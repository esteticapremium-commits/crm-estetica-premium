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
-- Admin: pieno accesso. Venditore: solo il cliente del suo profilo.
-- Anon: solo l'ingest dei lead dal workflow n8n (cliente Estetica Premium).

alter table clients enable row level security;
alter table pipelines enable row level security;
alter table stages enable row level security;
alter table leads enable row level security;
alter table profiles enable row level security;
alter table lead_stage_events enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.my_client_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select client_id from public.profiles where id = auth.uid()
$$;

create policy clients_select on clients for select to authenticated
  using (is_admin() or id = my_client_id());
create policy clients_write on clients for all to authenticated
  using (is_admin()) with check (is_admin());

create policy pipelines_select on pipelines for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy pipelines_write on pipelines for all to authenticated
  using (is_admin()) with check (is_admin());

create policy stages_select on stages for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy stages_write on stages for all to authenticated
  using (is_admin()) with check (is_admin());

create policy leads_select on leads for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy leads_insert on leads for insert to authenticated
  with check (is_admin() or client_id = my_client_id());
create policy leads_update on leads for update to authenticated
  using (is_admin() or client_id = my_client_id())
  with check (is_admin() or client_id = my_client_id());
create policy leads_delete on leads for delete to authenticated
  using (is_admin() or client_id = my_client_id());

-- n8n (Instantly) entra con la chiave anon: solo insert/update sul cliente
-- Estetica Premium (sostituisci l'UUID col client_id reale del progetto).
create policy leads_anon_insert on leads for insert to anon
  with check (client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c');
create policy leads_anon_update on leads for update to anon
  using (client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c')
  with check (client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c');

create policy profiles_select on profiles for select to authenticated
  using (is_admin() or id = auth.uid());
create policy profiles_insert on profiles for insert to authenticated
  with check (is_admin());
create policy profiles_update on profiles for update to authenticated
  using (is_admin() or id = auth.uid())
  with check (is_admin() or id = auth.uid());
create policy profiles_delete on profiles for delete to authenticated
  using (is_admin());

create policy lse_select on lead_stage_events for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy lse_write on lead_stage_events for insert to authenticated
  with check (is_admin() or client_id = my_client_id());
create policy lse_update on lead_stage_events for update to authenticated
  using (is_admin() or client_id = my_client_id())
  with check (is_admin() or client_id = my_client_id());
create policy lse_delete on lead_stage_events for delete to authenticated
  using (is_admin() or client_id = my_client_id());

-- ---------- RPC per l'ingest n8n (anon, senza RLS debole) ----------
create or replace function public.upsert_lead(
  p_name text, p_phone text, p_email text, p_source text, p_assigned text
) returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_client uuid := 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c';
  v_pipe uuid; v_stage uuid; v_id uuid;
begin
  if p_name is null or length(trim(p_name)) = 0 then return null; end if;
  if p_phone is null or length(trim(p_phone)) = 0 then return null; end if;
  select id into v_pipe from pipelines where client_id = v_client limit 1;
  select id into v_stage from stages
    where pipeline_id = v_pipe and name = 'NO ANSWER' order by position limit 1;
  insert into leads (client_id, pipeline_id, stage_id, name, phone, email, source, assigned_to, position)
  values (v_client, v_pipe, v_stage, trim(p_name), trim(p_phone),
          nullif(trim(coalesce(p_email,'')),''), coalesce(nullif(trim(p_source),''),'Instantly'),
          nullif(trim(coalesce(p_assigned,'')),''), 0)
  on conflict (phone) do update set
    name = excluded.name,
    email = coalesce(excluded.email, leads.email)
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.upsert_lead(text, text, text, text, text) to anon, authenticated;

create or replace function public.append_note(p_phone text, p_text text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if p_text is null or length(trim(p_text)) = 0 then return; end if;
  update leads
  set notes = coalesce(notes || E'\n\n', '') || to_char(now(), 'DD/MM/YYYY HH24:MI') || ' — ' || trim(p_text)
  where phone = p_phone and client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c';
end;
$$;
grant execute on function public.append_note(text, text) to anon, authenticated;

create or replace function public.list_users()
returns table(id uuid, email text, role text, client_id uuid, full_name text)
language sql security definer set search_path = public
as $$
  select u.id, u.email::text, p.role, p.client_id, p.full_name
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.deleted_at is null
    and (exists (select 1 from public.profiles a where a.id = auth.uid() and a.role = 'admin')
         or u.id = auth.uid())
  order by u.created_at;
$$;
grant execute on function public.list_users() to authenticated;

-- ---------- CONTRATTI (firma digitale) ----------
create table if not exists contract_templates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  body text,
  client_fields text,
  created_at timestamptz not null default now()
);

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  template_id uuid references contract_templates(id) on delete set null,
  title text not null,
  body text,
  client_fields text,
  client_data text,
  status text not null default 'draft' check (status in ('draft','sent','signed')),
  sign_token uuid not null default gen_random_uuid() unique,
  sent_to text,
  sent_at timestamptz,
  signed_name text,
  signature_data text,
  signed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);

alter table contract_templates enable row level security;
alter table contracts enable row level security;

create policy ct_select on contract_templates for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy ct_write on contract_templates for all to authenticated
  using (is_admin()) with check (is_admin());
create policy contracts_select on contracts for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy contracts_insert on contracts for insert to authenticated
  with check (is_admin() or client_id = my_client_id());
create policy contracts_update on contracts for update to authenticated
  using (is_admin() or client_id = my_client_id())
  with check (is_admin() or client_id = my_client_id());
create policy contracts_delete on contracts for delete to authenticated
  using (is_admin() or client_id = my_client_id());

create or replace function public.get_contract_by_token(p_token text)
returns table(
  id uuid, title text, body text, status text, lead_name text,
  signed_name text, signed_at timestamptz, signature_data text
)
language sql security definer set search_path = public
as $$
  select c.id, c.title, c.body, c.status,
         (select l.name from leads l where l.id = c.lead_id),
         c.signed_name, c.signed_at, c.signature_data,
         c.client_fields, c.client_data
  from contracts c
  where c.sign_token::text = p_token
  limit 1;
$$;
grant execute on function public.get_contract_by_token(text) to anon;

create or replace function public.sign_contract(p_token text, p_name text, p_sig text, p_data text)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if p_name is null or length(trim(p_name)) = 0 then return false; end if;
  if p_sig is null or length(p_sig) < 20 then return false; end if;
  update contracts
  set status = 'signed',
      signed_name = trim(p_name),
      signature_data = p_sig,
      client_data = p_data,
      signed_at = now()
  where sign_token::text = p_token and status <> 'signed';
  return found;
end;
$$;
grant execute on function public.sign_contract(text, text, text, text) to anon;

-- ---------- DATI INIZIALI ----------
-- Cliente e pipeline: gli stage vengono creati dall'import (o qui sotto
-- se preferisci crearli a mano nel pannello Fasi).
insert into clients (name)
values ('Estetica Premium')
on conflict do nothing;

insert into pipelines (client_id, name, position)
select id, 'Pipeline Sales', 1 from clients where name = 'Estetica Premium'
on conflict do nothing;
