/**
 * Ship for Flexible threads, slice F4 (the Flexible plan v2 §7 with the owner's round-2 decision D3', §1's controlled
 * import and Codex round 2's required changes 5–7, binding): how a thread's committed work becomes a checked, merged
 * result, in ONE press.
 *
 * - **Ship** (`flexible-ship`, an approval kind of its own, never a build or release approval) is the person's yes to
 *   exact terms (flexibleShipTerms): the candidate commit and its base, the changed files, the title, goal and what
 *   done means, the project's check command, that Toolroll merges by itself only once that check passes on this exact
 *   commit, that further code changes need a new Ship, and, before consent, that the thread could read the repository's
 *   history beyond its base. They hash to `digest`, and the approval summary's key (approval-summary.ts shipSummaryOf)
 *   binds every row shown; the press carries both back, or it is stale and refused. It takes the same step-up as any
 *   ordinary approval (a person's password, a remembered sign-in where the rules allow, or the person's own session
 *   where it stands in, as when working alone); a machine never ships. Then, in order: the yes is recorded (one
 *   transaction re-reading the person's standing, the thread's owner and generation, the project's Flexible terms and
 *   two-person rules); the controlled import runs (flexible-import.ts: every check, on every commit, in quarantine before
 *   any ref moves); and, in ONE transaction, the verify-only task is filed, its scope proposed with the imported
 *   candidate and sealed through the ordinary approve() authority checks, and the merge ARMED, bound to the candidate,
 *   the person's account generation and the sealed terms. A refusal there files nothing and leaves an imported branch
 *   with no task (shown, removable; the next Ship is n+1).
 * - **The armed merge** (mergeArmedFlexible, run by the watch loop's pass, flexibleArmedPass) re-proves everything each
 *   time immediately before acting: the person still an approver of the project at the generation they shipped with,
 *   the project's Flexible terms live, the task's sealed scope unchanged, the base still under the branch it merges
 *   into. Once the newest result is exactly the candidate's files and the required check passed on its exact commit, it
 *   completes that result and owes its pull request (bound to that head); then it merges that head (pull-request-flow.ts
 *   mergePullRequest, through the shared guard). A failed or missing check never merges; there is no bypass. A changed
 *   head, a base moved out from under it, a revocation or the person's cancel ends it for good: nothing is re-armed.
 * - **Send back** reopens the thread: the send ends (its armed merge with it) and the feedback is handed back as the
 *   thread's next message. **Cancel** ends an armed merge without feedback.
 * - A Ship whose import a crash interrupted is settled by reconcileFlexibleShips (refs put back by compare-and-swap,
 *   the send failed and shippable again).
 *
 * The ledger records the press ("flexible ship approved"), the arming, the completion and the merge ("flexible
 * merged") apart. Nothing here works while FLEXIBLE_AVAILABLE is false. The only caller outside the engine is the watch
 * loop's pass (operate.ts), which refuses at once while it is false; no route, CLI, MCP tool or chat action reaches it.
 *
 * Not createCodingHandoff (coding-handoff.ts): that hand-off needs an installation operator and a desktop coding
 * session in the coding catalog, and proves a worktree sharing the project's git directory, none of which a thread has
 * (Codex round 2, required change 7). fileAndSeal below files the same verify-only task (its scope's prepared candidate,
 * planning skipped, the same out-of-scope words) from the import instead, and seals it in the same transaction.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { FLEXIBLE_UNAVAILABLE, flexibleNetworkOf, flexibleStanding, flexibleTwoPerson, type FlexibleNetwork } from "./flexible.js";
import { flexibleThread, flexibleThreadBranch, withFlexibleThreadLock, type FlexibleThreadRow } from "./flexible-thread.js";
import { flexibleImportRef, flexibleTaskBranch, importFlexibleCandidate, readFlexibleCandidate, removeFlexibleImportRefs, settleInterruptedImport, type FlexibleImportRefusal } from "./flexible-import.js";
import { unsettledLaunch } from "./flexible-launch.js";
import { shipSummaryOf, type ApprovalSummary, type SummaryNote, type SummaryRow } from "./approval-summary.js";
import { canonicalJson } from "./canonical-json.js";
import { approvalOf, approve, authenticateApprover, machineActing, parseAcceptanceCriteria, proposeGuarded, type AcceptanceCriterion } from "./scope.js";
import { personProof } from "./person-proof.js";
import { fileTaskProposal } from "./proposal.js";
import { validateTaskText } from "./task-text.js";
import { taskBranch } from "./names.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentOf } from "./assignment.js";
import { completeAndOpenPullRequest, mergePullRequest } from "./pull-request-flow.js";
import type { PublishExec } from "./publish.js";
import { fullCheckGate } from "./result-follow-ups.js";
import { runCheckLevel } from "./check-levels.js";
import { FLEXIBLE_FILED_PREFIX } from "./flexible-merge-guard.js";
import { run } from "./exec.js";
import { hardenedGit } from "./teardown-git.js";
import type { Store } from "./store.js";
import type { Runner } from "./worktree.js";

// ---- the terms --------------------------------------------------------------------------------------------------------

export const FLEXIBLE_SHIP_VERSION = 1;
/** What a Ship's check task may do: verify the imported candidate, nothing more. */
export const SHIP_OUT_OF_SCOPE = "Verify the imported candidate only. Further code changes need a new Ship.";
/** The disclosure Codex round 2 (item 6) requires before consent: a thread reads the project's real objects folder. */
export const HISTORY_WORDS = "This thread could read your repository's full history, not just the commit it started from: it reads your repository's stored objects, read-only.";
const OPEN_HISTORY_WORDS = "This project's network is open, so the thread could have sent what it read, that history included, to any website.";
export const MERGE_WORDS = "Toolroll merges it by itself once the project's checks pass on this exact commit. A failed or missing check never merges it. A change to the result, your cancel, or your access changing stops the merge.";
const DEFAULT_TITLE = "Changes from a Flexible thread";
const DEFAULT_GOAL = "Ship the thread's committed changes once the project's checks pass on them.";
const DEFAULT_ACCEPTANCE: readonly AcceptanceCriterion[] = Object.freeze([{ id: "c1", statement: "The project's checks pass on this exact commit.", how: null, evidence: ["check"] }]) as readonly AcceptanceCriterion[];

export type FlexibleShipTerms = {
  kind: "flexible-ship";
  version: 1;
  thread: string;
  repo: string;
  /** The thread's owner, at the account generation the terms were made for. */
  owner: string;
  ownerGeneration: number;
  /** This Ship's number: 1 for the thread's first, then n+1. */
  seq: number;
  base: string;
  candidate: string;
  /** The thread's branch in the project's repository, and this Ship's import ref. */
  branch: string;
  importRef: string;
  changedPaths: string[];
  title: string;
  goal: string;
  acceptance: AcceptanceCriterion[];
  outOfScope: string;
  /** The project's check command, as approved (its digest), run on the exact commit with no way to skip it. */
  check: { command: string; digest: string };
  /** The press is the merge's authority: Toolroll merges only once that check passes on the exact candidate. */
  merge: "when-checks-pass";
  network: FlexibleNetwork;
  /** The disclosure is a term: the thread could read history beyond its base. */
  history: "beyond-base";
};

export const flexibleShipDigestOf = (terms: FlexibleShipTerms): string =>
  createHash("sha256").update(`standing-orders:flexible-ship:${canonicalJson(terms)}`, "utf8").digest("hex").slice(0, 32);
/** The verify-only task a Ship files, and its provenance: both derived from the Ship's digest, so neither can name
 * another Ship. */
export const flexibleShipTaskId = (digest: string): string => `flexible-${digest}`;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The sheet's rows and warnings, and the key over them (approval-summary.ts shipSummaryOf). */
export function flexibleShipSummary(terms: FlexibleShipTerms, digest: string): ApprovalSummary {
  const shown = terms.changedPaths.slice(0, 50);
  const decisions: SummaryRow[] = [
    { label: "Task", words: terms.title, fields: ["ship.title"] },
    { label: "Ships", words: `${plural(terms.changedPaths.length, "changed file")} from this thread, as commit ${terms.candidate.slice(0, 12)}`,
      lines: terms.changedPaths.length > shown.length ? [...shown, `and ${terms.changedPaths.length - shown.length} more`] : shown, fields: ["ship.candidate", "ship.changedPaths"] },
    { label: "Starts from", words: `commit ${terms.base.slice(0, 12)}, where the thread started`, fields: ["ship.base"] },
    { label: "Goal", words: terms.goal, fields: ["goal"] },
    { label: "Done when", words: terms.acceptance.map(one => one.statement).join(" "), fields: ["acceptance"] },
    { label: "Checks", words: `${terms.check.command} runs on this exact commit. It can't be skipped.`, fields: ["ship.check"] },
    { label: "Merges", words: MERGE_WORDS, fields: ["ship.merge"] },
    { label: "Further changes", words: "Need a new Ship.", fields: ["outOfScope"] },
  ];
  const warnings: SummaryNote[] = [{ words: HISTORY_WORDS, fields: ["ship.history"] },
    ...(terms.network === "open" ? [{ words: OPEN_HISTORY_WORDS, fields: ["ship.network"] as SummaryNote["fields"] }] : [])];
  return shipSummaryOf(digest, decisions, warnings);
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type FlexibleShipReason = "not-available" | "thread-unknown" | "not-owner" | "not-an-approver" | "stale-generation" | "two-person" | "not-flexible"
  | "no-check" | "thread-running" | "invalid-request" | "changed" | "machine-proof" | "proof-refused" | "handoff-failed" | "approval-refused"
  | "not-found" | "wrong-state" | "cancelled";
export type FlexibleShipRefusal = { ok: false; reason: FlexibleShipReason; message: string };

const WORDS: Readonly<Record<FlexibleShipReason, string>> = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "thread-unknown": "There's no such thread.",
  "not-owner": "Only the person who started this thread can do that. Nothing changed.",
  "not-an-approver": "Only an approver for this project can do that. Nothing changed.",
  "stale-generation": "Your account changed since this started. Sign in again and retry. Nothing changed.",
  "two-person": "This project needs two people to approve work, so a Flexible thread can't ship from it. Nothing changed.",
  "not-flexible": "This project's Flexible terms don't count right now, so nothing was shipped.",
  "no-check": "This project has no check command, and a Flexible thread's work ships only after its checks pass. Set one in the project's settings first. Nothing changed.",
  "thread-running": "The thread's agent is still working. Stop it, then ship. Nothing changed.",
  "invalid-request": "The title, goal or what done means isn't valid. Nothing changed.",
  "changed": "These terms changed since they were shown, or were already used. Read them again first. Nothing changed.",
  "machine-proof": "Only a person can ship a thread's work. Nothing changed.",
  "proof-refused": "That didn't prove it's you, or you can't approve work in this project. Nothing changed.",
  "handoff-failed": "The changes were imported, but their check task couldn't be made. The import is kept: ship again, or remove it.",
  "approval-refused": "The changes were imported, but their check task couldn't be approved. The import is kept: ship again, or remove it.",
  "not-found": "There's no such Ship.",
  "wrong-state": "This Ship can't do that now.",
  "cancelled": "The merge was stopped for good.",
});
const refuse = (reason: FlexibleShipReason, detail?: string): FlexibleShipRefusal =>
  ({ ok: false, reason, message: detail === undefined ? WORDS[reason] : `${WORDS[reason]} (${detail})` });

// ---- authority --------------------------------------------------------------------------------------------------------

/** The thread's owner acting now, from Toolroll's records: an active approver of the project, the thread's owner, the
 * project not two-person, its Flexible terms live. Their current generation, or why not. Read inside the caller's
 * transaction. */
function ownerStanding(store: Store, thread: FlexibleThreadRow, by: string): { generation: number } | FlexibleShipRefusal {
  if (thread.createdBy !== by) return refuse("not-owner");
  const account = store.accountOf(by);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(by, thread.repo)) return refuse("not-an-approver");
  if (flexibleTwoPerson(store, thread.repo)) return refuse("two-person");
  const standing = flexibleStanding(store, thread.repo);
  if (standing.state !== "on") return refuse("not-flexible", standing.state);
  return { generation: account.generation };
}

/** The person, proved as an ordinary approval proves them (scope.ts authenticateApprover: a password, a remembered
 * sign-in, or their own live session where it stands in); a machine's credential, or a machine acting, never. */
function personNow(store: Store, by: string, token: string, repo: string): FlexibleShipRefusal | { method: string } {
  if (machineActing()) return refuse("machine-proof");
  const proved = authenticateApprover(store, by, token, repo);
  if (!proved.ok) return refuse("proof-refused");
  if (!personProof(proved.method)) return refuse("machine-proof");
  return { method: proved.method };
}

const turnRunning = (store: Store, thread: string): boolean =>
  store.handle.prepare("SELECT 1 FROM thread_turn WHERE thread = ? AND status IN ('admitted', 'running')").get(thread) !== undefined;

/** What the thread's branch in the project's repository holds after the Ships so far: the latest import that wrote it
 * and still stands (a removed or interrupted one put back what it found), or null when none did. */
function branchHeld(store: Store, thread: string): string | null {
  const row = store.handle.prepare("SELECT candidate FROM flexible_ship WHERE thread = ? AND state IN ('imported', 'armed', 'completed', 'merged', 'cancelled', 'sent-back') ORDER BY seq DESC LIMIT 1").get(thread);
  return row === undefined ? null : String(row["candidate"]);
}
const nextSeq = (store: Store, thread: string): number => Number(store.handle.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM flexible_ship WHERE thread = ?").get(thread)!["n"]);

// ---- the terms, and the one press -------------------------------------------------------------------------------------

export type FlexibleShipText = { title?: string; goal?: string; acceptance?: unknown };

/**
 * The exact terms a Ship would sign now, from Toolroll's records and the thread's committed branch (read in a
 * quarantine, flexible-import.ts readFlexibleCandidate: nothing of the thread's runs), with their digest and the
 * approval summary the sheet shows. Only the thread's owner, an approver of a Flexible project with a check command.
 */
export async function flexibleShipTerms(store: Store, input: { thread: string; by: string; text?: FlexibleShipText; runner?: Runner }):
  Promise<{ ok: true; terms: FlexibleShipTerms; digest: string; summary: ApprovalSummary } | FlexibleShipRefusal | FlexibleImportRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const thread = flexibleThread(store, input.thread);
  if (thread === null) return refuse("thread-unknown");
  const standing = ownerStanding(store, thread, input.by);
  if ("ok" in standing) return standing;
  const check = store.liveVerifyCommand(thread.repo);
  if (check === null) return refuse("no-check");
  const title = (input.text?.title ?? DEFAULT_TITLE).trim(), goal = (input.text?.goal ?? DEFAULT_GOAL).trim();
  if (validateTaskText({ title, goal }) !== null || goal === "") return refuse("invalid-request");
  const parsed = parseAcceptanceCriteria(input.text?.acceptance ?? DEFAULT_ACCEPTANCE);
  if (parsed.problems.length > 0 || parsed.criteria.length === 0) return refuse("invalid-request");
  const read = await readFlexibleCandidate(store, { thread: thread.id, ...(input.runner === undefined ? {} : { runner: input.runner }) });
  if (!read.ok) return read;
  const seq = nextSeq(store, thread.id);
  const terms: FlexibleShipTerms = {
    kind: "flexible-ship", version: FLEXIBLE_SHIP_VERSION, thread: thread.id, repo: thread.repo, owner: input.by, ownerGeneration: standing.generation, seq,
    base: read.base, candidate: read.candidate, branch: flexibleThreadBranch(thread.id), importRef: flexibleImportRef(thread.id, seq), changedPaths: read.changedPaths,
    title, goal, acceptance: parsed.criteria, outOfScope: SHIP_OUT_OF_SCOPE, check: { command: check.command, digest: check.digest }, merge: "when-checks-pass",
    network: flexibleNetworkOf(store, thread.repo), history: "beyond-base",
  };
  const digest = flexibleShipDigestOf(terms);
  return { ok: true, terms, digest, summary: flexibleShipSummary(terms, digest) };
}

export type FlexibleShipped = { ok: true; ship: string; seq: number; taskId: string; scopeDigest: string; importRef: string; refsChanged: string[] | null };

/**
 * Ship: the person's yes to exactly the terms shown (`shownDigest` and the summary's `shownKey`), proved as an ordinary
 * approval proves them; then the controlled import; then the verify-only task filed and sealed and the merge armed. See
 * the module comment.
 */
export async function shipFlexible(store: Store, input: { thread: string; by: string; token: string; shownDigest: string; shownKey: string; text?: FlexibleShipText; now: Date; runner?: Runner }):
  Promise<FlexibleShipped | FlexibleShipRefusal | FlexibleImportRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const first = flexibleThread(store, input.thread);
  if (first === null) return refuse("thread-unknown");
  const proved = personNow(store, input.by, input.token, first.repo);
  if ("ok" in proved) return proved;
  const locked = await withFlexibleThreadLock(input.thread, () => shipLocked(store, input, proved.method));
  if (locked.ok === false && (locked.reason === "not-available" || locked.reason === "thread-unknown")) return refuse(locked.reason);
  return locked as FlexibleShipped | FlexibleShipRefusal | FlexibleImportRefusal;
}

/** A refusal raised inside a transaction to roll it back whole. */
class ShipStop extends Error { constructor(readonly refusal: FlexibleShipRefusal) { super(refusal.message); } }

async function shipLocked(store: Store, input: { thread: string; by: string; token: string; shownDigest: string; shownKey: string; text?: FlexibleShipText; now: Date; runner?: Runner },
  method: string): Promise<FlexibleShipped | FlexibleShipRefusal | FlexibleImportRefusal> {
  if (turnRunning(store, input.thread) || unsettledLaunch(store, input.thread) !== null) return refuse("thread-running");
  // The terms again, from the records and the thread's branch as they are now: anything different is a stale press.
  const shown = await flexibleShipTerms(store, { thread: input.thread, by: input.by, ...(input.text === undefined ? {} : { text: input.text }), ...(input.runner === undefined ? {} : { runner: input.runner }) });
  if (!shown.ok) return shown;
  if (shown.digest !== input.shownDigest || shown.summary.key !== input.shownKey) return refuse("changed");
  const { terms, digest } = shown;
  const now = input.now.toISOString();
  // The yes, recorded with the authority re-read in the same transaction (check and write together). The Ship's id is
  // its digest: a second press of the same terms is refused, never a second Ship.
  const recorded = store.transact((): FlexibleShipRefusal | { branchBefore: string | null } => {
    const thread = flexibleThread(store, input.thread);
    if (thread === null || thread.state !== "ready") return refuse("thread-unknown");
    const standing = ownerStanding(store, thread, input.by);
    if ("ok" in standing) return standing;
    if (standing.generation !== terms.ownerGeneration) return refuse("stale-generation");
    if (nextSeq(store, thread.id) !== terms.seq || store.handle.prepare("SELECT 1 FROM flexible_ship WHERE id = ?").get(digest) !== undefined) return refuse("changed");
    const branchBefore = branchHeld(store, thread.id);
    store.handle.prepare(`INSERT INTO flexible_ship (id, thread, seq, repo, base_sha, candidate, import_ref, branch, branch_before, terms_json, digest, summary_key, approved_by, approved_generation, proof, approved_at, state, state_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`).run(digest, thread.id, terms.seq, thread.repo, terms.base, terms.candidate, terms.importRef, terms.branch, branchBefore,
      canonicalJson(terms), digest, shown.summary.key, input.by, standing.generation, method, now, now);
    store.recordAction({ at: now, actor: input.by, repo: thread.repo, taskId: null, runId: null, source: "work", action: "flexible ship approved", outcome: "flexible-ship",
      detail: `thread ${thread.id} · ship ${terms.seq} · terms ${digest} · candidate ${terms.candidate} · ${method} · generation ${standing.generation}` });
    return { branchBefore };
  });
  if ("ok" in recorded) return recorded;
  const imported = await importFlexibleCandidate(store, { thread: input.thread, seq: terms.seq, expected: terms.candidate, branchBefore: recorded.branchBefore, by: input.by, now: input.now,
    ...(input.runner === undefined ? {} : { runner: input.runner }) });
  if (!imported.ok) {
    store.transact(() => {
      store.handle.prepare("UPDATE flexible_ship SET state = 'refused', reason = ?, detail = ?, state_at = ? WHERE id = ? AND state = 'approved'")
        .run("check" in imported ? imported.check : imported.reason, imported.message.slice(0, 2000), now, digest);
      store.recordAction({ at: now, actor: input.by, repo: terms.repo, taskId: null, runId: null, source: "work", action: "flexible ship refused", outcome: "check" in imported ? imported.check : imported.reason,
        detail: `thread ${terms.thread} · ship ${terms.seq} · ${imported.message}`.slice(0, 2000) });
    });
    return imported;
  }
  store.transact(() => { store.handle.prepare("UPDATE flexible_ship SET state = 'imported', state_at = ? WHERE id = ? AND state = 'approved'").run(now, digest); });
  return fileAndSeal(store, { terms, digest, by: input.by, token: input.token, now: input.now, refsChanged: imported.refsChanged, ...(input.runner === undefined ? {} : { runner: input.runner }) });
}

/** The verify-only task for an import: its branch made at the thread's base, then (one transaction) the task filed, its
 * scope proposed with the imported candidate, sealed through approve(), and the merge armed. A refusal anywhere files
 * nothing, takes the branch back, and leaves the import with no task (shown, shippable again, removable). */
async function fileAndSeal(store: Store, input: { terms: FlexibleShipTerms; digest: string; by: string; token: string; now: Date; refsChanged: string[] | null; runner?: Runner }):
  Promise<FlexibleShipped | FlexibleShipRefusal> {
  const { terms, digest } = input;
  const taskId = flexibleShipTaskId(digest);
  const branch = taskBranch(taskId);
  const runner = input.runner === undefined ? {} : { runner: input.runner };
  const kept = (refusal: FlexibleShipRefusal): FlexibleShipRefusal => {
    store.transact(() => { store.handle.prepare("UPDATE flexible_ship SET detail = ?, state_at = ? WHERE id = ? AND state = 'imported'").run(refusal.message.slice(0, 2000), input.now.toISOString(), digest); });
    return refusal;
  };
  if (store.lookupRef(taskId) !== null) return kept(refuse("handoff-failed", "its task already exists"));
  if (!await flexibleTaskBranch(store, { thread: terms.thread, branch, at: terms.base, make: true, ...runner })) return kept(refuse("handoff-failed", "its task's branch couldn't be made"));
  try {
    return store.transact(() => {
      const row = store.handle.prepare("SELECT state FROM flexible_ship WHERE id = ?").get(digest);
      if (row?.["state"] !== "imported") throw new ShipStop(refuse("wrong-state"));
      const made = fileTaskProposal(store, { id: taskId, title: terms.title, repo: terms.repo, goal: terms.goal, outOfScope: terms.outOfScope, acceptance: terms.acceptance,
        filedVia: `${FLEXIBLE_FILED_PREFIX}${digest}`, filedBy: { name: input.by, kind: "person" as const }, planning: "skip", admittedRepos: [terms.repo] }, input.now);
      if (!made.ok) throw new ShipStop(refuse("handoff-failed", made.message));
      const ref = store.lookupRef(made.id)!;
      const proposed = proposeGuarded(store, { taskId: made.id, author: input.by, taskRef: ref.id, sawDigest: store.getScope(made.id)!.digest, goal: terms.goal, outOfScope: terms.outOfScope,
        acceptance: terms.acceptance, candidate: terms.candidate, now: input.now });
      if (!proposed.ok) throw new ShipStop(refuse("handoff-failed", proposed.message || "its scope couldn't be saved"));
      // The ordinary authority checks, in this same transaction: approver standing and access, org policy, protected
      // paths and two-person rules, release and CI holds, the digest seen. A refusal rolls the filing back whole.
      const yes = approve(store, made.id, input.by, input.now, proposed.scope.digest, input.token);
      if (!yes.ok) throw new ShipStop(refuse("approval-refused", "message" in yes && typeof yes.message === "string" ? yes.message : yes.reason));
      const sealed = store.getScope(made.id)!;
      if (!approvalOf(sealed).approved || sealed.candidate !== terms.candidate) throw new ShipStop(refuse("approval-refused", "its seal didn't hold"));
      // Armed: the merge's authority is this press, bound to the candidate, the person's generation (on the row since the
      // yes) and the sealed scope's digest.
      const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'armed', task_id = ?, scope_digest = ?, detail = NULL, state_at = ? WHERE id = ? AND state = 'imported'")
        .run(made.id, sealed.digest, input.now.toISOString(), digest);
      if (Number(moved.changes) !== 1) throw new ShipStop(refuse("wrong-state"));
      store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: terms.repo, taskId: made.id, runId: null, source: "work", action: "flexible ship armed", outcome: "flexible-ship",
        detail: `thread ${terms.thread} · ship ${terms.seq} · terms ${digest} · scope ${sealed.digest} · candidate ${terms.candidate}` });
      return { ok: true as const, ship: digest, seq: terms.seq, taskId: made.id, scopeDigest: sealed.digest, importRef: terms.importRef, refsChanged: input.refsChanged };
    });
  } catch (error) {
    await flexibleTaskBranch(store, { thread: terms.thread, branch, at: terms.base, make: false, ...runner });
    if (error instanceof ShipStop) return kept(error.refusal);
    return kept(refuse("handoff-failed", error instanceof Error ? error.message.slice(0, 300) : undefined));
  }
}

// ---- reading a Ship ---------------------------------------------------------------------------------------------------

export type FlexibleShipRow = { id: string; thread: string; seq: number; repo: string; base: string; candidate: string; importRef: string; branch: string; branchBefore: string | null;
  terms: FlexibleShipTerms; approvedBy: string; approvedGeneration: number; state: string; reason: string | null; detail: string | null; taskId: string | null; scopeDigest: string | null;
  feedback: string | null; mergeHead: string | null; stateAt: string };

/** A Ship, read exactly: its terms canonical and hashing to its digest, which is its id; its fixed columns the terms'
 * own. Null for anything else (never a guess). */
function readRow(row: Record<string, unknown> | undefined): FlexibleShipRow | null {
  if (row === undefined) return null;
  let terms: FlexibleShipTerms;
  try { terms = JSON.parse(String(row["terms_json"])) as FlexibleShipTerms; } catch { return null; }
  if (canonicalJson(terms) !== row["terms_json"] || flexibleShipDigestOf(terms) !== row["digest"] || row["id"] !== row["digest"] || terms.kind !== "flexible-ship" || terms.version !== FLEXIBLE_SHIP_VERSION) return null;
  if (terms.thread !== row["thread"] || terms.seq !== row["seq"] || terms.repo !== row["repo"] || terms.base !== row["base_sha"] || terms.candidate !== row["candidate"] || terms.importRef !== row["import_ref"] || terms.branch !== row["branch"]) return null;
  if (terms.owner !== row["approved_by"] || terms.ownerGeneration !== row["approved_generation"]) return null;
  const text = (key: string) => (row[key] === null || row[key] === undefined ? null : String(row[key]));
  return { id: String(row["id"]), thread: terms.thread, seq: terms.seq, repo: terms.repo, base: terms.base, candidate: terms.candidate, importRef: terms.importRef, branch: terms.branch,
    branchBefore: text("branch_before"), terms, approvedBy: String(row["approved_by"]), approvedGeneration: Number(row["approved_generation"]), state: String(row["state"]), reason: text("reason"),
    detail: text("detail"), taskId: text("task_id"), scopeDigest: text("scope_digest"), feedback: text("feedback"), mergeHead: text("merge_head"), stateAt: String(row["state_at"]) };
}

/** Every Ship of a thread, newest first: what the thread's Ship view shows (an imported Ship with no task among them). */
export function flexibleShipsOf(store: Store, thread: string): { ok: true; ships: FlexibleShipRow[] } | FlexibleShipRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const rows = store.handle.prepare("SELECT * FROM flexible_ship WHERE thread = ? ORDER BY seq DESC").all(thread) as Record<string, unknown>[];
  return { ok: true, ships: rows.map(readRow).filter((one): one is FlexibleShipRow => one !== null) };
}

const rowOfTask = (store: Store, taskId: string): FlexibleShipRow | null => readRow(store.handle.prepare("SELECT * FROM flexible_ship WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined);

/** The Ship a task was filed for, read exactly and still bound to its task's sealed scope (the seal under
 * `flexible-ship`): its provenance names this Ship, its scope is the one sealed, unchanged, with the Ship's candidate. */
function shipOfTask(store: Store, taskId: string): FlexibleShipRow | null {
  const via = store.filedViaOf(taskId);
  if (via === null || !via.startsWith(FLEXIBLE_FILED_PREFIX)) return null;
  const ship = rowOfTask(store, taskId);
  if (ship === null || via !== `${FLEXIBLE_FILED_PREFIX}${ship.id}` || taskId !== flexibleShipTaskId(ship.id)) return null;
  const scope = store.getScope(taskId);
  if (scope === null || scope.digest !== ship.scopeDigest || scope.candidate !== ship.candidate || !approvalOf(scope).approved) return null;
  return ship;
}

// ---- the armed merge ----------------------------------------------------------------------------------------------------

/** End an armed (or completed) Ship for good, with why. */
function cancelArmed(store: Store, ship: FlexibleShipRow, why: string, now: Date, actor = "toolroll"): boolean {
  return store.transact(() => {
    const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'cancelled', detail = ?, state_at = ? WHERE id = ? AND state IN ('armed', 'completed')").run(why.slice(0, 2000), now.toISOString(), ship.id);
    if (Number(moved.changes) !== 1) return false;
    store.recordAction({ at: now.toISOString(), actor, repo: ship.repo, taskId: ship.taskId, runId: null, source: actor === "toolroll" ? "policy" : "work", action: "flexible merge cancelled", outcome: "cancelled", detail: why.slice(0, 2000) });
    return true;
  });
}

export type FlexibleArmedStep = { ok: true; state: "waiting" | "completed" | "merged"; why?: string } | FlexibleShipRefusal;

/**
 * One step of an armed Ship's merge (the watch loop's pass runs it): re-prove the press's authority, then complete
 * the exact checked result and owe its pull request, or merge that head. Waits (and says why) while the result isn't
 * built or checked yet, its check didn't pass, or its pull request isn't open; never merges on a failed or missing
 * check. Ends the Ship for good when the authority lapsed, the head isn't the candidate's or changed since completion,
 * the base moved out from under it, or the task was cancelled.
 */
export async function mergeArmedFlexible(store: Store, input: { taskId: string; root: string; exec?: PublishExec; clock?: () => Date; runner?: Runner }): Promise<FlexibleArmedStep> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const clock = input.clock ?? (() => new Date());
  const found = rowOfTask(store, input.taskId);
  if (found === null) return refuse("not-found");
  if (found.state !== "armed" && found.state !== "completed") return refuse("wrong-state", found.state);
  const stop = (why: string): FlexibleShipRefusal => { cancelArmed(store, found, why, clock()); return refuse("cancelled", why); };
  const ship = shipOfTask(store, input.taskId);
  if (ship === null) return stop("its task's sealed terms no longer hold");
  // The press's authority, re-proved: the owner still an approver of the project at the generation they shipped with,
  // the project's Flexible terms live, not two-person; the task not cancelled.
  const thread = flexibleThread(store, ship.thread);
  if (thread === null) return stop("its thread is gone");
  const standing = ownerStanding(store, thread, ship.approvedBy);
  if ("ok" in standing) return stop(`the person's authority ended: ${standing.message}`);
  if (standing.generation !== ship.approvedGeneration) return stop("the person's account changed since they shipped it");
  if (store.getTask(input.taskId)?.state === "cancelled") return stop("its task was cancelled");
  const grant = store.publicationGrantFor(ship.repo);
  if (grant === null) return { ok: true, state: "waiting", why: "pull requests aren't set up for this project" };
  // The base still under the branch it merges into: a base rewritten out from under it is an incompatible move.
  let project: string;
  try { project = realpathSync(ship.repo); } catch { return { ok: true, state: "waiting", why: "the project can't be read" }; }
  const read = hardenedGit(input.runner ?? run, "read", { repo: project });
  const git = (args: string[]) => read("git", ["--no-replace-objects", ...args], { cwd: project, timeoutMs: 30_000 });
  const based = await git(["merge-base", "--is-ancestor", ship.base, `refs/heads/${grant.base}`]);
  if (based.code === 1) return stop(`its starting commit is no longer on ${grant.base}`);
  if (based.code !== 0) return { ok: true, state: "waiting", why: `${grant.base} couldn't be read` };
  const ref = store.lookupRef(input.taskId);
  const runs = ref === null ? [] : store.runsFor(ref.id).filter(one => one.role !== "reviewer");
  const newest = runs.reduce<typeof runs[number] | null>((best, one) => (best === null || one.id > best.id ? one : best), null);
  if (newest === null || newest.headRevision === null || newest.finishedAt == null) return { ok: true, state: "waiting", why: "its check task hasn't finished" };
  const head = newest.headRevision;
  // Green, on exactly this commit: the check level recorded, the project's check command set, the full check passed.
  const green = runCheckLevel(store, newest.id) !== null && store.liveVerifyCommand(ship.repo) !== null && fullCheckGate(store, newest.id, clock()).state === "clear";
  if (ship.state === "armed") {
    const tree = async (rev: string) => { const out = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{tree}`]); return out.code === 0 ? out.stdout.trim() : null; };
    const [built, imported] = [await tree(head), await tree(ship.candidate)];
    if (built === null || imported === null) return { ok: true, state: "waiting", why: "its commit couldn't be read" };
    if (built !== imported) return stop("the result isn't exactly the shipped candidate");
    if (!green) return { ok: true, state: "waiting", why: "the check hasn't passed on this exact commit" };
    const receipt = assignmentOf(store, input.taskId, clock(), { principal: "operator", repos: [ship.repo] }, input.root)?.receipt ?? null;
    if (receipt === null || receipt.runId !== newest.id || (receipt.head !== null && receipt.head !== head)) return { ok: true, state: "waiting", why: "its result isn't ready to complete yet" };
    try {
      store.transact(() => {
        const again = shipOfTask(store, input.taskId);
        if (again === null || again.state !== "armed") throw new ShipStop(refuse("wrong-state"));
        const now = store.accountOf(again.approvedBy);
        if (now === null || now.generation !== again.approvedGeneration) throw new ShipStop(refuse("stale-generation"));
        const who = verifyApproverStanding(store, again.approvedBy, again.approvedGeneration, [again.repo]);
        if (!who.ok) throw new ShipStop(refuse("not-an-approver"));
        const opened = completeAndOpenPullRequest(store, { taskId: input.taskId, digest: receipt.digest, runId: newest.id, who: who.who, root: input.root }, clock());
        if (!opened.ok) throw new ShipStop(refuse("wrong-state", opened.message));
        if (opened.publication.headSha !== head) throw new ShipStop(refuse("wrong-state", "its pull request names another commit"));
        const at = clock().toISOString();
        store.handle.prepare("UPDATE flexible_ship SET state = 'completed', merge_head = ?, merge_at = ?, state_at = ? WHERE id = ? AND state = 'armed'").run(head, at, at, again.id);
        store.recordAction({ at, actor: again.approvedBy, repo: again.repo, taskId: input.taskId, runId: newest.id, source: "work", action: "flexible ship completed", outcome: head,
          detail: `ship ${again.id} · checked head ${head} · pull request owed` });
      });
    } catch (error) {
      if (error instanceof ShipStop) return { ok: true, state: "waiting", why: error.refusal.message };
      throw error;
    }
    return { ok: true, state: "completed" };
  }
  // Completed: merge exactly the checked head, through its pull request, while everything still stands.
  const publication = store.publicationForRun(newest.id);
  if (head !== ship.mergeHead || publication === null || publication.headSha !== ship.mergeHead) return stop("the result's head changed since its check passed");
  if (!green) return { ok: true, state: "waiting", why: "the check no longer stands on this exact commit" };
  if (publication.prNumber === null) return { ok: true, state: "waiting", why: "its pull request isn't open yet" };
  const merged = await mergePullRequest(store, { runId: newest.id, by: ship.approvedBy, flexibleShip: ship.id, ...(input.exec === undefined ? {} : { exec: input.exec }), clock });
  if (!merged.ok) {
    if (merged.reason === "moved" || merged.reason === "closed") return stop(merged.message);
    return { ok: true, state: "waiting", why: merged.message };
  }
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_ship SET state = 'merged', state_at = ? WHERE id = ? AND state = 'completed'").run(clock().toISOString(), ship.id);
    store.recordAction({ at: clock().toISOString(), actor: ship.approvedBy, repo: ship.repo, taskId: input.taskId, runId: newest.id, source: "work", action: "flexible merged", outcome: merged.commit ?? "merged",
      detail: `ship ${ship.id} · head ${head}` });
  });
  return { ok: true, state: "merged" };
}

/**
 * Settle the Ships a crash interrupted mid-import (left `approved`): under each thread's lock (held by any Ship still
 * running, so a live one is never touched), the import's ref and the thread's branch are put back by compare-and-swap
 * where they hold this Ship's candidate, and the Ship ends `failed` (interrupted), shippable again as n+1.
 */
export async function reconcileFlexibleShips(store: Store, input: { now: Date; runner?: Runner; lockWaitMs?: number }): Promise<{ ok: true; settled: number } | FlexibleShipRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const stuck = (store.handle.prepare("SELECT * FROM flexible_ship WHERE state = 'approved' ORDER BY thread, seq").all() as Record<string, unknown>[]);
  let settled = 0;
  for (const raw of stuck) {
    const id = String(raw["id"]), thread = String(raw["thread"]);
    let done: unknown;
    try {
      done = await withFlexibleThreadLock(thread, async () => {
        const row = store.handle.prepare("SELECT * FROM flexible_ship WHERE id = ? AND state = 'approved'").get(id) as Record<string, unknown> | undefined;
        if (row === undefined) return false;
        const candidate = String(row["candidate"]), branchBefore = row["branch_before"] === null ? null : String(row["branch_before"]);
        const put = await settleInterruptedImport(store, { thread, seq: Number(row["seq"]), candidate, branchBefore, ...(input.runner === undefined ? {} : { runner: input.runner }) });
        const words = put.ok ? `interrupted before it finished; import ref ${put.importRef}, thread branch ${put.branch}` : `interrupted before it finished; its refs couldn't be checked: ${put.message}`;
        return store.transact(() => {
          const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'failed', reason = 'interrupted', detail = ?, state_at = ? WHERE id = ? AND state = 'approved'").run(words.slice(0, 2000), input.now.toISOString(), id);
          if (Number(moved.changes) !== 1) return false;
          store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: String(row["repo"]), taskId: null, runId: null, source: "policy", action: "flexible ship interrupted", outcome: "failed",
            detail: `ship ${id} · ${words}`.slice(0, 2000) });
          return true;
        });
      }, input.lockWaitMs ?? 200);
    } catch { continue; } // the thread's lock is held: a Ship is running there, not crashed.
    if (done === true) settled++;
  }
  return { ok: true, settled };
}

export type FlexibleArmedReport = { ok: true; reconciled: number; completed: number; merged: number; cancelled: number; waiting: number };

/**
 * The watch loop's pass (operate.ts): settle interrupted Ships, then take one step on every armed or completed Ship.
 * Refuses at once while Flexible isn't available.
 */
export async function flexibleArmedPass(store: Store, input: { root: string; exec?: PublishExec; clock?: () => Date; runner?: Runner }): Promise<FlexibleArmedReport | FlexibleShipRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const clock = input.clock ?? (() => new Date());
  const runner = input.runner === undefined ? {} : { runner: input.runner };
  const reconciled = await reconcileFlexibleShips(store, { now: clock(), ...runner });
  const report: FlexibleArmedReport = { ok: true, reconciled: reconciled.ok ? reconciled.settled : 0, completed: 0, merged: 0, cancelled: 0, waiting: 0 };
  const tasks = store.handle.prepare("SELECT task_id FROM flexible_ship WHERE state IN ('armed', 'completed') ORDER BY approved_at").all().map(row => String(row["task_id"]));
  for (const taskId of tasks) {
    const step = await mergeArmedFlexible(store, { taskId, root: input.root, clock, ...runner, ...(input.exec === undefined ? {} : { exec: input.exec }) });
    if (!step.ok) { if (step.reason === "cancelled") report.cancelled++; continue; }
    report[step.state]++;
  }
  return report;
}

// ---- cancel, send back, and removing an import --------------------------------------------------------------------

/** The person who shipped it, at their current generation, ending its armed merge (no password: it only narrows). */
function ownersShip(store: Store, taskId: string, by: { name: string; generation: number }): FlexibleShipRow | FlexibleShipRefusal {
  const ship = shipOfTask(store, taskId) ?? rowOfTask(store, taskId);
  if (ship === null) return refuse("not-found");
  if (ship.state !== "armed" && ship.state !== "completed") return refuse("wrong-state", ship.state);
  if (ship.approvedBy !== by.name) return refuse("not-owner");
  const account = store.accountOf(by.name);
  if (account === null || account.revokedAt !== null || account.generation !== by.generation) return refuse("stale-generation");
  return ship;
}

/** Cancel: the person stops a Ship's armed merge for good. Its check task is cancelled where it still can be; a pull
 * request already open stays open, unmerged. */
export function cancelFlexibleShip(store: Store, input: { taskId: string; by: { name: string; generation: number }; now: Date }): { ok: true } | FlexibleShipRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (machineActing()) return refuse("machine-proof");
  return store.transact(() => {
    const ship = ownersShip(store, input.taskId, input.by);
    if ("ok" in ship) return ship;
    if (!cancelArmed(store, ship, `cancelled by ${input.by.name}`, input.now, input.by.name)) return refuse("wrong-state");
    store.cancelTask(input.taskId, input.now, "its Flexible Ship was cancelled");
    return { ok: true as const };
  });
}

/**
 * Send back: the person ends a Ship that was armed or completed, with feedback, and reopens the thread with that
 * feedback as its next message (returned for the thread to take). Its check task is cancelled where it still can be.
 * The next Ship is a new import (n+1).
 */
export function sendBackFlexible(store: Store, input: { taskId: string; by: { name: string; generation: number }; feedback: string; now: Date }):
  { ok: true; thread: string; feedback: string } | FlexibleShipRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (machineActing()) return refuse("machine-proof");
  const feedback = input.feedback.trim();
  if (feedback === "" || feedback.length > 20_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(feedback)) return refuse("invalid-request");
  return store.transact(() => {
    const ship = ownersShip(store, input.taskId, input.by);
    if ("ok" in ship) return ship;
    const at = input.now.toISOString();
    store.handle.prepare("UPDATE flexible_ship SET state = 'sent-back', feedback = ?, state_at = ? WHERE id = ? AND state IN ('armed', 'completed')").run(feedback, at, ship.id);
    const cancelled = store.cancelTask(input.taskId, input.now, "sent back to its Flexible thread");
    store.recordAction({ at, actor: input.by.name, repo: ship.repo, taskId: input.taskId, runId: null, source: "work", action: "flexible sent back", outcome: "sent-back",
      detail: `ship ${ship.id} · thread ${ship.thread}${cancelled.ok ? " · task cancelled" : ` · task ${cancelled.reason}`}` });
    return { ok: true as const, thread: ship.thread, feedback };
  });
}

/**
 * Remove an import that has no task (a Ship whose check task couldn't be made): the thread's owner. Its import ref goes
 * and the thread's branch goes back to what that import found there (flexible-import.ts removeFlexibleImportRefs), any
 * check-task branch a crash left goes too, and the Ship ends removed. Only the newest import that still holds the branch.
 */
export async function removeFlexibleImport(store: Store, input: { ship: string; by: { name: string; generation: number }; now: Date; runner?: Runner }):
  Promise<{ ok: true } | FlexibleShipRefusal | FlexibleImportRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (machineActing()) return refuse("machine-proof");
  const ship = readRow(store.handle.prepare("SELECT * FROM flexible_ship WHERE id = ?").get(input.ship) as Record<string, unknown> | undefined);
  if (ship === null) return refuse("not-found");
  if (ship.state !== "imported" || ship.taskId !== null) return refuse("wrong-state", ship.state);
  if (ship.approvedBy !== input.by.name) return refuse("not-owner");
  const account = store.accountOf(input.by.name);
  if (account === null || account.revokedAt !== null || account.generation !== input.by.generation) return refuse("stale-generation");
  if (branchHeld(store, ship.thread) !== ship.candidate) return refuse("wrong-state", "a later Ship holds the branch");
  const runner = input.runner === undefined ? {} : { runner: input.runner };
  const removed = await removeFlexibleImportRefs(store, { thread: ship.thread, seq: ship.seq, candidate: ship.candidate, branchBefore: ship.branchBefore, ...runner });
  if (!removed.ok) return removed;
  await flexibleTaskBranch(store, { thread: ship.thread, branch: taskBranch(flexibleShipTaskId(ship.id)), at: ship.base, make: false, ...runner });
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_ship SET state = 'removed', state_at = ? WHERE id = ? AND state = 'imported'").run(input.now.toISOString(), ship.id);
    store.recordAction({ at: input.now.toISOString(), actor: input.by.name, repo: ship.repo, taskId: null, runId: null, source: "work", action: "flexible import removed", outcome: "removed",
      detail: `ship ${ship.id} · ${ship.importRef}` });
  });
  return { ok: true };
}
