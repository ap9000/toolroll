/** Decisions finish in the chat app. A pushed card about a result, a failed task, a plan waiting for approval or a
 * pull request ready to merge carries buttons that act in place: Accept and finish, Request changes, Retry,
 * Approve & start, Merge. Every act that changes something asks twice ("Accept and finish 'X'? [Yes] [Cancel]"),
 * and each button is one opaque token bound to the exact result, receipt, plan or commit the card showed: a card a
 * newer result, a finished task or a changed plan has overtaken says so and acts on nothing.
 *
 * Approving a plan or merging needs the password, which never goes in chat, so they act in chat only under a
 * repository's signed mode that carries the chatApprove term, for the signer's own chat; otherwise, and for a plan
 * that widens permissions, exceeds the mode's budget or touches protected paths, the card keeps its link.
 *
 * Channel-agnostic: Telegram renders these today, and Slack, Discord and Teams reach the same acts through the same
 * tokens (the `channel` column). Every act runs through the door the console uses. */
import { DECIDE_ACTS, readDecideActionRow, type DecideActionRow } from "./contracts/chat-callback-rows.js";
import type { ContractResult } from "./contracts/contract.js";
import { createHash, randomBytes } from "node:crypto";
import { acceptAndCompleteAsOperator, assignmentOf, owedAcceptance } from "./assignment.js";
import { chatControlHref, chatResultHref } from "./chat-controls.js";
import { applyChatTaskAction, chatTaskStamp } from "./chat-task-actions.js";
import { chatTitle } from "./chat-voice.js";
import { readVerifiedArtifact } from "./evidence.js";
import { modeTermsFromJson, type ModeTerms } from "./modes.js";
import { parseExecutionPlanDocument } from "./plan.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { pullRequestFollowOf } from "./pull-request-flow.js";
import { requestResultChanges } from "./result-actions.js";
import { revisionSourceOf } from "./result-review.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";
import { phoneText } from "./telegram-status.js";

/** The tokens live in chat_decide_action and the open "What should change?" in chat_decide_prompt (store.ts). */
export type DecideAct = (typeof DECIDE_ACTS)[number];
export type DecideTarget =
  | { kind: "result"; taskId: string; run: number }
  | { kind: "failed"; taskId: string }
  | { kind: "plan"; taskId: string }
  | { kind: "merge"; taskId: string; run: number };
export type DecideChannel = "telegram" | "slack" | "discord" | "teams";
/** Who is tapping, where: one paired person's binding on one channel, and the chat the card is in. */
export type DecideSeat = { channel: DecideChannel; binding: number; chat: string; approver: string; generation: number };
export type DecideLink = { label: string; path: string };
/** A button as a channel draws it: an act (its token) or a link to the console. */
export type DecideButton = { label: string; token: string } | { label: string; link: DecideLink };

/** The words, said once. */
export const DECIDE_LABELS = {
  accept: "Accept and finish",
  changes: "Request changes",
  retry: "Retry",
  approve: "Approve & start",
  "not-now": "Not now",
  merge: "Merge",
  look: "Look first",
  edit: "Edit",
  yes: "Yes",
  cancel: "Cancel",
} as const;

const OFFER_TTL_MS = 7 * 86_400_000;
const CONFIRM_TTL_MS = 10 * 60_000;
const PROMPT_TTL_MS = 30 * 60_000;
export const WHAT_SHOULD_CHANGE = "What should change?";

type ActSpec = { act: DecideAct; run: number | null; digest: string };
/** What a card offers: an optional replacement text (the plan card) and rows of acts and links. */
export type DecideOffer = { text: string | null; rows: Array<Array<ActSpec | DecideLink>> };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const isAct = (one: ActSpec | DecideLink): one is ActSpec => "act" in one;
const title = (store: Store, taskId: string): string => phoneText(chatTitle(store, taskId), 60);

// ---- the chatApprove term ----------------------------------------------------------

/** The live mode on this repository, when it lets this person's chat approve: the term signed, by them. */
export function chatApproveMode(store: Store, repo: string | null, approver: string, now: Date):
  { ok: true; digest: string; terms: ModeTerms } | { ok: false; why: string } {
  const mode = repo === null ? null : store.activeMode(repo, now);
  const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
  if (mode === null || terms === null || !terms.chatApprove) return { ok: false, why: "Approving from chat isn't turned on for this project." };
  if (mode.signedBy !== approver || !store.accountCanAccess(approver, repo!)) return { ok: false, why: "Only the person who signed this project's mode can approve from chat." };
  return { ok: true, digest: mode.digest, terms };
}

/** What a plan's yes allows an agent to do, in a few plain words (the approval sheet's "You're allowing"). */
export function permissionPlainWords(profile: Scope["profile"] | null | undefined): string | null {
  if (profile === null || profile === undefined) return null;
  const full = "full access, nothing asks first";
  if (profile.provider === "claude") {
    return profile.permissionArgv === "bypassPermissions" ? full
      : profile.permissionArgv === "auto" ? "file edits and routine commands; anything risky stops"
      : "file edits only; commands are refused";
  }
  if (profile.provider === "gemini") return profile.approvalArgv === "yolo" ? full : "file edits only; other tools are refused";
  return profile.sandboxMode === "danger-full-access" ? full : "file edits and commands inside the project only";
}

function fullAccess(profile: Scope["profile"] | null | undefined): boolean {
  if (profile === null || profile === undefined) return false;
  return profile.provider === "claude" ? profile.permissionArgv === "bypassPermissions"
    : profile.provider === "gemini" ? profile.approvalArgv === "yolo" : profile.sandboxMode === "danger-full-access";
}

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** A plan this person's chat may approve now: the term, the plan's exact bytes, and none of the reasons it must open
 * Toolroll instead. `digest` binds the scope and the plan document the card shows. */
export function planInChat(store: Store, taskId: string, approver: string, now: Date, root?: string):
  { ok: true; modeDigest: string; digest: string; scope: Scope } | { ok: false; why: string } {
  const ref = store.lookupRef(taskId);
  const scope = store.getScope(taskId);
  if (ref === null || ref.repo === null || scope === null) return { ok: false, why: "This plan isn't available now." };
  if (scope.approvedDigest != null && scope.approvedDigest === scope.digest) return { ok: false, why: "This plan is already approved." };
  if (ref.plan === "requested") return { ok: false, why: "The plan is still being written." };
  const mode = chatApproveMode(store, ref.repo, approver, now);
  if (!mode.ok) return mode;
  if (store.getTask(taskId)?.state === "cancelled" || store.getTask(taskId)?.state === "done") return { ok: false, why: "This task is already finished." };
  const family = store.taskFamilyOf(taskId, [ref.repo], false);
  if (family === null || family.problem !== null || family.current.id !== taskId) return { ok: false, why: "A newer version of this task is current." };
  // What the mode's seal refuses anyway, said first: model- or coordinator-written terms, a race, an unreadable route.
  if (ref.coordinatorCid !== null || (scope.proposedVia ?? null) !== null) return { ok: false, why: "This plan was written for you, so you approve it in Toolroll." };
  if (store.activeTournamentTerms(ref.id) !== null) return { ok: false, why: "Agents compete on this task, so you approve it in Toolroll." };
  if (scope.profileState === "unresolved" || scope.routeEra == null || (scope.termsProblem ?? null) !== null) return { ok: false, why: "This plan can't say exactly which agents run, so you approve it in Toolroll." };
  if (fullAccess(scope.profile) && mode.terms.permissionDefault !== "escalated") return { ok: false, why: "This plan asks for more access than your mode allows." };
  const cap = mode.terms.perAttemptBudgetMicrousd;
  if (cap !== null && (scope.budgetMicrousd === null || scope.budgetMicrousd > cap)) return { ok: false, why: `This plan has ${scope.budgetMicrousd === null ? "no attempt limit" : `a ${money(scope.budgetMicrousd)} attempt limit`}, more than your mode's ${money(cap)}.` };
  if (store.approvalGate(taskId, approver, "mode").verdict !== "seal") return { ok: false, why: "This plan touches protected work, so two people approve it in Toolroll." };
  if (store.scopePolicyRefusal(taskId) !== null) return { ok: false, why: "Your organisation's policy needs this plan approved in Toolroll." };
  // A revision approves only against notes that still verify, as on the console.
  if (ref.revisionBriefArtifact !== null) {
    const brief = store.getArtifact(ref.revisionBriefArtifact);
    let verified = false;
    try { verified = brief !== null && root !== undefined && readVerifiedArtifact(root, brief).ok; } catch { verified = false; }
    if (!verified) return { ok: false, why: "This revision's notes can't be verified here, so you approve it in Toolroll." };
  }
  // The plan the card shows must be the saved one, verified, as the console's approval reads it.
  const plan = store.latestPlanArtifact(ref.id);
  if (plan !== null) {
    let verified = false;
    try { verified = root !== undefined && readVerifiedArtifact(root, plan).ok; } catch { verified = false; }
    if (!verified) return { ok: false, why: "The saved plan can't be verified here, so you approve it in Toolroll." };
  }
  return { ok: true, modeDigest: mode.digest, scope, digest: sha(`${scope.digest}:${plan?.sha256 ?? ""}`) };
}

/** A ready pull request this person's chat may merge now, bound to the exact commit. */
export function mergeInChat(store: Store, taskId: string, run: number, approver: string, now: Date):
  { ok: true; modeDigest: string; head: string } | { ok: false; why: string } {
  const ref = store.lookupRef(taskId);
  const publication = store.publicationForRun(run);
  const follow = publication === null ? null : pullRequestFollowOf(store, publication.id);
  if (ref === null || ref.repo === null || publication === null || follow === null || publication.prNumber === null) return { ok: false, why: "This result has no pull request to merge." };
  if (follow.mergeCommit !== null) return { ok: false, why: "This pull request is already merged." };
  if (follow.readyHead !== publication.headSha) return { ok: false, why: "This pull request changed since this card was sent." };
  const mode = chatApproveMode(store, ref.repo, approver, now);
  if (!mode.ok) return mode;
  return { ok: true, modeDigest: mode.digest, head: publication.headSha };
}

/** The plan card: title, goal in two lines, what changes, done when, and what the yes allows. On Telegram the yes's
 * terms come second, under the title, and the steps are fewer: the full plan is behind Edit. */
export function planCardText(store: Store, taskId: string, scope: Scope, root?: string, channel?: DecideChannel): string {
  const ref = store.lookupRef(taskId);
  const artifact = ref === null ? null : store.latestPlanArtifact(ref.id);
  let milestones: string[] = [];
  if (artifact !== null && root !== undefined) {
    try {
      const read = readVerifiedArtifact(root, artifact);
      const parsed = read.ok ? parseExecutionPlanDocument(read.content.toString("utf8")) : null;
      if (parsed?.ok) milestones = parsed.document.milestones;
    } catch { milestones = []; }
  }
  const bullets = (items: readonly string[], cap: number): string[] =>
    [...items.slice(0, cap).map(one => `• ${phoneText(one, 120)}`), ...(items.length > cap ? [`• and ${items.length - cap} more`] : [])];
  // The goal in two lines at most: its first two, each kept short.
  const goal = scope.goal.split("\n").filter(one => one.trim() !== "").slice(0, 2).map(one => phoneText(one, 160));
  const allowing = [permissionPlainWords(scope.profile), scope.budgetMicrousd === null ? "no attempt limit" : `up to ${money(scope.budgetMicrousd)} per attempt`]
    .filter((one): one is string => one !== null);
  if (channel === "telegram") {
    return [
      `Plan ready: ${title(store, taskId)}`,
      `Starting allows: ${allowing.join(" · ")}`,
      "",
      ...goal,
      ...(scope.touches.length > 0 ? [`Only in: ${scope.touches.slice(0, 6).map(one => phoneText(one, 80)).join(", ")}${scope.touches.length > 6 ? ", …" : ""}`] : ["Any file in the project."]),
      "",
      "Done when:",
      ...(scope.acceptance.length > 0 ? bullets(scope.acceptance.map(one => one.statement), 5) : ["You decide when you review the result."]),
      ...(milestones.length > 0 ? ["", "Steps:", ...bullets(milestones, 3)] : []),
    ].join("\n");
  }
  return [
    `Plan ready: ${title(store, taskId)}`,
    "",
    ...goal,
    "",
    "Changes:",
    ...(milestones.length > 0 ? bullets(milestones, 5) : []),
    ...(scope.touches.length > 0 ? [`Only in: ${scope.touches.slice(0, 6).map(one => phoneText(one, 80)).join(", ")}${scope.touches.length > 6 ? ", …" : ""}`] : milestones.length > 0 ? [] : ["Any file in the project."]),
    "",
    "Done when:",
    ...(scope.acceptance.length > 0 ? bullets(scope.acceptance.map(one => one.statement), 5) : ["You decide when you review the result."]),
    "",
    `You're allowing: ${allowing.join(" · ")}`,
  ].join("\n");
}

// ---- what a card offers ---------------------------------------------------------------

/** The acts a card about this target can take in chat right now, or null when none can (the card keeps its own
 * link). Reads only; nothing is minted. */
export function decideOffer(store: Store, target: DecideTarget, who: VerifiedApprover, now: Date, root?: string, channel?: DecideChannel): DecideOffer | null {
  const ref = store.lookupRef(target.taskId);
  if (ref === null || ref.repo === null || !who.repos.includes(ref.repo)) return null;
  switch (target.kind) {
    case "result": {
      // Accepting and requesting changes read the saved result: without it, the card keeps its link.
      if (root === undefined) return null;
      const fresh = resultFresh(store, target.taskId, target.run, who, now, root);
      if (!fresh.ok) return null;
      const look = { label: DECIDE_LABELS.look, path: chatResultHref(target.taskId, target.run, "changes") };
      // A result accepted only with a reason ("Accept anyway") keeps its link: the reason is typed on the result.
      if (fresh.exception) return null;
      return { text: null, rows: [[{ act: "accept", run: target.run, digest: fresh.receipt }, { act: "changes", run: target.run, digest: fresh.source }], [look]] };
    }
    case "failed": {
      const stamp = retryStamp(store, target.taskId, who);
      if (stamp === null) return null;
      return { text: null, rows: [[{ act: "retry", run: null, digest: stamp }], [{ label: DECIDE_LABELS.look, path: chatControlHref("task", target.taskId) }]] };
    }
    case "plan": {
      const plan = planInChat(store, target.taskId, who.name, now, root);
      if (!plan.ok) return null;
      return { text: planCardText(store, target.taskId, plan.scope, root, channel),
        rows: [[{ act: "approve", run: null, digest: plan.digest }], [{ label: DECIDE_LABELS.edit, path: chatControlHref("approval", target.taskId) }, { act: "not-now", run: null, digest: plan.digest }]] };
    }
    case "merge": {
      const merge = mergeInChat(store, target.taskId, target.run, who.name, now);
      if (!merge.ok) return null;
      return { text: null, rows: [[{ act: "merge", run: target.run, digest: merge.head }], [{ label: DECIDE_LABELS.look, path: chatResultHref(target.taskId, target.run, "changes") }]] };
    }
  }
}

/** Is the result the card showed still the one waiting to be finished? */
function resultFresh(store: Store, taskId: string, run: number, who: VerifiedApprover, now: Date, root?: string):
  { ok: true; receipt: string; source: string; exception: boolean } | { ok: false; why: string } {
  const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: who.repos }, root);
  if (assignment === null) return { ok: false, why: "This result isn't available now." };
  if (assignment.state === "complete") return { ok: false, why: "This task is already finished." };
  if (assignment.state === "cancelled") return { ok: false, why: "This task was cancelled." };
  const receipt = assignment.receipt;
  if (receipt === null || receipt.taskId !== taskId || receipt.runId !== run) return { ok: false, why: "A newer result is current." };
  if (assignment.state !== "ready-to-check") return { ok: false, why: "This result isn't ready to finish now." };
  return { ok: true, receipt: receipt.digest, source: revisionSourceOf(store.getScope(taskId)?.digest ?? null), exception: owedAcceptance(receipt) === "exception" };
}

function retryStamp(store: Store, taskId: string, who: VerifiedApprover): string | null {
  if (store.getTask(taskId)?.state !== "failed") return null;
  const stamp = chatTaskStamp(store, who, taskId);
  return stamp === null ? null : sha(stamp);
}

/** One fingerprint of what the card offers, without its tokens: a repaint with the same offer keeps its buttons. */
export function offerFingerprint(offer: DecideOffer): string {
  return sha(JSON.stringify(offer));
}

// ---- tokens ------------------------------------------------------------------------------------

/** A saved button (contracts/chat-callback-rows.ts), by the names this module uses. */
type ActionRow = Pick<DecideActionRow, "token" | "channel" | "binding" | "chat" | "message" | "act" | "phase" | "run" | "digest">
  & { taskId: DecideActionRow["task_id"]; expiresAt: DecideActionRow["expires_at"]; consumedAt: DecideActionRow["consumed_at"] };

function readAction(raw: unknown): ContractResult<ActionRow> {
  const read = readDecideActionRow(raw);
  if (!read.ok) return read;
  const { task_id: taskId, expires_at: expiresAt, consumed_at: consumedAt, created_at: _created, ...row } = read.value;
  return { ok: true, value: { ...row, taskId, expiresAt, consumedAt } };
}

function mint(store: Store, seat: DecideSeat, message: string | null, spec: ActSpec, taskId: string, phase: ActionRow["phase"], now: Date): string {
  const token = `d:${randomBytes(12).toString("hex")}`;
  store.handle.prepare(`INSERT INTO chat_decide_action (token, channel, binding, chat, message, act, phase, task_id, run, digest, created_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(token, seat.channel, seat.binding, seat.chat, message, spec.act, phase, taskId, spec.run, spec.digest,
    now.toISOString(), new Date(now.getTime() + (phase === "offer" ? OFFER_TTL_MS : CONFIRM_TTL_MS)).toISOString());
  return token;
}

/** The card's buttons, minted now (message unknown until it is sent: `placeDecideTokens` puts them on it). */
export function mintDecideButtons(store: Store, seat: DecideSeat, target: DecideTarget, offer: DecideOffer, now: Date, message: string | null = null):
  { rows: DecideButton[][]; tokens: string[] } {
  const tokens: string[] = [];
  const rows = offer.rows.map(row => row.map((one): DecideButton => {
    if (!isAct(one)) return { label: one.label, link: one };
    const token = mint(store, seat, message, one, target.taskId, "offer", now);
    tokens.push(token);
    return { label: DECIDE_LABELS[one.act], token };
  }));
  return { rows, tokens };
}

/** Put freshly minted tokens on the message they ride: a tap on any other message proves itself stale. */
export function placeDecideTokens(store: Store, tokens: readonly string[], message: string): void {
  const place = store.handle.prepare("UPDATE chat_decide_action SET message = ? WHERE token = ? AND message IS NULL");
  for (const token of tokens) place.run(message, token);
}

/** Every live button on one message stops working: the card was repainted, or one of its acts was taken. */
export function retireDecideTokens(store: Store, channel: DecideChannel, chat: string, message: string, now: Date): void {
  store.handle.prepare("UPDATE chat_decide_action SET consumed_at = ? WHERE channel = ? AND chat = ? AND message = ? AND consumed_at IS NULL")
    .run(now.toISOString(), channel, chat, message);
}

/** Buttons minted for a send or an edit that didn't land: they never act. */
export function dropDecideTokens(store: Store, tokens: readonly string[], now: Date): void {
  const drop = store.handle.prepare("UPDATE chat_decide_action SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL");
  for (const token of tokens) drop.run(now.toISOString(), token);
}

/** Whether a message still carries a button that acts (an offer, or an armed Yes or Cancel): a card whose acts were
 * all spent, as by Not now, needs fresh ones. */
export function hasLiveDecideTokens(store: Store, channel: DecideChannel, chat: string, message: string, now: Date): boolean {
  return store.handle.prepare("SELECT 1 FROM chat_decide_action WHERE channel = ? AND chat = ? AND message = ? AND consumed_at IS NULL AND expires_at > ? LIMIT 1")
    .get(channel, chat, message, now.toISOString()) !== undefined;
}

export function isDecideToken(store: Store, token: string): boolean {
  return token.startsWith("d:") && store.handle.prepare("SELECT 1 FROM chat_decide_action WHERE token = ?").get(token) !== undefined;
}

// ---- a tap -----------------------------------------------------------------------------------------

export type DecideTapOutcome = {
  ack: string;
  /** The card repainted: its text and buttons now. */
  edit?: { text: string; rows: DecideButton[][]; tokens: string[] };
  /** Ask "What should change?": the person's next message is the feedback. `id` names the prompt, so the channel can
   * record the message it sent (a reply to anything else is not the feedback). */
  prompt?: { id: number; text: string };
  /** Merge after the transaction (GitHub is a network call); the card says "Merging…" until it lands, and
   * `recordChatMerge` ledgers how it went. */
  merge?: ChatMerge;
  ignored?: boolean;
};

/** A merge approved in chat, waiting on GitHub: what its ledger line names once the answer is back. */
export type ChatMerge = { runId: number; taskId: string; by: string; repo: string; via: string };

const QUESTIONS: Record<"accept" | "retry" | "approve" | "merge", (name: string) => string> = {
  accept: name => `Accept and finish "${name}"?`,
  retry: name => `Retry "${name}"? It queues another attempt.`,
  approve: name => `Approve and start "${name}"?`,
  merge: name => `Merge "${name}"?`,
};

function targetOf(row: Pick<ActionRow, "act" | "taskId" | "run">): DecideTarget {
  switch (row.act) {
    case "accept": case "changes": return { kind: "result", taskId: row.taskId, run: row.run ?? 0 };
    case "retry": return { kind: "failed", taskId: row.taskId };
    case "merge": return { kind: "merge", taskId: row.taskId, run: row.run ?? 0 };
    default: return { kind: "plan", taskId: row.taskId };
  }
}

/** Why the card's act no longer applies, or null while it still does — checked at the offer and again at the yes. */
function staleWhy(store: Store, row: Pick<ActionRow, "act" | "taskId" | "run" | "digest">, who: VerifiedApprover, now: Date, root?: string): string | null {
  switch (row.act) {
    case "accept": case "changes": {
      const fresh = resultFresh(store, row.taskId, row.run ?? 0, who, now, root);
      if (!fresh.ok) return fresh.why;
      if ((row.act === "accept" ? fresh.receipt : fresh.source) !== row.digest) return "This result changed since this card was sent.";
      return row.act === "accept" && fresh.exception ? "This result needs a reason to accept. Open it in Toolroll." : null;
    }
    case "retry": {
      if (store.getTask(row.taskId)?.state !== "failed") return "This task isn't failed any more.";
      return retryStamp(store, row.taskId, who) === row.digest ? null : "This task changed since this card was sent.";
    }
    case "approve": case "not-now": {
      const plan = planInChat(store, row.taskId, who.name, now, root);
      if (!plan.ok) return plan.why;
      return plan.digest === row.digest ? null : "The plan changed since this card was sent.";
    }
    case "merge": {
      const merge = mergeInChat(store, row.taskId, row.run ?? 0, who.name, now);
      if (!merge.ok) return merge.why;
      return merge.head === row.digest ? null : "This pull request changed since this card was sent.";
    }
  }
}

/** The links a card keeps once its acts are spent or stale: where to look, never a token. */
export function linksFor(target: DecideTarget): DecideButton[][] {
  switch (target.kind) {
    case "result": return [[{ label: DECIDE_LABELS.look, link: { label: DECIDE_LABELS.look, path: chatResultHref(target.taskId, target.run, "changes") } }]];
    case "merge": return [[{ label: "Open task", link: { label: "Open task", path: chatControlHref("task", target.taskId) } }]];
    case "plan": return [[{ label: "Review & start", link: { label: "Review & start", path: chatControlHref("approval", target.taskId) } }]];
    case "failed": return [[{ label: "Open task", link: { label: "Open task", path: chatControlHref("task", target.taskId) } }]];
  }
}

const QUESTION_STARTS = ["Accept and finish \"", "Retry \"", "Approve and start \"", "Merge \""];
/** The card's words without a question this module appended. */
function cardBody(shown: string): string {
  const at = shown.lastIndexOf("\n\n");
  return at >= 0 && QUESTION_STARTS.some(start => shown.startsWith(start, at + 2)) ? shown.slice(0, at) : shown;
}

/**
 * One tap on a decide button, inside the caller's transaction. Null: not this module's token. The seat must be the
 * token's own (person, chat, message); a spent, expired or foreign button acts on nothing.
 */
export function applyDecideTap(store: Store, seat: DecideSeat, input: { token: string; message: string; shown: string; repos: readonly string[]; root?: string; now: Date }): DecideTapOutcome | null {
  const raw = input.token.startsWith("d:") ? store.handle.prepare("SELECT * FROM chat_decide_action WHERE token = ?").get(input.token) : undefined;
  if (raw === undefined) return null;
  const read = readAction(raw);
  // A saved button that can't be read acts on nothing, and says why.
  if (!read.ok) return { ack: `That button can't be read (${read.issues.map(issue => issue.line).join("; ")}). Nothing was done.`, ignored: true };
  const row = read.value;
  const { now } = input;
  if (row.channel !== seat.channel || row.binding !== seat.binding || row.chat !== seat.chat || (row.message !== null && row.message !== input.message)) return { ack: "That button isn't for this chat.", ignored: true };
  if (row.consumedAt !== null) return { ack: "That button was already used or has expired." };
  const verified = verifyApproverStanding(store, seat.approver, seat.generation, input.repos);
  const ref = store.lookupRef(row.taskId);
  if (!verified.ok || ref === null || ref.repo === null || !verified.who.repos.includes(ref.repo)) return { ack: "That task isn't available here now.", ignored: true };
  const who = verified.who;
  const target = targetOf(row);
  const name = title(store, row.taskId);
  const body = cardBody(input.shown);
  const spend = () => {
    // This token by its own id (it may never have been placed on a message), then every other button on the card.
    store.handle.prepare("UPDATE chat_decide_action SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL").run(now.toISOString(), row.token);
    retireDecideTokens(store, seat.channel, seat.chat, input.message, now);
  };
  const stale = (why: string): DecideTapOutcome => {
    spend();
    return { ack: why, edit: { text: `${body}\n\n${why} Nothing was done.`, rows: linksFor(target), tokens: [] } };
  };

  // An expired button: the card says so and keeps its links, so it is never a dead end.
  if (row.expiresAt <= now.toISOString()) {
    spend();
    return { ack: "That button expired.", edit: { text: `${body}\n\nThat button expired. Nothing was done.`, rows: linksFor(target), tokens: [] } };
  }

  if (row.phase === "cancel") {
    spend();
    const offer = decideOffer(store, target, who, now, input.root, seat.channel);
    if (offer === null) return { ack: "Cancelled.", edit: { text: body, rows: linksFor(target), tokens: [] } };
    const minted = mintDecideButtons(store, seat, target, offer, now, input.message);
    return { ack: "Cancelled.", edit: { text: offer.text ?? body, ...minted } };
  }

  const why = staleWhy(store, row, who, now, input.root);
  if (why !== null) return stale(why);

  if (row.phase === "offer") {
    if (row.act === "changes") {
      const id = openDecidePrompt(store, seat, row.taskId, row.run ?? 0, row.digest, now);
      return { ack: WHAT_SHOULD_CHANGE, prompt: { id, text: `${WHAT_SHOULD_CHANGE} Your next message is the feedback for "${name}".` } };
    }
    if (row.act === "not-now") {
      spend();
      return { ack: "Okay, it waits.", edit: { text: `${body}\n\nNot now. It waits for you in Tasks.`,
        rows: [[{ label: DECIDE_LABELS.edit, link: { label: DECIDE_LABELS.edit, path: chatControlHref("approval", row.taskId) } }]], tokens: [] } };
    }
    // The first tap asks; only the yes acts, bound to exactly what this button was.
    spend();
    const spec: ActSpec = { act: row.act, run: row.run, digest: row.digest };
    const yes = mint(store, seat, input.message, spec, row.taskId, "yes", now);
    const cancel = mint(store, seat, input.message, spec, row.taskId, "cancel", now);
    return { ack: "Confirm below.", edit: { text: `${body}\n\n${QUESTIONS[row.act as keyof typeof QUESTIONS](name)}`,
      rows: [[{ label: DECIDE_LABELS.yes, token: yes }, { label: DECIDE_LABELS.cancel, token: cancel }]], tokens: [yes, cancel] } };
  }

  // The yes: the act itself, through the door the console uses.
  spend();
  const done = (said: string, rows: DecideButton[][] = []): DecideTapOutcome => ({ ack: said, edit: { text: `${body}\n\n${said}`, rows, tokens: [] } });
  const notDone = (said: string): DecideTapOutcome => ({ ack: "Not done.", edit: { text: `${body}\n\n✗ Not done: ${said}`, rows: linksFor(target), tokens: [] } });
  switch (row.act) {
    case "accept": {
      if (input.root === undefined) return notDone("this chat can't read the saved result. Open it in Toolroll.");
      const finished = acceptAndCompleteAsOperator(store, row.taskId, { runId: row.run, receiptDigest: row.digest, note: null }, who, now, input.root);
      return finished.ok ? done("✓ Accepted and finished. The recorded checks are unchanged.") : notDone(finished.message);
    }
    case "retry": {
      const stamp = chatTaskStamp(store, who, row.taskId);
      const retried = applyChatTaskAction(store, who, { task: row.taskId, operation: "retry", stamp }, now, true, input.root === undefined ? {} : { evidenceRoot: input.root });
      return retried.ok ? done("✓ Queued again. Existing approvals and holds still apply.") : notDone(retried.message);
    }
    case "approve": {
      const plan = planInChat(store, row.taskId, who.name, now, input.root);
      if (!plan.ok) return notDone(plan.why);
      if (!store.sealScopeApproval(row.taskId, who.name, now, {}, { kind: "mode", modeDigest: plan.modeDigest })) return notDone("the plan couldn't be approved from chat. Open it in Toolroll.");
      store.recordAction({ at: now.toISOString(), actor: who.name, repo: ref.repo, taskId: row.taskId, runId: null, action: "plan approved in chat", outcome: "approved",
        source: "request", detail: `via ${seat.channel} · chat binding #${seat.binding} · mode ${plan.modeDigest}` });
      return done("✓ Approved under your chat approval mode. Work starts when a worker is free.");
    }
    case "merge": {
      const merge = mergeInChat(store, row.taskId, row.run ?? 0, who.name, now);
      if (!merge.ok) return notDone(merge.why);
      const via = `via ${seat.channel} · chat binding #${seat.binding} · mode ${merge.modeDigest} · ${merge.head.slice(0, 12)}`;
      // The approval is ledgered with the tap, so a bridge that stops before GitHub answers still leaves it on record;
      // what GitHub then did is its own line (recordChatMerge).
      store.recordAction({ at: now.toISOString(), actor: who.name, repo: ref.repo, taskId: row.taskId, runId: row.run ?? null, action: "merge approved in chat", outcome: "approved",
        source: "request", detail: via });
      return { ack: "Merging…", edit: { text: `${body}\n\nMerging…`, rows: [], tokens: [] }, merge: { runId: row.run ?? 0, taskId: row.taskId, by: who.name, repo: ref.repo, via } };
    }
    default:
      return { ack: "That button doesn't do anything now.", ignored: true };
  }
}

/** A chat merge's second ledger line, after the GitHub call: merged, or failed and why (its approval is the first). */
export function recordChatMerge(store: Store, merge: ChatMerge, result: { ok: true } | { ok: false; message: string }, now: Date): void {
  store.recordAction({ at: now.toISOString(), actor: merge.by, repo: merge.repo, taskId: merge.taskId, runId: merge.runId, action: "merge from chat",
    outcome: result.ok ? "merged" : "failed", source: "request", detail: result.ok ? merge.via : `${merge.via} · ${phoneText(result.message, 160)}` });
}

/** What the card says once the merge came back. */
export function mergedText(shown: string, result: { ok: true } | { ok: false; message: string }): string {
  const body = shown.replace(/\n\nMerging…$/, "");
  return result.ok ? `${body}\n\n✓ Merged.` : `${body}\n\n✗ Not merged: ${result.message}`;
}

// ---- Request changes: the next message is the feedback -----------------------------------------------

export type DecidePrompt = { id: number; taskId: string; run: number; digest: string; message: string | null };

/** One open "What should change?" per person and chat: a newer one replaces it. */
export function openDecidePrompt(store: Store, seat: DecideSeat, taskId: string, run: number, digest: string, now: Date): number {
  store.handle.prepare("UPDATE chat_decide_prompt SET consumed_at = ? WHERE channel = ? AND binding = ? AND chat = ? AND consumed_at IS NULL")
    .run(now.toISOString(), seat.channel, seat.binding, seat.chat);
  return Number(store.handle.prepare("INSERT INTO chat_decide_prompt (channel, binding, chat, task_id, run, digest, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(seat.channel, seat.binding, seat.chat, taskId, run, digest, now.toISOString(), new Date(now.getTime() + PROMPT_TTL_MS).toISOString()).lastInsertRowid);
}

/** The message that asked "What should change?", once it was sent. */
export function placeDecidePrompt(store: Store, id: number, message: string): void {
  store.handle.prepare("UPDATE chat_decide_prompt SET message = ? WHERE id = ? AND message IS NULL").run(message, id);
}

export function openPromptFor(store: Store, seat: Pick<DecideSeat, "channel" | "binding" | "chat">, now: Date): DecidePrompt | null {
  const row = store.handle.prepare("SELECT * FROM chat_decide_prompt WHERE channel = ? AND binding = ? AND chat = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1")
    .get(seat.channel, seat.binding, seat.chat, now.toISOString());
  return row === undefined ? null : { id: Number(row["id"]), taskId: String(row["task_id"]), run: Number(row["run"]), digest: String(row["digest"]),
    message: row["message"] == null ? null : String(row["message"]) };
}

/** Whether this message answers the prompt: the person's next message, unless it replies to some other message. */
export function answersPrompt(prompt: DecidePrompt, replyTo: string | null): boolean {
  return replyTo === null || (prompt.message !== null && prompt.message === replyTo);
}

/** The person's message after "What should change?": a revision of the exact result, with these words as its
 * feedback, through the result page's own service. Says what was sent, once. */
export function applyDecideFeedback(store: Store, seat: DecideSeat, prompt: DecidePrompt, text: string, repos: readonly string[], root: string | undefined, now: Date):
  { said: string; link: DecideLink | null } {
  store.handle.prepare("UPDATE chat_decide_prompt SET consumed_at = ? WHERE id = ?").run(now.toISOString(), prompt.id);
  const name = title(store, prompt.taskId);
  const verified = verifyApproverStanding(store, seat.approver, seat.generation, repos);
  if (!verified.ok) return { said: "That result isn't available here now. Nothing was sent.", link: null };
  const why = staleWhy(store, { act: "changes", taskId: prompt.taskId, run: prompt.run, digest: prompt.digest }, verified.who, now, root);
  if (why !== null) return { said: `${why} Your feedback wasn't sent.`, link: { label: "Open task", path: chatControlHref("task", prompt.taskId) } };
  if (root === undefined) return { said: "This chat can't read the saved result, so your feedback wasn't sent. Open it in Toolroll.", link: null };
  const revised = requestResultChanges(store, root, {
    run: prompt.run, batch: "", source: prompt.digest, actor: verified.who.name, repos: verified.who.repos,
    note: text, path: "", line: "", request: sha(`chat-decide:${seat.channel}:${prompt.id}`).slice(0, 32), allowMode: true,
  }, now);
  if (!revised.ok) return { said: `Your feedback wasn't sent: ${revised.message}`, link: null };
  const quoted = phoneText(text, 1_000).split("\n").map(line => `| ${line}`).join("\n");
  const scope = store.getScope(revised.id);
  const approved = scope !== null && scope.approvedDigest != null && scope.approvedDigest === scope.digest;
  return {
    said: `Changes requested for "${name}":\n${quoted}\n\n${approved ? "The revision starts under your automatic approval settings." : "The revision waits for your approval."}`,
    link: approved ? { label: "Open task", path: chatControlHref("task", revised.id) } : { label: "Review & start", path: chatControlHref("approval", revised.id) },
  };
}

/** The link a card keeps when it can't act in chat: a plan's is Review & start, where the password step lives. */
export function decideFallbackLink(target: DecideTarget | null): DecideLink | null {
  return target?.kind === "plan" ? { label: "Review & start", path: chatControlHref("approval", target.taskId) } : null;
}

/** Which card a pushed notification is, from its recorded kind and task — never from its words. */
export function decideTargetOf(row: { kind: string; taskId: string | null; run: number | null }): DecideTarget | null {
  if (row.taskId === null) return null;
  if (row.kind === "acceptance-ready" && row.run !== null) return { kind: "result", taskId: row.taskId, run: row.run };
  if (row.kind === "plan-ready") return { kind: "plan", taskId: row.taskId };
  if (row.kind === "pull-request-ready" && row.run !== null) return { kind: "merge", taskId: row.taskId, run: row.run };
  if (/fail|exhausted|stalled|fenced/.test(row.kind)) return { kind: "failed", taskId: row.taskId };
  return null;
}
