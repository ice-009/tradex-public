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

test("test a signal in the Signal Lab (#22)", async ({ page }) => {
  await openDockTab(page, "Lab");
  const run = page.getByRole("button", { name: /^Run signal test/ });
  await expect(run).toBeEnabled();
  await page.getByLabel("Signal", { exact: true }).selectOption("reversal-1m");
  await run.click();
  const results = page.locator(".tx-lab-results");
  await expect(results).toBeVisible({ timeout: 90_000 });
  await expect(results.getByRole("heading", { name: /Long–short spread/ })).toBeVisible();
  await expect(results.getByRole("heading", { name: /Decay/ })).toBeVisible();
  await expect(results.getByRole("heading", { name: /Turnover/ })).toBeVisible();
  await expect(results.locator(".tx-stamp")).toContainText("Stamp");
  await expect(results.getByRole("link", { name: /Open report card/ })).toHaveAttribute("href", /^\/lab\/reversal-1m\?variant=/);
});

test("open a signal's report card (#23)", async ({ page }) => {
  await page.goto("/lab");
  const row = page.locator("tr", { has: page.getByRole("link", { name: "1-month reversal", exact: true }) });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "1-month reversal", exact: true }).click();
  await expect(page).toHaveURL(/\/lab\/reversal-1m/);
  // Stored by the Lab test above; run here when this test runs alone.
  const runNow = page.getByRole("button", { name: "Run it now" });
  const verdict = page.locator(".tx-card-verdict");
  await expect(runNow.or(verdict)).toBeVisible();
  if (await runNow.isVisible()) await runNow.click();
  await expect(verdict).toBeVisible({ timeout: 90_000 });
  await expect(verdict.locator(".tx-card-badge")).toHaveText(/Works|No edge|Too little data/);
  await expect(page.getByRole("heading", { name: /Equity curve of the long–short spread/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Cumulative net spread at \d+ sessions/ }).or(page.getByText(/Too few non-overlapping/))).toBeVisible();
  await expect(page.getByRole("img", { name: /Net spread by horizon/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /By market regime/ })).toBeVisible();
  await expect(page.locator(".tx-stamp")).toContainText("Stamp");
  await expect(page.locator(".tx-trials")).toBeVisible();
  await page.getByRole("group", { name: "Horizon" }).getByRole("button", { name: "1d", exact: true }).click();
  await expect(verdict).toContainText("at 1 session");
  await page.getByRole("link", { name: "Report cards" }).click();
  await expect(page.locator("tr", { has: page.getByRole("link", { name: "1-month reversal", exact: true }) }).locator(".tx-card-badge")).toBeVisible();
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

test("scroll a daily chart back past the stored 5 years: older bars load, a renamed stock's history joined (#18, #16)", async ({ page }) => {
  await openSymbol(page, "INFY");
  await pickInterval(page, "D");
  const canvas = chartCell(page).locator("canvas").first();
  await canvas.hover();
  // Zoom all the way out: the whole 5 years fit, the left edge is in view, and the chart asks for the bars before it.
  const older = page.waitForResponse((response) => response.url().includes("/api/chart") && response.url().includes("INFY") && response.url().includes("from="));
  for (let i = 0; i < 12; i += 1) await page.keyboard.press("Shift+ArrowDown");
  const body = await (await older).json();
  expect(body.source).toBe("broker");
  // Ten years before the first stored bar, through 2011 when INFOSYSTCH became INFY: one series, no break.
  expect(body.priceSeries.length).toBeGreaterThan(2000);
  const days: number[] = body.priceSeries.map((point: { date: string }) => Date.parse(point.date));
  const gaps = days.slice(1).filter((day, i) => day - days[i] > 5 * 86_400_000);
  expect(gaps, "no stretch of missing sessions").toEqual([]);
  expect(body.hasOlder, "and more before that, back to 1994").toBe(true);
});
