import { supabase } from "./supabaseClient";

const KEY = "ep-google-calendar-token";
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID as string | undefined;
export const OWNER_CALENDAR_ID = "ettoreandrosoni@estetica-premium.it";
const OWNER_CALENDAR_BLUE = "9";

export type GoogleEvent = { id: string; iCalUID?: string; created?: string; originalStartTime?: { dateTime?: string; date?: string }; summary?: string; description?: string; location?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
type Token = { accessToken: string; expiresAt: number };

function saveToken(accessToken: string, expiresIn = 3600) {
  // Un piccolo margine evita di iniziare una richiesta mentre il token sta
  // scadendo. Il rinnovo vero avviene sul backend con il refresh token.
  localStorage.setItem(KEY, JSON.stringify({
    accessToken,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  }));
  sessionStorage.removeItem(KEY);
}

export async function refreshGoogleCalendarConnection() {
  const { data, error } = await supabase.functions.invoke("google-calendar-oauth", {
    body: { action: "token" },
  });
  if (error || !data?.accessToken) return false;
  saveToken(data.accessToken, Number(data.expiresIn || 3600));
  return true;
}

export function googleCalendarConfigured() { return Boolean(CLIENT_ID); }
export function googleCalendarConnected() {
  try { const stored = localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || "null"; const token = JSON.parse(stored) as Token | null; return Boolean(token && token.expiresAt > Date.now()); } catch { return false; }
}
function token() { try { return JSON.parse(localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || "null") as Token | null; } catch { return null; } }
function loadScript() { return new Promise<void>((resolve, reject) => { if ((window as any).google?.accounts?.oauth2) return resolve(); const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error("Non riesco a caricare Google.")); document.head.appendChild(s); }); }

/** Rinnova in silenzio il token quando l'utente ha già dato il consenso a Google.
 * L'utente deve intervenire solo se ha revocato il consenso o è uscito da Google. */
export async function ensureGoogleCalendarConnection() {
  if (googleCalendarConnected()) return true;
  if (!CLIENT_ID) return false;
  // Prima prova il rinnovo persistente: dopo il primo collegamento non serve
  // più alcun popup, neppure dopo refresh, logout/login o cambio dispositivo.
  if (await refreshGoogleCalendarConnection()) return true;
  return false;
}

/** Il venditore autorizza solo il proprio calendario Google, nel suo browser. */
export async function connectGoogleCalendar() {
  if (!CLIENT_ID) throw new Error("Configurazione Google Calendar mancante.");
  await loadScript();
  return new Promise<void>((resolve, reject) => {
    const client = (window as any).google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID,
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy",
      ux_mode: "popup",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      callback: async (response: any) => {
        if (response.error || !response.code) return reject(new Error(response.error || "Collegamento non riuscito"));
        const { data, error } = await supabase.functions.invoke("google-calendar-oauth", {
          body: { action: "exchange", code: response.code, redirectUri: window.location.origin },
          headers: { "X-Requested-With": "XmlHttpRequest" },
        });
        if (error || !data?.accessToken) {
          return reject(new Error(data?.error || "Collegamento permanente non disponibile."));
        }
        saveToken(data.accessToken, Number(data.expiresIn || 3600));
        resolve();
      },
    });
    client.requestCode();
  });
}
async function googleFetch(path: string, init?: RequestInit) {
  if (!googleCalendarConnected() && !await ensureGoogleCalendarConnection()) throw new Error("Ricollega Google Calendar per continuare.");
  const t = token(); if (!t) throw new Error("Ricollega Google Calendar per continuare.");
  let response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { ...init, headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
  // Se Google invalida anticipatamente un access token, lo rinnoviamo una
  // volta dal backend e ripetiamo la richiesta senza disturbare l'utente.
  if (response.status === 401) {
    localStorage.removeItem(KEY);
    if (await refreshGoogleCalendarConnection()) {
      const renewed = token();
      response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { ...init, headers: { Authorization: `Bearer ${renewed?.accessToken}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
    }
  }
  if (!response.ok) throw Object.assign(new Error("Google Calendar non ha accettato la richiesta."), { status: response.status });
  if (response.status === 204) return null;
  return response.json();
}
export async function createGoogleCalendarEvent(input: { title: string; start: string; end: string; description?: string; attendees?: string[]; eventId?: string; videoConference?: boolean }) {
  const videoConference = input.videoConference !== false;
  const query = new URLSearchParams({ sendUpdates: input.attendees?.length ? "all" : "none" });
  if (videoConference) query.set("conferenceDataVersion", "1");
  const requestId = `ep-${input.eventId || crypto.randomUUID()}`;
  try {
    return await googleFetch(`/calendars/primary/events?${query}`, { method: "POST", body: JSON.stringify({
      id: input.eventId, summary: input.title, description: input.description || "",
      start: { dateTime: input.start, timeZone: "Europe/Rome" }, end: { dateTime: input.end, timeZone: "Europe/Rome" },
      attendees: input.attendees?.map((email) => email.toLowerCase() === OWNER_CALENDAR_ID ? { email, responseStatus: "accepted" } : { email }),
      extendedProperties: input.eventId ? { shared: { epAppointmentId: input.eventId } } : undefined,
      conferenceData: videoConference ? { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } : undefined,
    }) });
  } catch (error) {
    if (!input.eventId || (error as { status?: number })?.status !== 409) throw error;
    return googleFetch(`/calendars/primary/events/${encodeURIComponent(input.eventId)}`);
  }
}
export async function confirmOwnerCalendarAttendance(taskId: string) {
  const { data, error } = await supabase.functions.invoke("google-calendar-oauth", {
    body: { action: "confirm_owner_attendance", taskId },
  });
  if (error || !data?.confirmed) return false;
  return true;
}

export async function confirmOnPrimaryOwnerCalendar(eventId: string, startsAt: string) {
  const path = `/calendars/primary/events/${encodeURIComponent(eventId)}`;
  const event = await googleFetch(path);
  const organizer = event.organizer;
  if (!organizer?.self || organizer.email?.toLowerCase() !== OWNER_CALENDAR_ID ||
    event.status === "cancelled" || event.extendedProperties?.shared?.epAppointmentId !== eventId ||
    Date.parse(event.start?.dateTime) !== Date.parse(startsAt)) return false;

  const owner = event.attendees?.find((attendee: { self?: boolean; email?: string }) =>
    attendee.self && attendee.email?.toLowerCase() === OWNER_CALENDAR_ID);
  if (owner?.responseStatus === "declined" || owner?.responseStatus === "tentative") return true;
  const needsResponse = owner && owner.responseStatus !== "accepted";
  if (!needsResponse && event.colorId === OWNER_CALENDAR_BLUE) return true;
  if (!event.etag) return false;
  await googleFetch(`${path}?sendUpdates=none`, {
    method: "PATCH", headers: { "If-Match": event.etag },
    body: JSON.stringify({
      colorId: OWNER_CALENDAR_BLUE,
      ...(needsResponse ? {
        attendeesOmitted: true,
        attendees: [{ email: OWNER_CALENDAR_ID, responseStatus: "accepted" }],
      } : {}),
    }),
  });
  return true;
}

export async function updateGoogleCalendarEvent(id: string, input: { title: string; start: string; end: string; description?: string }) {
  return googleFetch(`/calendars/primary/events/${encodeURIComponent(id)}?conferenceDataVersion=1`, {
    method: "PATCH",
    body: JSON.stringify({
      summary: input.title,
      description: input.description,
      start: { dateTime: input.start, timeZone: "Europe/Rome" },
      end: { dateTime: input.end, timeZone: "Europe/Rome" },
    }),
  });
}

export async function removeStaleClosingEvent(taskId: string, previousStart: string, title: string) {
  const eventId = taskId.replace(/-/g, "");
  const path = `/calendars/primary/events/${encodeURIComponent(eventId)}`;
  try {
    const event = await googleFetch(path);
    if (event.id !== eventId || event.status !== "confirmed" || event.summary !== title ||
      Date.parse(event.start?.dateTime) !== Date.parse(previousStart) ||
      !event.organizer?.self || event.organizer.email?.toLowerCase() !== OWNER_CALENDAR_ID ||
      event.extendedProperties?.shared?.epAppointmentId !== eventId || !event.etag ||
      event.recurringEventId || event.recurrence?.length || event.attendeesOmitted ||
      event.attendees?.some((attendee: { email?: string }) => attendee.email?.toLowerCase() !== OWNER_CALENDAR_ID)) return;
    await googleFetch(`${path}?sendUpdates=none`, { method: "DELETE", headers: { "If-Match": event.etag } });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404 && status !== 410) throw error;
  }
}
export async function deleteGoogleCalendarEvent(id: string) {
  return googleFetch(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function listGoogleCalendarEvents(from: Date, to: Date): Promise<GoogleEvent[]> {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime" });
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) q.set('pageToken', pageToken);
    const result = await googleFetch(`/calendars/primary/events?${q}`);
    events.push(...(result.items || [])); pageToken = result.nextPageToken;
  } while (pageToken);
  return events;
}
export async function googleFreeBusy(from: Date, to: Date, calendarId = "primary"): Promise<Array<{ start: string; end: string }>> {
  const result = await googleFetch("/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: "Europe/Rome", items: [{ id: calendarId }] }) });
  return result.calendars?.[calendarId]?.busy || [];
}
