/**
 * The fast path: file and approve in one step (docs/plans/plain-toolroll.md P2.4).
 *
 * For an eligible small task a person starts themselves, the New task form shows the exact terms a plan approval would
 * seal, and pressing Build is that person's approval of exactly those terms: approve()'s own checks on the digest they
 * saw, with the same proofs, inside the filing's transaction. Nothing is narrowed or widened. The seal is the ordinary
 * person basis; the marker (the proof row's `fastStart`, `task_ref.fast_start_at`) only adds restrictions:
 *
 * - **the start window**: the first build starts within 30 minutes, or the seal is cleared in a logged transaction and
 *   the task shows the ordinary Approve plan (approval-authority.ts fastStartStandsSql, expireFastStarts);
 * - **the Accept backstop**: a machine can't complete it, the project's grant doesn't push it until a person accepted it,
 *   and completion, publication and merge all read one verified measure of the whole change (verifiedChange).
 *
 * Only a person's own surfaces reach here (the browser, the terminal UI as the local owner, interactive `task new`, and
 * a person's own tap or typed yes on a chat's Start card: docs/plans/one-step-chat.md). Every machine is refused in the
 * writer from trusted context. `task add` never comes this way.
 *
 * A chat start (`via: "chat"`) runs the same rules (fastStartRules). Its words are the lead's, so it is filed as the
 * lead's text (`proposedVia: "mate"`, quarantined), and only its person-proof step differs: chat has no password, so
 * instead of the password field it passes only within the person's own chat approval limits (chatLimitProblem), and
 * quarantined text is approvable in chat only on a card that showed every term whole (store.ts sealScopeApproval).
 */
import { randomBytes } from "node:crypto";
import { approvalPasswordField, type ApprovalPasswordFacts } from "./approval-password.js";
import type { ChatApprovalLimits } from "./chat-approval.js";
import { chatLimitProblem } from "./chat-terms.js";
import { isProtectedWork, protectedChanges } from "./approval-policy.js";
import { originalTaskBase } from "./observations.js";
import { legOf, makesNoPlan, routeFromJson, type TaskSizing } from "./phase-routing.js";
import { levelOfProfile } from "./policy.js";
import { fileTaskProposal } from "./proposal.js";
import { releaseCiHoldOf } from "./release-ci-hold.js";
import { COMPLETION_ACTION, COMPLETION_BY_PERSON } from "./result-completion.js";
import { deployGateScope, machineActing, propose, releaseCheckScope, type ApproveResult, type Scope } from "./scope.js";
import { BUILT_IN, withdrawApproval, type Store } from "./store.js";
import { classifyTask, filingSizer, heuristicSizing } from "./task-sizing.js";
import { issueImported } from "./task-source.js";
import { titleWithin } from "./task-text.js";
import { viewedGitSync } from "./teardown-git.js";

/** The constants, in one place, versioned together in every marker. */
export const FAST_START_RULE = "small-v1";
export const FAST_WINDOW_MS = 30 * 60_000;
export const FAST_MAX_FILES = 3;
export const FAST_MAX_LINES = 150;
/** How long a rendered form may still be pressed. */
export const FAST_PREVIEW_MS = 15 * 60_000;

/** Which person surface is filing. `chat` is a Start card a person taps or answers yes to (one-step-chat.md); a flow, a
 * token or an agent has no entry here. */
export type FastVia = "console" | "terminal-ui" | "cli" | "chat";

export type FastRefusal = "setting" | "size" | "classifier" | "plan" | "quality" | "rules" | "protected" | "password" | "release" | "trial" | "chain" | "monthly" | "policy" | "agents" | "machine" | "mode" | "limit";
const FAST_WORDS: Readonly<Record<FastRefusal, string>> = {
  setting: "Small tasks don't start right away in this project.",
  size: "This looks bigger than a small change.",
  classifier: "Toolroll couldn't confirm this is a small change.",
  plan: "This needs a plan first.",
  quality: "Strict checks need a plan first.",
  rules: "This project's approval rules need a plan first.",
  protected: "This may reach protected work.",
  password: "Approving this takes your password.",
  release: "Releases need a plan first.",
  trial: "A cheaper-model trial is approved on its own.",
  chain: "A fallback chain needs a plan first.",
  monthly: "A monthly limit is reached.",
  policy: "Your organisation's policy needs a plan first.",
  agents: "Choose an agent first.",
  machine: "Only a person starts work this way.",
  mode: "This project's mode approves it.",
  limit: "This is more than your chat approval setting allows.",
};
export const fastRefusalWords = (reason: FastRefusal): string => FAST_WORDS[reason];

// ---- the project setting ---------------------------------------------------------------------------------------------

/** Small tasks start right away: a project's own choice, else on for single-approver installs and off once there's more
 * than one approver. */
export function fastStartOn(store: Store, repo: string): boolean {
  const saved = store.handle.prepare("SELECT fast_start FROM project WHERE path = ?").get(repo)?.["fast_start"];
  if (saved === 0 || saved === 1) return saved === 1;
  const approvers = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM approver WHERE revoked_at IS NULL AND role = 'approver'").get()?.["n"] ?? 0);
  return approvers === 1;
}

/** A person's logged settings act. */
export function setFastStart(store: Store, repo: string, on: boolean, by: string, now: Date): boolean {
  return store.transact(() => {
    const written = store.handle.prepare("UPDATE project SET fast_start = ? WHERE path = ?").run(on ? 1 : 0, repo);
    if (Number(written.changes) === 0) return false;
    store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action: "small tasks start right away", outcome: on ? "on" : "off", source: "policy", detail: null });
    return true;
  });
}

// ---- eligibility: one function, read by the form and again inside the transaction ------------------------------------

/** Filed this way, the plan's words are the person's words, and they inspect the result. */
export const fastAcceptance = (title: string): { id: string; statement: string; how: null; evidence: ["manual-review"] }[] => [{ id: "c1", statement: title, how: null, evidence: ["manual-review"] }];

export type FastInput = { actor: string; repo: string; title: string; permissionMode?: "auto" | "bypassPermissions" | undefined };
export type PasswordFacts = Pick<ApprovalPasswordFacts, "passwordless" | "localOwner" | "freshAt" | "returnTo">;

/** How the person is proved at the one step that differs by surface: the password rule the form reads, or (a chat
 * start) the person's own chat approval limits. */
export type FastProof = { password: PasswordFacts } | { chat: ChatApprovalLimits };

/** Every person surface's eligibility: the rules, then a machine is refused. */
export function fastStartEligible(store: Store, input: FastInput & { taskId: string; sizing: TaskSizing } & ({ password: PasswordFacts } | { proof: FastProof }), now: Date): { ok: true; scope: Scope } | { ok: false; reason: FastRefusal } {
  if (machineActing()) return { ok: false, reason: "machine" };
  return fastStartRules(store, { ...input, proof: "proof" in input ? input.proof : { password: input.password } }, now);
}

/** The rules alone, the same for every surface: only the person-proof step has two forms (FastProof). A preview reads
 * these as any caller; Build reads them again behind the machine check (fastStartEligible). */
export function fastStartRules(store: Store, input: FastInput & { taskId: string; sizing: TaskSizing; proof: FastProof }, now: Date): { ok: true; scope: Scope } | { ok: false; reason: FastRefusal } {
  const no = (reason: FastRefusal) => ({ ok: false as const, reason });
  if (!fastStartOn(store, input.repo)) return no("setting");
  const account = store.accountOf(input.actor);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(input.actor, input.repo)) return no("rules");
  // The description decides "small"; the classifier can only confirm it, and silence is no.
  if (heuristicSizing({ title: input.title, goal: input.title }).size !== "small") return no("size");
  if (input.sizing.source !== "classifier") return no("classifier");
  if (input.sizing.size !== "small" || input.sizing.risky) return no("size");
  const scope = store.getScope(input.taskId);
  if (scope === null) return no("plan");
  if (issueImported(store, input.taskId)) return no("plan");
  if (scope.profileState === "unresolved" || scope.profile == null) return no("agents");
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  if (route === null) return no("agents");
  if (!makesNoPlan(input.sizing, route.risk)) return no("plan");
  if ((scope.qualityMode ?? "default") !== "default") return no("quality");
  if (scope.proposedChainJson != null) return no("chain");
  const rules = store.approvalRules(input.repo);
  if (rules.notRequester) return no("rules");
  if (isProtectedWork(rules, scope.touches)) return no("protected");
  const gate = store.approvalGate(input.taskId, input.actor, "person");
  if (gate.verdict !== "seal" || gate.protectedWork) return no("rules");
  if (deployGateScope(scope) || releaseCheckScope(scope) || releaseCiHoldOf(store, input.taskId) !== null) return no("release");
  if (legOf(route, "build").selection?.kind === "trial") return no("trial");
  // Anything approving would take a typed password for: escalated terms, wider check access, sandbox widenings.
  const profile = scope.profile as unknown as Record<string, unknown>;
  if (levelOfProfile(scope.profile) === "escalated" || profile["checkAccess"] !== undefined || profile["machLookup"] !== undefined) return no("password");
  if ("password" in input.proof) {
    const field = approvalPasswordField(store, { name: input.actor, taskId: input.taskId, scope, ...input.proof.password });
    if (field.field === "required" || field.field === "local-refused") return no("password");
  } else if (chatLimitProblem(scope, input.proof.chat, "your chat approval setting") !== null) return no("limit");
  const ref = store.lookupRef(input.taskId);
  if (ref === null || store.budgetGate(now)({ ...store.budgetSubject(ref.id), agents: store.agentsFor([scope.profile.provider]) }).over !== null) return no("monthly");
  if (store.scopePolicyRefusal(input.taskId) !== null) return no("policy");
  return { ok: true, scope };
}

/** File the task, inside the caller's transaction, exactly as Build will. A chat start's words are the lead's: its text
 * stays quarantined (`proposedVia: "mate"`), as every lead-written scope is. */
function fileIt(store: Store, id: string, input: FastInput & { via: FastVia; sizing: TaskSizing }, now: Date): { ok: true } | { ok: false; message: string } {
  const filed = fileTaskProposal(store, {
    id, title: titleWithin(input.title), repo: input.repo, goal: input.title, acceptance: fastAcceptance(input.title), planning: "skip", sizing: input.sizing,
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    filedVia: input.via === "console" ? "console" : input.via === "terminal-ui" ? "tui" : input.via === "chat" ? "chat" : "cli", filedBy: { name: input.actor, kind: "person" as const },
    ...(input.via === "chat" ? { proposedVia: "mate" as const } : {}),
  }, now);
  return filed.ok ? { ok: true } : { ok: false, message: filed.message };
}

class RolledBack<T> extends Error { constructor(readonly answer: T) { super("fast start preview"); } }
/** Run `body` in a savepoint that never commits: a preview writes nothing, at any nesting depth (a nested transact runs
 * in place, so only the savepoint undoes the writes when a caller already holds a transaction). */
function dryRun<T>(store: Store, body: () => T): T {
  try { store.transact(() => store.savepoint(() => { throw new RolledBack(body()); })); }
  catch (error) { if (error instanceof RolledBack) return error.answer as T; throw error; }
  throw new Error("unreachable");
}

export type FastPreview =
  | { eligible: true; preview: string; digest: string; scope: Scope; taskId: string }
  | { eligible: false; reason: FastRefusal };

/**
 * What the form renders: the classifier asked (at most its budget), then the same proposal the plan step would seal, in a
 * transaction that's rolled back. The filing's words and the classifier's answer are kept (fast_preview), so Build
 * files exactly this, whatever is posted.
 */
export async function prepareFastStart(store: Store, input: FastInput & { via: Exclude<FastVia, "chat">; password: PasswordFacts }, now: Date): Promise<FastPreview> {
  if (machineActing()) return { eligible: false, reason: "machine" };
  // A chat start is prepared in the lead's turn (prepareChatStart), bound to it.
  if ((input.via as FastVia) === "chat") return { eligible: false, reason: "rules" };
  if (!fastStartOn(store, input.repo)) return { eligible: false, reason: "setting" };
  if (heuristicSizing({ title: input.title, goal: input.title }).size !== "small") return { eligible: false, reason: "size" };
  // A mode that auto-approves filings comes first: its own road, its own seal.
  const mode = store.activeMode(input.repo, now);
  if (mode !== null && /"autoApproveFiling":true/.test(mode.termsJson)) return { eligible: false, reason: "mode" };
  const sizer = filingSizer();
  const sizing = await classifyTask({ title: input.title, goal: input.title }, sizer.sizer, sizer.budget);
  const taskId = `task-${randomBytes(8).toString("hex")}`;
  const read = dryRun(store, () => {
    const filed = fileIt(store, taskId, { ...input, sizing }, now);
    if (!filed.ok) return { ok: false as const, reason: "plan" as const };
    return fastStartEligible(store, { ...input, taskId, sizing }, now);
  });
  if (!read.ok) return { eligible: false, reason: read.reason };
  const preview = randomBytes(16).toString("hex");
  store.handle.prepare(`INSERT INTO fast_preview (id, actor, via, task_id, repo, title, permission, sizing_json, digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(preview, input.actor, input.via, taskId, input.repo, input.title, input.permissionMode ?? null, JSON.stringify(sizing), read.scope.digest, now.toISOString(), new Date(now.getTime() + FAST_PREVIEW_MS).toISOString());
  return { eligible: true, preview, digest: read.scope.digest, scope: read.scope, taskId };
}

export type FastBuild =
  | { ok: true; taskId: string }
  | { ok: false; reason: "gone" | "changed" | FastRefusal; message: string };

/** Approve inside the filing: `approveNow` is the surface's own call to approve() (web: its freshness and re-check). */
export type FastApprove = (taskId: string, sawDigest: string, fast: { rule: string; at: string }) => ApproveResult;

/**
 * Build: file and approve in one transaction. Every check is made here, on the rows written here; anything refused
 * rolls the filing back, so a refusal leaves nothing behind.
 */
export function fastStartBuild(store: Store, input: { preview: string; digest: string; actor: string; via: FastVia; approveNow: FastApprove;
  /** A chat start: the lead turn its card was drafted in. Its preview must have been prepared in that same turn. */
  turn?: number } & ({ password: PasswordFacts } | { proof: FastProof }), now: Date): FastBuild {
  if (machineActing()) return { ok: false, reason: "machine", message: FAST_WORDS.machine };
  const proof: FastProof = "proof" in input ? input.proof : { password: input.password };
  // The chat form of the proof is a chat start's alone; the form's surfaces keep the password rule.
  if ("chat" in proof && input.via !== "chat") return { ok: false, reason: "rules", message: FAST_WORDS.rules };
  class Refused extends Error { constructor(readonly answer: FastBuild) { super("fast start refused"); } }
  const refuse = (answer: FastBuild): never => { throw new Refused(answer); };
  try {
    // A savepoint inside the transaction: a refusal undoes the filing even when the caller already holds a transaction
    // (a nested transact runs in place, and this function catches its own refusal).
    return store.transact(() => store.savepoint(() => {
      const row = store.handle.prepare("SELECT * FROM fast_preview WHERE id = ? AND consumed_at IS NULL AND expires_at > ?").get(input.preview, now.toISOString());
      if (row === undefined || row["actor"] !== input.actor || row["via"] !== input.via) return refuse({ ok: false, reason: "gone", message: "This form has expired. Start again." });
      // A chat preview without a turn, or from another turn than its card's, is nobody's card.
      if (input.via === "chat" && (row["turn"] === null || row["turn"] === undefined || input.turn === undefined || Number(row["turn"]) !== input.turn))
        return refuse({ ok: false, reason: "gone", message: "This card has expired. Ask again." });
      const sizing = JSON.parse(String(row["sizing_json"])) as TaskSizing;
      const taskId = String(row["task_id"]);
      const filing = { actor: input.actor, repo: String(row["repo"]), title: String(row["title"]), ...(row["permission"] === null ? {} : { permissionMode: row["permission"] as "auto" | "bypassPermissions" }) };
      const filed = fileIt(store, taskId, { ...filing, via: input.via, sizing }, now);
      if (!filed.ok) return refuse({ ok: false, reason: "changed", message: filed.message });
      const eligible = fastStartEligible(store, { ...filing, taskId, sizing, proof }, now);
      if (!eligible.ok) return refuse({ ok: false, reason: eligible.reason, message: FAST_WORDS[eligible.reason] });
      const at = now.toISOString();
      // approve() compares the digest the person saw with the plan just filed: changed terms refuse "changed".
      const approved = input.approveNow(taskId, input.digest, { rule: FAST_START_RULE, at });
      if (!approved.ok && approved.reason === "changed") return refuse({ ok: false, reason: "changed", message: "This changed since you read it. Read it again." });
      // Chat has no password: a refusal there says the rule, not "takes your password".
      if (!approved.ok) return refuse(input.via === "chat" ? { ok: false, reason: "rules", message: approved.reason === "policy" ? approved.message : FAST_WORDS.rules } : { ok: false, reason: "password", message: FAST_WORDS.password });
      store.handle.prepare("UPDATE fast_preview SET consumed_at = ? WHERE id = ?").run(at, input.preview);
      store.handle.prepare("UPDATE task_ref SET fast_start_at = ?, fast_start_until = ? WHERE backend = ? AND external_id = ?").run(at, new Date(now.getTime() + FAST_WINDOW_MS).toISOString(), BUILT_IN, taskId);
      store.bumpWake();
      return { ok: true as const, taskId };
    }));
  } catch (error) {
    if (error instanceof Refused) return error.answer;
    throw error;
  }
}

// ---- the start window ------------------------------------------------------------------------------------------------

/**
 * A fast start that didn't start in time: its seal is cleared, in a logged transaction, and the task shows the ordinary
 * Approve plan. A task with a build running or a result to read is left to that.
 */
export function expireFastStarts(store: Store, now: Date): number {
  const stamp = now.toISOString();
  // Forms nobody pressed hold a person's words: they go once they can't be pressed.
  store.handle.prepare("DELETE FROM fast_preview WHERE expires_at <= ?").run(stamp);
  const late = store.handle.prepare(`SELECT r.id AS ref, r.external_id AS task, r.repo AS repo FROM task_ref r JOIN task t ON t.id = r.external_id
    WHERE r.backend = ? AND r.fast_start_until IS NOT NULL AND r.fast_start_until <= ? AND t.state = 'queued'`).all(BUILT_IN, stamp);
  let cleared = 0;
  for (const row of late) {
    const ref = Number(row["ref"]), task = String(row["task"]);
    store.transact(() => {
      if (store.currentLiveLease(ref, now) !== null) return;
      withdrawApproval(store, { where: "WHERE task_id = ?", args: [task] }, { basisAfter: null, clearRoute: true, clearModeDigest: false });
      store.handle.prepare("UPDATE task_ref SET fast_start_until = NULL WHERE id = ?").run(ref);
      store.recordAction({ at: stamp, actor: "system", repo: row["repo"] === null ? null : String(row["repo"]), taskId: task, runId: null, action: "fast start expired", outcome: "seal cleared", source: "work", detail: `no build started within ${FAST_WINDOW_MS / 60_000} minutes` });
      cleared++;
    });
  }
  if (cleared > 0) store.bumpWake();
  return cleared;
}

// ---- the Accept backstop ---------------------------------------------------------------------------------------------

/** Files a small change has no business touching, by name, wherever they sit. */
const HEAVY_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|uv\.lock|package\.json|Cargo\.toml|Gemfile|go\.mod|pyproject\.toml|requirements[^/]*\.txt|composer\.json|schema\.(?:sql|prisma|rb|graphql)|structure\.sql)$|(?:^|\/)(?:migrations?|migrate|db\/migrate)\//i;

export type VerifiedChange = { ok: true; base: string; head: string; files: { path: string; added: number; removed: number }[]; lines: number } | { ok: false; problem: string };

const SHA = /^[0-9a-f]{40}$/;

/** `ls-tree -r -z`: path to mode and object, read from the commit, so a gitlink can't hide from a diff setting. */
function treeOf(repo: string, commit: string): Map<string, string> {
  const out = new Map<string, string>();
  const listed = viewedGitSync(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error("the commit couldn't be read");
  for (const entry of listed.stdout.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("a tree entry couldn't be read");
    const [mode = "", type = "", object = ""] = entry.slice(0, tab).split(" ");
    out.set(entry.slice(tab + 1), `${mode} ${type} ${object}`);
  }
  return out;
}

/**
 * The whole change a result carries, verified: every version of the task (any ancestry problem refuses), from the base in
 * Toolroll's own records to the head on the run record, every contributing build's saved diff present, and every file
 * countable through the hardened git. Null-like answers refuse: nothing here is ever a guess.
 */
export function verifiedChange(store: Store, taskId: string, runId: number): VerifiedChange {
  const no = (problem: string): VerifiedChange => ({ ok: false, problem });
  const ancestry = store.revisionAncestryStatus(taskId);
  if (ancestry.problem !== null) return no("Its history can't be read whole.");
  const run = store.getRun(runId);
  const ref = store.lookupRef(taskId);
  if (run === null || ref === null || ref.repo === null || run.taskRef !== ref.id || run.headRevision === null || !SHA.test(run.headRevision)) return no("Its result has no recorded commit.");
  const base = originalTaskBase(store, taskId);
  if (base === null || !SHA.test(base)) return no("Its base commit isn't on record.");
  for (const id of ancestry.chain.length === 0 ? [taskId] : ancestry.chain) {
    const member = store.lookupRef(id);
    if (member === null) return no("Its history can't be read whole.");
    for (const one of store.runsFor(member.id)) {
      if ((one.role !== "builder" && one.role !== "repair") || one.outcome !== "built") continue;
      if (!store.artifactsFor(one.id).some(artifact => artifact.kind === "diff-stat" || artifact.kind === "terminal-diff")) return no(`Build #${one.id} has no saved diff.`);
    }
  }
  try {
    const before = treeOf(ref.repo, base), after = treeOf(ref.repo, run.headRevision);
    const changed = new Set<string>();
    for (const [path, entry] of after) if (before.get(path) !== entry) changed.add(path);
    for (const path of before.keys()) if (!after.has(path)) changed.add(path);
    for (const path of changed) {
      const entry = after.get(path) ?? before.get(path) ?? "";
      if (!entry.startsWith("100")) return no(`${path} can't be counted.`);
    }
    const counted = viewedGitSync(ref.repo, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", base, run.headRevision], { timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (counted.status !== 0) return no("The change couldn't be counted.");
    const files: { path: string; added: number; removed: number }[] = [];
    for (const entry of counted.stdout.split("\0")) {
      if (entry === "") continue;
      const [added = "", removed = "", ...rest] = entry.split("\t");
      const path = rest.join("\t");
      if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) return no(`${path} can't be counted.`);
      files.push({ path, added: Number(added), removed: Number(removed) });
    }
    if (files.length !== changed.size || files.some(one => !changed.has(one.path))) return no("The change couldn't be counted whole.");
    return { ok: true, base, head: run.headRevision, files, lines: files.reduce((sum, one) => sum + one.added + one.removed, 0) };
  } catch { return no("The change couldn't be read."); }
}

/** Whether any version of this task started fast. An unreadable history counts: it fails closed below. */
export function fastStarted(store: Store, taskId: string): boolean {
  const ancestry = store.revisionAncestryStatus(taskId);
  if (ancestry.problem !== null) {
    const own = store.handle.prepare("SELECT 1 AS hit FROM task_ref WHERE backend = ? AND external_id = ? AND fast_start_at IS NOT NULL").get(BUILT_IN, taskId);
    return own !== undefined;
  }
  const chain = ancestry.chain.length === 0 ? [taskId] : ancestry.chain;
  return store.handle.prepare(`SELECT 1 AS hit FROM task_ref WHERE backend = ? AND fast_start_at IS NOT NULL AND external_id IN (SELECT value FROM json_each(?))`).get(BUILT_IN, JSON.stringify(chain)) !== undefined;
}

/** The one sentence over every over-the-caps refusal; the road on is the approval of the expanded commit (keepGrownChange). */
export const GREW_WORDS = "This grew beyond a small change. Approve it to keep it.";

function grownApproved(store: Store, taskId: string, runId: number): boolean {
  const scope = store.getScope(taskId), run = store.getRun(runId);
  return scope !== null && run !== null && scope.candidate != null && scope.candidate === run.headRevision && scope.approvedDigest === scope.digest && run.scopeDigest === scope.digest
    && (scope.approvalBasis === "password" || scope.approvalBasis === "chat");
}

/** Why this exact result can't go further as a small change, or null. */
export function fastChangeProblem(store: Store, taskId: string, runId: number): string | null {
  if (!fastStarted(store, taskId)) return null;
  if (grownApproved(store, taskId, runId)) return null;
  const change = verifiedChange(store, taskId, runId);
  if (!change.ok) return GREW_WORDS;
  if (change.files.length > FAST_MAX_FILES || change.lines > FAST_MAX_LINES) return GREW_WORDS;
  const ref = store.lookupRef(taskId);
  const paths = change.files.map(one => one.path);
  if (paths.some(path => HEAVY_FILE.test(path))) return GREW_WORDS;
  if (ref?.repo != null && protectedChanges(store.approvalRules(ref.repo), paths).length > 0) return GREW_WORDS;
  return null;
}

/** Completion: a person only, and only a change the measure accepts. */
export function fastCompletionProblem(store: Store, taskId: string, runId: number, person: string | null): string | null {
  if (!fastStarted(store, taskId)) return null;
  if (person === null) return "A person accepts this one.";
  return fastChangeProblem(store, taskId, runId);
}

/** Publication and merge: nothing leaves until a person accepted this exact build, and the measure still accepts it. */
export function fastPublishProblem(store: Store, taskId: string, runId: number): string | null {
  if (!fastStarted(store, taskId)) return null;
  const accepted = store.handle.prepare("SELECT 1 AS hit FROM action_ledger WHERE run_id = ? AND action = ? AND detail = ? LIMIT 1").get(runId, COMPLETION_ACTION, COMPLETION_BY_PERSON);
  if (accepted === undefined) return "It waits for a person to accept it.";
  return fastChangeProblem(store, taskId, runId);
}

/**
 * "Approve it to keep it": a plan for the actual expanded commit, proposed the way a rerun proposes one (dispose.ts
 * regateTask): the same terms with `candidate` set to the exact head. It seals nothing; the person approves it on the
 * ordinary ceremony, Toolroll checks that commit out with no agent, and only that attempt's result goes further.
 */
export function keepGrownChange(store: Store, taskId: string, now: Date): { ok: true; digest: string } | { ok: false; message: string } {
  if (machineActing()) return { ok: false, message: FAST_WORDS.machine };
  return store.transact(() => {
    const ref = store.lookupRef(taskId);
    const scope = store.getScope(taskId);
    const last = ref === null ? null : store.lastBuilderRun(ref.id);
    if (ref === null || scope === null || last === null || last.headRevision === null) return { ok: false as const, message: "This task has no result to keep." };
    if (!fastStarted(store, taskId) || fastChangeProblem(store, taskId, last.id) === null) return { ok: false as const, message: "This change doesn't need a new approval." };
    if (store.hasLiveClaim(ref.id, now)) return { ok: false as const, message: "A build is running on it." };
    const proposed = propose(store, { taskId, goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd,
      acceptance: scope.acceptance, qualityMode: scope.qualityMode ?? "default", candidate: last.headRevision, now });
    return { ok: true as const, digest: proposed.digest };
  });
}

// ---- a chat start: prepared in the lead's turn (docs/plans/one-step-chat.md C1) --------------------------------------

/** What a chat start's preview is for: who asked, where, the lead's one-line title, and the lead turn it is prepared in. */
export type ChatStartInput = { actor: string; repo: string; title: string; turn: number };

/**
 * A chat start's preview, prepared by the lead's turn loop before the Start card is drafted: the classifier asked (at
 * most its budget), the filing dry-run, and the rules read. It refuses no machine caller, because a preview grants
 * nothing (the lead's turn runs as the lead): Build refuses a machine (fastStartBuild), and only a person's own tap or
 * typed yes reaches Build. The row is bound to the person, `via = 'chat'` and the turn; a preview without a turn is
 * unusable. The person's own chat limits are read again at the tap, for the chat it comes from; here only the loosest
 * limit that still means something applies (no full access, no cap), so a card is never drafted for terms no chat
 * approval could allow.
 */
export async function prepareChatStart(store: Store, input: ChatStartInput, now: Date): Promise<FastPreview> {
  if (!Number.isSafeInteger(input.turn) || input.turn < 1) return { eligible: false, reason: "rules" };
  if (!fastStartOn(store, input.repo)) return { eligible: false, reason: "setting" };
  if (heuristicSizing({ title: input.title, goal: input.title }).size !== "small") return { eligible: false, reason: "size" };
  const mode = store.activeMode(input.repo, now);
  if (mode !== null && /"autoApproveFiling":true/.test(mode.termsJson)) return { eligible: false, reason: "mode" };
  const sizer = filingSizer();
  const sizing = await classifyTask({ title: input.title, goal: input.title }, sizer.sizer, sizer.budget);
  const taskId = `task-${randomBytes(8).toString("hex")}`;
  const filing = { actor: input.actor, repo: input.repo, title: input.title };
  const read = dryRun(store, () => {
    const filed = fileIt(store, taskId, { ...filing, via: "chat", sizing }, now);
    if (!filed.ok) return { ok: false as const, reason: "plan" as const };
    return fastStartRules(store, { ...filing, taskId, sizing, proof: { chat: { fullAccess: false, capMicrousd: null } } }, now);
  });
  if (!read.ok) return { eligible: false, reason: read.reason };
  const preview = randomBytes(16).toString("hex");
  store.handle.prepare(`INSERT INTO fast_preview (id, actor, via, task_id, repo, title, permission, sizing_json, digest, created_at, expires_at, turn) VALUES (?, ?, 'chat', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
    .run(preview, input.actor, taskId, input.repo, input.title, JSON.stringify(sizing), read.scope.digest, now.toISOString(), new Date(now.getTime() + FAST_PREVIEW_MS).toISOString(), input.turn);
  return { eligible: true, preview, digest: read.scope.digest, scope: read.scope, taskId };
}

/** A chat start's preview, as the Start card reads it again: this person's, `via = 'chat'`, prepared in this turn,
 * unexpired and unused. Null otherwise. */
export function chatStartPreview(store: Store, preview: string, actor: string, turn: number, now: Date): { taskId: string; repo: string; title: string; sizing: TaskSizing; digest: string } | null {
  const row = store.handle.prepare("SELECT * FROM fast_preview WHERE id = ? AND consumed_at IS NULL AND expires_at > ?").get(preview, now.toISOString());
  if (row === undefined || row["actor"] !== actor || row["via"] !== "chat" || row["turn"] === null || Number(row["turn"]) !== turn) return null;
  return { taskId: String(row["task_id"]), repo: String(row["repo"]), title: String(row["title"]), sizing: JSON.parse(String(row["sizing_json"])) as TaskSizing, digest: String(row["digest"]) };
}

/** A dismissed Start card's preview can't be used: consumed, in the dismissal's transaction. */
export function consumeChatStartPreview(store: Store, preview: string, now: Date): void {
  store.handle.prepare("UPDATE fast_preview SET consumed_at = ? WHERE id = ? AND via = 'chat' AND consumed_at IS NULL").run(now.toISOString(), preview);
}

/**
 * A chat start's filing dry-run, for its card: the scope filing would make, read in a savepoint that is always rolled
 * back, with the rules read on it (any proof form; the card shows the terms, the tap proves the person). The card is made
 * from these words; the tap files again and compares.
 */
export function chatStartDryRun(store: Store, input: { actor: string; repo: string; title: string; taskId: string; sizing: TaskSizing }, now: Date): { ok: true; scope: Scope } | { ok: false; reason: FastRefusal } {
  return dryRun(store, () => {
    const filed = fileIt(store, input.taskId, { actor: input.actor, repo: input.repo, title: input.title, via: "chat", sizing: input.sizing }, now);
    if (!filed.ok) return { ok: false as const, reason: "plan" as const };
    return fastStartRules(store, { actor: input.actor, repo: input.repo, title: input.title, taskId: input.taskId, sizing: input.sizing, proof: { chat: { fullAccess: false, capMicrousd: null } } }, now);
  });
}
