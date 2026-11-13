const ORIGIN = 'https://crm-estetica-premium.vercel.app';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A fragment (#/firma/...) is never sent to link-preview crawlers. This read-only
// page exposes just the title and brand image, then opens the existing signing UI.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).send('Metodo non consentito');
  }
  const token = req.query.token;
  if (typeof token !== 'string' || !UUID.test(token)) return res.status(404).send('Link non disponibile');
  const url = process.env.VITE_SUPABASE_URL || "https://mvujbtygcmowkbvoqcgp.supabase.co";
  // Same public anon fallback as the CRM; no privileged credentials.
  const key = process.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12dWpidHlnY21vd2tidm9xY2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MzQ3MDMsImV4cCI6MjEwMzAxMDcwM30.Xk3CUy-3ESAuHvTAQRDtDrrAN4iTQlhQ2pYc9Lb_PSw";
  if (!url || !key) return res.status(503).send('Documento temporaneamente non disponibile');
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/get_contract_by_token?select=title`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return res.status(503).send('Documento temporaneamente non disponibile');
    const rows = await response.json();
    const contract = Array.isArray(rows) ? rows[0] : null;
    // The existing RPC enforces expiry and revocation; do not bypass those checks.
    if (!contract || typeof contract.title !== 'string') return res.status(404).send('Link non disponibile');
    const title = escapeHtml(contract.title);
    const description = 'Estetica Premium · Consulta il contratto e completa la firma online.';
    const target = `/#/firma/${token}`;
    return res.status(200).send(`<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="robots" content="noindex,nofollow,noarchive">
<meta name="description" content="${description}">
<meta property="og:type" content="website"><meta property="og:locale" content="it_IT">
<meta property="og:site_name" content="Estetica Premium"><meta property="og:title" content="${title}">
<meta property="og:description" content="${description}"><meta property="og:url" content="${ORIGIN}/contratto/${token}">
<meta property="og:image" content="${ORIGIN}/estetica-premium-logo.png">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1536"><meta property="og:image:height" content="1004">
<meta property="og:image:alt" content="EP — Estetica Premium">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${ORIGIN}/estetica-premium-logo.png"><link rel="icon" href="/favicon.svg">
<style>body{margin:0;background:#f2ede5;color:#511429;font:18px/1.6 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:680px;padding:32px;text-align:center}img{width:240px;max-width:70%;height:auto}h1{font-size:clamp(24px,5vw,36px);line-height:1.25}a{display:inline-block;background:#511429;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none}a:focus-visible{outline:3px solid #511429;outline-offset:4px}</style>
</head><body><main><img src="/estetica-premium-logo.png" alt="Estetica Premium"><h1>${title}</h1><p>Il documento si sta aprendo.</p><a href="${target}">Apri il contratto</a></main><script>window.location.replace(${JSON.stringify(target)});</script></body></html>`);
  } catch {
    return res.status(503).send('Documento temporaneamente non disponibile');
  }
}
