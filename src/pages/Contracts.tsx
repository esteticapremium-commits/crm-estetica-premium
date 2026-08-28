import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import { openSignedContractPdf } from "../contractPdf";
import type { Contract, ContractEvent, Lead } from "../types";

type Filter = "all" | "pending" | "signed" | "expired" | "revoked";

export default function Contracts() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Contract | null>(null);
  const load = () => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      supabase.from("contracts").select("*").order("created_at", { ascending: false }),
      supabase.from("leads").select("id,name,email,phone,client_id,pipeline_id,stage_id,source,assigned_to,value,notes,next_action_date,closing_date,lost_reason,tags,position,created_at,updated_at"),
      supabase.from("contract_events").select("*").order("created_at", { ascending: false }).limit(500),
    ]).then(([c, l, e]) => {
      const failure = [c, l, e].find((r) => r.error)?.error;
      if (failure) setLoadError(failure.message);
      setContracts((c.data as Contract[]) ?? []); setLeads((l.data as Lead[]) ?? []); setEvents((e.data as ContractEvent[]) ?? []); setLoading(false);
    }).catch(() => { setLoadError("Errore di connessione durante il caricamento dei contratti."); setLoading(false); });
  };
  useEffect(load, []);
  const now = Date.now();
  const state = (c: Contract): Exclude<Filter, "all"> => c.revoked_at ? "revoked" : c.status === "signed" ? "signed" : c.expires_at && new Date(c.expires_at).getTime() <= now ? "expired" : "pending";
  const list = useMemo(() => contracts.filter((c) => (filter === "all" || state(c) === filter) && (`${c.title} ${leads.find((l) => l.id === c.lead_id)?.name ?? ""} ${c.sent_to ?? ""}`).toLowerCase().includes(q.trim().toLowerCase())), [contracts, leads, filter, q]);
  const count = (f: Filter) => f === "all" ? contracts.length : contracts.filter((c) => state(c) === f).length;
  const leadName = (c: Contract) => leads.find((l) => l.id === c.lead_id)?.name || "Lead non disponibile";
  const renew = async (c: Contract) => { const { data, error } = await supabase.rpc("renew_contract_link", { p_contract_id: c.id }); if (error) return alert(error.message); await navigator.clipboard.writeText(`${window.location.origin}/#/firma/${data}`); alert("Nuovo link creato e copiato. Scade tra 30 giorni."); load(); };
  const revoke = async (c: Contract) => { if (!confirm(`Revocare il link di firma per “${c.title}”?`)) return; const { error } = await supabase.rpc("revoke_contract", { p_contract_id: c.id }); if (error) return alert(error.message); load(); };
  if (loading) return <div className="center-msg">Caricamento contratti…</div>;
  if (loadError) return <div className="center-msg">La sezione Contratti richiede l’aggiornamento del database.<br /><small>{loadError}</small></div>;
  return <div className="page contracts-page">
    <div className="contracts-intro"><div><h1>Contratti</h1><p>Controlla firma, scadenze e storico di ogni accordo.</p></div><div className="contract-safety">Link firmabili protetti da scadenza e revoca</div></div>
    <div className="cards-grid contracts-kpis"><Kpi label="Da firmare" value={count("pending")} /><Kpi label="Firmati" value={count("signed")} good /><Kpi label="Scaduti" value={count("expired")} warn /><Kpi label="Revocati" value={count("revoked")} /></div>
    <section className="panel contracts-list"><div className="contracts-toolbar"><div className="status-filters">{(["all", "pending", "signed", "expired", "revoked"] as Filter[]).map((f) => <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{label(f)} <small>{count(f)}</small></button>)}</div><div className="contract-search">⌕<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca contratto o lead" /></div></div>
      {list.length === 0 ? <div className="empty-editorial"><b>Nessun contratto trovato.</b><span>I contratti vengono creati dalla scheda del lead.</span></div> : <div className="contracts-table"><div className="contracts-head"><span>Contratto</span><span>Lead</span><span>Stato</span><span>Scadenza / firma</span><span></span></div>{list.map((c) => <div className="contracts-row" key={c.id}><span><b>{c.title}</b><small>Creato da {c.created_by || "—"} · {new Date(c.created_at).toLocaleDateString("it-IT")}</small></span><span>{leadName(c)}<small>{c.sent_to || "Nessuna email"}</small></span><span><em className={`contract-status ${state(c)}`}>{label(state(c))}</em></span><span>{c.status === "signed" ? `Firmato il ${new Date(c.signed_at!).toLocaleDateString("it-IT")}` : c.revoked_at ? `Revocato il ${new Date(c.revoked_at).toLocaleDateString("it-IT")}` : c.expires_at ? `Scade il ${new Date(c.expires_at).toLocaleDateString("it-IT")}` : "—"}</span><span><button className="btn small" onClick={() => setSelected(c)}>Dettagli</button></span></div>)}</div>}
    </section>
    {selected && <ContractDetail contract={selected} events={events.filter((e) => e.contract_id === selected.id)} onClose={() => setSelected(null)} onRenew={renew} onRevoke={revoke} />}
  </div>;
}

function label(s: Filter) { return ({ all: "Tutti", pending: "Da firmare", signed: "Firmati", expired: "Scaduti", revoked: "Revocati" } as Record<Filter, string>)[s]; }
function Kpi({ label, value, good, warn }: { label: string; value: number; good?: boolean; warn?: boolean }) { return <div className="stat"><div className="k">{label}</div><div className="v" style={{ color: good ? "#15803d" : warn ? "#b45309" : undefined }}>{value}</div></div>; }
function ContractDetail({ contract: c, events, onClose, onRenew, onRevoke }: { contract: Contract; events: ContractEvent[]; onClose: () => void; onRenew: (c: Contract) => void; onRevoke: (c: Contract) => void }) {
  const link = `${window.location.origin}/#/firma/${c.sign_token}`; const canChange = c.status !== "signed";
  return <div className="overlay" onClick={onClose}><div className="modal contract-detail" onClick={(e) => e.stopPropagation()}><header><h3>{c.title}</h3><button className="x" onClick={onClose}>×</button></header><div className="content"><div className="contract-detail-state"><em className={`contract-status ${c.revoked_at ? "revoked" : c.status === "signed" ? "signed" : "pending"}`}>{c.revoked_at ? "Revocato" : c.status === "signed" ? "Firmato" : "Da firmare"}</em>{c.signed_document_hash && <span>Documento sigillato · SHA-256</span>}</div>{c.status === "signed" ? <><div className="field"><label>Firmato da</label><div className="readonly">{c.signed_name} · {c.signed_at && new Date(c.signed_at).toLocaleString("it-IT")}</div></div><button className="btn primary" onClick={() => openSignedContractPdf(c)}>Scarica PDF firmato</button></> : <><div className="field"><label>Link di firma</label><div className="copy-row"><input readOnly value={link} /><button className="btn" onClick={() => { navigator.clipboard.writeText(link); alert("Link copiato."); }}>Copia</button></div></div><div className="field"><label>Scadenza</label><div className="readonly">{c.expires_at ? new Date(c.expires_at).toLocaleString("it-IT") : "Nessuna scadenza"}</div></div></>}<div className="contract-audit"><b>Storico</b>{events.length === 0 ? <p className="muted">Nessun evento registrato.</p> : events.map((e) => <div key={e.id}><span>{eventLabel(e.action)}</span><small>{e.actor || "Sistema"} · {new Date(e.created_at).toLocaleString("it-IT")}</small></div>)}</div></div><footer>{canChange && !c.revoked_at && <button className="btn danger" onClick={() => onRevoke(c)} style={{ marginRight: "auto" }}>Revoca link</button>}{canChange && <button className="btn" onClick={() => onRenew(c)}>Genera nuovo link</button>}<button className="btn primary" onClick={onClose}>Chiudi</button></footer></div></div>;
}
function eventLabel(action: string) { return ({ created: "Contratto creato", sent: "Link inviato", signed: "Contratto firmato", revoked: "Link revocato", link_renewed: "Nuovo link generato" } as Record<string, string>)[action] || action; }
