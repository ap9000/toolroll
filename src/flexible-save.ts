/**
 * Save as branch for interactive agent threads (everyday 9, B1): a thread's committed work put into its project's own
 * repository as the branch `toolroll/code-<thread>`, with no pull request, no task and no merge, so a local project
 * (no remote, no pull requests) can still take a thread's work. The person merges it themselves; the words show the
 * exact `git -C <repo> merge --ff-only toolroll/code-<thread>` (or say their branch moved since the thread started).
 *
 * - The transfer is the controlled import, unchanged (flexible-import.ts importFlexibleCandidate): the thread's
 *   candidate read from its ref as plain bytes, every check (lineage, no merges, limits, and on every commit no
 *   submodule, placeholder, protected name, link out of the project or secret) in a quarantine before any ref moves,
 *   then a create-only import ref and the thread's branch moved by compare-and-swap. No git ever runs in the thread's
 *   folder, and nothing here fetches from it.
 * - A save is recorded as a send of the thread (flexible_ship, the same numbering as Ship's, so a later Ship's import
 *   follows from the branch a save left and a crash mid-import is settled by the same reconciler) whose terms are their
 *   own kind, `flexible-save`: never a Ship's terms, so nothing reads it as a Ship (flexible-ship.ts readRow), it arms
 *   nothing and files no task. It ends `imported` (or `refused`, with the import's reason).
 * - Who: the thread's owner, an active approver of the project with access to it, at the account generation their
 *   session holds, proved by the caller's own `prove` inside the transaction that records the save (the same identity
 *   End and remove take: the person's session, or a solo install's operator). No password: saving grants nothing (no
 *   merge, no check, no access); the person's own git merge is what lands it. Allowed after End, and while interactive
 *   agent threads are off (recovering past work, as the import itself is). Never while the agent is on a turn.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { flexibleStanding } from "./flexible.js";
import { flexibleImportRef, importFlexibleCandidate, projectMergeHint, projectThreadBranch, readFlexibleCandidate, type FlexibleImportRefusal } from "./flexible-import.js";
import { branchHeld, nextSeq, turnRunning } from "./flexible-ship.js";
import { flexibleThread, flexibleThreadBranch, withFlexibleThreadLock } from "./flexible-thread.js";
import { machineActing } from "./scope.js";
import type { Store } from "./store.js";
import type { Runner } from "./worktree.js";
import { gitCommand, UNSAFE_FOLDER } from "./local-landing.js";

export type FlexibleSaveTerms = {
  kind: "flexible-save"; version: 1; thread: string; repo: string; owner: string; ownerGeneration: number; seq: number;
  base: string; candidate: string; branch: string; importRef: string; changedPaths: string[];
};

export type FlexibleSaveReason = "machine-proof" | "thread-unknown" | "not-owner" | "not-an-approver" | "stale-generation" | "thread-running" | "thread-removed" | "changed"
  | "branch-gone" | "branch-moved";
export type FlexibleSaveRefusal = { ok: false; reason: FlexibleSaveReason; message: string };
export type FlexibleSaved = { ok: true; already: boolean; branch: string; candidate: string; seq: number | null; changedPaths: string[];
  /** The command a person copies to put it on their checked-out branch, or why there isn't one. */
  next: string;
  /** That command alone, exactly as `next` shows it; null when none could be written (no project folder to name, or a
   * folder name no command can carry safely). */
  command: string | null };

const WORDS: Readonly<Record<FlexibleSaveReason, string>> = Object.freeze({
  "machine-proof": "Only a person can save a thread's work. Nothing was saved.",
  "thread-unknown": "There's no such thread.",
  "not-owner": "Only the person who started this thread can save its work. Nothing was saved.",
  "not-an-approver": "Only an approver for this project can save a thread's work. Nothing was saved.",
  "stale-generation": "Your account changed since you signed in. Sign in again and retry. Nothing was saved.",
  "thread-running": "The agent is still working on your last message. Wait for it, or stop its turn, then save. Nothing was saved.",
  "thread-removed": "This thread's working copy was removed, so there's nothing left to save.",
  "changed": "The thread changed while it was being saved. Try again. Nothing was saved.",
  "branch-gone": "Toolroll saved this work before, but its branch was deleted from your repository since. Toolroll doesn't make it again by itself. Nothing was changed.",
  "branch-moved": "This thread's branch in your repository was changed by someone else since Toolroll saved it. Toolroll won't overwrite it. Nothing was changed.",
});
const refuse = (reason: FlexibleSaveReason): FlexibleSaveRefusal => ({ ok: false, reason, message: WORDS[reason] });

export const flexibleSaveDigestOf = (terms: FlexibleSaveTerms): string =>
  createHash("sha256").update(`standing-orders:flexible-save:${canonicalJson(terms)}`, "utf8").digest("hex").slice(0, 32);


/** Who may save, from Toolroll's records, read inside the caller's transaction. */
function saverStanding(store: Store, thread: { createdBy: string; repo: string }, by: { name: string; generation: number }): FlexibleSaveRefusal | null {
  if (thread.createdBy !== by.name) return refuse("not-owner");
  const account = store.accountOf(by.name);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(by.name, thread.repo)) return refuse("not-an-approver");
  if (account.generation !== by.generation) return refuse("stale-generation");
  return null;
}

/** The words after a save: the exact merge to run, or why a fast-forward won't do. The command is Land's own (local-landing.ts
 * gitCommand): the recorded folder single-quoted, and none at all when its name holds a control, bidi or zero-width
 * character (never a cleaned-up name that would be a different folder): then plain words say what to run there. */
async function nextWords(store: Store, thread: string, candidate: string, branch: string, runner?: Runner): Promise<{ next: string; command: string | null }> {
  const hint = await projectMergeHint(store, { thread, candidate, ...(runner === undefined ? {} : { runner }) });
  if (hint === null) return { next: `To use it: merge ${branch} in your repository.`, command: null };
  const ff = gitCommand(hint.repo, ["merge", "--ff-only", branch]), merge = gitCommand(hint.repo, ["merge", branch]);
  if (hint.branch === null) return { next: `To use it: check out the branch you want it on, then ${ff === null ? UNSAFE_FOLDER(`git merge --ff-only ${branch}`) : `run \`${ff}\`.`}`, command: ff };
  // Already merged into the checked-out branch (everyday-9 E5): nothing to bring in, and no command to run.
  if (hint.contained) return { next: `It's already in ${hint.branch}: nothing to merge.`, command: null };
  if (hint.fastForward) return { next: ff === null ? `To put it on ${hint.branch}: ${UNSAFE_FOLDER(`git merge --ff-only ${branch}`)}` : `To put it on ${hint.branch}: \`${ff}\`.`, command: ff };
  return { next: `${hint.branch} moved since the thread started, so it won't fast-forward. ${merge === null ? UNSAFE_FOLDER(`git merge ${branch}`) : `To merge it: \`${merge}\`.`}`, command: merge };
}

/**
 * Save the thread's committed work as `toolroll/code-<thread>` in its project. `prove` is the caller's own proof of the
 * person (their session still held, or the solo operator), asked again inside the transaction that records the save.
 * Saving the same commit again changes nothing and says so.
 */
export async function saveFlexibleBranch(store: Store, input: { thread: string; by: { name: string; generation: number }; now: Date; prove: () => boolean; runner?: Runner }):
  Promise<FlexibleSaved | FlexibleSaveRefusal | FlexibleImportRefusal> {
  if (machineActing()) return refuse("machine-proof");
  const first = flexibleThread(store, input.thread);
  if (first === null) return refuse("thread-unknown");
  const early = saverStanding(store, first, input.by);
  if (early !== null) return early;
  if (first.state !== "ready") return refuse("thread-removed");
  const runner = input.runner === undefined ? {} : { runner: input.runner };
  const locked = await withFlexibleThreadLock(input.thread, async (): Promise<FlexibleSaved | FlexibleSaveRefusal | FlexibleImportRefusal> => {
    if (turnRunning(store, input.thread)) return refuse("thread-running");
    const read = await readFlexibleCandidate(store, { thread: input.thread, ...runner });
    if (!read.ok) return read;
    const branch = flexibleThreadBranch(input.thread);
    const held = branchHeld(store, input.thread);
    if (held === read.candidate) {
      // What the repository really holds, not only what Toolroll recorded (round 1, finding 2): a deleted or moved branch
      // is said, never reported as saved, and never overwritten.
      const actual = await projectThreadBranch(store, { thread: input.thread, ...runner });
      if (actual === null) return refuse("branch-gone");
      if (actual !== read.candidate) return refuse("branch-moved");
      return { ok: true, already: true, branch, candidate: read.candidate, seq: null, changedPaths: read.changedPaths, ...(await nextWords(store, input.thread, read.candidate, branch, input.runner)) };
    }
    const at = input.now.toISOString();
    // The save recorded first (check and write together), so a crash mid-import is settled like a Ship's.
    const recorded = store.transact((): FlexibleSaveRefusal | { seq: number; digest: string } => {
      const thread = flexibleThread(store, input.thread);
      if (thread === null) return refuse("thread-unknown");
      if (thread.state !== "ready") return refuse("thread-removed");
      const standing = saverStanding(store, thread, input.by);
      if (standing !== null) return standing;
      if (!input.prove()) return refuse("stale-generation");
      if (branchHeld(store, thread.id) !== held) return refuse("changed");
      const seq = nextSeq(store, thread.id);
      const terms: FlexibleSaveTerms = { kind: "flexible-save", version: 1, thread: thread.id, repo: thread.repo, owner: input.by.name, ownerGeneration: input.by.generation, seq,
        base: read.base, candidate: read.candidate, branch, importRef: flexibleImportRef(thread.id, seq), changedPaths: read.changedPaths };
      const digest = flexibleSaveDigestOf(terms);
      const live = flexibleStanding(store, thread.repo);
      store.handle.prepare(`INSERT INTO flexible_ship (id, thread, seq, repo, base_sha, candidate, import_ref, branch, branch_before, terms_json, digest, summary_key, approved_by, approved_generation, proof, approved_at, delegation_id, state, state_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'session', ?, ?, 'approved', ?)`).run(digest, thread.id, seq, thread.repo, terms.base, terms.candidate, terms.importRef, branch, held,
        canonicalJson(terms), digest, digest, input.by.name, input.by.generation, at, live.state === "on" ? live.id : 0, at);
      store.recordAction({ at, actor: input.by.name, repo: thread.repo, taskId: null, runId: null, source: "work", action: "flexible branch saved", outcome: "flexible-save",
        detail: `thread ${thread.id} · save ${seq} · candidate ${read.candidate} · ${branch}` });
      return { seq, digest };
    });
    if ("ok" in recorded) return recorded;
    const imported = await importFlexibleCandidate(store, { thread: input.thread, seq: recorded.seq, expected: read.candidate, branchBefore: held, by: input.by.name, now: input.now, ...runner });
    if (!imported.ok) {
      store.transact(() => {
        store.handle.prepare("UPDATE flexible_ship SET state = 'refused', reason = ?, detail = ?, state_at = ? WHERE id = ? AND state = 'approved'")
          .run("check" in imported ? imported.check : imported.reason, imported.message.slice(0, 2000), at, recorded.digest);
      });
      return imported;
    }
    store.transact(() => { store.handle.prepare("UPDATE flexible_ship SET state = 'imported', state_at = ? WHERE id = ? AND state = 'approved'").run(at, recorded.digest); });
    return { ok: true, already: false, branch, candidate: read.candidate, seq: recorded.seq, changedPaths: read.changedPaths, ...(await nextWords(store, input.thread, read.candidate, branch, input.runner)) };
  });
  if (locked.ok === false && (locked.reason === "not-available" || locked.reason === "thread-unknown")) return refuse("thread-unknown");
  return locked as FlexibleSaved | FlexibleSaveRefusal | FlexibleImportRefusal;
}

/** Whether a send of a thread (a flexible_ship row's terms) is a save, read from its own canonical terms. */
export function isFlexibleSave(termsJson: unknown): boolean {
  try { return (JSON.parse(String(termsJson)) as { kind?: unknown }).kind === "flexible-save"; } catch { return false; }
}

/** The thread's newest standing save (its branch still where the save left it, as far as Toolroll's records say), or null. */
export function latestFlexibleSave(store: Store, thread: string): { seq: number; candidate: string; at: string } | null {
  const rows = store.handle.prepare("SELECT seq, candidate, terms_json, state_at FROM flexible_ship WHERE thread = ? AND state = 'imported' AND task_id IS NULL ORDER BY seq DESC").all(thread);
  const newest = rows[0];
  if (newest === undefined || !isFlexibleSave(newest["terms_json"])) return null;
  return { seq: Number(newest["seq"]), candidate: String(newest["candidate"]), at: String(newest["state_at"]) };
}
