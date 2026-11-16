begin;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'venditore', 'setter'));

-- A setter uses the restricted workspace RPCs. Existing tenant RLS predicates
-- continue to authorize the sales team, including Giovanni, as before.
create or replace function public.my_client_id()
returns uuid language sql stable security definer set search_path = public
as $$ select client_id from public.profiles where id = auth.uid() and role <> 'setter' $$;

-- Self-service profile edits must never change scope or promote a user.
create or replace function public.protect_profile_access() returns trigger
language plpgsql set search_path = public
as $$
begin
  if current_user = 'authenticated' and not public.is_admin()
    and (new.role is distinct from old.role or new.client_id is distinct from old.client_id or new.id is distinct from old.id
      or (old.role = 'setter' and new.full_name is distinct from old.full_name)) then
    raise exception 'Solo il titolare può modificare l’accesso';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_access on public.profiles;
create trigger protect_profile_access before update on public.profiles
  for each row execute function public.protect_profile_access();

alter table public.sales_tasks add column if not exists setter_id uuid references public.profiles(id) on delete set null;

create table if not exists public.setter_assignments (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  setter_id uuid not null references public.profiles(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  state text not null default 'new' check (state in ('new', 'follow_up', 'booked', 'not_interested')),
  last_outcome text check (last_outcome in ('answered', 'no_answer', 'not_interested')),
  callback_at timestamptz,
  note text,
  discovery_task_id uuid references public.sales_tasks(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists setter_assignments_queue_idx on public.setter_assignments(client_id, setter_id, state);
create index if not exists sales_tasks_setter_idx on public.sales_tasks(client_id, setter_id, due_at) where setter_id is not null;
alter table public.setter_assignments enable row level security;
revoke all on public.setter_assignments from public, anon, authenticated;

-- Returns only contact data and setting fields for the authorized assignments.
create or replace function public.get_setter_workspace(
  p_client_id uuid, p_setter_id uuid, p_from date, p_to date
) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  caller public.profiles;
  safe_queue jsonb;
  totals jsonb;
begin
  select * into caller from public.profiles where id = auth.uid();
  if caller.id is null or (caller.role <> 'admin' and
    (caller.role <> 'setter' or caller.client_id is distinct from p_client_id
      or (p_setter_id is not null and p_setter_id <> caller.id))) then
    raise exception 'Postazione setter non accessibile';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Periodo non valido';
  end if;
  if caller.role = 'setter' then p_setter_id := caller.id; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lead_id', l.id, 'name', l.name, 'phone', l.phone, 'email', l.email, 'source', l.source,
    'setter_id', a.setter_id, 'setter_name', coalesce(nullif(trim(setter.full_name), ''), 'Setter'),
    'seller_name', coalesce(nullif(trim(seller.full_name), ''), 'Venditore'),
    'state', case when a.state = 'booked' and t.id is null then 'follow_up' else a.state end,
    'last_outcome', a.last_outcome, 'callback_at', a.callback_at, 'note', a.note,
    'discovery_at', t.due_at, 'discovery_status', t.appointment_status, 'updated_at', a.updated_at
  ) order by a.callback_at asc nulls last, a.updated_at desc, a.lead_id), '[]'::jsonb) into safe_queue
  from public.setter_assignments a
  join public.leads l on l.id = a.lead_id and l.client_id = a.client_id
  join public.profiles setter on setter.id = a.setter_id and setter.client_id = a.client_id and setter.role = 'setter'
  join public.profiles seller on seller.id = a.seller_id and seller.client_id = a.client_id and seller.role = 'venditore'
  left join public.sales_tasks t on t.id = a.discovery_task_id and t.appointment_status is distinct from 'cancelled'
  where a.client_id = p_client_id and (p_setter_id is null or a.setter_id = p_setter_id);

  with log as (
    select event_type, outcome from public.lead_activities e
    where e.client_id = p_client_id and e.event_type in ('setting_call', 'discovery_booked')
      and e.details ? 'setter_id' and (p_setter_id is null or e.details->>'setter_id' = p_setter_id::text)
      and e.occurred_at >= (p_from::timestamp at time zone 'Europe/Rome')
      and e.occurred_at < ((p_to + 1)::timestamp at time zone 'Europe/Rome')
  )
  select jsonb_build_object(
    'contacts', count(*) filter (where event_type='setting_call'),
    'answered', count(*) filter (where event_type='setting_call' and outcome in ('answered','not_interested')),
    'booked', count(*) filter (where event_type='discovery_booked'),
    'held', (select count(*) from public.sales_tasks t where t.client_id=p_client_id and t.setter_id is not null
      and (p_setter_id is null or t.setter_id=p_setter_id) and t.appointment_type='discovery' and t.appointment_status='held'
      and t.due_at >= (p_from::timestamp at time zone 'Europe/Rome') and t.due_at < ((p_to+1)::timestamp at time zone 'Europe/Rome'))
  ) into totals from log;

  return jsonb_build_object('queue', safe_queue, 'totals', totals);
end;
$$;

create or replace function public.assign_setter_lead(p_lead_id uuid, p_setter_id uuid, p_seller_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target public.leads;
  existing public.setter_assignments;
begin
  if not public.is_admin() then raise exception 'Solo il titolare può assegnare i lead'; end if;
  select * into target from public.leads where id=p_lead_id for update;
  if not found then raise exception 'Lead non trovato'; end if;
  if not exists(select 1 from public.profiles p where p.id=p_setter_id and p.client_id=target.client_id and p.role='setter')
    or not exists(select 1 from public.profiles p where p.id=p_seller_id and p.client_id=target.client_id and p.role='venditore') then
    raise exception 'Scegli un setter e un venditore della stessa azienda';
  end if;
  select * into existing from public.setter_assignments where lead_id=p_lead_id for update;
  if existing.discovery_task_id is not null and (existing.setter_id <> p_setter_id or existing.seller_id <> p_seller_id) then
    raise exception 'La discovery è già passata al venditore';
  end if;
  insert into public.setter_assignments (lead_id,client_id,setter_id,seller_id)
    values(p_lead_id,target.client_id,p_setter_id,p_seller_id)
  on conflict (lead_id) do update set setter_id=excluded.setter_id, seller_id=excluded.seller_id, updated_at=now();
end;
$$;

create or replace function public.record_setter_contact(
  p_lead_id uuid, p_request_id uuid, p_outcome text, p_note text, p_callback_at timestamptz
) returns void language plpgsql security definer set search_path = public
as $$
declare
  assignment public.setter_assignments;
  target public.leads;
  caller public.profiles;
  author text;
  eventcode text := 'setter-contact:' || p_request_id;
begin
  select * into caller from public.profiles where id=auth.uid() and role='setter';
  if caller.id is null then raise exception 'Accesso riservato al setter assegnato'; end if;
  select * into target from public.leads where id=p_lead_id and client_id=caller.client_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;
  select * into assignment from public.setter_assignments where lead_id=p_lead_id and setter_id=caller.id and client_id=caller.client_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;
  if p_request_id is null or p_outcome not in ('answered','no_answer','not_interested') or p_outcome is null
    or length(coalesce(p_note,'')) > 3000 then raise exception 'Esito non valido'; end if;
  if exists(select 1 from public.lead_activities e where e.client_id=assignment.client_id and e.lead_id=p_lead_id
    and e.event_key=eventcode and e.details->>'setter_id'=caller.id::text and e.outcome=p_outcome
    and e.note is not distinct from nullif(trim(p_note),'')
    and (e.details->>'callback_at')::timestamptz is not distinct from p_callback_at) then return; end if;
  if assignment.discovery_task_id is not null or exists (
    select 1 from public.stages where id=target.stage_id and upper(trim(name)) in ('CLOSING','CLOSED','LOST')
  ) then raise exception 'Il lead è già passato alla vendita o è chiuso'; end if;
  if p_callback_at is not null and (p_outcome='not_interested' or p_callback_at<=now()) then
    raise exception 'Scegli una data futura per il richiamo';
  end if;
  author:=coalesce(nullif(trim(caller.full_name),''),'Setter');
  insert into public.lead_activities (client_id,lead_id,pipeline_id,activity_type,event_type,channel,call_type,
    outcome,occurred_at,note,created_by,details,event_key)
  values (assignment.client_id,p_lead_id,target.pipeline_id,'call','setting_call','phone','outbound',
    p_outcome,now(),nullif(trim(p_note),''),author,
    jsonb_build_object('setter_id',caller.id,'owner_at_event',author,'assigned_to',author,'callback_at',p_callback_at),eventcode);
  update public.setter_assignments set state=case when p_outcome='not_interested' then 'not_interested' else 'follow_up' end,
    last_outcome=p_outcome, note=coalesce(nullif(trim(p_note),''),note), callback_at=p_callback_at, updated_at=now()
    where lead_id=p_lead_id;
end;
$$;

create or replace function public.book_setter_discovery(
  p_lead_id uuid, p_request_id uuid, p_due_at timestamptz, p_note text
) returns uuid language plpgsql security definer set search_path = public
as $$
declare
  assignment public.setter_assignments;
  target public.leads;
  caller public.profiles;
  closer public.profiles;
  discovery_stage uuid;
  current_stage text;
  booking public.sales_tasks;
  setter_name text;
  seller_name text;
  handoff_note text;
begin
  select * into caller from public.profiles where id=auth.uid() and role='setter';
  if caller.id is null then raise exception 'Accesso riservato al setter assegnato'; end if;
  select * into target from public.leads where id=p_lead_id and client_id=caller.client_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;
  select * into assignment from public.setter_assignments where lead_id=p_lead_id and setter_id=caller.id and client_id=caller.client_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;
  if p_request_id is null or p_due_at is null or length(coalesce(p_note,''))>3000 then raise exception 'Dati della discovery non validi'; end if;
  handoff_note:=coalesce(nullif(trim(p_note),''),assignment.note);
  if assignment.discovery_task_id=p_request_id and exists(select 1 from public.sales_tasks t
    where t.id=p_request_id and t.setter_id=caller.id and t.due_at=p_due_at and t.description is not distinct from handoff_note) then return p_request_id; end if;
  if p_due_at<=now() then raise exception 'Scegli data e ora future'; end if;
  if assignment.discovery_task_id is not null or assignment.state='not_interested' then
    raise exception 'La discovery è già passata al venditore o il lead è stato chiuso dal setter';
  end if;

  select * into closer from public.profiles where id=assignment.seller_id and client_id=caller.client_id and role='venditore';
  seller_name:=coalesce(nullif(trim(closer.full_name),''),(select email from auth.users where id=closer.id));
  setter_name:=coalesce(nullif(trim(caller.full_name),''),'Setter');
  if seller_name is null then raise exception 'Il venditore assegnato non è disponibile'; end if;
  select name into current_stage from public.stages where id=target.stage_id and client_id=target.client_id;
  select id into discovery_stage from public.stages where client_id=target.client_id and pipeline_id=target.pipeline_id
    and upper(trim(name))='DISCOVERY' order by position,id limit 1;
  if discovery_stage is null or upper(trim(coalesce(current_stage,''))) not in ('SETTING','RECALL','NO ANSWER','NO ANSWER 1-3','NO ANSWER 4-5','DISCOVERY') then
    raise exception 'La fase attuale del lead non è disponibile per il passaggio al venditore';
  end if;

  -- Same task, event key and duplicate guard used by the sales agenda.
  insert into public.sales_tasks (id,client_id,lead_id,title,description,due_at,assigned_to,created_by,appointment_type,
    appointment_status,duration_minutes,audience,commercial_tracked,appointment_host,setter_id)
  values (p_request_id,target.client_id,target.id,'Discovery telefonica — '||coalesce(nullif(trim(target.name),''),'Lead'),
    handoff_note,p_due_at,seller_name,setter_name,'discovery','scheduled',30,'lead',true,seller_name,caller.id)
  returning * into booking;
  insert into public.lead_activities (client_id,lead_id,pipeline_id,activity_type,event_type,channel,call_type,outcome,
    occurred_at,scheduled_at,duration_minutes,note,created_by,details,event_key)
  values (target.client_id,target.id,target.pipeline_id,'meeting','discovery_booked','phone','lead','scheduled',
    booking.created_at,booking.due_at,30,handoff_note,seller_name,
    jsonb_build_object('setter_id',caller.id,'booked_by',setter_name,'task_id',booking.id,'assigned_to',seller_name,
      'owner_at_event',seller_name,'appointment_host',seller_name),'appointment:'||booking.id||':booked');
  update public.leads set assigned_to=seller_name, stage_id=discovery_stage, next_action_date=(p_due_at at time zone 'Europe/Rome')::date,
    position=case when stage_id=discovery_stage then position else
      least(0,coalesce((select min(l.position) from public.leads l where l.stage_id=discovery_stage),0))-1 end
    where id=target.id;
  update public.setter_assignments set state='booked', discovery_task_id=booking.id, callback_at=null,
    note=coalesce(nullif(trim(p_note),''),note), updated_at=now() where lead_id=target.id;
  return booking.id;
end;
$$;

revoke all on function public.get_setter_workspace(uuid,uuid,date,date), public.assign_setter_lead(uuid,uuid,uuid),
  public.record_setter_contact(uuid,uuid,text,text,timestamptz), public.book_setter_discovery(uuid,uuid,timestamptz,text) from public, anon;
grant execute on function public.get_setter_workspace(uuid,uuid,date,date), public.assign_setter_lead(uuid,uuid,uuid),
  public.record_setter_contact(uuid,uuid,text,text,timestamptz), public.book_setter_discovery(uuid,uuid,timestamptz,text) to authenticated;
notify pgrst, 'reload schema';

commit;
