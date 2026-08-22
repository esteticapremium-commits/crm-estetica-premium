import { createClient } from "@supabase/supabase-js";

// CRM Estetica Premium — progetto separato.
// Il database di questo CRM è un progetto Supabase dedicato: la URL e la
// chiave anon (pubblica) vanno inserite qui sotto, oppure tramite le
// variabili VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY su Vercel.
// NOTA: la chiave anon è PUBBLICA per design (le regole di sicurezza del
// database proteggono i dati). La service_role NON va mai messa nel codice.
const DEFAULT_URL = "https://PROJECT_REF.supabase.co";
const DEFAULT_ANON_KEY = "LA_TUA_CHIAVE_ANON";

export const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string) || DEFAULT_URL;
export const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || DEFAULT_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // Gestiamo noi il link di recupero password (vedi Login.tsx), così
  // l'app non consuma da sola il token nell'URL.
  auth: { detectSessionInUrl: false },
});

// URL della funzione che gestisce gli utenti (usata solo dall'admin)
export const ADMIN_FN_URL = `${SUPABASE_URL}/functions/v1/admin-user`;
