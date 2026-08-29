-- Storico avanzato contratti: eseguire una sola volta nel SQL Editor di Supabase.
-- Registra gli eventi operativi senza memorizzare IP, dispositivo o altri dati del firmatario.
alter table public.contracts add column if not exists viewed_at timestamptz;
alter table public.contracts add column if not exists view_count integer not null default 0;
create index if not exists contracts_viewed_at_idx on public.contracts(viewed_at desc);

create table if not exists public.contract_events (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  action text not null,
  actor text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists contract_events_contract_idx on public.contract_events(contract_id, created_at desc);
alter table public.contract_events enable row level security;
create or replace function public.my_full_name()
returns text language sql stable security definer set search_path = public
as $$ select full_name from public.profiles where id = auth.uid() $$;
drop policy if exists contract_events_select on public.contract_events;
create policy contract_events_select on public.contract_events for select to authenticated using (
  public.is_admin() or exists (
    select 1 from public.contracts c join public.leads l on l.id = c.lead_id
    where c.id = contract_id and l.assigned_to = public.my_full_name()
  )
);

-- Funzione pubblica limitata: con un token valido aggiorna solo il contatore
-- della sua apertura. Non espone né restituisce dati contrattuali.
create or replace function public.record_contract_view(p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_count integer;
begin
  update public.contracts
  set viewed_at = now(), view_count = coalesce(view_count, 0) + 1
  where sign_token::text = p_token
    and revoked_at is null
    and (expires_at is null or expires_at > now())
  returning id, view_count into v_id, v_count;

  if v_id is null then return false; end if;
  insert into public.contract_events(contract_id, action, details)
  values (v_id, 'viewed', jsonb_build_object('view_count', v_count));
  return true;
end;
$$;
grant execute on function public.record_contract_view(text) to anon, authenticated;
