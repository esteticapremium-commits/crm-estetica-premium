import LeadDateTimePicker from "./LeadDateTimePicker";
import { APPOINTMENT_DURATION, APPOINTMENT_LABELS, CLOSING_WON_LABEL, allowedOutcomes, type AppointmentOutcome, type AppointmentType } from "./appointments";

const labels: Record<AppointmentOutcome, string> = {
  answered: "Ha risposto", not_interested: "Non interessato",
  qualified: "In target", not_qualified: "Fuori target", no_answer: "No-show", held: "Svolta", no_show: "No-show",
  won: CLOSING_WON_LABEL, lost: "Offerta rifiutata",
};

export function AppointmentTime({ type, value, disabled, onChange, revealPanel }: {
  type: AppointmentType; value: string; disabled?: boolean; onChange: (value: string) => void; revealPanel?: boolean;
}) {
  return <div>
    <p className="muted">{APPOINTMENT_LABELS[type]} · {APPOINTMENT_DURATION[type]} min</p>
    <LeadDateTimePicker value={value} disabled={!!disabled} onChange={onChange} revealPanel={revealPanel} />
  </div>;
}

export function AppointmentOutcomeChoices({ type, value, disabled, beforeStart = false, onChange }: {
  type: AppointmentType | "confirmation"; value?: AppointmentOutcome | ""; disabled?: boolean; beforeStart?: boolean; onChange: (value: AppointmentOutcome) => void;
}) {
  const choices = beforeStart ? ["no_show"] as const : allowedOutcomes(type);
  return <div className="lead-appointment-actions" role="group" aria-label="Esito della call">
    {choices.map(outcome => <button
      key={outcome}
      className={`btn small${value === outcome ? " primary" : ""}`}
      type="button"
      disabled={disabled}
      aria-pressed={value === outcome}
      onClick={() => onChange(outcome)}
    >{beforeStart ? "No-show preannunciato" : outcome === "no_show" && (type === "setting" || type === "discovery") ? "Disdetta" : type === "setting" && outcome === "no_answer" ? "Non risponde" : labels[outcome]}</button>)}
  </div>;
}
