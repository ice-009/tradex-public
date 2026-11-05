"use client";

import { useEffect, useRef, useState } from "react";
import { formatPrice } from "@/core/format";
import { liveHub, type LiveTick } from "@/client/marketData";

// Price + change cells that follow live ticks while the row is on screen.
// Off-screen rows don't subscribe, so a long screener list doesn't push symbols
// past the broker's streaming limit (those would be polled, costing API calls).

/** Priority after charts (0), alerts (1) and watchlist rows (2.x). */
const SCREEN_ROW_PRIORITY = 3;

export function LivePriceCells({ symbol, close, changePct, priceClassName }: { symbol: string; close: number; changePct: number; priceClassName?: string }) {
  const ref = useRef<HTMLTableCellElement>(null);
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

  // A tick for this symbol replaces the screener's snapshot (taken up to a few minutes ago).
  const live = tick && tick.symbol === symbol ? tick : null;
  const price = live?.ltp ?? close;
  const change = live ? live.chp : changePct;
  return (
    <>
      <td ref={ref} className={priceClassName} title={live ? `Live · ${new Date(live.ts).toLocaleTimeString("en-IN", { hour12: false })}` : "From the last screener scan"}>
        {formatPrice(price)}
      </td>
      <td className={change >= 0 ? "is-up" : "is-down"}>
        {change >= 0 ? "+" : ""}
        {change.toFixed(2)}%
      </td>
    </>
  );
}
