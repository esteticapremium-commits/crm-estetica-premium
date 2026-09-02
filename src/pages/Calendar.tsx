import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Lead, SalesTask } from "../types";
import { connectGoogleCalendar, googleCalendarConfigured, googleCalendarConnected, listGoogleCalendarEvents, type GoogleEvent } from "../calendarGoogle";

const romeDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const formatTime = (iso: string) => new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(new Date(iso));
const formatDateTime = (iso: string) => new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(new Date(iso));
const monday = (value: Date) => { const date = new Date(value); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date; };
const eventDay = (event: GoogleEvent) => event.start?.dateTime ? romeDay(new Date(event.start.dateTime)) : event.start?.date || "";
const eventTime = (event: GoogleEvent) => event.start?.dateTime ? formatTime(event.start.dateTime) : "Tutto il giorno";
type Selected = { kind: "crm"; task: SalesTask; lead: Lead | null } | { kind: "google"; event: GoogleEvent };

export default function Calendar({ client }: { client: Client }) {
  const [tasks, setTasks] = useState<SalesTask[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [google, setGoogle] = useState<GoogleEvent[]>([]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [weekStart, setWeekStart] = useState(() => monday(new Date()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const weekEnd = useMemo(() => { const date = new Date(weekStart); date.setDate(date.getDate() + 7); return date; }, [weekStart]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => { const date = new Date(weekStart); date.setDate(date.getDate() + index); return date; }), [weekStart]);
  const load = useCallback(async () => {
    const [taskResult, leadResult] = await Promise.all([
      supabase.from("sales_tasks").select("*").eq("client_id", client.id).gte("due_at", weekStart.toISOString()).lt("due_at", weekEnd.toISOString()).order("due_at"),
      supabase.from("leads").select("*").eq("client_id", client.id),
    ]);
    setTasks((taskResult.data as SalesTask[]) || []);
    setLeads((leadResult.data as Lead[]) || []);
    if (googleCalendarConnected()) { try { setGoogle(await listGoogleCalendarEvents(weekStart, weekEnd)); } catch { setGoogle([]); } } else setGoogle([]);
  }, [client.id, weekEnd, weekStart]);

  useEffect(() => { void load(); }, [load]);
  const leadById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const rangeLabel = `${weekStart.toLocaleDateString("it-IT", { day: "numeric", month: "short" })} – ${new Date(weekEnd.getTime() - 86400000).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" })}`;
  async function connect() { setBusy(true); setError(null); try { await connectGoogleCalendar(); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Collegamento non riuscito."); } setBusy(false); }
  function shiftWeek(amount: number) { setSelected(null); setWeekStart((current) => { const next = new Date(current); next.setDate(next.getDate() + amount * 7); return next; }); }
  function selectTask(task: SalesTask) { setSelected({ kind: "crm", task, lead: task.lead_id ? leadById.get(task.lead_id) || null : null }); }

  return <div className="page calendar-page">
    <div className="calendar-intro"><div><div className="calendar-kicker">Agenda commerciale</div><h1>Calendario</h1><p>Gli appuntamenti CRM sono condivisi con il team. Gli eventi Google personali restano privati.</p></div><div className="calendar-top-actions"><div className="calendar-navigation"><button type="button" aria-label="Settimana precedente" onClick={() => shiftWeek(-1)}>‹</button><button type="button" onClick={() => { setSelected(null); setWeekStart(monday(new Date())); }}>Oggi</button><button type="button" aria-label="Settimana successiva" onClick={() => shiftWeek(1)}>›</button></div>{googleCalendarConfigured() ? <button className={`btn ${googleCalendarConnected() ? "" : "primary"}`} disabled={busy} onClick={() => void connect()}>{googleCalendarConnected() ? "Google collegato" : "Collega Google Calendar"}</button> : <span className="calendar-notice">Google Calendar da configurare</span>}</div></div>
    {error && <div className="notice err">{error}</div>}
    <div className="calendar-toolbar"><b>{rangeLabel}</b><span><i className="crm-dot" /> Appuntamenti CRM condivisi <i className="google-dot" /> Il mio Google Calendar</span></div>
    <div className="calendar-workspace"><div className="calendar-week" aria-label={`Settimana ${rangeLabel}`}>
      {days.map((date) => {
        const iso = romeDay(date); const isToday = iso === romeDay(new Date());
        const local = tasks.filter((task) => romeDay(new Date(task.due_at)) === iso && !task.completed_at);
        const external = google.filter((event) => eventDay(event) === iso);
        const allDay = external.filter((event) => !event.start?.dateTime);
        const timed = [...local.map((task) => ({ kind: "crm" as const, at: task.due_at, task })), ...external.filter((event) => event.start?.dateTime).map((event) => ({ kind: "google" as const, at: event.start?.dateTime || "", event }))].sort((a, b) => a.at.localeCompare(b.at));
        return <section key={iso} className={`calendar-column${isToday ? " today" : ""}`}><header><span>{date.toLocaleDateString("it-IT", { weekday: "short" })}</span><b>{date.getDate()}</b></header>{allDay.length > 0 && <div className="calendar-all-day">{allDay.map((event) => <button key={event.id} className="calendar-event google all-day" onClick={() => setSelected({ kind: "google", event })}><b>{event.summary || "Impegno Google"}</b></button>)}</div>}<div className="calendar-day-events">{timed.map((item) => item.kind === "crm" ? <button key={item.task.id} className={`calendar-event crm${item.task.title.startsWith("Appuntamento —") ? " appointment" : ""}`} onClick={() => selectTask(item.task)}><time>{formatTime(item.task.due_at)}</time><b>{item.task.title.replace(/^Appuntamento —\s*/, "")}</b><small>{item.task.lead_id ? leadById.get(item.task.lead_id)?.name || "Lead" : "Attività personale"}</small></button> : <button key={item.event.id} className="calendar-event google" onClick={() => setSelected({ kind: "google", event: item.event })}><time>{eventTime(item.event)}</time><b>{item.event.summary || "Impegno Google"}</b><small>Calendario personale</small></button>)}</div>{!timed.length && !allDay.length && <span className="calendar-free">Nessun impegno</span>}</section>;
      })}
    </div><aside className="calendar-detail" aria-live="polite">{!selected ? <div className="calendar-detail-empty"><span>◷</span><b>Dettagli appuntamento</b><p>Seleziona un evento dal calendario per leggere tutte le informazioni qui.</p></div> : selected.kind === "crm" ? <><div className="calendar-detail-head"><span className="calendar-detail-label">{selected.task.title.startsWith("Appuntamento —") ? "Appuntamento CRM" : "Attività CRM"}</span><button type="button" aria-label="Chiudi dettagli" onClick={() => setSelected(null)}>×</button></div><h2>{selected.task.title.replace(/^Appuntamento —\s*/, "")}</h2><dl><div><dt>Quando</dt><dd>{formatDateTime(selected.task.due_at)}</dd></div><div><dt>Assegnato a</dt><dd>{selected.task.assigned_to || "Non assegnato"}</dd></div>{selected.lead && <div><dt>Lead</dt><dd><b>{selected.lead.name || "Senza nome"}</b>{selected.lead.phone && <small>{selected.lead.phone}</small>}{selected.lead.email && <small>{selected.lead.email}</small>}</dd></div>}{selected.task.description && <div><dt>Dettagli</dt><dd>{selected.task.description}</dd></div>}</dl><p className="calendar-detail-note">Questo appuntamento resta qui: non vieni riportato alla pipeline.</p></> : <><div className="calendar-detail-head"><span className="calendar-detail-label google-label">Evento Google</span><button type="button" aria-label="Chiudi dettagli" onClick={() => setSelected(null)}>×</button></div><h2>{selected.event.summary || "Impegno Google"}</h2><dl><div><dt>Quando</dt><dd>{selected.event.start?.dateTime ? formatDateTime(selected.event.start.dateTime) : selected.event.start?.date || "Tutto il giorno"}</dd></div>{selected.event.location && <div><dt>Luogo</dt><dd>{selected.event.location}</dd></div>}{selected.event.description && <div><dt>Note</dt><dd>{selected.event.description}</dd></div>}</dl><p className="calendar-detail-note">Evento del tuo Google Calendar: non è visibile agli altri venditori.</p></>}</aside></div>
  </div>;
}
