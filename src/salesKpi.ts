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
  demo_booked: "Demo fissata",
  demo_call: "Demo in videochiamata",
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

export function activityTimestamp(activity: LeadActivity) {
  return activity.occurred_at || activity.created_at;
}

export function pct(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function formatPct(value: number | null) {
  return value === null ? "—" : `${value.toLocaleString("it-IT", { maximumFractionDigits: 1 })}%`;
}

export function normalizedLeadSource(source: string | null | undefined): "instantly" | "dm" | "other" {
  const value = (source || "").trim().toLowerCase();
  if (value.includes("instantly") || value.includes("email") || value.includes("mail")) return "instantly";
  if (value.includes("dm") || value.includes("instagram") || value.includes("facebook") || value.includes("linkedin")) return "dm";
  return "other";
}
