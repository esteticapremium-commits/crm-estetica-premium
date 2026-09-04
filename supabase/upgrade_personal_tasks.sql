-- Kanban personale dell'amministratore. Eseguire una sola volta nel SQL Editor.
create table if not exists public.personal_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  notes text,
  status text not null default 'backlog' check (status in ('backlog', 'next', 'doing', 'waiting', 'done')),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists personal_tasks_owner_status_idx on public.personal_tasks(owner_id, status, position);
alter table public.personal_tasks enable row level security;
create policy personal_tasks_owner_only on public.personal_tasks for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
