import { chartCell, expect, openDockTab, openSymbol, openTerminal, pickInterval, test } from "./fixtures";

// The terminal's main flows against the stub hub: if one of these breaks, CI fails.

test.beforeEach(async ({ page }) => {
  await openTerminal(page);
});

test("the hub is connected and the chart shows its data", async ({ page }) => {
  await expect(page.locator(".tx-hub-banner"), "no 'Connect a Market Data Hub' banner").toHaveCount(0);
  const status = await page.request.get("/api/broker/status");
  expect(status.ok()).toBe(true);
  expect(JSON.stringify(await status.json())).toContain("0.0.0-e2e-stub");
});

test("open a chart: symbol search, interval, legend", async ({ page }) => {
  const chart = page.waitForResponse((response) => response.url().includes("/api/chart") && response.url().includes("RELIANCE"));
  await openSymbol(page, "RELIANCE");
  const body = await (await chart).json();
  expect(body.source, "candles from the hub").toBe("broker");
  expect(body.priceSeries.length).toBeGreaterThan(100);

  await pickInterval(page, "D");
  const cell = chartCell(page);
  await expect(cell.locator(".tx-legend-dim")).toContainText("· D ·");
  // The stub's last daily bar for RELIANCE is in the legend.
  await expect(cell.locator(".tx-legend-ohlc")).toContainText("O");
  // The canvas really drew something (not a blank plot).
  const inked = await cell.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 97) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return colours.size;
  });
  expect(inked).toBeGreaterThan(10);
});

test("run a screen: the screener lists ideas and opens one on the chart", async ({ page }) => {
  await openDockTab(page, "Explore");
  const rows = page.locator(".tx-scr-table tbody tr");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(3);

  // Narrow to one horizon, then open the first idea.
  await page.locator(".tx-scr-tab.tx-hz-swing").click();
  await expect(page.locator(".tx-scr-tab.tx-hz-swing")).toHaveClass(/is-active/);
  await expect(rows.first()).toBeVisible();
  const symbol = (await rows.first().locator(".tx-scr-symbol").textContent())!.trim();
  await rows.first().click();
  await expect(chartCell(page).locator(".tx-legend-symbol")).toHaveText(symbol);
  await expect(chartCell(page).getByRole("button", { name: "Show or hide the trade plan" })).toBeVisible();
});

test("run a backtest", async ({ page }) => {
  await openDockTab(page, "Backtest");
  const run = page.getByRole("button", { name: /^Run backtest/ });
  await expect(run).toBeEnabled();
  await run.click();
  const results = page.locator(".tx-bt-results");
  await expect(results).toBeVisible({ timeout: 60_000 });
  await expect(results.locator(".tx-bt-kpis")).toContainText("Total return");
  await expect(results.locator(".tx-bt-kpis")).toContainText("Trades");
  await expect(results.getByRole("heading", { name: "By strategy" })).toBeVisible();
});

test("open the plan", async ({ page }) => {
  await openDockTab(page, "Plan");
  const plan = page.locator(".tx-plan-section").first();
  await expect(plan).toContainText("TODAY'S PLAN");
  await expect(plan).toContainText(/slots free/);
  // The evidence (every screen replayed over the stored history) is computed, and the plan lists ideas.
  await expect(plan.locator(".tx-plan-ideas li").first()).toBeVisible({ timeout: 60_000 });
  await expect(plan).not.toContainText("couldn't be computed");
  await expect(page.getByText("Show the evidence")).toBeVisible();
});
