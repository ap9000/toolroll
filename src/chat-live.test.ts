/** Live replies in Slack, Discord and Teams (docs/plans/responsive-chat.md §3.2, §3.5, §12 slice 3). Scripted apps only. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { ChatState, chatHash, type ChatContent } from "./chat-delivery-state.js";
import { ackPass, liveRow, liveText, openChatLive, planWithLive, reactionsRefused, resetAckSpacing, resetLiveGates, settleLive, LIVE_WORDS, type ChatLiveTransport } from "./chat-live.js";
import { LIVE_STATUS } from "./live-reply.js";
import { SlackError, SLACK_MANIFEST, type SlackApi } from "./slack-api.js";
import { deliverSlackPart, processSlackEvent, receiveSlack, slackAckHooks, slackLivePayload, slackVoiceBlocks, type SlackChatOptions } from "./slack-chat.js";
import { discordAckHooks, discordLive } from "./discord-chat.js";
import { DiscordError, discordApi, type DiscordApi } from "./discord-api.js";
import { teamsAckHooks, teamsLive } from "./teams-chat.js";
import { workChatQueue, DELIVER_PER_PASS } from "./chat-follow.js";
import type { LeadProgress } from "./lead-progress.js";

const ID = { installation: "installation-live", team: "TLIVE", app: "ALIVE", bot: "UBOT", workspace: "Live workspace" };
const MEMBER = "UOWNER", CHANNEL = "DOWNER", TS = "1789700000.000001";
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const turn = (kind: LeadProgress["kind"], extra: Record<string, unknown> = {}): LeadProgress => ({ kind, turn: 1, step: 1, ...extra }) as LeadProgress;

let dir: string, store: Store, state: ChatState, now: Date;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-live-")));
  store = openStore(join(dir, "state.db"));
  state = new ChatState(store, "slack");
  now = new Date("2026-11-08T20:00:00Z");
  resetLiveGates();
  resetAckSpacing();
  const added = addApprover(store, "alex", now);
  if (!added.ok) throw Error("account");
  state.lease(ID.installation, "test", now);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const pair = (chat = state) => {
  const code = chat.pairing(ID.installation, "alex", store.accountOf("alex")!.generation, now);
  return chat.pair(ID, chatHash(code), MEMBER, CHANNEL, now)!;
};
const saveEvent = (id: string, chat = state, binding: number | null = null) =>
  chat.enqueue({ id, installation: ID.installation, binding, kind: "message", channel: CHANNEL, member: MEMBER, ts: TS, thread: TS, payload: { text: "hello" }, created: now.toISOString() });

/** A scripted transport: every create and edit recorded; `hold` makes the next edit wait. */
function scripted(overrides: Partial<ChatLiveTransport> = {}) {
  const sent: Array<{ op: "create" | "edit"; text: string; message?: string }> = [];
  const transport: ChatLiveTransport = {
    platform: "slack", limit: 2_800, spacingMs: 0,
    create: async text => { sent.push({ op: "create", text }); return "1789700000.000500"; },
    edit: async (message, text) => { sent.push({ op: "edit", text, message }); },
    rateLimited: error => error instanceof SlackError && error.code === "ratelimited" ? error.retryMs : null,
    uncertain: error => !(error instanceof SlackError) || error.uncertain,
    ...overrides,
  };
  return { transport, sent };
}
const open = (transport: ChatLiveTransport, standing: () => Promise<boolean> = async () => true, event = "e1") =>
  openChatLive({ state, event: state.event(event)!, installation: ID.installation, transport, shape: {}, fenced: () => state.owns(ID.installation, "test", now), standing, now: () => now });

describe("the live message", () => {
  test("is placed once, follows the turn, closes before the reply is planned, and the reply's first part replaces it", async () => {
    saveEvent("e1");
    const { transport, sent } = scripted();
    const live = open(transport);
    live.push(turn("started"));
    await flush();
    live.push(turn("tool", { id: "a", label: "Listing tasks" }));
    await flush();
    live.push(turn("text", { text: "Two tasks are **ready** and one waits on you. More soon" }));
    await flush();
    await live.close();
    expect(sent.map(one => one.op)).toEqual(["create", "edit", "edit"]);
    expect(sent[0]!.text).toBe(`_${LIVE_WORDS.working}_`);
    expect(sent[1]!.text).toBe("_Listing tasks…_");
    // The unfinished last word stays out; the words end with the visible "not final" marker.
    expect(sent[2]!.text).toBe(`Two tasks are *ready* and one waits on you. More\n\n_Listing tasks… ${LIVE_WORDS.notFinal}_`);
    // The event is still waiting for its reply; the live message is its own row.
    expect(state.event("e1")!.state).toBe("queued");
    expect(liveRow(state, "e1")).toMatchObject({ state: "placed", message: "1789700000.000500" });
    expect(state.prepare("SELECT COUNT(*) AS n FROM chat_part WHERE provider = :provider").get()!["n"]).toBe(0);
    planWithLive(state, "e1", [{ text: "Two tasks are ready.", voice: true }, { text: "More of it.", voice: true }], now);
    const parts = state.prepare("SELECT ordinal, payload FROM chat_part WHERE provider = :provider ORDER BY ordinal").all();
    expect(JSON.parse(String(parts[0]!["payload"]))).toMatchObject({ text: "Two tasks are ready.", edit: "1789700000.000500" });
    expect(JSON.parse(String(parts[1]!["payload"])).edit).toBeUndefined();
    expect(liveRow(state, "e1")!.state).toBe("finalized");
    expect(state.event("e1")!.state).toBe("done");
  });

  test.each([
    ["a failure notice", { text: "The assistant took too long to answer. Send your message again." }, true],
    ["a card with buttons first", { text: "Result ready", decide: { rows: [[{ label: "Open", link: { label: "Open", path: "/chat" } }]] } } as ChatContent, false],
    ["a reply to a room", { text: "Room words", channel: "C123" }, false],
  ])("planning %s: replaces the live message only with words to the person's own chat", (_, first, edits) => {
    saveEvent("e1");
    state.prepare("INSERT INTO chat_live (provider, event, state, message, created, updated) VALUES (:provider, 'e1', 'placed', 'M1', 'x', 'x')").run();
    planWithLive(state, "e1", [first], now);
    const payload = JSON.parse(String(state.prepare("SELECT payload FROM chat_part WHERE provider = :provider AND ordinal = 0").get()!["payload"]));
    expect(payload.edit).toBe(edits ? "M1" : undefined);
  });

  test("a late edit in flight settles before close resolves; nothing is sent after close", async () => {
    saveEvent("e1");
    const hold = deferred();
    let editing = 0;
    const { transport, sent } = scripted({ edit: async (message, text) => { editing += 1; sent.push({ op: "edit", text, message }); await hold.promise; } });
    const live = open(transport);
    live.push(turn("started"));
    await flush();
    live.push(turn("tool", { id: "a", label: "Reading the result" }));
    await flush();
    live.push(turn("tool-result", { id: "a", outcome: { state: "succeeded" } }));
    let closed = false;
    const closing = live.close().then(() => { closed = true; });
    await flush();
    expect(closed).toBe(false);
    hold.resolve();
    await closing;
    // The waiting view was dropped; no edit after close, even when more progress arrives.
    live.push(turn("text", { text: "Late words here " }));
    await flush();
    expect(editing).toBe(1);
    expect(sent.filter(one => one.op === "edit")).toHaveLength(1);
  });

  test("Slack and Teams: a create whose answer was lost is never posted again, and the reply says one may be left", async () => {
    saveEvent("e1");
    const { transport, sent } = scripted({ create: async text => { sent.push({ op: "create", text }); throw new SlackError("Slack did not confirm delivery", 15_000, true); } });
    const live = open(transport);
    live.push(turn("started"));
    await flush();
    await live.close();
    expect(liveRow(state, "e1")!.state).toBe("uncertain");
    // The next pass (or a restart) never posts it again.
    const again = open(transport);
    again.push(turn("started"));
    await again.queued();
    await flush();
    await again.close();
    expect(sent.filter(one => one.op === "create")).toHaveLength(1);
    planWithLive(state, "e1", [{ text: "Answer" }], now);
    expect(JSON.parse(String(state.prepare("SELECT payload FROM chat_part WHERE provider = :provider").get()!["payload"])).edit).toBeUndefined();
    expect(state.prepare("SELECT problem FROM chat_event WHERE provider = :provider AND id = 'e1'").get()!["problem"]).toBe(LIVE_WORDS.maybeLeft);
  });

  test("Slack and Teams: a crash between the create and its record leaves it uncertain for the next claimant", async () => {
    saveEvent("e1");
    state.prepare("INSERT INTO chat_live (provider, event, state, created, updated) VALUES (:provider, 'e1', 'creating', 'x', 'x')").run();
    const { transport, sent } = scripted();
    const live = open(transport);
    live.push(turn("started"));
    await flush();
    await live.close();
    expect(sent).toEqual([]);
    expect(liveRow(state, "e1")!.state).toBe("uncertain");
  });

  test("Discord: a create from before a restart is the same message, found by its nonce", async () => {
    const discord = new ChatState(store, "discord");
    discord.lease(ID.installation, "test", now);
    discord.enqueue({ id: "d1", installation: ID.installation, binding: null, kind: "message", channel: "123456789012345678", member: "223456789012345678", ts: "323456789012345678", thread: "323456789012345678", payload: { text: "hi" }, created: now.toISOString() });
    discord.prepare("INSERT INTO chat_live (provider, event, state, created, updated) VALUES (:provider, 'd1', 'creating', 'x', 'x')").run();
    const nonce = chatHash("discord:live:d1").slice(0, 24);
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const api: DiscordApi = async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "GET") return { items: [{ id: "423456789012345678", nonce, channel_id: "123456789012345678", author: { id: "523456789012345678" } }] };
      return { id: "423456789012345678", channel_id: "123456789012345678", author: { id: "523456789012345678" } };
    };
    const transport = { ...discordLive({ api, identity: { ...ID, bot: "523456789012345678" } }, discord.event("d1")!), spacingMs: 0 };
    await settleLive(discord, "d1", transport, () => now);
    expect(liveRow(discord, "d1")).toMatchObject({ state: "placed", message: "423456789012345678" });
    const live = openChatLive({ state: discord, event: discord.event("d1")!, installation: ID.installation, transport, shape: {}, fenced: () => true, standing: async () => true, now: () => now });
    live.push(turn("started"));
    live.push(turn("text", { text: "Ask @everyone about <@123> now " }));
    await flush();
    await live.close();
    expect(calls.filter(one => one.method === "POST")).toEqual([]);
    // Every edit is the whole message: an embed, no content, no buttons, and never a ping.
    const patch = calls.find(one => one.method === "PATCH")!;
    expect(patch.path).toBe("/channels/123456789012345678/messages/423456789012345678");
    expect(patch.body).toMatchObject({ content: "", components: [], allowed_mentions: { parse: [], replied_user: false } });
    expect((patch.body!.embeds as Array<{ description: string }>)[0]!.description).toContain("@​everyone");
  });

  test("access lost mid-turn: no edit after it, cleanup included; the row is abandoned and its last words say not final", async () => {
    saveEvent("e1");
    let allowed = true;
    const { transport, sent } = scripted();
    const live = open(transport, async () => allowed);
    live.push(turn("started"));
    await flush();
    live.push(turn("text", { text: "The release is blocked by one check " }));
    await flush();
    now = new Date(now.getTime() + 6_000);
    state.lease(ID.installation, "test", now);
    allowed = false;
    live.push(turn("text", { text: "The release is blocked by one check that fails on main " }));
    await flush();
    await live.close();
    expect(sent.map(one => one.op)).toEqual(["create", "edit"]);
    expect(sent.at(-1)!.text.endsWith(`_${LIVE_WORDS.notFinal}_`)).toBe(true);
    expect(liveRow(state, "e1")!.state).toBe("abandoned");
  });

  test("a cooldown holds every live send; a 'slow down' on an edit sets it for durable delivery too", async () => {
    saveEvent("e1");
    state.deferUntil(ID.installation, new Date(now.getTime() + 30_000).toISOString());
    const quiet = scripted();
    const held = open(quiet.transport);
    held.push(turn("started"));
    held.push(turn("tool", { id: "a", label: "Listing tasks" }));
    await flush();
    await held.close();
    expect(quiet.sent).toEqual([]);

    now = new Date(now.getTime() + 60_000);
    state.lease(ID.installation, "test", now);
    const slowed = scripted({ edit: async () => { throw new SlackError("ratelimited", 20_000); } });
    const live = open(slowed.transport);
    live.push(turn("started"));
    await flush();
    live.push(turn("tool", { id: "a", label: "Listing tasks" }));
    await flush();
    await live.close();
    expect(state.retryAt(ID.installation)).toBe(new Date(now.getTime() + 20_000).toISOString());
  });

  test("a waiting message shows the fixed waiting words once, and the turn's later pass edits that same message", async () => {
    saveEvent("e1");
    const { transport, sent } = scripted();
    const waiting = open(transport, async () => false);
    await waiting.queued();
    await waiting.close();
    expect(sent).toEqual([{ op: "create", text: `_${LIVE_STATUS.queued}_` }]);
    const later = open(transport);
    later.push(turn("started"));
    later.push(turn("tool", { id: "a", label: "Listing tasks" }));
    await flush();
    await later.close();
    expect(sent.slice(1)).toEqual([{ op: "edit", text: "_Listing tasks…_", message: "1789700000.000500" }]);
  });

  test("a long partial keeps its first window, measured after rendering, and says it continues", () => {
    const text = liveText({ phase: "writing", status: LIVE_STATUS.writing, text: `${"word & more ".repeat(400)}end` }, "slack", 2_800)!;
    expect(text.length).toBeLessThanOrEqual(2_800);
    expect(text).toContain(`_${LIVE_WORDS.continues}_`);
    expect(text.endsWith(`_${LIVE_WORDS.notFinal}_`)).toBe(true);
    expect(text).not.toMatch(/&(?!amp;)/);
  });
});

describe("payloads", () => {
  test("Slack: verbatim on every mrkdwn text object, live and final; mention syntax stays escaped", () => {
    const rendered = liveText({ phase: "writing", status: LIVE_STATUS.writing, text: "Ping @here and <!channel> and <@U123> please now" }, "slack", 2_800)!;
    const payload = slackLivePayload(CHANNEL, rendered);
    expect(payload).toMatchObject({ parse: "none", link_names: false, mrkdwn: true, unfurl_links: false, unfurl_media: false });
    const blocks = payload.blocks as Array<{ text: { type: string; verbatim?: boolean; text: string } }>;
    for (const block of [...blocks, ...slackVoiceBlocks("A *final* reply with @here")]) expect(block.text).toMatchObject({ type: "mrkdwn", verbatim: true });
    expect(JSON.stringify(blocks)).toContain("&lt;!channel&gt;");
    expect(JSON.stringify(blocks)).not.toContain("<!channel>");
    expect(SLACK_MANIFEST.oauth_config.scopes.bot).toContain("reactions:write");
  });

  test("Teams: the live message is one Markdown activity, replaced whole by PUT; no service address, no live message", async () => {
    const teams = new ChatState(store, "teams");
    teams.enqueue({ id: "t1", installation: ID.installation, binding: null, kind: "message", channel: "a:1dm-conversation", member: "29:1someone-xxxxxxxxxxxx", ts: "1", thread: "1", payload: { text: "hi" }, created: now.toISOString() });
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const api = async (method: "GET" | "POST" | "PUT", _url: string, path: string, body?: Record<string, unknown>) => { calls.push({ method, path, body }); return { id: "act-1" }; };
    expect(teamsLive({ api, identity: ID }, teams, teams.event("t1")!)).toBeNull();
    teams.setMeta(ID.installation, "serviceUrl:a:1dm-conversation", "https://smba.trafficmanager.net/teams/", now);
    const transport = teamsLive({ api, identity: ID }, teams, teams.event("t1")!)!;
    expect(await transport.create("_Working on it…_")).toBe("act-1");
    await transport.edit("act-1", "Words\n\n_(still writing — not final)_");
    expect(calls).toEqual([
      { method: "POST", path: "/v3/conversations/a%3A1dm-conversation/activities", body: { type: "message", text: "_Working on it…_", textFormat: "markdown" } },
      { method: "PUT", path: "/v3/conversations/a%3A1dm-conversation/activities/act-1", body: { type: "message", text: "Words\n\n_(still writing — not final)_", textFormat: "markdown" } },
    ]);
  });

  test("Discord's REST wrapper admits the 👀 (on and off) and no other reaction", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const api = discordApi("a".repeat(40), fetcher);
    const path = "/channels/123456789012345678/messages/223456789012345678/reactions";
    await expect(api("PUT", `${path}/%F0%9F%91%80/@me`)).resolves.toEqual({});
    await expect(api("DELETE", `${path}/%F0%9F%91%80/@me`)).resolves.toEqual({});
    await expect(api("PUT", `${path}/%F0%9F%91%8D/@me`)).rejects.toThrow("Invalid Discord request");
    await expect(api("DELETE", "/channels/123456789012345678/messages/223456789012345678")).rejects.toThrow("Invalid Discord request");
  });
});

describe("the 👀", () => {
  const slackCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let answer: (method: string) => unknown;
  const api: SlackApi = async (method, args = {}) => { slackCalls.push({ method, args }); const out = answer(method); if (out instanceof Error) throw out; return out as Record<string, unknown>; };
  const pass = () => ackPass({ state, installation: ID.installation, owner: "test", current: () => true, hooks: slackAckHooks({ api }), now: () => now });
  beforeEach(() => { slackCalls.length = 0; answer = () => ({}); });

  test("goes on the owner's own message as it arrives, beside the queue, and comes off once its reply is delivered", async () => {
    const binding = pair();
    saveEvent("e1", state, binding.id);
    expect(await pass()).toBe(true);
    expect(slackCalls).toEqual([{ method: "reactions.add", args: { channel: CHANNEL, timestamp: TS, name: "eyes" } }]);
    expect(await pass()).toBe(false);
    state.plan("e1", [{ text: "Answer" }], now);
    // Planned but not yet delivered: it stays on.
    expect(await pass()).toBe(false);
    state.prepare("UPDATE chat_part SET state = 'sent', message = 'M' WHERE provider = :provider AND event = 'e1'").run();
    expect(await pass()).toBe(true);
    expect(slackCalls.at(-1)).toEqual({ method: "reactions.remove", args: { channel: CHANNEL, timestamp: TS, name: "eyes" } });
    expect(await pass()).toBe(false);
  });

  test("an install without reactions:write: skipped quietly, asked again at most once a minute, and settings learn it", async () => {
    const binding = pair();
    answer = method => method === "reactions.add" ? new SlackError("missing_scope") : {};
    saveEvent("e1", state, binding.id);
    expect(await pass()).toBe(true);
    expect(reactionsRefused(state, ID.installation, now)).toBe(true);
    now = new Date(now.getTime() + 2_000);
    saveEvent("e2", state, binding.id);
    expect(await pass()).toBe(true);
    expect(slackCalls.filter(one => one.method === "reactions.add")).toHaveLength(1);
    expect(state.prepare("SELECT state FROM chat_ack WHERE provider = :provider ORDER BY event").all().map(row => row["state"])).toEqual(["skipped", "skipped"]);
    expect(state.runtime(ID.installation)?.problem ?? null).toBeNull();
    // Reinstalled: the next try (a minute on) succeeds and clears it.
    answer = () => ({});
    now = new Date(now.getTime() + 61_000);
    state.lease(ID.installation, "test", now);
    saveEvent("e3", state, binding.id);
    expect(await pass()).toBe(true);
    expect(reactionsRefused(state, ID.installation, now)).toBe(false);
  });

  test.each([
    ["someone else's message", { member: "UOTHER" }],
    ["a room", { channel: "C0ROOM" }],
    ["an old message", { created: "2026-11-08T19:58:00.000Z" }],
  ])("never on %s", async (_, extra) => {
    const binding = pair();
    state.enqueue({ id: "x1", installation: ID.installation, binding: binding.id, kind: "message", channel: CHANNEL, member: MEMBER, ts: TS, thread: TS, payload: { text: "hi" }, created: now.toISOString(), ...extra });
    expect(await pass()).toBe(false);
    expect(slackCalls).toEqual([]);
  });

  test("a burst from one person: one 👀 a second; Discord takes its own off with DELETE; Teams types instead", async () => {
    const binding = pair();
    saveEvent("e1", state, binding.id);
    state.enqueue({ id: "e2", installation: ID.installation, binding: binding.id, kind: "message", channel: CHANNEL, member: MEMBER, ts: "1789700000.000002", thread: "1789700000.000002", payload: { text: "and" }, created: now.toISOString() });
    expect(await pass()).toBe(true);
    expect(await pass()).toBe(false);
    now = new Date(now.getTime() + 1_000);
    expect(await pass()).toBe(true);
    expect(slackCalls.map(one => one.args.timestamp)).toEqual([TS, "1789700000.000002"]);

    const discordCalls: Array<[string, string]> = [];
    const discordHooks = discordAckHooks({ api: async (method, path) => { discordCalls.push([method, path]); if (method === "DELETE") throw new DiscordError("The Discord message or conversation is unavailable. Open the saved chat."); return {}; } });
    const event = state.event("e1")!;
    await discordHooks.react!(event);
    await expect(discordHooks.unreact!(event)).rejects.toThrow();
    expect(discordCalls.map(([method]) => method)).toEqual(["PUT", "DELETE"]);
    expect(discordCalls[0]![1]).toContain("/reactions/%F0%9F%91%80/@me");

    const teams = new ChatState(store, "teams");
    const typed: unknown[] = [];
    teams.setMeta(ID.installation, `serviceUrl:${CHANNEL}`, "https://smba.trafficmanager.net/teams/", now);
    await teamsAckHooks({ api: async (_m, _u, _p, body) => { typed.push(body); return {}; }, identity: ID }, teams).typing!(event);
    expect(typed).toEqual([{ type: "typing" }]);
  });
});

describe("Slack end to end", () => {
  let repo: string, calls: Array<{ method: string; args: Record<string, unknown> }>, options: SlackChatOptions;
  beforeEach(() => {
    repo = join(dir, "repo");
    mkdirSync(repo);
    mkdirSync(join(dir, "evidence"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Synthetic live test\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", now);
    calls = [];
    let posted = 100;
    const api: SlackApi = async (method, args = {}) => {
      calls.push({ method, args });
      if (method === "users.info") return { user: { id: MEMBER, team_id: ID.team, deleted: false, is_bot: false } };
      if (method === "conversations.info") return { channel: { id: CHANNEL, is_im: true, user: MEMBER } };
      if (method === "chat.postMessage") return { ts: `1789700000.${String(posted++).padStart(6, "0")}` };
      if (method === "chat.update") return { ts: args.ts };
      return {};
    };
    options = {
      store, identity: ID, api, owner: "test", readProjects: async () => [repo], evidenceRoot: join(dir, "evidence"), current: () => true,
      origin: () => "https://console.example", clock: () => now, liveReplies: { spacingMs: 0 },
      subscriptionRunner: vi.fn(async request => {
        request.onText?.("Nothing needs you right now. Two tasks are ");
        await flush();
        request.onText?.("Nothing needs you right now. Two tasks are building and ");
        await flush();
        return { ok: true as const, answer: { text: "Nothing needs you right now. Two tasks are building and one is ready for review.", calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } };
      }),
    };
    pair();
  });

  test("one message: a live message in its thread, edits while it writes, and the reply replaces it in place with no second message", async () => {
    expect(receiveSlack(state, ID, "events_api", { api_app_id: ID.app, team_id: ID.team, event_id: "Ev1", event: { type: "message", channel_type: "im", user: MEMBER, channel: CHANNEL, ts: TS, text: "what needs me?" } }, now)).toBe(true);
    expect(await processSlackEvent(options)).toBe(true);
    const posts = calls.filter(one => one.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args).toMatchObject({ channel: CHANNEL, thread_ts: TS, text: `_${LIVE_WORDS.working}_` });
    const live = String(liveRow(state, state.prepare("SELECT id FROM chat_event WHERE provider = :provider").get()!["id"] as string)!.message);
    const edits = calls.filter(one => one.method === "chat.update");
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.every(one => one.args.ts === live && String(one.args.text).endsWith(`_${LIVE_WORDS.notFinal}_`))).toBe(true);
    for (let i = 0; i < 5 && await deliverSlackPart(options); i++);
    const final = calls.at(-1)!;
    expect(final).toMatchObject({ method: "chat.update", args: { ts: live, link_names: false } });
    expect(String(final.args.text)).toContain("one is ready for review.");
    expect(String(final.args.text)).not.toContain(LIVE_WORDS.notFinal);
    expect((final.args.blocks as Array<{ text: { verbatim?: boolean } }>).every(block => block.text.verbatim === true)).toBe(true);
    expect(calls.filter(one => one.method === "chat.postMessage")).toHaveLength(1);
  });

  test("the live message was deleted: the reply goes out as a new message instead of retrying forever", async () => {
    receiveSlack(state, ID, "events_api", { api_app_id: ID.app, team_id: ID.team, event_id: "Ev2", event: { type: "message", channel_type: "im", user: MEMBER, channel: CHANNEL, ts: TS, text: "what needs me?" } }, now);
    await processSlackEvent(options);
    const real = options.api;
    options.api = async (method, args) => method === "chat.update" ? Promise.reject(new SlackError("message_not_found")) : real(method, args);
    for (let i = 0; i < 5 && await deliverSlackPart(options); i++);
    const last = calls.filter(one => one.method === "chat.postMessage").at(-1)!;
    expect(String(last.args.text)).toContain("one is ready for review.");
  });
});

test("a pass delivers up to five parts, stopping at the first rate signal", async () => {
  let delivered = 0, ready = true, passes = 0;
  await workChatQueue({
    same: () => passes < 1, ready: () => ready, pause: async () => { passes += 1; }, notifications: () => false,
    process: async () => true, rooms: async () => true, notify: async () => true,
    deliver: async () => { delivered += 1; if (delivered === 3) ready = false; return true; },
  });
  expect(delivered).toBe(3);
  expect(DELIVER_PER_PASS).toBe(5);
});

test("due reply parts go out before the next event starts another turn", async () => {
  const log: string[] = [];
  const events = ["turn 1", "turn 2"];
  const due: string[] = [];
  let passes = 0;
  await workChatQueue({
    same: () => passes < 6, ready: () => true, pause: async () => { passes += 1; }, notifications: () => false,
    rooms: async () => true, notify: async () => true,
    process: async () => {
      const event = events.shift();
      if (!event) return false;
      log.push(event);
      for (let part = 1; part <= 6; part++) due.push(`${event} part ${part}`);
      return true;
    },
    deliver: async () => { const part = due.shift(); if (!part) return false; log.push(part); return true; },
  });
  expect(log.indexOf("turn 1 part 6")).toBeLessThan(log.indexOf("turn 2"));
  expect(log).toHaveLength(14);
});
