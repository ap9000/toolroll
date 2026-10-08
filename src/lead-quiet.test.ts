/**
 * Pings follow responsibility. The lead (an agent holding a lead token its
 * person minted) acts as "lead for <owner>": the work it files, approves,
 * cancels or completes pings nobody unless it hands the task to a person,
 * the task fails with nothing left for the lead to try, or there is a
 * security alert. Nobody is pinged about their own act. A cancellation with
 * a successor reads "Replaced by <id>", never "Cancelled". A person can mute
 * a project's pings; the console and the evening digest keep it. The CLI is
 * the real command; Telegram is scripted; nothing live is claimed.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { acquire, finalize } from "./claim.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { eveningDigestText, quietCardView } from "./chat-quiet.js";
import { chatControlHref } from "./chat-controls.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { assignmentOf } from "./assignment.js";
import { assignmentStatusFacts, taskStatusOf } from "./task-status.js";
import { workIndexPage } from "./work-index.js";
import { runOperate } from "./operate.js";
import { withActor } from "./actor.js";

const T0 = new Date("2026-09-30T09:00:00.000Z");
const BOT = "777000";
const ALEX_CHAT = 4242, BOB_CHAT = 5151;
const REPO = "/projects/alpha";
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
  /** Every message (new or edited) one chat was shown. */
  const shown = (chat: number) => calls.filter(call => (call.method === "sendMessage" || call.method === "editMessageText") && String(call.params["chat_id"]) === String(chat));
  const texts = (chat: number) => shown(chat).map(call => String(call.params["text"]));
  const buttons = (call: { params: Record<string, unknown> }) =>
    ((call.params["reply_markup"] as { inline_keyboard?: { text: string; url?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
  return { transport, calls, shown, texts, buttons, reset: () => { calls.length = 0; } };
}

describe("pings follow responsibility", () => {
  let dir: string;
  let db: string;
  let store: Store;
  let now: Date;
  let lines: string[] = [];
  let alexPassword = "";
  let serial = 0;

  const cli = async (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    const code = await runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
    return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
  };
  const pair = (approver: string, chat: number, user: string, update: number) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver, by: approver, ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(chat), userId: user, updateId: update }, now).ok).toBe(true);
  };
  const pass = (script: ReturnType<typeof scriptedTelegram>) =>
    bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => "https://console.example" } });
  const ref = (id: string) => store.refFor("built-in", id).id;
  const mintLead = async () => {
    const minted = await cli(["lead", "token", "--as", "alex", "--token", alexPassword, "--json"]);
    expect(minted.code).toBe(0);
    return String(minted.body["token"]);
  };
  /** One attempt that finishes with a saved result, as a worker would record it. */
  const finishAttempt = (taskRef: number) => {
    const lease = `lease-${++serial}`;
    const took = acquire(store, taskRef, RUNNER, { now, token: `tok-${RUNNER}`, newLeaseId: () => lease, ttlMs: TTL });
    if (!took.ok) throw new Error(`claim refused: ${took.reason}`);
    const run = store.startRun({ taskRef, leaseId: lease, runner: RUNNER, branch: "so/t", worktree: "/pool/t", ...legacy, now });
    store.finishRun(run, { outcome: "built", committed: true, now });
    expect(finalize(store, lease, { kind: "complete", state: "done", now: now }).ok).toBe(true);
    return run;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-lead-quiet-"));
    db = join(dir, "orders.db");
    store = openStore(db);
    now = T0;
    serial = 0;
    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("bootstrap failed");
    const bob = addApprover(store, "bob", now, { name: "alex", token: alex.token });
    if (!bob.ok) throw new Error("bootstrap failed");
    alexPassword = alex.token;
    register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now, newToken: () => `tok-${RUNNER}` });
    store.upsertProject(REPO, "alpha", now);
    pair("alex", ALEX_CHAT, "31337", 1);
    pair("bob", BOB_CHAT, "31338", 2);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("c1: the lead token is minted behind the password and recorded as \"lead for <owner>\"; a lead cannot mint one", async () => {
    expect((await cli(["lead", "token", "--as", "alex", "--token", "wrong", "--json"])).body).toMatchObject({ ok: false, reason: "unauthenticated" });
    const token = await mintLead();
    expect(token).toMatch(/^lt_[a-f0-9]{12}_/);
    expect(store.actionLedger({ repos: null, instance: true }).find(one => one.action === "lead token created")).toMatchObject({ actor: "alex", detail: "lead for alex" });
    expect((await cli(["lead", "token", "--token", token, "--json"])).body).toMatchObject({ ok: false, reason: "refused" });
    // The token is for single commands, never a service, and a bad one is refused rather than ignored.
    expect((await cli(["serve", "--token", token, "--json"])).body).toMatchObject({ ok: false, reason: "usage" });
    expect((await cli(["task", "add", "x", "--token", "lt_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "--json"])).body).toMatchObject({ ok: false, reason: "unauthenticated" });
    // A new token replaces the old; --revoke ends it.
    const second = await mintLead();
    expect((await cli(["task", "list", "--token", token, "--json"])).body).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect((await cli(["lead", "token", "--revoke", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: true, revoked: 1 });
    expect((await cli(["task", "list", "--token", second, "--json"])).body).toMatchObject({ ok: false, reason: "unauthenticated" });
  });

  test("c1: work the lead files, approves, cancels or completes pings no person; the console and ledger keep it as the lead's", async () => {
    const token = await mintLead();
    const script = scriptedTelegram();
    store.setNotificationPreference("bob", { mode: "all" }, "bob", now);
    // The live case: a release check filed, built, then re-filed as "b" — the lead's own housekeeping.
    expect((await cli(["task", "add", "Release 0.9.7", "--id", "release-097", "--repo", REPO, "--token", token, "--json"])).code).toBe(0);
    finishAttempt(ref("release-097"));
    expect((await cli(["task", "add", "Release 0.9.7b", "--id", "release-097b", "--repo", REPO, "--replaces", "release-097", "--token", token, "--json"])).code).toBe(0);
    expect((await cli(["task", "state", "release-097b", "done", "--token", token, "--json"])).code).toBe(0);
    await pass(script);
    await pass(script);
    expect(script.shown(ALEX_CHAT)).toEqual([]);
    expect(script.shown(BOB_CHAT)).toEqual([]);
    // Every fact is still recorded for the console and the evening digest.
    const facts = store.taskFactsSince(new Date(T0.getTime() - 1000).toISOString());
    expect(facts.map(one => one.kind)).toEqual(expect.arrayContaining(["task-filed", "run-finished", "task-cancelled"]));
    expect(eveningDigestText(store, "alex", now)).toContain("Release 0.9.7");
    // Acts are the lead's, in the ledger as "lead for alex".
    expect(store.taskActs(ref("release-097")).map(one => [one.act, one.lead])).toEqual([["filed", true], ["cancelled", true]]);
    expect(store.taskActs(ref("release-097b")).map(one => [one.act, one.lead])).toEqual([["filed", true], ["completed", true]]);
    expect(store.actionLedger({ repos: null, taskId: "release-097" }).filter(one => one.actor === "lead for alex").map(one => one.action).sort()).toEqual(["task cancelled", "task filed"]);
    // A lead's approval is the lead's too, and says so.
    store.createTask({ id: "person-task", title: "Person's task" }, now);
    store.placeTask(ref("person-task"), REPO, {}, now);
    withActor({ account: "alex", lead: true }, () => store.noteTaskAct(ref("person-task"), "approved", now));
    expect(store.leadWorkOf(ref("person-task"))).toBe("alex");
  });

  test("c1: the lead's work still reaches a person when handed to them, when it fails with nothing left for the lead, or for a security alert", async () => {
    const token = await mintLead();
    const script = scriptedTelegram();
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    store.setNotificationPreference("bob", { mode: "all" }, "bob", now);
    expect((await cli(["task", "add", "Release 0.9.8", "--id", "release-098", "--repo", REPO, "--token", token, "--json"])).code).toBe(0);
    const taskRef = ref("release-098");
    // A failure the lead can retry stays with the lead.
    store.enqueueNotification({ dedupeKey: "fail:1", kind: "build-failed", subject: "Build failed", body: "Attempt 1 failed; it retries.", source: { taskRef } }, now);
    await pass(script);
    expect(script.shown(ALEX_CHAT)).toEqual([]);
    // Nothing left for the lead to try: everyone who follows the project hears.
    store.enqueueNotification({ dedupeKey: "spent:1", kind: "attempts-exhausted", subject: "Out of attempts", body: "Three attempts failed.", pushClass: "attention", source: { taskRef } }, now);
    await pass(script);
    expect(script.texts(ALEX_CHAT).join("\n")).toContain("Out of attempts");
    expect(script.texts(BOB_CHAT).join("\n")).toContain("Out of attempts");
    script.reset();
    store.enqueueNotification({ dedupeKey: "secret:1", kind: "secret-detected", subject: "A secret was found", body: "Rotate it.", pushClass: "attention", source: { taskRef } }, now);
    await pass(script);
    expect(script.texts(ALEX_CHAT).join("\n")).toContain("A secret was found");
    script.reset();
    // Handed to a person: only they are asked, and from then on the task is theirs.
    expect((await cli(["task", "ask", "release-098", "--person", "bob", "--why", "Pick the deploy window", "--token", token, "--json"])).code).toBe(0);
    await pass(script);
    expect(script.texts(BOB_CHAT).join("\n")).toContain("The lead needs you: Release 0.9.8");
    expect(script.texts(BOB_CHAT).join("\n")).toContain("Pick the deploy window");
    expect(script.shown(ALEX_CHAT)).toEqual([]);
    expect(store.leadWorkOf(taskRef)).toBeNull();
    expect(store.actionLedger({ repos: [REPO], taskId: "release-098" }).find(one => one.action === "task handed to a person")).toMatchObject({ actor: "lead for alex", detail: "bob: Pick the deploy window" });
    script.reset();
    store.enqueueNotification({ dedupeKey: "fail:2", kind: "build-failed", subject: "Build failed again", body: "Attempt 2 failed.", source: { taskRef } }, now);
    await pass(script);
    expect(script.texts(BOB_CHAT).join("\n")).toContain("Build failed again");
    // Asking needs an identity, and someone who can see the project.
    expect((await cli(["task", "ask", "release-098", "--person", "bob", "--why", "x", "--json"])).body).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect((await cli(["task", "ask", "release-098", "--person", "nobody", "--why", "x", "--token", token, "--json"])).body).toMatchObject({ ok: false, reason: "unknown-person" });
  });

  test("c1: your own act never pings you: a task you cancel or complete messages the others, not you", async () => {
    const script = scriptedTelegram();
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    store.setNotificationPreference("bob", { mode: "all" }, "bob", now);
    store.createTask({ id: "tidy", title: "Tidy the changelog" }, now);
    store.placeTask(ref("tidy"), REPO, {}, now);
    await pass(script);
    script.reset();
    expect((await cli(["task", "state", "tidy", "cancelled", "--as", "alex", "--token", alexPassword, "--json"])).code).toBe(0);
    await pass(script);
    expect(script.shown(ALEX_CHAT)).toEqual([]);
    expect(script.texts(BOB_CHAT).join("\n")).toContain("Cancelled");
    // Completing in the console, chat or CLI goes through the same door with the person's name.
    store.createTask({ id: "ship", title: "Ship the notes" }, now);
    store.placeTask(ref("ship"), REPO, {}, now);
    const fact = withActor({ account: "bob", lead: false }, () => {
      store.noteTaskAct(ref("ship"), "completed", now);
      store.enqueueNotification({ dedupeKey: "done:ship", kind: "assignment-handoff", subject: "Complete", body: "Marked complete.", source: { taskRef: ref("ship") } }, now);
      return store.listNotifications("all").find(one => one.dedupeKey === "done:ship")!;
    });
    expect(store.pingAllowed(fact, "bob")).toBe(false);
    expect(store.pingAllowed(fact, "alex")).toBe(true);
  });

  test("c2: a cancellation with a successor reads \"Replaced by <id>\" with a link on the task status, \"Replaced by a newer task\" on the chat card, never \"Cancelled\"; chat is never pinged", async () => {
    const script = scriptedTelegram();
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    for (const [id, title] of [["release-096", "Release 0.9.6"], ["release-096b", "Release 0.9.6 again"]] as const) {
      store.createTask({ id, title }, now);
      store.placeTask(ref(id), REPO, {}, now);
    }
    await pass(script);
    script.reset();
    expect((await cli(["task", "state", "release-096", "queued", "--replaced-by", "release-096b", "--json"])).body).toMatchObject({ ok: false, reason: "usage" });
    expect((await cli(["task", "state", "release-096", "cancelled", "--replaced-by", "nope", "--json"])).body).toMatchObject({ ok: false, reason: "unknown-task" });
    expect((await cli(["task", "state", "release-096", "cancelled", "--replaced-by", "release-096b", "--json"])).body).toMatchObject({ ok: true, replacedBy: "release-096b" });
    expect(store.replacementOf("release-096")).toBe("release-096b");

    // Chat: a replaced task never pings (chat voice, 2026-10-02); the console keeps the fact.
    await pass(script);
    expect(script.shown(ALEX_CHAT)).toEqual([]);
    // The quiet card (one message per task) says a newer task took over and links to it, without either id.
    const card = quietCardView(store, [ref("release-096")], now)!;
    expect(card.text).toContain("Replaced by a newer task");
    expect(card.text).not.toMatch(/cancel|release-096/i);
    expect(card.link).toEqual({ label: "Open the new task", path: chatControlHref("task", "release-096b") });

    // The task page and the Tasks list read the same status, with the successor one tap away.
    expect(diagnoseTaskDispatch(store, "release-096", now)).toMatchObject({ code: "cancelled", summary: "Replaced by release-096b" });
    const assignment = assignmentOf(store, "release-096", now, { principal: "operator", repos: [REPO] }, dir)!;
    expect(assignment.detail).toBe("Replaced by release-096b.");
    expect(assignment.primaryAction).toMatchObject({ label: "Open release-096b", target: { taskId: "release-096b" } });
    const status = taskStatusOf(assignmentStatusFacts(assignment));
    expect(status.sentence).toBe("Replaced by release-096b.");
    const item = workIndexPage(store, now, { principal: "operator", repos: [REPO] }).items.find(one => one.activeTaskId === "release-096")!;
    expect(item.status.detail).toBe("Replaced by release-096b.");
    expect(item.status.label).not.toMatch(/cancel/i);
    expect(item.primaryAction).toMatchObject({ label: "Open release-096b", target: { taskId: "release-096b" } });

    // A plain cancellation still reads Cancelled.
    store.createTask({ id: "dropped", title: "Dropped idea" }, now);
    store.placeTask(ref("dropped"), REPO, {}, now);
    expect((await cli(["task", "state", "dropped", "cancelled", "--json"])).code).toBe(0);
    expect(diagnoseTaskDispatch(store, "dropped", now)?.summary).toBe("Cancelled");
  });

  test("c2: re-filing with --replaces cancels the old task as replaced", async () => {
    store.createTask({ id: "release-099", title: "Release 0.9.9" }, now);
    store.placeTask(ref("release-099"), REPO, {}, now);
    expect((await cli(["task", "add", "Release 0.9.9 again", "--id", "release-099b", "--repo", REPO, "--replaces", "nope", "--json"])).body).toMatchObject({ ok: false, reason: "unknown-task" });
    expect(store.getTask("release-099b")).toBeNull();
    expect((await cli(["task", "add", "Release 0.9.9 again", "--id", "release-099b", "--repo", REPO, "--replaces", "release-099", "--json"])).body).toMatchObject({ ok: true, replaces: "release-099" });
    expect(store.getTask("release-099")?.state).toBe("cancelled");
    expect(store.listNotifications("all").find(one => one.taskId === "release-099" && one.kind === "task-cancelled")?.subject).toBe("Replaced by release-099b");
  });

  test("c3: a project muted from the CLI sends its person no pings; the others still hear, and the console and digest keep it", async () => {
    const script = scriptedTelegram();
    store.setNotificationPreference("alex", { mode: "all", digestAt: "18:00" }, "alex", now);
    store.setNotificationPreference("bob", { mode: "all" }, "bob", now);
    expect((await cli(["notifications", "mute", "--json"])).body).toMatchObject({ ok: false, reason: "usage" });
    expect((await cli(["notifications", "mute", "--repo", "/projects/none", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: false, reason: "unknown-project" });
    expect((await cli(["notifications", "mute", "--repo", REPO, "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: true, repo: REPO, muted: true, mutedProjects: [REPO] });
    expect((await cli(["notifications", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ mutedProjects: [REPO] });
    store.createTask({ id: "docs", title: "Write the upgrade notes" }, now);
    store.placeTask(ref("docs"), REPO, {}, now);
    finishAttempt(ref("docs"));
    await pass(script);
    expect(script.shown(ALEX_CHAT)).toEqual([]);
    expect(script.texts(BOB_CHAT).join("\n")).toContain("Write the upgrade notes");
    // The console's facts and the evening digest keep the muted project.
    expect(store.taskFactsSince(new Date(T0.getTime() - 1000).toISOString()).some(one => one.taskId === "docs")).toBe(true);
    expect(eveningDigestText(store, "alex", now)).toContain("Write the upgrade notes");
    // A security alert is never muted.
    store.enqueueNotification({ dedupeKey: "secret:docs", kind: "secret-detected", subject: "A secret was found", body: "Rotate it.", pushClass: "attention", source: { taskRef: ref("docs") } }, now);
    await pass(script);
    expect(script.texts(ALEX_CHAT).join("\n")).toContain("A secret was found");
    expect((await cli(["notifications", "unmute", "--repo", REPO, "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: true, muted: false, mutedProjects: [] });
  });

  test("notifications screenshots off|first|all is each person's own choice, off by default", async () => {
    expect((await cli(["notifications", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: true, screenshots: "off" });
    expect((await cli(["notifications", "screenshots", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: false, reason: "usage" });
    expect((await cli(["notifications", "screenshots", "some", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: false, reason: "usage" });
    expect((await cli(["notifications", "screenshots", "first", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: true, screenshots: "first" });
    expect(store.notificationPreference("alex").screenshots).toBe("first");
    expect(store.notificationPreference("bob").screenshots).toBe("off");
    expect((await cli(["notifications", "screenshots", "all", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: true, screenshots: "all" });
    expect((await cli(["notifications", "screenshots", "off", "--as", "alex", "--token", alexPassword, "--json"])).body).toMatchObject({ ok: true, screenshots: "off" });
  });
});
