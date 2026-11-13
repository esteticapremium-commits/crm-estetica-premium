export type Step = { channel: 'email' | 'whatsapp'; delay_days: number; subject: string; body: string; template: string; language: string };
export function validateSteps(steps: Step[]) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('Inserisci da 1 a 100 passaggi.');
  for (const s of steps) {
    if (!['email', 'whatsapp'].includes(s.channel) || !Number.isInteger(s.delay_days) || s.delay_days < 0 || s.delay_days > 365) throw new Error('Intervallo non valido.');
    if (!s.body?.trim() || (s.channel === 'email' && !s.subject?.trim())) throw new Error('Completa il testo e l’oggetto delle email.');
    if (s.channel === 'whatsapp' && !/^[a-z0-9_]+$/.test(s.template)) throw new Error('Indica il nome del modello Meta approvato.');
    if (s.channel === 'whatsapp' && !/^[a-z]{2}(_[A-Z]{2})?$/.test(s.language)) throw new Error('Indica la lingua del modello WhatsApp.');
    if ((s.body + (s.subject||'')).replace(/{{nome\s*}}/g,'').includes('{{')) throw new Error('Segnaposto supportato: {{nome}}.');
  }
}
export function render(text: string, name: string | null) { return text.replace(/{{nome\s*}}/g, name?.trim() || ''); }
export function inSendingWindow(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(p.find(x => x.type === 'hour')?.value);
  return p.find(x => x.type === 'weekday')?.value !== 'Sun' && hour >= 9 && hour < 19;
}
export function isStop(text: string) { return /^(stop|basta|unsubscribe|disiscrivimi|non contattarmi|non interessato|non interessata)[.!\s]*$/i.test(text.trim()); }
export function normalizePhone(phone: string) { return phone.replace(/[^\d]/g, '').replace(/^00/, ''); }
