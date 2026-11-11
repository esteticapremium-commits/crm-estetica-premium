import type { SupabaseClient } from "@supabase/supabase-js";
import { withTimeout } from "./async";

/** Read the destination at save time; do not renumber any other lead. */
export async function topLeadPosition(
  db: Pick<SupabaseClient, "from">,
  clientId: string,
  pipelineId: string | null,
  stageId: string,
): Promise<number> {
  let query = db.from("leads").select("position")
    .eq("client_id", clientId).eq("stage_id", stageId);
  query = pipelineId === null ? query.is("pipeline_id", null) : query.eq("pipeline_id", pipelineId);
  const { data, error } = await withTimeout(query
    .order("position", { ascending: true, nullsFirst: false }).limit(1).maybeSingle());
  if (error) throw new Error("Impossibile determinare la posizione nella fase: " + error.message);
  return Math.min(0, data?.position ?? 0) - 1;
}
