/** The outbound privacy guard (outbound-privacy.ts): a notification, card or reply whose words name a key or a folder on
 * this computer reaches Telegram, Slack, Discord, Teams, a webhook, a phone or an inbox only as its safe version — the
 * project's name and a link to Toolroll — and the private words are in no call. Scripted transports only; no network,
 * no model. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import { bridgePass, createTransport, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { deliverSlackPart, planSlackNotifications, processSlackEvent, receiveSlack, type SlackChatOptions } from "./slack-chat.js";
import { deliverDiscordPart, planDiscordNotifications, type DiscordChatOptions } from "./discord-chat.js";
import { deliverTeamsPart, planTeamsNotifications, type TeamsChatOptions } from "./teams-chat.js";
import { slackApi, type SlackApi } from "./slack-api.js";
import { discordApi, type DiscordApi } from "./discord-api.js";
import { forgetTeamsToken, teamsApi, teamsIdentity, type TeamsApi } from "./teams-api.js";
import { postWebhook } from "./webhooks.js";
import { buildPushPayload, privacySafeLine } from "./push.js";
import { saveEmailSettings, sendEmail, type Mail } from "./flow-actions.js";
import { notificationCommandEnv } from "./notification-delivery.js";
import { checkedChunks, privateWords, projectName, safeLink, safeWords } from "./outbound-privacy.js";
import { splitChatText } from "./chat-delivery.js";
import { shapeReplyParts } from "./reply-shape.js";
import { PLATFORM_LIMITS } from "./text-limits.js";
import { PART_CAP as LEAD_PART_CAP } from "./telegram-lead.js";
import { slackBlocks } from "./slack-chat.js";
import { liveText } from "./chat-live.js";
import { telegramDraftOf } from "./telegram-live.js";

const PRIVATE_TITLES = ["Rotate ~/.ssh/id_rsa", "Read /Users/me/secret before the build"] as const;
const SECRETS = ["~/.ssh/id_rsa", "/Users/me/secret"] as const;
const ORDINARY = "Fix the login page";
const ORIGIN = "https://console.example";
const SAFE = "An update is ready in shop. Open it in Toolroll.";

/** Which private words appear in any call — as sent, or once a chat app's escapes ("\~", "\_") are taken off. */
/** A message whose private path sits exactly across a chunk boundary at `size`: ":/Use" ends one chunk, "rs/me/secret"
 * starts the next, so neither chunk alone names it. No spaces, so every splitter cuts at the size itself. */
const straddling = (size: number): string => `${"x".repeat(size - 5)}:${SECRETS[1]}${"y".repeat(size)}`;
const cleanEach = (chunks: readonly string[]): boolean => chunks.length > 1 && chunks.every(one => !privateWords(one));

const leaks = (calls: unknown): string[] => SECRETS.filter(one => JSON.stringify(calls).replaceAll("\\\\", "").includes(one));

describe("the rule", () => {
  test("names of keys and folders on this computer are private; a project's paths, routes and web addresses are not", () => {
    // Assembled so the repository's own secret scan never sees a key-shaped literal.
    const key = ["ghp", "A".repeat(10) + "b".repeat(10) + "C".repeat(10) + "d1e2f3"].join("_");
    for (const one of [...SECRETS, "C:\\Users\\me", "see d:/backups", "\\\\server\\share", "file:///Users/me/x", `token ${key}`, "1234567:abcdefghijklmnopqrstuvwxyz"])
      expect(privateWords(one), one).toBe(true);
    // A project folder that happens to be called "home" or "Users" (joined, so the repository hygiene scan reads no path).
    for (const one of [ORDINARY, ["src", "home", "index.ts"].join("/"), "/next", "https://github.com/acme/shop/pull/3", ["packages", "Users", "list.ts"].join("/"), "ratio 3:4"])
      expect(privateWords(one), one).toBe(false);
  });

  test("a project is named, never its path, and a link is kept only when nothing private is in it", () => {
    expect(projectName("/Users/me/code/shop")).toBe("shop");
    expect(projectName(null)).toBeNull();
    expect(safeWords({ project: "/Users/me/code/shop" })).toBe(SAFE);
    expect(safeWords(null)).toBe("An update is ready. Open it in Toolroll.");
    expect(safeLink(`${ORIGIN}/tasks/abc`)).toBe(`${ORIGIN}/tasks/abc`);
    expect(safeLink(`${ORIGIN}/open?path=/Users/me/secret`)).toBeNull();
    expect(safeLink(`${ORIGIN}/open?path=%2FUsers%2Fme`)).toBeNull();
    expect(safeLink("vscode://file/x")).toBeNull();
  });

  test("a message is checked whole before it is cut: a path a chunk boundary cuts in two still sends the safe version", () => {
    const text = straddling(2800);
    const chunks = splitChatText(text, 2800);
    expect(cleanEach(chunks)).toBe(true);
    expect(chunks[0]!.endsWith(":/Use")).toBe(true);
    expect(checkedChunks(text, chunks, { project: "/srv/shop" })).toEqual([SAFE]);
    // Slack's sections and every app's live window are cut the same way, and checked whole the same way.
    expect(JSON.stringify(slackBlocks(`Title\n${text}`))).not.toContain(":/Use");
    expect(JSON.stringify(slackBlocks(`Title\n${text}`))).toContain("An update is ready. Open it in Toolroll.");
    for (const platform of ["slack", "discord", "teams"] as const) {
      const live = liveText({ phase: "writing", status: "Writing…", text: straddling(1000) }, platform, 1000)!;
      expect(live, platform).not.toContain(":/Use");
      expect(live, platform).toContain("An update is ready. Open it in Toolroll.");
    }
    const draft = telegramDraftOf({ phase: "writing", status: "Writing…", text: straddling(4000) })!;
    expect(draft.text).not.toContain(":/Use");
    expect(draft.text).toContain("An update is ready. Open it in Toolroll.");
    const plain = `${"x".repeat(2795)}${"y".repeat(2800)}`;
    expect(checkedChunks(plain, splitChatText(plain, 2800))).toEqual(splitChatText(plain, 2800));
  });
});

describe("every transport sends the safe version", () => {
  let dir: string, repo: string, store: Store, now: Date;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-outbound-")));
    repo = join(dir, "shop");
    mkdirSync(repo);
    mkdirSync(join(dir, "evidence"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Synthetic outbound test\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
    store = openStore(join(dir, "state.db"));
    now = new Date("2026-11-15T12:00:00Z");
    if (!addApprover(store, "alex", now).ok) throw Error("account");
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  /** A task in the shop project, and the "needs you" notice about it (its title as the subject, as every notice says it). */
  const notice = (id: string, title: string, body = "It needs a person.") => {
    store.createTask({ id, title }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo, {}, now);
    expect(store.enqueueNotification({ dedupeKey: `needs-you:${id}`, kind: "needs-you", subject: title, body, pushClass: "attention", link: `/tasks/${id}`, source: { taskRef: ref } }, now)).toBe(true);
    return ref;
  };

  describe("Telegram", () => {
    const BOT = "777000", CHAT = 4242;
    let calls: Array<{ method: string; params: Record<string, unknown> }>, updates: unknown[][] = [];
    const transport: TelegramTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === "getUpdates") return { ok: true, result: updates.shift() ?? [] };
      return { ok: true, result: method === "sendMessage" ? { message_id: 100 + calls.length } : true };
    };
    beforeEach(() => {
      calls = [];
      const code = mintPairingCode();
      store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
      expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: String(CHAT), updateId: 1 }, now).ok).toBe(true);
    });
    const pass = () => bridgePass(store, { botId: BOT, transport, clock: () => now, readProjects: async () => [repo], conversation: { evidenceRoot: join(dir, "evidence"), phoneOrigin: () => ORIGIN } });
    const sent = () => calls.filter(one => one.method === "sendMessage" || one.method === "editMessageText");

    test.each(PRIVATE_TITLES)("a task titled %j reaches the chat as the project and a link only", async title => {
      notice("t-private", title);
      await pass();
      expect(sent().length).toBeGreaterThan(0);
      expect(leaks(calls)).toEqual([]);
      expect(sent().at(-1)!.params["text"]).toBe(SAFE);
    });

    test("an ordinary title passes unchanged", async () => {
      notice("t-plain", ORDINARY);
      await pass();
      expect(JSON.stringify(sent())).toContain(ORDINARY);
      expect(JSON.stringify(calls)).not.toContain("Open it in Toolroll");
    });

    test("the lead's reply with a path exactly across a part boundary goes as the safe version, never in pieces", async () => {
      const reply = straddling(LEAD_PART_CAP);
      expect(cleanEach(shapeReplyParts(reply, LEAD_PART_CAP, {}))).toBe(true);
      for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
      store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", now);
      updates = [[{ update_id: 2, message: { message_id: 1002, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: "Where are the notes?" } }]];
      await bridgePass(store, { botId: BOT, transport, clock: () => now, deliver: false, readProjects: async () => [repo],
        conversation: { evidenceRoot: join(dir, "evidence"), phoneOrigin: () => ORIGIN, liveTiming: { ackGapMs: 0, draftSpacingMs: 0 },
          subscriptionRunner: async () => ({ ok: true, answer: { text: reply, calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } }) } });
      const said = sent().map(one => String(one.params["text"]));
      expect(said).toContain("An update is ready. Open it in Toolroll.");
      expect(leaks(calls)).toEqual([]);
      expect(JSON.stringify(calls)).not.toContain(":/Use");
    });

    test("the real client guards every call, whatever sent it: the private words never reach the network", async () => {
      const bodies: string[] = [];
      const client = createTransport("fixture-token", 5_000, (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      }) as typeof fetch);
      await client("sendMessage", { chat_id: CHAT, text: `${PRIVATE_TITLES[1]}\nDone.`, reply_markup: { inline_keyboard: [[{ text: "Accept", callback_data: "a".repeat(32) }, { text: "Open", url: `${ORIGIN}/tasks/t1` }]] } });
      await client("sendMessage", { chat_id: CHAT, text: ORDINARY });
      expect(leaks(bodies)).toEqual([]);
      expect(JSON.parse(bodies[0]!)).toEqual({ chat_id: CHAT, text: "An update is ready. Open it in Toolroll.", link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [[{ text: "Open in Toolroll", url: `${ORIGIN}/tasks/t1` }]] } });
      expect(JSON.parse(bodies[1]!)).toEqual({ chat_id: CHAT, text: ORDINARY });
      // A call that can't be made safe (a file of private words) is not made at all.
      expect(await client("sendDocument", { chat_id: CHAT, caption: "Terms" }, undefined, { field: "document", fileName: "terms.txt", contentType: "text/plain", bytes: Buffer.from(SECRETS[0]) })).toMatchObject({ ok: false });
      expect(bodies).toHaveLength(2);
    });
  });

  describe("Slack", () => {
    const ID = { installation: "installation-test", team: "TTEST", app: "ATEST", bot: "UBOT", workspace: "Test workspace" };
    const MEMBER = "UTEST", CHANNEL = "DTEST";
    let calls: Array<{ method: string; args: Record<string, unknown> }>, options: SlackChatOptions, state: ChatState;
    beforeEach(() => {
      calls = [];
      state = new ChatState(store, "slack");
      let ts = 100;
      const api: SlackApi = async (method, args = {}) => {
        calls.push({ method, args });
        if (method === "users.info") return { user: { id: MEMBER, team_id: ID.team, deleted: false, is_bot: false } };
        if (method === "conversations.info") return { channel: { id: CHANNEL, is_im: true, user: MEMBER } };
        if (method === "chat.postMessage") return { ts: `1789700000.${String(ts++).padStart(6, "0")}` };
        if (method === "chat.update") return { ts: args["ts"] };
        return {};
      };
      options = { store, identity: ID, api, owner: "test", current: () => true, readProjects: async () => [repo], evidenceRoot: join(dir, "evidence"), origin: () => ORIGIN, clock: () => now };
      state.lease(ID.installation, "test", now);
      const code = state.pairing(ID.installation, "alex", store.accountOf("alex")!.generation, now);
      expect(state.pair(ID, chatHash(code), MEMBER, CHANNEL, now)).not.toBeNull();
      now = new Date(now.getTime() + 1_000);
    });
    const deliver = async () => { await planSlackNotifications(options); for (let i = 0; i < 20 && (await deliverSlackPart(options)); i++); };
    const sent = () => calls.filter(one => one.method === "chat.postMessage" || one.method === "chat.update");

    test.each(PRIVATE_TITLES)("a task titled %j reaches Slack as the project and a link only", async title => {
      notice("s-private", title);
      await deliver();
      expect(sent().length).toBeGreaterThan(0);
      expect(leaks(calls)).toEqual([]);
      expect(String(sent().at(-1)!.args["text"])).toMatch(/^An update is ready in shop\. Open it in Toolroll\./);
      expect(JSON.stringify(sent().at(-1)!.args["blocks"])).not.toContain("action_id");
    });

    test("an ordinary title passes unchanged", async () => {
      notice("s-plain", ORDINARY);
      await deliver();
      expect(JSON.stringify(sent())).toContain(ORDINARY);
      expect(JSON.stringify(calls)).not.toContain("Open it in Toolroll");
    });

    test("the lead's reply with a path exactly across a part boundary goes as the safe version, never in pieces", async () => {
      const reply = straddling(2800);
      // The parts the reply is cut into: neither names the path on its own.
      expect(cleanEach(shapeReplyParts(reply, 2800, { appOrigin: ORIGIN }))).toBe(true);
      for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
      store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", now);
      options = { ...options, subscriptionRunner: async () => ({ ok: true, answer: { text: reply, calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } }) };
      expect(receiveSlack(state, ID, "events_api", { api_app_id: ID.app, team_id: ID.team, event_id: "Ev1",
        event: { type: "message", channel_type: "im", user: MEMBER, channel: CHANNEL, ts: "1789700000.000001", text: "Where are the notes?" } }, now)).toBe(true);
      await processSlackEvent(options);
      for (let i = 0; i < 20 && (await deliverSlackPart(options)); i++);
      const said = sent().map(one => String(one.args["text"]));
      expect(said.length).toBeGreaterThan(0);
      expect(leaks(calls)).toEqual([]);
      expect(JSON.stringify(calls)).not.toContain(":/Use");
      expect(said.some(one => one.startsWith("An update is ready. Open it in Toolroll."))).toBe(true);
    });

    test("the real client guards every call, and refuses one it can't make safe", async () => {
      const bodies: string[] = [];
      const api = slackApi(["xoxb", "fixture", "outbound"].join("-"), (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Response.json({ ok: true, ts: "1.2" });
      }) as typeof fetch);
      await api("chat.postMessage", { channel: CHANNEL, text: PRIVATE_TITLES[0], blocks: [{ type: "section", text: { type: "plain_text", text: PRIVATE_TITLES[0] } },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: `${ORIGIN}/tasks/s1`, action_id: "toolroll_link" }] }] });
      expect(leaks(bodies)).toEqual([]);
      expect(JSON.parse(bodies[0]!)).toMatchObject({ channel: CHANNEL, text: `An update is ready. Open it in Toolroll. <${ORIGIN}/tasks/s1|Open in Toolroll>` });
      await expect(api("reactions.add", { channel: CHANNEL, name: SECRETS[1] })).rejects.toMatchObject({ permanent: true });
      expect(bodies).toHaveLength(1);
    });
  });

  describe("Discord", () => {
    const BOT = "100000000000000001", MEMBER = "100000000000000002", CHANNEL = "100000000000000003";
    const ID = { app: BOT, bot: BOT, workspace: "Synthetic application", installation: chatHash(`discord:${BOT}:${BOT}`) };
    let calls: Array<{ method: string; path: string; body: Record<string, unknown> }>, options: DiscordChatOptions, state: ChatState, serial = 0;
    beforeEach(() => {
      calls = [];
      state = new ChatState(store, "discord");
      const api: DiscordApi = async (method, path, body = {}) => {
        calls.push({ method, path, body });
        if (path === `/users/${MEMBER}`) return { id: MEMBER };
        if (path === `/channels/${CHANNEL}`) return { id: CHANNEL, type: 1, recipients: [{ id: MEMBER }] };
        if (method === "GET") return { items: [] };
        return { id: method === "PATCH" ? path.split("/").at(-1) : String(100000000000001000n + BigInt(++serial)), channel_id: CHANNEL, author: { id: BOT } };
      };
      options = { store, identity: ID, api, owner: "test", current: () => true, readProjects: async () => [repo], evidenceRoot: join(dir, "evidence"), origin: () => ORIGIN, clock: () => now };
      state.lease(ID.installation, "test", now);
      const code = state.pairing(ID.installation, "alex", store.accountOf("alex")!.generation, now);
      expect(state.pair(ID, chatHash(code), MEMBER, CHANNEL, now)).not.toBeNull();
      now = new Date(now.getTime() + 1_000);
    });
    const deliver = async () => { await planDiscordNotifications(options); for (let i = 0; i < 20 && (await deliverDiscordPart(options)); i++); };
    const sent = () => calls.filter(one => one.method !== "GET");

    test.each(PRIVATE_TITLES)("a task titled %j reaches Discord as the project and a link only", async title => {
      notice("d-private", title);
      await deliver();
      expect(sent().length).toBeGreaterThan(0);
      expect(leaks(calls)).toEqual([]);
      expect(sent().at(-1)!.body).toMatchObject({ content: SAFE, embeds: [] });
    });

    test("an ordinary title passes unchanged", async () => {
      notice("d-plain", ORDINARY);
      await deliver();
      expect(JSON.stringify(sent())).toContain(ORDINARY);
      expect(JSON.stringify(calls)).not.toContain("Open it in Toolroll");
    });

    test("the real client guards every call", async () => {
      const bodies: string[] = [];
      const api = discordApi(["synthetic", "discord", "outbound"].join("-"), (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Response.json({ id: "100000000000009999" });
      }) as typeof fetch);
      await api("POST", `/channels/${CHANNEL}/messages`, { content: "", embeds: [{ title: PRIVATE_TITLES[1], description: "Done." }],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open", url: `${ORIGIN}/tasks/d1` }, { type: 2, style: 1, label: "Accept", custom_id: "a".repeat(32) }] }] });
      expect(leaks(bodies)).toEqual([]);
      expect(JSON.parse(bodies[0]!)).toMatchObject({ embeds: [], components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open in Toolroll", url: `${ORIGIN}/tasks/d1` }] }] });
      // Words Discord's escapes would hide from a plain scan ("\~/", "\_") are read as the person will see them.
      await api("PATCH", `/channels/${CHANNEL}/messages/100000000000000777`, { content: "", embeds: [{ title: "Rotate \\~/.ssh/id\\_rsa", description: "Done." }] });
      expect(leaks(bodies)).toEqual([]);
      expect(JSON.parse(bodies[1]!)).toMatchObject({ content: "An update is ready. Open it in Toolroll.", embeds: [] });
    });
  });

  describe("Teams", () => {
    const APP = "11111111-2222-4333-8444-555555555555", TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", SERVICE = "https://smba.trafficmanager.net/teams/";
    const ALEX = "29:1alex-user-id-xxxxxxxxxxxxxx", DM = "a:1dm-alex-conversation-id";
    const credentials = { ...teamsIdentity(APP, TENANT), tenant: TENANT, secret: "secret-value-for-tests-1234567890" };
    let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>, options: TeamsChatOptions, state: ChatState, ids = 0;
    beforeEach(() => {
      calls = [];
      forgetTeamsToken();
      state = new ChatState(store, "teams");
      const api: TeamsApi = async (method, _serviceUrl, path, body) => {
        calls.push({ method, path, ...(body ? { body } : {}) });
        if (method === "GET") return { id: decodeURIComponent(path.split("/members/")[1] ?? "") };
        return { id: `act-${++ids}` };
      };
      options = { store, identity: credentials, api, owner: "test", current: () => true, readProjects: async () => [repo], evidenceRoot: join(dir, "evidence"), origin: () => ORIGIN, clock: () => now };
      state.lease(credentials.installation, "test", now);
      const code = state.pairing(credentials.installation, "alex", store.accountOf("alex")!.generation, now);
      state.setMeta(credentials.installation, `serviceUrl:${DM}`, SERVICE, now);
      expect(state.pair(credentials, chatHash(code), ALEX, DM, now)).not.toBeNull();
      now = new Date(now.getTime() + 1_000);
    });
    afterEach(() => forgetTeamsToken());
    const deliver = async () => { await planTeamsNotifications(options); for (let i = 0; i < 20 && (await deliverTeamsPart(options)); i++); };
    const sent = () => calls.filter(one => one.method !== "GET");

    test.each(PRIVATE_TITLES)("a task titled %j reaches Teams as the project and a link only", async title => {
      notice("m-private", title);
      await deliver();
      expect(sent().length).toBeGreaterThan(0);
      expect(leaks(calls)).toEqual([]);
      expect(JSON.stringify(sent().at(-1)!.body)).toContain(SAFE);
      expect(JSON.stringify(sent().at(-1)!.body)).not.toContain("Action.Submit");
    });

    test("an ordinary title passes unchanged", async () => {
      notice("m-plain", ORDINARY);
      await deliver();
      expect(JSON.stringify(sent())).toContain(ORDINARY);
      expect(JSON.stringify(calls)).not.toContain("Open it in Toolroll");
    });

    test("a message with a path exactly across the boundary of two Teams messages goes as the safe version, never in pieces", async () => {
      const text = straddling(PLATFORM_LIMITS.teams);
      expect(cleanEach(splitChatText(text, PLATFORM_LIMITS.teams))).toBe(true);
      const binding = state.bindingFor(credentials.installation, ALEX)!;
      state.enqueue({ id: "long-part", installation: credentials.installation, binding: binding.id, kind: "notice", channel: DM, member: ALEX, ts: "x", thread: "x", payload: "{}", created: now.toISOString() });
      state.plan("long-part", [{ text, link: { label: "Open", path: "/flows/1?card=2" } }], now);
      for (let i = 0; i < 20 && (await deliverTeamsPart(options)); i++);
      expect(sent()).toHaveLength(1);
      expect(leaks(calls)).toEqual([]);
      expect(JSON.stringify(calls)).not.toContain(":/Use");
      expect(JSON.stringify(sent()[0]!.body)).toContain("An update is ready. Open it in Toolroll.");
    });

    test("the real client guards every call", async () => {
      const bodies: string[] = [];
      const api = teamsApi(credentials, (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: "bot-token", expires_in: 3600 });
        bodies.push(String(init?.body));
        return Response.json({ id: "act-1" });
      }) as typeof fetch);
      await api("POST", SERVICE, `/v3/conversations/${encodeURIComponent(DM)}/activities`, { type: "message", text: `${PRIVATE_TITLES[0]}\nDone.`, textFormat: "plain" });
      expect(leaks(bodies)).toEqual([]);
      expect(JSON.parse(bodies[0]!)).toEqual({ type: "message", text: "An update is ready. Open it in Toolroll.", textFormat: "plain" });
    });
  });

  describe("a legacy webhook", () => {
    const post = async (subject: string, body: string) => {
      const bodies: string[] = [];
      const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response("ok"); }) as typeof fetch;
      notice("w-task", subject, body);
      const row = store.listNotifications("pending").find(one => one.dedupeKey === "needs-you:w-task")!;
      expect(await postWebhook({ kind: "slack", url: "https://hooks.slack.example/T/B/x" }, row, `${ORIGIN}/next`, fetcher)).toEqual({ ok: true });
      expect(await postWebhook({ kind: "discord", url: "https://discord.example/api/webhooks/1/x" }, row, `${ORIGIN}/next`, fetcher)).toEqual({ ok: true });
      return bodies;
    };

    test.each(PRIVATE_TITLES)("a task titled %j posts the project and a link only", async title => {
      const bodies = await post(title, "It failed.");
      expect(leaks(bodies)).toEqual([]);
      expect(JSON.parse(bodies[0]!).text).toBe(`*${SAFE}*\n<${ORIGIN}/next|open in Toolroll>`);
      expect(JSON.parse(bodies[1]!).content).toBe(`**${SAFE}**\n${ORIGIN}/next`);
    });

    test("an ordinary title passes unchanged", async () => {
      const bodies = await post(ORDINARY, "It failed.");
      expect(JSON.parse(bodies[0]!).text).toBe(`*${ORDINARY}*\nIt failed.\n<${ORIGIN}/next|open in Toolroll>`);
    });
  });

  describe("the operator's delivery command", () => {
    const envOf = (title: string) => {
      notice("c-task", title, "It failed.");
      return notificationCommandEnv(store.listNotifications("pending").find(one => one.dedupeKey === "needs-you:c-task")!);
    };

    test.each(PRIVATE_TITLES)("a task titled %j is handed over as the project and where to look only", title => {
      const env = envOf(title);
      expect(leaks(env)).toEqual([]);
      expect(env).toMatchObject({ TOOLROLL_KIND: "needs-you", TOOLROLL_SUBJECT: SAFE, TOOLROLL_BODY: "" });
    });

    test("an ordinary title passes unchanged", () => {
      expect(envOf(ORDINARY)).toMatchObject({ TOOLROLL_SUBJECT: ORDINARY, TOOLROLL_BODY: "It failed." });
    });
  });

  describe("a phone", () => {
    test.each(PRIVATE_TITLES)("a ping about a task titled %j carries only fixed words", title => {
      const ref = notice("p-private", title, `Logs at ${SECRETS[1]}`);
      const row = store.listNotifications("pending").find(one => one.dedupeKey === "needs-you:p-private")!;
      const payload = buildPushPayload(row);
      expect(leaks(payload)).toEqual([]);
      expect(JSON.parse(payload)).toMatchObject({ title: "Toolroll", body: `#${ref} needs you`, url: `/n/${ref}` });
    });

    test("the last check on a line: private words go as the class's fixed words; ordinary ones pass", () => {
      expect(privacySafeLine({ body: `unit ✓ 3 · ${SECRETS[1]}`, url: "/next" }, "progress")).toEqual({ body: "checks in progress", url: "/" });
      expect(privacySafeLine({ body: "#4 needs you", url: "/n/4" }, "attention")).toEqual({ body: "#4 needs you", url: "/n/4" });
    });
  });

  describe("an email", () => {
    const send = async (title: string) => {
      expect(saveEmailSettings(dir, { host: "smtp.shop.example", port: "587", secure: "", user: "support@shop.example", from: "support@shop.example", password: "app-password-1" }).ok).toBe(true);
      const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, stages: [] }) }, now);
      const card = store.addFlowCard({ flow, title, description: null, stage: "send", by: "alex", byKind: "person" }, now);
      const stage = { id: "send", title: "Send", kind: "email", email: { to: "priya@example.com", subject: "Update: {{card.title}}", body: "{{card.title}} is done." } };
      const sent: Mail[] = [];
      const mail = async (_settings: unknown, message: Mail) => { sent.push(message); return { ok: true as const, id: "<r1@shop.example>" }; };
      expect(await sendEmail(stage as never, store.getFlowCard(card)!, { dir, mail }, null, repo)).toMatchObject({ state: "passed" });
      return sent;
    };

    test.each(PRIVATE_TITLES)("a card titled %j is emailed as the project and where to look only", async title => {
      const sent = await send(title);
      expect(leaks(sent)).toEqual([]);
      expect(sent[0]).toMatchObject({ to: ["priya@example.com"], subject: "An update from Toolroll in shop", text: SAFE });
    });

    test("an ordinary title passes unchanged", async () => {
      const sent = await send(ORDINARY);
      expect(sent[0]).toMatchObject({ subject: `Update: ${ORDINARY}`, text: `${ORDINARY} is done.` });
    });
  });
});
