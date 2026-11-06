"use client";

import { useEffect } from "react";
import { formatPrice } from "@/core/format";
import { istParts } from "@/core/market/session";
import { pendingBtstAlerts } from "@/core/screener/btstAlerts";
import { SCREENS } from "@/core/screener/screens";
import { useScreenerFeed } from "@/client/screenerFeed";
import { notifyUser } from "./Alerts";
import { useTerminal } from "./store";

// Flashes live BTST setups in the last minutes of the session (rules in
// src/core/screener/btstAlerts.ts). Rides on the screener feed's polling, so it
// costs no extra API calls. What already flashed today is remembered across
// reloads, so a refresh at 3:20 doesn't replay the 3:10 alerts.

const STORAGE_KEY = "tradex.btstAlerted.v1";
/** Above this many at once, the rest are summed up in one toast instead of a chime each. */
const MAX_TOASTS = 3;

function loadAlerted(day: number): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { day: number; keys: string[] } | null;
    return new Set(saved?.day === day ? saved.keys : []);
  } catch {
    return new Set();
  }
}

function saveAlerted(day: number, keys: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ day, keys: [...keys] }));
  } catch {
    // storage unavailable: alerts may repeat after a reload
  }
}

/** Mount once in the workspace. */
export function BtstAlertWatcher() {
  const enabled = useTerminal((state) => state.screener.btstAlerts);
  const data = useScreenerFeed((feed) => feed.data);
  const track = useScreenerFeed((feed) => feed.track);

  useEffect(() => {
    if (!enabled || data?.status !== "ready" || data.asOf?.stale) return;
    const now = Date.now();
    const day = istParts(now).day;
    const alerted = loadAlerted(day);
    const pending = pendingBtstAlerts({
      screens: SCREENS,
      results: data.results,
      track: track && "screens" in track ? track.screens : undefined,
      banned: data.ban?.available ? data.ban.symbols : [],
      alerted,
      now,
    });
    if (!pending.length) return;
    pending.sort((a, b) => b.row.score - a.row.score);
    const regime = data.regime ? ` · Market: ${data.regime.label}` : "";
    for (const { screen, row } of pending.slice(0, MAX_TOASTS)) {
      const stopPct = ((row.plan.entry - row.plan.stop) / row.plan.entry) * 100;
      notifyUser({
        symbol: row.symbol,
        title: `BTST · ${row.symbol} — ${screen.name}`,
        detail: `Buy ~${formatPrice(row.close)} · stop ${formatPrice(row.plan.stop)} (${stopPct.toFixed(1)}%) · sell at the next open${regime}`,
        tone: "setup",
        notification: `BTST ${row.symbol} ~${formatPrice(row.close)}`,
        tag: `btst-${row.symbol}`,
      });
    }
    const rest = pending.slice(MAX_TOASTS);
    if (rest.length) {
      notifyUser({
        symbol: rest[0].row.symbol,
        title: `+${rest.length} more BTST setup${rest.length === 1 ? "" : "s"}`,
        detail: rest.map(({ row }) => row.symbol).join(", "),
        tone: "setup",
        notification: `+${rest.length} more BTST setups`,
        tag: "btst-more",
      });
    }
    for (const { key } of pending) alerted.add(key);
    saveAlerted(day, alerted);
  }, [enabled, data, track]);

  return null;
}
