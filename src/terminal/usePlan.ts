import { useMemo } from "react";
import { buildPlan, type Plan, type PlanInput } from "@/core/plan/builder";
import type { MarketState } from "@/core/plan/evidence";
import { useLotSizes } from "@/client/lotsFeed";
import { usePlanFeed } from "@/client/planFeed";
import { useScreenerFeed } from "@/client/screenerFeed";
import { useLivePrices } from "./LivePrice";
import { usePrefs } from "./uiPrefs";

// Today's plan, built in the browser from what the terminal already has: the
// screener's live matches, the strategy evidence, your open trades, the F&O
// ban list, lot sizes and your sizing settings (src/core/plan/builder.ts).
// Every candidate is re-checked on its live price, so a plan the price has
// left behind (stop broken, entry run away, buy-stop out of reach) drops out
// between screener scans instead of staying on the list.

/** NIFTY vs its 200-day average: the screener's live reading, else the last stored session's. */
export function useMarketState(): MarketState | null {
  const live = useScreenerFeed((feed) => feed.data?.regime?.niftyAbove200);
  const stored = usePlanFeed((feed) => (feed.evidence?.status === "ready" ? feed.evidence.table.lastState : null));
  if (live === true) return "up";
  if (live === false) return "down";
  return stored;
}

export function useDailyPlan(): Plan | null {
  const data = useScreenerFeed((feed) => feed.data);
  const evidence = usePlanFeed((feed) => feed.evidence);
  const trades = usePlanFeed((feed) => feed.trades);
  const lots = useLotSizes().lots;
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const maxOpen = usePrefs((prefs) => prefs.maxOpen);
  const maxLeverage = usePrefs((prefs) => prefs.maxLeverage);
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
  const symbols = useMemo(() => {
    if (!input) return [];
    const plan = buildPlan(input);
    return [...plan.ideas, ...plan.unsized, ...plan.invalid, ...plan.more.slice(0, plan.freeSlots)].map((idea) => idea.symbol);
  }, [input]);
  const prices = useLivePrices(symbols);
  return useMemo(() => (input ? buildPlan({ ...input, prices }) : null), [input, prices]);
}
