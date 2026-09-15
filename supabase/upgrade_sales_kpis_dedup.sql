-- Un solo evento commerciale per ogni azione reale.
-- Le chiavi restano nullable per non alterare lo storico precedente.

alter table public.lead_activities add column if not exists event_key text;
alter table public.sales_revenue_events add column if not exists event_key text;

create unique index if not exists lead_activities_event_key_uidx
  on public.lead_activities(client_id, event_key);

create unique index if not exists sales_revenue_event_key_uidx
  on public.sales_revenue_events(client_id, event_key);

create unique index if not exists sales_tasks_google_event_uidx
  on public.sales_tasks(client_id, google_event_id)
  where google_event_id is not null;
