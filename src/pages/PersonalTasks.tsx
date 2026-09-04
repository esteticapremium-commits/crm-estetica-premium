import { useEffect, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { supabase } from "../supabaseClient";
import type { PersonalTask, PersonalTaskStatus } from "../types";

const COLUMNS: Array<{ id: PersonalTaskStatus; label: string; hint: string }> = [
  { id: "backlog", label: "Da decidere", hint: "Idee e cose da pianificare" },
  { id: "next", label: "Prossime", hint: "Le priorità su cui partire" },
  { id: "doing", label: "In corso", hint: "Massimo poche alla volta" },
  { id: "waiting", label: "In attesa", hint: "Deleghe e risposte esterne" },
  { id: "done", label: "Fatte", hint: "Chiuse" },
];

export default function PersonalTasks() {
  const [items, setItems] = useState<PersonalTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonalTask | "new" | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    const { data, error: loadError } = await supabase.from("personal_tasks").select("*").order("position").order("created_at");
    setItems((data as PersonalTask[]) ?? []); setError(loadError?.message ?? null); setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const move = async (item: PersonalTask, status: PersonalTaskStatus) => {
    if (item.status === status) return;
    const previous = items;
    const position = items.filter((task) => task.status === status).length;
    setItems((current) => current.map((task) => task.id === item.id ? { ...task, status, position } : task));
    const { error: updateError } = await supabase.from("personal_tasks").update({ status, position }).eq("id", item.id);
    if (updateError) { setItems(previous); setError(`Non sono riuscito a spostare la task: ${updateError.message}`); }
  };

  return <div className="page personal-tasks-page">
    <div className="personal-tasks-intro"><div><span className="eyebrow">SPAZIO PERSONALE</span><h1>Task Aziendali</h1><p>Le attività aziendali che vuoi tenere sotto controllo, senza mescolarle ai lead e alle attività di vendita.</p></div><button className="btn primary" onClick={() => setEditing("new")}>+ Nuova task</button></div>
    <div className="personal-task-summary"><b>{items.filter((task) => task.status === "next").length} priorità prossime</b><span>Trascina le card per aggiornare lo stato.</span></div>
    {loading ? <p className="muted editorial-loading">Caricamento delle tue task…</p> : error && items.length === 0 ? <div className="empty-editorial"><b>La sezione personale non è ancora attiva.</b><span>Serve l’aggiornamento del database: {error}</span></div> : <>{error && <div className="notice err">{error}</div>}<TaskKanban items={items} onEdit={setEditing} onMove={move} /></>}
    {editing && <TaskForm item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
  </div>;
}

function TaskCard({ item, onEdit }: { item: PersonalTask; onEdit: (item: PersonalTask) => void }) {
  return <button className="personal-task-card" onClick={() => onEdit(item)}><b>{item.title}</b>{item.notes && <small>{item.notes}</small>}<span>Apri per modificare</span></button>;
}
function DraggableTask({ item, onEdit }: { item: PersonalTask; onEdit: (item: PersonalTask) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.id });
  return <div ref={setNodeRef} className={`personal-task-draggable${isDragging ? " dragging" : ""}`} {...attributes} {...listeners}><TaskCard item={item} onEdit={onEdit} /></div>;
}
function TaskColumn({ column, items, onEdit }: { column: typeof COLUMNS[number]; items: PersonalTask[]; onEdit: (item: PersonalTask) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `personal-status-${column.id}` });
  return <section ref={setNodeRef} className={`personal-task-column ${column.id}${isOver ? " drop-hint" : ""}`}><header><div><h2>{column.label}</h2><small>{column.hint}</small></div><span>{items.length}</span></header>{items.map((item) => <DraggableTask key={item.id} item={item} onEdit={onEdit} />)}{items.length === 0 && <p className="personal-task-empty">Trascina qui una task</p>}</section>;
}
function TaskKanban({ items, onEdit, onMove }: { items: PersonalTask[]; onEdit: (item: PersonalTask) => void; onMove: (item: PersonalTask, status: PersonalTaskStatus) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = activeId ? items.find((item) => item.id === activeId) : null;
  const end = ({ active: dragged, over }: DragEndEvent) => { setActiveId(null); const target = String(over?.id || ""); if (!target.startsWith("personal-status-")) return; const item = items.find((task) => task.id === String(dragged.id)); const status = target.replace("personal-status-", "") as PersonalTaskStatus; if (item && COLUMNS.some((column) => column.id === status)) onMove(item, status); };
  return <DndContext sensors={sensors} onDragStart={({ active: dragged }: DragStartEvent) => setActiveId(String(dragged.id))} onDragCancel={() => setActiveId(null)} onDragEnd={end}><div className="personal-task-kanban">{COLUMNS.map((column) => <TaskColumn key={column.id} column={column} items={items.filter((item) => item.status === column.id)} onEdit={onEdit} />)}</div><DragOverlay>{active && <div className="personal-task-overlay"><TaskCard item={active} onEdit={onEdit} /></div>}</DragOverlay></DndContext>;
}
function TaskForm({ item, onClose, onSaved }: { item: PersonalTask | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item?.title ?? ""); const [notes, setNotes] = useState(item?.notes ?? ""); const [status, setStatus] = useState<PersonalTaskStatus>(item?.status ?? "backlog"); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const save = async () => { if (!title.trim()) return setError("Scrivi il titolo della task."); setBusy(true); setError(null); const data = { title: title.trim(), notes: notes.trim() || null, status }; const result = item ? await supabase.from("personal_tasks").update(data).eq("id", item.id) : await supabase.from("personal_tasks").insert({ ...data, position: 0 }); setBusy(false); if (result.error) setError(result.error.message); else onSaved(); };
  const remove = async () => { if (!item || !confirm("Eliminare questa task personale?")) return; setBusy(true); const { error: deleteError } = await supabase.from("personal_tasks").delete().eq("id", item.id); setBusy(false); if (deleteError) setError(deleteError.message); else onSaved(); };
  return <div className="overlay" onClick={onClose}><div className="modal personal-task-modal" onClick={(event) => event.stopPropagation()}><header><div><h3>{item ? "Modifica task" : "Nuova task personale"}</h3><p>Solo quello che serve per non perdere il filo.</p></div><button className="x" onClick={onClose}>×</button></header><div className="content">{error && <div className="notice err">{error}</div>}<div className="field"><label>Task</label><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Es. Preparare il piano commerciale di ottobre" /></div><div className="field"><label>Stato</label><select value={status} onChange={(event) => setStatus(event.target.value as PersonalTaskStatus)}>{COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}</select></div><div className="field"><label>Nota facoltativa</label><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Dettagli, prossimi passi o promemoria…" /></div></div><footer>{item && <button className="btn danger" onClick={() => void remove()} disabled={busy} style={{ marginRight: "auto" }}>Elimina</button>}<button className="btn" onClick={onClose} disabled={busy}>Annulla</button><button className="btn primary" onClick={() => void save()} disabled={busy}>{busy ? "Salvataggio…" : "Salva"}</button></footer></div></div>;
}
