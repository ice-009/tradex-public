import { describe, expect, it } from "vitest";
import type { HealthReport } from "@/contracts/api";
import { HUB_DATASETS, assessHealth, candleDatasets, evidenceDataset, hubDatasetHealth, hubJobs, marketState, oiTagHealth, storeHealth, tradexJobs, type AssessInput } from "./healthRules";

/** Epoch ms of an IST wall-clock time (2026-11-18 is a Wednesday). */
const ist = (hours: number, minutes = 0, date = "2026-11-18") => Date.parse(`${date}T00:00:00Z`) + (hours * 60 + minutes - 330) * 60_000;
const meta = (id: string) => HUB_DATASETS.find((dataset) => dataset.id === id)!;
const dayKey = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("market state", () => {
  it("names the session state in IST", () => {
    expect(marketState(ist(8, 0))).toMatchObject({ open: false, label: expect.stringMatching(/^Before the open/) });
    expect(marketState(ist(10, 0))).toMatchObject({ open: true });
    expect(marketState(ist(16, 0))).toMatchObject({ open: false, label: expect.stringMatching(/^Closed for the day/) });
    expect(marketState(ist(11, 0, "2026-11-21"))).toMatchObject({ open: false, label: expect.stringMatching(/weekend/) });
  });
});

describe("hub dataset freshness", () => {
  const fresh = { lastSession: "2026-11-17", lastSuccessAt: ist(19, 0, "2026-11-17"), lastAttemptAt: ist(19, 0, "2026-11-17"), lastError: null };

  it("is waiting during the day while today's evening file isn't due", () => {
    const health = hubDatasetHealth(meta("cashBhav"), fresh, { now: ist(17, 0), problems: [], warnings: [] });
    expect(health).toMatchObject({ state: "waiting", asOf: "2026-11-17", owner: "hub" });
    expect(health.message).toMatch(/by about 20:00 IST.*end at 17 Nov 2026/);
  });

  it("is fresh before the open and once today's file is in", () => {
    expect(hubDatasetHealth(meta("cashBhav"), fresh, { now: ist(8, 0), problems: [], warnings: [] }).state).toBe("ok");
    expect(hubDatasetHealth(meta("cashBhav"), { ...fresh, lastSession: "2026-11-18" }, { now: ist(19, 30), problems: [], warnings: [] }).state).toBe("ok");
  });

  it("is stale when the hub's health check says so, with what that means in Tradex", () => {
    const problem = "F&O bhavcopy is stale: last session stored 2026-11-17, missing 2026-11-18.";
    const health = hubDatasetHealth(meta("foBhav"), fresh, { now: ist(21, 0), problems: ["Cash bhavcopy is stale: …", problem], warnings: [] });
    expect(health.state).toBe("stale");
    expect(health.message).toBe(`${problem} The screener's OI tag shows 17 Nov 2026's open interest.`);
  });

  it("is late (not stale) for the hub's maybe-a-holiday warning", () => {
    const warning = "Cash bhavcopy is stale: last session stored 2026-11-17, missing 2026-11-18. (Fine if today was an exchange holiday.)";
    expect(hubDatasetHealth(meta("cashBhav"), fresh, { now: ist(21, 0), problems: [], warnings: [warning] }).state).toBe("late");
  });

  it("reports a failed newest attempt while the older copy is still in use", () => {
    const entry = { events: 197, lastSuccessAt: ist(9, 0, "2026-11-16"), lastAttemptAt: ist(9, 0), lastError: "NSE timed out" };
    const health = hubDatasetHealth(meta("resultsCalendar"), entry, { now: ist(10, 0), problems: [], warnings: [] });
    expect(health).toMatchObject({ state: "error", error: "NSE timed out", detail: "197 events" });
    expect(health.message).toMatch(/2 days ago/);
    // Hubs reading the PR zip report results dates still to come instead.
    expect(hubDatasetHealth(meta("resultsCalendar"), { ...entry, events: undefined, upcoming: 41 }, { now: ist(10, 0), problems: [], warnings: [] }).detail).toBe("41 upcoming");
    // An error from before the last success is history, not a failure.
    expect(hubDatasetHealth(meta("resultsCalendar"), { ...entry, lastSuccessAt: ist(9, 30) }, { now: ist(10, 0), problems: [], warnings: [] }).state).toBe("ok");
  });

  it("is missing when the hub has nothing", () => {
    expect(hubDatasetHealth(meta("lots"), undefined, { now: ist(10, 0), problems: ["Lot sizes: never fetched."], warnings: [] })).toMatchObject({ state: "missing", message: "Lot sizes: never fetched." });
  });

  it("lists stored candles as information", () => {
    expect(candleDatasets([{ tf: "15m", series: 35, candles: 176288, lastSession: "2026-11-12T09:30:00.000Z" }])[0]).toMatchObject({ state: "info", asOf: "2026-11-12", detail: "35 series · 1,76,288 candles" });
  });
});

describe("Tradex's own copies", () => {
  const store = { phase: "done" as const, message: "", finishedAt: ist(16, 30), queued: 0, lastBar: dayKey("2026-11-17") };

  it("flags the daily-bar store when it is behind the hub", () => {
    expect(storeHealth(store, "2026-11-17").state).toBe("ok");
    const behind = storeHealth({ ...store, lastBar: dayKey("2026-11-14") }, "2026-11-17");
    expect(behind.state).toBe("stale");
    expect(behind.message).toMatch(/through 14 Nov 2026; the hub has 17 Nov 2026/);
  });

  it("says when the store hasn't been read, is waiting on hub downloads, or failed", () => {
    expect(storeHealth({ ...store, phase: "idle", lastBar: null, finishedAt: null }, "2026-11-17").state).toBe("info");
    expect(storeHealth({ ...store, queued: 3 }, "2026-11-17")).toMatchObject({ state: "waiting", message: expect.stringMatching(/downloading 3 symbols/) });
    expect(storeHealth({ ...store, phase: "error", message: "Market Data Hub 503" }, "2026-11-17")).toMatchObject({ state: "error", error: "Market Data Hub 503" });
  });

  it("judges the OI tag against the hub's newest F&O file", () => {
    const now = ist(10, 0);
    expect(oiTagHealth({ day: dayKey("2026-11-17"), fetchedAt: now, answered: true }, "2026-11-17", now).state).toBe("ok");
    expect(oiTagHealth({ day: dayKey("2026-11-14"), fetchedAt: now, answered: true }, "2026-11-17", now).state).toBe("stale");
    expect(oiTagHealth({ day: dayKey("2026-11-05"), fetchedAt: now, answered: true }, "2026-11-05", now).message).toMatch(/hides the tag/);
    expect(oiTagHealth({ day: null, fetchedAt: null, answered: false }, null, now).state).toBe("info");
    expect(oiTagHealth({ day: null, fetchedAt: now, answered: false }, null, now).state).toBe("error");
  });

  it("shows the plan evidence recomputing", () => {
    expect(evidenceDataset({ through: dayKey("2026-11-17"), computedAt: ist(16, 5), pending: { done: 40, total: 1200 }, error: null })).toMatchObject({ state: "waiting", asOf: "2026-11-17" });
    expect(evidenceDataset({ through: null, computedAt: null, pending: null, error: { message: "Not enough history" } }).state).toBe("error");
  });
});

describe("jobs", () => {
  it("describes the hub's backfills and gap repair", () => {
    const jobs = hubJobs(
      [{ id: 7, kind: "backfill", params: { tf: "15m", universe: "fno" }, state: "paused", done: 40, total: 200, failed: 2, message: "Market hours: paused.", resumeAfter: ist(15, 35), updatedAt: ist(9, 15) }],
      { running: true, pending: 63, last: { reason: "gap", startedAt: ist(9, 20), finishedAt: ist(9, 30), calls: 40, bars: 119 } },
    );
    expect(jobs[0]).toMatchObject({ label: "Hub backfill (15m fno)", state: "paused", progress: "40 / 200 · 2 failures", message: "Market hours: paused. · resumes 15:35 IST" });
    expect(jobs[1]).toMatchObject({ id: "hub-recovery", state: "running", progress: "last run: 40 calls, 119 bars", message: "63 repairs waiting" });
  });

  it("describes Tradex's background work", () => {
    const jobs = tradexJobs({
      store: { phase: "history", message: "Reading daily bars", finishedAt: null, queued: 0, lastBar: null, done: 120, total: 239 },
      evidence: { computedAt: ist(9, 0), pending: null, error: { message: "boom", at: ist(9, 30) } },
      highLow: { running: true, status: "live", lastPollAt: ist(10, 0), sweepMs: 90_000, instruments: 400 },
    });
    expect(jobs.map((job) => [job.id, job.state, job.progress])).toEqual([
      ["tradex-daily-sync", "running", "120 / 239"],
      ["tradex-evidence", "failed", null],
      ["tradex-highlow", "running", "400 instruments"],
    ]);
    expect(jobs[2].message).toMatch(/every 90 s/);
  });
});

describe("why a number may be old", () => {
  const hub: HealthReport["hub"] = { configured: true, url: "http://127.0.0.1:8787", reachable: true, error: null, version: "0.1.0", healthy: true, problems: [], warnings: [], brokerConnected: true, endOfDay: false, modeNote: null, feed: "socket", streamOpen: true, checkedAt: ist(10, 0), uptimeSec: 100, keyName: "tradex", scopes: ["history"], streams: 1 };
  const live: HealthReport["live"] = {
    hubFeed: null,
    hubStream: { running: true, open: true, openedAt: ist(9, 15), symbols: 5, connects: 1, failures: 0, lastError: null, lastErrorAt: null, lastHeardAt: ist(10, 0) },
    market: { mode: "live", source: "hub", live: 5, polled: 0, subscribers: 1, lastTickAt: ist(10, 0), lastPollAt: null, lastRestartAt: null },
    sources: [{ id: "hub", label: "Market Data Hub", lastError: null, restingUntil: null }],
  };
  const base: AssessInput = { now: ist(10, 0), market: marketState(ist(10, 0)), hub, budget: null, live, datasets: [], jobs: [] };

  it("is ok with nothing to say during a healthy session", () => {
    expect(assessHealth(base)).toEqual({ verdict: "ok", issues: [] });
  });

  it("says so, without calling it a problem, when the hub has no broker (end-of-day data)", () => {
    const eod = assessHealth({ ...base, hub: { ...hub, brokerConnected: false, endOfDay: true, modeNote: "Live quotes and intraday charts need a broker on the hub." }, live: { ...live, hubStream: null } });
    expect(eod.verdict).toBe("ok");
    expect(eod.issues).toEqual([{ severity: "info", area: "hub", text: "End-of-day data (no broker connected). Live quotes and intraday charts need a broker on the hub." }]);
  });

  it("is down without a hub, or when it can't be reached", () => {
    expect(assessHealth({ ...base, hub: { ...hub, configured: false } })).toMatchObject({ verdict: "down", issues: [{ severity: "problem", area: "hub" }] });
    const unreachable = assessHealth({ ...base, hub: { ...hub, reachable: false, error: "network error (ECONNREFUSED)" } });
    expect(unreachable.verdict).toBe("down");
    expect(unreachable.issues[0].text).toMatch(/can't reach the hub at http:\/\/127\.0\.0\.1:8787 \(network error/);
  });

  it("passes the hub's problems on, worst first, and doesn't repeat them per dataset", () => {
    const problem = "Cash bhavcopy is stale: last session stored 2026-11-16, missing 2026-11-17.";
    const stale = hubDatasetHealth(meta("cashBhav"), { lastSession: "2026-11-16", lastSuccessAt: 1 }, { now: ist(21, 0), problems: [problem], warnings: [] });
    const result = assessHealth({ ...base, now: ist(21, 0), market: marketState(ist(21, 0)), hub: { ...hub, healthy: false, problems: [problem], warnings: ["Another hub process owns the broker connection."] }, datasets: [stale] });
    expect(result.verdict).toBe("degraded");
    expect(result.issues.map((issue) => [issue.severity, issue.text.slice(0, 20)])).toEqual([
      ["problem", `Hub: ${problem}`.slice(0, 20)],
      ["warning", "Hub: Another hub pro"],
      ["info", "Market: Closed for t"],
    ]);
  });

  it("explains a dead live stream, quiet ticks, a resting source and a spent budget", () => {
    const result = assessHealth({
      ...base,
      now: ist(11, 0),
      market: marketState(ist(11, 0)),
      live: {
        ...live,
        hubStream: { ...live.hubStream!, open: false, failures: 3, lastError: "Market Data Hub network error" },
        market: { ...live.market, lastTickAt: ist(10, 50) },
        sources: [{ id: "hub", label: "Market Data Hub", lastError: "503", restingUntil: ist(11, 0, "2026-11-18") + 20_000 }],
      },
      budget: { plan: "standard", usedToday: 4300, dayCap: 4750, usedThisMinute: 3, minuteCap: 40, byPriority: {}, strikes: 0, slowed: false, coolingDown: false, stoppedForToday: false },
    });
    const texts = result.issues.map((issue) => issue.text).join("\n");
    expect(result.verdict).toBe("degraded");
    expect(texts).toMatch(/resting until 11:00 IST/);
    expect(texts).toMatch(/live stream from the hub is down \(Market Data Hub network error\); prices are polled/);
    expect(texts).toMatch(/No live price has arrived for 10 min/);
    expect(texts).toMatch(/used 91% of today's broker calls/);
  });

  it("raises Tradex-side staleness and failed jobs", () => {
    const store = storeHealth({ phase: "done", message: "", finishedAt: 1, queued: 0, lastBar: dayKey("2026-11-13") }, "2026-11-17");
    const result = assessHealth({ ...base, datasets: [store], jobs: [{ id: "tradex-evidence", label: "Plan evidence", owner: "tradex", state: "failed", progress: null, message: "boom", updatedAt: 1 }] });
    expect(result.issues).toEqual([
      { severity: "problem", area: "data", text: expect.stringMatching(/^Screener daily bars \(Tradex's copy\): Tradex holds bars through 13 Nov 2026/) },
      { severity: "warning", area: "jobs", text: "Plan evidence failed: boom." },
    ]);
  });
});
