begin;

create or replace function public.move_setter_contact(
  p_client_id uuid, p_contact_id uuid, p_database_contact boolean,
  p_from text, p_to text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  source_state text;
  handed_off boolean;
  target_lead public.leads;
begin
  if actor is null or not exists (
    select 1 from public.profiles where id = actor and role = 'setter' and client_id = p_client_id
  ) then raise exception 'Accesso riservato al setter assegnato'; end if;

  if p_database_contact is null or p_from is null or p_to is null
    or p_from not in ('new', 'follow_up', 'not_interested')
    or p_to not in ('new', 'follow_up', 'not_interested') then
    raise exception 'Spostamento non disponibile';
  end if;

  if p_database_contact then
    select state, handed_off_at is not null into source_state, handed_off
    from public.database_leads
    where id = p_contact_id and client_id = p_client_id and setter_id = actor and archived_at is null
    for update;
  else
    select * into target_lead from public.leads
    where id = p_contact_id and client_id = p_client_id for update;
    if not found then raise exception 'Lead non accessibile'; end if;
    select state, discovery_task_id is not null into source_state, handed_off
    from public.setter_assignments
    where lead_id = p_contact_id and client_id = p_client_id and setter_id = actor
    for update;
    handed_off := handed_off or exists (
      select 1 from public.stages where id = target_lead.stage_id
      and upper(trim(name)) in ('CLOSING', 'CLOSED', 'LOST')
    );
  end if;

  if source_state is null then raise exception 'Lead non accessibile'; end if;
  if handed_off or source_state = 'booked' then raise exception 'Il lead è già passato alla vendita'; end if;
  if source_state = p_to then return; end if;
  if source_state is distinct from p_from then raise exception 'Il lead è cambiato. Aggiorna la pipeline e riprova'; end if;

  if p_database_contact then
    update public.database_leads
    set state = p_to, callback_at = case when p_to = 'follow_up' then callback_at end, updated_at = now()
    where id = p_contact_id and client_id = p_client_id and setter_id = actor;
  else
    update public.setter_assignments
    set state = p_to, callback_at = case when p_to = 'follow_up' then callback_at end, updated_at = now()
    where lead_id = p_contact_id and client_id = p_client_id and setter_id = actor;
  end if;
end;
$$;

revoke all on function public.move_setter_contact(uuid,uuid,boolean,text,text) from public, anon;
grant execute on function public.move_setter_contact(uuid,uuid,boolean,text,text) to authenticated;
commit;
