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

/** The pull-request checks a release waits for, by exact job name (.github/workflows/ci.yml). Every one must have
 * concluded `success` on the gated commit; src/ci-workflow.test.ts holds the workflow to this list. */
export const REQUIRED_PR_CHECKS = [
  "node 22 · ubuntu-latest",
  "node 24 · ubuntu-latest",
  "linux native containment · delegated cgroup v2",
  "linux fence · sandbox-runtime",
  "Windows Job Object containment",
] as const;
/** The checks a release tag runs (.github/workflows/publish.yml), awaited before Homebrew moves. */
export const RELEASE_TAG_CHECKS = ["node 22 · macos-latest", "node 24 · macos-latest", "publish"] as const;

export const RELEASE_STEPS = ["gate", "approval", "check", "complete", "quiet", "deploy", "link", "ci", "merge", "tree", "tag", "publish", "homebrew", "done"] as const;
export type ReleaseStep = typeof RELEASE_STEPS[number];
type WaitingStep = "gate" | "approval" | "check" | "quiet" | "deploy" | "ci" | "publish" | "homebrew";
/** How long each waiting step may take, in minutes, before the release stops there (rerunning continues from it). */
export const RELEASE_LIMITS: Readonly<Record<WaitingStep, number>> = { gate: 60, approval: 24 * 60, check: 120, quiet: 60, deploy: 30, ci: 60, publish: 45, homebrew: 45 };
const POLL_MS = 15_000;

/** One check attempt; `app` is the GitHub App that made it (github-actions for a workflow), when known. */
export type CheckRun = { name: string; status: string; conclusion: string | null; app?: string | null };
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
  completion: { actor: string; at: string; digest: string } | null;
};
export type Installed = { services: string[]; clis: { name: string; runtime: string | null }[] };
/** A CLI name's link on PATH and where it pointed before the release moved it (release-links.ts). */
export type SavedLink = { name: string; path: string; before: string | null; foreign?: true };
/** A deployment that stopped and couldn't recover. `gate`: the update pause it left, when its journal is before the swap. */
export type DeployStop = { ok: false; message: string; gate?: { id: string; phase: string } };
export type HomebrewState = { kind: "current" } | { kind: "proposed"; pr: number; head: string } | { kind: "missing" };

/** One commit that landed after the approval, with its files and line counts (release_carry). */
export type LandedCommit = { sha: string; files: { path: string; added: number; deleted: number }[] };
/** A release's authority record as the coordinator reads it (store.ts release_authority). */
export type AuthorityView = { id: number; generation: number; state: string; tipSha: string; tipTask: string; version: string; pr: number; landed: LandedCommit[] };
export type ReleaseAction = "dispatch" | "deploy" | "merge" | "complete";
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
    merge(repo: string, pr: number, head: string, message?: string): Promise<string>;
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
  homebrew: { pr: number | null; head: string | null; merged: boolean } | null;
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
  constructor(readonly reason: string, message: string) { super(message); }
}
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
      freshApproval = journal.needsApproval === true;
      supersededTask = journal.task.id;
      journal = null;
    }
    if (journal?.step === "done") {
      say(`Released ${journal.tag} (${journal.candidate.sha.slice(0, 7)}) — nothing left to do.`);
      return { ok: true, journal, file };
    }

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
    const ciFailedAfterDeploy = async (what: string): Promise<never> => {
      j.needsApproval = true; save();
      // Fail closed: the authority must have stopped; otherwise its approval could still carry the commit.
      if (rel !== undefined && j.authority && (epoch === null || !await rel.needsApproval(j.authority.id, "a pull request check failed after the deploy", epoch))) {
        throw new Stop("lease", `${what}. Nothing was merged, but this release's approval couldn't be stopped (another coordinator holds it, or a merge is reserved). Check it with \`toolroll release ${j.branch} --repo ${j.checkout}\` before going on.`);
      }
      throw new Stop("ci-failed", `${what}. Nothing was merged. The deploy had already started, so this commit needs a person's approval again: run \`toolroll release ${j.branch} --repo ${j.checkout} --new\`.`);
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
      j.approval = null; j.check = null; j.completion = null; j.authority = null; epoch = null;
      delete j.intents.gate; delete j.intents.check; delete j.intents.complete;
      j.step = "gate"; j.stopped = null; save();
    };

    /**
     * The task is approved for `action`: a release task (a carried commit, or any task once the release has an
     * authority) only when the live-release predicate applies to it AND accepts it — fail closed, whatever its own seal
     * says. Anything else needs the owner's own approval of these exact words (which a carried seal never is).
     */
    const approved = async (gate: GateState, action: ReleaseAction = "dispatch") => {
      if (gate.candidate !== j.candidate.sha || gate.scopeDigest !== j.task.scopeDigest) throw new Stop("scope-changed", `Task ${j.task.id}'s candidate or scope changed after approval.`);
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
      if (gate.result.check !== "passed") throw new Stop("check-failed", `The Full release check of ${j.candidate.sha.slice(0, 7)} did not pass (run ${gate.result.run}: ${gate.result.check}). It stays as it is: fix the branch and release the new commit with --new.`);
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
    while (j.step !== "done") {
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
          const existing = await adapters.toolroll.gate(j.task.id);
          // A fresh task this journal never filed has appeared under its id: it isn't ours, and isn't a fresh approval.
          if (existing.exists && j.freshTask === true && j.intents.gate === undefined) throw new Stop("approval", `Task ${j.task.id} appeared before this release filed it; rerun with --new.`);
          if (existing.exists) {
            // Filed already (a resume after a lost answer): the task stands, and the ci step judges its checks.
            if (existing.candidate !== j.candidate.sha) throw new Stop("conflict", `Task ${j.task.id} exists for a different commit (${existing.candidate?.slice(0, 7) ?? "none"}).`);
            j.task.scopeDigest = existing.scopeDigest;
          } else {
            await earlyChecks(adapters, j, (what, probe) => waitFor("gate", what, probe));
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
          say(`  The release scope needs your approval: \`toolroll task approve ${j.task.id} --digest ${j.task.scopeDigest}\`, or open the task in the console.`);
          const approved = await waitFor("approval", `a person to approve task ${j.task.id}`, async () => {
            await watch("dispatch");
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
          const result = await waitFor("check", `the release check of ${j.candidate.sha.slice(0, 7)}`, async () => {
            // Before acting on an old candidate's failure: a moved head restarts the release first.
            await watch("dispatch");
            const gate = await adapters.toolroll.gate(j.task.id);
            await approved(gate);
            if (gate.failed !== null) throw new Stop("check-failed", `The release build of ${j.task.id} failed: ${gate.failed}. Fix it and release the new commit with --new.`);
            if (gate.result === null || gate.result.check === "running" || gate.result.check === "pending") return null;
            // The build records a prepared candidate as a commit of its own (its message names the task): it must hold
            // exactly the candidate's tree, or it isn't the release.
            const head = gate.result.head;
            if (head === null || (head !== j.candidate.sha && await adapters.repo.tree(head) !== await adapters.repo.tree(j.candidate.sha))) {
              throw new Stop("drift", `The release result is for ${head?.slice(0, 7) ?? "no commit"}, which doesn't hold exactly ${j.candidate.sha.slice(0, 7)}'s files.`);
            }
            fullCheck(gate);
            if (gate.result.worktree === null) throw new Stop("worktree", `Run ${gate.result.run} names no checkout to deploy from.`);
            return { run: gate.result.run, receipt: gate.result.receipt, worktree: gate.result.worktree, head };
          });
          j.check = result;
          say(`  run ${result.run} passed on ${j.candidate.sha.slice(0, 7)}`);
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
              await watch("deploy");
              const reserved = await rel.reserve({ authority: j.authority.id, kind: "deploy", taskId: j.task.id, candidate: j.candidate.sha, epoch });
              if (!reserved.ok) throw new Stop("release", `The deploy couldn't be reserved: ${reserved.why}`);
              if (!await rel.start(reserved.operation, epoch)) throw new Stop("lease", "Another release coordinator took over this release.");
              await rel.finish(reserved.operation, "succeeded", { detail: "the services already run this candidate" }, epoch);
            }
          }
          if (runtime === null) {
            // The last moment a moved head restarts; then the deploy reservation freezes the candidate in the store.
            await watch("deploy");
            await pinned();
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
            const verdict = checksVerdict(await adapters.github.checks(j.github, j.candidate.sha), REQUIRED_PR_CHECKS);
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
            // A squash merge only reproduces the gated tree when main hasn't moved past the branch's base.
            await adapters.repo.sync(j.branch);
            const main = await adapters.repo.mainHead();
            if (!await adapters.repo.contains(j.candidate.sha, main)) throw new Stop("base-moved", `main moved to ${main.slice(0, 7)}, which ${j.branch} doesn't contain, so the merge wouldn't be the gated tree. Nothing was merged: update the branch and release the new commit with --new.`);
            // The checks again, at the moment of merging: a rerun that failed since must not merge.
            const verdict = checksVerdict(await adapters.github.checks(j.github, j.candidate.sha), REQUIRED_PR_CHECKS);
            if (verdict.state !== "passed") await ciFailedAfterDeploy(`Pull request checks are no longer all passing on ${j.candidate.sha.slice(0, 7)}`);
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
            // Whatever checks do register are always judged; an empty set passes only for a tap whose workflows never run
            // on a change, and only when it's still empty a poll later.
            const checked = await brew.checked(proposed.head);
            let emptyLooks = 0;
            await waitFor("homebrew", `the Homebrew change's checks (${brew.repo} #${proposed.pr})`, async () => {
              // Check runs and commit statuses are judged apart, so neither stands in for the other or hides its failure.
              // Two apps may name a check alike; each app's attempts stand for themselves.
              const runs = (await adapters.github.checks(brew.repo, proposed.head)).map(run => ({ ...run, name: `${run.app ?? "unknown app"}: ${run.name}` }));
              const statuses = await brew.statuses(proposed.head);
              const verdicts = [runs, statuses].filter(one => one.length > 0).map(one => checksVerdict(one, [...new Set(one.map(run => run.name))]));
              const failed = verdicts.flatMap(one => one.state === "failed" ? one.failed : []);
              if (failed.length > 0) throw new Stop("homebrew-failed", `The Homebrew change's checks failed: ${failed.join(", ")}.`);
              if (verdicts.some(one => one.state === "pending")) return null;
              // GitHub registers checks asynchronously; an empty set says nothing about success.
              // A workflow is owed: only its own run counts, not another app's green check.
              if (checked && !runs.some(run => run.app === "github-actions")) return null;
              if (runs.length === 0 && statuses.length === 0) return ++emptyLooks >= 2 ? true : null;
              return true;
            });
            await brew.merge(proposed.pr, proposed.head);
          }
          j.homebrew = { pr: j.homebrew?.pr ?? null, head: j.homebrew?.head ?? null, merged: true };
          advance("done");
          break;
        }
      }
      } catch (error) {
        if (!(error instanceof Restart)) throw error;
        await restart(error.head);
      }
    }
    say(`Released ${j.tag}: deployed, merged as ${j.merge!.sha.slice(0, 7)}, tagged, published and on Homebrew.`);
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
async function earlyChecks(adapters: ReleaseAdapters, j: ReleaseJournal, wait: <T>(what: string, probe: () => Promise<T | null>) => Promise<T>): Promise<void> {
  const sha = j.candidate.sha.slice(0, 7);
  const required: readonly string[] = REQUIRED_PR_CHECKS;
  let named = "", unread = false;
  try {
    await wait(`the pull request checks on ${sha}`, async () => {
      let runs: CheckRun[];
      try { runs = await adapters.github.checks(j.github, j.candidate.sha); }
      catch (error) {
        if (!unread) adapters.say(`  Couldn't read the pull request checks on ${sha} (${(error as Error)?.message ?? error}); trying again.`);
        unread = true;
        return null;
      }
      const verdict = checksVerdict(runs.filter(run => required.includes(run.name)), required);
      if (verdict.state === "failed") {
        throw new Stop("ci-failed", `Pull request checks already failed on ${sha}: ${verdict.failed.join(", ")}. Nothing was filed or sent for approval. Fix the branch, then release the new commit with \`toolroll release ${j.branch} --repo ${j.checkout} --new\` (or rerun the failed job on GitHub and run this command again).`);
      }
      if (verdict.state === "passed") return true;
      const now = verdict.waiting.join(", ");
      if (now !== named) { adapters.say(`  Pull request checks on ${sha} not finished yet: ${now}.`); named = now; }
      return null;
    });
  } catch (error) {
    if (!(error instanceof Stop) || error.reason !== "timeout") throw error;
    throw new Stop("ci-missing", `Pull request checks on ${sha} didn't all finish in time${named === "" ? (unread ? " (GitHub didn't answer)" : "") : `: ${named}`}. Nothing was filed or sent for approval. Start or rerun them on GitHub, then run this command again.`);
  }
}
