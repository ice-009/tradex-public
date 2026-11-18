import { NextResponse } from "next/server";
import type { HealthReport } from "@/contracts/api";
import { authed } from "@/server/http";
import { healthReport } from "@/server/services/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The /health page: hub connection, data freshness, budget, sockets, background jobs, recent errors, and why a number may be old. */
export const GET = authed("Health", "Unable to read Tradex's health right now.", async () => NextResponse.json<HealthReport>(await healthReport()));
