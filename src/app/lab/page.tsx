import type { Metadata } from "next";
import { LabCardsIndex } from "@/terminal/LabCards";

export const metadata: Metadata = {
  title: "Report cards · Tradex",
  description: "Every Signal Lab signal with its latest verdict: works, works in uptrends or downtrends only, no edge — after the multiple-testing correction.",
};

export default function LabCards() {
  return <LabCardsIndex />;
}
