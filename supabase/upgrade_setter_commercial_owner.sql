begin;

create or replace function public.setter_commercial_owner(p_client_id uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$
  select p.id from public.profiles p
  join auth.users u on u.id=p.id
  join public.clients c on c.id=p_client_id and c.name='Estetica Premium'
  where p.role='admin' and (p.client_id=c.id or p.client_id is null)
    and lower(u.email)='ettoreandrosoni@estetica-premium.it';
$$;
revoke all on function public.setter_commercial_owner(uuid) from public, anon, authenticated;

-- Preserve the current function bodies and their contact-level access checks.
do $migration$
declare
  patch record;
  definition text;
  target_client_id uuid;
  target_owner_id uuid;
begin
  for patch in select * from (values
    ('public.get_database_setter_workspace(uuid,uuid,date,date)',
      $old$v.client_id=d.client_id and v.role='venditore'$old$,
      $new$((v.client_id=d.client_id and v.role='venditore') or v.id=public.setter_commercial_owner(d.client_id))$new$),
    ('public.get_setter_workspace(uuid,uuid,date,date)',
      $old$seller.client_id = a.client_id and seller.role = 'venditore'$old$,
      $new$((seller.client_id = a.client_id and seller.role = 'venditore') or seller.id=public.setter_commercial_owner(a.client_id))$new$),
    ('public.book_setter_discovery(uuid,uuid,timestamptz,text)',
      $old$client_id=caller.client_id and role='venditore'$old$,
      $new$((client_id=caller.client_id and role='venditore') or id=public.setter_commercial_owner(caller.client_id))$new$)
  ) as changes(signature, old_clause, new_clause)
  loop
    definition := pg_get_functiondef(patch.signature::regprocedure);
    if strpos(definition, patch.new_clause) > 0 then continue; end if;
    if (length(definition)-length(replace(definition,patch.old_clause,''))) <> length(patch.old_clause) then
      raise exception 'Verifica la definizione di % prima di applicare la modifica', patch.signature;
    end if;
    execute replace(definition,patch.old_clause,patch.new_clause);
  end loop;

  select c.id into strict target_client_id from public.clients c where c.name='Estetica Premium';
  target_owner_id := public.setter_commercial_owner(target_client_id);
  if target_owner_id is null then raise exception 'Titolare commerciale non trovato'; end if;

  update public.database_leads d set seller_id=target_owner_id
  from public.profiles setter
  where d.client_id=setter.client_id and d.setter_id=setter.id and setter.role='setter'
    and d.client_id=target_client_id and d.seller_id is null and d.handed_off_at is null;
end;
$migration$;

commit;
