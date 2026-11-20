import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OWNER_ID = "cc9de596-9011-4d70-b3f5-4c5e49f6cec3";
const SELLER_ID = "fea14cde-316f-4519-bad0-abb9d9208df7";
const CLIENT_ID = "fae0d66c-0e93-4e5e-b6f1-82ad0c47674c";
const CALENDAR_ID = "ettoreandrosoni@estetica-premium.it";
const CALENDAR_PATH = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;
const CRM_URL = "https://crm-estetica-premium.vercel.app";
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const TIME_ZONE = "Europe/Rome";
const normalizeName = (name: string | null) => name?.trim().toLowerCase().replaceAll("’", "'");

type GoogleEvent = {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  organizer?: { email?: string };
  extendedProperties?: { shared?: { epAppointmentId?: string } };
  start?: { dateTime?: string };
  end?: { dateTime?: string };
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": CRM_URL, "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
      "Content-Type": "application/json", "Cache-Control": "no-store",
    },
  });
}

async function refreshCalendarToken(refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(6000),
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET") ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) return null;
  const { access_token } = await response.json();
  return typeof access_token === "string" ? access_token : null;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return reply({});
  if (request.method !== "POST") return reply({ error: "Metodo non consentito." }, 405);
  try {
    const authorization = request.headers.get("authorization") ?? "";
    const jwt = authorization.match(/^Bearer (\S+)$/i)?.[1];
    if (!jwt) return reply({ error: "Sessione CRM non valida." }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } }, auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser(jwt);
    if (authError || !user) return reply({ error: "Sessione CRM non valida." }, 401);
    if (user.id !== OWNER_ID && user.id !== SELLER_ID) return reply({ error: "Accesso non autorizzato." }, 403);
    const { taskId, operation, expectedUpdatedAt } = await request.json().catch(() => ({}));
    if (!UUID.test(taskId ?? "") || (operation !== "sync" && operation !== "delete")) {
      return reply({ error: "Richiesta non valida." }, 400);
    }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const [taskResult, roles] = await Promise.all([
      authClient.from("sales_tasks").select("id,created_by,updated_at,title,due_at,appointment_status,completed_at,google_event_id")
        .eq("id", taskId).eq("client_id", CLIENT_ID).eq("appointment_type", "discovery").eq("commercial_tracked", true).maybeSingle(),
      admin.from("profiles").select("id,role,client_id,full_name").in("id", [OWNER_ID, SELLER_ID]),
    ]);
    const seller = roles.data?.find(person => person.id === SELLER_ID && person.role === "venditore" && person.client_id === CLIENT_ID);
    const owner = roles.data?.find(person => person.id === OWNER_ID && person.role === "admin");
    const task = taskResult.data;
    if (!owner || !seller?.full_name || !task || normalizeName(task.created_by) !== normalizeName(seller.full_name)) {
      return reply({ error: "Discovery non accessibile." }, 404);
    }
    if (operation === "delete" && (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt !== task.updated_at)) {
      return reply({ error: "Appuntamento aggiornato. Riapri la scheda." }, 409);
    }
    if (operation === "sync" && (task.completed_at || !["scheduled", "rescheduled"].includes(task.appointment_status))) {
      return reply({ error: "La Discovery non è più da svolgere." }, 409);
    }

    const legacyId = task.id.replaceAll("-", "");
    const managedId = `epd${legacyId}`;
    if (task.google_event_id && task.google_event_id !== managedId) {
      return reply({ error: "La Discovery è collegata a un altro calendario." }, 409);
    }
    const { data: connection } = await admin.from("google_calendar_connections").select("refresh_token")
      .eq("user_id", OWNER_ID).maybeSingle();
    const token = connection?.refresh_token && await refreshCalendarToken(connection.refresh_token);
    if (!token) return reply({ error: "Il collegamento Google Calendar di Ettore va rinnovato." }, 503);

    function google(path: string, method = "GET", body?: unknown, etag?: string) {
      return fetch(`${CALENDAR_PATH}${path}`, {
        method, signal: AbortSignal.timeout(6000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function getEvent(id: string): Promise<GoogleEvent | null> {
      const response = await google(`/${id}`);
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new Error("Google Calendar non raggiungibile.");
      return response.json();
    }
    const belongsToTask = (event: GoogleEvent, id: string) =>
      event.id === id && event.extendedProperties?.shared?.epAppointmentId === id;
    const isManaged = (event: GoogleEvent) => belongsToTask(event, managedId) &&
      event.organizer?.email?.toLowerCase() === CALENDAR_ID;

    let event = await getEvent(managedId);
    if (event && event.status !== "cancelled" && !isManaged(event)) {
      return reply({ error: "L’evento Google non corrisponde alla Discovery." }, 409);
    }
    if (operation === "delete") {
      if (event && event.status !== "cancelled") {
        if (!event.etag) return reply({ error: "Evento Google da verificare." }, 409);
        const removed = await google(`/${managedId}?sendUpdates=none`, "DELETE", undefined, event.etag);
        if (!removed.ok && removed.status !== 404 && removed.status !== 410) {
          return reply({ error: "Google Calendar non ha eliminato l’appuntamento." }, 409);
        }
      }
      return reply({ synced: true });
    }

    const startsAt = new Date(task.due_at);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const timeMatches = (item: GoogleEvent) => Date.parse(item.start?.dateTime ?? "") === startsAt.getTime() &&
      Date.parse(item.end?.dateTime ?? "") === endsAt.getTime();
    const timing = {
      summary: task.title, start: { dateTime: startsAt.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: endsAt.toISOString(), timeZone: TIME_ZONE },
    };
    if (!event && !task.google_event_id) {
      const original = await getEvent(legacyId);
      if (original && original.status !== "cancelled" && belongsToTask(original, legacyId)) {
        if (!timeMatches(original)) return reply({ error: "Su Google c’è già la stessa Discovery con un orario diverso. Verifica l’evento esistente." }, 409);
        event = original;
      } else if (startsAt.getTime() > Date.now()) {
        const { data } = await admin.auth.admin.getUserById(SELLER_ID);
        const sellerEmail = data.user?.email;
        const created = await google("?conferenceDataVersion=1&sendUpdates=none", "POST", {
          ...timing, id: managedId, colorId: "9",
          attendees: sellerEmail ? [{ email: sellerEmail }] : undefined,
          extendedProperties: { shared: { epAppointmentId: managedId } },
          conferenceData: { createRequest: { requestId: managedId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
        });
        if (created.ok) event = await created.json();
        else if (created.status === 409) event = await getEvent(managedId);
      }
    }
    if (!event?.id || event.status === "cancelled") return reply({ error: "Google Calendar non ha confermato l’evento." }, 503);
    if (event.id === managedId) {
      if (!isManaged(event)) return reply({ error: "L’evento Google non corrisponde alla Discovery." }, 409);
      if (!timeMatches(event) || event.summary !== task.title) {
        if (!event.etag) return reply({ error: "Evento Google da verificare." }, 409);
        const changed = await google(`/${managedId}?conferenceDataVersion=1&sendUpdates=none`, "PATCH", timing, event.etag);
        if (!changed.ok) return reply({ error: "Google Calendar non ha accettato il nuovo orario." }, 409);
      }
    }

    if (!task.google_event_id) {
      const linked = await authClient.from("sales_tasks").update({ google_event_id: event.id })
        .eq("id", task.id).eq("updated_at", task.updated_at).is("google_event_id", null).select("id").maybeSingle();
      if (!linked.data) {
        const current = await authClient.from("sales_tasks").select("google_event_id,title,due_at").eq("id", task.id).maybeSingle();
        if (current.data?.google_event_id !== event.id || current.data.title !== task.title || current.data.due_at !== task.due_at) {
          return reply({ error: "Appuntamento aggiornato nel frattempo. Riprova a sincronizzarlo." }, 409);
        }
      }
    }
    return reply({ synced: true });
  } catch {
    return reply({ error: "Google Calendar di Ettore non è raggiungibile. Riprova." }, 503);
  }
});
