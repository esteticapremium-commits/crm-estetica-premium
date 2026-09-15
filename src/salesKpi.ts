import type { LeadActivity } from "./types";

export type SalesEventType =
  | "outreach_sent"
  | "outreach_reply"
  | "follow_up"
  | "discovery_call"
  | "discovery_booked"
  | "demo_booked"
  | "demo_call"
  | "proposal_sent"
  | "sale_outcome";

export type SalesChannel = "instantly" | "dm" | "phone" | "video_call" | "other";

export const EVENT_LABELS: Record<string, string> = {
  outreach_sent: "Outreach inviato",
  outreach_reply: "Risposta outreach",
  follow_up: "Follow-up",
  discovery_call: "Discovery telefonica",
  discovery_booked: "Discovery fissata",
  demo_booked: "Closing fissata",
  demo_call: "Closing in videochiamata",
  proposal_sent: "Proposta inviata",
  sale_outcome: "Esito vendita",
};

export const CHANNEL_LABELS: Record<string, string> = {
  instantly: "Instantly · email",
  dm: "DM",
  phone: "Telefono",
  video_call: "Videochiamata",
  other: "Altro",
};

export const OUTCOME_LABELS: Record<string, string> = {
  sent: "Inviato",
  positive: "Risposta positiva",
  neutral: "Risposta neutra",
  negative: "Risposta negativa",
  answered: "Risposto",
  no_answer: "Non risponde",
  qualified: "Svolta · in target",
  not_qualified: "Svolta · fuori target",
  held: "Svolta",
  no_show: "No-show",
  rescheduled: "Riprogrammata",
  won: "Chiuso vinto",
  lost: "Perso",
};

export type CallType = "lead" | "outbound" | "client" | "other";

export const CALL_TYPE_LABELS: Record<CallType, string> = {
  lead: "Call lead",
  outbound: "Call outbound",
  client: "Call già clienti",
  other: "Altre call",
};

export function activityTimestamp(activity: LeadActivity) {
  return activity.occurred_at || activity.created_at;
}

/** Minuto in cui è avvenuta l'azione, usato come granularità delle chiavi di
 *  deduplicazione: due clic sullo stesso esito nello stesso minuto sono lo
 *  stesso evento, un secondo tentativo reale un minuto dopo è un evento nuovo. */
export function minuteStamp(date = new Date()) {
  return date.toISOString().slice(0, 16);
}

/**
 * Chiave stabile di un'azione registrata dalla scheda lead.
 *
 * Prima qui c'era un crypto.randomUUID(), quindi l'indice univoco su
 * (client_id, event_key) non poteva mai scattare: due schede aperte sullo
 * stesso lead producevano due discovery. Con una chiave deterministica il
 * secondo salvataggio collide e viene ignorato dal database, non dall'interfaccia.
 */
export function quickActivityKey(leadId: string, eventType: string, outcome: string, at = new Date()) {
  return `quick:${leadId}:${eventType}:${outcome}:${minuteStamp(at)}`;
}

/** Stessa logica per gli incassi: stesso lead, stesso tipo, stessa data/ora e
 *  stesso importo = stesso incasso. Un secondo pagamento reale differisce
 *  sempre per importo o per momento di registrazione. */
export function revenueKey(leadId: string, revenueType: string, occurredAtIso: string, amount: number) {
  return `revenue:${leadId}:${revenueType}:${occurredAtIso.slice(0, 16)}:${amount.toFixed(2)}`;
}

/** Chiave del registro outreach manuale: una riga per data, canale,
 *  responsabile e tipo di evento. Risalvare la stessa combinazione sostituisce
 *  il valore invece di sommarlo. */
export function outreachKey(day: string, channel: string, owner: string, eventType: string) {
  return `manual:${day}:${channel}:${owner.trim().toLowerCase()}:${eventType}`;
}

export function pct(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function formatPct(value: number | null) {
  return value === null ? "—" : `${value.toLocaleString("it-IT", { maximumFractionDigits: 1 })}%`;
}

export function normalizedLeadSource(source: string | null | undefined): "instantly" | "dm" | "other" {
  const value = (source || "").trim().toLowerCase();
  // I DM vengono caricati a mano scegliendo il canale dal menu; tutto il resto
  // arriva dall'ingest automatico, che scrive sempre "Instantly".
  if (value.includes("dm") || value.includes("instagram") || value.includes("facebook") || value.includes("linkedin")) return "dm";
  // "Istantly" e simili refusi esistono già nello storico: senza questa
  // tolleranza quei lead sparirebbero da entrambi i filtri di canale.
  if (/inst?a?ntly|e?mail/.test(value)) return "instantly";
  return "other";
}

/** Tipo di chiamata suggerito dalla fase in cui si trova il lead. Resta
 *  modificabile a mano: serve solo a non far partire tutto su "Lead". */
export function defaultCallType(stageName: string | null | undefined): CallType {
  const stage = (stageName || "").trim().toUpperCase();
  if (stage === "CLOSED") return "client";
  if (stage === "SETTING") return "outbound";
  return "lead";
}

/** Un appuntamento con un lead già chiuso è un appuntamento con un cliente. */
export function defaultAudience(stageName: string | null | undefined): "lead" | "client" {
  return (stageName || "").trim().toUpperCase() === "CLOSED" ? "client" : "lead";
}
