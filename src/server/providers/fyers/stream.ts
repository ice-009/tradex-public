import os from "os";
import path from "path";
import type { FyersDataSocketInstance } from "fyers-api-v3";
import { getFyersAccessToken } from "@/server/providers/fyers/auth";
import { toFyersSymbol } from "@/server/providers/fyers/client";
import { fyersPlan } from "@/server/providers/fyers/budget";

// Server-side singleton over the official Fyers v3 HSM data socket
// (wss://socket.fyers.in/hsm/v1-5/prod). ONE upstream connection powers the
// whole deployment (market data is account-agnostic, matching fyersAuth's
// single-account model). Browsers consume normalized ticks over SSE
// (see /api/broker/stream) instead of talking to Fyers directly — the old
// per-client v2 websocket URL was dead.
//
// Nothing happens on import: the manager is built on first use and the SDK is
// loaded when the socket first starts, so a Tradex connected to a Market Data
// Hub never loads or runs any of it.

export interface LiveTick {
  symbol: string; // app symbol, e.g. "RELIANCE" / "NIFTY"
  fyersSymbol: string; // e.g. "NSE:RELIANCE-EQ"
  ltp: number;
  ch: number;
  chp: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  bid: number;
  ask: number;
  ltt: number; // last traded time (epoch ms)
  ts: number; // exch feed time (epoch ms), fallback Date.now()
}

type TickListener = (tick: LiveTick) => void;

interface RawTick {
  symbol?: string;
  ltp?: number;
  ch?: number;
  chp?: number;
  vol_traded_today?: number;
  open_price?: number;
  high_price?: number;
  low_price?: number;
  prev_close_price?: number;
  bid_price?: number;
  ask_price?: number;
  last_traded_time?: number;
  exch_feed_time?: number;
}

class FyersStreamManager {
  private socket: FyersDataSocketInstance | null = null;
  private connected = false;
  private starting: Promise<boolean> | null = null;
  private reconnecting = false;
  /** Token the current socket was opened with (Fyers tokens change every morning). */
  private socketToken: string | null = null;
  private connectedAt = 0;
  private lastMessageAt = 0;
  private readonly refCounts = new Map<string, number>(); // fyersSymbol -> consumers
  private readonly appSymbolByFyers = new Map<string, string>();
  private readonly latest = new Map<string, LiveTick>(); // keyed by app symbol
  private readonly listeners = new Set<TickListener>();

  isConnected() {
    return this.connected;
  }

  addListener(fn: TickListener) {
    this.listeners.add(fn);
  }

  removeListener(fn: TickListener) {
    this.listeners.delete(fn);
  }

  getLatest(appSymbols: string[]): LiveTick[] {
    return appSymbols
      .map((s) => this.latest.get(s.trim().toUpperCase()))
      .filter((t): t is LiveTick => Boolean(t));
  }

  /** When the last tick arrived (0 = never). */
  lastTickAt() {
    return this.lastMessageAt;
  }

  /** When the current socket connected (0 = not connected). */
  connectedSince() {
    return this.connected ? this.connectedAt : 0;
  }

  /**
   * Ensure the upstream socket is live. Returns false when Fyers isn't configured.
   * A socket opened with an older token (Fyers tokens expire every morning) is
   * replaced with a fresh one.
   */
  async ensureStarted(): Promise<boolean> {
    if (this.starting) return this.starting;
    const token = await getFyersAccessToken();
    if (!token) return false;
    if (this.connected && this.socket && token === this.socketToken) return true;
    if (this.socket && token !== this.socketToken) this.dropSocket();
    if (this.starting) return this.starting; // another caller started while we fetched the token

    this.starting = (async () => {
      // A CommonJS package: its exports may arrive as named exports or under `default`.
      let sdk: typeof import("fyers-api-v3") & { default?: typeof import("fyers-api-v3") };
      try {
        sdk = await import("fyers-api-v3");
      } catch (error) {
        console.warn("Fyers stream: couldn't load the Fyers SDK:", (error as Error).message);
        this.starting = null;
        return false;
      }
      const fyersDataSocket = sdk.fyersDataSocket ?? sdk.default!.fyersDataSocket;
      const clientId = process.env.FYERS_CLIENT_ID || "";
      const logPath = path.join(os.tmpdir(), "tradex-fyers-sdk");

      // The SDK hands back one cached socket for the whole process, whatever token
      // it's given, so a reconnect after a token change would silently reuse the
      // old, expired socket. Clear its cache to get a real new connection.
      (fyersDataSocket as unknown as { instance?: unknown }).instance = undefined;
      const socket = fyersDataSocket.getInstance(`${clientId}:${token}`, logPath, false);
      this.socket = socket;
      this.socketToken = token;
      const current = () => this.socket === socket; // events from a replaced socket are ignored

      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (ok: boolean) => {
          if (settled) return;
          settled = true;
          this.starting = null;
          resolve(ok);
        };

        socket.on("connect", () => {
          if (!current()) return;
          this.connected = true;
          this.connectedAt = Date.now();
          // (Re)subscribe every symbol with active consumers, then request full ticks.
          const active = [...this.refCounts.keys()].filter((s) => (this.refCounts.get(s) ?? 0) > 0);
          if (active.length) {
            socket.subscribe(active);
            socket.mode(socket.FullMode);
          }
          settle(true);
        });

        socket.on("message", (payload) => {
          if (current()) this.handleMessage(payload);
        });

        socket.on("error", (err) => {
          if (!current()) return;
          const text = typeof err === "string" ? err : JSON.stringify(err).slice(0, 200);
          console.warn("Fyers stream error:", text);
          // Auth failures (e.g. -15 "Please provide valid token") happen when the
          // token rotates out from under a long-lived socket: reconnect with a new one.
          if (/valid token|-15|invalid|unauthor/i.test(text)) void this.restart("auth error");
          settle(this.connected);
        });

        socket.on("close", () => {
          if (current()) this.connected = false;
        });

        socket.connect();
        socket.autoreconnect(6);

        // Don't hang a request forever if the socket never opens.
        setTimeout(() => settle(this.connected), 8000);
      });
    })();

    return this.starting;
  }

  /**
   * Throw the socket away and open a new one (fresh token, all subscriptions
   * replayed on connect). Used after auth errors and by the market stream's
   * watchdog when ticks stop arriving.
   */
  async restart(reason: string): Promise<boolean> {
    if (this.reconnecting) return this.connected;
    this.reconnecting = true;
    try {
      console.warn(`Fyers stream: reconnecting (${reason}).`);
      this.dropSocket();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return await this.ensureStarted();
    } finally {
      this.reconnecting = false;
    }
  }

  private dropSocket() {
    const old = this.socket;
    this.socket = null;
    this.socketToken = null;
    this.connected = false;
    this.starting = null;
    try {
      old?.close();
    } catch {
      // already closed
    }
  }

  /**
   * Add consumers for these symbols, in priority order. Fyers counts symbols across
   * all socket connections (100 on Standard) and refuses the whole connection past
   * that, so symbols beyond the plan's limit are not subscribed. Returns the app
   * symbols that were accepted — pass exactly those to unsubscribe().
   */
  async subscribe(appSymbols: string[]): Promise<string[]> {
    const limit = fyersPlan().limits.socketSymbols;
    const fresh: string[] = [];
    const accepted: string[] = [];
    for (const raw of appSymbols) {
      const appSymbol = raw.trim().toUpperCase();
      if (!appSymbol) continue;
      const fyersSymbol = toFyersSymbol(appSymbol);
      const current = this.refCounts.get(fyersSymbol) ?? 0;
      if (current === 0 && this.refCounts.size >= limit) continue;
      this.appSymbolByFyers.set(fyersSymbol, appSymbol);
      this.refCounts.set(fyersSymbol, current + 1);
      accepted.push(appSymbol);
      if (current === 0) fresh.push(fyersSymbol);
    }

    await this.ensureStarted();
    if (fresh.length && this.connected && this.socket) {
      this.socket.subscribe(fresh);
      this.socket.mode(this.socket.FullMode);
    }
    return accepted;
  }

  unsubscribe(appSymbols: string[]): void {
    const drop: string[] = [];
    for (const raw of appSymbols) {
      const fyersSymbol = toFyersSymbol(raw.trim().toUpperCase());
      const next = (this.refCounts.get(fyersSymbol) ?? 0) - 1;
      if (next <= 0) {
        this.refCounts.delete(fyersSymbol);
        drop.push(fyersSymbol);
      } else {
        this.refCounts.set(fyersSymbol, next);
      }
    }
    if (drop.length && this.connected && this.socket) {
      try {
        this.socket.unsubscribe(drop);
      } catch {
        // best-effort; a dropped unsubscribe just wastes a little upstream bandwidth
      }
    }
  }

  private handleMessage(payload: unknown) {
    if (!payload || typeof payload !== "object") return;
    const raw = payload as RawTick;
    if (!raw.symbol || typeof raw.ltp !== "number") return; // skip acks/control frames

    const appSymbol = this.appSymbolByFyers.get(raw.symbol) ?? raw.symbol;
    const tick: LiveTick = {
      symbol: appSymbol,
      fyersSymbol: raw.symbol,
      ltp: raw.ltp,
      ch: raw.ch ?? 0,
      chp: raw.chp ?? 0,
      volume: raw.vol_traded_today ?? 0,
      open: raw.open_price ?? 0,
      high: raw.high_price ?? 0,
      low: raw.low_price ?? 0,
      prevClose: raw.prev_close_price ?? 0,
      bid: raw.bid_price ?? 0,
      ask: raw.ask_price ?? 0,
      ltt: raw.last_traded_time ? raw.last_traded_time * 1000 : Date.now(),
      ts: raw.exch_feed_time ? raw.exch_feed_time * 1000 : Date.now(),
    };

    this.latest.set(appSymbol, tick);
    this.lastMessageAt = Date.now();
    for (const fn of this.listeners) {
      try {
        fn(tick);
      } catch {
        // a broken listener must not kill the fan-out
      }
    }
  }
}

// HMR-safe singleton (mirrors src/lib/prisma.ts's globalThis caching), built on first use.
const globalForStream = globalThis as unknown as { fyersStream?: FyersStreamManager };

export function fyersStream(): FyersStreamManager {
  // A hot reload that changed this class replaces an instance missing newer methods.
  if (typeof (globalForStream.fyersStream as Partial<FyersStreamManager> | undefined)?.restart !== "function") globalForStream.fyersStream = new FyersStreamManager();
  return globalForStream.fyersStream!;
}
