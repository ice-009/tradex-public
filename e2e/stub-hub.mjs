// A deterministic stand-in for the Market Data Hub (github.com/ice-009/market-data-hub),
// for the end-to-end tests. It serves the /v1 endpoints Tradex calls
// (src/server/providers/hub/client.ts) from generated fixture data:
//
//  - Every symbol gets the same candles on every run: a seeded random walk
//    (seed = the ticker) over weekdays ending on a FIXED last session,
//    2026-11-13. Requests are answered as if made at FROZEN_NOW (the Saturday
//    after): Tradex asks for "the last 5 years" from the real clock, and the
//    stub moves that window back by however long it is since FROZEN_NOW, so
//    every run, today or in three years, gets the same bars.
//  - Quotes are the last daily bar, marked stale (the hub's stored price, as on
//    a weekend): Tradex shows them but builds no intraday bar from them.
//  - The stream sends a status event and heartbeats, never a tick.
//
// Usage: node e2e/stub-hub.mjs  (STUB_HUB_PORT, default 8797; STUB_HUB_KEY, default "mdh_e2e")

import { createServer } from "node:http";

const PORT = Number(process.env.STUB_HUB_PORT || 8797);
const KEY = process.env.STUB_HUB_KEY || "mdh_e2e";

const DAY = 86_400_000;
/** The last trade day in the fixture (a Friday), as the hub keys daily bars: UTC midnight of the IST date. */
const LAST_SESSION = Date.UTC(2026, 10, 13);
const FIRST_SESSION = Date.UTC(2021, 10, 15);
/** The moment the fixture is "now": Saturday 2026-11-14, 12:00 IST (the e2e tests freeze the browser clock here too). */
const FROZEN_NOW = Date.UTC(2026, 10, 14, 6, 30);
/** A `from` (epoch ms) computed from the real clock, as it would have been at FROZEN_NOW. */
const asOfFrozen = (from) => from - Math.max(0, Date.now() - FROZEN_NOW);
/** 09:15 IST in UTC. */
const OPEN_UTC_MS = (3 * 60 + 45) * 60_000;
const SESSION_MINUTES = 375;

/** The F&O list the stub serves (≥ 50, so Tradex uses it instead of its snapshot). */
const FNO = [
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BEL", "BHARTIARTL",
  "BPCL", "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DLF", "DRREDDY", "EICHERMOT", "GAIL", "GRASIM",
  "HAL", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "INDUSINDBK", "INFY",
  "IOC", "ITC", "JSWSTEEL", "KOTAKBANK", "LT", "LUPIN", "M&M", "MARUTI", "NESTLEIND", "NTPC",
  "ONGC", "PIDILITIND", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN", "SHREECEM", "SIEMENS", "SUNPHARMA", "TATACONSUM",
  "TATAPOWER", "TATASTEEL", "TCS", "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "UPL", "VEDL", "WIPRO",
];
const INDICES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "NIFTYIT", "INDIAVIX"]);
const FUTURE = /^([A-Z0-9&_-]+)\d{2}[A-Z]{3}FUT$/;
const NEAR_EXPIRY = "2026-11-24";
const NEXT_EXPIRY = "2026-12-29";

// ------------------------------------------------------------------ fixture data

function hash(text) {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value) => Math.round(value * 20) / 20; // ₹0.05 ticks

const SESSIONS = (() => {
  const days = [];
  for (let t = FIRST_SESSION; t <= LAST_SESSION; t += DAY) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(t);
  }
  return days;
})();

const dailyCache = new Map();

/** Five years of daily bars: a random walk with slow-changing drift, so screens find trends, pullbacks and breakouts. */
function daily(symbol) {
  const underlying = FUTURE.exec(symbol)?.[1] ?? symbol;
  const key = `${underlying}:${symbol === underlying ? "" : "fut"}`;
  const cached = dailyCache.get(key);
  if (cached) return cached;
  const rand = random(hash(underlying));
  const index = INDICES.has(underlying);
  let price = index ? 12_000 + rand() * 20_000 : 80 + rand() * 3_000;
  const vol = index ? 0.009 : 0.012 + rand() * 0.012;
  let drift = 0;
  const baseVolume = index ? 0 : Math.round(200_000 + rand() * 5_000_000);
  const bars = SESSIONS.map((t, i) => {
    if (i % 40 === 0) drift = (rand() - 0.45) * 0.004;
    const open = price * (1 + (rand() - 0.5) * vol * 0.6);
    const close = open * (1 + drift + (rand() - 0.5) * 2 * vol);
    const high = Math.max(open, close) * (1 + rand() * vol * 0.7);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.7);
    price = close;
    const v = index ? 0 : Math.round(baseVolume * (0.5 + rand() * 1.5) * (Math.abs(close - open) / open > vol ? 1.8 : 1));
    return { t, o: round(open), h: round(high), l: round(low), c: round(close), v, dp: index ? null : Math.round(25 + rand() * 50) };
  });
  // A future trades at a small premium to its stock.
  const series = symbol === underlying ? bars : bars.map((bar) => ({ ...bar, o: round(bar.o * 1.004), h: round(bar.h * 1.004), l: round(bar.l * 1.004), c: round(bar.c * 1.004), dp: null }));
  dailyCache.set(key, series);
  return series;
}

/** Intraday bars for the last sessions, built from each day's bar (path: open → one extreme → the other → close). */
function intraday(symbol, minutes, sessions) {
  const days = daily(symbol).slice(-sessions);
  const out = [];
  for (const day of days) {
    const rand = random(hash(`${symbol}:${day.t}:${minutes}`));
    const count = Math.ceil(SESSION_MINUTES / minutes);
    const highFirst = rand() < 0.5;
    const turn1 = Math.floor(count * (0.2 + rand() * 0.3));
    const turn2 = Math.floor(turn1 + (count - turn1) * (0.3 + rand() * 0.4));
    const path = [day.o, highFirst ? day.h : day.l, highFirst ? day.l : day.h, day.c];
    const at = (step) => {
      const [from, to, a, b] = step <= turn1 ? [path[0], path[1], 0, turn1] : step <= turn2 ? [path[1], path[2], turn1, turn2] : [path[2], path[3], turn2, count];
      return from + ((to - from) * (step - a)) / Math.max(1, b - a);
    };
    for (let k = 0; k < count; k += 1) {
      const open = at(k);
      const close = at(k + 1);
      const wiggle = (day.h - day.l) * 0.05 * rand();
      out.push({
        t: day.t + OPEN_UTC_MS + k * minutes * 60_000,
        o: round(open),
        h: round(Math.min(day.h, Math.max(open, close) + wiggle)),
        l: round(Math.max(day.l, Math.min(open, close) - wiggle)),
        c: round(close),
        v: Math.round(day.v / count),
      });
    }
  }
  return out;
}

function weekly(symbol) {
  const weeks = new Map();
  for (const bar of daily(symbol)) {
    const weekday = (new Date(bar.t).getUTCDay() + 6) % 7; // Monday = 0
    const monday = bar.t - weekday * DAY;
    const week = weeks.get(monday);
    if (!week) weeks.set(monday, { t: monday, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    else Object.assign(week, { h: Math.max(week.h, bar.h), l: Math.min(week.l, bar.l), c: bar.c, v: week.v + bar.v });
  }
  return [...weeks.values()];
}

const INTRADAY = { "1h": [60, 120], "15m": [15, 60], "5m": [5, 20], "1m": [1, 5] };

function candlesFor(symbol, tf) {
  if (tf === "1d") return daily(symbol);
  if (tf === "1w") return weekly(symbol);
  const spec = INTRADAY[tf];
  return spec ? intraday(symbol, spec[0], spec[1]) : null;
}

const known = (symbol) => /^[A-Z0-9][A-Z0-9&_-]{0,19}$/.test(symbol);

function quote(symbol) {
  const bars = daily(symbol);
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const ch = round(last.c - prev.c);
  // 15:30 IST on the last session.
  const ltt = last.t + OPEN_UTC_MS + SESSION_MINUTES * 60_000;
  return { symbol, ltp: last.c, ch, chp: Math.round((ch / prev.c) * 10_000) / 100, open: last.o, high: last.h, low: last.l, prevClose: prev.c, volume: last.v, ltt, ts: ltt, source: "store", stale: true };
}

const iso = (t) => new Date(t).toISOString().slice(0, 10);

function oiDay() {
  const day = LAST_SESSION;
  const rows = FNO.map((symbol) => {
    const bars = daily(symbol);
    const last = bars.at(-1);
    const prev = bars.at(-2);
    const rand = random(hash(`${symbol}:oi`));
    const oi = Math.round(1_000_000 + rand() * 50_000_000);
    const chgOi = Math.round(oi * (rand() - 0.5) * 0.1);
    const leg = (expiry, premium) => ({ expiry, close: round(last.c * premium), settle: round(last.c * premium), prevClose: round(prev.c * premium), volume: Math.round(rand() * 20_000), oi, chgOi });
    return { symbol, date: iso(day), day, nseSymbol: symbol, expiries: 3, lot: lotFor(symbol), underlying: last.c, near: leg(NEAR_EXPIRY, 1.004), next: leg(NEXT_EXPIRY, 1.009), oi, chgOi };
  });
  return { date: iso(day), day, rows };
}

/** Small lots (about ₹60,000 of stock), so the plan's default ₹5,000 risk per trade fits some ideas. */
function lotFor(symbol) {
  return Math.max(1, Math.round(60_000 / daily(symbol).at(-1).c));
}

// ------------------------------------------------------------------ server

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const notFound = (res, message = "not found") => send(res, 404, { error: message, code: "not_found" });

function symbolsParam(url) {
  return (url.searchParams.get("symbols") ?? "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
}

const STATUS = {
  healthy: true,
  problems: [],
  warnings: [],
  service: "market-data-hub",
  version: "0.0.0-e2e-stub",
  uptimeSec: 1,
  key: { name: "tradex-e2e", scopes: ["history", "live", "fo"] },
  broker: { configured: true, connected: true, ownsConnection: true, lastLoginError: null, budget: { plan: "standard", usedToday: 42, dayCap: 5_000, usedThisMinute: 0, minuteCap: 50, strikes: 0 } },
  data: {
    cashBhav: { lastSession: iso(LAST_SESSION), lastSuccessAt: LAST_SESSION, count: FNO.length },
    foBhav: { lastSession: iso(LAST_SESSION), lastSuccessAt: LAST_SESSION, count: FNO.length },
    lots: { lastSuccessAt: LAST_SESSION, count: FNO.length },
    candles: [{ tf: "1d", series: FNO.length, candles: FNO.length * SESSIONS.length, lastSession: iso(LAST_SESSION) }],
  },
  live: { enabled: true, running: true, feed: { mode: "socket", socket: "connected", socketSymbols: 0, polledSymbols: 0, capacity: 100, lastTickAt: null, reconnects: 0 } },
};

const routes = {
  "/v1/status": (url, res) => send(res, 200, STATUS),

  "/v1/candles": (url, res) => {
    const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
    const tf = url.searchParams.get("tf") ?? "1d";
    const from = asOfFrozen(Number(url.searchParams.get("from") ?? 0));
    if (!known(symbol)) return send(res, 400, { error: "bad symbol", code: "bad_request" });
    const all = candlesFor(symbol, tf);
    if (!all) return send(res, 400, { error: `unknown tf ${tf}`, code: "bad_request" });
    const candles = all.filter((bar) => bar.t >= from);
    send(res, 200, { symbol, tf, from, to: all.at(-1).t, complete: true, coverage: { from: all[0].t, to: all.at(-1).t }, liveThrough: null, candles });
  },

  "/v1/candles/batch": (url, res) => {
    const tf = url.searchParams.get("tf") === "1w" ? "1w" : "1d";
    const from = asOfFrozen(Number(url.searchParams.get("from") ?? 0));
    const to = Number(url.searchParams.get("to") ?? Number.MAX_SAFE_INTEGER);
    const series = {};
    const unknown = [];
    for (const symbol of symbolsParam(url)) {
      if (!known(symbol)) {
        unknown.push(symbol);
        continue;
      }
      const all = candlesFor(symbol, tf);
      series[symbol] = { complete: true, coverage: { from: all[0].t, to: all.at(-1).t }, candles: all.filter((bar) => bar.t >= from && bar.t <= to) };
    }
    send(res, 200, { tf, from, to: Math.min(to, LAST_SESSION), series, queued: [], unknown });
  },

  "/v1/quotes": (url, res) => {
    const symbols = symbolsParam(url);
    send(res, 200, { quotes: symbols.filter(known).map(quote), missing: symbols.filter((symbol) => !known(symbol)) });
  },

  "/v1/stream": (url, res, req) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(STATUS.live.feed)}\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ quotes: symbolsParam(url).filter(known).map(quote), missing: [] })}\n\n`);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => clearInterval(heartbeat));
  },

  "/v1/universe/fno": (url, res) => send(res, 200, { name: "fno", source: "e2e-stub", asOf: iso(LAST_SESSION), count: FNO.length, members: FNO.map((symbol) => ({ symbol, name: "", industry: "" })) }),

  "/v1/lots": (url, res) => send(res, 200, { source: "e2e-stub", fetchedAt: LAST_SESSION, count: FNO.length, lots: Object.fromEntries(FNO.map((symbol) => [symbol, lotFor(symbol)])) }),

  "/v1/fo/ban": (url, res) => send(res, 200, { tradeDate: iso(LAST_SESSION), symbols: ["VEDL"], fetchedAt: LAST_SESSION, current: true }),

  "/v1/results-calendar": (url, res) => {
    const from = url.searchParams.get("from") ?? iso(LAST_SESSION);
    const to = url.searchParams.get("to") ?? iso(LAST_SESSION + 60 * DAY);
    send(res, 200, { from, to, fetchedAt: LAST_SESSION, events: [] });
  },

  "/v1/fo/oi/day": (url, res) => send(res, 200, oiDay()),

  "/v1/fo/members": (url, res) => {
    const from = asOfFrozen(Date.parse(`${url.searchParams.get("from")}T00:00:00Z`));
    const to = Date.parse(`${url.searchParams.get("to")}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return send(res, 400, { error: "from and to are required", code: "bad_request" });
    const days = SESSIONS.filter((t) => t >= from && t <= to).map((t) => ({ date: iso(t), day: t, symbols: FNO }));
    send(res, 200, { from: iso(from), to: iso(to), days });
  },

  "/v1/fo/contracts": (url, res) => {
    const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
    if (!FNO.includes(symbol)) return notFound(res, `${symbol} has no futures`);
    send(res, 200, {
      symbol,
      asOf: iso(LAST_SESSION),
      lot: lotFor(symbol),
      contracts: [
        { ticker: `${symbol}26NOVFUT`, expiry: NEAR_EXPIRY, kind: "near" },
        { ticker: `${symbol}26DECFUT`, expiry: NEXT_EXPIRY, kind: "next" },
      ],
    });
  },
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") return send(res, 200, { ok: true });
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: "bad key", code: "unauthorized" });
  const route = routes[url.pathname];
  if (!route || req.method !== "GET") return notFound(res);
  try {
    route(url, res, req);
  } catch (error) {
    send(res, 500, { error: String(error), code: "internal" });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Stub Market Data Hub on http://127.0.0.1:${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
