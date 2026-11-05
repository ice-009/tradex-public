## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, screens you checked (iPad / laptop), backtest results for screen or scoring changes (including out-of-sample). -->

## Checklist

- [ ] `npm run check` passes (typecheck, lint with layer rules, unit tests)
- [ ] `npm run build` passes
- [ ] New logic in `src/core` has tests
- [ ] Broker calls go through the data engine (no direct API calls from new places)
- [ ] No secrets, `.env`, `*.db` or `.cache/` files included
