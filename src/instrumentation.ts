import type { Instrumentation } from "next";

// Next.js instrumentation: one structured log line when the server starts, and
// errors Next catches itself (page renders, routes not wrapped by `authed()`)
// written to the same JSON log as everything else (src/server/log.ts), so they
// show on the /health page too. The Node-only code is in ./instrumentationNode.ts,
// loaded only in the Node.js runtime (this file is also compiled for the edge).

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("./instrumentationNode")).registerNode();
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("./instrumentationNode")).logRequestError(error, request, context);
};
