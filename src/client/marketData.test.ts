import { describe, expect, it } from "vitest";
import { streamChange } from "./marketData";

describe("streamChange", () => {
  it("keeps the connection when only the priority order changed", () => {
    expect(streamChange(["SBIN", "INFY", "TCS"], ["TCS", "SBIN", "INFY"])).toBe("keep");
  });

  it("reconnects for a symbol the connection doesn't carry", () => {
    expect(streamChange(["SBIN", "INFY"], ["SBIN", "INFY", "PAYTM"])).toBe("reconnect");
  });

  it("trims symbols nobody wants later instead of reconnecting now", () => {
    expect(streamChange(["SBIN", "INFY", "TCS"], ["SBIN"])).toBe("prune");
    // …so a row scrolled away and back costs no reconnect at all
    expect(streamChange(["SBIN", "INFY", "TCS"], ["SBIN", "TCS"])).toBe("prune");
  });

  it("closes the connection when nothing is wanted", () => {
    expect(streamChange(["SBIN"], [])).toBe("reconnect");
    expect(streamChange([], [])).toBe("keep");
  });

  it("past the limit, reconnects when a top-priority symbol is outside the live slots", () => {
    expect(streamChange(["A", "B", "C"], ["A", "B", "C"], 2)).toBe("keep");
    expect(streamChange(["A", "B", "C"], ["B", "A", "C"], 2)).toBe("keep");
    expect(streamChange(["A", "B", "C"], ["C", "A", "B"], 2)).toBe("reconnect");
    // a lingering extra symbol pushing a wanted one out of the live slots
    expect(streamChange(["X", "A", "B"], ["A", "B"], 2)).toBe("reconnect");
  });
});
