/**
 * The Telegram bridge: decisions out, answers back, zero tokens spent.
 *
 * This is channel plumbing — no LLM is anywhere in this path, and everything
 * it renders is deterministic. The security model, in one breath: a chat is
 * not a person, so pairing is a local authenticated act that binds one
 * private chat AND one immutable user id to one approver generation; a
 * button is not a command, so callback_data carries only an opaque one-time
 * token whose meaning lives in this database where a stolen bot token
 * cannot read it; and an answer lands in the same transaction that proves
 * the binding is still live and consumes the token — or it does not land.
 *
 * What a stolen bot token CAN do is stated rather than wished away: read
 * the decision text this installation chose to send through Telegram,
 * repaint the bot's keyboards with deceptive labels, and race our poll for
 * updates. It cannot mint an action token, answer as the operator, or make
 * `answered_by` say anything the pairing did not authorize. Rotating the
 * BotFather token plus `bridge telegram unpair` is the recovery, and both
 * are one command.
 */

import { applyTelegramQuestionReply, applyTelegramQuestionTap, openQuestionOf, telegramQuestionButtons } from "./teammate-question.js";
import { messageTeammate } from "./teammate-desk.js";
import { acceptanceEvidenceText } from "./chat-acceptance.js";
import { verifyApproverStanding } from "./principal.js";
import { resultImageFileName, resultTaskLabel, verifyResultImage } from "./chat-evidence.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateNote } from "./decision.js";
import { isShotsKind, resultShotsFor, type ResultShot } from "./result-shots.js";
import { isLifecycleNotification, isTelegramProgressNotification, RESULT_SHOTS_KIND, TELEGRAM_HOLD_REASONS, type Store, type Decision, type Notification, type TelegramBinding, type TelegramDelivery } from "./store.js";
import { telegramProgressCard, type ProgressEntity } from "./telegram-progress.js";
import { enqueueEveningDigests, finishedView, isTaskFact, joinsBatch, needsPerson, quietCardView, type QuietView } from "./chat-quiet.js";
import { BATCH_MS, chatText, chatTitle, factLinkLabel, mentions, nameTelegramBot } from "./chat-voice.js";
import { LEAD_SAY_KIND, enqueueLeadLapses, leadSayEarlier, leadSayText, leadSubjectOf } from "./lead-voice.js";
import { applyTeamInbound, deliverTeamChats, teamCommand } from "./telegram-team.js";
import { applyFlowChoiceTap, applyFlowConfirm, applyFlowReply, applyFlowTap, flowConfirmOf, type FlowKeyboard, FLOW_DECIDE_KEY, flowButtons, flowChoiceButtons, flowChoiceHead, flowDecisionAt, flowDecisionText, flowSendKeyboardRow, flowSentContent } from "./telegram-flow.js";
import { flowChoiceAt, flowSendTail, FLOW_CHOOSE_KEY, FLOW_SEND_KEY } from "./flow-send.js";
import { cleanFlowMessage, fitFlowMessage } from "./flow-items.js";
import { telegramReply, type TelegramEntity } from "./reply-shape.js";
import { connectChannel, FLOW_WORDS, takeChannelMessage, watchedChannel } from "./chat-inbox.js";
import { focusContextFor, taskInCeiling } from "./chat-channel.js";
import { answersPrompt, applyDecideFeedback, applyDecideTap, decideFallbackLink, dropDecideTokens, hasLiveDecideTokens, linksFor, placeDecidePrompt, decideOffer, decideTargetOf, isDecideToken, mergedText, mintDecideButtons, offerFingerprint, openPromptFor, placeDecideTokens, recordChatMerge, retireDecideTokens,
  type DecideButton, type DecideOffer, type DecideSeat, type DecideTarget } from "./chat-decide.js";
import { mergePullRequest } from "./pull-request-flow.js";
import { phoneCommand, phoneStatus, phoneTaskView, PHONE_CONSOLE_FOOTER, PHONE_HELP, notificationIdentity, phoneTaskChoices, resolvePhoneTask, phoneFocusText, phoneTaskListText, phoneText, PHONE_NO_MATCH, PHONE_BACK_TO_LEAD, type PhoneTaskChoice } from "./telegram-status.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import { envValue } from "./names.js";
import {
  applyProposalTap,
  processTelegramConversations,
  phoneLinkButton,
  type InlineButton,
  replyContextFor,
  telegramConversationRepos,
  telegramRequestId,
  tooLongText,
  whichTaskText,
  type TelegramConversationOptions,
} from "./telegram-mate.js";
import { askOf, parseTelegramUpdate, pickOf, readTelegramButtonData, readTelegramUpdate, telegramButton, type TelegramUpdate } from "./contracts/telegram-callback.js";

/** Read the enrolled project list on demand. No callback means no task data,
 * never an implicit all-database ceiling. Shared by pass and embedded follower. */
export type TelegramReadProjects = () => Promise<readonly string[]>;

/** The environment name — and therefore the name the builder strips from agents (both names; see names.ts). */
export { TELEGRAM_TOKEN_ENV as TOKEN_ENV, TELEGRAM_TOKEN_ENVS as TOKEN_ENVS } from "./names.js";

/** BotFather's shape: numeric bot id, colon, secret. */
const TOKEN_SHAPE = /^(\d+):[A-Za-z0-9_-]{20,}$/;

export const PAIRING_TTL_MS = 10 * 60_000;
export const CONFIRM_TTL_MS = 10 * 60_000;
export const BRIDGE_LEASE_MS = 2 * 60_000;
export const DELIVERY_CLAIM_MS = 2 * 60_000;
/** Telegram's own message ceiling, with room for our part headers. */
const PART_CAP = 3_900;
/** Telegram's own limit on one message's text (Bot API sendMessage), less room for the line a tap adds under it. */
const TELEGRAM_TEXT_MAX = 4_096 - 300;
/** Pages of getUpdates one pass will read before reporting a backlog. */
const PAGE_BUDGET = 10;

// ---- pushed updates (v98) ----------------------------------------------------

/** Where Telegram pushes this bot's updates: under the public hooks address (Tailscale Funnel covers /hooks). */
export const TELEGRAM_HOOK_PATH = "/hooks/telegram";
const HOOK_SECRET_FILE = "telegram-hook-secret";

/** The secret Telegram sends with every push (its header), kept beside the database; made once when asked to. */
export function telegramHookSecret(dir: string, make = false): string | null {
  const file = join(dir, HOOK_SECRET_FILE);
  try { const saved = readFileSync(file, "utf8").trim(); if (/^[A-Za-z0-9_-]{32,256}$/.test(saved)) return saved; } catch { /* none yet */ }
  if (!make) return null;
  const made = randomBytes(32).toString("base64url");
  writeFileSync(file, made, { mode: 0o600 });
  chmodSync(file, 0o600);
  return made;
}

/** The address Telegram pushes to: the public hooks address (https only) and /hooks/telegram; null without one. */
export function telegramPushUrl(hooksBase: string | null): string | null {
  if (hooksBase === null) return null;
  try {
    const url = new URL(hooksBase);
    return url.protocol === "https:" ? `${hooksBase.replace(/\/+$/, "")}${TELEGRAM_HOOK_PATH}` : null;
  } catch {
    return null;
  }
}

/** A push is Telegram's when its secret header matches ours (compared in constant time). */
export function pushedByTelegram(header: unknown, secret: string | null): boolean {
  if (secret === null || typeof header !== "string") return false;
  const given = Buffer.from(header), wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Keep one pushed update for the bridge. A schema-invalid JSON update is logged and acknowledged, never retried. */
export function keepPushedUpdate(store: Store, botId: string, body: Buffer, now: Date): { ok: true; kept: boolean } | { ok: false } {
  let raw: unknown;
  try { raw = JSON.parse(body.toString("utf8")); } catch { return { ok: false }; }
  const update = readTelegramUpdate(raw);
  if (!update.ok) {
    console.warn(`Ignoring a pushed Telegram update: ${update.issues.map(issue => issue.line).join("; ")}`);
    return { ok: true, kept: false };
  }
  return { ok: true, kept: store.queueTelegramUpdate(botId, update.value.update_id, JSON.stringify(raw), now) };
}

// ---- the credential --------------------------------------------------------

export type TokenSource = { token: string; botId: string; source: "env" | "file" };

/**
 * Environment wins, the credential file beside the database otherwise.
 * The file is how the CLI and the web settings card set it (0600, owner
 * only); the env var is how people who already run keychain tooling keep
 * it out of files entirely.
 */
export function loadBotToken(
  env: Record<string, string | undefined>,
  file: string,
): TokenSource | null {
  const fromEnv = envValue(env, "TELEGRAM_TOKEN");
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const parsed = TOKEN_SHAPE.exec(fromEnv.trim());
    return parsed === null ? null : { token: fromEnv.trim(), botId: parsed[1] as string, source: "env" };
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  const parsed = TOKEN_SHAPE.exec(raw);
  return parsed === null ? null : { token: raw, botId: parsed[1] as string, source: "file" };
}

/** Write the credential file, owner-only. Refuses a string that is not a bot token. */
export function saveBotToken(file: string, token: string): { ok: true } | { ok: false; message: string } {
  if (!TOKEN_SHAPE.test(token.trim())) {
    return {
      ok: false,
      message: "that does not look like a bot token (expected <digits>:<secret>, from @BotFather)",
    };
  }
  writeFileSync(file, `${token.trim()}\n`, { mode: 0o600 });
  // writeFileSync applies the mode only on creation; an existing file keeps
  // whatever it had, so the permission is asserted rather than assumed.
  chmodSync(file, 0o600);
  return { ok: true };
}

export function clearBotToken(file: string): boolean {
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The last four characters are enough to recognize a token without holding it. */
export function redactToken(token: string): string {
  return `…${token.slice(-4)}`;
}

/** Scrub a token out of any text on its way to a log, an error, or a row. */
export function scrub(text: string, token: string): string {
  return token === "" ? text : text.split(token).join(redactToken(token));
}

// ---- the transport ---------------------------------------------------------

/**
 * One Bot API call. Injectable, so the suite scripts Telegram instead of
 * dialing it. The optional signal lets a follower cancel a long poll the
 * moment it is told to stop, instead of waiting the poll window out.
 */
export type TelegramTransport = (
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  /** v64: one verified file to send as multipart — the ONLY way bytes leave. Absent, the call is JSON exactly as before. */
  upload?: TelegramUpload,
  /** More verified files in the same multipart call: the rest of one album (sendMediaGroup). */
  more?: readonly TelegramUpload[],
) => Promise<{ ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number }; uncertain?: boolean }>;

/**
 * The one typed shape a file takes onto the wire: bytes the caller already
 * verified, under a name and type the caller chose from the verified
 * kind. There is no path, no URL and no `file_id` form here on purpose —
 * Telegram never fetches anything for us, and nothing on this machine is
 * uploaded by name.
 */
export type TelegramUpload = { field: "document" | "photo" | `shot${number}`; fileName: string; contentType: "image/png" | "image/jpeg"; bytes: Buffer };

export function createTransport(token: string, timeoutMs = 30_000): TelegramTransport {
  return async (method, params, signal, upload, more) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      // A JSON call stays byte for byte what it was. A multipart call lets
      // fetch mint the boundary and the content-type: scalars ride as
      // fields, objects (reply_parameters, reply_markup) as their JSON, and
      // the verified bytes as one Blob under the file name given.
      const request: RequestInit = upload === undefined
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal: controller.signal }
        : { method: "POST", body: multipartOf(params, upload, ...(more ?? [])), signal: controller.signal };
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, request);
      const body = (await response.json()) as { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } | null;
      // A missing or malformed acknowledgement does not prove a send failed.
      // Only Telegram's explicit rejection is a definite failed delivery.
      if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.ok !== "boolean" || (body.ok && !response.ok)) {
        return { ok: false, description: "Telegram returned an invalid acknowledgement", uncertain: true };
      }
      return {
        ok: body.ok === true,
        result: body.result,
        ...(body.parameters === undefined ? {} : { parameters: body.parameters }),
        // Whatever Telegram said, the token must not be in what we keep.
        ...(typeof body.description !== "string" ? {} : { description: scrub(body.description, token) }),
      };
    } catch (error) {
      return {
        ok: false,
        description: scrub(transportError(error), token),
        uncertain: true,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * Why this process can't reach Telegram the way the service does, or null.
 * A coding agent's sandbox fences the network: Codex says so in its own
 * variables, and Claude Code's sandbox routes traffic through a proxy on
 * this computer, which curl uses and Node's fetch does not — so sends fail
 * "fetch failed" while curl works (Oct 2). Builds, checks and agents also
 * get a database of their own, so none of them can hold the live bridge;
 * this keeps an agent-launched `watch` or `bridge` from holding it either.
 */
export function networkFence(env: Record<string, string | undefined>): string | null {
  const set = (name: string): boolean => (env[name] ?? "") !== "";
  if (set("CODEX_SANDBOX_NETWORK_DISABLED") || set("CODEX_SANDBOX")) return "a Codex sandbox";
  const agent = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].some(set);
  const loopbackProxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some(name => {
    const value = env[name] ?? "";
    if (value === "") return false;
    try { return /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(new URL(value.includes("://") ? value : `http://${value}`).hostname); } catch { return false; }
  });
  return agent && loopbackProxy ? "a Claude Code sandbox" : null;
}

/** The plain line a fenced process says instead of polling or sending. */
export function networkFenceLine(reason: string): string {
  return `Telegram: not connecting from here — this process runs inside ${reason}, which blocks its network. Replies and notifications go out from the Toolroll service.`;
}

/** fetch's own message ("fetch failed") with the reason under it, e.g. "fetch failed (EMFILE: too many open files)". */
export function transportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return message;
  const code = typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : null;
  const detail = cause instanceof Error ? cause.message : String(cause);
  const why = code !== null && !detail.includes(code) ? `${code}: ${detail}` : detail;
  return why === "" || why === message ? message : `${message} (${why.slice(0, 160)})`;
}

/** The multipart body: every param a field (objects as JSON), the file last. Exported for the adapter's own test only. */
export function multipartOf(params: Record<string, unknown>, upload: TelegramUpload, ...more: readonly TelegramUpload[]): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  for (const one of [upload, ...more]) form.append(one.field, new Blob([new Uint8Array(one.bytes)], { type: one.contentType }), one.fileName);
  return form;
}

// ---- pairing ---------------------------------------------------------------

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 128 bits, hex — pasteable, and not guessable inside any code's lifetime. */
export function mintPairingCode(): string {
  return randomBytes(16).toString("hex");
}

// ---- the pass --------------------------------------------------------------

export type BridgeReport = {
  sent: number;
  answered: number;
  paired: number;
  ignored: number;
  /** Updates Telegram still holds beyond this pass's page budget. */
  backlog: boolean;
  problems: string[];
  /** Free-text notes captured as drafts. */
  noted?: number;
  /** Digests sent this pass (away mode). */
  digests?: number;
  /** Successful replies to read-only phone commands, separate from outbox sends. */
  statusReplies?: number;
  /** Ordinary messages persisted for the shared assistant this pass. */
  chatQueued?: number;
  /** Assistant replies delivered (including a recovered earlier reply). */
  chatAnswered?: number;
  /** Messages settled without a reply from the assistant: refused, failed, unpaired, or answered deterministically. */
  chatRefused?: number;
  /** Proposal cards confirmed by a tap this pass. */
  chatConfirmed?: number;
  /** v98: another program asked Telegram for this bot's updates (harmless: nothing is lost). */
  contention?: number;
  /** v98: Telegram answered that it pushes this bot's updates to a webhook. */
  webhookActive?: boolean;
  /** v98: pushed updates applied this pass. */
  pushed?: number;
};

type Effect = () => Promise<void>;

/**
 * One bridge pass: claim and send what the outbox holds, then read one
 * budgeted window of updates and apply each in its own transaction. Cron
 * calls this; running it twice concurrently loses the lease race and does
 * nothing, which is the design working.
 */
export async function bridgePass(
  store: Store,
  options: {
    botId: string;
    transport: TelegramTransport;
    clock?: () => Date;
    owner?: string;
    /** false: inbound only — another channel is primary and carries the
     * pages; taps and replies still land here. */
    deliver?: boolean;
    readProjects?: TelegramReadProjects;
    /** Reload channel configuration before every outbound part. */
    canDeliver?: () => boolean;
    /** Ordinary text talks to the shared assistant. Absent: text that is not a command or a decision note is ignored, as before. */
    conversation?: TelegramConversationOptions;
  },
): Promise<{ ok: true; report: BridgeReport } | { ok: false; reason: "bridge-busy"; message: string }> {
  const clock = options.clock ?? (() => new Date());
  const owner = options.owner ?? randomBytes(8).toString("hex");
  const { botId, transport } = options;

  const lease = store.acquireBridgeLease(botId, owner, BRIDGE_LEASE_MS, clock());
  if (!lease.ok) {
    return {
      ok: false,
      reason: "bridge-busy",
      message: `another bridge holds the poll until ${lease.until} — one poller per bot, or taps get eaten`,
    };
  }

  const report: BridgeReport = { sent: 0, answered: 0, paired: 0, ignored: 0, backlog: false, problems: [] };

  try {
    if (options.deliver !== false) {
      await deliverOutbox(store, botId, transport, owner, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin, options.conversation?.evidenceRoot);
      await deliverTeam(store, botId, transport, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin);
    }
    // v98: updates Telegram pushed to the console apply first; asking for more only works while it isn't pushing.
    const pushed = await drainInbox({ store, botId, transport, clock, report, readProjects: options.readProjects, conversation: options.conversation, projects: null }, owner, lease.generation);
    if (pushed > 0) report.pushed = pushed;
    await drainUpdates(store, botId, transport, owner, lease.generation, lease.cursor, clock, report, 0, undefined, options.readProjects, options.conversation);
    if (options.conversation !== undefined && options.readProjects !== undefined) {
      // The queued turns, outside any transaction. A model turn can outlive
      // the poll lease, so the lease is renewed under the same owner while
      // they run — the follower's own fenced renewal, reused.
      const renew = setInterval(() => { store.acquireBridgeLease(botId, owner, BRIDGE_LEASE_MS, clock()); }, 30_000);
      renew.unref?.();
      try {
        await processConversations(store, botId, transport, owner, clock, report, options.readProjects, options.conversation);
      } finally {
        clearInterval(renew);
      }
    }
  } finally {
    // Handed back so the next cron firing is not told busy for the rest of
    // this pass's TTL. A crash skips this and the lease expires instead —
    // which is exactly what the TTL is for.
    store.releaseBridgeLease(botId, owner, clock());
  }

  return { ok: true, report };
}

// ---- the follower ----------------------------------------------------------

/**
 * The longest long poll the follower may ask for. `createTransport`'s HTTP
 * timeout is 30s and must outlive the poll window, or the client would abort
 * a poll Telegram is still honestly holding open.
 */
export const MAX_POLL_SECONDS = 25;
/** Reconnect backoff: starts here, doubles per consecutive failure, capped. */
const FOLLOW_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** A cycle that returned instantly with nothing is padded to this — a scripted or broken server must not spin the loop hot. */
const FOLLOW_IDLE_FLOOR_MS = 1_000;
/** v98: how often the bridge checks Telegram still pushes to us; how long pushes may keep failing before it asks
 * for updates itself; and how long it asks before trying pushes again. */
const PUSH_CHECK_MS = 60_000, PUSH_GIVE_UP_MS = 5 * 60_000, PUSH_RETRY_MS = 15 * 60_000, PUSH_IDLE_MS = 2_000;

export type FollowReport = {
  cycles: number;
  sent: number;
  answered: number;
  paired: number;
  ignored: number;
  problems: string[];
  statusReplies?: number;
  chatQueued?: number;
  chatAnswered?: number;
  chatRefused?: number;
  chatConfirmed?: number;
};

/**
 * The follower (§M4): one actor that holds the poll lease and stays on the
 * wire, so an answer tapped on a phone reaches the store in seconds, not at
 * the next cron firing. `bridge telegram --follow` runs it standalone;
 * watch embeds the same actor — the poll lease guarantees only one is
 * live, and a cron pass overlapping it simply loses the lease race.
 *
 * Each cycle re-acquires the lease under the same owner — that is the
 * fenced renewal: same generation while held, and if the lease lapsed
 * mid-poll (a stall longer than the TTL), the re-acquire takes the next
 * generation and the cursor rides it, so nothing this follower stamped
 * with the old generation can move state afterwards. Transport failures
 * back off exponentially and are counted, not hidden; cancellation aborts
 * the in-flight long poll instead of waiting it out.
 */
/** What Telegram lists when the person taps "/". */
export const TELEGRAM_COMMANDS = [
  { command: "tasks", description: "Pick a task to talk about" },
  { command: "status", description: "Recent work across your projects" },
  { command: "lead", description: "Back to the lead" },
  { command: "help", description: "What you can do here" },
];

export async function followBridge(
  store: Store,
  options: {
    botId: string;
    transport: TelegramTransport;
    signal: AbortSignal;
    clock?: () => Date;
    owner?: string;
    /** false: inbound only; another channel is primary. */
    deliver?: boolean;
    readProjects?: TelegramReadProjects;
    /** Reload channel configuration before every outbound part. */
    canDeliver?: () => boolean;
    /** Ordinary text talks to the shared assistant. */
    conversation?: TelegramConversationOptions;
    pollSeconds?: number;
    /** One line per cycle that did something — the follower's narration hook. */
    onCycle?: (report: BridgeReport) => void;
    /** Injectable for tests; the default resolves early on abort. */
    sleep?: (ms: number) => Promise<void>;
    /** v98: have Telegram push updates to this public address (with this secret) instead of asking for them. */
    push?: { url: string; secret: string } | null;
    /** v98: how often to check Telegram still pushes to us (tests shorten it). */
    pushCheckMs?: number;
  },
): Promise<FollowReport> {
  const clock = options.clock ?? (() => new Date());
  const owner = options.owner ?? `follow-${randomBytes(8).toString("hex")}`;
  const { botId, transport, signal } = options;
  const pollSeconds = Math.max(1, Math.min(options.pollSeconds ?? MAX_POLL_SECONDS, MAX_POLL_SECONDS));

  const wait =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>(resolve => {
        const timer = setTimeout(finish, ms);
        function finish(): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
      }));

  const total: FollowReport = { cycles: 0, sent: 0, answered: 0, paired: 0, ignored: 0, problems: [] };
  let commandsListed = false;
  let failures = 0;
  // Queued turns run BESIDE the poll, never inside a cycle: a long model
  // turn must not stall the long poll, and each cycle's lease re-acquire is
  // the renewal that keeps this the only live poller meanwhile. One
  // processor at a time; its counts land on the totals when it finishes.
  // It only persists the reply: the cycle sends it, in the same slot as
  // notifications, so a reply never needs a connection of its own beside
  // the long poll (Oct 2: replies failed "fetch failed" for minutes while
  // notifications from the same process went out).
  let inFlight: Promise<void> | null = null;
  const kick = (): void => {
    if (inFlight !== null || options.conversation === undefined || options.readProjects === undefined) return;
    const report: BridgeReport = { sent: 0, answered: 0, paired: 0, ignored: 0, backlog: false, problems: [] };
    inFlight = processConversations(store, botId, transport, owner, clock, report, options.readProjects, options.conversation, signal, "turns")
      .catch(error => { report.problems.push(`telegram chat: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => {
        inFlight = null;
        if ((report.chatAnswered ?? 0) > 0) total.chatAnswered = (total.chatAnswered ?? 0) + (report.chatAnswered ?? 0);
        if ((report.chatRefused ?? 0) > 0) total.chatRefused = (total.chatRefused ?? 0) + (report.chatRefused ?? 0);
        total.problems.push(...report.problems);
        if ((report.chatAnswered ?? 0) > 0 || (report.chatRefused ?? 0) > 0 || report.problems.length > 0) options.onCycle?.(report);
      });
  };

  // v98: pushed updates. With a public address, Telegram pushes each update to
  // /hooks/telegram and the console keeps it for us; while it does, nobody can
  // ask Telegram for this bot's updates — no other program can take them. Every
  // minute we check the address is still ours (a framework starting up elsewhere
  // may delete it); if pushes keep failing we ask for updates ourselves for a
  // while, then try pushes again.
  const push = options.push ?? null;
  const pushCheckMs = options.pushCheckMs ?? PUSH_CHECK_MS;
  let pushMode: "push" | "poll" = push === null ? "poll" : "push";
  let pushRegistered = false, pushCheckedAt = -Infinity, pushFailingSince: number | null = null, pollUntil = 0, pollNoted = false;
  const pushing = (): boolean => push !== null && pushMode === "push" && pushRegistered;
  const fallBack = (report: BridgeReport, problem: string): void => {
    pushMode = "poll"; pushRegistered = false; pushFailingSince = null; pollUntil = clock().getTime() + PUSH_RETRY_MS;
    report.problems.push(`${problem}. Asking Telegram for updates directly for now.`);
    store.setTelegramPush(botId, { url: null, problem }, clock());
  };
  const managePush = async (report: BridgeReport): Promise<void> => {
    if (push === null) {
      if (!pollNoted) { store.setTelegramPush(botId, { url: null, problem: null }, clock()); pollNoted = true; }
      return;
    }
    const now = clock().getTime();
    if (pushMode === "poll") { if (now < pollUntil) return; pushMode = "push"; pushRegistered = false; }
    if (pushRegistered && now - pushCheckedAt < pushCheckMs) return;
    pushCheckedAt = now;
    const info = await transport("getWebhookInfo", {}, signal);
    if (!info.ok) { report.problems.push(`getWebhookInfo: ${info.description ?? "failed"}`); return; }
    const hook = (info.result ?? {}) as { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string };
    if (hook.url !== push.url) {
      if (pushRegistered) report.problems.push(`Telegram stopped pushing to ${push.url} (${hook.url ? "another address was set" : "something switched this bot back to being asked for updates"}); set it again`);
      const set = await transport("setWebhook", { url: push.url, secret_token: push.secret, allowed_updates: ["message", "callback_query"], max_connections: 4 }, signal);
      if (!set.ok) { fallBack(report, `Telegram refused the push address ${push.url}: ${set.description ?? "failed"}`); return; }
      pushRegistered = true; pushFailingSince = null;
      store.setTelegramPush(botId, { url: push.url, problem: null }, clock());
      return;
    }
    pushRegistered = true;
    // Telegram couldn't deliver lately and updates are waiting: the address isn't reachable.
    const failing = (hook.pending_update_count ?? 0) > 0 && typeof hook.last_error_date === "number" && now / 1000 - hook.last_error_date < 180;
    if (!failing) { pushFailingSince = null; store.setTelegramPush(botId, { url: push.url, problem: null }, clock()); return; }
    pushFailingSince ??= now;
    store.setTelegramPush(botId, { url: push.url, problem: `Telegram can't reach it: ${hook.last_error_message ?? "no answer"}` }, clock());
    if (now - pushFailingSince < PUSH_GIVE_UP_MS) return;
    await transport("deleteWebhook", { drop_pending_updates: false }, signal);
    fallBack(report, `Telegram couldn't reach ${push.url} (${hook.last_error_message ?? "no answer"})`);
  };

  try {
    while (!signal.aborted) {
      const lease = store.acquireBridgeLease(botId, owner, BRIDGE_LEASE_MS, clock());
      if (!lease.ok) {
        // A cron pass (or a rival follower) holds the poll. Not an error —
        // wait our turn and try again.
        await wait(FOLLOW_BACKOFF_MS[Math.min(failures, FOLLOW_BACKOFF_MS.length - 1)] as number);
        failures = Math.min(failures + 1, FOLLOW_BACKOFF_MS.length - 1);
        continue;
      }

      // The "/" menu in Telegram, once, by the poller that holds the lease:
      // the picker first. Best effort; typed commands work either way.
      if (!commandsListed && options.conversation !== undefined) {
        commandsListed = true;
        // Both carry the stop signal: a stop never waits on a slow Bot API for them.
        try { await transport("setMyCommands", { commands: TELEGRAM_COMMANDS }, signal); } catch { /* typed commands still work */ }
        // After an upgrade, a bot still called StandingOrders becomes Toolroll, once per start; any other name is kept.
        await nameTelegramBot(transport, "upgrade", signal);
      }
      const startedAt = Date.now();
      const report: BridgeReport = { sent: 0, answered: 0, paired: 0, ignored: 0, backlog: false, problems: [] };
      await managePush(report);
      if (options.deliver !== false) {
        await deliverOutbox(store, botId, transport, owner, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin, options.conversation?.evidenceRoot);
        await deliverTeam(store, botId, transport, clock, report, options.readProjects, options.canDeliver, options.conversation?.phoneOrigin);
      }
      // Replies the turn worker has planned go out here, like notifications.
      if (options.conversation !== undefined && options.readProjects !== undefined) {
        await processConversations(store, botId, transport, owner, clock, report, options.readProjects, options.conversation, signal, "replies");
      }
      // Pushed updates first (some may wait from before a fall back), then — only while
      // Telegram isn't pushing — ask for more.
      const pushed = await drainInbox({ store, botId, transport, clock, report, readProjects: options.readProjects, conversation: options.conversation, projects: null }, owner, lease.generation);
      if (pushed > 0) report.pushed = pushed;
      if (!pushing()) {
        // While a turn is running, poll briefly so its reply is sent within a second or two of being written.
        await drainUpdates(
          store, botId, transport, owner, lease.generation, lease.cursor, clock, report, inFlight === null ? pollSeconds : 1, signal, options.readProjects, options.conversation,
        );
        // A push address nobody here wants any more (the public address was removed): take it down, so asking works again.
        if (report.webhookActive === true && push === null) await transport("deleteWebhook", { drop_pending_updates: false }, signal);
      }
      kick();

      total.cycles++;
      total.sent += report.sent;
      total.answered += report.answered;
      total.paired += report.paired;
      total.ignored += report.ignored;
      if (report.statusReplies !== undefined) total.statusReplies = (total.statusReplies ?? 0) + report.statusReplies;
      if (report.chatQueued !== undefined) total.chatQueued = (total.chatQueued ?? 0) + report.chatQueued;
      if (report.chatRefused !== undefined) total.chatRefused = (total.chatRefused ?? 0) + report.chatRefused;
      if (report.chatConfirmed !== undefined) total.chatConfirmed = (total.chatConfirmed ?? 0) + report.chatConfirmed;
      if (report.chatAnswered !== undefined) total.chatAnswered = (total.chatAnswered ?? 0) + report.chatAnswered;
      total.problems.push(...report.problems);
      if (report.sent > 0 || report.answered > 0 || report.paired > 0 || (report.statusReplies ?? 0) > 0 || (report.chatQueued ?? 0) > 0 || (report.chatAnswered ?? 0) > 0 || (report.chatRefused ?? 0) > 0 || (report.chatConfirmed ?? 0) > 0 || report.problems.length > 0) {
        options.onCycle?.(report);
      }

      if (report.problems.length > 0 && report.sent === 0 && report.answered === 0 && (report.chatAnswered ?? 0) === 0) {
        // The wire is down. Back off; the counter resets on the first clean cycle.
        if (!signal.aborted) {
          await wait(FOLLOW_BACKOFF_MS[Math.min(failures, FOLLOW_BACKOFF_MS.length - 1)] as number);
        }
        failures = Math.min(failures + 1, FOLLOW_BACKOFF_MS.length - 1);
        continue;
      }
      failures = 0;

      // A healthy cycle's wait IS the long poll. A cycle that came back
      // instantly and empty (scripted transport, misbehaving server) gets
      // padded so the loop cannot spin hot.
      const took = Date.now() - startedAt;
      // While Telegram pushes (v98) there is no long poll to wait on: a pushed update waits at most this long.
      const floor = pushing() ? PUSH_IDLE_MS : FOLLOW_IDLE_FLOOR_MS;
      if (!signal.aborted && report.sent === 0 && report.answered === 0 && (report.chatAnswered ?? 0) === 0 && took < floor) {
        await wait(floor - took);
      }
    }
  } finally {
    // A turn in flight finishes on its own bounds (the engine's wall clock);
    // its reply is fenced on the claim and the channel like every other part.
    if (inFlight !== null) {
      await inFlight;
      // Its reply was written for the cycle that will not come: send it now, while the lease is still ours.
      if (options.conversation !== undefined && options.readProjects !== undefined) {
        const report: BridgeReport = { sent: 0, answered: 0, paired: 0, ignored: 0, backlog: false, problems: [] };
        await processConversations(store, botId, transport, owner, clock, report, options.readProjects, options.conversation, undefined, "replies").catch(() => {});
        if (report.chatAnswered !== undefined) total.chatAnswered = (total.chatAnswered ?? 0) + report.chatAnswered;
        total.problems.push(...report.problems);
      }
    }
    store.releaseBridgeLease(botId, owner, clock());
  }

  return total;
}

/** The queued turns for one bot, counted onto the pass's report. */
async function processConversations(
  store: Store, botId: string, transport: TelegramTransport, owner: string, clock: () => Date, report: BridgeReport,
  readProjects: TelegramReadProjects, conversation: TelegramConversationOptions, signal?: AbortSignal, only?: "turns" | "replies",
): Promise<void> {
  const chat = { answered: 0, refused: 0, problems: [] as string[] };
  await processTelegramConversations({ store, botId, transport, owner, clock, readProjects, options: conversation, report: chat, ...(signal === undefined ? {} : { signal }), ...(only === undefined ? {} : { only }) });
  if (chat.answered > 0) report.chatAnswered = (report.chatAnswered ?? 0) + chat.answered;
  if (chat.refused > 0) report.chatRefused = (report.chatRefused ?? 0) + chat.refused;
  report.problems.push(...chat.problems);
}

// ---- outbound --------------------------------------------------------------

type SendResult = { ok: true; messageId: string | null } | { ok: false; error: string; retryAfter?: number };
type OutboundSender = (text: string, keyboard?: InlineButton[][], messageRows?: readonly TelegramDelivery[], entities?: TelegramEntity[], silent?: boolean) => Promise<SendResult>;

/** A fact's own next-action button row under the trusted origin read now; none without one. */
function factButton(phoneOrigin: (() => string | null) | undefined, link: string): InlineButton[] | null {
  try { return phoneLinkButton(phoneOrigin?.() ?? null, { label: factLinkLabel(link), path: link }); }
  catch { return null; }
}

/** A view's buttons on one row: its link, then any others ([Merge] [Look first]); none without a trusted origin. */
function viewKeyboard(phoneOrigin: (() => string | null) | undefined, view: QuietView): InlineButton[][] {
  try {
    const origin = phoneOrigin?.() ?? null;
    const row = [view.link, ...(view.also ?? [])].flatMap(link => phoneLinkButton(origin, link) ?? []);
    return row.length === 0 ? [] : [row];
  } catch { return []; }
}

/** Where a paired person taps: their binding and private chat. */
function decideSeat(binding: TelegramBinding): DecideSeat {
  return { channel: "telegram", binding: binding.id, chat: binding.chatId, approver: binding.approver, generation: binding.approverGeneration };
}

/** Decide buttons as Telegram draws them: an act's opaque token, or a link under the trusted origin read now (none without one). */
function decideKeyboard(phoneOrigin: (() => string | null) | undefined, rows: readonly DecideButton[][]): InlineButton[][] {
  let origin: string | null = null;
  try { origin = phoneOrigin?.() ?? null; } catch { origin = null; }
  return rows.map(row => row.flatMap((one): InlineButton[] => "token" in one ? [telegramButton(one.label, one.token)]
    : phoneLinkButton(origin, one.link) ?? [])).filter(row => row.length > 0);
}

/** What this card may act on in the chat now, for this person under their current ceiling; null keeps its link. */
function decideOfferFor(store: Store, binding: TelegramBinding, target: DecideTarget | null | undefined, projects: readonly string[], now: Date, root?: string): DecideOffer | null {
  if (target === null || target === undefined) return null;
  const principal = verifyApproverStanding(store, binding.approver, binding.approverGeneration, telegramConversationRepos(store, binding.approver, projects));
  return principal.ok ? decideOffer(store, target, principal.who, now, "telegram", root) : null;
}

/** Team-conversation traffic to the chats that follow one — after the outbox, under the same delivery switch, never a problem to raise when nothing follows anything. */
async function deliverTeam(
  store: Store, botId: string, transport: TelegramTransport, clock: () => Date, report: BridgeReport,
  readProjects?: TelegramReadProjects, canDeliver?: () => boolean, phoneOrigin?: () => string | null,
): Promise<void> {
  if (store.listTelegramTeamChats(botId).length === 0) return;
  try { if (canDeliver !== undefined && !canDeliver()) return; } catch { return; }
  let projects: readonly string[];
  try { projects = await readProjects?.() ?? []; } catch { report.problems.push("team chats: current project access could not be read"); return; }
  const team = { sent: 0, problems: [] as string[] };
  await deliverTeamChats(store, botId, transport, clock, team, projects, phoneOrigin, { ...(readProjects === undefined ? {} : { readProjects }), ...(canDeliver === undefined ? {} : { canDeliver }) });
  report.sent += team.sent;
  report.problems.push(...team.problems);
}

async function deliverOutbox(
  store: Store, botId: string, transport: TelegramTransport, owner: string,
  clock: () => Date, report: BridgeReport, readProjects?: TelegramReadProjects,
  canDeliver?: () => boolean, phoneOrigin?: () => string | null, evidenceRoot?: string,
): Promise<void> {
  const bindings = store.liveTelegramBindings(botId);
  if (bindings.length === 0) {
    // Routine progress facts are not a problem to fix: a first pairing
    // starts from now and settles them as history. Anything else pending
    // is named, once per pass, as before.
    if (store.listNotifications("pending").some(row => !isLifecycleNotification(row) && !isShotsKind(row.kind))) report.problems.push("outbox rows are pending but no chat is paired — `toolroll bridge telegram pair`");
    return;
  }
  const digest = store.telegramDigest();
  const now = clock();
  // An evening digest someone asked for is due: record it as their own notification, delivered below.
  try { enqueueEveningDigests(store, now, evidenceRoot); } catch { report.problems.push("evening digest could not be prepared"); }
  // A lead claim that went two hours quiet repaints its owner's card back to the task's real state.
  enqueueLeadLapses(store, now);
  const digestDue = digest.everyMs === null || digest.lastSentAt === null || now.getTime() >= new Date(digest.lastSentAt).getTime() + digest.everyMs;
  // Every paired person is a destination of their own: each binding claims
  // and settles its own rows under its own ceiling, in turn.
  for (const binding of bindings) await deliverOutboxTo(store, botId, binding, transport, owner, clock, report, digest, digestDue, readProjects, canDeliver, phoneOrigin, evidenceRoot);
}

async function deliverOutboxTo(
  store: Store, botId: string, binding: TelegramBinding, transport: TelegramTransport, owner: string,
  clock: () => Date, report: BridgeReport, digest: ReturnType<Store["telegramDigest"]>, digestDue: boolean,
  readProjects?: TelegramReadProjects, canDeliver?: () => boolean, phoneOrigin?: () => string | null, evidenceRoot?: string,
): Promise<void> {
  const now = clock();
  // Only when I'm needed (the default): a task's facts edit its one card and only what needs this person makes a
  // new message, so the installation's routine-fact cadence does not apply. Every step keeps today's behaviour.
  const quiet = store.notificationPreference(binding.approver).mode === "quiet";
  const claimed = store.claimTelegramDeliveries(binding, owner, DELIVERY_CLAIM_MS, now, quiet || digestDue ? "all" : "urgent");

  // Preserve ID order, flushing earlier routine facts before an urgent task
  // update. An earlier failed/retrying row also fences later rows for that task.
  const groups: TelegramDelivery[][] = [];
  for (const row of claimed) {
    const last = groups[groups.length - 1];
    if (!quiet && digest.everyMs !== null && joinsDigest(row) && last !== undefined && joinsDigest(last[0]!)) last.push(row);
    else groups.push([row]);
  }
  for (const group of groups) {
    let projects: readonly string[] = [];
    const readAccess = async (): Promise<string | null> => {
      try { projects = await readProjects?.() ?? []; }
      catch { return "Current Telegram delivery access could not be read"; }
      return null;
    };
    const channelProblem = (): string | null => {
      try {
        if (canDeliver !== undefined && !canDeliver()) return TELEGRAM_HOLD_REASONS.disabled;
      } catch { return "Current Telegram delivery access could not be read"; }
      return null;
    };
    const retryAt = (): string => [store.telegramRetryAt(botId), new Date(clock().getTime() + 1_000).toISOString()].sort().at(-1)!;

    // Partition before anything is sent: a row without live authority is
    // retained with its reason, and the rows that ARE eligible go out now
    // rather than waiting on it. Walking in ID order with the eligible set
    // as the batch keeps a task's later facts behind its blocked earlier one.
    const rows: TelegramDelivery[] = [];
    const blocked: { row: TelegramDelivery; error: string }[] = [];
    const preflight = (await readAccess()) ?? channelProblem();
    for (const row of group) {
      const problem = preflight ?? store.telegramDeliveryProblem(row, binding, owner, projects, clock(), [...rows.map(one => one.id), row.id]);
      if (problem === null) rows.push(row);
      else blocked.push({ row, error: problem });
    }
    store.transact(() => {
      for (const { row, error } of blocked) store.finalizeTelegramDelivery(row, binding, owner, { ok: false, error, retryAt: retryAt() }, clock());
    });
    for (const { row, error } of blocked) report.problems.push(`notification ${row.id}: ${error}`);
    if (rows.length === 0) continue;

    const ids = rows.map(row => row.id);
    const fence = (): string | null => {
      const channel = channelProblem();
      if (channel !== null) return channel;
      for (const row of rows) {
        const problem = store.telegramDeliveryProblem(row, binding, owner, projects, clock(), ids);
        if (problem !== null) return problem;
      }
      return null;
    };
    const sender: OutboundSender = async (text, keyboard, messageRows = rows, entities, silent) => {
      // Finish every await before the synchronous fence and transport call.
      const problem = (await readAccess()) ?? fence();
      if (problem !== null) return { ok: false, error: problem };
      const sent = await send(transport, binding.chatId, text, keyboard, entities, silent);
      if (!sent.ok) {
        if (sent.retryAfter !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + sent.retryAfter * 1_000).toISOString());
        return sent;
      }
      if (sent.messageId === null) return { ok: false, error: "Telegram returned no confirmed message identity" };
      for (const row of messageRows) store.recordTelegramMessage(row, binding, sent.messageId, clock());
      // Keep the old message's history but never acknowledge a replaced pairing.
      const after = (await readAccess()) ?? fence();
      return after === null ? sent : { ok: false, error: after };
    };
    const imageSender = async (row: TelegramDelivery): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> => {
      const problem = (await readAccess()) ?? fence();
      if (problem !== null) return { ok: false, error: problem };
      const match = /^life:acceptance-evidence:r(\d+)-a(\d+)-([a-f0-9]{64}):\d+$/.exec(row.dedupeKey);
      if (match === null || row.taskId === null || row.run === null || store.getRun(Number(match[1]))?.parentRun !== row.run) return { ok: false, error: "Screenshot notification does not match its recorded review" };
      const family = store.taskFamilyOf(row.taskId, projects, false);
      const current = family?.current.id === row.taskId && store.runsFor(row.taskRef!).find(one => one.finishedAt !== null && ["builder", "repair", "scout"].includes(one.role))?.id === row.run;
      const skip = store.proofAcceptance(row.run) !== null ? "Acceptance is already recorded; no further acceptance is needed." : !current ? "A newer result is current. Request its evidence before accepting." : null;
      const verified = evidenceRoot === undefined ? { ok: false as const, problem: "the bridge cannot read evidence files" } : verifyResultImage(store, evidenceRoot, telegramConversationRepos(store, binding.approver, projects), { taskId: row.taskId, run: row.run, artifact: Number(match[2]), sha256: match[3]! });
      if (skip !== null) return { ok: true, receipt: store.proofAcceptance(row.run) !== null ? "skipped:already-accepted" : "skipped:newer-result" };
      if (!verified.ok) {
        const sent = await sender(`A screenshot for result #${row.run} could not be sent: ${verified.problem}. Inspect the result before accepting.`);
        return sent.ok ? { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) } : sent;
      }
      // Already sent with its result (result-shots.ts): the same screenshot is not sent again.
      const artifact = Number(match[2]);
      if (store.resultShotsSent(row.destination, row.run).has(artifact)) return { ok: true, receipt: "skipped:screenshot-sent" };
      // Marked while it goes, so the screenshots sent with the result skip it; any failure unmarks it for the retry.
      store.markResultShotsSent(row.destination, row.run, [artifact], clock());
      // No await between the access fence, file validation and upload.
      let answer: Awaited<ReturnType<TelegramTransport>>;
      try { answer = await transport("sendDocument", { chat_id: binding.chatId, caption: `${resultTaskLabel(row.taskId)} · result #${row.run} · screenshot for acceptance` }, undefined, {
        field: "document", bytes: verified.bytes, contentType: verified.format === "png" ? "image/png" : "image/jpeg", fileName: resultImageFileName(row.taskId, row.run, artifact, verified.format),
      });
      } catch {
        store.unmarkResultShotsSent(row.destination, row.run, [artifact]);
        return { ok: false, error: "Screenshot delivery is unconfirmed; retry may duplicate it" };
      }
      const messageId = (answer.result as { message_id?: number } | undefined)?.message_id;
      if (!answer.ok || !Number.isSafeInteger(messageId)) {
        store.unmarkResultShotsSent(row.destination, row.run, [artifact]);
        if (answer.parameters?.retry_after !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + answer.parameters.retry_after * 1000).toISOString());
        return { ok: false, error: answer.uncertain || (answer.ok && messageId == null) ? "Screenshot delivery is unconfirmed; retry may duplicate it" : "Telegram did not accept the screenshot" };
      }
      store.recordTelegramMessage(row, binding, String(messageId), clock());
      const after = (await readAccess()) ?? fence();
      return after === null ? { ok: true, receipt: receiptFor(botId, binding.chatId, String(messageId)) } : { ok: false, error: after };
    };
    /** Screenshots with a result (result-shots.ts): photos, several as one album, re-proved before every call. Each is
     * marked sent before it goes, so an unconfirmed send is never repeated; only Telegram's outright refusal unmarks it. */
    const shotsSender = async (row: TelegramDelivery): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> => {
      let receipt: string | null = null;
      for (let call = 0; call <= 4; call++) {
        const problem = (await readAccess()) ?? fence();
        if (problem !== null) return { ok: false, error: problem };
        const plan = resultShotsFor(store, evidenceRoot, telegramConversationRepos(store, binding.approver, projects), row, store.resultShotsSent(row.destination, row.run ?? 0));
        if (plan.kind === "none") return call > 0 ? { ok: true, receipt } : { ok: true, receipt: `skipped:screenshots-${plan.why}` };
        if (plan.kind === "line") {
          const sent = await sender(plan.text, undefined, [row]);
          return sent.ok ? { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) } : sent;
        }
        // No await between the access fence, the files' verification and the upload.
        const photos = plan.shots.filter(one => one.photo);
        const batch: ResultShot[] = photos.length >= 2 ? photos : [plan.shots[0]!];
        const upload = (one: ResultShot, field: TelegramUpload["field"]): TelegramUpload =>
          ({ field, fileName: one.fileName, contentType: one.format === "png" ? "image/png" : "image/jpeg", bytes: one.bytes });
        const ids = batch.map(one => one.artifact);
        store.markResultShotsSent(row.destination, plan.run, ids, clock());
        let answer: Awaited<ReturnType<TelegramTransport>>;
        try {
          answer = batch.length > 1
            ? await transport("sendMediaGroup", { chat_id: binding.chatId, media: batch.map((one, index) => ({ type: "photo", media: `attach://shot${index}`, ...(index === 0 || one.numbered === true ? { caption: one.caption } : {}) })) },
              undefined, upload(batch[0]!, "shot0"), batch.slice(1).map((one, index) => upload(one, `shot${index + 1}`)))
            : batch[0]!.photo
              ? await transport("sendPhoto", { chat_id: binding.chatId, caption: batch[0]!.caption }, undefined, upload(batch[0]!, "photo"))
              : await transport("sendDocument", { chat_id: binding.chatId, caption: batch[0]!.caption }, undefined, upload(batch[0]!, "document"));
        } catch { answer = { ok: false, uncertain: true }; }
        if (!answer.ok && answer.uncertain !== true) {
          store.unmarkResultShotsSent(row.destination, plan.run, ids);
          if (answer.parameters?.retry_after !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + answer.parameters.retry_after * 1000).toISOString());
          return { ok: false, error: "Telegram did not accept the screenshots" };
        }
        const messages = (Array.isArray(answer.result) ? answer.result : [answer.result])
          .map(one => (one as { message_id?: number } | undefined)?.message_id).filter((one): one is number => Number.isSafeInteger(one));
        // An unconfirmed send stays marked: it may have arrived, so it is never sent again.
        if (!answer.ok || messages.length === 0) report.problems.push(`notification ${row.id}: Telegram did not confirm the screenshots; they are not sent again`);
        for (const one of messages) store.recordTelegramMessage(row, binding, String(one), clock());
        receipt = receiptFor(botId, binding.chatId, messages.length === 0 ? null : String(messages[0]));
      }
      return { ok: true, receipt };
    };
    const batched = !quiet && digest.everyMs !== null && joinsDigest(rows[0]!);
    const row = rows[0]!;
    const progressRun = batched ? null : store.telegramProgressRun(row);
    const progress = progressRun !== null && isTelegramProgressNotification(row);
    const updateProgress = async (onlyExisting: boolean): Promise<SendResult | null> => {
      if (progressRun === null || row.taskId === null || row.project === null) return null;
      const problem = (await readAccess()) ?? fence();
      if (problem !== null) return { ok: false, error: problem };
      const messageId = store.telegramProgressMessage(binding, progressRun);
      if (messageId === null && onlyExisting) return null;
      const card = telegramProgressCard(store, store.getRun(progressRun.id)!, row.taskId, row.project, clock(), evidenceRoot, binding.approver);
      let button: InlineButton[] | null = null;
      try { button = phoneLinkButton(phoneOrigin?.() ?? null, card.link); } catch { /* No trusted origin. */ }
      const keyboard = button === null ? [] : [button];
      if (messageId === null) return sender(card.text, keyboard, rows, card.entities);
      const edited = await editProgress(transport, binding.chatId, messageId, card.text, keyboard, card.entities);
      if (!edited.ok) {
        if (edited.retryAfter !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + edited.retryAfter * 1000).toISOString());
        // Only Telegram's definitive missing/uneditable response permits a
        // replacement. Timeouts, rate limits and uncertain edits retry in place.
        if (!onlyExisting && edited.replace) return sender(card.text, keyboard, rows, card.entities);
        return edited;
      }
      if (!onlyExisting) store.recordTelegramMessage(row, binding, messageId, clock());
      const after = (await readAccess()) ?? fence();
      return after === null ? edited : { ok: false, error: after };
    };
    /** Quiet mode: the task's one card (or its group's), created silently and then only ever edited. */
    const updateCard = async (fact: TelegramDelivery & { taskRef: number; taskId: string }): Promise<SendResult> => {
      const problem = (await readAccess()) ?? fence();
      if (problem !== null) return { ok: false, error: problem };
      const card = store.chatCardFor(fact.destination, fact.taskRef, store.getTask(fact.taskId)?.createdAt ?? fact.createdAt, clock());
      const view = quietCardView(store, card.tasks, clock(), evidenceRoot, binding.approver);
      if (view === null) return { ok: true, messageId: card.message };
      let button: InlineButton[] | null = null;
      try { button = phoneLinkButton(phoneOrigin?.() ?? null, view.link); } catch { /* No trusted origin. */ }
      const keyboard = button === null ? [] : [button];
      const shown = createHash("sha256").update(JSON.stringify([view.text, view.entities, keyboard])).digest("hex");
      if (card.message !== null && card.digest === shown) {
        store.recordTelegramMessage(fact, binding, card.message, clock());
        return { ok: true, messageId: card.message };
      }
      if (card.message !== null) {
        const edited = await editProgress(transport, binding.chatId, card.message, view.text, keyboard, view.entities);
        if (edited.ok) {
          store.setChatCardMessage(card.id, card.message, shown);
          store.recordTelegramMessage(fact, binding, card.message, clock());
          const after = (await readAccess()) ?? fence();
          return after === null ? edited : { ok: false, error: after };
        }
        if (edited.retryAfter !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + edited.retryAfter * 1000).toISOString());
        // Only Telegram's definitive missing/uneditable answer permits a replacement card.
        if (!edited.replace) return edited;
      }
      const sent = await sender(view.text, keyboard, [fact], view.entities, true);
      // A card that reached the chat is kept even if a later fence refused the acknowledgement: never a second card.
      const placed = sent.ok ? sent.messageId : store.telegramMessageOf(fact.id, fact.destination);
      if (placed !== null) store.setChatCardMessage(card.id, placed, shown);
      return sent;
    };
    const quietOutcome = async (fact: TelegramDelivery & { taskRef: number; taskId: string; project: string }): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> => {
      const card = await updateCard(fact);
      if (!card.ok) return card;
      if (!needsPerson(fact)) return { ok: true, receipt: receiptFor(botId, binding.chatId, card.messageId) };
      const readyRun = fact.kind === "run-finished" ? store.telegramProgressRun(fact) : null;
      if (readyRun !== null || (fact.kind !== "run-finished" && joinsBatch(fact))) {
        // Any update for this person joins their open batch: one message, edited in place while it grows.
        const batch = store.chatBatchFor(fact.destination, fact.taskRef, readyRun?.id ?? store.telegramProgressRun(fact)?.id ?? null, clock(), BATCH_MS,
          readyRun !== null ? null : fact.id);
        // A lone update that is not finished work goes out exactly as it always has; a later one edits it in place.
        const lone = batch.items.length === 1 && batch.items[0]!.notification !== null;
        if (batch.message === null && lone) {
          const sent = await deliverOne(store, botId, binding, sender, fact, clock, phoneOrigin, evidenceRoot, projects);
          const placed = store.telegramMessageOf(fact.id, fact.destination);
          if (placed !== null) store.setChatBatchMessage(batch.id, placed, "");
          return sent;
        }
        const view = finishedView(store, batch, clock(), evidenceRoot, binding.approver);
        // Nothing in the batch reads as a line. Finished work left out on purpose (a release check, a replaced task,
        // the reader's own completion) stays quiet; any other update that needs this person still reaches them alone.
        if (view === null) {
          if (readyRun !== null) return { ok: true, receipt: receiptFor(botId, binding.chatId, card.messageId) };
          return deliverOne(store, botId, binding, sender, fact, clock, phoneOrigin, evidenceRoot, projects);
        }
        // A message about one result, plan, failure or pull request acts in place (chat-decide.ts); its buttons are
        // minted only when what it offers changed, or its own were spent (Not now), so an unchanged repaint keeps the
        // ones already in the chat.
        const offer = decideOfferFor(store, binding, view.target, projects, clock(), evidenceRoot);
        const text = offer?.text ?? view.text;
        // While a lone update is still the only item, its edit keeps that update's own action button.
        const own = offer === null && lone && fact.link !== null ? factButton(phoneOrigin, fact.link) : null;
        let keyboard = own !== null ? [own] : viewKeyboard(phoneOrigin, view);
        const shown = createHash("sha256").update(JSON.stringify(offer === null ? [view.text, keyboard] : [text, offerFingerprint(offer)])).digest("hex");
        let tokens: string[] = [];
        // Minted unplaced: they ride a message only once it shows them, and until then the old card's buttons work.
        const mintFor = (): void => {
          if (offer === null) return;
          const minted = mintDecideButtons(store, decideSeat(binding), view.target!, offer, clock());
          keyboard = decideKeyboard(phoneOrigin, minted.rows);
          tokens = minted.tokens;
        };
        if (batch.message !== null) {
          if (batch.digest === shown && (offer === null || hasLiveDecideTokens(store, "telegram", binding.chatId, batch.message, clock()))) {
            store.recordTelegramMessage(fact, binding, batch.message, clock());
            return { ok: true, receipt: receiptFor(botId, binding.chatId, batch.message) };
          }
          const problem = (await readAccess()) ?? fence();
          if (problem !== null) return { ok: false, error: problem };
          mintFor();
          const edited = await editProgress(transport, binding.chatId, batch.message, text, keyboard);
          if (edited.ok) {
            // The repaint landed: the old words' buttons retire and the new ones ride the message.
            retireDecideTokens(store, "telegram", binding.chatId, batch.message, clock());
            placeDecideTokens(store, tokens, batch.message);
            store.setChatBatchMessage(batch.id, batch.message, shown);
            store.recordTelegramMessage(fact, binding, batch.message, clock());
            const after = (await readAccess()) ?? fence();
            return after === null ? { ok: true, receipt: receiptFor(botId, binding.chatId, batch.message) } : { ok: false, error: after };
          }
          // A failed edit: the buttons it carried never act, and the card's old ones keep working.
          dropDecideTokens(store, tokens, clock());
          if (edited.retryAfter !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + edited.retryAfter * 1000).toISOString());
          // Only Telegram's definitive missing/uneditable answer permits a new message.
          if (!edited.replace) return edited;
        }
        // A new message: its buttons are minted for it, never the ones a failed edit was given.
        mintFor();
        const sent = await sender(text, keyboard.length === 0 ? undefined : keyboard, [fact]);
        const placed = sent.ok ? sent.messageId : store.telegramMessageOf(fact.id, fact.destination);
        if (placed !== null) store.setChatBatchMessage(batch.id, placed, shown);
        if (sent.ok && sent.messageId !== null) {
          // The new card replaces the old one: only its buttons act.
          if (batch.message !== null) retireDecideTokens(store, "telegram", binding.chatId, batch.message, clock());
          placeDecideTokens(store, tokens, sent.messageId);
        } else dropDecideTokens(store, tokens, clock());
        return sent.ok ? { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) } : sent;
      }
      return fact.kind === "acceptance-evidence" ? imageSender(fact) : deliverOne(store, botId, binding, sender, fact, clock, phoneOrigin, evidenceRoot, projects);
    };
    /** The lead's words (lead-voice.ts): one message; a later say within two minutes edits it in place. */
    const leadSayOutcome = async (fact: TelegramDelivery): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> => {
      const words = leadSayText(store, fact, binding.approver);
      const button = fact.link === null ? null : factButton(phoneOrigin, fact.link);
      const keyboard = button === null ? [] : [button];
      const earlier = leadSayEarlier(store, fact).map(id => store.telegramMessageOf(id, fact.destination)).find(one => one !== null) ?? null;
      if (earlier !== null) {
        const problem = (await readAccess()) ?? fence();
        if (problem !== null) return { ok: false, error: problem };
        const edited = await editProgress(transport, binding.chatId, earlier, words, keyboard);
        if (edited.ok) {
          store.recordTelegramMessage(fact, binding, earlier, clock());
          const after = (await readAccess()) ?? fence();
          return after === null ? { ok: true, receipt: receiptFor(botId, binding.chatId, earlier) } : { ok: false, error: after };
        }
        if (edited.retryAfter !== undefined) store.deferTelegram(botId, new Date(clock().getTime() + edited.retryAfter * 1000).toISOString());
        // Only Telegram's definitive missing/uneditable answer permits a new message.
        if (!edited.replace) return edited;
      }
      const sent = await sender(words, keyboard.length === 0 ? undefined : keyboard, [fact]);
      return sent.ok ? { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) } : sent;
    };
    let outcome: { ok: true; receipt: string | null } | { ok: false; error: string };
    if (rows.length === 1 && isShotsKind(row.kind)) outcome = await shotsSender(row);
    else if (rows.length === 1 && row.kind === LEAD_SAY_KIND) outcome = await leadSayOutcome(row);
    else if (quiet && rows.length === 1 && isTaskFact(row)) outcome = await quietOutcome(row);
    else {
      // A failure or decision still gets its own alert. Refresh an existing
      // card first so it does not keep saying the build is running.
      if (!progress && progressRun !== null) await updateProgress(true);
      const updated = progress ? await updateProgress(false) : null;
      outcome = updated !== null ? updated.ok ? { ok: true as const, receipt: receiptFor(botId, binding.chatId, updated.messageId) } : updated
        : rows[0]!.kind === "acceptance-evidence" ? await imageSender(rows[0]!) : batched
        ? await deliverDigest(botId, binding, sender, rows, digest.lastSentAt, clock, taskId => chatTitle(store, taskId))
        : await deliverOne(store, botId, binding, sender, rows[0]!, clock, phoneOrigin, evidenceRoot, projects);
    }
    const finalProblem = outcome.ok ? (await readAccess()) ?? fence() : null;
    const settled = finalProblem === null ? outcome : { ok: false as const, error: finalProblem };
    // A skipped screenshot settles its row but nothing reached the phone.
    const skipped = settled.ok && settled.receipt !== null && settled.receipt.startsWith("skipped:");
    const finalized = store.transact(() => {
      let count = 0;
      for (const row of rows) {
        const result = settled.ok ? settled : { ...settled, retryAt: retryAt() };
        if (store.finalizeTelegramDelivery(row, binding, owner, result, clock()) && settled.ok) count++;
      }
      if (batched && count === rows.length) store.markTelegramDigestSent(clock());
      return count;
    });
    if (!skipped) report.sent += finalized;
    if (batched && finalized === rows.length) report.digests = (report.digests ?? 0) + 1;
    if (!settled.ok) report.problems.push(`${batched ? `digest of ${rows.length} notification(s)` : `notification ${rows[0]!.id}`}: ${settled.error}`);
    else if (finalized !== rows.length) report.problems.push("Telegram delivery claim expired before acknowledgement; retry may duplicate a message");
  }
}

/** What pages singly whatever the cadence: a decision, or an attention-class fact. */
function isUrgent(notification: Notification): boolean {
  return /^decision:\d+$/.test(notification.dedupeKey) || notification.pushClass === "attention" || notification.kind === "acceptance-evidence" || notification.kind === "acceptance-ready";
}

/** A routine fact the digest may carry. Screenshots are never urgent (they follow their result message, which the
 * task's order fence holds them behind) and never a digest line: they go as their own photos once it has gone. */
function joinsDigest(notification: Notification): boolean {
  return !isUrgent(notification) && !isShotsKind(notification.kind);
}

/** The digest text: a header with the count and the window, then one
 * fact per entry — its subject, then its body's first line, indented.
 * Plain text, no buttons: nothing in a digest is tappable. */
export function digestText(rows: readonly Notification[], since: string | null, now: Date, titleOf?: (taskId: string) => string): string {
  const window = since === null ? "" : ` since ${since.slice(0, 16).replace("T", " ")}`;
  const lines = [`digest — ${rows.length} routine fact(s)${window} (as of ${now.toISOString().slice(0, 16).replace("T", " ")})`, ""];
  for (const row of rows) {
    lines.push(digestEntry(row, titleOf));
  }
  return lines.join("\n");
}

function digestEntry(row: Notification, titleOf?: (taskId: string) => string): string {
  const title = row.taskId === null ? undefined : titleOf?.(row.taskId);
  const task = row.taskId === null ? [] : [{ id: row.taskId, ...(title === undefined ? {} : { title }) }];
  const subject = chatText(row.subject, task);
  const first = row.body.split("\n").map(one => one.trim()).find(one => one !== "");
  const body = first === undefined ? "" : `\n    ${first.length > 200 ? `${first.slice(0, 200).replace(/[\uD800-\uDBFF]$/, "")}…` : first}`;
  return `• ${notificationIdentity(row, title !== undefined && mentions(subject, title) ? undefined : title)}${subject}${chatText(body, task)}`;
}

async function deliverDigest(
  botId: string, binding: TelegramBinding, sender: OutboundSender,
  rows: readonly TelegramDelivery[], since: string | null, clock: () => Date, titleOf?: (taskId: string) => string,
): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> {
  const text = digestText(rows, since, clock(), titleOf);
  // Track the exact rows represented by each text part. A split row may bind
  // several messages; a digest message may bind several rows.
  let offset = text.indexOf("\n\n") + 2;
  const spans = rows.map(row => {
    const length = digestEntry(row, titleOf).length;
    const span = { row, start: offset, end: offset + length };
    offset += length + 1;
    return span;
  });
  let last: string | null = null;
  let at = 0;
  for (const part of split(text)) {
    const related = spans.filter(span => span.start < at + part.length && span.end > at).map(span => span.row);
    const sent = await sender(part, undefined, related);
    if (!sent.ok) return sent;
    last = sent.messageId;
    at += part.length;
  }
  return { ok: true, receipt: receiptFor(botId, binding.chatId, last) };
}

async function deliverOne(
  store: Store,
  botId: string,
  binding: TelegramBinding,
  sender: OutboundSender,
  notification: TelegramDelivery,
  clock: () => Date,
  phoneOrigin?: () => string | null,
  evidenceRoot?: string,
  projects: readonly string[] = [],
): Promise<{ ok: true; receipt: string | null } | { ok: false; error: string }> {
  const decisionId = /^decision:(\d+)$/.exec(notification.dedupeKey);
  const decision = decisionId === null ? null : store.getDecision(Number(decisionId[1]));

  if (decision !== null && (notification.taskRef === null || store.getRun(decision.run)?.taskRef !== notification.taskRef || (notification.run !== null && notification.run !== decision.run))) {
    return { ok: false, error: "Decision does not match notification provenance" };
  }

  if (decision === null || decision.state === "answered") {
    // A plain fact, or a decision settled before the bridge got to it: the
    // text is the message. Its one next-action button — the fact's
    // machine-minted link under the trusted origin read now, never a token
    // and never persisted — rides the LAST part only, exactly as `/task`'s
    // does; with no trusted origin the words stand alone.
    const alreadyAccepted = notification.kind === "acceptance-ready" && notification.run !== null && store.proofAcceptance(notification.run) !== null;
    let body = alreadyAccepted ? "This result already has recorded human acceptance. No further acceptance is needed." : notification.body;
    let current = true;
    if (notification.kind === "acceptance-ready" && !alreadyAccepted && notification.taskId !== null && notification.run !== null) {
      const principal = verifyApproverStanding(store, binding.approver, binding.approverGeneration, telegramConversationRepos(store, binding.approver, projects));
      if (!principal.ok) return { ok: false, error: "Current acceptance evidence access could not be verified" };
      const packet = acceptanceEvidenceText(store, principal.who, evidenceRoot, notification.taskId, notification.run);
      if (!packet.ok) { body = `Acceptance evidence unavailable: ${packet.message}`; current = false; }
      else if (!packet.isCurrent) { body = "A newer result is current. Request its evidence before accepting."; current = false; }
      else body = `${packet.text}\n\n${notification.body}`;
    }
    // A short title, never the task's id or a "— revision" suffix (chat-voice.ts).
    const title = notification.taskId === null ? undefined : chatTitle(store, notification.taskId);
    const task = notification.taskId === null ? [] : [{ id: notification.taskId, ...(title === undefined ? {} : { title }) }];
    const words = chatText(`${alreadyAccepted ? "Acceptance recorded" : leadSubjectOf(store, notification, binding.approver)}${body === "" ? "" : `\n\n${body}`}`, task);
    // The task's title once: in front, unless the words already name it.
    // A result, plan, failure or ready pull request acts in place (chat-decide.ts); otherwise its one link.
    const target = alreadyAccepted || !current ? null : decideTargetOf(notification);
    const offer = decideOfferFor(store, binding, target, projects, clock(), evidenceRoot);
    const decided = offer === null ? null : mintDecideButtons(store, decideSeat(binding), target!, offer, clock());
    let parts = split(offer?.text ?? `${notificationIdentity(notification, title !== undefined && mentions(words, title) ? undefined : title)}${words}`);
    const fallback = offer === null ? decideFallbackLink(target) : null;
    let button = fallback !== null ? (() => { try { return phoneLinkButton(phoneOrigin?.() ?? null, fallback); } catch { return null; } })()
      : offer === null && notification.link !== null && !alreadyAccepted && current ? factButton(phoneOrigin, notification.link) : null;
    // A flow card waiting on a decision (v86): Approve, Edit, Send back on the last part, for this visit only.
    const visit = FLOW_DECIDE_KEY.exec(notification.dedupeKey);
    const waiting = visit === null ? null : flowDecisionAt(store, Number(visit[1]), Number(visit[2]));
    const flowKeys = waiting === null ? null : flowButtons(store, binding, waiting, clock());
    // A flow's "Send to me" or "Person chooses" (flow-send.ts): its links as buttons, and a choice's options above them.
    const sentVisit = FLOW_SEND_KEY.exec(notification.dedupeKey) ?? FLOW_CHOOSE_KEY.exec(notification.dedupeKey);
    const sent = sentVisit === null ? null : flowSentContent(store, Number(sentVisit[1]), Number(sentVisit[2]));
    const choosing = sent === null || !FLOW_CHOOSE_KEY.test(notification.dedupeKey) || notification.recipient !== binding.approver ? null : flowChoiceAt(store, Number(sentVisit![1]), Number(sentVisit![2]));
    const choiceKeys = choosing === null || sent === null ? null : flowChoiceButtons(store, binding, choosing, sent, clock());
    const sentRow = sent === null ? null : (() => { try { return flowSendKeyboardRow(phoneOrigin?.() ?? null, sent); } catch { return []; } })();
    if (sentRow !== null) button = sentRow.length === 0 ? null : sentRow;
    // A flow decision or choice for this person leads with what to do and where each button takes the card
    // (telegram-flow.ts); the flow and zone close it. The saved notice keeps its own words for every other place.
    const pull = sent === null ? [] : sent.links.flatMap(one => "url" in one ? [`${one.label}: ${one.url}`] : []).slice(0, 1);
    const choiceHead = choosing === null || sent === null ? null : flowChoiceHead(choosing, sent);
    const choiceTail = choosing === null ? [] : [...pull, `${choosing.flow.name}${sent?.from === undefined ? "" : ` · after ${sent.from}`}`];
    if (offer === null && flowKeys !== null && waiting !== null) parts = split(`${notificationIdentity(notification)}${chatText(flowDecisionText(waiting, notification.body), task)}`);
    else if (offer === null && choiceHead !== null && sent !== null) parts = split(`${notificationIdentity(notification)}${chatText([...choiceHead, "", sent.summary, "", ...choiceTail.flatMap((line, index) => index === 0 ? [line] : ["", line])].join("\n"), task)}`);
    // After research (flow-items.ts): each item numbered under the summary, its words cleaned as the rest of the message's
    // are, within Telegram's limit with every link kept — one message, unless head, links and tail alone overflow it.
    let entities: TelegramEntity[][] = [];
    if (sent?.items !== undefined && sent.items.length > 0 && offer === null) {
      const subject = chatText(leadSubjectOf(store, notification, binding.approver), task);
      const head = choiceHead !== null ? `${notificationIdentity(notification)}${choiceHead.join("\n")}`
        : `${notificationIdentity(notification, title !== undefined && mentions(subject, title) ? undefined : title)}${subject}`;
      const message = cleanFlowMessage({ head, summary: sent.summary, items: sent.items, tail: choiceHead !== null ? choiceTail : flowSendTail(sent) }, words => chatText(words, task));
      const voiced = fitFlowMessage(message, TELEGRAM_TEXT_MAX, shaped => telegramReply(shaped).text.length).map(telegramReply);
      parts = voiced.map(one => one.text);
      entities = voiced.map(one => one.entities);
    }
    // A teammate's question (v93): its options and "Answer in words", for the person it asks.
    const asked = flowKeys === null && choiceKeys === null ? openQuestionOf(store, notification.dedupeKey) : null;
    const questionKeys = asked === null ? null : telegramQuestionButtons(store, binding, asked, clock());
    const keys = flowKeys ?? choiceKeys ?? questionKeys;
    let last: string | null = null;
    for (const [index, part] of parts.entries()) {
      const final = index === parts.length - 1;
      const decideKeys = decided === null ? [] : decideKeyboard(phoneOrigin, decided.rows);
      const keyboard = !final ? undefined : keys !== null ? [...keys.keyboard, ...(button === null ? [] : [button])] : decideKeys.length > 0 ? decideKeys : button !== null ? [button] : undefined;
      const sent = await sender(part, keyboard, undefined, entities[index]?.length ? entities[index] : undefined);
      if (!sent.ok) {
        if (decided !== null) dropDecideTokens(store, decided.tokens, clock());
        return { ok: false, error: sent.error };
      }
      last = sent.messageId;
    }
    if (flowKeys !== null && last !== null) store.placeTelegramFlowActions(flowKeys.tokens, last);
    if (choiceKeys !== null && last !== null) {
      store.placeTelegramFlowChoices(choiceKeys.tokens, last);
      // A reply to this message, instead of a tap, is the person's note (applyFlowReply).
      if (sent?.reply === true) store.recordTelegramFlowPrompt({ chatId: binding.chatId, messageId: last, binding: binding.id, card: choosing!.card.id, entry: choosing!.card.entry, mode: "send-back" }, clock(), 7 * 24);
    }
    if (questionKeys !== null && last !== null) store.placeTelegramQuestionActions(questionKeys.tokens, last);
    if (decided !== null && last !== null) placeDecideTokens(store, decided.tokens, last);
    return { ok: true, receipt: receiptFor(botId, binding.chatId, last) };
  }

  // A decision. Every safety-bearing word goes out before anything tappable
  // exists: the question and every option's consequence first, then the
  // recap, split across as many plain messages as they need — a button whose
  // warning was truncated away is a trap, so the keyboard rides the LAST part
  // only, and only if every earlier part arrived.
  const parts = split([`${notificationIdentity(notification)}${decisionAsk(decision)}`, "", `Background: ${decision.recap}`].join("\n"));

  for (const part of parts.slice(0, -1)) {
    const sent = await sender(part);
    if (!sent.ok) return { ok: false, error: sent.error };
    // Every part is a message somebody may REPLY to with a note: each id
    // routes to this decision, exactly (Codex free-text review, finding 1).
    if (sent.messageId !== null) {
      store.recordTelegramDecisionMessage(binding.id, binding.chatId, sent.messageId, decision.id, clock());
    }
  }

  // The buttons: one opaque token per option, minted before the send so a
  // tap can never arrive for a token that does not exist, placed onto the
  // message afterwards so a tap on any OTHER message proves itself stale.
  const tokens = decision.options.map(option => ({
    option,
    token: randomBytes(16).toString("hex"),
  }));
  for (const { option, token } of tokens) {
    store.createTelegramAction(
      {
        token,
        binding: binding.id,
        decision: decision.id,
        optionId: option.id,
        phase: "choose",
        chatId: binding.chatId,
      },
      clock(),
    );
  }
  const keyboard = tokens.map(({ option, token }) => [
    telegramButton(`${option.label}${option.id === decision.recommendation ? " ✓" : ""}${option.reversible ? "" : " ⚠"}`, token),
  ]);
  const last = parts[parts.length - 1] as string;
  const sent = await sender(last, keyboard);
  if (!sent.ok) return { ok: false, error: sent.error };
  if (sent.messageId !== null) {
    store.placeTelegramActions(
      tokens.map(({ token }) => token),
      sent.messageId,
    );
    store.recordTelegramDecisionMessage(binding.id, binding.chatId, sent.messageId, decision.id, clock());
  }
  return { ok: true, receipt: receiptFor(botId, binding.chatId, sent.messageId) };
}

async function send(
  transport: TelegramTransport,
  chatId: string,
  text: string,
  keyboard?: InlineButton[][],
  entities?: TelegramEntity[],
  silent?: boolean,
): Promise<SendResult> {
  // No markup parsing. Only machine-selected heading ranges may be bold;
  // agent text remains literal and URLs never trigger link previews.
  let answer: Awaited<ReturnType<TelegramTransport>>;
  try {
    answer = await transport("sendMessage", {
      chat_id: chatId,
      text,
      ...(entities === undefined ? {} : { entities }),
      link_preview_options: { is_disabled: true },
      // A new quiet card arrives without a sound; only a ping should buzz.
      ...(silent === true ? { disable_notification: true } : {}),
      ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
    });
  } catch { return { ok: false, error: "Telegram transport failed; delivery may be uncertain" }; }
  if (!answer.ok) {
    const retry = answer.parameters?.retry_after;
    return { ok: false, error: answer.description ?? "sendMessage failed", ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? { retryAfter: Math.ceil(retry) } : {}) };
  }
  const messageId = (answer.result as { message_id?: number } | undefined)?.message_id;
  return { ok: true, messageId: Number.isSafeInteger(messageId) && messageId! > 0 ? String(messageId) : null };
}

async function editProgress(transport: TelegramTransport, chatId: string, messageId: string, text: string, keyboard: InlineButton[][], entities?: ProgressEntity[]): Promise<SendResult & { replace?: boolean }> {
  let answer: Awaited<ReturnType<TelegramTransport>>;
  try {
    answer = await transport("editMessageText", { chat_id: chatId, message_id: Number(messageId), text, ...(entities === undefined ? {} : { entities }),
      link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } });
  } catch { return { ok: false, error: "Telegram progress update is unconfirmed; it will retry in place" }; }
  // The retry may be repainting the same bytes after an acknowledgement was
  // lost. Telegram's explicit unchanged response confirms this target state.
  if (!answer.ok && !answer.uncertain && /^Bad Request: message is not modified\b/i.test(answer.description ?? "")) return { ok: true, messageId };
  if (!answer.ok) {
    const retry = answer.parameters?.retry_after;
    return { ok: false, error: answer.description ?? "Telegram progress update failed",
      ...(typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? { retryAfter: Math.ceil(retry) } : {}),
      replace: !answer.uncertain && /^Bad Request: message (?:to edit not found|can't be edited)$/i.test(answer.description ?? "") };
  }
  const confirmed = (answer.result as { message_id?: number } | undefined)?.message_id;
  return String(confirmed) === messageId ? { ok: true, messageId } : { ok: false, error: "Telegram did not confirm the progress message identity" };
}

/** A tapped message's own formatting, read back for its edit: only bold and links that still fall inside the text. */
function keptEntities(raw: unknown[] | undefined, length: number): TelegramEntity[] {
  return (raw ?? []).flatMap((one): TelegramEntity[] => {
    if (typeof one !== "object" || one === null) return [];
    const { type, offset, length: size, url } = one as Record<string, unknown>;
    if (typeof offset !== "number" || typeof size !== "number" || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size <= 0 || offset + size > length) return [];
    if (type === "bold") return [{ type, offset, length: size }];
    return type === "text_link" && typeof url === "string" && /^https?:\/\/\S+$/.test(url) ? [{ type, offset, length: size, url }] : [];
  });
}

function receiptFor(botId: string, chatId: string, messageId: string | null): string {
  return `telegram:${botId}:${chatId}:${messageId ?? "?"}`;
}

function split(text: string): string[] {
  if (text.length <= PART_CAP) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + PART_CAP, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}

function taskOf(store: Store, decision: Decision): string {
  const run = store.getRun(decision.run);
  return run === null ? "?" : store.externalIdFor(run.taskRef) ?? "?";
}

// ---- inbound ---------------------------------------------------------------

/** An update as Telegram sends it (contracts/telegram-callback.ts). */
type Update = TelegramUpdate;

type Context = {
  store: Store;
  botId: string;
  transport: TelegramTransport;
  clock: () => Date;
  report: BridgeReport;
  readProjects?: TelegramReadProjects | undefined;
  conversation?: TelegramConversationOptions | undefined;
  /** The enrolled ceiling read for THIS update, when a proposal tap needs it; null when it could not be read. */
  projects: readonly string[] | null;
};

async function drainUpdates(
  store: Store,
  botId: string,
  transport: TelegramTransport,
  owner: string,
  generation: number,
  cursor: number,
  clock: () => Date,
  report: BridgeReport,
  pollSeconds = 0,
  signal?: AbortSignal,
  readProjects?: TelegramReadProjects,
  conversation?: TelegramConversationOptions,
): Promise<void> {
  const context: Context = { store, botId, transport, clock, report, readProjects, conversation, projects: null };
  let offset = cursor + 1;

  for (let page = 0; page < PAGE_BUDGET; page++) {
    const answer = await transport(
      "getUpdates",
      {
        offset,
        // Only the first page long-polls; a backlog drains at full speed.
        timeout: page === 0 ? pollSeconds : 0,
        allowed_updates: ["message", "callback_query"],
      },
      signal,
    );
    if (!answer.ok) {
      const said = answer.description ?? "failed";
      // v98: another program asked Telegram for this bot's updates, and Telegram ended our
      // request in its favour. Nothing is lost: an update is only gone once someone
      // confirms it, and the next request asks again. Not a problem to report.
      if (/terminated by other getUpdates/i.test(said)) { report.contention = (report.contention ?? 0) + 1; return; }
      // Telegram is pushing this bot's updates to a webhook: polling isn't how they arrive now.
      if (/webhook is active/i.test(said)) { report.webhookActive = true; return; }
      report.problems.push(`getUpdates: ${said}`);
      return;
    }
    const updates: unknown[] = Array.isArray(answer.result) ? answer.result : [];
    if (updates.length === 0) return;

    for (const raw of updates) {
      const update = readTelegramUpdate(raw);
      if (!update.ok) {
        // Telegram's own update in a shape this bridge doesn't read: said, and passed over so the next one is read.
        const id = (raw as { update_id?: unknown } | null)?.update_id;
        report.problems.push(`an update Telegram sent couldn't be read: ${update.issues.map(issue => issue.line).join("; ")}`);
        if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
        offset = id + 1;
        continue;
      }
      await processUpdate(context, update.value, owner, generation);
      offset = update.value.update_id + 1;
    }
  }
  // The budget ran out with Telegram still holding pages: said, not hidden.
  report.backlog = true;
}

/**
 * One update, polled or pushed (v98): the projects it may read, applied in
 * its own transaction (once: applyUpdate refuses an update id it has seen),
 * its Telegram-side effects, and the cursor moved past it.
 */
async function processUpdate(context: Context, update: Update, owner: string, generation: number): Promise<void> {
  // A proposal tap confirms as a principal minted against the CURRENT
  // enrolled ceiling, and the registry is a file read: it happens
  // before the update's transaction, and only once the envelope has
  // proved the exact paired sender and chat — a stranger reads nothing.
  context.projects = update.message !== undefined ? await enrolledForMessage(context, update) : await projectsForTap(context, update);
  const effects = applyUpdate(context, update);
  // Effects are Telegram-side conveniences — acks, edits, replies. They
  // retry-or-drop; they never decide whether the cursor moves, because
  // an unreachable edit must not make the bridge re-apply an answer.
  for (const effect of effects) {
    try {
      await effect();
    } catch {
      context.report.problems.push(`a telegram edit/ack failed for update ${update.update_id}`);
    }
  }
  context.store.advanceBridgeCursor(context.botId, owner, generation, update.update_id, context.clock());
}

/** v98: updates Telegram pushed to /hooks/telegram, applied in order through the same door as polled ones. */
async function drainInbox(context: Context, owner: string, generation: number): Promise<number> {
  let applied = 0;
  for (const queued of context.store.telegramInbox(context.botId, PAGE_BUDGET * 100)) {
    const update = parseTelegramUpdate(queued.payload);
    if (update.ok && update.value.update_id === queued.updateId) await processUpdate(context, update.value, owner, generation);
    else if (!update.ok) context.report.problems.push(`a pushed update couldn't be read: ${update.issues.map(issue => issue.line).join("; ")}`);
    context.store.dropTelegramInbox(queued.updateId);
    applied++;
  }
  return applied;
}

/** The enrolled registry, read before a message is applied: the team layer
 * scopes leads and conversations to it (each person's own access is checked
 * inside the domain). Unreadable reads as null, and the personal paths stay
 * exactly as they were. */
async function enrolledForMessage(context: Context, update: Update): Promise<readonly string[] | null> {
  const message = update.message;
  if (message?.chat === undefined || message.from === undefined || message.text === undefined || context.readProjects === undefined) return null;
  // An untrusted envelope reads nothing: the sender must be paired, the
  // text plain and direct, and the chat either that person's own private
  // chat or a group that follows (or is being pointed at) a conversation.
  if (message.forward_origin !== undefined || message.forward_date !== undefined || message.via_bot !== undefined || message.sender_chat !== undefined || message.caption !== undefined) return null;
  const binding = context.store.liveTelegramBindingFor(context.botId, String(message.from.id));
  if (binding === null) return null;
  const chatId = String(message.chat.id);
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  const trusted = isGroup
    ? context.store.telegramTeamChat(context.botId, chatId)?.kind === "group" || teamCommand(message.text) !== null || FLOW_WORDS.test(message.text.trim())
    : message.chat.type === "private" && chatId === binding.chatId;
  if (!trusted) return null;
  try { return await context.readProjects(); } catch { return null; }
}

async function projectsForTap(context: Context, update: Update): Promise<readonly string[] | null> {
  const callback = update.callback_query;
  // Flow decision buttons (v86) work with or without the lead's conversation on this phone.
  const flowTap = callback !== undefined && (context.store.getTelegramFlowAction(callback.data ?? "") !== null || context.store.getTelegramFlowChoice(callback.data ?? "") !== null
    || flowConfirmOf(context.store, callback.data ?? "") !== null);
  // So do a result's, plan's or pull request's own buttons (chat-decide.ts).
  const decideTap = callback !== undefined && isDecideToken(context.store, callback.data ?? "");
  if (callback === undefined || context.readProjects === undefined || (context.conversation === undefined && !flowTap && !decideTap)) return null;
  const binding = callback.from === undefined ? null : context.store.liveTelegramBindingFor(context.botId, String(callback.from.id));
  if (
    binding === null || callback.from === undefined ||
    callback.message?.chat === undefined ||
    // Proposal cards and task picks read the chat's project ceiling.
    (context.store.getTelegramProposalAction(callback.data ?? "") === null && !flowTap && !decideTap && !(callback.data ?? "").startsWith("pick:"))
  ) return null;
  const chat = callback.message.chat;
  const chatId = String(chat.id);
  const trusted = chatId === binding.chatId || context.store.telegramTeamChat(context.botId, chatId)?.kind === "group";
  if (!trusted) return null;
  try {
    return telegramConversationRepos(context.store, binding.approver, await context.readProjects());
  } catch {
    return null;
  }
}

/**
 * Apply one update in one transaction; return the Telegram-side effects to
 * attempt afterwards. Everything suspicious lands in the same place:
 * `ignored`, silently — an unbound stranger learns nothing, including
 * whether there was anything to learn.
 */
function applyUpdate(context: Context, update: Update): Effect[] {
  const effects: Effect[] = [];
  context.store.transact(() => {
    if (!context.store.markTelegramUpdateApplied(update.update_id, "seen", context.clock())) {
      // Already applied by an earlier pass. The local mutation happened;
      // the edits were attempted then; nothing repeats.
      return;
    }
    if (update.message !== undefined) {
      applyMessage(context, update, effects);
      return;
    }
    if (update.callback_query !== undefined) {
      applyCallback(context, update, effects);
      return;
    }
    context.report.ignored++;
  });
  return effects;
}

/** A group message that connects the group to a flow, or that the group's flow takes as a card. False: not for an inbox. */
function applyGroupInbox(context: Context, message: NonNullable<Update["message"]>, effects: Effect[]): boolean {
  const { store, botId, transport, clock } = context;
  const chatId = String(message.chat!.id), text = message.text ?? "";
  const reply = (said: string, link?: { label: string; path: string }) => effects.push(async () => {
    let button: InlineButton[] | null = null;
    if (link !== undefined) { try { button = phoneLinkButton(context.conversation?.phoneOrigin?.() ?? null, link); } catch { button = null; } }
    await transport("sendMessage", { chat_id: chatId, text: said, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: message.message_id },
      ...(button === null ? {} : { reply_markup: { inline_keyboard: [button] } }) });
  });
  if (FLOW_WORDS.test(text.trim())) {
    const binding = store.liveTelegramBindingFor(botId, String(message.from!.id));
    if (binding === null) { context.report.ignored++; return true; }
    const repos = context.projects === null ? [] : telegramConversationRepos(store, binding.approver, context.projects);
    reply(connectChannel(store, { app: "telegram", installation: botId, conversation: chatId, binding, text, repos, followsConversation: store.telegramTeamChat(botId, chatId) !== null }, clock()));
    return true;
  }
  const trigger = watchedChannel(store, "telegram", botId, chatId);
  if (trigger === null) return false;
  // Forwards, other bots and channel posts don't become cards: only people writing in the group.
  if (message.forward_origin !== undefined || message.forward_date !== undefined || message.via_bot !== undefined || message.sender_chat !== undefined) { context.report.ignored++; return true; }
  const ts = String(message.message_id), thread = message.reply_to_message === undefined ? ts : String(message.reply_to_message.message_id);
  const sender = message.from as { id: number; username?: string; first_name?: string };
  const who = typeof sender.username === "string" ? `@${sender.username}` : typeof sender.first_name === "string" ? sender.first_name : "someone";
  const taken = takeChannelMessage(store, trigger, { app: "telegram", conversation: chatId, ts, thread, text, who }, clock());
  if (taken.said !== null) reply(taken.said, taken.link);
  return true;
}

function applyMessage(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const message = update.message as NonNullable<Update["message"]>;
  const chat = message.chat;
  const from = message.from;
  const pair = /^\/pair\s+([0-9a-f]{32})\s*$/.exec(message.text ?? "");

  // A group as a flow's inbox (v89): "/flow 12" from a paired approver connects it; after that its messages are cards.
  if (pair === null && chat !== undefined && from !== undefined && (chat.type === "group" || chat.type === "supergroup") && typeof message.text === "string" && applyGroupInbox(context, message, effects)) return;

  if (pair === null && chat !== undefined && from !== undefined) {
    // The team layer first: `/team` anywhere, everything in a followed
    // group, and a private chat that chose a conversation. Its replies ride
    // the same post-commit effects as every other answer.
    const consumed = applyTeamInbound({
      store, botId, now: clock(), report, projects: context.projects, phoneOrigin: context.conversation?.phoneOrigin, updateId: update.update_id, message,
      say: (chatId, text, keyboard) => {
        effects.push(async () => {
          await transport("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: message.message_id },
            ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }) });
        });
      },
    });
    if (consumed) return;
    // Replies to decisions retain their existing note meaning, even if the
    // note starts with a slash. New read commands are direct messages only.
    if (message.reply_to_message === undefined && applyPhoneRead(context, update, effects)) return;
    // A reply to a decision message this bot sent is a note, exactly as
    // before. Everything else that is ordinary text talks to the shared
    // assistant when a conversation is configured; otherwise silence.
    const binding = store.liveTelegramBindingFor(botId, String(from.id));
    // A reply to an Edit or Send back prompt (v86): the new draft, or the note it goes back with.
    // A reply to a teammate's "Answer in words" prompt (v93): the answer.
    const questionPrompt = binding !== null && message.reply_to_message !== undefined && String(chat.id) === binding.chatId
      ? store.telegramQuestionPrompt(binding.chatId, String(message.reply_to_message.message_id), clock()) : null;
    if (binding !== null && questionPrompt !== null) {
      const said = applyTelegramQuestionReply(store, binding, questionPrompt, message.text ?? "", clock());
      if (said !== null) effects.push(async () => { await transport("sendMessage", { chat_id: binding.chatId, text: said, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: message.message_id } }); });
      return;
    }
    const flowPrompt = binding !== null && message.reply_to_message !== undefined && String(chat.id) === binding.chatId
      ? store.telegramFlowPrompt(binding.chatId, String(message.reply_to_message.message_id), clock()) : null;
    if (binding !== null && flowPrompt !== null) {
      const repos = context.projects === null ? null : telegramConversationRepos(store, binding.approver, context.projects);
      for (const effect of applyFlowReply(store, binding, flowPrompt, message.text ?? "", repos, clock())) {
        if (effect.kind === "say") effects.push(async () => { await transport("sendMessage", { chat_id: binding.chatId, text: effect.text, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: message.message_id } }); });
        else effects.push(async () => {
          const sent = await send(transport, binding.chatId, effect.text, effect.keyboard);
          if (sent.ok && sent.messageId !== null) store.placeTelegramFlowActions(effect.tokens, sent.messageId);
        });
      }
      return;
    }
    // After Request changes asked "What should change?": the person's next message in their own chat is the feedback.
    // A reply to some other message (a decision, a result) keeps its own meaning.
    const decidePrompt = binding !== null && chat.type === "private" && String(chat.id) === binding.chatId && typeof message.text === "string" && message.text.trim() !== "" && !message.text.startsWith("/")
      ? openPromptFor(store, { channel: "telegram", binding: binding.id, chat: binding.chatId }, clock()) : null;
    if (binding !== null && decidePrompt !== null && answersPrompt(decidePrompt, message.reply_to_message === undefined ? null : String(message.reply_to_message.message_id))) {
      const repos = context.projects === null ? [] : telegramConversationRepos(store, binding.approver, context.projects);
      const answer = applyDecideFeedback(store, decideSeat(binding), decidePrompt, message.text ?? "", repos, context.conversation?.evidenceRoot, clock());
      effects.push(async () => {
        let button: InlineButton[] | null = null;
        try { button = phoneLinkButton(context.conversation?.phoneOrigin?.() ?? null, answer.link); } catch { button = null; }
        await transport("sendMessage", { chat_id: binding.chatId, text: answer.said, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: message.message_id },
          ...(button === null ? {} : { reply_markup: { inline_keyboard: [button] } }) });
      });
      return;
    }
    // A message to a teammate by name (v96), in the person's own chat: a card on its desk, and the answer comes back here.
    if (binding !== null && message.reply_to_message === undefined && message.chat?.type === "private" && String(chat.id) === binding.chatId && store.accountOf(binding.approver)?.role === "approver") {
      const repos = context.projects === null ? store.knownRepos().filter(repo => store.accountCanAccess(binding.approver, repo)) : telegramConversationRepos(store, binding.approver, context.projects);
      const handed = messageTeammate(store, { who: binding.approver, repos, via: "Telegram" }, message.text ?? "", clock());
      if (handed !== null) {
        effects.push(async () => {
          let button: InlineButton[] | null = null;
          if (handed.link !== undefined) { try { button = phoneLinkButton(context.conversation?.phoneOrigin?.() ?? null, handed.link); } catch { button = null; } }
          await transport("sendMessage", { chat_id: binding.chatId, text: handed.said, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: message.message_id },
            ...(button === null ? {} : { reply_markup: { inline_keyboard: [button] } }) });
        });
        return;
      }
    }
    const repliedDecision = binding !== null && message.reply_to_message !== undefined
      ? store.decisionForTelegramMessage(binding.id, binding.chatId, String(message.reply_to_message.message_id))
      : null;
    if (repliedDecision === null && context.conversation !== undefined && context.readProjects !== undefined) {
      applyConversation(context, update, effects);
      return;
    }
    applyNote(context, update, effects);
    return;
  }

  // Only /pair, only in a private chat, only with the sender on the record.
  // A group is exactly where "the chat" and "the person" diverge, which is
  // why a group cannot pair at all.
  if (pair === null || chat === undefined || chat.type !== "private" || from === undefined) {
    report.ignored++;
    return;
  }

  const consumed = store.consumeTelegramPairing(
    {
      codeHash: hashPairingCode(pair[1] as string),
      botId,
      chatId: String(chat.id),
      userId: String(from.id),
      updateId: update.update_id,
    },
    clock(),
  );
  if (!consumed.ok) {
    // A wrong code gets the same silence as everything else wrong: replying
    // "no such code" to a guesser is an oracle.
    report.ignored++;
    return;
  }
  report.paired++;
  const chatId = String(chat.id);
  const approver = consumed.binding.approver;
  effects.push(async () => {
    // At-least-once across a crash-after-send window, by design: a repeated
    // "paired" line is annoying; a paired chat that never heard so is worse.
    await transport("sendMessage", {
      chat_id: chatId,
      text: `paired: this chat now answers as ${approver}\n\nSend /status to check recent work, /task <id> for one task, or /help for your options.`,
      link_preview_options: { is_disabled: true },
    });
    // The bot is Toolroll in every chat list from here on (best effort; pairing never waits on it).
    await nameTelegramBot(transport, "pairing");
  });
}

/**
 * An ordinary message from the paired person: persisted for the shared
 * assistant in THIS transaction — before the cursor moves — with the exact
 * binding, sender, update, message and the request identity the engine
 * receipts its turn under. Two things are answered here and now without a
 * model: text over the engine's bound (never truncated), and a reply to a
 * message that carried several tasks (never guessed). Everything hostile is
 * silence, as for every other inbound shape.
 */
function applyConversation(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const message = update.message as NonNullable<Update["message"]>;
  const chat = message.chat;
  const from = message.from;
  const binding = from === undefined ? null : store.liveTelegramBindingFor(botId, String(from.id));
  if (
    binding === null || store.accountOf(binding.approver)?.role !== "approver" ||
    chat === undefined || chat.type !== "private" || String(chat.id) !== binding.chatId ||
    from === undefined ||
    message.text === undefined ||
    message.forward_origin !== undefined || message.forward_date !== undefined ||
    message.via_bot !== undefined || message.sender_chat !== undefined || message.caption !== undefined
  ) {
    report.ignored++;
    return;
  }
  const say = (text: string): void => {
    effects.push(async () => {
      await transport("sendMessage", {
        chat_id: binding.chatId,
        text,
        reply_parameters: { message_id: message.message_id },
        link_preview_options: { is_disabled: true },
      });
    });
  };
  const text = message.text.trim();
  if (text === "") {
    report.ignored++;
    return;
  }
  if (text.length > MATE_MESSAGE_MAX_CHARS) {
    say(tooLongText(text.length));
    report.chatRefused = (report.chatRefused ?? 0) + 1;
    return;
  }
  // A reply binds to what the replied-to message carried: exactly one task
  // (and its run) pins the turn; several ask which; none is a plain turn.
  let context_: string | null = null;
  let taskId: string | null = null;
  let sourceRun: number | null = null;
  const replyTo = message.reply_to_message === undefined ? null : String(message.reply_to_message.message_id);
  if (replyTo !== null) {
    const bindings = store.telegramMessageBindings(binding, replyTo).filter(one => one.taskId !== null);
    const tasks = [...new Set(bindings.map(one => one.taskId as string))];
    if (tasks.length > 1) {
      say(whichTaskText(tasks.map(id => store.getTask(id)?.title ?? id)));
      report.chatRefused = (report.chatRefused ?? 0) + 1;
      return;
    }
    if (tasks.length === 1) {
      taskId = tasks[0] as string;
      sourceRun = bindings.find(one => one.run !== null)?.run ?? null;
      context_ = replyContextFor(taskId, sourceRun);
    }
  }
  // No reply target: the task this chat chose to talk about, if any. The
  // turn re-proves it; a task no longer in reach reads as a plain message.
  if (taskId === null) {
    const focused = store.chatFocus("telegram", binding.id);
    if (focused !== null) {
      taskId = focused;
      context_ = focusContextFor(focused);
    }
  }
  store.enqueueTelegramConversation(
    {
      binding, updateId: update.update_id, messageId: String(message.message_id), replyTo,
      request: telegramRequestId(botId, binding.id, update.update_id), text, context: context_, taskId, sourceRun,
    },
    clock(),
  );
  report.chatQueued = (report.chatQueued ?? 0) + 1;
}

/** The picker's buttons: one task per row (its title and where it stands),
 * carried by the task's numeric reference so the data fits Telegram's 64
 * bytes; a tap re-proves the task against the ceiling. */
function pickKeyboard(store: Store, choices: readonly PhoneTaskChoice[], focused: boolean): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (const one of choices) {
    const ref = store.lookupRef(one.id);
    if (ref !== null) rows.push([telegramButton(`${one.title} · ${one.label}`.slice(0, 60), `pick:${ref.id}`)]);
  }
  if (focused) rows.push([telegramButton("Back to the lead", "pick:lead")]);
  return rows;
}

/** The title of the task this Telegram chat chose to talk about, if any. */
function focusedTitle(store: Store, binding: TelegramBinding): { id: string; title: string } | null {
  const id = store.chatFocus("telegram", binding.id);
  return id === null ? null : { id, title: phoneText(store.getTask(id)?.title ?? id, 64) };
}

function applyPhoneRead(context: Context, update: Update, effects: Effect[]): boolean {
  const { store, botId, transport, clock, report } = context;
  const message = update.message!;
  const command = phoneCommand(message.text ?? "");
  if (command === null) return false;
  const binding = message.from === undefined ? null : store.liveTelegramBindingFor(botId, String(message.from.id));
  if (
    binding === null || store.accountOf(binding.approver)?.role !== "approver" ||
    message.chat?.type !== "private" || String(message.chat.id) !== binding.chatId ||
    message.from === undefined ||
    message.forward_origin !== undefined || message.forward_date !== undefined ||
    message.via_bot !== undefined || message.sender_chat !== undefined || message.caption !== undefined
  ) {
    report.ignored++;
    return true;
  }
  // Like decision-message edits, a read reply is best-effort after the update
  // was consumed. A crash or send failure cannot turn replay into a new action.
  effects.push(async () => {
    const stillPaired = (): boolean => {
      const live = store.liveTelegramBindingById(binding.id);
      return live !== null && live.approverGeneration === binding.approverGeneration && store.accountOf(binding.approver)?.role === "approver";
    };
    if (!stillPaired()) return;
    let response = PHONE_HELP;
    // `/task` may carry ONE url button to the exact recorded task or result:
    // minted from the trusted origin read now, never persisted, never a token.
    let button: InlineButton[] | null = null;
    // `/tasks` and an ambiguous `/task <name>` offer tasks as buttons.
    let keyboard: InlineButton[][] | null = null;
    // The one task (and saved result) a `/task` reply shows: a reply to it is about that task.
    let shown: { task: string; run: number | null } | null = null;
    if (command.kind === "lead") {
      store.setChatFocus("telegram", binding.id, null, clock());
      response = PHONE_BACK_TO_LEAD;
    } else if (command.kind !== "help") {
      try {
        // The registry, then — after the await — the pairing again and the
        // account's OWN ceiling over it: a project this approver was never
        // given, or lost since, is not read, named or linked from here.
        const registry = await context.readProjects?.() ?? [];
        if (!stillPaired()) return;
        const repos = telegramConversationRepos(store, binding.approver, registry);
        const focused = focusedTitle(store, binding);
        if (command.kind === "status") response = phoneStatus(store, repos, clock(), focused?.title ?? null);
        else if (command.kind === "tasks") {
          const choices = phoneTaskChoices(store, repos, clock());
          response = choices.length === 0 ? phoneTaskListText([], null) : `${focused === null ? "" : `Talking about: ${focused.title}\n\n`}Pick a task to talk about:`;
          if (choices.length > 0) keyboard = pickKeyboard(store, choices, focused !== null);
        } else {
          const pick = resolvePhoneTask(store, repos, clock(), command.id);
          if (pick.kind === "many") {
            response = "Several tasks match. Pick one:";
            keyboard = pickKeyboard(store, pick.choices, false);
          } else if (pick.kind === "none") response = PHONE_NO_MATCH;
          else {
            store.setChatFocus("telegram", binding.id, pick.id, clock());
            const view = phoneTaskView(store, repos, pick.view, clock());
            shown = { task: pick.view, run: view.run };
            button = phoneLinkButton(context.conversation?.phoneOrigin?.() ?? null, view.link);
            // A destination with no trusted origin to carry it: the words say where instead.
            response = phoneFocusText(button === null && view.link !== null ? `${view.text}\n\n${PHONE_CONSOLE_FOOTER}` : view.text);
          }
        }
      } catch {
        // No registry paths, SQLite errors, credentials, or stale snapshots
        // leave on the failure road. A new request can try again.
        response = "I couldn't read the current project status. No tasks were changed. Try /status again; if it persists, check Toolroll on the computer.";
        report.problems.push("phone status could not read the current project records");
      }
    }
    if (!stillPaired()) return;
    // Each view fits one message. Fail visibly if a future change violates
    // that contract, rather than cutting off the important next action.
    if (response.length > PART_CAP) {
      response = "This status is too large for one phone message. Open the console for the full view, or send /task <id> for one task.";
      report.problems.push("phone status exceeded its message bound");
    }
    const sent = await transport("sendMessage", {
      chat_id: binding.chatId,
      text: response,
      reply_parameters: { message_id: message.message_id },
      link_preview_options: { is_disabled: true },
      ...(keyboard !== null ? { reply_markup: { inline_keyboard: keyboard } } : button === null ? {} : { reply_markup: { inline_keyboard: [button] } }),
    });
    if (sent.ok) report.statusReplies = (report.statusReplies ?? 0) + 1;
    else report.problems.push(`phone status reply failed for update ${update.update_id}; send a new command to retry`);
    const sentId = sent.ok ? (sent.result as { message_id?: unknown } | undefined)?.message_id : undefined;
    if (shown !== null && typeof sentId === "number" && Number.isSafeInteger(sentId) && sentId > 0) {
      // Best effort: without it a reply still reaches the chosen task through the focus.
      try { store.recordTelegramTaskMessage(binding, String(sentId), shown.task, shown.run, clock()); } catch { /* the focus still holds */ }
    }
  });
  return true;
}

/**
 * A free-text note, accepted only as an AUTHENTICATED REPLY to a recorded
 * decision message (Codex free-text review, prescribed design): live
 * binding, private chat, exact chat AND user, a reply_to that maps to
 * exactly one decision this bot sent, the decision still unanswered, and
 * direct initial plain text — no forwards, media, captions, bots, or
 * channel identities. Everything else is silence: a reply naming what was
 * wrong is an oracle. Choice stays TAP-ONLY; prose never selects an option.
 */
function applyNote(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const message = update.message as NonNullable<Update["message"]>;
  const chat = message.chat;
  const from = message.from;
  const binding = from === undefined ? null : store.liveTelegramBindingFor(botId, String(from.id));

  const say = (text: string): void => {
    effects.push(async () => {
      await transport("sendMessage", {
        chat_id: String(chat?.id ?? ""),
        text,
        reply_parameters: { message_id: message.message_id },
        link_preview_options: { is_disabled: true },
      });
    });
  };

  if (
    binding === null ||
    chat === undefined || chat.type !== "private" ||
    from === undefined ||
    String(chat.id) !== binding.chatId ||
    message.reply_to_message === undefined ||
    message.text === undefined ||
    message.forward_origin !== undefined ||
    message.forward_date !== undefined ||
    message.via_bot !== undefined ||
    message.sender_chat !== undefined ||
    message.caption !== undefined
  ) {
    report.ignored++;
    return;
  }

  const decisionId = store.decisionForTelegramMessage(
    binding.id,
    binding.chatId,
    String(message.reply_to_message.message_id),
  );
  if (decisionId === null) {
    // A reply to something that never carried a decision — including a
    // send whose record was lost: fail closed, never guess by recency.
    report.ignored++;
    return;
  }
  const decision = store.getDecision(decisionId);
  if (decision === null) {
    report.ignored++;
    return;
  }
  if (decision.state === "answered") {
    say(`already answered: ${decision.choice ?? "?"} — this note did not travel`);
    report.ignored++;
    return;
  }

  const valid = validateNote(message.text);
  if (!valid.ok) {
    say(`that note cannot travel: ${valid.problem}`);
    report.ignored++;
    return;
  }

  const saved = store.saveNoteDraft(
    {
      binding: binding.id,
      decision: decision.id,
      updateId: update.update_id,
      messageId: String(message.message_id),
      replyTo: String(message.reply_to_message.message_id),
      note: valid.note,
    },
    clock(),
  );
  if (!saved) {
    // An older or equal update raced in late: the newer note stands.
    report.ignored++;
    return;
  }
  // A new note voids any ARMED irreversible confirmation: what it showed
  // is no longer what would travel (Codex free-text review, finding 3).
  store.consumeTelegramChallenges(decision.id, clock());
  report.noted = (report.noted ?? 0) + 1;
  // The echo IS the ceremony: the exact captured text, line-prefixed, so a
  // later edit of the operator's own message cannot rewrite the audit.
  say(
    [
      `noted for ${taskOf(store, decision)}:`,
      ...valid.note.split("\n").map((line: string) => `| ${line}`),
      "",
      "Tap an option on the decision to answer WITH this note. It expires in 10 minutes; a new reply replaces it.",
    ].join("\n"),
  );
}

function applyCallback(context: Context, update: Update, effects: Effect[]): void {
  const { store, botId, transport, clock, report } = context;
  const callback = update.callback_query as NonNullable<Update["callback_query"]>;
  const from = callback.from;
  const message = callback.message;
  const token = callback.data ?? "";

  const ack = (text?: string): void => {
    effects.push(async () => {
      await transport("answerCallbackQuery", {
        callback_query_id: callback.id,
        ...(text === undefined ? {} : { text }),
      });
    });
  };
  const editText = (text: string, keyboard?: InlineButton[][], entities?: TelegramEntity[]): void => {
    if (message === undefined) return;
    const chatId = message.chat === undefined ? null : String(message.chat.id);
    const messageId = message.message_id;
    if (chatId === null) return;
    effects.push(async () => {
      await transport("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(entities === undefined || entities.length === 0 ? {} : { entities }),
        link_preview_options: { is_disabled: true },
        ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
      });
    });
  };

  // The person, the chat, and the message must all be the paired ones. A
  // callback with no accessible message (inline mode, too-old messages) is
  // out; so is a tap from anyone but the exact paired user id — usernames
  // change hands, immutable ids do not.
  const binding = from === undefined ? null : store.liveTelegramBindingFor(botId, String(from.id));
  const tapChat = message?.chat === undefined ? null : String(message.chat.id);
  const followedGroup = tapChat !== null && binding !== null && tapChat !== binding.chatId && store.telegramTeamChat(botId, tapChat)?.kind === "group";
  // A result's, plan's, failure's or pull request's own buttons act only in the paired person's own chat; a tap
  // anywhere else is still answered, so the button never just spins.
  if (isDecideToken(store, token) && (binding === null || tapChat === null || tapChat !== binding.chatId)) {
    report.ignored++;
    ack(binding === null ? "These buttons work only for the person they were sent to. Nothing was done."
      : "These buttons work only in your own chat with the bot. Nothing was done.");
    return;
  }
  if (
    binding === null ||
    from === undefined ||
    message === undefined ||
    message.chat === undefined ||
    (tapChat !== binding.chatId && !followedGroup)
  ) {
    report.ignored++;
    return;
  }
  // The paired person, in their chat: a button whose data isn't one Toolroll makes is answered with why, and does nothing.
  const data = readTelegramButtonData(callback.data);
  if (!data.ok) {
    report.ignored++;
    ack(`That button couldn't be read (${data.issues.map(issue => issue.line).join("; ")}). Nothing was done.`.slice(0, 190));
    return;
  }

  // A task picked from /tasks: this private chat now talks about it (or,
  // "Back to the lead", about everything again). The task is re-proved
  // against the chat's ceiling at the tap.
  const pick = pickOf(token);
  if (pick !== null) {
    if (tapChat !== binding.chatId) { report.ignored++; return; }
    if (pick.ref === null) {
      store.setChatFocus("telegram", binding.id, null, clock());
      store.recordTelegramTaskMessage(binding, String(message.message_id), null, null, clock());
      ack("Back to the lead");
      editText(PHONE_BACK_TO_LEAD);
      return;
    }
    const taskId = store.externalIdFor(pick.ref);
    const repos = context.projects === null ? null : telegramConversationRepos(store, binding.approver, context.projects);
    if (taskId === null || repos === null || !taskInCeiling(store, taskId, repos)) {
      ack("That task isn't available here now.");
      return;
    }
    const root = store.taskFamilyOf(taskId, repos, false)?.root ?? null;
    const id = root?.id ?? taskId;
    const title = phoneText(root?.title ?? store.getTask(taskId)?.title ?? taskId, 64);
    store.setChatFocus("telegram", binding.id, id, clock());
    ack(`Talking about: ${title}`.slice(0, 190));
    const current = store.taskFamilyOf(taskId, repos, false)?.current.id ?? id;
    const view = phoneTaskView(store, repos, current, clock());
    store.recordTelegramTaskMessage(binding, String(message.message_id), current, view.run, clock());
    editText(phoneFocusText(view.text), [[telegramButton("Back to the lead", "pick:lead")]]);
    return;
  }
  // A teammate's question (v93): an option answers it; "Answer in words" asks for a reply.
  const questionAction = store.getTelegramQuestionAction(token);
  if (questionAction !== null) {
    if (questionAction.binding !== binding.id || questionAction.chatId !== tapChat || (questionAction.messageId !== null && questionAction.messageId !== String(message.message_id))) { report.ignored++; return; }
    for (const effect of applyTelegramQuestionTap(store, binding, questionAction, { text: message.text ?? "" }, clock())) {
      if (effect.kind === "ack") ack(effect.text);
      else if (effect.kind === "edit") editText(effect.text);
      else effects.push(async () => {
        const answer = await transport("sendMessage", { chat_id: binding.chatId, text: effect.text, link_preview_options: { is_disabled: true },
          reply_parameters: { message_id: message.message_id }, reply_markup: { force_reply: true, input_field_placeholder: effect.placeholder } });
        const id = (answer.result as { message_id?: number } | undefined)?.message_id;
        if (answer.ok && Number.isSafeInteger(id)) store.recordTelegramQuestionPrompt({ chatId: binding.chatId, messageId: String(id), binding: binding.id, question: effect.question }, clock());
      });
    }
    return;
  }
  // A flow decision's repaint: its buttons (fresh ones stamped on this message) or links under the console.
  const flowEdit = (effect: { text: string; keyboard?: FlowKeyboard; place?: string[] }) => {
    if (effect.place !== undefined && effect.place.length > 0) store.placeTelegramFlowActions(effect.place, String(message.message_id));
    editText(effect.text, decideKeyboard(context.conversation?.phoneOrigin, effect.keyboard ?? []));
  };
  // The Yes or Cancel a flow Approve armed (telegram-flow.ts): on the message it was armed on, by the person it was armed for.
  const flowConfirm = flowConfirmOf(store, token);
  if (flowConfirm !== null) {
    if (flowConfirm.binding !== binding.id || flowConfirm.chatId !== tapChat || flowConfirm.messageId !== String(message.message_id)) { report.ignored++; ack("That button isn't for this chat. Nothing was done."); return; }
    const repos = context.projects === null ? null : telegramConversationRepos(store, binding.approver, context.projects);
    for (const effect of applyFlowConfirm(store, binding, flowConfirm, { text: message.text ?? "" }, repos, clock())) {
      if (effect.kind === "ack") ack(effect.text);
      else if (effect.kind === "edit") flowEdit(effect);
    }
    return;
  }
  const flowAction = store.getTelegramFlowAction(token);
  if (flowAction !== null) {
    if (flowAction.binding !== binding.id || flowAction.chatId !== tapChat || (flowAction.messageId !== null && flowAction.messageId !== String(message.message_id))) { report.ignored++; return; }
    const repos = context.projects === null ? null : telegramConversationRepos(store, binding.approver, context.projects);
    const tapped = applyFlowTap(store, binding, flowAction, { chatId: binding.chatId, messageId: String(message.message_id), text: message.text ?? "" }, repos, clock());
    for (const effect of tapped) {
      if (effect.kind === "ack") ack(effect.text);
      else if (effect.kind === "edit") flowEdit(effect);
      else effects.push(async () => {
        // A reply box: whatever they send back as a reply to this prompt is the new draft, or the note.
        const answer = await transport("sendMessage", { chat_id: binding.chatId, text: effect.text, link_preview_options: { is_disabled: true },
          reply_parameters: { message_id: message.message_id }, reply_markup: { force_reply: true, input_field_placeholder: effect.placeholder } });
        const id = (answer.result as { message_id?: number } | undefined)?.message_id;
        if (answer.ok && Number.isSafeInteger(id)) store.recordTelegramFlowPrompt({ ...effect.prompt, messageId: String(id) }, clock());
      });
    }
    return;
  }
  // A "Person chooses" option (flow-send.ts): the card goes where it leads, or is ignored.
  const choiceAction = store.getTelegramFlowChoice(token);
  if (choiceAction !== null) {
    if (choiceAction.binding !== binding.id || choiceAction.chatId !== tapChat || (choiceAction.messageId !== null && choiceAction.messageId !== String(message.message_id))) { report.ignored++; return; }
    const repos = context.projects === null ? null : telegramConversationRepos(store, binding.approver, context.projects);
    const listed = (flowSentContent(store, choiceAction.card, choiceAction.entry)?.items?.length ?? 0) > 0;
    for (const effect of applyFlowChoiceTap(store, binding, choiceAction, { text: message.text ?? "" }, repos, clock())) {
      if (effect.kind === "ack") ack(effect.text);
      // An item list's message (flow-items.ts) keeps its bold titles and labelled links under what was chosen; any other stays plain.
      else if (effect.kind === "edit") editText(effect.text, undefined, listed ? keptEntities(message.entities, effect.text.length) : undefined);
    }
    return;
  }
  // The lead's question to its owner: an option is sent as their next message; "Something else" asks them to type it.
  const askTap = askOf(token);
  if (askTap !== null) {
    if (tapChat !== binding.chatId || context.conversation === undefined) { report.ignored++; return; }
    const turn = askTap.turn;
    const found = store.getMateTurn(turn)?.approver === binding.approver ? store.mateAskState(turn, clock()) : { state: "expired" as const };
    if (found.state !== "open") {
      const line = found.state === "answered" ? "That question was already answered." : "That question expired. Send your answer as a message.";
      ack(line);
      editText(`${message.text ?? ""}\n\n${line}`.trim().slice(0, 4000));
      return;
    }
    const ask = found.ask;
    if (store.telegramConversationWaitingOn(binding.id, String(message.message_id))) { ack("Your answer is on its way."); return; }
    if (askTap.option === "x") { ack("Type your answer as a message."); return; }
    const option = ask.options[askTap.option];
    if (option === undefined) { ack("That option is no longer there."); return; }
    const focused = store.chatFocus("telegram", binding.id);
    store.enqueueTelegramConversation({
      binding, updateId: update.update_id, messageId: String(message.message_id), replyTo: null,
      request: telegramRequestId(botId, binding.id, update.update_id), text: option,
      context: focused === null ? null : focusContextFor(focused), taskId: focused, sourceRun: null,
    }, clock());
    report.chatQueued = (report.chatQueued ?? 0) + 1;
    ack(`Sent: ${option}`.slice(0, 190));
    editText(`${message.text ?? ask.question}\n\nYou chose: ${option}`.slice(0, 4000));
    return;
  }
  // A result's, plan's, failure's or pull request's own buttons (chat-decide.ts): in the person's own chat only.
  if (isDecideToken(store, token)) {
    const repos = context.projects === null ? null : telegramConversationRepos(store, binding.approver, context.projects);
    if (repos === null) { ack("Your projects couldn't be read just now. Try again."); return; }
    const messageId = String(message.message_id);
    const tapped = applyDecideTap(store, decideSeat(binding), { token, message: messageId, shown: message.text ?? "", repos, ...(context.conversation === undefined ? {} : { root: context.conversation.evidenceRoot }), now: clock() });
    if (tapped === null) { report.ignored++; ack("That button doesn't do anything now."); return; }
    if (tapped.ignored === true) report.ignored++;
    ack(tapped.ack.slice(0, 190));
    if (tapped.edit !== undefined) editText(tapped.edit.text.slice(0, 4000), decideKeyboard(context.conversation?.phoneOrigin, tapped.edit.rows));
    if (tapped.prompt !== undefined) {
      const prompt = tapped.prompt;
      effects.push(async () => {
        const answer = await transport("sendMessage", { chat_id: binding.chatId, text: prompt.text, link_preview_options: { is_disabled: true },
          reply_parameters: { message_id: message.message_id }, reply_markup: { force_reply: true, input_field_placeholder: "What should change?" } });
        const id = (answer.result as { message_id?: number } | undefined)?.message_id;
        if (answer.ok && Number.isSafeInteger(id)) placeDecidePrompt(store, prompt.id, String(id));
      });
    }
    if (tapped.merge !== undefined) {
      const merge = tapped.merge, shown = tapped.edit?.text ?? message.text ?? "";
      // GitHub is a network call: after the tap's transaction, then the card says how it went.
      effects.push(async () => {
        let merged: { ok: true } | { ok: false; message: string };
        try {
          merged = context.conversation?.merge !== undefined ? await context.conversation.merge({ runId: merge.runId, by: merge.by })
            : await mergePullRequest(store, { runId: merge.runId, by: merge.by, clock });
        } catch { merged = { ok: false, message: "GitHub couldn't be reached just now. Try again from the task." }; }
        // The ledger says what happened, failure included, once GitHub has answered.
        recordChatMerge(store, merge, merged.ok ? { ok: true } : { ok: false, message: merged.message }, clock());
        // A merge that didn't land keeps a way to the task.
        await transport("editMessageText", { chat_id: binding.chatId, message_id: message.message_id, text: mergedText(shown, merged.ok ? { ok: true } : { ok: false, message: merged.message }).slice(0, 4000),
          link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: merged.ok ? [] : decideKeyboard(context.conversation?.phoneOrigin, linksFor({ kind: "merge", taskId: merge.taskId, run: merge.runId })) } });
      });
    }
    return;
  }
  const action = store.getTelegramAction(token);
  if (action === null && context.conversation !== undefined && store.getTelegramProposalAction(token) !== null) {
    // A proposal card's button: the shared confirm door, inside this
    // update's transaction, with the stop's process signal deferred to
    // after its commit (the door's own ordering, preserved from here).
    const tapped = applyProposalTap(store, binding, token, message, context.projects, context.conversation, clock());
    for (const effect of tapped.effects) {
      if (effect.kind === "ack") ack(effect.text);
      else if (effect.kind === "edit") editText(effect.text, effect.keyboard);
      else effects.push(async () => { effect.run(); });
    }
    if (tapped.confirmed) report.chatConfirmed = (report.chatConfirmed ?? 0) + 1;
    if (tapped.ignored) report.ignored++;
    return;
  }
  if (
    action === null ||
    action.binding !== binding.id ||
    action.chatId !== binding.chatId ||
    (action.messageId !== null && action.messageId !== String(message.message_id))
  ) {
    // Bound person, dead or foreign button: acknowledged, not acted on.
    ack("that button is stale — toolroll decide shows what still waits");
    report.ignored++;
    return;
  }

  const decision = store.getDecision(action.decision);
  if (decision === null) {
    ack("that decision no longer exists");
    return;
  }
  if (decision.state === "answered") {
    store.consumeTelegramAction(token, clock());
    ack(`already answered: ${decision.choice ?? "?"}`);
    editText(answeredText(store, decision));
    return;
  }

  if (action.phase === "choose") {
    const option = decision.options.find(one => one.id === action.optionId);
    if (option === undefined) {
      ack("that option no longer exists");
      return;
    }
    if (expiredDraftGuard(store, binding, decision.id, clock())) {
      // The token is NOT consumed: the same button answers on the next tap,
      // now that the operator knows the note is gone.
      ack("your note expired — tap again to answer without it, or reply with a fresh note first");
      return;
    }
    if (!store.consumeTelegramAction(token, clock())) {
      ack("that button was already used");
      return;
    }

    if (!option.reversible) {
      // The arm. Nothing is answered here: two fresh one-time tokens make a
      // real challenge — a stolen bot token can repaint a keyboard, but it
      // cannot mint a row in this table, so a tap on a forged "confirm"
      // lands in the stale-button branch above.
      const confirm = randomBytes(16).toString("hex");
      const cancel = randomBytes(16).toString("hex");
      const placedOn = String(message.message_id);
      // The confirmation binds the EXACT answer tuple: option AND the note
      // it displays (its digest; null when none). A note that changes,
      // expires, or is cancelled strands this challenge (finding 3).
      const draft = store.liveNoteDraft(binding.id, decision.id, clock());
      const digest = draft === null ? undefined : noteDigestOf(draft.note);
      if (draft !== null) store.setNoteDraftState(draft.id, "armed");
      store.createTelegramAction(
        { token: confirm, binding: binding.id, decision: decision.id, optionId: option.id, phase: "confirm", chatId: binding.chatId, messageId: placedOn, ttlMs: CONFIRM_TTL_MS, ...(digest === undefined ? {} : { noteDigest: digest }) },
        clock(),
      );
      store.createTelegramAction(
        { token: cancel, binding: binding.id, decision: decision.id, optionId: option.id, phase: "cancel", chatId: binding.chatId, messageId: placedOn, ttlMs: CONFIRM_TTL_MS },
        clock(),
      );
      ack("irreversible — confirm it");
      editText(
        armedDecisionText(option, draft?.note ?? null),
        [
          [telegramButton(`⚠ Yes, ${option.label}`, confirm)],
          [telegramButton("Cancel", cancel)],
        ],
      );
      return;
    }

    answerNow(context, decision, option.id, binding, ack, editText);
    return;
  }

  if (action.phase === "confirm") {
    if (!store.consumeTelegramAction(token, clock())) {
      ack("that confirmation expired — start again from the option");
      return;
    }
    // Re-proved at the moment of commitment, not remembered from the arm.
    const option = decision.options.find(one => one.id === action.optionId);
    if (option === undefined) {
      ack("that option no longer exists");
      return;
    }
    // The tuple the challenge displayed must still be the tuple that
    // travels: the CURRENT live draft's digest (or none) must equal what
    // was armed. Anything else strands the yes (finding 3).
    const current = store.liveNoteDraft(binding.id, decision.id, clock());
    const currentDigest = current === null ? null : noteDigestOf(current.note);
    if ((action.noteDigest ?? null) !== currentDigest) {
      store.consumeTelegramChallenges(decision.id, clock());
      ack("the note changed since this confirmation — read it again and re-arm");
      return;
    }
    answerNow(context, decision, option.id, binding, ack, editText);
    return;
  }

  // cancel: consume it, kill its sibling confirm, discard the note draft
  // (cancel means cancelled — the note it displayed dies with it), and
  // restore the choices.
  store.consumeTelegramAction(token, clock());
  store.consumeTelegramChallenges(decision.id, clock());
  {
    const draft = store.liveNoteDraft(binding.id, decision.id, clock());
    if (draft !== null) store.setNoteDraftState(draft.id, "discarded");
  }
  const fresh = decision.options.map(option => ({ option, token: randomBytes(16).toString("hex") }));
  for (const { option, token: choose } of fresh) {
    store.createTelegramAction(
      { token: choose, binding: binding.id, decision: decision.id, optionId: option.id, phase: "choose", chatId: binding.chatId, messageId: String(message.message_id) },
      clock(),
    );
  }
  ack("cancelled");
  // The card again, within one message; a decision too long for one keeps the consequences its earlier parts show.
  const ask = decisionAsk(decision);
  editText(
    ask.length <= PART_CAP ? ask : `Decide: ${decision.question}`,
    fresh.map(({ option, token: choose }) => [
      telegramButton(`${option.label}${option.id === decision.recommendation ? " ✓" : ""}${option.reversible ? "" : " ⚠"}`, choose),
    ]),
  );
}

function answerNow(
  context: Context,
  decision: Decision,
  choice: string,
  binding: TelegramBinding,
  ack: (text?: string) => void,
  editText: (text: string, keyboard?: InlineButton[][]) => void,
): void {
  const { store, clock, report } = context;
  // The live draft is the note that travels — consumed WITH the answer in
  // the same transaction the whole update already holds; a CAS loss
  // discards it (Codex free-text review, finding 4: never choose-then-note).
  const draft = store.liveNoteDraft(binding.id, decision.id, clock());
  const answered = store.answerDecisionLocked(
    { id: decision.id, choice, by: binding.approver, via: "telegram", ...(draft === null ? {} : { note: draft.note }) },
    clock(),
  );
  if (answered.ok) {
    if (draft !== null) store.setNoteDraftState(draft.id, "consumed");
    report.answered++;
    ack(`✓ ${choice}${draft === null ? "" : " — with your note"}`);
    editText(answeredText(store, answered.decision));
    return;
  }
  if (answered.reason === "already-answered") {
    if (draft !== null) store.setNoteDraftState(draft.id, "discarded");
    const settled = store.getDecision(decision.id);
    ack(`already answered: ${settled?.choice ?? "?"}${draft === null ? "" : " — your note did NOT travel"}`);
    if (settled !== null) editText(answeredText(store, settled));
    return;
  }
  ack(`could not answer: ${answered.reason}`);
}

/** A decision's card, action first: the question, then each option with what it does, then its deadline. */
function decisionAsk(decision: Decision): string {
  return [
    `Decide: ${decision.question}`,
    ...decision.options.map(option =>
      `• ${option.label}${option.id === decision.recommendation ? " (recommended)" : ""}${option.reversible ? "" : " ⚠ can't be undone"}: ${option.consequence}`),
    ...(decision.deadline === null ? [] : [`Decide by ${decision.deadline.slice(0, 16).replace("T", " ")} UTC`]),
  ].join("\n");
}

/** The armed confirm of an option that can't be undone: what it is and what it does, then the note that travels. */
function armedDecisionText(option: Decision["options"][number], note: string | null): string {
  return [
    `${option.label}? ⚠ This can't be undone.`,
    option.consequence,
    ...(note === null ? [] : ["", "With your note:", ...note.split("\n").map(line => `| ${line}`)]),
  ].join("\n");
}

function answeredText(store: Store, decision: Decision): string {
  const chosen = decision.options.find(one => one.id === decision.choice)?.label ?? decision.choice ?? "?";
  return [
    `✓ Answered: ${chosen}`,
    `${taskOf(store, decision)} · by ${decision.answeredBy ?? "?"} via ${decision.answeredVia ?? "?"}`,
    // Line-prefixed, never inline: a multiline note must not be able to
    // draw fake status lines (Codex free-text review, finding 7).
    ...(decision.note === null ? [] : ["with note:", ...decision.note.split("\n").map(line => `| ${line}`)]),
  ].join("\n");
}

function noteDigestOf(note: string): string {
  return createHash("sha256").update(note, "utf8").digest("hex").slice(0, 32);
}

/**
 * A pending draft that ALREADY EXPIRED must never silently drop: the tap
 * proceeds only after the operator is told (Codex free-text review, state
 * machine — "never silently answer without the expected note").
 */
function expiredDraftGuard(store: Store, binding: TelegramBinding, decisionId: number, now: Date): boolean {
  const expired = store.telegramChat()
    .prepare(
      `SELECT id FROM chat_note_draft
        WHERE provider = :provider AND binding = ? AND decision = ? AND state IN ('pending','armed') AND expires <= ?`,
    )
    .get(binding.id, decisionId, now.toISOString());
  if (expired === undefined) return false;
  store.setNoteDraftState(Number(expired["id"]), "discarded");
  return true;
}
