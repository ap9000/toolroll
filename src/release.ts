/**
 * `toolroll release <branch>` (D10): the whole release of Toolroll itself as one resumable command. The owner's
 * approval of the release scope is the only human step; everything else runs headless, each waiting step with a time
 * limit:
 *
 *   gate → approval → check → complete → quiet → deploy → link → ci → merge → tree → tag → publish → homebrew → done
 *
 * gate, before filing a task for that commit, looks at the pull request's required checks on it: one that failed stops
 * the release before anything is filed or sent for approval; it waits, naming them, for checks not started or still
 * running, and stops if they don't finish within its limit (a task already filed is not looked at again; ci checks
 * once more before merging). It then files a prepared-candidate task pinned to the branch's exact commit, with the full
 * release check. approval
 * waits for an active approver's yes to that exact scope (never a mode's, an AI's or the lead's). check requires a Full
 * result of that commit: a failed check stops the release and stays visible, nothing reruns it. complete marks that
 * exact result Complete through the task's own authorization. quiet waits until nothing builds. deploy runs the
 * candidate's own deploy (scripts/deploy-browser.mjs: drain, backup, rehearsal, swap, health) and keeps the runtime its
 * final JSON names; an interrupted one is recovered from its saved stage (--phase recover) before anything else. link
 * points both CLI names at that runtime's bin.js, putting them back if either doesn't answer, and goes on only when
 * the console, worker and both names run the gated commit. ci waits for every
 * reported pull-request check on that same commit to pass, with every required check present: pending, missing,
 * skipped or failed never merges. merge
 * squash-merges with the head pinned to the gated commit, tree proves main's new commit has exactly the gated tree,
 * and only then tag pushes the version tag, whose macOS matrix must pass before npm publication (publish.yml). publish
 * waits for npm, the GitHub release and the macOS checks; homebrew updates the tap's formula and merges it (after its checks, when the tap runs any).
 *
 * A private journal (mode 0600, written whole then renamed) records what each step is about to do before it does
 * anything outside this machine, and what it saw after. A stop — a time limit, a failure, a crash, Ctrl-C — leaves the
 * journal at its step; running the same command again finds what already happened (the task, the completion, the
 * merge, the tag, the package, the tap change) instead of doing it twice, and continues from the first unfinished
 * step. A branch, pull request or tag that no longer matches what was gated stops the release rather than guess.
 *
 * Everything outside this module is an adapter (release-adapters.ts), so the state machine is tested without git,
 * GitHub, npm or a running Toolroll.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { personProof } from "./person-proof.js";
import { RELEASE_CI_RUNNING_WORDS as CI_RUNNING_WORDS } from "./release-ci-hold.js";

/** The pull-request checks a release waits for, by exact job name (.github/workflows/ci.yml). Every one must have
 * concluded `success` on the gated commit; src/ci-workflow.test.ts holds the workflow to this list. */
export const REQUIRED_PR_CHECKS = [
  "node 22 · ubuntu-latest",
  "node 24 · ubuntu-latest",
  "linux native containment · delegated cgroup v2",
  "linux fence · sandbox-runtime",
  "Windows Job Object containment",
  // The git lanes (ci.yml job "git"): the declared floor (git-floor.ts) and Debian trixie's 2.47.
  "git 2.41 · debian trixie",
  "git 2.47 · debian trixie",
] as const;
/** The workflow file every REQUIRED_PR_CHECKS job belongs to: a job of that name from any other workflow (a lookalike
 * added beside it) never stands for it (Codex review round 1, inherited CI limitation). */
export const REQUIRED_PR_CHECKS_WORKFLOW = ".github/workflows/ci.yml";
/**
 * The pull-request checks main's GitHub protection is not yet required to name (eval-harness review 2, finding 1): the
 * git lanes join main's protection once they have run there, so a protection without them is reported, never refused.
 * A later release empties this list; from then on main's protection must name every REQUIRED_PR_CHECKS check.
 */
export const PROTECTION_REPORT_ONLY_CHECKS: readonly string[] = ["git 2.41 · debian trixie", "git 2.47 · debian trixie"];
/** The checks main's protection must require at minimum: every required check that isn't report-only. */
export const PROTECTION_MINIMUM_CHECKS: readonly string[] = REQUIRED_PR_CHECKS.filter(name => !PROTECTION_REPORT_ONLY_CHECKS.includes(name));
/**
 * Main's protection as the plane's gh reads it (release-adapters.ts readMainProtection): `effective` only when one layer
 * (classic protection or one active ruleset) requires up-to-date branches, binds every PROTECTION_MINIMUM_CHECKS check to GitHub Actions,
 * and nobody merging as this gh can bypass it. `missing` names each absent property; `notYetRequired` the report-only
 * checks the effective layer doesn't name.
 */
export type MainProtection = { effective: boolean; missing: string[]; notYetRequired: string[] };
/** The checks a release tag runs (.github/workflows/publish.yml), awaited before Homebrew moves. */
export const RELEASE_TAG_CHECKS = ["node 22 · macos-latest", "node 24 · macos-latest", "publish"] as const;

export const RELEASE_STEPS = ["gate", "approval", "check", "complete", "quiet", "deploy", "link", "ci", "merge", "tree", "tag", "publish", "homebrew", "done"] as const;
export type ReleaseStep = typeof RELEASE_STEPS[number];
type WaitingStep = "gate" | "approval" | "check" | "quiet" | "deploy" | "ci" | "publish" | "homebrew";
/** How long each waiting step may take, in minutes, before the release stops there (rerunning continues from it). */
export const RELEASE_LIMITS: Readonly<Record<WaitingStep, number>> = { gate: 60, approval: 24 * 60, check: 120, quiet: 60, deploy: 30, ci: 60, publish: 45, homebrew: 45 };
const POLL_MS = 15_000;

/** One check attempt; `app` is the GitHub App that made it (github-actions for a workflow), when known; `id` its check
 * run id, `suite` its check suite (one workflow run: its re-runs stay in it) and `head` the commit GitHub filed it
 * under, when known. */
export type CheckRun = { name: string; status: string; conclusion: string | null; app?: string | null; id?: number | null; suite?: number | null; head?: string | null;
  /** The workflow (its id, from GitHub's workflow-run API) that this check's suite is a run of, when known. */
  workflow?: number | null;
  /** That workflow's file in the repository (GitHub's workflow-run `path`), when known. */
  workflowPath?: string | null;
  /** GitHub's own job record (its steps, read by the plane's gh) shows this unsuccessful attempt ended before any of the
   * workflow's own steps ran: the runner failed, not the tests. Absent or false: nothing shows that. */
  beforeTests?: boolean | null };

/**
 * Failure classes replace a flat flake allowance (docs/plans/eval-harness.md; check-failure.ts says the classes): only a
 * failure the plane itself confirmed as infrastructure is ever run again under the same approval — at most once per
 * incident and twice per candidate — for a release check and for a GitHub CI job alike. A failing test, a typecheck, an
 * attack test, a migration: none tolerated. An unexplained failure blocks, and a person decides.
 */
export const INFRA_RERUNS_PER_INCIDENT = 1;
export const INFRA_RERUNS_PER_CANDIDATE = 2;
/** One failed attempt that a later attempt of the same job passed. */
export type CheckFailure = { id: number; name: string; conclusion: string | null };

export type PullRequest = { number: number; state: "open" | "closed" | "merged"; head: string; base: string; mergeCommit: string | null };
/** The release task as Toolroll records it (`task show --json`). */
export type GateState = {
  exists: boolean;
  candidate: string | null;
  scopeDigest: string | null;
  /** The current approval of the scope: by whom, of which digest, and how (`password` or `chat` is a person's yes). */
  approval: { by: string; at: string; digest: string; basis: string | null; role: string | null; active: boolean;
    /** The plane's own answer to "did a person give this approval, with a person's proof recorded?" (approval policy
     * §1.5). Absent from a plane too old to say, which is no person's approval. */
    person?: { ok: true; method: string } | { ok: false; why: string } } | null;
  /** The newest finished build of the task: its sealed result and check. */
  result: { run: number; head: string | null; check: string; level: string | null; receipt: string; worktree: string | null } | null;
  /** A finished build that left no result to complete (it failed before the check), in words. */
  failed: string | null;
  /** A newer attempt is queued or running (`task regate` after a failed check): the result shown is the one before it.
   * Absent from a plane too old to say. */
  pending?: boolean;
  completion: { actor: string; at: string; digest: string } | null;
};
export type Installed = { services: string[]; clis: { name: string; runtime: string | null }[] };
/** A CLI name's link on PATH and where it pointed before the release moved it (release-links.ts). */
export type SavedLink = { name: string; path: string; before: string | null; foreign?: true };
/** A deployment that stopped and couldn't recover. `gate`: the update pause it left, when its journal is before the swap. */
export type DeployStop = { ok: false; message: string; gate?: { id: string; phase: string } };
/** The tap's formula for a version: current, a proposal open, missing — or `newer`: the tap's default branch already
 * names a later version, which an older release must never overwrite. */
export type HomebrewState = { kind: "current" } | { kind: "proposed"; pr: number; head: string } | { kind: "missing" } | { kind: "newer"; version: string };
/** Homebrew after publication (pipeline-speed.md, P1): its own durable state, finished by `toolroll release <branch>`.
 * `pending`: a change proposed or its checks still running; `failed`: its checks failed (a later run reads them again);
 * `current`: merged, or already on the tap; `superseded`: the tap already names a newer version, so nothing was changed. */
export type HomebrewProgress = "pending" | "failed" | "current" | "superseded";

/** One commit that landed after the approval, with its files and line counts (release_carry). */
export type LandedCommit = { sha: string; files: { path: string; added: number; deleted: number }[] };
/** A release's authority record as the coordinator reads it (store.ts release_authority). */
export type AuthorityView = { id: number; generation: number; state: string; tipSha: string; tipTask: string; version: string; pr: number; landed: LandedCommit[] };
export type ReleaseAction = "dispatch" | "deploy" | "merge" | "complete";
/** The plane's answer after a failed release check: rerun (confirmed infrastructure), already rerunning, or stop. */
export type FailureClassName = "deterministic" | "infrastructure" | "unknown" | "agent-behaviour";
export type RecheckView = { action: "rerun"; why: string } | { action: "pending" } | { action: "stop"; class: FailureClassName | null; why: string };

export type OperationView = { id: string; kind: "deploy" | "merge"; state: "reserved" | "running" | "succeeded" | "failed" | "unknown"; candidate: string; externalRef: string | null; reservedAt: string;
  /** Reserved by a person's own deploy run (deploy-browser.mjs), not a coordinator. */
  direct: boolean;
  /** Whether the process that issued it is proven gone (store.ts releaseIssuerGone): read when the view is made. */
  issuerGone: boolean;
  /** A direct deploy's staging folder. */
  stage: string | null };
/** The release's authority record, through the plane's store (release-once.md). Absent: a plane too old to carry, and
 * every commit asks for a person as before. */
export type ReleaseAuthorityAdapter = {
  authority(taskId: string): Promise<AuthorityView | null>;
  live(taskId: string, action: ReleaseAction): Promise<{ applies: boolean; ok: boolean; why: string | null }>;
  lease(authority: number, owner: string): Promise<{ ok: true; epoch: number } | { ok: false; why: string }>;
  renew(authority: number, owner: string, epoch: number): Promise<boolean>;
  carry(authority: number, to: string, requestId: string, epoch: number): Promise<{ ok: true; taskId: string } | { ok: false; message: string }>;
  /** `secret`: proves a deploy run is this reservation's (handed to deploy-browser on stdin). */
  reserve(input: { authority: number; kind: "deploy" | "merge"; taskId: string; candidate: string; epoch: number }): Promise<{ ok: true; operation: string; secret?: string } | { ok: false; why: string }>;
  start(operation: string, epoch: number): Promise<boolean>;
  /** Settle an operation at the epoch this coordinator holds; false: it no longer holds the release. */
  finish(operation: string, outcome: "succeeded" | "failed" | "unknown", facts: { detail?: string | null; externalRef?: string | null }, epoch: number): Promise<boolean>;
  /** A CI failure after the deploy (Alex's decision): the release stops and needs a person's fresh approval. False when
   * the authority could not be stopped (a stale epoch, a merge already reserved): the coordinator fails closed. */
  needsApproval(authority: number, reason: string, epoch: number): Promise<boolean>;
  operations(authority: number): Promise<OperationView[]>;
  /** After a failed release check (check-failure.ts): the plane classifies it from its own records and, only for
   * confirmed infrastructure within its limits, runs the check again on the same candidate under the same approval.
   * Absent on an older plane: a failed check stops as before. */
  recheck?(taskId: string): Promise<RecheckView>;
  /** Whether a passing check stands given every earlier attempt on the same commit (an earlier failure that wasn't
   * confirmed infrastructure isn't erased by a pass), and what passed only on a retry. */
  standing?(taskId: string, run: number): Promise<{ ok: true; retried: string[] | null } | { ok: false; why: string; retried: string[] | null }>;
  /** Releases that approve themselves when green (docs/plans/auto-approve-green.md): the plane's own seals, each proven
   * again inside the plane. Absent: a plane that can't, and every release asks a person as before. */
  auto?: AutoReleaseAdapter;
};

/** The plane's automatic release approval, as the coordinator asks it. Every answer is the plane's own: the coordinator
 * hands it ids, never evidence (the plane reads GitHub CI itself for `approve`). */
export type AutoReleaseAdapter = {
  /** The project's "Approve automatically when checks pass", read now (off when unreadable). */
  setting(taskId: string): Promise<boolean>;
  /** Seal `auto-check` so the release check runs before anyone approves. */
  authorizeCheck(input: { taskId: string; digest: string; candidate: string }): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Whether the `auto-check` seal still stands (the setting on, its evidence, the digest). */
  checking(taskId: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Observe CI on the candidate and, when everything passed, seal `auto-green` (opening the release's authority). */
  approve(input: { taskId: string; digest: string; candidate: string; run: number; receipt: string }): Promise<{ ok: true; by: string; at: string; ci: { id: number; name: string }[] } | { ok: false; why: string }>;
  /** The automatic road ended without a release: the task asks a person, and the owner is told why. */
  giveUp(taskId: string, why: string): Promise<void>;
  /** The task is filed while CI still runs on `candidate` (recorded in the plane before the task is filed): its approval
   * card says so until the plane reads CI passing. It holds nothing (Alex, 2026-10-29: a person may approve during CI). */
  ciRunning?(taskId: string, candidate: string): Promise<void>;
  /** The plane reads CI on `candidate` itself and, when every required check passed, ends the "CI still running" note
   * (and lifts a hold an older coordinator placed); `ask` tells the owner of a held release it needs them now. */
  ciPassed?(taskId: string, candidate: string, ask: boolean): Promise<{ ok: true } | { ok: false; why: string }>;
  /** The release check failed while checking automatically: the owner is told; the commit may be checked again (a
   * regate of the same commit and digest, within the plane's cap on failed runs). */
  checkFailed(taskId: string, why: string): Promise<void>;
  /** "Released 0.9.x automatically". */
  released(taskId: string, tag: string): Promise<void>;
  /** CI stopped passing after the merge of an automatic release: hold its tag, publication and Homebrew until a person
   * lets it go on (`toolroll release publish-ok`). Durable, in the plane. */
  holdPublish(taskId: string, why: string): Promise<void>;
  /** Why the release's publication waits for a person, or null. Read from the plane, whatever the journal says. */
  publishHeld(taskId: string): Promise<string | null>;
};

export type ReleaseAdapters = {
  /** One approval per release (release-once.md); absent on a plane that can't carry. */
  release?: ReleaseAuthorityAdapter;
  now(): Date;
  sleep(ms: number): Promise<void>;
  say(line: string): void;
  repo: {
    /** owner/name of the gate checkout's origin. */
    github(): Promise<string>;
    /** Fetch the branch and main into the gate checkout (main fast-forwarded), so the gate diffs from today's main. */
    sync(branch: string): Promise<void>;
    remoteHead(branch: string): Promise<string | null>;
    /** Delete only this exact branch head, with a lease; an already absent branch is finished. */
    deleteBranch(branch: string, head: string): Promise<void>;
    tree(sha: string): Promise<string>;
    fileAt(sha: string, path: string): Promise<string | null>;
  };
  toolroll: {
    /** Which runtime each launchd service and each CLI name (`toolroll`, `standing-orders`) runs from. */
    installed(): Promise<Installed>;
    /** The exact commit recorded in the deployment's runtime/package.json. */
    runtimeCommit(runtime: string): Promise<string | null>;
    gate(taskId: string): Promise<GateState>;
    fileGate(input: { taskId: string; title: string; checkout: string; candidate: string; goal: string; acceptance: string;
      /** Release terms to file with the scope (task scope --release): the version, pull request and branch. */
      release?: { version: string; pr: number; branch: string; noCarry: boolean } }): Promise<{ scopeDigest: string }>;
    complete(taskId: string, receipt: string): Promise<{ ok: true } | { ok: false; message: string }>;
    busy(): Promise<{ running: number; tasks: string[] }>;
    /** scripts/deploy-browser.mjs --run --stage --yes from the builder's checkout; runtime is its final JSON's `runtime`. */
    deploy(input: { run: number; worktree: string; stage: string; operation?: { id: string; secret: string } }): Promise<{ ok: true; runtime: string } | DeployStop>;
    /** scripts/deploy-browser.mjs --stage --phase recover for a stage that was launched; a stage never prepared is ok. */
    recoverDeploy(input: { run: number; worktree: string; stage: string }): Promise<{ ok: true } | DeployStop>;
    /** Whether no deployment is at work or half done: no deploy-browser process, no update pause held, and `stage`'s
     * journal (when given) unlocked and at a phase that changed nothing or finished. Null stage: unknown, so false. */
    deploymentIdle(stage: string | null): Promise<boolean>;
    /** Where both CLI names are on PATH now. */
    cliLinks(): Promise<SavedLink[]>;
    /** Point every saved link at `bin` and check each answers `version`; on any failure every link goes back to its
     * saved `before` and this throws. */
    switchLinks(links: readonly SavedLink[], bin: string, version: string): Promise<void>;
  };
  github: {
    authenticated(): Promise<boolean>;
    pullRequest(repo: string, branch: string): Promise<PullRequest | null>;
    checks(repo: string, sha: string): Promise<CheckRun[]>;
    /** Whether GitHub's check history of this commit can be read whole (fewer check suites than the check-runs
     * endpoint's ceiling). Absent or false: an automatic release fails closed; a person's is unaffected. */
    complete?(repo: string, sha: string): Promise<boolean>;
    merge(repo: string, pr: number, head: string, message?: string): Promise<string>;
    /** main's head as GitHub's API answers now (never a local ref a build could move). */
    mainHead(repo: string): Promise<string>;
    /** Whether `sha` already holds `ancestor`, by GitHub's own comparison. */
    contains(repo: string, sha: string, ancestor: string): Promise<boolean>;
    /** Whether GitHub refuses to merge a branch that is behind main ("Require branches to be up to date before
     * merging"); null when it can't be read. Read only. */
    upToDateRequired(repo: string): Promise<MainProtection | null>;
    tag(repo: string, tag: string): Promise<string | null>;
    createTag(repo: string, tag: string, sha: string): Promise<void>;
    release(repo: string, tag: string): Promise<boolean>;
  };
  registry: { published(name: string, version: string): Promise<boolean> };
  homebrew: {
    repo: string;
    /** Whether any of the tap's workflows, at the change or its base, runs on a change; if none does, no checks are owed. */
    checked(head: string): Promise<boolean>;
    /** The change's commit statuses, as check runs oldest first. */
    statuses(head: string): Promise<CheckRun[]>;
    state(version: string): Promise<HomebrewState>;
    propose(version: string): Promise<{ pr: number; head: string }>;
    /** Right before the merge: the change is the tap's own open pull request at exactly `head`, and its formula is
     * exactly the tap's formula with npm's published tarball for `version` and that tarball's own sha256. */
    verified(pr: number, head: string, version: string): Promise<{ ok: true } | { ok: false; why: string }>;
    merge(pr: number, head: string): Promise<void>;
  };
};

export type ReleaseJournal = {
  version: 1;
  id: string;
  github: string;
  checkout: string;
  branch: string;
  candidate: { sha: string; tree: string };
  packageName: string;
  packageVersion: string;
  tag: string;
  pr: number;
  step: ReleaseStep;
  task: { id: string; scopeDigest: string | null };
  approval: { by: string; at: string } | null;
  /** The passing result: its run, receipt and checkout, and the commit it built (`head`), which a prepared candidate
   * records as a commit of its own with exactly the candidate's tree (absent in a journal from before that was known). */
  check: { run: number; receipt: string; worktree: string; head?: string } | null;
  completion: { actor: string; at: string } | null;
  deploy: { runtime: string; at: string } | null;
  /** Saved before launching deploy, so a killed coordinator can recover that exact attempt first. */
  deployAttempt?: { stage: string } | null;
  /** Where both CLI names pointed before link moved them: saved first, so a resumed or failed relink can put them back. */
  links?: SavedLink[] | null;
  ci: { checks: string[]; at: string } | null;
  merge: { sha: string; tree: string | null } | null;
  tagged: { sha: string } | null;
  published: { at: string } | null;
  homebrew: { pr: number | null; head: string | null; merged: boolean;
    /** Absent in a journal from before Homebrew was finished apart: read from `merged`. */
    state?: HomebrewProgress; why?: string | null } | null;
  /** The release's authority record (release-once.md), once a person approved terms: the id and generation. */
  authority?: { id: number; generation: number } | null;
  /** Commits that landed after the approval, carried under it: each with its files and line counts. */
  landed?: LandedCommit[];
  /** The deploy and merge operations this coordinator reserved (store.ts release_operation). */
  operations?: { deploy?: string; merge?: string };
  /** A pull request check failed after the deploy: nothing continues until a person approves again (--new). */
  needsApproval?: boolean;
  /** This journal's task was picked fresh after a CI failure after the deploy: an id that never existed, never another. */
  freshTask?: boolean;
  /** The automatic road (auto-approve-green.md): `checking` once the plane sealed `auto-check`, `approved` once it sealed
   * `auto-green`, `refused` (and why) when it wouldn't — then a person approves, as before. */
  auto?: { state: "checking" | "approved" | "refused"; why?: string; ci?: number[] } | null;
  /** The gate filed the task while the pull request's checks still ran (pipeline-speed.md, D2 and "Decision: a person's
   * release asks during CI"): the release check runs beside CI. A person may approve meanwhile; the plane's automatic
   * approval waits for every check to pass, and nothing deploys, merges, tags or publishes before they do. */
  ciAhead?: boolean;
  /** Set with ciAhead and never cleared for this commit: a person's release reads CI again, fresh, right before the
   * deploy, whatever was seen while asking (a green CI may have a newer attempt failing since). */
  ciBeforeDeploy?: boolean;
  /** When each step was about to change something outside this machine: what a resume must look for before acting. */
  intents: Partial<Record<ReleaseStep, string>>;
  stopped: { step: ReleaseStep; reason: string; message: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type ReleaseOutcome =
  | { ok: true; journal: ReleaseJournal; file: string }
  | { ok: false; reason: string; message: string; step: ReleaseStep | "preflight"; journal: ReleaseJournal | null; file: string; resume: string };

export type ReleaseOptions = {
  branch: string;
  /** The gate checkout: a clone of the repository the release check runs in. */
  checkout: string;
  /** Where journals live (the installation's state folder). */
  stateDir: string;
  limits?: Partial<Record<WaitingStep, number>>;
  /** Start over for a new commit on the branch, keeping the old journal aside. Refused once merging began. */
  fresh?: boolean;
  pollMs?: number;
  /** File the release without carrying later commits: each one asks again. */
  noCarry?: boolean;
};

/** A stop the release reports: the step it stopped at and why, in words. */
class Stop extends Error {
  /** `build`: the release build itself failed before its check (not a failed check). */
  constructor(readonly reason: string, message: string, readonly build = false) { super(message); }
}
/** The tap change's checks failed: Homebrew's own state, never a stop of a published release. */
class HomebrewFailed extends Error {}
/** The branch moved before the deploy reservation: carry the approval to the new head, or file it for a person. */
class Restart extends Error {
  constructor(readonly head: string) { super(`restart at ${head}`); }
}

/** Every commit that landed after the approval, in words: the summary and the merge message list them all. */
export function landedWords(landed: readonly LandedCommit[]): string[] {
  if (landed.length === 0) return [];
  return [`Landed after the approval (${landed.length} commit${landed.length === 1 ? "" : "s"}):`,
    ...landed.map(one => `- ${one.sha.slice(0, 7)}: ${one.files.map(file => `${file.path} (+${file.added} −${file.deleted})`).join(", ")}`)];
}

const branchFile = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, "_");
export const journalFile = (stateDir: string, branch: string) => join(stateDir, "releases", `${branchFile(branch)}.json`);
export const resumeCommand = (branch: string, checkout: string) => `toolroll release ${branch} --repo ${checkout}`;

/** Whole or not at all: a private temp file, synced, renamed into place, its folder synced. */
export function writeJournal(file: string, journal: ReleaseJournal): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  if (process.platform !== "win32") {
    const folder = openSync(dirname(file), "r");
    try { fsyncSync(folder); } finally { closeSync(folder); }
  }
}

export function readJournal(file: string): ReleaseJournal | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ReleaseJournal;
  if (parsed.version !== 1 || !RELEASE_STEPS.includes(parsed.step)) throw new Error(`${file} is not a release journal this version reads`);
  return parsed;
}

/** The release task's id: one per exact commit, so a rerun finds the task it filed instead of filing another. */
export const gateTaskId = (version: string, sha: string) => `release-${version.replace(/[^0-9A-Za-z.-]/g, "-")}-${sha.slice(0, 7)}`;

/** Whether the scope's approval is the owner's own yes to these exact bytes: a person through the password (or
 * identity) ceremony or a chat confirmation — never a mode's coverage, an AI teammate, a routine or the lead. */
export function ownerApproval(gate: GateState, digest: string | null): { ok: true; by: string; at: string } | { ok: false; why: string } {
  const approval = gate.approval;
  if (approval === null) return { ok: false, why: "not approved yet" };
  if (digest === null || approval.digest !== digest) return { ok: false, why: "the approval is for different scope text" };
  if (approval.basis === "lead") return { ok: false, why: "approved by the lead, not by a person" };
  if (approval.basis !== "password" && approval.basis !== "chat") return { ok: false, why: `approved by ${approval.basis ?? "an unknown road"}, not by a person` };
  if (/ \(AI\)$/.test(approval.by) || /^mode /.test(approval.by) || /^lead\b/.test(approval.by) || approval.by === "routine") return { ok: false, why: `approved as ${approval.by}, not by a person` };
  if (approval.role !== "approver" || !approval.active) return { ok: false, why: `approved by ${approval.by}, who is not an active approver` };
  // A person's proof, recorded for these exact bytes (approval policy §1.5): a lead token or a remote API token sealed
  // through the person's road before the fix said `password` too. A plane that can't say is not a yes.
  if (approval.person === undefined) return { ok: false, why: "the plane can't show a person gave this approval; update it first" };
  if (!approval.person.ok) return { ok: false, why: approval.person.why };
  if (!personProof(approval.person.method)) return { ok: false, why: "approved with a machine credential, not by a person" };
  return { ok: true, by: approval.by, at: approval.at };
}

/** Every required check present, and every reported check's newest attempt completed successfully. */
export function checksVerdict(runs: readonly CheckRun[], required: readonly string[]): { state: "passed" } | { state: "pending"; waiting: string[] } | { state: "failed"; failed: string[] } {
  const failed: string[] = [], waiting: string[] = [];
  // The adapter orders attempts oldest first, so the last attempt for each name is authoritative.
  const latest = new Map(runs.map(run => [run.name, run]));
  for (const name of new Set([...required, ...latest.keys()])) {
    const run = latest.get(name);
    if (run === undefined || run.status !== "completed") { waiting.push(run === undefined ? `${name} (not started)` : `${name} (${run.status})`); continue; }
    if (run.conclusion !== "success") failed.push(`${name} (${run.conclusion ?? "no conclusion"})`);
  }
  if (failed.length > 0) return { state: "failed", failed };
  return waiting.length > 0 ? { state: "pending", waiting } : { state: "passed" };
}

/** Run the release from wherever its journal stopped. */
export async function runRelease(options: ReleaseOptions, adapters: ReleaseAdapters): Promise<ReleaseOutcome> {
  const file = journalFile(options.stateDir, options.branch);
  const resume = resumeCommand(options.branch, options.checkout);
  const limits = { ...RELEASE_LIMITS, ...options.limits };
  const pollMs = options.pollMs ?? POLL_MS;
  const say = adapters.say;
  let journal: ReleaseJournal | null = null;
  let step: ReleaseStep | "preflight" = "preflight";
  let freshApproval = false;
  let supersededTask: string | null = null;

  const save = () => { journal!.updatedAt = adapters.now().toISOString(); writeJournal(file, journal!); };
  const advance = (next: ReleaseStep) => { journal!.step = next; journal!.stopped = null; save(); };
  const intend = (at: ReleaseStep) => { journal!.intents[at] = adapters.now().toISOString(); save(); };
  const recoverDeploy = async () => {
    const j = journal!;
    if (j.step !== "deploy" || j.intents.deploy === undefined) return;
    if (!j.deployAttempt) throw new Stop("deploy-recovery", "The interrupted deployment has no saved staging path. Recover it with the deployment journal before starting another release.");
    const recovered = await adapters.toolroll.recoverDeploy({ ...j.check!, stage: j.deployAttempt.stage });
    if (!recovered.ok) throw deployStop("deploy-recovery", `Deployment recovery stopped: ${recovered.message}`, recovered);
    j.deployAttempt = null;
    delete j.intents.deploy;
    save();
  };
  /** Ask `probe` until it answers, within this step's limit. A short network failure on the way to GitHub (git or gh
   * timing out) is no answer yet, never the release's end: the next poll asks again, until the step's own limit. */
  const waitFor = async <T>(at: WaitingStep, what: string, probe: () => Promise<T | null>): Promise<T> => {
    const deadline = adapters.now().getTime() + limits[at] * 60_000;
    let said = false, unreachable: string | null = null;
    for (;;) {
      let answer: T | null;
      try {
        answer = await probe();
        unreachable = null;
      } catch (error) {
        if (!transientNetworkError(error)) throw error;
        if (unreachable === null) say(`  GitHub didn't answer in time (${networkWords(error)}); asking again`);
        unreachable = networkWords(error);
        answer = null;
      }
      if (answer !== null) return answer;
      if (adapters.now().getTime() >= deadline) throw new Stop("timeout", `Still waiting for ${what} after ${limits[at]} minutes${unreachable === null ? "" : ` (GitHub last didn't answer: ${unreachable})`}.`);
      if (!said) { say(`  waiting for ${what} (up to ${limits[at]} min)`); said = true; }
      await adapters.sleep(pollMs);
    }
  };

  try {
    journal = readJournal(file);
    if (journal !== null && options.fresh === true && journal.step !== "done") {
      if (journal.intents.merge !== undefined) throw new Stop("merging", `The release of ${journal.candidate.sha.slice(0, 7)} already began merging; finish it with \`${resume}\` instead of starting over.`);
      await recoverDeploy();
      const aside = file.replace(/\.json$/, `.superseded-${adapters.now().toISOString().replace(/[:.]/g, "-")}.json`);
      renameSync(file, aside);
      say(`Kept the earlier release journal at ${aside}.`);
      freshApproval = journal.needsApproval === true;
      supersededTask = journal.task.id;
      journal = null;
    }
    if (journal?.step === "done") {
      say(`Released ${journal.tag} (${journal.candidate.sha.slice(0, 7)}) — nothing left to do.`);
      return { ok: true, journal, file };
    }
    // Published, with Homebrew still to finish: this run finishes it, waiting for the tap's checks within its limit.
    const finishingHomebrew = journal !== null && journal.step === "homebrew" && journal.published !== null && options.fresh !== true;

    if (!await adapters.github.authenticated()) throw new Stop("github-auth", "GitHub CLI is not signed in: run `gh auth login`, then rerun.");
    if (journal === null) {
      journal = await begin(options, adapters, adapters.now());
      // The earlier attempt needs a person's fresh approval (a CI failure after its deploy): this one files a task of its
      // own for the same commit, so the old approval can't carry it.
      // Only an id that has never existed, numbered after the superseded one: never a task whose approval still stands.
      if (freshApproval) {
        const base = journal.task.id;
        const suffix = supersededTask === null ? null : supersededTask === base ? 1 : supersededTask.startsWith(`${base}-`) ? Number(supersededTask.slice(base.length + 1)) : null;
        let picked: string | null = null;
        for (let n = suffix !== null && Number.isInteger(suffix) && suffix > 0 ? suffix + 1 : 2; n < 1000; n++) {
          const id = `${base}-${n}`;
          if (!(await adapters.toolroll.gate(id)).exists) { picked = id; break; }
        }
        if (picked === null) throw new Stop("approval", `No unused task id is left for a fresh approval of ${base}.`);
        journal.task = { id: picked, scopeDigest: null };
        journal.freshTask = true;
      }
    }
    else say(`Resuming the release of ${journal.tag} (${journal.candidate.sha.slice(0, 7)}) at ${journal.step}.`);
    const j = journal;
    // A journal an older coordinator filed ahead of CI: its deploy reads CI fresh too.
    if (j.ciAhead === true && j.ciBeforeDeploy !== true) j.ciBeforeDeploy = true;
    if (j.checkout !== options.checkout) throw new Stop("checkout", `This release runs in ${j.checkout}; rerun with --repo ${j.checkout}.`);
    save();

    // Before anything merges, the branch and its pull request must still be the gated commit.
    const pinned = async () => {
      const head = await adapters.repo.remoteHead(j.branch);
      if (head !== j.candidate.sha) throw new Stop("drift", `${j.branch} moved from ${j.candidate.sha.slice(0, 7)} to ${head?.slice(0, 7) ?? "nothing"} after it was gated. Run \`toolroll release ${j.branch} --repo ${j.checkout} --new\` to release the new commit.`);
      const pr = await adapters.github.pullRequest(j.github, j.branch);
      if (pr === null || pr.number !== j.pr || (pr.state === "open" && pr.head !== j.candidate.sha)) throw new Stop("drift", `Pull request #${j.pr} no longer has ${j.candidate.sha.slice(0, 7)} at its head.`);
      return pr;
    };
    // ---- Homebrew, finished apart from publication (pipeline-speed.md, P1) ------------------------------------------
    let homebrewLeft: { state: "pending" | "failed"; why: string | null } | null = null;
    /**
     * One look at the tap: propose the formula change when it's missing, judge its checks (once, or within the Homebrew
     * limit when `wait`), and merge exactly the proposed head once every check passed. A tap that already names a newer
     * version is never overwritten, checked again right before the merge. Checksums come from npm's own tarball
     * (release-adapters.ts propose), unchanged.
     */
    const homebrewPass = async (wait: boolean): Promise<{ state: HomebrewProgress; why: string | null }> => {
      const brew = adapters.homebrew;
      let state = await brew.state(j.packageVersion);
      if (state.kind === "newer") return { state: "superseded", why: `the tap already names ${state.version}` };
      if (state.kind === "current") return { state: "current", why: null };
      // A change this release already proposed is the only one it ever merges (security scan): another pull request for
      // the same version, a moved head or a closed change is failed, never adopted or merged.
      const journaled = j.homebrew?.pr != null && j.homebrew.head != null ? { pr: j.homebrew.pr, head: j.homebrew.head } : null;
      if (journaled !== null && state.kind === "missing") return { state: "failed", why: `${brew.repo} #${journaled.pr} was closed before it merged` };
      if (journaled !== null && state.kind === "proposed" && (state.pr !== journaled.pr || state.head !== journaled.head)) {
        return { state: "failed", why: `${brew.repo}'s change for ${j.packageVersion} is now #${state.pr} at ${state.head.slice(0, 7)}, not the #${journaled.pr} at ${journaled.head.slice(0, 7)} this release proposed` };
      }
      if (state.kind === "missing") { intend("homebrew"); const proposed = await brew.propose(j.packageVersion); state = { kind: "proposed", ...proposed }; }
      const proposed = state;
      j.homebrew = { pr: proposed.pr, head: proposed.head, merged: false, state: "pending", why: null };
      save();
      // Whatever checks do register are always judged; an empty set passes only for a tap whose workflows never run
      // on a change, and only when it's still empty a poll later.
      const checked = await brew.checked(proposed.head);
      let emptyLooks = 0;
      const probe = async (): Promise<true | null> => {
        // Check runs and commit statuses are judged apart, so neither stands in for the other or hides its failure.
        // Two apps may name a check alike; each app's attempts stand for themselves.
        const runs = (await adapters.github.checks(brew.repo, proposed.head)).map(run => ({ ...run, name: `${run.app ?? "unknown app"}: ${run.name}` }));
        const statuses = await brew.statuses(proposed.head);
        const verdicts = [runs, statuses].filter(one => one.length > 0).map(one => checksVerdict(one, [...new Set(one.map(run => run.name))]));
        const failed = verdicts.flatMap(one => one.state === "failed" ? one.failed : []);
        if (failed.length > 0) throw new HomebrewFailed(`the tap change's checks failed: ${failed.join(", ")}`);
        if (verdicts.some(one => one.state === "pending")) return null;
        // GitHub registers checks asynchronously; an empty set says nothing about success.
        // A workflow is owed: only its own run counts, not another app's green check.
        if (checked && !runs.some(run => run.app === "github-actions")) return null;
        if (runs.length === 0 && statuses.length === 0) return ++emptyLooks >= 2 ? true : null;
        return true;
      };
      try {
        const passed = wait ? await waitFor("homebrew", `the Homebrew change's checks (${brew.repo} #${proposed.pr})`, probe) : await probe();
        if (passed === null) return { state: "pending", why: `${brew.repo} #${proposed.pr}'s checks are still running` };
      } catch (error) {
        if (error instanceof HomebrewFailed) return { state: "failed", why: `${brew.repo} #${proposed.pr}: ${error.message}` };
        // Waiting ran out: still pending, never a stop of a published release.
        if (error instanceof Stop && error.reason === "timeout") return { state: "pending", why: error.message };
        throw error;
      }
      // Ordering, once more right before the merge: a newer formula landed meanwhile is never overwritten.
      const now = await brew.state(j.packageVersion);
      if (now.kind === "newer") return { state: "superseded", why: `the tap already names ${now.version}` };
      if (now.kind === "missing") return { state: "failed", why: `${brew.repo} #${proposed.pr} was closed before it merged` };
      if (now.kind === "proposed" && now.head !== proposed.head) return { state: "failed", why: `${brew.repo} #${proposed.pr} moved to ${now.head.slice(0, 7)} after its checks were read` };
      if (now.kind === "current") return { state: "current", why: null };
      const verified = await brew.verified(proposed.pr, proposed.head, j.packageVersion);
      if (!verified.ok) return { state: "failed", why: verified.why };
      await brew.merge(proposed.pr, proposed.head);
      return { state: "current", why: null };
    };
    // ---- one approval per release (release-once.md) -------------------------------------------------------------
    const rel = adapters.release;
    let epoch: number | null = null;
    // This invocation's own lease owner (review round 1): two runs of the same journal never share an epoch.
    const owner = `${j.id}:${randomUUID()}`;
    /** Take the release's lease (a takeover raises its epoch), then settle every operation still open before any new work. */
    const hold = async () => {
      if (rel === undefined || !j.authority) return;
      const lease = await rel.lease(j.authority.id, owner);
      if (!lease.ok) throw new Stop("lease", lease.why);
      epoch = lease.epoch;
      await reconcile();
    };
    const reconcile = async () => {
      if (rel === undefined || !j.authority) return;
      for (const op of (await rel.operations(j.authority.id)).filter(one => one.state === "reserved" || one.state === "running" || one.state === "unknown")) {
        // A started call whose issuer may still be alive may still land (review round 2): nothing is settled for it on
        // elapsed time. It stays as it is, and a person looks.
        const inFlight = () => new Stop("operation-in-flight", `An earlier ${op.kind} (operation ${op.id}) was started by a process that may still be running. Nothing was settled: check that process, then rerun.`);
        if (op.kind === "deploy") {
          // Reserved and never started: nothing to undo (a start after this takeover is refused: its epoch moved).
          if (op.state === "reserved") { await rel.finish(op.id, "failed", { detail: "the call never started" }, epoch!); continue; }
          if (await served(adapters, builtHead()) !== null) { await rel.finish(op.id, "succeeded", { detail: "reconciled: the services run the candidate" }, epoch!); continue; }
          if (!op.issuerGone) throw inFlight();
          if (op.direct) {
            // A person's own deploy: its process is gone; its lock, update pause and journal must say nothing is half done.
            if (!await adapters.toolroll.deploymentIdle(op.stage)) throw new Stop("deploy-recovery", `A person's deploy of this release (operation ${op.id}) ended without finishing${op.stage === null ? "" : `; its journal is in ${op.stage}`}. Recover it, then rerun.`);
            await rel.finish(op.id, "failed", { detail: "reconciled: the deploy's process ended, and nothing is deployed or half done" }, epoch!);
            continue;
          }
          await recoverDeploy();
          await rel.finish(op.id, "failed", { detail: "reconciled: recovered the previous build" }, epoch!);
        } else {
          // The pull request decides an unknown merge: merged from the gated head is a success, whoever issued it.
          const pr = await adapters.github.pullRequest(j.github, j.branch);
          if (pr?.state === "merged" && pr.number === j.pr && pr.head === op.candidate && pr.mergeCommit !== null) await rel.finish(op.id, "succeeded", { externalRef: pr.mergeCommit, detail: "reconciled: the pull request is merged from the gated head" }, epoch!);
          else if (op.state === "reserved") await rel.finish(op.id, "failed", { detail: "reconciled: the merge never started" }, epoch!);
          else if (!op.issuerGone) throw inFlight();
          else if (pr?.state === "open" && pr.number === j.pr && pr.head === op.candidate) await rel.finish(op.id, "failed", { detail: "reconciled: the merge's process ended and the pull request is still open at the gated head" }, epoch!);
          else throw new Stop("merge-unknown", `The merge of pull request #${j.pr} can't be reconciled: it is ${pr?.state ?? "gone"}. Check it on GitHub before rerunning.`);
        }
      }
    };
    /**
     * Who and what the release is, read again: the repository, the pull request (open, its number, base main) and its
     * head, and the live-release predicate for the coming action. Before the deploy reservation a moved head restarts
     * the release for the new commit; after it, it stops, and the new commit needs a person.
     */
    const identity = async (action: ReleaseAction, beforeReservation: boolean) => {
      if (rel === undefined) { await pinned(); return; }
      if (await adapters.repo.github() !== j.github) throw new Stop("drift", `The release's repository is no longer ${j.github}.`);
      const head = await adapters.repo.remoteHead(j.branch);
      const pr = await adapters.github.pullRequest(j.github, j.branch);
      if (pr === null || pr.number !== j.pr || pr.state !== "open") throw new Stop("drift", `Pull request #${j.pr} is no longer the open pull request of ${j.branch}; the release stops.`);
      if (pr.base !== "main") throw new Stop("drift", `Pull request #${j.pr} now merges into ${pr.base}, not main; the release stops.`);
      if (head !== j.candidate.sha || pr.head !== j.candidate.sha) {
        if (beforeReservation && head !== null && pr.head === head) throw new Restart(head);
        throw new Stop("drift", `${j.branch} moved from ${j.candidate.sha.slice(0, 7)} to ${head?.slice(0, 7) ?? "nothing"} after the deploy began. The new commit needs a person's approval: run \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`);
      }
      if (j.authority) {
        const live = await rel.live(j.task.id, action);
        // Fail closed: once the release has an authority, its task must be one the predicate applies to AND accepts.
        if (!live.applies || !live.ok) throw new Stop("release", `Task ${j.task.id} can't ${action === "dispatch" ? "go on" : action}: ${live.applies ? live.why ?? "its release approval doesn't stand" : "it belongs to no release approval this plane can find"}.`);
        if (epoch !== null && !await rel.renew(j.authority.id, owner, epoch)) throw new Stop("lease", "Another release coordinator took over this release.");
      }
    };
    /** The head moved before the deploy reservation: carry the approval to it, or file it for a person. Nothing kept from
     * the old step is used afterwards: the journal is rewritten and the state machine runs again. */
    /**
     * A pull request check failed after the deploy reservation (Alex, 2026-10-25): the candidate froze at deploy, so the
     * release needs a person's fresh approval, even for the same commit. It is persisted (the authority stops; the
     * journal says so) before the release stops; `--new` files the commit for a person again.
     */
    const ciFailedAfterDeploy = async (what: string, deploy: "before" | "after" = "after"): Promise<never> => {
      j.needsApproval = true; save();
      // An automatic approval never outlives a CI failure: the owner is told, and a person approves again.
      if (j.auto?.state === "approved") await rel?.auto?.giveUp(j.task.id, deploy === "after" ? `${what}, after the deploy` : what);
      // Fail closed: the authority must have stopped; otherwise its approval could still carry the commit.
      if (rel !== undefined && j.authority && (epoch === null || !await rel.needsApproval(j.authority.id, deploy === "after" ? "a pull request check failed after the deploy" : "a pull request check failed before the deploy", epoch))) {
        throw new Stop("lease", `${what}. Nothing was merged, but this release's approval couldn't be stopped (another coordinator holds it, or a merge is reserved). Check it with \`toolroll release ${j.branch} --repo ${j.checkout}\` before going on.`);
      }
      throw new Stop("ci-failed", deploy === "after"
        ? `${what}. Nothing was merged. The deploy had already started, so this commit needs a person's approval again: run \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`
        : `${what}. Nothing was deployed or merged. This commit needs a person's approval: run \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`);
    };
    /** An automatic approval's CI allowance: only attempts GitHub shows failing before the tests ran, at most
     * INFRA_RERUNS_PER_CANDIDATE on the commit; a person's approval judges each job by its latest attempt. */
    const autoCap = (): { auto?: true } => (j.auto?.state === "approved" ? { auto: true } : {});
    /**
     * An automatically approved release stands only while its CI does (auto-approve-green.md): the complete, current
     * checks on the exact commit are read again right before each step that can't be taken back — the deploy, the CLI
     * relink, the merge and the tag. Anything but green (failed, a job re-run and pending, an earlier failure GitHub
     * doesn't show as the runner's own) stops the
     * release, revokes its approval and tells the owner; the commit then needs a person.
     */
    const autoCiHolds = async (before: string) => {
      if (j.auto?.state !== "approved") return;
      const read = await adapters.github.checks(j.github, j.candidate.sha);
      const whole = adapters.github.complete === undefined ? false : await adapters.github.complete(j.github, j.candidate.sha);
      const verdict = whole ? prChecksVerdict(read, j.candidate.sha, REQUIRED_PR_CHECKS, { auto: true, workflow: REQUIRED_PR_CHECKS_WORKFLOW }) : { state: "failed" as const, failed: ["GitHub's check history of this commit can't be read whole"] };
      if (verdict.state === "passed") { await liftCiHold(false, `The release cannot continue before ${before}`); return; }
      if (before === "the tag") {
        // Already merged: nothing to revoke. It isn't tagged or published, and a person decides — durably, in the plane.
        const why = `Pull request checks on ${j.candidate.sha.slice(0, 7)} stopped passing after the merge`;
        await rel?.auto?.holdPublish(j.task.id, why);
        await rel?.auto?.giveUp(j.task.id, why);
        throw new Stop("ci-failed", `Pull request checks on ${j.candidate.sha.slice(0, 7)} are no longer all passing: ${(verdict.state === "failed" ? verdict.failed : verdict.waiting).join(", ")}. It was merged, but nothing was tagged or published; a person decides how to go on.`);
      }
      await ciFailedAfterDeploy(`Pull request checks on ${j.candidate.sha.slice(0, 7)} are no longer all passing before ${before}: ${(verdict.state === "failed" ? verdict.failed : verdict.waiting).join(", ")}`,
        before === "the deploy" && j.deploy === null ? "before" : "after");
    };
    /** A publication held for a person (the plane's record) stops the tag, the publication and Homebrew. */
    const publishHold = async () => {
      const held = rel?.auto === undefined ? null : await rel.auto.publishHeld(j.task.id);
      if (held !== null) throw new Stop("approval", `${held}. It was merged; nothing more is tagged, published or sent to Homebrew until a person lets it go on: \`toolroll release publish-ok ${j.task.id} --as <you> --token <password>\`, then rerun.`);
    };
    /** identity(), on a plane that keeps release authority; a legacy plane keeps the old rules. */
    const watch = async (action: ReleaseAction) => { if (rel !== undefined) await identity(action, true); };
    const restart = async (head: string) => {
      const tree = await adapters.repo.tree(head);
      if (rel !== undefined && j.authority && epoch !== null) {
        say(`  ${j.branch} moved to ${head.slice(0, 7)}: checking whether the approval carries`);
        const carried = await rel.carry(j.authority.id, head, randomUUID(), epoch);
        if (carried.ok) {
          const view = await rel.authority(carried.taskId);
          j.candidate = { sha: head, tree };
          j.task = { id: carried.taskId, scopeDigest: (await adapters.toolroll.gate(carried.taskId)).scopeDigest };
          j.check = null; j.completion = null; j.landed = view?.landed ?? j.landed ?? [];
          delete j.intents.check; delete j.intents.complete;
          j.step = "check"; j.stopped = null; save();
          say(`  carried the approval to ${head.slice(0, 7)} (task ${carried.taskId})`);
          return;
        }
        say(`  ${head.slice(0, 7)} needs a person's approval: ${carried.message}`);
      } else say(`  ${j.branch} moved to ${head.slice(0, 7)}: filing it for approval`);
      j.candidate = { sha: head, tree };
      j.task = { id: gateTaskId(j.packageVersion, head), scopeDigest: null };
      j.approval = null; j.check = null; j.completion = null; j.authority = null; j.auto = null; epoch = null;
      delete j.intents.gate; delete j.intents.check; delete j.intents.complete;
      j.step = "gate"; j.stopped = null; save();
    };

    /**
     * The automatic road ended without an approval: the plane takes its `auto-check` back (the task asks a person, its
     * passing check kept) and tells the owner; the release waits at approval for a person, as without the setting.
     */
    const autoRefused = async (why: string): Promise<never> => {
      j.auto = { state: "refused", why }; j.check = null; j.step = "approval"; save();
      await rel?.auto?.giveUp(j.task.id, why);
      throw new Stop("approval", `Not approved automatically: ${why}. A person approves task ${j.task.id} (\`toolroll task approve ${j.task.id} --digest ${j.task.scopeDigest}\`, or the console), then rerun \`${resume}\`.`);
    };
    /**
     * CI passed on the candidate as the coordinator read it: the plane reads it itself and lifts the approval hold it
     * placed when the task was filed ahead of CI (round 1, finding 4). A refusal stops here; nobody was asked.
     */
    const liftCiHold = async (ask: boolean, nothing: string): Promise<void> => {
      const lift = rel?.auto?.ciPassed;
      if (lift === undefined) return;
      const lifted = await lift(j.task.id, j.candidate.sha, ask);
      if (!lifted.ok) throw new Stop("ci-failed", `The plane didn't confirm CI passed on ${j.candidate.sha.slice(0, 7)}: ${lifted.why}. ${nothing}. Rerun \`${resume}\` once every pull request check passes.`);
    };
    /**
     * One look at the pull request's required checks on the exact commit while CI may still run: a failed check stops
     * (`nothing` says what hasn't happened), passed ends the plane's "CI still running" note, pending (or GitHub not
     * answering) answers false. Judged as the ci step judges a person's release (prChecksVerdict, ci.yml, exact head).
     */
    const ciWhileRunning = async (nothing: string, ask: boolean): Promise<boolean> => {
      let runs: CheckRun[];
      try { runs = await adapters.github.checks(j.github, j.candidate.sha); }
      catch (error) { if (transientNetworkError(error)) return false; throw error; }
      const verdict = prChecksVerdict(runs, j.candidate.sha, REQUIRED_PR_CHECKS, { workflow: REQUIRED_PR_CHECKS_WORKFLOW });
      if (verdict.state === "failed") {
        throw new Stop("ci-failed", `GitHub's checks failed on ${j.candidate.sha.slice(0, 7)}: ${verdict.failed.join(", ")}. ${nothing}. ${j.approval === null ? "" : `The approval covers ${j.candidate.sha.slice(0, 7)} only. `}Rerun the failed job on GitHub and run \`${resume}\` again, or fix the branch and release the new commit with \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`);
      }
      if (verdict.state !== "passed") return false;
      // The plane's note can survive a crash before the journal saved ciAhead. Clear it on the plane's own reading,
      // even on an older/resumed journal whose flags say nothing about CI.
      await liftCiHold(ask, nothing);
      if (j.ciAhead === true) { j.ciAhead = false; save(); }
      return true;
    };
    /** Every person's release reads exact-head CI at deployment, even if it was green at the gate or an older
     * journal has no ciBeforeDeploy flag. An approval and the release check can outlive that earlier green reading. */
    const personCiBeforeDeploy = async () => {
      if (j.auto?.state === "approved") return;
      let said = false;
      await waitFor("ci", `the pull request checks on ${j.candidate.sha.slice(0, 7)} before the deploy`, async () => {
        await watch("deploy");
        if (await ciWhileRunning("Nothing was deployed, merged, tagged or published", false)) return true;
        if (!said) { say(`  ${CI_RUNNING_WORDS}`); said = true; }
        return null;
      });
    };
    /**
     * The task is approved for `action`: a release task (a carried commit, or any task once the release has an
     * authority) only when the live-release predicate applies to it AND accepts it — fail closed, whatever its own seal
     * says. Anything else needs the owner's own approval of these exact words (which a carried seal never is).
     */
    const approved = async (gate: GateState, action: ReleaseAction = "dispatch") => {
      if (gate.candidate !== j.candidate.sha || gate.scopeDigest !== j.task.scopeDigest) throw new Stop("scope-changed", `Task ${j.task.id}'s candidate or scope changed after approval.`);
      // Checking automatically: the plane's `auto-check` seal must still stand (the setting on, its evidence, this digest).
      if (j.auto?.state === "checking" && !j.authority) {
        const standing = rel?.auto === undefined ? { ok: false as const, why: "this plane can't approve releases automatically" } : await rel.auto.checking(j.task.id);
        if (standing.ok) return;
        return await autoRefused(standing.why);
      }
      if (rel !== undefined && (j.authority || gate.approval?.basis === "carried")) {
        const live = await rel.live(j.task.id, action);
        if (live.applies && live.ok) return;
        throw new Stop("release", `Task ${j.task.id} can't ${action === "dispatch" ? "go on" : action}: ${live.applies ? live.why ?? "its release approval doesn't stand" : "it belongs to no release approval this plane can find"}.`);
      }
      const owner = ownerApproval(gate, j.task.scopeDigest);
      if (!owner.ok) throw new Stop("approval", `Task ${j.task.id}: ${owner.why}. An active approver must approve the release scope.`);
    };
    const fullCheck = (gate: GateState) => {
      if (gate.result?.level !== "full") throw new Stop("check-level", `A Full check is required for this release (run ${gate.result?.run ?? "unknown"}: ${gate.result?.level ?? "unknown"}). Quick and Off checks cannot release a build.`);
      if (gate.result.check !== "passed") throw new Stop("check-failed", checkFailedWords({ sha: j.candidate.sha, run: gate.result.run, class: null, why: `its check reads ${gate.result.check}`, branch: j.branch, checkout: j.checkout, taskId: j.task.id }));
    };
    /** The commit the passing build recorded: what the deployed runtime is stamped with. */
    const builtHead = () => j.check?.head ?? j.candidate.sha;
    const checked = async (gate: GateState, action: ReleaseAction = "dispatch") => {
      await approved(gate, action);
      if (gate.result?.head !== builtHead() || gate.result?.receipt !== j.check?.receipt) throw new Stop("drift", `Task ${j.task.id}'s result changed since its check passed.`);
      fullCheck(gate);
    };

    if (j.needsApproval === true) throw new Stop("ci-failed", `A pull request check failed after the deploy, so ${j.candidate.sha.slice(0, 7)} needs a person's approval again: run \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`);
    // A resumed release that already has an authority takes its lease and settles every open operation first.
    await hold();
    while (j.step !== "done" && homebrewLeft === null) {
      step = j.step;
      say(`• ${j.step}`);
      try {
      switch (j.step) {
        case "gate": {
          await pinned();
          // The same commit's earlier gate belongs to a release that no longer stands (a CI failure after its deploy, a
          // revoke): a fresh task asks a person again, and their yes opens a new generation.
          if (rel !== undefined && j.freshTask !== true) {
            const base = gateTaskId(j.packageVersion, j.candidate.sha);
            for (let n = 1; n < 50; n++) {
              const id = n === 1 ? base : `${base}-${n}`;
              const live = await rel.live(id, "dispatch");
              if (!live.applies || live.ok) { if (j.task.id !== id) { j.task = { id, scopeDigest: null }; save(); } break; }
            }
          }
          // The tree CI tested (the pull request's head, not GitHub's merge commit) is the tree that merges only when the
          // branch already contains main's head: refused here, before anything is filed, and again right before merging.
          await containsMain(adapters, j, "Nothing was filed or sent for approval");
          if (j.intents.gate === undefined) await mainProtection(adapters, j, false, "Nothing was filed or sent for approval");
          const existing = await adapters.toolroll.gate(j.task.id);
          // A fresh task this journal never filed has appeared under its id: it isn't ours, and isn't a fresh approval.
          if (existing.exists && j.freshTask === true && j.intents.gate === undefined) throw new Stop("approval", `Task ${j.task.id} appeared before this release filed it; rerun with --new.`);
          if (existing.exists) {
            // Filed already (a resume after a lost answer): the task stands, and the ci step judges its checks.
            if (existing.candidate !== j.candidate.sha) throw new Stop("conflict", `Task ${j.task.id} exists for a different commit (${existing.candidate?.slice(0, 7) ?? "none"}).`);
            j.task.scopeDigest = existing.scopeDigest;
          } else {
            // The gate only stops on a check that already failed: the task is filed and a person asked while CI runs, and
            // the release check runs beside it (pipeline-speed.md, D2 and "Decision: a person's release asks during
            // CI"). The automatic approval waits for CI (the check step); nothing deploys before it passes (the deploy).
            const settled = await earlyChecks(adapters, j, (what, probe) => waitFor("gate", what, probe), { pendingIsEnough: true });
            // Recorded before the task exists, so its approval card says CI still runs from the first moment.
            if (!settled) await rel?.auto?.ciRunning?.(j.task.id, j.candidate.sha);
            j.ciAhead = !settled;
            if (!settled) j.ciBeforeDeploy = true;
            save();
            if (!settled) { say(`  Pull request checks on ${j.candidate.sha.slice(0, 7)} are still running: the release check runs beside them, and nothing deploys before they pass`); }
            intend("gate");
            await adapters.repo.sync(j.branch);
            const filed = await adapters.toolroll.fileGate({
              taskId: j.task.id, title: `Release ${j.packageVersion}`, checkout: j.checkout, candidate: j.candidate.sha,
              goal: `Verify ${j.packageName} ${j.packageVersion} (${j.branch} at ${j.candidate.sha}) passes the approved release check before it is deployed, merged, tagged and published.`,
              acceptance: "The approved release check passes on the candidate commit|check",
              ...(rel === undefined ? {} : { release: { version: j.packageVersion, pr: j.pr, branch: j.branch, noCarry: options.noCarry === true } }),
            });
            j.task.scopeDigest = filed.scopeDigest;
          }
          advance("approval");
          break;
        }
        case "approval": {
          // Approve automatically when checks pass (auto-approve-green.md): with the project's setting on, the plane seals
          // `auto-check` so the release check runs first; the approval itself is sealed after it passed. A fresh task
          // after a CI failure after the deploy, or an automatic refusal, always asks a person.
          const auto = rel?.auto;
          if (auto !== undefined && j.freshTask !== true && j.auto?.state !== "refused" && j.task.scopeDigest !== null && await auto.setting(j.task.id)) {
            await watch("dispatch");
            const gate = await adapters.toolroll.gate(j.task.id);
            if (gate.scopeDigest !== j.task.scopeDigest) throw new Stop("scope-changed", `The scope of ${j.task.id} changed after it was filed; the release only runs on the scope it filed.`);
            if (!ownerApproval(gate, j.task.scopeDigest).ok) {
              const authorized = await auto.authorizeCheck({ taskId: j.task.id, digest: j.task.scopeDigest, candidate: j.candidate.sha });
              if (authorized.ok) {
                j.auto = { state: "checking" };
                say(`  Approving automatically once CI and the release check pass on ${j.candidate.sha.slice(0, 7)} (this project's release approval setting)`);
                advance("check");
                break;
              }
              j.auto = { state: "refused", why: authorized.why }; save();
              await auto.giveUp(j.task.id, authorized.why);
              say(`  Not approved automatically: ${authorized.why}. A person approves it.`);
            }
          }
          // Filed while CI still runs: the person is asked now (Alex, 2026-10-29), and told nothing deploys until CI passes.
          // A check that already failed asks nobody (as at the gate).
          if (j.ciAhead === true) await ciWhileRunning("Nothing was deployed or merged", true);
          say(`  The release scope needs your approval: \`toolroll task approve ${j.task.id} --digest ${j.task.scopeDigest}\`, or open the task in the console.`);
          if (j.ciAhead === true) say(`  ${CI_RUNNING_WORDS}`);
          const approved = await waitFor("approval", `a person to approve task ${j.task.id}`, async () => {
            await watch("dispatch");
            // While asking: a check that failed stops here (nobody approves a red commit), and CI passing ends the card's
            // "still running" note (and lifts a hold an older coordinator placed).
            if (j.ciAhead === true) await ciWhileRunning("Nothing was deployed or merged", true);
            const gate = await adapters.toolroll.gate(j.task.id);
            if (gate.scopeDigest !== j.task.scopeDigest) throw new Stop("scope-changed", `The scope of ${j.task.id} changed after it was filed; the release only runs on the scope it filed.`);
            const owner = ownerApproval(gate, j.task.scopeDigest);
            if (!owner.ok && gate.approval !== null && owner.why !== "the approval is for different scope text") throw new Stop("approval", `Task ${j.task.id} was ${owner.why}; the release needs a person to approve it.`);
            return owner.ok ? owner : null;
          });
          j.approval = { by: approved.by, at: approved.at };
          say(`  approved by ${approved.by}`);
          // The person's yes to release terms opened the release's authority: hold its lease from here on.
          if (rel !== undefined) {
            const view = await rel.authority(j.task.id);
            if (view !== null) { j.authority = { id: view.id, generation: view.generation }; j.landed = view.landed; save(); await hold(); say(`  later test-only commits on #${j.pr} carry this approval (release ${view.id})`); }
          }
          advance("check");
          break;
        }
        case "check": {
          const checkProbe = async () => {
            // Before acting on an old candidate's failure: a moved head restarts the release first.
            await watch("dispatch");
            const gate = await adapters.toolroll.gate(j.task.id);
            await approved(gate);
            // A rerun of the same approved commit is on its way: the failure before it is not this release's answer.
            if (gate.pending === true && gate.result?.check !== "passed") return null;
            // A failed Full check: the plane says why (its own records only) and reruns it under the same approval only
            // for confirmed infrastructure; every attempt stays in the evidence. Anything else stops, saying its class.
            if (gate.failed === null && gate.result !== null && gate.result.level === "full" && gate.result.check === "failed" && rel?.recheck !== undefined) {
              const answer = await rel.recheck(j.task.id);
              if (answer.action === "pending") return null;
              if (answer.action === "rerun") {
                say(`  run ${gate.result.run} failed: ${answer.why}. Toolroll confirmed it as its own infrastructure, so the check runs again on ${j.candidate.sha.slice(0, 7)} under the same approval`);
                return null;
              }
              throw new Stop("check-failed", checkFailedWords({ sha: j.candidate.sha, run: gate.result.run, class: answer.class, why: answer.why, branch: j.branch, checkout: j.checkout, taskId: j.task.id }));
            }
            if (gate.failed !== null) throw new Stop("check-failed", `The release build of ${j.task.id} failed: ${gate.failed}. Fix it and release the new commit with --new.`, true);
            if (gate.result === null || gate.result.check === "running" || gate.result.check === "pending") return null;
            // The build records a prepared candidate as a commit of its own (its message names the task): it must hold
            // exactly the candidate's tree, or it isn't the release.
            const head = gate.result.head;
            if (head === null || (head !== j.candidate.sha && await adapters.repo.tree(head) !== await adapters.repo.tree(j.candidate.sha))) {
              throw new Stop("drift", `The release result is for ${head?.slice(0, 7) ?? "no commit"}, which doesn't hold exactly ${j.candidate.sha.slice(0, 7)}'s files.`);
            }
            fullCheck(gate);
            if (gate.result.worktree === null) throw new Stop("worktree", `Run ${gate.result.run} names no checkout to deploy from.`);
            // A pass stands only when no earlier attempt on this commit failed for a reason other than confirmed
            // infrastructure the release reran; what passed only on a retry is said (and an automatic approval refuses it).
            if (rel?.standing !== undefined) {
              const standing = await rel.standing(j.task.id, gate.result.run);
              if (!standing.ok) throw new Stop("check-failed", `Run ${gate.result.run} passed on ${j.candidate.sha.slice(0, 7)}, but ${standing.why}: approve this commit again with \`toolroll release ${j.branch} --repo ${j.checkout} --new\`, or fix the branch and release the new commit the same way.`);
              if (standing.retried === null) say(`  run ${gate.result.run} passed, but its report can't be read, so whether anything passed only on a retry is unknown`);
              else if (standing.retried.length > 0) say(`  run ${gate.result.run} passed, but only on a retry: ${standing.retried.join(", ")}`);
            }
            return { run: gate.result.run, receipt: gate.result.receipt, worktree: gate.result.worktree, head };
          };
          const result = await waitFor("check", `the release check of ${j.candidate.sha.slice(0, 7)}`, async () => {
            try { return await checkProbe(); }
            catch (error) {
              // A failed check (or a changed candidate) ends the automatic road: the owner is told, and a person decides.
              // A failed check is told, and stays checkable again on the same commit (a flake); anything else ends the road.
              if (error instanceof Stop && j.auto?.state === "checking" && error.reason === "check-failed" && !error.build) await rel?.auto?.checkFailed(j.task.id, error.message.replace(/\.$/, ""));
              else if (error instanceof Stop && j.auto?.state === "checking" && error.reason !== "approval") await rel?.auto?.giveUp(j.task.id, error.message.replace(/\.$/, ""));
              throw error;
            }
          });
          j.check = result;
          say(`  run ${result.run} passed on ${j.candidate.sha.slice(0, 7)}`);
          if (j.auto?.state === "checking" && !j.authority) {
            // The check ran beside CI (the gate didn't wait): it waits for every pull request check now. A failure ends the
            // automatic road, and the person's road refuses it too (the approval step waits for CI first).
            if (j.ciAhead === true) {
              try { await earlyChecks(adapters, j, (what, probe) => waitFor("gate", what, probe), { nothing: "Nothing was approved" }); await liftCiHold(false, "Nothing was approved"); }
              catch (error) {
                if (error instanceof Stop && error.reason === "ci-failed") { j.auto = { state: "refused", why: error.message }; j.check = null; j.step = "approval"; save(); await rel?.auto?.giveUp(j.task.id, error.message.replace(/\.$/, "")); }
                throw error;
              }
              j.ciAhead = false; save();
            }
            // The release approval, sealed only now: the plane reads CI on the exact commit itself and proves the check.
            const sealed = rel?.auto === undefined ? { ok: false as const, why: "this plane can't approve releases automatically" }
              : await rel.auto.approve({ taskId: j.task.id, digest: j.task.scopeDigest!, candidate: j.candidate.sha, run: result.run, receipt: result.receipt });
            if (!sealed.ok) await autoRefused(sealed.why);
            else {
              j.auto = { state: "approved", ci: sealed.ci.map(one => one.id) };
              j.approval = { by: `${sealed.by} (automatic)`, at: sealed.at };
              const view = await rel!.authority(j.task.id);
              if (view === null) throw new Stop("release", `The automatic approval of ${j.task.id} opened no release record; a person approves it.`);
              j.authority = { id: view.id, generation: view.generation }; j.landed = view.landed; save();
              await hold();
              say(`  Approved automatically: CI and the release check passed on ${j.candidate.sha.slice(0, 7)}`);
            }
          }
          advance("complete");
          break;
        }
        case "complete": {
          await watch("complete");
          const check = j.check!;
          const gate = await adapters.toolroll.gate(j.task.id);
          await checked(gate, "complete");
          if (gate.completion?.digest !== check.receipt) {
            intend("complete");
            const done = await adapters.toolroll.complete(j.task.id, check.receipt);
            if (!done.ok) throw new Stop("complete", `Couldn't mark task ${j.task.id} complete: ${done.message} Mark that exact result complete in the console, then rerun.`);
          }
          const after = await adapters.toolroll.gate(j.task.id);
          if (after.completion?.digest !== check.receipt) throw new Stop("complete", `Task ${j.task.id} is not marked complete for result ${check.receipt.slice(0, 12)}.`);
          j.completion = { actor: after.completion.actor, at: after.completion.at };
          advance("quiet");
          break;
        }
        case "quiet": {
          await waitFor("quiet", "running work to finish", async () => {
            await watch("complete");
            const busy = await adapters.toolroll.busy();
            return busy.running === 0 ? true : null;
          });
          advance("deploy");
          break;
        }
        case "deploy": {
          const check = j.check!;
          await recoverDeploy();
          await checked(await adapters.toolroll.gate(j.task.id), "deploy");
          // A deployment that finished but whose answer was lost: the services already run a runtime of this commit.
          let runtime = await served(adapters, builtHead());
          // Already running this candidate (a new generation after a CI failure, or a lost answer): the release still
          // reserves its deploy, so its merge has a deploy to stand on.
          if (runtime !== null && rel !== undefined && j.authority && epoch !== null) {
            const authority = await rel.authority(j.task.id);
            if (authority !== null && authority.state === "open") {
              await personCiBeforeDeploy();
              await watch("deploy");
              // Every deploy reservation, whatever the journal saved: CI must still be green on the exact commit.
              await autoCiHolds("the deploy");
              const reserved = await rel.reserve({ authority: j.authority.id, kind: "deploy", taskId: j.task.id, candidate: j.candidate.sha, epoch });
              if (!reserved.ok) throw new Stop("release", `The deploy couldn't be reserved: ${reserved.why}`);
              if (!await rel.start(reserved.operation, epoch)) throw new Stop("lease", "Another release coordinator took over this release.");
              await rel.finish(reserved.operation, "succeeded", { detail: "the services already run this candidate" }, epoch);
            }
          }
          if (runtime === null) {
            // The last moment a moved head restarts; then the deploy reservation freezes the candidate in the store.
            // A person's release: every required check passed on the exact commit, read now (the approval may have come
            // while CI ran). A check that failed stops here, before anything is deployed.
            await personCiBeforeDeploy();
            await watch("deploy");
            await pinned();
            // Every deploy issued, whatever the journal saved (a retry after a rollback included): CI still green.
            await autoCiHolds("the deploy");
            let operation: string | undefined, secret = "";
            if (rel !== undefined && j.authority && epoch !== null) {
              const reserved = await rel.reserve({ authority: j.authority.id, kind: "deploy", taskId: j.task.id, candidate: j.candidate.sha, epoch });
              if (!reserved.ok) throw new Stop("release", `The deploy couldn't be reserved: ${reserved.why}`);
              operation = reserved.operation;
              secret = reserved.secret ?? "";
              j.operations = { ...j.operations, deploy: operation };
              save();
            }
            j.deployAttempt = { stage: join(options.stateDir, "staged-upgrades", `browser-${j.candidate.sha.slice(0, 7)}-${randomUUID()}`) };
            intend("deploy");
            // The issuing fence, immediately before the deploy is spawned (review round 2): lease, epoch and the live
            // release again, in one transaction that marks the operation as issued by this process.
            if (operation !== undefined && !await rel!.start(operation, epoch!)) throw new Stop("lease", "Another release coordinator took over this release; the deploy didn't start.");
            const result = await adapters.toolroll.deploy({ run: check.run, worktree: check.worktree, stage: j.deployAttempt.stage, ...(operation === undefined ? {} : { operation: { id: operation, secret } }) });
            if (operation !== undefined) await rel!.finish(operation, result.ok ? "succeeded" : "failed", { detail: result.ok ? result.runtime : result.message.slice(0, 500) }, epoch!);
            if (!result.ok) throw deployStop("deploy", `The deployment of run ${check.run} stopped: ${result.message}`, result);
            if (!/[\\/]dist$/.test(result.runtime)) throw new Stop("deploy", `The deployment named ${result.runtime} as its runtime, which is not a dist folder.`);
            runtime = result.runtime;
            // Saved at once: everything after this (relinking, a rerun) uses the runtime the deployer named.
            j.deploy = { runtime, at: adapters.now().toISOString() };
            save();
          }
          const want = runtime;
          await waitFor("deploy", `the console and worker to run the gated commit from ${want}`, async () => (await served(adapters, builtHead())) === want ? true : null);
          j.deploy = { runtime: want, at: j.deploy?.runtime === want ? j.deploy.at : adapters.now().toISOString() };
          j.deployAttempt = null;
          delete j.intents.deploy;
          say(`  the service runs ${j.packageVersion} from ${want}`);
          advance("link");
          break;
        }
        case "link": {
          const runtime = j.deploy!.runtime;
          await autoCiHolds("the CLI names move");
          if (await served(adapters, builtHead()) !== runtime) throw new Stop("drift", `The console and worker no longer run ${runtime}; the CLI names were not moved.`);
          if (j.links === undefined || j.links === null) {
            j.links = await adapters.toolroll.cliLinks();
            intend("link");
          }
          try { await adapters.toolroll.switchLinks(j.links, join(runtime, "bin.js"), j.packageVersion); }
          catch (error) { throw new Stop("link", `The CLI names were not moved to ${runtime} (they point where they did): ${(error as Error).message}. The service already runs the new build; rerun to try again.`); }
          const everywhere = await deployed(adapters, builtHead());
          if (everywhere !== runtime) throw new Stop("mixed-runtime", `After relinking, the console, worker and both CLI names don't all run ${runtime} at ${j.candidate.sha.slice(0, 7)}.`);
          say(`  toolroll and standing-orders run ${join(runtime, "bin.js")}`);
          advance("ci");
          break;
        }
        case "ci": {
          await waitFor("ci", `the pull request checks on ${j.candidate.sha.slice(0, 7)}`, async () => {
            await pinned();
            const verdict = prChecksVerdict(await adapters.github.checks(j.github, j.candidate.sha), j.candidate.sha, REQUIRED_PR_CHECKS, { ...autoCap(), workflow: REQUIRED_PR_CHECKS_WORKFLOW });
            if (verdict.state === "failed") await ciFailedAfterDeploy(`Pull request checks failed on ${j.candidate.sha.slice(0, 7)}: ${verdict.failed.join(", ")}`);
            return verdict.state === "passed" ? true : null;
          });
          j.ci = { checks: [...REQUIRED_PR_CHECKS], at: adapters.now().toISOString() };
          advance("merge");
          break;
        }
        case "merge": {
          const pr = await adapters.github.pullRequest(j.github, j.branch);
          if (pr?.state === "merged" && pr.number === j.pr && pr.mergeCommit !== null) {
            if (pr.head !== j.candidate.sha || pr.base !== "main") throw new Stop("drift", `Merged pull request #${j.pr} does not match the gated commit and base.`);
            if (j.intents.merge === undefined) intend("merge");
            j.merge = { sha: pr.mergeCommit, tree: null };
          } else {
            // After the deploy reservation a moved head, a changed pull request or a stopped release stops it here.
            if (rel !== undefined && j.authority) await identity("merge", false);
            await pinned();
            // A squash merge only reproduces the gated (and CI-tested) tree when main hasn't moved past the branch's base.
            const main = await containsMain(adapters, j, "Nothing was merged");
            // Every release merges only where GitHub itself refuses a branch behind main.
            await mainProtection(adapters, j, j.auto?.state === "approved", "Nothing was merged");
            // The checks again, at the moment of merging: a rerun that failed since must not merge.
            const verdict = prChecksVerdict(await adapters.github.checks(j.github, j.candidate.sha), j.candidate.sha, REQUIRED_PR_CHECKS, { ...autoCap(), workflow: REQUIRED_PR_CHECKS_WORKFLOW });
            if (verdict.state !== "passed") await ciFailedAfterDeploy(`Pull request checks are no longer all passing on ${j.candidate.sha.slice(0, 7)}`);
            // Main once more, from GitHub, the last thing before the merge is reserved: moved since the comparison, it
            // stops here (finding 4). GitHub's own up-to-date rule refuses the rest of the window.
            const now = await adapters.github.mainHead(j.github);
            if (now !== main) throw new Stop("base-moved", `The branch is behind main; update it and push. Main moved to ${now.slice(0, 7)} while ${j.branch} was being merged, so what merges wouldn't be the tree CI tested. Nothing was merged: release the updated commit with \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`);
            let operation: string | undefined;
            if (rel !== undefined && j.authority && epoch !== null) {
              const reserved = await rel.reserve({ authority: j.authority.id, kind: "merge", taskId: j.task.id, candidate: j.candidate.sha, epoch });
              if (!reserved.ok) throw new Stop("release", `The merge couldn't be reserved: ${reserved.why}`);
              operation = reserved.operation;
              j.operations = { ...j.operations, merge: operation };
              save();
            }
            intend("merge");
            const message = landedWords(j.landed ?? []).join("\n");
            // The issuing fence, immediately before gh is spawned (review round 2).
            if (operation !== undefined && !await rel!.start(operation, epoch!)) throw new Stop("lease", "Another release coordinator took over this release; the merge didn't start.");
            let merged: string;
            try { merged = await adapters.github.merge(j.github, j.pr, j.candidate.sha, ...(message === "" ? [] : [message])); }
            catch (error) { if (operation !== undefined) await rel!.finish(operation, "unknown", { detail: String((error as Error)?.message ?? error).slice(0, 500) }, epoch!); throw error; }
            if (operation !== undefined) await rel!.finish(operation, "succeeded", { externalRef: merged }, epoch!);
            j.merge = { sha: merged, tree: null };
          }
          save();
          // This also runs after discovering a merge whose response was lost. Never delete a reused branch.
          await adapters.repo.deleteBranch(j.branch, j.candidate.sha);
          advance("tree");
          break;
        }
        case "tree": {
          const merge = j.merge!;
          await adapters.repo.sync(j.branch);
          const tree = await adapters.repo.tree(merge.sha);
          merge.tree = tree;
          if (tree !== j.candidate.tree) throw new Stop("tree-mismatch", `Main's merge commit ${merge.sha.slice(0, 7)} has tree ${tree.slice(0, 12)}, not the gated ${j.candidate.tree.slice(0, 12)}: main changed what was checked. Nothing was tagged; the deployed build stays as it is.`);
          advance("tag");
          break;
        }
        case "tag": {
          const merge = j.merge!;
          await publishHold();
          const at = await adapters.github.tag(j.github, j.tag);
          if (at !== null && at !== merge.sha) throw new Stop("conflict", `${j.tag} already points at ${at.slice(0, 7)}, not the merge ${merge.sha.slice(0, 7)}.`);
          if (at === null) { await autoCiHolds("the tag"); intend("tag"); await adapters.github.createTag(j.github, j.tag, merge.sha); }
          j.tagged = { sha: merge.sha };
          advance("publish");
          break;
        }
        case "publish": {
          await publishHold();
          if (j.intents.publish === undefined) intend("publish");
          await waitFor("publish", `npm, the GitHub release and the tag's checks for ${j.tag}`, async () => {
            if (await adapters.github.tag(j.github, j.tag) !== j.tagged!.sha) throw new Stop("conflict", `${j.tag} no longer points at the verified merge commit. Homebrew was not updated.`);
            const verdict = checksVerdict(await adapters.github.checks(j.github, j.tagged!.sha), RELEASE_TAG_CHECKS);
            if (verdict.state === "failed") throw new Stop("publish-failed", `The release tag's checks failed: ${verdict.failed.join(", ")}. Homebrew was not updated.`);
            if (verdict.state === "pending") return null;
            return await adapters.registry.published(j.packageName, j.packageVersion) && await adapters.github.release(j.github, j.tag) ? true : null;
          });
          j.published = { at: adapters.now().toISOString() };
          advance("homebrew");
          break;
        }
        case "homebrew": {
          await publishHold();
          // Homebrew is finished apart from publication (pipeline-speed.md, P1): npm and the GitHub release are verified,
          // so the release is published. This run proposes the tap's change and reads its checks once; only a run that
          // resumes to finish Homebrew waits for them. Pending or failed, the state is kept and the run ends published.
          const progress = await homebrewPass(finishingHomebrew);
          j.homebrew = { pr: j.homebrew?.pr ?? null, head: j.homebrew?.head ?? null, merged: progress.state === "current" && j.homebrew?.head != null ? true : j.homebrew?.merged ?? false, state: progress.state, why: progress.why };
          save();
          if (progress.state === "pending" || progress.state === "failed") { homebrewLeft = { state: progress.state, why: progress.why }; break; }
          advance("done");
          break;
        }
      }
      } catch (error) {
        if (!(error instanceof Restart)) throw error;
        await restart(error.head);
      }
    }
    const left = homebrewLeft as { state: "pending" | "failed"; why: string | null } | null;
    if (left === null) say(`Released ${j.tag}: deployed, merged as ${j.merge!.sha.slice(0, 7)}, tagged, published and ${j.homebrew?.state === "superseded" ? `left Homebrew as it is (${j.homebrew.why ?? "the tap names a newer version"})` : "on Homebrew"}.`);
    else say(`Published ${j.tag} (deployed, merged as ${j.merge!.sha.slice(0, 7)}, tagged, on npm and GitHub); Homebrew ${left.state}${left.why === null ? "" : `: ${left.why}`}. Finish it with \`${resume}\`.`);
    // The automatic road's note, once: when this run published (a run that only finishes Homebrew already said it).
    if (j.auto?.state === "approved" && !finishingHomebrew) { try { await rel?.auto?.released(j.task.id, j.tag); } catch { /* the release is done; the note is best effort */ } }
    for (const line of landedWords(j.landed ?? [])) say(line);
    return { ok: true, journal: j, file };
  } catch (error) {
    const stop = error instanceof Stop ? error : new Stop("error", String((error as Error)?.message ?? error));
    if (journal !== null) {
      journal.stopped = { step: journal.step, reason: stop.reason, message: stop.message, at: adapters.now().toISOString() };
      try { save(); } catch { /* the stop is still reported */ }
    }
    return { ok: false, reason: stop.reason, message: stop.message, step: journal?.step ?? step, journal, file, resume };
  }
}

/** The first run: everything checked before anything changes. */
async function begin(options: ReleaseOptions, adapters: ReleaseAdapters, now: Date): Promise<ReleaseJournal> {
  const { branch, checkout } = options;
  if (["main", "master"].includes(branch)) throw new Stop("usage", "Release a branch with an open pull request, not main.");
  const installed = await adapters.toolroll.installed();
  const runtimes = new Set([...installed.services, ...installed.clis.map(one => one.runtime ?? "(not linked)")]);
  if (installed.services.length === 0 || runtimes.size !== 1) {
    throw new Stop("mixed-runtime", `The console, worker and CLI names don't run one build (${[...installed.services.map(one => `service ${one}`), ...installed.clis.map(one => `${one.name} ${one.runtime ?? "not linked"}`)].join("; ")}). Update them to one verified build first.`);
  }
  const github = await adapters.repo.github();
  await adapters.repo.sync(branch);
  const sha = await adapters.repo.remoteHead(branch);
  if (sha === null) throw new Stop("no-branch", `${branch} is not on ${github}: push it first.`);
  const pr = await adapters.github.pullRequest(github, branch);
  if (pr === null || pr.state !== "open") throw new Stop("no-pull-request", `${branch} has no open pull request: open one first.`);
  if (pr.head !== sha) throw new Stop("drift", `Pull request #${pr.number} is at ${pr.head.slice(0, 7)}, the branch at ${sha.slice(0, 7)}.`);
  if (pr.base !== "main") throw new Stop("base", `Pull request #${pr.number} merges into ${pr.base}, not main.`);
  const manifest = await adapters.repo.fileAt(sha, "package.json");
  const pkg = manifest === null ? null : JSON.parse(manifest) as { name?: unknown; version?: unknown };
  if (typeof pkg?.name !== "string" || typeof pkg.version !== "string") throw new Stop("version", `package.json at ${sha.slice(0, 7)} names no package version.`);
  const tag = `v${pkg.version}`;
  const changelog = await adapters.repo.fileAt(sha, "CHANGELOG.md") ?? "";
  if (!new RegExp(`^## ${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`, "m").test(changelog)) throw new Stop("changelog", `CHANGELOG.md at ${sha.slice(0, 7)} has no "## ${pkg.version}" entry; the lead writes it before the release.`);
  if (await adapters.github.tag(github, tag) !== null) throw new Stop("version", `${tag} already exists: bump the version first.`);
  if (await adapters.registry.published(pkg.name, pkg.version)) throw new Stop("version", `${pkg.name}@${pkg.version} is already on npm: bump the version first.`);
  const tree = await adapters.repo.tree(sha);
  const at = now.toISOString();
  adapters.say(`Releasing ${pkg.name} ${pkg.version}: ${branch} at ${sha.slice(0, 7)}, pull request #${pr.number}.`);
  return {
    version: 1, id: randomUUID(), github, checkout, branch, candidate: { sha, tree }, packageName: pkg.name, packageVersion: pkg.version, tag, pr: pr.number,
    step: "gate", task: { id: gateTaskId(pkg.version, sha), scopeDigest: null }, approval: null, check: null, completion: null, deploy: null, ci: null,
    merge: null, tagged: null, published: null, homebrew: null, intents: {}, stopped: null, createdAt: at, updatedAt: at,
  };
}

/** A deployment stop; when it left an update pause before the swap, the guided way to lift it. */
function deployStop(reason: string, message: string, stop: DeployStop): Stop {
  if (stop.gate === undefined) return new Stop(reason, message);
  return new Stop("gate-held", `${message} New work is still paused by update ${stop.gate.id} (its journal stopped at ${stop.gate.phase}, before the swap). Check and lift that pause with \`toolroll release --release-gate ${stop.gate.id}\`, then rerun.`);
}

/** The one runtime the launchd services run, when it records the gated commit; otherwise null. */
async function served(adapters: ReleaseAdapters, candidate: string): Promise<string | null> {
  const installed = await adapters.toolroll.installed();
  const runtimes = new Set(installed.services);
  if (runtimes.size !== 1) return null;
  const [runtime] = runtimes;
  return runtime !== undefined && await adapters.toolroll.runtimeCommit(runtime) === candidate ? runtime : null;
}

/** The one runtime the services and both CLI names run, when it records the gated commit; otherwise null. */
async function deployed(adapters: ReleaseAdapters, candidate: string): Promise<string | null> {
  const installed = await adapters.toolroll.installed();
  const runtimes = new Set([...installed.services, ...installed.clis.map(one => one.runtime ?? "")]);
  if (installed.services.length === 0 || installed.clis.length < 2 || runtimes.size !== 1) return null;
  const [runtime] = runtimes;
  return runtime !== undefined && runtime !== "" && await adapters.toolroll.runtimeCommit(runtime) === candidate ? runtime : null;
}

/**
 * The gate's look at the pull request's required checks on the exact commit, before anything is filed or anyone is
 * asked to approve (#237): a required check that failed or was cancelled stops here; checks not started or still
 * running are named, and the gate waits for them; ones that never finish within the gate's limit stop here too. GitHub
 * not answering is waited out the same way, never taken for a pass. The ci step still checks again before merging.
 */
/**
 * The branch must contain main's head as GitHub's API answers now: CI tests the pull request's head commit,
 * so only a branch that already holds main merges into exactly the tested tree. Refused in plain words otherwise.
 */
async function containsMain(adapters: ReleaseAdapters, j: ReleaseJournal, nothing: string): Promise<string> {
  // GitHub's own answers (eval-harness review 1, finding 4): main's head and the comparison are read from its API by
  // this coordinator, never from refs/remotes/origin/main in a checkout a build can write. The checkout is still synced
  // for what the gate reads from it later.
  await adapters.repo.sync(j.branch);
  const main = await adapters.github.mainHead(j.github);
  if (!/^[0-9a-f]{40}$/.test(main)) throw new Stop("base-moved", `GitHub named no commit for main. ${nothing}.`);
  if (await adapters.github.contains(j.github, j.candidate.sha, main)) return main;
  throw new Stop("base-moved", `The branch is behind main; update it and push. ${j.branch} at ${j.candidate.sha.slice(0, 7)} doesn't contain main's head ${main.slice(0, 7)}, so what merges wouldn't be the tree CI tested. ${nothing}: release the updated commit with \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`);
}

/**
 * GitHub must refuse a branch behind main for every release (eval-harness review 1, finding 4). A person's approval
 * cannot make the final main read and merge atomic, so absent or unreadable protection stops that release too.
 */
async function mainProtection(adapters: ReleaseAdapters, j: ReleaseJournal, auto: boolean, nothing: string): Promise<void> {
  let protection: MainProtection | null;
  try { protection = await adapters.github.upToDateRequired(j.github); } catch { protection = null; }
  // The git lanes main's protection doesn't name yet are said, never refused (PROTECTION_REPORT_ONLY_CHECKS).
  if (protection !== null && protection.notYetRequired.length > 0) adapters.say(`  Note: main's protection doesn't require ${protection.notYetRequired.join(", ")} yet; add ${protection.notYetRequired.length === 1 ? "it" : "them"} to its required checks.`);
  if (protection?.effective === true) return;
  const lacking = protection === null ? "GitHub's branch protection for main couldn't be read" : `main's protection doesn't hold: ${protection.missing.join("; ")}`;
  throw new Stop("base-unprotected", `${lacking}, so this release can't merge${auto ? " automatically" : ""}. ${nothing}. Restore effective main protection and try again.`);
}

/**
 * Wait for every required pull request check on the candidate to pass; stop on one that failed. `pendingIsEnough` (the
 * automatic road's gate, pipeline-speed.md D2): checks still running are no reason to wait — returns false then, true
 * once they all passed. `nothing` says what hasn't happened yet when a check failed.
 */
async function earlyChecks(adapters: ReleaseAdapters, j: ReleaseJournal, wait: <T>(what: string, probe: () => Promise<T | null>) => Promise<T>,
  options: { pendingIsEnough?: boolean; nothing?: string } = {}): Promise<boolean> {
  const nothing = options.nothing ?? "Nothing was filed or sent for approval";
  const sha = j.candidate.sha.slice(0, 7);
  const required: readonly string[] = REQUIRED_PR_CHECKS;
  let named = "", unread = false;
  try {
    return await wait(`the pull request checks on ${sha}`, async () => {
      let runs: CheckRun[];
      try { runs = await adapters.github.checks(j.github, j.candidate.sha); }
      catch (error) {
        if (!unread) adapters.say(`  Couldn't read the pull request checks on ${sha} (${(error as Error)?.message ?? error}); trying again.`);
        unread = true;
        return null;
      }
      const verdict = prChecksVerdict(runs.filter(run => required.includes(run.name)), j.candidate.sha, required, { workflow: REQUIRED_PR_CHECKS_WORKFLOW });
      if (verdict.state === "failed") {
        throw new Stop("ci-failed", `Pull request checks already failed on ${sha}: ${verdict.failed.join(", ")}. ${nothing}. Fix the branch, then release the new commit with \`toolroll release ${j.branch} --repo ${j.checkout} --new\` (or rerun the failed job on GitHub and run this command again).`);
      }
      if (verdict.state === "passed") return true;
      if (options.pendingIsEnough === true) return false;
      const now = verdict.waiting.join(", ");
      if (now !== named) { adapters.say(`  Pull request checks on ${sha} not finished yet: ${now}.`); named = now; }
      return null;
    });
  } catch (error) {
    if (!(error instanceof Stop) || error.reason !== "timeout") throw error;
    throw new Stop("ci-missing", `Pull request checks on ${sha} didn't all finish in time${named === "" ? (unread ? " (GitHub didn't answer)" : "") : `: ${named}`}. ${nothing}. Start or rerun them on GitHub, then run this command again.`);
  }
}

/** The network failures a release's waits ride out: git or gh timing out (or cut off) on the way to GitHub. */
const TRANSIENT_NETWORK = /Recv failure: (?:Operation timed out|Connection reset by peer)|TLS handshake timeout|Operation timed out|Connection timed out|i\/o timeout|Connection reset by peer|Failed to connect to [^\s]*github\.com port \d+/i;

/** A probe's failure that is only the network to GitHub being slow, never a decision (a Stop) or another error. */
export function transientNetworkError(error: unknown): boolean {
  if (error instanceof Stop || error instanceof Restart) return false;
  return TRANSIENT_NETWORK.test(String((error as Error)?.message ?? error));
}

/** The part of a network failure worth saying: its matching phrase. */
function networkWords(error: unknown): string {
  return TRANSIENT_NETWORK.exec(String((error as Error)?.message ?? error))?.[0] ?? "a network failure";
}

/**
 * The pull request's checks on exactly `head`, every attempt (the adapter asks GitHub for all of them, filter=all):
 * each reported attempt must be filed under `head` with a check-run id; a required check counts only from GitHub
 * Actions (an app that names a check alike can't stand in for it); attempts are grouped by the job they belong to — the
 * app, its check suite (a workflow run, whose re-runs stay in it) and the name — and every group is judged by its
 * latest attempt; every required check needs a group. With `auto` (an automatic approval), every other failed attempt on
 * the commit — an earlier attempt, or a job a newer run renamed or dropped — must be one GitHub's own job record shows ending before any workflow step ran (`beforeTests`: confirmed
 * infrastructure), and at most INFRA_RERUNS_PER_CANDIDATE of them on the commit; any other earlier failure — a test,
 * a typecheck, or one nothing explains — fails the verdict, so a person decides. The failures it tolerated are returned.
 */
export function prChecksVerdict(runs: readonly CheckRun[], head: string, required: readonly string[], options: { auto?: true; workflow?: string } = {}):
  { state: "passed"; failures: CheckFailure[] } | { state: "pending"; waiting: string[] } | { state: "failed"; failed: string[] } {
  const failed: string[] = [], waiting: string[] = [], failures: CheckFailure[] = [];
  const valid: CheckRun[] = [];
  for (const run of runs) {
    if (run.head !== head) { failed.push(`${run.name} (reported for ${run.head == null ? "no commit" : run.head.slice(0, 7)}, not ${head.slice(0, 7)})`); continue; }
    if (typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id <= 0) { failed.push(`${run.name} (no check run id)`); continue; }
    if (required.includes(run.name) && run.app !== "github-actions") { failed.push(`${run.name} (reported by ${run.app ?? "an unknown app"}, not GitHub Actions)`); continue; }
    // A required name counts only from the workflow that defines it: a job of the same name in another workflow (or
    // one whose workflow GitHub doesn't name) fails the verdict rather than stand in for it.
    if (options.workflow !== undefined && required.includes(run.name) && !workflowIs(run.workflowPath, options.workflow)) {
      failed.push(`${run.name} (from ${run.workflowPath ?? "a workflow GitHub doesn't name"}, not ${options.workflow})`); continue;
    }
    if (run.app === "github-actions" && (typeof run.suite !== "number" || !Number.isSafeInteger(run.suite))) { failed.push(`${run.name} (no workflow run)`); continue; }
    valid.push(run);
  }
  // Supersession by trusted workflow identity (GitHub's workflow-run API, read by the adapter): a newer run of the same
  // workflow on this commit replaces the older ones — its jobs are the current ones. A suite whose workflow isn't known
  // is its own workflow (nothing supersedes it), and another app's suites stand on their own.
  const workflowOf = (run: CheckRun): string => run.app === "github-actions" && typeof run.workflow === "number" ? `w:${run.workflow}` : `s:${run.app ?? ""}:${run.suite ?? ""}`;
  const current = new Map<string, number | null>();
  for (const run of valid) { const key = workflowOf(run), suite = run.suite ?? null; const was = current.get(key); if (was === undefined || (suite !== null && (was === null || suite > was))) current.set(key, suite); }
  // Jobs: a workflow and a name, every attempt in every suite of it; judged by the latest attempt in the current suite.
  const groups = new Map<string, CheckRun[]>();
  for (const run of valid) { const key = JSON.stringify([workflowOf(run), run.name]); groups.set(key, [...(groups.get(key) ?? []), run]); }
  const judged = new Set<string>();
  // The attempt each current job stands on (its latest in the current run); every other attempt on the commit is
  // history, whatever its job is called now.
  const standing = new Set<CheckRun>();
  for (const attempts of groups.values()) {
    const ordered = [...attempts].sort((a, b) => a.id! - b.id!);
    const now = current.get(workflowOf(ordered[0]!)) ?? null;
    const live = ordered.filter(one => (one.suite ?? null) === now);
    // A job only an older run had (the newer run no longer has it, or calls it something else) doesn't stand for a
    // required check; its failures are still history below.
    if (live.length === 0) continue;
    const latest = live.at(-1)!, name = latest.name;
    judged.add(name);
    standing.add(latest);
    if (latest.status !== "completed") { waiting.push(`${name} (${latest.status})`); continue; }
    if (latest.conclusion !== "success") { failed.push(`${name} (${latest.conclusion ?? "no conclusion"})`); continue; }
  }
  // Every failed attempt on the commit that no current job stands on — an earlier attempt of a job, a job a newer run
  // renamed, dropped, or never ran again — is classified before anything is superseded (eval-harness review 1, finding
  // 1): a renamed or vanished job never erases a failure. An automatic approval tolerates only confirmed
  // infrastructure (GitHub's job record shows the runner failing before any workflow step ran), and waits out any
  // earlier attempt still running.
  const history = valid.filter(one => !standing.has(one));
  if (options.auto === true) {
    for (const one of history) if (one.status !== "completed") waiting.push(`${one.name} (an earlier attempt still running)`);
  }
  const flaked = history.filter(one => one.status === "completed" && one.conclusion !== "success");
  if (options.auto === true) {
    const unexplained = new Map<string, number>();
    for (const one of flaked) if (one.beforeTests !== true) unexplained.set(one.name, (unexplained.get(one.name) ?? 0) + 1);
    for (const [name, count] of unexplained) failed.push(`${name} (failed ${count === 1 ? "once" : `${count} times`} on this commit, and GitHub doesn't show its runner failing before the tests ran)`);
  }
  const infrastructure = flaked.filter(one => one.beforeTests === true).length;
  failures.push(...flaked.map(one => ({ id: one.id!, name: one.name, conclusion: one.conclusion })));
  if (options.auto === true && infrastructure > INFRA_RERUNS_PER_CANDIDATE) failed.push(`GitHub's runners failed ${infrastructure} times on this commit before the tests ran (at most ${INFRA_RERUNS_PER_CANDIDATE} are rerun)`);
  for (const name of required) if (!judged.has(name)) waiting.push(`${name} (not started)`);
  if (failed.length > 0) return { state: "failed", failed };
  return waiting.length > 0 ? { state: "pending", waiting } : { state: "passed", failures };
}

/**
 * What a failed release check means and what happens next, by its class (check-failure.ts), in words. Only confirmed
 * infrastructure reruns on its own; nothing else is rerun to pass.
 */
export function checkFailedWords(input: { sha: string; run: number; class: FailureClassName | null; why: string; branch: string; checkout: string; taskId: string }): string {
  const short = input.sha.slice(0, 7), again = `\`toolroll release ${input.branch} --repo ${input.checkout} --new\``;
  switch (input.class) {
    case "deterministic":
      return `The Full release check of ${short} failed (run ${input.run}): ${input.why}. That is a failure in the code or its tests, so it isn't run again: fix the branch, then release the new commit with ${again}.`;
    case "agent-behaviour":
      return `The Full release check of ${short} failed (run ${input.run}): ${input.why}. Real-model journeys are counted, never rerun until they pass, so a person decides: fix the branch and release the new commit with ${again}, or approve this commit again with ${again}.`;
    case "infrastructure":
      return `The Full release check of ${short} failed (run ${input.run}): ${input.why}. It was already run again as often as a commit is (${INFRA_RERUNS_PER_CANDIDATE} times), so a person decides: approve this commit again with ${again}.`;
    case "unknown":
      return `The Full release check of ${short} failed (run ${input.run}) with no failure Toolroll could explain: ${input.why}. It isn't rerun to pass. To look into it, \`toolroll task regate ${input.taskId}\` runs it again on the same commit, but a pass then doesn't erase this failure: a person decides, and approves this commit again with ${again}, or fixes the branch and releases the new commit the same way.`;
    default:
      return `The Full release check of ${short} did not pass (run ${input.run}): ${input.why}. Fix the branch and release the new commit with ${again}.`;
  }
}

/** Whether GitHub's workflow-run `path` names exactly `file` (it may carry the ref it ran from, after an `@`). */
export function workflowIs(path: string | null | undefined, file: string): boolean {
  return typeof path === "string" && (path === file || path.startsWith(`${file}@`));
}
