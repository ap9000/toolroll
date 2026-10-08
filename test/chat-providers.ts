/**
 * One scripted wire per chat app, behind the same few verbs, so a contract can be run against Telegram, Slack, Discord
 * and Teams alike: mint a pairing code (as each app's settings page does), say something in a chat, run the app's
 * worker once, read the messages a chat now shows, and tap a button on one. Each drives the app's own entry points —
 * Telegram's bridge pass, and Slack's, Discord's and Teams' receive, process, plan and deliver — against fixture APIs.
 * Nothing here reaches a network; no live account acceptance is claimed.
 */
import { ChatState, chatHash } from "../src/chat-delivery-state.js";
import type { ChatProvider } from "../src/contracts/chat-tables.js";
import type { Store } from "../src/store.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "../src/telegram.js";
import { deliverSlackPart, planSlackNotifications, processSlackEvent, receiveSlack, type SlackChatOptions } from "../src/slack-chat.js";
import type { SlackApi } from "../src/slack-api.js";
import { deliverDiscordPart, planDiscordNotifications, processDiscordEvent, receiveDiscord, type DiscordChatOptions } from "../src/discord-chat.js";
import type { DiscordApi } from "../src/discord-api.js";
import { deliverTeamsPart, planTeamsNotifications, processTeamsEvent, receiveTeams, type TeamsChatOptions } from "../src/teams-chat.js";
import { teamsIdentity, type TeamsApi, type TeamsCredentials } from "../src/teams-api.js";

/** One message as its chat shows it now (its newest edit): its words and its buttons. */
export type ChatCard = { message: string; text: string; buttons: Array<{ label: string; token?: string; url?: string; action?: string }> };

export type ChatWorld = {
  store: Store;
  clock: () => Date;
  evidenceRoot: string;
  projects: () => readonly string[];
  origin: string;
  /** How a Merge tapped in chat reaches GitHub. */
  merge: (input: { runId: number; by: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
};

export type ChatHarness = {
  provider: ChatProvider;
  /** The app's installation (Telegram: the bot). */
  installation: string;
  /** Mint a one-time pairing code as this app's settings page does. */
  mint(who: string): string;
  /** Send "pair <code>" (Telegram: "/pair <code>") from a member's own private chat. */
  sendPair(code: string, member: string): void;
  /** A message from a member's own private chat; `replyTo`: the message it answers. */
  say(text: string, member: string, replyTo?: string): void;
  /** Tap a button on a card, from a member's own private chat. */
  tap(card: ChatCard, label: RegExp, member: string): void;
  /** Tap a token on a message (a stale or foreign button). */
  tapToken(token: string, message: string, member: string, action?: string): void;
  /** Deliver an inbound event again, exactly as the app redelivers one (same event id). */
  redeliver(): void;
  /** Run the app's worker once: apply what came in, plan notifications, send what is due. */
  pass(): Promise<void>;
  /** Every message a member's private chat shows now, oldest first. */
  cards(member: string): ChatCard[];
  /** The next `count` sends fail as a network failure would. */
  failSends(count: number): void;
  /** How many messages (not edits) were posted to a member's chat. */
  posted(member: string): number;
  /** The chat a member's private messages go to. */
  chatOf(member: string): string;
  /** A member id this app gives a person (0, 1, 2: different people). */
  member(index: number): string;
};

type Sent = { chat: string; message: string; text: string; buttons: ChatCard["buttons"]; edit: boolean };

function newCards(log: readonly Sent[], chat: string): ChatCard[] {
  const byMessage = new Map<string, ChatCard>();
  for (const one of log) if (one.chat === chat) byMessage.set(one.message, { message: one.message, text: one.text, buttons: one.buttons });
  return [...byMessage.values()];
}

// ---- Telegram ---------------------------------------------------------------------------------------------------

export function telegramHarness(world: ChatWorld): ChatHarness {
  const BOT = "777000";
  const log: Sent[] = [];
  const updates: unknown[][] = [];
  // Update ids carry on from the newest this bot has applied (a harness on an upgraded file never replays one).
  let next = 100, failing = 0;
  let update = Number(world.store.handle.prepare("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 9) + 1 AS n FROM chat_event WHERE provider = 'telegram' AND kind = 'update'").get()?.["n"] ?? 10);
  let last: unknown = null;
  const transport: TelegramTransport = async (method, params) => {
    if (method === "getUpdates") {
      const offset = Number(params["offset"] ?? 0);
      return { ok: true, result: (updates.shift() ?? []).filter(one => Number((one as { update_id: number }).update_id) >= offset) };
    }
    if ((method === "sendMessage" || method === "editMessageText") && failing > 0) {
      failing--;
      return { ok: false, description: "Bad Gateway", error_code: 502 };
    }
    const markup = (params["reply_markup"] as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>> } | undefined)?.inline_keyboard ?? [];
    const buttons = markup.flat().map(one => ({ label: one.text, ...(one.callback_data === undefined ? {} : { token: one.callback_data }), ...(one.url === undefined ? {} : { url: one.url }) }));
    if (method === "sendMessage") {
      const message = String(next++);
      log.push({ chat: String(params["chat_id"]), message, text: String(params["text"] ?? ""), buttons, edit: false });
      return { ok: true, result: { message_id: Number(message) } };
    }
    if (method === "editMessageText") {
      log.push({ chat: String(params["chat_id"]), message: String(params["message_id"]), text: String(params["text"] ?? ""), buttons, edit: true });
      return { ok: true, result: { message_id: params["message_id"] } };
    }
    if (method === "getMyName") return { ok: true, result: { name: "Toolroll" } };
    return { ok: true, result: true };
  };
  const push = (one: unknown) => { last = one; updates.push([one]); };
  const tapToken = (token: string, message: string, member: string) =>
    push({ update_id: update++, callback_query: { id: `cb-${update}`, data: token, from: { id: Number(member) }, message: { message_id: Number(message), chat: { id: Number(member) },
      text: log.filter(one => one.message === message).at(-1)?.text ?? "" } } });
  return {
    provider: "telegram",
    installation: BOT,
    mint(who) {
      const code = mintPairingCode();
      world.store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, world.clock());
      return code;
    },
    sendPair(code, member) {
      push({ update_id: update++, message: { message_id: 1000 + update, chat: { id: Number(member), type: "private" }, from: { id: Number(member) }, text: `/pair ${code}` } });
    },
    say(text, member, replyTo) {
      push({ update_id: update++, message: { message_id: 2000 + update, chat: { id: Number(member), type: "private" }, from: { id: Number(member) }, text,
        ...(replyTo === undefined ? {} : { reply_to_message: { message_id: Number(replyTo) } }) } });
    },
    tap(card, label, member) {
      const button = card.buttons.find(one => label.test(one.label) && one.token !== undefined);
      if (button === undefined) throw new Error(`telegram: no ${label} button on ${JSON.stringify(card)}`);
      tapToken(button.token!, card.message, member);
    },
    tapToken,
    redeliver() { updates.push([last]); },
    async pass() {
      await bridgePass(world.store, { botId: BOT, transport, clock: world.clock, readProjects: async () => world.projects(),
        conversation: { evidenceRoot: world.evidenceRoot, phoneOrigin: () => world.origin, merge: world.merge } });
    },
    cards: member => newCards(log, member),
    failSends(count) { failing = count; },
    posted: member => log.filter(one => one.chat === member && !one.edit).length,
    chatOf: member => member,
    member: index => String(4242 + index),
  };
}

// ---- Slack --------------------------------------------------------------------------------------------------------

export function slackHarness(world: ChatWorld): ChatHarness {
  const ID = { installation: "slack-installation", team: "TTEST", app: "ATEST", bot: "UBOT", workspace: "Test workspace" };
  const state = new ChatState(world.store, "slack");
  const log: Sent[] = [];
  let serial = 0, failing = 0;
  let last: [string, unknown] | null = null;
  const dm = (member: string) => `D${member}`;
  const api: SlackApi = async (method, args = {}) => {
    if (method === "users.info") return { user: { id: args["user"], team_id: ID.team, deleted: false, is_bot: false } };
    if (method === "conversations.info") return { channel: { id: args["channel"], is_im: true, user: String(args["channel"]).slice(1) } };
    if ((method === "chat.postMessage" || method === "chat.update") && failing > 0) {
      failing--;
      throw new Error("fetch failed");
    }
    const blocks = (args["blocks"] as Array<{ type: string; elements?: Array<Record<string, unknown>> }> | undefined) ?? [];
    const buttons = blocks.filter(block => block.type === "actions").flatMap(block => block.elements ?? []).map(one => ({
      label: String((one["text"] as { text?: string } | undefined)?.text ?? ""), ...(typeof one["value"] === "string" ? { token: one["value"] } : {}),
      ...(typeof one["url"] === "string" ? { url: one["url"] } : {}), action: String(one["action_id"] ?? "") }));
    const text = blocks.filter(block => block.type === "header" || block.type === "section").map(block => String((block as { text?: { text?: string } }).text?.text ?? "")).join("\n") || String(args["text"] ?? "");
    if (method === "chat.postMessage") {
      const ts = `1789700000.${String(++serial).padStart(6, "0")}`;
      log.push({ chat: String(args["channel"]), message: ts, text, buttons, edit: false });
      return { ts };
    }
    if (method === "chat.update") {
      log.push({ chat: String(args["channel"]), message: String(args["ts"]), text, buttons, edit: true });
      return { ts: args["ts"] };
    }
    return {};
  };
  const options: SlackChatOptions = { store: world.store, identity: ID, api, owner: "test", readProjects: async () => world.projects(), evidenceRoot: world.evidenceRoot,
    current: () => true, origin: () => world.origin, clock: world.clock, upload: async () => {} };
  const receive = (type: string, body: unknown) => { last = [type, body]; receiveSlack(state, ID, type, body, world.clock()); };
  const message = (text: string, member: string, extra: Record<string, unknown> = {}) => ({ api_app_id: ID.app, team_id: ID.team, event_id: `Ev${++serial}`,
    event: { type: "message", channel_type: "im", user: member, channel: dm(member), ts: `1789600000.${String(++serial).padStart(6, "0")}`, text, ...extra } });
  const tapToken = (token: string, message: string, member: string, action = "toolroll_decide_0") =>
    receive("interactive", { api_app_id: ID.app, team: { id: ID.team }, type: "block_actions", user: { id: member }, channel: { id: dm(member) },
      container: { type: "message", channel_id: dm(member), message_ts: message }, actions: [{ action_id: action, value: token, action_ts: `1789700000.${String(++serial).padStart(6, "0")}` }] });
  return {
    provider: "slack",
    installation: ID.installation,
    mint: who => state.pairing(ID.installation, who, world.store.accountOf(who)!.generation, world.clock()),
    sendPair: (code, member) => receive("events_api", message(`pair ${code}`, member)),
    say: (text, member, replyTo) => receive("events_api", message(text, member, replyTo === undefined ? {} : { thread_ts: replyTo })),
    tap(card, label, member) {
      const button = card.buttons.find(one => label.test(one.label) && one.token !== undefined);
      if (button === undefined) throw new Error(`slack: no ${label} button on ${JSON.stringify(card)}`);
      tapToken(button.token!, card.message, member, button.action);
    },
    tapToken,
    redeliver() { if (last !== null) receiveSlack(state, ID, last[0], last[1], world.clock()); },
    async pass() {
      state.lease(ID.installation, "test", world.clock());
      for (let i = 0; i < 20 && (await processSlackEvent(options)); i++);
      await planSlackNotifications(options);
      for (let i = 0; i < 40 && (await deliverSlackPart(options)); i++);
    },
    cards: member => newCards(log, dm(member)),
    failSends(count) { failing = count; },
    posted: member => log.filter(one => one.chat === dm(member) && !one.edit).length,
    chatOf: dm,
    member: index => `U${String.fromCharCode(65 + index)}MEMBER`,
  };
}

// ---- Discord ------------------------------------------------------------------------------------------------------

export function discordHarness(world: ChatWorld): ChatHarness {
  const BOT = "100000000000000001";
  const ID = { app: BOT, bot: BOT, workspace: "Synthetic application", installation: chatHash(`discord:${BOT}:${BOT}`) };
  const state = new ChatState(world.store, "discord");
  const log: Sent[] = [];
  let serial = 0, failing = 0;
  let last: [string, unknown] | null = null;
  const snow = () => String(100000000000001000n + BigInt(++serial));
  const dm = (member: string) => `9${member.slice(1)}`;
  const memberOf = (channel: string) => `1${channel.slice(1)}`;
  const api: DiscordApi = async (method, path, body = {}) => {
    const user = /^\/users\/(\d+)$/.exec(path);
    if (user !== null) return { id: user[1] };
    const channel = /^\/channels\/(\d+)$/.exec(path);
    if (channel !== null) return { id: channel[1], type: 1, recipients: [{ id: memberOf(channel[1]!) }] };
    if (method === "GET") return { items: [] };
    if (failing > 0) {
      failing--;
      throw new Error("fetch failed");
    }
    const to = /^\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(path);
    const embed = ((body["embeds"] as Array<{ title?: string; description?: string }> | undefined) ?? [])[0];
    const text = [embed?.title === "Toolroll" ? "" : embed?.title ?? "", embed?.description ?? String(body["content"] ?? "")].filter(one => one !== "").join("\n");
    const buttons = ((body["components"] as Array<{ components: Array<Record<string, unknown>> }> | undefined) ?? []).flatMap(row => row.components).map(one => ({
      label: String(one["label"] ?? ""), ...(typeof one["custom_id"] === "string" ? { token: String(one["custom_id"]).slice(3) } : {}),
      ...(typeof one["url"] === "string" ? { url: one["url"] } : {}) }));
    const id = method === "PATCH" ? to![2]! : snow();
    log.push({ chat: to![1]!, message: id, text, buttons, edit: method === "PATCH" });
    return { id, channel_id: to![1], author: { id: BOT } };
  };
  const options: DiscordChatOptions = { store: world.store, identity: ID, api, owner: "test", current: () => true, readProjects: async () => world.projects(),
    evidenceRoot: world.evidenceRoot, origin: () => world.origin, clock: world.clock };
  const receive = (type: string, body: unknown) => { last = [type, body]; receiveDiscord(state, ID, type, body, world.clock()); };
  const tapToken = (token: string, message: string, member: string) =>
    receive("INTERACTION_CREATE", { id: snow(), application_id: ID.app, type: 3, channel_id: dm(member), channel: { id: dm(member), type: 1 }, user: { id: member },
      message: { id: message, channel_id: dm(member), author: { id: BOT } }, data: { component_type: 2, custom_id: `so_${token}` }, token: "interaction-credential-must-not-persist" });
  return {
    provider: "discord",
    installation: ID.installation,
    mint: who => state.pairing(ID.installation, who, world.store.accountOf(who)!.generation, world.clock()),
    sendPair: (code, member) => receive("MESSAGE_CREATE", { id: snow(), channel_id: dm(member), author: { id: member }, type: 0, content: `pair ${code}` }),
    say: (text, member, replyTo) => receive("MESSAGE_CREATE", { id: snow(), channel_id: dm(member), author: { id: member }, type: replyTo === undefined ? 0 : 19, content: text,
      ...(replyTo === undefined ? {} : { message_reference: { message_id: replyTo, channel_id: dm(member) } }) }),
    tap(card, label, member) {
      const button = card.buttons.find(one => label.test(one.label) && one.token !== undefined);
      if (button === undefined) throw new Error(`discord: no ${label} button on ${JSON.stringify(card)}`);
      tapToken(button.token!, card.message, member);
    },
    tapToken,
    redeliver() { if (last !== null) receiveDiscord(state, ID, last[0], last[1], world.clock()); },
    async pass() {
      state.lease(ID.installation, "test", world.clock());
      for (let i = 0; i < 20 && (await processDiscordEvent(options)); i++);
      await planDiscordNotifications(options);
      for (let i = 0; i < 40 && (await deliverDiscordPart(options)); i++);
    },
    cards: member => newCards(log, dm(member)),
    failSends(count) { failing = count; },
    posted: member => log.filter(one => one.chat === dm(member) && !one.edit).length,
    chatOf: dm,
    member: index => String(100000000000000002n + BigInt(index)),
  };
}

// ---- Teams --------------------------------------------------------------------------------------------------------

export function teamsHarness(world: ChatWorld): ChatHarness {
  const APP = "11111111-2222-4333-8444-555555555555", TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", SERVICE = "https://smba.trafficmanager.net/teams/";
  const credentials: TeamsCredentials = { ...teamsIdentity(APP, TENANT), tenant: TENANT, secret: "secret-value-for-tests-1234567890" };
  const state = new ChatState(world.store, "teams");
  const log: Sent[] = [];
  let ids = 0, failing = 0;
  let last: unknown = null;
  const dm = (member: string) => `a:dm-${member}`;
  const api: TeamsApi = async (method, _serviceUrl, path, body) => {
    if (method === "GET") return { id: decodeURIComponent(path.split("/members/")[1] ?? "") };
    if (failing > 0) {
      failing--;
      throw new Error("fetch failed");
    }
    const conversation = decodeURIComponent(/\/v3\/conversations\/([^/]+)\/activities/.exec(path)?.[1] ?? "");
    const card = ((body?.["attachments"] as Array<{ content?: { body?: Array<{ text?: string }>; actions?: Array<Record<string, unknown>> } }> | undefined) ?? [])[0]?.content;
    const text = card?.body?.[0]?.text ?? String(body?.["text"] ?? "");
    const buttons = (card?.actions ?? []).map(one => ({ label: String(one["title"] ?? ""),
      ...(typeof (one["data"] as { so?: unknown } | undefined)?.so === "string" ? { token: String((one["data"] as { so: string }).so) } : {}),
      ...(typeof one["url"] === "string" ? { url: one["url"] } : {}) }));
    const edited = /\/activities\/([^/]+)$/.exec(path)?.[1];
    const id = method === "PUT" && edited !== undefined ? decodeURIComponent(edited) : `act-${++ids}`;
    log.push({ chat: conversation, message: id, text, buttons, edit: method === "PUT" });
    return { id };
  };
  const options: TeamsChatOptions = { store: world.store, identity: credentials, api, owner: "test", current: () => true, readProjects: async () => world.projects(),
    evidenceRoot: world.evidenceRoot, origin: () => world.origin, clock: world.clock };
  const receive = (raw: unknown) => { last = raw; receiveTeams(state, credentials, raw, SERVICE, world.clock()); };
  const activity = (member: string, text: string, extra: Record<string, unknown> = {}) => ({ type: "message", id: `in-${++ids}`, serviceUrl: SERVICE, text, from: { id: member },
    recipient: { id: `28:${APP}` }, conversation: { id: dm(member), conversationType: "personal", tenantId: TENANT }, ...extra });
  const tapToken = (token: string, message: string, member: string) => receive(activity(member, "", { replyToId: message, value: { so: token } }));
  return {
    provider: "teams",
    installation: credentials.installation,
    mint: who => state.pairing(credentials.installation, who, world.store.accountOf(who)!.generation, world.clock()),
    sendPair: (code, member) => receive(activity(member, `pair ${code}`)),
    say: (text, member, replyTo) => receive(activity(member, text, replyTo === undefined ? {} : { replyToId: replyTo })),
    tap(card, label, member) {
      const button = card.buttons.find(one => label.test(one.label) && one.token !== undefined);
      if (button === undefined) throw new Error(`teams: no ${label} button on ${JSON.stringify(card)}`);
      tapToken(button.token!, card.message, member);
    },
    tapToken,
    redeliver() { if (last !== null) receiveTeams(state, credentials, last, SERVICE, world.clock()); },
    async pass() {
      state.lease(credentials.installation, "test", world.clock());
      for (let i = 0; i < 20 && (await processTeamsEvent(options)); i++);
      await planTeamsNotifications(options);
      for (let i = 0; i < 40 && (await deliverTeamsPart(options)); i++);
    },
    cards: member => newCards(log, dm(member)),
    failSends(count) { failing = count; },
    posted: member => log.filter(one => one.chat === dm(member) && !one.edit).length,
    chatOf: dm,
    member: index => `29:1member-${index}-xxxxxxxxxxxxxx`,
  };
}

/** Each app's harness on one world. Members are numeric strings every app accepts (Discord's snowflakes, Telegram's ids). */
export const CHAT_HARNESSES: Record<ChatProvider, (world: ChatWorld) => ChatHarness> = {
  telegram: telegramHarness,
  slack: slackHarness,
  discord: discordHarness,
  teams: teamsHarness,
};
