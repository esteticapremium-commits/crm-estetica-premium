-- ============================================================
-- CRM Estetica Premium — database separato
-- Da eseguire nel SQL Editor del NUOVO progetto Supabase
-- (Project Settings > Database > ... oppure SQL Editor).
-- ============================================================

-- ---------- TABELLE ----------

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ingest_token text,
  ghl_pipeline_id text,
  meta_page_id text,
  meta_form_id text,
  meta_page_token text,
  meta_ad_account_id text,
  created_at timestamptz not null default now()
);

create table if not exists pipelines (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  position integer not null default 1,
  meta_form_id text,
  meta_ad_account_id text,
  created_at timestamptz not null default now()
);

create table if not exists stages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  name text not null,
  position integer not null default 1,
  color text,
  is_entry boolean not null default false,
  ghl_stage_id text,
  created_at timestamptz not null default now()
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  stage_id uuid not null references stages(id) on delete cascade,
  pipeline_id uuid references pipelines(id) on delete cascade,
  name text,
  phone text,
  email text,
  source text,
  assigned_to text,
  value numeric default 0,
  notes text,
  position integer not null default 0,
  ghl_opportunity_id text,
  ghl_contact_id text,
  meta_lead_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_client_idx on leads(client_id);
create index if not exists leads_stage_idx on leads(stage_id);
create unique index if not exists leads_ghl_idx on leads(ghl_opportunity_id)
  where ghl_opportunity_id is not null;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'venditore' check (role in ('admin', 'venditore')),
  client_id uuid references clients(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now()
);

create table if not exists lead_stage_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  client_id uuid references clients(id) on delete cascade,
  pipeline_id uuid references pipelines(id) on delete cascade,
  from_stage_id uuid references stages(id) on delete set null,
  to_stage_id uuid references stages(id) on delete set null,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists lse_client_idx on lead_stage_events(client_id);
create index if not exists lse_lead_idx on lead_stage_events(lead_id);
create index if not exists lse_at_idx on lead_stage_events(changed_at);

-- ---------- TRIGGER: registra ogni cambiamento di fase ----------

create or replace function record_stage_event()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into lead_stage_events (lead_id, client_id, pipeline_id, from_stage_id, to_stage_id)
  values (new.id, new.client_id, new.pipeline_id, old.stage_id, new.stage_id);
  return new;
end;
$$;

drop trigger if exists lead_stage_event_on_change on leads;
create trigger lead_stage_event_on_change
  after insert or update of stage_id on leads
  for each row execute function record_stage_event();

-- updated_at automatico
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;

drop trigger if exists leads_touch on leads;
create trigger leads_touch
  before update on leads for each row execute function touch_updated_at();

-- ---------- SICUREZZA (RLS) ----------
-- Chiave anon pubblica, ma RLS limita i dati: solo il proprio cliente.
alter table clients enable row level security;
alter table pipelines enable row level security;
alter table stages enable row level security;
alter table leads enable row level security;
alter table profiles enable row level security;
alter table lead_stage_events enable row level security;

drop policy if exists "anon read" on clients;
create policy "anon read" on clients for select to anon using (true);
drop policy if exists "anon all" on pipelines;
create policy "anon all" on pipelines for all to anon using (true) with check (true);
drop policy if exists "anon all" on stages;
create policy "anon all" on stages for all to anon using (true) with check (true);
drop policy if exists "anon all" on leads;
create policy "anon all" on leads for all to anon using (true) with check (true);
drop policy if exists "anon all" on profiles;
create policy "anon all" on profiles for all to anon using (true) with check (true);
drop policy if exists "anon all" on lead_stage_events;
create policy "anon all" on lead_stage_events for all to anon using (true) with check (true);

-- ---------- DATI INIZIALI ----------
-- Cliente e pipeline: gli stage vengono creati dall'import (o qui sotto
-- se preferisci crearli a mano nel pannello Fasi).
insert into clients (name)
values ('Estetica Premium')
on conflict do nothing;

insert into pipelines (client_id, name, position)
select id, 'Pipeline Sales', 1 from clients where name = 'Estetica Premium'
on conflict do nothing;
