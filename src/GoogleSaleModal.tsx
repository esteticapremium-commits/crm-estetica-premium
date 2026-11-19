import LeadDateTimePicker from './LeadDateTimePicker';
import { useEffect, useRef, useState } from 'react';
import { createAppointment } from './appointments';
import { supabase } from './supabaseClient';
import { withTimeout } from './async';
import { listGoogleCalendarEvents, type GoogleEvent } from './calendarGoogle';
import type { Lead } from './types';
import { googleOutcomesBeforeStart, googleSaleKey, saleOutcomes, validateGoogleSale, type GoogleSale, type GoogleSaleOutcome } from './googleSales';
import './googleSales.css';
const localStamp = (iso: string | null | undefined) => {
  if (!iso) return '';
  const date = new Date(iso); const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const iso = (value: string) => value ? new Date(value).toISOString() : null;
type ClosingChoice = {
  reference: string;
  title: string;
  starts_at: string;
  google_event_id?: string;
  booked_at?: string | null;
};
export default function GoogleSaleModal({ clientId, event, sale, leads, admin, onClose, onSaved }: {
  clientId: string; event?: GoogleEvent; sale?: GoogleSale; leads: Lead[]; admin: boolean;
  onClose: () => void; onSaved: (warning?: string) => void;
}) {
  const [contact, setContact] = useState(sale?.contact_name || event?.summary || '');
  const [leadId, setLeadId] = useState(sale?.lead_id || '');
  const [leadSearch, setLeadSearch] = useState('');
  const normalizeSearch = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
  const query = normalizeSearch(leadSearch);
  const matchingLeads = query ? leads.filter(lead => {
    const text = normalizeSearch([lead.name, lead.email, lead.phone].filter(Boolean).join(' '));
    const phoneQuery = query.replace(/[\s()+.-]/g, '');
    return text.includes(query) || (/^\d+$/.test(phoneQuery) && (lead.phone || '').replace(/\D/g, '').includes(phoneQuery));
  }) : [];
  const selectedLead = leads.find(lead => lead.id === leadId);
  const [type, setType] = useState<GoogleSale['appointment_type'] | "">(sale?.appointment_type ||
    (/\bdiscovery\b/i.test(event?.summary || "") ? "discovery" : /\b(?:demo|closing)\b/i.test(event?.summary || "") ? "demo" : ""));
  const [revenueType, setRevenueType] = useState<GoogleSale['revenue_type']>(sale?.revenue_type || 'new');
  const [outcome, setOutcome] = useState<GoogleSale['outcome']>(sale?.outcome || 'pending');
  const [proposal, setProposal] = useState(sale?.proposal_made || false);
  const [qualified, setQualified] = useState(sale?.qualified == null ? '' : String(sale.qualified));
  const [startsAt, setStartsAt] = useState(localStamp(sale?.starts_at || event?.start?.dateTime));
  const beforeStart = Date.parse(startsAt) > Date.now();
  const [next, setNext] = useState(localStamp(sale?.next_action_at));
  const [closingDay, setClosingDay] = useState(() => (localStamp(sale?.next_action_at) || localStamp(new Date().toISOString())).slice(0, 10));
  const [closingReference, setClosingReference] = useState(sale?.outcome === 'closing_booked' ? sale.closing_reference || '' : '');
  const [closingMode, setClosingMode] = useState<'new' | 'existing'>(sale?.closing_reference ? 'existing' : 'new');
  const [closingTime, setClosingTime] = useState('');
  const bookingId = useRef('');
  const bookedClosing = useRef<{ reference: string; warning?: string } | null>(null);
  const [closingChoices, setClosingChoices] = useState<ClosingChoice[]>([]);
  const [closingLoading, setClosingLoading] = useState(false);
  const [closingWarning, setClosingWarning] = useState('');
  const [value, setValue] = useState(String(sale?.contract_value || ''));
  const [cash, setCash] = useState(String(sale?.collected_amount || ''));
  const [cashAt, setCashAt] = useState(localStamp(sale?.collected_at || new Date().toISOString()));
  const [note, setNote] = useState(sale?.note || '');
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState('');
  const discoveryKey = sale?.google_key || (event ? googleSaleKey(event) : '');
  const discoveryId = sale?.google_event_id || event?.id;
  useEffect(() => {
    if (outcome !== 'closing_booked' || closingMode !== 'existing' || !closingDay) return;
    const start = new Date(`${closingDay}T00:00:00`);
    if (!Number.isFinite(start.getTime())) return;
    const end = new Date(start); end.setDate(end.getDate() + 1);
    let current = true;
    setClosingLoading(true); setClosingWarning(''); setClosingChoices([]);
    void Promise.allSettled([
      withTimeout(supabase.from('sales_tasks').select('id,title,due_at,google_event_id,appointment_status').eq('client_id', clientId)
        .eq('appointment_type', 'demo').gte('due_at', start.toISOString()).lt('due_at', end.toISOString()).order('due_at')),
      withTimeout(listGoogleCalendarEvents(start, end)),
    ]).then(([crmResult, googleResult]) => {
      if (!current) return;
      const crm = crmResult.status === 'fulfilled' ? crmResult.value : null;
      const googleEvents = googleResult.status === 'fulfilled' ? googleResult.value : null;
      const crmRows = (crm?.data || []).filter(task => task.appointment_status !== 'cancelled');
      const linkedIds = new Set((crm?.data || []).map(task => task.google_event_id));
      const options: ClosingChoice[] = [
        ...crmRows.map(task => ({ reference: `crm:${task.id}`, title: task.title, starts_at: task.due_at })),
        ...(googleEvents || []).flatMap(candidate => {
          const at = candidate.start?.dateTime;
          const key = googleSaleKey(candidate);
          if (!at || candidate.id === discoveryId || key === discoveryKey || linkedIds.has(candidate.id)) return [];
          return [{ reference: `google:${key}`, title: candidate.summary || 'Evento Google', starts_at: at,
            google_event_id: candidate.id, booked_at: candidate.originalStartTime ? null : candidate.created || null }];
        }),
      ];
      const unique = new Map(options.map(option => [option.reference, option]));
      setClosingChoices([...unique.values()].filter(option => Date.parse(option.starts_at) > Date.parse(startsAt))
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)));
      if (!crm || crm.error || !googleEvents) setClosingWarning('Non ho potuto leggere tutti i calendari. Controlla il collegamento a Google per vedere anche i suoi eventi.');
      setClosingLoading(false);
    });
    return () => { current = false; };
  }, [clientId, closingDay, closingMode, discoveryId, discoveryKey, outcome, startsAt]);

  async function save() {
    if (lock.current) return;
    if (!type) return setError('Scegli Discovery, Closing o Follow-up.');
    try {
      const payload = {
        google_key: sale?.google_key || googleSaleKey(event!), google_event_id: sale?.google_event_id || event!.id,
        title: sale?.title || event?.summary || contact, contact_name: contact.trim(),
        starts_at: iso(startsAt) || '', booked_at: sale ? sale.booked_at : event?.originalStartTime ? null : event?.created || null,
        proposal_made: outcome === 'won' || proposal, lead_id: leadId || null, appointment_type: type, revenue_type: revenueType, outcome,
        qualified: outcome === 'closing_booked' ? true : type === 'discovery' && qualified !== '' ? qualified === 'true' : null,
        next_action_at: ['follow_up', 'rescheduled'].includes(outcome) ? iso(next) : null,
        contract_value: outcome === 'won' ? Number(value) : 0,
        collected_amount: outcome === 'won' ? Number(cash) : 0,
        collected_at: outcome === 'won' && Number(cash) > 0 ? iso(cashAt) : null, note: note.trim(),
      };
      const invalid = validateGoogleSale(payload);
      if (invalid) { setError(invalid); return; }
      const choice = closingChoices.find(item => item.reference === closingReference);
      let closing = choice
        ? {reference: choice.reference, starts_at: choice.starts_at, google_event_id: choice.google_event_id, booked_at: choice.booked_at}
        : closingReference && closingReference === sale?.closing_reference ? {reference: closingReference} : null;
      const newClosing = outcome === 'closing_booked' && closingMode === 'new';
      const closingStart = new Date(`${closingDay}T${closingTime}`);
      if (newClosing && !bookedClosing.current &&
        (!Number.isFinite(closingStart.getTime()) || closingStart.getTime() <= Math.max(Date.now(), Date.parse(payload.starts_at)))) {
        return setError('Scegli una data e un’ora future per la Closing, successive alla Discovery.');
      }
      if (outcome === 'closing_booked' && !newClosing && !closing) {
        return setError('Seleziona la Closing già in calendario.');
      }
      lock.current = true; setBusy(true); setError('');
      if (newClosing) {
        if (leadId && !selectedLead) throw new Error('Il lead collegato non è accessibile.');
        if (!bookedClosing.current) {
          bookingId.current ||= crypto.randomUUID();
          const booking = await createAppointment({
            clientId, lead: selectedLead || null, type: 'demo', audience: 'lead',
            subject: selectedLead?.name || contact.trim(), startsAt: closingStart,
            note: '', requestId: bookingId.current,
          });
          if (!booking.ok || !booking.taskId) throw new Error(booking.error || 'Prenotazione non confermata.');
          bookedClosing.current = {
            reference: `crm:${booking.taskId}`,
            warning: [booking.pipelineWarning, booking.warning].filter(Boolean).join(' '),
          };
        }
        closing = { reference: bookedClosing.current.reference };
      }
      const args = {p_client_id: clientId, p_sale: payload, p_expected_version: sale?.version || 0};
      const request = outcome === 'closing_booked'
        ? supabase.rpc('save_google_discovery_with_closing', {...args, p_closing: closing})
        : supabase.rpc('save_google_sale', args);
      const result = await withTimeout(request, 20000, 'Conferma non ricevuta. Riprova: la stessa registrazione non viene duplicata.');
      if (result.error) throw new Error(result.error.message);
      const saved = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!saved?.id) throw new Error('Il server non ha confermato il salvataggio.');
      onSaved(newClosing ? bookedClosing.current?.warning : undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Salvataggio non riuscito.';
      setError(bookedClosing.current
        ? `Closing già prenotata nel CRM. Riprova per salvare l’esito della Discovery. ${message}`
        : message);
    }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="calendar-modal-overlay" onClick={() => !busy && onClose()}>
    <section className="calendar-modal google-sale-modal" role="dialog" aria-modal="true" aria-label="Appuntamento di vendita Google" onClick={e => e.stopPropagation()}>
      <header className="calendar-detail-head"><span className="calendar-detail-label">Google Calendar · Vendita</span><button disabled={busy} aria-label="Chiudi vendita" onClick={onClose}>×</button></header>
      <h2>{sale ? 'Esito appuntamento' : 'Appuntamento di vendita'}</h2>
      <p>Collega un lead per sincronizzare la Discovery o la Closing con la sua fase in pipeline.</p>
      <p className="muted">Solo i dati inseriti qui vengono condivisi nel CRM con chi è autorizzato. Le note private di Google non vengono copiate.</p>
      {error && <div className="notice err" role="alert">{error}</div>}
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={busy}>
          <label>Contatto<input required value={contact} onChange={e => setContact(e.target.value)} /></label>
          <div className="google-sale-grid">
            <label>Tipo di appuntamento<select disabled={!!bookedClosing.current} value={type} onChange={e => {
              const nextType = e.target.value as typeof type;
              setType(nextType);
              if (nextType !== 'discovery' && outcome === 'closing_booked') setOutcome('pending');
            }}><option value="">Scegli il tipo</option><option value="demo">Closing / demo</option><option value="discovery">Discovery</option><option value="follow_up">Follow-up post closing</option></select></label>
            {type !== "discovery" && <label>Tipo di vendita<select value={revenueType} onChange={e => setRevenueType(e.target.value as typeof revenueType)}><option value="new">Nuovo cliente</option><option value="renewal">Rinnovo</option><option value="upsell">Upsell</option></select></label>}
          </div>

          {sale && event?.start?.dateTime && new Date(event.start.dateTime).getTime() !== new Date(sale.starts_at).getTime() && <p className="notice">La data su Google è cambiata. <button type="button" className="btn small" onClick={() => setStartsAt(localStamp(event.start?.dateTime))}>Usa il nuovo orario Google</button></p>}
          <label>Esito<select disabled={!!bookedClosing.current} value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}>
            {type === 'discovery' && <option value="closing_booked" disabled={beforeStart}>Closing prenotata</option>}
            {Object.entries(saleOutcomes).filter(([key]) => key !== 'closing_booked').map(([key, label]) => <option key={key} value={key} disabled={beforeStart && !googleOutcomesBeforeStart.includes(key as GoogleSaleOutcome)}>{beforeStart && key === 'no_show' ? 'No-show preannunciato' : label}</option>)}
          </select></label>
          {outcome === 'closing_booked' && <>
            <label>Closing<select value={closingMode} disabled={!!bookedClosing.current} onChange={e => setClosingMode(e.target.value as typeof closingMode)}>
              <option value="new">Prenota una nuova Closing</option>
              <option value="existing">Collega un evento già in agenda</option>
            </select></label>
            {closingMode === 'new' ? <LeadDateTimePicker
              value={closingDay ? `${closingDay}T${closingTime}` : ''}
              disabled={busy || !!bookedClosing.current}
              onChange={datetime => {
                const [day, time = ''] = datetime.split('T');
                setClosingDay(day);
                setClosingTime(time);
                setClosingReference('');
              }}
            /> : <div className="google-sale-grid">
              <label>Data della Closing<input type="date" required disabled={!!bookedClosing.current} value={closingDay} onChange={e => {setClosingDay(e.target.value);setClosingReference('');setClosingChoices([]);}} /></label>
              <label>Evento già in agenda<select required value={closingReference} disabled={closingLoading} onChange={e => setClosingReference(e.target.value)}>
                <option value="">{closingLoading ? 'Ricerca in calendario…' : 'Scegli la Closing'}</option>
                {closingReference && closingReference === sale?.closing_reference && !closingChoices.some(choice => choice.reference === closingReference) &&
                  <option value={closingReference}>Closing già collegata</option>}
                {closingChoices.map(choice => <option key={choice.reference} value={choice.reference}>
                  {new Date(choice.starts_at).toLocaleTimeString('it-IT', {timeZone:'Europe/Rome', hour:'2-digit',minute:'2-digit'})} · {choice.title}
                </option>)}
              </select></label>
            </div>}
            <small role="status">{closingMode === 'new' ? 'Il CRM prenota la Closing e registra la Discovery come svolta e in target.' : closingWarning || (!closingLoading && !closingChoices.length && !closingReference
              ? 'Nessun evento successivo alla Discovery in questa data. Seleziona “Prenota una nuova Closing” per fissarla qui.'
              : 'La Discovery risulta svolta e in target. Il CRM usa la Closing già in agenda, senza duplicarla.')}</small>
          </>}
          {['follow_up','lost'].includes(outcome) && <label>Offerta presentata<select value={String(proposal)} onChange={e => setProposal(e.target.value === 'true')}><option value="false">No</option><option value="true">Sì</option></select></label>}
          {type === 'discovery' && ['won','lost','follow_up'].includes(outcome) && <label>Contatto in target<select required value={qualified} onChange={e => setQualified(e.target.value)}><option value="">Seleziona</option><option value="true">Sì</option><option value="false">No</option></select></label>}
          {['follow_up','rescheduled'].includes(outcome) && <label>Prossimo passo · data e ora<input type="datetime-local" required value={next} onChange={e => setNext(e.target.value)} /><small>Comparirà nella home alla scadenza. Per spostare o creare l’evento usa Google Calendar.</small></label>}
          {outcome === 'won' && <>
            <label>Valore dell’accordo (€)<input type="number" min="0.01" max="9999999999.99" step="0.01" required value={value} onChange={e => setValue(e.target.value)} /></label>
            <label>Incasso registrato per questa vendita (€)<input type="number" min="0" max="9999999999.99" step="0.01" value={cash} disabled={!admin} onChange={e => setCash(e.target.value)} /></label>
            {!admin && <small>L’incasso di una vendita esterna viene registrato dall’amministratore.</small>}
            {Number(cash) > 0 && <label>Data effettiva dell’incasso<input type="datetime-local" required disabled={!admin} value={cashAt} onChange={e => setCashAt(e.target.value)} /></label>}
            <small>Registra qui un pagamento, con la sua data effettiva, solo se non è già presente nel CRM. Questo campo corregge lo stesso pagamento: per rate in date diverse usa il registro incassi collegato al lead.</small>
          </>}
          <div className="google-sale-lead-picker">
            <label>Lead collegato · facoltativo<input type="search" placeholder="Cerca per nome, telefono o email" value={leadSearch} onChange={e => setLeadSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} /></label>
            <div className="google-sale-selected-lead">{leadId ? <><span><b>{selectedLead?.name || 'Lead collegato'}</b>{selectedLead?.phone && <small>{selectedLead.phone}</small>}</span><button type="button" className="btn small" onClick={() => setLeadId('')}>Rimuovi collegamento</button></> : <small>Senza un lead collegato, salvi la call solo nel registro vendite.</small>}</div>
            {query && <><small role="status">{matchingLeads.length ? `${matchingLeads.length} risultati${matchingLeads.length > 50 ? ' · primi 50, precisa la ricerca' : ''}` : 'Nessun lead trovato tra quelli accessibili.'}</small><div className="google-sale-lead-results">{matchingLeads.slice(0, 50).map(lead => <button type="button" key={lead.id} aria-pressed={lead.id === leadId} onClick={() => { setLeadId(lead.id); setLeadSearch(''); }}><b>{lead.name || 'Senza nome'}</b><small>{[lead.phone, lead.email].filter(Boolean).join(' · ')}</small></button>)}</div></>}
          </div>
          <details><summary>Data, ora e nota</summary>
          <label>Data e ora della call<input type="datetime-local" required value={startsAt} onChange={e => setStartsAt(e.target.value)} /></label>
          <label>Nota {outcome === 'lost' ? '/ motivo' : '/ prossimo passo'}<textarea rows={3} maxLength={5000} value={note} onChange={e => setNote(e.target.value)} /></label>
                  </details>
        </fieldset>
        <footer><button type="button" className="btn" disabled={busy} onClick={onClose}>Annulla</button><button className="btn primary" disabled={busy || (outcome === 'closing_booked' && (closingMode === 'existing' ? closingLoading || !closingReference : !closingDay || !closingTime))}>{busy ? 'Salvataggio…' : outcome === 'closing_booked' && closingMode === 'new' ? bookedClosing.current ? 'Salva esito Discovery' : 'Prenota Closing e salva esito' : 'Salva nei risultati'}</button></footer>
      </form>
    </section>
  </div>;
}
