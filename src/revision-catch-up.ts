/**
 * A revision brought up to date with its project's main before its agent starts (stranger 17). A revision builds on the
 * head of the attempt it revises, so once main moved on since that work started, its result could never land
 * (local-landing.ts lands only work whose destination commit is an ancestor of it) and sending it back again changed
 * nothing. So before a revision's first attempt on a new branch, Toolroll merges main's current commit into that head:
 * one merge commit, its first parent the revised head and its second main's commit, the tree `git merge-tree` makes,
 * a fixed Toolroll identity, written as an object only (no checkout, index or ref is touched here). The new branch then
 * starts at it, so the agent works on the combined tree, the checks run on it as usual, and the family's whole change
 * runs from that main commit (task-base.ts familyStartOf, from the branch_base_move row the dispatch records).
 *
 * A merge that conflicts makes nothing: the revision starts from the revised head as before, and the conflict is
 * recorded (with the commit it conflicted with) so landing and the task page stop advising another send back and say
 * how to bring the two together instead. Only for a project that doesn't publish through pull requests: there main's
 * local commits could be ones nobody pushed, and a merge would publish them.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./backend.js";
import type { Store } from "./store.js";
import { recordActionWhole } from "./action-ledger.js";

/** The ledger's record of each catch-up (outcome `merged` or `conflict`): what landing reads back for a conflict. */
export const CATCH_UP_ACTION = "revision brought up to date";

export type CatchUp =
  /** The revised head already has main's commit. */
  | { kind: "current"; main: string }
  /** `commit` merges `main` (main's commit) into the revised head. */
  | { kind: "merged"; commit: string; main: string }
  /** Merging main's commit conflicts in `files` (at most 20). */
  | { kind: "conflict"; main: string; files: string[] }
  /** Git couldn't say (no such branch, an old git without `merge-tree --write-tree`, a SHA-256 repository): nothing made. */
  | { kind: "unavailable" };

const OID = /^[0-9a-f]{40}$/;
/** The fixed identity every catch-up merge carries, as author and committer. */
const IDENTITY = "Toolroll <update@toolroll.invalid>";
const PLAIN_BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

/** The merge commit's bytes: a fixed identity at `time`, the revised head first. */
function mergeBody(tree: string, head: string, main: string, time: number, message: string): string {
  const who = `${IDENTITY} ${time} +0000`;
  return `tree ${tree}\nparent ${head}\nparent ${main}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`;
}
const commitIdOf = (body: string) => createHash("sha1").update(`commit ${Buffer.byteLength(body, "utf8")}\0`).update(body, "utf8").digest("hex");

/**
 * Merge `branch`'s current commit into `head` (a revision's verified start), in `repo`, through `git` (the caller's
 * hardened runner bound to the project). Writes objects only; the caller starts the branch at `commit`.
 */
export async function catchUpRevision(git: Runner, repo: string, head: string, branch: string, taskId: string, now: Date, scratch?: string): Promise<CatchUp> {
  // No replace refs: every object is read as its own id says (a planted refs/replace/* never substitutes content).
  const run = (args: readonly string[]) => git("git", ["--no-replace-objects", ...args], { cwd: repo, timeoutMs: 120_000 });
  if (!OID.test(head) || !PLAIN_BRANCH.test(branch)) return { kind: "unavailable" };
  const read = await run(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
  const main = read.stdout.trim();
  if (read.code !== 0 || !OID.test(main)) return { kind: "unavailable" };
  const contained = await run(["merge-base", "--is-ancestor", main, head]);
  if (contained.code === 0) return { kind: "current", main };
  if (contained.code !== 1) return { kind: "unavailable" };
  // Exit 0: merged cleanly, the tree first; 1: conflicts, the conflicted names after it; anything else: no answer.
  const merged = await run(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", head, main]);
  const [tree = "", ...names] = merged.stdout.split("\0");
  if (merged.code === 1) return { kind: "conflict", main, files: [...new Set(names.filter(one => one !== ""))].slice(0, 20) };
  if (merged.code !== 0 || !OID.test(tree)) return { kind: "unavailable" };
  const message = `Bring ${taskId} up to date with ${branch} (${main.slice(0, 8)})`;
  const body = mergeBody(tree, head, main, Math.floor(now.getTime() / 1000), message);
  // The bytes go through a private temporary file Toolroll writes (outside every checkout), removed after.
  const folder = mkdtempSync(join(scratch ?? tmpdir(), "toolroll-catch-up-"));
  let written: Awaited<ReturnType<Runner>>;
  try {
    const file = join(folder, "commit");
    writeFileSync(file, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    written = await run(["hash-object", "-t", "commit", "-w", "--", file]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
  const commit = written.stdout.trim();
  if (written.code !== 0 || commit !== commitIdOf(body)) return { kind: "unavailable" };
  // Checked back: that tree, the revised head then main's commit.
  const shown = await run(["cat-file", "commit", commit]);
  const header = shown.stdout.split("\n\n")[0] ?? "";
  const parents = header.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice("parent ".length));
  if (shown.code !== 0 || !header.startsWith(`tree ${tree}\n`) || parents.length !== 2 || parents[0] !== head || parents[1] !== main) return { kind: "unavailable" };
  return { kind: "merged", commit, main };
}

/**
 * Main's commit, when `commit` is a Toolroll catch-up merge of exactly `head`: its parents are `head` then a commit the
 * landing `branch` contains, its author and committer the fixed Toolroll identity. Else null. A retry reads it back
 * from a branch whose first attempt never opened (the read-back after its lease couldn't confirm it).
 */
export async function catchUpMergeOf(git: Runner, repo: string, commit: string, head: string, branch: string): Promise<string | null> {
  const run = (args: readonly string[]) => git("git", ["--no-replace-objects", ...args], { cwd: repo, timeoutMs: 120_000 });
  if (!OID.test(commit) || !OID.test(head) || !PLAIN_BRANCH.test(branch)) return null;
  const shown = await run(["cat-file", "commit", commit]);
  if (shown.code !== 0) return null;
  const header = (shown.stdout.split("\n\n")[0] ?? "").split("\n");
  const parents = header.filter(line => line.startsWith("parent ")).map(line => line.slice("parent ".length));
  const who = (field: string) => header.filter(line => line.startsWith(`${field} `)).map(line => line.slice(field.length + 1).replace(/ \d+ [+-]\d{4}$/, ""));
  if (parents.length !== 2 || parents[0] !== head || !OID.test(parents[1]!)) return null;
  if (who("author").join() !== IDENTITY || who("committer").join() !== IDENTITY) return null;
  const onBranch = await run(["merge-base", "--is-ancestor", parents[1]!, `refs/heads/${branch}`]);
  return onBranch.code === 0 ? parents[1]! : null;
}

/** Record a catch-up that merged or conflicted, for the attempt it started, and the attempt's history line. */
export function recordCatchUp(store: Store, at: { repo: string; taskId: string; runId: number; branch: string; head: string; onto: string }, caught: CatchUp, now: Date): void {
  if (caught.kind !== "merged" && caught.kind !== "conflict") return;
  recordActionWhole(store.handle, { at: now.toISOString(), actor: "toolroll", repo: at.repo, taskId: at.taskId, runId: at.runId, action: CATCH_UP_ACTION, outcome: caught.kind, source: "work" },
    { v: 1, branch: at.branch, head: at.head, onto: at.onto, main: caught.main, ...(caught.kind === "merged" ? { commit: caught.commit } : { files: caught.files }) });
  store.addRunNote(at.runId, "Toolroll", caught.kind === "merged"
    ? `Started from the earlier attempt's work with the current ${at.onto} (${caught.main.slice(0, 8)}) merged in, so its checks run on both together.`
    : `The current ${at.onto} (${caught.main.slice(0, 8)}) conflicts with the earlier attempt's work${caught.files.length === 0 ? "" : ` in ${caught.files.length === 1 ? "1 file" : `${caught.files.length} files`}`}, so this attempt starts from that work as it was.`, now);
}

/**
 * The files the newest catch-up of `taskId`'s family (its own or an earlier version's) conflicted in, when that was
 * against exactly `main` (a commit id); else null. Toolroll's own record only: display, never a decision.
 */
export function catchUpConflictOf(store: Store, taskId: string, main: string): string[] | null {
  const chain = store.revisionAncestryStatus(taskId).chain;
  if (chain.length === 0 || !OID.test(main)) return null;
  const row = store.handle.prepare(`SELECT outcome, detail FROM action_ledger WHERE action = ? AND task_id IN (${chain.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`)
    .get(CATCH_UP_ACTION, ...chain);
  if (row === undefined || row["outcome"] !== "conflict") return null;
  try {
    const detail = JSON.parse(String(row["detail"] ?? "null")) as { main?: unknown; files?: unknown } | null;
    if (detail === null || detail.main !== main) return null;
    return Array.isArray(detail.files) ? detail.files.filter((one): one is string => typeof one === "string") : [];
  } catch { return null; }
}
