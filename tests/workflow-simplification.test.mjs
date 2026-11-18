import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function module(path, deps={}) { const exports={}; vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:name=>deps[name],Date,Map,Set}); return exports; }
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

for (const [type, stored, duration, googleDuration] of [['setting', 15, 15, 30], ['discovery', 60, 30, 30], ['discovery', null, 30, 30], ['demo', 60, 60, 60]]) {
  test(`spostamento ${type} da ${stored} minuti mantiene l’identità e usa ${googleDuration} minuti su Google`, async () => {
    const updates = [];
    const rpcCalls = [];
    const appointment = {
      id:'task', title:'Discovery telefonica — Centro', due_at:'2026-11-10T12:00:00Z',
      appointment_type:type, updated_at:'2026-11-08T12:00:00Z', google_event_id:'g1', duration_minutes:stored,
    };
    const appointments=module('src/appointments.ts',{
      './supabaseClient': {supabase:{async rpc(name,args){rpcCalls.push({name,args}); return {};}}},
      './calendarGoogle': {updateGoogleCalendarEvent:async(id,data)=>updates.push({id,data})},
    });
    const moved = new Date('2026-11-13T12:00:00Z');
    assert.equal((await appointments.updateAppointment(appointment,{subject:'Centro',startsAt:moved,note:''})).ok,true);
    assert.deepEqual(rpcCalls.map(call => call.name), ['reschedule_crm_appointment']);
    assert.equal(updates.length, 1);
    assert.equal(rpcCalls[0].args.p_task_id, appointment.id);
    assert.equal(rpcCalls[0].args.p_expected_updated_at, appointment.updated_at);
    assert.equal(rpcCalls[0].args.p_duration_minutes, duration);
    assert.equal(updates[0].id,'g1');
    assert.equal(updates[0].data.start,moved.toISOString());
    assert.equal(updates[0].data.end,new Date(moved.getTime() + googleDuration * 60_000).toISOString());
    assert.equal(updates[0].data.description,undefined);
  });
}

test('prenotazione propone alla transazione la stessa identità e la durata corretta', async () => {
  const requests=[];
  const googleEvents=[];
  const updateQuery={eq(){return this;},select(){return this;},async single(){return {};}};
  const appointments = module('src/appointments.ts',{
    './supabaseClient':{supabase:{
      async rpc(name,args){
        requests.push({name,args});
        return {data:{id:args.p_id, due_at:args.p_due_at, appointment_type:args.p_type, duration_minutes:args.p_minutes}};
      },
      from(){return {update(){return updateQuery;}};},
    }},
    './calendarGoogle':{
      ensureGoogleCalendarConnection:async()=>true,
      async createGoogleCalendarEvent(event){googleEvents.push(event);return {id:'g1'};},
    },
  });
  for (const [type,minutes,googleMinutes] of [['setting',15,30],['discovery',30,30],['demo',60,60]]) {
    const input={clientId:'company',lead:null,type,audience:'lead',subject:'Centro',startsAt:new Date('2026-11-18T12:00:00Z'),note:'',durationMinutes:type==='discovery' ? 60 : undefined,requestId:'uuid-'+type};
    const result=await appointments.createAppointment(input);
    assert.equal(result.taskId,input.requestId);
    assert.equal(result.warning,undefined);
    assert.equal(requests.at(-1).args.p_minutes,minutes);
    assert.equal(requests.at(-1).args.p_lead_id,null);
    assert.equal(Date.parse(googleEvents.at(-1).end)-Date.parse(googleEvents.at(-1).start),googleMinutes*60_000);
  }
});

test('la discovery fa avanzare solo le fasi iniziali e la closing parte dalla discovery', async () => {
  for (const [type,phase,next] of [['discovery','SETTING','DISCOVERY'],['discovery','CLOSING',null],['demo','DISCOVERY','CLOSING']]) {
    const changes=[];
    const db={
      async rpc(){return {data:{id:'booking',google_event_id:'linked'}};},
      from(table){
        const query={select(){return query;},eq(){return query;},
          async single(){return {data:{pipeline_id:'real-pipeline',stage_id:phase}};},
          async maybeSingle(){return {data:{id:'lead'}};},
          update(data){changes.push(data); return query;},
          then(resolve){resolve({data:table==='stages' ? ['SETTING','DISCOVERY','CLOSING'].map(name=>({id:name,name})) : null});},
        };
        return query;
      },
    };
    const appointments=module('src/appointments.ts',{
      './supabaseClient':{supabase:db}, './calendarGoogle':{},
      './leadPosition':{topLeadPosition:async(_client,_owner,pipeline)=>{assert.equal(pipeline,'real-pipeline');return -2;}},
    });
    const result=await appointments.createAppointment({clientId:'company',lead:{id:'lead'},type,audience:'lead',
      subject:'Centro',startsAt:new Date('2026-11-18T12:00:00Z'),note:'',requestId:'booking'});
    assert.equal(result.advancedStageId,next || undefined);
    assert.equal(changes[0].stage_id,next || undefined);
  }
});

test('l’esito conserva la versione dell’appuntamento e i minuti dichiarati', async () => {
  const requests=[];
  const appointments=module('src/appointments.ts',{
    './supabaseClient':{supabase:{async rpc(name,args){requests.push({name,args});return {data:[{id:args.p_id}]};}}},
    './calendarGoogle':{},
  });
  const task={id:'task',updated_at:'2026-11-10T10:00:00Z'};
  assert.equal((await appointments.recordAppointmentOutcome(task,'held',42,'  Nota  ')).ok,true);
  assert.equal(requests[0].name,'save_sales_appointment_outcome');
  assert.equal(requests[0].args.p_expected_updated_at,task.updated_at);
  assert.equal(requests[0].args.p_minutes,42);
  assert.equal(requests[0].args.p_note,'Nota');
});

const dailySales = module('src/dailySales.ts');
const googleSales = module('src/googleSales.ts');
const kpiRows = module('src/salesKpiRows.ts', {'./dates': dates, './googleSales': googleSales, './salesKpi': kpi});
const reporting = module('src/salesReporting.ts', {'./dates': dates, './dailySales': dailySales, './salesKpiRows': kpiRows, './salesKpi': kpi});

test('i no-show preannunciati entrano nel giorno della call senza gonfiare i tentativi', () => {
  const day = '2026-11-09';
  const startsAt = day + 'T16:00:00Z';
  const previous = '2026-11-08';
  const activities = ['setting', 'discovery', 'demo'].flatMap(type => {
    const event = {lead_id:type, details:{task_id:type}, scheduled_at:startsAt};
    return [
      {...event,id:type+'-booked',event_type:type+'_booked',occurred_at:previous+'T16:00:00Z'},
      {...event,id:type+'-outcome',event_type:type+'_call',outcome:'no_show',occurred_at:startsAt},
    ];
  });
  const standalone = [{id:'standalone',appointment_type:'demo',appointment_status:'no_show',appointment_outcome:'no_show',
    commercial_tracked:true,due_at:startsAt,created_at:previous+'T16:00:00Z'}];
  const externalSales = [{id:'external',appointment_type:'discovery',outcome:'no_show',early_no_show:true,starts_at:startsAt}];
  const tally = now => kpiRows.calculateKpiRows({activities,standalone,externalSales,outreach:[],revenue:[],range:{from:previous,to:day},now:new Date(now)}).rows;
  for (const now of [day+'T10:00:00Z',day+'T18:00:00Z']) {
    const rows = tally(now);
    const prior = rows.find(row => row.day === previous);
    const missed = rows.find(row => row.day === day);
    assert.equal(prior.noShow, 0);
    assert.equal(missed.noShow, 4);
    assert.equal(missed.discoveryScheduled, 2);
    assert.equal(missed.demoScheduled, 2);
    assert.equal(missed.discoveryHeld + missed.demoHeld, 0);
    assert.equal(kpiRows.phoneAttempts(missed), 0);
  }
});

test('il resoconto usa la data della call e conta un appuntamento una sola volta', () => {
  const booking = {id:'book', lead_id:'lead', event_type:'discovery_booked', occurred_at:'2026-11-08T21:00:00Z',
    scheduled_at:'2026-11-09T09:00:00Z', details:{task_id:'task'}};
  const outcome = {...booking,id:'outcome',event_type:'discovery_call',outcome:'qualified',occurred_at:'2026-11-12T09:00:00Z'};
  const data={activities:[booking,outcome],revenue:[],outreach:[],standalone:[],externalSales:[]};
  assert.equal(reporting.suggestDailyReport('2026-11-08',data).discovery_booked,1);
  assert.equal(reporting.suggestDailyReport('2026-11-09',data).discovery_held,1);
  assert.equal(reporting.suggestDailyReport('2026-11-12',data).discovery_held,0);
});

test('solo gli appuntamenti commerciali senza lead già classificati entrano nella giornata', () => {
  const appointment={lead_id:null,appointment_type:'demo',appointment_status:'held',commercial_tracked:true,
    created_at:'2026-11-08T11:00:00Z',due_at:'2026-11-13T11:00:00Z'};
  const data={activities:[],revenue:[],outreach:[],standalone:[appointment,{...appointment,commercial_tracked:false}],externalSales:[]};
  assert.equal(reporting.suggestDailyReport('2026-11-08',data).demo_booked,1);
  assert.equal(reporting.suggestDailyReport('2026-11-13',data).demo_held,1);
});

test('la verifica per trattativa usa il link esplicito e l’ordine degli orari', () => {
  const discovery={id:'disc',lead_id:'lead',event_key:'disc-outcome',event_type:'discovery_call',outcome:'qualified',occurred_at:'2026-11-09T10:00:00Z'};
  const booking={id:'book',lead_id:'lead',event_type:'demo_booked',occurred_at:'2026-11-09T11:00:00Z',details:{source_outcome_key:'disc-outcome'}};
  const compare = (rows) => reporting.linkedAppointmentRates(rows,[],[],[],'2026-11-09','2026-11-09');
  assert.equal(compare([discovery,booking,{...booking,id:'retry'}]).discovery.converted,1);
  assert.equal(compare([discovery,{...booking,details:{}}]).discovery.converted,0);
  assert.equal(compare([discovery,{...booking,occurred_at:'2026-11-09T09:00:00Z'}]).discovery.converted,0);
});

test('KPI vendite e resoconto concordano sui sei contatori con Pipeline, chiamate esterne e rate', () => {
  const day='2026-11-09';
  const instant=day+'T15:00:00Z';
  const activity=(id, event_type, outcome, details={})=>({id,lead_id:'a',event_type,outcome,details,occurred_at:instant});
  const google={id:'google',lead_id:'b',contact_name:'Centro B',appointment_type:'demo',revenue_type:'new',outcome:'won',
    starts_at:instant,booked_at:instant,collected_amount:300,contract_value:1900};
  const standalone={id:'standalone',appointment_type:'discovery',appointment_status:'no_show',commercial_tracked:true,
    title:'Call esterna',lead_id:null,created_at:instant,due_at:instant};
  const payment=(id,amount,lead_id,event_key)=>({id,revenue_type:'new',status:'collected',occurred_at:instant,lead_id,amount,event_key});
  const inputs={
    activities:[
      activity('book','demo_booked','scheduled',{task_id:'demo'}),
      activity('held','demo_call','held',{task_id:'demo'}),
      activity('qual','discovery_call','qualified'),
      activity('contact','discovery_call','no_answer'),
    ],
    outreach:[{id:'reply-book',lead_id:'a',event_type:'booking',occurred_at:instant}],
    standalone:[standalone],
    externalSales:[google],
    revenue:[payment('cash',500,'a'),payment('instalment',200,'a'),payment('g-cash',300,'b','google-sale:google')],
  };
  const {rows,evidence}=kpiRows.calculateKpiRows({...inputs,range:{from:day,to:day}});
  const suggested = reporting.suggestDailyReport(day,inputs);
  assert.deepEqual({...suggested}, {calls_made:3,discovery_booked:2,discovery_held:1,demo_booked:2,demo_held:2,demo_won:2});
  assert.deepEqual({...suggested}, {...kpiRows.dailyReportFromKpi(rows[0])});
  assert.equal(rows[0].collectedNew,1000);
  assert.equal(rows[0].noShow,1);
  assert.equal(evidence.filter(entry=>entry.kind==='discovery').length,2);
  const duplicate={...inputs,activities:[...inputs.activities,activity('crm-book','discovery_booked','scheduled')]};
  assert.equal(reporting.suggestDailyReport(day,duplicate).discovery_booked,2);
});

test('un setting entra solo nei tentativi telefonici, alla data fissata', () => {
  const callDay='2026-11-10';
  const bookingDay='2026-11-09';
  const ledger={
    id:'setting-call',lead_id:'lead',event_type:'setting_call',occurred_at:'2026-11-12T10:00:00Z',
    scheduled_at:callDay+'T11:00:00Z',details:{task_id:'setting'},call_type:'outbound',
  };
  const inputs={activities:[{
    ...ledger,id:'setting-booked',event_type:'setting_booked',occurred_at:bookingDay+'T15:00:00Z',
  }],outreach:[],standalone:[],externalSales:[],revenue:[]};
  const before=reporting.suggestDailyReport(bookingDay,inputs);
  assert.equal(before.calls_made,0);
  assert.equal(before.discovery_booked,0);
  for (const outcome of ['answered','no_answer','not_interested']) {
    const data={...inputs,activities:[...inputs.activities,{...ledger,outcome}]};
    const {rows}=kpiRows.calculateKpiRows({...data,range:{from:callDay,to:callDay}});
    const total=rows[0];
    assert.equal(total.callOutbound,1);
    assert.equal(total.settingContacts,1);
    assert.equal(total.prospectCallsAnswered,outcome==='no_answer' ? 0 : 1);
    assert.equal(total.noShow,0);
    assert.equal(total.discoveryScheduled,0);
    assert.equal(total.discoveryHeld,0);
    assert.equal(reporting.suggestDailyReport(callDay,data).calls_made,1);
  }
  const manualSetting = {...ledger,id:'manual-setting',details:{},occurred_at:callDay+'T14:00:00Z',outcome:'not_interested'};
  const ordinaryOutbound = {...manualSetting,id:'outbound',event_type:'discovery_call',outcome:'answered'};
  const data={...inputs,activities:[...inputs.activities,manualSetting,ordinaryOutbound]};
  const {rows}=kpiRows.calculateKpiRows({...data,range:{from:callDay,to:callDay}});
  assert.equal(rows[0].settingContacts,1);
  assert.equal(rows[0].callOutbound,2);
  assert.equal(reporting.suggestDailyReport(callDay,data).calls_made,2);
  assert.equal(rows[0].discoveryHeld,0);
});
