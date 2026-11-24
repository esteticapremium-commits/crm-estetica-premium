import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const owner = "ettoreandrosoni@estetica-premium.it";
const startsAt = "2030-11-20T12:00:00Z";
const id = "00000000000000000000000000000001";

const calendarClient = ts.transpileModule(
  readFileSync("src/calendarGoogle.ts", "utf8").replace("import.meta.env", "({})"),
  {compilerOptions: {module: ts.ModuleKind.CommonJS}},
).outputText;

function staleClosingFixture(overrides = {}) {
  const deletes = [];
  const exports = {};
  const title = "Centro di prova — Closing video";
  const calendarEvent = {
    id, summary: title, status: "confirmed", etag: '"current"', start: {dateTime: startsAt},
    organizer: {email: owner, self: true}, attendees: [{email: owner, self: true}],
    extendedProperties: {shared: {epAppointmentId: id}}, ...overrides,
  };
  vm.runInNewContext(calendarClient, {
    exports, require: () => ({}), localStorage: {getItem: () => JSON.stringify({accessToken: "test", expiresAt: Date.now() + 60_000})},
    fetch: async (path, request) => {
      if (request.method !== "DELETE") return Response.json(calendarEvent);
      deletes.push({ path, etag: request.headers["If-Match"] });
      return new Response(null, {status: 204});
    },
  });
  return {deletes, remove: () => exports.removeStaleCrmCalendarEvent("00000000-0000-0000-0000-000000000001", startsAt, title)};
}

test("rimuove dal vecchio slot solo l’evento CRM confermato e con la versione appena letta", async () => {
  const fixture = staleClosingFixture();
  await fixture.remove();
  assert.deepEqual(fixture.deletes, [{
    path: `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}?sendUpdates=none`, etag: '"current"',
  }]);
});

test("il rinvio lascia gli eventi di altri orari, gli inviti e quelli senza identità CRM", async () => {
  for (const overrides of [{start: {dateTime: "2030-11-19T12:00:00Z"}},
    {attendees: [{email: "guest@example.test"}]}, {extendedProperties: null}, {recurringEventId: "series"}]) {
    const fixture = staleClosingFixture(overrides);
    await fixture.remove();
    assert.deepEqual(fixture.deletes, []);
  }
});
