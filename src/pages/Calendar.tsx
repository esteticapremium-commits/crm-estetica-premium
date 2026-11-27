import "../calendar-appointments.css";
import LeadDateTimePicker from "../LeadDateTimePicker";
import { AppointmentOutcomeChoices, AppointmentTime } from "../AppointmentFields";
import { loadGoogleSales } from "../googleSalesData";
import GoogleSaleModal from "../GoogleSaleModal";
import { googleSaleKey, saleOutcomes, type GoogleSale } from "../googleSales";
import CalendarSchedule, { type CalendarView, type DisplayEvent } from "../CalendarSchedule";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { withTimeout } from "../async";
import { supabase } from "../supabaseClient";
import type { Client, Lead, SalesTask, Stage } from "../types";
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
  const [error, setError] = useState<string | null>(null); const [formError, setFormError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const weekEnd = useMemo(() => { const date = new Date(weekStart); date.setDate(date.getDate() + 7); return date; }, [weekStart]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => { const date = new Date(weekStart); date.setDate(date.getDate() + index); return date; }), [weekStart]);
  const loadVersion = useRef(0);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError(null);
    try {
    const [taskResult, leadResult, stageResult, saleResult] = await Promise.all([supabase.from("sales_tasks").select("*").eq("client_id", client.id).gte("due_at", weekStart.toISOString()).lt("due_at", weekEnd.toISOString()).order("due_at"), supabase.from("leads").select("*").eq("client_id", client.id), supabase.from("stages").select("*").eq("client_id", client.id), loadGoogleSales(client.id)]);
    if (version !== loadVersion.current) return;
    const failure = taskResult.error || leadResult.error || stageResult.error;
    if (failure) throw new Error(failure.message);
    const loadedTasks = (taskResult.data as SalesTask[]) || [];
    const loadedLeads = (leadResult.data as Lead[]) || [];
    const loadedLeadIds = new Set(loadedLeads.map(lead => lead.id));
    const missingLeadIds = [...new Set(loadedTasks.flatMap(task =>
      task.confirmation_for && task.lead_id && !loadedLeadIds.has(task.lead_id) ? [task.lead_id] : []))];
    if (missingLeadIds.length) {
      const { data } = await supabase.from("leads").select("*").eq("client_id", client.id).in("id", missingLeadIds);
      if (version !== loadVersion.current) return;
      if (data) loadedLeads.push(...data as Lead[]);
    }
    setSaleError(saleResult.error ? "Registro vendite Google non disponibile. Riprova prima di classificare una call." : null);
    setGoogleSales((saleResult.data as GoogleSale[]) || []);
    setTasks(loadedTasks); setLeads(loadedLeads); setStages((stageResult.data as Stage[]) || []);
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
  useEffect(() => { void load(); }, [load]);
  const leadById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const stageNameOf = (lead: Lead | null) => (lead ? stages.find((stage) => stage.id === lead.stage_id)?.name ?? null : null);
  // Un appuntamento con un lead in CLOSED è un appuntamento con un cliente:
  // lo deduciamo, lasciando al venditore la possibilità di correggere.
  const audience = appointmentType === "setting" ? "lead" : audienceOverride ?? defaultAudience(stageNameOf(leadId ? leadById.get(leadId) || null : null));
  const rangeLabel = `${weekStart.toLocaleDateString("it-IT", { day: "numeric", month: "short" })} – ${new Date(weekEnd.getTime() - 86400000).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" })}`;
  async function connect() { setBusy(true); setError(null); try { await connectGoogleCalendar(); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Collegamento non riuscito."); } setBusy(false); }
  function shiftWeek(amount: number) { setSelected(null); setOwnerEvent(null); setWeekStart((current) => { const next = new Date(current); next.setDate(next.getDate() + amount * 7); return next; }); }
  function openCreate(date = new Date(), prefill?: { type: AppointmentType; leadId?: string | null; title: string; audience?: AppointmentAudience | null; previousOutcomeKey?: string; startsAt?: Date; confirmationClosingId?: string }) {
    setConfirmationClosingId(prefill?.confirmationClosingId);
    const initial = new Date(prefill?.startsAt ?? date);
    if (!prefill?.startsAt) {
      initial.setHours(10, 0, 0, 0);
      if (initial < new Date()) initial.setTime(Math.ceil(Date.now() / 1_800_000) * 1_800_000);
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
      await load();
      if (result.warning || result.pipelineWarning) setError([result.pipelineWarning, result.warning].filter(Boolean).join(" "));
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
    if (selected.kind === "crm") {
      const result = await updateAppointment(selected.task, { subject: editTitle.trim(), startsAt: start, note: editNote });
      setBusy(false);
      if (!result.ok) return setEditError(result.error || "Modifica non riuscita.");
      setSelected(null); setEditingEvent(false);
      await load();
      if (result.warning) setError(result.warning);
      return;
    }
    try {
      const originalStart = Date.parse(selected.event.start?.dateTime || "");
      const originalEnd = Date.parse(selected.event.end?.dateTime || "");
      const duration = originalEnd - originalStart;
      const end = new Date(start.getTime() + (duration > 0 ? duration : 60 * 60 * 1000));
      await updateGoogleCalendarEvent(selected.event.id, { title: editTitle.trim(), start: start.toISOString(), end: end.toISOString(), description: editNote.trim() });
      setSelected({ kind: "google", event: { ...selected.event, summary: editTitle.trim(), description: editNote.trim(), start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } } });
      setEditingEvent(false); await load();
    } catch (reason) { setEditError(reason instanceof Error ? reason.message : "Modifica non riuscita. Ricollega Google Calendar e riprova."); }
    setBusy(false);
  }

  async function deleteSelected() {
    if (!selected || !confirm("Eliminare questo appuntamento? Verrà rimosso anche da Google Calendar e dai KPI.")) return;
    setBusy(true); setEditError(null);
    if (selected.kind === "crm") {
      const result = await deleteAppointment(selected.task);
      setBusy(false);
      if (!result.ok) return setEditError(result.error || "Eliminazione non riuscita.");
    } else {
      try { await deleteGoogleCalendarEvent(selected.event.id); } catch (reason) { setBusy(false); return setEditError(reason instanceof Error ? reason.message : "Eliminazione non riuscita."); }
      setBusy(false);
    }
    setSelected(null); setEditingEvent(false); await load();
  }

  function bookClosingFromDiscovery() {
    if (busy || selected?.kind !== "crm") return;
    const { task, lead } = selected;
    if (task.appointment_type !== "discovery" || task.appointment_status === "cancelled" || (task.lead_id && !lead)) return;
    setSelected(null);
    openCreate(new Date(), {
      type: "demo",
      leadId: task.lead_id,
      title: appointmentSubject(task),
      audience: task.audience,
    });
  }

  async function setAppointmentOutcome(outcome: AppointmentOutcome, rebook = false, proposalMade?: boolean, markLost = false) {
    if (!selected || selected.kind !== "crm" || saveOutcomeLock.current) return;
    const { task } = selected;
    if (rebook && outcome === "no_show" && !isAppointmentClosed(task) && Date.parse(task.due_at) > Date.now()) {
      beginEdit();
      return;
    }
    saveOutcomeLock.current = true;
    setBusy(true); setEditError(null);
    try {
      const result = await recordAppointmentOutcome(task, outcome, task.outcome_minutes || undefined, undefined, proposalMade,
        markLost ? selected.lead?.stage_id : undefined);
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
    } finally {
      setBusy(false);
    }
  }

  const nextClosingStart = selected?.kind === "crm" && selected.task.appointment_type === "demo" &&
    !selected.task.completed_at && !isAppointmentClosed(selected.task) && selected.task.appointment_status !== "cancelled"
    ? new Date(Date.parse(selected.task.due_at) + 30 * 60_000)
    : null;

  function bookNextClosing() {
    if (busy || !nextClosingStart || !(nextClosingStart.getTime() > Date.now())) return;
    setSelected(null);
    openCreate(undefined, { type: "demo", title: "", startsAt: nextClosingStart });
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

  const googleSalesByKey = new Map(googleSales.map(sale => [sale.google_key, sale]));
  const displayEvents: DisplayEvent[] = [
    ...visibleTasks.map(task => ({id:`crm-${task.id}`,at:task.due_at,endAt:eventEnd(task).toISOString(),title:appointmentSubject(task),subtitle:`${task.appointment_type ? APPOINTMENT_SHORT_LABELS[task.appointment_type] : task.confirmation_for ? CONFIRMATION_LABEL : "Richiamo"} · ${task.appointment_outcome === "won" ? CLOSING_WON_LABEL : task.appointment_status === "no_show" ? task.appointment_type === "setting" && task.appointment_outcome !== "no_show" ? "Non risponde" : "No-show" : task.appointment_status === "held" || (task.confirmation_for && task.completed_at) ? "Svolta" : task.assigned_to || "CRM"}`,kind:"crm" as const,skipAsNext:Boolean(task.completed_at) || isAppointmentClosed(task),onOpen:()=>setSelected({kind:"crm",task,lead:task.lead_id ? leadById.get(task.lead_id)||null : null})})),
    ...google.filter(event => !linkedGoogleIds.has(event.id) && !calendarTasks.some(task => task.title === event.summary && event.start?.dateTime && Math.abs(new Date(task.due_at).getTime()-new Date(event.start.dateTime).getTime())<60000)).map(event => {
      const sale = googleSalesByKey.get(googleSaleKey(event));
      return {
        id: `google-${event.id}`, at: event.start?.dateTime || event.start?.date || "",
        endAt: event.end?.dateTime || event.end?.date || event.start?.date || "",
        title: event.summary || "Impegno Google", subtitle: sale ? `Vendita · ${saleOutcomes[sale.outcome]}` : "Google personale",
        kind: "google" as const, allDay: !event.start?.dateTime, skipAsNext: sale?.outcome === "no_show" || sale?.outcome === "rescheduled",
        onOpen: () => setSelected({ kind: "google", event }),
      };
    }),
    ...sharedCalendarEvents,
  ].filter(event => event.at && event.endAt);
  return <div className="page calendar-page">
    <header className="calendar-compact-bar">
      <div><h1>Calendario</h1><span aria-live="polite">{rangeLabel}</span></div>
      <div className="calendar-navigation" role="group" aria-label="Navigazione calendario">
        <button type="button" aria-label="Settimana precedente" onClick={() => shiftWeek(-1)}>‹</button>
        <button type="button" onClick={() => { setSelected(null); setOwnerEvent(null); setWeekStart(monday(new Date())); }}>Oggi</button>
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
          <button className="btn" type="button" disabled={loading} onClick={() => { if (menu.current) menu.current.open = false; void load(); }}>Aggiorna</button>
          {googleCalendarConfigured() ? <button className="btn" type="button" disabled={busy} onClick={() => { if (menu.current) menu.current.open = false; void connect(); }}>{googleCalendarConnected() ? "Google collegato" : "Collega Google Calendar"}</button> : <small>Google Calendar da configurare</small>}
        </div>
      </details>
    </header>
    {error && <div className="notice err" role="alert">{error}</div>}
    {saleError && <div className="notice err" role="alert">{saleError}</div>}
    {showOwnerCalendar && ownerCalendarError && <div className="notice warn" role="status">Calendario di Ettore temporaneamente non disponibile.</div>}
    {loading && <span className="calendar-loading" role="status">Caricamento appuntamenti…</span>}
    <CalendarSchedule days={days} events={displayEvents} onCreate={openCreate} view={view} onViewChange={setView} />
    {!saleError && <details className="panel google-sales-pending"><summary>Vendite Google registrate · questa settimana</summary>{googleSales.filter(s => s.starts_at >= weekStart.toISOString() && s.starts_at < weekEnd.toISOString()).map(s => <div className="google-sale-row" key={s.id}><div><b>{s.contact_name}</b><small>{formatDateTime(s.starts_at)} · {saleOutcomes[s.outcome]}</small></div><button className="btn" onClick={() => { setSelected(null); setSaleRecord(s); setSaleOpen(true); }}>Apri esito</button></div>)}</details>}
    {saleOpen && (saleRecord || selected?.kind === "google") && <GoogleSaleModal clientId={client.id} event={selected?.kind === "google" ? selected.event : undefined} sale={saleRecord || (selected?.kind === "google" ? googleSales.find(s => s.google_key === googleSaleKey(selected.event)) : undefined)} leads={leads} admin={admin} onClose={() => { setSaleOpen(false); setSaleRecord(null); }} onSaved={async warning => { setSaleOpen(false); setSaleRecord(null); setSelected(null); await load(); if (warning) setError(warning); }} />}
    {selected && !saleOpen && <EventDetailsModal onSale={() => setSaleOpen(true)} saleDisabled={!!saleError} hasSale={selected.kind === "google" && googleSales.some(s => s.google_key === googleSaleKey(selected.event))}  selected={selected} editing={editingEvent} title={editTitle} startsAt={editStartsAt} note={editNote} error={editError} busy={busy} onClose={() => { setSelected(null); setEditingEvent(false); }} onEdit={beginEdit} onCancelEdit={() => setEditingEvent(false)} onTitle={setEditTitle} onStartsAt={setEditStartsAt} onNote={setEditNote} onSave={() => void saveEventChanges()} onDelete={() => void deleteSelected()} onBookClosing={bookClosingFromDiscovery} onBookConfirmation={openConfirmationCall} onBookNextClosing={nextClosingStart && nextClosingStart.getTime() > Date.now() ? bookNextClosing : undefined} onOutcome={(outcome, rebook, proposalMade, markLost) => void setAppointmentOutcome(outcome, rebook, proposalMade, markLost)} canMarkConfirmationLost={selected.kind === "crm" && !!selected.lead && Boolean(stages.some(stage => stage.pipeline_id === selected.lead?.pipeline_id && stage.id !== selected.lead?.stage_id && stage.name.trim().toUpperCase() === "LOST"))} onSync={canSyncSelected ? () => void syncSelected() : undefined} />}
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
        {formError && <div className="notice err">{formError}</div>}
        {!confirmationClosingId && <div className="calendar-appointment-kind">
          <b>Tipo di appuntamento</b>
          <div className="calendar-type-options" role="group" aria-label="Tipo di appuntamento">
            {(["setting", "discovery", "demo"] as const).map(type =>
              <button key={type} type="button" className="btn" aria-pressed={appointmentType === type} disabled={busy}
                onClick={() => chooseAppointmentType(type)}>{APPOINTMENT_SHORT_LABELS[type]}</button>)}
          </div>
        </div>}
        <label>Contatto<input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="Nome del centro o della persona" /></label>
        {confirmationClosingId ? <>
          <p className="muted">Durata {CONFIRMATION_MINUTES} minuti</p>
          <LeadDateTimePicker value={startsAt} onChange={setStartsAt} disabled={busy} />
          <label>Nota (facoltativa)<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
        </> : <>
        <AppointmentTime type={appointmentType} value={startsAt} disabled={busy} onChange={setStartsAt} />
        <details key={appointmentType} open><summary>{appointmentType === "setting" ? "Lead da contattare" : "Collega il lead · sincronizza la pipeline"}</summary>
          <label>Cerca lead<input type="search" value={leadQuery} onChange={event => setLeadQuery(event.target.value)} /></label>
          <label>Lead collegato{appointmentType !== "setting" && <small> (facoltativo)</small>}<select value={leadId} onChange={event => { setLeadId(event.target.value); setAppointmentHost(""); }}>
            <option value="">Nessun lead</option>
            {leads.filter(lead => lead.id === leadId || (leadQuery.trim() && [lead.name, lead.phone, lead.email].join(" ").toLowerCase().includes(leadQuery.trim().toLowerCase()))).slice(0, 50).map(lead => <option key={lead.id} value={lead.id}>{lead.name || "Senza nome"} · {lead.phone}</option>)}
          </select></label>
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
        <footer className="calendar-appointment-footer"><button className="btn" type="button" disabled={busy} onClick={() => setCreateOpen(false)}>Annulla</button><button className="btn primary" type="button" disabled={busy} onClick={() => void saveAppointment()}>{busy ? "Salvataggio…" : "Crea appuntamento"}</button></footer>
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
  onOutcome: (outcome: AppointmentOutcome, rebook?: boolean, proposalMade?: boolean, markLost?: boolean) => void;
  canMarkConfirmationLost: boolean;
  onBookClosing: () => void;
  onBookConfirmation: () => void;
  onBookNextClosing?: () => void;
  onSync?: () => void;
};

function EventDetailsModal({
  selected, editing, title, startsAt, note, error, busy, saleDisabled, hasSale,
  onSale, onClose, onEdit, onCancelEdit, onTitle, onStartsAt, onNote, onSave, onDelete, onOutcome, onBookClosing, onBookConfirmation, onBookNextClosing, onSync, canMarkConfirmationLost,
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

  return <div className="calendar-modal-overlay" role="presentation" onClick={() => !busy && onClose()}>
    <section className="calendar-modal calendar-event-modal calendar-appointment-dialog" role="dialog" aria-modal="true" aria-label="Dettagli evento" onClick={event => event.stopPropagation()}>
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
        <LeadDateTimePicker value={startsAt} onChange={onStartsAt} disabled={busy} />
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

        {task?.appointment_type === "discovery" && task.appointment_status !== "cancelled" &&
          (!task.lead_id || (selected.kind === "crm" && selected.lead)) &&
          <button className="btn primary" type="button" disabled={busy} onClick={onBookClosing}>Prenota closing</button>}

        {onBookNextClosing &&
          <button className="btn" type="button" disabled={busy} onClick={onBookNextClosing}>Prenota un’altra demo dopo 30 min</button>}

        {task?.appointment_type === "demo" && ["held", "scheduled", "rescheduled"].includes(task.appointment_status || "") &&
          <button className="btn primary" type="button" disabled={busy} onClick={onBookConfirmation}>Prenota call di conferma</button>}

        {canReschedule && <div className="calendar-reschedule-action">
          <div><b>Il contatto ha chiesto un rinvio?</b><p>{reopenSetting ? "Spostando il setting, correggi anche l’esito precedente." : "Sposta lo stesso evento nel CRM e su Google Calendar."}</p></div>
          <button className="btn primary" type="button" disabled={busy} onClick={onEdit}>Riprogramma appuntamento</button>
        </div>}
        {task && (task.appointment_type || task.confirmation_for) && task.appointment_status !== "cancelled" &&
          (canReschedule && beforeStart
            ? <details className="calendar-early-outcome"><summary>No-show preannunciato</summary>
                <p>Usalo se il contatto ha annullato e non avete concordato un nuovo orario.</p>
                <CalendarOutcome key={`${task.id}:${task.updated_at}:${selected.kind === "crm" ? selected.lead?.stage_id : ""}`} task={task} busy={busy} onOutcome={onOutcome} canMarkLost={canMarkConfirmationLost} />
              </details>
            : <CalendarOutcome key={`${task.id}:${task.updated_at}:${selected.kind === "crm" ? selected.lead?.stage_id : ""}`} task={task} busy={busy} onOutcome={onOutcome} canMarkLost={canMarkConfirmationLost} />)}

        {(task?.commercial_tracked || task?.confirmation_for) && onSync && (!task.google_event_id || isOwnerManagedDiscovery(task)) && !task.completed_at &&
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
          <button className="btn danger" type="button" disabled={busy || hasSale} onClick={onDelete}>Elimina</button>
          {canEdit && !canReschedule && <button className="btn" type="button" disabled={busy} onClick={onEdit}>Modifica appuntamento</button>}
        </>}
      </footer>
    </section>
  </div>;
}

function CalendarOutcome({ task, busy, onOutcome, canMarkLost }: {
  task: SalesTask; busy: boolean; canMarkLost: boolean; onOutcome: EventDetailsProps["onOutcome"];
}) {
  const [value, setValue] = useState<AppointmentOutcome | "">((task.appointment_outcome || "") as AppointmentOutcome | "");
  const [proposalMade, setProposalMade] = useState(task.proposal_made ?? undefined);
  const [markLost, setMarkLost] = useState(false);
  const type = task.confirmation_for ? "confirmation" : task.appointment_type;
  if (!type) return null;
  const beforeStart = Date.parse(task.due_at) > Date.now();
  const saveValue = !beforeStart || value === "no_show" ? value : "";
  const canAdvance = value === "qualified" || (task.appointment_type === "setting" && value === "answered");
  const nextAction = beforeStart || type === "confirmation" ? null : value === "qualified" ? "Salva e prenota closing"
    : task.appointment_type === "setting" && value === "answered" ? "Salva e prenota discovery"
    : value === "no_show" || value === "no_answer" ? value === "no_answer" && task.appointment_type === "setting" ? "Non risponde e riprenota setting" : "No-show e riprenota"
    : null;
  return <div className="appointment-outcomes">
    {!beforeStart && <b>{isAppointmentClosed(task) ? "Correggi l’esito" : "Com’è andata?"}</b>}
    <AppointmentOutcomeChoices type={type} value={value} disabled={busy} beforeStart={beforeStart} onChange={setValue} />
    {type === "demo" && value === "held" && <label><input type="checkbox" checked={proposalMade ?? false} disabled={busy} onChange={event => setProposalMade(event.target.checked)} /> Proposta presentata</label>}
    {type === "confirmation" && canMarkLost && <label className="calendar-confirmation-disposition">
      <input type="checkbox" checked={markLost} disabled={busy} onChange={event => setMarkLost(event.target.checked)} />
      Non interessato · sposta il lead in LOST
    </label>}
    <div className="calendar-outcome-actions">
      <button type="button" className={canAdvance ? "btn" : "btn primary"}
        disabled={busy || !saveValue} onClick={() => { if (saveValue) onOutcome(saveValue, false, proposalMade, markLost); }}>{markLost ? "Salva esito e sposta in LOST" : "Salva esito"}</button>
      {saveValue && nextAction && <button type="button" className={canAdvance ? "btn primary" : "btn"}
        disabled={busy} onClick={() => onOutcome(saveValue, true)}>{nextAction}</button>}
    </div>
  </div>;
}
