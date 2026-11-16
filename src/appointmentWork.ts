import { supabase } from "./supabaseClient";
import type { SalesTask } from "./types";

export function awaitingOutcome(task: SalesTask, now = Date.now()) {
  return Boolean(task.appointment_type && !task.completed_at &&
    (!task.appointment_status || task.appointment_status === "scheduled" || task.appointment_status === "rescheduled") &&
    Date.parse(task.due_at) <= now);
}

export async function loadAppointmentRows(clientId: string, mode: "pending" | "standalone") {
  const tasks: SalesTask[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = supabase.from("sales_tasks").select("*").eq("client_id", clientId).not("appointment_type", "is", null);
    query = mode === "pending"
      ? query.is("completed_at", null).lte("due_at", new Date().toISOString())
      : query.eq("commercial_tracked", true).is("lead_id", null);
    const { data, error } = await query.order("due_at").order("id").range(offset, offset + 499);
    if (error) throw new Error(error.message);
    tasks.push(...data as SalesTask[]);
    if (data.length < 500) break;
  }
  return mode === "pending" ? tasks.filter(task => awaitingOutcome(task)) : tasks;
}
