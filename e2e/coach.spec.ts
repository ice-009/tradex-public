import type { APIRequestContext } from "@playwright/test";
import { expect, openDockTab, openTerminal, test } from "./fixtures";

// The trade coach (#42) against the stub hub: trades made through the API on
// the fixture's sessions, then the coach's report and its section in the Plan
// tab. Each run starts and ends with an empty journal (the account is shared).

const SYMBOL = "TCS";
/** Epoch ms of an IST clock time on a YYYY-MM-DD date. */
const ist = (date: string, hh: number, mm: number) => Date.parse(`${date}T00:00:00Z`) + (hh * 60 + mm - 330) * 60_000;

async function clearJournal(request: APIRequestContext) {
  const answer = await request.get("/api/trades");
  expect(answer.ok()).toBe(true);
  for (const trade of (await answer.json()).trades as Array<{ id: string }>) expect((await request.delete(`/api/trades/${trade.id}`)).ok()).toBe(true);
}

test.afterEach(async ({ page }) => {
  await clearJournal(page.request);
});

test("the coach explains an empty journal, then reviews closed trades (#42)", async ({ page }) => {
  const request = page.request;
  await clearJournal(request);

  // Live only: the Time Machine gets "past".
  const past = await (await request.get("/api/trades/coach?asOf=2026-10-01")).json();
  expect(past.status).toBe("past");

  // No closed trades: a short explanation in the Plan tab, not empty tables.
  await openTerminal(page);
  await openDockTab(page, "Plan");
  const coach = page.locator(".tx-coach");
  await expect(coach).toContainText("COACH");
  await expect(coach.locator(".tx-coach-empty")).toContainText("No closed trades yet");
  await expect(coach.locator("table")).toHaveCount(0);

  // The stub's daily bars for the trades' sessions (the chart reads the same hub).
  const chart = await (await request.get(`/api/chart?symbol=${SYMBOL}&interval=1d&range=3mo`)).json();
  const closeOn = (date: string) => {
    const bar = (chart.priceSeries as Array<{ date: string; close: number }>).find((point) => point.date.startsWith(date));
    expect(bar, `a stub bar on ${date}`).toBeTruthy();
    return bar!.close;
  };

  const take = async (date: string, hh: number, mm: number, patch: Record<string, unknown> = {}) => {
    const entry = closeOn(date);
    const answer = await request.post("/api/trades", {
      data: {
        symbol: SYMBOL,
        screenId: "res-drift",
        plannedEntry: entry,
        stop: Math.round(entry * 0.97 * 20) / 20,
        target: Math.round(entry * 1.5 * 20) / 20,
        exitRule: "stop-target",
        holdSessions: 10,
        entryPrice: entry,
        entryAt: ist(date, hh, mm),
        lots: 1,
        lotSize: 175,
        entryKind: "close",
        planLots: 1,
        ...patch,
      },
    });
    expect(answer.ok(), await answer.text()).toBe(true);
    return (await answer.json()) as { id: string; stop: number };
  };
  const close = async (id: string, date: string, hh: number, mm: number) => {
    const answer = await request.post(`/api/trades/${id}/close`, { data: { exitPrice: closeOn(date), exitAt: ist(date, hh, mm), reason: "manual" } });
    expect(answer.ok(), await answer.text()).toBe(true);
  };

  // 1: by the plan. 2: bought at 1 PM, outside the 3:15–3:25 PM window. 3: three lots where the plan sized one, and the stop moved down.
  const onPlan = await take("2026-11-02", 15, 20);
  await close(onPlan.id, "2026-11-05", 15, 25);
  const early = await take("2026-10-26", 13, 0);
  await close(early.id, "2026-10-28", 15, 25);
  const big = await take("2026-10-19", 15, 21, { lots: 3 });
  const moved = await request.patch(`/api/trades/${big.id}`, { data: { stop: Math.round((big.stop - 5) * 20) / 20 } });
  expect(moved.ok()).toBe(true);
  await close(big.id, "2026-10-22", 15, 25);
  // One still open: its entry rules are checked, nothing else.
  await take("2026-11-12", 15, 18);

  const answer = await (await request.get("/api/trades/coach")).json();
  expect(answer.status).toBe("ready");
  const report = answer.report;
  expect(report.closed).toBe(3);
  expect(report.open).toBe(1);
  const rule = (id: string) => report.rules.find((entry: { rule: string }) => entry.rule === id);
  expect(rule("entry")).toMatchObject({ checked: 4, broken: 1, unchecked: 0 });
  expect(rule("oversized")).toMatchObject({ checked: 4, broken: 1 });
  expect(rule("stop-moved")).toMatchObject({ checked: 4, broken: 1 });
  expect(rule("held-past-exit")).toMatchObject({ checked: 3, broken: 0 });
  // Inside the hub's year of intraday candles: MAE / MFE on 15-minute candles, in R and never negative.
  expect(report.resolution).toEqual({ intraday: 3, daily: 0, none: 0 });
  for (const review of report.reviews.filter((entry: { status: string }) => entry.status === "closed")) {
    expect(review.excursion.resolution).toBe("intraday");
    expect(review.excursion.mae.low).toBeGreaterThanOrEqual(0);
    expect(review.excursion.mfe.high).toBeGreaterThanOrEqual(review.excursion.mfe.low);
    expect(review.held).toBeGreaterThan(0);
  }
  const bigReview = report.reviews.find((entry: { id: string }) => entry.id === big.id);
  expect(bigReview.breaks.map((entry: { rule: string }) => entry.rule).sort()).toEqual(["oversized", "stop-moved"]);
  // R is on the stop as taken (3% below the entry), not the moved one.
  expect(bigReview.risk).toBeCloseTo(closeOn("2026-10-19") - Math.round(closeOn("2026-10-19") * 0.97 * 20) / 20, 6);
  // Three trades: no finding is stated.
  for (const finding of report.findings) {
    expect(finding.mean).toBeNull();
    expect(finding.text).toMatch(/^Too few trades/);
  }

  // The Plan tab's coach section shows the same (the journal reloads on its own every few minutes: reload the page).
  await page.reload();
  await openDockTab(page, "Plan");
  await expect(coach).toContainText("3 closed · 1 open");
  await expect(coach.locator('[data-finding="winners-vs-plan"]')).toContainText("Too few trades");
  await expect(coach.locator('[data-rule="entry"]')).toContainText("1 of 4");
  await expect(coach.locator('[data-rule="oversized"]')).toContainText("1 of 4");
  await coach.getByRole("button", { name: "Show trades" }).click();
  await expect(coach.locator(`[data-trade="${big.id}"]`)).toContainText("Took 3 lots; the plan sized 1");
  await expect(coach.locator(`[data-trade="${early.id}"]`)).toContainText("Bought at 1:00 PM");
});
