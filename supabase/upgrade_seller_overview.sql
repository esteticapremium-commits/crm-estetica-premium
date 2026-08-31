-- Panoramica aggregata per i venditori.
-- Non restituisce lead, nominativi, contatti o importi: solo i numeri generali del CRM.
create or replace function public.seller_company_overview(p_client_id uuid)
returns table (
  total_leads bigint,
  active_leads bigint,
  appointments bigint,
  closed_leads bigint,
  worked_today bigint,
  due_today bigint,
  conversion_rate numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'non autorizzato';
  end if;

  if not public.is_admin() and p_client_id is distinct from public.my_client_id() then
    raise exception 'non autorizzato';
  end if;

  return query
  select
    count(*)::bigint,
    count(*) filter (where lower(coalesce(s.name, '')) not in ('closed', 'chiuso', 'lost', 'perso'))::bigint,
    count(*) filter (where lower(coalesce(s.name, '')) like '%appuntament%')::bigint,
    count(*) filter (where lower(coalesce(s.name, '')) in ('closed', 'chiuso'))::bigint,
    count(*) filter (
      where timezone('Europe/Rome', coalesce(l.updated_at, l.created_at))::date = timezone('Europe/Rome', now())::date
    )::bigint,
    count(*) filter (
      where lower(coalesce(s.name, '')) not in ('closed', 'chiuso', 'lost', 'perso')
        and (l.next_action_date is null or l.next_action_date <= timezone('Europe/Rome', now())::date)
    )::bigint,
    case when count(*) = 0 then 0 else round((count(*) filter (where lower(coalesce(s.name, '')) in ('closed', 'chiuso'))::numeric / count(*)::numeric) * 100, 1) end
  from public.leads l
  left join public.stages s on s.id = l.stage_id
  where l.client_id = p_client_id;
end;
$$;

revoke all on function public.seller_company_overview(uuid) from public;
grant execute on function public.seller_company_overview(uuid) to authenticated;
