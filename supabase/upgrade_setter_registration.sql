begin;

create table if not exists public.setter_registration_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked_at timestamptz
);
create unique index if not exists setter_registration_active_link
  on public.setter_registration_links(client_id) where revoked_at is null;
create table if not exists public.setter_registration_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  link_id uuid not null references public.setter_registration_links(id),
  full_name text not null,
  email text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','activated')),
  activation_hash text,
  activation_expires_at timestamptz,
  activated_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_id, email)
);
alter table public.setter_registration_links enable row level security;
alter table public.setter_registration_requests enable row level security;
revoke all on public.setter_registration_links, public.setter_registration_requests from public, anon, authenticated;

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
      activation:=gen_random_uuid();
      update public.setter_registration_requests set status='approved', activation_hash=encode(sha256(convert_to(activation::text,'UTF8')),'hex'),
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
      'id',r.id,'full_name',r.full_name,'email',r.email,'status',r.status,'created_at',r.created_at
    ) order by r.created_at desc) from public.setter_registration_requests r
      where r.client_id=p_client_id and r.status in ('pending','approved')), '[]'::jsonb)
  );
end;
$$;

create or replace function public.submit_setter_registration(p_link_id uuid,p_full_name text,p_email text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  link public.setter_registration_links;
  name text := btrim(p_full_name);
  address text := lower(btrim(p_email));
begin
  if name is null or char_length(name) not between 2 and 100
    or address is null or char_length(address)>254 or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Inserisci nome completo e un indirizzo email valido';
  end if;
  select * into link from public.setter_registration_links where id=p_link_id and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Il link di registrazione non è valido o è scaduto'; end if;
  if (select count(*) from public.setter_registration_requests where link_id=link.id)>=80 then
    raise exception 'Questo link ha raggiunto il limite di richieste. Chiedine uno nuovo al titolare.';
  end if;
  insert into public.setter_registration_requests(client_id,link_id,full_name,email)
    values(link.client_id,link.id,name,address) on conflict (client_id,email) do nothing;
end;
$$;

create or replace function public.resolve_setter_activation(p_token uuid)
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('id',r.id,'email',r.email)
  from public.setter_registration_requests r
  where r.activation_hash=encode(sha256(convert_to(p_token::text,'UTF8')),'hex')
    and r.status='approved' and r.activation_expires_at>now()
$$;
create unique index if not exists setter_activation_hash_idx on public.setter_registration_requests(activation_hash)
  where activation_hash is not null;

create or replace function public.apply_setter_registration()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  request public.setter_registration_requests;
begin
  if not (coalesce(new.raw_app_meta_data,'{}'::jsonb) ? 'ep_setter_activation') then return new; end if;
  select * into request from public.setter_registration_requests
    where id=(new.raw_app_meta_data->>'ep_setter_request')::uuid and activation_hash=new.raw_app_meta_data->>'ep_setter_activation'
      and status='approved' and activation_expires_at>now() and email=lower(new.email) for update;
  if not found then raise exception 'Attivazione non disponibile'; end if;
  insert into public.profiles (id,role,client_id,full_name) values(new.id,'setter',request.client_id,request.full_name);
  update public.setter_registration_requests set status='activated',activation_hash=null,activation_expires_at=null,activated_user_id=new.id where id=request.id;
  update auth.users set raw_app_meta_data=raw_app_meta_data-'ep_setter_activation'-'ep_setter_request' where id=new.id;
  return new;
end;
$$;
drop trigger if exists apply_setter_registration on auth.users;
create trigger apply_setter_registration after insert on auth.users
  for each row when (new.raw_app_meta_data ? 'ep_setter_activation') execute function public.apply_setter_registration();

revoke all on function public.setter_registration_portal(uuid,text,uuid), public.submit_setter_registration(uuid,text,text),
  public.resolve_setter_activation(uuid), public.apply_setter_registration() from public, anon, authenticated;
grant execute on function public.setter_registration_portal(uuid,text,uuid) to authenticated;
grant execute on function public.submit_setter_registration(uuid,text,text) to anon, authenticated;
grant execute on function public.resolve_setter_activation(uuid) to service_role;
notify pgrst, 'reload schema';
commit;
