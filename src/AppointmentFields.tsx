import LeadDateTimePicker from "./LeadDateTimePicker";
import { APPOINTMENT_DURATION, APPOINTMENT_LABELS, allowedOutcomes, type AppointmentOutcome, type AppointmentType } from "./appointments";

const labels: Record<AppointmentOutcome, string> = {
  answered: "Ha risposto", not_interested: "Non interessato",
  qualified: "In target", not_qualified: "Fuori target", no_answer: "No-show", held: "Svolta", no_show: "No-show",
};

export function AppointmentTime({ type, value, disabled, onChange }: {
  type: AppointmentType; value: string; disabled?: boolean; onChange: (value: string) => void;
}) {
  return <div>
    <p className="muted">{APPOINTMENT_LABELS[type]} · {APPOINTMENT_DURATION[type]} min</p>
    <LeadDateTimePicker value={value} disabled={!!disabled} onChange={onChange} />
  </div>;
}

export function AppointmentOutcomeChoices({ type, value, disabled, onChange }: {
  type: AppointmentType; value?: AppointmentOutcome | ""; disabled?: boolean; onChange: (value: AppointmentOutcome) => void;
}) {
  return <div className="lead-appointment-actions" role="group" aria-label="Esito della call">
    {allowedOutcomes(type).map(outcome => <button
      key={outcome}
      className={`btn small${value === outcome ? " primary" : ""}`}
      type="button"
      disabled={disabled}
      aria-pressed={value === outcome}
      onClick={() => onChange(outcome)}
    >{type === "setting" && outcome === "no_answer" ? "Non risponde" : labels[outcome]}</button>)}
  </div>;
}
