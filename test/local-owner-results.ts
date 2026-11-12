/**
 * Finished results on a laptop install (test/local-owner-world.ts), for the local owner's completion and accept tests:
 * a Ready result of one kind (ordinary, release, protected, a coordinator's), owing nothing, the person's own check or an
 * exception, its check passed or failed, and what a completion, an acceptance or a pull request would write. Shared by
 * test/attacks/local-owner-completion.test.ts (slice 0) and local-owner-accept.test.ts (slice 1).
 */
import { storeEvidence } from "../src/evidence.js";
import { propose } from "../src/scope.js";
import { sealVerificationReceipt } from "../src/verification-evidence.js";
import { assignmentOf, owedAcceptance } from "../src/assignment.js";
import { register } from "../src/runner.js";
import { COMPLETION_ACTION } from "../src/result-completion.js";
import { savePublishing } from "../src/pull-request-flow.js";
import type { ReleaseCheckPurpose } from "../src/contracts/release-terms.js";
import type { LocalWorld } from "./local-owner-world.js";

export const RESULT_T0 = new Date("2026-11-03T12:00:00.000Z");
const T0 = RESULT_T0;
const HEAD = "a".repeat(40);

export type Kind = "ordinary" | "release" | "release-record" | "declared-protected" | "changed-protected" | "coordinator";
/** What the person still owes before the result finishes: nothing (its proof verified), their own check of a
 * manual-review requirement, or an exception (a requirement not shown) they accept with a reason. */
export type Owed = "nothing" | "person-check" | "exception";
/** A revision's source build that saved no diff inventory: its run record either doesn't say whether it committed
 * ("unknown") or proves it committed nothing ("nothing"). */
export type Inherited = "unknown" | "nothing";
const MANUAL = (id: string) => `criterion "${id}" requires manual-review evidence — an operator must accept it before this can verify`;

/**
 * The results factory over one world: `prepare()` once (the project's check, a worker, a second approver, pull requests
 * set up), then `ready()` for each result. `evidence` is where its artifacts live (the console's own folder, or the
 * folder beside the database that a terminal command reads).
 */
export function resultFixtures(world: LocalWorld, evidence: string) {
  let serial = 0;
  function prepare(): void {
    world.store.setVerifyCommand({ repo: world.repo, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, T0);
    register(world.store, { name: "worker-1", host: "test", capacity: 4, repos: [world.repo], now: T0, newToken: () => "tok-worker-1" });
    // A second approver, whose earlier yes is the other pair of eyes on protected work.
    // (Written straight in: on a laptop nobody vouches for another approver without a password.)
    world.store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at) VALUES ('robin', 'x', ?)").run(T0.toISOString());
    // Pull requests set up for the project, so "Complete and open a pull request" would otherwise go through.
    savePublishing(world.store, { repo: world.repo, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", {}, T0);
  }
  /** A finished, checked result on its own branch, Ready, with its exact receipt: the kind of work it is decides the rest. */
  function ready(kind: Kind, { owed = "nothing", inherited, check = "passed" }: { owed?: Owed; inherited?: Inherited; check?: "passed" | "failed" } = {}): { id: string; runId: number; digest: string } {
    const store = world.store, id = `result-${++serial}`;
    // Nothing protected until this result's own approval is sealed (an earlier fixture may have protected infra/).
    store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: [] }, "alex", T0);
    // A revision builds on its source's head: the source's build is part of what the result's branch carries.
    if (inherited !== undefined) {
      const source = `${id}-source`;
      store.createTask({ id: source, title: "Fix the checkout total" }, T0);
      store.placeTask(store.refFor("built-in", source).id, world.repo, {}, T0);
      propose(store, { taskId: source, goal: "Fix the checkout total", touches: ["src/total.ts"],
        acceptance: [{ id: "c1", statement: "Totals add up.", how: null, evidence: ["check"] }], now: T0 });
      if (!store.sealScopeApproval(source, "alex", T0)) throw Error("seal source");
      const sourceRef = store.lookupRef(source)!.id;
      const route = store.routeAuthorityFor(sourceRef, "builder");
      if (!route?.ok) throw Error("source route fixture");
      const sourceRun = store.startRun({ taskRef: sourceRef, leaseId: `l-${source}`, runner: "worker-1", branch: `toolroll/${source}`, worktree: `/pool/${source}`, route: route.stamp, now: T0 });
      // No diff inventory was saved for it. Its record either can't say whether it committed, or proves it didn't.
      store.finishRun(sourceRun, inherited === "nothing" ? { outcome: "no-change", committed: false, now: T0 } : { outcome: "built", now: T0 });
      store.setTaskState(source, "done", T0);
      const brief = storeEvidence(store, evidence, sourceRun, "revision-brief", "revision.json", Buffer.from("{}"), "revision brief", T0, { captureStatus: "ok" });
      store.createTask({ id, title: "Fix the checkout total" }, T0);
      store.markRevision(store.refFor("built-in", id).id, source, brief);
    } else store.createTask({ id, title: "Fix the checkout total" }, T0);
    store.placeTask(store.refFor("built-in", id).id, world.repo, {}, T0);
    // A release's check purpose, signed in its scope (pipeline-speed.md P0): the scope alone says this is release work.
    const releaseCheck: ReleaseCheckPurpose | undefined = kind !== "release" ? undefined : { version: 1, purpose: "release-check", repo: world.repo, packageVersion: "1.2.3",
      branch: "release/1.2.3", pr: 7, base: "main", approvedSha: "c".repeat(40), approvedTree: "d".repeat(40), grant: { id: 1, digest: "g" }, access: "sandboxed" } as ReleaseCheckPurpose;
    // The owed acceptance is a second requirement: a person's own look, or a screenshot the build never showed.
    const extra = owed === "nothing" ? [] : [{ id: "c2", statement: "The receipt reads well on a phone.", how: null, evidence: [owed === "person-check" ? "manual-review" as const : "screenshot" as const] }];
    propose(store, { taskId: id, goal: "Fix the checkout total", touches: [kind === "declared-protected" ? "infra/main.tf" : "src/total.ts"],
      acceptance: [{ id: "c1", statement: "Totals add up.", how: null, evidence: ["check"] }, ...extra], now: T0, ...(releaseCheck === undefined ? {} : { releaseCheck }) });
    if (kind === "coordinator") {
      store.handle.exec("PRAGMA foreign_keys = OFF");
      store.handle.prepare("UPDATE task_ref SET coordinator_cid = 'c-1' WHERE external_id = ?").run(id);
      store.handle.exec("PRAGMA foreign_keys = ON");
    }
    // A person approved it with a password, earlier (the local owner could not have).
    if (!store.sealScopeApproval(id, "alex", T0)) throw Error(`seal ${kind}`);
    if (kind === "declared-protected" || kind === "changed-protected" || inherited !== undefined) {
      // The project protects infra/ (since the seal): its scope declares infra/ ("declared"), or only its build changed
      // it ("changed"), where a second person's yes on record makes today's two-person rule let the owner complete it.
      // A revision's own build touches no protected file, so what its source's build changed is what decides.
      store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: ["infra/"] }, "alex", T0);
      if (kind === "changed-protected") store.recordApprovalVote(id, store.getScope(id)!.digest, "robin", T0, "password-now");
    }
    const ref = store.lookupRef(id)!.id;
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw Error("route fixture");
    const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "worker-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: T0 });
    store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Totals now include tax." });
    store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
    store.setTaskState(id, "done", T0);
    const c1 = { id: "c1", statement: "Totals add up.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null };
    if (owed === "nothing") store.saveProofVerdict(runId, "verified", [], T0, [c1] as never, "verified");
    else if (owed === "person-check") store.saveProofVerdict(runId, "short", [MANUAL("c2")], T0, [c1, { id: "c2", statement: "The receipt reads well on a phone.", requiredEvidence: ["manual-review"],
      state: "manual-review", detail: [MANUAL("c2")], answered: [{ kind: "manual-review", ref: "Looked at it on a phone" }], review: null }] as never, "short");
    else store.saveProofVerdict(runId, "short", ["no proof for c2"], T0, [c1, { id: "c2", statement: "The receipt reads well on a phone.", requiredEvidence: ["screenshot"],
      state: "missing", detail: ["no screenshot"], answered: [], review: null }] as never, "short");
    // What the build actually changed: a protected file only in the "changed" case, whatever the scope declared.
    const changed = kind === "changed-protected" ? "infra/main.tf" : "src/total.ts";
    storeEvidence(store, evidence, runId, "terminal-diff", "diff.patch", Buffer.from(`--- a/${changed}\n+++ b/${changed}\n`), "git diff (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, evidence, runId, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ filesTruncated: false, files: [{ path: changed }] })), "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, evidence, runId, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidence, runId, HEAD, store.liveVerifyCommand(world.repo)!, { configured: true, ran: true, exitCode: check === "passed" ? 0 : 1 }, T0);
    if (kind === "release-record") {
      // It belongs to a release through the release records alone (this task anchors a release approval), not its scope.
      store.handle.exec("PRAGMA foreign_keys = OFF");
      store.handle.prepare(`INSERT INTO release_authority (repo, generation, version, pr, branch, base, anchor_task, anchor_digest, approved_sha, approved_tree,
          tip_sha, tip_task, policy_json, policy_digest, verify_command, verify_digest, access_digest, state, expires_at, created_at)
        VALUES (?, 1, '1.2.3', ?, 'release/1.2.3', 'main', ?, ?, ?, ?, ?, ?, '{}', 'pd', 1, 'vd', 'sandboxed', 'open', '2026-11-04T12:00:00.000Z', ?)`)
        .run(world.repo, serial, id, store.getScope(id)!.digest, HEAD, "d".repeat(40), HEAD, id, T0.toISOString());
      store.handle.exec("PRAGMA foreign_keys = ON");
    }
    const current = assignmentOf(store, id, T0, { principal: "operator", repos: [world.repo] }, evidence)!;
    if (current.receipt?.runId !== runId || (current.state !== "ready-to-check" && check === "passed")) throw Error(`${kind}: ${current.state} ${current.detail}`);
    // The fixture owes exactly what it says: Accept and finish reaches the acceptance write for it.
    const due = owedAcceptance(current.receipt, current.readiness?.blockers ?? []);
    if (due !== (owed === "nothing" ? null : owed)) throw Error(`${kind} ${owed}: owes ${due}`);
    return { id, runId, digest: current.receipt.digest };
  }

  /** Everything a completion, an acceptance or a pull request would write, and what the task's approval and state are. */
  function stateOf(id: string, runId: number): string {
    const store = world.store;
    return JSON.stringify([
      store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = ? AND run_id = ?").all(COMPLETION_ACTION, runId),
      store.handle.prepare("SELECT * FROM proof_acceptance WHERE run = ?").all(runId),
      store.handle.prepare("SELECT * FROM publication WHERE run = ?").all(runId),
      store.handle.prepare("SELECT digest, approved_digest, approved_by, approval_basis FROM task_scope WHERE task_id = ?").all(id),
      store.handle.prepare("SELECT state FROM task WHERE id = ?").all(id),
      store.handle.prepare("SELECT outcome, finished_at FROM run WHERE id = ?").all(runId),
    ]);
  }
  const completed = (runId: number) => world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = ? AND run_id = ?").get(COMPLETION_ACTION, runId)?.["n"];

  /** A newer build of the same task lands (a retry), replacing the result a screen read: its run and receipt. */
  function rebuild(id: string): { runId: number; digest: string } {
    const store = world.store;
    const ref = store.lookupRef(id)!.id;
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw Error("route fixture");
    const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}-again`, runner: "worker-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: T0 });
    store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
    const head = "e".repeat(40);
    store.recordOutcomeFacts(runId, { headRevision: head, handoff: "Totals now include tax, rounded." });
    store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
    store.setTaskState(id, "done", T0);
    const c1 = { id: "c1", statement: "Totals add up.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null };
    store.saveProofVerdict(runId, "verified", [], T0, [c1] as never, "verified");
    storeEvidence(store, evidence, runId, "terminal-diff", "diff.patch", Buffer.from("--- a/src/total.ts\n+++ b/src/total.ts\n"), "git diff (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, evidence, runId, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ filesTruncated: false, files: [{ path: "src/total.ts" }] })), "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, evidence, runId, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidence, runId, head, store.liveVerifyCommand(world.repo)!, { configured: true, ran: true, exitCode: 0 }, T0);
    const current = assignmentOf(store, id, T0, { principal: "operator", repos: [world.repo] }, evidence)!;
    if (current.receipt?.runId !== runId) throw Error(`rebuild: ${current.state} ${current.detail}`);
    return { runId, digest: current.receipt.digest };
  }

  return { prepare, ready, stateOf, completed, rebuild };
}
