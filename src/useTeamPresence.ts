import { useEffect, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./supabaseClient";
import type { AuthState } from "./useAuth";
import { withTimeout } from "./async";
import { isPresenceActive, PRESENCE_IDLE_MS } from "./teamPresenceLogic";

export type PresenceStatus = "connecting" | "recording" | "offline" | "unavailable";
/** Segnali aggregati, mai contenuti digitati, coordinate o screenshot. */
export function useTeamPresence(auth: AuthState, clientId: string | null, enabled: boolean) {
  const [status, setStatus] = useState<PresenceStatus>("connecting");
  useEffect(() => {
    if (!enabled || !clientId || !auth.userId || !auth.profile || auth.loading) return;
    let sessionId = crypto.randomUUID();
    let lastInteraction = Date.now();
    let token: string | null = null;
    let stopped = false;
    let busy = false;
    let requested = false;
    const isActive = () => isPresenceActive(document.visibilityState === "visible", document.hasFocus(), lastInteraction, Date.now());

    async function heartbeat() {
      if (stopped) return;
      if (!navigator.onLine) { setStatus("offline"); return; }
      if (busy) { requested = true; return; }
      busy = true;
      try {
        const { data } = await withTimeout(supabase.auth.getSession(), 10_000, "Presence session unavailable");
        if (!data.session || data.session.user.id !== auth.userId || stopped) return;
        token = data.session.access_token;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 10_000);
        let response: Response;
        try {
          response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/team_presence_heartbeat`, {
            method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ p_session_id: sessionId, p_client_id: clientId, p_active: isActive(), p_close: false }), signal: controller.signal,
          });
        } finally { window.clearTimeout(timeout); }
        if (!response.ok) throw new Error("Presence unavailable");
        const result = await response.json() as { closed?: boolean };
        if (result.closed && !stopped) { sessionId = crypto.randomUUID(); requested = true; }
        if (!stopped) setStatus("recording");
      } catch {
        if (!stopped) setStatus(navigator.onLine ? "unavailable" : "offline");
      } finally {
        busy = false;
        if (requested && !stopped) { requested = false; void heartbeat(); }
      }
    }
    function close() {
      if (!token) return;
      // keepalive copre logout/chiusura; il timeout server copre crash/rete assente.
      void fetch(`${SUPABASE_URL}/rest/v1/rpc/team_presence_heartbeat`, {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ p_session_id: sessionId, p_client_id: clientId, p_active: isActive(), p_close: true }),
      }).catch(() => {});
    }
    const interaction = () => { const wasIdle = Date.now() - lastInteraction >= PRESENCE_IDLE_MS; lastInteraction = Date.now(); if (wasIdle) void heartbeat(); };
    const changed = () => { void heartbeat(); };
    const focus = () => { lastInteraction = Date.now(); void heartbeat(); };
    const offline = () => setStatus("offline");
    const pagehide = () => { close(); };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) { sessionId = crypto.randomUUID(); void heartbeat(); } };
    window.addEventListener("pointerdown", interaction, { passive: true });
    window.addEventListener("keydown", interaction);
    window.addEventListener("scroll", interaction, { passive: true, capture: true });
    window.addEventListener("focus", focus);
    window.addEventListener("blur", changed);
    window.addEventListener("online", changed);
    window.addEventListener("offline", offline);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", pageshow);
    document.addEventListener("visibilitychange", changed);
    setStatus("connecting");
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), 30_000);
    return () => {
      stopped = true; window.clearInterval(timer); close();
      window.removeEventListener("pointerdown", interaction);
      window.removeEventListener("keydown", interaction);
      window.removeEventListener("scroll", interaction, true);
      window.removeEventListener("focus", focus); window.removeEventListener("blur", changed);
      window.removeEventListener("online", changed); window.removeEventListener("offline", offline);
      window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", pageshow);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [auth.userId, auth.loading, auth.profile?.id, clientId, enabled]);
  return status;
}
