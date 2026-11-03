import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('src/dailySales.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,Date});
const {reportRange,reportDays,parseDailyNumbers,sumDailyReports,emptyDailyNumbers}=exports;
test('settimana lunedì-domenica attraversa mese e anno',()=>{
 const r=reportRange('2027-01-01','week'); assert.equal(r.from,'2026-12-28');assert.equal(r.to,'2027-01-03');
});
test('mese bisestile e cambio ora non perdono giornate',()=>{
 const r=reportRange('2028-02-14','month');assert.equal(r.to,'2028-02-29');assert.equal(reportDays(r.from,r.to).length,29);
 assert.equal(reportDays('2026-10-01','2026-10-31').length,31);
});
test('vuoti, negativi e frazioni non vengono convertiti in risultati validi',()=>{
 const v={calls_made:'10',discovery_booked:'2',discovery_held:'1',demo_booked:'2',demo_held:'0',demo_won:'0'};
 for(const x of ['', '-1','1.5','2147483648','1e3']) assert.equal(parseDailyNumbers({...v,calls_made:x}),null);
 assert.equal(parseDailyNumbers(v).calls_made,10);
});
test('totali sommano le giornate, anche chiusure di demo precedenti',()=>{
 const sum=sumDailyReports([{...emptyDailyNumbers(),calls_made:30,demo_won:2},{...emptyDailyNumbers(),calls_made:20,discovery_booked:3}]);
 assert.equal(sum.calls_made,50);assert.equal(sum.demo_won,2);assert.equal(sum.discovery_booked,3);
});

test('prenotazioni e riprenotazioni non diventano demo svolte',()=>{
 const sum=sumDailyReports([{...emptyDailyNumbers(),demo_booked:3,demo_held:1},{...emptyDailyNumbers(),demo_booked:2,demo_held:0}]);
 assert.equal(sum.demo_booked,5);assert.equal(sum.demo_held,1);
});
test('giornate precedenti senza demo prenotate non diventano zero',()=>{
 assert.equal(sumDailyReports([{...emptyDailyNumbers(),demo_booked:null},{...emptyDailyNumbers(),demo_booked:2}]).demo_booked,null);
});
