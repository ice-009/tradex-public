// Inputs of the IIMA factor check (issue #25), each downloaded once and kept
// under .cache/research/iima/ (git-ignored):
//
//   1. IIM Ahmedabad's Fama-French & momentum factor files. Their site states
//      no licence for the files (only how to cite them), so they are never
//      committed or redistributed: they are read at run time from the URL below.
//   2. The cash universe: which NSE tickers traded. The hub serves any
//      ticker's archive but has no list of every ticker it holds
//      (market-data-hub#60), so the list comes from NSE's own cash bhavcopy on
//      the last session of each month (about 385 files, one request every
//      1.5 s, as the hub itself reads NSE's archive).
//   3. Every one of those stocks' daily bars from the hub, as traded
//      (GET /v1/candles/batch?adjust=none, 40 symbols a request) and the hub's
//      split/bonus factors (GET /v1/adjustments/batch). Adjusted = as traded ×
//      the factors, which is exactly how the hub adjusts its archive, but
//      reading as-traded bars never queues a broker download (adjust=split would
//      ask the broker for every stock it doesn't hold yet: thousands of Fyers
//      calls for one research run).
//
// GET-only; nothing here writes to the hub.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import type { HubClient } from "@/server/providers/hub/client";

export const IIMA_PAGE = "https://faculty.iima.ac.in/iffm/Indian-Fama-French-Momentum/";
const NSE_ARCHIVE = "https://nsearchives.nseindia.com";
/** NSE's old cash bhavcopy format ends here (sec_bhavdata_full from 8 Jul 2024). */
const LEGACY_LAST_DAY = Date.UTC(2024, 6, 5);
const NSE_GAP_MS = 1_500;
const HUB_BATCH = 40;
const ADJUST_BATCH = 300;
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "en-IN,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);
const say = (text: string) => process.stderr.write(`${text}\n`);

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A cached file's bytes, or null when it isn't there (read once: no exists-then-read race). */
function cached(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const cachedJson = <T>(file: string): T | null => {
  const bytes = cached(file);
  return bytes === null ? null : (JSON.parse((file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")) as T);
};

// ---------- 1. IIMA ----------

export interface IimaFiles {
  release: string;
  monthly: string;
  daily: string;
  portfolios: string;
  breakpoints: string;
  urls: Record<string, string>;
}

const IIMA_FILES = {
  monthly: "FourFactors_and_Market_Returns_Monthly_SurvivorshipBiasAdjusted.csv",
  daily: "FourFactors_and_Market_Returns_Daily_SurvivorshipBiasAdjusted.csv",
  portfolios: "Size_Momentum_Portfolio_Returns_Monthly_SurvivorshipBiasAdjusted.csv",
  breakpoints: "Size_and_Momentum_Break_Points_for_Size_Momentum_Portfolios.csv",
} as const;

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "tradex-research (github.com/ice-009/tradex-public)", ...headers }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

/** IIMA's newest release (or the cached one): five requests the first time, none after. */
export async function iimaFiles(cacheDir: string, refresh: boolean): Promise<IimaFiles> {
  const dir = ensureDir(path.join(cacheDir, "iima"));
  const marker = path.join(dir, "release.txt");
  // A release is YYYY-MM: anything else in the marker (or on the page) is ignored.
  const isRelease = (text: string) => /^\d{4}-\d{2}$/.test(text);
  let release = refresh ? "" : (cached(marker)?.toString("utf8").trim() ?? "");
  if (!isRelease(release)) {
    const page = await fetchText(IIMA_PAGE);
    const found = page.match(/DATA\/(\d{4}-\d{2})_FourFactors_and_Market_Returns_Monthly_SurvivorshipBiasAdjusted\.csv/);
    if (!found) throw new Error(`No factor file linked from ${IIMA_PAGE} (the page changed?)`);
    release = found[1];
    if (!isRelease(release)) throw new Error(`Unexpected IIMA release name ${release}`);
  }
  const urls: Record<string, string> = {};
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(IIMA_FILES)) {
    const url = `${IIMA_PAGE}DATA/${release}_${name}`;
    urls[key] = url;
    const file = path.join(dir, `${release}_${name}`);
    let text = cached(file)?.toString("utf8");
    if (text === undefined) {
      say(`Downloading ${url}`);
      text = await fetchText(url);
      writeFileSync(file, text);
      await sleep(1_000);
    }
    out[key] = text;
  }
  writeFileSync(marker, release);
  return { release, monthly: out.monthly, daily: out.daily, portfolios: out.portfolios, breakpoints: out.breakpoints, urls };
}

// ---------- 2. NSE's cash universe ----------

/** The one file in a zip (NSE's legacy bhavcopies hold one CSV). */
export function unzipSingle(body: Buffer): Buffer {
  let eocd = -1;
  for (let i = body.length - 22; i >= Math.max(0, body.length - 65_557); i -= 1) {
    if (body.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const central = body.readUInt32LE(eocd + 16);
  if (body.readUInt32LE(central) !== 0x02014b50) throw new Error("bad zip directory");
  const method = body.readUInt16LE(central + 10);
  const size = body.readUInt32LE(central + 20);
  const local = body.readUInt32LE(central + 42);
  if (body.readUInt32LE(local) !== 0x04034b50) throw new Error("bad zip entry");
  const start = local + 30 + body.readUInt16LE(local + 26) + body.readUInt16LE(local + 28);
  const data = body.subarray(start, start + size);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip method ${method}`);
}

export interface NseRow {
  symbol: string;
  series: string;
  isin: string | null;
}

/** Symbols, series (EQ and BE, as the hub stores) and ISINs (2011–2024 files) of one cash bhavcopy. */
export function parseCashBhav(text: string): NseRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0].split(",").map((cell) => cell.trim().toUpperCase());
  const at = (name: string) => header.indexOf(name);
  const [iSymbol, iSeries, iIsin] = [at("SYMBOL"), at("SERIES"), at("ISIN")];
  if (iSymbol < 0 || iSeries < 0) throw new Error(`not a cash bhavcopy (header ${header.slice(0, 4).join(",")})`);
  const rows: NseRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((cell) => cell.trim());
    const series = (cells[iSeries] ?? "").toUpperCase();
    if (series !== "EQ" && series !== "BE") continue;
    rows.push({ symbol: cells[iSymbol].toUpperCase(), series, isin: iIsin >= 0 ? cells[iIsin] || null : null });
  }
  return rows;
}

function cashBhavUrl(day: number): string {
  const date = new Date(day);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  if (day > LEGACY_LAST_DAY) return `${NSE_ARCHIVE}/products/content/sec_bhavdata_full_${dd}${mm}${yyyy}.csv`;
  const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][date.getUTCMonth()];
  return `${NSE_ARCHIVE}/content/historical/EQUITIES/${yyyy}/${mon}/cm${dd}${mon}${yyyy}bhav.csv.zip`;
}

export interface MonthSample {
  month: string;
  /** The session sampled (the month's last with a file), or null. */
  date: string | null;
  rows: NseRow[];
}

let lastNse = 0;
async function nseGet(url: string): Promise<{ status: number; body: Buffer }> {
  for (let attempt = 0; ; attempt += 1) {
    const wait = lastNse + NSE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastNse = Date.now();
    try {
      const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(30_000) });
      const body = Buffer.from(await response.arrayBuffer());
      if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < 2) {
        await sleep(attempt ? 60_000 : 10_000);
        continue;
      }
      return { status: response.status, body };
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(10_000);
    }
  }
}

/** The cash bhavcopy of each month's last session, `from`..`to` (YYYY-MM), cached per month. */
export async function nseMonthSamples(cacheDir: string, from: string, to: string): Promise<MonthSample[]> {
  const dir = ensureDir(path.join(cacheDir, "nse"));
  const out: MonthSample[] = [];
  const thisMonth = new Date().toISOString().slice(0, 7);
  for (let [y, m] = from.split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    const file = path.join(dir, `${month}.json`);
    const known = cachedJson<MonthSample>(file);
    if (known) {
      out.push(known);
      continue;
    }
    let sample: MonthSample = { month, date: null, rows: [] };
    const last = Date.UTC(y, m, 0);
    for (let day = Math.min(last, Date.now() - 86_400_000); day > last - 10 * 86_400_000; day -= 86_400_000) {
      const weekday = new Date(day).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const url = cashBhavUrl(day);
      const { status, body } = await nseGet(url);
      if (status === 404) continue;
      if (status !== 200) throw new Error(`NSE ${status} for ${url}; try again later`);
      const text = url.endsWith(".zip") ? unzipSingle(body).toString("utf8") : body.toString("utf8");
      sample = { month, date: isoDay(day), rows: parseCashBhav(text) };
      break;
    }
    say(`NSE ${month}: ${sample.date ?? "no file"} (${sample.rows.length} EQ/BE rows)`);
    // The current month isn't over: don't keep its sample.
    if (month < thisMonth) writeFileSync(file, JSON.stringify(sample));
    out.push(sample);
  }
  return out;
}

// ---------- 3. The hub's bars and factors ----------

/** One stock's daily history, compact: day keys, as-traded closes and volumes. */
export interface RawSeries {
  /** The listing's tickers, oldest first (the hub joins renames). */
  names: string[];
  t: number[];
  c: number[];
  v: number[];
}

export interface HubSet {
  series: Map<string, RawSeries>;
  unknown: string[];
  factors: Map<string, Array<{ day: number; factor: number; symbol: string; source: string }>>;
}

type FactorList = Array<{ day: number; factor: number; symbol: string; source: string }>;

/**
 * Every symbol's as-traded daily bars from..to (day keys) and its factors.
 * Cached per symbol (.cache/research/iima/hub/bars-<to>/), so a changed list
 * asks the hub only for the symbols it hasn't answered yet.
 */
export async function hubSet(client: HubClient, symbols: string[], from: number, to: number, cacheDir: string): Promise<HubSet> {
  const dir = ensureDir(path.join(cacheDir, "hub", `bars-${isoDay(to)}`));
  const fileOf = (symbol: string) => path.join(dir, `${encodeURIComponent(symbol)}.json.gz`);
  const unknownFile = path.join(dir, "_unknown.json");
  const unknown = new Set<string>(cachedJson<string[]>(unknownFile) ?? []);
  const sorted = [...new Set(symbols)].sort();
  const series = new Map<string, RawSeries>();
  const todo: string[] = [];
  for (const symbol of sorted) {
    if (unknown.has(symbol)) continue;
    const item = cachedJson<RawSeries>(fileOf(symbol));
    if (item === null) todo.push(symbol);
    else if (item.t.length) series.set(symbol, item);
  }
  for (let start = 0; start < todo.length; start += HUB_BATCH) {
    const part = todo.slice(start, start + HUB_BATCH);
    const batch = await client.candlesBatch(part, "1d", from, to, { adjust: "none" });
    for (const symbol of batch.unknown ?? []) unknown.add(symbol);
    for (const [symbol, item] of Object.entries(batch.series)) {
      const bars = item.candles.filter((bar) => bar.c > 0).sort((x, y) => x.t - y.t);
      const names = [...new Set((item.sources ?? []).flatMap((span) => span.names ?? []))];
      const raw: RawSeries = { names: names.length ? names : [symbol], t: bars.map((bar) => bar.t), c: bars.map((bar) => bar.c), v: bars.map((bar) => bar.v) };
      writeFileSync(fileOf(symbol), gzipSync(JSON.stringify(raw)));
      if (raw.t.length) series.set(symbol, raw);
    }
    for (const symbol of part) if (!batch.series[symbol]) unknown.add(symbol);
    writeFileSync(unknownFile, JSON.stringify([...unknown].sort()));
    if ((start / HUB_BATCH) % 10 === 0 || start + HUB_BATCH >= todo.length) say(`Hub bars: ${Math.min(todo.length, start + HUB_BATCH)}/${todo.length} symbols to fetch`);
  }

  const factorFile = path.join(cacheDir, "hub", `factors-${isoDay(to)}.json.gz`);
  const stored: Record<string, FactorList> = cachedJson<Record<string, FactorList>>(factorFile) ?? {};
  const missing = [...series.keys()].filter((symbol) => !stored[symbol]);
  for (let start = 0; start < missing.length; start += ADJUST_BATCH) {
    const batch = await client.adjustmentsBatch(missing.slice(start, start + ADJUST_BATCH));
    for (const [symbol, item] of Object.entries(batch.series)) stored[symbol] = item.factors.map((f) => ({ day: f.day, factor: f.factor, symbol: f.symbol, source: f.source }));
    for (const symbol of missing.slice(start, start + ADJUST_BATCH)) stored[symbol] ??= [];
  }
  if (missing.length) writeFileSync(factorFile, gzipSync(JSON.stringify(stored)));
  const factors = new Map<string, FactorList>([...series.keys()].map((symbol) => [symbol, stored[symbol] ?? []]));
  return { series, unknown: sorted.filter((symbol) => unknown.has(symbol)), factors };
}

export interface CorporateAction {
  symbol: string;
  exDay: number;
  purpose: string;
  kinds: string[];
  ratio: number | null;
}

/** NSE's corporate actions as the hub stores them (the PR zip's bc file, 2010 on), every ticker, 400 days a request, cached. */
export async function hubCorporateActions(client: HubClient, from: number, to: number, cacheDir: string): Promise<CorporateAction[]> {
  const file = path.join(ensureDir(path.join(cacheDir, "hub")), `actions-${isoDay(from)}-${isoDay(to)}.json.gz`);
  const known = cachedJson<CorporateAction[]>(file);
  if (known) return known;
  const out: CorporateAction[] = [];
  const span = 399 * 86_400_000;
  for (let start = from; start <= to; start += span + 86_400_000) {
    const end = Math.min(to, start + span);
    const answer = await client.get<{ actions?: CorporateAction[] }>("/v1/corporate-actions", { from: isoDay(start), to: isoDay(end) }, { retries: 2 });
    for (const action of answer.actions ?? []) out.push({ symbol: action.symbol, exDay: action.exDay, purpose: action.purpose, kinds: action.kinds, ratio: action.ratio });
  }
  writeFileSync(file, gzipSync(JSON.stringify(out)));
  return out;
}
