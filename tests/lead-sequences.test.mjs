import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('supabase/functions/_shared/sequence-policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,Date,Intl});
const {inSendingWindow,validateSteps,render,isStop,normalizePhone}=exports;
test('Roma: orari inverno, estate e domenica',()=>{
 assert.equal(inSendingWindow(new Date('2026-11-12T08:00:00Z')),true);
 assert.equal(inSendingWindow(new Date('2026-11-12T18:00:00Z')),false);
 assert.equal(inSendingWindow(new Date('2026-07-13T07:00:00Z')),true);
 assert.equal(inSendingWindow(new Date('2026-07-13T17:00:00Z')),false);
 assert.equal(inSendingWindow(new Date('2026-11-15T10:00:00Z')),false);
});
test('sequenze rifiutano contenuti incompleti e attese non valide',()=>{
 const s={channel:'email',delay_days:1,subject:'Ciao',body:'Ciao {{nome}}',template:'',language:'it'};
 validateSteps([s]);
 for(const delta of [-1,1.5,366,NaN])assert.throws(()=>validateSteps([{...s,delay_days:delta}]));
 assert.throws(()=>validateSteps([]));assert.throws(()=>validateSteps([{...s,body:''}]));
 assert.throws(()=>validateSteps([{...s,body:'{{risultato_inventato}}'}]));
 assert.throws(()=>validateSteps([{...s,channel:'whatsapp',template:''}]));
});
test('personalizzazione e stop espliciti',()=>{
 assert.equal(render('Ciao {{nome}}', 'Anna'),'Ciao Anna');
 assert.equal(isStop('STOP!'),true);assert.equal(isStop('Non interessata'),true);
 assert.equal(isStop('Quando possiamo sentirci?'),false);
 assert.equal(normalizePhone('+39 334 8496487'),'393348496487');
});
