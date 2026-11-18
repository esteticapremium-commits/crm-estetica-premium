import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { withTimeout } from "../async";

type Registration = { id: string; full_name: string; email: string; status: "pending" | "approved"; created_at: string; same_browser: boolean };
type Portal = { link: { id: string; expires_at: string } | null; requests: Registration[]; activation: string | null };
type PortalAction = "read" | "new_link" | "revoke_link" | "approve" | "reject";

const linkFor = (path: string, token: string) => `${window.location.origin}/#/${path}/${token}`;
const deadline = (value: string) => new Intl.DateTimeFormat("it-IT", { timeZone:"Europe/Rome", dateStyle:"medium", timeStyle:"short" }).format(new Date(value));

export default function SetterRegistrationAdmin({ clientId }: { clientId: string }) {
  const [portal, setPortal] = useState<Portal>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [decision, setDecision] = useState<{ action:"approve" | "reject"; request:Registration }>();
  const [privateLink, setPrivateLink] = useState<{ name:string; url:string }>();
  const lock = useRef(false);

  const run = useCallback(async (action: PortalAction, request?: Registration) => {
    if (lock.current) return;
    lock.current = true; setWorking(true); setError(""); setCopied("");
    try {
      const { data, error } = await withTimeout(supabase.rpc("setter_registration_portal", {
        p_client_id: clientId, p_action: action, p_request_id: request?.id ?? null,
      }));
      if (error || !data) throw new Error(error?.message || "Nessuna risposta dal CRM.");
      const result = data as Portal;
      setPortal({ ...result, activation:null });
      if (action === "approve" && request) {
        if (result.activation) setPrivateLink({ name:request.full_name, url:linkFor("setter-attiva",result.activation) });
        else {
          setPrivateLink(undefined);
          setCopied("Richiesta approvata: la persona può scegliere la password dalla stessa pagina.");
        }
      }
      if (action === "reject") setPrivateLink(undefined);
      setDecision(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Operazione non riuscita.");
    } finally {
      lock.current = false; setWorking(false);
    }
  },[clientId]);
  useEffect(() => { void run("read"); },[run]);

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setCopied("Non copiato automaticamente. Seleziona il link e copialo a mano."); }
  }

  const groupLink = portal?.link && linkFor("setter-registrazione",portal.link.id);
  return <section className="panel" aria-label="Registrazione Setter" style={{ marginBlock: "18px" }}>
    <h3>Registrazione Setter</h3>
    <p className="muted">Condividi un solo link nel gruppo. Verifica nome ed email dichiarata e approva le persone che riconosci. La scelta della password si sblocca nella pagina in cui hanno inviato la richiesta.</p>
    {error && <p className="notice err" role="alert">{error}</p>}
    {groupLink && portal?.link && <div className="field">
      <label htmlFor="setter-group-link">Link per il gruppo · scade il {deadline(portal.link.expires_at)}</label>
      <input id="setter-group-link" readOnly value={groupLink} onFocus={e => e.target.select()} />
    </div>}
    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      {groupLink && <button className="btn primary" type="button" onClick={() => void copy(groupLink,"Link per il gruppo copiato.")}>Copia link per il gruppo</button>}
      {!groupLink && <button className="btn primary" type="button" disabled={working || !portal} onClick={() => void run("new_link")}>Genera link per il gruppo</button>}
      {groupLink && <button className="btn" type="button" disabled={working} onClick={() => void run("revoke_link")}>Disattiva link</button>}
      <button className="btn" type="button" disabled={working} onClick={() => void run("read")}>Aggiorna richieste</button>
    </div>
    <h4>Richieste Setter</h4>
    {portal?.requests.length ? <div style={{display:"grid",gap:10}}>{portal.requests.map(request =>
      <article key={request.id}>
        <b>{request.full_name}</b><div style={{overflowWrap:"anywhere"}}>{request.email}</div>
        <p className="muted">{request.status === "approved" ? "Approvata · in attesa di attivazione" : "In attesa di approvazione"}</p>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button className="btn primary" type="button" disabled={working} onClick={() => setDecision({action:"approve",request})}>
            {request.status === "approved" ? request.same_browser ? "Rinnova approvazione" : "Rigenera link privato" : "Approva"}
          </button>
          <button className="btn" type="button" disabled={working} onClick={() => setDecision({action:"reject",request})}>Rifiuta</button>
        </div>
        {decision?.request.id === request.id && <div className="notice">
          <p>{decision.action === "approve" ? `Confermi l’accesso Setter per ${request.full_name}? L’email dichiarata è ${request.email}.` : `Rifiutare la richiesta di ${request.full_name}?`}</p>
          <button className="btn primary" type="button" disabled={working} onClick={() => void run(decision.action,request)}>Conferma</button>{" "}
          <button className="btn" type="button" disabled={working} onClick={() => setDecision(undefined)}>Annulla</button>
        </div>}
      </article>
    )}</div> : <p className="muted">{working && !portal ? "Caricamento richieste…" : "Nessuna richiesta in attesa."}</p>}
    {privateLink && <div className="notice ok">
      <p>Link privato per <b>{privateLink.name}</b>. Mandalo solo in privato, mai nel gruppo. Scade dopo 24 ore e funziona una volta sola.</p>
      <div className="field"><label htmlFor="setter-private-link">Link di attivazione</label>
        <input id="setter-private-link" readOnly value={privateLink.url} onFocus={e => e.target.select()} /></div>
      <button className="btn primary" type="button" onClick={() => void copy(privateLink.url,"Link privato copiato.")}>Copia link privato</button>{" "}
      <button className="btn" type="button" onClick={() => setPrivateLink(undefined)}>Nascondi</button>
    </div>}
    {copied && <p role="status">{copied}</p>}
  </section>;
}
