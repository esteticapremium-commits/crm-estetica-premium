# Risveglio lead: implementazione e attivazione

Le modifiche al modulo sono locali sul ramo feature/risveglio-lead. Nessun invio, deploy, modifica DNS o collegamento account viene eseguito da questi file. I contratti restano separati.

## Scelta concordata

Invii automatici tramite Resend, risposte tramite una casella Google Workspace dedicata, WhatsApp tramite API ufficiale Meta. Mittente previsto `Ettore – Estetica Premium <info@estetica-premium.it>`. Non usare l’account personale per l’OAuth. Numero indicato da Ettore: +39 334 849 6487, già su WhatsApp Business; il mantenimento dell’app richiede onboarding Coexistence compatibile, ancora da completare. Non migrare il numero cancellando l’app.

Resend è stato creato, il dominio verificato e la chiave dedicata salvata nei segreti Supabase. SEQUENCE_LIVE=false è stato salvato sul server; nessun invio effettuato. La casella info deve essere creata: un semplice alias non è un account Google autonomo e non si può collegare col suo login. Per isolare l’accesso dalla casella personale, preferire una casella Workspace dedicata. La separazione della casella non garantisce isolamento della reputazione del dominio. Prima dell’attivazione valutare un sottodominio di invio dedicato se la protezione della reputazione è prioritaria.

## Cosa c’è

- Sezione Automazioni: editor di sequenze (fino a 100 passaggi), attese configurabili, canali, filtri fase/inattività/tag, limiti ingressi e messaggi, approvazione, pausa, anteprima locale.
- Sequenza 0/1/2/3 giorni proposta nell’editor, testi vuoti: nessun risultato inventato. Ogni attesa parte dall’invio precedente. Un percorso educativo può essere collegato al risveglio, poi tornare al risveglio dopo 90 giorni. Le sequenze di sola educazione vanno configurate con fasi di ingresso vuote, così entrano solo dal percorso precedente.
- Consensi per canale con fonte e data. Nessun consenso è attribuito automaticamente. Le disiscrizioni non vengono cancellate quando si aggiorna una nota di consenso.
- Invii lunedì–sabato 09:00–19:00 Europe/Rome, massimo un messaggio per canale ogni 24 ore. Limite globale, limite per percorso e ingressi giornalieri distinti.
- Iscrizione e prenotazione dell’invio atomiche, una sola sequenza attiva per lead, copia dei testi per ogni iscrizione. Modificare una sequenza mette in pausa e richiede riapprovazione; gli iscritti esistenti mantengono i testi approvati al loro ingresso.
- Email testo semplice, Reply-To casella dedicata, disiscrizione con conferma GET e one-click POST. Resend bounce e complaint bloccano tutti i canali per il lead.
- WhatsApp: modelli Meta solo testo, senza variabili o con il nome come unica variabile BODY. Il testo in editor deve corrispondere al modello approvato; media, header e pulsanti dinamici non sono implementati.
- Risposte WhatsApp verificate con HMAC; eventi Resend verificati con Svix. STOP WhatsApp esplicito blocca il lead. Qualsiasi risposta email o WhatsApp ferma la sequenza e crea un task prioritario per il venditore, con fase RECALL se non già avanzata.
- Gmail sincronizzata ogni minuto prima degli invii: storia paginata, eventi deduplicati, nessun invio se la sincronizzazione fallisce. Le risposte email sono visibili con il loro oggetto, il contenuto completo resta in Gmail. La lettura usa gmail.readonly e non modifica la casella.
- Prenotazioni registrate in sales_tasks con appointment_status=scheduled fermano la sequenza; avanzamento a SETTING/CLOSING/CLOSED/LOST la ferma. Un LOST selezionato può entrare inizialmente; un nuovo passaggio a LOST lo ferma.
- Tentativi con esito incerto non ritentati automaticamente, per evitare duplicati (Meta non offre qui una chiave idempotente equivalente a Resend). Lo storico li rende visibili per riconciliazione manuale. Una risposta ricevuta tra l’ultimo controllo e la richiesta esterna può ancora incrociare un invio già in partenza.
- RLS: admin gestisce, venditore vede i propri lead. Credenziali Gmail server-only. Configurazione provider per un singolo client_id CRM.

## Ordine di attivazione

1. Creare Resend e verificare il dominio con i record DNS esatti forniti dal servizio. Non modificare gli MX principali che ricevono la posta Google. Configurare SPF/DKIM/DMARC in base ai record già presenti, senza sovrascriverli alla cieca.
2. Creare la casella info e il progetto OAuth Google (può riusare il progetto Google esistente, ma con permessi e credenziali distinti dal calendario). Abilitare Gmail API, origine JavaScript e redirect per l’origine CRM, scope gmail.readonly. Per un progetto interno Workspace configurare il pubblico interno; verificare eventuali requisiti Google prima di renderlo esterno. Non lasciare il collegamento in una modalità di test con credenziali in scadenza per l’uso continuativo.
3. Completare onboarding Meta ufficiale/Coexistence, verificare ricezione e invio sul numero e approvare i modelli. Se il progetto non è abilitato all’onboarding Coexistence diretto, usare un partner ufficiale compatibile e adattare l’onboarding prima di collegare il numero. Non è implementato un pulsante di onboarding Meta nel frontend.
4. Applicare `supabase/upgrade_lead_sequences.sql` e poi `supabase/upgrade_automations.sql`, una volta ciascuno. Richiede schema CRM e migrazioni sales_tasks, sales_control, sales_kpis, RLS già applicate. Nessuna modifica alle tabelle contratti.
5. Configurare i segreti sotto elencati e distribuire le tre funzioni. Per runner e webhook disabilitare la verifica JWT gateway: hanno verifica propria del segreto cron o firma del provider. Gmail usa sessione e controllo admin; mantenere verifica JWT secondo il progetto.

```
supabase functions deploy sequence-runner --no-verify-jwt
supabase functions deploy sequence-webhook --no-verify-jwt
supabase functions deploy sequence-gmail
```

6. Configurare webhook Meta su `/functions/v1/sequence-webhook` (campo messages), verify token corrispondente; webhook Resend su `/functions/v1/sequence-webhook?provider=resend`, eventi email.delivered/email.bounced/email.complained. La stessa funzione gestisce i link di disiscrizione pubblici. Non abilitare invii finché ricezione e firme non sono provate.
7. Frontend: `VITE_SEQUENCE_GOOGLE_CLIENT_ID`, quindi rebuild. Collega Gmail dalla pagina Automazioni usando info. Verifica lo stato dei collegamenti. Un alias non basta per questa modalità: usare una casella autonoma.
8. Preparare Vault e applicare `supabase/enable_lead_sequence_schedule.sql`. Il cron ogni minuto sincronizza le risposte anche fuori fascia oraria, ma in modalità SEQUENCE_LIVE=false non opera su lead reali.
9. Collaudare in un progetto di staging con soli contatti fittizi/di Ettore e credenziali test. Non abilitare SEQUENCE_LIVE nel database di produzione per fare prove. Inserire contenuti reali e consensi documentati, verificare STOP, risposta, prenotazione e disiscrizione prima dell’attivazione.
10. Solo dopo collaudo e autorizzazione all’avvio reale: approvare e attivare i percorsi e impostare SEQUENCE_LIVE=true, con quota iniziale contenuta. Monitorare storico, bounce, complaint e stato Gmail. Nessuna frequenza elimina il rischio di spam: scalare in base a consegne e risposte.

## Segreti delle Edge Function

- SEQUENCE_LIVE=false (default bloccato; solo `true` abilita).
- SEQUENCE_CLIENT_ID: UUID del cliente CRM.
- SEQUENCE_RUNNER_SECRET: segreto casuale forte, identico al valore in Vault.
- SEQUENCE_DAILY_LIMIT: tetto totale messaggi al giorno, es. 100 iniziali; massimo 10000 nell’implementazione attuale.
- SEQUENCE_FROM: `Ettore – Estetica Premium <info@estetica-premium.it>` dopo verifica.
- SEQUENCE_RESEND_KEY, SEQUENCE_RESEND_WEBHOOK_SECRET (dedicati, non recuperati dalle impostazioni dei contratti).
- SEQUENCE_GOOGLE_CLIENT_ID, SEQUENCE_GOOGLE_CLIENT_SECRET, SEQUENCE_MAILBOX=info@estetica-premium.it, SEQUENCE_APP_ORIGIN: origine esatta CRM senza slash finale.
- SEQUENCE_META_TOKEN, SEQUENCE_META_PHONE_ID, SEQUENCE_META_APP_SECRET, SEQUENCE_META_VERIFY_TOKEN, SEQUENCE_META_VERSION: versione Graph supportata verificata al momento dell’attivazione.
- SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY sono forniti dall’ambiente Supabase.

Nessun segreto va committato, inserito in VITE_* o incollato nella chat. Il token Gmail resta nella tabella protetta lead_sequence_mailboxes, inaccessibile a anon/authenticated.

## Verifiche e limiti operativi

Build e test locali senza chiamate ai lead. Il test SQL usa PostgreSQL WASM PGlite con schema CRM fittizio e orologio fisso; non prova il database remoto né i provider reali. Ripetere:

```
npm run build
node --test tests/*.test.mjs
# PGlite installato separatamente, senza cambiare le dipendenze dell’app:
PGLITE_MODULE=/tmp/risveglio-sql-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/test-lead-sequences-sql.mjs
deno check --no-config --no-lock --node-modules-dir=auto supabase/functions/sequence-runner/index.ts supabase/functions/sequence-gmail/index.ts supabase/functions/sequence-webhook/index.ts
```

La sincronizzazione Gmail ha latenza di circa un ciclo cron; non è un webhook push Google. Se la cronologia Gmail scade (404), gli invii si fermano: riconciliare prima le risposte non elaborate e poi ricollegare la casella. Il task prioritario è la notifica operativa; non è stata aggiunta una notifica push o email al venditore. Prenotazioni esterne non registrate nel CRM non fermano il motore. Report fatturato attribuito al risveglio e automazione delle risposte commerciali non sono inclusi. La coda processa fino a 20 messaggi per chiamata cron, con tetto giornaliero: prima di volumi superiori misurare tempi, quote provider e backlog.

Fonti consultate: [HighLevel invii e Gmail](https://help.gohighlevel.com/support/solutions/articles/48001235216-how-to-set-up-two-way-email-sync-for-gmail), [HighLevel WhatsApp Coexistence](https://help.gohighlevel.com/support/solutions/articles/155000003417-whatsapp-coexistence-feature), [Resend invio](https://resend.com/docs/api-reference/emails/send-email), [firme Resend](https://resend.com/docs/webhooks/verify-webhooks-requests), [sincronizzazione Gmail](https://developers.google.com/workspace/gmail/api/guides/sync).

## Macro sezione Automazioni (13 novembre 2026)

Panoramica, Percorsi, Attività, Consensi e Collegamenti sostituiscono la pagina unica Risveglio. La chiave interna di navigazione resta `risveglio` per preservare le sessioni già aperte.

`upgrade_automations.sql` introduce impostazioni per cliente: pausa generale attiva per default, 100 tentativi/giorno e 3000 tentativi email/mese. In assenza della configurazione il motore non iscrive né invia. Il limite mensile è controllato atomicamente al claim, nel mese civile Europe/Rome; non rileva consumi di altre applicazioni sullo stesso account provider. Il tetto server giornaliero resta un limite aggiuntivo.

Le bozze possono essere salvate con testi incompleti; il database valida i passaggi prima dell’approvazione. Modifiche a testi, filtri o concatenamenti revocano approvazione e attivazione. L’editor impedisce approvazione/attivazione con modifiche non salvate. Gli admin possono interrompere un singolo ingresso dalla scheda Attività. Pausa e stop non possono ritirare messaggi già trasmessi al provider.

Per il collaudo usare soltanto la fixture locale. La migrazione, le funzioni e il frontend non sono stati pubblicati con questa modifica.
