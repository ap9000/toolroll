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
import { fullCheckProblem, projectGitDir } from "./check-report.js";
import { sealedRun } from "./release-recheck.js";
import { runCheckLevel } from "./check-levels.js";
import { readVerifiedCommit, verifiedBlobs, verifiedTreeDiff, verifiedTreeEntries } from "./commit-extract.js";
import { EVAL_HOOK_FILES, evalHookProblem } from "./eval-hooks.js";
import { mightName, testInfrastructure, type TestInfrastructure } from "./test-infra.js";
import { chatControlHref } from "./chat-controls.js";
import { INFRA_RERUNS_PER_CANDIDATE, REQUIRED_PR_CHECKS, REQUIRED_PR_CHECKS_WORKFLOW, prChecksVerdict, type CheckFailure } from "./release.js";
import { releaseCheckStanding } from "./check-failure.js";
import { CARRY_RULES, rulePath } from "./release-carry.js";
import { AUTO_EVIDENCE_ACTION, AUTO_WITHDRAWN_ACTION, LIVE_RELEASE_STATES, RELEASE_APPROVAL_ACTION, releaseAuthorityOfTask, releaseAutoApproves, type ReleaseApprovalSetting, releaseApprovalSetting } from "./release-authority.js";
import { autoReleaseApprovalOf, personApprovalOf } from "./scope.js";
import { releaseOperations, revokeRelease, type Store } from "./store.js";
import { RELEASE_CI_HELD_ACTION, RELEASE_CI_PASSED_ACTION, RELEASE_CI_RUNNING_WORDS, releaseCiHoldOf, releaseCiRunningOf } from "./release-ci-hold.js";
import { verificationEvidence } from "./verification-evidence.js";
import { nightlyDebtHold } from "./nightly-github.js";

export { RELEASE_APPROVAL_ACTION, releaseApprovalSetting, releaseAutoApproves, type ReleaseApprovalSetting };

/** The setting's words, one place. */
export const RELEASE_APPROVAL_WORDS = { ask: "Ask me", auto: "Approve automatically when checks pass" } as const;
/** How old the plane's own CI observation may be when it seals. */
export const CI_OBSERVATION_MS = 5 * 60_000;

/** One check run on the candidate as the plane's own `gh` reported it (oldest first). */
export type ObservedCheckRun = { id: number | null; name: string; status: string; conclusion: string | null; app: string | null; suite?: number | null; head?: string | null; workflow?: number | null;
  /** The workflow's file (GitHub's workflow-run `path`): a required check counts only from its own (REQUIRED_PR_CHECKS_WORKFLOW). */
  workflowPath?: string | null;
  /** GitHub's job record shows this unsuccessful attempt ended before any workflow step ran (release-adapters.ts). */
  beforeTests?: boolean | null };
/** The plane's own look at GitHub CI for one commit (release-adapters.ts makes it, right before the seal). */
export type CiObservation = { head: string; observedAt: string; runs: readonly ObservedCheckRun[];
  /** Whether the history is whole (fewer check suites than GitHub's check-runs ceiling): false or absent refuses. */
  complete?: boolean };

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
        const a = found?.authority ?? null;
        if (a !== null && a.state === "merged") continue;
        if (a !== null && a.state === "merge-reserved") {
          // A merge already issued (running, or its outcome unknown) is genuinely in flight: it finishes through its own
          // reconciliation. One only reserved, never issued, is stopped for good here, so it can't come back.
          const issued = releaseOperations(store, a.id).some(op => op.kind === "merge" && (op.state === "running" || op.state === "unknown" || op.state === "succeeded"));
          if (issued) {
            // In flight: it reconciles on its own (merged finishes; failed goes back to deploying) — but the seal is
            // withdrawn now, so a failed merge never regains the automatic approval, even with the setting back on.
            withdraw(store, taskId, now);
            continue;
          }
          store.handle.prepare("UPDATE release_authority SET state = 'revoked', ended_at = ?, ended_by = ?, rev = rev + 1 WHERE id = ? AND rev = ?")
            .run(now.toISOString(), `${by}: automatic release approval turned off`, a.id, a.rev);
          store.recordAction({ at: now.toISOString(), actor: by, repo: a.repo, taskId, runId: null, action: "release revoked", outcome: "revoked", source: "work", detail: `release ${a.id}: automatic release approval turned off before its merge was issued` });
        } else if (a !== null && LIVE_RELEASE_STATES.includes(a.state)) revokeRelease(store, a.id, `${by}: automatic release approval turned off`, now);
        unseal(store, taskId, now);
        withdrawn.push(taskId);
        store.enqueueNotification({ dedupeKey: `release-auto-withdrawn:${taskId}:${now.toISOString()}`, kind: "release-auto", subject: "Release needs your approval",
          body: "Automatic release approval was turned off, so this release waits for a person's approval.", link: chatControlHref("task", taskId), source: { taskRef: store.lookupRef(taskId)!.id } }, now);
      }
    }
    store.bumpWake();
    return { changed: true, withdrawn };
  });
}

/** Take back an automatic seal for good: the task asks a person again (its result, if any, is kept), and its evidence is
 * marked withdrawn, so no later reading — the setting turned on again included — lets it stand. */
function unseal(store: Store, taskId: string, now: Date): void {
  withdraw(store, taskId, now);
  store.handle.prepare(`UPDATE task_scope SET approved_at = NULL, approved_by = NULL, approved_digest = NULL, approved_profile_json = NULL,
      approved_route_json = NULL, approval_basis = NULL, mode_digest = NULL WHERE task_id = ? AND approval_basis IN ('auto-check', 'auto-green')`).run(taskId);
}

/** Mark a task's automatic seal's evidence withdrawn for good (its seal row may stay while an issued merge reconciles). */
function withdraw(store: Store, taskId: string, now: Date): void {
  const sealedWith = store.handle.prepare("SELECT mode_digest FROM task_scope WHERE task_id = ? AND approval_basis IN ('auto-check', 'auto-green')").get(taskId)?.["mode_digest"];
  if (typeof sealedWith === "string") store.recordAction({ at: now.toISOString(), actor: "toolroll", repo: store.lookupRef(taskId)?.repo ?? null, taskId, runId: null, action: AUTO_WITHDRAWN_ACTION, outcome: sealedWith, source: "work" });
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
export function authorizeAutoCheck(store: Store, input: { taskId: string; digest: string; candidate: string;
  /** Where the candidate left its release's base branch, as the plane read it from GitHub (release-adapters.ts
   * readMergeBase): the one comparison base every check of this commit is judged against. Never a task branch. */
  base: string; now: Date }): { ok: true; already: boolean } | Refusal {
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
    if (!/^[0-9a-f]{40}$/.test(input.base)) return refuse("GitHub named no base for this commit");
    const gitDir = projectGitDir(facts.repo);
    if (gitDir === null || !readVerifiedCommit(gitDir, input.base).ok) return refuse(`the base ${input.base.slice(0, 7)} isn't in the project's own Git directory`);
    sealWith(store, "auto-check", input.taskId, facts.by, facts.repo, { digest: input.digest, candidate: input.candidate, base: input.base }, input.now,
      "the scope can't be approved automatically (its approval rules, text or check access need a person)");
    return { ok: true as const, already: false };
  });
}

/** Test infrastructure that lives under src/ (helpers and fixtures, not tests): a person approves changes to it. */
const SRC_TEST_INFRA = /^src\/(fixtures\/|(.*\/)?(test-[^/]*|[^/]*-test-support[^/]*|[^/]*fixtures?[^/]*)\.[cm]?[jt]sx?$)/;
/** A test file (normalized path): `*.test.ts`, never inside a fixtures folder. */
const TEST_FILE = /^(?!.*(^|\/)fixtures?\/)[^]*\.test\.ts$/;

/** The eval set's and GitHub nightly's policy code (docs/plans/evals-nightly.md, part C, finding 10): the cases and
 * oracles, the evaluator, its gate, hooks and world, reviewer scoring, nightly ingestion, their contracts, and the
 * accounting readings evals trust (reported-usage.ts, run-efficiency.ts). Where they are called from, and the store's
 * accounting reads, are held by eval-hooks.ts instead (evalHookProblem). */
const EVAL_POLICY = /^(evals\/|src\/evals[^/]*\.ts$|src\/eval-[^/]*\.ts$|src\/reviewer-evals\.ts$|src\/nightly-github\.ts$|src\/contracts\/evals[^/]*\.ts$|src\/reported-usage\.ts$|src\/run-efficiency\.ts$)/;

/** Build or type configuration anywhere: a person approves it. */
const BUILD_CONFIG = /(^|\/)(tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|\.npmrc|\.nvmrc|\.node-version)$/;

/**
 * What an automatic approval may ship without a person, as an allowlist over each changed path (auto-approve-green.md):
 * product code under `src/` (its tests included; never its test helpers or fixtures, nor build configuration), test files
 * under `test/` (only `*.test.ts`: never a helper, fixture or setup file; deleting any test needs a person), docs
 * (never the testing policy or plans, never agent or security policy), the changelog and README, and a version bump of
 * package.json and package-lock.json. Everything else — CI, scripts (the check, the build, the harness), test/,
 * dependencies, the lockfile beyond its version, config — and every path the release carry rules never carry, needs a
 * person. Null when the path may ship.
 */
export function autoPathProblem(path: string): string | null {
  const normal = rulePath(path);
  const testUnderTest = TEST_FILE.test(normal) && normal.startsWith("test/");
  // Every deny rule first — the carry rules' never list (minus its blanket test/ rule, for test files there only) and
  // build configuration — so a test file can't slip a policy or CI path through (test/attacks/.github/a.test.ts).
  for (const rule of CARRY_RULES.never) {
    if (testUnderTest && rule.matches("test/__probe__.test.ts")) continue;
    if (rule.matches(normal)) return rule.why;
  }
  // Test files under test/ carry the same trust as src's (Alex: test authors are trusted) — only the `.test.ts` files
  // themselves, never a helper, fixture, setup or config file beside them, nor one inside a fixtures folder.
  if (EVAL_POLICY.test(normal)) return "it's eval or nightly policy code";
  if (testUnderTest) return null;
  if (BUILD_CONFIG.test(normal)) return "it configures the build or the checks";
  if (normal === "package.json" || normal === "package-lock.json") return null;
  if (normal.startsWith("src/")) return SRC_TEST_INFRA.test(normal) ? "it's a test helper or fixture" : null;
  if (normal === "changelog.md" || normal === "readme.md") return null;
  if (normal.startsWith("docs/") && normal.endsWith(".md")) return null;
  return "it's outside what a release approves itself for (product code, tests, docs, the changelog and a version bump)";
}

/** One CI attempt that failed before its job's latest attempt passed (GitHub showed its runner failing before the
 * tests ran), as the evidence records it. */
export type CiFailure = CheckFailure;

/**
 * GitHub CI on the exact head, as the plane read it (every attempt): fresh, every run GitHub Actions, and the same
 * verdict every later release boundary uses (release.ts prChecksVerdict: exact head, each job by its latest attempt,
 * every required check present), where an earlier failure stands only as confirmed infrastructure (GitHub's job record
 * shows it ended before any workflow step ran), at most INFRA_RERUNS_PER_CANDIDATE of them. The tolerated failures are
 * returned for the evidence.
 */
export function ciVerdict(observation: CiObservation, candidate: string, now: Date): { ok: true; failures: CiFailure[] } | { ok: false; problem: string } {
  const no = (problem: string) => ({ ok: false as const, problem });
  if (observation.head !== candidate) return no(`CI was read for ${observation.head.slice(0, 7)}, not ${candidate.slice(0, 7)}`);
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(at) || at > now.getTime() + 60_000 || now.getTime() - at > CI_OBSERVATION_MS) return no("the CI reading isn't fresh");
  if (observation.complete !== true) return no("GitHub's check history of this commit can't be read whole");
  const other = observation.runs.find(run => run.app !== "github-actions");
  if (other !== undefined) return no(`${other.name} was reported by ${other.app ?? "an unknown app"}, not GitHub Actions`);
  const verdict = prChecksVerdict(observation.runs, candidate, REQUIRED_PR_CHECKS, { auto: true, workflow: REQUIRED_PR_CHECKS_WORKFLOW });
  if (verdict.state === "failed") return no(verdict.failed.join(", "));
  if (verdict.state === "pending") return no(`not finished: ${verdict.waiting.join(", ")}`);
  return { ok: true, failures: verdict.failures };
}

/** ciVerdict's problem, or null when CI passes. */
export function ciProblem(observation: CiObservation, candidate: string, now: Date): string | null {
  const verdict = ciVerdict(observation, candidate, now);
  return verdict.ok ? null : verdict.problem;
}

/** package.json or package-lock.json with only its version fields left out, canonical (sorted keys); undefined when it
 * can't be read. */
function withoutVersion(path: string, bytes: Buffer | undefined): string | null | undefined {
  if (bytes === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const copy = structuredClone(parsed) as Record<string, unknown>;
  delete copy["version"];
  if (path === "package-lock.json") {
    const root = (copy["packages"] as Record<string, Record<string, unknown>> | undefined)?.[""];
    if (root !== undefined && typeof root === "object" && root !== null) delete root["version"];
  }
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return JSON.stringify(canonical(copy));
}

/** The test infrastructure of one verified tree: its source files under src/ and test/ and its vitest configs, scanned. */
function infrastructureAt(gitDir: string, tree: string): TestInfrastructure | null {
  const entries = verifiedTreeEntries(gitDir, tree);
  if (!entries.ok) return null;
  const files = entries.value.filter(one => one.mode === "100644" || one.mode === "100755");
  const paths = files.filter(one => (/\.(?:[cm]?[jt]sx?)$/.test(one.path) && !one.path.startsWith("node_modules/")) || one.path === "tsconfig.json" || one.path === "package.json").map(one => one.path);
  const blobs = verifiedBlobs(gitDir, tree, paths);
  if (!blobs.ok) return null;
  try { return testInfrastructure(new Map([...blobs.value].map(([path, blob]) => [path, blob.bytes.toString("utf8")])), new Set(entries.value.map(one => one.path))); }
  catch { return null; }
}

/** What the candidate changes since `base` (the plane's own reading of where it left its base branch), from verified
 * objects, that an automatic approval never ships. Null when every change may ship. */
function changeProblem(repo: string, base: string | null, candidate: string): string | null {
  const gitDir = projectGitDir(repo);
  if (gitDir === null) return "the project's Git directory can't be read";
  if (base === null || !/^[0-9a-f]{40}$/.test(base)) return "no base was recorded to compare with";
  const before = readVerifiedCommit(gitDir, base), after = readVerifiedCommit(gitDir, candidate);
  if (!before.ok || !after.ok) return "the candidate's commits can't be read";
  const diff = verifiedTreeDiff(gitDir, before.value.tree, after.value.tree);
  if (!diff.ok) return `the candidate's change can't be read: ${diff.message}`;
  // Test infrastructure found from the import graph (test-infra.ts), at the base — which the candidate can't rewrite —
  // and at the candidate (a new helper only tests import). Unreadable: refuse.
  const scans: TestInfrastructure[] = [];
  for (const tree of [before.value.tree, after.value.tree]) {
    const found = infrastructureAt(gitDir, tree);
    if (found === null) return "the tests' imports can't be read";
    scans.push(found);
  }
  const infra = new Set(scans.flatMap(one => [...one.infra]));
  // The eval and nightly enforcement calls the base holds must all still be in place at the candidate (eval-hooks.ts).
  // One verified read of every listed file per tree (an unreadable tree reads as every file missing: a person decides).
  const blobAt = (tree: string) => { const blobs = verifiedBlobs(gitDir, tree, EVAL_HOOK_FILES); return (file: string): Buffer | null => blobs.ok ? blobs.value.get(file)?.bytes ?? null : null; };
  const hooks = evalHookProblem(blobAt(after.value.tree), blobAt(before.value.tree));
  if (hooks !== null) return `${hooks}: a person decides`;
  for (const change of diff.value) {
    const modes = [change.before?.mode, change.after?.mode].filter((one): one is string => one !== undefined);
    if (modes.includes("120000") || modes.includes("160000")) return `${change.path} is a symlink or submodule`;
    // Taking a test away is never automatic, wherever it lives.
    if (change.kind === "deleted" && TEST_FILE.test(rulePath(change.path))) return `${change.path} was deleted (removing a test needs a person)`;
    if (change.before !== null && TEST_FILE.test(rulePath(change.path))) {
      // Counts cannot prove that an assertion survived: replacing it, commenting it out, or skipping its case can
      // leave the counts unchanged. Only append-only additions preserve the existing code without interpretation.
      // Both copies come from verified trees; no report or candidate-provided file list decides this permission.
      const was = verifiedBlobs(gitDir, before.value.tree, [change.path]);
      const now = verifiedBlobs(gitDir, after.value.tree, [change.path]);
      if (!was.ok || !now.ok) return `${change.path}'s existing test code couldn't be read (a person decides)`;
      const original = was.value.get(change.path)?.bytes, revised = now.value.get(change.path)?.bytes;
      if (original === undefined || revised === undefined || !revised.subarray(0, original.length).equals(original)) {
        return `${change.path} changes existing test code (removing or rewriting tests needs a person)`;
      }
    }
    const why = autoPathProblem(change.path);
    if (why !== null) return `${change.path} changed (${why})`;
    if (infra.has(change.path)) return `${change.path} changed (tests import it and the product doesn't: it's test infrastructure)`;
    // An import the tests make that couldn't be resolved might name this file: fail closed.
    for (const scan of scans) {
      const open = scan.unresolved.find(one => mightName(one, change.path, scan));
      if (open !== undefined) return `${change.path} changed, and ${open.from} imports ${open.specifier === null ? "a computed path" : open.specifier}, which couldn't be resolved and might name it`;
    }
    const normal = rulePath(change.path);
    if (normal === "package.json" || normal === "package-lock.json") {
      const read = (tree: string) => { const blobs = verifiedBlobs(gitDir, tree, [change.path]); return blobs.ok ? withoutVersion(normal, blobs.value.get(change.path)?.bytes) : undefined; };
      const was = read(before.value.tree), now = read(after.value.tree);
      if (was === undefined || now === undefined || was !== now) return `${change.path} changed beyond its version (dependencies or scripts need a person)`;
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
  /** Whether main's protection holds for the account that merges (release-adapters.ts readMainProtection), as the plane's gh read it just now (null: unreadable). */
  mainUpToDate: boolean | null;
}): { ok: true; by: string; at: string; ci: { id: number; name: string }[] } | Refusal {
  const answer = inTransaction(store, (): { ok: true; by: string; at: string; ci: { id: number; name: string }[] } | Refusal => {
    const facts = releaseTaskFacts(store, input);
    if (!facts.ok) return facts;
    // Head-only CI is the merged tree only when GitHub itself refuses a branch behind main (eval-harness review 1,
    // finding 4): without that setting nothing approves itself.
    if (input.mainUpToDate !== true) return refuse(input.mainUpToDate === null
      ? "GitHub's branch protection for main couldn't be read, so whether it refuses a branch behind main is unknown"
      : "main's branch protection doesn't hold for the account that merges: it must require branches to be up to date, require the release's checks, and allow no bypass (\"Do not allow bypassing the above settings\")");
    const checking = autoReleaseApprovalOf(store, input.taskId, "auto-check");
    if (!checking.ok) return refuse(`its check wasn't authorized automatically: ${checking.why}`);
    // The release check: this task's build on this digest, its native receipt, a Full level and no failed check before.
    const run = store.getRun(input.run);
    if (run === null || run.taskRef !== facts.taskRef || run.role !== "builder" || run.finishedAt === null || !(run.outcome === "built" || run.outcome === "no-change")) return refuse(`run ${input.run} isn't a finished build of this release task`);
    if (run.scopeDigest !== input.digest) return refuse(`run ${input.run} checked different scope text`);
    const head = run.headRevision;
    if (head === null) return refuse(`run ${input.run} recorded no commit`);
    if (runCheckLevel(store, run.id) !== "full") return refuse("the release check wasn't Full");
    // Earlier builds of this task that didn't finish built with a passed check (a failed check, a check that never ran,
    // a build that failed or was interrupted) stand only as confirmed infrastructure the release itself reran on the
    // same signed scope, at most INFRA_RERUNS_PER_CANDIDATE (check-failure.ts): a failing test, an unexplained failure
    // or a real-model journey before the pass means a person decides. So does anything that passed only on a retry.
    const failedRuns = store.handle.prepare(`SELECT r.id, r.scope_digest FROM run r LEFT JOIN run_check c ON c.run = r.id
        WHERE r.task_ref = ? AND r.role = 'builder' AND r.id <> ?
          AND NOT (COALESCE(r.outcome, '') IN ('built', 'no-change') AND COALESCE(c.status, '') = 'passed') ORDER BY r.id`).all(facts.taskRef, run.id);
    if (failedRuns.some(one => one["scope_digest"] !== input.digest)) return refuse("an earlier check of this release ran on different scope text, so a person decides");
    if (failedRuns.some(one => Number(one["id"]) > run.id)) return refuse(`run ${input.run} isn't this task's newest build`);
    const standing = releaseCheckStanding(store, input.evidenceRoot, { taskId: input.taskId, run: run.id });
    if (!standing.ok) return refuse(standing.why);
    // Unknown is never "no retries" (eval-harness review 1, finding 3).
    if (standing.retried === null) return refuse("the release check's retry record can't be read (its report or receipt is missing or damaged), so whether anything passed only on a retry is unknown and a person decides");
    if (standing.retried.length > 0) return refuse(`the release check passed only on a retry (${standing.retried.slice(0, 3).join(", ")}${standing.retried.length > 3 ? ", …" : ""}), so a person decides`);
    if (failedRuns.length > INFRA_RERUNS_PER_CANDIDATE) return refuse(`the release check failed ${failedRuns.length} times before it passed, so a person decides`);
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
    // A readable, valid report and inventory of a Full attempt, the receipt's own, every obligation accounted for, and
    // the retry summary sealed in the receipt: an automatic approval never stands on evidence it can't read.
    const check = gate["check"] as { attempt?: unknown; report?: unknown; inventory?: unknown; retried?: unknown } | undefined;
    const sealed = sealedRun(store, input.evidenceRoot, run.id);
    if (check === undefined || sealed === null || sealed.attempt.mode !== "full" || check.attempt !== "full" || sealed.report === null || sealed.inventory === null || sealed.reportDigest !== check.report) {
      return refuse("the release check's sealed report or inventory can't be read, so what it ran and retried is unknown");
    }
    const incomplete = fullCheckProblem({ report: sealed.report, inventory: sealed.inventory, exitCode: typeof result?.exitCode === "number" ? result.exitCode : null });
    if (incomplete !== null) return refuse(`the release check has no complete result: ${incomplete}`);
    if (!Array.isArray(check.retried)) return refuse("the release check's receipt has no sealed retry record, so a person decides");
    // Belt to the retry record (finding 6): a check that passed only on a rerun after the recovery setup never approves
    // itself — its first failure isn't confirmed infrastructure.
    if ((result as { setupReplayed?: unknown } | undefined)?.setupReplayed === true) return refuse("the release check passed only when it was run again after the approved setup, so a person decides");
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
    // Compared with where the candidate left its base branch, as the plane read it when the check was authorized —
    // the same base for every attempt, never a build's own recorded base (a task branch can be seeded ahead of time).
    const base = checking.evidence.base;
    const changed = changeProblem(facts.repo, base, input.candidate);
    if (changed !== null) return refuse(changed);
    // GitHub CI, as the plane's own gh saw it moments ago, on exactly this commit.
    // GitHub's nightly lane debt (evals-nightly.md, part A2): dormant while automatic approval is refused, held here too.
    const nightly = nightlyDebtHold(store, { repo: facts.repo, taskId: input.taskId, candidate: input.candidate, phase: "auto", release: true, now: input.now });
    if (nightly !== null) return refuse(nightly.why);
    const ci = ciVerdict(input.ci, input.candidate, input.now);
    if (!ci.ok) return refuse(`CI: ${ci.problem}`);
    const observed = input.ci.runs.map(one => ({ id: one.id!, name: one.name, suite: one.suite ?? null }));
    sealWith(store, "auto-green", input.taskId, facts.by, facts.repo, {
      digest: input.digest, candidate: input.candidate, run: run.id, receipt: input.receipt, head, base, ci: observed, observedAt: input.ci.observedAt,
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
    unseal(store, input.taskId, input.now);
    const scope = store.getScope(input.taskId);
    const version = scope?.releaseTerms?.packageVersion ?? null;
    // Still waiting for CI (round 1, finding 4): nobody is asked to approve yet; `liftCiHold` asks once CI passed.
    const ciHold = releaseCiHoldOf(store, input.taskId);
    if (ciHold !== null) {
      store.enqueueNotification({ dedupeKey: `release-auto-stopped:${input.taskId}:${input.why.slice(0, 120)}`, kind: "release-auto",
        subject: `Release${version === null ? "" : ` ${version}`} won't approve itself`,
        body: `Not approved automatically: ${input.why}. GitHub CI is still running on ${ciHold.candidate?.slice(0, 7) ?? "its commit"}; you're asked to approve it once CI passes.`,
        link: chatControlHref("task", input.taskId), source: { taskRef: ref.id } }, input.now);
      return;
    }
    // Filed while CI runs (Alex, 2026-10-29): a person may approve now; nothing deploys until CI passes.
    const running = releaseCiRunningOf(store, input.taskId) === null ? "" : ` ${RELEASE_CI_RUNNING_WORDS}`;
    store.enqueueNotification({ dedupeKey: `release-auto-stopped:${input.taskId}:${input.why.slice(0, 120)}`, kind: "release-auto", pushClass: "attention",
      subject: `Release${version === null ? "" : ` ${version}`} needs you`,
      body: `Not approved automatically: ${input.why}. Approve it yourself, or fix the branch and release the new commit.${running}`,
      link: chatControlHref("task", input.taskId), source: { taskRef: ref.id } }, input.now);
  });
}

/** A release check failed while checking automatically: tell the owner. The `auto-check` stays: a rerun the release
 * itself made after confirmed infrastructure may still approve itself; any other failure means a person decides. */
export function noteAutoCheckFailed(store: Store, input: { taskId: string; why: string; now: Date }): void {
  const ref = store.lookupRef(input.taskId);
  if (ref === null) return;
  const version = store.getScope(input.taskId)?.releaseTerms?.packageVersion ?? null;
  store.enqueueNotification({ dedupeKey: `release-auto-check-failed:${input.taskId}:${input.why.slice(0, 120)}`, kind: "release-auto", pushClass: "attention",
    subject: `Release${version === null ? "" : ` ${version}`} check failed`,
    body: `${input.why}. Only a failure Toolroll confirmed as its own infrastructure is checked again automatically; for anything else, approve it yourself or fix the branch and release the new commit.`,
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

/** The plane's record that an automatic release's publication waits for a person (CI stopped passing after its merge),
 * and a person's answer. The newest row for the task wins. */
export const PUBLISH_HELD_ACTION = "release publish held";
export const PUBLISH_ALLOWED_ACTION = "release publish allowed";

export function holdAutoPublish(store: Store, input: { taskId: string; why: string; now: Date }): void {
  store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: store.lookupRef(input.taskId)?.repo ?? null, taskId: input.taskId, runId: null,
    action: PUBLISH_HELD_ACTION, outcome: "held", source: "work", detail: input.why });
}

/** Why the release's tag, publication and Homebrew wait for a person, or null. */
export function autoPublishHeld(store: Store, taskId: string): string | null {
  const row = store.handle.prepare("SELECT action, detail FROM action_ledger WHERE task_id = ? AND action IN (?, ?) ORDER BY id DESC LIMIT 1").get(taskId, PUBLISH_HELD_ACTION, PUBLISH_ALLOWED_ACTION);
  return row === undefined || row["action"] !== PUBLISH_HELD_ACTION ? null : String(row["detail"] ?? "This release's publication waits for a person");
}

/** A person lets a held publication go on: the caller proved a person (never the lead, a token or a mode). */
export function allowAutoPublish(store: Store, input: { taskId: string; by: string; now: Date }): { ok: true } | Refusal {
  if (autoPublishHeld(store, input.taskId) === null) return refuse("nothing about this release waits for a person");
  store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: store.lookupRef(input.taskId)?.repo ?? null, taskId: input.taskId, runId: null,
    action: PUBLISH_ALLOWED_ACTION, outcome: "allowed", source: "request", detail: `${input.by} lets the release's tag, publication and Homebrew go on` });
  return { ok: true };
}

/**
 * A release filed while its pull request's CI still ran (pipeline-speed.md D2): hold every approval but the automatic
 * road's until the plane reads exact-head CI passing (Codex review round 1, finding 4). Recorded before the task is
 * filed, so no moment exists where the filed task is approvable with CI pending. Idempotent.
 */
export function holdApprovalForCi(store: Store, input: { taskId: string; candidate: string; now: Date }): void {
  if (!/^[0-9a-f]{40}$/.test(input.candidate)) throw new Error("a CI hold needs the exact candidate commit");
  const held = releaseCiHoldOf(store, input.taskId);
  if (held !== null && held.candidate === input.candidate) return;
  store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: store.lookupRef(input.taskId)?.repo ?? null, taskId: input.taskId, runId: null,
    action: RELEASE_CI_HELD_ACTION, outcome: "held", source: "work", detail: input.candidate });
}

/**
 * Lift a release's CI hold (an older coordinator's) or end its "CI still running" note on the plane's own reading of
 * GitHub CI (never the coordinator's word): fresh, whole, every run GitHub Actions, on exactly the held candidate, and
 * every required check passed (release.ts prChecksVerdict, as a person's road judges it: a person decides about earlier
 * attempts). With `ask`, the owner of a held release is told it needs them now. Nothing held or noted is a pass.
 */
export function liftCiHold(store: Store, input: { taskId: string; candidate: string; ci: CiObservation; ask: boolean; now: Date }): { ok: true } | Refusal {
  return store.transact(() => {
    const held = releaseCiHoldOf(store, input.taskId);
    const waiting = held ?? releaseCiRunningOf(store, input.taskId);
    if (waiting === null) return { ok: true as const };
    if (waiting.candidate !== input.candidate) return refuse(`the release waits for CI on ${waiting.candidate?.slice(0, 7) ?? "an unreadable commit"}, not ${input.candidate.slice(0, 7)}`);
    const ci = input.ci;
    if (ci.head !== input.candidate) return refuse(`CI was read for ${ci.head.slice(0, 7)}, not ${input.candidate.slice(0, 7)}`);
    const at = Date.parse(ci.observedAt);
    if (!Number.isFinite(at) || at > input.now.getTime() + 60_000 || input.now.getTime() - at > CI_OBSERVATION_MS) return refuse("the CI reading isn't fresh");
    if (ci.complete !== true) return refuse("GitHub's check history of this commit can't be read whole");
    const other = ci.runs.find(run => run.app !== "github-actions");
    if (other !== undefined) return refuse(`${other.name} was reported by ${other.app ?? "an unknown app"}, not GitHub Actions`);
    const verdict = prChecksVerdict(ci.runs, input.candidate, REQUIRED_PR_CHECKS, { workflow: REQUIRED_PR_CHECKS_WORKFLOW });
    if (verdict.state === "failed") return refuse(`CI failed: ${verdict.failed.join(", ")}`);
    if (verdict.state === "pending") return refuse(`CI hasn't finished: ${verdict.waiting.join(", ")}`);
    const ref = store.lookupRef(input.taskId);
    store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: ref?.repo ?? null, taskId: input.taskId, runId: null,
      action: RELEASE_CI_PASSED_ACTION, outcome: "passed", source: "work", detail: input.candidate });
    if (input.ask && held !== null && ref !== null) {
      const version = store.getScope(input.taskId)?.releaseTerms?.packageVersion ?? null;
      store.enqueueNotification({ dedupeKey: `release-ci-passed:${input.taskId}:${input.candidate}`, kind: "release-auto", pushClass: "attention",
        subject: `Release${version === null ? "" : ` ${version}`} needs you`,
        body: `GitHub CI passed on ${input.candidate.slice(0, 7)}. Approve it yourself, or fix the branch and release the new commit.`,
        link: chatControlHref("task", input.taskId), source: { taskRef: ref.id } }, input.now);
    }
    return { ok: true as const };
  });
}
