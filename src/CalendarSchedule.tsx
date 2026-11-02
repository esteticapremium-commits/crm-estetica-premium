import { useState } from "react";
import { romeDay, romeToday } from "./dates";
import { layoutIntervals, romeMinutes } from "./calendarLayout";
export type DisplayEvent = { id:string; at:string; endAt:string; title:string; subtitle:string; kind:"crm"|"google"; allDay?:boolean; onOpen:()=>void };
export default function CalendarSchedule({days,events,onCreate}: {days:Date[];events:DisplayEvent[];onCreate:(date:Date)=>void}) {
  const [view,setView] = useState<"week"|"agenda">(() => window.matchMedia("(max-width: 760px)").matches ? "agenda" : "week");
  const forDay = (day:string) => events.filter(e => {
    const start = e.allDay ? e.at.slice(0,10) : romeDay(e.at);
    // Google all-day end dates are exclusive, as are timed midnight endings.
    const end = e.allDay ? e.endAt.slice(0,10) : romeDay(new Date(new Date(e.endAt).getTime()-1));
    return start <= day && (e.allDay ? day < end : day <= end);
  });
  const placed = days.map(date => {
    const day = romeDay(date);
    return layoutIntervals(forDay(day).filter(e => !e.allDay).map(e => {
      const start = romeDay(e.at) < day ? 0 : romeMinutes(e.at);
      const end = romeDay(e.endAt) > day ? 1440 : romeMinutes(e.endAt);
      return {...e,start,end:Math.min(1440,Math.max(start+30,end))};
    }));
  });
  const startHour = Math.min(8, ...placed.flat().map(e => Math.floor(e.start/60)));
  const endHour = Math.max(20, ...placed.flat().map(e => Math.ceil(e.end/60)));
  const hours = Array.from({length:endHour-startHour+1},(_,i)=>i+startHour);
  const eventButton = (event:DisplayEvent) => <button className={`schedule-event ${event.kind}`} onClick={event.onOpen} title={`${event.title} · ${event.subtitle}`}><time>{event.allDay ? "Tutto il giorno" : new Date(event.at).toLocaleTimeString("it-IT",{timeZone:"Europe/Rome",hour:"2-digit",minute:"2-digit"})}</time><b>{event.title}</b><small>{event.subtitle}</small></button>;
  return <><div className="schedule-controls"><div className="view-switch"><button aria-pressed={view==="week"} onClick={()=>setView("week")}>Settimana</button><button aria-pressed={view==="agenda"} onClick={()=>setView("agenda")}>Agenda</button></div><small>Orari Europe/Rome · clicca un evento per aprirlo</small></div>
    {view === "agenda" ? <div className="schedule-agenda">{days.map(date => <section key={romeDay(date)}><header><b>{date.toLocaleDateString("it-IT",{weekday:"long",day:"numeric",month:"long"})}</b><button className="btn" onClick={()=>onCreate(date)}>+ Appuntamento</button></header>{forDay(romeDay(date)).sort((a,b)=>a.at.localeCompare(b.at)).map(event=><div key={event.id}>{eventButton(event)}</div>)}{!forDay(romeDay(date)).length && <p className="muted">Nessun appuntamento</p>}</section>)}</div> : <div className="schedule-scroll"><div className="schedule-week"><div className="schedule-head"><div className="schedule-zone">Roma</div>{days.map((date,index)=><header key={romeDay(date)} className={romeDay(date)===romeToday()?"today":""}><span>{date.toLocaleDateString("it-IT",{weekday:"short"})}</span><b>{date.getDate()}</b><button onClick={()=>onCreate(date)} aria-label={`Aggiungi il ${date.toLocaleDateString("it-IT")}`}>+</button>{placed[index].some(e=>e.columns>2) && <button className="schedule-dense-link" onClick={()=>setView("agenda")}>Vedi {placed[index].length} eventi in agenda</button>}{forDay(romeDay(date)).filter(e=>e.allDay).map(e=><div key={e.id}>{eventButton(e)}</div>)}</header>)}</div><div className="schedule-grid" style={{height:(endHour-startHour)*72}}><div className="schedule-hours">{hours.map(hour=><span key={hour} style={{top:(hour-startHour)*72}}>{String(hour).padStart(2,"0")}:00</span>)}</div>{days.map((date,index)=><div className="schedule-day" key={romeDay(date)}>{placed[index].map(event=><div className="schedule-position" key={event.id} style={{top:(event.start-startHour*60)*1.2,height:(event.end-event.start)*1.2,left:`${event.column*100/event.columns}%`,width:`${100/event.columns}%`}}>{eventButton(event)}</div>)}</div>)}</div></div></div>}
  </>;
}
