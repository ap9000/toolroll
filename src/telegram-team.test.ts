/** Telegram in the shared team conversations (v72): a group follows one
 * conversation, a private chat can select one, messages enter the same
 * queue the browser uses, and replies come back through per-chat cursors. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { subscriptionCredentialKey } from './converse.js';
import { teamChatAuthorization, subscriptionTeamChatProvider } from './team-chat-authorization.js';
import { PROPOSAL_CHAT_REASON } from './lead-doors.js';
import { TeamLeads } from "./team-leads.js";
import { ceilingDigestOf } from "./principal.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { teamCommand, teamRequestId, PAIR_FIRST } from "./telegram-team.js";

const BOT = "777000";
const REPO = "/test/project";
const ALEX = { chat: 4242, user: 4242 };
const SAM = { chat: 8800, user: 8800 };
const GROUP = -100777;
const T0 = new Date("2026-09-21T18:00:00Z");

type Call = { method: string; params: Record<string, unknown> };
function scripted() {
  const calls: Call[] = [];
  const updates: unknown[][] = [];
  let next = 100;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === "getUpdates") return { ok: true, result: updates.shift() ?? [] };
    if (method === "sendMessage") return { ok: true, result: { message_id: next++ } };
    return { ok: true, result: true };
  };
  const sends = () => calls.filter(call => call.method === "sendMessage");
  const texts = (chat: number) => sends().filter(call => String(call.params["chat_id"]) === String(chat)).map(call => String(call.params["text"]));
  return { transport, calls, updates, sends, texts };
}
const textUpdate = (id: number, chat: { id: number; type: string }, from: number, text: string) => ({ update_id: id, message: { message_id: id, text, chat, from: { id: from } } });
const group = { id: GROUP, type: "supergroup" };
const priv = (id: number) => ({ id, type: "private" });

describe("Telegram team chats", () => {
  let dir: string, store: Store, alexToken: string, samToken: string, domain: TeamLeads, conversation: string, thread: number;
  const pairAs = (who: string, ids: { chat: number; user: number }) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, T0);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(ids.chat), userId: String(ids.user), updateId: ids.user }, T0).ok).toBe(true);
  };
  const actor = (name: string) => ({ name, generation: store.accountOf(name)!.generation });
  const consent = (name: string) => store.mintTeamMateSession({ approver: name, approverGeneration: actor(name).generation, thread, credentialKey: subscriptionCredentialKey('claude-subscription'), ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([REPO]), termsDigest: teamChatAuthorization(store, actor(name), domain.access(actor(name), conversation).conversation, subscriptionTeamChatProvider(store)).termsDigest }, T0);
  const pass = (script: ReturnType<typeof scripted>, extra: Partial<Parameters<typeof bridgePass>[1]> = {}) => bridgePass(store, { botId: BOT, transport: script.transport, clock: () => T0, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => "https://console.example" }, ...extra });
  const queued = () => store.handle.prepare("SELECT q.author, q.request_id, q.status, m.text FROM team_message q JOIN lead_message m ON m.id = q.message WHERE q.conversation = ? ORDER BY q.message").all(conversation);

  const replyWithCard = () => {
    const session = store.teamMateSession("alex", thread)?.id ?? consent("alex");
    store.createTask({ id: "target", title: "Launch page" }, T0);
    store.placeTask(store.lookupRef("target")!.id, REPO);
    const opened = store.openLeadTurn({ approver: "alex", session, thread, credentialKey: subscriptionCredentialKey('claude-subscription'), reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, T0);
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startLeadTurn(opened.id, T0);
    if (!started.ok) throw new Error("start");
    const proposal = store.draftLeadProposal({ thread, turn: opened.id, kind: "hold", payload: { task: "target", taskTitle: "Launch page", reason: "Wait for the audit", sawHold: null }, ceilingDigest: ceilingDigestOf([REPO]) }, T0);
    expect(store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "The launch needs an audit.", activity: "" } }, T0)).toBe(true);
    return proposal;
  };
  const groupTap = (id: number, user: number, token: string, messageId: number) => ({ update_id: id, callback_query: { id: `cb-${id}`, data: token, from: { id: user }, message: { message_id: messageId, chat: group } } });
  const sentCard = (script: ReturnType<typeof scripted>) => {
    const sent = script.sends().find(call => String(call.params["chat_id"]) === String(GROUP) &&
      ((call.params["reply_markup"] as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat().some(button => button.text === "Confirm" && button.callback_data !== undefined))!;
    const buttons = (sent.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
    const token = buttons.find(button => button.text === "Confirm")!.callback_data;
    return { token, messageId: Number(store.getTelegramProposalAction(token)!.messageId) };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-telegram-team-"));
    store = openStore(join(dir, "orders.db"));
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("alex");
    alexToken = alex.token;
    const sam = addApprover(store, "sam", T0, { name: "alex", token: alexToken });
    if (!sam.ok) throw new Error("sam");
    samToken = sam.token;
    void samToken;
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
    domain = new TeamLeads(store, () => [REPO]);
    const lead = domain.execute(actor("alex"), { operation: "create-lead", args: { name: "Engineering", instructions: "Keep it simple.", projects: [REPO] } }, T0);
    if (!lead.ok) throw new Error(lead.message);
    const leadId = String((lead.result as { leadId: string }).leadId);
    const made = domain.execute(actor("alex"), { operation: "create-conversation", args: { leadId, title: "Website launch", visibility: "team", projects: [REPO] } }, T0);
    if (!made.ok) throw new Error(made.message);
    conversation = String((made.result as { conversationId: string }).conversationId);
    thread = Number((made.result as { threadId: number }).threadId);
    const joined = domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: true, expectedRevision: 1, joinLead: true, expectedLeadRevision: 1 } }, T0);
    if (!joined.ok) throw new Error(joined.message);
    pairAs("alex", ALEX);
    pairAs("sam", SAM);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("the /team command shapes", () => {
    expect(teamCommand("/team")).toEqual({ kind: "list" });
    expect(teamCommand("/team@so_bot 2")).toEqual({ kind: "select", index: 2 });
    expect(teamCommand("/team off")).toEqual({ kind: "off" });
    expect(teamCommand("/team private")).toEqual({ kind: "off" });
    expect(teamCommand("/teamwork")).toBeNull();
    expect(teamCommand("hello /team")).toBeNull();
  });

  test("a manager binds the group, paired members' messages enter the shared queue, unpaired chatter is silent, and consent is checked before saving", async () => {
    const script = scripted();
    // A group the bot merely sits in: silence, even for a paired member.
    script.updates.push([textUpdate(1, group, ALEX.user, "hello?")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(script.sends()).toHaveLength(0);
    // sam (contributor) lists nothing to bind; alex (manager) binds.
    script.updates.push([textUpdate(2, group, SAM.user, "/team")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toContain("No team conversation you manage");
    script.updates.push([textUpdate(3, group, ALEX.user, "/team")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toContain("1. Website launch — lead Engineering");
    script.updates.push([textUpdate(4, group, ALEX.user, "/team 1")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toContain("This group now follows Website launch (lead Engineering)");
    expect(store.telegramTeamChat(BOT, String(GROUP))).toMatchObject({ kind: "group", conversation, boundBy: "alex" });
    // An unpaired member's text is nobody's message; a slash attempt gets the one hint.
    script.updates.push([textUpdate(5, group, 9999, "ship it")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { ignored: 1 } });
    script.updates.push([textUpdate(6, group, 9999, "/help")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe(PAIR_FIRST);
    // sam has not enabled chat for this conversation: told, with the link, and nothing is saved.
    script.updates.push([textUpdate(7, group, SAM.user, "Add a criterion for the footer")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts(GROUP).at(-1)).toContain("enable chat for yourself in Toolroll first");
    expect(script.sends().at(-1)!.params["reply_markup"]).toEqual({ inline_keyboard: [[{ text: "Enable chat", url: `https://console.example/chat?conversation=${conversation}` }]] });
    expect(queued()).toEqual([]);
    // With consent the message is saved once under its update identity, as sam.
    consent("sam");
    script.updates.push([textUpdate(8, group, SAM.user, "Add a criterion for the footer")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    expect(queued()).toEqual([{ author: "sam", request_id: teamRequestId(String(GROUP), 8), status: "queued", text: "Add a criterion for the footer" }]);
    // Nothing chatty was sent back for a saved message.
    expect(script.texts(GROUP).at(-1)).toContain("enable chat");
    // The lead answers (the runtime's job, simulated here); the next cycle carries the reply to the group.
    const claim = domain.claimNext("fixture-runner", T0)!;
    expect(claim).toMatchObject({ conversationId: conversation, actor: { name: "sam" } });
    expect(domain.finish(claim, { status: "answered", text: "Added: the footer must show the current year." }, T0)).toBe(true);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1, problems: [] } });
    expect(script.texts(GROUP).at(-1)).toBe("Added: the footer must show the current year.");
    // sam's own message is not echoed; alex's message from the browser is, with the author.
    expect(script.texts(GROUP).some(text => text.startsWith("sam:"))).toBe(false);
    consent("alex");
    expect(domain.execute(actor("alex"), { operation: "send", args: { conversationId: conversation, requestId: "web-1", text: "Also check the phone layout." } }, T0).ok).toBe(true);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(script.texts(GROUP).at(-1)).toBe("alex: Also check the phone layout.");
    // A second cycle with nothing new sends nothing: the cursor moved.
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    // A second group cannot follow the same conversation; /team off frees it.
    script.updates.push([textUpdate(9, { id: -100999, type: "supergroup" }, ALEX.user, "/team 1")]);
    await pass(script);
    expect(script.texts(-100999).at(-1)).toContain("Another group already follows that conversation");
    script.updates.push([textUpdate(10, group, SAM.user, "/team off")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe("This group follows nothing you can change.");
    script.updates.push([textUpdate(11, group, ALEX.user, "/team off")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe("This group no longer follows a conversation.");
    expect(store.telegramTeamChat(BOT, String(GROUP))).toBeNull();
  });

  test("lifecycle: a replayed update saves nothing twice, a removed member is refused, and a rotated credential ends a phone's voice while history stays", async () => {
    const script = scripted();
    consent("alex"); consent("sam");
    script.updates.push([textUpdate(1, group, ALEX.user, "/team 1")]);
    await pass(script);
    script.updates.push([textUpdate(2, group, SAM.user, "First point.")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    // Telegram redelivers the same update: applied once, saved once.
    script.updates.push([textUpdate(2, group, SAM.user, "First point.")]);
    const replay = await pass(script);
    expect(replay.ok && (replay.report.chatQueued ?? 0)).toBe(0);
    expect(queued()).toHaveLength(1);
    // Membership removal: sam's next message is refused in words; the saved one stays.
    const removed = domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: false, expectedRevision: 2 } }, T0);
    expect(removed.ok).toBe(true);
    script.updates.push([textUpdate(3, group, SAM.user, "Second point.")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts(GROUP).at(-1)).toMatch(/access|member|conversation/i);
    expect(queued()).toHaveLength(1);
    // Credential rotation: alex's binding no longer speaks; the group's history and binding remain.
    const rotated = addApprover(store, "alex", T0, { name: "alex", token: alexToken });
    expect(rotated.ok).toBe(true);
    expect(store.liveTelegramBindingFor(BOT, String(ALEX.user))).toBeNull();
    script.updates.push([textUpdate(4, group, ALEX.user, "/team")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe(PAIR_FIRST);
    expect(store.telegramTeamChat(BOT, String(GROUP))).toMatchObject({ conversation });
    expect(queued()).toHaveLength(1);
  });

  test("a private chat selects a conversation, talks there as itself, hears the reply once, and returns to its private assistant", async () => {
    const script = scripted();
    consent("alex");
    script.updates.push([textUpdate(1, priv(ALEX.chat), ALEX.user, "/team")]);
    await pass(script);
    expect(script.texts(ALEX.chat).at(-1)).toContain("1. Website launch — Team · lead Engineering");
    expect(script.texts(ALEX.chat).at(-1)).toContain("This chat talks to your private assistant.");
    script.updates.push([textUpdate(2, priv(ALEX.chat), ALEX.user, "/team 1")]);
    await pass(script);
    expect(script.texts(ALEX.chat).at(-1)).toContain("This chat now talks in Website launch");
    script.updates.push([textUpdate(3, priv(ALEX.chat), ALEX.user, "What is left before launch?")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    expect(queued()).toEqual([{ author: "alex", request_id: teamRequestId(String(ALEX.chat), 3), status: "queued", text: "What is left before launch?" }]);
    // Nothing landed in the personal Telegram queue.
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    const claim = domain.claimNext("fixture-runner", T0)!;
    expect(domain.finish(claim, { status: "answered", text: "Two tasks: the footer and the phone layout." }, T0)).toBe(true);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(script.texts(ALEX.chat).at(-1)).toBe("Two tasks: the footer and the phone layout.");
    expect(script.texts(ALEX.chat).filter(text => text.startsWith("alex:"))).toEqual([]);
    script.updates.push([textUpdate(4, priv(ALEX.chat), ALEX.user, "/team off")]);
    await pass(script);
    expect(script.texts(ALEX.chat).at(-1)).toBe("Back to your private assistant.");
    expect(store.telegramTeamChat(BOT, String(ALEX.chat))).toBeNull();
    // An unpaired private chat asking for /team is told to pair.
    script.updates.push([textUpdate(5, priv(31337), 31337, "/team")]);
    await pass(script);
    expect(script.texts(31337).at(-1)).toBe(PAIR_FIRST);
  });

  test.each(["membership", "lead-membership", "projects", "unpair", "rotation", "unpair-and-repair"])("private delivery stops after %s without deleting shared history", async change => {
    const script = scripted();
    script.updates.push([textUpdate(1, priv(SAM.chat), SAM.user, "/team 1")]);
    await pass(script);
    const id = store.appendLeadMessage({ thread, turn: null, role: "assistant", text: "Private launch details" }, T0);
    if (change === "membership") expect(domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: false, expectedRevision: 2 } }, T0).ok).toBe(true);
    if (change === "lead-membership") {
      const lead = domain.access(actor("alex"), conversation).lead;
      expect(domain.execute(actor("alex"), { operation: "member", args: { leadId: lead.id, account: "sam", role: "contributor", active: false, expectedRevision: lead.revision } }, T0).ok).toBe(true);
    }
    if (change === "projects") expect(store.setAccountProjects("sam", [], "alex", T0).ok).toBe(true);
    if (change === "rotation") expect(addApprover(store, "sam", T0, { name: "alex", token: alexToken }).ok).toBe(true);
    if (change.startsWith("unpair")) store.unpairTelegram(BOT, "sam", T0);
    if (change === "unpair-and-repair") pairAs("sam", SAM);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(script.texts(SAM.chat)).not.toContain("Private launch details");
    expect(store.listLeadMessages(thread, 10).some(message => message.id === id)).toBe(true);
  });

  test("group delivery stops when its granting manager is unpaired, even if another contributor remains paired", async () => {
    const script = scripted();
    script.updates.push([textUpdate(1, group, ALEX.user, "/team 1")]);
    await pass(script);
    store.appendLeadMessage({ thread, turn: null, role: "assistant", text: "Do not send after the grant ends" }, T0);
    store.unpairTelegram(BOT, "alex", T0);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(script.texts(GROUP)).not.toContain("Do not send after the grant ends");
  });

  test("a long lead reply full of links, bold and & or < is sent in parts Telegram accepts, no link cut", async () => {
    const script = scripted();
    script.updates.push([textUpdate(1, priv(SAM.chat), SAM.user, "/team 1")]);
    await pass(script);
    const before = script.sends().length;
    const urls = Array.from({ length: 300 }, (_, index) => `https://docs.example.org/guide/${index}?a=1&b=2`);
    store.appendLeadMessage({ thread, turn: null, role: "assistant", text: urls.map((url, index) => `**Step ${index}** a<b & c: ${url}`).join(" ") }, T0);
    await pass(script);
    const sent = script.sends().slice(before).map(call => String(call.params["text"]));
    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) expect(part.length).toBeLessThanOrEqual(4096);
    const joined = sent.join(" ");
    for (const url of urls) expect(joined).toContain(`docs.example.org (${url})`);
    expect(joined).toContain("a<b & c");
    expect(store.telegramTeamChat(BOT, String(SAM.chat))!.cursor).toBeGreaterThan(0);
  });

  test("delivery rechecks membership between parts and does not advance an unfinished message", async () => {
    const script = scripted();
    script.updates.push([textUpdate(1, priv(SAM.chat), SAM.user, "/team 1")]);
    await pass(script);
    const before = script.sends().length;
    store.appendLeadMessage({ thread, turn: null, role: "assistant", text: "Details ".repeat(1200) }, T0);
    const transport: TelegramTransport = async (...args) => {
      const result = await script.transport(...args);
      if (args[0] === "sendMessage") expect(domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: false, expectedRevision: 2 } }, T0).ok).toBe(true);
      return result;
    };
    await pass(script, { transport });
    expect(script.sends().length - before).toBe(1);
    expect(store.telegramTeamChat(BOT, String(SAM.chat))!.cursor).toBe(0);
  });

  test("a failed card keeps its message pending and retries only its unsent parts", async () => {
    const script = scripted();
    script.updates.push([textUpdate(1, group, ALEX.user, "/team 1")]);
    await pass(script);
    const proposal = replyWithCard();
    const transport: TelegramTransport = async (method, params, ...rest) => method === "sendMessage" && params["reply_markup"] !== undefined
      ? { ok: false, description: "fixture card failure" } : script.transport(method, params, ...rest);
    const failed = await pass(script, { transport });
    expect(failed.ok && failed.report.problems).toContain(`team card ${proposal}: fixture card failure`);
    expect(store.telegramTeamChat(BOT, String(GROUP))!.cursor).toBe(0);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(script.texts(GROUP).filter(text => text === "The launch needs an audit.")).toHaveLength(1);
    expect(sentCard(script).messageId).toBeGreaterThan(0);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
  });

  test("a paired group contributor confirms under their own account through the bridge callback", async () => {
    const script = scripted();
    consent("sam");
    script.updates.push([textUpdate(1, group, ALEX.user, "/team 1")]);
    await pass(script);
    const proposal = replyWithCard();
    await pass(script);
    const card = sentCard(script);
    script.updates.push([groupTap(2, SAM.user, card.token, card.messageId)]);
    expect(await pass(script, { readProjects: async () => [REPO, "/test/unrelated-project"] })).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
    expect(store.getLeadProposal(proposal)).toMatchObject({ state: "confirmed", resolvedBy: "sam", outcome: { ok: true, via: "telegram" } });
  });

  test('changed provider terms refuse a Telegram confirmation with the enable-chat reason and preserve the proposal', async () => {
    const script = scripted();
    consent('sam');
    script.updates.push([textUpdate(1, group, ALEX.user, '/team 1')]);
    await pass(script);
    const proposal = replyWithCard();
    await pass(script);
    const card = sentCard(script), before = store.getLeadProposal(proposal);
    store.setChatConfig({ ...store.getChatConfig()!, dailyTurns: 51 }, 'alex', T0);
    script.updates.push([groupTap(2, SAM.user, card.token, card.messageId)]);
    const refused = await pass(script);
    expect(refused).toMatchObject({ ok: true });
    expect(refused.ok && (refused.report.chatConfirmed ?? 0)).toBe(0);
    expect(script.calls.filter(call => call.method === 'editMessageText').at(-1)?.params['text']).toContain(PROPOSAL_CHAT_REASON);
    expect(store.getLeadProposal(proposal)).toEqual(before);
    expect(store.handle.prepare('SELECT 1 FROM hold').get()).toBeUndefined();
  });

  test("a removed group member sees no card details and cannot consume the shared confirmation", async () => {
    const script = scripted();
    script.updates.push([textUpdate(1, group, ALEX.user, "/team 1")]);
    await pass(script);
    const proposal = replyWithCard();
    await pass(script);
    const card = sentCard(script);
    expect(domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: false, expectedRevision: 2 } }, T0).ok).toBe(true);
    const before = script.calls.length;
    script.updates.push([groupTap(2, SAM.user, card.token, card.messageId)]);
    await pass(script);
    expect(script.calls.slice(before).filter(call => call.method === "editMessageText")).toEqual([]);
    expect(store.getTelegramProposalAction(card.token)!.consumedAt).toBeNull();
    expect(store.getLeadProposal(proposal)!.state).toBe("pending");
  });

  test("rebinding a group to another conversation makes its old card unavailable", async () => {
    const script = scripted();
    script.updates.push([textUpdate(1, group, ALEX.user, "/team 1")]);
    await pass(script);
    const proposal = replyWithCard();
    await pass(script);
    const card = sentCard(script);
    const lead = domain.access(actor("alex"), conversation).lead;
    const created = domain.execute(actor("alex"), { operation: "create-conversation", args: { leadId: lead.id, title: "Other launch", visibility: "team", projects: [REPO] } }, T0);
    expect(created.ok).toBe(true);
    const other = String((created.result as { conversationId: string }).conversationId);
    expect(store.bindTelegramTeamChat({ botId: BOT, chatId: String(GROUP), kind: "group", conversation: other, by: "alex", binding: store.liveTelegramBindingFor(BOT, String(ALEX.user))!.id }, T0).ok).toBe(true);
    script.updates.push([groupTap(2, ALEX.user, card.token, card.messageId)]);
    await pass(script);
    expect(store.getLeadProposal(proposal)!.state).toBe("pending");
    expect(script.calls.filter(call => call.method === "answerCallbackQuery").at(-1)!.params["text"]).toContain("no longer available");
  });


  test("a re-paired phone must reconnect its selected conversation before saving new work", async () => {
    const script = scripted();
    consent("sam");
    script.updates.push([textUpdate(1, priv(SAM.chat), SAM.user, "/team 1")]);
    await pass(script);
    store.unpairTelegram(BOT, "sam", T0);
    pairAs("sam", SAM);
    script.updates.push([textUpdate(2, priv(SAM.chat), SAM.user, "Do not save without a reply channel")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(queued()).toEqual([]);
    expect(script.texts(SAM.chat).at(-1)).toContain("Send /team and choose the conversation again");
  });

});
