import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(path, dependencies = {}) {
  const exports = {};
  const js = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(js, { exports, require: name => dependencies[name] });
  return exports;
}

const { matchesSetterQueue, summarizeSetterQueue } = load("src/setterQueue.ts", {
  "./dates": load("src/dates.ts"),
});
const today = "2026-11-19";
const now = Date.parse("2026-11-19T09:00:00Z");
const lead = (state, fields = {}) => ({ state, callback_at: null, discovery_at: null, discovery_status: null, ...fields });

test("i richiami di oggi usano il fuso italiano e gli scaduti coincidono con il filtro della pipeline", () => {
  const queue = [
    lead("new"),
    lead("follow_up", { callback_at: "2026-11-18T23:30:00Z" }),
    lead("follow_up", { callback_at: "2026-11-19T11:00:00Z" }),
    lead("follow_up", { callback_at: "2026-11-18T19:00:00Z" }),
    lead("not_interested", { callback_at: "2026-11-19T08:00:00Z" }),
  ];
  const summary = summarizeSetterQueue(queue, today, now);
  assert.equal(summary.stages.follow_up, 3);
  assert.equal(summary.todayCallbacks, 2);
  assert.equal(summary.overdue, 2);
  assert.equal(queue.filter(item => matchesSetterQueue(item, "overdue", today, now)).length, summary.overdue);
});

test("la prossima discovery include solo appuntamenti futuri ancora attivi", () => {
  const queue = [
    lead("booked", { discovery_at: "2026-11-19T08:00:00Z", discovery_status: "held" }),
    lead("booked", { discovery_at: "2026-11-19T10:00:00Z", discovery_status: "no_show" }),
    lead("booked", { discovery_at: "2026-11-19T11:00:00Z", discovery_status: "scheduled" }),
    lead("booked", { discovery_at: "2026-11-19T10:30:00Z", discovery_status: "rescheduled" }),
  ];
  const summary = summarizeSetterQueue(queue, today, now);
  assert.equal(summary.stages.booked, 4);
  assert.equal(summary.nextDiscovery, "2026-11-19T10:30:00Z");
});
