/**
 * Attack: change how results routing reads evidence, or write its rows from somewhere new, in a release that approves
 * itself (docs/plans/results-routing.md, Protection item 5). Guard: release-auto.ts changeProblem, through its policy
 * paths (EVAL_POLICY) and route-hooks.ts routingHookProblem (required calls, pinned bodies, the SQL writer scan), run
 * by the installed plane on a real plane database and repository. Each candidate leaves the scorer unchanged and must
 * need a person; the legitimate change beside each one ships.
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

describe("results-routing policy code needs a person", () => {
  test.each([
    // An eligibility change, or a changed execution-class table, lives in the evaluator.
    ["src/route-results.ts", "export const EXEC_CLASS_OF_REASON = { timeout: \"infrastructure\" };\n"],
    ["src/route-results.ts", "export function cohortOf() { return { cohortSize: \"small\", ineligible: null }; }\n"],
    ["src/route-store.ts", "export function recordExecClass() {}\n"],
    ["src/route-rules.ts", "export function acceptRule() { return { ok: true }; }\n"],
    ["src/route-hooks.ts", "export const ROUTING_HOOKS = [];\n"],
    ["src/contracts/route-results.ts", "export const REVISION_ORIGINS = [\"person\"];\n"],
  ])("%s changed: a person approves", (path, text) => {
    needsPerson({}, { [path]: text }, `${path} changed (it's eval, nightly or model routing policy code)`);
  });
});

describe("no new writer of the routing rows", () => {
  test.each([
    ["a new file inserting a rule", "src/sneaky.ts", "export const go = (db) => db.prepare(\"INSERT INTO route_rule (repo) VALUES (?)\").run('x');\n"],
    ["a direct Models row update", "src/models-tweak.ts", "export const go = (db) => db.prepare(`UPDATE phase_config SET model = ? WHERE scope = ?`).run('m', 's');\n"],
    ["a quoted, schema-named table", "src/tidy.ts", "export const go = (db) => db.exec('DELETE FROM main.\"run_cohort\"');\n"],
    ["a run's execution class rewritten", "src/fixup.ts", "export const go = (db) => db.prepare(\"UPDATE run SET reason = ?, exec_class = 'infrastructure' WHERE id = ?\").run('x', 1);\n"],
    ["a revision's origin rewritten", "src/origin.ts", "export const go = (db) => db.prepare(\"UPDATE task_ref SET revision_origin = 'flow' WHERE id = ?\").run(1);\n"],
    ["a template with an interpolated value", "src/gen.ts", "export const go = (db, n) => db.exec(`UPDATE models_generation SET generation = ${n}`);\n"],
  ])("%s: a person approves", (_name, path, text) => {
    needsPerson({}, { [path]: text }, `${path} writes results-routing or Models rows outside their writers`);
  });

  test("the same write the base already had ships beside an ordinary change; a test file's fixture write ships", () => {
    const old = "export const go = (db) => db.prepare(\"DELETE FROM phase_config WHERE scope = ?\").run('x');\n";
    ships({ "src/legacy.ts": old }, { "src/legacy.ts": `${old}export const more = 2;\n`, "src/legacy.test.ts": "test('x', () => { db.exec(\"INSERT INTO route_rule (repo) VALUES ('r')\"); });\n" });
  });
});

describe("the calls that feed the records, and the bodies that decide them, stay as the base has them", () => {
  const FLOW = (origin: string) => `import { requestResultChanges } from "./result-actions.js";\n`
    + `export function revisionWithNote(store, root, note, now) {\n  return requestResultChanges(store, root, { note, allowMode: true, origin: ${origin} }, now);\n}\n`;
  test("a caller passing origin person from the flow path: a person approves; the flow's own origin ships", () => {
    needsPerson({ "src/flow-engine.ts": FLOW(`"flow"`) }, { "src/flow-engine.ts": FLOW(`"person"`) }, "src/flow-engine.ts's revisionWithNote changed what it passes to requestResultChanges");
    ships({ "src/flow-engine.ts": FLOW(`"flow"`) }, { "src/flow-engine.ts": `${FLOW(`"flow"`)}export const kept = 1;\n` });
  });

  const DISPOSE = (body: string) => `import { recordExecClass } from "./route-store.js";\nexport function disposeBuildOutcomeLocked(store, runId, result) {\n${body}\n  return result;\n}\n`;
  test.each([
    ["the raw class no longer kept", DISPOSE("  const kept = 1;"), "no longer calls recordExecClass"],
    ["the normalized reason kept instead of the raw one", DISPOSE("  recordExecClass(store, runId, \"retryable-infra\");"), "changed what it passes to recordExecClass"],
  ])("dispose with %s: a person approves", (_name, text, named) => {
    needsPerson({ "src/dispose.ts": DISPOSE("  recordExecClass(store, runId, result.reason);") }, { "src/dispose.ts": text }, named);
  });

  test("a project deletion that skips the Models counter: a person approves", () => {
    const rows = (body: string) => `import { forgetProjectModels } from "./store.js";\nexport function deleteRows(store, repo, now) {\n${body}\n}\n`;
    needsPerson({ "src/project-delete.ts": rows("  return forgetProjectModels(store, repo, now);") },
      { "src/project-delete.ts": rows("  store.handle.exec(`DELETE FROM ${'phase_config'}`);\n  return 0;") }, "no longer calls forgetProjectModels");
  });

  test("an if (false) around a check in a pinned consumer: a person approves", () => {
    const store = (guard: string) => `export class Store {\n  sealScopeApproval(taskId) {\n    if (${guard}) return false;\n    return true;\n  }\n}\n`;
    needsPerson({ "src/store.ts": store("this.trialProblem(taskId)") }, { "src/store.ts": store("false && this.trialProblem(taskId)") }, "src/store.ts's Store#sealScopeApproval changed");
  });

  test("a pinned Models writer that stops moving its generation: a person approves", () => {
    const writer = (body: string) => `import { bumpModelsGeneration } from "./route-store.js";\nexport class Store {\n  clearPhaseConfig(scope, phase) {\n    const gone = this.db.prepare("DELETE FROM phase_config WHERE scope = ? AND phase = ?").run(scope, phase);\n${body}\n    return gone;\n  }\n}\n`;
    needsPerson({ "src/store.ts": writer("    bumpModelsGeneration(this, scope, phase, new Date());") }, { "src/store.ts": writer("") }, "src/store.ts's Store#clearPhaseConfig changed");
  });
});

describe("slice 2: the precedence order, the hold and the rule pass stay as the base has them", () => {
  test("an eligibility change in selectBuildLeg: a person approves", () => {
    const routing = (guard: string) => `export function selectBuildLeg(input, configured) {\n  if (${guard}) return { leg: configured, moved: false };\n  return { leg: input, moved: false };\n}\n`;
    needsPerson({ "src/phase-routing.ts": routing("input.size?.size === \"large\"") }, { "src/phase-routing.ts": routing("false") }, "src/phase-routing.ts's selectBuildLeg changed");
  });

  test("the rule pass dropped from the reconcile pass: a person approves", () => {
    const pass = (body: string) => `import { routeRulesPass } from "./route-rules.js";\nexport async function reconcileCommand(store, repo, now) {\n${body}\n}\n`;
    needsPerson({ "src/operate.ts": pass("  routeRulesPass(store, repo, now);") }, { "src/operate.ts": pass("  return 0;") }, "no longer calls routeRulesPass");
  });

  test("a switched-off rule's admission hold removed from admitRun: a person approves", () => {
    const admit = (body: string) => `export class Store {\n  admitRun(run) {\n${body}\n    return 1;\n  }\n}\n`;
    needsPerson({ "src/store.ts": admit("    if (ruleHoldOf(this, run.task) !== null) throw new Error('rule-switched-off');") }, { "src/store.ts": admit("") }, "src/store.ts's Store#admitRun changed");
  });
});

describe("slice 3: a trial's person-only approval and its precedence stay as the base has them", () => {
  test("an if (false) around the trial check in sealScopeApproval: a person approves", () => {
    const seal = (guard: string) => `export class Store {\n  sealScopeApproval(taskId, by, now, mutation, basis) {\n    if (${guard}) return false;\n    return true;\n  }\n}\n`;
    needsPerson({ "src/store.ts": seal("trialSealProblem(this, { basis }) !== null") }, { "src/store.ts": seal("false && trialSealProblem(this, { basis }) !== null") }, "src/store.ts's Store#sealScopeApproval changed");
  });

  test("the trial clause dropped from the dispatch predicate: a person approves", () => {
    const sql = (tail: string) => `export function authorityStandsSql(scope, repo, now) {\n  return \`COALESCE(1${tail}, 0)\`;\n}\nexport function trialSealStandsSql(scope) { return "1"; }\n`;
    needsPerson({ "src/approval-authority.ts": sql(" AND (instr(x, 'trial') = 0 OR ${trialSealStandsSql(scope)})") }, { "src/approval-authority.ts": sql("") }, "src/approval-authority.ts's authorityStandsSql changed");
  });

  test("a trial that skips its eligibility in trialFor: a person approves", () => {
    const routing = (guard: string) => `export function trialFor(input, configured) {\n  if (${guard}) return null;\n  return { kind: "trial", trial: input.earned.trial };\n}\n`;
    needsPerson({ "src/phase-routing.ts": routing("input.size?.size === \"large\"") }, { "src/phase-routing.ts": routing("false") }, "src/phase-routing.ts's trialFor changed");
  });

  test("a new file consuming a trial place: a person approves", () => {
    needsPerson({}, { "src/shortcut.ts": "export const go = (db) => db.prepare(\"UPDATE route_trial_reservation SET state = 'consumed' WHERE id = ?\").run(1);\n" }, "src/shortcut.ts writes results-routing or Models rows outside their writers");
  });
});
