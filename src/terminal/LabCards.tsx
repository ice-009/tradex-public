"use client";

import "./backtest.css";
import "./lab.css";
import "./labCard.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { LabCardResponse, LabCardsResponse, LabCardVariant, LabRequest } from "@/contracts/api";
import { api } from "@/client/api";
import type { HorizonReport, LabReport, SpreadPair } from "@/core/lab/engine";
import { isoDay, num, pct, share, turnoverRows } from "@/core/lab/format";
import type { SignalGroup } from "@/core/lab/signals";
import type { SignalVerdict, VerdictLabel } from "@/core/lab/verdict";
import { DecayBandChart, QuantileBars, SpreadEquityChart } from "./LabCardCharts";
import { cardHref } from "./labLinks";
import { LabTrials } from "./LabTrials";
import { RunStampBar, type Replay } from "./RunStampBar";

// Report cards (#23): /lab lists every Signal Lab signal with its latest
// verdict; /lab/<signal> is one signal's card — the plain-language verdict
// (src/core/lab/verdict.ts) and the evidence behind it: the long–short spread's
// equity curve, its decay, bucket returns, regimes, the 60/40 split, costs and
// turnover, sample sizes, data errors, the multiple-testing record and the run
// stamp. Cards read the variant's latest stored run (GET /api/lab/card); a run
// from the Lab tab or from here replaces it.


const GROUPS: Array<{ id: SignalGroup; label: string }> = [
  { id: "built-in", label: "Built-in signals" },
  { id: "sector", label: "Sector rotation" },
  { id: "screen", label: "Screens: matched vs the rest" },
  { id: "screen-score", label: "Screens: score among matches" },
];

const TONE: Record<VerdictLabel, string> = {
  works: "is-works",
  "works in uptrends only": "is-regime",
  "works in downtrends only": "is-regime",
  "no edge": "is-none",
  "too little data": "is-few",
};

const LABEL: Record<VerdictLabel, string> = {
  works: "Works",
  "works in uptrends only": "Works in uptrends only",
  "works in downtrends only": "Works in downtrends only",
  "no edge": "No edge",
  "too little data": "Too little data",
};

export function VerdictBadge({ verdict, small }: { verdict: SignalVerdict; small?: boolean }) {
  const luck = verdict.deflation === "fails" && verdict.preDeflation !== "no edge";
  return (
    <span className={`tx-card-badge ${TONE[verdict.label]}${luck ? " is-luck" : ""}${small ? " is-small" : ""}`} title={verdict.headline}>
      {LABEL[verdict.label]}
      {luck ? <span className="tx-card-badge-sub"> · likely luck</span> : null}
    </span>
  );
}

const paramsText = (params: Record<string, number>) =>
  Object.entries(params)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ") || "default parameters";

const runDate = (at: number) => new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Signed-in only: otherwise off to the sign-in page (as /health). */
function useSignedIn() {
  const { status } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === "unauthenticated") router.push("/auth/signin");
  }, [router, status]);
  return status === "authenticated";
}

function Shell({ title, back, children, aside }: { title: ReactNode; back: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="tx-health tx-card-page">
      <header className="tx-health-head">
        {back}
        <h1>{title}</h1>
        {aside}
      </header>
      {children}
    </div>
  );
}

const Boot = () => (
  <div className="tx-boot">
    <span className="tx-spinner" />
  </div>
);

// ------------------------------------------------------------------ /lab

export function LabCardsIndex() {
  const signedIn = useSignedIn();
  const [data, setData] = useState<LabCardsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    api
      .labCards(controller.signal)
      .then(setData)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't load the report cards.");
      });
    return () => controller.abort();
  }, [signedIn]);

  if (!signedIn) return <Boot />;
  const run = data?.cards.filter((card) => card.latest).length ?? 0;
  return (
    <Shell
      title="Report cards"
      back={
        <Link href="/" className="tx-health-back">
          ← Terminal
        </Link>
      }
      aside={data && <span className="tx-health-checked">{`${run} of ${data.cards.length} signals tested`}</span>}
    >
      <p className="tx-health-note">
        One card per Signal Lab signal: its latest run&apos;s verdict at the horizon with the highest net t-stat, judged against every variant tried for it (the deflated Sharpe
        ratio). Run a signal from the Lab tab, or open its card and run it there.
      </p>
      {error && <p className="tx-health-error">{error}</p>}
      {!data ? (
        !error && <p className="tx-dim">Loading…</p>
      ) : (
        GROUPS.map((group) => {
          const cards = data.cards.filter((card) => card.signal.group === group.id);
          if (!cards.length) return null;
          return (
            <section key={group.id} className="tx-health-card is-wide">
              <h2>{group.label}</h2>
              <div className="tx-lab-wrap">
                <table className="tx-bt-table tx-lab-table tx-card-index">
                  <thead>
                    <tr>
                      <th className="is-left">Signal</th>
                      <th className="is-left">Verdict</th>
                      <th title="The horizon the verdict is judged at (sessions)">Horizon</th>
                      <th className="is-left">Period</th>
                      <th title="Deflated Sharpe ratio of the variant at that horizon, and the trials it was judged against">DSR</th>
                      <th className="is-left">Last run</th>
                      <th title="Variants (parameter sets) with a stored report">Variants</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map(({ signal, latest }) => (
                      <tr key={signal.id} className={latest ? "" : "is-unrun"}>
                        <th className="is-left">
                          <Link href={cardHref(signal.id)} className="tx-card-link" title={signal.summary}>
                            {signal.group === "screen-score" ? signal.name.replace(/ \(score\)$/, "") : signal.name}
                          </Link>
                        </th>
                        <td className="is-left">{latest ? <VerdictBadge verdict={latest.verdict} small /> : <span className="tx-dim">Not run yet</span>}</td>
                        <td>{latest?.verdict.horizon ? `${latest.verdict.horizon}d` : "—"}</td>
                        <td className="is-left">{latest ? `${isoDay(latest.period.from)} – ${isoDay(latest.period.to)}` : "—"}</td>
                        <td>{latest?.verdict.dsr !== null && latest?.verdict.dsr !== undefined ? `${num(latest.verdict.dsr, 3)}${latest.verdict.trials ? ` · ${latest.verdict.trials} trials` : ""}` : "—"}</td>
                        <td className="is-left tx-dim">{latest ? runDate(latest.runAt) : ""}</td>
                        <td>{latest?.variants ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })
      )}
    </Shell>
  );
}

// ------------------------------------------------------------------ /lab/<signal>

/** What "Run it now" sends for a signal never run: the Lab tab's defaults (5 stored years, F&O list, 1/5/10/21 sessions, quintiles, futures costs). */
const defaultRequest = (signal: string): LabRequest => ({
  universe: "fno",
  signal,
  params: {},
  from: null,
  to: null,
  horizons: [1, 5, 10, 21],
  quantiles: 5,
  costPreset: "futures-2026",
});

export function LabCardPage({ signalId, variant: initialVariant }: { signalId: string; variant: string | null }) {
  const signedIn = useSignedIn();
  const router = useRouter();
  const [variant, setVariant] = useState<string | null>(initialVariant);
  const [data, setData] = useState<LabCardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [horizon, setHorizon] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    api
      .labCard(signalId, variant ?? undefined, controller.signal)
      .then((answer) => {
        setData(answer);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't load the report card.");
      });
    return () => controller.abort();
  }, [signedIn, signalId, variant, reload]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  const pickVariant = useCallback(
    (key: string) => {
      setVariant(key);
      setHorizon(null);
      router.replace(cardHref(signalId, key), { scroll: false });
    },
    [router, signalId],
  );

  const runNow = (request: LabRequest) => {
    setRunning(true);
    setElapsed(0);
    setRunError(null);
    api
      .lab(request)
      .then((answer) => {
        if (answer.status === "error") {
          setRunError(answer.error);
          return;
        }
        setHorizon(null);
        if (answer.report.signal.variantKey === variant) setReload((n) => n + 1);
        else pickVariant(answer.report.signal.variantKey);
      })
      .catch((cause: unknown) => setRunError(cause instanceof Error ? cause.message : "The Lab run failed."))
      .finally(() => setRunning(false));
  };

  if (!signedIn) return <Boot />;
  const card = data?.card ?? null;
  const back = (
    <span className="tx-card-crumbs">
      <Link href="/" className="tx-health-back">
        ← Terminal
      </Link>
      <Link href="/lab" className="tx-health-back">
        Report cards
      </Link>
    </span>
  );
  const runState = running ? (
    <span className="tx-dim">Running… {elapsed}s (a screen or a long period reads every stock&apos;s history: up to a minute or more)</span>
  ) : runError ? (
    <span className="tx-health-error">{runError}</span>
  ) : null;

  return (
    <Shell title={data?.signal.name ?? signalId} back={back} aside={card && <VerdictBadge verdict={card.verdicts.find((v) => v.horizon === card.primary) ?? card.verdicts[0]} />}>
      {error && <p className="tx-health-error">{error}</p>}
      {!data ? (
        !error && <p className="tx-dim">Loading…</p>
      ) : (
        <>
          <p className="tx-health-note">{data.signal.summary}</p>
          {!card ? (
            <section className="tx-health-why">
              <h2>Not run yet</h2>
              <p className="tx-health-note">
                No Lab run of this signal is stored. Run it with the Lab tab&apos;s defaults — the stored 5 years, the F&amp;O list, horizons 1, 5, 10 and 21 sessions, quintiles,
                futures costs — or from the Lab tab with your own settings.
              </p>
              <div className="tx-card-actions">
                <button type="button" className="tx-btn" disabled={running} onClick={() => runNow(defaultRequest(data.signal.id))}>
                  {running ? "Running…" : "Run it now"}
                </button>
                {runState}
              </div>
            </section>
          ) : (
            <CardBody
              data={data}
              card={card}
              horizon={horizon ?? card.primary}
              onHorizon={setHorizon}
              onVariant={pickVariant}
              onRun={() => runNow(card.stamp.params as unknown as LabRequest)}
              running={running}
              runState={runState}
            />
          )}
        </>
      )}
    </Shell>
  );
}

type Card = NonNullable<LabCardResponse["card"]>;

function CardBody({
  data,
  card,
  horizon,
  onHorizon,
  onVariant,
  onRun,
  running,
  runState,
}: {
  data: LabCardResponse;
  card: Card;
  horizon: number | null;
  onHorizon: (h: number) => void;
  onVariant: (key: string) => void;
  onRun: () => void;
  running: boolean;
  runState: ReactNode;
}) {
  const { report, stamp, variant } = card;
  const h = report.byHorizon.find((entry) => entry.horizon === horizon) ?? report.byHorizon[0];
  const verdict = card.verdicts.find((entry) => entry.horizon === h?.horizon) ?? card.verdicts[0];
  const top = report.signal.kind === "binary" ? "matched" : `Q${report.quantiles}`;
  const bottom = report.signal.kind === "binary" ? "rest" : "Q1";
  const replay = async (signal: AbortSignal): Promise<Replay> => {
    const answer = await api.replayLab({ stamp }, signal);
    return answer.status === "error" ? { error: answer.error } : { stamp: answer.stamp, result: answer.report };
  };

  return (
    <>
      <section className={`tx-card-verdict ${TONE[verdict.label]}${verdict.deflation === "fails" && verdict.preDeflation !== "no edge" ? " is-luck" : ""}`}>
        <div className="tx-card-verdict-head">
          <VerdictBadge verdict={verdict} />
          <span className="tx-dim">
            at {h?.horizon} session{h?.horizon === 1 ? "" : "s"}
            {h?.horizon === card.primary ? " (the horizon with the highest net t)" : ""}
          </span>
          <div className="tx-bt-seg tx-card-horizons" role="group" aria-label="Horizon">
            {report.byHorizon.map((entry) => {
              const v = card.verdicts.find((item) => item.horizon === entry.horizon);
              return (
                <button key={entry.horizon} type="button" className={entry.horizon === h?.horizon ? "is-active" : ""} title={v?.headline} onClick={() => onHorizon(entry.horizon)}>
                  {entry.horizon}d
                </button>
              );
            })}
          </div>
        </div>
        <p className="tx-card-headline">{verdict.headline}</p>
        <ul className="tx-card-reasons">
          {verdict.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p className="tx-health-small tx-dim">
          Rules: an edge is a net spread above zero with a Newey–West t above 2 over at least 30 days, positive in both the first 60% and the last 40% of the days; a regime-only
          verdict when one market regime carries it and the other loses; and it must clear a deflated Sharpe ratio of 0.95 after every variant and horizon tried for the signal.
        </p>
      </section>

      <section className="tx-health-card is-wide">
        <div className="tx-card-run">
          <span>
            <b>{paramsText(variant.params)}</b> · {variant.universe || "universe ?"} · {isoDay(report.period.from)} – {isoDay(report.period.to)} · {card.costs.label} · run{" "}
            {runDate(variant.runAt)}
          </span>
          {data.variants.length > 1 && (
            <label className="tx-card-variant">
              <span className="tx-dim">Variant</span>
              <select className="tx-input" value={variant.variantKey} onChange={(event) => onVariant(event.target.value)} aria-label="Variant">
                {data.variants.map((entry: LabCardVariant) => (
                  <option key={entry.variantKey} value={entry.variantKey}>
                    {paramsText(entry.params)} · {runDate(entry.runAt)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="tx-btn tx-btn-outline" disabled={running} onClick={onRun} title="Run this variant again with the same settings on the newest data; the card shows the new run">
            {running ? "Running…" : "Run again on the latest data"}
          </button>
        </div>
        {runState && <div className="tx-card-actions">{runState}</div>}
        <RunStampBar key={`${stamp.hash}:${stamp.resultHash}`} stamp={stamp} result={report} replay={replay} slow="Reading and computing again from scratch (no cache)." />
      </section>

      <SampleFacts report={report} h={h} />

      {h && (
        <div className="tx-health-grid is-two">
          <section className="tx-health-card is-wide">
            <h2>
              Equity curve of the long–short spread{" "}
              <span className="tx-dim tx-card-sub">
                {top} − {bottom}, net of costs, cumulative over non-overlapping {h.horizon}-session holds ({h.series?.net.length ?? 0} of them)
              </span>
            </h2>
            <SpreadEquityChart horizon={h} splitDate={h.split.splitDate} />
          </section>
          <section className="tx-health-card">
            <h2>
              Decay <span className="tx-dim tx-card-sub">net spread by horizon, ±2 Newey–West standard errors</span>
            </h2>
            <DecayBandChart decay={report.decay} horizons={report.horizons} selected={h.horizon} />
          </section>
          <section className="tx-health-card">
            <h2>
              Bucket returns <span className="tx-dim tx-card-sub">mean {h.horizon}-session return per bucket, gross</span>
            </h2>
            <QuantileBars report={report} horizon={h} />
          </section>
        </div>
      )}

      <div className="tx-health-grid is-two">
        <section className="tx-health-card">
          <h2>
            By market regime <span className="tx-dim tx-card-sub">NIFTY above / below its 200-day average on the formation day</span>
          </h2>
          <SplitTable report={report} selected={h?.horizon} cells={(entry) => [entry.regimes.up, entry.regimes.down]} heads={["NIFTY up", "NIFTY down"]} />
          {h && h.regimes.unknown > 0 && <p className="tx-health-small tx-dim">{h.regimes.unknown} days without a regime (no 200-day average yet).</p>}
        </section>
        <section className="tx-health-card">
          <h2>
            Over time <span className="tx-dim tx-card-sub">first 60% / last 40% of the days, split {isoDay(h?.split.splitDate)}</span>
          </h2>
          <SplitTable report={report} selected={h?.horizon} cells={(entry) => [entry.split.first, entry.split.last]} heads={["First 60%", "Last 40%"]} />
        </section>
      </div>

      <section className="tx-health-card is-wide">
        <h2>
          Costs and turnover <span className="tx-dim tx-card-sub">{pct(report.costPerTrade, 3)} a round trip per position on average ({card.costs.label}); the spread pays two</span>
        </h2>
        <CostsTable report={report} selected={h?.horizon} />
      </section>

      <div className="tx-health-grid is-two">
        <section className="tx-health-card">
          <h2>Multiple testing</h2>
          <LabTrials ideaId={report.signal.id} reloadKey={stamp.hash} />
        </section>
        <section className="tx-health-card">
          <h2>Data errors and notes</h2>
          <p className="tx-health-note">
            {report.dataErrors.bars
              ? `${report.dataErrors.bars} session${report.dataErrors.bars === 1 ? "" : "s"} moved more than ±${Math.round(report.dataErrors.maxDailyMove * 100)}% close to close: ${report.dataErrors.observations.toLocaleString("en-IN")} observations left out (${share(report.observations ? report.dataErrors.observations / report.observations : null, 2)}).`
              : `No session moved more than ±${Math.round(report.dataErrors.maxDailyMove * 100)}% close to close: no observations left out as data errors.`}
          </p>
          {report.dataErrors.symbols.length > 0 && (
            <p className="tx-health-small tx-dim">
              Worst: {report.dataErrors.symbols.slice(0, 10).map((entry) => `${entry.symbol} (${entry.bars})`).join(", ")}
              {report.dataErrors.symbols.length > 10 ? ", …" : ""}
            </p>
          )}
          {report.notes.length > 0 && (
            <ul className="tx-card-reasons">
              {report.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function SampleFacts({ report, h }: { report: LabReport; h: HorizonReport | undefined }) {
  const facts: Array<[string, ReactNode, string?]> = [
    ["Period", `${isoDay(report.period.from)} – ${isoDay(report.period.to)}`],
    ["Ranked sessions", `${report.period.days.toLocaleString("en-IN")} of ${report.period.sessions.toLocaleString("en-IN")}${report.period.skippedDays ? ` (${report.period.skippedDays} skipped)` : ""}`],
    ["Stocks", `${report.universe.symbols} · ${report.universe.perDay.mean.toFixed(0)} a day (${report.universe.perDay.min}–${report.universe.perDay.max})`],
    ["Observations", report.observations.toLocaleString("en-IN")],
    [`Spreads at ${h?.horizon ?? "?"}d`, h ? `${h.spread.net.n.toLocaleString("en-IN")} days · ${h.dsr.n} non-overlapping` : "—"],
    ["Delisted, closed at last close", report.truncated.toLocaleString("en-IN")],
    ["Data errors left out", report.dataErrors.observations.toLocaleString("en-IN"), report.dataErrors.observations ? "is-warn" : undefined],
    ["Buckets", `${report.quantiles} (${report.occupiedBuckets.toFixed(1)} occupied a day)`],
  ];
  return (
    <section className="tx-health-card is-wide">
      <h2>Sample</h2>
      <dl className="tx-health-facts tx-card-facts">
        {facts.map(([name, value, tone]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd className={tone}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const tone = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) || value === 0 ? "" : value > 0 ? "is-pos" : "is-neg");
const tCell = (t: number | null) => <td className={Math.abs(t ?? 0) >= 2 ? "tx-lab-strong" : ""}>{num(t)}</td>;

function SplitTable({ report, selected, cells, heads }: { report: LabReport; selected: number | undefined; cells: (h: HorizonReport) => SpreadPair[]; heads: string[] }) {
  return (
    <div className="tx-lab-wrap">
      <table className="tx-bt-table tx-lab-table">
        <thead>
          <tr>
            <th className="is-left">Horizon</th>
            {heads.map((head) => (
              <th key={head} colSpan={3}>
                {head}
              </th>
            ))}
          </tr>
          <tr>
            <th />
            {heads.map((head) => [
              <th key={`${head}-net`}>Net</th>,
              <th key={`${head}-t`}>t</th>,
              <th key={`${head}-n`}>Days</th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {report.byHorizon.map((h) => (
            <tr key={h.horizon} className={`is-static${h.horizon === selected ? " is-selected" : ""}`}>
              <th className="is-left">{h.horizon}d</th>
              {cells(h).map((pair, i) => [
                <td key={`${i}-net`} className={tone(pair.net.mean)}>
                  {pct(pair.net.mean, 3)}
                </td>,
                <td key={`${i}-t`} className={Math.abs(pair.net.t ?? 0) >= 2 ? "tx-lab-strong" : ""}>
                  {num(pair.net.t)}
                </td>,
                <td key={`${i}-n`} className="tx-dim">
                  {pair.net.n}
                </td>,
              ])}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostsTable({ report, selected }: { report: LabReport; selected: number | undefined }) {
  const daily = turnoverRows(report)[0]?.turnover;
  return (
    <div className="tx-lab-wrap">
      <table className="tx-bt-table tx-lab-table">
        <thead>
          <tr>
            <th className="is-left">Horizon</th>
            <th>Gross</th>
            <th title="After a full round trip on each leg every formation day">Net</th>
            <th>t (net)</th>
            <th title="Average round-trip cost of the long leg">Cost long</th>
            <th title="Average round-trip cost of the short leg">Cost short</th>
            <th title="Share of the long leg replaced since the last rebalance h sessions earlier">Turnover long</th>
            <th>Turnover short</th>
            <th title="If each leg is held between rebalances every h sessions and only replaced stocks pay costs">Net @ turnover</th>
            <th title="Net spread, non-overlapping, annualised">Sharpe / yr</th>
            <th title="Rank correlation of signal and forward return per day">IC</th>
          </tr>
        </thead>
        <tbody>
          {report.byHorizon.map((h) => (
            <tr key={h.horizon} className={`is-static${h.horizon === selected ? " is-selected" : ""}`}>
              <th className="is-left">{h.horizon}d</th>
              <td className={tone(h.spread.gross.mean)}>{pct(h.spread.gross.mean, 3)}</td>
              <td className={tone(h.spread.net.mean)}>{pct(h.spread.net.mean, 3)}</td>
              {tCell(h.spread.net.t)}
              <td>{share(h.cost.long, 3)}</td>
              <td>{share(h.cost.short, 3)}</td>
              <td>{share(h.turnover.long)}</td>
              <td>{share(h.turnover.short)}</td>
              <td className={tone(h.netAtTurnover)}>{pct(h.netAtTurnover, 3)}</td>
              <td>{num(h.sharpeAnnual)}</td>
              <td>{num(h.ic.mean, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {daily && (
        <p className="tx-health-small tx-dim">
          Daily turnover: {share(daily.long)} of the long leg and {share(daily.short)} of the short leg change from one session to the next.
        </p>
      )}
    </div>
  );
}
