import { romeStamp } from "../dates";
import { setterColumns, summarizeSetterQueue, type SetterQueueFilter } from "../setterQueue";

type SetterSummary = ReturnType<typeof summarizeSetterQueue> & { id: string; name: string; total: number };

export default function SetterTeamOverview({ summaries, selected, now, loaded, onOpen }: {
  summaries: SetterSummary[];
  selected: string;
  now: number;
  loaded: boolean;
  onOpen: (id: string, filter: SetterQueueFilter) => void;
}) {
  const overdue = summaries.reduce((total, setter) => total + setter.overdue, 0);
  return <section className="setter-team" aria-labelledby="setter-team-title">
    <header className="setter-team-heading">
      <div>
        <h2 id="setter-team-title">Pipeline dei setter</h2>
        {loaded && <p>Ultimo aggiornamento alle {new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(now)}</p>}
      </div>
      {overdue > 0 && <button className="btn setter-team-overdue" type="button" onClick={() => onOpen("", "overdue")}>
        {overdue} {overdue === 1 ? "richiamo scaduto" : "richiami scaduti"} nel team
      </button>}
    </header>
    <div className="setter-team-grid">
      {summaries.map(person => <article className="panel setter-worker-card" key={person.id} data-selected={selected === person.id}>
        <div className="setter-worker-head">
          <div><h3>{person.name}</h3><p>{loaded ? `${person.total} lead in coda` : "Caricamento lead…"}</p></div>
          <button type="button" className="btn" aria-label={`Apri la pipeline di ${person.name}`}
            aria-pressed={selected === person.id} onClick={() => onOpen(person.id, "all")}>Apri pipeline</button>
        </div>
        <dl className="setter-worker-stages">
          {setterColumns.map(([stage, label]) => <div key={stage}>
            <dt>{label}</dt><dd>{loaded ? person.stages[stage] : "—"}</dd>
          </div>)}
        </dl>
        {loaded && (person.overdue > 0 || person.todayCallbacks > 0 || person.nextDiscovery) && <div className="setter-worker-actions">
          {person.overdue > 0 && <button className="btn setter-team-overdue" type="button"
            aria-label={`${person.overdue} ${person.overdue === 1 ? "richiamo scaduto" : "richiami scaduti"} di ${person.name}`}
            onClick={() => onOpen(person.id, "overdue")}>{person.overdue} {person.overdue === 1 ? "scaduto" : "scaduti"}</button>}
          {person.todayCallbacks > 0 && <button className="btn" type="button"
            aria-label={`${person.todayCallbacks} ${person.todayCallbacks === 1 ? "richiamo" : "richiami"} di oggi di ${person.name}`}
            onClick={() => onOpen(person.id, "today")}>{person.todayCallbacks} oggi</button>}
          {person.nextDiscovery && <p>Prossima discovery <strong>{romeStamp(person.nextDiscovery)}</strong></p>}
        </div>}
      </article>)}
    </div>
    {loaded && !summaries.length && <p className="muted">Nessun setter attivo per questa azienda.</p>}
  </section>;
}
