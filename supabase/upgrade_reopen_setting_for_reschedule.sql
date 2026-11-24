begin;

create or replace function public.reopen_and_reschedule_setting(
  p_task_id uuid, p_expected_updated_at timestamptz, p_title text,
  p_starts_at timestamptz, p_note text, p_duration_minutes integer
) returns void
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  setting public.sales_tasks;
  outcome_key text := 'appointment:' || p_task_id || ':outcome';
  revised_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  if p_starts_at is null or p_starts_at <= now() then raise exception 'Scegli un nuovo orario futuro'; end if;
  select t.* into setting from public.sales_tasks t where t.id = p_task_id for update;
  if not found then raise exception 'Appuntamento non accessibile'; end if;
  if setting.updated_at is distinct from p_expected_updated_at then
    raise exception 'Appuntamento aggiornato da un collega. Riaprilo prima di riprogrammarlo';
  end if;
  if setting.appointment_type is distinct from 'setting' or setting.appointment_status is distinct from 'held'
    or setting.appointment_outcome is distinct from 'answered' then
    raise exception 'È possibile riaprire solo un setting registrato come svolto';
  end if;
  if exists(select 1 from public.lead_activities a where a.client_id=setting.client_id and a.lead_id=setting.lead_id
    and a.event_type='discovery_booked' and a.details->>'source_outcome_key'=outcome_key) then
    raise exception 'A questo esito è già collegata una discovery';
  end if;

  update public.lead_activities a set
    event_key = outcome_key || ':correction:' || gen_random_uuid(),
    event_type = 'appointment_correction', outcome = 'rescheduled',
    details = coalesce(a.details,'{}'::jsonb) || jsonb_build_object(
      'previous_outcome', a.outcome, 'previous_event_type', a.event_type,
      'corrected_at', now(), 'corrected_by', public.my_full_name())
  where a.client_id=setting.client_id and a.event_key=outcome_key and a.lead_id=setting.lead_id
    and a.event_type='setting_call' and a.outcome='answered';
  if setting.lead_id is not null and not found then raise exception 'Esito originale del setting non trovato'; end if;

  update public.sales_tasks t set appointment_status='scheduled', appointment_outcome=null,
    completed_at=null, completed_by=null, outcome_minutes=null, outcome_note=null
  where t.id=setting.id returning t.updated_at into revised_at;
  if not found then raise exception 'Modifica non autorizzata'; end if;
  perform public.reschedule_crm_appointment(setting.id,revised_at,p_title,p_starts_at,p_note,p_duration_minutes);
end;
$$;

revoke all on function public.reopen_and_reschedule_setting(uuid,timestamptz,text,timestamptz,text,integer) from public, anon;
grant execute on function public.reopen_and_reschedule_setting(uuid,timestamptz,text,timestamptz,text,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
