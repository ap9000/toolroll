/** Follow-ups on any result: "Run checks" and "Add tests".
 *
 * Run checks runs the project's quick or full check on the result's exact
 * commit, in a fresh checkout, after the build has finished. A person (or a
 * pull request opening) asks; the ask is a ledger entry; a worker runs it
 * once and seals its log and a receipt beside the result. A pass upgrades
 * what the result's Checks row says; a failure stays visible. Nothing here
 * rewrites the build's own check or reruns crew work.
 *
 * Add tests files a small task, unapproved like any other filing, to write
 * tests for that change. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./backend.js";
import type { Store, VerifyCommand } from "./store.js";
import type { ExecResult } from "./exec.js";
import { run as execRun } from "./exec.js";
import { approvedCommandShell, SETUP_ENV_ALLOWLIST, SETUP_ENV_DENYLIST } from "./builder.js";
import { runWithIsolatedDatabase } from "./child-database.js";
import { boundStreamHeadTail, readVerifiedArtifact, redactSecretLines, scanForSecrets, storeEvidence } from "./evidence.js";
import { CHECK_LEVEL_WORDS, checkCommandFor, quickVerifyKey, repoClause, repoOfRun, runCheckLevel, type CheckLevel } from "./check-levels.js";
import { fileTaskProposal } from "./proposal.js";

export const CHECKS_REQUESTED = "checks requested";
export const CHECKS_STARTED = "checks started";
export const CHECKS_FINISHED = "checks finished";
export const FOLLOW_UP_LOG = "follow-up check log v1";
export const FOLLOW_UP_RECEIPT = "follow-up check receipt v1";
export const ADD_TESTS_ACTION = "tests task filed";
/** A started check with no result after its time limit and this grace didn't finish. */
const ABANDONED_GRACE_MS = 10 * 60_000;

export type RunLevel = Exclude<CheckLevel, "off">;
/** How a batch check (batch-checks.ts) reached this result's outcome. `together`: one check on a temporary
 * merge of `members`; `split`: its batch failed, so it was checked on its own; `conflict`: it couldn't be merged
 * with the others, so it was checked on its own; `alone`: nothing joined it within the window. */
export type BatchFacts = { mode: "together" | "split" | "conflict" | "alone"; tested: string; base: string | null; members: { task: string; run: number; head: string }[] };
export type FollowUpCheck = {
  request: number; runId: number; level: RunLevel; head: string; actor: string; at: string; why: "person" | "pull-request" | "batch";
  /** The approved command's digest when checks were asked for: only that exact command runs. */
  digest: string;
  state: "waiting" | "running" | "passed" | "failed" | "not-run"; exitCode: number | null; logArtifactId: number | null; note: string | null;
  /** A batch request: the project base it is merged onto. */
  base?: string | null;
  /** The commit the check actually ran on: the result's own, or a temporary batch commit. Null until it ran. */
  tested?: string | null;
  /** From the sealed receipt of a batch check. */
  batch?: BatchFacts | null;
};
type Refusal = { ok: false; reason: string; message: string };
const refuse = (reason: string, message: string): Refusal => ({ ok: false, reason, message });

type LedgerRow = { id: number; actor: string; at: string; outcome: string; detail: string | null; action: string };
function ledgerFor(store: Store, runId: number): LedgerRow[] {
  const [where, params] = repoClause(repoOfRun(store, runId));
  return store.handle.prepare(`SELECT id, actor, at, outcome, detail, action FROM action_ledger WHERE ${where} AND run_id = ? AND action IN (?, ?, ?) ORDER BY id`)
    .all(...params, runId, CHECKS_REQUESTED, CHECKS_STARTED, CHECKS_FINISHED)
    .map(row => ({ id: Number(row["id"]), actor: String(row["actor"]), at: String(row["at"]), outcome: String(row["outcome"]),
      detail: row["detail"] === null ? null : String(row["detail"]), action: String(row["action"]) }));
}

/** Every follow-up check a result has had, oldest first, as the ledger and its sealed receipts say. */
export function followUpChecksOf(store: Store, runId: number, now: Date = new Date(), root?: string): FollowUpCheck[] {
  const rows = ledgerFor(store, runId);
  const receipts = new Map<number, { exitCode: number | null; ran: boolean; log: number | null; head: string | null; tested: string | null; batch: BatchFacts | null }>();
  if (root !== undefined) {
    for (const artifact of store.artifactsFor(runId).filter(one => one.kind === "structured-output" && one.capture === FOLLOW_UP_RECEIPT)) {
      const read = readVerifiedArtifact(root, artifact);
      if (!read.ok) continue;
      try {
        const body = JSON.parse(read.content.toString("utf8")) as { request?: unknown; head?: unknown; tested?: unknown; result?: { ran?: unknown; exitCode?: unknown }; log?: { artifactId?: unknown }; batch?: unknown };
        if (typeof body.request !== "number") continue;
        const head = typeof body.head === "string" ? body.head : null;
        receipts.set(body.request, { ran: body.result?.ran === true, exitCode: typeof body.result?.exitCode === "number" ? body.result.exitCode : null,
          log: typeof body.log?.artifactId === "number" ? body.log.artifactId : null, head,
          tested: typeof body.tested === "string" ? body.tested : head, batch: batchFactsOf(body.batch, runId, head) });
      } catch { /* an unreadable receipt upgrades nothing */ }
    }
  }
  return rows.filter(row => row.action === CHECKS_REQUESTED && (row.outcome === "quick" || row.outcome === "full")).map(request => {
    const [head = "", why = "person", digest = "", recordedBase = ""] = (request.detail ?? "").split(" · ");
    const started = rows.find(row => row.action === CHECKS_STARTED && row.outcome === String(request.id)) ?? null;
    const finished = rows.find(row => row.action === CHECKS_FINISHED && row.outcome.startsWith(`${request.id}:`)) ?? null;
    const base = { request: request.id, runId, level: request.outcome as RunLevel, head, digest, actor: request.actor, at: request.at,
      why: why === "pull-request" ? "pull-request" as const : why === "batch" ? "batch" as const : "person" as const, exitCode: null, logArtifactId: null, note: null,
      ...(why === "batch" ? { base: /^[a-f0-9]{40}$/.test(recordedBase) ? recordedBase : null } : {}) };
    if (finished !== null) {
      const status = finished.outcome.slice(String(request.id).length + 1);
      const sealed = receipts.get(request.id) ?? null;
      // With the evidence at hand, only a sealed receipt can say passed: for this result's own commit, and,
      // for a batch, a batch that names this result.
      if (status === "passed" && root !== undefined && (sealed === null || !sealed.ran || sealed.exitCode !== 0 || (sealed.head !== null && sealed.head !== head)
        || (base.why === "batch" && sealed.batch === null))) {
        return { ...base, state: "not-run" as const, note: "The saved check result could not be verified." };
      }
      const exit = /exit (\d+)/.exec(finished.detail ?? "");
      return { ...base, state: status === "passed" ? "passed" as const : status === "failed" ? "failed" as const : "not-run" as const,
        exitCode: exit === null ? sealed?.exitCode ?? null : Number(exit[1]), logArtifactId: sealed?.log ?? null, note: status === "not-run" ? finished.detail : null,
        ...(sealed === null ? {} : { tested: sealed.ran ? sealed.tested : null, batch: sealed.batch }) };
    }
    if (started !== null) {
      const limit = Number(/limit (\d+)/.exec(started.detail ?? "")?.[1] ?? 3_600_000);
      if (now.getTime() - Date.parse(started.at) > limit + ABANDONED_GRACE_MS) return { ...base, state: "not-run" as const, note: "The check didn't finish." };
      return { ...base, state: "running" as const };
    }
    return { ...base, state: "waiting" as const };
  });
}

/** A receipt's batch facts, only when they are whole and name this result at its own commit. */
function batchFactsOf(value: unknown, runId: number, head: string | null): BatchFacts | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { mode?: unknown; tested?: unknown; base?: unknown; members?: unknown };
  const modes = ["together", "split", "conflict", "alone"] as const;
  const mode = modes.find(one => one === raw.mode);
  if (mode === undefined || typeof raw.tested !== "string" || !/^[a-f0-9]{40}$/.test(raw.tested) || !Array.isArray(raw.members)) return null;
  const members = raw.members.flatMap(one => {
    const m = one as { task?: unknown; run?: unknown; head?: unknown };
    return typeof m?.task === "string" && typeof m.run === "number" && typeof m.head === "string" ? [{ task: m.task, run: m.run, head: m.head }] : [];
  });
  if (members.length !== raw.members.length || !members.some(one => one.run === runId && one.head === head)) return null;
  // Checked on its own: the commit tested is the result's own.
  if (mode !== "together" && (members.length !== 1 || raw.tested !== head)) return null;
  return { mode, tested: raw.tested, base: typeof raw.base === "string" ? raw.base : null, members };
}

/** Whether a result can have checks run on it, and with which command. */
function checkTarget(store: Store, runId: number, level: RunLevel): { ok: true; repo: string; taskId: string; head: string; level: RunLevel; command: VerifyCommand } | Refusal {
  const run = store.getRun(runId);
  const ref = run === null ? null : store.refById(run.taskRef);
  if (run === null || ref === null) return refuse("unknown", "No such result.");
  if (run.finishedAt === null || run.headRevision === null || !/^[a-f0-9]{40}$/.test(run.headRevision)) return refuse("no-commit", "This result has no finished commit to check.");
  if (ref.repo === null) return refuse("unplaced", "This result isn't in a project, so there is no check to run.");
  const chosen = checkCommandFor(store, ref.repo, level);
  if (chosen.command === null) return refuse("no-check", `${ref.repo} has no approved ${level === "quick" ? "quick or full" : "full"} check. Set one in Settings → Projects → Checks.`);
  return { ok: true, repo: ref.repo, taskId: ref.externalId, head: run.headRevision, level: chosen.level as RunLevel, command: chosen.command };
}

/** Ask for checks on a result's exact commit. Asking twice while one is waiting
 * or running returns the same request; a worker runs it once. */
export function requestFollowUpChecks(store: Store, input: { runId: number; level: RunLevel; actor: string; why?: "person" | "pull-request" }, now: Date):
  { ok: true; request: number; level: RunLevel; existing: boolean } | Refusal {
  return store.transact(() => {
    const target = checkTarget(store, input.runId, input.level);
    if (!target.ok) return target;
    const open = followUpChecksOf(store, input.runId, now).find(one => one.level === target.level && one.head === target.head && (one.state === "waiting" || one.state === "running"));
    if (open !== undefined) return { ok: true as const, request: open.request, level: target.level, existing: true };
    const request = store.recordAction({ at: now.toISOString(), actor: input.actor, repo: target.repo, taskId: target.taskId, runId: input.runId,
      action: CHECKS_REQUESTED, outcome: target.level, source: "work", detail: `${target.head} · ${input.why ?? "person"} · ${target.command.digest}` });
    store.bumpWake();
    return { ok: true as const, request, level: target.level, existing: false };
  });
}

/** Requests nobody has started yet, oldest first. Batch requests wait for the batch pass (batch-checks.ts). */
export function waitingCheckRequests(store: Store, now: Date): FollowUpCheck[] {
  return waitingRequestsOfAnyKind(store, now).filter(one => one.why !== "batch");
}

export function waitingRequestsOfAnyKind(store: Store, now: Date): FollowUpCheck[] {
  const runs = store.handle.prepare(`SELECT DISTINCT r.run_id AS run FROM action_ledger r WHERE r.action = ? AND r.run_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM action_ledger s WHERE s.run_id = r.run_id AND s.action = ? AND s.outcome = CAST(r.id AS TEXT)) ORDER BY r.id`)
    .all(CHECKS_REQUESTED, CHECKS_STARTED).map(row => Number(row["run"]));
  return runs.flatMap(runId => followUpChecksOf(store, runId, now).filter(one => one.state === "waiting"));
}

export type CheckRunDeps = { runner?: Runner; git?: Runner; now?: () => Date; scratch?: string };

/** Run one waiting request: claim it, check out its commit, run the approved
 * setup (when the project has one) and the check, seal the log and receipt. */
export async function runFollowUpCheck(store: Store, root: string, request: number, deps: CheckRunDeps = {}): Promise<FollowUpCheck | null> {
  const now = deps.now ?? (() => new Date());
  const runner = deps.runner ?? execRun;
  const git = deps.git ?? execRun;
  const asked = store.handle.prepare("SELECT run_id FROM action_ledger WHERE id = ? AND action = ?").get(request, CHECKS_REQUESTED);
  if (asked === undefined) return null;
  const runId = Number(asked["run_id"]);
  const wanted = followUpChecksOf(store, runId, now()).find(one => one.request === request);
  if (wanted === undefined || wanted.state !== "waiting") return wanted ?? null;
  const target = checkTarget(store, runId, wanted.level);
  const finish = (status: "passed" | "failed" | "not-run", detail: string) => {
    store.recordAction({ at: now().toISOString(), actor: "system", repo: target.ok ? target.repo : null, taskId: target.ok ? target.taskId : null, runId,
      action: CHECKS_FINISHED, outcome: `${request}:${status}`, source: "work", detail });
    store.bumpWake();
  };
  // The claim: one started entry per request, written only while none exists.
  const claimed = store.transact(() => {
    if (store.handle.prepare("SELECT 1 FROM action_ledger WHERE run_id = ? AND action = ? AND outcome = ?").get(runId, CHECKS_STARTED, String(request)) !== undefined) return false;
    store.recordAction({ at: now().toISOString(), actor: "system", repo: target.ok ? target.repo : null, taskId: target.ok ? target.taskId : null, runId,
      action: CHECKS_STARTED, outcome: String(request), source: "work", detail: `limit ${target.ok ? target.command.timeoutMs : 0}` });
    return true;
  });
  if (!claimed) return followUpChecksOf(store, runId, now(), root).find(one => one.request === request) ?? null;
  if (!target.ok) { finish("not-run", target.message); return followUpChecksOf(store, runId, now(), root).find(one => one.request === request) ?? null; }
  // The commit asked about is the one checked, even if the result changed since.
  if (target.head !== wanted.head) { finish("not-run", "The result's commit changed after checks were asked for."); return followUpChecksOf(store, runId, now(), root).find(one => one.request === request) ?? null; }

  const folder = mkdtempSync(join(deps.scratch ?? tmpdir(), "toolroll-checks-"));
  const checkout = join(folder, "checkout");
  const log: string[] = [];
  const bound = (text: string) => { const hits = scanForSecrets(text); return boundStreamHeadTail(hits.length > 0 ? redactSecretLines(text, hits) : text, 24 * 1024); };
  const note = (label: string, command: string, result: ExecResult) =>
    log.push(`=== ${label} ===\n$ ${command}\n(exit ${result.code}${result.notFound ? ", could not start" : ""}${result.timedOut ? ", timed out" : ""})\n\n--- stdout ---\n${bound(result.stdout)}\n\n--- stderr ---\n${bound(result.stderr)}`);
  let result: { ran: true; exitCode: number } | { ran: false; failure: string };
  try {
    const added = await git("git", ["-C", target.repo, "worktree", "add", "--detach", checkout, target.head], { timeoutMs: 120_000 });
    if (added.code !== 0) {
      note("Checkout", `git worktree add --detach <fresh folder> ${target.head}`, added);
      result = { ran: false, failure: "The commit couldn't be checked out. It may have been removed from this computer." };
    } else {
      const setup = store.liveWorktreeSetup(target.repo);
      let ready = true;
      if (setup !== null) {
        const shell = approvedCommandShell(setup.command);
        const prepared = await runWithIsolatedDatabase(runner, shell.file, shell.args, { cwd: checkout, timeoutMs: setup.timeoutMs, processGroup: true, envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST });
        note("Approved project setup", setup.command, prepared);
        if (prepared.code !== 0 || prepared.timedOut || prepared.notFound) { ready = false; result = { ran: false, failure: "The project's setup failed, so the check didn't run." }; }
      }
      if (ready) {
        // The approval is re-read right before the check starts: a revoked or changed command never runs.
        const live = store.liveVerifyCommand(target.command.repo);
        if (live === null || live.digest !== target.command.digest || live.digest !== wanted.digest) {
          result = { ran: false, failure: "The approved check changed before it started." };
        } else {
          const shell = approvedCommandShell(live.command);
          const ran = await runWithIsolatedDatabase(runner, shell.file, shell.args, { cwd: checkout, timeoutMs: live.timeoutMs, processGroup: true, envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST });
          note(`${CHECK_LEVEL_WORDS[target.level]} check`, live.command, ran);
          result = ran.timedOut ? { ran: false, failure: "The check ran out of time." } : ran.notFound ? { ran: false, failure: "The check couldn't start." } : { ran: true, exitCode: ran.code };
        }
      } else result ??= { ran: false, failure: "The project's setup failed, so the check didn't run." };
    }
  } finally {
    await git("git", ["-C", target.repo, "worktree", "remove", "--force", checkout], { timeoutMs: 120_000 }).catch(() => null);
    rmSync(folder, { recursive: true, force: true });
  }
  const at = now();
  const text = log.length === 0 ? "No command started." : log.join("\n\n");
  const logId = storeEvidence(store, root, runId, "structured-output", `follow-up-check-${request}.log`, Buffer.from(text, "utf8"), FOLLOW_UP_LOG, at, { captureStatus: "ok" });
  const logArtifact = store.getArtifact(logId)!;
  const receipt = JSON.stringify({ version: 1, request, run: runId, head: target.head, tested: target.head, level: target.level,
    command: { repo: target.command.repo, command: target.command.command, digest: target.command.digest, approvedBy: target.command.approvedBy },
    result, log: { artifactId: logArtifact.id, sha256: logArtifact.sha256, bytesStored: logArtifact.bytesStored, truncated: logArtifact.truncated } }, null, 1);
  storeEvidence(store, root, runId, "structured-output", `follow-up-check-${request}.json`, Buffer.from(receipt, "utf8"), FOLLOW_UP_RECEIPT, at, { captureStatus: "ok" });
  if (result.ran) finish(result.exitCode === 0 ? "passed" : "failed", `${CHECK_LEVEL_WORDS[target.level]} checks on ${target.head.slice(0, 7)} · exit ${result.exitCode}`);
  else finish("not-run", result.failure);
  return followUpChecksOf(store, runId, now(), root).find(one => one.request === request) ?? null;
}

/** The worker's pass: run every waiting request, one at a time. */
export async function runWaitingChecks(store: Store, root: string, deps: CheckRunDeps & { shouldStop?: () => boolean } = {}): Promise<number> {
  let ran = 0;
  for (const one of waitingCheckRequests(store, (deps.now ?? (() => new Date()))())) {
    if (deps.shouldStop?.() === true) break;
    if ((await runFollowUpCheck(store, root, one.request, deps))?.state !== "waiting") ran++;
  }
  return ran;
}

// ---- what a result's checks say, with its follow-ups ------------------------

export type CheckReading = { status: "passed" | "failed" | "not-run" | "unavailable"; level: CheckLevel | null; exitCode: number | null; head: string | null };
/** The build's own check, then each finished follow-up in order on the same
 * commit: a pass upgrades (a quick pass never replaces a full one), a failure
 * is shown as it is. A follow-up that couldn't run changes nothing. */
export function withFollowUps(original: CheckReading, followUps: readonly Pick<FollowUpCheck, "level" | "state" | "head" | "exitCode">[]): CheckReading & { running: RunLevel | null } {
  let reading: CheckReading = original;
  for (const one of followUps) {
    if (original.head !== null && one.head !== "" && one.head !== original.head) continue;
    if (one.state === "passed") {
      if (!(reading.status === "passed" && reading.level === "full" && one.level === "quick")) reading = { status: "passed", level: one.level, exitCode: 0, head: one.head };
    } else if (one.state === "failed") reading = { status: "failed", level: one.level, exitCode: one.exitCode, head: one.head };
  }
  const running = followUps.filter(one => one.state === "waiting" || one.state === "running").at(-1)?.level ?? null;
  return { ...reading, running };
}

/** The level a result's checks stand at now: the build's own level, raised by
 * a follow-up that passed on the same commit. null for results from before levels. */
export function resultCheckLevel(store: Store, runId: number, now: Date): CheckLevel | null {
  const level = runCheckLevel(store, runId);
  const run = store.getRun(runId);
  const follows = followUpChecksOf(store, runId, now);
  if (follows.length === 0) return level;
  const read = withFollowUps({ status: level === "off" ? "not-run" : "passed", level, exitCode: null, head: run?.headRevision ?? null }, follows);
  return read.level;
}

/** Whether this result's commit has passed the project's full check, here or in a follow-up. */
export function fullCheckPassed(reading: CheckReading): boolean {
  return reading.status === "passed" && (reading.level === "full" || reading.level === null);
}

/** Before a Quick or Off result merges: the project's full check on its exact
 * commit. Clear when the build already ran the full check, when the project has
 * no full command (its CI covers it), or when a follow-up full check passed. */
export type FullCheckGate = { state: "clear" } | { state: "not-requested" | "waiting" | "failed" | "not-run"; message: string };
export function fullCheckGate(store: Store, runId: number, now: Date): FullCheckGate {
  const level = runCheckLevel(store, runId);
  const repo = repoOfRun(store, runId);
  const run = store.getRun(runId);
  if (level === null || repo === null || run === null) return { state: "clear" };
  const fulls = followUpChecksOf(store, runId, now).filter(one => one.level === "full" && one.head === run.headRevision);
  // A Full build that waited for a batch check has had no check of its own: Merge waits for the batch, like Quick does.
  const batched = level === "full" && fulls.some(one => one.why === "batch");
  if ((level === "full" && !batched) || (!batched && store.liveVerifyCommand(repo) === null)) return { state: "clear" };
  const last = fulls.at(-1);
  if (last === undefined) return { state: "not-requested", message: "The full check hasn't run on this commit yet. Merge once it passes, or merge anyway." };
  if (last.state === "passed") return { state: "clear" };
  if (last.state === "failed") return { state: "failed", message: `The full check failed on this commit${last.exitCode === null ? "" : ` (exit ${last.exitCode})`}. Fix it, or merge anyway.` };
  if (last.state === "not-run") return { state: "not-run", message: `The full check didn't finish on this commit${last.note === null ? "" : `: ${last.note}`} Run it again, or merge anyway.` };
  return { state: "waiting", message: "The full check is still running on this commit. Merge once it passes, or merge anyway." };
}

export const isQuickCommand = (command: VerifyCommand | null, repo: string): boolean => command !== null && command.repo === quickVerifyKey(repo);

// ---- Add tests --------------------------------------------------------------

/** File a small task to write tests for a result's change. It is filed like any
 * other task: nothing runs until a person approves it. */
export function fileAddTestsTask(store: Store, root: string | null, input: { runId: number; actor: string; filedVia: string; admittedRepos?: readonly string[] }, now: Date):
  { ok: true; id: string; existing: boolean } | Refusal {
  const run = store.getRun(input.runId);
  const ref = run === null ? null : store.refById(run.taskRef);
  if (run === null || ref === null) return refuse("unknown", "No such result.");
  if (ref.repo === null) return refuse("unplaced", "This result isn't in a project.");
  if (run.headRevision === null || !/^[a-f0-9]{40}$/.test(run.headRevision)) return refuse("no-commit", "This result has no commit to write tests for.");
  const earlier = store.handle.prepare("SELECT outcome FROM action_ledger WHERE run_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(input.runId, ADD_TESTS_ACTION);
  if (earlier !== undefined && store.getTask(String(earlier["outcome"])) !== null) return { ok: true, id: String(earlier["outcome"]), existing: true };
  const task = store.getTask(ref.externalId);
  const files = root === null ? [] : changedFilesOf(store, root, input.runId);
  const shown = files.slice(0, 12);
  const title = `Add tests for ${task?.title ?? ref.externalId}`.slice(0, 200);
  const goal = [
    `Write tests for the change made by ${ref.externalId} (commit ${run.headRevision.slice(0, 7)}).`,
    shown.length === 0 ? "" : `Changed files: ${shown.join(", ")}${files.length > shown.length ? `, and ${files.length - shown.length} more` : ""}.`,
    "Cover the changed behaviour, including its edge cases. Change product code only if a test shows a real bug, and say so.",
  ].filter(one => one !== "").join(" ");
  const filed = store.transact(() => {
    const made = fileTaskProposal(store, {
      title, repo: ref.repo!, goal, planning: "skip", filedVia: input.filedVia,
      acceptance: [{ id: "c1", statement: "New tests cover the changed behaviour and pass", evidence: ["check"], how: null }],
      ...(input.admittedRepos === undefined ? {} : { admittedRepos: input.admittedRepos }),
    }, now);
    if (!made.ok) return made;
    store.recordAction({ at: now.toISOString(), actor: input.actor, repo: ref.repo, taskId: ref.externalId, runId: input.runId, action: ADD_TESTS_ACTION, outcome: made.id, source: "request",
      detail: `Filed ${made.id}` });
    return made;
  });
  if (!filed.ok) return refuse(filed.reason, filed.message);
  return { ok: true, id: filed.id, existing: false };
}

function changedFilesOf(store: Store, root: string, runId: number): string[] {
  const stat = store.artifactsFor(runId).find(one => one.kind === "diff-stat");
  if (stat === undefined) return [];
  const read = readVerifiedArtifact(root, stat);
  if (!read.ok) return [];
  try {
    const parsed = JSON.parse(read.content.toString("utf8")) as { files?: { path?: unknown }[] };
    return (parsed.files ?? []).map(one => one.path).filter((one): one is string => typeof one === "string" && one.length < 300);
  } catch { return []; }
}
