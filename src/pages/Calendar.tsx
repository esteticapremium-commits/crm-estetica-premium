import "../calendar-appointments.css";
import LeadDateTimePicker from "../LeadDateTimePicker";
import { AppointmentOutcomeChoices, AppointmentTime } from "../AppointmentFields";
import { salesPages } from "../salesReportingData";
import { calendarLeadMatches } from "../calendarLayout";
import { loadGoogleSales } from "../googleSalesData";
import GoogleSaleModal from "../GoogleSaleModal";
import { calendarClosingRevenueKey, googleSaleKey, saleOutcomes, type GoogleSale } from "../googleSales";
import CalendarSchedule, { type CalendarView, type DisplayEvent } from "../CalendarSchedule";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { withTimeout } from "../async";
import { supabase } from "../supabaseClient";
import type { Client, Lead, SalesRevenueEvent, SalesTask, Stage } from "../types";
import { connectGoogleCalendar, deleteGoogleCalendarEvent, ensureGoogleCalendarConnection, googleCalendarConfigured, googleCalendarConnected, listGoogleCalendarEvents, updateGoogleCalendarEvent, type GoogleEvent } from "../calendarGoogle";
import { defaultAudience } from "../salesKpi";
import { APPOINTMENT_DURATION, APPOINTMENT_LABELS, APPOINTMENT_SHORT_LABELS, CLOSING_WON_LABEL, CONFIRMATION_LABEL, CONFIRMATION_MINUTES, GIOVANNI_ID, appointmentSubject, bookConfirmationCall, canReopenSettingForReschedule, createAppointment, deleteAppointment, isAppointmentClosed, isGiovanniSetting, isOwnerManagedDiscovery, outcomeKey, recordAppointmentOutcome, retryAppointmentSync, updateAppointment, usesOwnerDiscoveryCalendar, type AppointmentAudience, type AppointmentOutcome, type AppointmentType } from "../appointments";

const formatDateTime = (iso: string) => new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(new Date(iso));
const monday = (value: Date) => { const date = new Date(value); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date; };
const localDateTime = (date: Date) => { const pad = (n: number) => String(n).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const ETTORE_ID = "cc9de596-9011-4d70-b3f5-4c5e49f6cec3";
type OwnerCalendarEvent = { title: string; at: string; endAt: string; allDay: boolean };

async function loadOwnerCalendarTitles(from: Date, to: Date): Promise<OwnerCalendarEvent[]> {
  const { data, error } = await withTimeout(supabase.functions.invoke("owner-discovery-calendar", {
    body: { operation: "list_titles", from: from.toISOString(), to: to.toISOString() },
  }));
  if (error || !Array.isArray(data?.events)) throw new Error("Agenda di Ettore non disponibile.");
  return data.events;
}

function calendarEventKey(title: string, at: string) {
  return `${title.trim().toLowerCase()}|${at.length === 10 ? at : Date.parse(at)}`;
}

const eventEnd = (task: SalesTask) => new Date(new Date(task.due_at).getTime() + (task.duration_minutes || 60) * 60 * 1000);
type ClosingAmounts = { contractValue: number; collectedAmount: number; revenueType: SalesRevenueEvent["revenue_type"] };
type Selected = { kind: "crm"; task: SalesTask; lead: Lead | null } | { kind: "google"; event: GoogleEvent };
export default function Calendar({ client, meName, userId, admin = false, headerTools }: { client: Client; meName: string; userId?: string | null; admin?: boolean; headerTools?: ReactNode }) {
  const [view, setView] = useState<CalendarView>(() =>
    window.matchMedia("(max-width: 760px)").matches ? "agenda" : "week");
  const menu = useRef<HTMLDetailsElement>(null);
  const showOwnerCalendar = !admin && userId === GIOVANNI_ID;
  const [ownerEvents, setOwnerEvents] = useState<OwnerCalendarEvent[]>([]);
  const [ownerCalendarError, setOwnerCalendarError] = useState(false);
  const [ownerEvent, setOwnerEvent] = useState<OwnerCalendarEvent | null>(null);
  const [googleSales, setGoogleSales] = useState<GoogleSale[]>([]);
  const [saleRecord, setSaleRecord] = useState<GoogleSale | null>(null);
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [leadLoadError, setLeadLoadError] = useState(false);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadQuery, setLeadQuery] = useState("");
  const [appointmentHost, setAppointmentHost] = useState("");
  const [bookingId, setBookingId] = useState("");
  const [confirmationClosingId, setConfirmationClosingId] = useState<string>();
  const [previousOutcomeKey, setPreviousOutcomeKey] = useState<string>();
  const saveOutcomeLock = useRef(false);
  const [tasks, setTasks] = useState<SalesTask[]>([]); const [leads, setLeads] = useState<Lead[]>([]); const [stages, setStages] = useState<Stage[]>([]); const [google, setGoogle] = useState<GoogleEvent[]>([]);
  const [selected, setSelected] = useState<Selected | null>(null); const [createOpen, setCreateOpen] = useState(false); const [editingEvent, setEditingEvent] = useState(false); const [weekStart, setWeekStart] = useState(() => monday(new Date()));
  const [title, setTitle] = useState(""); const [startsAt, setStartsAt] = useState(""); const [durationOverride, setDurationOverride] = useState<number | null>(null); const [note, setNote] = useState(""); const [leadId, setLeadId] = useState(""); const [appointmentType, setAppointmentType] = useState<AppointmentType>("discovery"); const [audienceOverride, setAudienceOverride] = useState<AppointmentAudience | null>(null);
  // Il lucchetto è sincrono: a differenza di `busy`, che dipende da un
  // re-render, blocca il secondo clic anche quando la rete è lenta.
  const saveLock = useRef(false);
  const [editTitle, setEditTitle] = useState(""); const [editStartsAt, setEditStartsAt] = useState(""); const [editNote, setEditNote] = useState(""); const [editError, setEditError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState("");
  const [error, setError] = useState<string | null>(null); const [formError, setFormError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const weekEnd = useMemo(() => { const date = new Date(weekStart); date.setDate(date.getDate() + 7); return date; }, [weekStart]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => { const date = new Date(weekStart); date.setDate(date.getDate() + index); return date; }), [weekStart]);
  const loadVersion = useRef(0);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError(null);
    setLeadLoading(true); setLeadLoadError(false);
    void withTimeout(salesPages<Lead>("leads", client.id)).then(
      data => {
        if (version === loadVersion.current) { setLeads(data); setLeadLoading(false); }
      },
      () => {
        if (version === loadVersion.current) { setLeads([]); setLeadLoadError(true); setLeadLoading(false); }
      },
    );
    try {
    const [taskResult, stageResult, saleResult] = await withTimeout(Promise.all([
      supabase.from("sales_tasks").select("*").eq("client_id", client.id)
        .gte("due_at", weekStart.toISOString()).lt("due_at", weekEnd.toISOString()).order("due_at"),
      supabase.from("stages").select("*").eq("client_id", client.id),
      loadGoogleSales(client.id),
    ]));
    if (version !== loadVersion.current) return;
    const failure = taskResult.error || stageResult.error;
    if (failure) throw new Error(failure.message);
    setSaleError(saleResult.error ? "Registro vendite Google non disponibile. Riprova prima di classificare una call." : null);
    setGoogleSales((saleResult.data as GoogleSale[]) || []);
    setTasks((taskResult.data as SalesTask[]) || []);
    setStages((stageResult.data as Stage[]) || []);
    const [personal, shared] = await Promise.allSettled([
      ensureGoogleCalendarConnection().then(connected => connected ? listGoogleCalendarEvents(weekStart, weekEnd) : []),
      showOwnerCalendar ? loadOwnerCalendarTitles(weekStart, weekEnd) : Promise.resolve([]),
    ]);
    if (version !== loadVersion.current) return;
    setOwnerEvents(shared.status === "fulfilled" ? shared.value : []);
    setOwnerCalendarError(shared.status === "rejected");
    if (personal.status === "rejected") throw personal.reason;
    setGoogle(personal.value);
    } catch (reason) {
      if (version === loadVersion.current) { setGoogle([]); setError(`Calendario non aggiornato completamente: ${reason instanceof Error ? reason.message : "errore di connessione"}. Riprova con Aggiorna.`); }
    } finally { if (version === loadVersion.current) setLoading(false); }
  }, [client.id, showOwnerCalendar, weekEnd, weekStart]);
  useEffect(() => { void load(); return () => { loadVersion.current += 1; }; }, [load]);
  const leadById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const matchingLeads = useMemo(() => calendarLeadMatches(leads, leadQuery), [leads, leadQuery]);
  const selectedLead = selected?.kind === "crm" && selected.task.lead_id ? leadById.get(selected.task.lead_id) ?? selected.lead : null;
  async function showAppointmentWeek(start: Date) {
    const week = monday(start);
    if (week.getTime() === weekStart.getTime()) await load();
    else setWeekStart(week);
  }
  const stageNameOf = (lead: Lead | null) => (lead ? stages.find((stage) => stage.id === lead.stage_id)?.name ?? null : null);
  // Un appuntamento con un lead in CLOSED è un appuntamento con un cliente:
  // lo deduciamo, lasciando al venditore la possibilità di correggere.
  const audience = appointmentType === "setting" ? "lead" : audienceOverride ?? defaultAudience(stageNameOf(leadId ? leadById.get(leadId) || null : null));
  const rangeLabel = `${weekStart.toLocaleDateString("it-IT", { day: "numeric", month: "short" })} – ${new Date(weekEnd.getTime() - 86400000).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" })}`;
  async function connect() { setBusy(true); setError(null); try { await connectGoogleCalendar(); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Collegamento non riuscito."); } setBusy(false); }
  function shiftWeek(amount: number) { setSyncNotice(""); setSelected(null); setOwnerEvent(null); setWeekStart((current) => { const next = new Date(current); next.setDate(next.getDate() + amount * 7); return next; }); }
  function openCreate(date = new Date(), prefill?: { type: AppointmentType; leadId?: string | null; title: string; audience?: AppointmentAudience | null; previousOutcomeKey?: string; startsAt?: Date; confirmationClosingId?: string }) {
    setSyncNotice("");
    setConfirmationClosingId(prefill?.confirmationClosingId);
    const initial = new Date(prefill?.startsAt ?? date);
    if (!prefill?.startsAt) {
      initial.setHours(10, 0, 0, 0);
      if (initial.toDateString() === new Date().toDateString() && initial < new Date()) initial.setTime(Math.ceil(Date.now() / 1_800_000) * 1_800_000);
    }
    setTitle(prefill?.title || ""); setStartsAt(localDateTime(initial)); setDurationOverride(null); setNote(""); setLeadQuery(""); setAppointmentHost(""); setLeadId(prefill?.leadId || ""); setAppointmentType(prefill?.type || "discovery"); setAudienceOverride(prefill?.audience || null); setBookingId(crypto.randomUUID()); setPreviousOutcomeKey(prefill?.previousOutcomeKey); setFormError(null); setCreateOpen(true);
  }
  function chooseAppointmentType(type: AppointmentType) {
    if (type === appointmentType) return;
    if (type === "setting" || appointmentType === "setting") setAppointmentHost("");
    setAppointmentType(type);
    setDurationOverride(null);
  }
  async function saveAppointment() {
    if (saveLock.current) return;
    const lead = leadId ? leadById.get(leadId) : null;
    if (leadId && !lead) return setFormError("Il lead collegato non è disponibile. Aggiorna il calendario e riprova.");
    const subject = title.trim() || lead?.name || "";
    const start = new Date(startsAt);
    const minutes = confirmationClosingId ? CONFIRMATION_MINUTES
      : appointmentType === "demo" ? durationOverride ?? APPOINTMENT_DURATION.demo : APPOINTMENT_DURATION[appointmentType];
    if (!confirmationClosingId && appointmentType === "setting" && !lead) return setFormError("Cerca e seleziona il lead a cui collegare il setting.");
    if (!subject || !Number.isFinite(start.getTime()) || minutes < 15) return setFormError("Inserisci contatto, data e ora.");
    saveLock.current = true; setBusy(true); setFormError(null);
    try {
      const result = confirmationClosingId
        ? await bookConfirmationCall(confirmationClosingId, bookingId, subject, start, note)
        : await createAppointment({
        clientId: client.id, lead: lead || null, type: appointmentType, audience, subject, startsAt: start,
        durationMinutes: minutes, note, requestId: bookingId, previousOutcomeKey, host: appointmentHost || undefined,
      });
      if (!result.ok) return setFormError(result.error || "Appuntamento non salvato.");
      setCreateOpen(false);
      await showAppointmentWeek(start);
      setSyncNotice([result.pipelineWarning, result.warning].filter(Boolean).join(" "));
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Prenotazione da verificare. Riprova.");
    } finally {
      saveLock.current = false; setBusy(false);
    }
  }
  function beginEdit() { if (!selected) return; const source = selected.kind === "crm" ? { title: appointmentSubject(selected.task), start: selected.task.due_at, note: selected.task.description || "" } : { title: selected.event.summary || "", start: selected.event.start?.dateTime || "", note: selected.event.description || "" }; if (!source.start) { setEditError("Gli eventi Google di intera giornata non sono modificabili dal CRM."); return; } setEditTitle(source.title); setEditStartsAt(localDateTime(new Date(source.start))); setEditNote(source.note); setEditError(null); setEditingEvent(true); }

  async function saveEventChanges() {
    if (!selected || !editTitle.trim() || !editStartsAt) return setEditError("Inserisci titolo, data e ora.");
    const start = new Date(editStartsAt);
    if (Number.isNaN(start.getTime())) return setEditError("Data o ora non valide.");
    setBusy(true); setEditError(null);
    try {
      if (selected.kind === "crm") {
        const result = await updateAppointment(selected.task, { subject: editTitle.trim(), startsAt: start, note: editNote });
        if (!result.ok) return setEditError(result.error || "Modifica non riuscita.");
        setSelected(null);
        setEditingEvent(false);
        await showAppointmentWeek(start);
        setSyncNotice(result.warning || "");
        return;
      }
      const originalStart = Date.parse(selected.event.start?.dateTime || "");
      const originalEnd = Date.parse(selected.event.end?.dateTime || "");
      const duration = originalEnd - originalStart;
      const end = new Date(start.getTime() + (duration > 0 ? duration : 60 * 60 * 1000));
      await updateGoogleCalendarEvent(selected.event.id, { title: editTitle.trim(), start: start.toISOString(), end: end.toISOString(), description: editNote.trim() });
      setSelected(null);
      setEditingEvent(false);
      await showAppointmentWeek(start);
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Modifica non riuscita. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selected || !confirm("Eliminare questo appuntamento?")) return;
    setBusy(true); setEditError(null);
    try {
      if (selected.kind === "crm") {
        const result = await deleteAppointment(selected.task);
        if (!result.ok) return setEditError(result.error || "Eliminazione non riuscita.");
      } else {
        await deleteGoogleCalendarEvent(selected.event.id);
      }
      setSelected(null);
      setEditingEvent(false);
      await load();
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Eliminazione non riuscita. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  function bookClosingFromDiscovery() {
    if (busy || selected?.kind !== "crm") return;
    const { task } = selected;
    if (task.appointment_type !== "discovery" || task.appointment_status === "cancelled" || (task.lead_id && !leadById.has(task.lead_id))) return;
    setSelected(null);
    openCreate(new Date(), {
      type: "demo",
      leadId: task.lead_id,
      title: appointmentSubject(task),
      audience: task.audience,
    });
  }

  async function setAppointmentOutcome(outcome: AppointmentOutcome, rebook = false, proposalMade?: boolean, markLost = false, closingAmounts?: ClosingAmounts) {
    if (!selected || selected.kind !== "crm" || saveOutcomeLock.current) return;
    const { task } = selected;
    if (rebook && task.lead_id && !leadById.has(task.lead_id)) {
      return setEditError("Il lead collegato non è ancora disponibile. Attendi il caricamento e riprova.");
    }
    if (rebook && outcome === "no_show" && !isAppointmentClosed(task) && Date.parse(task.due_at) > Date.now()) {
      beginEdit();
      return;
    }
    saveOutcomeLock.current = true;
    setBusy(true); setEditError(null);
    try {
      const result = closingAmounts
        ? await withTimeout(supabase.rpc("save_calendar_closing", {
            p_id: task.id, p_expected_updated_at: task.updated_at,
            p_contract_value: closingAmounts.contractValue, p_collected_amount: closingAmounts.collectedAmount,
            p_revenue_type: closingAmounts.revenueType,
          })).then(({ data, error }) => {
            const saved = Array.isArray(data) ? data[0] : data;
            return { ok: saved?.id === task.id && !error, error: error?.message };
          })
        : await recordAppointmentOutcome(task, outcome, task.outcome_minutes || undefined, undefined, proposalMade,
            markLost ? selectedLead?.stage_id : undefined);
      if (!result.ok) {
        if (markLost && result.error?.includes("La fase del lead è cambiata") && task.lead_id) {
          const { data: latestLead } = await supabase.from("leads").select("*")
            .eq("client_id", client.id).eq("id", task.lead_id).maybeSingle();
          if (latestLead) {
            setLeads(current => current.map(lead => lead.id === latestLead.id ? latestLead : lead));
            setSelected({ ...selected, lead: latestLead });
            return setEditError("La fase del lead è cambiata. Verificala nella pipeline prima di salvare.");
          }
        }
        if (result.error?.includes("Appuntamento aggiornato da un collega")) {
          const { data: latest, error } = await supabase.from("sales_tasks").select("*")
            .eq("client_id", client.id).eq("id", task.id).maybeSingle();
          if (!error && latest && latest.appointment_status !== "cancelled") {
            setSelected({ ...selected, task: latest });
            setEditError("Ho ricaricato l’appuntamento. Verifica l’esito e premi di nuovo il pulsante per continuare.");
            return;
          }
        }
        return setEditError(result.error || "Esito non salvato.");
      }
      setSelected(null);
      if (rebook && task.appointment_type) openCreate(new Date(), {
        type: outcome === "qualified" ? "demo" : task.appointment_type === "setting" && outcome === "answered" ? "discovery" : task.appointment_type,
        leadId: task.lead_id, title: appointmentSubject(task), audience: task.audience, previousOutcomeKey: task.lead_id ? outcomeKey(task.id) : undefined,
      });
      await load();
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Esito da verificare.");
    } finally {
      saveOutcomeLock.current = false;
      setBusy(false);
    }
  }

  async function syncSelected() {
    if (!selected || selected.kind !== "crm" || busy) return;
    setBusy(true); setEditError(null);
    try {
      const result = await retryAppointmentSync(selected.task);
      if (!result.ok) return setEditError(result.error || "Sincronizzazione non riuscita.");
      setSelected(null); await load();
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Sincronizzazione non riuscita. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  function openConfirmationCall() {
    if (busy || selected?.kind !== "crm" || selected.task.appointment_type !== "demo") return;
    const { task } = selected;
    const earliest = Math.max(eventEnd(task).getTime(), Date.now() + 60_000);
    const start = new Date(Math.ceil(earliest / 1_800_000) * 1_800_000);
    setSelected(null);
    openCreate(undefined, { type: "demo", title: appointmentSubject(task), startsAt: start, confirmationClosingId: task.id });
  }

  const calendarTasks = tasks.filter(task => task.appointment_status !== "cancelled" && (task.appointment_type || task.confirmation_for || !task.completed_at));
  const visibleTasks = admin && userId === ETTORE_ID
    ? calendarTasks.filter(task => !isGiovanniSetting(task))
    : calendarTasks;
  const canSyncSelected = selected?.kind === "crm" && (isGiovanniSetting(selected.task)
    ? userId === GIOVANNI_ID
    : selected.task.created_by === meName || (selected.task.setter_id && selected.task.assigned_to === meName) ||
      (admin && usesOwnerDiscoveryCalendar(selected.task)));
  const selectedGoogleCopy = selected?.kind === "crm"
    ? google.find(event => event.id === selected.task.google_event_id) : undefined;
  const selectedGoogleTimeMismatch = selected?.kind === "crm" && !!selectedGoogleCopy?.start?.dateTime &&
    Date.parse(selectedGoogleCopy.start.dateTime) !== Date.parse(selected.task.due_at);
  const linkedGoogleIds = new Set(tasks.map(task => task.google_event_id).filter(Boolean));
  const knownEvents = new Set([
    ...visibleTasks.map(task => calendarEventKey(task.title, task.due_at)),
    ...google.map(event => calendarEventKey(event.summary || "", event.start?.dateTime || event.start?.date || "")),
  ]);
  const sharedCalendarEvents: DisplayEvent[] = showOwnerCalendar ? ownerEvents.flatMap((event, index) =>
    knownEvents.has(calendarEventKey(event.title, event.at)) ? [] : [{
      ...event, id: `owner-${event.at}-${index}`, subtitle: "Calendario di Ettore", kind: "owner",
      onOpen: () => setOwnerEvent(event),
    }]) : [];

  function openEvent(event: Selected) {
    setEditError(null);
    setEditingEvent(false);
    setSelected(event);
  }

  const googleSalesByKey = new Map(googleSales.map(sale => [sale.google_key, sale]));
  const displayEvents: DisplayEvent[] = [
    ...visibleTasks.map(task => {
      const closed = task.appointment_status === "held" || Boolean(task.confirmation_for && task.completed_at);
      const absent = task.appointment_status === "no_show";
      const label = task.appointment_type ? APPOINTMENT_SHORT_LABELS[task.appointment_type]
        : task.confirmation_for ? CONFIRMATION_LABEL : "Richiamo";
      const status = absent ? task.appointment_type === "setting" && task.appointment_outcome !== "no_show" ? "Non risponde" : "No-show"
        : task.appointment_outcome === "won" ? CLOSING_WON_LABEL : task.appointment_outcome === "lost" ? "Offerta rifiutata"
        : closed ? "Svolta" : task.assigned_to || "CRM";
      return {
        id: `crm-${task.id}`, at: task.due_at, endAt: eventEnd(task).toISOString(),
        title: appointmentSubject(task), subtitle: `${label} · ${status}`, kind: "crm" as const,
        state: absent ? "absent" as const : task.appointment_outcome === "won" ? "won" as const : closed ? "held" as const : undefined,
        skipAsNext: Boolean(task.completed_at) || isAppointmentClosed(task),
        onOpen: () => openEvent({ kind: "crm", task, lead: task.lead_id ? leadById.get(task.lead_id) || null : null }),
      };
    }),
    ...google.filter(event => !linkedGoogleIds.has(event.id) && !calendarTasks.some(task => task.title === event.summary && event.start?.dateTime && Math.abs(new Date(task.due_at).getTime()-new Date(event.start.dateTime).getTime())<60000)).map(event => {
      const sale = googleSalesByKey.get(googleSaleKey(event));
      return {
        id: `google-${event.id}`, at: event.start?.dateTime || event.start?.date || "",
        endAt: event.end?.dateTime || event.end?.date || event.start?.date || "",
        title: event.summary || "Impegno Google", subtitle: sale ? `Vendita · ${saleOutcomes[sale.outcome]}` : "Google personale",
        kind: "google" as const, allDay: !event.start?.dateTime,
        state: sale?.outcome === "won" ? "won" as const : sale?.outcome === "no_show" ? "absent" as const : undefined,
        skipAsNext: Boolean(sale && !["pending", "excluded"].includes(sale.outcome)),
        onOpen: () => openEvent({ kind: "google", event }),
      };
    }),
    ...sharedCalendarEvents,
  ].filter(event => Number.isFinite(Date.parse(event.at)) && Number.isFinite(Date.parse(event.endAt)));
  return <div className="page calendar-page">
    <header className="calendar-compact-bar">
      <div><h1>Calendario</h1><span aria-live="polite">{rangeLabel}</span></div>
      <div className="calendar-navigation" role="group" aria-label="Navigazione calendario">
        <button type="button" aria-label="Settimana precedente" onClick={() => shiftWeek(-1)}>‹</button>
        <button type="button" onClick={() => { setSyncNotice(""); setSelected(null); setOwnerEvent(null); setWeekStart(monday(new Date())); }}>Oggi</button>
        <button type="button" aria-label="Settimana successiva" onClick={() => shiftWeek(1)}>›</button>
      </div>
      <details ref={menu} className="calendar-options">
        <summary className="btn" aria-label="Opzioni calendario">Opzioni</summary>
        <div className="calendar-options-content">
          <label>Vista<select value={view} onChange={event => { setView(event.target.value === "agenda" ? "agenda" : "week"); if (menu.current) menu.current.open = false; }}>
            <option value="week">Settimana</option><option value="agenda">Agenda</option>
          </select></label>
          {headerTools}
          <button className="btn" type="button" onClick={() => { if (menu.current) menu.current.open = false; openCreate(); }}>+ Nuovo appuntamento</button>
          <button className="btn" type="button" disabled={loading} onClick={() => { if (menu.current) menu.current.open = false; setSyncNotice(""); void load(); }}>Aggiorna</button>
          {googleCalendarConfigured() ? <button className="btn" type="button" disabled={busy} onClick={() => { if (menu.current) menu.current.open = false; void connect(); }}>{googleCalendarConnected() ? "Google collegato" : "Collega Google Calendar"}</button> : <small>Google Calendar da configurare</small>}
        </div>
      </details>
    </header>
    {error && <div className="notice err" role="alert">{error}</div>}
    {syncNotice && <div className="notice warn" role="status">{syncNotice}</div>}
    {saleError && <div className="notice err" role="alert">{saleError}</div>}
    {showOwnerCalendar && ownerCalendarError && <div className="notice warn" role="status">Calendario di Ettore temporaneamente non disponibile.</div>}
    {leadLoadError && <div className="notice warn" role="status">La ricerca lead non è disponibile. Riprova da Opzioni → Aggiorna.</div>}
    {loading && <span className="calendar-loading" role="status">Caricamento appuntamenti…</span>}
    <CalendarSchedule days={days} events={displayEvents} onCreate={openCreate} view={view} onViewChange={setView} />
    {!saleError && googleSales.some(s => s.starts_at >= weekStart.toISOString() && s.starts_at < weekEnd.toISOString()) && <details className="panel google-sales-pending"><summary>Vendite Google registrate · questa settimana</summary>{googleSales.filter(s => s.starts_at >= weekStart.toISOString() && s.starts_at < weekEnd.toISOString()).map(s => <div className="google-sale-row" key={s.id}><div><b>{s.contact_name}</b><small>{formatDateTime(s.starts_at)} · {saleOutcomes[s.outcome]}</small></div><button className="btn" onClick={() => { setSelected(null); setSaleRecord(s); setSaleOpen(true); }}>Apri esito</button></div>)}</details>}
    {saleOpen && (saleRecord || selected?.kind === "google") && <GoogleSaleModal clientId={client.id} event={selected?.kind === "google" ? selected.event : undefined} sale={saleRecord || (selected?.kind === "google" ? googleSales.find(s => s.google_key === googleSaleKey(selected.event)) : undefined)} leads={leads} admin={admin} onClose={() => { setSaleOpen(false); setSaleRecord(null); }} onSaved={async warning => { setSaleOpen(false); setSaleRecord(null); setSelected(null); await load(); setSyncNotice(warning || ""); }} />}
    {selected && !saleOpen && <EventDetailsModal onSale={() => setSaleOpen(true)} saleDisabled={!!saleError} hasSale={selected.kind === "google" && googleSales.some(s => s.google_key === googleSaleKey(selected.event))}  selected={selected.kind === "crm" ? { ...selected, lead: selectedLead } : selected} editing={editingEvent} title={editTitle} startsAt={editStartsAt} note={editNote} error={editError} busy={busy} onClose={() => { setSelected(null); setEditingEvent(false); }} onEdit={beginEdit} onCancelEdit={() => setEditingEvent(false)} onTitle={setEditTitle} onStartsAt={setEditStartsAt} onNote={setEditNote} onSave={() => void saveEventChanges()} onDelete={() => void deleteSelected()} onBookClosing={bookClosingFromDiscovery} onBookConfirmation={openConfirmationCall} onOutcome={setAppointmentOutcome} canRecordClosingRevenue={admin} canMarkConfirmationLost={!!selectedLead && Boolean(stages.some(stage => stage.pipeline_id === selectedLead.pipeline_id && stage.id !== selectedLead.stage_id && stage.name.trim().toUpperCase() === "LOST"))} onSync={canSyncSelected && selected.kind === "crm" && (!selected.task.google_event_id || isOwnerManagedDiscovery(selected.task) || selectedGoogleTimeMismatch) ? () => void syncSelected() : undefined} />}
    {showOwnerCalendar && ownerEvent && <div className="calendar-modal-overlay" role="presentation" onClick={() => setOwnerEvent(null)}>
      <section className="calendar-modal calendar-event-modal calendar-appointment-dialog" role="dialog" aria-modal="true"
        aria-label="Evento del calendario di Ettore" onClick={event => event.stopPropagation()}>
        <header className="calendar-appointment-header">
          <div><h2>{ownerEvent.title}</h2><span className="calendar-detail-label google-label">Calendario di Ettore</span></div>
          <button type="button" className="btn calendar-close" aria-label="Chiudi dettagli" onClick={() => setOwnerEvent(null)}>×</button>
        </header>
        <dl className="calendar-appointment-facts">
          {ownerEvent.allDay ? <div className="calendar-fact-full"><dt>Quando</dt><dd>Tutto il giorno</dd></div> : <>
            <div><dt>Inizio</dt><dd>{formatDateTime(ownerEvent.at)}</dd></div>
            <div><dt>Fine</dt><dd>{formatDateTime(ownerEvent.endAt)}</dd></div>
          </>}
        </dl>
      </section>
    </div>}
    {createOpen && <div className="calendar-modal-overlay" role="presentation" onClick={() => !busy && setCreateOpen(false)}>
      <section className="calendar-modal calendar-create calendar-appointment-dialog" role="dialog" aria-modal="true" aria-label={confirmationClosingId ? CONFIRMATION_LABEL : "Nuovo appuntamento"} onClick={(event) => event.stopPropagation()}>
        <header className="calendar-appointment-header">
          <h2>{confirmationClosingId ? CONFIRMATION_LABEL : "Fissa appuntamento"}</h2>
          <button type="button" className="btn calendar-close" aria-label="Chiudi" disabled={busy} onClick={() => setCreateOpen(false)}>×</button>
        </header>
        {formError && <div className="notice err" role="alert">{formError}</div>}
        {!confirmationClosingId && <div className="calendar-appointment-kind">
          <b>Tipo di appuntamento</b>
          <div className="calendar-type-options" role="group" aria-label="Tipo di appuntamento">
            {(["setting", "discovery", "demo"] as const).map(type =>
              <button key={type} type="button" className="btn" aria-pressed={appointmentType === type} disabled={busy}
                onClick={() => chooseAppointmentType(type)}>{APPOINTMENT_SHORT_LABELS[type]}</button>)}
          </div>
        </div>}
        <label>Contatto<input value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="Nome del centro o della persona" /></label>
        {confirmationClosingId ? <>
          <span className="calendar-duration">Durata · {CONFIRMATION_MINUTES} min</span>
          <LeadDateTimePicker value={startsAt} onChange={setStartsAt} disabled={busy} revealPanel />
          <label>Nota (facoltativa)<textarea rows={2} disabled={busy} value={note} onChange={event => setNote(event.target.value)} /></label>
        </> : <>
        <AppointmentTime type={appointmentType} durationMinutes={durationOverride ?? undefined} value={startsAt} disabled={busy} onChange={setStartsAt} revealPanel />
        <div className="calendar-booking-lead">
          <label>{appointmentType === "setting" ? "Lead da contattare" : "Collega un lead (facoltativo)"}
            <input type="search" placeholder="Nome, telefono o email" value={leadQuery} disabled={busy}
              onChange={event => setLeadQuery(event.target.value)} />
          </label>
          {leadId && <div className="calendar-linked-lead">
            <strong>{leadById.get(leadId)?.name || "Lead collegato"}</strong>
            <button type="button" className="btn small" disabled={busy} onClick={() => { setLeadId(""); setAppointmentHost(""); }}>Rimuovi</button>
          </div>}
          {leadQuery.trim() && <div className="google-sale-lead-picker">
            <small role="status">{matchingLeads.length ? `${matchingLeads.length} risultati${matchingLeads.length > 50 ? " · primi 50" : ""}` : leadLoading ? "Ricerca in corso…" : leadLoadError ? "Ricerca non disponibile" : "Nessun lead trovato"}</small>
            <div className="google-sale-lead-results">{matchingLeads.slice(0, 50).map(lead =>
              <button key={lead.id} type="button" disabled={busy} aria-pressed={lead.id === leadId}
                onClick={() => { setLeadId(lead.id); setLeadQuery(""); setAppointmentHost(""); }}>
                <strong>{lead.name || "Senza nome"}</strong>
                <small>{[lead.phone, lead.email].filter(Boolean).join(" · ")}</small>
              </button>)}</div>
          </div>}
        </div>
        <details className="calendar-form-options" key={appointmentType}><summary>Opzioni appuntamento</summary>
          {leadId && leadById.get(leadId)?.assigned_to && leadById.get(leadId)?.assigned_to !== meName &&
            <label>Chi conduce<select value={appointmentHost} onChange={event => setAppointmentHost(event.target.value)}>
              <option value="">{appointmentType === "setting" ? meName : leadById.get(leadId)?.assigned_to}</option>
              <option>{appointmentType === "setting" ? leadById.get(leadId)?.assigned_to : meName}</option>
            </select></label>}
          {appointmentType !== "setting" && <label>Con chi<select value={audience} onChange={event => setAudienceOverride(event.target.value as AppointmentAudience)}><option value="lead">Nuovo lead</option><option value="client">Già cliente</option></select></label>}
          {appointmentType === "demo" && <label>Durata<select value={durationOverride ?? APPOINTMENT_DURATION.demo} onChange={event => setDurationOverride(Number(event.target.value))}><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 ora</option><option value="90">1 ora e 30</option><option value="120">2 ore</option></select></label>}
          <label>Nota<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
        </details>
        </>}
        <footer className="calendar-appointment-footer"><button className="btn" type="button" disabled={busy} onClick={() => setCreateOpen(false)}>Annulla</button><button className="btn primary" type="button" disabled={busy} onClick={() => void saveAppointment()}>{busy ? "Salvataggio…" : confirmationClosingId ? "Prenota conferma" : "Crea appuntamento"}</button></footer>
      </section>
    </div>}
  </div>;
}

type EventDetailsProps = {
  selected: Selected;
  editing: boolean;
  title: string;
  startsAt: string;
  note: string;
  error: string | null;
  busy: boolean;
  saleDisabled: boolean;
  hasSale: boolean;
  onSale: () => void;
  onClose: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onTitle: (value: string) => void;
  onStartsAt: (value: string) => void;
  onNote: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onOutcome: (outcome: AppointmentOutcome, rebook?: boolean, proposalMade?: boolean, markLost?: boolean, closingAmounts?: ClosingAmounts) => void;
  canMarkConfirmationLost: boolean;
  canRecordClosingRevenue: boolean;
  onBookClosing: () => void;
  onBookConfirmation: () => void;
  onSync?: () => void;
};

function EventDetailsModal({
  selected, editing, title, startsAt, note, error, busy, saleDisabled, hasSale,
  onSale, onClose, onEdit, onCancelEdit, onTitle, onStartsAt, onNote, onSave, onDelete, onOutcome, onBookClosing, onBookConfirmation, onSync, canMarkConfirmationLost, canRecordClosingRevenue,
}: EventDetailsProps) {
  const task = selected.kind === "crm" ? selected.task : null;
  const heading = selected.kind === "crm" ? appointmentSubject(selected.task) : selected.event.summary || "Impegno Google";
  const canEdit = !task || (!task.completed_at && !isAppointmentClosed(task) && task.appointment_status !== "cancelled");
  const reopenSetting = Boolean(task && canReopenSettingForReschedule(task));
  const canReschedule = Boolean((task?.appointment_type || task?.confirmation_for) && (canEdit || reopenSetting));
  const beforeStart = Boolean(task && Date.parse(task.due_at) > Date.now());
  const kindLabel = task
    ? task.confirmation_for ? CONFIRMATION_LABEL : task.appointment_type ? APPOINTMENT_LABELS[task.appointment_type] : "Appuntamento CRM"
    : "Evento Google personale";

  const isClosing = task?.appointment_type === "demo";
  const showOutcomeFirst = !beforeStart;
  const outcomeControls = task && (task.appointment_type || task.confirmation_for) && task.appointment_status !== "cancelled" && (
    <CalendarOutcome key={`${task.id}:${task.updated_at}:${selected.kind === "crm" ? selected.lead?.stage_id : ""}`}
      task={task} busy={busy} onOutcome={onOutcome} canMarkLost={canMarkConfirmationLost}
      canRecordClosingRevenue={canRecordClosingRevenue} />
  );

  return <div className="calendar-modal-overlay" role="presentation" onClick={() => !busy && onClose()}>
    <section className={`calendar-modal calendar-event-modal calendar-appointment-dialog${isClosing && !editing ? " calendar-closing-dialog" : ""}`} role="dialog" aria-modal="true" aria-label="Dettagli evento" onClick={event => event.stopPropagation()}>
      <header className="calendar-appointment-header">
        <div>
          <h2>{editing ? "Modifica appuntamento" : heading}</h2>
          <span className={`calendar-detail-label${task ? "" : " google-label"}`}>{kindLabel}</span>
        </div>
        <button type="button" className="btn calendar-close" aria-label="Chiudi dettagli" disabled={busy} onClick={onClose}>×</button>
      </header>
      {error && <div className="notice err" role="alert">{error}</div>}

      {editing ? <div className="calendar-event-edit">
        <label>Titolo<input autoFocus value={title} onChange={event => onTitle(event.target.value)} /></label>
        <LeadDateTimePicker value={startsAt} onChange={onStartsAt} disabled={busy} revealPanel />
        <label>Note<textarea value={note} onChange={event => onNote(event.target.value)} /></label>
      </div> : <>
        <dl className="calendar-appointment-facts">
          {selected.kind === "crm" ? <>
            <div><dt>Quando</dt><dd>{formatDateTime(selected.task.due_at)}</dd></div>
            <div><dt>Durata</dt><dd>{selected.task.duration_minutes || (selected.task.appointment_type ? APPOINTMENT_DURATION[selected.task.appointment_type] : 60)} minuti</dd></div>
            <div><dt>Stato</dt><dd>{selected.task.appointment_outcome === "won" ? CLOSING_WON_LABEL : selected.task.appointment_outcome === "lost" ? "Offerta rifiutata" : selected.task.appointment_status === "held" ? "Svolta" : selected.task.appointment_status === "no_show"
              ? selected.task.appointment_type === "setting" && selected.task.appointment_outcome !== "no_show" ? "Non risponde" : "No-show"
              : selected.task.appointment_status === "cancelled" ? "Annullata" : "Da svolgere"}</dd></div>
            <div><dt>Assegnato a</dt><dd>{selected.task.assigned_to || "Non assegnato"}</dd></div>
            {selected.task.appointment_host && <div><dt>Conduce</dt><dd>{selected.task.appointment_host}</dd></div>}
            {selected.lead && <div className="calendar-fact-full"><dt>Lead</dt><dd>
              <b>{selected.lead.name || "Senza nome"}</b>
              {selected.lead.phone && <small>{selected.lead.phone}</small>}
              {selected.lead.email && <small>{selected.lead.email}</small>}
            </dd></div>}
            {selected.task.description && <div className="calendar-fact-full"><dt>Dettagli</dt><dd>{selected.task.description}</dd></div>}
          </> : <>
            <div className="calendar-fact-full"><dt>Quando</dt><dd>{selected.event.start?.dateTime ? formatDateTime(selected.event.start.dateTime) : selected.event.start?.date || "Tutto il giorno"}</dd></div>
            {selected.event.location && <div className="calendar-fact-full"><dt>Luogo</dt><dd>{selected.event.location}</dd></div>}
            {selected.event.description && <div className="calendar-fact-full"><dt>Note</dt><dd>{selected.event.description}</dd></div>}
          </>}
        </dl>

        {showOutcomeFirst && outcomeControls}

        {task?.appointment_type === "discovery" && task.appointment_status !== "cancelled" &&
          (!task.lead_id || (selected.kind === "crm" && selected.lead)) &&
          <button className="btn primary" type="button" disabled={busy} onClick={onBookClosing}>Prenota closing</button>}

        {task?.appointment_type === "demo" && ["held", "scheduled", "rescheduled"].includes(task.appointment_status || "") &&
          <button className="btn calendar-confirmation-action" type="button" disabled={busy} onClick={onBookConfirmation}>Prenota call di conferma</button>}

        {canReschedule && <div className="calendar-reschedule-action">
          {reopenSetting && <p>Il rinvio corregge anche l’esito precedente.</p>}
          <button className="btn" type="button" disabled={busy} onClick={onEdit}>Riprogramma appuntamento</button>
        </div>}
        {!showOutcomeFirst && (canReschedule && beforeStart && outcomeControls
          ? <details className="calendar-early-outcome"><summary>No-show preannunciato</summary>
              <p>Usalo se il contatto ha annullato e non avete concordato un nuovo orario.</p>
              {outcomeControls}
            </details>
          : outcomeControls)}

        {(task?.commercial_tracked || task?.confirmation_for) && onSync && !task.completed_at &&
          <button type="button" className="btn calendar-sync-action" disabled={busy} onClick={onSync}>Sincronizza con Google</button>}

        {selected.kind === "google" && <div className="calendar-sale-action">
          <button type="button" className="btn primary" disabled={busy || saleDisabled || !selected.event.start?.dateTime} onClick={onSale}>
            {hasSale ? "Registra / correggi esito vendita" : "Appuntamento di vendita"}
          </button>
          <p className="calendar-detail-note">{hasSale
            ? "Se sposti l’evento su Google, aggiorna anche la registrazione dell’esito."
            : "Registri nel CRM solo i dati commerciali che scegli di condividere."}</p>
        </div>}
      </>}

      <footer className={`calendar-appointment-footer${editing ? "" : " calendar-manage-footer"}`}>
        {editing ? <>
          <button className="btn" type="button" disabled={busy} onClick={onCancelEdit}>Annulla</button>
          <button className="btn primary" type="button" disabled={busy} onClick={onSave}>{busy ? "Salvataggio…" : "Salva modifiche"}</button>
        </> : <>
          <button className="btn danger calendar-delete-action" type="button" disabled={busy || hasSale} onClick={onDelete}>Elimina</button>
          {canEdit && !canReschedule && <button className="btn" type="button" disabled={busy} onClick={onEdit}>Modifica appuntamento</button>}
        </>}
      </footer>
    </section>
  </div>;
}

function CalendarOutcome({ task, busy, onOutcome, canMarkLost, canRecordClosingRevenue }: {
  task: SalesTask; busy: boolean; canMarkLost: boolean; canRecordClosingRevenue: boolean; onOutcome: EventDetailsProps["onOutcome"];
}) {
  const [value, setValue] = useState<AppointmentOutcome | "">((task.appointment_outcome || "") as AppointmentOutcome | "");
  const [proposalMade, setProposalMade] = useState(task.proposal_made ?? undefined);
  const [markLost, setMarkLost] = useState(false);
  const type = task.confirmation_for ? "confirmation" : task.appointment_type;
  if (!type) return null;
  const beforeStart = Date.parse(task.due_at) > Date.now();
  const saveValue = !beforeStart || value === "no_show" ? value : "";
  const showClosingAmounts = saveValue === "won" && type === "demo" && canRecordClosingRevenue;
  const canAdvance = value === "qualified" || (task.appointment_type === "setting" && value === "answered");
  const nextAction = beforeStart || type === "confirmation" ? null : value === "qualified" ? "Salva e prenota closing"
    : task.appointment_type === "setting" && value === "answered" ? "Salva e prenota discovery"
    : value === "no_show" || value === "no_answer" ? value === "no_answer" && task.appointment_type === "setting" ? "Non risponde e riprenota setting" : "No-show e riprenota"
    : null;
  return <div className="appointment-outcomes">
    {!beforeStart && <b>{type === "demo" || !isAppointmentClosed(task) ? "Com’è andata?" : "Correggi l’esito"}</b>}
    <AppointmentOutcomeChoices type={type} value={value} disabled={busy} beforeStart={beforeStart} onChange={setValue} />
    {type === "demo" && value === "held" && <label><input type="checkbox" checked={proposalMade ?? false} disabled={busy} onChange={event => setProposalMade(event.target.checked)} /> Proposta presentata</label>}
    {type === "confirmation" && canMarkLost && <label className="calendar-confirmation-disposition">
      <input type="checkbox" checked={markLost} disabled={busy} onChange={event => setMarkLost(event.target.checked)} />
      Non interessato · sposta il lead in LOST
    </label>}
    {showClosingAmounts ? <CalendarClosingAmounts task={task} busy={busy}
      onSave={amounts => onOutcome("won", false, undefined, false, amounts)} /> : <div className="calendar-outcome-actions">
      <button type="button" className={canAdvance ? "btn" : "btn primary"}
        disabled={busy || !saveValue} onClick={() => { if (saveValue) onOutcome(saveValue, false, proposalMade, markLost); }}>{markLost ? "Salva esito e sposta in LOST" : "Salva esito"}</button>
      {saveValue && nextAction && <button type="button" className={canAdvance ? "btn primary" : "btn"}
        disabled={busy} onClick={() => onOutcome(saveValue, true)}>{nextAction}</button>}
    </div>}
  </div>;
}

function CalendarClosingAmounts({ task, busy, onSave }: {
  task: SalesTask; busy: boolean; onSave: (amounts: ClosingAmounts) => void;
}) {
  const [contract, setContract] = useState("");
  const [cash, setCash] = useState("");
  const [revenueType, setRevenueType] = useState<ClosingAmounts["revenueType"] | "">(task.audience === "client" ? "" : "new");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [validation, setValidation] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    setValidation("");
    void (async () => {
      try {
        const { data, error } = await withTimeout(supabase.from("sales_revenue_events")
          .select("amount,contract_value,revenue_type,event_key,status")
          .eq("client_id", task.client_id).eq("sale_appointment_id", task.id).neq("status", "cancelled").order("occurred_at"));
        if (error) throw error;
        if (!active) return;
        const rows = data || [];
        const saved = rows.find(row => row.event_key === calendarClosingRevenueKey(task.id))
          ?? rows.find(row => row.contract_value != null);
        const total = rows.reduce((sum, row) => sum + (row.status === "collected" ? Math.round(Number(row.amount) * 100) : 0), 0);
        setContract(saved?.contract_value != null ? String(saved.contract_value) : "");
        setCash(total > 0 ? String(total / 100) : "");
        if (task.audience === "client") setRevenueType(saved?.revenue_type === "renewal" || saved?.revenue_type === "upsell" ? saved.revenue_type : "");
      } catch {
        if (active) setLoadError("Impossibile caricare i pagamenti già collegati.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [task.id, task.client_id, task.audience, reload]);

  function submit() {
    const value = contract.trim().replace(",", ".");
    const received = cash.trim().replace(",", ".") || "0";
    const validAmount = /^\d+(\.\d{1,2})?$/;
    if (!validAmount.test(value) || !validAmount.test(received) || Number(value) <= 0 || Number(value) >= 10_000_000_000 || Number(received) > Number(value)) {
      setValidation("Inserisci un valore del contratto positivo e un incassato tra zero e il valore del contratto.");
      return;
    }
    if (!revenueType) {
      setValidation("Scegli il tipo di vendita.");
      return;
    }
    setValidation("");
    onSave({ contractValue: Number(value), collectedAmount: Number(received), revenueType });
  }

  if (loadError) return <div role="alert">{loadError} <button className="btn small" type="button" disabled={busy} onClick={() => setReload(v => v + 1)}>Riprova</button></div>;
  return <form className="calendar-closing-form" onSubmit={event => { event.preventDefault(); submit(); }}>
    {task.audience === "client" && <label>Tipo di vendita
      <select value={revenueType} disabled={busy || loading} onChange={event => setRevenueType(event.target.value as typeof revenueType)}>
        <option value="">Scegli</option><option value="renewal">Rinnovo</option><option value="upsell">Upsell</option>
      </select>
    </label>}
    <div className="calendar-closing-amounts">
      <label>Valore del contratto
        <span className="calendar-amount-input">
          <span aria-hidden="true">€</span>
          <input type="text" inputMode="decimal" placeholder="0,00" value={contract}
            disabled={busy || loading} onChange={event => setContract(event.target.value)} />
        </span>
      </label>
      <label>Incassato
        <span className="calendar-amount-input">
          <span aria-hidden="true">€</span>
          <input type="text" inputMode="decimal" placeholder="0,00" value={cash}
            disabled={busy || loading} onChange={event => setCash(event.target.value)} />
        </span>
      </label>
    </div>
    {validation && <p className="notice err" role="alert">{validation}</p>}
    <div className="calendar-outcome-actions">
      <button type="submit" className="btn primary" disabled={busy || loading}>{loading ? "Caricamento…" : busy ? "Salvataggio…" : "Salva chiusura"}</button>
    </div>
  </form>;
}
