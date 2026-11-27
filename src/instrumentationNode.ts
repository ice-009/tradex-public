import type { Instrumentation } from "next";
import { log } from "@/server/log";

// Node.js half of ./instrumentation.ts.

export function registerNode() {
  log.info("Tradex server started", { node: process.version, logLevel: log.level, hub: Boolean(process.env.HUB_URL?.trim() && process.env.HUB_KEY?.trim()) });
  // The sealed daily plan (#33): a timer in this process, so a day is sealed whether or not anyone has the terminal open.
  // Not during `next build` (it loads the server to collect pages), and loaded only once the server has started.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    void import("@/server/services/planLedger").then((ledger) => ledger.startPlanLedgerJob()).catch((error) => log.error("Sealed plan: job failed to start", { error }));
  }
}

export function logRequestError(...[error, request, context]: Parameters<Instrumentation.onRequestError>) {
  const header = request.headers["x-request-id"];
  log.error("Unhandled request error", {
    ...(typeof header === "string" ? { requestId: header } : {}),
    method: request.method,
    path: request.path.split("?")[0],
    route: context.routePath,
    routeType: context.routeType,
    digest: (error as { digest?: string }).digest,
    error,
  });
}
