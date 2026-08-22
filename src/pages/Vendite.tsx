import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Lead, Pipeline, Stage } from "../types";

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

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const todayRow = days.find((d) => d.day === today);
  const weekMov = days.slice(0, 7).reduce((s, d) => s + d.movimenti, 0);

  if (loading) return <div className="center-msg">Caricamento vendite…</div>;

  return (
    <div className="page vendite">
      <h1>Vendite · {client.name}</h1>
      <p className="sub">
        Pipeline: <b>{pipeline.name}</b> · attività di Giovanni giorno per giorno
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
          <div className="k">Chiusi (CLOSED)</div>
          <div className="v" style={{ color: "#16a34a" }}>
            {(byStage[stages.find((s) => s.name === "CLOSED")?.id ?? ""] ?? []).length}
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
