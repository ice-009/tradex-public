// An incremental Server-Sent Events parser (the "event stream" format from the
// HTML spec): feed it text chunks as they arrive, get complete events back.
// Handles \n, \r\n and \r line endings (also split across chunks), comments
// (": ping"), multi-line data, `id:` (kept as lastEventId for resuming) and
// `retry:`. Pure.

export interface SseEvent {
  /** "message" when the frame had no `event:` line. */
  event: string;
  data: string;
  /** The last event id seen so far (the stream's resume point). */
  id: string | undefined;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  /** Last `id:` received; send it back as Last-Event-ID when reconnecting. */
  lastEventId: string | undefined;
  /** Reconnection delay the server asked for (`retry:`), ms. */
  retryMs: number | null = null;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone \r at the very end may be the first half of \r\n: wait for more.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.lastEventId = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
    return null;
  }

  private dispatch(): SseEvent | null {
    const event = this.event || "message";
    const data = this.data.join("\n");
    const had = this.data.length > 0;
    this.data = [];
    this.event = "";
    return had ? { event, data, id: this.lastEventId } : null;
  }
}
