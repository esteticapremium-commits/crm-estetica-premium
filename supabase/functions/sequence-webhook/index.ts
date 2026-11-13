import { Webhook } from 'https://esm.sh/svix@1.42.0';
import { checked, clientId, db, receive, required } from '../_shared/sequence-server.ts';
import { isStop, normalizePhone } from '../_shared/sequence-policy.ts';
Deno.serve(async req=>{
 const url=new URL(req.url);
 try {
 const unsub=url.searchParams.get('unsubscribe');
 if(unsub) {
 if(!/^[0-9a-f-]{36}$/i.test(unsub)) return new Response('Link non valido',{status:400});
 if(req.method==='GET') return new Response('<!doctype html><html lang="it"><meta charset="utf-8"><title>Disiscrizione</title><h1>Non vuoi più ricevere messaggi?</h1><form method="POST"><button>Conferma disiscrizione</button></form></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}});
 if(req.method!=='POST') return new Response('Metodo non consentito',{status:405});
 const m=await checked(db().from('lead_sequence_messages').select('lead_id').eq('client_id',clientId()).eq('unsubscribe_token',unsub).maybeSingle());
 if(m) await receive(m.lead_id,'email',`unsubscribe:${unsub}`,'unsubscribe','Disiscrizione');
 return new Response('Disiscrizione registrata. Non riceverai altri messaggi automatici.');
 }
 if(req.method==='GET'&&url.searchParams.get('hub.mode')==='subscribe'&&url.searchParams.get('hub.verify_token')===required('SEQUENCE_META_VERIFY_TOKEN')) return new Response(url.searchParams.get('hub.challenge'));
 if(req.method!=='POST') return new Response('Metodo non consentito',{status:405});
 const raw=await req.text(); let data:any;
 if(url.searchParams.get('provider')==='resend') {
 try {data=new Webhook(required('SEQUENCE_RESEND_WEBHOOK_SECRET')).verify(raw,{'svix-id':req.headers.get('svix-id')||'','svix-timestamp':req.headers.get('svix-timestamp')||'','svix-signature':req.headers.get('svix-signature')||''});}catch{return new Response('Firma non valida',{status:401});}
 const m=await checked(db().from('lead_sequence_messages').select('id,lead_id').eq('client_id',clientId()).eq('channel','email').eq('provider_id',data.data?.email_id||'').maybeSingle());
 if(m) {
 const kind=({'email.bounced':'bounced','email.complained':'complained'} as Record<string,string>)[data.type];
 if(kind) await receive(m.lead_id,'email',req.headers.get('svix-id')!,kind,'');
 if(data.type==='email.delivered') await checked(db().from('lead_sequence_messages').update({status:'delivered'}).eq('id',m.id).eq('status','sent'));
 }
 }else {
 const hex=req.headers.get('x-hub-signature-256')?.replace(/^sha256=/,'')||'';
 if(!/^[a-f0-9]{64}$/.test(hex)) return new Response('Firma non valida',{status:401});
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(required('SEQUENCE_META_APP_SECRET')),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const valid=await crypto.subtle.verify('HMAC',key,Uint8Array.from(hex.match(/../g)!,x=>parseInt(x,16)),new TextEncoder().encode(raw));
 if(!valid) return new Response('Firma non valida',{status:401}); data=JSON.parse(raw);
 for(const entry of data.entry||[]) for(const change of entry.changes||[]) {
 const value=change.value; if(value?.metadata?.phone_number_id!==required('SEQUENCE_META_PHONE_ID')) continue;
 for(const msg of value.messages||[]) {
 const body=msg.text?.body||msg.button?.text||msg.interactive?.button_reply?.title||`[${msg.type}]`;
 await checked(db().rpc('sequence_receive_contact',{p_client:clientId(),p_contact:normalizePhone(msg.from),p_channel:'whatsapp',p_external:msg.id,p_kind:isStop(body)?'unsubscribe':'reply',p_body:body.slice(0,10000)}));
 }
 for(const status of value.statuses||[]) {
 const m=await checked(db().from('lead_sequence_messages').select('id,status,enrollment_id').eq('client_id',clientId()).eq('channel','whatsapp').eq('provider_id',status.id).maybeSingle());
 if(m&&['delivered','read','failed'].includes(status.status)) {
 const rank:Record<string,number>={sending:0,sent:1,delivered:2,read:3,failed:4,uncertain:0};
 if(rank[status.status]>rank[m.status]) {
 await checked(db().from('lead_sequence_messages').update({status:status.status,error:status.status==='failed'?'Consegna WhatsApp fallita':null}).eq('id',m.id));
 if(status.status==='failed') await checked(db().from('lead_sequence_enrollments').update({status:'error'}).eq('id',m.enrollment_id).eq('status','active'));
 }
 }
 }
 }
 }
 return new Response('ok');
 }catch{return new Response('Elaborazione non completata: riprovare',{status:500});}
});
