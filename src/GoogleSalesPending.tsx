import { loadGoogleSales } from "./googleSalesData";
import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { withTimeout } from './async';
import { saleNeedsAction, saleOutcomes, type GoogleSale } from './googleSales';
import type { Lead } from './types';
import GoogleSaleModal from './GoogleSaleModal';
export default function GoogleSalesPending({clientId, admin, onOpenCalendar}: {clientId:string; admin:boolean; onOpenCalendar:()=>void}) {
  const [rows,setRows]=useState<GoogleSale[]>([]); const [leads,setLeads]=useState<Lead[]>([]);
  const [selected,setSelected]=useState<GoogleSale|null>(null); const [reload,setReload]=useState(0);
  const [error,setError]=useState(''); const [loading,setLoading]=useState(true);
  useEffect(()=>{let active=true;setLoading(true);setError('');
    void withTimeout(Promise.all([
      loadGoogleSales(clientId),
      supabase.from('leads').select('*').eq('client_id',clientId),
    ])).then(([r,l])=>{if(!active)return;if(r.error||l.error)throw new Error(r.error?.message||l.error?.message);setRows((r.data||[]) as GoogleSale[]);setLeads((l.data||[]) as Lead[]);})
      .catch(()=>{if(active)setError('Appuntamenti Google commerciali non disponibili. Riprova ad aggiornare.');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[clientId,reload]);
  const pending=rows.filter(r=>saleNeedsAction(r)).sort((a,b)=>(a.next_action_at||a.starts_at).localeCompare(b.next_action_at||b.starts_at));
  return <section className="panel google-sales-pending"><header><div><h2>Appuntamenti di vendita da completare</h2><p>Call Google classificate come commerciali e prossimi passi scaduti.</p></div><button className="btn" onClick={()=>setReload(n=>n+1)} disabled={loading}>Aggiorna</button></header>
    {error ? <p role="alert">{error}</p> : loading ? <p>Caricamento…</p> : pending.length ? pending.map(s=><div className="google-sale-row" key={s.id}><div><b>{s.contact_name}</b><small>{saleOutcomes[s.outcome]} · {new Date(s.next_action_at||s.starts_at).toLocaleString('it-IT',{timeZone:'Europe/Rome',dateStyle:'short',timeStyle:'short'})} · {s.assigned_to}</small></div><button className="btn" onClick={()=>setSelected(s)}>Registra esito</button></div>) : <p>Nessun appuntamento classificato richiede un esito o un follow-up oggi.</p>}
    <button className="btn" onClick={onOpenCalendar}>Apri calendario · classifica una call</button>
    {selected&&<GoogleSaleModal clientId={clientId} sale={selected} leads={leads} admin={admin} onClose={()=>setSelected(null)} onSaved={()=>{setSelected(null);setReload(n=>n+1);}}/>}
  </section>;
}
