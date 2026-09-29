-- Test d'integrazione: tutti i dati dimostrativi sono annullati dal ROLLBACK.
begin;
do $$
declare
  v_admin uuid; v_seller uuid; v_client uuid;
  v_a uuid := gen_random_uuid(); v_b uuid := gen_random_uuid();
  v_cross uuid := gen_random_uuid(); v_live uuid := gen_random_uuid();
  v_day date := (now() at time zone 'Europe/Rome')::date - 3;
  v_start timestamptz; v_midnight timestamptz;
  v_report jsonb; v_row jsonb; v_result jsonb;
  v_count integer; v_blocked boolean;
begin
  select id into strict v_admin from public.profiles where role='admin' order by id limit 1;
  select id,client_id into strict v_seller,v_client from public.profiles where role <> 'admin' and client_id is not null order by id limit 1;
  v_start := (v_day::timestamp + interval '9 hours') at time zone 'Europe/Rome';
  v_midnight := (v_day+1)::timestamp at time zone 'Europe/Rome';
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  insert into public.team_presence_sessions(id,user_id,client_id,started_at,last_seen_at,ended_at,is_active) values
    (v_a,v_admin,v_client,v_start,v_start+interval '30 seconds',v_start+interval '30 seconds',false),
    (v_b,v_admin,v_client,v_start+interval '15 seconds',v_start+interval '45 seconds',v_start+interval '45 seconds',false),
    (v_cross,v_admin,v_client,v_midnight-interval '15 seconds',v_midnight+interval '15 seconds',v_midnight+interval '15 seconds',false);
  insert into public.team_presence_intervals(session_id,user_id,client_id,starts_at,ends_at,is_active) values
    (v_a,v_admin,v_client,v_start,v_start+interval '30 seconds',true),
    (v_b,v_admin,v_client,v_start+interval '15 seconds',v_start+interval '45 seconds',false),
    (v_cross,v_admin,v_client,v_midnight-interval '15 seconds',v_midnight+interval '15 seconds',true);
  v_report := public.team_activity_report(v_client,v_day,v_day+1);
  select value into strict v_row from jsonb_array_elements(v_report->'days') where value->>'user_id'=v_admin::text and value->>'day'=v_day::text;
  if (v_row->>'connected_seconds')::integer <> 60 or (v_row->>'active_seconds')::integer <> 45 then raise exception 'Unione intervalli errata: %',v_row; end if;
  select value into strict v_row from jsonb_array_elements(v_report->'days') where value->>'user_id'=v_admin::text and value->>'day'=(v_day+1)::text;
  if (v_row->>'connected_seconds')::integer <> 15 or (v_row->>'active_seconds')::integer <> 15 then raise exception 'Divisione a mezzanotte errata: %',v_row; end if;
  v_report := public.team_activity_report(v_client,v_day+1,v_day+1);
  select value into strict v_row from jsonb_array_elements(v_report->'sessions') where value->>'id'=v_cross::text;
  if (v_row->>'connected_seconds')::integer <> 15 then raise exception 'Durata sessione non limitata al giorno selezionato: %',v_row; end if;
  if has_function_privilege('anon','public.team_activity_report(uuid,date,date)','execute') or
    has_function_privilege('anon','public.team_presence_heartbeat(uuid,uuid,boolean,boolean)','execute') or
    has_table_privilege('authenticated','public.team_presence_sessions','select') or
    has_table_privilege('authenticated','public.team_presence_intervals','insert') then raise exception 'Permessi diretti eccessivi'; end if;
  perform set_config('request.jwt.claim.sub',v_seller::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_seller,'role','authenticated')::text,true);
  v_blocked := false;
  begin perform public.team_activity_report(v_client,v_day,v_day); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'Venditore può leggere il registro'; end if;
  v_blocked := false;
  begin perform public.team_presence_heartbeat(v_a,v_client,true,false); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'Venditore può modificare la sessione altrui'; end if;
  v_result := public.team_presence_heartbeat(v_live,v_client,true,false);
  if (v_result->>'closed')::boolean then raise exception 'Nuova sessione chiusa'; end if;
  update public.team_presence_sessions set last_seen_at=clock_timestamp()-interval '30 seconds' where id=v_live;
  perform public.team_presence_heartbeat(v_live,v_client,true,false);
  select count(*) into v_count from public.team_presence_intervals where session_id=v_live;
  if v_count <> 1 then raise exception 'Heartbeat non registrato'; end if;
  perform public.team_presence_heartbeat(v_live,v_client,true,false);
  if (select count(*) from public.team_presence_intervals where session_id=v_live) <> v_count then raise exception 'Heartbeat immediato duplicato'; end if;
  perform public.team_presence_heartbeat(v_live,v_client,false,true);
  v_result := public.team_presence_heartbeat(v_live,v_client,true,false);
  if not (v_result->>'closed')::boolean then raise exception 'Sessione chiusa riaperta'; end if;
  v_live := gen_random_uuid();
  perform public.team_presence_heartbeat(v_live,v_client,true,false);
  update public.team_presence_sessions set last_seen_at=clock_timestamp()-interval '2 minutes' where id=v_live;
  v_result := public.team_presence_heartbeat(v_live,v_client,true,false);
  if not (v_result->>'closed')::boolean or exists(select 1 from public.team_presence_intervals where session_id=v_live) then raise exception 'Pausa offline conteggiata erroneamente'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{}',true);
  v_blocked := false;
  begin perform public.team_presence_heartbeat(gen_random_uuid(),v_client,true,false); exception when insufficient_privilege then v_blocked := true; end;
  if not v_blocked then raise exception 'Accesso senza autenticazione consentito'; end if;
end $$;
select 'ok' as unione_schede, 'ok' as mezzanotte_e_durata_giornaliera,
  'ok' as isolamento_venditore, 'ok' as heartbeat_e_disconnessione,
  'ROLLBACK: nessun dato dimostrativo conservato' as dati_test;
rollback;
