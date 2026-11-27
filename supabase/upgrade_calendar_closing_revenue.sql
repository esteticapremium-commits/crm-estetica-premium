-- Apply after upgrade_closing_won.
begin;

-- A standalone closing can have its own payment without a lead.
do $migration$
declare
  definition text := pg_get_functiondef('public.check_sales_revenue_appointment()'::regprocedure);
  before_check text := 't.lead_id = new.lead_id';
  after_check text := '(t.lead_id = new.lead_id or (t.lead_id is null and new.lead_id is null and new.event_key = ''calendar-closing:'' || t.id))';
begin
  if strpos(definition,after_check)=0 then
    if strpos(definition,before_check)=0 then raise exception 'Convalida collegamento incasso da verificare'; end if;
    execute replace(definition,before_check,after_check);
  end if;
end;
$migration$;

create or replace function public.save_calendar_closing(
  p_id uuid, p_expected_updated_at timestamptz, p_contract_value numeric,
  p_collected_amount numeric, p_revenue_type text
) returns public.sales_tasks
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  task public.sales_tasks;
  target public.leads;
  payment public.sales_revenue_events;
  payment_key text := 'calendar-closing:' || p_id;
  previous_cash numeric;
  cash_to_record numeric;
  closed_stage uuid;
begin
  if auth.uid() is null or not coalesce(public.is_admin(), false) then
    raise exception 'Solo l’amministratore può registrare gli importi della closing';
  end if;
  if p_contract_value is null or p_collected_amount is null
    or p_contract_value::text in ('NaN','Infinity','-Infinity') or p_collected_amount::text in ('NaN','Infinity','-Infinity')
    or p_contract_value <= 0 or p_contract_value >= 10000000000
    or p_collected_amount < 0 or p_collected_amount > p_contract_value
    or round(p_contract_value,2) <> p_contract_value or round(p_collected_amount,2) <> p_collected_amount then
    raise exception 'Inserisci un valore del contratto positivo e un incassato compreso tra zero e il valore del contratto';
  end if;

  select * into task from public.sales_tasks where id=p_id and appointment_type='demo' for update;
  if not found then raise exception 'Closing non accessibile'; end if;
  if p_revenue_type is null or
    (task.audience is distinct from 'client' and p_revenue_type <> 'new') or
    (task.audience = 'client' and p_revenue_type not in ('renewal','upsell')) then
    raise exception 'Tipo di vendita non valido per questa closing';
  end if;

  select * into payment from public.sales_revenue_events
    where client_id=task.client_id and event_key=payment_key for update;
  select coalesce(sum(amount),0) into previous_cash from public.sales_revenue_events
    where client_id=task.client_id and sale_appointment_id=task.id and status='collected'
      and event_key is distinct from payment_key;
  cash_to_record := p_collected_amount - previous_cash;
  if cash_to_record < 0 then
    raise exception 'L’incassato è inferiore ai pagamenti già collegati. Correggili nella sezione Incassi.';
  end if;
  if task.appointment_status='held' and task.appointment_outcome='won'
    and payment.contract_value=p_contract_value and payment.amount=cash_to_record
    and payment.revenue_type=p_revenue_type
    and payment.status=(case when cash_to_record>0 then 'collected' else 'expected' end) then
    return task;
  end if;
  if task.updated_at is distinct from p_expected_updated_at then
    raise exception 'Appuntamento aggiornato da un collega. Riaprilo prima di correggere l’esito.';
  end if;

  task := public.save_sales_appointment_outcome(p_id, p_expected_updated_at, 'won', null, null, true);
  if task.lead_id is not null then
    select * into target from public.leads where id=task.lead_id and client_id=task.client_id for update;
    if not found then raise exception 'Lead collegato non accessibile'; end if;
    if p_revenue_type='new' then
      select s.id into closed_stage from public.stages s
        where s.client_id=target.client_id and s.pipeline_id=target.pipeline_id and upper(trim(s.name))='CLOSED'
        order by s.position,s.id limit 1;
      update public.leads l set value=p_contract_value, closing_date=coalesce(l.closing_date,(now() at time zone 'Europe/Rome')::date),
        stage_id=coalesce(closed_stage,l.stage_id), next_action_date=null, lost_reason=null,
        position=case when closed_stage is null or l.stage_id=closed_stage then l.position
          else least(0,coalesce((select min(other.position) from public.leads other
            where other.client_id=target.client_id and other.pipeline_id=target.pipeline_id and other.stage_id=closed_stage),0))-1 end
        where l.id=target.id;
    end if;
  end if;

  insert into public.sales_revenue_events as r (
    client_id, pipeline_id, lead_id, sale_appointment_id, revenue_type, amount, contract_value,
    status, occurred_at, assigned_to, created_by, note, event_key
  ) values (
    task.client_id, target.pipeline_id, task.lead_id, task.id, p_revenue_type, cash_to_record, p_contract_value,
    case when cash_to_record>0 then 'collected' else 'expected' end,
    case when payment.status='collected' then payment.occurred_at else now() end,
    coalesce(nullif(task.appointment_host,''),task.assigned_to),public.my_full_name(),'Closing da calendario · ' || task.title,payment_key
  ) on conflict(client_id,event_key) do update set
    revenue_type=excluded.revenue_type, amount=excluded.amount, contract_value=excluded.contract_value,
    status=excluded.status, occurred_at=excluded.occurred_at;

  -- Updating amounts must invalidate an older popup even if the call outcome was already won.
  update public.sales_tasks set updated_at=clock_timestamp() where id=task.id returning * into task;
  return task;
end;
$$;

revoke all on function public.save_calendar_closing(uuid,timestamptz,numeric,numeric,text) from public, anon;
grant execute on function public.save_calendar_closing(uuid,timestamptz,numeric,numeric,text) to authenticated;
notify pgrst, 'reload schema';
commit;
