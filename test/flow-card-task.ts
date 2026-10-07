import { acquire, release } from "../src/claim.js";
import { flowFromSteps } from "../src/flows.js";
import type { MilestoneState } from "../src/plan.js";
import { register } from "../src/runner.js";
import { addApprover, approve, propose } from "../src/scope.js";
import type { Store } from "../src/store.js";

/** A synthetic agent card with a real scope, lease and saved progress. No agent runs. */
export function flowTaskFixture(store: Store, now: Date, repo = "/repo/flow-cards", id = "checkout") {
  const added = addApprover(store, "alex", now);
  if (!added.ok) throw new Error("fixture approver already exists");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
  store.createTask({ id, title: "Fix checkout rounding" }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo, {}, now);
  propose(store, { taskId: id, goal: "Fix checkout rounding", now });
  const scope = store.getScope(id)!;
  if (!approve(store, id, "alex", now, scope.digest, added.token).ok) throw new Error("fixture approval failed");
  register(store, { name: "builder", host: "test", capacity: 2, repos: [repo], now, newToken: () => "fixture-runner" });
  const claim = acquire(store, ref, "builder", { token: "fixture-runner", now, ttlMs: 3_600_000 });
  if (!claim.ok) throw new Error(`fixture claim failed: ${claim.reason}`);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("fixture route missing");
  const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "builder", branch: "fixture/checkout", worktree: repo,
    role: "builder", route: authority.stamp, now });
  store.stampRun(run, { baseRevision: "a".repeat(40), scopeDigest: scope.digest });
  store.setTaskState(id, "running", now);
  const artifact = store.saveArtifact({ run, kind: "plan", key: `${run}/plan.md`, bytesOriginal: 0, bytesStored: 0, truncated: false, sha256: "a".repeat(64), capture: "synthetic plan" }, now);
  const planRevision = store.insertPlanRevision({ taskRef: ref, revision: 1, artifact, parentHash: null, reason: "Initial plan", evidenceLink: null,
    author: "alex", originRun: null, kind: "initial", authorityKind: "plan-only", authorityDigest: scope.digest, changedFields: [], status: "applied" }, now);
  const checkpoint = (states: MilestoneState[], note: string | null = null, attempt = run) => store.insertRunCheckpoint({ run: attempt, taskRef: ref, planRevision,
    snapshot: { revisionHash: "a".repeat(64), milestones: states.map((state, index) => ({ id: `m${index + 1}`, state, note: state === "blocked" ? note : null })) } }, now);
  const flow = store.createFlow({ repo, name: "Checkout · synthetic fixture", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
    { id: "build", title: "Build", kind: "task", instructions: "Fix checkout rounding" },
    { id: "review", title: "Review", kind: "approval" },
    { id: "empty", title: "Waiting", kind: "inbox" },
  ], null)) }, now);
  const card = store.addFlowCard({ flow, title: "Fix checkout rounding", description: "Synthetic fixture for live flow cards.", stage: "build", by: "alex" }, now);
  store.updateFlowCard(card, { task: id, primaryTask: id, waiting: "Filed as a task" }, now);
  const finish = (state: "done" | "failed" = "done") => {
    store.recordOutcomeFacts(run, { headRevision: "b".repeat(40), handoff: "Checkout totals now round correctly." });
    store.finishRun(run, { outcome: state === "done" ? "built" : "failed", reason: state === "done" ? "built" : "check-failed", now });
    release(store, claim.claim.leaseId, now);
    store.setTaskState(id, state, now);
  };
  const question = (text = "Use banker's rounding for refunds too?") => store.saveDecision({ run, urgency: "blocking", recap: "Refunds share the rounding helper.", question: text,
    options: [{ id: "yes", label: "Use it", consequence: "Refund totals use the same rounding.", reversible: true }, { id: "no", label: "Keep refunds", consequence: "Only checkout changes.", reversible: true }], recommendation: "yes" }, now);
  return { repo, id, ref, run, planRevision, flow, card, checkpoint, finish, question, password: added.token };
}
