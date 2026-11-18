begin;

alter table public.google_sales_appointments add column if not exists closing_reference text;
alter table public.google_sales_appointments drop constraint if exists google_sales_appointments_outcome_check;
alter table public.google_sales_appointments add constraint google_sales_appointments_outcome_check
  check (outcome in ('excluded','pending','won','follow_up','lost','no_show','rescheduled','closing_booked'));
alter table public.google_sales_appointments drop constraint if exists google_sales_discovery_closing_check;
alter table public.google_sales_appointments add constraint google_sales_discovery_closing_check
  check (outcome <> 'closing_booked' or (
    appointment_type = 'discovery' and qualified is true and closing_reference is not null
    and next_action_at is not null and next_action_at > starts_at
  ));

create or replace function public.save_google_discovery_with_closing(
  p_client_id uuid, p_sale jsonb, p_expected_version integer, p_closing jsonb
) returns public.google_sales_appointments
language plpgsql security definer set search_path = public
as $$
declare
  actor uuid := auth.uid();
  admin boolean := coalesce(public.is_admin(), false);
  reference text := p_closing->>'reference';
  discovery_at timestamptz := (p_sale->>'starts_at')::timestamptz;
  closing_at timestamptz;
  closing_lead uuid;
  crm public.sales_tasks;
  google_row public.google_sales_appointments;
  result public.google_sales_appointments;
begin
  if actor is null or (not admin and p_client_id is distinct from public.my_client_id()) then
    raise exception 'Non autorizzato';
  end if;
  if p_sale->>'appointment_type' is distinct from 'discovery' or p_sale->>'outcome' is distinct from 'closing_booked'
     or reference is null or length(reference) > 1507 or discovery_at is null or discovery_at > now() then
    raise exception 'Serve una Discovery già svolta e una Closing prenotata';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text || ':google-sales', 0));
  if reference like 'crm:%' then
    select * into crm from public.sales_tasks
      where id=substring(reference from 5)::uuid and client_id=p_client_id and appointment_type='demo'
        and appointment_status is distinct from 'cancelled'
        and (admin or assigned_to=public.my_full_name()) for share;
    if not found then raise exception 'Closing CRM non trovata o non accessibile'; end if;
    closing_at := crm.due_at;
    closing_lead := crm.lead_id;
  elsif reference like 'google:%' then
    if substring(reference from 8)=p_sale->>'google_key'
       or nullif(p_closing->>'google_event_id','')=p_sale->>'google_event_id' then
      raise exception 'La Closing deve essere un evento diverso dalla Discovery';
    end if;
    select * into google_row from public.google_sales_appointments
      where client_id=p_client_id and google_key=substring(reference from 8) for update;
    if found then
      if not admin and google_row.owner_id is distinct from actor then raise exception 'Closing Google non accessibile'; end if;
      if google_row.appointment_type<>'demo' or google_row.outcome='excluded' then
        raise exception 'Questo evento è già classificato con un altro tipo o è escluso';
      end if;
    else
      if nullif(p_closing->>'google_event_id','') is null then raise exception 'Scegli la Closing dal calendario'; end if;
      google_row := public.save_google_sale(p_client_id, jsonb_build_object(
        'google_key',substring(reference from 8),'google_event_id',p_closing->>'google_event_id',
        'starts_at',p_closing->>'starts_at','booked_at',p_closing->>'booked_at',
        'title', btrim(p_sale->>'contact_name') || ' — Closing', 'contact_name',p_sale->>'contact_name',
        'lead_id',p_sale->>'lead_id','appointment_type','demo','revenue_type','new','outcome','pending'
      ),0);
    end if;
    closing_at := google_row.starts_at;
    closing_lead := google_row.lead_id;
  else
    raise exception 'Scegli una Closing valida';
  end if;
  if closing_at is null or closing_at<=discovery_at then
    raise exception 'La Closing deve essere successiva alla Discovery';
  end if;
  if closing_lead is not null and nullif(p_sale->>'lead_id','') is not null
     and closing_lead is distinct from (p_sale->>'lead_id')::uuid then
    raise exception 'La Closing è già collegata a un altro lead';
  end if;

  result := public.save_google_sale(p_client_id, p_sale || jsonb_build_object(
    'outcome','follow_up','qualified',true,'proposal_made',false,
    'next_action_at',closing_at,'closing_reference',reference
  ),p_expected_version);
  if result.outcome is distinct from 'closing_booked' or result.closing_reference is distinct from reference then
    update public.google_sales_appointments
      set outcome='closing_booked', closing_reference=reference
      where id=result.id and client_id=p_client_id returning * into result;
  end if;
  return result;
end;
$$;

revoke all on function public.save_google_discovery_with_closing(uuid,jsonb,integer,jsonb) from public, anon;
grant execute on function public.save_google_discovery_with_closing(uuid,jsonb,integer,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
