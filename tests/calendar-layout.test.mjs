import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('src/calendarLayout.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,Date,Intl});
const {layoutIntervals,romeMinutes}=exports;
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
