import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { romeToday } from "../dates";
import { withTimeout } from "../async";
import "./DailyRevenue.css";

const MONTHLY_GOALS: Record<string, number> = { "2026-10": 10000 };
const euros = (value: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

/** Company totals only: never fetch other sellers' individual financial records. */
export default function DailyRevenue({ clientId }: { clientId: string }) {
  const [today, setToday] = useState(romeToday);
  const [chosenDay, setChosenDay] = useState<string | null>(null);
  const day = chosenDay ?? today;
  const [result, setResult] = useState<{ day: string; client: string; amount: number } | null>(null);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [monthlyResult, setMonthlyResult] = useState<{ month: string; client: string; amount: number } | null>(null);
  const [monthlyError, setMonthlyError] = useState(false);
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

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      setToday(romeToday());
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const { data, error: failure } = await withTimeout(supabase.rpc("company_monthly_collected", { p_client_id: clientId, p_month: monthStart }));
        if (failure) throw failure;
        const amount = Number(data);
        if (data == null || !Number.isFinite(amount) || amount < 0) throw new Error("Invalid total");
        if (active) { setMonthlyResult({ month: monthStart, client: clientId, amount }); setMonthlyError(false); }
      } catch { if (active) setMonthlyError(true); }
      finally { pending = false; }
    };
    setMonthlyResult(null); setMonthlyError(false);
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [clientId, monthStart, retry]);

  const amount = result?.day === day && result.client === clientId ? result.amount : null;
  const monthlyAmount = monthlyResult?.month === monthStart && monthlyResult.client === clientId ? monthlyResult.amount : null;
  const monthlyGoal = MONTHLY_GOALS[today.slice(0, 7)];
  const remaining = monthlyAmount === null || !monthlyGoal ? null : Math.max(0, monthlyGoal - monthlyAmount);
  const progress = monthlyAmount === null || !monthlyGoal ? 0 : Math.min(100, monthlyAmount / monthlyGoal * 100);
  const month = new Intl.DateTimeFormat("it-IT", { month: "long", timeZone: "Europe/Rome" }).format(new Date(`${today}T12:00:00Z`));
  const label = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Rome" }).format(new Date(`${day}T12:00:00Z`));

  return <section className="daily-revenue" aria-labelledby="daily-revenue-heading">
    <div className="daily-revenue-center">
    {error ? <div className="daily-revenue-error" role="alert">Il totale non è disponibile. <button type="button" onClick={() => setRetry((n) => n + 1)}>Riprova</button></div> : <>
      <div className="daily-revenue-amount" aria-live="polite">{amount === null ? <span className="daily-revenue-loading">Caricamento risultato…</span> : euros(amount)}</div>
    </>}
    <h2 id="daily-revenue-heading">{day === today ? "Incasso del giorno" : "Incasso del giorno selezionato"}</h2><span className="daily-revenue-day">{label}</span>
    <div className="daily-revenue-goal"><span>Obiettivo del mese · {month}</span><strong>{monthlyGoal ? `Chiudere a ${euros(monthlyGoal)}` : "Obiettivo da definire"}</strong>
      {monthlyGoal && (monthlyError ? <div role="alert">Il totale mensile non è disponibile. <button type="button" onClick={() => setRetry((n) => n + 1)}>Riprova</button></div> : monthlyAmount === null ? <p>Caricamento avanzamento mensile…</p> : <div className="monthly-goal-progress">
        <div className="monthly-goal-totals"><span><b>{euros(monthlyAmount)}</b> incassati nel mese</span><span>{new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }).format(monthlyAmount / monthlyGoal * 100)}%</span></div>
        <div className="monthly-goal-track" role="progressbar" aria-label="Avanzamento obiettivo mensile" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${euros(monthlyAmount)} incassati su ${euros(monthlyGoal)}`}><span style={{ width: `${progress}%` }} /></div>
        <p className="monthly-goal-remaining" aria-live="polite">{remaining! > 0 ? <>Mancano <strong>{euros(remaining!)}</strong> all’obiettivo del mese</> : <><strong>Obiettivo raggiunto!</strong>{monthlyAmount > monthlyGoal ? ` ${euros(monthlyAmount - monthlyGoal)} oltre il traguardo.` : ""}</>}</p>
      </div>)}
    </div>
    </div>
      <div className="daily-revenue-date"><label htmlFor="revenue-day">Visualizza un giorno</label><div><input id="revenue-day" type="date" value={day} max={today} onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value <= today) setChosenDay(e.target.value === today ? null : e.target.value); }} />{chosenDay && <button type="button" onClick={() => setChosenDay(null)}>Oggi</button>}</div></div>
    <p className="daily-revenue-note">Incassi aziendali registrati nel CRM nella data selezionata, inclusi rinnovi e upsell. Esclusi importi previsti e annullati. Orario italiano.</p>
  </section>;
}
