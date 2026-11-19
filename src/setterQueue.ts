import { romeDay } from "./dates";

export const setterColumns = [
  ["new", "Da contattare"],
  ["follow_up", "Da richiamare"],
  ["booked", "Discovery fissate"],
  ["not_interested", "Non interessati"],
] as const;

export type SetterStage = typeof setterColumns[number][0];
export type SetterQueueFilter = "all" | "new" | "today" | "overdue" | "priority";

type QueueEntry = {
  state: SetterStage;
  callback_at: string | null;
  discovery_at: string | null;
  discovery_status: string | null;
};

export function matchesSetterQueue(entry: QueueEntry, filter: SetterQueueFilter, today: string, now: number) {
  if (filter === "all" || filter === "priority") return true;
  if (filter === "new") return entry.state === "new";
  if (entry.state !== "follow_up" || !entry.callback_at) return false;
  return filter === "today" ? romeDay(entry.callback_at) === today : Date.parse(entry.callback_at) < now;
}

export function summarizeSetterQueue(queue: QueueEntry[], today: string, now: number) {
  const stages = { new: 0, follow_up: 0, booked: 0, not_interested: 0 };
  let overdue = 0;
  let todayCallbacks = 0;
  let nextDiscovery: string | null = null;
  for (const entry of queue) {
    stages[entry.state] += 1;
    if (matchesSetterQueue(entry, "overdue", today, now)) overdue += 1;
    if (matchesSetterQueue(entry, "today", today, now)) todayCallbacks += 1;
    if (entry.state === "booked" && entry.discovery_at && Date.parse(entry.discovery_at) >= now
      && (!entry.discovery_status || ["scheduled", "rescheduled"].includes(entry.discovery_status))
      && (!nextDiscovery || Date.parse(entry.discovery_at) < Date.parse(nextDiscovery))) {
      nextDiscovery = entry.discovery_at;
    }
  }
  return { stages, overdue, todayCallbacks, nextDiscovery };
}

export function setterWorkQueue<T extends QueueEntry>(queue: T[], today: string, now: number) {
  const overdue: T[] = [];
  const todayCallbacks: T[] = [];
  const newLeads: T[] = [];
  for (const lead of queue) {
    if (lead.state === "new") newLeads.push(lead);
    else if (matchesSetterQueue(lead, "overdue", today, now)) overdue.push(lead);
    else if (matchesSetterQueue(lead, "today", today, now)) todayCallbacks.push(lead);
  }
  const byCallback = (a: T, b: T) => Date.parse(a.callback_at!) - Date.parse(b.callback_at!);
  return { overdue: overdue.sort(byCallback), todayCallbacks: todayCallbacks.sort(byCallback), newLeads };
}
