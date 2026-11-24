import SalesSetterHandoff from "./SalesSetterHandoff";
import { awaitingOutcome } from "../appointmentWork";
import { AppointmentOutcomeChoices, AppointmentTime } from "../AppointmentFields";
import LeadTimeline from "../LeadTimeline";
import LeadDateTimePicker from "../LeadDateTimePicker";
import { appendLeadNote } from "../leadNotes";
import { topLeadPosition } from "../leadPosition";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { withTimeout } from "../async";
import { persistRevenue } from "../revenueRegistration";
import { romeDay, romeStamp } from "../dates";
import { isPrivateDeed, normalizeSpecificApprovalSignature, openSignedContractPdf } from "../contractPdf";
import { PRIVATE_DEED_TEMPLATE, TRIAL_5K_RENEWAL_CONTRACT_TEMPLATE, TRIAL_CONTRACT_TEMPLATE } from "../defaultContractTemplates";
import { CHANNEL_LABELS, defaultAudience, defaultCallType, EVENT_LABELS, OUTCOME_LABELS, quickActivityKey, revenueKey, type CallType } from "../salesKpi";
import { APPOINTMENT_DURATION, APPOINTMENT_SHORT_LABELS, allowedOutcomes, appointmentSubject, createAppointment, isAppointmentClosed, leadAppointments, outcomeKey, recordAppointmentOutcome, updateAppointment, type AppointmentAudience, type AppointmentOutcome, type AppointmentType } from "../appointments";
import type { Contract, ContractTemplate, Lead, LeadActivity, Pipeline, SalesRevenueEvent, SalesOutreachEvent, SalesTask, Stage } from "../types";

const BUILT_IN_TRIAL_TEMPLATE_ID = "built-in-trial-contract";
const BUILT_IN_TRIAL_5K_RENEWAL_TEMPLATE_ID = "built-in-trial-5k-renewal-contract";
const BUILT_IN_PRIVATE_DEED_TEMPLATE_ID = "built-in-private-deed";
const BUILT_IN_CONTRACT_TEMPLATE_IDS = new Set([
  BUILT_IN_TRIAL_TEMPLATE_ID,
  BUILT_IN_TRIAL_5K_RENEWAL_TEMPLATE_ID,
  BUILT_IN_PRIVATE_DEED_TEMPLATE_ID,
]);
const NOTE_SEPARATOR = "\n\n---\n\n";
const localDateTime = (date: Date) => { const pad = (value: number) => String(value).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const appointmentStamp = (value: string) => new Date(value).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const activityTaskId = (activity: LeadActivity) => String(activity.details?.task_id || "");
const appointmentOutcomeLabel: Record<AppointmentOutcome, string> = {
  answered: "Ha risposto", not_interested: "Non interessato",
  qualified: "In target", not_qualified: "Fuori target", no_answer: "No-show", held: "Svolta", no_show: "No-show",
  lost: "Offerta rifiutata",
};
type ContactType = CallType | "setting";
type AppointmentDraft = { task: SalesTask; due: string; note: string } & (
  { mode: "edit" } | { mode: "outcome"; outcome: AppointmentOutcome | ""; minutes: string; proposalMade?: boolean }
);
const AUTOMATIC_CONTRACT_FIELDS = new Set([
  "data_oggi",
  "data_firma",
  "data_inizio",
  "data_decorrenza",
  "data_inizio_servizio",
]);

/** Data scritta dal venditore (gg/mm/aaaa, anche con "." o "-") in formato italiano. */
function normalizeItalianDate(value: string) {
  const match = value.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  if (Number(day) < 1 || Number(day) > 31 || Number(month) < 1 || Number(month) > 12) return null;
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
}

function formatContractDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return "";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

/**
 * I vecchi modelli usano {{data_oggi}} sia per la firma sia nella clausola
 * di durata. Quando viene scelta una decorrenza futura, cambiamo il
 * segnaposto soltanto nella clausola di durata, lasciando la data di firma
 * alla data in cui il contratto viene generato/sottoscritto.
 */
function separateServiceStartDate(body: string) {
  if (body.includes("{{data_inizio_servizio}}")) return body;

  const lines = body.split("\n");
  const headingPattern = /\b(durata|decorrenza)\b/i;
  const nextArticlePattern = /^\s*(?:art(?:icolo)?\.?\s*\d+|\d+[.)-])\s*/i;
  let changed = false;

  for (let index = 0; index < lines.length && !changed; index += 1) {
    if (!headingPattern.test(lines[index])) continue;

    for (let cursor = index; cursor < lines.length; cursor += 1) {
      if (cursor > index && nextArticlePattern.test(lines[cursor])) break;
      if (
        lines[cursor].includes("{{data_oggi}}") &&
        /(inizio|inizier|decorre|durata|sottoscrizione)/i.test(lines[cursor])
      ) {
        lines[cursor] = lines[cursor]
          .split("{{data_oggi}}")
          .join("{{data_inizio_servizio}}");
        changed = true;
      }
    }
  }

  if (!changed) {
    const fallback = lines.findIndex(
      (line) =>
        line.includes("{{data_oggi}}") &&
        /(avrà inizio|avvio|decorre|decorrenza|durata)/i.test(line)
    );
    if (fallback >= 0) {
      lines[fallback] = lines[fallback]
        .split("{{data_oggi}}")
        .join("{{data_inizio_servizio}}");
      changed = true;
    }
  }

  return changed ? lines.join("\n") : body;
}

function appendNote(history: string, note: string) {
  const entry = `${romeStamp()} — ${note.trim()}`;
  return history.trim() ? `${entry}${NOTE_SEPARATOR}${history.trim()}` : entry;
}

function splitNoteHistory(history: string) {
  const text = history.trim();
  if (!text) return [];
  if (text.includes(NOTE_SEPARATOR)) return text.split(NOTE_SEPARATOR).filter(Boolean);
  // Compatibilità con le note create prima del nuovo separatore: la prima
  // nota rapida era su una riga, il testo restante è lo storico precedente.
  const legacyTimed = text.match(/^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+—\s+[^\n]*)(?:\n([\s\S]+))?$/);
  return legacyTimed ? [legacyTimed[1], legacyTimed[2]].filter(Boolean) : [text];
}

interface Props {
  lead?: Lead;
  newInStage?: Stage;
  clientId?: string;
  pipelineId?: string;
  stages: Stage[];
  meName?: string;
  canDelete?: boolean;
  canReassign?: boolean;
  /** Solo l'amministratore registra gli incassi: sono dati di cassa e devono
   *  passare da una sola mano, come già avviene per i costi. */
  admin?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onUpdated?: () => void;
  navigation?: { index: number; total: number; onPrevious: () => void; onNext: () => void };
}

export default function LeadModal({
  lead,
  newInStage,
  clientId,
  pipelineId,
  stages,
  meName,
  canDelete = false,
  canReassign = false,
  admin = false,
  onClose,
  onSaved,
  onUpdated,
  navigation,
}: Props) {
  const isNew = !lead;
  const [drawerWidth, setDrawerWidth] = useState(680);
  const resizeStart = useRef<{x:number;width:number} | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [section, setSection] = useState("work");
  const [actionGroup, setActionGroup] = useState(stages.find(s => s.id === lead?.stage_id)?.name === "CLOSING" ? "closing" : stages.find(s => s.id === lead?.stage_id)?.name === "DISCOVERY" ? "discovery" : "contact");
  const [appointmentDraft, setAppointmentDraft] = useState<AppointmentDraft | null>(null);
  const [appointmentFeedback, setAppointmentFeedback] = useState<{ text: string; warning?: boolean } | null>(null);
  const [noteSaved, setNoteSaved] = useState("");
  const [payments, setPayments] = useState<SalesRevenueEvent[]>([]);
  const [paymentsError, setPaymentsError] = useState("");
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [followUps, setFollowUps] = useState<SalesTask[]>([]);
  async function reloadFollowUps() {
    if (!lead) return;
    const result = await supabase.from("sales_tasks").select("*").eq("lead_id", lead.id).is("completed_at", null).is("appointment_type", null).order("due_at");
    if (result.error) { setErr("Richiami non disponibili: " + result.error.message); return; }
    setFollowUps((result.data || []) as SalesTask[]);
  }
  async function reloadPayments() {
    if (!lead) return;
    setPaymentsLoading(true);
    const result = await supabase.from("sales_revenue_events").select("*").eq("lead_id", lead.id).order("occurred_at", { ascending: false });
    setPaymentsLoading(false);
    setPaymentsError(result.error ? "Elenco incassi non disponibile: " + result.error.message : "");
    if (!result.error) setPayments((result.data || []) as SalesRevenueEvent[]);
  }
  async function completeFollowUp(task: SalesTask) {
    setBusy(true); setErr(null);
    try {
      const result = await supabase.from("sales_tasks").update({ completed_at: new Date().toISOString(), completed_by: meName || null }).eq("id", task.id).is("completed_at", null);
      if (result.error) throw result.error;
      const remaining = await supabase.from("sales_tasks").select("due_at,appointment_status").eq("lead_id", task.lead_id).is("completed_at", null).order("due_at");
      if (remaining.error) throw remaining.error;
      const next = remaining.data?.find(t => !["cancelled", "held", "no_show"].includes(t.appointment_status || ""))?.due_at;
      const nextDay = next ? new Date(next).toLocaleDateString("en-CA", {timeZone:"Europe/Rome"}) : null;
      const updated = await supabase.from("leads").update({ next_action_date: nextDay }).eq("id", task.lead_id);
      if (updated.error) throw updated.error;
      setNextAction(nextDay || ""); await reloadFollowUps(); onUpdated?.();
    } catch (error) { setErr(error instanceof Error ? error.message : "Richiamo non aggiornato."); }
    finally { setBusy(false); }
  }

  const [canRecordRevenue, setCanRecordRevenue] = useState(admin);
  useEffect(() => {
    let active = true;
    setCanRecordRevenue(admin);
    if (!admin) {
      void withTimeout(supabase.rpc("can_record_revenue", {}))
        .then(({ data, error }) => { if (active) setCanRecordRevenue(!error && data === true); })
        .catch(() => { if (active) setCanRecordRevenue(false); });
    }
    return () => { active = false; };
  }, [admin]);
  const originalPipelineId = lead?.pipeline_id ?? pipelineId ?? "";
  const [selectedPipelineId, setSelectedPipelineId] = useState(originalPipelineId);
  const [availablePipelines, setAvailablePipelines] = useState<Pipeline[]>([]);
  const [pipelineError, setPipelineError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const owner = lead?.client_id ?? clientId;
    if (!owner) return;
    void Promise.resolve(supabase.from("pipelines").select("*").eq("client_id", owner).order("position"))
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setPipelineError("Impossibile caricare le pipeline. Riapri la scheda per riprovare.");
        else setAvailablePipelines((data ?? []) as Pipeline[]);
      }).catch(() => {
        if (!cancelled) setPipelineError("Impossibile caricare le pipeline. Riapri la scheda per riprovare.");
      });
    return () => { cancelled = true; };
  }, [lead?.client_id, clientId]);
  const [name, setName] = useState(lead?.name ?? "");
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [email, setEmail] = useState(lead?.email ?? "");
  const [source, setSource] = useState(lead?.source ?? "Instantly");
  const [assigned, setAssigned] = useState(lead?.assigned_to ?? "");
  const [value, setValue] = useState(String(lead?.value ?? 0));
  const settingStageId = stages.find((stage) => stage.name === "SETTING")?.id ?? newInStage?.id ?? stages[0]?.id;
  const [stageId, setStageId] = useState(
    lead?.stage_id ?? settingStageId
  );
  // Lo storico non si riscrive: ogni nuovo aggiornamento viene aggiunto sopra.
  const [notes, setNotes] = useState(lead?.notes ?? "");
  const [quickNote, setQuickNote] = useState("");
  const [nextAction, setNextAction] = useState(lead?.next_action_date ?? "");
  const [closingDate, setClosingDate] = useState(lead?.closing_date ?? "");
  const [lostReason, setLostReason] = useState(lead?.lost_reason ?? "");
  const [tags, setTags] = useState(lead?.tags ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [quickAction, setQuickAction] = useState<"qualified" | "not_qualified" | "lost" | null>(null);
  const [closingAction, setClosingAction] = useState<"held" | "no_show" | null>(null);
  const [closingMinutes, setClosingMinutes] = useState("");
  const [commercialNote, setCommercialNote] = useState("");
  const [commercialMinutes, setCommercialMinutes] = useState("");
  const [activitySaved, setActivitySaved] = useState("");
  const [activityHistory, setActivityHistory] = useState<LeadActivity[]>([]);
  const [appointments, setAppointments] = useState<SalesTask[]>([]);
  const [appointmentsReady, setAppointmentsReady] = useState(false);
  const currentStageName = stages.find((stage) => stage.id === stageId)?.name ?? null;
  const notInTargetStage = stages.find((stage) => stage.pipeline_id === lead?.pipeline_id && stage.name.trim().toLowerCase() === "non in target");
  // Tipo di chiamata e destinatario si deducono dalla fase del lead: il
  // venditore li corregge solo quando la deduzione sbaglia, non a ogni azione.
  const [callTypeOverride, setCallTypeOverride] = useState<ContactType | null>(null);
  const commercialActionLock = useRef(false);
  const leadSaveLock = useRef(false);
  const revenueLock = useRef(false);
  const planLock = useRef(false);
  const [booking, setBooking] = useState<{ id: string; type: AppointmentType; due: string; note: string; audience: AppointmentAudience; previousOutcomeKey?: string; sourceReplyId?: string; host?: string } | null>(null);
  const [bookingReplies, setBookingReplies] = useState<SalesOutreachEvent[]>([]);
  const [manualCallAt, setManualCallAt] = useState("");
  const persistedStage = useRef(lead?.stage_id);
  const persistedNextAction = useRef(lead?.next_action_date || "");
  const contactType = callTypeOverride ?? defaultCallType(currentStageName);
  const [planTitle, setPlanTitle] = useState("");
  const [planDue, setPlanDue] = useState("");
  const [planNote, setPlanNote] = useState("");
  const [planPriority, setPlanPriority] = useState(false);
  const revenueDraftKey = `revenue-draft:${lead?.client_id ?? clientId}:${meName}:${lead?.id ?? "new"}`;
  const [revenueDraft] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(revenueDraftKey) || "null"); } catch { return null; }
  });
  const [revenueType, setRevenueType] = useState<SalesRevenueEvent["revenue_type"]>(revenueDraft?.type ?? "new");
  const [revenueAmount, setRevenueAmount] = useState<string>(revenueDraft?.amount ?? "");
  const [revenueContractValue, setRevenueContractValue] = useState<string>(revenueDraft?.contractValue ?? "");
  const [revenueAppointmentId, setRevenueAppointmentId] = useState<string>(revenueDraft?.appointmentId || "");
  const [revenueAt, setRevenueAt] = useState<string>(revenueDraft?.at ?? localDateTime(new Date()));
  const [revenueNote, setRevenueNote] = useState<string>(revenueDraft?.note ?? "");
  const [revenueSaved, setRevenueSaved] = useState("");
  const [revenueError, setRevenueError] = useState("");
  useEffect(() => {
    try {
      if (revenueAmount) sessionStorage.setItem(revenueDraftKey, JSON.stringify({ type: revenueType, amount: revenueAmount, contractValue: revenueContractValue, at: revenueAt, note: revenueNote, appointmentId: revenueAppointmentId }));
      else sessionStorage.removeItem(revenueDraftKey);
    } catch { /* La registrazione resta disponibile se lo storage è disabilitato. */ }
  }, [revenueDraftKey, revenueType, revenueAmount, revenueContractValue, revenueAt, revenueNote, revenueAppointmentId]);
  function leaveLead(action: () => void) {
    if (busy || leadSaveLock.current || revenueLock.current || planLock.current || commercialActionLock.current) return;
    const dataChanged = lead && (name !== (lead.name || "") || phone !== (lead.phone || "") || email !== (lead.email || "") || source !== (lead.source ?? "Instantly") || assigned !== (lead.assigned_to || "") || value !== String(lead.value ?? 0) || stageId !== persistedStage.current || selectedPipelineId !== originalPipelineId || nextAction !== persistedNextAction.current || closingDate !== (lead.closing_date || "") || lostReason !== (lead.lost_reason || "") || tags !== (lead.tags || ""));
    if ((isNew && (name.trim() || phone.trim() || email.trim())) || dataChanged || quickNote.trim() || commercialNote.trim() || planDue || planTitle.trim() || planNote.trim() || revenueAmount || ctForm || appointmentDraft || booking) { setPendingLeave(() => action); return; }
    action();
  }
  function closeLead() { leaveLead(onClose); }
  // Contratti
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  const [ctForm, setCtForm] = useState(false);
  const [ctTpl, setCtTpl] = useState("");
  const [ctTitle, setCtTitle] = useState("");
  const [ctTo, setCtTo] = useState(lead?.email ?? "");
  const [ctVals, setCtVals] = useState<Record<string, string>>({});
  const [ctStartMode, setCtStartMode] = useState<"automatic" | "custom">("automatic");
  const [ctStartDate, setCtStartDate] = useState("");
  const [ctErr, setCtErr] = useState<string | null>(null);

  useEffect(() => {
    if (!lead) return;
    supabase
      .from("contracts")
      .select("*")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setContracts((data as Contract[]) ?? []));
    supabase
      .from("contract_templates")
      .select("*")
      .is("team_department", null)
      .order("name")
      .then(({ data }) => {
        const list = (data as ContractTemplate[]) ?? [];
        const builtInTemplates: ContractTemplate[] = [
          {
            id: BUILT_IN_TRIAL_TEMPLATE_ID,
            client_id: lead.client_id,
            name: TRIAL_CONTRACT_TEMPLATE.name,
            body: TRIAL_CONTRACT_TEMPLATE.body,
            client_fields: TRIAL_CONTRACT_TEMPLATE.clientFields,
            created_at: "",
          },
          {
            id: BUILT_IN_TRIAL_5K_RENEWAL_TEMPLATE_ID,
            client_id: lead.client_id,
            name: TRIAL_5K_RENEWAL_CONTRACT_TEMPLATE.name,
            body: TRIAL_5K_RENEWAL_CONTRACT_TEMPLATE.body,
            client_fields: TRIAL_5K_RENEWAL_CONTRACT_TEMPLATE.clientFields,
            created_at: "",
          },
          {
            id: BUILT_IN_PRIVATE_DEED_TEMPLATE_ID,
            client_id: lead.client_id,
            name: PRIVATE_DEED_TEMPLATE.name,
            body: PRIVATE_DEED_TEMPLATE.body,
            client_fields: PRIVATE_DEED_TEMPLATE.clientFields || null,
            created_at: "",
          },
        ];
        const existingNames = new Set(list.map((template) => template.name));
        const templatesWithTrial = [
          ...builtInTemplates.filter((template) => !existingNames.has(template.name)),
          ...list,
        ];
        setTemplates(templatesWithTrial);
        setCtTpl(templatesWithTrial[0]?.id ?? "");
      });
  }, [lead?.id]);

  async function reloadActivityHistory() {
    if (!lead) return;
    const { data, error } = await supabase.from("lead_activities").select("*").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(500);
    setHistoryError(error ? "Azioni non disponibili: " + error.message : "");
    setActivityHistory((data as LeadActivity[]) ?? []);
  }

  async function reloadAppointments() {
    if (!lead) return;
    try {
      setAppointments(await leadAppointments(lead.client_id, lead.id));
      setAppointmentsReady(true);
    } catch {
      setAppointmentsReady(false);
      setAppointmentFeedback({ text: "Impossibile caricare gli appuntamenti. Riprova prima di registrare una call.", warning: true });
    }
  }

  useEffect(() => {
    if (!lead) return;
    void reloadActivityHistory();
    void reloadAppointments();
    void reloadFollowUps();
  }, [lead?.id]);
  useEffect(() => { if ((section === "payments" || section === "history") && canRecordRevenue) void reloadPayments(); }, [section, lead?.id, canRecordRevenue]);

  const activeAppointments = appointments.filter((task) => !isAppointmentClosed(task) && !task.completed_at && task.appointment_status !== "cancelled").sort((a, b) => a.due_at.localeCompare(b.due_at));
  const planAudienceAllowsProspect = defaultAudience(currentStageName) === "lead";
  const pendingSetting = activeAppointments.find(task => task.appointment_type === "setting");
  const settingDue = pendingSetting && awaitingOutcome(pendingSetting);
  const hasDiscovery = activeAppointments.some(task => task.appointment_type === "discovery");
  const hasClosing = activeAppointments.some(task => task.appointment_type === "demo");
  const appointmentAttempts = new Map<string, number>();
  const attemptsByType = { setting: 0, discovery: 0, demo: 0 };
  [...appointments].sort((a, b) => a.created_at.localeCompare(b.created_at)).forEach((task) => {
    const type = task.appointment_type;
    if (type) appointmentAttempts.set(task.id, ++attemptsByType[type]);
  });

  function openAppointmentDraft(task: SalesTask, mode: AppointmentDraft["mode"]) {
    setQuickAction(null);
    setClosingAction(null);
    setAppointmentFeedback(null);
    const due = localDateTime(new Date(task.due_at));
    requestAnimationFrame(() => document.getElementById("lead-appointment-draft")?.scrollIntoView({ block: "nearest" }));
    if (mode === "edit") {
      setAppointmentDraft({ mode, task, due, note: task.description || "" });
      return;
    }
    const type = task.appointment_type ?? "discovery";
    if (type === "setting") setActionGroup("contact");
    const result = activityHistory.find(activity => activity.event_key === outcomeKey(task.id));
    const allowed = allowedOutcomes(type);
    const outcome = allowed.find(option => option === result?.outcome) || "";
    setAppointmentDraft({ mode, task, due, outcome, proposalMade: task.proposal_made ?? undefined, note: result?.note || "", minutes: type === "setting" ? String(result?.duration_minutes ?? "") : String(result?.duration_minutes || task.duration_minutes || APPOINTMENT_DURATION[type]) });
  }

  async function saveAppointmentDraft(nextType?: AppointmentType) {
    const draft = appointmentDraft;
    if (!lead || !draft || busy || commercialActionLock.current || leadSaveLock.current || planLock.current) return;
    const start = new Date(draft.due);
    if (draft.mode === "edit" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.due) || !Number.isFinite(start.getTime()))) {
      setAppointmentFeedback({ text: "Scegli la data e l’ora dell’appuntamento.", warning: true });
      return;
    }
    if (draft.mode === "outcome") {
      if (!draft.outcome || Date.parse(draft.task.due_at) > Date.now()) return;
      if (!["no_answer", "no_show"].includes(draft.outcome) && draft.minutes && (!Number.isInteger(Number(draft.minutes)) || Number(draft.minutes) < 1)) {
        setAppointmentFeedback({ text: "Inserisci la durata effettiva in minuti interi.", warning: true });
        return;
      }
    }
    commercialActionLock.current = true;
    setBusy(true);
    setAppointmentFeedback(null);
    try {
      const result = draft.mode === "edit"
        ? await updateAppointment(draft.task, { subject: appointmentSubject(draft.task), startsAt: start, note: draft.note })
        : await recordAppointmentOutcome(draft.task, draft.outcome as AppointmentOutcome, Number(draft.minutes) || undefined, draft.note, draft.proposalMade);
      if (!result.ok) {
        setAppointmentFeedback({ text: result.error || "Modifica non salvata. Riprova.", warning: true });
        return;
      }
      if (draft.mode === "edit") {
        persistedNextAction.current = romeDay(start);
        setNextAction(persistedNextAction.current);
      }
      setAppointmentDraft(null);
      setAppointmentFeedback({ text: result.warning || (draft.mode === "edit" ? "Appuntamento aggiornato" : "Esito registrato nelle KPI"), warning: !!result.warning });
      await Promise.all([reloadAppointments(), reloadActivityHistory()]);
      if (nextType && draft.mode === "outcome") prepareAppointment(nextType, outcomeKey(draft.task.id));
      onUpdated?.();
    } catch (reason) {
      setAppointmentFeedback({ text: reason instanceof Error ? reason.message : "Impossibile verificare il salvataggio. Riapri la scheda per controllare l’appuntamento.", warning: true });
    } finally {
      commercialActionLock.current = false;
      setBusy(false);
    }
  }

  async function markNotInTarget() {
    if (!lead || !notInTargetStage || commercialActionLock.current) return;
    commercialActionLock.current = true;
    setBusy(true);
    setErr(null);
    setActivitySaved("");
    try {
      const { data, error } = await withTimeout(supabase.rpc("mark_lead_not_in_target", {
        p_lead_id: lead.id, p_expected_stage_id: persistedStage.current ?? lead.stage_id,
        p_note: commercialNote.trim() || null,
      }));
      if (error || !data) throw new Error(error?.message || "Spostamento non confermato.");
      persistedStage.current = data;
      setStageId(data);
      setCommercialNote("");
      setActivitySaved("Lead spostato in Non in target");
      onUpdated?.();
      await reloadActivityHistory();
    } catch (reason) {
      setErr(reason instanceof Error ? reason.message : "Impossibile spostare il lead in Non in target.");
    } finally {
      commercialActionLock.current = false;
      setBusy(false);
    }
  }

  async function recordQuickActivity(outcome: "no_answer" | "answered" | "not_interested" | "qualified" | "not_qualified" | "completed" | "lost", bookClosing = false) {
    if (!lead || commercialActionLock.current) return;
    const isContact = outcome === "no_answer" || outcome === "answered" || outcome === "not_interested";
    const isSetting = isContact && contactType === "setting";
    if (pendingSetting && settingDue && isContact) {
      openAppointmentDraft(pendingSetting, "outcome");
      return;
    }
    // Solo "in target" e "fuori target" dichiarano una discovery svolta: un
    // recall a cui il cliente risponde e' una chiamata risposta, non una discovery.
    const isDiscovery = ["qualified", "not_qualified"].includes(outcome);
    const isCall = isContact || isDiscovery;
    if (isDiscovery && (!appointmentsReady || hasDiscovery)) return setErr("Controlla Appuntamenti del lead prima di registrare una discovery non pianificata.");
    const minutes = Number(commercialMinutes) || 0;
    if (["qualified", "not_qualified"].includes(outcome) && minutes <= 0) return setErr("Seleziona la durata della discovery.");
    if (outcome === "lost" && !lostReason.trim()) return setErr("Scegli il motivo della perdita.");
    commercialActionLock.current = true;
    setBusy(true); setErr(null); setActivitySaved("");

    const lostStage = outcome === "lost" ? stages.find((stage) => stage.name === "LOST") : undefined;
    let lostPosition: number | undefined;
    if (lostStage && lostStage.id !== lead.stage_id) {
      try {
        lostPosition = await topLeadPosition(supabase, lead.client_id, lead.pipeline_id, lostStage.id);
      } catch (reason) {
        setBusy(false); commercialActionLock.current = false;
        return setErr(reason instanceof Error ? reason.message : "Impossibile preparare lo spostamento.");
      }
    }
    const occurredAt = isDiscovery && manualCallAt ? new Date(manualCallAt) : new Date();
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now()) {
      setBusy(false); commercialActionLock.current = false;
      return setErr("Scegli la data effettiva della call, nel passato.");
    }
    const eventType = isSetting ? "setting_call" : isCall ? "discovery_call" : outcome === "lost" ? "sale_outcome" : "follow_up";
    // Chiave deterministica: due clic sullo stesso esito nello stesso minuto sono
    // lo stesso evento e il database rifiuta il secondo. Un tentativo reale più
    // tardi ha una chiave diversa e viene registrato normalmente.
    const eventKey = quickActivityKey(lead.id, eventType, outcome, occurredAt);
    const result = await supabase.from("lead_activities").upsert({
      lead_id: lead.id,
      client_id: lead.client_id,
      pipeline_id: lead.pipeline_id,
      activity_type: isCall ? "call" : "follow_up",
      event_type: eventType,
      channel: isCall ? "phone" : "other",
      call_type: isCall ? contactType === "setting" ? "outbound" : contactType : null,
      outcome,
      duration_minutes: isSetting ? null : minutes || null,
      occurred_at: occurredAt.toISOString(),
      note: commercialNote.trim() || (outcome === "lost" ? lostReason.trim() : null),
      next_action_date: nextAction.trim() || null,
      created_by: meName?.trim() || null,
      details: { assigned_to: lead.assigned_to || meName || null, owner_at_event: lead.assigned_to || meName || null },
      event_key: eventKey,
    }, { onConflict: "client_id,event_key" }).select("*").single();
    if (result.error) {
      setBusy(false); commercialActionLock.current = false;
      return setErr("Attività non registrata: " + result.error.message);
    }
    if (outcome === "lost") {
      const update = await supabase.from("leads").update({ lost_reason: lostReason.trim(), ...(lostStage ? { stage_id: lostStage.id } : {}), ...(lostPosition !== undefined ? { position: lostPosition } : {}) }).eq("id", lead.id);
      if (update.error) {
        await supabase.from("lead_activities").delete().eq("client_id", lead.client_id).eq("event_key", eventKey);
        setBusy(false); commercialActionLock.current = false;
        return setErr("Esito non registrato: " + update.error.message);
      }
      if (lostStage) setStageId(lostStage.id);
    }
    setActivityHistory((current) => [result.data as LeadActivity, ...current.filter((item) => item.id !== (result.data as LeadActivity).id)]);
    setCommercialNote(""); setCommercialMinutes(""); setQuickAction(null); setManualCallAt("");
    setActivitySaved(isSetting ? "Tentativo di setting registrato" : outcome === "no_answer" ? "Tentativo registrato" : outcome === "answered" ? "Chiamata risposta registrata" : outcome === "completed" ? "Follow-up registrato" : outcome === "lost" ? "Lead segnato come perso" : "Discovery registrata");
    setBusy(false); commercialActionLock.current = false;
    if (bookClosing && outcome === "qualified") prepareAppointment("demo", eventKey);
    onUpdated?.();
  }

  async function recordClosingOutcome(outcome: "held" | "no_show") {
    if (!lead || commercialActionLock.current) return;
    if (!appointmentsReady || hasClosing) return setErr("Controlla Appuntamenti del lead prima di registrare una closing non pianificata.");
    const minutes = Number(closingMinutes) || 0;
    if (outcome === "held" && minutes <= 0) return setErr("Seleziona la durata della closing.");
    commercialActionLock.current = true;
    setBusy(true); setErr(null); setActivitySaved("");

    const occurredAt = manualCallAt ? new Date(manualCallAt) : new Date();
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now()) {
      setBusy(false); commercialActionLock.current = false;
      return setErr("Scegli la data effettiva della call, nel passato.");
    }
    const eventKey = quickActivityKey(lead.id, "demo_call", outcome, occurredAt);
    const result = await supabase.from("lead_activities").upsert({
      lead_id: lead.id,
      client_id: lead.client_id,
      pipeline_id: lead.pipeline_id,
      activity_type: "meeting",
      event_type: "demo_call",
      channel: "video_call",
      call_type: defaultAudience(currentStageName) === "client" ? "client" : "lead",
      outcome,
      duration_minutes: outcome === "held" ? minutes : null,
      occurred_at: occurredAt.toISOString(),
      note: commercialNote.trim() || "Closing registrata dalla scheda lead senza appuntamento CRM",
      details: { assigned_to: lead.assigned_to || meName || null, owner_at_event: lead.assigned_to || meName || null },
      created_by: meName?.trim() || null,
      event_key: eventKey,
    }, { onConflict: "client_id,event_key" }).select("*").single();
    setBusy(false); commercialActionLock.current = false;
    if (result.error) return setErr("Esito della closing non registrato: " + result.error.message);
    setActivityHistory((current) => [result.data as LeadActivity, ...current.filter((item) => item.id !== (result.data as LeadActivity).id)]);
    setClosingAction(null); setClosingMinutes(""); setCommercialNote(""); setManualCallAt("");
    setActivitySaved(outcome === "held" ? "Closing non pianificata registrata come svolta" : "No-show non pianificato registrato");
    onUpdated?.();
  }

  useEffect(() => {
    if (!lead || booking?.type !== "discovery") return;
    let active = true;
    setBookingReplies([]);
    void supabase.from("sales_outreach_events").select("*").eq("client_id", lead.client_id)
      .eq("lead_id", lead.id).eq("event_type", "reply").eq("quantity", 1)
      .order("occurred_at", { ascending: false }).limit(20).then(({ data }) => {
        if (active) setBookingReplies((data || []) as SalesOutreachEvent[]);
      });
    return () => { active = false; };
  }, [lead?.id, lead?.client_id, booking?.id, booking?.type]);

  function prepareAppointment(type: AppointmentType, previousOutcomeKey?: string) {
    if (busy && !previousOutcomeKey) return;
    setBooking({ id: crypto.randomUUID(), type, due: "", note: "", audience: type === "setting" ? "lead" : defaultAudience(currentStageName), previousOutcomeKey });
    setAppointmentFeedback(null);
    requestAnimationFrame(() => document.getElementById("lead-booking-form")?.scrollIntoView({ block: "nearest" }));
  }

  async function saveBooking() {
    if (!lead || !booking || planLock.current || busy) return;
    const startsAt = new Date(booking.due);
    if (!booking.due || !Number.isFinite(startsAt.getTime())) return;
    planLock.current = true;
    setBusy(true);
    setAppointmentFeedback(null);
    try {
      const result = await createAppointment({
        clientId: lead.client_id, lead, type: booking.type, audience: booking.audience,
        subject: lead.name || "Lead", startsAt, note: booking.note,
        requestId: booking.id, previousOutcomeKey: booking.previousOutcomeKey, sourceReplyId: booking.sourceReplyId, host: booking.host,
      });
      if (!result.ok) {
        setAppointmentFeedback({ text: result.error || "Prenotazione non salvata. Riprova.", warning: true });
        return;
      }
      setBooking(null);
      persistedNextAction.current = romeDay(startsAt);
      setNextAction(persistedNextAction.current);
      if (result.advancedStageId) {
        const previousStage = persistedStage.current;
        setStageId(phase => phase === previousStage ? result.advancedStageId! : phase);
        persistedStage.current = result.advancedStageId;
      }
      const warning = [result.pipelineWarning, result.warning].filter(Boolean).join(" ");
      setAppointmentFeedback({ text: warning || "Appuntamento prenotato", warning: Boolean(warning) });
      await Promise.all([reloadAppointments(), reloadActivityHistory()]);
      onUpdated?.();
    } catch (error) {
      setAppointmentFeedback({ text: error instanceof Error ? error.message : "Salvataggio da verificare. Riprova.", warning: true });
    } finally {
      planLock.current = false;
      setBusy(false);
    }
  }

  async function removeCommercialActivity(activity: LeadActivity) {
    if (activityTaskId(activity)) return setErr("Le registrazioni collegate a un appuntamento si correggono dal Calendario, per non separare storico e KPI.");
    if (!confirm("Eliminare questa registrazione dai KPI?")) return;
    setBusy(true);
    const result = await supabase.from("lead_activities").delete().eq("id", activity.id); setBusy(false);
    if (result.error) return setErr("Registrazione non eliminata: " + result.error.message);
    setActivityHistory((current) => current.filter((item) => item.id !== activity.id));
    onUpdated?.();
  }

  async function recordRevenue() {
    if (!lead || !canRecordRevenue || revenueLock.current) return;
    if (!Number.isFinite(Number(revenueAmount)) || Number(revenueAmount) <= 0 || !revenueAt || !Number.isFinite(new Date(revenueAt).getTime())) return setRevenueError("Inserisci importo incassato, data e ora validi.");
    revenueLock.current = true; setBusy(true); setErr(null); setRevenueSaved(""); setRevenueError("");
    let paymentConfirmed = false;
    try {
      const amount = Number(revenueAmount);
      const occurredAt = new Date(revenueAt).toISOString();
      // Stesso lead, stesso tipo, stesso momento e stesso importo = stesso incasso.
      // Il reinvio della stessa registrazione non aggiunge una seconda riga.
      const key = revenueKey(lead.id, revenueType, occurredAt, amount);
      const savedState = await persistRevenue(supabase, {
        client_id: lead.client_id, pipeline_id: lead.pipeline_id, lead_id: lead.id,
        revenue_type: revenueType, amount, contract_value: Number(revenueContractValue) || null,
        status: "collected", occurred_at: occurredAt, assigned_to: lead.assigned_to || meName || null,
        sale_appointment_id: revenueType === "new" && revenueAppointmentId ? revenueAppointmentId : null,
        created_by: meName || null, note: revenueNote.trim() || null, event_key: key,
      });
      paymentConfirmed = true;
      // La prima cauzione/incasso nuovo rende la vendita vinta. Lo scriviamo
      // automaticamente nello storico: l'amministratore non deve compilare un
      // secondo esito e un nuovo tentativo con la stessa chiave non duplica nulla.
      if (revenueType === "new") {
        const wonResult = await withTimeout(supabase.from("lead_activities").upsert({
          lead_id: lead.id,
          client_id: lead.client_id,
          pipeline_id: lead.pipeline_id,
          activity_type: "meeting",
          event_type: "sale_outcome",
          channel: "other",
          call_type: "lead",
          outcome: "won",
          amount,
          occurred_at: occurredAt,
          note: revenueNote.trim() || "Vendita vinta con incasso registrato",
          created_by: meName || null,
          event_key: `revenue-won:${key}`,
        }, { onConflict: "client_id,event_key", ignoreDuplicates: true }));
        if (wonResult.error) {
          return setRevenueError("Incasso registrato, ma la chiusura vinta non è entrata nello storico: " + wonResult.error.message);
        }
      }
      // Il valore aggiornato resta la previsione corrente del lead. I KPI già
      // chiusi non cambiano: leggono il valore congelato sul contratto firmato.
      if (revenueType === "new" && Number(revenueContractValue) > 0) {
        const valueResult = await withTimeout(supabase.from("leads").update({ value: Number(revenueContractValue) }).eq("id", lead.id));
        if (valueResult.error) { return setRevenueError("Incasso registrato, ma valore contratto non aggiornato: " + valueResult.error.message); }
        setValue(String(Number(revenueContractValue)));
      }
      void reloadPayments();
      setRevenueSaved(`${savedState === "existing" ? "Incasso già presente (nessun doppione)" : "Incasso registrato"}: ${amount.toLocaleString("it-IT", { style: "currency", currency: "EUR" })} per ${lead.name}. Data incasso: ${new Date(occurredAt).toLocaleString("it-IT")}.`);
      setRevenueAmount(""); setRevenueContractValue(""); setRevenueAppointmentId(""); setRevenueNote(""); setRevenueAt(localDateTime(new Date()));
      onUpdated?.();
    } catch (error) {
      setRevenueError(`${paymentConfirmed ? "Incasso già registrato, aggiornamento dello storico incompleto." : "Non è stato possibile confermare il salvataggio."} Mantieni importo e data invariati prima di riprovare: ${error instanceof Error ? error.message : "errore di connessione"}`);
    } finally {
      revenueLock.current = false; setBusy(false);
    }
  }

  // placeholders del modello selezionato
  const tpl = templates.find((x) => x.id === ctTpl);
  const placeholders = [
    ...new Set((tpl?.body ?? "").match(/\{\{(\w+)\}\}/g) ?? []),
  ].map((ph) => ph.slice(2, -2));
  // La scrittura privata la compila il venditore: al lead arriva da firmare e basta.
  const deedTemplate = isPrivateDeed(tpl?.body);
  const defaultCtTitle = (deed: boolean) => `${deed ? "Scrittura privata" : "Contratto"} — ${lead?.name ?? "lead"}`;

  function openCtForm() {
    const defaults: Record<string, string> = {
      nome_lead: lead?.name ?? "",
      email_lead: lead?.email ?? "",
      telefono_lead: lead?.phone ?? "",
      nome_venditore: meName ?? "",
    };
    setCtVals(defaults);
    setCtTitle(defaultCtTitle(deedTemplate));
    setCtTo(lead?.email ?? "");
    setCtStartMode("automatic");
    setCtStartDate("");
    setCtErr(null);
    setCtForm(true);
  }

  function chooseCtTemplate(id: string) {
    const deed = isPrivateDeed(templates.find((x) => x.id === id)?.body);
    // Il titolo automatico segue il tipo di documento; uno scritto a mano resta.
    setCtTitle((title) => (title === defaultCtTitle(true) || title === defaultCtTitle(false) ? defaultCtTitle(deed) : title));
    setCtErr(null);
    setCtTpl(id);
  }

  /** Dati del cliente scritti dal venditore: tutti obbligatori, puliti e
   *  controllati, perché il lead riceve il documento già compilato. */
  function privateDeedValues() {
    const fields = placeholders.filter((ph) => !AUTOMATIC_CONTRACT_FIELDS.has(ph));
    const label = (ph: string) => PRIVATE_DEED_TEMPLATE.sellerFields[ph]?.label ?? ph.replace(/_/g, " ");
    const values: Record<string, string> = { ...ctVals };
    for (const ph of fields) values[ph] = (ctVals[ph] ?? "").trim().replace(/\s+/g, " ");
    const missing = fields.filter((ph) => !values[ph]);
    if (missing.length) {
      setCtErr(`Compila tutti i dati del cliente: ${missing.map(label).join(", ")}.`);
      return null;
    }
    for (const ph of fields.filter((field) => field.includes("data_di_nascita"))) {
      const date = normalizeItalianDate(values[ph]);
      if (!date) {
        setCtErr(`${label(ph)}: scrivi la data come gg/mm/aaaa.`);
        return null;
      }
      values[ph] = date;
    }
    for (const ph of fields.filter((field) => field.includes("codice_fiscale"))) {
      values[ph] = values[ph].replace(/\s+/g, "").toUpperCase();
      if (!/^[A-Z0-9]{16}$/.test(values[ph])) {
        setCtErr(`${label(ph)}: deve avere 16 caratteri tra lettere e numeri.`);
        return null;
      }
    }
    return values;
  }

  async function createContract() {
    const cid = clientId ?? lead?.client_id;
    if (!lead || !cid) return setErr("Cliente mancante: riapri la scheda del lead.");
    if (!ctTpl) return setErr("Scegli un modello.");
    if (!deedTemplate && ctStartMode === "custom" && !ctStartDate) {
      return setErr("Seleziona la data di inizio del servizio.");
    }
    const sellerValues = deedTemplate ? privateDeedValues() : ctVals;
    if (!sellerValues) return;
    setCtErr(null);
    setErr(null);
    let body = normalizeSpecificApprovalSignature(tpl?.body ?? "");
    const today = new Date().toLocaleDateString("it-IT");
    const serviceStart =
      ctStartMode === "custom" ? formatContractDate(ctStartDate) : today;

    if (!deedTemplate && ctStartMode === "custom") {
      const updatedBody = separateServiceStartDate(body);
      if (
        updatedBody === body &&
        !body.includes("{{data_inizio_servizio}}") &&
        !body.includes("{{data_inizio}}") &&
        !body.includes("{{data_decorrenza}}")
      ) {
        return setErr(
          "Nel modello non trovo una data nella clausola di durata. Aggiungi {{data_inizio_servizio}} nel punto dedicato alla durata."
        );
      }
      body = updatedBody;
    }
    // sostituisci i segnaposto "normali" (valore, data...) ma lascia quelli
    // dei campi cliente: li riempirà il cliente nella pagina di firma.
    const clientSlugs = (tpl?.client_fields ?? "")
      .split("\n")
      .map((f) => f.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
      .filter(Boolean);
    const vals: Record<string, string> = {
      ...sellerValues,
      data_oggi: today,
      data_firma: today,
      data_inizio: serviceStart,
      data_decorrenza: serviceStart,
      data_inizio_servizio: serviceStart,
    };
    for (const ph of placeholders) {
      if (clientSlugs.includes(ph)) continue;
      body = body.split(`{{${ph}}}`).join(vals[ph] ?? "");
    }
    // Sostituisce anche il segnaposto introdotto al volo nei modelli legacy.
    for (const field of AUTOMATIC_CONTRACT_FIELDS) {
      body = body.split(`{{${field}}}`).join(vals[field] ?? "");
    }
    const { data: created, error } = await supabase
      .from("contracts")
      .insert({
        client_id: cid,
        lead_id: lead.id,
        template_id: BUILT_IN_CONTRACT_TEMPLATE_IDS.has(ctTpl) ? null : ctTpl,
        title: ctTitle.trim() || "Contratto",
        body,
        client_fields: tpl?.client_fields ?? null,
        status: "draft",
        sent_to: ctTo.trim() || lead.email || null,
        created_by: meName ?? null,
        // Il valore viene congelato qui: correggere il lead più avanti non deve
        // riscrivere il fatturato di una giornata già chiusa nei KPI. La
        // scrittura privata (deposito) non è il contratto: nessun valore.
        deal_value: deedTemplate ? null : Number(value) || null,
      })
      .select("id, sign_token")
      .single();
    if (error) return setErr(error.message);
    setCtForm(false);
    const tok = (created as { sign_token?: string } | null)?.sign_token;
    if (tok) {
      const link = `${window.location.origin}/#/firma/${tok}`;
      alert((deedTemplate ? "Scrittura privata generata" : "Contratto generato") + " (bozza). Link per il cliente:\n\n" + link + "\n\nNon è stato inviato nulla: usa Genera link o WhatsApp.");
    }
    supabase
      .from("contracts")
      .select("*")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setContracts((data as Contract[]) ?? []));
  }

  async function sendEmail(c: Contract) {
    if (!c.sent_to) return alert("Il contratto non ha un destinatario email.");
    setErr(null);
    const { data, error } = await supabase.rpc("send_contract_email", {
      p_contract_id: c.id,
    });
    if (error) return alert("Invio non riuscito: " + error.message);
    if (data !== "inviata") return alert(data);
    alert("Email inviata a " + c.sent_to + ". Il link di firma è nella mail.");
    setContracts((prev) =>
      prev.map((x) =>
        x.id === c.id ? { ...x, status: "sent", sent_at: new Date().toISOString() } : x
      )
    );
  }

  async function markSent(c: Contract) {
    const { error } = await supabase
      .from("contracts")
      .update({ status: "sent", sent_at: new Date().toISOString(), sent_to: ctTo.trim() || c.sent_to })
      .eq("id", c.id);
    if (error) return alert(error.message);
    setContracts((prev) =>
      prev.map((x) => (x.id === c.id ? { ...x, status: "sent", sent_at: new Date().toISOString() } : x))
    );
  }

  const firmLink = (c: Contract) =>
    `${window.location.origin}/#/firma/${c.sign_token}`;

  const waLink = (c: Contract) => {
    const digits = (lead?.phone ?? "").replace(/\D/g, "");
    const intl = digits.startsWith("39") ? digits : "39" + digits;
    const text =
      "Buongiorno, ti invio il contratto da firmare: " +
      firmLink(c) +
      "\nBasta aprire il link, compilare i campi e firmare con il dito. Grazie!";
    return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
  };

  async function save(afterSave: () => void = onSaved) {
    if (busy || leadSaveLock.current) return;
    if (revenueAmount) {
      setRevenueError("Hai un incasso da confermare: premi Registra incasso prima di salvare e chiudere la scheda.");
      document.querySelector(".revenue-tracker")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    leadSaveLock.current = true;
    try {
    setBusy(true);
    setErr(null);
    let destinationStageId = isNew ? settingStageId : stageId;
    let destinationPosition: number | undefined;
    const changingPipeline = selectedPipelineId !== originalPipelineId;
    if (changingPipeline) {
      try {
        const owner = lead?.client_id ?? clientId;
        const stageName = isNew ? "SETTING" : stages.find((stage) => stage.id === stageId)?.name;
        if (!availablePipelines.some((pipeline) => pipeline.id === selectedPipelineId) || !stageName) {
          throw new Error("Seleziona una pipeline e una fase valide.");
        }
        const target = await supabase.from("stages").select("id")
          .eq("client_id", owner).eq("pipeline_id", selectedPipelineId).eq("name", stageName).single();
        if (target.error || !target.data) {
          throw new Error(`La pipeline scelta non contiene una fase univoca «${stageName}». Nessun dato è stato salvato.`);
        }
        destinationStageId = target.data.id;
        const first = await supabase.from("leads").select("position")
          .eq("client_id", owner).eq("pipeline_id", selectedPipelineId).eq("stage_id", destinationStageId)
          .order("position").limit(1).maybeSingle();
        if (first.error) throw first.error;
        destinationPosition = Math.min(0, first.data?.position ?? 0) - 1;
      } catch (error) {
        setBusy(false);
        setErr(error instanceof Error ? error.message : "Impossibile preparare lo spostamento. Riprova.");
        return;
      }
    }
    if (!isNew && !changingPipeline && destinationStageId !== persistedStage.current) {
      destinationPosition = await topLeadPosition(supabase, lead!.client_id, selectedPipelineId, destinationStageId);
    }
    // Nota rapida: aggiunta in cima allo storico con data e ora (fuso Roma).
    const qn = quickNote.trim();
    const finalNotes = qn ? appendNote(notes, qn) : notes;
    const payload = {
      name: name.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      source: source.trim() || null,
      assigned_to: canReassign ? assigned.trim() || null : meName?.trim() || assigned.trim() || null,
      value: Number(value) || 0,
      stage_id: destinationStageId,
      ...(changingPipeline ? { pipeline_id: selectedPipelineId } : {}),
      ...(destinationPosition !== undefined ? { position: destinationPosition } : {}),
      ...(isNew ? { notes: finalNotes.trim() || null } : {}),
      next_action_date: nextAction.trim() || null,
      closing_date: closingDate.trim() || null,
      lost_reason: lostReason.trim() || null,
      tags: tags.trim() || null,
    };
    let error;
    let newLeadId: string | null = null;
    if (isNew) {
      // Come nel trascinamento: un nuovo lead precede le card già in SETTING.
      // Leggi la posizione al salvataggio, non all'apertura della scheda.
      const firstLead = await supabase
        .from("leads")
        .select("position")
        .eq("client_id", clientId)
        .eq("pipeline_id", selectedPipelineId)
        .eq("stage_id", destinationStageId)
        .order("position", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (firstLead.error) {
        setBusy(false);
        setErr("Impossibile determinare la posizione del nuovo lead: " + firstLead.error.message);
        return;
      }
      const position = Math.min(0, firstLead.data?.position ?? 0) - 1;
      const res = await supabase
        .from("leads")
        .insert({ ...payload, client_id: clientId, pipeline_id: selectedPipelineId, position })
        .select("id")
        .single();
      error = res.error;
      newLeadId = (res.data as { id: string } | null)?.id ?? null;
    } else {
      let update = supabase
        .from("leads")
        .update(payload)
        .eq("id", lead!.id);
      if (changingPipeline) update = update.eq("pipeline_id", originalPipelineId).eq("stage_id", persistedStage.current);
      const result = await update.select("id").single();
      error = result.error;
      if (changingPipeline && error?.code === "PGRST116") {
        setBusy(false);
        setErr("Il lead è stato spostato da un altro utente. Riapri la scheda prima di riprovare.");
        return;
      }
    }
    setBusy(false);
    if (error) setErr(error.message);
    else {
      if (!isNew && qn) {
        try { setNotes(await appendLeadNote(supabase, lead!.id, appendNote("", qn))); setQuickNote(""); }
        catch (reason) { setErr("Dati della scheda salvati, nota non confermata: " + (reason instanceof Error ? reason.message : "riprova")); return; }
      }
      // Se è stato compilato il prossimo passo, il Salva generale crea anche
      // la task/appuntamento: il venditore non deve fare un secondo passaggio.
      if (!isNew && planDue) {
        const planned = await savePlan();
        if (!planned) return;
      }
      // L'autore dell'eventuale cambio fase lo registra il database stesso
      // (trigger record_stage_event): niente aggiornamento manuale qui.
      afterSave();
    }
    } catch (reason) {
      setErr("Salvataggio non confermato: " + (reason instanceof Error ? reason.message : "riprova senza chiudere la scheda"));
    } finally { leadSaveLock.current = false; setBusy(false); }
  }

  async function saveQuickNote() {
    if (!lead || !quickNote.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setNotes(await appendLeadNote(supabase, lead.id, appendNote("", quickNote)));
      setQuickNote(""); setNoteSaved("Nota salvata"); onUpdated?.();
    } catch (reason) { setErr("Nota non confermata: " + (reason instanceof Error ? reason.message : "riprova")); }
    finally { setBusy(false); }
  }

  async function savePlan(): Promise<boolean> {
    if (!lead || planLock.current) return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(planDue) || !Number.isFinite(Date.parse(planDue))) {
      setErr("Scegli data e orario."); return false;
    }
    const subject = planTitle.trim() || lead.name || "Lead";
    planLock.current = true; setBusy(true); setErr(null);

    const finalTitle = planTitle.trim() || `Follow-up — ${lead.name || "Lead"}`;
    const finalNote = planNote.trim();
    const taskResult = await supabase.from("sales_tasks").insert({
      client_id: lead.client_id, lead_id: lead.id, title: finalTitle, description: finalNote || null,
      is_priority: planPriority, due_at: new Date(planDue).toISOString(),
      assigned_to: lead.assigned_to || meName || "Venditore", created_by: meName || null,
    }).select("id").single();
    if (!taskResult.error) await supabase.from("leads").update({ next_action_date: planDue.slice(0, 10) }).eq("id", lead.id);
    planLock.current = false; setBusy(false);
    if (taskResult.error) { setErr("Pianificazione non salvata: " + taskResult.error.message); return false; }
    persistedNextAction.current = planDue.slice(0, 10);
    setNextAction(persistedNextAction.current); void reloadFollowUps(); onUpdated?.();
    setPlanTitle(""); setPlanDue(""); setPlanNote(""); setPlanPriority(false);
    return true;
  }

  async function remove() {
    if (!lead) return;
    if (!confirm("Eliminare definitivamente questo lead?")) return;
    setBusy(true);
    const { error } = await supabase.from("leads").delete().eq("id", lead.id);
    setBusy(false);
    if (error) setErr(error.message);
    else onSaved();
  }

  // Mantiene il prefisso internazionale e rimuove soltanto i caratteri di
  // formattazione, così su iPhone il link apre direttamente l'app Telefono.
  const callablePhone = phone.trim().replace(/[^\d+*#,;]/g, "");

  const draftType = appointmentDraft?.task.appointment_type ?? "discovery";
  const settingOutcomeDraft = appointmentDraft?.mode === "outcome" && draftType === "setting";
  const appointmentForm = appointmentDraft && <div id="lead-appointment-draft" className="activity-box lead-appointment-draft">
    <b>{appointmentDraft.mode === "edit" ? "Modifica appuntamento" : "Esito appuntamento"} · {APPOINTMENT_SHORT_LABELS[draftType]}</b>
    {appointmentDraft.mode === "edit" ? (
      <LeadDateTimePicker value={appointmentDraft.due} disabled={busy} onChange={due => setAppointmentDraft({ ...appointmentDraft, due })} />
    ) : <>
      <p>{appointmentStamp(appointmentDraft.task.due_at)}</p>
      <AppointmentOutcomeChoices type={draftType} value={appointmentDraft.outcome} disabled={busy} beforeStart={Date.parse(appointmentDraft.task.due_at) > Date.now()} onChange={outcome => setAppointmentDraft({ ...appointmentDraft, outcome })} />
      {appointmentDraft.outcome === "held" && appointmentDraft.task.appointment_type === "demo" &&
        <label><input type="checkbox" checked={appointmentDraft.proposalMade ?? false} disabled={busy} onChange={event => setAppointmentDraft({ ...appointmentDraft, proposalMade: event.target.checked })} /> Proposta presentata</label>}
      <details><summary>Durata e nota</summary>
        {appointmentDraft.outcome && !["no_answer", "no_show"].includes(appointmentDraft.outcome) && <label>Durata effettiva (min)<input type="number" min="1" step="1" value={appointmentDraft.minutes} disabled={busy} onChange={event => setAppointmentDraft({ ...appointmentDraft, minutes: event.target.value })} /></label>}
        <label>Nota<textarea rows={2} value={appointmentDraft.note} disabled={busy} onChange={event => setAppointmentDraft({ ...appointmentDraft, note: event.target.value })} /></label>
      </details>
    </>}
    {appointmentDraft.mode === "edit" && <div className="field"><label htmlFor="lead-appt-note">Nota (facoltativa)</label><textarea id="lead-appt-note" rows={2} value={appointmentDraft.note} disabled={busy} onChange={event => setAppointmentDraft({ ...appointmentDraft, note: event.target.value })} /></div>}
    <div className="lead-appointment-actions">
      <button type="button" className="btn small" disabled={busy} onClick={() => { setAppointmentDraft(null); setAppointmentFeedback(null); }}>Annulla</button>
      <button type="button" className="btn small primary" disabled={busy || (appointmentDraft.mode === "outcome" && !appointmentDraft.outcome)} onClick={() => void saveAppointmentDraft()}>{appointmentDraft.mode === "edit" ? "Salva modifica" : "Salva esito"}</button>
      {appointmentDraft.mode === "outcome" && appointmentDraft.outcome === "qualified" && !hasClosing &&
        <button type="button" className="btn small" disabled={busy} onClick={() => void saveAppointmentDraft("demo")}>Salva e prenota closing</button>}
      {appointmentDraft.mode === "outcome" && draftType === "setting" && appointmentDraft.outcome === "answered" && !hasDiscovery &&
        <button type="button" className="btn small" disabled={busy} onClick={() => void saveAppointmentDraft("discovery")}>Salva e prenota discovery</button>}
      {appointmentDraft.mode === "outcome" && ["no_show", "no_answer"].includes(appointmentDraft.outcome) &&
        <button type="button" className="btn small" disabled={busy} onClick={() => void saveAppointmentDraft(draftType)}>{draftType === "setting" && appointmentDraft.outcome === "no_answer" ? "Non risponde e riprenota setting" : "No-show e riprenota"}</button>}
    </div>
  </div>;

  return (
    <div className="overlay lead-drawer-overlay" onClick={closeLead}>
      <div className="modal lead-drawer" role="dialog" aria-modal="true" aria-label={isNew ? "Nuovo lead" : name || "Scheda lead"} style={{width:`min(${drawerWidth}px, 96vw)`}} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-resize" role="separator" tabIndex={0} aria-label="Larghezza scheda lead" aria-orientation="vertical" aria-valuemin={520} aria-valuemax={1000} aria-valuenow={drawerWidth} onKeyDown={e => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); setDrawerWidth(w => Math.max(520, Math.min(1000, w + (e.key === "ArrowLeft" ? 40 : -40)))); } }} onPointerDown={e => { resizeStart.current = {x:e.clientX,width:drawerWidth}; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (resizeStart.current) setDrawerWidth(Math.max(520, Math.min(1000, resizeStart.current.width + resizeStart.current.x - e.clientX))); }} onPointerUp={() => { resizeStart.current = null; }} onPointerCancel={() => { resizeStart.current = null; }} />
        <header>
          <h3>{isNew ? "Nuovo lead" : name || "Lead"}</h3>
          <button className="x" onClick={closeLead}>
            ×
          </button>
        </header>
        {navigation && <div className="lead-queue-navigation"><button className="btn" disabled={busy || navigation.index === 0} onClick={() => leaveLead(navigation.onPrevious)}>← Precedente</button><span>{navigation.index + 1} di {navigation.total}</span><button className="btn" disabled={busy || navigation.index >= navigation.total - 1} onClick={() => leaveLead(navigation.onNext)}>Successivo →</button></div>}
        {!isNew && <><div className="lead-context"><span>{stages.find((s) => s.id === stageId)?.name} · {assigned || "Non assegnato"}</span>{callablePhone && <a className="btn primary" href={`tel:${callablePhone}`}>Chiama</a>}</div><nav className="lead-sections" aria-label="Sezioni del lead">{[["work", "Lavora lead"], ["data", "Dati"], ["history", "Storico"], ["contracts", "Contratti"], ...(canRecordRevenue ? [["payments", "Incassi"]] : [])].map(([id, label]) => <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</button>)}</nav></>}
        <div className="content">
          {err && <div className="notice err">{err}</div>}

          <section hidden={!isNew && section !== "work"}>
          {isNew && <>           <div className="field">
            <label>Nome</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div> </>}

          {lead && <SalesSetterHandoff key={lead.id} clientId={lead.client_id} leadId={lead.id} />}

          {!isNew && (
            <div className="lead-appointment-overview" aria-label="Appuntamenti del lead">
              <b>Appuntamenti del lead</b>
              {appointmentFeedback && <p role="status" className={appointmentFeedback.warning ? "notice warn" : "commercial-saved"}>{appointmentFeedback.text}</p>}
              {!appointmentsReady && !appointmentFeedback && <p>Caricamento appuntamenti…</p>}
              {!appointmentsReady && appointmentFeedback?.warning && <button type="button" className="btn small" onClick={() => { setAppointmentFeedback(null); void reloadAppointments(); }}>Riprova</button>}
              {appointmentsReady && activeAppointments.length === 0 && <p>Nessun appuntamento da svolgere.</p>}
              {activeAppointments.map((task) => (
                <div className="lead-appointment-overview-row" key={task.id}>
                  <span><strong>{APPOINTMENT_SHORT_LABELS[task.appointment_type ?? "discovery"]}{(appointmentAttempts.get(task.id) || 0) > 1 ? ` · ${appointmentAttempts.get(task.id)}ª prenotazione` : ""}</strong><small>{appointmentStamp(task.due_at)} · {task.appointment_host || task.assigned_to}</small></span>
                  <div className="lead-appointment-actions">
                    <button type="button" className="btn small" disabled={busy || !!appointmentDraft || !!booking} onClick={() => openAppointmentDraft(task, "edit")}>Sposta</button>
                    {Date.parse(task.due_at) <= Date.now()
                      ? <button type="button" className="btn small primary" disabled={busy || !!appointmentDraft || !!booking} onClick={() => openAppointmentDraft(task, "outcome")}>Registra esito</button>
                      : <em>Da svolgere</em>}
                  </div>
                </div>
              ))}
              {appointments.filter((task) => isAppointmentClosed(task)).slice(0, 2).map((task) => {
                const outcome = activityHistory.find((activity) => activityTaskId(activity) === task.id && (["setting_call", "discovery_call", "demo_call"].includes(activity.event_type || "")));
                const recordedOutcome = task.appointment_outcome || outcome?.outcome;
                const label = task.appointment_type === "setting" && recordedOutcome === "no_answer"
                  ? "Non risponde" : recordedOutcome ? appointmentOutcomeLabel[recordedOutcome as AppointmentOutcome] : null;
                return <div className="lead-appointment-overview-row past" key={task.id}>
                  <span><strong>{APPOINTMENT_SHORT_LABELS[task.appointment_type ?? "discovery"]} · {label || (task.appointment_status === "no_show" ? "No-show" : "Svolta")}</strong><small>{appointmentStamp(outcome?.scheduled_at || task.due_at)} · {task.appointment_host || task.assigned_to}</small></span>
                  <div className="lead-appointment-actions">
                  <button type="button" className="btn small" disabled={busy || !!appointmentDraft || !!booking} onClick={() => openAppointmentDraft(task, "outcome")}>Correggi esito</button>
                    {canRecordRevenue && task.appointment_type === "demo" && task.appointment_status === "held" && recordedOutcome !== "lost" &&
                      <button type="button" className="btn small" disabled={busy || !!appointmentDraft || !!booking} onClick={() => { setRevenueType("new"); setRevenueAppointmentId(task.id); setSection("payments"); }}>Registra incasso</button>}
                  </div>
                </div>;
              })}
              {!settingOutcomeDraft && appointmentForm}
              {booking && <div className="activity-box lead-appointment-draft" id="lead-booking-form">
                <AppointmentTime type={booking.type} value={booking.due} disabled={busy} onChange={due => setBooking({ ...booking, due })} />
                <details><summary>Opzioni</summary>
                  {booking.type !== "setting" && <label>Con chi<select value={booking.audience} disabled={busy} onChange={event => setBooking({ ...booking, audience: event.target.value as AppointmentAudience })}><option value="lead">Nuovo lead</option><option value="client">Già cliente</option></select></label>}
                  {lead?.assigned_to && meName && lead.assigned_to !== meName &&
                    <label>Chi conduce<select value={booking.host || (booking.type === "setting" ? meName : lead.assigned_to)} disabled={busy} onChange={event => setBooking({ ...booking, host: event.target.value })}>
                      <option>{lead.assigned_to}</option><option>{meName}</option>
                    </select></label>}
                  {booking.type === "discovery" && bookingReplies.length > 0 && <label>Risposta che ha generato la discovery
                    <select value={booking.sourceReplyId || ""} disabled={busy} onChange={event => setBooking({ ...booking, sourceReplyId: event.target.value || undefined })}>
                      <option value="">Nessuna risposta collegata</option>
                      {bookingReplies.map(reply => <option key={reply.id} value={reply.id}>{reply.channel} · {appointmentStamp(reply.occurred_at)}</option>)}
                    </select>
                  </label>}
                  <label>Nota<textarea rows={2} value={booking.note} disabled={busy} onChange={event => setBooking({ ...booking, note: event.target.value })} /></label>
                </details>
                <div className="lead-appointment-actions">
                  <button type="button" className="btn small" disabled={busy} onClick={() => setBooking(null)}>Annulla</button>
                  <button type="button" className="btn small primary" disabled={busy || !booking.due} onClick={() => void saveBooking()}>Conferma prenotazione</button>
                </div>
              </div>}
              {!appointmentDraft && !booking && <div className="lead-appointment-actions lead-appointment-new">
                {!pendingSetting && planAudienceAllowsProspect && <button type="button" className="btn small" disabled={busy || !appointmentsReady} onClick={() => prepareAppointment("setting")}>Prenota setting</button>}
                {!hasDiscovery && <button type="button" className="btn small" disabled={busy || !appointmentsReady} onClick={() => prepareAppointment("discovery")}>Prenota discovery</button>}
                {!hasClosing && <button type="button" className="btn small" disabled={busy || !appointmentsReady} onClick={() => prepareAppointment("demo")}>Prenota closing</button>}
              </div>}
            </div>
          )}

          {!isNew && (
            <div className="activity-box commercial-tracker quick-commercial-tracker">
              <div className="tracker-heading"><div><b>Com’è andata?</b><p>Registra l’esito del setting o di un altro contatto.</p></div><span>1 CLIC</span></div>
              {actionGroup === "contact" && pendingSetting && !settingOutcomeDraft && <div className="lead-appointment-overview-row">
                <span><strong>Setting telefonico</strong><small>{appointmentStamp(pendingSetting.due_at)}</small></span>
                {settingDue ? <button type="button" className="btn small primary" disabled={busy || !!appointmentDraft || !!booking} onClick={() => openAppointmentDraft(pendingSetting, "outcome")}>Registra esito setting</button>
                  : <small>Esito disponibile dall’orario fissato</small>}
              </div>}
              {settingOutcomeDraft && appointmentFeedback?.warning && <p role="alert" className="notice warn">{appointmentFeedback.text}</p>}
              {settingOutcomeDraft && appointmentForm}
              {actionGroup === "contact" && !settingOutcomeDraft && !settingDue && <div className="field quick-call-type"><label htmlFor="quick-call-type">Tipo di contatto</label><select id="quick-call-type" value={contactType} onChange={e => setCallTypeOverride(e.target.value as ContactType)}><option value="setting">Setting</option><option value="lead">Richiamo</option><option value="outbound">Outbound</option><option value="client">Già cliente</option><option value="other">Altro</option></select></div>}
              {((actionGroup === "discovery" && hasDiscovery) || (actionGroup === "closing" && hasClosing)) && <p>Per le call in agenda usa «Registra esito» in Appuntamenti del lead.</p>}
              <div className="lead-action-groups">{[["contact", "Contatto"], ["discovery", "Discovery"], ["closing", "Closing"], ["other", "Altre azioni"]].map(([id, label]) => <button type="button" key={id} aria-pressed={actionGroup === id} onClick={() => { setActionGroup(id); setQuickAction(null); setClosingAction(null); setManualCallAt(""); }}>{label}</button>)}</div>
              <div className={"commercial-quick-actions action-group-" + actionGroup}>
                {!settingDue && !settingOutcomeDraft && <button data-action-group="contact" type="button" disabled={busy} onClick={() => void recordQuickActivity("no_answer")}><b>Non risponde</b><small>Registra un tentativo</small></button>}
                {!settingDue && !settingOutcomeDraft && <button data-action-group="contact" type="button" disabled={busy} onClick={() => void recordQuickActivity("answered")}><b>Ha risposto</b><small>Call senza discovery</small></button>}
                {!settingDue && !settingOutcomeDraft && contactType === "setting" && <button data-action-group="contact" type="button" disabled={busy} onClick={() => void recordQuickActivity("not_interested")}><b>Non interessato</b><small>Registra l’esito del setting</small></button>}
                {notInTargetStage && notInTargetStage.id !== stageId && !settingOutcomeDraft && <button data-action-group="contact" type="button" disabled={busy} onClick={() => void markNotInTarget()}><b>Non in target</b><small>Sposta nella colonna dedicata</small></button>}
                <button
                  data-action-group="contact"
                  type="button"
                  disabled={busy || !appointmentsReady || hasDiscovery || !!appointmentDraft || !!booking}
                  className="accent"
                  onClick={() => prepareAppointment("discovery")}
                >
                  <b>Prenota discovery</b><small>Vai a data e ora</small>
                </button>
                {!hasDiscovery && <button data-action-group="discovery" type="button" disabled={busy || !appointmentsReady || hasDiscovery || !!appointmentDraft || !!booking} className={quickAction === "qualified" ? "active success" : "success"} onClick={() => { setClosingAction(null); setQuickAction("qualified"); }}><b>In target</b><small>Non era in calendario</small></button>}
                {!hasDiscovery && <button data-action-group="discovery" type="button" disabled={busy || !appointmentsReady || hasDiscovery || !!appointmentDraft || !!booking} className={quickAction === "not_qualified" ? "active" : ""} onClick={() => { setClosingAction(null); setQuickAction("not_qualified"); }}><b>Fuori target</b><small>Non era in calendario</small></button>}
                <button data-action-group="other" type="button" disabled={busy} onClick={() => void recordQuickActivity("completed")}><b>Follow-up fatto</b><small>Registra il contatto</small></button>
                <button data-action-group="discovery" type="button" disabled={busy || !appointmentsReady || hasClosing || !!appointmentDraft || !!booking} className="accent" onClick={() => prepareAppointment("demo")}><b>Prenota closing</b><small>Vai a data e ora</small></button>
                {!hasClosing && <button data-action-group="closing" type="button" disabled={busy || !appointmentsReady || hasClosing || !!appointmentDraft || !!booking} className={closingAction === "held" ? "active success" : "success"} onClick={() => { setQuickAction(null); setClosingAction("held"); }}><b>Closing svolta</b><small>Non era in calendario</small></button>}
                {!hasClosing && <button data-action-group="closing" type="button" disabled={busy || !appointmentsReady || hasClosing || !!appointmentDraft || !!booking} className={closingAction === "no_show" ? "active danger" : "danger"} onClick={() => { setQuickAction(null); setClosingAction("no_show"); }}><b>No-show closing</b><small>Non era in calendario</small></button>}
                <button data-action-group="other" type="button" disabled={busy} className={quickAction === "lost" ? "active danger" : "danger"} onClick={() => { setClosingAction(null); setQuickAction("lost"); }}><b>Perso</b><small>Indica il motivo</small></button>
              </div>
              {quickAction && <div className="commercial-quick-detail">
                {quickAction !== "lost" && <details><summary>La call è di un altro giorno?</summary><LeadDateTimePicker value={manualCallAt} onChange={setManualCallAt} disabled={busy} /></details>}

                {quickAction !== "lost" ? <><label>Durata discovery</label><div className="duration-chips">{[5, 10, 15, 20, 30, 45, 60].map((minutes) => <button type="button" key={minutes} className={commercialMinutes === String(minutes) ? "active" : ""} onClick={() => setCommercialMinutes(String(minutes))}>{minutes} min</button>)}</div></> : <div className="field"><label>Motivo della perdita</label><select value={lostReason} onChange={(e) => setLostReason(e.target.value)}><option value="">— scegli —</option><option>Prezzo troppo alto</option><option>Nessuna differenza percepita</option><option>Ha scelto un concorrente</option><option>Non interessato più</option><option>Irraggiungibile</option><option>Budget fermo</option><option>Altro</option></select></div>}
                <div className="field"><label>Nota <small>(facoltativa)</small></label><input value={commercialNote} onChange={(e) => setCommercialNote(e.target.value)} placeholder="Solo se serve ricordare qualcosa" /></div>
                <div className="commercial-quick-confirm"><button className="btn" type="button" onClick={() => setQuickAction(null)}>Annulla</button><button className="btn primary" type="button" disabled={busy} onClick={() => void recordQuickActivity(quickAction)}>{busy ? "Salvataggio…" : "Conferma esito"}</button></div>
              </div>}
              {closingAction && <div className="commercial-quick-detail">
                {<details><summary>La call è di un altro giorno?</summary><LeadDateTimePicker value={manualCallAt} onChange={setManualCallAt} disabled={busy} /></details>}

                <p className="quick-closing-explanation">La closing verrà registrata come non pianificata.</p>
                {closingAction === "held" && <><label>Durata closing</label><div className="duration-chips">{[15, 30, 45, 60, 75, 90].map((minutes) => <button type="button" key={minutes} className={closingMinutes === String(minutes) ? "active" : ""} onClick={() => setClosingMinutes(String(minutes))}>{minutes} min</button>)}</div></>}
                <div className="field"><label>Nota <small>(facoltativa)</small></label><input value={commercialNote} onChange={(e) => setCommercialNote(e.target.value)} placeholder="Esito o dettaglio utile" /></div>
                {closingAction === "held" && canRecordRevenue && <p className="quick-closing-explanation"><b>Se il lead ha pagato:</b> dopo questo passaggio apri Incassi e registra il pagamento. La prima cauzione lo segnerà automaticamente come vendita vinta.</p>}
                <div className="commercial-quick-confirm"><button className="btn" type="button" onClick={() => setClosingAction(null)}>Annulla</button><button className="btn primary" type="button" disabled={busy} onClick={() => void recordClosingOutcome(closingAction)}>{busy ? "Salvataggio…" : "Conferma esito closing"}</button></div>
              </div>}
              {activitySaved && <div className="commercial-saved">✓ {activitySaved}</div>}

            </div>
          )}
          {!isNew && (
            <div className="field new-lead-note">
              <label>Aggiungi una nuova nota</label>
              <textarea
                value={quickNote}
                onChange={(e) => setQuickNote(e.target.value)}
                placeholder="Es. Richiamato: vuole essere ricontattato venerdì dopo le 16."
                rows={3}
              />
              <small>
                Viene salvata come aggiornamento separato con data e ora. La card
                si aggiorna e il lead conta come lavorato oggi.
              </small>
              <button className="btn small primary" type="button" disabled={busy || !quickNote.trim()} onClick={() => void saveQuickNote()} style={{ marginTop: 9 }}>
                {busy ? "Salvataggio…" : "Salva nota"}
              </button>
            </div>
          )}
          {noteSaved && <p role="status" className="commercial-saved">✓ {noteSaved}</p>}
          {!isNew && (
            <div className="activity-box lead-plan-box" id="lead-next-step">
              <b>Pianifica un richiamo</b>
              <LeadDateTimePicker value={planDue} onChange={setPlanDue} disabled={busy} />
              <div className="field"><label>Cosa fare <small>(facoltativo)</small></label><input value={planTitle} onChange={(e) => setPlanTitle(e.target.value)} placeholder="Es. Richiamare dopo le 18" /></div>
              <label className={`task-priority-option compact${planPriority ? " active" : ""}`}><input type="checkbox" checked={planPriority} onChange={(e) => setPlanPriority(e.target.checked)} /><span><b>Task prioritaria</b><small>Evidenzia il richiamo come prioritario.</small></span></label>
              <div className="field"><label>Dettagli <small>(facoltativo)</small></label><input value={planNote} onChange={(e) => setPlanNote(e.target.value)} placeholder="Nota utile prima del contatto" /></div>
              <button type="button" className="btn small" disabled={busy || !planDue} onClick={() => void savePlan()}>Salva richiamo</button>
            </div>
          )}
          {!isNew && followUps.length > 0 && <section className="lead-followups"><h4>Richiami pianificati</h4>{followUps.map((task) => <div key={task.id}><span><b>{task.title}</b><small>{appointmentStamp(task.due_at)}</small></span><button type="button" className="btn small" disabled={busy} onClick={() => void completeFollowUp(task)}>Fatto</button></div>)}</section>}
          </section><section hidden={!isNew && section !== "data"}>
          {!isNew && <>           <div className="field">
            <label>Nome</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div> </>}
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Telefono</label>
              <div className="lead-phone-control">
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
                {callablePhone && (
                  <a
                    className="btn primary lead-call-button"
                    href={`tel:${callablePhone}`}
                    aria-label={`Chiama ${phone.trim()}`}
                  >
                    Chiama
                  </a>
                )}
              </div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="lead-pipeline">Pipeline</label>
              <select id="lead-pipeline" value={selectedPipelineId} disabled={busy || !availablePipelines.length}
                onChange={(event) => setSelectedPipelineId(event.target.value)}>
                {!availablePipelines.length && <option value={originalPipelineId}>Pipeline attuale</option>}
                {availablePipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
              </select>
              {pipelineError && <small role="alert">{pipelineError}</small>}
              {selectedPipelineId !== originalPipelineId && <small>Premi Salva per spostare il lead in cima alla stessa fase della pipeline scelta. Note, attività e contratti rimangono collegati.</small>}
            </div>
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Fase</label>
              {isNew ? (
                <input value="SETTING" readOnly />
              ) : (
                <select
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>
                Assegnata a
                {meName && meName.trim() && assigned.trim() !== meName.trim() && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setAssigned(meName.trim())}
                  >
                    Assegna a me
                  </button>
                )}
              </label>
              <input
                value={assigned}
                onChange={(e) => setAssigned(e.target.value)}
                placeholder="es. Asmaa"
                disabled={!canReassign}
              />
            </div>
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Fonte</label>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {source && !["Instantly", "DM Instagram", "DM Facebook", "DM LinkedIn", "DM Altro", "Meta Ads", "Cold call", "Altro"].includes(source) && <option value={source}>{source} · storico</option>}
                <option value="Instantly">Instantly · email</option>
                <option value="DM Instagram">DM Instagram</option>
                <option value="DM Facebook">DM Facebook</option>
                <option value="DM LinkedIn">DM LinkedIn</option>
                <option value="DM Altro">DM altro</option><option value="Meta Ads">Meta Ads</option><option value="Cold call">Chiamata a freddo</option><option value="Altro">Altro</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Valore (€)</label>
              <input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Prossima azione</label>
              <input
                type="date"
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Chiusura prevista</label>
              <input
                type="date"
                value={closingDate}
                onChange={(e) => setClosingDate(e.target.value)}
              />
            </div>
          </div>
          {stages.find((s) => s.id === stageId)?.name === "LOST" && (
            <div className="field">
              <label>Motivo della perdita</label>
              <select
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              >
                <option value="">— scegli —</option>
                <option>Prezzo troppo alto</option>
                <option>Nessuna differenza percepita</option>
                <option>Ha scelto un concorrente</option>
                <option>Non interessato più</option>
                <option>Irraggiungibile</option>
                <option>Budget fermo</option>
                <option>Altro</option>
              </select>
            </div>
          )}
          <div className="field">
            <label>Etichette (separate da virgola, es. VIP, caldo)</label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="es. VIP, da richiamare"
            />
          </div>
          {!isNew && canDelete && (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              Creato il{" "}
              {new Date(lead!.created_at).toLocaleString("it-IT")}
            </div>
          )}

          </section>
          <section hidden={isNew || section !== "history"}>
            {lead && section === "history" && <LeadTimeline lead={lead} stages={stages} notes={splitNoteHistory(notes)} contracts={contracts} payments={canRecordRevenue ? payments : []} error={historyError || paymentsError} activities={activityHistory.map(activity => {
                const isBooking = activity.event_type === "discovery_booked" || activity.event_type === "demo_booked";
                const isReschedule = activity.event_type === "appointment_rescheduled";
                const previousAt = typeof activity.details?.previous_at === "string" ? activity.details.previous_at : null;
                const nextAt = typeof activity.details?.new_at === "string" ? activity.details.new_at : activity.scheduled_at;
                const attempt = isBooking ? appointmentAttempts.get(activityTaskId(activity)) : null;
                return {id:`activity-${activity.id}`, at:activity.occurred_at || activity.created_at, content:<div><span><b>{EVENT_LABELS[activity.event_type || ""] || activity.activity_type}{isBooking && attempt && attempt > 1 ? ` · ${attempt}ª prenotazione` : ""}</b><small>Avvenuto il {appointmentStamp(activity.occurred_at || activity.created_at)}</small><small>Registrato il {appointmentStamp(activity.created_at)} · {activity.created_by || "CRM"}</small>{isBooking && activity.scheduled_at && <small>Fissata per il {appointmentStamp(activity.scheduled_at)}</small>}{isReschedule && previousAt && nextAt && <small>Spostata dal {appointmentStamp(previousAt)} al {appointmentStamp(nextAt)}</small>}{!isBooking && !isReschedule && <small>{OUTCOME_LABELS[activity.outcome || ""] || activity.outcome || "—"}{activity.scheduled_at ? ` · Appuntamento del ${appointmentStamp(activity.scheduled_at)}` : ""}</small>}{activity.note && <small>{activity.note}</small>}</span>{!activityTaskId(activity) && <button type="button" aria-label="Elimina registrazione" disabled={busy} onClick={() => void removeCommercialActivity(activity)}>×</button>}</div>};
            })} />}
          </section>
          <section hidden={isNew || section !== "payments"}>          {!isNew && canRecordRevenue && (
            <div className="activity-box revenue-tracker">
              <div className="tracker-heading"><div><b>Registra un incasso</b><p>Firma e denaro ricevuto restano separati: qui entra solo ciò che è realmente incassato. Registra soltanto pagamenti effettivamente ricevuti.</p></div><span>€</span></div>
              <div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Tipo</label><select disabled={busy} value={revenueType} onChange={(e) => setRevenueType(e.target.value as SalesRevenueEvent["revenue_type"])}><option value="new">Nuovo cliente</option><option value="renewal">Rinnovo</option><option value="upsell">Upsell</option></select></div><div className="field" style={{ flex: 1 }}><label>Incassato (€)</label><input disabled={busy} type="number" min="0" step="0.01" value={revenueAmount} onChange={(e) => setRevenueAmount(e.target.value)} /></div></div>
              {revenueType === "new" && appointments.some(task => task.appointment_type === "demo" && task.appointment_status === "held") &&
                <label>Closing collegata <small>(facoltativo)</small><select value={revenueAppointmentId} disabled={busy} onChange={event => setRevenueAppointmentId(event.target.value)}>
                  <option value="">Seleziona se da una closing</option>
                  {appointments.filter(task => task.appointment_type === "demo" && task.appointment_status === "held").map(task => <option value={task.id} key={task.id}>{appointmentStamp(task.due_at)}</option>)}
                </select></label>}
              <div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Valore totale contratto (€)</label><input disabled={busy} type="number" min="0" step="0.01" value={revenueContractValue} onChange={(e) => setRevenueContractValue(e.target.value)} placeholder="Facoltativo" /></div><div className="field" style={{ flex: 1 }}><label>Data e ora incasso</label><input disabled={busy} type="datetime-local" value={revenueAt} onChange={(e) => setRevenueAt(e.target.value)} /></div></div>
              <div className="field"><label>Nota <small>(facoltativa)</small></label><input disabled={busy} value={revenueNote} onChange={(e) => setRevenueNote(e.target.value)} placeholder="Es. prima rata, saldo…" /></div>
              {revenueSaved && <div className="commercial-saved" role="status">✓ {revenueSaved}</div>}
              {revenueError && <div className="notice err" role="alert">{revenueError}</div>}
              <p className="muted">Per salvare il pagamento premi «Registra incasso». Il pulsante «Salva» in fondo aggiorna solo la scheda lead.</p>
              <button className="btn primary tracker-save" type="button" disabled={busy || !revenueAmount} onClick={() => void recordRevenue()}>{busy ? "Registrazione…" : "Registra incasso"}</button>
            </div>
          )}
<h4>Pagamenti registrati</h4>{!paymentsLoading && !paymentsError && payments.length > 0 && <p><b>Totale incassato: {payments.filter(p => p.status === "collected").reduce((sum,p) => sum + Number(p.amount),0).toLocaleString("it-IT", {style:"currency",currency:"EUR"})}</b></p>}{paymentsLoading ? <p>Caricamento pagamenti…</p> : paymentsError ? <p role="alert">{paymentsError}</p> : payments.length ? payments.map((payment) => <div className="lead-payment-row" key={payment.id}><b>{payment.amount.toLocaleString("it-IT", {style:"currency", currency:"EUR"})}</b><span>{appointmentStamp(payment.occurred_at)} · {payment.status === "collected" ? "Incassato" : payment.status === "cancelled" ? "Annullato" : "Previsto"}</span><small>{payment.created_by} {payment.note}</small></div>) : <p>Nessun pagamento visibile per questo lead.</p>}</section>
          <section hidden={isNew || section !== "contracts"}>
          {!isNew && (
            <div className="contracts-box">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <b>📄 Contratti</b>
                <button className="btn small" onClick={openCtForm}>
                  + Nuovo contratto
                </button>
              </div>
              {contracts.length === 0 && !ctForm && (
                <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 6 }}>
                  Nessun contratto per questo lead.
                </div>
              )}
              {contracts.map((c) => (
                <div className="contract-row" key={c.id}>
                  <div>
                    <b>{c.title}</b>
                    <div className="contract-meta">
                      {c.status === "signed"
                        ? `✓ Firmato da ${c.signed_name ?? "—"} il ${
                            c.signed_at ? new Date(c.signed_at).toLocaleString("it-IT") : ""
                          }`
                        : c.status === "sent"
                        ? `📤 Inviato a ${c.sent_to ?? "—"}`
                        : `📝 Bozza · a ${c.sent_to ?? "—"}`}
                    </div>
                    {c.client_data &&
                      (() => {
                        try {
                          const data = JSON.parse(c.client_data);
                          const keys = Object.keys(data).filter(
                            (k) => String(data[k] ?? "").trim()
                          );
                          if (keys.length)
                            return (
                              <div className="contract-meta" style={{ marginTop: 4 }}>
                                {keys.map((k) => (
                                  <div key={k}>
                                    {k}: <b>{String(data[k])}</b>
                                  </div>
                                ))}
                              </div>
                            );
                        } catch {
                          return null;
                        }
                      })()}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {c.status !== "signed" && (
                      <>
                        <button
                          className="btn small"
                          onClick={() => {
                            navigator.clipboard.writeText(firmLink(c));
                            alert("Link di firma copiato. Incollalo nella mail al cliente.");
                          }}
                        >
                          Copia link
                        </button>
                        <a
                          className="btn small"
                          style={{ textDecoration: "none" }}
                          href={`mailto:${encodeURIComponent(c.sent_to ?? "")}?subject=${encodeURIComponent(
                            c.title
                          )}&body=${encodeURIComponent(
                            isPrivateDeed(c.body)
                              ? `Buongiorno,

ti invio la scrittura privata da firmare: ${firmLink(c)}

È già compilata con i tuoi dati: basta aprire il link, controllarli e firmare con il dito.

Grazie!`
                              : `Buongiorno,

ti invio il contratto da firmare: ${firmLink(c)}

Basta aprire il link, compilare i campi e firmare con il dito.

Grazie!`
                          )}`}
                        >
                          Invia email
                        </a>
                        <button className="btn small" onClick={() => markSent(c)}>
                          Segna inviato
                        </button>
                      </>
                    )}
                    {c.status === "signed" && (
                      <button
                        className="btn small"
                        onClick={() => openSignedContractPdf(c)}
                      >
                        📄 Scarica PDF firmato
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {ctForm && (
                <div className="ct-form">
                  <div className="field">
                    <label>Modello</label>
                    <select value={ctTpl} onChange={(e) => chooseCtTemplate(e.target.value)}>
                      {templates.map((tp) => (
                        <option key={tp.id} value={tp.id}>
                          {tp.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Titolo contratto</label>
                    <input value={ctTitle} onChange={(e) => setCtTitle(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Email del cliente</label>
                    <input value={ctTo} onChange={(e) => setCtTo(e.target.value)} />
                  </div>
                  {!deedTemplate && (
                    <div className="field">
                      <label>Inizio del servizio</label>
                      <select
                        value={ctStartMode}
                        onChange={(e) =>
                          setCtStartMode(e.target.value as "automatic" | "custom")
                        }
                      >
                        <option value="automatic">Automatico — dalla data di firma</option>
                        <option value="custom">Data di inizio personalizzata</option>
                      </select>
                      <small style={{ color: "var(--muted)" }}>
                        La data della firma resta quella effettiva. La durata decorre
                        dalla data di inizio scelta.
                      </small>
                    </div>
                  )}
                  {deedTemplate && (
                    <small style={{ display: "block", margin: "0 0 10px", color: "var(--muted)" }}>
                      Compila i dati del cliente: il lead riceve la scrittura privata già
                      compilata e deve solo firmarla. La data si inserisce da sola alla firma.
                    </small>
                  )}
                  {!deedTemplate && ctStartMode === "custom" && (
                    <div className="field">
                      <label>Data di inizio del servizio</label>
                      <input
                        type="date"
                        value={ctStartDate}
                        onChange={(e) => setCtStartDate(e.target.value)}
                      />
                    </div>
                  )}
                  {placeholders
                    .filter((ph) => !AUTOMATIC_CONTRACT_FIELDS.has(ph))
                    .map((ph) => {
                      const deedField = deedTemplate ? PRIVATE_DEED_TEMPLATE.sellerFields[ph] : undefined;
                      return (
                        <div className="field" key={ph}>
                          <label>{deedField?.label ?? ph.replace(/_/g, " ")}</label>
                          <input
                            value={ctVals[ph] ?? ""}
                            placeholder={deedField?.hint}
                            onChange={(e) =>
                              setCtVals((prev) => ({ ...prev, [ph]: e.target.value }))
                            }
                          />
                        </div>
                      );
                    })}
                  {ctErr && <div className="notice err">{ctErr}</div>}
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="btn" onClick={() => setCtForm(false)}>
                      Annulla
                    </button>
                    <button className="btn primary" onClick={createContract}>
                      Genera contratto
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          </section>
        </div>
        {pendingLeave && <div className="lead-unsaved-overlay" onClick={e => e.stopPropagation()}><section className="lead-unsaved-dialog" role="alertdialog" aria-modal="true" aria-label="Modifiche non salvate"><h3>Ci sono modifiche non salvate</h3><p>Rimani nella scheda per completare il salvataggio. Se esci, le modifiche non confermate verranno scartate.</p>{revenueAmount && <p>La bozza dell’incasso resta in questo browser, ma non è un pagamento registrato.</p>}<div><button className="btn primary" onClick={() => setPendingLeave(null)}>Rimani nella scheda</button><button className="btn" onClick={() => { const leave = pendingLeave; setPendingLeave(null); leave(); }}>Esci senza salvare</button></div></section></div>}
        <footer>
          {!isNew && canDelete && section === "data" && (
            <button
              className="btn danger"
              onClick={remove}
              disabled={busy}
              style={{ marginRight: "auto" }}
            >
              Elimina
            </button>
          )}
          <button className="btn" onClick={closeLead} disabled={busy}>
            Chiudi
          </button>
          {navigation && navigation.index < navigation.total - 1 && (section === "work" || section === "data") && <button className="btn" disabled={busy || !!appointmentDraft || !!booking} onClick={() => {
            if (commercialNote.trim() || revenueAmount) { setErr("Registra prima l’esito o l’incasso compilato, oppure svuota la relativa bozza."); return; }
            void save(() => { onUpdated?.(); navigation.onNext(); });
          }}>Salva e successivo →</button>}
          {(isNew || section === "work" || section === "data") && <button className="btn primary" onClick={() => void save()} disabled={busy || !!appointmentDraft || !!booking}>
            {busy ? "Salvataggio…" : "Salva"}
          </button>}
        </footer>
      </div>
    </div>
  );
}
