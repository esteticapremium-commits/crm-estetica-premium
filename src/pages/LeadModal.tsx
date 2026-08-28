import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { romeStamp } from "../dates";
import { openSignedContractPdf } from "../contractPdf";
import { TRIAL_CONTRACT_TEMPLATE } from "../defaultContractTemplates";
import type { Contract, ContractTemplate, Lead, Stage } from "../types";

const BUILT_IN_TRIAL_TEMPLATE_ID = "built-in-trial-contract";

interface Props {
  lead?: Lead;
  newInStage?: Stage;
  clientId?: string;
  pipelineId?: string;
  stages: Stage[];
  meName?: string;
  canDelete?: boolean;
  canReassign?: boolean;
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
  canDelete = false,
  canReassign = false,
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
  const [quickNote, setQuickNote] = useState("");
  const [nextAction, setNextAction] = useState(lead?.next_action_date ?? "");
  const [closingDate, setClosingDate] = useState(lead?.closing_date ?? "");
  const [lostReason, setLostReason] = useState(lead?.lost_reason ?? "");
  const [tags, setTags] = useState(lead?.tags ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activityType, setActivityType] = useState("call");
  const [activityOutcome, setActivityOutcome] = useState("");
  const [activityNote, setActivityNote] = useState("");
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
        const trialTemplate: ContractTemplate = {
          id: BUILT_IN_TRIAL_TEMPLATE_ID,
          client_id: lead.client_id,
          name: TRIAL_CONTRACT_TEMPLATE.name,
          body: TRIAL_CONTRACT_TEMPLATE.body,
          client_fields: TRIAL_CONTRACT_TEMPLATE.clientFields,
          created_at: "",
        };
        const templatesWithTrial = list.some((t) => t.name === trialTemplate.name)
          ? list
          : [trialTemplate, ...list];
        setTemplates(templatesWithTrial);
        setCtTpl(templatesWithTrial[0]?.id ?? "");
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
    const cid = clientId ?? lead?.client_id;
    if (!lead || !cid) return setErr("Cliente mancante: riapri la scheda del lead.");
    if (!ctTpl) return setErr("Scegli un modello.");
    setErr(null);
    let body = tpl?.body ?? "";
    // sostituisci i segnaposto "normali" (valore, data...) ma lascia quelli
    // dei campi cliente: li riempirà il cliente nella pagina di firma.
    const clientSlugs = (tpl?.client_fields ?? "")
      .split("\n")
      .map((f) => f.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
      .filter(Boolean);
    const vals: Record<string, string> = { ...ctVals, data_oggi: new Date().toLocaleDateString("it-IT") };
    for (const ph of placeholders) {
      if (clientSlugs.includes(ph)) continue;
      body = body.split(`{{${ph}}}`).join(vals[ph] ?? "");
    }
    const { data: created, error } = await supabase
      .from("contracts")
      .insert({
        client_id: cid,
        lead_id: lead.id,
        template_id: ctTpl === BUILT_IN_TRIAL_TEMPLATE_ID ? null : ctTpl,
        title: ctTitle.trim() || "Contratto",
        body,
        client_fields: tpl?.client_fields ?? null,
        status: "draft",
        sent_to: ctTo.trim() || lead.email || null,
        created_by: meName ?? null,
      })
      .select("id, sign_token")
      .single();
    if (error) return setErr(error.message);
    setCtForm(false);
    const tok = (created as { sign_token?: string } | null)?.sign_token;
    if (tok) {
      const link = `${window.location.origin}/#/firma/${tok}`;
      alert("Contratto generato (bozza). Link per il cliente:\n\n" + link + "\n\nNon è stato inviato nulla: usa Genera link o WhatsApp.");
    }
    supabase
      .from("contracts")
      .select("*")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setContracts((data as Contract[]) ?? []));
  }

  async function sendEmail(c: Contract) {
    if (!c.sent_to) return alert("Il contratto non ha un destinatario email.");
    setErr(null);
    const { data, error } = await supabase.rpc("send_contract_email", {
      p_contract_id: c.id,
    });
    if (error) return alert("Invio non riuscito: " + error.message);
    if (data !== "inviata") return alert(data);
    alert("Email inviata a " + c.sent_to + ". Il link di firma è nella mail.");
    setContracts((prev) =>
      prev.map((x) =>
        x.id === c.id ? { ...x, status: "sent", sent_at: new Date().toISOString() } : x
      )
    );
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

  const waLink = (c: Contract) => {
    const digits = (lead?.phone ?? "").replace(/\D/g, "");
    const intl = digits.startsWith("39") ? digits : "39" + digits;
    const text =
      "Buongiorno, ti invio il contratto da firmare: " +
      firmLink(c) +
      "\nBasta aprire il link, compilare i campi e firmare con il dito. Grazie!";
    return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
  };

  async function save() {
    if (!isNew && activityOutcome && !nextAction && stages.find((s) => s.id === stageId)?.name !== "CLOSED" && stages.find((s) => s.id === stageId)?.name !== "LOST") {
      return setErr("Dopo un'attività scegli la prossima azione: così nessun lead resta senza seguito.");
    }
    setBusy(true);
    setErr(null);
    // Nota rapida: aggiunta in cima allo storico con data e ora (fuso Roma).
    const qn = quickNote.trim();
    const finalNotes = qn
      ? notes.trim()
        ? `${romeStamp()} — ${qn}\n${notes}`
        : `${romeStamp()} — ${qn}`
      : notes;
    const payload = {
      name: name.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      source: source.trim() || null,
      assigned_to: canReassign ? assigned.trim() || null : meName?.trim() || assigned.trim() || null,
      value: Number(value) || 0,
      stage_id: stageId,
      notes: finalNotes.trim() || null,
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
      setNotes(finalNotes);
      setQuickNote("");
      if (!isNew && activityOutcome) {
        const { error: activityError } = await supabase.from("lead_activities").insert({
          lead_id: lead!.id,
          client_id: lead!.client_id,
          activity_type: activityType,
          outcome: activityOutcome,
          note: activityNote.trim() || null,
          next_action_date: nextAction.trim() || null,
          created_by: meName?.trim() || null,
        });
        if (activityError) {
          setErr("Lead salvato, ma lo storico attività non è stato registrato: " + activityError.message);
          return;
        }
      }
      // L'autore dell'eventuale cambio fase lo registra il database stesso
      // (trigger record_stage_event): niente aggiornamento manuale qui.
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

          {!isNew && (
            <div className="activity-box">
              <b>Registra attività</b>
              <p>Compilala dopo ogni contatto: alimenta il tuo controllo giornaliero.</p>
              <div className="modal-row">
                <div className="field" style={{ flex: 1 }}>
                  <label>Tipo</label>
                  <select value={activityType} onChange={(e) => setActivityType(e.target.value)}>
                    <option value="call">Chiamata</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="meeting">Appuntamento</option>
                    <option value="follow_up">Follow-up</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>Esito</label>
                  <select value={activityOutcome} onChange={(e) => setActivityOutcome(e.target.value)}>
                    <option value="">— non registrare —</option>
                    <option value="Risposto">Risposto</option>
                    <option value="Non risponde">Non risponde</option>
                    <option value="Interessato">Interessato</option>
                    <option value="Non interessato">Non interessato</option>
                    <option value="Appuntamento fissato">Appuntamento fissato</option>
                    <option value="Appuntamento svolto">Appuntamento svolto</option>
                    <option value="No show">No show</option>
                  </select>
                </div>
              </div>
              {activityOutcome && (
                <div className="field">
                  <label>Nota sull'attività (facoltativa)</label>
                  <input value={activityNote} onChange={(e) => setActivityNote(e.target.value)} placeholder="es. richiamare dopo le 18" />
                </div>
              )}
            </div>
          )}
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
                disabled={!canReassign}
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
          {!isNew && (
            <div className="field">
              <label>Aggiungi nota (con data e ora automatiche)</label>
              <input
                value={quickNote}
                onChange={(e) => setQuickNote(e.target.value)}
                placeholder="es. richiamato: vuole essere ricontattato venerdì"
              />
              <small style={{ color: "var(--muted)" }}>
                Finisce in cima allo storico qui sotto, con data e ora, e la card
                conta come lead lavorato oggi.
              </small>
            </div>
          )}
          <div className="field">
            <label>Note (storico chiamate, esito, ecc.)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {!isNew && canDelete && (
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
                    {c.client_data &&
                      (() => {
                        try {
                          const data = JSON.parse(c.client_data);
                          const keys = Object.keys(data).filter(
                            (k) => String(data[k] ?? "").trim()
                          );
                          if (keys.length)
                            return (
                              <div className="contract-meta" style={{ marginTop: 4 }}>
                                {keys.map((k) => (
                                  <div key={k}>
                                    {k}: <b>{String(data[k])}</b>
                                  </div>
                                ))}
                              </div>
                            );
                        } catch {
                          return null;
                        }
                      })()}
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
                    {c.status === "signed" && (
                      <button
                        className="btn small"
                        onClick={() => openSignedContractPdf(c)}
                      >
                        📄 Scarica PDF firmato
                      </button>
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
