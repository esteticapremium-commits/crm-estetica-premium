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

function setup({ organizer, linkError, guestConfirmed = false }) {
  const exports = {};
  let guestChecks = 0;
  const calendar = {
    OWNER_CALENDAR_ID: owner,
    ensureGoogleCalendarConnection: async () => true,
    createGoogleCalendarEvent: async ({ eventId }) => ({ id: eventId, organizer }),
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
  return { retry: () => exports.retryAppointmentSync(task), guestChecks: () => guestChecks };
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
