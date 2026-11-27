// Ciclo di vita unico dell'appuntamento commerciale.
//
// Prima esistevano tre implementazioni parallele (Calendario, scheda lead,
// Attività) che si comportavano in modo diverso: una cancellava l'evento Google
// e l'altra no, una registrava il KPI e l'altra lo lasciava orfano. Qui c'è una
// sola versione di ogni operazione, così Google Calendar, sales_tasks e
// lead_activities non possono più divergere.
import { supabase } from "./supabaseClient";
import { withTimeout } from "./async";
import { confirmOnPrimaryOwnerCalendar, confirmOwnerCalendarAttendance, createGoogleCalendarEvent, deleteGoogleCalendarEvent, ensureGoogleCalendarConnection, refreshGoogleCalendarConnection, removeStaleCrmCalendarEvent, updateGoogleCalendarEvent } from "./calendarGoogle";
import { OWNER_CALENDAR_ID } from "./calendarGoogle";
import type { Lead, SalesTask } from "./types";

export const GIOVANNI_ID = "fea14cde-316f-4519-bad0-abb9d9208df7";

export type AppointmentType = NonNullable<SalesTask["appointment_type"]>;
export const APPOINTMENT_DURATION: Record<AppointmentType, number> = { setting: 15, discovery: 30, demo: 60 };

function plannedDuration(type: AppointmentType | null | undefined, preferred?: number | null) {
  if (type === "setting" || type === "discovery") return APPOINTMENT_DURATION[type];
  return preferred || APPOINTMENT_DURATION.demo;
}

// The longer Google slot keeps a short setting call readable in the week view.
function googleAppointmentEnd(start: Date, type: AppointmentType | null | undefined, minutes: number) {
  return new Date(start.getTime() + (type === "setting" ? 30 : minutes) * 60_000).toISOString();
}

export type AppointmentAudience = "lead" | "client";
export type DiscoveryOutcome = "qualified" | "not_qualified" | "no_answer" | "no_show";
export type DemoOutcome = "held" | "won" | "lost" | "no_show";
export type SettingOutcome = "answered" | "no_answer" | "not_interested" | "no_show";
export type AppointmentOutcome = SettingOutcome | DiscoveryOutcome | DemoOutcome;

const SETTING_OUTCOMES: SettingOutcome[] = ["answered", "no_answer", "not_interested", "no_show"];
export const DISCOVERY_OUTCOMES: DiscoveryOutcome[] = ["qualified", "not_qualified", "no_answer", "no_show"];
export const DEMO_OUTCOMES: DemoOutcome[] = ["held", "won", "lost", "no_show"];
const CONFIRMATION_OUTCOMES: AppointmentOutcome[] = ["held", "no_show"];

/** Gli unici esiti ammessi per fase. Una demo non può essere "in target" e una
 *  discovery non può essere genericamente "svolta": sono due domande diverse. */
export function allowedOutcomes(type: AppointmentType | "confirmation"): AppointmentOutcome[] {
  if (type === "confirmation") return CONFIRMATION_OUTCOMES;
  return type === "setting" ? SETTING_OUTCOMES : type === "discovery" ? DISCOVERY_OUTCOMES : DEMO_OUTCOMES;
}

export function isAppointmentClosed(task: Pick<SalesTask, "appointment_status">) {
  return task.appointment_status === "held" || task.appointment_status === "no_show";
}

export function canReopenSettingForReschedule(task: Pick<SalesTask, "appointment_type" | "appointment_status" | "appointment_outcome">) {
  return task.appointment_type === "setting" && task.appointment_status === "held" && task.appointment_outcome === "answered";
}

/** Una prenotazione e un esito per ogni appuntamento, qualunque sia la pagina
 *  da cui li registri. È questa chiave, non il pulsante disabilitato, a impedire
 *  il doppio conteggio. */
export const bookingKey = (taskId: string) => `appointment:${taskId}:booked`;
export const outcomeKey = (taskId: string) => `appointment:${taskId}:outcome`;

export const APPOINTMENT_LABELS: Record<AppointmentType, string> = {
  setting: "Setting telefonico", discovery: "Discovery", demo: "Closing video",
};
export const APPOINTMENT_SHORT_LABELS: Record<AppointmentType, string> = {
  setting: "Setting", discovery: "Discovery", demo: "Closing",
};
export const CLOSING_WON_LABEL = "CHIUSO";
export const CONFIRMATION_LABEL = "Call di conferma";
export const CONFIRMATION_MINUTES = 30;
const titleLabels = [...Object.values(APPOINTMENT_LABELS), CONFIRMATION_LABEL, "Discovery telefonica", "Demo video", "Appuntamento"].join("|");
const titleLabelPattern = new RegExp(`^(?:${titleLabels})\\s*—\\s*|\\s*—\\s*(?:${titleLabels})$`, "g");
const channelFor = (type: AppointmentType) => (type === "discovery" ? "phone" : "video_call");

export function appointmentTitle(type: AppointmentType, subject: string) {
  return `${appointmentSubject({ title: subject }) || "Appuntamento"} — ${APPOINTMENT_LABELS[type]}`;
}

export function appointmentSubject(task: Pick<SalesTask, "title">) {
  return task.title.trim().replace(titleLabelPattern, "").trim();
}

export interface CreateAppointmentInput {
  clientId: string;
  lead: Lead | null;
  type: AppointmentType;
  audience: AppointmentAudience;
  subject: string;
  startsAt: Date;
  durationMinutes?: number;
  note: string;
  requestId: string;
  previousOutcomeKey?: string;
  sourceReplyId?: string;
  host?: string;
}

export interface AppointmentResult {
  ok: boolean;
  error?: string;
  /** L'operazione è riuscita ma qualcosa merita di essere detto: tipicamente
   *  l'appuntamento è nel CRM e nei KPI ma non su Google Calendar. */
  warning?: string;
  pipelineWarning?: string;
  taskId?: string;
  advancedStageId?: string;
}

async function readLeadStageAfterBooking(lead: Lead, clientId: string) {
  const { data, error } = await supabase.from("leads")
    .select("stage_id").eq("id", lead.id).eq("client_id", clientId).single();
  if (error) throw error;
  return data?.stage_id !== lead.stage_id ? data?.stage_id : undefined;
}

function isGiovanni(name?: string | null) {
  return name?.trim().toLowerCase().replace(/’/g, "'") === "giovanni d'agosta";
}

export function isGiovanniSetting(task: Pick<SalesTask, "appointment_type" | "appointment_host" | "assigned_to" | "created_by">) {
  return task.appointment_type === "setting" &&
    isGiovanni(task.appointment_host?.trim() || task.created_by?.trim() || task.assigned_to);
}

export function usesOwnerDiscoveryCalendar(task: Pick<SalesTask, "appointment_type" | "created_by">) {
  return task.appointment_type === "discovery" && isGiovanni(task.created_by);
}

export function isOwnerManagedDiscovery(task: Pick<SalesTask, "id" | "google_event_id" | "appointment_type">) {
  return task.appointment_type === "discovery" && task.google_event_id === `epd${task.id.replace(/-/g, "")}`;
}

async function manageOwnerDiscoveryCalendar(task: SalesTask, operation: "sync" | "delete") {
  const { data, error } = await withTimeout(supabase.functions.invoke("owner-discovery-calendar", {
    body: { operation, taskId: task.id, expectedUpdatedAt: operation === "delete" ? task.updated_at : undefined },
  }), 35_000);
  if (!error && data?.synced === true) return;
  const response = error?.context as Response | undefined;
  const details = await response?.json?.().catch(() => undefined);
  throw new Error(details?.error || "Google Calendar di Ettore da sincronizzare. Riprova dal Calendario.");
}

/**
 * Il CRM salva task e KPI nella stessa transazione. Google usa l'ID della
 * task, così il recupero di una sincronizzazione incerta non duplica l'evento.
 */
async function synchronizeBooking(task: SalesTask, description: string) {
  if (isOwnerManagedDiscovery(task) || (!task.google_event_id && usesOwnerDiscoveryCalendar(task))) {
    try {
      await manageOwnerDiscoveryCalendar(task, "sync");
    } catch (reason) {
      return `Prenotazione salvata nel CRM. ${reason instanceof Error ? reason.message : "Google Calendar di Ettore da sincronizzare."}`;
    }
    return;
  }
  if (task.google_event_id) return;
  const personalSetting = isGiovanniSetting(task);
  let ownerOrganizes = false;
  try {
    if (personalSetting) {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user.id !== GIOVANNI_ID) {
        return "Setting salvato nel CRM. Giovanni può sincronizzarlo dal suo Calendario.";
      }
    }
    // For setting calls, use the Google connection of the current CRM account.
    const connected = await (task.appointment_type === "setting" ? refreshGoogleCalendarConnection() : ensureGoogleCalendarConnection());
    if (!connected) return personalSetting
      ? "Setting salvato nel CRM. Collega il tuo Google Calendar e riprova dal Calendario."
      : "Prenotazione salvata nel CRM. Google Calendar da sincronizzare.";
    const start = new Date(task.due_at);
    const end = googleAppointmentEnd(start, task.appointment_type, task.duration_minutes || 60);
    const event = await createGoogleCalendarEvent({
      eventId: task.id.replace(/-/g, ""), title: task.title, start: start.toISOString(), end,
      description, attendees: personalSetting ? undefined : [OWNER_CALENDAR_ID],
      videoConference: !personalSetting,
    });
    if (!event.id) throw new Error("Identità evento mancante");
    ownerOrganizes = event.organizer?.self === true && event.organizer.email?.toLowerCase() === OWNER_CALENDAR_ID;
    if ((event.start?.dateTime && Date.parse(event.start.dateTime) !== start.getTime()) ||
      (event.end?.dateTime && Date.parse(event.end.dateTime) !== Date.parse(end))) {
      await updateGoogleCalendarEvent(event.id, { title: task.title, start: start.toISOString(), end });
    }
    const { error } = await supabase.from("sales_tasks").update({ google_event_id: event.id })
      .eq("id", task.id).eq("updated_at", task.updated_at).select("id").single();
    if (error) throw error;
  } catch {
    return "Prenotazione salvata nel CRM. Google Calendar da sincronizzare.";
  }
  if (personalSetting || Date.parse(task.due_at) <= Date.now()) return;
  const eventId = task.id.replace(/-/g, "");
  if (await confirmOnPrimaryOwnerCalendar(eventId, task.due_at).catch(() => false)) return;
  // For an organizer, the optional Google Calendar color is independent of RSVP.
  if (ownerOrganizes) return;
  try {
    if (await confirmOwnerCalendarAttendance(task.id)) return;
  } catch {
    // The appointment and its Google event are already saved.
  }
  return "Evento salvato su Google Calendar. Conferma di partecipazione del titolare da verificare.";
}

export async function bookConfirmationCall(closingId: string, requestId: string, subject: string, startsAt: Date, note: string): Promise<AppointmentResult> {
  const { data, error } = await supabase.rpc("book_confirmation_call", {
    p_id: requestId, p_closing_id: closingId, p_starts_at: startsAt.toISOString(),
    p_title: `${appointmentSubject({ title: subject })} — ${CONFIRMATION_LABEL}`, p_note: note.trim() || null,
  });
  const task = (Array.isArray(data) ? data[0] : data) as SalesTask | null;
  if (error || !task?.id) return { ok: false, error: error?.message || "Call di conferma non salvata." };
  const warning = await synchronizeBooking(task, task.description || "");
  return { ok: true, taskId: task.id, warning };
}

export async function retryAppointmentSync(task: SalesTask): Promise<AppointmentResult> {
  const warning = await synchronizeBooking(task, task.description || "");
  return { ok: !warning, error: warning, taskId: task.id };
}

export async function createAppointment(input: CreateAppointmentInput): Promise<AppointmentResult> {
  const { clientId, lead, type, audience, subject, startsAt, note } = input;
  const durationMinutes = plannedDuration(type, input.durationMinutes);
  const title = appointmentTitle(type, subject);
  const description = [lead ? `Lead: ${lead.name || "Senza nome"}` : "", lead?.phone ? `Telefono: ${lead.phone}` : "", note.trim()].filter(Boolean).join("\n");

  const { data, error } = await supabase.rpc("book_sales_appointment", {
    p_id: input.requestId, p_client_id: clientId, p_lead_id: lead?.id ?? null,
    p_type: type, p_audience: audience, p_title: title, p_due_at: startsAt.toISOString(),
    p_minutes: durationMinutes, p_description: description || null, p_note: note.trim() || null,
    p_previous_outcome_key: input.previousOutcomeKey ?? null, p_source_reply_id: input.sourceReplyId ?? null, p_host: input.host ?? null,
  });
  const task = (Array.isArray(data) ? data[0] : data) as SalesTask | null;
  if (error || !task?.id) return { ok: false, error: error?.message || "Prenotazione non confermata. Riprova." };
  let advancedStageId: string | undefined;
  let pipelineWarning: string | undefined;
  if (lead) {
    try {
      if (audience === "lead" && type !== "setting") {
        advancedStageId = await readLeadStageAfterBooking(lead, clientId);
      } else {
        const { data, error } = await supabase.from("leads").update({ next_action_date: romeDayOf(startsAt) })
          .eq("id", lead.id).eq("client_id", clientId).select("stage_id").single();
        if (error) throw error;
        if (type === "setting" && data?.stage_id !== lead.stage_id) advancedStageId = data?.stage_id;
      }
    } catch {
      pipelineWarning = "Appuntamento salvato. Verifica la fase e il prossimo passo nella scheda lead.";
    }
  }
  let warning = await synchronizeBooking(task, description);
  const previousTaskId = input.previousOutcomeKey?.match(/^appointment:([0-9a-f-]{36}):outcome$/i)?.[1];
  if (!warning && !task.google_event_id && lead && previousTaskId && startsAt.getTime() > Date.now()) {
    try {
      await removeSupersededGoogleCopies(task, lead.id, previousTaskId);
    } catch {
      warning = "Nuovo appuntamento salvato su Google Calendar. Verifica se nello stesso orario è rimasto l’evento precedente.";
    }
  }
  return { ok: true, taskId: task.id, warning, pipelineWarning, advancedStageId };
}

async function removeSupersededGoogleCopies(task: SalesTask, leadId: string, previousTaskId?: string) {
  // A historical no-show may have been moved directly on Google to the slot
  // later used for its replacement. Keep the historical CRM attempt and KPI.
  const candidates = supabase.from("sales_tasks").select("id,title,google_event_id")
    .eq("client_id", task.client_id).eq("lead_id", leadId)
    .eq("appointment_type", task.appointment_type).eq("appointment_status", "no_show")
    .lt("due_at", task.due_at).not("completed_at", "is", null)
    .not("google_event_id", "is", null);
  const { data, error } = await (previousTaskId ? candidates.eq("id", previousTaskId) : candidates.eq("title", task.title));
  if (error) throw error;
  for (const older of data ?? []) {
    if (older.id !== task.id && older.google_event_id === older.id.replace(/-/g, "") && older.google_event_id !== task.google_event_id) {
      await removeStaleCrmCalendarEvent(older.id, task.due_at, older.title);
    }
  }
}

/**
 * Sposta o rinomina un appuntamento mantenendo allineati Google Calendar,
 * la task CRM e la data pianificata nell'attività KPI.
 */
export async function updateAppointment(task: SalesTask, changes: { subject: string; startsAt: Date; note: string; durationMinutes?: number }): Promise<AppointmentResult> {
  const reopenSetting = canReopenSettingForReschedule(task);
  if (!reopenSetting && (isAppointmentClosed(task) || task.completed_at)) return { ok: false, error: "Questa call ha già un esito: non spostarla. Crea una nuova prenotazione per il secondo tentativo." };
  const type = (task.appointment_type as AppointmentType | null) || null;
  const title = type ? appointmentTitle(type, changes.subject) : task.confirmation_for
    ? `${appointmentSubject({ title: changes.subject })} — ${CONFIRMATION_LABEL}` : changes.subject.trim();
  const minutes = task.confirmation_for ? CONFIRMATION_MINUTES : plannedDuration(type, changes.durationMinutes ?? task.duration_minutes);
  const updated = await supabase.rpc(reopenSetting ? "reopen_and_reschedule_setting" : "reschedule_crm_appointment", {
    p_task_id: task.id, p_expected_updated_at: task.updated_at,
    p_title: title, p_starts_at: changes.startsAt.toISOString(),
    p_note: changes.note.trim() || null, p_duration_minutes: minutes,
  });
  if (updated.error) return { ok: false, error: "Modifica non salvata: " + updated.error.message };
  // Google si aggiorna dopo il CRM: se fallisce, prenotazione e storico restano coerenti.
  let googleWarning: string | undefined;
  if (isOwnerManagedDiscovery(task) || (!task.google_event_id && usesOwnerDiscoveryCalendar(task))) {
    try {
      await manageOwnerDiscoveryCalendar(task, "sync");
    } catch (reason) {
      googleWarning = `Appuntamento spostato nel CRM. ${reason instanceof Error ? reason.message : "Google Calendar di Ettore da sincronizzare."}`;
    }
  } else if (task.google_event_id) {
    try {
      const note = changes.note.trim();
      await updateGoogleCalendarEvent(task.google_event_id, {
        title, start: changes.startsAt.toISOString(), end: googleAppointmentEnd(changes.startsAt, type, minutes),
        description: note === (task.description || "") ? undefined : note,
      });
    } catch {
      googleWarning = "Appuntamento spostato nel CRM. Google Calendar non ha accettato la modifica: verifica il collegamento e i permessi sul calendario che ha creato l’evento.";
    }
    if (!googleWarning && Date.parse(task.due_at) !== changes.startsAt.getTime()) {
      await confirmOnPrimaryOwnerCalendar(task.google_event_id, changes.startsAt.toISOString()).catch(() => false);
      if (type === "demo" && task.lead_id) {
        try {
          await removeSupersededGoogleCopies(task, task.lead_id);
        } catch {
          googleWarning = "Appuntamento spostato su Google Calendar. Verifica se nel vecchio orario è rimasta una call precedente.";
        }
      }
    }
  } else {
    googleWarning = "Appuntamento spostato nel CRM. Non era collegato a Google Calendar, quindi lì non cambia nulla.";
  }
  return { ok: true, taskId: task.id, warning: googleWarning };
}

/**
 * Elimina l'appuntamento ovunque sia stato registrato.
 * Prima cancellare da Attività lasciava il KPI a bilancio e l'evento su Google:
 * le demo fissate restavano contate anche dopo l'annullamento.
 */
export async function deleteAppointment(task: SalesTask): Promise<AppointmentResult> {
  const managed = isOwnerManagedDiscovery(task);
  if (managed) {
    try {
      await manageOwnerDiscoveryCalendar(task, "delete");
    } catch (reason) {
      return { ok: false, error: reason instanceof Error ? reason.message : "Google Calendar di Ettore non ha eliminato l’appuntamento." };
    }
  }
  const deleted = await supabase.from("sales_tasks").delete().eq("id", task.id);
  if (deleted.error) return { ok: false, error: "Attività non eliminata: " + deleted.error.message };

  // Prenotazione, esito e spostamenti appartengono alla stessa task: quando
  // l'appuntamento viene eliminato non devono restare KPI o storico orfani.
  await supabase.from("lead_activities").delete()
    .eq("client_id", task.client_id).contains("details", { task_id: task.id });
  if (!managed) await rollbackGoogle(task.google_event_id || null);

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
 * lead. Il database salva esito e KPI insieme e rifiuta le revisioni superate.
 */
export async function recordAppointmentOutcome(
  task: SalesTask,
  outcome: AppointmentOutcome,
  actualMinutes?: number,
  note?: string,
  proposalMade?: boolean,
  lostLeadStageId?: string,
): Promise<AppointmentResult> {
  const outcomeParams = { p_id: task.id, p_expected_updated_at: task.updated_at, p_outcome: outcome };
  const { data, error } = task.confirmation_for
    ? lostLeadStageId
      ? await supabase.rpc("save_confirmation_call_outcome_and_close_lead", { ...outcomeParams, p_expected_stage_id: lostLeadStageId })
      : await supabase.rpc("save_confirmation_call_outcome", outcomeParams)
    : await supabase.rpc("save_sales_appointment_outcome", {
        ...outcomeParams, p_minutes: actualMinutes ?? null,
        p_note: note?.trim() ?? null, p_proposal_made: proposalMade ?? null,
      });
  const saved = Array.isArray(data) ? data[0] : data;
  if (error || saved?.id !== task.id) return { ok: false, error: error?.message || "Esito non confermato. Riprova." };
  return { ok: true, taskId: task.id };
}

/** Storico completo degli appuntamenti del lead, inclusi esiti già chiusi:
 *  la scheda deve mostrarli prima di permettere una nuova prenotazione. */
export async function leadAppointments(clientId: string, leadId: string) {
  const { data, error } = await supabase.from("sales_tasks").select("*")
    .eq("client_id", clientId).eq("lead_id", leadId)
    .not("appointment_type", "is", null)
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data as SalesTask[]) || [];
}

async function rollbackGoogle(googleEventId: string | null) {
  if (!googleEventId) return;
  try { await deleteGoogleCalendarEvent(googleEventId); } catch { /* rollback best effort: l'errore principale resta quello del CRM */ }
}

const romeDayOf = (date: Date) => date.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
