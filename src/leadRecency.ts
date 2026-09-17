import { activityTimestamp } from "./salesKpi";
import type { Lead, LeadActivity } from "./types";

type ActivityStamp = Pick<LeadActivity, "lead_id" | "created_at" | "occurred_at">;

function validTime(value: string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/** Ultima attività commerciale per lead, indipendentemente dalla pagina dalla
 * quale è stata registrata (scheda lead, Attività o Calendario). */
export function latestActivityByLead(activities: ActivityStamp[]) {
  const latest = new Map<string, string>();
  for (const activity of activities) {
    const timestamp = activityTimestamp(activity as LeadActivity);
    if (validTime(timestamp) > validTime(latest.get(activity.lead_id))) {
      latest.set(activity.lead_id, timestamp);
    }
  }
  return latest;
}

/** Una modifica alla scheda e un'attività commerciale sono entrambe lavoro
 * reale. Usiamo sempre la più recente, senza lasciare che una vecchia attività
 * prevalga su una nota o uno spostamento di fase appena salvati. */
export function lastLeadWorkAt(lead: Pick<Lead, "id" | "created_at" | "updated_at">, latestActivity: Map<string, string>) {
  const candidates = [lead.created_at, lead.updated_at, latestActivity.get(lead.id)].filter((value): value is string => Boolean(value));
  return candidates.reduce((latest, value) => validTime(value) > validTime(latest) ? value : latest, lead.created_at);
}

export function daysSinceLeadWork(lead: Pick<Lead, "id" | "created_at" | "updated_at">, latestActivity: Map<string, string>) {
  const elapsed = Date.now() - validTime(lastLeadWorkAt(lead, latestActivity));
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}
