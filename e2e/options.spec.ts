import { chartCell, chartReady, expect, openSymbol, openTerminal, test } from "./fixtures";

// The Options side panel (#36) against the stub hub's generated option
// summaries (e2e/stub-hub.mjs): one underlying's IV term structure, rank, IV
// history, straddle move, skew and levels; the day's cross-section; the hub's
// "nothing stored yet" answer; and the Time Machine — as of a past day the
// panel shows that day and nothing after it.

const LAST = "2026-11-13";
const LAST_DAY = Date.parse(`${LAST}T00:00:00Z`);

async function openOptions(page: import("@playwright/test").Page) {
  const button = page.locator(".tx-widget-btn[title^='Options:']");
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  await expect(page.getByTestId("options-panel")).toBeVisible();
}

test("the Options panel shows the charted stock's option summary, its IV history and the day's cross-section", async ({ page }) => {
  await openTerminal(page);
  await openSymbol(page, "SBIN");
  await openOptions(page);
  const panel = page.getByTestId("options-panel");

  await expect(panel.getByTestId("options-day")).toHaveText("13 Nov 2026");
  await expect(panel).toContainText("Implied volatility");
  await expect(panel.getByTestId("options-rank")).toContainText(/IV rank \d+ · percentile \d+/);
  await expect(panel.getByTestId("options-move")).toContainText(/±\d+\.\d%/);
  await expect(panel).toContainText("25Δ put");
  await expect(panel).toContainText("Max pain");
  await expect(panel.getByTestId("options-iv-chart").locator("svg path.tx-opt-line-iv30")).toHaveCount(1);
  if (process.env.OPTIONS_SHOT) {
    await page.addStyleTag({ content: ".tx-side-bottom, .tx-side-hsplit { display: none !important } .tx-opt { overflow: visible !important }" });
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.locator(".tx-side").screenshot({ path: process.env.OPTIONS_SHOT });
  }

  // The API answer behind it: the year up to the stub's last session, ranked on 60+ days.
  const answer = await (await page.request.get("/api/options?symbol=SBIN&range=1y")).json();
  expect(answer.status).toBe("ready");
  expect(answer.day.date).toBe(LAST);
  expect(answer.history.at(-1).day).toBe(LAST_DAY);
  expect(answer.history.length).toBeGreaterThan(200);
  expect(answer.rank.days).toBeGreaterThanOrEqual(60);
  expect(answer.view.move.pct).toBeCloseTo(answer.day.near.expectedMovePct, 2); // the hub rounds the straddle to paise

  // Five years of history on request.
  await panel.getByRole("tab", { name: "5Y" }).click();
  await expect(panel.getByTestId("options-iv-chart").locator("svg")).toBeVisible();
  const five = await (await page.request.get("/api/options?symbol=SBIN&range=5y")).json();
  expect(five.history.length).toBeGreaterThan(1_000);

  // A future's chart reads its underlying's options; an index has its own.
  expect((await (await page.request.get("/api/options?symbol=SBIN26NOVFUT")).json()).symbol).toBe("SBIN");
  expect((await (await page.request.get("/api/options?symbol=NIFTY")).json()).day.kind).toBe("index");

  // Market: every underlying that day, sorted by IV rank; a row opens its chart.
  await page.locator(".tx-side").getByRole("tab", { name: "Market", exact: true }).click();
  await expect(panel.getByTestId("options-market-day")).toContainText("13 Nov 2026");
  const rows = panel.locator(".tx-opt-row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(50);
  const first = (await rows.first().locator(".tx-wl-symbol-text").textContent())!;
  await rows.first().click();
  await chartReady(page, first);
  await expect(chartCell(page).locator(".tx-legend-symbol")).toHaveText(first);
});

test("a hub with no option summaries stored says how to fill it", async ({ page }) => {
  // The stub answers TCS like a hub before its backfill: 503 not_ready.
  const answer = await (await page.request.get("/api/options?symbol=TCS")).json();
  expect(answer).toMatchObject({ status: "unavailable", reason: "not_ready" });
  expect(answer.message).toMatch(/hub data nse-history --only options/);

  await openTerminal(page);
  await openSymbol(page, "TCS");
  await openOptions(page);
  await expect(page.getByTestId("options-unavailable")).toHaveAttribute("data-reason", "not_ready");
});

test("as of a past day the panel shows that day's options and nothing after it", async ({ page }) => {
  const ASKED = "2025-06-15";
  const SHOWN = "2025-06-13";
  const SHOWN_DAY = Date.parse(`${SHOWN}T00:00:00Z`);
  const request = page.waitForRequest((req) => req.url().includes("/api/options?") && req.url().includes(`asOf=${ASKED}`));
  await page.goto(`/?asOf=${ASKED}`);
  await expect(page.locator(".tx-root")).toBeVisible();
  await chartReady(page);
  await openSymbol(page, "SBIN");
  await openOptions(page);
  await request;
  await expect(page.getByTestId("options-panel").getByTestId("options-day")).toHaveText("13 Jun 2025");

  const answer = await (await page.request.get(`/api/options?symbol=SBIN&range=5y&asOf=${ASKED}`)).json();
  expect(answer.status).toBe("ready");
  expect(answer.day.date).toBe(SHOWN);
  expect(answer.lastDate).toBeNull();
  expect(answer.asOf.day).toBe(SHOWN_DAY);
  expect(Math.max(...answer.history.map((point: { day: number }) => point.day))).toBe(SHOWN_DAY);
  expect(answer.rank.to).toBe(SHOWN_DAY);

  const day = await (await page.request.get(`/api/options/day?asOf=${ASKED}`)).json();
  expect(day).toMatchObject({ status: "ready", date: SHOWN });

  // The screener as of that day carries that day's option facts (information only, never scored).
  // (Live, the stub's frozen last session is more than a week old by the real clock, so they aren't shown there, as with the OI tag.)
  await expect
    .poll(async () => {
      const screener = await (await page.request.get(`/api/screener?universe=fno&asOf=${ASKED}`)).json();
      const rows = Object.values(screener.results ?? {}).flat() as Array<{ options?: { day: number } }>;
      return [...new Set(rows.flatMap((row) => (row.options ? [row.options.day] : [])))];
    }, { timeout: 60_000, intervals: [1_000] })
    .toEqual([SHOWN_DAY]);
});
