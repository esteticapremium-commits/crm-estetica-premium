// Ciclo di vita unico dell'appuntamento commerciale.
//
// Prima esistevano tre implementazioni parallele (Calendario, scheda lead,
// Attività) che si comportavano in modo diverso: una cancellava l'evento Google
// e l'altra no, una registrava il KPI e l'altra lo lasciava orfano. Qui c'è una
// sola versione di ogni operazione, così Google Calendar, sales_tasks e
// lead_activities non possono più divergere.
import { supabase } from "./supabaseClient";
import { createGoogleCalendarEvent, deleteGoogleCalendarEvent, ensureGoogleCalendarConnection, updateGoogleCalendarEvent } from "./calendarGoogle";
import { OWNER_CALENDAR_ID } from "./calendarGoogle";
import type { Lead, SalesTask } from "./types";

export type AppointmentType = "discovery" | "demo";
export type AppointmentAudience = "lead" | "client";
export type DiscoveryOutcome = "qualified" | "not_qualified" | "no_answer";
export type DemoOutcome = "held" | "no_show";
export type AppointmentOutcome = DiscoveryOutcome | DemoOutcome;

export const DISCOVERY_OUTCOMES: DiscoveryOutcome[] = ["qualified", "not_qualified", "no_answer"];
export const DEMO_OUTCOMES: DemoOutcome[] = ["held", "no_show"];

/** Gli unici esiti ammessi per fase. Una demo non può essere "in target" e una
 *  discovery non può essere genericamente "svolta": sono due domande diverse. */
export function allowedOutcomes(type: AppointmentType): AppointmentOutcome[] {
  return type === "discovery" ? DISCOVERY_OUTCOMES : DEMO_OUTCOMES;
}

export function isAppointmentClosed(task: Pick<SalesTask, "appointment_status">) {
  return task.appointment_status === "held" || task.appointment_status === "no_show";
}

/** Una prenotazione e un esito per ogni appuntamento, qualunque sia la pagina
 *  da cui li registri. È questa chiave, non il pulsante disabilitato, a impedire
 *  il doppio conteggio. */
export const bookingKey = (taskId: string) => `appointment:${taskId}:booked`;
export const outcomeKey = (taskId: string) => `appointment:${taskId}:outcome`;

const appointmentLabel = (type: AppointmentType) => (type === "discovery" ? "Discovery telefonica" : "Closing video");
const channelFor = (type: AppointmentType) => (type === "discovery" ? "phone" : "video_call");

/** Il titolo conserva sempre il prefisso della fase: il Calendario lo usa per
 *  riconoscere l'evento e il venditore per leggerlo a colpo d'occhio. */
export function appointmentTitle(type: AppointmentType, subject: string) {
  const clean = subject.replace(/^(Discovery telefonica|Closing video|Demo video|Appuntamento)\s*—\s*/, "").trim();
  return `${appointmentLabel(type)} — ${clean || "Appuntamento"}`;
}

export function appointmentSubject(task: Pick<SalesTask, "title">) {
  return task.title.replace(/^(Discovery telefonica|Closing video|Demo video|Appuntamento)\s*—\s*/, "");
}

export interface CreateAppointmentInput {
  clientId: string;
  lead: Lead | null;
  type: AppointmentType;
  audience: AppointmentAudience;
  subject: string;
  startsAt: Date;
  durationMinutes: number;
  note: string;
  meName: string;
}

export interface AppointmentResult {
  ok: boolean;
  error?: string;
  /** L'operazione è riuscita ma qualcosa merita di essere detto: tipicamente
   *  l'appuntamento è nel CRM e nei KPI ma non su Google Calendar. */
  warning?: string;
  taskId?: string;
}

/**
 * Crea in un colpo solo l'evento Google, la task CRM e l'attività KPI.
 * Se un passaggio fallisce, i precedenti vengono annullati: non resta mai un
 * appuntamento a metà, né un KPI senza appuntamento.
 */
export async function createAppointment(input: CreateAppointmentInput): Promise<AppointmentResult> {
  const { clientId, lead, type, audience, subject, startsAt, durationMinutes, note, meName } = input;
  const title = appointmentTitle(type, subject);
  const end = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const description = [lead ? `Lead: ${lead.name || "Senza nome"}` : "", lead?.phone ? `Telefono: ${lead.phone}` : "", note.trim()].filter(Boolean).join("\n");

  // Google Calendar è una comodità, non una condizione. Prima un token scaduto
  // impediva di registrare l'appuntamento: il venditore restava bloccato e il
  // KPI della giornata perdeva un dato reale per un problema di integrazione.
  // Ora l'appuntamento si salva comunque e resta segnalato come da sincronizzare.
  let googleEventId: string | null = null;
  let googleWarning: string | undefined;
  if (await ensureGoogleCalendarConnection()) {
    try {
      const event = await createGoogleCalendarEvent({ title, start: startsAt.toISOString(), end: end.toISOString(), description, attendees: [OWNER_CALENDAR_ID] });
      googleEventId = event.id || null;
    } catch {
      googleWarning = "Appuntamento salvato nel CRM e nei KPI, ma Google Calendar l'ha rifiutato. Apri Calendario, premi “Collega Google Calendar” e risincronizzalo.";
    }
  } else {
    googleWarning = "Appuntamento salvato nel CRM e nei KPI, ma non è finito su Google Calendar: il collegamento è scaduto. Apri Calendario e premi “Collega Google Calendar”.";
  }

  const taskResult = await supabase.from("sales_tasks").insert({
    client_id: clientId, lead_id: lead?.id || null, title, description: description || null,
    due_at: startsAt.toISOString(), assigned_to: lead?.assigned_to || meName || "Venditore", created_by: meName || null,
    appointment_type: type, appointment_status: "scheduled", audience, duration_minutes: durationMinutes,
    google_event_id: googleEventId,
  }).select("id").single();

  if (taskResult.error || !taskResult.data) {
    await rollbackGoogle(googleEventId);
    return { ok: false, error: "Appuntamento non salvato: " + (taskResult.error?.message || "task non creata.") };
  }
  const taskId = taskResult.data.id as string;

  if (lead) {
    const tracked = await supabase.from("lead_activities").upsert({
      lead_id: lead.id, client_id: clientId, pipeline_id: lead.pipeline_id,
      activity_type: "meeting", event_type: `${type}_booked`, channel: channelFor(type),
      call_type: audience === "client" ? "client" : "lead",
      outcome: "scheduled", occurred_at: new Date().toISOString(), scheduled_at: startsAt.toISOString(),
      duration_minutes: durationMinutes, note: note.trim() || null, created_by: meName || null,
      details: { task_id: taskId }, event_key: bookingKey(taskId),
    }, { onConflict: "client_id,event_key" });

    if (tracked.error) {
      await supabase.from("sales_tasks").delete().eq("id", taskId);
      await rollbackGoogle(googleEventId);
      return { ok: false, error: "Appuntamento non salvato: il KPI non è stato registrato (" + tracked.error.message + ")." };
    }
    await supabase.from("leads").update({ next_action_date: romeDayOf(startsAt) }).eq("id", lead.id);
  }
  return { ok: true, taskId, warning: googleWarning };
}

/**
 * Sposta o rinomina un appuntamento mantenendo allineati Google Calendar,
 * la task CRM e la data pianificata nell'attività KPI.
 */
export async function updateAppointment(task: SalesTask, changes: { subject: string; startsAt: Date; note: string; durationMinutes?: number }): Promise<AppointmentResult> {
  const type = (task.appointment_type as AppointmentType | null) || null;
  const title = type ? appointmentTitle(type, changes.subject) : changes.subject.trim();
  const minutes = changes.durationMinutes || task.duration_minutes || 60;
  const end = new Date(changes.startsAt.getTime() + minutes * 60_000);

  const updated = await supabase.from("sales_tasks")
    .update({ title, due_at: changes.startsAt.toISOString(), description: changes.note.trim() || null, duration_minutes: minutes })
    .eq("id", task.id);
  if (updated.error) return { ok: false, error: "Modifica non salvata: " + updated.error.message };

  // L'evento si ritrova sempre dal suo id, mai dal titolo: rinominare
  // l'appuntamento non deve far perdere il collegamento con Google.
  let googleWarning: string | undefined;
  if (task.google_event_id) {
    try {
      await updateGoogleCalendarEvent(task.google_event_id, { title, start: changes.startsAt.toISOString(), end: end.toISOString(), description: changes.note.trim() });
    } catch {
      // Lo spostamento nel CRM è già avvenuto: segnalarlo come errore farebbe
      // credere che non sia stato salvato nulla, e il venditore lo rifarebbe.
      googleWarning = "Appuntamento spostato nel CRM, ma Google Calendar non ha accettato la modifica. Apri Calendario e premi “Collega Google Calendar”.";
    }
  } else {
    googleWarning = "Appuntamento spostato nel CRM. Non era collegato a Google Calendar, quindi lì non cambia nulla.";
  }

  if (task.lead_id && type) {
    await supabase.from("lead_activities")
      .update({ scheduled_at: changes.startsAt.toISOString(), duration_minutes: minutes })
      .eq("client_id", task.client_id).eq("event_key", bookingKey(task.id));
    await supabase.from("leads").update({ next_action_date: romeDayOf(changes.startsAt) }).eq("id", task.lead_id);
  }
  return { ok: true, taskId: task.id, warning: googleWarning };
}

/**
 * Elimina l'appuntamento ovunque sia stato registrato.
 * Prima cancellare da Attività lasciava il KPI a bilancio e l'evento su Google:
 * le demo fissate restavano contate anche dopo l'annullamento.
 */
export async function deleteAppointment(task: SalesTask): Promise<AppointmentResult> {
  const deleted = await supabase.from("sales_tasks").delete().eq("id", task.id);
  if (deleted.error) return { ok: false, error: "Attività non eliminata: " + deleted.error.message };

  await supabase.from("lead_activities").delete()
    .eq("client_id", task.client_id)
    .in("event_key", [bookingKey(task.id), outcomeKey(task.id)]);
  // Lo storico precedente al tracciamento con chiave resta agganciato solo da details.
  await supabase.from("lead_activities").delete()
    .eq("client_id", task.client_id).is("event_key", null).contains("details", { task_id: task.id });
  await rollbackGoogle(task.google_event_id || null);

  if (task.lead_id) {
    const { data: nextTask } = await supabase.from("sales_tasks").select("due_at")
      .eq("lead_id", task.lead_id).is("completed_at", null).order("due_at").limit(1).maybeSingle();
    await supabase.from("leads")
      .update({ next_action_date: nextTask?.due_at ? romeDayOf(new Date(nextTask.due_at as string)) : null })
      .eq("id", task.lead_id);
  }
  return { ok: true };
}

/**
 * Registra (o corregge) l'esito di un appuntamento.
 * La chiave è legata alla task, quindi lo stesso incontro conta una volta sola
 * anche se l'esito viene registrato dal Calendario e poi corretto dalla scheda
 * lead. Se il KPI non viene salvato, la task torna "da svolgere": un
 * appuntamento non resta mai falsamente completato.
 */
export async function recordAppointmentOutcome(
  task: SalesTask,
  outcome: AppointmentOutcome,
  meName: string,
  pipelineId: string | null,
  /** Minuti effettivi della call. Senza questo dato vale la durata pianificata,
   *  ma quando il venditore la dichiara è la sua a finire in "min call". */
  actualMinutes?: number,
): Promise<AppointmentResult> {
  const type = (task.appointment_type as AppointmentType | null) || "discovery";
  if (!allowedOutcomes(type).includes(outcome)) {
    return { ok: false, error: `Esito non valido per una ${type === "discovery" ? "discovery" : "closing"}.` };
  }
  if (!task.lead_id) return { ok: false, error: "L'appuntamento non è collegato a un lead: non può produrre KPI." };

  const completedAt = new Date().toISOString();
  const status = outcome === "no_show" || outcome === "no_answer" ? "no_show" : "held";
  const previous = { appointment_status: task.appointment_status || "scheduled", completed_at: task.completed_at || null, completed_by: task.completed_by || null };

  const update = await supabase.from("sales_tasks")
    .update({ appointment_status: status, completed_at: completedAt, completed_by: meName })
    .eq("id", task.id);
  if (update.error) return { ok: false, error: "Esito non salvato: " + update.error.message };

  const tracked = await supabase.from("lead_activities").upsert({
    lead_id: task.lead_id, client_id: task.client_id, pipeline_id: pipelineId,
    activity_type: type === "discovery" ? "call" : "meeting",
    event_type: type === "discovery" ? "discovery_call" : "demo_call",
    channel: channelFor(type),
    call_type: task.audience === "client" ? "client" : "lead",
    outcome, occurred_at: completedAt, scheduled_at: task.due_at,
    duration_minutes: status === "held" ? actualMinutes || task.duration_minutes || 60 : null,
    created_by: meName || null, details: { task_id: task.id }, event_key: outcomeKey(task.id),
  }, { onConflict: "client_id,event_key" });

  if (tracked.error) {
    await supabase.from("sales_tasks").update(previous).eq("id", task.id);
    return { ok: false, error: "Esito non salvato: non è stato conteggiato nei KPI e l'appuntamento resta da svolgere. Riprova." };
  }
  return { ok: true, taskId: task.id };
}

/** Appuntamenti ancora da chiudere per un lead: servono alla scheda lead per
 *  capire se l'esito che stai registrando appartiene a un incontro già in
 *  agenda, invece di creare una seconda attività scollegata. */
export async function pendingAppointments(clientId: string, leadId: string) {
  const { data } = await supabase.from("sales_tasks").select("*")
    .eq("client_id", clientId).eq("lead_id", leadId)
    .not("appointment_type", "is", null)
    .order("due_at", { ascending: false }).limit(20);
  return ((data as SalesTask[]) || []).filter((task) => !isAppointmentClosed(task));
}

async function rollbackGoogle(googleEventId: string | null) {
  if (!googleEventId) return;
  try { await deleteGoogleCalendarEvent(googleEventId); } catch { /* rollback best effort: l'errore principale resta quello del CRM */ }
}

const romeDayOf = (date: Date) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
