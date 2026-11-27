import type { GoogleEvent } from './calendarGoogle';

export type GoogleSaleOutcome = 'excluded' | 'pending' | 'won' | 'follow_up' | 'lost' | 'no_show' | 'rescheduled' | 'closing_booked';
export interface GoogleSale {
  id: string; client_id: string; owner_id: string; assigned_to: string;
  google_key: string; google_event_id: string; title: string; contact_name: string;
  starts_at: string; booked_at: string | null; lead_id: string | null;
  appointment_type: 'discovery' | 'demo' | 'follow_up'; revenue_type: 'new' | 'renewal' | 'upsell';
  outcome: GoogleSaleOutcome; early_no_show?: boolean; proposal_made: boolean; qualified: boolean | null; next_action_at: string | null;
  closing_reference?: string | null;
  contract_value: number; collected_amount: number; collected_at: string | null;
  note: string; version: number;
}
export const saleOutcomes: Record<GoogleSaleOutcome, string> = {
  excluded: 'Escludi dai risultati', pending: 'Da completare', won: 'Vendita conclusa', follow_up: 'Da ricontattare',
  lost: 'Non acquistato', no_show: 'Non presentato', rescheduled: 'Rimandato',
  closing_booked: 'Closing prenotata',
};
/** iCalUID identifies copies in different calendars; recurring instances need their original date. */
export function googleSaleKey(event: GoogleEvent) {
  const occurrence = event.originalStartTime?.dateTime || event.originalStartTime?.date || '';
  return `${event.iCalUID || event.id}|${occurrence}`;
}
export const calendarClosingRevenueKey = (id: string) => `calendar-closing:${id}`;
export function isCalendarClosingRevenue(key?: string | null) { return Boolean(key?.startsWith('calendar-closing:')); }
export function isGoogleRevenue(key?: string | null) { return Boolean(key?.startsWith('google-sale:')); }
const heldOutcomes: GoogleSaleOutcome[] = ['won', 'follow_up', 'lost', 'closing_booked'];
export const googleSaleHistoryOutcomes: GoogleSaleOutcome[] = [...heldOutcomes, 'no_show'];
export function saleHeld(sale: Pick<GoogleSale, 'outcome'>) { return heldOutcomes.includes(sale.outcome); }
export function saleNeedsAction(sale: GoogleSale, now = new Date()) {
  return (sale.outcome === 'pending' && new Date(sale.starts_at) <= now) ||
    (['follow_up', 'rescheduled'].includes(sale.outcome) && !!sale.next_action_at && new Date(sale.next_action_at) <= now);
}
export const googleOutcomesBeforeStart: GoogleSaleOutcome[] = ['pending', 'excluded', 'no_show'];

export function validateGoogleSale(sale: Pick<GoogleSale, 'contact_name' | 'starts_at' | 'outcome' | 'next_action_at' | 'contract_value' | 'collected_amount' | 'collected_at' | 'appointment_type' | 'qualified'>, now = new Date()) {
  if (!sale.contact_name.trim()) return 'Inserisci il nome del contatto.';
  if (!Number.isFinite(Date.parse(sale.starts_at))) return 'Data appuntamento non valida.';
  if (!googleOutcomesBeforeStart.includes(sale.outcome) && new Date(sale.starts_at) > now) return 'Prima dell’orario puoi registrare solo un no-show.';
  if (sale.outcome === 'closing_booked' && (sale.appointment_type !== 'discovery' || sale.qualified !== true)) return 'Collega una Closing a una Discovery in target.';
  if (['follow_up', 'rescheduled'].includes(sale.outcome) && (!sale.next_action_at || !Number.isFinite(Date.parse(sale.next_action_at)) || new Date(sale.next_action_at) <= new Date(sale.starts_at))) return 'Scegli una data del prossimo passo successiva all’appuntamento.';
  if (![sale.contract_value, sale.collected_amount].every(n => Number.isFinite(n) && n >= 0 && n < 1e10)) return 'Gli importi devono essere numeri positivi o zero.';
  if (sale.outcome === 'won' && sale.contract_value <= 0) return 'Inserisci il valore dell’accordo.';
  if (sale.collected_amount > sale.contract_value) return 'L’incasso non può superare il valore dell’accordo.';
  if (sale.collected_amount > 0 && (!sale.collected_at || !Number.isFinite(Date.parse(sale.collected_at)) || new Date(sale.collected_at) > now)) return 'Indica la data effettiva dell’incasso, non futura.';
  if (sale.appointment_type === 'discovery' && ['won', 'follow_up', 'lost'].includes(sale.outcome) && sale.qualified === null) return 'Indica se il contatto è in target.';
  return null;
}

/** Counts only explicit outcomes. Missing outcomes never become attended calls or losses. */
export function googleSaleMetrics(sale: GoogleSale, day: string, now = new Date()) {
  const romeDay = (at: string) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
  const result: Record<string, number> = {};
  if (sale.outcome === 'excluded') return result;
  const add = (key: string) => { result[key] = (result[key] || 0) + 1; };
  const prefix = sale.appointment_type === 'follow_up' ? 'followUp' : sale.appointment_type === 'discovery' ? 'discovery' : sale.revenue_type === 'new' ? 'demo' : 'demoClient';
  if (sale.booked_at && romeDay(sale.booked_at) === day) add(`${prefix}Booked`);
  if (romeDay(sale.starts_at) !== day) return result;
  if (sale.outcome !== 'rescheduled' && (sale.outcome === 'no_show' || new Date(sale.starts_at) <= now)) add(`${prefix}Scheduled`);
  if (saleHeld(sale)) {
    add(`${prefix}Held`); add(`${prefix}HeldBooked`);
    if (sale.booked_at && romeDay(sale.booked_at) === day) add(`${prefix}SameDay`);
    if (sale.appointment_type === 'discovery' && sale.qualified) add('qualified');
    if (sale.proposal_made || sale.outcome === 'won') add('proposals');
  }
  if (sale.outcome === 'no_show') add('noShow');
  if (sale.outcome === 'won') {
    // New agreements count at the declared outcome, independently of the cash date.
    if (sale.revenue_type === 'new') { add('won'); result.contractValue = Number(sale.contract_value); }
    else add(sale.revenue_type === 'renewal' ? 'renewals' : 'upsells');
  }
  return result;
}

/** One new-customer win per linked lead, even after linking a Google sale or adding instalments. */
export function firstNewSaleIds(sales: GoogleSale[], revenue: Array<{id:string; lead_id:string|null; revenue_type:string; status:string; occurred_at:string; created_at?:string; sale_appointment_id?:string|null; event_key?:string|null}>) {
  const candidates = [
    ...sales.filter(s => s.outcome === 'won' && s.revenue_type === 'new').map(s => ({key:`google:${s.id}`,lead:s.lead_id,at:s.starts_at})),
    ...revenue.filter(r => r.revenue_type === 'new' && !isGoogleRevenue(r.event_key) && (
      (isCalendarClosingRevenue(r.event_key) && (r.status === 'collected' || (r.status === 'expected' && r.sale_appointment_id))) ||
      (r.lead_id && r.status === 'collected')
    )).map(r => ({
      key:`revenue:${r.id}`, lead:r.lead_id,
      at:isCalendarClosingRevenue(r.event_key) ? r.created_at || r.occurred_at : r.occurred_at,
    })),
  ].sort((a,b) => Date.parse(a.at)-Date.parse(b.at) || a.key.localeCompare(b.key));
  const seen=new Set<string>(); const ids=new Set<string>();
  for(const c of candidates) { if(c.lead && seen.has(c.lead)) continue; ids.add(c.key); if(c.lead)seen.add(c.lead); }
  return ids;
}
