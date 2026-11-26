-- Apply after upgrade_confirmation_call_outcomes.
begin;

create or replace function public.save_confirmation_call_outcome_and_close_lead(
  p_id uuid, p_expected_updated_at timestamptz, p_outcome text, p_expected_stage_id uuid
) returns public.sales_tasks
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  task public.sales_tasks;
  target public.leads;
  lost_stage uuid;
  activity_key text := 'confirmation:' || p_id || ':not-interested';
begin
  task := public.save_confirmation_call_outcome(p_id, p_expected_updated_at, p_outcome);
  select * into target from public.leads
    where id = task.lead_id and client_id = task.client_id for update;
  if not found then raise exception 'Lead collegato non accessibile'; end if;

  select s.id into lost_stage from public.stages s
    where s.client_id = target.client_id and s.pipeline_id = target.pipeline_id
      and upper(trim(s.name)) = 'LOST' order by s.position,s.id limit 1;
  if not found then raise exception 'La colonna LOST non è disponibile in questa pipeline'; end if;
  if target.stage_id = lost_stage then return task; end if;
  if target.stage_id is distinct from p_expected_stage_id then
    raise exception 'La fase del lead è cambiata. Chiudi e riapri l’appuntamento prima di riprovare.';
  end if;

  update public.leads l set stage_id = lost_stage,
    position = least(0,coalesce((select min(other.position) from public.leads other
      where other.client_id=target.client_id and other.pipeline_id=target.pipeline_id and other.stage_id=lost_stage),0))-1,
    lost_reason = 'Non interessato più', next_action_date = null
    where l.id = target.id;
  if not found then raise exception 'Spostamento del lead non autorizzato'; end if;

  insert into public.lead_activities (lead_id,client_id,pipeline_id,activity_type,event_type,outcome,
    occurred_at,created_by,details,event_key)
  values (target.id,target.client_id,target.pipeline_id,'follow_up','follow_up','not_interested',
    now(),public.my_full_name(),jsonb_build_object('task_id',task.id,'assigned_to',target.assigned_to),activity_key)
  on conflict (client_id,event_key) do nothing;
  return task;
end;
$$;

revoke all on function public.save_confirmation_call_outcome_and_close_lead(uuid,timestamptz,text,uuid) from public, anon;
grant execute on function public.save_confirmation_call_outcome_and_close_lead(uuid,timestamptz,text,uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
