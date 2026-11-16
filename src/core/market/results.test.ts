import { describe, expect, it } from "vitest";
import { dedupeEvents } from "./results";

describe("results calendar", () => {
  it("keeps one event per symbol and date", () => {
    const day = Date.UTC(2026, 10, 4);
    const events = dedupeEvents([
      { symbol: "EUROPRATIK", company: "Euro Pratik", purpose: "Financial Results", date: day },
      { symbol: "EUROPRATIK", company: "Euro Pratik", purpose: "Financial Results/Dividend", date: day },
      { symbol: "TIRUPATIFL", company: "Tirupati Forge", purpose: "Financial Results", date: day },
      { symbol: "TIRUPATIFL", company: "Tirupati Forge", purpose: "Financial Results", date: day },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].purpose).toBe("Financial Results · Financial Results/Dividend");
  });
});
