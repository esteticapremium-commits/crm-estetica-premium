import { useState } from "react";
import { supabase } from "../supabaseClient";
import type { Lead, Stage } from "../types";

interface Props {
  lead?: Lead;
  newInStage?: Stage;
  clientId?: string;
  pipelineId?: string;
  stages: Stage[];
  meName?: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function LeadModal({
  lead,
  newInStage,
  clientId,
  pipelineId,
  stages,
  meName,
  onClose,
  onSaved,
}: Props) {
  const isNew = !lead;
  const [name, setName] = useState(lead?.name ?? "");
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [email, setEmail] = useState(lead?.email ?? "");
  const [source, setSource] = useState(lead?.source ?? "Facebook");
  const [assigned, setAssigned] = useState(lead?.assigned_to ?? "");
  const [value, setValue] = useState(String(lead?.value ?? 0));
  const [stageId, setStageId] = useState(
    lead?.stage_id ?? newInStage?.id ?? stages[0]?.id
  );
  const [notes, setNotes] = useState(lead?.notes ?? "");
  const [nextAction, setNextAction] = useState(lead?.next_action_date ?? "");
  const [closingDate, setClosingDate] = useState(lead?.closing_date ?? "");
  const [lostReason, setLostReason] = useState(lead?.lost_reason ?? "");
  const [tags, setTags] = useState(lead?.tags ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    const payload = {
      name: name.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      source: source.trim() || null,
      assigned_to: assigned.trim() || null,
      value: Number(value) || 0,
      stage_id: stageId,
      notes: notes.trim() || null,
      next_action_date: nextAction.trim() || null,
      closing_date: closingDate.trim() || null,
      lost_reason: lostReason.trim() || null,
      tags: tags.trim() || null,
    };
    let error;
    let newLeadId: string | null = null;
    if (isNew) {
      const res = await supabase
        .from("leads")
        .insert({ ...payload, client_id: clientId, pipeline_id: pipelineId })
        .select("id")
        .single();
      error = res.error;
      newLeadId = (res.data as { id: string } | null)?.id ?? null;
    } else {
      ({ error } = await supabase
        .from("leads")
        .update(payload)
        .eq("id", lead!.id));
    }
    setBusy(false);
    if (error) setErr(error.message);
    else {
      // Se la fase è cambiata (o il lead è nuovo), il database ha registrato
      // l'evento da solo: ci scriviamo sopra il nome di chi l'ha fatto.
      const stageChanged = isNew || stageId !== lead!.stage_id;
      const lid = newLeadId ?? lead!.id;
      if (stageChanged && meName?.trim() && lid) {
        supabase
          .from("lead_stage_events")
          .update({ changed_by: meName.trim() })
          .eq("lead_id", lid)
          .is("changed_by", null)
          .order("changed_at", { ascending: false })
          .limit(1)
          .then(() => {});
      }
      onSaved();
    }
  }

  async function remove() {
    if (!lead) return;
    if (!confirm("Eliminare definitivamente questo lead?")) return;
    setBusy(true);
    const { error } = await supabase.from("leads").delete().eq("id", lead.id);
    setBusy(false);
    if (error) setErr(error.message);
    else onSaved();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{isNew ? "Nuovo lead" : name || "Lead"}</h3>
          <button className="x" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="content">
          {err && <div className="notice err">{err}</div>}

          <div className="field">
            <label>Nome</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Telefono</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Fase</label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>
                Assegnata a
                {meName && meName.trim() && assigned.trim() !== meName.trim() && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setAssigned(meName.trim())}
                  >
                    Assegna a me
                  </button>
                )}
              </label>
              <input
                value={assigned}
                onChange={(e) => setAssigned(e.target.value)}
                placeholder="es. Asmaa"
              />
            </div>
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Fonte</label>
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Valore (€)</label>
              <input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>
          <div className="modal-row">
            <div className="field" style={{ flex: 1 }}>
              <label>Prossima azione</label>
              <input
                type="date"
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Chiusura prevista</label>
              <input
                type="date"
                value={closingDate}
                onChange={(e) => setClosingDate(e.target.value)}
              />
            </div>
          </div>
          {stages.find((s) => s.id === stageId)?.name === "LOST" && (
            <div className="field">
              <label>Motivo della perdita</label>
              <select
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              >
                <option value="">— scegli —</option>
                <option>Prezzo troppo alto</option>
                <option>Ha scelto un concorrente</option>
                <option>Non interessato più</option>
                <option>Irraggiungibile</option>
                <option>Budget fermo</option>
                <option>Altro</option>
              </select>
            </div>
          )}
          <div className="field">
            <label>Etichette (separate da virgola, es. VIP, caldo)</label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="es. VIP, da richiamare"
            />
          </div>
          <div className="field">
            <label>Note (storico chiamate, esito, ecc.)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {!isNew && (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              Creato il{" "}
              {new Date(lead!.created_at).toLocaleString("it-IT")}
            </div>
          )}
        </div>
        <footer>
          {!isNew && (
            <button
              className="btn danger"
              onClick={remove}
              disabled={busy}
              style={{ marginRight: "auto" }}
            >
              Elimina
            </button>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>
            Annulla
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Salvataggio…" : "Salva"}
          </button>
        </footer>
      </div>
    </div>
  );
}
