/**
 * Screenshots with results (result-shots.ts): each person's Off / First one /
 * Up to 4 choice, the outbox row a result message makes for them, and every
 * chat transport carrying it — Telegram photos and albums, Slack and Discord
 * uploads in the result's thread, Teams' link — under the same checks as the
 * acceptance-evidence sender. Scripted transports only; no live account.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, RESULT_SHOTS_KIND, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { RETENTION_NOTE, storeEvidence } from "./evidence.js";
import { bridgePass, hashPairingCode, mintPairingCode, multipartOf, PAIRING_TTL_MS, type TelegramTransport, type TelegramUpload } from "./telegram.js";
import { resultShotLimit, resultShotsFor } from "./result-shots.js";
import { ChatState, chatHash, type ChatContent } from "./chat-delivery-state.js";
import { SlackState, slackHash } from "./slack-state.js";
import { SlackError, type SlackApi } from "./slack-api.js";
import { deliverSlackPart, planSlackNotifications, type SlackChatOptions } from "./slack-chat.js";
import { DISCORD_REFUSED, DiscordError, type DiscordApi } from "./discord-api.js";
import { deliverDiscordPart, planDiscordNotifications, type DiscordChatOptions } from "./discord-chat.js";
import { planTeamsNotifications } from "./teams-chat.js";

const T0 = new Date("2026-10-03T09:00:00.000Z");
const BOT = "777000";
const CHAT = 4242;
const RUNNER = "worker-1";
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

/** A real PNG header: signature, then IHDR with the given size; the rest is filler. */
function png(width: number, height: number, fill = 7): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(300, fill)]);
}

let dir: string, root: string, store: Store, now: Date;
const ALPHA = "/projects/alpha";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-result-shots-")));
  root = join(dir, "evidence");
  mkdirSync(root);
  store = openStore(join(dir, "state.db"));
  now = T0;
  expect(addApprover(store, "alex", now).ok).toBe(true);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** A builder result for one task with saved screenshots (and their proof captions); finished as built unless told otherwise. */
function result(id: string, shots: { name: string; bytes: Buffer; caption?: string }[], outcome: "built" | "none" = "built", repo = ALPHA) {
  let ref = store.lookupRef(id)?.id;
  if (ref === undefined) {
    store.createTask({ id, title: "Is the site current?" }, now);
    ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo, {}, now);
  }
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}-${Math.random()}`, runner: RUNNER, branch: `so/${id}`, worktree: `/pool/${id}`, ...legacy, now });
  for (const one of shots) storeEvidence(store, root, run, "screenshot", one.name, one.bytes, `agent-claimed screenshot at evidence/${one.name} (validated png)`, now);
  const captioned = shots.filter(one => one.caption !== undefined).map(one => ({ path: `evidence/${one.name}`, caption: one.caption! }));
  if (captioned.length > 0) storeEvidence(store, root, run, "proof", "proof.json", Buffer.from(JSON.stringify({ version: 1, screenshots: captioned })), "agent-authored proof", now);
  if (outcome === "built") store.finishRun(run, { outcome: "built", committed: true, now });
  return { ref, run };
}
const shotRows = () => store.listNotifications("all").filter(one => one.kind === RESULT_SHOTS_KIND);
const THREE = [
  { name: "phone.png", bytes: png(390, 844, 1), caption: "the home page on a phone" },
  { name: "desk.png", bytes: png(1440, 900, 2), caption: "the home page on a desktop" },
  { name: "menu.png", bytes: png(390, 844, 3) },
];

describe("c1: the per-person choice", () => {
  test("off by default; First one and Up to 4 are each person's own, and only they get a row", () => {
    expect(store.notificationPreference("alex").screenshots).toBe("off");
    expect(resultShotLimit("off")).toBe(0);
    expect(resultShotLimit("first")).toBe(1);
    expect(resultShotLimit("all")).toBe(4);
    result("off-1", THREE);
    expect(shotRows()).toEqual([]);

    store.setNotificationPreference("alex", { screenshots: "first" }, "alex", now);
    expect(store.notificationPreference("alex")).toMatchObject({ mode: "quiet", screenshots: "first" });
    expect(store.notificationPreference("nobody").screenshots).toBe("off");
    // Changing the mode or digest keeps the choice.
    store.setNotificationPreference("alex", { mode: "all", digestAt: "18:30" }, "alex", now);
    expect(store.notificationPreference("alex").screenshots).toBe("first");
    expect(() => store.setNotificationPreference("alex", { screenshots: "some" as never }, "alex", now)).toThrow();

    const { run } = result("on-1", THREE);
    expect(shotRows().map(one => [one.recipient, one.run, one.dedupeKey])).toEqual([["alex", run, `result-shots:r${run}:alex`]]);
    // A result without screenshots makes no row.
    result("plain-1", []);
    expect(shotRows()).toHaveLength(1);
  });

  test("a failed result with screenshots qualifies; the person's own act and a project they can't see never do", () => {
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    const failed = result("fail-1", THREE, "none");
    store.finishRun(failed.run, { outcome: "failed", reason: "verify", now });
    store.enqueueNotification({ source: { run: failed.run }, dedupeKey: `run:${failed.run}:failed`, kind: "build-failed", subject: "Checks failed", body: "The check failed." }, now);
    expect(shotRows().map(one => one.run)).toEqual([failed.run]);
    // The same result again never makes a second row.
    store.enqueueNotification({ source: { run: failed.run }, dedupeKey: `run:${failed.run}:failed:again`, kind: "build-failed", subject: "Checks failed", body: "Again." }, now);
    expect(shotRows()).toHaveLength(1);
  });

  test("the choice is read again at send time: never more than it allows, nothing once off", () => {
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    result("again-1", [...THREE, { name: "four.png", bytes: png(400, 400, 4) }, { name: "five.png", bytes: png(400, 400, 5) }]);
    const row = shotRows()[0]!;
    const plan = resultShotsFor(store, root, [ALPHA], row);
    expect(plan.kind === "send" ? plan.shots.length : 0).toBe(4);
    store.setNotificationPreference("alex", { screenshots: "first" }, "alex", now);
    const first = resultShotsFor(store, root, [ALPHA], row);
    expect(first.kind === "send" ? first.shots.map(one => one.caption) : []).toEqual(["Is the site current? · the home page on a phone"]);
    store.setNotificationPreference("alex", { screenshots: "off" }, "alex", now);
    expect(resultShotsFor(store, root, [ALPHA], row)).toEqual({ kind: "none", why: "off" });
  });
});

describe("a scout's report", () => {
  test("its screenshots go with its \"report ready\" message, captioned as the report captioned them", () => {
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    store.createTask({ id: "scout-1", title: "What do competitors charge?" }, now);
    const ref = store.refFor("built-in", "scout-1").id;
    store.placeTask(ref, ALPHA, {}, now);
    const run = store.startRun({ taskRef: ref, leaseId: "l-scout-1", runner: RUNNER, role: "scout", branch: "so/scout-1", worktree: "/pool/scout-1", ...legacy, now });
    const pricing = png(1280, 800, 1);
    const plans = png(1280, 800, 2);
    const first = storeEvidence(store, root, run, "screenshot", "report-image-1.png", pricing, "scout screenshot pricing.png (validated png) from https://rival.example/pricing", now);
    const second = storeEvidence(store, root, run, "screenshot", "report-image-2.png", plans, "scout screenshot plans.png (validated png) from https://rival.example/plans", now);
    const sha = (artifact: number) => store.artifactsFor(run).find(one => one.id === artifact)!.sha256;
    const report = { title: "Rivals charge less", summary: "Both rivals undercut the annual plan.", report: "## Prices", followUps: [],
      items: [{ title: "Rival A is cheaper", why: "Its annual plan is 20% less.", url: "https://rival.example/pricing", image: "pricing.png" }],
      images: [
        { file: "pricing.png", caption: "Rival A's pricing page", url: "https://rival.example/pricing", sha256: sha(first), artifact: first },
        { file: "plans.png", caption: "Rival A's plan table", url: "https://rival.example/plans", sha256: sha(second), artifact: second },
      ] };
    storeEvidence(store, root, run, "report", "report.json", Buffer.from(JSON.stringify(report)), "scout handoff (verified tree)", now);
    store.finishRun(run, { outcome: "built", reason: "report-delivered", now });
    expect(shotRows()).toEqual([]);
    store.enqueueNotification({ source: { run }, dedupeKey: `report:${ref}:${run}`, kind: "report-ready", subject: "scout-1: report ready", body: "Both rivals undercut the annual plan." }, now);
    const row = shotRows()[0]!;
    expect(row).toMatchObject({ recipient: "alex", run });
    const plan = resultShotsFor(store, root, [ALPHA], row);
    expect(plan.kind === "send" ? plan.shots.map(one => [one.artifact, one.caption]) : plan).toEqual([
      [first, "What do competitors charge? · Rival A's pricing page"],
      [second, "Rival A's plan table"],
    ]);
  });
});

describe("c2: Telegram", () => {
  const pair = () => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: "31337", updateId: 1 }, now).ok).toBe(true);
  };
  type Call = { method: string; params: Record<string, unknown>; uploads: TelegramUpload[] };
  function scripted() {
    const calls: Call[] = [];
    let id = 100;
    const failures: Array<{ method: string; answer: Awaited<ReturnType<TelegramTransport>> }> = [];
    const transport: TelegramTransport = async (method, params, _signal, upload, more) => {
      calls.push({ method, params, uploads: [...(upload === undefined ? [] : [upload]), ...(more ?? [])] });
      if (method === "getUpdates") return { ok: true, result: [] };
      const failure = failures.findIndex(one => one.method === method);
      if (failure >= 0) return failures.splice(failure, 1)[0]!.answer;
      if (method === "sendMediaGroup") return { ok: true, result: (params["media"] as unknown[]).map(() => ({ message_id: id++ })) };
      if (method === "editMessageText") return { ok: true, result: { message_id: params["message_id"] } };
      if (method.startsWith("send")) return { ok: true, result: { message_id: id++ } };
      return { ok: true, result: true };
    };
    const media = () => calls.filter(one => ["sendPhoto", "sendMediaGroup", "sendDocument"].includes(one.method));
    const texts = () => calls.filter(one => one.method === "sendMessage").map(one => String(one.params["text"]));
    return { transport, calls, media, texts, fail: (method: string, answer: Awaited<ReturnType<TelegramTransport>>) => failures.push({ method, answer }) };
  }
  const pass = (script: ReturnType<typeof scripted>, projects = [ALPHA]) =>
    bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => projects, conversation: { evidenceRoot: root, phoneOrigin: () => "https://console.example" } });

  test("Up to 4: one album after the result message, the plain caption on the first photo only; never resent", async () => {
    pair();
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    result("album-1", THREE);
    const script = scripted();
    expect((await pass(script)).ok).toBe(true);
    const sent = script.media();
    expect(sent.map(one => one.method)).toEqual(["sendMediaGroup"]);
    const media = sent[0]!.params["media"] as { type: string; media: string; caption?: string }[];
    expect(media).toEqual([
      { type: "photo", media: "attach://shot0", caption: "Is the site current? · the home page on a phone" },
      { type: "photo", media: "attach://shot1" },
      { type: "photo", media: "attach://shot2" },
    ]);
    expect(sent[0]!.uploads.map(one => one.field)).toEqual(["shot0", "shot1", "shot2"]);
    expect(sent[0]!.uploads[1]!.bytes.equals(THREE[1]!.bytes)).toBe(true);
    // The result's own message went first.
    const first = script.calls.findIndex(one => one.method === "sendMessage" || one.method === "editMessageText");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(script.calls.indexOf(sent[0]!));
    // The album is one multipart body with every file in it.
    const form = multipartOf({ chat_id: CHAT }, sent[0]!.uploads[0]!, ...sent[0]!.uploads.slice(1));
    expect([...form.keys()]).toEqual(["chat_id", "shot0", "shot1", "shot2"]);
    // Later passes, and a restart, send nothing again.
    await pass(script);
    store.close(); store = openStore(join(dir, "state.db"));
    await pass(script);
    expect(script.media()).toHaveLength(1);
  });

  test("held for a digest: the screenshots wait for their result message and go right after it, once", async () => {
    pair();
    store.setNotificationPreference("alex", { mode: "all", screenshots: "first" }, "alex", now);
    store.setTelegramDigest(60_000, "alex", now);
    now = new Date(now.getTime() + 1_000);
    result("held-1", THREE);
    const script = scripted();
    await pass(script);
    // The result message is held for the digest, so its screenshots are too.
    expect(script.media()).toEqual([]);
    expect(script.texts()).toEqual([]);
    now = new Date(now.getTime() + 61_000);
    await pass(script);
    const digest = script.calls.findIndex(one => one.method === "sendMessage" && String(one.params["text"]).startsWith("digest"));
    expect(digest).toBeGreaterThanOrEqual(0);
    expect(script.media()).toHaveLength(1);
    expect(script.calls.indexOf(script.media()[0]!)).toBeGreaterThan(digest);
    await pass(script);
    expect(script.media()).toHaveLength(1);
  });

  test("First one: a single photo with inline preview; an oversized screenshot goes as a document", async () => {
    pair();
    store.setNotificationPreference("alex", { screenshots: "first" }, "alex", now);
    result("one-1", THREE);
    const script = scripted();
    await pass(script);
    expect(script.media().map(one => [one.method, one.params["caption"], one.uploads.map(u => u.field)])).toEqual([["sendPhoto", "Is the site current? · the home page on a phone", ["photo"]]]);

    // A very tall capture is over Telegram's photo ratio: it goes as a document.
    result("tall-1", [{ name: "tall.png", bytes: png(300, 9000) }]);
    await pass(script);
    expect(script.media().at(-1)).toMatchObject({ method: "sendDocument", params: { caption: "Is the site current?" } });
  });

  test("a refused send retries only what didn't arrive; an unconfirmed one is never sent again", async () => {
    pair();
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    result("retry-1", [{ name: "a.png", bytes: png(400, 800), caption: "the page" }, { name: "tall.png", bytes: png(100, 5000) }]);
    const script = scripted();
    script.fail("sendDocument", { ok: false, description: "Bad Request" });
    await pass(script);
    expect(script.media().map(one => one.method)).toEqual(["sendPhoto", "sendDocument"]);
    now = new Date(now.getTime() + 60_000);
    await pass(script);
    // The photo already arrived: only the document goes again.
    expect(script.media().map(one => one.method)).toEqual(["sendPhoto", "sendDocument", "sendDocument"]);
    await pass(script);
    expect(script.media()).toHaveLength(3);

    // Unconfirmed (the network dropped): marked sent before it went, so it is not repeated.
    result("lost-1", [{ name: "b.png", bytes: png(400, 800) }]);
    script.fail("sendPhoto", { ok: false, description: "fetch failed", uncertain: true });
    const report = await pass(script);
    expect(report.ok && report.report.problems.join("\n")).toContain("not sent again");
    now = new Date(now.getTime() + 60_000);
    await pass(script);
    expect(script.media().filter(one => one.method === "sendPhoto")).toHaveLength(2);
  });

  test("a screenshot that no longer verifies, or a result replaced since, says one plain line and sends nothing else", async () => {
    pair();
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    const { run } = result("tamper-1", THREE);
    writeFileSync(join(root, String(run), "desk.png"), png(10, 10, 9));
    const script = scripted();
    await pass(script);
    expect(script.media()).toEqual([]);
    expect(script.texts().filter(one => one.startsWith("Screenshots"))).toEqual(["Screenshots for Is the site current? weren't sent: the saved file is missing or changed."]);

    // A newer result of the same task finished before this one's screenshots went.
    store.setNotificationPreference("alex", { screenshots: "first" }, "alex", now);
    const projects = [ALPHA];
    const older = result("newer-1", THREE);
    result("newer-1", [], "built");
    expect(shotRows().some(one => one.run === older.run)).toBe(true);
    await pass(script, projects);
    expect(script.media()).toEqual([]);
    expect(script.texts().at(-1)).toBe("Screenshots for Is the site current? weren't sent: a newer result replaced this one.");
  });

  test("screenshots pruned by retention send nothing and say nothing", async () => {
    pair();
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    const { run } = result("pruned-1", THREE);
    for (const one of THREE) rmSync(join(root, String(run), one.name), { force: true });
    writeFileSync(join(root, String(run), RETENTION_NOTE), "");
    const script = scripted();
    await pass(script);
    expect(script.media()).toEqual([]);
    expect(script.texts().some(one => one.startsWith("Screenshots"))).toBe(false);
    const row = shotRows()[0]!;
    const receipt = store.telegramDeliveries(store.liveTelegramBinding(BOT)!).find(one => one.id === row.id);
    expect(receipt?.receipt).toBe("skipped:screenshots-pruned");
  });
});

describe("c3: Slack and Discord upload in the result's thread; Teams links", () => {
  const SLACK_ID = { installation: "installation-test", team: "TTEST", app: "ATEST", bot: "UBOT", workspace: "Test workspace" };
  const MEMBER = "UTEST", CHANNEL = "DTEST";

  function slack(refuse?: string, failPosts = 0) {
    const state = new SlackState(store);
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    let sent = 100;
    const api: SlackApi = async (method, args = {}) => {
      calls.push({ method, args });
      if (method === "chat.postMessage" && failPosts > 0) { failPosts--; throw new SlackError("internal_error", 60_000); }
      if (method === "users.info") return { user: { id: MEMBER, team_id: SLACK_ID.team, deleted: false, is_bot: false } };
      if (method === "conversations.info") return { channel: { id: CHANNEL, is_im: true, user: MEMBER } };
      if (method === "chat.postMessage") return { ts: `1789700000.${String(sent++).padStart(6, "0")}` };
      if (method === "chat.update") return { ts: args.ts };
      if (method === "files.getUploadURLExternal") {
        if (refuse !== undefined) throw new SlackError(refuse);
        return { file_id: `F${sent++}`, upload_url: "https://files.slack.com/upload/v1/test" };
      }
      if (method === "files.completeUploadExternal") return { files: [{ id: (args.files as { id: string }[])[0]!.id }] };
      return {};
    };
    const options: SlackChatOptions = { store, identity: SLACK_ID, api, owner: "test", readProjects: async () => [ALPHA], evidenceRoot: root,
      current: () => true, origin: () => "https://console.example", clock: () => now, upload: vi.fn(async () => {}) };
    state.lease(SLACK_ID.installation, "test", now);
    const code = state.pairing(SLACK_ID.installation, "alex", store.accountOf("alex")!.generation, now);
    state.pair(SLACK_ID, slackHash(code), MEMBER, CHANNEL, now);
    const drain = async () => { for (let i = 0; i < 30 && (await deliverSlackPart(options)); i++); };
    return { state, calls, options, drain };
  }

  test("Slack: each screenshot is uploaded in the result message's thread, once", async () => {
    const wire = slack();
    store.setNotificationPreference("alex", { screenshots: "all", mode: "all" }, "alex", now);
    result("slack-1", THREE);
    await planSlackNotifications(wire.options);
    await wire.drain();
    const posted = wire.calls.find(one => one.method === "chat.postMessage")!;
    const shared = wire.calls.filter(one => one.method === "files.completeUploadExternal");
    expect(shared).toHaveLength(3);
    // Each in the thread of the result's own message.
    const resultTs = "1789700000.000100";
    expect(posted.args.thread_ts).toBeUndefined();
    expect(shared.map(one => one.args.thread_ts)).toEqual([resultTs, resultTs, resultTs]);
    expect(shared[0]!.args.initial_comment).toBe("Is the site current? · the home page on a phone");
    // Planning and delivering again sends nothing more.
    await planSlackNotifications(wire.options);
    await wire.drain();
    expect(wire.calls.filter(one => one.method === "files.completeUploadExternal")).toHaveLength(3);
  });

  test("Slack: while the result message waits to retry, its screenshots wait too, then go in its thread", async () => {
    const wire = slack(undefined, 1);
    store.setNotificationPreference("alex", { screenshots: "first", mode: "all" }, "alex", now);
    result("slack-wait", THREE);
    await planSlackNotifications(wire.options);
    await wire.drain();
    expect(wire.calls.filter(one => one.method.startsWith("files."))).toEqual([]);
    now = new Date(now.getTime() + 5 * 60_000);
    wire.state.lease(SLACK_ID.installation, "test", now);
    await wire.drain();
    const posted = wire.calls.filter(one => one.method === "chat.postMessage");
    expect(posted).toHaveLength(2);
    const shared = wire.calls.filter(one => one.method === "files.completeUploadExternal");
    expect(shared.map(one => one.args.thread_ts)).toEqual(["1789700000.000100"]);
  });

  test("Slack without file permission: one plain line, no uploads; pruned screenshots go quietly", async () => {
    const wire = slack("missing_scope");
    store.setNotificationPreference("alex", { screenshots: "all", mode: "all" }, "alex", now);
    result("slack-2", THREE);
    await planSlackNotifications(wire.options);
    await wire.drain();
    expect(wire.calls.filter(one => one.method === "files.completeUploadExternal")).toEqual([]);
    const lines = wire.calls.filter(one => one.method === "chat.postMessage").map(one => String(one.args.text)).filter(one => one.startsWith("Screenshots"));
    expect(lines).toEqual(["Screenshots for Is the site current? weren't sent: the Slack app isn't allowed to upload files here."]);

    // Pruned after planning: nothing uploaded and nothing said.
    const allowed = slack();
    const { run } = result("slack-3", THREE);
    await planSlackNotifications(allowed.options);
    writeFileSync(join(root, String(run), RETENTION_NOTE), "");
    const before = allowed.calls.length;
    await allowed.drain();
    expect(allowed.calls.slice(before).filter(one => one.method.startsWith("files."))).toEqual([]);
    expect(allowed.calls.slice(before).filter(one => one.method === "chat.postMessage").map(one => String(one.args.text)).some(one => one.startsWith("Screenshot"))).toBe(false);
  });

  const D_BOT = "100000000000000001", D_MEMBER = "100000000000000002", D_CHANNEL = "100000000000000003";
  const D_ID = { app: D_BOT, bot: D_BOT, workspace: "Synthetic application", installation: chatHash(`discord:${D_BOT}:${D_BOT}`) };
  function discord(refuse = false, failPosts = 0) {
    const state = new ChatState(store, "discord");
    const calls: { method: string; path: string; body: Record<string, unknown>; file?: { bytes: Uint8Array; name: string } }[] = [];
    let serial = 200;
    const api: DiscordApi = async (method, path, body = {}, file) => {
      calls.push({ method, path, body, ...(file ? { file } : {}) });
      if (method === "POST" && !file && path.endsWith("/messages") && failPosts > 0) { failPosts--; throw new DiscordError("Discord is unavailable", 60_000); }
      if (path === `/users/${D_MEMBER}`) return { id: D_MEMBER };
      if (path === `/channels/${D_CHANNEL}`) return { id: D_CHANNEL, type: 1, recipients: [{ id: D_MEMBER }] };
      if (method === "GET") return { items: [] };
      if (file && refuse) throw new DiscordError(DISCORD_REFUSED, 60_000);
      return { id: method === "PATCH" ? path.split("/").at(-1) : `30000000000000${serial++}00`, channel_id: D_CHANNEL, author: { id: D_BOT },
        ...(file ? { attachments: [{ id: "1", filename: file.name, size: file.bytes.length }] } : {}) };
    };
    const options: DiscordChatOptions = { store, identity: D_ID, api, owner: "test", current: () => true, readProjects: async () => [ALPHA],
      evidenceRoot: root, origin: () => "https://console.example", clock: () => now };
    state.lease(D_ID.installation, "test", now);
    const code = state.pairing(D_ID.installation, "alex", store.accountOf("alex")!.generation, now);
    state.pair(D_ID, chatHash(code), D_MEMBER, D_CHANNEL, now);
    const drain = async () => { for (let i = 0; i < 30 && (await deliverDiscordPart(options)); i++); };
    return { state, calls, options, drain };
  }

  test("Discord: screenshots are files replying to the result message; no permission is one plain line", async () => {
    const wire = discord();
    store.setNotificationPreference("alex", { screenshots: "first", mode: "all" }, "alex", now);
    result("discord-1", THREE);
    await planDiscordNotifications(wire.options);
    await wire.drain();
    const posts = wire.calls.filter(one => one.method === "POST");
    const files = posts.filter(one => one.file !== undefined);
    expect(files).toHaveLength(1);
    expect(files[0]!.file!.name).toMatch(/\.png$/);
    expect(files[0]!.body.message_reference).toMatchObject({ message_id: "3000000000000020000" });

    const refused = discord(true);
    result("discord-2", THREE);
    await planDiscordNotifications(refused.options);
    await refused.drain();
    const texts = refused.calls.filter(one => one.method === "POST" && one.file === undefined).map(one => JSON.stringify(one.body));
    expect(texts.filter(one => one.includes("weren't sent")).length).toBe(1);
    expect(texts.some(one => one.includes("the Discord app isn't allowed to upload files here"))).toBe(true);
  });

  test("Discord: while the result message waits to retry, its screenshot waits too, then replies to it", async () => {
    const wire = discord(false, 1);
    store.setNotificationPreference("alex", { screenshots: "first", mode: "all" }, "alex", now);
    result("discord-wait", THREE);
    await planDiscordNotifications(wire.options);
    await wire.drain();
    expect(wire.calls.filter(one => one.file !== undefined)).toEqual([]);
    now = new Date(now.getTime() + 5 * 60_000);
    wire.state.lease(D_ID.installation, "test", now);
    await wire.drain();
    const files = wire.calls.filter(one => one.file !== undefined);
    expect(files).toHaveLength(1);
    expect(files[0]!.body.message_reference).toMatchObject({ message_id: "3000000000000020000" });
  });

  test("Teams: one message that links to the saved result", async () => {
    const state = new ChatState(store, "teams");
    const identity = { installation: "teams-installation", app: "teams-app", bot: "28:teams-app", workspace: "Synthetic tenant" };
    state.lease(identity.installation, "test", now);
    const code = state.pairing(identity.installation, "alex", store.accountOf("alex")!.generation, now);
    expect(state.pair(identity, chatHash(code), "29:member-abcdefghij", "a:conversation-1", now)).not.toBeNull();
    store.setNotificationPreference("alex", { screenshots: "all" }, "alex", now);
    result("teams-1", THREE);
    await planTeamsNotifications({ store, identity, api: async () => ({}), owner: "test", current: () => true, readProjects: async () => [ALPHA],
      evidenceRoot: root, origin: () => "https://console.example", clock: () => now });
    const shots = state.prepare("SELECT payload FROM chat_part").all().map(one => JSON.parse(String(one.payload)) as ChatContent).filter(one => one.image !== undefined);
    expect(shots).toHaveLength(1);
    expect(shots[0]!.text).toBe("Is the site current? · the home page on a phone · 3 screenshots");
  });
});
