-- KPI commerciali v2 — funnel outreach (Instantly + DM) → discovery telefonica
-- → demo in videochiamata → contratto → incasso.
--
-- Questa migrazione è idempotente e non riscrive lo storico: aggiunge soltanto
-- colonne nullable, indici e policy. Va applicata dopo upgrade_sales_kpis.sql e
-- upgrade_sales_kpis_dedup.sql.

-- ---------------------------------------------------------------------------
-- 1. Tipo di chiamata: distingue le azioni di contatto nel registro giornaliero.
--    'lead'     = lead in lavorazione arrivato dall'outreach
--    'outbound' = primo contatto a freddo, lead ancora in fase di setting
--    'client'   = cliente già acquisito (rinnovi, upsell, assistenza)
--    'other'    = tutto il resto (partner, fornitori, interni)
-- ---------------------------------------------------------------------------
alter table public.lead_activities add column if not exists call_type text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lead_activities_call_type_check') then
    alter table public.lead_activities
      add constraint lead_activities_call_type_check
      check (call_type is null or call_type in ('lead', 'outbound', 'client', 'other'));
  end if;
end $$;

-- Lo storico esistente diventa leggibile senza interventi manuali: tutto ciò che
-- era una chiamata o una demo viene attribuito al lead che l'ha generata.
update public.lead_activities
set call_type = 'lead'
where call_type is null
  and (event_type in ('discovery_call', 'demo_call', 'discovery_booked', 'demo_booked')
       or (event_type is null and activity_type = 'call'));

create index if not exists lead_activities_call_type_idx
  on public.lead_activities(client_id, call_type, occurred_at desc)
  where call_type is not null;

-- ---------------------------------------------------------------------------
-- 2. Destinatario dell'appuntamento: separa le demo sui nuovi lead da quelle
--    sui clienti già acquisiti, che nei KPI restano due colonne distinte.
-- ---------------------------------------------------------------------------
alter table public.sales_tasks add column if not exists audience text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_tasks_audience_check') then
    alter table public.sales_tasks
      add constraint sales_tasks_audience_check
      check (audience is null or audience in ('lead', 'client'));
  end if;
end $$;

update public.sales_tasks
set audience = 'lead'
where audience is null and appointment_type is not null;

-- ---------------------------------------------------------------------------
-- 3. Valore del contratto congelato alla firma.
--    Prima € SALES leggeva leads.value, che è modificabile in qualsiasi momento:
--    bastava correggere il valore di un lead per riscrivere un KPI già chiuso.
-- ---------------------------------------------------------------------------
alter table public.contracts add column if not exists deal_value numeric(12,2);

update public.contracts c
set deal_value = l.value
from public.leads l
where c.deal_value is null and c.lead_id = l.id and l.value is not null;

-- ---------------------------------------------------------------------------
-- 4. Costi con responsabile: senza questo campo CPL, CAC e ROI filtrati per
--    venditore dividevano i costi di tutto il team per i risultati di uno solo.
-- ---------------------------------------------------------------------------
alter table public.sales_costs add column if not exists assigned_to text;

-- ---------------------------------------------------------------------------
-- 5. Chiavi di deduplicazione: gli indici diventano parziali, così le righe
--    storiche senza chiave non occupano spazio nell'indice.
-- ---------------------------------------------------------------------------
drop index if exists public.lead_activities_event_key_uidx;
create unique index lead_activities_event_key_uidx
  on public.lead_activities(client_id, event_key)
  where event_key is not null;

drop index if exists public.sales_revenue_event_key_uidx;
create unique index sales_revenue_event_key_uidx
  on public.sales_revenue_events(client_id, event_key)
  where event_key is not null;

-- ---------------------------------------------------------------------------
-- 6. Incassi riservati all'amministratore.
--    Le policy precedenti permettevano a ogni venditore di registrare i propri
--    incassi: i dati di cassa devono passare da una sola mano.
-- ---------------------------------------------------------------------------
drop policy if exists sales_revenue_insert on public.sales_revenue_events;
create policy sales_revenue_insert on public.sales_revenue_events for insert to authenticated
  with check (public.is_admin());

drop policy if exists sales_revenue_update on public.sales_revenue_events;
create policy sales_revenue_update on public.sales_revenue_events for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists sales_revenue_delete on public.sales_revenue_events;
create policy sales_revenue_delete on public.sales_revenue_events for delete to authenticated
  using (public.is_admin());

-- Il venditore continua a vedere gli incassi dei propri lead: gli servono per
-- leggere i KPI della sua colonna, ma non può crearli o modificarli.
drop policy if exists sales_revenue_select on public.sales_revenue_events;
create policy sales_revenue_select on public.sales_revenue_events for select to authenticated
  using (public.is_admin() or (client_id = public.my_client_id() and assigned_to = public.my_full_name()));

-- ---------------------------------------------------------------------------
-- 7. L'upsert dell'esito deve poter aggiornare la riga anche quando
--    l'appuntamento è stato prenotato da un collega: senza questo, correggere
--    un esito su un lead passato di mano falliva con un errore RLS opaco.
-- ---------------------------------------------------------------------------
drop policy if exists lead_activities_update on public.lead_activities;
create policy lead_activities_update on public.lead_activities for update to authenticated
  using (
    public.is_admin()
    or (client_id = public.my_client_id() and created_by = public.my_full_name())
    or (client_id = public.my_client_id() and event_key like 'appointment:%')
  )
  with check (
    public.is_admin()
    or (client_id = public.my_client_id() and created_by = public.my_full_name())
    or (client_id = public.my_client_id() and event_key like 'appointment:%')
  );

-- ---------------------------------------------------------------------------
-- 8. Identità del venditore allineata all'interfaccia.
--    L'app usa `full_name` e ripiega sull'email quando il nome non è compilato;
--    le policy confrontavano invece il solo `full_name`. Con un profilo senza
--    nome il venditore non vedeva più nemmeno le proprie attività.
-- ---------------------------------------------------------------------------
create or replace function public.my_full_name()
returns text language sql stable security definer set search_path = public
as $$
  select coalesce(nullif(trim(p.full_name), ''), u.email)
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- 9. Integrazione Instantly: registro esplicito di ciò che è realmente attivo.
--    L'interfaccia non deve dedurre "Instantly è integrato" dal solo fatto che
--    la tabella sia leggibile, altrimenti i volumi inseriti a mano si sommano
--    a quelli del webhook.
-- ---------------------------------------------------------------------------
create table if not exists public.sales_integrations (
  client_id uuid not null references public.clients(id) on delete cascade,
  provider text not null check (provider in ('instantly')),
  is_active boolean not null default false,
  activated_at timestamptz,
  note text,
  updated_at timestamptz not null default now(),
  primary key (client_id, provider)
);
alter table public.sales_integrations enable row level security;
drop policy if exists sales_integrations_select on public.sales_integrations;
create policy sales_integrations_select on public.sales_integrations for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());
drop policy if exists sales_integrations_write on public.sales_integrations;
create policy sales_integrations_write on public.sales_integrations for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
