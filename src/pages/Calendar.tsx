import LeadDateTimePicker from "../LeadDateTimePicker";
import { AppointmentOutcomeChoices, AppointmentTime } from "../AppointmentFields";
import { loadGoogleSales } from "../googleSalesData";
import GoogleSaleModal from "../GoogleSaleModal";
import { googleSaleKey, saleOutcomes, type GoogleSale } from "../googleSales";
import CalendarSchedule, { type DisplayEvent } from "../CalendarSchedule";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Lead, SalesTask, Stage } from "../types";
import { connectGoogleCalendar, deleteGoogleCalendarEvent, ensureGoogleCalendarConnection, googleCalendarConfigured, googleCalendarConnected, listGoogleCalendarEvents, updateGoogleCalendarEvent, type GoogleEvent } from "../calendarGoogle";
import { defaultAudience } from "../salesKpi";
import { APPOINTMENT_DURATION, APPOINTMENT_LABELS, APPOINTMENT_SHORT_LABELS, appointmentSubject, createAppointment, deleteAppointment, isAppointmentClosed, outcomeKey, recordAppointmentOutcome, retryAppointmentSync, updateAppointment, type AppointmentAudience, type AppointmentOutcome, type AppointmentType } from "../appointments";

const formatDateTime = (iso: string) => new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(new Date(iso));
const monday = (value: Date) => { const date = new Date(value); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date; };
const localDateTime = (date: Date) => { const pad = (n: number) => String(n).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const eventEnd = (task: SalesTask) => new Date(new Date(task.due_at).getTime() + (task.duration_minutes || 60) * 60 * 1000);
type Selected = { kind: "crm"; task: SalesTask; lead: Lead | null } | { kind: "google"; event: GoogleEvent };
export default function Calendar({ client, meName, admin = false, headerTools }: { client: Client; meName: string; admin?: boolean; headerTools?: ReactNode }) {
  const [googleSales, setGoogleSales] = useState<GoogleSale[]>([]);
  const [saleRecord, setSaleRecord] = useState<GoogleSale | null>(null);
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [leadQuery, setLeadQuery] = useState("");
  const [appointmentHost, setAppointmentHost] = useState("");
  const [bookingId, setBookingId] = useState("");
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
    setSaleError(saleResult.error ? "Registro vendite Google non disponibile. Riprova prima di classificare una call." : null);
    setGoogleSales((saleResult.data as GoogleSale[]) || []);
    setTasks((taskResult.data as SalesTask[]) || []); setLeads((leadResult.data as Lead[]) || []); setStages((stageResult.data as Stage[]) || []);
    const connected = await ensureGoogleCalendarConnection();
    const events = connected ? await listGoogleCalendarEvents(weekStart, weekEnd) : [];
    if (version === loadVersion.current) setGoogle(events);
    } catch (reason) {
      if (version === loadVersion.current) { setGoogle([]); setError(`Calendario non aggiornato completamente: ${reason instanceof Error ? reason.message : "errore di connessione"}. Riprova con Aggiorna.`); }
    } finally { if (version === loadVersion.current) setLoading(false); }
  }, [client.id, weekEnd, weekStart]);
  useEffect(() => { void load(); }, [load]);
  const leadById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const stageNameOf = (lead: Lead | null) => (lead ? stages.find((stage) => stage.id === lead.stage_id)?.name ?? null : null);
  // Un appuntamento con un lead in CLOSED è un appuntamento con un cliente:
  // lo deduciamo, lasciando al venditore la possibilità di correggere.
  const audience = appointmentType === "setting" ? "lead" : audienceOverride ?? defaultAudience(stageNameOf(leadId ? leadById.get(leadId) || null : null));
  const rangeLabel = `${weekStart.toLocaleDateString("it-IT", { day: "numeric", month: "short" })} – ${new Date(weekEnd.getTime() - 86400000).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" })}`;
  async function connect() { setBusy(true); setError(null); try { await connectGoogleCalendar(); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Collegamento non riuscito."); } setBusy(false); }
  function shiftWeek(amount: number) { setSelected(null); setWeekStart((current) => { const next = new Date(current); next.setDate(next.getDate() + amount * 7); return next; }); }
  function openCreate(date = new Date(), prefill?: { type: AppointmentType; leadId?: string | null; title: string; audience?: AppointmentAudience | null; previousOutcomeKey?: string }) { const initial = new Date(date); initial.setHours(10, 0, 0, 0); if (initial < new Date()) initial.setTime(Math.ceil(Date.now() / 1_800_000) * 1_800_000); setTitle(prefill?.title || ""); setStartsAt(localDateTime(initial)); setDurationOverride(null); setNote(""); setLeadQuery(""); setAppointmentHost(""); setLeadId(prefill?.leadId || ""); setAppointmentType(prefill?.type || "discovery"); setAudienceOverride(prefill?.audience || null); setBookingId(crypto.randomUUID()); setPreviousOutcomeKey(prefill?.previousOutcomeKey); setFormError(null); setCreateOpen(true); }
  function chooseAppointmentType(type: AppointmentType) {
    if (type === appointmentType) return;
    setAppointmentType(type);
    setDurationOverride(null);
  }
  async function saveAppointment() {
    if (saveLock.current) return;
    const lead = leadId ? leadById.get(leadId) : null;
    const subject = title.trim() || lead?.name || "";
    const start = new Date(startsAt);
    const minutes = appointmentType === "setting" ? APPOINTMENT_DURATION.setting : durationOverride ?? APPOINTMENT_DURATION[appointmentType];
    if (appointmentType === "setting" && !lead) return setFormError("Cerca e seleziona il lead a cui collegare il setting.");
    if (!subject || !Number.isFinite(start.getTime()) || minutes < 15) return setFormError("Inserisci contatto, data e ora.");
    saveLock.current = true; setBusy(true); setFormError(null);
    try {
      const result = await createAppointment({
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

  async function setAppointmentOutcome(outcome: AppointmentOutcome, rebook = false, proposalMade?: boolean) {
    if (!selected || selected.kind !== "crm" || saveOutcomeLock.current) return;
    const { task } = selected;
    saveOutcomeLock.current = true;
    setBusy(true); setEditError(null);
    try {
      const result = await recordAppointmentOutcome(task, outcome, task.outcome_minutes || undefined, undefined, proposalMade);
      if (!result.ok) return setEditError(result.error || "Esito non salvato.");
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

  const visibleTasks = tasks.filter(task => task.appointment_type || !task.completed_at);
  const displayEvents: DisplayEvent[] = [
    ...visibleTasks.map(task => ({id:`crm-${task.id}`,at:task.due_at,endAt:eventEnd(task).toISOString(),title:appointmentSubject(task),subtitle:`${task.appointment_type ? APPOINTMENT_SHORT_LABELS[task.appointment_type] : "Richiamo"} · ${task.appointment_status === "held" ? "Svolta" : task.appointment_status === "no_show" ? task.appointment_type === "setting" && task.appointment_outcome !== "no_show" ? "Non risponde" : "No-show" : task.assigned_to || "CRM"}`,kind:"crm" as const,onOpen:()=>setSelected({kind:"crm",task,lead:task.lead_id ? leadById.get(task.lead_id)||null : null})})),
    ...google.filter(event => !visibleTasks.some(task => task.google_event_id === event.id || (task.title === event.summary && event.start?.dateTime && Math.abs(new Date(task.due_at).getTime()-new Date(event.start.dateTime).getTime())<60000))).map(event => ({id:`google-${event.id}`,at:event.start?.dateTime || event.start?.date || "",endAt:event.end?.dateTime || event.end?.date || event.start?.date || "",title:event.summary || "Impegno Google",subtitle:googleSales.some(s => s.google_key === googleSaleKey(event)) ? `Vendita · ${saleOutcomes[googleSales.find(s => s.google_key === googleSaleKey(event))!.outcome]}` : "Google personale",kind:"google" as const,allDay:!event.start?.dateTime,onOpen:()=>setSelected({kind:"google",event})}))
  ].filter(event => event.at && event.endAt);
  return <div className="page calendar-page">
    <div className="calendar-intro"><div><div className="calendar-kicker">Agenda commerciale</div><h1>Calendario</h1><p>Appuntamenti CRM condivisi; Google personale privato. Gli appuntamenti sovrapposti restano tutti visibili.</p></div><div className="calendar-top-actions">{headerTools}<button className="btn primary" type="button" onClick={() => openCreate()}>+ Nuovo appuntamento</button><div className="calendar-navigation"><button type="button" aria-label="Settimana precedente" onClick={() => shiftWeek(-1)}>‹</button><button type="button" onClick={() => { setSelected(null); setWeekStart(monday(new Date())); }}>Oggi</button><button type="button" aria-label="Settimana successiva" onClick={() => shiftWeek(1)}>›</button></div>{googleCalendarConfigured() ? <button className={`btn ${googleCalendarConnected() ? "" : "primary"}`} disabled={busy} onClick={() => void connect()}>{googleCalendarConnected() ? "Google collegato" : "Collega Google Calendar"}</button> : <span className="calendar-notice">Google Calendar da configurare</span>}</div></div>
    {error && <div className="notice err">{error}</div>}
    {saleError && <div className="notice err">{saleError}</div>}
    <div className="calendar-toolbar"><b>{rangeLabel}</b><span><i className="crm-dot" /> CRM condiviso <i className="google-dot" /> Il mio Google Calendar</span></div>
    <div className="calendar-refresh-status"><button className="btn" disabled={loading} onClick={() => void load()}>{loading ? "Aggiornamento…" : "Aggiorna"}</button>{loading && <span role="status">Caricamento appuntamenti…</span>}</div>
    <CalendarSchedule days={days} events={displayEvents} onCreate={openCreate} />
    {!saleError && <section className="panel google-sales-pending"><h2>Vendite Google registrate · questa settimana</h2><p>Esiti consultabili anche quando Google non è collegato.</p>{googleSales.filter(s => s.starts_at >= weekStart.toISOString() && s.starts_at < weekEnd.toISOString()).map(s => <div className="google-sale-row" key={s.id}><div><b>{s.contact_name}</b><small>{formatDateTime(s.starts_at)} · {saleOutcomes[s.outcome]}</small></div><button className="btn" onClick={() => { setSelected(null); setSaleRecord(s); setSaleOpen(true); }}>Apri esito</button></div>)}</section>}
    {saleOpen && (saleRecord || selected?.kind === "google") && <GoogleSaleModal clientId={client.id} event={selected?.kind === "google" ? selected.event : undefined} sale={saleRecord || (selected?.kind === "google" ? googleSales.find(s => s.google_key === googleSaleKey(selected.event)) : undefined)} leads={leads} admin={admin} onClose={() => { setSaleOpen(false); setSaleRecord(null); }} onSaved={() => { setSaleOpen(false); setSaleRecord(null); setSelected(null); void load(); }} />}
    {selected && !saleOpen && <EventDetailsModal onSale={() => setSaleOpen(true)} saleDisabled={!!saleError} hasSale={selected.kind === "google" && googleSales.some(s => s.google_key === googleSaleKey(selected.event))}  selected={selected} editing={editingEvent} title={editTitle} startsAt={editStartsAt} note={editNote} error={editError} busy={busy} onClose={() => { setSelected(null); setEditingEvent(false); }} onEdit={beginEdit} onCancelEdit={() => setEditingEvent(false)} onTitle={setEditTitle} onStartsAt={setEditStartsAt} onNote={setEditNote} onSave={() => void saveEventChanges()} onDelete={() => void deleteSelected()} onOutcome={(outcome, rebook, proposalMade) => void setAppointmentOutcome(outcome, rebook, proposalMade)} onSync={selected.kind === "crm" && (selected.task.created_by === meName || (selected.task.setter_id && selected.task.assigned_to === meName)) ? () => void syncSelected() : undefined} />}
    {createOpen && <div className="calendar-modal-overlay" role="presentation" onClick={() => !busy && setCreateOpen(false)}>
      <section className="calendar-modal calendar-create" role="dialog" aria-modal="true" aria-label="Nuovo appuntamento" onClick={(event) => event.stopPropagation()}>
        <div className="calendar-detail-head"><span className="calendar-detail-label">Nuovo appuntamento</span><button type="button" aria-label="Chiudi" onClick={() => setCreateOpen(false)}>×</button></div>
        <h2>Fissa appuntamento</h2><p className="calendar-create-copy">Scegli la fase corretta: il CRM userà questo dato per i KPI giornalieri.</p>
        {formError && <div className="notice err">{formError}</div>}
        <div>Tipo di appuntamento<div className="channel-choice">{(["setting", "discovery", "demo"] as const).map(type =>
          <button key={type} type="button" className={appointmentType === type ? "active" : ""} onClick={() => chooseAppointmentType(type)}>{APPOINTMENT_LABELS[type]}</button>)}</div></div>
        <label>Contatto<input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="Nome del centro o della persona" /></label>
        <AppointmentTime type={appointmentType} value={startsAt} disabled={busy} onChange={setStartsAt} />
        <details key={appointmentType} open={appointmentType === "setting" || undefined}><summary>{appointmentType === "setting" ? "Lead da contattare" : "Opzioni e collegamento alla pipeline"}</summary>
          <label>Cerca lead<input type="search" value={leadQuery} onChange={event => setLeadQuery(event.target.value)} /></label>
          <label>Lead collegato{appointmentType !== "setting" && <small> (facoltativo)</small>}<select value={leadId} onChange={event => { setLeadId(event.target.value); setAppointmentHost(""); }}>
            <option value="">Nessun lead</option>
            {leads.filter(lead => lead.id === leadId || (leadQuery.trim() && [lead.name, lead.phone, lead.email].join(" ").toLowerCase().includes(leadQuery.trim().toLowerCase()))).slice(0, 50).map(lead => <option key={lead.id} value={lead.id}>{lead.name || "Senza nome"} · {lead.phone}</option>)}
          </select></label>
          {leadId && leadById.get(leadId)?.assigned_to && leadById.get(leadId)?.assigned_to !== meName &&
            <label>Chi conduce<select value={appointmentHost} onChange={event => setAppointmentHost(event.target.value)}>
              <option value="">{leadById.get(leadId)?.assigned_to}</option><option>{meName}</option>
            </select></label>}
          {appointmentType !== "setting" && <><label>Con chi<select value={audience} onChange={event => setAudienceOverride(event.target.value as AppointmentAudience)}><option value="lead">Nuovo lead</option><option value="client">Già cliente</option></select></label>
          <label>Durata<select value={durationOverride ?? APPOINTMENT_DURATION[appointmentType]} onChange={event => setDurationOverride(Number(event.target.value))}><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 ora</option><option value="90">1 ora e 30</option><option value="120">2 ore</option></select></label></>}
          <label>Nota<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
        </details>
        <footer><button className="btn" type="button" disabled={busy} onClick={() => setCreateOpen(false)}>Annulla</button><button className="btn primary" type="button" disabled={busy} onClick={() => void saveAppointment()}>{busy ? "Salvataggio…" : "Crea appuntamento"}</button></footer>
      </section>
    </div>}
  </div>;
}

function EventDetailsModal({ onSale, saleDisabled, hasSale, selected, editing, title, startsAt, note, error, busy, onClose, onEdit, onCancelEdit, onTitle, onStartsAt, onNote, onSave, onDelete, onOutcome, onSync }: { onSale: () => void; saleDisabled: boolean; hasSale: boolean; selected: Selected; editing: boolean; title: string; startsAt: string; note: string; error: string | null; busy: boolean; onClose: () => void; onEdit: () => void; onCancelEdit: () => void; onTitle: (value: string) => void; onStartsAt: (value: string) => void; onNote: (value: string) => void; onSave: () => void; onDelete: () => void; onOutcome: (outcome: AppointmentOutcome, rebook?: boolean, proposalMade?: boolean) => void; onSync?: () => void }) {
  const heading = selected.kind === "crm" ? selected.task.title.replace(/^Appuntamento —\s*/, "") : selected.event.summary || "Impegno Google";
  return <div className="calendar-modal-overlay" role="presentation" onClick={() => !busy && onClose()}><section className="calendar-modal calendar-event-modal" role="dialog" aria-modal="true" aria-label="Dettagli evento" onClick={(event) => event.stopPropagation()}><div className="calendar-detail-head"><span className={`calendar-detail-label${selected.kind === "google" ? " google-label" : ""}`}>{selected.kind === "google" ? "Evento Google personale" : selected.task.appointment_type ? APPOINTMENT_LABELS[selected.task.appointment_type] : "Appuntamento CRM"}</span><button type="button" aria-label="Chiudi dettagli" onClick={onClose}>×</button></div><h2>{editing ? "Modifica appuntamento" : heading}</h2>{error && <div className="notice err">{error}</div>}{editing ? <div className="calendar-event-edit"><label>Titolo<input autoFocus value={title} onChange={(event) => onTitle(event.target.value)} /></label><LeadDateTimePicker value={startsAt} onChange={onStartsAt} disabled={busy} /><label>Note<textarea value={note} onChange={(event) => onNote(event.target.value)} /></label></div> : <><dl>{selected.kind === "crm" ? <><div><dt>Quando</dt><dd>{formatDateTime(selected.task.due_at)}</dd></div><div><dt>Durata</dt><dd>{selected.task.duration_minutes || (selected.task.appointment_type ? APPOINTMENT_DURATION[selected.task.appointment_type] : 60)} minuti</dd></div><div><dt>Stato</dt><dd>{selected.task.appointment_status === "held" ? "Svolta" : selected.task.appointment_status === "no_show" ? selected.task.appointment_type === "setting" && selected.task.appointment_outcome !== "no_show" ? "Non risponde" : "No-show" : "Da svolgere"}</dd></div><div><dt>Assegnato a</dt><dd>{selected.task.assigned_to || "Non assegnato"}</dd></div>{selected.task.appointment_host && <div><dt>Conduce</dt><dd>{selected.task.appointment_host}</dd></div>}{selected.lead && <div><dt>Lead</dt><dd><b>{selected.lead.name || "Senza nome"}</b>{selected.lead.phone && <small>{selected.lead.phone}</small>}{selected.lead.email && <small>{selected.lead.email}</small>}</dd></div>}{selected.task.description && <div><dt>Dettagli</dt><dd>{selected.task.description}</dd></div>}</> : <><div><dt>Quando</dt><dd>{selected.event.start?.dateTime ? formatDateTime(selected.event.start.dateTime) : selected.event.start?.date || "Tutto il giorno"}</dd></div>{selected.event.location && <div><dt>Luogo</dt><dd>{selected.event.location}</dd></div>}{selected.event.description && <div><dt>Note</dt><dd>{selected.event.description}</dd></div>}</>}</dl>{selected.kind === "crm" && selected.task.appointment_type && selected.task.appointment_status !== "cancelled" && <CalendarOutcome key={selected.task.id} task={selected.task} busy={busy} onOutcome={onOutcome} />}
    {selected.kind === "crm" && selected.task.commercial_tracked && onSync && !selected.task.google_event_id && !selected.task.completed_at && <button type="button" className="btn small" disabled={busy} onClick={onSync}>Sincronizza con Google</button>}
    <p className="calendar-detail-note">{selected.kind === "google" ? "L’evento Google resta personale. Con “Appuntamento di vendita” puoi condividere nel CRM solo i dati commerciali scelti." : "L'esito vale una volta sola: correggerlo aggiorna la registrazione esistente, non ne crea una seconda."}</p></>}{selected.kind === "google" && !editing && <button className="btn primary" disabled={busy || saleDisabled || !selected.event.start?.dateTime} onClick={onSale}>{hasSale ? "Registra / correggi esito vendita" : "Appuntamento di vendita"}</button>}{hasSale && <p className="calendar-detail-note">Questa call ha una registrazione commerciale nel CRM. Modifiche a Google non riscrivono l’esito: aggiorna anche la registrazione.</p>}<footer className="calendar-event-footer">{editing ? <><button className="btn" type="button" disabled={busy} onClick={onCancelEdit}>Annulla</button><button className="btn primary" type="button" disabled={busy} onClick={onSave}>{busy ? "Salvataggio…" : "Salva modifiche"}</button></> : <><button className="btn danger" type="button" disabled={busy || hasSale} onClick={onDelete}>Elimina</button><button className="btn" type="button" onClick={onEdit}>Modifica</button></>}</footer></section></div>;
}


function CalendarOutcome({ task, busy, onOutcome }: {
  task: SalesTask; busy: boolean; onOutcome: (outcome: AppointmentOutcome, rebook?: boolean, proposalMade?: boolean) => void;
}) {
  const [value, setValue] = useState<AppointmentOutcome | "">((task.appointment_outcome || "") as AppointmentOutcome | "");
  const [proposalMade, setProposalMade] = useState(task.proposal_made ?? undefined);
  if (!task.appointment_type) return null;
  const beforeStart = Date.parse(task.due_at) > Date.now();
  const canSave = value && (!beforeStart || value === "no_show");
  const nextAction = value === "qualified" ? "Salva e prenota closing"
    : task.appointment_type === "setting" && value === "answered" ? "Salva e prenota discovery"
    : value === "no_show" || value === "no_answer" ? value === "no_answer" && task.appointment_type === "setting" ? "Non risponde e riprenota setting" : "No-show e riprenota"
    : null;
  return <div className="appointment-outcomes">
    <b>{isAppointmentClosed(task) ? "Correggi l’esito" : beforeStart ? "Il contatto ha annullato?" : "Com’è andata?"}</b>
    <AppointmentOutcomeChoices type={task.appointment_type} value={value} disabled={busy} beforeStart={beforeStart} onChange={setValue} />
    {value === "held" && <label><input type="checkbox" checked={proposalMade ?? false} disabled={busy} onChange={event => setProposalMade(event.target.checked)} /> Proposta presentata</label>}
    {canSave && <div className="lead-appointment-actions">
      <button className="btn small primary" disabled={busy} onClick={() => onOutcome(value, false, proposalMade)}>Salva esito</button>
      {nextAction && <button className="btn small" disabled={busy} onClick={() => onOutcome(value, true)}>{nextAction}</button>}
    </div>}
  </div>;
}
