/**
 * Attack: change what learning loops record, or how, in a release that approves itself (docs/plans/learning-loops.md,
 * Safety, Protection 1-4). Guards: release-auto.ts changeProblem through its policy paths (EVAL_POLICY: the learning
 * modules whole) and eval-hooks.ts learningHookProblem (required calls, strict and nested pins, the SQL writer scan),
 * run by the installed plane on a real plane database and repository. Each candidate must need a person; the legitimate
 * change beside it ships.
 *
 * Platform-free release-policy attacks (auto-approve-* runs on Linux + nightly macOS; the sandbox-exec output checks
 * stay in test/attacks/learning-loops-protection.slow.test.ts on the macOS lane).
 */
import { describe, expect, test } from "vitest";
import { authorize, check, open, seal } from "../auto-approve-world.js";

const needsPerson = (files: Record<string, string>, candidate: Record<string, string | null>, named: string) => {
  const f = open({ files, candidate });
  authorize(f);
  expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining(named) });
};
const ships = (files: Record<string, string>, candidate: Record<string, string | null>) => {
  const f = open({ files, candidate });
  authorize(f);
  const sealed = seal(f, check(f));
  expect(sealed.ok ? "" : sealed.why).toBe("");
};

const MODULES = ["src/check-facts.ts", "src/flaky.ts", "src/flaky-ci.ts", "src/lesson-notes.ts", "src/memory-use.ts", "src/memory-tidy.ts"];
const POLICY = "it's eval, nightly, model routing or learning policy code";

describe("the learning policy modules need a person, whole", () => {
  test.each(MODULES)("%s edited, added, renamed away or deleted: a person approves", path => {
    const kept = "export const kept = 1;\n";
    needsPerson({ [path]: kept }, { [path]: "export const kept = 2;\n" }, `${path} changed (${POLICY})`);
    needsPerson({}, { [path]: kept }, `${path} changed (${POLICY})`);
    needsPerson({ [path]: kept }, { [path]: null, "src/renamed.ts": kept }, `${path} changed (${POLICY})`);
    needsPerson({ [path]: kept }, { [path]: null }, `${path} changed (${POLICY})`);
  });
  test("an ordinary product file beside them ships", () => ships({ "src/check-facts.ts": "export const kept = 1;\n" }, { "src/other.ts": "export const x = 1;\n" }));
});

describe("no new writer of the learning rows, and the strict pins hold", () => {
  test.each([
    ["a new file recording a check's result", "src/sneaky.ts", "export const go = (db) => db.prepare(\"INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (1, 'check', 'passed', 'receipt', 'x')\").run();\n", "writes learning-loops rows"],
    ["a tally rewritten from a template", "src/tally.ts", "export const go = (db, n) => db.exec(`UPDATE lesson_note_tally SET failures = ${n}`);\n", "writes learning-loops rows"],
    ["a table name split around an expression", "src/split.ts", "export const go = (db, x) => db.exec(`DELETE FROM memory_${x}`);\n", "builds a learning-loops table's name"],
    ["a restore written past memory-tidy.ts", "src/restore.ts", "export const go = (db) => db.exec(\"UPDATE decision_merge SET undone_at = 'now', undone_by = 'x'\");\n", "writes learning-loops rows"],
  ])("%s: a person approves", (_name, path, text, named) => {
    needsPerson({}, { [path]: text }, `${path} ${named}`);
  });

  const KNOWLEDGE = (body: string) => `export function knowledgeContext(store, runId) {\n${body}\n}\n`;
  test("a pinned memory body changed: a person approves; unchanged beside another change, it ships", () => {
    needsPerson({ "src/project-knowledge.ts": KNOWLEDGE("  return select(store, runId);") }, { "src/project-knowledge.ts": KNOWLEDGE("  if (false) return select(store, runId);\n  return '';") }, "src/project-knowledge.ts's knowledgeContext changed");
    ships({ "src/project-knowledge.ts": KNOWLEDGE("  return select(store, runId);") }, { "src/project-knowledge.ts": `${KNOWLEDGE("  return select(store, runId);")}export const near = 1;\n` });
  });

  test("a strict pin the base can't resolve: a person approves, even for a change elsewhere", () => {
    needsPerson({ "src/project-memory.ts": "export const recordDecision = () => null;\nexport function retireDecision() {}\n" }, { "src/other.ts": "export const x = 1;\n" }, "pinned strictly");
  });

  const BUILDER = (inner: string, settle = "  recordCheckFacts(store, root, facts);") => `import { captureCheckConditions, recordCheckFacts } from "./check-facts.js";\n`
    + `async function settleProof(captured) {\n  if (captured) {\n    const runVerification = async (label) => {\n${inner}\n    };\n    await runVerification("a");\n  }\n${settle}\n}\n`;
  const FINE = BUILDER("      captureCheckConditions(conditions);\n      return run(label);");
  test.each([
    ["the conditions captured behind if (false)", BUILDER("      if (false) captureCheckConditions(conditions);\n      return run(label);"), "settleProof>runVerification"],
    ["the facts no longer recorded at disposition", BUILDER("      captureCheckConditions(conditions);\n      return run(label);", "  void 0;"), "no longer calls recordCheckFacts"],
  ])("builder with %s: a person approves", (_name, text, named) => {
    needsPerson({ "src/builder.ts": FINE }, { "src/builder.ts": text }, named);
  });
});
