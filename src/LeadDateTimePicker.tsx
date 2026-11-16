import { useId, useRef, useState } from "react";
import { romeToday } from "./dates";
import "./lead-date-time.css";

const weekdays = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
const monthLabel = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthStart = (day: string) => new Date(`${day.slice(0, 7)}-01T12:00:00Z`);

export default function LeadDateTimePicker({ value, onChange, disabled }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [date, time = ""] = value.split("T");
  const today = romeToday();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthStart(date || today));
  const pickerId = useId();
  const dateButton = useRef<HTMLButtonElement>(null);
  const focusDay = () => dateButton.current?.focus({ preventScroll: true });
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const offset = (month.getUTCDay() + 6) % 7;

  function selectDate(nextDate: string) {
    onChange(`${nextDate}T${time}`);
    setOpen(false);
    focusDay();
  }

  return <div className="lead-date-time" onKeyDown={(event) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      focusDay();
    }
  }}>
    <div className="lead-date-time-fields">
      <div className="field">
        <label htmlFor={`${pickerId}-date`}>Data</label>
        <button ref={dateButton} id={`${pickerId}-date`} type="button" disabled={disabled}
          className="lead-date-trigger" aria-expanded={open} aria-controls={`${pickerId}-month`}
          aria-label={date ? `Data, ${dayLabel.format(new Date(`${date}T12:00:00Z`))}` : "Scegli la data"}
          onClick={() => { if (!open) setMonth(monthStart(date || today)); setOpen(!open); }}>
          {date ? date.split("-").reverse().join("/") : "Scegli la data"}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
      </div>
      <div className="field">
        <label htmlFor={`${pickerId}-time`}>Ora</label>
        <input id={`${pickerId}-time`} type="time" value={time} disabled={disabled || !date}
          onChange={(event) => onChange(`${date}T${event.target.value}`)} />
      </div>
    </div>
    <div id={`${pickerId}-month`} hidden={!open} className="lead-date-month" role="group" aria-label="Calendario della prenotazione">
      <div className="lead-date-month-header">
        <button type="button" aria-label="Mese precedente" disabled={disabled} onClick={() => setMonth(new Date(Date.UTC(year, monthIndex - 1, 1, 12)))}>‹</button>
        <strong aria-live="polite">{monthLabel.format(month)}</strong>
        <button type="button" aria-label="Mese successivo" disabled={disabled} onClick={() => setMonth(new Date(Date.UTC(year, monthIndex + 1, 1, 12)))}>›</button>
      </div>
      <div className="lead-date-days">
        {weekdays.map((weekday) => <span key={weekday} className="lead-date-weekday" aria-hidden="true">{weekday}</span>)}
        {Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
        {Array.from({ length: days }, (_, index) => {
          const day = index + 1;
          const iso = new Date(Date.UTC(year, monthIndex, day, 12)).toISOString().slice(0, 10);
          return <button key={iso} type="button" disabled={disabled} aria-pressed={iso === date}
            aria-current={iso === today ? "date" : undefined} aria-label={dayLabel.format(new Date(`${iso}T12:00:00Z`))}
            onClick={() => selectDate(iso)}>{day}</button>;
        })}
      </div>
      <div className="lead-date-month-footer">
        <button type="button" disabled={disabled} onClick={() => selectDate(today)}>Oggi</button>
        {date && <button type="button" disabled={disabled} onClick={() => { onChange(""); setOpen(false); focusDay(); }}>Cancella data e ora</button>}
      </div>
    </div>
  </div>;
}
