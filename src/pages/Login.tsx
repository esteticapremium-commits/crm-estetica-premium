import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

type Mode = "login" | "forgot" | "recovery" | "done";

export default function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Il link di recupero password arriva con un token nell'URL
  // (#access_token=...&type=recovery oppure #code=...&type=recovery).
  useEffect(() => {
    if (window.location.hash.includes("type=recovery")) setMode("recovery");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (error) {
      setErr("Email o password non corretti.");
    }
    // Se ok, useAuth rileva la sessione e l'app cambia da sola.
  }

  async function sendReset(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin + "/",
    });
    setBusy(false);
    if (error) {
      setErr("Invio email non riuscito: " + error.message);
    } else {
      setMsg(
        "Email inviata. Apri il link che hai ricevuto (controlla anche lo spam) e scegli la nuova password."
      );
    }
  }

  async function setNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 6) {
      setErr("La password deve avere almeno 6 caratteri.");
      return;
    }
    if (password !== confirm) {
      setErr("Le due password non coincidono.");
      return;
    }
    setBusy(true);
    try {
      // Il link di recupero puo' contenere i token diretti (implicit) o un
      // codice da scambiare (PKCE): gestiamo entrambi i casi.
      const params = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      const code = params.get("code");
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) throw error;
      } else if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
      } else {
        throw new Error("link non valido, chiedi un nuovo link di recupero");
      }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      await supabase.auth.signOut();
      window.history.replaceState(null, "", "/");
      setMode("done");
    } catch (e) {
      setErr("Cambio password non riuscito: " + (e as Error).message);
    }
    setBusy(false);
  }

  if (mode === "recovery") {
    return (
      <div className="login-wrap">
        <form className="login-box" onSubmit={setNewPassword}>
          <h1>Nuova password</h1>
          <p>Scegli la nuova password per il tuo account.</p>

          {err && <div className="notice err">{err}</div>}

          <div className="field">
            <label>Nuova password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label>Ripeti la nuova password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>

          <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Salvataggio…" : "Salva nuova password"}
          </button>
        </form>
      </div>
    );
  }

  if (mode === "done") {
    return (
      <div className="login-wrap">
        <div className="login-box">
          <h1>Password cambiata ✓</h1>
          <p>Ora puoi entrare con la nuova password.</p>
          <button
            className="btn primary"
            style={{ width: "100%" }}
            onClick={() => setMode("login")}
          >
            Torna al login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={mode === "forgot" ? sendReset : submit}>
        <h1>Estetica Premium</h1>
        <p>
          {mode === "forgot"
            ? "Scrivi la tua email: ti mandiamo il link per scegliere una nuova password."
            : "Accedi per vedere la tua pipeline."}
        </p>

        {err && <div className="notice err">{err}</div>}
        {msg && <div className="notice ok">{msg}</div>}

        <div className="field">
          <label>Email</label>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {mode === "login" && (
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        )}

        <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? "Un attimo…" : mode === "forgot" ? "Invia link di recupero" : "Entra"}
        </button>

        <a
          href="#"
          style={{ display: "block", marginTop: 12, fontSize: 13, textAlign: "center" }}
          onClick={(e) => {
            e.preventDefault();
            setMode(mode === "forgot" ? "login" : "forgot");
            setErr(null);
            setMsg(null);
            setPassword("");
          }}
        >
          {mode === "forgot" ? "← Torna al login" : "Password dimenticata?"}
        </a>
      </form>
    </div>
  );
}
