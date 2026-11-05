import "server-only";

import type { AnalyzedStock } from "@/contracts/api";
import { computeFeatures } from "@/core/screener/features";
import { rsPercentile, rsScore } from "@/core/screener/run";
import { factsFrom } from "@/core/screener/score";
import { chartPlan } from "@/core/screener/screens";
import { warningsFor } from "@/core/screener/warnings";
import type { DailyBar } from "@/core/types";
import { screenerStore } from "@/server/providers/dailyStore";
import { getUniverse } from "@/server/providers/universe";

export const MAX_ANALYZE_SYMBOLS = 20;
/** Sessions of history needed for a meaningful read. */
const MIN_BARS = 60;

/** Full read of up to 20 symbols for the Compare view: facts for the score and a chart-based plan. */
export async function analyzeSymbols(symbols: string[]): Promise<AnalyzedStock[]> {
  if (!symbols.length) return [];
  const [nifty500, fno] = await Promise.all([getUniverse("nifty500"), getUniverse("fno")]);
  const members = new Map([...nifty500, ...fno].map((member) => [member.symbol, member]));
  // RS ranks against everything cached, so a lone symbol still gets a fair percentile.
  const peers = [...members.keys()];
  await screenerStore.hasData([...peers, ...symbols]);
  const peerScores = peers.map((symbol) => rsScore(screenerStore.getBars(symbol))).filter(Number.isFinite).sort((a, b) => a - b);
  const live = await screenerStore.getLiveBars(symbols.filter((symbol) => screenerStore.getBars(symbol).length > 0)).catch(() => new Map<string, DailyBar>());

  return symbols.map((symbol) => {
    const member = members.get(symbol);
    const base = { symbol, name: member?.name ?? symbol, industry: member?.industry ?? "" };
    const stored = screenerStore.getBars(symbol);
    if (stored.length < MIN_BARS) return { ...base, missing: true };
    const today = live.get(symbol);
    const bars = today ? [...stored, today] : stored;
    const f = computeFeatures(symbol, bars, Boolean(today));
    f.rsRank = rsPercentile(rsScore(bars), peerScores);
    return { ...base, live: f.live, date: f.date, close: f.close, changePct: f.changePct, facts: factsFrom(f), plan: chartPlan(f), warnings: warningsFor(f) };
  });
}
