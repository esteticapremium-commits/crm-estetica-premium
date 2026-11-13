import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
export const db = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
export function required(name: string) { const value = Deno.env.get(name); if (!value) throw new Error(`Configurazione mancante: ${name}`); return value; }
export function clientId() { return required('SEQUENCE_CLIENT_ID'); }
export function cors(req: Request) { return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': Deno.env.get('SEQUENCE_APP_ORIGIN') || 'http://localhost:5173', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-requested-with', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' }; }
export function json(req: Request, body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: cors(req) }); }
export async function checkAdmin(req: Request) {
 const token = req.headers.get('authorization')?.replace(/^Bearer /i,'') || '';
 const { data, error } = await db().auth.getUser(token);
 if (error || !data.user) throw new Error('Accesso non autorizzato');
 const { data: profile } = await db().from('profiles').select('role').eq('id',data.user.id).single();
 if (profile?.role !== 'admin') throw new Error('Accesso non autorizzato');
}
export function checkRunner(req: Request) { return req.headers.get('authorization') === `Bearer ${required('SEQUENCE_RUNNER_SECRET')}`; }
export async function checked<T>(result: PromiseLike<{data:T;error:unknown}>) { const r=await result; if(r.error) throw new Error('Operazione database non riuscita'); return r.data; }
export async function receive(lead: string, channel: string, external: string, kind: string, body: string) {
 await checked(db().rpc('sequence_receive',{p_client:clientId(),p_lead:lead,p_channel:channel,p_external:external,p_kind:kind,p_body:body.slice(0,10000)}));
}
export async function googleToken(refresh: string) {
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:required('SEQUENCE_GOOGLE_CLIENT_ID'),client_secret:required('SEQUENCE_GOOGLE_CLIENT_SECRET'),refresh_token:refresh,grant_type:'refresh_token'})});
 const t=await r.json(); if(!r.ok||!t.access_token) throw new Error('Ricollegare la casella email'); return t.access_token as string;
}
export async function gmail(token:string,path:string) {
 const r=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{headers:{Authorization:`Bearer ${token}`}});
 if(!r.ok) throw new Error(`Sincronizzazione Gmail interrotta (${r.status}); ricollegare se la cronologia è scaduta`); return r.json();
}
export async function syncMailbox() {
 const c=await checked(db().from('lead_sequence_mailboxes').select('*').eq('client_id',clientId()).single());
 if(!c) throw new Error('Collega prima la casella email');
 const token=await googleToken(c.refresh_token); let page:string|undefined; let history=c.history_id;
 // Cursor avanzato solo dopo aver elaborato tutte le pagine; eventi deduplicati nel DB.
 do {
 const q=new URLSearchParams({startHistoryId:c.history_id,historyTypes:'messageAdded',maxResults:'100'}); if(page) q.set('pageToken',page);
 const result=await gmail(token,`history?${q}`);
 for(const item of result.history||[]) for(const added of item.messagesAdded||[]) {
 const message=await gmail(token,`messages/${added.message.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted`);
 if(message.labelIds?.includes('SENT')||message.labelIds?.includes('DRAFT')) continue;
 const headers=message.payload?.headers||[];
 const header=(n:string)=>headers.find((h:{name:string})=>h.name.toLowerCase()===n.toLowerCase())?.value||'';
 if(header('Auto-Submitted') && header('Auto-Submitted')!=='no') continue;
 const from=header('From'); const address=(from.match(/<([^>]+)>/)?.[1]||from).trim().toLowerCase();
 // Uguaglianza, non filtro interpolato: niente wildcard nel mittente.
 await checked(db().rpc('sequence_receive_contact',{p_client:clientId(),p_contact:address,p_channel:'email',p_external:`gmail:${message.id}`,p_kind:'reply',p_body:header('Subject')}));
 }
 history=result.historyId||history; page=result.nextPageToken;
 }while(page);
 await checked(db().from('lead_sequence_mailboxes').update({history_id:history,synced_at:new Date().toISOString()}).eq('client_id',clientId()).eq('history_id',c.history_id));
 return c.email as string;
}
