begin;

create table if not exists public.database_leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email text,
  city text,
  region text,
  source text not null,
  source_row integer not null,
  source_outcome text,
  setter_id uuid references public.profiles(id) on delete set null,
  seller_id uuid references public.profiles(id) on delete set null,
  pipeline_id uuid references public.pipelines(id) on delete set null,
  state text not null default 'new' check (state in ('new', 'follow_up', 'booked', 'not_interested')),
  last_outcome text,
  callback_at timestamptz,
  note text,
  lead_id uuid references public.leads(id) on delete set null,
  handed_off_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(client_id, phone)
);

create table if not exists public.database_lead_calls (
  id uuid primary key,
  contact_id uuid not null references public.database_leads(id) on delete cascade,
  setter_id uuid not null,
  author text not null,
  outcome text not null check (outcome in ('answered', 'no_answer', 'not_interested')),
  occurred_at timestamptz not null default now(),
  callback_at timestamptz,
  note text
);

create index if not exists database_leads_queue_idx on public.database_leads(client_id, setter_id, state);
create index if not exists database_lead_calls_contact_idx on public.database_lead_calls(contact_id);
alter table public.database_leads enable row level security;
alter table public.database_lead_calls enable row level security;
revoke all on public.database_leads, public.database_lead_calls from public, anon, authenticated;
grant select on public.database_leads to authenticated;
do $$
begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='database_leads' and policyname='database_leads_admin_read') then
    create policy database_leads_admin_read on public.database_leads for select to authenticated using (public.is_admin());
  end if;
end;
$$;

create or replace function public.assign_database_leads(p_client_id uuid, p_contact_ids uuid[], p_setter_id uuid, p_seller_id uuid, p_pipeline_id uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  selected_count integer;
begin
  if not public.is_admin() then raise exception 'Solo il titolare può assegnare i contatti'; end if;
  if coalesce(cardinality(p_contact_ids),0) not between 1 and 50 then raise exception 'Seleziona da 1 a 50 contatti'; end if;
  if not exists(select 1 from public.profiles where id=p_setter_id and client_id=p_client_id and role='setter')
     or not exists(select 1 from public.profiles where id=p_seller_id and client_id=p_client_id and role='venditore') then
    raise exception 'Scegli un setter e un venditore di questa azienda';
  end if;
  if not exists(select 1 from public.pipelines where id=p_pipeline_id and client_id=p_client_id)
     or 2 <> (select count(distinct upper(trim(name))) from public.stages
       where client_id=p_client_id and pipeline_id=p_pipeline_id and upper(trim(name)) in ('SETTING','DISCOVERY')) then
    raise exception 'Scegli una pipeline con le fasi SETTING e DISCOVERY';
  end if;

  select count(*) into selected_count from (
    select id from public.database_leads where client_id=p_client_id and id=any(p_contact_ids)
      and handed_off_at is null and state='new'
      and (setter_id is null or (setter_id=p_setter_id and seller_id=p_seller_id and pipeline_id=p_pipeline_id))
    order by id for update
  ) eligible;
  if selected_count <> cardinality(p_contact_ids) then
    raise exception 'La disponibilità dei contatti è cambiata. Aggiorna l’elenco e riprova.';
  end if;
  update public.database_leads set setter_id=p_setter_id,seller_id=p_seller_id,pipeline_id=p_pipeline_id,updated_at=now()
    where client_id=p_client_id and id=any(p_contact_ids) and setter_id is null;
  return selected_count;
end;
$$;

create or replace function public.get_database_setter_workspace(p_client_id uuid, p_setter_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  caller public.profiles;
  queue jsonb;
  attempts integer;
  answered integer;
begin
  select * into caller from public.profiles where id=auth.uid();
  if caller.id is null or (caller.role <> 'admin' and
    (caller.role <> 'setter' or caller.client_id is distinct from p_client_id
      or (p_setter_id is not null and p_setter_id <> caller.id))) then
    raise exception 'Postazione setter non accessibile';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to-p_from > 366 then raise exception 'Periodo non valido'; end if;
  if caller.role='setter' then p_setter_id:=caller.id; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lead_id', d.id, 'database_contact', true, 'name',d.name,'phone',d.phone,'email',d.email,
    'setter_id',d.setter_id,'setter_name',coalesce(nullif(trim(s.full_name),''),'Setter'),
    'seller_name',coalesce(nullif(trim(v.full_name),''),'Venditore'),'state',d.state,
    'last_outcome',d.last_outcome,'callback_at',d.callback_at,'note',d.note,'updated_at',d.updated_at
  ) || case when caller.role='admin' then jsonb_build_object('source',d.source) else '{}'::jsonb end
    order by d.callback_at nulls last, d.updated_at desc, d.source_row), '[]'::jsonb) into queue
  from public.database_leads d
  join public.profiles s on s.id=d.setter_id and s.client_id=d.client_id and s.role='setter'
  join public.profiles v on v.id=d.seller_id and v.client_id=d.client_id and v.role='venditore'
  where d.client_id=p_client_id and d.handed_off_at is null and (p_setter_id is null or d.setter_id=p_setter_id);

  select count(*),count(*) filter (where c.outcome in ('answered','not_interested')) into attempts,answered
  from public.database_lead_calls c join public.database_leads d on d.id=c.contact_id
  where d.client_id=p_client_id and d.handed_off_at is null and (p_setter_id is null or c.setter_id=p_setter_id)
    and c.occurred_at >= (p_from::timestamp at time zone 'Europe/Rome')
    and c.occurred_at < ((p_to+1)::timestamp at time zone 'Europe/Rome');
  return jsonb_build_object('queue',queue,'contacts',attempts,'answered',answered);
end;
$$;

create or replace function public.get_complete_setter_workspace(p_client_id uuid, p_setter_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  regular jsonb := public.get_setter_workspace(p_client_id,p_setter_id,p_from,p_to);
  stock jsonb := public.get_database_setter_workspace(p_client_id,p_setter_id,p_from,p_to);
  totals jsonb := regular->'totals';
  queue jsonb;
begin
  select coalesce(jsonb_agg(item order by (item->>'callback_at')::timestamptz nulls last,
    (item->>'updated_at')::timestamptz desc nulls last,item->>'lead_id'),'[]'::jsonb) into queue
    from jsonb_array_elements((regular->'queue')||(stock->'queue')) items(item);
  return jsonb_build_object('queue',queue,'totals',totals||jsonb_build_object(
    'contacts',coalesce((totals->>'contacts')::integer,0)+(stock->>'contacts')::integer,
    'answered',coalesce((totals->>'answered')::integer,0)+(stock->>'answered')::integer));
end;
$$;

create or replace function public.record_database_setter_contact(p_contact_id uuid, p_request_id uuid, p_outcome text, p_note text, p_callback_at timestamptz)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  caller public.profiles;
  contact public.database_leads;
  clean_note text := nullif(trim(p_note),'');
begin
  select * into caller from public.profiles where id=auth.uid() and role='setter';
  if not found then raise exception 'Accesso riservato al setter assegnato'; end if;
  select * into contact from public.database_leads where id=p_contact_id and client_id=caller.client_id and setter_id=caller.id for update;
  if not found then raise exception 'Contatto non accessibile'; end if;
  if p_request_id is null or p_outcome is null or p_outcome not in ('answered','no_answer','not_interested')
     or length(coalesce(clean_note,'')) > 3000 then raise exception 'Esito non valido'; end if;
  if exists(select 1 from public.database_lead_calls where id=p_request_id and contact_id=contact.id and setter_id=caller.id
    and outcome=p_outcome and note is not distinct from clean_note and callback_at is not distinct from p_callback_at) then return; end if;
  if contact.handed_off_at is not null then raise exception 'Il contatto è già passato alla vendita'; end if;
  if p_callback_at is not null and (p_outcome='not_interested' or p_callback_at<=now()) then raise exception 'Scegli una data futura per il richiamo'; end if;

  insert into public.database_lead_calls(id,contact_id,setter_id,author,outcome,note,callback_at)
    values(p_request_id,contact.id,caller.id,coalesce(nullif(trim(caller.full_name),''),'Setter'),p_outcome,clean_note,p_callback_at);
  update public.database_leads set state=case when p_outcome='not_interested' then 'not_interested' else 'follow_up' end,
    last_outcome=p_outcome,note=coalesce(clean_note,note),callback_at=p_callback_at,updated_at=now() where id=contact.id;
end;
$$;

create or replace function public.database_phone_key(p_phone text)
returns text language sql immutable strict set search_path = public, pg_temp
as $$
  select regexp_replace(regexp_replace(p_phone,'[^0-9]','','g'),'^(0039|39)([03][0-9]{5,10})$','\2')
$$;

create or replace function public.book_database_setter_discovery(p_contact_id uuid, p_request_id uuid, p_due_at timestamptz, p_note text, p_record_call boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  caller public.profiles;
  contact public.database_leads;
  target public.leads;
  lead_id_match uuid;
  match_count integer;
  start_stage uuid;
  booked_id uuid;
begin
  select * into caller from public.profiles where id=auth.uid() and role='setter';
  if not found then raise exception 'Accesso riservato al setter assegnato'; end if;
  select * into contact from public.database_leads where id=p_contact_id and client_id=caller.client_id and setter_id=caller.id for update;
  if not found then raise exception 'Contatto non accessibile'; end if;
  if contact.handed_off_at is not null then
    if exists(select 1 from public.sales_tasks where id=p_request_id and lead_id=contact.lead_id and setter_id=caller.id and due_at=p_due_at)
      then return p_request_id; end if;
    raise exception 'Il contatto è già passato alla vendita';
  end if;
  if p_request_id is null or p_due_at is null or p_due_at<=now() or p_record_call is null or contact.state='not_interested'
     or length(coalesce(p_note,''))>3000 then raise exception 'Dati della discovery non validi'; end if;

  perform pg_advisory_xact_lock(hashtextextended(contact.client_id::text||':'||contact.phone,0));
  select count(*), (array_agg(l.id order by l.id))[1] into match_count,lead_id_match from public.leads l
    where l.client_id=contact.client_id and (public.database_phone_key(l.phone)=public.database_phone_key(contact.phone)
      or (contact.email is not null and lower(trim(l.email))=lower(trim(contact.email))));
  if match_count>1 then raise exception 'Esistono più lead con lo stesso recapito. Chiedi al titolare di verificare.'; end if;
  if lead_id_match is null then
    select id into start_stage from public.stages where client_id=contact.client_id and pipeline_id=contact.pipeline_id
      and upper(trim(name))='SETTING' order by position,id limit 1;
    if start_stage is null then raise exception 'Pipeline della discovery non più disponibile'; end if;
    insert into public.leads(id,client_id,pipeline_id,stage_id,name,phone,email,source)
      values(gen_random_uuid(),contact.client_id,contact.pipeline_id,start_stage,contact.name,contact.phone,contact.email,contact.source)
      returning * into target;
  else
    select * into target from public.leads where id=lead_id_match and client_id=contact.client_id for update;
    if not found then raise exception 'Il lead esistente non è più disponibile'; end if;
    if exists(select 1 from public.sales_tasks where lead_id=target.id and appointment_type='discovery' and appointment_status='scheduled') then
      raise exception 'Esiste già una discovery programmata per questo lead'; end if;
  end if;

  insert into public.setter_assignments(lead_id,client_id,setter_id,seller_id,note)
    values(target.id,contact.client_id,caller.id,contact.seller_id,contact.note) on conflict (lead_id) do nothing;
  if not exists(select 1 from public.setter_assignments where lead_id=target.id and client_id=contact.client_id
    and setter_id=caller.id and seller_id=contact.seller_id) then
    raise exception 'Il lead è già assegnato a un’altra persona';
  end if;
  booked_id:=public.save_setter_discovery(target.id,p_request_id,p_due_at,p_note,p_record_call);

  insert into public.lead_activities(client_id,lead_id,pipeline_id,activity_type,event_type,channel,call_type,outcome,occurred_at,note,created_by,details,event_key)
    select contact.client_id,target.id,target.pipeline_id,'call','setting_call','phone','outbound',c.outcome,c.occurred_at,c.note,c.author,
      jsonb_build_object('setter_id',c.setter_id,'owner_at_event',c.author,'assigned_to',c.author,'callback_at',c.callback_at),
      'database-setter-contact:'||c.id
    from public.database_lead_calls c where c.contact_id=contact.id;
  update public.database_leads set lead_id=target.id,handed_off_at=now(),state='booked',callback_at=null,updated_at=now() where id=contact.id;
  return booked_id;
end;
$$;

revoke all on function public.database_phone_key(text), public.get_database_setter_workspace(uuid,uuid,date,date) from public, anon, authenticated;
revoke all on function public.assign_database_leads(uuid,uuid[],uuid,uuid,uuid), public.get_complete_setter_workspace(uuid,uuid,date,date),
  public.record_database_setter_contact(uuid,uuid,text,text,timestamptz), public.book_database_setter_discovery(uuid,uuid,timestamptz,text,boolean)
  from public, anon;
grant execute on function public.assign_database_leads(uuid,uuid[],uuid,uuid,uuid), public.get_complete_setter_workspace(uuid,uuid,date,date),
  public.record_database_setter_contact(uuid,uuid,text,text,timestamptz), public.book_database_setter_discovery(uuid,uuid,timestamptz,text,boolean)
  to authenticated;
notify pgrst, 'reload schema';
commit;
