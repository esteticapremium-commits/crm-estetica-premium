import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "../supabaseClient";
import type { Client } from "../types";

interface LeadRow {
  assigned_to: string | null;
  client_id: string;
  stage_id: string;
  value: number | null;
}
interface StageRow { id: string; client_id: string; name: string }

interface CenterAgg { g: number; a: number; e: number }
interface Agg {
  name: string;
  gestiti: number;
  app: number;
  acc: number;
  accEur: number;
  tratt: number;
  persi: number;
  centers: Record<string, CenterAgg>;
}

export default function Performance({ clients }: { clients: Client[] }) {
  const [stages, setStages] = useState<StageRow[]>([]);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      supabase.from("stages").select("id,client_id,name"),
      supabase.from("leads").select("assigned_to,client_id,stage_id,value"),
    ]).then(([{ data: st }, { data: ld }]) => {
      setStages((st as StageRow[]) ?? []);
      setLeads((ld as LeadRow[]) ?? []);
      setLoading(false);
    });
  }, []);

  const clientName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of clients) m[c.id] = c.name;
    return m;
  }, [clients]);

  const data = useMemo(() => {
    const stageById: Record<string, StageRow> = {};
    for (const s of stages) stageById[s.id] = s;
    const nameOf = (l: LeadRow) =>
      (stageById[l.stage_id]?.name || "").toLowerCase();

    // Stesse regole della Dashboard (escludono "non accettato")
    const isAccettato = (n: string) =>
      n.includes("accettato") && !n.includes("non accettato");
    const isTrattativa = (n: string) => n.includes("trattativa");
    const isApp = (n: string) => n.includes("appuntament");
    const isPerso = (n: string) =>
      n.includes("non interessato") ||
      n.includes("non in target") ||
      n.includes("disdett");

    const by: Record<string, Agg> = {};
    let unassigned = 0;

    for (const l of leads) {
      const who = (l.assigned_to || "").trim();
      if (!who) { unassigned++; continue; }
      const n = nameOf(l);
      const a =
        by[who] ||
        (by[who] = {
          name: who, gestiti: 0, app: 0, acc: 0, accEur: 0,
          tratt: 0, persi: 0, centers: {},
        });
      a.gestiti++;
      const cn = clientName[l.client_id] || "—";
      const c = a.centers[cn] || (a.centers[cn] = { g: 0, a: 0, e: 0 });
      c.g++;
      if (isApp(n)) a.app++;
      if (isTrattativa(n)) a.tratt++;
      if (isPerso(n)) a.persi++;
      if (isAccettato(n)) {
        const v = Number(l.value) || 0;
        a.acc++; a.accEur += v; c.a++; c.e += v;
      }
    }

    const rows = Object.values(by).sort(
      (x, y) =>
        y.accEur - x.accEur || y.acc - x.acc || y.gestiti - x.gestiti
    );
    const tot = rows.reduce(
      (s, r) => ({
        gestiti: s.gestiti + r.gestiti,
        acc: s.acc + r.acc,
        accEur: s.accEur + r.accEur,
      }),
      { gestiti: 0, acc: 0, accEur: 0 }
    );
    return { rows, unassigned, tot };
  }, [leads, stages, clientName]);

  if (loading) return <div className="center-msg">Caricamento performance…</div>;

  const eur = (n: number) => "€ " + n.toLocaleString("it-IT");
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) + "%" : "—");

  return (
    <div className="page">
      <h1>Performance venditori</h1>
      <p className="sub">
        I lead sono conteggiati in base al campo “Assegnata a”.
      </p>

      <div className="cards-grid">
        <Stat k="Lead assegnati (totale)" v={data.tot.gestiti} />
        <Stat k="Preventivi accettati" v={data.tot.acc} accent="#16a34a" />
        <Stat k="Valore accettati" v={eur(data.tot.accEur)} small accent="#16a34a" />
        <Stat k="Lead non assegnati" v={data.unassigned} accent="#ea580c" />
      </div>

      <div className="panel" style={{ overflowX: "auto" }}>
        {data.rows.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>
            Nessun lead è ancora assegnato a un venditore. Apri un lead e usa
            “Assegna a me”, oppure compila il campo “Assegnata a”.
          </div>
        ) : (
          <table className="perf-table">
            <thead>
              <tr>
                <th>Venditore</th>
                                <th>Gestiti</th>
                <th>Appunt.</th>
                <th>In trattativa</th>
                <th>Accettati</th>
                <th>€ Accettati</th>
                <th>Conversione</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Fragment key={r.name}>
                  <tr
                    className={"perf-row" + (open === r.name ? " open" : "")}
                    onClick={() => setOpen(open === r.name ? null : r.name)}
                  >
                    <td>
                      <span className="perf-caret">{open === r.name ? "▾" : "▸"}</span>
                      <b>{r.name}</b>
                    </td>
                    <td>{Object.keys(r.centers).length}</td>
                    <td>{r.gestiti}</td>
                    <td>{r.app}</td>
                    <td>{r.tratt}</td>
                    <td className="pos">{r.acc}</td>
                    <td className="pos">{eur(r.accEur)}</td>
                    <td>{pct(r.acc, r.gestiti)}</td>
                  </tr>
                  {open === r.name && (
                    <tr className="perf-detail">
                      <td colSpan={8}>
                        <div className="perf-sub">
                          {Object.entries(r.centers)
                            .sort((a, b) => b[1].g - a[1].g)
                            .map(([cn, c]) => (
                              <div className="perf-sub-row" key={cn}>
                                <span className="cn">{cn}</span>
                                <span>{c.g} gestiti</span>
                                <span className="pos">{c.a} accettati</span>
                                <span className="pos">{eur(c.e)}</span>
                                <span className="muted">
                                  conv. {pct(c.a, c.g)}
                                </span>
                              </div>
                            ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="sub" style={{ marginTop: 14 }}>
        Suggerimento: “Gestiti” = lead assegnati a quella persona. “Accettati” e
        “€ Accettati” contano solo la fase <b>Preventivo Accettato</b>.
      </p>
    </div>
  );
}

function Stat({
  k, v, small, accent,
}: { k: string; v: ReactNode; small?: boolean; accent?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={"v" + (small ? " small" : "")} style={accent ? { color: accent } : undefined}>
        {v}
      </div>
    </div>
  );
}
