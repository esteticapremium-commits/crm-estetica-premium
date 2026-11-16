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
import { topLeadPosition } from "./leadPosition";
import type { Lead, SalesTask } from "./types";

export type AppointmentType = NonNullable<SalesTask["appointment_type"]>;
export const APPOINTMENT_DURATION: Record<AppointmentType, number> = { setting: 15, discovery: 30, demo: 60 };

// The longer Google slot keeps a short setting call readable in the week view.
function googleAppointmentEnd(start: Date, type: AppointmentType | null | undefined, minutes: number) {
  return new Date(start.getTime() + (type === "setting" ? 30 : minutes) * 60_000).toISOString();
}

export type AppointmentAudience = "lead" | "client";
export type DiscoveryOutcome = "qualified" | "not_qualified" | "no_answer";
export type DemoOutcome = "held" | "no_show";
export type SettingOutcome = "answered" | "no_answer" | "not_interested";
export type AppointmentOutcome = SettingOutcome | DiscoveryOutcome | DemoOutcome;

const SETTING_OUTCOMES: SettingOutcome[] = ["answered", "no_answer", "not_interested"];
export const DISCOVERY_OUTCOMES: DiscoveryOutcome[] = ["qualified", "not_qualified", "no_answer"];
export const DEMO_OUTCOMES: DemoOutcome[] = ["held", "no_show"];

/** Gli unici esiti ammessi per fase. Una demo non può essere "in target" e una
 *  discovery non può essere genericamente "svolta": sono due domande diverse. */
export function allowedOutcomes(type: AppointmentType): AppointmentOutcome[] {
  return type === "setting" ? SETTING_OUTCOMES : type === "discovery" ? DISCOVERY_OUTCOMES : DEMO_OUTCOMES;
}

export function isAppointmentClosed(task: Pick<SalesTask, "appointment_status">) {
  return task.appointment_status === "held" || task.appointment_status === "no_show";
}

/** Una prenotazione e un esito per ogni appuntamento, qualunque sia la pagina
 *  da cui li registri. È questa chiave, non il pulsante disabilitato, a impedire
 *  il doppio conteggio. */
export const bookingKey = (taskId: string) => `appointment:${taskId}:booked`;
export const outcomeKey = (taskId: string) => `appointment:${taskId}:outcome`;

export const APPOINTMENT_LABELS: Record<AppointmentType, string> = {
  setting: "Setting telefonico", discovery: "Discovery telefonica", demo: "Closing video",
};
export const APPOINTMENT_SHORT_LABELS: Record<AppointmentType, string> = {
  setting: "Setting", discovery: "Discovery", demo: "Closing",
};
const channelFor = (type: AppointmentType) => (type === "discovery" ? "phone" : "video_call");

/** Il titolo conserva sempre il prefisso della fase: il Calendario lo usa per
 *  riconoscere l'evento e il venditore per leggerlo a colpo d'occhio. */
export function appointmentTitle(type: AppointmentType, subject: string) {
  const clean = subject.replace(/^(Setting telefonico|Discovery telefonica|Closing video|Demo video|Appuntamento)\s*—\s*/, "").trim();
  return `${APPOINTMENT_LABELS[type]} — ${clean || "Appuntamento"}`;
}

export function appointmentSubject(task: Pick<SalesTask, "title">) {
  return task.title.replace(/^(Setting telefonico|Discovery telefonica|Closing video|Demo video|Appuntamento)\s*—\s*/, "");
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

const stagesBeforeDiscovery = new Set(["SETTING", "RECALL", "NO ANSWER", "NO ANSWER 1-3", "NO ANSWER 4-5"]);

async function updateLeadAfterBooking(lead: Lead, clientId: string, startsAt: Date, targetType?: AppointmentType) {
  const nextAction = { next_action_date: romeDayOf(startsAt) };
  if (targetType && targetType !== "setting") {
    const { data: current, error: leadError } = await supabase.from("leads")
      .select("pipeline_id,stage_id").eq("id", lead.id).eq("client_id", clientId).single();
    if (leadError) throw leadError;
    if (current.pipeline_id) {
      const { data: stages, error: stageError } = await supabase.from("stages")
        .select("id,name").eq("client_id", clientId).eq("pipeline_id", current.pipeline_id);
      if (stageError) throw stageError;
      const currentStage = stages.find(stage => stage.id === current.stage_id)?.name.trim().toUpperCase();
      const targetName = targetType === "discovery" ? "DISCOVERY" : "CLOSING";
      const canAdvance = currentStage && (targetType === "discovery" ? stagesBeforeDiscovery.has(currentStage) : currentStage === "DISCOVERY");
      if (canAdvance) {
        const target = stages.find(stage => stage.name.trim().toUpperCase() === targetName);
        if (!target) throw new Error(`La colonna ${targetName} non è presente in questa pipeline.`);
        const position = await topLeadPosition(supabase, clientId, current.pipeline_id, target.id);
        // Preserve a simultaneous change by another user. The stage trigger records the move.
        const { data: moved, error } = await supabase.from("leads")
          .update({ ...nextAction, stage_id: target.id, position })
          .eq("id", lead.id).eq("client_id", clientId)
          .eq("pipeline_id", current.pipeline_id).eq("stage_id", current.stage_id)
          .select("id").maybeSingle();
        if (error) throw error;
        if (!moved) throw new Error("La fase del lead è cambiata durante il salvataggio. Controlla la scheda.");
        return target.id;
      }
    }
  }
  const { error } = await supabase.from("leads").update(nextAction).eq("id", lead.id).eq("client_id", clientId);
  if (error) throw error;
}

/**
 * Il CRM salva task e KPI nella stessa transazione. Google usa l'ID della
 * task, così il recupero di una sincronizzazione incerta non duplica l'evento.
 */
async function synchronizeBooking(task: SalesTask, description: string) {
  if (task.google_event_id) return;
  try {
    if (!await ensureGoogleCalendarConnection()) throw new Error("Google scollegato");
    const start = new Date(task.due_at);
    const end = googleAppointmentEnd(start, task.appointment_type, task.duration_minutes || 60);
    const event = await createGoogleCalendarEvent({
      eventId: task.id.replace(/-/g, ""), title: task.title, start: start.toISOString(), end,
      description, attendees: [OWNER_CALENDAR_ID],
    });
    if (!event.id) throw new Error("Identità evento mancante");
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
}

export async function retryAppointmentSync(task: SalesTask): Promise<AppointmentResult> {
  const warning = await synchronizeBooking(task, task.description || "");
  return { ok: !warning, error: warning, taskId: task.id };
}

export async function createAppointment(input: CreateAppointmentInput): Promise<AppointmentResult> {
  const { clientId, lead, type, audience, subject, startsAt, durationMinutes = APPOINTMENT_DURATION[type], note } = input;
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
      advancedStageId = await updateLeadAfterBooking(lead, clientId, startsAt, audience === "lead" ? type : undefined);
    } catch {
      pipelineWarning = "Appuntamento salvato. Verifica la fase e il prossimo passo nella scheda lead.";
    }
  }
  const warning = await synchronizeBooking(task, description);
  return { ok: true, taskId: task.id, warning, pipelineWarning, advancedStageId };
}

/**
 * Sposta o rinomina un appuntamento mantenendo allineati Google Calendar,
 * la task CRM e la data pianificata nell'attività KPI.
 */
export async function updateAppointment(task: SalesTask, changes: { subject: string; startsAt: Date; note: string; durationMinutes?: number }): Promise<AppointmentResult> {
  if (isAppointmentClosed(task) || task.completed_at) return { ok: false, error: "Questa call ha già un esito: non spostarla. Crea una nuova prenotazione per il secondo tentativo." };
  const type = (task.appointment_type as AppointmentType | null) || null;
  const title = type ? appointmentTitle(type, changes.subject) : changes.subject.trim();
  const minutes = changes.durationMinutes || task.duration_minutes || 60;
  const updated = await supabase.rpc("reschedule_crm_appointment", {
    p_task_id: task.id, p_expected_updated_at: task.updated_at,
    p_title: title, p_starts_at: changes.startsAt.toISOString(),
    p_note: changes.note.trim() || null, p_duration_minutes: minutes,
  });
  if (updated.error) return { ok: false, error: "Modifica non salvata: " + updated.error.message };
  // Google si aggiorna dopo il CRM: se fallisce, prenotazione e storico restano coerenti.
  let googleWarning: string | undefined;
  if (task.google_event_id) {
    try {
      const note = changes.note.trim();
      await updateGoogleCalendarEvent(task.google_event_id, {
        title, start: changes.startsAt.toISOString(), end: googleAppointmentEnd(changes.startsAt, type, minutes),
        description: note === (task.description || "") ? undefined : note,
      });
    } catch {
      googleWarning = "Appuntamento spostato nel CRM. Google Calendar non ha accettato la modifica: verifica il collegamento e i permessi sul calendario che ha creato l’evento.";
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
  const deleted = await supabase.from("sales_tasks").delete().eq("id", task.id);
  if (deleted.error) return { ok: false, error: "Attività non eliminata: " + deleted.error.message };

  // Prenotazione, esito e spostamenti appartengono alla stessa task: quando
  // l'appuntamento viene eliminato non devono restare KPI o storico orfani.
  await supabase.from("lead_activities").delete()
    .eq("client_id", task.client_id).contains("details", { task_id: task.id });
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
 * lead. Il database salva esito e KPI insieme e rifiuta le revisioni superate.
 */
export async function recordAppointmentOutcome(
  task: SalesTask,
  outcome: AppointmentOutcome,
  actualMinutes?: number,
  note?: string,
  proposalMade?: boolean,
): Promise<AppointmentResult> {
  const { data, error } = await supabase.rpc("save_sales_appointment_outcome", {
    p_id: task.id, p_expected_updated_at: task.updated_at, p_outcome: outcome,
    p_minutes: actualMinutes ?? null, p_note: note?.trim() ?? null, p_proposal_made: proposalMade ?? null,
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
