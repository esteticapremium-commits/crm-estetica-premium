-- Spostamento atomico: usa i permessi RLS esistenti, senza ampliarli.
create or replace function public.reschedule_crm_appointment(
  p_task_id uuid, p_expected_updated_at timestamptz, p_title text,
  p_starts_at timestamptz, p_note text, p_duration_minutes integer
) returns void
language plpgsql security invoker set search_path = public
as $$
declare
  t public.sales_tasks%rowtype;
  affected integer;
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  if p_starts_at is null or nullif(trim(p_title), '') is null
     or p_duration_minutes is null or p_duration_minutes < 1 then
    raise exception 'Titolo, data e durata non validi';
  end if;
  select * into t from public.sales_tasks where id = p_task_id for update;
  if not found then raise exception 'Appuntamento non trovato o non autorizzato'; end if;
  if t.updated_at is distinct from p_expected_updated_at then
    raise exception 'Appuntamento modificato da un collega: aggiorna la pagina';
  end if;
  if t.completed_at is not null or t.appointment_status in ('held', 'no_show', 'cancelled') then
    raise exception 'Call già chiusa: crea una nuova prenotazione';
  end if;
  update public.sales_tasks set title = p_title, due_at = p_starts_at,
    description = p_note, duration_minutes = p_duration_minutes where id = t.id;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Modifica non autorizzata'; end if;
  if t.lead_id is not null and t.appointment_type in ('discovery', 'demo') then
    update public.lead_activities set scheduled_at = p_starts_at, duration_minutes = p_duration_minutes
      where client_id = t.client_id and event_key = 'appointment:' || t.id::text || ':booked';
    get diagnostics affected = row_count;
    if affected <> 1 then raise exception 'Prenotazione KPI collegata non trovata o non modificabile'; end if;
    if t.due_at is distinct from p_starts_at then
      insert into public.lead_activities
        (lead_id, client_id, activity_type, event_type, channel, outcome,
         occurred_at, scheduled_at, created_by, details, event_key)
      values (t.lead_id, t.client_id, 'meeting', 'appointment_rescheduled',
        case when t.appointment_type = 'demo' then 'video_call' else 'phone' end,
        'rescheduled', now(), p_starts_at, public.my_full_name(),
        jsonb_build_object('task_id', t.id, 'assigned_to', t.assigned_to,
          'previous_at', t.due_at, 'new_at', p_starts_at),
        'appointment:' || t.id::text || ':rescheduled:' || gen_random_uuid()::text);
    end if;
    update public.leads set next_action_date = (p_starts_at at time zone 'Europe/Rome')::date
      where id = t.lead_id and client_id = t.client_id;
  end if;
end;
$$;
revoke all on function public.reschedule_crm_appointment(uuid,timestamptz,text,timestamptz,text,integer) from public, anon;
grant execute on function public.reschedule_crm_appointment(uuid,timestamptz,text,timestamptz,text,integer) to authenticated;
notify pgrst, 'reload schema';

select proname, not prosecdef as usa_permessi_esistenti
from pg_proc where oid = 'public.reschedule_crm_appointment(uuid,timestamptz,text,timestamptz,text,integer)'::regprocedure;
