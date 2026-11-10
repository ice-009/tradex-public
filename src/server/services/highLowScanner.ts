import "server-only";

import type { HighLowResponse, ScanStatus } from "@/contracts/api";

import { sweepIntervalMs } from "@/core/ratelimit/budget";
import type { Tick } from "@/contracts/api";
import { dataEngine, marketStream } from "@/server/data";
import { asPriority, budgetFor, planLimits } from "@/server/providers/marketBudget";
import { getUniverse } from "@/server/providers/universe";
import { applyQuotes, emptyState, type HLEvent, type HLQuote, type HLState } from "@/core/scanner/highLow";
import { nearMonthFuture } from "@/core/market/futures";
import { SESSION_CLOSE_MIN, SESSION_OPEN_MIN, istParts } from "@/core/market/session";

// Day high / low scanner for every F&O stock, cash and near-month futures.
//
// Cash + futures for the F&O list is ~440 instruments — more than the data
// socket carries (100 symbols on Fyers Standard) — so a background sweep reads
// them through the quotes API (50 per call on Standard → ~9 calls a sweep).
// The sweep's pace comes from the request budget: Standard allows 5,000 data
// calls a day, so it spreads what's left of the background share over the rest
// of the session (about every 1½ minutes) instead of burning the day by noon.
// A late sweep loses nothing: quotes carry the day's high and low, so a new
// extreme is still caught, just later. Symbols on the live socket (open charts,
// the top of the watchlist) are checked on every tick, so those are instant.
//
// It runs only during market hours and only while someone has the terminal
// open (a client asked within the last 90 s), then goes idle.

const MIN_SWEEP_MS = 20_000;
const IDLE_AFTER_MS = 90_000;


interface Service {
  state: HLState;
  lastClientAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  status: ScanStatus;
  instruments: number;
  lastPollAt: number;
  /** Per symbol: months ahead for its futures contract (bumped when a contract stops quoting). */
  futOffset: Map<string, number>;
  /** Polls in a row a futures contract returned nothing. */
  futMisses: Map<string, number>;
  /** Current near-month contract → underlying, from the last sweep. */
  futureOf: Map<string, string>;
  /** F&O stocks (cash symbols) being scanned. */
  cash: Set<string>;
  /** Delay before the next sweep (ms); null when the day's budget is spent. */
  sweepMs: number | null;
  listening: boolean;
}

const globalForHL = globalThis as unknown as { highLow?: Service };
const service: Service = (globalForHL.highLow ??= {
  state: emptyState(istParts().day),
  lastClientAt: 0,
  timer: null,
  running: false,
  status: "starting",
  instruments: 0,
  lastPollAt: 0,
  futOffset: new Map(),
  futMisses: new Map(),
  futureOf: new Map(),
  cash: new Set(),
  sweepMs: MIN_SWEEP_MS,
  listening: false,
});
// Fields added after a hot reload kept an older object.
service.futureOf ??= new Map();
service.cash ??= new Set();
service.sweepMs ??= MIN_SWEEP_MS;

async function poll() {
  const { day, minutes, weekday } = istParts();
  if (service.state.day !== day) {
    service.state = emptyState(day);
    service.futOffset.clear();
    service.futMisses.clear();
  }
  // One extra poll just after the close captures the final high/low.
  if (weekday === 0 || weekday === 6 || minutes < SESSION_OPEN_MIN || minutes > SESSION_CLOSE_MIN + 1) {
    service.status = "closed";
    return;
  }
  // Needs live broker quotes (an end-of-day close can't make a new intraday high).
  const engine = dataEngine();
  const brokers = engine.sources.filter((source) => source.kind === "broker" && source.quotes);
  if (!(await Promise.all(brokers.map((source) => engine.unavailable(source)))).some((reason) => reason === null)) {
    service.status = "no-broker";
    return;
  }
  const fno = (await getUniverse("fno")).map((member) => member.symbol);
  const futureOf = new Map(fno.map((symbol) => [nearMonthFuture(symbol, day, service.futOffset.get(symbol) ?? 0), symbol]));
  const instruments = [...fno, ...futureOf.keys()];
  service.instruments = instruments.length;
  service.futureOf = futureOf;
  service.cash = new Set(fno);
  const quotes = await asPriority("background", () => engine.quotes(instruments, { maxAgeMs: MIN_SWEEP_MS / 2, kinds: ["broker"] }));

  const seen = new Set(quotes.map((quote) => quote.symbol));
  const hlQuotes: HLQuote[] = quotes.map((quote) => {
    const underlying = futureOf.get(quote.symbol);
    return {
      symbol: underlying ?? quote.symbol,
      segment: underlying ? "fut" : "cash",
      instrument: underlying ? quote.symbol : `NSE:${quote.symbol}-EQ`,
      ltp: quote.ltp,
      high: quote.high,
      low: quote.low,
      open: quote.open,
      prevClose: quote.prevClose,
    };
  });
  // A contract that never quotes has likely expired early (holiday): move that stock to next month.
  for (const [instrument, symbol] of futureOf) {
    if (seen.has(instrument)) {
      service.futMisses.delete(symbol);
      continue;
    }
    const misses = (service.futMisses.get(symbol) ?? 0) + 1;
    service.futMisses.set(symbol, misses);
    if (misses >= 3 && (service.futOffset.get(symbol) ?? 0) === 0) {
      service.futOffset.set(symbol, 1);
      service.futMisses.delete(symbol);
    }
  }
  applyQuotes(service.state, hlQuotes, Date.now());
  service.lastPollAt = Date.now();
  service.status = "live";

  // Pace the next sweep from what's left of today's background budget.
  const background = budgetFor("background");
  service.sweepMs = sweepIntervalMs({
    requestsPerSweep: Math.ceil(instruments.length / planLimits().limits.quoteBatch),
    remainingToday: background.remainingToday,
    minutesLeft: SESSION_CLOSE_MIN - minutes,
    backgroundPerMinute: background.perMinute,
    minMs: MIN_SWEEP_MS,
  });
}

/** Ticks from the market stream (charts, watchlist): check them for a new high/low immediately, no API call. */
function onTick(tick: Tick) {
  if (service.status !== "live" || !(tick.high > 0) || !(tick.low > 0)) return;
  // Futures arrive under their contract symbol (NSE:SBIN26NOVFUT); cash under the stock's symbol.
  const underlying = service.futureOf.get(tick.symbol);
  const cash = !underlying && service.cash.has(tick.symbol);
  if (!underlying && !cash) return;
  applyQuotes(
    service.state,
    [{ symbol: underlying ?? tick.symbol, segment: underlying ? "fut" : "cash", instrument: underlying ? tick.symbol : `NSE:${tick.symbol}-EQ`, ltp: tick.ltp, high: tick.high, low: tick.low, open: tick.open, prevClose: tick.prevClose }],
    Date.now(),
  );
}

function schedule() {
  if (service.timer) return;
  // Budget spent for today: stop sweeping (socket ticks still count); check again in 5 minutes.
  const delay = service.sweepMs ?? 5 * 60_000;
  service.timer = setTimeout(async () => {
    service.timer = null;
    if (Date.now() - service.lastClientAt > IDLE_AFTER_MS) {
      service.running = false;
      return;
    }
    try {
      await poll();
    } catch (error) {
      console.error("High/low scan failed", error);
    }
    schedule();
  }, delay);
}

/** Called by the API on every client request: keeps the scanner running and returns events after `after`. */
export async function readHighLow(after: number): Promise<HighLowResponse> {
  service.lastClientAt = Date.now();
  if (!service.listening) {
    service.listening = true;
    marketStream().onTick(onTick);
  }
  if (!service.running) {
    service.running = true;
    try {
      await poll();
    } catch (error) {
      console.error("High/low scan failed", error);
    }
    schedule();
  }
  const events: HLEvent[] = service.state.events.filter((event) => event.seq > after).slice(-300);
  const highs = service.state.events.filter((event) => event.kind === "high").length;
  return {
    status: service.status,
    day: service.state.day,
    seq: service.state.seq,
    instruments: service.instruments,
    lastPollAt: service.lastPollAt,
    sweepMs: service.status === "live" ? service.sweepMs : null,
    totals: { highs, lows: service.state.events.length - highs },
    events,
  };
}
