/**
 * A deployable candidate in a real plane database (deploy-gate.ts passes it): a person approved its scope with their
 * password, its build passed the approved check on an exact commit, and a person marked that result complete. Shared by
 * the release-adapter tests and the deployment attack, which also need its unapproved twin.
 */
import { join } from "node:path";
import { openStore, type Store } from "../src/store.js";
import { addApprover, approve, propose } from "../src/scope.js";
import { storeEvidence } from "../src/evidence.js";
import { sealVerificationReceipt } from "../src/verification-evidence.js";
import { recordRunCheckLevel } from "../src/check-levels.js";
import { assignmentOf, checkAssignmentAsOperator } from "../src/assignment.js";
import { verifyApproverByPassword } from "../src/principal.js";

export const CANDIDATE_HEAD = "c".repeat(40);
const NOW = new Date("2026-10-24T12:00:00.000Z");
const REPO = "/repo/deploy-candidate";

/** Build one candidate in the database at `database`. `approval: "lead"` makes the record say a lead token made its
 * seal (as before the fix); the result is still checked and complete. */
export function provableCandidate(database: string, id = "deploy-me", approval: "person" | "lead" = "person", head = CANDIDATE_HEAD): { runId: number; head: string; now: Date } {
  const store = openStore(database);
  try {
    let password = "";
    if (store.accountOf("alex") === null) {
      const alex = addApprover(store, "alex", NOW);
      if (!alex.ok) throw new Error("alex");
      password = alex.token;
      for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
      store.setVerifyCommand({ repo: REPO, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
      store.handle.prepare("CREATE TABLE IF NOT EXISTS fixture_secret (v TEXT)").run();
      store.handle.prepare("INSERT INTO fixture_secret VALUES (?)").run(password);
    } else password = String(store.handle.prepare("SELECT v FROM fixture_secret").get()!["v"]);
    store.createTask({ id, title: id }, NOW);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO, {}, NOW);
    const scope = propose(store, { taskId: id, goal: `Ship ${id}`, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
    const approved = approve(store, id, "alex", NOW, scope.digest, password);
    if (!approved.ok) throw new Error(approved.reason);
    const runId = built(store, id, ref, database, head);
    // A person marks the exact result complete.
    const root = join(database, "..", "evidence");
    const receipt = assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root)?.receipt;
    const who = verifyApproverByPassword(store, "alex", password, [REPO]);
    if (receipt == null || !who.ok) throw new Error("not ready");
    const done = checkAssignmentAsOperator(store, id, receipt.digest, who.who, NOW, root);
    if (!done.ok) throw new Error(done.message);
    // The unapproved twin: the record shows the lead's token made that seal (as before the fix), so no person stands
    // behind it, whatever else is in order.
    if (approval === "lead") store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: id, runId: null, action: "approval proved", outcome: "lead-token",
      source: "work", detail: `${NOW.toISOString()} · generation 1 · digest ${scope.digest}` });
    return { runId, head, now: NOW };
  } finally { store.close(); }
}

function built(store: Store, id: string, ref: number, database: string, head: string): number {
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "r", branch: `b-${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
  store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(runId, { headRevision: head, handoff: "Done." });
  store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
  store.setTaskState(id, "done", NOW);
  const root = join(database, "..", "evidence");
  recordRunCheckLevel(store, { id: runId, taskId: id, repo: REPO }, "full", "project", NOW);
  store.saveProofVerdict(runId, "verified", [], NOW, [{ id: "c1", statement: "it works", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null }] as never, "verified");
  storeEvidence(store, root, runId, "terminal-diff", "diff.patch", Buffer.from("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n"), "git diff (exit 0)", NOW, { captureStatus: "ok" });
  storeEvidence(store, root, runId, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ schema: 1, head: head, base: "1".repeat(40), filesTruncated: false, fileCount: 1, files: [{ path: "src/a.ts" }] })), "git diff --numstat", NOW, { captureStatus: "ok" });
  storeEvidence(store, root, runId, "check-log", "checks.txt", Buffer.from("1 passed\n"), "true", NOW, { captureStatus: "ok" });
  sealVerificationReceipt(store, root, runId, head, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, NOW);
  store.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [] }, NOW);
  return runId;
}
