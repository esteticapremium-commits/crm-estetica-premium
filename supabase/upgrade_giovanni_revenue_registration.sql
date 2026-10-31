-- Solo nuovi incassi di Giovanni: nessun permesso di modifica o cancellazione.
begin;
create or replace function public.can_record_revenue()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    coalesce(public.is_admin(), false) or exists (
      select 1 from public.profiles p where p.id = auth.uid()
        and p.id = 'fea14cde-316f-4519-bad0-abb9d9208df7'::uuid
        and p.role = 'venditore'
        and p.client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c'::uuid
    )
  );
$$;
revoke all on function public.can_record_revenue() from public, anon;
grant execute on function public.can_record_revenue() to authenticated;

drop policy if exists sales_revenue_insert on public.sales_revenue_events;
create policy sales_revenue_insert on public.sales_revenue_events for insert to authenticated
with check (
  coalesce(public.is_admin(), false) or (
    public.can_record_revenue()
    and client_id = public.my_client_id()
    and created_by = public.my_full_name()
    and status = 'collected' and amount > 0
    and event_key is not null
    and exists (
      select 1 from public.leads l
      where l.id = sales_revenue_events.lead_id
        and l.client_id = sales_revenue_events.client_id
        and l.pipeline_id is not distinct from sales_revenue_events.pipeline_id
        and sales_revenue_events.assigned_to = coalesce(nullif(l.assigned_to, ''), public.my_full_name())
    )
  )
);
-- Le policy SELECT, UPDATE e DELETE restano invariate.
notify pgrst, 'reload schema';
commit;
