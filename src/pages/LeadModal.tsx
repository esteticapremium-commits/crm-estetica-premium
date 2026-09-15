import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { romeStamp } from "../dates";
import { normalizeSpecificApprovalSignature, openSignedContractPdf } from "../contractPdf";
import { TRIAL_CONTRACT_TEMPLATE } from "../defaultContractTemplates";
import { CHANNEL_LABELS, EVENT_LABELS, OUTCOME_LABELS, quickActivityKey, revenueKey } from "../salesKpi";
import { createAppointment, pendingAppointments, recordAppointmentOutcome, type AppointmentAudience } from "../appointments";
import type { Contract, ContractTemplate, Lead, LeadActivity, SalesRevenueEvent, SalesTask, Stage } from "../types";

const BUILT_IN_TRIAL_TEMPLATE_ID = "built-in-trial-contract";
const NOTE_SEPARATOR = "\n\n---\n\n";
const localDateTime = (date: Date) => { const pad = (value: number) => String(value).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const AUTOMATIC_CONTRACT_FIELDS = new Set([
  "data_oggi",
  "data_firma",
  "data_inizio",
  "data_decorrenza",
  "data_inizio_servizio",
]);

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
}: Props) {
  const isNew = !lead;
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
  const [commercialNote, setCommercialNote] = useState("");
  const [commercialMinutes, setCommercialMinutes] = useState("");
  const [activitySaved, setActivitySaved] = useState("");
  const [activityHistory, setActivityHistory] = useState<LeadActivity[]>([]);
  const [appointments, setAppointments] = useState<SalesTask[]>([]);
  const [callType, setCallType] = useState<"lead" | "outbound" | "client" | "other">("lead");
  const commercialActionLock = useRef(false);
  const revenueLock = useRef(false);
  const planLock = useRef(false);
  const [planAudience, setPlanAudience] = useState<AppointmentAudience>("lead");
  const [planKind, setPlanKind] = useState<"task" | "appointment">("task");
  const [planAppointmentType, setPlanAppointmentType] = useState<"discovery" | "demo">("discovery");
  const [planTitle, setPlanTitle] = useState("");
  const [planDue, setPlanDue] = useState("");
  const [planNote, setPlanNote] = useState("");
  const [planPriority, setPlanPriority] = useState(false);
  const [revenueType, setRevenueType] = useState<SalesRevenueEvent["revenue_type"]>("new");
  const [revenueAmount, setRevenueAmount] = useState("");
  const [revenueContractValue, setRevenueContractValue] = useState("");
  const [revenueAt, setRevenueAt] = useState(() => localDateTime(new Date()));
  const [revenueNote, setRevenueNote] = useState("");
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
      .order("name")
      .then(({ data }) => {
        const list = (data as ContractTemplate[]) ?? [];
        const trialTemplate: ContractTemplate = {
          id: BUILT_IN_TRIAL_TEMPLATE_ID,
          client_id: lead.client_id,
          name: TRIAL_CONTRACT_TEMPLATE.name,
          body: TRIAL_CONTRACT_TEMPLATE.body,
          client_fields: TRIAL_CONTRACT_TEMPLATE.clientFields,
          created_at: "",
        };
        const templatesWithTrial = list.some((t) => t.name === trialTemplate.name)
          ? list
          : [trialTemplate, ...list];
        setTemplates(templatesWithTrial);
        setCtTpl(templatesWithTrial[0]?.id ?? "");
      });
  }, [lead?.id]);

  async function reloadActivityHistory() {
    if (!lead) return;
    const { data } = await supabase.from("lead_activities").select("*").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(20);
    setActivityHistory((data as LeadActivity[]) ?? []);
  }

  useEffect(() => {
    if (!lead) return;
    void reloadActivityHistory();
    // Appuntamenti ancora da chiudere: se ce n'è uno, l'esito registrato da qui
    // deve aggiornare quello invece di creare una seconda attività.
    void pendingAppointments(lead.client_id, lead.id).then(setAppointments);
  }, [lead?.id]);

  // Solo gli appuntamenti la cui ora è già passata possono avere un esito: una
  // discovery fissata per la settimana prossima non deve essere chiusa da un
  // "non risponde" registrato oggi.
  const dueAppointments = appointments.filter((task) => new Date(task.due_at).getTime() <= Date.now());
  const openDiscovery = dueAppointments.find((task) => task.appointment_type === "discovery") ?? null;
  const openDemo = dueAppointments.find((task) => task.appointment_type === "demo") ?? null;

  async function recordQuickActivity(outcome: "no_answer" | "qualified" | "not_qualified" | "completed" | "lost") {
    if (!lead || commercialActionLock.current) return;
    const isDiscovery = ["no_answer", "qualified", "not_qualified"].includes(outcome);
    const minutes = Number(commercialMinutes) || 0;
    if (["qualified", "not_qualified"].includes(outcome) && minutes <= 0) return setErr("Seleziona la durata della discovery.");
    if (outcome === "lost" && !lostReason.trim()) return setErr("Scegli il motivo della perdita.");
    commercialActionLock.current = true;
    setBusy(true); setErr(null); setActivitySaved("");

    // Se la discovery era già in agenda, l'esito appartiene a quell'appuntamento:
    // viene registrato sulla sua chiave, così lo stesso incontro conta una volta
    // sola anche se l'esito lo segni da qui invece che dal Calendario.
    const linkedAppointment = isDiscovery ? openDiscovery : null;
    if (linkedAppointment) {
      const tracked = await recordAppointmentOutcome(linkedAppointment, outcome as "qualified" | "not_qualified" | "no_answer", meName?.trim() || "", lead.pipeline_id ?? null, minutes || undefined);
      setBusy(false); commercialActionLock.current = false;
      if (!tracked.ok) return setErr(tracked.error || "Esito non registrato.");
      setAppointments((current) => current.filter((task) => task.id !== linkedAppointment.id));
      setCommercialNote(""); setCommercialMinutes(""); setQuickAction(null);
      setActivitySaved(outcome === "no_answer" ? "Appuntamento segnato come non risposto" : "Esito della discovery in agenda registrato");
      await reloadActivityHistory();
      return;
    }

    const occurredAt = new Date();
    const eventType = isDiscovery ? "discovery_call" : outcome === "lost" ? "sale_outcome" : "follow_up";
    // Chiave deterministica: due clic sullo stesso esito nello stesso minuto sono
    // lo stesso evento e il database rifiuta il secondo. Un tentativo reale più
    // tardi ha una chiave diversa e viene registrato normalmente.
    const eventKey = quickActivityKey(lead.id, eventType, outcome, occurredAt);
    const result = await supabase.from("lead_activities").upsert({
      lead_id: lead.id,
      client_id: lead.client_id,
      pipeline_id: lead.pipeline_id,
      activity_type: isDiscovery ? "call" : "follow_up",
      event_type: eventType,
      channel: isDiscovery ? "phone" : "other",
      call_type: isDiscovery ? callType : null,
      outcome,
      duration_minutes: minutes || null,
      occurred_at: occurredAt.toISOString(),
      note: commercialNote.trim() || (outcome === "lost" ? lostReason.trim() : null),
      next_action_date: nextAction.trim() || null,
      created_by: meName?.trim() || null,
      event_key: eventKey,
    }, { onConflict: "client_id,event_key" }).select("*").single();
    if (result.error) {
      setBusy(false); commercialActionLock.current = false;
      return setErr("Attività non registrata: " + result.error.message);
    }
    if (outcome === "lost") {
      const lostStage = stages.find((stage) => stage.name === "LOST");
      const update = await supabase.from("leads").update({ lost_reason: lostReason.trim(), ...(lostStage ? { stage_id: lostStage.id } : {}) }).eq("id", lead.id);
      if (update.error) {
        await supabase.from("lead_activities").delete().eq("client_id", lead.client_id).eq("event_key", eventKey);
        setBusy(false); commercialActionLock.current = false;
        return setErr("Esito non registrato: " + update.error.message);
      }
      if (lostStage) setStageId(lostStage.id);
    }
    setActivityHistory((current) => [result.data as LeadActivity, ...current.filter((item) => item.id !== (result.data as LeadActivity).id)]);
    setCommercialNote(""); setCommercialMinutes(""); setQuickAction(null);
    setActivitySaved(outcome === "no_answer" ? "Tentativo registrato" : outcome === "completed" ? "Follow-up registrato" : outcome === "lost" ? "Lead segnato come perso" : "Discovery registrata");
    setBusy(false); commercialActionLock.current = false;
  }

  function prepareDemo() {
    setPlanKind("appointment");
    setPlanAppointmentType("demo");
    setPlanTitle(`Closing video — ${lead?.name || "Lead"}`);
    requestAnimationFrame(() => document.getElementById("lead-next-step")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  async function removeCommercialActivity(activity: LeadActivity) {
    if (!confirm("Eliminare questa registrazione dai KPI?")) return;
    setBusy(true);
    const result = await supabase.from("lead_activities").delete().eq("id", activity.id); setBusy(false);
    if (result.error) return setErr("Registrazione non eliminata: " + result.error.message);
    setActivityHistory((current) => current.filter((item) => item.id !== activity.id));
  }

  async function recordRevenue() {
    if (!lead || revenueLock.current) return;
    if (Number(revenueAmount) <= 0 || !revenueAt) return setErr("Inserisci importo incassato, data e ora.");
    revenueLock.current = true; setBusy(true); setErr(null);
    const amount = Number(revenueAmount);
    const occurredAt = new Date(revenueAt).toISOString();
    // Stesso lead, stesso tipo, stesso momento e stesso importo = stesso incasso.
    // Un secondo pagamento reale differisce sempre per importo o per orario.
    const key = revenueKey(lead.id, revenueType, occurredAt, amount);
    const result = await supabase.from("sales_revenue_events").upsert({
      client_id: lead.client_id, pipeline_id: lead.pipeline_id, lead_id: lead.id,
      revenue_type: revenueType, amount, contract_value: Number(revenueContractValue) || null,
      status: "collected", occurred_at: occurredAt, assigned_to: lead.assigned_to || meName || null,
      created_by: meName || null, note: revenueNote.trim() || null, event_key: key,
    }, { onConflict: "client_id,event_key" });
    if (result.error) { revenueLock.current = false; setBusy(false); return setErr("Incasso non registrato: " + result.error.message); }
    // Il valore aggiornato resta la previsione corrente del lead. I KPI già
    // chiusi non cambiano: leggono il valore congelato sul contratto firmato.
    if (revenueType === "new" && Number(revenueContractValue) > 0) {
      const valueResult = await supabase.from("leads").update({ value: Number(revenueContractValue) }).eq("id", lead.id);
      if (valueResult.error) { revenueLock.current = false; setBusy(false); return setErr("Incasso registrato, ma valore contratto non aggiornato: " + valueResult.error.message); }
      setValue(String(Number(revenueContractValue)));
    }
    revenueLock.current = false; setBusy(false);
    setRevenueAmount(""); setRevenueContractValue(""); setRevenueNote(""); setRevenueAt(localDateTime(new Date()));
  }

  // placeholders del modello selezionato
  const tpl = templates.find((x) => x.id === ctTpl);
  const placeholders = [
    ...new Set((tpl?.body ?? "").match(/\{\{(\w+)\}\}/g) ?? []),
  ].map((ph) => ph.slice(2, -2));

  function openCtForm() {
    const defaults: Record<string, string> = {
      nome_lead: lead?.name ?? "",
      email_lead: lead?.email ?? "",
      telefono_lead: lead?.phone ?? "",
      nome_venditore: meName ?? "",
    };
    setCtVals(defaults);
    setCtTitle(`Contratto — ${lead?.name ?? "lead"}`);
    setCtTo(lead?.email ?? "");
    setCtStartMode("automatic");
    setCtStartDate("");
    setCtForm(true);
  }

  async function createContract() {
    const cid = clientId ?? lead?.client_id;
    if (!lead || !cid) return setErr("Cliente mancante: riapri la scheda del lead.");
    if (!ctTpl) return setErr("Scegli un modello.");
    if (ctStartMode === "custom" && !ctStartDate) {
      return setErr("Seleziona la data di inizio del servizio.");
    }
    setErr(null);
    let body = normalizeSpecificApprovalSignature(tpl?.body ?? "");
    const today = new Date().toLocaleDateString("it-IT");
    const serviceStart =
      ctStartMode === "custom" ? formatContractDate(ctStartDate) : today;

    if (ctStartMode === "custom") {
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
      ...ctVals,
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
        template_id: ctTpl === BUILT_IN_TRIAL_TEMPLATE_ID ? null : ctTpl,
        title: ctTitle.trim() || "Contratto",
        body,
        client_fields: tpl?.client_fields ?? null,
        status: "draft",
        sent_to: ctTo.trim() || lead.email || null,
        created_by: meName ?? null,
        // Il valore viene congelato qui: correggere il lead più avanti non deve
        // riscrivere il fatturato di una giornata già chiusa nei KPI.
        deal_value: Number(value) || null,
      })
      .select("id, sign_token")
      .single();
    if (error) return setErr(error.message);
    setCtForm(false);
    const tok = (created as { sign_token?: string } | null)?.sign_token;
    if (tok) {
      const link = `${window.location.origin}/#/firma/${tok}`;
      alert("Contratto generato (bozza). Link per il cliente:\n\n" + link + "\n\nNon è stato inviato nulla: usa Genera link o WhatsApp.");
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

  async function save() {
    setBusy(true);
    setErr(null);
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
      stage_id: isNew ? settingStageId : stageId,
      notes: finalNotes.trim() || null,
      next_action_date: nextAction.trim() || null,
      closing_date: closingDate.trim() || null,
      lost_reason: lostReason.trim() || null,
      tags: tags.trim() || null,
    };
    let error;
    let newLeadId: string | null = null;
    if (isNew) {
      const res = await supabase
        .from("leads")
        .insert({ ...payload, client_id: clientId, pipeline_id: pipelineId })
        .select("id")
        .single();
      error = res.error;
      newLeadId = (res.data as { id: string } | null)?.id ?? null;
    } else {
      ({ error } = await supabase
        .from("leads")
        .update(payload)
        .eq("id", lead!.id));
    }
    setBusy(false);
    if (error) setErr(error.message);
    else {
      setNotes(finalNotes);
      setQuickNote("");
      // Se è stato compilato il prossimo passo, il Salva generale crea anche
      // la task/appuntamento: il venditore non deve fare un secondo passaggio.
      if (!isNew && planDue) {
        const planned = await savePlan(false);
        if (!planned) return;
      }
      // L'autore dell'eventuale cambio fase lo registra il database stesso
      // (trigger record_stage_event): niente aggiornamento manuale qui.
      onSaved();
    }
  }

  async function saveQuickNote() {
    if (!lead || !quickNote.trim()) return;
    setBusy(true);
    setErr(null);
    const finalNotes = appendNote(notes, quickNote);
    const { error } = await supabase
      .from("leads")
      .update({ notes: finalNotes })
      .eq("id", lead.id);
    setBusy(false);
    if (error) return setErr("Nota non salvata: " + error.message);
    setNotes(finalNotes);
    setQuickNote("");
    onSaved();
  }

  async function savePlan(closeAfterSave = true): Promise<boolean> {
    if (!lead || planLock.current) return false;
    if (!planDue) { setErr("Scegli data e orario."); return false; }
    const subject = planTitle.trim() || lead.name || "Lead";
    planLock.current = true; setBusy(true); setErr(null);

    // L'appuntamento passa dal ciclo di vita condiviso: Google Calendar, task CRM
    // e attività KPI nascono insieme o non nascono affatto.
    if (planKind === "appointment") {
      const result = await createAppointment({
        clientId: lead.client_id, lead, type: planAppointmentType, audience: planAudience,
        subject, startsAt: new Date(planDue), durationMinutes: 60, note: planNote, meName: meName || "",
      });
      planLock.current = false; setBusy(false);
      if (!result.ok) { setErr(result.error || "Appuntamento non salvato."); return false; }
      void pendingAppointments(lead.client_id, lead.id).then(setAppointments);
      setPlanTitle(""); setPlanDue(""); setPlanNote(""); setPlanPriority(false);
      if (closeAfterSave) onSaved();
      return true;
    }

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
    setPlanTitle(""); setPlanDue(""); setPlanNote(""); setPlanPriority(false);
    if (closeAfterSave) onSaved();
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

  return (
    <div className="overlay lead-drawer-overlay" onClick={onClose}>
      <div className="modal lead-drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{isNew ? "Nuovo lead" : name || "Lead"}</h3>
          <button className="x" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="content">
          {err && <div className="notice err">{err}</div>}

          <div className="field">
            <label>Nome</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {!isNew && (
            <div className="activity-box commercial-tracker quick-commercial-tracker">
              <div className="tracker-heading"><div><b>Com’è andata?</b><p>Scegli soltanto l’esito reale. Ora, venditore e lead vengono compilati automaticamente.</p></div><span>1 CLIC</span></div>
              {openDiscovery && <div className="notice warn quick-linked-appointment">Stai registrando l’esito della discovery del {new Date(openDiscovery.due_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" })}: conta una volta sola, anche se l’hai già aperta dal Calendario.</div>}
              {openDemo && <div className="notice quick-linked-appointment">C’è una closing in agenda il {new Date(openDemo.due_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" })}: il suo esito si registra dal Calendario.</div>}
              {!openDiscovery && <div className="field quick-call-type"><label>Tipo di chiamata</label><div className="channel-choice">{([["lead", "Lead"], ["outbound", "Outbound"], ["client", "Già cliente"], ["other", "Altro"]] as const).map(([value, label]) => <button type="button" key={value} className={callType === value ? "active" : ""} onClick={() => setCallType(value)}>{label}</button>)}</div></div>}
              <div className="commercial-quick-actions">
                <button type="button" disabled={busy} onClick={() => void recordQuickActivity("no_answer")}><b>Non risponde</b><small>Registra un tentativo</small></button>
                <button type="button" disabled={busy} className={quickAction === "qualified" ? "active success" : "success"} onClick={() => setQuickAction("qualified")}><b>In target</b><small>Discovery svolta</small></button>
                <button type="button" disabled={busy} className={quickAction === "not_qualified" ? "active" : ""} onClick={() => setQuickAction("not_qualified")}><b>Fuori target</b><small>Discovery svolta</small></button>
                <button type="button" disabled={busy} onClick={() => void recordQuickActivity("completed")}><b>Follow-up fatto</b><small>Registra il contatto</small></button>
                <button type="button" disabled={busy} className="accent" onClick={prepareDemo}><b>Prenota closing</b><small>Vai a data e ora</small></button>
                <button type="button" disabled={busy} className={quickAction === "lost" ? "active danger" : "danger"} onClick={() => setQuickAction("lost")}><b>Perso</b><small>Indica il motivo</small></button>
              </div>
              {quickAction && <div className="commercial-quick-detail">
                {quickAction !== "lost" ? <><label>Durata discovery</label><div className="duration-chips">{[5, 10, 15, 20, 30, 45, 60].map((minutes) => <button type="button" key={minutes} className={commercialMinutes === String(minutes) ? "active" : ""} onClick={() => setCommercialMinutes(String(minutes))}>{minutes} min</button>)}</div></> : <div className="field"><label>Motivo della perdita</label><select value={lostReason} onChange={(e) => setLostReason(e.target.value)}><option value="">— scegli —</option><option>Prezzo troppo alto</option><option>Nessuna differenza percepita</option><option>Ha scelto un concorrente</option><option>Non interessato più</option><option>Irraggiungibile</option><option>Budget fermo</option><option>Altro</option></select></div>}
                <div className="field"><label>Nota <small>(facoltativa)</small></label><input value={commercialNote} onChange={(e) => setCommercialNote(e.target.value)} placeholder="Solo se serve ricordare qualcosa" /></div>
                <div className="commercial-quick-confirm"><button className="btn" type="button" onClick={() => setQuickAction(null)}>Annulla</button><button className="btn primary" type="button" disabled={busy} onClick={() => void recordQuickActivity(quickAction)}>{busy ? "Salvataggio…" : "Conferma esito"}</button></div>
              </div>}
              {activitySaved && <div className="commercial-saved">✓ {activitySaved}</div>}
              {activityHistory.length > 0 && <details className="tracker-history"><summary>Storico commerciale ({activityHistory.length})</summary>{activityHistory.slice(0, 8).map((activity) => <div key={activity.id}><span><b>{EVENT_LABELS[activity.event_type || ""] || activity.activity_type}</b><small>{OUTCOME_LABELS[activity.outcome || ""] || activity.outcome || "—"} · {CHANNEL_LABELS[activity.channel || ""] || activity.channel || "CRM"} · {new Date(activity.occurred_at || activity.created_at).toLocaleString("it-IT")}</small></span><button type="button" aria-label="Elimina registrazione" disabled={busy} onClick={() => void removeCommercialActivity(activity)}>×</button></div>)}</details>}
            </div>
          )}
          {!isNew && (
            <div className="activity-box lead-plan-box" id="lead-next-step">
              <b>Prossimo passo</b><p>Fissa qui la task o l'appuntamento: comparirà subito in Attività e Calendario.</p>
              <div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Tipo</label><select value={planKind} onChange={(e) => setPlanKind(e.target.value as "task" | "appointment")}><option value="task">Attività / follow-up</option><option value="appointment">Appuntamento</option></select></div><div className="field" style={{ flex: 1 }}><label>Data e ora</label><input type="datetime-local" value={planDue} onChange={(e) => setPlanDue(e.target.value)} /></div></div>
              {planKind === "appointment" && <><div className="field"><label>Fase dell'appuntamento</label><div className="channel-choice"><button type="button" className={planAppointmentType === "discovery" ? "active" : ""} onClick={() => setPlanAppointmentType("discovery")}>Discovery · telefono</button><button type="button" className={planAppointmentType === "demo" ? "active" : ""} onClick={() => setPlanAppointmentType("demo")}>Closing · video</button></div></div><div className="field"><label>Con chi</label><div className="channel-choice"><button type="button" className={planAudience === "lead" ? "active" : ""} onClick={() => setPlanAudience("lead")}>Nuovo lead</button><button type="button" className={planAudience === "client" ? "active" : ""} onClick={() => setPlanAudience("client")}>Già cliente</button></div></div></>}
              <div className="field"><label>{planKind === "appointment" ? "Titolo appuntamento" : "Cosa fare"} <small>(facoltativo)</small></label><input value={planTitle} onChange={(e) => setPlanTitle(e.target.value)} placeholder={planKind === "appointment" ? "Es. Consulenza in sede" : "Es. Richiamare dopo le 18"} /></div>
              {planKind === "task" && <label className={`task-priority-option compact${planPriority ? " active" : ""}`}><input type="checkbox" checked={planPriority} onChange={(e) => setPlanPriority(e.target.checked)} /><span><b>Task prioritaria</b><small>Evidenziala nell’Agenda e mostrala prima delle altre.</small></span></label>}
              <div className="field"><label>Dettagli <small>(facoltativo)</small></label><input value={planNote} onChange={(e) => setPlanNote(e.target.value)} placeholder="Nota utile prima del contatto" /></div>
              {planKind === "appointment" && <p className="ettore-auto-invite"><b>{planAppointmentType === "discovery" ? "Discovery telefonica" : "Closing in videochiamata"}.</b> L’appuntamento viene registrato nei KPI quando lo salvi. Ettore viene invitato automaticamente nel calendario.</p>}
              <p className="lead-plan-save-hint">Compila data e ora, poi premi <b>Salva</b> in basso: l’appuntamento verrà creato insieme alle modifiche della scheda.</p>
            </div>
          )}
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Telefono</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
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
                {source && !["Instantly", "DM Instagram", "DM Facebook", "DM LinkedIn", "DM Altro"].includes(source) && <option value={source}>{source} · storico</option>}
                <option value="Instantly">Instantly · email</option>
                <option value="DM Instagram">DM Instagram</option>
                <option value="DM Facebook">DM Facebook</option>
                <option value="DM LinkedIn">DM LinkedIn</option>
                <option value="DM Altro">DM altro</option>
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
          {!isNew && admin && (
            <div className="activity-box revenue-tracker">
              <div className="tracker-heading"><div><b>Registra un incasso</b><p>Firma e denaro ricevuto restano separati: qui entra solo ciò che è realmente incassato. Riservato all’amministratore.</p></div><span>€</span></div>
              <div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Tipo</label><select value={revenueType} onChange={(e) => setRevenueType(e.target.value as SalesRevenueEvent["revenue_type"])}><option value="new">Nuovo cliente</option><option value="renewal">Rinnovo</option><option value="upsell">Upsell</option></select></div><div className="field" style={{ flex: 1 }}><label>Incassato (€)</label><input type="number" min="0" step="0.01" value={revenueAmount} onChange={(e) => setRevenueAmount(e.target.value)} /></div></div>
              <div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Valore totale contratto (€)</label><input type="number" min="0" step="0.01" value={revenueContractValue} onChange={(e) => setRevenueContractValue(e.target.value)} placeholder="Facoltativo" /></div><div className="field" style={{ flex: 1 }}><label>Data e ora incasso</label><input type="datetime-local" value={revenueAt} onChange={(e) => setRevenueAt(e.target.value)} /></div></div>
              <div className="field"><label>Nota <small>(facoltativa)</small></label><input value={revenueNote} onChange={(e) => setRevenueNote(e.target.value)} placeholder="Es. prima rata, saldo…" /></div>
              <button className="btn primary tracker-save" type="button" disabled={busy || !revenueAmount} onClick={() => void recordRevenue()}>{busy ? "Registrazione…" : "Registra incasso"}</button>
            </div>
          )}
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
          <div className="field lead-note-history">
            <label>Storico note</label>
            {notes.trim() ? <div className="note-history-list">{splitNoteHistory(notes).map((note, index) => <div className="note-history-item" key={`${index}-${note}`}><span>{note}</span></div>)}</div> : <div className="note-history-empty">Nessuna nota precedente. Aggiungi il primo aggiornamento qui sopra.</div>}
          </div>

          {!isNew && canDelete && (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              Creato il{" "}
              {new Date(lead!.created_at).toLocaleString("it-IT")}
            </div>
          )}

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
                            `Buongiorno,

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
                    <select value={ctTpl} onChange={(e) => setCtTpl(e.target.value)}>
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
                  {ctStartMode === "custom" && (
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
                    .map((ph) => (
                      <div className="field" key={ph}>
                        <label>{ph.replace(/_/g, " ")}</label>
                        <input
                          value={ctVals[ph] ?? ""}
                          onChange={(e) =>
                            setCtVals((prev) => ({ ...prev, [ph]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
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
        </div>
        <footer>
          {!isNew && (
            <button
              className="btn danger"
              onClick={remove}
              disabled={busy}
              style={{ marginRight: "auto" }}
            >
              Elimina
            </button>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>
            Annulla
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Salvataggio…" : "Salva"}
          </button>
        </footer>
      </div>
    </div>
  );
}
