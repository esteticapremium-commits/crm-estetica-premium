import { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
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
const Tasks = lazy(() => import("./pages/Tasks"));
const Calendar = lazy(() => import("./pages/Calendar"));
const PersonalTasks = lazy(() => import("./pages/PersonalTasks"));

type Tab = "board" | "sales" | "tasks" | "calendar" | "admin" | "control" | "editorial" | "contracts" | "personal";
type NavIconName = "home" | "pipeline" | "tasks" | "calendar" | "sales" | "contracts" | "company" | "editorial" | "revenue" | "comp" | "settings";

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-7h5v7"/></>,
    pipeline: <><rect x="3" y="4" width="6" height="6" rx="1.5"/><rect x="15" y="4" width="6" height="6" rx="1.5"/><rect x="9" y="14" width="6" height="6" rx="1.5"/><path d="M6 10v2h6m6-2v2h-6v2"/></>,
    tasks: <><path d="m4 6 2 2 4-4"/><path d="M12 6h8"/><path d="m4 13 2 2 4-4"/><path d="M12 13h8"/><path d="m4 20 2 2 4-4"/><path d="M12 20h8"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
    sales: <><path d="M4 18 10 12l4 4 6-9"/><path d="M15 7h5v5"/></>,
    contracts: <><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/></>,
    company: <><path d="M4 21V8l8-4v17M12 10l8-3v14M2 21h20"/><path d="M8 11h.01M8 15h.01M8 19h.01M16 11h.01M16 15h.01M16 19h.01"/></>,
    editorial: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 9h18M8 13h3M8 17h7"/></>,
    revenue: <><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5c-.8-.7-1.9-1-3.1-1-1.8 0-3 .8-3 2s1 1.8 3 2.2c2.1.4 3.2 1 3.2 2.4 0 1.3-1.2 2.4-3.3 2.4-1.4 0-2.7-.4-3.7-1.2M12 5.5v13"/></>,
    comp: <><circle cx="12" cy="8" r="4"/><path d="M4.5 21c.7-4.2 3.2-6.5 7.5-6.5s6.8 2.3 7.5 6.5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };
  return <i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg></i>;
}

/** Evita lo schermo bianco se una pagina aperta prova a caricare un file
 * JavaScript della versione precedente subito dopo una nuova pubblicazione. */
class ModuleBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    const isStaleModule = /dynamically imported module|module script|ChunkLoadError/i.test(error.message);
    const recoveryKey = "ep-module-recovery";
    if (isStaleModule && !window.sessionStorage.getItem(recoveryKey)) {
      window.sessionStorage.setItem(recoveryKey, "1");
      window.location.reload();
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="center-msg module-error"><b>Aggiornamento disponibile</b><span>La pagina è stata aggiornata. Premi qui per continuare.</span><button className="btn primary" onClick={() => window.location.reload()}>Ricarica pagina</button></div>;
  }
}

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
  const contentRef = useRef<HTMLDivElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("ep-sidebar-collapsed") === "true"
  );

  useEffect(() => {
    window.localStorage.setItem("ep-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Ogni modulo parte dalla propria intestazione. Senza questo reset la
  // posizione verticale del modulo precedente veniva mantenuta, facendo
  // sembrare troncati titoli e controlli dopo un cambio sezione.
  useLayoutEffect(() => {
    const resetScroll = () => {
      if (!contentRef.current) return;
      contentRef.current.scrollTop = 0;
      contentRef.current.scrollLeft = 0;
    };
    resetScroll();
    const frame = window.requestAnimationFrame(resetScroll);
    const afterModuleMount = window.setTimeout(resetScroll, 180);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(afterModuleMount);
    };
  }, [tab]);

  // Il venditore entra direttamente nella sua bacheca: qui lavora i lead.
  // La Panoramica rimane disponibile dal menu per seguire l'andamento generale.
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
    return <ModuleBoundary><Suspense fallback={<div className="center-msg">Caricamento documento…</div>}><FirmaPage token={firmaMatch[1]} /></Suspense></ModuleBoundary>;
  }

  if (auth.loading) {
    return <div className="center-msg">Caricamento…</div>;
  }
  if (!auth.userId) {
    return <ModuleBoundary><Suspense fallback={<div className="center-msg">Caricamento…</div>}><Login /></Suspense></ModuleBoundary>;
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
  const headerTools = tab !== "editorial" && tab !== "contracts" ? (
    <div className="section-global-tools">
      {pipelines.length > 1 && tab !== "admin" && (
        <select className="select" value={pipelineId ?? ""} onChange={(e) => setPipelineId(e.target.value)} title="Scegli la pipeline">
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <div className="search-wrap"><div className="search"><span>⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca lead…" /></div>
        {qResults.length > 0 && <div className="search-results">{qResults.map((l) => <div className="sr" key={l.id} onClick={() => selectLead(l)}><span><b>{l.name || "(senza nome)"}</b>{l.phone}</span><span>{clients.find((c) => c.id === l.client_id)?.name ?? ""}</span></div>)}</div>}
      </div>
    </div>
  ) : null;

  return (
    <div className={`app theme-premium platform-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand" aria-label="Estetica Premium"><div className="brand-logo">EP</div></div>
        <button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((v) => !v)} aria-label={sidebarCollapsed ? "Espandi barra laterale" : "Riduci barra laterale"} title={sidebarCollapsed ? "Espandi menu" : "Riduci menu"}>{sidebarCollapsed ? "›" : "‹"}</button>
        <nav className="side-nav" aria-label="Navigazione principale">
          <span className="nav-label">{isAdmin ? "Azienda" : "Generale"}</span>
          <button title="Panoramica" className={tab === "control" ? "active" : ""} onClick={() => setTab("control")}><NavIcon name="home" /> Panoramica</button>
          <span className="nav-label">CRM</span>
          <button title="Pipeline" className={tab === "board" ? "active" : ""} onClick={() => setTab("board")}><NavIcon name="pipeline" /> Pipeline</button>
          <button title="Attività" className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}><NavIcon name="tasks" /> Attività</button>
          <button title="Calendario" className={tab === "calendar" ? "active" : ""} onClick={() => setTab("calendar")}><NavIcon name="calendar" /> Calendario</button>
          <button title="Vendite" className={tab === "sales" ? "active" : ""} onClick={() => setTab("sales")}><NavIcon name="sales" /> Vendite</button>
          <button title="Contratti" className={tab === "contracts" ? "active" : ""} onClick={() => setTab("contracts")}><NavIcon name="contracts" /> Contratti</button>
          {isAdmin && <><span className="nav-label">Azienda</span><button title="Task Aziendali" className={tab === "personal" ? "active" : ""} onClick={() => setTab("personal")}><NavIcon name="company" /> Task Aziendali</button><button title="Piano editoriale" className={tab === "editorial" ? "active" : ""} onClick={() => setTab("editorial")}><NavIcon name="editorial" /> Piano editoriale</button><span className="side-item disabled"><NavIcon name="revenue" /> Fatturato</span><span className="side-item disabled"><NavIcon name="comp" /> Compensi</span><span className="nav-label">Sistema</span><button title="Impostazioni" className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}><NavIcon name="settings" /> Impostazioni</button></>}
        </nav>
        <div className="sidebar-user"><div className="avatar">{(auth.profile.full_name || auth.email || "?").charAt(0).toUpperCase()}</div><div><b>{auth.profile.full_name || auth.email}</b><span>{isAdmin ? "Amministratore" : "Venditore"}</span></div><button title="Esci" onClick={() => supabase.auth.signOut()}>↪</button></div>
      </aside>
      <main className="app-main">
        <div className="app-content" ref={contentRef}><ModuleBoundary><Suspense fallback={<div className="center-msg">Caricamento modulo…</div>}>
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
            headerTools={headerTools}
          />
        ) : (
          <div className="center-msg">Nessuna pipeline disponibile.</div>
        ))}

      {tab === "sales" && currentClient && currentPipeline && (
        <Vendite client={currentClient} pipeline={currentPipeline} headerTools={headerTools} />
      )}

      {tab === "tasks" && currentClient && (
        <Tasks client={currentClient} pipeline={currentPipeline} meName={meName} admin={isAdmin} headerTools={headerTools} onOpenLead={(lead) => { setClientId(lead.client_id); setPipelineId(lead.pipeline_id); setFocusLeadId(lead.id); setTab("board"); }} />
      )}

      {tab === "calendar" && currentClient && (
        <Calendar client={currentClient} meName={meName} headerTools={headerTools} />
      )}

      {tab === "control" && currentClient && (
        <Control client={currentClient} pipelines={pipelines} meName={meName} admin={isAdmin} headerTools={headerTools} />
      )}

      {tab === "editorial" && isAdmin && currentClient && (
        <EditorialPlan clientId={currentClient.id} meName={meName} />
      )}

      {tab === "personal" && isAdmin && <PersonalTasks headerTools={headerTools} />}

      {tab === "contracts" && <Contracts canManageLinks={isAdmin} />}

      {tab === "admin" && isAdmin && <Admin clients={clients} headerTools={headerTools} />}
        </Suspense></ModuleBoundary></div>
      </main>
    </div>
  );
}
