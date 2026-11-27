import { describe, expect, it } from "vitest";
import { blockReadFrom, blockServing, nextBarLimit, previousBarLimit, replayBlockFor, revealLimit, revealed, stepIntervalMs, stepSession, REPLAY_AHEAD_DAYS, REPLAY_BACK_DAYS } from "./replay";
import { sessionCloseMs } from "./timeMachine";

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("replay blocks", () => {
  const last = day("2026-11-26");
  const broker = day("2021-11-29");

  it("reaches a few weeks back and about three months ahead, never past the newest past session", () => {
    expect(replayBlockFor(day("2024-03-01"), last, broker)).toEqual({ from: day("2024-03-01") - REPLAY_BACK_DAYS * DAY, to: day("2024-03-01") + REPLAY_AHEAD_DAYS * DAY });
    expect(replayBlockFor(day("2026-11-20"), last, broker).to).toBe(last);
  });

  it("never straddles the start of the hub's broker window", () => {
    const before = replayBlockFor(day("2021-10-01"), last, broker);
    expect(before.to).toBe(broker - DAY);
    const after = replayBlockFor(day("2021-12-06"), last, broker);
    expect(after.from).toBe(broker);
    expect(after.to).toBe(day("2021-12-06") + REPLAY_AHEAD_DAYS * DAY);
  });

  it("finds the block serving a day, and gives each day the same read", () => {
    const blocks = [{ from: 10, to: 20 }, { from: 30, to: 40 }];
    expect(blockServing(blocks, 35)).toBe(blocks[1]);
    expect(blockServing(blocks, 25)).toBeNull();
    const block = { from: day("2024-01-01"), to: day("2024-04-01") };
    expect(blockReadFrom(block, day("2024-02-01"), day("2024-02-01") - 14 * DAY)).toBe(blockReadFrom(block, day("2024-03-01"), day("2024-03-01") - 14 * DAY));
  });
});

describe("stepping sessions", () => {
  const sessions = [day("2024-03-21"), day("2024-03-22"), day("2024-03-26"), day("2024-03-27")]; // 25 Mar 2024 was Holi

  it("steps over weekends and holidays from the exchange calendar", () => {
    expect(stepSession(day("2024-03-22"), sessions, 1)).toBe(day("2024-03-26"));
    expect(stepSession(day("2024-03-26"), sessions, -1)).toBe(day("2024-03-22"));
    expect(stepSession(day("2024-03-21"), sessions, 3)).toBe(day("2024-03-27"));
    expect(stepSession(day("2024-03-27"), sessions, 1)).toBeNull();
    expect(stepSession(day("2024-03-21"), sessions, -1)).toBeNull();
  });

  it("steps from a day that isn't a session to the sessions around it", () => {
    expect(stepSession(day("2024-03-25"), sessions, 1)).toBe(day("2024-03-26"));
    expect(stepSession(day("2024-03-25"), sessions, -1)).toBe(day("2024-03-22"));
  });

  it("plays at sessions per second", () => {
    expect(stepIntervalMs(2)).toBe(500);
    expect(stepIntervalMs(0.5)).toBe(2000);
  });
});

describe("revealing bars", () => {
  const d = day("2024-03-22");
  const open = sessionCloseMs(d) + (24 * 60 - 375) * 60_000; // 09:15 IST the next calendar day
  const times = [d - DAY, d, ...Array.from({ length: 4 }, (_, i) => open + i * 5 * 60_000)];

  it("shows the bars up to the day's close, then one more each step", () => {
    const limit = revealLimit(d, null);
    expect(revealed(times, limit, (t) => t)).toEqual([d - DAY, d]);
    const next = nextBarLimit(times, limit)!;
    expect(revealed(times, next, (t) => t)).toEqual([d - DAY, d, open]);
    expect(revealed(times, nextBarLimit(times, next)!, (t) => t)).toHaveLength(4);
    expect(nextBarLimit(times, times.at(-1)! + 1)).toBeNull();
    expect(previousBarLimit(times, next, limit)).toBe(null);
    expect(previousBarLimit(times, nextBarLimit(times, next)!, limit)).toBe(open + 5 * 60_000);
  });
});
