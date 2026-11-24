import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const task = {
  id: "4fbc47b9-8c26-4032-9d08-feb836b27e39",
  due_at: "2030-11-20T12:00:00Z",
  appointment_type: "setting",
  title: "Centro di prova — Setting telefonico",
};
const owner = "owner@example.test";
const script = ts.transpileModule(readFileSync("src/appointments.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function setup({ organizer, linkError, guestConfirmed = false, personalConnected = true, userId = "fea14cde-316f-4519-bad0-abb9d9208df7" }) {
  const exports = {};
  let guestChecks = 0;
  let personalRefreshes = 0;
  let cachedConnectionChecks = 0;
  const created = [];
  const calendar = {
    OWNER_CALENDAR_ID: owner,
    ensureGoogleCalendarConnection: async () => { cachedConnectionChecks++; return true; },
    refreshGoogleCalendarConnection: async () => { personalRefreshes++; return personalConnected; },
    createGoogleCalendarEvent: async event => { created.push(event); return { id: event.eventId, organizer }; },
    confirmOnPrimaryOwnerCalendar: async () => { throw new Error("Aggiornamento del colore respinto"); },
    confirmOwnerCalendarAttendance: async () => { guestChecks++; return guestConfirmed; },
  };
  const updates = {
    update() { return this; },
    eq() { return this; },
    select() { return this; },
    async single() { return { error: linkError }; },
  };
  const imports = {
    "./calendarGoogle": calendar,
    "./supabaseClient": { supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: userId } } } }) }, from: () => updates } },
  };
  vm.runInNewContext(script, { exports, require: name => imports[name] ?? {} });
  return {
    isGiovanniSetting: exports.isGiovanniSetting,
    retry: (appointment = task) => exports.retryAppointmentSync(appointment),
    guestChecks: () => guestChecks, personalRefreshes: () => personalRefreshes,
    cachedConnectionChecks: () => cachedConnectionChecks, created,
  };
}

test("il mancato aggiornamento del colore non segnala una conferma mancante all’organizzatore", async () => {
  const fixture = setup({ organizer: { email: owner.toUpperCase(), self: true } });
  const result = await fixture.retry();
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(fixture.guestChecks(), 0);
});

test("per il calendario del venditore rimane la verifica della partecipazione del titolare", async () => {
  const fixture = setup({ organizer: { email: "seller@example.test", self: true } });
  const result = await fixture.retry();
  assert.equal(result.ok, false);
  assert.match(result.error, /Conferma di partecipazione del titolare da verificare/);
  assert.equal(fixture.guestChecks(), 1);
});

test("un errore nel collegamento dell’evento al CRM resta visibile anche all’organizzatore", async () => {
  const fixture = setup({ organizer: { email: owner, self: true }, linkError: new Error("Errore di collegamento") });
  const result = await fixture.retry();
  assert.equal(result.ok, false);
  assert.match(result.error, /Google Calendar da sincronizzare/);
});

test("il setting di Giovanni usa il suo Google, dura 30 minuti in agenda e non aggiunge ospiti o Meet", async () => {
  const fixture = setup({ organizer: { email: "seller@example.test", self: true } });
  const result = await fixture.retry({ ...task, created_by: "Giovanni D’Agosta", duration_minutes: 15 });
  assert.equal(result.ok, true);
  assert.equal(fixture.personalRefreshes(), 1);
  assert.equal(fixture.cachedConnectionChecks(), 0);
  assert.equal(fixture.guestChecks(), 0);
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.created[0].attendees, undefined);
  assert.equal(fixture.created[0].videoConference, false);
  assert.equal(Date.parse(fixture.created[0].end) - Date.parse(fixture.created[0].start), 30 * 60_000);
});

test("un setting di Giovanni in attesa di collegamento Google non passa a un calendario già in memoria", async () => {
  const fixture = setup({ personalConnected: false });
  const result = await fixture.retry({ ...task, created_by: "Giovanni D'agosta" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Collega il tuo Google Calendar/);
  assert.equal(fixture.cachedConnectionChecks(), 0);
  assert.equal(fixture.created.length, 0);
});


test("il setting segue chi conduce anche se lo prenota Ettore", async () => {
  const giovanni = "Giovanni D’agosta";
  const appointment = { ...task, appointment_host: giovanni, assigned_to: giovanni, created_by: "Titolare" };
  const ownerFixture = setup({ userId: "owner" });
  assert.equal(ownerFixture.isGiovanniSetting(appointment), true);
  assert.match((await ownerFixture.retry(appointment)).error, /Giovanni può sincronizzarlo/);
  assert.equal(ownerFixture.personalRefreshes(), 0);
  assert.equal(ownerFixture.cachedConnectionChecks(), 0);
  assert.equal(ownerFixture.created.length, 0);

  const sellerFixture = setup({ organizer: { email: "seller@example.test", self: true } });
  assert.equal((await sellerFixture.retry(appointment)).ok, true);
  assert.equal(sellerFixture.created.length, 1);
  assert.equal(sellerFixture.created[0].attendees, undefined);
  assert.equal(sellerFixture.isGiovanniSetting({ ...appointment, appointment_host: "Titolare" }), false);
  assert.equal(sellerFixture.isGiovanniSetting({ ...appointment, appointment_type: "discovery" }), false);
  assert.equal(sellerFixture.isGiovanniSetting({ ...appointment, appointment_type: "demo" }), false);
});

test("la setting di Ettore usa la sua connessione Google anche se il lead è di Giovanni", async () => {
  const fixture = setup({ userId: "owner", organizer: { email: owner, self: true } });
  const appointment = { ...task, created_by: "Titolare", assigned_to: "Giovanni D’agosta" };
  assert.equal(fixture.isGiovanniSetting(appointment), false);
  assert.equal((await fixture.retry({ ...appointment, appointment_host: "Titolare" })).ok, true);
  assert.equal(fixture.personalRefreshes(), 1);
  assert.equal(fixture.cachedConnectionChecks(), 0);
});

test("riprenotare un no-show crea un nuovo evento Google confermato per setting, discovery e closing", async () => {
  const previousId = "3597cf4f-cc6e-4c96-bd17-ac93a572f634";
  const lead = { id: "babea8e3-9038-4aa4-a92d-7285ec4c2fbf", name: "Centro di prova", stage_id: "current" };
  const startsAt = new Date(task.due_at);
  for (const type of ["setting", "discovery", "demo"]) {
    const exports = {};
    const actions = [];
    const prior = { id: previousId, title: "Tentativo precedente", google_event_id: previousId.replaceAll("-", "") };
    const rows = {
      select() { return this; }, update() { return this; }, not() { return this; }, lt() { return this; },
      eq(column, value) {
        if (column === "id" && value === previousId) actions.push("validated predecessor");
        return this;
      },
      async single() { return { data: { stage_id: lead.stage_id }, error: null }; },
      then(resolve) { return Promise.resolve({ data: [prior], error: null }).then(resolve); },
    };
    const imports = {
      "./supabaseClient": { supabase: {
        from: () => rows,
        rpc: async (_, params) => {
          assert.equal(params.p_previous_outcome_key, exports.outcomeKey(previousId));
          return { data: { ...task, client_id: "client", lead_id: lead.id, appointment_type: type, title: params.p_title, appointment_host: "Titolare" } };
        },
      } },
      "./calendarGoogle": {
        OWNER_CALENDAR_ID: owner,
        ensureGoogleCalendarConnection: async () => true,
        refreshGoogleCalendarConnection: async () => true,
        createGoogleCalendarEvent: async event => {
          assert.equal(event.eventId, task.id.replaceAll("-", ""));
          assert.equal(event.start, startsAt.toISOString());
          assert.deepEqual(Array.from(event.attendees), [owner]);
          actions.push("created replacement");
          return { id: event.eventId, organizer: { email: owner, self: true } };
        },
        confirmOnPrimaryOwnerCalendar: async () => { actions.push("confirmed replacement"); return true; },
        removeStaleCrmCalendarEvent: async (id, start, title) => {
          assert.equal(id, previousId);
          assert.equal(Date.parse(start), startsAt.getTime());
          assert.equal(title, prior.title);
          actions.push("checked duplicate");
        },
      },
    };
    vm.runInNewContext(script, { exports, require: name => imports[name] ?? {} });
    const result = await exports.createAppointment({
      type, lead, audience: "lead", startsAt, note: "", subject: lead.name, clientId: "client", requestId: task.id,
      previousOutcomeKey: exports.outcomeKey(previousId),
    });
    assert.equal(result.warning, undefined);
    assert.equal(result.pipelineWarning, undefined);
    assert.deepEqual(actions, ["created replacement", "confirmed replacement", "validated predecessor", "checked duplicate"]);
  }
});
