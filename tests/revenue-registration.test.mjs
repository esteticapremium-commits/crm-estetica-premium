import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync('src/revenueRegistration.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, {exports, require:()=>({withTimeout:async p=>p})});
const payload={client_id:'company',event_key:'stable-key',amount:1000};
function client(reply, inspect=()=>{}) { return {from(name){assert.equal(name,'sales_revenue_events');return {upsert(data,opts){inspect(data,opts);return Promise.resolve(reply);}};}}; }
test('conferma solo una scrittura confermata dal server',async()=>{
 assert.equal(await exports.persistRevenue(client({count:1,error:null}),payload),'created');
});
test('un reinvio usa la stessa chiave e non aggiorna o duplica il pagamento',async()=>{
 assert.equal(await exports.persistRevenue(client({count:0,error:null},(data,opts)=>{
 assert.equal(data,payload);assert.equal(opts.ignoreDuplicates,true);assert.equal(opts.onConflict,'client_id,event_key');assert.equal(opts.count,'exact');
 }),payload),'existing');
});
test('errore permessi non viene mostrato come successo',async()=>{
 await assert.rejects(exports.persistRevenue(client({error:{message:'RLS denied'}}),payload),/RLS denied/);
});
test('risposta senza conteggio non viene mostrata come successo',async()=>{
 await assert.rejects(exports.persistRevenue(client({error:null,count:null}),payload),/non ha confermato/);
});
test('risposta persa e reinvio non creano due incassi',async()=>{
 const rows=new Map(); let first=true;
 const db={from(){return {upsert(data,opts){const exists=rows.has(data.event_key);if(!exists)rows.set(data.event_key,data);assert.equal(opts.ignoreDuplicates,true);if(first){first=false;return Promise.reject(new Error('connection lost'));}return Promise.resolve({count:exists?0:1,error:null});}};}};
 await assert.rejects(exports.persistRevenue(db,payload),/connection lost/);
 assert.equal(await exports.persistRevenue(db,payload),'existing');assert.equal(rows.size,1);
});
