import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabaseClient";

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

/** slug di un campo (es. "Sede legale (via e città)" -> "sede_legale_via_e_città") */
function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Sostituisce i segnaposto dei campi cliente con trattini (da compilare)
 *  o con i valori (documento firmato). */
function fillBody(body: string, fields: string[], values: Record<string, string>, signed: boolean) {
  let out = body;
  for (const f of fields) {
    const sl = slug(f);
    const val = signed ? values[f] ?? "" : "";
    out = out.split(`{{${sl}}}`).join(signed ? val || "—" : "________________________________________");
  }
  // eventuali segnaposto rimasti
  out = out.replace(/\{\{[^}]+\}\}/g, "________");
  return out;
}

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  useEffect(() => {
    supabase
      .rpc("get_contract_by_token", { p_token: token })
      .then(({ data, error }) => {
        if (error) return setErr("Documento non trovato o link non valido.");
        const row = (data as ContractPub[])?.[0];
        if (!row) return setErr("Documento non trovato o link non valido.");
        setDoc(row);
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
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const c = canvasRef.current!;
    const { x, y } = pos(e, c);
    const ctx = c.getContext("2d")!;
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  function up() {
    drawing.current = false;
  }

  function clear() {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
  }

  async function sign() {
    if (!name.trim()) return setErr("Scrivi il tuo nome e cognome.");
    for (const f of fields) {
      if (!(values[f] ?? "").trim()) return setErr(`Compila il campo: ${f}`);
    }
    const c = canvasRef.current;
    if (!c) return;
    setBusy(true);
    setErr(null);
    const data = c.toDataURL("image/png");
    const { error } = await supabase.rpc("sign_contract", {
      p_token: token,
      p_name: name.trim(),
      p_sig: data,
      p_data: JSON.stringify(values),
    });
    setBusy(false);
    if (error) return setErr("Firma non riuscita: " + error.message);
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
            <div className="firma-body print-area">
              {/* Thank you page: appare dopo la firma */}
              <div className="thankyou no-print">
                <div className="thankyou-ic">✓</div>
                <h2 className="thankyou-title">Grazie, contratto firmato!</h2>
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
                  onClick={() => window.print()}
                >
                  📄 Scarica il contratto firmato (PDF)
                </button>
                <p className="thankyou-note">
                  Il documento qui sotto è quello firmato: lo ricevi completo di
                  dati, data e firma.
                </p>
              </div>

              {/* Riepilogo dati + data firma, sempre nel documento/PDF */}
              <div className="firma-recap">
                <div className="recap-title">Dati dichiarati dal firmatario</div>
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
                Il contratto firmato
              </b>
              <Document body={fillBody(doc.body ?? "", fields, values, true)} />
              <div className="firma-signatures">
                <div>
                  <div className="sig-label">Il firmatario</div>
                  <div className="sig-name">{doc.signed_name}</div>
                  {doc.signature_data && (
                    <img src={doc.signature_data} alt="firma" className="firma-preview" />
                  )}
                </div>
                <div>
                  <div className="sig-label">Data</div>
                  <div className="sig-name">
                    {doc.signed_at
                      ? new Date(doc.signed_at).toLocaleDateString("it-IT")
                      : ""}
                  </div>
                </div>
              </div>
            </div>
          )}

          {doc && !ok && (
            <>
              <div className="firma-head">
                <div className="firma-title">{doc.title}</div>
                {doc.lead_name && (
                  <div className="firma-sub">Destinato a: {doc.lead_name}</div>
                )}
              </div>
              <div className="firma-body">
                {/* 1) prima i campi da compilare */}
                {fields.length > 0 && (
                  <div className="client-fields">
                    <b style={{ display: "block", marginBottom: 8, fontSize: 15 }}>
                      Compila i tuoi dati
                    </b>
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
                <b style={{ display: "block", margin: "16px 0 8px", fontSize: 15 }}>
                  Il contratto
                </b>
                <Document body={fillBody(doc.body ?? "", fields, values, false)} />

                {/* 3) infine la firma */}
                <div className="field" style={{ marginTop: 22 }}>
                  <label>Nome e cognome (firmatario)</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Scrivi qui il tuo nome e cognome"
                  />
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
                {err && <div className="notice err">{err}</div>}
                <button
                  className="btn primary"
                  style={{ width: "100%", padding: 13, fontSize: 16 }}
                  onClick={sign}
                  disabled={busy}
                >
                  {busy ? "Invio firma…" : "Firma e conferma ✓"}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Il contratto in stile documento (carta bianca, intestazione serif). */
function Document({ body }: { body: string }) {
  const lines = body.split("\n");
  return (
    <div className="firma-doc">
      {lines.map((line, i) => {
        const t = line.trim();
        if (t === "")
          return <div key={i} style={{ height: 10 }} />;
        // le prime due righe sono l'intestazione (agenzia + tipo contratto)
        if (i === 0)
          return (
            <div key={i} className="doc-company">
              {t}
            </div>
          );
        if (i === 1)
          return (
            <div key={i} className="doc-type">
              {t}
            </div>
          );
        if (i === 2)
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
