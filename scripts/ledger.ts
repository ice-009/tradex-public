// The sealed-plan ledger from the command line (issue #33). Run through
// scripts/ledger.mjs (`npm run ledger`). Reads the server's market database
// (.cache/market.db, or MARKET_DB_PATH) — or an export — and checks it with the
// same code as GET /api/plan/ledger/verify. Exits 1 when anything fails.
//
//   npm run ledger -- verify                              the whole chain in .cache/market.db
//   npm run ledger -- verify --file tradex-plan-ledger.json   an export (GET /api/plan/ledger?from=2000-01-01)
//   npm run ledger -- verify --anchors ledger.jsonl       also against hashes published outside (one JSON line per seal)
//   npm run ledger -- show [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   npm run ledger -- export [--out file.json]

import { readFileSync, writeFileSync } from "node:fs";
import { checkAnchors, verifyLedger, type LedgerAnchor, type LedgerRecord } from "@/core/plan/seal";
import { shortHash } from "@/core/repro/stamp";

const USAGE = `Usage: npm run ledger -- <verify|show|export> [options]

  verify [--file export.json] [--anchors ledger.jsonl]
  show   [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  export [--out file.json]`;

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Unexpected argument ${key}\n\n${USAGE}`);
    args[key.slice(2)] = value;
  }
  return { command, args };
}

const day = (text: string | undefined) => {
  if (!text) return null;
  const value = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(value)) throw new Error(`Not a date: ${text} (YYYY-MM-DD)`);
  return value;
};
const dayText = (value: number) => new Date(value).toISOString().slice(0, 10);

async function stored() {
  return import("@/server/providers/planLedger");
}

/** An export: the GET /api/plan/ledger body, or a bare list of records. */
function readExport(file: string): { entries: LedgerRecord[]; after: { seq: number; hash: string } | null } {
  const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (Array.isArray(json)) return { entries: json as LedgerRecord[], after: null };
  const body = json as { entries?: LedgerRecord[]; after?: { seq: number; hash: string } | null };
  if (!Array.isArray(body.entries)) throw new Error(`${file} isn't a ledger export (no "entries").`);
  return { entries: body.entries, after: body.after ?? null };
}

function readAnchorFile(file: string): LedgerAnchor[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerAnchor);
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "verify") {
    const source = args.file ? readExport(args.file) : { entries: (await stored()).readLedger(), after: null };
    const result = verifyLedger(source.entries, source.after);
    const where = args.file ?? "the server's ledger";
    if (result.ok) console.log(`✓ ${result.count} seal${result.count === 1 ? "" : "s"} in ${where} verify end to end${result.head ? ` — newest #${result.head.seq} ${dayText(result.head.day)} ${result.head.kind} ${result.head.hash}` : ""}.`);
    else {
      console.log(`✗ ${where}: the chain breaks at #${result.firstBad} (${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}):`);
      for (const problem of result.problems) console.log(`  - ${problem.message}`);
    }
    if (source.after) console.log(`  (a slice: it starts after #${source.after.seq} ${source.after.hash}, which it trusts)`);
    let ok = result.ok;
    const anchors = args.anchors ? readAnchorFile(args.anchors) : !args.file ? (await stored()).readAnchors().filter((anchor) => anchor.ok) : [];
    if (anchors.length) {
      const check = checkAnchors(source.entries, anchors);
      console.log(check.ok ? `✓ ${check.checked} published hash${check.checked === 1 ? "" : "es"} match${args.anchors ? ` (${args.anchors})` : " (as the server recorded them)"}.` : `✗ Published hashes:\n${check.problems.map((problem) => `  - ${problem}`).join("\n")}`);
      ok &&= check.ok;
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === "show") {
    const records = (await stored()).readLedger({ from: day(args.from), to: day(args.to) });
    if (!records.length) console.log("No seals in that range.");
    for (const record of records) {
      const ideas = record.plan.ideas.map((idea) => idea.symbol);
      console.log(`#${record.seq} ${dayText(record.day)} ${record.kind.padEnd(5)} ${new Date(record.sealedAt).toISOString()} ${shortHash(record.hash)} ← ${shortHash(record.prevHash)}  ${ideas.length} idea${ideas.length === 1 ? "" : "s"}${ideas.length ? `: ${ideas.slice(0, 10).join(", ")}${ideas.length > 10 ? " …" : ""}` : ""}`);
    }
    return;
  }
  if (command === "export") {
    const entries = (await stored()).readLedger();
    const text = JSON.stringify({ entries, after: null }, null, 1);
    if (args.out) {
      writeFileSync(args.out, text);
      console.log(`Wrote ${entries.length} seal${entries.length === 1 ? "" : "s"} to ${args.out}.`);
    } else process.stdout.write(`${text}\n`);
    return;
  }
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
