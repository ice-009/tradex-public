import type { DailyBar } from "@/core/types";
import { canonicalJson, canonicalNumber } from "./canonical";
import { Sha256, sha256 } from "./sha256";

// Run stamps: every backtest and evidence run says exactly what it was computed
// from — the data (a content hash of the bars and reference data it actually
// used), the code (git commit and the engine's own version) and the parameters —
// with a hash of all three, and a hash of its result. Two runs with the same
// stamp hash must give the same result hash; `compareRuns` says what differs
// when they don't.
//
// Hashes are SHA-256 over canonical JSON (canonical.ts): stable key order and
// fixed number formatting, so they are identical on every machine.

export const STAMP_SCHEMA = 1;

export type RunKind = "backtest" | "evidence";

export interface CodeVersion {
  /** Git commit the server was built from; "-dirty" when built with uncommitted changes, "dev" when unknown. */
  commit: string;
  /** The engine's own version, bumped when its rules change (e.g. "backtest/5"). */
  engine: string;
}

/** The Market Data Hub's own view of its data when the run was made (for reading; not part of the hash). */
export interface HubVersion {
  version: string | null;
  /** Last session of the hub's cash and F&O bhavcopy datasets. */
  cashBhav: string | null;
  foBhav: string | null;
}

export interface DataStamp {
  /** Hash of `parts`. */
  hash: string;
  /** Hash of each input: `bars` (every symbol's daily bars, and the benchmark's), `membership` (point-in-time F&O list), `lots`, `universe` (today's list). */
  parts: Record<string, string>;
  /** Symbols whose bars were used (sorted), and the benchmark. */
  symbols: string[];
  benchmark: string;
  /** First and last stored session used (day keys); a replay reads the bars up to `to` only. */
  from: number | null;
  to: number | null;
  sessions: number;
  bars: number;
  /** Window the point-in-time F&O list was read for (null when none was used). */
  membership: { from: number; to: number } | null;
  hub: HubVersion | null;
}

export interface RunStamp {
  schema: typeof STAMP_SCHEMA;
  kind: RunKind;
  code: CodeVersion;
  data: DataStamp;
  /** The run's parameters, as validated by the server. */
  params: Record<string, unknown>;
  /** Hash of kind + code + data hash + params: the run's inputs. */
  hash: string;
  /** Hash of the canonical result. */
  resultHash: string;
  /** When it ran (epoch ms; not hashed). */
  createdAt: number;
}

/** The first 12 hex digits: enough to tell runs apart on screen. */
export const shortHash = (hash: string) => hash.slice(0, 12);

const row = (bar: DailyBar) => canonicalJson([bar.t, bar.o, bar.h, bar.l, bar.c, bar.v, bar.dp ?? null]);

/** Hash of one series of daily bars: canonical rows [t, o, h, l, c, v, dp], streamed. */
export function hashBars(bars: DailyBar[]): string {
  const hash = new Sha256().update("[");
  let chunk = "";
  for (let i = 0; i < bars.length; i += 1) {
    chunk += (i ? "," : "") + row(bars[i]);
    if (chunk.length > 32_768) {
      hash.update(chunk);
      chunk = "";
    }
  }
  return hash.update(`${chunk}]`).hex();
}

export interface DatasetInput {
  /** Daily bars per symbol actually used, the benchmark's included. */
  bars: Map<string, DailyBar[]>;
  benchmark: string;
  /** Point-in-time F&O list by session; days after the last session are ignored. */
  membership?: Map<number, Set<string>> | null;
  membershipWindow?: { from: number; to: number } | null;
  /** Lot sizes; only the dataset's symbols count. */
  lots?: Record<string, number> | null;
  /** Today's universe list. */
  universe?: string[] | null;
  hub?: HubVersion | null;
  /** Cached per-series hashes (series arrays are replaced, never changed in place, by the store). */
  cache?: WeakMap<DailyBar[], string>;
  /** Called between symbols so hashing a large universe doesn't block the server. */
  pause?: () => Promise<void>;
}

/** Content hash of the data a run used, with the span it covers. */
export async function hashDataset(input: DatasetInput): Promise<DataStamp> {
  const names = [...input.bars.keys()].sort();
  const digests: Record<string, string> = {};
  let from = Infinity;
  let to = -Infinity;
  let count = 0;
  const sessions = new Set<number>();
  for (const name of names) {
    const bars = input.bars.get(name)!;
    let digest = input.cache?.get(bars);
    if (!digest) {
      digest = hashBars(bars);
      input.cache?.set(bars, digest);
      if (input.pause) await input.pause();
    }
    digests[name] = digest;
    count += bars.length;
    if (bars.length) {
      from = Math.min(from, bars[0].t);
      to = Math.max(to, bars[bars.length - 1].t);
    }
    if (name !== input.benchmark) for (const bar of bars) sessions.add(bar.t);
  }
  const last = Number.isFinite(to) ? to : null;
  const symbols = names.filter((name) => name !== input.benchmark);
  const parts: Record<string, string> = { bars: sha256(canonicalJson(digests)) };
  if (input.membership) {
    const days = [...input.membership].filter(([day]) => last === null || day <= last);
    parts.membership = sha256(canonicalJson(new Map(days)));
  }
  if (input.lots) parts.lots = sha256(canonicalJson(lotsOf(input.lots, { symbols })));
  if (input.universe) parts.universe = sha256(canonicalJson([...input.universe].sort()));
  return {
    hash: sha256(canonicalJson(parts)),
    parts,
    symbols,
    benchmark: input.benchmark,
    from: Number.isFinite(from) ? from : null,
    to: last,
    sessions: sessions.size,
    bars: count,
    membership: input.membershipWindow ?? null,
    hub: input.hub ?? null,
  };
}

/** Lot sizes of the dataset's symbols only (a revision elsewhere doesn't change the data hash). */
export const lotsOf = (lots: Record<string, number>, data: Pick<DataStamp, "symbols">) =>
  Object.fromEntries(data.symbols.filter((symbol) => lots[symbol] !== undefined).map((symbol) => [symbol, lots[symbol]]));

/** The data stamp with one more input (or one fewer, for null), its hash recomputed. */
export function withDataPart(data: DataStamp, name: string, value: unknown): DataStamp {
  const parts = { ...data.parts };
  if (value === null || value === undefined) delete parts[name];
  else parts[name] = sha256(canonicalJson(value));
  return { ...data, parts, hash: sha256(canonicalJson(parts)) };
}

/** Hash of a run's inputs. */
export const inputsHash = (kind: RunKind, code: CodeVersion, dataHash: string, params: unknown) =>
  sha256(canonicalJson({ schema: STAMP_SCHEMA, kind, code, data: dataHash, params }));

/** Hash of a run's result. */
export const resultHash = (result: unknown) => sha256(canonicalJson(result));

export function makeStamp(input: { kind: RunKind; code: CodeVersion; data: DataStamp; params: Record<string, unknown>; result: unknown; createdAt: number }): RunStamp {
  const params = JSON.parse(canonicalJson(input.params)) as Record<string, unknown>;
  return {
    schema: STAMP_SCHEMA,
    kind: input.kind,
    code: input.code,
    data: input.data,
    params,
    hash: inputsHash(input.kind, input.code, input.data.hash, params),
    resultHash: resultHash(input.result),
    createdAt: input.createdAt,
  };
}

// ------------------------------------------------------------------ comparing two runs

export interface Difference {
  path: string;
  before: string;
  after: string;
}

/**
 * Field-by-field differences between two JSON-like values (numbers compared by
 * their canonical text). Returns the first `limit` and the total count.
 */
export function diffValues(before: unknown, after: unknown, limit = 40): { differences: Difference[]; total: number } {
  const differences: Difference[] = [];
  let total = 0;
  const leaf = (value: unknown) => (typeof value === "number" ? canonicalNumber(value) : canonicalJson(value));
  const isNode = (value: unknown) => value !== null && typeof value === "object";
  const add = (path: string, a: unknown, b: unknown) => {
    total += 1;
    if (differences.length < limit) differences.push({ path: path || "(root)", before: clip(leaf(a)), after: clip(leaf(b)) });
  };
  const walk = (path: string, a: unknown, b: unknown) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) add(`${path}.length`, a.length, b.length);
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) walk(`${path}[${i}]`, a[i], b[i]);
      return;
    }
    if (isNode(a) && isNode(b) && !Array.isArray(a) && !Array.isArray(b)) {
      const left = a as Record<string, unknown>;
      const right = b as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        if (left[key] === undefined && right[key] === undefined) continue;
        walk(path ? `${path}.${key}` : key, left[key], right[key]);
      }
      return;
    }
    if (leaf(a) !== leaf(b)) add(path, a, b);
  };
  walk("", before, after);
  return { differences, total };
}

const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}…` : text);
const dayLabel = (day: number | null) => (day === null ? "none" : new Date(day).toISOString().slice(0, 10));

export interface RunComparison {
  /** Same stamp hash (inputs) and same result hash. */
  identical: boolean;
  sameInputs: boolean;
  sameResult: boolean;
  /** What changed in the inputs, in words (empty when the inputs are the same). */
  changes: string[];
  /** Where the results differ (first few), and how many fields differ in all. */
  differences: Difference[];
  totalDifferences: number;
}

/** Compare a stamped run with its replay. */
export function compareRuns(original: { stamp: RunStamp; result: unknown }, replay: { stamp: RunStamp; result: unknown }, limit = 40): RunComparison {
  const a = original.stamp;
  const b = replay.stamp;
  const changes: string[] = [];
  if (a.code.commit !== b.code.commit) changes.push(`Code: commit ${a.code.commit} → ${b.code.commit}.`);
  if (a.code.engine !== b.code.engine) changes.push(`Engine: ${a.code.engine} → ${b.code.engine}.`);
  if (a.data.hash !== b.data.hash) {
    const parts = [...new Set([...Object.keys(a.data.parts), ...Object.keys(b.data.parts)])].sort().filter((part) => a.data.parts[part] !== b.data.parts[part]);
    const span =
      a.data.from !== b.data.from || a.data.to !== b.data.to ? ` History ${dayLabel(a.data.from)} – ${dayLabel(a.data.to)} → ${dayLabel(b.data.from)} – ${dayLabel(b.data.to)}.` : "";
    const lost = a.data.symbols.filter((symbol) => !b.data.symbols.includes(symbol));
    const gained = b.data.symbols.filter((symbol) => !a.data.symbols.includes(symbol));
    const symbols = [lost.length ? `${lost.length} fewer symbol${lost.length === 1 ? "" : "s"} (${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""})` : "", gained.length ? `${gained.length} more` : ""]
      .filter(Boolean)
      .join(", ");
    changes.push(`Data changed: ${parts.join(", ") || "hash"}.${span}${symbols ? ` ${symbols}.` : ""}`);
  }
  const params = diffValues(a.params, b.params, 5);
  if (params.total) changes.push(`Parameters: ${params.differences.map((d) => `${d.path} ${d.before} → ${d.after}`).join("; ")}${params.total > 5 ? "; …" : ""}.`);
  if (a.kind !== b.kind) changes.push(`Kind: ${a.kind} → ${b.kind}.`);
  const sameInputs = a.hash === b.hash;
  if (!sameInputs && !changes.length) changes.push("Stamp format changed.");
  const sameResult = a.resultHash === b.resultHash;
  const diff = sameResult ? { differences: [], total: 0 } : diffValues(original.result, replay.result, limit);
  return { identical: sameInputs && sameResult, sameInputs, sameResult, changes, differences: diff.differences, totalDifferences: diff.total };
}
