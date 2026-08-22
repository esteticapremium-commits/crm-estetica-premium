import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import type { Profile } from "./types";

export interface AuthState {
  loading: boolean;
  userId: string | null;
  email: string | null;
  profile: Profile | null;
}

/** Gestisce la sessione di login e carica il profilo (ruolo + cliente). */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    userId: null,
    email: null,
    profile: null,
  });

  useEffect(() => {
    let active = true;

    async function loadProfile(userId: string, email: string | null) {
      const { data } = await supabase
        .from("profiles")
        .select("id, role, client_id, full_name")
        .eq("id", userId)
        .maybeSingle();
      if (!active) return;
      setState({
        loading: false,
        userId,
        email,
        profile: (data as Profile) ?? null,
      });
    }

    supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      if (!active) return;
      if (s?.user) loadProfile(s.user.id, s.user.email ?? null);
      else setState({ loading: false, userId: null, email: null, profile: null });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      if (!active) return;
      if (session?.user) {
        setState((p) => ({ ...p, loading: true }));
        loadProfile(session.user.id, session.user.email ?? null);
      } else {
        setState({ loading: false, userId: null, email: null, profile: null });
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
