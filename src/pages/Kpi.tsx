import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "../supabaseClient";
import { activityTimestamp, formatPct, normalizedLeadSource, outreachKey, pct } from "../salesKpi";
import type { Client, Contract, Lead, LeadActivity, SalesCost, SalesIntegration, SalesOutreachEvent, SalesRevenueEvent } from "../types";

type ChannelFilter = "all" | "instantly" | "dm";
type RangePreset = "today" | "yesterday" | "7" | "30" | "month" | "custom";

interface DailyKpi {
  day: string;
  // Azioni di contatto
  callLead: number;
  callOutbound: number;
  callClient: number;
  callOther: number;
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

const dayInRome = (value: string | Date) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
const today = () => dayInRome(new Date());
// Aritmetica di calendario pura: nessun fuso orario coinvolto, così il periodo
// selezionato non slitta di un giorno per chi apre il CRM da un altro paese.
const addDays = (iso: string, amount: number) => {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
const eur = (value: number) => `€ ${value.toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const ratio = (value: number | null) => (value === null ? "—" : value.toLocaleString("it-IT", { maximumFractionDigits: 1 }));
const number = (value: unknown) => Number(value) || 0;
const taskIdOf = (activity: LeadActivity) => {
  const raw = (activity.details as { task_id?: unknown } | null)?.task_id;
  return raw ? String(raw) : null;
};

const emptyDay = (day: string): DailyKpi => ({
  day, callLead: 0, callOutbound: 0, callClient: 0, callOther: 0, mexFollowUp: 0, callMinutes: 0,
  prospectCallsAnswered: 0, reachedLeads: 0, leads: 0, instantlySent: 0, dmSent: 0, replies: 0, positiveReplies: 0,
  discoveryBooked: 0, demoBooked: 0, demoClientBooked: 0, discoveryScheduled: 0, demoScheduled: 0, demoClientScheduled: 0,
  discoverySameDay: 0, demoSameDay: 0, demoClientSameDay: 0,
  discoveryHeld: 0, demoHeld: 0, demoClientHeld: 0, discoveryHeldBooked: 0, demoHeldBooked: 0, demoClientHeldBooked: 0,
  noShow: 0, qualified: 0, proposals: 0, won: 0,
  renewals: 0, upsells: 0, collectedNew: 0, collectedRenewal: 0, collectedUpsell: 0, contractValue: 0, costs: 0,
});

const sumRows = (rows: DailyKpi[]) => rows.reduce((total, row) => {
  (Object.keys(total) as Array<keyof DailyKpi>).forEach((key) => { if (key !== "day") (total[key] as number) += row[key] as number; });
  return total;
}, emptyDay("totale"));

// Una discovery è "svolta" solo se il venditore ha dichiarato se il prospect è
// in target o no. Un generico "svolta" non la rende mai qualificata.
const isHeldDiscovery = (outcome?: string | null) => outcome === "qualified" || outcome === "not_qualified";

// Lo storico precedente al tracciamento strutturato non ha event_type: quelle
// righe si riconoscono da activity_type e dall'esito scritto in italiano.
// Senza queste tre righe il lavoro fatto finora resterebbe invisibile nei KPI.
const isLegacy = (activity: LeadActivity) => !activity.event_type;
const isCallActivity = (activity: LeadActivity) => activity.event_type === "discovery_call" || (isLegacy(activity) && activity.activity_type === "call");
const isFollowUpActivity = (activity: LeadActivity) => activity.event_type === "follow_up" || (isLegacy(activity) && activity.activity_type === "follow_up");
const isBookingActivity = (activity: LeadActivity) => activity.event_type === "discovery_booked" || (isLegacy(activity) && activity.outcome === "Appuntamento fissato");

// Formule KPI: un solo punto di verità, riusato da riepilogo, righe e legenda.
const contactActions = (row: DailyKpi) => row.callLead + row.callOutbound + row.callClient + row.callOther + row.mexFollowUp;
const outreachSent = (row: DailyKpi) => row.instantlySent + row.dmSent;
const scheduled = (row: DailyKpi) => row.discoveryScheduled + row.demoScheduled + row.demoClientScheduled;
const attendedScheduled = (row: DailyKpi) => row.discoveryHeldBooked + row.demoHeldBooked + row.demoClientHeldBooked;
const sameDayTotal = (row: DailyKpi) => row.discoverySameDay + row.demoSameDay + row.demoClientSameDay;
const callsHeld = (row: DailyKpi) => row.discoveryHeld + row.demoHeld + row.demoClientHeld;
const collected = (row: DailyKpi) => row.collectedNew + row.collectedRenewal + row.collectedUpsell;
const prospectCalls = (row: DailyKpi) => row.callLead + row.callOutbound;
const answerRate = (row: DailyKpi) => pct(row.prospectCallsAnswered, prospectCalls(row));
const attemptsPerReached = (row: DailyKpi) => (row.reachedLeads > 0 ? prospectCalls(row) / row.reachedLeads : null);
const outreachReplyRate = (row: DailyKpi) => pct(row.replies, outreachSent(row));
// % PRENOT: quanti, dopo una discovery svolta, prenotano la closing. È il passo
// che il venditore controlla davvero, ed è il complemento del DROP D/DE.
const bookingRate = (row: DailyKpi) => pct(row.demoBooked + row.demoClientBooked, row.discoveryHeld);
// % PREN RIS: quante discovery nascono dalle risposte all'outreach.
const bookingOnReplies = (row: DailyKpi) => pct(row.discoveryBooked, row.replies);
const showUpDiscovery = (row: DailyKpi) => pct(row.discoveryHeldBooked, row.discoveryScheduled);
const showUpDemo = (row: DailyKpi) => pct(row.demoHeldBooked, row.demoScheduled);
const showUpDemoClient = (row: DailyKpi) => pct(row.demoClientHeldBooked, row.demoClientScheduled);
const showUpTotal = (row: DailyKpi) => pct(attendedScheduled(row), scheduled(row));
const discoveryDemoDrop = (row: DailyKpi) => (row.discoveryHeld > 0 ? (Math.max(row.discoveryHeld - row.demoBooked, 0) / row.discoveryHeld) * 100 : null);
const qualificationRate = (row: DailyKpi) => pct(row.qualified, row.discoveryHeld);
const winRate = (row: DailyKpi) => pct(row.won, row.proposals);
const closeRate = (row: DailyKpi) => pct(row.won, row.demoHeld + row.demoClientHeld);
const averageDeal = (row: DailyKpi) => (row.won > 0 ? row.contractValue / row.won : null);
const cpl = (row: DailyKpi) => (row.leads > 0 ? row.costs / row.leads : null);
const costPerDiscovery = (row: DailyKpi) => (row.discoveryBooked > 0 ? row.costs / row.discoveryBooked : null);
const cac = (row: DailyKpi) => (row.won > 0 ? row.costs / row.won : null);
const roi = (row: DailyKpi) => (row.costs > 0 ? collected(row) / row.costs : null);

export default function Kpi({ client, meName, admin, headerTools }: { client: Client; meName: string; admin: boolean; headerTools?: ReactNode }) {
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [outreach, setOutreach] = useState<SalesOutreachEvent[]>([]);
  const [outreachReady, setOutreachReady] = useState(false);
  const [instantlyActive, setInstantlyActive] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [revenue, setRevenue] = useState<SalesRevenueEvent[]>([]);
  const [costs, setCosts] = useState<SalesCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupWarning, setSetupWarning] = useState(false);
  const [preset, setPreset] = useState<RangePreset>("today");
  const [customFrom, setCustomFrom] = useState(addDays(today(), -29));
  const [customTo, setCustomTo] = useState(today());
  const [seller, setSeller] = useState(admin ? "all" : meName);
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);

  const range = useMemo(() => {
    const end = today();
    if (preset === "custom") return { from: customFrom, to: customTo };
    if (preset === "today") return { from: end, to: end };
    if (preset === "yesterday") { const day = addDays(end, -1); return { from: day, to: day }; }
    if (preset === "month") return { from: `${end.slice(0, 7)}-01`, to: end };
    return { from: addDays(end, -(Number(preset) - 1)), to: end };
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setSetupWarning(false);
    const [activityResult, outreachResult, leadResult, contractResult, revenueResult, costResult, integrationResult] = await Promise.all([
      supabase.from("lead_activities").select("*").eq("client_id", client.id).order("created_at", { ascending: false }).limit(10000),
      supabase.from("sales_outreach_events").select("*").eq("client_id", client.id).order("occurred_at", { ascending: false }).limit(50000),
      supabase.from("leads").select("*").eq("client_id", client.id),
      supabase.from("contracts").select("*").eq("client_id", client.id),
      supabase.from("sales_revenue_events").select("*").eq("client_id", client.id).order("occurred_at", { ascending: false }),
      admin ? supabase.from("sales_costs").select("*").eq("client_id", client.id).order("cost_date", { ascending: false }) : Promise.resolve({ data: [], error: null }),
      supabase.from("sales_integrations").select("*").eq("client_id", client.id),
    ]);
    const coreError = activityResult.error || leadResult.error || contractResult.error;
    if (coreError) setError(`KPI non caricati: ${coreError.message}`);
    // La migrazione manca solo se il database rifiuta le colonne nuove, non se
    // il periodo selezionato è semplicemente vuoto.
    if (outreachResult.error || revenueResult.error || costResult.error) setSetupWarning(true);
    setActivities((activityResult.data as LeadActivity[]) || []);
    setOutreach((outreachResult.data as SalesOutreachEvent[]) || []);
    setOutreachReady(!outreachResult.error);
    // Instantly conta come integrato solo se qualcuno lo ha dichiarato attivo:
    // non basta che la tabella degli eventi sia leggibile.
    const integrations = (integrationResult.data as SalesIntegration[]) || [];
    setInstantlyActive(integrations.some((row) => row.provider === "instantly" && row.is_active));
    setLeads((leadResult.data as Lead[]) || []);
    setContracts((contractResult.data as Contract[]) || []);
    setRevenue((revenueResult.data as SalesRevenueEvent[]) || []);
    setCosts((costResult.data as SalesCost[]) || []);
    setLoading(false);
  }, [admin, client.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!admin) setSeller(meName); }, [admin, meName]);

  const leadById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const sellers = useMemo(() => [...new Set([...leads.map((lead) => lead.assigned_to), ...activities.map((activity) => activity.created_by), ...outreach.map((event) => event.assigned_to)].filter((value): value is string => Boolean(value?.trim())))].sort(), [activities, leads, outreach]);

  const sourceMatches = (leadId: string | null | undefined, explicit?: string | null) => {
    if (channel === "all") return true;
    const source = explicit === "instantly" || explicit === "dm" ? explicit : normalizedLeadSource(leadId ? leadById.get(leadId)?.source : null);
    return source === channel;
  };
  const sellerMatches = (name: string | null | undefined) => seller === "all" || (name || "").trim().toLowerCase() === seller.trim().toLowerCase();
  const inRange = (day: string) => day >= range.from && day <= range.to;

  // Giornata in cui ogni appuntamento è stato prenotato: serve a riconoscere
  // quelli fissati e svolti nella stessa giornata.
  const bookingDayByTask = useMemo(() => {
    const map = new Map<string, string>();
    activities.forEach((activity) => {
      const taskId = taskIdOf(activity);
      if (taskId && (activity.event_type === "discovery_booked" || activity.event_type === "demo_booked")) {
        map.set(taskId, dayInRome(activityTimestamp(activity)));
      }
    });
    return map;
  }, [activities]);

  // La prima cauzione/incasso "new" di ogni lead e' l'evento che trasforma la
  // closing in una vendita vinta. La sola firma di un accordo di prova non e'
  // denaro incassato e non deve gonfiare chiusure, CR o CAC.
  const firstNewRevenueByLead = useMemo(() => {
    const map = new Map<string, SalesRevenueEvent>();
    revenue.forEach((entry) => {
      if (!entry.lead_id || entry.status !== "collected" || entry.revenue_type !== "new") return;
      const current = map.get(entry.lead_id);
      if (!current || entry.occurred_at < current.occurred_at || (entry.occurred_at === current.occurred_at && entry.id < current.id)) {
        map.set(entry.lead_id, entry);
      }
    });
    return map;
  }, [revenue]);

  const signedValueByLead = useMemo(() => {
    const map = new Map<string, number>();
    contracts
      .filter((contract) => contract.lead_id && contract.signed_at)
      .sort((a, b) => (b.signed_at || "").localeCompare(a.signed_at || ""))
      .forEach((contract) => {
        if (!map.has(contract.lead_id!)) map.set(contract.lead_id!, number(contract.deal_value ?? leadById.get(contract.lead_id!)?.value));
      });
    return map;
  }, [contracts, leadById]);

  // Appuntamenti già registrati nel CRM: un booking arrivato dal webhook
  // Instantly non deve aggiungersi a una discovery che il venditore ha già
  // fissato a mano per lo stesso lead.
  const crmBookings = useMemo(() => {
    const keys = new Set<string>();
    activities.forEach((activity) => {
      if (activity.event_type === "discovery_booked" || activity.event_type === "demo_booked") {
        keys.add(`${activity.lead_id}|${dayInRome(activityTimestamp(activity))}`);
      }
    });
    return keys;
  }, [activities]);

  const rows = useMemo(() => {
    const result = new Map<string, DailyKpi>();
    const reachedByDay = new Map<string, Set<string>>();
    for (let day = range.from; day <= range.to; day = addDays(day, 1)) result.set(day, emptyDay(day));
    const rowOf = (day: string) => { if (!result.has(day)) result.set(day, emptyDay(day)); return result.get(day)!; };

    leads.forEach((lead) => {
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
      if (event.event_type === "booking" && !crmBookings.has(`${event.lead_id}|${day}`)) row.discoveryBooked += 1;
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
        sellerMatches(activity.created_by) &&
        sourceMatches(activity.lead_id, activity.channel)
      ) {
        const scheduledDay = dayInRome(activity.scheduled_at);
        // Durante la giornata non consideriamo assente chi deve ancora fare la
        // call: entrerà nel denominatore dello show-up quando arriva il suo
        // orario. Per i giorni passati, invece, tutti gli appuntamenti previsti
        // restano nel calcolo anche se l'esito non è stato compilato.
        const isStillUpcomingToday = scheduledDay === today() && new Date(activity.scheduled_at).getTime() > Date.now();
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
      const appointmentOutcome = fromAppointment && (type === "discovery_call" || type === "demo_call");
      const day = dayInRome(appointmentOutcome && activity.scheduled_at ? activity.scheduled_at : activityTimestamp(activity));
      if (!inRange(day) || !sellerMatches(activity.created_by) || !sourceMatches(activity.lead_id, activity.channel)) return;
      const row = rowOf(day);
      const outcome = activity.outcome || "";
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
        if (isHeldDiscovery(outcome)) {
          row.discoveryHeld += 1;
          if (fromAppointment) row.discoveryHeldBooked += 1;
          if (sameDay) row.discoverySameDay += 1;
        }
        if (outcome === "qualified") row.qualified += 1;
        if (outcome === "no_answer" && fromAppointment) row.noShow += 1;
      }

      if (isBookingActivity(activity)) row.discoveryBooked += 1;
      if (type === "demo_booked") { if (callType === "client") row.demoClientBooked += 1; else row.demoBooked += 1; }

      if (type === "demo_call") {
        row.callMinutes += number(activity.duration_minutes);
        if (outcome === "held") {
          if (callType === "client") { row.demoClientHeld += 1; if (fromAppointment) row.demoClientHeldBooked += 1; if (sameDay) row.demoClientSameDay += 1; }
          else { row.demoHeld += 1; if (fromAppointment) row.demoHeldBooked += 1; if (sameDay) row.demoSameDay += 1; }
        }
        if (outcome === "no_show") row.noShow += 1;
      }
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

    revenue.forEach((entry) => {
      const day = dayInRome(entry.occurred_at);
      if (!inRange(day) || entry.status !== "collected" || !sellerMatches(entry.assigned_to) || !sourceMatches(entry.lead_id)) return;
      const row = rowOf(day);
      if (entry.revenue_type === "new") {
        row.collectedNew += number(entry.amount);
        // Rate successive aumentano l'incassato, ma la closing resta una sola.
        if (entry.lead_id && firstNewRevenueByLead.get(entry.lead_id)?.id === entry.id) {
          row.won += 1;
          row.contractValue += number(entry.contract_value ?? signedValueByLead.get(entry.lead_id) ?? leadById.get(entry.lead_id)?.value);
        }
      }
      if (entry.revenue_type === "renewal") { row.renewals += 1; row.collectedRenewal += number(entry.amount); }
      if (entry.revenue_type === "upsell") { row.upsells += 1; row.collectedUpsell += number(entry.amount); }
    });

    costs.forEach((entry) => {
      const channelMatches = channel === "all" || (channel === "instantly" && entry.cost_type === "instantly") || (channel === "dm" && entry.cost_type === "dm_tools");
      // I costi senza responsabile sono spese di struttura: restano visibili solo
      // sul totale del team, così CPL e CAC di un singolo venditore non ereditano
      // i costi di tutti.
      const ownerMatches = entry.assigned_to ? sellerMatches(entry.assigned_to) : seller === "all";
      if (inRange(entry.cost_date) && channelMatches && ownerMatches) rowOf(entry.cost_date).costs += number(entry.amount);
    });

    return [...result.values()].sort((a, b) => b.day.localeCompare(a.day));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities, bookingDayByTask, channel, contracts, costs, crmBookings, firstNewRevenueByLead, leadById, leads, outreach, outreachReady, range.from, range.to, revenue, seller, signedValueByLead]);

  const total = useMemo(() => {
    const aggregate = sumRows(rows);
    // Nel totale periodo ogni lead raggiunto vale una sola volta, anche se è
    // stato richiamato in giorni diversi. Le righe giornaliere restano invece
    // indipendenti, così il lavoro di ciascun giorno continua a essere leggibile.
    const uniqueReached = new Set<string>();
    activities.forEach((activity) => {
      if (!isCallActivity(activity)) return;
      const callType = activity.call_type || "lead";
      if (callType !== "lead" && callType !== "outbound") return;
      const outcome = activity.outcome || "";
      if (outcome === "no_answer" || outcome === "Non risponde") return;
      const day = dayInRome(activityTimestamp(activity));
      if (!inRange(day) || !sellerMatches(activity.created_by) || !sourceMatches(activity.lead_id, activity.channel)) return;
      uniqueReached.add(activity.lead_id);
    });
    aggregate.reachedLeads = uniqueReached.size;
    return aggregate;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities, channel, leadById, range.from, range.to, rows, seller]);

  // Lo stesso giorno non può avere volumi manuali e volumi dal webhook Instantly:
  // sarebbero due conteggi dello stesso invio.
  const outreachConflicts = useMemo(() => {
    const manual = new Set<string>();
    const automatic = new Set<string>();
    outreach.forEach((event) => {
      if (event.channel !== "instantly" || event.event_type !== "sent") return;
      const day = dayInRome(event.occurred_at);
      if (!inRange(day)) return;
      (event.external_id?.startsWith("manual:") ? manual : automatic).add(day);
    });
    return [...manual].filter((day) => automatic.has(day)).sort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outreach, range.from, range.to]);

  if (loading) return <div className="center-msg">Calcolo KPI commerciali…</div>;

  return <div className="page kpi-page">
    <div className="kpi-intro">
      <div><span className="eyebrow">CONTROLLO COMMERCIALE</span><h1>KPI vendite</h1><p>Outreach Instantly e DM → discovery telefonica → closing in videochiamata → contratto e incasso.</p></div>
      <div className="section-header-actions">{headerTools}<button className="btn" onClick={() => void load()}>Aggiorna</button><button className="btn" onClick={() => setOutreachOpen(true)}>+ Dati outreach</button>{admin && <button className="btn primary" onClick={() => setCostOpen(true)}>+ Registra costo</button>}</div>
    </div>
    {error && <div className="notice err">{error}</div>}
    {setupWarning && <div className="notice warn"><b>Tracciamento KPI da completare nel database.</b> La pagina mostra i dati disponibili, ma incassi, costi e colonne nuove saranno completi dopo le migrazioni <code>upgrade_sales_kpis.sql</code> e <code>upgrade_sales_kpis_v2.sql</code>.</div>}
    {outreachConflicts.length > 0 && <div className="notice warn"><b>Possibile doppio conteggio Instantly.</b> In {outreachConflicts.length === 1 ? "questa giornata" : "queste giornate"} ({outreachConflicts.join(", ")}) risultano sia invii registrati a mano sia invii arrivati dal webhook: i volumi si sommano. Tieni una sola delle due fonti.</div>}

    <section className="kpi-filters panel">
      <div><label>Periodo</label><div className="segmented"><button className={preset === "today" ? "active" : ""} onClick={() => setPreset("today")}>Oggi</button><button className={preset === "yesterday" ? "active" : ""} onClick={() => setPreset("yesterday")}>Ieri</button><button className={preset === "7" ? "active" : ""} onClick={() => setPreset("7")}>7 giorni</button><button className={preset === "30" ? "active" : ""} onClick={() => setPreset("30")}>30 giorni</button><button className={preset === "month" ? "active" : ""} onClick={() => setPreset("month")}>Mese corrente</button><button className={preset === "custom" ? "active" : ""} onClick={() => setPreset("custom")}>Personalizzato</button></div></div>
      {preset === "custom" && <div className="kpi-date-range"><label>Dal<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label>Al<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label></div>}
      <label>Canale<select value={channel} onChange={(event) => setChannel(event.target.value as ChannelFilter)}><option value="all">Instantly + DM</option><option value="instantly">Solo Instantly</option><option value="dm">Solo DM</option></select></label>
      {admin && <label>Venditore<select value={seller} onChange={(event) => setSeller(event.target.value)}><option value="all">Tutto il team</option>{sellers.map((name) => <option value={name} key={name}>{name}</option>)}</select></label>}
    </section>

    <div className="kpi-summary-grid">
      <Summary label="Azioni di contatto" value={contactActions(total)} detail={`${total.callLead} richiami · ${total.mexFollowUp} mex FU`} />
      <Summary label="% RISP" value={formatPct(answerRate(total))} detail={`${total.prospectCallsAnswered} risposte / ${prospectCalls(total)} call prospect`} />
      <Summary label="T/M" value={ratio(attemptsPerReached(total))} detail={`${prospectCalls(total)} tentativi / ${total.reachedLeads} lead raggiunti`} />
      <Summary label="Messaggi outreach" value={outreachSent(total)} detail={`${total.instantlySent} Instantly · ${total.dmSent} DM`} />
      <Summary label="% PRENOT" value={formatPct(bookingRate(total))} detail={`${total.demoBooked + total.demoClientBooked} closing / ${total.discoveryHeld} discovery svolte`} />
      <Summary label="% PREN RIS" value={formatPct(bookingOnReplies(total))} detail={`${total.discoveryBooked} discovery / ${total.replies} risposte`} />
      <Summary label="Call tot svolte" value={callsHeld(total)} detail={`${total.discoveryHeld} disco · ${total.demoHeld} closing · ${total.demoClientHeld} closing GC`} />
      <Summary label="SHOW UP TOT" value={formatPct(showUpTotal(total))} detail={`${attendedScheduled(total)} presenti / ${scheduled(total)} previsti`} />
      <Summary label="DROP D/DE" value={formatPct(discoveryDemoDrop(total))} detail={`${Math.max(total.discoveryHeld - total.demoBooked, 0)} persi / ${total.discoveryHeld} discovery`} />
      <Summary label="% in target" value={formatPct(qualificationRate(total))} detail={`${total.qualified} in target / ${total.discoveryHeld} discovery`} />
      <Summary label="% chiusura" value={formatPct(winRate(total))} detail={`${total.won} vinte / ${total.proposals} proposte`} />
      <Summary label="CR" value={formatPct(closeRate(total))} detail={`${total.won} vinte / ${total.demoHeld + total.demoClientHeld} closing svolte`} />
      <Summary label="VAL TOT" value={eur(total.contractValue)} detail={`${total.won} vendite vinte`} />
      <Summary label="VAL TOT M" value={averageDeal(total) === null ? "—" : eur(averageDeal(total)!)} detail="Valore medio per contratto" />
      <Summary label="€ SALES" value={eur(collected(total))} detail={`${eur(total.collectedNew)} nuovo · ${eur(total.collectedRenewal + total.collectedUpsell)} rinnovi e upsell`} positive />
    </div>

    <section className="panel kpi-table-panel">
      <header><div><span className="eyebrow">GIORNO PER GIORNO</span><h2>Registro KPI</h2></div><span>Fuso orario: Europa/Roma</span></header>
      <div className="kpi-table-scroll"><table className="kpi-table">
        <thead>
          <tr className="kpi-group-row">
            <th className="sticky-col" />
            <th colSpan={10}>Azioni di contatto</th>
            <th colSpan={5}>Lead e outreach</th>
            <th colSpan={5}>Prenotazioni</th>
            <th colSpan={4}>Fissati e svolti in giornata</th>
            <th colSpan={12}>Appuntamenti svolti</th>
            <th colSpan={6}>Chiusura</th>
            <th colSpan={6}>Denaro</th>
            {admin && <th colSpan={5}>Costi</th>}
          </tr>
          <tr>
            <th className="sticky-col">Data</th>
            <th>Richiami</th><th>Call outbound</th><th>Call già clienti</th><th>Altre call</th><th>Mex FU</th><th>Azioni tot</th><th>Min call</th><th>Call prospect risp</th><th>% RISP</th><th>T/M</th>
            <th>N. lead</th><th>Instantly</th><th>DM</th><th>Risposte</th>
            <th>Positive</th><th>Disco fiss</th><th>Closing fiss</th><th>Closing GC fiss</th><th>% PRENOT</th>
            <th>% PREN RIS</th><th>Disco day</th><th>Closing day</th><th>Closing GC day</th>
            <th>Call tot day</th><th>Disco svolte</th><th>Closing svolte</th><th>Closing GC svolte</th><th>Call tot</th><th>No show</th><th>% show disco</th><th>% show closing</th>
            <th>% show closing GC</th><th>SHOW UP TOT</th><th>DROP D/DE</th><th>In target</th>
            <th>% in target</th><th>Proposte</th><th>Chiusure</th><th>% chiusura</th><th>CR</th><th>Upsell</th>
            <th>Rinnovi</th><th>Inc. nuovo</th><th>Inc. rinnovo</th><th>Inc. upsell</th><th>Inc. totale</th><th>VAL TOT</th><th>VAL TOT M</th>
            {admin && <><th>Costi</th><th>CPL</th><th>Costo/disco</th><th>CAC</th><th>ROI</th></>}
          </tr>
        </thead>
        <tbody>
          <KpiRow row={total} total admin={admin} />
          {rows.map((row) => <KpiRow key={row.day} row={row} admin={admin} />)}
        </tbody>
      </table></div>
    </section>

    <details className="panel kpi-definitions"><summary>Come vengono calcolati i numeri</summary><div>
      <p><b>Azioni di contatto:</b> richiami + call outbound + call già clienti + altre call + messaggi di follow-up. <b>% RISP:</b> call a prospect con risposta ÷ richiami e call outbound. <b>T/M:</b> tentativi di richiamo e outbound ÷ lead raggiunti.</p>
      <p><b>Lead raggiunti:</b> nel totale del periodo ogni lead conta una volta sola anche se richiamato in giorni diversi; nelle righe giornaliere conta in ogni giornata in cui è stato davvero lavorato.</p>
      <p><b>% PRENOT:</b> closing prenotate ÷ discovery svolte — quanti, dopo la discovery, accettano la closing. <b>% PREN RIS:</b> discovery fissate ÷ risposte outreach.</p>
      <p><b>Colonne “day”:</b> appuntamenti svolti senza attesa — fissati e chiusi in giornata, oppure fatti al volo durante la chiamata senza prenotazione. <b>Show up:</b> appuntamenti svolti ÷ appuntamenti previsti in agenda nello stesso giorno, anche se erano stati fissati nei giorni precedenti. Una discovery fatta seduta stante non gonfia lo show-up. <b>DROP D/DE:</b> discovery svolte che non producono una closing ÷ discovery svolte.</p>
      <p><b>In target:</b> discovery chiuse con esito “in target”. Una discovery è svolta solo con esito in target o fuori target; “non risponde” resta un tentativo.</p>
      <p><b>Proposte:</b> contratti creati o inviati. <b>Vendita vinta:</b> prima cauzione o primo incasso “nuovo” realmente ricevuto per il lead; la sola firma di una prova gratuita non conta. <b>% chiusura:</b> vendite vinte ÷ proposte. <b>CR:</b> vendite vinte ÷ closing svolte.</p>
      <p><b>VAL TOT:</b> valore contrattuale delle vendite vinte. <b>VAL TOT M:</b> valore medio per vendita vinta. <b>€ SALES:</b> incassato reale del periodo. Le rate successive aumentano € SALES ma non creano una seconda chiusura.</p>
      <p><b>CPL:</b> costi ÷ lead entrati. <b>Costo/disco:</b> costi ÷ discovery fissate. <b>CAC:</b> costi ÷ vendite vinte. <b>ROI:</b> incassato ÷ costi. I costi senza responsabile compaiono solo sul totale del team.</p>
      <p><b>Denominatore a zero:</b> la cella mostra “—”, mai 0%.</p>
    </div></details>

    {outreachOpen && <OutreachModal client={client} meName={meName} admin={admin} sellers={sellers} instantlyActive={instantlyActive} onClose={() => setOutreachOpen(false)} onSaved={() => { setOutreachOpen(false); void load(); }} />}
    {costOpen && <CostModal client={client} meName={meName} sellers={sellers} onClose={() => setCostOpen(false)} onSaved={() => { setCostOpen(false); void load(); }} />}
  </div>;
}

function Summary({ label, value, detail, positive }: { label: string; value: string | number; detail: string; positive?: boolean }) {
  return <article className={`kpi-summary${positive ? " positive" : ""}`}><span>{label}</span><b>{value}</b><small>{detail}</small></article>;
}

function KpiRow({ row, total, admin }: { row: DailyKpi; total?: boolean; admin: boolean }) {
  const label = total ? "Totale periodo" : new Date(`${row.day}T12:00:00Z`).toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short", timeZone: "Europe/Rome" });
  const money = (value: number | null) => (value === null ? "—" : eur(value));
  return <tr className={total ? "total" : row.day === today() ? "today" : ""}>
    <th className="sticky-col">{label}</th>
    <td>{row.callLead}</td><td>{row.callOutbound}</td><td>{row.callClient}</td><td>{row.callOther}</td><td>{row.mexFollowUp}</td>
    <td>{contactActions(row)}</td><td>{row.callMinutes}</td><td>{row.prospectCallsAnswered}</td><td>{formatPct(answerRate(row))}</td><td>{ratio(attemptsPerReached(row))}</td>
    <td>{row.leads}</td><td>{row.instantlySent}</td><td>{row.dmSent}</td><td>{row.replies}</td><td>{row.positiveReplies}</td>
    <td>{row.discoveryBooked}</td><td>{row.demoBooked}</td><td>{row.demoClientBooked}</td><td>{formatPct(bookingRate(row))}</td><td>{formatPct(bookingOnReplies(row))}</td>
    <td>{row.discoverySameDay}</td><td>{row.demoSameDay}</td><td>{row.demoClientSameDay}</td><td>{sameDayTotal(row)}</td>
    <td>{row.discoveryHeld}</td><td>{row.demoHeld}</td><td>{row.demoClientHeld}</td><td>{callsHeld(row)}</td><td>{row.noShow}</td>
    <td>{formatPct(showUpDiscovery(row))}</td><td>{formatPct(showUpDemo(row))}</td><td>{formatPct(showUpDemoClient(row))}</td><td>{formatPct(showUpTotal(row))}</td>
    <td>{formatPct(discoveryDemoDrop(row))}</td><td>{row.qualified}</td><td>{formatPct(qualificationRate(row))}</td>
    <td>{row.proposals}</td><td>{row.won}</td><td>{formatPct(winRate(row))}</td><td>{formatPct(closeRate(row))}</td><td>{row.upsells}</td><td>{row.renewals}</td>
    <td>{eur(row.collectedNew)}</td><td>{eur(row.collectedRenewal)}</td><td>{eur(row.collectedUpsell)}</td><td className="money">{eur(collected(row))}</td>
    <td>{eur(row.contractValue)}</td><td>{money(averageDeal(row))}</td>
    {admin && <><td>{eur(row.costs)}</td><td>{money(cpl(row))}</td><td>{money(costPerDiscovery(row))}</td><td>{money(cac(row))}</td><td>{roi(row) === null ? "—" : `${ratio(roi(row))}x`}</td></>}
  </tr>;
}

function OutreachModal({ client, meName, admin, sellers, instantlyActive, onClose, onSaved }: { client: Client; meName: string; admin: boolean; sellers: string[]; instantlyActive: boolean; onClose: () => void; onSaved: () => void }) {
  const [channel, setChannel] = useState<"instantly" | "dm">("dm");
  const [date, setDate] = useState(today());
  const [sent, setSent] = useState(""); const [replies, setReplies] = useState(""); const [positive, setPositive] = useState("");
  const [assignedTo, setAssignedTo] = useState(meName);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  async function save() {
    if (lock.current) return;
    const sentCount = number(sent); const replyCount = number(replies); const positiveCount = number(positive);
    if (!date) return setError("Scegli la data.");
    if (sent === "" && replies === "" && positive === "") return setError("Inserisci almeno un valore. Scrivi 0 per azzerare un dato già registrato.");
    if (positiveCount > replyCount) return setError("Le risposte positive non possono superare le risposte totali.");
    const owner = (assignedTo || meName).trim();
    if (!owner) return setError("Indica il responsabile.");
    const occurredAt = new Date(`${date}T12:00:00Z`).toISOString();
    const common = { client_id: client.id, lead_id: null, channel, occurred_at: occurredAt, assigned_to: owner, created_by: meName, campaign_name: "Inserimento giornaliero", details: { aggregate: true } };
    const keys = { sent: outreachKey(date, channel, owner, "sent"), reply: outreachKey(date, channel, owner, "reply"), positive: outreachKey(date, channel, owner, "positive") };

    const records: Record<string, unknown>[] = [];
    if (sentCount > 0) records.push({ ...common, event_type: "sent", quantity: sentCount, external_id: keys.sent });
    if (replyCount > 0) records.push({ ...common, event_type: "reply", quantity: replyCount, external_id: keys.reply });
    if (positiveCount > 0) records.push({ ...common, event_type: "positive_reply", quantity: positiveCount, external_id: keys.positive });
    // Un valore riportato a zero elimina il dato precedente invece di lasciarlo
    // a bilancio: è così che si corregge una giornata inserita per errore.
    const zeroKeys = [sentCount <= 0 ? keys.sent : null, replyCount <= 0 ? keys.reply : null, positiveCount <= 0 ? keys.positive : null].filter((value): value is string => Boolean(value));

    lock.current = true; setBusy(true); setError(null);
    const result = records.length ? await supabase.from("sales_outreach_events").upsert(records, { onConflict: "client_id,external_id" }) : { error: null };
    const cleared = !result.error && zeroKeys.length
      ? await supabase.from("sales_outreach_events").delete().eq("client_id", client.id).in("external_id", zeroKeys)
      : { error: null };
    setBusy(false); lock.current = false;
    if (result.error || cleared.error) setError((result.error || cleared.error)?.message || "Dati non salvati."); else onSaved();
  }

  const people = [...new Set([meName, ...sellers].filter(Boolean))];
  return <div className="overlay" onClick={onClose}><div className="modal kpi-cost-modal" onClick={(event) => event.stopPropagation()}>
    <header><div><h3>Registra outreach giornaliero</h3><p>Una sola riga per data, canale e responsabile: risalvando la stessa combinazione il valore viene sostituito, non sommato. Scrivi 0 per cancellare un dato.</p></div><button className="x" onClick={onClose}>×</button></header>
    <div className="content">
      {error && <div className="notice err">{error}</div>}
      {channel === "instantly" && instantlyActive && <div className="notice warn">Il webhook Instantly risulta attivo: gli invii arrivano già da soli. Inserirli anche a mano li conterebbe due volte.</div>}
      <div className="modal-row">
        <div className="field"><label>Canale</label><select value={channel} onChange={(event) => setChannel(event.target.value as "instantly" | "dm")}><option value="dm">DM</option><option value="instantly">Instantly · {instantlyActive ? "webhook attivo" : "recupero manuale"}</option></select></div>
        <div className="field"><label>Data</label><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></div>
      </div>
      {admin && <div className="field"><label>Responsabile</label><select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)}>{people.map((person) => <option key={person} value={person}>{person}</option>)}</select></div>}
      <div className="modal-row">
        <div className="field"><label>Messaggi inviati</label><input type="number" min="0" step="1" value={sent} onChange={(event) => setSent(event.target.value)} /></div>
        <div className="field"><label>Risposte</label><input type="number" min="0" step="1" value={replies} onChange={(event) => setReplies(event.target.value)} /></div>
      </div>
      <div className="field"><label>Risposte positive</label><input type="number" min="0" step="1" value={positive} onChange={(event) => setPositive(event.target.value)} /></div>
    </div>
    <footer><button className="btn" onClick={onClose}>Annulla</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "Salvataggio…" : "Registra dati"}</button></footer>
  </div></div>;
}

function CostModal({ client, meName, sellers, onClose, onSaved }: { client: Client; meName: string; sellers: string[]; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<SalesCost["cost_type"]>("instantly");
  const [amount, setAmount] = useState(""); const [date, setDate] = useState(today()); const [note, setNote] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  async function save() {
    if (lock.current) return;
    if (number(amount) <= 0 || !date) return setError("Inserisci un importo e una data validi.");
    lock.current = true; setBusy(true); setError(null);
    const result = await supabase.from("sales_costs").insert({ client_id: client.id, cost_type: type, amount: number(amount), cost_date: date, note: note.trim() || null, created_by: meName, assigned_to: owner || null });
    setBusy(false); lock.current = false;
    if (result.error) setError(result.error.message); else onSaved();
  }

  const people = [...new Set([meName, ...sellers].filter(Boolean))];
  return <div className="overlay" onClick={onClose}><div className="modal kpi-cost-modal" onClick={(event) => event.stopPropagation()}>
    <header><div><h3>Registra costo outreach</h3><p>Serve per CPL, costo per discovery, CAC e ROI.</p></div><button className="x" onClick={onClose}>×</button></header>
    <div className="content">
      {error && <div className="notice err">{error}</div>}
      <div className="field"><label>Tipo di costo</label><select value={type} onChange={(event) => setType(event.target.value as SalesCost["cost_type"])}><option value="instantly">Instantly / email</option><option value="dm_tools">Strumenti DM</option><option value="personnel">Personale outreach</option><option value="other">Altro</option></select></div>
      <div className="modal-row">
        <div className="field"><label>Importo (€)</label><input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
        <div className="field"><label>Data</label><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></div>
      </div>
      <div className="field"><label>Responsabile <small>(facoltativo)</small></label><select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">Costo di struttura · tutto il team</option>{people.map((person) => <option key={person} value={person}>{person}</option>)}</select><small>Un costo attribuito entra nel CPL e nel CAC di quel venditore. Senza responsabile resta solo sul totale del team.</small></div>
      <div className="field"><label>Nota</label><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Es. abbonamento mensile" /></div>
    </div>
    <footer><button className="btn" onClick={onClose}>Annulla</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "Salvataggio…" : "Registra costo"}</button></footer>
  </div></div>;
}
