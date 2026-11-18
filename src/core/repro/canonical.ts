// Canonical JSON: one exact text per value, so equal inputs and results hash
// equal on any machine.
//
//  - Object keys sorted (UTF-16 code-unit order); keys whose value is
//    undefined or a function are left out, like JSON.stringify.
//  - Numbers: integers that fit exactly (|n| ≤ 2^53) as plain digits;
//    everything else rounded to 12 significant digits, so a last-bit
//    difference in floating-point maths (a different CPU or Math library)
//    can't change the text. -0 is 0. NaN and ±Infinity become the strings
//    "NaN", "Infinity", "-Infinity" (JSON has no such numbers).
//  - Maps become objects (keys as strings, sorted); Sets become arrays sorted
//    by their canonical text.
//  - undefined inside an array is null, like JSON.stringify.

const SIGNIFICANT = 12;

export function canonicalNumber(n: number): string {
  if (Number.isNaN(n)) return '"NaN"';
  if (!Number.isFinite(n)) return n > 0 ? '"Infinity"' : '"-Infinity"';
  if (n === 0) return "0";
  if (Number.isSafeInteger(n)) return String(n);
  return String(Number(n.toPrecision(SIGNIFICANT)));
}

function write(value: unknown, out: string[]): void {
  switch (typeof value) {
    case "number":
      out.push(canonicalNumber(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "bigint":
      out.push(value.toString());
      return;
    case "undefined":
    case "function":
    case "symbol":
      out.push("null");
      return;
  }
  if (value === null) {
    out.push("null");
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item, i) => {
      if (i) out.push(",");
      write(item, out);
    });
    out.push("]");
    return;
  }
  if (value instanceof Set) {
    out.push(`[${[...value].map((item) => canonicalJson(item)).sort().join(",")}]`);
    return;
  }
  const entries: Array<[string, unknown]> = value instanceof Map ? [...value].map(([key, item]) => [String(key), item]) : Object.entries(value as Record<string, unknown>);
  out.push("{");
  let first = true;
  for (const [key, item] of entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
    if (!first) out.push(",");
    first = false;
    out.push(JSON.stringify(key), ":");
    write(item, out);
  }
  out.push("}");
}

/** The canonical JSON text of a value (see the rules above). */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join("");
}
