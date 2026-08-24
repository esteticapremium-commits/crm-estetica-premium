-- ============================================================
-- CRM Estetica Premium — RLS corretta per utenti AUTENTICATI
-- Admin: pieno accesso. Venditore: solo il cliente del suo profilo.
-- Anon: solo l'ingest dei lead dal workflow n8n (client Estetica Premium).
-- Da eseguire nel SQL Editor del progetto mvujbtygcmowkbvoqcgp.
-- ============================================================

-- ---------- helper (security definer: evitano la ricorsione RLS) ----------
create or replace function public.is_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select coalesce((
    select role = 'admin' from public.profiles where id = auth.uid()
  ), false)
$$;

create or replace function public.my_client_id()
returns uuid
language sql stable
security definer
set search_path = public
as $$
  select client_id from public.profiles where id = auth.uid()
$$;

-- ---------- rimuovi le policy vecchie ----------
drop policy if exists "anon read" on clients;
drop policy if exists "anon all" on pipelines;
drop policy if exists "anon all" on stages;
drop policy if exists "anon all" on leads;
drop policy if exists "anon all" on profiles;
drop policy if exists "anon all" on lead_stage_events;
drop policy if exists clients_authenticated on clients;
drop policy if exists pipelines_authenticated on pipelines;
drop policy if exists stages_authenticated on stages;
drop policy if exists leads_authenticated on leads;
drop policy if exists profiles_authenticated on profiles;
drop policy if exists lead_stage_events_authenticated on lead_stage_events;

-- ---------- clients ----------
create policy clients_select on clients
  for select to authenticated
  using (is_admin() or id = my_client_id());
create policy clients_write on clients
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------- pipelines ----------
create policy pipelines_select on pipelines
  for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy pipelines_write on pipelines
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------- stages ----------
create policy stages_select on stages
  for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy stages_write on stages
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------- leads ----------
create policy leads_select on leads
  for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy leads_insert on leads
  for insert to authenticated
  with check (is_admin() or client_id = my_client_id());
create policy leads_update on leads
  for update to authenticated
  using (is_admin() or client_id = my_client_id())
  with check (is_admin() or client_id = my_client_id());
create policy leads_delete on leads
  for delete to authenticated
  using (is_admin() or client_id = my_client_id());

-- Anon: SOLO il workflow n8n (Instantly) può inserire/aggiornare lead
-- del cliente Estetica Premium. Nessuna lettura anon.
create policy leads_anon_insert on leads
  for insert to anon
  with check (client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c');
create policy leads_anon_update on leads
  for update to anon
  using (client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c')
  with check (client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c');

-- ---------- profiles ----------
create policy profiles_select on profiles
  for select to authenticated
  using (is_admin() or id = auth.uid());
create policy profiles_insert on profiles
  for insert to authenticated
  with check (is_admin());
create policy profiles_update on profiles
  for update to authenticated
  using (is_admin() or id = auth.uid())
  with check (is_admin() or id = auth.uid());
create policy profiles_delete on profiles
  for delete to authenticated
  using (is_admin());

-- ---------- lead_stage_events ----------
create policy lse_select on lead_stage_events
  for select to authenticated
  using (is_admin() or client_id = my_client_id());
create policy lse_write on lead_stage_events
  for insert to authenticated
  with check (is_admin() or client_id = my_client_id());
create policy lse_update on lead_stage_events
  for update to authenticated
  using (is_admin() or client_id = my_client_id())
  with check (is_admin() or client_id = my_client_id());
create policy lse_delete on lead_stage_events
  for delete to authenticated
  using (is_admin() or client_id = my_client_id());

-- ---------- trigger: aggiunge search_path per sicurezza ----------
create or replace function record_stage_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_stage_events (lead_id, client_id, pipeline_id, from_stage_id, to_stage_id)
  values (new.id, new.client_id, new.pipeline_id, old.stage_id, new.stage_id);
  return new;
end;
$$;

-- ---------- list_users: admin vede tutti, gli altri solo se stessi ----------
create or replace function public.list_users()
returns table(id uuid, email text, role text, client_id uuid, full_name text)
language sql
security definer
set search_path = public
as $$
  select u.id, u.email::text, p.role, p.client_id, p.full_name
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.deleted_at is null
    and (
      exists (select 1 from public.profiles a where a.id = auth.uid() and a.role = 'admin')
      or u.id = auth.uid()
    )
  order by u.created_at;
$$;
grant execute on function public.list_users() to authenticated;

-- ---------- append_note: limitata al cliente Estetica Premium ----------
create or replace function public.append_note(p_phone text, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_text is null or length(trim(p_text)) = 0 then return; end if;
  update leads
  set notes = coalesce(notes || E'\n\n', '') || to_char(now(), 'DD/MM/YYYY HH24:MI') || ' — ' || trim(p_text)
  where phone = p_phone
    and client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c';
end;
$$;
grant execute on function public.append_note(text, text) to anon, authenticated;
