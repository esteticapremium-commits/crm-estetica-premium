import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AppointmentTime } from "../AppointmentFields";
import LeadDateTimePicker from "../LeadDateTimePicker";
import { withTimeout } from "../async";
import { romeStamp, romeToday } from "../dates";
import { reportRange } from "../dailySales";
import { matchesSetterQueue, setterWorkQueue, setterColumns as columns, summarizeSetterQueue, type SetterQueueFilter, type SetterStage } from "../setterQueue";
import { supabase } from "../supabaseClient";
import SetterInstructions from "./SetterInstructions";
import SetterLeadNotes from "./SetterLeadNotes";
import SetterTeamOverview from "./SetterTeamOverview";
import "./Setter.css";

const outcomes = {
  answered: "Ha risposto",
  no_answer: "Non risponde",
  not_interested: "Non interessato",
} as const;
type Outcome = keyof typeof outcomes;
type SetterAction = Outcome | "book_from_call" | "book_only";
type SetterLead = {
  database_contact?: boolean;
  lead_id: string; name: string | null; phone: string | null; email: string | null; source: string | null;
  setter_id: string; setter_name: string; seller_name: string; state: SetterStage;
  last_outcome: Outcome | null; callback_at: string | null; note: string | null;
  discovery_at: string | null; discovery_status: string | null;
};
type SetterTotals = { contacts: number; answered: number; booked: number; held: number };
type Workspace = { queue: SetterLead[]; totals: SetterTotals };
type Staff = { id: string; role: string; full_name: string | null; email: string | null; client_id: string | null };
type LeadChoice = { id: string; name: string | null; phone: string | null };

const labelFor = (person: Staff) => person.full_name || person.email || "Utente";
const errorMessage = (reason: unknown) => typeof reason === "object" && reason && "message" in reason
  ? String(reason.message) : "Operazione non riuscita. Riprova.";

const romeClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});

function romeAppointmentTime(value: string) {
  // For modern dates Rome uses UTC+2 in summer and UTC+1 in winter.
  // Round-trip the wall time so the skipped hour in spring is rejected.
  return ["+02:00", "+01:00"].map(offset => Date.parse(value + offset))
    .find(instant => Number.isFinite(instant) && romeClock.format(instant).replace(" ", "T") === value) ?? NaN;
}

type SlotStatus = "checking" | "free" | "occupied" | "error";

async function setterCalendarRequest(body: Record<string, unknown>) {
  const { data, error } = await withTimeout(supabase.functions.invoke("setter-calendar-booking", { body }), 25_000);
  if (error) {
    const response = error.context as Response | undefined;
    const details = await response?.json?.().catch(() => undefined);
    throw Object.assign(new Error(details?.error || "Google Calendar non è raggiungibile. Riprova."), {
      occupied: details?.available === false,
    });
  }
  return data as { booked?: boolean; available?: boolean };
}

async function readSetterWorkspace(clientId: string, from: string, to: string, setterId: string | null = null) {
  const { data, error } = await withTimeout(supabase.rpc("get_complete_setter_workspace", {
    p_client_id: clientId, p_setter_id: setterId, p_from: from, p_to: to,
  }));
  if (error) throw error;
  return data as Workspace;
}

export default function Setter({ clientId, admin }: { clientId: string; admin: boolean }) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [lastUpdated, setLastUpdated] = useState(0);
  const [scopedKpis, setScopedKpis] = useState<{ scope: string; totals?: SetterTotals; error?: string }>();
  const [period, setPeriod] = useState<"today" | "week" | "month">("today");
  const [owner, setOwner] = useState("");
  const [metricsOpen, setMetricsOpen] = useState(false);
  const metricsId = useId();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffError, setStaffError] = useState("");
  const [filter, setFilter] = useState<SetterQueueFilter>(admin ? "all" : "priority");
  const [mobileColumn, setMobileColumn] = useState<SetterStage>("new");
  const [search, setSearch] = useState("");
  const [activeLeadId, setActiveLeadId] = useState<string>();
  const [workSaved, setWorkSaved] = useState<{ id: string; name: string; booked: boolean }>();
  const [assignOpen, setAssignOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const version = useRef(0);
  const queueHeading = useRef<HTMLHeadingElement>(null);

  const today = romeToday();
  const dates = period === "today" ? { from: today, to: today } : reportRange(today, period);
  const { from, to } = dates;
  const now = lastUpdated || Date.now();
  const metricsScope = `${owner}:${from}:${to}:${lastUpdated}`;
  const currentKpis = scopedKpis?.scope === metricsScope ? scopedKpis : undefined;
  const totals = admin && owner ? currentKpis?.totals : loading ? undefined : workspace?.totals;
  const activeLead = workspace?.queue.find(lead => lead.lead_id === activeLeadId);

  const load = useCallback(async (quiet = false) => {
    const request = ++version.current;
    if (!quiet) setLoading(true);
    setError("");
    try {
      const workspace = await readSetterWorkspace(clientId, from, to);
      if (version.current === request) {
        setWorkspace(workspace);
        setLastUpdated(Date.now());
      }
    } catch (reason) {
      if (version.current === request) setError(`Aggiornamento non riuscito. ${errorMessage(reason)}`);
    } finally {
      if (version.current === request) setLoading(false);
    }
  }, [clientId, from, to]);

  useEffect(() => { void load(); return () => { version.current += 1; }; }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const timer = window.setInterval(refresh, admin ? 60_000 : 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [admin, load]);
  useEffect(() => {
    if (!admin || !owner || !lastUpdated) return;
    let active = true;
    readSetterWorkspace(clientId, from, to, owner).then(result => {
      if (active) setScopedKpis({ scope: metricsScope, totals: result.totals });
    }).catch(reason => { if (active) setScopedKpis({ scope: metricsScope, error: errorMessage(reason) }); });
    return () => { active = false; };
  }, [admin, owner, lastUpdated, from, to, clientId, metricsScope]);
  useEffect(() => {
    if (!admin) return;
    let active = true;
    withTimeout(supabase.rpc("list_users")).then(({ data, error }) => {
      if (error) throw error;
      if (active) setStaff(((data || []) as Staff[]).filter(person => person.client_id === clientId));
    }).catch(reason => { if (active) setStaffError(errorMessage(reason)); });
    return () => { active = false; };
  }, [admin, clientId]);

  const shown = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("it-IT");
    return (workspace?.queue || []).filter(lead => {
      if (admin && owner && lead.setter_id !== owner) return false;
      if (term && ![lead.name, lead.phone, lead.email].some(value => value?.toLocaleLowerCase("it-IT").includes(term))) return false;
      return matchesSetterQueue(lead, filter, today, now);
    });
  }, [workspace, search, admin, owner, filter, today, now]);
  const grouped = columns.map(([id, title]) => ({ id, title, leads: shown.filter(lead => lead.state === id) }));

  const team = useMemo(() => {
    if (!admin) return [];
    const queues = new Map(staff.filter(person => person.role === "setter").map(person =>
      [person.id, { name: labelFor(person), leads: [] as SetterLead[] }]));
    for (const lead of workspace?.queue ?? []) {
      const entry = queues.get(lead.setter_id) ?? { name: lead.setter_name, leads: [] };
      entry.leads.push(lead);
      queues.set(lead.setter_id, entry);
    }
    return [...queues].map(([id, { name, leads }]) => ({ id, name, total: leads.length, ...summarizeSetterQueue(leads, today, now) }))
      .sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name, "it"));
  }, [admin, staff, workspace, today, now]);

  function openQueue(setterId: string, nextFilter: SetterQueueFilter) {
    setOwner(setterId);
    setFilter(nextFilter);
    setSearch("");
    const entries = workspace?.queue.filter(lead => !setterId || lead.setter_id === setterId);
    const firstStage = columns.find(([stage]) => entries?.some(lead => lead.state === stage))?.[0];
    setMobileColumn(nextFilter === "today" || nextFilter === "overdue" ? "follow_up" : firstStage ?? "new");
    queueHeading.current?.focus({ preventScroll: true });
    queueHeading.current?.scrollIntoView({ block: "start" });
  }

  const searching = Boolean(search.trim());
  const showWorkQueue = filter === "priority" && !searching;
  const priority = setterWorkQueue(workspace?.queue || [], today, now);
  const priorityGroups = [
    { title: "Richiami scaduti", leads: priority.overdue },
    { title: "Richiami di oggi", leads: priority.todayCallbacks },
    { title: "Nuovi lead", leads: priority.newLeads },
  ];
  const nextLead = workSaved ? priorityGroups.flatMap(group => group.leads).find(lead => lead.lead_id !== workSaved.id) : undefined;

  function renderLeadCard(lead: SetterLead) {
    return <article key={lead.lead_id} className="setter-card">
      <button type="button" className="setter-card-main" onClick={() => setActiveLeadId(lead.lead_id)}>
        <strong>{lead.name || "Lead senza nome"}</strong>
        {lead.source && <small>{lead.source}</small>}
        {admin && <small>In carico a {lead.state === "booked" ? lead.seller_name : lead.setter_name}</small>}
        {lead.discovery_at && <small>Discovery · {romeStamp(lead.discovery_at)}</small>}
        {lead.callback_at && <small className={Date.parse(lead.callback_at) < now ? "setter-overdue" : ""}>Richiamo · {romeStamp(lead.callback_at)}</small>}
        {lead.last_outcome && <small>{outcomes[lead.last_outcome]}</small>}
      </button>
      {lead.phone && <a className="btn small" href={`tel:${lead.phone.replace(/[^\d+*#,;]/g, "")}`}>Chiama</a>}
    </article>;
  }

  const firstMatchingColumn = searching && !grouped.some(column => column.id === mobileColumn && column.leads.length)
    ? grouped.find(column => column.leads.length)?.id
    : undefined;
  const visibleColumn = firstMatchingColumn ?? mobileColumn;

  const metrics = (
    <section className="panel setter-metrics" aria-label="KPI setter" data-mobile-expanded={metricsOpen}>
      <button className="btn setter-metrics-toggle" type="button" aria-expanded={metricsOpen} aria-controls={metricsId}
        onClick={() => setMetricsOpen(open => !open)}>
        <b>KPI setter</b><span aria-hidden="true">{metricsOpen ? "−" : "+"}</span>
      </button>
      <div className="setter-metrics-body" id={metricsId}>
        <div className="setter-tools">
          <h2>KPI setter</h2>
          <label>Periodo <select value={period} onChange={event => setPeriod(event.target.value as typeof period)}><option value="today">Oggi</option><option value="week">Settimana</option><option value="month">Mese</option></select></label>
        </div>
        <div className="setter-metric-grid">
          {([["contacts", "Tentativi telefonici"], ["answered", "Risposte"], ["booked", "Discovery prenotate"], ["held", "Discovery svolte"]] as const).map(([id, label]) =>
            <article key={id}><span>{label}</span><strong>{totals?.[id] ?? "—"}</strong></article>)}
        </div>
        {admin && owner && currentKpis?.error && <p className="notice warn" role="status">KPI del setter non disponibili. {currentKpis.error}</p>}
      </div>
    </section>
  );

  return <div className="page setter-page">
    <header className="setter-heading">
      <div><h1>Setter</h1><p>{admin ? "Controlla le code del team e i prossimi appuntamenti." : "Lavora i tuoi lead e fissa le discovery per i venditori."}</p></div>
      <div className="setter-tools">
        <SetterInstructions clientId={clientId} />
        {admin && <button className="btn primary" onClick={() => setAssignOpen(true)}>Assegna lead</button>}
        <button className="btn" onClick={() => void load()} disabled={loading}>Aggiorna</button>
      </div>
    </header>
    {error && <p className="notice err" role="alert">{error}</p>}
    {staffError && <p className="notice warn" role="status">Elenco utenti indisponibile. {staffError}</p>}
    {admin && <>
      <SetterTeamOverview summaries={team} selected={owner} now={now} loaded={Boolean(workspace)} onOpen={openQueue} />
      <div className="setter-queue-heading">
        <h2 tabIndex={-1} ref={queueHeading}>{owner ? `Pipeline di ${team.find(person => person.id === owner)?.name || "Setter"}` : "Tutte le pipeline"}</h2>
        {(owner || filter !== "all") && <button className="btn" type="button" onClick={() => openQueue("", "all")}>Tutti i setter</button>}
      </div>
    </>}
    {admin && metrics}
    <div className="setter-tools setter-filters" data-setter={!admin}>
      <label className="sr-only" htmlFor="setter-lead-search">Cerca in postazione</label>
      <input id="setter-lead-search" type="search" placeholder="Nome, telefono o email" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="segmented" aria-label="Filtra la coda">
        {(admin ? [["all","Tutti"],["new","Nuovi"],["today","Richiami di oggi"],["overdue","Scaduti"]] as const
          : [["priority","Da fare adesso"],["all","Pipeline"]] as const).map(([id,label]) => <button key={id} className={filter === id ? "active" : ""} aria-pressed={filter === id} onClick={() => {
          setFilter(id);
          if (id !== "all") setMobileColumn(id === "new" ? "new" : "follow_up");
        }}>{label}</button>)}
      </div>
    </div>
    {loading && !workspace && <p role="status">Caricamento postazione…</p>}
    {workspace && (showWorkQueue ? <div className="setter-work-queue">
      {priorityGroups.every(group => !group.leads.length) && <p className="muted">Nessun richiamo in scadenza e nessun nuovo lead.</p>}
      {priorityGroups.filter(group => group.leads.length).map(group =>
        <section className="panel setter-column" key={group.title} aria-label={group.title}>
          <h3>{group.title} <span>{group.leads.length}</span></h3>
          {group.leads.map(renderLeadCard)}
        </section>
      )}
    </div> : <>
      <div className="setter-mobile-stages" role="group" aria-label="Colonne della postazione">
        {grouped.map(({id,title,leads}) => <button key={id} className="btn" type="button"
          aria-label={`${title}, ${leads.length} lead`} aria-pressed={visibleColumn === id} disabled={searching && !leads.length && visibleColumn !== id}
          aria-controls={`setter-column-${id}`} onClick={() => setMobileColumn(id)}>
          <span>{title}</span><b>{leads.length}</b>
        </button>)}
      </div>
      <div className="setter-board">
      {grouped.map(({id,title,leads}) => {
        return <section className="panel setter-column" key={id} id={`setter-column-${id}`} aria-label={title} data-mobile-active={id === visibleColumn}>
          <h3>{title} <span>{leads.length}</span></h3>
          {leads.length === 0 && <p className="muted">Nessun lead in questa colonna.</p>}
          {leads.map(renderLeadCard)}
        </section>;
      })}
      </div>
    </>)}
    {!admin && metrics}
    {activeLead && <SetterLeadDialog key={activeLead.lead_id} clientId={clientId} lead={activeLead} admin={admin} onClose={() => setActiveLeadId(undefined)}
      onSaved={async booked => {
        setActiveLeadId(undefined);
        setWorkSaved({ id: activeLead.lead_id, name: activeLead.name || "Lead", booked });
        await load();
      }} />}
    {workSaved && <div className="overlay setter-dialog-overlay">
      <section className="modal setter-dialog" role="dialog" aria-modal="true" aria-label={workSaved.booked ? "Discovery prenotata" : "Esito salvato"}>
        <header><h2>{workSaved.booked ? "Discovery prenotata" : "Esito salvato"}</h2>
          <button className="btn small" type="button" onClick={() => setWorkSaved(undefined)}>Chiudi</button></header>
        <div className="content">
          <strong>{workSaved.name}</strong>
          {workSaved.booked && <p>Appuntamento su Google Calendar. Il lead è passato alle vendite.</p>}
          {loading ? <p role="status">Aggiornamento della coda…</p>
            : error ? <button className="btn" type="button" onClick={() => void load()}>Riprova aggiornamento</button>
            : nextLead ? <button className="btn primary" type="button" onClick={() => {
              setActiveLeadId(nextLead.lead_id); setWorkSaved(undefined);
            }}>Prossimo lead <span>{nextLead.name || "Lead"}</span></button>
            : <p>Nessun altro lead nella coda di oggi.</p>}
        </div>
      </section>
    </div>}
    {assignOpen && admin && <AssignmentDialog clientId={clientId} staff={staff} onClose={() => setAssignOpen(false)}
      onSaved={async () => { setAssignOpen(false); await load(); }} />}
  </div>;
}

function SetterLeadDialog({ clientId, lead, admin, onClose, onSaved }: { clientId: string; lead: SetterLead; admin: boolean; onClose: () => void; onSaved: (booked: boolean) => Promise<void> }) {
  const workAllowed = !admin && lead.state !== "booked";
  const [action, setAction] = useState<SetterAction | "">("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [showCallback, setShowCallback] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [slot, setSlot] = useState<{ time: string; status: SlotStatus; message?: string }>();
  const [check, setCheck] = useState(0);
  const formId = useId();
  const schedule = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const request = useRef<string>();
  const canBook = workAllowed && lead.state !== "not_interested";
  const isBooking = action === "book_from_call" || action === "book_only";
  const needsCallbackTime = showCallback && (action === "answered" || action === "no_answer");
  const timeRequired = isBooking || needsCallbackTime;
  const slotStatus = slot?.time === time ? slot.status : "checking";
  const timeMs = isBooking ? romeAppointmentTime(time) : Date.parse(time);
  const validFutureTime = timeMs > Date.now();
  const readyToSave = action && (!timeRequired || validFutureTime) && (!isBooking || slotStatus === "free");

  useEffect(() => {
    if (!isBooking || !validFutureTime) return;
    let active = true;
    setSlot({ time, status: "checking" });
    setterCalendarRequest({
      action: "availability", contactId: lead.lead_id, databaseContact: Boolean(lead.database_contact),
      start: new Date(timeMs).toISOString(),
    }).then(result => {
      if (active) setSlot({ time, status: result.available === true ? "free" : result.available === false ? "occupied" : "error" });
    }).catch(reason => {
      if (active) setSlot({ time, status: "error", message: errorMessage(reason) });
    });
    return () => { active = false; };
  }, [isBooking, validFutureTime, timeMs, time, lead.lead_id, lead.database_contact, check]);

  useEffect(() => {
    if (timeRequired && window.matchMedia("(max-width: 760px), (pointer: coarse) and (max-height: 520px)").matches) {
      schedule.current?.scrollIntoView({ block: "start" });
    }
  }, [action, timeRequired]);

  function choose(next: SetterAction) {
    if (next === action) return;
    setAction(next); setTime(""); setSlot(undefined); setShowCallback(false); setError("");
    request.current = undefined;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!workAllowed || !action || savingNote || pending.current || (isBooking && (!canBook || slotStatus !== "free"))) return;
    if (isBooking && !time) return setError("Scegli data e ora della Discovery.");
    if (needsCallbackTime && !time) return setError("Scegli data e ora del richiamo.");
    if (time && !validFutureTime) return setError("Scegli data e ora future.");
    pending.current = true; setBusy(true); setError("");
    request.current ??= crypto.randomUUID();
    try {
      const identity = lead.database_contact ? {p_contact_id: lead.lead_id} : {p_lead_id: lead.lead_id};
      const args = {...identity, p_request_id: request.current, p_note: note.trim() || null};
      const scheduledAt = (isBooking || needsCallbackTime) && time ? new Date(timeMs).toISOString() : null;
      if (isBooking) {
        const result = await setterCalendarRequest({
          action: "book", contactId: lead.lead_id, databaseContact: Boolean(lead.database_contact),
          requestId: request.current, start: scheduledAt, note: note.trim(), recordCall: action === "book_from_call",
        });
        if (!result.booked) throw new Error("Prenotazione da verificare. Riprova sullo stesso orario.");
      } else {
        const { error } = await withTimeout(supabase.rpc(lead.database_contact ? "record_database_setter_contact" : "record_setter_contact",
          {...args, p_outcome: action, p_callback_at: scheduledAt}));
        if (error) throw error;
      }
      await onSaved(isBooking);
    } catch (reason) {
      if (isBooking && typeof reason === "object" && reason && "occupied" in reason && reason.occupied) {
        setSlot({ time, status: "occupied" });
      }
      setError(errorMessage(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <div className="overlay setter-dialog-overlay">
    <section className="modal setter-dialog setter-lead-dialog" role="dialog" aria-modal="true" aria-label="Scheda setter">
      <header><div><h2>{lead.name || "Lead senza nome"}</h2><p>{lead.state === "booked" ? `In carico a ${lead.seller_name}` : `In carico a ${lead.setter_name} · Setter`}</p></div><div className="setter-tools"><SetterInstructions clientId={clientId} small /><button className="btn small" onClick={onClose} disabled={busy || savingNote}>Chiudi</button></div></header>
      <form className="content" id={formId} onSubmit={event => void submit(event)}>
        {(lead.phone || lead.email) && <div className="setter-tools setter-contact-tools">
          {lead.phone && <a className="btn" href={`tel:${lead.phone.replace(/[^\d+*#,;]/g, "")}`}>Chiama {lead.phone}</a>}
          {lead.email && <span>{lead.email}</span>}
        </div>}
        {lead.note && <p className="setter-last-outcome-note"><strong>Nota dell’ultimo esito</strong><br />{lead.note}</p>}
        {lead.discovery_at && <p>Discovery · {romeStamp(lead.discovery_at)}</p>}
        <SetterLeadNotes clientId={clientId} contactId={lead.lead_id} databaseContact={Boolean(lead.database_contact)}
          editable={!admin} disabled={busy} onSavingChange={setSavingNote} />
        {workAllowed && <>
          <b>Com’è andata?</b>
          <div className="setter-tools setter-outcome-tools" role="group" aria-label="Esito setting">
            {canBook && <button className={`btn setter-discovery-action${action === "book_from_call" ? " primary" : ""}`} type="button" aria-pressed={action === "book_from_call"} disabled={busy} onClick={() => choose("book_from_call")}>Ha risposto e prenota Discovery</button>}
            {Object.entries(outcomes).map(([key,label]) => <button key={key} type="button" className={action === key ? "btn primary" : "btn"} aria-pressed={action === key} disabled={busy} onClick={() => choose(key as Outcome)}>{label}</button>)}
          </div>
          {canBook && <div className="setter-tools setter-book-only"><button className={action === "book_only" ? "btn small primary" : "btn small"} type="button" aria-pressed={action === "book_only"} disabled={busy} onClick={() => choose("book_only")}>Prenota Discovery</button></div>}
          {(action === "answered" || action === "no_answer") && <label className="setter-callback-option"><input type="checkbox" checked={showCallback} disabled={busy} onChange={e => {setShowCallback(e.target.checked);setTime("");}} /> Fissa un richiamo</label>}
          {timeRequired && <div className="setter-schedule" ref={schedule}>
            {isBooking ? <>
              <small>{action === "book_from_call" ? "Salvi un tentativo con risposta e una prenotazione." : "Usalo se hai già registrato la chiamata o se hai fissato l’appuntamento via messaggio."}</small>
              <AppointmentTime type="discovery" value={time} disabled={busy} onChange={value => {
                setTime(value); setSlot(undefined); setError(""); request.current = undefined;
              }} revealPanel />
              <div className="setter-calendar-status">
                <p role="status" className={slotStatus === "free" && validFutureTime ? "setter-note-status" : "muted"}>
                  {!validFutureTime ? "Scegli data e ora (fuso di Roma) per verificare la disponibilità di Ettore."
                    : slotStatus === "checking" ? "Verifica disponibilità su Google Calendar…"
                    : slotStatus === "free" ? "Orario libero nel calendario di Ettore."
                    : slotStatus === "occupied" ? "Orario occupato. Scegli un altro orario."
                    : slot?.message || "Disponibilità non verificata. Riprova per continuare."}
                </p>
                {validFutureTime && (slotStatus === "error" || slotStatus === "occupied") &&
                  <button type="button" className="btn small" disabled={busy} onClick={() => {
                    setSlot({ time, status: "checking" }); setError(""); setCheck(value => value + 1);
                  }}>Verifica di nuovo</button>}
              </div>
            </> : <LeadDateTimePicker value={time} disabled={busy} onChange={setTime} revealPanel />}
          </div>}
          {action && <label>Nota dell’esito (facoltativa)<textarea maxLength={3000} rows={3} value={note} disabled={busy} onChange={e => setNote(e.target.value)} /></label>}
        </>}
      </form>
      {workAllowed && <footer className="setter-dialog-footer">
        {error && <p className="notice err" role="alert">{error}</p>}
        <button className="btn primary" type="submit" form={formId} disabled={busy || savingNote || !readyToSave}>{busy ? "Salvataggio…" : action === "book_from_call" ? "Salva risposta e prenota" : isBooking ? "Conferma Discovery" : "Salva esito"}</button>
      </footer>}
    </section>
  </div>;
}

function AssignmentDialog({ clientId, staff, onClose, onSaved }: { clientId: string; staff: Staff[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const formId = useId();
  const [term, setTerm] = useState("");
  const [choices, setChoices] = useState<LeadChoice[]>([]);
  const [lead, setLead] = useState("");
  const [setter, setSetter] = useState("");
  const [seller, setSeller] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const setters = staff.filter(person => person.role === "setter");
  const sellers = staff.filter(person => person.role === "venditore");
  useEffect(() => {
    const query = term.trim().replace(/[%,()_]/g, "");
    if (query.length < 2) { setChoices([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      withTimeout(supabase.from("leads").select("id,name,phone").eq("client_id", clientId)
        .or(`name.ilike.%${query}%,phone.ilike.%${query}%`).order("name").limit(40)).then(({ data, error }) => {
        if (error) throw error;
        if (active) setChoices(data ?? []);
      }).catch(reason => { if (active) setMessage(errorMessage(reason)); });
    }, 240);
    return () => { active = false; window.clearTimeout(timer); };
  }, [clientId, term]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!lead || !setter || !seller || saving.current) return;
    saving.current = true; setBusy(true); setMessage("");
    try {
      const { error } = await withTimeout(supabase.rpc("assign_setter_lead", {p_lead_id: lead, p_setter_id: setter, p_seller_id: seller}));
      if (error) throw error;
      await onSaved();
    } catch (reason) { setMessage(errorMessage(reason)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <div className="overlay setter-dialog-overlay"><section className="modal setter-dialog" role="dialog" aria-modal="true" aria-label="Assegna lead">
    <header><h2>Assegna lead</h2><button className="btn small" disabled={busy} onClick={onClose}>Chiudi</button></header>
    <form className="content" id={formId} onSubmit={event => void submit(event)}>
      {!setters.length && <p className="notice warn">Crea un accesso Setter in Impostazioni → Accessi per iniziare.</p>}
      <label>Cerca lead<input type="search" value={term} onChange={e => {setTerm(e.target.value);setLead("");setChoices([]);}} disabled={busy} /></label>
      <label>Lead<select value={lead} onChange={e => setLead(e.target.value)} disabled={busy}><option value="">Seleziona il contatto</option>{choices.map(item => <option key={item.id} value={item.id}>{item.name || item.phone || "Lead senza nome"}</option>)}</select></label>
      <label>Setter<select value={setter} onChange={e => setSetter(e.target.value)} disabled={busy}><option value="">Seleziona</option>{setters.map(person => <option key={person.id} value={person.id}>{labelFor(person)}</option>)}</select></label>
      <label>Venditore per la discovery<select value={seller} onChange={e => setSeller(e.target.value)} disabled={busy}><option value="">Seleziona</option>{sellers.map(person => <option key={person.id} value={person.id}>{labelFor(person)}</option>)}</select></label>
    </form>
    <footer className="setter-dialog-footer">
      {message && <p role="alert" className="notice err">{message}</p>}
      <button className="btn primary" type="submit" form={formId} disabled={!lead || !setter || !seller || busy}>{busy ? "Salvataggio…" : "Assegna lead"}</button>
    </footer>
  </section></div>;
}
