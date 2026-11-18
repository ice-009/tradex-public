import type { Metadata } from "next";
import { HealthPage } from "@/terminal/HealthPage";

export const metadata: Metadata = {
  title: "Health · Tradex",
  description: "Why a number may be old: the Market Data Hub, data freshness, request budget, live sockets, background jobs and recent errors.",
};

export default function Health() {
  return <HealthPage />;
}
