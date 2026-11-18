begin;

create or replace function public.get_setter_instructions(p_client_id uuid)
returns text language plpgsql stable security definer set search_path = public
as $$
declare
  caller public.profiles;
begin
  select * into caller from public.profiles where id = auth.uid();
  if caller.id is null or not (
    caller.role = 'admin' or (caller.role = 'setter' and caller.client_id = p_client_id)
  ) or not exists (select 1 from public.clients where id = p_client_id and name = 'Estetica Premium') then
    raise exception 'Istruzioni setter non accessibili';
  end if;

  return $script$**SE IL LEAD RISPONDE, RECITARE ED INTERPRETARE LO SCRIPT PER CHIUDERE L’APPUNTAMENTO**

Pronto (NOME)? Sono NOME SETTER, come stai tutto bene?

Sì, sono NOME SETTER di Estetica Premium, non so se ricordi che ci siamo sentiti qualche tempo fa, più o meno verso Agosto circa…

Ok figurati (NOME), ci mancherebbe.

Infatti era stata una chiamata abbastanza veloce e avevamo rimandato a novembre perché eravamo entrambi presi… ed é stata mia premura richiamare, magari ti faccio un breve riepilogo di massimo 1 minuto, d’accordo?

Stiamo selezionando un centro estetico di riferimento nella tua zona.

Lavoriamo esclusivamente con centri estetici o centri di medicina estetica: indirizzando clienti già interessati a epilazione laser, rimodellamento corpo e anti-age viso presso il tuo centro, pronte per il check-up e la presentazione del percorso.

Gestiamo tutto noi, tu ti concentri sulla cliente quando arriva.

Considera che parliamo di 7-10 clienti in più al mese, il tutto gestito al 100% da noi.

Ed infatti eravamo rimasti che ci saremmo risentiti in questo periodo per riprendere un appuntamento nei prossimi giorni.

**SE IL LEAD TI CHIEDE INCESSANTEMENTE COSA FACCIAMO E COSTI RISPONDI:**

Struttureremo un messaggio di marketing che differenzi chiaramente il tuo centro estetico dalla concorrenza, attirando l’attenzione di potenziali clienti realmente interessati ai trattamenti che vuoi promuovere.

Una volta generate le richieste, la nostra Beauty Consultant si occuperà di contattare ogni lead per comprenderne esigenze, obiettivi e problematiche specifiche. Successivamente, fisserà direttamente gli appuntamenti con i contatti più qualificati.

Il tuo unico compito sarà svolgere le consulenze con persone realmente interessate e con un concreto potenziale di acquisto, per poi concentrarti sulla chiusura e sulla vendita dei tuoi percorsi.

Nessun lavoro extra, nessuna perdita di tempo con contatti poco qualificati: continuerai a fare ciò che sai fare meglio, mentre il nostro sistema lavorerà per espandere la clientela del tuo centro e aumentare le opportunità di vendita.

**SE IL LEAD VUOLE SAPERE A TUTTI I COSTI IL PREZZO RISPONDI:**

Non offriamo un servizio standard, ed in più non sappiamo nemmeno se possiamo indirizzarti questi clienti in sede, ma posiamo valutare tutto nel nostro appuntamento dove il consulente ti esporrà modalità e costi in maniera chiara.

Quando sei disponibile NOME, oggi o domani?

**SE IL NON LEAD RISPONDE, SCRIVERE QUESTO MESSAGGIO SU WHATSAPP.**

**RICORDA: INVIA MAX 50 MESS WHATSAPP A FREDDO AL GIORNO.**

Ciao! Sono Ettore Androsoni, come stai?

Ho provato a chiamarti, ci eravamo sentiti verso agosto poichè il nostro servizio aveva suscitato il vostro interesse.

Come ti dicevo stiamo selezionando un centro estetico di riferimento nella tua zona: indirizziamo nel tuo centro clienti già interessate a epilazione laser, rimodellamento corpo e anti-age viso, pronte per il check-up. 7-10 clienti in più al mese, gestito al 100% da noi.

Eravamo rimasti di risentirci in questo periodo per fissare un appuntamento. Nei prossimi giorni a che ora sei disponibile?$script$;
end;
$$;

revoke all on function public.get_setter_instructions(uuid) from public, anon;
grant execute on function public.get_setter_instructions(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
