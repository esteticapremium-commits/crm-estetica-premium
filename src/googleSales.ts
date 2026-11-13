import type { GoogleEvent } from './calendarGoogle';

export type GoogleSaleOutcome = 'excluded' | 'pending' | 'won' | 'follow_up' | 'lost' | 'no_show' | 'rescheduled';
export interface GoogleSale {
  id: string; client_id: string; owner_id: string; assigned_to: string;
  google_key: string; google_event_id: string; title: string; contact_name: string;
  starts_at: string; booked_at: string | null; lead_id: string | null;
  appointment_type: 'discovery' | 'demo'; revenue_type: 'new' | 'renewal' | 'upsell';
  outcome: GoogleSaleOutcome; proposal_made: boolean; qualified: boolean | null; next_action_at: string | null;
  contract_value: number; collected_amount: number; collected_at: string | null;
  note: string; version: number;
}
export const saleOutcomes: Record<GoogleSaleOutcome, string> = {
  excluded: 'Escludi dai risultati', pending: 'Da completare', won: 'Vendita conclusa', follow_up: 'Da ricontattare',
  lost: 'Non acquistato', no_show: 'Non presentato', rescheduled: 'Rimandato',
};
/** iCalUID identifies copies in different calendars; recurring instances need their original date. */
export function googleSaleKey(event: GoogleEvent) {
  const occurrence = event.originalStartTime?.dateTime || event.originalStartTime?.date || '';
  return `${event.iCalUID || event.id}|${occurrence}`;
}
export function isGoogleRevenue(key?: string | null) { return Boolean(key?.startsWith('google-sale:')); }
export function saleHeld(sale: GoogleSale) { return ['won', 'follow_up', 'lost'].includes(sale.outcome); }
export function saleNeedsAction(sale: GoogleSale, now = new Date()) {
  return (sale.outcome === 'pending' && new Date(sale.starts_at) <= now) ||
    (['follow_up', 'rescheduled'].includes(sale.outcome) && !!sale.next_action_at && new Date(sale.next_action_at) <= now);
}
export function validateGoogleSale(sale: Pick<GoogleSale, 'contact_name' | 'starts_at' | 'outcome' | 'next_action_at' | 'contract_value' | 'collected_amount' | 'collected_at' | 'appointment_type' | 'qualified'>, now = new Date()) {
  if (!sale.contact_name.trim()) return 'Inserisci il nome del contatto.';
  if (!Number.isFinite(Date.parse(sale.starts_at))) return 'Data appuntamento non valida.';
  if (!['pending','excluded'].includes(sale.outcome) && new Date(sale.starts_at) > now) return 'Puoi registrare un esito dopo l’inizio dell’appuntamento.';
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
  const prefix = sale.appointment_type === 'discovery' ? 'discovery' : sale.revenue_type === 'new' ? 'demo' : 'demoClient';
  if (sale.booked_at && romeDay(sale.booked_at) === day) add(`${prefix}Booked`);
  if (romeDay(sale.starts_at) !== day) return result;
  if (sale.outcome !== 'rescheduled' && new Date(sale.starts_at) <= now) add(`${prefix}Scheduled`);
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
