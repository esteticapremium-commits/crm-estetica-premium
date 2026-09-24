import type { Lead, LeadActivity, SalesTask } from "./types";

type ActivityStamp = Pick<LeadActivity, "lead_id" | "created_at" | "occurred_at">;
type CompletedTaskStamp = Pick<SalesTask, "lead_id" | "completed_at">;

function validTime(value: string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/** Per l'inattività conta anche quando l'esito è stato registrato: una call
 * svolta giorni fa ma compilata oggi non deve lasciare il lead "fermo".
 * Anche completare una task collegata al lead è lavoro, senza creare una
 * chiamata KPI. I KPI continuano a usare occurred_at, cioè il giorno reale. */
export function latestActivityByLead(activities: ActivityStamp[], completedTasks: CompletedTaskStamp[] = []) {
  const latest = new Map<string, string>();
  for (const activity of activities) {
    const timestamp = activity.occurred_at && validTime(activity.occurred_at) > validTime(activity.created_at)
      ? activity.occurred_at
      : activity.created_at;
    if (validTime(timestamp) > validTime(latest.get(activity.lead_id))) {
      latest.set(activity.lead_id, timestamp);
    }
  }
  for (const task of completedTasks) {
    if (task.lead_id && task.completed_at && validTime(task.completed_at) > validTime(latest.get(task.lead_id))) {
      latest.set(task.lead_id, task.completed_at);
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
