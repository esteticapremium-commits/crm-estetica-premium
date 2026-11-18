import { createClient } from "npm:@supabase/supabase-js@2";

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const productionOrigin = "https://crm-estetica-premium.vercel.app";

Deno.serve(async (request) => {
  const headers = {
    "Access-Control-Allow-Origin": productionOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
  const reply = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { headers, status });
  if (request.method === "OPTIONS") return new Response(null, { headers, status: 204 });
  if (request.method !== "POST") return reply({ error: "Metodo non consentito." }, 405);
  const body = await request.json().catch(() => null);
  const token = body?.token;
  const password = body?.password;
  if (typeof token !== "string" || !uuid.test(token) || typeof password !== "string" ||
    password.length < 12 || new TextEncoder().encode(password).length > 72) {
    return reply({ error: "Link non valido o password fuori dai limiti (da 12 a 72 byte)." }, 400);
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return reply({ error: "Attivazione temporaneamente non disponibile." }, 503);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: enrollment, error } = await admin.rpc("resolve_setter_activation", { p_token: token });
  if (error) return reply({ error: "Attivazione temporaneamente non disponibile." }, 503);
  if (!enrollment?.id || !enrollment.email) return reply({ error: "Link scaduto, revocato o già utilizzato. Se hai già attivato l’accesso, entra dal login." }, 410);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.toLowerCase()));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const result = await admin.auth.admin.createUser({
    email: enrollment.email, password, email_confirm: true,
    app_metadata: { ep_setter_request: enrollment.id, ep_setter_activation: hash },
  });
  if (result.error || !result.data.user) {
    return reply({ error: "Attivazione non completata. Se hai già attivato l’accesso, prova il login; altrimenti chiedi un nuovo link al titolare." }, 409);
  }
  return reply({ ok: true });
});
