/**
 * The deployment gate, in the runtime that is releasing (docs/plans/approval-policy.md §1.7): whether a candidate run
 * may be deployed at all — a person approved its scope, its exact result passed the approved check and was marked
 * complete, and nothing still blocks it. `toolroll release` asks this BEFORE it starts anything from the candidate's
 * checkout, so the candidate's own scripts never decide their own deployment. (scripts/deploy-candidate.mjs keeps the
 * same checks for the deployment script, proven again there with the installed runtime's modules.)
 */
import { assignmentOf } from "./assignment.js";
import { liveReleaseOf, personApprovalOf } from "./scope.js";
import { verificationEvidence } from "./verification-evidence.js";
import type { Store } from "./store.js";

export type DeploymentGate = { ok: true; taskId: string; head: string; repo: string; approvedBy: string } | { ok: false; message: string };

/** Whether run `runId` is a deployable candidate now, read only from the plane's records and this runtime's code. */
export function deploymentGate(store: Store, input: { runId: number; evidenceRoot: string; now: Date }): DeploymentGate {
  const refuse = (message: string): DeploymentGate => ({ ok: false, message });
  const run = store.getRun(input.runId);
  const ref = run === null ? null : store.refById(run.taskRef);
  const scope = ref === null ? null : store.getScope(ref.externalId);
  const head = run?.headRevision ?? null;
  if (run === null || ref === null || head === null) return refuse(`Run ${input.runId} is not a built candidate.`);
  // `task regate` reruns the approved check on the last built commit and records no-change: a candidate only for that commit.
  const regated = run.outcome === "no-change" && scope?.candidate === head &&
    store.runsFor(run.taskRef).find(one => one.id < input.runId && one.role === "builder" && one.outcome === "built")?.headRevision === head;
  if (run.role !== "builder" || !(run.outcome === "built" || regated)) return refuse(`Run ${input.runId} is not a built candidate at ${head.slice(0, 7)}.`);
  if (scope === null || scope.approvedDigest !== scope.digest || scope.digest !== run.scopeDigest) return refuse("The run's signed scope is no longer the approved one.");
  // One approval per release (release-once.md): a release's task deploys only while its authority stands for it — the
  // live predicate proves the anchor's person approval (a carried commit's own seal is never a person's). Any other task
  // needs a person's approval of its own.
  const release = liveReleaseOf(store, ref.externalId, "deploy", input.now);
  if (release.applies && !release.ok) return refuse(`This release can't deploy: ${release.why}.`);
  const anchorPerson = release.applies && release.ok ? personApprovalOf(store, release.authority.anchorTask) : null;
  const person = anchorPerson ?? personApprovalOf(store, ref.externalId);
  if (!person.ok) return refuse(`A person has to approve this candidate's scope: ${person.why}.`);
  const evidence = verificationEvidence(store, input.evidenceRoot, input.runId);
  if (!evidence.ok || evidence.bytes === null) return refuse(`Native check unavailable: ${evidence.ok ? "no receipt" : evidence.problem}.`);
  let gate: Record<string, unknown>;
  try { gate = JSON.parse(evidence.bytes.toString()) as Record<string, unknown>; } catch { return refuse("The native check's receipt can't be read."); }
  const live = ref.repo === null ? null : store.liveVerifyCommand(ref.repo);
  const result = gate["result"] as { ran?: unknown; exitCode?: unknown } | undefined;
  // A release check's coverage (receipt version 3): partial or identity-removed never deploys, whatever the exit.
  if (gate["coverage"] !== undefined && gate["coverage"] !== "full" && gate["coverage"] !== "composed") return refuse(`The release check didn't cover this candidate (${String(gate["coverage"])}).`);
  const command = gate["command"] as { command?: unknown } | undefined;
  if (gate["run"] !== input.runId || gate["head"] !== head || gate["scopeDigest"] !== scope.digest || result?.ran !== true || result.exitCode !== 0
    || live === null || command?.command !== live.command) return refuse("The native check did not pass this candidate under the currently approved command.");
  const assignment = assignmentOf(store, ref.externalId, input.now, { principal: "operator", repos: null, includeUnplaced: true }, input.evidenceRoot);
  if (assignment?.state !== "complete" || assignment.receipt?.runId !== input.runId || assignment.receipt.head !== head
    || assignment.receipt.scopeDigest !== scope.digest || assignment.completion?.digest !== assignment.receipt.digest) return refuse("The lead or user has not marked this exact result complete.");
  const blockers = assignment.readiness?.blockers;
  if (!Array.isArray(blockers)) return refuse("The result's readiness could not be read.");
  if (blockers.length > 0) return refuse(`This result isn't ready to deploy: ${blockers.map(one => one.message).join(" ")}`);
  if (ref.repo === null) return refuse("The candidate's task is in no project.");
  return { ok: true, taskId: ref.externalId, head, repo: ref.repo, approvedBy: person.by };
}
