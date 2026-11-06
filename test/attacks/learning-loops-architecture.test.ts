/**
 * Architecture: learning loops' hooks, pins and writers as this tree holds them (docs/plans/learning-loops.md, Safety,
 * Protection 2-5), and the checker's own rules tried against the ways around them. Every required call and strict pin
 * resolves here; every SQL site in the product that writes a learning-loops table (or a decision, its history or a
 * merge) is listed below and a new one fails this test; and the scan finds a write however its text is spelt or
 * whatever runs it.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type ts from "typescript-parser";
import { evalHookProblem, LEARNING_HOOKS, LEARNING_PINNED, LEARNING_WRITERS, learningConstructs, learningHookProblem, learningWriteProblem, type EvalPinned } from "../../src/eval-hooks.js";
import { V149_TABLES } from "../../src/store.js";

const ROOT = join(import.meta.dirname, "../..");
const read = (file: string): Buffer | null => { try { return readFileSync(join(ROOT, file)); } catch { return null; } };
const compiler = createRequire(import.meta.url)("typescript-parser") as typeof ts;
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}
const bytes = (files: Record<string, string>) => (file: string): Buffer | null => files[file] === undefined ? null : Buffer.from(files[file]!);

describe("this tree", () => {
  test("holds every required call and strict pin, the nested runVerification pin among them", () => {
    expect(learningHookProblem({ candidate: read, base: read }, { paths: [], candidate: read, base: read })).toBeNull();
    expect(LEARNING_HOOKS.map(hook => `${hook.file}:${hook.inside}→${hook.calls}`)).toEqual(["src/builder.ts:settleProof→recordCheckFacts", "src/builder.ts:settleProof>runVerification→captureCheckConditions"]);
    expect(LEARNING_PINNED.every(pin => pin.strict === true)).toBe(true);
    expect(LEARNING_PINNED.map(pin => pin.fn)).toEqual(["knowledgeContext", "learningContext", "decideProposal", "recordDecision", "retireDecision", "settleProof>runVerification"]);
    // Every v149 table has its writer.
    for (const table of V149_TABLES) expect(LEARNING_WRITERS[table], table).toBeDefined();
  });

  test("every SQL site that writes a protected table is one of these; a new one fails here", () => {
    const sites = sources("src").flatMap(file => {
      const source = compiler.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS);
      return learningConstructs(source).map(one => `${file} ${one.inside} ${one.bare ? `names ${one.text}` : `writes ${one.tables.join("+")}`}`);
    });
    expect([...new Set(sites)].sort()).toEqual([
      "src/check-facts.ts recordCheckFacts writes check_fact",
      "src/check-facts.ts recordCheckFacts writes check_result",
      "src/flaky.ts watchObservation writes learning_watch",
      "src/project-delete.ts SETTINGS names project_decision",
      "src/project-delete.ts deleteRows names decision_change",
      "src/project-memory.ts changeStatus writes decision_change",
      "src/project-memory.ts changeStatus writes project_decision",
      "src/project-memory.ts recordDecision writes decision_change",
      "src/project-memory.ts recordDecision writes project_decision",
      ...[...V149_TABLES].map(table => `src/store.ts V149_TABLES names ${table}`),
      ...["check_fact", "local_observation", "ci_flaky_observation", "learning_watch", "lesson_note", "memory_use", "memory_tidy_proposal"].map(table => `src/store.ts V149_REPO_TABLES names ${table}`),
    ].sort());
    // With no base to keep anything, every one stands where it is.
    expect(learningWriteProblem(sources("src"), read, () => null)).toBeNull();
  });
});

describe("the write scan finds a write however it is spelt or run", () => {
  test.each([
    ["a literal", "export const go = (db) => db.prepare(\"INSERT INTO check_fact (run) VALUES (1)\").run();\n", "writes learning-loops rows"],
    ["a template", "export const go = (db, run) => db.prepare(`UPDATE check_result SET state = 'passed' WHERE run = ${run}`).run();\n", "writes learning-loops rows"],
    ["a concatenation", "export const go = (db) => db.exec(\"DELETE \" + \"FROM lesson_note_tally\");\n", "writes learning-loops rows"],
    ["a concatenation around a value", "export const go = (db, id) => db.exec(\"UPDATE decision_merge SET undone_at = NULL WHERE merge = \" + id);\n", "writes learning-loops rows"],
    ["a table name split around a template expression", "export const go = (db, x) => db.exec(`DELETE FROM check_${x}`);\n", "builds a learning-loops table's name around an expression"],
    ["a table name split around a concatenation", "export const go = (db) => db.exec(\"DELETE FROM memory_\" + \"tidy\" + suffix);\nconst suffix = \"_proposal\";\n", "builds a learning-loops table's name around an expression"],
    ["handle.exec", "export const go = (store) => store.handle.exec('DROP TRIGGER IF EXISTS check_fact_no_update');\n", "writes learning-loops rows"],
    ["a renamed prepare", "export const go = (db) => { const run = db.prepare.bind(db); return run(`REPLACE INTO learning_watch (repo) VALUES ('r')`).run(); };\n", "writes learning-loops rows"],
    ["a quoted, schema-named table", "export const go = (db) => db.exec('DELETE FROM main.\"memory_use\"');\n", "writes learning-loops rows"],
    ["a merge written to the decisions", "export const go = (db) => db.exec(\"UPDATE project_decision SET status = 'active' WHERE id = 1\");\n", "writes learning-loops rows"],
    ["a table name held for later", "const TABLE = 'check_result';\nexport const go = (db) => db.exec(`DELETE FROM ${TABLE}`);\n", "names a learning-loops table"],
  ])("%s, from a new file: a person approves", (_name, text, named) => {
    expect(learningWriteProblem(["src/sneaky.ts"], bytes({ "src/sneaky.ts": text }), () => null)).toEqual(expect.stringContaining(`src/sneaky.ts ${named}`));
  });

  test("a writer's own writes stand; the same write the base already had stands beside a change; a test file isn't scanned", () => {
    const write = "export const go = (db) => db.prepare(\"INSERT INTO check_fact (run) VALUES (1)\").run();\n";
    expect(learningWriteProblem(["src/check-facts.ts"], bytes({ "src/check-facts.ts": write }), () => null)).toBeNull();
    // The writer of one table isn't a writer of another.
    expect(learningWriteProblem(["src/flaky.ts"], bytes({ "src/flaky.ts": write }), () => null)).toEqual(expect.stringContaining("writes learning-loops rows"));
    expect(learningWriteProblem(["src/legacy.ts"], bytes({ "src/legacy.ts": `${write}export const more = 1;\n` }), bytes({ "src/legacy.ts": write }))).toBeNull();
    // A second copy of the same write is new.
    expect(learningWriteProblem(["src/legacy.ts"], bytes({ "src/legacy.ts": `${write}${write.replace("go", "again")}` }), bytes({ "src/legacy.ts": write }))).not.toBeNull();
    expect(learningWriteProblem(["src/check-facts.test.ts", "test/x.ts"], bytes({ "src/check-facts.test.ts": write, "test/x.ts": write }), () => null)).toBeNull();
    // The v149 schema in store.ts is the migration's own; anything else in store.ts is held like any file.
    expect(learningWriteProblem(["src/store.ts"], bytes({ "src/store.ts": "export const V149_SCHEMA = `CREATE TRIGGER x BEFORE UPDATE ON check_fact BEGIN DELETE FROM check_result; END;`;\n" }), () => null)).toBeNull();
    expect(learningWriteProblem(["src/store.ts"], bytes({ "src/store.ts": `export class Store { go() { ${write.slice("export const go = (db) => ".length).replace("db.", "this.db.").trim()} } }\n` }), () => null)).not.toBeNull();
    // Unreadable or unparsable: a person decides.
    expect(learningWriteProblem(["src/x.ts"], () => null, () => null)).toBe("src/x.ts can't be read");
    expect(learningWriteProblem(["src/x.ts"], bytes({ "src/x.ts": "export const = ;" }), () => null)).toBe("src/x.ts doesn't parse");
  });
});

describe("pins: nested and strict", () => {
  const settle = (inner: string, extra = "") => `export async function settleProof(captured) {\n  if (captured) {\n    const runVerification = async (label) => {\n${inner}\n    };\n    await runVerification("a");\n  }\n}\n${extra}`;
  const PIN: EvalPinned[] = [{ file: "src/builder.ts", fn: "settleProof>runVerification", strict: true, why: "the check" }];
  const problem = (base: string | null, candidate: string | null) => evalHookProblem(bytes(candidate === null ? {} : { "src/builder.ts": candidate }), bytes(base === null ? {} : { "src/builder.ts": base }), [], PIN);
  const ORIGINAL = settle("      capture(label);\n      return run(label);");

  test("the nested body is held: an if (false), a changed argument or a dropped call needs a person; a change beside it ships", () => {
    expect(problem(ORIGINAL, ORIGINAL)).toBeNull();
    expect(problem(ORIGINAL, `${ORIGINAL}export const unrelated = 1;\n`)).toBeNull();
    for (const changed of [settle("      if (false) capture(label);\n      return run(label);"), settle("      capture(\"x\");\n      return run(label);"), settle("      return run(label);")]) {
      expect(problem(ORIGINAL, changed)).toBe("src/builder.ts's settleProof>runVerification changed (the check)");
    }
  });

  test("a stand-in can't take the nested name: declared twice, reassigned, moved out, or inside another function, it isn't the pin", () => {
    for (const changed of [
      settle("      return run(label);", "const runVerification = () => 0;\n"),
      ORIGINAL.replace("    await runVerification(\"a\");", "    runVerification = async () => 0;\n    await runVerification(\"a\");"),
      `const runVerification = async (label) => {\n      capture(label);\n      return run(label);\n    };\nexport async function settleProof(captured) { await runVerification("a"); }\n`,
      `export async function settleProof(captured) {\n  const wrap = () => {\n    const runVerification = async (label) => {\n      capture(label);\n      return run(label);\n    };\n  };\n}\n`,
      `export async function settleProof(captured) {\n  let runVerification = async (label) => {\n      capture(label);\n      return run(label);\n    };\n}\n`,
    ]) expect(problem(ORIGINAL, changed)).toBe("src/builder.ts no longer has settleProof>runVerification as one function (the check)");
  });

  test("strict: a base that holds the file but can't resolve the pin needs a person; a base without the file (not Toolroll) holds none", () => {
    expect(problem(settle("", "const runVerification = 1;\n"), ORIGINAL)).toBe("src/builder.ts at the base has no settleProof>runVerification as one function, which is pinned strictly (the check)");
    expect(problem("export const = ;", ORIGINAL)).toContain("pinned strictly");
    expect(problem(null, null)).toBeNull();
    // A non-strict pin the base can't resolve is skipped, as today.
    expect(evalHookProblem(bytes({ "src/builder.ts": ORIGINAL }), bytes({ "src/builder.ts": "export {};\n" }), [], [{ ...PIN[0]!, strict: undefined } as EvalPinned])).toBeNull();
  });

  test("a hook inside the nested function: the call must stay there, bound to its module", () => {
    const hook = [{ file: "src/builder.ts", inside: "settleProof>runVerification", calls: "captureCheckConditions", from: "./check-facts.js", why: "conditions" }];
    const file = (inner: string, imports = "import { captureCheckConditions } from \"./check-facts.js\";\n") => `${imports}${settle(inner)}`;
    const check = (candidate: string) => evalHookProblem(bytes({ "src/builder.ts": candidate }), bytes({ "src/builder.ts": file("      captureCheckConditions(label);") }), hook, []);
    expect(check(file("      captureCheckConditions(label);"))).toBeNull();
    expect(check(file("      return 0;"))).toBe("src/builder.ts's settleProof>runVerification no longer calls captureCheckConditions (conditions)");
    expect(check(file("      captureCheckConditions(label);", "const captureCheckConditions = () => null;\n"))).toContain("no longer calls the real captureCheckConditions");
  });
});
