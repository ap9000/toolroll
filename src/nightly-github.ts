/**
 * GitHub's nightly as release debt (docs/plans/evals-nightly.md, part A). The plane reads every Nightly run and every
 * attempt on main itself, through its own gh, and a lane that failed its tests becomes debt.
 *
 * - Opting in (`toolroll release nightly --github`) is a person's step, proved now: it records the GitHub repository
 *   from the project's recorded remote and seeds one stable lane per required check (release.ts REQUIRED_PR_CHECKS).
 *   A rename needs a person's alias; a lane retires only when no required check names it, by a person.
 * - Reading keeps a paging cursor (at most NIGHTLY_PAGES_PER_READ pages a read, resumed on the next) and a watch list
 *   of every counted run created in the last 30 days (GitHub's re-run horizon), each re-read for new attempts; a run
 *   that hasn't finished stays watched whatever its age. A run counts only from `.github/workflows/nightly.yml`
 *   exactly, in the project's own repository, on main, by schedule or dispatch, at a commit on main's first-parent
 *   history as the plane read it (nightly-check.ts trustedMainOf). Every attempt's completed jobs are recorded once.
 * - A lane's failure is a test failure unless GitHub's own step records show the runner failed (github-jobs.ts):
 *   before the lane's own steps, or, for an aggregate lane failing only at "Every shard passed", a positively
 *   established chain of readable shard failures in the same attempt, each before its tests. The coverage verifier
 *   ("Every shard ran the whole suite") failing is always a test failure. A cause that can't be read is a failure.
 * - A failure clears only when a different counted nightly run, started after the failure completed, passes the same
 *   lane on a commit that contains the failed one. Nothing read later — a cancellation, a missing job, an unreadable
 *   page, a newer attempt — ever removes a recorded failure.
 *
 * Trust: a lane's conclusion is GitHub's record of the job, not independent evidence (the tests are the repository's
 * code). It only ever adds holds, and never trusts more than the required-checks gate already does.
 */
import { approverStanding, authenticateApprover, personProof } from "./scope.js";
import { verifiedFirstParentAncestry } from "./commit-extract.js";
import { projectGitDir } from "./check-report.js";
import { failedBeforeTests } from "./github-jobs.js";
import { GITHUB_NIGHTLY_ON, TRUSTED_MAIN_CLEAR_MS, failureSummary, trustedMainOf } from "./nightly-check.js";
import { REQUIRED_PR_CHECKS, REQUIRED_PR_CHECKS_WORKFLOW } from "./release.js";
import { releaseRemote } from "./release-git.js";
import { TRUSTED_MAIN_ACTION, releaseAuthorityOfTask, trustedRemoteIdentity, type Store } from "./store.js";

export { GITHUB_NIGHTLY_ON };

/** The one workflow file whose runs count: exactly this path, never one with an `@` suffix or another folder's. */
export const NIGHTLY_WORKFLOW_PATH = ".github/workflows/nightly.yml";
/** GitHub's re-run horizon: a counted run is read again for new attempts for this long. */
export const NIGHTLY_WATCH_MS = 30 * 24 * 60 * 60_000;
/** Listing never goes further back than this: no run older than it can still be unfinished. */
export const NIGHTLY_LIST_HORIZON_MS = 40 * 24 * 60 * 60_000;
/** Pages of runs one read lists at most; a longer backlog resumes on the next read. */
export const NIGHTLY_PAGES_PER_READ = 10;
const PAGE = 100;
/** GitHub answers at most this many runs to one filtered listing. */
const LISTING_CAP = 1000;
/** A boundary's one bounded read (deploy, merge, pre-tag), and the background read's overall deadline. */
export const NIGHTLY_BOUNDARY_READ_MS = 20_000;
export const NIGHTLY_BACKGROUND_READ_MS = 60_000;
/** How often the watch loop reads each opted-in project's nightly. */
export const NIGHTLY_BACKGROUND_EVERY_MS = 30 * 60_000;
/** One call never waits longer than this, inside the read's deadline. */
const CALL_MS = 15_000;
/** How far back main's first-parent history is walked. */
const MAIN_WALK = 20_000;
const SHA = /^[0-9a-f]{40}$/;

/** The job-name prefix GitHub gives a lane of each called workflow inside nightly.yml (its job names "nightly" and
 * "nightly floor"). */
const LANE_PREFIX: Readonly<Record<string, string>> = {
  ".github/workflows/ci.yml": "nightly / ",
  ".github/workflows/release-candidate.yml": "nightly floor / ",
};
/** An aggregate lane: the join of a sharded unit suite. */
const AGGREGATE = /^node (\d+) · (ubuntu|macos)-latest$/;
export const SHARDS_PASSED_STEP = "Every shard passed";
export const SHARDS_COVERED_STEP = "Every shard ran the whole suite";

/** One GitHub REST read through the plane's own gh (release-adapters.ts githubReads), bounded by `timeoutMs`. */
export type GhRead = (path: string, timeoutMs: number) => Promise<{ ok: true; body: unknown } | { ok: false; why: string }>;
/** Main as the plane read it from the recorded remote: whether a commit is on its first-parent history ("unknown" when
 * main hasn't been read lately, the commit isn't here yet, or the read of main is older than `since` — a run created
 * after main was read may be on a main that read hasn't seen), and whether one main commit contains another. */
export type MainHistory = {
  /** `deadline`: wall-clock milliseconds by which the local history work stops ("unknown" then). */
  onMain(sha: string, since: string, deadline: number): "yes" | "no" | "unknown";
  mainContains(sha: string, ancestor: string, deadline: number): boolean };
export type NightlyDeps = MainHistory & { gh: GhRead; now: () => Date };
/** One read inside a read's deadline. */
type Get = (path: string) => Promise<{ ok: true; body: unknown } | { ok: false; why: string }>;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const isoOf = (value: unknown): string | null => {
  if (typeof value !== "string" || value === "") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

// ---- opting in, lanes and aliases ----------------------------------------------------------------------------------

/** Whether a project opted in, as the plane recorded a person's step: the newest such ledger row, read strictly. */
export function githubNightlyOf(store: Store, repo: string): { slug: string; url: string; record: number; by: string; at: string } | null {
  const row = store.handle.prepare("SELECT detail FROM action_ledger WHERE repo = ? AND action = ? ORDER BY id DESC LIMIT 1").get(repo, GITHUB_NIGHTLY_ON);
  if (row === undefined) return null;
  try {
    const read = JSON.parse(String(row["detail"])) as Json;
    if (read["v"] !== 1 || typeof read["slug"] !== "string" || typeof read["url"] !== "string" || !Number.isSafeInteger(read["record"])
      || typeof read["by"] !== "string" || typeof read["at"] !== "string" || typeof read["proof"] !== "string" || !personProof(read["proof"])) return null;
    return { slug: read["slug"], url: read["url"], record: Number(read["record"]), by: read["by"], at: read["at"] };
  } catch { return null; }
}

/** Every project that ever opted in (a broken or superseded record still counts here: its debt still holds). */
export function githubNightlyRepos(store: Store): string[] {
  return store.handle.prepare("SELECT DISTINCT repo FROM action_ledger WHERE action = ? AND repo IS NOT NULL").all(GITHUB_NIGHTLY_ON).map(row => String(row["repo"]));
}

/** A lane's stable id: its workflow file and the required check's name when it was seeded. */
export const laneIdOf = (workflow: string, name: string): string => `${workflow.replace(/^\.github\/workflows\//, "")}:${name}`;

/** One lane per required check whose name no lane (by its name or an alias) answers to yet. A retired lane whose name
 * is required again opens again. */
export function seedLanes(store: Store, repo: string, now: Date): void {
  for (const name of REQUIRED_PR_CHECKS) {
    const workflow = REQUIRED_PR_CHECKS_WORKFLOW[name];
    if (resolveLane(store, repo, workflow, name) !== null) continue;
    store.handle.prepare(`INSERT INTO nightly_lane (repo, lane_id, workflow, display_name, seeded_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (repo, lane_id) DO UPDATE SET retired_at = NULL, retired_by = NULL, retired_proof = NULL WHERE display_name = excluded.display_name AND workflow = excluded.workflow`)
      .run(repo, laneIdOf(workflow, name), workflow, name, now.toISOString());
  }
}

/** The live lane a job of `workflow` named `name` belongs to: a person's alias first (the newest for that name), then
 * the lane seeded under it. Never a guess: anything else is no lane. */
export function resolveLane(store: Store, repo: string, workflow: string, name: string): string | null {
  const aliased = store.handle.prepare(`SELECT a.lane_id FROM nightly_lane_alias a JOIN nightly_lane l ON l.repo = a.repo AND l.lane_id = a.lane_id
      WHERE a.repo = ? AND a.name = ? AND l.workflow = ? AND l.retired_at IS NULL ORDER BY a.id DESC LIMIT 1`).get(repo, name, workflow);
  if (aliased !== undefined) return String(aliased["lane_id"]);
  const own = store.handle.prepare("SELECT lane_id FROM nightly_lane WHERE repo = ? AND workflow = ? AND display_name = ? AND retired_at IS NULL").get(repo, workflow, name);
  return own === undefined ? null : String(own["lane_id"]);
}

/** Every name a lane answers to: its seeded name and each alias. */
function laneNames(store: Store, repo: string, laneId: string): string[] {
  const lane = store.handle.prepare("SELECT display_name FROM nightly_lane WHERE repo = ? AND lane_id = ?").get(repo, laneId);
  const aliases = store.handle.prepare("SELECT name FROM nightly_lane_alias WHERE repo = ? AND lane_id = ? ORDER BY id").all(repo, laneId).map(row => String(row["name"]));
  return [...new Set([...(lane === undefined ? [] : [String(lane["display_name"])]), ...aliases])];
}

/** The name a lane is shown by: its newest alias, else the name it was seeded under. */
export function laneName(store: Store, repo: string, laneId: string): string {
  const alias = store.handle.prepare("SELECT name FROM nightly_lane_alias WHERE repo = ? AND lane_id = ? ORDER BY id DESC LIMIT 1").get(repo, laneId);
  if (alias !== undefined) return String(alias["name"]);
  const lane = store.handle.prepare("SELECT display_name FROM nightly_lane WHERE repo = ? AND lane_id = ?").get(repo, laneId);
  return lane === undefined ? laneId : String(lane["display_name"]);
}

type Proved = { ok: true; by: string; proof: string; generation: number } | { ok: false; message: string };
function provePerson(store: Store, repo: string, as: string, token: string, what: string): Proved {
  const proved = authenticateApprover(store, as, token, repo);
  const account = store.accountOf(as);
  if (!proved.ok || !personProof(proved.method) || account === null) return { ok: false, message: `Only an approver of this project, proved as a person, ${what}.` };
  return { ok: true, by: as, proof: proved.method, generation: account.generation };
}
/** Inside the mutation's own transaction: the person proved a moment ago is still an active approver of this project,
 * on the same account generation, which moves with every credential rotation, access change and revocation (Codex
 * round 1, finding 7: never a standing read before the lock). */
function stillProved(store: Store, repo: string, proved: Extract<Proved, { ok: true }>): boolean {
  const account = store.accountOf(proved.by);
  return approverStanding(store, proved.by, repo).ok && account !== null && account.generation === proved.generation;
}
const REVOKED = "Your approval of this project changed while this was being made; nothing was changed.";

/** `toolroll release nightly --github`: a person turns GitHub's nightly into release debt for this project. The
 * repository is the project's recorded remote's, never the checkout's. */
export function optInGithubNightly(store: Store, input: { repo: string; as: string; token: string }, now: Date): { ok: true; slug: string; lanes: number } | { ok: false; message: string } {
  const proved = provePerson(store, input.repo, input.as, input.token, "turns on GitHub's nightly");
  if (!proved.ok) return proved;
  return store.transact(() => {
    if (!stillProved(store, input.repo, proved)) return { ok: false as const, message: REVOKED };
    // The recorded remote as it stands inside this transaction.
    const identity = trustedRemoteIdentity(store, input.repo);
    const remote = identity === null ? null : releaseRemote(identity.url);
    if (identity === null || remote === null) return { ok: false as const, message: "The project's recorded remote isn't a GitHub repository, so its nightly can't be read." };
    store.recordAction({ at: now.toISOString(), actor: proved.by, repo: input.repo, taskId: null, runId: null, action: GITHUB_NIGHTLY_ON, outcome: "on", source: "request",
      detail: JSON.stringify({ v: 1, slug: remote.slug, url: identity.url, record: identity.record, workflow: NIGHTLY_WORKFLOW_PATH, by: proved.by, proof: proved.proof, at: now.toISOString() }) });
    seedLanes(store, input.repo, now);
    store.handle.prepare("INSERT OR IGNORE INTO github_nightly_cursor (repo, page_cursor) VALUES (?, ?)").run(input.repo, JSON.stringify(EMPTY_CURSOR));
    const lanes = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM nightly_lane WHERE repo = ? AND retired_at IS NULL").get(input.repo)?.["n"] ?? 0);
    return { ok: true as const, slug: remote.slug, lanes };
  });
}

/** `--lane-alias <old-id> <new name>`: a person says a renamed job is the same lane. Open debt goes with the lane. */
export function aliasNightlyLane(store: Store, input: { repo: string; laneId: string; name: string; as: string; token: string }, now: Date): { ok: true } | { ok: false; message: string } {
  const proved = provePerson(store, input.repo, input.as, input.token, "renames a nightly lane");
  if (!proved.ok) return proved;
  const name = input.name.trim();
  if (name === "" || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: "That isn't a job name." };
  return store.transact(() => {
    if (!stillProved(store, input.repo, proved)) return { ok: false as const, message: REVOKED };
    const lane = store.handle.prepare("SELECT workflow, retired_at FROM nightly_lane WHERE repo = ? AND lane_id = ?").get(input.repo, input.laneId);
    if (lane === undefined || lane["retired_at"] !== null) return { ok: false as const, message: `No live lane ${input.laneId} in this project.` };
    // Only a name no other lane answers to: never one another live lane resolves (whatever its debt), nor a required
    // check's name that another lane owns, so a rename can't re-route a live lane's results onto this one.
    const workflow = String(lane["workflow"]);
    const other = resolveLane(store, input.repo, workflow, name);
    if (other !== null && other !== input.laneId) return { ok: false as const, message: `"${name}" is already lane ${other}; it can't also be ${input.laneId}.` };
    const required = (REQUIRED_PR_CHECKS as readonly string[]).includes(name) ? laneIdOf(REQUIRED_PR_CHECKS_WORKFLOW[name as typeof REQUIRED_PR_CHECKS[number]], name) : null;
    if (required !== null && required !== input.laneId) return { ok: false as const, message: `"${name}" is a required check of its own lane (${required}); it can't be renamed onto ${input.laneId}.` };
    store.handle.prepare("INSERT INTO nightly_lane_alias (repo, lane_id, name, by, proof, at) VALUES (?, ?, ?, ?, ?, ?)").run(input.repo, input.laneId, name, proved.by, proved.proof, now.toISOString());
    store.recordAction({ at: now.toISOString(), actor: proved.by, repo: input.repo, taskId: null, runId: null, action: "nightly lane renamed", outcome: "aliased", source: "request", detail: `${input.laneId} → ${name}` });
    return { ok: true as const };
  });
}

/** `--lane-retire <lane-id>`: a person retires a lane no required check names any more; its open debt closes,
 * recorded as theirs. */
export function retireNightlyLane(store: Store, input: { repo: string; laneId: string; as: string; token: string }, now: Date): { ok: true; closed: number } | { ok: false; message: string } {
  const proved = provePerson(store, input.repo, input.as, input.token, "retires a nightly lane");
  if (!proved.ok) return proved;
  return store.transact(() => {
    if (!stillProved(store, input.repo, proved)) return { ok: false as const, message: REVOKED };
    const lane = store.handle.prepare("SELECT retired_at FROM nightly_lane WHERE repo = ? AND lane_id = ?").get(input.repo, input.laneId);
    if (lane === undefined || lane["retired_at"] !== null) return { ok: false as const, message: `No live lane ${input.laneId} in this project.` };
    const required = laneNames(store, input.repo, input.laneId).filter(name => (REQUIRED_PR_CHECKS as readonly string[]).includes(name));
    if (required.length > 0) return { ok: false as const, message: `"${required[0]}" is still a required check, so its lane can't be retired.` };
    const at = now.toISOString();
    store.handle.prepare("UPDATE nightly_lane SET retired_at = ?, retired_by = ?, retired_proof = ? WHERE repo = ? AND lane_id = ?").run(at, proved.by, proved.proof, input.repo, input.laneId);
    const closed = Number(store.handle.prepare("UPDATE nightly_lane_failure SET cleared_at = ?, closed_why = ? WHERE repo = ? AND lane_id = ? AND cleared_at IS NULL")
      .run(at, `retired by ${proved.by}`, input.repo, input.laneId).changes);
    store.recordAction({ at, actor: proved.by, repo: input.repo, taskId: null, runId: null, action: "nightly lane retired", outcome: "retired", source: "request", detail: `${input.laneId} · ${closed} open failure${closed === 1 ? "" : "s"} closed` });
    return { ok: true as const, closed };
  });
}

// ---- what GitHub answered, read strictly --------------------------------------------------------------------------

type GhRun = { id: number; path: string; repository: string | null; headRepository: string | null; headBranch: string | null; headSha: string; event: string;
  status: string; runAttempt: number; createdAt: string };
type GhStep = { number: number; name: string; status: string; conclusion: string | null };
export type GhJob = { id: number; name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; headSha: string;
  runId: number; runAttempt: number | null; steps: GhStep[] | null };

function runOf(value: unknown): GhRun | null {
  const one = object(value);
  if (one === null || !positive(one["id"]) || typeof one["path"] !== "string" || typeof one["head_sha"] !== "string" || typeof one["event"] !== "string"
    || typeof one["status"] !== "string" || !positive(one["run_attempt"])) return null;
  const createdAt = isoOf(one["created_at"]);
  if (createdAt === null) return null;
  const full = (value: unknown) => { const repo = object(value); return repo !== null && typeof repo["full_name"] === "string" ? repo["full_name"] : null; };
  return { id: Number(one["id"]), path: one["path"], repository: full(one["repository"]), headRepository: full(one["head_repository"]),
    headBranch: typeof one["head_branch"] === "string" ? one["head_branch"] : null, headSha: one["head_sha"], event: one["event"], status: one["status"],
    runAttempt: Number(one["run_attempt"]), createdAt };
}

function jobOf(value: unknown): GhJob | null {
  const one = object(value);
  if (one === null || !positive(one["id"]) || typeof one["name"] !== "string" || typeof one["status"] !== "string" || typeof one["head_sha"] !== "string" || !positive(one["run_id"])) return null;
  const rawSteps = one["steps"];
  let steps: GhStep[] | null = null;
  if (Array.isArray(rawSteps)) {
    const read = rawSteps.map(object);
    steps = read.every(step => step !== null && Number.isSafeInteger(step["number"]) && typeof step["name"] === "string" && typeof step["status"] === "string")
      ? read.map(step => ({ number: Number(step!["number"]), name: String(step!["name"]), status: String(step!["status"]), conclusion: typeof step!["conclusion"] === "string" ? step!["conclusion"] : null }))
      : null;
  }
  return { id: Number(one["id"]), name: one["name"], status: one["status"], conclusion: typeof one["conclusion"] === "string" && one["conclusion"] !== "" ? one["conclusion"] : null,
    startedAt: isoOf(one["started_at"]), completedAt: isoOf(one["completed_at"]), headSha: one["head_sha"], runId: Number(one["run_id"]),
    runAttempt: positive(one["run_attempt"]) ? Number(one["run_attempt"]) : null, steps };
}

/** Whether a run is one of the project's own nightly runs on main (everything but main's history, checked apart). */
export function nightlyRunBinds(run: Pick<GhRun, "path" | "repository" | "headRepository" | "headBranch" | "event" | "headSha">, slug: string): boolean {
  return run.path === NIGHTLY_WORKFLOW_PATH && run.repository === slug && run.headRepository === slug && run.headBranch === "main"
    && (run.event === "schedule" || run.event === "workflow_dispatch") && SHA.test(run.headSha);
}

/** A lane job's workflow and its name inside that workflow, from its name in the nightly ("nightly / node 24 · …"). */
function laneJobName(name: string): { workflow: string; name: string } | null {
  for (const [workflow, prefix] of Object.entries(LANE_PREFIX)) if (name.startsWith(prefix)) return { workflow, name: name.slice(prefix.length) };
  return null;
}

export type Cause = "passed" | "test-failure" | "runner-failure" | "not-run";

/**
 * Why a completed lane job ended as it did, from GitHub's own job and step records in the same attempt
 * (evals-nightly.md, "Cause of a failure"). Fails closed: anything not positively the runner's is a test failure.
 */
export function causeOf(job: GhJob, attempt: readonly GhJob[]): Cause {
  if (job.conclusion === "success") return "passed";
  if (job.conclusion === "cancelled" || job.conclusion === "skipped") return "not-run";
  if (job.steps === null) return "test-failure";
  const record = (one: GhJob) => ({ id: one.id, status: one.status, conclusion: one.conclusion, steps: one.steps ?? [] });
  if (failedBeforeTests(record(job))) return "runner-failure";
  const lane = laneJobName(job.name);
  const aggregate = lane === null ? null : AGGREGATE.exec(lane.name);
  if (lane === null || aggregate === null) return "test-failure";
  // The coverage verifier failing is always the tests' (it can fail with every shard green: a file that ran nowhere).
  const failedSteps = job.steps.filter(step => step.conclusion !== null && step.conclusion !== "success" && step.conclusion !== "skipped");
  if (failedSteps.length !== 1 || failedSteps[0]!.name !== SHARDS_PASSED_STEP || failedSteps[0]!.conclusion !== "failure") return "test-failure";
  // Only "Every shard passed" failed: the runner's only on a positively established, non-empty chain — every failed
  // shard of the same attempt readable and ended before its tests.
  const prefix = LANE_PREFIX[lane.workflow]!;
  const shard = new RegExp(`^node ${aggregate[1]} · ${aggregate[2] === "macos" ? "macos " : ""}shard \\d+/\\d+$`);
  const shards = attempt.filter(one => one.name.startsWith(prefix) && shard.test(one.name.slice(prefix.length)));
  const failed = shards.filter(one => one.conclusion !== "success");
  if (failed.length === 0) return "test-failure";
  const chain = failed.every(one => one.status === "completed" && one.steps !== null && (one.conclusion === "failure" || one.conclusion === "timed_out" || one.conclusion === "cancelled")
    && failedBeforeTests(record(one)));
  return chain ? "runner-failure" : "test-failure";
}

// ---- the cursor ----------------------------------------------------------------------------------------------------

type Cursor = { v: 1; done: number; scan: { top: number; below: string } | null };
const EMPTY_CURSOR: Cursor = { v: 1, done: 0, scan: null };
function cursorOf(store: Store, repo: string): Cursor {
  const row = store.handle.prepare("SELECT page_cursor FROM github_nightly_cursor WHERE repo = ?").get(repo);
  if (row === undefined) return EMPTY_CURSOR;
  try {
    const read = JSON.parse(String(row["page_cursor"])) as Json;
    const scan = object(read["scan"]);
    if (read["v"] !== 1 || !Number.isSafeInteger(read["done"]) || Number(read["done"]) < 0) return EMPTY_CURSOR;
    return { v: 1, done: Number(read["done"]), scan: scan !== null && positive(scan["top"]) && isoOf(scan["below"]) !== null ? { top: Number(scan["top"]), below: isoOf(scan["below"])! } : null };
  } catch { return EMPTY_CURSOR; }
}
function saveCursor(store: Store, repo: string, cursor: Cursor): void {
  store.handle.prepare("INSERT INTO github_nightly_cursor (repo, page_cursor) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET page_cursor = excluded.page_cursor").run(repo, JSON.stringify(cursor));
}

// ---- reading -------------------------------------------------------------------------------------------------------

export type NightlyRead = { ok: true; listed: number; checked: number; complete: boolean } | { ok: false; why: string };

/** Why the project's nightly can't be read now (not opted in, or its remote changed since), or its repository. */
function readableSlug(store: Store, repo: string): { ok: true; slug: string } | { ok: false; why: string } {
  const on = githubNightlyOf(store, repo);
  if (on === null) return { ok: false, why: "GitHub's nightly isn't turned on for this project" };
  const identity = trustedRemoteIdentity(store, repo);
  if (identity === null || identity.url !== on.url || releaseRemote(identity.url)?.slug !== on.slug) return { ok: false, why: "the project's recorded remote changed since GitHub's nightly was turned on; turn it on again" };
  return { ok: true, slug: on.slug };
}

/**
 * One read of the project's GitHub nightly within `budgetMs`: list runs from the cursor, re-read the watch list (new
 * and unfinished runs first, then the oldest-checked), record every completed lane job, open and clear failures. A
 * failed call stops where it is; what was recorded stays, and the cursor never moves past a page it couldn't read.
 */
export async function readGithubNightly(store: Store, repo: string, deps: NightlyDeps, budgetMs: number): Promise<NightlyRead> {
  const started = deps.now();
  const deadline = started.getTime() + budgetMs;
  const readable = readableSlug(store, repo);
  if (!readable.ok) { noteRead(store, repo, readable.why, started); return readable; }
  const slug = readable.slug;
  seedLanes(store, repo, started);
  const get: Get = async path => {
    const left = deadline - deps.now().getTime();
    if (left <= 0) return { ok: false, why: "the read ran out of time" };
    try { return await deps.gh(path, Math.min(left, CALL_MS)); } catch (error) { return { ok: false, why: String((error as Error)?.message ?? error).slice(0, 200) }; }
  };
  // Local history work (main's first-parent walks) is bounded by the same budget on the wall clock.
  const wall = Date.now() + budgetMs;
  let problem: string | null = null;
  const listing = await listRuns(store, repo, slug, get, deps.now);
  if (!listing.ok) problem = listing.why;
  const watched = await revisitWatchList(store, repo, slug, get, deps, () => deps.now().getTime() >= deadline || Date.now() >= wall, wall);
  if (problem === null && !watched.ok) problem = watched.why;
  const settled = settleGithubNightly(store, repo, deps, deps.now(), wall);
  const complete = listing.ok && listing.complete && watched.ok && watched.complete && settled.complete;
  // Partial progress is never a whole read (Codex round 1, finding 5): what is still unresolved is said, and the last
  // whole read's time stays as it was.
  const unresolved = problem ?? (complete ? null : watched.ok && watched.unresolved !== null ? watched.unresolved : "some runs are still to be read");
  noteRead(store, repo, unresolved, deps.now());
  return problem === null ? { ok: true, listed: listing.listed, checked: watched.checked, complete } : { ok: false, why: problem };
}

function noteRead(store: Store, repo: string, why: string | null, now: Date): void {
  store.handle.prepare(`INSERT INTO github_nightly_cursor (repo, page_cursor, last_ok_at, last_why) VALUES (?, ?, ?, ?)
    ON CONFLICT (repo) DO UPDATE SET last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at), last_why = excluded.last_why`)
    .run(repo, JSON.stringify(EMPTY_CURSOR), why === null ? now.toISOString() : null, why === null ? null : why.slice(0, 300));
}

/** List nightly.yml's runs on main from the cursor, at most NIGHTLY_PAGES_PER_READ pages, putting every run that binds
 * on the watch list page by page. A page that can't be read whole stops here, the cursor before it. */
async function listRuns(store: Store, repo: string, slug: string, get: Get, now: () => Date): Promise<{ ok: true; listed: number; complete: boolean } | { ok: false; why: string; listed: number }> {
  const cursor = cursorOf(store, repo);
  const filter = cursor.scan?.below ?? null;
  let top = cursor.scan?.top ?? cursor.done, below = filter, total: number | null = null, listed = 0;
  for (let page = 1; page <= NIGHTLY_PAGES_PER_READ; page++) {
    const query = `branch=main&per_page=${PAGE}&page=${page}${filter === null ? "" : `&created=${encodeURIComponent(`<=${filter}`)}`}`;
    const got = await get(`repos/${slug}/actions/workflows/nightly.yml/runs?${query}`);
    if (!got.ok) return { ok: false, why: `GitHub's nightly runs couldn't be listed: ${got.why}`, listed };
    const body = object(got.body);
    const rows = body === null ? null : body["workflow_runs"];
    const count = body === null ? null : body["total_count"];
    if (!Array.isArray(rows) || rows.length > PAGE || !Number.isSafeInteger(count) || Number(count) < 0) return { ok: false, why: "a page of GitHub's nightly runs couldn't be read", listed };
    if (total !== null && total !== count) return { ok: false, why: "GitHub's list of nightly runs changed while it was read", listed };
    total = Number(count);
    const expected = Math.max(0, Math.min(PAGE, Math.min(total, LISTING_CAP) - (page - 1) * PAGE));
    const runs = rows.map(runOf);
    if (rows.length !== expected || runs.some(one => one === null) || new Set(runs.map(one => one!.id)).size !== runs.length) {
      return { ok: false, why: "a page of GitHub's nightly runs came back cut short or unreadable", listed };
    }
    let end = rows.length < PAGE;
    const at = now();
    store.transact(() => {
      for (const run of runs as GhRun[]) {
        if (run.id <= cursor.done) { end = true; continue; }
        const age = at.getTime() - Date.parse(run.createdAt);
        if (age > NIGHTLY_LIST_HORIZON_MS && run.status === "completed") { end = true; continue; }
        if (!nightlyRunBinds(run, slug) || (age > NIGHTLY_WATCH_MS && run.status === "completed")) continue;
        listed += Number(store.handle.prepare("INSERT OR IGNORE INTO github_nightly_watch (repo, gh_run, created_at) VALUES (?, ?, ?)").run(repo, run.id, run.createdAt).changes);
      }
      for (const run of runs as GhRun[]) {
        top = Math.max(top, run.id);
        if (below === null || run.createdAt < below) below = run.createdAt;
      }
      saveCursor(store, repo, end || rows.length === 0 ? { v: 1, done: Math.max(cursor.done, top), scan: null } : { v: 1, done: cursor.done, scan: { top, below: below! } });
    });
    if (end || rows.length === 0) return { ok: true, listed, complete: true };
  }
  return { ok: true, listed, complete: false };
}

/** Read one run by id, strictly. */
async function readRun(get: Get, slug: string, id: number): Promise<GhRun | null> {
  const got = await get(`repos/${slug}/actions/runs/${id}`);
  if (!got.ok) return null;
  const run = runOf(got.body);
  return run !== null && run.id === id ? run : null;
}

/** Every job of one exact attempt of one run, every page, each GitHub's record of that run, attempt and commit. Null
 * when any page can't be read whole. */
export async function readAttemptJobs(get: Get, slug: string, run: number, attempt: number, sha: string): Promise<GhJob[] | null> {
  const all: GhJob[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 10; page++) {
    const got = await get(`repos/${slug}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=${PAGE}&page=${page}`);
    if (!got.ok) return null;
    const body = object(got.body);
    const rows = body === null ? null : body["jobs"];
    const count = body === null ? null : body["total_count"];
    if (!Array.isArray(rows) || rows.length > PAGE || !Number.isSafeInteger(count) || (total !== null && total !== count)) return null;
    total = Number(count);
    for (const row of rows) {
      const job = jobOf(row);
      if (job === null || job.runId !== run || job.headSha !== sha || (job.runAttempt !== null && job.runAttempt !== attempt)) return null;
      all.push(job);
    }
    if (rows.length < PAGE || all.length >= total) break;
  }
  if (total === null || all.length !== total || new Set(all.map(one => one.id)).size !== all.length) return null;
  return all;
}

/** Re-read every watched run within the budget (never-checked first, then unfinished, then the oldest-checked): new
 * attempts' jobs are recorded; a run leaves once it is 30 days old, finished and fully read. */
async function revisitWatchList(store: Store, repo: string, slug: string, get: Get, deps: NightlyDeps, outOfTime: () => boolean, wall: number): Promise<{ ok: true; checked: number; complete: boolean; unresolved: string | null } | { ok: false; why: string; checked: number }> {
  // Never-checked first, then strictly the oldest-checked (Codex round 1, finding 4: unfinished runs never starve a
  // finished one whose rerun is waiting to be seen).
  const rows = store.handle.prepare(`SELECT gh_run, created_at, attempts_read, finished FROM github_nightly_watch WHERE repo = ?
    ORDER BY last_checked_at IS NOT NULL, last_checked_at, gh_run`).all(repo);
  let problem: string | null = null, checked = 0, complete = true, unresolved: string | null = null;
  for (const row of rows) {
    if (outOfTime()) { complete = false; break; }
    const id = Number(row["gh_run"]), attemptsRead = Number(row["attempts_read"]);
    const mark = (fields: { attemptsRead?: number; finished?: boolean } = {}) => store.handle.prepare("UPDATE github_nightly_watch SET attempts_read = MAX(attempts_read, ?), finished = ?, last_checked_at = ? WHERE repo = ? AND gh_run = ?")
      .run(fields.attemptsRead ?? attemptsRead, (fields.finished ?? Number(row["finished"]) === 1) ? 1 : 0, deps.now().toISOString(), repo, id);
    const drop = () => store.handle.prepare("DELETE FROM github_nightly_watch WHERE repo = ? AND gh_run = ?").run(repo, id);
    const first = await readRun(get, slug, id);
    if (first === null) { problem ??= `nightly run ${id} couldn't be read`; complete = false; mark(); continue; }
    checked++;
    // A run that doesn't bind never counts; one not on main's history (as the plane read main) never counts either.
    if (!nightlyRunBinds(first, slug)) { drop(); continue; }
    const old = deps.now().getTime() - Date.parse(first.createdAt) > NIGHTLY_WATCH_MS;
    // "No" only from a read of main made after the run was created, and only for a finished run; anything less certain
    // keeps the run watched (never dropped on a stale read of main: its failure would never be recorded).
    const onMain = deps.onMain(first.headSha, first.createdAt, wall);
    if (onMain === "no" && first.status === "completed") { drop(); continue; }
    if (onMain !== "yes") { complete = false; unresolved ??= `nightly run ${id}'s commit ${first.headSha.slice(0, 7)} couldn't be placed on main's history yet`; mark(); continue; }
    if (first.runAttempt < attemptsRead) { problem ??= `nightly run ${id}'s attempts went backwards`; mark(); continue; }
    let read = attemptsRead, whole = true;
    for (let attempt = attemptsRead + 1; attempt <= first.runAttempt; attempt++) {
      const jobs = await readAttemptJobs(get, slug, id, attempt, first.headSha);
      if (jobs === null) { problem ??= `nightly run ${id} attempt ${attempt}'s jobs couldn't be read`; whole = false; complete = false; break; }
      recordAttempt(store, repo, { run: id, attempt, sha: first.headSha, createdAt: first.createdAt, jobs }, deps.now());
      // An earlier attempt than the newest is over: GitHub re-runs only a finished run.
      if (attempt < first.runAttempt) read = attempt;
    }
    let finished = false;
    if (whole) {
      // Read again: an attempt or status that changed mid-read is read whole next time; what was recorded stays.
      const again = await readRun(get, slug, id);
      if (again !== null && again.runAttempt === first.runAttempt && again.status === first.status && first.status === "completed") { read = first.runAttempt; finished = true; }
      else if (again === null) { problem ??= `nightly run ${id} couldn't be read again`; complete = false; }
      else complete = false;
    }
    if (finished && old && read === first.runAttempt) { drop(); continue; }
    mark({ attemptsRead: read, finished });
  }
  return problem === null ? { ok: true, checked, complete, unresolved } : { ok: false, why: problem, checked };
}

/** Record one attempt's completed lane jobs once each, and open a failure for each test failure. */
function recordAttempt(store: Store, repo: string, attempt: { run: number; attempt: number; sha: string; createdAt: string; jobs: readonly GhJob[] }, now: Date): void {
  const at = now.toISOString();
  store.transact(() => {
    for (const job of attempt.jobs) {
      if (job.status !== "completed") continue;
      const lane = laneJobName(job.name);
      const laneId = lane === null ? null : resolveLane(store, repo, lane.workflow, lane.name);
      if (laneId === null) continue;
      const cause = causeOf(job, attempt.jobs);
      store.handle.prepare(`INSERT OR IGNORE INTO nightly_lane_job (repo, lane_id, gh_run, run_created_at, attempt, job_id, sha, started_at, completed_at, conclusion, cause, read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(repo, laneId, attempt.run, attempt.createdAt, attempt.attempt, job.id, attempt.sha, job.startedAt, job.completedAt, job.conclusion, cause, at);
      if (cause !== "test-failure") continue;
      // No completion time on record: the failure counts as completed now, so only a pass started later clears it.
      const opened = store.handle.prepare(`INSERT OR IGNORE INTO nightly_lane_failure (repo, lane_id, gh_run, run_created_at, attempt, job_id, sha, completed_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(repo, laneId, attempt.run, attempt.createdAt, attempt.attempt, job.id, attempt.sha, job.completedAt ?? at, at);
      // One attention notice per failure, when it is first recorded.
      if (Number(opened.changes) === 1) {
        const lane = laneName(store, repo, laneId);
        store.enqueueNotification({ dedupeKey: `github-nightly-failed:${Number(opened.lastInsertRowid)}`, kind: "github-nightly-failed", subject: "GitHub's nightly failed on main",
          body: `Nightly checks failed: ${lane}, on main at ${attempt.sha.slice(0, 7)}. Releases wait until it passes again.`, pushClass: "attention",
          // The project it belongs to, so its people's chats may carry it (Codex round 1, finding 8).
          source: { project: repo }, link: "/board" }, now);
      }
    }
  });
}

/** A recorded open failure of a lane. */
export type LaneFailure = { id: number; repo: string; laneId: string; ghRun: number; attempt: number; jobId: number; sha: string; completedAt: string; openedAt: string };
export function openFailures(store: Store, repo: string): LaneFailure[] {
  return store.handle.prepare("SELECT * FROM nightly_lane_failure WHERE repo = ? AND cleared_at IS NULL ORDER BY id").all(repo).map(row => ({
    id: Number(row["id"]), repo: String(row["repo"]), laneId: String(row["lane_id"]), ghRun: Number(row["gh_run"]), attempt: Number(row["attempt"]), jobId: Number(row["job_id"]),
    sha: String(row["sha"]), completedAt: String(row["completed_at"]), openedAt: String(row["opened_at"]),
  }));
}

/**
 * Clear each open failure that a later counted nightly run passed: a run created after the failed run (a rerun of an
 * older run never clears newer debt; Codex round 1, finding 2), the same lane, a job started after the failed one
 * completed, on a commit that contains the failed one. A re-run inside the same run never clears. Local history work
 * stops at `wall` (wall-clock ms); what is left is settled on a later read.
 */
export function settleGithubNightly(store: Store, repo: string, history: Pick<MainHistory, "mainContains">, now: Date, wall = Date.now() + NIGHTLY_BACKGROUND_READ_MS): { cleared: number; complete: boolean } {
  let cleared = 0;
  for (const failure of openFailures(store, repo)) {
    if (Date.now() >= wall) return { cleared, complete: false };
    const passes = store.handle.prepare(`SELECT j.gh_run, j.attempt, j.job_id, j.sha FROM nightly_lane_job j JOIN nightly_lane_failure f ON f.id = ?
        WHERE j.repo = ? AND j.lane_id = ? AND j.cause = 'passed' AND j.gh_run <> f.gh_run AND j.run_created_at > f.run_created_at
          AND j.started_at IS NOT NULL AND j.started_at > f.completed_at ORDER BY j.started_at, j.id`).all(failure.id, repo, failure.laneId);
    const pass = passes.find(one => String(one["sha"]) === failure.sha || history.mainContains(String(one["sha"]), failure.sha, wall));
    if (pass === undefined) continue;
    const by = `${Number(pass["gh_run"])}/${Number(pass["attempt"])}/${Number(pass["job_id"])}`;
    store.transact(() => {
      if (Number(store.handle.prepare("UPDATE nightly_lane_failure SET cleared_at = ?, cleared_by_job = ?, closed_why = 'passed' WHERE id = ? AND cleared_at IS NULL").run(now.toISOString(), by, failure.id).changes) !== 1) return;
      store.recordAction({ at: now.toISOString(), actor: "toolroll", repo, taskId: null, runId: null, action: "nightly lane failure cleared", outcome: "cleared", source: "work",
        detail: `${laneName(store, repo, failure.laneId)} at ${failure.sha.slice(0, 7)} · by nightly run ${by}` });
      cleared++;
    });
  }
  return { cleared, complete: true };
}

/** Main's history as the plane read it from the project's recorded remote (nightly-check.ts trustedMainOf), from the
 * verified objects in the project's own Git store; never a ref a build could move. */
export function mainHistoryOf(store: Store, repo: string, now: Date): MainHistory {
  const main = trustedMainOf(store, repo, now, TRUSTED_MAIN_CLEAR_MS);
  // When that read of main was made: the same ledger row trustedMainOf stands on.
  const readAt = main === null ? null : String(store.handle.prepare("SELECT at FROM action_ledger WHERE repo = ? AND action = ? ORDER BY id DESC LIMIT 1").get(repo, TRUSTED_MAIN_ACTION)?.["at"] ?? "");
  const gitDir = projectGitDir(repo);
  return {
    onMain(sha, since, deadline) {
      if (main === null || gitDir === null || !SHA.test(sha)) return "unknown";
      if (sha === main) return "yes";
      // "No" only when proven: every commit back to the root read and verified without meeting it (Codex round 1,
      // finding 1) — and only by a read of main made after the run was created. A missing or unreadable object, the
      // walk's limit or the deadline is "unknown": the run stays watched.
      const walked = verifiedFirstParentAncestry(gitDir, main, sha, { deadline, max: MAIN_WALK });
      if (walked !== "no") return walked;
      return readAt !== null && Number.isFinite(Date.parse(readAt)) && Date.parse(readAt) > Date.parse(since) ? "no" : "unknown";
    },
    mainContains(sha, ancestor, deadline) {
      return gitDir !== null && SHA.test(sha) && SHA.test(ancestor) && verifiedFirstParentAncestry(gitDir, sha, ancestor, { deadline, max: MAIN_WALK }) === "yes";
    },
  };
}

/**
 * The watch loop's background read (operate.ts refreshGithubNightlies): each opted-in project at most every
 * NIGHTLY_BACKGROUND_EVERY_MS, claimed in the store so two processes don't both read, within one overall deadline.
 */
export async function readGithubNightlies(store: Store, deps: { gh: GhRead; now: () => Date; history?: (repo: string, now: Date) => MainHistory }, budgetMs = NIGHTLY_BACKGROUND_READ_MS): Promise<number> {
  const started = deps.now();
  const deadline = started.getTime() + budgetMs;
  let read = 0;
  for (const repo of githubNightlyRepos(store)) {
    const left = deadline - deps.now().getTime();
    if (left <= 0) break;
    if (githubNightlyOf(store, repo) === null) continue;
    const at = deps.now();
    store.handle.prepare("INSERT OR IGNORE INTO github_nightly_cursor (repo, page_cursor) VALUES (?, ?)").run(repo, JSON.stringify(EMPTY_CURSOR));
    const claimed = store.handle.prepare("UPDATE github_nightly_cursor SET last_tried_at = ? WHERE repo = ? AND (last_tried_at IS NULL OR last_tried_at <= ?)")
      .run(at.toISOString(), repo, new Date(at.getTime() - NIGHTLY_BACKGROUND_EVERY_MS).toISOString());
    if (Number(claimed.changes) !== 1) continue;
    const history = deps.history === undefined ? mainHistoryOf(store, repo, at) : deps.history(repo, at);
    await readGithubNightly(store, repo, { ...history, gh: deps.gh, now: deps.now }, left);
    read++;
  }
  return read;
}

// ---- holding every boundary (A2) -----------------------------------------------------------------------------------

/** What a hold stops: a deploy, the merge, the tag (pre-tag authorization), or an automatic approval (sealAutoGreen). */
export type NightlyPhase = "deploy" | "merge" | "tag" | "auto";
/** How long a boundary's re-read of a candidate's exemption stands for the stored checks inside the reservation, the
 * deployment gate and the installed runtime's deploy check after it. */
export const EXEMPTION_FRESH_MS = 10 * 60_000;

const STAMP = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
/** "Oct 30, 06:17 UTC". */
export const nightlyStamp = (iso: string): string => `${STAMP.format(new Date(iso))} UTC`;

/** The words of a nightly hold: the first open failure, how many more, and the way out at this point. */
export function nightlyDebtWords(store: Store, held: readonly LaneFailure[], phase: NightlyPhase, release: boolean): string {
  const first = held[0]!;
  const more = held.length - 1;
  const lanes = `GitHub's nightly failed "${laneName(store, first.repo, first.laneId)}" on main at ${first.sha.slice(0, 7)} (${nightlyStamp(first.completedAt)})${more > 0 ? `, and ${more} more lane${more === 1 ? "" : "s"}` : ""}.`;
  const who = release ? "This release" : "This candidate";
  const what = phase === "deploy" ? "can't deploy" : phase === "merge" ? "can't merge" : phase === "tag" ? "can't be tagged or published" : "can't be approved automatically";
  // After the merge the release's own CI can't help (the release proof refuses jobs finished after the merge).
  const way = release && phase !== "tag" ? "re-run this release's CI, or wait for tonight's nightly" : "wait for tonight's nightly, or dispatch Nightly on main";
  return `${lanes} ${who} ${what} until ${more > 0 ? "those lanes pass" : "that lane passes"} again: ${way}.`;
}

/** Whether this exact candidate of this task holds a fresh exemption for one failure. */
function exempted(store: Store, taskId: string, candidate: string, failure: number, now: Date): boolean {
  const row = store.handle.prepare("SELECT read_at FROM nightly_exemption WHERE task = ? AND candidate = ? AND failure_id = ?").get(taskId, candidate, failure);
  return row !== undefined && Date.parse(String(row["read_at"])) >= now.getTime() - EXEMPTION_FRESH_MS && Date.parse(String(row["read_at"])) <= now.getTime() + 60_000;
}

/**
 * The stored check every boundary makes, inside the caller's own transaction where it has one (the deployment gate, the
 * deploy and merge reservations, the pre-tag step, an automatic approval): the project's open lane failures, less those
 * this exact task and candidate hold a fresh exemption for. Null when nothing holds. A project that never opted in has
 * no lane failures.
 */
export function nightlyDebtHold(store: Store, input: { repo: string; taskId: string | null; candidate: string | null; phase: NightlyPhase; release: boolean; now: Date }): { why: string; failures: LaneFailure[] } | null {
  const held = openFailures(store, input.repo).filter(failure => input.taskId === null || input.candidate === null || !exempted(store, input.taskId, input.candidate, failure.id, input.now));
  return held.length === 0 ? null : { why: nightlyDebtWords(store, held, input.phase, input.release), failures: held };
}

/** How the project's GitHub nightly stands: whether it is on, when it was last read (and why not), when it last ran. */
export type NightlyStatus = { on: boolean; lastOkAt: string | null; lastWhy: string | null; lastRunAt: string | null; stale: boolean };
/** No nightly run seen for this long reads "hasn't run since". */
export const NIGHTLY_STALE_MS = 36 * 60 * 60_000;
export function githubNightlyStatus(store: Store, repo: string, now: Date): NightlyStatus {
  const on = githubNightlyOf(store, repo);
  const cursor = store.handle.prepare("SELECT last_ok_at, last_why FROM github_nightly_cursor WHERE repo = ?").get(repo);
  const ran = store.handle.prepare(`SELECT MAX(at) AS at FROM (SELECT MAX(created_at) AS at FROM github_nightly_watch WHERE repo = ?
    UNION ALL SELECT MAX(started_at) FROM nightly_lane_job WHERE repo = ?)`).get(repo, repo);
  const lastRunAt = ran?.["at"] == null ? null : String(ran["at"]);
  const since = lastRunAt ?? on?.at ?? null;
  return { on: on !== null, lastOkAt: cursor?.["last_ok_at"] == null ? null : String(cursor["last_ok_at"]), lastWhy: cursor?.["last_why"] == null ? null : String(cursor["last_why"]),
    lastRunAt, stale: on !== null && since !== null && now.getTime() - Date.parse(since) > NIGHTLY_STALE_MS };
}

const agoWords = (iso: string | null, now: Date): string => {
  if (iso === null) return "never read";
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `last read ${minutes} min ago` : minutes < 48 * 60 ? `last read ${Math.round(minutes / 60)} h ago` : `last read ${Math.round(minutes / 1440)} days ago`;
};

/** A warning that never holds anything (Decision 1): GitHub couldn't be read, or the nightly hasn't run lately. */
export function nightlyWarning(status: NightlyStatus, now: Date): string | null {
  if (!status.on) return null;
  if (status.lastWhy !== null) return `GitHub nightly: couldn't be read (${status.lastWhy}), ${agoWords(status.lastOkAt, now)}. Not holding the release.`;
  if (status.stale) return status.lastRunAt === null ? "GitHub nightly: hasn't run since it was turned on. Not holding the release." : `GitHub nightly: hasn't run since ${nightlyStamp(status.lastRunAt)}. Not holding the release.`;
  return null;
}

/** One workflow's newest pull-request run on a candidate head, as an exemption reads it. */
export type LaneJobs = { run: number; attempt: number; status: string; jobs: GhJob[] };

/**
 * A release candidate's own pull-request CI, as an exemption needs it (modelled on scripts/release-proof.mjs): for each
 * workflow, the newest run on `head` from that pull request's `pull_request` event, that run's latest attempt's jobs
 * with their times, then the run read again. The newest run is chosen first: one that doesn't bind to this pull
 * request never lets an older run stand. `null` for a workflow with no such run; "unreadable" when anything can't be
 * read whole or changed during the read.
 */
export async function readLaneJobs(get: Get, slug: string, pr: number, head: string, workflows: readonly string[]): Promise<Map<string, LaneJobs | null> | "unreadable"> {
  const listed: GhRun[] = [];
  const raw = new Map<number, Json>();
  let total: number | null = null;
  for (let page = 1; page <= 10; page++) {
    const got = await get(`repos/${slug}/actions/runs?head_sha=${head}&event=pull_request&per_page=${PAGE}&page=${page}`);
    if (!got.ok) return "unreadable";
    const body = object(got.body);
    const rows = body === null ? null : body["workflow_runs"];
    const count = body === null ? null : body["total_count"];
    if (!Array.isArray(rows) || rows.length > PAGE || !Number.isSafeInteger(count) || (total !== null && total !== count)) return "unreadable";
    total = Number(count);
    for (const row of rows) {
      const run = runOf(row);
      if (run === null || raw.has(run.id)) return "unreadable";
      listed.push(run);
      raw.set(run.id, object(row)!);
    }
    if (rows.length < PAGE || listed.length >= total) break;
  }
  if (total === null || listed.length !== total) return "unreadable";
  const found = new Map<string, LaneJobs | null>();
  for (const workflow of new Set(workflows)) {
    const newest = listed.filter(run => run.path === workflow && run.headSha === head && run.event === "pull_request").sort((a, b) => b.id - a.id)[0];
    if (newest === undefined) { found.set(workflow, null); continue; }
    const bound = raw.get(newest.id)!["pull_requests"];
    const binds = newest.repository === slug && newest.headRepository === slug && Array.isArray(bound) && bound.length === 1 && (() => {
      const one = object(bound[0]), base = object(one?.["base"]), baseRepo = object(base?.["repo"]), headRef = object(one?.["head"]);
      return one?.["number"] === pr && base?.["ref"] === "main" && baseRepo?.["url"] === `https://api.github.com/repos/${slug}` && headRef?.["sha"] === head;
    })();
    if (!binds) { found.set(workflow, null); continue; }
    if (newest.status !== "completed") { found.set(workflow, { run: newest.id, attempt: newest.runAttempt, status: newest.status, jobs: [] }); continue; }
    const jobs = await readAttemptJobs(get, slug, newest.id, newest.runAttempt, head);
    if (jobs === null) return "unreadable";
    const again = await readRun(get, slug, newest.id);
    if (again === null || again.runAttempt !== newest.runAttempt || again.status !== newest.status) return "unreadable";
    found.set(workflow, { run: newest.id, attempt: newest.runAttempt, status: newest.status, jobs });
  }
  // The runs again: a newer run or attempt that appeared mid-read voids the read.
  const relisted = await get(`repos/${slug}/actions/runs?head_sha=${head}&event=pull_request&per_page=${PAGE}&page=1`);
  const relistedBody = relisted.ok ? object(relisted.body) : null;
  const relistedRows = relistedBody === null ? null : relistedBody["workflow_runs"];
  if (!Array.isArray(relistedRows) || relistedBody!["total_count"] !== total) return "unreadable";
  if (total <= PAGE) {
    const newestOf = (runs: readonly (GhRun | null)[], workflow: string) => runs.filter((run): run is GhRun => run !== null && run.path === workflow && run.headSha === head && run.event === "pull_request").sort((a, b) => b.id - a.id)[0];
    for (const workflow of found.keys()) {
      const before = newestOf(listed, workflow), after = newestOf(relistedRows.map(runOf), workflow);
      if (before?.id !== after?.id || before?.runAttempt !== after?.runAttempt || before?.status !== after?.status) return "unreadable";
    }
  }
  return found;
}

/** The files a lane's job runs that the candidate could otherwise rewrite to make a job of that name pass: its workflow
 * file and the CI scripts the workflows call. An exemption stands only when each is byte-identical (the same Git
 * blob) on the candidate and at the failed commit. The tests themselves are the candidate's, as for every required
 * check (the trust the required-checks gate already places in them). */
export const LANE_PINNED_FILES = ["scripts/ci-shards.mjs", "scripts/ci-scope.mjs", "scripts/ci-git.sh", "scripts/ci-no-skips.mjs"] as const;

/** Whether every pinned file of a lane's workflow is the same blob on `candidate` as at `failed`, by GitHub's own
 * contents API; null when any can't be read. */
async function lanePinned(get: Get, slug: string, workflow: string, candidate: string, failed: string): Promise<{ same: true } | { same: false; path: string } | null> {
  for (const path of [workflow, ...LANE_PINNED_FILES]) {
    const blobs: string[] = [];
    for (const ref of [candidate, failed]) {
      const got = await get(`repos/${slug}/contents/${path}?ref=${ref}`);
      const body = got.ok ? object(got.body) : null;
      if (body === null || body["type"] !== "file" || typeof body["sha"] !== "string" || !/^[0-9a-f]{40,64}$/.test(body["sha"])) return null;
      blobs.push(body["sha"]);
    }
    if (blobs[0] !== blobs[1]) return { same: false, path };
  }
  return { same: true };
}

/** Whether `candidate` contains `ancestor`, by GitHub's own comparison; null when it can't be read. */
async function candidateContains(get: Get, slug: string, candidate: string, ancestor: string): Promise<boolean | null> {
  if (candidate === ancestor) return true;
  const got = await get(`repos/${slug}/compare/${ancestor}...${candidate}`);
  if (!got.ok) return null;
  const body = object(got.body);
  if (body === null || typeof body["status"] !== "string" || !Number.isSafeInteger(body["behind_by"])) return null;
  return body["behind_by"] === 0 && (body["status"] === "ahead" || body["status"] === "identical");
}

/** A read time no stored check accepts: an exemption whose last re-read failed. */
const STALE_READ = "1970-01-01T00:00:00.000Z";

export type NightlyBoundary = { ok: true; warning: string | null } | { ok: false; why: string; warning: string | null };

/**
 * A boundary (the coordinator's deploy, merge and pre-tag steps): one bounded read of GitHub's nightly, then this
 * candidate's exemptions read again from its own pull-request CI — minted only before the merge (`deploy`, `merge`);
 * at the tag an exemption obtained before the merge is re-read, never made — then the stored debt. A read that fails is
 * a warning and the stored debt still holds; an exemption that can't be re-read is no exemption here.
 */
export async function nightlyBoundary(store: Store, input: { repo: string; taskId: string; candidate: string; pr: number; phase: Exclude<NightlyPhase, "auto"> },
  deps: NightlyDeps, budgetMs = NIGHTLY_BOUNDARY_READ_MS): Promise<NightlyBoundary> {
  const started = deps.now().getTime();
  const deadline = started + budgetMs;
  if (githubNightlyOf(store, input.repo) === null && openFailures(store, input.repo).length === 0) return { ok: true, warning: null };
  const get: Get = async path => {
    const left = deadline - deps.now().getTime();
    if (left <= 0) return { ok: false, why: "the read ran out of time" };
    try { return await deps.gh(path, Math.min(left, CALL_MS)); } catch (error) { return { ok: false, why: String((error as Error)?.message ?? error).slice(0, 200) }; }
  };
  // The nightly itself, within about two thirds of the budget; the rest is the candidate's own CI.
  if (githubNightlyOf(store, input.repo) !== null) await readGithubNightly(store, input.repo, deps, Math.max(0, Math.floor(budgetMs * 2 / 3) - (deps.now().getTime() - started)));
  const warning = nightlyWarning(githubNightlyStatus(store, input.repo, deps.now()), deps.now());
  const open = openFailures(store, input.repo);
  const unverified = new Set<number>();
  // A re-read that fails takes the stored permission away too (Codex round 1, finding 3): the row stays, so a later
  // boundary that reads it whole again (the tag included) can restore it, but no stored check accepts it meanwhile.
  const invalidate = (failure: number) => store.handle.prepare("UPDATE nightly_exemption SET read_at = ? WHERE task = ? AND candidate = ? AND failure_id = ?")
    .run(STALE_READ, input.taskId, input.candidate, failure);
  /** Failures this candidate can't be exempted from: it changes how the lane runs (the path that differs). */
  const changed = new Map<number, string>();
  const slug = githubNightlyOf(store, input.repo)?.slug ?? null;
  if (open.length > 0 && slug !== null && SHA.test(input.candidate) && positive(input.pr)) {
    const lanes = new Map(open.map(failure => [failure.id, store.handle.prepare("SELECT workflow FROM nightly_lane WHERE repo = ? AND lane_id = ?").get(input.repo, failure.laneId)?.["workflow"]]));
    const read = await readLaneJobs(get, slug, input.pr, input.candidate, [...new Set([...lanes.values()].filter((one): one is string => typeof one === "string"))]);
    for (const failure of open) {
      const workflow = lanes.get(failure.id);
      const row = store.handle.prepare("SELECT gh_run, attempt, job_id FROM nightly_exemption WHERE task = ? AND candidate = ? AND failure_id = ?").get(input.taskId, input.candidate, failure.id);
      if (read === "unreadable" || typeof workflow !== "string") { unverified.add(failure.id); invalidate(failure.id); continue; }
      const found = read.get(workflow) ?? null;
      const names = laneNames(store, input.repo, failure.laneId);
      const named = found === null ? [] : found.jobs.filter(job => names.includes(job.name));
      const job = named.length === 1 ? named[0]! : null;
      const valid = found !== null && found.status === "completed" && job !== null && job.status === "completed" && job.conclusion === "success" && job.headSha === input.candidate
        && job.startedAt !== null && job.completedAt !== null && job.startedAt > failure.completedAt;
      const same = row !== undefined && found !== null && job !== null && Number(row["gh_run"]) === found.run && Number(row["attempt"]) === found.attempt && Number(row["job_id"]) === job.id;
      const at = deps.now().toISOString();
      // The newest run or attempt differs, is pending, or holds a failure for that lane: the exemption is void.
      if (row !== undefined && !(same && valid)) store.handle.prepare("DELETE FROM nightly_exemption WHERE task = ? AND candidate = ? AND failure_id = ?").run(input.taskId, input.candidate, failure.id);
      if (!valid) continue;
      if (same) { store.handle.prepare("UPDATE nightly_exemption SET read_at = ? WHERE task = ? AND candidate = ? AND failure_id = ?").run(at, input.taskId, input.candidate, failure.id); continue; }
      if (input.phase === "tag") continue;
      const contains = await candidateContains(get, slug, input.candidate, failure.sha);
      if (contains !== true) { if (contains === null) { unverified.add(failure.id); invalidate(failure.id); } continue; }
      // A job named like the lane proves nothing if the candidate rewrote what that job runs.
      const pinned = await lanePinned(get, slug, workflow, input.candidate, failure.sha);
      if (pinned === null) { unverified.add(failure.id); invalidate(failure.id); continue; }
      if (!pinned.same) { changed.set(failure.id, pinned.path); continue; }
      store.handle.prepare(`INSERT INTO nightly_exemption (task, candidate, failure_id, pr, gh_run, attempt, job_id, started_at, completed_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (task, candidate, failure_id) DO UPDATE SET pr = excluded.pr, gh_run = excluded.gh_run, attempt = excluded.attempt, job_id = excluded.job_id,
          started_at = excluded.started_at, completed_at = excluded.completed_at, read_at = excluded.read_at`)
        .run(input.taskId, input.candidate, failure.id, input.pr, found!.run, found!.attempt, job!.id, job!.startedAt, job!.completedAt, at);
    }
  }
  const now = deps.now();
  const hold = store.transact(() => {
    const stored = nightlyDebtHold(store, { repo: input.repo, taskId: input.taskId, candidate: input.candidate, phase: input.phase, release: true, now });
    // An exemption that couldn't be re-read now never counts at this boundary, whatever is stored.
    const held = openFailures(store, input.repo).filter(failure => unverified.has(failure.id) || stored?.failures.some(one => one.id === failure.id) === true);
    if (held.length === 0) return null;
    const rewrote = held.map(failure => changed.get(failure.id)).find((path): path is string => path !== undefined);
    return rewrote === undefined ? nightlyDebtWords(store, held, input.phase, true)
      : `${nightlyDebtWords(store, held, input.phase, true)} This release changes ${rewrote}, which that lane runs, so its own CI can't stand in for the nightly: wait for tonight's nightly, or dispatch Nightly on main.`;
  });
  return hold === null ? { ok: true, warning } : { ok: false, why: hold, warning };
}

// ---- words (A3) ----------------------------------------------------------------------------------------------------

/** One project-level Needs-you item: an open GitHub nightly lane failure, or a nightly check of main that failed. */
export type NightlyNeed = { key: string; repo: string; title: string; reason: string; href: string; since: string };

/**
 * Needs you, for the projects `shown` admits: one item per open GitHub nightly lane failure (linking to its job on
 * GitHub, under the opted-in repository the plane recorded), and one per nightly check of main with open failures
 * (linking to its task). Oldest first.
 */
export function nightlyNeedsYou(store: Store, shown: (repo: string) => boolean): NightlyNeed[] {
  const needs: NightlyNeed[] = [];
  const failed = store.handle.prepare("SELECT DISTINCT repo FROM nightly_lane_failure WHERE cleared_at IS NULL").all().map(row => String(row["repo"])).filter(shown);
  for (const repo of failed) {
    const slug = githubNightlyOf(store, repo)?.slug ?? null;
    for (const failure of openFailures(store, repo)) {
      needs.push({ key: `github-nightly-${failure.id}`, repo, title: `Nightly checks failed: ${laneName(store, repo, failure.laneId)}`,
        reason: `On main at ${failure.sha.slice(0, 7)}. Releases wait until it passes again.`,
        href: slug === null ? "/board" : `https://github.com/${slug}/actions/runs/${failure.ghRun}/job/${failure.jobId}`, since: failure.openedAt });
    }
  }
  // The plane's own nightly check of main (nightly-check.ts): one item per failed check, its items summed up.
  const rows = store.handle.prepare("SELECT repo, run, sha, MIN(opened_at) AS since, COUNT(*) AS n FROM main_check_failure WHERE cleared_at IS NULL GROUP BY repo, run, sha ORDER BY since").all();
  for (const row of rows) {
    const repo = String(row["repo"]);
    if (!shown(repo)) continue;
    const run = store.getRun(Number(row["run"]));
    const task = run === null ? null : store.refById(run.taskRef)?.externalId ?? null;
    const items = store.handle.prepare("SELECT item FROM main_check_failure WHERE repo = ? AND run = ? AND cleared_at IS NULL ORDER BY item").all(repo, Number(row["run"])).map(one => String(one["item"]));
    needs.push({ key: `main-check-${Number(row["run"])}`, repo, title: `Nightly check of main failed: ${failureSummary(items)}`,
      reason: `On main at ${String(row["sha"]).slice(0, 7)}. Composed releases wait until a full check passes.`,
      href: task === null ? "/board" : `/t/${encodeURIComponent(task)}`, since: String(row["since"]) });
  }
  return needs.sort((a, b) => a.since.localeCompare(b.since));
}

/** The release card's GitHub nightly lines: each open lane failure (held, or exempted for this candidate), then a
 * warning when GitHub couldn't be read or the nightly hasn't run lately. Empty when there is nothing to say. */
export function nightlyReleaseLines(store: Store, input: { repo: string; taskId: string; candidate: string | null; now: Date }): string[] {
  const lines = openFailures(store, input.repo).map(failure => {
    const lane = `GitHub nightly: failed ${laneName(store, input.repo, failure.laneId)} (${nightlyStamp(failure.completedAt)}).`;
    return input.candidate !== null && exempted(store, input.taskId, input.candidate, failure.id, input.now)
      ? `${lane} This release re-ran it after the failure and passed.` : `${lane} This release waits until it passes again.`;
  });
  const warning = nightlyWarning(githubNightlyStatus(store, input.repo, input.now), input.now);
  return warning === null ? lines : [...lines, warning];
}

/**
 * A deploy run's own boundary (scripts/deploy-browser.mjs, through the installed runtime; Codex round 1, finding 3):
 * the same bounded read as the coordinator's — GitHub's nightly, then this candidate's exemptions re-read — before the
 * stored check, so a deploy started by hand neither misses a new failure nor rides an exemption its CI no longer
 * supports. A task no release covers has no exemption to re-read; its nightly is still read. Anything that fails here
 * takes away the candidate's stored exemptions; the stored check that follows decides.
 */
export async function refreshNightlyForDeploy(store: Store, input: { runId: number; now: () => Date; gh?: GhRead; budgetMs?: number }): Promise<NightlyBoundary | null> {
  const run = store.getRun(input.runId);
  const ref = run === null ? null : store.refById(run.taskRef);
  if (run === null || ref === null || ref.repo === null) return null;
  const repo = ref.repo;
  if (githubNightlyOf(store, repo) === null && openFailures(store, repo).length === 0) return null;
  const candidate = store.getScope(ref.externalId)?.candidate ?? run.headRevision;
  const at = input.now();
  try {
    const gh = input.gh ?? await (async () => {
      const [{ exec, githubReads }, { releaseTools }] = await Promise.all([import("./release-adapters.js"), import("./release-git.js")]);
      return githubReads(exec, releaseTools().gh);
    })();
    const deps = { ...mainHistoryOf(store, repo, at), gh, now: input.now };
    const pr = releaseAuthorityOfTask(store, ref.externalId)?.authority.pr ?? null;
    if (candidate === null || pr === null) {
      if (githubNightlyOf(store, repo) !== null) await readGithubNightly(store, repo, deps, input.budgetMs ?? NIGHTLY_BOUNDARY_READ_MS);
      return null;
    }
    return await nightlyBoundary(store, { repo, taskId: ref.externalId, candidate, pr, phase: "deploy" }, deps, input.budgetMs ?? NIGHTLY_BOUNDARY_READ_MS);
  } catch {
    if (candidate !== null) store.handle.prepare("UPDATE nightly_exemption SET read_at = ? WHERE task = ? AND candidate = ?").run(STALE_READ, ref.externalId, candidate);
    return null;
  }
}
