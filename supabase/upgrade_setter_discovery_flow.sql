begin;

create or replace function public.save_setter_discovery(
  p_lead_id uuid, p_request_id uuid, p_due_at timestamptz, p_note text, p_record_call boolean
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  caller public.profiles;
  target public.leads;
  assignment public.setter_assignments;
  booked_id uuid;
  new_title text;
begin
  select * into caller from public.profiles where id=auth.uid() and role='setter';
  if not found then raise exception 'Accesso riservato al setter assegnato'; end if;
  select * into target from public.leads where id=p_lead_id and client_id=caller.client_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;
  select * into assignment from public.setter_assignments
    where lead_id=p_lead_id and setter_id=caller.id and client_id=caller.client_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;
  if p_record_call is null or assignment.state='not_interested' then raise exception 'Prenotazione non disponibile'; end if;
  if p_record_call then
    perform public.record_setter_contact(p_lead_id,p_request_id,'answered',null,null);
  end if;
  booked_id := public.book_setter_discovery(p_lead_id,p_request_id,p_due_at,p_note);
  new_title := coalesce(nullif(trim(target.name),''),'Lead') || ' — Discovery';
  update public.sales_tasks set title=new_title where id=booked_id and setter_id=caller.id
    and client_id=caller.client_id and title is distinct from new_title;
  update public.lead_activities set channel='video_call'
    where client_id=caller.client_id and lead_id=p_lead_id and event_type='discovery_booked'
      and event_key='appointment:'||booked_id||':booked' and channel is distinct from 'video_call';
  return booked_id;
end;
$$;

create or replace function public.carry_setter_on_discovery_rebooking()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  caller public.profiles;
  replacement public.sales_tasks;
  original public.sales_tasks;
  source_key text := new.details->>'source_outcome_key';
begin
  if new.event_type is distinct from 'discovery_booked' or new.outcome is distinct from 'scheduled'
    or new.call_type is distinct from 'lead' or nullif(source_key,'') is null then return new; end if;
  select * into caller from public.profiles where id=auth.uid() and role in ('admin','venditore');
  if not found or (caller.role='venditore' and caller.client_id is distinct from new.client_id) then return new; end if;
  select t.* into replacement from public.sales_tasks t
    where t.id::text=new.details->>'task_id' and t.client_id=new.client_id and t.lead_id=new.lead_id
      and t.appointment_type='discovery' and t.appointment_status='scheduled' and t.setter_id is null
      and t.created_at=new.occurred_at and t.due_at=new.scheduled_at
      and new.event_key='appointment:'||t.id||':booked'
      and (caller.role='admin' or t.assigned_to=public.my_full_name());
  if not found then return new; end if;
  select t.* into original from public.lead_activities outcome
    join public.sales_tasks t on t.id::text=outcome.details->>'task_id' and t.client_id=outcome.client_id
      and t.lead_id=outcome.lead_id
    where outcome.client_id=new.client_id and outcome.lead_id=new.lead_id and outcome.event_key=source_key
      and outcome.event_type='discovery_call' and outcome.outcome in ('no_answer','no_show')
      and t.appointment_type='discovery' and t.appointment_status='no_show' and t.setter_id is not null
      and outcome.event_key='appointment:'||t.id||':outcome';
  if not found then return new; end if;
  update public.setter_assignments set discovery_task_id=replacement.id, state='booked', updated_at=now()
    where client_id=new.client_id and lead_id=new.lead_id and setter_id=original.setter_id and discovery_task_id=original.id;
  if found then
    update public.sales_tasks set setter_id=original.setter_id where id=replacement.id and setter_id is null;
  end if;
  return new;
end;
$$;

revoke all on function public.save_setter_discovery(uuid,uuid,timestamptz,text,boolean) from public, anon;
grant execute on function public.save_setter_discovery(uuid,uuid,timestamptz,text,boolean) to authenticated;
revoke all on function public.carry_setter_on_discovery_rebooking() from public, anon, authenticated;
drop trigger if exists carry_setter_on_discovery_rebooking on public.lead_activities;
create trigger carry_setter_on_discovery_rebooking after insert on public.lead_activities
  for each row when (new.event_type = 'discovery_booked')
  execute function public.carry_setter_on_discovery_rebooking();

notify pgrst, 'reload schema';
commit;
