import { supabase } from "./supabaseClient";

const KEY = "ep-google-calendar-token";
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID as string | undefined;
export const OWNER_CALENDAR_ID = "ettoreandrosoni@estetica-premium.it";

export type GoogleEvent = { id: string; summary?: string; description?: string; location?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
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

async function persistentToken() {
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
  if (await persistentToken()) return true;
  return false;
}

async function legacyConnectGoogleCalendar() {
  try {
    await loadScript();
    await new Promise<void>((resolve, reject) => {
      const client = (window as any).google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy", callback: (r: any) => {
        if (r.error || !r.access_token) return reject(new Error(r.error || "Collegamento non riuscito"));
        saveToken(r.access_token, Number(r.expires_in || 3600)); resolve();
      }});
      client.requestAccessToken({ prompt: "consent" });
    });
  } catch (error) { throw error; }
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
          // Compatibilità temporanea durante l'attivazione del backend.
          try { await legacyConnectGoogleCalendar(); return resolve(); }
          catch { return reject(new Error(data?.error || "Collegamento permanente non disponibile.")); }
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
    if (await persistentToken()) {
      const renewed = token();
      response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { ...init, headers: { Authorization: `Bearer ${renewed?.accessToken}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
    }
  }
  if (!response.ok) throw new Error("Google Calendar non ha accettato la richiesta.");
  if (response.status === 204) return null;
  return response.json();
}
export async function createGoogleCalendarEvent(input: { title: string; start: string; end: string; description?: string; attendees?: string[] }) {
  const query = new URLSearchParams({ sendUpdates: "all", conferenceDataVersion: "1" });
  const requestId = `ep-${crypto.randomUUID()}`;
  return googleFetch(`/calendars/primary/events?${query}`, { method: "POST", body: JSON.stringify({ summary: input.title, description: input.description || "", start: { dateTime: input.start, timeZone: "Europe/Rome" }, end: { dateTime: input.end, timeZone: "Europe/Rome" }, attendees: input.attendees?.map((email) => ({ email })), conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } }) });
}
export async function updateGoogleCalendarEvent(id: string, input: { title: string; start: string; end: string; description?: string }) {
  return googleFetch(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ summary: input.title, description: input.description || "", start: { dateTime: input.start, timeZone: "Europe/Rome" }, end: { dateTime: input.end, timeZone: "Europe/Rome" } }) });
}
export async function deleteGoogleCalendarEvent(id: string) {
  return googleFetch(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function listGoogleCalendarEvents(from: Date, to: Date): Promise<GoogleEvent[]> {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime" });
  const result = await googleFetch(`/calendars/primary/events?${q}`); return result.items || [];
}
export async function googleFreeBusy(from: Date, to: Date, calendarId = "primary"): Promise<Array<{ start: string; end: string }>> {
  const result = await googleFetch("/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: "Europe/Rome", items: [{ id: calendarId }] }) });
  return result.calendars?.[calendarId]?.busy || [];
}
