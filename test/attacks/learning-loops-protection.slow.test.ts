/**
 * Attack: change what learning loops record, or how, in a release that approves itself — or make a check's own output
 * move its outcome (docs/plans/learning-loops.md, Safety, Protection 1-5). Guards: release-auto.ts changeProblem
 * through its policy paths (EVAL_POLICY: the learning modules whole) and eval-hooks.ts learningHookProblem (required
 * calls, strict and nested pins, the SQL writer scan), run by the installed plane on a real plane database and
 * repository; and check-facts.ts, which only ever writes advisory rows. Each candidate must need a person; the
 * legitimate change beside it ships.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { authorize, check, open, passingReport, seal } from "../auto-approve-world.js";
import { EVIDENCE, sealedCheck, type ReleaseFixture } from "../release-fixture.js";
import { captureCheckConditions, checkFactOf, checkResultsOf, recordCheckFacts } from "../../src/check-facts.js";
import { LEARN_MAX_BYTES, LEARN_PREFIX } from "../../src/contracts/release-check.js";
import { verificationEvidence } from "../../src/verification-evidence.js";
import { classifyRunCheck } from "../../src/check-failure.js";
import { RELEASE_NOW } from "../release-fixture.js";

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

/** A release check of the candidate, sealed as the builder seals it, its facts recorded as the builder records them. */
function recorded(f: ReleaseFixture, before: (nonce: string) => string) {
  const sealed = sealedCheck(f, f.taskId, f.approved, (_plan, units) => passingReport(units), { base: f.base, learn: ["unit:src/index.test.ts::answer"], stdoutBefore: before });
  const conditions = captureCheckConditions({ repo: f.repo, head: f.approved, command: sealed.command, access: "sandboxed", envNames: ["PATH", "HOME"] });
  recordCheckFacts(f.store, EVIDENCE(f), { runId: sealed.runId, taskRef: f.store.refFor("built-in", f.taskId).id, repo: f.repo, conditions, receipt: { status: sealed.status },
    report: sealed.report, attempt: { nonce: sealed.prepared.nonce, learn: sealed.prepared.learn }, stdout: sealed.stdout, now: RELEASE_NOW });
  return sealed;
}
/** The lines a candidate's check prints, produced by a real process (inside the OS sandbox where one exists). */
function printed(text: string): string {
  const sandbox = process.platform === "darwin" ? ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)(deny file-write*)"] : [];
  const out = spawnSync(sandbox[0] ?? "/bin/sh", [...sandbox.slice(1), ...(sandbox.length > 0 ? ["/bin/sh"] : []), "-c", "cat"], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`the printing process failed: ${out.stderr}`);
  return out.stdout;
}

describe("a check's own output can move only advisory rows", () => {
  test("fake FAIL lines, a fake report and fake or flooded learning lines leave run_check, the receipt's standing and the automatic approval as they were", () => {
    const f = open();
    authorize(f);
    const fakes = (nonce: string) => printed([
      " FAIL  src/index.test.ts > answer", " Tests  1 failed",
      `TOOLROLL_CHECK_REPORT ${JSON.stringify({ version: 1, nonce: "0".repeat(64), mode: "full", planDigest: null, exitCode: 1, parts: [], units: null, journeys: [], upgrades: null })}`,
      `${LEARN_PREFIX}${JSON.stringify({ nonce: "e".repeat(64), results: [{ identity: "unit:src/index.test.ts::answer", state: "failed" }] })}`,
      `${LEARN_PREFIX}${JSON.stringify({ nonce, results: [{ identity: "unit:src/index.test.ts::answer", state: "failed" }] }).padEnd(LEARN_MAX_BYTES + 10, " ")}`,
    ].join("\n") + "\n");
    const attacked = recorded(f, fakes);
    expect(f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(attacked.runId)?.["status"]).toBe("passed");
    expect(verificationEvidence(f.store, EVIDENCE(f), attacked.runId).ok).toBe(true);
    expect(classifyRunCheck(f.store, EVIDENCE(f), attacked.runId)).toBeNull();
    // Only advisory rows: no learning line was read, and the receipt says passed.
    expect(checkFactOf(f.store, attacked.runId)).toMatchObject({ learnState: "not-recorded", learnWhy: "the learning line was over 64 KiB" });
    expect(checkResultsOf(f.store, attacked.runId).filter(one => one.source === "receipt")).toEqual([{ identity: "check", state: "passed", source: "receipt" }]);
    // The automatic approval reads this check exactly as it reads a clean one.
    expect(seal(f, attacked.runId)).toMatchObject({ ok: true });
  });

  test("a valid learning line saying a test failed leaves the passing check passing and approved", () => {
    const f = open();
    authorize(f);
    const run = recorded(f, nonce => printed(`${LEARN_PREFIX}${JSON.stringify({ nonce, results: [{ identity: "unit:src/index.test.ts::answer", state: "failed" }] })}\n`));
    expect(checkResultsOf(f.store, run.runId).filter(one => one.source === "learn")).toEqual([{ identity: "unit:src/index.test.ts::answer", state: "failed", source: "learn" }]);
    expect(f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(run.runId)?.["status"]).toBe("passed");
    expect(seal(f, run.runId)).toMatchObject({ ok: true });
  });
});
