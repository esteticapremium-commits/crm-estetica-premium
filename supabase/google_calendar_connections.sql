-- Collegamento Google Calendar persistente per singolo utente CRM.
-- I token non sono leggibili dal browser: vengono usati esclusivamente dalla
-- Edge Function google-calendar-oauth con la chiave service_role.
create table if not exists public.google_calendar_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  scopes text,
  connected_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now()
);

alter table public.google_calendar_connections enable row level security;

revoke all on table public.google_calendar_connections from anon, authenticated;
grant all on table public.google_calendar_connections to service_role;

