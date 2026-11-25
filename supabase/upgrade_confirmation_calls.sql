begin;

alter table public.sales_tasks add column if not exists confirmation_for uuid;
create unique index if not exists sales_tasks_confirmation_slot_idx on public.sales_tasks (confirmation_for, due_at)
  where confirmation_for is not null and completed_at is null and appointment_status = 'scheduled';

create or replace function public.book_confirmation_call(
  p_id uuid, p_closing_id uuid, p_starts_at timestamptz, p_title text, p_note text default null
) returns public.sales_tasks
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  closing public.sales_tasks;
  booking public.sales_tasks;
  author text := public.my_full_name();
begin
  if auth.uid() is null or nullif(trim(author), '') is null then raise exception 'Accesso richiesto'; end if;
  if p_id is null or p_starts_at is null or nullif(trim(p_title), '') is null then raise exception 'Dati della conferma incompleti'; end if;

  select t.* into closing from public.sales_tasks t where t.id = p_closing_id and t.appointment_type = 'demo'
    and t.appointment_status in ('held', 'scheduled', 'rescheduled') for update;
  if not found then raise exception 'Closing non disponibile'; end if;

  select t.* into booking from public.sales_tasks t where t.id = p_id;
  if found then
    if booking.confirmation_for is distinct from closing.id or booking.due_at is distinct from p_starts_at then
      raise exception 'Richiesta già usata per un altro appuntamento';
    end if;
    return booking;
  end if;
  if p_starts_at <= now() or p_starts_at < closing.due_at + make_interval(mins => coalesce(closing.duration_minutes, 60)) then
    raise exception 'Scegli un orario futuro dopo la closing';
  end if;

  select t.* into booking from public.sales_tasks t where t.confirmation_for = closing.id and t.due_at = p_starts_at
    and t.completed_at is null and t.appointment_status = 'scheduled';
  if found then return booking; end if;

  insert into public.sales_tasks (id,client_id,lead_id,confirmation_for,title,description,due_at,assigned_to,created_by,
    appointment_status,appointment_host,duration_minutes,commercial_tracked)
  values (p_id,closing.client_id,closing.lead_id,closing.id,trim(p_title),nullif(trim(p_note),''),p_starts_at,author,author,
    'scheduled',author,30,false) returning * into booking;
  return booking;
end;
$$;

revoke all on function public.book_confirmation_call(uuid,uuid,timestamptz,text,text) from public, anon;
grant execute on function public.book_confirmation_call(uuid,uuid,timestamptz,text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
