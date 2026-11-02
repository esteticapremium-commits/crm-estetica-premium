import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function module(path, deps={}) { const exports={}; vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>deps[name],Date,Map,Set}); return exports; }
const notes=module('src/leadNotes.ts',{'./async':{withTimeout:async p=>p}});
function notesDb(initial, conflict=false, failure=null) {
 let stored=initial, writes=0;
 return {get value(){return stored;},get writes(){return writes;},from(){return {
 select(){return {eq(){return {single:async()=>({data:{notes:stored},error:null})}}}},
 update(payload){let expected; const query={eq(key,value){if(key==='notes')expected=value;return query;},is(key,value){expected=value;return query;},async select(){writes++;if(failure)return {error:{message:failure}};if(conflict){stored='Nota Giovanni';conflict=false;}if(stored!==expected)return {data:[],error:null};stored=payload.notes;return {data:[{id:'lead'}],error:null};}};return query;}
 }}};
}
test('append conserva lo storico',async()=>{const db=notesDb('Prima nota');await notes.appendLeadNote(db,'lead','Nuova nota');assert.equal(db.value,'Nuova nota\n\n---\n\nPrima nota');});
test('una scrittura concorrente non viene sovrascritta',async()=>{const db=notesDb('Prima nota',true);await notes.appendLeadNote(db,'lead','Nota Ettore');assert.equal(db.value,'Nota Ettore\n\n---\n\nNota Giovanni');assert.equal(db.writes,2);});
test('gestisce uno storico null',async()=>{const db=notesDb(null);await notes.appendLeadNote(db,'lead','Nuova nota');assert.equal(db.value,'Nuova nota');});
test('errore RLS rimane errore',async()=>{const db=notesDb('Prima nota',false,'permission denied');await assert.rejects(notes.appendLeadNote(db,'lead','Nuova'),/permission denied/);assert.equal(db.value,'Prima nota');});
const dates=module('src/dates.ts');
const work=module('src/leadWork.ts',{'./dates':dates});
const lead={id:'a',next_action_date:null};
const task=(id,due,extra={})=>({id,lead_id:'a',due_at:due,completed_at:null,...extra});
test('prossimo passo ignora appuntamenti annullati e attività completate',()=>{const steps=work.nextSteps([task('cancel','2026-11-01T10:00:00Z',{appointment_status:'cancelled'}),task('done','2026-11-01T09:00:00Z',{completed_at:'2026-11-01T10:00:00Z'}),task('valid','2026-11-02T09:00:00Z')]);assert.equal(steps.get('a').id,'valid');});
test('richiami oggi usa il giorno di Roma',()=>{assert.equal(work.matchesWork(lead,[task('a','2026-11-01T23:30:00Z')],'today','2026-11-02',false),true);});
test('una closing non è un richiamo',()=>{assert.equal(work.matchesWork(lead,[task('a','2026-11-02T10:00:00Z',{appointment_type:'demo'})],'today','2026-11-02',false),false);});
test('lead chiusi non alimentano le code operative',()=>{assert.equal(work.matchesWork(lead,[],'missing','2026-11-02',true),false);});
test('data storica rimane visibile in assenza di task',()=>{assert.equal(work.matchesWork({...lead,next_action_date:'2026-11-01'},[],'overdue','2026-11-02',false),true);});
test('tutti i richiami del giorno sono rilevati anche se esiste un arretrato',()=>{assert.equal(work.matchesWork(lead,[task('old','2026-10-30T09:00:00Z'),task('new','2026-11-02T09:00:00Z')],'today','2026-11-02',false),true);});
const kpi=module('src/salesKpi.ts');
test('ads e cold call non diventano DM',()=>{assert.equal(kpi.normalizedLeadSource('Facebook Ads'),'ads');assert.equal(kpi.normalizedLeadSource('Cold call'),'cold_call');assert.equal(kpi.normalizedLeadSource('DM Facebook'),'dm');assert.equal(kpi.normalizedLeadSource('Instantly'),'instantly');});
test('esito appuntamento conserva nota, data originale e chiave unica',async()=>{
 const records=[];
 const db={from(table){return {update(){return {eq:async()=>({error:null})}},async upsert(data,options){records.push({table,data,options});return {error:null}}}}};
 const appointments=module('src/appointments.ts',{'./supabaseClient':{supabase:db},'./calendarGoogle':{}});
 const task={id:'meeting',lead_id:'lead',client_id:'company',appointment_type:'demo',due_at:'2026-10-30T10:00:00Z',assigned_to:'Giovanni',audience:'lead'};
 const result=await appointments.recordAppointmentOutcome(task,'held','Ettore','pipeline',30,'  Vuole ricevere la proposta  ');
 assert.equal(result.ok,true);assert.equal(records[0].data.note,'Vuole ricevere la proposta');assert.equal(records[0].data.occurred_at,task.due_at);assert.equal(records[0].data.event_key,'appointment:meeting:outcome');assert.equal(records[0].options.onConflict,'client_id,event_key');
});
