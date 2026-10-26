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
    // Every git read of the candidate (HEAD, status, the archive it builds from, the blobs it compares) ignores
    // replacement objects and lazy fetch, and no shell pipes an archive.
    const calls = [...browser.matchAll(/(?:execFileSync|spawnSync)\("git", \[([^\]]*)/g)].map(one => one[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const args of calls) expect(args.startsWith("...SAFE_GIT,"), args).toBe(true);
    expect(browser).toMatch(/const SAFE_GIT = \["--no-replace-objects",/);
    expect(browser).toMatch(/GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1"/);
    expect(browser).not.toMatch(/git -C .*archive/);
  });
});
