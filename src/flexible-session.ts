/**
 * Flexible threads, slice F3 (solo-workbench plan "F3: the thread view in the terminal, as one more LiveSession in the
 * same panes"; the Flexible plan v2 §4 and §6): the console's own threads, wired end to end. This module is the one
 * bridge between the thread engine (F2a–F2e) and a person's surface (the engine API's thread road, server/engine-api.ts):
 * nothing else outside the engine calls into it.
 *
 * What it holds, per console process (a FlexibleSessions host):
 * - the coding catalog's answer side, opened once (flexible-answers.ts openFlexibleAnswerCatalog);
 * - each running thread's sign-in relay (flexible-relay.ts startFlexibleRelay), started with the thread's session and
 *   closed when it stops;
 * - the thread's live agent: its stdout read into live records (live-records.ts, the same recorder a build uses: redacted,
 *   cleaned, capped) and into requests (recordFlexibleRequest), its stdin the answer connection (`frame` + F2d's
 *   streamAnswerSender), closed after a send whose outcome is uncertain (a deadline passed, or bytes went part way);
 * - each request's single-use answer token, in memory only, never sent to any surface: an answer reaches the agent only
 *   through F2d's decide and send, with the person's own session as `by`.
 *
 * The wiring F2b–F2d left open, each here and nowhere else: answers revoked when a turn ends (endFlexibleThreadTurn),
 * when the agent stops or exits (stopFlexibleThreadSession, the exit watcher) and when the thread is lowered
 * (lowerFlexibleThreadSession); recovered at holder recovery (recoverFlexibleHolders: launches first, then answers);
 * expired on the console's existing upkeep tick (tickFlexibleSessions).
 *
 * The rules this module keeps:
 * - Nothing here works while FLEXIBLE_AVAILABLE is false: every entry point refuses with `not-available` first.
 * - A model never answers: nothing here decides anything. `answerFlexibleRequest` takes a person (`by.kind` "person",
 *   proved by the caller's own session) and the card digest they were shown; F2d re-checks both, the turn, the
 *   connection and the authority at the write.
 * - The read is the owner's: `flexibleThreadLiveOf` and `flexibleThreadsOf` refuse anyone but the thread's creator
 *   (the route adds the session's re-read and project access, before and after the read).
 * - Agent text is cleaned before it is kept: a card's strings pass the live sanitizer (controls, escapes, bidi out;
 *   a line shaped like a secret hidden) before they are recorded, so the card the person sees is the card digested.
 * - The holder is this console process, named by its pid and start identity: a holder is proved gone only when no
 *   process with that pid and start identity runs (recoverFlexibleHolders never touches a holder it can't prove gone).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { FLEXIBLE_LEVEL_WORDS, FLEXIBLE_UNAVAILABLE, isFlexibleLevel, type FlexibleLevel } from "./flexible.js";
import { lowerFlexibleThreadLevel, recoverFlexibleLaunchesOf, startFlexibleTurn, type FlexibleTurnStartInput } from "./flexible-agents.js";
import {
  decideFlexibleAnswer, expireFlexibleAnswers, flexibleRequestsOf, noteFlexibleToolActivity, openFlexibleAnswerCatalog, recordFlexibleRequest, recoverFlexibleAnswersOf, revokeFlexibleAnswers,
  sendFlexibleAnswer, streamAnswerSender, type FlexibleAnswerCatalog, type FlexibleAnswerConnection, type FlexibleAnswerPayload, type FlexibleAnswerRefusal, type FlexibleAnswerState,
  type FlexibleRequestCard, type FlexibleRequestKind,
} from "./flexible-answers.js";
import { startIdentityOf, type CustodyIO } from "./flexible-custody.js";
import { defaultCustodyIO } from "./flexible-launch.js";
import { startFlexibleRelay, type FlexibleRelayServer } from "./flexible-relay.js";
import { flexibleThread, prepareFlexibleThread, stopFlexibleThreadAgent } from "./flexible-thread.js";
import { admitFlexibleTurn, finishFlexibleTurn, flexibleTurn, withdrawFlexibleTurn, type FlexibleClock } from "./flexible-turns.js";
import { userFrame } from "./live-input.js";
import { cleanLiveText, createLiveRecorder, HIDDEN_LINE, liveSecretHit, type LiveRecord, type LiveRecorder } from "./live-records.js";
import type { FlexibleLauncher } from "./flexible-launcher.js";
import { primaryResultEvent } from "./stream-scope.js";
import type { Store } from "./store.js";

export type FlexibleSessionReason = "not-available" | "invalid-request" | "no-holder" | "thread-unknown" | "not-owner" | "not-answerable" | "scope-unshown" | "no-network";
export type FlexibleSessionRefusal = { ok: false; reason: FlexibleSessionReason; message: string };
const WORDS: Readonly<Record<FlexibleSessionReason, string>> = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "invalid-request": "That isn't a request Toolroll can read. Nothing changed.",
  "no-holder": "Toolroll can't tell which process this is, so it holds no threads.",
  "thread-unknown": "There's no such thread.",
  "not-owner": "Only the person who started this thread can answer its agent. Nothing was sent.",
  "scope-unshown": "This request couldn't be shown in full, so it can't be allowed from here. You can deny it. Nothing was sent.",
  "not-answerable": "This question can't be answered from here: Toolroll restarted since it was asked, or another Toolroll holds it. Nothing was sent.",
  "no-network": "This console can't give a thread its network yet, so no thread was started.",
});
const refuse = (reason: FlexibleSessionReason): FlexibleSessionRefusal => ({ ok: false, reason, message: WORDS[reason] });

const ID = /^[0-9a-f]{32}$/;
const REF = /^[\x21-\x7e]{1,200}$/;
const systemClock: FlexibleClock = () => new Date();
/** Records kept per thread in memory (the newest); older ones are dropped and the read says so (`earlier`). */
export const FLEXIBLE_RECORDS_KEPT = 5_000;
/** Records one window carries at most (the rest: `more`). */
const WINDOW_RECORDS = 500;
/** The longest stdout line read from an agent; a longer one is skipped whole. */
const LINE_CAP = 1_048_576;

// ---- the host ----------------------------------------------------------------------------------------------------------------

type Asked = { request: string; token: string; ref: string; kind: FlexibleRequestKind; tool: string; input: Record<string, unknown>; inputDigest: string; complete: boolean; questions: string[] };
type AgentLink = { launch: string; turn: string | null; stdin: Writable; connection: FlexibleAnswerConnection; recorder: LiveRecorder };
type ThreadSession = { thread: string; relay: FlexibleRelayServer | null; agent: AgentLink | null; records: LiveRecord[]; dropped: number; epoch: string;
  asked: Map<string, Asked>; title: string | null };

/** One console process's Flexible threads (openFlexibleSessions). `changes` counts, per thread, what this host changed
 * that its owner's view shows (records, requests, answers, turns, level, the agent's life); `waiters` are the owner's
 * reads waiting for the next change (waitFlexibleThreadChange). */
export type FlexibleSessions = { readonly holder: string; readonly catalog: FlexibleAnswerCatalog; readonly io: CustodyIO; readonly threads: Map<string, ThreadSession>;
  readonly changes: Map<string, number>; readonly waiters: Map<string, Set<() => void>> };

/** Something the owner's view of `thread` shows changed here: its count moves and every read waiting on it wakes. */
function bump(sessions: FlexibleSessions, thread: string): void {
  sessions.changes.set(thread, (sessions.changes.get(thread) ?? 0) + 1);
  const waiting = sessions.waiters.get(thread);
  if (waiting === undefined) return;
  sessions.waiters.delete(thread);
  for (const wake of waiting) { try { wake(); } catch { /* one waiter never stops another */ } }
}
/** Every thread this host holds changed (an upkeep tick or a recovery settled answers it can't name one by one). */
function bumpAll(sessions: FlexibleSessions): void {
  for (const thread of new Set([...sessions.threads.keys(), ...sessions.waiters.keys()])) bump(sessions, thread);
}

const sha16 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const HOLDER = /^console:([1-9][0-9]{0,9}):([0-9a-f]{16})$/;
/** A process's holder name: its pid and (a digest of) its start identity, or null when that can't be read. */
function holderOf(pid: number, io: Pick<CustodyIO, "table">): string | null {
  const start = startIdentityOf(pid, io);
  return start === null ? null : `console:${pid}:${sha16(start)}`;
}
/**
 * Whether a holder named as holderOf names them is gone, alive or unknown. Gone only on proof: the process table was
 * read whole and has no live process with its pid, or that pid's start identity is known and is another one. A table
 * that can't be read, or a start identity that can't, is unknown; a holder named any other way is unknown too. Unknown
 * never recovers.
 */
export type FlexibleHolderLife = "gone" | "alive" | "unknown";
function holderLife(holder: string, io: Pick<CustodyIO, "table">): FlexibleHolderLife {
  const named = HOLDER.exec(holder);
  if (named === null) return "unknown";
  let table: ReturnType<CustodyIO["table"]>;
  try { table = io.table(); } catch { return "unknown"; }
  if (table === null) return "unknown";
  const pid = Number(named[1]);
  const row = table.find(one => one.pid === pid && !one.zombie);
  if (row === undefined) return "gone";
  if (row.start === null) return "unknown";
  return sha16(row.start) === named[2] ? "alive" : "gone";
}

/**
 * Open this process's host: its holder name (pid and start identity), and the coding catalog's answer side. Nothing
 * runs until a thread's session starts.
 */
export function openFlexibleSessions(store: Store, input: { pid?: number; io?: CustodyIO } = {}): { ok: true; sessions: FlexibleSessions } | FlexibleSessionRefusal | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const io = input.io ?? defaultCustodyIO();
  const holder = holderOf(input.pid ?? process.pid, io);
  if (holder === null) return refuse("no-holder");
  const opened = openFlexibleAnswerCatalog(store);
  if (!opened.ok) return opened;
  return { ok: true, sessions: { holder, catalog: opened.catalog, io, threads: new Map(), changes: new Map(), waiters: new Map() } };
}

/** Close the host: every thread's agent stopped, its answers revoked and its relay closed, then the catalog. */
export async function closeFlexibleSessions(store: Store, sessions: FlexibleSessions, input: { clock?: FlexibleClock } = {}): Promise<{ ok: true } | FlexibleSessionRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  for (const thread of [...sessions.threads.keys()]) {
    try { await stopFlexibleThreadSession(store, sessions, { thread, reason: "Toolroll stopped", ...(input.clock === undefined ? {} : { clock: input.clock }) }); } catch { /* recovery settles it */ }
  }
  sessions.catalog.close();
  bumpAll(sessions);
  return { ok: true };
}

// ---- upkeep: the tick and holder recovery -------------------------------------------------------------------------------------

/** The console's upkeep tick: answers past their deadlines are settled (F2d expireFlexibleAnswers). */
export function tickFlexibleSessions(store: Store, sessions: FlexibleSessions, input: { clock?: FlexibleClock } = {}): { ok: true; uncertain: number } | FlexibleSessionRefusal | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const expired = expireFlexibleAnswers(store, sessions.catalog, input.clock === undefined ? {} : { clock: input.clock });
  if (expired.ok && expired.uncertain > 0) bumpAll(sessions);
  return expired;
}

/**
 * Holder recovery: every other holder that left launches or turns open and is proved gone (no process with its pid and
 * start identity) has its launches stopped and verified (F2c recoverFlexibleLaunchesOf), then its answers recovered (F2d
 * recoverFlexibleAnswersOf: pending withdrawn, anything in flight uncertain, never sent again). A holder that can't be
 * proved gone is left alone.
 */
export async function recoverFlexibleHolders(store: Store, sessions: FlexibleSessions, input: { clock?: FlexibleClock } = {}):
  Promise<{ ok: true; recovered: string[]; unresolved: string[]; unknown: string[] } | FlexibleSessionRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const clocked = input.clock === undefined ? {} : { clock: input.clock };
  const holders = new Set([
    ...store.handle.prepare("SELECT DISTINCT holder FROM flexible_thread_launch WHERE state <> 'exited'").all().map(row => String(row["holder"])),
    ...store.handle.prepare("SELECT DISTINCT holder FROM thread_turn WHERE status IN ('admitted', 'running')").all().map(row => String(row["holder"])),
  ]);
  const recovered: string[] = [], unresolved: string[] = [], unknown: string[] = [];
  for (const holder of [...holders].sort()) {
    if (holder === sessions.holder) continue;
    const life = holderLife(holder, sessions.io);
    if (life === "unknown" && HOLDER.test(holder)) unknown.push(holder);
    if (life !== "gone") continue;
    const launches = await recoverFlexibleLaunchesOf(store, { holder, ...clocked, io: sessions.io });
    const answers = recoverFlexibleAnswersOf(store, sessions.catalog, { holder, ...clocked });
    if (!launches.ok || launches.unresolved > 0 || !answers.ok) unresolved.push(holder); else recovered.push(holder);
  }
  if (recovered.length + unresolved.length > 0) bumpAll(sessions);
  return { ok: true, recovered, unresolved, unknown };
}

// ---- a thread's session: its relay, its agent ---------------------------------------------------------------------------------

/** Start a thread's session here: its sign-in relay listens (one per thread, until the session stops). */
export async function startFlexibleThreadSession(store: Store, sessions: FlexibleSessions, input: { thread: string }): Promise<{ ok: true; relayPort: number } | FlexibleSessionRefusal | { ok: false; reason: string; message: string }> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread)) return refuse("invalid-request");
  const held = sessions.threads.get(input.thread);
  if (held?.relay != null) return { ok: true, relayPort: held.relay.port };
  const relay = await startFlexibleRelay(store, { thread: input.thread });
  if ("ok" in relay) return relay;
  const session = held ?? { thread: input.thread, relay: null, agent: null, records: [], dropped: 0, epoch: randomBytes(8).toString("hex"), asked: new Map(), title: null };
  session.relay = relay;
  sessions.threads.set(input.thread, session);
  return { ok: true, relayPort: relay.port };
}

/**
 * Stop a thread's session: its answers revoked first (nothing more is sent), its agent's stdin closed and the agent
 * stopped with its whole tree's exit verified (F2c stopFlexibleThreadAgent), then its relay closed.
 */
export async function stopFlexibleThreadSession(store: Store, sessions: FlexibleSessions, input: { thread: string; reason: string; clock?: FlexibleClock }):
  Promise<{ ok: true; stopped: boolean; why: string | null } | FlexibleSessionRefusal | FlexibleAnswerRefusal | { ok: false; reason: string; message: string }> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread) || typeof input.reason !== "string" || input.reason.length < 1 || input.reason.length > 200) return refuse("invalid-request");
  const clocked = input.clock === undefined ? {} : { clock: input.clock };
  const revoked = revokeFlexibleAnswers(store, sessions.catalog, { thread: input.thread, reason: input.reason, ...clocked });
  if (!revoked.ok) return revoked;
  const session = sessions.threads.get(input.thread);
  if (session?.agent != null) { try { session.agent.stdin.end(); } catch { /* already closed */ } }
  const stopped = await stopFlexibleThreadAgent(store, { id: input.thread, reason: input.reason, ...clocked, io: sessions.io });
  if (session !== undefined) {
    session.agent = null;
    try { await session.relay?.close(); } catch { /* closed already */ }
    session.relay = null;
    sessions.threads.delete(input.thread);
  }
  bump(sessions, input.thread);
  if ("reason" in stopped) return stopped;
  return { ok: true, stopped: stopped.ok, why: stopped.ok ? null : stopped.why };
}

/** A card's text as kept: the live sanitizer's (controls, escapes, bidi out), cut, and hidden whole when it looks like a secret. */
function cardText(given: unknown, cap: number): string {
  if (typeof given !== "string") return "";
  const one = cleanLiveText(given).trim().slice(0, cap);
  return liveSecretHit(one) ? HIDDEN_LINE : one;
}

/** The agent's whole request as canonical JSON (keys sorted at every level), and its SHA-256: what an allow binds to. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function flexibleInputDigest(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256").update(canonical({ tool, input }), "utf8").digest("hex");
}

/** How a tab is drawn on a card: a visible mark and padding (never a bare space, which would read as a space). */
const TAB_MARK = "→";
const TAB_SHOWN = `${TAB_MARK}   `;
/** How much of a request a card shows whole; past either, it can't be allowed from a card. */
export const FLEXIBLE_SCOPE_LINES = 200;
export const FLEXIBLE_SCOPE_CHARS = 16_000;
/** The most a card's detail may hold (F2d's card limit is 32,000): a whole card's detail is never cut to fit it. */
const FLEXIBLE_DETAIL_CHARS = 30_000;
const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * Every line of what an allow would allow, as the person reads it: a command's every line, a file change's path and its
 * whole change (each line marked - or +, its size), anything else as its full input. `complete` is false, and the
 * lines a short preview with the reason, when it can't all be shown truthfully: too long, a line shaped like a secret,
 * or characters a terminal can't show (cleaning would change what the person reads).
 */
function scopeOf(tool: string, input: Record<string, unknown>): { lines: string[]; complete: boolean; why: string | null } {
  const unshown = (raw: string[], why: string) => {
    const preview = raw.slice(0, 10).map(line => cardText(line, 300));
    return { lines: [...preview, ...(raw.length > 10 ? [`… and ${raw.length - 10} more lines`] : []), `This can't be allowed from here: ${why}. You can deny it.`], complete: false, why };
  };
  const raw: string[] = [];
  const text = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const rest = (skip: string[]) => {
    for (const key of Object.keys(input).sort()) if (!skip.includes(key)) raw.push(`${key}: ${text(input[key])}`);
  };
  if (tool === "Bash") {
    raw.push(...text(input["command"]).split("\n"));
    rest(["command"]);
  } else if (tool === "Write") {
    const content = text(input["content"]);
    raw.push(`file: ${text(input["file_path"])}`, `content (${Buffer.byteLength(content, "utf8")} bytes):`, ...content.split("\n").map(line => `+ ${line}`));
    rest(["file_path", "content"]);
  } else if (tool === "Edit") {
    raw.push(`file: ${text(input["file_path"])}`, ...text(input["old_string"]).split("\n").map(line => `- ${line}`), ...text(input["new_string"]).split("\n").map(line => `+ ${line}`));
    rest(["file_path", "old_string", "new_string"]);
  } else {
    raw.push(...JSON.stringify(input, null, 2).split("\n"));
  }
  // A tab is drawn as a visible mark (TAB_SHOWN), so the text read maps one to one onto the bytes sent; text that already
  // holds that mark beside a tab would be ambiguous, and any other character display would change is unshowable.
  const shown = raw.map(line => line.replace(/\t/g, TAB_SHOWN));
  // The caps count the text as shown (a tab drawn as its mark is longer than the tab), never the raw bytes.
  const why = shown.length > FLEXIBLE_SCOPE_LINES || shown.reduce((sum, line) => sum + line.length + 1, 0) > FLEXIBLE_SCOPE_CHARS ? "it is too long to show here"
    : raw.some(line => liveSecretHit(line)) ? "part of it is shaped like a secret, so it isn't shown"
    : raw.some(line => line.includes("\t")) && raw.some(line => line.includes(TAB_MARK)) ? "its tabs couldn't be told apart from its own text"
    : shown.some(line => cleanLiveText(line) !== line) ? "it holds characters a terminal can't show"
    : null;
  if (why !== null) return unshown(raw, why);
  // Never cut a card that says it is whole: past the card's own detail cap it is shown as not whole instead.
  if (shown.join("\n").length > FLEXIBLE_DETAIL_CHARS) return unshown(raw, "it is too long to show here");
  return { lines: shown, complete: true, why: null };
}

/** The card a person is shown for an agent's request (Claude's stdio permission channel: `can_use_tool`), in Toolroll's
 * own words with the agent's text cleaned, bound to the tool and the digest of its whole input; null when it isn't a
 * request Toolroll can show. */
function cardOf(tool: string, input: Record<string, unknown>): { kind: FlexibleRequestKind; card: FlexibleRequestCard; questions: string[]; inputDigest: string } | null {
  const inputDigest = flexibleInputDigest(tool, input);
  // The tool's name exactly as the agent gave it, or the card isn't whole: a name too long, or one display would change.
  const toolShown = /^[\x21-\x7e]{1,100}$/.test(tool);
  const bound = { tool: toolShown ? tool : "unnamed", input: inputDigest };
  if (tool === "AskUserQuestion") {
    const given = Array.isArray(input["questions"]) ? (input["questions"] as unknown[]).slice(0, 9) : [];
    const questions: { id: string; question: string; options?: { label: string }[] }[] = [];
    const texts: string[] = [];
    let complete = toolShown && (input["questions"] as unknown[] | undefined)?.length === given.length;
    for (const [index, one] of given.entries()) {
      if (typeof one !== "object" || one === null) return null;
      const q = one as Record<string, unknown>;
      const question = cardText(q["question"], 4000);
      if (question === "" || typeof q["question"] !== "string") return null;
      if (question !== q["question"]) complete = false;
      const options = (Array.isArray(q["options"]) ? (q["options"] as unknown[]).slice(0, 9) : [])
        .map(option => ({ label: cardText(typeof option === "object" && option !== null ? (option as Record<string, unknown>)["label"] : null, 200) }))
        .filter(option => option.label !== "");
      questions.push({ id: String(index + 1), question, ...(options.length === 0 ? {} : { options }) });
      texts.push(q["question"]);
    }
    if (questions.length === 0) return null;
    return { kind: "question", card: { title: questions.length === 1 ? "The agent asks you" : `The agent asks you ${questions.length} things`, ...bound, complete, questions }, questions: texts, inputDigest };
  }
  const scope = scopeOf(tool, input);
  const title = tool === "Bash" ? "Allow this command?" : FILE_TOOLS.includes(tool) ? "Allow this change to a file?"
    : tool === "WebFetch" || tool === "WebSearch" ? "Allow this lookup?" : `Allow the agent's ${bound.tool} step?`;
  const lines = toolShown ? scope.lines : [...scope.lines, "This can't be allowed from here: the agent's name for this step can't be shown as it is. You can deny it."];
  const detail = lines.join("\n");
  // A detail past F2d's limit is never cut while the card says it is whole: it is cut only on a deny-only card.
  const whole = scope.complete && toolShown && detail.length <= FLEXIBLE_DETAIL_CHARS;
  return { kind: "permission", card: { title, detail: whole ? detail : detail.slice(0, FLEXIBLE_DETAIL_CHARS), ...bound, complete: whole }, questions: [], inputDigest };
}

/** An answer in Claude's stdio control form for the request it answers (`frame`: pure, run inside F2d's attempt). */
function frameFor(session: ThreadSession, requestRef: string, answer: FlexibleAnswerPayload): Uint8Array {
  const asked = [...session.asked.values()].find(one => one.ref === requestRef);
  if (asked === undefined) throw new Error("no such request on this connection");
  let response: Record<string, unknown>;
  if ("decision" in answer) {
    response = answer.decision === "accept" ? { behavior: "allow", updatedInput: asked.input }
      : { behavior: "deny", message: answer.decision === "cancel" ? "The person cancelled this." : "The person declined this." };
  } else {
    const given = Object.entries(answer.answers);
    if (given.length === 0) response = { behavior: "deny", message: "The person didn't answer." };
    else {
      const answers = Object.fromEntries(asked.questions.map((text, index) => [text, answer.answers[String(index + 1)]?.answers.join(", ") ?? ""]));
      response = { behavior: "allow", updatedInput: { ...asked.input, answers } };
    }
  }
  return Buffer.from(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestRef, response } })}\n`, "utf8");
}

/**
 * Attach a thread's live agent to its session (the thread start does, with the child it spawned; tests, with a scripted
 * connection): its stdout read line by line into live records, requests and turn ends; its stdin the answer connection.
 * When it exits, its answers are revoked and the session forgets it.
 */
export function attachFlexibleAgent(store: Store, sessions: FlexibleSessions, input: { thread: string; turn: string | null; launch: string; stdout: Readable; stdin: Writable;
  exited: (listener: () => void) => void; clock?: FlexibleClock }): { ok: true } | FlexibleSessionRefusal | FlexibleAnswerRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread) || typeof input.launch !== "string" || !ID.test(input.launch) || (input.turn !== null && (typeof input.turn !== "string" || !ID.test(input.turn)))) return refuse("invalid-request");
  const session = sessions.threads.get(input.thread);
  const thread = flexibleThread(store, input.thread);
  if (session === undefined || thread === null) return refuse("thread-unknown");
  const send = streamAnswerSender(input.stdin);
  if (typeof send !== "function") return send;
  const clock = input.clock ?? systemClock;
  const clocked = { clock };
  const link: AgentLink = { launch: input.launch, turn: input.turn, stdin: input.stdin,
    connection: { id: input.launch, frame: (ref, answer) => frameFor(session, ref, answer), send },
    recorder: createLiveRecorder({ base: thread.folder === "" ? null : `${thread.folder}/repo`, commands: false, clock }) };
  session.agent = link;
  const keep = (records: LiveRecord[]) => {
    if (records.length === 0) return;
    session.records.push(...records);
    if (session.records.length > FLEXIBLE_RECORDS_KEPT) {
      const drop = session.records.length - FLEXIBLE_RECORDS_KEPT;
      session.records.splice(0, drop);
      session.dropped += drop;
    }
    bump(sessions, input.thread);
  };
  const event = (raw: Record<string, unknown>) => {
    if (session.agent !== link) return;
    if (raw["type"] === "control_request") {
      const request = raw["request"] as Record<string, unknown> | undefined;
      const ref = raw["request_id"];
      if (typeof request !== "object" || request === null || request["subtype"] !== "can_use_tool" || typeof ref !== "string" || !REF.test(ref) || link.turn === null) return;
      const given = request["input"];
      const toolInput = typeof given === "object" && given !== null && !Array.isArray(given) ? given as Record<string, unknown> : {};
      const tool = String(request["tool_name"] ?? "");
      const shown = cardOf(tool, toolInput);
      if (shown === null) return;
      const correlation = typeof request["tool_use_id"] === "string" && REF.test(request["tool_use_id"]) ? request["tool_use_id"] : null;
      const made = recordFlexibleRequest(store, sessions.catalog, { thread: input.thread, turn: link.turn, connection: link.launch, holder: sessions.holder, requestRef: ref,
        kind: shown.kind, card: shown.card, correlation, ...clocked });
      if (made.ok) session.asked.set(made.request, { request: made.request, token: made.token, ref, kind: shown.kind, tool, input: structuredClone(toolInput), inputDigest: shown.inputDigest,
        complete: shown.card.complete !== false, questions: shown.questions });
      bump(sessions, input.thread);
      return;
    }
    // Tool activity carrying a request's tool id: F2d decides whether it is that answer's acknowledgement.
    if (raw["type"] === "user" && link.turn !== null) {
      const content = (raw["message"] as Record<string, unknown> | undefined)?.["content"];
      for (const part of Array.isArray(content) ? content : []) {
        const id = typeof part === "object" && part !== null && (part as Record<string, unknown>)["type"] === "tool_result" ? (part as Record<string, unknown>)["tool_use_id"] : null;
        if (typeof id === "string" && REF.test(id)) { noteFlexibleToolActivity(store, sessions.catalog, { connection: link.launch, turn: link.turn, correlation: id, ...clocked }); bump(sessions, input.thread); }
      }
    }
    keep(link.recorder.observe(raw));
    if (primaryResultEvent(raw) && link.turn !== null) {
      void endFlexibleThreadTurn(store, sessions, { thread: input.thread, turn: link.turn, outcome: "finished", ...clocked });
    }
  };
  const decoder = new StringDecoder("utf8");
  let carry = "", skipping = false;
  input.stdout.on("data", (chunk: Buffer | string) => {
    carry += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let end: number;
    while ((end = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, end);
      carry = carry.slice(end + 1);
      if (skipping) { skipping = false; continue; }
      try { const parsed = JSON.parse(line) as unknown; if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) event(parsed as Record<string, unknown>); }
      catch { /* not an event */ }
    }
    if (carry.length > LINE_CAP) { carry = ""; skipping = true; }
  });
  input.exited(() => {
    if (session.agent === link) { keep(link.recorder.end()); session.agent = null; }
    revokeFlexibleAnswers(store, sessions.catalog, { thread: input.thread, connection: link.launch, reason: "the agent stopped", ...clocked });
    bump(sessions, input.thread);
  });
  return { ok: true };
}

/** A turn ended (its result, or the caller's word): recorded with the relay's own counts (F2e finishFlexibleTurn, usage
 * never the agent's), then every request of that turn still open is revoked. */
export function endFlexibleThreadTurn(store: Store, sessions: FlexibleSessions, input: { thread: string; turn: string; outcome: "finished" | "unknown"; detail?: string; clock?: FlexibleClock }):
  { ok: true; withdrawn: number; notSent: number } | FlexibleSessionRefusal | FlexibleAnswerRefusal | { ok: false; reason: string; message: string } {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread) || typeof input.turn !== "string" || !ID.test(input.turn)) return refuse("invalid-request");
  const clocked = input.clock === undefined ? {} : { clock: input.clock };
  const finished = finishFlexibleTurn(store, { turn: input.turn, holder: sessions.holder, outcome: input.outcome, usage: null, ...(input.detail === undefined ? {} : { detail: input.detail }), ...clocked });
  const revoked = revokeFlexibleAnswers(store, sessions.catalog, { thread: input.thread, turn: input.turn, reason: "the turn ended", ...clocked });
  const agent = sessions.threads.get(input.thread)?.agent;
  if (agent != null && agent.turn === input.turn) agent.turn = null;
  bump(sessions, input.thread);
  if (!revoked.ok) return revoked;
  if (!finished.ok && finished.reason !== "turn-not-running") return finished;
  return revoked;
}

/** Lower a thread's level (F2c lowerFlexibleThreadLevel: its owner, narrowing only), then revoke every open request of the
 * thread: nothing asked under the old level is answered under the new one. */
export async function lowerFlexibleThreadSession(store: Store, sessions: FlexibleSessions, input: { thread: string; by: { name: string; generation: number }; level: FlexibleLevel; clock?: FlexibleClock }):
  Promise<{ ok: true; level: FlexibleLevel; stopped: "none" | "stopped" | "pending"; message: string } | FlexibleSessionRefusal | { ok: false; reason: string; message: string }> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread) || !isFlexibleLevel(input.level)) return refuse("invalid-request");
  const clocked = input.clock === undefined ? {} : { clock: input.clock };
  const lowered = await lowerFlexibleThreadLevel(store, { thread: input.thread, by: input.by, level: input.level, ...clocked, io: sessions.io });
  if (!lowered.ok) return lowered;
  const revoked = revokeFlexibleAnswers(store, sessions.catalog, { thread: input.thread, reason: `the thread was lowered to ${FLEXIBLE_LEVEL_WORDS[input.level]}`, ...clocked });
  bump(sessions, input.thread);
  if (!revoked.ok) return revoked;
  return lowered;
}

/**
 * Start an admitted turn (F2c startFlexibleTurn, under this host's holder and the thread's relay), attach a newly
 * started agent, and hand it the person's message as its next user frame. The launch's network (its own run proxy,
 * under the project's network now, or exactly `expectNetwork` for a first launch a person was shown) and its storage
 * check come from this console's launcher (flexible-launcher.ts); startFlexibleTurn closes the proxy when the agent is
 * stopped, or at once when the turn launches nothing.
 */
export async function beginFlexibleThreadTurn(store: Store, sessions: FlexibleSessions, input: { turn: string; message: string; launcher: FlexibleLauncher | null; clock?: FlexibleClock;
  expectNetwork?: string; seams?: FlexibleTurnStartInput["seams"]; proven?: FlexibleTurnStartInput["proven"] }): Promise<{ ok: true; launched: "started" | "reused"; launchId: string } | FlexibleSessionRefusal | { ok: false; reason: string; message: string }> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.turn !== "string" || !ID.test(input.turn) || typeof input.message !== "string" || input.message.trim() === "" || input.message.length > 100_000) return refuse("invalid-request");
  if (input.launcher === null) return refuse("no-network");
  const turn = flexibleTurn(store, input.turn);
  if (turn === null) return refuse("invalid-request");
  const thread = flexibleThread(store, turn.thread);
  if (thread === null) return refuse("thread-unknown");
  const relayed = await startFlexibleThreadSession(store, sessions, { thread: turn.thread });
  if (!relayed.ok) return relayed;
  const session = sessions.threads.get(turn.thread)!;
  const clocked = input.clock === undefined ? {} : { clock: input.clock };
  const prepared = await input.launcher.prepare({ id: thread.id, repo: thread.repo }, input.expectNetwork === undefined ? undefined : { network: input.expectNetwork });
  if (!prepared.ok) {
    // Nothing launched: the turn is withdrawn (it counts toward nothing), as startFlexibleTurn withdraws a turn it won't run.
    withdrawFlexibleTurn(store, { turn: input.turn, holder: sessions.holder, detail: prepared.message, ...clocked });
    bump(sessions, turn.thread);
    return prepared;
  }
  const network = prepared.network;
  const started = await startFlexibleTurn(store, { turn: input.turn, holder: sessions.holder, ...clocked, network, relay: session.relay!, storage: prepared.storage,
    ...(input.launcher.platform === undefined ? {} : { platform: input.launcher.platform }), ...(input.seams === undefined ? {} : { seams: input.seams }), ...(input.proven === undefined ? {} : { proven: input.proven }) });
  if (!started.ok) { bump(sessions, turn.thread); return started; }
  if (started.launched === "started") {
    const child = started.child;
    if (child.stdout === null || child.stdin === null) return refuse("invalid-request");
    const attached = attachFlexibleAgent(store, sessions, { thread: turn.thread, turn: input.turn, launch: started.launchId, stdout: child.stdout, stdin: child.stdin,
      exited: listener => { child.once("exit", listener); }, ...clocked });
    if (!attached.ok) return attached;
  } else if (session.agent !== null && session.agent.launch === started.launchId) {
    session.agent.turn = input.turn;
  }
  session.title ??= cardText(input.message.split("\n")[0], 80) || null;
  try { session.agent?.stdin.write(`${userFrame(input.message, randomUUID())}\n`); } catch { /* its exit settles the turn */ }
  bump(sessions, turn.thread);
  return { ok: true, launched: started.launched, launchId: started.launchId };
}

/**
 * Start a new thread for a person (a person's surface only): the thread's isolated repository (F2a), its session and
 * relay, its first turn admitted under the terms they were shown (`digest`; no fresh password: at most the terms'
 * password-free level), and the turn begun with their message. Refused before anything is made when this console has no
 * launcher for the thread's network.
 */
export async function startFlexibleThread(store: Store, sessions: FlexibleSessions, input: { repo: string; by: { name: string; generation: number }; digest: string; message: string; model: string;
  launcher: FlexibleLauncher | null; clock?: FlexibleClock;
  /** The person proved themselves for this start just now (a password, an identity-provider re-check, the local owner's
   * own act): a start above the terms' password-free level needs it. Never a session standing in. */
  freshProof?: boolean;
  /** The network digest of the terms card the person was shown (flexible-start.ts): the first launch is held to it. */
  expectNetwork?: string;
  seams?: FlexibleTurnStartInput["seams"]; proven?: FlexibleTurnStartInput["proven"] }): Promise<{ ok: true; thread: string; turn: string } | FlexibleSessionRefusal | { ok: false; reason: string; message: string }> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.repo !== "string" || typeof input.digest !== "string" || typeof input.model !== "string" || typeof input.message !== "string" || input.message.trim() === "") return refuse("invalid-request");
  if (input.launcher === null) return refuse("no-network");
  const clock = input.clock ?? systemClock;
  const prepared = await prepareFlexibleThread(store, { repo: input.repo, base: "HEAD", by: input.by.name, now: clock() });
  if (!prepared.ok) return prepared;
  const thread = prepared.thread.id;
  const admitted = admitFlexibleTurn(store, { thread, starter: input.by, digest: input.digest, level: "full", freshProof: input.freshProof === true, provider: "claude", model: input.model, billing: "subscription",
    requestKey: randomBytes(16).toString("hex"), holder: sessions.holder, clock });
  if (!admitted.ok) return admitted;
  const begun = await beginFlexibleThreadTurn(store, sessions, { turn: admitted.turn, message: input.message, launcher: input.launcher, clock,
    ...(input.expectNetwork === undefined ? {} : { expectNetwork: input.expectNetwork }), ...(input.seams === undefined ? {} : { seams: input.seams }), ...(input.proven === undefined ? {} : { proven: input.proven }) });
  if (!begun.ok) return begun;
  return { ok: true, thread, turn: admitted.turn };
}

// ---- answering ------------------------------------------------------------------------------------------------------------------

/** What a person picked on a card: a permission's allow or deny, or one question's answer (the option's words as shown). */
export type FlexibleChoice = { decision: "accept" | "decline" } | { question: string; answer: string };

/**
 * A person answers a request of their thread's agent: decided (F2d decideFlexibleAnswer, with this host's token for the
 * request, the card digest they were shown and their own session as `by`) and sent (F2d sendFlexibleAnswer, on the
 * thread's live agent connection, as this host's holder). A send whose outcome is uncertain closes the agent's stdin:
 * bytes may be part way out, and nothing more is written after them.
 */
export async function answerFlexibleRequest(store: Store, sessions: FlexibleSessions, input: { thread: string; request: string; shownDigest: string; by: { kind: "person"; name: string; generation: number };
  choice: FlexibleChoice; clock?: FlexibleClock; writeMs?: number;
  /** The person's own session, still held (its saved authority, re-read): bound to the decision and checked again
   * inside F2d's decision and its final attempt transaction. */
  held: () => boolean }): Promise<{ ok: true; state: "sent" } | FlexibleSessionRefusal | FlexibleAnswerRefusal> {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread) || typeof input.request !== "string" || !ID.test(input.request) || typeof input.shownDigest !== "string"
    || typeof input.choice !== "object" || input.choice === null || typeof input.held !== "function") return refuse("invalid-request");
  // The thread's owner only, at their account's current generation, checked here before anything is decided; F2d
  // checks the turn's owner and generation again at the decision and at the write (the backstop, not the only line).
  if (input.by?.kind !== "person" || typeof input.by.name !== "string" || !Number.isSafeInteger(input.by.generation)) return refuse("not-owner");
  const account = store.accountOf(input.by.name);
  if (ownThread(store, input.thread, { name: input.by.name }) === null || account === null || account.revokedAt !== null || account.generation !== input.by.generation) return refuse("not-owner");
  const session = sessions.threads.get(input.thread);
  const asked = session?.asked.get(input.request);
  if (session === undefined || asked === undefined) return refuse("not-answerable");
  const choice = input.choice;
  const decision = "decision" in choice ? (choice.decision === "accept" || choice.decision === "decline" ? choice.decision : null) : asked.kind === "question" ? "answer" as const : null;
  if (decision === null || (!("decision" in choice) && (typeof choice.question !== "string" || typeof choice.answer !== "string" || choice.answer.length < 1 || choice.answer.length > 16_000))) return refuse("invalid-request");
  // An allow covers the whole request: only one whose card showed all of it, and whose input is still the one digested.
  if (decision === "accept" && (!asked.complete || flexibleInputDigest(asked.tool, asked.input) !== asked.inputDigest)) return refuse("scope-unshown");
  const clocked = input.clock === undefined ? {} : { clock: input.clock };
  const answers = "decision" in choice ? undefined : { [choice.question]: { answers: [choice.answer] } };
  const decided = decideFlexibleAnswer(store, sessions.catalog, { request: input.request, token: asked.token, shownDigest: input.shownDigest, by: input.by, decision, ...(answers === undefined ? {} : { answers }),
    held: input.held, ...clocked });
  bump(sessions, input.thread);
  if (!decided.ok) return decided;
  // The agent's connection as this host holds it now; with none, F2d refuses the send (the connection changed) and the
  // answer is not-sent.
  const agent = session.agent;
  const connection: FlexibleAnswerConnection = agent?.connection ?? { id: "0".repeat(32), frame: () => new Uint8Array(0), send: async () => ({ written: 0, complete: false }) };
  const sent = await sendFlexibleAnswer(store, sessions.catalog, { request: input.request, connection, holder: sessions.holder, held: input.held, ...clocked, ...(input.writeMs === undefined ? {} : { writeMs: input.writeMs }) });
  if (!sent.ok && sent.reason === "uncertain" && agent != null) {
    try { agent.stdin.destroy(); } catch { /* already closed */ }
  }
  bump(sessions, input.thread);
  return sent.ok ? { ok: true, state: "sent" } : sent;
}

// ---- what the owner's surface reads ----------------------------------------------------------------------------------------------

export type FlexibleQuestionView = { request: string; kind: FlexibleRequestKind; title: string; detail: string | null; tool: string | null; complete: boolean; digest: string;
  state: FlexibleAnswerState; answerable: boolean; parts: { id: string; question: string; options: string[] }[] };
export type FlexibleThreadFacts = { version: string; title: string; project: string | null; level: FlexibleLevel | null; agent: { provider: string; model: string } | null;
  turn: { seq: number; status: string; costUsd: number | null; costBasis: "measured" | "estimated" | "unknown" | null } | null; questions: FlexibleQuestionView[] };
export type FlexibleWindow = { ok: true; records: LiveRecord[]; cursor: string; restarted: boolean; earlier: boolean; quarantined: number; skipped: number; more: boolean }
  | { ok: false; reason: "missing" };

/** The thread's level as it stands: the one it was lowered to, else its last turn's. */
function levelOf(store: Store, thread: string): FlexibleLevel | null {
  const chosen = store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(thread)?.["level"];
  if (isFlexibleLevel(chosen)) return chosen;
  const last = store.handle.prepare("SELECT level FROM thread_turn WHERE thread = ? AND status <> 'withdrawn' ORDER BY seq DESC LIMIT 1").get(thread)?.["level"];
  return isFlexibleLevel(last) ? last : null;
}

function factsOf(store: Store, sessions: FlexibleSessions, thread: { id: string; repo: string }, session: ThreadSession | undefined): FlexibleThreadFacts {
  const last = store.handle.prepare("SELECT id FROM thread_turn WHERE thread = ? AND status <> 'withdrawn' ORDER BY seq DESC LIMIT 1").get(thread.id)?.["id"];
  const turn = typeof last === "string" ? flexibleTurn(store, last) : null;
  const read = turn === null ? null : flexibleRequestsOf(sessions.catalog, { thread: thread.id, turn: turn.id });
  const questions = read === null || !read.ok ? [] : read.requests.map(one => ({
    request: one.request, kind: one.kind, title: one.card.title, detail: one.card.detail ?? null, tool: one.card.tool ?? null, complete: one.card.complete !== false, digest: one.requestDigest, state: one.state,
    answerable: one.state === "pending" && session?.asked.has(one.request) === true && session.agent?.launch === one.connection,
    parts: (one.card.questions ?? []).map(q => ({ id: q.id, question: q.question, options: (q.options ?? []).map(option => option.label) })),
  }));
  const project = store.handle.prepare("SELECT name FROM project WHERE path = ?").get(thread.repo)?.["name"];
  const facts = {
    title: session?.title ?? `Thread ${thread.id.slice(0, 8)}`,
    project: typeof project === "string" ? project : null,
    level: levelOf(store, thread.id),
    agent: turn === null ? null : { provider: turn.provider, model: turn.model },
    turn: turn === null ? null : { seq: turn.seq, status: turn.status, costUsd: turn.costBasis === null ? null : turn.costMicrousd / 1_000_000, costBasis: turn.costBasis },
    questions,
  };
  // What the facts are, as one short digest: a client holding it is told "unchanged" instead of being sent them again.
  return { version: sha16(JSON.stringify(facts)), ...facts };
}

/** The thread if `viewer` is its owner (the person who started it: flexible_thread.created_by) and it is ready; null
 * otherwise, the same answer for unseen and gone. Every read and the answer road go through this check. */
function ownThread(store: Store, thread: string, viewer: { name: string }) {
  const row = typeof thread === "string" && ID.test(thread) ? flexibleThread(store, thread) : null;
  return row === null || row.state !== "ready" || row.createdBy !== viewer.name ? null : row;
}

/**
 * One window of a thread's live session, for its owner only: its records from `cursor` (this host's memory: a restart
 * starts them over, said by `restarted`), and its facts (level, agent, the current turn and its cost, its questions with
 * where each answer stands and whether it can be answered here). `file` "sub": a thread has no helpers' file.
 */
export function flexibleThreadLiveOf(store: Store, sessions: FlexibleSessions, input: { thread: string; viewer: { name: string }; file: "main" | "sub"; cursor: string | null }):
  { ok: true; live: boolean; window: FlexibleWindow; facts: FlexibleThreadFacts } | FlexibleSessionRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const thread = ownThread(store, input.thread, input.viewer);
  if (thread === null) return refuse("thread-unknown");
  const session = sessions.threads.get(thread.id);
  const facts = factsOf(store, sessions, thread, session);
  const live = session?.agent != null;
  if (input.file === "sub" || session === undefined) return { ok: true, live, window: { ok: false, reason: "missing" }, facts };
  const total = session.dropped + session.records.length;
  const named = input.cursor === null ? null : /^([0-9a-f]{16})\.(0|[1-9][0-9]{0,11})$/.exec(input.cursor);
  const restarted = input.cursor !== null && (named === null || named[1] !== session.epoch || Number(named[2]) > total);
  let from = named !== null && !restarted ? Number(named[2]) : session.dropped;
  const earlier = from < session.dropped;
  if (earlier) from = session.dropped;
  const records = session.records.slice(from - session.dropped, from - session.dropped + WINDOW_RECORDS);
  const next = from + records.length;
  return { ok: true, live, window: { ok: true, records, cursor: `${session.epoch}.${next}`, restarted, earlier, quarantined: 0, skipped: 0, more: next < total }, facts };
}

/** The owner's ready threads, newest first, as the work list shows them. */
export function flexibleThreadsOf(store: Store, sessions: FlexibleSessions, input: { owner: string }):
  { ok: true; threads: (FlexibleThreadFacts & { id: string; repo: string; live: boolean; waiting: number })[] } | FlexibleSessionRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.owner !== "string") return refuse("invalid-request");
  const rows = store.handle.prepare("SELECT id FROM flexible_thread WHERE created_by = ? AND state = 'ready' ORDER BY created_at DESC, id LIMIT 50").all(input.owner).map(row => String(row["id"]));
  const threads = rows.map(id => flexibleThread(store, id)).filter(one => one !== null).map(thread => {
    const session = sessions.threads.get(thread.id);
    const facts = factsOf(store, sessions, thread, session);
    return { ...facts, id: thread.id, repo: thread.repo, live: session?.agent != null, waiting: facts.questions.filter(one => one.answerable).length };
  });
  return { ok: true, threads };
}

/** Whether `viewer` may read or answer a thread here: its owner (its creator), the thread ready, and its project still
 * theirs (`canAccess`, the console's own access check). The same refusal for unseen and gone. */
export function admitFlexibleThreadOwner(store: Store, sessions: FlexibleSessions, input: { thread: string; viewer: { name: string }; canAccess: (repo: string) => boolean }):
  { ok: true; repo: string } | FlexibleSessionRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const thread = ownThread(store, input.thread, input.viewer);
  return thread === null || !input.canAccess(thread.repo) ? refuse("thread-unknown") : { ok: true, repo: thread.repo };
}

// ---- the owner's view, woken on change -----------------------------------------------------------------------------------------

/** How long an owner's read may wait for a change (the engine's long poll, engine-api.ts liveThread `wait=1`): well
 * inside a client's request timeout (the terminal's is 30 s). */
export const FLEXIBLE_WAIT_MS = 20_000;
/** Reads waiting at once on this host, all threads together: past it, a read answers at once (the client polls). */
export const FLEXIBLE_WAITERS_MAX = 64;

/** How many changes this host has seen for `thread` (0 before any): a read takes it BEFORE it reads, then waits for it
 * to move, so a change between the read and the wait is never missed. */
export function flexibleThreadChangeOf(sessions: FlexibleSessions, input: { thread: string }): { ok: true; change: number } | FlexibleSessionRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread)) return refuse("invalid-request");
  return { ok: true, change: sessions.changes.get(input.thread) ?? 0 };
}

/**
 * Wait until `thread` changes on this host past `since` (flexibleThreadChangeOf), `ms` passes, or `abandoned` says the
 * reader went away; at once when it already moved, or when FLEXIBLE_WAITERS_MAX reads are already waiting. The answer
 * says which; the caller reads again (under its own checks) whatever it is. Nothing is read or decided here.
 */
export function waitFlexibleThreadChange(sessions: FlexibleSessions, input: { thread: string; since: number; ms: number; abandoned?: (stop: () => void) => void }):
  Promise<{ ok: true; woke: "changed" | "timeout" | "busy" | "abandoned" }> | FlexibleSessionRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  if (typeof input.thread !== "string" || !ID.test(input.thread) || !Number.isSafeInteger(input.since) || !Number.isSafeInteger(input.ms) || input.ms < 0 || input.ms > FLEXIBLE_WAIT_MS) return refuse("invalid-request");
  if ((sessions.changes.get(input.thread) ?? 0) !== input.since) return Promise.resolve({ ok: true, woke: "changed" });
  const waiting = [...sessions.waiters.values()].reduce((sum, set) => sum + set.size, 0);
  if (waiting >= FLEXIBLE_WAITERS_MAX) return Promise.resolve({ ok: true, woke: "busy" });
  return new Promise(resolve => {
    let done = false;
    const finish = (woke: "changed" | "timeout" | "abandoned") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = sessions.waiters.get(input.thread);
      set?.delete(wake);
      if (set !== undefined && set.size === 0) sessions.waiters.delete(input.thread);
      resolve({ ok: true, woke });
    };
    const wake = () => finish("changed");
    const timer = setTimeout(() => finish("timeout"), input.ms);
    timer.unref();
    const set = sessions.waiters.get(input.thread) ?? new Set<() => void>();
    set.add(wake);
    sessions.waiters.set(input.thread, set);
    input.abandoned?.(() => finish("abandoned"));
  });
}
