/**
 * The paired phone as one more way to use the same assistant, against a
 * scripted Bot API and a scripted membership harness: ordinary text runs
 * the shared engine on the shared thread, cards confirm through the shared
 * doors with the phone named as the source, a reply to a result binds the
 * exact run, and every hostile or unlucky shape — wrong sender, stale
 * button, revoked pairing mid-turn, a crash between admission and reply,
 * a console confirmation racing a tap — ends with nothing done twice.
 *
 * Fixture transport, not a phone: nothing here is a live Telegram proof.
 */
import { notifyPeople } from "./flow-people.js";
import { TEAMMATE_TEMPLATES } from "./teammates.js";
import { replyToAsker } from "./teammate-desk.js";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MATE_ASK_TTL_MS, openStore, type Store, type TelegramBinding } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { bridgePass, createTransport, followBridge, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, saveBotToken, TOKEN_ENV, type TelegramTransport, type TelegramUpload } from "./telegram.js";
import { ceilingDigestOf, verifyApproverStanding } from "./principal.js";
import { subscriptionCredentialKey } from "./converse.js";
import { MATE_CHANNEL_COPY, MATE_FAILURE_COPY, mateFailureText } from "./mate.js";
import { knowledgeView } from './project-knowledge.js';
import { mintSharedActionReview, prepareSharedAction } from './chat-actions.js';
import { assignmentOf } from './assignment.js';
import { confirmMateProposal } from "./mate-doors.js";
import { MATE_TOOL_SCHEMAS, executeMateTool } from "./mate-tools.js";
import { runMateCli } from "./mate-cli.js";
import { readChatResult } from "./chat-review.js";
import { resultTaskLabel } from "./chat-evidence.js";
import { chatTaskStamp } from "./chat-task-actions.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { runOperate, EXIT } from "./operate.js";
import { saveRepos } from "./repos.js";
import { run as exec } from "./exec.js";
import { CONVERSATION_CLAIM_MS, NO_PHONE_LINK, NO_TASK_LINK, PART_RETRY_MS, TELEGRAM_ACTION_PARITY, mintCardTokens, parityGaps, proposalPreview, telegramRequestId } from "./telegram-mate.js";
import { saveConsoleUrl, CONSOLE_URL_ENV } from "./webhooks.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import type { SubscriptionMateRequest, SubscriptionMateRunner } from "./subscription-chat.js";
import { TURN_WALL_CLOCK_MS } from "./converse.js";

const T0 = new Date("2026-09-16T09:00:00.000Z");
const BOT = "777000";
const CHAT = 4242;
const USER = 31337;

type Call = { id: string; name: string; args: Record<string, unknown> };
type Answer = { text: string; calls?: Call[]; before?: () => void | Promise<void> };

/** What the scripted wire does to one sendMessage: nothing special, a lost answer, an ok with no message id, or Telegram's own refusal. */
type SendFault = "throw" | "no-id" | { ok: false; description?: string; parameters?: { retry_after?: number } } | null;

function scriptedTransport() {
  const calls: { method: string; params: Record<string, unknown>; messageId: number | null; upload?: TelegramUpload }[] = [];
  const updates: unknown[][] = [];
  let nextMessageId = 100;
  const script = {
    /** Consulted before every sendMessage with the attempt count so far; a fault is recorded as an attempt, never as a send. */
    fault: null as ((params: Record<string, unknown>, attempt: number) => SendFault) | null,
  };
  const attempts = () => calls.filter(call => call.method.startsWith("sendMessage"));
  const transport: TelegramTransport = async (method, params, _signal, upload) => {
    if (method === "getUpdates") {
      calls.push({ method, params, messageId: null });
      const offset = Number(params["offset"] ?? 0);
      return { ok: true, result: (updates.shift() ?? []).filter(update => Number((update as { update_id: number }).update_id) >= offset) };
    }
    if (method === "sendMessage" || method === "sendDocument") {
      // A document is the multipart road: recorded with the exact upload the adapter would serialize, faulted by the same script.
      const fault = script.fault === null ? null : script.fault(params, calls.filter(call => call.method.startsWith(method)).length);
      if (fault !== null) {
        calls.push({ method: `${method}:failed`, params, messageId: null, ...(upload === undefined ? {} : { upload }) });
        if (fault === "throw") throw new Error("socket hang up");
        if (fault === "no-id") return { ok: true, result: {} };
        return fault;
      }
      const messageId = nextMessageId++;
      calls.push({ method, params, messageId, ...(upload === undefined ? {} : { upload }) });
      return { ok: true, result: { message_id: messageId } };
    }
    calls.push({ method, params, messageId: null });
    return { ok: true, result: true };
  };
  const sends = () => calls.filter(call => call.method === "sendMessage");
  const documents = () => calls.filter(call => call.method === "sendDocument");
  const texts = () => sends().map(call => String(call.params["text"]));
  const edits = () => calls.filter(call => call.method === "editMessageText").map(call => String(call.params["text"]));
  const acks = () => calls.filter(call => call.method === "answerCallbackQuery").map(call => String(call.params["text"] ?? ""));
  /** The card: the last send carrying a keyboard, with its opaque tokens. */
  const card = () => {
    const sent = [...sends()].reverse().find(call => call.params["reply_markup"] !== undefined);
    if (sent === undefined) throw new Error("no card was sent");
    const rows = (sent.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    const button = (label: RegExp): string => {
      const found = rows.flat().find(one => label.test(one.text));
      if (found === undefined) throw new Error(`no ${label} button on the card`);
      return found.callback_data;
    };
    return { messageId: sent.messageId as number, text: String(sent.params["text"]), rows, button };
  };
  return { transport, calls, updates, sends, documents, attempts, texts, edits, acks, card, set fault(value: typeof script.fault) { script.fault = value; } };
}

const textUpdate = (id: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: { message_id: 1000 + id, chat: { id: CHAT, type: "private" }, from: { id: USER }, text, ...extra },
});
const tap = (id: number, data: string, messageId: number, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  callback_query: { id: `cb-${id}`, data, from: { id: USER }, message: { message_id: messageId, chat: { id: CHAT } }, ...extra },
});

describe("Telegram conversation: the same chat, from the phone", () => {
  let dir: string;
  let file: string;
  let evidenceRoot: string;
  let repo: string;
  let store: Store;
  let now: Date;
  let projects: string[];
  let token: string;
  let answers: Answer[];
  let requests: SubscriptionMateRequest[];
  let script: ReturnType<typeof scriptedTransport>;
  /** The trusted https origin the wiring reads before every card and `/task`; null is the unconfigured phone. */
  let origin: string | null;

  const runner: SubscriptionMateRunner = async request => {
    requests.push(request);
    const next = answers.shift();
    if (next === undefined) throw new Error("the harness script ran out of answers");
    await next.before?.();
    return { ok: true, answer: { text: next.text, calls: next.calls ?? [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } };
  };
  const readProjects = vi.fn(async () => projects);
  const binding = (): TelegramBinding => store.liveTelegramBinding(BOT)!;
  const pair = () => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: String(USER), updateId: 1 }, now).ok).toBe(true);
  };
  const pass = (extra: Partial<Parameters<typeof bridgePass>[1]> = {}) => {
    // Lifecycle progress facts have their own suite (task-notifications.test.ts);
    // this one drives the conversation, so they are settled before each pass.
    store.resolveEpisodes("life", now);
    return bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, deliver: false, readProjects, conversation: { evidenceRoot, subscriptionRunner: runner, phoneOrigin: () => origin }, ...extra });
  };
  /** The url row of the last edit or send carrying a keyboard: label and href, or [] when none rides it. */
  const urlButtons = (call: { params: Record<string, unknown> } | undefined) =>
    ((call?.params["reply_markup"] as { inline_keyboard?: { text: string; url?: string }[][] } | undefined)?.inline_keyboard ?? []).flat().filter(one => one.url !== undefined).map(one => [one.text, one.url]);
  const lastEdit = () => script.calls.filter(call => call.method === "editMessageText").at(-1);
  const who = () => {
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };
  const task = (id: string, title = `work ${id}`) => {
    store.createTask({ id, title }, now);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };
  /** An approved, built source with a sealed terminal diff to annotate — the result a phone can reply to. */
  const seedSource = (id: string) => {
    const ref = task(id, `Guard the payout path (${id})`);
    propose(store, { taskId: id, goal: `do ${id} carefully`, touches: ["src/payments/"], acceptance: [{ id: "c1", statement: "The guard holds", how: null, evidence: ["manual-review"] }], now });
    const scope = store.getScope(id)!;
    const approved = approve(store, id, "alex", now, scope.digest, token);
    if (!approved.ok) throw new Error(`approval refused: ${approved.reason}`);
    const route = store.routeAuthorityFor(ref, "builder", null);
    if (!route?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `so/${id}`, worktree: `/pool/${id}`, route: route.stamp, now });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, { outcome: "built", committed: true, now });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from(`diff --git a/${id} b/${id}\n+x\n`, "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    const artifact = store.saveArtifact({ run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" }, now);
    store.setTaskState(id, "done", now);
    return { ref, run, artifact };
  };
  /** A pending card of one kind on the phone's own session and thread, its tokens placed on a synthetic message. */
  const card = (kind: Parameters<Store["draftMateProposal"]>[0]["kind"], payload: Record<string, unknown>, messageId = 77) => {
    const me = who();
    const credentialKey = subscriptionCredentialKey("claude-subscription");
    let session = store.activeMateSession("alex");
    if (session === null) {
      store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey, ceilingMicrousd: 0, ceilingDigest: me.ceilingDigest, termsDigest: "t".repeat(64) }, now);
      session = store.activeMateSession("alex")!;
    }
    const thread = store.openMateThread("alex", me.ceilingDigest, now).thread;
    const opened = store.openMateTurn({ approver: "alex", session: session.id, thread: thread.id, credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, now);
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startMateTurn(opened.id, now);
    if (!started.ok) throw new Error("start");
    const id = store.draftMateProposal({ thread: thread.id, turn: opened.id, kind, payload, ceilingDigest: me.ceilingDigest }, now);
    store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 }, now);
    const minted = mintCardTokens(store, binding(), id, now, String(messageId));
    return { id, confirm: minted.tokens[0]!, dismiss: minted.tokens[1]!, messageId, preview: proposalPreview(store, store.getMateProposal(id)!, [repo]) };
  };
  let nextUpdate = 10;
  const tapPass = async (data: string, messageId: number) => {
    script.updates.push([tap(nextUpdate++, data, messageId)]);
    return pass();
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-telegram-mate-")));
    file = join(dir, "orders.db");
    evidenceRoot = join(dir, "evidence");
    repo = join(dir, "repo");
    mkdirSync(evidenceRoot); mkdirSync(repo);
    now = T0;
    origin = null;
    projects = [repo];
    answers = [];
    requests = [];
    nextUpdate = 10;
    readProjects.mockClear();
    script = scriptedTransport();
    store = openStore(file);
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", now);
    const added = addApprover(store, "alex", now);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", now);
    pair();
  });
  afterEach(() => { try { store.close(); } catch { /* a production-wiring test closed it */ } rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  test("new shared changes confirm once in Telegram; protected actions link to the same saved review outcome", async () => {
    origin = "https://console.example";
    execFileSync("git",["init","-q",repo]);writeFileSync(join(repo,"README.md"),"Synthetic shared action test\n");execFileSync("git",["-C",repo,"add","."]);execFileSync("git",["-C",repo,"-c","user.name=Test","-c","user.email=test@localhost","commit","-qm","seed"]);
    answers.push({text:"Save these project instructions.",calls:[{id:"shared-1",name:"propose_action",args:{operation:"knowledge_instructions",repo:"r1",instructions:"Use concise progress updates."}}]},{text:"Review the proposed instructions."});
    script.updates.push([textUpdate(2,"Save instructions")]);await pass();const change=script.card();expect(change.text).toContain("Use concise progress updates.");
    script.updates.push([tap(3,change.button(/Confirm/),change.messageId)]);await pass();expect(knowledgeView(store,repo,"alex").knowledge.instructions).toBe("Use concise progress updates.");
    script.updates.push([tap(4,change.button(/Confirm/),change.messageId)]);await pass();expect(knowledgeView(store,repo,"alex").revision).toBe(1);
    task("shared-cancel","Cancel only this synthetic task");
    answers.push({text:"Review cancellation.",calls:[{id:"shared-2",name:"propose_action",args:{operation:"task_cancel",task:"shared-cancel"}}]},{text:"Open the full review to cancel."});
    script.updates.push([textUpdate(5,"Cancel the synthetic task")]);await pass();const protectedCard=script.card();
    const actions=store.handle.prepare("SELECT id FROM mate_proposal WHERE kind='action' ORDER BY id DESC").all(),id=Number(actions[0]!['id']);
    expect(urlButtons(script.sends().at(-1))).toEqual([["Review action",`https://console.example/chat/action/${id}`]]);
    expect(protectedCard.rows.flat().some(button=>/Confirm/.test(button.text))).toBe(false);expect(store.getTask("shared-cancel")?.state).not.toBe("cancelled");
    const review=mintSharedActionReview(store,who(),id,evidenceRoot,now);
    expect(confirmMateProposal(store,who(),id,now,{via:"web",evidenceRoot,confirm:true,actionReview:{nonce:review.nonce,password:""}})).toMatchObject({ok:true});
    expect(store.getMateProposal(id)?.outcome).toMatchObject({ok:true,via:"web",said:"Task cancelled."});
    expect(executeMateTool({store,who:who(),now,step:1,readDecisions:new Map(),draft:()=>null},"get_action_status",{proposal:id})).toMatchObject({ok:true,body:{state:"confirmed",outcome:{ok:true,via:"web"}}});
  });
  test("the lead's question arrives with one button per option and Something else; a tap is the owner's next message, once (ask_owner)", async () => {
    answers.push(
      { text: "", calls: [{ id: "q1", name: "ask_owner", args: { question: "Ship today or Friday?", options: ["Today", "Friday"] } }] },
      { text: "It depends on one thing." },
    );
    script.updates.push([textUpdate(2, "When should the release go out?")]);
    await pass();
    const asked = script.sends().find(call => String(call.params["text"]) === "Ship today or Friday?")!;
    const rows = (asked.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(rows.map(row => row.map(one => one.text))).toEqual([["Today", "Friday"], ["Something else"]]);
    // Something else asks for words; nothing is sent to the lead.
    await tapPass(rows[1]![0]!.callback_data, asked.messageId!);
    expect(script.acks().at(-1)).toBe("Type your answer as a message.");
    expect(requests).toHaveLength(2);
    answers.push({ text: "Friday it is." });
    await tapPass(rows[0]![1]!.callback_data, asked.messageId!);
    expect(script.acks().at(-1)).toBe("Sent: Friday");
    expect(script.edits().at(-1)).toContain("You chose: Friday");
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)!.history.filter(one => one.role === "operator").at(-1)).toMatchObject({ text: "Friday" });
    expect(script.texts()).toContain("Friday it is.");
    // The question is answered: a later tap sends nothing.
    await tapPass(rows[0]![0]!.callback_data, asked.messageId!);
    expect(script.acks().at(-1)).toBe("That question was already answered.");
    expect(requests).toHaveLength(3);
  });
  test("a tap on the lead's question after its time says it expired and sends nothing (ask_owner)", async () => {
    answers.push(
      { text: "", calls: [{ id: "q1", name: "ask_owner", args: { question: "Ship today or Friday?", options: ["Today", "Friday"] } }] },
      { text: "It depends on one thing." },
    );
    script.updates.push([textUpdate(2, "When should the release go out?")]);
    await pass();
    const asked = script.sends().find(call => String(call.params["text"]) === "Ship today or Friday?")!;
    const rows = (asked.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    now = new Date(now.getTime() + MATE_ASK_TTL_MS);
    await tapPass(rows[0]![0]!.callback_data, asked.messageId!);
    expect(script.acks().at(-1)).toBe("That question expired. Send your answer as a message.");
    expect(script.edits().at(-1)).toContain("That question expired.");
    expect(requests).toHaveLength(2);
  });
  test("a hidden path uses complete review instead of offering incomplete confirmation",()=>{
    const preview=proposalPreview(store,{kind:'action',payload:{operation:'knowledge_instructions',request:{},repo,title:'Save project instructions',terms:['Use /Users/operator/project/reference.md'],stamp:'fixture',state:{}}} as Parameters<typeof proposalPreview>[1],[repo]);
    expect(preview.buttons).toBe(false);expect(preview.text).not.toContain('/Users/operator/project/reference.md');
  });
  test("ordinary text runs the shared engine on the shared thread; the card confirms through the shared door as telegram; web and CLI read the same rows; a replay does nothing twice", async () => {
    answers.push(
      { text: "", calls: [{ id: "g0", name: "get_capabilities", args: { repo: "r1" } }] },
      { text: "Let me draft that.", calls: [{ id: "c1", name: "propose_task", args: { repo: "r1", title: "Tighten the payout guard", goal: "Refuse a payout over the limit.", acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", evidence: ["manual-review"] }] } }] },
      { text: "Proposed a task to tighten the payout guard. Confirm it to file it." },
    );
    // Durable before acknowledged: when the cursor moves past the update, its row already exists.
    const cursorMoves = vi.spyOn(store, "advanceBridgeCursor");
    script.updates.push([textUpdate(2, "Please tighten the payout guard so an over-limit payout is refused")]);
    const first = await pass();
    expect(first).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, ignored: 0, problems: [] } });
    expect(cursorMoves).toHaveBeenCalledTimes(1);
    const rows = store.listTelegramConversations(BOT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ updateId: 2, messageId: "1002", state: "done", outcome: "answered", request: telegramRequestId(BOT, binding().id, 2), approver: "alex", text: "Please tighten the payout guard so an over-limit payout is refused" });
    expect(rows[0]!.turn).not.toBeNull();
    expect(Number(store.handle.prepare("SELECT cursor FROM chat_runtime WHERE provider = 'telegram' AND installation = ?").get(BOT)?.["cursor"])).toBe(2);
    // The engine ran three times (a capabilities read, a tool step, then text); the session is a membership session over the enrolled ceiling.
    expect(requests).toHaveLength(3);
    expect(requests[0]!.history.filter(one => one.role === "operator").at(-1)).toMatchObject({ role: "operator", text: "Please tighten the payout guard so an over-limit payout is refused" });
    const session = store.activeMateSession("alex")!;
    expect(session).toMatchObject({ credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([repo]), approverGeneration: who().generation });
    expect(rows[0]!.session).toBe(session.id);
    // The reply, then the card, both to this chat; the reply answers the operator's message.
    expect(script.texts()[0]).toBe("Proposed a task to tighten the payout guard. Confirm it to file it.");
    expect(script.sends()[0]!.params["reply_parameters"]).toEqual({ message_id: 1002 });
    const sent = script.card();
    expect(sent.text).toContain("Create task in repo: Tighten the payout guard");
    expect(sent.text).toContain("Goal: Refuse a payout over the limit.");
    expect(sent.text).toContain("You still approve its scope before work starts.");
    expect(sent.rows[0]!.map(one => one.text)).toEqual(["Confirm", "Dismiss"]);
    // The console's view: the same live thread under the same ceiling, its messages and pending card.
    const me = who();
    const opened = store.openMateThread(me.name, me.ceilingDigest, now);
    expect(opened.ceilingChanged).toBe(false);
    expect(store.listMateMessages(opened.thread.id, 10).map(one => [one.role, one.text])).toEqual([
      ["operator", "Please tighten the payout guard so an over-limit payout is refused"],
      ["assistant", "Proposed a task to tighten the payout guard. Confirm it to file it."],
    ]);
    const pending = store.listMateProposals(opened.thread.id, ["pending"]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "task", state: "pending" });
    // The terminal's view: `toolroll chat` lists the phone's card on the same session (no new mint).
    const lines: string[] = [];
    const cli = await runMateCli({ store, databaseFile: file, write: line => lines.push(line), json: false, credentials: { name: "alex", token }, repos: [repo], say: undefined, end: false, ceilingUsd: undefined, seams: { lines: ["proposals", "quit"], clock: () => now } });
    expect(cli.code).toBe(0);
    expect(lines.join("\n")).toContain("mate conversation live");
    expect(lines.join("\n")).toContain('file "Tighten the payout guard"');
    expect(store.activeMateSession("alex")?.id).toBe(session.id);
    // Confirm from the phone: the shared door files the task and records the phone as the source.
    const confirmed = await tapPass(sent.button(/^Confirm$/), sent.messageId);
    expect(confirmed).toMatchObject({ ok: true, report: { chatConfirmed: 1, ignored: 0 } });
    const proposal = store.getMateProposal(pending[0]!.id)!;
    expect(proposal.state).toBe("confirmed");
    expect(proposal.outcome).toMatchObject({ ok: true, kind: "task", via: "telegram" });
    const filed = (proposal.outcome as { taskId: string }).taskId;
    expect(store.getTask(filed)).toMatchObject({ title: "Tighten the payout guard" });
    expect(store.lookupRef(filed)?.repo).toBe(repo);
    expect(script.acks().at(-1)).toBe("✓ done");
    // No trusted origin: one next action in words, one honest line about the missing setup, no localhost.
    expect(script.edits().at(-1)).toBe(`✓ filed ${filed} — review and approve its scope to start work\n\nApprove it in Toolroll on the computer.\n\n${NO_PHONE_LINK}`);
    expect(script.edits().at(-1)).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(urlButtons(lastEdit())).toEqual([]);
    // /task reads the filed task on the same view.
    script.updates.push([textUpdate(nextUpdate++, `/task ${filed}`)]);
    expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
    expect(script.texts().at(-1)).toContain("Tighten the payout guard");
    // Replay of both updates: nothing runs, nothing files, nothing is sent.
    const sendsBefore = script.sends().length;
    const tasksBefore = store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"];
    script.updates.push([textUpdate(2, "Please tighten the payout guard so an over-limit payout is refused"), tap(10, sent.button(/^Confirm$/), sent.messageId)]);
    const replayed = await pass();
    expect(replayed.ok && replayed.report.chatQueued).toBeFalsy();
    expect(replayed.ok && replayed.report.chatConfirmed).toBeFalsy();
    expect(requests).toHaveLength(3);
    expect(script.sends()).toHaveLength(sendsBefore);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(tasksBefore);
    expect(store.listTelegramConversations(BOT)).toHaveLength(1);
  });

  test("the lead's voice on the phone: a tool turn gets one 👍 on the owner's message and typing; the reply is shaped, its bold and links sent as entities", async () => {
    origin = "https://so.example.com";
    answers.push(
      { text: "Checking.", calls: [{ id: "q1", name: "list_tasks", args: {} }, { id: "q2", name: "list_repos", args: {} }] },
      { text: "## Payout\n**Ready**: see https://so.example.com/chat?task=payout (run #4)." },
    );
    script.updates.push([textUpdate(2, "how is the payout fix?")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    const reactions = script.calls.filter(call => call.method === "setMessageReaction");
    expect(reactions).toHaveLength(1);
    expect(reactions[0]!.params).toMatchObject({ message_id: 1002, reaction: [{ type: "emoji", emoji: "👍" }] });
    expect(script.calls.filter(call => call.method === "sendChatAction").map(call => call.params["action"])).toContain("typing");
    const reply = script.sends()[0]!;
    expect(reply.params["text"]).toBe("Payout\nReady: see the task.");
    expect(reply.params["entities"]).toEqual([{ type: "bold", offset: 7, length: 5 }, { type: "text_link", offset: 18, length: 8, url: "https://so.example.com/chat?task=payout" }]);
    // A quick answer (no tool step) gets neither; the lead never reacts to its own messages.
    answers.push({ text: "All quiet." });
    script.updates.push([textUpdate(3, "anything else?")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    expect(script.calls.filter(call => call.method === "setMessageReaction")).toHaveLength(1);
    expect(script.texts().at(-1)).toBe("All quiet.");
    expect(script.sends().at(-1)!.params["entities"]).toBeUndefined();
  });

  test("a long reply full of links, bold and & or < goes out in parts Telegram accepts, each link whole as an entity", async () => {
    origin = "https://so.example.com";
    const urls = Array.from({ length: 200 }, (_, index) => `https://docs.example.org/guide/${index}?a=1&b=2`);
    // Over Telegram's 4,096 the lead is asked once to shorten; still over, the reply is split, never cut.
    const guide = urls.map((url, index) => `**Step ${index}** a<b & c: ${url}`).join(" ");
    answers.push({ text: guide }, { text: guide });
    script.updates.push([textUpdate(2, "send me the guide links")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    const sent = script.sends().filter(call => call.method === "sendMessage");
    expect(sent.length).toBeGreaterThan(1);
    const links: string[] = [];
    for (const call of sent) {
      const text = String(call.params["text"]);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/\*\*|\]\(/);
      for (const entity of (call.params["entities"] ?? []) as Array<{ type: string; offset: number; length: number; url?: string }>) {
        expect(entity.offset + entity.length).toBeLessThanOrEqual(text.length);
        if (entity.type === "text_link") { expect(text.slice(entity.offset, entity.offset + entity.length)).toBe("docs.example.org"); links.push(entity.url!); }
      }
    }
    expect(links).toEqual(urls);
    expect(sent.map(call => String(call.params["text"])).join(" ").match(/a<b & c/g)).toHaveLength(200);
  });

  test("a teammate's question arrives with its options and Answer in words; a tap answers it once, a stale tap changes nothing, and a reply answers in words (v93)", async () => {
    const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] }) }, now);
    const mate = store.createTeammate({ repo, handle: "maya", soul: TEAMMATE_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, now);
    const ask = (title: string) => {
      const card = store.addFlowCard({ flow, title, description: null, stage: "inbox", by: "alex" }, now);
      const id = store.openTeammateQuestion({ teammate: mate, card, entry: 1, question: `Refund all of ${title}?`, options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "Half" }], askedOf: "alex" }, now)!;
      notifyPeople(store, store.getFlowCard(card)!, ["alex"], null, { key: `teammate-q:${id}`, attention: true, subject: `Maya · Support asks about “${title}”`, body: "Over my $50 limit." }, now);
      return id;
    };
    const first = ask("order 42");
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 1 } });
    const notice = script.card();
    expect(notice.text).toContain("Maya · Support asks about “order 42”");
    expect(notice.rows.flat().map(one => one.text)).toEqual(["Yes", "Half", "✏️ Answer in words"]);
    // A tap on another message changes nothing; on the notice it answers, once.
    await tapPass(notice.button(/Half/), notice.messageId + 99);
    expect(store.teammateQuestion(first)!.state).toBe("open");
    await tapPass(notice.button(/Half/), notice.messageId);
    expect(store.teammateQuestion(first)).toMatchObject({ state: "answered", choice: "o2", answeredBy: "alex", answeredVia: "telegram" });
    expect(script.edits().at(-1)).toContain("✅ You answered: Half.");
    await tapPass(notice.button(/Yes/), notice.messageId);
    expect(script.acks().at(-1)).toContain("already answered");
    expect(store.teammateQuestion(first)!.choice).toBe("o2");
    // In words: a reply to the prompt is the answer.
    const second = ask("order 43");
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 1 } });
    const again = script.card();
    await tapPass(again.button(/Answer in words/), again.messageId);
    const prompt = script.sends().at(-1)!;
    expect(prompt.params["reply_markup"]).toMatchObject({ force_reply: true });
    expect(String(prompt.params["text"])).toContain("Refund all of order 43?");
    script.updates.push([textUpdate(nextUpdate++, "Refund $50 and send a coupon.", { reply_to_message: { message_id: prompt.messageId } })]);
    await pass();
    expect(store.teammateQuestion(second)).toMatchObject({ state: "answered", choice: null, answer: "Refund $50 and send a coupon.", answeredVia: "telegram" });
    expect(script.texts().at(-1)).toContain("It picks the card up again now.");
  });

  test("a message to a teammate by name lands on its desk instead of the lead, and its answer comes back in Telegram (v96)", async () => {
    store.createTeammate({ repo, handle: "maya", soul: TEAMMATE_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, now);
    script.updates.push([textUpdate(nextUpdate++, "Maya: where's order 2201?")]);
    await pass();
    expect(script.texts().at(-1)).toContain("Maya has it. The answer comes here when it's done.");
    const desk = store.listFlows([repo]).find(one => one.name === "Maya's desk")!;
    const [card] = store.flowCards(desk.id, false);
    expect(card).toMatchObject({ title: "where's order 2201?", createdBy: "alex", source: { kind: "message", label: "Telegram message" } });
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()!.n)).toBe(0);
    replyToAsker(store, desk, card!, store.teammateByHandle(repo, "maya")!, "Order 2201 shipped yesterday.", now);
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(script.texts().at(-1)).toContain("Maya · Support: where's order 2201?");
    expect(script.texts().at(-1)).toContain("Order 2201 shipped yesterday.");
  });

  test("a reply to a result message binds that exact run; confirming creates the same-family revision, audited as telegram", async () => {
    origin = "https://console.example";
    const { run } = seedSource("payout");
    // The result reaches the phone through the outbox with its exact task/run provenance.
    store.enqueueNotification({ dedupeKey: `result:${run}`, kind: "report-ready", subject: "Result ready", body: "Built and verified.", source: { run } }, now);
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 1 } });
    const resultMessage = script.sends()[0]!.messageId as number;
    expect(store.telegramMessageBindings(binding(), String(resultMessage))).toEqual([{ taskId: "payout", taskRef: store.lookupRef("payout")!.id, run, project: repo }]);
    answers.push(
      { text: "Reading the result.", calls: [{ id: "r1", name: "get_result", args: { task: "payout", run } }] },
      { text: "Proposing the change.", calls: [{ id: "r2", name: "propose_review", args: { run, operation: "revise", note: "Rename the guard and add a test for the over-limit case." } }] },
      { text: "I proposed a revision of payout with your feedback. Confirm it to create the revision." },
    );
    script.updates.push([textUpdate(5, "Rename the guard and add a test for the over-limit case.", { reply_to_message: { message_id: resultMessage } })]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, problems: [] } });
    const row = store.listTelegramConversations(BOT)[0]!;
    expect(row).toMatchObject({ replyTo: String(resultMessage), taskId: "payout", sourceRun: run, state: "done" });
    const asked = requests[0]!.history.filter(one => one.role === "operator").at(-1) as { text: string };
    expect(asked.text).toContain(`replying to result #${run} from execution payout`);
    expect(asked.text).not.toMatch(/\/pool|evidence/);
    const sent = script.card();
    expect(sent.text).toContain(`Request changes to result #${run} of Guard the payout path (payout)`);
    expect(sent.text).toContain("| Rename the guard and add a test for the over-limit case.");
    expect(sent.text).toContain("Creates a revision of the same task.");
    expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
    const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id)[0]!;
    expect(proposal).toMatchObject({ kind: "review", state: "confirmed" });
    expect(proposal.outcome).toMatchObject({ ok: true, via: "telegram" });
    const child = (proposal.outcome as { taskId: string }).taskId;
    const family = store.taskFamilyOf("payout", [repo], false)!;
    expect(family.problem).toBeNull();
    expect(family.versions.map(one => one.id)).toEqual(["payout", child]);
    expect(store.getTask(child)?.title).toBe("Guard the payout path (payout) — revision");
    expect(store.revisionSourceOf(store.lookupRef(child)!.id)).toMatchObject({ sourceRun: run, sourceTask: "payout" });
    expect(store.allDiffComments(run).map(one => [one.author, one.note, one.consumedBy])).toEqual([["alex", "Rename the guard and add a test for the over-limit case.", child]]);
    // Planned first: the door's one sentence says so, and ONE button opens the revision — nothing to approve yet.
    expect(script.edits().at(-1)).toBe("✓ Revision created. Updating the plan with your notes; you'll approve it next.");
    expect(urlButtons(lastEdit()).map(button => button[0])).toEqual(["Open task"]);
    // The task keeps the exchange in its own chat too: the phone's words,
    // the lead's reply and what was confirmed, each labelled Telegram.
    const taskChat = store.liveMateThreadFor("alex", { kind: "task", key: "payout" })!;
    expect(store.listMateMessages(taskChat.id, 10).map(one => [one.role, one.text])).toEqual([
      ["operator", "From Telegram: Rename the guard and add a test for the over-limit case."],
      ["assistant", "I proposed a revision of payout with your feedback. Confirm it to create the revision."],
      ["assistant", "From Telegram — Changes to make: Revision created. Updating the plan with your notes; you'll approve it next."],
    ]);
    expect(store.getScope(child)?.approvedDigest ?? null).toBeNull();
    // The planner keeps the terms (its real turn is covered end to end): now it waits for approval.
    store.setPlanState(store.lookupRef(child)!.id, "drafted");
    // The revision's own status reads from the phone, on the same records, with the same precise button.
    script.updates.push([textUpdate(nextUpdate++, `/task ${child}`)]);
    expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
    expect(script.texts().at(-1)).toContain("— revision");
    expect(script.texts().at(-1)).not.toContain("Read-only status");
    expect(urlButtons(script.sends().at(-1))).toEqual([["Review & start", `https://console.example/chat?task=${encodeURIComponent(child)}#task-chat-action`]]);
    // The source result itself: the exact run's checks, never the latest run by guess.
    script.updates.push([textUpdate(nextUpdate++, "/task payout")]);
    expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
    expect(urlButtons(script.sends().at(-1))).toEqual([["Open changes", `https://console.example/chat?task=payout&result=${run}&tab=changes`]]);
  });

  test("the same journey under a signed automatic-approval mode: the phone's revision is approved under that policy and runs unattended; nothing asks for a password", async () => {
    origin = "https://console.example";
    const terms = { ...presetTerms("hands-off", new Date(now.getTime() + 24 * 3_600_000).toISOString()), autoApproveFiling: true };
    store.signMode({ repo, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, now);
    const { run } = seedSource("payout");
    store.enqueueNotification({ dedupeKey: `result:${run}`, kind: "report-ready", subject: "Result ready", body: "Built and verified.", source: { run } }, now);
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 1 } });
    const resultMessage = script.sends()[0]!.messageId as number;
    answers.push(
      { text: "Reading the result.", calls: [{ id: "r1", name: "get_result", args: { task: "payout", run } }] },
      { text: "Proposing the change.", calls: [{ id: "r2", name: "propose_review", args: { run, operation: "revise", note: "Add a test for the over-limit case." } }] },
      { text: "I proposed a revision of payout with your feedback. Confirm it to create the revision." },
    );
    script.updates.push([textUpdate(5, "Add a test for the over-limit case.", { reply_to_message: { message_id: resultMessage } })]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, problems: [] } });
    const sent = script.card();
    expect(sent.text).toContain(`Request changes to result #${run} of Guard the payout path (payout)`);
    expect(sent.text).toContain("Its approval follows your settings.");
    expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
    const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id)[0]!;
    expect(proposal.outcome).toMatchObject({ ok: true, via: "telegram", said: "Revision created under your automatic approval settings." });
    const child = (proposal.outcome as { taskId: string }).taskId;
    expect(store.taskFamilyOf("payout", [repo], false)?.versions.map(one => one.id)).toEqual(["payout", child]);
    expect(store.revisionSourceOf(store.lookupRef(child)!.id)).toMatchObject({ sourceRun: run, sourceTask: "payout" });
    // Approved under the signed mode — the same policy the console's form applies — so a worker can take it without anyone at the computer.
    const scope = store.getScope(child)!;
    expect(scope.approvedDigest).toBe(scope.digest);
    expect(scope.approvalBasis).toBe("mode");
    expect(store.getTask(child)?.state).toBe("queued");
    expect(script.edits().at(-1)).toBe("✓ Revision created under your automatic approval settings.");
    expect(script.edits().at(-1)).not.toMatch(/password|Approve/);
    // Approved from the recorded scope, so the button opens the task — not a second approval.
    expect(urlButtons(lastEdit())).toEqual([["Open task", `https://console.example/chat?task=${encodeURIComponent(child)}`]]);
    // A second tap on the same card creates nothing more.
    expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(store.taskFamilyOf("payout", [repo], false)?.versions).toHaveLength(2);
  });

  test.each([
    { from: { id: USER + 1 } }, { chat: { id: CHAT + 1, type: "private" } }, { chat: { id: CHAT, type: "group" } },
    { forward_origin: {} }, { forward_date: 1 }, { via_bot: {} }, { sender_chat: {} }, { caption: "photo" },
  ])("an untrusted envelope %j never queues a turn, reads projects, or reaches the harness", async extra => {
    script.updates.push([textUpdate(2, "cancel everything", extra)]);
    expect(await pass()).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    expect(readProjects).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(script.sends()).toEqual([]);
  });

  test("an unpaired, rotated, or downgraded identity gets silence; a message queued before revocation runs nothing afterwards", async () => {
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
    script.updates.push([textUpdate(2, "hello")]);
    expect(await pass()).toMatchObject({ ok: true, report: { ignored: 1 } });
    store.handle.prepare("UPDATE approver SET generation = generation - 1 WHERE name = 'alex'").run();
    // Queued under a live pairing, revoked before the turn started: no harness call, no reply, the row says why.
    const queueOnly = vi.spyOn(store, "claimTelegramConversation").mockReturnValueOnce(null);
    script.updates.push([textUpdate(3, "hello again")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    queueOnly.mockRestore();
    expect(store.listTelegramConversations(BOT)[0]?.state).toBe("queued");
    // Unpairing ends what the chat could still do, in every chat app: the queued message is dropped with its words.
    store.unpairTelegram(BOT, "alex", now);
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "failed", outcome: "revoked", text: "" });
    expect(await pass()).toMatchObject({ ok: true, report: { sent: 0 } });
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "failed", outcome: "revoked" });
    expect(requests).toEqual([]);
    expect(script.sends()).toEqual([]);
  });

  test.each(["unpair", "unenroll", "viewer"])("%s while the harness is answering ends the turn before any tool runs: nothing proposed, nothing sent, the failure named", async change => {
    answers.push({
      text: "Holding it.",
      calls: [{ id: "h1", name: "propose_hold", args: { task: "a", reason: "wait" } }],
      before: () => {
        if (change === "unpair") store.unpairTelegram(BOT, "alex", now);
        else if (change === "unenroll") projects = [];
        else store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run();
      },
    });
    task("a");
    script.updates.push([textUpdate(2, "hold task a")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatRefused: 1 } });
    expect(requests).toHaveLength(1);
    const row = store.listTelegramConversations(BOT)[0]!;
    expect(row).toMatchObject({ state: "failed", outcome: expect.stringMatching(/^failed:revoked|^failed:superseded/) });
    expect(store.getMateTurn(row.turn!)).toMatchObject({ state: "failed" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_proposal").get()?.["n"]).toBe(0);
    expect(store.activeHolds(store.lookupRef("a")!.id, now)).toEqual([]);
    // Unenrolled: the pairing still stands, so the truth is said; unpaired or downgraded: nothing may be sent at all.
    if (change === "unenroll") {
      expect(script.texts()).toHaveLength(1);
      expect(script.texts()[0]).toBe(MATE_CHANNEL_COPY["projects-changed"]);
    } else {
      expect(script.sends()).toEqual([]);
    }
  });

  test.each(["unpair", "unenroll"])("%s between two model steps stops the turn before the second step's tools run: nothing proposed, no project data sent afterwards", async change => {
    answers.push(
      { text: "Reading.", calls: [{ id: "s1", name: "list_tasks", args: {} }] },
      {
        text: "Holding it.",
        calls: [{ id: "s2", name: "propose_hold", args: { task: "a", reason: "wait" } }],
        before: () => { if (change === "unpair") store.unpairTelegram(BOT, "alex", now); else projects = []; },
      },
      { text: "never reached" },
    );
    task("a");
    script.updates.push([textUpdate(2, "hold task a")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatRefused: 1 } });
    // The second step was already on the wire when the channel changed; nothing after it ran or went out.
    expect(requests).toHaveLength(2);
    expect(answers).toHaveLength(1);
    const row = store.listTelegramConversations(BOT)[0]!;
    expect(row).toMatchObject({ state: "failed", outcome: expect.stringMatching(/^failed:revoked|^failed:superseded/) });
    expect(store.getMateTurn(row.turn!)).toMatchObject({ state: "failed" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_proposal").get()?.["n"]).toBe(0);
    expect(store.activeHolds(store.lookupRef("a")!.id, now)).toEqual([]);
    expect(store.listTelegramConversationParts(row.id)).toEqual([]);
    if (change === "unenroll") expect(script.texts()).toEqual([MATE_CHANNEL_COPY["projects-changed"]]);
    else expect(script.sends()).toEqual([]);
  });

  test("a reply stays on its task: to a /task status, to the lead's answer about a task, and to a card; a reply to a general answer is for the lead", async () => {
    task("a", "Fix the login page");
    task("b", "Payout guard");
    const asked = () => (requests.at(-1)!.history.filter(one => one.role === "operator").at(-1) as { text: string }).text;
    const last = () => store.listTelegramConversations(BOT).at(-1)!;
    // A /task status, then back to the lead: the status message still names its task.
    script.updates.push([textUpdate(2, "/task a"), textUpdate(3, "/lead")]);
    expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 2 } });
    const status = script.sends().find(one => String(one.params["text"]).startsWith("Fix the login page"))!.messageId!;
    expect(store.telegramMessageBindings(binding(), String(status))).toMatchObject([{ taskId: "a", run: null }]);
    answers.push({ text: "It is waiting for your approval." });
    script.updates.push([textUpdate(4, "How is it going?", { reply_to_message: { message_id: status } })]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1 } });
    expect(last()).toMatchObject({ taskId: "a" });
    expect(asked()).toContain("Current task: a.");
    // The lead's answer about that task names it too: a reply to the answer stays on the login page.
    const answer = script.sends().at(-1)!;
    expect(answer.params["text"]).toBe("It is waiting for your approval.");
    expect(store.telegramMessageBindings(binding(), String(answer.messageId))).toMatchObject([{ taskId: "a" }]);
    answers.push({ text: "Noted." });
    script.updates.push([textUpdate(5, "Make the button bigger too.", { reply_to_message: { message_id: answer.messageId } })]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1 } });
    expect(last()).toMatchObject({ taskId: "a" });
    expect(asked()).toContain("Current task: a.");
    // A general message about another task: its card names that task; the general answer names none.
    answers.push(
      { text: "Drafting.", calls: [{ id: "g1", name: "propose_steer", args: { task: "b", note: "Keep amounts in cents." } }] },
      { text: "Confirm the card to pass that on." },
    );
    script.updates.push([textUpdate(6, "Tell the payout guard to keep amounts in cents.")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1 } });
    expect(last()).toMatchObject({ taskId: null });
    const sentCard = script.card();
    const general = script.sends().find(one => one.params["text"] === "Confirm the card to pass that on.")!;
    expect(store.telegramMessageBindings(binding(), String(sentCard.messageId))).toMatchObject([{ taskId: "b", run: null }]);
    expect(store.telegramMessageBindings(binding(), String(general.messageId))).toEqual([]);
    answers.push({ text: "Updated." }, { text: "Here is everything." });
    script.updates.push([
      textUpdate(7, "Actually, use whole numbers.", { reply_to_message: { message_id: sentCard.messageId } }),
      textUpdate(8, "What else is going on?", { reply_to_message: { message_id: general.messageId } }),
    ]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 2, chatAnswered: 2 } });
    const [onCard, onGeneral] = store.listTelegramConversations(BOT).slice(-2);
    expect(onCard).toMatchObject({ taskId: "b" });
    expect(onGeneral).toMatchObject({ taskId: null, context: null });
  });

  test("long text is refused whole with no model call; a reply to a digest naming two tasks asks which", async () => {
    const long = "x".repeat(2_001);
    script.updates.push([textUpdate(2, long)]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts()[0]).toContain("2,001 characters; chat takes up to 2,000");
    expect(script.texts()[0]).toContain("Nothing was sent to the assistant");
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    expect(requests).toEqual([]);
    // Two routine facts about two tasks in one digest part (Every step): a reply to it is ambiguous, never guessed.
    store.setNotificationPreference("alex", { mode: "all" }, "alex", now);
    const a = task("a"), b = task("b");
    store.enqueueNotification({ dedupeKey: "a-fact", kind: "report-ready", subject: "a moved", body: "a", source: { taskRef: a } }, now);
    store.enqueueNotification({ dedupeKey: "b-fact", kind: "report-ready", subject: "b moved", body: "b", source: { taskRef: b } }, now);
    store.setTelegramDigest(60_000, "alex", now);
    now = new Date(T0.getTime() + 61_000);
    expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 2, digests: 1 } });
    const digest = script.sends().at(-1)!;
    expect(String(digest.params["text"])).toContain("digest — 2 routine fact(s)");
    script.updates.push([textUpdate(3, "approve it", { reply_to_message: { message_id: digest.messageId } })]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts().at(-1)).toContain("is about more than one task");
    expect(script.texts().at(-1)).toContain("• work a");
    expect(script.texts().at(-1)).toContain("• work b");
    expect(script.texts().at(-1)).toContain("send /tasks to pick one");
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a crash between the engine's receipt and the reply is recovered after restart from the receipt — no second dispatch", async () => {
    answers.push({ text: "Nothing waits on you right now." });
    // The process dies right after the turn answered, before its row settles.
    const dying = vi.spyOn(store, "bindTelegramConversationTurn").mockImplementationOnce(() => { throw new Error("power cut"); });
    script.updates.push([textUpdate(2, "what needs me?")]);
    const crashed = await pass();
    expect(crashed).toMatchObject({ ok: true, report: { chatQueued: 1, problems: [expect.stringContaining("power cut")] } });
    dying.mockRestore();
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "running", outcome: null });
    expect(store.handle.prepare("SELECT state FROM mate_turn").all().map(row => row["state"])).toEqual(["answered"]);
    expect(script.sends()).toEqual([]);
    // Restart: a new process, the claim lapsed, the same update never re-read.
    store.close(); store = openStore(file);
    now = new Date(T0.getTime() + CONVERSATION_CLAIM_MS + 1_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
    expect(requests).toHaveLength(1);
    expect(script.texts()).toEqual(["Nothing waits on you right now."]);
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "done", outcome: "replayed", attempts: 2 });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()?.["n"]).toBe(1);
  });

  test("a crash while the harness was answering is reported truthfully after restart, never restarted silently", async () => {
    answers.push({ text: "Still thinking." });
    const dying = vi.spyOn(store, "finalizeChatTurn").mockImplementationOnce(() => { throw new Error("power cut"); });
    script.updates.push([textUpdate(2, "what needs me?")]);
    expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("power cut")] } });
    dying.mockRestore();
    store.close(); store = openStore(file);
    now = new Date(T0.getTime() + TURN_WALL_CLOCK_MS + CONVERSATION_CLAIM_MS + 60_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(requests).toHaveLength(1);
    expect(script.texts()).toEqual([mateFailureText("crashed")]);
    expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "failed", outcome: "replayed:crashed" });
  });

  describe("outgoing replies and cards are durable before they are sent", () => {
    const draft = () => answers.push(
      { text: "", calls: [{ id: "g0", name: "get_capabilities", args: { repo: "r1" } }] },
      { text: "Drafting.", calls: [{ id: "c1", name: "propose_task", args: { repo: "r1", title: "Add the limit", goal: "Add a payout limit.", acceptance: [{ id: "c1", statement: "The limit holds.", evidence: ["manual-review"] }] } }] },
      { text: "Proposed. Confirm to file." },
    );
    const row = () => store.listTelegramConversations(BOT)[0]!;
    const parts = () => store.listTelegramConversationParts(row().id);
    const turns = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()?.["n"]);
    const later = (ms: number) => { now = new Date(now.getTime() + ms); };

    test.each(["network", "abort", "invalid-json", "invalid-envelope"] as const)("the real HTTP adapter preserves %s uncertainty through retry, without another model turn", async fault => {
      draft();
      script.updates.push([textUpdate(2, "add a payout limit")]);
      let loseReply = true;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const method = String(url).split("/").at(-1)!;
        const params = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (method === "sendMessage" && loseReply) {
          loseReply = false;
          if (fault === "network") throw new Error("socket hang up");
          if (fault === "abort") throw new DOMException("response lost", "AbortError");
          return new Response(fault === "invalid-json" ? "not-json" : JSON.stringify({ result: {} }));
        }
        return new Response(JSON.stringify(await script.transport(method, params)));
      });
      const transport = createTransport("fixture-token");
      expect(await pass({ transport })).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("delivery may be uncertain")] } });
      expect(row().state).toBe("queued");
      expect(parts()[0]).toMatchObject({ state: "pending", attempts: 1, uncertain: 1, messageId: null });
      expect(requests).toHaveLength(3);
      store.close(); store = openStore(file);
      later(PART_RETRY_MS[0]);
      expect(await pass({ transport })).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(row().state).toBe("done");
      expect(parts()[0]).toMatchObject({ state: "sent", attempts: 2, uncertain: 1 });
      expect(requests).toHaveLength(3);
      expect(turns()).toBe(1);
    });

    test("a lost network answer: the reply and card were persisted first, the send is counted uncertain, and the retry needs no model call", async () => {
      draft();
      script.fault = () => "throw";
      script.updates.push([textUpdate(2, "add a payout limit")]);
      const first = await pass();
      // The person is told once, in plain words; on a dead wire that notice is lost too, and said so.
      expect(first).toMatchObject({ ok: true, report: { chatQueued: 1, problems: [expect.stringContaining("notice for update 2 could not be sent"), expect.stringContaining("is waiting to be sent: Telegram transport failed; delivery may be uncertain")] } });
      expect(String(script.calls.find(call => call.method === "sendMessage:failed" && String(call.params["text"]).startsWith("I couldn't"))?.params["text"])).toBe("I couldn't answer that just now: my reply may not have reached Telegram. Ask again, or open the console.");
      expect(first.ok && first.report.chatAnswered).toBeFalsy();
      expect(row()).toMatchObject({ state: "queued", outcome: "delivering", replyMessageId: null, nextAttemptAt: new Date(now.getTime() + PART_RETRY_MS[0]).toISOString() });
      expect(row().turn).not.toBeNull();
      // The exact output, per part, before any send: the reply answering the operator's message, then the card with its tokens already minted.
      expect(parts().map(one => [one.kind, one.state, one.attempts, one.uncertain, one.replyTo, one.messageId])).toEqual([["reply", "pending", 1, 1, "1002", null], ["card", "pending", 0, 0, null, null]]);
      expect(parts()[0]).toMatchObject({ text: "Proposed. Confirm to file.", lastError: "Telegram transport failed; delivery may be uncertain" });
      expect(parts()[1]!.keyboard!.flat().map(one => one.text)).toEqual(["Confirm", "Dismiss"]);
      const tokens = parts()[1]!.keyboard!.flat().map(one => one.callback_data);
      expect(tokens.map(one => store.getTelegramProposalAction(one)?.messageId)).toEqual([null, null]);
      expect(script.attempts()).toHaveLength(2);
      expect(requests).toHaveLength(3);
      // Too early: nothing is claimed. Then a second lost answer, counted again, with the longer wait — and no second notice.
      later(1_000);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [] } });
      expect(script.attempts()).toHaveLength(2);
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("delivery may be uncertain")] } });
      expect(script.attempts()).toHaveLength(3);
      expect(parts()[0]).toMatchObject({ state: "pending", attempts: 2, uncertain: 2, nextAttemptAt: new Date(now.getTime() + PART_RETRY_MS[1]).toISOString() });
      // The wire returns: both parts go out in order, once each, and only now is the row done — with no third model call and no second turn.
      script.fault = null;
      later(PART_RETRY_MS[1]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(script.texts()).toEqual(["Proposed. Confirm to file.", expect.stringContaining("Create task in repo: Add the limit")]);
      expect(script.sends()[0]!.params["reply_parameters"]).toEqual({ message_id: 1002 });
      expect(parts().map(one => [one.state, one.messageId, one.attempts])).toEqual([["sent", "100", 3], ["sent", "101", 1]]);
      expect(row()).toMatchObject({ state: "done", outcome: "replayed", replyMessageId: "100" });
      expect(requests).toHaveLength(3);
      expect(turns()).toBe(1);
      // The card that finally went out carries the tokens minted with the part, now placed on the confirmed message; a tap confirms once.
      expect(script.card().rows.flat().map(one => one.callback_data)).toEqual(tokens);
      expect(tokens.map(one => store.getTelegramProposalAction(one)?.messageId)).toEqual(["101", "101"]);
      expect(await tapPass(tokens[0]!, 101)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(1);
    });

    test("Telegram's retry_after on the card pauses every send bot-wide — the outbox included — and the card resumes with the same tokens after it", async () => {
      draft();
      script.fault = params => params["reply_markup"] === undefined ? null : { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } };
      script.updates.push([textUpdate(2, "add a payout limit")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, problems: [expect.stringContaining("is waiting to be sent: Too Many Requests (retry after 7s)")] } });
      const pausedUntil = new Date(now.getTime() + 7_000).toISOString();
      expect(store.telegramRetryAt(BOT)).toBe(pausedUntil);
      expect(row()).toMatchObject({ state: "queued", outcome: "delivering", nextAttemptAt: pausedUntil, replyMessageId: "100" });
      expect(parts().map(one => [one.kind, one.state, one.attempts, one.uncertain])).toEqual([["reply", "sent", 1, 0], ["card", "pending", 1, 0]]);
      const planned = parts()[1]!.keyboard!.flat().map(one => one.callback_data);
      // The pause holds the outbox's own rows too, and the conversation is not claimed before it ends — even after a restart.
      script.fault = null;
      store.enqueueNotification({ dedupeKey: "fact", kind: "report-ready", subject: "A fact", body: "landed", source: { taskRef: task("a") } }, now);
      store.close(); store = openStore(file);
      later(6_999);
      expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 0 } });
      expect(script.attempts()).toHaveLength(2);
      later(1);
      expect(await pass({ deliver: true })).toMatchObject({ ok: true, report: { sent: 1, chatAnswered: 1, problems: [] } });
      expect(script.card().rows.flat().map(one => one.callback_data)).toEqual(planned);
      expect(parts()[1]).toMatchObject({ state: "sent", messageId: String(script.card().messageId), attempts: 2 });
      expect(row()).toMatchObject({ state: "done", outcome: "replayed" });
      expect(requests).toHaveLength(3);
      expect(turns()).toBe(1);
      expect(await tapPass(planned[0]!, script.card().messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
    });

    test("an ok answer without a message id is not a delivery: the part stays pending and uncertain, and the row is not done until Telegram confirms one", async () => {
      answers.push({ text: "Nothing waits on you." });
      script.fault = () => "no-id";
      script.updates.push([textUpdate(2, "what needs me?")]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("Telegram returned no confirmed message identity")] } });
      expect(parts()).toEqual([expect.objectContaining({ kind: "reply", state: "pending", messageId: null, attempts: 1, uncertain: 1, lastError: "Telegram returned no confirmed message identity" })]);
      expect(row()).toMatchObject({ state: "queued", outcome: "delivering", replyMessageId: null });
      script.fault = null;
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
      expect(parts()[0]).toMatchObject({ state: "sent", messageId: "100", attempts: 2, uncertain: 1 });
      expect(row()).toMatchObject({ state: "done", replyMessageId: "100" });
      expect(requests).toHaveLength(1);
    });

    test("a crash after the first part of a long reply was confirmed: the restart sends only the rest, with no model call", async () => {
      const long = "The queue is quiet. ".repeat(220);
      // Asked once to shorten (it is over 4,096), the lead keeps it: it goes out split.
      answers.push({ text: long }, { text: long });
      let renewals = 0;
      const original = store.renewTelegramConversation.bind(store);
      const dying = vi.spyOn(store, "renewTelegramConversation").mockImplementation((...args) => { if (++renewals === 2) throw new Error("power cut"); return original(...args); });
      script.updates.push([textUpdate(2, "how is the queue?")]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("power cut")] } });
      dying.mockRestore();
      // Split as written at the last sentence that fits, then shaped: neither part ends mid-word.
      const first = "The queue is quiet. ".repeat(195).trimEnd(), rest = "The queue is quiet. ".repeat(25).trimEnd();
      expect(script.texts()).toEqual([first]);
      expect(parts().map(one => [one.state, one.messageId])).toEqual([["sent", "100"], ["pending", null]]);
      expect(row()).toMatchObject({ state: "running", replyMessageId: "100" });
      store.close(); store = openStore(file);
      later(CONVERSATION_CLAIM_MS + 1_000);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(script.texts()).toEqual([first, rest]);
      expect(parts().map(one => [one.state, one.messageId])).toEqual([["sent", "100"], ["sent", "101"]]);
      expect(row()).toMatchObject({ state: "done", outcome: "replayed", attempts: 2 });
      // The answer and its one shorten step, both before the crash: the restart made no model call.
      expect(requests).toHaveLength(2);
      expect(turns()).toBe(1);
    });

    test("a card whose proposal was confirmed on the console before it went out is dropped as moot, and the row still completes", async () => {
      draft();
      script.fault = params => params["reply_markup"] === undefined ? null : "throw";
      script.updates.push([textUpdate(2, "add a payout limit")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
      const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id, ["pending"])[0]!;
      expect(confirmMateProposal(store, who(), proposal.id, now, { via: "web" })).toMatchObject({ ok: true, kind: "task" });
      script.fault = null;
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
      expect(parts().map(one => [one.kind, one.state, one.lastError])).toEqual([["reply", "sent", null], ["card", "dropped", "the proposal was already confirmed"]]);
      expect(script.sends()).toHaveLength(1);
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]).toBe(1);
    });

    test("a project unenrolled while the reply waits: the model's text never goes out under a changed ceiling, and the row says so", async () => {
      answers.push({ text: "Two tasks are queued." });
      script.fault = () => "throw";
      script.updates.push([textUpdate(2, "how do things stand?")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
      script.fault = null;
      projects = [];
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1, problems: [expect.stringContaining("was not sent: the connected projects changed")] } });
      expect(script.texts()).toEqual([expect.stringMatching(/^The connected projects changed, so the assistant's reply was not sent\. Nothing was changed\./)]);
      expect(parts()[0]).toMatchObject({ state: "pending", messageId: null });
      expect(row()).toMatchObject({ state: "failed", outcome: "unsent:the connected projects changed" });
    });
  });

  describe("the original turn is bound before the first dispatch", () => {
    const replaceSession = () => {
      const original = store.activeMateSession("alex")!;
      store.endMateSession(original.id, "alex", now);
      const me = who();
      const replacement = store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: me.ceilingDigest, termsDigest: "t".repeat(64) }, now);
      return { original, replacement };
    };

    test("the session is on the row before the harness is called, and a crash after the answer with the session then ended and replaced from the console recovers the original turn from ITS receipt", async () => {
      let boundAtDispatch: number | null | undefined;
      answers.push({ text: "Nothing waits on you right now.", before: () => { boundAtDispatch = store.listTelegramConversations(BOT)[0]!.session; } });
      const dying = vi.spyOn(store, "bindTelegramConversationTurn").mockImplementationOnce(() => { throw new Error("power cut"); });
      script.updates.push([textUpdate(2, "what needs me?")]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("power cut")] } });
      dying.mockRestore();
      expect(boundAtDispatch).toBe(store.activeMateSession("alex")!.id);
      expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "running", session: boundAtDispatch, turn: null });
      expect(script.sends()).toEqual([]);
      const { original, replacement } = replaceSession();
      store.close(); store = openStore(file);
      now = new Date(T0.getTime() + CONVERSATION_CLAIM_MS + 1_000);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(requests).toHaveLength(1);
      expect(script.texts()).toEqual(["Nothing waits on you right now."]);
      const row = store.listTelegramConversations(BOT)[0]!;
      expect(row).toMatchObject({ state: "done", outcome: "replayed", session: original.id, attempts: 2 });
      expect(store.getMateTurn(row.turn!)).toMatchObject({ session: original.id, state: "answered" });
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()?.["n"]).toBe(1);
      // The console's replacement session was neither used nor touched.
      expect(store.activeMateSession("alex")?.id).toBe(replacement);
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn WHERE session = ?").get(replacement)?.["n"]).toBe(0);
    });

    test("a crash while the harness was answering, with the session then replaced, is reported as an unfinished attempt — once, with no new dispatch", async () => {
      answers.push({ text: "Still thinking." });
      const dying = vi.spyOn(store, "finalizeChatTurn").mockImplementationOnce(() => { throw new Error("power cut"); });
      script.updates.push([textUpdate(2, "what needs me?")]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("power cut")] } });
      dying.mockRestore();
      const { original } = replaceSession();
      store.close(); store = openStore(file);
      now = new Date(T0.getTime() + TURN_WALL_CLOCK_MS + CONVERSATION_CLAIM_MS + 60_000);
      expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
      expect(requests).toHaveLength(1);
      // Ending the session from the console superseded the running turn; that is the word the phone gets, not a silent restart.
      expect(script.texts()).toEqual([MATE_FAILURE_COPY.stopped]);
      expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "failed", outcome: "replayed:superseded", session: original.id });
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()?.["n"]).toBe(1);
      expect(store.listTelegramConversationParts(store.listTelegramConversations(BOT)[0]!.id)).toEqual([]);
    });
  });

  test("a console confirmation racing the tap wins once: the tap shows the recorded outcome and files nothing", async () => {
    answers.push(
      { text: "", calls: [{ id: "g0", name: "get_capabilities", args: { repo: "r1" } }] },
      { text: "Drafting.", calls: [{ id: "c1", name: "propose_task", args: { repo: "r1", title: "Add the limit", goal: "Add a payout limit.", acceptance: [{ id: "c1", statement: "The limit holds.", evidence: ["manual-review"] }] } }] },
      { text: "Proposed. Confirm to file." },
    );
    script.updates.push([textUpdate(2, "add a payout limit")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    const sent = script.card();
    const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id, ["pending"])[0]!;
    expect(confirmMateProposal(store, who(), proposal.id, now, { via: "web" })).toMatchObject({ ok: true, kind: "task" });
    const tasks = () => store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"];
    const before = tasks();
    const raced = await tapPass(sent.button(/^Confirm$/), sent.messageId);
    expect(raced).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(raced.ok && raced.report.chatConfirmed).toBeFalsy();
    expect(tasks()).toBe(before);
    expect(script.acks().at(-1)).toBe("already done");
    expect(script.edits().at(-1)).toMatch(/^✓ Done \(from web\): filed /);
    // A stale button — the same token again, or the token on another message — does nothing more.
    expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(await tapPass(sent.button(/^Dismiss$/), sent.messageId + 1)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(script.acks().at(-1)).toContain("that button is stale");
    // The wrong person's tap is silence, not even an acknowledgement.
    script.updates.push([tap(nextUpdate++, sent.button(/^Dismiss$/), sent.messageId, { from: { id: USER + 1 } })]);
    const acksBefore = script.acks().length;
    expect(await pass()).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(script.acks()).toHaveLength(acksBefore);
    expect(tasks()).toBe(before);
  });

  test("the other order: the tap confirms first, and a console confirmation of the same card afterwards is refused as already acted on", async () => {
    answers.push(
      { text: "", calls: [{ id: "g0", name: "get_capabilities", args: { repo: "r1" } }] },
      { text: "Drafting.", calls: [{ id: "c1", name: "propose_task", args: { repo: "r1", title: "Add the limit", goal: "Add a payout limit.", acceptance: [{ id: "c1", statement: "The limit holds.", evidence: ["manual-review"] }] } }] },
      { text: "Proposed. Confirm to file." },
    );
    script.updates.push([textUpdate(2, "add a payout limit")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    const sent = script.card();
    const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id, ["pending"])[0]!;
    expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
    const tasks = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"]);
    expect(confirmMateProposal(store, who(), proposal.id, now, { via: "web" })).toMatchObject({ ok: false, reason: "not-pending" });
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()?.["n"])).toBe(tasks);
    expect(store.getMateProposal(proposal.id)?.outcome).toMatchObject({ ok: true, via: "telegram" });
  });

  test("a session mismatch starts a fresh lead session and the person gets an answer; while a console turn runs the message waits instead (c2)", async () => {
    // Oct 1: a console session over another ceiling refused the phone ("refused:session-mismatch") and nothing was sent.
    const me = who();
    store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([repo, "/elsewhere"]), termsDigest: "t".repeat(64) }, now);
    const stale = store.activeMateSession("alex")!;
    answers.push({ text: "Toolroll 0.9.9 is the latest." });
    script.updates.push([textUpdate(2, "what's the latest update of toolroll include")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1 } });
    expect(script.texts()).toEqual(["Toolroll 0.9.9 is the latest."]);
    const fresh = store.activeMateSession("alex")!;
    expect(fresh.id).not.toBe(stale.id);
    expect(fresh).toMatchObject({ ceilingDigest: me.ceilingDigest, endedAt: null });
    expect(store.getMateSession(stale.id)?.endedAt).not.toBeNull();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ state: "done", outcome: "answered", session: fresh.id });
    expect(requests).toHaveLength(1);
    // A mismatched session with a turn still running on the computer is not ended under it: the message waits.
    store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([repo, "/elsewhere"]), termsDigest: "t".repeat(64) }, now);
    const busy = store.activeMateSession("alex")!;
    const busyThread = store.openMateThread("alex", ceilingDigestOf([repo, "/elsewhere"]), now).thread;
    const console = store.openMateTurn({ approver: "alex", session: busy.id, thread: busyThread.id, credentialKey: subscriptionCredentialKey("claude-subscription"), reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, now);
    if (!console.ok) throw new Error(console.reason);
    const consoleStarted = store.startMateTurn(console.id, now);
    if (!consoleStarted.ok) throw new Error("start");
    script.updates.push([textUpdate(4, "and before that?")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ state: "queued", outcome: "busy" });
    expect(store.getMateTurn(console.id)?.state).toBe("running");
    expect(store.getMateSession(busy.id)?.endedAt).toBeNull();
    expect(store.finalizeMateTurn(console.id, consoleStarted.generation, { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 }, now)).toBe(true);
    answers.push({ text: "0.9.8 before it." });
    now = new Date(now.getTime() + 6_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    expect(script.texts().at(-1)).toBe("0.9.8 before it.");
    expect(store.getMateSession(busy.id)?.endedAt).not.toBeNull();
    // Nobody waits forever: a message that stays blocked is answered in plain words once it gives up.
    store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([repo, "/elsewhere"]), termsDigest: "t".repeat(64) }, now);
    const stuck = store.activeMateSession("alex")!;
    const stuckTurn = store.openMateTurn({ approver: "alex", session: stuck.id, thread: store.openMateThread("alex", ceilingDigestOf([repo, "/elsewhere"]), now).thread.id, credentialKey: subscriptionCredentialKey("claude-subscription"), reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60 * 60_000 }, now);
    if (!stuckTurn.ok || !store.startMateTurn(stuckTurn.id, now).ok) throw new Error("start");
    script.updates.push([textUpdate(5, "still there?")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    now = new Date(now.getTime() + 11 * 60_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts().at(-1)).toBe("I couldn't answer that just now: the assistant stayed busy with another message. Ask again, or open the console.");
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ state: "failed", outcome: "busy:gave-up" });
  });

  test("a busy engine defers the phone's message instead of failing it", async () => {
    const me = who();
    // A turn already running on the console: the phone's message waits its turn.
    answers.push({ text: "Hi." });
    const session = store.mintMateSession({ approver: "alex", approverGeneration: me.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: me.ceilingDigest, termsDigest: "t".repeat(64) }, now);
    const thread = store.openMateThread("alex", me.ceilingDigest, now).thread;
    const running = store.openMateTurn({ approver: "alex", session, thread: thread.id, credentialKey: subscriptionCredentialKey("claude-subscription"), reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, now);
    if (!running.ok) throw new Error(running.reason);
    const startedRunning = store.startMateTurn(running.id, now);
    if (!startedRunning.ok) throw new Error("start");
    script.updates.push([textUpdate(3, "hello?")]);
    const deferred = await pass();
    expect(deferred).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    expect(deferred.ok && deferred.report.chatAnswered).toBeFalsy();
    expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ state: "queued", outcome: "busy" });
    expect(store.getMateTurn(running.id)?.state).toBe("running");
    // The console turn ends; the deferred message runs on the next pass on the same thread.
    expect(store.finalizeMateTurn(running.id, startedRunning.generation, { state: "failed", settledMicrousd: 0, unknownSpend: false, tokensIn: 0, tokensOut: 0, failureReason: "ended" }, now)).toBe(true);
    now = new Date(now.getTime() + 6_000);
    expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
    expect(script.texts().at(-1)).toBe("Hi.");
    expect(store.listMateMessages(thread.id, 10).map(one => one.role)).toEqual(["operator", "assistant"]);
  });

  test("a direct-API configuration is never spent from the phone", async () => {
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 10_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 }, "alex", now);
    script.updates.push([textUpdate(2, "hello")]);
    expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts()[0]).toContain("Direct API chat stays on the computer");
    expect(requests).toEqual([]);
    expect(store.activeMateSession("alex")).toBeNull();
  });

  describe("every confirmable kind through the phone's card", () => {
    const outcome = (id: number) => store.getMateProposal(id)!;

    test("next, reserve, hold, unhold and steer confirm through the shared door as telegram", async () => {
      task("a"); task("b");
      const place = store.queuePosition("a")!;
      const next = card("next", { task: "a", taskTitle: "work a", position: place.position, column: place.column ?? null, of: 2, queueRevision: store.queueRevision() });
      expect(next.preview.text).toContain("Move work a to the front of its queue");
      expect(await tapPass(next.confirm, next.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(next.id)).toMatchObject({ state: "confirmed", outcome: { ok: true, via: "telegram" } });
      const after = store.queuePosition("b")!;
      const reserve = card("reserve", { task: "b", taskTitle: "work b", worker: null, position: after.position, column: after.column ?? null, queueRevision: store.queueRevision() });
      expect(reserve.preview.text).toContain("Release work b to the shared queue.");
      expect(await tapPass(reserve.confirm, reserve.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(reserve.id).outcome).toMatchObject({ ok: true, via: "telegram" });
      const hold = card("hold", { task: "a", taskTitle: "work a", reason: "wait for the audit", sawHold: null });
      expect(hold.preview.text).toContain("Hold work a: wait for the audit");
      expect(await tapPass(hold.confirm, hold.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      const standing = store.activeHolds(store.lookupRef("a")!.id, now).find(one => one.ownerKind === "operator")!;
      expect(standing.reason).toBe("wait for the audit");
      const unhold = card("unhold", { task: "a", taskTitle: "work a", holdId: standing.id });
      expect(await tapPass(unhold.confirm, unhold.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.activeHolds(store.lookupRef("a")!.id, now)).toEqual([]);
      const steer = card("steer", { task: "b", taskTitle: "work b", note: "Prefer the smaller diff." });
      expect(steer.preview.text).toContain("| Prefer the smaller diff.");
      expect(await tapPass(steer.confirm, steer.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(steer.id)).toMatchObject({ state: "confirmed", outcome: { said: "Guidance saved for work b's next attempt", via: "telegram" } });
      expect(script.edits().at(-1)).toBe("✓ Guidance saved for work b's next attempt");
      // Dismiss is the same door's decline, recorded once.
      const dismissed = card("hold", { task: "b", taskTitle: "work b", reason: "no", sawHold: null });
      const declined = await tapPass(dismissed.dismiss, dismissed.messageId);
      expect(declined.ok && declined.report.chatConfirmed).toBeFalsy();
      expect(outcome(dismissed.id).state).toBe("dismissed");
      expect(script.edits().at(-1)).toBe("Dismissed.");
      expect(await tapPass(dismissed.confirm, dismissed.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(script.acks().at(-1)).toBe("already dismissed");
    });

    test("dependency repair, agents and scope confirm through their shared doors; scope and agents hand the approval back to the computer", async () => {
      task("d"); task("e");
      expect(store.addEdge("d", "e").ok).toBe(true);
      store.setTaskState("e", "failed", now);
      const repair = card("repair", { task: "d", taskTitle: "work d", blocker: "e", blockerTitle: "work e", operation: "retry", sawBlockerState: "failed" });
      expect(repair.preview.text).toContain("Queue work e again; work d follows when it finishes.");
      expect(await tapPass(repair.confirm, repair.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getTask("e")?.state).toBe("queued");
      expect(outcome(repair.id).outcome).toMatchObject({ ok: true, via: "telegram" });
      // Agents: a configured, role-valid choice drafted by the real tool, confirmed through the authenticated route edit.
      store.setPhaseTierConfig("installation", "build", "strong", "codex", "gpt-5-codex", "ops", now);
      task("f");
      propose(store, { taskId: "f", goal: "Harden the flow", acceptance: [{ id: "c1", statement: "It holds", how: null, evidence: ["check"] }], now });
      let drafted: Record<string, unknown> | null = null;
      const ctx = { store, who: who(), now, step: 2, readDecisions: new Map<number, number>(), draft: (_kind: string, payload: Record<string, unknown>) => { drafted = payload; return 1; } };
      expect(executeMateTool({ ...ctx, step: 1 }, "get_agents", { task: "f" })).toMatchObject({ ok: true });
      expect(executeMateTool(ctx, "propose_agents", { task: "f", role: "builder", agent: { provider: "codex", model: "gpt-5-codex" } })).toMatchObject({ ok: true });
      const agents = card("agents", drafted!);
      expect(agents.preview.text).toContain("Change agents for work f: builder: codex gpt-5-codex");
      expect(agents.preview.text).toContain("renewed approval before work starts");
      expect(await tapPass(agents.confirm, agents.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.refForId(store.lookupRef("f")!.id)?.routeOverrides).toEqual([expect.objectContaining({ phase: "build", provider: "codex", model: "gpt-5-codex" })]);
      // The route change staled f's approval: the recorded scope waits again, and the card says so once, unlinked here.
      expect(script.edits().at(-1)).toBe(`✓ Agents changed for work f: the builder is now codex · gpt-5-codex\n\nApprove it in Toolroll on the computer.\n\n${NO_PHONE_LINK}`);
      expect(store.getScope("f")?.approvedDigest ?? null).not.toBe(store.getScope("f")?.digest);
      expect(urlButtons(lastEdit())).toEqual([]);
      // Scope: rewritten through the guarded proposal; approval is the password ceremony, reached by one precise button under a trusted origin.
      origin = "https://console.example";
      const scope = card("scope", { task: "d", taskTitle: "work d", goal: "Do d with a smaller blast radius", acceptance: [{ id: "c1", statement: "d is smaller", evidence: ["manual-review"] }], sawDigest: store.getScope("d")?.digest ?? null });
      expect(scope.preview.text).toContain("the new scope still needs your password approval");
      expect(await tapPass(scope.confirm, scope.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(outcome(scope.id).outcome).toMatchObject({ ok: true, via: "telegram" });
      expect(store.getScope("d")).toMatchObject({ goal: "Do d with a smaller blast radius", proposedVia: "mate" });
      expect(script.edits().at(-1)).toBe("✓ d's scope rewritten — approve it with your password on the task");
      expect(urlButtons(lastEdit())).toEqual([["Review & start", "https://console.example/chat?task=d#task-chat-action"]]);
    });

    test("answers: a reversible option answers on the first confirm; an irreversible one arms a yes/cancel pair, and cancel restores the card", async () => {
      const ref = task("q");
      const route = store.routeAuthorityFor(ref, "builder", null);
      const run = store.startRun({ taskRef: ref, leaseId: "l-q", runner: "r", branch: "b", worktree: "/w", ...(route?.ok ? { route: route.stamp } : { route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" as const } }), now });
      const options = [{ id: "open", label: "Fail open", consequence: "Requests pass while the check is down", reversible: true }, { id: "closed", label: "Fail closed", consequence: "Requests are refused; a rollback restores them", reversible: false }];
      const first = store.saveDecision({ run, urgency: "blocking", recap: "The check can fail", question: "Fail open or closed?", options, recommendation: "closed" }, now);
      const easy = card("answer", { decision: first, task: "q", taskTitle: "work q", option: "open", optionLabel: "Fail open", reversible: true, rationale: "Keep traffic flowing" });
      expect(easy.preview.text).toContain("Q: Fail open or closed?");
      expect(easy.preview.text).toContain("→ Fail open: Requests pass while the check is down");
      expect(easy.preview.text).toContain("Fail closed — IRREVERSIBLE (the builder recommends this)");
      expect(await tapPass(easy.confirm, easy.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getDecision(first)).toMatchObject({ state: "answered", choice: "open", answeredBy: "alex", answeredVia: "telegram" });
      const second = store.saveDecision({ run, urgency: "blocking", recap: "Again", question: "Fail open or closed?", options, recommendation: "closed" }, now);
      const hard = card("answer", { decision: second, task: "q", taskTitle: "work q", option: "closed", optionLabel: "Fail closed", reversible: false, rationale: "Safer" });
      expect(hard.preview.text).toContain("⚠ This choice is irreversible. Confirming asks you once more.");
      const armedPass = await tapPass(hard.confirm, hard.messageId);
      expect(armedPass).toMatchObject({ ok: true, report: { ignored: 0 } });
      expect(armedPass.ok && armedPass.report.chatConfirmed).toBeFalsy();
      expect(store.getDecision(second)?.state).toBe("open");
      expect(script.acks().at(-1)).toBe("irreversible — confirm it");
      const armed = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      const keyboard = (armed.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
      const yes = keyboard.find(one => one.text.startsWith("⚠ Yes"))!.callback_data;
      const cancel = keyboard.find(one => one.text === "Cancel")!.callback_data;
      // Cancel: the yes dies, the card comes back with fresh buttons; the old yes is stale.
      expect(await tapPass(cancel, hard.messageId)).toMatchObject({ ok: true, report: { ignored: 0 } });
      expect(script.acks().at(-1)).toBe("cancelled");
      const restored = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      expect(await tapPass(yes, hard.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(store.getDecision(second)?.state).toBe("open");
      const again = (restored.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
      expect(await tapPass(again.find(one => one.text === "Confirm")!.callback_data, hard.messageId)).toMatchObject({ ok: true });
      const rearmed = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      const yes2 = (rearmed.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find(one => one.text.startsWith("⚠ Yes"))!.callback_data;
      expect(await tapPass(yes2, hard.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getDecision(second)).toMatchObject({ state: "answered", choice: "closed", answeredVia: "telegram" });
      expect(outcome(hard.id).outcome).toMatchObject({ ok: true, via: "telegram" });
    });

    test("mark complete: the phone card confirms behind its own yes/cancel challenge, records the assignment check for the exact result, and cancel restores the card", async () => {
      const ref = task("done-1", "Keep the guard readable");
      propose(store, { taskId: "done-1", goal: "Keep the guard readable", touches: ["src/guard.ts"], acceptance: [{ id: "c1", statement: "The guard stays readable", how: null, evidence: ["check"] }], now });
      const scope = store.getScope("done-1")!;
      const approved = approve(store, "done-1", "alex", now, scope.digest, token);
      if (!approved.ok) throw new Error(`approval refused: ${approved.reason}`);
      const route = store.routeAuthorityFor(ref, "builder", null);
      if (!route?.ok) throw new Error("route");
      const run = store.startRun({ taskRef: ref, leaseId: "l-done-1", runner: "builder-1", branch: "so/done-1", worktree: "/pool/done-1", route: route.stamp, now });
      store.stampRun(run, { scopeDigest: scope.digest, baseRevision: "b".repeat(40) });
      store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "The guard reads well." });
      store.finishRun(run, { outcome: "built", committed: true, now });
      store.setTaskState("done-1", "done", now);
      const assignment = () => assignmentOf(store, "done-1", now, { principal: "operator", repos: [repo] }, evidenceRoot);
      expect(assignment()?.state).toBe("ready-to-check");
      const payload = prepareSharedAction(store, who(), "result_accept", { task: "done-1", run }, evidenceRoot, now);
      const complete = card("action", { ...payload });
      const preview = proposalPreview(store, store.getMateProposal(complete.id)!, [repo], "telegram");
      expect(preview.buttons).toBe(true);
      expect(preview.text).toContain("Accept and finish: Keep the guard readable");
      expect(preview.text).toContain("Confirm asks once more before anything is recorded.");
      // Other channels keep the secure handoff for the same card.
      expect(complete.preview.buttons).toBe(false);
      // Confirm arms the challenge; nothing is recorded yet.
      expect(await tapPass(complete.confirm, complete.messageId)).toMatchObject({ ok: true, report: { ignored: 0 } });
      expect(script.acks().at(-1)).toBe("confirm it");
      expect(assignment()?.state).toBe("ready-to-check");
      const armed = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      expect(String(armed.params["text"])).toContain("This records that you handled this exact result. Confirm?");
      const keyboard = (armed.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
      const yes = keyboard.find(one => one.text === "✓ Yes, accept and finish")!.callback_data;
      const cancel = keyboard.find(one => one.text === "Cancel")!.callback_data;
      // Cancel restores the card; the stale yes changes nothing.
      expect(await tapPass(cancel, complete.messageId)).toMatchObject({ ok: true, report: { ignored: 0 } });
      expect(await tapPass(yes, complete.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(assignment()?.state).toBe("ready-to-check");
      const restored = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      const again = (restored.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
      expect(await tapPass(again.find(one => one.text === "Confirm")!.callback_data, complete.messageId)).toMatchObject({ ok: true });
      const rearmed = script.calls.filter(call => call.method === "editMessageText").at(-1)!;
      const yes2 = (rearmed.params["reply_markup"] as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find(one => one.text === "✓ Yes, accept and finish")!.callback_data;
      expect(await tapPass(yes2, complete.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(assignment()).toMatchObject({ state: "complete", completion: { actor: "operator:alex" } });
      expect(store.proofAcceptance(run)).toBeNull();
      expect(outcome(complete.id).outcome).toMatchObject({ ok: true, via: "telegram", said: "Accepted and finished. The recorded checks are unchanged." });
      expect(String(script.calls.filter(call => call.method === "editMessageText").at(-1)!.params["text"])).toContain("✓ Accepted and finished.");
      // A repeated yes is spent; the record is unchanged.
      expect(await tapPass(yes2, complete.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
    });

    test("task actions: retry, plan, dependencies and a stop confirm through the shared door — the stop is audited as telegram; resume only opens the password step", async () => {
      task("r"); task("s");
      store.setTaskState("r", "failed", now);
      const stamp = (id: string) => chatTaskStamp(store, who(), id)!;
      const retry = card("task_action", { task: "r", taskTitle: "work r", operation: "retry", stamp: stamp("r") });
      expect(retry.preview.text).toContain("Try again: work r");
      expect(await tapPass(retry.confirm, retry.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.getTask("r")?.state).toBe("queued");
      const plan = card("task_action", { task: "s", taskTitle: "work s", operation: "plan", stamp: stamp("s") });
      expect(await tapPass(plan.confirm, plan.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.lookupRef("s")?.plan).toBe("requested");
      const wait = card("task_action", { task: "r", taskTitle: "work r", operation: "wait_for", dependency: "s", dependencyTitle: "work s", stamp: stamp("r") });
      expect(wait.preview.text).toContain("Add dependency: work r · work s");
      expect(await tapPass(wait.confirm, wait.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.blockers("r")).toEqual(["s"]);
      const unwait = card("task_action", { task: "r", taskTitle: "work r", operation: "stop_waiting", dependency: "s", dependencyTitle: "work s", stamp: stamp("r") });
      expect(await tapPass(unwait.confirm, unwait.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.blockers("r")).toEqual([]);
      // A stale card (the task moved on) refuses through the same door.
      const stale = card("task_action", { task: "s", taskTitle: "work s", operation: "retry", stamp: stamp("s") });
      store.setTaskState("s", "done", now);
      const refused = await tapPass(stale.confirm, stale.messageId);
      expect(refused.ok && refused.report.chatConfirmed).toBeFalsy();
      expect(outcome(stale.id)).toMatchObject({ state: "refused", outcome: { reason: "stale", via: "telegram" } });
      expect(script.edits().at(-1)).toMatch(/^✗ Not done: This task changed/);
      // The stop: a live claimed attempt, requested from the phone, audited as such, its process signal deferred past commit.
      const ref = task("t");
      propose(store, { taskId: "t", goal: "Keep the saved work", acceptance: [{ id: "c1", statement: "ok", how: null, evidence: ["manual-review"] }], now });
      expect(approve(store, "t", "alex", now, store.getScope("t")!.digest, token).ok).toBe(true);
      register(store, { name: "worker", host: "test", capacity: 1, repos: [repo], now, newToken: () => "worker-token" });
      const claim = acquire(store, ref, "worker", { token: "worker-token", now });
      if (!claim.ok) throw new Error(claim.reason);
      const route = store.routeAuthorityFor(ref, "builder", null);
      if (!route?.ok) throw new Error("route");
      const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "worker", branch: "b", worktree: "/pool/t", route: route.stamp, now });
      const stop = card("task_action", { task: "t", taskTitle: "work t", operation: "stop", run, stamp: stamp("t") });
      expect(stop.preview.text).toContain("Stop task: work t");
      expect(await tapPass(stop.confirm, stop.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.stopOf(run)).toMatchObject({ requestedBy: "alex", requestedVia: "telegram", settledAt: null });
      expect(outcome(stop.id).outcome).toMatchObject({ ok: true, said: `Stop requested for t, run #${run}.`, via: "telegram" });
      // Resume is a password ceremony: the card says so before and after, and confirming resumes nothing.
      // The stopped attempt ends and its stop settles, so the task is paused — the state a resume card is minted from.
      store.finishRun(run, { outcome: "failed", reason: "interrupted", committed: true, now });
      expect(store.stopOf(run)?.settledAt).not.toBeNull();
      origin = "https://console.example";
      const resume = card("task_action", { task: "t", taskTitle: "work t", operation: "resume", run, stamp: stamp("t") });
      expect(resume.preview.text).toContain("Confirming only requests the resume. Work resumes after the password step on the task, not from here.");
      expect(urlButtons(script.sends().at(-1))).toEqual([]);
      const stateBefore = store.getTask("t")?.state;
      expect(await tapPass(resume.confirm, resume.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(script.edits().at(-1)).toBe("✓ Resume review requested for t. Complete the password confirmation on the task to resume.\n\nNothing has resumed yet: the password step on the task finishes it.");
      expect(script.edits().at(-1)).not.toMatch(/resumed\.|is running/);
      expect(urlButtons(lastEdit())).toEqual([["Open task", "https://console.example/chat?task=t"]]);
      expect(store.getTask("t")?.state).toBe(stateBefore);
      expect(store.stopOf(run)).toMatchObject({ requestedVia: "telegram", resumedAt: null, resumedVia: null });
      expect(TELEGRAM_ACTION_PARITY["propose_task_action"]?.gap).toContain("resume completes in the console");
    });

    test("review note saves feedback without a revision; cancel and console controls are handoffs with no button", async () => {
      const { run } = seedSource("n");
      const snapshot = readChatResult(store, who(), evidenceRoot, "n", run);
      if (!snapshot.ok) throw new Error(snapshot.message);
      const note = card("review", { task: "n", taskTitle: "Guard the payout path (n)", run, snapshot: snapshot.snapshot, operation: "note", note: "Looks right; keep the early return.", path: null, line: null, notes: [] });
      expect(note.preview.text).toContain(`Save feedback on result #${run} of Guard the payout path (n)`);
      expect(note.preview.text).toContain("Saves feedback; no work starts.");
      expect(await tapPass(note.confirm, note.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      expect(store.allDiffComments(run).map(one => [one.author, one.note, one.consumedBy])).toEqual([["alex", "Looks right; keep the early return.", null]]);
      expect(store.taskFamilyOf("n", [repo], false)?.versions).toHaveLength(1);
      expect(script.edits().at(-1)).toBe("✓ Feedback saved. No work started.");
      task("z");
      const cancel = card("cancel", { task: "z", taskTitle: "work z", reason: "no longer needed" });
      expect(cancel.preview).toMatchObject({ buttons: false });
      expect(cancel.preview.text).toContain("Cancelling is armed on the task itself, never from a card.");
      expect(cancel.preview.text).toContain("This step finishes in Toolroll.");
      expect(cancel.preview.text).not.toMatch(/http|localhost|\//);
      const control = card("control", { control: "publish", task: "z", taskTitle: "work z" });
      expect(control.preview).toMatchObject({ buttons: false });
      expect(control.preview.text).toContain("Review publication for work z");
      expect(control.preview.text).not.toMatch(/http|localhost|\//);
      // A tap on a handoff card (a forged keyboard) changes nothing; unconfigured, the repaint says why there is no button.
      expect(await tapPass(cancel.confirm, cancel.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(store.getTask("z")?.state).not.toBe("cancelled");
      expect(outcome(cancel.id).state).toBe("pending");
      expect(script.edits().at(-1)).toBe(`${cancel.preview.text}\n\n${NO_PHONE_LINK}`);
      expect(urlButtons(lastEdit())).toEqual([]);
    });

    test("previews never carry paths, secrets or digests a person typed into a title or a note", () => {
      task("p", `see /Users/private/notes and token sk-${"X".repeat(40)}`);
      const steer = card("steer", { task: "p", taskTitle: `see /Users/private/notes and token sk-${"X".repeat(40)}`, note: `look in C:\\Users\\me and ${"d".repeat(64)}` });
      expect(steer.preview.text).not.toMatch(/\/Users|C:\\|X{40}|d{64}/);
    });
  });

  describe("secure phone handoffs: one url button to the exact existing control, minted from the trusted origin at send time", () => {
    test("handoff cards link the exact control or task page; the link is navigation only, and a forged tap still changes nothing", async () => {
      origin = "https://console.example";
      task("z");
      answers.push(
        { text: "Pointing you at it.", calls: [{ id: "c1", name: "show_control", args: { control: "publish", task: "z" } }, { id: "c2", name: "propose_cancel", args: { task: "z", reason: "no longer needed" } }] },
        { text: "Two cards: the publication control and the cancel step." },
      );
      script.updates.push([textUpdate(2, "publish z, or cancel it")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, problems: [] } });
      const cards = script.sends().filter(call => call.params["reply_markup"] !== undefined);
      expect(cards).toHaveLength(2);
      expect(cards.map(one => urlButtons(one))).toEqual([
        [["Review publication", "https://console.example/t/z"]],
        [["Cancel task", "https://console.example/t/z"]],
      ]);
      // Navigation, never authority: no callback token was minted for a handoff card, and its text says the step finishes in the console once.
      expect(cards.every(one => (one.params["reply_markup"] as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat().every(button => button.callback_data === undefined))).toBe(true);
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_action WHERE provider = 'telegram' AND proposal IS NOT NULL").get()!["n"]).toBe(0);
      for (const one of cards) {
        expect(String(one.params["text"])).toContain("This step finishes in Toolroll.");
        expect(String(one.params["text"])).not.toContain("No phone link");
      }
      // A forged tap (a callback that names no token) on the linked card: acknowledged, nothing done, the card repainted with its current link.
      const pending = store.listMateProposals(store.liveMateThreadFor("alex")!.id, ["pending"]);
      const forged = mintCardTokens(store, binding(), pending.find(one => one.kind === "cancel")!.id, now, String(cards[1]!.messageId));
      const forgedPass = await tapPass(forged.tokens[0]!, cards[1]!.messageId as number);
      expect(forgedPass).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(forgedPass.report.chatConfirmed).toBeUndefined();
      expect(store.getTask("z")?.state).toBe("queued");
      expect(urlButtons(lastEdit())).toEqual([["Cancel task", "https://console.example/t/z"]]);
      expect(requests).toHaveLength(2);
    });

    test("a card planned under one setting is sent under the CURRENT one: a lost send retried after the address was removed carries no link and says so, with no model call", async () => {
      origin = "https://console.example";
      task("z");
      answers.push(
        { text: "Pointing you at it.", calls: [{ id: "c1", name: "show_control", args: { control: "publish", task: "z" } }] },
        { text: "Open the publication control." },
      );
      // The reply goes out; the card's send loses its answer.
      script.fault = (params, attempt) => attempt === 1 && params["reply_markup"] !== undefined ? "throw" : null;
      script.updates.push([textUpdate(2, "publish z")]);
      const lost = await pass();
      expect(lost).toMatchObject({ ok: true, report: { chatQueued: 1 } });
      expect(lost.report.chatAnswered ?? 0).toBe(0);
      expect(script.attempts().filter(call => call.method === "sendMessage:failed")).toHaveLength(1);
      expect(urlButtons(script.attempts().at(-1))).toEqual([["Review publication", "https://console.example/t/z"]]);
      const before = requests.length;
      // The setting goes away before the retry: the persisted card carries no url (none was stored) and the resend says why.
      origin = null;
      script.fault = null;
      now = new Date(now.getTime() + PART_RETRY_MS[0] + 1);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      const resent = script.sends().at(-1)!;
      expect(resent.params["reply_markup"]).toBeUndefined();
      expect(String(resent.params["text"])).toContain(NO_PHONE_LINK);
      expect(requests).toHaveLength(before);
      expect(store.listTelegramConversationParts(store.listTelegramConversations(BOT)[0]!.id).map(one => [one.kind, one.state, one.keyboard])).toEqual([["reply", "sent", null], ["card", "sent", null]]);
      // Restored: the next card links again.
      origin = "https://console.example";
      answers.push({ text: "Again.", calls: [{ id: "c2", name: "show_control", args: { control: "settings" } }] }, { text: "Settings." });
      script.updates.push([textUpdate(3, "open settings")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
      expect(urlButtons(script.sends().at(-1))).toEqual([["Open settings", "https://console.example/settings"]]);
    });

    test("a stale or foreign identity gets no link even under a trusted origin, and the card says that rather than blaming setup", async () => {
      origin = "https://console.example";
      const foreign = join(dir, "elsewhere");
      mkdirSync(foreign);
      store.createTask({ id: "far", title: "far away" }, now);
      store.placeTask(store.refFor("built-in", "far").id, foreign);
      const away = card("control", { control: "publish", task: "far", taskTitle: "far away" });
      expect(await tapPass(away.confirm, away.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(urlButtons(lastEdit())).toEqual([]);
      expect(script.edits().at(-1)).toContain(NO_TASK_LINK);
      const gone = card("control", { control: "publish", task: "vanished", taskTitle: "vanished" });
      expect(await tapPass(gone.confirm, gone.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(urlButtons(lastEdit())).toEqual([]);
      expect(script.edits().at(-1)).toContain(NO_TASK_LINK);
      // Access revoked between the card and the tap: silence, no repaint, no link.
      const later = card("control", { control: "publish", task: "far", taskTitle: "far away" });
      store.unpairTelegram(BOT, "alex", now);
      expect(await tapPass(later.confirm, later.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(script.calls.filter(call => call.method === "editMessageText")).toHaveLength(2);
    });

    test("a filed task links Review & start while its scope waits, and a duplicate tap neither files nor links twice; `/task` follows the recorded state", async () => {
      origin = "https://console.example";
      answers.push(
        { text: "", calls: [{ id: "g0", name: "get_capabilities", args: { repo: "r1" } }] },
        { text: "Drafting.", calls: [{ id: "c1", name: "propose_task", args: { repo: "r1", title: "Tighten the payout guard", goal: "Refuse a payout over the limit.", acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", evidence: ["manual-review"] }] } }] },
        { text: "Confirm it to file it." },
      );
      script.updates.push([textUpdate(2, "file the payout guard task")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1 } });
      const sent = script.card();
      // A confirmable card keeps its two callback buttons alone.
      expect(sent.rows.flat().map(one => one.text)).toEqual(["Confirm", "Dismiss"]);
      expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      const filed = (store.listMateProposals(store.liveMateThreadFor("alex")!.id)[0]!.outcome as { taskId: string }).taskId;
      expect(script.edits().at(-1)).toBe(`✓ filed ${filed} — review and approve its scope to start work`);
      expect(urlButtons(lastEdit())).toEqual([["Review & start", `https://console.example/chat?task=${encodeURIComponent(filed)}#task-chat-action`]]);
      const modelCalls = requests.length;
      expect(await tapPass(sent.button(/^Confirm$/), sent.messageId)).toMatchObject({ ok: true, report: { ignored: 1 } });
      expect(store.taskFamilyOf(filed, [repo], false)?.versions).toHaveLength(1);
      expect(requests).toHaveLength(modelCalls);
      // /task before and after approval: the button names the recorded next step, never a stale one.
      script.updates.push([textUpdate(nextUpdate++, `/task ${filed}`)]);
      expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
      expect(urlButtons(script.sends().at(-1))).toEqual([["Review & start", `https://console.example/chat?task=${encodeURIComponent(filed)}#task-chat-action`]]);
      const scope = store.getScope(filed)!;
      expect(approve(store, filed, "alex", now, scope.digest, token).ok).toBe(true);
      script.updates.push([textUpdate(nextUpdate++, `/task ${filed}`)]);
      expect(await pass()).toMatchObject({ ok: true, report: { statusReplies: 1 } });
      expect(urlButtons(script.sends().at(-1))).toEqual([["Open task", `https://console.example/chat?task=${encodeURIComponent(filed)}`]]);
    });
  });

  describe("result screenshots on demand: the same saved evidence, sent as files", () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(150, 3)]);
    /** One saved screenshot record of a result, exactly as the builder stores a verified capture (or a flawed one). */
    const shot = (run: number, name: string, bytes: Buffer, record: { captureStatus?: "ok" | "failed"; truncated?: boolean; redacted?: boolean; bytesStored?: number } = {}) => {
      writeFileSync(join(evidenceRoot, String(run), name), bytes);
      return store.saveArtifact({
        run, kind: "screenshot", key: `${run}/${name}`, bytesOriginal: bytes.length, bytesStored: record.bytesStored ?? bytes.length, truncated: record.truncated ?? false,
        sha256: createHash("sha256").update(bytes).digest("hex"), capture: "agent-claimed screenshot (validated)",
        ...(record.redacted === undefined ? {} : { redacted: record.redacted }), ...(record.captureStatus === undefined ? {} : { captureStatus: record.captureStatus }),
      }, now);
    };
    const row = () => store.listTelegramConversations(BOT).at(-1)!;
    const parts = () => store.listTelegramConversationParts(row().id);
    const turns = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()?.["n"]);
    const later = (ms: number) => { now = new Date(now.getTime() + ms); };
    /** The most recent result the model saw from one tool, across every harness request so far. */
    const toolResult = (name: string): unknown => {
      for (let index = requests.length - 1; index >= 0; index--) {
        const found = [...requests[index]!.history].reverse().find(one => one.role === "tool" && one.name === name);
        if (found !== undefined) return JSON.parse((found as { result: string }).result);
      }
      throw new Error(`no ${name} result was shown to the model`);
    };
    const askForImages = (run: number | undefined, reply: string, extra: Record<string, unknown> = {}) => {
      answers.push(
        { text: "Selecting the screenshots.", calls: [{ id: "i1", name: "get_result_images", args: { task: "payout", ...(run === undefined ? {} : { run }) } }] },
        { text: reply },
      );
      script.updates.push([textUpdate(nextUpdate++, "Show me the screenshots from that result.", extra)]);
    };

    test("an acceptance evidence request sends the exact result's screenshots and one secure acceptance link without accepting", async () => {
      origin = "https://console.example";
      const { run } = seedSource("payout");
      shot(run, "phone.png", PNG);
      shot(run, "desktop.jpg", JPEG);
      const detail = 'criterion "c1" requires manual-review evidence — an operator must accept it before this can verify';
      store.saveProofVerdict(run, "short", [detail], now, [{ id: "c1", statement: "Inspect the phone layout", requiredEvidence: ["manual-review"], state: "manual-review", detail: [detail], answered: [{ kind: "manual-review", ref: "Inspect the saved captures" }], review: { judgement: "upholds", note: "Both viewports match", author: "reviewer:claude" } }]);
      answers.push(
        { text: "Reading the acceptance evidence.", calls: [{ id: "a1", name: "get_acceptance_evidence", args: { task: "payout", run } }] },
        { text: "Attaching the captures.", calls: [{ id: "a2", name: "get_result_images", args: { task: "payout", run } }, { id: "a3", name: "show_control", args: { control: "acceptance", task: "payout", run } }] },
        { text: "The layout needs your review. The reviewer upheld it. Two saved screenshots follow. Open Review for acceptance to inspect the full terms and record your decision." },
      );
      script.updates.push([textUpdate(nextUpdate++, "Send the evidence for acceptance")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(toolResult("get_acceptance_evidence")).toMatchObject({ status: "You check the remaining requirements", run, accepted: false, criteria: [{ requirement: "Inspect the phone layout", reviewer: { judgement: "upholds" } }] });
      expect(script.documents()).toHaveLength(2);
      expect(urlButtons(script.sends().at(-1))).toEqual([["Inspect result", `https://console.example/review?result=payout&run=${run}&tab=checks`]]);
      expect(store.proofAcceptance(run)).toBeNull();
      expect(store.getTask("payout")?.state).toBe("done");
    });

    test("asked for a result's screenshots: the shared tool selects that exact result's verified images, Telegram sends each original as a document after the reply, a reply to an image revises that exact run, and a newer revision is said, never switched to", async () => {
      origin = "https://console.example";
      const { run } = seedSource("payout");
      const first = shot(run, "screenshot-home.png", PNG);
      const second = shot(run, "screenshot-form.jpg", JPEG);
      askForImages(run, `Two screenshots from result #${run} of payout follow.`);
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, problems: [] } });
      // What the model was told: identity and count, and that the files FOLLOW — nothing was delivered when it answered.
      expect(toolResult("get_result_images")).toMatchObject({ task: "payout", root: "payout", currentExecution: "payout", isCurrent: true, run, imageCount: 2, unavailable: [], report: false, delivery: "2 image file(s) will be sent to this chat after your reply. Say they follow; do not say they were delivered." });
      // Durable before any send, typed: the reply, then one image part per screenshot by identity — never bytes, never a path.
      expect(parts().map(one => [one.kind, one.state, one.text, one.taskId, one.run, one.artifact, one.sha256])).toEqual([
        ["reply", "sent", `Two screenshots from result #${run} of payout follow.`, null, null, null, null],
        ["image", "sent", `payout · result #${run} · screenshot 1 of 2`, "payout", run, first, createHash("sha256").update(PNG).digest("hex")],
        ["image", "sent", `payout · result #${run} · screenshot 2 of 2`, "payout", run, second, createHash("sha256").update(JPEG).digest("hex")],
      ]);
      // The wire: the reply as text, then one multipart document per image — the original bytes, a name from identity, the sniffed type, the short caption.
      expect(script.texts()).toEqual([`Two screenshots from result #${run} of payout follow.`]);
      const documents = script.documents();
      expect(documents.map(one => [one.params["chat_id"], one.params["caption"], one.upload?.field, one.upload?.fileName, one.upload?.contentType])).toEqual([
        [String(CHAT), `payout · result #${run} · screenshot 1 of 2`, "document", `payout-result-${run}-${first}.png`, "image/png"],
        [String(CHAT), `payout · result #${run} · screenshot 2 of 2`, "document", `payout-result-${run}-${second}.jpg`, "image/jpeg"],
      ]);
      expect(documents[0]!.upload!.bytes.equals(PNG)).toBe(true);
      expect(documents[1]!.upload!.bytes.equals(JPEG)).toBe(true);
      for (const call of documents) expect(JSON.stringify(call.params)).not.toMatch(/\/pool|evidence|orders\.db|[0-9a-f]{32}|Guard the payout/);
      expect(row()).toMatchObject({ state: "done", outcome: "answered", replyMessageId: "100" });
      expect(requests).toHaveLength(2);
      expect(turns()).toBe(1);
      // Each confirmed image binds to the exact task and run — the same routing an outbox result message carries.
      const imageMessage = documents[0]!.messageId as number;
      expect(store.telegramMessageBindings(binding(), String(imageMessage))).toEqual([{ taskId: "payout", taskRef: store.lookupRef("payout")!.id, run, project: repo }]);
      // Replying to the image: the turn is pinned to that result, and the existing revise flow creates the same-family revision, audited as telegram.
      answers.push(
        { text: "Reading the result.", calls: [{ id: "r1", name: "get_result", args: { task: "payout", run } }] },
        { text: "Proposing the change.", calls: [{ id: "r2", name: "propose_review", args: { run, operation: "revise", note: "Fix the spacing on the form." } }] },
        { text: "I proposed a revision of payout with your feedback. Confirm it to create the revision." },
      );
      script.updates.push([textUpdate(nextUpdate++, "Fix the spacing on the form.", { reply_to_message: { message_id: imageMessage } })]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatAnswered: 1, problems: [] } });
      expect(row()).toMatchObject({ replyTo: String(imageMessage), taskId: "payout", sourceRun: run, state: "done" });
      expect((requests[2]!.history.filter(one => one.role === "operator").at(-1) as { text: string }).text).toContain(`replying to result #${run} from execution payout`);
      const card = script.card();
      expect(card.text).toContain(`Request changes to result #${run} of Guard the payout path (payout)`);
      expect(card.text).toContain("| Fix the spacing on the form.");
      expect(await tapPass(card.button(/^Confirm$/), card.messageId)).toMatchObject({ ok: true, report: { chatConfirmed: 1 } });
      const proposal = store.listMateProposals(store.liveMateThreadFor("alex")!.id, ["confirmed"])[0]!;
      expect(proposal).toMatchObject({ kind: "review", state: "confirmed" });
      expect(proposal.outcome).toMatchObject({ ok: true, via: "telegram" });
      const child = (proposal.outcome as { taskId: string }).taskId;
      expect(store.taskFamilyOf("payout", [repo], false)!.versions.map(one => one.id)).toEqual(["payout", child]);
      expect(store.revisionSourceOf(store.lookupRef(child)!.id)).toMatchObject({ sourceRun: run, sourceTask: "payout" });
      expect(store.allDiffComments(run).map(one => [one.author, one.note, one.consumedBy])).toEqual([["alex", "Fix the spacing on the form.", child]]);
      expect(store.getScope(child)?.approvedDigest ?? null).toBeNull();
      // Planned first: the card opens the revision; there is nothing to approve until the plan is updated.
      expect(urlButtons(lastEdit())).toEqual([["Open task", `https://console.example/chat?task=${encodeURIComponent(child)}`]]);
      // The image message keeps its identity after the revision. Asked again with no run, the newer revision is said and nothing is switched; nothing is sent.
      askForImages(undefined, "A newer revision of payout is current. Which result do you want: this version or the newer one?", { reply_to_message: { message_id: imageMessage } });
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(toolResult("get_result_images")).toEqual({ ok: false, message: "A newer revision of this task is current. Say which result you mean before images are selected: this version or the newer one." });
      expect(script.documents()).toHaveLength(2);
      // By exact run the older result still travels, captioned as the older version; a revise against it is refused by the existing stale-result rule, and no second revision exists.
      askForImages(run, "Two screenshots from the older result follow.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(toolResult("get_result_images")).toMatchObject({ run, currentExecution: child, isCurrent: false, imageCount: 2 });
      expect(script.documents().slice(2).map(one => one.params["caption"])).toEqual([`payout · result #${run} · screenshot 1 of 2 · older version`, `payout · result #${run} · screenshot 2 of 2 · older version`]);
      const older = script.documents()[2]!.messageId as number;
      expect(store.telegramMessageBindings(binding(), String(older))).toEqual([{ taskId: "payout", taskRef: store.lookupRef("payout")!.id, run, project: repo }]);
      answers.push(
        { text: "Reading.", calls: [{ id: "r3", name: "get_result", args: { task: "payout", run } }] },
        { text: "Trying.", calls: [{ id: "r4", name: "propose_review", args: { run, operation: "revise", note: "Also tighten the header." } }] },
        { text: "A newer revision of payout is current. Review that version before requesting changes." },
      );
      script.updates.push([textUpdate(nextUpdate++, "Also tighten the header.", { reply_to_message: { message_id: older } })]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(toolResult("propose_review")).toEqual({ ok: false, message: "A newer revision is current. Read that version before requesting changes." });
      expect(store.taskFamilyOf("payout", [repo], false)!.versions).toHaveLength(2);
      expect(store.listMateProposals(store.liveMateThreadFor("alex")!.id, ["pending"])).toEqual([]);
      // Ordinary history, as the console and CLI read it: the operator's asks and the assistant's words, and never an image described that was not selected.
      expect(store.listMateMessages(store.liveMateThreadFor("alex")!.id, 20).filter(one => one.role === "assistant").map(one => one.text)).toEqual([
        `Two screenshots from result #${run} of payout follow.`,
        "I proposed a revision of payout with your feedback. Confirm it to create the revision.",
        "A newer revision of payout is current. Which result do you want: this version or the newer one?",
        "Two screenshots from the older result follow.",
        "A newer revision of payout is current. Review that version before requesting changes.",
      ]);
    });

    test("a lost answer on a document: the confirmed reply is not resent, the image resumes from its typed identity after a restart with no model call, and its bytes are read and verified again — a file changed meanwhile is refused visibly with the exact result to open, never sent", async () => {
      origin = "https://console.example";
      const { run } = seedSource("payout");
      shot(run, "screenshot-home.png", PNG);
      shot(run, "screenshot-form.jpg", JPEG);
      script.fault = params => params["caption"] === undefined ? null : "throw";
      askForImages(run, "Two screenshots follow.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, problems: [expect.stringContaining("is waiting to be sent: Telegram transport failed; delivery may be uncertain")] } });
      expect(parts().map(one => [one.kind, one.state, one.attempts, one.uncertain])).toEqual([["reply", "sent", 1, 0], ["image", "pending", 1, 1], ["image", "pending", 0, 0]]);
      expect(row()).toMatchObject({ state: "queued", outcome: "delivering", replyMessageId: "100" });
      expect(script.documents()).toHaveLength(0);
      // The first file changes on disk while the part waits. Restart, retry: the bytes are read again and refused; the second image goes out untouched.
      writeFileSync(join(evidenceRoot, String(run), "screenshot-home.png"), Buffer.concat([PNG, Buffer.from([1])]));
      script.fault = null;
      store.close(); store = openStore(file);
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [expect.stringContaining("was not sent: the saved file is missing or changed")] } });
      expect(parts().map(one => [one.kind, one.state, one.messageId, one.attempts, one.uncertain, one.lastError])).toEqual([
        ["reply", "sent", "100", 1, 0, null],
        ["image", "dropped", null, 1, 1, "the saved file is missing or changed"],
        ["image", "sent", "102", 1, 0, null],
      ]);
      expect(script.texts()).toEqual(["Two screenshots follow.", `payout · result #${run} · screenshot 1 of 2 was not sent: the saved file is missing or changed. Open the result to view it.`]);
      expect(urlButtons(script.sends().at(-1))).toEqual([["Open result", `https://console.example/chat?task=payout&result=${run}`]]);
      expect(script.documents()).toHaveLength(1);
      expect(script.documents()[0]!.upload!.bytes.equals(JPEG)).toBe(true);
      expect(row()).toMatchObject({ state: "done", outcome: "replayed" });
      expect(requests).toHaveLength(2);
      expect(turns()).toBe(1);
      // The dropped image never binds a reply; the sent one does.
      expect(store.telegramMessageBindings(binding(), "101")).toEqual([]);
      expect(store.telegramMessageBindings(binding(), "102")).toEqual([{ taskId: "payout", taskRef: store.lookupRef("payout")!.id, run, project: repo }]);
    });

    test("Telegram's own refusal of a document is definite and retried on the existing schedule, retry_after pauses the bot, and an acknowledgement without a message id stays pending and uncertain — with no model call anywhere", async () => {
      const { run } = seedSource("payout");
      shot(run, "screenshot-home.png", PNG);
      shot(run, "screenshot-form.jpg", JPEG);
      let attempt = 0;
      script.fault = params => params["caption"] === undefined ? null
        : ++attempt === 1 ? { ok: false, description: "Bad Request: file is too big" }
        : attempt === 2 ? { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } }
        : attempt === 3 ? "no-id" : null;
      askForImages(run, "Two screenshots follow.");
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("is waiting to be sent: Bad Request: file is too big")] } });
      expect(parts()[1]).toMatchObject({ kind: "image", state: "pending", attempts: 1, uncertain: 0, lastError: "Bad Request: file is too big", nextAttemptAt: new Date(now.getTime() + PART_RETRY_MS[0]).toISOString() });
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("Too Many Requests (retry after 7s)")] } });
      expect(store.telegramRetryAt(BOT)).toBe(new Date(now.getTime() + 7_000).toISOString());
      expect(parts()[1]).toMatchObject({ state: "pending", attempts: 2, uncertain: 0 });
      later(PART_RETRY_MS[1]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("Telegram returned no confirmed message identity")] } });
      expect(parts()[1]).toMatchObject({ state: "pending", attempts: 3, uncertain: 1, messageId: null });
      later(PART_RETRY_MS[2]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(parts().map(one => [one.kind, one.state, one.attempts, one.uncertain])).toEqual([["reply", "sent", 1, 0], ["image", "sent", 4, 1], ["image", "sent", 1, 0]]);
      expect(script.documents()).toHaveLength(2);
      expect(script.texts()).toEqual(["Two screenshots follow."]);
      expect(requests).toHaveLength(2);
      expect(turns()).toBe(1);
    });

    test("access revoked while an image waits: the registry is read again after the await and nothing is uploaded under a changed ceiling; a result moved out of the phone's projects is refused at the upload itself", async () => {
      const { run } = seedSource("payout");
      shot(run, "screenshot-home.png", PNG);
      script.fault = params => params["caption"] === undefined ? null : "throw";
      askForImages(run, "One screenshot follows.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
      expect(parts().map(one => [one.kind, one.state])).toEqual([["reply", "sent"], ["image", "pending"]]);
      script.fault = null;
      projects = [];
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatRefused: 1, problems: [expect.stringContaining("was not sent: the connected projects changed")] } });
      expect(script.documents()).toHaveLength(0);
      expect(parts()[1]).toMatchObject({ kind: "image", state: "pending", messageId: null });
      expect(row()).toMatchObject({ state: "failed", outcome: "unsent:the connected projects changed" });
      expect(script.texts().at(-1)).toMatch(/^The connected projects changed, so the assistant's reply was not sent\. Nothing was changed\./);
      // The ceiling unchanged, the task's recorded project changed under it between the plan and the upload (the door refuses to move a scoped task, so the row is moved directly): the per-image proof refuses it in words, with no link to a project this phone cannot reach.
      projects = [repo];
      script.fault = params => params["caption"] === undefined ? null : "throw";
      askForImages(run, "One screenshot follows.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
      const elsewhere = join(dir, "elsewhere"); mkdirSync(elsewhere);
      expect(store.placeTask(store.lookupRef("payout")!.id, elsewhere)).toEqual({ ok: false, reason: "scoped" });
      store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(elsewhere, store.lookupRef("payout")!.id);
      script.fault = null;
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [expect.stringContaining("was not sent: the result is outside your connected projects now")] } });
      expect(script.documents()).toHaveLength(0);
      expect(parts()[1]).toMatchObject({ kind: "image", state: "dropped", lastError: "the result is outside your connected projects now" });
      expect(script.texts().at(-1)).toBe(`payout · result #${run} · screenshot 1 of 1 was not sent: the result is outside your connected projects now. Open the result to view it.`);
      expect(urlButtons(script.sends().at(-1))).toEqual([]);
      expect(script.texts().at(-1)).not.toContain("elsewhere");
    });

    test("a turn that selected images and then failed sends nothing: its selection is deleted with its drafts; unusable records are named to the model and never travel", async () => {
      const { run } = seedSource("payout");
      const good = shot(run, "screenshot-home.png", PNG);
      const failed = shot(run, "screenshot-failed.png", PNG, { captureStatus: "failed" });
      const shortened = shot(run, "screenshot-cut.png", PNG, { truncated: true });
      const redacted = shot(run, "screenshot-redacted.png", PNG, { redacted: true });
      const oversized = shot(run, "screenshot-huge.png", PNG, { bytesStored: 5 * 1024 * 1024 + 1 });
      const wrongKind = shot(run, "screenshot-text.png", Buffer.from("just words", "utf8"));
      answers.push(
        { text: "Selecting.", calls: [{ id: "i1", name: "get_result_images", args: { task: "payout", run } }] },
        { text: "", before: () => { throw new Error("harness died"); } },
      );
      script.updates.push([textUpdate(nextUpdate++, "Show me the screenshots from that result.")]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, chatRefused: 1 } });
      expect(row()).toMatchObject({ state: "failed", outcome: "failed:provider-error" });
      expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn_evidence").get()?.["n"])).toBe(0);
      expect(parts()).toEqual([]);
      expect(script.documents()).toHaveLength(0);
      expect(script.texts().at(-1)).toBe(MATE_FAILURE_COPY.signIn);
      // The same ask, answered: the model is told which records cannot travel and why; only the verified image is sent.
      askForImages(run, "One screenshot follows; five saved captures could not be verified.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(toolResult("get_result_images")).toMatchObject({
        imageCount: 1, images: [{ id: good, format: "png", caption: `payout · result #${run} · screenshot 1 of 1` }],
        unavailable: [
          { id: failed, problem: "the capture failed" }, { id: shortened, problem: "the saved file was shortened" }, { id: redacted, problem: "sensitive text was hidden from the saved file" },
          { id: oversized, problem: "the saved file is too large to send" }, { id: wrongKind, problem: "the saved file is not a PNG or JPEG" },
        ],
        delivery: "1 image file(s) will be sent to this chat after your reply. Say they follow; do not say they were delivered.",
      });
      expect(script.documents().map(one => [one.params["caption"], one.upload?.fileName])).toEqual([[`payout · result #${run} · screenshot 1 of 1`, `payout-result-${run}-${good}.png`]]);
      expect(parts().map(one => [one.kind, one.state])).toEqual([["reply", "sent"], ["image", "sent"]]);
      expect(turns()).toBe(2);
    });

    test("a refused image's notice is durable: it rides the image's own pending part, a failed or lost notice is retried after a restart with no model call and no confirmed part resent, the row is not done until Telegram confirms it, and the part is dropped only then (review 509)", async () => {
      origin = "https://console.example";
      const { run } = seedSource("payout");
      shot(run, "screenshot-home.png", PNG);
      script.fault = params => params["caption"] === undefined ? null : "throw";
      askForImages(run, "One screenshot follows.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1, problems: [expect.stringContaining("is waiting to be sent: Telegram transport failed; delivery may be uncertain")] } });
      expect(parts().map(one => [one.kind, one.state, one.attempts, one.uncertain])).toEqual([["reply", "sent", 1, 0], ["image", "pending", 1, 1]]);
      // The file changes on disk; the retry refuses it, and Telegram refuses the notice: the part stays pending with the notice's error, the row stays queued — nothing is done.
      writeFileSync(join(evidenceRoot, String(run), "screenshot-home.png"), Buffer.concat([PNG, Buffer.from([1])]));
      store.close(); store = openStore(file);
      script.fault = params => String(params["text"] ?? "").includes("was not sent") ? { ok: false, description: "temporary network failure" } : null;
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [
        expect.stringContaining("was not sent: the saved file is missing or changed"),
        expect.stringContaining("is waiting to be sent: temporary network failure"),
      ] } });
      expect(parts()[1]).toMatchObject({ kind: "image", state: "pending", messageId: null, attempts: 2, uncertain: 1, lastError: "temporary network failure", nextAttemptAt: new Date(now.getTime() + PART_RETRY_MS[1]).toISOString() });
      expect(row()).toMatchObject({ state: "queued", outcome: "delivering" });
      expect(script.documents()).toHaveLength(0);
      expect(script.texts()).toEqual(["One screenshot follows."]);
      // A lost answer on the notice: uncertain, retried — the notice may have arrived, and the row says so instead of claiming otherwise.
      script.fault = params => String(params["text"] ?? "").includes("was not sent") ? "throw" : null;
      later(PART_RETRY_MS[1]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("was not sent: the saved file is missing or changed"), expect.stringContaining("is waiting to be sent: Telegram transport failed; delivery may be uncertain")] } });
      expect(parts()[1]).toMatchObject({ state: "pending", attempts: 3, uncertain: 2 });
      expect(row()).toMatchObject({ state: "queued", outcome: "delivering" });
      // Restart with a healthy transport: the image is verified again (still wrong), the notice goes out with the exact result to open, and only now is the part dropped and the row done. The reply was never resent; the model was never called again.
      store.close(); store = openStore(file);
      script.fault = null;
      later(PART_RETRY_MS[2]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [expect.stringContaining("was not sent: the saved file is missing or changed")] } });
      expect(parts().map(one => [one.kind, one.state, one.messageId, one.attempts, one.uncertain, one.lastError])).toEqual([
        ["reply", "sent", "100", 1, 0, null],
        ["image", "dropped", null, 3, 2, "the saved file is missing or changed"],
      ]);
      expect(script.texts()).toEqual(["One screenshot follows.", `payout · result #${run} · screenshot 1 of 1 was not sent: the saved file is missing or changed. Open the result to view it.`]);
      expect(script.sends().at(-1)!.params["reply_parameters"]).toEqual({ message_id: Number(row().messageId) });
      expect(urlButtons(script.sends().at(-1))).toEqual([["Open result", `https://console.example/chat?task=payout&result=${run}`]]);
      expect(script.documents()).toHaveLength(0);
      expect(row()).toMatchObject({ state: "done", outcome: "replayed" });
      expect(requests).toHaveLength(2);
      expect(turns()).toBe(1);
      // A notice is not an image message: replying to it binds nothing.
      expect(store.telegramMessageBindings(binding(), String(script.sends().at(-1)!.messageId))).toEqual([]);
      // A file repaired before the notice is confirmed is sent after all: verified again on that attempt, never the invalid bytes.
      shot(run, "screenshot-form.jpg", JPEG);
      script.fault = params => params["caption"] === undefined ? null : "throw";
      askForImages(run, "Two screenshots follow.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
      writeFileSync(join(evidenceRoot, String(run), "screenshot-form.jpg"), Buffer.concat([JPEG, Buffer.from([1])]));
      script.fault = params => String(params["text"] ?? "").includes("was not sent") ? { ok: false, description: "temporary network failure" } : null;
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { problems: [expect.stringContaining("was not sent: the saved file is missing or changed"), expect.stringContaining("is waiting to be sent: temporary network failure")] } });
      expect(row()).toMatchObject({ state: "queued", outcome: "delivering" });
      expect(parts().map(one => [one.kind, one.state, one.lastError])).toEqual([["reply", "sent", null], ["image", "pending", "temporary network failure"]]);
      writeFileSync(join(evidenceRoot, String(run), "screenshot-form.jpg"), JPEG);
      script.fault = null;
      later(PART_RETRY_MS[1]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [] } });
      expect(parts().map(one => [one.kind, one.state, one.lastError])).toEqual([["reply", "sent", null], ["image", "sent", null]]);
      expect(script.documents()).toHaveLength(1);
      expect(script.documents()[0]!.upload!.bytes.equals(JPEG)).toBe(true);
      expect(turns()).toBe(2);
    });

    test("a credential-shaped caption never reaches Telegram: a persisted caption is checked again before every send and retry and rebuilt from the part's typed identity, for the document and for a refusal notice alike, while the part, the bindings and the link keep the exact identity (review 507)", async () => {
      origin = "https://console.example";
      const { run } = seedSource("payout");
      shot(run, "screenshot-home.png", PNG);
      const second = shot(run, "screenshot-form.jpg", JPEG);
      // The shape of an AWS access key. A live turn never plans such a caption (the selection labels a credential-shaped id opaquely, and the engine refuses a context that carries one), so the road here is the persisted row: planned before this rule, or edited by hand.
      const tokenShaped = "AKIAABCDEFGHIJKLMNOP";
      expect(resultTaskLabel(tokenShaped)).toMatch(/^task-[0-9a-f]{12}$/);
      script.fault = params => params["caption"] === undefined ? null : "throw";
      askForImages(run, "Two screenshots follow.");
      expect(await pass()).toMatchObject({ ok: true, report: { chatQueued: 1 } });
      expect(parts().map(one => [one.kind, one.state, one.text])).toEqual([
        ["reply", "sent", "Two screenshots follow."],
        ["image", "pending", `payout · result #${run} · screenshot 1 of 2`],
        ["image", "pending", `payout · result #${run} · screenshot 2 of 2`],
      ]);
      const caption = store.handle.prepare("UPDATE chat_part SET payload = json_set(payload, '$.text', ?) WHERE provider = 'telegram' AND event = ? AND ordinal = ?");
      caption.run(`${tokenShaped} · result #${run} · screenshot 1 of 2`, `m${row().id}`, 1);
      caption.run(`${tokenShaped} · result #${run} · screenshot 2 of 2`, `m${row().id}`, 2);
      // The first file also changes on disk: its refusal notice is rebuilt as well. Restart and retry.
      writeFileSync(join(evidenceRoot, String(run), "screenshot-home.png"), Buffer.concat([PNG, Buffer.from([1])]));
      store.close(); store = openStore(file);
      script.fault = null;
      later(PART_RETRY_MS[0]);
      expect(await pass()).toMatchObject({ ok: true, report: { chatAnswered: 1, problems: [expect.stringContaining("was not sent: the saved file is missing or changed")] } });
      expect(script.texts().at(-1)).toBe(`payout · result #${run} · screenshot was not sent: the saved file is missing or changed. Open the result to view it.`);
      expect(script.documents().map(one => [one.params["caption"], one.upload?.fileName])).toEqual([[`payout · result #${run} · screenshot`, `payout-result-${run}-${second}.jpg`]]);
      for (const call of script.calls) expect(JSON.stringify([call.params, call.upload?.fileName ?? ""])).not.toContain(tokenShaped);
      expect(script.documents()[0]!.upload!.bytes.equals(JPEG)).toBe(true);
      expect(parts().map(one => [one.kind, one.state, one.taskId, one.run])).toEqual([["reply", "sent", null, null], ["image", "dropped", "payout", run], ["image", "sent", "payout", run]]);
      // The exact identity still binds a reply to the image, and the console link still names the exact task.
      expect(store.telegramMessageBindings(binding(), String(script.documents()[0]!.messageId))).toEqual([{ taskId: "payout", taskRef: store.lookupRef("payout")!.id, run, project: repo }]);
      expect(urlButtons(script.sends().at(-1))).toEqual([["Open result", `https://console.example/chat?task=payout&result=${run}`]]);
      expect(requests).toHaveLength(2);
      expect(turns()).toBe(1);
    });
  });

  test("every mate tool has a phone road, and the committed matrix agrees with the code column for column — support, how and remaining gap; every handoff is labelled an incomplete phone action", () => {
    expect(parityGaps()).toEqual([]);
    expect(Object.keys(TELEGRAM_ACTION_PARITY).sort()).toEqual(MATE_TOOL_SCHEMAS.map(tool => tool.name).sort());
    const doc = readFileSync(join(__dirname, "..", "docs", "TELEGRAM_ACTION_PARITY_2026-09-16.md"), "utf8");
    const rows = new Map(doc.split("\n").filter(line => /^\| `[a-z_]+` \|/.test(line)).map(line => {
      const cells = line.split(" | ").map(cell => cell.replace(/^\| |\|$/g, "").trim());
      return [cells[0]!.replace(/`/g, ""), { support: cells[1], how: cells[2], test: cells[3], gap: cells[4] }] as const;
    }));
    expect([...rows.keys()].sort()).toEqual(MATE_TOOL_SCHEMAS.map(tool => tool.name).sort());
    for (const tool of MATE_TOOL_SCHEMAS) {
      const code = TELEGRAM_ACTION_PARITY[tool.name]!;
      const row = rows.get(tool.name)!;
      expect(row, `matrix row for ${tool.name}`).toMatchObject({ support: code.support, how: code.how, gap: code.gap ?? "none" });
      expect(row.test, `test column for ${tool.name}`).not.toBe("");
      // A handoff does nothing on the phone: its row must say so where the reader looks for what is missing.
      if (code.support === "handoff") expect(code.gap, `${tool.name} is a handoff`).toMatch(/incomplete phone action/i);
      if (code.support === "missing") expect(code.gap, `${tool.name} is missing`).not.toBeNull();
    }
    expect(doc).toContain("not a live Telegram");
    expect(doc).toContain("incomplete phone action");
  });

  describe("production wiring", () => {
    const stub = () => {
      vi.stubEnv(TOKEN_ENV, "");
      saveBotToken(join(dir, "telegram-token"), `${BOT}:${"x".repeat(25)}`);
    };
    const operate = (argv: string[], lines: string[]) =>
      runOperate(argv[0]!, argv.slice(1), line => lines.push(line), { databaseFile: file, now, telegramTransport: script.transport, mateSeams: { subscriptionRunner: runner, clock: () => now } });

    test("`bridge telegram` (the cron pass) answers ordinary text through the shared engine and reports it", async () => {
      stub();
      await saveRepos(join(dir, "repos.json"), [repo]);
      store.close();
      answers.push({ text: "Two tasks are queued; nothing waits on you." });
      script.updates.push([textUpdate(2, "how do things stand?")]);
      const lines: string[] = [];
      expect(await operate(["bridge", "telegram", "--inbound-only", "--json"], lines)).toBe(EXIT.ok);
      const report = JSON.parse(lines.join("\n")).report;
      expect(report).toMatchObject({ chatQueued: 1, chatAnswered: 1, problems: [] });
      expect(script.texts()).toEqual(["Two tasks are queued; nothing waits on you."]);
      store = openStore(file);
      expect(store.listTelegramConversations(BOT)[0]).toMatchObject({ state: "done", outcome: "answered" });
      expect(store.activeMateSession("alex")).toMatchObject({ ceilingDigest: ceilingDigestOf([repo]) });
    });

    test("`chat --say` in the terminal names a link to this console as its page, and a foreign one by its host", async () => {
      await saveRepos(join(dir, "repos.json"), [repo]);
      store.close();
      expect(saveConsoleUrl(dir, "https://console.example:8443/")).toMatchObject({ ok: true });
      answers.push({ text: "It's at https://console.example:8443/chat?task=z and the PR is https://github.com/acme/app/pull/9." });
      const lines: string[] = [];
      expect(await operate(["chat", "--as", "alex", "--token", token, "--say", "where is z?"], lines)).toBe(EXIT.ok);
      expect(lines.join("\n")).toContain("It's at the task (https://console.example:8443/chat?task=z) and the PR is github.com (https://github.com/acme/app/pull/9).");
      store = openStore(file);
    });

    test("the pass links handoff cards and `/task` from the console-url setting only when it is an https origin, re-read every time: an http, path-prefixed or removed setting sends no link", async () => {
      stub();
      await saveRepos(join(dir, "repos.json"), [repo]);
      task("z");
      store.close();
      expect(saveConsoleUrl(dir, "https://console.example:8443/")).toMatchObject({ ok: true });
      answers.push({ text: "Pointing.", calls: [{ id: "c1", name: "show_control", args: { control: "publish", task: "z" } }] }, { text: "The publication control." });
      script.updates.push([textUpdate(2, "publish z"), textUpdate(3, "/task z")]);
      const lines: string[] = [];
      expect(await operate(["bridge", "telegram", "--inbound-only", "--json"], lines)).toBe(EXIT.ok);
      expect(urlButtons(script.sends().find(call => String(call.params["text"]).startsWith("Review publication")))).toEqual([["Review publication", "https://console.example:8443/t/z"]]);
      expect(urlButtons(script.sends().find(call => String(call.params["text"]).startsWith("work z")))).toEqual([["Open task", "https://console.example:8443/chat?task=z"]]);
      // The generic setting still accepts http and a path prefix for the mirrors; the phone refuses both, and the environment override is read the same way.
      for (const [setting, env] of [["http://console.example:8443", undefined], ["https://console.example/base", undefined], [undefined, "https://user:pw@console.example"], [undefined, "https://localhost:4180"]] as const) {
        if (setting !== undefined) expect(saveConsoleUrl(dir, setting)).toMatchObject({ ok: true });
        else rmSync(join(dir, "console-url"), { force: true });
        vi.stubEnv(CONSOLE_URL_ENV, env ?? "");
        answers.push({ text: "Again.", calls: [{ id: "c2", name: "show_control", args: { control: "publish", task: "z" } }] }, { text: "Again the control." });
        script.updates.push([textUpdate(10 + script.sends().length, "publish z")]);
        expect(await operate(["bridge", "telegram", "--inbound-only", "--json"], []), `${setting ?? env}`).toBe(EXIT.ok);
        const sent = script.sends().at(-1)!;
        expect(sent.params["reply_markup"], `${setting ?? env}`).toBeUndefined();
        expect(String(sent.params["text"]), `${setting ?? env}`).toContain(NO_PHONE_LINK);
        expect(String(sent.params["text"])).not.toMatch(/localhost|http:/);
      }
      vi.stubEnv(CONSOLE_URL_ENV, "");
      store = openStore(file);
    });

    test("`bridge telegram --follow` answers while it stays on the wire, and a watch's embedded follower does the same for the normal worker", async () => {
      stub();
      await saveRepos(join(dir, "repos.json"), [repo]);
      // The follower: one long-poll actor, the reply arrives without a second invocation.
      answers.push({ text: "Nothing is waiting on you." });
      script.updates.push([textUpdate(2, "anything waiting?")]);
      const controller = new AbortController();
      const report = await followBridge(store, {
        botId: BOT, transport: script.transport, signal: controller.signal, clock: () => new Date(), deliver: false,
        readProjects, conversation: { evidenceRoot, subscriptionRunner: runner },
        onCycle: cycle => { if ((cycle.chatAnswered ?? 0) > 0) controller.abort(); },
        sleep: async () => {},
      });
      expect(report).toMatchObject({ chatQueued: 1, chatAnswered: 1 });
      expect(script.texts()).toEqual(["Nothing is waiting on you."]);
      // The watch (what `up` runs per project): its embedded follower carries the conversation too, and its
      // phone links must name the console this process co-hosts — the stated --public-url — or not exist.
      await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await exec("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo });
      const runnerToken = register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: new Date() }).token;
      task("z");
      store.close();
      expect(saveConsoleUrl(dir, "https://console.example")).toMatchObject({ ok: true });
      const watch = async (publicUrl: string, update: number, text: string) => {
        answers.push({ text: "Pointing.", calls: [{ id: `w${update}`, name: "show_control", args: { control: "publish", task: "z" } }] }, { text });
        script.updates.push([textUpdate(update, "publish z")]);
        const lines: string[] = [];
        // The watch stops once this message's conversation is done and its answer and link are sent, not after a
        // fixed window a loaded machine can outrun; --for is only a safety cap.
        const observer = openStore(file);
        const answered = () => {
          const at = script.texts().lastIndexOf(text);
          return at !== -1 && script.sends().length > at + 1 && observer.listTelegramConversations(BOT).filter(one => one.state === "done").length === update - 1;
        };
        const code = await runOperate("watch", ["--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", join(dir, "pool"), "--public-url", publicUrl, "--for", "60000", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000"],
          line => lines.push(line), { databaseFile: file, now: new Date(), telegramTransport: script.transport, mateSeams: { subscriptionRunner: runner }, shouldStop: answered }).finally(() => observer.close());
        expect(code, lines.join("\n")).toBe(EXIT.ok);
        expect(script.texts().at(-2), lines.join("\n")).toBe(text);
        return urlButtons(script.sends().at(-1));
      };
      expect(await watch("https://console.example", 3, "Still nothing waiting.")).toEqual([["Review publication", "https://console.example/t/z"]]);
      expect(await watch("https://elsewhere.example", 4, "Once more.")).toEqual([]);
      expect(String(script.sends().at(-1)!.params["text"])).toContain(NO_PHONE_LINK);
      store = openStore(file);
      expect(store.listTelegramConversations(BOT).map(one => one.state)).toEqual(["done", "done", "done"]);
    });

    test("a reply goes out in the bridge cycle like notifications, never beside the long poll — and a reply that can't go out tells the person (c1, c3)", async () => {
      // Oct 2: the lead's reply failed "fetch failed; delivery may be uncertain" for minutes while notifications from the
      // same process went out. The reply was sent beside the long poll on a connection of its own; notifications go out
      // between polls. The wire here refuses exactly that: any send while a getUpdates is in flight fails like fetch did.
      stub();
      await saveRepos(join(dir, "repos.json"), [repo]);
      await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await exec("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo });
      const runnerToken = register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: new Date() }).token;
      store.close();
      let polling = 0;
      const besidePoll: string[] = [];
      const fenced: TelegramTransport = async (method, params, signal, upload) => {
        if (method === "getUpdates") {
          polling++;
          try {
            const answer = await script.transport(method, params, signal, upload);
            await new Promise(resolve => setTimeout(resolve, 40));
            return answer;
          } finally { polling--; }
        }
        if (method.startsWith("send") && polling > 0) {
          besidePoll.push(String(params["text"]));
          return { ok: false, description: "fetch failed", uncertain: true };
        }
        return script.transport(method, params, signal, upload);
      };
      // The answer is written while a long poll is in flight.
      const duringPoll = async () => { while (polling === 0) await new Promise(resolve => setTimeout(resolve, 2)); };
      answers.push({ text: "Toolroll 0.9.9: lighter tests, shared dependencies, a clear Needs you.", before: duringPoll });
      script.updates.push([textUpdate(2, "what's the latest update of toolroll include")]);
      const lines: string[] = [];
      const observer = openStore(file);
      const done = () => observer.listTelegramConversations(BOT).some(one => one.state === "done" || one.state === "failed");
      const code = await runOperate("watch", ["--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", join(dir, "pool"), "--for", "60000", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000"],
        line => lines.push(line), { databaseFile: file, now: new Date(), telegramTransport: fenced, mateSeams: { subscriptionRunner: runner }, shouldStop: done }).finally(() => observer.close());
      expect(code, lines.join("\n")).toBe(EXIT.ok);
      expect(besidePoll, lines.join("\n")).toEqual([]);
      expect(script.texts()).toEqual(["Toolroll 0.9.9: lighter tests, shared dependencies, a clear Needs you."]);
      store = openStore(file);
      expect(store.listTelegramConversations(BOT)).toEqual([expect.objectContaining({ state: "done", outcome: "answered", replyMessageId: "100" })]);
      expect(lines.join("\n")).toContain("chat replied 1");

      // A reply Telegram will not take: the person hears so once, in plain words, and the reply stays queued to retry.
      store.close();
      script.fault = params => String(params["text"]).startsWith("I couldn't") ? null : { ok: false, description: "Bad Request: message is too long" };
      answers.push({ text: "Here is a long answer." });
      script.updates.push([textUpdate(3, "and the one before?")]);
      const told = () => script.texts().some(text => text.startsWith("I couldn't"));
      expect(await runOperate("watch", ["--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", join(dir, "pool"), "--for", "60000", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000"],
        () => {}, { databaseFile: file, now: new Date(), telegramTransport: fenced, mateSeams: { subscriptionRunner: runner }, shouldStop: told })).toBe(EXIT.ok);
      expect(script.texts().at(-1)).toBe("I couldn't answer that just now: Telegram didn't accept my reply. Ask again, or open the console.");
      store = openStore(file);
      expect(store.listTelegramConversations(BOT).at(-1)).toMatchObject({ state: "queued", outcome: "delivering" });
    });

    test("under up, the service's own follower sends the reply while project watches run; no project loop touches the bot (c1)", async () => {
      // Oct 2: "[bentoportfolio] watch: bridge …" — the reply went out from a project loop's own follower. Now the service
      // runs the one follower; every send happens while the bridge is held by the service, and no project loop logs a bridge line.
      stub();
      const second = join(dir, "second");
      mkdirSync(second);
      for (const one of [repo, second]) {
        await exec("git", ["init", "-q", "-b", "main"], { cwd: one });
        await exec("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: one });
      }
      await saveRepos(join(dir, "repos.json"), [repo, second]);
      writeFileSync(join(dir, "up-login.txt"), `alex ${token}\n`, { mode: 0o600 });
      store.close();
      const observer = openStore(file);
      const holders: string[] = [];
      const traced: TelegramTransport = async (method, params, signal, upload) => {
        if (method.startsWith("send")) holders.push(String(observer.handle.prepare("SELECT owner FROM chat_runtime WHERE provider = 'telegram' AND installation = ?").get(BOT)?.["owner"]));
        return script.transport(method, params, signal, upload);
      };
      answers.push({ text: "Toolroll 0.9.9: lighter tests, shared dependencies, a clear Needs you." });
      script.updates.push([textUpdate(2, "what's the latest update of toolroll include")]);
      const lines: string[] = [];
      const port = 43000 + (process.pid % 2000);
      let ended = false;
      const running = runOperate("up", ["--repo", repo, "--repo", second, "--port", String(port), "--for", "60000"], line => lines.push(line),
        { databaseFile: file, telegramTransport: traced, mateSeams: { subscriptionRunner: runner }, upSeams: { terminal: false, env: {}, openBrowser: () => {} } }).finally(() => { ended = true; });
      try {
        const deadline = Date.now() + 30_000;
        while (!ended && !observer.listTelegramConversations(BOT).some(one => one.state === "done" || one.state === "failed") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      } finally {
        process.emit("SIGINT");
        expect(await running, lines.join("\n")).toBe(EXIT.ok);
        observer.close();
      }
      expect(script.texts(), lines.join("\n")).toEqual(["Toolroll 0.9.9: lighter tests, shared dependencies, a clear Needs you."]);
      expect(holders).toEqual([expect.stringMatching(/^service-/)]);
      expect(lines.join("\n")).toContain("telegram: sent 0, answered 0, paired 0, chat replied 1");
      expect(lines.filter(line => line.includes("watch: bridge"))).toEqual([]);
      store = openStore(file);
      expect(store.listTelegramConversations(BOT)).toEqual([expect.objectContaining({ state: "done", outcome: "answered", replyMessageId: "100" })]);
    });

    test("stopping the service releases the coding owner record within seconds while the follower still has a chat turn in flight", async () => {
      // Oct 2: deploys over 0.9.11 stopped the service, every pid was gone, and orders.db.coding.sqlite still named the
      // killed `up` as its owner: the stop waited behind the Telegram follower's turn and launchd killed it first.
      stub();
      await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await exec("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo });
      await saveRepos(join(dir, "repos.json"), [repo]);
      writeFileSync(join(dir, "up-login.txt"), `alex ${token}\n`, { mode: 0o600 });
      store.close();
      let release: () => void = () => {};
      const held = new Promise<void>(resolve => (release = resolve));
      answers.push({ text: "Still thinking.", before: () => held });
      script.updates.push([textUpdate(2, "how do things stand?")]);
      const lines: string[] = [];
      const port = 45000 + (process.pid % 2000);
      const running = runOperate("up", ["--repo", repo, "--port", String(port), "--for", "600000"], line => lines.push(line),
        { databaseFile: file, telegramTransport: script.transport, mateSeams: { subscriptionRunner: runner }, upSeams: { terminal: false, env: {}, openBrowser: () => {} } });
      const owner = () => {
        const catalog = new DatabaseSync(`${file}.coding.sqlite`, { readOnly: true });
        try { return catalog.prepare("SELECT token, pid, native_pid, clean FROM coding_owner").get(); } finally { catalog.close(); }
      };
      try {
        const deadline = Date.now() + 30_000;
        while (requests.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        expect(requests, lines.join("\n")).toHaveLength(1);
        expect(owner()).toMatchObject({ token: expect.stringMatching(/^.{36}$/), pid: process.pid });
        const stoppedAt = Date.now();
        process.emit("SIGTERM");
        while (owner()?.["token"] !== "" && Date.now() - stoppedAt < 10_000) await new Promise(resolve => setTimeout(resolve, 20));
        expect(owner()).toEqual({ token: "", pid: 0, native_pid: null, clean: 1 });
        expect(Date.now() - stoppedAt).toBeLessThan(4_000);
        // The rest of the stop is bounded too, while the turn still runs.
        expect(await running, lines.join("\n")).toBe(EXIT.ok);
        expect(Date.now() - stoppedAt).toBeLessThan(15_000);
      } finally {
        release();
      }
    }, 60_000);

    test("a process inside a coding agent's sandbox never takes the bridge: it says why and sends nothing (c1)", async () => {
      stub();
      await saveRepos(join(dir, "repos.json"), [repo]);
      store.close();
      script.updates.push([textUpdate(2, "hello")]);
      const lines: string[] = [];
      const fenced = { CODEX_SANDBOX: "seatbelt" };
      expect(await runOperate("bridge", ["telegram"], line => lines.push(line), { databaseFile: file, now, telegramTransport: script.transport, telegramEnv: fenced, mateSeams: { subscriptionRunner: runner } })).toBe(EXIT.refused);
      expect(lines.join("\n")).toContain("Telegram: not connecting from here — this process runs inside a Codex sandbox, which blocks its network. Replies and notifications go out from the Toolroll service.");
      expect(script.calls).toEqual([]);
      store = openStore(file);
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM chat_runtime WHERE provider = 'telegram'").get()?.["n"]).toBe(0);
    });
  });
});
