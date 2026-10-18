/**
 * Chat reads like a teammate talking (2026-10-02): nobody is told about their
 * own completions, cancels or approvals; finished work landing within two
 * minutes is one message edited in place; no chat text carries a task id,
 * "— revision" or "Marked complete by" its reader; release checks and
 * replaced tasks stay quiet; a deploy says one "is live" line; the Telegram
 * bot is named Toolroll. The facts come from the real mutations and the
 * transports are scripted; nothing live is claimed.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { acquire, finalize } from "./claim.js";
import { withActor } from "./actor.js";
import { finishedView } from "./chat-quiet.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import { deliverSlackPart, planSlackNotifications, type SlackChatOptions } from "./slack-chat.js";
import type { SlackApi } from "./slack-api.js";

const T0 = new Date("2026-10-02T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const BOT = "777000";
const ALEX_CHAT = 4242;
const BOB_CHAT = 5353;
const REPO = "/projects/alpha";
const ORIGIN = "https://console.example";
const RUNNER = "worker-1";
const TTL = 10 * 365 * 24 * 3600 * 1000;
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

/** The six titles from the Oct 2 Telegram screenshot, ids and "— revision" included. */
const SIX = [
  ["faster-tests-2", "Faster tests — revision"],
  ["cleanup-r2", "Cleanup of the old status words (cleanup-r2) — revision"],
  ["accents-3", "Search ignores accents — revision"],
  ["chat-voice-4", "Chat reads like a subagent"],
  ["pr-open-5", "Pull requests open reliably — revision"],
  ["gallery-6", "Flow gallery shows sharing"],
] as const;

/** No chat text may carry these: a task id, a revision suffix, or the reader's own completion. */
function expectClean(texts: readonly string[], reader: string, ids: readonly string[] = SIX.map(one => one[0])): void {
  for (const text of texts) {
    expect(text).not.toMatch(/—\s*revision/i);
    expect(text).not.toContain(`Marked complete by ${reader}`);
    for (const id of ids) expect(text, `${id} in ${JSON.stringify(text)}`).not.toContain(id);
  }
}

function scriptedTelegram() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let next = 100;
  let name = "StandingOrders";
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") return { ok: true, result: [] };
    if (method === "getMyName") return { ok: true, result: { name } };
    if (method === "setMyName") { name = String(params["name"]); return { ok: true, result: true }; }
    if (method === "sendMessage" || method === "editMessageText") return { ok: true, result: { message_id: method === "editMessageText" ? params["message_id"] : next++ } };
    return { ok: true, result: true };
  };
  const inChat = (chat: number) => calls.filter(call => String(call.params["chat_id"]) === String(chat));
  /** A new message that can buzz: not the silent task card. */
  const pings = (chat: number) => inChat(chat).filter(call => call.method === "sendMessage" && call.params["disable_notification"] !== true);
  const shown = (chat: number) => inChat(chat).filter(call => call.method === "sendMessage" || call.method === "editMessageText").map(call => String(call.params["text"]));
  /** What a message says now: its last edit, or what was sent. */
  const current = (chat: number, messageId: number) => {
    const edits = inChat(chat).filter(call => call.method === "editMessageText" && call.params["message_id"] === messageId);
    return edits.length > 0 ? edits.at(-1)! : calls.find(call => call.method === "sendMessage" && String(call.params["chat_id"]) === String(chat) && calls.filter(one => one.method === "sendMessage").indexOf(call) + 100 === messageId)!;
  };
  const sentId = (call: { method: string; params: Record<string, unknown> }) => calls.filter(one => one.method === "sendMessage").indexOf(call) + 100;
  const buttons = (call: { params: Record<string, unknown> }) =>
    ((call.params["reply_markup"] as { inline_keyboard?: { text: string; url?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
  return { transport, calls, pings, shown, current, sentId, buttons, name: () => name, rename: (to: string) => { name = to; }, reset: () => { calls.length = 0; } };
}

describe("chat voice on Telegram", () => {
  let dir: string;
  let store: Store;
  let now: Date;
  let serial = 0;
  let alexToken = "";

  const pairAs = (who: string, chat: number, updateId: number) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(chat), userId: String(chat), updateId }, now).ok).toBe(true);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-chat-voice-"));
    store = openStore(join(dir, "orders.db"));
    now = T0;
    serial = 0;
    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("bootstrap failed");
    alexToken = alex.token;
    expect(addApprover(store, "bob", now, { name: "alex", token: alexToken }).ok).toBe(true);
    register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now, newToken: () => `tok-${RUNNER}` });
    pairAs("alex", ALEX_CHAT, 1);
    pairAs("bob", BOB_CHAT, 2);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const pass = (script: ReturnType<typeof scriptedTelegram>) =>
    bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => ORIGIN } });
  const placed = (id: string, title: string) => {
    store.createTask({ id, title }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO, {}, now);
    return ref;
  };
  /** One attempt that saves a result: its run-finished fact is the "finished" update. */
  const built = (ref: number) => {
    const lease = `lease-${++serial}`;
    const took = acquire(store, ref, RUNNER, { now, token: `tok-${RUNNER}`, newLeaseId: () => lease, ttlMs: TTL });
    if (!took.ok) throw new Error(`claim refused: ${took.reason}`);
    const run = store.startRun({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "so/t", worktree: "/pool/t", ...legacy, now });
    store.finishRun(run, { outcome: "built", committed: true, now });
    expect(finalize(store, lease, { kind: "complete", state: "done", now: now }).ok).toBe(true);
    return run;
  };

  test("c1: nobody is told about their own completion, cancel or approval — the lead acting for them included; others still are", async () => {
    const script = scriptedTelegram();
    const done = placed("ship-notes-7", "Ship the release notes");
    const dropped = placed("old-banner-8", "Remove the old banner");
    const approved = placed("tidy-docs-9", "Tidy the docs");
    await pass(script);
    script.reset();

    // A result is saved, then alex marks it complete before the bridge comes round: alex hears nothing about it.
    now = at(10_000);
    built(done);
    // Marking a result complete (console, chat or CLI) records the person's act; the worker already closed the claim.
    withActor({ account: "alex", lead: false }, () => store.noteTaskAct(done, "completed", now));
    // alex cancels one task; alex's lead token approves another (it acts as alex).
    withActor({ account: "alex", lead: false }, () => store.cancelTask("old-banner-8", now, "No longer needed"));
    withActor({ account: "alex", lead: true }, () => {
      store.noteTaskAct(approved, "approved", now);
      store.enqueueNotification({ dedupeKey: "approved:tidy-docs-9", kind: "scope-approved", subject: "Approved", body: "Approved by the lead.", source: { taskRef: approved } }, now);
    });
    await pass(script);
    await pass(script);
    // No new message reaches alex; the tasks' one silent card may only be repainted.
    expect(script.pings(ALEX_CHAT)).toEqual([]);
    expect(script.shown(ALEX_CHAT).join("\n")).not.toMatch(/Ship the release notes needs|is ready|Approved|Cancelled|Marked complete/);
    expect(store.settledBy(done)).toBe("alex");
    expect(store.settledBy(dropped)).toBe("alex");
    // bob is told: the finished work pings once.
    expect(script.pings(BOB_CHAT)).toHaveLength(1);
    expect(String(script.pings(BOB_CHAT)[0]!.params["text"])).toContain("Ship the release notes");
    // A later fact on a task alex settled still says nothing to alex.
    now = at(20_000);
    store.enqueueNotification({ dedupeKey: "late:ship-notes-7", kind: "attempts-exhausted", pushClass: "attention", subject: "Late fact", body: "fixture", source: { taskRef: done } }, now);
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toEqual([]);
    expectClean([...script.shown(ALEX_CHAT), ...script.shown(BOB_CHAT)], "bob", ["ship-notes-7", "old-banner-8", "tidy-docs-9"]);
  });

  test("c2: a lone failure that no batch line can read still sends a new message", async () => {
    const script = scriptedTelegram();
    const stuck = placed("payout-18", "Guard the payout path — revision");
    await pass(script);
    script.reset();
    now = at(10_000);
    store.enqueueNotification({ dedupeKey: "exhausted:payout-18", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-18 stalled after 3 straight failures",
      body: "The last attempt failed its checks.", source: { taskRef: stuck } }, now);
    // Its task reads as no batch line (its placement is unknown to the batch view): the update still goes out.
    const refById = store.refById.bind(store);
    vi.spyOn(store, "refById").mockImplementation(id => { const ref = refById(id); return ref !== null && id === stuck ? { ...ref, repo: null } : ref; });
    expect(finishedView(store, { items: [{ taskRef: stuck, run: null, notification: store.listNotifications("all").find(row => row.kind === "attempts-exhausted")!.id }] }, now, dir, "alex")).toBeNull();
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toHaveLength(1);
    expect(String(script.pings(ALEX_CHAT)[0]!.params["text"])).toContain("stalled after 3 straight failures");
    expectClean(script.shown(ALEX_CHAT), "alex", ["payout-18"]);
  });

  test("c1: a security alert always pings, even about a task the reader settled, a release check or a replaced task", async () => {
    const script = scriptedTelegram();
    const check = placed("release-check-15", "Release check for 0.9.9");
    await pass(script);
    script.reset();
    now = at(10_000);
    const run = built(check);
    store.handle.prepare("INSERT INTO run_check (run, release, recorded_at) VALUES (?, 1, ?)").run(run, now.toISOString());
    withActor({ account: "alex", lead: false }, () => store.noteTaskAct(check, "completed", now));
    expect(store.neverPings(check)).toBe(true);
    expect(store.settledBy(check)).toBe("alex");
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toEqual([]);
    withActor({ account: "alex", lead: false }, () => store.enqueueNotification({ dedupeKey: "secret:release-check-15", kind: "secret-detected", pushClass: "attention",
      subject: "A secret was found in saved evidence", body: "It was withheld. Rotate the key.", source: { taskRef: check } }, now));
    const fact = store.listNotifications("all").find(row => row.kind === "secret-detected")!;
    expect(store.pingAllowed(fact, "alex")).toBe(true);
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toHaveLength(1);
    expect(String(script.pings(ALEX_CHAT)[0]!.params["text"])).toContain("A secret was found in saved evidence");
  });

  test("c1: settling older work never silences a newer revision: its failure still reaches the person", async () => {
    const script = scriptedTelegram();
    const base = placed("search-16", "Search ignores accents");
    withActor({ account: "alex", lead: false }, () => store.noteTaskAct(base, "completed", now));
    expect(store.settledBy(base)).toBe("alex");
    now = at(60_000);
    const revision = placed("search-17", "Search ignores accents — revision");
    store.handle.prepare("UPDATE task_ref SET revision_of = ? WHERE id = ?").run("search-16", revision);
    expect(store.settledBy(revision)).toBeNull();
    await pass(script);
    script.reset();
    now = at(90_000);
    store.enqueueNotification({ dedupeKey: "exhausted:search-17", kind: "attempts-exhausted", pushClass: "attention", subject: "search-17 stalled after 3 straight failures",
      body: "fixture", source: { taskRef: revision } }, now);
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toHaveLength(1);
    expectClean(script.shown(ALEX_CHAT), "alex", ["search-16", "search-17"]);
    // Completing the revision (recorded on its root, after it was filed) settles it for alex.
    now = at(120_000);
    withActor({ account: "alex", lead: false }, () => store.noteTaskAct(base, "completed", now));
    expect(store.settledBy(revision)).toBe("alex");
  });

  test("release checks and replaced tasks never ping", async () => {
    const script = scriptedTelegram();
    const check = placed("release-check-12", "Release check for 0.9.9");
    const replaced = placed("release-099", "Release 0.9.9");
    placed("release-099b", "Release 0.9.9 again");
    await pass(script);
    script.reset();
    // The release check's run carries the release flag; its result is quiet.
    now = at(10_000);
    const run = built(check);
    store.handle.prepare("INSERT INTO run_check (run, release, recorded_at) VALUES (?, 1, ?)").run(run, now.toISOString());
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toEqual([]);
    // A replaced task is quiet: no "Stopped · Release 0.9.9 … Replaced by release-099b".
    expect(withActor({ account: "bob", lead: false }, () => store.setTaskState("release-099", "cancelled", now, {}, "Replaced", "release-099b"))).toMatchObject({ ok: true });
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toEqual([]);
    expect(store.neverPings(replaced)).toBe(true);
    expect(store.neverPings(check)).toBe(true);
    expectClean(script.shown(ALEX_CHAT), "alex", ["release-check-12", "release-099"]);
  });

});

describe("chat voice on Slack (the shared path Discord and Teams use)", () => {
  let dir: string;
  let store: Store;
  let now: Date;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-chat-voice-slack-"));
    store = openStore(join(dir, "state.db"));
    now = T0;
    expect(addApprover(store, "alex", now).ok).toBe(true);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  test("c2: a lone failure that no batch line can read still gets its own post", async () => {
    const identity = { installation: "installation-test", team: "TTEST", app: "ATEST", bot: "UBOT", workspace: "Test workspace" };
    const state = new ChatState(store, "slack");
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    let ts = 100;
    const api: SlackApi = vi.fn(async (method, args = {}) => {
      calls.push({ method, args });
      if (method === "users.info") return { user: { id: "UTEST", team_id: "TTEST", deleted: false, is_bot: false } };
      if (method === "conversations.info") return { channel: { id: "DTEST", is_im: true, user: "UTEST" } };
      if (method === "chat.postMessage") return { ts: `1789700000.${String(ts++).padStart(6, "0")}` };
      if (method === "chat.update") return { ts: args["ts"] };
      return {};
    });
    const options: SlackChatOptions = { store, identity, api, owner: "test", readProjects: async () => [REPO], evidenceRoot: join(dir, "evidence"), current: () => true, origin: () => ORIGIN, clock: () => now };
    state.lease(identity.installation, "test", T0);
    const pairing = state.pairing(identity.installation, "alex", store.accountOf("alex")!.generation, T0);
    expect(state.pair(identity, chatHash(pairing), "UTEST", "DTEST", T0)).not.toBeNull();
    const pass = async () => {
      state.lease(identity.installation, "test", now);
      await planSlackNotifications(options);
      for (let i = 0; i < 40 && (await deliverSlackPart(options)); i++);
    };
    now = at(1_000);
    store.createTask({ id: "payout-20", title: "Guard the payout path — revision" }, now);
    const ref = store.refFor("built-in", "payout-20").id;
    store.placeTask(ref, REPO, {}, now);
    await pass();
    const before = calls.length;
    now = at(10_000);
    store.enqueueNotification({ dedupeKey: "exhausted:payout-20", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-20 stalled after 3 straight failures",
      body: "fixture", source: { taskRef: ref } }, now);
    const refById = store.refById.bind(store);
    vi.spyOn(store, "refById").mockImplementation(id => { const one = refById(id); return one !== null && id === ref ? { ...one, repo: null } : one; });
    await pass();
    const posts = calls.slice(before).filter(call => call.method === "chat.postMessage").map(call => String(call.args["text"]));
    expect(posts.some(text => text.includes("stalled after 3 straight failures"))).toBe(true);
    expectClean(posts, "alex", ["payout-20"]);
  });
});
