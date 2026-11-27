import { describe, expect, it } from "vitest";
import { ARCHIVE_START } from "@/core/backtest/phases";
import { barsThrough, dayLabel, evidenceWindowStart, isoDay, parseAsOfParam, resolveDay, sessionCloseMs, sessionOnOrBefore, weekdayOnOrBefore } from "./timeMachine";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const TODAY = day("2026-11-27");

describe("the Time Machine's day", () => {
  it("parses YYYY-MM-DD and refuses anything else, or a day before NSE's first session", () => {
    expect(parseAsOfParam("2020-03-23")).toEqual({ ok: true, day: day("2020-03-23") });
    expect(parseAsOfParam(" 2020-03-23 ")).toEqual({ ok: true, day: day("2020-03-23") });
    expect(parseAsOfParam("23/03/2020")).toMatchObject({ ok: false, error: expect.stringMatching(/YYYY-MM-DD/) });
    expect(parseAsOfParam("2020-02-30")).toMatchObject({ ok: false, error: expect.stringMatching(/isn't a calendar date/) });
    expect(parseAsOfParam("1990-01-01")).toMatchObject({ ok: false, error: expect.stringMatching(/3 Nov 1994/) });
    expect(parseAsOfParam(isoDay(ARCHIVE_START))).toEqual({ ok: true, day: ARCHIVE_START });
    expect(dayLabel(day("2020-03-23"))).toBe("23 Mar 2020");
  });

  it("snaps a weekend or an exchange holiday to the last session before it, from the hub's calendar", () => {
    // March 2020: 10 Mar was Holi (no session).
    const sessions = ["2020-03-05", "2020-03-06", "2020-03-09", "2020-03-11", "2020-03-12", "2020-03-13", "2020-03-16", "2020-03-20", "2020-03-23"].map(day);
    expect(resolveDay(day("2020-03-23"), TODAY, sessions)).toEqual({ mode: "past", day: day("2020-03-23"), requested: day("2020-03-23"), snapped: false, calendar: true, note: null });
    expect(resolveDay(day("2020-03-22"), TODAY, sessions)).toMatchObject({ day: day("2020-03-20"), snapped: true, note: "22 Mar 2020 was a Sunday: showing 20 Mar 2020, the last session before it." });
    expect(resolveDay(day("2020-03-10"), TODAY, sessions)).toMatchObject({ day: day("2020-03-09"), snapped: true, note: expect.stringMatching(/^10 Mar 2020 was an exchange holiday: showing 9 Mar 2020/) });
    expect(sessionOnOrBefore(day("2020-03-04"), sessions)).toBeNull();
    expect(resolveDay(day("2020-03-04"), TODAY, sessions)).toMatchObject({ mode: "past", note: expect.stringMatching(/No session on or before/) });
  });

  it("without the hub's calendar skips weekends and says holidays weren't checked", () => {
    expect(weekdayOnOrBefore(day("2020-03-22"))).toBe(day("2020-03-20"));
    expect(resolveDay(day("2020-03-10"), TODAY, null)).toMatchObject({ day: day("2020-03-10"), snapped: false, calendar: false, note: expect.stringMatching(/holidays aren't checked/) });
    expect(resolveDay(day("2020-03-21"), TODAY, null)).toMatchObject({ day: day("2020-03-20"), snapped: true });
  });

  it("is the live terminal for today or later", () => {
    expect(resolveDay(TODAY, TODAY, [])).toEqual({ mode: "live" });
    expect(resolveDay(day("2027-01-04"), TODAY, [])).toEqual({ mode: "live" });
  });
});

describe("bars known by a day's close", () => {
  const D = day("2020-03-23");
  it("keeps daily bars up to and including the day", () => {
    const bars = ["2020-03-19", "2020-03-20", "2020-03-23", "2020-03-24"].map((iso) => ({ t: day(iso) }));
    expect(barsThrough(bars, D, (bar) => bar.t).map((bar) => isoDay(bar.t))).toEqual(["2020-03-19", "2020-03-20", "2020-03-23"]);
  });

  it("keeps intraday bars that started before 15:30 IST that day, none of the next", () => {
    const close = sessionCloseMs(D);
    expect(new Date(close).toISOString()).toBe("2020-03-23T10:00:00.000Z"); // 15:30 IST
    const bars = [close - 15 * 60_000, close, close + 18 * 3_600_000].map((t) => ({ t }));
    expect(barsThrough(bars, D, (bar) => bar.t)).toEqual([{ t: close - 15 * 60_000 }]);
  });

  it("puts the plan's evidence window at the five years ending the day, never before 1994", () => {
    expect(evidenceWindowStart(D, 5 * 365 - 3)).toBe(D - (5 * 365 - 3) * 86_400_000);
    expect(evidenceWindowStart(day("1996-01-01"), 5 * 365 - 3)).toBe(ARCHIVE_START);
  });
});
