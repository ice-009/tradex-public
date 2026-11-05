# TradingView drawing-tool semantics (reference for Tradex Charts)

## Long / Short Position
- https://www.tradingview.com/support/solutions/43000475660-how-to-use-long-and-short-position-drawing-tools/
- https://www.tradingview.com/support/solutions/43000517002-long-position-drawing-tool/
- Placed with one click at the entry price. Two boxes extend from the entry level: green profit zone (to target) and
  red loss zone (to stop). Long: target above, stop below; Short: mirrored.
- Labels: Target and Stop levels (price, %, ticks/points), P&L, Qty, Risk/Reward ratio = |target-entry| / |entry-stop|.
- Handles: entry (moves entry price/start time), target (price only), stop (price only), right edge (time extent).
- The horizontal extent is the window in which the tool checks whether entry, then target or stop, was hit; closed
  P&L = target offset on TP, stop offset on SL; while open, last price is used ("Open P&L").
  Tradex: entry assumed filled when a bar inside the window trades through the entry price; same-bar TP+SL counts as SL.

## Parallel Channel
- https://in.tradingview.com/support/solutions/43000518117 (Parallel Channel)
- https://www.tradingview.com/blog/en/parallel-channel-gets-more-levels-47030
- 3 clicks: two points define the base line (level 0), the third sets the parallel line's price offset (level 1).
  Middle (0.5) line is dashed, area between filled. Can extend left/right. Handles at the corners move the base points
  or the offset.

## Drawing toolbar / properties
- Floating toolbar appears when a drawing is selected: line color, width (1-4px), style (solid/dashed/dotted),
  lock, clone, hide, delete; text tools get a text field. Locked drawings can be selected but not moved.
- Left toolbar groups tools in flyouts (Lines, Fib, Shapes, Text, Prediction & measurement incl. Long/Short Position,
  Date range, Price range, Date & price range), plus magnet, hide-all and remove-all.
- Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo for drawing edits.
- Crosshair sync across layout charts is by time; session breaks show as faint vertical lines on intraday charts.
