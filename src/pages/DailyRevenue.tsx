import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { romeToday } from "../dates";
import { withTimeout } from "../async";
import "./DailyRevenue.css";

const GOAL = 1000;
const euros = (value: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

/** Company totals only: never fetch other sellers' individual financial records. */
export default function DailyRevenue({ clientId }: { clientId: string }) {
  const [today, setToday] = useState(romeToday);
  const [chosenDay, setChosenDay] = useState<string | null>(null);
  const day = chosenDay ?? today;
  const [result, setResult] = useState<{ day: string; client: string; amount: number } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      setToday(romeToday());
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const { data, error: failure } = await withTimeout(supabase.rpc("company_daily_collected", { p_client_id: clientId, p_day: day }));
        if (failure) throw failure;
        const amount = Number(data);
        if (data == null || !Number.isFinite(amount) || amount < 0) throw new Error("Invalid total");
        if (active) { setResult({ day, client: clientId, amount }); setError(false); }
      } catch { if (active) setError(true); }
      finally { pending = false; }
    };
    setResult(null); setError(false);
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [clientId, day, retry]);

  const amount = result?.day === day && result.client === clientId ? result.amount : null;
  const remaining = amount === null ? null : Math.max(0, Math.round((GOAL - amount) * 100) / 100);
  const progress = amount === null ? 0 : Math.min(100, amount / GOAL * 100);
  const label = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Rome" }).format(new Date(`${day}T12:00:00Z`));

  return <section className="daily-revenue" aria-labelledby="daily-revenue-heading">
    <div className="daily-revenue-top">
      <div><span className="daily-revenue-eyebrow">IL RISULTATO DELLA SQUADRA</span><h2 id="daily-revenue-heading">{day === today ? "Incassato oggi" : "Incassato del giorno"}</h2><span>{label}</span></div>
      <div className="daily-revenue-date"><label htmlFor="revenue-day">Visualizza un giorno</label><div><input id="revenue-day" type="date" value={day} max={today} onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value <= today) setChosenDay(e.target.value === today ? null : e.target.value); }} />{chosenDay && <button type="button" onClick={() => setChosenDay(null)}>Oggi</button>}</div></div>
    </div>
    {error ? <div className="daily-revenue-error" role="alert">Il totale non è disponibile. <button type="button" onClick={() => setRetry((n) => n + 1)}>Riprova</button></div> : <>
      <div className="daily-revenue-amount" aria-live="polite">{amount === null ? <span className="daily-revenue-loading">Caricamento risultato…</span> : euros(amount)}</div>
      <p className="daily-revenue-message">{remaining === null ? "Obiettivo giornaliero: 1.000 €" : remaining > 0 ? <>Mancano <strong>{euros(remaining)}</strong> all’obiettivo {day === today ? "di oggi" : "del giorno"}.</> : <><strong>Obiettivo raggiunto!</strong>{amount! > GOAL ? ` ${euros(amount! - GOAL)} oltre il traguardo.` : " Il traguardo di 1.000 € è nostro."}</>}</p>
      <div className="daily-revenue-track" role="progressbar" aria-label="Obiettivo giornaliero di incasso" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} aria-valuetext={amount === null ? "Caricamento" : `${euros(amount)} su ${euros(GOAL)}`}><span style={{ width: `${progress}%` }} /></div>
      <div className="daily-revenue-target"><span>{amount === null ? "—" : `${Math.round(amount / GOAL * 100)}%`} del traguardo</span><strong>Obiettivo {euros(GOAL)} / giorno</strong></div>
    </>}
    <p className="daily-revenue-note">Incassi aziendali registrati nel CRM nella data selezionata, inclusi rinnovi e upsell. Esclusi importi previsti e annullati. Orario italiano.</p>
  </section>;
}
