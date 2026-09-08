import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ALLOWED_ORIGINS = new Set([
  "https://crm-estetica-premium.vercel.app",
  "http://localhost:5173",
]);

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://crm-estetica-premium.vercel.app";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-requested-with",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
}

function json(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (request.method !== "POST") return json(origin, { error: "Metodo non consentito" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const googleClientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID")!;
  const googleClientSecret = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET")!;
  if (!googleClientId || !googleClientSecret) {
    return json(origin, { error: "Configurazione Google incompleta" }, 503);
  }

  const authorization = request.headers.get("authorization") || "";
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userError } = await authClient.auth.getUser();
  if (userError || !user) return json(origin, { error: "Sessione CRM non valida" }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const payload = await request.json().catch(() => ({}));

  if (payload.action === "exchange") {
    if (request.headers.get("x-requested-with") !== "XmlHttpRequest") {
      return json(origin, { error: "Richiesta non valida" }, 400);
    }
    if (!payload.code || !payload.redirectUri || payload.redirectUri !== origin) {
      return json(origin, { error: "Codice Google non valido" }, 400);
    }

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: payload.code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: payload.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) {
      return json(origin, { error: "Google non ha completato il collegamento" }, 400);
    }

    const { data: previous } = await admin
      .from("google_calendar_connections")
      .select("refresh_token")
      .eq("user_id", user.id)
      .maybeSingle();
    const refreshToken = tokens.refresh_token || previous?.refresh_token;
    if (!refreshToken) {
      return json(origin, { error: "Google non ha rilasciato il rinnovo permanente. Rimuovi l'accesso all'app dal tuo account Google e collegala di nuovo." }, 409);
    }

    const { error: saveError } = await admin.from("google_calendar_connections").upsert({
      user_id: user.id,
      refresh_token: refreshToken,
      scopes: tokens.scope || null,
      connected_at: new Date().toISOString(),
      refreshed_at: new Date().toISOString(),
    });
    if (saveError) return json(origin, { error: "Collegamento non salvato" }, 500);

    return json(origin, {
      accessToken: tokens.access_token,
      expiresIn: Number(tokens.expires_in || 3600),
      persistent: true,
    });
  }

  if (payload.action === "token") {
    const { data: connection, error: connectionError } = await admin
      .from("google_calendar_connections")
      .select("refresh_token")
      .eq("user_id", user.id)
      .maybeSingle();
    if (connectionError || !connection?.refresh_token) {
      return json(origin, { connected: false }, 404);
    }

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: connection.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) {
      return json(origin, { connected: false, error: "Collegamento Google scaduto o revocato" }, 401);
    }

    await admin
      .from("google_calendar_connections")
      .update({ refreshed_at: new Date().toISOString() })
      .eq("user_id", user.id);
    return json(origin, {
      connected: true,
      accessToken: tokens.access_token,
      expiresIn: Number(tokens.expires_in || 3600),
      persistent: true,
    });
  }

  return json(origin, { error: "Azione non valida" }, 400);
});

