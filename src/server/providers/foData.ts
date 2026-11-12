import "server-only";

import { expiryDayKey } from "@/core/market/futures";
import { oiFact, type FoDayRecord, type FoLeg, type OiFact } from "@/core/market/openInterest";
import { DAY_MS, istParts } from "@/core/market/session";
import { hubClient, type HubOiRow } from "@/server/providers/hub";

// Stock-futures data from NSE's daily F&O bhavcopy, as the Market Data Hub
// keeps it:
//
//   OI facts for the screener   GET /v1/fo/oi/day           newest stored day, every F&O stock
//   point-in-time F&O list      GET /v1/fo/members?from&to  per trade day, for backtests
//
// Both change once a day (in the evening), so they're cached in memory and
// re-read every 30 minutes / 6 hours. When the hub can't answer, the last
// answer is kept, or the feature does without (no OI tag; today's F&O list).

const OI_TTL_MS = 30 * 60 * 1000;
const MEMBERS_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
/** OI facts older than this (a week of holidays at most) aren't shown. */
const MAX_OI_AGE_MS = 7 * DAY_MS;

/** A hub OI row as the engine's record (expiries as day keys). */
export function toFoRecord(row: HubOiRow): FoDayRecord | null {
  const leg = (raw: HubOiRow["near"] | null | undefined): FoLeg | null => {
    const expiry = raw ? expiryDayKey(raw.expiry) : null;
    return raw && expiry !== null ? { expiry, close: raw.close, settle: raw.settle, prevClose: raw.prevClose, volume: raw.volume, oi: raw.oi, chgOi: raw.chgOi } : null;
  };
  const near = leg(row.near);
  const day = Number.isFinite(row.day) ? row.day : Date.parse(`${row.date}T00:00:00Z`);
  if (!near || !Number.isFinite(day)) return null;
  return {
    day,
    symbol: row.symbol,
    nseSymbol: row.nseSymbol ?? row.symbol,
    expiries: row.expiries ?? 1,
    lot: row.lot ?? null,
    underlying: row.underlying ?? null,
    near,
    next: leg(row.next),
    oi: row.oi,
    chgOi: row.chgOi,
  };
}

const globalForFo = globalThis as unknown as {
  hubOi?: { at: number; ok: boolean; value: { day: number; bySymbol: Map<string, OiFact> } | null; pending: Promise<void> | null };
  hubMembers?: Map<string, { at: number; value: Map<number, Set<string>>; pending: Promise<void> | null }>;
};
const oiState = (globalForFo.hubOi ??= { at: 0, ok: false, value: null, pending: null });
const membersState: Map<string, { at: number; value: Map<number, Set<string>>; pending: Promise<void> | null }> = (globalForFo.hubMembers ??= new Map());

/**
 * OI facts for every F&O stock on the newest trade day the hub has (for the
 * screener's tag). Null until the hub has answered, or when its newest day is
 * more than a week old. Never waits: the first call starts the request.
 */
export function latestOiFacts(now = Date.now()): { day: number; bySymbol: Map<string, OiFact> } | null {
  const hub = hubClient();
  if (hub && now - oiState.at > (oiState.ok ? OI_TTL_MS : RETRY_MS) && !oiState.pending) {
    oiState.pending = hub
      .foOiDay()
      .then((answer) => {
        const records = (answer.rows ?? []).flatMap((row) => toFoRecord(row) ?? []);
        oiState.value = records.length ? { day: records[0].day, bySymbol: new Map(records.map((record) => [record.symbol, oiFact(record)])) } : null;
        oiState.ok = true;
      })
      .catch((error: Error) => console.warn("F&O open interest from the Market Data Hub:", error.message))
      .finally(() => {
        oiState.at = Date.now();
        oiState.pending = null;
      });
  }
  const value = oiState.value;
  return value && istParts(now).day - value.day <= MAX_OI_AGE_MS ? value : null;
}

/** Wait for an OI request started by latestOiFacts (tests). */
export const oiSettled = () => oiState.pending ?? Promise.resolve();

/**
 * Stock-futures underlyings per trade day (day key) between `from` and `to`
 * (point-in-time F&O membership). Days the hub has no F&O file for are absent.
 * Cached per range; an empty map when the hub can't answer (today's list is then used).
 */
export async function foMembership(from: number, to: number): Promise<Map<number, Set<string>>> {
  const hub = hubClient();
  if (!hub || to < from) return new Map();
  const key = `${from}:${to}`;
  let entry = membersState.get(key);
  if (!entry) {
    entry = { at: 0, value: new Map(), pending: null };
    membersState.set(key, entry);
    // Ranges move forward a day at a time: drop the ones that aren't asked for any more.
    for (const old of [...membersState.keys()].filter((other) => other !== key).slice(0, -3)) membersState.delete(old);
  }
  const current = entry;
  if (Date.now() - current.at > (current.value.size ? MEMBERS_TTL_MS : RETRY_MS) && !current.pending) {
    current.pending = hub
      .foMembers(from, to)
      .then((answer) => {
        const byDay = new Map<number, Set<string>>();
        for (const day of answer.days ?? []) {
          const t = Number.isFinite(day.day) ? day.day : Date.parse(`${day.date}T00:00:00Z`);
          if (Number.isFinite(t) && day.symbols?.length) byDay.set(t, new Set(day.symbols.map((symbol) => symbol.toUpperCase())));
        }
        current.value = byDay;
      })
      .catch((error: Error) => console.warn("F&O membership from the Market Data Hub:", error.message))
      .finally(() => {
        current.at = Date.now();
        current.pending = null;
      });
  }
  if (current.pending && !current.value.size) await current.pending;
  return current.value;
}
