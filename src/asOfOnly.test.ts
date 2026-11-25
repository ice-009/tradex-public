import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Point in time (issue #19): the screener, plan and backtester read reference
// data only through asOf. This runs the project's ESLint config on snippets to
// prove the rule bites (and doesn't bite elsewhere).

const ROOT = path.resolve(__dirname, "..");
const eslint = new ESLint({ cwd: ROOT });

async function restricted(file: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(ROOT, file) });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports").map((message) => message.message);
}

describe("reference data only through asOf", { timeout: 60_000 }, () => {
  it("stops the screener, plan and backtest services reading reference providers directly", async () => {
    for (const file of ["src/server/services/screener.ts", "src/server/services/evidence.ts", "src/server/services/backtest.ts", "src/server/services/btstRecord.ts", "src/server/services/lab.ts"]) {
      expect(await restricted(file, `import { getLotSizes } from "@/server/providers/reference";\nvoid getLotSizes;\n`), file).toEqual([expect.stringMatching(/through asOf/)]);
    }
    expect(await restricted("src/server/services/backtest.ts", `import { foMembership } from "@/server/providers/foData";\nvoid foMembership;\n`)).toHaveLength(1);
    expect(await restricted("src/server/services/screener.ts", `import { getUniverse } from "../providers/universe";\nvoid getUniverse;\n`)).toHaveLength(1);
    expect(await restricted("src/server/services/evidence.ts", `import { lotHistory } from "@/server/providers/referenceHistory";\nvoid lotHistory;\n`)).toHaveLength(1);
    expect(await restricted("src/server/services/screener.ts", `import { hubClient } from "@/server/providers/hub";\nvoid hubClient;\n`)).toHaveLength(1);
  });

  it("allows asOf, constants and non-reference imports, and keeps the layer rules", async () => {
    expect(await restricted("src/server/services/backtest.ts", `import { asOfSpan } from "@/server/providers/asOf";\nimport { UNIVERSES } from "@/server/providers/universe";\nimport { hubEndOfDay } from "@/server/providers/hub";\nimport { latestOiFacts } from "@/server/providers/foData";\nvoid [asOfSpan, UNIVERSES, hubEndOfDay, latestOiFacts];\n`)).toEqual([]);
    expect(await restricted("src/server/services/screener.ts", `import { x } from "@/terminal/store";\nvoid x;\n`)).toEqual([expect.stringMatching(/src\/server must not import frontend code/)]);
    expect(await restricted("src/core/backtest/portfolio.ts", `import { x } from "@/server/providers/reference";\nvoid x;\n`)).toHaveLength(2);
    // Other services (the results panel, the lots endpoint's feed) may still read today's data directly.
    expect(await restricted("src/server/services/results.ts", `import { getResultsCalendar } from "@/server/providers/reference";\nvoid getResultsCalendar;\n`)).toEqual([]);
  });
});
