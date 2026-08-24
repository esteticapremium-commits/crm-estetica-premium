import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import type { Contract, ContractTemplate, Lead, Stage } from "../types";

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
  // Contratti
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  const [ctForm, setCtForm] = useState(false);
  const [ctTpl, setCtTpl] = useState("");
  const [ctTitle, setCtTitle] = useState("");
  const [ctTo, setCtTo] = useState(lead?.email ?? "");
  const [ctVals, setCtVals] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!lead) return;
    supabase
      .from("contracts")
      .select("*")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setContracts((data as Contract[]) ?? []));
    supabase
      .from("contract_templates")
      .select("*")
      .order("name")
      .then(({ data }) => {
        const list = (data as ContractTemplate[]) ?? [];
        setTemplates(list);
        setCtTpl(list[0]?.id ?? "");
      });
  }, [lead?.id]);

  // placeholders del modello selezionato
  const tpl = templates.find((x) => x.id === ctTpl);
  const placeholders = [
    ...new Set((tpl?.body ?? "").match(/\{\{(\w+)\}\}/g) ?? []),
  ].map((ph) => ph.slice(2, -2));

  function openCtForm() {
    const defaults: Record<string, string> = {
      nome_lead: lead?.name ?? "",
      email_lead: lead?.email ?? "",
      telefono_lead: lead?.phone ?? "",
      nome_venditore: meName ?? "",
    };
    setCtVals(defaults);
    setCtTitle(`Contratto — ${lead?.name ?? "lead"}`);
    setCtTo(lead?.email ?? "");
    setCtForm(true);
  }

  async function createContract() {
    if (!lead || !clientId) return;
    if (!ctTpl) return setErr("Scegli un modello.");
    setErr(null);
    let body = tpl?.body ?? "";
    const vals: Record<string, string> = {
      ...ctVals,
      data_oggi: new Date().toLocaleDateString("it-IT"),
    };
    for (const [k, v] of Object.entries(vals)) {
      body = body.split(`{{${k}}}`).join(v || "");
    }
    const { error } = await supabase.from("contracts").insert({
      client_id: clientId,
      lead_id: lead.id,
      template_id: ctTpl,
      title: ctTitle.trim() || "Contratto",
      body,
      status: "draft",
      sent_to: ctTo.trim() || lead.email || null,
      created_by: meName ?? null,
    });
    if (error) return setErr(error.message);
    setCtForm(false);
    supabase
      .from("contracts")
      .select("*")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setContracts((data as Contract[]) ?? []));
  }

  async function markSent(c: Contract) {
    const { error } = await supabase
      .from("contracts")
      .update({ status: "sent", sent_at: new Date().toISOString(), sent_to: ctTo.trim() || c.sent_to })
      .eq("id", c.id);
    if (error) return alert(error.message);
    setContracts((prev) =>
      prev.map((x) => (x.id === c.id ? { ...x, status: "sent", sent_at: new Date().toISOString() } : x))
    );
  }

  const firmLink = (c: Contract) =>
    `${window.location.origin}/#/firma/${c.sign_token}`;

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

          {!isNew && (
            <div className="contracts-box">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <b>📄 Contratti</b>
                <button className="btn small" onClick={openCtForm}>
                  + Nuovo contratto
                </button>
              </div>
              {contracts.length === 0 && !ctForm && (
                <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 6 }}>
                  Nessun contratto per questo lead.
                </div>
              )}
              {contracts.map((c) => (
                <div className="contract-row" key={c.id}>
                  <div>
                    <b>{c.title}</b>
                    <div className="contract-meta">
                      {c.status === "signed"
                        ? `✓ Firmato da ${c.signed_name ?? "—"} il ${
                            c.signed_at ? new Date(c.signed_at).toLocaleString("it-IT") : ""
                          }`
                        : c.status === "sent"
                        ? `📤 Inviato a ${c.sent_to ?? "—"}`
                        : `📝 Bozza · a ${c.sent_to ?? "—"}`}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {c.status !== "signed" && (
                      <>
                        <button
                          className="btn small"
                          onClick={() => {
                            navigator.clipboard.writeText(firmLink(c));
                            alert("Link di firma copiato. Incollalo nella mail al cliente.");
                          }}
                        >
                          Copia link
                        </button>
                        <a
                          className="btn small"
                          style={{ textDecoration: "none" }}
                          href={`mailto:${encodeURIComponent(c.sent_to ?? "")}?subject=${encodeURIComponent(
                            c.title
                          )}&body=${encodeURIComponent(
                            `Buongiorno,

ti invio il contratto da firmare: ${firmLink(c)}

Basta aprire il link, compilare i campi e firmare con il dito.

Grazie!`
                          )}`}
                        >
                          Invia email
                        </a>
                        <button className="btn small" onClick={() => markSent(c)}>
                          Segna inviato
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {ctForm && (
                <div className="ct-form">
                  <div className="field">
                    <label>Modello</label>
                    <select value={ctTpl} onChange={(e) => setCtTpl(e.target.value)}>
                      {templates.map((tp) => (
                        <option key={tp.id} value={tp.id}>
                          {tp.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Titolo contratto</label>
                    <input value={ctTitle} onChange={(e) => setCtTitle(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Email del cliente</label>
                    <input value={ctTo} onChange={(e) => setCtTo(e.target.value)} />
                  </div>
                  {placeholders
                    .filter((ph) => ph !== "data_oggi")
                    .map((ph) => (
                      <div className="field" key={ph}>
                        <label>{ph.replace(/_/g, " ")}</label>
                        <input
                          value={ctVals[ph] ?? ""}
                          onChange={(e) =>
                            setCtVals((prev) => ({ ...prev, [ph]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="btn" onClick={() => setCtForm(false)}>
                      Annulla
                    </button>
                    <button className="btn primary" onClick={createContract}>
                      Genera contratto
                    </button>
                  </div>
                </div>
              )}
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
