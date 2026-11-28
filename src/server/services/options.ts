import "server-only";

import type { OptionRange, OptionsDayResponse, OptionsDayRow, OptionsResponse } from "@/contracts/api";
import { DAY_MS, istParts } from "@/core/market/session";
import { impliedMove, ivRank, optionPoint, optionView, skewOf, throughDay } from "@/core/options/summary";
import { dayLabel, isoDay } from "@/core/reference/timeMachine";
import { toHubSymbol } from "@/server/data/sources/hub";
import { optionCrossSection, optionHistory } from "@/server/providers/options";
import { dayNotes, type PastDay } from "@/server/services/timeMachine";

// The Options panel (issue #36): an underlying's option summaries from the
// Market Data Hub — the newest day in full (term structure, skew, the move the
// straddle prices, max pain and the OI walls) and its IV history — and the
// day's cross-section of every underlying. As of today, or of the Time
// Machine's day: the hub is asked for nothing after that day (`to`, `date`),
// and what it sends is cut at it again here (`throughDay`).

/** NSE's first option day (index options, 4 Jun 2001). */
export const OPTIONS_START = "2001-06-04";
const RANGE_DAYS: Record<OptionRange, number | null> = { "1y": 365, "5y": 5 * 365 + 1, all: null };
/** The newest option day older than this before the day shown gets a note (a week of holidays at most). */
const STALE_DAYS = 7;
const FUTURE = /^([A-Z0-9&_-]+)\d{2}[A-Z]{3}FUT$/;

export const parseOptionRange = (raw: string | null | undefined): OptionRange => (raw === "5y" || raw === "all" ? raw : "1y");

/** The hub's ticker of the underlying: a future's stock or index; null for what the hub doesn't serve (BSE). */
export function optionUnderlying(symbol: string): string | null {
  const hub = toHubSymbol(symbol);
  if (!hub) return null;
  return FUTURE.exec(hub)?.[1] ?? hub;
}

/** An underlying's option summaries up to today, or up to the Time Machine's day (`past`). */
export async function optionsFor(rawSymbol: string, range: OptionRange, past: PastDay | null, today = istParts().day): Promise<OptionsResponse> {
  const asOf = past ? { asOf: dayNotes(past) } : {};
  const symbol = optionUnderlying(rawSymbol);
  if (!symbol) return { status: "empty", symbol: rawSymbol, range, message: `${rawSymbol} has no NSE options.`, knownFrom: null, lastDate: null, ...asOf };
  const through = past?.day ?? today;
  const days = RANGE_DAYS[range];
  const from = days === null ? OPTIONS_START : isoDay(Math.max(Date.parse(`${OPTIONS_START}T00:00:00Z`), through - days * DAY_MS));
  const answer = await optionHistory(symbol, from, isoDay(through), Boolean(past));
  if (!answer.ok) return { status: "unavailable", symbol, reason: answer.reason, message: answer.message, ...asOf };

  const { knownFrom } = answer.value;
  const lastDate = past ? null : answer.value.lastDate;
  const known = throughDay(answer.value.days ?? [], through);
  const day = known.at(-1);
  if (!day) {
    const span = `${dayLabel(Date.parse(`${from}T00:00:00Z`))} – ${dayLabel(through)}`;
    const message = knownFrom && Date.parse(`${knownFrom}T00:00:00Z`) > through
      ? `The hub's option summaries start on ${dayLabel(Date.parse(`${knownFrom}T00:00:00Z`))}, after ${dayLabel(through)}: its archive isn't read that far back yet (\`hub data nse-history --only options\`).`
      : `No option summaries for ${symbol} over ${span}: it had no listed options then, or it isn't an F&O underlying.`;
    return { status: "empty", symbol, range, message, knownFrom, lastDate, ...asOf };
  }

  const notes: string[] = [];
  if (through - day.day > STALE_DAYS * DAY_MS) notes.push(`The newest option day for ${symbol} on or before ${dayLabel(through)} is ${dayLabel(day.day)}.`);
  if (day.ticker && day.ticker !== symbol) notes.push(`Traded as ${day.ticker} that day.`);
  notes.push(`Strikes, forward, straddle and levels are in prices as traded on ${dayLabel(day.day)}${past ? "" : " (a later split or bonus isn't applied to them)"}.`);
  return { status: "ready", symbol, range, day, view: optionView(day), rank: ivRank(known, day.day), history: known.map(optionPoint), knownFrom, lastDate, notes, ...asOf };
}

/** Every underlying's option summary on the newest stored day on or before today / the Time Machine's day. */
export async function optionsDayFor(kind: "stock" | "index" | null, past: PastDay | null, today = istParts().day): Promise<OptionsDayResponse> {
  const asOf = past ? { asOf: dayNotes(past) } : {};
  const through = past?.day ?? today;
  const answer = await optionCrossSection(isoDay(through), Boolean(past));
  if (!answer.ok) return { status: "unavailable", reason: answer.reason, message: answer.message, ...asOf };
  // The hub answers the newest day on or before the date; one after it (a hub ignoring `date`) is refused, not shown.
  if (!(answer.value.day <= through)) return { status: "unavailable", reason: "not_found", message: `No option summaries stored on or before ${dayLabel(through)}.`, ...asOf };
  const rows: OptionsDayRow[] = (answer.value.rows ?? [])
    .filter((row) => !kind || row.kind === kind)
    .map((row) => {
      const move = impliedMove(row.near);
      return {
        symbol: row.symbol,
        kind: row.kind,
        spot: row.spot,
        iv30: row.iv30,
        ivPercentile: row.ivPercentile,
        nearIv: row.near?.atmIv ?? null,
        movePct: move?.pct ?? null,
        moveDays: move?.days ?? null,
        pcrOi: row.pcrOi,
        skew25: skewOf(row)?.skew25 ?? null,
        optionToStock: row.optionToStock,
      };
    });
  const notes: string[] = [];
  if (through - answer.value.day > STALE_DAYS * DAY_MS) notes.push(`The newest option day on or before ${dayLabel(through)} is ${dayLabel(answer.value.day)}.`);
  return { status: "ready", day: answer.value.day, date: isoDay(answer.value.day), rows, notes, ...asOf };
}
