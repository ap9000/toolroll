/**
 * Releases that approve themselves when green (docs/plans/auto-approve-green.md): the project setting "Release
 * approval: Ask me / Approve automatically when checks pass", and the plane's two automatic seals of a release task.
 *
 *   auto-check  (the approval step)  lets the release task's build run its check — nothing else;
 *   auto-green  (after the check)    the release approval, once the plane itself saw the pull request's CI and the
 *                                    release check pass on the exact candidate. It opens the release's authority as a
 *                                    person's seal of release terms does.
 *
 * Both are written only here, each in one write transaction that proves every fact again from the plane's own records,
 * its own `gh` observation (handed in by release-adapters.ts, which made it) and verified objects in the project's own
 * Git directory. No command or console road reaches these functions: `toolroll release` calls them through its store
 * adapter. Any refusal unseals `auto-check`, so the task asks a person, its passing check kept.
 */
import { assignmentOf } from "./assignment.js";
import { projectGitDir } from "./check-report.js";
import { runCheckLevel } from "./check-levels.js";
import { readVerifiedCommit, verifiedBlobs, verifiedFirstParentWalk, verifiedTreeDiff } from "./commit-extract.js";
import { chatControlHref } from "./chat-controls.js";
import { REQUIRED_PR_CHECKS } from "./release.js";
import { AUTO_EVIDENCE_ACTION, LIVE_RELEASE_STATES, RELEASE_APPROVAL_ACTION, releaseAuthorityOfTask, releaseAutoApproves, type ReleaseApprovalSetting, releaseApprovalSetting } from "./release-authority.js";
import { autoReleaseApprovalOf, personApprovalOf } from "./scope.js";
import { revokeRelease, type Store } from "./store.js";
import { verificationEvidence } from "./verification-evidence.js";

export { RELEASE_APPROVAL_ACTION, releaseApprovalSetting, releaseAutoApproves, type ReleaseApprovalSetting };

/** The setting's words, one place. */
export const RELEASE_APPROVAL_WORDS = { ask: "Ask me", auto: "Approve automatically when checks pass" } as const;
/** How old the plane's own CI observation may be when it seals. */
export const CI_OBSERVATION_MS = 5 * 60_000;

/** One check run on the candidate as the plane's own `gh` reported it (oldest first). */
export type ObservedCheckRun = { id: number | null; name: string; status: string; conclusion: string | null; app: string | null };
/** The plane's own look at GitHub CI for one commit (release-adapters.ts makes it, right before the seal). */
export type CiObservation = { head: string; observedAt: string; runs: readonly ObservedCheckRun[] };

type Refusal = { ok: false; why: string };
const refuse = (why: string): Refusal => ({ ok: false, why });

/**
 * Change the setting: an approver's act, proven by the caller (on: a password typed now; off: one click). Lowering it,
 * in the same transaction, unseals every automatic seal of the project whose release hasn't started merging and stops
 * their live releases, so nothing approves — or goes on — on the old setting.
 */
export function setReleaseApproval(store: Store, repo: string, auto: boolean, by: string, now: Date): { changed: boolean; withdrawn: string[] } {
  return store.transact(() => {
    const before = releaseApprovalSetting(store, repo).auto;
    if (before === auto) return { changed: false, withdrawn: [] };
    store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action: RELEASE_APPROVAL_ACTION, outcome: auto ? "auto" : "ask", source: "policy",
      detail: `Release approval: ${before ? RELEASE_APPROVAL_WORDS.auto : RELEASE_APPROVAL_WORDS.ask} → ${auto ? RELEASE_APPROVAL_WORDS.auto : RELEASE_APPROVAL_WORDS.ask}` });
    const withdrawn: string[] = [];
    if (!auto) {
      const sealed = store.handle.prepare(`SELECT s.task_id FROM task_scope s JOIN task_ref r ON r.external_id = s.task_id AND r.backend = 'built-in'
          WHERE r.repo = ? AND s.approved_at IS NOT NULL AND s.approval_basis IN ('auto-check', 'auto-green')`).all(repo).map(row => String(row["task_id"]));
      for (const taskId of sealed) {
        const found = releaseAuthorityOfTask(store, taskId);
        // A merge already under way finishes through its own reconciliation; it can't be taken back here.
        if (found !== null && (found.authority.state === "merge-reserved" || found.authority.state === "merged")) continue;
        if (found !== null && LIVE_RELEASE_STATES.includes(found.authority.state)) revokeRelease(store, found.authority.id, `${by}: automatic release approval turned off`, now);
        unseal(store, taskId);
        withdrawn.push(taskId);
        store.enqueueNotification({ dedupeKey: `release-auto-withdrawn:${taskId}:${now.toISOString()}`, kind: "release-auto", subject: "Release needs your approval",
          body: "Automatic release approval was turned off, so this release waits for a person's approval.", link: chatControlHref("task", taskId), source: { taskRef: store.lookupRef(taskId)!.id } }, now);
      }
    }
    store.bumpWake();
    return { changed: true, withdrawn };
  });
}

/** Take back an automatic seal: the task asks a person again (its result, if any, is kept). */
function unseal(store: Store, taskId: string): void {
  store.handle.prepare(`UPDATE task_scope SET approved_at = NULL, approved_by = NULL, approved_digest = NULL, approved_profile_json = NULL,
      approved_route_json = NULL, approval_basis = NULL, mode_digest = NULL WHERE task_id = ? AND approval_basis IN ('auto-check', 'auto-green')`).run(taskId);
}

/** What every automatic seal needs before anything else: the setting on now, a release task in this project with its
 * candidate and release terms signed in, the exact digest the coordinator filed, and a person who can approve here. */
function releaseTaskFacts(store: Store, input: { taskId: string; digest: string; candidate: string }):
  { ok: true; repo: string; by: string; taskRef: number; version: string; pr: number } | Refusal {
  const ref = store.lookupRef(input.taskId);
  const scope = store.getScope(input.taskId);
  if (ref === null || ref.repo === null || scope === null) return refuse("the release task isn't in a project Toolroll knows");
  const setting = releaseApprovalSetting(store, ref.repo);
  if (!setting.auto || setting.setBy === null) return refuse("this project's releases aren't approved automatically");
  if ((scope.candidate ?? null) === null || (scope.releaseTerms ?? null) === null) return refuse("only a release task is approved automatically");
  if (scope.candidate !== input.candidate) return refuse(`the release task is for ${String(scope.candidate).slice(0, 7)}, not ${input.candidate.slice(0, 7)}`);
  if (scope.digest !== input.digest) return refuse("the release scope changed after it was filed");
  if (scope.termsProblem != null) return refuse("the release scope can't be read exactly");
  const by = setting.setBy;
  const account = store.accountOf(by);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(by, ref.repo)) return refuse(`${by}, who turned on automatic release approval, can no longer approve in this project`);
  const terms = scope.releaseTerms!;
  // A release a person or Toolroll stopped (revoked, or a CI failure after its deploy) asks a person again.
  const stopped = store.handle.prepare("SELECT 1 AS hit FROM release_authority WHERE repo = ? AND version = ? AND pr = ? AND state = 'revoked' LIMIT 1").get(terms.repo, terms.packageVersion, terms.pr);
  if (stopped !== undefined) return refuse(`release ${terms.packageVersion} was stopped before, so a person approves it again`);
  return { ok: true, repo: ref.repo, by, taskRef: ref.id, version: terms.packageVersion, pr: terms.pr };
}

/** A refusal inside a seal's transaction: thrown, so nothing it wrote (the evidence row) stays. */
class AutoRefused extends Error {}

/** One evidence row, then the seal naming it, in the caller's transaction. Throws AutoRefused when the seal primitive
 * refused, so the evidence row rolls back with it. */
function sealWith(store: Store, kind: "auto-check" | "auto-green", taskId: string, by: string, repo: string, detail: Record<string, unknown>, now: Date, why: string): void {
  // Written whole (recordAction shortens details for display): the evidence is the record of what proved the seal.
  const written = store.handle.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(now.toISOString(), "toolroll", repo, taskId, typeof detail["run"] === "number" ? detail["run"] : null, AUTO_EVIDENCE_ACTION, kind, "work", JSON.stringify({ v: 1, by, ...detail }));
  const id = Number(written.lastInsertRowid);
  if (!store.sealScopeApproval(taskId, by, now, {}, { kind, modeDigest: `auto:${id}` }, "automation")) throw new AutoRefused(why);
}

/** Run `body` in one write transaction; an AutoRefused inside it rolls everything back and is the answer. */
function inTransaction<T>(store: Store, body: () => T | Refusal): T | Refusal {
  try { return store.transact(body); }
  catch (error) { if (error instanceof AutoRefused) return refuse(error.message); throw error; }
}

/**
 * The approval step with the setting on: seal `auto-check`, so the release task's build runs its check before anyone
 * approves it. Idempotent: an `auto-check` already standing on this digest is the answer. A person's own approval
 * already there is left alone (the coordinator then takes the person's road).
 */
export function authorizeAutoCheck(store: Store, input: { taskId: string; digest: string; candidate: string; now: Date }): { ok: true; already: boolean } | Refusal {
  return inTransaction(store, (): { ok: true; already: boolean } | Refusal => {
    const facts = releaseTaskFacts(store, input);
    if (!facts.ok) return facts;
    const scope = store.getScope(input.taskId)!;
    if (scope.approvedAt !== null && scope.approvedDigest === scope.digest) {
      if (scope.approvalBasis === "auto-check") {
        const standing = autoReleaseApprovalOf(store, input.taskId, "auto-check");
        return standing.ok ? { ok: true as const, already: true } : refuse(standing.why);
      }
      return refuse(personApprovalOf(store, input.taskId).ok ? "a person already approved it" : "it already has an approval that isn't automatic");
    }
    sealWith(store, "auto-check", input.taskId, facts.by, facts.repo, { digest: input.digest, candidate: input.candidate }, input.now,
      "the scope can't be approved automatically (its approval rules, text or check access need a person)");
    return { ok: true as const, already: false };
  });
}

/** Paths an automatic approval never ships without a person: what defines CI or the check, or steers agents. */
export function autoHarnessPath(path: string): string | null {
  const p = path.toLowerCase();
  if (/(^|\/)\.(github|claude|codex|gemini|cursor)(\/|$)/.test(p)) return "it configures CI or agents";
  if (/(^|\/)(agents|claude|gemini|security)\.md$/.test(p)) return "it's an agent or security policy file";
  if (/(^|\/)vitest\.config\.[cm]?[jt]s$/.test(p)) return "it's part of the test harness";
  if (/^scripts\/(release-check[^/]*|suite-lifecycle|provider-gate|e2e-parallel|e2e-kit|upgrade-path)\.mjs$/.test(p)) return "it's part of the release check";
  if (/^test\/(setup-state|fresh-store|temp-root|ensure-build|release-reporter)\.ts$/.test(p)) return "it's part of the test harness";
  return null;
}

/** Flakes: how many failed attempts one CI check, and how many failed release-check runs, may have before a person decides.
 * The head and digest are pinned, so between attempts only nondeterminism differs. */
export const MAX_FAILED_ATTEMPTS = 2;

/** One CI attempt that failed before its latest attempt passed, as the evidence records it. */
export type CiFailure = { id: number; name: string; conclusion: string | null };

/**
 * GitHub CI on the exact head: fresh, every required check present, and each reported check judged by its LATEST attempt
 * (highest check-run id), which must be a completed GitHub Actions success. Earlier attempts must be GitHub Actions too,
 * completed, and at most MAX_FAILED_ATTEMPTS of them failed; they are returned for the evidence.
 */
export function ciVerdict(observation: CiObservation, candidate: string, now: Date): { ok: true; failures: CiFailure[] } | { ok: false; problem: string } {
  const no = (problem: string) => ({ ok: false as const, problem });
  if (observation.head !== candidate) return no(`CI was read for ${observation.head.slice(0, 7)}, not ${candidate.slice(0, 7)}`);
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(at) || at > now.getTime() + 60_000 || now.getTime() - at > CI_OBSERVATION_MS) return no("the CI reading isn't fresh");
  const byName = new Map<string, ObservedCheckRun[]>();
  for (const run of observation.runs) {
    if (run.id === null || !Number.isSafeInteger(run.id) || run.id <= 0) return no(`${run.name} has no check run id`);
    if (run.app !== "github-actions") return no(`${run.name} was reported by ${run.app ?? "an unknown app"}, not GitHub Actions`);
    byName.set(run.name, [...(byName.get(run.name) ?? []), run]);
  }
  const missing = REQUIRED_PR_CHECKS.filter(name => !byName.has(name));
  if (missing.length > 0) return no(`required checks didn't run: ${missing.join(", ")}`);
  const failures: CiFailure[] = [];
  for (const [name, attempts] of byName) {
    const ordered = [...attempts].sort((a, b) => a.id! - b.id!);
    const latest = ordered.at(-1)!;
    if (latest.status !== "completed") return no(`${name} is ${latest.status}`);
    if (latest.conclusion !== "success") return no(`${name} ${latest.conclusion === null ? "has no conclusion" : `ended ${latest.conclusion}`}`);
    const earlier = ordered.slice(0, -1);
    if (earlier.some(one => one.status !== "completed")) return no(`an earlier attempt of ${name} hasn't finished`);
    const failed = earlier.filter(one => one.conclusion !== "success");
    if (failed.length > MAX_FAILED_ATTEMPTS) return no(`${name} failed ${failed.length} times before it passed, so a person decides`);
    failures.push(...failed.map(one => ({ id: one.id!, name, conclusion: one.conclusion })));
  }
  return { ok: true, failures };
}

/** ciVerdict's problem, or null when CI passes. */
export function ciProblem(observation: CiObservation, candidate: string, now: Date): string | null {
  const verdict = ciVerdict(observation, candidate, now);
  return verdict.ok ? null : verdict.problem;
}

/** What the change since the build's recorded base touches that an automatic approval never ships, from verified objects. */
function harnessProblem(repo: string, base: string | null, candidate: string): string | null {
  const gitDir = projectGitDir(repo);
  if (gitDir === null) return "the project's Git directory can't be read";
  if (base === null || !/^[0-9a-f]{40}$/.test(base)) return "the build recorded no base to compare with";
  const walk = verifiedFirstParentWalk(gitDir, candidate, base, 500);
  if (!walk.ok) return `${candidate.slice(0, 7)} doesn't descend from the build's base ${base.slice(0, 7)}`;
  const before = readVerifiedCommit(gitDir, base), after = readVerifiedCommit(gitDir, candidate);
  if (!before.ok || !after.ok) return "the candidate's commits can't be read";
  const diff = verifiedTreeDiff(gitDir, before.value.tree, after.value.tree);
  if (!diff.ok) return `the candidate's change can't be read: ${diff.message}`;
  for (const change of diff.value) {
    const why = autoHarnessPath(change.path);
    if (why !== null) return `${change.path} changed (${why})`;
    if (change.path === "package.json") {
      const scripts = (tree: string) => {
        const blobs = verifiedBlobs(gitDir, tree, ["package.json"]);
        if (!blobs.ok) return undefined;
        const bytes = blobs.value.get("package.json")?.bytes;
        if (bytes === undefined) return null;
        try { return JSON.stringify((JSON.parse(bytes.toString("utf8")) as { scripts?: unknown }).scripts ?? null); } catch { return undefined; }
      };
      const was = scripts(before.value.tree), now = scripts(after.value.tree);
      if (was === undefined || now === undefined || was !== now) return "package.json's scripts changed";
    }
  }
  return null;
}

/**
 * The release approval, once the check passed: seal `auto-green` over the standing `auto-check`, or refuse in words —
 * and on any refusal take the `auto-check` back, so a person decides. Everything is proven again in this one write
 * transaction (docs/plans/auto-approve-green.md, "What auto-green proves").
 */
export function sealAutoGreen(store: Store, input: {
  taskId: string; digest: string; candidate: string; run: number; receipt: string; ci: CiObservation; evidenceRoot: string; now: Date;
}): { ok: true; by: string; at: string; ci: { id: number; name: string }[] } | Refusal {
  const answer = inTransaction(store, (): { ok: true; by: string; at: string; ci: { id: number; name: string }[] } | Refusal => {
    const facts = releaseTaskFacts(store, input);
    if (!facts.ok) return facts;
    const checking = autoReleaseApprovalOf(store, input.taskId, "auto-check");
    if (!checking.ok) return refuse(`its check wasn't authorized automatically: ${checking.why}`);
    // The release check: this task's build on this digest, its native receipt, a Full level and no failed check before.
    const run = store.getRun(input.run);
    if (run === null || run.taskRef !== facts.taskRef || run.role !== "builder" || run.finishedAt === null || !(run.outcome === "built" || run.outcome === "no-change")) return refuse(`run ${input.run} isn't a finished build of this release task`);
    if (run.scopeDigest !== input.digest) return refuse(`run ${input.run} checked different scope text`);
    const head = run.headRevision;
    if (head === null) return refuse(`run ${input.run} recorded no commit`);
    if (runCheckLevel(store, run.id) !== "full") return refuse("the release check wasn't Full");
    // A flake: earlier release checks of this task may have failed, but only re-runs of the same signed scope (the
    // regate road keeps the candidate and digest), and at most MAX_FAILED_ATTEMPTS of them.
    const failedRuns = store.handle.prepare(`SELECT r.id, r.scope_digest FROM run_check c JOIN run r ON r.id = c.run
        WHERE r.task_ref = ? AND r.role = 'builder' AND c.status IS NOT NULL AND c.status <> 'passed' AND r.id <> ? ORDER BY r.id`).all(facts.taskRef, run.id);
    if (failedRuns.some(one => one["scope_digest"] !== input.digest)) return refuse("an earlier check of this release ran on different scope text, so a person decides");
    if (failedRuns.length > MAX_FAILED_ATTEMPTS) return refuse(`the release check failed ${failedRuns.length} times before it passed, so a person decides`);
    const checkFailures = failedRuns.map(one => Number(one["id"]));
    const newest = store.runsFor(facts.taskRef).find(one => one.role === "builder");
    if (newest?.id !== run.id) return refuse(`run ${input.run} isn't this task's newest build`);
    const evidence = verificationEvidence(store, input.evidenceRoot, run.id);
    if (!evidence.ok || evidence.bytes === null) return refuse(`the release check's receipt can't be read${evidence.ok ? "" : `: ${evidence.problem}`}`);
    let gate: Record<string, unknown>;
    try { gate = JSON.parse(evidence.bytes.toString()) as Record<string, unknown>; } catch { return refuse("the release check's receipt can't be read"); }
    const live = store.liveVerifyCommand(facts.repo);
    const result = gate["result"] as { ran?: unknown; exitCode?: unknown } | undefined;
    const command = gate["command"] as { command?: unknown } | undefined;
    if (gate["coverage"] !== undefined && gate["coverage"] !== "full") return refuse(`the release check didn't cover everything (${String(gate["coverage"])})`);
    if (gate["run"] !== run.id || gate["head"] !== head || gate["scopeDigest"] !== input.digest || result?.ran !== true || result.exitCode !== 0 || live === null || command?.command !== live.command) {
      return refuse("the release check didn't pass this candidate under the approved command");
    }
    const assignment = assignmentOf(store, input.taskId, input.now, { principal: "operator", repos: null, includeUnplaced: true }, input.evidenceRoot);
    const receipt = assignment?.receipt ?? null;
    if (receipt === null || receipt.runId !== run.id || receipt.digest !== input.receipt || receipt.head !== head || receipt.scopeDigest !== input.digest) return refuse("the result the release read isn't this build's");
    // The candidate's change, from verified objects: nothing that defines CI or the check, or steers agents.
    if (head !== input.candidate) {
      // A prepared candidate's build records its own commit of exactly the candidate's tree (builder.ts).
      const gitDir = projectGitDir(facts.repo);
      const built = gitDir === null ? null : readVerifiedCommit(gitDir, head), wanted = gitDir === null ? null : readVerifiedCommit(gitDir, input.candidate);
      if (built === null || wanted === null || !built.ok || !wanted.ok || built.value.tree !== wanted.value.tree) return refuse(`the build's commit ${head.slice(0, 7)} doesn't hold exactly ${input.candidate.slice(0, 7)}'s files`);
    }
    const harness = harnessProblem(facts.repo, run.baseRevision, input.candidate);
    if (harness !== null) return refuse(harness);
    // GitHub CI, as the plane's own gh saw it moments ago, on exactly this commit.
    const ci = ciVerdict(input.ci, input.candidate, input.now);
    if (!ci.ok) return refuse(`CI: ${ci.problem}`);
    const observed = input.ci.runs.map(one => ({ id: one.id!, name: one.name }));
    sealWith(store, "auto-green", input.taskId, facts.by, facts.repo, {
      digest: input.digest, candidate: input.candidate, run: run.id, receipt: input.receipt, head, base: run.baseRevision, ci: observed, observedAt: input.ci.observedAt,
      // What failed first on this same commit and digest (flakes), for whoever reads the record later.
      ciFailures: ci.failures, checkFailures,
    }, input.now, "the release terms can't be approved now (an unsettled deploy, a merge already started, or rules that need a person)");
    store.enqueueNotification({ dedupeKey: `release-auto-approved:${input.taskId}:${input.digest}`, kind: "release-auto",
      subject: `Release ${facts.version} approved automatically`,
      body: `CI and the release check passed on ${input.candidate.slice(0, 7)}, so Toolroll approved it under your project setting. It deploys, merges and publishes next.`,
      link: chatControlHref("task", input.taskId), source: { taskRef: facts.taskRef } }, input.now);
    return { ok: true as const, by: facts.by, at: input.now.toISOString(), ci: observed };
  });
  if (!answer.ok) giveUpAutoApproval(store, { taskId: input.taskId, why: answer.why, now: input.now });
  return answer;
}

/** The automatic road ended without an approval (a refusal, a failed check, a CI failure after the deploy): take the
 * `auto-check` back so the task asks a person, and tell the owner why. Idempotent. */
export function giveUpAutoApproval(store: Store, input: { taskId: string; why: string; now: Date }): void {
  store.transact(() => {
    const ref = store.lookupRef(input.taskId);
    if (ref === null) return;
    unseal(store, input.taskId);
    const scope = store.getScope(input.taskId);
    const version = scope?.releaseTerms?.packageVersion ?? null;
    store.enqueueNotification({ dedupeKey: `release-auto-stopped:${input.taskId}:${input.why.slice(0, 120)}`, kind: "release-auto", pushClass: "attention",
      subject: `Release${version === null ? "" : ` ${version}`} needs you`,
      body: `Not approved automatically: ${input.why}. Approve it yourself, or fix the branch and release the new commit.`,
      link: chatControlHref("task", input.taskId), source: { taskRef: ref.id } }, input.now);
  });
}

/** A release check failed while checking automatically: tell the owner. The `auto-check` stays, so a regate of the same
 * commit and digest (a flake) may still approve itself, within MAX_FAILED_ATTEMPTS failed runs. */
export function noteAutoCheckFailed(store: Store, input: { taskId: string; why: string; now: Date }): void {
  const ref = store.lookupRef(input.taskId);
  if (ref === null) return;
  const version = store.getScope(input.taskId)?.releaseTerms?.packageVersion ?? null;
  store.enqueueNotification({ dedupeKey: `release-auto-check-failed:${input.taskId}:${input.why.slice(0, 120)}`, kind: "release-auto", pushClass: "attention",
    subject: `Release${version === null ? "" : ` ${version}`} check failed`,
    body: `${input.why}. Rerun it on the same commit (a flake still approves itself, up to ${MAX_FAILED_ATTEMPTS} failed checks), or fix the branch and release the new commit.`,
    link: chatControlHref("task", input.taskId), source: { taskRef: ref.id } }, input.now);
}

/** "Released 0.9.x automatically": the release that approved itself finished. */
export function noteAutoRelease(store: Store, input: { taskId: string; tag: string; now: Date }): void {
  const ref = store.lookupRef(input.taskId);
  if (ref === null) return;
  store.enqueueNotification({ dedupeKey: `release-auto-released:${input.taskId}:${input.tag}`, kind: "release-auto",
    subject: `Released ${input.tag} automatically`, body: `${input.tag} is deployed, merged, tagged and published. CI and the release check passed, so nobody had to approve it.`,
    link: chatControlHref("task", input.taskId), source: { taskRef: ref.id } }, input.now);
}

/** Whether a task carries an automatic release seal (any state): it never merges or deploys outside `toolroll release`. */
export function autoReleaseSealed(store: Store, taskId: string): boolean {
  return store.handle.prepare("SELECT 1 AS hit FROM task_scope WHERE task_id = ? AND approval_basis IN ('auto-check', 'auto-green')").get(taskId) !== undefined;
}
