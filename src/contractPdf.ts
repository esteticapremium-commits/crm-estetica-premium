// Genera e apre in stampa/PDF il contratto FIRMATO, con dati, data e firma.
// Usata dal CRM (scheda lead) per riscaricare la copia firmata; la stessa
// impaginazione della pagina pubblica di firma.

/** Normalizza un nome campo o un segnaposto: toglie gli accenti (a->a, e->e...),
 *  minuscolo, e ogni carattere non alfanumerico diventa "_". Cosi il campo
 *  "Sede legale (via e citta)" e il segnaposto {{sede_legale_via_e_citta}}
 *  combaciano sempre, a prescindere da accenti e formattazione. */
export function normKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Sostituisce i segnaposto dei campi cliente coi valori (documento firmato)
 *  o coi trattini (documento ancora da compilare). Il confronto tra segnaposto
 *  e nome del campo e tollerante ad accenti e formattazione. */
export function fillBody(
  body: string,
  fields: string[],
  values: Record<string, string>,
  signed: boolean
) {
  const byKey: Record<string, string> = {};
  for (const f of fields) byKey[normKey(f)] = signed ? values[f] ?? "" : "";
  return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, raw: string) => {
    const k = normKey(raw);
    if (k in byKey) {
      return signed
        ? byKey[k] || "—"
        : "________________________________________";
    }
    return "________";
  });
}

/** I valori del firmatario finiscono in un documento HTML stampabile: mai
 * interpolarli senza escape, altrimenti un campo compilato dal cliente può
 * alterare il documento. */
export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface SignedContract {
  title: string;
  body: string | null;
  client_fields: string | null;
  client_data: string | null;
  signed_name: string | null;
  signed_at: string | null;
  signature_data: string | null;
}

/** Apre una finestra col SOLO documento firmato e lancia la stampa/salva PDF. */
export function openSignedContractPdf(c: SignedContract) {
  const fields = (c.client_fields ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  let values: Record<string, string> = {};
  try {
    values = JSON.parse(c.client_data ?? "{}");
  } catch {
    values = {};
  }
  const fullBody = fillBody(c.body ?? "", fields, values, true);
  const rows = fields
    .map((f) => `<tr><td>${escapeHtml(f)}</td><td><b>${escapeHtml(values[f] || "—")}</b></td></tr>`)
    .join("");
  const dataLong = c.signed_at
    ? new Date(c.signed_at).toLocaleString("it-IT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  const dataShort = c.signed_at
    ? new Date(c.signed_at).toLocaleDateString("it-IT")
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${c.title}</title>
<style>
  @page { size: A4; margin: 22mm 18mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 13.5px; line-height: 1.55; }
  .company { text-align: center; font-size: 20px; font-weight: 700; letter-spacing: 1.5px; }
  .type { text-align: center; font-size: 16px; font-weight: 700; }
  .variant { text-align: center; font-style: italic; color: #444; border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 18px; }
  .recap { border: 1px solid #ccc; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; }
  .recap h3 { margin: 0 0 8px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; }
  .recap td { padding: 3px 4px; border-bottom: 1px solid #eee; }
  .recap td:first-child { color: #666; width: 42%; }
  .doc p { margin: 6px 0; white-space: pre-wrap; }
  .signatures { display: flex; gap: 40px; margin-top: 28px; padding-top: 14px; border-top: 1px solid #111; }
  .sig-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666; }
  .sig-name { font-size: 17px; margin: 4px 0 6px; }
  .sig-img { max-width: 340px; max-height: 130px; border: 1px solid #ddd; padding: 4px; background: #fff; }
</style></head><body>
  <div class="company">ESTETICA PREMIUM</div>
  <div class="type">Contratto di collaborazione professionale</div>
  <div class="variant">${escapeHtml(c.title)}</div>
  <div class="recap">
    <h3>Dati dichiarati dal firmatario</h3>
    <table><tbody>
      ${rows}
      <tr><td>Firmato da</td><td><b>${escapeHtml(c.signed_name)}</b></td></tr>
      <tr><td>Data della firma</td><td><b>${dataLong}</b></td></tr>
    </tbody></table>
  </div>
  <div class="doc">${fullBody.split("\n").map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</div>
  <div class="signatures">
    <div>
      <div class="sig-label">Il firmatario</div>
      <div class="sig-name">${escapeHtml(c.signed_name)}</div>
      ${c.signature_data ? `<div style="margin-top:6px"><img class="sig-img" src="${c.signature_data}"/></div>` : ""}
    </div>
    <div>
      <div class="sig-label">Data</div>
      <div class="sig-name">${dataShort}</div>
    </div>
  </div>
  <script>window.onload = function(){ window.print(); }<\/script>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) {
    alert("Il browser ha bloccato la finestra. Consenti i popup per questo sito.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
