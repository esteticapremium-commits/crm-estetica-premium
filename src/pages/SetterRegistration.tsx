import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient";
import { withTimeout } from "../async";
import "./SetterRegistration.css";

type RegistrationState = "missing" | "pending" | "approved" | "rejected" | "expired" | "activated";
const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export default function SetterRegistration({ token, activation }: { token: string; activation: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const storageKey = `ep-setter-application:${token}`;
  const [deviceToken, setDeviceToken] = useState(() => {
    if (activation) return "";
    try {
      const saved = localStorage.getItem(storageKey) || "";
      return uuidPattern.test(saved) ? saved : "";
    } catch { return ""; }
  });
  const [state, setState] = useState<RegistrationState>(activation ? "approved" : "missing");
  const [checking, setChecking] = useState(!activation && Boolean(deviceToken));
  const [checkError, setCheckError] = useState("");
  const lock = useRef(false);
  const checkVersion = useRef(0);

  const check = useCallback(async (device: string, stillCurrent: () => boolean = () => true) => {
    if (!device || lock.current) return;
    const version = ++checkVersion.current;
    const latest = () => stillCurrent() && checkVersion.current === version;
    setChecking(true);
    try {
      const { data, error } = await withTimeout(supabase.rpc("get_setter_self_activation", {
        p_link_id: token, p_device_token: device,
      }), 10000);
      if (error) throw error;
      if (!latest() || lock.current) return;
      setState(data as RegistrationState);
      setCheckError("");
    } catch {
      if (latest()) setCheckError("Non riesco a verificare lo stato della richiesta. Riprova tra poco.");
    } finally {
      if (latest()) setChecking(false);
    }
  },[token]);

  useEffect(() => {
    if (activation || !deviceToken) return;
    let active = true;
    const update = () => { if (document.visibilityState === "visible") void check(deviceToken, () => active); };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    const timer = window.setInterval(update, 8000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  },[activation, check, deviceToken]);

  const choosingPassword = state === "approved";
  const showForm = choosingPassword || (state === "missing" && !checking && !checkError);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !showForm) return;
    if (choosingPassword && (password !== confirmation || new TextEncoder().encode(password).length > 72)) {
      setError(password !== confirmation ? "Le due password non coincidono." : "Scegli una password più corta.");
      return;
    }
    lock.current = true; ++checkVersion.current; setChecking(false); setBusy(true); setError("");
    try {
      if (choosingPassword) {
        const result = await withTimeout(supabase.functions.invoke("setter-activate", { body: { token: activation ? token : deviceToken, password } }), 20000);
        if (result.error || !result.data?.ok) {
          const failure = await result.error?.context?.json?.().catch(() => null);
          throw new Error(failure?.error || "Attivazione non confermata. Riprova o accedi se hai già impostato la password.");
        }
        setPassword(""); setConfirmation(""); setState("activated");
      } else {
        const device = deviceToken || crypto.randomUUID();
        try { localStorage.setItem(storageKey, device); }
        catch { throw new Error("Consenti al browser di salvare i dati del sito prima di inviare la richiesta."); }
        setDeviceToken(device);
        const { data, error } = await withTimeout(supabase.rpc("request_setter_self_activation", {
          p_link_id: token, p_full_name: name, p_email: email, p_device_token: device,
        }));
        if (error) throw new Error(error.message);
        if (data === "already_requested") throw new Error("Non posso collegare questa richiesta al browser. Se l’hai già inviata, usa il browser originale o contatta il titolare.");
        if (!data) throw new Error("Richiesta non confermata. Riprova.");
        setState(data as RegistrationState);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Richiesta non riuscita. Riprova.");
    } finally {
      lock.current = false; setBusy(false);
    }
  }

  return <main className="login-wrap setter-register-page">
    <form className="login-box setter-register-box" onSubmit={submit}>
      <div className="login-monogram" aria-hidden="true">EP</div>
      <h1>{choosingPassword ? "Scegli la tua password" : "Registrazione Setter"}</h1>
      {state === "activated" && <p role="status">Accesso attivato. Entra con l’email della richiesta e la password che hai scelto.</p>}
      {state === "pending" && <div role="status"><b>In attesa di approvazione</b><p>Lasciala aperta o riapri lo stesso link da questo browser: appena il titolare approva, qui potrai scegliere la password.</p></div>}
      {state === "rejected" && <p role="status">La richiesta non è stata approvata.</p>}
      {state === "expired" && <p role="status">Il tempo per attivare l’account è scaduto. Chiedi al titolare di riapprovare, poi riapri questa pagina.</p>}
      {state === "missing" && checking && <p role="status">Verifica della richiesta…</p>}
      {checkError && <p className="notice err" role="alert">{checkError}</p>}
      {!activation && deviceToken && ["pending","expired","missing"].includes(state) && (state !== "missing" || checkError) &&
        <button className="btn" type="button" disabled={checking || busy} onClick={() => void check(deviceToken)}>Aggiorna stato</button>}
      {showForm && <>
          <p>{choosingPassword ? "Scegli una password personale per la tua postazione Setter."
            : "Invia la richiesta e torna su questo link dallo stesso browser per scegliere la password dopo l’approvazione."}</p>
          {error && <div className="notice err" role="alert">{error}</div>}
          {choosingPassword ? <>
            <div className="field"><label htmlFor="setter-new-password">Password</label><input id="setter-new-password" type={passwordVisible ? "text" : "password"} autoComplete="new-password" autoCapitalize="none" spellCheck={false} aria-describedby="setter-password-hint" required minLength={12} maxLength={72} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></div>
            <div className="field"><label htmlFor="setter-repeat-password">Conferma password</label><input id="setter-repeat-password" type={passwordVisible ? "text" : "password"} autoComplete="new-password" autoCapitalize="none" spellCheck={false} required minLength={12} maxLength={72} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} /></div>
            <div className="setter-password-options">
              <small id="setter-password-hint">Usa almeno 12 caratteri.</small>
              <label><input type="checkbox" checked={passwordVisible} onChange={e => setPasswordVisible(e.target.checked)} disabled={busy} /> Mostra password</label>
            </div>
          </> : <>
            <div className="field"><label htmlFor="setter-register-name">Nome e cognome</label><input id="setter-register-name" autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></div>
            <div className="field"><label htmlFor="setter-register-email">Email</label><input id="setter-register-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} /></div>
          </>}
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "Un attimo…" : choosingPassword ? "Attiva accesso" : "Invia richiesta"}</button>
        </>}
      <a className="btn setter-register-login" href="/">Vai al login</a>
    </form>
  </main>;
}
