-- Piano editoriale interno dell'azienda. Eseguire una sola volta nel SQL Editor.
create table if not exists public.editorial_contents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null,
  channel text not null default 'Instagram',
  format text,
  status text not null default 'idea' check (status in ('idea', 'in_production', 'review', 'scheduled', 'published')),
  scheduled_for date,
  owner text,
  pillar text,
  cta text,
  notes text,
  asset_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists editorial_contents_schedule_idx on public.editorial_contents(client_id, scheduled_for);
alter table public.editorial_contents enable row level security;
create policy editorial_contents_admin_all on public.editorial_contents for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create or replace function public.touch_editorial_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end; $$;
drop trigger if exists editorial_contents_touch on public.editorial_contents;
create trigger editorial_contents_touch before update on public.editorial_contents for each row execute function public.touch_editorial_updated_at();
