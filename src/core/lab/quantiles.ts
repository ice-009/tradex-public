// Ranking one day's signal values into quantile buckets. Pure.
//
// Stocks are sorted by value, lowest first; the stock at position p (0-based)
// of n goes to bucket ⌊p · q / n⌋, so bucket 0 (Q1) holds the lowest values and
// bucket q − 1 (Q5 of five) the highest. Tied values share one bucket, the one
// of their average position.
//
// A coarse signal — no more distinct values that day than buckets, like a
// screen's match (1 or 0) — is spread by distinct value instead: the lowest
// value goes to Q1, the highest to the top bucket and the rest evenly between.
// So a binary signal is always "the rest" in Q1 and "matched" in Q5, however
// many stocks matched that day, and the Lab's long–short spread is matched
// minus the rest.

/** Bucket (0 … q − 1) per value, in the input's order. */
export function quantileBuckets(values: ArrayLike<number>, q: number): Int8Array {
  const n = values.length;
  const out = new Int8Array(n);
  if (!n) return out;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  // Groups of tied values, lowest first: [start, end] positions in `order`.
  const groups: Array<[number, number]> = [];
  for (let start = 0; start < n; ) {
    let end = start;
    while (end + 1 < n && values[order[end + 1]] === values[order[start]]) end += 1;
    groups.push([start, end]);
    start = end + 1;
  }
  const coarse = groups.length <= q;
  groups.forEach(([start, end], g) => {
    const bucket = coarse
      ? groups.length === 1
        ? Math.floor((q - 1) / 2)
        : Math.round((g * (q - 1)) / (groups.length - 1))
      : Math.min(q - 1, Math.floor((((start + end) / 2) * q) / n));
    for (let k = start; k <= end; k += 1) out[order[k]] = bucket;
  });
  return out;
}
