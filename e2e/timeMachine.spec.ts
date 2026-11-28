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

// Replay and paper trading (#32): step the day with the replay bar, paper-take
// a trade on the day shown, and watch it graded as the replay moves on.
test("replay: step a session, paper-take a trade and see it graded as the days advance", async ({ page }) => {
  await page.goto(`/?asOf=${SHOWN}`);
  const bar = page.getByTestId("replay-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("replay-day")).toContainText("13 Jun 2025");

  const info = await (await page.request.get(`/api/time-machine?asOf=${SHOWN}`)).json();
  const after: string[] = info.sessions.after;
  expect(after.length).toBeGreaterThan(5);
  expect(info.sessions.before.at(-1) < SHOWN).toBe(true);

  // One step forward: the next session, in place of the day in the URL.
  await bar.getByRole("button", { name: "Next session" }).click();
  await expect(page).toHaveURL(new RegExp(`asOf=${after[0]}`));
  await expect(page.getByTestId("time-machine-banner")).toBeVisible();
  await bar.getByRole("button", { name: "Previous session" }).click();
  await expect(page).toHaveURL(new RegExp(`asOf=${SHOWN}`));

  // Paper-take RELIANCE at the close on the day shown: a time exit after 3 sessions, stop and target far away.
  const chart = await (await page.request.get(`/api/chart?symbol=RELIANCE&interval=1d&range=1y&asOf=${SHOWN}`)).json();
  const close = chart.priceSeries.at(-1).close;
  expect((await page.request.post("/api/paper/session", { data: {} })).ok()).toBe(true);
  const take = await page.request.post(`/api/paper?asOf=${SHOWN}`, {
    data: { symbol: "RELIANCE", screenId: "swing-ema-pullback", entryKind: "close", plannedEntry: close, stop: close * 0.5, target: close * 2, exitRule: "time", holdSessions: 3, lots: 1, lotSize: 250, expectedR: 0.1 },
  });
  expect(take.ok()).toBe(true);
  const again = await page.request.post(`/api/paper?asOf=${SHOWN}`, {
    data: { symbol: "RELIANCE", screenId: "swing-ema-pullback", entryKind: "close", plannedEntry: close, stop: close * 0.5, target: close * 2, exitRule: "time", holdSessions: 3, lots: 1, lotSize: 250 },
  });
  expect(again.status()).toBe(400);

  // The day it was taken: open, bought at that close. A session later: still open. Three sessions later: closed at that close.
  const graded = async (day: string) => (await (await page.request.get(`/api/paper?asOf=${day}`)).json()).trades.find((trade: { symbol: string }) => trade.symbol === "RELIANCE");
  expect((await graded(SHOWN)).grade).toMatchObject({ status: "open", entryPrice: close, sessions: 0 });
  expect((await graded(after[0])).grade).toMatchObject({ status: "open", sessions: 1 });
  const third = await (await page.request.get(`/api/chart?symbol=RELIANCE&interval=1d&range=1y&asOf=${after[2]}`)).json();
  const exit = await graded(after[4]);
  expect(exit.grade).toMatchObject({ status: "closed", exitReason: "time", sessions: 3 });
  expect(exit.grade.exitPrice).toBeCloseTo(third.priceSeries.at(-1).close, 6);
  // Stepping back un-does the exit; a day before the trade doesn't grade it.
  expect((await graded(after[1])).grade.status).toBe("open");
  expect((await graded(info.sessions.before.at(-1))).grade.status).toBe("later");

  // The Paper tab shows it, with the session's summary.
  await page.goto(`/?asOf=${after[4]}`);
  await page.getByTestId("dock-paper").click();
  await expect(page.getByTestId("paper-row").first()).toContainText("RELIANCE");
  await expect(page.getByTestId("paper-summary")).toContainText("1 closed");
  await expect(page.getByTestId("paper-chip")).toContainText("1 closed");
});
