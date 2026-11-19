begin;

create or replace function public.sync_calendar_lead_stage(p_client_id uuid, p_lead_id uuid, p_type text, p_starts_at timestamptz)
returns uuid language plpgsql set search_path = public, pg_temp
as $$
declare
  target public.leads;
  current_stage text;
  destination_name text;
  destination_id uuid;
  appointment_day date;
begin
  if p_lead_id is null or p_starts_at is null or p_type is null or p_type not in ('discovery','demo') then return null; end if;

  select * into target from public.leads where id=p_lead_id and client_id=p_client_id for update;
  if not found or target.pipeline_id is null then return null; end if;
  select upper(trim(s.name)) into current_stage from public.stages s
    where s.id=target.stage_id and s.client_id=p_client_id and s.pipeline_id=target.pipeline_id;

  destination_name:=case p_type when 'discovery' then 'DISCOVERY' else 'CLOSING' end;
  if current_stage is null or (current_stage <> destination_name
    and current_stage not in ('SETTING','RECALL','NO ANSWER','NO ANSWER 1-3','NO ANSWER 4-5','NO SHOW')
    and not (p_type='demo' and current_stage='DISCOVERY')) then return null; end if;

  select s.id into destination_id from public.stages s
    where s.client_id=p_client_id and s.pipeline_id=target.pipeline_id and upper(trim(s.name))=destination_name
    order by s.position,s.id limit 1;
  if destination_id is null then raise exception 'La colonna % non è presente nella pipeline del lead', destination_name; end if;

  appointment_day:=(p_starts_at at time zone 'Europe/Rome')::date;
  if target.stage_id=destination_id then
    update public.leads set next_action_date=appointment_day where id=target.id and next_action_date is distinct from appointment_day;
  else
    update public.leads set stage_id=destination_id,next_action_date=appointment_day,
      position=least(0,coalesce((select min(position) from public.leads where client_id=p_client_id
        and pipeline_id=target.pipeline_id and stage_id=destination_id),0))-1
      where id=target.id;
  end if;
  return destination_id;
end;
$$;

create or replace function public.sync_crm_booking_pipeline()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op='UPDATE' then
    if (new.lead_id,new.appointment_type,new.appointment_status,new.audience,new.due_at) is not distinct from
       (old.lead_id,old.appointment_type,old.appointment_status,old.audience,old.due_at) then return new; end if;
  end if;
  perform public.sync_calendar_lead_stage(new.client_id,new.lead_id,new.appointment_type,new.due_at);
  return new;
end;
$$;

create or replace function public.sync_google_booking_pipeline()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op='UPDATE' then
    if (new.lead_id,new.appointment_type,new.outcome,new.revenue_type,new.starts_at,new.next_action_at) is not distinct from
       (old.lead_id,old.appointment_type,old.outcome,old.revenue_type,old.starts_at,old.next_action_at) then return new; end if;
  end if;
  if new.outcome='closing_booked' then
    perform public.sync_calendar_lead_stage(new.client_id,new.lead_id,'demo',new.next_action_at);
  else
    perform public.sync_calendar_lead_stage(new.client_id,new.lead_id,new.appointment_type,new.starts_at);
  end if;
  return new;
end;
$$;

revoke all on function public.sync_calendar_lead_stage(uuid,uuid,text,timestamptz),
  public.sync_crm_booking_pipeline(),public.sync_google_booking_pipeline() from public, anon, authenticated;

create or replace trigger sync_crm_booking_pipeline
  after insert or update of lead_id,appointment_type,appointment_status,audience,due_at on public.sales_tasks
  for each row when (new.lead_id is not null and new.audience='lead' and new.appointment_status in ('scheduled','rescheduled')
    and new.appointment_type in ('discovery','demo')) execute function public.sync_crm_booking_pipeline();

create or replace trigger sync_google_booking_pipeline
  after insert or update of lead_id,appointment_type,outcome,revenue_type,starts_at,next_action_at on public.google_sales_appointments
  for each row when (new.lead_id is not null and new.revenue_type='new' and new.outcome in ('pending','closing_booked')
    and new.appointment_type in ('discovery','demo')) execute function public.sync_google_booking_pipeline();

commit;
