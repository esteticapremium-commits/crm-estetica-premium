/** Placement only: never changes event dates or booking rules. */
export function layoutIntervals<T extends { start: number; end: number; id: string }>(items: T[]) {
  const sorted = [...items].sort((a,b) => a.start-b.start || a.end-b.end || a.id.localeCompare(b.id));
  const result: (T & { column:number; columns:number })[] = [];
  let group: (T & {column:number;columns:number})[] = [], ends:number[] = [], groupEnd = -1;
  const flush = () => { for (const item of group) { item.columns = ends.length; result.push(item); } group=[]; ends=[]; };
  for (const item of sorted) {
    if (item.start >= groupEnd) flush();
    let column = ends.findIndex(end => end <= item.start);
    if (column < 0) column = ends.length;
    ends[column] = item.end;
    group.push({...item,column,columns:1}); groupEnd = Math.max(groupEnd, item.end);
  }
  flush(); return result;
}
export function romeMinutes(iso: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone:"Europe/Rome",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(iso));
  return Number(parts.find(p=>p.type==="hour")?.value)*60 + Number(parts.find(p=>p.type==="minute")?.value);
}

export function nextTimedEvent(events: readonly { at: string; allDay?: boolean; skipAsNext?: boolean }[], now: Date) {
  const currentMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  let nextAt: string | undefined;
  let delay = Infinity;
  for (const event of events) {
    if (event.allDay || event.skipAsNext) continue;
    const startsAt = Date.parse(event.at);
    const wait = startsAt - now.getTime();
    if (startsAt >= currentMinute && wait < delay) {
      nextAt = event.at;
      delay = wait;
    }
  }
  return nextAt ? { at: nextAt, minutes: Math.max(0, Math.ceil(delay / 60_000)) } : null;
}
