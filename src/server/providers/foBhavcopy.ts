import "server-only";

import { aggregateStockFutures, parseFoBhav, type FoDayRecord } from "@/core/parsers/foBhavcopy";
import { ZipError, isZip, unzipSingle } from "@/server/providers/unzip";

// One day's NSE F&O bhavcopy (UDiFF format, the only one NSE has published
// since July 2024) from NSE's free public archive — no broker API calls:
//
//   https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip
//
// Politeness: every request from this module waits for a shared gate, so there
// is at most one request every ~1.1 s however many callers there are (the
// backfill and the evening update). A 403/429/5xx, a timeout or a non-zip body
// is a "hard" failure: it is retried after 5 s and 20 s (60 s after a 429),
// then reported to the caller, which stops after a few in a row.
//
// A 404 means no file: an exchange holiday (or, for today, not published yet).
// NSE's archive has been seen to serve another day's file for a holiday URL,
// so the trade date inside the file must equal the date asked for.

const BASE_URL = "https://nsearchives.nseindia.com/content/fo";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Referer: "https://www.nseindia.com/",
  Accept: "*/*",
};
/** Minimum gap between two requests to NSE from this module. */
export const NSE_MIN_GAP_MS = 1_100;
const TIMEOUT_MS = 30_000;
const RETRY_WAITS_MS = [5_000, 20_000];
const RATE_LIMIT_WAIT_MS = 60_000;

export type FoFetchResult =
  | { kind: "ok"; day: number; records: FoDayRecord[]; badRows: number }
  | { kind: "missing"; day: number }
  | { kind: "mismatch"; day: number; fileDate: number | null; note: string };

/** A failed download that isn't "no file". `status` is the HTTP status when there was one. */
export class FoFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function foBhavFileName(day: number): string {
  const date = new Date(day);
  const ymd = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  return `BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`;
}

export const foBhavUrl = (day: number) => `${BASE_URL}/${foBhavFileName(day)}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Shared across hot reloads, so a reload can't start a second stream of requests.
const gate = ((globalThis as unknown as { foBhavGate?: { next: number; chain: Promise<void> } }).foBhavGate ??= { next: 0, chain: Promise.resolve() });

/** Wait for this module's turn to call NSE (≥ NSE_MIN_GAP_MS since the previous request). */
function politeTurn(): Promise<void> {
  const turn = gate.chain.then(async () => {
    const wait = gate.next - Date.now();
    if (wait > 0) await sleep(wait);
    gate.next = Date.now() + NSE_MIN_GAP_MS;
  });
  gate.chain = turn.catch(() => undefined);
  return turn;
}

/** Turn a downloaded zip into the day's records. Exported for tests and local imports of saved files. */
export function readFoZip(day: number, buffer: Buffer): FoFetchResult {
  if (!isZip(buffer)) throw new FoFetchError("NSE sent something that isn't a zip file", null, true);
  const { data } = unzipSingle(buffer);
  const parsed = parseFoBhav(data.toString("utf8"));
  if (parsed.mixedDates || parsed.tradeDate !== day) {
    const fileDate = parsed.tradeDate;
    const note = parsed.mixedDates ? "file has more than one trade date" : `file is for ${fileDate === null ? "no date" : new Date(fileDate).toISOString().slice(0, 10)}`;
    return { kind: "mismatch", day, fileDate, note };
  }
  if (!parsed.contracts.length) throw new FoFetchError("no stock-futures rows in the file (format change?)", null, false);
  return { kind: "ok", day, records: aggregateStockFutures(parsed.contracts, day), badRows: parsed.badRows };
}

async function fetchOnce(day: number): Promise<FoFetchResult> {
  await politeTurn();
  let response: Response;
  try {
    response = await fetch(foBhavUrl(day), { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const name = (error as Error).name;
    throw new FoFetchError(name === "TimeoutError" ? "NSE timed out" : `NSE unreachable (${(error as Error).message})`, null, true);
  }
  if (response.status === 404) return { kind: "missing", day };
  if (!response.ok) throw new FoFetchError(`NSE answered ${response.status}`, response.status, response.status === 403 || response.status === 429 || response.status >= 500);
  return readFoZip(day, Buffer.from(await response.arrayBuffer()));
}

/** Download and parse one day, retrying hard failures with back-off. Throws FoFetchError when it gives up. */
export async function fetchFoDay(day: number, shouldStop: () => boolean = () => false): Promise<FoFetchResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchOnce(day);
    } catch (error) {
      // A broken zip is usually a cut-off download: worth another try.
      const failure = error instanceof FoFetchError ? error : new FoFetchError((error as Error).message, null, error instanceof ZipError);
      if (!failure.retryable || attempt >= RETRY_WAITS_MS.length || shouldStop()) throw failure;
      await sleep(failure.status === 429 ? RATE_LIMIT_WAIT_MS : RETRY_WAITS_MS[attempt]);
    }
  }
}
