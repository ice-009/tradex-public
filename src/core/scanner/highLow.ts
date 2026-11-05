// Day high / low detection, kept free of I/O so it can be tested on its own.
//
// Each poll brings a quote per instrument with the exchange's running day
// high and low. The first quote of the day only sets the baseline (no event):
// otherwise every stock would "make a new high" the moment the terminal opens.
// After that, an event fires whenever the exchange's day high rises above the
// last one we saw (or the low falls below it) — so a break between two polls
// is still caught, even if the price has already pulled back.

export type Segment = "cash" | "fut";

export interface HLQuote {
  /** Underlying stock symbol (e.g. RELIANCE), the same for cash and futures. */
  symbol: string;
  segment: Segment;
  /** Exchange symbol, e.g. NSE:RELIANCE-EQ or NSE:RELIANCE26NOVFUT. */
  instrument: string;
  ltp: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
}

export interface HLEvent {
  seq: number;
  at: number;
  symbol: string;
  segment: Segment;
  instrument: string;
  kind: "high" | "low";
  /** The new day high / low. */
  price: number;
  /** The high / low it broke. */
  previous: number;
  ltp: number;
  /** % change vs the previous close. */
  changePct: number;
  /** How many new highs (or lows) this instrument has made today, this one included. */
  count: number;
}

interface InstrumentState {
  high: number;
  low: number;
  highs: number;
  lows: number;
}

export interface HLState {
  day: number;
  seq: number;
  instruments: Map<string, InstrumentState>;
  events: HLEvent[];
}

export const MAX_EVENTS = 1500;

export function emptyState(day: number): HLState {
  return { day, seq: 0, instruments: new Map(), events: [] };
}

/** Fold one poll's quotes into the state; returns the new events (oldest first). */
export function applyQuotes(state: HLState, quotes: HLQuote[], at: number): HLEvent[] {
  const fresh: HLEvent[] = [];
  for (const quote of quotes) {
    if (!(quote.high > 0) || !(quote.low > 0) || !(quote.ltp > 0)) continue;
    const known = state.instruments.get(quote.instrument);
    if (!known) {
      state.instruments.set(quote.instrument, { high: quote.high, low: quote.low, highs: 0, lows: 0 });
      continue;
    }
    const changePct = quote.prevClose > 0 ? ((quote.ltp - quote.prevClose) / quote.prevClose) * 100 : 0;
    if (quote.high > known.high) {
      known.highs += 1;
      state.seq += 1;
      fresh.push({ seq: state.seq, at, symbol: quote.symbol, segment: quote.segment, instrument: quote.instrument, kind: "high", price: quote.high, previous: known.high, ltp: quote.ltp, changePct, count: known.highs });
      known.high = quote.high;
    }
    if (quote.low < known.low) {
      known.lows += 1;
      state.seq += 1;
      fresh.push({ seq: state.seq, at, symbol: quote.symbol, segment: quote.segment, instrument: quote.instrument, kind: "low", price: quote.low, previous: known.low, ltp: quote.ltp, changePct, count: known.lows });
      known.low = quote.low;
    }
  }
  state.events.push(...fresh);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  return fresh;
}
