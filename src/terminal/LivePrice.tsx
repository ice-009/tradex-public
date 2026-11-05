"use client";

import { useEffect, useRef, useState } from "react";
import { formatPrice } from "@/core/format";
import { liveHub, type LiveTick } from "@/client/marketData";

// Live prices for table rows while they're on screen. Off-screen rows don't
// subscribe, so a long screener list doesn't push symbols past the broker's
// streaming limit (those would be polled, costing API calls).

/** Priority after charts (0), alerts (1) and watchlist rows (2.x). */
const SCREEN_ROW_PRIORITY = 3;

/** Attach `ref` to the row; `tick` is the latest live tick while the row is visible. */
export function useVisibleLiveTick<T extends Element>(symbol: string) {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  const [tick, setTick] = useState<LiveTick | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "64px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    return liveHub.subscribe(symbol, setTick, SCREEN_ROW_PRIORITY);
  }, [symbol, visible]);

  return { ref, tick: tick && tick.symbol === symbol ? tick : null };
}

/** Price + change cells: the live tick when there is one, else the scan's snapshot. */
export function PriceCells({ tick, close, changePct, priceClassName }: { tick: LiveTick | null; close: number; changePct: number; priceClassName?: string }) {
  const price = tick?.ltp ?? close;
  const change = tick ? tick.chp : changePct;
  return (
    <>
      <td className={priceClassName} title={tick ? `Live · ${new Date(tick.ts).toLocaleTimeString("en-IN", { hour12: false })}` : "From the last screener scan"}>
        {formatPrice(price)}
      </td>
      <td className={change >= 0 ? "is-up" : "is-down"}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(2)}%
      </td>
    </>
  );
}

/** The latest live tick for one symbol (always subscribed while mounted). */
export function useLiveTick(symbol: string, priority = 0): LiveTick | null {
  const [tick, setTick] = useState<LiveTick | null>(() => liveHub.getLatest(symbol));
  useEffect(() => liveHub.subscribe(symbol, setTick, priority), [symbol, priority]);
  return tick && tick.symbol === symbol ? tick : null;
}
