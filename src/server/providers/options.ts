import "server-only";

import { optionFact, type OptionFact } from "@/core/options/summary";
import { hubClient, HubError, type HubOptionDay, type HubOptionSummary } from "@/server/providers/hub";
import { log } from "@/server/log";

// Daily option summaries from the Market Data Hub (issue #36; computed by
// market-data-hub#30 from NSE's F&O bhavcopy, back to June 2001):
//
//   one underlying, day by day   GET /v1/options/summary?symbol&from&to
//   every underlying on a day     GET /v1/options/day?date&kind
//
// Both change once a day (the evening's F&O file), so answers are kept in
// memory: 30 minutes for a range ending today, 6 hours for one ending on a
// past day (only a backfill on the hub changes those). Callers always pass the
// last day they may see (`to`, `date`): the Time Machine's day, or today.
//
// A hub that can't answer says why, and the panel shows it: no hub, a hub too
// old to have the endpoints (404), a hub with nothing stored yet (not_ready:
// the evening run or `hub data nse-history --only options` fills it), or
// another error. Those answers are kept for a minute, so an old hub isn't
// asked on every click.

export type OptionsProblemReason = "no_hub" | "old_hub" | "not_ready" | "not_found" | "error";

export type HubAnswer<T> = { ok: true; value: T } | { ok: false; reason: OptionsProblemReason; message: string };

const LIVE_TTL_MS = 30 * 60 * 1000;
const PAST_TTL_MS = 6 * 60 * 60 * 1000;
const PROBLEM_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 64;

export const OPTIONS_MESSAGES = {
  no_hub: "Option summaries come from a Market Data Hub, and none is connected.",
  old_hub: "This Market Data Hub doesn't serve option summaries yet (it answered 404 for /v1/options): update it to a version with market-data-hub#30 and restart it.",
  not_ready:
    "The Market Data Hub has no option summaries stored yet. They come with each evening's F&O file; for the history back to 2001, run `hub data nse-history --only options` on the hub (about two hours).",
} as const;

/** What a failed hub request means for the Options panel. `endpoint` says which one was asked (a 404 means different things). */
export function classifyOptionsError(caught: unknown, endpoint: "summary" | "day"): { reason: OptionsProblemReason; message: string } {
  // By shape as well as class: a HubError from another copy of the module (tests, hot reload) is still one.
  if (!(caught instanceof HubError) && (caught as Error | null)?.name !== "HubError") return { reason: "error", message: (caught as Error)?.message ?? String(caught) };
  const error = caught as HubError;
  const detail = typeof (error.body as { error?: unknown } | null)?.error === "string" ? ((error.body as { error: string }).error) : "";
  if (error.status === 503 && error.code === "not_ready") return { reason: "not_ready", message: OPTIONS_MESSAGES.not_ready };
  if (error.status === 404) {
    // /v1/options/day answers 404 when nothing is stored on or before the date; any other 404 is a hub without the route.
    if (endpoint === "day" && /^No option summaries/i.test(detail)) return { reason: "not_found", message: detail };
    return { reason: "old_hub", message: OPTIONS_MESSAGES.old_hub };
  }
  if (error.status === 403) return { reason: "error", message: `The hub key can't read option summaries: it needs the "fo" scope (${detail || error.code}).` };
  return { reason: "error", message: error.message };
}

interface Entry<T> {
  at: number;
  ttl: number;
  answer: HubAnswer<T> | null;
  pending: Promise<HubAnswer<T>> | null;
}

const globalForOptions = globalThis as unknown as { hubOptions?: Map<string, Entry<unknown>> };
const entries = (globalForOptions.hubOptions ??= new Map());

/** The cached answer for `key` (refreshed when stale): awaited when `wait`, else whatever is held (null the first time). */
function cached<T>(key: string, ttl: number, load: () => Promise<T>, endpoint: "summary" | "day", wait: boolean): Promise<HubAnswer<T>> | HubAnswer<T> | null {
  let entry = entries.get(key) as Entry<T> | undefined;
  if (!entry) {
    entry = { at: 0, ttl, answer: null, pending: null };
    entries.set(key, entry as Entry<unknown>);
    for (const old of [...entries.keys()].slice(0, Math.max(0, entries.size - MAX_ENTRIES))) entries.delete(old);
  }
  const current = entry;
  const stale = Date.now() - current.at > (current.answer?.ok ? current.ttl : PROBLEM_TTL_MS);
  if (stale && !current.pending) {
    current.pending = Promise.resolve()
      .then(load)
      .then((value): HubAnswer<T> => ({ ok: true, value }))
      .catch((error: unknown): HubAnswer<T> => {
        const problem = classifyOptionsError(error, endpoint);
        if (problem.reason === "error") log.warn("option summaries from the Market Data Hub failed", { key, error: problem.message });
        return { ok: false, ...problem };
      })
      .then((answer) => {
        // A failed refresh keeps a good earlier answer (it is still the right one for that day).
        if (answer.ok || !current.answer?.ok) current.answer = answer;
        return current.answer!;
      })
      .finally(() => {
        current.at = Date.now();
        current.pending = null;
      });
  }
  if (!wait) return current.answer;
  if (current.answer && !stale) return Promise.resolve(current.answer);
  return current.pending ?? Promise.resolve(current.answer!);
}

const noHub = <T>(): HubAnswer<T> => ({ ok: false, reason: "no_hub", message: OPTIONS_MESSAGES.no_hub });

/**
 * One underlying's option summaries from `from` to `to` (YYYY-MM-DD, inclusive).
 * `past`: `to` is a past day (cached longer). The answer is the hub's; callers
 * still cut it at `to` (`throughDay`).
 */
export async function optionHistory(symbol: string, from: string, to: string, past: boolean): Promise<HubAnswer<HubOptionSummary>> {
  const hub = hubClient();
  if (!hub) return noHub();
  return cached(`summary:${symbol}:${from}:${to}`, past ? PAST_TTL_MS : LIVE_TTL_MS, () => hub.optionSummary(symbol, { from, to }), "summary", true)!;
}

/** Every underlying on the newest stored option day on or before `date` (YYYY-MM-DD). */
export async function optionCrossSection(date: string, past: boolean): Promise<HubAnswer<HubOptionDay>> {
  const hub = hubClient();
  if (!hub) return noHub();
  return cached(`day:${date}`, past ? PAST_TTL_MS : LIVE_TTL_MS, () => hub.optionDay({ date }), "day", true)!;
}

/** The screener's option facts: per symbol, on the newest stored day on or before `date`. */
export interface OptionFacts {
  day: number;
  bySymbol: Map<string, OptionFact>;
}

const factsByDate = new Map<string, { source: HubOptionDay; facts: OptionFacts }>();

function factsOf(date: string, answer: HubAnswer<HubOptionDay> | null): OptionFacts | null {
  if (!answer?.ok) return null;
  const held = factsByDate.get(date);
  if (held?.source === answer.value) return held.facts;
  const bySymbol = new Map<string, OptionFact>();
  for (const row of answer.value.rows ?? []) {
    const fact = row.day <= Date.parse(`${date}T00:00:00Z`) ? optionFact(row) : null;
    if (fact) bySymbol.set(row.symbol, fact);
  }
  const facts = { day: answer.value.day, bySymbol };
  factsByDate.set(date, { source: answer.value, facts });
  for (const old of [...factsByDate.keys()].slice(0, Math.max(0, factsByDate.size - 8))) factsByDate.delete(old);
  return facts;
}

/**
 * Option facts for the screener's rows as of `date` (YYYY-MM-DD: today, or the
 * Time Machine's day). Never waits: null until the hub has answered (the next
 * screener run has them), or when it can't.
 */
export function optionFactsNow(date: string, past: boolean): OptionFacts | null {
  const hub = hubClient();
  if (!hub) return null;
  return factsOf(date, cached(`day:${date}`, past ? PAST_TTL_MS : LIVE_TTL_MS, () => hub.optionDay({ date }), "day", false) as HubAnswer<HubOptionDay> | null);
}

/** Like optionFactsNow, but waits up to `ms` for a first answer (the Time Machine's one-off screener runs). */
export async function optionFactsWithin(date: string, past: boolean, ms: number): Promise<OptionFacts | null> {
  if (!hubClient()) return null;
  const pending = optionCrossSection(date, past);
  const answer = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
  return factsOf(date, answer);
}
