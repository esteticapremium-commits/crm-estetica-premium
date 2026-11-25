-- Apply after upgrade_setter_commercial_owner.sql.
begin;

create or replace function public.get_database_leads_commercial_owner(p_client_id uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$
  select public.setter_commercial_owner(p_client_id) where public.is_admin();
$$;
revoke all on function public.get_database_leads_commercial_owner(uuid) from public, anon;
grant execute on function public.get_database_leads_commercial_owner(uuid) to authenticated;

do $migration$
declare
  definition text := pg_get_functiondef('public.assign_database_leads(uuid,uuid[],uuid,uuid,uuid)'::regprocedure);
  before_clause text := $body$or not exists(select 1 from public.profiles where id=p_seller_id and client_id=p_client_id and role='venditore') then$body$;
  after_clause text := $body$or (not coalesce(p_seller_id = public.setter_commercial_owner(p_client_id), false)
       and not exists(select 1 from public.profiles where id=p_seller_id and client_id=p_client_id and role='venditore')) then$body$;
begin
  if strpos(definition, after_clause) > 0 then return; end if;
  if strpos(definition, before_clause) = 0 then raise exception 'Verifica la regola di assegnazione del Database Lead'; end if;
  execute replace(definition, before_clause, after_clause);
end;
$migration$;

notify pgrst, 'reload schema';
commit;
