begin;

create table if not exists public.setter_calendar_reservations (
  id uuid primary key,
  setter_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null,
  database_contact boolean not null,
  starts_at timestamptz not null,
  event_pending boolean not null default false,
  finished boolean not null default false,
  lease_until timestamptz not null
);
alter table public.setter_calendar_reservations enable row level security;
revoke all on table public.setter_calendar_reservations from public, anon, authenticated;

create or replace function public.prepare_setter_calendar_booking(
  p_setter_id uuid, p_contact_id uuid, p_database_contact boolean, p_starts_at timestamptz, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  client uuid;
  calendar_owner uuid;
  contact_name text;
  contact_state text;
  reserved public.setter_calendar_reservations;
  booking_id uuid;
begin
  select p.client_id into client from public.profiles p join public.clients c on c.id=p.client_id
    where p.id=p_setter_id and p.role='setter' and c.name='Estetica Premium';
  if not found then raise exception 'Accesso riservato ai setter di Estetica Premium'; end if;

  if p_database_contact then
    select d.name,d.state into contact_name,contact_state from public.database_leads d
      where d.id=p_contact_id and d.setter_id=p_setter_id and d.client_id=client;
  else
    select l.name,a.state into contact_name,contact_state from public.setter_assignments a
      join public.leads l on l.id=a.lead_id and l.client_id=a.client_id
      where a.lead_id=p_contact_id and a.setter_id=p_setter_id and a.client_id=client;
  end if;
  if not found then raise exception 'Lead non accessibile'; end if;

  select p.id into calendar_owner from public.profiles p join auth.users u on u.id=p.id
    where p.role='admin' and (p.client_id=client or p.client_id is null)
      and lower(u.email)='ettoreandrosoni@estetica-premium.it';
  if calendar_owner is null then raise exception 'Calendario del titolare non configurato'; end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('setter-calendar:'||calendar_owner,0));
    select t.id into booking_id from public.sales_tasks t
      where t.id=p_request_id and t.client_id=client and t.setter_id=p_setter_id and t.due_at=p_starts_at
        and t.google_event_id=replace(t.id::text,'-','')
        and (case when p_database_contact then exists (
          select 1 from public.database_leads d where d.id=p_contact_id and d.lead_id=t.lead_id
        ) else t.lead_id=p_contact_id end);
    if found then return jsonb_build_object('booked',true); end if;
  end if;

  if contact_state in ('booked','not_interested') then raise exception 'Questo lead non è disponibile per una nuova prenotazione'; end if;
  if p_starts_at is null or p_starts_at<=now() then raise exception 'Scegli data e ora future'; end if;
  select * into reserved from public.setter_calendar_reservations
    where setter_id=p_setter_id and contact_id=p_contact_id and database_contact=p_database_contact
      and starts_at=p_starts_at and not finished and (id=p_request_id or lease_until<=clock_timestamp())
    order by event_pending desc,(id=p_request_id) desc,lease_until desc limit 1;
  if exists (select 1 from public.setter_calendar_reservations r
    where r.setter_id=p_setter_id and r.contact_id=p_contact_id and r.database_contact=p_database_contact
      and r.event_pending and r.starts_at>now() and r.starts_at<>p_starts_at
  ) then raise exception 'Una prenotazione precedente è in verifica. Riprova sull’orario già scelto.'; end if;
  if exists (select 1 from public.setter_calendar_reservations r
    join public.sales_tasks t on r.id=t.id
    where r.finished and t.appointment_status in ('scheduled','rescheduled') and t.completed_at is null
      and t.due_at<p_starts_at+interval '30 minutes'
      and t.due_at+make_interval(mins=>coalesce(t.duration_minutes,30))>p_starts_at
  ) or exists (select 1 from public.setter_calendar_reservations r
    where not r.finished and r.lease_until>clock_timestamp() and (
      (r.setter_id=p_setter_id and r.contact_id=p_contact_id and r.database_contact=p_database_contact)
      or (r.starts_at<p_starts_at+interval '30 minutes' and r.starts_at+interval '30 minutes'>p_starts_at)
    )) then
    return jsonb_build_object('busy',true);
  end if;

  if p_request_id is not null then
    delete from public.setter_calendar_reservations r where r.starts_at<now()-interval '30 minutes'
      and (not r.finished or not exists(select 1 from public.sales_tasks t where t.id=r.id and t.due_at>=now()));
    insert into public.setter_calendar_reservations(id,setter_id,contact_id,database_contact,starts_at,lease_until)
      values(coalesce(reserved.id,p_request_id),p_setter_id,p_contact_id,p_database_contact,p_starts_at,clock_timestamp()+interval '2 minutes')
    on conflict(id) do update set lease_until=excluded.lease_until
      where setter_calendar_reservations.setter_id=excluded.setter_id
        and setter_calendar_reservations.contact_id=excluded.contact_id
        and setter_calendar_reservations.database_contact=excluded.database_contact
        and setter_calendar_reservations.starts_at=excluded.starts_at
    returning * into reserved;
    if not found then raise exception 'Richiesta di prenotazione non valida'; end if;
  end if;
  return jsonb_build_object('owner_id',calendar_owner,'request_id',reserved.id,'lease_until',reserved.lease_until,
    'title',coalesce(nullif(trim(contact_name),''),'Lead')||' — Discovery');
end;
$$;

create or replace function public.finish_setter_calendar_booking(
  p_request_id uuid, p_lease_until timestamptz, p_note text, p_record_call boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  reserved public.setter_calendar_reservations;
  booked uuid;
begin
  select * into reserved from public.setter_calendar_reservations
    where id=p_request_id and not finished and lease_until=p_lease_until and lease_until>clock_timestamp() for update;
  if not found then raise exception 'Prenotazione in corso di verifica. Riprova sullo stesso orario.'; end if;
  perform set_config('request.jwt.claim.sub',reserved.setter_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',reserved.setter_id,'role','authenticated')::text,true);
  begin
    if reserved.database_contact then
      booked := public.book_database_setter_discovery(reserved.contact_id,reserved.id,reserved.starts_at,p_note,p_record_call);
    else
      booked := public.save_setter_discovery(reserved.contact_id,reserved.id,reserved.starts_at,p_note,p_record_call);
    end if;
    if booked is distinct from reserved.id then raise exception 'Identità della discovery non coerente'; end if;
    update public.sales_tasks set google_event_id=replace(booked::text,'-','') where id=booked;
    if not found then raise exception 'Appuntamento CRM non trovato'; end if;
    update public.setter_calendar_reservations set finished=true,event_pending=false where id=reserved.id;
  exception when raise_exception then
    return jsonb_build_object('rejected',sqlerrm);
  end;
  return jsonb_build_object('booked',true);
end;
$$;

revoke all on function public.prepare_setter_calendar_booking(uuid,uuid,boolean,timestamptz,uuid),
  public.finish_setter_calendar_booking(uuid,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.prepare_setter_calendar_booking(uuid,uuid,boolean,timestamptz,uuid),
  public.finish_setter_calendar_booking(uuid,timestamptz,text,boolean) to service_role;
-- The old RPCs remain available to definer functions, but setters must go
-- through Calendar verification before a discovery is recorded.
revoke execute on function public.book_setter_discovery(uuid,uuid,timestamptz,text),
  public.save_setter_discovery(uuid,uuid,timestamptz,text,boolean),
  public.book_database_setter_discovery(uuid,uuid,timestamptz,text,boolean) from authenticated;
grant select, update, delete on table public.setter_calendar_reservations to service_role;

notify pgrst, 'reload schema';
commit;
