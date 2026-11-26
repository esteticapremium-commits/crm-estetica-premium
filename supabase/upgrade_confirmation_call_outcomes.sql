-- Apply after upgrade_confirmation_calls. Confirmation calls keep their own outcome.
begin;

create or replace function public.save_confirmation_call_outcome(
  p_id uuid, p_expected_updated_at timestamptz, p_outcome text
) returns public.sales_tasks
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  task public.sales_tasks;
  author text := public.my_full_name();
begin
  if auth.uid() is null or nullif(trim(author), '') is null then raise exception 'Accesso richiesto'; end if;
  if p_outcome is null or p_outcome not in ('held', 'no_show') then raise exception 'Esito non valido per una call di conferma'; end if;

  select * into task from public.sales_tasks
  where id = p_id and confirmation_for is not null and appointment_type is null
  for update;
  if not found then raise exception 'Call di conferma non accessibile'; end if;
  if task.appointment_status = 'cancelled' then raise exception 'Appuntamento annullato'; end if;
  if task.due_at > now() and p_outcome <> 'no_show' then
    raise exception 'Prima dell’orario puoi registrare solo un no-show';
  end if;
  if task.appointment_status = p_outcome and task.appointment_outcome = p_outcome
    and task.completed_at is not null then return task; end if;
  if task.updated_at is distinct from p_expected_updated_at then
    raise exception 'Appuntamento aggiornato da un collega. Riaprilo prima di correggere l’esito.';
  end if;

  update public.sales_tasks
  set appointment_status = p_outcome,
      appointment_outcome = p_outcome,
      completed_at = now(),
      completed_by = author
  where id = task.id
  returning * into task;
  if not found then raise exception 'Modifica non autorizzata'; end if;
  return task;
end;
$$;

revoke all on function public.save_confirmation_call_outcome(uuid, timestamptz, text) from public, anon;
grant execute on function public.save_confirmation_call_outcome(uuid, timestamptz, text) to authenticated;
notify pgrst, 'reload schema';

commit;
