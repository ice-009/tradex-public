"use client";

import { useEffect } from "react";
import { api } from "@/client/api";
import { pendingQualityAlerts } from "@/core/quality/findings";
import { notifyUser } from "./Alerts";

// Toasts for the Market Data Hub's data-quality findings (rules in
// src/core/quality/findings.ts): after its evening import the hub checks for
// missing sessions, files for the wrong date, price outliers, broker-vs-NSE
// mismatches and lot-size / F&O-list changes; new problems, warnings and lot /
// F&O changes flash here once, while the terminal is open. What already
// flashed is remembered across reloads. A toast opens the stock's chart, or
// the /health page for a finding about a file or the F&O list.

const STORAGE_KEY = "tradex.qualityAlerted.v1";
const POLL_MS = 5 * 60_000;
/** Above this many groups at once, the rest are summed up in one toast. */
const MAX_TOASTS = 3;
/** Keys remembered (the hub's recent list holds at most 50). */
const KEEP = 500;

function loadAlerted(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function saveAlerted(keys: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys.slice(-KEEP)));
  } catch {
    // storage unavailable: alerts may repeat after a reload
  }
}

/** Mount once in the workspace. */
export function QualityAlertWatcher() {
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const { quality, checkedAt } = await api.quality();
        if (cancelled) return;
        const alerted = loadAlerted();
        const pending = pendingQualityAlerts(quality, new Set(alerted), checkedAt);
        if (!pending.length) return;
        for (const alert of pending.slice(0, MAX_TOASTS)) {
          notifyUser({
            symbol: alert.symbol ?? "",
            href: alert.symbol ? undefined : "/health",
            title: alert.title,
            detail: alert.detail,
            tone: alert.severity === "problem" ? "problem" : "note",
            notification: alert.title,
            tag: alert.tag,
          });
        }
        const rest = pending.slice(MAX_TOASTS);
        if (rest.length) {
          notifyUser({
            symbol: "",
            href: "/health",
            title: `+${rest.length} more data-quality finding${rest.length === 1 ? "" : "s"}`,
            detail: rest.map((alert) => alert.title.replace(/^Data quality · /, "")).join("; "),
            tone: "note",
            notification: `+${rest.length} more data-quality findings`,
            tag: "quality-more",
          });
        }
        saveAlerted([...alerted, ...pending.flatMap((alert) => alert.keys)]);
      } catch {
        // no hub, signed out or offline: try again at the next poll
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}
