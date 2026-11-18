import { useRef, useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient";
import { withTimeout } from "../async";

export default function SetterRegistration({ token, activation }: { token: string; activation: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const lock = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || done) return;
    if (activation && (password !== confirmation || new TextEncoder().encode(password).length > 72)) {
      setError(password !== confirmation ? "Le due password non coincidono." : "Scegli una password più corta.");
      return;
    }
    lock.current = true; setBusy(true); setError("");
    try {
      if (activation) {
        const result = await withTimeout(supabase.functions.invoke("setter-activate", { body: { token, password } }), 20000);
        if (result.error || !result.data?.ok) {
          const failure = await result.error?.context?.json?.().catch(() => null);
          throw new Error(failure?.error || "Attivazione non confermata. Riprova o accedi se hai già impostato la password.");
        }
      } else {
        const { error } = await withTimeout(supabase.rpc("submit_setter_registration", { p_link_id: token, p_full_name: name, p_email: email }));
        if (error) throw new Error(error.message);
      }
      setPassword(""); setConfirmation(""); setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Richiesta non riuscita. Riprova.");
    } finally {
      lock.current = false; setBusy(false);
    }
  }

  return <main className="login-wrap">
    <form className="login-box" onSubmit={submit}>
      <div className="login-monogram" aria-hidden="true">EP</div>
      <h1>{activation ? "Attiva il tuo accesso" : "Registrazione Setter"}</h1>
      {done ? <p role="status">{activation
        ? "Accesso attivato. Entra con l’email della richiesta e la password che hai scelto."
        : "Richiesta ricevuta. Dopo l’approvazione, il titolare ti invierà in privato il link per scegliere la password."}</p>
        : <>
          <p>{activation ? "Scegli una password personale per la tua postazione Setter."
            : "Invia la richiesta per la postazione Setter di Estetica Premium. L’accesso è soggetto ad approvazione."}</p>
          {error && <div className="notice err" role="alert">{error}</div>}
          {activation ? <>
            <div className="field"><label htmlFor="setter-new-password">Password</label><input id="setter-new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></div>
            <div className="field"><label htmlFor="setter-repeat-password">Conferma password</label><input id="setter-repeat-password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} /></div>
            <p><small>Usa almeno 12 caratteri.</small></p>
          </> : <>
            <div className="field"><label htmlFor="setter-register-name">Nome e cognome</label><input id="setter-register-name" autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></div>
            <div className="field"><label htmlFor="setter-register-email">Email</label><input id="setter-register-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} /></div>
          </>}
          <button className="btn primary" type="submit" disabled={busy} style={{ width:"100%" }}>{busy ? "Un attimo…" : activation ? "Attiva accesso" : "Invia richiesta"}</button>
        </>}
      <a className="btn" href="/" style={{ marginTop:12 }}>Vai al login</a>
    </form>
  </main>;
}
