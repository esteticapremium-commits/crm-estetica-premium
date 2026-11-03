import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { withTimeout } from '../async';
import { romeToday, romeStamp } from '../dates';
import { dailyMetrics, parseDailyNumbers, reportDays, reportRange, sumDailyReports, type DailyMetric, type DailyReport } from '../dailySales';
import './DailySalesReport.css';
const blank = () => Object.fromEntries(dailyMetrics.map(([k]) => [k,''])) as Record<DailyMetric,string>;
const formatDay = (day:string) => day.split('-').reverse().join('/');
export default function DailySalesReportPage({clientId}:{clientId:string}) {
 const [day,setDay] = useState(romeToday);
 const [mode,setMode] = useState<'week'|'month'>('week');
 const [rows,setRows] = useState<DailyReport[]>([]);
 const [values,setValues] = useState(blank);
 const [notes,setNotes] = useState('');
 const [dirty,setDirty] = useState(false);
 const [loading,setLoading] = useState(true);
 const [busy,setBusy] = useState(false);
 const [error,setError] = useState('');
 const [message,setMessage] = useState('');
 const [reload,setReload] = useState(0);
 const saving = useRef(false);
 const range = reportRange(day,mode);
 const existing = rows.find(r => r.report_date === day);
 const today = romeToday();
 useEffect(() => {
  let current=true; setLoading(true); setError(''); setMessage('');
  (async () => {
   try {
    const {data,error:e} = await withTimeout(supabase.from('daily_sales_reports').select('*').eq('client_id',clientId).gte('report_date',range.from).lte('report_date',range.to).order('report_date'));
    if(e) throw e;
    if(!current) return;
    const result=(data || []) as DailyReport[]; setRows(result);
    const row=result.find(r=>r.report_date===day);
    setValues(row ? Object.fromEntries(dailyMetrics.map(([k])=>[k,row[k] == null ? "" : String(row[k])])) as Record<DailyMetric,string> : blank());
    setNotes(row?.notes || ''); setDirty(false);
   } catch(e) { if(current) setError(`Impossibile caricare i resoconti. ${e instanceof Error ? e.message : (e as {message?:string}).message || 'Riprova.'}`); }
   finally { if(current) setLoading(false); }
  })();
  return ()=>{current=false;};
 },[clientId,day,range.from,range.to,reload]);
 useEffect(()=>{
  if(!dirty) return;
  const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};
  window.addEventListener('beforeunload',warn);
  const guard=(e:MouseEvent)=>{ const target=e.target as Element; if(target.closest('.app-sidebar button,.sidebar button,nav[aria-label="Navigazione principale"] button') && !window.confirm('Hai modifiche non salvate. Vuoi lasciare il resoconto?')) { e.preventDefault();e.stopPropagation(); } };
  document.addEventListener('click',guard,true);
  return ()=>{window.removeEventListener('beforeunload',warn);document.removeEventListener('click',guard,true);};
 },[dirty]);
 function change(nextDay:string,nextMode=mode) {
  if(!nextDay || nextDay>today || (nextDay===day && nextMode===mode)) return;
  if(dirty && !window.confirm('Hai modifiche non salvate. Vuoi scartarle e cambiare vista?')) return;
  setDay(nextDay);setMode(nextMode);
 }
 async function save() {
  if(saving.current || loading || error) return;
  const parsed=parseDailyNumbers(values);
  if(!parsed) {setMessage('Compila tutte e sei le metriche con numeri interi da zero in su.');return;}
  saving.current=true;setBusy(true);setMessage('');
  try {
   const payload={...parsed,notes:notes.trim()};
   const query=existing ? supabase.from('daily_sales_reports').update(payload).eq('id',existing.id).eq('version',existing.version) : supabase.from('daily_sales_reports').insert({...payload,client_id:clientId,report_date:day});
   const {data,error:e}=await withTimeout(query.select('*').single());
   if(e) throw e;
   const row=data as DailyReport;
   setRows(previous=>[...previous.filter(r=>r.report_date!==day),row].sort((a,b)=>a.report_date.localeCompare(b.report_date)));
   setDirty(false);setMessage(`Giornata del ${formatDay(day)} salvata. Riepiloghi aggiornati.`);
  } catch(e) {setMessage(`Salvataggio non confermato: ${(e as {code?:string}).code==='23505' || (e as {code?:string}).code==='PGRST116' ? 'la giornata è stata già salvata o modificata da un’altra sessione. Ricarica i dati prima di correggerla.' : (e as {message?:string}).message || 'Riprova.'} I valori inseriti restano nella scheda.`);}
  finally {saving.current=false;setBusy(false);}
 }
 const totals=sumDailyReports(rows);
 const days=reportDays(range.from,range.to).filter(d=>d<=today);
 return <div className="page daily-report-page">
  <header className="daily-report-heading"><div><span className="eyebrow">CHIUSURA GIORNATA SALES</span><h1>Resoconto giornaliero</h1><p>Inserisci i risultati aziendali a fine giornata. Questo registro manuale è separato dai KPI automatici.</p></div></header>
  <div className="daily-report-date"><label>Giornata<input type="date" value={day} max={today} disabled={busy} onChange={e=>change(e.target.value)}/></label><button className="btn" disabled={busy} onClick={()=>change(today)}>Oggi</button><button className="btn" disabled={busy || loading} onClick={()=>{if(!dirty || window.confirm('Ricaricare e scartare le modifiche non salvate?')) setReload(v=>v+1);}}>Ricarica dati</button></div>
  {loading ? <p role="status">Caricamento resoconti…</p> : error ? <div className="notice err" role="alert">{error} Nessun valore viene considerato zero se non è stato salvato.</div> : <>
  <form className="panel daily-report-form" onSubmit={e=>{e.preventDefault();void save();}}>
   <div className="daily-report-section-title"><h2>{existing ? 'Modifica giornata' : 'Compila la giornata'}</h2><span>{existing ? `Salvato · ${romeStamp(existing.updated_at)}` : 'Non ancora compilata'}</span></div>
   <fieldset disabled={busy}><div className="daily-report-inputs">{dailyMetrics.map(([key,label])=><label key={key}>{label}<input type="number" min="0" max="2147483647" step="1" required inputMode="numeric" value={values[key]} placeholder="0" onChange={e=>{setValues(v=>({...v,[key]:e.target.value}));setDirty(true);setMessage('');}}/></label>)}</div>
   <p className="muted">Chiamate fatte = tentativi effettuati. Demo prenotate = appuntamenti fissati nella giornata, comprese le riprenotazioni dopo un no-show; conta ogni prenotazione una sola volta, non i semplici cambi di orario. Un no-show non è una demo svolta. Demo chiuse = chiusure positive della giornata, anche se la demo era stata svolta prima. Usa 0 solo per risultati effettivamente pari a zero.</p>
   <label>Nota sulla giornata <span className="muted">(facoltativa)</span><textarea maxLength={5000} rows={3} value={notes} onChange={e=>{setNotes(e.target.value);setDirty(true);}} placeholder="Cosa ha funzionato, ostacoli e cose da riprendere domani…"/></label></fieldset>
   <div className="daily-report-save"><span>{dirty ? 'Modifiche da salvare' : existing ? 'Giornata registrata' : 'Tutte le metriche sono obbligatorie'}</span><button className="btn primary" disabled={busy || (!!existing && !dirty)}>{busy ? 'Salvataggio…' : existing ? 'Aggiorna giornata' : 'Salva giornata'}</button></div>
  </form>
  {message && <p className="notice" role="status">{message}</p>}
  <section className="panel daily-report-summary"><div className="daily-report-section-title"><h2>Resoconto {mode==='week'?'settimanale':'mensile'}</h2><div className="view-switch"><button disabled={busy} aria-pressed={mode==='week'} onClick={()=>change(day,'week')}>Settimana</button><button disabled={busy} aria-pressed={mode==='month'} onClick={()=>change(day,'month')}>Mese</button></div></div>
   <p>{formatDay(range.from)} – {formatDay(range.to)} · {rows.length} giornate compilate su {days.length} trascorse.</p><p className="muted">Settimana lunedì–domenica · date Europe/Rome. I giorni non compilati sono esclusi dai totali; una metrica mancante nelle giornate salvate mostra — finché non viene completata; il periodo corrente è ancora in corso.</p>
   <div className="daily-report-totals">{dailyMetrics.map(([key,label])=><article key={key}><span>{label}</span><strong>{rows.length && totals[key] !== null ? totals[key]!.toLocaleString('it-IT') : '—'}</strong></article>)}</div>
   <div className="daily-report-table"><table><thead><tr><th>Giornata</th>{dailyMetrics.map(([k,l])=><th key={k}>{l}</th>)}<th>Stato</th></tr></thead><tbody>{[...days].reverse().map(d=>{const row=rows.find(r=>r.report_date===d);return <tr key={d}><th><button className="btn" disabled={busy} onClick={()=>change(d)}>{formatDay(d)}</button></th>{dailyMetrics.map(([k])=><td key={k}>{row ? row[k] ?? '—' : '—'}</td>)}<td>{row ? 'Salvata' : 'Non compilata'}</td></tr>;})}</tbody></table></div>
  </section></>}
 </div>;
}
