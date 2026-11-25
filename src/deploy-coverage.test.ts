/**
 * A release from main's deploy check, as the plane seals and the deploy gates read it (docs/plans/release-from-main.md,
 * part C): coverage `deploy` only for a scope sealed as a release from main with the deploy check and only with a whole
 * result; the deploy gates accept it only when the coordinator's proof of exactly the approved commit was recorded
 * after the approval; a branch release never deploys on it.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { recordRunCheckLevel } from "./check-levels.js";
import { CHECK_INVENTORY_CAPTURE, CHECK_REPORT_CAPTURE, deployCheckProblem, prepareCheckAttempt, sealCheckOutcome } from "./check-report.js";
import type { CheckReport } from "./contracts/release-check.js";
import { deploymentGate } from "./deploy-gate.js";
import { storeEvidence } from "./evidence.js";
import { releaseCheckPurposeFor } from "./release-carry.js";
import { MAIN_PROOF_VALID_MS, mainReleaseProofProblem, recordMainReleaseProof, recordMainReleaseProofFailure } from "./release-main-proof.js";
import { settleCoverage } from "./release-recheck.js";
import { approve, propose } from "./scope.js";
import { effectiveCheckFacts, sealVerificationReceipt, verificationEvidence } from "./verification-evidence.js";
import { builtRun, EVIDENCE, RELEASE_NOW, releaseFixture, VERSION, type ReleaseFixture } from "../test/release-fixture.js";
import { mainReleaseProofProblem as candidateRule } from "../scripts/deploy-candidate.mjs";
import { DEPLOY_PART_NAMES, parseHandshake } from "../scripts/release-check.mjs";

let f: ReleaseFixture | undefined;
afterEach(() => { f?.close(); f = undefined; });

const LATER = new Date(RELEASE_NOW.getTime() + 60_000), EARLIER = new Date(RELEASE_NOW.getTime() - 60_000);
const deployParts = (overrides: Partial<Record<string, Partial<CheckReport["parts"][number]>>> = {}) =>
  DEPLOY_PART_NAMES.map(part => ({ part: part as CheckReport["parts"][number]["part"], selected: part !== "upgrade", ran: part !== "upgrade", code: part === "upgrade" ? null : 0, timedOut: false, ...overrides[part] }));

/** The fixture's release task, sealed as a release from main (or, `kind: "branch"`, a branch release's purpose). */
function mainRelease(kind: "main" | "branch" = "main") {
  f = releaseFixture({ termsless: true, approve: false });
  const g = f;
  const purpose = releaseCheckPurposeFor(g.store, { repo: g.repo, version: VERSION, branch: `release-${VERSION}`, pr: 240, candidate: g.approved, ...(kind === "main" ? { main: { check: "deploy" as const } } : {}) });
  if (!purpose.ok) throw new Error(purpose.why);
  const scope = propose(g.store, { taskId: g.taskId, goal: `Release ${VERSION} from main`, candidate: g.approved, acceptance: [{ id: "c1", statement: "The deploy check passes", how: null, evidence: ["check"] }], releaseCheck: purpose.purpose, now: RELEASE_NOW });
  const yes = approve(g.store, g.taskId, "alex", RELEASE_NOW, scope.digest, g.password);
  if (!yes.ok) throw new Error(yes.reason);
  return purpose.purpose;
}

/** One deploy check of the release task's build, sealed as the builder seals it. */
function sealedDeployCheck(parts = deployParts(), exitCode = 0) {
  const f = fixture();
  const store = f.store, root = EVIDENCE(f);
  const runId = builtRun(store, f.taskId, f.approved);
  recordRunCheckLevel(store, { id: runId, taskId: f.taskId, repo: f.repo }, "full", "project", RELEASE_NOW);
  const command = store.liveVerifyCommand(f.repo)!;
  const prepared = prepareCheckAttempt(store, root, { runId, repo: f.repo, head: f.approved, command, access: "unsandboxed", authority: null, watch: [], release: true, deploy: { copy: "/private/tmp/copy/orders.db" } }, RELEASE_NOW)!;
  expect(prepared.mode).toBe("deploy");
  expect(JSON.parse(prepared.stdin)).toMatchObject({ mode: "deploy", copy: "/private/tmp/copy/orders.db", plan: null });
  const report = { version: 1, nonce: prepared.nonce, mode: "deploy", planDigest: null, exitCode, parts, units: null, journeys: [], upgrades: null };
  sealCheckOutcome(store, root, prepared, { stdout: `TOOLROLL_CHECK_REPORT ${JSON.stringify(report)}\n`, exitCode }, RELEASE_NOW);
  const settled = settleCoverage(store, root, { runId, taskId: f.taskId, exitCode, now: RELEASE_NOW }, run => { const gate = verificationEvidence(store, root, run); return gate.ok ? gate.digest : null; });
  storeEvidence(store, root, runId, "check-log", "check-log.txt", Buffer.from(`exit ${exitCode}\n`), command.command, RELEASE_NOW, { captureStatus: "ok" });
  const sha = (capture: string) => store.artifactsFor(runId).find(a => a.kind === "structured-output" && a.capture === capture)?.sha256 ?? null;
  const effective = effectiveCheckFacts({ configured: true, ran: true, exitCode }, { coverage: settled.coverage, check: { attempt: "full", report: sha(CHECK_REPORT_CAPTURE), inventory: sha(CHECK_INVENTORY_CAPTURE), retried: [] }, composed: settled.composed });
  sealVerificationReceipt(store, root, runId, f.approved, command, effective.result, RELEASE_NOW, undefined, effective.facts ?? undefined);
  return { runId, coverage: settled.coverage, receipt: verificationEvidence(store, root, runId) };
}

const fixture = (): ReleaseFixture => { if (f === undefined) throw new Error("no fixture"); return f; };
const proof = (sha: string, tree: string) => ({ sha, tree, pr: 240, head: "d".repeat(40), branch: `release-${VERSION}` });

describe("the deploy check's coverage", () => {
  test("a release from main sealed with the deploy check: coverage `deploy`, and its receipt verifies", () => {
    mainRelease();
    const sealed = sealedDeployCheck();
    expect(sealed.coverage).toBe("deploy");
    expect(sealed.receipt.ok).toBe(true);
  });

  test("a deploy check that skipped its rehearsal, or a branch release's scope, has no result", () => {
    mainRelease();
    expect(sealedDeployCheck(deployParts({ rehearsal: { selected: false, ran: false, code: null } })).coverage).toBe("no-result");
    fixture().close(); f = undefined;
    mainRelease("branch");
    expect(sealedDeployCheck().coverage).toBe("no-result");
  });

  test("the deploy gates accept it only with the coordinator's proof of exactly the approved commit, made after the approval", () => {
    const purpose = mainRelease();
    const f = fixture();
    const { runId } = sealedDeployCheck();
    const gate = () => deploymentGate(f.store, { runId, evidenceRoot: EVIDENCE(f), now: LATER });
    const scope = () => f.store.getScope(f.taskId);
    // No proof recorded: refused, by both gates.
    expect(gate()).toMatchObject({ ok: false, message: expect.stringMatching(/deploys a release from main alone: the release commit's proof isn't recorded/) });
    expect(candidateRule(f.store, f.taskId, scope(), LATER)).toMatch(/proof isn't recorded/);
    // A proof from before the approval, or of another commit: refused.
    recordMainReleaseProof(f.store, { taskId: f.taskId, version: VERSION, proof: proof(f.approved, purpose.approvedTree), now: EARLIER });
    expect(mainReleaseProofProblem(f.store, f.taskId, scope(), LATER)).toMatch(/wasn't proven since it was approved/);
    recordMainReleaseProof(f.store, { taskId: f.taskId, version: VERSION, proof: proof("e".repeat(40), purpose.approvedTree), now: LATER });
    expect(mainReleaseProofProblem(f.store, f.taskId, scope(), LATER)).toMatch(/another release commit/);
    expect(candidateRule(f.store, f.taskId, scope(), LATER)).toMatch(/another release commit/);
    // The approved commit, proven after the approval: the deploy check's coverage stands (the gate goes on to completion).
    recordMainReleaseProof(f.store, { taskId: f.taskId, version: VERSION, proof: proof(f.approved, purpose.approvedTree), now: LATER });
    expect(mainReleaseProofProblem(f.store, f.taskId, scope(), LATER)).toBeNull();
    expect(candidateRule(f.store, f.taskId, scope(), LATER)).toBeNull();
    expect(gate()).toMatchObject({ ok: false, message: expect.stringMatching(/not marked this exact result complete/) });
    // A proof stands 30 minutes; after that (a direct deploy later on) both gates refuse it.
    const STALE = new Date(LATER.getTime() + MAIN_PROOF_VALID_MS + 1);
    expect(mainReleaseProofProblem(f.store, f.taskId, scope(), STALE)).toMatch(/older than 30 minutes/);
    expect(candidateRule(f.store, f.taskId, scope(), STALE)).toMatch(/older than 30 minutes/);
    expect(deploymentGate(f.store, { runId, evidenceRoot: EVIDENCE(f), now: STALE })).toMatchObject({ ok: false, message: expect.stringMatching(/older than 30 minutes/) });
    // Exactly 30 minutes is already too old, and a clock set back (a negative age) never extends it.
    const EDGE = new Date(LATER.getTime() + MAIN_PROOF_VALID_MS), BACK = new Date(LATER.getTime() - 1000);
    for (const at of [EDGE, BACK]) {
      expect(mainReleaseProofProblem(f.store, f.taskId, scope(), at)).toMatch(/older than 30 minutes/);
      expect(candidateRule(f.store, f.taskId, scope(), at)).toMatch(/older than 30 minutes/);
    }
    // A failed re-proof (a newer CI attempt failed, M left main) makes the earlier proof unusable at once.
    recordMainReleaseProofFailure(f.store, { taskId: f.taskId, version: VERSION, why: "node 24 · macos-latest: failure", now: LATER });
    expect(mainReleaseProofProblem(f.store, f.taskId, scope(), LATER)).toMatch(/last proof failed \(node 24/);
    expect(candidateRule(f.store, f.taskId, scope(), LATER)).toMatch(/last proof failed/);
    expect(gate()).toMatchObject({ ok: false, message: expect.stringMatching(/last proof failed/) });
    // Only a fresh proof, after it, stands again.
    recordMainReleaseProof(f.store, { taskId: f.taskId, version: VERSION, proof: proof(f.approved, purpose.approvedTree), now: LATER });
    expect(mainReleaseProofProblem(f.store, f.taskId, scope(), LATER)).toBeNull();
  });

  test("a branch release never deploys on a deploy check's coverage", () => {
    mainRelease("branch");
    const f = fixture();
    expect(mainReleaseProofProblem(f.store, f.taskId, f.store.getScope(f.taskId), LATER)).toMatch(/only a release from main/);
    expect(candidateRule(f.store, f.taskId, f.store.getScope(f.taskId), LATER)).toMatch(/only a release from main/);
  });
});

describe("the deploy check's report and handshake", () => {
  const nonce = createHash("sha256").update("n").digest("hex");
  const sealed = (deploy: boolean, parts: string[] = ["build", "rehearsal"]) => ({ version: 1 as const, sealed: { version: 1 as const, units: [], parts: parts as never, release: true, ...(deploy ? { deploy: true as const } : {}) }, declared: { groups: [], versions: [] } });
  const report = (parts = deployParts(), mode: "deploy" | "full" = "deploy") => ({ version: 1 as const, nonce, mode, planDigest: null, exitCode: 0, parts, units: null, journeys: [], upgrades: null });

  test("deployCheckProblem: every owed part ran and passed, in deploy mode, sealed as a deploy check", () => {
    expect(deployCheckProblem({ report: report(), inventory: sealed(true), exitCode: 0 })).toBeNull();
    expect(deployCheckProblem({ report: report(), inventory: sealed(false), exitCode: 0 })).toMatch(/wasn't sealed as a deploy check/);
    expect(deployCheckProblem({ report: report(deployParts(), "full"), inventory: sealed(true), exitCode: 0 })).toMatch(/not the deploy check/);
    expect(deployCheckProblem({ report: report(deployParts({ rehearsal: { code: 1 } })), inventory: sealed(true), exitCode: 0 })).toMatch(/rehearsal exited 1/);
    expect(deployCheckProblem({ report: report(), inventory: sealed(true, ["build", "rehearsal", "upgrade"]), exitCode: 0 })).toMatch(/owed the upgrade/);
    expect(deployCheckProblem({ report: report(), inventory: sealed(true), exitCode: null })).toMatch(/didn't end on its own/);
  });

  test("parseHandshake: a deploy handshake names the plane's copy and no plan; a full one never owes the rehearsal", () => {
    const base = { nonce, plan: null, watch: [], owed: ["build", "rehearsal"] };
    expect(parseHandshake(JSON.stringify({ ...base, mode: "deploy", copy: "/private/tmp/x/orders.db" }))).toMatchObject({ mode: "deploy", copy: "/private/tmp/x/orders.db" });
    expect(parseHandshake(JSON.stringify({ ...base, mode: "deploy" }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ ...base, mode: "deploy", copy: "relative/orders.db" }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ ...base, mode: "full" }))).toBeNull();
  });
});
