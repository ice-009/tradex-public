import { describe, expect, it } from "vitest";
import { SseParser } from "./sse";

describe("SseParser", () => {
  it("parses the hub's frames: retry, named events, ids and heartbeats", () => {
    const parser = new SseParser();
    const events = parser.feed(
      [
        "retry: 3000",
        "event: status",
        'data: {"mode":"socket"}',
        "",
        ": ping 1794200416000",
        "",
        "id: 1794200401000",
        "event: tick",
        'data: {"symbol":"SBIN","ltp":1008.1}',
        "",
        "",
      ].join("\n"),
    );
    expect(parser.retryMs).toBe(3000);
    expect(events).toEqual([
      { event: "status", data: '{"mode":"socket"}', id: undefined },
      { event: "tick", data: '{"symbol":"SBIN","ltp":1008.1}', id: "1794200401000" },
    ]);
    expect(parser.lastEventId).toBe("1794200401000");
  });

  it("joins events split across chunks, including a CRLF split in the middle", () => {
    const parser = new SseParser();
    expect(parser.feed("event: ti")).toEqual([]);
    expect(parser.feed('ck\r\ndata: {"a"')).toEqual([]);
    expect(parser.feed(":1}\r")).toEqual([]);
    expect(parser.feed("\n\r")).toEqual([]);
    expect(parser.feed("\n")).toEqual([{ event: "tick", data: '{"a":1}', id: undefined }]);
  });

  it("handles multi-line data, a missing event name, bare CR endings and fields without a space", () => {
    const parser = new SseParser();
    expect(parser.feed("data:one\rdata: two\r\r")).toEqual([]); // the last \r may still become \r\n
    expect(parser.feed(": next\n")).toEqual([{ event: "message", data: "one\ntwo", id: undefined }]);
    expect(parser.feed("event: empty\n\n")).toEqual([]); // no data: nothing to dispatch
  });
});
