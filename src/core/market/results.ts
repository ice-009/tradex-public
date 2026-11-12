// Financial-results dates (from the Market Data Hub's copy of NSE's event
// calendar). Pure: no I/O.

export interface ResultsEvent {
  symbol: string;
  company: string;
  /** UTC midnight of the IST date, ms. */
  date: number;
  purpose: string;
}

/**
 * NSE lists some companies more than once for the same meeting (e.g. "Financial Results" and
 * "Financial Results/Dividend" as separate rows). Keep one event per symbol and date, joining
 * the distinct purposes.
 */
export function dedupeEvents(events: ResultsEvent[]): ResultsEvent[] {
  const byKey = new Map<string, ResultsEvent>();
  for (const event of events) {
    const key = `${event.symbol}|${event.date}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...event });
      continue;
    }
    const purposes = new Set([...existing.purpose.split(" · "), event.purpose].map((purpose) => purpose.trim()).filter(Boolean));
    existing.purpose = [...purposes].join(" · ").slice(0, 160);
  }
  return [...byKey.values()].sort((a, b) => a.date - b.date || a.symbol.localeCompare(b.symbol));
}
