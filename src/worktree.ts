/**
 * The pool of working copies, and the leases over them.
 *
 * Semantics copied from treehouse rather than reinvented, including the two
 * rules that are easy to get wrong and expensive to get wrong quietly:
 *
 * **Untracked files count as dirty.** A repository whose `.gitignore` hides
 * build output is still a repository with somebody's work in it, and a pool
 * that recycles a directory because `git status` looked clean under the
 * operator's config will delete something they wanted. So the check is run
 * with ignored files excluded but untracked files included, which is the
 * conservative reading of "is anyone using this".
 *
 * **Reconstructed state is leased-until-verified.** A worktree found on disk
 * after a crash describes what a dead process was doing, not what is true now.
 * It comes back into the pool marked unverified, and something has to look at
 * it before it is handed to anybody.
 *
 * Where the pool lives is a decision, not a detail. Worktrees are created
 * outside the repository — never inside it, where they would appear as
 * untracked directories in the operator's own `git status`, and never inside a
 * synced folder like OneDrive or Dropbox, where a sync client racing an agent
 * over `.git` internals corrupts both.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { currentBootId, provenDeadByBootChange } from "./boot-identity.js";
import type { Run, Store, WorktreeRow } from "./store.js";
import { HANDOFF_PREFIX, MAILBOX_SUFFIX, looksLikeProtocolFile, readMailbox } from "./evidence.js";
import { parseHandoff } from "./decision.js";
import { diskBytes } from "./storage.js";
import { markNeverIndex } from "./never-index.js";

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

export type PoolOptions = {
  /** Where worktrees are created. Outside the repo, and outside any sync root. */
  root: string;
  runner?: Runner;
};

export type LeaseRequest = {
  repo: string;
  branch: string;
  runner: string;
  taskRef?: number;
  now: Date;
  /** Branch to create from, when the branch does not exist yet. */
  base?: string;
  /**
   * Reclaim this task's OWN leftover: when the checkout was released dirty
   * by a finished attempt of the same task (not a dead runner's, not
   * another task's), keep what it left as a patch under the last run's
   * evidence and reset the tree for the next attempt. Without this a
   * failed attempt's half-edit blocks every retry forever.
   */
  reclaim?: { evidenceRoot: string };
  /** With `base`: a branch that already exists (its checkout removed by storage retention) is checked out as it
   * stands, as its kept checkout would have been reused. Without it, `base` always starts a new branch (and an
   * existing one refuses). */
  reuseBranch?: boolean;
};

export type LeaseResult =
  | {
      ok: true;
      worktree: WorktreeRow;
      created: boolean;
      reclaimed?: string;
      resumedFromRun?: number;
      recoveryKind?: "completed" | "partial";
    }
  | { ok: false; reason: LeaseFailure; message: string };

export type LeaseFailure = "held" | "dirty" | "git" | "unverified" | "unknown-runner" | "in-use";

/** Why storage retention left a checkout in place. */
export type KeptWhy = "has changes" | "has commits" | "unreadable" | "git refused";

/**
 * The note a lease leaves in the checkout, naming the process holding it.
 *
 * Deliberately inside the worktree rather than beside it: it travels with the
 * directory, and `git status` will show it as untracked, which is honest —
 * something is in there.
 */
export const MARKER = ".standing-orders-lease";

/** Checkouts this process is leasing or removing right now: a lease and storage retention never overlap on one. */
const busy = new Map<string, "leasing" | "removing">();

/** What a kept checkout drops once its run ends (only where .gitignore hides it): dependencies and build output. */
export const SLIM_NAMES: readonly string[] = ["node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", "coverage", "target"];

/** Creating a worktree copies a tree; it is local work but not instant. */
export const WORKTREE_TIMEOUT_MS = 60_000;
const GIT = "git";
const READ_ONLY = ["--no-optional-locks"] as const;

/**
 * A path for this repository and branch that is stable across runs.
 *
 * Stable so that a second attempt at the same task reuses the checkout it
 * already paid for, and flattened so a branch called `feat/a/b` cannot escape
 * the pool root through its own slashes.
 */
export function worktreePath(root: string, repo: string, branch: string): string {
  // The readable part is for a person reading `ls`; the digest is what makes
  // it correct. Flattening alone collides in two ways that both end with one
  // task's work landing in another's checkout: `feat/a` and `feat-a` reduce to
  // the same name, and `/x/api` and `/y/api` share a basename. The digest is
  // taken over the full repository path and the exact branch, so neither can.
  const digest = createHash("sha256")
    .update(`${normalisePath(repo)}\u0000${branch}`, "utf8")
    .digest("hex")
    .slice(0, 8);

  return join(root, safeSegment(basenameOf(repo)), `${safeSegment(branch)}-${digest}`);
}

function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function basenameOf(repo: string): string {
  const parts = repo.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "repo";
}

/** Anything that is not a plain name becomes one; no separators survive. */
function safeSegment(text: string): string {
  const cleaned = text.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned === "" ? "x" : cleaned;
}

/** Record a potentially writing subprocess against the original checkout lease. */
export function recordWorktreeProcess(store: Store, path: string, runner: string, pid: number, leaseEpoch?: string | null): void {
  const leased = store.getWorktree(path);
  if (!Number.isInteger(pid) || pid <= 0 || leased === null || leased.releasedAt !== null || leased.runner !== runner ||
      (leaseEpoch !== undefined && leased.leaseEpoch !== leaseEpoch)) {
    throw new Error(`${path}: subprocess custody no longer matches its worktree lease`);
  }
  // The boot the holder was born under rides the note (v53): after a
  // verified boot change nothing of it survives, and the checkout is free
  // without a PID probe that a reused pid could answer wrongly.
  const bootId = currentBootId();
  writeFileSync(join(path, MARKER), `${pid} ${runner} group ${bootId ?? "unknown"} ${hostname()}\n`, "utf8");
}

/** Read-only occupancy witness shared with stop settlement. */
export function worktreeProcessOccupancy(path: string): { held: true; by: number } | { held: false } {
  const note = join(path, MARKER);
  if (!existsSync(note)) return { held: false };

  const parts = readFileSync(note, "utf8").trim().split(/\s+/);
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return { held: false };
  const noteHost = parts[4];
  if (noteHost !== undefined && noteHost !== hostname()) return { held: true, by: pid };
  if (pid === process.pid && parts[2] !== "group") return { held: false };
  // A note from a previous, VERIFIED boot of this host names a process
  // that cannot exist any more; a note without a boot id (legacy) or a
  // boot this host cannot verify keeps the probe below.
  const noteBoot = parts[3];
  if (noteBoot !== undefined && noteHost !== undefined && provenDeadByBootChange({ host: noteHost, bootId: noteBoot })) return { held: false };

  // A shell/provider can exit before its descendants. A recorded POSIX
  // process group remains an owner until that whole group has gone.
  if (parts[2] === "group" && process.platform !== "win32") {
    try { process.kill(-pid, 0); return { held: true, by: pid }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { held: true, by: pid }; }
  }

  try {
    process.kill(pid, 0);
    return { held: true, by: pid };
  } catch (error) {
    // Two different answers hide behind one throw. ESRCH means the process
    // is gone and the note is what it left behind. EPERM means it is very
    // much alive and simply not ours to signal — running as another user, or
    // elevated — and reading that as "gone" would hand somebody's live
    // checkout to another runner. Only ESRCH frees it.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? { held: false } : { held: true, by: pid };
  }
}

/**
 * A checkout's uncommitted work as one patch — tracked changes against HEAD,
 * then each untracked file against nothing (the lease note aside) — written
 * to `file`. Nothing in the checkout is touched. Every road that is about to
 * reset or clean a tree saves this first.
 */
export async function saveWorkPatch(runner: Runner, path: string, file: string, header: string): Promise<{ ok: true; file: string } | { ok: false; message: string }> {
  const status = await runner(GIT, [...READ_ONLY, "status", "--porcelain", "--untracked-files=all"], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (status.code !== 0) return { ok: false, message: `${path} could not be inspected before its work was saved` };
  const untracked = status.stdout
    .split("\n")
    .filter(line => line.startsWith("?? ") && !line.trimEnd().endsWith(MARKER))
    .map(line => line.slice(3).trim());
  const tracked = await runner(GIT, [...READ_ONLY, "diff", "--binary", "HEAD"], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (tracked.code !== 0) return { ok: false, message: `${path}: git diff failed while saving its work (${firstLine(tracked.stderr)})` };
  const parts = [tracked.stdout];
  for (const one of untracked) {
    // --no-index exits 1 when the sides differ; that is the expected answer.
    const diff = await runner(GIT, [...READ_ONLY, "diff", "--binary", "--no-index", "--", "/dev/null", one], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (diff.code > 1) return { ok: false, message: `${path}: ${one} could not be captured (${firstLine(diff.stderr)})` };
    parts.push(diff.stdout);
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, header + parts.join(""), { mode: 0o600 });
  } catch (error) {
    return { ok: false, message: `${path}: its work could not be written to ${file} (${error instanceof Error ? error.message : String(error)})` };
  }
  return { ok: true, file };
}

export class WorktreePool {
  private readonly runner: Runner;

  constructor(
    private readonly store: Store,
    private readonly options: PoolOptions,
  ) {
    this.runner = options.runner ?? run;
  }

  /**
   * Take a working copy for this branch.
   *
   * Refused when somebody else holds it — losing is ordinary, and a caller
   * that is told who holds it can go and do something else rather than poll.
   */
  /**
   * Whether a live process is working in there, independently of what the
   * database believes.
   *
   * treehouse's rule, and it exists because the database is the thing most
   * likely to be wrong: a row saying "released" written by a process that then
   * kept running, or a stale row from a crash, are both cases where the
   * checkout is genuinely occupied and only the machine can say so. So each
   * lease drops a note naming the process holding it, and `process.kill(pid, 0)`
   * — which signals nothing and only asks whether the pid exists — is what
   * answers the question afterwards.
   *
   * A pid can be recycled by the operating system, so this can say "in use"
   * about a stranger. That is the safe direction: refusing a checkout somebody
   * may be in costs a retry, and taking one they are in costs their work.
   */
  inUse(path: string): { held: true; by: number } | { held: false } {
    return worktreeProcessOccupancy(path);
  }

  /**
   * Once a provider exists it, not the supervising console, is the process
   * whose liveness protects this checkout. Rewriting the occupancy marker at
   * spawn means a replacement control plane waits for an orphaned provider
   * to finish instead of starting a second writer in the same worktree.
   */
  markProviderOccupancy(path: string, runner: string, providerPid: number, leaseEpoch?: string | null): boolean {
    if (!Number.isInteger(providerPid) || providerPid <= 0) return false;
    const leased = this.store.getWorktree(path);
    if (leased === null || leased.releasedAt !== null || leased.runner !== runner) return false;
    if (leaseEpoch !== undefined && leased.leaseEpoch !== leaseEpoch) return false;
    try { recordWorktreeProcess(this.store, path, runner, providerPid, leaseEpoch); return true; }
    catch { return false; }
  }

  /** Spawn callbacks must fail if custody cannot be recorded. The transport
   * kills and reaps its child before returning that callback failure. */
  recordProviderOccupancy(path: string, runner: string, providerPid: number, leaseEpoch?: string | null): void {
    if (!this.markProviderOccupancy(path, runner, providerPid, leaseEpoch)) {
      throw new Error(`${path}: the provider's worktree custody could not be recorded`);
    }
  }

  async lease(request: LeaseRequest): Promise<LeaseResult> {
    const target = worktreePath(this.options.root, request.repo, request.branch);
    if (busy.get(target) === "removing") return { ok: false, reason: "in-use", message: `${target} is being removed; try again in a moment` };
    const mine = !busy.has(target);
    if (mine) busy.set(target, "leasing");
    try { return await this.leaseNow(request); } finally { if (mine) busy.delete(target); }
  }

  private async leaseNow(request: LeaseRequest): Promise<LeaseResult> {
    // A worktree leased to a runner nobody registered cannot be heartbeated
    // and cannot be recovered — it would be a checkout that never comes back.
    // The database enforces this too; catching it here is what turns a foreign
    // key error into a sentence somebody can act on.
    if (this.store.getRunner(request.runner) === null) {
      return {
        ok: false,
        reason: "unknown-runner",
        message: `no runner \`${request.runner}\` — register it before giving it work`,
      };
    }

    const path = worktreePath(this.options.root, request.repo, request.branch);
    const existing = this.store.getWorktree(path);

    // The machine outranks the database here. A row can say "released" while a
    // process that never got to write its own ending is still working in the
    // directory, and that is exactly when taking it away costs somebody a
    // night's work.
    const occupied = this.inUse(path);
    if (occupied.held) {
      return {
        ok: false,
        reason: "in-use",
        message: `${path} is being used by process ${occupied.by} — leaving it alone`,
      };
    }

    if (existing !== null && existing.releasedAt === null && existing.runner !== request.runner) {
      return {
        ok: false,
        reason: "held",
        message: `${path} is leased to ${existing.runner ?? "someone"}`,
      };
    }

    // Re-inspect every released checkout at the lease boundary. `verified`
    // says it was clean when released, not that no orphan/provider/person
    // wrote to it afterwards; trusting that old bit is how a restored safety
    // patch can be handed out without recovery lineage or silently reset.
    let reclaimed: string | undefined;
    let resumedFromRun: number | undefined;
    let recoveryKind: "completed" | "partial" | undefined;
    if (existing !== null && existing.releasedAt !== null) {
      const dirty = await this.isDirty(path);
      if (dirty === null) {
        return { ok: false, reason: "git", message: `${path} could not be inspected` };
      }
      if (dirty) {
        // The task's own leftover, from an attempt that finished and said
        // so: kept as evidence, then cleared, so the retry starts from the
        // branch and not from a half-edit. Anything else stays for a person.
        const own = request.reclaim !== undefined && request.taskRef !== undefined && existing.taskRef === request.taskRef;
        if (!own) {
          return {
            ok: false,
            reason: "dirty",
            message: `${path} has uncommitted or untracked work from a previous run — look before reusing it`,
          };
        }
        const previousRun = this.store.latestRunInWorktree(path);
        const recoveryRun = this.store.latestRecoverableRunInWorktree(path);
        const recovery = recoveryRun === null ? null : this.recoverableDraft(path, recoveryRun, previousRun);
        const kept = await this.keepLeftover(path, (request.reclaim as { evidenceRoot: string }).evidenceRoot, request.now);
        if (!kept.ok) return { ok: false, reason: "git", message: kept.message };
        reclaimed = kept.file;
        if (recovery !== null) {
          // The predecessor reached a structurally valid completed handoff
          // before its runner disappeared. Keep its draft in place under the
          // fresh lease so the successor reviews and verifies it. build()
          // quarantines the old nonce-bound handoff before the new provider
          // starts, so only the source draft crosses attempts — never the old
          // attempt's authority.
          resumedFromRun = recovery.runId;
          recoveryKind = recovery.kind;
        } else {
          const reset = await this.resetTree(path);
          if (!reset.ok) return { ok: false, reason: "git", message: reset.message };
        }
      }
    }

    const created = existing === null;
    if (created) {
      // A branch that already exists (its checkout removed by storage retention) is checked out as it stands, just
      // as its kept checkout would have been reused; `base` only starts a branch that doesn't exist yet.
      const branchExists = request.base !== undefined && request.reuseBranch === true &&
        (await this.git(request.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}`], READ_ONLY)).code === 0;
      const fromBase = request.base !== undefined && !branchExists;
      // Spotlight leaves the checkouts alone: the marker sits in the pool and the project's folder, never inside a
      // checkout, where a build's `git add -A` would commit it (never-index.ts).
      try { mkdirSync(dirname(path), { recursive: true }); } catch { /* git reports it */ }
      markNeverIndex(this.options.root);
      markNeverIndex(dirname(path));
      const add = await this.git(request.repo, [
        "worktree",
        "add",
        ...(fromBase ? ["-b", request.branch] : []),
        path,
        ...(fromBase ? [request.base as string] : [request.branch]),
      ]);
      if (add.code !== 0) {
        return { ok: false, reason: "git", message: firstLine(add.stderr) };
      }
    }

    const row: WorktreeRow = {
      path,
      repo: request.repo,
      branch: request.branch,
      runner: request.runner,
      taskRef: request.taskRef ?? null,
      createdAt: existing?.createdAt ?? request.now.toISOString(),
      leasedAt: request.now.toISOString(),
      releasedAt: null,
      // Freshly created, or inspected just above — either way, checked.
      verified: true,
      // The occupancy epoch (live-peek findings 16/28): fresh randomness,
      // written by the SAME row write that grants the lease — it can never
      // repeat and never lag the occupancy it names.
      leaseEpoch: randomBytes(12).toString("hex"),
    };
    // The note goes down before the lease is granted. A checkout we cannot
    // mark is one whose next holder cannot tell it is occupied — the in-use
    // check would report it free while a process worked in it — so failing to
    // write the note fails the lease rather than quietly leaving the gap.
    if (!this.mark(path, request.runner)) {
      return {
        ok: false,
        reason: "git",
        message: `${path} could not be marked as in use, so it is not safe to hand out`,
      };
    }

    this.store.saveWorktree(row);
    return {
      ok: true,
      worktree: row,
      created,
      ...(reclaimed === undefined ? {} : { reclaimed }),
      ...(resumedFromRun === undefined ? {} : { resumedFromRun }),
      ...(recoveryKind === undefined ? {} : { recoveryKind }),
    };
  }

  /**
   * A crash can strand either a finished handoff or a partial source draft.
   * The expired lease can no longer authorize a commit, so this never ingests
   * the old result. It classifies the recovery context for the next freshly
   * fenced attempt, which must review and prove the inherited work itself.
   */
  private recoverableDraft(path: string, runId: number, latestRun: number | null): { runId: number; kind: "completed" | "partial" } | null {
    const prior = this.store.getRun(runId);
    if (prior === null) return null;
    // Once a fresh attempt has explicitly inherited a validated draft, keep
    // that lineage through an infrastructure/provider failure too. A warm
    // park resume also uses parentRun, but its parent is `parked`, never the
    // failed/interrupted source required here.
    if (prior.parentRun !== null) {
      const source = this.store.getRun(prior.parentRun);
      if (source?.outcome === "failed" && source.reason === "interrupted") {
        return { runId: source.id, kind: "partial" };
      }
    }
    // An attempt that stopped before its handoff (run 2085) left work it
    // never got to hand off: kept in place for the next attempt, never reset
    // — until a later attempt fails some other way. That failure may have
    // broken the tree, and the work is already saved (its own patch, and the
    // leftover patch the caller writes first), so the tree can be reset. A
    // crash or a sign-in that stopped working says nothing about the tree.
    // A resumed or repair turn is judged as part of the attempt it belongs to.
    const attemptOf = (one: Run | null): Run | null =>
      one !== null && one.role === "repair" && one.parentRun !== null ? this.store.getRun(one.parentRun) ?? one : one;
    const brokeTree = (one: Run | null): boolean =>
      one !== null && one.outcome === "failed" && one.reason !== "no-handoff" && one.reason !== "interrupted" && one.reason !== "auth-expired";
    const attempt = attemptOf(prior)!;
    const later = latestRun !== null && latestRun > runId ? attemptOf(this.store.getRun(latestRun)) : null;
    const unhanded = attempt.outcome === "failed" && attempt.reason === "no-handoff"
      ? attempt
      : attempt.parentRun === null ? null : this.store.getRun(attempt.parentRun);
    if (unhanded !== null && unhanded.outcome === "failed" && unhanded.reason === "no-handoff") {
      return brokeTree(attempt) || brokeTree(later) ? null : { runId: unhanded.id, kind: "partial" };
    }
    if (prior.outcome !== null && (prior.outcome !== "failed" || prior.reason !== "interrupted")) return null;
    let names: string[];
    try {
      names = readdirSync(path).filter(name => name.startsWith(HANDOFF_PREFIX) && name.endsWith(MAILBOX_SUFFIX));
    } catch {
      return { runId, kind: "partial" };
    }
    if (names.length !== 1) return { runId, kind: "partial" };
    const read = readMailbox(join(path, names[0] as string));
    if (!read.ok) return { runId, kind: "partial" };
    const parsed = parseHandoff(read.raw.toString("utf8"));
    return {
      runId,
      kind: parsed.ok && parsed.handoff.status === "completed" ? "completed" : "partial",
    };
  }

  /**
   * Preserve a dirty tree's work as one patch — tracked changes against
   * HEAD, then each untracked file against nothing — under the evidence of
   * the last run that lived in this checkout (or a leftover folder when no
   * run is on record). Nothing is deleted here.
   */
  private async keepLeftover(path: string, evidenceRoot: string, now: Date): Promise<{ ok: true; file: string } | { ok: false; message: string }> {
    const lastRun = this.store.latestRunInWorktree(path);
    const dir = lastRun === null ? join(evidenceRoot, "leftover") : join(evidenceRoot, String(lastRun));
    const file = join(dir, lastRun === null ? `${now.toISOString().replace(/[:.]/g, "-")}.patch` : "leftover.patch");
    return saveWorkPatch(this.runner, path, file, `# leftover from ${path}\n# kept ${now.toISOString()} before the tree was reset for the next attempt\n`);
  }

  /** Back to HEAD, untracked gone, our lease note kept; proven clean after. */
  private async resetTree(path: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const checkout = await this.runner(GIT, ["checkout", "--", "."], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (checkout.code !== 0) return { ok: false, message: `${path}: git checkout failed while resetting (${firstLine(checkout.stderr)})` };
    const clean = await this.runner(GIT, ["clean", "-fd", "-e", MARKER], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (clean.code !== 0) return { ok: false, message: `${path}: git clean failed while resetting (${firstLine(clean.stderr)})` };
    const dirty = await this.isDirty(path);
    if (dirty !== false) return { ok: false, message: `${path} is still not clean after the reset — leaving it for a person` };
    return { ok: true };
  }

  /** Leave a note naming the process holding this checkout. */
  private mark(path: string, runner: string, pid = process.pid): boolean {
    try {
      writeFileSync(join(path, MARKER), `${pid} ${runner} process ${currentBootId() ?? "unknown"} ${hostname()}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Hand a working copy back.
   *
   * The tree is inspected first, and dirt is reported rather than cleaned.
   * `git reset --hard` leaves untracked files behind and destroys work that
   * might have been repairable, which is why the failure taxonomy this project
   * borrows says to preserve a failed commit rather than blanket-reset.
   */
  async release(path: string, now: Date): Promise<LeaseResult> {
    const existing = this.store.getWorktree(path);
    if (existing === null) {
      return { ok: false, reason: "git", message: `${path} is not a worktree we made` };
    }

    const dirty = await this.isDirty(path);
    // The note goes before the row is written: a crash between the two should
    // leave a checkout that looks free rather than one held by a pid that has
    // gone, which is the direction that needs no human to unstick it.
    try {
      rmSync(join(path, MARKER), { force: true });
    } catch {
      // Nothing to do about it, and the pid check handles a note left behind.
    }

    const row: WorktreeRow = {
      ...existing,
      runner: null,
      releasedAt: now.toISOString(),
      // Unknown counts as unverified. Saying "clean" about a tree we could not
      // read would hand the next runner a surprise.
      verified: dirty === false,
      // Occupancy ended: the epoch rotates HERE too, so a peek proved
      // against the tenancy that just ended can only discard (finding 28).
      leaseEpoch: randomBytes(12).toString("hex"),
    };
    this.store.saveWorktree(row);

    if (dirty === null) {
      return { ok: false, reason: "git", message: `${path} could not be inspected on release` };
    }
    if (dirty) {
      return {
        ok: false,
        reason: "dirty",
        message: `${path} still has uncommitted or untracked work — it is kept, not cleaned`,
      };
    }
    return { ok: true, worktree: row, created: false };
  }

  /**
   * Worktrees git knows about that this pool does not, and the reverse.
   *
   * The first is somebody else's business and is left alone. The second is
   * ours: a row for a directory that is no longer there, which happens when a
   * machine is reimaged or a pool root is deleted between runs.
   */
  /**
   * Remove a released checkout and its branch (v4 review, finding 3): the
   * read-only roles' workspaces are disposable, so the next attempt starts
   * from the requested base instead of whatever the last one saw. Refused
   * while a process holds the directory; a failure leaves the checkout
   * where `worktrees` can see it rather than pretending it is gone.
   */
  async discard(path: string, now: Date): Promise<{ ok: true } | { ok: false; message: string }> {
    const existing = this.store.getWorktree(path);
    if (existing === null) return { ok: false, message: `${path} is not a worktree we made` };
    if (existing.releasedAt === null) return { ok: false, message: `${path} is still leased — release it first` };
    const occupied = this.inUse(path);
    if (occupied.held) return { ok: false, message: `${path} is being used by process ${occupied.by} — leaving it alone` };
    const removed = await this.git(existing.repo, ["worktree", "remove", "--force", path]);
    if (removed.code !== 0) return { ok: false, message: `git worktree remove: ${removed.stderr.trim() || `exit ${removed.code}`}` };
    // The branch is disposable too; a failure here is bookkeeping, not custody.
    await this.git(existing.repo, ["branch", "-D", existing.branch]);
    this.store.forgetWorktree(path);
    void now;
    return { ok: true };
  }

  async orphans(
    repo: string,
  ): Promise<{ ok: true; untracked: string[]; missing: string[] } | { ok: false; message: string }> {
    const listed = await this.git(repo, ["worktree", "list", "--porcelain"], READ_ONLY);
    // A listing that failed is not a listing that came back empty. Treating
    // it as empty would report every stored row as missing — and anything
    // acting on that answer would erase real bookkeeping over a git hiccup.
    if (listed.code !== 0) {
      return {
        ok: false,
        message: `git could not list ${repo}'s worktrees — ${listed.stderr.trim() || `exit ${listed.code}`}`,
      };
    }
    const onDisk = new Set(
      listed.stdout
        .split("\n")
        .filter(line => line.startsWith("worktree "))
        .map(line => line.slice("worktree ".length).trim()),
    );

    const ours = this.store.listWorktrees().filter(row => row.repo === repo);
    const known = new Set(ours.map(row => row.path));

    return {
      ok: true,
      untracked: [...onDisk].filter(path => !known.has(path) && path !== repo),
      missing: ours.filter(row => !onDisk.has(row.path)).map(row => row.path),
    };
  }

  /**
   * Take responsibility for worktrees that exist but nothing recorded.
   *
   * These turn up after a crash between `git worktree add` and the row that
   * should have followed it, or when a database is replaced while checkouts
   * survive on disk. Left alone they are invisible: git knows about them,
   * every pool query does not, and the same branch gets checked out again
   * beside them.
   *
   * Adopted **released and unverified**, never leased. Nobody watched them
   * being made, so they are a claim about the past — the same rule that
   * governs a dead runner's worktrees, for the same reason.
   *
   * Rows whose directory is gone are dropped: a lease over a path that does
   * not exist can only refuse work that could otherwise have run.
   */
  async adopt(
    repo: string,
    now: Date,
  ): Promise<{ ok: true; adopted: string[]; forgotten: string[] } | { ok: false; message: string }> {
    const found = await this.orphans(repo);
    // Fail closed, before anything is written or forgotten: an answer built
    // on a failed listing would adopt nothing and erase everything.
    if (!found.ok) return found;

    // Only what lives under this pool's root is ours to adopt. A worktree the
    // operator made by hand, wherever they made it, is somebody's business —
    // it is named by `orphans()` and left exactly where it is. Compared as
    // real paths, because git reports where a directory actually is while the
    // configured root may reach it through a symlink (macOS's /var, for one).
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    const root = normalisePath(real(this.options.root)) + "/";
    const adoptable = found.untracked.filter(path => normalisePath(real(path)).startsWith(root));

    // Git's listing is a survey, not permission to overwrite custody. A
    // builder may create and record a worktree while the listing is in
    // flight. Recheck under the writer transaction, and never forget an
    // owned checkout or a directory that appeared after the listing.
    return this.store.transact(() => {
      const adopted: string[] = [];
      const forgotten: string[] = [];
      for (const path of adoptable) {
        if (this.store.getWorktree(path) !== null || this.inUse(path).held) continue;
        this.store.saveWorktree({
          path,
          repo,
          // The branch is not knowable from the listing alone, and inventing one
          // would be worse than admitting it: whoever verifies this will look.
          branch: "unknown",
          runner: null,
          taskRef: null,
          createdAt: now.toISOString(),
          leasedAt: null,
          releasedAt: now.toISOString(),
          verified: false,
        });
        adopted.push(path);
      }
      for (const path of found.missing) {
        const current = this.store.getWorktree(path);
        if (current === null || current.repo !== repo || (current.runner !== null && current.releasedAt === null) || existsSync(path)) continue;
        this.store.forgetWorktree(path);
        forgotten.push(path);
      }
      return { ok: true as const, adopted, forgotten };
    });
  }

  /**
   * Whether a let-go checkout could go without losing anything: clean (build output that .gitignore hides is not
   * work, and neither are the files Toolroll itself wrote in there), and everything its HEAD reaches on a branch, tag
   * or remote. Reads only.
   */
  async inspect(path: string): Promise<"clean" | KeptWhy> {
    const dirty = await this.isDirty(path, true);
    if (dirty !== false) return dirty === null ? "unreadable" : "has changes";
    // Commits only this checkout's HEAD reaches (a detached HEAD moved on) exist nowhere else.
    const own = await this.runner(GIT, [...READ_ONLY, "rev-list", "-1", "HEAD", "--not", "--branches", "--tags", "--remotes"], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (own.code !== 0) return "unreadable";
    return own.stdout.trim() === "" ? "clean" : "has commits";
  }

  /**
   * Keep storage in check: remove the working copies nobody needs any more. Of `rows`, a checkout goes when it is
   * let go, nothing holds it, `wanted` says it may go (asked again right before it goes, so a task coming back or a
   * lease since keeps it) and `inspect` finds it clean. Only the working copy goes: its branch, and so every commit,
   * stays, and a later lease of the same branch makes a new one. At most `max` go per pass.
   */
  async prune(rows: readonly WorktreeRow[], wanted: (row: WorktreeRow, fresh: boolean) => boolean, max = Infinity): Promise<{ removed: WorktreeRow[]; kept: { path: string; why: KeptWhy }[] }> {
    const removed: WorktreeRow[] = [];
    const kept: { path: string; why: KeptWhy }[] = [];
    const idle = (row: WorktreeRow | null, releasedAt: string) =>
      row !== null && row.runner === null && row.releasedAt === releasedAt && !this.inUse(row.path).held;
    for (const row of rows) {
      if (removed.length >= max) break;
      if (row.releasedAt === null || row.runner !== null || busy.has(row.path) || !wanted(row, false)) continue;
      if (!existsSync(row.path) || !idle(row, row.releasedAt)) continue;
      const found = await this.inspect(row.path);
      if (found !== "clean") { kept.push({ path: row.path, why: found }); continue; }
      if (busy.has(row.path)) continue;
      busy.set(row.path, "removing");
      try {
        // A lease, or a task coming back, since the listing wins: look again right before removing.
        const now = this.store.getWorktree(row.path);
        if (!idle(now, row.releasedAt) || !wanted(now as WorktreeRow, true)) continue;
        const gone = await this.removeWorkingCopy(row);
        if (!gone) { kept.push({ path: row.path, why: "git refused" }); continue; }
        removed.push(row);
      } finally { busy.delete(row.path); }
    }
    return { removed, kept };
  }

  /**
   * Drop a let-go, idle checkout's dependencies and build output: the folders .gitignore hides that are named like
   * them (SLIM_NAMES). Its work, tracked or untracked, is untouched. The setup stamp goes first, so the next lease
   * runs the project's setup again and restores them. `wanted` is asked again right before anything goes; `deps`
   * false keeps node_modules (no setup would restore it).
   */
  async slim(row: WorktreeRow, wanted: (row: WorktreeRow) => boolean, deps = true): Promise<{ ok: true; dropped: string[]; bytes: number } | { ok: false; message: string }> {
    const idle = (now: WorktreeRow | null) => now !== null && now.runner === null && now.releasedAt !== null && now.releasedAt === row.releasedAt && !this.inUse(row.path).held;
    if (busy.has(row.path) || !existsSync(row.path) || !idle(this.store.getWorktree(row.path))) return { ok: false, message: `${row.path} is in use` };
    const listed = await this.runner(GIT, [...READ_ONLY, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { cwd: row.path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (listed.code !== 0) return { ok: false, message: `git couldn't list ${row.path}` };
    const drop = listed.stdout.split("\0").filter(one => one.endsWith("/")).map(one => one.slice(0, -1))
      .filter(one => { const name = one.split("/").at(-1)!; return SLIM_NAMES.includes(name) && (deps || name !== "node_modules"); });
    if (drop.length === 0) return { ok: true, dropped: [], bytes: 0 };
    busy.set(row.path, "removing");
    const note = join(row.path, MARKER);
    let held = false;
    try {
      const now = this.store.getWorktree(row.path);
      if (!idle(now) || !wanted(now!)) return { ok: false, message: `${row.path} is in use` };
      // Held while it slims: another process's lease sees this process in it.
      try { writeFileSync(note, `${process.pid} storage-retention slimming ${currentBootId() ?? "unknown"} ${hostname()}\n`, "utf8"); held = true; } catch { return { ok: false, message: `${row.path} couldn't be held` }; }
      const sizes = diskBytes(drop.map(one => join(row.path, one)));
      this.store.forgetWorktreeSetup(row.path);
      for (const one of drop) rmSync(join(row.path, one), { recursive: true, force: true, maxRetries: 3 });
      return { ok: true, dropped: drop, bytes: [...sizes.values()].reduce((sum, one) => sum + one, 0) };
    } finally {
      if (held) rmSync(note, { force: true });
      busy.delete(row.path);
    }
  }

  /**
   * Throw away a let-go checkout kept for its changes, on purpose: the working copy and what is uncommitted in it
   * go; its branch, and every commit on it, stays. Refused while anything holds it.
   */
  async discardChanges(path: string): Promise<{ ok: true; row: WorktreeRow } | { ok: false; message: string }> {
    const row = this.store.getWorktree(path);
    if (row === null) return { ok: false, message: `${path} is not a checkout Toolroll made` };
    if (row.releasedAt === null || row.runner !== null || busy.has(path)) return { ok: false, message: `${path} is in use — it can't be discarded now` };
    const occupied = this.inUse(path);
    if (occupied.held) return { ok: false, message: `${path} is being used by process ${occupied.by} — it can't be discarded now` };
    busy.set(path, "removing");
    try {
      if (!existsSync(path)) {
        this.store.transact(() => { const still = this.store.getWorktree(path); if (still !== null && still.runner === null && still.releasedAt === row.releasedAt) this.store.forgetWorktree(path); });
        return { ok: true, row };
      }
      return (await this.removeWorkingCopy(row)) ? { ok: true, row } : { ok: false, message: `git would not remove ${path}` };
    } finally { busy.delete(path); }
  }

  /** Remove one idle checkout's working copy (the caller holds it in `busy`) and forget its row. */
  private async removeWorkingCopy(row: WorktreeRow): Promise<boolean> {
    // Held while it goes: another process's lease sees this process in it (the busy map is this process's only).
    const note = join(row.path, MARKER);
    try { writeFileSync(note, `${process.pid} storage-retention removing ${currentBootId() ?? "unknown"} ${hostname()}\n`, "utf8"); } catch { return false; }
    const gone = await this.git(row.repo, ["worktree", "remove", "--force", row.path]);
    if (gone.code !== 0) { rmSync(note, { force: true }); return false; }
    this.store.transact(() => {
      const still = this.store.getWorktree(row.path);
      if (still !== null && still.runner === null && still.releasedAt === row.releasedAt) this.store.forgetWorktree(row.path);
    });
    return true;
  }

  /**
   * Whether anybody's work is in there. null means we could not tell, which is
   * neither clean nor dirty and must not be rounded to either.
   *
   * `--untracked-files=all` and no `--ignored`: build output that .gitignore
   * hides is not work, but a file somebody dropped in and never staged is.
   */
  private async isDirty(path: string, ignoreOwnFiles = false): Promise<boolean | null> {
    const status = await this.runner(
      GIT,
      [...READ_ONLY, "status", "--porcelain", "--untracked-files=all"],
      { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS },
    );
    if (status.code !== 0) return null;

    // Our own lease note is not the operator's work. Without this the marker
    // makes every checkout permanently dirty, which would jam the pool shut on
    // the first lease — untracked files counting as dirty is the right rule,
    // and this is the one file it must not apply to.
    // Deciding whether a checkout can go, the files Toolroll wrote at its top (a progress note, a handoff, a
    // proof list) are not a person's work either; any other untracked or changed file still is.
    return status.stdout
      .split("\n")
      .filter(line => line.trim() !== "")
      .some(line => !line.trimEnd().endsWith(MARKER) && !(ignoreOwnFiles && line.startsWith("?? ") && looksLikeProtocolFile(line.slice(3).trim())));
  }

  private git(
    cwd: string,
    args: readonly string[],
    prefix: readonly string[] = [],
  ): Promise<ExecResult> {
    return this.runner(GIT, [...prefix, ...args], { cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
  }
}

function firstLine(text: string): string {
  const [line = ""] = text.trim().split("\n");
  return line;
}
