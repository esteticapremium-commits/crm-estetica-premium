-- Tracciamento KPI commerciali giornalieri.
-- Il registro esistente lead_activities resta la fonte unica delle azioni:
-- aggiungiamo campi strutturati senza perdere o reinterpretare lo storico.

alter table public.lead_activities add column if not exists pipeline_id uuid references public.pipelines(id) on delete set null;
alter table public.lead_activities add column if not exists event_type text;
alter table public.lead_activities add column if not exists channel text;
alter table public.lead_activities add column if not exists duration_minutes integer;
alter table public.lead_activities add column if not exists occurred_at timestamptz;
alter table public.lead_activities add column if not exists scheduled_at timestamptz;
alter table public.lead_activities add column if not exists amount numeric(12,2);
alter table public.lead_activities add column if not exists details jsonb not null default '{}'::jsonb;

update public.lead_activities
set occurred_at = created_at
where occurred_at is null;

alter table public.lead_activities alter column occurred_at set default now();

create index if not exists lead_activities_event_at_idx
  on public.lead_activities(client_id, event_type, occurred_at desc);
create index if not exists lead_activities_actor_at_idx
  on public.lead_activities(client_id, created_by, occurred_at desc);

-- Registro outreach separato dalle attività sui lead. È necessario perché
-- Instantly deve poter contare anche email inviate a contatti che non sono
-- ancora diventati lead nel CRM.
create table if not exists public.sales_outreach_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  channel text not null check (channel in ('instantly', 'dm')),
  event_type text not null check (event_type in ('sent', 'reply', 'positive_reply', 'opened', 'bounced', 'unsubscribed', 'booking')),
  quantity integer not null default 1 check (quantity > 0),
  outcome text,
  contact_key text,
  campaign_id text,
  campaign_name text,
  external_id text not null,
  occurred_at timestamptz not null default now(),
  assigned_to text,
  created_by text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (client_id, external_id)
);
create index if not exists sales_outreach_events_at_idx
  on public.sales_outreach_events(client_id, channel, occurred_at desc);
create index if not exists sales_outreach_events_contact_idx
  on public.sales_outreach_events(client_id, contact_key);
alter table public.sales_outreach_events enable row level security;
drop policy if exists sales_outreach_select on public.sales_outreach_events;
create policy sales_outreach_select on public.sales_outreach_events for select to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
drop policy if exists sales_outreach_insert on public.sales_outreach_events;
create policy sales_outreach_insert on public.sales_outreach_events for insert to authenticated
  with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
drop policy if exists sales_outreach_update on public.sales_outreach_events;
create policy sales_outreach_update on public.sales_outreach_events for update to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()))
  with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
drop policy if exists sales_outreach_delete on public.sales_outreach_events;
create policy sales_outreach_delete on public.sales_outreach_events for delete to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));

-- Un venditore può correggere o eliminare soltanto le attività registrate da lui.
drop policy if exists lead_activities_update on public.lead_activities;
create policy lead_activities_update on public.lead_activities for update to authenticated
  using (
    public.is_admin()
    or (client_id = public.my_client_id() and created_by = public.my_full_name())
  )
  with check (
    public.is_admin()
    or (client_id = public.my_client_id() and created_by = public.my_full_name())
  );

drop policy if exists lead_activities_delete on public.lead_activities;
create policy lead_activities_delete on public.lead_activities for delete to authenticated
  using (
    public.is_admin()
    or (client_id = public.my_client_id() and created_by = public.my_full_name())
  );

-- Informazioni commerciali dell'appuntamento CRM. Google Calendar resta il
-- calendario, sales_tasks conserva il significato commerciale e l'esito.
alter table public.sales_tasks add column if not exists appointment_type text;
alter table public.sales_tasks add column if not exists appointment_status text;
alter table public.sales_tasks add column if not exists duration_minutes integer;
alter table public.sales_tasks add column if not exists google_event_id text;

create index if not exists sales_tasks_appointment_idx
  on public.sales_tasks(client_id, appointment_type, due_at desc)
  where appointment_type is not null;

-- Incassato reale: separato dal valore indicativo del lead e dalla firma.
create table if not exists public.sales_revenue_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  pipeline_id uuid references public.pipelines(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  revenue_type text not null check (revenue_type in ('new', 'renewal', 'upsell')),
  amount numeric(12,2) not null check (amount >= 0),
  contract_value numeric(12,2) check (contract_value is null or contract_value >= 0),
  status text not null default 'collected' check (status in ('expected', 'collected', 'cancelled')),
  occurred_at timestamptz not null default now(),
  assigned_to text,
  created_by text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists sales_revenue_events_at_idx
  on public.sales_revenue_events(client_id, occurred_at desc);
alter table public.sales_revenue_events enable row level security;
drop policy if exists sales_revenue_select on public.sales_revenue_events;
create policy sales_revenue_select on public.sales_revenue_events for select to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
drop policy if exists sales_revenue_insert on public.sales_revenue_events;
create policy sales_revenue_insert on public.sales_revenue_events for insert to authenticated
  with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
drop policy if exists sales_revenue_update on public.sales_revenue_events;
create policy sales_revenue_update on public.sales_revenue_events for update to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()))
  with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
drop policy if exists sales_revenue_delete on public.sales_revenue_events;
create policy sales_revenue_delete on public.sales_revenue_events for delete to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));

-- Costi di outreach: visibili e modificabili solo dall'amministratore.
create table if not exists public.sales_costs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  cost_type text not null check (cost_type in ('instantly', 'dm_tools', 'personnel', 'other')),
  amount numeric(12,2) not null check (amount >= 0),
  cost_date date not null,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists sales_costs_date_idx on public.sales_costs(client_id, cost_date desc);
alter table public.sales_costs enable row level security;
drop policy if exists sales_costs_select on public.sales_costs;
create policy sales_costs_select on public.sales_costs for select to authenticated using (public.is_admin());
drop policy if exists sales_costs_insert on public.sales_costs;
create policy sales_costs_insert on public.sales_costs for insert to authenticated with check (public.is_admin());
drop policy if exists sales_costs_update on public.sales_costs;
create policy sales_costs_update on public.sales_costs for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists sales_costs_delete on public.sales_costs;
create policy sales_costs_delete on public.sales_costs for delete to authenticated using (public.is_admin());
