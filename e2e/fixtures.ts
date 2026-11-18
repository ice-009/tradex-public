import { test as base, expect, type Locator, type Page } from "@playwright/test";

/** The stub hub's "now" (e2e/stub-hub.mjs FROZEN_NOW): Saturday 2026-11-14, 12:00 IST, the day after its last session. */
export const FROZEN_NOW = new Date("2026-11-14T06:30:00Z");

export const USER = { name: "E2E Trader", email: "e2e@tradex.test", password: "e2e-password-1" };

/**
 * Every test: the browser's clock is frozen at FROZEN_NOW (market closed, same
 * session maths on every run), and an uncaught page error fails the test.
 */
export const test = base.extend<{ pageErrors: Error[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      await use(errors);
      expect(errors.map((error) => error.message), "uncaught errors in the page").toEqual([]);
    },
    { auto: true },
  ],
  page: async ({ page }, use) => {
    await page.clock.setFixedTime(FROZEN_NOW);
    await use(page);
  },
});

export { expect };

/** The terminal, signed in, with its first chart drawn. */
export async function openTerminal(page: Page) {
  await page.goto("/");
  await expect(page.locator(".tx-root")).toBeVisible();
  await chartReady(page);
}

/** The (only) chart cell. */
export const chartCell = (page: Page): Locator => page.locator(".tx-cell").first();

/** Wait until the chart has its data and no spinner, error or sample-data badge. */
export async function chartReady(page: Page, symbol?: string) {
  const cell = chartCell(page);
  if (symbol) await expect(cell.locator(".tx-legend-symbol")).toHaveText(symbol);
  await expect(cell.locator(".tx-legend-ohlc")).toBeVisible();
  await expect(cell.locator(".tx-cell-overlay")).toHaveCount(0);
  await expect(cell.locator(".tx-sample-badge"), "the chart should come from the hub, not sample data").toHaveCount(0);
  // Let the canvas finish its frame (it draws on requestAnimationFrame) once fonts are in.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** Change the chart's symbol through symbol search. */
export async function openSymbol(page: Page, symbol: string) {
  await page.locator(".tx-symbol-btn").click();
  const input = page.getByPlaceholder("Symbol or company, e.g. RELIANCE, Nifty Bank");
  await input.fill(symbol);
  await page.locator(".tx-search-row", { has: page.locator(".tx-search-symbol", { hasText: new RegExp(`^${symbol}$`) }) }).first().click();
  await chartReady(page, symbol);
}

/** Pick an interval from the top bar (1m, 5m, 15m, 1h, 4h, D, W, M). */
export async function pickInterval(page: Page, label: string) {
  await page.locator(".tx-interval", { hasText: new RegExp(`^${label}$`) }).click();
  await expect(page.locator(".tx-interval.is-active")).toHaveText(label);
  await chartReady(page);
}

/** A bottom-dock tab (Plan, Explore, Compare, Day High/Low, Backtest). */
export async function openDockTab(page: Page, name: string) {
  const tab = page.locator(".tx-dock-tab", { hasText: new RegExp(`^${name}`) });
  // Clicking the open tab closes the panel.
  if (!(await tab.getAttribute("class"))?.includes("is-active")) await tab.click();
  await expect(tab).toHaveClass(/is-active/);
}
