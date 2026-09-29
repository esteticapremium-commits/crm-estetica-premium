-- Presenza CRM: durata stimata, non rilevazione delle ore lavorate.
-- Nessuna scrittura su lead, calendari, contratti o KPI commerciali.
begin;

create table if not exists public.team_presence_settings (
  singleton boolean primary key default true check (singleton),
  activated_at timestamptz not null default now(),
  last_cleanup_at timestamptz
);
insert into public.team_presence_settings(singleton) values (true) on conflict do nothing;

create table if not exists public.team_presence_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  is_active boolean not null default false
);
create index if not exists team_presence_sessions_client_user_idx on public.team_presence_sessions(client_id, user_id, last_seen_at desc);
create table if not exists public.team_presence_intervals (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.team_presence_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_active boolean not null,
  check (ends_at > starts_at and ends_at <= starts_at + interval '45 seconds')
);
create index if not exists team_presence_intervals_report_idx on public.team_presence_intervals(client_id, starts_at, user_id);
alter table public.team_presence_settings enable row level security;
alter table public.team_presence_sessions enable row level security;
alter table public.team_presence_intervals enable row level security;
-- Nessun accesso diretto dal browser: scritture e letture solo tramite RPC.
revoke all on public.team_presence_settings, public.team_presence_sessions, public.team_presence_intervals from anon, authenticated;
revoke all on sequence public.team_presence_intervals_id_seq from anon, authenticated;

create or replace function public.team_presence_cleanup() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.team_presence_settings set last_cleanup_at = now()
    where singleton and (last_cleanup_at is null or last_cleanup_at < now() - interval '1 day');
  if found then
    delete from public.team_presence_intervals where ends_at < now() - interval '30 days';
    delete from public.team_presence_sessions where last_seen_at < now() - interval '30 days';
  end if;
end;
$$;
revoke all on function public.team_presence_cleanup() from public, anon, authenticated;

create or replace function public.team_presence_heartbeat(p_session_id uuid, p_client_id uuid, p_active boolean default false, p_close boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_session public.team_presence_sessions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
begin
  if v_user is null then raise exception 'Accesso richiesto' using errcode = '42501'; end if;
  select * into v_profile from public.profiles where id = v_user;
  if not found or (v_profile.role <> 'admin' and v_profile.client_id is distinct from p_client_id)
     or not exists(select 1 from public.clients where id = p_client_id) then
    raise exception 'Accesso non autorizzato' using errcode = '42501';
  end if;
  if p_session_id is null then raise exception 'Sessione richiesta'; end if;
  -- Un lock per sessione serializza richieste simultanee e impedisce doppioni.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));
  select * into v_session from public.team_presence_sessions where id = p_session_id for update;
  if found then
    if v_session.user_id <> v_user or v_session.client_id <> p_client_id then
      raise exception 'Sessione non autorizzata' using errcode = '42501';
    end if;
    -- Una sessione chiusa non viene riaperta da richieste in ritardo.
    if v_session.ended_at is not null then return jsonb_build_object('closed', true, 'server_time', v_now); end if;
    if v_now > v_session.last_seen_at + interval '90 seconds' then
      update public.team_presence_sessions set ended_at = last_seen_at, is_active = false where id = p_session_id;
      return jsonb_build_object('closed', true, 'server_time', v_now);
    end if;
    if v_now > v_session.last_seen_at + interval '2 seconds' then
      if v_now <= v_session.last_seen_at + interval '90 seconds' then
        v_start := greatest(v_session.last_seen_at, v_now - interval '45 seconds');
        insert into public.team_presence_intervals(session_id,user_id,client_id,starts_at,ends_at,is_active)
          values(p_session_id,v_user,p_client_id,v_start,v_now,v_session.is_active and coalesce(p_active,false));
      end if;
      update public.team_presence_sessions set last_seen_at = v_now, is_active = coalesce(p_active,false),
        ended_at = case when p_close then v_now else null end where id = p_session_id;
    else
      update public.team_presence_sessions set is_active = coalesce(p_active,false),
        ended_at = case when p_close then v_now else null end where id = p_session_id;
    end if;
  elsif not p_close then
    insert into public.team_presence_sessions(id,user_id,client_id,started_at,last_seen_at,is_active)
      values(p_session_id,v_user,p_client_id,v_now,v_now,coalesce(p_active,false));
  end if;
  perform public.team_presence_cleanup();
  return jsonb_build_object('closed', coalesce(p_close,false), 'server_time', v_now);
end;
$$;
revoke all on function public.team_presence_heartbeat(uuid,uuid,boolean,boolean) from public, anon;
grant execute on function public.team_presence_heartbeat(uuid,uuid,boolean,boolean) to authenticated;

create or replace function public.team_activity_report(p_client_id uuid, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not exists(select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    raise exception 'Sezione riservata all’amministratore' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30 then raise exception 'Seleziona un periodo di massimo 31 giorni'; end if;
  perform public.team_presence_cleanup();
  with
  members as (
    select p.id, coalesce(nullif(trim(p.full_name),''),u.email,'Utente') as name, p.role
    from public.profiles p join auth.users u on u.id = p.id
    where p.client_id = p_client_id or (p.role = 'admin' and exists(select 1 from public.team_presence_sessions s where s.user_id = p.id and s.client_id = p_client_id))
  ),
  days as (
    select d::date as day, d::date::timestamp at time zone 'Europe/Rome' as day_start,
      (d::date+1)::timestamp at time zone 'Europe/Rome' as day_end
    from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d
  ),
  ranges as (
    select i.user_id,d.day,i.is_active,
      tstzrange(greatest(i.starts_at,d.day_start),least(i.ends_at,d.day_end),'[)') as span
    from public.team_presence_intervals i join days d on i.starts_at < d.day_end and i.ends_at > d.day_start
    where i.client_id = p_client_id
  ),
  -- range_agg unisce gli intervalli sovrapposti tra schede e dispositivi.
  merged as (
    select user_id,day,false as active_only,range_agg(span) as spans from ranges group by user_id,day
    union all
    select user_id,day,true,range_agg(span) from ranges where is_active group by user_id,day
  ),
  durations as (
    select user_id,day,active_only,sum(extract(epoch from upper(span)-lower(span)))::integer as seconds
    from merged cross join lateral unnest(spans) span group by user_id,day,active_only
  ),
  daily_sessions as (
    select s.user_id,d.day,count(*)::integer as session_count,
      min(greatest(s.started_at,d.day_start)) as first_seen_at,
      max(least(s.last_seen_at,d.day_end)) as last_seen_at
    from public.team_presence_sessions s join days d on s.started_at < d.day_end and s.last_seen_at >= d.day_start
    where s.client_id = p_client_id group by s.user_id,d.day
  ),
  -- Autore storico testuale: non attribuire operazioni se il nome è ambiguo.
  unique_names as (
    select lower(trim(name)) as name,min(id::text)::uuid as user_id from members group by lower(trim(name)) having count(*) = 1
  ),
  operations as (
    select n.user_id,(a.created_at at time zone 'Europe/Rome')::date as day,
      count(*)::integer as recorded_operations,count(distinct a.lead_id)::integer as worked_leads,
      count(*) filter(where a.activity_type = 'call')::integer as recorded_calls
    from public.lead_activities a join unique_names n on lower(trim(a.created_by)) = n.name
    where a.client_id = p_client_id and a.created_at >= p_from::timestamp at time zone 'Europe/Rome'
      and a.created_at < (p_to+1)::timestamp at time zone 'Europe/Rome'
    group by n.user_id,(a.created_at at time zone 'Europe/Rome')::date
  ),
  daily as (
    select m.id as user_id,d.day,coalesce(c.seconds,0) as connected_seconds,coalesce(a.seconds,0) as active_seconds,
      coalesce(s.session_count,0) as session_count,s.first_seen_at,s.last_seen_at,
      coalesce(o.recorded_operations,0) as recorded_operations,coalesce(o.worked_leads,0) as worked_leads,coalesce(o.recorded_calls,0) as recorded_calls
    from members m cross join days d
    left join durations c on c.user_id=m.id and c.day=d.day and not c.active_only
    left join durations a on a.user_id=m.id and a.day=d.day and a.active_only
    left join daily_sessions s on s.user_id=m.id and s.day=d.day
    left join operations o on o.user_id=m.id and o.day=d.day
  )
  select jsonb_build_object(
    'server_time',v_now,'activated_at',(select activated_at from public.team_presence_settings where singleton),'retention_days',30,
    'users',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'role',m.role,
      'online',exists(select 1 from public.team_presence_sessions s where s.user_id=m.id and s.client_id=p_client_id and s.ended_at is null and s.last_seen_at>v_now-interval '90 seconds'),
      'active',exists(select 1 from public.team_presence_sessions s where s.user_id=m.id and s.client_id=p_client_id and s.ended_at is null and s.is_active and s.last_seen_at>v_now-interval '90 seconds'),
      'last_seen_at',(select max(s.last_seen_at) from public.team_presence_sessions s where s.user_id=m.id and s.client_id=p_client_id)) order by m.name) from members m),'[]'::jsonb),
    'days',coalesce((select jsonb_agg(to_jsonb(d) order by d.day desc,d.user_id) from daily d),'[]'::jsonb),
    'sessions',coalesce((select jsonb_agg(to_jsonb(s) order by s.started_at desc) from (
      select id,user_id,started_at,last_seen_at,ended_at,is_active,
        coalesce((select sum(extract(epoch from least(i.ends_at,(p_to+1)::timestamp at time zone 'Europe/Rome')-greatest(i.starts_at,p_from::timestamp at time zone 'Europe/Rome')))::integer from public.team_presence_intervals i where i.session_id=team_presence_sessions.id and i.starts_at < (p_to+1)::timestamp at time zone 'Europe/Rome' and i.ends_at > p_from::timestamp at time zone 'Europe/Rome'),0) as connected_seconds,
        coalesce((select sum(extract(epoch from least(i.ends_at,(p_to+1)::timestamp at time zone 'Europe/Rome')-greatest(i.starts_at,p_from::timestamp at time zone 'Europe/Rome')))::integer from public.team_presence_intervals i where i.session_id=team_presence_sessions.id and i.is_active and i.starts_at < (p_to+1)::timestamp at time zone 'Europe/Rome' and i.ends_at > p_from::timestamp at time zone 'Europe/Rome'),0) as active_seconds,
        (ended_at is null and last_seen_at>v_now-interval '90 seconds') as online
      from public.team_presence_sessions where client_id=p_client_id and started_at < (p_to+1)::timestamp at time zone 'Europe/Rome'
        and last_seen_at >= p_from::timestamp at time zone 'Europe/Rome' order by started_at desc limit 1000
    ) s),'[]'::jsonb),
    'session_total',(select count(*) from public.team_presence_sessions where client_id=p_client_id and started_at < (p_to+1)::timestamp at time zone 'Europe/Rome' and last_seen_at >= p_from::timestamp at time zone 'Europe/Rome')
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.team_activity_report(uuid,date,date) from public, anon;
grant execute on function public.team_activity_report(uuid,date,date) to authenticated;

-- Pulizia giornaliera anche senza accessi, quando pg_cron è già disponibile.
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    if not exists(select 1 from cron.job where jobname='team-presence-retention') then
      perform cron.schedule('team-presence-retention','17 2 * * *','select public.team_presence_cleanup()');
    end if;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;

select (select count(*) from information_schema.tables where table_schema='public' and table_name in ('team_presence_sessions','team_presence_intervals','team_presence_settings')) as tabelle_attese_3,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('team_presence_heartbeat','team_activity_report')) as funzioni_attese_2,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('team_presence_sessions','team_presence_intervals','team_presence_settings') and c.relrowsecurity) as rls_attese_3;
