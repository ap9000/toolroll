/**
 * One-tap release approval (docs/plans/trusted-release-reports.md, slice A v3): the plane's side of one push, one
 * screen and one proof for a release a person must approve.
 *
 * - `releaseApprovalCard`: the authoritative card snapshot of a release task waiting for its person, for the sheet
 *   (`/t/<id>/release`) and `toolroll release approve`: either sealed form (release terms or a release check's purpose),
 *   the change list, GitHub CI as the coordinator last read it on the exact commit, why it can't be approved now (shown,
 *   never hidden) and the card digest, which binds all of it.
 * - `approveReleaseCard`: the one wrapper both doors call. It rebuilds the card, compares the digest the person saw,
 *   re-reads the store's parts inside one transaction and only then passes THAT snapshot's scope digest into the
 *   unchanged transactional `approve()` the caller hands in. The digest is never swapped after the person was asked.
 * - The notification's whole life: `noteReleaseReady` (one per task and scope digest, older ones resolved), the push
 *   class derived at send time from the plane's own state (`releasePushOf`), `noteReleaseStopped` for a manual
 *   release's stop, and the coordinator's CI snapshots (`recordReleaseCi`).
 * Nothing here proves a person, widens a proof or seals anything itself.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { permissionPlainWords } from "./chat-terms.js";
import { approvalTermsOf, releaseAccessWords, releaseCardOf, releaseSealOf, type PullRequestReader, type ReleaseCard, type ReleaseSeal, type TermLine } from "./release-card.js";
import { approvalOf, type ApproveResult, type Scope } from "./scope.js";
import { releaseProgressFor, type Notification, type Store } from "./store.js";
import { taskArchived } from "./task-archive.js";
import { cleanTerminalLine } from "./terminal-text.js";
import { ciName, ciWords, refusalOf, releaseCiOf, RELEASE_CI_SEEN_ACTION, type ReleaseCiRun, type ReleaseCiSnapshot } from "./release-refusal.js";

// The CI reading and the refusals live in release-refusal.ts, so scope.ts approve() can read them without a cycle.
export { ciWords, releaseApprovalRefusal, releaseCiOf, RELEASE_CI_SEEN_ACTION, type ReleaseCiRun, type ReleaseCiSnapshot } from "./release-refusal.js";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** A scope digest as scope.ts writes it. */
const SCOPE_DIGEST = /^[0-9a-f]{32,64}$/;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---- GitHub CI as the coordinator read it -------------------------------------------------------------------------

/**
 * Record what the coordinator just read of the pull request's CI on `candidate` (its verdict and every check's newest
 * attempt), when it differs from the last reading recorded: the sheet and the CLI show it, and the card digest binds
 * it. The coordinator is Toolroll's own runtime reading GitHub through the plane's recorded repository.
 */
export function recordReleaseCi(store: Store, input: { taskId: string; candidate: string; state: ReleaseCiSnapshot["state"]; failed: readonly string[];
  runs: readonly { id?: number | null; name: string; status: string; conclusion: string | null }[]; now: Date }): boolean {
  if (!SHA.test(input.candidate) || store.lookupRef(input.taskId) === null) return false;
  // The newest attempt of each check (the adapter lists attempts oldest first), by name.
  const latest = new Map<string, ReleaseCiRun>();
  for (const run of input.runs.slice(0, 2_000)) {
    const name = ciName(run.name);
    if (name === "") continue;
    latest.set(name, { id: typeof run.id === "number" && Number.isSafeInteger(run.id) ? run.id : null, name, status: ciName(run.status).slice(0, 40), conclusion: run.conclusion === null ? null : ciName(run.conclusion).slice(0, 40) });
  }
  const runs = [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
  const detail = JSON.stringify({ v: 1, candidate: input.candidate, state: input.state, failed: input.failed.map(ciName).slice(0, 50), runs });
  const last = store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(input.taskId, RELEASE_CI_SEEN_ACTION);
  if (last !== undefined && last["detail"] === detail) return false;
  store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: store.lookupRef(input.taskId)?.repo ?? null, taskId: input.taskId, runId: null,
    action: RELEASE_CI_SEEN_ACTION, outcome: input.state, source: "work", detail });
  return true;
}

/** What of a CI reading the card binds: its state and each check's attempt, whether it finished, and how. Queued and
 * in progress read alike (neither is finished); the time it was read is not bound. */
export function ciBinding(ci: ReleaseCiSnapshot | null): unknown {
  return ci === null ? null : { candidate: ci.candidate, state: ci.state, failed: ci.failed, runs: ci.runs.map(run => [run.id, run.name, run.status === "completed", run.conclusion]) };
}

// ---- the card --------------------------------------------------------------------------------------------------

export type ReleaseApprovalCard = {
  taskId: string;
  taskRef: number;
  repo: string;
  scope: Scope;
  seal: ReleaseSeal;
  /** The chat release card (release-card.ts): the change list and its own digest. */
  card: ReleaseCard;
  /** Every signed term, one line each (release-card.ts approvalTermsOf). */
  terms: TermLine[];
  ci: ReleaseCiSnapshot | null;
  /** Why it can't be approved now, in words; null when it can (or already is). */
  refusal: string | null;
  approved: { by: string; at: string } | null;
  /** The release coordinator stopped (its last step failed): approving needs `toolroll release` run again. */
  stopped: { step: string; message: string } | null;
  /** Binds everything above that a person is shown and can change under them. */
  digest: string;
};

/** A release task from the plane's own state: a sealed form (terms or a release check's purpose) whose repository is the
 * task's project and whose approved commit is the scope's candidate. Never from a title or a task id. */
export function releaseTaskOf(store: Store, taskId: string): { ref: { id: number; repo: string }; scope: Scope; seal: ReleaseSeal } | null {
  const ref = store.lookupRef(taskId);
  const scope = store.getScope(taskId);
  const seal = releaseSealOf(scope);
  if (ref === null || ref.repo === null || scope === null || seal === null || scope.candidate == null || scope.candidate !== seal.identity.approvedSha || seal.identity.repo !== ref.repo) return null;
  return { ref: { id: ref.id, repo: ref.repo }, scope, seal };
}

/** The authoritative card for a release task waiting for its person, or why there is none. Reads only. */
export function releaseApprovalCard(store: Store, taskId: string, options: { read?: PullRequestReader } = {}): { ok: true; card: ReleaseApprovalCard } | { ok: false; why: string } {
  const found = releaseTaskOf(store, taskId);
  if (found === null) return { ok: false, why: "This isn't a release waiting for approval." };
  const { ref, scope, seal } = found;
  const terms = approvalTermsOf(store, scope, { profile: permissionPlainWords });
  const card = releaseCardOf(store, scope, scope.digest, { profile: permissionPlainWords }, options.read);
  const ci = releaseCiOf(store, taskId, scope.candidate!);
  const approval = approvalOf(scope);
  const approved = approval.approved ? { by: approval.by, at: approval.at } : null;
  const refusal = approved === null ? refusalOf(store, taskId, scope, ci) : null;
  const progress = releaseProgressFor(store, taskId);
  const stopped = progress?.stopped == null ? null : { step: progress.stopped.step, message: cleanTerminalLine(progress.stopped.message).slice(0, 300) };
  const digest = sha256(`release-sheet:v1:${JSON.stringify([card.digest, scope.digest, ciBinding(ci), refusal, approved])}`);
  return { ok: true, card: { taskId, taskRef: ref.id, repo: ref.repo, scope, seal, card, terms, ci, refusal, approved, stopped, digest } };
}

/** What approving does, in the sheet's and the CLI's words: the consequence, the check's access, and whether later
 * commits carry. */
export function releaseConsequence(card: ReleaseApprovalCard): string[] {
  const id = card.seal.identity;
  const carries = card.seal.kind === "terms" && card.seal.terms.policy.carry;
  return [
    `Approving runs the release check on ${id.approvedSha.slice(0, 7)}, then deploys, merges, tags and publishes once GitHub CI and the check pass.`,
    ...(releaseAccessWords(id.access) === null ? [] : [releaseAccessWords(id.access)!]),
    carries ? "Later commits that only change tests, docs or the changelog carry this approval." : "Every later commit asks again.",
  ];
}

export type ReleaseCardRefusal = { ok: false; reason: "not-release" | "changed" | "approved" | "refused"; message: string } | { ok: false; reason: "approve"; result: Exclude<ApproveResult, { ok: true }> };

/**
 * The one card-approval wrapper (Codex round 2, finding 2): rebuild the authoritative card and compare the digest the
 * person saw; then, in one transaction, re-read the store's parts (the scope digest, the CI reading, the refusal state)
 * and refuse on any change; then hand THAT snapshot's scope digest to `approveNow`, the caller's unchanged
 * transactional `approve()`, which proves the person and seals. Nothing here proves anyone.
 */
export function approveReleaseCard(store: Store, input: { taskId: string; cardDigest: string; read?: PullRequestReader; approveNow: (scopeDigest: string) => ApproveResult }):
  { ok: true; scope: Scope } | ReleaseCardRefusal {
  if (!DIGEST.test(input.cardDigest)) return { ok: false, reason: "changed", message: "This release changed while you were reading it. Read it again." };
  const built = releaseApprovalCard(store, input.taskId, input.read === undefined ? {} : { read: input.read });
  if (!built.ok) return { ok: false, reason: "not-release", message: built.why };
  const card = built.card;
  if (card.digest !== input.cardDigest) return { ok: false, reason: "changed", message: "This release changed while you were reading it. Read it again." };
  if (card.approved !== null) return { ok: false, reason: "approved", message: `Already approved by ${card.approved.by}.` };
  if (card.refusal !== null) return { ok: false, reason: "refused", message: card.refusal };
  return store.transact(() => {
    const scope = store.getScope(input.taskId);
    if (scope === null || scope.digest !== card.scope.digest || approvalOf(scope).approved) return { ok: false as const, reason: "changed" as const, message: "This release changed while you were reading it. Read it again." };
    const ci = releaseCiOf(store, input.taskId, card.scope.candidate!);
    const refusal = refusalOf(store, input.taskId, scope, ci);
    if (JSON.stringify(ciBinding(ci)) !== JSON.stringify(ciBinding(card.ci)) || refusal !== card.refusal) {
      return { ok: false as const, reason: "changed" as const, message: "This release changed while you were reading it. Read it again." };
    }
    const result = input.approveNow(card.scope.digest);
    return result.ok ? { ok: true as const, scope: result.scope } : { ok: false as const, reason: "approve" as const, result };
  });
}

// ---- notifications --------------------------------------------------------------------------------------------

export const RELEASE_READY_KIND = "release-ready";
export const RELEASE_STOPPED_KIND = "release-stopped";
/** The one push phrase for a release waiting on its person (push.ts PUSH_WORDS.release). */
export const RELEASE_PUSH_WORDS = "A release is ready for your approval";
const READY_KEY = /^release-ready:([1-9][0-9]{0,14}):([0-9a-f]{32,64})$/;

/** The sheet's own address for a task (the in-app link; a push carries the opaque `/approve/<task ref>` instead). */
export const releaseSheetHref = (taskId: string): string => `/t/${encodeURIComponent(taskId)}/release`;

/**
 * The coordinator asked a person (on entering the approval step, a fresh filing or a resumed one): one notification per
 * task and stable scope digest, so a crash between filing and asking is healed by the next run and a repeat says nothing
 * new. Every older `release-ready` row of the project (another task or digest) is resolved first. Nothing when the task
 * isn't a release waiting for a person.
 */
export function noteReleaseReady(store: Store, input: { taskId: string; now: Date }): boolean {
  return store.transact(() => {
    const found = releaseTaskOf(store, input.taskId);
    if (found === null || approvalOf(found.scope).approved || taskArchived(store, input.taskId)) return false;
    const key = `release-ready:${found.ref.id}:${found.scope.digest}`;
    store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE kind = ? AND resolved_at IS NULL AND project = ? AND dedupe_key <> ?")
      .run(input.now.toISOString(), RELEASE_READY_KIND, found.ref.repo, key);
    const id = found.seal.identity;
    const short = id.approvedSha.slice(0, 7);
    const ci = releaseCiOf(store, input.taskId, id.approvedSha);
    const body = ci?.state === "passed"
      ? `GitHub CI passed on ${short}. Approve to run the release check, deploy, merge and publish.`
      : `Release ${id.packageVersion} (${short}) is ready to approve. You can approve now: Toolroll runs the release check after your yes, and deploys, merges and publishes only once GitHub CI and the check pass. You're told if something fails.`;
    return store.enqueueNotification({ dedupeKey: key, kind: RELEASE_READY_KIND, pushClass: "decision", link: releaseSheetHref(input.taskId), source: { taskRef: found.ref.id },
      subject: `Release ${id.packageVersion} is ready for your approval`, body }, input.now);
  });
}

/** Resolve a task's `release-ready` rows (it was approved, or the release stopped): a push not sent yet never is. */
export function retireReleaseReady(store: Store, taskRef: number, now: Date): number {
  return Number(store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE kind = ? AND resolved_at IS NULL AND task_ref = ?").run(now.toISOString(), RELEASE_READY_KIND, taskRef).changes);
}

/**
 * The push class `release` and its link, derived at send time from the plane's own state, never from a title, a task id,
 * the stored link or the stored class: the row is a `release-ready` row for exactly its task ref and a scope digest, and
 * that task is a release scope (terms or a release check's purpose, its candidate the approved commit), not put away,
 * not approved, at that same digest. Null otherwise.
 */
export function releasePushOf(store: Store, notification: Pick<Notification, "kind" | "dedupeKey" | "taskRef" | "resolvedAt">): { link: string } | null {
  if (notification.kind !== RELEASE_READY_KIND || notification.taskRef === null || notification.resolvedAt !== null) return null;
  const key = READY_KEY.exec(notification.dedupeKey);
  if (key === null || Number(key[1]) !== notification.taskRef) return null;
  const ref = store.refForId(notification.taskRef);
  if (ref === null || ref.backend !== "built-in") return null;
  const found = releaseTaskOf(store, ref.externalId);
  if (found === null || found.ref.id !== notification.taskRef) return null;
  if (found.scope.digest !== key[2] || approvalOf(found.scope).approved || taskArchived(store, ref.externalId)) return null;
  return { link: `/approve/${notification.taskRef}` };
}

/** A `release-ready` row that no longer stands (the push pass resolves it instead of sending it). */
export function releaseReadyObsolete(store: Store, notification: Pick<Notification, "kind" | "dedupeKey" | "taskRef" | "resolvedAt">): boolean {
  return notification.kind === RELEASE_READY_KIND && releasePushOf(store, notification) === null;
}

/**
 * A person's release stopped (CI failed, the check failed, the deploy, the merge, the tag or publication failed, or it
 * stopped waiting): one attention notification per task, step and reason, with the stop's words in the app (the push
 * says only the fixed attention phrase). Its `release-ready` row is resolved, except while it only stopped waiting
 * for the approval (the sheet still approves it then).
 */
export function noteReleaseStopped(store: Store, input: { taskId: string; step: string; reason: string; message: string; now: Date }): boolean {
  const ref = store.lookupRef(input.taskId);
  if (ref === null) return false;
  const step = /^[a-z-]{1,20}$/.test(input.step) ? input.step : "release";
  const reason = /^[a-z-]{1,40}$/.test(input.reason) ? input.reason : "error";
  return store.transact(() => {
    if (!(step === "approval" && reason === "timeout")) retireReleaseReady(store, ref.id, input.now);
    const seal = releaseSealOf(store.getScope(input.taskId));
    const words = cleanTerminalLine(input.message).replace(/\s+/g, " ").trim().slice(0, 600);
    return store.enqueueNotification({ dedupeKey: `release-stopped:${ref.id}:${step}:${reason}`, kind: RELEASE_STOPPED_KIND, pushClass: "attention",
      link: `/t/${encodeURIComponent(input.taskId)}`, source: { taskRef: ref.id },
      subject: `Release${seal === null ? "" : ` ${seal.identity.packageVersion}`} stopped at ${step}`, body: words === "" ? "The release stopped. Open it to see why." : words }, input.now);
  });
}

// ---- the terminal -------------------------------------------------------------------------------------------------

/** The card as the CLI prints it, every line control-free (src/terminal-text.ts). */
export function releaseCardLines(card: ReleaseApprovalCard): string[] {
  const id = card.seal.identity;
  const changes = card.card.changes;
  const lines = [
    `Release ${id.packageVersion} · pull request #${id.pr} · ${id.branch}`,
    `Commit ${id.approvedSha}`,
    ciWords(card.ci, id.approvedSha),
    ...releaseConsequence(card),
    ...(card.stopped === null ? [] : [`The release isn't running (it stopped at ${card.stopped.step}). After you approve, run \`toolroll release ${id.branch}\`.`]),
    "",
    changes.commits === null
      ? `What changed couldn't be read${changes.why === undefined ? "" : ` (${changes.why})`}.`
      : changes.baseline === null ? `Pull request #${id.pr}'s commits (${changes.commits.length}):` : `Changes since the last verified release (${changes.baseline.slice(0, 7)}), ${changes.commits.length}:`,
    ...(changes.commits ?? []).map(one => `  ${one.sha.slice(0, 7)} ${one.subject}`),
    "",
    "Every term:",
    ...card.terms.map(line => `  ${line.label}: ${line.value}`),
    ...(card.refusal === null ? [] : ["", `Can't approve now: ${card.refusal}`]),
  ];
  return lines.map(cleanTerminalLine);
}

// ---- `toolroll release approve`: which release ----------------------------------------------------------------------

/** One release journal as discovery reads it: strictly, every field it relies on in its exact shape. */
export type WaitingJournal = { file: string; branch: string; checkout: string; taskId: string; scopeDigest: string; candidate: string; version: string; pr: number };

const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,200}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** A journal's own fields, strictly; null when any is missing or not its exact shape. */
export function readWaitingJournal(file: string, raw: unknown, expectedFile: (branch: string) => string): WaitingJournal | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  const task = j["task"] as Record<string, unknown> | null | undefined;
  const candidate = j["candidate"] as Record<string, unknown> | null | undefined;
  if (j["version"] !== 1 || (j["step"] !== "approval" && j["step"] !== "gate")) return null;
  if (typeof j["branch"] !== "string" || !BRANCH.test(j["branch"]) || j["branch"].startsWith("-") || j["branch"].includes("..")) return null;
  if (typeof j["checkout"] !== "string" || !j["checkout"].startsWith("/") || typeof j["packageVersion"] !== "string" || !VERSION.test(j["packageVersion"])) return null;
  if (typeof j["pr"] !== "number" || !Number.isSafeInteger(j["pr"]) || j["pr"] < 1) return null;
  if (task === null || typeof task !== "object" || typeof task["id"] !== "string" || !TASK_ID.test(task["id"]) || typeof task["scopeDigest"] !== "string" || !SCOPE_DIGEST.test(task["scopeDigest"])) return null;
  if (candidate === null || typeof candidate !== "object" || typeof candidate["sha"] !== "string" || !SHA.test(candidate["sha"])) return null;
  // The file must be the one its own branch maps to: two branches that map to one file name never stand in for each other.
  if (expectedFile(j["branch"]) !== file) return null;
  return { file, branch: j["branch"], checkout: j["checkout"], taskId: task["id"], scopeDigest: task["scopeDigest"], candidate: candidate["sha"], version: j["packageVersion"], pr: j["pr"] };
}

const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };

/**
 * Whether a journal (discovery only) names exactly the release the plane sealed: the task is a release scope whose
 * sealed identity has this exact branch, version, pull request and candidate at this scope digest, and the journal's
 * checkout, the task's project and the sealed repository are one real folder (`repo` too, when given). Why not, in words.
 */
export function journalMatchesPlane(store: Store, journal: WaitingJournal, repo: string | null): { ok: true } | { ok: false; why: string } {
  const found = releaseTaskOf(store, journal.taskId);
  if (found === null) return { ok: false, why: `${journal.branch}'s release task isn't a release this plane can approve` };
  const id = found.seal.identity;
  if (id.branch !== journal.branch || id.packageVersion !== journal.version || id.pr !== journal.pr || id.approvedSha !== journal.candidate) {
    return { ok: false, why: `${journal.branch}'s journal doesn't name the release the plane sealed (branch ${id.branch}, ${id.packageVersion}, #${id.pr}, ${id.approvedSha.slice(0, 7)})` };
  }
  if (found.scope.digest !== journal.scopeDigest) return { ok: false, why: `the release's terms changed since ${journal.branch} was filed; run \`toolroll release\` again` };
  const checkout = real(journal.checkout), project = real(found.ref.repo), sealed = real(id.repo);
  if (checkout === null || project === null || checkout !== project || sealed !== project) return { ok: false, why: `${journal.branch}'s checkout isn't the project the release was sealed for` };
  if (repo !== null && real(repo) !== project) return { ok: false, why: `${journal.branch} isn't a release of ${repo}` };
  return { ok: true };
}

/** Every release journal in the state folder, read strictly; unreadable ones are counted, never guessed at. */
export function waitingJournals(stateDir: string, expectedFile: (branch: string) => string): { journals: WaitingJournal[]; unreadable: string[] } {
  const folder = join(stateDir, "releases");
  let names: string[] = [];
  try { names = readdirSync(folder).filter(name => name.endsWith(".json")); } catch { return { journals: [], unreadable: [] }; }
  const journals: WaitingJournal[] = [], unreadable: string[] = [];
  for (const name of names.sort()) {
    const file = join(folder, name);
    let raw: unknown;
    try { if (!lstatSync(file).isFile()) { unreadable.push(name); continue; } raw = JSON.parse(readFileSync(file, "utf8")); } catch { unreadable.push(name); continue; }
    const step = (raw as { step?: unknown } | null)?.step;
    if (step !== "approval" && step !== "gate") continue;
    const read = readWaitingJournal(file, raw, expectedFile);
    if (read === null) unreadable.push(name); else journals.push(read);
  }
  return { journals, unreadable };
}

/** A release as Home names it (docs/plans/home-other-asks.md, part 1): its version, and why it can't take a yes now
 * in the sheet's own words (`refusalOf`, the one source), or null when this isn't a release. Reads only; Home never
 * approves one, it links to the sheet. */
export function releaseAskOf(store: Store, taskId: string): { version: string; refusal: string | null } | null {
  const found = releaseTaskOf(store, taskId);
  if (found === null) return null;
  const { scope, seal } = found;
  const refusal = approvalOf(scope).approved ? null : refusalOf(store, taskId, scope, releaseCiOf(store, taskId, scope.candidate!));
  return { version: seal.identity.packageVersion, refusal };
}
