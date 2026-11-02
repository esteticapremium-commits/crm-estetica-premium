import type { SupabaseClient } from "@supabase/supabase-js";
import { withTimeout } from "./async";

/** Compare-and-swap: a concurrent writer must never lose their note. */
export async function appendLeadNote(client: SupabaseClient, leadId: string, entry: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await withTimeout(client.from("leads").select("notes").eq("id", leadId).single());
    if (current.error) throw new Error(current.error.message);
    const previous: string | null = current.data.notes;
    const notes = previous?.trim() ? `${entry}\n\n---\n\n${previous}` : entry;
    let update = client.from("leads").update({ notes }).eq("id", leadId);
    update = previous === null ? update.is("notes", null) : update.eq("notes", previous);
    const saved = await withTimeout(update.select("id"));
    if (saved.error) throw new Error(saved.error.message);
    if (saved.data?.length === 1) return notes;
  }
  throw new Error("Il lead è in aggiornamento da un altro utente. La tua nota è ancora qui: riprova.");
}
