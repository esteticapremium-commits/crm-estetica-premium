-- Apply after upgrade_setting_appointments and upgrade_google_sales.
-- Allow a confirmed no-show before the scheduled time, keeping the same outcome and revenue keys.
begin;

alter table public.google_sales_appointments add column if not exists early_no_show boolean not null default false;

create or replace function public.save_sales_appointment_outcome(
  p_id uuid, p_expected_updated_at timestamptz, p_outcome text, p_minutes integer, p_note text, p_proposal_made boolean
) returns public.sales_tasks
language plpgsql security invoker set search_path = public
as $$
declare
  task public.sales_tasks;
  result_status text;
  result_minutes integer;
  result_note text;
  result_proposal boolean;
  previous_activity public.lead_activities;
  pipeline uuid;
  author text := public.my_full_name();
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  select * into task from public.sales_tasks where id = p_id for update;
  if not found then raise exception 'Appuntamento non accessibile'; end if;
  if task.appointment_status = 'cancelled' then
    raise exception 'Appuntamento annullato';
  end if;
  if task.due_at > now() and p_outcome is distinct from 'no_show' then
    raise exception 'Prima dell’orario puoi registrare solo un no-show';
  end if;
  if not coalesce((task.appointment_type = 'discovery' and p_outcome in ('qualified', 'not_qualified', 'no_answer', 'no_show'))
    or (task.appointment_type = 'setting' and p_outcome in ('answered', 'no_answer', 'not_interested', 'no_show'))
    or (task.appointment_type = 'demo' and p_outcome in ('held', 'no_show')), false) then
    raise exception 'Esito non valido per questo appuntamento';
  end if;
  if p_minutes is not null and p_minutes < 1 then raise exception 'Durata non valida'; end if;
  result_status := case when p_outcome in ('no_show', 'no_answer') then 'no_show' else 'held' end;
  if task.lead_id is not null then
    select * into previous_activity from public.lead_activities where client_id = task.client_id
      and event_key = 'appointment:' || task.id || ':outcome';
  end if;
  result_minutes := case when result_status = 'held' then coalesce(p_minutes, task.outcome_minutes,
    previous_activity.duration_minutes, case when task.appointment_type <> 'setting'
      then coalesce(task.duration_minutes, case when task.appointment_type = 'discovery' then 30 else 60 end) end) end;
  result_note := case when p_note is null then coalesce(task.outcome_note, previous_activity.note) else nullif(trim(p_note), '') end;
  result_proposal := case when task.appointment_type = 'demo' and result_status = 'held'
    then coalesce(p_proposal_made, task.proposal_made) end;
  if (task.lead_id is null or previous_activity.id is not null)
    and task.appointment_status = result_status and task.appointment_outcome = p_outcome
    and task.outcome_minutes is not distinct from result_minutes
    and task.outcome_note is not distinct from result_note
    and task.proposal_made is not distinct from result_proposal then return task; end if;
  if task.updated_at is distinct from p_expected_updated_at then
    raise exception 'Appuntamento aggiornato da un collega. Riaprilo prima di correggere l’esito.';
  end if;
  update public.sales_tasks set appointment_status = result_status, completed_at = now(), completed_by = author,
    commercial_tracked = true, appointment_outcome = p_outcome, outcome_minutes = result_minutes,
    outcome_note = result_note, proposal_made = result_proposal
  where id = task.id returning * into task;
  if not found then raise exception 'Modifica non autorizzata'; end if;
  if task.lead_id is not null then
    select pipeline_id into pipeline from public.leads where id = task.lead_id;
    insert into public.lead_activities as activity
      (lead_id, client_id, pipeline_id, activity_type, event_type, channel, call_type,
        outcome, occurred_at, scheduled_at, duration_minutes, note, created_by, details, event_key)
    values (task.lead_id, task.client_id, pipeline,
      case when task.appointment_type = 'demo' then 'meeting' else 'call' end,
      task.appointment_type || '_call',
      case when task.appointment_type = 'demo' then 'video_call' else 'phone' end,
      case when task.appointment_type = 'setting' then 'outbound' when task.audience = 'client' then 'client' else 'lead' end,
      p_outcome, task.due_at, task.due_at, result_minutes, task.outcome_note, author,
      jsonb_build_object('task_id', task.id, 'assigned_to', task.assigned_to, 'owner_at_event', task.assigned_to, 'appointment_host', task.appointment_host,
        'outcome_recorded_by', author, 'proposal_made', task.proposal_made),
      'appointment:' || task.id || ':outcome')
    on conflict (client_id, event_key) do update set
      outcome = excluded.outcome, occurred_at = excluded.occurred_at, scheduled_at = excluded.scheduled_at,
      duration_minutes = excluded.duration_minutes, note = excluded.note,
      details = coalesce(activity.details, '{}'::jsonb) || excluded.details;
  end if;
  return task;
end;
$$;

create or replace function public.save_google_sale(p_client_id uuid, p_sale jsonb, p_expected_version integer default 0)
returns public.google_sales_appointments language plpgsql security definer set search_path = public as $$
declare
 r public.google_sales_appointments; old public.google_sales_appointments;
 uid uuid := auth.uid(); admin boolean := coalesce(public.is_admin(),false);
 lead public.leads; author text; amount numeric; deal numeric; cash_at timestamptz;
 start_at timestamptz; next_at timestamptz; state text; gkey text; gid text;
 missed_before_start boolean;
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
 if state not in ('pending','excluded','no_show') and start_at > now() then raise exception 'Appuntamento non ancora iniziato'; end if;
 missed_before_start := coalesce(state='no_show' and (start_at>now() or
   (old.early_no_show and old.starts_at=start_at)), false);
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
 (id,client_id,owner_id,assigned_to,google_key,google_event_id,title,contact_name,starts_at,booked_at,lead_id,appointment_type,revenue_type,outcome,proposal_made,qualified,next_action_at,contract_value,collected_amount,collected_at,note,request_hash,early_no_show)
 values(coalesce(old.id,gen_random_uuid()),p_client_id,coalesce(old.owner_id,uid),coalesce(old.assigned_to,author),gkey,gid,
 coalesce(p_sale->>'title','Appuntamento Google'),trim(p_sale->>'contact_name'),start_at,
 nullif(p_sale->>'booked_at','')::timestamptz,lead.id,p_sale->>'appointment_type',p_sale->>'revenue_type',state,
 (state='won' or coalesce((p_sale->>'proposal_made')::boolean,false)),(p_sale->>'qualified')::boolean,case when state in ('follow_up','rescheduled') then next_at end,deal,amount,
 case when amount>0 then cash_at end,coalesce(p_sale->>'note',''),md5(p_sale::text),missed_before_start)
 on conflict(client_id,google_key) do update set
 title=excluded.title, contact_name=excluded.contact_name, starts_at=excluded.starts_at, booked_at=excluded.booked_at,
 lead_id=excluded.lead_id,appointment_type=excluded.appointment_type,revenue_type=excluded.revenue_type,
 outcome=excluded.outcome,early_no_show=excluded.early_no_show,proposal_made=excluded.proposal_made,qualified=excluded.qualified,next_action_at=excluded.next_action_at,
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

notify pgrst, 'reload schema';
commit;
