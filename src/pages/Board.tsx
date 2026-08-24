import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { supabase } from "../supabaseClient";
import type { Client, Lead, Pipeline, Stage } from "../types";
import LeadModal from "./LeadModal";
import { romeToday } from "../dates";

// Probabilità di chiusura per fase (impostazione da CRM vendita: il valore
// della pipeline si pondera per la probabilità della fase in cui si trova).
export const STAGE_PROBABILITY: Record<string, number> = {
  "NO ANSWER": 5,
  "RECALL": 15,
  "DISCOVERY": 30,
  "SETTING": 50,
  "NO SHOW": 10,
  "CLOSING": 75,
  "LOST": 0,
  "CLOSED": 100,
};

export default function Board({
  client,
  pipeline,
  canEdit,
  meName,
  autoAssign,
  focusLeadId,
  onFocusConsumed,
}: {
  client: Client;
  pipeline: Pipeline;
  canEdit: boolean;
  meName?: string;
  /** Se true, spostando un lead lo si assegna automaticamente a chi lo sposta
   *  (attivo per le segretarie, disattivo per l'admin). */
  autoAssign?: boolean;
  /** Apre in modale il lead arrivato dalla ricerca globale. */
  focusLeadId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeLead, setActiveLead] = useState<Lead | null>(null);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [creatingInStage, setCreatingInStage] = useState<Stage | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const load = useCallback(async () => {
    const [{ data: st }, { data: ld }] = await Promise.all([
      supabase
        .from("stages")
        .select("*")
        .eq("pipeline_id", pipeline.id)
        .order("position"),
      supabase
        .from("leads")
        .select("*")
        .eq("pipeline_id", pipeline.id)
        .order("position")
        .order("created_at", { ascending: false }),
    ]);
    setStages((st as Stage[]) ?? []);
    setLeads((ld as Lead[]) ?? []);
    setLoading(false);
  }, [pipeline.id]);

  useEffect(() => {
    setLoading(true);
    load();
    // Aggiornamento in tempo reale: se un altro venditore sposta un lead,
    // la bacheca si aggiorna da sola.
    const ch = supabase
      .channel(`leads-${pipeline.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "leads",
          filter: `pipeline_id=eq.${pipeline.id}`,
        },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [pipeline.id, load]);

  // Lead arrivato dalla ricerca globale: apri la sua scheda
  useEffect(() => {
    if (!focusLeadId) return;
    const lead = leads.find((l) => l.id === focusLeadId);
    if (lead) {
      setEditing(lead);
      onFocusConsumed?.();
    }
  }, [focusLeadId, leads, onFocusConsumed]);

  // Nome della fase per ogni lead (per i badge sulle card)
  const leadStageNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of stages) m[s.id] = s.name;
    return m;
  }, [stages]);

  const leadsByStage = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    for (const s of stages) map[s.id] = [];
    for (const l of leads) {
      if (!map[l.stage_id]) map[l.stage_id] = [];
      map[l.stage_id].push(l);
    }
    return map;
  }, [stages, leads]);

  async function onDragEnd(e: DragEndEvent) {
    setActiveLead(null);
    const leadId = String(e.active.id);
    const targetStageId = e.over ? String(e.over.id) : null;
    if (!targetStageId) return;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stage_id === targetStageId) return;

    // Posiziona in cima alla colonna di destinazione
    const minPos = Math.min(
      0,
      ...(leadsByStage[targetStageId] ?? []).map((l) => l.position)
    );
    const newPos = minPos - 1;

    // Chi lavora il lead se lo prende (regola: "ultimo che l'ha lavorato").
    // Attivo solo per le segretarie: gli spostamenti dell'admin non riassegnano.
    const patch: {
      stage_id: string;
      position: number;
      assigned_to?: string;
    } = { stage_id: targetStageId, position: newPos };
    if (autoAssign && meName && meName.trim()) {
      patch.assigned_to = meName.trim();
    }

    // Aggiornamento ottimistico (immediato a schermo)
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, ...patch } : l))
    );
    const { error } = await supabase
      .from("leads")
      .update(patch)
      .eq("id", leadId);
    if (error) {
      alert("Non è stato possibile spostare il lead: " + error.message);
      load();
    } else if (meName?.trim()) {
      // Il database registra lo spostamento da solo (trigger): qui scriviamo
      // sopra l'evento appena creato il nome di chi l'ha fatto, per il
      // registro attività in Amministrazione.
      supabase
        .from("lead_stage_events")
        .update({ changed_by: meName.trim() })
        .eq("lead_id", leadId)
        .is("changed_by", null)
        .order("changed_at", { ascending: false })
        .limit(1)
        .then(() => {});
    }
  }

  function onDragStart(e: DragStartEvent) {
    const lead = leads.find((l) => l.id === String(e.active.id));
    setActiveLead(lead ?? null);
  }

  if (loading) return <div className="center-msg">Caricamento bacheca…</div>;
  if (stages.length === 0)
    return (
      <div className="center-msg">
        Questo cliente non ha ancora delle fasi. Aggiungile da
        “Amministrazione”.
      </div>
    );

  const isPremium = client.name.startsWith("Estetica");
  const total = leads.length;
  const hot =
    (leadsByStage[stages.find((s) => s.name === "RECALL")?.id ?? ""] ?? [])
      .length +
    (leadsByStage[stages.find((s) => s.name === "NO ANSWER")?.id ?? ""] ?? [])
      .length;
  const pipeValue = leads.reduce((s, l) => s + (Number(l.value) || 0), 0);
  const weightedValue = leads.reduce((s, l) => {
    const st = stages.find((x) => x.id === l.stage_id);
    const p = st
      ? (st.probability ?? STAGE_PROBABILITY[st.name] ?? 0)
      : 0;
    return s + ((Number(l.value) || 0) * p) / 100;
  }, 0);
  const eur = (n: number) =>
    n ? "€ " + Math.round(n).toLocaleString("it-IT") : "€ 0";

  return (
    <>
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className={"board-wrap" + (isPremium ? " premium" : "")}>
          {isPremium && (
            <div className="board-header">
              <div>
                <div className="board-title">{pipeline.name}</div>
                <div className="board-sub">
                  {total} lead · {hot} da lavorare · {stages.length} fasi
                </div>
              </div>
              <div className="board-kpis">
                <div className="kpi">
                  <span className="kpi-v">{total}</span>
                  <span className="kpi-k">lead totali</span>
                </div>
                <div className="kpi">
                  <span className="kpi-v">{hot}</span>
                  <span className="kpi-k">in lavorazione</span>
                </div>
                <div className="kpi">
                  <span className="kpi-v">
                    {leadsByStage[stages.find((s) => s.name === "CLOSING")?.id ?? ""]?.length ?? 0}
                  </span>
                  <span className="kpi-k">in chiusura</span>
                </div>
                <div className="kpi">
                  <span className="kpi-v">{eur(pipeValue)}</span>
                  <span className="kpi-k">valore pipeline</span>
                </div>
                <div className="kpi">
                  <span className="kpi-v">{eur(weightedValue)}</span>
                  <span className="kpi-k">valore ponderato</span>
                </div>
              </div>
            </div>
          )}
          <div className="board">
            {stages.map((s) => (
              <Column
                key={s.id}
                stage={s}
                leads={leadsByStage[s.id] ?? []}
                onOpen={(l) => setEditing(l)}
                onAdd={canEdit ? () => setCreatingInStage(s) : undefined}
                leadStageNames={leadStageNames}
              />
            ))}
          </div>
        </div>
        <DragOverlay>
          {activeLead ? (
            <LeadCardView
              lead={activeLead}
              stageName={leadStageNames[activeLead.stage_id] ?? ""}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {editing && (
        <LeadModal
          lead={editing}
          stages={stages}
          meName={meName}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {creatingInStage && (
        <LeadModal
          newInStage={creatingInStage}
          clientId={client.id}
          pipelineId={pipeline.id}
          stages={stages}
          meName={meName}
          onClose={() => setCreatingInStage(null)}
          onSaved={() => {
            setCreatingInStage(null);
            load();
          }}
        />
      )}
    </>
  );
}

/* ---------------- Colonna ---------------- */
function Column({
  stage,
  leads,
  onOpen,
  onAdd,
  leadStageNames,
}: {
  stage: Stage;
  leads: Lead[];
  onOpen: (l: Lead) => void;
  onAdd?: () => void;
  leadStageNames: Record<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div className={"column" + (isOver ? " drop-hint" : "")}>
      <div className="col-head">
        <span
          className="col-dot"
          style={{ background: stage.color || "#94a3b8" }}
        />
        {stage.name}
        <span className="col-count">{leads.length}</span>
      </div>
      <div className="col-body" ref={setNodeRef}>
        {leads.map((l) => (
          <DraggableCard
            key={l.id}
            lead={l}
            onOpen={() => onOpen(l)}
            stageName={leadStageNames[l.stage_id] ?? ""}
          />
        ))}
      </div>
      {onAdd && (
        <button className="col-add" onClick={onAdd}>
          + Aggiungi lead
        </button>
      )}
    </div>
  );
}

/* ---------------- Card trascinabile ---------------- */
function DraggableCard({
  lead,
  onOpen,
  stageName,
}: {
  lead: Lead;
  onOpen: () => void;
  stageName: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead.id,
  });
  return (
    <div
      ref={setNodeRef}
      className={"card" + (isDragging ? " dragging" : "")}
      {...listeners}
      {...attributes}
      onClick={onOpen}
    >
      <LeadCardInner lead={lead} stageName={stageName} />
    </div>
  );
}

/* Card usata anche nell'overlay di trascinamento */
function LeadCardView({ lead, stageName }: { lead: Lead; stageName: string }) {
  return (
    <div className="card" style={{ width: 264 }}>
      <LeadCardInner lead={lead} stageName={stageName} />
    </div>
  );
}

function daysSince(d: string) {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  return Math.max(0, Math.floor(diff / 86400000));
}

function LeadCardInner({
  lead,
  stageName,
}: {
  lead: Lead;
  stageName: string;
}) {
  const idle = daysSince(lead.updated_at ?? lead.created_at);
  const isDead = ["LOST", "CLOSED"].includes(stageName);
  return (
    <>
      <div className="name">{lead.name || "(senza nome)"}</div>
      {lead.value ? (
        <div className="deal-value">
          € {Number(lead.value).toLocaleString("it-IT")}
        </div>
      ) : null}
      {lead.phone && (
        <div className="row">
          <span>📞</span>
          <a href={`tel:${lead.phone}`} onClick={(e) => e.stopPropagation()}>
            {lead.phone}
          </a>
        </div>
      )}
      {lead.email && (
        <div className="row">
          <span>✉️</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {lead.email}
          </span>
        </div>
      )}
      {lead.next_action_date && (
        <div className="row">
          <span>📅</span>
          <span className={lead.next_action_date <= romeToday() ? "overdue" : ""}>
            {new Date(lead.next_action_date).toLocaleDateString("it-IT", {
              day: "numeric",
              month: "short",
            })}
          </span>
        </div>
      )}
      {stageName === "LOST" && lead.lost_reason && (
        <div className="row lost-reason">✗ {lead.lost_reason}</div>
      )}
      <div className="tags">
        {lead.assigned_to && (
          <span className="chip">
            <span className="mini">{lead.assigned_to.trim().charAt(0).toUpperCase()}</span>
            {lead.assigned_to}
          </span>
        )}
        {lead.source && <span className="chip src">{lead.source}</span>}
        {lead.notes && <span className="chip note">📝 nota</span>}
        {!isDead && idle !== null && idle >= 3 && (
          <span className="chip idle">⏳ fermo {idle} gg</span>
        )}
      </div>
    </>
  );
}
