import { useEffect, useId, useState, type FormEvent } from "react";
import { withTimeout } from "../async";
import { supabase } from "../supabaseClient";
import "./DatabaseLeads.css";

const pageSize = 20;
type Filter = "available" | "assigned" | "all";
type Contact = {
  id: string; name: string; phone: string; email: string | null; city: string | null; region: string | null;
  source_outcome: string | null; setter_id: string | null; handed_off_at: string | null; state: string;
};
type Staff = { id: string; full_name: string | null; email: string | null; role: string; client_id: string | null };

const labelFor = (person: Staff) => person.full_name || person.email || "Utente";
const available = (contact: Contact) => !contact.setter_id && !contact.handed_off_at && contact.state === "new";
const messageFor = (error: unknown) => typeof error === "object" && error && "message" in error
  ? String(error.message) : "Operazione non riuscita. Riprova.";

export default function DatabaseLeads({ clientId }: { clientId: string }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffError, setStaffError] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [matching, setMatching] = useState(0);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<Filter>("available");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [setter, setSetter] = useState("");
  const [seller, setSeller] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const searchId = useId();
  const setters = staff.filter(person => person.role === "setter");
  const sellers = staff.filter(person => person.role === "venditore");
  const sellerId = seller || (sellers.length === 1 ? sellers[0].id : "");
  const eligible = contacts.filter(available);
  const entirePageSelected = eligible.length > 0 && eligible.every(contact => selected.includes(contact.id));

  useEffect(() => {
    let active = true;
    withTimeout(supabase.rpc("list_users")).then(({ data, error }) => {
      if (error) throw error;
      if (active) setStaff(((data || []) as Staff[]).filter(person => person.client_id === clientId));
    }).catch(reason => { if (active) setStaffError(messageFor(reason)); });
    return () => { active = false; };
  }, [clientId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        let query = supabase.from("database_leads")
          .select("id,name,phone,email,city,region,source_outcome,setter_id,handed_off_at,state", { count: "exact" })
          .eq("client_id", clientId);
        if (filter === "available") query = query.is("setter_id", null).is("handed_off_at", null).eq("state", "new");
        if (filter === "assigned") query = query.not("setter_id", "is", null);
        const term = search.trim().replace(/[^\p{L}\p{N} @+.'-]/gu, "");
        if (term) {
          const phoneTerm = /^[+\d\s.-]+$/.test(term) ? term.replace(/\D/g, "") : term;
          query = query.or(`name.ilike.*${term}*,city.ilike.*${term}*,region.ilike.*${term}*,email.ilike.*${term}*,phone.ilike.*${phoneTerm}*`);
        }
        const [list, count] = await Promise.all([
          withTimeout(query.order("source_row").order("id").range(page * pageSize, (page + 1) * pageSize - 1)),
          withTimeout(supabase.from("database_leads").select("id", { count: "exact", head: true }).eq("client_id", clientId)),
        ]);
        if (list.error || count.error) throw list.error || count.error;
        if (!active) return;
        const matches = list.count ?? 0;
        setMatching(matches);
        setTotal(count.count ?? 0);
        if (page > 0 && page * pageSize >= matches) {
          setPage(Math.max(0, Math.ceil(matches / pageSize) - 1));
          return;
        }
        setContacts((list.data ?? []) as Contact[]);
      } catch (reason) {
        if (active) { setError(messageFor(reason)); setContacts([]); }
      } finally {
        if (active) setLoading(false);
      }
    }, search ? 220 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [clientId, filter, page, revision, search]);

  async function assign(event: FormEvent) {
    event.preventDefault();
    if (!selected.length || !setter || !sellerId || saving || loading) return;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const { data, error } = await withTimeout(supabase.rpc("assign_database_leads_to_setter", {
        p_client_id: clientId, p_contact_ids: selected, p_setter_id: setter, p_seller_id: sellerId,
      }));
      if (error) throw error;
      setSelected([]);
      setNotice(`${data} ${data === 1 ? "contatto assegnato" : "contatti assegnati"} a ${labelFor(setters.find(person => person.id === setter)!)}.`);
      setRevision(value => value + 1);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setSaving(false);
    }
  }

  function status(contact: Contact) {
    if (contact.handed_off_at) return "Discovery fissata";
    if (contact.state === "booked") return "Già prenotato nel foglio";
    if (contact.setter_id) return staff.find(person => person.id === contact.setter_id)?.full_name || "Assegnato";
    return "Da assegnare";
  }

  return <div className="page database-leads">
    <header className="database-leads-header">
      <div><h1>Database Leads</h1><p>{total.toLocaleString("it-IT")} contatti totali · Cold Call 1</p></div>
      <button type="button" className="btn" disabled={loading || saving} onClick={() => { setSelected([]); setRevision(value => value + 1); }}>Aggiorna</button>
    </header>
    <section className="panel database-leads-list" aria-label="Contatti da assegnare">
      <div className="database-leads-filters">
        <label htmlFor={searchId}>Cerca contatti<input id={searchId} type="search" placeholder="Nome, telefono o città" value={search} disabled={saving} onChange={e => { setSearch(e.target.value); setPage(0); setSelected([]); }} /></label>
        <label>Stato<select value={filter} disabled={saving} onChange={e => { setFilter(e.target.value as Filter); setPage(0); setSelected([]); }}>
          <option value="available">Da assegnare</option><option value="assigned">Assegnati</option><option value="all">Tutti i contatti</option>
        </select></label>
      </div>
      {notice && <p className="notice ok" role="status">{notice}</p>}
      {error && <p className="notice err" role="alert">{error}</p>}
      {staffError && <p className="notice err" role="alert">Elenco del team non disponibile. {staffError}</p>}
      {selected.length > 0 && <form className="database-leads-assign" onSubmit={event => void assign(event)}>
        <strong>{selected.length} {selected.length === 1 ? "contatto selezionato" : "contatti selezionati"}</strong>
        <div className="database-leads-assign-fields">
          <label>Setter<select required value={setter} disabled={saving} onChange={e => setSetter(e.target.value)}>
            <option value="">Scegli un setter</option>{setters.map(person => <option key={person.id} value={person.id}>{labelFor(person)}</option>)}
          </select></label>
          {sellers.length !== 1 && <label>Venditore per la discovery<select required value={sellerId} disabled={saving} onChange={e => setSeller(e.target.value)}>
            <option value="">Scegli un venditore</option>{sellers.map(person => <option key={person.id} value={person.id}>{labelFor(person)}</option>)}
          </select></label>}
        </div>
        <button className="btn primary" type="submit" disabled={saving || loading || !setter || !sellerId}>{saving ? "Assegnazione…" : "Assegna i contatti"}</button>
      </form>}
      <div className="database-leads-summary">
        <span>{loading ? "Caricamento…" : `${matching.toLocaleString("it-IT")} risultati`}</span>
        {eligible.length > 0 && <button className="btn" type="button" disabled={loading || saving} onClick={() => setSelected(entirePageSelected ? [] : eligible.map(contact => contact.id))}>
          {entirePageSelected ? "Deseleziona" : `Seleziona ${eligible.length} in questa pagina`}
        </button>}
      </div>
      {!loading && !contacts.length ? <p>Nessun contatto in questa vista.</p> : <ul className="database-lead-rows" aria-label="Elenco contatti" aria-busy={loading}>
        {contacts.map(contact => <li key={contact.id} className="database-lead-row" data-selected={selected.includes(contact.id)}>
          {available(contact) && <input type="checkbox" aria-label={`Seleziona ${contact.name}`} checked={selected.includes(contact.id)} disabled={loading || saving}
            onChange={e => { const checked = e.target.checked; setSelected(ids => checked ? [...ids, contact.id] : ids.filter(id => id !== contact.id)); }} />}
          <div className="database-lead-name"><strong>{contact.name}</strong><span>{[contact.city, contact.region].filter(Boolean).join(" · ")}</span></div>
          <div className="database-lead-contact"><a href={`tel:${contact.phone}`}>{contact.phone}</a>{contact.email && <span>{contact.email}</span>}</div>
          <div className="database-lead-status"><b>{status(contact)}</b>{contact.source_outcome && <small>{contact.source_outcome}</small>}</div>
        </li>)}
      </ul>}
      {matching > pageSize && <div className="database-leads-pagination" aria-label="Paginazione">
        <button className="btn" type="button" disabled={loading || saving || page === 0} onClick={() => { setSelected([]); setPage(value => value - 1); }}>Indietro</button>
        <span>{page + 1} di {Math.ceil(matching / pageSize)}</span>
        <button className="btn" type="button" disabled={loading || saving || (page + 1) * pageSize >= matching} onClick={() => { setSelected([]); setPage(value => value + 1); }}>Avanti</button>
      </div>}
    </section>
  </div>;
}
