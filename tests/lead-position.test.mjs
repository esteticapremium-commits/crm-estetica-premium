import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync('src/leadPosition.ts','utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText, { exports, Error, require: () => ({ withTimeout: p => p }) });
const modal = readFileSync('src/pages/LeadModal.tsx','utf8');
const saveCode = ts.transpile(modal.slice(modal.indexOf('  async function save('), modal.indexOf('  async function saveQuickNote(')));

async function saveScenario(stageId, readError = null) {
  const reads = [], writes = [], errors = [], filters = [];
  const db = { from(table) {
    assert.equal(table, 'leads');
    const query = {
      eq(key,value) { filters.push([key,value]); return query; },
      order(key, options) { assert.equal(key,'position'); assert.equal(options.ascending,true); return query; },
      limit(n) { assert.equal(n,1); return query; },
      async maybeSingle() { reads.push(true); return {data:{position:-8},error:readError}; },
      async single() { return {data:{id:'lead'},error:null}; },
      select() { return query; }
    };
    return { select: () => query, update: payload => {writes.push(payload); return query;} };
  }};
  const lock = {current:false};
  const context = {
    Error, supabase:db, topLeadPosition:exports.topLeadPosition,
    busy:false,leadSaveLock:lock,revenueAmount:'',setBusy:()=>{},setErr:e=>errors.push(e),
    isNew:false,stageId,persistedStage:{current:"source"},selectedPipelineId:'pipeline',originalPipelineId:'pipeline',
    lead:{id:'lead',client_id:'client',pipeline_id:'pipeline',stage_id:'source'},
    quickNote:'',notes:'',name:'Synthetic lead',phone:'',email:'',source:'',
    assigned:'',canReassign:false,meName:'',value:'0',nextAction:'',closingDate:'',
    lostReason:'',tags:'',planDue:'',onSaved:()=>{}
  };
  await vm.runInNewContext(saveCode+'; save();', context);
  assert.equal(lock.current,false);
  return {reads,writes,errors,filters};
}

test('changing stage in the same pipeline puts an old lead ahead of the current first lead', async () => {
  const r = await saveScenario('destination');
  assert.equal(r.writes[0].position,-9);
  assert.equal(r.writes[0].stage_id,'destination');
  assert.ok(r.filters.some(([key,value]) => key==='client_id' && value==='client'));
  assert.ok(r.filters.some(([key,value]) => key==='pipeline_id' && value==='pipeline'));
  assert.ok(r.filters.some(([key,value]) => key==='stage_id' && value==='destination'));
});

test('editing without changing stage preserves the lead position', async () => {
  const r = await saveScenario('source');
  assert.equal(r.reads.length,0);
  assert.equal('position' in r.writes[0],false);
});

test('a failed destination lookup stops the save and releases the lock', async () => {
  const r = await saveScenario('destination',{message:'permission denied'});
  assert.equal(r.writes.length,0);
  assert.match(r.errors.at(-1),/permission denied/);
});
