import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { withTimeout } from "../async";
import { fillBody } from "../contractPdf";
import { TEAM_DEPARTMENTS, type TeamDepartment } from "../teamContract";
import type { ContractTemplate } from "../types";
import Contracts from "./Contracts";
import "./TeamContracts.css";

export default function TeamContracts({ clientId, meName }: { clientId: string; meName: string }) {
  const [department, setDepartment] = useState<TeamDepartment>("sales");
  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ContractTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [refresh, setRefresh] = useState(0);
  const requestId = useRef("");
  const locked = useRef(false);
  const fields = (selected?.client_fields || "").split("\n").filter(Boolean);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void withTimeout(supabase.from("contract_templates").select("*").eq("client_id", clientId).eq("team_department", department).order("name"))
      .then(({ data, error }) => { if (!active) return; if (error) setError(error.message); else setTemplates(data || []); })
      .catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [clientId, department]);
  function open(template: ContractTemplate) {
    setSelected(template); setValues({}); setEmail(""); setLink(""); setError(""); requestId.current = crypto.randomUUID();
  }
  async function create() {
    if (!selected || locked.current || link) return;
    if (!values["Nome e cognome"]?.trim()) { setError("Inserisci il nome del collaboratore."); return; }
    locked.current = true; setBusy(true); setError("");
    try {
      // A stable ID makes a retry safe even if the first response was lost.
      const result = await withTimeout(supabase.from("contracts").upsert({
        id: requestId.current, client_id: clientId, lead_id: null, template_id: selected.id,
        team_department: department, title: `Consulente telefonico — ${values["Nome e cognome"].trim()}`,
        body: selected.body, client_fields: selected.client_fields, client_data: JSON.stringify(values),
        status: "draft", sent_to: email.trim() || null, created_by: meName,
      }, { onConflict: "id", ignoreDuplicates: true }));
      if (result.error) throw result.error;
      const confirmed = await withTimeout(supabase.from("contracts").select("sign_token").eq("id", requestId.current).eq("client_id", clientId).single());
      if (confirmed.error || !confirmed.data?.sign_token) throw confirmed.error || new Error("Creazione non confermata. Riprova senza chiudere questa finestra.");
      setLink(`${window.location.origin}/#/firma/${confirmed.data.sign_token}`); setRefresh((n) => n + 1);
    } catch (e) { setError((e as { message?: string })?.message || "Creazione non confermata. Riprova."); }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="page team-contracts-page">
    <header className="contracts-intro"><div><h1>Contratti team</h1><p>Modelli e accordi dei collaboratori, organizzati per reparto.</p></div><span className="contract-safety">Riservato all’amministratore</span></header>
    <nav className="status-filters team-departments" aria-label="Reparto contratti">{TEAM_DEPARTMENTS.map((d) => <button key={d} aria-pressed={department === d} className={department === d ? "active" : ""} onClick={() => setDepartment(d)}>{d[0].toUpperCase() + d.slice(1)}</button>)}</nav>
    {error && !selected && <p role="alert">{error}</p>}
    <section className="panel team-templates"><h2>Modelli {department}</h2>{loading ? <p>Caricamento modelli…</p> : templates.length ? templates.map((t) => <article key={t.id}><div><h3>{t.name}</h3><p>Collaborazione autonoma a Partita IVA · 10% sull’incassato reale, al netto di IVA e ritenute.</p></div><button className="btn primary" onClick={() => open(t)}>Prepara contratto</button></article>) : <p>Nessun modello in questo reparto.</p>}</section>
    <Contracts key={`${clientId}:${department}:${refresh}`} department={department} clientId={clientId} canManageLinks />
    {selected && <div className="overlay"><div className="modal team-contract-compose" role="dialog" aria-modal="true" aria-labelledby="team-contract-title"><header><h3 id="team-contract-title">{selected.name}</h3><button className="x" aria-label="Chiudi preparazione contratto" disabled={busy} onClick={() => setSelected(null)}>×</button></header><div className="content">
      {link ? <div role="status"><h3>Contratto creato</h3><p>Il link è pronto da inviare al collaboratore.</p><label>Link di firma<input readOnly value={link} onFocus={(e) => e.target.select()} /></label><a href={link} target="_blank" rel="noreferrer">Apri il contratto</a></div> : <><p>Compila i dati disponibili. Il collaboratore potrà verificarli e completare la Partita IVA prima della firma.</p><div className="team-contract-fields">{fields.map((f) => <label key={f}>{f}<input disabled={busy} value={values[f] || ""} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} /></label>)}<label>Email del collaboratore<input type="email" disabled={busy} value={email} onChange={(e) => setEmail(e.target.value)} /></label></div><details><summary>Leggi il modello integrale</summary><div className="team-contract-body">{fillBody(selected.body || "", fields, values, true)}</div></details></>}
      {error && <p role="alert" className="error">{error}</p>}
    </div><footer>{!link && <button className="btn primary" disabled={busy} onClick={() => void create()}>{busy ? "Creazione…" : "Crea link di firma"}</button>}<button className="btn" disabled={busy} onClick={() => setSelected(null)}>Chiudi</button></footer></div></div>}
  </div>;
}
