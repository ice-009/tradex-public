// Checks a running Tradex whose Market Data Hub has no broker (end-of-day mode,
// market-data-hub#32): signs up and in, then asserts that Tradex says
// "End-of-day data (no broker connected)", draws daily charts from the hub,
// explains why intraday charts are off, quotes the last close, runs the
// screener and a backtest, and that the daily plan answers. CI's `docker` job runs it against `docker compose up` with no
// broker keys (and e2e/nse-stub.mjs standing in for NSE).
//
// Usage: node e2e/no-broker-smoke.mjs [base URL, default http://127.0.0.1:3100]
//   SHORT_HISTORY=1  the hub has only a few weeks of daily bars (CI): a backtest may answer "not enough history".

const BASE = (process.argv[2] || "http://127.0.0.1:3100").replace(/\/+$/, "");
const USER = { email: "eod@example.com", password: "ci-only-password", name: "EOD" };
const cookies = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, init = {}) {
  const headers = { ...(init.headers ?? {}), cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
  const response = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return response;
}

async function json(path) {
  const response = await request(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function check(condition, message, detail) {
  if (!condition) {
    console.error(`✗ ${message}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2).slice(0, 2000));
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

// ------------------------------------------------------------------ sign in

const signup = await request("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(USER) });
check(signup.ok || signup.status === 400, "signed up (or the account exists)");
const { csrfToken } = await (await request("/api/auth/csrf")).json();
const signin = await request("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken, email: USER.email, password: USER.password, json: "true" }).toString(),
});
check([200, 302].includes(signin.status) && [...cookies.keys()].some((name) => name.includes("session-token")), "signed in");

// ------------------------------------------------------------------ mode

const usage = await json("/api/broker/usage");
check(usage.hub.reachable && usage.hub.endOfDay === true, "the hub is reachable and in end-of-day mode", usage.hub);
const status = await json("/api/broker/status");
check(status.label === "End-of-day data (no broker connected)", `Tradex says "${status.label}"`, status);

// ------------------------------------------------------------------ charts

// The hub fills its last two weeks from NSE's files right after it starts; wait for them.
let daily;
for (let attempt = 0; attempt < 60; attempt += 1) {
  daily = await json("/api/chart?symbol=SBIN&interval=1d&range=1y");
  if (daily.priceSeries.length >= 5) break;
  await sleep(5_000);
}
check(daily.sourceId === "hub" && !daily.error && daily.priceSeries.length >= 5, `daily chart from the hub (${daily.priceSeries.length} candles)`, daily);
const weekly = await json("/api/chart?symbol=SBIN&interval=1w&range=5y");
check(weekly.sourceId === "hub" && weekly.priceSeries.length >= 1, `weekly chart from the hub (${weekly.priceSeries.length} candles)`, weekly);
const intraday = await json("/api/chart?symbol=SBIN&interval=15m&range=5d");
check(intraday.priceSeries.length === 0 && /Intraday charts need a broker/.test(intraday.error ?? ""), "intraday chart explains it needs a broker", intraday);

// ------------------------------------------------------------------ quotes

const quotes = await json("/api/quotes?symbols=SBIN,INFY");
const sbin = (quotes.quotes ?? []).find((quote) => quote.symbol === "SBIN");
check(sbin && sbin.delayed === true && sbin.ltp === daily.priceSeries.at(-1).close, "quotes are the last daily close, marked delayed", quotes);

// ------------------------------------------------------------------ screener

let screener;
for (let attempt = 0; attempt < 60; attempt += 1) {
  screener = await json("/api/screener?universe=nifty50&live=0");
  if (screener.status !== "syncing") break;
  await sleep(5_000);
}
check(screener.status === "ready", `screener ran over NIFTY 50 (${screener.universe?.covered ?? "?"}/${screener.universe?.count ?? "?"} stocks with bars)`, { ...screener, results: undefined });

// ------------------------------------------------------------------ backtest and daily plan

const screenIds = Object.keys(screener.results ?? {});
const backtestResponse = await request("/api/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ universe: "nifty50", screenIds }) });
const backtest = await backtestResponse.json();
// SHORT_HISTORY=1 (CI): the hub holds only its two-week catch-up, too little to backtest; it must say so.
const tooShort = process.env.SHORT_HISTORY === "1" && backtest.status === "error" && /enough history/.test(backtest.error ?? "");
check(
  backtestResponse.ok && (backtest.status === "ready" || tooShort),
  tooShort ? `backtest answers (history too short so far: "${backtest.error}")` : `backtest of ${screenIds.length} screens over NIFTY 50 ran (${backtest.result?.trades?.length ?? "?"} trades)`,
  { status: backtest.status, error: backtest.error },
);

let evidence;
for (let attempt = 0; attempt < 60; attempt += 1) {
  evidence = await json("/api/plan/evidence");
  if (evidence.status !== "computing") break;
  await sleep(5_000);
}
// The plan's market filter needs NIFTY's history, which an end-of-day hub only has once it
// imports NSE's index closes (market-data-hub#23): until then it must say so, not fail.
const planWaitsForNifty = evidence.status === "error" && /NIFTY's daily history/.test(evidence.error ?? "");
check(evidence.status === "ready" || planWaitsForNifty, planWaitsForNifty ? "the daily plan explains it waits for NIFTY's history (market-data-hub#23)" : "the daily plan's strategy evidence was computed", { status: evidence.status, error: evidence.error });

console.log("No-broker mode works.");
