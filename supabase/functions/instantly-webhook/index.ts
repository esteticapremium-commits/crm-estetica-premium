import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const EVENT_MAP: Record<string, string> = {
  email_sent: "sent",
  email_opened: "opened",
  email_link_clicked: "opened",
  link_clicked: "opened",
  reply_received: "reply",
  auto_reply_received: "reply",
  email_bounced: "bounced",
  lead_unsubscribed: "unsubscribed",
  lead_interested: "positive_reply",
  lead_meeting_booked: "booking",
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  const expectedSecret = Deno.env.get("INSTANTLY_WEBHOOK_SECRET") || "";
  const supplied = request.headers.get("authorization") || request.headers.get("x-webhook-secret") || "";
  const suppliedSecret = supplied.toLowerCase().startsWith("bearer ") ? supplied.slice(7) : supplied;
  if (!expectedSecret || suppliedSecret !== expectedSecret) return json({ error: "Webhook non autorizzato" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("CRM_CLIENT_ID") || "fae0d66c-0e93-4e5e-b6f1-82ad0c47674c";
  if (!supabaseUrl || !serviceKey) return json({ error: "Configurazione server incompleta" }, 503);

  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return json({ error: "Payload JSON non valido" }, 400);

  const instantType = clean(payload.event_type || payload.eventType || payload.type).toLowerCase();
  const eventType = EVENT_MAP[instantType];
  if (!eventType) return json({ ok: true, ignored: instantType || "unknown" });

  const email = clean(payload.lead_email || payload.email).toLowerCase();
  const occurredAtRaw = clean(payload.timestamp || payload.occurred_at || payload.created_at);
  const occurredAt = occurredAtRaw && !Number.isNaN(Date.parse(occurredAtRaw)) ? new Date(occurredAtRaw).toISOString() : new Date().toISOString();
  const campaignId = clean(payload.campaign_id || payload.campaign) || null;
  const campaignName = clean(payload.campaign_name) || null;
  const suppliedId = clean(payload.id || payload.event_id || payload.webhook_event_id);
  const externalId = suppliedId || await digest([instantType, email, campaignId || "", occurredAt].join("|"));

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  let lead: { id: string; assigned_to: string | null } | null = null;
  if (email) {
    const { data } = await admin.from("leads").select("id, assigned_to").eq("client_id", clientId).ilike("email", email).limit(1).maybeSingle();
    lead = data;
  }

  const outcome = instantType === "lead_interested" ? "positive" : instantType === "auto_reply_received" ? "automatic" : null;
  const { error } = await admin.from("sales_outreach_events").upsert({
    client_id: clientId,
    lead_id: lead?.id || null,
    channel: "instantly",
    event_type: eventType,
    outcome,
    contact_key: email || null,
    campaign_id: campaignId,
    campaign_name: campaignName,
    external_id: `instantly:${externalId}`,
    occurred_at: occurredAt,
    assigned_to: lead?.assigned_to || null,
    created_by: "Instantly",
    details: payload,
  }, { onConflict: "client_id,external_id", ignoreDuplicates: true });

  if (error) return json({ error: "Evento non salvato", detail: error.message }, 500);
  return json({ ok: true, matchedLead: Boolean(lead) });
});
