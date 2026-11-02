import type { SupabaseClient } from "@supabase/supabase-js";
import { withTimeout } from "./async";

/** La stessa chiave resta identica anche quando la risposta di rete va persa. */
export async function persistRevenue(client: SupabaseClient, payload: Record<string, unknown>) {
  const result = await withTimeout(client.from("sales_revenue_events").upsert(payload, {
    onConflict: "client_id,event_key", ignoreDuplicates: true, count: "exact",
  }));
  if (result.error) throw new Error(result.error.message);
  if (result.count !== 0 && result.count !== 1) {
    throw new Error("Il database non ha confermato la registrazione. Riprova senza cambiare data e importo.");
  }
  return result.count === 0 ? "existing" : "created";
}
