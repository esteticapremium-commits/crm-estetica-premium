import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Lead, LeadActivity, Pipeline, Profile, Stage } from "../types";
import { romeDay, romeLastDays, romeToday } from "../dates";

type StageEvent = { changed_by: string | null; changed_at: string; to_stage_id: string | null };

export default function Control({ client, pipelines, meName, admin }: { client: Client; pipelines: Pipeline[]; meName: string; admin: boolean }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [moves, setMoves] = useState<StageEvent[]>([]);
  const [team, setTeam] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const ids = pipelines.map((p) => p.id);
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!ids.length) return;
    setLoading(true);
    Promise.all([
      supabase.from("leads").select("*").in("pipeline_id", ids),
      supabase.from("stages").select("*").in("pipeline_id", ids),
      supabase.from("lead_activities").select("*").eq("client_id", client.id).order("created_at", { ascending: false }).limit(1000),
      supabase.from("lead_stage_events").select("changed_by,changed_at,to_stage_id").eq("client_id", client.id).order("changed_at", { ascending: false }).limit(5000),
      supabase.from("profiles").select("id,role,client_id,full_name").eq("client_id", client.id).eq("role", "venditore"),
    ]).then(([l, s, a, m, p]) => {
      setLeads((l.data as Lead[]) ?? []); setStages((s.data as Stage[]) ?? []);
      setActivities((a.data as LeadActivity[]) ?? []); setMoves((m.data as StageEvent[]) ?? []); setTeam((p.data as Profile[]) ?? []); setLoading(false);
    });
  }, [client.id, idsKey]);

  const isMine = (name: string | null) => !admin && (name ?? "").trim().toLowerCase() === meName.trim().toLowerCase();
  const visible = useMemo(() => admin ? leads : leads.filter((l) => isMine(l.assigned_to)), [leads, admin, meName]);
  const today = romeToday(); const week = romeLastDays(7);
  const active = (l: Lead) => !["CLOSED", "LOST"].includes(stages.find((s) => s.id === l.stage_id)?.name ?? "");
  const due = visible.filter((l) => active(l) && (!l.next_action_date || l.next_action_date <= today));
  const stale = visible.filter((l) => active(l) && (Date.now() - new Date(l.updated_at ?? l.created_at).getTime()) >= 2 * 86400000);
  const closed = visible.filter((l) => stages.find((s) => s.id === l.stage_id)?.name === "CLOSED");
  const activityToday = activities.filter((a) => romeDay(a.created_at) === today && (admin || isMine(a.created_by)));
  const workWeek = activities.filter((a) => week.has(romeDay(a.created_at)) && (admin || isMine(a.created_by))).length + moves.filter((m) => week.has(romeDay(m.changed_at)) && (admin || isMine(m.changed_by))).length;
  const people = useMemo(() => {
    const names = new Set<string>(); team.forEach((p) => p.full_name && names.add(p.full_name)); leads.forEach((l) => l.assigned_to && names.add(l.assigned_to)); activities.forEach((a) => a.created_by && names.add(a.created_by));
    return [...names].sort().map((name) => {
      const mine = leads.filter((l) => l.assigned_to === name); const acts = activities.filter((a) => a.created_by === name);
      const wins = mine.filter((l) => stages.find((s) => s.id === l.stage_id)?.name === "CLOSED");
      return { name, open: mine.filter(active).length, due: mine.filter((l) => active(l) && (!l.next_action_date || l.next_action_date <= today)).length, today: acts.filter((a) => romeDay(a.created_at) === today).length + moves.filter((m) => m.changed_by === name && romeDay(m.changed_at) === today).length, wins: wins.length, value: wins.reduce((n, l) => n + Number(l.value || 0), 0) };
    });
  }, [leads, activities, moves, stages, team, today]);
  if (loading) return <div className="center-msg">Caricamento controllo commerciale…</div>;
  const eur = (n: number) => "€ " + Math.round(n).toLocaleString("it-IT");
  return <div className="page control-page">
    <h1>{admin ? "Controllo vendite" : "La mia giornata"}</h1>
    <p className="sub">{admin ? "Priorità, attività e risultati del team in tempo reale." : "Le priorità da chiudere oggi: registra ogni contatto e pianifica il prossimo passo."}</p>
    <div className="cards-grid">
      <Stat k={admin ? "Lead attivi" : "I miei lead attivi"} v={visible.filter(active).length} />
      <Stat k="Da lavorare oggi" v={due.length} accent={due.length ? "#dc2626" : undefined} />
      <Stat k="Attività registrate oggi" v={activityToday.length} accent="#b88725" />
      <Stat k="Attività ultimi 7 gg" v={workWeek} />
      <Stat k="Valore chiuso" v={eur(closed.reduce((n, l) => n + Number(l.value || 0), 0))} accent="#16a34a" />
    </div>
    <div className="control-grid">
      <section className="panel"><h2>Priorità di oggi</h2>{due.length === 0 ? <p className="muted">Nessun follow-up scaduto.</p> : due.slice(0, 12).map((l) => <LeadRow key={l.id} lead={l} stages={stages} />)}</section>
      <section className="panel"><h2>Lead fermi da almeno 48 ore</h2>{stale.length === 0 ? <p className="muted">Nessun lead fermo.</p> : stale.slice(0, 12).map((l) => <LeadRow key={l.id} lead={l} stages={stages} />)}</section>
    </div>
    {admin && <section className="panel"><h2>Squadra · oggi</h2><div className="team-table"><div className="team-head"><span>Venditore</span><span>Attività</span><span>Da lavorare</span><span>Attivi</span><span>Chiusi</span><span>Valore</span></div>{people.map((p) => <div className="team-row" key={p.name}><b>{p.name}</b><span>{p.today}</span><span className={p.due ? "danger-text" : ""}>{p.due}</span><span>{p.open}</span><span>{p.wins}</span><span>{eur(p.value)}</span></div>)}</div></section>}
  </div>;
}
function Stat({ k, v, accent }: { k: string; v: string | number; accent?: string }) { return <div className="stat"><div className="k">{k}</div><div className="v" style={{ color: accent }}>{v}</div></div>; }
function LeadRow({ lead, stages }: { lead: Lead; stages: Stage[] }) { const stage = stages.find((s) => s.id === lead.stage_id)?.name ?? "—"; return <div className="control-lead"><div><b>{lead.name || "Senza nome"}</b><span>{lead.assigned_to || "Non assegnato"} · {stage}</span></div><div>{lead.next_action_date ? new Date(lead.next_action_date).toLocaleDateString("it-IT") : "Senza prossima azione"}</div></div>; }
