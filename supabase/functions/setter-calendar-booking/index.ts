import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CRM = "https://crm-estetica-premium.vercel.app";
const CALENDAR = "ettoreandrosoni@estetica-premium.it";
const EVENTS = `/calendars/${encodeURIComponent(CALENDAR)}/events`;
const TIME_ZONE = "Europe/Rome";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const calendarError = "Impossibile verificare Google Calendar del titolare. Riprova tra poco.";
const uncertain = "Prenotazione in corso di verifica. Riprova sullo stesso orario.";
const occupied = "Questo orario è occupato. Scegli un altro orario.";

type Reservation = {
  owner_id?: string;
  request_id?: string;
  lease_until?: string;
  title?: string;
  busy?: boolean;
  booked?: boolean;
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": CRM, "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    },
  });
}

function boundedFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(7_000) });
}

async function accessToken(refreshToken: string) {
  const response = await boundedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET") ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error(calendarError);
  const token = (await response.json()).access_token;
  if (typeof token !== "string" || !token) throw new Error(calendarError);
  return token;
}

function calendarFetch(token: string, path: string, method = "GET", body?: unknown) {
  return boundedFetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function isAvailable(token: string, start: string, end: string) {
  const response = await calendarFetch(token, "/freeBusy", "POST", {
    timeMin: start, timeMax: end, timeZone: TIME_ZONE, items: [{ id: CALENDAR }],
  });
  if (!response.ok) throw new Error(calendarError);
  const calendar = (await response.json()).calendars?.[CALENDAR];
  if (calendar?.errors?.length || !Array.isArray(calendar?.busy)) throw new Error(calendarError);
  return calendar.busy.length === 0;
}

function matchesBooking(event: any, id: string, start: string, end: string) {
  return event?.id === id && event.status !== "cancelled" &&
    event.extendedProperties?.shared?.epAppointmentId === id &&
    event.organizer?.email?.toLowerCase() === CALENDAR &&
    Date.parse(event.start?.dateTime) === Date.parse(start) &&
    Date.parse(event.end?.dateTime) === Date.parse(end);
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return reply({});
  if (request.method !== "POST") return reply({ error: "Metodo non consentito" }, 405);
  const signal = AbortSignal.timeout(20_000);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const auth = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
    const jwt = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!jwt) return reply({ error: "Sessione CRM non valida" }, 401);
    const { data: { user }, error: authError } = await auth.auth.getUser(jwt);
    if (authError || !user) return reply({ error: "Sessione CRM non valida" }, 401);

    const payload = await request.json().catch(() => null);
    const booking = payload?.action === "book";
    const startMs = typeof payload?.start === "string" ? Date.parse(payload.start) : NaN;
    if ((!booking && payload?.action !== "availability") ||
      typeof payload.contactId !== "string" || !UUID.test(payload.contactId) ||
      typeof payload.databaseContact !== "boolean" || !Number.isFinite(startMs) || startMs <= Date.now() ||
      (booking && (!UUID.test(payload.requestId ?? "") || typeof payload.recordCall !== "boolean" ||
        typeof payload.note !== "string" || payload.note.length > 3000))) {
      return reply({ error: "Dati della Discovery non validi." }, 400);
    }
    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + 30 * 60_000).toISOString();
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal }) },
    });
    const context = await admin.rpc("prepare_setter_calendar_booking", {
      p_setter_id: user.id, p_contact_id: payload.contactId, p_database_contact: payload.databaseContact,
      p_starts_at: start, p_request_id: booking ? payload.requestId : null,
    });
    if (context.error) return reply({ error: context.error.code === "P0001" ? context.error.message : calendarError }, 409);
    const reservation = context.data as Reservation;
    if (reservation.booked) return reply({ booked: true });
    if (reservation.busy) return booking
      ? reply({ error: "C’è una prenotazione in corso per questo lead o questo orario. Riprova tra poco." }, 409)
      : reply({ available: false });
    const leaseId = reservation.request_id;
    const leaseUntil = reservation.lease_until;
    const release = async () => {
      if (leaseId && leaseUntil) {
        await admin.from("setter_calendar_reservations").delete().eq("id", leaseId).eq("lease_until", leaseUntil);
      }
    };
    const { data: connection } = await admin.from("google_calendar_connections").select("refresh_token")
      .eq("user_id", reservation.owner_id!).maybeSingle();
    if (!connection?.refresh_token) {
      return reply({ error: "Google Calendar del titolare non è collegato." }, 503);
    }
    const token = await accessToken(connection.refresh_token);
    if (!booking) {
      if (leaseId) {
        const eventId = leaseId.replaceAll("-", "");
        const matching = await calendarFetch(token, `${EVENTS}/${eventId}`);
        if (matching.ok && matchesBooking(await matching.json(), eventId, start, end)) return reply({ available: true });
      }
      return reply({ available: await isAvailable(token, start, end) });
    }
    if (!leaseId || !leaseUntil) return reply({ error: uncertain }, 503);

    const eventId = leaseId.replaceAll("-", "");
    const eventPath = `${EVENTS}/${eventId}`;
    let event: unknown;
    const existing = await calendarFetch(token, eventPath);
    if (existing.ok) {
      event = await existing.json();
    } else if (existing.status === 404) {
      if (!await isAvailable(token, start, end)) {
        await release();
        return reply({ available: false, error: occupied }, 409);
      }
      const marked = await admin.from("setter_calendar_reservations").update({ event_pending: true })
        .eq("id", leaseId).eq("lease_until", leaseUntil).select("id").single();
      if (marked.error) return reply({ error: uncertain }, 503);
      signal.throwIfAborted();
      const created = await calendarFetch(token, `${EVENTS}?conferenceDataVersion=1&sendUpdates=none`, "POST", {
        id: eventId, summary: reservation.title, colorId: "9",
        start: { dateTime: start, timeZone: TIME_ZONE }, end: { dateTime: end, timeZone: TIME_ZONE },
        extendedProperties: { shared: { epAppointmentId: eventId } },
        conferenceData: { createRequest: { requestId: eventId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
      });
      if (created.ok) {
        event = await created.json();
      } else if (created.status === 409) {
        const retried = await calendarFetch(token, eventPath);
        if (retried.ok) event = await retried.json();
      } else if ([400, 401, 403, 404].includes(created.status)) {
        await release();
        return reply({ error: "Google Calendar non ha accettato la Discovery. Riprova." }, 503);
      }
    }
    if (!matchesBooking(event, eventId, start, end)) return reply({ error: uncertain }, 503);

    const saved = await admin.rpc("finish_setter_calendar_booking", {
      p_request_id: leaseId, p_lease_until: leaseUntil, p_note: payload.note.trim() || null, p_record_call: payload.recordCall,
    });
    if (saved.data?.booked) return reply({ booked: true });
    if (saved.data?.rejected) {
      const removed = await calendarFetch(token, `${eventPath}?sendUpdates=none`, "DELETE");
      if (removed.ok || removed.status === 404 || removed.status === 410) {
        await release();
        return reply({ error: saved.data.rejected }, 409);
      }
    }
    return reply({ error: uncertain }, 503);
  } catch {
    return reply({ error: calendarError }, 503);
  }
});
