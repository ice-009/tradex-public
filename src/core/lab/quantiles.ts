// Ranking one day's signal values into quantile buckets. Pure.
//
// Stocks are sorted by value, lowest first; the stock at position p (0-based)
// of n goes to bucket ⌊p · q / n⌋, so bucket 0 (Q1) holds the lowest values and
// bucket q − 1 (Q5 of five) the highest. Tied values share one bucket, the one
// of their average position: a binary signal (a screen's match, 1 or 0) then
// splits into "matched" (the top bucket its average position falls in) and
// "the rest" (a middle bucket), and the Lab's long–short spread becomes
// "matched minus the rest" — the top occupied bucket minus the bottom one.

/** Bucket (0 … q − 1) per value, in the input's order. */
export function quantileBuckets(values: ArrayLike<number>, q: number): Int8Array {
  const n = values.length;
  const out = new Int8Array(n);
  if (!n) return out;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  for (let start = 0; start < n; ) {
    let end = start;
    while (end + 1 < n && values[order[end + 1]] === values[order[start]]) end += 1;
    const bucket = Math.min(q - 1, Math.floor((((start + end) / 2) * q) / n));
    for (let k = start; k <= end; k += 1) out[order[k]] = bucket;
    start = end + 1;
  }
  return out;
}
