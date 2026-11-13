import { checked, checkAdmin, clientId, db, gmail, json, required } from '../_shared/sequence-server.ts';
Deno.serve(async req=>{
 if(req.method==='OPTIONS') return json(req,{});
 if(req.method!=='POST') return json(req,{error:'Metodo non consentito'},405);
 try {
 await checkAdmin(req); const input=await req.json();
 if(input.action==='status') {
 const c=await checked(db().from('lead_sequence_mailboxes').select('email,synced_at').eq('client_id',clientId()).maybeSingle());
 return json(req,{mailbox:c,live:Deno.env.get('SEQUENCE_LIVE')==='true',whatsappConfigured:!!Deno.env.get('SEQUENCE_META_TOKEN'),emailConfigured:!!Deno.env.get('SEQUENCE_RESEND_KEY')});
 }
 if(input.action!=='exchange'||req.headers.get('origin')!==required('SEQUENCE_APP_ORIGIN')||req.headers.get('x-requested-with')!=='XmlHttpRequest') return json(req,{error:'Richiesta non valida'},400);
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code:input.code,client_id:required('SEQUENCE_GOOGLE_CLIENT_ID'),client_secret:required('SEQUENCE_GOOGLE_CLIENT_SECRET'),redirect_uri:required('SEQUENCE_APP_ORIGIN'),grant_type:'authorization_code'})});
 const t=await response.json(); if(!response.ok||!t.access_token||!t.refresh_token) throw new Error('Google non ha autorizzato il collegamento permanente. Ripeti il consenso.');
 const p=await gmail(t.access_token,'profile');
 if(p.emailAddress.toLowerCase()!==required('SEQUENCE_MAILBOX').toLowerCase()) throw new Error('Collega la casella dedicata configurata, non quella personale.');
 await checked(db().from('lead_sequence_mailboxes').upsert({client_id:clientId(),email:p.emailAddress,refresh_token:t.refresh_token,history_id:p.historyId,synced_at:new Date().toISOString()}));
 return json(req,{connected:true,email:p.emailAddress});
 }catch(error){return json(req,{error:String(error)},400);}
});
