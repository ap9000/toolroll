/**
 * `toolroll release <branch>` (D10): the whole release of Toolroll itself as one resumable command. The owner's
 * approval of the release scope is the only human step; everything else runs headless, each waiting step with a time
 * limit:
 *
 *   gate → approval → check → complete → quiet → deploy → link → ci → merge → tree → tag → publish → homebrew → done
 *
 * gate files a prepared-candidate task pinned to the branch's exact commit, with the full release check. approval
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
 * waits for npm, the GitHub release and the macOS checks; homebrew updates the tap's formula and merges it.
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

/** The pull-request checks a release waits for, by exact job name (.github/workflows/ci.yml). Every one must have
 * concluded `success` on the gated commit; src/ci-workflow.test.ts holds the workflow to this list. */
export const REQUIRED_PR_CHECKS = [
  "node 22 · ubuntu-latest",
  "node 24 · ubuntu-latest",
  "linux native containment · delegated cgroup v2",
  "Windows Job Object containment",
] as const;
/** The checks a release tag runs (.github/workflows/publish.yml), awaited before Homebrew moves. */
export const RELEASE_TAG_CHECKS = ["node 22 · macos-latest", "node 24 · macos-latest", "publish"] as const;

export const RELEASE_STEPS = ["gate", "approval", "check", "complete", "quiet", "deploy", "link", "ci", "merge", "tree", "tag", "publish", "homebrew", "done"] as const;
export type ReleaseStep = typeof RELEASE_STEPS[number];
type WaitingStep = "approval" | "check" | "quiet" | "deploy" | "ci" | "publish" | "homebrew";
/** How long each waiting step may take, in minutes, before the release stops there (rerunning continues from it). */
export const RELEASE_LIMITS: Readonly<Record<WaitingStep, number>> = { approval: 24 * 60, check: 120, quiet: 60, deploy: 30, ci: 60, publish: 45, homebrew: 45 };
const POLL_MS = 15_000;

export type CheckRun = { name: string; status: string; conclusion: string | null };
export type PullRequest = { number: number; state: "open" | "closed" | "merged"; head: string; base: string; mergeCommit: string | null };
/** The release task as Toolroll records it (`task show --json`). */
export type GateState = {
  exists: boolean;
  candidate: string | null;
  scopeDigest: string | null;
  /** The current approval of the scope: by whom, of which digest, and how (`password` or `chat` is a person's yes). */
  approval: { by: string; at: string; digest: string; basis: string | null; role: string | null; active: boolean } | null;
  /** The newest finished build of the task: its sealed result and check. */
  result: { run: number; head: string | null; check: string; level: string | null; receipt: string; worktree: string | null } | null;
  /** A finished build that left no result to complete (it failed before the check), in words. */
  failed: string | null;
  completion: { actor: string; at: string; digest: string } | null;
};
export type Installed = { services: string[]; clis: { name: string; runtime: string | null }[] };
/** A CLI name's link on PATH and where it pointed before the release moved it (release-links.ts). */
export type SavedLink = { name: string; path: string; before: string | null; foreign?: true };
/** A deployment that stopped and couldn't recover. `gate`: the update pause it left, when its journal is before the swap. */
export type DeployStop = { ok: false; message: string; gate?: { id: string; phase: string } };
export type HomebrewState = { kind: "current" } | { kind: "proposed"; pr: number; head: string } | { kind: "missing" };

export type ReleaseAdapters = {
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
    /** origin/main as the last sync fetched it. */
    mainHead(): Promise<string>;
    /** Whether `ancestor` is in `sha`'s history. */
    contains(sha: string, ancestor: string): Promise<boolean>;
  };
  toolroll: {
    /** Which runtime each launchd service and each CLI name (`toolroll`, `standing-orders`) runs from. */
    installed(): Promise<Installed>;
    /** The exact commit recorded in the deployment's runtime/package.json. */
    runtimeCommit(runtime: string): Promise<string | null>;
    gate(taskId: string): Promise<GateState>;
    fileGate(input: { taskId: string; title: string; checkout: string; candidate: string; goal: string; acceptance: string }): Promise<{ scopeDigest: string }>;
    complete(taskId: string, receipt: string): Promise<{ ok: true } | { ok: false; message: string }>;
    busy(): Promise<{ running: number; tasks: string[] }>;
    /** scripts/deploy-browser.mjs --run --stage --yes from the builder's checkout; runtime is its final JSON's `runtime`. */
    deploy(input: { run: number; worktree: string; stage: string }): Promise<{ ok: true; runtime: string } | DeployStop>;
    /** scripts/deploy-browser.mjs --stage --phase recover for a stage that was launched; a stage never prepared is ok. */
    recoverDeploy(input: { run: number; worktree: string; stage: string }): Promise<{ ok: true } | DeployStop>;
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
    merge(repo: string, pr: number, head: string): Promise<string>;
    tag(repo: string, tag: string): Promise<string | null>;
    createTag(repo: string, tag: string, sha: string): Promise<void>;
    release(repo: string, tag: string): Promise<boolean>;
  };
  registry: { published(name: string, version: string): Promise<boolean> };
  homebrew: {
    repo: string;
    state(version: string): Promise<HomebrewState>;
    propose(version: string): Promise<{ pr: number; head: string }>;
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
  check: { run: number; receipt: string; worktree: string } | null;
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
  homebrew: { pr: number | null; head: string | null; merged: boolean } | null;
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
};

/** A stop the release reports: the step it stopped at and why, in words. */
class Stop extends Error {
  constructor(readonly reason: string, message: string) { super(message); }
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
  if (approval.basis !== "password" && approval.basis !== "chat") return { ok: false, why: `approved by ${approval.basis ?? "an unknown road"}, not by a person` };
  if (/ \(AI\)$/.test(approval.by) || /^mode /.test(approval.by) || /^lead\b/.test(approval.by) || approval.by === "routine") return { ok: false, why: `approved as ${approval.by}, not by a person` };
  if (approval.role !== "approver" || !approval.active) return { ok: false, why: `approved by ${approval.by}, who is not an active approver` };
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
  /** Ask `probe` until it answers, within this step's limit. */
  const waitFor = async <T>(at: WaitingStep, what: string, probe: () => Promise<T | null>): Promise<T> => {
    const deadline = adapters.now().getTime() + limits[at] * 60_000;
    let said = false;
    for (;;) {
      const answer = await probe();
      if (answer !== null) return answer;
      if (adapters.now().getTime() >= deadline) throw new Stop("timeout", `Still waiting for ${what} after ${limits[at]} minutes.`);
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
      journal = null;
    }
    if (journal?.step === "done") {
      say(`Released ${journal.tag} (${journal.candidate.sha.slice(0, 7)}) — nothing left to do.`);
      return { ok: true, journal, file };
    }

    if (!await adapters.github.authenticated()) throw new Stop("github-auth", "GitHub CLI is not signed in: run `gh auth login`, then rerun.");
    if (journal === null) journal = await begin(options, adapters, adapters.now());
    else say(`Resuming the release of ${journal.tag} (${journal.candidate.sha.slice(0, 7)}) at ${journal.step}.`);
    const j = journal;
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
    const approved = (gate: GateState) => {
      if (gate.candidate !== j.candidate.sha || gate.scopeDigest !== j.task.scopeDigest) throw new Stop("scope-changed", `Task ${j.task.id}'s candidate or scope changed after approval.`);
      const owner = ownerApproval(gate, j.task.scopeDigest);
      if (!owner.ok) throw new Stop("approval", `Task ${j.task.id}: ${owner.why}. An active approver must approve the release scope.`);
    };
    const fullCheck = (gate: GateState) => {
      if (gate.result?.level !== "full") throw new Stop("check-level", `A Full check is required for this release (run ${gate.result?.run ?? "unknown"}: ${gate.result?.level ?? "unknown"}). Quick and Off checks cannot release a build.`);
      if (gate.result.check !== "passed") throw new Stop("check-failed", `The Full release check of ${j.candidate.sha.slice(0, 7)} did not pass (run ${gate.result.run}: ${gate.result.check}). It stays as it is: fix the branch and release the new commit with --new.`);
    };
    const checked = (gate: GateState) => {
      approved(gate);
      if (gate.result?.head !== j.candidate.sha || gate.result?.receipt !== j.check?.receipt) throw new Stop("drift", `Task ${j.task.id}'s result changed since its check passed.`);
      fullCheck(gate);
    };

    while (j.step !== "done") {
      step = j.step;
      say(`• ${j.step}`);
      switch (j.step) {
        case "gate": {
          await pinned();
          const existing = await adapters.toolroll.gate(j.task.id);
          if (existing.exists) {
            if (existing.candidate !== j.candidate.sha) throw new Stop("conflict", `Task ${j.task.id} exists for a different commit (${existing.candidate?.slice(0, 7) ?? "none"}).`);
            j.task.scopeDigest = existing.scopeDigest;
          } else {
            intend("gate");
            await adapters.repo.sync(j.branch);
            const filed = await adapters.toolroll.fileGate({
              taskId: j.task.id, title: `Release ${j.packageVersion}`, checkout: j.checkout, candidate: j.candidate.sha,
              goal: `Verify ${j.packageName} ${j.packageVersion} (${j.branch} at ${j.candidate.sha}) passes the approved release check before it is deployed, merged, tagged and published.`,
              acceptance: "The approved release check passes on the candidate commit|check",
            });
            j.task.scopeDigest = filed.scopeDigest;
          }
          advance("approval");
          break;
        }
        case "approval": {
          say(`  The release scope needs your approval: \`toolroll task approve ${j.task.id} --digest ${j.task.scopeDigest}\`, or open the task in the console.`);
          const approved = await waitFor("approval", `a person to approve task ${j.task.id}`, async () => {
            const gate = await adapters.toolroll.gate(j.task.id);
            if (gate.scopeDigest !== j.task.scopeDigest) throw new Stop("scope-changed", `The scope of ${j.task.id} changed after it was filed; the release only runs on the scope it filed.`);
            const owner = ownerApproval(gate, j.task.scopeDigest);
            if (!owner.ok && gate.approval !== null && owner.why !== "the approval is for different scope text") throw new Stop("approval", `Task ${j.task.id} was ${owner.why}; the release needs a person to approve it.`);
            return owner.ok ? owner : null;
          });
          j.approval = { by: approved.by, at: approved.at };
          say(`  approved by ${approved.by}`);
          advance("check");
          break;
        }
        case "check": {
          const result = await waitFor("check", `the release check of ${j.candidate.sha.slice(0, 7)}`, async () => {
            const gate = await adapters.toolroll.gate(j.task.id);
            approved(gate);
            if (gate.failed !== null) throw new Stop("check-failed", `The release build of ${j.task.id} failed: ${gate.failed}. Fix it and release the new commit with --new.`);
            if (gate.result === null || gate.result.check === "running" || gate.result.check === "pending") return null;
            if (gate.result.head !== j.candidate.sha) throw new Stop("drift", `The release result is for ${gate.result.head?.slice(0, 7) ?? "no commit"}, not ${j.candidate.sha.slice(0, 7)}.`);
            fullCheck(gate);
            if (gate.result.worktree === null) throw new Stop("worktree", `Run ${gate.result.run} names no checkout to deploy from.`);
            return { run: gate.result.run, receipt: gate.result.receipt, worktree: gate.result.worktree };
          });
          j.check = result;
          say(`  run ${result.run} passed on ${j.candidate.sha.slice(0, 7)}`);
          advance("complete");
          break;
        }
        case "complete": {
          const check = j.check!;
          const gate = await adapters.toolroll.gate(j.task.id);
          checked(gate);
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
            const busy = await adapters.toolroll.busy();
            return busy.running === 0 ? true : null;
          });
          advance("deploy");
          break;
        }
        case "deploy": {
          const check = j.check!;
          await recoverDeploy();
          checked(await adapters.toolroll.gate(j.task.id));
          // A deployment that finished but whose answer was lost: the services already run a runtime of this commit.
          let runtime = await served(adapters, j.candidate.sha);
          if (runtime === null) {
            await pinned();
            j.deployAttempt = { stage: join(options.stateDir, "staged-upgrades", `browser-${j.candidate.sha.slice(0, 7)}-${randomUUID()}`) };
            intend("deploy");
            const result = await adapters.toolroll.deploy({ run: check.run, worktree: check.worktree, stage: j.deployAttempt.stage });
            if (!result.ok) throw deployStop("deploy", `The deployment of run ${check.run} stopped: ${result.message}`, result);
            if (!/[\\/]dist$/.test(result.runtime)) throw new Stop("deploy", `The deployment named ${result.runtime} as its runtime, which is not a dist folder.`);
            runtime = result.runtime;
            // Saved at once: everything after this (relinking, a rerun) uses the runtime the deployer named.
            j.deploy = { runtime, at: adapters.now().toISOString() };
            save();
          }
          const want = runtime;
          await waitFor("deploy", `the console and worker to run the gated commit from ${want}`, async () => (await served(adapters, j.candidate.sha)) === want ? true : null);
          j.deploy = { runtime: want, at: j.deploy?.runtime === want ? j.deploy.at : adapters.now().toISOString() };
          j.deployAttempt = null;
          delete j.intents.deploy;
          say(`  the service runs ${j.packageVersion} from ${want}`);
          advance("link");
          break;
        }
        case "link": {
          const runtime = j.deploy!.runtime;
          if (await served(adapters, j.candidate.sha) !== runtime) throw new Stop("drift", `The console and worker no longer run ${runtime}; the CLI names were not moved.`);
          if (j.links === undefined || j.links === null) {
            j.links = await adapters.toolroll.cliLinks();
            intend("link");
          }
          try { await adapters.toolroll.switchLinks(j.links, join(runtime, "bin.js"), j.packageVersion); }
          catch (error) { throw new Stop("link", `The CLI names were not moved to ${runtime} (they point where they did): ${(error as Error).message}. The service already runs the new build; rerun to try again.`); }
          const everywhere = await deployed(adapters, j.candidate.sha);
          if (everywhere !== runtime) throw new Stop("mixed-runtime", `After relinking, the console, worker and both CLI names don't all run ${runtime} at ${j.candidate.sha.slice(0, 7)}.`);
          say(`  toolroll and standing-orders run ${join(runtime, "bin.js")}`);
          advance("ci");
          break;
        }
        case "ci": {
          await waitFor("ci", `the pull request checks on ${j.candidate.sha.slice(0, 7)}`, async () => {
            await pinned();
            const verdict = checksVerdict(await adapters.github.checks(j.github, j.candidate.sha), REQUIRED_PR_CHECKS);
            if (verdict.state === "failed") throw new Stop("ci-failed", `Pull request checks failed on ${j.candidate.sha.slice(0, 7)}: ${verdict.failed.join(", ")}. Nothing was merged. Rerun the failed job on GitHub, then rerun this command.`);
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
            await pinned();
            // A squash merge only reproduces the gated tree when main hasn't moved past the branch's base.
            await adapters.repo.sync(j.branch);
            const main = await adapters.repo.mainHead();
            if (!await adapters.repo.contains(j.candidate.sha, main)) throw new Stop("base-moved", `main moved to ${main.slice(0, 7)}, which ${j.branch} doesn't contain, so the merge wouldn't be the gated tree. Nothing was merged: update the branch and release the new commit with --new.`);
            // The checks again, at the moment of merging: a rerun that failed since must not merge.
            const verdict = checksVerdict(await adapters.github.checks(j.github, j.candidate.sha), REQUIRED_PR_CHECKS);
            if (verdict.state !== "passed") throw new Stop("ci-failed", `Pull request checks are no longer all passing on ${j.candidate.sha.slice(0, 7)}; nothing was merged.`);
            intend("merge");
            j.merge = { sha: await adapters.github.merge(j.github, j.pr, j.candidate.sha), tree: null };
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
          const at = await adapters.github.tag(j.github, j.tag);
          if (at !== null && at !== merge.sha) throw new Stop("conflict", `${j.tag} already points at ${at.slice(0, 7)}, not the merge ${merge.sha.slice(0, 7)}.`);
          if (at === null) { intend("tag"); await adapters.github.createTag(j.github, j.tag, merge.sha); }
          j.tagged = { sha: merge.sha };
          advance("publish");
          break;
        }
        case "publish": {
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
          const brew = adapters.homebrew;
          let state = await brew.state(j.packageVersion);
          if (state.kind === "missing") { intend("homebrew"); const proposed = await brew.propose(j.packageVersion); state = { kind: "proposed", ...proposed }; }
          if (state.kind === "proposed") {
            const proposed = state;
            j.homebrew = { pr: proposed.pr, head: proposed.head, merged: false };
            save();
            await waitFor("homebrew", `the Homebrew change's checks (${brew.repo} #${proposed.pr})`, async () => {
              const runs = await adapters.github.checks(brew.repo, proposed.head);
              // GitHub registers checks asynchronously; an empty set says nothing about success.
              if (runs.length === 0) return null;
              const verdict = checksVerdict(runs, [...new Set(runs.map(one => one.name))]);
              if (verdict.state === "failed") throw new Stop("homebrew-failed", `The Homebrew change's checks failed: ${verdict.failed.join(", ")}.`);
              return verdict.state === "passed" ? true : null;
            });
            await brew.merge(proposed.pr, proposed.head);
          }
          j.homebrew = { pr: j.homebrew?.pr ?? null, head: j.homebrew?.head ?? null, merged: true };
          advance("done");
          break;
        }
      }
    }
    say(`Released ${j.tag}: deployed, merged as ${j.merge!.sha.slice(0, 7)}, tagged, published and on Homebrew.`);
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
