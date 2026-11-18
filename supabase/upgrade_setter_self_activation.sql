begin;

alter table public.setter_registration_requests add column if not exists device_hash text;
create unique index if not exists setter_registration_device_idx on public.setter_registration_requests(device_hash)
  where device_hash is not null;

create or replace function public.setter_registration_portal(p_client_id uuid, p_action text default 'read', p_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  link public.setter_registration_links;
  request public.setter_registration_requests;
  activation uuid;
begin
  if not coalesce(public.is_admin(),false) or not exists (select from public.clients where id=p_client_id and name='Estetica Premium') then
    raise exception 'Accesso non autorizzato';
  end if;
  if p_action is null or p_action not in ('read','new_link','revoke_link','approve','reject') then raise exception 'Azione non valida'; end if;
  perform pg_advisory_xact_lock(hashtextextended('setter-registration:'||p_client_id,0));
  if p_action in ('new_link','revoke_link') then
    update public.setter_registration_links set revoked_at=now() where client_id=p_client_id and revoked_at is null;
    if p_action='new_link' then insert into public.setter_registration_links(client_id) values (p_client_id); end if;
  end if;
  if p_action in ('approve','reject') then
    select * into request from public.setter_registration_requests where id=p_request_id and client_id=p_client_id for update;
    if not found or request.status not in ('pending','approved') then raise exception 'Richiesta non disponibile'; end if;
    if p_action='approve' then
      if exists (select from auth.users u where lower(u.email)=request.email and u.deleted_at is null) then
        raise exception 'Esiste già un account con questa email. Gestiscilo in Accessi del team.';
      end if;
      if request.device_hash is null then activation:=gen_random_uuid(); end if;
      update public.setter_registration_requests set status='approved',
        activation_hash=coalesce(request.device_hash,encode(sha256(convert_to(activation::text,'UTF8')),'hex')),
        activation_expires_at=now()+interval '24 hours' where id=request.id;
    else
      update public.setter_registration_requests set status='rejected',activation_hash=null,activation_expires_at=null where id=request.id;
    end if;
  end if;
  select * into link from public.setter_registration_links where client_id=p_client_id and revoked_at is null and expires_at>now();
  return jsonb_build_object(
    'link', case when link.id is not null then jsonb_build_object('id',link.id,'expires_at',link.expires_at) end,
    'activation', activation,
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'full_name',r.full_name,'email',r.email,'status',r.status,'created_at',r.created_at,'same_browser',r.device_hash is not null
    ) order by r.created_at desc) from public.setter_registration_requests r
      where r.client_id=p_client_id and r.status in ('pending','approved')), '[]'::jsonb)
  );
end;
$$;

create or replace function public.request_setter_self_activation(p_link_id uuid,p_full_name text,p_email text,p_device_token uuid)
returns text language plpgsql security definer set search_path = public
as $$
declare
  link public.setter_registration_links;
  applicant public.setter_registration_requests;
  full_name text := btrim(p_full_name);
  address text := lower(btrim(p_email));
  digest text := encode(sha256(convert_to(p_device_token::text,'UTF8')),'hex');
begin
  if full_name is null or char_length(full_name) not between 2 and 100 or digest is null
    or address is null or char_length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Inserisci nome completo e un indirizzo email valido';
  end if;
  select * into link from public.setter_registration_links where id=p_link_id for update;
  if not found then raise exception 'Il link di registrazione non è valido'; end if;
  select * into applicant from public.setter_registration_requests where link_id=link.id and device_hash=digest;
  if found then return applicant.status; end if;
  if link.revoked_at is not null or link.expires_at<=now() then raise exception 'Il link di registrazione non è più attivo'; end if;
  if (select count(*) from public.setter_registration_requests where link_id=link.id)>=80 then
    raise exception 'Questo link ha raggiunto il limite di richieste. Chiedine uno nuovo al titolare.';
  end if;
  insert into public.setter_registration_requests(client_id,link_id,full_name,email,device_hash)
    values(link.client_id,link.id,full_name,address,digest)
    on conflict (client_id,email) do nothing returning * into applicant;
  return case when found then 'pending' else 'already_requested' end;
end;
$$;

create or replace function public.get_setter_self_activation(p_link_id uuid,p_device_token uuid)
returns text language sql stable security definer set search_path = public
as $$
  select coalesce((select case
    when r.status='approved' and r.activation_expires_at<=now() then 'expired'
    else r.status end
    from public.setter_registration_requests r
    where r.link_id=p_link_id and r.device_hash=encode(sha256(convert_to(p_device_token::text,'UTF8')),'hex')), 'missing')
$$;

revoke all on function public.request_setter_self_activation(uuid,text,text,uuid), public.get_setter_self_activation(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.request_setter_self_activation(uuid,text,text,uuid), public.get_setter_self_activation(uuid,uuid)
  to anon, authenticated;
notify pgrst, 'reload schema';
commit;
