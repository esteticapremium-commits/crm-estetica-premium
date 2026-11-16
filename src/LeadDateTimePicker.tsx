import { useId, useRef, useState } from "react";
import { romeToday } from "./dates";
import "./lead-date-time.css";

const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
const quarterHours = ["00", "15", "30", "45"];
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
  const [panel, setPanel] = useState<"date" | "time" | null>(null);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
  const [showAllMinutes, setShowAllMinutes] = useState(false);
  const [month, setMonth] = useState(() => monthStart(date || today));
  const pickerId = useId();
  const dateButton = useRef<HTMLButtonElement>(null);
  const timeButton = useRef<HTMLButtonElement>(null);
  const timeHeading = useRef<HTMLElement>(null);
  const [hour, minute] = time.split(":");
  const focusTrigger = (field: "date" | "time") =>
    (field === "date" ? dateButton : timeButton).current?.focus({ preventScroll: true });

  function closePanel() {
    if (panel) focusTrigger(panel);
    setPanel(null);
  }

  function selectHour(nextHour: string) {
    setSelectedHour(nextHour);
    setShowAllMinutes(nextHour === hour && Boolean(minute) && !quarterHours.includes(minute));
    timeHeading.current?.focus({ preventScroll: true });
  }
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const offset = (month.getUTCDay() + 6) % 7;

  function selectDate(nextDate: string) {
    onChange(`${nextDate}T${time}`);
    closePanel();
  }

  return <div className="lead-date-time" onKeyDown={(event) => {
    if (panel && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  }}>
    <div className="lead-date-time-fields">
      <div className="field">
        <label htmlFor={`${pickerId}-date`}>Data</label>
        <button ref={dateButton} id={`${pickerId}-date`} type="button" disabled={disabled}
          className="lead-date-trigger" aria-expanded={panel === "date"} aria-controls={`${pickerId}-month`}
          aria-label={date ? `Data, ${dayLabel.format(new Date(`${date}T12:00:00Z`))}` : "Scegli la data"}
          onClick={() => {
            if (panel !== "date") setMonth(monthStart(date || today));
            setPanel(panel === "date" ? null : "date");
          }}>
          {date ? date.split("-").reverse().join("/") : "Scegli la data"}
          <span aria-hidden="true">{panel === "date" ? "▴" : "▾"}</span>
        </button>
      </div>
      <div className="field">
        <label htmlFor={`${pickerId}-time`}>Ora</label>
        <button ref={timeButton} id={`${pickerId}-time`} type="button" disabled={disabled || !date}
          className="lead-date-trigger" aria-expanded={panel === "time"} aria-controls={`${pickerId}-clock`}
          aria-label={time ? `Ora, ${time}` : "Scegli l’ora"}
          onClick={() => {
            setSelectedHour(null);
            setShowAllMinutes(false);
            setPanel(panel === "time" ? null : "time");
          }}>
          {time || "Scegli l’ora"}
          <span aria-hidden="true">{panel === "time" ? "▴" : "▾"}</span>
        </button>
      </div>
    </div>
    <div id={`${pickerId}-month`} hidden={panel !== "date"} className="lead-date-panel lead-date-month" role="group" aria-label="Calendario della prenotazione">
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
        {date && <button type="button" disabled={disabled} onClick={() => { onChange(""); closePanel(); }}>Cancella data e ora</button>}
      </div>
    </div>
    <div id={`${pickerId}-clock`} hidden={panel !== "time"} className="lead-date-panel lead-time-panel" role="group" aria-label="Selettore dell’ora">
      <div className="lead-time-header">
        {selectedHour !== null && <button type="button" disabled={disabled} onClick={() => {
          setSelectedHour(null);
          timeHeading.current?.focus({ preventScroll: true });
        }}>‹ Ore</button>}
        <strong ref={timeHeading} tabIndex={-1} aria-live="polite">
          {selectedHour === null ? "Scegli le ore" : `Minuti · ${selectedHour}:––`}
        </strong>
      </div>
      {selectedHour === null ? <div className="lead-time-grid" aria-label="Ore">
        {hours.map(option => <button key={option} type="button" disabled={disabled}
          aria-label={`Ore ${option}`} aria-pressed={option === hour}
          onClick={() => selectHour(option)}>{option}</button>)}
      </div> : <>
        <div className={`lead-time-grid${showAllMinutes ? " all-minutes" : " quick-minutes"}`} aria-label="Minuti">
          {(showAllMinutes ? minutes : quarterHours).map(option => <button key={option} type="button"
            disabled={disabled || !date} aria-label={`Minuti ${option}`}
            aria-pressed={selectedHour === hour && option === minute}
            onClick={() => { onChange(`${date}T${selectedHour}:${option}`); closePanel(); }}>{option}</button>)}
        </div>
        {!showAllMinutes && <div className="lead-date-month-footer">
          <button type="button" disabled={disabled} onClick={() => { setShowAllMinutes(true); timeHeading.current?.focus({ preventScroll: true }); }}>Tutti i minuti</button>
        </div>}
      </>}
      {time && <div className="lead-date-month-footer">
        <button type="button" disabled={disabled} onClick={() => { onChange(`${date}T`); closePanel(); }}>Cancella ora</button>
      </div>}
    </div>
  </div>;
}
