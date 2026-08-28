-- Controllo commerciale: storico delle attività, separato dalle note libere.
-- Eseguire una sola volta nel SQL Editor di Supabase.
create table if not exists public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  activity_type text not null check (activity_type in ('call', 'whatsapp', 'meeting', 'follow_up')),
  outcome text,
  note text,
  next_action_date date,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists lead_activities_client_at_idx on public.lead_activities(client_id, created_at desc);
create index if not exists lead_activities_lead_idx on public.lead_activities(lead_id);
alter table public.lead_activities enable row level security;
create policy lead_activities_select on public.lead_activities for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());
create policy lead_activities_insert on public.lead_activities for insert to authenticated
  with check (public.is_admin() or client_id = public.my_client_id());
create policy lead_activities_update on public.lead_activities for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy lead_activities_delete on public.lead_activities for delete to authenticated
  using (public.is_admin());

-- I lead restano nello storico: solo l'amministratore può eliminarli.
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads for delete to authenticated using (public.is_admin());

-- Ogni venditore lavora solo sui lead assegnati al proprio nome.
-- L'interfaccia assegna automaticamente i nuovi lead al venditore autenticato;
-- qui la regola è applicata anche direttamente dal database.
create or replace function public.my_full_name()
returns text language sql stable security definer set search_path = public
as $$ select full_name from public.profiles where id = auth.uid() $$;

drop policy if exists leads_select on public.leads;
drop policy if exists leads_insert on public.leads;
drop policy if exists leads_update on public.leads;
create policy leads_select on public.leads for select to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
create policy leads_insert on public.leads for insert to authenticated
  with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));
create policy leads_update on public.leads for update to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()))
  with check (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));

drop policy if exists lse_select on public.lead_stage_events;
create policy lse_select on public.lead_stage_events for select to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and changed_by = public.my_full_name()));

drop policy if exists lead_activities_select on public.lead_activities;
create policy lead_activities_select on public.lead_activities for select to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and created_by = public.my_full_name()));
