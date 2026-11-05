# Tradex Charts — research notes

Sourced background for the chart's indicators, layout presets and drawing tools.
Some notes were written for earlier versions of the app; where code paths or counts
differ, the code and [ARCHITECTURE.md](../../ARCHITECTURE.md) are authoritative.
Every URL listed in these notes was opened and checked while building the feature,
except where a note marks a source *(search)*: those were read through search
results only, because the site was unreachable from the development environment.

| Note | Covers |
|---|---|
| [indicators.md](indicators.md) | Formula, defaults and Indian-market usage for all 31 indicators (`src/core/indicators/indicators.ts`) |
| [presets.md](presets.md) | Background for the layout presets (the app now ships two: Swing and BTST — see `src/terminal/presets.ts`), timeframes, indicator parameters and why (`src/terminal/presets.ts`) |
| [patterns.md](patterns.md) | Automatic chart patterns and S/R zones: detection rules, false-positive checks on random walks, plan levels (pattern stop, measured target, chandelier trail) (`src/core/indicators/patterns.ts`) |
| [platform-review.md](platform-review.md) | Review of the live terminal vs TradingView / Kite / Fyers / Chartink: chart-label and axis fixes, alerts, order ticket (GTT OCO, NSE tick sizes), backlog |
| [drawings.md](drawings.md) | Behaviour of the drawing tools, incl. Long/Short position (`src/chart/drawings.ts`) |

Primary sources used throughout: Zerodha Varsity (Indian-market usage: CPR, pivots,
Supertrend, VWAP, EMA pairs), StockCharts ChartSchool (formulas and worked examples —
RSI and ADX outputs were checked against their spreadsheets), TradingView Help Center
(numeric conventions the chart matches), SEBI publications, and original authors
(Wilder, Lane, Appel, Bollinger, Lambert, Elder, Connors) where accessible.

These notes are educational and are not trading advice.
