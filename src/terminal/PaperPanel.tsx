"use client";

import { useState } from "react";
import "./replay.css";
import type { PaperResponse, PaperTradeDto } from "@/contracts/api";
import { formatPrice } from "@/core/format";
import { signedR } from "@/core/plan/evidence";
import { paperCsv, type PaperStatus } from "@/core/plan/paper";
import { exitShort } from "@/core/plan/instructions";
import { dayLabel, isoDay } from "@/core/reference/timeMachine";
import { SCREEN_MAP } from "@/core/screener/screens";
import { newPaperSession, paperRemove, usePaperFeed } from "@/client/paperFeed";
import { useTimeMachine } from "@/client/timeMachine";
import { openIdea } from "./ideaActions";
import { useTerminal } from "./store";

// The Paper tab (issue #32): the paper trades of the current replay session,
// graded by the server as of the day shown — pending buy-stops, open trades
// with their mark, closed ones with how they closed — and the session's
// summary: trades, hit rate, net R, ₹ P&L after costs, max drawdown, and what
// the plan's evidence expected of the same trades. Export as CSV or JSON.
// Paper trades live apart from your real journal.

const rupees = (value: number) => `${value < 0 ? "−" : ""}₹${formatPrice(Math.abs(value), 0)}`;
const STATUS_LABEL: Record<PaperStatus, string> = { later: "taken later", pending: "buy-stop working", unfilled: "not filled", open: "open", closed: "closed" };

function download(name: string, type: string, text: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function PaperPanel() {
  const height = useTerminal((state) => state.screener.height);
  const maximized = useTerminal((state) => state.screener.maximized);
  const asOf = useTimeMachine((state) => state.asOf);
  const data = usePaperFeed((feed) => feed.data);
  const error = usePaperFeed((feed) => feed.error);
  const loading = usePaperFeed((feed) => feed.loading);
  return (
    <section className="tx-scr tx-paper" style={{ height: maximized ? undefined : `min(${height}px, 42vh)` }} data-testid="paper-panel">
      <header className="tx-scr-head">
        <b>PAPER TRADES</b>
        <span className="tx-scr-status">{asOf ? (data ? `Graded as of ${dayLabel(data.day)} close${loading ? " · updating…" : ""}` : loading ? "Loading…" : "") : ""}</span>
        <span className="tx-tb-spacer" />
        {data && data.trades.length > 0 && (
          <>
            <button type="button" className="tx-btn-outline" onClick={() => download(`paper-${isoDay(data.day)}.csv`, "text/csv", paperCsv(data.trades))}>
              Export CSV
            </button>
            <button type="button" className="tx-btn-outline" onClick={() => download(`paper-${isoDay(data.day)}.json`, "application/json", JSON.stringify(data, null, 2))}>
              JSON
            </button>
          </>
        )}
        {asOf && (
          <button type="button" className="tx-btn-outline" title="Start a new paper session (this one is kept)" onClick={() => void newPaperSession()}>
            New session
          </button>
        )}
      </header>
      {!asOf ? (
        <p className="tx-tm-note">Paper trading runs inside the Time Machine: pick a past day in the top bar, then &quot;Paper take&quot; ideas from the Plan tab and step the replay forward.</p>
      ) : error ? (
        <p className="tx-tm-note">{error}</p>
      ) : !data ? null : (
        <div className="tx-paper-body">
          <Summary data={data} />
          {data.trades.length ? <TradeTable trades={data.trades} /> : <p className="tx-tm-note">No paper trades yet. In the Plan tab, &quot;Paper take&quot; an idea; it fills by the plan&apos;s entry rule as you step forward.</p>}
          {data.notes.map((note) => (
            <p key={note} className="tx-scr-note">
              {note}
            </p>
          ))}
          <p className="tx-scr-note">
            Fills follow the plan: a close entry buys at that session&apos;s close; a buy-stop fills only if the next session trades through it (at the open if it opens above); BTST sells at the next open. Exits:
            the stop (at the open if it gaps below), the target, a trailing low where the setup has one, else the close after the holding period. Net of slippage and charges ({data.costs.label}).
          </p>
        </div>
      )}
    </section>
  );
}

function Summary({ data }: { data: PaperResponse }) {
  const s = data.summary;
  return (
    <div className="tx-paper-summary" data-testid="paper-summary">
      <span>
        Trades <b>{s.taken}</b>
        <em>
          {s.closed} closed · {s.open} open{s.pending ? ` · ${s.pending} working` : ""}
          {s.unfilled ? ` · ${s.unfilled} not filled` : ""}
        </em>
      </span>
      <span>
        Hit rate <b>{s.hitRate === null ? "—" : `${Math.round(s.hitRate * 100)}%`}</b>
        <em>{s.closed ? `${s.wins} of ${s.closed}` : "none closed"}</em>
      </span>
      <span>
        Net R <b className={s.netR >= 0 ? "is-up" : "is-down"}>{signedR(s.netR)}</b>
        <em>{s.avgNetR === null ? "" : `${signedR(s.avgNetR)} a trade`}{s.expectedR !== null ? ` · plan expected ${signedR(s.expectedR)}` : ""}</em>
      </span>
      <span>
        P&amp;L <b className={s.pnl >= 0 ? "is-up" : "is-down"}>{rupees(s.pnl)}</b>
        <em>after {rupees(s.charges)} charges{s.open ? ` · open ${rupees(s.openPnl)}` : ""}</em>
      </span>
      <span>
        Max drawdown <b>{rupees(s.maxDrawdown)}</b>
        <em>{signedR(-s.maxDrawdownR)}</em>
      </span>
    </div>
  );
}

function TradeTable({ trades }: { trades: PaperTradeDto[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <table className="tx-scr-table tx-paper-table">
      <thead>
        <tr>
          <th>Stock</th>
          <th>Setup</th>
          <th>Taken</th>
          <th>Entry</th>
          <th>Stop / exit rule</th>
          <th>Status</th>
          <th>Exit</th>
          <th>Net R</th>
          <th>₹</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {trades.map((trade) => {
          const g = trade.grade;
          return (
            <tr key={trade.id} className={`is-${g.status}`} data-testid="paper-row">
              <td>
                <button type="button" className="tx-scr-clear" onClick={() => openIdea(trade.symbol, trade.screenId)}>
                  {trade.symbol}
                </button>
              </td>
              <td>{SCREEN_MAP[trade.screenId]?.name ?? trade.screenId}</td>
              <td>{dayLabel(trade.signalDay)}</td>
              <td title={`${trade.entryKind === "buy-stop" ? "Buy-stop" : trade.entryKind === "btst" ? "BTST: bought at the close" : "Bought at the close"} · ${trade.lots} × ${trade.lotSize}`}>
                {g.entryPrice !== null ? formatPrice(g.entryPrice) : `${trade.entryKind === "buy-stop" ? "stop " : ""}${formatPrice(trade.plannedEntry)}`}
              </td>
              <td>
                {formatPrice(trade.stop)} · {exitShort(trade.exitRule, trade, trade.holdSessions)}
              </td>
              <td className="tx-paper-status" title={g.text}>
                {STATUS_LABEL[g.status]}
                {g.status === "open" && g.mark !== null ? ` · ${formatPrice(g.mark)}` : ""}
              </td>
              <td title={g.text}>{g.exitPrice !== null ? `${formatPrice(g.exitPrice)} ${g.exitReason}${g.gap ? " (gap)" : ""}` : g.status === "open" ? `session ${g.sessions}/${trade.holdSessions}` : ""}</td>
              <td className={(g.netR ?? g.grossR ?? 0) >= 0 ? "is-up" : "is-down"}>{g.status === "closed" ? signedR(g.netR) : g.grossR !== null ? `${signedR(g.grossR)}*` : ""}</td>
              <td>{g.pnl !== null ? rupees(g.pnl) : ""}</td>
              <td>
                <button
                  type="button"
                  className="tx-icon-btn"
                  aria-label={`Remove ${trade.symbol}`}
                  title="Remove this paper trade"
                  disabled={busy === trade.id}
                  onClick={() => {
                    setBusy(trade.id);
                    void paperRemove(trade.id).finally(() => setBusy(null));
                  }}
                >
                  ×
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={10} className="tx-dim">
            * open: the move at the last close, before costs.
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
