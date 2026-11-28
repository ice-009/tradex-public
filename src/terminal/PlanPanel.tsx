"use client";

import { useEffect, useMemo, useState } from "react";
import "./plan.css";
import type { EvidenceResponse, ScreenerResponse, TradeDto, TradesResponse } from "@/contracts/api";
import { MARKET_PHASES, phaseById } from "@/core/backtest/phases";
import { formatPrice } from "@/core/format";
import { istParts } from "@/core/market/session";
import type { Plan, PlanIdea } from "@/core/plan/builder";
import { MIN_T, MIN_TRADES, VERDICT_LABEL, bucketFor, signedR, type EvidenceBucket, type EvidenceTable, type MarketState } from "@/core/plan/evidence";
import { exitShort, trailSessions } from "@/core/plan/instructions";
import { EXCLUSION_ORDER, MAX_RISK_PCT, excludedScreens, lakhs, sizeHint, type Exclusion, type ExclusionReason } from "@/core/plan/explain";
import { isPlanPreview } from "@/core/plan/preview";
import { EXIT_REASONS, realisedR, slippageR, type ExitReason } from "@/core/plan/journal";
import { withLivePrice, type TradeTrack } from "@/core/plan/tracker";
import { BTST_WINDOW } from "@/core/screener/btstAlerts";
import { SCREENS, SCREEN_MAP } from "@/core/screener/screens";
import type { LiveScreenRecord } from "@/core/screener/liveRecord";
import type { RunStamp } from "@/core/repro/stamp";
import { api } from "@/client/api";
import { closeTrade, editTrade, removeTrade, takeTrade, usePlanFeed } from "@/client/planFeed";
import { refreshScreener, riskReward, useScreenerFeed } from "@/client/screenerFeed";
import { openIdea } from "./ideaActions";
import { drawPlanOnChart } from "./SetupCard";
import { updateScreener, useTerminal } from "./store";
import { setSizing, usePrefs } from "./uiPrefs";
import { useDailyPlan, useMarketState } from "./usePlan";
import { useLiveTick, useVisibleLiveTick } from "./LivePrice";
import { Icons } from "./icons";
import { RunStampBar, type Replay } from "./RunStampBar";
import { ReceiptLine } from "./Receipt";
import { useScreenReceipts } from "./useReceipts";
import { useTimeMachine } from "@/client/timeMachine";
import { LiveOnlyNote } from "./TimeMachine";
import { PlanLedger } from "./PlanLedger";
import { Coach } from "./Coach";

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
/** "HH:MM" IST now, for time inputs. */
const clockNow = () => {
  const { minutes } = istParts();
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};
/** A date and an optional "HH:MM" IST time to epoch ms; without a time, 3:25 PM IST and `timed` false (the coach then can't check the entry window). */
function entryMoment(date: string, clock: string): { at: number; timed: boolean } {
  const dayKey = Date.parse(`${date}T00:00:00Z`);
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!Number.isFinite(dayKey)) return { at: Date.now(), timed: true };
  if (!match) return { at: dayKey + (15 * 60 + 25 - 330) * 60_000, timed: false };
  return { at: dayKey + (Number(match[1]) * 60 + Number(match[2]) - 330) * 60_000, timed: true };
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
          <TodaysPlan plan={plan} state={state} evidence={ready} trades={trades} live={Boolean(data?.asOf?.live)} eodDate={data?.asOf?.eodDate ?? null} onSizing={() => setSettingsOpen(true)} />
          <PlanLedger />
        </div>
        <div className="tx-plan-col">
          <JournalColumn trades={trades} error={tradesError} />
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
          {ready && showEvidence && <EvidencePeriods evidence={ready} />}
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
        <input className="tx-input tx-input-num" type="number" min={0.1} max={MAX_RISK_PCT} step={0.1} value={riskPct} onChange={(event) => { const n = number(event.target.value, 0.1, MAX_RISK_PCT); if (n !== null) setSizing({ riskPct: n }); }} />
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

/** The time now, re-read every 30 s (the plan's wording changes at the close window). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function TodaysPlan({
  plan,
  state,
  evidence,
  trades,
  live,
  eodDate,
  onSizing,
}: {
  plan: Plan | null;
  state: MarketState | null;
  evidence: Extract<EvidenceResponse, { status: "ready" }> | null;
  trades: TradesResponse | null;
  live: boolean;
  eodDate: number | null;
  /** Opens the sizing settings (capital, risk %). */
  onSizing: () => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const universe = useTerminal((s) => s.screener.universe);
  const evidenceStatus = usePlanFeed((feed) => feed.evidence?.status);
  const sized = plan?.ideas.length ?? 0;
  const now = useNow();
  const inSession = isPlanPreview(live, now);
  const preview = inSession && Boolean(plan && (plan.ideas.length || plan.unsized.length));
  const excluded = evidence && plan ? excludedScreens(evidence.table.screens, state, plan.eligible) : [];
  const btstEligible = Boolean(plan?.eligible.some((id) => SCREEN_MAP[id]?.group === "btst"));
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
      {preview && (
        <div className="tx-plan-preview">
          <b>Preview at live prices.</b> These setups were tested on closing prices, so the plan is final at {BTST_WINDOW.from / 60 | 0}:{String(BTST_WINDOW.from % 60).padStart(2, "0")} PM: take an idea only if it
          still matches then. A stock that is already up a lot today can fade by the close and drop out.
        </div>
      )}
      {!evidence ? (
        <div className="tx-plan-empty">{evidenceStatus === "error" ? "The evidence couldn't be computed, so there is no plan. It needs the F&O stocks' daily history from the Market Data Hub (see Market data in the top bar)." : "Testing the screens on the stored history (about 10 seconds the first time each day)…"}</div>
      ) : !plan ? (
        <div className="tx-plan-empty">Waiting for the screener&apos;s matches…</div>
      ) : !plan.eligible.length ? (
        <div className="tx-plan-empty">No setup passed the test in this market. Not trading is the plan today.</div>
      ) : plan.freeSlots === 0 ? (
        <div className="tx-plan-empty">All {plan.openCount} slots are in use. Manage the open trades; new ideas appear when one closes.</div>
      ) : !plan.ideas.length && !plan.unsized.length ? (
        <div className="tx-plan-empty">
          None of the setups that work in this market ({plan.eligible.map((id) => SCREEN_MAP[id]?.name).join(", ")}) match right now. The screener re-checks during the session.
          {inSession && btstEligible ? " The BTST setups judge the day's close, so most of their matches appear only in the last hour: the plan is final at 3:10 PM." : ""}
        </div>
      ) : !plan.ideas.length ? (
        <TooBig plan={plan} onSizing={onSizing} />
      ) : (
        <ol className="tx-plan-ideas">
          {plan.ideas.map((idea, i) => (
            <IdeaRow key={idea.symbol} idea={idea} rank={i + 1} evidence={evidence} trades={trades} />
          ))}
        </ol>
      )}
      {plan && plan.unsized.length > 0 && <UnsizedList plan={plan} />}
      {excluded.length > 0 && plan && <LeftOut excluded={excluded} expanded={!plan.ideas.length} />}
      {plan && plan.invalid.length > 0 && <InvalidList plan={plan} />}
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

/** Every match is too big for the risk per trade: what would fit the closest one, and a way to the sizing settings. */
function TooBig({ plan, onSizing }: { plan: Plan; onSizing: () => void }) {
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const maxOpen = usePrefs((prefs) => prefs.maxOpen);
  const maxLeverage = usePrefs((prefs) => prefs.maxLeverage);
  const hint = sizeHint(plan, { capital, riskPct, maxOpen, maxLeverage });
  const count = plan.unsized.length;
  const leverageBound = Boolean(hint && hint.lotNotional + plan.openNotional > capital * maxLeverage);
  return (
    <div className="tx-plan-empty tx-plan-toobig">
      None of today&apos;s {count} match{count === 1 ? "" : "es"} fits a {rupees(plan.riskBudget)} risk per trade ({riskPct}% of {lakhs(capital)}): one futures lot of {count === 1 ? "it" : "each"} loses more
      than that at its stop{plan.unsized.some((idea) => idea.size.status === "no-room") ? ", or doesn't fit under the leverage cap" : ""}.
      {hint && (
        <>
          {" "}
          The closest: one lot of <b>{hint.symbol}</b> ({hint.lot} shares, {lakhs(hint.lotNotional)}) risks <b>{rupees(hint.oneLotRisk)}</b> — it needs <b>≥ {lakhs(hint.capital)}</b> capital at{" "}
          {riskPct}% risk
          {hint.riskPct !== null ? (
            <>
              , or <b>{hint.riskPct}%</b> risk on {lakhs(capital)}
            </>
          ) : leverageBound ? (
            ` (one lot is more than your ${maxLeverage}× leverage cap allows on ${lakhs(capital)})`
          ) : (
            ` (on ${lakhs(capital)} it would take over ${MAX_RISK_PCT}% risk)`
          )}
          .
        </>
      )}{" "}
      Leave the slots empty, or change your sizing if that really is your size.{" "}
      <button type="button" className="tx-scr-clear" onClick={onSizing}>
        Sizing settings
      </button>
    </div>
  );
}

const RULE_TITLE = `A setup joins the plan only while, in this market state, it has at least ${MIN_TRADES} tested trades, made money in both the first 60% and the last 40% of them, and has a t-stat over ${MIN_T}.`;

const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  "lost-lately": "Made money, then lost it in their last 40% of signals",
  noisy: `Made money, but too unevenly to trust (t-stat not over ${MIN_T})`,
  "lost-early": "Lost money in their first 60% of signals (they must make money in both parts)",
  few: `Too few signals in this market to judge (under ${MIN_TRADES})`,
  "one-state": "Work in one market state only, and the state is unknown",
  lost: "Lost money over the test",
};

function exclusionShort(entry: Exclusion): string {
  switch (entry.reason) {
    case "lost-lately":
      return `${entry.name} ${signedR(entry.last)}${entry.splitDate ? ` since ${monthYear(entry.splitDate)}` : ""}`;
    case "noisy":
      return `${entry.name} t ${entry.t === null ? "—" : entry.t.toFixed(1)}`;
    case "lost-early":
      return `${entry.name} ${signedR(entry.first)}`;
    case "few":
      return `${entry.name} (${entry.n})`;
    case "lost":
      return `${entry.name} ${signedR(entry.mean)}`;
    default:
      return entry.name;
  }
}

const exclusionTitle = (entry: Exclusion) =>
  `${entry.n} trades · mean ${signedR(entry.mean)} · first 60% ${signedR(entry.first)} · last 40% ${signedR(entry.last)}${entry.splitDate ? ` (from ${monthYear(entry.splitDate)})` : ""} · last 12 months ${signedR(entry.recent)} · t ${entry.t === null ? "—" : entry.t.toFixed(1)}`;

function ExclusionList({ list }: { list: Exclusion[] }) {
  return (
    <>
      {list.map((entry, i) => (
        <span key={entry.id} title={exclusionTitle(entry)}>
          {i ? ", " : ""}
          {exclusionShort(entry)}
        </span>
      ))}
    </>
  );
}

/** The setups the evidence rule leaves out in this market state, and why: in full when the plan has no ideas. */
function LeftOut({ excluded, expanded }: { excluded: Exclusion[]; expanded: boolean }) {
  const [open, setOpen] = useState(false);
  const lately = excluded.filter((entry) => entry.reason === "lost-lately");
  if (!expanded && !open) {
    return (
      <p className="tx-scr-note" title={RULE_TITLE}>
        {lately.length > 0 && (
          <>
            Left out because they lost money lately (their last 40% of signals): <ExclusionList list={lately} />. They come back once their recent trades recover.{" "}
          </>
        )}
        <button type="button" className="tx-scr-clear" onClick={() => setOpen(true)}>
          Why {excluded.length} setups are left out
        </button>
      </p>
    );
  }
  const groups = EXCLUSION_ORDER.map((reason) => [reason, excluded.filter((entry) => entry.reason === reason)] as const).filter(([, list]) => list.length > 0);
  return (
    <div className="tx-scr-note tx-plan-leftout" title={RULE_TITLE}>
      <span>Left out of the plan in this market ({excluded.length} setups), by the test rule:</span>
      <ul>
        {groups.map(([reason, list]) => (
          <li key={reason}>
            {EXCLUSION_TEXT[reason]}: <ExclusionList list={list} />.
          </li>
        ))}
      </ul>
      {!expanded && (
        <button type="button" className="tx-scr-clear" onClick={() => setOpen(false)}>
          Hide
        </button>
      )}
    </div>
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

/** Matches whose plan the live price has left behind: listed so you know why they're gone, not to be taken. */
function InvalidList({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const shown = open ? plan.invalid : plan.invalid.slice(0, 6);
  return (
    <div className="tx-plan-unsized">
      <span className="tx-dim" title="Their plan was made at the last screener scan and no longer holds at the live price. They come back if the next scan makes a fresh plan.">
        Not valid at the live price:
      </span>
      {shown.map((idea) => (
        <button
          type="button"
          key={idea.symbol}
          className="tx-plan-chip"
          onClick={() => openIdea(idea.symbol, idea.screenId)}
          title={`${SCREEN_MAP[idea.screenId]?.name} · ${idea.entry.text}${idea.status.kind !== "ok" ? `\n${idea.status.detail}` : ""}`}
        >
          {idea.symbol} <span className={`tx-plan-status is-${idea.status.kind}`}>{idea.status.kind !== "ok" ? idea.status.label : ""}</span>
        </button>
      ))}
      {plan.invalid.length > shown.length && (
        <button type="button" className="tx-scr-clear" onClick={() => setOpen(true)}>
          +{plan.invalid.length - shown.length} more
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
  // Receipt (#29): tested period, market, net expectancy, sample, live record and a link to the report card.
  const receipt = useScreenReceipts()?.[idea.screenId] ?? null;
  const span = spanLabel(evidence.table);
  const live = liveLine(idea.screenId, evidence.live, trades);
  const { size } = idea;
  const dayPct = tick?.chp ?? idea.row.changePct;
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
          {tick && (
            <span className="tx-dim tx-plan-ltp" title={idea.entry.kind === "buy-stop" ? "A buy-stop is an order for the next session: it fills only if the price trades up to it. Nothing is bought below it." : undefined}>
              now {formatPrice(tick.ltp)}
              {idea.entry.kind === "buy-stop" && tick.ltp < idea.entry.price ? ` · ${(((idea.entry.price - tick.ltp) / tick.ltp) * 100).toFixed(1)}% below the buy-stop` : ""}
            </span>
          )}
          {Number.isFinite(dayPct) && (
            <span
              className={`tx-plan-day ${dayPct >= 0 ? "is-up" : "is-down"}`}
              title={Math.abs(dayPct) >= 3 ? `Already ${dayPct >= 0 ? "up" : "down"} ${Math.abs(dayPct).toFixed(1)}% today. The tested trades bought at the close, after the whole day's move; before 3:10 PM the move can still fade and the setup drop out.` : "Change since yesterday's close."}
            >
              {dayPct >= 0 ? "+" : ""}
              {dayPct.toFixed(1)}% today
            </span>
          )}
        </span>
        <span className="tx-plan-line2">
          {idea.entry.kind === "buy-stop" ? "buy-stop" : "entry"} ~{formatPrice(idea.entry.price)} · stop {formatPrice(idea.stop)} · exit: {exitShort(idea.exitRule, idea, idea.holdSessions)}
        </span>
        <span className="tx-plan-line3" title={`${idea.entry.text}. Exit: ${idea.exitText}.\n${idea.sampleN} trades behind the ${span} number${idea.scoreRanks ? "; within this setup, higher scores did better" : ""}.${idea.alsoMatched.length ? `\nAlso matches: ${idea.alsoMatched.map((id) => SCREEN_MAP[id]?.name).join(", ")}` : ""}`}>
          {span} {signedR(idea.expectedR)}/trade · last 12m {signedR(idea.recentR)}
          {live ? ` · ${live}` : ""}
        </span>
      </button>
      {receipt && <ReceiptLine receipt={receipt} className="tx-plan-receipt" />}
      <span className="tx-plan-actions">
        <button type="button" className="tx-icon-btn" title="Save this plan on the chart as a Long Position" onClick={() => drawPlanOnChart({ screen, row: idea.row, rr: riskReward(idea.row) })}>
          <Icons.long size={15} />
        </button>
        <TookItButton taking={taking} onClick={() => setTaking(!taking)} />
      </span>
      {taking && <TakeForm idea={idea} price={tick?.ltp ?? null} onDone={() => setTaking(false)} />}
    </li>
  );
}

function TakeForm({ idea, price, onDone }: { idea: PlanIdea; price: number | null; onDone: () => void }) {
  const [fill, setFill] = useState(String(Math.round((price ?? idea.entry.price) * 100) / 100));
  const [lots, setLots] = useState(String(Math.max(1, idea.size.lots)));
  const [date, setDate] = useState(dateValue(istParts().day));
  const [clock, setClock] = useState(clockNow);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const moment = entryMoment(date, clock);
      await takeTrade({
        symbol: idea.symbol,
        screenId: idea.screenId,
        plannedEntry: idea.entry.price,
        stop: idea.stop,
        target: idea.target,
        exitRule: idea.exitRule,
        holdSessions: idea.holdSessions,
        entryPrice: Number(fill),
        entryAt: moment.at,
        entryTimeKnown: moment.timed,
        lots: Number(lots),
        lotSize: idea.size.lot,
        notes: notes || null,
        // For the coach (#42): how the plan said to buy, and the lots it sized (0 = none).
        entryKind: idea.entry.kind,
        planLots: idea.size.status === "ok" ? idea.size.lots : 0,
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
        <input
          className="tx-input"
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            // Another day: its time isn't "now"; leave it blank unless you know it.
            if (event.target.value !== dateValue(istParts().day)) setClock("");
          }}
          required
        />
      </label>
      <label title="When the order filled (IST). Leave it blank if you don't know: the coach then won't check the 3:15–3:25 PM window for it.">
        <span>Time</span>
        <input className="tx-input" type="time" value={clock} onChange={(event) => setClock(event.target.value)} />
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

/** Your open trades and journal; in the Time Machine (a past day) they're live records, so not shown. */
function JournalColumn({ trades, error }: { trades: TradesResponse | null; error: string | null }) {
  const pastDay = useTimeMachine((state) => state.info?.label ?? state.asOf);
  if (pastDay) return <LiveOnlyNote>Your open trades, journal and coach are live records, so they aren&apos;t shown as of {pastDay}. The plan above is the one that day would have had.</LiveOnlyNote>;
  return (
    <>
      <OpenTrades trades={trades} error={error} />
      <Journal trades={trades} />
      <Coach trades={trades} />
    </>
  );
}

/** "I took it" records a real trade: off in the Time Machine (paper trading in a replay is #32). */
function TookItButton({ taking, onClick }: { taking: boolean; onClick: () => void }) {
  const pastDay = useTimeMachine((state) => state.asOf !== null);
  return (
    <button type="button" className="tx-btn-outline tx-plan-took" onClick={onClick} disabled={pastDay} title={pastDay ? "The Time Machine shows a past day: your journal holds real trades only" : "Record that you took this trade"}>
      {taking ? "Cancel" : "I took it"}
    </button>
  );
}

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

/** "Re-run this" for the evidence: the server computes its stamp again from scratch. */
const replayEvidence =
  (stamp: RunStamp) =>
  async (signal: AbortSignal): Promise<Replay> => {
    const answer = await api.replayEvidence({ stamp }, signal);
    return answer.status === "ready" ? { stamp: answer.stamp, result: { table: answer.table, note: answer.universeNote } } : { error: answer.error };
  };

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
      {evidence.stamp && (
        <RunStampBar
          key={`${evidence.stamp.hash}:${evidence.stamp.resultHash}`}
          stamp={evidence.stamp}
          result={{ table: evidence.table, note: evidence.universeNote }}
          replay={replayEvidence(evidence.stamp)}
          slow="Replaying every screen over the stored history again from scratch: about 10 seconds."
        />
      )}
    </div>
  );
}

/**
 * The evidence over the plan's window (the stored 5 years), or over a market
 * phase picked here (computed on the server in the background, back to 1994).
 * The plan itself always uses the default window.
 */
function EvidencePeriods({ evidence }: { evidence: Extract<EvidenceResponse, { status: "ready" }> }) {
  const [phaseId, setPhaseId] = useState("");
  const [answer, setAnswer] = useState<EvidenceResponse | null>(null);
  useEffect(() => {
    const phase = phaseById(phaseId);
    if (!phase) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await api.evidence({ from: phase.from, to: phase.to }).catch((error: Error): EvidenceResponse => ({ status: "error", error: error.message }));
      if (stopped) return;
      setAnswer(next);
      if (next.status === "computing") timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phaseId]);
  const phase = phaseById(phaseId);
  const shown = phase && answer?.status === "ready" ? answer : phase ? null : evidence;
  return (
    <>
      <label className="tx-plan-evidence-period">
        <span className="tx-dim">Period</span>{" "}
        <select
          className="tx-input"
          value={phaseId}
          onChange={(event) => {
            setAnswer(null);
            setPhaseId(event.target.value);
          }}
        >
          <option value="">Stored 5 years (the plan&apos;s)</option>
          {MARKET_PHASES.map((p) => (
            <option key={p.id} value={p.id} title={p.note}>
              {p.label}
            </option>
          ))}
        </select>{" "}
        {phase && <span className="tx-dim">{phase.note} Not used by the plan.</span>}
      </label>
      {shown ? (
        <EvidenceTableView evidence={shown} />
      ) : (
        <p className="tx-scr-note">
          {answer?.status === "error"
            ? `Evidence for ${phase?.label} unavailable: ${answer.error}`
            : answer?.status === "computing"
              ? `Replaying every screen over ${phase?.label} (read from the Market Data Hub's archive)… ${answer.progress.total ? `${answer.progress.done}/${answer.progress.total} sessions` : ""}`
              : `Loading ${phase?.label}…`}
        </p>
      )}
    </>
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
