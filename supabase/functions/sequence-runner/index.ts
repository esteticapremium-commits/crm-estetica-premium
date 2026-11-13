import { checked, checkAdmin, checkRunner, clientId, db, json, required, syncMailbox } from '../_shared/sequence-server.ts';
import { inSendingWindow, normalizePhone, render, validateSteps } from '../_shared/sequence-policy.ts';
Deno.serve(async req=>{
 if(req.method==='OPTIONS') return json(req,{});
 if(req.method!=='POST') return json(req,{error:'Metodo non consentito'},405);
 let lease:string|null=null;
 try {
 const input=await req.json().catch(()=>({}));
 if(input.action==='preview') {
 await checkAdmin(req); validateSteps(input.steps);
 return json(req,{simulation:true,messages:input.steps.map((s:any)=>({...s,body:render(s.body,'Lead di prova'),subject:render(s.subject,'Lead di prova')})),note:'Nessun invio effettuato. Gli intervalli sono attese dopo il passaggio precedente.'});
 }
 if(!checkRunner(req)) return json(req,{error:'Accesso non autorizzato'},401);
 // Interruttore server: il default non effettua neppure iscrizioni reali.
 if(Deno.env.get('SEQUENCE_LIVE')!=='true') return json(req,{simulation:true,sent:0});
 lease=await checked(db().rpc('sequence_worker_acquire',{p_client:clientId()}));
 if(!lease) return json(req,{sent:0,reason:'Elaborazione già in corso'});
 const config=await checked(db().from('lead_automation_settings').select('*').eq('client_id',clientId()).maybeSingle());
 if(!config||config.paused)return json(req,{sent:0,reason:'Automazioni in pausa generale'});
 const replyTo=await syncMailbox();
 if(!inSendingWindow()) return json(req,{sent:0,reason:'Fuori fascia oraria'});
 required('SEQUENCE_RESEND_KEY'); required('SEQUENCE_FROM');
 const cap=Math.min(10000,Math.max(1,Number(required('SEQUENCE_DAILY_LIMIT'))));
 if(!Number.isFinite(cap)) throw new Error('Limite giornaliero non valido');
 await checked(db().rpc('sequence_enroll',{p_client:clientId()}));
 let sent=0;
 for(let i=0;i<20;i++) {
 if(i>0) await new Promise(resolve=>setTimeout(resolve,650));
 // Il limite globale è controllato anche dal claim atomico nel DB (parametro).
 const job=await checked(db().rpc('sequence_claim',{p_client:clientId(),p_limit:cap})); if(!job) break;
 const {message:m,lead,step}=job;
 let attempted=false;
 try {
 validateSteps([step]);
 // Rileggi lo stato immediatamente prima della richiesta esterna.
 const e=await checked(db().from('lead_sequence_enrollments').select('status,sequence_id').eq('id',m.enrollment_id).single());
 const pref=await checked(db().from('lead_sequence_preferences').select('*').eq('lead_id',lead.id).single());
 if(!e||!pref||e.status!=='active'||pref.suppressed||!pref[step.channel+'_consent']) throw new Error('Invio annullato: lead non più idoneo');
 const sequence=await checked(db().from('lead_sequences').select('active,approved').eq('id',e.sequence_id).single());
 const settings=await checked(db().from('lead_automation_settings').select('paused').eq('client_id',clientId()).single());
 if(!sequence||!settings||!sequence.active||!sequence.approved||settings.paused)throw new Error('Invio annullato: automazione in pausa');
 let response:Response;
 if(step.channel==='email') {
 const unsubscribe=`${required('SUPABASE_URL')}/functions/v1/sequence-webhook?unsubscribe=${m.unsubscribe_token}`;
 if(!lead.email) throw new Error('Indirizzo email mancante');
 attempted=true;
 response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${required('SEQUENCE_RESEND_KEY')}`,'Content-Type':'application/json','Idempotency-Key':m.id},body:JSON.stringify({from:required('SEQUENCE_FROM'),to:[lead.email],reply_to:replyTo,subject:m.subject,text:`${m.body}\n\nPer non ricevere più messaggi: ${unsubscribe}`,headers:{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}})});
 } else {
 const phone=normalizePhone(lead.phone||''); if(!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Numero WhatsApp non valido: usare il prefisso internazionale');
 const version=required('SEQUENCE_META_VERSION'); const phoneId=required('SEQUENCE_META_PHONE_ID'); const token=required('SEQUENCE_META_TOKEN');
 attempted=true;
 response=await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'template',template:{name:step.template,language:{code:step.language||'it'},components:/{{nome\s*}}/.test(step.body)?[{type:'body',parameters:[{type:'text',text:lead.name||'cliente'}]}]:[]},biz_opaque_callback_data:m.id})});
 }
 const result=await response.json();
 if(!response.ok) {
 await checked(db().rpc('sequence_finish',{p_message:m.id,p_provider:null,p_status:response.status>=500?'uncertain':'failed',p_error:`Provider HTTP ${response.status}; controllare configurazione e quote`}));
 if(response.status===429||response.status>=500) break;
 continue;
 }
 const provider=step.channel==='email'?result.id:result.messages?.[0]?.id;
 if(!provider) throw new Error('Risposta provider senza identificativo');
 await checked(db().rpc('sequence_finish',{p_message:m.id,p_provider:provider,p_status:'sent'})); sent++;
 }catch(error){
 await checked(db().rpc('sequence_finish',{p_message:m.id,p_provider:null,p_status:attempted?'uncertain':'failed',p_error:attempted?'Esito da verificare presso il provider':String(error)}));
 if(attempted) break;
 }
 }
 return json(req,{sent});
 }catch(error){return json(req,{error:String(error)},503);}
 finally{if(lease) await db().rpc('sequence_worker_release',{p_client:clientId(),p_token:lease});}
});
