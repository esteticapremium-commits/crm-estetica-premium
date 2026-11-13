begin;
-- Explicitly classified Google events only. No private calendar is imported wholesale.
create table if not exists public.google_sales_appointments (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id) on delete cascade,
 owner_id uuid not null references auth.users(id), assigned_to text not null,
 google_key text not null, google_event_id text not null,
 title text not null, contact_name text not null,
 starts_at timestamptz not null, booked_at timestamptz,
 lead_id uuid references public.leads(id) on delete set null,
 appointment_type text not null check (appointment_type in ('discovery','demo')),
 revenue_type text not null check (revenue_type in ('new','renewal','upsell')),
 outcome text not null check (outcome in ('excluded','pending','won','follow_up','lost','no_show','rescheduled')),
 proposal_made boolean not null default false, qualified boolean, next_action_at timestamptz,
 contract_value numeric(12,2) not null default 0 check (contract_value >= 0),
 collected_amount numeric(12,2) not null default 0 check (collected_amount >= 0 and collected_amount <= contract_value),
 collected_at timestamptz, note text not null default '', version integer not null default 1,
 request_hash text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(client_id, google_key), unique(client_id, google_event_id)
);
alter table public.google_sales_appointments enable row level security;
revoke all on public.google_sales_appointments from anon, authenticated;
grant select on public.google_sales_appointments to authenticated;
drop policy if exists google_sales_read on public.google_sales_appointments;
create policy google_sales_read on public.google_sales_appointments for select to authenticated
 using (public.is_admin() or (client_id = public.my_client_id() and owner_id = auth.uid()));
create index if not exists google_sales_pending_idx on public.google_sales_appointments(client_id, starts_at) where outcome in ('pending','follow_up','rescheduled');

-- One transaction: classification, outcome correction, optional lead link and cash.
-- Version check rejects stale edits. Identical retries return the existing record.
create or replace function public.save_google_sale(p_client_id uuid, p_sale jsonb, p_expected_version integer default 0)
returns public.google_sales_appointments language plpgsql security definer set search_path = public as $$
declare
 r public.google_sales_appointments; old public.google_sales_appointments;
 uid uuid := auth.uid(); admin boolean := coalesce(public.is_admin(),false);
 lead public.leads; author text; amount numeric; deal numeric; cash_at timestamptz;
 start_at timestamptz; next_at timestamptz; state text; gkey text; gid text;
begin
 if uid is null or (not admin and p_client_id is distinct from public.my_client_id()) then raise exception 'Non autorizzato'; end if;
 author := coalesce(nullif(public.my_full_name(),''),'Titolare');
 gkey := nullif(p_sale->>'google_key',''); gid := nullif(p_sale->>'google_event_id','');
 if gkey is null or gid is null or length(gkey)>1500 or length(gid)>1024 then raise exception 'Identità Google mancante o non valida'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_client_id::text || ':google-sales', 0));
 select * into old from public.google_sales_appointments where client_id=p_client_id and google_key=gkey for update;
 if old.id is not null and not admin and old.owner_id<>uid then raise exception 'Appuntamento già classificato da un altro utente'; end if;
 if exists (select 1 from public.sales_tasks where client_id=p_client_id and google_event_id=gid) then
  raise exception 'Questo evento è già collegato a un appuntamento CRM. Registra l’esito dalla sua scheda.';
 end if;
 if nullif(p_sale->>'lead_id','') is not null then
  select * into lead from public.leads where id=(p_sale->>'lead_id')::uuid and client_id=p_client_id;
  if lead.id is null or (not admin and lead.assigned_to is distinct from public.my_full_name()) then raise exception 'Lead non accessibile'; end if;
 end if;
 start_at := (p_sale->>'starts_at')::timestamptz;
 next_at := nullif(p_sale->>'next_action_at','')::timestamptz;
 state := p_sale->>'outcome';
 amount := coalesce((p_sale->>'collected_amount')::numeric,0);
 deal := coalesce((p_sale->>'contract_value')::numeric,0);
 cash_at := nullif(p_sale->>'collected_at','')::timestamptz;
 if nullif(trim(p_sale->>'contact_name'),'') is null or start_at is null then raise exception 'Contatto e data obbligatori'; end if;
 if state not in ('pending','excluded') and start_at > now() then raise exception 'Appuntamento non ancora iniziato'; end if;
 if state in ('follow_up','rescheduled') and (next_at is null or next_at<=start_at) then raise exception 'Data del prossimo passo non valida'; end if;
 if state='won' and deal<=0 then raise exception 'Valore accordo obbligatorio'; end if;
 if state<>'won' then amount:=0; deal:=0; cash_at:=null; end if;
 if amount<0 or deal<0 or amount>deal or deal>=10000000000 or amount::text='NaN' or deal::text='NaN' then raise exception 'Importi non validi'; end if;
 if amount>0 and (cash_at is null or cash_at>now()) then raise exception 'Data incasso non valida'; end if;
 if not admin and (amount<>coalesce(old.collected_amount,0) or cash_at is distinct from old.collected_at) then raise exception 'Solo l’amministratore può registrare o correggere questi incassi'; end if;
 if p_sale->>'appointment_type'='discovery' and state in ('won','follow_up','lost') and nullif(p_sale->>'qualified','') is null then raise exception 'Indicare se il contatto è in target'; end if;
 if old.id is not null and old.version<>p_expected_version then
  if old.request_hash=md5(p_sale::text) then return old; end if;
  raise exception 'Registrazione aggiornata da un’altra scheda. Riapri e riprova.';
 end if;
 if old.id is null and p_expected_version<>0 then raise exception 'Registrazione non trovata'; end if;
 insert into public.google_sales_appointments as target
 (id,client_id,owner_id,assigned_to,google_key,google_event_id,title,contact_name,starts_at,booked_at,lead_id,appointment_type,revenue_type,outcome,proposal_made,qualified,next_action_at,contract_value,collected_amount,collected_at,note,request_hash)
 values(coalesce(old.id,gen_random_uuid()),p_client_id,coalesce(old.owner_id,uid),coalesce(old.assigned_to,author),gkey,gid,
 coalesce(p_sale->>'title','Appuntamento Google'),trim(p_sale->>'contact_name'),start_at,
 nullif(p_sale->>'booked_at','')::timestamptz,lead.id,p_sale->>'appointment_type',p_sale->>'revenue_type',state,
 (state='won' or coalesce((p_sale->>'proposal_made')::boolean,false)),(p_sale->>'qualified')::boolean,case when state in ('follow_up','rescheduled') then next_at end,deal,amount,
 case when amount>0 then cash_at end,coalesce(p_sale->>'note',''),md5(p_sale::text))
 on conflict(client_id,google_key) do update set
 title=excluded.title, contact_name=excluded.contact_name, starts_at=excluded.starts_at, booked_at=excluded.booked_at,
 lead_id=excluded.lead_id,appointment_type=excluded.appointment_type,revenue_type=excluded.revenue_type,
 outcome=excluded.outcome,proposal_made=excluded.proposal_made,qualified=excluded.qualified,next_action_at=excluded.next_action_at,
 contract_value=excluded.contract_value,collected_amount=excluded.collected_amount,collected_at=excluded.collected_at,
 note=excluded.note,request_hash=excluded.request_hash,version=target.version+1,updated_at=now()
 returning * into r;
 -- Stable cash key: editing the outcome never appends another payment.
 if amount>0 then
  insert into public.sales_revenue_events(client_id,lead_id,pipeline_id,revenue_type,amount,contract_value,status,occurred_at,assigned_to,created_by,note,event_key)
  values(p_client_id,r.lead_id,lead.pipeline_id,r.revenue_type,amount,deal,'collected',cash_at,r.assigned_to,author,
  'Google Calendar · '||r.contact_name,'google-sale:'||r.id::text)
  on conflict(client_id,event_key) do update set lead_id=excluded.lead_id,pipeline_id=excluded.pipeline_id,
  revenue_type=excluded.revenue_type,amount=excluded.amount,contract_value=excluded.contract_value,status='collected',
  occurred_at=excluded.occurred_at,assigned_to=excluded.assigned_to,note=excluded.note;
 else
  update public.sales_revenue_events set status='cancelled' where client_id=p_client_id and event_key='google-sale:'||r.id::text;
 end if;
 return r;
end $$;
revoke all on function public.save_google_sale(uuid,jsonb,integer) from public, anon;
grant execute on function public.save_google_sale(uuid,jsonb,integer) to authenticated;
-- Protect the other entry point as well: an imported Google call cannot also be created as a CRM task.
create or replace function public.prevent_google_sale_task_duplicate() returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.client_id::text || ':google-sales',0));
 if new.google_event_id is not null and exists(select 1 from public.google_sales_appointments where client_id=new.client_id and google_event_id=new.google_event_id) then
  raise exception 'Evento già registrato nelle vendite Google: collega il lead alla registrazione esistente';
 end if;
 return new;
end $$;
revoke all on function public.prevent_google_sale_task_duplicate() from public, anon, authenticated;
drop trigger if exists sales_tasks_google_sale_guard on public.sales_tasks;
create trigger sales_tasks_google_sale_guard before insert or update of google_event_id on public.sales_tasks for each row execute function public.prevent_google_sale_task_duplicate();
notify pgrst, 'reload schema';
commit;
