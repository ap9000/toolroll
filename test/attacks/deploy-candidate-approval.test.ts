/**
 * Attack: a candidate ships a dist/scope.js whose personApprovalOf says yes, so the code being deployed would decide
 * whether its own deployment is authorized. Guard: the deployment gate (scripts/deploy-candidate.mjs) takes the person
 * check from the INSTALLED runtime's scope.js, or reads the plane's records itself when that runtime predates it; the
 * deploy scripts never load scope.js from the candidate. A lead-sealed candidate is refused either way, and a person's
 * approval still deploys.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { openStore, type Store } from "../../src/store.js";
import { APPROVAL_PROOF, addApprover, approvalProofDetail, personApprovalOf, propose } from "../../src/scope.js";
import { noteCiRunning } from "../../src/release-ci-hold.js";
import { liftCiHold } from "../../src/release-auto.js";
import { REQUIRED_PR_CHECKS, REQUIRED_PR_CHECKS_WORKFLOW } from "../../src/release.js";
import { deploymentGate } from "../../src/deploy-gate.js";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../../scripts/deploy-candidate.mjs";
import { useScratch } from "./harness.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const REPO = "/repo/deploy-attack";
const HEAD = "a".repeat(40);
const ROOT = resolve(import.meta.dirname, "../..");

/** A built candidate whose scope was sealed through the person's road with the proof the act really left. */
function candidate(store: Store, id: string, proof: string): number {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, NOW);
  propose(store, { taskId: id, goal: id, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "works", how: null, evidence: ["check"] }], now: NOW });
  expect(store.sealScopeApproval(id, "alex", NOW)).toBe(true);
  store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: id, runId: null, action: APPROVAL_PROOF, outcome: proof, source: "work",
    detail: approvalProofDetail(NOW.getTime(), 1, store.getScope(id)!.digest) });
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "r", branch: "b", worktree: "/w", route: authority.stamp, now: NOW });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: HEAD, handoff: "done" });
  store.finishRun(run, { outcome: "built", committed: true, now: NOW });
  return run;
}

describe("attack: the candidate's own scope.js approves its deployment", () => {
  const scratch = useScratch("deploy-approval");

  test("a person's early approval cannot bypass pending CI through either deployment gate, even without release terms", () => {
    const store = openStore(join(scratch(), "orders.db"));
    try {
      expect(addApprover(store, "alex", NOW).ok).toBe(true);
      for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
      const runId = candidate(store, "early-approval", "password-now");
      noteCiRunning(store, { taskId: "early-approval", candidate: HEAD, now: NOW });
      const input = { runId, head: HEAD, evidenceRoot: "/evidence", now: NOW };
      const deps = { assignmentOf: () => null, verificationEvidence: () => ({ ok: false }), installedScope: { personApprovalOf } };
      for (const releaseFlow of [false, true]) {
        expect(deploymentGate(store, { ...input, releaseFlow })).toMatchObject({ ok: false, message: expect.stringContaining("CI") });
        expect(() => deploymentCandidate(store, { ...input, releaseFlow }, deps)).toThrow("CI");
      }
      expect(liftCiHold(store, { taskId: "early-approval", candidate: HEAD, now: NOW, ask: false, ci: {
        head: HEAD, observedAt: NOW.toISOString(), complete: true,
        runs: REQUIRED_PR_CHECKS.map((name, i) => ({ id: i + 1, suite: 1, name, status: "completed", conclusion: "success", head: HEAD, app: "github-actions", workflowPath: REQUIRED_PR_CHECKS_WORKFLOW[name] })),
      } })).toEqual({ ok: true });
      expect(deploymentGate(store, input)).toMatchObject({ ok: false, message: expect.stringContaining("Native check") });
      expect(() => deploymentCandidate(store, input, deps)).toThrow("Native check");
    } finally { store.close(); }
  });

  test("a candidate dist whose personApprovalOf returns yes is never asked; a lead-sealed candidate is refused", async () => {
    const dir = scratch();
    const dist = join(dir, "candidate", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "scope.js"), "export const personApprovalOf = () => ({ ok: true, by: 'alex', at: 'now', method: 'password-now' });\n");
    const evil = await import(pathToFileURL(join(dist, "scope.js")).href) as { personApprovalOf: () => unknown };
    expect(evil.personApprovalOf()).toMatchObject({ ok: true });
    const store = openStore(join(dir, "orders.db"));
    try {
      if (!addApprover(store, "alex", NOW).ok) throw new Error("alex");
      for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
      const lead = candidate(store, "lead-sealed", "lead-token");
      const deps = { assignmentOf: () => null, verificationEvidence: () => ({ ok: false }) };
      // Handed the candidate's answer under any name the gate doesn't trust, from an installed runtime that predates the
      // check, or from one that has it: refused, before any check or completion is read.
      for (const extra of [{ personApprovalOf: evil.personApprovalOf }, { candidateScope: evil }, {}, { installedScope: {} }, { installedScope: { personApprovalOf } }]) {
        expect(() => deploymentCandidate(store, { runId: lead, head: HEAD, evidenceRoot: join(dir, "evidence"), now: NOW }, { ...deps, ...extra }), JSON.stringify(Object.keys(extra)))
          .toThrow("A person has to approve this candidate's scope: approved by the lead, not by a person.");
      }
      // The legitimate path beside it: a person's approval passes the approval step (and stops later, at the check).
      const person = candidate(store, "person-sealed", "password-now");
      for (const extra of [{}, { installedScope: { personApprovalOf } }]) {
        expect(() => deploymentCandidate(store, { runId: person, head: HEAD, evidenceRoot: join(dir, "evidence"), now: NOW }, { ...deps, ...extra })).toThrow("Native check unavailable");
      }
      // A plane from before lead tokens has no task_act table (the 0.5.0 upgrade path), shown here by a store that has none: the records are still read, the
      // proof rows still decide, and nothing throws on the missing table.
      const handle = new Proxy(store.handle, { get: (target, key) => key !== "prepare" ? Reflect.get(target, key) : (sql: string) => {
        if (!sql.includes("task_act")) return target.prepare(sql);
        if (sql.includes("sqlite_master")) return { get: () => undefined };
        throw new Error("no such table: task_act");
      } });
      // The store's own methods keep its real handle; only what the gate reads itself sees the older plane.
      const old = new Proxy(store, { get: (target, key) => { const value = Reflect.get(target, key); return key === "handle" ? handle : typeof value === "function" ? value.bind(target) : value; } });
      expect(() => deploymentCandidate(old, { runId: lead, head: HEAD, evidenceRoot: join(dir, "evidence"), now: NOW }, deps))
        .toThrow("A person has to approve this candidate's scope: approved by the lead, not by a person.");
      expect(() => deploymentCandidate(old, { runId: person, head: HEAD, evidenceRoot: join(dir, "evidence"), now: NOW }, deps)).toThrow("Native check unavailable");
    } finally { store.close(); }
  });

  test("the deploy scripts prove the candidate with the installed runtime before loading any of the candidate's code", () => {
    for (const script of ["scripts/deploy-browser.mjs", "scripts/upgrade-path.mjs"]) {
      const text = readFileSync(join(ROOT, script), "utf8");
      for (const line of text.split("\n").filter(one => /deploymentCandidate\(|installedScope|personApprovalOf/.test(one))) {
        expect(line, script).not.toMatch(/candidate(Scope|Dist)|join\((source|candidate), "dist"\)/);
      }
    }
    const browser = readFileSync(join(ROOT, "scripts/deploy-browser.mjs"), "utf8");
    expect(browser).toContain('scope: await load(priorDist, "scope.js")');
    expect(browser).toContain("installedScope: oldRt.scope");
    expect(browser).not.toMatch(/load\(join\(source, "dist"\), "scope\.js"\)/);
    // Nothing of the candidate's runs before it is proven: every module load that names the candidate's dist comes
    // after the early proof, which uses only the installed runtime (its names, lock, scope, assignment and store).
    const early = browser.indexOf("const early = ");
    expect(early).toBeGreaterThan(0);
    for (const at of [...browser.matchAll(/load\(join\(source, "dist"\)|import\(pathToFileURL\(join\(source/g)].map(one => one.index!)) expect(at).toBeGreaterThan(early);
    expect(browser.slice(0, early)).not.toMatch(/candidateAssignment|loadNames\(join\(source/);
    expect(browser).toContain('assignment: await load(priorDist, "assignment.js")');
    expect(browser).toContain("assignmentOf: oldRt.assignment.assignmentOf");
    // Every git read of the candidate (HEAD, cleanliness, the files it builds from, the blobs it compares) goes through
    // deploy-git.mjs's own view (review 2, findings 2 and 3): the script never spawns git itself.
    expect(browser).not.toMatch(/(?:execFileSync|spawnSync|execFile|spawn)\(\s*"git"/);
    expect(browser).toContain("headOf(REPO_GIT, SAFE_GIT_ENV)");
    expect(browser).toContain('headOf(["-C", result.worktree], SAFE_GIT_ENV)');
    // The commit's files and the checkout's cleanliness are read with no attribute applied (deploy-git.mjs): never
    // archive, show or status, which run the filters and textconv a repository names.
    expect(browser).not.toMatch(/"(archive|show|status)"/);
    expect(browser).toContain("extractTree(REPO_GIT, commit, scratch, SAFE_GIT_ENV)");
    expect(browser).toMatch(/import \{[^}]*headOf[^}]*\} from "\.\/deploy-git\.mjs";/);
    expect(browser).toMatch(/GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1"/);
    expect(browser).not.toMatch(/git -C .*archive/);
  });
});
