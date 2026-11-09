// Market Data Hub settings (see .env.example). With HUB_URL and HUB_KEY set,
// Tradex gets all its market data from the hub and never calls Fyers itself.
// Pure: reads only the env object it's given.

export interface HubConfig {
  /** Base URL without a trailing slash, e.g. "https://hub.example.com". */
  url: string;
  key: string;
  /** Per-request timeout (ms). */
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const warned = new Set<string>();
const warnOnce = (message: string) => {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
};

/** The hub settings, or null when the hub isn't configured (Tradex then runs standalone). */
export function hubConfig(env: Record<string, string | undefined> = process.env): HubConfig | null {
  const raw = env.HUB_URL?.trim();
  const key = env.HUB_KEY?.trim();
  if (!raw || !key) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    warnOnce("HUB_URL is not a valid URL; the Market Data Hub is off.");
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    warnOnce("HUB_URL must start with http:// or https://; the Market Data Hub is off.");
    return null;
  }
  // Credentials belong in HUB_KEY, never in a URL that might be logged.
  url.username = "";
  url.password = "";
  const timeout = Number(env.HUB_TIMEOUT_MS);
  return {
    url: url.toString().replace(/\/+$/, ""),
    key,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1_000 ? Math.min(timeout, 300_000) : DEFAULT_TIMEOUT_MS,
  };
}

/** True when market data comes from a Market Data Hub. */
export const hubMode = (env: Record<string, string | undefined> = process.env) => hubConfig(env) !== null;
