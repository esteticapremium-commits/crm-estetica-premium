import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { useAuth } from "./useAuth";
import type { Client, Lead, Pipeline } from "./types";
import Login from "./pages/Login";
import Board from "./pages/Board";
import Dashboard, { ALL_PIPELINES_ID } from "./pages/Dashboard";
import Admin from "./pages/Admin";
import Performance from "./pages/Performance";
import Vendite from "./pages/Vendite";
import FirmaPage from "./pages/FirmaPage";

type Tab = "board" | "dashboard" | "sales" | "performance" | "admin";

export default function App() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>("board");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [qResults, setQResults] = useState<Lead[]>([]);
  const [focusLeadId, setFocusLeadId] = useState<string | null>(null);

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

  // Link pubblico di firma: #/firma/<token> — nessun login richiesto
  const firmaMatch = window.location.hash.match(/^#\/firma\/([^/]+)/);
  if (firmaMatch) {
    return <FirmaPage token={firmaMatch[1]} />;
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

  if (auth.loading) {
    return <div className="center-msg">Caricamento…</div>;
  }
  if (!auth.userId) {
    return <Login />;
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
  // Tema premium: riservato alle agenzie di marketing (clienti "Estetica").
  // Gli altri clienti restano sul tema caldo standard.
  const isPremium = currentClient?.name.startsWith("Estetica") ?? false;
  const isAllView = pipelineId === ALL_PIPELINES_ID;
  // Pipeline sintetica "Totale": esiste solo per la Dashboard.
  const allPipeline: Pipeline | null =
    isAllView && clientId
      ? {
          id: ALL_PIPELINES_ID,
          client_id: clientId,
          name: "Totale (tutti i servizi)",
          position: -1,
          meta_form_id: null,
          meta_ad_account_id: null,
          created_at: "",
        }
      : null;
  const currentPipeline = allPipeline ?? pipelines.find((p) => p.id === pipelineId) ?? null;
  // La Bacheca non conosce la vista Totale: usa sempre una pipeline reale.
  const boardPipeline = isAllView ? pipelines[0] ?? null : currentPipeline;

  return (
    <div className="app theme-premium">
      <div className="topbar">
        <div className="brand">
          Estetica Premium <small>· pipeline</small>
        </div>

        <nav className="nav">
          <button
            className={tab === "board" ? "active" : ""}
            onClick={() => {
              setTab("board");
              // La Bacheca non ha la vista Totale: torna a una pipeline reale.
              if (pipelineId === ALL_PIPELINES_ID) setPipelineId(pipelines[0]?.id ?? null);
            }}
          >
            Bacheca
          </button>
          {isPremium && (
            <button
              className={tab === "sales" ? "active" : ""}
              onClick={() => setTab("sales")}
            >
              Vendite
            </button>
          )}
          {!isPremium && (
            <button
              className={tab === "dashboard" ? "active" : ""}
              onClick={() => setTab("dashboard")}
            >
              Dashboard
            </button>
          )}
          {isAdmin && !isPremium && (
            <button
              className={tab === "performance" ? "active" : ""}
              onClick={() => setTab("performance")}
            >
              Performance
            </button>
          )}
          {isAdmin && (
            <button
              className={tab === "admin" ? "active" : ""}
              onClick={() => setTab("admin")}
            >
              Amministrazione
            </button>
          )}
        </nav>

        {/* CRM singolo: il selettore cliente non esiste. */}

        {/* Selettore pipeline: appare solo se il cliente ha piu' di una pipeline */}
        {pipelines.length > 1 && tab !== "admin" && tab !== "performance" && (
          <select
            className="select"
            value={pipelineId ?? ""}
            onChange={(e) => setPipelineId(e.target.value)}
            title="Scegli la pipeline"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {/* La vista Totale somma tutti i servizi: solo nella Dashboard */}
            {tab === "dashboard" && (
              <option value={ALL_PIPELINES_ID}>Totale (tutti i servizi)</option>
            )}
          </select>
        )}

        <div className="spacer" />

        {/* Cerca lead: digiti e scegli, si apre nella sua bacheca */}
        <div className="search-wrap">
          <div className="search">
            🔍
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cerca lead per nome o telefono…"
            />
          </div>
          {qResults.length > 0 && (
            <div className="search-results">
              {qResults.map((l) => (
                <div className="sr" key={l.id} onClick={() => selectLead(l)}>
                  <span>
                    <b>{l.name || "(senza nome)"}</b>
                    {l.phone}
                  </span>
                  <span>
                    {clients.find((c) => c.id === l.client_id)?.name ?? ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="userchip">
          <div className="avatar">
            {(auth.profile.full_name || auth.email || "?").charAt(0).toUpperCase()}
          </div>
          <div className="who">
            <b>{auth.profile.full_name || auth.email}</b>
            {isAdmin ? "Amministratore" : "Venditore"}
          </div>
        </div>
        <button className="btn small" onClick={() => supabase.auth.signOut()}>
          Esci
        </button>
      </div>

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
          />
        ) : (
          <div className="center-msg">Nessuna pipeline disponibile.</div>
        ))}

      {tab === "sales" && currentClient && currentPipeline && (
        <Vendite client={currentClient} pipeline={currentPipeline} />
      )}

      {tab === "performance" && isAdmin && <Performance clients={clients} />}

      {tab === "dashboard" &&
        (currentClient && currentPipeline ? (
          <Dashboard client={currentClient} pipeline={currentPipeline} pipelines={pipelines} />
        ) : (
          <div className="center-msg">Nessuna pipeline disponibile.</div>
        ))}

      {tab === "admin" && isAdmin && (
        <Admin
          clients={clients}
          onClientsChanged={() => {
            supabase
              .from("clients")
              .select(
        "id, name, ingest_token, ghl_pipeline_id, meta_page_id, meta_form_id, meta_ad_account_id, created_at"
      )
              .order("name")
              .then(({ data }) => setClients((data as Client[]) ?? []));
          }}
        />
      )}
    </div>
  );
}
