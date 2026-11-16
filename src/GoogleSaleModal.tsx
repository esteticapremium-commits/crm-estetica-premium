import { useRef, useState } from 'react';
import { supabase } from './supabaseClient';
import { withTimeout } from './async';
import type { GoogleEvent } from './calendarGoogle';
import type { Lead } from './types';
import { googleSaleKey, saleOutcomes, validateGoogleSale, type GoogleSale } from './googleSales';
import './googleSales.css';
const localStamp = (iso: string | null | undefined) => {
  if (!iso) return '';
  const date = new Date(iso); const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const iso = (value: string) => value ? new Date(value).toISOString() : null;
export default function GoogleSaleModal({ clientId, event, sale, leads, admin, onClose, onSaved }: {
  clientId: string; event?: GoogleEvent; sale?: GoogleSale; leads: Lead[]; admin: boolean;
  onClose: () => void; onSaved: () => void;
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
  const [next, setNext] = useState(localStamp(sale?.next_action_at));
  const [value, setValue] = useState(String(sale?.contract_value || ''));
  const [cash, setCash] = useState(String(sale?.collected_amount || ''));
  const [cashAt, setCashAt] = useState(localStamp(sale?.collected_at || new Date().toISOString()));
  const [note, setNote] = useState(sale?.note || '');
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [error, setError] = useState('');
  async function save() {
    if (lock.current) return;
    if (!type) return setError('Scegli Discovery, Closing o Follow-up.');
    try {
      const payload = {
        google_key: sale?.google_key || googleSaleKey(event!), google_event_id: sale?.google_event_id || event!.id,
        title: sale?.title || event?.summary || contact, contact_name: contact.trim(),
        starts_at: iso(startsAt) || '', booked_at: sale ? sale.booked_at : event?.originalStartTime ? null : event?.created || null,
        proposal_made: outcome === 'won' || proposal, lead_id: leadId || null, appointment_type: type, revenue_type: revenueType, outcome,
        qualified: type === 'discovery' && qualified !== '' ? qualified === 'true' : null,
        next_action_at: ['follow_up', 'rescheduled'].includes(outcome) ? iso(next) : null,
        contract_value: outcome === 'won' ? Number(value) : 0,
        collected_amount: outcome === 'won' ? Number(cash) : 0,
        collected_at: outcome === 'won' && Number(cash) > 0 ? iso(cashAt) : null, note: note.trim(),
      };
      const invalid = validateGoogleSale(payload);
      if (invalid) { setError(invalid); return; }
      lock.current = true; setBusy(true); setError('');
      const result = await withTimeout(supabase.rpc('save_google_sale', {p_client_id: clientId, p_sale: payload, p_expected_version: sale?.version || 0}), 20000, 'Conferma non ricevuta. Riprova: la stessa registrazione non viene duplicata.');
      if (result.error) throw new Error(result.error.message);
      const saved = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!saved?.id) throw new Error('Il server non ha confermato il salvataggio.');
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Salvataggio non riuscito.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="calendar-modal-overlay" onClick={() => !busy && onClose()}>
    <section className="calendar-modal google-sale-modal" role="dialog" aria-modal="true" aria-label="Appuntamento di vendita Google" onClick={e => e.stopPropagation()}>
      <header className="calendar-detail-head"><span className="calendar-detail-label">Google Calendar · Vendita</span><button disabled={busy} aria-label="Chiudi vendita" onClick={onClose}>×</button></header>
      <h2>{sale ? 'Esito appuntamento' : 'Appuntamento di vendita'}</h2>
      <p>Salva questa call nei risultati commerciali. Il lead in pipeline è facoltativo; l’evento Google resta invariato.</p>
      <p className="muted">Solo i dati inseriti qui vengono condivisi nel CRM con chi è autorizzato. Le note private di Google non vengono copiate.</p>
      {error && <div className="notice err" role="alert">{error}</div>}
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={busy}>
          <label>Contatto<input required value={contact} onChange={e => setContact(e.target.value)} /></label>
          <div className="google-sale-grid">
            <label>Tipo di appuntamento<select value={type} onChange={e => setType(e.target.value as typeof type)}><option value="">Scegli il tipo</option><option value="demo">Closing / demo</option><option value="discovery">Discovery</option><option value="follow_up">Follow-up post closing</option></select></label>
            {type !== "discovery" && <label>Tipo di vendita<select value={revenueType} onChange={e => setRevenueType(e.target.value as typeof revenueType)}><option value="new">Nuovo cliente</option><option value="renewal">Rinnovo</option><option value="upsell">Upsell</option></select></label>}
          </div>

          {sale && event?.start?.dateTime && new Date(event.start.dateTime).getTime() !== new Date(sale.starts_at).getTime() && <p className="notice">La data su Google è cambiata. <button type="button" className="btn small" onClick={() => setStartsAt(localStamp(event.start?.dateTime))}>Usa il nuovo orario Google</button></p>}
          <label>Esito<select value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}>{Object.entries(saleOutcomes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
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
          <details><summary>Data, nota e collegamento alla pipeline</summary>
          <label>Data e ora della call<input type="datetime-local" required value={startsAt} onChange={e => setStartsAt(e.target.value)} /></label>
          <div className="google-sale-lead-picker">
            <label>Lead collegato · facoltativo<input type="search" placeholder="Cerca per nome, telefono o email" value={leadSearch} onChange={e => setLeadSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} /></label>
            <div className="google-sale-selected-lead">{leadId ? <><span><b>{selectedLead?.name || 'Lead collegato'}</b>{selectedLead?.phone && <small>{selectedLead.phone}</small>}</span><button type="button" className="btn small" onClick={() => setLeadId('')}>Rimuovi collegamento</button></> : <small>Nessun lead collegato. Puoi salvare anche senza.</small>}</div>
            {query && <><small role="status">{matchingLeads.length ? `${matchingLeads.length} risultati${matchingLeads.length > 50 ? ' · primi 50, precisa la ricerca' : ''}` : 'Nessun lead trovato tra quelli accessibili.'}</small><div className="google-sale-lead-results">{matchingLeads.slice(0, 50).map(lead => <button type="button" key={lead.id} aria-pressed={lead.id === leadId} onClick={() => { setLeadId(lead.id); setLeadSearch(''); }}><b>{lead.name || 'Senza nome'}</b><small>{[lead.phone, lead.email].filter(Boolean).join(' · ')}</small></button>)}</div></>}
          </div>
          <label>Nota {outcome === 'lost' ? '/ motivo' : '/ prossimo passo'}<textarea rows={3} maxLength={5000} value={note} onChange={e => setNote(e.target.value)} /></label>
                  </details>
        </fieldset>
        <footer><button type="button" className="btn" disabled={busy} onClick={onClose}>Annulla</button><button className="btn primary" disabled={busy}>{busy ? 'Salvataggio…' : 'Salva nei risultati'}</button></footer>
      </form>
    </section>
  </div>;
}
