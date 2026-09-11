-- Priorità visiva per Agenda commerciale e Task Aziendali.
alter table public.sales_tasks
  add column if not exists is_priority boolean not null default false;

alter table public.personal_tasks
  add column if not exists is_priority boolean not null default false;
