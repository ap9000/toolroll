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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { acquire, completeFenced } from "./claim.js";
import { withActor } from "./actor.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { verifyApproverStanding } from "./principal.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { finishedView, quietCardView } from "./chat-quiet.js";
import { bridgePass, followBridge, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import { deliverSlackPart, planSlackNotifications, type SlackChatOptions } from "./slack-chat.js";
import type { SlackApi } from "./slack-api.js";
import { batchLine, BOT_NAME, chatText, nameTelegramBot, shortTitle } from "./chat-voice.js";
import { notifyVersionLive, RUNNER_VERSIONS_FILE } from "./releases.js";

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
  ["chat-voice-4", "Chat reads like a teammate"],
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

describe("short human titles and plain chat words", () => {
  test("titles drop \"— revision\" and ids and stay within 60 characters", () => {
    expect(shortTitle("Faster tests — revision", "faster-tests-2")).toBe("Faster tests");
    // Only real task ids go: another task's id when the store knows it, and the task's own.
    expect(shortTitle("Release 0.9.9: lighter tests (release-099b)", "release-099", token => token === "release-099b")).toBe("Release 0.9.9: lighter tests");
    expect(shortTitle("Release 0.9.9: lighter tests (release-099b)", "release-099")).toBe("Release 0.9.9: lighter tests (release-099b)");
    // Words with digits are words: node-20, utf-8, v2, 0.9.9.
    expect(shortTitle("Move CI to node-20 and read utf-8 names", "ci-node-3")).toBe("Move CI to node-20 and read utf-8 names");
    expect(shortTitle("Ship v2 of the API (ci-node-3)", "ci-node-3", () => false)).toBe("Ship v2 of the API");
    expect(shortTitle("Stop charging tax twice at checkout (fix-checkout-tax)", "fix-checkout-tax")).toBe("Stop charging tax twice at checkout");
    expect(shortTitle("Fix login—revision 2")).toBe("Fix login");
    expect(shortTitle("Pre-revision checks stay")).toBe("Pre-revision checks stay");
    expect(shortTitle("Tidy the changelog", "tidy")).toBe("Tidy the changelog");
    expect(shortTitle("release-099b", "release-099b")).toBe("Release 099b");
    const long = shortTitle("Make the evening digest group finished work by project and explain every failure in plain words");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });

  test("pushed words never carry the task id, a revision suffix or \"Replaced by <id>\"", () => {
    expect(chatText("Release 0.9.9 — revision\nReplaced by release-099b.", ["release-099"])).toBe("Release 0.9.9\nReplaced by a newer task.");
    expect(chatText("alpha-1 stalled after 3 straight failures", [{ id: "alpha-1", title: "Guard the payout path" }])).toBe("Guard the payout path stalled after 3 straight failures");
    expect(chatText("keep it tidy", ["tidy"])).toBe("keep it tidy");
  });

  test("one finished task is one or two short sentences, outcome first; several are one line with the names", () => {
    const fact = (summary: string, headline = "Ready for review", checks: "passed" | "failed" | null = "passed") => ({ summary, headline, checks, report: false, completedBy: null });
    expect(batchLine([fact("Search now ignores accents")])).toBe("Search now ignores accents is ready. Your tests passed. Accept and finish it?");
    expect(batchLine([{ ...fact("Search now ignores accents"), pullRequest: true }])).toBe("Search now ignores accents is ready. Your tests passed. Merge it?");
    // The lead says "I" for what it did.
    expect(batchLine([{ ...fact("Search now ignores accents"), lead: true, pullRequest: true }])).toBe("I finished search now ignores accents. Your tests passed. Merge it?");
    expect(batchLine([{ ...fact("Faster tests", "Failed", "failed"), lead: true }])).toBe("I built faster tests, but its tests failed. It waits for you: retry or ask for changes.");
    expect(batchLine([{ ...fact("Faster tests", "Complete", null), lead: true, completedBy: "alex" }])).toBe("I marked faster tests complete.");
    // Updates that are not finished work share the message too.
    const update = (summary: string, phrase: string, headline = "Needs you") => ({ ...fact(summary, headline, null), update: { words: `${summary} · words`, phrase } });
    expect(batchLine([update("Cleanup", "has a plan to review")])).toBe("Cleanup · words");
    expect(batchLine([fact("Faster tests"), update("Cleanup", "has a plan to review"), update("Accents", "failed", "Failed")]))
      .toBe("3 updates: faster tests is ready, cleanup has a plan to review, accents failed.\nAccents stopped before it finished, and 1 needs your decision; they wait for you.");
    expect(batchLine([fact("Faster tests", "Failed", "failed")])).toBe("Faster tests is built, but its tests failed. It waits for you: retry or ask for changes.");
    expect(batchLine([fact("Faster tests"), fact("Cleanup"), fact("Search ignores accents"), fact("API keys rotate")]))
      .toBe("4 tasks finished: faster tests, cleanup, search ignores accents, …");
    expect(batchLine([fact("Faster tests"), fact("Cleanup", "Failed", "failed")])).toBe("2 tasks finished: faster tests, cleanup.\nTests failed on cleanup; it waits for you.");
  });
});

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
    expect(completeFenced(store, lease, "done", now).ok).toBe(true);
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

  test("c2: six completions within two minutes are one message, edited in place as it grows; a seventh later starts a new one", async () => {
    const script = scriptedTelegram();
    const refs = SIX.map(([id, title]) => placed(id, title));
    await pass(script);
    for (const [index, ref] of refs.entries()) {
      now = at(index * 20_000);
      built(ref);
      await pass(script);
    }
    // One silent card for the six tasks filed together, and exactly one finished-work message.
    const pings = script.pings(ALEX_CHAT);
    expect(pings).toHaveLength(1);
    const batch = script.sentId(pings[0]!);
    const latest = script.current(ALEX_CHAT, batch);
    expect(String(latest.params["text"])).toMatch(/^6 tasks finished: faster tests, cleanup of the old status words, search ignores accents, …/);
    expect(script.buttons(latest)).toEqual([{ text: "Open", url: `${ORIGIN}/tasks` }]);
    expect(script.calls.filter(call => call.method === "editMessageText" && call.params["message_id"] === batch).length).toBeGreaterThanOrEqual(5);
    // Every receipt is settled: nothing is waiting to be re-sent.
    const binding = store.liveTelegramBindingFor(BOT, String(ALEX_CHAT))!;
    expect(store.telegramDeliveries(binding).filter(row => row.kind === "run-finished").every(row => row.deliveredAt !== null)).toBe(true);

    // Outside the window, the next finished task is its own message, and it says what happened.
    now = at(5 * 60_000);
    const seventh = placed("export-btn-10", "Rename the export button — revision");
    await pass(script);
    now = at(6 * 60_000);
    built(seventh);
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toHaveLength(2); // the six's one message, then the seventh's own line (its card is silent)
    const last = script.pings(ALEX_CHAT).at(-1)!;
    expect(String(last.params["text"])).toMatch(/^Rename the export button /);
    expect(script.buttons(last)[0]).toMatchObject({ text: "Open result" });
    expectClean(script.shown(ALEX_CHAT), "alex", [...SIX.map(one => one[0]), "export-btn-10"]);
  });

  /** A saved result whose tests passed, Ready for a person. */
  const readyResult = (id: string, title: string) => {
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", now);
    const ref = placed(id, title);
    propose(store, { taskId: id, goal: title, touches: ["src/guard.ts"], acceptance: [{ id: "c1", statement: "The guard stays readable.", how: null, evidence: ["check"] }], now });
    expect(approve(store, id, "alex", now, store.getScope(id)!.digest, alexToken).ok).toBe(true);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route fixture");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: RUNNER, branch: `so/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "The guard reads well." });
    store.finishRun(run, { outcome: "built", committed: true, now });
    store.setTaskState(id, "done", now);
    store.saveProofVerdict(run, "verified", [], now, [{ id: "c1", statement: "The guard stays readable.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, now);
    storeEvidence(store, dir, run, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", now, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, run, "a".repeat(40), store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, now);
    return { ref, run };
  };

  test("c3: a result the reader marked complete never says \"Marked complete by\" them; anyone else still reads who did", () => {
    const { ref, run } = readyResult("ready-11", "Keep the guard readable — revision");
    const who = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!who.ok) throw new Error("approver fixture");
    const receipt = assignmentOf(store, "ready-11", now, { principal: "operator", repos: [REPO] }, dir)!.receipt!;
    // The console's door, with no command actor: the act is still recorded as alex's.
    expect(checkAssignmentAsOperator(store, "ready-11", receipt.digest, who.who, now, dir).ok).toBe(true);
    expect(store.settledBy(ref)).toBe("alex");

    const forAlex = telegramProgressCard(store, store.getRun(run)!, "ready-11", REPO, now, dir, "alex");
    const forBob = telegramProgressCard(store, store.getRun(run)!, "ready-11", REPO, now, dir, "bob");
    expect(forAlex.text).toContain("✅ Complete\nMarked complete.");
    expect(forBob.text).toContain("Marked complete by alex.");
    const card = quietCardView(store, [ref], now, dir, "alex")!;
    expectClean([forAlex.text, card.text], "alex", ["ready-11"]);
    expect(card.text.split("\n")[0]).toBe("Keep the guard readable");
    // And alex's chat is not pinged about it at all.
    const fact = store.listNotifications("all").find(row => row.taskRef === ref && row.kind === "run-finished")!;
    expect(store.pingAllowed(fact, "alex")).toBe(false);
    expect(store.pingAllowed(fact, "bob")).toBe(true);
  });

  test("a ready result offers its real next step and a look first: [Accept and finish] or, with a pull request, [Merge]", async () => {
    const script = scriptedTelegram();
    await pass(script);
    script.reset();
    const { ref, run } = readyResult("guard-12", "Keep the guard readable");
    await pass(script);
    const pings = script.pings(BOB_CHAT);
    expect(pings).toHaveLength(1);
    expect(String(pings[0]!.params["text"])).toBe("Keep the guard readable is ready. Your tests passed. Accept and finish it?");
    // Accept and finish and Request changes act in place (chat-decide.ts); Look first stays a link.
    expect(script.buttons(pings[0]!).map(one => ({ text: one.text, url: one.url ?? null }))).toEqual([
      { text: "Accept and finish", url: null },
      { text: "Request changes", url: null },
      { text: "Look first", url: `${ORIGIN}/chat?task=guard-12&result=${run}&tab=changes` },
    ]);
    // An open pull request: the ask is "Merge it?", and [Merge] opens the task's merge control.
    vi.spyOn(store, "publicationForRun").mockReturnValue({ state: "opened", prNumber: 3, prUrl: "https://github.com/o/r/pull/3", remoteState: "OPEN" } as never);
    const view = finishedView(store, { items: [{ taskRef: ref, run, notification: null }] }, now, dir, "bob")!;
    expect(view.text).toBe("Keep the guard readable is ready. Your tests passed. Merge it?");
    expect([view.link, ...(view.also ?? [])].map(one => one.label)).toEqual(["Merge", "Look first"]);
    expect(view.link.path).toBe("/t/guard-12#merge");
    vi.restoreAllMocks();
  });

  test("c2: any updates within two minutes share one message — a lone failure goes out as before, then finished work joins it", async () => {
    const script = scriptedTelegram();
    const stuck = placed("payout-13", "Guard the payout path — revision");
    const notes = placed("notes-14", "Ship the release notes");
    await pass(script);
    now = at(10_000);
    store.enqueueNotification({ dedupeKey: "exhausted:payout-13", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-13 stalled after 3 straight failures",
      body: "The last attempt failed its checks.", source: { taskRef: stuck } }, now);
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toHaveLength(1);
    const first = script.pings(ALEX_CHAT)[0]!;
    expect(String(first.params["text"])).toContain("Guard the payout path stalled after 3 straight failures");
    now = at(70_000);
    built(notes);
    await pass(script);
    // Still one message: it now says both, edited in place.
    expect(script.pings(ALEX_CHAT)).toHaveLength(1);
    const latest = String(script.current(ALEX_CHAT, script.sentId(first)).params["text"]);
    expect(latest).toMatch(/^2 updates: guard the payout path failed, ship the release notes needs you\.\n/);
    expect(latest).toContain("Guard the payout path stopped before it finished");
    expectClean(script.shown(ALEX_CHAT), "alex", ["payout-13", "notes-14"]);
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

  test("c2: while a lone update is still the only item, its edit keeps that update's own button", async () => {
    const script = scriptedTelegram();
    const stuck = placed("payout-19", "Guard the payout path");
    await pass(script);
    script.reset();
    now = at(10_000);
    store.enqueueNotification({ dedupeKey: "exhausted:payout-19", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-19 stalled after 3 straight failures",
      body: "fixture", source: { taskRef: stuck }, link: "/t/payout-19#retry" }, now);
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toHaveLength(1);
    const first = script.pings(ALEX_CHAT)[0]!;
    const own = script.buttons(first);
    expect(own).toHaveLength(1);
    now = at(40_000);
    store.enqueueNotification({ dedupeKey: "exhausted:payout-19:2", kind: "attempts-exhausted", pushClass: "attention", subject: "payout-19 stalled again",
      body: "fixture", source: { taskRef: stuck }, link: "/t/payout-19#retry" }, now);
    await pass(script);
    expect(script.pings(ALEX_CHAT)).toHaveLength(1);
    const edits = script.calls.filter(call => call.method === "editMessageText" && String(call.params["chat_id"]) === String(ALEX_CHAT));
    expect(edits).toHaveLength(1);
    expect(String(edits[0]!.params["text"])).toContain("stalled again");
    expect(script.buttons(edits[0]!)).toEqual(own);
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

  test("c4: pairing names the bot Toolroll; on upgrade a bot still called StandingOrders is renamed once, any other name is kept", async () => {
    const script = scriptedTelegram();
    // Pairing through the bot: "/pair <code>" in a private chat. One live pairing per person on a bot, as in every
    // chat app: alex moves to this new chat after unpairing the old one.
    store.unpairTelegram(BOT, "alex", now);
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
    let queued = true;
    const pairing: TelegramTransport = async (method, params) => {
      if (method !== "getUpdates" || !queued) return script.transport(method, params);
      queued = false;
      return { ok: true, result: [{ update_id: 90, message: { message_id: 1, chat: { id: 6464, type: "private" }, from: { id: 6464 }, text: `/pair ${code}` } }] };
    };
    const paired = await bridgePass(store, { botId: BOT, transport: pairing, clock: () => now, readProjects: async () => [REPO] });
    expect(paired).toMatchObject({ ok: true, report: { paired: 1 } });
    expect(script.name()).toBe(BOT_NAME);
    expect(script.calls.filter(call => call.method === "setMyName")).toEqual([{ method: "setMyName", params: { name: "Toolroll" } }]);

    // Upgrade: the follower renames only the old name.
    script.rename("StandingOrders");
    expect(await nameTelegramBot(script.transport, "upgrade")).toBe(true);
    expect(script.name()).toBe("Toolroll");
    expect(await nameTelegramBot(script.transport, "upgrade")).toBe(false);
    script.rename("Our build bot");
    expect(await nameTelegramBot(script.transport, "upgrade")).toBe(false);
    expect(script.name()).toBe("Our build bot");

    // The long-running follower does it once at start, beside the "/" menu.
    script.rename("Standing Orders");
    script.reset();
    const stop = new AbortController();
    const followed = followBridge(store, { botId: BOT, transport: async (method, params) => {
      const answer = await script.transport(method, params);
      if (method === "getUpdates") stop.abort();
      return answer;
    }, clock: () => now, signal: stop.signal, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => ORIGIN } });
    await followed;
    expect(script.name()).toBe("Toolroll");
    expect(script.calls.filter(call => call.method === "setMyName")).toHaveLength(1);
    // A refused or failing call never blocks anything.
    expect(await nameTelegramBot(async () => { throw new Error("offline"); }, "pairing")).toBe(false);
  });

  test("a deploy sends one \"is live\" line to each operator, once per version; a fresh install is not news", async () => {
    expect(notifyVersionLive(store, dir, "0.9.9", now)).toBe(0);
    writeFileSync(join(dir, RUNNER_VERSIONS_FILE), JSON.stringify([{ runner: RUNNER, version: "0.9.8", at: T0.toISOString() }]));
    writeFileSync(join(dir, "latest-release.json"), JSON.stringify({ checkedAt: T0.toISOString(), release: { version: "0.9.9", notes: "## Release 0.9.9: lighter tests, cleaner status\n\n- more", url: "https://example.invalid", security: false } }));
    const queued = notifyVersionLive(store, dir, "0.9.9", now);
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(notifyVersionLive(store, dir, "0.9.9", now)).toBe(0);
    const script = scriptedTelegram();
    await pass(script);
    const lines = script.shown(ALEX_CHAT).filter(text => text.includes("is live"));
    expect(lines).toEqual(["Toolroll 0.9.9 is live: lighter tests, cleaner status."]);
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

  test("c1, c2, c3: six results in two minutes are one post edited in place, own completions say nothing, and no text carries an id", async () => {
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
    const refs = SIX.map(([id, title]) => {
      store.createTask({ id, title }, now);
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, REPO, {}, now);
      return ref;
    });
    await pass();
    for (const [index, ref] of refs.entries()) {
      now = at(2_000 + index * 20_000);
      const run = store.startRun({ taskRef: ref, leaseId: `l-${index}`, runner: RUNNER, branch: "so/t", worktree: "/pool/t", ...legacy, now });
      store.finishRun(run, { outcome: "built", committed: true, now });
      await pass();
    }
    const posts = calls.filter(call => call.method === "chat.postMessage");
    // The tasks' one shared card, then one finished-work post.
    expect(posts).toHaveLength(2);
    const batchTs = "1789700000.000101";
    const batchEdits = calls.filter(call => call.method === "chat.update" && call.args["ts"] === batchTs);
    expect(batchEdits.length).toBeGreaterThanOrEqual(5);
    expect(String(batchEdits.at(-1)!.args["text"])).toMatch(/^6 tasks finished: faster tests, /);
    // alex completes one in the console: nothing new in alex's chat.
    const before = calls.length;
    now = at(200_000);
    withActor({ account: "alex", lead: false }, () => store.setTaskState("faster-tests-2", "done", now));
    await pass();
    expect(calls.slice(before).filter(call => call.method === "chat.postMessage" || call.method === "chat.update")).toEqual([]);
    // Updates that are not finished work batch too: two failures a few seconds apart are one post, edited in place.
    now = at(400_000);
    store.enqueueNotification({ dedupeKey: "exhausted:accents-3", kind: "attempts-exhausted", pushClass: "attention", subject: "accents-3 stalled after 3 straight failures",
      body: "fixture", source: { taskRef: refs[2]! } }, now);
    await pass();
    now = at(430_000);
    store.enqueueNotification({ dedupeKey: "exhausted:gallery-6", kind: "attempts-exhausted", pushClass: "attention", subject: "gallery-6 stalled after 3 straight failures",
      body: "fixture", source: { taskRef: refs[5]! } }, now);
    await pass();
    const later = calls.slice(before).filter(call => call.method === "chat.postMessage");
    expect(later).toHaveLength(1);
    const edits = calls.slice(before).filter(call => call.method === "chat.update" && call.args["ts"] === "1789700000.000102");
    expect(String(edits.at(-1)!.args["text"])).toMatch(/^2 updates: search ignores accents failed, flow gallery shows sharing failed\.\n2 failed; they wait for you\.$/);
    const texts = calls.filter(call => call.method === "chat.postMessage" || call.method === "chat.update").map(call => String(call.args["text"]));
    expectClean(texts, "alex");
  });

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
