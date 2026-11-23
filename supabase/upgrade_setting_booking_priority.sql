begin;

create or replace function public.prioritize_lead_on_setting_booking()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  target public.leads;
  setting_stage_id uuid;
begin
  select l.* into target
    from public.leads l
    join public.stages s on s.id = l.stage_id and s.client_id = l.client_id and s.pipeline_id = l.pipeline_id
    where l.id = new.lead_id and l.client_id = new.client_id
      and upper(trim(s.name)) in ('RECALL', 'SETTING')
    for update of l;
  if not found then return new; end if;

  select s.id into setting_stage_id from public.stages s
    where s.client_id = target.client_id and s.pipeline_id = target.pipeline_id and upper(trim(s.name)) = 'SETTING'
    order by (s.id = target.stage_id) desc, s.position, s.id limit 1;
  if setting_stage_id is null then return new; end if;

  -- Serialize new setting bookings in the same column before choosing its first position.
  perform pg_advisory_xact_lock(hashtextextended('setting-booking-column:' || setting_stage_id, 0));
  update public.leads set
    stage_id = setting_stage_id,
    position = least(0, coalesce((select min(l.position) from public.leads l
      where l.client_id = target.client_id and l.pipeline_id = target.pipeline_id and l.stage_id = setting_stage_id), 0)) - 1,
    next_action_date = (new.due_at at time zone 'Europe/Rome')::date
    where id = target.id;
  return new;
end;
$$;

revoke all on function public.prioritize_lead_on_setting_booking() from public, anon, authenticated;

create or replace trigger prioritize_lead_on_setting_booking
  after insert on public.sales_tasks
  for each row when (new.lead_id is not null and new.appointment_type = 'setting' and new.audience = 'lead'
    and new.appointment_status = 'scheduled' and new.completed_at is null)
  execute function public.prioritize_lead_on_setting_booking();

commit;
