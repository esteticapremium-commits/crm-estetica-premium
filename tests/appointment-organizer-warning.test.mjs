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

function setup({ organizer, linkError, guestConfirmed = false, personalConnected = true }) {
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
    "./supabaseClient": { supabase: { from: () => updates } },
  };
  vm.runInNewContext(script, { exports, require: name => imports[name] ?? {} });
  return {
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
