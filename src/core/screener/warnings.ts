import type { Features } from "@/core/screener/features";

/** Cautions shown on a setup: the "bad news" drift some Indian studies find after heavy gap-downs. */
export function warningsFor(f: Features): string[] {
  const warnings: string[] = [];
  if (f.eventGapPct <= -4) warnings.push(`Gapped down ${f.eventGapPct.toFixed(1)}% on heavy volume ${f.eventAgo} sessions ago — post-bad-news drift risk.`);
  if (f.gapPct <= -4 && f.volRatio50 >= 3) warnings.push(`Gapped down ${f.gapPct.toFixed(1)}% today on ${f.volRatio50.toFixed(1)}× volume.`);
  return warnings;
}
