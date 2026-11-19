import { useEffect, useId, useRef, useState } from "react";
import { withTimeout } from "../async";
import { romeStamp } from "../dates";
import { supabase } from "../supabaseClient";

type LeadNote = { id: string; author_name: string; body: string; created_at: string };
type NotesProps = {
  clientId: string;
  contactId: string;
  databaseContact: boolean;
  editable: boolean;
  disabled: boolean;
  onSavingChange: (saving: boolean) => void;
};

const messageFor = (error: unknown, fallback: string) =>
  typeof error === "object" && error && "message" in error ? String(error.message) : fallback;

export default function SetterLeadNotes({ clientId, contactId, databaseContact, editable, disabled, onSavingChange }: NotesProps) {
  const [notes, setNotes] = useState<LeadNote[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef<{ id: string; body: string }>();
  const pending = useRef(false);
  const history = useRef<HTMLDetailsElement>(null);
  const labelId = useId();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setReadError("");
    withTimeout(supabase.rpc("get_setter_lead_notes", {
      p_client_id: clientId, p_contact_id: contactId, p_database_contact: databaseContact,
    })).then(({ data, error }) => {
      if (error) throw error;
      if (active) setNotes((data ?? []) as LeadNote[]);
    }).catch(error => { if (active) setReadError(messageFor(error, "Storico note non disponibile.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [clientId, contactId, databaseContact, revision]);

  async function save() {
    const body = draft.trim();
    if (!editable || !body || disabled || loading || pending.current) return;
    pending.current = true;
    setSaving(true);
    onSavingChange(true);
    setSaveError("");
    setSaved(false);
    try {
      if (request.current?.body !== body) request.current = { id: crypto.randomUUID(), body };
      const { data, error } = await withTimeout(supabase.rpc("add_setter_lead_note", {
        p_client_id: clientId, p_contact_id: contactId, p_database_contact: databaseContact,
        p_request_id: request.current.id, p_body: body,
      }));
      if (error) throw error;
      const note = data as LeadNote | null;
      if (!note?.id) throw new Error("Salvataggio da verificare. La nota è ancora qui.");
      setNotes(previous => previous.some(item => item.id === note.id) ? previous : [note, ...previous]);
      setDraft("");
      request.current = undefined;
      setSaved(true);
    } catch (error) {
      setSaveError(messageFor(error, "Salvataggio non riuscito. La nota è ancora qui, riprova."));
    } finally {
      pending.current = false;
      onSavingChange(false);
      setSaving(false);
    }
  }

  useEffect(() => {
    if (saved && history.current) history.current.open = true;
  }, [saved]);

  return <section className="setter-notes" aria-labelledby={labelId}>
    <h3 id={labelId}>Note del lead</h3>
    {editable && <>
      <label className="setter-note-input">Scrivi una nota
        <textarea rows={2} maxLength={3000} value={draft} disabled={disabled || saving} placeholder="Dettagli da ricordare o prossimi passi…"
          onChange={event => { setDraft(event.target.value); setSaved(false); }} />
      </label>
      <button type="button" className="btn" onClick={() => void save()} disabled={disabled || loading || saving || !draft.trim()}>
        {saving ? "Salvataggio…" : "Salva nota"}
      </button>
    </>}
    {saved && <p className="setter-note-status" role="status">Nota salvata.</p>}
    {saveError && <p className="notice err" role="alert">{saveError}</p>}
    {readError && <div className="setter-note-retry" role="status">
      <span>{readError}</span><button className="btn small" type="button" disabled={saving || disabled} onClick={() => setRevision(value => value + 1)}>Ricarica storico</button>
    </div>}
    {!loading && !readError && !notes.length && !editable && <p className="muted">Ancora nessuna nota.</p>}
    {notes.length > 0 && <details ref={history} className="setter-note-history">
      <summary>Storico note ({notes.length})</summary>
      <ol>
        {notes.map(note => <li key={note.id}>
          <div><strong>{note.author_name}</strong> <time dateTime={note.created_at}>{romeStamp(note.created_at)}</time></div>
          <p>{note.body}</p>
        </li>)}
      </ol>
    </details>}
  </section>;
}
