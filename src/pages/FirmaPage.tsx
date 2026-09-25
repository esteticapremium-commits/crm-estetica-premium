import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { fillBody, isPrivateDeed, isPrivateDeedHeading, openSignedContractPdf, privateDeedClientName, splitContractClosing } from "../contractPdf";

interface ContractPub {
  id: string;
  title: string;
  body: string | null;
  status: string;
  lead_name: string | null;
  signed_name: string | null;
  signed_at: string | null;
  signature_data: string | null;
  client_fields: string | null;
  client_data: string | null;
}

// slug/fillBody sono in ../contractPdf (confronto tollerante agli accenti).

/**
 * Pagina PUBBLICA di firma: il cliente compila i suoi dati, legge il
 * contratto (con i trattini dove va ogni risposta), disegna la firma e
 * conferma. Dopo la firma può scaricare il PDF compilato.
 */
export default function FirmaPage({ token }: { token: string }) {
  const [doc, setDoc] = useState<ContractPub | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [specificApproval, setSpecificApproval] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  // Una pressione sul riquadro non e una firma: registriamo almeno un tratto
  // reale prima di consentire la conferma del documento.
  const hasInk = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    supabase
      .rpc("get_contract_by_token", { p_token: token })
      .then(({ data, error }) => {
        if (error) return setErr("Documento non trovato o link non valido.");
        const row = (data as ContractPub[])?.[0];
        if (!row) return setErr("Documento non trovato o link non valido.");
        setDoc(row);
        // L'apertura viene registrata dal database senza raccogliere IP,
        // dispositivo o altri dati personali del firmatario.
        // Le query Supabase partono quando la Promise viene consumata: senza
        // .then() il contatore resterebbe fermo anche se il documento è aperto.
        void supabase.rpc("record_contract_view", { p_token: token }).then(() => undefined);
        document.title = row.title + " — Estetica Premium";
        // La scrittura privata arriva già compilata: il firmatario è la persona
        // indicata nel documento, al lead resta solo da disegnare la firma.
        if (isPrivateDeed(row.body)) setName(privateDeedClientName(row.body));
        if (row.status === "signed") {
          setOk(true);
          try {
            setValues(JSON.parse(row.client_data ?? "{}"));
          } catch {
            setValues({});
          }
        }
      });
  }, [token]);

  const fields = (doc?.client_fields ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  const draftParts = splitContractClosing(fillBody(doc?.body ?? "", fields, values, false));
  const signedParts = splitContractClosing(fillBody(doc?.body ?? "", fields, values, true));
  const deed = isPrivateDeed(doc?.body);
  const deedClientName = deed ? privateDeedClientName(doc?.body) : "";

  function setupCanvas(c: HTMLCanvasElement | null) {
    if (!c || canvasRef.current === c) return;
    canvasRef.current = c;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 480;
    c.width = w * dpr;
    c.height = 160 * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b0b0b";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, 160);
  }

  function pos(e: React.PointerEvent, c: HTMLCanvasElement) {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function down(e: React.PointerEvent) {
    const c = canvasRef.current!;
    drawing.current = true;
    c.setPointerCapture(e.pointerId);
    const { x, y } = pos(e, c);
    const ctx = c.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(x, y);
    lastPoint.current = { x, y };
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const c = canvasRef.current!;
    const { x, y } = pos(e, c);
    const ctx = c.getContext("2d")!;
    ctx.lineTo(x, y);
    ctx.stroke();
    const previous = lastPoint.current;
    if (previous && Math.hypot(x - previous.x, y - previous.y) > 1) {
      hasInk.current = true;
    }
    lastPoint.current = { x, y };
  }
  function up() {
    drawing.current = false;
    lastPoint.current = null;
  }

  /** Apre una finestra con SOLO il documento compilato e la stampa:
   *  niente dipendenze dal CSS della pagina, funziona su ogni browser. */
  function downloadPdf() {
    if (!doc) return;
    openSignedContractPdf(doc);
  }

  function clear() {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    hasInk.current = false;
    lastPoint.current = null;
  }

  async function sign() {
    if (!name.trim()) return setErr("Scrivi il tuo nome e cognome.");
    for (const f of fields) {
      if (!(values[f] ?? "").trim()) return setErr(`Compila il campo: ${f}`);
    }
    if (!hasInk.current) {
      return setErr(deed ? "Disegna la firma nel riquadro prima di confermare la scrittura privata." : "Disegna la firma nel riquadro prima di confermare il contratto.");
    }
    if (draftParts.approval && !specificApproval) {
      return setErr("Conferma anche l'approvazione specifica delle clausole indicate nel contratto.");
    }
    const c = canvasRef.current;
    if (!c) return;
    setBusy(true);
    setErr(null);
    const data = deed ? croppedSignature(c) : c.toDataURL("image/png");
    const { error } = await supabase.rpc("sign_contract", {
      p_token: token,
      p_name: name.trim(),
      p_sig: data,
      p_data: JSON.stringify({ ...values, __approvazione_specifica_1341_1342: draftParts.approval ? "accettata" : "non prevista" }),
    });
    if (error) {
      setBusy(false);
      return setErr("Firma non riuscita: " + error.message);
    }
    // Ricarica il documento ORA firmato dal database (con data e firma salvate).
    // Senza questo passaggio, data e firma restano vuote nella copia scaricata,
    // perché "doc" era stato caricato PRIMA della firma.
    const { data: fresh } = await supabase.rpc("get_contract_by_token", {
      p_token: token,
    });
    const row = (fresh as ContractPub[])?.[0];
    if (row) {
      setDoc(row);
    } else {
      // Fallback: aggiorna localmente con ciò che è stato appena firmato.
      setDoc((d) =>
        d
          ? {
              ...d,
              status: "signed",
              signed_name: name.trim(),
              signature_data: data,
              signed_at: new Date().toISOString(),
              client_data: JSON.stringify(values),
            }
          : d
      );
    }
    setBusy(false);
    setOk(true);
  }

  return (
    <div className="firma-page">
      <div className="firma-wrap">
        <div className="firma-card">
          {!doc && !err && <div className="center-msg">Caricamento documento…</div>}
          {err && (
            <div className="firma-body">
              <div className="notice err">{err}</div>
            </div>
          )}

          {doc && ok && (
            <div className="firma-body print-area signing-document">
              {/* Thank you page: appare dopo la firma */}
              <div className="thankyou no-print">
                <div className="thankyou-ic">✓</div>
                <h2 className="thankyou-title">{deed ? "Grazie, scrittura privata firmata!" : "Grazie, contratto firmato!"}</h2>
                <p className="thankyou-sub">
                  {doc.signed_name} ·{" "}
                  {doc.signed_at
                    ? new Date(doc.signed_at).toLocaleString("it-IT", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : ""}
                </p>
                <button
                  className="btn primary thankyou-dl"
                  onClick={downloadPdf}
                >
                  {deed ? "📄 Scarica la scrittura privata firmata (PDF)" : "📄 Scarica il contratto firmato (PDF)"}
                </button>
                <p className="thankyou-note">
                  Il documento qui sotto è quello firmato: lo ricevi completo di
                  dati, data e firma.
                </p>
              </div>

              {/* Riepilogo dati + data firma, sempre nel documento/PDF */}
              <div className="firma-recap">
                <div className="recap-title">{deed ? "Estremi della firma" : "Dati dichiarati dal firmatario"}</div>
                <table className="recap-table">
                  <tbody>
                    {fields.map((f) => (
                      <tr key={f}>
                        <td>{f}</td>
                        <td><b>{values[f] || "—"}</b></td>
                      </tr>
                    ))}
                    <tr>
                      <td>Firmato da</td>
                      <td><b>{doc.signed_name}</b></td>
                    </tr>
                    <tr>
                      <td>Data della firma</td>
                      <td><b>
                        {doc.signed_at
                          ? new Date(doc.signed_at).toLocaleString("it-IT", {
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </b></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <b style={{ display: "block", margin: "16px 0 8px", fontSize: 15 }}>
                {deed ? "La scrittura privata firmata" : "Il contratto firmato"}
              </b>
              {deed ? (
                <><PrivateDeedDocument body={doc.body ?? ""} signedAt={doc.signed_at} /><PrivateDeedSignatureBox signerName={doc.signed_name} signature={doc.signature_data} /></>
              ) : (
                <>
                  <Document body={signedParts.main} />
                  <ContractSignatureBox values={values} signedName={doc.signed_name} signature={doc.signature_data} signedAt={doc.signed_at} />
                  {signedParts.approval && <><Document body={signedParts.approval} plain /><SpecificApprovalSignature signedName={doc.signed_name} signature={doc.signature_data} signedAt={doc.signed_at} /></>}
                </>
              )}
            </div>
          )}

          {doc && !ok && (
            <>
              <div className="firma-brandbar">
                <div className="firma-monogram">EP</div>
                <div><b>Estetica Premium</b><span>{deed ? "Scrittura privata" : "Accordo di collaborazione"}</span></div>
                <small>Documento riservato</small>
              </div>
              <div className="firma-head">
                <div className="firma-title">{deed ? "Scrittura privata" : "Accordo di collaborazione professionale"}</div>
                {deed ? (
                  <div className="firma-sub">{`Deposito cauzionale${deedClientName || doc.lead_name ? ` · Destinata a ${deedClientName || doc.lead_name}` : ""}`}</div>
                ) : doc.lead_name && (
                  <div className="firma-sub">Periodo di prova di 30 giorni · Destinato a {doc.lead_name}</div>
                )}
              </div>
              <div className="firma-body">
                <div className="signing-document">
                {/* 1) prima i campi da compilare */}
                {fields.length > 0 && (
                  <div className="client-fields">
                    <div className="firma-step"><span>01</span><div><b>Verifica i dati aziendali</b><small>Servono per completare correttamente l’accordo.</small></div></div>
                    {fields.map((f) => (
                      <div className="field" key={f} style={{ marginBottom: 8 }}>
                        <label>{f}</label>
                        <input
                          value={values[f] ?? ""}
                          onChange={(e) =>
                            setValues((prev) => ({ ...prev, [f]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* 2) poi il contratto, con i trattini dove va ogni risposta */}
                {deed ? (
                  <>
                    <div className="firma-step document-step"><span>01</span><div><b>Leggi la scrittura privata</b><small>È già compilata: controlla che i tuoi dati siano corretti prima di firmare.</small></div></div>
                    <PrivateDeedDocument body={doc.body ?? ""} />
                    <PrivateDeedSignatureBox signerName={deedClientName} />
                  </>
                ) : (
                  <>
                    <div className="firma-step document-step"><span>02</span><div><b>Leggi l’accordo</b><small>Puoi scorrere il documento prima di firmare.</small></div></div>
                    <Document body={draftParts.main} />
                    <ContractSignatureBox values={values} />
                    {draftParts.approval && <><Document body={draftParts.approval} plain /><SpecificApprovalSignature /></>}
                  </>
                )}

                {/* 3) infine la firma */}
                {deed ? (
                  <div className="firma-step document-step"><span>02</span><div><b>Firma la scrittura privata</b><small>La data della firma verrà inserita automaticamente nel documento.</small></div></div>
                ) : (
                  <div className="firma-step document-step"><span>03</span><div><b>Firma il contratto</b><small>La firma e la data verranno registrate nel documento.</small></div></div>
                )}
                <div className="field" style={{ marginTop: 14 }}>
                  <label>Nome e cognome (firmatario)</label>
                  {deed && deedClientName ? (
                    <input value={name} readOnly aria-readonly="true" title="È il nome indicato nella scrittura privata" style={{ background: "#f7f4f1", color: "#2b2a26" }} />
                  ) : (
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Scrivi qui il tuo nome e cognome"
                    />
                  )}
                </div>
                <div className="field">
                  <label>Firma (disegna qui con il dito o il mouse)</label>
                  <canvas
                    ref={setupCanvas}
                    className="firma-canvas"
                    onPointerDown={down}
                    onPointerMove={move}
                    onPointerUp={up}
                    onPointerLeave={up}
                  />
                  <button
                    type="button"
                    className="link-btn"
                    style={{ marginTop: 6 }}
                    onClick={clear}
                  >
                    Cancella firma
                  </button>
                </div>
                {draftParts.approval && <label className="specific-approval-check"><input type="checkbox" checked={specificApproval} onChange={(event) => setSpecificApproval(event.target.checked)} /><span>Dichiaro di approvare specificamente le clausole richiamate ai sensi degli artt. 1341 e 1342 c.c. La firma disegnata sopra sarà applicata anche al relativo riquadro.</span></label>}
                {err && <div className="notice err">{err}</div>}
                <button
                  className="btn primary"
                  style={{ width: "100%", padding: 13, fontSize: 16 }}
                  onClick={sign}
                  disabled={busy}
                >
                  {busy ? "Registrazione firma…" : deed ? "Conferma e firma" : "Conferma e firma il contratto"}
                </button>
                <p
                  style={{
                    color: "var(--muted)",
                    fontSize: 12,
                    marginTop: 10,
                    textAlign: "center",
                  }}
                >
                  Confermando, accetti il documento e autorizzi la registrazione di
                  data, ora e firma.
                </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ContractSignatureBox({ values, signedName, signature, signedAt }: { values: Record<string, string>; signedName?: string | null; signature?: string | null; signedAt?: string | null }) {
  const company = values["Ragione sociale del committente"] || "____________________________";
  const signer = signedName || values["Rappresentante legale del committente"] || "____________________________";
  const date = signedAt ? new Date(signedAt).toLocaleDateString("it-IT") : "____________________________";
  return (
    <div className="contract-signature-box">
      <div className="signature-cell"><b>Committente</b><span>Nome</span><strong>{signer}</strong><span>Ragione sociale</span><strong>{company}</strong><span>Firma</span>{signature ? <img className="firma-preview" src={signature} alt="Firma del committente" /> : <i /> }<span>Data</span><strong>{date}</strong></div>
      <div className="signature-cell collaborator"><b>Collaboratore</b><span>Nome</span><strong>Ettore Androsoni</strong><span>Ragione sociale</span><strong>AI BUSINESS REVOLUTION</strong><span>Firma</span><img src="/ettore-androsoni-signature.png" alt="Firma di Ettore Androsoni" /><span>Data</span><strong>{date}</strong></div>
    </div>
  );
}

function SpecificApprovalSignature({ signedName, signature, signedAt }: { signedName?: string | null; signature?: string | null; signedAt?: string | null }) {
  const date = signedAt ? new Date(signedAt).toLocaleDateString("it-IT") : "____________________________";
  return <div className="specific-approval-signature"><div><b>Approvazione specifica del Committente</b><p>La stessa firma apposta al contratto si riferisce anche alle clausole sopra espressamente richiamate.</p><span>Firmato da</span><strong>{signedName || "____________________________"}</strong><span>Data</span><strong>{date}</strong></div>{signature ? <img className="firma-preview" src={signature} alt="Firma del committente per approvazione specifica" /> : <i>La firma sarà riportata qui dopo la conferma.</i>}</div>;
}

/** Ritaglia la firma sul tratto disegnato (con un piccolo margine): nel
 *  riquadro e nel PDF la firma occupa lo spazio, invece di restare piccola in
 *  mezzo al bianco dell'area di disegno. */
function croppedSignature(canvas: HTMLCanvasElement) {
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (pixels[i] < 200 || pixels[i + 1] < 200 || pixels[i + 2] < 200) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return canvas.toDataURL("image/png");
  const pad = Math.round(8 * (window.devicePixelRatio || 1));
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const out = document.createElement("canvas");
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** Scrittura privata: testo già compilato, intestazioni in maiuscolo centrate
 *  e data della firma in fondo, come nel modello cartaceo. */
function PrivateDeedDocument({ body, signedAt }: { body: string; signedAt?: string | null }) {
  const date = signedAt ? new Date(signedAt).toLocaleDateString("it-IT") : "________________";
  const lines = fillBody(body, [], {}, true).split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <div className="firma-doc">
      {lines.map((line, i) =>
        isPrivateDeedHeading(line) ? (
          <p key={i} style={{ margin: i === 0 ? "0 0 10px" : "16px 0 8px", textAlign: "center", fontWeight: 700, letterSpacing: 0.4, fontSize: i === 0 ? 17 : undefined }}>{line}</p>
        ) : (
          <p key={i} style={{ margin: "6px 0" }}>{line}</p>
        )
      )}
      <p style={{ margin: "22px 0 0" }}>DATA <b>{date}</b></p>
    </div>
  );
}

/** Firme della scrittura privata: quella del Prestatore è già apposta, quella
 *  del cliente compare dopo la conferma. */
function PrivateDeedSignatureBox({ signerName, signature }: { signerName?: string | null; signature?: string | null }) {
  const cellStyle = { minHeight: 0, alignContent: "start" } as const;
  return (
    <div className="contract-signature-box">
      <div className="signature-cell" style={cellStyle}><b>FIRMA CLIENTE</b><span>Nome</span><strong>{signerName || "____________________________"}</strong><span>Firma</span>{signature ? <img className="firma-preview" src={signature} alt="Firma del cliente" /> : <i />}</div>
      <div className="signature-cell collaborator" style={cellStyle}><b>FIRMA PRESTATORE</b><span>Nome</span><strong>AI BUSINESS REVOLUTION</strong><span>Legale rappresentante</span><strong>Ettore Androsoni</strong><span>Firma</span><img src="/ettore-androsoni-signature.png" alt="Firma di Ettore Androsoni" /></div>
    </div>
  );
}

/** Il contratto in stile documento (carta bianca, intestazione serif). */
function Document({ body, plain = false }: { body: string; plain?: boolean }) {
  const lines = body.split("\n");
  return (
    <div className="firma-doc">
      {lines.map((line, i) => {
        const t = line.trim();
        if (t === "")
          return <div key={i} style={{ height: 10 }} />;
        // le prime due righe sono l'intestazione (agenzia + tipo contratto)
        if (!plain && i === 0)
          return (
            <div key={i} className="doc-company">
              {t}
            </div>
          );
        if (!plain && i === 1)
          return (
            <div key={i} className="doc-type">
              {t}
            </div>
          );
        if (!plain && i === 2)
          return (
            <div key={i} className="doc-variant">
              {t}
            </div>
          );
        return (
          <p key={i} style={{ margin: "6px 0" }}>
            {t}
          </p>
        );
      })}
    </div>
  );
}
