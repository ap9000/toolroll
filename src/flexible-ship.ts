/**
 * Ship for Flexible threads, slice F4 (the Flexible plan v2 §7 "Ship is its own exact-terms approval", with §1's
 * controlled import and Codex round 2's required changes 5–7, binding): how a thread's committed work becomes a checked,
 * merged result. Two presses, each a person's own act with their password typed now:
 *
 * 1. **Send for checks** (`flexible-ship`, an approval kind of its own, never a build or release approval). The sheet
 *    shows exact terms (flexibleShipTerms): the candidate commit and its base, the changed files, the title, goal and
 *    what done means, the project's check command, that further code changes need a new send, and, before consent,
 *    that the thread could read the repository's history beyond its base. They hash to `digest` and the approval
 *    summary's key (approval-summary.ts shipSummaryOf) binds every row shown; the press must carry both back, or it is
 *    stale and refused. Then, in order: the yes is recorded (one transaction re-reading the person's standing, the
 *    thread's owner and generation, the project's Flexible terms and two-person rules), the controlled import runs
 *    (flexible-import.ts: every check in quarantine before any ref moves), and the verify-only task is filed, its
 *    scope proposed with the imported candidate and sealed through the ordinary approve() authority checks, in ONE
 *    transaction (a refusal there files nothing and leaves an imported branch with no task, shown and removable).
 *    Each send is a new import and receipt: sequence n+1.
 * 2. **Complete and merge**, only after the required check passed on the exact head (no bypass: never `merge anyway`,
 *    never automerge, never automatic completion; pull-request-flow.ts refuses every other merge road for these tasks).
 *    It completes that exact result, owes its pull request and arms a single-use merge bound to that head, the person's
 *    generation and this send. The armed merge (mergeArmedFlexible) re-proves all of it immediately before merging;
 *    any change (a moved head, a stale check, the person's account changed, the task sent back) cancels it for good.
 *
 * **Send back** reopens the thread: the send ends (an armed merge with it) and the feedback is handed back as the
 * thread's next message. Nothing here works while FLEXIBLE_AVAILABLE is false; no route, CLI, MCP tool or chat action
 * calls it yet (flexible-disabled.test.ts).
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { FLEXIBLE_UNAVAILABLE, flexibleNetworkOf, flexibleStanding, flexibleTwoPerson, type FlexibleNetwork } from "./flexible.js";
import { flexibleThread, flexibleThreadBranch, withFlexibleThreadLock, type FlexibleThreadRow } from "./flexible-thread.js";
import { flexibleImportRef, flexibleTaskBranch, importFlexibleCandidate, readFlexibleCandidate, removeFlexibleImportRefs, type FlexibleImportRefusal } from "./flexible-import.js";
import { unsettledLaunch } from "./flexible-launch.js";
import { shipSummaryOf, type ApprovalSummary, type SummaryNote, type SummaryRow } from "./approval-summary.js";
import { canonicalJson } from "./canonical-json.js";
import { approvalOf, approve, machineActing, parseAcceptanceCriteria, proposeGuarded, proveCredential, type AcceptanceCriterion } from "./scope.js";
import { fileTaskProposal } from "./proposal.js";
import { validateTaskText } from "./task-text.js";
import { taskBranch } from "./names.js";
import { verifyApproverStanding } from "./principal.js";
import { completeAndOpenPullRequest, mergePullRequest } from "./pull-request-flow.js";
import type { PublishExec } from "./publish.js";
import { fullCheckGate } from "./result-follow-ups.js";
import { runCheckLevel } from "./check-levels.js";
import { run } from "./exec.js";
import { hardenedGit } from "./teardown-git.js";
import type { Store } from "./store.js";
import type { Runner } from "./worktree.js";

// ---- the terms --------------------------------------------------------------------------------------------------------

export const FLEXIBLE_SHIP_VERSION = 1;
/** What a send's check task may do: verify the imported candidate, nothing more. */
export const SHIP_OUT_OF_SCOPE = "Verify the imported candidate only. Further code changes need a new send.";
/** The disclosure Codex round 2 (item 6) requires before consent: a thread reads the project's real objects folder. */
export const HISTORY_WORDS = "This thread could read your repository's full history, not just the commit it started from: it reads your repository's stored objects, read-only.";
const OPEN_HISTORY_WORDS = "This project's network is open, so the thread could have sent what it read, that history included, to any website.";
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
  /** This send's number: 1 for the thread's first, then n+1. */
  seq: number;
  base: string;
  candidate: string;
  /** The thread's branch in the project's repository, and this send's import ref. */
  branch: string;
  importRef: string;
  changedPaths: string[];
  title: string;
  goal: string;
  acceptance: AcceptanceCriterion[];
  outOfScope: string;
  /** The project's check command, as approved (its digest), run on the exact commit with no way to skip it. */
  check: { command: string; digest: string };
  network: FlexibleNetwork;
  /** The disclosure is a term: the thread could read history beyond its base. */
  history: "beyond-base";
};

export const flexibleShipDigestOf = (terms: FlexibleShipTerms): string =>
  createHash("sha256").update(`standing-orders:flexible-ship:${canonicalJson(terms)}`, "utf8").digest("hex").slice(0, 32);
/** The verify-only task a send files, and its provenance: both derived from the send's digest, so neither can name
 * another send. */
export const flexibleShipTaskId = (digest: string): string => `flexible-${digest}`;
const FILED_PREFIX = "flexible:";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The sheet's rows and warnings, and the key over them (approval-summary.ts shipSummaryOf). */
export function flexibleShipSummary(terms: FlexibleShipTerms, digest: string): ApprovalSummary {
  const shown = terms.changedPaths.slice(0, 50);
  const decisions: SummaryRow[] = [
    { label: "Task", words: terms.title, fields: ["ship.title"] },
    { label: "Sends", words: `${plural(terms.changedPaths.length, "changed file")} from this thread, as commit ${terms.candidate.slice(0, 12)}`,
      lines: terms.changedPaths.length > shown.length ? [...shown, `and ${terms.changedPaths.length - shown.length} more`] : shown, fields: ["ship.candidate", "ship.changedPaths"] },
    { label: "Starts from", words: `commit ${terms.base.slice(0, 12)}, where the thread started`, fields: ["ship.base"] },
    { label: "Goal", words: terms.goal, fields: ["goal"] },
    { label: "Done when", words: terms.acceptance.map(one => one.statement).join(" "), fields: ["acceptance"] },
    { label: "Checks", words: `${terms.check.command} runs on this exact commit. It can't be skipped.`, fields: ["ship.check"] },
    { label: "After the checks", words: "You choose Complete and merge, with your password. Further code changes need a new send.", fields: ["outOfScope"] },
  ];
  const warnings: SummaryNote[] = [{ words: HISTORY_WORDS, fields: ["ship.history"] },
    ...(terms.network === "open" ? [{ words: OPEN_HISTORY_WORDS, fields: ["ship.network"] as SummaryNote["fields"] }] : [])];
  return shipSummaryOf(digest, decisions, warnings);
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type FlexibleShipReason = "not-available" | "thread-unknown" | "not-owner" | "not-an-approver" | "stale-generation" | "two-person" | "not-flexible"
  | "no-check" | "thread-running" | "invalid-request" | "changed" | "machine-proof" | "password-now" | "handoff-failed" | "approval-refused"
  | "not-found" | "wrong-state" | "head-changed" | "check-not-green" | "publish-refused" | "merge-refused";
export type FlexibleShipRefusal = { ok: false; reason: FlexibleShipReason; message: string };

const WORDS: Readonly<Record<FlexibleShipReason, string>> = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "thread-unknown": "There's no such thread.",
  "not-owner": "Only the person who started this thread can do that. Nothing changed.",
  "not-an-approver": "Only an approver for this project can do that. Nothing changed.",
  "stale-generation": "Your account changed since this started. Sign in again and retry. Nothing changed.",
  "two-person": "This project needs two people to approve work, so a Flexible thread can't ship from it. Nothing changed.",
  "not-flexible": "This project's Flexible terms don't count right now, so nothing was sent.",
  "no-check": "This project has no check command, and a Flexible thread's work ships only after its checks pass. Set one in the project's settings first. Nothing changed.",
  "thread-running": "The thread's agent is still working. Stop it, then send for checks. Nothing changed.",
  "invalid-request": "The title, goal or what done means isn't valid. Nothing changed.",
  "changed": "These terms changed since they were shown, or were already used. Read them again first. Nothing changed.",
  "machine-proof": "Only a person can send a thread's work for checks or merge it. Nothing changed.",
  "password-now": "This needs your password, typed now. Nothing changed.",
  "handoff-failed": "The changes were imported, but their check task couldn't be made. The import is kept: send again, or remove it.",
  "approval-refused": "The changes were imported, but their check task couldn't be approved. The import is kept: send again, or remove it.",
  "not-found": "There's no such send.",
  "wrong-state": "This send can't do that now.",
  "head-changed": "The result changed since it was shown. Nothing was merged.",
  "check-not-green": "The check hasn't passed on this exact commit, so it can't merge. Nothing was merged.",
  "publish-refused": "The result couldn't be completed and published. Nothing was merged.",
  "merge-refused": "The merge didn't happen.",
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

/** A person's password typed now, proved for this project: never a machine's credential, a remembered sign-in or an
 * empty password. */
function personNow(store: Store, by: string, token: string, repo: string): FlexibleShipRefusal | { method: "password-now" | "sso-now" } {
  if (machineActing()) return refuse("machine-proof");
  if (token === "") return refuse("password-now");
  const proved = proveCredential(store, by, token, repo);
  if (!proved.ok) return refuse("not-an-approver");
  if (proved.method !== "password-now" && proved.method !== "sso-now") return refuse("password-now");
  return { method: proved.method };
}

const turnRunning = (store: Store, thread: string): boolean =>
  store.handle.prepare("SELECT 1 FROM thread_turn WHERE thread = ? AND status IN ('admitted', 'running')").get(thread) !== undefined;

/** What the thread's branch in the project's repository holds after the sends so far: the latest import that wrote it
 * and still stands (a removed one put back what it found), or null when none did. */
function branchHeld(store: Store, thread: string): string | null {
  const row = store.handle.prepare("SELECT candidate FROM flexible_ship WHERE thread = ? AND state IN ('imported', 'sent', 'sent-back', 'merge-armed', 'merged', 'cancelled') ORDER BY seq DESC LIMIT 1").get(thread);
  return row === undefined ? null : String(row["candidate"]);
}
const nextSeq = (store: Store, thread: string): number => Number(store.handle.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM flexible_ship WHERE thread = ?").get(thread)!["n"]);

// ---- press 1: the terms, and Send for checks ----------------------------------------------------------------------------

export type FlexibleShipText = { title?: string; goal?: string; acceptance?: unknown };

/**
 * The exact terms a Send for checks would sign now, from Toolroll's records and the thread's committed branch (read in
 * a quarantine, flexible-import.ts readFlexibleCandidate: nothing of the thread's runs), with their digest and the
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
    title, goal, acceptance: parsed.criteria, outOfScope: SHIP_OUT_OF_SCOPE, check: { command: check.command, digest: check.digest },
    network: flexibleNetworkOf(store, thread.repo), history: "beyond-base",
  };
  const digest = flexibleShipDigestOf(terms);
  return { ok: true, terms, digest, summary: flexibleShipSummary(terms, digest) };
}

export type FlexibleSent = { ok: true; ship: string; seq: number; taskId: string; scopeDigest: string; importRef: string; refsChanged: string[] | null };

/**
 * Send for checks: the person's yes to exactly the terms shown (`shownDigest` and the summary's `shownKey`), with their
 * password typed now, then the controlled import, then the verify-only task filed and sealed. See the module comment.
 */
export async function sendFlexibleForChecks(store: Store, input: { thread: string; by: string; token: string; shownDigest: string; shownKey: string; text?: FlexibleShipText; now: Date; runner?: Runner }):
  Promise<FlexibleSent | FlexibleShipRefusal | FlexibleImportRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const first = flexibleThread(store, input.thread);
  if (first === null) return refuse("thread-unknown");
  const proved = personNow(store, input.by, input.token, first.repo);
  if ("ok" in proved) return proved;
  const locked = await withFlexibleThreadLock(input.thread, () => sendLocked(store, input, proved.method));
  if (locked.ok === false && (locked.reason === "not-available" || locked.reason === "thread-unknown")) return refuse(locked.reason);
  return locked as FlexibleSent | FlexibleShipRefusal | FlexibleImportRefusal;
}

/** A refusal raised inside a transaction to roll it back whole. */
class ShipStop extends Error { constructor(readonly refusal: FlexibleShipRefusal) { super(refusal.message); } }

async function sendLocked(store: Store, input: { thread: string; by: string; token: string; shownDigest: string; shownKey: string; text?: FlexibleShipText; now: Date; runner?: Runner },
  method: "password-now" | "sso-now"): Promise<FlexibleSent | FlexibleShipRefusal | FlexibleImportRefusal> {
  if (turnRunning(store, input.thread) || unsettledLaunch(store, input.thread) !== null) return refuse("thread-running");
  // The terms again, from the records and the thread's branch as they are now: anything different is a stale press.
  const shown = await flexibleShipTerms(store, { thread: input.thread, by: input.by, ...(input.text === undefined ? {} : { text: input.text }), ...(input.runner === undefined ? {} : { runner: input.runner }) });
  if (!shown.ok) return shown;
  if (shown.digest !== input.shownDigest || shown.summary.key !== input.shownKey) return refuse("changed");
  const { terms, digest } = shown;
  const now = input.now.toISOString();
  // The yes, recorded with the authority re-read in the same transaction (check and write together). The send's id is
  // its digest: a second press of the same terms is refused, never a second send.
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
      detail: `thread ${thread.id} · send ${terms.seq} · terms ${digest} · candidate ${terms.candidate} · ${method} · generation ${standing.generation}` });
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
        detail: `thread ${terms.thread} · send ${terms.seq} · ${imported.message}`.slice(0, 2000) });
    });
    return imported;
  }
  store.transact(() => { store.handle.prepare("UPDATE flexible_ship SET state = 'imported', state_at = ? WHERE id = ? AND state = 'approved'").run(now, digest); });
  return fileAndSeal(store, { terms, digest, by: input.by, token: input.token, now: input.now, refsChanged: imported.refsChanged, ...(input.runner === undefined ? {} : { runner: input.runner }) });
}

/** The verify-only task for an import: its branch made at the thread's base, then (one transaction) the task filed, its
 * scope proposed with the imported candidate, sealed through approve() and the send marked sent. A refusal anywhere
 * files nothing, takes the branch back, and leaves the import with no task (shown, sendable again, removable). */
async function fileAndSeal(store: Store, input: { terms: FlexibleShipTerms; digest: string; by: string; token: string; now: Date; refsChanged: string[] | null; runner?: Runner }):
  Promise<FlexibleSent | FlexibleShipRefusal> {
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
    const sent = store.transact(() => {
      const row = store.handle.prepare("SELECT state FROM flexible_ship WHERE id = ?").get(digest);
      if (row?.["state"] !== "imported") throw new ShipStop(refuse("wrong-state"));
      const made = fileTaskProposal(store, { id: taskId, title: terms.title, repo: terms.repo, goal: terms.goal, outOfScope: terms.outOfScope, acceptance: terms.acceptance,
        filedVia: `${FILED_PREFIX}${digest}`, filedBy: { name: input.by, kind: "person" as const }, planning: "skip", admittedRepos: [terms.repo] }, input.now);
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
      const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'sent', task_id = ?, scope_digest = ?, detail = NULL, state_at = ? WHERE id = ? AND state = 'imported'")
        .run(made.id, sealed.digest, input.now.toISOString(), digest);
      if (Number(moved.changes) !== 1) throw new ShipStop(refuse("wrong-state"));
      store.recordAction({ at: input.now.toISOString(), actor: input.by, repo: terms.repo, taskId: made.id, runId: null, source: "work", action: "flexible ship sent", outcome: "flexible-ship",
        detail: `thread ${terms.thread} · send ${terms.seq} · terms ${digest} · scope ${sealed.digest} · candidate ${terms.candidate}` });
      return { ok: true as const, ship: digest, seq: terms.seq, taskId: made.id, scopeDigest: sealed.digest, importRef: terms.importRef, refsChanged: input.refsChanged };
    });
    return sent;
  } catch (error) {
    await flexibleTaskBranch(store, { thread: terms.thread, branch, at: terms.base, make: false, ...runner });
    if (error instanceof ShipStop) return kept(error.refusal);
    return kept(refuse("handoff-failed", error instanceof Error ? error.message.slice(0, 300) : undefined));
  }
}

// ---- reading a send ---------------------------------------------------------------------------------------------------

export type FlexibleShipRow = { id: string; thread: string; seq: number; repo: string; base: string; candidate: string; importRef: string; branch: string; branchBefore: string | null;
  terms: FlexibleShipTerms; approvedBy: string; approvedGeneration: number; state: string; reason: string | null; detail: string | null; taskId: string | null; scopeDigest: string | null;
  feedback: string | null; mergeHead: string | null; mergeBy: string | null; mergeGeneration: number | null; stateAt: string };

/** A send, read exactly: its terms canonical and hashing to its digest, which is its id; its fixed columns the terms'
 * own. Null for anything else (never a guess). */
function readRow(row: Record<string, unknown> | undefined): FlexibleShipRow | null {
  if (row === undefined) return null;
  let terms: FlexibleShipTerms;
  try { terms = JSON.parse(String(row["terms_json"])) as FlexibleShipTerms; } catch { return null; }
  if (canonicalJson(terms) !== row["terms_json"] || flexibleShipDigestOf(terms) !== row["digest"] || row["id"] !== row["digest"] || terms.kind !== "flexible-ship" || terms.version !== FLEXIBLE_SHIP_VERSION) return null;
  if (terms.thread !== row["thread"] || terms.seq !== row["seq"] || terms.repo !== row["repo"] || terms.base !== row["base_sha"] || terms.candidate !== row["candidate"] || terms.importRef !== row["import_ref"] || terms.branch !== row["branch"]) return null;
  const text = (key: string) => (row[key] === null || row[key] === undefined ? null : String(row[key]));
  return { id: String(row["id"]), thread: terms.thread, seq: terms.seq, repo: terms.repo, base: terms.base, candidate: terms.candidate, importRef: terms.importRef, branch: terms.branch,
    branchBefore: text("branch_before"), terms, approvedBy: String(row["approved_by"]), approvedGeneration: Number(row["approved_generation"]), state: String(row["state"]), reason: text("reason"),
    detail: text("detail"), taskId: text("task_id"), scopeDigest: text("scope_digest"), feedback: text("feedback"), mergeHead: text("merge_head"), mergeBy: text("merge_by"),
    mergeGeneration: row["merge_generation"] === null ? null : Number(row["merge_generation"]), stateAt: String(row["state_at"]) };
}

/** Every send of a thread, newest first: what the thread's Ship view shows (an imported send with no task among them). */
export function flexibleShipsOf(store: Store, thread: string): { ok: true; sends: FlexibleShipRow[] } | FlexibleShipRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const rows = store.handle.prepare("SELECT * FROM flexible_ship WHERE thread = ? ORDER BY seq DESC").all(thread) as Record<string, unknown>[];
  return { ok: true, sends: rows.map(readRow).filter((one): one is FlexibleShipRow => one !== null) };
}

/** The send a task was filed for, read exactly and still bound to its task's sealed scope (the seal under
 * `flexible-ship`): its provenance names this send, its scope is the one sealed, unchanged, with the send's candidate. */
function sendOfTask(store: Store, taskId: string): FlexibleShipRow | null {
  const via = store.filedViaOf(taskId);
  if (via === null || !via.startsWith(FILED_PREFIX)) return null;
  const ship = readRow(store.handle.prepare("SELECT * FROM flexible_ship WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined);
  if (ship === null || via !== `${FILED_PREFIX}${ship.id}` || taskId !== flexibleShipTaskId(ship.id)) return null;
  const scope = store.getScope(taskId);
  if (scope === null || scope.digest !== ship.scopeDigest || scope.candidate !== ship.candidate || !approvalOf(scope).approved) return null;
  return ship;
}

// ---- press 2: Complete and merge ----------------------------------------------------------------------------------------

/** Why a result's check isn't green on exactly this run's head, or null when it is: the run is the task's newest, its
 * head the one shown, its tree exactly the imported candidate's, its check level recorded, the project's check command
 * still set, and the full check passed on this commit (result-follow-ups.ts fullCheckGate). Never "anyway". */
async function greenProblem(store: Store, ship: FlexibleShipRow, runId: number, head: string, now: Date, runner: Runner): Promise<FlexibleShipRefusal | null> {
  const ref = store.lookupRef(ship.taskId!);
  const result = store.getRun(runId);
  if (ref === null || result === null || result.taskRef !== ref.id) return refuse("head-changed");
  const newest = store.runsFor(ref.id).filter(one => one.role !== "reviewer").reduce((best, one) => (one.id > best ? one.id : best), 0);
  if (newest !== runId || result.headRevision !== head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return refuse("head-changed");
  if (runCheckLevel(store, runId) === null || store.liveVerifyCommand(ship.repo) === null || fullCheckGate(store, runId, now).state !== "clear") return refuse("check-not-green");
  let project: string;
  try { project = realpathSync(ship.repo); } catch { return refuse("head-changed"); }
  const read = hardenedGit(runner, "read", { repo: project });
  const tree = async (rev: string) => { const out = await read("git", ["--no-replace-objects", "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{tree}`], { cwd: project, timeoutMs: 30_000 }); return out.code === 0 ? out.stdout.trim() : null; };
  const [built, imported] = [await tree(head), await tree(ship.candidate)];
  if (built === null || built !== imported) return refuse("head-changed", "its files aren't exactly the imported candidate's");
  return null;
}

/**
 * Complete and merge: the thread's owner, their password typed now, on the exact result shown (`runId`, its receipt
 * `digest`, its `head`), only after the required check passed on that head. Completes it and owes its pull request
 * (pull-request-flow.ts completeAndOpenPullRequest), and arms a single-use merge bound to that head, the person's
 * generation and this send, in one transaction. Refuses, and arms nothing, on a red or stale check or a changed head.
 */
export async function completeAndMergeFlexible(store: Store, input: { taskId: string; runId: number; digest: string; head: string; by: string; token: string; root: string; now: Date; runner?: Runner }):
  Promise<{ ok: true; ship: string; publication: number } | FlexibleShipRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const ship = sendOfTask(store, input.taskId);
  if (ship === null) return refuse("not-found");
  const proved = personNow(store, input.by, input.token, ship.repo);
  if ("ok" in proved) return proved;
  if (ship.state !== "sent") return refuse("wrong-state", ship.state);
  if (ship.approvedBy !== input.by) return refuse("not-owner");
  const green = await greenProblem(store, ship, input.runId, input.head, input.now, input.runner ?? run);
  if (green !== null) return green;
  try {
    return store.transact(() => {
      const again = sendOfTask(store, input.taskId);
      if (again === null || again.state !== "sent") throw new ShipStop(refuse("wrong-state"));
      const thread = flexibleThread(store, again.thread);
      if (thread === null) throw new ShipStop(refuse("thread-unknown"));
      const standing = ownerStanding(store, thread, input.by);
      if ("ok" in standing) throw new ShipStop(standing);
      if (standing.generation !== again.approvedGeneration) throw new ShipStop(refuse("stale-generation"));
      if (store.getRun(input.runId)?.headRevision !== input.head) throw new ShipStop(refuse("head-changed"));
      const who = verifyApproverStanding(store, input.by, standing.generation, [again.repo]);
      if (!who.ok) throw new ShipStop(refuse("not-an-approver"));
      const opened = completeAndOpenPullRequest(store, { taskId: input.taskId, digest: input.digest, runId: input.runId, who: who.who, root: input.root }, input.now);
      if (!opened.ok) throw new ShipStop(opened.reason === "stale" ? refuse("head-changed") : refuse("publish-refused", opened.message));
      if (opened.publication.headSha !== input.head) throw new ShipStop(refuse("head-changed"));
      const at = input.now.toISOString();
      store.handle.prepare("UPDATE flexible_ship SET state = 'merge-armed', merge_head = ?, merge_by = ?, merge_generation = ?, merge_at = ?, state_at = ? WHERE id = ? AND state = 'sent'")
        .run(input.head, input.by, standing.generation, at, at, again.id);
      store.recordAction({ at, actor: input.by, repo: again.repo, taskId: input.taskId, runId: input.runId, source: "work", action: "flexible complete and merge", outcome: "armed",
        detail: `send ${again.id} · head ${input.head} · ${proved.method} · generation ${standing.generation}` });
      return { ok: true as const, ship: again.id, publication: opened.publication.id };
    });
  } catch (error) {
    if (error instanceof ShipStop) return error.refusal;
    throw error;
  }
}

/** End an armed send for good (its authority no longer holds), with why. */
function cancelArmed(store: Store, ship: FlexibleShipRow, why: string, now: Date): void {
  store.transact(() => {
    const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'cancelled', detail = ?, state_at = ? WHERE id = ? AND state IN ('sent', 'merge-armed')").run(why.slice(0, 2000), now.toISOString(), ship.id);
    if (Number(moved.changes) === 1) store.recordAction({ at: now.toISOString(), actor: "toolroll", repo: ship.repo, taskId: ship.taskId, runId: null, source: "policy", action: "flexible merge cancelled", outcome: "cancelled", detail: why.slice(0, 2000) });
  });
}

/**
 * The armed merge (run by the pull-request follower in the release that turns Flexible on): immediately before merging,
 * re-prove the authority Complete and merge armed (the owner still an approver of the project at the generation they
 * armed it with, the project's Flexible terms live, the task's sealed scope unchanged, the newest run's head still the
 * armed head and the pull request's, the check still passed on it), then merge that exact commit
 * (pull-request-flow.ts mergePullRequest, which merges a Flexible result for this send only). Any of it changed cancels
 * the send for good; nothing is ever re-armed.
 */
export async function mergeArmedFlexible(store: Store, input: { taskId: string; exec?: PublishExec; clock?: () => Date }): Promise<{ ok: true; commit: string | null } | FlexibleShipRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const clock = input.clock ?? (() => new Date());
  const raw = store.handle.prepare("SELECT * FROM flexible_ship WHERE task_id = ?").get(input.taskId) as Record<string, unknown> | undefined;
  const ship = sendOfTask(store, input.taskId);
  if (ship === null) {
    const found = readRow(raw);
    if (found !== null && (found.state === "merge-armed" || found.state === "sent")) cancelArmed(store, found, "its task's sealed terms no longer hold", clock());
    return refuse("not-found");
  }
  if (ship.state !== "merge-armed" || ship.mergeHead === null || ship.mergeBy === null) return refuse("wrong-state", ship.state);
  const thread = flexibleThread(store, ship.thread);
  const standing = thread === null ? refuse("thread-unknown") : ownerStanding(store, thread, ship.mergeBy);
  if ("ok" in standing) { cancelArmed(store, ship, `the merge's authority lapsed: ${standing.message}`, clock()); return standing; }
  if (standing.generation !== ship.mergeGeneration) { cancelArmed(store, ship, "the person's account changed since they pressed Complete and merge", clock()); return refuse("stale-generation"); }
  const ref = store.lookupRef(input.taskId);
  const runs = ref === null ? [] : store.runsFor(ref.id).filter(one => one.role !== "reviewer");
  const newest = runs.reduce<typeof runs[number] | null>((best, one) => (best === null || one.id > best.id ? one : best), null);
  const publication = newest === null ? null : store.publicationForRun(newest.id);
  if (newest === null || newest.headRevision !== ship.mergeHead || publication === null || publication.headSha !== ship.mergeHead) {
    cancelArmed(store, ship, "the result's head changed since Complete and merge", clock());
    return refuse("head-changed");
  }
  if (fullCheckGate(store, newest.id, clock()).state !== "clear" || runCheckLevel(store, newest.id) === null) {
    cancelArmed(store, ship, "the check no longer stands on the armed commit", clock());
    return refuse("check-not-green");
  }
  const merged = await mergePullRequest(store, { runId: newest.id, by: ship.mergeBy, flexibleShip: ship.id, ...(input.exec === undefined ? {} : { exec: input.exec }), clock });
  if (!merged.ok) {
    if (merged.reason === "moved" || merged.reason === "closed") cancelArmed(store, ship, merged.message, clock());
    return refuse("merge-refused", merged.message);
  }
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_ship SET state = 'merged', state_at = ? WHERE id = ? AND state = 'merge-armed'").run(clock().toISOString(), ship.id);
    store.recordAction({ at: clock().toISOString(), actor: ship.mergeBy!, repo: ship.repo, taskId: input.taskId, runId: newest.id, source: "work", action: "flexible merged", outcome: merged.commit ?? "merged",
      detail: `send ${ship.id} · head ${ship.mergeHead}` });
  });
  return { ok: true, commit: merged.commit };
}

// ---- send back, and removing an import --------------------------------------------------------------------------------

/**
 * Send back: the thread's owner (no password: it only narrows) ends a send that was sent or armed, with feedback, and
 * reopens the thread with that feedback as its next message (returned for the thread to take). The send's check task
 * is cancelled where it still can be; an armed merge ends with it. The next Send for checks is a new import (n+1).
 */
export function sendBackFlexible(store: Store, input: { taskId: string; by: { name: string; generation: number }; feedback: string; now: Date }):
  { ok: true; thread: string; feedback: string } | FlexibleShipRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (machineActing()) return refuse("machine-proof");
  const feedback = input.feedback.trim();
  if (feedback === "" || feedback.length > 20_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(feedback)) return refuse("invalid-request");
  return store.transact(() => {
    const ship = sendOfTask(store, input.taskId) ?? readRow(store.handle.prepare("SELECT * FROM flexible_ship WHERE task_id = ?").get(input.taskId) as Record<string, unknown> | undefined);
    if (ship === null) return refuse("not-found");
    if (ship.state !== "sent" && ship.state !== "merge-armed") return refuse("wrong-state", ship.state);
    if (ship.approvedBy !== input.by.name) return refuse("not-owner");
    const account = store.accountOf(input.by.name);
    if (account === null || account.revokedAt !== null || account.generation !== input.by.generation) return refuse("stale-generation");
    const at = input.now.toISOString();
    store.handle.prepare("UPDATE flexible_ship SET state = 'sent-back', feedback = ?, state_at = ? WHERE id = ? AND state IN ('sent', 'merge-armed')").run(feedback, at, ship.id);
    const cancelled = store.cancelTask(input.taskId, input.now, "sent back to its Flexible thread");
    store.recordAction({ at, actor: input.by.name, repo: ship.repo, taskId: input.taskId, runId: null, source: "work", action: "flexible sent back", outcome: "sent-back",
      detail: `send ${ship.id} · thread ${ship.thread}${cancelled.ok ? " · task cancelled" : ` · task ${cancelled.reason}`}` });
    return { ok: true as const, thread: ship.thread, feedback };
  });
}

/**
 * Remove an import that has no task (a send whose check task couldn't be made): the thread's owner. Its import ref goes
 * and the thread's branch goes back to what that import found there (flexible-import.ts removeFlexibleImportRefs); the
 * send ends removed. Only the newest import that still holds the branch can be removed.
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
  if (branchHeld(store, ship.thread) !== ship.candidate) return refuse("wrong-state", "a later send holds the branch");
  const removed = await removeFlexibleImportRefs(store, { thread: ship.thread, seq: ship.seq, candidate: ship.candidate, branchBefore: ship.branchBefore, ...(input.runner === undefined ? {} : { runner: input.runner }) });
  if (!removed.ok) return removed;
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_ship SET state = 'removed', state_at = ? WHERE id = ? AND state = 'imported'").run(input.now.toISOString(), ship.id);
    store.recordAction({ at: input.now.toISOString(), actor: input.by.name, repo: ship.repo, taskId: null, runId: null, source: "work", action: "flexible import removed", outcome: "removed",
      detail: `send ${ship.id} · ${ship.importRef}` });
  });
  return { ok: true };
}
