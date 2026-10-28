-- Aggregate only. Existing row-level financial access remains unchanged.
create or replace function public.company_daily_collected(p_client_id uuid, p_day date)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'non autorizzato';
  end if;
  if not coalesce(public.is_admin(), false) and p_client_id is distinct from public.my_client_id() then
    raise exception 'non autorizzato';
  end if;
  if p_client_id is null or p_day is null then
    raise exception 'cliente e giorno obbligatori';
  end if;
  return (
    select coalesce(sum(r.amount), 0)
    from public.sales_revenue_events r
    where r.client_id = p_client_id
      and r.status = 'collected'
      and r.occurred_at >= (p_day::timestamp at time zone 'Europe/Rome')
      and r.occurred_at < ((p_day + 1)::timestamp at time zone 'Europe/Rome')
  );
end;
$$;
revoke all on function public.company_daily_collected(uuid, date) from public, anon;
grant execute on function public.company_daily_collected(uuid, date) to authenticated;
notify pgrst, 'reload schema';
