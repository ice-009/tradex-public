import { describe, expect, it } from "vitest";
import { GRACE_MS, emptyFresh, updateFresh } from "./fresh";

const MIN = 60_000;

describe("first-seen tracking", () => {
  it("keeps the first time a setup matched", () => {
    let state = updateFresh(emptyFresh(1), 1, ["s:A"], 0);
    state = updateFresh(state, 1, ["s:A", "s:B"], 5 * MIN);
    expect(state.seen["s:A"].first).toBe(0);
    expect(state.seen["s:B"].first).toBe(5 * MIN);
  });

  it("ignores a short flicker but treats a long absence as new", () => {
    let state = updateFresh(emptyFresh(1), 1, ["s:A"], 0);
    state = updateFresh(state, 1, [], 2 * MIN);
    state = updateFresh(state, 1, ["s:A"], 4 * MIN);
    expect(state.seen["s:A"].first).toBe(0);
    state = updateFresh(state, 1, [], 4 * MIN + GRACE_MS + 1);
    state = updateFresh(state, 1, ["s:A"], 30 * MIN);
    expect(state.seen["s:A"].first).toBe(30 * MIN);
  });

  it("starts over on a new day", () => {
    const state = updateFresh(updateFresh(emptyFresh(1), 1, ["s:A"], 0), 2, ["s:A"], 99);
    expect(state).toEqual({ day: 2, seen: { "s:A": { first: 99, last: 99 } } });
  });
});

import { NEW_WINDOW_MS, isNewSetup } from "./fresh";

describe("isNewSetup", () => {
  const open = 1_000_000;
  it("isn't new when it was there at the first scan", () => {
    expect(isNewSetup(open, open, open + 60_000)).toBe(false);
  });
  it("is new for 30 minutes after appearing later in the day", () => {
    const appeared = open + 2 * 3600_000;
    expect(isNewSetup(appeared, open, appeared + 60_000)).toBe(true);
    expect(isNewSetup(appeared, open, appeared + NEW_WINDOW_MS + 1)).toBe(false);
  });
});
