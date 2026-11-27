import { describe, expect, it } from "vitest";
import { DAY_MS } from "@/core/market/session";
import { dueSeals, istTime, nextCloseSeal } from "./sealSchedule";

// When the daily plan is sealed: the close window on trading days only, the
// final seal from the evening until the next open, never twice.

const WED = Date.UTC(2026, 10, 25);
const THU = WED + DAY_MS;
const FRI = WED + 2 * DAY_MS;
const MON = WED + 5 * DAY_MS;
const at = (day: number, hh: number, mm: number) => istTime(day, hh * 60 + mm);
const none = () => false;
/** Thursday 26 Nov is a holiday in this calendar. */
const calendar = new Set([WED - DAY_MS, WED, FRI, MON, MON + DAY_MS]);

describe("seal schedule", () => {
  it("seals the close inside 3:15–3:25 PM IST only", () => {
    expect(dueSeals(at(WED, 15, 14), calendar, none)).toEqual([]);
    expect(dueSeals(at(WED, 15, 15), calendar, none)).toEqual([{ day: WED, kind: "close" }]);
    expect(dueSeals(at(WED, 15, 24), calendar, none)).toEqual([{ day: WED, kind: "close" }]);
    expect(dueSeals(at(WED, 15, 25), calendar, none)).toEqual([]);
  });

  it("skips holidays from the calendar, and weekends without one", () => {
    expect(dueSeals(at(THU, 15, 20), calendar, none).filter((due) => due.kind === "close")).toEqual([]);
    expect(dueSeals(at(THU, 15, 20), null, none).filter((due) => due.kind === "close")).toEqual([{ day: THU, kind: "close" }]);
    const SAT = WED + 3 * DAY_MS;
    expect(dueSeals(at(SAT, 15, 20), null, none).filter((due) => due.kind === "close")).toEqual([]);
  });

  it("seals the final version from 7:30 PM until the next session opens", () => {
    expect(dueSeals(at(WED, 19, 29), calendar, none)).toEqual([]);
    expect(dueSeals(at(WED, 19, 30), calendar, none)).toEqual([{ day: WED, kind: "final" }]);
    // Through the holiday (Thursday) to Friday's open.
    expect(dueSeals(at(THU, 12, 0), calendar, none)).toEqual([{ day: WED, kind: "final" }]);
    expect(dueSeals(at(FRI, 9, 14), calendar, none)).toEqual([{ day: WED, kind: "final" }]);
    expect(dueSeals(at(FRI, 9, 15), calendar, none)).toEqual([]);
    // Friday's final seal stays due over the weekend.
    expect(dueSeals(at(MON, 8, 0), calendar, none)).toEqual([{ day: FRI, kind: "final" }]);
  });

  it("asks for nothing already sealed (the job is idempotent)", () => {
    expect(dueSeals(at(WED, 15, 20), calendar, (day, kind) => day === WED && kind === "close")).toEqual([]);
    expect(dueSeals(at(WED, 21, 0), calendar, (day, kind) => day === WED && kind === "final")).toEqual([]);
  });

  it("says when the next close seal is", () => {
    expect(nextCloseSeal(at(WED, 10, 0), calendar)).toBe(at(WED, 15, 15));
    expect(nextCloseSeal(at(WED, 15, 20), calendar)).toBe(at(FRI, 15, 15));
    expect(nextCloseSeal(at(WED, 15, 20), null)).toBe(at(THU, 15, 15));
  });
});
