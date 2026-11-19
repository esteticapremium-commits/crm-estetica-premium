import { useEffect, useState } from "react";
import { withTimeout } from "../async";
import { romeStamp } from "../dates";
import { supabase } from "../supabaseClient";

type Handoff = {
  setter_name: string;
  sales_owner: string | null;
  discovery_status: string | null;
  outcome_note: string | null;
  notes: { id: string; author_name: string; body: string; created_at: string }[];
};

export default function SalesSetterHandoff({ clientId, leadId }: { clientId: string; leadId: string }) {
  const [result, setResult] = useState<{ handoff?: Handoff; error?: boolean }>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    withTimeout(supabase.rpc("get_sales_setter_handoff", { p_client_id: clientId, p_lead_id: leadId }))
      .then(({ data, error }) => {
        if (error) throw error;
        if (active) setResult({ handoff: data ?? undefined });
      }).catch(() => { if (active) setResult({ error: true }); });
    return () => { active = false; };
  }, [clientId, leadId, revision]);

  if (result?.error) return <p className="notice warn">
    Passaggio dal setter non disponibile. <button className="btn small" type="button" onClick={() => {
      setResult(undefined); setRevision(value => value + 1);
    }}>Riprova</button>
  </p>;
  const handoff = result?.handoff;
  if (!handoff) return null;
  const totalNotes = handoff.notes.length + Number(Boolean(handoff.outcome_note));
  return <section className="lead-appointment-overview" aria-label="Passaggio alle vendite">
    <b>Passaggio alle vendite</b>
    <p>Discovery fissata da {handoff.setter_name}. In carico a <strong>{handoff.sales_owner || "Vendite"}</strong>.</p>
    {handoff.discovery_status === "no_show" && <p>Il richiamo dopo il no-show è in carico alle vendite.</p>}
    {totalNotes > 0 && <details>
      <summary>Note del setter ({totalNotes})</summary>
      {handoff.outcome_note && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{handoff.outcome_note}</p>}
      {handoff.notes.map(note => <div key={note.id} className="lead-appointment-overview-row">
        <span><strong>{note.author_name}</strong> <time dateTime={note.created_at}>{romeStamp(note.created_at)}</time>
          <small style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{note.body}</small>
        </span>
      </div>)}
    </details>}
  </section>;
}
