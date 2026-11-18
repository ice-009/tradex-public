import { describe, expect, it } from "vitest";
import { createLogger, currentRequestId, parseLevel, redact, withRequestId, type LogLevel } from "./log";

function capture(level: LogLevel = "debug", secrets: string[] = []) {
  const lines: Array<{ line: string; level: LogLevel }> = [];
  const logger = createLogger({ level, secrets: () => secrets, write: (line, lineLevel) => lines.push({ line, level: lineLevel }), now: () => Date.UTC(2026, 10, 18, 4, 30) });
  return { logger, lines, parsed: () => lines.map(({ line }) => JSON.parse(line) as Record<string, unknown>) };
}

describe("structured log", () => {
  it("writes one JSON object per line with time, level, message and fields", () => {
    const { logger, lines, parsed } = capture();
    logger.info("Track record", { universe: "fno", ms: 120 });
    expect(lines).toHaveLength(1);
    expect(lines[0].line).not.toContain("\n");
    expect(parsed()[0]).toEqual({ time: "2026-11-18T04:30:00.000Z", level: "info", msg: "Track record", universe: "fno", ms: 120 });
  });

  it("drops lines below the level and counts what it writes", () => {
    const { logger, lines } = capture("warn");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines.map(({ level }) => level)).toEqual(["warn", "error"]);
    expect(logger.counts()).toEqual({ debug: 0, info: 0, warn: 1, error: 1 });
  });

  it("serialises errors with their message (and a short stack)", () => {
    const { logger, parsed } = capture();
    logger.error("Strategy evidence failed", { error: new Error("not enough history") });
    const error = parsed()[0].error as Record<string, unknown>;
    expect(error).toMatchObject({ name: "Error", message: "not enough history" });
    expect(String(error.stack).split("\n").length).toBeLessThanOrEqual(6);
  });

  it("tags every line inside a request with its id, awaited work included", async () => {
    const { logger, parsed } = capture();
    await withRequestId("req-12345678", async () => {
      logger.info("before");
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentRequestId()).toBe("req-12345678");
      logger.warn("after");
    });
    logger.info("outside");
    expect(parsed().map((line) => line.requestId)).toEqual(["req-12345678", "req-12345678", undefined]);
  });

  it("scrubs secrets, hub keys and bearer tokens from every line", () => {
    const { logger, lines } = capture("debug", ["super-secret-value"]);
    logger.warn("Market Data Hub 401: Bearer abc.def-123 rejected", { key: "mdh_Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5", note: "token super-secret-value leaked" });
    expect(lines[0].line).not.toMatch(/abc\.def-123|Zm9vYmFy|super-secret-value/);
    expect(lines[0].line).toContain("Bearer [redacted]");
    expect(lines[0].line).toContain("mdh_[redacted]");
  });

  it("keeps the newest warnings and errors for the health page", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", keep: 2, write: (line) => lines.push(line), secrets: () => ["hunter22"] });
    logger.info("fine");
    logger.warn("first", { error: "boom" });
    withRequestId("req-abcdefgh", () => logger.error("second", { symbol: "SBIN", error: new Error("hub down hunter22") }));
    logger.warn("third");
    const recent = logger.recent();
    expect(recent.map((entry) => entry.msg)).toEqual(["third", "second"]);
    expect(recent[1]).toMatchObject({ level: "error", requestId: "req-abcdefgh" });
    expect(recent[1].detail).toContain("symbol=SBIN");
    expect(recent[1].detail).toContain("hub down [redacted]");
  });

  it("never throws when the output is closed", () => {
    const logger = createLogger({
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => logger.error("x")).not.toThrow();
  });
});

describe("redact / parseLevel", () => {
  it("removes the longest secret first and ignores short ones", () => {
    expect(redact("key=abcdef and abc", ["abc", "abcdef"])).toBe("key=[redacted] and abc");
  });
  it("reads LOG_LEVEL, defaulting to info", () => {
    expect(parseLevel("DEBUG")).toBe("debug");
    expect(parseLevel(" warn ")).toBe("warn");
    expect(parseLevel("verbose")).toBe("info");
    expect(parseLevel(undefined)).toBe("info");
  });
});
