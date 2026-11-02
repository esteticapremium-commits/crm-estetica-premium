-- Team contracts use the established signing/audit flow, without pipeline leads.
begin;
alter table public.contract_templates add column if not exists team_department text check (team_department in ('sales','marketing','delivery'));
alter table public.contracts add column if not exists team_department text check (team_department in ('sales','marketing','delivery'));
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.contracts'::regclass and conname='team_contract_without_lead') then
    alter table public.contracts add constraint team_contract_without_lead check (team_department is null or (lead_id is null and deal_value is null));
  end if;
end $$;
-- Restrictive rules narrow existing permissions; no seller gains access to HR documents.
drop policy if exists team_contract_admin_only on public.contracts;
create policy team_contract_admin_only on public.contracts as restrictive for all to authenticated
  using (team_department is null or public.is_admin())
  with check (team_department is null or public.is_admin());
drop policy if exists team_template_admin_only on public.contract_templates;
create policy team_template_admin_only on public.contract_templates as restrictive for all to authenticated
  using (team_department is null or public.is_admin())
  with check (team_department is null or public.is_admin());
insert into public.contract_templates(id,client_id,name,body,client_fields,team_department) values ('6bbd92d4-5809-48fa-94a1-dd4de5885f96','fae0d66c-0e93-4e5e-b6f1-82ad0c47674c','Consulente telefonico — Tempo indeterminato · 10% incassato',$team$ESTETICA PREMIUM
ACCORDO DI COLLABORAZIONE
Consulente Telefonico
Accordo di collaborazione professionale a Partita IVA — Tempo indeterminato

1. Chi siamo
Questo accordo è tra:
Committente: AI Business Revolution (di seguito “l’Agenzia”)
con sede in: Via Tropeano, Napoli
P.IVA: 10743551219

e
Collaboratore: {{nome_e_cognome}} (il “Consulente Telefonico”)
Nato/a a: {{luogo_di_nascita}} il: {{data_di_nascita}}
Residente in: {{residenza}}
C.F.: {{codice_fiscale}}
P.IVA: {{partita_iva}}

2. Premesse
• L’Agenzia opera nel settore del marketing e dell’acquisizione clienti per centri estetici, e intende avvalersi dell’esperienza professionale del Consulente Telefonico.
• Il Consulente Telefonico svolge la propria attività in regime di Partita IVA e ha manifestato la volontà di collaborare in forma autonoma con l’Agenzia.
• Le Parti istituiscono un rapporto di lavoro autonomo professionale ai sensi degli artt. 2222 e ss. del Codice Civile. È espressamente escluso qualsiasi rapporto di lavoro subordinato o di agenzia.
• Il Consulente Telefonico dichiara che il corrispettivo percepito dall’Agenzia non costituirà più dell’80% dei corrispettivi totali percepiti nell’anno solare e che l’Agenzia non è il suo unico committente.
• Il Consulente Telefonico non dispone di una postazione fissa presso la sede dell’Agenzia e svolge l’attività con piena autonomia organizzativa.
• Nello svolgimento dell’incarico il Consulente Telefonico verrà a conoscenza di informazioni riservate dell’Agenzia e si impegna a mantenerne la confidenzialità. Le premesse sono parte integrante e sostanziale del presente accordo.

3. Di cosa si occupa il Consulente Telefonico
Per la durata del presente accordo, il Consulente Telefonico gestirà le attività di contatto telefonico sui lead che l’Agenzia gli assegnerà. In concreto:
• Chiamate conoscitive e di qualifica con i lead dell’Agenzia
• Presentazione dei pacchetti di servizio più adatti alle esigenze del potenziale cliente
• Gestione del rapporto con il cliente nel tempo, fornendo risposte e supporto quando necessario
• Coordinamento con il team marketing dell’Agenzia, con feedback utili al miglioramento delle campagne
• Raccolta e gestione dei documenti: contratti, contabili di pagamento, rate del cliente
• Aggiornamento quotidiano del CRM aziendale secondo le modalità e le tempistiche concordate I lead e i clienti assegnati verranno comunicati per iscritto prima dell’inizio dell’attività. L’incarico è conferito senza alcun diritto di esclusiva.

4. Come lavoriamo
L’incarico è “home based”: viene svolto presso la sede del Consulente Telefonico, con propri mezzi e propria organizzazione, in piena autonomia di azione, di tempo e di organizzazione, senza alcun vincolo di subordinazione. Il Consulente Telefonico si impegna a:
• Rispettare i tempi concordati per chiamate, follow-up e aggiornamento del CRM
• Segnalare subito all’Agenzia problemi o anomalie che possano compromettere il normale svolgimento dell’incarico
• Fornire, su richiesta, informazioni sui fatti attinenti al proprio incarico L’Agenzia si impegna a fornire:
• Un indirizzo email aziendale personalizzato
• Gli accessi ai software necessari all’operatività (CRM, dialer, documentazione)
• La reportistica sui numeri aziendali strettamente necessaria all’attività
• Training e formazione professionale per migliorare le performance L’Agenzia revocherà prontamente tutti gli accessi concessi in caso di fine collaborazione. L’incarico è affidato in ragione delle qualità personali del Consulente Telefonico (intuitus personae): i diritti che ne derivano non possono essere ceduti, in tutto o in parte, senza il preventivo accordo scritto dell’Agenzia.

5. Durata
Il presente accordo è a tempo indeterminato a decorrere dalla data di sottoscrizione.

6. Compenso
Il Consulente Telefonico ha diritto a una commissione pari al 10% (dieci per cento) sull’incassato reale, al netto di IVA e ritenute, relativo a ogni contratto di servizio concluso direttamente con i clienti e regolarmente fatturato dall’Agenzia. La commissione viene corrisposta tra il 1° e il 5° giorno del mese successivo a quello di riferimento, in relazione ai contratti conclusi nel mese precedente, tramite bonifico bancario e previo ricevimento di regolare fattura elettronica. Nessun altro compenso, rimborso o indennità è dovuto, salvo diverso accordo scritto.

7. Responsabilità sui risultati
Il Consulente Telefonico dichiara di possedere le competenze professionali necessarie e si impegna a eseguire le prestazioni con la massima diligenza professionale, secondo le migliori pratiche del settore. Svolgendo l’attività presso la propria sede e con propri mezzi, solleva l’Agenzia da ogni responsabilità relativa alla messa in sicurezza del locale adibito a lavoro e all’adempimento degli obblighi di sicurezza sul lavoro.

8. Riservatezza
Il Consulente Telefonico si impegna a mantenere la massima riservatezza su tutte le informazioni acquisite durante la collaborazione: informazioni tecniche, commerciali e strategiche, know-how, dati dei lead e dei clienti, prezzi, costi, progetti, script, risultati delle campagne. L’obbligo di riservatezza vale per tutta la durata dell’accordo e per i 5 (cinque) anni successivi alla cessazione. È fatto espresso divieto di utilizzare per scopi diversi da quelli contrattuali le informazioni, i contenuti e i database dell’Agenzia.

9. Rapporto con i clienti e non concorrenza
I lead e i clienti assegnati sono lead e clienti dell’Agenzia. Il Consulente Telefonico si impegna a non contattarli per finalità commerciali proprie, né direttamente né tramite terzi, durante la collaborazione e nei 12 (dodici) mesi successivi alla sua conclusione. Per tutta la durata dell’accordo e per i 3 (tre) anni successivi alla cessazione, nel territorio italiano, il Consulente Telefonico si impegna a non prestare attività professionale in diretta concorrenza con quella svolta dall’Agenzia nel settore del marketing e della consulenza per centri estetici. L’obbligo di non concorrenza è limitato all’attività specifica oggetto del presente accordo e non si estende ad altri settori professionali del Consulente Telefonico. In caso di violazione degli obblighi di riservatezza, di non concorrenza o di non contatto dei clienti, il Consulente Telefonico sarà tenuto al risarcimento del danno effettivamente subito e dimostrato dall’Agenzia.

10. Materiali prodotti
Tutto ciò che viene creato nell’ambito di questa collaborazione — script, procedure, materiali, processi e metodologie — appartiene all’Agenzia e ai suoi clienti. Restano escluse le competenze professionali generali e le metodologie preesistenti del Consulente Telefonico. In caso di cessazione, per qualsiasi causa, il Consulente Telefonico consegnerà all’Agenzia manuali, procedure, documenti e materiali riguardanti l’attività svolta, cancellando ogni copia in proprio possesso.

11. Dati personali
Nell’esecuzione del presente accordo l’Agenzia assume il ruolo di Titolare del trattamento dei dati personali dei lead e dei clienti; il Consulente Telefonico agisce quale soggetto autorizzato al trattamento, secondo le istruzioni ricevute. Il Consulente Telefonico si impegna a trattare i dati nel rispetto del Regolamento UE 2016/679 e della normativa nazionale, adottando misure di sicurezza appropriate e utilizzando i dati esclusivamente per le finalità contrattuali.

12. Limitazione di responsabilità e forza maggiore
Sono eventi di forza maggiore gli eventi straordinari, imprevedibili e inevitabili che impediscono, in tutto o in parte, l’adempimento delle obbligazioni contrattuali: eventi bellici e atti di terrorismo; pandemie ed emergenze sanitarie dichiarate dalle autorità competenti; catastrofi naturali; provvedimenti delle autorità pubbliche che impediscano o limitino l’attività lavorativa; interruzioni dei servizi essenziali (energia elettrica, telecomunicazioni, internet) per oltre 48 ore consecutive; cyberattacchi di vasta portata che compromettano i sistemi aziendali. In caso di forza maggiore gli obblighi contrattuali sono sospesi per la durata dell’impedimento e i termini sono automaticamente prorogati. Se l’evento si protrae per oltre 30 giorni, ciascuna Parte può recedere senza penali con preavviso di 7 giorni. La responsabilità di ciascuna Parte è limitata ai danni diretti e prevedibili, con esclusione del lucro cessante e dei danni indiretti, e comunque entro il limite del valore del contratto.

13. Se le cose cambiano
Ciascuna Parte può recedere senza giusta causa con un preavviso scritto di 7 (sette) giorni, oppure per giusta causa con effetto immediato. Il compenso viene calcolato in proporzione alle attività effettivamente svolte. L’accordo si risolve di diritto in caso di grave inadempimento agli obblighi principali, non sanato entro 15 (quindici) giorni dalla diffida scritta. Costituiscono gravi inadempimenti:
• L’interruzione definitiva delle prestazioni senza giustificato motivo
• Il trattamento illecito di dati personali
• La violazione degli obblighi di riservatezza
• La violazione degli obblighi di non concorrenza e di non contatto dei clienti In questi casi l’Agenzia si riserva il diritto di recedere con effetto immediato e di revocare ogni accesso.

14. In caso di disaccordo
Le Parti si impegnano a cercare prima di tutto una soluzione amichevole, anche tramite procedimento di mediazione ex D.Lgs. 28/2010 presso l’Organismo di Mediazione della Camera di Commercio competente. In caso di mancato accordo, il Foro competente in via esclusiva è quello di Napoli. Al presente accordo si applica la legge italiana.

15. Disposizioni finali
Il presente accordo sostituisce qualsiasi precedente intesa tra le Parti. Eventuali modifiche devono essere formalizzate per iscritto. L’eventuale nullità di una clausola non inficia la validità delle restanti. È vietata la cessione del contratto senza consenso scritto. La tolleranza di inadempimenti occasionali non costituisce rinuncia ai relativi diritti.

16. Firme
Entrambe le Parti dichiarano di aver letto e accettato quanto sopra.

Approvazione specifica delle clausole
Ai sensi degli articoli 1341 e 1342 del Codice Civile, il Consulente Telefonico dichiara di aver letto attentamente e di approvare specificamente le seguenti clausole:
• Art. 4 (Come lavoriamo — autonomia, divieto di cessione)
• Art. 6 (Compenso)
• Art. 8 (Riservatezza)
• Art. 9 (Rapporto con i clienti e non concorrenza)
• Art. 10 (Materiali prodotti)
• Art. 12 (Limitazione di responsabilità)
• Art. 13 (Recesso e risoluzione)
• Art. 14 (Foro competente)$team$,$fields$Nome e cognome
Luogo di nascita
Data di nascita
Residenza
Codice fiscale
Partita IVA
Luogo di firma$fields$,'sales') on conflict (id) do nothing;
create or replace function public.revoke_contract(p_contract_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not public.can_revoke_contracts() then raise exception 'non autorizzato'; end if;
  select public.my_full_name() into v_name;
  update public.contracts
  set revoked_at = now(), revoked_by = v_name
  where id = p_contract_id and status <> 'signed' and revoked_at is null
    and (coalesce(public.is_admin(), false) or (client_id = public.my_client_id() and team_department is null));
  if not found then return false; end if;
  insert into public.contract_events(contract_id, action, actor)
    values (p_contract_id, 'revoked', v_name);
  return true;
end;
$$;
revoke all on function public.revoke_contract(uuid) from public, anon;
grant execute on function public.revoke_contract(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
select name,team_department from public.contract_templates where id='6bbd92d4-5809-48fa-94a1-dd4de5885f96';
