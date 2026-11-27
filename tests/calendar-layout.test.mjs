import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('src/calendarLayout.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,Date,Intl});
const {layoutIntervals,nextTimedEvent,romeMinutes}=exports;
const event=(id,start,end)=>({id,start,end});
test('sovrapposizioni parziali, non soltanto inizi identici, affiancate',()=>{
 const placed=layoutIntervals([event('a',600,660),event('b',630,690)]);
 assert.equal(placed[0].columns,2);assert.notEqual(placed[0].column,placed[1].column);
});
test('gli appuntamenti consecutivi recuperano la larghezza completa',()=>{
 const placed=layoutIntervals([event('a',600,660),event('b',660,720)]);
 assert.ok(placed.every(e=>e.columns===1));
});
test('evento lungo e due eventi consecutivi riusano la colonna libera',()=>{
 const p=layoutIntervals([event('a',600,780),event('b',630,660),event('c',660,690)]);
 assert.equal(p.find(e=>e.id==='b').column,p.find(e=>e.id==='c').column);
 assert.ok(p.every(e=>e.columns===2));
});
test('un gruppo separato non eredita le colonne di quello precedente',()=>{
 const p=layoutIntervals([event('a',600,660),event('b',600,690),event('c',720,780)]);
 assert.equal(p.find(e=>e.id==='c').columns,1);
});
test('nessuna sovrapposizione assegna la stessa colonna agli eventi simultanei',()=>{
 const events=Array.from({length:40},(_,i)=>event(String(i),480+(i*17)%300,520+(i*17)%300));
 const p=layoutIntervals(events);
 for(const a of p)for(const b of p)if(a.id!==b.id&&a.start<b.end&&b.start<a.end)assert.notEqual(a.column,b.column);
 assert.equal(p.length,events.length);
});
test('gli orari sono di Roma, anche al cambio dell’ora',()=>{
 assert.equal(romeMinutes('2026-07-01T08:30:00Z'),630);
 assert.equal(romeMinutes('2026-11-02T09:30:00Z'),630);
 assert.equal(romeMinutes('2026-11-01T23:00:00Z'),0);
});
test('il conto alla rovescia usa il prossimo appuntamento valido e ignora quelli già trascorsi',()=>{
 const now=new Date('2026-11-25T12:15:20Z');
 const next=nextTimedEvent([
  {at:'2026-11-25T13:00:00Z'},
  {at:'2026-11-25T12:17:00Z',skipAsNext:true},
  {at:'2026-11-25T12:16:00Z',allDay:true},
  {at:'2026-11-25T12:14:00Z'},
  {at:'2026-11-25T12:32:00Z'},
 ],now);
 assert.equal(next.at,'2026-11-25T12:32:00Z');
 assert.equal(next.minutes,17);
 assert.equal(nextTimedEvent([{at:'2026-11-25T12:15:00Z'}],now).minutes,0);
 assert.equal(nextTimedEvent([{at:'2026-11-25T12:14:59Z'}],now),null);
});

test('ricerca lead anche oltre il primo migliaio, per accenti, telefono ed email', () => {
 const leads = Array.from({ length: 1100 }, () => ({name:'Altro',email:null,phone:null}));
 const lead = {name:'Caffè Élite',email:'info@elite.it',phone:'+39 333 123-4567'};
 leads.push(lead);
 for (const query of ['caffe elite', '3331234567', ' INFO@ELITE.IT ']) {
  const results = exports.calendarLeadMatches(leads, query);
  assert.equal(results.length, 1);
  assert.equal(results[0], lead);
 }
 assert.equal(exports.calendarLeadMatches(leads, '   ').length, 0);
});
