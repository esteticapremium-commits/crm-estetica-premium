import { createClient } from "@supabase/supabase-js";

// La chiave `anon` è pubblica per design: la protezione dei dati è affidata
// alle policy RLS del database. Le variabili di ambiente hanno sempre
// priorità; i valori di riserva evitano che il CRM resti inutilizzabile se
// Vercel non le ha ancora configurate.
const FALLBACK_SUPABASE_URL = "https://mvujbtygcmowkbvoqcgp.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12dWpidHlnY21vd2tidm9xY2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MzQ3MDMsImV4cCI6MjEwMzAxMDcwM30.Xk3CUy-3ESAuHvTAQRDtDrrAN4iTQlhQ2pYc9Lb_PSw";

export const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) || FALLBACK_SUPABASE_URL;
export const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || FALLBACK_SUPABASE_ANON_KEY;
export const isSupabaseConfigured = true;

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  { auth: { detectSessionInUrl: false } }
);

// URL della funzione che gestisce gli utenti (usata solo dall'admin)
export const ADMIN_FN_URL = `${SUPABASE_URL}/functions/v1/admin-user`;
