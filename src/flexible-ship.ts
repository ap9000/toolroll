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
 * merged") apart. Interactive agent threads' switch (flexible-available.ts) gates only what grants: arming a Ship,
 * completing it and its merge, each read again inside its own transaction. Ship's terms and the press up to its
 * quarantined import never check it (a person recovering past work while threads are off); settling, cancelling,
 * sending back and removing never do. The only caller outside the engine is the watch loop's pass (operate.ts); no
 * route, CLI, MCP tool or chat action reaches it.
 *
 * Not createCodingHandoff (coding-handoff.ts): that hand-off needs an installation operator and a desktop coding
 * session in the coding catalog, and proves a worktree sharing the project's git directory, none of which a thread has
 * (Codex round 2, required change 7). fileAndSeal below files the same verify-only task (its scope's prepared candidate,
 * planning skipped, the same out-of-scope words) from the import instead, and seals it in the same transaction.
 */
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { flexibleAvailable } from "./flexible-available.js";
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
import { laptopShipBinding, laptopShipProblem } from "./flexible-laptop.js";
import { localActNow } from "./local-owner.js";
import { assignmentOf } from "./assignment.js";
import { completeAndOpenPullRequest, mergePullRequest, type PullRequestSeen } from "./pull-request-flow.js";
import type { PublishExec } from "./publish.js";
import { fullCheckGate } from "./result-follow-ups.js";
import { runCheckLevel } from "./check-levels.js";
import { FLEXIBLE_FILED_PREFIX } from "./flexible-merge-guard.js";
import { run } from "./exec.js";
import { verificationEvidence } from "./verification-evidence.js";
import { readVerificationView } from "./contracts/verification-view.js";
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
  /** The press is the merge's authority: Toolroll merges only once that check passes on the exact candidate commit. */
  merge: "when-checks-pass";
  /** Where it merges and what Toolroll may do there, from the project's publication grant as signed: any change
   * cancels the merge. */
  github: { repo: string; remote: string; base: string; method: "squash" | "merge" | "rebase"; capabilities: string[]; draft: boolean };
  /** The project's Flexible terms the press was made under (their digest): ending them ends the Ship. */
  delegation: string;
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
    { label: "Merges into", words: `${terms.github.repo}, branch ${terms.github.base}, by ${terms.github.method}`,
      lines: [`Toolroll may ${terms.github.capabilities.map(one => one.replace(/-/g, " ")).join(", ")} there${terms.github.draft ? ", as a draft" : ""}, through ${terms.github.remote}.`], fields: ["ship.github"] },
    { label: "Further changes", words: "Need a new Ship.", fields: ["outOfScope"] },
  ];
  const warnings: SummaryNote[] = [{ words: HISTORY_WORDS, fields: ["ship.history"] },
    ...(terms.network === "open" ? [{ words: OPEN_HISTORY_WORDS, fields: ["ship.network"] as SummaryNote["fields"] }] : [])];
  return shipSummaryOf(digest, decisions, warnings);
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

export type FlexibleShipReason = "not-available" | "thread-unknown" | "not-owner" | "not-an-approver" | "stale-generation" | "two-person" | "not-flexible"
  | "no-check" | "thread-running" | "invalid-request" | "changed" | "machine-proof" | "proof-refused" | "handoff-failed" | "approval-refused"
  | "not-found" | "wrong-state" | "cancelled" | "no-publishing" | "merging" | "laptop";
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
  "no-publishing": "This project can't publish pull requests, so a Flexible thread's work can't merge from it. Set up pull requests first. Nothing changed.",
  "merging": "Too late: the merge is already happening. Its outcome is read back from GitHub.",
  "laptop": "Shipping from the workbench without a password works only on a laptop install where nobody has a password. Ship with your password instead: `toolroll thread ship`. Nothing was shipped.",
});
const refuse = (reason: FlexibleShipReason, detail?: string): FlexibleShipRefusal =>
  ({ ok: false, reason, message: detail === undefined ? WORDS[reason] : `${WORDS[reason]} (${detail})` });

// ---- authority --------------------------------------------------------------------------------------------------------

/** The thread's owner acting now, from Toolroll's records: an active approver of the project, the thread's owner, the
 * project not two-person, its Flexible terms live. Their current generation, or why not. Read inside the caller's
 * transaction. */
function ownerStanding(store: Store, thread: FlexibleThreadRow, by: string): { generation: number; termsId: number; termsDigest: string } | FlexibleShipRefusal {
  if (thread.createdBy !== by) return refuse("not-owner");
  const account = store.accountOf(by);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(by, thread.repo)) return refuse("not-an-approver");
  if (flexibleTwoPerson(store, thread.repo)) return refuse("two-person");
  const standing = flexibleStanding(store, thread.repo);
  if (standing.state !== "on") return refuse("not-flexible", standing.state);
  return { generation: account.generation, termsId: standing.id, termsDigest: standing.digest };
}

/**
 * How a Ship's press is proved (threads-everyday S7; Codex round 2 finding 2, and the owner's D1). Exactly one of:
 * - `password-now`: the person's password typed for this press (the CLI's hidden prompt), checked as a password typed
 *   now; never a session standing in, a remembered login, `cli-login`, Passwordless or freshness;
 * - `local-owner`: the laptop road (D1): the local owner's own act `ship-thread` in their live session, on an install
 *   where nobody has a password (flexible-laptop.ts laptopShipProblem, read at every step that acts on it).
 */
export type ShipProof = { kind: "password-now"; password: string }
  /** `held`: the person's own live session, compared whole with the one admitted (its lifetime included); asked before
   * the lock and again inside the consent's transaction (Codex round 1 of the build, finding 2). */
  | { kind: "local-owner"; held: () => boolean };
type ShipProved = { method: "password-now" } | { method: "local-owner"; localGeneration: number; accountGeneration: number };

/** The press's proof, now (before the lock, and again inside the consent's own transaction); a machine never ships. */
function shipProofNow(store: Store, by: string, proof: ShipProof, repo: string): FlexibleShipRefusal | ShipProved {
  if (machineActing()) return refuse("machine-proof");
  if (proof?.kind === "password-now") {
    if (typeof proof.password !== "string" || proof.password === "") return refuse("proof-refused");
    const proved = authenticateApprover(store, by, proof.password, repo);
    if (!proved.ok || !personProof(proved.method)) return refuse("proof-refused");
    // A password typed now, and nothing standing in for one.
    if (proved.method !== "password-now") return refuse("proof-refused");
    return { method: "password-now" };
  }
  if (proof?.kind !== "local-owner" || typeof proof.held !== "function") return refuse("proof-refused");
  if (!proof.held()) return refuse("proof-refused");
  const local = localActNow(store, "ship-thread");
  if (local === null || local.account !== by) return refuse("proof-refused");
  const problem = laptopShipProblem(store, { owner: by, localGeneration: local.localGeneration });
  if (problem !== null) return refuse("laptop", problem);
  return { method: "local-owner", localGeneration: local.localGeneration, accountGeneration: local.accountGeneration };
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

/** Where the project's pull requests go and what Toolroll may do there, from its live publication grant; null when it
 * can't push and open pull requests. */
function destinationOf(store: Store, repo: string): FlexibleShipTerms["github"] | null {
  const grant = store.publicationGrantFor(repo);
  if (grant === null || !grant.capabilities.includes("push-branch") || !grant.capabilities.includes("open-pr")) return null;
  return { repo: grant.githubRepo, remote: grant.remote, base: grant.base, method: grant.mergeMethod ?? "squash", capabilities: [...grant.capabilities].sort(), draft: grant.draft };
}

// ---- the terms, and the one press -------------------------------------------------------------------------------------

export type FlexibleShipText = { title?: string; goal?: string; acceptance?: unknown };

/**
 * The exact terms a Ship would sign now, from Toolroll's records and the thread's committed branch (read in a
 * quarantine, flexible-import.ts readFlexibleCandidate: nothing of the thread's runs), with their digest and the
 * approval summary the sheet shows. Only the thread's owner, an approver of a Flexible project with a check command.
 */
export async function flexibleShipTerms(store: Store, input: { thread: string; by: string; text?: FlexibleShipText; runner?: Runner }):
  Promise<{ ok: true; terms: FlexibleShipTerms; digest: string; summary: ApprovalSummary } | FlexibleShipRefusal | FlexibleImportRefusal> {
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
  const destination = destinationOf(store, thread.repo);
  if (destination === null) return refuse("no-publishing");
  const read = await readFlexibleCandidate(store, { thread: thread.id, ...(input.runner === undefined ? {} : { runner: input.runner }) });
  if (!read.ok) return read;
  const seq = nextSeq(store, thread.id);
  const terms: FlexibleShipTerms = {
    kind: "flexible-ship", version: FLEXIBLE_SHIP_VERSION, thread: thread.id, repo: thread.repo, owner: input.by, ownerGeneration: standing.generation, seq,
    base: read.base, candidate: read.candidate, branch: flexibleThreadBranch(thread.id), importRef: flexibleImportRef(thread.id, seq), changedPaths: read.changedPaths,
    title, goal, acceptance: parsed.criteria, outOfScope: SHIP_OUT_OF_SCOPE, check: { command: check.command, digest: check.digest }, merge: "when-checks-pass",
    github: destination, delegation: standing.termsDigest, network: flexibleNetworkOf(store, thread.repo), history: "beyond-base",
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
export async function shipFlexible(store: Store, input: { thread: string; by: string; proof: ShipProof; shownDigest: string; shownKey: string; text?: FlexibleShipText; now: Date; runner?: Runner }):
  Promise<FlexibleShipped | FlexibleShipRefusal | FlexibleImportRefusal> {
  const first = flexibleThread(store, input.thread);
  if (first === null) return refuse("thread-unknown");
  // Proved before the lock (a quick refusal), and again inside the transaction that records the yes.
  const proved = shipProofNow(store, input.by, input.proof, first.repo);
  if ("ok" in proved) return proved;
  const locked = await withFlexibleThreadLock(input.thread, () => shipLocked(store, input));
  if (locked.ok === false && (locked.reason === "not-available" || locked.reason === "thread-unknown")) return refuse(locked.reason);
  return locked as FlexibleShipped | FlexibleShipRefusal | FlexibleImportRefusal;
}

/** A refusal raised inside a transaction to roll it back whole. */
class ShipStop extends Error { constructor(readonly refusal: FlexibleShipRefusal) { super(refusal.message); } }

async function shipLocked(store: Store, input: { thread: string; by: string; proof: ShipProof; shownDigest: string; shownKey: string; text?: FlexibleShipText; now: Date; runner?: Runner }):
  Promise<FlexibleShipped | FlexibleShipRefusal | FlexibleImportRefusal> {
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
    // The proof again, here, in the transaction that records the yes, before anything is imported: a password
    // changed, a session ended or the laptop road gone since the first check refuses it.
    const again = shipProofNow(store, input.by, input.proof, thread.repo);
    if ("ok" in again) return again;
    const method = again.method;
    const standing = ownerStanding(store, thread, input.by);
    if ("ok" in standing) return standing;
    if (standing.generation !== terms.ownerGeneration) return refuse("stale-generation");
    if (again.method === "local-owner" && again.accountGeneration !== standing.generation) return refuse("stale-generation");
    if (standing.termsDigest !== terms.delegation) return refuse("changed");
    if (nextSeq(store, thread.id) !== terms.seq || store.handle.prepare("SELECT 1 FROM flexible_ship WHERE id = ?").get(digest) !== undefined) return refuse("changed");
    const branchBefore = branchHeld(store, thread.id);
    store.handle.prepare(`INSERT INTO flexible_ship (id, thread, seq, repo, base_sha, candidate, import_ref, branch, branch_before, terms_json, digest, summary_key, approved_by, approved_generation, proof, approved_at, delegation_id, state, state_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`).run(digest, thread.id, terms.seq, thread.repo, terms.base, terms.candidate, terms.importRef, terms.branch, branchBefore,
      canonicalJson(terms), digest, shown.summary.key, input.by, standing.generation, method, now, standing.termsId, now);
    // The laptop consent (D1), bound to the local-mode and account generations it was made under: every later step
    // that acts on it reads the laptop predicate again at that generation.
    if (again.method === "local-owner") store.handle.prepare("INSERT INTO flexible_ship_laptop (ship, owner, local_generation, account_generation, consented_at) VALUES (?, ?, ?, ?, ?)")
      .run(digest, input.by, again.localGeneration, again.accountGeneration, now);
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
  return fileAndSeal(store, { terms, digest, by: input.by, token: input.proof.kind === "password-now" ? input.proof.password : "", now: input.now, refsChanged: imported.refsChanged,
    ...(input.runner === undefined ? {} : { runner: input.runner }) });
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
      // Arming is a grant: only while interactive agent threads are on, read here, in the transaction that arms. Off, the
      // quarantined import stays (shown, removable, shippable again once they are on).
      if (!flexibleAvailable(store)) throw new ShipStop(refuse("not-available"));
      const row = store.handle.prepare("SELECT state FROM flexible_ship WHERE id = ?").get(digest);
      if (row?.["state"] !== "imported") throw new ShipStop(refuse("wrong-state"));
      // The laptop road (D1), read again in the transaction that seals: gone since the press, nothing is sealed.
      const laptop = laptopShipBinding(store, digest);
      if (laptop !== null) {
        const problem = laptopShipProblem(store, { owner: laptop.owner, localGeneration: laptop.localGeneration });
        if (problem !== null) throw new ShipStop(refuse("laptop", problem));
      }
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
  feedback: string | null; mergeHead: string | null; checkReceipt: string | null; mergeToken: string | null; mergeReservedAt: string | null; delegationId: number; stateAt: string;
  /** How the press was proved (flexible_ship.proof): `local-owner` is the laptop road (D1). */
  proof: string };

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
    detail: text("detail"), taskId: text("task_id"), scopeDigest: text("scope_digest"), feedback: text("feedback"), mergeHead: text("merge_head"), checkReceipt: text("check_receipt"),
    mergeToken: text("merge_token"), mergeReservedAt: text("merge_reserved_at"), delegationId: Number(row["delegation_id"]), stateAt: String(row["state_at"]), proof: String(row["proof"]) };
}

/** Every Ship of a thread, newest first: what the thread's Ship view shows (an imported Ship with no task among them). */
export function flexibleShipsOf(store: Store, thread: string): { ok: true; ships: FlexibleShipRow[] } | FlexibleShipRefusal {
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

/** Reservations this process holds while its merge call runs: never read back as uncertain while they're here. */
const inFlight = new Set<string>();
/** A reservation older than this, held by no merge running here, is uncertain: its outcome is read back from GitHub
 * (pull-request-flow.ts holds its own merge reservation for the same window). */
export const FLEXIBLE_STALE_MERGE_MS = 15 * 60_000;

/** End an armed (or completed) Ship for good, with why. Never a reserved one: that merge is past stopping. */
function cancelArmed(store: Store, ship: Pick<FlexibleShipRow, "id" | "repo" | "taskId">, why: string, now: Date, actor = "toolroll"): boolean {
  return store.transact(() => {
    const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'cancelled', detail = ?, state_at = ? WHERE id = ? AND state IN ('armed', 'completed')").run(why.slice(0, 2000), now.toISOString(), ship.id);
    if (Number(moved.changes) !== 1) return false;
    store.recordAction({ at: now.toISOString(), actor, repo: ship.repo, taskId: ship.taskId, runId: null, source: actor === "toolroll" ? "policy" : "work", action: "flexible merge cancelled", outcome: "cancelled", detail: why.slice(0, 2000) });
    return true;
  });
}

/**
 * Why the press's authority no longer holds for `ship`, or null. Read from Toolroll's records only, inside the caller's
 * transaction: the owner still an approver of the project, at the generation they shipped with, under exactly the
 * Flexible terms they shipped under (not a later row: a revoked delegation never comes back); the project not
 * two-person; the task's sealed scope unchanged and the task not cancelled; where it merges and what Toolroll may do
 * there exactly as signed; the project's check command exactly the signed one.
 */
function authorityProblem(store: Store, ship: FlexibleShipRow): string | null {
  const thread = flexibleThread(store, ship.thread);
  if (thread === null) return "its thread is gone";
  const standing = ownerStanding(store, thread, ship.approvedBy);
  if ("ok" in standing) return `the person's authority ended: ${standing.message}`;
  if (standing.generation !== ship.approvedGeneration) return "the person's account changed since they shipped it";
  if (standing.termsId !== ship.delegationId || standing.termsDigest !== ship.terms.delegation) return "the project's Flexible terms it was shipped under ended";
  if (ship.taskId === null || shipOfTask(store, ship.taskId) === null) return "its task's sealed terms no longer hold";
  if (store.getTask(ship.taskId)?.state === "cancelled") return "its task was cancelled";
  const destination = destinationOf(store, ship.repo);
  if (destination === null || canonicalJson(destination) !== canonicalJson(ship.terms.github)) return "where it merges, or what Toolroll may do there, changed since it was shipped";
  if (store.liveVerifyCommand(ship.repo)?.digest !== ship.terms.check.digest) return "the project's check command changed since it was shipped";
  // A laptop Ship (D1) holds only while the install is still one where nobody has a password, at the local-mode
  // generation it was shipped under: read here at every step that acts on it, and when it isn't, the Ship ends for
  // good (the caller cancels it), so putting the settings back never revives it.
  if (ship.proof === "local-owner") {
    const laptop = laptopShipBinding(store, ship.id);
    if (laptop === null) return "its laptop consent can't be read";
    const problem = laptopShipProblem(store, { owner: laptop.owner, localGeneration: laptop.localGeneration });
    if (problem !== null) return `it was shipped without a password from the workbench, and ${problem}`;
  }
  return null;
}

/** The newest builder run of a task, or null. */
function newestRun(store: Store, taskId: string) {
  const ref = store.lookupRef(taskId);
  const runs = ref === null ? [] : store.runsFor(ref.id).filter(one => one.role !== "reviewer");
  return runs.reduce<typeof runs[number] | null>((best, one) => (best === null || one.id > best.id ? one : best), null);
}

/** The digest of `runId`'s sealed check receipt (verification-evidence.ts) when it is the signed check command, on
 * exactly the shipped commit, passed; else null. The full check gate (fullCheckGate) must be clear too. */
function passingCheck(store: Store, root: string, runId: number, ship: FlexibleShipRow, now: Date): string | null {
  if (runCheckLevel(store, runId) === null || fullCheckGate(store, runId, now).state !== "clear") return null;
  const evidence = verificationEvidence(store, root, runId);
  if (!evidence.ok || evidence.bytes === null) return null;
  const view = readVerificationView(evidence.bytes);
  if (!view.ok) return null;
  const result = view.value.result as { exitCode?: unknown };
  return view.value.head === ship.candidate && view.value.command.digest === ship.terms.check.digest && result.exitCode === 0 ? evidence.digest : null;
}

export type FlexibleArmedStep = { ok: true; state: "waiting" | "completed" | "merged"; why?: string } | FlexibleShipRefusal;

/**
 * One step of an armed Ship's merge (the watch loop's pass runs it). Waits (and says why) while the result isn't
 * built or checked yet, its check didn't pass, or its pull request isn't open; never merges on a failed or missing
 * check. Ends the Ship for good when its authority lapsed (authorityProblem), the result isn't the shipped commit
 * itself (another commit, even with identical files, needs a new Ship), the head changed after completion, or the
 * base moved out from under it.
 *
 * Armed: once the newest result IS the candidate commit and its signed check passed on it, complete it and owe its
 * pull request to exactly the signed destination, binding the check's receipt. Completed: merge, through
 * mergePullRequest, whose own reservation transaction takes this Ship's reservation (completed → merging) after
 * re-proving everything, immediately before the call to GitHub. A cancel or revocation that lands first ends the Ship
 * and the merge refuses; once reserved, the outcome is recorded, or read back from GitHub when it's uncertain.
 */
export async function mergeArmedFlexible(store: Store, input: { taskId: string; root: string; exec?: PublishExec; clock?: () => Date; runner?: Runner }): Promise<FlexibleArmedStep> {
  if (!flexibleAvailable(store)) return refuse("not-available");
  const clock = input.clock ?? (() => new Date());
  const found = rowOfTask(store, input.taskId);
  if (found === null) return refuse("not-found");
  if (found.state === "merging") return { ok: true, state: "waiting", why: "its merge is under way; its outcome is read back from GitHub" };
  if (found.state !== "armed" && found.state !== "completed") return refuse("wrong-state", found.state);
  const stop = (why: string): FlexibleShipRefusal => { cancelArmed(store, found, why, clock()); return refuse("cancelled", why); };
  const lapsed = authorityProblem(store, found);
  if (lapsed !== null) return stop(lapsed);
  // The base still under the branch it merges into: a base rewritten out from under it is an incompatible move.
  let project: string;
  try { project = realpathSync(found.repo); } catch { return { ok: true, state: "waiting", why: "the project can't be read" }; }
  const read = hardenedGit(input.runner ?? run, "read", { repo: project });
  const based = await read("git", ["--no-replace-objects", "merge-base", "--is-ancestor", found.base, `refs/heads/${found.terms.github.base}`], { cwd: project, timeoutMs: 30_000 });
  if (based.code === 1) return stop(`its starting commit is no longer on ${found.terms.github.base}`);
  if (based.code !== 0) return { ok: true, state: "waiting", why: `${found.terms.github.base} couldn't be read` };
  const newest = newestRun(store, input.taskId);
  if (newest === null || newest.headRevision === null || newest.finishedAt == null) return { ok: true, state: "waiting", why: "its check task hasn't finished" };
  const head = newest.headRevision;
  // The exact commit the person shipped, never another with the same files.
  if (head !== found.candidate) return stop("the result isn't the shipped commit itself; another commit, even with identical files, needs a new Ship");
  const check = passingCheck(store, input.root, newest.id, found, clock());
  if (found.state === "armed") {
    if (check === null) return { ok: true, state: "waiting", why: "the check hasn't passed on this exact commit" };
    const receipt = assignmentOf(store, input.taskId, clock(), { principal: "operator", repos: [found.repo] }, input.root)?.receipt ?? null;
    if (receipt === null || receipt.runId !== newest.id || (receipt.head !== null && receipt.head !== head)) return { ok: true, state: "waiting", why: "its result isn't ready to complete yet" };
    // A lapsed authority ends the Ship for good: that cancellation is written and COMMITTED by the transaction below
    // (it returns; only the other refusals throw, to roll back what they began), and is said only after the commit.
    let cancelled: FlexibleShipRefusal | null = null;
    try {
      store.transact(() => {
        // Interactive agent threads still on, read in the transaction that completes (the reads above were async).
        if (!flexibleAvailable(store)) throw new ShipStop(refuse("not-available"));
        const again = rowOfTask(store, input.taskId);
        if (again === null || again.state !== "armed") throw new ShipStop(refuse("wrong-state"));
        const problem = authorityProblem(store, again);
        if (problem !== null) { cancelArmed(store, again, problem, clock()); cancelled = refuse("cancelled", problem); return; }
        const who = verifyApproverStanding(store, again.approvedBy, again.approvedGeneration, [again.repo]);
        if (!who.ok) throw new ShipStop(refuse("not-an-approver"));
        const opened = completeAndOpenPullRequest(store, { taskId: input.taskId, digest: receipt.digest, runId: newest.id, who: who.who, root: input.root }, clock());
        if (!opened.ok) throw new ShipStop(refuse("wrong-state", opened.message));
        if (opened.publication.headSha !== head || opened.publication.githubRepo !== again.terms.github.repo || opened.publication.base !== again.terms.github.base) {
          throw new ShipStop(refuse("wrong-state", "its pull request would go somewhere other than the shipped commit and destination"));
        }
        const at = clock().toISOString();
        store.handle.prepare("UPDATE flexible_ship SET state = 'completed', merge_head = ?, merge_at = ?, check_receipt = ?, state_at = ? WHERE id = ? AND state = 'armed'").run(head, at, check, at, again.id);
        store.recordAction({ at, actor: again.approvedBy, repo: again.repo, taskId: input.taskId, runId: newest.id, source: "work", action: "flexible ship completed", outcome: head,
          detail: `ship ${again.id} · checked head ${head} · check receipt ${check} · pull request owed to ${again.terms.github.repo} ${again.terms.github.base}` });
      });
    } catch (error) {
      if (error instanceof ShipStop) return error.refusal.reason === "cancelled" ? error.refusal : { ok: true, state: "waiting", why: error.refusal.message };
      throw error;
    }
    if (cancelled !== null) return cancelled;
    return { ok: true, state: "completed" };
  }
  // Completed: merge exactly the checked head, through its pull request to the signed destination.
  const publication = store.publicationForRun(newest.id);
  if (head !== found.mergeHead || publication === null || publication.headSha !== found.mergeHead) return stop("the result's head changed since its check passed");
  if (publication.githubRepo !== found.terms.github.repo || publication.base !== found.terms.github.base) return stop("its pull request goes somewhere other than the signed destination");
  if (check === null || check !== found.checkReceipt) return { ok: true, state: "waiting", why: "the check no longer stands on this exact commit" };
  if (publication.prNumber === null) return { ok: true, state: "waiting", why: "its pull request isn't open yet" };
  const prNumber = publication.prNumber;
  const token = randomBytes(16).toString("hex");
  // Where it may land, on GitHub's own view: the signed repository, base and number, on exactly the checked head.
  const destination = (seen: PullRequestSeen): string | null =>
    pullRequestElsewhere(found, seen, prNumber) ?? (seen.head !== found.mergeHead ? "its pull request on GitHub shows another commit than the one whose check passed" : null);
  inFlight.add(token);
  let merged: Awaited<ReturnType<typeof mergePullRequest>>;
  try {
    merged = await mergePullRequest(store, { runId: newest.id, by: found.approvedBy, flexibleShip: found.id, flexibleToken: token, clock, destination, ...(input.exec === undefined ? {} : { exec: input.exec }),
      proceed: seen => reserveMerge(store, { ship: found.id, token, runId: newest.id, root: input.root, now: clock(), seen, prNumber }) });
  } finally { inFlight.delete(token); }
  // A merge GitHub shows somewhere else (another base or repository, another head, or merged by someone else there) is
  // never this Ship's: it ends cancelled, said as it is, whether GitHub reported it before the call or after.
  const landedElsewhere = merged.ok ? (merged.seen === undefined ? "GitHub didn't say where it merged" : destination(merged.seen)) : merged.reason === "elsewhere" ? merged.message : null;
  if (landedElsewhere !== null) {
    store.transact(() => {
      const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'cancelled', merge_token = NULL, merge_reserved_at = NULL, detail = ?, state_at = ? WHERE id = ? AND state IN ('completed', 'merging')")
        .run(`${landedElsewhere} (GitHub reports it merged there, not as this Ship's merge)`.slice(0, 2000), clock().toISOString(), found.id);
      if (Number(moved.changes) === 1) store.recordAction({ at: clock().toISOString(), actor: "toolroll", repo: found.repo, taskId: input.taskId, runId: newest.id, source: "policy",
        action: "flexible merge cancelled", outcome: "merged-elsewhere", detail: `ship ${found.id} · ${landedElsewhere}`.slice(0, 2000) });
    });
    return refuse("cancelled", landedElsewhere);
  }
  const after = rowOfTask(store, input.taskId);
  if (merged.ok) {
    store.transact(() => {
      store.handle.prepare("UPDATE flexible_ship SET state = 'merged', merge_token = NULL, merge_reserved_at = NULL, state_at = ? WHERE id = ? AND state IN ('merging', 'completed')").run(clock().toISOString(), found.id);
      store.recordAction({ at: clock().toISOString(), actor: found.approvedBy, repo: found.repo, taskId: input.taskId, runId: newest.id, source: "work", action: "flexible merged", outcome: merged.commit ?? "merged",
        detail: `ship ${found.id} · head ${head}${after?.state === "completed" ? " · found already merged on GitHub" : ""}` });
    });
    return { ok: true, state: "merged" };
  }
  if (after?.state === "cancelled") return refuse("cancelled", after.detail ?? merged.message);
  // Reserved, and the call didn't merge (or said so unclearly): GitHub says what happened.
  if (after?.state === "merging" && after.mergeToken === token) return settleMerging(store, after, input.exec, clock);
  return { ok: true, state: "waiting", why: merged.message };
}

/**
 * The reservation (completed → merging), taken INSIDE mergePullRequest's own reservation transaction, immediately
 * before its call to GitHub: the Ship still completed (not cancelled), its authority re-proved (authorityProblem), the
 * newest result still the shipped commit and the checked head, the signed check's receipt the one bound at
 * completion. A lapsed authority cancels the Ship in this same transaction; anything else waits. True when reserved.
 */
function reserveMerge(store: Store, input: { ship: string; token: string; runId: number; root: string; now: Date; seen: { base: string | null; url: string | null; head: string | null }; prNumber: number }): boolean {
  // Interactive agent threads still on, read in this reservation transaction (GitHub was read just before): off, nothing
  // is reserved and the Ship waits.
  if (!flexibleAvailable(store)) return false;
  const ship = readRow(store.handle.prepare("SELECT * FROM flexible_ship WHERE id = ?").get(input.ship) as Record<string, unknown> | undefined);
  if (ship === null || ship.state !== "completed" || ship.taskId === null) return false;
  // Where GitHub would actually merge it, read just before this: the pull request's own base branch and repository must
  // be the signed ones. A pull request retargeted elsewhere (same head, same green checks) ends the Ship.
  const elsewhere = pullRequestElsewhere(ship, input.seen, input.prNumber);
  const problem = elsewhere ?? authorityProblem(store, ship);
  if (problem !== null) { cancelArmed(store, ship, problem, input.now); return false; }
  const newest = newestRun(store, ship.taskId);
  if (newest === null || newest.id !== input.runId || newest.headRevision !== ship.candidate || ship.mergeHead !== ship.candidate) return false;
  if (passingCheck(store, input.root, newest.id, ship, input.now) !== ship.checkReceipt) return false;
  const at = input.now.toISOString();
  const moved = store.handle.prepare("UPDATE flexible_ship SET state = 'merging', merge_token = ?, merge_reserved_at = ?, state_at = ? WHERE id = ? AND state = 'completed'").run(input.token, at, at, ship.id);
  if (Number(moved.changes) !== 1) return false;
  store.recordAction({ at, actor: ship.approvedBy, repo: ship.repo, taskId: ship.taskId, runId: newest.id, source: "work", action: "flexible merge reserved", outcome: ship.candidate, detail: `ship ${ship.id}` });
  return true;
}

/**
 * A reserved merge's outcome, read back from GitHub (the call returned unclearly, or the process died during it): merged
 * there → merged; still open on the shipped commit → released (completed: the next step re-proves everything before it
 * reserves again); closed, or moved to another commit → cancelled. Unreadable: left reserved, read again later.
 */
async function settleMerging(store: Store, ship: FlexibleShipRow, exec: PublishExec | undefined, clock: () => Date): Promise<FlexibleArmedStep> {
  const newest = ship.taskId === null ? null : newestRun(store, ship.taskId);
  const publication = newest === null ? null : store.publicationForRun(newest.id);
  if (publication === null || publication.prNumber === null) return { ok: true, state: "waiting", why: "its merge's outcome can't be read yet" };
  const viewed = await (exec ?? run)("gh", ["pr", "view", String(publication.prNumber), "--repo", ship.terms.github.repo, "--json", "state,headRefOid,mergeCommit,baseRefName,url"], { timeoutMs: 60_000 });
  let state = "", headOid: string | null = null, commit: string | null = null, base: string | null = null, url: string | null = null;
  try {
    const payload = JSON.parse(viewed.stdout) as { state?: unknown; headRefOid?: unknown; mergeCommit?: { oid?: unknown } | null; baseRefName?: unknown; url?: unknown };
    state = String(payload.state ?? "").toUpperCase();
    headOid = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
    commit = typeof payload.mergeCommit?.oid === "string" ? payload.mergeCommit.oid : null;
    base = typeof payload.baseRefName === "string" ? payload.baseRefName : null;
    url = typeof payload.url === "string" ? payload.url : null;
  } catch { state = ""; }
  if (viewed.code !== 0 || state === "") return { ok: true, state: "waiting", why: "GitHub couldn't be read to settle the merge" };
  const at = clock().toISOString();
  // The same destination check as the reservation: a pull request GitHub shows targeting anything but the signed base
  // and repository is never released or counted as this Ship's merge; it ends cancelled, said as it is.
  const elsewhere = pullRequestElsewhere(ship, { base, url }, publication.prNumber);
  const outcome: "merged" | "completed" | "cancelled" = elsewhere !== null ? "cancelled" : state === "MERGED" ? "merged" : state === "OPEN" && headOid === ship.mergeHead ? "completed" : "cancelled";
  const why = elsewhere !== null ? `${elsewhere}${state === "MERGED" ? " (GitHub merged it there)" : ""}` : `its pull request is ${state.toLowerCase()} on GitHub${headOid !== ship.mergeHead ? " on another commit" : ""}`;
  store.transact(() => {
    const moved = store.handle.prepare(`UPDATE flexible_ship SET state = ?, merge_token = NULL, merge_reserved_at = NULL, state_at = ?${outcome === "cancelled" ? ", detail = ?" : ""} WHERE id = ? AND state = 'merging' AND merge_token = ?`)
      .run(...(outcome === "cancelled" ? [outcome, at, why.slice(0, 2000), ship.id, ship.mergeToken] : [outcome, at, ship.id, ship.mergeToken]));
    if (Number(moved.changes) !== 1) return;
    store.recordAction({ at, actor: "toolroll", repo: ship.repo, taskId: ship.taskId, runId: newest?.id ?? null, source: "policy", action: outcome === "merged" ? "flexible merged" : outcome === "completed" ? "flexible merge released" : "flexible merge cancelled",
      outcome: outcome === "merged" ? commit ?? "merged" : outcome, detail: `ship ${ship.id} · read back from GitHub: ${state.toLowerCase()}` });
  });
  if (outcome === "merged") return { ok: true, state: "merged" };
  if (outcome === "completed") return { ok: true, state: "waiting", why: "the merge didn't happen; it will be tried again once everything still holds" };
  return refuse("cancelled", why);
}

/** Why GitHub's view of the pull request isn't the signed destination (its base branch, its repository, its number), or
 * null when it is. */
function pullRequestElsewhere(ship: FlexibleShipRow, seen: { base: string | null; url: string | null }, prNumber: number): string | null {
  const address = `https://github.com/${ship.terms.github.repo}/pull/${prNumber}`;
  if (seen.base !== ship.terms.github.base || seen.url === null || seen.url.toLowerCase() !== address.toLowerCase()) {
    return `its pull request on GitHub targets ${seen.base ?? "an unknown branch"}${seen.url !== null && seen.url.toLowerCase() !== address.toLowerCase() ? ` at ${seen.url}` : ""}, not the signed ${ship.terms.github.repo} ${ship.terms.github.base}`;
  }
  return null;
}

/** Reserved merges whose outcome is uncertain (held by no merge running here, past the window), settled from GitHub. */
async function settleUncertainMerges(store: Store, exec: PublishExec | undefined, clock: () => Date): Promise<number> {
  const before = new Date(clock().getTime() - FLEXIBLE_STALE_MERGE_MS).toISOString();
  const rows = store.handle.prepare("SELECT * FROM flexible_ship WHERE state = 'merging' AND merge_reserved_at < ?").all(before) as Record<string, unknown>[];
  let settled = 0;
  for (const raw of rows) {
    const ship = readRow(raw);
    if (ship === null || ship.mergeToken === null || inFlight.has(ship.mergeToken)) continue;
    const step = await settleMerging(store, ship, exec, clock);
    if (!step.ok || step.state !== "waiting" || rowOfTask(store, ship.taskId!)?.state !== "merging") settled++;
  }
  return settled;
}

/**
 * Settle the Ships a crash interrupted mid-import (left `approved`): under each thread's lock (held by any Ship still
 * running, so a live one is never touched), the import's ref and the thread's branch are put back by compare-and-swap
 * where they hold this Ship's candidate, and the Ship ends `failed` (interrupted), shippable again as n+1.
 */
export async function reconcileFlexibleShips(store: Store, input: { now: Date; runner?: Runner; lockWaitMs?: number }): Promise<{ ok: true; settled: number } | FlexibleShipRefusal> {
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
 * An armed merge waits while interactive agent threads are off; settling runs whatever the switch says.
 */
export async function flexibleArmedPass(store: Store, input: { root: string; exec?: PublishExec; clock?: () => Date; runner?: Runner }): Promise<FlexibleArmedReport | FlexibleShipRefusal> {
  const clock = input.clock ?? (() => new Date());
  const runner = input.runner === undefined ? {} : { runner: input.runner };
  const reconciled = await reconcileFlexibleShips(store, { now: clock(), ...runner });
  const uncertain = await settleUncertainMerges(store, input.exec, clock);
  const report: FlexibleArmedReport = { ok: true, reconciled: (reconciled.ok ? reconciled.settled : 0) + uncertain, completed: 0, merged: 0, cancelled: 0, waiting: 0 };
  const tasks = store.handle.prepare("SELECT task_id FROM flexible_ship WHERE state IN ('armed', 'completed') ORDER BY approved_at").all().map(row => String(row["task_id"]));
  for (const taskId of tasks) {
    let step: FlexibleArmedStep;
    // One Ship's failure (a merge call that threw leaves its reservation for settleUncertainMerges) never stops the rest.
    try { step = await mergeArmedFlexible(store, { taskId, root: input.root, clock, ...runner, ...(input.exec === undefined ? {} : { exec: input.exec }) }); }
    catch { report.waiting++; continue; }
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
  if (ship.approvedBy !== by.name) return refuse("not-owner");
  if (ship.state === "merging") return refuse("merging");
  if (ship.state !== "armed" && ship.state !== "completed") return refuse("wrong-state", ship.state);
  const account = store.accountOf(by.name);
  if (account === null || account.revokedAt !== null || account.generation !== by.generation) return refuse("stale-generation");
  return ship;
}

/** Cancel: the person stops a Ship's armed merge for good. Its check task is cancelled where it still can be; a pull
 * request already open stays open, unmerged. */
export function cancelFlexibleShip(store: Store, input: { taskId: string; by: { name: string; generation: number }; now: Date }): { ok: true } | FlexibleShipRefusal {
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
