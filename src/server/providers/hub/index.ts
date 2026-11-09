import "server-only";

import { createHash } from "node:crypto";
import { HubClient, type HubStatus } from "./client";
import { hubConfig } from "./config";
import { HubStream } from "./stream";

export { hubConfig, hubMode } from "./config";
export { HubClient, HubError } from "./client";
export type { HubCandle, HubCandles, HubQuote, HubStatus, HubTimeframe } from "./client";

// The app's one hub client, one price stream and a cached view of the hub's
// health (from GET /v1/status), built on first use from HUB_URL / HUB_KEY.

const globalForHub = globalThis as unknown as {
  hub?: { signature: string; client: HubClient; stream: HubStream | null };
  hubStatus?: { at: number; status: HubStatus | null; error: string | null; pending: Promise<void> | null };
};

function current() {
  const config = hubConfig();
  if (!config) return null;
  // Rebuilt when the settings change; only a hash of the key is kept outside the client.
  const signature = createHash("sha256").update(`${config.url}|${config.timeoutMs}|${config.key}`).digest("hex");
  if (globalForHub.hub?.signature !== signature) {
    globalForHub.hub?.stream?.close();
    globalForHub.hub = { signature, client: new HubClient(config), stream: null };
  }
  return globalForHub.hub;
}

/** The hub client, or null when no hub is configured. */
export function hubClient(): HubClient | null {
  return current()?.client ?? null;
}

/** The shared price stream (one SSE connection for every live symbol), or null without a hub. */
export function hubStream(): HubStream | null {
  const hub = current();
  if (!hub) return null;
  hub.stream ??= new HubStream({ open: (symbols, lastEventId, signal) => hub.client.openStream(symbols, lastEventId, signal) });
  return hub.stream;
}

const STATUS_FRESH_MS = 30_000;
const status = (globalForHub.hubStatus ??= { at: 0, status: null, error: null, pending: null });

/**
 * The hub's last known status (never throws). Refreshes in the background when
 * older than 30 s; `wait` waits for that refresh.
 */
export async function hubHealth(options: { wait?: boolean } = {}): Promise<{ status: HubStatus | null; error: string | null; at: number }> {
  const client = hubClient();
  if (!client) return { status: null, error: "not configured", at: 0 };
  if (Date.now() - status.at > STATUS_FRESH_MS && !status.pending) {
    status.pending = client
      .status()
      .then((value) => {
        status.status = value;
        status.error = null;
      })
      .catch((error: Error) => {
        status.error = client.scrub(error.message);
      })
      .finally(() => {
        status.at = Date.now();
        status.pending = null;
      });
  }
  if (status.pending && (options.wait || !status.at)) await status.pending;
  return { status: status.status, error: status.error, at: status.at };
}

/** The last status read, without fetching (null before the first answer). */
export function lastHubStatus(): HubStatus | null {
  if (hubClient()) void hubHealth();
  return status.status;
}
