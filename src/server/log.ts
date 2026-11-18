import { AsyncLocalStorage } from "node:async_hooks";

// The server's log: one JSON object per line, no dependencies.
//
//   {"time":"2026-11-18T10:21:03.112Z","level":"warn","msg":"…","requestId":"…", …fields}
//
//  - `LOG_LEVEL` (debug, info, warn, error; default info) sets the threshold.
//  - Inside a request handled by `authed()` (src/server/http.ts) every line
//    carries that request's id, so one request's lines can be grepped together.
//  - Every line is scrubbed: the hub key, the metrics token, the NextAuth
//    secret, hub API keys (mdh_…) and bearer tokens never reach the output.
//  - The newest warnings and errors are kept in memory for the /health page,
//    and counted per level for /api/metrics.
//
// No server-only import: unit-tested with an injected writer.

export type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const LOG_LEVELS = Object.keys(RANK) as LogLevel[];

/** A logged line as the /health page shows it. */
export interface LogEntry {
  time: number;
  level: LogLevel;
  msg: string;
  requestId?: string;
  /** Short summary of the line's other fields (error messages first). */
  detail?: string;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Newest warnings and errors first. */
  recent(): LogEntry[];
  /** Lines written per level since start (filtered-out levels aren't counted). */
  counts(): Record<LogLevel, number>;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Values to remove from every line (read on each write, so a key set later is still scrubbed). */
  secrets?: () => Array<string | undefined>;
  write?: (line: string, level: LogLevel) => void;
  now?: () => number;
  /** How many warnings and errors to keep for recent() (default 50). */
  keep?: number;
}

/** Hub API keys look like `mdh_` + base64url. */
const KEY_PATTERN = /mdh_[A-Za-z0-9_-]{16,}/g;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** `text` with hub keys, bearer tokens and each secret (4+ characters) replaced. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text.replace(KEY_PATTERN, "mdh_[redacted]").replace(BEARER_PATTERN, "$1[redacted]");
  const values = secrets.filter((value): value is string => typeof value === "string" && value.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of values) out = out.split(secret).join("[redacted]");
  return out;
}

export const parseLevel = (value: string | undefined): LogLevel => {
  const level = value?.trim().toLowerCase();
  return level && level in RANK ? (level as LogLevel) : "info";
};

// One context per process: Next may load this module in more than one bundle
// (instrumentation, route handlers), and they must all see the same request id.
const globalForContext = globalThis as unknown as { tradexRequestContext?: AsyncLocalStorage<{ requestId: string }> };
const requestContext = (globalForContext.tradexRequestContext ??= new AsyncLocalStorage<{ requestId: string }>());

/** Run `fn` with every log line inside it (awaited work included) tagged with `requestId`. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/** The id of the request being handled, if any. */
export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;

function errorFields(error: Error): Record<string, unknown> {
  const cause = (error as { cause?: unknown }).cause;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack.split("\n").slice(0, 6).join("\n") } : {}),
    ...(cause instanceof Error ? { cause: cause.message } : {}),
  };
}

function summary(fields: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "stack" || value === undefined) continue;
    const text = value instanceof Error ? value.message : typeof value === "object" && value !== null ? ((value as { message?: unknown }).message as string | undefined) ?? JSON.stringify(value) : String(value);
    parts.push(key === "error" ? text : `${key}=${text}`);
  }
  return parts.length ? parts.join(" · ").slice(0, 400) : undefined;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = options.level ?? "info";
  const secrets = options.secrets ?? (() => []);
  const write = options.write ?? ((line: string, level: LogLevel) => (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`));
  const now = options.now ?? Date.now;
  const keep = options.keep ?? 50;
  const recent: LogEntry[] = [];
  const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };

  const emit = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (RANK[level] < RANK[threshold]) return;
    counts[level] += 1;
    const time = now();
    const requestId = currentRequestId();
    const entry = { time: new Date(time).toISOString(), level, msg, ...(requestId && !("requestId" in fields) ? { requestId } : {}), ...fields };
    const scrubbed = redact(
      JSON.stringify(entry, (_key, value: unknown) => (value instanceof Error ? errorFields(value) : typeof value === "bigint" ? String(value) : value)),
      secrets(),
    );
    try {
      write(scrubbed, level);
    } catch {
      // a closed stdout must not take a request down
    }
    if (RANK[level] >= RANK.warn) {
      const rest = JSON.parse(scrubbed) as Record<string, unknown>;
      const cleanMsg = String(rest.msg);
      const id = rest.requestId;
      for (const key of ["time", "level", "msg", "requestId"]) delete rest[key];
      const detail = summary(rest);
      recent.unshift({ time, level, msg: cleanMsg, ...(typeof id === "string" ? { requestId: id } : {}), ...(detail ? { detail } : {}) });
      if (recent.length > keep) recent.length = keep;
    }
  };

  return {
    level: threshold,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    recent: () => recent.map((entry) => ({ ...entry })),
    counts: () => ({ ...counts }),
  };
}

const serverSecrets = () => [process.env.HUB_KEY, process.env.METRICS_TOKEN, process.env.NEXTAUTH_SECRET];

// One logger per server process (kept across hot reloads, so recent errors survive an edit).
const globalForLog = globalThis as unknown as { tradexLog?: Logger };
export const log: Logger = (globalForLog.tradexLog ??= createLogger({ level: parseLevel(process.env.LOG_LEVEL), secrets: serverSecrets }));

/** `message` as a warning, for code that takes a `(message: string) => void` logger. */
export const warnLine = (message: string) => log.warn(message);
