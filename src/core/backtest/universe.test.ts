import { describe, expect, it } from "vitest";
import { pointInTimeUniverse, universeNote } from "./universe";

const D1 = Date.UTC(2026, 3, 29);
const D2 = Date.UTC(2026, 3, 30);
const D3 = Date.UTC(2026, 4, 4);

describe("point-in-time F&O universe", () => {
  const byDay = new Map([
    [D1, new Set(["AAA", "OLD"])],
    [D2, new Set(["AAA", "NEW"])],
  ]);
  const universe = pointInTimeUniverse({ byDay, today: ["AAA", "NEW", "LATER"] });

  it("uses the day's list where it has one and today's list elsewhere", () => {
    expect(universe.symbols).toEqual(["AAA", "LATER", "NEW", "OLD"]);
    expect(universe.isMember("OLD", D1)).toBe(true);
    expect(universe.isMember("NEW", D1)).toBe(false);
    expect(universe.isMember("OLD", D2)).toBe(false);
    expect(universe.isMember("LATER", D2)).toBe(false);
    // D3 isn't covered: today's list.
    expect(universe.isMember("LATER", D3)).toBe(true);
    expect(universe.isMember("OLD", D3)).toBe(false);
  });

  it("says which list decided how many sessions", () => {
    expect(universeNote({ sessions: [D1, D2, D3], byDay, noHistory: ["OLD"] })).toBe(
      "Universe: F&O stocks as listed on each day (NSE F&O bhavcopy) on 2 of 3 sessions (29 Apr 2026 – 30 Apr 2026); today's list on the other 1. 1 former member has no stored price history and is left out (OLD).",
    );
    expect(universeNote({ sessions: [D1, D2], byDay, noHistory: [] })).toBe("Universe: F&O stocks as listed on each day (NSE F&O bhavcopy), 29 Apr 2026 – 30 Apr 2026.");
    expect(universeNote({ sessions: [D3], byDay, noHistory: [] })).toMatch(/^Universe: today's F&O list for every session/);
  });
});
