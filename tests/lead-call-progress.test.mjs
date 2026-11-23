import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function loadModule(path, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => dependencies[name] });
  return exports;
}

const { leadCallProgress } = loadModule("src/leadCallProgress.ts", {
  "./googleSales": loadModule("src/googleSales.ts"),
  "./leadWork": loadModule("src/leadWork.ts"),
});
const earlier = "2026-11-20T15:00:00Z";
const later = "2026-11-23T14:00:00Z";
const next = "2026-11-24T12:00:00Z";
const settingOutcome = { lead_id: "a", event_type: "setting_call", outcome: "answered", occurred_at: earlier };
const task = (appointment_type, due_at, fields = {}) => ({
  lead_id: "a", appointment_type, due_at, appointment_status: "scheduled", completed_at: null, is_priority: false, ...fields,
});
const google = (appointment_type, outcome, starts_at, fields = {}) => ({
  lead_id: "a", appointment_type, outcome, starts_at, qualified: null, ...fields,
});

test("una setting solo prenotata resta un appuntamento senza esito", () => {
  const progress = leadCallProgress([{ ...settingOutcome, event_type: "setting_booked", outcome: "scheduled" }], [], [task("setting", earlier)]).get("a");
  assert.equal(progress.outcome, undefined);
  assert.equal(progress.step.type, "setting");
  assert.equal(progress.step.at, earlier);
});

test("il no-show di Closing da Google prevale su una vecchia setting e resta separato dal richiamo", () => {
  const progress = leadCallProgress([settingOutcome], [google("demo", "no_show", later)], [task(null, next, { is_priority: true })]).get("a");
  assert.equal(progress.outcome.type, "demo");
  assert.equal(progress.outcome.label, "No-show");
  assert.equal(progress.outcome.missed, true);
  assert.equal(progress.step.type, null);
  assert.equal(progress.step.at, next);
  assert.equal(progress.step.priority, true);
});

test("una discovery svolta sostituisce la prenotazione duplicata e lascia visibile la closing futura", () => {
  const progress = leadCallProgress([settingOutcome], [google("discovery", "closing_booked", later, { qualified: true }), google("demo", "pending", next)], [task("discovery", later)]).get("a");
  assert.equal(progress.outcome.type, "discovery");
  assert.match(progress.outcome.label, /Svolta.*Closing prenotata.*In target/);
  assert.equal(progress.step.type, "demo");
  assert.equal(progress.step.at, next);
});

test("esclusi, rinviati, annullati o senza lead non diventano esiti o appuntamenti", () => {
  const progress = leadCallProgress([], [google("discovery", "excluded", earlier), google("demo", "rescheduled", later), google("demo", "won", later, { lead_id: null })], [task("demo", next, { appointment_status: "cancelled" })]);
  assert.equal(progress.size, 0);
});
