import { useEffect, useMemo, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { supabase } from "../supabaseClient";
import type { EditorialContent, EditorialStatus } from "../types";
import { romeToday } from "../dates";

type View = "today" | "calendar" | "kanban" | "list";
const STATUS: Record<EditorialStatus, string> = { idea: "Da definire", in_production: "Da registrare", review: "Da editare", scheduled: "Da pubblicare", published: "Pubblicato" };
const CHANNELS = ["Instagram", "TikTok", "LinkedIn", "YouTube", "Newsletter", "Blog", "Altro"];
const KANBAN: EditorialStatus[] = ["idea", "in_production", "review", "scheduled", "published"];
const ROUTINES: Record<number, { title: string; steps: string[]; priority?: boolean }> = {
  1: { title: "Controlla piano editoriale settimana", steps: ["Controlla i reel dei prossimi 7 giorni", "Verifica argomenti, venerdì e CTA", "Verifica buffer contenuti"] },
  3: { title: "Controllo produzione contenuti", steps: ["Controlla reel da registrare", "Verifica montaggi in sospeso", "Copri sabato e domenica"] },
  5: { title: "Pubblica Video Offerta", steps: ["Pubblica il video offerta con CTA", "Controlla che sabato e domenica siano pronti", "Imposta almeno il lunedì"], priority: true },
  0: { title: "Prepara prossima settimana", steps: ["Controlla i prossimi 7 giorni", "Inserisci argomenti mancanti", "Verifica CTA, venerdì e buffer"] },
};

function asDate(date: string) { return new Date(`${date}T12:00:00`); }
function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function formatDate(date: string) { return asDate(date).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }); }
function weekDays(today: string) { const first = asDate(today); const weekDay = first.getDay() || 7; first.setDate(first.getDate() - weekDay + 1); return Array.from({ length: 7 }, (_, i) => { const day = new Date(first); day.setDate(first.getDate() + i); return isoDate(day); }); }
function addDays(day: string, amount: number) { const date = asDate(day); date.setDate(date.getDate() + amount); return isoDate(date); }
function workForDay(items: EditorialContent[], day: string) { return items.flatMap((item) => { if (!item.scheduled_for || item.status === "published") return []; const distance = Math.round((asDate(item.scheduled_for).getTime() - asDate(day).getTime()) / 86_400_000); if (distance === 3) return [{ item, action: "Scrivi script", tone: "write" }]; if (distance === 2) return [{ item, action: "Registra", tone: "record" }]; if (distance === 1) return [{ item, action: "Controlla / manda al montaggio", tone: "review" }]; if (distance === 0) return [{ item, action: "Pubblica", tone: "publish" }]; return []; }); }
function readyBuffer(items: EditorialContent[], today: string) { let count = 0; for (let index = 0; index < 30; index += 1) { const day = addDays(today, index); const ready = items.some((item) => item.scheduled_for === day && ["scheduled", "published"].includes(item.status)); if (!ready) break; count += 1; } return count; }

export default function EditorialPlan({ clientId, meName }: { clientId: string; meName: string }) {
  const [items, setItems] = useState<EditorialContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("today");
  const [editing, setEditing] = useState<EditorialContent | null | "new">(null);
  const [selectedDay, setSelectedDay] = useState(romeToday());
  const [routineChecks, setRoutineChecks] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem("ep-editorial-routine-checks") || "{}"); } catch { return {}; } });
  const [generating, setGenerating] = useState(false);

  const load = () => {
    setLoading(true); setLoadError(null);
    supabase.from("editorial_contents").select("*").eq("client_id", clientId).order("scheduled_for", { ascending: true, nullsFirst: false }).then(({ data, error }) => {
      if (error) setLoadError(error.message);
      setItems((data as EditorialContent[]) ?? []); setLoading(false);
    });
  };
  useEffect(load, [clientId]);

  const today = romeToday();
  const todayItems = useMemo(() => items.filter((x) => x.scheduled_for === selectedDay && x.status !== "published"), [items, selectedDay]);
  const overdue = useMemo(() => items.filter((x) => x.scheduled_for && x.scheduled_for < today && x.status !== "published"), [items, today]);
  const upcoming = items.filter((x) => x.scheduled_for && x.scheduled_for >= today && x.status !== "published");
  const days = weekDays(selectedDay);
  const todayWork = useMemo(() => workForDay(items, selectedDay), [items, selectedDay]);
  const buffer = useMemo(() => readyBuffer(items, today), [items, today]);
  const routine = ROUTINES[asDate(selectedDay).getDay()];
  const hasFridayOffer = items.some((item) => item.scheduled_for && asDate(item.scheduled_for).getDay() === 5 && (item.pillar || "").toLowerCase().includes("video offerta"));
  const toggleRoutine = (key: string) => setRoutineChecks((current) => { const next = { ...current, [key]: !current[key] }; localStorage.setItem("ep-editorial-routine-checks", JSON.stringify(next)); return next; });
  const generateThirtyDays = async () => {
    setGenerating(true); setLoadError(null); const occupied = new Set(items.map((item) => item.scheduled_for).filter(Boolean)); const slots: Record<string, unknown>[] = []; let valueCount = 0;
    for (let index = 0; index < 30; index += 1) { const date = addDays(today, index); if (occupied.has(date)) continue; const friday = asDate(date).getDay() === 5; const kind = friday ? "VIDEO OFFERTA" : valueCount === 3 ? "CTA" : "VALORE"; if (friday || kind === "CTA") valueCount = 0; else valueCount += 1; slots.push({ client_id: clientId, title: "Titolo da definire", channel: "Instagram", format: "Reel", status: "idea", scheduled_for: date, owner: meName, pillar: kind, cta: kind === "VALORE" ? null : "CTA da definire", notes: "Slot generato dal piano: definisci argomento e script." }); }
    if (slots.length > 0) { const { error } = await supabase.from("editorial_contents").insert(slots); if (error) setLoadError(error.message); }
    setGenerating(false); load();
  };
  const moveKanbanCard = async (item: EditorialContent, status: EditorialStatus) => {
    if (item.status === status) return;
    setLoadError(null);
    setItems((current) => current.map((content) => content.id === item.id ? { ...content, status } : content));
    const { error } = await supabase.from("editorial_contents").update({ status }).eq("id", item.id).eq("client_id", clientId);
    if (error) {
      setItems((current) => current.map((content) => content.id === item.id ? item : content));
      setLoadError(`Non sono riuscito ad aggiornare il contenuto: ${error.message}`);
    }
  };

  return <div className="page editorial-page">
    <div className="editorial-intro"><div><h1>Piano editoriale</h1><p>Apri qui ogni mattina: sai subito cosa scrivere, registrare, controllare e pubblicare.</p></div><div className="editorial-intro-actions"><button className="btn" disabled={generating} onClick={() => void generateThirtyDays()}>{generating ? "Genero…" : "Genera prossimi 30 giorni"}</button><button className="btn primary" onClick={() => setEditing("new")}>+ Nuovo contenuto</button></div></div>
    <div className="cards-grid editorial-kpis"><Kpi label="Da fare oggi" value={todayWork.length + todayItems.length} /><Kpi label="Da registrare" value={items.filter((x) => x.status === "in_production").length} /><Kpi label="Da editare" value={items.filter((x) => x.status === "review").length} /><Kpi label="Buffer contenuti" value={`${buffer} giorni`} /></div>
    <section className="panel editorial-workspace">
      <div className="editorial-toolbar"><div className="editorial-views"><button className={view === "today" ? "active" : ""} onClick={() => setView("today")}>Oggi</button><button className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")}>Calendario</button><button className={view === "kanban" ? "active" : ""} onClick={() => setView("kanban")}>Kanban</button><button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>Elenco</button></div><div className="editorial-day"><button onClick={() => { const d = asDate(selectedDay); d.setDate(d.getDate() - 1); setSelectedDay(isoDate(d)); }}>‹</button><input type="date" value={selectedDay} onChange={(e) => setSelectedDay(e.target.value || today)} /><button onClick={() => { const d = asDate(selectedDay); d.setDate(d.getDate() + 1); setSelectedDay(isoDate(d)); }}>›</button><button className="today-jump" onClick={() => setSelectedDay(today)}>Oggi</button></div></div>
      {loading ? <p className="muted editorial-loading">Caricamento piano editoriale…</p> : loadError && items.length === 0 ? <div className="empty-editorial"><b>Il piano editoriale non è ancora attivo.</b><span>Nel database manca la relativa migrazione: {loadError}</span></div> : <>{loadError && <div className="notice err editorial-save-error">{loadError}</div>}{items.length === 0 ? <Empty onNew={() => setEditing("new")} /> : <>
        {view === "today" && <TodayView day={selectedDay} items={todayItems} work={todayWork} routine={routine} routineChecks={routineChecks} overdue={overdue} hasFridayOffer={hasFridayOffer} buffer={buffer} onToggleRoutine={toggleRoutine} onEdit={setEditing} onNew={() => setEditing("new")} />}
        {view === "calendar" && <CalendarView days={days} items={items} selectedDay={selectedDay} onSelectDay={setSelectedDay} onEdit={setEditing} />}
        {view === "kanban" && <KanbanView items={items} onEdit={setEditing} onStatusChange={moveKanbanCard} />}
        {view === "list" && <ListView items={items} onEdit={setEditing} />}
      </>}</>}
    </section>
    {editing && <ContentForm item={editing === "new" ? null : editing} clientId={clientId} meName={meName} initialDate={selectedDay} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
  </div>;
}

function Kpi({ label, value }: { label: string | number; value: string | number }) { return <div className="stat"><div className="k">{label}</div><div className="v">{value}</div></div>; }
function Empty({ onNew }: { onNew: () => void }) { return <div className="empty-editorial"><b>Il tuo calendario è libero.</b><span>Aggiungi il primo contenuto: bastano titolo, stato e giorno della prossima azione.</span><button className="btn" onClick={onNew}>Aggiungi contenuto</button></div>; }
function ContentCard({ item, onEdit }: { item: EditorialContent; onEdit: (item: EditorialContent) => void }) { return <button className="editorial-card" onClick={() => onEdit(item)}><div className="editorial-card-top"><em className={`status ${item.status}`}>{STATUS[item.status]}</em><span>{item.channel}</span></div><b>{item.title}</b>{item.format && <small>{item.format}</small>}<div className="editorial-card-foot">{item.owner || "Senza responsabile"}{item.cta && <span>CTA ✓</span>}</div></button>; }

function TodayView({ day, items, work, routine, routineChecks, overdue, hasFridayOffer, buffer, onToggleRoutine, onEdit, onNew }: { day: string; items: EditorialContent[]; work: Array<{ item: EditorialContent; action: string; tone: string }>; routine?: { title: string; steps: string[]; priority?: boolean }; routineChecks: Record<string, boolean>; overdue: EditorialContent[]; hasFridayOffer: boolean; buffer: number; onToggleRoutine: (key: string) => void; onEdit: (item: EditorialContent) => void; onNew: () => void }) {
  const groups = KANBAN.filter((status) => status !== "published").map((status) => ({ status, items: items.filter((x) => x.status === status) })).filter((x) => x.items.length);
  const keyBase = `editorial-routine-${day}`;
  return <div className="today-view"><div className="today-heading"><div><h2>{day === romeToday() ? "Cosa devo fare oggi" : `Piano del ${formatDate(day)}`}</h2><p>Le attività nascono dalla data di pubblicazione: scrivi 3 giorni prima, registra 2 giorni prima, controlla il giorno prima, pubblica il giorno stesso.</p></div><button className="btn small" onClick={onNew}>+ Aggiungi qui</button></div>{overdue.length > 0 && <div className="editorial-alert"><b>{overdue.length} contenuti in ritardo</b><span>Riprogrammali per tenere il piano pulito.</span></div>}{buffer < 3 && <div className="editorial-alert"><b>Buffer {buffer}/3 giorni</b><span>Prepara almeno tre contenuti pronti per non lavorare all’ultimo momento.</span></div>}{asDate(day).getDay() === 5 && !hasFridayOffer && <div className="editorial-alert"><b>Venerdì senza Video Offerta</b><span>Inserisci il reel con CTA: ha priorità sul ciclo normale.</span></div>}<div className="editorial-today-grid">{work.length > 0 && <section className="editorial-operation-list"><header><b>Attività sui contenuti</b><span>{work.length} da fare</span></header>{work.map(({ item, action, tone }) => <button key={`${item.id}-${action}`} className={`editorial-operation ${tone}`} onClick={() => onEdit(item)}><span>{action}</span><div><b>{item.title}</b><small>Pubblicazione: {item.scheduled_for ? formatDate(item.scheduled_for) : "da assegnare"} · {item.pillar || "Valore"}</small></div><i>›</i></button>)}</section>}{routine && <section className={`editorial-routine${routine.priority ? " priority" : ""}`}><header><b>{routine.title}</b><span>{routine.priority ? "Priorità alta" : "Routine"}</span></header>{routine.steps.map((step, index) => { const key = `${keyBase}-${index}`; return <label key={key}><input type="checkbox" checked={Boolean(routineChecks[key])} onChange={() => onToggleRoutine(key)} /><span>{step}</span></label>; })}</section>}<section className="editorial-routine daily"><header><b>Checklist giornaliera</b><span>Ogni giorno</span></header>{["Reel di oggi pronto", "Reel pubblicato", "Ripubblicato sulle piattaforme previste", "Commenti controllati", "DM controllati", "Contenuto successivo preparato", "Buffer contenuti verificato"].map((step, index) => { const key = `${keyBase}-daily-${index}`; return <label key={key}><input type="checkbox" checked={Boolean(routineChecks[key])} onChange={() => onToggleRoutine(key)} /><span>{step}</span></label>; })}</section></div>{groups.length > 0 && <div className="today-actions">{groups.map((group) => <section key={group.status} className={`today-action ${group.status}`}><header><span>{group.status === "in_production" ? "●" : group.status === "review" ? "✦" : "↗"}</span><div><h3>{STATUS[group.status]}</h3><small>{group.items.length} {group.items.length === 1 ? "contenuto" : "contenuti"}</small></div></header>{group.items.map((item) => <ContentCard key={item.id} item={item} onEdit={onEdit} />)}</section>)}</div>}{work.length === 0 && groups.length === 0 && <Empty onNew={onNew} />}</div>;
}

function CalendarView({ days, items, selectedDay, onSelectDay, onEdit }: { days: string[]; items: EditorialContent[]; selectedDay: string; onSelectDay: (day: string) => void; onEdit: (item: EditorialContent) => void }) { return <div className="editorial-calendar">{days.map((day) => { const current = items.filter((x) => x.scheduled_for === day && x.status !== "published"); return <section key={day} className={`calendar-day${day === selectedDay ? " selected" : ""}`}><button className="calendar-day-title" onClick={() => onSelectDay(day)}><b>{asDate(day).toLocaleDateString("it-IT", { weekday: "short" })}</b><span>{asDate(day).getDate()}</span></button><div className="calendar-items">{current.map((item) => <ContentCard key={item.id} item={item} onEdit={onEdit} />)}{current.length === 0 && <button className="calendar-empty" onClick={() => onSelectDay(day)}>Libero</button>}</div></section>; })}</div>; }
function KanbanCard({ item, onEdit }: { item: EditorialContent; onEdit: (item: EditorialContent) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.id });
  return <div ref={setNodeRef} className={`editorial-draggable${isDragging ? " dragging" : ""}`} {...attributes} {...listeners}><ContentCard item={item} onEdit={onEdit} /></div>;
}
function KanbanColumn({ status, items, onEdit }: { status: EditorialStatus; items: EditorialContent[]; onEdit: (item: EditorialContent) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `editorial-status-${status}` });
  return <section ref={setNodeRef} className={`kanban-column ${status}${isOver ? " drop-hint" : ""}`}><header><h3>{STATUS[status]}</h3><span>{items.length}</span></header>{items.map((item) => <KanbanCard key={item.id} item={item} onEdit={onEdit} />)}</section>;
}
function KanbanView({ items, onEdit, onStatusChange }: { items: EditorialContent[]; onEdit: (item: EditorialContent) => void; onStatusChange: (item: EditorialContent, status: EditorialStatus) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const target = String(over?.id || "");
    if (!target.startsWith("editorial-status-")) return;
    const item = items.find((content) => content.id === String(active.id));
    const status = target.replace("editorial-status-", "") as EditorialStatus;
    if (item && KANBAN.includes(status)) onStatusChange(item, status);
  };
  return <DndContext sensors={sensors} onDragStart={({ active }: DragStartEvent) => setActiveId(String(active.id))} onDragCancel={() => setActiveId(null)} onDragEnd={handleDragEnd}><div className="editorial-kanban">{KANBAN.map((status) => <KanbanColumn key={status} status={status} items={items.filter((item) => item.status === status)} onEdit={onEdit} />)}</div><DragOverlay>{activeItem ? <div className="editorial-drag-overlay"><ContentCard item={activeItem} onEdit={onEdit} /></div> : null}</DragOverlay></DndContext>;
}
function ListView({ items, onEdit }: { items: EditorialContent[]; onEdit: (item: EditorialContent) => void }) { return <div className="editorial-table"><div className="editorial-head"><span>Contenuto</span><span>Prossima azione</span><span>Canale</span><span>Giorno</span><span>Responsabile</span></div>{items.map((item) => <button className="editorial-row" key={item.id} onClick={() => onEdit(item)}><span><b>{item.title}</b><small>{item.format || item.pillar || "Contenuto"}</small></span><span>{STATUS[item.status]}</span><span><em className={`status ${item.status}`}>{item.channel}</em></span><span>{item.scheduled_for ? formatDate(item.scheduled_for) : "Da assegnare"}</span><span>{item.owner || "—"}</span></button>)}</div>; }

function ContentForm({ item, clientId, meName, initialDate, onClose, onSaved }: { item: EditorialContent | null; clientId: string; meName: string; initialDate: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item?.title ?? ""); const [channel, setChannel] = useState(item?.channel ?? "Instagram"); const [format, setFormat] = useState(item?.format ?? "Video / Reel"); const [status, setStatus] = useState<EditorialStatus>(item?.status ?? "in_production"); const [date, setDate] = useState(item?.scheduled_for ?? initialDate); const [owner, setOwner] = useState(item?.owner ?? meName); const [pillar, setPillar] = useState(item?.pillar ?? ""); const [cta, setCta] = useState(item?.cta ?? ""); const [notes, setNotes] = useState(item?.notes ?? ""); const [url, setUrl] = useState(item?.asset_url ?? ""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const save = async () => { if (!title.trim()) return setError("Inserisci almeno il titolo del contenuto."); setBusy(true); setError(null); const data = { title: title.trim(), channel, format: format.trim() || null, status, scheduled_for: date || null, owner: owner.trim() || null, pillar: pillar.trim() || null, cta: cta.trim() || null, notes: notes.trim() || null, asset_url: url.trim() || null }; const res = item ? await supabase.from("editorial_contents").update(data).eq("id", item.id) : await supabase.from("editorial_contents").insert({ ...data, client_id: clientId }); setBusy(false); if (res.error) setError(res.error.message); else onSaved(); };
  const remove = async () => { if (!item || !confirm("Eliminare questo contenuto dal piano editoriale?")) return; setBusy(true); const { error } = await supabase.from("editorial_contents").delete().eq("id", item.id); setBusy(false); if (error) setError(error.message); else onSaved(); };
  return <div className="overlay" onClick={onClose}><div className="modal editorial-modal" onClick={(e) => e.stopPropagation()}><header><div><h3>{item ? "Aggiorna contenuto" : "Aggiungi contenuto"}</h3><p>Compila solo il necessario per sapere cosa fare e quando.</p></div><button className="x" onClick={onClose}>×</button></header><div className="content">{error && <div className="notice err">{error}</div>}<div className="field"><label>Titolo / idea</label><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Es. Prima e dopo: trattamento viso" /></div><div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Prossimo passaggio</label><select value={status} onChange={(e) => setStatus(e.target.value as EditorialStatus)}>{Object.entries(STATUS).filter(([key]) => key !== "published").map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><div className="field" style={{ flex: 1 }}><label>Quando lo fai</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div></div><div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Canale</label><select value={channel} onChange={(e) => setChannel(e.target.value)}>{CHANNELS.map((x) => <option key={x}>{x}</option>)}</select></div><div className="field" style={{ flex: 1 }}><label>Formato</label><input value={format} onChange={(e) => setFormat(e.target.value)} placeholder="Video, reel, carosello…" /></div></div><div className="field"><label>Responsabile</label><input value={owner} onChange={(e) => setOwner(e.target.value)} /></div><details className="editorial-details"><summary>Aggiungi dettagli facoltativi: CTA, rubrica, briefing</summary><div className="field"><label>Call to action</label><input value={cta} onChange={(e) => setCta(e.target.value)} placeholder="Es. Scrivici “INFO” in DM" /></div><div className="field"><label>Rubrica / pillar</label><input value={pillar} onChange={(e) => setPillar(e.target.value)} placeholder="Educazione, prova sociale…" /></div><div className="field"><label>Link asset o bozza</label><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></div><div className="field"><label>Note</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Brief, angolo creativo, riferimenti…" /></div></details></div><footer>{item && <button className="btn danger" onClick={remove} disabled={busy} style={{ marginRight: "auto" }}>Elimina</button>}<button className="btn" onClick={onClose} disabled={busy}>Annulla</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? "Salvataggio…" : "Salva"}</button></footer></div></div>;
}
