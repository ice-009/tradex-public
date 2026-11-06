"use client";

import { useMemo, useState } from "react";
import "./plan.css";
import type { EvidenceResponse, ScreenerResponse, TradeDto, TradesResponse } from "@/contracts/api";
import { formatPrice } from "@/core/format";
import { istParts } from "@/core/market/session";
import type { Plan, PlanIdea } from "@/core/plan/builder";
import { MIN_T, VERDICT_LABEL, bucketFor, signedR, type EvidenceBucket, type EvidenceTable, type MarketState } from "@/core/plan/evidence";
import { exitShort, trailSessions } from "@/core/plan/instructions";
import { EXIT_REASONS, realisedR, slippageR, type ExitReason } from "@/core/plan/journal";
import { withLivePrice, type TradeTrack } from "@/core/plan/tracker";
import { SCREENS, SCREEN_MAP } from "@/core/screener/screens";
import type { LiveScreenRecord } from "@/core/screener/liveRecord";
import { closeTrade, editTrade, removeTrade, takeTrade, usePlanFeed } from "@/client/planFeed";
import { refreshScreener, riskReward, useScreenerFeed } from "@/client/screenerFeed";
import { openIdea } from "./ideaActions";
import { drawPlanOnChart } from "./SetupCard";
import { updateScreener, useTerminal } from "./store";
import { setSizing, usePrefs } from "./uiPrefs";
import { useDailyPlan, useMarketState } from "./usePlan";
import { useLiveTick, useVisibleLiveTick } from "./LivePrice";
import { Icons } from "./icons";

// The Plan tab: today's trades to take (from screens with a tested edge in
// this market), how many lots, how to get in and out; your open trades with
// today's action; and the journal of closed ones. The rules are in
// src/core/plan (builder, tracker, journal); this file only shows them.

const rupees = (value: number) => `₹${formatPrice(value, 0)}`;
const day = (time: number) => new Date(time).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const monthYear = (time: number) => new Date(time).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

/** "5y" for the span of the evidence (it is shorter when less history is stored). */
function spanLabel(table: EvidenceTable) {
  const years = (table.to - table.from) / (365.25 * 86_400_000);
  return years >= 4.5 ? "5y" : years >= 1 ? `${Math.round(years)}y` : `${Math.round(years * 12)}m`;
}

/** yyyy-mm-dd of an IST day key, for date inputs. */
const dateValue = (dayKey: number) => new Date(dayKey).toISOString().slice(0, 10);
/** A date input's IST day back to epoch ms: now when it's today, else 3:25 PM IST that day. */
function entryTime(value: string) {
  const dayKey = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(dayKey) || dayKey === istParts().day) return Date.now();
  return dayKey + (15 * 60 + 25 - 330) * 60_000;
}

export function PlanPanel() {
  const height = useTerminal((state) => state.screener.height);
  const maximized = useTerminal((state) => state.screener.maximized);
  const data = useScreenerFeed((feed) => feed.data);
  const loading = useScreenerFeed((feed) => feed.loading);
  const evidence = usePlanFeed((feed) => feed.evidence);
  const trades = usePlanFeed((feed) => feed.trades);
  const tradesError = usePlanFeed((feed) => feed.tradesError);
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const maxOpen = usePrefs((prefs) => prefs.maxOpen);
  const plan = useDailyPlan();
  const state = useMarketState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const ready = evidence?.status === "ready" ? evidence : null;

  return (
    <section className="tx-scr tx-plan" style={{ height: maximized ? undefined : `min(${height}px, 42vh)` }}>
      <header className="tx-scr-head tx-plan-head">
        <MarketBadge state={state} />
        <span className="tx-plan-risk" title={`${riskPct}% of ${rupees(capital)} capital, at most ${maxOpen} trades open`}>
          Risk/trade <b>{rupees((capital * riskPct) / 100)}</b>
        </span>
        {data?.regime && (
          <span className={`tx-regime is-${data.regime.state}`} title={[`Market regime: ${data.regime.label}`, ...data.regime.reasons].join("\n")}>
            <i aria-hidden />
            {data.regime.label}
          </span>
        )}
        <span className="tx-scr-status">{statusLine(data, evidence)}</span>
        <span className="tx-tb-spacer" />
        <button type="button" className={`tx-icon-btn ${settingsOpen ? "is-on" : ""}`} title="Capital, risk per trade, most open trades" onClick={() => setSettingsOpen(!settingsOpen)}>
          <Icons.gear size={15} />
        </button>
        <button type="button" className="tx-icon-btn" title="Re-check the screens now" disabled={loading} onClick={refreshScreener}>
          <Icons.reset size={15} />
        </button>
      </header>
      {settingsOpen && <PlanSettings />}

      <div className="tx-plan-body">
        <div className="tx-plan-col">
          <TodaysPlan plan={plan} state={state} evidence={ready} trades={trades} live={Boolean(data?.asOf?.live)} eodDate={data?.asOf?.eodDate ?? null} />
        </div>
        <div className="tx-plan-col">
          <OpenTrades trades={trades} error={tradesError} />
          <Journal trades={trades} />
        </div>
        <div className="tx-plan-foot">
          {ready ? (
            <p className="tx-scr-note">
              How setups are picked: every screen was replayed over {monthYear(ready.table.from)} – {monthYear(ready.table.to)} on {`${ready.table.symbols} F&O stocks`}, bought at the
              signal close (or the buy-stop) and sold at its stop, target or time exit, net of costs ({ready.costs.label}, ≈{ready.costs.roundTripPct.toFixed(2)}% a round trip). A
              setup is used only in the market state where it made money in both the first 60% and the last 40% of its signals with a t-stat over {MIN_T}.{" "}
              <button type="button" className="tx-scr-clear" onClick={() => setShowEvidence(!showEvidence)}>
                {showEvidence ? "Hide the evidence" : "Show the evidence"}
              </button>
            </p>
          ) : null}
          {ready && showEvidence && <EvidenceTableView evidence={ready} />}
          <p className="tx-scr-note">A planning aid, not advice: past results of mechanical rules don&apos;t promise future ones. Orders are placed in your broker&apos;s app.</p>
        </div>
      </div>
    </section>
  );
}

function statusLine(data: ScreenerResponse | null, evidence: EvidenceResponse | null) {
  if (evidence?.status === "computing") {
    const { done, total } = evidence.progress;
    return `Testing every screen on the stored history… ${total ? `${Math.round((done / total) * 100)}%` : ""}`;
  }
  if (evidence?.status === "error") return `Evidence unavailable: ${evidence.error}`;
  if (!data) return "Loading the screener…";
  if (data.status === "syncing") return "The screener is building its history…";
  if (data.status === "error") return data.error ?? "The screener has no data.";
  if (!data.asOf) return "";
  if (data.asOf.stale) return "⚠ No live prices: matches use the last close";
  return data.asOf.live ? `Live · checked ${new Date(data.asOf.computedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : `From the close of ${day(data.asOf.eodDate)}`;
}

function MarketBadge({ state }: { state: MarketState | null }) {
  const regime = useScreenerFeed((feed) => feed.data?.regime);
  const values =
    regime?.niftyClose && regime.niftySma200 ? `NIFTY ${formatPrice(regime.niftyClose, 0)} vs its 200-day average ${formatPrice(regime.niftySma200, 0)}` : "NIFTY vs its 200-day average";
  const label = state === "up" ? "Uptrend (NIFTY > 200-day)" : state === "down" ? "Downtrend (NIFTY < 200-day)" : "Unknown (no NIFTY 200-day yet)";
  return (
    <span className={`tx-plan-market is-${state ?? "unknown"}`} title={`${values}. The plan uses only setups that held up in this market state over the last five years.`}>
      MARKET: <b>{label}</b>
    </span>
  );
}

function PlanSettings() {
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const maxOpen = usePrefs((prefs) => prefs.maxOpen);
  const maxLeverage = usePrefs((prefs) => prefs.maxLeverage);
  const number = (value: string, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  return (
    <div className="tx-plan-settings">
      <label>
        <span>Capital ₹</span>
        <input className="tx-input tx-input-num" type="number" min={10000} step={10000} value={capital} onChange={(event) => { const n = number(event.target.value, 10_000, 1e10); if (n !== null) setSizing({ capital: n }); }} />
      </label>
      <label>
        <span>Risk per trade %</span>
        <input className="tx-input tx-input-num" type="number" min={0.1} max={5} step={0.1} value={riskPct} onChange={(event) => { const n = number(event.target.value, 0.1, 5); if (n !== null) setSizing({ riskPct: n }); }} />
      </label>
      <label>
        <span>Most open trades</span>
        <input className="tx-input tx-input-num" type="number" min={1} max={20} step={1} value={maxOpen} onChange={(event) => { const n = number(event.target.value, 1, 20); if (n !== null) setSizing({ maxOpen: Math.round(n) }); }} />
      </label>
      <label title="Total open notional is capped at capital × this (stock-futures margin is about 20–25% of notional)">
        <span>Leverage cap ×</span>
        <input className="tx-input tx-input-num" type="number" min={1} max={8} step={0.5} value={maxLeverage} onChange={(event) => { const n = number(event.target.value, 1, 8); if (n !== null) setSizing({ maxLeverage: n }); }} />
      </label>
      <span className="tx-dim">Each trade is sized so its stop loses about {riskPct}% of capital, in whole futures lots.</span>
    </div>
  );
}

// ------------------------------------------------------------------ today's plan

function TodaysPlan({ plan, state, evidence, trades, live, eodDate }: { plan: Plan | null; state: MarketState | null; evidence: Extract<EvidenceResponse, { status: "ready" }> | null; trades: TradesResponse | null; live: boolean; eodDate: number | null }) {
  const [showMore, setShowMore] = useState(false);
  const universe = useTerminal((s) => s.screener.universe);
  const evidenceStatus = usePlanFeed((feed) => feed.evidence?.status);
  const sized = plan?.ideas.length ?? 0;
  const riskBudget = plan?.riskBudget ?? 0;
  return (
    <section className="tx-plan-section">
      <div className="tx-plan-title">
        TODAY&apos;S PLAN <span className="tx-dim">(buy 3:15–3:25 PM)</span>
        {plan && (
          <span className="tx-plan-slots">
            {plan.freeSlots} of {plan.freeSlots + plan.openCount} slots free
          </span>
        )}
      </div>
      {state === "down" && (
        <div className="tx-plan-warn">
          NIFTY is below its 200-day average. In this market most long setups lost money over the last five years, so only the ones that held up in it are listed
          {plan && !plan.eligible.length ? " — and none did." : "."}
        </div>
      )}
      {!evidence ? (
        <div className="tx-plan-empty">{evidenceStatus === "error" ? "The evidence couldn't be computed, so there is no plan. It needs the stored daily history (Market data → Download F&O history)." : "Testing the screens on the stored history (about 10 seconds the first time each day)…"}</div>
      ) : !plan ? (
        <div className="tx-plan-empty">Waiting for the screener&apos;s matches…</div>
      ) : !plan.eligible.length ? (
        <div className="tx-plan-empty">No setup passed the test in this market. Not trading is the plan today.</div>
      ) : plan.freeSlots === 0 ? (
        <div className="tx-plan-empty">All {plan.openCount} slots are in use. Manage the open trades; new ideas appear when one closes.</div>
      ) : !plan.ideas.length && !plan.unsized.length ? (
        <div className="tx-plan-empty">
          None of the setups that work in this market ({plan.eligible.map((id) => SCREEN_MAP[id]?.name).join(", ")}) match right now. The screener re-checks during the session.
        </div>
      ) : !plan.ideas.length ? (
        <div className="tx-plan-empty">
          None of today&apos;s {plan.unsized.length} matches fits a {rupees(riskBudget)} risk per trade: one futures lot of each loses more than that at its stop. Leave the slots empty, or
          raise capital or risk % (gear icon) if that really is your size.
        </div>
      ) : (
        <ol className="tx-plan-ideas">
          {plan.ideas.map((idea, i) => (
            <IdeaRow key={idea.symbol} idea={idea} rank={i + 1} evidence={evidence} trades={trades} />
          ))}
        </ol>
      )}
      {plan && plan.unsized.length > 0 && <UnsizedList plan={plan} />}
      {plan && !live && eodDate && plan.ideas.length > 0 && (
        <p className="tx-scr-note">These matched at the close of {day(eodDate)}. During the session they are re-checked on live prices: take what still matches at 3:15–3:25 PM.</p>
      )}
      {plan && plan.ideas.length > 0 && sized < plan.freeSlots && (
        <p className="tx-scr-note">
          {sized} idea{sized === 1 ? "" : "s"} for {plan.freeSlots} free slots: leave the rest empty rather than take setups without an edge.
        </p>
      )}
      {plan && plan.more.length > 0 && (
        <div className="tx-plan-more">
          <button type="button" className="tx-scr-clear" onClick={() => setShowMore(!showMore)}>
            {showMore ? "Hide" : "Show"} {plan.more.length} more match{plan.more.length === 1 ? "" : "es"} (slots full)
          </button>
          {showMore && (
            <ol className="tx-plan-ideas is-more">
              {plan.more.map((idea, i) => (
                <IdeaRow key={idea.symbol} idea={idea} rank={plan.ideas.length + i + 1} evidence={evidence!} trades={trades} />
              ))}
            </ol>
          )}
        </div>
      )}
      {plan && (plan.skipped.banned.length > 0 || plan.skipped.held.length > 0 || plan.skipped.noLot.length > 0) && (
        <p className="tx-scr-note">
          Left out:
          {plan.skipped.banned.length > 0 && ` F&O ban ${plan.skipped.banned.join(", ")}.`}
          {plan.skipped.held.length > 0 && ` Already held ${plan.skipped.held.join(", ")}.`}
          {plan.skipped.noLot.length > 0 && ` No futures lot size known for ${plan.skipped.noLot.slice(0, 8).join(", ")}${plan.skipped.noLot.length > 8 ? ` and ${plan.skipped.noLot.length - 8} more` : ""}.`}
        </p>
      )}
      {universe !== "fno" && plan && (
        <p className="tx-scr-note">
          The plan trades stock futures, but Explore is set to another list, so stocks without futures are left out.{" "}
          <button type="button" className="tx-scr-clear" onClick={() => updateScreener({ universe: "fno" })}>
            Use the F&amp;O list
          </button>
        </p>
      )}
    </section>
  );
}

/** Ideas that ranked in the plan but can't be sized: one compact chip each, still clickable. */
function UnsizedList({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const shown = open ? plan.unsized : plan.unsized.slice(0, 6);
  return (
    <div className="tx-plan-unsized">
      <span
        className="tx-dim"
        title="One lot loses more than your risk per trade at its stop (or your open trades already use the leverage cap). Shown so you know they matched; the plan doesn't size them."
      >
        Too big for your {rupees(plan.riskBudget)} risk:
      </span>
      {shown.map((idea) => (
        <button
          type="button"
          key={idea.symbol}
          className="tx-plan-chip"
          onClick={() => openIdea(idea.symbol, idea.screenId)}
          title={`${SCREEN_MAP[idea.screenId]?.name} · ${idea.entry.text} · ${idea.exitText}\n${idea.size.status === "too-big" ? `One lot (${idea.size.lot}) loses ${rupees(idea.size.oneLotRisk)} at the stop` : "No room under the leverage cap"}`}
        >
          {idea.symbol} <span className="tx-dim">{idea.size.status === "too-big" ? `${rupees(idea.size.oneLotRisk)}/lot` : "no room"}</span>
        </button>
      ))}
      {plan.unsized.length > shown.length && (
        <button type="button" className="tx-scr-clear" onClick={() => setOpen(true)}>
          +{plan.unsized.length - shown.length} more
        </button>
      )}
    </div>
  );
}

/** "live 4/6" (BTST live record) or "you 2/3" (your own closed trades of this setup). */
function liveLine(screenId: string, live: Record<string, LiveScreenRecord> | null, trades: TradesResponse | null): string | null {
  const record = live?.[screenId];
  if (record && record.trades > 0 && record.winShare !== null) return `live ${Math.round(record.winShare * record.trades)}/${record.trades}`;
  const mine = trades?.journal.byScreen[screenId];
  return mine?.trades ? `you ${mine.wins}/${mine.trades}` : null;
}

function IdeaRow({ idea, rank, evidence, trades }: { idea: PlanIdea; rank: number; evidence: Extract<EvidenceResponse, { status: "ready" }>; trades: TradesResponse | null }) {
  const { ref, tick } = useVisibleLiveTick<HTMLLIElement>(idea.symbol);
  const [taking, setTaking] = useState(false);
  const active = useTerminal((state) => state.cells[state.activeCell].symbol === idea.symbol);
  const screen = SCREEN_MAP[idea.screenId];
  const span = spanLabel(evidence.table);
  const live = liveLine(idea.screenId, evidence.live, trades);
  const { size } = idea;
  const sizeText =
    size.status === "ok" ? `${size.lots} lot${size.lots === 1 ? "" : "s"}` : size.status === "too-big" ? "too big for your risk" : "no room under the leverage cap";
  const sizeTitle =
    size.status === "ok"
      ? `${size.lots} × ${size.lot} = ${size.qty} shares · ${rupees(size.notional)} notional · loses ${rupees(size.risk)} at the stop`
      : size.status === "too-big"
        ? `One lot (${size.lot} shares) loses ${rupees(size.oneLotRisk)} at the stop, more than your risk per trade`
        : "Your open trades already use the leverage cap: total notional ≤ capital × the cap.";
  return (
    <li ref={ref} className={`tx-plan-idea ${active ? "is-active" : ""} ${size.status !== "ok" ? "is-unsized" : ""}`}>
      <button type="button" className="tx-plan-idea-main" onClick={() => openIdea(idea.symbol, idea.screenId)} title="Open the chart with this plan">
        <span className="tx-plan-rank">{rank}</span>
        <span className="tx-plan-line1">
          <b className="tx-plan-symbol">{idea.symbol}</b>
          <span className={`tx-plan-setup tx-hz-${screen.group}`}>{screen.name}</span>
          <span className={`tx-plan-size is-${size.status}`} title={sizeTitle}>
            {sizeText}
          </span>
          {tick && <span className="tx-dim tx-plan-ltp">now {formatPrice(tick.ltp)}</span>}
        </span>
        <span className="tx-plan-line2">
          {idea.entry.kind === "buy-stop" ? "buy-stop" : "entry"} ~{formatPrice(idea.entry.price)} · stop {formatPrice(idea.stop)} · exit: {exitShort(idea.exitRule, idea, idea.holdSessions)}
        </span>
        <span className="tx-plan-line3" title={`${idea.entry.text}. Exit: ${idea.exitText}.\n${idea.sampleN} trades behind the ${span} number${idea.scoreRanks ? "; within this setup, higher scores did better" : ""}.${idea.alsoMatched.length ? `\nAlso matches: ${idea.alsoMatched.map((id) => SCREEN_MAP[id]?.name).join(", ")}` : ""}`}>
          {span} {signedR(idea.expectedR)}/trade · last 12m {signedR(idea.recentR)}
          {live ? ` · ${live}` : ""}
        </span>
      </button>
      <span className="tx-plan-actions">
        <button type="button" className="tx-icon-btn" title="Save this plan on the chart as a Long Position" onClick={() => drawPlanOnChart({ screen, row: idea.row, rr: riskReward(idea.row) })}>
          <Icons.long size={15} />
        </button>
        <button type="button" className="tx-btn-outline tx-plan-took" onClick={() => setTaking(!taking)} title="Record that you took this trade">
          {taking ? "Cancel" : "I took it"}
        </button>
      </span>
      {taking && <TakeForm idea={idea} price={tick?.ltp ?? null} onDone={() => setTaking(false)} />}
    </li>
  );
}

function TakeForm({ idea, price, onDone }: { idea: PlanIdea; price: number | null; onDone: () => void }) {
  const [fill, setFill] = useState(String(Math.round((price ?? idea.entry.price) * 100) / 100));
  const [lots, setLots] = useState(String(Math.max(1, idea.size.lots)));
  const [date, setDate] = useState(dateValue(istParts().day));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await takeTrade({
        symbol: idea.symbol,
        screenId: idea.screenId,
        plannedEntry: idea.entry.price,
        stop: idea.stop,
        target: idea.target,
        exitRule: idea.exitRule,
        holdSessions: idea.holdSessions,
        entryPrice: Number(fill),
        entryAt: entryTime(date),
        lots: Number(lots),
        lotSize: idea.size.lot,
        notes: notes || null,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const risk = (Number(fill) - idea.stop) * Number(lots) * idea.size.lot;
  return (
    <form
      className="tx-plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        <span>Fill price</span>
        <input className="tx-input tx-input-num" type="number" step="0.05" min="0" value={fill} onChange={(event) => setFill(event.target.value)} required />
      </label>
      <label>
        <span>Lots ({idea.size.lot})</span>
        <input className="tx-input tx-input-num" type="number" step="1" min="1" value={lots} onChange={(event) => setLots(event.target.value)} required />
      </label>
      <label>
        <span>Date</span>
        <input className="tx-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
      </label>
      <label className="tx-plan-notes">
        <span>Notes</span>
        <input className="tx-input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional" />
      </label>
      <button type="submit" className="tx-btn-small" disabled={busy}>
        Save trade
      </button>
      <span className="tx-dim">{Number.isFinite(risk) && risk > 0 ? `Loses ${rupees(risk)} at the stop ${formatPrice(idea.stop)}` : ""}</span>
      {error && <span className="tx-plan-error">{error}</span>}
    </form>
  );
}

// ------------------------------------------------------------------ open trades

const REASON_FOR: Record<TradeTrack["action"], ExitReason> = { "sell-open": "open", overnight: "open", stop: "stop", target: "target", trail: "trail", time: "time", hold: "manual" };

function OpenTrades({ trades, error }: { trades: TradesResponse | null; error: string | null }) {
  const open = useMemo(() => (trades?.trades ?? []).filter((trade) => trade.status === "open"), [trades]);
  return (
    <section className="tx-plan-section">
      <div className="tx-plan-title">
        OPEN TRADES <span className="tx-dim">{open.length || ""}</span>
      </div>
      {error && !trades && <div className="tx-plan-empty">Couldn&apos;t load your trades: {error}</div>}
      {trades && !open.length && <div className="tx-plan-empty">None. Press “I took it” on a plan idea after you place the order, and it is tracked here.</div>}
      <ul className="tx-plan-open">
        {open.map((trade) => (
          <OpenTradeRow key={trade.id} trade={trade} track={trades?.tracks[trade.id] ?? null} />
        ))}
      </ul>
    </section>
  );
}

function OpenTradeRow({ trade, track: stored }: { trade: TradeDto; track: TradeTrack | null }) {
  const tick = useLiveTick(trade.symbol, 2);
  const [mode, setMode] = useState<"close" | "edit" | null>(null);
  const track = stored ? withLivePrice(stored, trade, tick?.ltp) : null;
  const screen = SCREEN_MAP[trade.screenId];
  const btst = trade.exitRule === "next-open";
  const trail = trailSessions(trade.exitRule);
  return (
    <li className={`tx-plan-trade ${track?.urgent ? "is-urgent" : ""}`}>
      <button type="button" className="tx-plan-trade-main" onClick={() => openIdea(trade.symbol)} title={`${screen?.name ?? trade.screenId} · ${trade.lots} lot${trade.lots === 1 ? "" : "s"} (${trade.quantity}) bought at ${formatPrice(trade.entryPrice)} on ${day(trade.entryDay)}`}>
        <b className="tx-plan-symbol">{trade.symbol}</b>
        <span className="tx-plan-hold">{btst ? "BTST" : track ? `day ${track.session}/${trade.holdSessions}` : ""}</span>
        {track && <span className={`tx-plan-r ${track.r >= 0 ? "is-up" : "is-down"}`} title={`At ${formatPrice(track.price)}${track.live ? " (live)" : " (last close)"}`}>{signedR(track.r, 1)}</span>}
        <span className={`tx-plan-action ${track?.urgent ? "is-urgent" : ""}`}>
          {btst && track?.urgent ? "→ " : ""}
          {track?.text ?? "…"}
          {trail && track?.action === "hold" && track.trailStop === null ? ` · trail starts after ${trail} sessions` : ""}
        </span>
      </button>
      <span className="tx-plan-actions">
        <button type="button" className="tx-btn-outline" onClick={() => setMode(mode === "close" ? null : "close")}>
          {mode === "close" ? "Cancel" : "Close"}
        </button>
        <button type="button" className="tx-icon-btn" title="Edit fill, lots or notes" onClick={() => setMode(mode === "edit" ? null : "edit")}>
          <Icons.gear size={14} />
        </button>
      </span>
      {mode === "close" && <CloseForm trade={trade} price={tick?.ltp ?? track?.price ?? trade.entryPrice} reason={track ? REASON_FOR[track.action] : "manual"} onDone={() => setMode(null)} />}
      {mode === "edit" && <EditForm trade={trade} onDone={() => setMode(null)} />}
    </li>
  );
}

function CloseForm({ trade, price, reason: initialReason, onDone }: { trade: TradeDto; price: number; reason: ExitReason; onDone: () => void }) {
  const [exit, setExit] = useState(String(Math.round(price * 100) / 100));
  const [reason, setReason] = useState<ExitReason>(initialReason);
  const [date, setDate] = useState(dateValue(istParts().day));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = realisedR({ plannedEntry: trade.plannedEntry, stop: trade.stop, entryPrice: trade.entryPrice, exitPrice: Number(exit) });
  return (
    <form
      className="tx-plan-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await closeTrade(trade.id, { exitPrice: Number(exit), reason, exitAt: entryTime(date) });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span>Exit fill</span>
        <input className="tx-input tx-input-num" type="number" step="0.05" min="0" value={exit} onChange={(event) => setExit(event.target.value)} required />
      </label>
      <label>
        <span>Why</span>
        <select className="tx-input" value={reason} onChange={(event) => setReason(event.target.value as ExitReason)}>
          {EXIT_REASONS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Date</span>
        <input className="tx-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
      </label>
      <button type="submit" className="tx-btn-small" disabled={busy}>
        Close trade
      </button>
      <span className="tx-dim">{Number.isFinite(r) ? `${signedR(r)} before costs` : ""}</span>
      {error && <span className="tx-plan-error">{error}</span>}
    </form>
  );
}

function EditForm({ trade, onDone }: { trade: TradeDto; onDone: () => void }) {
  const [fill, setFill] = useState(String(trade.entryPrice));
  const [lots, setLots] = useState(String(trade.lots));
  const [stop, setStop] = useState(String(trade.stop));
  const [notes, setNotes] = useState(trade.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="tx-plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => editTrade(trade.id, { entryPrice: Number(fill), lots: Number(lots), stop: Number(stop), notes }));
      }}
    >
      <label>
        <span>Fill price</span>
        <input className="tx-input tx-input-num" type="number" step="0.05" min="0" value={fill} onChange={(event) => setFill(event.target.value)} required />
      </label>
      <label>
        <span>Lots ({trade.lotSize})</span>
        <input className="tx-input tx-input-num" type="number" step="1" min="1" value={lots} onChange={(event) => setLots(event.target.value)} required />
      </label>
      <label>
        <span>Stop</span>
        <input className="tx-input tx-input-num" type="number" step="0.05" min="0" value={stop} onChange={(event) => setStop(event.target.value)} required />
      </label>
      <label className="tx-plan-notes">
        <span>Notes</span>
        <input className="tx-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <button type="submit" className="tx-btn-small" disabled={busy}>
        Save
      </button>
      <button
        type="button"
        className="tx-scr-clear tx-plan-delete"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Delete the ${trade.symbol} trade? Use this only for a trade entered by mistake.`)) void run(() => removeTrade(trade.id));
        }}
      >
        Delete
      </button>
      {error && <span className="tx-plan-error">{error}</span>}
    </form>
  );
}

// ------------------------------------------------------------------ journal

function Journal({ trades }: { trades: TradesResponse | null }) {
  const [open, setOpen] = useState(false);
  const closed = useMemo(() => (trades?.trades ?? []).filter((trade) => trade.status === "closed").sort((a, b) => (b.exitAt ?? 0) - (a.exitAt ?? 0)), [trades]);
  const summary = trades?.journal;
  if (!summary || !summary.trades) {
    return (
      <section className="tx-plan-section">
        <div className="tx-plan-title">JOURNAL</div>
        <div className="tx-plan-empty">Closed trades show here: R made, and how your fills compared with the plan.</div>
      </section>
    );
  }
  const slip = (value: number | null) => (value === null ? "—" : `${value > 0 ? "−" : "+"}${Math.abs(value).toFixed(2)}R`);
  return (
    <section className="tx-plan-section">
      <div className="tx-plan-title">
        JOURNAL <span className="tx-dim">{summary.trades} closed</span>
      </div>
      <div className="tx-plan-summary">
        <span title="Share of closed trades that made money after charges">
          Won <b>{summary.wins}/{summary.trades}</b>
        </span>
        <span title="Average R per trade after charges (your fills include your slippage)">
          Avg <b className={(summary.avgNetR ?? 0) >= 0 ? "is-up" : "is-down"}>{signedR(summary.avgNetR)}</b>
        </span>
        <span>
          Total <b className={summary.totalNetR >= 0 ? "is-up" : "is-down"}>{signedR(summary.totalNetR, 1)}</b> ({rupees(summary.pnl)} gross)
        </span>
        <span title="Your entry fills vs the plan's entry, in R (negative = you paid more than planned)">
          Entry slippage <b>{slip(summary.entrySlipR)}</b>
        </span>
        <span title={`Your exit fills vs the plan's exit (the stop, the target, or that session's open/close) on ${summary.exitCompared} trades, in R`}>
          Exit slippage <b>{slip(summary.exitSlipR)}</b>
        </span>
        <button type="button" className="tx-scr-clear" onClick={() => setOpen(!open)}>
          {open ? "Hide trades" : "Show trades"}
        </button>
      </div>
      {open && (
        <div className="tx-plan-table-wrap">
          <table className="tx-scr-track tx-plan-closed">
            <thead>
              <tr>
                <th className="is-left">Closed</th>
                <th className="is-left">Stock</th>
                <th className="is-left">Setup</th>
                <th title="Your fill (plan)">Entry</th>
                <th title="Your fill (plan)">Exit</th>
                <th className="is-left">Why</th>
                <th title="Before charges, on the planned risk">R</th>
                <th title="Entry + exit slippage against the plan, R (negative = worse)">Slip</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((trade) => {
                const r = realisedR({ ...trade, exitPrice: trade.exitPrice ?? trade.entryPrice });
                const s = slippageR({ ...trade, exitPrice: trade.exitPrice ?? trade.entryPrice, plannedExit: trade.plannedExit });
                const total = s.entry + (s.exit ?? 0);
                return (
                  <tr key={trade.id} title={trade.notes ?? undefined}>
                    <td className="is-left">{trade.exitAt ? day(istParts(trade.exitAt).day) : "—"}</td>
                    <td className="is-left">{trade.symbol}</td>
                    <td className="is-left">{SCREEN_MAP[trade.screenId]?.name ?? trade.screenId}</td>
                    <td>
                      {formatPrice(trade.entryPrice)} <span className="tx-dim">({formatPrice(trade.plannedEntry)})</span>
                    </td>
                    <td>
                      {formatPrice(trade.exitPrice ?? NaN)} {trade.plannedExit !== null && <span className="tx-dim">({formatPrice(trade.plannedExit)})</span>}
                    </td>
                    <td className="is-left">{EXIT_REASONS.find((entry) => entry.id === trade.exitReason)?.label ?? "—"}</td>
                    <td className={r >= 0 ? "is-up" : "is-down"}>{signedR(r)}</td>
                    <td className={total > 0 ? "is-down" : ""}>{slip(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ evidence table

function BucketCells({ bucket }: { bucket: EvidenceBucket }) {
  const tone = bucket.eligible ? "good" : (bucket.mean ?? 0) < 0 ? "bad" : "none";
  return (
    <>
      <td>{bucket.n}</td>
      <td className={`tx-tone-${tone}`}>{signedR(bucket.mean)}</td>
      <td>{bucket.t === null ? "—" : bucket.t.toFixed(1)}</td>
      <td title={bucket.splitDate ? `Split at ${day(bucket.splitDate)}` : undefined}>
        {signedR(bucket.first.mean)} / {signedR(bucket.last.mean)}
      </td>
      <td>{bucket.eligible ? "✓" : ""}</td>
    </>
  );
}

function EvidenceTableView({ evidence }: { evidence: Extract<EvidenceResponse, { status: "ready" }> }) {
  const { table } = evidence;
  const rows = SCREENS.map((screen) => table.screens[screen.id]).filter(Boolean);
  return (
    <div className="tx-plan-table-wrap">
      <table className="tx-scr-track tx-plan-evidence">
        <thead>
          <tr>
            <th className="is-left" rowSpan={2}>
              Screen
            </th>
            <th className="is-left" rowSpan={2}>
              Verdict
            </th>
            <th colSpan={5}>NIFTY above its 200-day</th>
            <th colSpan={5}>NIFTY below its 200-day</th>
            <th rowSpan={2} title="All market states, last 12 months">
              12m
            </th>
            <th rowSpan={2} title="Top third vs bottom third of signals by the screen's score (t ≥ 2 = the score picks better trades)">
              Score
            </th>
          </tr>
          <tr>
            {["up", "down"].map((side) => (
              <FragmentHead key={side} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => {
            const screen = SCREEN_MAP[entry.screenId];
            const score = bucketFor(entry, null).score;
            return (
              <tr key={entry.screenId} title={VERDICT_LABEL[entry.verdict]}>
                <td className="is-left">
                  <span className={`tx-hz-dot tx-hz-${screen.group}`} /> {screen.name}
                </td>
                <td className="is-left">
                  <span className={`tx-plan-verdict is-${entry.verdict}`}>{VERDICT_LABEL[entry.verdict]}</span>
                </td>
                <BucketCells bucket={entry.up} />
                <BucketCells bucket={entry.down} />
                <td>{signedR(entry.all.recent.mean)}</td>
                <td title={score ? `top ${signedR(score.top)} · middle ${signedR(score.mid)} · bottom ${signedR(score.bottom)} (t ${score.t.toFixed(1)})` : "Too few signals"}>
                  {score ? (score.ranks ? "ranks" : "noise") : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="tx-scr-note">
        n = trades, R = mean net R per trade, t over signal days, first 60% / last 40% of each column&apos;s signals in date order. ✓ = used by the plan in that market. {evidence.universeNote}
        {" "}Computed {new Date(evidence.computedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} in {(evidence.ms / 1000).toFixed(1)} s.
      </p>
    </div>
  );
}

function FragmentHead() {
  return (
    <>
      <th>n</th>
      <th>R</th>
      <th>t</th>
      <th>60% / 40%</th>
      <th title="Passes: used by the plan">Use</th>
    </>
  );
}
