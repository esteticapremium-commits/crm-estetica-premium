import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Lead, Pipeline, Stage } from "../types";
import { romeToday } from "../dates";

type View = "today" | "upcoming" | "missing";

export default function Tasks({ client, pipeline, meName, admin, onOpenLead }: { client: Client; pipeline: Pipeline | null; meName: string; admin: boolean; onOpenLead: (lead: Lead) => void }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [view, setView] = useState<View>("today");
  const [planning, setPlanning] = useState<Lead | null>(null);
  const [date, setDate] = useState(romeToday());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const today = romeToday();

  const load = useCallback(async () => {
    const [leadResult, stageResult] = await Promise.all([
      supabase.from("leads").select("*").eq("client_id", client.id).order("next_action_date", { ascending: true, nullsFirst: false }),
      supabase.from("stages").select("*").eq("client_id", client.id).order("position"),
    ]);
    setLeads((leadResult.data as Lead[]) ?? []);
    setStages((stageResult.data as Stage[]) ?? []);
  }, [client.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPlanning(null); }, [pipeline?.id]);

  const stageById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);
  const scoped = useMemo(() => leads.filter((lead) => !pipeline || lead.pipeline_id === pipeline.id), [leads, pipeline]);
  const isClosed = (lead: Lead) => ["CLOSED", "LOST"].includes(stageById.get(lead.stage_id)?.name ?? "");
  const active = scoped.filter((lead) => !isClosed(lead));
  const overdue = active.filter((lead) => lead.next_action_date && lead.next_action_date < today);
  const dueToday = active.filter((lead) => lead.next_action_date === today);
  const upcoming = active.filter((lead) => lead.next_action_date && lead.next_action_date > today);
  const missing = active.filter((lead) => !lead.next_action_date);
  const list = view === "today" ? [...overdue, ...dueToday] : view === "upcoming" ? upcoming : missing;

  async function savePlan() {
    if (!planning || !date) return;
    setBusy(true);
    const { error } = await supabase.from("leads").update({ next_action_date: date }).eq("id", planning.id);
    if (!error && note.trim()) {
      await supabase.from("lead_activities").insert({
        lead_id: planning.id, client_id: client.id, activity_type: "follow_up", outcome: "Prossima azione pianificata", note: note.trim(), next_action_date: date, created_by: meName,
      });
    }
    setBusy(false);
    if (error) return alert("Non sono riuscito a pianificare l'attività: " + error.message);
    setPlanning(null); setNote(""); await load();
  }

  async function complete(lead: Lead) {
    if (!window.confirm(`Segnare l'attività per ${lead.name || "questo lead"} come completata? Il lead resterà nell'elenco “Senza prossimo passo” finché non pianifichi il seguito.`)) return;
    setBusy(true);
    const { error } = await supabase.from("leads").update({ next_action_date: null }).eq("id", lead.id);
    if (!error) await supabase.from("lead_activities").insert({ lead_id: lead.id, client_id: client.id, activity_type: "follow_up", outcome: "Attività completata", note: "Completata dalla lista attività", created_by: meName });
    setBusy(false);
    if (error) return alert("Non sono riuscito ad aggiornare il lead: " + error.message);
    await load();
  }

  const label = (lead: Lead) => stageById.get(lead.stage_id)?.name || "Fase non definita";
  return <div className="page tasks-page">
    <div className="tasks-intro"><div><h1>Attività commerciali</h1><p>{admin ? "Il controllo operativo di ogni lead: cosa è da fare, cosa è in ritardo e cosa non ha un seguito." : "Le tue attività collegate ai lead della pipeline. Nessun contatto deve restare senza prossimo passo."}</p></div><button className="btn primary" onClick={() => setPlanning(active[0] ?? null)} disabled={active.length === 0}>+ Pianifica attività</button></div>
    <div className="task-kpis"><button className={view === "today" ? "active danger" : ""} onClick={() => setView("today")}><b>{overdue.length}</b><span>in ritardo</span></button><button className={view === "today" ? "active" : ""} onClick={() => setView("today")}><b>{dueToday.length}</b><span>da fare oggi</span></button><button className={view === "upcoming" ? "active" : ""} onClick={() => setView("upcoming")}><b>{upcoming.length}</b><span>in programma</span></button><button className={view === "missing" ? "active warn" : ""} onClick={() => setView("missing")}><b>{missing.length}</b><span>senza prossimo passo</span></button></div>
    <div className="tasks-tabs"><button className={view === "today" ? "active" : ""} onClick={() => setView("today")}>Oggi {overdue.length > 0 && <em>{overdue.length} ritardo</em>}</button><button className={view === "upcoming" ? "active" : ""} onClick={() => setView("upcoming")}>In programma</button><button className={view === "missing" ? "active" : ""} onClick={() => setView("missing")}>Da pianificare</button></div>
    {list.length === 0 ? <div className="tasks-empty"><b>{view === "missing" ? "Tutti i lead attivi hanno un prossimo passo." : "Nessuna attività in questa lista."}</b><span>{view === "today" ? "Ottimo: puoi preparare le prossime attività dalla pipeline." : "Usa “Pianifica attività” per assegnare una data a un lead."}</span></div> : <div className="task-list">{list.map((lead) => <article className={`task-card ${lead.next_action_date && lead.next_action_date < today ? "overdue" : ""}`} key={lead.id}><div className="task-date"><b>{lead.next_action_date ? new Date(`${lead.next_action_date}T12:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "short" }) : "—"}</b><span>{lead.next_action_date && lead.next_action_date < today ? "Ritardo" : lead.next_action_date === today ? "Oggi" : "Da fissare"}</span></div><div className="task-lead"><b>{lead.name || "Lead senza nome"}</b><span>{label(lead)}{lead.phone ? ` · ${lead.phone}` : ""}</span>{lead.assigned_to && admin && <small>Assegnato a {lead.assigned_to}</small>}</div><div className="task-actions"><button className="btn small" onClick={() => onOpenLead(lead)}>Apri lead</button>{lead.next_action_date ? <><button className="btn small" onClick={() => { setPlanning(lead); setDate(today); }}>Sposta</button><button className="btn small done" disabled={busy} onClick={() => void complete(lead)}>Fatto</button></> : <button className="btn small primary" onClick={() => { setPlanning(lead); setDate(today); }}>Pianifica</button>}</div></article>)}</div>}
    {planning && <div className="overlay" onClick={() => !busy && setPlanning(null)}><div className="modal task-planner" onClick={(event) => event.stopPropagation()}><header><div><h3>Pianifica attività</h3><p>{planning.name || "Lead senza nome"} · {label(planning)}</p></div><button className="x" onClick={() => setPlanning(null)}>×</button></header><div className="content"><label>Lead</label><select value={planning.id} onChange={(event) => setPlanning(active.find((lead) => lead.id === event.target.value) ?? planning)}>{active.map((lead) => <option value={lead.id} key={lead.id}>{lead.name || "Lead senza nome"} · {label(lead)}</option>)}</select><label>Quando deve essere lavorato?</label><input type="date" value={date} onChange={(event) => setDate(event.target.value)} min={today} /><label>Promemoria / prossimo passo <small>(facoltativo, finisce nello storico)</small></label><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Es. richiamare dopo le 18, inviare proposta, confermare appuntamento…" /></div><footer><button className="btn" onClick={() => setPlanning(null)}>Annulla</button><button className="btn primary" disabled={busy} onClick={() => void savePlan()}>{busy ? "Salvataggio…" : "Pianifica"}</button></footer></div></div>}
  </div>;
}
