begin;

insert into public.stages (client_id, pipeline_id, name, position, color, probability)
select p.client_id, p.id, 'Non in target',
  coalesce((select max(s.position) from public.stages s where s.pipeline_id = p.id), 0) + 1,
  '#64748b', 0
from public.pipelines p
where p.id = 'f8cd3213-dd94-4b45-b02f-3b5316aaa8e7'
  and not exists (select 1 from public.stages s where s.pipeline_id = p.id and lower(trim(s.name)) = 'non in target');

create or replace function public.mark_lead_not_in_target(p_lead_id uuid, p_expected_stage_id uuid, p_note text default null)
returns uuid
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  target public.leads;
  destination uuid;
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;

  select l.* into target from public.leads l where l.id = p_lead_id for update;
  if not found then raise exception 'Lead non accessibile'; end if;

  select s.id into destination from public.stages s
  where s.client_id = target.client_id and s.pipeline_id = target.pipeline_id
    and lower(trim(s.name)) = 'non in target'
  order by s.position, s.id limit 1;
  if destination is null then raise exception 'La colonna Non in target non è disponibile in questa pipeline'; end if;
  if target.stage_id = destination then return destination; end if;
  if target.stage_id is distinct from p_expected_stage_id then
    raise exception 'La fase del lead è cambiata. Riapri la scheda e riprova';
  end if;

  update public.leads l set stage_id = destination,
    position = least(0, coalesce((select min(other.position) from public.leads other
      where other.client_id = target.client_id and other.pipeline_id = target.pipeline_id and other.stage_id = destination), 0)) - 1
  where l.id = target.id and l.client_id = target.client_id;
  if not found then raise exception 'Spostamento del lead non autorizzato'; end if;

  insert into public.lead_activities (lead_id, client_id, pipeline_id, activity_type, event_type,
    channel, outcome, occurred_at, note, created_by, details)
  values (target.id, target.client_id, target.pipeline_id, 'follow_up', 'lead_qualification',
    'other', 'not_in_target', now(), nullif(trim(p_note), ''), public.my_full_name(),
    jsonb_build_object('assigned_to', target.assigned_to, 'owner_at_event', target.assigned_to));
  return destination;
end;
$$;

revoke all on function public.mark_lead_not_in_target(uuid,uuid,text) from public, anon;
grant execute on function public.mark_lead_not_in_target(uuid,uuid,text) to authenticated;
notify pgrst, 'reload schema';

commit;
