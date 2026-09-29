import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "../supabaseClient";
import { withTimeout } from "../async";
import { presenceDuration } from "../teamPresenceLogic";

type User = { id: string; name: string; role: string; online: boolean; active: boolean; last_seen_at: string | null };
type Day = { user_id: string; day: string; connected_seconds: number; active_seconds: number; session_count: number; first_seen_at: string | null; last_seen_at: string | null; recorded_operations: number; worked_leads: number; recorded_calls: number };
type Session = { id: string; user_id: string; started_at: string; last_seen_at: string; ended_at: string | null; online: boolean; connected_seconds: number; active_seconds: number };
type Report = { server_time: string; activated_at: string; retention_days: number; users: User[]; days: Day[]; sessions: Session[]; session_total: number };
const romeDay = (value = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
const addDays = (day: string, offset: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }) : "—";
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("it-IT", { timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short" });

export default function TeamActivity({ clientId, headerTools }: { clientId: string; headerTools?: ReactNode }) {
  const [preset, setPreset] = useState("today");
  const [from, setFrom] = useState(romeDay());
  const [to, setTo] = useState(romeDay());
  const [userId, setUserId] = useState("all");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [drillBack, setDrillBack] = useState<{ preset: string; from: string; to: string; userId: string } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const requestId = useRef(0);
  const end = romeDay();
  const range = preset === "custom" ? { from, to } : { from: addDays(end, preset === "today" ? 0 : -(Number(preset) - 1)), to: end };
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight || document.hidden) return;
      const ownId = ++requestId.current;
      if (!range.from || !range.to || range.from > range.to || range.from < addDays(range.to, -30)) { setError("Seleziona un periodo di massimo 31 giorni, con la data iniziale prima della finale."); setBusy(false); return; }
      inFlight = true;
      try {
        const { data, error: rpcError } = await withTimeout(supabase.rpc("team_activity_report", { p_client_id: clientId, p_from: range.from, p_to: range.to }), 15_000, "Il registro del team non risponde.");
        if (rpcError) throw new Error(rpcError.message);
        if (!disposed && ownId === requestId.current) { setReport(data as Report); setError(null); }
      } catch (reason) {
        if (!disposed && ownId === requestId.current) setError(reason instanceof Error ? reason.message : "Impossibile aggiornare il registro del team.");
      } finally { inFlight = false; if (!disposed && ownId === requestId.current) setBusy(false); }
    };
    setBusy(true); void load();
    const timer = window.setInterval(() => void load(), 30_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [clientId, range.from, range.to, refresh]);
  const users = report?.users ?? [];
  const days = useMemo(() => (report?.days ?? []).filter(day => userId === "all" || day.user_id === userId), [report, userId]);
  const totals = days.reduce((sum, day) => ({ connected: sum.connected + day.connected_seconds, active: sum.active + day.active_seconds, leads: sum.leads + day.worked_leads, calls: sum.calls + day.recorded_calls }), { connected: 0, active: 0, leads: 0, calls: 0 });
  const activationDay = report ? romeDay(new Date(report.activated_at)) : end;
  const sessions = (report?.sessions ?? []).filter(session => (userId === "all" || session.user_id === userId) && (!selectedDay || (romeDay(new Date(session.started_at)) <= selectedDay && romeDay(new Date(session.last_seen_at)) >= selectedDay)));
  const name = (id: string) => users.find(user => user.id === id)?.name ?? "Utente";
  const showDay = (day: Day) => { if (!selectedDay) setDrillBack({ preset, from, to, userId }); setUserId(day.user_id); setSelectedDay(day.day); setFrom(day.day); setTo(day.day); setPreset("custom"); };
  const showPeriod = () => { setSelectedDay(null); if (drillBack) { setPreset(drillBack.preset); setFrom(drillBack.from); setTo(drillBack.to); setUserId(drillBack.userId); setDrillBack(null); } };
  return <div className="page team-activity-page">
    <div className="team-activity-intro"><div><h1>Attività del team</h1><p>Presenza sul CRM e operazioni registrate. Riservato all’amministratore.</p></div><div className="section-header-actions">{headerTools}<button className="btn" onClick={() => setRefresh(value => value + 1)} disabled={busy}>{busy ? "Aggiornamento…" : "Aggiorna"}</button></div></div>
    <div className="team-activity-explainer"><b>Tempo sul CRM ≠ ore lavorate</b><p>Il tempo connesso può includere una scheda lasciata aperta. L’utilizzo stimato conta il CRM in primo piano, con interazioni negli ultimi 5 minuti. Le call esterne non sono misurate. Schede e dispositivi sovrapposti vengono uniti per ciascun utente.</p><small>Orari: Europe/Rome · Conservazione: 30 giorni · Rilevazione ogni 30 secondi · Offline dopo 90 secondi senza segnali</small></div>
    <div className="card kpi-filters team-activity-filters"><div><label>Periodo</label><div className="segmented">{[["today", "Oggi"], ["7", "7 giorni"], ["14", "14 giorni"], ["30", "30 giorni"], ["custom", "Personalizzato"]].map(([value, label]) => <button key={value} className={preset === value ? "active" : ""} onClick={() => { setPreset(value); setSelectedDay(null); }}>{label}</button>)}</div></div>{preset === "custom" && <div className="kpi-date-range"><label>Dal<input type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} /></label><label>Al<input type="date" value={to} max={end} onChange={event => setTo(event.target.value)} /></label></div>}<label>Utente<select value={userId} onChange={event => { setUserId(event.target.value); setSelectedDay(null); }}><option value="all">Tutto il team</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label></div>
    {error && <div className="notice err" role="alert">{error} {report && "I dati qui sotto sono quelli dell’ultimo aggiornamento riuscito."}</div>}
    {!report && busy ? <div className="center-msg">Caricamento attività del team…</div> : !report ? <div className="team-empty">Registro non disponibile. Premi Aggiorna per riprovare.</div> : <>
      <div className="team-presence-grid">{users.filter(user => userId === "all" || user.id === userId).map(user => <article className="team-presence-card" key={user.id}><div className="team-user-heading"><div className="avatar">{user.name.charAt(0)}</div><div><b>{user.name}</b><small>{user.role === "admin" ? "Amministratore" : "Venditore"}</small></div><span className={`team-status ${user.online ? "online" : "offline"}`}>{user.online ? (user.active ? "In uso" : "Connesso") : "Offline"}</span></div><p>Ultima presenza: {user.last_seen_at ? `${dateLabel(romeDay(new Date(user.last_seen_at)))} · ${time(user.last_seen_at)}` : "Non ancora rilevata"}</p></article>)}</div>
      <div className="team-summary-grid">{[["Tempo connesso", presenceDuration(totals.connected)], ["Utilizzo stimato", presenceDuration(totals.active)], ["Lead lavorati / giorno", String(totals.leads)], ["Chiamate registrate", String(totals.calls)]].map(([label, value]) => <article className="team-metric" key={label}><small>{label}</small><b>{value}</b></article>)}</div>
      <section className="team-report-card"><header><div><h2>Storico giornaliero</h2><p>Apri un giorno per vedere le sessioni. Operazioni attribuite al giorno di registrazione, non alla data della call.</p></div><small>Aggiornato alle {time(report.server_time)}</small></header><div className="team-table-scroll"><table className="team-table"><thead><tr><th>Giorno</th><th>Utente</th><th>Prima presenza</th><th>Ultima presenza</th><th>Connesso</th><th>Utilizzo stimato</th><th>Lead lavorati</th><th>Chiamate</th><th>Operazioni</th><th></th></tr></thead><tbody>{days.map(day => <tr key={`${day.day}-${day.user_id}`} className={selectedDay === day.day && userId === day.user_id ? "selected" : ""}><td>{dateLabel(day.day)}</td><td>{name(day.user_id)}</td><td>{time(day.first_seen_at)}</td><td>{time(day.last_seen_at)}</td><td>{day.day < activationDay ? "Non tracciato" : presenceDuration(day.connected_seconds)}</td><td>{day.day < activationDay ? "Non tracciato" : presenceDuration(day.active_seconds)}</td><td>{day.worked_leads}</td><td>{day.recorded_calls}</td><td>{day.recorded_operations}</td><td><button className="btn" onClick={() => showDay(day)}>Sessioni</button></td></tr>)}</tbody></table></div></section>
      <section className="team-report-card"><header><div><h2>{selectedDay ? `Sessioni · ${dateLabel(selectedDay)}` : "Sessioni del periodo"}</h2><p>Una sessione corrisponde a una scheda/dispositivo. Le durate per sessione possono sovrapporsi: il totale giornaliero non le conta due volte.</p></div>{selectedDay && <button className="btn" onClick={showPeriod}>Torna al periodo</button>}</header>{sessions.length === 0 ? <div className="team-empty">Nessuna sessione rilevata. Lo storico presenze parte dal {dateLabel(activationDay)} alle {time(report.activated_at)}.</div> : <div className="team-table-scroll"><table className="team-table"><thead><tr><th>Utente</th><th>Giorno apertura</th><th>Apertura</th><th>Ultimo segnale</th><th>Connesso</th><th>Utilizzo stimato</th><th>Stato</th></tr></thead><tbody>{sessions.map(session => <tr key={session.id}><td>{name(session.user_id)}</td><td>{dateLabel(romeDay(new Date(session.started_at)))}</td><td>{time(session.started_at)}</td><td>{dateLabel(romeDay(new Date(session.last_seen_at)))} · {time(session.last_seen_at)}</td><td>{presenceDuration(session.connected_seconds)}</td><td>{presenceDuration(session.active_seconds)}</td><td><span className={`team-status ${session.online ? "online" : "offline"}`}>{session.online ? "Connessa" : session.ended_at ? "Chiusa" : "Segnale scaduto"}</span></td></tr>)}</tbody></table></div>}{report.session_total > 1000 && <p className="muted">Mostrate le ultime 1.000 sessioni. Restringi il periodo per consultarne altre; i totali giornalieri includono tutte le sessioni.</p>}</section>
      <p className="team-method-note">Lead lavorati: contatti distinti con un’attività registrata dall’utente quel giorno; lo stesso lead può comparire in giorni diversi. Le operazioni storiche sono attribuite per autore, solo se identificabile senza ambiguità. I movimenti di colonna e le note senza un evento attribuibile non sono inclusi. Nessun dato di presenza viene usato nei KPI vendite.</p>
    </>}
  </div>;
}
