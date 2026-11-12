import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Tradex gets all its market data from a Market Data Hub. This guards it:
//  - no code under src/ talks about Fyers or NSE's download hosts (comments
//    are allowed, e.g. citing where a cost or tick-size rule comes from);
//  - on the server, the hub client is the only code that calls fetch().

const SRC = path.resolve(__dirname);
/** Research citations shown as links in the screen descriptions; never fetched. */
const CITATIONS = new Set(["core/screener/screens.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/** Source without comments (good enough for this check: no regex literals contain comment markers here). */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");

const sources = files(SRC).map((file) => ({ file: path.relative(SRC, file).split(path.sep).join("/"), code: code(readFileSync(file, "utf8")) }));

describe("hub-only market data", () => {
  it("has no Fyers code and no NSE download hosts in src/", () => {
    const offenders = sources.flatMap(({ file, code: text }) => {
      const hits = [/fyers/i, /nsearchives/i, ...(CITATIONS.has(file) ? [] : [/nseindia\.com/i])].filter((pattern) => pattern.test(text));
      return hits.length ? [`${file}: ${hits.map(String).join(", ")}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("calls fetch() on the server only in the hub client", () => {
    // A call to the global fetch, not a `fetch(…)` method of a data source (`async fetch(request) {`, `fetch(symbols): …;`).
    const callsFetch = (text: string) => text.split("\n").some((line) => /(^|[^.\w])fetch\s*\(/.test(line) && !/^\s*(async\s+)?fetch\s*\([^)]*\)\s*(:[^=]*)?[{;]?\s*$/.test(line));
    const callers = sources.filter(({ file, code: text }) => /^(server|app\/api|core)\//.test(file) && callsFetch(text)).map(({ file }) => file);
    expect(callers).toEqual(["server/providers/hub/client.ts"]);
  });
});
