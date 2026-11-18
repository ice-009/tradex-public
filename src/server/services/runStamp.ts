import "server-only";

import { STAMP_SCHEMA, type CodeVersion, type HubVersion, type RunKind, type RunStamp } from "@/core/repro/stamp";
import { lastHubStatus } from "@/server/providers/hub";

// What the server adds to a run stamp (src/core/repro/stamp.ts): the commit it
// was built from and the Market Data Hub's own dataset dates. TRADEX_COMMIT is
// set at build time by next.config.ts (git HEAD, "-dirty" with uncommitted
// changes), or from the environment for builds without git (Docker).

export function codeVersion(engine: string): CodeVersion {
  return { commit: process.env.TRADEX_COMMIT || "dev", engine };
}

/** The hub's version and the last session of its bhavcopy datasets, from the cached /v1/status (null before the first answer). */
export function hubVersion(): HubVersion | null {
  const status = lastHubStatus();
  if (!status) return null;
  return {
    version: status.version ?? null,
    cashBhav: status.data?.cashBhav?.lastSession ?? status.data?.cashBhav?.tradeDate ?? null,
    foBhav: status.data?.foBhav?.lastSession ?? status.data?.foBhav?.tradeDate ?? null,
  };
}

const isDay = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const SYMBOL = /^[A-Z0-9&_.-]{1,40}$/i;

/**
 * A stamp sent back by the browser for a replay: checked field by field (it is
 * untrusted input). Returns null when it isn't a stamp of this kind.
 */
export function parseStamp(body: unknown, kind: RunKind): RunStamp | null {
  const raw = (body as { stamp?: unknown } | null)?.stamp as Partial<RunStamp> | undefined;
  if (!raw || raw.schema !== STAMP_SCHEMA || raw.kind !== kind) return null;
  const data = raw.data;
  if (!data || !isDay(data.to) || !Array.isArray(data.symbols) || data.symbols.length > 2_000) return null;
  if (!raw.params || typeof raw.params !== "object" || Array.isArray(raw.params)) return null;
  const symbols = data.symbols.filter((symbol): symbol is string => typeof symbol === "string" && SYMBOL.test(symbol));
  const window = data.membership && isDay(data.membership.from) && isDay(data.membership.to) ? { from: data.membership.from, to: data.membership.to } : null;
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : "");
  return {
    schema: STAMP_SCHEMA,
    kind,
    code: { commit: text(raw.code?.commit), engine: text(raw.code?.engine) },
    data: {
      hash: text(data.hash),
      parts: Object.fromEntries(Object.entries(data.parts ?? {}).map(([key, value]) => [text(key), text(value)])),
      symbols,
      benchmark: text(data.benchmark),
      from: isDay(data.from) ? data.from : null,
      to: data.to,
      sessions: isDay(data.sessions) ? data.sessions : 0,
      bars: isDay(data.bars) ? data.bars : 0,
      membership: window,
      hub: null,
    },
    params: raw.params as Record<string, unknown>,
    hash: text(raw.hash),
    resultHash: text(raw.resultHash),
    createdAt: isDay(raw.createdAt) ? raw.createdAt : 0,
  };
}

/** Where a replay pins its inputs: the stamped run's last session, symbols and F&O-list window. */
export interface ReplayPin {
  to: number;
  symbols: string[];
  membership: { from: number; to: number } | null;
}

export const pinOf = (stamp: RunStamp): ReplayPin => ({ to: stamp.data.to!, symbols: stamp.data.symbols, membership: stamp.data.membership });
