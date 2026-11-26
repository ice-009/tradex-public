// Rebuilding IIM Ahmedabad's Indian momentum (WML) and market factors from
// our own daily history (ice-009/tradex-public#25), to compare with the
// factors they publish (https://faculty.iima.ac.in/iffm/Indian-Fama-French-Momentum/).
// A close match says our adjusted, survivorship-free archive is sound; the
// months where it doesn't point at data bugs.
//
// Their method (Agarwalla, Jacob & Varma 2013, IIMA W.P. 2013-09-05, and the
// data library page) and ours:
//
//   | | IIMA | here |
//   |---|---|---|
//   | universe | BSE + NSE listed (CMIE Prowess) | NSE cash bhavcopy, EQ and BE series, delisted included |
//   | liquidity | traded on ≥ 50 days in the past 12 months | the same |
//   | penny filter | median price over the past year < ₹1 out | the same (median month-end close as traded) |
//   | micro-cap filter | market cap < 10% of the median out (~26% of stocks) | bottom 25% by traded value out (no market cap in the hub) |
//   | size | big = top 10% by market cap at the month end | top 10% by median daily traded value over the past 12 months |
//   | momentum | return over months t−11..t−1 (12-1), top/bottom 30% | the same, split/bonus-adjusted closes |
//   | WML | ½(WB − LB) + ½(WS − LS), portfolios value-weighted, < 5 stocks → leg dropped | the same, traded-value- or equal-weighted |
//   | returns | total returns (dividends in), daily, compounded to months | price returns, month-end to month-end, buy and hold |
//   | market | value-weighted, every stock in the factor portfolios, minus 91-day T-bill | the filtered universe, weighted as above, minus IIMA's own RF |
//
// Pure: everything comes in as data.

// ---------- months ----------

/** Months as integers: year × 12 + month − 1. */
export const monthOf = (day: number) => {
  const date = new Date(day);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
};
export const monthKey = (month: number) => `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}`;
export const parseMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + m - 1;
};

// ---------- IIMA's files ----------

export interface IimaFactorRow {
  month: string;
  smb: number | null;
  hml: number | null;
  wml: number | null;
  /** Market premium (Rm − Rf). */
  mf: number | null;
  rf: number | null;
}

const value = (cell: string | undefined): number | null => {
  if (cell === undefined) return null;
  const trimmed = cell.trim();
  if (!trimmed || trimmed === "NA") return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
};

function csvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));
}

/** IIMA's FourFactors_and_Market_Returns file (percent → fractions). Monthly dates are YYYY-MM, daily YYYY-MM-DD. */
export function parseIimaFactors(text: string): IimaFactorRow[] {
  const [header, ...rows] = csvRows(text);
  const at = (name: string) => header.findIndex((cell) => cell.toUpperCase() === name);
  const index = { date: at("DATE"), smb: at("SMB"), hml: at("HML"), wml: at("WML"), mf: at("MF"), rf: at("RF") };
  if (Object.values(index).some((i) => i < 0)) throw new Error(`Not an IIMA factor file (header: ${header.join(",")})`);
  const pct = (cell: string | undefined) => {
    const number = value(cell);
    return number === null ? null : number / 100;
  };
  return rows.map((row) => ({ month: row[index.date], smb: pct(row[index.smb]), hml: pct(row[index.hml]), wml: pct(row[index.wml]), mf: pct(row[index.mf]), rf: pct(row[index.rf]) }));
}

export interface IimaPortfolioRow {
  month: string;
  wb: number | null;
  ws: number | null;
  lb: number | null;
  ls: number | null;
}

/** IIMA's four size-momentum portfolios (percent → fractions). */
export function parseIimaPortfolios(text: string): IimaPortfolioRow[] {
  const [header, ...rows] = csvRows(text);
  const find = (code: string) => header.findIndex((cell) => new RegExp(`\\b${code}\\b`).test(cell));
  const index = { wb: find("WB"), ws: find("WS"), lb: find("LB"), ls: find("LS") };
  if (Object.values(index).some((i) => i < 0)) throw new Error(`Not an IIMA size-momentum portfolio file (header: ${header.join(",")})`);
  const pct = (cell: string | undefined) => {
    const number = value(cell);
    return number === null ? null : number / 100;
  };
  return rows.map((row) => ({ month: row[0], wb: pct(row[index.wb]), ws: pct(row[index.ws]), lb: pct(row[index.lb]), ls: pct(row[index.ls]) }));
}

export interface IimaBreakpointRow {
  /** Formation month (YYYY-MM). */
  month: string;
  /** 90th percentile market cap (₹ million). */
  size90: number | null;
  /** 30th and 70th percentile of the 12-1 momentum return (fractions). */
  mom30: number | null;
  mom70: number | null;
}

/** IIMA's size-momentum breakpoints (yearmonth as YYYYMM). */
export function parseIimaBreakpoints(text: string): IimaBreakpointRow[] {
  const [, ...rows] = csvRows(text);
  return rows.map((row) => {
    const raw = row[0];
    const mom30 = value(row[2]);
    const mom70 = value(row[3]);
    return { month: `${raw.slice(0, 4)}-${raw.slice(4, 6)}`, size90: value(row[1]), mom30: mom30 === null ? null : mom30 / 100, mom70: mom70 === null ? null : mom70 / 100 };
  });
}

/** Daily rows compounded to months: (1 + r1)(1 + r2)… − 1 per YYYY-MM. */
export function compoundToMonths(rows: Array<{ date: string; value: number | null }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.value === null) continue;
    const month = row.date.slice(0, 7);
    out.set(month, (1 + (out.get(month) ?? 0)) * (1 + row.value) - 1);
  }
  return out;
}

// ---------- our monthly panel ----------

/** One stock's months, dense from `first`: NaN where it didn't trade. */
export interface StockMonths {
  id: string;
  first: number;
  /** Last close of the month, split/bonus-adjusted to today. */
  adj: Float64Array;
  /** Last close of the month as traded (for the penny filter). */
  raw: Float64Array;
  /** Sessions traded in the month. */
  days: Float64Array;
  /** Traded value (Σ close × volume, ₹) in the month. */
  value: Float64Array;
}

export interface Factor {
  day: number;
  factor: number;
}

/**
 * A stock's daily closes (as traded) → its months. A bar before an ex-date is
 * multiplied by that factor, as the hub adjusts its archive. Pure.
 */
export function stockMonths(id: string, t: number[], c: number[], v: number[], factors: Factor[]): StockMonths | null {
  if (!t.length) return null;
  const sorted = [...factors].sort((a, b) => a.day - b.day);
  // cumulative[i]: the product of factors i.. (what a bar before factor i's ex-date is multiplied by).
  const cumulative = new Array<number>(sorted.length + 1).fill(1);
  for (let i = sorted.length - 1; i >= 0; i -= 1) cumulative[i] = cumulative[i + 1] * sorted[i].factor;
  const first = monthOf(t[0]);
  const length = monthOf(t[t.length - 1]) - first + 1;
  const out: StockMonths = { id, first, adj: new Float64Array(length).fill(NaN), raw: new Float64Array(length).fill(NaN), days: new Float64Array(length), value: new Float64Array(length) };
  let next = 0;
  for (let i = 0; i < t.length; i += 1) {
    while (next < sorted.length && sorted[next].day <= t[i]) next += 1;
    const m = monthOf(t[i]) - first;
    out.adj[m] = c[i] * cumulative[next];
    out.raw[m] = c[i];
    out.days[m] += 1;
    out.value[m] += c[i] * (v[i] || 0);
  }
  return out;
}

export interface Jump {
  id: string;
  day: number;
  prevDay: number;
  /** As-traded closes. */
  prevClose: number;
  close: number;
  /** The adjusted close-to-close return. */
  ret: number;
}

/** Day-to-day adjusted moves beyond −45% / +100%: unadjusted splits and bonuses, or bad prints. Pure. */
export function adjustedJumps(id: string, t: number[], c: number[], factors: Factor[], down = -0.45, up = 1): Jump[] {
  const sorted = [...factors].sort((a, b) => a.day - b.day);
  const out: Jump[] = [];
  let next = 0;
  for (let i = 1; i < t.length; i += 1) {
    // Factors with ex-date in (t[i-1], t[i]] scale the earlier bar only.
    let between = 1;
    while (next < sorted.length && sorted[next].day <= t[i]) {
      if (sorted[next].day > t[i - 1]) between *= sorted[next].factor;
      next += 1;
    }
    const ret = c[i] / (c[i - 1] * between) - 1;
    if (ret < down || ret > up) out.push({ id, day: t[i], prevDay: t[i - 1], prevClose: c[i - 1], close: c[i], ret });
  }
  return out;
}

/** Price factors of common splits, bonuses (a:b → b/(a+b), a, b ≤ 5) and both at once (1/k). */
export const STANDARD_RATIOS: number[] = (() => {
  const set = new Set<number>();
  for (let a = 1; a <= 5; a += 1) for (let b = 1; b <= 5; b += 1) set.add(Math.round((b / (a + b)) * 1e6) / 1e6);
  for (const k of [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 40, 50, 100]) set.add(Math.round((1 / k) * 1e6) / 1e6);
  return [...set].sort((a, b) => a - b);
})();

/** The standard ratio nearest `ratio` (relative distance), when within `tolerance`. */
export function snapRatio(ratio: number, tolerance = 0.12): number | null {
  let best: number | null = null;
  for (const candidate of STANDARD_RATIOS) if (best === null || Math.abs(ratio / candidate - 1) < Math.abs(ratio / best - 1)) best = candidate;
  return best !== null && Math.abs(ratio / best - 1) <= tolerance ? best : null;
}

export interface ListedAction {
  exDay: number;
  purpose: string;
}

export interface MissedFactor extends Factor {
  prevClose: number;
  close: number;
  purpose: string;
}

/** Purposes that change the share count: splits (SPLIT, FV SPL), bonuses (BON) and consolidations — not special dividends (SPL DIV). */
const SHARE_ACTION = /\b(BON|BONUS|SPLT|SPLIT|SUB-?DIV|FV|CONSOL)|(?<!\+\s*)\bSPL\b(?!\s*(INT\.?\s*)?DIV)/i;

/**
 * Splits and bonuses NSE's corporate-actions file lists that the factors miss:
 * a listed share action on day d, no factor within 3 days of it, and a close
 * at d that is the previous close × a standard ratio (within 12%: the day's own
 * move). The factor is that ratio. Pure.
 */
export function missedFactors(t: number[], c: number[], factors: Factor[], actions: ListedAction[]): MissedFactor[] {
  const out: MissedFactor[] = [];
  const near = (day: number) => factors.some((factor) => Math.abs(factor.day - day) <= 3 * 86_400_000);
  for (const action of actions) {
    if (!SHARE_ACTION.test(action.purpose) || near(action.exDay) || out.some((item) => item.day === action.exDay)) continue;
    const i = t.indexOf(action.exDay);
    if (i < 1) continue;
    const ratio = c[i] / c[i - 1];
    if (ratio >= 0.85) continue;
    const factor = snapRatio(ratio);
    if (factor !== null) out.push({ day: action.exDay, factor, prevClose: c[i - 1], close: c[i], purpose: action.purpose });
  }
  return out;
}

/**
 * Falls no exchange band allows: from one session to the next (≤ 4 calendar
 * days), the adjusted close × a standard split/bonus ratio at or below 0.6
 * (within 5%), and the price staying there (the next five closes' median
 * within −25%/+33% of the new close). NSE's widest band is 20%, so outside the
 * F&O list such a fall is almost always a split or bonus without a factor.
 * A heuristic for the years without NSE's corporate-actions file: an upper
 * bound on what missed factors do, not a correction. Pure.
 */
export function gapFactors(t: number[], c: number[], factors: Factor[]): MissedFactor[] {
  const out: MissedFactor[] = [];
  const sorted = [...factors].sort((a, b) => a.day - b.day);
  let next = 0;
  for (let i = 1; i < t.length; i += 1) {
    let between = 1;
    while (next < sorted.length && sorted[next].day <= t[i]) {
      if (sorted[next].day > t[i - 1]) between *= sorted[next].factor;
      next += 1;
    }
    if (t[i] - t[i - 1] > 4 * 86_400_000) continue;
    const ratio = c[i] / (c[i - 1] * between);
    if (ratio > 0.6) continue;
    const factor = snapRatio(ratio, 0.05);
    if (factor === null) continue;
    const after = c.slice(i + 1, i + 6).sort((a, b) => a - b);
    const median = after.length ? after[Math.floor(after.length / 2)] : c[i];
    if (median / c[i] < 0.75 || median / c[i] > 1.33) continue;
    out.push({ day: t[i], factor, prevClose: c[i - 1], close: c[i], purpose: "price gap" });
  }
  return out;
}

// ---------- the factors ----------

export type Weighting = "value" | "ew";

export interface FactorOptions {
  weighting: Weighting;
  /** Fewest sessions traded over the 12 months to the formation month (IIMA: 50). */
  minDays: number;
  /** Lowest median month-end price as traded over those months (IIMA: ₹1). */
  minPrice: number;
  /** Share of the smallest stocks (by traded value) left out (IIMA's micro-cap filter drops ~26%). */
  microShare: number;
  /** Big = this share of the largest (IIMA: 10%). */
  bigShare: number;
  /** Winners/losers: top/bottom share by momentum (IIMA: 30%). */
  momShare: number;
  /** Smallest portfolio counted (IIMA: 5). */
  minStocks: number;
}

export const IIMA_OPTIONS: FactorOptions = { weighting: "value", minDays: 50, minPrice: 1, microShare: 0.25, bigShare: 0.1, momShare: 0.3, minStocks: 5 };

export interface Member {
  id: string;
  weight: number;
  /** The holding month's return. */
  ret: number;
  mom: number;
  size: number;
}

export interface FormedMonth {
  /** Formation month (portfolios formed at its end). */
  formed: number;
  /** Holding month (formed + 1). */
  month: number;
  /** Stocks past the liquidity, penny and micro-cap filters. */
  universe: number;
  /** Of those, with a 12-1 momentum return. */
  ranked: number;
  breakpoints: { size90: number; mom30: number; mom70: number } | null;
  portfolios: Record<"wb" | "ws" | "lb" | "ls", { n: number; ret: number | null; members: Member[] }>;
  wml: number | null;
  /** The market (the filtered universe), weighted as the portfolios. */
  market: number | null;
  marketN: number;
}

const percentile = (sortedValues: number[], share: number) => {
  if (!sortedValues.length) return NaN;
  const position = (sortedValues.length - 1) * share;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sortedValues[low] + (sortedValues[high] - sortedValues[low]) * (position - low);
};

const median = (values: number[]) => percentile([...values].sort((a, b) => a - b), 0.5);

/** The adjusted close at the end of `month`, or the latest before it within `stale` months (NaN: none). */
function closeAt(stock: StockMonths, month: number, stale: number): number {
  for (let m = month; m >= month - stale; m -= 1) {
    const i = m - stock.first;
    if (i < 0) return NaN;
    if (i < stock.adj.length && Number.isFinite(stock.adj[i])) return stock.adj[i];
  }
  return NaN;
}

/** The last adjusted close on or before the end of `month` (carried across suspensions and past the last trade). */
function lastCloseBy(stock: StockMonths, month: number): number {
  for (let i = Math.min(month - stock.first, stock.adj.length - 1); i >= 0; i -= 1) if (Number.isFinite(stock.adj[i])) return stock.adj[i];
  return NaN;
}

function weighted(members: Member[]): number | null {
  if (!members.length) return null;
  const total = members.reduce((sum, member) => sum + member.weight, 0);
  return total > 0 ? members.reduce((sum, member) => sum + member.weight * member.ret, 0) / total : null;
}

/** The portfolios formed at the end of month `formed`, held over the next. Pure. */
export function formMonth(stocks: StockMonths[], formed: number, options: FactorOptions = IIMA_OPTIONS): FormedMonth {
  interface Row {
    stock: StockMonths;
    size: number;
    mom: number;
    ret: number;
  }
  const rows: Row[] = [];
  for (const stock of stocks) {
    const end = formed - stock.first;
    // Traded in the formation month itself (a stock suspended then isn't buyable).
    if (end < 0 || end >= stock.adj.length || !Number.isFinite(stock.adj[end])) continue;
    let days = 0;
    const prices: number[] = [];
    const monthly: number[] = [];
    for (let m = Math.max(0, end - 11); m <= end; m += 1) {
      days += stock.days[m];
      if (Number.isFinite(stock.raw[m])) prices.push(stock.raw[m]);
      if (stock.days[m] > 0) monthly.push(stock.value[m] / stock.days[m]);
    }
    if (days < options.minDays || !prices.length || median(prices) < options.minPrice) continue;
    const size = median(monthly);
    if (!(size > 0)) continue;
    const start = closeAt(stock, formed - 12, 1);
    const recent = closeAt(stock, formed - 1, 1);
    const mom = Number.isFinite(start) && Number.isFinite(recent) && start > 0 ? recent / start - 1 : NaN;
    const ret = lastCloseBy(stock, formed + 1) / stock.adj[end] - 1;
    rows.push({ stock, size, mom, ret: Number.isFinite(ret) ? ret : 0 });
  }
  const sizes = rows.map((row) => row.size).sort((a, b) => a - b);
  const microCut = percentile(sizes, options.microShare);
  const universe = options.microShare > 0 ? rows.filter((row) => row.size >= microCut) : rows;
  const weightOf = (row: Row) => (options.weighting === "value" ? row.size : 1);
  const member = (row: Row): Member => ({ id: row.stock.id, weight: weightOf(row), ret: row.ret, mom: row.mom, size: row.size });

  const marketMembers = universe.map(member);
  const ranked = universe.filter((row) => Number.isFinite(row.mom));
  const empty = () => ({ n: 0, ret: null as number | null, members: [] as Member[] });
  const portfolios = { wb: empty(), ws: empty(), lb: empty(), ls: empty() };
  let breakpoints: FormedMonth["breakpoints"] = null;
  let wml: number | null = null;
  if (ranked.length >= 4 * options.minStocks) {
    const size90 = percentile(ranked.map((row) => row.size).sort((a, b) => a - b), 1 - options.bigShare);
    const moms = ranked.map((row) => row.mom).sort((a, b) => a - b);
    const mom30 = percentile(moms, options.momShare);
    const mom70 = percentile(moms, 1 - options.momShare);
    breakpoints = { size90, mom30, mom70 };
    for (const row of ranked) {
      const big = row.size >= size90;
      const key = row.mom >= mom70 ? (big ? "wb" : "ws") : row.mom <= mom30 ? (big ? "lb" : "ls") : null;
      if (key) portfolios[key].members.push(member(row));
    }
    for (const item of Object.values(portfolios)) {
      item.n = item.members.length;
      item.ret = item.n >= options.minStocks ? weighted(item.members) : null;
    }
    const legs: number[] = [];
    if (portfolios.wb.ret !== null && portfolios.lb.ret !== null) legs.push(portfolios.wb.ret - portfolios.lb.ret);
    if (portfolios.ws.ret !== null && portfolios.ls.ret !== null) legs.push(portfolios.ws.ret - portfolios.ls.ret);
    wml = legs.length ? legs.reduce((sum, leg) => sum + leg, 0) / legs.length : null;
  }
  return { formed, month: formed + 1, universe: universe.length, ranked: ranked.length, breakpoints, portfolios, wml, market: weighted(marketMembers), marketN: marketMembers.length };
}

export interface FactorMonth {
  month: string;
  wml: number | null;
  market: number | null;
  wb: number | null;
  ws: number | null;
  lb: number | null;
  ls: number | null;
  universe: number;
  ranked: number;
  counts: { wb: number; ws: number; lb: number; ls: number };
  /** Breakpoints at the formation month's end. */
  breakpoints: FormedMonth["breakpoints"];
}

/** Our factor for every holding month from..to (month integers). Pure. */
export function buildFactors(stocks: StockMonths[], from: number, to: number, options: FactorOptions = IIMA_OPTIONS): FactorMonth[] {
  const out: FactorMonth[] = [];
  for (let month = from; month <= to; month += 1) {
    const formed = formMonth(stocks, month - 1, options);
    const p = formed.portfolios;
    out.push({
      month: monthKey(month),
      wml: formed.wml,
      market: formed.market,
      wb: p.wb.ret,
      ws: p.ws.ret,
      lb: p.lb.ret,
      ls: p.ls.ret,
      universe: formed.universe,
      ranked: formed.ranked,
      counts: { wb: p.wb.n, ws: p.ws.n, lb: p.lb.n, ls: p.ls.n },
      breakpoints: formed.breakpoints,
    });
  }
  return out;
}

/** Who moved a month's WML most: each member's signed share of it (½ × weight share × return, + winners, − losers). Pure. */
export function wmlContributions(formed: FormedMonth): Array<{ id: string; leg: "wb" | "ws" | "lb" | "ls"; contribution: number; ret: number; weightShare: number }> {
  const legs = (["wb", "lb", "ws", "ls"] as const).filter((leg) => formed.portfolios[leg].ret !== null);
  const pairs = Number(legs.includes("wb") && legs.includes("lb")) + Number(legs.includes("ws") && legs.includes("ls"));
  if (!pairs) return [];
  const out: Array<{ id: string; leg: "wb" | "ws" | "lb" | "ls"; contribution: number; ret: number; weightShare: number }> = [];
  for (const leg of legs) {
    const partner = leg === "wb" ? "lb" : leg === "lb" ? "wb" : leg === "ws" ? "ls" : "ws";
    if (!legs.includes(partner)) continue;
    const members = formed.portfolios[leg].members;
    const total = members.reduce((sum, member) => sum + member.weight, 0);
    const sign = leg.startsWith("w") ? 1 : -1;
    for (const member of members) {
      const weightShare = member.weight / total;
      out.push({ id: member.id, leg, contribution: (sign * weightShare * member.ret) / pairs, ret: member.ret, weightShare });
    }
  }
  return out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

// ---------- comparing two series ----------

export interface Comparison {
  n: number;
  from: string | null;
  to: string | null;
  correlation: number;
  /** Annualised standard deviation of the monthly difference. */
  trackingError: number;
  /** Annualised (× 12) arithmetic means and (× √12) volatilities. */
  meanOurs: number;
  meanTheirs: number;
  volOurs: number;
  volTheirs: number;
  /** OLS slope of ours on theirs. */
  beta: number;
}

const mean = (values: number[]) => values.reduce((sum, item) => sum + item, 0) / values.length;
const std = (values: number[]) => {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, item) => sum + (item - m) ** 2, 0) / (values.length - 1));
};

export function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

export interface Pair {
  month: string;
  ours: number;
  theirs: number;
}

/** Months where both series have a value, oldest first. */
export function pairUp(ours: Map<string, number | null>, theirs: Map<string, number | null>, from?: string, to?: string): Pair[] {
  const out: Pair[] = [];
  for (const [month, value] of ours) {
    const other = theirs.get(month);
    if (value === null || value === undefined || other === null || other === undefined) continue;
    if ((from && month < from) || (to && month > to)) continue;
    out.push({ month, ours: value, theirs: other });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month));
}

export function compare(pairs: Pair[]): Comparison {
  const ours = pairs.map((pair) => pair.ours);
  const theirs = pairs.map((pair) => pair.theirs);
  if (pairs.length < 3) return { n: pairs.length, from: pairs[0]?.month ?? null, to: pairs.at(-1)?.month ?? null, correlation: NaN, trackingError: NaN, meanOurs: NaN, meanTheirs: NaN, volOurs: NaN, volTheirs: NaN, beta: NaN };
  const diff = pairs.map((pair) => pair.ours - pair.theirs);
  const volTheirs = std(theirs);
  const corr = correlation(ours, theirs);
  return {
    n: pairs.length,
    from: pairs[0].month,
    to: pairs[pairs.length - 1].month,
    correlation: corr,
    trackingError: std(diff) * Math.sqrt(12),
    meanOurs: mean(ours) * 12,
    meanTheirs: mean(theirs) * 12,
    volOurs: std(ours) * Math.sqrt(12),
    volTheirs: volTheirs * Math.sqrt(12),
    beta: (corr * std(ours)) / volTheirs,
  };
}

/** Correlation over each trailing `window` months (labelled by the window's last month). */
export function rollingCorrelation(pairs: Pair[], window = 36): Array<{ month: string; correlation: number }> {
  const out: Array<{ month: string; correlation: number }> = [];
  for (let end = window; end <= pairs.length; end += 1) {
    const slice = pairs.slice(end - window, end);
    out.push({ month: slice[slice.length - 1].month, correlation: correlation(slice.map((pair) => pair.ours), slice.map((pair) => pair.theirs)) });
  }
  return out;
}

/** The months where ours and theirs differ most (absolute difference), largest first. */
export function largestGaps(pairs: Pair[], count = 10): Array<Pair & { gap: number }> {
  return pairs
    .map((pair) => ({ ...pair, gap: pair.ours - pair.theirs }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, count);
}
