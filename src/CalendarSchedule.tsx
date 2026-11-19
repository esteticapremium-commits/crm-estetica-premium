import { type CSSProperties } from "react";
import { romeDay, romeToday } from "./dates";
import { layoutIntervals, romeMinutes } from "./calendarLayout";

export type DisplayEvent = {
  id: string;
  at: string;
  endAt: string;
  title: string;
  subtitle: string;
  kind: "crm" | "google";
  allDay?: boolean;
  onOpen: () => void;
};

const hourHeight = 100;
const labelWidth = 64;
const timeFormat = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });

function EventButton({ event, compact = false }: { event: DisplayEvent; compact?: boolean }) {
  const time = event.allDay ? "Tutto il giorno" : timeFormat.format(new Date(event.at));
  return <button type="button" className={`schedule-event ${event.kind}${compact ? " compact" : ""}`}
    onClick={event.onOpen} title={event.title} aria-label={`${time} · ${event.title} · ${event.subtitle}`}>
    <time dateTime={event.at}>{time}</time>
    <b>{event.title}</b>
    {!compact && <small>{event.subtitle}</small>}
  </button>;
}

export type CalendarView = "week" | "agenda";
export default function CalendarSchedule({ days, events, onCreate, view, onViewChange }: {
  days: Date[];
  events: DisplayEvent[];
  onCreate: (date: Date) => void;
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
}) {
  const forDay = (day: string) => events.filter(event => {
    const start = event.allDay ? event.at.slice(0, 10) : romeDay(event.at);
    // Google all-day end dates are exclusive, as are timed midnight endings.
    const end = event.allDay ? event.endAt.slice(0, 10) : romeDay(new Date(Date.parse(event.endAt) - 1));
    return start <= day && (event.allDay ? day < end : day <= end);
  });
  const week = days.map(date => {
    const day = romeDay(date);
    const dailyEvents = forDay(day).sort((a, b) => a.at.localeCompare(b.at));
    const placed = layoutIntervals(dailyEvents.filter(event => !event.allDay).map(event => {
      const start = romeDay(event.at) < day ? 0 : romeMinutes(event.at);
      const end = romeDay(event.endAt) > day ? 1440 : romeMinutes(event.endAt);
      return { ...event, start, end: Math.min(1440, Math.max(start + 30, end)) };
    }));
    const lanes = Math.max(1, ...placed.map(event => event.columns));
    return { day, date, dailyEvents, placed, lanes, minWidth: Math.max(134, lanes * 96) };
  });
  const timedEvents = week.flatMap(({ placed }) => placed);
  const startHour = Math.min(8, ...timedEvents.map(event => Math.floor(event.start / 60)));
  const endHour = Math.max(20, ...timedEvents.map(event => Math.ceil(event.end / 60)));
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, index) => startHour + index);
  const positionAt = (minute: number) => (minute / 60 - startHour) * hourHeight;
  const weekStyle = {
    minWidth: week.reduce((sum, day) => sum + day.minWidth, labelWidth),
    "--schedule-columns": `${labelWidth}px ${week.map(({ minWidth }) => `minmax(${minWidth}px, 1fr)`).join(" ")}`,
    "--schedule-hour": `${hourHeight}px`,
  } as CSSProperties;

  return <>
    {view === "agenda" ? <div className="schedule-agenda">
      {week.map(({ day, date, dailyEvents }) => <section key={day}>
        <header>
          <b>{date.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}</b>
          <button className="btn" type="button" onClick={() => onCreate(date)}>+ Appuntamento</button>
        </header>
        {dailyEvents.map(event => <div key={event.id}><EventButton event={event} /></div>)}
        {!dailyEvents.length && <p className="muted">Nessun appuntamento</p>}
      </section>)}
    </div> : <div className="schedule-scroll">
      <div className="schedule-week" style={weekStyle}>
        <div className="schedule-head">
          <div className="schedule-zone">Roma</div>
          {week.map(({ day, date, lanes, dailyEvents }) => <header key={day} className={day === romeToday() ? "today" : ""}>
            <span>{date.toLocaleDateString("it-IT", { weekday: "short" })}</span>
            <b>{date.getDate()}</b>
            <button type="button" onClick={() => onCreate(date)} aria-label={`Aggiungi il ${date.toLocaleDateString("it-IT")}`}>+</button>
            {lanes > 2 && <button type="button" className="schedule-dense-link" onClick={() => onViewChange("agenda")}>Vedi {dailyEvents.length} eventi in agenda</button>}
            {dailyEvents.filter(event => event.allDay).map(event => <div key={event.id}><EventButton event={event} /></div>)}
          </header>)}
        </div>
        <div className="schedule-grid" style={{ height: (endHour - startHour) * hourHeight }}>
          <div className="schedule-hours">
            {hours.map(hour => <span key={hour} style={{ top: positionAt(hour * 60) }}>{String(hour).padStart(2, "0")}:00</span>)}
          </div>
          {week.map(({ day, placed }) => <div className="schedule-day" key={day}>
            {placed.map(event => <div className="schedule-position" key={event.id} style={{
              top: positionAt(event.start),
              height: positionAt(event.end) - positionAt(event.start),
              left: `${event.column * 100 / event.columns}%`,
              width: `${100 / event.columns}%`,
            }}>
              <EventButton event={event} compact={event.end - event.start <= 30} />
            </div>)}
          </div>)}
        </div>
      </div>
    </div>}
  </>;
}
