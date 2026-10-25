/**
 * Re-running only what failed (docs/plans/release-once.md, part 2, attacks 15–23): accidental damage can't make a
 * targeted check pass; every outcome has a disposition; obligations are immutable; a removed or newly skipped required
 * test asks again; coverage is conserved; a partial result never passes; every link of a composed receipt is proved
 * again; and a targeted run is never a base. Releases are real (a real repository and a person's approval), checks are
 * sealed exactly as the builder seals them. Coverage trusts test code (Alex's decision): these are accidents, not a
 * hostile test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { proveCarry } from "../../src/release-carry.js";
import { requiredSet, coverageOf } from "../../src/release-recheck.js";
import { verificationEvidence } from "../../src/verification-evidence.js";
import { join } from "node:path";
const readEvidencePath = (root: string, artifact: { key: string }) => join(root, artifact.key);
import type { CheckReport } from "../../src/contracts/release-check.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const UNITS = ["src/browser/app.test.ts", "src/index.test.ts", "test/attacks/fence.test.ts"];
const allPass = () => reportOf(UNITS.map(file => ({ file })));
/** A release whose full check A failed `answer` in src/index.test.ts, and a carried test-only commit B. */
async function failedThenCarried(change: Record<string, string> = { "docs/guide.md": "# Guide\nfixed\n" }) {
  const f = (fixture = releaseFixture());
  const a = sealedCheck(f, f.taskId, f.approved, () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file })));
  expect(a.coverage).toBe("full");
  const to = f.commit(change);
  const carried = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
  if (!carried.ok) throw new Error(carried.message);
  return { f, a, to, task: carried.taskId };
}
/** The targeted report that runs exactly the plan and passes it (each required identity passes). */
const passingPlan = (plan: { units: string[]; sanity: string[]; required: string[] } | null, extra: Partial<Record<string, UnitOutcomeExtra>> = {}): Omit<CheckReport, "nonce" | "mode" | "planDigest"> => {
  const files = [...new Set([...(plan?.units ?? []), ...(plan?.sanity ?? [])])];
  return reportOf(files.map(file => ({ file, passed: (plan?.required ?? []).filter(id => id.startsWith(`unit:${file}::`)).map(id => id.slice(`unit:${file}::`.length)), ...(extra[file] ?? {}) })));
};
type UnitOutcomeExtra = { failed?: string[]; skipped?: string[]; passed?: string[]; state?: "passed" | "failed" | "skipped" };

describe("attack 16: every outcome at A has a disposition", () => {
  const inventory = (units = UNITS) => ({ version: 1 as const, sealed: { version: 1 as const, units, parts: [] }, declared: { groups: [], versions: [] } });
  const at = (report: ReturnType<typeof reportOf>) => requiredSet({ report: { ...report, nonce: "a".repeat(64), mode: "full", planDigest: null } as CheckReport, inventory: inventory() });
  test("units: failed re-runs the file with each failed identity required; flaky re-runs the file; skipped may stay; not run or unattributed re-runs the part", () => {
    const failed = at(reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file })));
    expect(failed).toMatchObject({ full: null, units: ["src/index.test.ts"], required: ["unit:src/index.test.ts::answer"], parts: [] });
    const flaky = at(reportOf(UNITS.map(file => ({ file, flaky: file === "src/index.test.ts" }))));
    expect(flaky.units).toEqual(["src/index.test.ts"]);
    const skipped = at(reportOf(UNITS.map(file => ({ file, skipped: file === "src/index.test.ts" ? ["later"] : [] }))));
    expect(skipped).toMatchObject({ units: [], skipped: ["unit:src/index.test.ts::later"] });
    expect(at(reportOf(UNITS.slice(1).map(file => ({ file })))).parts).toEqual(["unit"]);
    for (const units of [{ reusedFromCI: false, finished: false, runErrors: 0, files: [], identities: [] }, { reusedFromCI: false, finished: true, runErrors: 2, files: [], identities: [] }, null])
      expect(at(reportOf([], { units })).parts).toEqual(["unit"]);
    // A file that failed to load has no failed identity: the file itself must pass.
    expect(at(reportOf(UNITS.map(file => ({ file, state: file === "src/index.test.ts" ? "failed" : "passed" })))).required).toEqual(["file:src/index.test.ts"]);
  });

  test("journeys: a failed, retried or unattributed group re-runs whole; a not-run group or an unfinished run re-runs the part", () => {
    const parts = reportOf([]).parts.map(one => one.part === "app" ? { ...one, selected: true, ran: true, code: 1 } : one);
    const journeys = (groups: CheckReport["journeys"][number]["groups"], finished = true) => reportOf(UNITS.map(file => ({ file })), { parts, journeys: [{ script: "app", kind: "scripted", finished, groups }] });
    const g = (group: string, state: "passed" | "failed" | "not-run", more: Partial<CheckReport["journeys"][number]["groups"][number]> = {}) => ({ group, state, retried: false, unattributed: false, journeys: [], ...more });
    expect(at(journeys([g("alpha", "failed", { journeys: [{ name: "opens", state: "failed" }] }), g("beta", "passed")])))
      .toMatchObject({ groups: [{ script: "app", kind: "scripted", groups: ["alpha"] }], required: expect.arrayContaining(["group:app:scripted:alpha", "journey:app:scripted:alpha::opens"]) });
    expect(at(journeys([g("alpha", "passed", { retried: true })])).groups[0]?.groups).toEqual(["alpha"]);
    expect(at(journeys([g("alpha", "failed", { unattributed: true })])).groups[0]?.groups).toEqual(["alpha"]);
    expect(at(journeys([g("alpha", "not-run")])).parts).toEqual(["app"]);
    expect(at(journeys([g("alpha", "passed")], false)).parts).toEqual(["app"]);
  });

  test("upgrades: a failed or not-run version re-runs; an unfinished run re-runs the part; a failed typecheck or build means a full check", () => {
    const parts = reportOf([]).parts.map(one => one.part === "upgrade" ? { ...one, selected: true, ran: true, code: 1 } : one);
    expect(at(reportOf(UNITS.map(file => ({ file })), { parts, upgrades: { finished: true, versions: [{ version: "0.9.1", state: "failed" }, { version: "0.9.2", state: "passed" }, { version: "0.9.3", state: "not-run" }] } })))
      .toMatchObject({ versions: ["0.9.1", "0.9.3"], required: expect.arrayContaining(["upgrade:0.9.1", "upgrade:0.9.3"]) });
    expect(at(reportOf(UNITS.map(file => ({ file })), { parts, upgrades: { finished: false, versions: [] } })).parts).toEqual(["upgrade"]);
    for (const failed of ["typecheck", "build"]) {
      const broken = reportOf([]).parts.map(one => one.part === failed ? { ...one, code: 2 } : one);
      expect(at(reportOf(UNITS.map(file => ({ file })), { parts: broken })).full).toContain(failed);
    }
  });
});

describe("a targeted check, through the real road", () => {
  test("B runs only what A failed, the tests changed since A and the sanity pass, and composes with A", async () => {
    const { f, a, to, task } = await failedThenCarried({ "src/browser/app.test.ts": "test('app', () => {});\ntest('more', () => {});\n" });
    const b = sealedCheck(f, task, to, plan => passingPlan(plan));
    expect(b.decision).toMatchObject({ mode: "targeted", plan: { base: a.runId, units: ["src/browser/app.test.ts", "src/index.test.ts"], required: ["unit:src/index.test.ts::answer"] } });
    expect(b.coverage).toBe("composed");
    const gate = verificationEvidence(f.store, EVIDENCE(f), b.runId);
    expect(gate.ok, gate.ok ? "" : gate.problem).toBe(true);
    expect(JSON.parse(gate.ok ? gate.bytes! : "{}")).toMatchObject({ version: 3, coverage: "composed", composed: { base: a.runId } });
  }, 120_000);

  // Attack 17.
  test("immutable obligations: A fails X, B passes X without changing it, C changes another file — C runs X again; later rows don't change B", async () => {
    const { f, to, task } = await failedThenCarried();
    const b = sealedCheck(f, task, to, plan => passingPlan(plan));
    expect(b.coverage).toBe("composed");
    const c = f.commit({ "src/browser/app.test.ts": "test('app', () => {});\ntest('again', () => {});\n" });
    const carried = await proveCarry(f.store, { authority: f.authority().id, to: c, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    const third = sealedCheck(f, carried.taskId, c, plan => passingPlan(plan));
    expect(third.decision).toMatchObject({ mode: "targeted", plan: { units: expect.arrayContaining(["src/index.test.ts", "src/browser/app.test.ts"]), required: expect.arrayContaining(["unit:src/index.test.ts::answer"]) } });
    // B's own revalidation reads its sealed plan and snapshot, never the newer rows.
    expect(verificationEvidence(f.store, EVIDENCE(f), b.runId).ok).toBe(true);
  }, 120_000);

  // Attack 18.
  test.each(["deleted", "renamed", "newly skipped"] as const)("a required identity %s asks again: the release stops carrying", async how => {
    const { f, to, task } = await failedThenCarried();
    const b = sealedCheck(f, task, to, plan => passingPlan(plan, {
      "src/index.test.ts": how === "deleted" ? { passed: ["other"] } : how === "renamed" ? { passed: ["answer (renamed)"] } : { skipped: ["answer"] },
    }));
    expect(b.coverage).toBe("identity-removed");
    expect(f.authority()).toMatchObject({ state: "revoked", endedBy: expect.stringContaining("removed or skipped") });
  }, 120_000);

  test("a required identity missing from the full check that follows a partial attempt also asks again", async () => {
    const { f, to, task } = await failedThenCarried();
    const lost = sealedCheck(f, task, to, () => null);
    expect(lost.coverage).toBe("partial");
    const again = sealedCheck(f, task, to, () => reportOf(UNITS.map(file => ({ file, ...(file === "src/index.test.ts" ? { passed: ["something else"] } : {}) }))), { forceFull: true });
    expect(again.decision.watch).toContain("unit:src/index.test.ts::answer");
    expect(again.coverage).toBe("identity-removed");
  }, 120_000);

  // Attack 19.
  test("coverage conservation: a test file B's inventory holds, with neither a pass at A nor at B, leaves the result partial", async () => {
    const { f, to, task } = await failedThenCarried({ "src/extra.test.ts": "test('extra', () => {});\n" });
    const b = sealedCheck(f, task, to, plan => passingPlan({ units: (plan?.units ?? []).filter(file => file !== "src/extra.test.ts"), sanity: plan?.sanity ?? [], required: plan?.required ?? [] }));
    expect(b.coverage).toBe("partial");
  }, 120_000);

  // Attack 20.
  test("partial never passes: targeted, exit 0, report lost", async () => {
    const { f, to, task } = await failedThenCarried();
    const b = sealedCheck(f, task, to, () => null);
    expect(b.coverage).toBe("partial");
    const gate = verificationEvidence(f.store, EVIDENCE(f), b.runId);
    expect(gate.ok && JSON.parse(gate.bytes!).coverage).toBe("partial");
  }, 120_000);

  // Attack 15 (the plane's side): a stale results file in the checkout and a look-alike line change nothing.
  test("accidental damage: a stale report file in the checkout and a look-alike report line are ignored", async () => {
    const { f, to, task } = await failedThenCarried();
    writeFileSync(`${f.repo}/report.json`, JSON.stringify({ results: [{ name: "answer", state: "passed" }] }));
    const b = sealedCheck(f, task, to, () => null);
    expect(b.coverage).toBe("partial");
  }, 120_000);

  // Attack 21.
  test.each(["A's receipt", "the report", "the plan", "the snapshot", "the artifacts", "the generation", "the grant"] as const)("receipt version 3: breaking %s makes every reader refuse", async link => {
    const { f, a, to, task } = await failedThenCarried();
    const b = sealedCheck(f, task, to, plan => passingPlan(plan));
    expect(b.coverage).toBe("composed");
    const root = EVIDENCE(f), db = f.store.handle;
    const artifact = (run: number, capture: string) => f.store.artifactsFor(run).find(one => one.capture === capture)!;
    const tamper = (run: number, capture: string) => { const path = readEvidencePath(root, artifact(run, capture)); writeFileSync(path, `${readFileSync(path, "utf8")} `); };
    if (link === "A's receipt") tamper(a.runId, "machine verification receipt v1");
    if (link === "the report") tamper(b.runId, "release check report v1");
    if (link === "the plan") tamper(b.runId, "release check targeted plan v1");
    if (link === "the snapshot") tamper(b.runId, "release check obligation snapshot v1");
    if (link === "the artifacts") db.prepare("UPDATE release_authority SET artifact_digest = 'other'").run();
    if (link === "the generation") db.prepare("UPDATE release_check_attempt SET authority = NULL WHERE run = ?").run(a.runId);
    if (link === "the grant") f.store.setVerifyCommand({ repo: f.repo, command: "node scripts/other.mjs", timeoutMs: 60_000, approvedBy: "alex" }, RELEASE_NOW);
    expect(verificationEvidence(f.store, root, b.runId).ok).toBe(false);
  }, 120_000);

  // Attack 22.
  test("no borrowed coverage: a targeted run is never a base, and a base that reused CI results isn't one", async () => {
    const { f, a, to, task } = await failedThenCarried();
    sealedCheck(f, task, to, plan => passingPlan(plan));
    const c = f.commit({ "docs/guide.md": "# Guide\nagain\n" });
    const carried = await proveCarry(f.store, { authority: f.authority().id, to: c, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    const third = sealedCheck(f, carried.taskId, c, plan => passingPlan(plan));
    expect(third.decision).toMatchObject({ mode: "targeted", plan: { base: a.runId } });
    fixture?.close();
    const g = (fixture = releaseFixture());
    sealedCheck(g, g.taskId, g.approved, () => ({ ...reportOf(UNITS.map(file => ({ file }))), units: { reusedFromCI: true, finished: true, runErrors: 0, files: [], identities: [] } }));
    const d = g.commit({ "docs/guide.md": "# x\n" });
    const dc = await proveCarry(g.store, { authority: g.authority().id, to: d, now: LATER });
    if (!dc.ok) throw new Error(dc.message);
    expect(sealedCheck(g, dc.taskId, d, () => allPass()).decision).toMatchObject({ mode: "full", why: expect.stringContaining("reused CI") });
  }, 120_000);

  test("an open main-check failure refuses targeted planning", async () => {
    const { f, to, task } = await failedThenCarried();
    f.store.handle.prepare("INSERT INTO main_check_failure (repo, sha, run, item, opened_at) VALUES (?, ?, 1, 'unit:src/x.test.ts::y', ?)").run(f.repo, f.approved, RELEASE_NOW.toISOString());
    expect(sealedCheck(f, task, to, () => allPass()).decision).toMatchObject({ mode: "full", why: expect.stringContaining("nightly") });
  }, 120_000);

  test("coverageOf is a pure function of sealed values: the plan must hold every obligation", () => {
    const report = { ...reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file })), nonce: "a".repeat(64), mode: "full", planDigest: null } as CheckReport;
    const inventory = { version: 1 as const, sealed: { version: 1 as const, units: UNITS, parts: [] }, declared: { groups: [], versions: [] } };
    const plan = { version: 1 as const, base: 1, units: [], sanity: [], groups: [], versions: [], parts: [], required: [] };
    expect(coverageOf({ a: { report, inventory }, b: { report: null, inventory, exitCode: 0 }, plan, snapshot: { version: 1, authority: 1, base: 1, earlier: [] } })).toBe("partial");
  });
});

describe("security review: a partial or identity-removed check never reads as passed anywhere", () => {
  const partial = async () => {
    const { f, to, task } = await failedThenCarried();
    // Exit 0, report lost: the command "passed", the coverage didn't.
    const b = sealedCheck(f, task, to, () => null);
    expect(b.coverage).toBe("partial");
    return { f, b, to, task };
  };

  test("the receipt's result is a failed attempt (so reuse, follow-ups and the verdict read a failure), with the raw exit kept apart", async () => {
    const { f, b } = await partial();
    const gate = verificationEvidence(f.store, EVIDENCE(f), b.runId);
    if (!gate.ok || gate.bytes === null) throw new Error("no gate");
    const receipt = JSON.parse(gate.bytes);
    expect(receipt.result).toEqual({ configured: true, ran: false, attemptFailed: true, failure: "coverage-incomplete" });
    expect(receipt.check.exitCode).toBe(1);
    // What reuseObservationVerification and build-review's checkPassed ask:
    expect(receipt.result.ran === true && receipt.result.exitCode === 0).toBe(false);
  }, 120_000);

  test("a receipt forged to read passed with coverage partial is refused by its reader", async () => {
    const { f, b } = await partial();
    const artifact = f.store.artifactsFor(b.runId).find(one => one.capture === "machine verification receipt v1")!;
    const path = join(EVIDENCE(f), artifact.key);
    const forged = readFileSync(path, "utf8").replace(/"result": \{[^}]*\}/, '"result": {\n  "configured": true,\n  "ran": true,\n  "exitCode": 0\n }');
    writeFileSync(path, forged);
    const { createHash } = await import("node:crypto");
    f.store.handle.prepare("UPDATE artifact SET sha256 = ?, bytes_stored = ?, bytes_original = ? WHERE id = ?").run(createHash("sha256").update(forged).digest("hex"), Buffer.byteLength(forged), Buffer.byteLength(forged), artifact.id);
    expect(verificationEvidence(f.store, EVIDENCE(f), b.runId)).toMatchObject({ ok: false, problem: expect.stringContaining("coverage fell short") });
  }, 120_000);

  test("the deploy gates, the run's check, the assignment's checks and release coverage all read it as failed", async () => {
    const { f, b, to, task } = await partial();
    const { deploymentGate } = await import("../../src/deploy-gate.js");
    // @ts-expect-error plain ESM script without declarations
    const { deploymentCandidate } = await import("../../scripts/deploy-candidate.mjs");
    const installedScope = await import("../../src/scope.js");
    const { assignmentOf } = await import("../../src/assignment.js");
    const { releaseCoverageOf } = await import("../../src/release-coverage.js");
    const gate = deploymentGate(f.store, { runId: b.runId, evidenceRoot: EVIDENCE(f), now: LATER });
    expect(gate).toMatchObject({ ok: false });
    expect(() => deploymentCandidate(f.store, { runId: b.runId, head: to, evidenceRoot: EVIDENCE(f), now: LATER }, { assignmentOf, verificationEvidence, installedScope })).toThrow();
    expect(f.store.handle.prepare("SELECT status FROM run_check WHERE run = ?").get(b.runId)?.["status"]).toBe("failed");
    const assignment = assignmentOf(f.store, task, LATER, { principal: "operator", repos: null, includeUnplaced: true }, EVIDENCE(f));
    expect(assignment?.receipt?.checks?.status ?? "failed").not.toBe("passed");
    expect(releaseCoverageOf(f.store, EVIDENCE(f), f.repo, to, { isAncestor: () => true })).toBeNull();
  }, 120_000);
});
