import { useMemo } from "react";
import type { RiskReturnsResponse, TradesResponse } from "@/contracts/api";
import { buildPlan, type Plan, type PlanInput } from "@/core/plan/builder";
import type { MarketState } from "@/core/plan/evidence";
import { riskPosition, type RiskPosition } from "@/core/risk/exposure";
import { buildRiskModel, type RiskModel } from "@/core/risk/model";
import { useLotSizes } from "@/client/lotsFeed";
import { usePlanFeed } from "@/client/planFeed";
import { useRiskReturns } from "@/client/riskFeed";
import { useScreenerFeed } from "@/client/screenerFeed";
import { useLivePrices } from "./LivePrice";
import { usePrefs } from "./uiPrefs";

// Today's plan, built in the browser from what the terminal already has: the
// screener's live matches, the strategy evidence, your open trades, the F&O
// ban list, lot sizes and your sizing settings (src/core/plan/builder.ts).
// Every candidate is re-checked on its live price, so a plan the price has
// left behind (stop broken, entry run away, buy-stop out of reach) drops out
// between screener scans instead of staying on the list.
//
// The risk model (issue #40: correlations, beta, sector) is built from the
// daily returns of the open trades and the stocks the plan shows; with
// correlation-aware sizing switched on it also sizes the plan.

/** NIFTY vs its 200-day average: the screener's live reading, else the last stored session's. */
export function useMarketState(): MarketState | null {
  const live = useScreenerFeed((feed) => feed.data?.regime?.niftyAbove200);
  const stored = usePlanFeed((feed) => (feed.evidence?.status === "ready" ? feed.evidence.table.lastState : null));
  if (live === true) return "up";
  if (live === false) return "down";
  return stored;
}

/** What the exposure view needs besides the plan: the risk model and your open trades as positions. */
export interface PlanRisk {
  returns: RiskReturnsResponse | null;
  model: RiskModel | null;
  open: RiskPosition[];
  /** Industry per stock: the screener's, else the returns answer's. */
  industries: Record<string, string>;
}

/** Spare candidates beyond the free slots whose returns are loaded too (correlation sizing can skip ideas and pull these in). */
const RISK_SPARES = 5;

/** Open trades as positions at their last known price (the tracker's: live-checked close), risk to their stops. */
function openPositions(trades: TradesResponse | null, industries: Record<string, string>): RiskPosition[] {
  return (trades?.trades ?? [])
    .filter((trade) => trade.status === "open")
    .map((trade) =>
      riskPosition({ symbol: trade.symbol, kind: "open", industry: industries[trade.symbol] ?? "", qty: trade.quantity, price: trades?.tracks[trade.id]?.price ?? trade.entryPrice, stop: trade.stop }),
    );
}

/** The plan and its risk model; returns are loaded when `withRisk` (the exposure view is shown) or correlation sizing is on. */
export function usePlanWithRisk(withRisk = true): { plan: Plan | null; risk: PlanRisk } {
  const data = useScreenerFeed((feed) => feed.data);
  const evidence = usePlanFeed((feed) => feed.evidence);
  const trades = usePlanFeed((feed) => feed.trades);
  const lots = useLotSizes().lots;
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const maxOpen = usePrefs((prefs) => prefs.maxOpen);
  const maxLeverage = usePrefs((prefs) => prefs.maxLeverage);
  const corrSizing = usePrefs((prefs) => prefs.corrSizing);
  const maxCorrelatedRisk = usePrefs((prefs) => prefs.maxCorrRisk);
  const threshold = usePrefs((prefs) => prefs.corrThreshold);
  const state = useMarketState();
  const input = useMemo((): PlanInput | null => {
    if (evidence?.status !== "ready" || data?.status !== "ready" || !data.results) return null;
    const open = (trades?.trades ?? []).filter((trade) => trade.status === "open").map((trade) => ({ symbol: trade.symbol, notional: trade.entryPrice * trade.quantity }));
    return {
      results: data.results,
      evidence: evidence.table.screens,
      state,
      banned: new Set(data.ban?.available ? data.ban.symbols : []),
      open,
      lots,
      settings: { capital, riskPct, maxOpen, maxLeverage },
    };
  }, [data, evidence, trades, lots, capital, riskPct, maxOpen, maxLeverage, state]);
  // The stocks the plan shows (checked at their scan close) plus enough of the
  // overflow to refill every slot, then the plan again on their live prices.
  const { symbols, riskSymbols } = useMemo(() => {
    if (!input) return { symbols: [], riskSymbols: [] };
    const plan = buildPlan(input);
    const shown = [...plan.ideas, ...plan.unsized, ...plan.invalid, ...plan.more.slice(0, plan.freeSlots)].map((idea) => idea.symbol);
    const spares = plan.more.slice(plan.freeSlots, plan.freeSlots + RISK_SPARES).map((idea) => idea.symbol);
    return { symbols: shown, riskSymbols: [...new Set([...input.open.map((position) => position.symbol), ...plan.ideas.map((idea) => idea.symbol), ...plan.more.slice(0, plan.freeSlots).map((idea) => idea.symbol), ...spares])] };
  }, [input]);
  const prices = useLivePrices(symbols);

  const returns = useRiskReturns(withRisk || corrSizing ? riskSymbols : []);
  const screenerIndustry = useMemo(() => Object.fromEntries(Object.values(data?.results ?? {}).flatMap((rows) => rows.map((row) => [row.symbol, row.industry] as const))), [data]);
  const risk = useMemo((): PlanRisk => {
    const ready = returns?.status === "ready" ? returns : null;
    const industries = { ...(ready?.industries ?? {}), ...Object.fromEntries(Object.entries(screenerIndustry).filter(([, industry]) => industry)) };
    const model = ready ? buildRiskModel(ready) : null;
    return { returns, model, open: openPositions(trades, industries), industries };
  }, [returns, screenerIndustry, trades]);

  const plan = useMemo(() => {
    if (!input) return null;
    const correlation = corrSizing
      ? { model: risk.model, maxCorrelatedRisk, threshold, open: risk.open.map((position) => ({ symbol: position.symbol, industry: position.industry, kind: position.kind, risk: position.risk })) }
      : undefined;
    return buildPlan({ ...input, prices, correlation });
  }, [input, prices, corrSizing, risk, maxCorrelatedRisk, threshold]);
  return { plan, risk };
}

export function useDailyPlan(): Plan | null {
  return usePlanWithRisk(false).plan;
}
