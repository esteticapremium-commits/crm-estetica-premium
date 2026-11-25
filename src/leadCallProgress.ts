import { saleHeld, saleOutcomes, type GoogleSale } from "./googleSales";
import { nextSteps } from "./leadWork";
import type { LeadActivity, SalesTask } from "./types";

type CallType = NonNullable<SalesTask["appointment_type"]>;
export type LeadCallActivity = Pick<LeadActivity, "lead_id" | "event_type" | "outcome" | "occurred_at" | "scheduled_at" | "created_at">;
export type LeadGoogleCall = Pick<GoogleSale, "lead_id" | "appointment_type" | "outcome" | "qualified" | "starts_at">;
export type CardCallOutcome = { type: CallType; at: string; label: string; missed: boolean };
export type CardNextStep = { type: CallType | null; at: string; priority: boolean; host?: string | null };
export type LeadCallProgress = { outcome?: CardCallOutcome; step?: CardNextStep };

const activityTypes: Readonly<Record<string, CallType>> = {
  setting_call: "setting", discovery_call: "discovery", demo_call: "demo",
};
export const leadCallEventTypes = Object.keys(activityTypes);

const outcomeLabels: Readonly<Record<string, string>> = {
  answered: "Svolta", held: "Svolta", qualified: "Svolta · In target", not_qualified: "Svolta · Fuori target",
  not_interested: "Svolta · Non interessato", no_answer: "Non risponde", no_show: "No-show",
  not_available_now: "Non disponibile ora",
  lost: "Offerta rifiutata",
};

function callKey(leadId: string, type: CallType, at: string) {
  return `${leadId}:${type}:${Math.floor(Date.parse(at) / 60_000)}`;
}

export function leadCallProgress(activities: LeadCallActivity[], googleCalls: LeadGoogleCall[], tasks: SalesTask[]) {
  const byLead = new Map<string, LeadCallProgress>();
  const resolved = new Set<string>();

  function record(leadId: string, outcome: CardCallOutcome, appointmentAt = outcome.at) {
    if (!Number.isFinite(Date.parse(outcome.at))) return;
    resolved.add(callKey(leadId, outcome.type, appointmentAt));
    const entry = byLead.get(leadId) ?? {};
    if (!entry.outcome || Date.parse(outcome.at) > Date.parse(entry.outcome.at)) entry.outcome = outcome;
    byLead.set(leadId, entry);
  }

  function selectStep(leadId: string, step: CardNextStep) {
    if (!Number.isFinite(Date.parse(step.at))) return;
    const entry = byLead.get(leadId) ?? {};
    if (!entry.step || Date.parse(step.at) < Date.parse(entry.step.at)) entry.step = step;
    byLead.set(leadId, entry);
  }

  for (const activity of activities) {
    const type = activityTypes[activity.event_type ?? ""];
    const outcome = activity.outcome ?? "";
    const label = outcomeLabels[outcome];
    if (!type || !label) continue;
    record(activity.lead_id, {
      type, label, at: activity.occurred_at || activity.scheduled_at || activity.created_at,
      missed: outcome === "no_show" || outcome === "no_answer",
    }, activity.scheduled_at || undefined);
  }

  for (const sale of googleCalls) {
    if (!sale.lead_id || sale.appointment_type === "follow_up") continue;
    if (sale.outcome === "no_show") {
      record(sale.lead_id, { type: sale.appointment_type, at: sale.starts_at, label: "No-show", missed: true });
    } else if (saleHeld(sale)) {
      const qualification = sale.appointment_type === "discovery" && sale.qualified !== null
        ? (sale.qualified ? " · In target" : " · Fuori target") : "";
      record(sale.lead_id, { type: sale.appointment_type, at: sale.starts_at,
        label: `Svolta · ${saleOutcomes[sale.outcome]}${qualification}`, missed: false });
    }
  }

  const unresolvedTasks = tasks.filter(task => !task.lead_id || !task.appointment_type ||
    !resolved.has(callKey(task.lead_id, task.appointment_type, task.due_at)));
  for (const [leadId, task] of nextSteps(unresolvedTasks)) {
    selectStep(leadId, { type: task.appointment_type ?? null, at: task.due_at, priority: task.is_priority,
      host: task.appointment_type === "setting" ? task.appointment_host || task.created_by || task.assigned_to : null });
  }
  for (const sale of googleCalls) {
    if (!sale.lead_id || sale.appointment_type === "follow_up" || sale.outcome !== "pending" ||
      resolved.has(callKey(sale.lead_id, sale.appointment_type, sale.starts_at))) continue;
    selectStep(sale.lead_id, { type: sale.appointment_type, at: sale.starts_at, priority: false });
  }
  return byLead;
}
