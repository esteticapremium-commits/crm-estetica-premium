import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import type { Profile } from "./types";
import { withTimeout } from "./async";

export interface AuthState {
  loading: boolean;
  userId: string | null;
  email: string | null;
  profile: Profile | null;
  error: string | null;
}

/** Gestisce la sessione di login e carica il profilo (ruolo + cliente). */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    userId: null,
    email: null,
    profile: null,
    error: null,
  });

  useEffect(() => {
    let active = true;
    let currentUserId: string | null = null;
    let requestId = 0;

    async function loadProfile(userId: string, email: string | null) {
      const ownRequest = ++requestId;
      try {
        const { data, error } = await withTimeout(
          supabase
            .from("profiles")
            .select("id, role, client_id, full_name")
            .eq("id", userId)
            .maybeSingle(),
          12_000,
          "Il profilo non risponde. Controlla la connessione e riprova."
        );
        if (error) throw error;
        if (!active || ownRequest !== requestId) return;
        setState({ loading: false, userId, email, profile: (data as Profile) ?? null, error: null });
      } catch (reason) {
        if (!active || ownRequest !== requestId) return;
        setState({
          loading: false,
          userId,
          email,
          profile: null,
          error: reason instanceof Error ? reason.message : "Accesso temporaneamente non disponibile.",
        });
      }
    }

    function handleSession(session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) {
      if (!active) return;
      if (!session?.user) {
        currentUserId = null;
        requestId += 1;
        setState({ loading: false, userId: null, email: null, profile: null, error: null });
        return;
      }
      // getSession e INITIAL_SESSION possono arrivare quasi insieme. Una sola
      // lettura del profilo evita lampeggi e caricamenti duplicati.
      if (currentUserId === session.user.id) return;
      currentUserId = session.user.id;
      setState((previous) => ({ ...previous, loading: true, error: null }));
      void loadProfile(session.user.id, session.user.email ?? null);
    }

    withTimeout(
      supabase.auth.getSession(),
      12_000,
      "La sessione non risponde. Controlla la connessione e riprova."
    )
      .then(({ data }) => handleSession(data.session))
      .catch((reason) => {
        if (!active) return;
        setState({
          loading: false,
          userId: null,
          email: null,
          profile: null,
          error: reason instanceof Error ? reason.message : "Accesso temporaneamente non disponibile.",
        });
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      handleSession(session);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
