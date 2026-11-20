import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("supabase/functions/owner-discovery-calendar/index.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
const sellerId = "fea14cde-316f-4519-bad0-abb9d9208df7";
const ownerId = "cc9de596-9011-4d70-b3f5-4c5e49f6cec3";
const clientId = "fae0d66c-0e93-4e5e-b6f1-82ad0c47674c";
const taskId = "026cb018-8386-4623-b98a-3064828cd1ff";
const legacyId = taskId.replaceAll("-", "");
const managedId = "epd" + legacyId;

function setup(calendarPages = []) {
  const task = {
    id: taskId, created_by: "Giovanni D'agosta", client_id: clientId, appointment_type: "discovery",
    commercial_tracked: true, updated_at: "2026-01-01T12:00:00Z", title: "Lead di prova — Discovery",
    due_at: new Date(Date.now() + 86_400_000).toISOString(), appointment_status: "scheduled", completed_at: null, google_event_id: null,
  };
  const google = new Map();
  const requests = [];
  const profiles = [
    { id: sellerId, role: "venditore", client_id: clientId, full_name: "Giovanni D’agosta" },
    { id: ownerId, role: "admin" },
  ];
  let handler;
  let activeUserId = sellerId;

  const createClient = (url, key) => {
    if (key === "service") return {
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "giovanni@example.test" } } }) } },
      from: name => name === "profiles" ? { select: () => ({ in: async () => ({ data: profiles }) }) } : {
        select: () => ({ eq: (_column, id) => ({ maybeSingle: async () => {
          assert.equal(id, ownerId);
          return { data: { refresh_token: "owner-token-fixture" } };
        } }) }),
      },
    };
    return {
      auth: { getUser: async () => ({ data: { user: { id: activeUserId } } }) },
      from: name => {
        assert.equal(name, "sales_tasks");
        const predicates = [];
        let update;
        const query = {
          select: () => query,
          eq: (column, value) => { predicates.push(() => task[column] === value); return query; },
          is: (column, value) => { predicates.push(() => task[column] === value); return query; },
          update: changes => { update = changes; return query; },
          maybeSingle: async () => {
            if (predicates.some(check => !check())) return { data: null };
            if (update) Object.assign(task, update);
            return { data: { ...task } };
          },
        };
        return query;
      },
    };
  };
  const fetch = async (input, options) => {
    const url = new URL(input);
    if (url.host === "oauth2.googleapis.com") {
      assert.equal(options.body.get("refresh_token"), "owner-token-fixture");
      return Response.json({ access_token: "owner-access-fixture" });
    }
    assert.equal(url.host, "www.googleapis.com");
    assert.ok(url.pathname.includes("ettoreandrosoni%40estetica-premium.it"));
    assert.equal(options.headers.Authorization, "Bearer owner-access-fixture");
    const id = url.pathname.split("/").at(-1);
    const body = options.body && JSON.parse(options.body);
    requests.push({ method: options.method, id, body });
    if (id === "events" && options.method === "GET") {
      assert.equal(url.searchParams.get("fields"), "nextPageToken,items(summary,visibility,status,transparency,start(date,dateTime),end(date,dateTime))");
      const page = url.searchParams.has("pageToken") ? 1 : 0;
      return Response.json(calendarPages[page] ?? { items: [] });
    }
    if (options.method === "POST") {
      const event = { ...body, etag: "v1", organizer: { email: "ettoreandrosoni@estetica-premium.it" } };
      google.set(event.id, event);
      return Response.json(event);
    }
    const event = google.get(id);
    if (!event) return new Response(null, { status: 404 });
    if (options.method === "PATCH") {
      assert.equal(options.headers["If-Match"], event.etag);
      Object.assign(event, body);
    }
    if (options.method === "DELETE") {
      assert.equal(options.headers["If-Match"], event.etag);
      google.delete(id);
      return new Response(null, { status: 204 });
    }
    return Response.json(event);
  };
  vm.runInNewContext(compiled, {
    exports: {}, require: () => ({ createClient }), fetch, Request, Response, URLSearchParams, AbortSignal,
    Deno: { env: { get: name => ({ SUPABASE_URL: "https://crm.example.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" })[name] }, serve: callback => { handler = callback; } },
  });
  const invoke = async (operation = "sync", expectedUpdatedAt, params = {}) => handler(new Request("https://crm.example.test/sync", {
    method: "POST", headers: { Authorization: "Bearer fixture-session" }, body: JSON.stringify({ taskId, operation, expectedUpdatedAt, ...params }),
  }));
  return { task, google, requests, invoke, setUser: id => { activeUserId = id; } };
}

test("la Discovery prenotata da Giovanni entra una volta nel calendario del titolare", async () => {
  const { task, google, requests, invoke } = setup();
  assert.equal((await invoke()).status, 200);
  assert.equal((await invoke()).status, 200);
  assert.equal(task.google_event_id, managedId);
  assert.equal(requests.filter(request => request.method === "POST").length, 1);
  const event = google.get(managedId);
  assert.equal(event.start.dateTime, task.due_at);
  assert.equal(Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime), 30 * 60_000);
  assert.equal(event.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.deepEqual(event.attendees, [{ email: "giovanni@example.test" }]);
});

test("lo spostamento conserva l’identità dell’evento e la revoca richiede la versione attuale", async () => {
  const { task, google, invoke, setUser } = setup();
  assert.equal((await invoke()).status, 200);
  task.due_at = new Date(Date.parse(task.due_at) + 3_600_000).toISOString();
  setUser(ownerId);
  assert.equal((await invoke()).status, 200);
  assert.equal(google.get(managedId).start.dateTime, task.due_at);
  assert.equal((await invoke("delete", "2025-01-01T00:00:00Z")).status, 409);
  assert.equal(google.size, 1);
  assert.equal((await invoke("delete", task.updated_at)).status, 200);
  assert.equal(google.size, 0);
});

test("un altro utente o una call di un altro autore non può scrivere sul calendario del titolare", async () => {
  const { task, requests, invoke, setUser } = setup();
  setUser("other-user");
  assert.equal((await invoke()).status, 403);
  setUser(sellerId);
  task.created_by = "Altro venditore";
  assert.equal((await invoke()).status, 404);
  assert.equal(requests.length, 0);
});

test("un invito già arrivato viene collegato senza duplicarlo", async () => {
  const { task, google, requests, invoke } = setup();
  google.set(legacyId, { id: legacyId, extendedProperties: { shared: { epAppointmentId: legacyId } },
    start: { dateTime: task.due_at }, end: { dateTime: new Date(Date.parse(task.due_at) + 1_800_000).toISOString() } });
  assert.equal((await invoke()).status, 200);
  assert.equal(task.google_event_id, legacyId);
  assert.equal(requests.filter(request => request.method === "POST").length, 0);
});

test("la settimana condivisa restituisce solo titoli e orari e oscura gli eventi privati", async () => {
  const at = "2026-11-20T15:00:00+01:00";
  const endAt = "2026-11-20T15:30:00+01:00";
  const t = { start: { dateTime: at }, end: { dateTime: endAt } };
  const { invoke, requests } = setup([
    { nextPageToken: "page-2", items: [
      { ...t, summary: "Riunione", description: "Nota privata", attendees: [{ email: "test@example.test" }], hangoutLink: "https://meet.example.test/riservato" },
      { ...t, summary: "Titolo privato", visibility: "private" },
      { ...t, summary: "Titolo privato libero", visibility: "private", transparency: "transparent" },
      { ...t, summary: "Appuntamento annullato", status: "cancelled" },
    ] },
    { items: [{ summary: "Fuori ufficio", start: { date: "2026-11-21" }, end: { date: "2026-11-22" } }] },
  ]);
  const result = await invoke("list_titles", undefined, { from: "2026-11-16T00:00:00+01:00", to: "2026-11-23T00:00:00+01:00" });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { events: [
    { title: "Riunione", at, endAt, allDay: false },
    { title: "Occupato", at, endAt, allDay: false },
    { title: "Fuori ufficio", at: "2026-11-21", endAt: "2026-11-22", allDay: true },
  ] });
  assert.equal(requests.length, 2);
});

test("la vista dei titoli è limitata a Giovanni e a una settimana per richiesta", async () => {
  const { invoke, setUser, requests } = setup();
  const from = "2026-11-16T00:00:00+01:00";
  const to = "2026-11-23T00:00:00+01:00";
  setUser("altro-setter");
  assert.equal((await invoke("list_titles", undefined, { from, to })).status, 403);
  setUser(ownerId);
  assert.equal((await invoke("list_titles", undefined, { from, to })).status, 403);
  setUser(sellerId);
  assert.equal((await invoke("list_titles", undefined, { from, to: "2026-12-16" })).status, 400);
  assert.equal(requests.length, 0);
});
