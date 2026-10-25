/**
 * A flow's Pull request zone (flows.ts): the card's built result becomes a pull request under the project's pull
 * request setup — the same grant, publisher and merge as Complete → pull request (pull-request-flow.ts) — and CI
 * decides where the card goes: on when checks pass (merging first when the zone says so), down the failure path
 * when they fail, with the failing check named on the card. A failure path back to a Build zone becomes a revision
 * of that same work carrying the failure, as a person's send back does.
 *
 * A zone that merges only ever merges a card a person approved (a "Person decides" zone) after it was last built:
 * the flow can't be drawn otherwise (validateFlowDefinition), and a card moved in by hand or by a trigger is checked
 * here too. Without that approval the checks passing leave it waiting for a person.
 *
 * Model-free, in the worker's step pass. The publisher and CI observation run in the watch loop; this reads what
 * they recorded, and reads GitHub itself only to name a failing check and to merge.
 */
import { createHash } from "node:crypto";
import type { Runner } from "./backend.js";
import { assignmentOf } from "./assignment.js";
import { cardFollowers, notifyPeople } from "./flow-people.js";
import type { FlowDefinition, FlowStage } from "./flows.js";
import { adoptPublishedPullRequest } from "./publish.js";
import { failingCheckOf, mergePullRequest, owePullRequest, pullRequestBlocker, pullRequestFollowOf } from "./pull-request-flow.js";
import { requestResultChanges } from "./result-actions.js";
import { revisionSourceOf } from "./result-review.js";
import type { FlowCardRow, FlowRow, Store } from "./store.js";

export type PullRequestIo = { gh: Runner; evidenceRoot?: string };

/** Whether a person approved this card at a "Person decides" zone since it was last built; their name when so. */
export function approvedSinceBuild(store: Store, definition: FlowDefinition, card: FlowCardRow): string | null {
  const kindOf = (id: string | null) => definition.stages.find(one => one.id === id)?.kind ?? null;
  const events = store.flowEvents(card.id);
  let built = -1;
  events.forEach((event, index) => { if (kindOf(event.fromStage) === "task" || kindOf(event.toStage) === "task") built = index; });
  // Only a person's recorded decision (approval policy §1.7): a subagent's, a machine credential's, or one from before
  // decisions recorded who made them, never lets this zone merge.
  const approval = events.slice(built + 1).reverse().find(event => event.outcome === "approved" && kindOf(event.fromStage) === "approval" && event.authority === "person");
  return approval === undefined ? null : approval.actor;
}

/** One pass of a Pull request zone for one card. Returns whether it changed anything. */
export async function pullRequestStep(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, now: Date, io: PullRequestIo): Promise<boolean> {
  const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? "another zone";
  const waiting = (said: string): boolean => {
    if (card.waiting === said) return false;
    store.updateFlowCard(card.id, { waiting: said }, now);
    return true;
  };
  const passed = (said: string, output: string): boolean => {
    store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: output }, waiting: null }, now);
    if (stage.next === null) return waiting(`${said} Move the card on when you're ready.`);
    return store.moveFlowCard(card.id, { to: stage.next, outcome: "ok", actor: "flow", historyNote: said, expectEntry: card.entry }, now);
  };
  const failed = (said: string, revision: string | null = null): boolean => {
    store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: said } }, now);
    if (stage.onFail === null) {
      if (!waiting(`${said} Fix it, then move the card to try again.`)) return false;
    } else if (!store.moveFlowCard(card.id, { to: stage.onFail, outcome: "fail", actor: "flow", note: said, ...(revision === null ? {} : { task: revision }), expectEntry: card.entry }, now)) return false;
    const people = card.owner === null ? cardFollowers(store, card) : [card.owner];
    notifyPeople(store, card, people, null, { key: `step-failed:${card.entry}`, subject: `${stage.title} didn't pass for “${card.title}”`, attention: true,
      body: `${said}${stage.onFail === null ? "" : `\n\nIt's back in ${titleOf(stage.onFail)}${revision === null ? "" : `, as revision ${revision}`}.`}` }, now);
    return true;
  };

  // Publishing that can't proceed is not the build's fault: rebuilding wouldn't change it, so the card waits here,
  // saying what to do, and the people on it hear once. It carries on by itself once the cause is fixed.
  const stuck = (said: string): boolean => {
    if (!waiting(said)) return false;
    const people = card.owner === null ? cardFollowers(store, card) : [card.owner];
    notifyPeople(store, card, people, null, { key: `pr-stuck:${card.entry}`, subject: `${stage.title} is waiting on you for “${card.title}”`, attention: true, body: said }, now);
    return true;
  };

  // With no failure path, a card that didn't pass waits for a person to move it (a move is a fresh visit).
  if (stage.onFail === null && card.waiting !== null && card.waiting.endsWith(" Fix it, then move the card to try again.")) return false;
  const task = card.primaryTask;
  const receipt = task === null ? null : assignmentOf(store, task, now, { principal: "operator", repos: [flow.repo] }, io.evidenceRoot)?.receipt ?? null;
  if (receipt === null) return failed("There's no built result on this card to open a pull request for.");
  const runId = receipt.runId;
  let publication = store.publicationForRun(runId);
  if (publication === null || pullRequestFollowOf(store, publication.id) === null) {
    if (publication === null) {
      const blocked = pullRequestBlocker(store, runId);
      // Only a result that can't be published as built goes back to be built again.
      if (blocked !== null && (blocked === "This result has no commit to publish." || blocked.includes("looks like a secret"))) return failed(blocked);
      if (blocked === "Pull requests aren't set up for this project.") return stuck("Pull requests aren't set up for this project. Turn them on in Projects → Pull requests (or run toolroll publish setup); the card carries on by itself.");
      if (blocked !== null) return stuck(blocked);
    }
    publication = owePullRequest(store, runId, `flow ${flow.name}`, card.id, now);
  }
  if (publication.state === "failed") {
    const said = `Couldn't open the pull request: ${publication.lastError ?? "GitHub refused it"}. The commit is safe locally. Fix that, then move the card back to Build for a fresh result.`;
    if (card.waiting === said) return false;
    // A pull request opened for this commit anyway (another pass, or a person) is the card's pull request.
    if (await adoptPublishedPullRequest(store, publication, io.gh, () => now)) publication = store.publicationForRun(runId)!;
    else return stuck(said);
  }
  const pr = publication.prNumber === null ? "the pull request" : `PR #${publication.prNumber}`;
  if (publication.state !== "opened") return waiting(publication.lastError === null ? "Opening the pull request…" : `Opening the pull request. Retrying: ${publication.lastError}`);
  const link = publication.prUrl ?? pr;
  if (publication.remoteState === "MERGED") return passed(`${pr} was merged on GitHub.`, `Merged: ${link}`);
  if (publication.remoteState === "CLOSED") return failed(`${pr} was closed on GitHub without merging.`);
  // Only what CI said since the card came here counts: a card moved back to try again waits for a fresh look.
  const entered = store.flowCardEnteredAt(card.id) ?? card.updatedAt;
  const fresh = publication.lastCheckAt !== null && publication.lastCheckAt >= entered;
  if (!fresh || publication.lastCheckState === "running") return waiting(`Waiting for CI on ${pr}.`);
  if (publication.lastCheckState !== "passing" && publication.lastCheckState !== "failing") return waiting(`No CI checks have reported on ${pr} yet. If this project has none, move the card on.`);

  if (publication.lastCheckState === "failing") {
    const found = await failingCheckOf(io.gh, publication);
    const said = found === null ? `CI failed on ${pr}. GitHub couldn't be read to name the check.` : `CI check “${found.check}” failed on ${pr}.`;
    // Back to a Build zone: a revision of the same work, carrying the failure (fenced as untrusted CI output).
    let revision: string | null = null;
    const target = definition.stages.find(one => one.id === stage.onFail);
    if (target?.kind === "task" && io.evidenceRoot !== undefined) {
      const runTask = store.externalIdFor(store.getRun(runId)?.taskRef ?? -1);
      const revised = runTask === null ? null : requestResultChanges(store, io.evidenceRoot, {
        run: runId, source: revisionSourceOf(store.getScope(runTask)?.digest ?? null), actor: "toolroll", repos: [flow.repo], batch: "",
        note: found?.note ?? said, path: "", line: "", allowMode: true,
        request: createHash("sha256").update(`flow-ci ${card.id} ${card.entry} ${publication.id}`).digest("hex").slice(0, 32),
      }, now);
      if (revised?.ok === true) revision = revised.id;
    }
    return failed(said, revision);
  }

  // Checks pass.
  if (stage.merge === undefined) return passed(`${pr} passed its checks.`, `Pull request: ${link} (checks passed)`);
  const approver = approvedSinceBuild(store, definition, card);
  if (approver === null) return waiting(`Checks passed on ${pr}, but no person approved this card since it was built, so it wasn't merged. Merge it from its task, or send it through a decision.`);
  const merged = await mergePullRequest(store, { runId, by: `${approver} (approved in ${flow.name})`, exec: io.gh, method: stage.merge, clock: () => now });
  if (merged.ok) return passed(`Merged ${pr} (${stage.merge}).`, `Merged: ${link}`);
  if (merged.reason === "checks" || merged.reason === "unread") return waiting(`${merged.message} (${pr})`);
  return failed(`Couldn't merge ${pr}: ${merged.message}`);
}
