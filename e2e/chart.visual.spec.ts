import { chartCell, chartReady, expect, openDockTab, openSymbol, openTerminal, pickInterval, test } from "./fixtures";

// Visual regression for the canvas chart: candles, the trade-plan overlay and
// drawings, compared with baselines in e2e/__screenshots__ (with a small
// tolerance for anti-aliasing). Baselines are rendered on Linux in the
// Playwright container CI uses, so these run only there: `npm run e2e:docker`
// runs them locally, and `npm run e2e:docker -- --update-snapshots` re-renders them.
test.skip(process.platform !== "linux" && !process.env.E2E_VISUAL, "chart screenshots are compared on Linux only (npm run e2e:docker)");

const canvasHost = (page: Parameters<typeof chartCell>[0]) => chartCell(page).locator(".tx-canvas-host");

/** Park the mouse outside the chart so no crosshair is drawn. */
async function moveAway(page: Parameters<typeof chartCell>[0]) {
  await page.mouse.move(2, 890);
  await chartReady(page);
}

test.beforeEach(async ({ page }) => {
  await openTerminal(page);
});

test("candles", async ({ page }) => {
  await openSymbol(page, "SBIN");
  await pickInterval(page, "D");
  await moveAway(page);
  await expect(canvasHost(page)).toHaveScreenshot("candles-sbin-1d.png");

  await pickInterval(page, "1h");
  await moveAway(page);
  await expect(canvasHost(page)).toHaveScreenshot("candles-sbin-1h.png");
});

test("trade-plan overlay", async ({ page }) => {
  await openDockTab(page, "Explore");
  const row = page.locator(".tx-scr-table tbody tr").first();
  await expect(row).toBeVisible();
  const symbol = (await row.locator(".tx-scr-symbol").textContent())!.trim();
  await row.click();
  await chartReady(page, symbol);
  const toggle = chartCell(page).getByRole("button", { name: "Show or hide the trade plan" });
  await expect(toggle).toHaveClass(/is-on/);
  await moveAway(page);
  await expect(canvasHost(page)).toHaveScreenshot("plan-overlay.png");
});

test("drawings", async ({ page }) => {
  await openSymbol(page, "SBIN");
  await pickInterval(page, "D");
  const box = (await canvasHost(page).boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + box.width * x, y: box.y + box.height * y });

  // Trend line: Alt+T, then two clicks.
  await page.keyboard.press("Alt+KeyT");
  for (const point of [at(0.2, 0.7), at(0.7, 0.3)]) await page.mouse.click(point.x, point.y);
  // Horizontal line: Alt+H, one click.
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(at(0.5, 0.5).x, at(0.5, 0.5).y);
  // Rectangle: Alt+R, two clicks.
  await page.keyboard.press("Alt+KeyR");
  for (const point of [at(0.3, 0.2), at(0.45, 0.4)]) await page.mouse.click(point.x, point.y);
  await page.keyboard.press("Escape");

  await moveAway(page);
  await expect(canvasHost(page)).toHaveScreenshot("drawings.png");
});
