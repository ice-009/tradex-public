// `npm run research -- iima-check`: our momentum (WML) and market factors,
// rebuilt from the hub's NSE archive, against IIM Ahmedabad's published
// factors (issue #25). See docs/research/iima-factor-check.md for the method
// and the findings; src/core/research/iima.ts for the computation.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { HubClient } from "@/server/providers/hub/client";
import { hubConfig } from "@/server/providers/hub/config";
import {
  IIMA_OPTIONS,
  adjustedJumps,
  buildFactors,
  compare,
  compoundToMonths,
  formMonth,
  largestGaps,
  missedFactors,
  gapFactors,
  monthKey,
  monthOf,
  pairUp,
  parseIimaBreakpoints,
  parseIimaFactors,
  parseIimaPortfolios,
  parseMonth,
  rollingCorrelation,
  wmlContributions,
  type Comparison,
  type FactorMonth,
  type FactorOptions,
  type Jump,
  type MissedFactor,
  type Pair,
  type StockMonths,
  stockMonths,
} from "@/core/research/iima";
import { IIMA_PAGE, hubCorporateActions, hubSet, iimaFiles, nseMonthSamples, type CorporateAction, type RawSeries } from "./iimaData";

export const IIMA_USAGE = `    --from YYYY-MM     first holding month compared (default 1996-01; NSE opened Nov 1994)
    --to YYYY-MM       last (default: IIMA's last month)
    --weights value|ew portfolio weights for the headline (default value: median daily traded value)
    --refresh          look for a newer IIMA release
    --fetch-only       download (and cache) the inputs, compute nothing
    --json <file>      also write every month's numbers
    --report <file>    where to write the Markdown tables (default .cache/research/iima/report.md)`;

const CACHE = path.join(process.cwd(), ".cache", "research", "iima");
const say = (text: string) => process.stderr.write(`${text}\n`);
const pct = (x: number | null | undefined, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(digits)}%`);
const num = (x: number | null | undefined, digits = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(digits));
const isoDay = (day: number) => new Date(day).toISOString().slice(0, 10);

/** Not companies: ETFs and other funds (ISIN INF…, or the usual ticker shapes). */
const FUND = /(BEES|ETF|IETF|^SGB|^GOLD[A-Z]*$|SLVR$|^NEXT50|^LIQUID|NIFTY|SENSEX|^MAFANG|^MON100|^MOM\d|^N100|^BBETF|^ICICI[A-Z0-9]*$)/;

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--refresh" || key === "--fetch-only") {
      args[key.slice(2)] = "1";
      continue;
    }
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) throw new Error(`Unexpected argument ${key}\n\n${IIMA_USAGE}`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

interface Universe {
  symbols: string[];
  funds: string[];
  months: number;
  sampled: Array<{ month: string; date: string | null; rows: number }>;
}

async function universe(lastMonth: string): Promise<Universe> {
  const samples = await nseMonthSamples(CACHE, "1994-11", lastMonth);
  const fundIsin = new Set<string>();
  const all = new Set<string>();
  for (const sample of samples)
    for (const row of sample.rows) {
      all.add(row.symbol);
      if (row.isin?.startsWith("INF")) fundIsin.add(row.symbol);
    }
  const funds = [...all].filter((symbol) => fundIsin.has(symbol) || FUND.test(symbol)).sort();
  const fundSet = new Set(funds);
  return { symbols: [...all].filter((symbol) => !fundSet.has(symbol)).sort(), funds, months: samples.length, sampled: samples.map((sample) => ({ month: sample.month, date: sample.date, rows: sample.rows.length })) };
}

/** One series per listing: the hub answers an old ticker with the whole listing too. */
function dedupe(series: Map<string, RawSeries>): Map<string, RawSeries> {
  const byListing = new Map<string, { symbol: string; item: RawSeries }>();
  for (const [symbol, item] of series) {
    const key = `${item.names.join(">")}@${item.t[0]}`;
    const seen = byListing.get(key);
    if (!seen || item.t.length > seen.item.t.length) byListing.set(key, { symbol, item });
  }
  return new Map([...byListing.values()].map(({ symbol, item }) => [symbol, item]));
}

export async function runIimaCheck(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const config = hubConfig(process.env);
  if (!config) throw new Error("HUB_URL and HUB_KEY are needed (the hub's NSE archive is the data being checked).");
  const client = new HubClient({ ...config, timeoutMs: 300_000 }, { retries: 3, maxRetryWaitMs: 60_000 });

  // 1. IIMA's files.
  const iima = await iimaFiles(CACHE, Boolean(args.refresh));
  const theirFactors = parseIimaFactors(iima.monthly);
  const theirDaily = parseIimaFactors(iima.daily);
  const theirPortfolios = parseIimaPortfolios(iima.portfolios);
  const theirBreakpoints = parseIimaBreakpoints(iima.breakpoints);
  const lastTheirs = theirFactors.at(-1)!.month;
  say(`IIMA release ${iima.release}: ${theirFactors[0].month}..${lastTheirs}`);

  // 2. The cash universe, from NSE's month-end bhavcopies.
  const lastComplete = monthKey(monthOf(Date.now()) - 1);
  const cash = await universe(lastComplete);
  say(`Universe: ${cash.symbols.length} NSE tickers (EQ/BE) in ${cash.months} month-end bhavcopies; ${cash.funds.length} funds/ETFs left out`);

  // 3. The hub's bars, as traded, and its factors.
  const to = Date.UTC(Number(lastComplete.slice(0, 4)), Number(lastComplete.slice(5, 7)), 0);
  const hub = await hubSet(client, cash.symbols, Date.UTC(1994, 10, 1), to, CACHE);
  const series = dedupe(hub.series);
  say(`Hub: ${hub.series.size} series (${series.size} listings after joining renames), ${hub.unknown.length} unknown`);
  if (args["fetch-only"]) return 0;

  // 4. Months, the jumps no factor explains, and the splits/bonuses NSE lists that have no factor.
  const actions = await hubCorporateActions(client, Date.UTC(2010, 0, 1), to, CACHE);
  const actionsBy = new Map<string, CorporateAction[]>();
  for (const action of actions) actionsBy.set(action.symbol, [...(actionsBy.get(action.symbol) ?? []), action]);
  const stocks: StockMonths[] = [];
  const repaired: StockMonths[] = [];
  const gapRepaired: StockMonths[] = [];
  const jumps: Jump[] = [];
  type Found = MissedFactor & { id: string; value: number };
  const missed: Found[] = [];
  const gapped: Found[] = [];
  /** Median daily traded value over the year before `day` (how much the stock mattered). */
  const tradedBefore = (item: RawSeries, day: number) => {
    const i = item.t.indexOf(day);
    const values: number[] = [];
    for (let k = Math.max(0, i - 250); k < i; k += 1) values.push(item.c[k] * item.v[k]);
    values.sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : 0;
  };
  for (const [symbol, item] of series) {
    const factors = hub.factors.get(symbol) ?? [];
    const months = stockMonths(symbol, item.t, item.c, item.v, factors);
    if (!months) continue;
    stocks.push(months);
    jumps.push(...adjustedJumps(symbol, item.t, item.c, factors));
    const listed = item.names.flatMap((name) => actionsBy.get(name) ?? []);
    const extra = missedFactors(item.t, item.c, factors, listed);
    for (const factor of extra) missed.push({ ...factor, id: symbol, value: tradedBefore(item, factor.day) });
    repaired.push(extra.length ? stockMonths(symbol, item.t, item.c, item.v, [...factors, ...extra])! : months);
    const gaps = gapFactors(item.t, item.c, [...factors, ...extra]);
    for (const factor of gaps) gapped.push({ ...factor, id: symbol, value: tradedBefore(item, factor.day) });
    gapRepaired.push(extra.length || gaps.length ? stockMonths(symbol, item.t, item.c, item.v, [...factors, ...extra, ...gaps])! : months);
  }
  say(`Missed splits/bonuses (NSE lists them, no hub factor): ${missed.length} in ${new Set(missed.map((item) => item.id)).size} stocks; split-like price gaps: ${gapped.length}`);

  const from = parseMonth(args.from ?? "1996-01");
  const until = parseMonth(args.to ?? (lastTheirs < lastComplete ? lastTheirs : lastComplete));
  const headline = (args.weights ?? "value") as FactorOptions["weighting"];
  if (headline !== "value" && headline !== "ew") throw new Error("--weights is value or ew");
  const runs: Record<string, FactorMonth[]> = {
    value: buildFactors(stocks, from, until, { ...IIMA_OPTIONS, weighting: "value" }),
    ew: buildFactors(stocks, from, until, { ...IIMA_OPTIONS, weighting: "ew" }),
    valueRepaired: buildFactors(repaired, from, until, { ...IIMA_OPTIONS, weighting: "value" }),
    ewRepaired: buildFactors(repaired, from, until, { ...IIMA_OPTIONS, weighting: "ew" }),
    valueGaps: buildFactors(gapRepaired, from, until, { ...IIMA_OPTIONS, weighting: "value" }),
    ewGaps: buildFactors(gapRepaired, from, until, { ...IIMA_OPTIONS, weighting: "ew" }),
  };

  // 5. Compare.
  const theirWml = new Map(theirFactors.map((row) => [row.month, row.wml]));
  const theirMf = new Map(theirFactors.map((row) => [row.month, row.mf]));
  const rf = new Map(theirFactors.map((row) => [row.month, row.rf]));
  const dailyWml = compoundToMonths(theirDaily.map((row) => ({ date: row.month, value: row.wml })));
  const ourWml = (run: FactorMonth[]) => new Map(run.map((row) => [row.month, row.wml]));
  const ourMf = (run: FactorMonth[]) => new Map(run.map((row) => [row.month, row.market === null || rf.get(row.month) == null ? null : row.market - rf.get(row.month)!]));

  const periods: Array<[string, string | undefined, string | undefined]> = [
    ["all", undefined, undefined],
    ["1996–2000", "1996-01", "2000-12"],
    ["2001–2010", "2001-01", "2010-12"],
    ["2011–2020", "2011-01", "2020-12"],
    ["2021–", "2021-01", undefined],
  ];
  const table: Array<{ series: string; weights: string; period: string; c: Comparison }> = [];
  for (const weights of ["value", "ew"] as const) {
    const run = runs[weights];
    for (const [period, a, b] of periods) {
      table.push({ series: "WML", weights, period, c: compare(pairUp(ourWml(run), theirWml, a, b)) });
      table.push({ series: "Market − Rf", weights, period, c: compare(pairUp(ourMf(run), theirMf, a, b)) });
    }
    for (const leg of ["wb", "ws", "lb", "ls"] as const) {
      table.push({ series: leg.toUpperCase(), weights, period: "all", c: compare(pairUp(new Map(run.map((row) => [row.month, row[leg]])), new Map(theirPortfolios.map((row) => [row.month, row[leg]])))) });
    }
    const fixed = runs[weights === "value" ? "valueRepaired" : "ewRepaired"];
    for (const [period, a, b] of periods.filter(([, a]) => !a || a >= "2011")) {
      table.push({ series: "WML, listed splits fixed", weights, period, c: compare(pairUp(ourWml(fixed), theirWml, a, b)) });
    }
    const gapped = runs[weights === "value" ? "valueGaps" : "ewGaps"];
    for (const [period, a, b] of periods) {
      table.push({ series: "WML, every split-like gap fixed", weights, period, c: compare(pairUp(ourWml(gapped), theirWml, a, b)) });
      table.push({ series: "Market − Rf, every split-like gap fixed", weights, period, c: compare(pairUp(ourMf(gapped), theirMf, a, b)) });
    }
  }
  const run = runs[headline];
  const wmlPairs = pairUp(ourWml(run), theirWml);
  const mktPairs = pairUp(ourMf(run), theirMf);
  const rolling = rollingCorrelation(wmlPairs, 36);
  const rollingMkt = rollingCorrelation(mktPairs, 36);
  const bp = new Map(theirBreakpoints.map((row) => [row.month, row]));
  // Breakpoints are dated by formation month; ours are stored on the holding month.
  const bpPairs = (key: "mom30" | "mom70"): Pair[] =>
    run.flatMap((row) => {
      const formed = monthKey(parseMonth(row.month) - 1);
      const theirs = bp.get(formed)?.[key];
      const ours = row.breakpoints?.[key];
      return theirs === null || theirs === undefined || ours === undefined ? [] : [{ month: formed, ours, theirs }];
    });

  // 6. The months that differ most, and who drives them.
  const gaps = largestGaps(wmlPairs, 12);
  const jumpsBy = new Map<string, Jump[]>();
  for (const jump of jumps) jumpsBy.set(jump.id, [...(jumpsBy.get(jump.id) ?? []), jump]);
  // The six largest gaps, and the two largest of each later period (whose data is newest).
  const toInvestigate = [...gaps.slice(0, 6)];
  for (const [, a, b] of periods.slice(2))
    for (const gap of largestGaps(pairUp(ourWml(run), theirWml, a, b), 2)) if (!toInvestigate.some((item) => item.month === gap.month)) toInvestigate.push(gap);
  const investigated = toInvestigate.map((gap) => {
    const holding = parseMonth(gap.month);
    const formed = formMonth(stocks, holding - 1, { ...IIMA_OPTIONS, weighting: headline });
    const drivers = wmlContributions(formed)
      .slice(0, 8)
      .map((driver) => {
        // Jumps inside the momentum window (months t−11..t−1 and the formation month) or the holding month.
        const near = (jumpsBy.get(driver.id) ?? []).filter((jump) => monthOf(jump.day) >= holding - 13 && monthOf(jump.day) <= holding);
        return { ...driver, jumps: near.map((jump) => `${isoDay(jump.day)} ${num(jump.prevClose)}→${num(jump.close)} (${pct(jump.ret, 0)})`) };
      });
    return { ...gap, universe: formed.universe, counts: Object.fromEntries(Object.entries(formed.portfolios).map(([key, item]) => [key, item.n])), drivers };
  });

  // 7. Report.
  const lines: string[] = [];
  lines.push(`# IIMA factor check — ${new Date().toISOString().slice(0, 10)}`, "");
  lines.push(`IIMA release ${iima.release} (${IIMA_PAGE}), survivorship-bias-adjusted monthly factors. Ours: ${series.size} NSE listings from the hub's cash archive (${cash.symbols.length} tickers seen in ${cash.months} month-end bhavcopies, ${cash.funds.length} funds/ETFs left out, ${hub.unknown.length} unknown to the hub), adjusted with the hub's split/bonus factors. Headline weights: ${headline === "value" ? "median daily traded value (IIMA: market cap)" : "equal"}.`, "");
  lines.push("| Series | Weights | Period | Months | Correlation | Tracking error /yr | Mean ours /yr | Mean IIMA /yr | Vol ours /yr | Vol IIMA /yr | Beta |", "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of table) lines.push(`| ${row.series} | ${row.weights === "value" ? "traded value" : "equal"} | ${row.period} | ${row.c.n} | ${num(row.c.correlation)} | ${pct(row.c.trackingError)} | ${pct(row.c.meanOurs)} | ${pct(row.c.meanTheirs)} | ${pct(row.c.volOurs)} | ${pct(row.c.volTheirs)} | ${num(row.c.beta)} |`);
  lines.push("");
  const bp30 = compare(bpPairs("mom30"));
  const bp70 = compare(bpPairs("mom70"));
  lines.push(`Momentum breakpoints (12-1 return of the 30th/70th percentile stock at each formation month): correlation ${num(bp30.correlation)} / ${num(bp70.correlation)}; average ours ${pct(bp30.meanOurs / 12)} / ${pct(bp70.meanOurs / 12)}, IIMA ${pct(bp30.meanTheirs / 12)} / ${pct(bp70.meanTheirs / 12)}.`, "");
  const monthlyVsDaily = compare(pairUp(theirWml, dailyWml));
  lines.push(`(IIMA's monthly WML vs its own daily WML compounded: correlation ${num(monthlyVsDaily.correlation, 4)}.)`, "");
  const yearsOf = (points: Array<{ month: string; correlation: number }>) => points.filter((point) => point.month.endsWith("-12")).map((point) => `${point.month.slice(0, 4)} ${num(point.correlation)}`);
  lines.push(`Rolling 36-month WML correlation (December of each year): ${yearsOf(rolling).join(", ")}.`, "");
  lines.push(`Rolling 36-month market correlation (December of each year): ${yearsOf(rollingMkt).join(", ")}.`, "");
  const minRolling = rolling.reduce((low, point) => (point.correlation < low.correlation ? point : low), rolling[0]);
  if (minRolling) lines.push(`Lowest rolling WML correlation: ${num(minRolling.correlation)} (36 months to ${minRolling.month}).`, "");
  lines.push("Largest monthly WML differences:", "", "| Month | Ours | IIMA | Gap | Universe | WB/WS/LB/LS |", "|---|---:|---:|---:|---:|---|");
  for (const gap of gaps) {
    const row = run.find((item) => item.month === gap.month)!;
    lines.push(`| ${gap.month} | ${pct(gap.ours)} | ${pct(gap.theirs)} | ${pct(gap.gap)} | ${row.universe} | ${row.counts.wb}/${row.counts.ws}/${row.counts.lb}/${row.counts.ls} |`);
  }
  lines.push("");
  for (const item of investigated) {
    lines.push(`### ${item.month}: ours ${pct(item.ours)}, IIMA ${pct(item.theirs)}`, "", "| Stock | Leg | Weight in leg | Month return | Share of our WML | Jumps (window or month) |", "|---|---|---:|---:|---:|---|");
    for (const driver of item.drivers) lines.push(`| ${driver.id} | ${driver.leg.toUpperCase()} | ${pct(driver.weightShare)} | ${pct(driver.ret)} | ${pct(driver.contribution, 2)} | ${driver.jumps.join("; ") || ""} |`);
    lines.push("");
  }
  lines.push(`Splits and bonuses in NSE's corporate-actions file (2010 on) with no hub factor, the price falling by a standard ratio that day: ${missed.length} in ${new Set(missed.map((item) => item.id)).size} stocks. Most traded:`, "", "| Stock | Ex-date | Close before → on | Factor | NSE purpose |", "|---|---|---|---:|---|");
  for (const item of [...missed].sort((a, b) => b.value - a.value).slice(0, 25)) lines.push(`| ${item.id} | ${isoDay(item.day)} | ${num(item.prevClose)} → ${num(item.close)} | ${num(item.factor, 4)} | ${item.purpose} |`);
  lines.push("");
  const byEra = (items: Found[]) =>
    periods
      .slice(1)
      .map(([label, a, b]) => `${label} ${items.filter((item) => isoDay(item.day) >= `${a}-01` && (!b || isoDay(item.day) <= `${b}-31`)).length}`)
      .join(", ");
  lines.push(`Split-like price gaps with no factor (a fall to a standard split/bonus ratio from one session to the next, and the price staying there): ${gapped.length} in ${new Set(gapped.map((item) => item.id)).size} stocks (${byEra(gapped)}; before ${periods[1][1]}: ${gapped.filter((item) => isoDay(item.day) < "1996-01-01").length}). Most traded before 2010 (no corporate-actions file to confirm them):`, "", "| Stock | Date | Close before → on | Ratio |", "|---|---|---|---:|");
  for (const item of gapped.filter((found) => isoDay(found.day) < "2010-01-01").sort((a, b) => b.value - a.value).slice(0, 15)) lines.push(`| ${item.id} | ${isoDay(item.day)} | ${num(item.prevClose)} → ${num(item.close)} | ${num(item.factor, 4)} |`);
  lines.push("");
  const unexplained = jumps.filter((jump) => jump.ret < -0.45);
  lines.push(`Adjusted one-day falls beyond −45% (a split or bonus without a factor, or a bad print): ${unexplained.length} across ${new Set(unexplained.map((jump) => jump.id)).size} stocks. Largest-weight ones are listed by \`--json\`.`, "");
  const report = lines.join("\n");
  console.log(report);
  const reportFile = args.report ?? path.join(CACHE, "report.md");
  writeFileSync(reportFile, `${report}\n`);
  say(`Wrote ${reportFile}`);
  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        { iima: { release: iima.release, urls: iima.urls }, universe: cash, unknown: hub.unknown, table, runs, rolling, rollingMkt, breakpoints: { mom30: bpPairs("mom30"), mom70: bpPairs("mom70") }, gaps, investigated, jumps: jumps.map((jump) => ({ ...jump, date: isoDay(jump.day) })), missed: missed.map((item) => ({ ...item, date: isoDay(item.day) })), gapped: gapped.map((item) => ({ ...item, date: isoDay(item.day) })) },
        null,
        1,
      ),
    );
    say(`Wrote ${args.json}`);
  }
  return 0;
}
