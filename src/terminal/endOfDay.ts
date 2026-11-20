// Wording for end-of-day mode: the Market Data Hub runs without a broker
// (market-data-hub#32), so Tradex has NSE's daily files only. Shared by the
// banner, the top bar and the Market data panel.

export const END_OF_DAY_LABEL = "End-of-day data (no broker connected)";

/** Why an intraday interval is off (tooltips). */
export const END_OF_DAY_INTRADAY_HINT = "Intraday charts need a broker on the Market Data Hub; it serves end-of-day data only.";

/** The status pill's tooltip. */
export const END_OF_DAY_STATUS_HINT = "No live prices: the Market Data Hub has no broker connected. Prices are the last daily close from NSE's end-of-day files.";

/** The hub's docs on adding a broker. */
export const BROKER_DOCS_URL = "https://github.com/ice-009/market-data-hub#configuration";
