import type { Instrumentation } from "next";
import { log } from "@/server/log";

// Node.js half of ./instrumentation.ts.

export function registerNode() {
  log.info("Tradex server started", { node: process.version, logLevel: log.level, hub: Boolean(process.env.HUB_URL?.trim() && process.env.HUB_KEY?.trim()) });
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
