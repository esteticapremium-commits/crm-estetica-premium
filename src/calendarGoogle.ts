const KEY = "ep-google-calendar-token";
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID as string | undefined;

export type GoogleEvent = { id: string; summary?: string; description?: string; location?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
type Token = { accessToken: string; expiresAt: number };

export function googleCalendarConfigured() { return Boolean(CLIENT_ID); }
export function googleCalendarConnected() {
  try { const token = JSON.parse(sessionStorage.getItem(KEY) || "null") as Token | null; return Boolean(token && token.expiresAt > Date.now()); } catch { return false; }
}
function token() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null") as Token | null; } catch { return null; } }
function loadScript() { return new Promise<void>((resolve, reject) => { if ((window as any).google?.accounts?.oauth2) return resolve(); const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error("Non riesco a caricare Google.")); document.head.appendChild(s); }); }

/** Il venditore autorizza solo il proprio calendario Google, nel suo browser. */
export async function connectGoogleCalendar() {
  if (!CLIENT_ID) throw new Error("Configurazione Google Calendar mancante.");
  await loadScript();
  return new Promise<void>((resolve, reject) => {
    const client = (window as any).google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy", callback: (r: any) => {
      if (r.error) return reject(new Error(r.error));
      sessionStorage.setItem(KEY, JSON.stringify({ accessToken: r.access_token, expiresAt: Date.now() + Number(r.expires_in || 3600) * 1000 })); resolve();
    }});
    client.requestAccessToken({ prompt: "consent" });
  });
}
async function googleFetch(path: string, init?: RequestInit) {
  const t = token(); if (!t || t.expiresAt <= Date.now()) throw new Error("Ricollega Google Calendar per continuare.");
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { ...init, headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) throw new Error("Google Calendar non ha accettato la richiesta.");
  return response.json();
}
export async function createGoogleCalendarEvent(input: { title: string; start: string; end: string; description?: string }) {
  return googleFetch("/calendars/primary/events", { method: "POST", body: JSON.stringify({ summary: input.title, description: input.description || "", start: { dateTime: input.start, timeZone: "Europe/Rome" }, end: { dateTime: input.end, timeZone: "Europe/Rome" } }) });
}
export async function listGoogleCalendarEvents(from: Date, to: Date): Promise<GoogleEvent[]> {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime" });
  const result = await googleFetch(`/calendars/primary/events?${q}`); return result.items || [];
}
export async function googleFreeBusy(from: Date, to: Date): Promise<Array<{ start: string; end: string }>> {
  const result = await googleFetch("/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: "Europe/Rome", items: [{ id: "primary" }] }) });
  return result.calendars?.primary?.busy || [];
}
