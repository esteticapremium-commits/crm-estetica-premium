// Date di calendario in fuso Europe/Rome (il CRM è per l'Italia).
// toISOString() usa UTC: a Roma dopo le 02:00 di notte cambiava già il giorno.

/** ISO "YYYY-MM-DD" del giorno di Roma per una data/istante. */
export function romeDay(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** ISO "YYYY-MM-DD" di oggi a Roma. */
export function romeToday(): string {
  return romeDay(new Date());
}

/** Data e ora "gg/mm/aaaa hh:mm" nel fuso di Roma, per timbrare le note. */
export function romeStamp(instant: Date | string = new Date()): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(d)
    .replace(",", "");
}

/** Set dei giorni di calendario degli ultimi N giorni (oggi compreso), a Roma. */
export function romeLastDays(n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.add(romeDay(d));
  }
  return out;
}
