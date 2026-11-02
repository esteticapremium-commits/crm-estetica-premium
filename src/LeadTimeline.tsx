import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "./supabaseClient";
import { romeStamp } from "./dates";
import type { Contract, Lead, SalesRevenueEvent, Stage } from "./types";
export type TimelineItem = { id: string; at: string | null; content: ReactNode };
function sortKey(at: string | null) {
  if (!at) return "";
  const stamp = /^\d{2}\/\d{2}\/\d{4}/.test(at) ? at : romeStamp(at);
  const m = stamp.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  return m ? `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}` : "";
}
export default function LeadTimeline({lead, stages, activities, notes, contracts, payments, error}: {lead:Lead;stages:Stage[];activities:TimelineItem[];notes:string[];contracts:Contract[];payments:SalesRevenueEvent[];error?:string}) {
  const [moves, setMoves] = useState<{id:string;changed_at:string;changed_by:string|null;from_stage_id:string|null;to_stage_id:string}[]>([]);
  const [moveError, setMoveError] = useState("");
  const [limit, setLimit] = useState(30);
  useEffect(() => {
    let active = true;
    void Promise.resolve(supabase.from("lead_stage_events").select("id,changed_at,changed_by,from_stage_id,to_stage_id").eq("lead_id", lead.id).order("changed_at",{ascending:false}).limit(1000)).then(({data,error}) => {
      if (!active) return;
      setMoveError(error ? "Cambi di fase non disponibili: " + error.message : ""); setMoves(data || []);
    }).catch(() => {if(active) setMoveError("Cambi di fase non disponibili. Riprova riaprendo la scheda.");});
    return () => { active = false; };
  }, [lead.id]);
  const items: TimelineItem[] = [
    {id:"created",at:lead.created_at,content:<><b>Lead creato</b><small>{romeStamp(lead.created_at)}</small></>},
    ...activities,
    ...notes.map((note,i) => ({id:`note-${i}`,at:note.match(/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/)?.[0] || null,content:<><b>Nota</b><p>{note}</p></>})),
    ...moves.map(m => ({id:`move-${m.id}`,at:m.changed_at,content:<><b>Cambio fase</b><p>{stages.find(s => s.id === m.from_stage_id)?.name || "Fase precedente"} → {stages.find(s => s.id === m.to_stage_id)?.name || "Altra pipeline"}</p><small>{romeStamp(m.changed_at)} · {m.changed_by || "CRM"}</small></>})),
    ...contracts.flatMap(c => [
      {id:`contract-${c.id}`,at:c.created_at,content:<><b>Contratto preparato</b><p>{c.title}</p><small>{romeStamp(c.created_at)} · {c.created_by || "CRM"}</small></>},
      ...(c.signed_at ? [{id:`signed-${c.id}`,at:c.signed_at,content:<><b>Contratto firmato</b><p>{c.title}</p><small>{romeStamp(c.signed_at)} · {c.signed_name}</small></>}] : []),
      ...(c.revoked_at ? [{id:`revoked-${c.id}`,at:c.revoked_at,content:<><b>Link revocato</b><p>{c.title}</p><small>{romeStamp(c.revoked_at)}</small></>}] : [])
    ]),
    ...payments.filter(p => p.status === "collected").map(p => ({id:`payment-${p.id}`,at:p.occurred_at,content:<><b>Incasso · {Number(p.amount).toLocaleString("it-IT",{style:"currency",currency:"EUR"})}</b><small>Avvenuto il {romeStamp(p.occurred_at)}</small><small>Registrato il {romeStamp(p.created_at)} · {p.created_by || "CRM"}</small>{p.note && <p>{p.note}</p>}</>}))
  ].sort((a,b) => sortKey(b.at).localeCompare(sortKey(a.at)) || a.id.localeCompare(b.id));
  return <div className="lead-timeline"><h4>La storia del lead</h4><p className="muted">Dal più recente. Le note senza data sono in fondo. Mostra gli eventi disponibili, fino a 500 azioni e 1.000 cambi di fase.</p>{(error || moveError) && <div className="notice err">{error || moveError}</div>}<ol>{items.slice(0,limit).map(item => <li key={item.id} className={!item.at ? "undated" : ""}>{item.content}{!item.at && <small>Data non registrata</small>}</li>)}</ol>{items.length > limit && <button className="btn" onClick={() => setLimit(n => n + 30)}>Mostra altri · {items.length - limit} rimanenti</button>}</div>;
}
