import { romeDay as dayInRome } from "./dates";
import type { DailyNumbers } from "./dailySales";
import { firstNewSaleIds, googleSaleMetrics, isCalendarClosingRevenue, isGoogleRevenue, saleHeld, saleOutcomes, type GoogleSale } from "./googleSales";
import { activityTimestamp, isHeldClosing } from "./salesKpi";
import type { Contract, Lead, LeadActivity, SalesCost, SalesOutreachEvent, SalesRevenueEvent, SalesTask } from "./types";

export interface DailyKpi {
  day: string;
  // Azioni di contatto
  callLead: number;
  callOutbound: number;
  settingContacts: number;
  callClient: number;
  callOther: number;
  callFromCalendar: number;
  mexFollowUp: number;
  callMinutes: number;
  prospectCallsAnswered: number;
  reachedLeads: number;
  leads: number;
  // Outreach
  instantlySent: number;
  dmSent: number;
  replies: number;
  positiveReplies: number;
  followUpBooked: number;
  followUpScheduled: number;
  followUpSameDay: number;
  followUpHeld: number;
  followUpHeldBooked: number;
  // Prenotazioni
  discoveryBooked: number;
  demoBooked: number;
  demoClientBooked: number;
  // Appuntamenti previsti nel giorno, indipendentemente da quando sono stati
  // fissati. Sono i denominatori corretti dello show-up giornaliero.
  discoveryScheduled: number;
  demoScheduled: number;
  demoClientScheduled: number;
  // Fissati e svolti nella stessa giornata
  discoverySameDay: number;
  demoSameDay: number;
  demoClientSameDay: number;
  // Svolti
  discoveryHeld: number;
  demoHeld: number;
  demoClientHeld: number;
  // Svolti che provengono da una prenotazione. Servono allo show-up: gli
  // appuntamenti fatti al volo non erano mai stati fissati, quindi non possono
  // stare al numeratore di "svolti su fissati".
  discoveryHeldBooked: number;
  demoHeldBooked: number;
  demoClientHeldBooked: number;
  // Conversione discovery -> closing calcolata per lead unico. Le
  // riprogrammazioni della stessa closing non devono mai alzare il tasso.
  discoveryLeads: number;
  discoveryConvertedLeads: number;
  noShow: number;
  qualified: number;
  // Chiusura
  proposals: number;
  won: number;
  renewals: number;
  upsells: number;
  // Denaro
  collectedNew: number;
  collectedRenewal: number;
  collectedUpsell: number;
  contractValue: number;
  costs: number;
}

// Aritmetica di calendario pura: nessun fuso orario coinvolto, così il periodo
// selezionato non slitta di un giorno per chi apre il CRM da un altro paese.
export const addDays = (iso: string, amount: number) => {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
const number = (value: unknown) => Number(value) || 0;
export const taskIdOf = (activity: LeadActivity) => {
  const raw = (activity.details as { task_id?: unknown } | null)?.task_id;
  return raw ? String(raw) : null;
};

export function kpiActivityDate(activity: LeadActivity) {
  const hasScheduledOutcome = taskIdOf(activity) && ["setting_call", "discovery_call", "demo_call"].includes(activity.event_type || "");
  return hasScheduledOutcome && activity.scheduled_at ? activity.scheduled_at : activityTimestamp(activity);
}

const emptyDay = (day: string): DailyKpi => ({
  day, callLead: 0, callOutbound: 0, settingContacts: 0, callClient: 0, callOther: 0, callFromCalendar: 0, mexFollowUp: 0, callMinutes: 0,
  prospectCallsAnswered: 0, reachedLeads: 0, leads: 0, instantlySent: 0, dmSent: 0, replies: 0, positiveReplies: 0,
  followUpBooked: 0, followUpScheduled: 0, followUpSameDay: 0, followUpHeld: 0, followUpHeldBooked: 0,
  discoveryBooked: 0, demoBooked: 0, demoClientBooked: 0, discoveryScheduled: 0, demoScheduled: 0, demoClientScheduled: 0,
  discoverySameDay: 0, demoSameDay: 0, demoClientSameDay: 0,
  discoveryHeld: 0, demoHeld: 0, demoClientHeld: 0, discoveryHeldBooked: 0, demoHeldBooked: 0, demoClientHeldBooked: 0,
  discoveryLeads: 0, discoveryConvertedLeads: 0,
  noShow: 0, qualified: 0, proposals: 0, won: 0,
  renewals: 0, upsells: 0, collectedNew: 0, collectedRenewal: 0, collectedUpsell: 0, contractValue: 0, costs: 0,
});

export const sumRows = (rows: DailyKpi[]) => rows.reduce((total, row) => {
  (Object.keys(total) as Array<keyof DailyKpi>).forEach((key) => { if (key !== "day") (total[key] as number) += row[key] as number; });
  return total;
}, emptyDay("totale"));

// Una discovery è "svolta" solo se il venditore ha dichiarato se il prospect è
// in target o no. Un generico "svolta" non la rende mai qualificata.
export const isHeldDiscovery = (outcome?: string | null) => outcome === "qualified" || outcome === "not_qualified";

// Lo storico precedente al tracciamento strutturato non ha event_type: quelle
// righe si riconoscono da activity_type e dall'esito scritto in italiano.
// Senza queste tre righe il lavoro fatto finora resterebbe invisibile nei KPI.
const isLegacy = (activity: LeadActivity) => !activity.event_type;
export const isCallActivity = (activity: LeadActivity) =>
  (["setting_call", "discovery_call"].includes(activity.event_type || "") && activity.outcome !== "no_show") ||
  (isLegacy(activity) && activity.activity_type === "call");
const isFollowUpActivity = (activity: LeadActivity) => activity.event_type === "follow_up" || (isLegacy(activity) && activity.activity_type === "follow_up");
const isBookingActivity = (activity: LeadActivity) => activity.event_type === "discovery_booked" || (isLegacy(activity) && activity.outcome === "Appuntamento fissato");

function standaloneAppointmentMetrics(task: SalesTask, day: string, now = Date.now()) {
  const result: Record<string, number> = {};
  if (!task.appointment_type || task.appointment_type === "setting" || task.lead_id || !task.commercial_tracked || task.appointment_status === "cancelled") return result;
  const key = task.appointment_type === "discovery" ? "discovery" : task.audience === "client" ? "demoClient" : "demo";
  const sameDay = dayInRome(task.created_at) === day;
  if (sameDay) result[`${key}Booked`] = 1;
  if (dayInRome(task.due_at) !== day || (Date.parse(task.due_at) > now && task.appointment_status !== "no_show")) return result;
  result[`${key}Scheduled`] = 1;
  if (task.appointment_status === "no_show") result.noShow = 1;
  if (task.appointment_status === "held") {
    result[`${key}Held`] = 1;
    result[`${key}HeldBooked`] = 1;
    if (sameDay) result[`${key}SameDay`] = 1;
    if (task.appointment_outcome === "qualified") result.qualified = 1;
    if (task.outcome_minutes) result.callMinutes = task.outcome_minutes;
  }
  return result;
}

export type EvidenceKind = "discovery" | "closing" | "held" | "cash";
type Evidence = { id: string; kind: EvidenceKind; leadId: string | null; at: string; scheduled?: string | null; owner: string | null; value?: number; label: string };

export interface SalesKpiInputs {
  activities: LeadActivity[];
  outreach: SalesOutreachEvent[];
  revenue: SalesRevenueEvent[];
  externalSales: GoogleSale[];
  standalone: SalesTask[];
}

type NameMatcher = (owner: string | null | undefined) => boolean;
type SourceMatcher = (leadId: string | null | undefined, channel?: string | null) => boolean;
const matchAll = () => true;
const defaultActivityOwner = (activity: LeadActivity) => activity.created_by;

export const phoneAttempts = (row: DailyKpi) =>
  row.callLead + row.callOutbound + row.callClient + row.callOther + row.callFromCalendar;

export function dailyReportFromKpi(row: DailyKpi): DailyNumbers {
  return {
    calls_made: phoneAttempts(row),
    discovery_booked: row.discoveryBooked,
    discovery_held: row.discoveryHeld,
    demo_booked: row.demoBooked + row.demoClientBooked,
    demo_held: row.demoHeld + row.demoClientHeld,
    demo_won: row.won,
  };
}

export function calculateKpiRows({
  activities, outreach, revenue, externalSales, standalone, range,
  leads = [], contracts = [], costs = [], dedupGoogle = externalSales, dedupRevenue = revenue,
  origin = "all", channel = "all", seller = "all", outreachReady = true, now = new Date(),
  activityOwner = defaultActivityOwner, sellerMatches = matchAll, sourceMatches = matchAll,
}: SalesKpiInputs & {
  range: { from: string; to: string };
  leads?: Lead[];
  contracts?: Contract[];
  costs?: SalesCost[];
  dedupGoogle?: GoogleSale[];
  dedupRevenue?: SalesRevenueEvent[];
  origin?: "all" | "pipeline" | "google";
  channel?: string;
  seller?: string;
  outreachReady?: boolean;
  now?: Date;
  activityOwner?: (activity: LeadActivity) => string | null;
  sellerMatches?: NameMatcher;
  sourceMatches?: SourceMatcher;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to) ||
    !Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(range.to)) || range.from > range.to) {
    return { rows: [], evidence: [] };
  }
  const leadById = new Map(leads.map(lead => [lead.id, lead]));
  const currentDay = dayInRome(now);
  const inRange = (day: string) => day >= range.from && day <= range.to;
  const sellerMatchesActivity = (activity: LeadActivity) => sellerMatches(activityOwner(activity));
  const missedTaskIds = new Set(activities.filter(activity => activity.outcome === "no_show" &&
    ["discovery_call", "demo_call"].includes(activity.event_type || "")).map(taskIdOf));
  // Giornata in cui ogni appuntamento è stato prenotato: serve a riconoscere
  // quelli fissati e svolti nella stessa giornata.
  const bookingDayByTask = (() => {
    const map = new Map<string, string>();
    activities.forEach((activity) => {
      const taskId = taskIdOf(activity);
      if (taskId && (activity.event_type === "discovery_booked" || activity.event_type === "demo_booked")) {
        map.set(taskId, dayInRome(activityTimestamp(activity)));
      }
    });
    return map;
  })();

  // La prima cauzione/incasso "new" di ogni lead e' l'evento che trasforma la
  // closing in una vendita vinta. La sola firma di un accordo di prova non e'
  // denaro incassato e non deve gonfiare chiusure, CR o CAC.
  const firstNewSales = firstNewSaleIds(dedupGoogle, dedupRevenue);

  const signedValueByLead = (() => {
    const map = new Map<string, number>();
    contracts
      .filter((contract) => contract.lead_id && contract.signed_at)
      .sort((a, b) => (b.signed_at || "").localeCompare(a.signed_at || ""))
      .forEach((contract) => {
        if (!map.has(contract.lead_id!)) map.set(contract.lead_id!, number(contract.deal_value ?? leadById.get(contract.lead_id!)?.value));
      });
    return map;
  })();

  // Appuntamenti già registrati nel CRM: un booking arrivato dal webhook
  // Instantly non deve aggiungersi a una discovery che il venditore ha già
  // fissato a mano per lo stesso lead.
  const crmBookings = (() => {
    const keys = new Set<string>();
    activities.forEach((activity) => {
      if (activity.event_type === "discovery_booked") {
        keys.add(`${activity.lead_id}|${dayInRome(activityTimestamp(activity))}`);
      }
    });
    return keys;
  })();

  const evidence: Evidence[] = [];
  const result = new Map<string, DailyKpi>();
  const reachedByDay = new Map<string, Set<string>>();
  const heldDiscoveryByDay = new Map<string, Map<string, string>>();
  const demoBookingsByLead = new Map<string, string[]>();
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) result.set(day, emptyDay(day));
  const rowOf = (day: string) => { if (!result.has(day)) result.set(day, emptyDay(day)); return result.get(day)!; };

  // Una closing può essere riprogrammata più volte, ma ai fini della
  // conversione la persona resta una sola. Conserviamo tutti gli orari di
  // prenotazione per verificare che la closing sia successiva alla discovery.
  activities.forEach((activity) => {
    if (activity.event_type !== "demo_booked" || !sellerMatchesActivity(activity) || !sourceMatches(activity.lead_id, activity.channel)) return;
    const bookings = demoBookingsByLead.get(activity.lead_id) || [];
    bookings.push(dayInRome(activityTimestamp(activity)));
    demoBookingsByLead.set(activity.lead_id, bookings);
  });

  if (origin !== "google") leads.forEach((lead) => {
    const day = dayInRome(lead.created_at);
    if (inRange(day) && sellerMatches(lead.assigned_to) && sourceMatches(lead.id)) rowOf(day).leads += 1;
  });

  if (outreachReady) outreach.forEach((event) => {
    const day = dayInRome(event.occurred_at);
    if (!inRange(day) || !sellerMatches(event.assigned_to) || !sourceMatches(event.lead_id, event.channel)) return;
    const row = rowOf(day);
    const quantity = number(event.quantity) || 1;
    if (event.event_type === "sent") {
      if (event.channel === "instantly") row.instantlySent += quantity;
      if (event.channel === "dm") row.dmSent += quantity;
    }
    if (event.event_type === "reply") {
      row.replies += quantity;
      if (event.outcome === "positive") row.positiveReplies += quantity;
    }
    if (event.event_type === "positive_reply") row.positiveReplies += quantity;
    if (event.event_type === "booking" && !crmBookings.has(`${event.lead_id}|${day}`)) { row.discoveryBooked += 1; evidence.push({id:event.id,kind:"discovery",leadId:event.lead_id,at:event.occurred_at,owner:event.assigned_to,label:"Prenotazione outreach"}); }
  });

  activities.forEach((activity) => {
    const type = activity.event_type || "";
    const fromAppointment = Boolean(taskIdOf(activity));
    // "Fissato" misura il giorno in cui il venditore ha ottenuto
    // l'appuntamento; lo show-up deve invece confrontare gli esiti con gli
    // appuntamenti effettivamente in agenda in quella giornata. Se una
    // discovery viene fissata ieri per oggi, entra quindi nel denominatore di
    // oggi e non in quello di ieri.
    if (
      activity.scheduled_at &&
      (type === "discovery_booked" || type === "demo_booked") &&
      sellerMatchesActivity(activity) &&
      sourceMatches(activity.lead_id, activity.channel)
    ) {
      const scheduledDay = dayInRome(activity.scheduled_at);
      // Durante la giornata non consideriamo assente chi deve ancora fare la
      // call: entrerà nel denominatore dello show-up quando arriva il suo
      // orario. Per i giorni passati, invece, tutti gli appuntamenti previsti
      // restano nel calcolo anche se l'esito non è stato compilato.
      const bookingTask = taskIdOf(activity);
      const isStillUpcomingToday = scheduledDay === currentDay && Date.parse(activity.scheduled_at) > now.getTime() &&
        !(bookingTask && missedTaskIds.has(bookingTask));
      if (inRange(scheduledDay) && !isStillUpcomingToday) {
        const scheduledRow = rowOf(scheduledDay);
        const scheduledCallType = activity.call_type || "lead";
        if (type === "discovery_booked") scheduledRow.discoveryScheduled += 1;
        else if (scheduledCallType === "client") scheduledRow.demoClientScheduled += 1;
        else scheduledRow.demoScheduled += 1;
      }
    }
    // Anche lo storico già registrato deve finire nel giorno corretto. Gli
    // esiti legati a un appuntamento usano la data pianificata; prenotazioni,
    // richiami e attività manuali continuano a usare il momento dell'azione.
    const eventAt = kpiActivityDate(activity);
    const day = dayInRome(eventAt);
    if (!inRange(day) || !sellerMatchesActivity(activity) || !sourceMatches(activity.lead_id, activity.channel)) return;
    const row = rowOf(day);
    const outcome = activity.outcome || "";
    if (type === "discovery_call" && outcome === "no_show" && fromAppointment) row.noShow += 1;
    const callType = activity.call_type || "lead";
    // Le colonne "day" misurano gli appuntamenti svolti senza attesa. Sono due
    // i casi: quelli fissati e chiusi nella stessa giornata, e quelli fatti al
    // volo durante la chiamata, che non hanno mai avuto una prenotazione. Il
    // secondo caso è la norma quando il lead risponde e si riesce a fare la
    // discovery seduta stante.
    const sameDay = fromAppointment ? bookingDayByTask.get(taskIdOf(activity)!) === day : true;

    // Storico precedente al registro outreach separato.
    if (!outreachReady && type === "outreach_sent") {
      if (activity.channel === "instantly") row.instantlySent += 1;
      if (activity.channel === "dm") row.dmSent += 1;
    }
    if (!outreachReady && type === "outreach_reply") { row.replies += 1; if (outcome === "positive") row.positiveReplies += 1; }

    if (isFollowUpActivity(activity)) row.mexFollowUp += 1;

    if (isCallActivity(activity)) {
      if (type === "setting_call") row.settingContacts += 1;
      if (callType === "outbound") row.callOutbound += 1;
      else if (callType === "client") row.callClient += 1;
      else if (callType === "other") row.callOther += 1;
      else row.callLead += 1;

      row.callMinutes += number(activity.duration_minutes);

      if (callType === "lead" || callType === "outbound") {
        if (outcome !== "no_answer" && outcome !== "Non risponde") {
          row.prospectCallsAnswered += 1;
          const reached = reachedByDay.get(day) || new Set<string>();
          reached.add(activity.lead_id);
          reachedByDay.set(day, reached);
          row.reachedLeads = reached.size;
        }
      }
      if (type !== "setting_call" && isHeldDiscovery(outcome)) {
        row.discoveryHeld += 1;
        if (fromAppointment) row.discoveryHeldBooked += 1;
        if (sameDay) row.discoverySameDay += 1;
        const leadTimes = heldDiscoveryByDay.get(day) || new Map<string, string>();
        const occurredAt = day;
        const previous = leadTimes.get(activity.lead_id);
        if (previous === undefined || occurredAt < previous) leadTimes.set(activity.lead_id, occurredAt);
        heldDiscoveryByDay.set(day, leadTimes);
      }
      if (type !== "setting_call" && outcome === "qualified") row.qualified += 1;
      if (outcome === "no_answer" && fromAppointment && type !== "setting_call") row.noShow += 1;
    }

    const proof = {id:activity.id,leadId:activity.lead_id,at:eventAt,scheduled:activity.scheduled_at,owner:activityOwner(activity) || null,label:activity.outcome || "Prenotazione"};
    if (isBookingActivity(activity)) { row.discoveryBooked += 1; evidence.push({...proof,kind:"discovery"}); }
    if (type === "demo_booked") evidence.push({...proof,kind:"closing"});
    if ((type !== "setting_call" && isCallActivity(activity) && isHeldDiscovery(outcome)) || (type === "demo_call" && isHeldClosing(outcome))) evidence.push({...proof,kind:"held"});
    if (type === "demo_booked") { if (callType === "client") row.demoClientBooked += 1; else row.demoBooked += 1; }

    if (type === "demo_call") {
      row.callMinutes += number(activity.duration_minutes);
      if (isHeldClosing(outcome)) {
        if (callType === "client") { row.demoClientHeld += 1; if (fromAppointment) row.demoClientHeldBooked += 1; if (sameDay) row.demoClientSameDay += 1; }
        else { row.demoHeld += 1; if (fromAppointment) row.demoHeldBooked += 1; if (sameDay) row.demoSameDay += 1; }
      }
      if (outcome === "no_show") row.noShow += 1;
    }
  });

  heldDiscoveryByDay.forEach((leadTimes, day) => {
    const row = rowOf(day);
    row.discoveryLeads = leadTimes.size;
    row.discoveryConvertedLeads = [...leadTimes].filter(([leadId, discoveryDay]) =>
      (demoBookingsByLead.get(leadId) || []).some((bookingDay) => bookingDay >= discoveryDay)
    ).length;
  });

  // Il contratto è la fonte autorevole di proposte e firme. Quando sent_at non
  // è valorizzato vale la data di creazione: una proposta esiste dal momento in
  // cui il contratto viene preparato, non solo se si usa il pulsante "invia".
  contracts.forEach((contract) => {
    const lead = contract.lead_id ? leadById.get(contract.lead_id) : null;
    if (!sellerMatches(lead?.assigned_to || contract.created_by) || !sourceMatches(contract.lead_id)) return;
    const proposalDay = dayInRome(contract.sent_at || contract.created_at);
    if (inRange(proposalDay)) rowOf(proposalDay).proposals += 1;
  });

  const closingValues = new Map(dedupRevenue
    .filter(entry => entry.sale_appointment_id && entry.status !== "cancelled" && isCalendarClosingRevenue(entry.event_key))
    .map(entry => [entry.sale_appointment_id, entry.contract_value]));
  const previouslyRecordedDeals = new Set(dedupRevenue
    .filter(entry => entry.sale_appointment_id && entry.status === "collected" && !isCalendarClosingRevenue(entry.event_key))
    .map(entry => `${entry.sale_appointment_id}:${entry.revenue_type}`));
  revenue.forEach((entry) => {
    if (!sellerMatches(entry.assigned_to) || !sourceMatches(entry.lead_id)) return;
    const calendarClosing = isCalendarClosingRevenue(entry.event_key);
    const day = dayInRome(entry.occurred_at);
    const saleDay = calendarClosing ? dayInRome(entry.created_at || entry.occurred_at) : day;
    if (inRange(saleDay) && firstNewSales.has(`revenue:${entry.id}`)) {
      const saleRow = rowOf(saleDay);
      saleRow.won += 1;
      const leadValue = entry.lead_id ? signedValueByLead.get(entry.lead_id) ?? leadById.get(entry.lead_id)?.value : null;
      saleRow.contractValue += number(closingValues.get(entry.sale_appointment_id) ?? entry.contract_value ?? leadValue);
    }
    if (calendarClosing && inRange(saleDay) && (entry.status === "collected" || (entry.status === "expected" && entry.sale_appointment_id))
      && !previouslyRecordedDeals.has(`${entry.sale_appointment_id}:${entry.revenue_type}`)) {
      if (entry.revenue_type === "renewal") rowOf(saleDay).renewals += 1;
      if (entry.revenue_type === "upsell") rowOf(saleDay).upsells += 1;
    }
    if (!inRange(day) || entry.status !== "collected") return;
    const row = rowOf(day);
    evidence.push({id:entry.id,kind:"cash",leadId:entry.lead_id,at:entry.occurred_at,owner:entry.assigned_to,value:number(entry.amount),label:entry.note || (entry.revenue_type === "new" ? "Nuovo cliente" : entry.revenue_type === "renewal" ? "Rinnovo" : "Upsell")});
    if (entry.revenue_type === "new") row.collectedNew += number(entry.amount);
    if (entry.revenue_type === "renewal") { if (!calendarClosing && !isGoogleRevenue(entry.event_key)) row.renewals += 1; row.collectedRenewal += number(entry.amount); }
    if (entry.revenue_type === "upsell") { if (!calendarClosing && !isGoogleRevenue(entry.event_key)) row.upsells += 1; row.collectedUpsell += number(entry.amount); }
  });

  if (origin !== "google") standalone.forEach(task => {
    if (!sellerMatches(task.assigned_to) || !sourceMatches(null)) return;
    const bookedDay = dayInRome(task.created_at);
    const dueDay = dayInRome(task.due_at);
    for (const day of new Set([bookedDay, dueDay])) {
      if (!inRange(day)) continue;
      const row = rowOf(day);
      const metrics = standaloneAppointmentMetrics(task, day, now.getTime());
      if (task.appointment_type === "discovery" && (metrics.discoveryHeld || (metrics.noShow && task.appointment_outcome !== "no_show"))) row.callFromCalendar += 1;
      Object.entries(metrics).forEach(([key, value]) => { (row[key as keyof Omit<DailyKpi, "day">] as number) += value; });
      if (metrics.discoveryBooked || metrics.demoBooked || metrics.demoClientBooked) evidence.push({
        id: task.id, kind: task.appointment_type === "demo" ? "closing" : "discovery", leadId: null,
        at: task.created_at, scheduled: task.due_at, owner: task.assigned_to, label: task.title,
      });
      if (metrics.discoveryHeld || metrics.demoHeld || metrics.demoClientHeld) evidence.push({
        id: `${task.id}:held`, kind: "held", leadId: null, at: task.due_at, owner: task.assigned_to, label: task.title,
      });
    }
  });

  externalSales.forEach(sale => {
    if (!sellerMatches(sale.assigned_to) || !sourceMatches(sale.lead_id)) return;
    const eventDay = dayInRome(sale.starts_at);
    const bookingDay = sale.booked_at ? dayInRome(sale.booked_at) : null;
    for (const day of new Set([eventDay, ...(bookingDay ? [bookingDay] : [])])) {
      if (!inRange(day)) continue;
      const row = rowOf(day);
      const metrics = googleSaleMetrics(sale, day, now);
      if (sale.appointment_type === "discovery" && (metrics.discoveryHeld || (metrics.noShow && !sale.early_no_show))) row.callFromCalendar += 1;
      Object.entries(metrics).forEach(([key, value]) => {
        if ((key === 'won' || key === 'contractValue') && !firstNewSales.has(`google:${sale.id}`)) return;
        (row[key as keyof Omit<DailyKpi, 'day'>] as number) += value;
      });
    }
    const proof = {id:sale.id, leadId:sale.lead_id, owner:sale.assigned_to, label:`Google · ${sale.contact_name} · ${sale.appointment_type === 'follow_up' ? 'Follow-up post closing · ' : ''}${saleOutcomes[sale.outcome]}`};
    if (sale.appointment_type !== 'follow_up' && bookingDay && inRange(bookingDay)) evidence.push({...proof,kind:sale.appointment_type === 'discovery' ? 'discovery' : 'closing',at:sale.booked_at!,scheduled:sale.starts_at});
    if (inRange(eventDay) && saleHeld(sale)) evidence.push({...proof,id:`${sale.id}:held`,kind:'held',at:sale.starts_at});
  });

  costs.forEach((entry) => {
    const channelMatches = channel === "all" || (channel === "instantly" && entry.cost_type === "instantly") || (channel === "dm" && entry.cost_type === "dm_tools");
    // I costi senza responsabile sono spese di struttura: restano visibili solo
    // sul totale del team, così CPL e CAC di un singolo venditore non ereditano
    // i costi di tutti.
    const ownerMatches = entry.assigned_to ? sellerMatches(entry.assigned_to) : seller === "all";
    if (inRange(entry.cost_date) && channelMatches && ownerMatches) rowOf(entry.cost_date).costs += number(entry.amount);
  });

  return { rows: [...result.values()].sort((a, b) => b.day.localeCompare(a.day)), evidence };
}
