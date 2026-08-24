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

/**
 * Pagina PUBBLICA di firma: il cliente apre il link ricevuto dal venditore,
 * compila nome e cognome, disegna la firma (dito o mouse) e conferma.
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
        if (row.status === "signed") setOk(true);
      });
  }, [token]);

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
    const fields = (doc?.client_fields ?? "")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
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
    <div className="app theme-premium">
      <div className="firma-wrap">
        <div className="firma-card">
          {!doc && !err && <div className="center-msg">Caricamento documento…</div>}
          {err && (
            <div className="firma-body">
              <div className="notice err">{err}</div>
            </div>
          )}
          {doc && ok && (
            <div className="firma-body">
              <div className="notice ok" style={{ fontSize: 15 }}>
                ✓ Documento già firmato
              </div>
              <h2 style={{ marginTop: 6 }}>{doc.title}</h2>
              <p style={{ color: "var(--muted)" }}>
                Firmato da <b style={{ color: "var(--ink)" }}>{doc.signed_name}</b> il{" "}
                {doc.signed_at ? new Date(doc.signed_at).toLocaleString("it-IT") : ""}
              </p>
              {doc.signature_data && (
                <img
                  src={doc.signature_data}
                  alt="firma"
                  className="firma-preview"
                />
              )}
              {doc.client_data && (() => {
                try {
                  const data = JSON.parse(doc.client_data);
                  const keys = Object.keys(data);
                  if (keys.length) {
                    return (
                      <div className="client-data" style={{ margin: "12px 0" }}>
                        <b style={{ display: "block", marginBottom: 6 }}>
                          Dati dichiarati dal firmatario
                        </b>
                        {keys.map((k) => (
                          <div key={k} style={{ fontSize: 13, margin: "2px 0" }}>
                            <span style={{ color: "var(--muted)" }}>{k}: </span>
                            <b>{String(data[k])}</b>
                          </div>
                        ))}
                      </div>
                    );
                  }
                } catch {
                  return null;
                }
              })()}
              <DocumentBody body={doc.body} />
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
                <DocumentBody body={doc.body} />
                {(doc.client_fields ?? "").trim() && (
                  <div className="client-fields">
                    <b style={{ display: "block", marginBottom: 6 }}>
                      I tuoi dati (richiesti)
                    </b>
                    {(doc.client_fields ?? "")
                      .split("\n")
                      .map((f) => f.trim())
                      .filter(Boolean)
                      .map((f) => (
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
                <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 10, textAlign: "center" }}>
                  Confermando, accetti il documento e autorizzi la registrazione
                  di data, ora e firma.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DocumentBody({ body }: { body: string | null }) {
  if (!body) return null;
  return (
    <div className="firma-doc">
      {body.split("\n").map((line, i) =>
        line.trim() === "" ? (
          <div key={i} style={{ height: 10 }} />
        ) : (
          <p key={i} style={{ margin: "4px 0" }}>
            {line}
          </p>
        )
      )}
    </div>
  );
}
