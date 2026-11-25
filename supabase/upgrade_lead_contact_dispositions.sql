begin;

create or replace function public.record_lead_contact_disposition(
  p_lead_id uuid, p_expected_stage_id uuid, p_request_id uuid,
  p_outcome text, p_contact_type text, p_note text, p_recall_at timestamptz
) returns public.leads
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  target public.leads;
  destination uuid;
  stage_name text;
  activity_key text := 'contact-disposition:' || p_request_id;
  author text := public.my_full_name();
  note_text text := nullif(trim(p_note), '');
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  if p_request_id is null or p_outcome is null or p_outcome not in ('not_available_now', 'not_interested')
    or p_contact_type is null or p_contact_type not in ('setting', 'lead', 'outbound', 'client', 'other') then
    raise exception 'Esito del contatto non valido';
  end if;

  select l.* into target from public.leads l where l.id=p_lead_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;
  if exists(select 1 from public.lead_activities a where a.client_id=target.client_id and a.lead_id=target.id
    and a.event_key=activity_key and a.outcome=p_outcome) then return target; end if;
  if target.stage_id is distinct from p_expected_stage_id then raise exception 'La fase del lead è cambiata. Riapri la scheda e riprova'; end if;
  if p_recall_at is not null and (p_outcome <> 'not_available_now' or p_recall_at <= now()) then
    raise exception 'Scegli una data e un orario futuri per il richiamo';
  end if;

  stage_name := case when p_outcome='not_interested' then 'LOST' else 'RECALL' end;
  select s.id into destination from public.stages s where s.client_id=target.client_id and s.pipeline_id=target.pipeline_id
    and upper(trim(s.name))=stage_name order by s.position,s.id limit 1;
  if destination is null then raise exception 'La colonna % non è disponibile in questa pipeline', stage_name; end if;

  update public.leads l set stage_id=destination,
    position=case when l.stage_id=destination then l.position else least(0,coalesce((select min(other.position)
      from public.leads other where other.client_id=target.client_id and other.pipeline_id=target.pipeline_id and other.stage_id=destination),0))-1 end,
    lost_reason=case when p_outcome='not_interested' then 'Non interessato più' else null end,
    next_action_date=case when p_outcome='not_interested' then null when p_recall_at is not null then (p_recall_at at time zone 'Europe/Rome')::date else l.next_action_date end
  where l.id=target.id returning l.* into target;
  if not found then raise exception 'Spostamento del lead non autorizzato'; end if;

  if p_recall_at is not null then
    insert into public.sales_tasks(id,client_id,lead_id,title,description,due_at,assigned_to,created_by)
    values(p_request_id,target.client_id,target.id,'Richiamo — '||coalesce(nullif(trim(target.name),''),'Lead'),note_text,
      p_recall_at,coalesce(nullif(target.assigned_to,''),author,'Venditore'),author);
  end if;
  insert into public.lead_activities (lead_id,client_id,pipeline_id,activity_type,event_type,channel,call_type,outcome,
    occurred_at,note,next_action_date,created_by,details,event_key)
  values(target.id,target.client_id,target.pipeline_id,'call',case when p_contact_type='setting' then 'setting_call' else 'discovery_call' end,
    'phone',case when p_contact_type='setting' then 'outbound' else p_contact_type end,p_outcome,now(),note_text,
    target.next_action_date,author,jsonb_build_object('assigned_to',target.assigned_to,'owner_at_event',target.assigned_to),activity_key);
  return target;
end;
$$;

revoke all on function public.record_lead_contact_disposition(uuid,uuid,uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.record_lead_contact_disposition(uuid,uuid,uuid,text,text,text,timestamptz) to authenticated;
notify pgrst, 'reload schema';
commit;
