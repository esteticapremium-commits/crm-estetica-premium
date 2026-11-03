begin;
create table if not exists public.daily_sales_reports (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id) on delete cascade,
 report_date date not null,
 calls_made integer not null check(calls_made >= 0),
 discovery_booked integer not null check(discovery_booked >= 0),
 discovery_held integer not null check(discovery_held >= 0),
 demo_booked integer check(demo_booked >= 0),
 demo_held integer not null check(demo_held >= 0),
 demo_won integer not null check(demo_won >= 0),
 notes text not null default '' check(length(notes) <= 5000),
 created_by uuid not null default auth.uid() references auth.users(id),
 updated_by uuid not null default auth.uid() references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version integer not null default 1,
 unique(client_id, report_date)
);
alter table public.daily_sales_reports add column if not exists version integer not null default 1;
alter table public.daily_sales_reports add column if not exists demo_booked integer check(demo_booked >= 0);
alter table public.daily_sales_reports enable row level security;
revoke all on public.daily_sales_reports from anon, authenticated;
grant select, insert, update on public.daily_sales_reports to authenticated;
drop policy if exists daily_sales_admin on public.daily_sales_reports;
create policy daily_sales_admin on public.daily_sales_reports for all to authenticated
 using (public.is_admin()) with check (public.is_admin());
create or replace function public.stamp_daily_sales_report() returns trigger
language plpgsql set search_path = public as $$
begin
 if new.report_date > (now() at time zone 'Europe/Rome')::date then
  raise exception 'Non puoi registrare una giornata futura';
 end if;
 if TG_OP = 'UPDATE' then
  new.version := old.version + 1;
  new.id := old.id; new.client_id := old.client_id; new.report_date := old.report_date;
  new.created_by := old.created_by; new.created_at := old.created_at;
 else
  new.version := 1;
  new.created_by := auth.uid(); new.created_at := clock_timestamp();
 end if;
 new.updated_by := auth.uid(); new.updated_at := clock_timestamp();
 return new;
end;
$$;
drop trigger if exists stamp_daily_sales_report on public.daily_sales_reports;
create trigger stamp_daily_sales_report before insert or update on public.daily_sales_reports
for each row execute function public.stamp_daily_sales_report();
notify pgrst, 'reload schema';
commit;
select to_regclass('public.daily_sales_reports') as tabella,
 (select relrowsecurity from pg_class where oid='public.daily_sales_reports'::regclass) as rls_attiva;
