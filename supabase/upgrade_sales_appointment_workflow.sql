begin;

alter table public.sales_tasks
  add column if not exists commercial_tracked boolean not null default false,
  add column if not exists appointment_outcome text,
  add column if not exists outcome_minutes integer,
  add column if not exists outcome_note text,
  add column if not exists appointment_host text,
  add column if not exists proposal_made boolean;

-- Existing rows remain intact. The guard also covers inserts from older clients.
create or replace function public.guard_open_sales_appointment() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.lead_id is not null and new.appointment_type in ('discovery', 'demo')
    and new.completed_at is null and coalesce(new.appointment_status, 'scheduled') in ('scheduled', 'rescheduled') then
    perform pg_advisory_xact_lock(hashtextextended(concat_ws(':', new.client_id, new.lead_id, new.appointment_type), 0));
    if exists (
      select 1 from public.sales_tasks where client_id = new.client_id and lead_id = new.lead_id
        and appointment_type = new.appointment_type and id is distinct from new.id and completed_at is null
        and coalesce(appointment_status, 'scheduled') in ('scheduled', 'rescheduled')
    ) then raise exception 'Esiste già un appuntamento da svolgere. Aprilo per spostarlo o registrare l’esito.'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_open_sales_appointment() from public, anon, authenticated;
drop trigger if exists guard_open_sales_appointment on public.sales_tasks;
create trigger guard_open_sales_appointment before insert or update of appointment_type, lead_id, client_id, appointment_status, completed_at
  on public.sales_tasks for each row execute function public.guard_open_sales_appointment();

create or replace function public.book_sales_appointment(
  p_id uuid, p_client_id uuid, p_lead_id uuid, p_type text, p_audience text,
  p_title text, p_due_at timestamptz, p_minutes integer, p_description text,
  p_note text, p_previous_outcome_key text, p_source_reply_id uuid, p_host text
) returns public.sales_tasks
language plpgsql security invoker set search_path = public
as $$
declare
  booking public.sales_tasks;
  target_lead public.leads;
  author text := public.my_full_name();
  previous_activity public.lead_activities;
  source_reply public.sales_outreach_events;
begin
  if auth.uid() is null or (not coalesce(public.is_admin(), false) and p_client_id is distinct from public.my_client_id()) then
    raise exception 'Accesso non autorizzato';
  end if;
  if p_id is null or p_type is null or p_audience is null or p_type not in ('discovery', 'demo') or p_audience not in ('lead', 'client')
    or p_due_at is null or p_minutes is null or p_minutes < 1 or nullif(trim(p_title), '') is null then
    raise exception 'Dati appuntamento non validi';
  end if;
  -- Bookings from different devices share the same lock for a lead and phase.
  perform pg_advisory_xact_lock(hashtextextended(concat_ws(':', p_client_id, coalesce(p_lead_id, p_id), p_type), 0));
  select * into booking from public.sales_tasks where id = p_id and client_id = p_client_id;
  if found then
    if booking.lead_id is distinct from p_lead_id or booking.appointment_type is distinct from p_type
      or booking.due_at is distinct from p_due_at or booking.audience is distinct from p_audience
      or booking.title is distinct from p_title or booking.description is distinct from p_description
      or booking.duration_minutes is distinct from p_minutes then
      raise exception 'La richiesta è già stata salvata con altri dati. Ricarica l’appuntamento.';
    end if;
    return booking;
  end if;

  if p_lead_id is not null then
    select * into target_lead from public.leads where id = p_lead_id and client_id = p_client_id;
    if not found then raise exception 'Lead non accessibile'; end if;
    if p_previous_outcome_key is not null then
      select * into previous_activity from public.lead_activities
        where client_id = p_client_id and lead_id = p_lead_id and event_key = p_previous_outcome_key
        and ((p_type = 'demo' and event_type = 'discovery_call' and outcome = 'qualified')
          or (p_type || '_call' = event_type and outcome in ('no_show', 'no_answer')));
      if not found then raise exception 'Esito precedente non trovato'; end if;
    end if;
    if p_source_reply_id is not null then
      select * into source_reply from public.sales_outreach_events where id = p_source_reply_id
        and client_id = p_client_id and lead_id = p_lead_id and event_type = 'reply' and quantity = 1
        and occurred_at <= now();
      if not found or p_type <> 'discovery' then raise exception 'Risposta outreach non collegabile'; end if;
    end if;
  end if;

  if nullif(trim(p_host), '') is not null
    and p_host is distinct from author and p_host is distinct from target_lead.assigned_to then
    raise exception 'Conduzione non valida per il lead selezionato';
  end if;

  insert into public.sales_tasks
    (id, client_id, lead_id, title, description, due_at, assigned_to, created_by,
     appointment_type, appointment_status, audience, duration_minutes, commercial_tracked, appointment_host)
  values (p_id, p_client_id, p_lead_id, p_title, p_description, p_due_at,
    coalesce(nullif(target_lead.assigned_to, ''), nullif(author, ''), 'Venditore'), author,
    p_type, 'scheduled', p_audience, p_minutes, true,
    coalesce(nullif(trim(p_host), ''), nullif(target_lead.assigned_to, ''), author))
  returning * into booking;

  if p_lead_id is not null then
    insert into public.lead_activities
      (lead_id, client_id, pipeline_id, activity_type, event_type, channel, call_type,
       outcome, occurred_at, scheduled_at, duration_minutes, note, created_by, details, event_key)
    values (p_lead_id, p_client_id, target_lead.pipeline_id, 'meeting', p_type || '_booked',
      case when p_type = 'discovery' then 'phone' else 'video_call' end,
      case when p_audience = 'client' then 'client' else 'lead' end,
      'scheduled', booking.created_at, booking.due_at, p_minutes, p_note, author,
      jsonb_strip_nulls(jsonb_build_object('task_id', booking.id, 'assigned_to', booking.assigned_to,
        'owner_at_event', booking.assigned_to, 'appointment_host', booking.appointment_host, 'source_outcome_key', p_previous_outcome_key, 'source_reply_id', p_source_reply_id)), 'appointment:' || booking.id || ':booked');
  end if;
  return booking;
end;
$$;

create or replace function public.save_sales_appointment_outcome(
  p_id uuid, p_expected_updated_at timestamptz, p_outcome text, p_minutes integer, p_note text, p_proposal_made boolean
) returns public.sales_tasks
language plpgsql security invoker set search_path = public
as $$
declare
  task public.sales_tasks;
  result_status text;
  result_minutes integer;
  result_note text;
  result_proposal boolean;
  previous_activity public.lead_activities;
  pipeline uuid;
  author text := public.my_full_name();
begin
  if auth.uid() is null then raise exception 'Accesso richiesto'; end if;
  select * into task from public.sales_tasks where id = p_id for update;
  if not found then raise exception 'Appuntamento non accessibile'; end if;
  if task.appointment_status = 'cancelled' or task.due_at > now() then
    raise exception 'L’esito si registra dall’orario della call';
  end if;
  if not coalesce((task.appointment_type = 'discovery' and p_outcome in ('qualified', 'not_qualified', 'no_answer'))
    or (task.appointment_type = 'demo' and p_outcome in ('held', 'no_show')), false) then
    raise exception 'Esito non valido per questo appuntamento';
  end if;
  if p_minutes is not null and p_minutes < 1 then raise exception 'Durata non valida'; end if;
  result_status := case when p_outcome in ('no_show', 'no_answer') then 'no_show' else 'held' end;
  if task.lead_id is not null then
    select * into previous_activity from public.lead_activities where client_id = task.client_id
      and event_key = 'appointment:' || task.id || ':outcome';
  end if;
  result_minutes := case when result_status = 'held' then coalesce(p_minutes, task.outcome_minutes,
    previous_activity.duration_minutes, task.duration_minutes, case when task.appointment_type = 'discovery' then 30 else 60 end) end;
  result_note := case when p_note is null then coalesce(task.outcome_note, previous_activity.note) else nullif(trim(p_note), '') end;
  result_proposal := case when task.appointment_type = 'demo' and result_status = 'held'
    then coalesce(p_proposal_made, task.proposal_made) end;
  if task.updated_at is distinct from p_expected_updated_at then
    if task.appointment_outcome = p_outcome and task.outcome_minutes is not distinct from result_minutes
      and task.outcome_note is not distinct from result_note
      and task.proposal_made is not distinct from result_proposal then return task; end if;
    raise exception 'Appuntamento aggiornato da un collega. Riaprilo prima di correggere l’esito.';
  end if;
  update public.sales_tasks set appointment_status = result_status, completed_at = now(), completed_by = author,
    commercial_tracked = true, appointment_outcome = p_outcome, outcome_minutes = result_minutes,
    outcome_note = result_note, proposal_made = result_proposal
  where id = task.id returning * into task;
  if not found then raise exception 'Modifica non autorizzata'; end if;
  if task.lead_id is not null then
    select pipeline_id into pipeline from public.leads where id = task.lead_id;
    insert into public.lead_activities as activity
      (lead_id, client_id, pipeline_id, activity_type, event_type, channel, call_type,
        outcome, occurred_at, scheduled_at, duration_minutes, note, created_by, details, event_key)
    values (task.lead_id, task.client_id, pipeline,
      case when task.appointment_type = 'discovery' then 'call' else 'meeting' end,
      task.appointment_type || '_call',
      case when task.appointment_type = 'discovery' then 'phone' else 'video_call' end,
      case when task.audience = 'client' then 'client' else 'lead' end,
      p_outcome, task.due_at, task.due_at, result_minutes, task.outcome_note, author,
      jsonb_build_object('task_id', task.id, 'assigned_to', task.assigned_to, 'owner_at_event', task.assigned_to, 'appointment_host', task.appointment_host,
        'outcome_recorded_by', author, 'proposal_made', task.proposal_made),
      'appointment:' || task.id || ':outcome')
    on conflict (client_id, event_key) do update set
      outcome = excluded.outcome, occurred_at = excluded.occurred_at, scheduled_at = excluded.scheduled_at,
      duration_minutes = excluded.duration_minutes, note = excluded.note,
      details = coalesce(activity.details, '{}'::jsonb) || excluded.details;
  end if;
  return task;
end;
$$;

revoke all on function public.book_sales_appointment(uuid,uuid,uuid,text,text,text,timestamptz,integer,text,text,text,uuid,text) from public, anon;
revoke all on function public.save_sales_appointment_outcome(uuid,timestamptz,text,integer,text,boolean) from public, anon;
grant execute on function public.book_sales_appointment(uuid,uuid,uuid,text,text,text,timestamptz,integer,text,text,text,uuid,text) to authenticated;
grant execute on function public.save_sales_appointment_outcome(uuid,timestamptz,text,integer,text,boolean) to authenticated;
alter table public.sales_revenue_events
  add column if not exists sale_appointment_id uuid references public.sales_tasks(id) on delete set null;

create or replace function public.check_sales_revenue_appointment() returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.sale_appointment_id is not distinct from old.sale_appointment_id
    and new.lead_id is not distinct from old.lead_id and new.client_id is not distinct from old.client_id
    and new.occurred_at is not distinct from old.occurred_at then return new; end if;
  if new.sale_appointment_id is not null and not exists (
    select 1 from public.sales_tasks t where t.id = new.sale_appointment_id and t.client_id = new.client_id
      and t.lead_id = new.lead_id and t.appointment_type = 'demo' and t.appointment_status = 'held'
      and t.due_at <= new.occurred_at
  ) then raise exception 'Collega un incasso a una closing svolta di questo lead'; end if;
  return new;
end;
$$;
drop trigger if exists check_sales_revenue_appointment on public.sales_revenue_events;
create trigger check_sales_revenue_appointment before insert or update of sale_appointment_id, lead_id, client_id, occurred_at on public.sales_revenue_events
  for each row execute function public.check_sales_revenue_appointment();

notify pgrst, 'reload schema';

commit;
