"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompact, formatPrice } from "@/core/format";
import type { AnalyzedStock } from "@/contracts/api";
import { api } from "@/client/api";
import type { SetupScore } from "@/core/screener/score";
import type { TradePlan } from "@/core/screener/screens";
import { switchList, toggleShortlist, updateScreener, useTerminal } from "./store";
import { GROUP_LABEL, focusSetup, resultsNote, scorePlan, useScreenerFeed } from "@/client/screenerFeed";
import { lotsForRisk } from "@/core/market/futures";
import { openIdea } from "./ideaActions";
import { useLotSize } from "@/client/lotsFeed";
import { HOLD_BARS } from "@/core/screener/backtest";
import { drawPlanOnChart } from "./SetupCard";
import { ScoreChip } from "./ScoreBits";
import { OrderTicket } from "./OrderTicket";
import { SymbolLogo } from "./Watchlist";
import { usePrefs } from "./uiPrefs";
import { Icons } from "./icons";

const REFRESH_MS = 5 * 60 * 1000;
const MAX_COMPARE = 20;

interface Candidate {
  symbol: string;
  name: string;
  stock: AnalyzedStock;
  plan: TradePlan;
  /** Setup the plan comes from; null = levels read off the chart. */
  source: { screenId: string; name: string; group: string } | null;
  score: SetupScore;
  /** How many screener setups this stock matches. */
  setups: number;
}

const pct = (value: number, base: number) => `${value >= base ? "+" : ""}${(((value - base) / base) * 100).toFixed(1)}%`;

/** Rank the open list: best plan per stock (screener setups vs the chart's own levels), scored on 100. */
export function ComparePanel() {
  const lists = useTerminal((state) => state.lists);
  const activeListId = useTerminal((state) => state.activeListId);
  const height = useTerminal((state) => state.screener.height);
  const maximized = useTerminal((state) => state.screener.maximized);
  const list = lists.find((entry) => entry.id === activeListId) ?? lists[0];
  const symbols = useMemo(() => list.symbols.slice(0, MAX_COMPARE), [list.symbols]);
  const ideas = useScreenerFeed((feed) => feed.ideas);
  const track = useScreenerFeed((feed) => feed.track);
  const results = useScreenerFeed((feed) => feed.results);
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const [refreshKey, setRefreshKey] = useState(0);
  const key = symbols.join(",");
  // The last answer and the list it was for; anything else means "still scoring".
  const [loaded, setLoaded] = useState<{ key: string; stocks: AnalyzedStock[]; error: string | null } | null>(null);
  const stocks = useMemo(() => (!key ? [] : loaded?.key === key ? loaded.stocks : null), [key, loaded]);
  const error = loaded?.key === key ? loaded.error : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [ticket, setTicket] = useState<Candidate | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const load = () =>
      api
        .analyze(key.split(","))
        .then((json) => {
          if (!cancelled) setLoaded({ key, stocks: json.stocks ?? [], error: null });
        })
        .catch((error: unknown) => !cancelled && setLoaded({ key, stocks: [], error: error instanceof Error ? error.message : "Couldn't analyze the list." }));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, refreshKey]);

  const ranked = useMemo<Candidate[]>(() => {
    if (!stocks) return [];
    const out: Candidate[] = [];
    for (const stock of stocks) {
      if (stock.missing || !stock.facts || !stock.plan) continue;
      const idea = ideas.get(stock.symbol);
      const options = [
        { plan: stock.plan, source: null, score: scorePlan(stock.symbol, stock.facts, stock.plan, { warnings: stock.warnings, track, results }) },
        ...(idea?.hits ?? []).map((hit) => ({
          plan: hit.row.plan,
          source: { screenId: hit.screen.id, name: hit.screen.name, group: hit.screen.group },
          score: scorePlan(stock.symbol, hit.row.facts ?? stock.facts!, hit.row.plan, {
            screenId: hit.screen.id,
            group: hit.screen.group,
            warnings: hit.row.warnings,
            track,
            results,
          }),
        })),
      ];
      const best = options.sort((a, b) => b.score.total - a.score.total)[0];
      out.push({ symbol: stock.symbol, name: stock.name, stock, ...best, setups: idea?.hits.length ?? 0 });
    }
    return out.sort((a, b) => b.score.total - a.score.total);
  }, [stocks, ideas, track, results]);

  const missing = stocks?.filter((stock) => stock.missing).map((stock) => stock.symbol) ?? [];
  const factorKeys = ranked[0]?.score.parts.map((part) => ({ key: part.key, label: part.label, max: part.max })) ?? [];
  const best = ranked[0];
  const runnerUp = ranked[1];

  return (
    <section className="tx-scr tx-cmp" style={{ height: maximized ? undefined : `min(${height}px, 42vh)` }}>
      <header className="tx-scr-head">
        <span className="tx-cmp-title">Compare</span>
        <select className="tx-input tx-scr-universe" value={list.id} onChange={(event) => switchList(event.target.value)} aria-label="List to compare">
          {lists.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} ({entry.symbols.length})
            </option>
          ))}
        </select>
        <span className="tx-scr-status">
          {stocks === null ? "Scoring…" : `${ranked.length} scored${missing.length ? ` · ${missing.length} without history` : ""}${list.symbols.length > MAX_COMPARE ? ` · first ${MAX_COMPARE}` : ""}`}
        </span>
        <span className="tx-tb-spacer" />
        <button type="button" className="tx-icon-btn" title="Re-score" onClick={() => setRefreshKey((value) => value + 1)}>
          <Icons.reset size={15} />
        </button>
      </header>

      {best && (
        <div className="tx-cmp-verdict">
          <Icons.target size={16} />
          <span>
            <strong>{best.symbol}</strong> scores highest ({best.score.total}
            {runnerUp ? `, ${best.score.total - runnerUp.score.total} ahead of ${runnerUp.symbol}` : ""}) —{" "}
            {[...best.score.parts]
              .sort((a, b) => b.points / b.max - a.points / a.max)
              .slice(0, 2)
              .map((part) => part.label.toLowerCase())
              .join(" and ")}{" "}
            are its strongest points
            {best.score.penalties.length ? `; watch: ${best.score.penalties.map((p) => p.label.toLowerCase()).join(", ")}` : ""}.
          </span>
        </div>
      )}

      <div className="tx-cmp-body" ref={scrollRef}>
        {!symbols.length && <div className="tx-scr-state">This list is empty. Star stocks in the screener or pick another list.</div>}
        {error && <div className="tx-scr-state is-error">{error}</div>}
        {stocks === null && symbols.length > 0 && (
          <div className="tx-scr-skeleton">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} />
            ))}
          </div>
        )}
        {ranked.length > 0 && (
          <table className="tx-cmp-table">
            <thead>
              <tr>
                <th className="tx-cmp-rowhead">Rank</th>
                {ranked.map((candidate, index) => (
                  <th key={candidate.symbol} className={index === 0 ? "is-best" : ""}>
                    <div className="tx-cmp-head">
                      <span className="tx-cmp-rank">#{index + 1}</span>
                      <button type="button" className="tx-cmp-symbol" onClick={() => (candidate.source ? openIdea(candidate.symbol, candidate.source.screenId) : openIdea(candidate.symbol))} title={candidate.name}>
                        <SymbolLogo symbol={candidate.symbol} />
                        {candidate.symbol}
                      </button>
                      <ScoreChip score={candidate.score} size="lg" />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label="Price">
                {ranked.map((c) => (
                  <td key={c.symbol}>
                    {formatPrice(c.stock.close ?? 0)}{" "}
                    <span className={(c.stock.changePct ?? 0) >= 0 ? "is-up" : "is-down"}>{(c.stock.changePct ?? 0).toFixed(2)}%</span>
                  </td>
                ))}
              </Row>
              <Row label="Plan from">
                {ranked.map((c) => (
                  <td key={c.symbol} className="tx-cmp-source">
                    {c.source ? (
                      <span className={`tx-setup-badge tx-hz-${c.source.group}`}>
                        {GROUP_LABEL[c.source.group as keyof typeof GROUP_LABEL]} · {c.source.name}
                      </span>
                    ) : (
                      <span className="tx-tag">Chart levels{c.stock.facts?.pattern ? ` · ${c.stock.facts.pattern.name}` : ""}</span>
                    )}
                    {c.setups > 1 && <span className="tx-dim"> +{c.setups - 1} setups</span>}
                  </td>
                ))}
              </Row>
              <Row label="Entry">
                {ranked.map((c) => (
                  <td key={c.symbol}>
                    {c.plan.entry > (c.stock.close ?? 0) * 1.0005 && <span className="tx-dim">↑ </span>}
                    {formatPrice(c.plan.entry)}
                  </td>
                ))}
              </Row>
              <Row label="Stop">
                {ranked.map((c) => (
                  <td key={c.symbol} className="is-down">
                    {formatPrice(c.plan.stop)} <small>{pct(c.plan.stop, c.plan.entry)}</small>
                  </td>
                ))}
              </Row>
              <Row label="Target">
                {ranked.map((c) => (
                  <td key={c.symbol} className="is-up">
                    {c.plan.target !== null ? (
                      <>
                        {formatPrice(c.plan.target)} <small>{pct(c.plan.target, c.plan.entry)}</small>
                      </>
                    ) : (
                      "Trail"
                    )}
                  </td>
                ))}
              </Row>
              <Row label="R:R (to resistance)">
                {ranked.map((c) => (
                  <td key={c.symbol} className={c.score.resistanceInWay ? "is-warn" : ""} title={c.score.resistanceInWay ? `Resistance at ${formatPrice(c.score.resistanceInWay)} before the target` : undefined}>
                    {c.score.effectiveRR !== null ? `${c.score.effectiveRR.toFixed(1)}R` : "—"}
                  </td>
                ))}
              </Row>
              <Row label="Trail stop">
                {ranked.map((c) => (
                  <td key={c.symbol}>{c.stock.facts && Number.isFinite(c.stock.facts.chandelier) ? formatPrice(c.stock.facts.chandelier) : "—"}</td>
                ))}
              </Row>
              <Row label="Lots (futures)">
                {ranked.map((c) => (
                  <LotsCell key={c.symbol} symbol={c.symbol} risk={c.plan.entry - c.plan.stop} maxLoss={(capital * riskPct) / 100} capital={capital} />
                ))}
              </Row>
              <Row label="Results">
                {ranked.map((c) => {
                  const note = resultsNote(results?.bySymbol.get(c.symbol), 30);
                  return (
                    <td key={c.symbol} className={note?.soon ? "is-warn" : ""}>
                      {note ? note.text : <span className="tx-dim">—</span>}
                    </td>
                  );
                })}
              </Row>
              <tr className="tx-cmp-section">
                <th className="tx-cmp-rowhead">Points</th>
                <td colSpan={ranked.length} />
              </tr>
              {factorKeys.map((factor) => (
                <Row key={factor.key} label={`${factor.label} /${factor.max}`}>
                  {ranked.map((c) => {
                    const part = c.score.parts.find((entry) => entry.key === factor.key)!;
                    const top = Math.max(...ranked.map((other) => other.score.parts.find((entry) => entry.key === factor.key)!.points));
                    return (
                      <td key={c.symbol} title={part.detail} className={part.points === top && ranked.length > 1 ? "is-top" : ""}>
                        <span className="tx-cmp-pts">
                          <i style={{ width: `${(part.points / part.max) * 100}%` }} />
                          <b>{part.points}</b>
                        </span>
                        <span className="tx-cmp-detail">{part.detail}</span>
                      </td>
                    );
                  })}
                </Row>
              ))}
              <Row label="Penalties">
                {ranked.map((c) => (
                  <td key={c.symbol} className={c.score.penalties.length ? "is-warn" : ""}>
                    {c.score.penalties.length ? c.score.penalties.map((p) => `${p.points} ${p.label}`).join(" · ") : <span className="tx-dim">none</span>}
                  </td>
                ))}
              </Row>
              <Row label="">
                {ranked.map((c) => (
                  <td key={c.symbol} className="tx-cmp-actions">
                    <button
                      type="button"
                      className="tx-btn-small"
                      onClick={() => {
                        if (c.source) focusSetup(c.symbol, c.source.screenId);
                        openIdea(c.symbol, c.source?.screenId);
                      }}
                    >
                      Chart
                    </button>
                    <button
                      type="button"
                      className="tx-btn-outline"
                      title="Save this plan on the chart as a Long Position"
                      onClick={() => {
                        const idea = ideas.get(c.symbol);
                        const hit = idea?.hits.find((entry) => entry.screen.id === c.source?.screenId);
                        if (hit) drawPlanOnChart(hit);
                        openIdea(c.symbol, c.source?.screenId);
                      }}
                      disabled={!c.source}
                    >
                      <Icons.long size={14} />
                    </button>
                    <button
                      type="button"
                      className="tx-btn-outline"
                      title="Order ticket: entry and GTT OCO exit values"
                      onClick={() => setTicket(c)}
                    >
                      <Icons.ticket size={14} />
                    </button>
                    <button type="button" className="tx-btn-outline" title="Remove from this list" onClick={() => toggleShortlist(c.symbol)}>
                      <Icons.x size={14} />
                    </button>
                  </td>
                ))}
              </Row>
            </tbody>
          </table>
        )}
        {missing.length > 0 && (
          <p className="tx-cmp-note">
            No cached daily history yet for {missing.join(", ")} — they&apos;ll score once a screener universe that contains them has synced.{" "}
            <button type="button" className="tx-scr-clear" onClick={() => updateScreener({ view: "screener", universe: "nifty500" })}>
              Sync Nifty 500
            </button>
          </p>
        )}
        <p className="tx-cmp-note">
          Score = trend 15 + relative strength 15 + accumulation 10 + pattern 15 + reward:risk 15 + stop distance 10 + not extended 10 + track record 10, minus penalties.
          Each stock is scored on its best plan (its screener setups, or levels read off the chart). A ranking aid, not advice.
        </p>
      </div>
      {ticket && (
        <OrderTicket
          symbol={ticket.symbol}
          plan={ticket.plan}
          close={ticket.stock.close ?? ticket.plan.entry}
          setupName={ticket.source ? ticket.source.name : "Chart levels"}
          holdDays={ticket.source ? HOLD_BARS[ticket.source.group as keyof typeof HOLD_BARS] : 15}
          onClose={() => setTicket(null)}
        />
      )}
    </section>
  );
}

/** Lots that fit the max loss for one candidate (lot size per stock, so it's its own component). */
function LotsCell({ symbol, risk, maxLoss, capital }: { symbol: string; risk: number; maxLoss: number; capital: number }) {
  const { lot } = useLotSize(symbol);
  if (!lot) return <td className="tx-dim">lot n/a</td>;
  const { lots, riskPerLot } = lotsForRisk(maxLoss, risk, lot);
  return (
    <td className={lots === 0 ? "is-warn" : ""} title={`Lot ${lot} · one lot risks ₹${formatCompact(riskPerLot)} (${((riskPerLot / capital) * 100).toFixed(1)}% of capital)`}>
      {lots} × {lot} <small className="tx-dim">· risks ₹{formatCompact(lots * riskPerLot)}</small>
    </td>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th className="tx-cmp-rowhead">{label}</th>
      {children}
    </tr>
  );
}
