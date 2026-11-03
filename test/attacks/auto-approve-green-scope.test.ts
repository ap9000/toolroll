/**
 * Attack: make a release approve itself when it shouldn't — the change classes that always need a person (codex r1 #2).
 * The rest of the automatic-approval attacks are in auto-approve-green.test.ts; this half runs beside it in CI.
 */
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, builtRun, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { authorizeAutoCheck, ciProblem, giveUpAutoApproval, holdApprovalForCi, liftCiHold, sealAutoGreen, setReleaseApproval, type CiObservation } from "../../src/release-auto.js";
import { noteCiRunning, releaseCiRunningOf, RELEASE_CI_RUNNING_WORDS } from "../../src/release-ci-hold.js";
import { releaseAutoApproves } from "../../src/release-authority.js";
import { approve, liveReleaseOf, personApprovalOf, propose, releaseApprovalOf } from "../../src/scope.js";
import { releaseAuthorityOfTask } from "../../src/store.js";
import { scopeApprovedForDispatch } from "../../src/dispatch.js";
import { deploymentGate } from "../../src/deploy-gate.js";
import { mergePullRequest } from "../../src/pull-request-flow.js";
import { assignmentOf } from "../../src/assignment.js";
import { runReleaseCommand } from "../../src/release-cli.js";
import { REQUIRED_PR_CHECKS, REQUIRED_PR_CHECKS_WORKFLOW } from "../../src/release.js";
import { RELEASE_RECHECK_ACTION, retriedOfRun, SETUP_REPLAY_RETRY, setupReplayWords } from "../../src/check-failure.js";
import { launchFailedBeforeCheck } from "../../src/builder.js";
import { CHECK_REPORT_CAPTURE, CheckBaselineUnverifiable } from "../../src/check-report.js";
import { verificationEvidence } from "../../src/verification-evidence.js";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../../scripts/deploy-candidate.mjs";
import * as installedScope from "../../src/scope.js";

import { execFileSync } from "node:child_process";
import { readCheckRuns, readContains, readMainHead, readMainProtection, readMergeBase, readUpToDateRequired, storeReleaseAdapter, type Exec } from "../../src/release-adapters.js";
import { PROTECTION_MINIMUM_CHECKS, PROTECTION_REPORT_ONLY_CHECKS } from "../../src/release.js";
import { adoptReleaseOperation, finishReleaseOperation, releaseOperations, reserveRelease, runReleaseOperation, takeReleaseLease } from "../../src/store.js";
import { testInfrastructure } from "../../src/test-infra.js";
import { readSuitesComplete } from "../../src/release-adapters.js";
import { allowAutoPublish, autoPublishHeld, holdAutoPublish } from "../../src/release-auto.js";
import { LATER, UNITS, authorize, basis, check, digestOf, green, held, infraCheck, open, passingReport, receiptOf, ref, rerunRecorded, seal } from "../auto-approve-world.js";

describe("codex r1 #2: only product code, tests, docs, the changelog and a version bump ship without a person", () => {
  const lock = (version: string, deps: Record<string, string> = {}) => JSON.stringify({ name: "fixture-app", version, lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-app", version, ...(Object.keys(deps).length === 0 ? {} : { dependencies: deps }) } } }, null, 2) + "\n";
  const pkg = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "fixture-app", version, type: "module", files: ["dist"], scripts: { build: "node build.mjs" }, ...extra }, null, 2) + "\n";
  test.each([
    ["scripts/check-results.mjs", "// reports\n"],
    ["scripts/postbuild.mjs", "// build\n"],
    ["scripts/app-e2e.mjs", "// journeys, changed\n"],
    ["test/helpers.ts", "export {};\n"],
    ["test/attacks/vitest.config.ts", "export default {};\n"],
    ["test/release-fixture.ts", "export {};\n"],
    ["test/fixtures/sample.test.ts", "test('x', () => {});\n"],
    ["test/attacks/harness.ts", "export {};\n"],
    ["docs/testing.md", "# Testing\n"],
    ["docs/plans/next.md", "# Plan\n"],
    ["src/fixtures/sample.json", "{}\n"],
    ["src/test-temp.ts", "export {};\n"],
    ["src/unfenced-test-support.ts", "export {};\n"],
    ["tsconfig.json", "{}\n"],
    ["src/browser/vite.config.ts", "export default {};\n"],
    [".npmrc", "registry=https://example.invalid\n"],
    ["CLAUDE.md", "# anything\n"],
    ["Makefile", "all:\n"],
    // The eval set's and GitHub nightly's policy code (evals-nightly.md, C1): cases, oracles, the evaluator, reviewer
    // scoring, nightly ingestion and their contracts.
    ["evals/manifest.json", "{}\n"],
    ["evals/cases/paginate/oracle.mjs", "export const files = [];\n"],
    ["src/evals.ts", "export {};\n"],
    ["src/eval-oracle.ts", "export {};\n"],
    ["src/eval-hooks.ts", "export const EVAL_HOOKS = [];\n"],
    ["src/reviewer-evals.ts", "export {};\n"],
    ["src/nightly-github.ts", "export {};\n"],
    ["src/contracts/evals-report.ts", "export {};\n"],
    // The accounting readings evals trust (Codex C1 round 1 #5).
    ["src/reported-usage.ts", "export {};\n"],
    ["src/run-efficiency.ts", "export {};\n"],
  ])("%s changed: a person approves", (path, text) => {
    const f = open({ candidate: { [path]: text } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining(`${path} changed`) });
  });

  test.each([
    ["a dependency added to package.json", { "package.json": pkg("0.9.71", { dependencies: { vitest: "^9.9.9" } }) }],
    ["a dependency swapped in the lockfile", { "package-lock.json": lock("0.9.71", { vitest: "npm:fake-vitest@1.0.0" }) }],
    ["package.json scripts changed", { "package.json": pkg("0.9.71", { scripts: { build: "node build.mjs", test: "true" } }) }],
  ])("%s: a person approves", (_name, files) => {
    const f = open({ candidate: files });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("beyond its version") });
  });

  // The calls into eval and nightly policy (eval-hooks.ts): a candidate that drops or moves one the base holds needs a
  // person; one that keeps it ships. A project whose base holds none is held to none.
  const GATE = `import { takeEvalDispatch } from "./eval-gate.js";\n`;
  const leadRequest = (body: string, head = GATE) => `${head}export async function performLeadRequest(request) {\n${body}\n  return request;\n}\nexport function other() {\n  return 1;\n}\n`;
  test.each([
    ["the call removed", leadRequest("  const kept = 1;")],
    ["the call left only in a comment", leadRequest("  // takeEvalDispatch(`lead`);")],
    ["the call left only in a string", leadRequest("  const words = \"takeEvalDispatch(`lead`)\";")],
    // Codex C1 round 1 #6: a regular expression literal is not a call.
    ["the call left only in a regular expression", leadRequest("  const removed = /takeEvalDispatch()/;")],
    ["the file no longer parsing", leadRequest("  takeEvalDispatch(`lead`);\n  const broken = ;")],
    ["the call moved to another function", `${GATE}export async function performLeadRequest(request) {\n  return request;\n}\nexport function other() {\n  takeEvalDispatch(\`lead\`);\n}\n`],
    // PR #263 review: the call must reach the real gate, not a local stand-in of the same name.
    ["the import renamed beside a local function of the same name", leadRequest("  takeEvalDispatch(`lead`);", `import { takeEvalDispatch as _unused } from "./eval-gate.js";\nfunction takeEvalDispatch() {\n  return { active: false };\n}\n`)],
    ["the import renamed, the gate called under another name", leadRequest("  gate(`lead`);", `import { takeEvalDispatch as gate } from "./eval-gate.js";\n`)],
    ["another export imported under the gate's name", leadRequest("  takeEvalDispatch(`lead`);", `import { inEvalWorld as takeEvalDispatch } from "./eval-gate.js";\n`)],
    ["a namespace import with a local of the gate's name", leadRequest("  takeEvalDispatch(`lead`);", `import * as gate from "./eval-gate.js";\nconst takeEvalDispatch = (kind) => gate.inEvalWorld() && { active: false, kind };\n`)],
    ["the gate imported from another module", leadRequest("  takeEvalDispatch(`lead`);", `import { takeEvalDispatch } from "./eval-gate-shim.js";\n`)],
    ["the gate shadowed inside the function", leadRequest("  const takeEvalDispatch = () => ({ active: false });\n  takeEvalDispatch(`lead`);")],
    ["the gate shadowed by a parameter", leadRequest("  takeEvalDispatch(`lead`);").replace("performLeadRequest(request)", "performLeadRequest(request, takeEvalDispatch = () => ({ active: false }))")],
    ["the gate shadowed by destructuring", leadRequest("  const { takeEvalDispatch } = request;\n  takeEvalDispatch(`lead`);")],
    ["the enclosing function replaced after its declaration", `${leadRequest("  takeEvalDispatch(`lead`);")}performLeadRequest = async request => request;\n`],
    ["the function renamed", leadRequest("  takeEvalDispatch(`lead`);").replace("performLeadRequest", "performRequest")],
    ["the file deleted", null],
  ])("an enforcement hook with %s: a person approves", (_name, text) => {
    const f = open({ files: { "src/converse.ts": leadRequest("  takeEvalDispatch(`lead`);") }, candidate: { "src/converse.ts": text } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("src/converse.ts") });
  });

  // Codex C1 round 1 #5: the store's accounting reads are pinned by body; changing one needs a person.
  const accounting = (body: string) => `export function runAccounting(store, runId) {\n${body}\n}\nexport function other() {\n  return 1;\n}\n`;
  test("a pinned accounting function changed: a person approves; one left as it was ships", () => {
    const changed = open({ files: { "src/store.ts": accounting("  return { amount: 'measured' };") }, candidate: { "src/store.ts": accounting("  return { amount: 'zero' };") } });
    authorize(changed);
    expect(seal(changed, check(changed))).toMatchObject({ ok: false, why: expect.stringContaining("src/store.ts's runAccounting changed") });
    changed.close();
    held.fixture = null;
    const kept = open({ files: { "src/store.ts": accounting("  return { amount: 'measured' };") }, candidate: { "src/store.ts": accounting("  return { amount: 'measured' };").replace("return 1;", "return 2;") } });
    authorize(kept);
    const sealed = seal(kept, check(kept));
    expect(sealed.ok ? "" : sealed.why).toBe("");
  });

  // PR #263 review: the store's own spending writes are Store methods, pinned by body too; a method replaced by name
  // after the class, or declared twice, is no longer the body that was pinned.
  const storeClass = (body: string, after = "") => `export class Store {\n  recordUsage(id, usage) {\n${body}\n  }\n  other() {\n    return 1;\n  }\n}\n${after}`;
  test.each([
    ["its body changed", storeClass("    this.write(id, 0);")],
    ["a second method of the same name", storeClass("    this.write(id, usage);").replace("  other() {", "  recordUsage(id) {\n    return;\n  }\n  other() {")],
    ["the method replaced on the prototype", storeClass("    this.write(id, usage);", "Store.prototype.recordUsage = function () {};\n")],
    ["the method redefined by name", storeClass("    this.write(id, usage);", "Object.defineProperty(Store.prototype, \"recordUsage\", { value() {} });\n")],
    ["the class gone", "export function recordUsage() {}\n"],
  ])("a pinned Store method with %s: a person approves", (_name, text) => {
    const f = open({ files: { "src/store.ts": storeClass("    this.write(id, usage);") }, candidate: { "src/store.ts": text } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("Store#recordUsage") });
  });

  // PR #263 security scan: a pinned Store method rewritten from ANY changed file, however it is reached, needs a person.
  test.each([
    ["assigned on the prototype", "Store.prototype.settleRunSpend = () => undefined;"],
    ["defined on the prototype", "Object.defineProperty(Store.prototype, \"settleRunSpend\", { value() {} });"],
    ["set through Reflect on the instance's prototype", "Reflect.set(Object.getPrototypeOf(store), \"fixRunBilling\", () => undefined);"],
    ["set through Reflect under a computed key", "const key = \"record\" + \"Usage\";\nReflect.set(target, key, () => undefined);"],
    ["written on the store under a computed key", "store[\"finalize\" + \"ChatTurn\"] = () => true;"],
    ["shadowed on the instance", "store.recordUsage = () => undefined;"],
    ["copied onto the store", "Object.assign(store, { recordUsage() {} });"],
    ["the store's prototype swapped", "Object.setPrototypeOf(store, {});"],
    ["reached through __proto__", "const proto = store.__proto__;"],
    // The owner's blunt rule (2026-10-31): computed writes and members, computed reads of Object, Reflect, globalThis or a
    // store, any reflective name or `.constructor`, and an `extends` that isn't a plain identifier.
    ["written through any computed key", "target[key] = () => undefined;"],
    ["declared as a computed class member", "return class { [key]() {} };"],
    ["read off Object under a computed key", "const tool = Object[key];"],
    ["replaced by a conditionally chosen subclass", "return class extends (key ? Store : Object) {};"],
    ["reached through .constructor", "const methods = store.constructor;"],
    // Security scan round 2: renamed or wrapped tools, a subclass, and a member of a pinned name.
    ["defined through a destructured, renamed defineProperty", "const { defineProperty: d } = Object;\nd(target, key, { value() {} });"],
    ["set through an alias of Reflect", "const R = Reflect;\nR.set(target, key, () => undefined);"],
    ["wrapped in a Proxy", "return new Proxy(store, { get: (t, k) => (k === key ? () => undefined : t[k]) });"],
    ["replaced by a subclass", "class Quiet extends Store {}\nreturn Quiet;"],
    ["shadowed by an object member of a pinned name", "return { ...store, settleRunSpend() {} };"],
  ])("a pinned Store method %s from another file: a person approves", (_name, code) => {
    const f = open({ candidate: { "src/hijack.ts": `export function hijack(store, target, key, Store) {\n${code}\n}\n` } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("src/hijack.ts adds") });
  });

  // PR #263 review: what invokeAgent passes as the run's billing basis and its unknown cost is held as the base has it.
  const invoke = (basis: string, unknown: string) => `import { takeEvalDispatch } from "./eval-gate.js";\nimport { recordRunBillingBasis, recordRunCostUnknown } from "./store.js";\n`
    + `export async function invokeAgent(store, runId, envelope, evidence) {\n  takeEvalDispatch("run");\n  recordRunBillingBasis(store, runId, ${basis});\n  recordRunCostUnknown(store, runId, ${unknown});\n}\n`;
  const BASIS = `evidence !== null ? "evidence" : "default"`, UNKNOWN = "envelope.costUnknown === true";
  test.each([
    ["a billing basis that always reads as known", invoke(`"evidence"`, UNKNOWN), "recordRunBillingBasis"],
    ["an unknown cost never recorded", invoke(BASIS, "false"), "recordRunCostUnknown"],
    ["the unknown cost's call removed", invoke(BASIS, UNKNOWN).replace(`  recordRunCostUnknown(store, runId, ${UNKNOWN});\n`, ""), "recordRunCostUnknown"],
  ])("invokeAgent with %s: a person approves", (_name, text, named) => {
    const f = open({ files: { "src/invoke.ts": invoke(BASIS, UNKNOWN) }, candidate: { "src/invoke.ts": text } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining(named) });
  });

  test("an enforcement hook kept in place ships with the change around it", () => {
    const f = open({ files: { "src/converse.ts": leadRequest("  takeEvalDispatch(`lead`);") }, candidate: { "src/converse.ts": leadRequest("  takeEvalDispatch(`lead`);\n  const more = 2;") } });
    authorize(f);
    const sealed = seal(f, check(f));
    expect(sealed.ok ? "" : sealed.why).toBe("");
  });

  test("a version bump of package.json and the lockfile, product code, its tests and docs ship", () => {
    const f = open({ candidate: { "package.json": pkg("0.9.72"), "package-lock.json": lock("0.9.72"), "src/index.js": "export const answer = 44;\n", "src/index.test.ts": "test('answer', () => {});\ntest('more', () => {});\n", "docs/guide.md": "# Guide 3\n", "CHANGELOG.md": "## 0.9.72\n" } });
    authorize(f);
    const sealed = seal(f, check(f));
    expect(sealed.ok ? "" : sealed.why).toBe("");
  });
});
