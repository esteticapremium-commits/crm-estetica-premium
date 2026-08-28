import { createClient } from "@supabase/supabase-js";

// La chiave anon è pubblica per design, ma non deve vivere nel repository.
// Ogni ambiente dichiara esplicitamente il proprio progetto Supabase: una
// copia del codice non può quindi collegarsi per errore al CRM reale.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = createClient(
  SUPABASE_URL || "https://not-configured.supabase.co",
  SUPABASE_ANON_KEY || "not-configured",
  { auth: { detectSessionInUrl: false } }
);

// URL della funzione che gestisce gli utenti (usata solo dall'admin)
export const ADMIN_FN_URL = `${SUPABASE_URL || ""}/functions/v1/admin-user`;
