begin;

do $migration$
declare
  definition text := pg_get_functiondef('public.save_sales_appointment_outcome(uuid,timestamptz,text,integer,text,boolean)'::regprocedure);
  allowed_before text := $body$task.appointment_type = 'demo' and p_outcome in ('held', 'no_show')$body$;
  allowed_after text := $body$task.appointment_type = 'demo' and p_outcome in ('held', 'lost', 'no_show')$body$;
  proposal_before text := $body$result_proposal := case when task.appointment_type = 'demo' and result_status = 'held'$body$;
  proposal_after text := $body$result_proposal := case when task.appointment_type = 'demo' and p_outcome = 'lost' then true
    when task.appointment_type = 'demo' and result_status = 'held'$body$;
begin
  if strpos(definition, allowed_after) = 0 then
    if strpos(definition, allowed_before) = 0 then raise exception 'Convalida esiti closing da verificare'; end if;
    definition := replace(definition, allowed_before, allowed_after);
  end if;
  if strpos(definition, proposal_after) = 0 then
    if strpos(definition, proposal_before) = 0 then raise exception 'Registrazione proposta da verificare'; end if;
    definition := replace(definition, proposal_before, proposal_after);
  end if;
  execute definition;
end;
$migration$;

create or replace function public.confirm_discovery_on_closing_booking()
returns trigger language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  closing public.sales_tasks;
  discovery public.sales_tasks;
begin
  select t.* into closing from public.sales_tasks t
  where t.id::text = new.details->>'task_id' and t.client_id = new.client_id and t.lead_id = new.lead_id
    and t.appointment_type = 'demo' and t.appointment_status = 'scheduled'
    and t.due_at = new.scheduled_at and t.created_at = new.occurred_at
    and new.event_key = 'appointment:' || t.id || ':booked';
  if not found or closing.audience = 'client' or auth.uid() is null then return new; end if;

  select t.* into discovery from public.sales_tasks t
  where t.client_id = closing.client_id and t.lead_id = closing.lead_id and t.appointment_type = 'discovery'
    and t.appointment_status is distinct from 'cancelled' and t.audience is distinct from 'client'
    and t.due_at <= least(closing.created_at, now()) and t.due_at < closing.due_at
  order by t.due_at desc, t.created_at desc, t.id limit 1 for update;
  if not found then return new; end if;
  if discovery.appointment_status in ('scheduled', 'rescheduled')
    and discovery.appointment_outcome is null and discovery.completed_at is null then
    perform public.save_sales_appointment_outcome(discovery.id, discovery.updated_at, 'qualified', null, null, null);
  elsif discovery.appointment_outcome is distinct from 'qualified' then
    return new;
  end if;
  if new.details->>'source_outcome_key' is null then
    new.details := new.details || jsonb_build_object('source_outcome_key', 'appointment:' || discovery.id || ':outcome');
  end if;
  return new;
end;
$$;

revoke all on function public.confirm_discovery_on_closing_booking() from public, anon, authenticated;
create or replace trigger confirm_discovery_on_closing_booking before insert on public.lead_activities
  for each row when (new.event_type = 'demo_booked' and new.outcome = 'scheduled' and new.lead_id is not null)
  execute function public.confirm_discovery_on_closing_booking();

notify pgrst, 'reload schema';
commit;
