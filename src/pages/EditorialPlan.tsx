import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";
import type { EditorialContent, EditorialStatus } from "../types";
import { romeToday } from "../dates";

const STATUS: Record<EditorialStatus, string> = { idea: "Idea", in_production: "In produzione", review: "In revisione", scheduled: "Programmato", published: "Pubblicato" };
const CHANNELS = ["Instagram", "TikTok", "LinkedIn", "YouTube", "Newsletter", "Blog", "Altro"];

export default function EditorialPlan({ clientId, meName }: { clientId: string; meName: string }) {
  const [items, setItems] = useState<EditorialContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<EditorialStatus | "all">("all");
  const [editing, setEditing] = useState<EditorialContent | null | "new">(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    supabase.from("editorial_contents").select("*").eq("client_id", clientId).order("scheduled_for", { ascending: true, nullsFirst: false }).then(({ data, error }) => {
      if (error) setLoadError(error.message);
      setItems((data as EditorialContent[]) ?? []); setLoading(false);
    });
  };
  useEffect(load, [clientId]);
  const visible = filter === "all" ? items : items.filter((x) => x.status === filter);
  const today = romeToday();
  const upcoming = items.filter((x) => x.scheduled_for && x.scheduled_for >= today && x.status !== "published");
  const published = items.filter((x) => x.status === "published");

  return <div className="page editorial-page">
    <div className="editorial-intro"><div><h1>Piano editoriale</h1><p>Organizza idee, produzione e pubblicazione dei contenuti dell’azienda.</p></div><button className="btn primary" onClick={() => setEditing("new")}>+ Nuovo contenuto</button></div>
    <div className="cards-grid editorial-kpis"><Kpi label="In programma" value={upcoming.length} /><Kpi label="In produzione" value={items.filter((x) => x.status === "in_production" || x.status === "review").length} /><Kpi label="Pubblicati" value={published.length} /><Kpi label="Prossima uscita" value={upcoming[0]?.scheduled_for ? new Date(upcoming[0].scheduled_for).toLocaleDateString("it-IT", { day: "2-digit", month: "short" }) : "—"} /></div>
    <section className="panel editorial-list"><div className="editorial-toolbar"><div className="status-filters">{(["all", "idea", "in_production", "review", "scheduled", "published"] as const).map((s) => <button key={s} className={filter === s ? "active" : ""} onClick={() => setFilter(s)}>{s === "all" ? "Tutti" : STATUS[s]}</button>)}</div></div>
      {loading ? <p className="muted">Caricamento piano editoriale…</p> : loadError ? <div className="empty-editorial"><b>Il piano editoriale non è ancora attivo.</b><span>Nel database manca la relativa migrazione: {loadError}</span></div> : visible.length === 0 ? <div className="empty-editorial"><b>Nessun contenuto qui.</b><span>Inizia aggiungendo un’idea o una pubblicazione già pianificata.</span><button className="btn" onClick={() => setEditing("new")}>Aggiungi contenuto</button></div> : <div className="editorial-table"><div className="editorial-head"><span>Contenuto</span><span>Canale</span><span>Stato</span><span>Pubblicazione</span><span>Responsabile</span></div>{visible.map((item) => <button className="editorial-row" key={item.id} onClick={() => setEditing(item)}><span><b>{item.title}</b><small>{item.format || item.pillar || "Contenuto"}</small></span><span>{item.channel}</span><span><em className={`status ${item.status}`}>{STATUS[item.status]}</em></span><span>{item.scheduled_for ? new Date(item.scheduled_for).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</span><span>{item.owner || "—"}</span></button>)}</div>}
    </section>
    {editing && <ContentForm item={editing === "new" ? null : editing} clientId={clientId} meName={meName} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
  </div>;
}

function Kpi({ label, value }: { label: string; value: string | number }) { return <div className="stat"><div className="k">{label}</div><div className="v">{value}</div></div>; }

function ContentForm({ item, clientId, meName, onClose, onSaved }: { item: EditorialContent | null; clientId: string; meName: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item?.title ?? ""); const [channel, setChannel] = useState(item?.channel ?? "Instagram"); const [format, setFormat] = useState(item?.format ?? ""); const [status, setStatus] = useState<EditorialStatus>(item?.status ?? "idea"); const [date, setDate] = useState(item?.scheduled_for ?? ""); const [owner, setOwner] = useState(item?.owner ?? meName); const [pillar, setPillar] = useState(item?.pillar ?? ""); const [cta, setCta] = useState(item?.cta ?? ""); const [notes, setNotes] = useState(item?.notes ?? ""); const [url, setUrl] = useState(item?.asset_url ?? ""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const save = async () => { if (!title.trim()) return setError("Inserisci il titolo del contenuto."); setBusy(true); setError(null); const data = { title: title.trim(), channel, format: format.trim() || null, status, scheduled_for: date || null, owner: owner.trim() || null, pillar: pillar.trim() || null, cta: cta.trim() || null, notes: notes.trim() || null, asset_url: url.trim() || null }; const res = item ? await supabase.from("editorial_contents").update(data).eq("id", item.id) : await supabase.from("editorial_contents").insert({ ...data, client_id: clientId }); setBusy(false); if (res.error) setError(res.error.message); else onSaved(); };
  const remove = async () => { if (!item || !confirm("Eliminare questo contenuto dal piano editoriale?")) return; setBusy(true); const { error } = await supabase.from("editorial_contents").delete().eq("id", item.id); setBusy(false); if (error) setError(error.message); else onSaved(); };
  return <div className="overlay" onClick={onClose}><div className="modal editorial-modal" onClick={(e) => e.stopPropagation()}><header><h3>{item ? "Modifica contenuto" : "Nuovo contenuto"}</h3><button className="x" onClick={onClose}>×</button></header><div className="content">{error && <div className="notice err">{error}</div>}<div className="field"><label>Titolo</label><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Es. 5 errori che bloccano le vendite" /></div><div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Canale</label><select value={channel} onChange={(e) => setChannel(e.target.value)}>{CHANNELS.map((x) => <option key={x}>{x}</option>)}</select></div><div className="field" style={{ flex: 1 }}><label>Formato</label><input value={format} onChange={(e) => setFormat(e.target.value)} placeholder="Reel, carosello…" /></div></div><div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Stato</label><select value={status} onChange={(e) => setStatus(e.target.value as EditorialStatus)}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><div className="field" style={{ flex: 1 }}><label>Data pubblicazione</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div></div><div className="modal-row"><div className="field" style={{ flex: 1 }}><label>Responsabile</label><input value={owner} onChange={(e) => setOwner(e.target.value)} /></div><div className="field" style={{ flex: 1 }}><label>Rubrica / pillar</label><input value={pillar} onChange={(e) => setPillar(e.target.value)} placeholder="Educazione, prova sociale…" /></div></div><div className="field"><label>Call to action</label><input value={cta} onChange={(e) => setCta(e.target.value)} placeholder="Es. Scrivici “INFO” in DM" /></div><div className="field"><label>Link asset o bozza</label><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></div><div className="field"><label>Note</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Brief, angolo creativo, riferimenti…" /></div></div><footer>{item && <button className="btn danger" onClick={remove} disabled={busy} style={{ marginRight: "auto" }}>Elimina</button>}<button className="btn" onClick={onClose} disabled={busy}>Annulla</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? "Salvataggio…" : "Salva contenuto"}</button></footer></div></div>;
}
