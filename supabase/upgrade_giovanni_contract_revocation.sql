-- Revoca dei link non firmati per Giovanni, limitata alla sua azienda.
begin;
create or replace function public.can_revoke_contracts()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    coalesce(public.is_admin(), false) or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.id = 'fea14cde-316f-4519-bad0-abb9d9208df7'::uuid
        and p.role = 'venditore'
        and p.client_id = 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c'::uuid
    )
  );
$$;
revoke all on function public.can_revoke_contracts() from public, anon;
grant execute on function public.can_revoke_contracts() to authenticated;

create or replace function public.revoke_contract(p_contract_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not public.can_revoke_contracts() then raise exception 'non autorizzato'; end if;
  select public.my_full_name() into v_name;
  update public.contracts
  set revoked_at = now(), revoked_by = v_name
  where id = p_contract_id and status <> 'signed' and revoked_at is null
    and (coalesce(public.is_admin(), false) or client_id = public.my_client_id());
  if not found then return false; end if;
  insert into public.contract_events(contract_id, action, actor)
    values (p_contract_id, 'revoked', v_name);
  return true;
end;
$$;
revoke all on function public.revoke_contract(uuid) from public, anon;
grant execute on function public.revoke_contract(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
