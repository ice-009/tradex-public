import { describe, expect, it } from "vitest";
import { isPlanPreview } from "./preview";

/** 2026-11-20 is a Friday; IST = UTC + 5:30. */
const ist = (hh: number, mm: number, day = "2026-11-20") => Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);

describe("isPlanPreview", () => {
  it("is a preview from the open until the close window on a weekday, live scans only", () => {
    expect(isPlanPreview(true, ist(9, 10))).toBe(false); // before the open
    expect(isPlanPreview(true, ist(12, 2))).toBe(true);
    expect(isPlanPreview(true, ist(15, 9))).toBe(true);
    expect(isPlanPreview(true, ist(15, 10))).toBe(false); // the close window opens
    expect(isPlanPreview(true, ist(19, 0))).toBe(false);
    expect(isPlanPreview(false, ist(12, 2))).toBe(false); // stored close, not a live scan
    expect(isPlanPreview(true, ist(12, 2, "2026-11-21"))).toBe(false); // Saturday
  });
});
