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
