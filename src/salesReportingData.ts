import { supabase } from "./supabaseClient";
import { loadGoogleSales } from "./googleSalesData";
import { loadAppointmentRows } from "./appointmentWork";
import { suggestDailyReport } from "./salesReporting";
import type { LeadActivity, SalesOutreachEvent, SalesRevenueEvent } from "./types";

export async function salesPages<T>(table: string, clientId: string) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from(table).select("*").eq("client_id", clientId).order("id").range(offset, offset + 499);
    if (error) throw new Error(error.message);
    rows.push(...data as T[]);
    if (data.length < 500) return rows;
  }
}

function readSource<T>(request: Promise<T>) {
  return request.then(data => ({ data, error: null })).catch((reason: unknown) => ({
    data: null,
    error: reason instanceof Error ? reason : new Error("Fonte KPI non disponibile"),
  }));
}

export async function loadSalesKpiSources(clientId: string) {
  const [activities, outreach, revenue, standalone, google] = await Promise.all([
    readSource(salesPages<LeadActivity>("lead_activities", clientId)),
    readSource(salesPages<SalesOutreachEvent>("sales_outreach_events", clientId)),
    readSource(salesPages<SalesRevenueEvent>("sales_revenue_events", clientId)),
    readSource(loadAppointmentRows(clientId, "standalone")),
    readSource(loadGoogleSales(clientId)),
  ]);
  return {
    activities, outreach, revenue, standalone,
    google: {
      data: google.data?.data ?? [],
      error: google.error || google.data?.error || null,
    },
  };
}

export async function loadDailyReportSuggestion(clientId: string, day: string) {
  const sources = await loadSalesKpiSources(clientId);
  if (!sources.activities.data || !sources.outreach.data || !sources.revenue.data || !sources.standalone.data || sources.google.error) {
    throw new Error("Una fonte di KPI vendite è indisponibile.");
  }
  return suggestDailyReport(day, {
    activities: sources.activities.data,
    outreach: sources.outreach.data,
    revenue: sources.revenue.data,
    standalone: sources.standalone.data,
    externalSales: sources.google.data,
  });
}
