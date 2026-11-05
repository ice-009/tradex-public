"use client";

import { useEffect, useState } from "react";
import { formatCompact, formatPrice } from "@/core/format";
import type { TradePlan } from "@/core/screener/screens";
import { expiryOf, nearMonthFuture } from "@/core/market/futures";
import { DAY_MS, istParts } from "@/core/market/session";
import { roundToTick, safeTickSize } from "@/core/market/ticks";
import { addPlanAlerts } from "./Alerts";
import { fetchQuotes } from "@/client/marketData";
import { lotsForRisk } from "@/core/market/futures";
import { useLotSize } from "@/client/lotsFeed";
import { usePrefs } from "./uiPrefs";
import { Modal } from "./ui";
import { Icons } from "./icons";

/** Limit beyond a stop trigger, so the exit still fills in a fast move. */
const STOP_LIMIT_BUFFER = 0.005;
/**
 * Turns a plan (read off the cash chart) into a stock-futures order: the near-month contract
 * (or next month when expiry falls inside the holding period), levels shifted by the current
 * basis (futures − cash), size in lots from your max loss, NRML so it carries overnight, and a
 * GTT OCO exit. Nothing is placed from here.
 */
export function OrderTicket({
  symbol,
  plan,
  close,
  setupName,
  holdDays = 1,
  onClose,
}: {
  symbol: string;
  plan: TradePlan;
  close: number;
  setupName: string;
  /** Sessions the plan expects to hold: decides whether the near-month contract is too close to expiry. */
  holdDays?: number;
  onClose: () => void;
}) {
  const capital = usePrefs((prefs) => prefs.capital);
  const riskPct = usePrefs((prefs) => prefs.riskPct);
  const { lot: knownLot, source: lotSource } = useLotSize(symbol);
  const [manualLot, setManualLot] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [alertsAdded, setAlertsAdded] = useState<number | null>(null);

  // Contract: this month's, unless it expires within the holding period (+1 session of margin).
  const today = istParts().day;
  const near = nearMonthFuture(symbol, today);
  const nearExpiry = expiryOf(near);
  const calendarDays = Math.ceil(holdDays * 1.45) + 1;
  const rollToNext = nearExpiry !== null && nearExpiry - today <= calendarDays * DAY_MS;
  const [useNext, setUseNext] = useState(rollToNext);
  const contract = useNext ? nearMonthFuture(symbol, today, 1) : near;
  const expiry = expiryOf(contract);

  // Basis = futures − cash, from one quote snapshot of both.
  const [quotes, setQuotes] = useState<{ key: string; cash: number | null; fut: number | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Planning only (nothing is placed from here): a recent cached quote is enough for the basis.
    fetchQuotes([symbol, contract]).then((items) => {
      if (cancelled) return;
      const live = items.filter((item) => !item.delayed);
      setQuotes({
        key: contract,
        cash: live.find((item) => item.symbol === symbol)?.ltp ?? null,
        fut: live.find((item) => item.symbol === contract)?.ltp ?? null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [symbol, contract]);
  const loaded = quotes?.key === contract ? quotes : null;
  const basis = loaded?.cash && loaded.fut ? loaded.fut - loaded.cash : null;
  const shift = basis ?? 0;

  const buyStop = plan.entry > close * 1.0005;
  const entry = roundToTick(plan.entry + shift, buyStop ? "up" : "nearest");
  const entryLimit = buyStop ? roundToTick(entry * (1 + STOP_LIMIT_BUFFER), "up") : entry;
  const stop = roundToTick(plan.stop + shift, "down");
  const stopLimit = roundToTick(stop * (1 - STOP_LIMIT_BUFFER), "down");
  const target = plan.target !== null ? roundToTick(plan.target + shift, "nearest") : null;
  const risk = entry - stop;

  const lot = knownLot ?? (Number(manualLot) > 0 ? Math.round(Number(manualLot)) : null);
  const maxLoss = (capital * riskPct) / 100;
  const sizing = lot ? lotsForRisk(maxLoss, risk, lot) : null;
  const lots = sizing?.lots ?? 0;
  const qty = lot ? lots * lot : 0;

  const rows: Array<{ key: string; label: string; value: string; hint?: string; copy?: string }> = [
    {
      key: "contract",
      label: "Contract · product",
      value: `${contract.replace("NSE:", "")} · NRML`,
      copy: contract.replace("NSE:", ""),
      hint: `Expires ${expiry ? new Date(expiry).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "—"} (last Tuesday). NRML carries overnight; MIS is squared off the same day.`,
    },
    lot
      ? {
          key: "qty",
          label: "Lots",
          value: lots > 0 ? `${lots} lot${lots === 1 ? "" : "s"} × ${lot} = ${qty}` : `0 lots (1 lot = ${lot})`,
          copy: String(qty),
          hint:
            lots > 0
              ? `Contract value ₹${formatCompact(qty * entry)} · risks ₹${formatCompact(qty * risk)} of your ₹${formatCompact(maxLoss)} max loss`
              : `One lot risks ₹${formatCompact(sizing?.riskPerLot ?? 0)} = ${(((sizing?.riskPerLot ?? 0) / capital) * 100).toFixed(1)}% of capital — more than your ${riskPct}% max loss. Skip, or widen the max loss knowingly.`,
        }
      : { key: "qty", label: "Lots", value: "Lot size unknown", hint: "Couldn't load lot sizes — type this contract's lot size below." },
    buyStop
      ? { key: "entry", label: "Entry · SL buy (NRML)", value: `Trigger ${entry.toFixed(2)} · Limit ${entryLimit.toFixed(2)}`, copy: `${entry.toFixed(2)}`, hint: "Fills only if the future trades up through the breakout." }
      : { key: "entry", label: "Entry · Limit buy (NRML)", value: entry.toFixed(2), copy: entry.toFixed(2), hint: "Or a market order near the close." },
    { key: "stop", label: "GTT OCO · stop leg", value: `Trigger ${stop.toFixed(2)} · Limit ${stopLimit.toFixed(2)}`, copy: stop.toFixed(2), hint: `${(((stop - entry) / entry) * 100).toFixed(2)}% · limit ${STOP_LIMIT_BUFFER * 100}% under the trigger so it fills on a fast drop` },
    target !== null
      ? { key: "target", label: "GTT OCO · target leg", value: `Trigger ${target.toFixed(2)} · Limit ${target.toFixed(2)}`, copy: target.toFixed(2), hint: `+${(((target - entry) / entry) * 100).toFixed(2)}% · ${(risk > 0 ? (target - entry) / risk : 0).toFixed(1)}R` }
      : { key: "target", label: "Target", value: "Trail — no fixed target", hint: plan.exit },
  ];

  const allText = [
    `${contract.replace("NSE:", "")} (NRML) — ${setupName}`,
    ...rows.map((row) => `${row.label}: ${row.value}`),
    basis !== null ? `Basis ${basis >= 0 ? "+" : ""}${basis.toFixed(2)} (futures − cash) applied to the cash-chart levels` : "Cash-chart levels (no live futures quote for the basis)",
    `Prices rounded to ₹${safeTickSize(entry)} · plan: ${plan.exit}`,
  ].join("\n");

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((value) => (value === key ? null : value)), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <Modal title={`Futures order · ${symbol}`} onClose={onClose} width={480}>
      <div className="tx-ticket">
        <p className="tx-ticket-sub">
          {setupName}
          {" · "}
          {loaded === null ? (
            "reading the basis…"
          ) : basis !== null ? (
            <>
              basis {basis >= 0 ? "+" : ""}
              {formatPrice(basis)} (future {formatPrice(loaded.fut!)} vs cash {formatPrice(loaded.cash!)}) applied to the chart&apos;s levels
            </>
          ) : (
            <span className="is-warn">no live futures quote — levels are the cash chart&apos;s; check the basis yourself</span>
          )}
        </p>
        {rollToNext && (
          <p className="tx-ticket-hint is-warn">
            This month&apos;s contract expires within the holding period, so the next month is selected.{" "}
            <button type="button" className="tx-scr-clear" onClick={() => setUseNext((value) => !value)}>
              Use {useNext ? "this" : "next"} month instead
            </button>
          </p>
        )}
        {!rollToNext && (
          <p className="tx-ticket-hint">
            <button type="button" className="tx-scr-clear" onClick={() => setUseNext((value) => !value)}>
              {useNext ? "Back to this month's contract" : "Use next month's contract"}
            </button>
          </p>
        )}
        {rows.map((row) => (
          <div key={row.key} className={`tx-ticket-row is-${row.key}`}>
            <div>
              <span className="tx-ticket-label">{row.label}</span>
              <strong>{row.value}</strong>
              {row.hint && <span className={`tx-ticket-hint ${row.key === "qty" && lot && lots === 0 ? "is-warn" : ""}`}>{row.hint}</span>}
            </div>
            {row.copy && (
              <button type="button" className="tx-btn-outline" onClick={() => void copy(row.key, row.copy!)} title="Copy">
                {copied === row.key ? <Icons.check size={14} /> : "Copy"}
              </button>
            )}
          </div>
        ))}
        {!knownLot && (
          <label className="tx-ticket-lot">
            Lot size
            <input className="tx-input" inputMode="numeric" value={manualLot} onChange={(event) => setManualLot(event.target.value.replace(/[^\d]/g, ""))} placeholder="e.g. 750" />
          </label>
        )}
        <div className="tx-ticket-actions">
          <button type="button" className="tx-btn-small" onClick={() => void copy("all", allText)}>
            {copied === "all" ? <><Icons.check size={14} /> Copied</> : "Copy all"}
          </button>
          <button type="button" className="tx-btn-outline" onClick={() => setAlertsAdded(addPlanAlerts(symbol, plan, close, setupName))} title="Alerts on the cash chart's breakout, stop and target">
            {alertsAdded ? <Icons.check size={14} /> : <Icons.bell size={14} />} {alertsAdded === null ? "Alert me (cash levels)" : alertsAdded ? `${alertsAdded} alerts set` : "Alerts already set"}
          </button>
        </div>
        <p className="tx-ticket-note">
          Place the entry as <strong>NRML</strong>; once filled, add the exit as a <strong>GTT → OCO</strong> on the same contract (Kite supports NRML F&amp;O GTTs;
          F&amp;O triggers run until 3:40 PM). One user has reported a futures GTT stop that triggered without fully exiting — check your position after a stop.
          Lots from {lotSource === "nse" ? "NSE's lot file" : lotSource === "fyers" ? "Fyers' symbol master" : lotSource === "disk" ? "the last saved lot file" : "your entry"}.
          Prices rounded to ₹{formatPrice(safeTickSize(entry))}. Nothing is sent to a broker from here.
        </p>
      </div>
    </Modal>
  );
}
