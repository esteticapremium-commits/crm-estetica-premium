import { lazy, Suspense, useEffect, useState } from "react";
import { isSupabaseConfigured, supabase } from "./supabaseClient";
import { useAuth } from "./useAuth";
import type { Client, Lead, Pipeline } from "./types";
const Login = lazy(() => import("./pages/Login"));
const Board = lazy(() => import("./pages/Board"));
const Admin = lazy(() => import("./pages/Admin"));
const Vendite = lazy(() => import("./pages/Vendite"));
const FirmaPage = lazy(() => import("./pages/FirmaPage"));
const Control = lazy(() => import("./pages/Control"));
const EditorialPlan = lazy(() => import("./pages/EditorialPlan"));
const Contracts = lazy(() => import("./pages/Contracts"));

type Tab = "board" | "sales" | "admin" | "control" | "editorial" | "contracts";

export default function App() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>("control");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [qResults, setQResults] = useState<Lead[]>([]);
  const [focusLeadId, setFocusLeadId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("ep-sidebar-collapsed") === "true"
  );

  useEffect(() => {
    window.localStorage.setItem("ep-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Il venditore entra direttamente nella sua bacheca: qui lavora i lead.
  // I numeri e le performance restano nella sezione Vendite.
  useEffect(() => {
    if (auth.profile?.role === "venditore") setTab("board");
  }, [auth.profile?.role]);

  // Ricerca globale: per nome o telefono, su tutti i lead visibili
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || term.includes(",") || term.includes(")")) {
      // virgole e parentesi romperebbero il filtro .or(): le ignoriamo
      setQResults([]);
      return;
    }
    const t = setTimeout(() => {
      supabase
        .from("leads")
        .select("id, name, phone, client_id, pipeline_id, stage_id")
        .or(`name.ilike.%${term}%,phone.ilike.%${term}%`)
        .limit(8)
        .then(({ data }) => setQResults((data as Lead[]) ?? []));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  function selectLead(l: Lead) {
    setQ("");
    setQResults([]);
    setTab("board");
    setClientId(l.client_id);
    setPipelineId(l.pipeline_id);
    setFocusLeadId(l.id);
  }

  const isAdmin = auth.profile?.role === "admin";
  const meName = auth.profile?.full_name || auth.email || "";

  // CRM singolo: carichiamo solo il cliente Estetica Premium.
  // I clienti di altri progetti non entrano in questa app.
  useEffect(() => {
    if (!auth.profile) return;
    supabase
      .from("clients")
      .select(
        "id, name, ingest_token, ghl_pipeline_id, meta_page_id, meta_form_id, meta_ad_account_id, created_at"
      )
      .order("name")
      .then(({ data }) => {
        const list = ((data as Client[]) ?? []).filter((c) =>
          c.name.startsWith("Estetica")
        );
        setClients(list);
        // Il venditore vede solo il proprio cliente; l'admin vede comunque
        // solo i clienti Estetica.
        if (auth.profile?.role === "venditore") {
          setClientId(auth.profile.client_id);
        } else if (list.length > 0) {
          setClientId((prev) => prev ?? list[0].id);
        }
      });
  }, [auth.profile]);

  // Carica le pipeline del cliente selezionato.
  // IMPORTANTE: questo hook deve stare PRIMA di ogni return condizionale,
  // altrimenti React cambia il numero di hook tra un render e l'altro (schermo bianco).
  useEffect(() => {
    if (!clientId) {
      setPipelines([]);
      setPipelineId(null);
      return;
    }
    supabase
      .from("pipelines")
      .select("id, client_id, name, position, meta_form_id, meta_ad_account_id, created_at")
      .eq("client_id", clientId)
      .order("position")
      .then(({ data }) => {
        const list = (data as Pipeline[]) ?? [];
        setPipelines(list);
        setPipelineId((prev) => (list.find((p) => p.id === prev) ? prev : list[0]?.id ?? null));
      });
  }, [clientId]);

  if (!isSupabaseConfigured) {
    return <div className="center-msg">Configurazione mancante. Imposta <b>VITE_SUPABASE_URL</b> e <b>VITE_SUPABASE_ANON_KEY</b> nelle variabili d’ambiente di Vercel.</div>;
  }

  // Link pubblico di firma: #/firma/<token> — nessun login richiesto.
  // Le dichiarazioni degli hook restano tutte sopra questo return.
  const firmaMatch = window.location.hash.match(/^#\/firma\/([^/]+)/);
  if (firmaMatch) {
    return <Suspense fallback={<div className="center-msg">Caricamento documento…</div>}><FirmaPage token={firmaMatch[1]} /></Suspense>;
  }

  if (auth.loading) {
    return <div className="center-msg">Caricamento…</div>;
  }
  if (!auth.userId) {
    return <Suspense fallback={<div className="center-msg">Caricamento…</div>}><Login /></Suspense>;
  }
  if (!auth.profile) {
    return (
      <div className="center-msg">
        Il tuo account non ha ancora un profilo. Chiedi all'amministratore di
        assegnarti un cliente.
        <br />
        <button
          className="btn"
          style={{ marginTop: 12 }}
          onClick={() => supabase.auth.signOut()}
        >
          Esci
        </button>
      </div>
    );
  }

  const currentClient = clients.find((c) => c.id === clientId) ?? null;
  const currentPipeline = pipelines.find((p) => p.id === pipelineId) ?? null;
  const boardPipeline = currentPipeline;
  const pageTitle: Record<Tab, string> = {
    control: isAdmin ? "Panoramica" : "Le mie priorità",
    board: "CRM · Pipeline",
    sales: "CRM · Vendite",
    admin: "Impostazioni",
    editorial: "Piano editoriale",
    contracts: "Contratti",
  };

  return (
    <div className={`app theme-premium platform-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand" aria-label="Estetica Premium"><div className="brand-logo">EP</div></div>
        <button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((v) => !v)} aria-label={sidebarCollapsed ? "Espandi barra laterale" : "Riduci barra laterale"} title={sidebarCollapsed ? "Espandi menu" : "Riduci menu"}>{sidebarCollapsed ? "›" : "‹"}</button>
        <nav className="side-nav" aria-label="Navigazione principale">
          {isAdmin && <><span className="nav-label">Azienda</span><button className={tab === "control" ? "active" : ""} onClick={() => setTab("control")}><i>⌂</i> Panoramica</button></>}
          <span className="nav-label">CRM</span>
          <button className={tab === "board" ? "active" : ""} onClick={() => setTab("board")}><i>▦</i> Pipeline</button>
          <button className={tab === "sales" ? "active" : ""} onClick={() => setTab("sales")}><i>↗</i> Vendite</button>
          {isAdmin && <><span className="nav-label">Azienda</span><button className={tab === "editorial" ? "active" : ""} onClick={() => setTab("editorial")}><i>□</i> Piano editoriale</button><button className={tab === "contracts" ? "active" : ""} onClick={() => setTab("contracts")}><i>▤</i> Contratti</button><span className="side-item disabled"><i>€</i> Fatturato</span><span className="side-item disabled"><i>◌</i> Compensi</span><span className="nav-label">Sistema</span><button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}><i>⚙</i> Impostazioni</button></>}
        </nav>
        <div className="sidebar-user"><div className="avatar">{(auth.profile.full_name || auth.email || "?").charAt(0).toUpperCase()}</div><div><b>{auth.profile.full_name || auth.email}</b><span>{isAdmin ? "Amministratore" : "Venditore"}</span></div><button title="Esci" onClick={() => supabase.auth.signOut()}>↪</button></div>
      </aside>
      <main className="app-main">
        <header className="topbar app-header">
          <div><div className="eyebrow">{isAdmin ? "Estetica Premium · Azienda" : "Estetica Premium · CRM"}</div><h1>{pageTitle[tab]}</h1></div>
          <div className="header-actions">
            {pipelines.length > 1 && tab !== "admin" && tab !== "editorial" && tab !== "contracts" && (
              <select className="select" value={pipelineId ?? ""} onChange={(e) => setPipelineId(e.target.value)} title="Scegli la pipeline">
                {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {tab !== "editorial" && tab !== "contracts" && <div className="search-wrap"><div className="search"><span>⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca lead…" /></div>
              {qResults.length > 0 && <div className="search-results">{qResults.map((l) => <div className="sr" key={l.id} onClick={() => selectLead(l)}><span><b>{l.name || "(senza nome)"}</b>{l.phone}</span><span>{clients.find((c) => c.id === l.client_id)?.name ?? ""}</span></div>)}</div>}
            </div>}
          </div>
        </header>
        <div className="app-content"><Suspense fallback={<div className="center-msg">Caricamento modulo…</div>}>
      {tab === "board" &&
        (currentClient && boardPipeline ? (
          <Board
            client={currentClient}
            pipeline={boardPipeline}
            canEdit={true}
            meName={meName}
            autoAssign={!isAdmin}
            focusLeadId={focusLeadId}
            onFocusConsumed={() => setFocusLeadId(null)}
            canDelete={isAdmin}
            canReassign={isAdmin}
          />
        ) : (
          <div className="center-msg">Nessuna pipeline disponibile.</div>
        ))}

      {tab === "sales" && currentClient && currentPipeline && (
        <Vendite client={currentClient} pipeline={currentPipeline} />
      )}

      {tab === "control" && currentClient && (
        <Control client={currentClient} pipelines={pipelines} meName={meName} admin={isAdmin} />
      )}

      {tab === "editorial" && isAdmin && currentClient && (
        <EditorialPlan clientId={currentClient.id} meName={meName} />
      )}

      {tab === "contracts" && isAdmin && <Contracts />}

      {tab === "admin" && isAdmin && <Admin clients={clients} />}
        </Suspense></div>
      </main>
    </div>
  );
}
