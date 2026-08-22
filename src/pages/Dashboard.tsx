import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Lead, Pipeline, Stage } from "../types";

interface AdMetrics {
  spend: number; cpc: number; ctr: number; cpm: number;
  leads_count: number; cost_per_lead: number; updated_at: string;
}
interface MonthRow {
  month: string; spend: number; leads_count: number; cost_per_lead: number;
  cpc: number; ctr: number;
}

type Preset =
  | "this_month" | "last_month" | "last3" | "last6" | "year" | "all" | "custom";

interface Range { from: Date; to: Date; prevFrom: Date; prevTo: Date; hasPrev: boolean }

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function computeRange(preset: Preset, cf: string, ct: string): Range {
  const now = new Date();
  const som = startOfMonth(now);
  const somPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const somPrev2 = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  switch (preset) {
    case "this_month":
      return { from: som, to: now, prevFrom: somPrev, prevTo: som, hasPrev: true };
    case "last_month":
      return { from: somPrev, to: som, prevFrom: somPrev2, prevTo: somPrev, hasPrev: true };
    case "last3":
      return { from: addDays(now, -90), to: now, prevFrom: addDays(now, -180), prevTo: addDays(now, -90), hasPrev: true };
    case "last6":
      return { from: addDays(now, -180), to: now, prevFrom: addDays(now, -360), prevTo: addDays(now, -180), hasPrev: true };
    case "year": {
      const soy = new Date(now.getFullYear(), 0, 1);
      const soyPrev = new Date(now.getFullYear() - 1, 0, 1);
      const prevTo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      return { from: soy, to: now, prevFrom: soyPrev, prevTo, hasPrev: true };
    }
    case "custom": {
      const from = cf ? new Date(cf) : new Date(0);
      const to = ct ? addDays(new Date(ct), 1) : now;
      const len = to.getTime() - from.getTime();
      return { from, to, prevFrom: new Date(from.getTime() - len), prevTo: from, hasPrev: !!(cf && ct) };
    }
    default:
      return { from: new Date(0), to: now, prevFrom: new Date(0), prevTo: new Date(0), hasPrev: false };
  }
}

const PRESET_LABEL: Record<Preset, string> = {
  this_month: "Questo mese", last_month: "Mese scorso", last3: "Ultimi 3 mesi",
  last6: "Ultimi 6 mesi", year: "Quest'anno", all: "Sempre", custom: "Personalizzato",
};

export const ALL_PIPELINES_ID = "__all__";

export default function Dashboard({
  client,
  pipeline,
  pipelines = [],
}: {
  client: Client;
  pipeline: Pipeline;
  pipelines?: Pipeline[];
}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [ads, setAds] = useState<AdMetrics | null>(null);
  const [months, setMonths] = useState<MonthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<Preset>("this_month");
  const [cf, setCf] = useState("");
  const [ct, setCt] = useState("");

  // Modalita' "Totale": somma tutti i servizi (pipeline) del cliente.
  const isAll = pipeline.id === ALL_PIPELINES_ID;
  const ids = isAll ? pipelines.map((p) => p.id) : [pipeline.id];
  const idsKey = ids.join(",");

  useEffect(() => {
    if (ids.length === 0) {
      setStages([]); setLeads([]); setAds(null); setMonths([]); setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      supabase.from("stages").select("*").in("pipeline_id", ids).order("position"),
      supabase.from("leads").select("*").in("pipeline_id", ids),
      supabase.from("client_ad_metrics").select("*").in("pipeline_id", ids),
      supabase.from("ad_metrics_monthly").select("*").in("pipeline_id", ids).order("month", { ascending: false }),
    ]).then(([{ data: st }, { data: ld }, { data: adm }, { data: mm }]) => {
      setStages((st as Stage[]) ?? []);
      setLeads((ld as Lead[]) ?? []);
      setAds(aggregateAds((adm as AdMetrics[]) ?? []));
      setMonths(aggregateMonths((mm as MonthRow[]) ?? []));
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const stageById = useMemo(() => {
    const m: Record<string, Stage> = {};
    for (const s of stages) m[s.id] = s;
    return m;
  }, [stages]);

  const kpiOf = (subset: Lead[]) => {
    const nameOf = (l: Lead) => (stageById[l.stage_id]?.name || "").toLowerCase();
    const cnt = (p: (n: string) => boolean) => subset.filter((l) => p(nameOf(l))).length;
    const sum = (p: (n: string) => boolean) =>
      subset.filter((l) => p(nameOf(l))).reduce((s, l) => s + (Number(l.value) || 0), 0);
    const isAcc = (n: string) => n.includes("accettato") && !n.includes("non accettato");
    return {
      totale: subset.length,
      appuntamenti: cnt((n) => n.includes("appuntament")),
      presentati: cnt((n) => n.includes("presentato") && !n.includes("preventivo")),
      accettati: cnt(isAcc),
      accettatiEur: sum(isAcc),
      trattativa: cnt((n) => n.includes("trattativa")),
      disdetti: cnt((n) => n.includes("disdett")),
    };
  };

  const range = useMemo(() => computeRange(preset, cf, ct), [preset, cf, ct]);

  const cur = useMemo(
    () => kpiOf(leads.filter((l) => { const t = new Date(l.created_at); return t >= range.from && t < range.to; })),
    [leads, range, stageById]
  );
  const prev = useMemo(
    () => kpiOf(range.hasPrev ? leads.filter((l) => { const t = new Date(l.created_at); return t >= range.prevFrom && t < range.prevTo; }) : []),
    [leads, range, stageById]
  );

  const snapshot = useMemo(() => {
    // Raggruppa per NOME fase: in modalita' Totale le 3 pipeline condividono
    // le stesse fasi, quindi sommiamo i lead con lo stesso nome fase.
    const byName = new Map<string, { label: string; color: string; count: number; pos: number }>();
    for (const s of stages) {
      const e = byName.get(s.name) ?? { label: s.name, color: s.color || "#94a3b8", count: 0, pos: s.position };
      e.pos = Math.min(e.pos, s.position);
      byName.set(s.name, e);
    }
    for (const l of leads) {
      const st = stageById[l.stage_id];
      if (st && byName.has(st.name)) byName.get(st.name)!.count += 1;
    }
    const byStage = [...byName.values()].sort((a, b) => a.pos - b.pos);
    return {
      total: leads.length,
      valoreTot: leads.reduce((s, l) => s + (Number(l.value) || 0), 0),
      byStage,
      byAssigned: groupCount(leads.map((l) => l.assigned_to || "— non assegnato")),
    };
  }, [leads, stages, stageById]);

  if (loading) return <div className="center-msg">Caricamento dati…</div>;

  const eur = (n: number) => "€ " + Math.round(n).toLocaleString("it-IT");
  const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  const maxStage = Math.max(1, ...snapshot.byStage.map((s) => s.count));

  // Confronto spesa: mese corrente vs mese precedente (dallo storico)
  const curMonthKey = new Date().toISOString().slice(0, 7);
  const curM = months.find((m) => m.month === curMonthKey) || months[0];
  const prevM = months.find((m) => m.month < (curM?.month || "")) || null;

  return (
    <div className="page">
      <h1>Dashboard · {client.name}</h1>
      <p className="sub">
        {isAll ? (
          <>Vista: <b>Totale (tutti i servizi)</b> · somma di {ids.length} pipeline</>
        ) : (
          <>Pipeline: <b>{pipeline.name}</b></>
        )}
      </p>

      {/* Selettore periodo */}
      <div className="panel" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: 13 }}>Periodo:</b>
        <select className="select" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <option key={p} value={p}>{PRESET_LABEL[p]}</option>
          ))}
        </select>
        {preset === "custom" && (
          <>
            <input type="date" className="select" value={cf} onChange={(e) => setCf(e.target.value)} />
            <span>→</span>
            <input type="date" className="select" value={ct} onChange={(e) => setCt(e.target.value)} />
          </>
        )}
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          Lead <b>arrivati</b> nel periodo, per esito attuale{range.hasPrev ? " · confronto col periodo precedente" : ""}
        </span>
      </div>

      <div className="cards-grid">
        <Stat k="Contatti (nel periodo)" v={cur.totale} d={delta(cur.totale, prev.totale, range.hasPrev)} />
        <Stat k="Appuntamenti" v={cur.appuntamenti} d={delta(cur.appuntamenti, prev.appuntamenti, range.hasPrev)} />
        <Stat k="Presentati" v={cur.presentati} d={delta(cur.presentati, prev.presentati, range.hasPrev)} />
        <Stat k="Disdetti" v={cur.disdetti} d={delta(cur.disdetti, prev.disdetti, range.hasPrev)} />
      </div>
      <div className="cards-grid">
        <Stat k="Preventivi accettati" v={cur.accettati} accent="#16a34a" d={delta(cur.accettati, prev.accettati, range.hasPrev)} />
        <Stat k="Importo accettati" v={eur(cur.accettatiEur)} small accent="#16a34a" d={delta(cur.accettatiEur, prev.accettatiEur, range.hasPrev, true)} />
        <Stat k="In trattativa" v={cur.trattativa} accent="#059669" d={delta(cur.trattativa, prev.trattativa, range.hasPrev)} />
        <Stat k="Tasso conversione" v={cur.totale ? Math.round((cur.accettati / cur.totale) * 100) + "%" : "—"} small />
      </div>

      {/* Storico spesa Meta */}
      <div className="panel">
        <h2>Spesa pubblicitaria Meta · andamento mensile</h2>
        {months.length === 0 ? (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Nessuno storico spesa per questa pipeline. Collega l'account pubblicitario Meta
            (in Amministrazione → Pipeline) e lo storico si popolerà da solo.
          </p>
        ) : (
          <>
            <div className="cards-grid" style={{ marginBottom: 14 }}>
              <Stat k={`Spesa ${curM?.month ?? ""}`} v={eur(curM?.spend ?? 0)} small accent="#ea580c"
                d={prevM ? delta(curM?.spend ?? 0, prevM.spend, true, true) : undefined} />
              <Stat k="Lead da Meta (mese)" v={curM?.leads_count ?? 0}
                d={prevM ? delta(curM?.leads_count ?? 0, prevM.leads_count, true) : undefined} />
              <Stat k="Costo per lead (mese)" v={eur(curM?.cost_per_lead ?? 0)} small
                d={prevM ? delta(curM?.cost_per_lead ?? 0, prevM.cost_per_lead, true, true, true) : undefined} />
              <Stat k="Mesi disponibili" v={months.length} small />
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="perf-table">
                <thead>
                  <tr><th>Mese</th><th>Spesa</th><th>Lead</th><th>Costo/lead</th><th>CPC</th><th>CTR</th></tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.month}>
                      <td><b>{m.month}</b></td>
                      <td>{eur(m.spend)}</td>
                      <td>{m.leads_count}</td>
                      <td>{eur(m.cost_per_lead)}</td>
                      <td>€ {round2(m.cpc)}</td>
                      <td>{round2(m.ctr)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {ads && (
          <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
            Ultimi 30 giorni: spesa <b>{eur(Number(ads.spend))}</b> · {ads.leads_count} lead ·
            aggiornato il {new Date(ads.updated_at).toLocaleString("it-IT")}
          </div>
        )}
      </div>

      {/* Stato attuale della pipeline */}
      <div className="panel">
        <h2>Stato attuale · lead per fase (tutti)</h2>
        {snapshot.byStage.map((s) => (
          <div className="bar-row" key={s.label}>
            <div className="lbl" title={s.label}>{s.label}</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: (s.count / maxStage) * 100 + "%", background: s.color }} />
            </div>
            <div className="num">{s.count}</div>
          </div>
        ))}
        <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
          Totale in pipeline: <b>{snapshot.total}</b> · valore potenziale: <b>{eur(snapshot.valoreTot)}</b>
        </div>
      </div>
    </div>
  );
}

// Somma le metriche "ultimi 30 giorni" di piu' pipeline in un unico blocco.
function aggregateAds(rows: AdMetrics[]): AdMetrics | null {
  if (!rows || rows.length === 0) return null;
  let spend = 0, leads = 0, cpcW = 0, ctrW = 0, cpmW = 0, w = 0, updated = "";
  for (const r of rows) {
    const s = Number(r.spend) || 0;
    spend += s;
    leads += Number(r.leads_count) || 0;
    cpcW += (Number(r.cpc) || 0) * s;
    ctrW += (Number(r.ctr) || 0) * s;
    cpmW += (Number(r.cpm) || 0) * s;
    w += s;
    if (r.updated_at && r.updated_at > updated) updated = r.updated_at;
  }
  return {
    spend, leads_count: leads,
    cost_per_lead: leads ? spend / leads : 0,
    cpc: w ? cpcW / w : 0,
    ctr: w ? ctrW / w : 0,
    cpm: w ? cpmW / w : 0,
    updated_at: updated,
  };
}

// Somma lo storico mensile di piu' pipeline: per ogni mese, spesa e lead si
// sommano; CPC e CTR sono medie pesate sulla spesa.
function aggregateMonths(rows: MonthRow[]): MonthRow[] {
  const map = new Map<string, { spend: number; leads: number; cpcW: number; ctrW: number; w: number }>();
  for (const r of rows) {
    const e = map.get(r.month) ?? { spend: 0, leads: 0, cpcW: 0, ctrW: 0, w: 0 };
    const s = Number(r.spend) || 0;
    e.spend += s;
    e.leads += Number(r.leads_count) || 0;
    e.cpcW += (Number(r.cpc) || 0) * s;
    e.ctrW += (Number(r.ctr) || 0) * s;
    e.w += s;
    map.set(r.month, e);
  }
  return [...map.entries()]
    .map(([month, e]) => ({
      month, spend: e.spend, leads_count: e.leads,
      cost_per_lead: e.leads ? e.spend / e.leads : 0,
      cpc: e.w ? e.cpcW / e.w : 0,
      ctr: e.w ? e.ctrW / e.w : 0,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

function delta(cur: number, prev: number, has: boolean, money = false, lowerBetter = false): ReactNode {
  if (!has) return undefined;
  const diff = cur - prev;
  if (Math.abs(diff) < 0.005) return <span style={{ color: "var(--muted)" }}>= vs prec.</span>;
  const up = diff > 0;
  const good = lowerBetter ? !up : up;
  const color = good ? "#16a34a" : "#dc2626";
  const arrow = up ? "▲" : "▼";
  const val = money ? "€ " + Math.round(Math.abs(diff)).toLocaleString("it-IT") : Math.abs(diff);
  return <span style={{ color, fontSize: 12, fontWeight: 700 }}>{arrow} {val} vs prec.</span>;
}

function Stat({
  k, v, small, accent, d,
}: { k: string; v: ReactNode; small?: boolean; accent?: string; d?: ReactNode }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={"v" + (small ? " small" : "")} style={accent ? { color: accent } : undefined}>{v}</div>
      {d && <div style={{ marginTop: 4 }}>{d}</div>}
    </div>
  );
}

function groupCount(arr: string[]): { label: string; count: number }[] {
  const map: Record<string, number> = {};
  for (const x of arr) map[x] = (map[x] || 0) + 1;
  return Object.entries(map).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}
