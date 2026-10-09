/**
 * The owner follows what their lead is doing from chat. `lead say` (lead token) posts one short message from
 * "Lead" (or the name its person gave it) in the owner's chat; another within two minutes joins it. `assignment claim` (lead token) makes a
 * task read "Lead is on it" and leaves Needs you until the lead completes it, hands it on, or two hours pass
 * with no lead act (then it is back, and says so). `toolroll status` and the console Home say what the lead is
 * doing and when it last acted. The CLI is the real command; Telegram is scripted; nothing live is claimed.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { acquire, finalize } from "./claim.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { quietCardView } from "./chat-quiet.js";
import { workIndexPage } from "./work-index.js";
import { installationStatus, renderInstallationStatus } from "./lead-status.js";
import { runOperate } from "./operate.js";
import { LEAD_IDLE_MS, agoWords, enqueueLeadLapses, leadActivity, leadActivityLine, leadClaimOf, leadSayText, leadSubjectOf } from "./lead-voice.js";
import { browserCrewOf } from "./browser-workspace.js";
import { withActor } from "./actor.js";
import { leadLapsed, leadOnIt } from "./task-status.js";

const LEAD_ON_IT = leadOnIt(), LEAD_LAPSED = leadLapsed();
import { finishedLine } from "./chat-voice.js";
import { GUIDES } from "./guides.js";

const T0 = new Date("2026-10-02T09:00:00.000Z");
const BOT = "777000";
const ALEX_CHAT = 4242, BOB_CHAT = 5151;
const REPO = "/projects/alpha";
const RUNNER = "worker-1";
const TTL = 10 * 365 * 24 * 3600 * 1000;
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };
const minutes = (n: number) => n * 60_000;

function scriptedTelegram() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let next = 100;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") return { ok: true, result: [] };
    if (method === "sendMessage" || method === "editMessageText") return { ok: true, result: { message_id: method === "editMessageText" ? params["message_id"] : next++ } };
    return { ok: true, result: true };
  };
  const shown = (chat: number) => calls.filter(call => (call.method === "sendMessage" || call.method === "editMessageText") && String(call.params["chat_id"]) === String(chat));
  return { transport, calls, shown, reset: () => { calls.length = 0; } };
}

describe("your lead tells you what it's doing", () => {
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
  /** A placed task whose one attempt failed: the task is Failed and waits for a person. */
  const failedTask = (id: string, title: string) => {
    store.createTask({ id, title }, now);
    store.placeTask(ref(id), REPO, {}, now);
    const lease = `lease-${++serial}`;
    const took = acquire(store, ref(id), RUNNER, { now, token: `tok-${RUNNER}`, newLeaseId: () => lease, ttlMs: TTL });
    if (!took.ok) throw new Error(`claim refused: ${took.reason}`);
    const run = store.startRun({ taskRef: ref(id), leaseId: lease, runner: RUNNER, branch: "so/t", worktree: "/pool/t", ...legacy, now });
    store.finishRun(run, { outcome: "failed", reason: "agent", now });
    expect(finalize(store, lease, { kind: "complete", state: "failed", now: now }).ok).toBe(true);
  };
  /** The console as `viewer` reads it: only their own lead's claim counts. */
  const operator = (viewer = "alex") => ({ principal: "operator" as const, repos: [REPO], viewer });
  const row = (id: string, viewer = "alex") => workIndexPage(store, now, operator(viewer)).items.find(one => one.activeTaskId === id)!;
  const needsYou = (viewer = "alex") => workIndexPage(store, now, operator(viewer), { view: "needs-you" }).items.map(one => one.activeTaskId);
  const failedRun = (id: string) => store.runsFor(ref(id))[0]!.id;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-lead-voice-"));
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

  test("c1: lead say posts one message from the lead in the owner's chat; a second within 2 minutes joins it", async () => {
    const token = await mintLead();
    const script = scriptedTelegram();
    // Only the lead speaks as the lead.
    expect((await cli(["lead", "say", "Fixing the release check", "--json"])).body).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect((await cli(["lead", "say", "--token", token, "--json"])).body).toMatchObject({ ok: false, reason: "usage" });

    expect((await cli(["lead", "say", "Fixing the release check", "--token", token, "--json"])).body).toMatchObject({ ok: true, joined: false });
    await pass(script);
    const first = script.shown(ALEX_CHAT);
    expect(first.map(one => one.method)).toEqual(["sendMessage"]);
    expect(String(first[0]!.params["text"])).toBe("Lead\n\nFixing the release check");
    // It is the owner's: nobody else hears it.
    expect(script.shown(BOB_CHAT)).toEqual([]);

    // A minute later: the same message, edited in place.
    script.reset();
    now = new Date(T0.getTime() + minutes(1));
    expect((await cli(["lead", "say", "Found it: a stale snapshot", "--token", token, "--json"])).body).toMatchObject({ ok: true, joined: true });
    await pass(script);
    const second = script.shown(ALEX_CHAT);
    expect(second.map(one => one.method)).toEqual(["editMessageText"]);
    expect(second[0]!.params["message_id"]).toBe(100);
    expect(String(second[0]!.params["text"])).toBe("Lead\n\nFixing the release check\nFound it: a stale snapshot");

    // Two says before the chat runs are still one message.
    script.reset();
    now = new Date(T0.getTime() + minutes(10));
    expect((await cli(["lead", "say", "Starting the docs fix", "--token", token, "--json"])).body).toMatchObject({ ok: true, joined: false });
    now = new Date(T0.getTime() + minutes(11));
    expect((await cli(["lead", "say", "Done: docs are fixed", "--token", token, "--json"])).body).toMatchObject({ ok: true, joined: true });
    await pass(script);
    expect(script.shown(ALEX_CHAT).map(one => [one.method, one.params["text"]])).toEqual([["sendMessage", "Lead\n\nStarting the docs fix\nDone: docs are fixed"]]);

    // Every say is the lead's act in the ledger, and the console's activity line reads the newest.
    expect(store.actionLedger({ repos: null, instance: true }).filter(one => one.action === "lead said").map(one => one.actor)).toEqual(Array(4).fill("lead for alex"));
    expect(leadActivity(store, "alex")).toMatchObject({ owner: "alex", doing: "Done: docs are fixed", at: now.toISOString() });
  });

  test("c1: a say about a task never shows its id, and links to the task", async () => {
    const token = await mintLead();
    const script = scriptedTelegram();
    store.createTask({ id: "release-0912", title: "Release 0.9.12" }, now);
    store.placeTask(ref("release-0912"), REPO, {}, now);
    expect((await cli(["lead", "say", "Fixing release-0912's check", "--task", "release-0912", "--token", token, "--json"])).code).toBe(0);
    expect((await cli(["lead", "say", "x", "--task", "nope", "--token", token, "--json"])).body).toMatchObject({ ok: false, reason: "unknown-task" });
    await pass(script);
    // The task's own quiet card is its own message; the lead's words are one more.
    expect(script.shown(ALEX_CHAT).map(one => String(one.params["text"]).split("\n")[0])).toEqual(["Release 0.9.12", "Lead"]);
    const sent = script.shown(ALEX_CHAT).filter(one => String(one.params["text"]).startsWith("Lead\n"));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.params["text"])).toBe("Lead\n\nFixing Release 0.9.12's check");
    const keyboard = (sent[0]!.params["reply_markup"] as { inline_keyboard: { text: string; url: string }[][] }).inline_keyboard.flat();
    expect(keyboard.map(one => one.text)).toEqual(["Open task"]);
  });

  test("c2: a task the lead claimed reads Lead is on it and leaves Needs you until done, handed over, or 2 hours idle", async () => {
    const token = await mintLead();
    failedTask("release-0912", "Release 0.9.12");
    expect(row("release-0912").status.label).toBe("Failed");
    expect(needsYou()).toEqual(["release-0912"]);

    // A coordinator claim still needs its own credential; the lead claims with its token.
    expect((await cli(["assignment", "claim", "release-0912", "--json"])).body).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect((await cli(["assignment", "claim", "nope", "--token", token, "--json"])).body).toMatchObject({ ok: false, reason: "unknown-task" });
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).body).toMatchObject({ ok: true, root: "release-0912", lead: { state: "on-it", owner: "alex" } });

    // The console: still Failed (a failure stays visible), but the lead is on it and nothing waits on the person.
    expect(row("release-0912").status).toMatchObject({ label: "Failed", detail: LEAD_ON_IT });
    expect(needsYou()).toEqual([]);
    // toolroll status: the same words, and the lead's line.
    const status = installationStatus(store, now, "alex");
    expect(status.tasks.find(one => one.task === "release-0912")).toMatchObject({ headline: "Failed", sentence: LEAD_ON_IT });
    // The chat card: "Lead is on it", never "waits for you".
    const card = quietCardView(store, [ref("release-0912")], now, undefined, "alex")!;
    expect(card.text).toContain(LEAD_ON_IT);
    expect(card.text).not.toMatch(/waits for you/i);
    expect(finishedLine({ summary: "Release 0.9.12", headline: "Failed", checks: "failed", report: false, completedBy: null, leadOnIt: true }))
      .toBe("Release 0.9.12 is built, but its tests failed. Lead is on it.");

    // A lead act keeps it the lead's: 1 h 59 min after a say about it, still on it.
    now = new Date(T0.getTime() + minutes(90));
    expect((await cli(["lead", "say", "Retrying with the fix", "--task", "release-0912", "--token", token, "--json"])).code).toBe(0);
    now = new Date(T0.getTime() + minutes(90) + LEAD_IDLE_MS - minutes(1));
    expect(needsYou()).toEqual([]);
    expect(row("release-0912").status.detail).toBe(LEAD_ON_IT);

    // Two hours with no lead act: back in Needs you, and it says so.
    now = new Date(T0.getTime() + minutes(90) + LEAD_IDLE_MS + minutes(1));
    expect(needsYou()).toEqual(["release-0912"]);
    expect(row("release-0912").status.detail.startsWith(LEAD_LAPSED)).toBe(true);
    expect(quietCardView(store, [ref("release-0912")], now, undefined, "alex")!.text).toContain(LEAD_LAPSED);

    // Claiming again takes it back; handing it to the person ends the claim at once.
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    expect(needsYou()).toEqual([]);
    expect((await cli(["task", "ask", "release-0912", "--person", "alex", "--why", "Pick the deploy window", "--token", token, "--json"])).code).toBe(0);
    expect(needsYou()).toEqual(["release-0912"]);
    expect(row("release-0912").status.detail).not.toContain("is on it");
  });

  test("c2: the lead completing the task ends its claim", async () => {
    const token = await mintLead();
    failedTask("cleanup", "Clean up old flags");
    expect((await cli(["assignment", "claim", "cleanup", "--token", token, "--json"])).code).toBe(0);
    expect(needsYou()).toEqual([]);
    expect((await cli(["task", "state", "cleanup", "done", "--token", token, "--json"])).code).toBe(0);
    expect(store.actionLedger({ repos: [REPO], taskId: "cleanup" }).map(one => one.action)).toContain("task completed");
    expect(row("cleanup").status.detail).not.toBe(LEAD_ON_IT);
  });

  test("c2: the person completing or cancelling the task ends the lead's claim, and it never repaints as back with them", async () => {
    const token = await mintLead();
    failedTask("cleanup", "Clean up old flags");
    failedTask("flags", "Drop flags");
    for (const id of ["cleanup", "flags"]) expect((await cli(["assignment", "claim", id, "--token", token, "--json"])).code).toBe(0);
    expect(needsYou()).toEqual([]);
    now = new Date(T0.getTime() + minutes(5));
    // Alex, not the lead: completes one, cancels the other.
    expect((await cli(["task", "state", "cleanup", "done", "--as", "alex", "--token", alexPassword, "--json"])).code).toBe(0);
    expect(store.actionLedger({ repos: [REPO], taskId: "cleanup" }).map(one => one.action)).not.toContain("task completed");
    expect(withActor({ account: "alex", lead: false }, () => store.cancelTask("flags", now)).ok).toBe(true);
    expect(leadClaimOf(store, "cleanup", now, "alex")).toBeNull();
    expect(leadClaimOf(store, "flags", now, "alex")).toBeNull();
    expect(row("cleanup").status.detail).not.toBe(LEAD_ON_IT);
    // Two quiet hours later neither finished task comes back to Needs you.
    now = new Date(T0.getTime() + LEAD_IDLE_MS + minutes(10));
    expect(enqueueLeadLapses(store, now)).toBe(0);
  });

  test("c2: the claim repaints the newest attempt's card, not the first", async () => {
    const token = await mintLead();
    failedTask("release-0912", "Release 0.9.12");
    const first = failedRun("release-0912");
    expect(store.setTaskState("release-0912", "queued", now).ok).toBe(true);
    const lease = `lease-${++serial}`;
    expect(acquire(store, ref("release-0912"), RUNNER, { now, token: `tok-${RUNNER}`, newLeaseId: () => lease, ttlMs: TTL }).ok).toBe(true);
    const second = store.startRun({ taskRef: ref("release-0912"), leaseId: lease, runner: RUNNER, branch: "so/t", worktree: "/pool/t", ...legacy, now });
    store.finishRun(second, { outcome: "failed", reason: "agent", now });
    expect(finalize(store, lease, { kind: "complete", state: "failed", now: now }).ok).toBe(true);
    expect(second).toBeGreaterThan(first);
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    const repaint = store.handle.prepare("SELECT id FROM notification WHERE kind = 'lead-on-it' ORDER BY id DESC LIMIT 1").get();
    expect(store.notificationById(Number(repaint?.["id"]))?.run).toBe(second);
  });

  test("c3: status and the console Home show what the lead is doing and when it last acted", async () => {
    expect(installationStatus(store, now, "alex").lead).toBeNull();
    const token = await mintLead();
    failedTask("release-0912", "Release 0.9.12");
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    expect(leadActivity(store, "alex")).toMatchObject({ doing: "working on Release 0.9.12", taskId: "release-0912" });
    now = new Date(T0.getTime() + minutes(1));
    expect((await cli(["lead", "say", "Fixing 0.9.12's release check", "--task", "release-0912", "--token", token, "--json"])).code).toBe(0);

    now = new Date(T0.getTime() + minutes(4));
    const status = installationStatus(store, now, "alex");
    expect(status.lead).toMatchObject({ owner: "alex", doing: "Fixing 0.9.12's release check", task: "release-0912", line: "Lead: Fixing 0.9.12's release check · 3 min ago" });
    expect(renderInstallationStatus(status)).toContain("Lead: Fixing 0.9.12's release check · 3 min ago");
    // The real command says it too, for the lead and for the person.
    expect((await cli(["status", "--token", token, "--json"])).body).toMatchObject({ ok: true, lead: { line: "Lead: Fixing 0.9.12's release check · 3 min ago" } });
    // Without a lead token: nobody known shows no lead; the remembered login shows that person's own lead.
    lines = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: db, now })).toBe(0);
    expect(lines.join("\n")).not.toMatch(/Lead: |is on it/);
    writeFileSync(join(dir, "up-login.txt"), `alex ${alexPassword}\n`, { mode: 0o600 });
    lines = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: db, now })).toBe(0);
    expect(lines.join("\n")).toContain("Lead: Fixing 0.9.12's release check · 3 min ago");
    writeFileSync(join(dir, "up-login.txt"), `bob x\n`, { mode: 0o600 });
    lines = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: db, now })).toBe(0);
    expect(lines.join("\n")).not.toMatch(/Lead: |is on it/);

    expect(leadActivityLine({ owner: "alex", doing: "x", at: now.toISOString(), taskId: null, name: "Lead" }, now)).toBe("Lead: x · just now");
    expect(agoWords(T0.toISOString(), new Date(T0.getTime() + 3 * 3_600_000))).toBe("3 h ago");
  });

  test("c1: the name the owner gave their lead is what its messages, claimed tasks and status line say", async () => {
    store.setLeadConfig("alex", "Maya", "Keep it short.", now);
    const token = await mintLead();
    const script = scriptedTelegram();
    failedTask("release-0912", "Release 0.9.12");
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    expect((await cli(["lead", "say", "Fixing the release check", "--token", token, "--json"])).code).toBe(0);
    await pass(script);
    expect(script.shown(ALEX_CHAT).map(one => String(one.params["text"])).filter(text => text.startsWith("Maya\n"))).toEqual(["Maya\n\nFixing the release check"]);
    expect(row("release-0912").status.detail).toBe("Maya is on it.");
    expect(quietCardView(store, [ref("release-0912")], now, undefined, "alex")!.text).toContain("Maya is on it.");
    expect(installationStatus(store, now, "alex").lead).toMatchObject({ line: "Maya: Fixing the release check · just now" });
    // Bob's view never borrows Alex's name for his own lead.
    expect(row("release-0912", "bob").status.detail).not.toContain("Maya");
  });

  test("c1: Crew says the lead's chosen name, and a rename reaches messages and cards saved before it", async () => {
    store.setLeadConfig("alex", "Maya", "Keep it short.", now);
    const token = await mintLead();
    const script = scriptedTelegram();
    failedTask("release-0912", "Release 0.9.12");
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    // Crew: the row keeps its own headline and says who took it on, for its owner only.
    const crew = (viewer: string) => browserCrewOf(store, now, { ...operator(viewer), includeUnplaced: false }).crew.find(one => one.id === "release-0912")!;
    expect(crew("alex")).toMatchObject({ label: "Failed", lead: "Maya is on it." });
    expect(crew("bob").lead).toBeUndefined();
    // Saved under the old name, shown under the new one: the say, the claim's card and the lapse.
    expect((await cli(["lead", "say", "Fixing the release check", "--token", token, "--json"])).code).toBe(0);
    store.setLeadConfig("alex", "Sam", "Keep it short.", now);
    await pass(script);
    const texts = script.shown(ALEX_CHAT).map(one => String(one.params["text"]));
    expect(texts).toContain("Sam\n\nFixing the release check");
    expect(texts.join("\n")).not.toContain("Maya");
    expect(crew("alex").lead).toBe("Sam is on it.");
    const saved = (kind: string) => store.handle.prepare("SELECT kind, subject, recipient FROM notification WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind) as { kind: string; subject: string; recipient: string | null };
    expect(saved("lead-on-it").subject).toBe("Maya is on it");
    expect(leadSubjectOf(store, saved("lead-on-it"), "alex")).toBe("Sam is on it");
    expect(leadSubjectOf(store, { kind: "lead-lapsed", subject: LEAD_LAPSED, recipient: null }, "alex")).toBe(leadLapsed("Sam"));
    // A lead-say row with no recipient reads the name of the reader's lead, as the chat it is shown in passes.
    expect(leadSayText(store, { kind: "lead-say", subject: "Maya", body: "Fixing the release check", recipient: null }, "alex")).toBe("Sam\n\nFixing the release check");
    // Any other row keeps its own words.
    expect(leadSubjectOf(store, { kind: "run-finished", subject: "Maya's build finished", recipient: "alex" }, "alex")).toBe("Maya's build finished");
  });

  test("c2: a claim and the lead line count only for the viewer's own lead, never another person's", async () => {
    const token = await mintLead();
    failedTask("release-0912", "Release 0.9.12");
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    expect((await cli(["lead", "say", "Fixing the release check", "--task", "release-0912", "--token", token, "--json"])).code).toBe(0);
    // Alex's lead is Alex's: Bob still sees a Failed task waiting on a person, and no lead of his.
    expect(needsYou("alex")).toEqual([]);
    expect(needsYou("bob")).toEqual(["release-0912"]);
    expect(row("release-0912", "bob").status.detail).not.toContain("is on it");
    expect(quietCardView(store, [ref("release-0912")], now, undefined, "bob")!.text).not.toContain(LEAD_ON_IT);
    expect(leadActivity(store, "bob")).toBeNull();
    expect(installationStatus(store, now, "bob")).toMatchObject({ lead: null });
    expect(installationStatus(store, now, "bob").tasks.find(one => one.task === "release-0912")!.sentence).not.toContain("is on it");
    // Nobody known (no lead token, no remembered login): no lead line at all.
    expect(installationStatus(store, now, null).lead).toBeNull();
  });

  test("c3: what the lead is doing and when it last acted come from the same newest act", async () => {
    const token = await mintLead();
    failedTask("release-0912", "Release 0.9.12");
    expect((await cli(["lead", "say", "Fixing the release check", "--task", "release-0912", "--token", token, "--json"])).code).toBe(0);
    now = new Date(T0.getTime() + minutes(30));
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    // The claim is newest: its words and its time, never the older say's words with the claim's time.
    expect(leadActivity(store, "alex")).toMatchObject({ doing: "working on Release 0.9.12", at: now.toISOString() });
    now = new Date(T0.getTime() + minutes(45));
    expect((await cli(["lead", "say", "Retrying with the fix", "--task", "release-0912", "--token", token, "--json"])).code).toBe(0);
    expect(leadActivity(store, "alex")).toMatchObject({ doing: "Retrying with the fix", at: now.toISOString() });
  });

  test("c2: a lapsed claim repaints the Telegram card back to its real state, once", async () => {
    const token = await mintLead();
    const script = scriptedTelegram();
    failedTask("release-0912", "Release 0.9.12");
    await pass(script);
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    script.reset();
    await pass(script);
    const claimed = script.shown(ALEX_CHAT);
    expect(claimed.map(one => one.method)).toEqual(["editMessageText"]);
    expect(String(claimed.at(-1)!.params["text"])).toContain(LEAD_ON_IT);
    const card = claimed.at(-1)!.params["message_id"];

    // Two quiet hours: the same card reads the task's real state again, and says it is back with Alex.
    script.reset();
    now = new Date(T0.getTime() + LEAD_IDLE_MS + minutes(1));
    await pass(script);
    const lapsed = script.shown(ALEX_CHAT);
    expect(lapsed.map(one => one.method)).toEqual(["editMessageText"]);
    expect(lapsed[0]!.params["message_id"]).toBe(card);
    expect(String(lapsed[0]!.params["text"])).toContain(LEAD_LAPSED);
    expect(String(lapsed[0]!.params["text"])).not.toContain(LEAD_ON_IT);
    // Bob never hears of Alex's lead.
    expect(script.shown(BOB_CHAT).filter(one => /is on it|^Lead\n/.test(String(one.params["text"])))).toEqual([]);
    // Once per lapse.
    expect(enqueueLeadLapses(store, now)).toBe(0);
  });

  test("c2: in every-update chat the claim edits the original Failed alert, so it stops saying it waits for you", async () => {
    const token = await mintLead();
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    const script = scriptedTelegram();
    failedTask("release-0912", "Release 0.9.12");
    store.enqueueNotification({ dedupeKey: `run:${failedRun("release-0912")}:failed`, kind: "build-failed", subject: "Build failed", body: "The agent stopped.",
      source: { run: failedRun("release-0912") } }, now);
    await pass(script);
    // The attempt's own card says Failed; its message is the one the claim must repaint.
    const alert = script.shown(ALEX_CHAT).filter(one => String(one.params["text"]).includes("❌ Failed"));
    expect(alert.length).toBeGreaterThan(0);
    expect(String(alert.at(-1)!.params["text"])).not.toContain(LEAD_ON_IT);
    const failedCard = alert.find(one => one.method === "editMessageText")?.params["message_id"] ?? 100 + script.calls.filter(one => one.method === "sendMessage").indexOf(alert[0]!);

    script.reset();
    expect((await cli(["assignment", "claim", "release-0912", "--token", token, "--json"])).code).toBe(0);
    await pass(script);
    const after = script.shown(ALEX_CHAT);
    expect(after.map(one => one.method)).toEqual(["editMessageText"]);
    expect(after[0]!.params["message_id"]).toBe(failedCard);
    expect(String(after[0]!.params["text"])).toContain(LEAD_ON_IT);
    expect(String(after[0]!.params["text"])).not.toMatch(/waits for you|retry or ask for changes/i);
  });

  test("the lead's guide tells it to say what it is doing at milestones and to claim what it fixes", () => {
    const operating = GUIDES.find(one => one.name === "operating")!.content;
    expect(operating).toContain("lead say");
    expect(operating).toMatch(/start work.*handling a\s+failure.*done/s);
    expect(operating).toContain("assignment claim <id>");
  });
});
