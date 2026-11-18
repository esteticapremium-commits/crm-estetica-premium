import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AppointmentTime } from "../AppointmentFields";
import LeadDateTimePicker from "../LeadDateTimePicker";
import { withTimeout } from "../async";
import { romeDay, romeStamp, romeToday } from "../dates";
import { reportRange } from "../dailySales";
import { supabase } from "../supabaseClient";
import SetterInstructions from "./SetterInstructions";
import "./Setter.css";

const columns = [
  ["new", "Da contattare"],
  ["follow_up", "Da richiamare"],
  ["booked", "Discovery fissata"],
  ["not_interested", "Non interessati"],
] as const;
const outcomes = {
  answered: "Ha risposto",
  no_answer: "Non risponde",
  not_interested: "Non interessato",
} as const;
type Outcome = keyof typeof outcomes;
type SetterLead = {
  lead_id: string; name: string | null; phone: string | null; email: string | null; source: string | null;
  setter_id: string; setter_name: string; seller_name: string; state: typeof columns[number][0];
  last_outcome: Outcome | null; callback_at: string | null; note: string | null;
  discovery_at: string | null; discovery_status: string | null;
};
type Workspace = { queue: SetterLead[]; totals: { contacts: number; answered: number; booked: number; held: number } };
type Staff = { id: string; role: string; full_name: string | null; email: string | null; client_id: string | null };
type LeadChoice = { id: string; name: string | null; phone: string | null };

const labelFor = (person: Staff) => person.full_name || person.email || "Utente";
const errorMessage = (reason: unknown) => typeof reason === "object" && reason && "message" in reason
  ? String(reason.message) : "Operazione non riuscita. Riprova.";

export default function Setter({ clientId, admin }: { clientId: string; admin: boolean }) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [period, setPeriod] = useState<"today" | "week" | "month">("today");
  const [owner, setOwner] = useState("");
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffError, setStaffError] = useState("");
  const [filter, setFilter] = useState<"all" | "new" | "today" | "overdue">("all");
  const [search, setSearch] = useState("");
  const [activeLeadId, setActiveLeadId] = useState<string>();
  const [assignOpen, setAssignOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const version = useRef(0);

  const today = romeToday();
  const dates = period === "today" ? { from: today, to: today } : reportRange(today, period);
  const { from, to } = dates;
  const activeLead = workspace?.queue.find(lead => lead.lead_id === activeLeadId);

  const load = useCallback(async () => {
    const request = ++version.current;
    setLoading(true); setError("");
    try {
      const { data, error } = await withTimeout(supabase.rpc("get_setter_workspace", {
        p_client_id: clientId, p_setter_id: owner || null, p_from: from, p_to: to,
      }));
      if (error) throw error;
      if (version.current === request) setWorkspace(data as Workspace);
    } catch (reason) {
      if (version.current === request) { setWorkspace(undefined); setError(errorMessage(reason)); }
    } finally {
      if (version.current === request) setLoading(false);
    }
  }, [clientId, owner, from, to]);

  useEffect(() => { void load(); return () => { version.current += 1; }; }, [load]);
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
      if (term && ![lead.name, lead.phone, lead.email].some(value => value?.toLocaleLowerCase("it-IT").includes(term))) return false;
      if (filter === "all") return true;
      if (filter === "new") return lead.state === "new";
      if (lead.state !== "follow_up" || !lead.callback_at) return false;
      return filter === "today" ? romeDay(lead.callback_at) === today : Date.parse(lead.callback_at) < Date.now();
    });
  }, [workspace, search, filter, today]);

  return <div className="page setter-page">
    <header className="setter-heading">
      <div><h1>Setter</h1><p>{admin ? "Assegna i contatti e segui il lavoro di ogni setter." : "Lavora i tuoi lead e fissa le discovery per i venditori."}</p></div>
      <div className="setter-tools">
        <SetterInstructions clientId={clientId} />
        {admin && <button className="btn primary" onClick={() => setAssignOpen(true)}>Assegna lead</button>}
        <button className="btn" onClick={() => void load()} disabled={loading}>Aggiorna</button>
      </div>
    </header>
    {error && <p className="notice err" role="alert">{error}</p>}
    {staffError && <p className="notice warn" role="status">Elenco utenti indisponibile. {staffError}</p>}
    <section className="panel setter-metrics" aria-label="KPI setter">
      <div className="setter-tools">
        <h2>KPI setter</h2>
        <label>Periodo <select value={period} onChange={event => setPeriod(event.target.value as typeof period)}><option value="today">Oggi</option><option value="week">Settimana</option><option value="month">Mese</option></select></label>
        {admin && <label>Setter <select value={owner} onChange={event => setOwner(event.target.value)}><option value="">Tutti</option>{staff.filter(p => p.role === "setter").map(person => <option key={person.id} value={person.id}>{labelFor(person)}</option>)}</select></label>}
      </div>
      <div className="setter-metric-grid">
        {([["contacts", "Tentativi telefonici"], ["answered", "Risposte"], ["booked", "Discovery prenotate"], ["held", "Discovery svolte"]] as const).map(([id, label]) =>
          <article key={id}><span>{label}</span><strong>{loading ? "—" : workspace?.totals[id] ?? "—"}</strong></article>)}
      </div>
    </section>
    <div className="setter-tools setter-filters">
      <label className="sr-only" htmlFor="setter-lead-search">Cerca in postazione</label>
      <input id="setter-lead-search" type="search" placeholder="Nome, telefono o email" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="segmented" aria-label="Filtra la coda">
        {([["all","Tutti"],["new","Nuovi"],["today","Richiami di oggi"],["overdue","Scaduti"]] as const).map(([id,label]) => <button key={id} className={filter === id ? "active" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
    </div>
    {loading && <p role="status">Caricamento postazione…</p>}
    {!loading && workspace && <div className="setter-board">
      {columns.map(([id, title]) => {
        const leads = shown.filter(lead => lead.state === id);
        return <section className="panel setter-column" key={id} aria-label={title}>
          <h3>{title} <span>{leads.length}</span></h3>
          {leads.length === 0 && <p className="muted">Nessun lead in questa colonna.</p>}
          {leads.map(lead => <article key={lead.lead_id} className="setter-card">
            <button type="button" className="setter-card-main" onClick={() => setActiveLeadId(lead.lead_id)}>
              <strong>{lead.name || "Lead senza nome"}</strong>
              {lead.source && <small>{lead.source}</small>}
              {admin && <small>{lead.setter_name} → {lead.seller_name}</small>}
              {lead.discovery_at && <small>Discovery · {romeStamp(lead.discovery_at)}</small>}
              {lead.callback_at && <small className={Date.parse(lead.callback_at) < Date.now() ? "setter-overdue" : ""}>Richiamo · {romeStamp(lead.callback_at)}</small>}
              {lead.last_outcome && <small>{outcomes[lead.last_outcome]}</small>}
            </button>
            {lead.phone && <a className="btn small" href={`tel:${lead.phone.replace(/[^\d+*#,;]/g, "")}`}>Chiama</a>}
          </article>)}
        </section>;
      })}
    </div>}
    {activeLead && <SetterLeadDialog key={activeLead.lead_id} clientId={clientId} lead={activeLead} admin={admin} onClose={() => setActiveLeadId(undefined)}
      onSaved={async () => { setActiveLeadId(undefined); await load(); }} />}
    {assignOpen && admin && <AssignmentDialog clientId={clientId} staff={staff} onClose={() => setAssignOpen(false)}
      onSaved={async () => { setAssignOpen(false); await load(); }} />}
  </div>;
}

function SetterLeadDialog({ clientId, lead, admin, onClose, onSaved }: { clientId: string; lead: SetterLead; admin: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const workAllowed = !admin && lead.state !== "booked";
  const [mode, setMode] = useState<"outcome" | "book">("outcome");
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [showCallback, setShowCallback] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const request = useRef<string>();
  const canBook = workAllowed && lead.state !== "not_interested";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!workAllowed || pending.current || (mode === "book" && !canBook)) return;
    if (mode === "book" && !time) return setError("Scegli data e ora della discovery.");
    if (mode === "outcome" && !outcome) return setError("Scegli l’esito del contatto.");
    if (mode === "outcome" && showCallback && outcome !== "not_interested" && !time) return setError("Scegli data e ora del richiamo.");
    if (time && (!Number.isFinite(Date.parse(time)) || Date.parse(time) <= Date.now())) return setError("Scegli data e ora future.");
    pending.current = true; setBusy(true); setError("");
    request.current ??= crypto.randomUUID();
    try {
      const args = {p_lead_id: lead.lead_id, p_request_id: request.current, p_note: note.trim() || null};
      const scheduledAt = time ? new Date(time).toISOString() : null;
      const { error } = mode === "book"
        ? await withTimeout(supabase.rpc("book_setter_discovery", {...args, p_due_at: scheduledAt}))
        : await withTimeout(supabase.rpc("record_setter_contact", {...args, p_outcome: outcome, p_callback_at: scheduledAt}));
      if (error) throw error;
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <div className="overlay">
    <section className="modal setter-dialog" role="dialog" aria-modal="true" aria-label="Scheda setter">
      <header><div><h2>{lead.name || "Lead senza nome"}</h2><p>Discovery per {lead.seller_name}</p></div><div className="setter-tools"><SetterInstructions clientId={clientId} small /><button className="btn small" onClick={onClose} disabled={busy}>Chiudi</button></div></header>
      <form className="content" onSubmit={event => void submit(event)}>
        <div className="setter-tools">
          {lead.phone && <a className="btn" href={`tel:${lead.phone.replace(/[^\d+*#,;]/g, "")}`}>Chiama {lead.phone}</a>}
          {lead.email && <span>{lead.email}</span>}
        </div>
        {lead.note && <p>{lead.note}</p>}
        {lead.discovery_at && <p>Discovery · {romeStamp(lead.discovery_at)}</p>}
        {workAllowed && <>
          <div className="setter-tools">
            <button className={mode === "outcome" ? "btn primary" : "btn"} type="button" disabled={busy} onClick={() => {setMode("outcome");setTime("");request.current=undefined;}}>Com’è andata?</button>
            {canBook && <button className={mode === "book" ? "btn primary" : "btn"} type="button" disabled={busy} onClick={() => {setMode("book");setTime("");request.current=undefined;}}>Prenota discovery</button>}
          </div>
          {mode === "outcome" ? <>
            <div className="setter-tools" role="group" aria-label="Esito setting">{Object.entries(outcomes).map(([key,label]) => <button key={key} type="button" className={outcome === key ? "btn primary" : "btn"} aria-pressed={outcome === key} disabled={busy} onClick={() => {setOutcome(key as Outcome);setTime("");}}>{label}</button>)}</div>
            {outcome !== "not_interested" && <label><input type="checkbox" checked={showCallback} disabled={busy} onChange={e => {setShowCallback(e.target.checked);setTime("");}} /> Fissa un richiamo</label>}
            {showCallback && outcome !== "not_interested" && <LeadDateTimePicker value={time} disabled={busy} onChange={setTime} />}
          </> : <AppointmentTime type="discovery" value={time} disabled={busy} onChange={setTime} />}
          <label>Nota (facoltativa)<textarea maxLength={3000} rows={3} value={note} disabled={busy} onChange={e => setNote(e.target.value)} /></label>
          {error && <p className="notice err" role="alert">{error}</p>}
          <button className="btn primary" disabled={busy || (mode === "outcome" && !outcome)}>{busy ? "Salvataggio…" : mode === "book" ? "Conferma discovery" : "Salva esito"}</button>
        </>}
      </form>
    </section>
  </div>;
}

function AssignmentDialog({ clientId, staff, onClose, onSaved }: { clientId: string; staff: Staff[]; onClose: () => void; onSaved: () => Promise<void> }) {
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
  return <div className="overlay"><section className="modal setter-dialog" role="dialog" aria-modal="true" aria-label="Assegna lead">
    <header><h2>Assegna lead</h2><button className="btn small" disabled={busy} onClick={onClose}>Chiudi</button></header>
    <form className="content" onSubmit={event => void submit(event)}>
      {!setters.length && <p className="notice warn">Crea un accesso Setter in Impostazioni → Accessi per iniziare.</p>}
      <label>Cerca lead<input type="search" value={term} onChange={e => {setTerm(e.target.value);setLead("");setChoices([]);}} disabled={busy} /></label>
      <label>Lead<select value={lead} onChange={e => setLead(e.target.value)} disabled={busy}><option value="">Seleziona il contatto</option>{choices.map(item => <option key={item.id} value={item.id}>{item.name || item.phone || "Lead senza nome"}</option>)}</select></label>
      <label>Setter<select value={setter} onChange={e => setSetter(e.target.value)} disabled={busy}><option value="">Seleziona</option>{setters.map(person => <option key={person.id} value={person.id}>{labelFor(person)}</option>)}</select></label>
      <label>Venditore per la discovery<select value={seller} onChange={e => setSeller(e.target.value)} disabled={busy}><option value="">Seleziona</option>{sellers.map(person => <option key={person.id} value={person.id}>{labelFor(person)}</option>)}</select></label>
      {message && <p role="alert" className="notice err">{message}</p>}
      <button className="btn primary" disabled={!lead || !setter || !seller || busy}>{busy ? "Salvataggio…" : "Assegna lead"}</button>
    </form>
  </section></div>;
}
