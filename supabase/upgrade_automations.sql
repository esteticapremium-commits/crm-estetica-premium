-- Applicare dopo upgrade_lead_sequences.sql. Nessun invio o cron abilitato.
begin;
create table public.lead_automation_settings (
 client_id uuid primary key references public.clients(id),
 paused boolean not null default true,
 daily_limit integer not null default 100 check(daily_limit between 1 and 10000),
 monthly_email_limit integer not null default 3000 check(monthly_email_limit between 1 and 1000000)
);
alter table public.lead_automation_settings enable row level security;
create policy read_settings on public.lead_automation_settings for select to authenticated using(public.is_admin() or client_id=public.my_client_id());
create policy manage_settings on public.lead_automation_settings for all to authenticated using(public.is_admin()) with check(public.is_admin());
-- Bloccare anche gli ingressi automatici durante la pausa generale.
-- Anche un passaggio da un percorso a un altro richiede tutti i consensi.
create function public.automation_check_entry() returns trigger language plpgsql set search_path=public as $$
begin
 if exists(select 1 from jsonb_array_elements(new.steps) item join lead_sequence_preferences p on p.lead_id=new.lead_id join leads l on l.id=p.lead_id
 where (item->>'channel'='email' and (not p.email_consent or coalesce(l.email,'')='')) or (item->>'channel'='whatsapp' and (not p.whatsapp_consent or coalesce(l.phone,'')='')) or p.suppressed) then return null;end if;
 return new;
end $$;
create trigger automation_check_entry before insert on public.lead_sequence_enrollments for each row execute function public.automation_check_entry();
alter function public.sequence_enroll(uuid) rename to sequence_enroll_unpaused;
revoke all on function public.sequence_enroll_unpaused(uuid) from public,anon,authenticated,service_role;
create function public.sequence_enroll(p_client uuid) returns integer language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from lead_automation_settings where client_id=p_client and not paused) then return 0; end if;
 return sequence_enroll_unpaused(p_client);
end $$;
revoke all on function public.sequence_enroll(uuid) from public,anon,authenticated;
grant execute on function public.sequence_enroll(uuid) to service_role;
-- Le bozze possono contenere testi vuoti; approvazione e attivazione richiedono contenuti completi.
create or replace function public.sequence_content_changed() returns trigger language plpgsql set search_path=public as $$
declare item jsonb;
begin
 if tg_op='UPDATE' then
 if row(new.steps,new.stage_names,new.inactive_days,new.tag_filter,new.next_sequence_id,new.next_delay_days)
 is distinct from row(old.steps,old.stage_names,old.inactive_days,old.tag_filter,old.next_sequence_id,old.next_delay_days)
 then new.approved=false;new.active=false;end if;
 if new.client_id<>old.client_id then raise exception 'Il cliente del percorso non può cambiare';end if;
 end if;
 if length(trim(new.name))=0 then raise exception 'Inserire il nome del percorso';end if;
 if new.next_sequence_id is not null and not exists(select 1 from lead_sequences where id=new.next_sequence_id and client_id=new.client_id) then raise exception 'Percorso successivo non valido';end if;
 if new.approved or new.active then
 if jsonb_array_length(new.steps)=0 then raise exception 'Inserire almeno un passaggio';end if;
 for item in select value from jsonb_array_elements(new.steps) loop
 if coalesce(item->>'channel','') not in ('email','whatsapp') or coalesce(item->>'delay_days','') !~ '^[0-9]+$' then raise exception 'Canale o attesa non validi';end if;
 if (item->>'delay_days')::numeric>365 then raise exception 'Attesa massima 365 giorni';end if;
 if length(trim(coalesce(item->>'body','')))=0 or (item->>'channel'='email' and length(trim(coalesce(item->>'subject','')))=0) then raise exception 'Completare testo e oggetto';end if;
 if item->>'channel'='whatsapp' and (coalesce(item->>'template','') !~ '^[a-z0-9_]+$' or coalesce(item->>'language','') !~ '^[a-z]{2}(_[A-Z]{2})?$') then raise exception 'Modello WhatsApp o lingua non validi';end if;
 if regexp_replace(coalesce(item->>'body','')||coalesce(item->>'subject',''),'{{nome[[:space:]]*}}','','g') like '%{{%' then raise exception 'Segnaposto supportato: {{nome}}';end if;
 end loop;
 end if;
 return new;
end $$;
drop trigger sequence_content_changed on public.lead_sequences;
create trigger sequence_content_changed before insert or update on public.lead_sequences for each row execute function public.sequence_content_changed();
create function public.automation_stop_enrollment(p_enrollment uuid) returns void language plpgsql security definer set search_path=public as $$
begin
 if not public.is_admin() then raise exception 'Accesso non autorizzato';end if;
 update lead_sequence_enrollments set status='stopped' where id=p_enrollment and status='active';
end $$;
revoke all on function public.automation_stop_enrollment(uuid) from public,anon;
grant execute on function public.automation_stop_enrollment(uuid) to authenticated;
create or replace function public.sequence_claim(p_client uuid,p_limit integer default 100) returns jsonb language plpgsql security definer set search_path=public as $$
declare e lead_sequence_enrollments%rowtype; l leads%rowtype; s lead_sequences%rowtype; p lead_sequence_preferences%rowtype; step jsonb; m lead_sequence_messages%rowtype; used integer; config lead_automation_settings%rowtype;
begin
 perform pg_advisory_xact_lock(hashtext('sequence-send:'||p_client));
 select * into config from lead_automation_settings where client_id=p_client;
 if not found or config.paused then return null; end if;
 p_limit=least(p_limit,config.daily_limit);
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
 if step->>'channel'='email' and (select count(*) from lead_sequence_messages where client_id=p_client and channel='email' and created_at>=date_trunc('month',now() at time zone 'Europe/Rome') at time zone 'Europe/Rome')>=config.monthly_email_limit then continue; end if;
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
 values(p_client,e.id,l.id,e.step_index,step->>'channel',regexp_replace(step->>'body','{{nome[[:space:]]*}}',replace(coalesce(l.name,''),E'\\',E'\\\\'),'g'),regexp_replace(step->>'subject','{{nome[[:space:]]*}}',replace(coalesce(l.name,''),E'\\',E'\\\\'),'g')) returning * into m;
 return jsonb_build_object('message',to_jsonb(m),'lead',to_jsonb(l),'step',step);
 end loop; return null;
end $$;

commit;
