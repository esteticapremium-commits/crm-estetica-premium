begin;

create or replace function public.assign_database_leads_to_setter(p_client_id uuid, p_contact_ids uuid[], p_setter_id uuid, p_seller_id uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  destination uuid;
begin
  if not public.is_admin() then raise exception 'Solo il titolare può assegnare i contatti'; end if;

  select p.id into destination from public.pipelines p
  where p.client_id=p_client_id and 2=(
    select count(distinct upper(trim(s.name))) from public.stages s
    where s.client_id=p_client_id and s.pipeline_id=p.id and upper(trim(s.name)) in ('SETTING','DISCOVERY')
  )
  order by p.position,p.created_at,p.id limit 1;

  if destination is null then raise exception 'Manca una pipeline commerciale con le fasi Setting e Discovery'; end if;
  return public.assign_database_leads(p_client_id,p_contact_ids,p_setter_id,p_seller_id,destination);
end;
$$;

revoke all on function public.assign_database_leads_to_setter(uuid,uuid[],uuid,uuid) from public, anon;
grant execute on function public.assign_database_leads_to_setter(uuid,uuid[],uuid,uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
