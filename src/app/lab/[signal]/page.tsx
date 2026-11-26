import type { Metadata } from "next";
import { findSignal } from "@/core/lab/signals";
import { LabCardPage } from "@/terminal/LabCards";

// /lab/<signal id>[?variant=<variant key>]: one signal's report card (#23).
// Signal ids hold ":" (screen:<id>), so links encode them; params arrive
// decoded, but a doubly-encoded link is decoded once more to be safe.

const decode = (value: string) => {
  try {
    return value.includes("%") ? decodeURIComponent(value) : value;
  } catch {
    return value;
  }
};

export async function generateMetadata({ params }: { params: Promise<{ signal: string }> }): Promise<Metadata> {
  const signal = findSignal(decode((await params).signal));
  return { title: `${signal ? signal.name : "Report card"} · Report card · Tradex`, description: signal?.summary };
}

export default async function LabCard({ params, searchParams }: { params: Promise<{ signal: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { signal } = await params;
  const { variant } = await searchParams;
  return <LabCardPage signalId={decode(signal)} variant={typeof variant === "string" && variant ? variant : null} />;
}
