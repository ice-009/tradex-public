import { defineConfig, devices } from "@playwright/test";

// End-to-end tests (e2e/): the production build against a stub Market Data Hub
// with fixed fixture data (e2e/stub-hub.mjs). `npm run build` first, then
// `npm run e2e`. See "End-to-end tests" in CONTRIBUTING.md.

const PORT = process.env.E2E_PORT || "3107";
const HUB_PORT = process.env.STUB_HUB_PORT || "8797";
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  // One server and one account for every test: run them one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 20_000,
    // Chart screenshots: allow anti-aliasing noise, not a changed chart.
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, threshold: 0.15, animations: "disabled", caret: "hide" },
  },
  // Baselines are rendered on Linux (CI's Playwright container); no per-platform suffix.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }], ["github"]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "chromium",
      testMatch: /\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, storageState: "e2e/.run/user.json" },
    },
  ],
  webServer: [
    {
      command: "node e2e/stub-hub.mjs",
      url: `http://127.0.0.1:${HUB_PORT}/health`,
      env: { STUB_HUB_PORT: HUB_PORT },
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
    {
      command: "node e2e/serve-app.mjs",
      url: `${baseURL}/auth/signin`,
      env: { E2E_PORT: PORT, STUB_HUB_PORT: HUB_PORT },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
    },
  ],
});
