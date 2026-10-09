/**
 * Quiet chat: in "Only when I'm needed" (the default) a task's whole life is
 * one chat message edited in place, and a new message arrives only when a
 * person is needed — a Ready result, a failure that needs a decision. Every
 * step keeps today's per-step messages. The facts come from the real
 * mutations (placement, run admission, phases, endings, the failure path);
 * the transports are scripted, and nothing live is claimed.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { acquire, finalize } from "./claim.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import { deliverSlackPart, planSlackNotifications, type SlackChatOptions } from "./slack-chat.js";
import type { SlackApi } from "./slack-api.js";
import { enqueueEveningDigests, needsPerson } from "./chat-quiet.js";
import { runOperate } from "./operate.js";

const T0 = new Date("2026-09-30T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const BOT = "777000";
const CHAT = 4242;
const REPO = "/projects/alpha";
const ORIGIN = "https://console.example";
const RUNNER = "worker-1";
const TTL = 10 * 365 * 24 * 3600 * 1000;
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

function scriptedTelegram() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let next = 100;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") return { ok: true, result: [] };
    if (method === "sendMessage" || method === "editMessageText") return { ok: true, result: { message_id: method === "editMessageText" ? params["message_id"] : next++ } };
    return { ok: true, result: true };
  };
  const sends = () => calls.filter(call => call.method === "sendMessage");
  const edits = () => calls.filter(call => call.method === "editMessageText");
  const buttons = (call: { params: Record<string, unknown> }) =>
    ((call.params["reply_markup"] as { inline_keyboard?: { text: string; url?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
  return { transport, calls, sends, edits, buttons };
}

describe("quiet chat on Telegram", () => {
  let dir: string;
  let store: Store;
  let now: Date;
  let serial = 0;
  let token = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-quiet-chat-"));
    store = openStore(join(dir, "orders.db"));
    now = T0;
    serial = 0;
    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("bootstrap failed");
    token = alex.token;
    register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now, newToken: () => `tok-${RUNNER}` });
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: "31337", updateId: 1 }, now).ok).toBe(true);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const pass = (script: ReturnType<typeof scriptedTelegram>) =>
    bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => ORIGIN } });
  const placed = (id: string, title: string) => {
    store.createTask({ id, title }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO, {}, now);
    return ref;
  };
  const attempt = (ref: number) => {
    const lease = `lease-${++serial}`;
    const took = acquire(store, ref, RUNNER, { now, token: `tok-${RUNNER}`, newLeaseId: () => lease, ttlMs: TTL });
    if (!took.ok) throw new Error(`claim refused: ${took.reason}`);
    return { lease, run: store.startRun({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "so/t", worktree: "/pool/t", ...legacy, now }) };
  };
  /** A task's whole life: filed, started, each phase, then a saved result. */
  const lifecycle = async (script: ReturnType<typeof scriptedTelegram>) => {
    const ref = placed("status-replies", "Make status replies clear");
    await pass(script);
    const { lease, run } = attempt(ref);
    await pass(script);
    for (const phase of ["validating-handoff", "capturing-evidence", "committing"] as const) {
      now = at(serial++ * 1_000 + 5_000);
      store.setRunPhase(run, phase, now);
      await pass(script);
    }
    store.finishRun(run, { outcome: "built", committed: true, now });
    expect(finalize(store, lease, { kind: "complete", state: "done", now: now }).ok).toBe(true);
    await pass(script);
    await pass(script);
    return run;
  };

  test("c1: in quiet mode a task's whole life is one message edited in place, plus one ping when its result is Ready", async () => {
    expect(store.notificationPreference("alex").mode).toBe("quiet");
    const script = scriptedTelegram();
    const run = await lifecycle(script);

    const sends = script.sends();
    expect(sends).toHaveLength(2);
    // The card arrives silently; only the ping may buzz.
    expect(sends[0]!.params["disable_notification"]).toBe(true);
    expect(String(sends[0]!.params["text"])).toContain("Make status replies clear");
    expect(sends[1]!.params["disable_notification"]).toBeUndefined();
    // The one ping, when the result is saved: its state in the assignment's own words, and that exact result.
    // (This fixture has no approved scope, so the assignment honestly asks for a decision rather than reading Ready.)
    expect(String(sends[1]!.params["text"])).toBe("Make status replies clear needs your decision before it can continue.");
    expect(script.buttons(sends[1]!)).toEqual([{ text: "Open result", url: `${ORIGIN}/chat?task=status-replies&result=${run}` }]);
    // Every other step edited that one card (a step that reads the same as the last is not re-sent).
    const edits = script.edits();
    expect(edits.length).toBeGreaterThanOrEqual(3);
    expect(new Set(edits.map(call => call.params["message_id"]))).toEqual(new Set([100]));
    // The card's heading is the shared headline (task-status.ts): no approved scope here, so a person is needed.
    expect(String(edits.at(-1)!.params["text"]).split("\n")[1]).toBe("👋 Needs you");
    // The ledger is unchanged: every fact has its own settled receipt, and replies to the card name the task.
    const binding = store.liveTelegramBinding(BOT)!;
    expect(store.telegramDeliveries(binding).filter(row => row.taskId === "status-replies").every(row => row.deliveredAt !== null)).toBe(true);
    expect(store.telegramMessageBindings(binding, "100").map(one => one.taskId)).toContain("status-replies");
    // Nothing further to say on a quiet pass.
    const before = script.calls.length;
    await pass(script);
    expect(script.calls.slice(before).map(call => call.method)).toEqual(["getUpdates"]);
  });

  test("c2: a failed build that needs a decision pings once; the retries before it only edit the card", async () => {
    const script = scriptedTelegram();
    const ref = placed("flaky-build", "Keep the payout guard green");
    await pass(script);
    for (let strike = 1; strike <= 3; strike++) {
      now = at(strike * 3_600_000);
      const { lease, run } = attempt(ref);
      await pass(script);
      finalize(store, lease, { kind: "failure", runId: run, taskId: "flaky-build", failureClass: "unknown", message: "tests failed", worktree: "/pool/t", now });
      await pass(script);
    }
    expect(store.listNotifications("all").filter(row => row.kind === "build-failed")).toHaveLength(2);
    const sends = script.sends();
    expect(sends).toHaveLength(2);
    expect(sends[0]!.params["disable_notification"]).toBe(true);
    expect(String(sends[1]!.params["text"])).toContain("stalled after 3 straight failures");
    expect(script.edits().every(call => call.params["message_id"] === 100)).toBe(true);
  });

  test("c2: Every step behaves as before — each routine fact is its own message and no Ready ping is added", async () => {
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    const script = scriptedTelegram();
    await lifecycle(script);
    const texts = script.sends().map(call => String(call.params["text"]));
    expect(texts[0]).toContain("New task: Make status replies clear");
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts.some(text => text.includes(" · Make status replies clear"))).toBe(false);
    expect(script.sends().every(call => call.params["disable_notification"] === undefined)).toBe(true);
    // The run's own progress card is still edited in place, as it was.
    expect(script.edits().length).toBeGreaterThanOrEqual(3);
  });

  test("tasks filed within a minute share one message listing them; a later task gets its own", async () => {
    const script = scriptedTelegram();
    placed("first", "Tidy the import screen");
    now = at(20_000);
    placed("second", "Explain the empty state");
    await pass(script);
    expect(script.sends()).toHaveLength(1);
    const listed = String((script.edits().at(-1) ?? script.sends()[0]!).params["text"]);
    expect(listed).toContain("2 tasks");
    expect(listed).toContain("Tidy the import screen · Queued");
    expect(listed).toContain("Explain the empty state · Queued");
    expect(script.buttons(script.edits().at(-1) ?? script.sends()[0]!)).toEqual([{ text: "Open tasks", url: `${ORIGIN}/tasks` }]);
    now = at(180_000);
    placed("third", "Rename the export button");
    await pass(script);
    expect(script.sends()).toHaveLength(2);
    expect(String(script.sends()[1]!.params["text"])).toContain("Rename the export button");
  });

  test("the evening digest is one message a day: what finished, what failed", async () => {
    const script = scriptedTelegram();
    await lifecycle(script);
    const evening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 5);
    store.setNotificationPreference("alex", { digestAt: "20:00" }, "alex", now);
    now = new Date(evening.getTime() - 3_600_000);
    expect(enqueueEveningDigests(store, now)).toBe(0);
    now = evening;
    const before = script.sends().length;
    await pass(script);
    await pass(script);
    const digests = script.sends().slice(before);
    expect(digests).toHaveLength(1);
    expect(String(digests[0]!.params["text"])).toContain("Evening digest");
    expect(String(digests[0]!.params["text"])).toContain("Finished (1)\n• Make status replies clear");
    expect(enqueueEveningDigests(store, new Date(evening.getTime() + 60_000))).toBe(0);
  });

  test("toolroll notifications sets each person's own choice", async () => {
    store.close();
    const db = join(dir, "orders.db");
    const lines: string[] = [];
    const run = async (argv: string[]) => {
      lines.length = 0;
      const code = await runOperate("notifications", [...argv, "--as", "alex", "--token", token, "--json"], line => lines.push(line), { databaseFile: db, now: T0 });
      return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
    };
    expect((await run([])).body).toMatchObject({ ok: true, mode: "quiet", digestAt: null });
    expect((await run(["all"])).body).toMatchObject({ ok: true, mode: "all" });
    expect((await run(["digest", "18:30"])).body).toMatchObject({ ok: true, mode: "all", digestAt: "18:30" });
    expect((await run(["digest", "25:00"])).code).not.toBe(0);
    expect((await run(["quiet"])).body).toMatchObject({ ok: true, mode: "quiet", digestAt: "18:30" });
    expect((await run(["digest", "off"])).body).toMatchObject({ ok: true, digestAt: null });
    store = openStore(db);
  });
});

describe("quiet chat on Slack (shared by Discord and Teams)", () => {
  let dir: string;
  let store: Store;
  let now: Date;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-quiet-slack-"));
    store = openStore(join(dir, "state.db"));
    now = T0;
    expect(addApprover(store, "alex", now).ok).toBe(true);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  test("c1: one card edited in place and one ping when the result is Ready", async () => {
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
      for (let i = 0; i < 20 && (await deliverSlackPart(options)); i++);
    };

    now = at(1_000);
    store.createTask({ id: "status-replies", title: "Make status replies clear" }, now);
    const ref = store.refFor("built-in", "status-replies").id;
    store.placeTask(ref, REPO, {}, now);
    await pass();
    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: RUNNER, branch: "so/t", worktree: "/pool/t", ...legacy, now });
    await pass();
    for (const [index, phase] of (["validating-handoff", "capturing-evidence"] as const).entries()) {
      now = at(2_000 + index * 1_000);
      store.setRunPhase(run, phase, now);
      await pass();
    }
    store.finishRun(run, { outcome: "built", committed: true, now });
    await pass();
    await pass();

    const posts = calls.filter(call => call.method === "chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(String(posts[0]!.args["text"])).toContain("Make status replies clear");
    expect(String(posts[1]!.args["text"])).toBe("Make status replies clear needs your decision before it can continue.");
    const updates = calls.filter(call => call.method === "chat.update");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(updates.map(call => call.args["ts"]))).toEqual(new Set(["1789700000.000100"]));
  });
});

describe("what needs a person", () => {
  const row = (kind: string, extra: Partial<{ dedupeKey: string; pushClass: "attention" | "progress" | null; recipient: string | null }> = {}) =>
    ({ kind, dedupeKey: extra.dedupeKey ?? `life:${kind}:r1:1`, pushClass: extra.pushClass ?? null, recipient: extra.recipient ?? null });
  test("progress is never a ping; Ready, questions, failures that need a decision, and personal alerts are", () => {
    for (const kind of ["task-filed", "scope-approved", "run-started", "run-phase", "task-held", "review-requested"]) expect(needsPerson(row(kind)), kind).toBe(false);
    expect(needsPerson(row("check-progress", { pushClass: "progress" }))).toBe(false);
    expect(needsPerson(row("build-failed", { dedupeKey: "run:1:failed" }))).toBe(false);
    expect(needsPerson(row("run-finished"))).toBe(true);
    expect(needsPerson(row("decision", { dedupeKey: "decision:4" }))).toBe(true);
    expect(needsPerson(row("attempts-exhausted", { dedupeKey: "stalled:1", pushClass: "attention" }))).toBe(true);
    expect(needsPerson(row("auth-expired", { dedupeKey: "signin:x:alex", recipient: "alex" }))).toBe(true);
    expect(needsPerson(row("security-release", { dedupeKey: "release:security:1:alex" }))).toBe(true);
  });
});
