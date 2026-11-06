"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatPrice } from "@/core/format";
import { roundToTick } from "@/core/market/ticks";
import { fetchQuotes, liveHub, type Quote } from "@/client/marketData";
import {
  addAlert,
  clearTriggeredAlerts,
  getState,
  rearmAlert,
  removeAlert,
  triggerAlert,
  updateActiveCell,
  useTerminal,
  type PriceAlert,
} from "./store";
import { SymbolLogo } from "./Watchlist";
import { Icons } from "./icons";

// Price alerts: checked against live ticks (and a 30 s quote refresh) while the
// terminal is open. A fired alert shows a toast, plays a short tone and — where
// the browser allows it — a system notification. On iPad, system notifications
// need the terminal added to the Home Screen (iPadOS 16.4+); the toast and tone
// work everywhere. Nothing runs when the terminal is closed.

const POLL_MS = 30_000;

// ------------------------------------------------------------------ notification helpers

let audio: AudioContext | null = null;

/** Call from a tap/click so iOS lets us play sound later. */
export function unlockAlertSound() {
  try {
    audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    audio = null;
  }
}

function chime() {
  if (!audio) return;
  const now = audio.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.16);
    gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.15);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + i * 0.16);
    osc.stop(now + i * 0.16 + 0.16);
  }
}

/** Ask for notification permission (must run inside a click). Safe where Notification doesn't exist. */
export function requestAlertPermission() {
  unlockAlertSound();
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // unsupported (e.g. iPad Safari outside a Home Screen app)
  }
}

// Toast queue (module-level so the watchers can push without React plumbing).
interface Toast {
  id: string;
  symbol: string;
  title: string;
  detail: string;
  /** Accent: a price crossing up or down, or a screener setup. */
  tone: "above" | "below" | "setup";
}
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
const pushToast = (toast: Toast) => {
  toasts = [toast, ...toasts].slice(0, 4);
  toastListeners.forEach((listener) => listener());
};
const dismissToast = (id: string) => {
  toasts = toasts.filter((toast) => toast.id !== id);
  toastListeners.forEach((listener) => listener());
};

/** Toast + tone + (where allowed) a system notification. `tag` collapses repeats of one notification. */
export function notifyUser(message: Omit<Toast, "id"> & { notification: string; tag: string }) {
  const { notification, tag, ...toast } = message;
  pushToast({ id: `${tag}-${Date.now()}`, ...toast });
  chime();
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(notification, { body: toast.detail, tag });
    }
  } catch {
    // notifications unavailable
  }
}

function fire(alert: PriceAlert, price: number) {
  triggerAlert(alert.id, price);
  const up = alert.direction === "above";
  notifyUser({
    symbol: alert.symbol,
    title: `${alert.symbol} ${up ? "crossed above" : "fell below"} ${formatPrice(alert.price)}`,
    detail: `${alert.label} · now ${formatPrice(price)}`,
    tone: alert.direction,
    notification: `${alert.symbol} ${up ? "↑" : "↓"} ${formatPrice(alert.price)}`,
    tag: alert.id,
  });
}

/** Check one quote against every armed alert for its symbol. */
function check(quote: Pick<Quote, "symbol" | "ltp">) {
  if (!(quote.ltp > 0)) return;
  for (const alert of getState().alerts) {
    if (alert.triggeredAt || alert.symbol !== quote.symbol) continue;
    const crossed = alert.direction === "above" ? quote.ltp >= alert.price : quote.ltp <= alert.price;
    if (crossed) fire(alert, quote.ltp);
  }
}

// ------------------------------------------------------------------ watcher + toasts (mount once)

/** Watches every symbol with an armed alert. Mount once in the workspace. */
export function AlertWatcher() {
  const alerts = useTerminal((state) => state.alerts);
  const key = useMemo(() => [...new Set(alerts.filter((alert) => !alert.triggeredAt).map((alert) => alert.symbol))].sort().join(","), [alerts]);

  useEffect(() => {
    if (!key) return;
    const symbols = key.split(",");
    let cancelled = false;
    const poll = () =>
      fetchQuotes(symbols).then((quotes) => {
        // End-of-day fallback prices must never fire an alert.
        if (!cancelled) quotes.filter((quote) => !quote.delayed).forEach(check);
      });
    void poll();
    const timer = setInterval(poll, POLL_MS);
    const unsubscribers = symbols.map((symbol) => liveHub.subscribe(symbol, check, 1));
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [key]);

  return <AlertToasts />;
}

function AlertToasts() {
  const list = useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => {
        toastListeners.delete(listener);
      };
    },
    () => toasts,
    () => toasts,
  );
  if (!list.length) return null;
  return (
    <div className="tx-alert-toasts" role="status" aria-live="assertive">
      {list.map((toast) => (
        <div key={toast.id} className={`tx-alert-toast is-${toast.tone}`}>
          <Icons.bell size={16} />
          <button
            type="button"
            className="tx-alert-toast-body"
            onClick={() => {
              updateActiveCell({ symbol: toast.symbol });
              dismissToast(toast.id);
            }}
          >
            <strong>{toast.title}</strong>
            <span>{toast.detail}</span>
          </button>
          <button type="button" className="tx-icon-btn" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            <Icons.x size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ plan → alerts

/** One tap: alerts for a plan's breakout (if it's a buy-stop), stop and target. Returns how many were added. */
export function addPlanAlerts(symbol: string, plan: { entry: number; stop: number; target: number | null }, close: number, setupName: string) {
  requestAlertPermission();
  let added = 0;
  if (plan.entry > close * 1.0005 && addAlert(symbol, roundToTick(plan.entry, "up"), close, `Breakout — ${setupName} buy-stop`)) added += 1;
  if (addAlert(symbol, roundToTick(plan.stop, "down"), close, `Stop — ${setupName}`)) added += 1;
  if (plan.target !== null && addAlert(symbol, roundToTick(plan.target), close, `Target — ${setupName}`)) added += 1;
  return added;
}

// ------------------------------------------------------------------ side panel

export function AlertsPanel() {
  const alerts = useTerminal((state) => state.alerts);
  const activeSymbol = useTerminal((state) => state.cells[state.activeCell].symbol);
  const [price, setPrice] = useState("");
  const [lastPrice, setLastPrice] = useState<Record<string, number>>({});
  const armed = alerts.filter((alert) => !alert.triggeredAt);
  const fired = alerts.filter((alert) => alert.triggeredAt);
  const symbolsKey = useMemo(() => [...new Set([...alerts.map((alert) => alert.symbol), activeSymbol])].sort().join(","), [alerts, activeSymbol]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Current prices for "how far away" and for setting a new alert's direction.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchQuotes(symbolsKey.split(",")).then((quotes) => {
        if (!cancelled) setLastPrice(Object.fromEntries(quotes.map((quote) => [quote.symbol, quote.ltp])));
      });
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbolsKey]);

  const current = lastPrice[activeSymbol];
  const submit = () => {
    const value = Number(price.replace(/[^\d.]/g, ""));
    if (!(value > 0) || !current) return;
    requestAlertPermission();
    addAlert(activeSymbol, roundToTick(value), current, `${activeSymbol} ${value >= current ? "above" : "below"} ${formatPrice(value)}`);
    setPrice("");
  };

  return (
    <>
      <form
        className="tx-side-sub tx-alert-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label>
          <span>
            New alert on <strong>{activeSymbol}</strong>
            {current ? <span className="tx-dim"> · now {formatPrice(current)}</span> : null}
          </span>
          <span className="tx-alert-input">
            <input ref={inputRef} className="tx-input" inputMode="decimal" placeholder="Price" value={price} onChange={(event) => setPrice(event.target.value)} />
            <button type="submit" className="tx-btn-small" disabled={!price || !current}>
              <Icons.bell size={14} /> Add
            </button>
          </span>
        </label>
        <span className="tx-side-note">Above the price → fires on a cross up; below → on a cross down. Checked while the terminal is open.</span>
      </form>
      <div className="tx-wl-list">
        {!alerts.length && (
          <div className="tx-empty">
            No alerts yet.
            <br />
            Use “Alerts” on a trade setup to watch its breakout, stop and target.
          </div>
        )}
        {armed.length > 0 && <div className="tx-cal-date">Armed · {armed.length}</div>}
        {armed.map((alert) => (
          <AlertRow key={alert.id} alert={alert} last={lastPrice[alert.symbol]} />
        ))}
        {fired.length > 0 && (
          <div className="tx-cal-date is-past">
            Triggered · {fired.length}
            <button type="button" className="tx-scr-clear" onClick={clearTriggeredAlerts}>
              Clear
            </button>
          </div>
        )}
        {fired.map((alert) => (
          <AlertRow key={alert.id} alert={alert} last={lastPrice[alert.symbol]} />
        ))}
      </div>
    </>
  );
}

function AlertRow({ alert, last }: { alert: PriceAlert; last?: number }) {
  const distance = last ? ((alert.price - last) / last) * 100 : null;
  return (
    <div className={`tx-alert-row ${alert.triggeredAt ? "is-fired" : ""}`} role="button" tabIndex={0} onClick={() => updateActiveCell({ symbol: alert.symbol })}>
      <SymbolLogo symbol={alert.symbol} />
      <span className="tx-alert-main">
        <strong>
          {alert.symbol} <span className={alert.direction === "above" ? "is-up" : "is-down"}>{alert.direction === "above" ? "↑" : "↓"}</span> {formatPrice(alert.price)}
        </strong>
        <span className="tx-alert-label">
          {alert.label}
          {alert.triggeredAt
            ? ` · fired ${new Date(alert.triggeredAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
            : distance !== null
              ? ` · ${distance >= 0 ? "+" : ""}${distance.toFixed(1)}% away`
              : ""}
        </span>
      </span>
      {alert.triggeredAt && last ? (
        <button
          type="button"
          className="tx-mk-star"
          title="Re-arm"
          onClick={(event) => {
            event.stopPropagation();
            rearmAlert(alert.id, last);
          }}
        >
          <Icons.reset size={14} />
        </button>
      ) : null}
      <button
        type="button"
        className="tx-mk-star"
        title="Delete alert"
        onClick={(event) => {
          event.stopPropagation();
          removeAlert(alert.id);
        }}
      >
        <Icons.x size={14} />
      </button>
    </div>
  );
}
