"use client";

import { useState } from "react";
import { useLiveTick } from "./LivePrice";
import { planStatus } from "@/core/screener/planStatus";
import type { Drawing } from "@/chart/types";
import { formatCompact, formatPrice } from "@/core/format";
import { HOLD_BARS, verdictFor } from "@/core/screener/backtest";
import { GROUP_LABEL, focusSetup, focusedHit, resultsNote, scoreHit, useIdea, useScreenerFeed, type SetupHit } from "@/client/screenerFeed";
import { lotsForRisk } from "@/core/market/futures";
import { useLotSize } from "@/client/lotsFeed";
import { ScoreBreakdown, ScoreChip } from "./ScoreBits";
import { OrderTicket } from "./OrderTicket";
import { addPlanAlerts } from "./Alerts";
import { getState, toggleShortlist, useTerminal } from "./store";
import { commitDrawings } from "./drawingHistory";
import { setSizing, toggleShowPlans, usePrefs } from "./uiPrefs";
import { Icons } from "./icons";
import { DAY_MS } from "@/core/market/session";

/** Below this R:R a setup is flagged (Varsity: R:R ≥ 1.5). */
const MIN_RR = 1.5;
const RISK_PRESETS = [0.5, 1, 1.5, 2];

/** Save the plan as a Long Position drawing on the stock (it then shows on every timeframe). */
export function drawPlanOnChart(hit: SetupHit) {
  const { row, screen } = hit;
  const { entry, stop } = row.plan;
  const risk = entry - stop;
  if (!(risk > 0)) return;
  const target = row.plan.target ?? entry + 2 * risk;
  // Weekends make ~1.45 calendar days per trading session.
  const endTime = row.date + Math.round(Math.max(3, HOLD_BARS[screen.group]) * 1.45) * DAY_MS;
  const drawing: Drawing = {
    id: `d-scr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: "long",
    color: "#2962ff",
    points: [
      { t: row.date, p: entry },
      { t: endTime, p: target },
      { t: endTime, p: stop },
    ],
  };
  commitDrawings(row.symbol, [...(getState().drawings[row.symbol] ?? []), drawing]);
}

const pct = (value: number, base: number) => `${value >= base ? "+" : ""}${(((value - base) / base) * 100).toFixed(2)}%`;

/** Sidebar card for the active symbol's screener setup: plan, its track record, and position size. */
export function SetupCard({ symbol }: { symbol: string }) {
  const idea = useIdea(symbol);
  const focus = useScreenerFeed((feed) => feed.focus);
  const track = useScreenerFeed((feed) => feed.track);
  const showPlans = usePrefs((prefs) => prefs.showPlans);
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const [saved, setSaved] = useState<string | null>(null);
  const [showScore, setShowScore] = useState(false);
  const [ticket, setTicket] = useState(false);
  const [alertsAdded, setAlertsAdded] = useState<number | null>(null);
  const results = useScreenerFeed((feed) => feed.results);
  const { lot } = useLotSize(symbol);
  const shortlisted = useTerminal((state) => state.watchlist.includes(symbol));
  const tick = useLiveTick(symbol);

  if (!idea) return null;
  const hit = focusedHit(idea, focus);
  const { plan, live } = hit.row;
  const risk = plan.entry - plan.stop;
  const rr = hit.rr;
  const buyStop = plan.entry > hit.row.close * 1.0005;
  // The plan was made at the last scan: check it against the live price.
  const status = tick ? planStatus(plan, hit.row.close, tick.ltp, hit.row.facts?.atr14 ?? NaN) : null;

  // Size by the most this trade may lose at the stop, capped by the capital itself.
  // Futures: size in lots from the max loss (the margin, not the contract value, comes out of capital).
  const maxLoss = (capital * riskPct) / 100;
  const sizing = lot ? lotsForRisk(maxLoss, risk, lot) : null;
  const lots = sizing?.lots ?? 0;
  const qty = lot ? lots * lot : 0;

  const record = track?.screens?.[hit.screen.id];
  const facts = hit.row.facts ?? null;
  const score = scoreHit(hit, track, results);
  const own = track?.bySymbol?.[hit.screen.id]?.[symbol];
  const ownVerdict = own ? verdictFor(own, record?.planR ?? null) : null;

  return (
    <div className="tx-setup">
      <div className="tx-setup-head">
        <span>
          Trade setup
          {idea.hits.length > 1 && <span className="tx-setup-n">{idea.hits.length}</span>}
        </span>
        <button
          type="button"
          className={`tx-icon-btn ${showPlans ? "is-on" : ""}`}
          title={showPlans ? "Hide the plan on the chart" : "Show the plan on the chart"}
          onClick={toggleShowPlans}
        >
          {showPlans ? <Icons.eye size={15} /> : <Icons.eyeOff size={15} />}
        </button>
      </div>

      <div className="tx-setup-hits">
        {idea.hits.map((entry) => (
          <button
            type="button"
            key={entry.screen.id}
            className={`tx-setup-hit tx-hz-${entry.screen.group} ${entry.screen.id === hit.screen.id ? "is-active" : ""}`}
            title={`${GROUP_LABEL[entry.screen.group]} · ${entry.screen.horizon}\n${entry.screen.summary}`}
            onClick={() => focusSetup(symbol, entry.screen.id)}
          >
            <span className="tx-hz-dot" />
            {entry.screen.name}
          </button>
        ))}
      </div>

      <SetupNotices symbol={symbol} warnings={hit.row.warnings ?? []} btst={hit.screen.group === "btst"} />

      {status && status.kind !== "ok" && (
        <div className={`tx-setup-status is-${status.kind}`} role="status">
          <strong>{status.label}</strong> {status.detail}
        </div>
      )}

      {/* Price ladder, top to bottom like the chart: target, entry, stop. */}
      <div className="tx-ladder">
        <div className="tx-ladder-row is-target">
          <span>Target</span>
          <strong>{plan.target !== null ? formatPrice(plan.target) : "Trail"}</strong>
          <em>{plan.target !== null ? pct(plan.target, plan.entry) : "exit rule"}</em>
        </div>
        <div className="tx-ladder-row is-entry">
          <span>{buyStop ? "Buy above" : "Entry"}</span>
          <strong>{formatPrice(plan.entry)}</strong>
          <em className={rr !== null && rr < MIN_RR ? "is-warn" : ""}>{rr !== null ? `${rr.toFixed(1)}R reward` : "—"}</em>
        </div>
        <div className="tx-ladder-row is-stop">
          <span>Stop</span>
          <strong>{formatPrice(plan.stop)}</strong>
          <em>{pct(plan.stop, plan.entry)}</em>
        </div>
      </div>
      <p className="tx-setup-exit">
        {hit.screen.horizon} · {plan.exit}
        {!live && hit.screen.basis === "live" ? " Based on the last close." : ""}
      </p>

      {facts && (
        <dl className="tx-mini-stats tx-levels">
          <div title="Nearest resistance zone above the price (auto-detected)">
            <dt>Resistance</dt>
            <dd className={score?.resistanceInWay ? "is-warn" : ""}>{facts.resistance !== null ? formatPrice(facts.resistance) : "—"}</dd>
          </div>
          <div title="Chandelier exit: 22-day high − 3 × ATR(22). Move the stop up to it as the trade works.">
            <dt>Trail stop</dt>
            <dd>{Number.isFinite(facts.chandelier) ? formatPrice(facts.chandelier) : "—"}</dd>
          </div>
          <div title="Nearest support zone below the price (auto-detected)">
            <dt>Support</dt>
            <dd>{facts.support !== null ? formatPrice(facts.support) : "—"}</dd>
          </div>
        </dl>
      )}
      {score?.resistanceInWay && (
        <p className="tx-setup-note is-warn">
          Resistance at {formatPrice(score.resistanceInWay)} sits before the target — consider booking part there (R:R to it {score.effectiveRR?.toFixed(1)}R).
        </p>
      )}
      {facts?.pattern && (
        <p className="tx-setup-note">
          <strong>{facts.pattern.name}</strong> · {facts.pattern.status} · Q{facts.pattern.quality} — {facts.pattern.note}. Breakout {formatPrice(facts.pattern.breakout)}, measured target {formatPrice(facts.pattern.target)}.
        </p>
      )}

      {score && (
        <>
          <button type="button" className="tx-score-head" onClick={() => setShowScore((value) => !value)} aria-expanded={showScore}>
            <span className="tx-section-label">Setup score</span>
            <ScoreChip score={score} size="lg" />
            <span className="tx-dim">{showScore ? "Hide points ▴" : "Show points ▾"}</span>
          </button>
          {showScore && <ScoreBreakdown score={score} />}
        </>
      )}

      <div className="tx-section-label">
        Track record <span className="tx-dim">· last {track?.sessions ?? "…"} sessions</span>
      </div>
      {record ? (
        <div className="tx-setup-track">
          <span className={`tx-verdict tx-tone-${record.tone}`}>{record.verdict}</span>
          <div className="tx-setup-bar" title={`${record.target} target · ${record.open} open · ${record.stop} stop`}>
            <span className="is-up" style={{ flex: record.target }} />
            <span className="is-flat" style={{ flex: record.open }} />
            <span className="is-down" style={{ flex: record.stop }} />
          </div>
          <div className="tx-setup-legend">
            <span><i className="is-up" />{record.target} target</span>
            <span><i className="is-flat" />{record.open} open {HOLD_BARS[hit.screen.group]}d</span>
            <span><i className="is-down" />{record.stop} stop</span>
          </div>
          <dl className="tx-mini-stats">
            <div><dt>Signals</dt><dd>{record.signals}</dd></div>
            <div>
              <dt>Avg R</dt>
              <dd className={`tx-tone-${record.tone}`}>{record.avgR !== null ? `${record.avgR >= 0 ? "+" : ""}${record.avgR.toFixed(2)}` : "—"}</dd>
            </div>
            <div>
              <dt title="Target first, of trades that hit a side — vs the share a plan of this R needs to break even">Win / need</dt>
              <dd>
                {record.winShare !== null ? `${Math.round(record.winShare * 100)}%` : "—"}
                {record.breakEven !== null && <small> / {Math.round(record.breakEven * 100)}%</small>}
              </dd>
            </div>
          </dl>
          {own && own.signals > 0 && (
            <div className="tx-setup-counts">
              On {symbol}: {own.signals}× → {own.target} target, {own.stop} stop
              {ownVerdict?.avgR !== null && ownVerdict?.avgR !== undefined ? ` · avg ${ownVerdict.avgR >= 0 ? "+" : ""}${ownVerdict.avgR.toFixed(2)}R` : ""}
            </div>
          )}
        </div>
      ) : (
        <div className="tx-setup-counts">
          {track?.status === "error" ? track.error : <><span className="tx-spinner tx-spinner-sm" /> Replaying past signals…</>}
        </div>
      )}

      <div className="tx-section-label">Position size</div>
      <div className="tx-setup-size">
        <label>
          <span>Capital</span>
          <span className="tx-input tx-input-affix">
            ₹
            <input
              inputMode="numeric"
              value={capital ? capital.toLocaleString("en-IN") : ""}
              onChange={(event) => setSizing({ capital: Math.min(1e11, Number(event.target.value.replace(/[^\d]/g, "")) || 0) })}
              aria-label="Capital in rupees"
            />
          </span>
        </label>
        <div className="tx-setup-risk">
          <span>Max loss / trade</span>
          <div className="tx-seg" role="group" aria-label="Max loss per trade, % of capital">
            {RISK_PRESETS.map((value) => (
              <button type="button" key={value} className={riskPct === value ? "is-active" : ""} onClick={() => setSizing({ riskPct: value })}>
                {value}%
              </button>
            ))}
          </div>
        </div>
      </div>
      <dl className="tx-mini-stats tx-setup-sizing">
        <div title={lot ? `Lot size ${lot}` : "Lot size not loaded"}>
          <dt>Lots</dt>
          <dd>
            <strong>{lot ? lots : "—"}</strong>
            {lot ? <small> ×{lot}</small> : null}
          </dd>
        </div>
        <div title="Contract value (margin is a fraction of it)"><dt>Value</dt><dd>₹{formatCompact(qty * plan.entry)}</dd></div>
        <div><dt>At stop</dt><dd className="is-down">−₹{formatCompact(qty * risk)}</dd></div>
        <div><dt>At target</dt><dd className="is-up">{plan.target !== null ? `+₹${formatCompact(qty * (plan.target - plan.entry))}` : "—"}</dd></div>
      </dl>
      {lot && lots === 0 && sizing && (
        <p className="tx-setup-note is-warn">
          One lot ({lot}) risks ₹{formatCompact(sizing.riskPerLot)} = {((sizing.riskPerLot / capital) * 100).toFixed(1)}% of capital — above your {riskPct}% max loss.
        </p>
      )}
      {!lot && <p className="tx-setup-note">Lot size not available yet — the order ticket lets you enter it.</p>}
      {rr !== null && rr < MIN_RR && <p className="tx-setup-note is-warn">R:R under {MIN_RR} — the target barely pays for the risk.</p>}

      <div className="tx-setup-actions">
        <button
          type="button"
          className={`tx-btn-outline tx-star ${shortlisted ? "is-on" : ""}`}
          aria-pressed={shortlisted}
          onClick={() => toggleShortlist(symbol)}
        >
          <Icons.star size={15} filled={shortlisted} />
          {shortlisted ? "Shortlisted" : "Shortlist"}
        </button>
        <button
          type="button"
          className="tx-btn-small"
          onClick={() => {
            drawPlanOnChart(hit);
            setSaved(hit.screen.id);
          }}
        >
          {saved === hit.screen.id ? <><Icons.check size={15} /> Saved to chart</> : "Save to chart"}
        </button>
      </div>
      <div className="tx-setup-actions">
        <button type="button" className="tx-btn-outline" onClick={() => setTicket(true)}>
          <Icons.ticket size={15} /> Order ticket
        </button>
        <button
          type="button"
          className="tx-btn-outline"
          onClick={() => setAlertsAdded(addPlanAlerts(symbol, plan, hit.row.close, hit.screen.name))}
          title="Alerts at the breakout (if it's a buy-stop), the stop and the target"
        >
          {alertsAdded ? <Icons.check size={15} /> : <Icons.bell size={15} />} {alertsAdded === null ? "Alerts" : alertsAdded ? `${alertsAdded} set` : "Already set"}
        </button>
      </div>
      {ticket && (
        <OrderTicket
          symbol={symbol}
          plan={plan}
          close={hit.row.close}
          setupName={`${GROUP_LABEL[hit.screen.group]} · ${hit.screen.name}`}
          holdDays={HOLD_BARS[hit.screen.group]}
          onClose={() => setTicket(false)}
        />
      )}
      <p className="tx-setup-note">Mechanical levels and a replay of past signals — not advice, not a prediction. Gaps can fill past a stop.</p>
    </div>
  );
}

/** Results date and research-backed cautions for the selected setup. */
function SetupNotices({ symbol, warnings, btst }: { symbol: string; warnings: string[]; btst: boolean }) {
  const event = useScreenerFeed((feed) => feed.results?.bySymbol.get(symbol));
  const note = resultsNote(event);
  // Holding into results turns a setup into a bet on the numbers.
  const resultsRisk = note?.soon && (btst || note.text.startsWith("Results in") || note.text.startsWith("Results today"));
  if (!note && !warnings.length) return null;
  return (
    <div className="tx-notices">
      {note && (
        <div className={`tx-notice ${resultsRisk ? "is-warn" : "is-info"}`}>
          <Icons.calendar size={14} />
          <span>
            {note.text}
            {resultsRisk ? " — the plan's levels can be gapped through on the announcement." : ""}
          </span>
        </div>
      )}
      {warnings.map((warning) => (
        <div key={warning} className="tx-notice is-warn">
          <Icons.trending size={14} style={{ transform: "scaleY(-1)" }} />
          <span>{warning}</span>
        </div>
      ))}
    </div>
  );
}
