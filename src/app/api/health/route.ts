import { NextResponse } from "next/server";
import { hubMode } from "@/server/providers/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness for the container healthcheck and `docker compose up --wait`. No
 * sign-in and no I/O: the server is up, and whether a Market Data Hub is
 * configured (not whether it's reachable; /api/data/hub reports that).
 */
export const GET = () => NextResponse.json({ ok: true, hub: hubMode() });
