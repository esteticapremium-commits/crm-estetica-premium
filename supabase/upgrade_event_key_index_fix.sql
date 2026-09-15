-- RIMEDIO URGENTE: ripristina gli indici di deduplicazione non parziali.
--
-- upgrade_sales_kpis_v2.sql li aveva resi parziali con "where event_key is not
-- null". Postgres pero' non riesce a dedurre un ON CONFLICT da un indice
-- parziale se l'istruzione non ripete lo stesso predicato, e PostgREST non lo
-- ripete. Risultato: ogni salvataggio che usa la chiave falliva con
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- bloccando i pulsanti di esito, la prenotazione degli appuntamenti e la
-- registrazione degli incassi.
--
-- L'indice pieno funziona identicamente per la deduplicazione: in Postgres i
-- valori NULL sono considerati distinti tra loro, quindi le righe storiche
-- senza chiave non collidono. L'unico costo era qualche pagina di indice in
-- piu', e non vale la rottura che ha causato.

drop index if exists public.lead_activities_event_key_uidx;
create unique index lead_activities_event_key_uidx
  on public.lead_activities(client_id, event_key);

drop index if exists public.sales_revenue_event_key_uidx;
create unique index sales_revenue_event_key_uidx
  on public.sales_revenue_events(client_id, event_key);

notify pgrst, 'reload schema';

-- Verifica: entrambi devono risultare "pieno".
select indexname,
       case when indexdef like '%WHERE%' then 'PARZIALE - NON VA BENE' else 'pieno' end as stato
from pg_indexes
where schemaname = 'public'
  and indexname in ('lead_activities_event_key_uidx', 'sales_revenue_event_key_uidx')
order by indexname;
