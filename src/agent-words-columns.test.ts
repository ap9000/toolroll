/**
 * Words an agent may have written (what it said on its way out, run.agent_said_json; why its plan was refused,
 * run.plan_problems_json) are read only through their cleaned accessors (store.ts agentSaidOf, planProblemsOf) and
 * written only through their cleaning writers (recordAgentSaid, recordPlanProblems). No other product file names either
 * column: a new reader that selected one raw would show or send what was never cleaned. Allowed narrowly: the schema
 * files that declare them, the accessors and shape checks in store.ts, and the export's own accessor table. Tests may
 * name them (they plant raw values on purpose).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const COLUMN = /\b(agent_said_json|plan_problems_json)\b/;
const SCHEMA_FILES = new Set(["src/agent-said-schema.ts", "src/plan-problems-schema.ts"]);
const STORE_FUNCTIONS = new Set(["recordAgentSaid", "agentSaidOf", "agentSaidShapeProblem", "recordPlanProblems", "planProblemsOf", "planProblemsShapeProblem"]);
/** The export reads both through their accessors (export.ts CLEANED_COLUMNS): only those table lines may name them. */
const EXPORT_LINE = /^\s*"run\.(agent_said_json|plan_problems_json)": (agentSaidOf|planProblemsOf),$/;

function productFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "node_modules") out.push(...productFiles(path)); continue; }
    if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*\*)/.test(line);

/** The top-level function a line of store.ts sits in, by the nearest declaration above it. */
function enclosingFunction(lines: readonly string[], at: number): string | null {
  for (let i = at; i >= 0; i--) {
    const found = /^(?:export )?(?:async )?function (\w+)/.exec(lines[i]!);
    if (found !== null) return found[1]!;
    if (i < at && /^\S/.test(lines[i]!) && !/^[})\]]/.test(lines[i]!) && !isComment(lines[i]!)) return null;
  }
  return null;
}

describe("agent-written columns are read and written only through their cleaning accessors", () => {
  test("no product file names a raw column outside the allowed sites", () => {
    const offenders: string[] = [];
    for (const file of [...productFiles(join(ROOT, "src")), ...productFiles(join(ROOT, "scripts"))]) {
      const name = relative(ROOT, file);
      if (SCHEMA_FILES.has(name)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, at) => {
        if (!COLUMN.test(line) || isComment(line)) return;
        if (name === "src/store.ts" && STORE_FUNCTIONS.has(enclosingFunction(lines, at) ?? "")) return;
        if (name === "src/export.ts" && EXPORT_LINE.test(line)) return;
        offenders.push(`${name}:${at + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
