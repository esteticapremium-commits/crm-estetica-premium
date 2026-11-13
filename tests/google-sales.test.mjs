import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('src/googleSales.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,Date});
const {googleSaleKey,googleSaleMetrics,validateGoogleSale,saleNeedsAction}=exports;
const now=new Date('2026-11-13T12:00:00Z');
const sale={contact_name:'Test',starts_at:'2026-11-10T10:00:00Z',booked_at:'2026-11-09T10:00:00Z',outcome:'pending',appointment_type:'demo',revenue_type:'new',contract_value:0,collected_amount:0,collected_at:null,next_action_at:null,qualified:null};
test('same Google meeting across calendars has one identity; recurring instances stay distinct',()=>{
 assert.equal(googleSaleKey({id:'a',iCalUID:'meeting'}),googleSaleKey({id:'b',iCalUID:'meeting'}));
 assert.notEqual(googleSaleKey({id:'a',iCalUID:'meeting',originalStartTime:{date:'2026-11-10'}}),googleSaleKey({id:'b',iCalUID:'meeting',originalStartTime:{date:'2026-11-11'}}));
});
test('pending, no-show and rescheduled calls never become attended or won',()=>{
 for(const outcome of ['pending','no_show','rescheduled']) {
  const m=googleSaleMetrics({...sale,outcome},'2026-11-10',now);assert.equal(m.demoHeld,undefined);assert.equal(m.won,undefined);
  assert.equal(m.noShow,outcome==='no_show'?1:undefined);
 }
 assert.equal(googleSaleMetrics({...sale,outcome:'rescheduled'},'2026-11-10',now).demoScheduled,undefined);
});
test('late entry uses meeting date; payment is not inferred from deal value',()=>{
 const s={...sale,outcome:'won',contract_value:3000};
 assert.equal(googleSaleMetrics(s,'2026-11-10',now).won,1);
 assert.equal(googleSaleMetrics(s,'2026-11-13',now).won,undefined);
 assert.equal(googleSaleMetrics(s,'2026-11-10',now).collectedNew,undefined);
 assert.equal(googleSaleMetrics(s,'2026-11-09',now).demoBooked,1);
});
test('renewal and upsell do not inflate new customers',()=>{
 for(const revenue_type of ['renewal','upsell']) {
  const m=googleSaleMetrics({...sale,outcome:'won',revenue_type},'2026-11-10',now);
  assert.equal(m.won,undefined);assert.equal(m.demoClientHeld,1);assert.equal(m[revenue_type==='renewal'?'renewals':'upsells'],1);
 }
});
test('follow-up is a held call with a dated action; missing outcome stays actionable',()=>{
 assert.equal(googleSaleMetrics({...sale,outcome:'follow_up'},'2026-11-10',now).demoHeld,1);
 assert.equal(saleNeedsAction(sale,now),true);
 assert.equal(saleNeedsAction({...sale,outcome:'follow_up',next_action_at:'2026-11-14T12:00:00Z'},now),false);
 assert.equal(saleNeedsAction({...sale,outcome:'follow_up',next_action_at:'2026-11-12T12:00:00Z'},now),true);
});
test('validates amounts, real payment date, follow-up and future outcomes',()=>{
 assert.equal(validateGoogleSale(sale,now),null);
 assert.ok(validateGoogleSale({...sale,outcome:'won'},now));
 assert.ok(validateGoogleSale({...sale,outcome:'won',contract_value:100,collected_amount:101},now));
 assert.ok(validateGoogleSale({...sale,outcome:'won',contract_value:100,collected_amount:50,collected_at:'2026-11-14'},now));
 assert.ok(validateGoogleSale({...sale,outcome:'follow_up'},now));
 assert.ok(validateGoogleSale({...sale,outcome:'lost',starts_at:'2026-11-14'},now));
 assert.ok(validateGoogleSale({...sale,appointment_type:'discovery',outcome:'lost'},now));
});
