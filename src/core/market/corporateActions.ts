// Chart markers for splits, bonuses and the like (the Market Data Hub's
// /v1/adjustments, market-data-hub#20). Prices on the chart are adjusted, so a
// split doesn't show as a crash; the marker says where one happened and what
// it did. Pure: no I/O.

export interface AdjustmentEvent {
  /** Ex-date as the bar time (UTC midnight of the IST trade date, ms). */
  time: number;
  date: string;
  factor: number;
  source: "prev_close" | "corporate_action" | "price_gap";
  /** NSE's purpose ("BONUS 1:1", "FV SPLIT RS.10 TO RE.1", "DEMERGER"), when its file lists one. */
  action: string | null;
}

export interface CorporateActionMarker {
  time: number;
  /** Short text on the chart: "Split 10:1", "Bonus 2:1", "Demerger". */
  label: string;
  /** The longer explanation (tooltip, legend). */
  title: string;
}

/** "BONUS 1:1" → "Bonus"; "FV SPLIT …" → "Split"; else from the factor. */
function kind(event: AdjustmentEvent): string {
  const action = (event.action ?? "").toUpperCase();
  if (/DE-?MERGER/.test(action)) return "Demerger";
  if (/\bRI?GH?TS?\b/.test(action)) return "Rights";
  if (/CONSOLIDAT/.test(action)) return "Consolidation";
  if (/\bBON(US)?\b/.test(action)) return "Bonus";
  if (/SPLIT|SPLT|SUB-?\s?DIVI/.test(action)) return "Split";
  return event.factor > 1 ? "Consolidation" : "Split/bonus";
}

/** Shares after : before, from the price factor — 0.5 → "2:1", 0.4 → "5:2" — or null when no small ratio fits. */
export function shareRatio(factor: number): string | null {
  if (!(factor > 0)) return null;
  const shares = 1 / factor;
  for (let before = 1; before <= 10; before += 1) {
    const after = Math.round(shares * before);
    if (after > 0 && after <= 100 && Math.abs(after / before / shares - 1) < 0.005) return `${after}:${before}`;
  }
  return null;
}

export function corporateActionMarker(event: AdjustmentEvent): CorporateActionMarker {
  const name = kind(event);
  // A demerger's or rights issue's factor is a price, not a share ratio.
  const ratio = name === "Demerger" || name === "Rights" ? null : shareRatio(event.factor);
  const how = event.source === "price_gap" ? " (from the price gap)" : event.source === "prev_close" ? " (NSE's adjusted previous close)" : "";
  return {
    time: event.time,
    label: ratio ? `${name} ${ratio}` : name,
    title: `${event.date}: ${name}${ratio ? ` ${ratio}` : ""}${event.action ? ` — NSE: ${event.action}` : ""}. Prices before are × ${Number(event.factor.toFixed(4))}${how}.`,
  };
}
