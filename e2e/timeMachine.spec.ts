import { chartCell, chartReady, expect, openDockTab, openSymbol, test } from "./fixtures";

// The Time Machine (#31) against the stub hub: open the terminal as of a past
// day and check that nothing after it shows. 15 Jun 2025 is a Sunday, so the
// terminal shows Friday 13 Jun 2025. The stub knows one bonus after it
// (RELIANCE 1:1 on 1 Sep 2025), so RELIANCE shows twice its adjusted price.

const ASKED = "2025-06-15";
const SHOWN = "2025-06-13";
const SHOWN_DAY = Date.parse(`${SHOWN}T00:00:00Z`);

test("open the terminal as it was on a past day: banner, chart ending that day, screener and plan as of it", async ({ page }) => {
  const firstChart = page.waitForResponse((response) => response.url().includes("/api/chart") && response.url().includes(`asOf=${ASKED}`) && response.url().includes("interval=1d"));
  await page.goto(`/?asOf=${ASKED}`);
  await expect(page.locator(".tx-root")).toBeVisible();

  // The banner says which day is shown, and why not the one asked for.
  const banner = page.getByTestId("time-machine-banner");
  await expect(banner).toContainText("Time Machine: 13 Jun 2025");
  await expect(banner).toContainText("data after this day is hidden");
  await expect(banner).toContainText("15 Jun 2025 was a Sunday");
  await expect(page.locator(".tx-status-past")).toHaveText("Time Machine");

  // The chart switched to daily (no intraday candles that far back) and ends at that day's close.
  const body = await (await firstChart).json();
  expect(body.asOf.day).toBe(SHOWN_DAY);
  expect(body.priceSeries.length).toBeGreaterThan(100);
  expect(body.priceSeries.at(-1).date.slice(0, 10)).toBe(SHOWN);
  await chartReady(page);

  // RELIANCE as it traded before its (later) 1:1 bonus: twice the adjusted close of that day.
  const reliance = page.waitForResponse((response) => response.url().includes("/api/chart") && response.url().includes("RELIANCE") && response.url().includes("asOf="));
  await openSymbol(page, "RELIANCE");
  const asOf = await (await reliance).json();
  expect(asOf.asOf.priceScale).toBe(2);
  expect(asOf.priceSeries.at(-1).date.slice(0, 10)).toBe(SHOWN);
  const live = await (await page.request.get("/api/chart?symbol=RELIANCE&interval=1d&range=5y")).json();
  const sameDay = live.priceSeries.find((point: { date: string }) => point.date.startsWith(SHOWN));
  expect(asOf.priceSeries.at(-1).close).toBeCloseTo(sameDay.close * 2, 6);
  expect(live.priceSeries.at(-1).date > asOf.priceSeries.at(-1).date).toBe(true);

  // The screener ran on that day's close (the terminal asked for it on load).
  await openDockTab(page, "Explore");
  await expect(page.getByTestId("screener-as-of")).toContainText("As of 13 Jun 2025 close");
  const rows = page.locator(".tx-scr-table tbody tr");
  await expect(rows.first()).toBeVisible();
  const ready = await (await page.request.get(`/api/screener?universe=fno&asOf=${ASKED}`)).json();
  expect(ready.status).toBe("ready");
  expect(ready.asOf.eodDate).toBe(SHOWN_DAY);
  expect(ready.asOf.live).toBe(false);
  for (const list of Object.values(ready.results) as Array<Array<{ date: number }>>) for (const row of list) expect(row.date).toBeLessThanOrEqual(SHOWN_DAY);

  // Live-only panels are off; the plan's evidence is the five years ending that day.
  await openDockTab(page, "Day High/Low");
  await expect(page.locator(".tx-tm-off")).toContainText("isn't available in the Time Machine");
  await expect
    .poll(async () => (await (await page.request.get(`/api/plan/evidence?asOf=${ASKED}`)).json()).status, { timeout: 90_000, intervals: [2_000] })
    .toBe("ready");
  const evidence = await (await page.request.get(`/api/plan/evidence?asOf=${ASKED}`)).json();
  expect(evidence.asOf).toBe(SHOWN_DAY);
  expect(evidence.table.to).toBeLessThanOrEqual(SHOWN_DAY);
  await openDockTab(page, "Plan");
  await expect(page.locator(".tx-tm-note")).toContainText("aren't shown as of 13 Jun 2025");
  // The trade coach (#42) reads the journal: hidden with it.
  await expect(page.locator(".tx-coach")).toHaveCount(0);

  // Back to live: the banner goes, the URL loses the day.
  await banner.getByRole("button", { name: "Back to live" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page).not.toHaveURL(/asOf=/);
});

test("a bad date is refused with the reason", async ({ page }) => {
  const answer = await page.request.get("/api/time-machine?asOf=1990-01-01");
  expect(answer.status()).toBe(400);
  expect((await answer.json()).error).toMatch(/3 Nov 1994/);
  expect((await (await page.request.get("/api/time-machine?asOf=2099-01-01")).json()).status).toBe("live");
});
