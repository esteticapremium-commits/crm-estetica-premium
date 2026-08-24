# Estetica Premium — CRM

CRM della nuova agenzia di marketing **Estetica Premium**: bacheca a pipeline
per il team vendita, tracking giorno per giorno e tasso di passaggio tra le fasi.

Progetto **completamente separato**: database dedicato, app dedicata.
Nessun riferimento ad altri progetti.

## Cosa fa

- **Bacheca**: pipeline con gli stage (NO ANSWER → RECALL → DISCOVERY →
  SETTING → NO SHOW → CLOSING → LOST → CLOSED), trascina i lead tra le fasi.
- **Vendite**: lead lavorati giorno per giorno (chiamate, Discovery, Closing,
  CLOSED) e tasso di passaggio percentuale tra le fasi.
- **Amministrazione**: clienti, fasi, accessi del team vendita, log attività.
- **Venditori**: ogni venditore vede solo il proprio cliente e i propri lead.

## Setup (fai tu, una volta sola, ~10 minuti)

### 1. Crea il progetto Supabase

1. Vai su https://supabase.com/dashboard e accedi.
2. `New project` → nome: `estetica-premium` → password database: generane
   una (il pulsante lo fa da solo) → region `eu-west-1` (Francoforte) →
   `Create new project`. Aspetta 1-2 minuti.
3. In **SQL Editor** → `New query` → incolla **tutto** il contenuto di
   [`supabase/migration.sql`](supabase/migration.sql) → `Run`.
4. In **Project Settings → API** copia:
   - `Project URL` (es. `https://abcdefgh.supabase.co`)
   - `service_role` key (quella "secret", in fondo)
   
   Salva questi due valori: serviranno a Claude per importare i dati.

### 2. Crea il repository GitHub

1. Vai su https://github.com/new → nome: `crm-estetica-premium` → Private →
   `Create repository`.
2. Il repository resta vuoto: ci pensa Claude a caricare il codice
   (devi solo dirgli l'indirizzo, es. `https://github.com/<tuo-utente>/crm-estetica-premium.git`).

### 3. Deploy su Vercel

1. Vai su https://vercel.com/new → importa il repository
   `crm-estetica-premium` (premi `Import` accanto al nome).
2. Framework: **Vite** (si riconosce da solo).
3. **Environment Variables** (pulsante nella schermata di import) — aggiungi:
   - `VITE_SUPABASE_URL` = il Project URL di Supabase (passo 1.4)
   - `VITE_SUPABASE_ANON_KEY` = la chiave `anon` (sempre in Project Settings → API)
4. `Deploy`. Da ora ogni push aggiorna il sito da solo.
5. In **Settings → Domains** puoi collegare un tuo dominio (es. crm.esteticapremium.it).

## Edge Function `admin-user` (gestione accessi dal pannello)

La pagina Amministrazione → Accessi usa una Supabase Edge Function per creare
venditori, cambiare password ed eliminare accessi. Il codice è in
`supabase/functions/admin-user/index.ts`: verifica che chi chiama sia admin e
usa la service role **solo lato server** (segreto, mai nel frontend).

Deploy (una volta sola):

```bash
npx supabase login
npx supabase functions deploy admin-user --project-ref mvujbtygcmowkbvoqcgp
```

In alternativa dal pannello: Supabase → Edge Functions → Deploy new function →
nome `admin-user` → incolla il contenuto di `supabase/functions/admin-user/index.ts` → Deploy.

Finché la funzione non è deployata, la lista venditori funziona comunque
(via funzione RPC nel database) ma creazione/password/elimina rispondono con
un errore: basta fare il deploy per attivarle.

## Sicurezza (RLS)

Le policy del database (in `supabase/migration.sql` e `supabase/upgrade_rls.sql`):
- **admin**: pieno accesso a tutte le tabelle CRM;
- **venditore**: vede e modifica solo i dati del cliente assegnato al suo profilo;
- **anon** (workflow n8n/Instantly): solo inserimento/aggiornamento lead del
  cliente Estetica Premium, nessuna lettura;
- la service_role non è mai usata dal frontend.

## Sviluppo locale

```bash
npm install
npm run dev
```

Build di produzione: `npm run build` (eseguita da Vercel in automatico).
