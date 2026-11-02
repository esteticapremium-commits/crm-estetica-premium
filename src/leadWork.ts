import type { Lead, SalesTask } from "./types";
import { romeDay } from "./dates";
export function nextSteps(tasks: SalesTask[]) {
  const result = new Map<string, SalesTask>();
  for (const task of tasks) {
    if (!task.lead_id || task.completed_at || ["cancelled", "held", "no_show"].includes(task.appointment_status || "")) continue;
    const current = result.get(task.lead_id);
    if (!current || task.due_at < current.due_at) result.set(task.lead_id, task);
  }
  return result;
}
export type WorkFilter = "all" | "today" | "overdue" | "missing";
export function matchesWork(lead: Lead, tasks: SalesTask[], filter: WorkFilter, today: string, closed: boolean) {
  if (filter === "all") return true;
  if (closed) return false;
  const pending = tasks.filter(t => t.lead_id === lead.id && !t.completed_at && !["cancelled", "held", "no_show"].includes(t.appointment_status || ""));
  if (filter === "missing") return !pending.length && !lead.next_action_date;
  const callbacks = pending.filter(t => !t.appointment_type);
  const dates = callbacks.map(t => romeDay(t.due_at));
  if (!pending.length && lead.next_action_date) dates.push(lead.next_action_date);
  return dates.some(day => filter === "today" ? day === today : day < today);
}
