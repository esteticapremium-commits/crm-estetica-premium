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
test('linking a sale and recording later instalments never adds a second new customer',()=>{
 const s={...sale,id:'g1',lead_id:'lead-1',outcome:'won',contract_value:3000};
 const r=[{id:'cash-google',lead_id:'lead-1',revenue_type:'new',status:'collected',occurred_at:'2026-11-10T10:00:00Z',event_key:'google-sale:g1'},
 {id:'instalment',lead_id:'lead-1',revenue_type:'new',status:'collected',occurred_at:'2026-11-12T10:00:00Z'}];
 const ids=exports.firstNewSaleIds([s],r);
 assert.equal(ids.size,1);assert.equal(ids.has('google:g1'),true);
 const older=[...r,{id:'original',lead_id:'lead-1',revenue_type:'new',status:'collected',occurred_at:'2026-11-01T10:00:00Z'}];
 assert.equal(exports.firstNewSaleIds([s],older).has('google:g1'),false);
 assert.equal(exports.firstNewSaleIds([s],older).has('revenue:original'),true);
});
test('excluded calls do not contribute even their booking',()=>{
 assert.equal(Object.keys(googleSaleMetrics({...sale,outcome:'excluded'},'2026-11-09',now)).length,0);
});
test('closing link counts Discovery held and qualified, leaving the booking to the actual Closing',()=>{
 const discovery={...sale,appointment_type:'discovery',outcome:'closing_booked',qualified:true,next_action_at:'2026-11-12T11:00:00Z'};
 const metrics=googleSaleMetrics(discovery,'2026-11-10',now);
 assert.equal(validateGoogleSale(discovery,now),null);
 assert.equal(metrics.discoveryHeld,1);
 assert.equal(metrics.qualified,1);
 assert.equal(metrics.demoBooked,undefined);
 assert.equal(metrics.won,undefined);
 assert.equal(saleNeedsAction(discovery,now),false);
 assert.ok(validateGoogleSale({...discovery,appointment_type:'demo'},now));
 const closing={...sale,booked_at:'2026-11-10T10:20:00Z',starts_at:discovery.next_action_at};
 assert.equal(googleSaleMetrics(closing,'2026-11-10',now).demoBooked,1);
});
test('post-closing follow-ups keep separate call counts and retain sales outcomes',()=>{
 const followUp={...sale,appointment_type:'follow_up',outcome:'won',contract_value:3000};
 const booked=googleSaleMetrics(followUp,'2026-11-09',now);
 assert.equal(booked.followUpBooked,1);assert.equal(booked.demoBooked,undefined);
 const held=googleSaleMetrics(followUp,'2026-11-10',now);
 assert.equal(held.followUpHeld,1);assert.equal(held.followUpScheduled,1);
 assert.equal(held.demoHeld,undefined);assert.equal(held.demoClientHeld,undefined);
 assert.equal(held.won,1);assert.equal(held.contractValue,3000);
 assert.equal(validateGoogleSale(followUp,now),null);
 const missed=googleSaleMetrics({...followUp,outcome:'no_show'},'2026-11-10',now);
 assert.equal(missed.followUpHeld,undefined);assert.equal(missed.noShow,1);
 const postponed=googleSaleMetrics({...followUp,outcome:'rescheduled'},'2026-11-10',now);
 assert.equal(postponed.followUpScheduled,undefined);
});
