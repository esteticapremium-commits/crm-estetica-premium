export const dailyMetrics = [
  ['calls_made', 'Chiamate fatte'],
  ['discovery_booked', 'Discovery prenotate'],
  ['discovery_held', 'Discovery svolte'],
  ['demo_booked', 'Demo prenotate'],
  ['demo_held', 'Demo svolte'],
  ['demo_won', 'Demo chiuse'],
] as const;
export type DailyMetric = typeof dailyMetrics[number][0];
export type DailyNumbers = Record<DailyMetric, number>;
export type DailyReport = Omit<DailyNumbers, "demo_booked"> & { demo_booked: number | null } & { id: string; version: number; client_id: string; report_date: string; notes: string; updated_at: string };
export const emptyDailyNumbers = (): DailyNumbers => ({calls_made:0, discovery_booked:0, discovery_held:0, demo_booked:0, demo_held:0, demo_won:0});
export function reportRange(day: string, mode: 'week' | 'month') {
  const d = new Date(`${day}T12:00:00Z`);
  const start = new Date(d); const end = new Date(d);
  if (mode === 'week') { start.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); end.setTime(start.getTime()); end.setUTCDate(start.getUTCDate() + 6); }
  else { start.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + 1, 0); }
  return {from:start.toISOString().slice(0,10), to:end.toISOString().slice(0,10)};
}
export function reportDays(from: string, to: string) {
  const result: string[] = []; const d = new Date(`${from}T12:00:00Z`);
  while (d.toISOString().slice(0,10) <= to) { result.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()+1); }
  return result;
}
export function sumDailyReports(rows: Record<DailyMetric, number | null>[]): Record<DailyMetric, number | null> {
  return rows.reduce<Record<DailyMetric, number | null>>((sum,row) => {
    for (const [key] of dailyMetrics) sum[key] = sum[key] === null || row[key] == null ? null : sum[key]! + row[key]!;
    return sum;
  }, emptyDailyNumbers());
}
export function parseDailyNumbers(values: Record<DailyMetric,string>): DailyNumbers | null {
  const numbers = emptyDailyNumbers();
  for (const [key] of dailyMetrics) {
    if (!/^\d+$/.test(values[key])) return null;
    const n = Number(values[key]); if (!Number.isSafeInteger(n) || n > 2147483647) return null;
    numbers[key] = n;
  }
  return numbers;
}
