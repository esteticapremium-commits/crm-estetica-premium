-- Upgrade contratti: scadenza/revoca link, audit e permessi stretti.
-- Eseguire una sola volta nel SQL Editor di Supabase.
create extension if not exists pgcrypto;

alter table public.contracts add column if not exists expires_at timestamptz;
alter table public.contracts add column if not exists revoked_at timestamptz;
alter table public.contracts add column if not exists revoked_by text;
alter table public.contracts add column if not exists signed_document_hash text;
update public.contracts set expires_at = created_at + interval '30 days' where expires_at is null and status <> 'signed';
alter table public.contracts alter column expires_at set default (now() + interval '30 days');

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

create or replace function public.audit_contract_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.contract_events(contract_id, action, actor) values (new.id, 'created', new.created_by);
  elsif new.sent_at is distinct from old.sent_at and new.sent_at is not null then
    insert into public.contract_events(contract_id, action, actor, details) values (new.id, 'sent', public.my_full_name(), jsonb_build_object('recipient', new.sent_to));
  end if;
  return new;
end;
$$;
drop trigger if exists contracts_audit_event on public.contracts;
create trigger contracts_audit_event after insert or update on public.contracts for each row execute function public.audit_contract_event();

create or replace function public.my_full_name()
returns text language sql stable security definer set search_path = public
as $$ select full_name from public.profiles where id = auth.uid() $$;

-- L'amministratore vede tutto; un venditore solo i contratti dei propri lead.
drop policy if exists contracts_select on public.contracts;
drop policy if exists contracts_insert on public.contracts;
drop policy if exists contracts_update on public.contracts;
drop policy if exists contracts_delete on public.contracts;
create policy contracts_select on public.contracts for select to authenticated using (
  public.is_admin() or exists (select 1 from public.leads l where l.id = lead_id and l.assigned_to = public.my_full_name())
);
create policy contracts_insert on public.contracts for insert to authenticated with check (
  public.is_admin() or exists (select 1 from public.leads l where l.id = lead_id and l.assigned_to = public.my_full_name())
);
create policy contracts_update on public.contracts for update to authenticated using (
  public.is_admin() or exists (select 1 from public.leads l where l.id = lead_id and l.assigned_to = public.my_full_name())
) with check (
  public.is_admin() or exists (select 1 from public.leads l where l.id = lead_id and l.assigned_to = public.my_full_name())
);
create policy contracts_delete on public.contracts for delete to authenticated using (public.is_admin());
create policy contract_events_select on public.contract_events for select to authenticated using (
  public.is_admin() or exists (select 1 from public.contracts c join public.leads l on l.id = c.lead_id where c.id = contract_id and l.assigned_to = public.my_full_name())
);

create or replace function public.get_contract_by_token(p_token text)
returns table(id uuid, title text, body text, status text, lead_name text, signed_name text, signed_at timestamptz, signature_data text, client_fields text, client_data text)
language sql security definer set search_path = public as $$
  select c.id, c.title, c.body, c.status, (select l.name from public.leads l where l.id = c.lead_id), c.signed_name, c.signed_at, c.signature_data, c.client_fields, c.client_data
  from public.contracts c
  where c.sign_token::text = p_token and c.revoked_at is null and (c.expires_at is null or c.expires_at > now())
  limit 1
$$;

create or replace function public.sign_contract(p_token text, p_name text, p_sig text, p_data text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_name is null or length(trim(p_name)) = 0 then return false; end if;
  if p_sig is null or length(p_sig) < 20 then return false; end if;
  update public.contracts set status = 'signed', signed_name = trim(p_name), signature_data = p_sig, client_data = p_data, signed_at = now(), signed_document_hash = encode(digest(coalesce(body,'') || coalesce(client_fields,'') || coalesce(p_data,'') || trim(p_name) || p_sig, 'sha256'), 'hex')
  where sign_token::text = p_token and status <> 'signed' and revoked_at is null and (expires_at is null or expires_at > now()) returning id into v_id;
  if v_id is null then return false; end if;
  insert into public.contract_events(contract_id, action, actor, details) values (v_id, 'signed', trim(p_name), jsonb_build_object('document_hash', (select signed_document_hash from public.contracts where id = v_id)));
  return true;
end;
$$;

create or replace function public.revoke_contract(p_contract_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not public.is_admin() then raise exception 'non autorizzato'; end if;
  select public.my_full_name() into v_name;
  update public.contracts set revoked_at = now(), revoked_by = v_name where id = p_contract_id and status <> 'signed' and revoked_at is null;
  if not found then return false; end if;
  insert into public.contract_events(contract_id, action, actor) values (p_contract_id, 'revoked', v_name);
  return true;
end;
$$;

create or replace function public.renew_contract_link(p_contract_id uuid, p_expires_at timestamptz default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_token text; v_name text;
begin
  if not public.is_admin() then raise exception 'non autorizzato'; end if;
  select public.my_full_name() into v_name;
  update public.contracts set sign_token = gen_random_uuid(), revoked_at = null, revoked_by = null, expires_at = coalesce(p_expires_at, now() + interval '30 days') where id = p_contract_id and status <> 'signed' returning sign_token::text into v_token;
  if v_token is null then raise exception 'contratto non rinnovabile'; end if;
  insert into public.contract_events(contract_id, action, actor, details) values (p_contract_id, 'link_renewed', v_name, jsonb_build_object('expires_at', (select expires_at from public.contracts where id = p_contract_id)));
  return v_token;
end;
$$;
grant execute on function public.revoke_contract(uuid), public.renew_contract_link(uuid, timestamptz) to authenticated;
