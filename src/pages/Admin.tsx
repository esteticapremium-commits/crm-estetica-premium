import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import type { Client, Pipeline, Stage } from "../types";

/* Chiamata alla funzione protetta che gestisce gli utenti */
async function callAdmin(action: string, payload: Record<string, unknown> = {}) {
  const { data, error } = await supabase.functions.invoke("admin-user", {
    body: { action, ...payload },
  });
  if (error) {
    // prova a leggere il messaggio dettagliato dalla risposta
    let msg = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === "function") {
        const j = await ctx.json();
        if (j?.error) msg = j.error;
      }
    } catch {
      /* ignora */
    }
    return { error: msg };
  }
  return data as any;
}

interface SecretaryRow {
  id: string;
  role: string;
  client_id: string | null;
  full_name: string | null;
  email: string;
}

export default function Admin({
  clients,
  onClientsChanged,
}: {
  clients: Client[];
  onClientsChanged: () => void;
}) {
  const [selClient, setSelClient] = useState<string | null>(
    clients[0]?.id ?? null
  );
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selPipeline, setSelPipeline] = useState<string | null>(null);
  const [sub, setSub] = useState<"stato" | "attivita" | "clienti" | "accessi" | "fasi">("stato");

  useEffect(() => {
    if (!selClient && clients[0]) setSelClient(clients[0].id);
  }, [clients, selClient]);

  const loadPipelines = useCallback(() => {
    if (!selClient) {
      setPipelines([]);
      setSelPipeline(null);
      return;
    }
    supabase
      .from("pipelines")
      .select("id, client_id, name, position, meta_form_id, meta_ad_account_id, created_at")
      .eq("client_id", selClient)
      .order("position")
      .then(({ data }) => {
        const list = (data as Pipeline[]) ?? [];
        setPipelines(list);
        setSelPipeline((prev) =>
          list.find((p) => p.id === prev) ? prev : list[0]?.id ?? null
        );
      });
  }, [selClient]);

  useEffect(() => {
    loadPipelines();
  }, [loadPipelines]);

  const current = clients.find((c) => c.id === selClient) ?? null;
  const currentPipeline = pipelines.find((p) => p.id === selPipeline) ?? null;

  return (
    <div className="page">
      <h1>Amministrazione</h1>
      <p className="sub">
        Gestisci clienti, pipeline, fasi e accessi — una cosa alla volta.
      </p>

      <div className="subnav">
        <button className={sub === "attivita" ? "active" : ""} onClick={() => setSub("attivita")}>
          Attività (log)
        </button>
        <button className={sub === "clienti" ? "active" : ""} onClick={() => setSub("clienti")}>
          Clienti
        </button>
        <button className={sub === "accessi" ? "active" : ""} onClick={() => setSub("accessi")}>
          Accessi
        </button>
        <button className={sub === "fasi" ? "active" : ""} onClick={() => setSub("fasi")}>
          Fasi e pipeline
        </button>
      </div>

      {sub === "attivita" && <ActivityPanel clients={clients} />}
      {sub === "clienti" && (
        <ClientsPanel
          clients={clients}
          onChanged={onClientsChanged}
          selClient={selClient}
          setSelClient={setSelClient}
        />
      )}
      {sub === "accessi" && <UsersPanel clients={clients} />}
      {sub === "fasi" &&
        (current ? (
          <>
            <PipelinesPanel
              client={current}
              pipelines={pipelines}
              selPipeline={selPipeline}
              setSelPipeline={setSelPipeline}
              onChanged={loadPipelines}
            />
            {currentPipeline && (
              <StagesPanel client={current} pipeline={currentPipeline} />
            )}
          </>
        ) : (
          <div className="center-msg" style={{ padding: 30 }}>
            Aggiungi prima un cliente nella sezione "Clienti".
          </div>
        ))}
    </div>
  );
}

/* ---------------- Clienti ---------------- */
function ClientsPanel({
  clients,
  onChanged,
  selClient,
  setSelClient,
}: {
  clients: Client[];
  onChanged: () => void;
  selClient: string | null;
  setSelClient: (id: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function addClient() {
    if (!newName.trim()) return;
    setBusy(true);
    const { error } = await supabase
      .from("clients")
      .insert({ name: newName.trim() });
    setBusy(false);
    if (error) return alert(error.message);
    setNewName("");
    onChanged();
  }

  async function rename(c: Client) {
    const n = prompt("Nuovo nome cliente:", c.name);
    if (!n || !n.trim()) return;
    const { error } = await supabase
      .from("clients")
      .update({ name: n.trim() })
      .eq("id", c.id);
    if (error) return alert(error.message);
    onChanged();
  }

  async function del(c: Client) {
    if (
      !confirm(
        `Eliminare il cliente "${c.name}"? Verranno cancellati anche le sue fasi e TUTTI i suoi lead. Operazione non annullabile.`
      )
    )
      return;
    const { error } = await supabase.from("clients").delete().eq("id", c.id);
    if (error) return alert(error.message);
    onChanged();
  }

  return (
    <div className="panel">
      <h2>Clienti</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Nome</th>
            <th style={{ width: 260 }}></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              <td>
                <b>{c.name}</b>
              </td>
              <td style={{ textAlign: "right" }}>
                <button
                  className="btn small"
                  onClick={() => setSelClient(c.id)}
                  style={{
                    marginRight: 6,
                    ...(selClient === c.id
                      ? { borderColor: "var(--brand)", color: "var(--brand)" }
                      : {}),
                  }}
                >
                  {selClient === c.id ? "● Selezionato" : "Gestisci"}
                </button>
                <button
                  className="btn small"
                  onClick={() => rename(c)}
                  style={{ marginRight: 6 }}
                >
                  Rinomina
                </button>
                <button className="btn small danger" onClick={() => del(c)}>
                  Elimina
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          className="field"
          style={{ flex: 1, padding: 9 }}
          placeholder="Nome nuovo cliente"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="btn primary" onClick={addClient} disabled={busy}>
          + Aggiungi cliente
        </button>
      </div>
    </div>
  );
}

/* ---------------- Pipeline ---------------- */
function PipelinesPanel({
  client,
  pipelines,
  selPipeline,
  setSelPipeline,
  onChanged,
}: {
  client: Client;
  pipelines: Pipeline[];
  selPipeline: string | null;
  setSelPipeline: (id: string) => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!newName.trim()) return;
    setBusy(true);
    const pos = pipelines.length
      ? Math.max(...pipelines.map((p) => p.position)) + 1
      : 1;
    const { error } = await supabase
      .from("pipelines")
      .insert({ client_id: client.id, name: newName.trim(), position: pos });
    setBusy(false);
    if (error) return alert(error.message);
    setNewName("");
    onChanged();
  }

  async function rename(p: Pipeline) {
    const n = prompt("Nuovo nome pipeline:", p.name);
    if (!n || !n.trim()) return;
    const { error } = await supabase
      .from("pipelines")
      .update({ name: n.trim() })
      .eq("id", p.id);
    if (error) return alert(error.message);
    onChanged();
  }

  async function del(p: Pipeline) {
    if (
      !confirm(
        `Eliminare la pipeline "${p.name}"? Verranno cancellate le sue fasi e TUTTI i suoi lead. Operazione non annullabile.`
      )
    )
      return;
    const { error } = await supabase.from("pipelines").delete().eq("id", p.id);
    if (error) return alert(error.message);
    onChanged();
  }

  return (
    <div className="panel">
      <h2>Pipeline di {client.name}</h2>
      <p style={{ color: "var(--muted)", marginTop: -6 }}>
        Ogni pipeline ha le sue fasi e la sua bacheca.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Pipeline</th>
            <th style={{ width: 260 }}></th>
          </tr>
        </thead>
        <tbody>
          {pipelines.map((p) => (
            <PipelineRow
              key={p.id}
              p={p}
              selected={selPipeline === p.id}
              onSelect={() => setSelPipeline(p.id)}
              onRename={() => rename(p)}
              onDelete={() => del(p)}
            />
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          className="field"
          style={{ flex: 1, padding: 9 }}
          placeholder="Nome nuova pipeline (es. Orto-K)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="btn primary" onClick={add} disabled={busy}>
          + Aggiungi pipeline
        </button>
      </div>
    </div>
  );
}

function PipelineRow({
  p,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  p: Pipeline;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td>
        <b>{p.name}</b>
      </td>
      <td style={{ textAlign: "right" }}>
        <button
          className="btn small"
          onClick={onSelect}
          style={{
            marginRight: 6,
            ...(selected
              ? { borderColor: "var(--brand)", color: "var(--brand)" }
              : {}),
          }}
        >
          {selected ? "● Fasi" : "Fasi"}
        </button>
        <button
          className="btn small"
          onClick={onRename}
          style={{ marginRight: 6 }}
        >
          Rinomina
        </button>
        <button className="btn small danger" onClick={onDelete}>
          Elimina
        </button>
      </td>
    </tr>
  );
}


/* ---------------- Fasi ---------------- */
function StagesPanel({ client, pipeline }: { client: Client; pipeline: Pipeline }) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#2563eb");

  async function load() {
    const { data } = await supabase
      .from("stages")
      .select("*")
      .eq("pipeline_id", pipeline.id)
      .order("position");
    setStages((data as Stage[]) ?? []);
  }
  useEffect(() => {
    load();
  }, [pipeline.id]);

  async function add() {
    if (!newName.trim()) return;
    const pos = stages.length
      ? Math.max(...stages.map((s) => s.position)) + 1
      : 1;
    const { error } = await supabase.from("stages").insert({
      client_id: client.id,
      pipeline_id: pipeline.id,
      name: newName.trim(),
      color: newColor,
      position: pos,
      is_entry: stages.length === 0,
    });
    if (error) return alert(error.message);
    setNewName("");
    load();
  }

  async function rename(s: Stage) {
    const n = prompt("Nuovo nome fase:", s.name);
    if (!n || !n.trim()) return;
    await supabase.from("stages").update({ name: n.trim() }).eq("id", s.id);
    load();
  }

  async function setColor(s: Stage, color: string) {
    await supabase.from("stages").update({ color }).eq("id", s.id);
    load();
  }

  async function move(s: Stage, dir: -1 | 1) {
    const idx = stages.findIndex((x) => x.id === s.id);
    const other = stages[idx + dir];
    if (!other) return;
    await Promise.all([
      supabase
        .from("stages")
        .update({ position: other.position })
        .eq("id", s.id),
      supabase
        .from("stages")
        .update({ position: s.position })
        .eq("id", other.id),
    ]);
    load();
  }

  async function setEntry(s: Stage) {
    await supabase
      .from("stages")
      .update({ is_entry: false })
      .eq("pipeline_id", pipeline.id);
    await supabase.from("stages").update({ is_entry: true }).eq("id", s.id);
    load();
  }

  async function del(s: Stage) {
    if (
      !confirm(
        `Eliminare la fase "${s.name}"? Puoi farlo solo se non contiene lead.`
      )
    )
      return;
    const { error } = await supabase.from("stages").delete().eq("id", s.id);
    if (error)
      return alert(
        "Impossibile eliminare: probabilmente la fase contiene ancora dei lead. Spostali prima altrove."
      );
    load();
  }

  return (
    <div className="panel">
      <h2>Fasi (colonne) · {client.name} → {pipeline.name}</h2>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>Fase</th>
            <th style={{ width: 70 }}>Colore</th>
            <th style={{ width: 110 }}>Ingresso</th>
            <th style={{ width: 220 }}></th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s, i) => (
            <tr key={s.id}>
              <td>{i + 1}</td>
              <td>
                <span
                  className="col-dot"
                  style={{
                    background: s.color || "#94a3b8",
                    display: "inline-block",
                    marginRight: 8,
                  }}
                />
                {s.name}
              </td>
              <td>
                <input
                  type="color"
                  value={s.color || "#94a3b8"}
                  onChange={(e) => setColor(s, e.target.value)}
                  style={{ width: 36, height: 26, border: "none" }}
                />
              </td>
              <td>
                {s.is_entry ? (
                  <span className="tag src">● ingresso</span>
                ) : (
                  <button
                    className="btn small"
                    onClick={() => setEntry(s)}
                    title="I nuovi lead da n8n entrano qui"
                  >
                    imposta
                  </button>
                )}
              </td>
              <td style={{ textAlign: "right" }}>
                <button
                  className="btn small"
                  onClick={() => move(s, -1)}
                  disabled={i === 0}
                >
                  ↑
                </button>{" "}
                <button
                  className="btn small"
                  onClick={() => move(s, 1)}
                  disabled={i === stages.length - 1}
                >
                  ↓
                </button>{" "}
                <button className="btn small" onClick={() => rename(s)}>
                  Rinomina
                </button>{" "}
                <button className="btn small danger" onClick={() => del(s)}>
                  Elimina
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          style={{ width: 40, height: 38, border: "none" }}
        />
        <input
          className="field"
          style={{ flex: 1, padding: 9 }}
          placeholder="Nome nuova fase"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="btn primary" onClick={add}>
          + Aggiungi fase
        </button>
      </div>
    </div>
  );
}

/* ---------------- Stato integrazione ---------------- */
function IntegrationPanel({ clients }: { clients: Client[] }) {
  const [stats, setStats] = useState<Record<string, IntStat>>({});
  const [tokens, setTokens] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const out: Record<string, IntStat> = {};
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const [tok] = await Promise.all([
        supabase.from("clients").select("id, meta_page_token"),
      ]);
      const tk: Record<string, boolean> = {};
      for (const t of (tok.data as { id: string; meta_page_token: string | null }[]) ?? []) {
        tk[t.id] = Boolean(t.meta_page_token);
      }
      setTokens(tk);
      for (const c of clients) {
        const [cnt, last] = await Promise.all([
          supabase
            .from("leads")
            .select("id", { count: "exact", head: true })
            .eq("client_id", c.id)
            .gte("created_at", weekAgo),
          supabase
            .from("leads")
            .select("created_at")
            .eq("client_id", c.id)
            .order("created_at", { ascending: false })
            .limit(1),
        ]);
        out[c.id] = {
          lead7: cnt.count ?? 0,
          last: (last.data?.[0]?.created_at as string) ?? null,
        };
      }
      setStats(out);
      setLoading(false);
    }
    load();
  }, [clients]);

  function giorniFa(iso: string | null): string {
    if (!iso) return "mai";
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (d <= 0) return "oggi";
    if (d === 1) return "ieri";
    return d + " gg fa";
  }

  const St = ({ ok, yes, no }: { ok: boolean; yes: string; no: string }) => (
    <span className={"st " + (ok ? "ok" : "warn")}>
      <span className="ic">{ok ? "✓" : "⚠"}</span>
      {ok ? yes : no}
    </span>
  );

  return (
    <div className="panel">
      <h2>Stato integrazione</h2>
      <p style={{ color: "var(--muted)", marginTop: -6 }}>
        A colpo d'occhio: cosa è collegato e quando è arrivato l'ultimo lead per
        ogni cliente. Lo stato delle campagne Meta (accese/spente) te lo
        controllo io da qui in chat.
      </p>
      {loading ? (
        <div style={{ color: "var(--muted)" }}>Caricamento…</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Pagina FB</th>
              <th>Token Meta</th>
              <th>Ad account</th>
              <th>Lead ultimi 7 gg</th>
              <th>Ultimo lead</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b></td>
                <td><St ok={Boolean(c.meta_page_id)} yes="collegata" no="mancante" /></td>
                <td><St ok={tokens[c.id] ?? false} yes="valido" no="mancante" /></td>
                <td><St ok={Boolean(c.meta_ad_account_id)} yes="attivo" no="non collegato" /></td>
                <td>{stats[c.id]?.lead7 ?? 0}</td>
                <td>{giorniFa(stats[c.id]?.last ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface IntStat {
  lead7: number;
  last: string | null;
}

/* ---------------- Attività recenti ---------------- */
interface ActEv {
  lead_id: string;
  client_id: string;
  changed_by: string | null;
  changed_at: string;
  from_stage_id: string | null;
  to_stage_id: string;
}

function ActivityPanel({ clients }: { clients: Client[] }) {
  const [rows, setRows] = useState<ActRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data: ev } = await supabase
        .from("lead_stage_events")
        .select(
          "lead_id, client_id, changed_by, changed_at, from_stage_id, to_stage_id"
        )
        .order("changed_at", { ascending: false })
        .limit(200);
      const events = (ev as ActEv[]) ?? [];
      const leadIds = [...new Set(events.map((e) => e.lead_id))];
      const stageIds = [
        ...new Set(
          events
            .flatMap((e) => [e.from_stage_id, e.to_stage_id])
            .filter((x): x is string => Boolean(x))
        ),
      ];
      const [ld, st] = await Promise.all([
        leadIds.length
          ? supabase.from("leads").select("id, name").in("id", leadIds)
          : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
        stageIds.length
          ? supabase.from("stages").select("id, name").in("id", stageIds)
          : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
      ]);
      const leadName = new Map((ld.data ?? []).map((l) => [l.id, l.name]));
      const stageName = new Map((st.data ?? []).map((s) => [s.id, s.name]));
      const clientName = new Map(clients.map((c) => [c.id, c.name]));
      setRows(
        events.map((e) => ({
          at: e.changed_at,
          client: clientName.get(e.client_id) ?? "—",
          lead: leadName.get(e.lead_id) ?? "(eliminato)",
          move:
            (e.from_stage_id
              ? (stageName.get(e.from_stage_id) ?? "—") + " → "
              : "✨ ingresso → ") + (stageName.get(e.to_stage_id) ?? "—"),
          by: e.changed_by ?? "—",
        }))
      );
      setLoading(false);
    }
    load();
  }, [clients]);

  return (
    <div className="panel">
      <h2>Attività recenti</h2>
      <p style={{ color: "var(--muted)", marginTop: -6 }}>
        Chi ha spostato cosa e quando (ultimi 200 movimenti). Il nome di chi
        agisce viene registrato da oggi in poi.
      </p>
      {loading ? (
        <div style={{ color: "var(--muted)" }}>Caricamento…</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Cliente</th>
              <th>Lead</th>
              <th>Movimento</th>
              <th>Chi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ whiteSpace: "nowrap" }}>
                  {new Date(r.at).toLocaleString("it-IT", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td>{r.client}</td>
                <td>{r.lead}</td>
                <td>{r.move}</td>
                <td>{r.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ActRow {
  at: string;
  client: string;
  lead: string;
  move: string;
  by: string;
}

/* ---------------- Utenti / Segretarie ---------------- */
function UsersPanel({ clients }: { clients: Client[] }) {
  const [users, setUsers] = useState<SecretaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");

  async function load() {
    setLoading(true);
    const res = await callAdmin("list_users");
    setLoading(false);
    if (res.error) return setErr(res.error);
    setUsers(res.users as SecretaryRow[]);
  }
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!clientId && clients[0]) setClientId(clients[0].id);
  }, [clients, clientId]);

  async function create() {
    setErr(null);
    setMsg(null);
    if (!email.trim() || !password.trim() || !clientId)
      return setErr("Compila email, password e cliente.");
    const res = await callAdmin("create_venditore", {
      email: email.trim(),
      password,
      client_id: clientId,
      full_name: fullName.trim() || null,
    });
    if (res.error) return setErr(res.error);
    setMsg("Accesso creato. Comunica email e password al venditore.");
    setEmail("");
    setPassword("");
    setFullName("");
    load();
  }

  async function resetPwd(u: SecretaryRow) {
    const p = prompt(`Nuova password per ${u.email}:`);
    if (!p) return;
    const res = await callAdmin("set_password", { user_id: u.id, password: p });
    if (res.error) return alert(res.error);
    alert("Password aggiornata.");
  }

  async function del(u: SecretaryRow) {
    if (!confirm(`Eliminare l'accesso di ${u.email}?`)) return;
    const res = await callAdmin("delete_user", { user_id: u.id });
    if (res.error) return alert(res.error);
    load();
  }

  const clientName = (id: string | null) =>
    clients.find((c) => c.id === id)?.name ?? (id ? "—" : "(tutti)");

  return (
    <div className="panel">
      <h2>Accessi (venditori)</h2>
      {err && <div className="notice err">{err}</div>}
      {msg && <div className="notice ok">{msg}</div>}

      {loading ? (
        <div style={{ color: "var(--muted)" }}>Caricamento…</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Email</th>
              <th>Ruolo</th>
              <th>Cliente</th>
              <th style={{ width: 180 }}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.full_name || "—"}</td>
                <td>{u.email}</td>
                <td>{u.role === "admin" ? "Amministratore" : "Venditore"}</td>
                <td>{u.role === "admin" ? "(tutti)" : clientName(u.client_id)}</td>
                <td style={{ textAlign: "right" }}>
                  {u.role !== "admin" && (
                    <>
                      <button
                        className="btn small"
                        onClick={() => resetPwd(u)}
                        style={{ marginRight: 6 }}
                      >
                        Password
                      </button>
                      <button
                        className="btn small danger"
                        onClick={() => del(u)}
                      >
                        Elimina
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ fontSize: 14, marginTop: 18 }}>Crea nuovo accesso venditore</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field">
          <label>Nome</label>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label>Cliente assegnato</label>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Email (per il login)</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label>Password iniziale</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      <button className="btn primary" onClick={create}>
        + Crea accesso
      </button>
    </div>
  );
}
