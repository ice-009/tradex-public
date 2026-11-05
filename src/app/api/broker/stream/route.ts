import { NextRequest } from "next/server";
import type { StreamStatus, Tick } from "@/contracts/api";
import { marketStream } from "@/server/data";
import { sessionEmail } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-Sent Events feed of live prices for the requested symbols, from the
// market stream (src/server/data/stream.ts): a broker socket where there is
// one, polled quotes otherwise — the same "tick" events either way.
// The browser opens `new EventSource("/api/broker/stream?symbols=RELIANCE,TCS")`
// (symbols in priority order) and gets a "status" event, then "tick" events.
export async function GET(request: NextRequest) {
  if (!(await sessionEmail())) return new Response("Unauthorized", { status: 401 });

  const symbols = [
    ...new Set(
      String(request.nextUrl.searchParams.get("symbols") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 500);
  if (!symbols.length) return new Response("At least one symbol is required.", { status: 400 });

  const wanted = new Set(symbols);
  const encoder = new TextEncoder();
  const stream = marketStream();

  const body = new ReadableStream({
    async start(controller) {
      let closed = false;
      let subscribed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const stopTicks = stream.onTick((tick: Tick) => {
        if (wanted.has(tick.symbol)) send("tick", tick);
      });
      // Every 15 s: the current status (live / polling / offline can change as the
      // watchdog restarts the socket). It doubles as a heartbeat: the browser
      // reconnects if it stops hearing these, and proxies don't idle the stream out.
      const heartbeat = setInterval(() => {
        if (!closed && subscribed) send("status", stream.status(symbols));
      }, 15000);

      const cleanup = () => {
        if (closed && !subscribed) return;
        closed = true;
        clearInterval(heartbeat);
        stopTicks();
        if (subscribed) stream.unsubscribe(symbols);
        subscribed = false;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", cleanup);

      const status: StreamStatus = await stream.subscribe(symbols);
      subscribed = true;
      if (closed) {
        cleanup(); // the browser left while we were subscribing
        return;
      }
      send("status", status);
      for (const tick of stream.getLatest(symbols)) send("tick", tick);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
