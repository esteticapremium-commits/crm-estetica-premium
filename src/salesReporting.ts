import { romeDay } from "./dates";
import { emptyDailyNumbers, type DailyNumbers } from "./dailySales";
import type { GoogleSale } from "./googleSales";
import { calculateKpiRows, dailyReportFromKpi, type SalesKpiInputs } from "./salesKpiRows";
import { activityTimestamp, isHeldClosing } from "./salesKpi";
import type { LeadActivity, SalesOutreachEvent, SalesRevenueEvent, SalesTask } from "./types";

export function suggestDailyReport(day: string, inputs: SalesKpiInputs): DailyNumbers {
  const { rows } = calculateKpiRows({ ...inputs, range: { from: day, to: day } });
  return rows.length ? dailyReportFromKpi(rows[0]) : emptyDailyNumbers();
}

/** Explicit links provide a lower bound when historical attribution is incomplete. */
export function linkedAppointmentRates(
  activities: LeadActivity[],
  outreach: SalesOutreachEvent[],
  revenue: SalesRevenueEvent[],
  google: GoogleSale[],
  from: string,
  to: string,
  standalone: SalesTask[] = [],
) {
  const within = (at: string) => { const day = romeDay(at); return day >= from && day <= to; };
  const appointmentAt = (row: LeadActivity) => row.details?.task_id && row.scheduled_at ? row.scheduled_at : activityTimestamp(row);
  const discoveries = activities.filter(row => row.event_type === "discovery_call" &&
    ["qualified", "not_qualified"].includes(row.outcome || "") && row.call_type !== "client" && within(appointmentAt(row)));
  const demos = activities.filter(row => row.event_type === "demo_call" && isHeldClosing(row.outcome) &&
    row.call_type !== "client" && within(appointmentAt(row)));
  const replies = outreach.filter(row => row.event_type === "reply" && within(row.occurred_at));
  const discoveryByKey = new Map(discoveries.map(row => [row.event_key, row]));
  const replyById = new Map(replies.map(row => [row.id, row]));
  const demoByTask = new Map(demos.map(row => [row.details?.task_id, row]));
  const discoveryMatches = new Set<string>();
  const replyMatches = new Set<string>();
  for (const booking of activities) {
    if (booking.call_type === "client") continue;
    const bookingTime = Date.parse(activityTimestamp(booking));
    if (booking.event_type === "demo_booked" && typeof booking.details?.source_outcome_key === "string") {
      const source = discoveryByKey.get(booking.details.source_outcome_key);
      if (source && source.lead_id === booking.lead_id && bookingTime >= Date.parse(appointmentAt(source))) discoveryMatches.add(source.id);
    }
    if (booking.event_type === "discovery_booked" && typeof booking.details?.source_reply_id === "string") {
      const source = replyById.get(booking.details.source_reply_id);
      if (source && source.lead_id === booking.lead_id && bookingTime >= Date.parse(source.occurred_at)) replyMatches.add(source.id);
    }
  }

  const payments = revenue.filter(row => row.status === "collected" && row.revenue_type === "new" && Number(row.amount) > 0);
  // An instalment updates cash without proving another acquisition.
  const firstPaymentByLead = new Map<string, SalesRevenueEvent>();
  for (const payment of payments) {
    if (!payment.lead_id) continue;
    const previous = firstPaymentByLead.get(payment.lead_id);
    if (!previous || Date.parse(payment.occurred_at) < Date.parse(previous.occurred_at)) firstPaymentByLead.set(payment.lead_id, payment);
  }
  const countedDemos = new Set<string>();
  for (const payment of firstPaymentByLead.values()) {
    const demo = payment.sale_appointment_id ? demoByTask.get(payment.sale_appointment_id) : undefined;
    if (demo && payment.lead_id === demo.lead_id && Date.parse(payment.occurred_at) >= Date.parse(appointmentAt(demo))) countedDemos.add(demo.id);
  }
  const externalHeld = google.filter(row => row.revenue_type === "new" && within(row.starts_at) && ["won", "lost", "follow_up"].includes(row.outcome));
  const externalDemos = externalHeld.filter(row => row.appointment_type === "demo");
  const externalPaid = externalDemos.filter(row =>
    row.outcome === "won" && Number(row.collected_amount) > 0 &&
    (!row.lead_id || firstPaymentByLead.get(row.lead_id)?.event_key === `google-sale:${row.id}`)
  ).length;
  const standaloneHeld = standalone.filter(row => row.appointment_status === "held" && row.audience !== "client" && within(row.due_at));
  return {
    discovery: { total: discoveries.length + externalHeld.filter(row => row.appointment_type === "discovery").length + standaloneHeld.filter(row => row.appointment_type === "discovery").length, converted: discoveryMatches.size },
    reply: { total: replies.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0), converted: replyMatches.size },
    closing: { total: demos.length + externalDemos.length + standaloneHeld.filter(row => row.appointment_type === "demo").length, converted: countedDemos.size + externalPaid },
  };
}
