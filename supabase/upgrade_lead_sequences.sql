-- Risveglio: migrazione additiva. Non abilita cron né invii.
begin;
create table public.lead_sequences (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 name text not null, active boolean not null default false, approved boolean not null default false,
 steps jsonb not null default '[]', stage_names text[] not null default array['NO ANSWER 1-3','NO ANSWER 4-5','RECALL','NO SHOW'],
 inactive_days integer not null default 30 check(inactive_days >= 0), tag_filter text not null default '',
 daily_entries integer not null default 20 check(daily_entries between 1 and 500),
 daily_messages integer not null default 100 check(daily_messages between 1 and 10000),
 next_sequence_id uuid references public.lead_sequences(id), next_delay_days integer not null default 7 check(next_delay_days between 1 and 365),
 created_at timestamptz not null default now(), unique(id,client_id),
 check(jsonb_typeof(steps)='array' and jsonb_array_length(steps)<=100),
 check(not active or (approved and jsonb_array_length(steps)>0))
);
create table public.lead_sequence_preferences (
 lead_id uuid primary key references public.leads(id) on delete cascade,
 client_id uuid not null references public.clients(id),
 email_consent boolean not null default false, whatsapp_consent boolean not null default false,
 evidence text not null default '', suppressed boolean not null default false,
 updated_at timestamptz not null default now(), unique(lead_id,client_id)
);
create table public.lead_sequence_enrollments (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 sequence_id uuid not null, lead_id uuid not null references public.leads(id),
 status text not null default 'active' check(status in ('active','replied','booked','stopped','unsubscribed','completed','error')),
 step_index integer not null default 0, next_at timestamptz not null default now(),
 steps jsonb not null, entry_stage_id uuid, created_at timestamptz not null default now(), completed_at timestamptz,
 foreign key(sequence_id,client_id) references public.lead_sequences(id,client_id),
 foreign key(lead_id,client_id) references public.lead_sequence_preferences(lead_id,client_id),
 check(jsonb_array_length(steps)>0)
);
create unique index lead_sequence_one_active on public.lead_sequence_enrollments(lead_id) where status='active';
create index lead_sequence_due on public.lead_sequence_enrollments(next_at) where status='active';
create table public.lead_sequence_messages (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 enrollment_id uuid not null references public.lead_sequence_enrollments(id), lead_id uuid not null references public.leads(id),
 step_index integer not null, channel text not null check(channel in ('email','whatsapp')),
 status text not null default 'sending' check(status in ('sending','sent','failed','uncertain','delivered','read')),
 provider_id text, body text not null, subject text, error text,
 unsubscribe_token uuid not null default gen_random_uuid(), created_at timestamptz not null default now(),
 unique(enrollment_id,step_index), unique(unsubscribe_token)
);
create unique index lead_sequence_provider_message on public.lead_sequence_messages(channel,provider_id) where provider_id is not null;
create table public.lead_sequence_events (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 lead_id uuid not null references public.leads(id), channel text not null, external_id text not null,
 kind text not null, body text, created_at timestamptz not null default now(), unique(client_id,lead_id,channel,external_id)
);
-- Segreti: nessun accesso browser, neanche per admin.
create table public.lead_sequence_mailboxes (
 client_id uuid primary key references public.clients(id), email text not null,
 refresh_token text not null, history_id text not null, synced_at timestamptz not null default now()
);
alter table public.lead_sequence_mailboxes enable row level security;
revoke all on public.lead_sequence_mailboxes from anon, authenticated;
do $$ declare t text; begin
 foreach t in array array['lead_sequences','lead_sequence_preferences','lead_sequence_enrollments','lead_sequence_messages','lead_sequence_events'] loop
 execute format('alter table public.%I enable row level security',t);
 if t='lead_sequences' then
 execute format('create policy read_client on public.%I for select to authenticated using (public.is_admin() or client_id=public.my_client_id())',t);
 else
 execute format('create policy read_client on public.%I for select to authenticated using (public.is_admin() or (client_id=public.my_client_id() and exists(select 1 from public.leads l where l.id=lead_id)))',t);
 end if;
 end loop;
 foreach t in array array['lead_sequences','lead_sequence_preferences'] loop
 execute format('create policy admin_write on public.%I for all to authenticated using(public.is_admin()) with check(public.is_admin())',t);
 end loop;
end $$;
create function public.sequence_validate_owner() returns trigger language plpgsql set search_path=public as $$
begin
 if not exists(select 1 from leads where id=new.lead_id and client_id=new.client_id) then raise exception 'Lead non appartenente al cliente'; end if;
 new.updated_at=now(); return new;
end $$;
create trigger sequence_preferences_owner before insert or update on public.lead_sequence_preferences for each row execute function public.sequence_validate_owner();
-- Le modifiche ai contenuti richiedono una nuova approvazione; gli iscritti mantengono una copia dei passaggi.
create function public.sequence_content_changed() returns trigger language plpgsql set search_path=public as $$
begin
 if new.steps is distinct from old.steps then new.approved=false; new.active=false; end if;
 if new.next_sequence_id is not null and not exists(select 1 from lead_sequences where id=new.next_sequence_id and client_id=new.client_id) then raise exception 'Percorso successivo non valido'; end if;
 return new;
end $$;
create trigger sequence_content_changed before update on public.lead_sequences for each row execute function public.sequence_content_changed();
-- Eventi in ingresso: registrazione e stop atomici, task creato una sola volta.
create function public.sequence_receive(p_client uuid,p_lead uuid,p_channel text,p_external text,p_kind text,p_body text)
returns void language plpgsql security definer set search_path=public as $$
declare l leads%rowtype; n integer; recall uuid;
begin
 select * into l from leads where id=p_lead and client_id=p_client for update;
 if not found then raise exception 'Lead non valido'; end if;
 insert into lead_sequence_events(client_id,lead_id,channel,external_id,kind,body) values(p_client,p_lead,p_channel,p_external,p_kind,p_body) on conflict do nothing;
 get diagnostics n=row_count; if n=0 then return; end if;
 if p_kind in ('unsubscribe','bounced','complained') then
 insert into lead_sequence_preferences(lead_id,client_id,suppressed) values(p_lead,p_client,true)
 on conflict(lead_id) do update set suppressed=true;
 end if;
 if p_kind not in ('reply','unsubscribe','bounced','complained') then return; end if;
 update lead_sequence_enrollments set status=case when p_kind='reply' then 'replied' else 'unsubscribed' end
 where lead_id=p_lead and status in ('active','completed');
 get diagnostics n=row_count;
 if p_kind='reply' and n>0 then
 insert into sales_tasks(client_id,lead_id,title,due_at,assigned_to,is_priority,description)
 values(p_client,p_lead,'Risveglio: richiamare entro 24 ore',now()+interval '24 hours',coalesce(nullif(l.assigned_to,''),'Titolare'),true,'Risposta ricevuta via '||p_channel);
 select id into recall from stages where pipeline_id=l.pipeline_id and upper(name)='RECALL' limit 1;
 if recall is not null and not exists(select 1 from stages where id=l.stage_id and upper(name) in ('SETTING','CLOSING','CLOSED')) then update leads set stage_id=recall where id=p_lead; end if;
 end if;
end $$;
create function public.sequence_stop_on_stage() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.stage_id is distinct from old.stage_id and exists(select 1 from stages where id=new.stage_id and upper(name) in ('SETTING','CLOSING','CLOSED','LOST')) then
 update lead_sequence_enrollments set status=case when exists(select 1 from stages where id=new.stage_id and upper(name)='SETTING') then 'booked' else 'stopped' end where lead_id=new.id and status in ('active','completed');
 end if; return new;
end $$;
create trigger sequence_stage_stop after update of stage_id on public.leads for each row execute function public.sequence_stop_on_stage();
create function public.sequence_stop_on_booking() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.lead_id is not null and new.appointment_status='scheduled' then
 update lead_sequence_enrollments set status='booked' where lead_id=new.lead_id and status in ('active','completed');
 end if; return new;
end $$;
create trigger sequence_booking_stop after insert or update on public.sales_tasks for each row execute function public.sequence_stop_on_booking();
-- Eseguito dal server, massimo una chiamata concorrente per cliente.
create function public.sequence_enroll(p_client uuid) returns integer language plpgsql security definer set search_path=public as $$
declare s lead_sequences%rowtype; n integer; total integer:=0; remaining integer;
begin
 perform pg_advisory_xact_lock(hashtext('sequence-enroll:'||p_client));
 for s in select * from lead_sequences where client_id=p_client and active and approved order by created_at loop
 select greatest(0,s.daily_entries-count(*)::integer) into remaining from lead_sequence_enrollments where sequence_id=s.id and (created_at at time zone 'Europe/Rome')::date=(now() at time zone 'Europe/Rome')::date;
 insert into lead_sequence_enrollments(client_id,sequence_id,lead_id,steps,entry_stage_id,next_at)
 select p_client,target.id,prior.lead_id,target.steps,l.stage_id,now()+make_interval(days=>coalesce((target.steps->0->>'delay_days')::integer,0))
 from lead_sequence_enrollments prior join lead_sequences source on source.id=prior.sequence_id
 join lead_sequences target on target.id=source.next_sequence_id and target.client_id=p_client
 join leads l on l.id=prior.lead_id join stages st on st.id=l.stage_id
 join lead_sequence_preferences pref on pref.lead_id=l.id
 where target.id=s.id and prior.client_id=p_client and prior.status='completed' and prior.completed_at+make_interval(days=>source.next_delay_days)<=now()
 and source.active and target.active and target.approved and not pref.suppressed
 and upper(st.name) not in ('SETTING','CLOSING','CLOSED','LOST')
 and not exists(select 1 from lead_sequence_enrollments newer where newer.lead_id=prior.lead_id and newer.created_at>prior.created_at)
 and not exists(select 1 from sales_tasks t where t.lead_id=l.id and t.appointment_status='scheduled')
 order by prior.completed_at limit remaining on conflict do nothing;
 get diagnostics n=row_count; total=total+n; remaining=remaining-n;
 insert into lead_sequence_enrollments(client_id,sequence_id,lead_id,steps,entry_stage_id,next_at)
 select p_client,s.id,l.id,s.steps,l.stage_id,now()+make_interval(days=>coalesce((s.steps->0->>'delay_days')::integer,0))
 from leads l join stages st on st.id=l.stage_id join lead_sequence_preferences p on p.lead_id=l.id and p.client_id=p_client
 where l.client_id=p_client and not p.suppressed and st.name=any(s.stage_names)
 and l.updated_at < now()-make_interval(days=>s.inactive_days)
 and not exists(select 1 from lead_activities a where a.lead_id=l.id and a.created_at > now()-make_interval(days=>s.inactive_days))
 and (s.tag_filter='' or position(lower(s.tag_filter) in lower(coalesce(l.tags,'')))>0)
 and not exists(select 1 from jsonb_array_elements(s.steps) step where (step->>'channel'='email' and (not p.email_consent or coalesce(l.email,'')='')) or (step->>'channel'='whatsapp' and (not p.whatsapp_consent or coalesce(l.phone,'')='')))
 and not exists(select 1 from sales_tasks t where t.lead_id=l.id and t.appointment_status='scheduled')
 and not exists(select 1 from lead_sequence_enrollments e where e.lead_id=l.id and (e.status='active' or e.sequence_id=s.id or e.status in ('replied','unsubscribed','booked')))
 order by l.updated_at,l.id limit remaining on conflict do nothing;
 get diagnostics n=row_count; total=total+n;
 end loop; return total;
end $$;
create function public.sequence_claim(p_client uuid,p_limit integer default 100) returns jsonb language plpgsql security definer set search_path=public as $$
declare e lead_sequence_enrollments%rowtype; l leads%rowtype; s lead_sequences%rowtype; p lead_sequence_preferences%rowtype; step jsonb; m lead_sequence_messages%rowtype; used integer;
begin
 perform pg_advisory_xact_lock(hashtext('sequence-send:'||p_client));
 if extract(isodow from now() at time zone 'Europe/Rome')=7 or extract(hour from now() at time zone 'Europe/Rome') not between 9 and 18 then return null; end if;
 if (select count(*) from lead_sequence_messages where client_id=p_client and (created_at at time zone 'Europe/Rome')::date=(now() at time zone 'Europe/Rome')::date)>=least(greatest(p_limit,1),10000) then return null; end if;
 -- Un tentativo interrotto non viene ritentato alla cieca: potrebbe essere già partito.
 update lead_sequence_messages set status='uncertain',error='Esito incerto: verificare presso il provider prima di reinviare' where client_id=p_client and status='sending' and created_at<now()-interval '10 minutes';
 for e in select en.* from lead_sequence_enrollments en join lead_sequences seq on seq.id=en.sequence_id
 where en.client_id=p_client and en.status='active' and en.next_at<=now() and seq.active and seq.approved order by en.next_at for update of en skip locked loop
 select * into s from lead_sequences where id=e.sequence_id;
 select * into l from leads where id=e.lead_id;
 select * into p from lead_sequence_preferences where lead_id=e.lead_id;
 step=e.steps->e.step_index;
 if step is null then update lead_sequence_enrollments set status='completed',completed_at=now() where id=e.id; continue; end if;
 if p.suppressed or (step->>'channel'='email' and not p.email_consent) or (step->>'channel'='whatsapp' and not p.whatsapp_consent) then
 update lead_sequence_enrollments set status='stopped' where id=e.id; continue; end if;
 if exists(select 1 from stages where id=l.stage_id and upper(name) in ('SETTING','CLOSING','CLOSED')) or exists(select 1 from sales_tasks where lead_id=l.id and appointment_status='scheduled') then
 update lead_sequence_enrollments set status='booked' where id=e.id; continue; end if;
 if exists(select 1 from lead_sequence_messages where enrollment_id=e.id and step_index=e.step_index) then continue; end if;
 -- Limite di frequenza trasversale: massimo un messaggio per canale ogni 24 ore.
 if exists(select 1 from lead_sequence_messages where lead_id=e.lead_id and channel=step->>'channel' and status<>'failed' and created_at>now()-interval '24 hours') then continue; end if;
 select count(*) into used from lead_sequence_messages msg join lead_sequence_enrollments en on en.id=msg.enrollment_id where en.sequence_id=s.id and (msg.created_at at time zone 'Europe/Rome')::date=(now() at time zone 'Europe/Rome')::date;
 if used>=s.daily_messages then continue; end if;
 insert into lead_sequence_messages(client_id,enrollment_id,lead_id,step_index,channel,body,subject)
 values(p_client,e.id,l.id,e.step_index,step->>'channel',replace(step->>'body','{{nome}}',coalesce(l.name,'')),replace(step->>'subject','{{nome}}',coalesce(l.name,''))) returning * into m;
 return jsonb_build_object('message',to_jsonb(m),'lead',to_jsonb(l),'step',step);
 end loop; return null;
end $$;
create function public.sequence_finish(p_message uuid,p_provider text,p_status text,p_error text default null) returns void language plpgsql security definer set search_path=public as $$
declare m lead_sequence_messages%rowtype; e lead_sequence_enrollments%rowtype;
begin
 select * into m from lead_sequence_messages where id=p_message for update;
 if not found or m.status<>'sending' then return; end if;
 if p_status not in ('sent','failed','uncertain') then raise exception 'Stato non valido'; end if;
 update lead_sequence_messages set status=p_status,provider_id=p_provider,error=p_error where id=m.id;
 if p_status<>'sent' then update lead_sequence_enrollments set status='error' where id=m.enrollment_id and status='active'; return; end if;
 select * into e from lead_sequence_enrollments where id=m.enrollment_id for update;
 if e.status<>'active' then return; end if;
 update lead_sequence_enrollments set step_index=step_index+1,
 status=case when step_index+1>=jsonb_array_length(steps) then 'completed' else 'active' end,
 completed_at=case when step_index+1>=jsonb_array_length(steps) then now() else null end,
 next_at=now()+make_interval(days=>coalesce((steps->(step_index+1)->>'delay_days')::integer,0)) where id=e.id;
end $$;
-- Ricerca indicizzata dei contatti: evita scansioni complete a ogni risposta.
create index if not exists leads_sequence_email on public.leads(client_id,lower(trim(email)));
create index if not exists leads_sequence_phone on public.leads(client_id,(regexp_replace(regexp_replace(phone,'[^0-9]','','g'),'^00','')));
create function public.sequence_receive_contact(p_client uuid,p_contact text,p_channel text,p_external text,p_kind text,p_body text)
returns void language plpgsql security definer set search_path=public as $$
declare l record;
begin
 for l in select id from leads where client_id=p_client and
 ((p_channel='email' and lower(trim(email))=lower(trim(p_contact))) or
 (p_channel='whatsapp' and regexp_replace(regexp_replace(phone,'[^0-9]','','g'),'^00','')=regexp_replace(regexp_replace(p_contact,'[^0-9]','','g'),'^00',''))) loop
 perform sequence_receive(p_client,l.id,p_channel,p_external,p_kind,p_body);
 end loop;
end $$;
revoke all on function public.sequence_receive_contact(uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.sequence_receive_contact(uuid,text,text,text,text,text) to service_role;
-- Lease del worker: due tick cron non sincronizzano/inviano contemporaneamente.
create table public.lead_sequence_worker_locks (
 client_id uuid primary key references public.clients(id), token uuid not null, expires_at timestamptz not null
);
alter table public.lead_sequence_worker_locks enable row level security;
revoke all on public.lead_sequence_worker_locks from anon,authenticated;
create function public.sequence_worker_acquire(p_client uuid) returns uuid language plpgsql security definer set search_path=public as $$
declare t uuid;
begin
 insert into lead_sequence_worker_locks(client_id,token,expires_at) values(p_client,gen_random_uuid(),now()+interval '10 minutes')
 on conflict(client_id) do update set token=excluded.token,expires_at=excluded.expires_at
 where lead_sequence_worker_locks.expires_at<now() returning token into t;
 return t;
end $$;
create function public.sequence_worker_release(p_client uuid,p_token uuid) returns void language sql security definer set search_path=public as $$
 delete from lead_sequence_worker_locks where client_id=p_client and token=p_token;
$$;
revoke all on function public.sequence_worker_acquire(uuid),public.sequence_worker_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sequence_worker_acquire(uuid),public.sequence_worker_release(uuid,uuid) to service_role;
-- RPC del motore accessibili esclusivamente alle Edge Function.
revoke all on function public.sequence_receive(uuid,uuid,text,text,text,text), public.sequence_enroll(uuid), public.sequence_claim(uuid,integer), public.sequence_finish(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.sequence_receive(uuid,uuid,text,text,text,text), public.sequence_enroll(uuid), public.sequence_claim(uuid,integer), public.sequence_finish(uuid,text,text,text) to service_role;

create function public.sequence_save_consent(p_lead uuid,p_email boolean,p_whatsapp boolean,p_evidence text)
returns void language plpgsql security definer set search_path=public as $$
declare c uuid;
begin
 if not public.is_admin() then raise exception 'Accesso non autorizzato'; end if;
 if length(trim(p_evidence))=0 then raise exception 'Indicare fonte e data del consenso'; end if;
 select client_id into c from leads where id=p_lead;
 if c is null then raise exception 'Lead non valido'; end if;
 insert into lead_sequence_preferences(lead_id,client_id,email_consent,whatsapp_consent,evidence)
 values(p_lead,c,p_email,p_whatsapp,p_evidence)
 on conflict(lead_id) do update set email_consent=p_email,whatsapp_consent=p_whatsapp,evidence=p_evidence;
end $$;
revoke all on function public.sequence_save_consent(uuid,boolean,boolean,text) from public,anon;
grant execute on function public.sequence_save_consent(uuid,boolean,boolean,text) to authenticated;
commit;
