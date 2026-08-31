-- Agenda operativa: task personali e task collegati a un lead.
-- Le attività già pianificate sui lead vengono portate nell'agenda alle 09:00.
create table if not exists public.sales_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  title text not null,
  description text,
  due_at timestamptz not null,
  assigned_to text not null,
  created_by text,
  completed_at timestamptz,
  completed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sales_tasks_agenda_idx on public.sales_tasks(client_id, assigned_to, due_at) where completed_at is null;
create index if not exists sales_tasks_lead_idx on public.sales_tasks(lead_id) where completed_at is null;
alter table public.sales_tasks enable row level security;
create policy sales_tasks_select on public.sales_tasks for select to authenticated using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
create policy sales_tasks_insert on public.sales_tasks for insert to authenticated with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
create policy sales_tasks_update on public.sales_tasks for update to authenticated using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name())) with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
create policy sales_tasks_delete on public.sales_tasks for delete to authenticated using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
create or replace function public.touch_sales_task_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end; $$;
drop trigger if exists sales_tasks_touch on public.sales_tasks;
create trigger sales_tasks_touch before update on public.sales_tasks for each row execute function public.touch_sales_task_updated_at();
insert into public.sales_tasks (client_id, lead_id, title, due_at, assigned_to, created_by)
select l.client_id, l.id, 'Follow-up — ' || coalesce(l.name, 'Lead senza nome'), (l.next_action_date::timestamp + time '09:00') at time zone 'Europe/Rome', coalesce(nullif(l.assigned_to, ''), 'Titolare'), coalesce(nullif(l.assigned_to, ''), 'Sistema')
from public.leads l where l.next_action_date is not null and not exists (select 1 from public.sales_tasks t where t.lead_id = l.id and t.completed_at is null);
