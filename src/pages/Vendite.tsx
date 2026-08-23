import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Lead, Pipeline, Stage } from "../types";
import { STAGE_PROBABILITY } from "./Board";

interface StageEvent {
  id: string;
  lead_id: string;
  from_stage_id: string | null;
  to_stage_id: string | null;
  changed_by: string | null;
  changed_at: string;
}

interface DayRow {
  day: string;
  label: string;
  movimenti: number;
  chiamate: number;
  discovery: number;
  closing: number;
  chiusi: number;
}

/**
 * Vendite — tracking giorno per giorno del team vendita:
 * quanti lead vengono lavorati ogni giorno e il tasso di
 * passaggio tra le fasi della pipeline.
 */
export default function Vendite({
  client,
  pipeline,
}: {
  client: Client;
  pipeline: Pipeline;
}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      supabase.from("stages").select("*").eq("pipeline_id", pipeline.id).order("position"),
      supabase.from("leads").select("*").eq("pipeline_id", pipeline.id),
      supabase
        .from("lead_stage_events")
        .select("id,lead_id,from_stage_id,to_stage_id,changed_by,changed_at")
        .eq("client_id", client.id)
        .order("changed_at", { ascending: false })
        .limit(5000),
    ]).then(([{ data: st }, { data: ld }, { data: ev }]) => {
      setStages((st as Stage[]) ?? []);
      setLeads((ld as Lead[]) ?? []);
      setEvents((ev as StageEvent[]) ?? []);
      setLoading(false);
    });
  }, [client.id, pipeline.id]);

  const stageById = useMemo(() => {
    const m: Record<string, Stage> = {};
    for (const s of stages) m[s.id] = s;
    return m;
  }, [stages]);

  const byStage = useMemo(() => {
    const m: Record<string, Lead[]> = {};
    for (const s of stages) m[s.id] = [];
    for (const l of leads) {
      if (!m[l.stage_id]) m[l.stage_id] = [];
      m[l.stage_id].push(l);
    }
    return m;
  }, [stages, leads]);

  // Funnel: per ogni fase, quanti lead sono passati dalla fase precedente
  // (o sono arrivati da fuori) e quanto pesa sul totale.
  const funnel = useMemo(() => {
    return stages.map((s, i) => {
      const count = (byStage[s.id] ?? []).length;
      const prev = i > 0 ? (byStage[stages[i - 1].id] ?? []).length : leads.length;
      const pct = prev > 0 ? Math.round((count / prev) * 100) : 0;
      return { stage: s, count, pct, isEntry: i === 0 };
    });
  }, [stages, byStage, leads.length]);

  // Attività per giorno: quanti spostamenti di fase al giorno,
  // e quanti hanno portato un lead in Discovery / Closing / CLOSED.
  const days = useMemo(() => {
    const byDay = new Map<string, DayRow>();
    const name = (id: string | null) => (id ? stageById[id]?.name ?? "" : "");
    const mk = (d: string) => {
      if (!byDay.has(d)) {
        byDay.set(d, { day: d, label: d, movimenti: 0, chiamate: 0, discovery: 0, closing: 0, chiusi: 0 });
      }
      return byDay.get(d)!;
    };
    for (const e of events) {
      const d = (e.changed_at || "").slice(0, 10);
      if (!d) continue;
      const row = mk(d);
      row.movimenti++;
      // "chiamate" = spostamenti verso NO ANSWER o RECALL
      const to = name(e.to_stage_id);
      if (to === "NO ANSWER" || to === "RECALL") row.chiamate++;
      if (to === "DISCOVERY") row.discovery++;
      if (to === "CLOSING") row.closing++;
      if (to === "CLOSED") row.chiusi++;
    }
    const arr = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
    for (const r of arr) {
      const [y, m, d] = r.day.split("-").map(Number);
      const wd = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"][new Date(y, m - 1, d).getDay()];
      r.label = `${d}/${m} · ${wd}`;
    }
    return arr.slice(0, 21); // ultime 3 settimane
  }, [events, stageById]);

  // KPI da CRM vendita: valore pipeline, ponderato, chiusi (€), tasso
  const pipeValue = leads.reduce((s, l) => s + (Number(l.value) || 0), 0);
  const weightedValue = leads.reduce((s, l) => {
    const st = stageById[l.stage_id];
    const p = st ? (st.probability ?? STAGE_PROBABILITY[st.name] ?? 0) : 0;
    return s + ((Number(l.value) || 0) * p) / 100;
  }, 0);
  const closedId = stages.find((s) => s.name === "CLOSED")?.id ?? "";
  const closedLeads = byStage[closedId] ?? [];
  const closedEur = closedLeads.reduce((s, l) => s + (Number(l.value) || 0), 0);
  const activeStages = stages.filter((s) => !["LOST", "CLOSED"].includes(s.name)).map((s) => s.id);
  const activeLeads = leads.filter((l) => activeStages.includes(l.stage_id));
  const closeRate = leads.length ? Math.round((closedLeads.length / leads.length) * 100) : 0;

  // Da richiamare: prossima azione scaduta o di oggi, lead non chiusi
  const todayIso = new Date().toISOString().slice(0, 10);
  const toCall = leads
    .filter((l) => l.next_action_date && l.next_action_date <= todayIso && activeStages.includes(l.stage_id))
    .sort((a, b) => (a.next_action_date ?? "").localeCompare(b.next_action_date ?? ""));
  // Lead fermi: nessuna attività da 5+ giorni, non chiusi
  const stale = leads
    .filter((l) => {
      if (!activeStages.includes(l.stage_id)) return false;
      const upd = l.updated_at ?? l.created_at;
      const days = (Date.now() - new Date(upd).getTime()) / 86400000;
      return days >= 5;
    })
    .sort((a, b) => (a.updated_at ?? a.created_at).localeCompare(b.updated_at ?? b.created_at));

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const todayRow = days.find((d) => d.day === today);
  const weekMov = days.slice(0, 7).reduce((s, d) => s + d.movimenti, 0);

  if (loading) return <div className="center-msg">Caricamento vendite…</div>;

  return (
    <div className="page vendite">
      <h1>Vendite · {client.name}</h1>
      <p className="sub">
        Pipeline: <b>{pipeline.name}</b> · attività del team vendita giorno per giorno
        e tasso di passaggio tra le fasi.
      </p>

      <div className="cards-grid">
        <div className="stat">
          <div className="k">Lead in pipeline</div>
          <div className="v">{leads.length}</div>
        </div>
        <div className="stat">
          <div className="k">Lavorati oggi</div>
          <div className="v" style={{ color: "var(--gold)" }}>
            {todayRow?.movimenti ?? 0}
          </div>
        </div>
        <div className="stat">
          <div className="k">Lavorati ultimi 7 giorni</div>
          <div className="v" style={{ color: "var(--gold)" }}>
            {weekMov}
          </div>
        </div>
        <div className="stat">
          <div className="k">Tasso di chiusura</div>
          <div className="v" style={{ color: "#16a34a" }}>
            {closeRate}%
          </div>
        </div>
      </div>
      <div className="cards-grid">
        <div className="stat">
          <div className="k">Valore pipeline</div>
          <div className="v">
            € {pipeValue.toLocaleString("it-IT")}
          </div>
        </div>
        <div className="stat">
          <div className="k">Valore ponderato</div>
          <div className="v" style={{ color: "var(--gold)" }}>
            € {Math.round(weightedValue).toLocaleString("it-IT")}
          </div>
        </div>
        <div className="stat">
          <div className="k">Chiusi (€)</div>
          <div className="v" style={{ color: "#16a34a" }}>
            € {closedEur.toLocaleString("it-IT")}
          </div>
        </div>
        <div className="stat">
          <div className="k">Da richiamare</div>
          <div className="v" style={{ color: toCall.length ? "#d3a24f" : undefined }}>
            {toCall.length}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Tasso di passaggio tra le fasi</h2>
        <div className="funnel">
          {funnel.map((f, i) => (
            <div className="funnel-step" key={f.stage.id}>
              <div className="funnel-label">
                <span
                  className="col-dot"
                  style={{ background: f.stage.color || "#94a3b8" }}
                />
                {f.stage.name}
                <span className="funnel-count">{f.count}</span>
              </div>
              {i > 0 && (
                <div className="funnel-bar">
                  <div
                    className="funnel-fill"
                    style={{
                      width: Math.max(2, Math.min(100, f.pct)) + "%",
                    }}
                  />
                </div>
              )}
              <div className="funnel-pct">
                {f.isEntry ? "inizio" : f.pct + "% di " + funnel[i - 1].stage.name}
              </div>
            </div>
          ))}
        </div>
        <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>
          Esempio: se RECALL ha 71 lead e DISCOVERY ne ha 12, il tasso è 12/71 = 17%.
        </div>
      </div>

      {toCall.length > 0 && (
        <div className="panel">
          <h2>📞 Da richiamare (prossima azione scaduta o di oggi)</h2>
          <table className="table">
            <thead>
              <tr><th>Lead</th><th>Fase</th><th>Prossima azione</th><th>Fermo da</th></tr>
            </thead>
            <tbody>
              {toCall.slice(0, 10).map((l) => (
                <tr key={l.id}>
                  <td><b>{l.name || "(senza nome)"}</b></td>
                  <td>{stageById[l.stage_id]?.name ?? ""}</td>
                  <td>{new Date(l.next_action_date!).toLocaleDateString("it-IT")}</td>
                  <td>{Math.floor((Date.now() - new Date(l.updated_at ?? l.created_at).getTime()) / 86400000)} gg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stale.length > 0 && (
        <div className="panel">
          <h2>⏳ Lead fermi (nessun movimento da 5+ giorni)</h2>
          <table className="table">
            <thead>
              <tr><th>Lead</th><th>Fase</th><th>Fermo da</th><th>Valore</th></tr>
            </thead>
            <tbody>
              {stale.slice(0, 10).map((l) => (
                <tr key={l.id}>
                  <td><b>{l.name || "(senza nome)"}</b></td>
                  <td>{stageById[l.stage_id]?.name ?? ""}</td>
                  <td>{Math.floor((Date.now() - new Date(l.updated_at ?? l.created_at).getTime()) / 86400000)} gg</td>
                  <td>{l.value ? "€ " + Number(l.value).toLocaleString("it-IT") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel" style={{ overflowX: "auto" }}>
        <h2>Attività giornaliera · ultime 3 settimane</h2>
        {days.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>
            Nessun movimento registrato finora. Quando un lead cambia fase,
            qui vedrai il lavoro di ogni giorno.
          </div>
        ) : (
          <table className="perf-table">
            <thead>
              <tr>
                <th>Giorno</th>
                <th>Lead lavorati</th>
                <th>Chiamate (NA/RECALL)</th>
                <th>→ Discovery</th>
                <th>→ Closing</th>
                <th>→ CLOSED</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className={d.day === today ? "today" : ""}>
                  <td>
                    <b>{d.label}</b>
                    {d.day === today && (
                      <span style={{ marginLeft: 8, color: "var(--gold)", fontSize: 11 }}>
                        OGGI
                      </span>
                    )}
                  </td>
                  <td>{d.movimenti}</td>
                  <td>{d.chiamate}</td>
                  <td>{d.discovery}</td>
                  <td>{d.closing}</td>
                  <td className="pos">{d.chiusi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
