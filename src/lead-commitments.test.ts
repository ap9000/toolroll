import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { confirmLeadProposal } from "./lead-doors.js";
import { executeLeadTool, type LeadToolContext } from "./lead-tools.js";
import { runLeadFollowPass } from "./lead-follow.js";
import { leadContext } from "./lead-context.js";
import { knowledgeView } from "./project-knowledge.js";
import { getCommitment, openCommitments, promiseChannelOf } from "./lead-commitments.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { prepareSharedAction } from "./chat-actions.js";
import { TELEGRAM_SKIPPED_OTHER_CHAT } from "./store.js";
import { deliverSlackPart, planSlackNotifications, type SlackChatOptions } from "./slack-chat.js";
import type { SlackApi } from "./slack-api.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import { deliverDiscordPart, planDiscordNotifications, type DiscordChatOptions } from "./discord-chat.js";
import type { DiscordApi } from "./discord-api.js";
import { deliverTeamsPart, planTeamsNotifications, type TeamsChatOptions } from "./teams-chat.js";
import type { TeamsApi } from "./teams-api.js";

describe("the lead keeps its promises and remembers corrections", () => {
  let root: string, repo: string, store: Store, who: VerifiedApprover, session: number, thread: number;
  const t0 = new Date("2026-10-02T12:00:00.000Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lead-promises-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Promises\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
    store = openStore(join(root, "state.db"));
    if (!addApprover(store, "operator", t0).ok) throw Error("account");
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "fixture", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, t0);
    thread = store.openLeadThread(who.name, who.ceilingDigest, t0).thread.id;
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  /** One lead turn: the tools run inside it, then it is answered (or fails) with its reply. */
  function turn(now: Date, calls: (ctx: LeadToolContext) => void, state: "answered" | "failed" | "running" = "answered", channel?: LeadToolContext["channel"]) {
    const opened = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "fixture", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!opened.ok) throw Error(opened.reason);
    const started = store.startLeadTurn(opened.id, now);
    if (!started.ok) throw Error("start");
    const ctx: LeadToolContext = { store, who, now, step: 1, readDecisions: new Map(), thread, turn: opened.id, evidenceRoot: root, ...(channel === undefined ? {} : { channel }),
      draft: (kind, payload) => store.draftLeadProposal({ thread, turn: opened.id, kind, payload, ceilingDigest: who.ceilingDigest }, now) };
    calls(ctx);
    if (state === "running") return opened.id;
    store.finalizeLeadTurn(opened.id, started.generation, state === "answered"
      ? { state, settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "I'll tell you.", activity: "" } }
      : { state, settledMicrousd: 0, tokensIn: 0, tokensOut: 0, failureReason: "provider-error" }, now);
    return opened.id;
  }
  const call = (ctx: LeadToolContext, name: string, args: Record<string, unknown>) => {
    const result = executeLeadTool(ctx, name, args);
    if (!result.ok) throw Error(result.message);
    return result.body as Record<string, unknown>;
  };
  const pass = (now: Date) => runLeadFollowPass({ store, repos: () => [repo], evidenceRoot: root, clock: () => now, provider: () => null });
  const said = () => store.listLeadMessages(thread, 50).filter(one => one.role === "assistant" && one.turn === null).map(one => one.text);
  function builtRun(id: string) {
    const made = fileTaskProposal(store, { id, title: "Fix the login page", repo, filedVia: "cli", planning: "skip" }, t0);
    if (!made.ok) throw Error(made.message);
    return store.startRun({ taskRef: store.refFor("built-in", id).id, leaseId: "l", runner: "b1", branch: "b", worktree: "/w",
      route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: t0 });
  }

  test("c1: a promise records what, its condition, check time, channel and expiry, and is reported once when met", async () => {
    const run = builtRun("login");
    let made: Record<string, unknown> = {};
    turn(t0, ctx => { made = call(ctx, "commit_to", { what: "Tell you when the release check passes", when: "check", run, result: "passed" }); });
    const saved = getCommitment(store, Number(made["commitment"]))!;
    expect(saved).toMatchObject({ owner: "operator", repo, thread, channel: "chat", state: "open", what: "Tell you when the release check passes",
      condition: { kind: "check", run, result: "passed" }, checkAt: t0.toISOString(), expiresAt: "2026-10-09T12:00:00.000Z" });
    expect(made["condition"]).toBe("when the checks on “Fix the login page” pass");

    // Not met yet: nothing is said, and the next look is scheduled.
    await pass(at(1));
    expect(said()).toEqual([]);
    expect(getCommitment(store, saved.id)).toMatchObject({ state: "open", checkedAt: at(1).toISOString() });

    store.finishRun(run, { outcome: "built", now: at(2) });
    store.recordRunCheck(run, { status: "passed", exitCode: 0, suites: [] }, at(2));
    await pass(at(3));
    expect(said()).toEqual(["The checks on “Fix the login page” passed. (I said I would tell you when the release check passes.)"]);
    expect(getCommitment(store, saved.id)).toMatchObject({ state: "done", closedBy: "lead" });
    // Once: later passes say nothing more.
    await pass(at(10));
    await pass(at(20));
    expect(said()).toHaveLength(1);
    expect(openCommitments(store, "operator")).toEqual([]);
  });

  test("c1: a task state and a time each complete a promise; one never met expires after 7 days without a message", async () => {
    builtRun("payout");
    turn(t0, ctx => {
      call(ctx, "commit_to", { what: "Tell you when payouts is complete", when: "task", task: "payout", states: ["complete"] });
      call(ctx, "commit_to", { what: "Check back with you this afternoon", when: "time", at: at(120).toISOString() });
    });
    const [task, time] = openCommitments(store, "operator");
    expect(time).toMatchObject({ condition: { kind: "time" }, checkAt: at(120).toISOString() });
    await pass(at(60));
    expect(said()).toEqual([]);
    await pass(at(121));
    expect(said()).toEqual(["It is time. (I said I would check back with you this afternoon.)"]);
    await pass(at(7 * 24 * 60 + 1));
    expect(getCommitment(store, task!.id)).toMatchObject({ state: "expired" });
    expect(said()).toHaveLength(1);
  });

  test("c1: a promise from a reply that was not delivered is dropped at once and never listed; the owner can cancel one (as Settings → Lead does); the lead can release one", async () => {
    turn(t0, ctx => { call(ctx, "commit_to", { what: "Tell you tomorrow", when: "time", at: at(60).toISOString() }); }, "failed");
    // Settings (and the lead's catch-up) never list it, even before the follow pass looks.
    expect(openCommitments(store, "operator")).toEqual([]);
    // Dropped on the next pass, long before it was due to be looked at.
    await pass(at(1));
    expect(store.handle.prepare("SELECT state, outcome FROM lead_commitment").get()).toMatchObject({ state: "cancelled", outcome: "The reply that made this promise was not delivered." });
    await pass(at(61));
    expect(said()).toEqual([]);

    let ids: number[] = [];
    turn(at(70), ctx => {
      ids = [call(ctx, "commit_to", { what: "Ping you at five", when: "time", at: at(300).toISOString() }),
        call(ctx, "commit_to", { what: "Ping you at six", when: "time", at: at(360).toISOString() })].map(one => Number(one["commitment"]));
      expect(executeLeadTool(ctx, "commit_to", { what: "Ping you next month", when: "time", at: at(8 * 24 * 60).toISOString() })).toMatchObject({ ok: false });
      expect(executeLeadTool(ctx, "commit_to", { what: "Watch someone else's task", when: "task", task: "nope" })).toMatchObject({ ok: false });
    });
    const { cancelCommitment } = await import("./lead-commitments.js");
    expect(cancelCommitment(store, "someone-else", ids[0]!, "someone-else", "no", at(80))).toBe(false);
    expect(cancelCommitment(store, "operator", ids[0]!, "operator", "Cancelled in Settings.", at(80))).toBe(true);
    turn(at(90), ctx => { expect(call(ctx, "release_commitment", { commitment: ids[1], reason: "You said not to ping after five." })).toMatchObject({ state: "cancelled" }); });
    await pass(at(400));
    expect(said()).toEqual([]);
  });

  test("c2: a correction becomes a confirmable decision card at once, and once confirmed it is in the next turn's bundle with the follow-through", () => {
    let card = 0, promise = 0;
    turn(t0, ctx => {
      promise = Number(call(ctx, "commit_to", { what: "Tell you when the full checks pass", when: "time", at: at(60).toISOString() })["commitment"]);
      const body = call(ctx, "remember", { repo: "r1", kind: "decision", text: "Don't run full checks on this project", why: "The operator said full checks are too slow here; quick checks are enough." });
      card = Number(body["proposal"]);
      expect(body).toMatchObject({ awaiting: "confirmation", executed: false });
    });
    const proposal = store.getLeadProposal(card)!;
    expect(proposal).toMatchObject({ kind: "action", state: "pending", payload: { operation: "decision_record" } });
    let bundle = JSON.parse(leadContext(store, who.repos, at(1), { evidenceRoot: root, owner: who.name, thread }));
    expect(bundle.projects[0].decisions).toEqual([]);
    expect(bundle.corrections).toEqual([]);
    expect(bundle.commitments).toMatchObject([{ id: promise, what: "Tell you when the full checks pass" }]);

    const confirmed = confirmLeadProposal(store, who, card, at(2), { via: "telegram", evidenceRoot: root });
    expect(confirmed).toMatchObject({ ok: true });
    bundle = JSON.parse(leadContext(store, who.repos, at(3), { evidenceRoot: root, owner: who.name, thread }));
    expect(bundle.projects).toMatchObject([{ repo: "r1", decisions: [{ title: "Don't run full checks on this project" }] }]);
    expect(bundle.corrections).toEqual([{ proposal: card, change: expect.stringContaining("Don't run full checks on this project") }]);
    expect(bundle.followThrough).toMatch(/Re-check the open proposals and promises/);
    // After the lead's next reply the correction is no longer new; the decision stays in the bundle.
    turn(at(4), () => {});
    bundle = JSON.parse(leadContext(store, who.repos, at(5), { evidenceRoot: root, owner: who.name, thread }));
    expect(bundle.corrections).toEqual([]);
    expect(bundle.projects[0].decisions).toHaveLength(1);
  });

  test("c2: a lasting preference becomes an instruction card added to the project's instructions, in the next bundle once confirmed", () => {
    let card = 0;
    turn(t0, ctx => {
      card = Number(call(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies to two sentences.", revision: 0 })["proposal"]);
      expect(executeLeadTool(ctx, "remember", { repo: "r1", kind: "decision", text: "No reason given" })).toMatchObject({ ok: false });
    });
    expect(store.getLeadProposal(card)!.payload).toMatchObject({ operation: "knowledge_instructions" });
    expect(confirmLeadProposal(store, who, card, at(1), { via: "telegram", evidenceRoot: root })).toMatchObject({ ok: true });
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe("Keep replies to two sentences.");
    const bundle = JSON.parse(leadContext(store, who.repos, at(2), { evidenceRoot: root, owner: who.name, thread }));
    expect(bundle.rest.knowledge).toMatchObject([{ repo: "r1", instructions: "Keep replies to two sentences." }]);
    expect(bundle.corrections).toEqual([{ proposal: card, change: "Project instructions now end: Keep replies to two sentences." }]);
    // Saying it again adds nothing.
    turn(at(3), ctx => { expect(executeLeadTool(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies to two sentences.", revision: 1 })).toMatchObject({ ok: false, message: "The project's instructions already say this." }); });
  });
  test("c1: a promise made on Telegram is reported there as the lead's message, and a promise made on Slack is not sent to Telegram", async () => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "operator", by: "operator", ttlMs: PAIRING_TTL_MS }, t0);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "777000", chatId: "4242", userId: "31337", updateId: 1 }, t0).ok).toBe(true);
    let phone = 0, slack = 0;
    turn(at(1), ctx => { phone = Number(call(ctx, "commit_to", { what: "I'll ping you at noon", when: "time", at: at(30).toISOString() })["commitment"]); }, "answered", "telegram");
    turn(at(2), ctx => { slack = Number(call(ctx, "commit_to", { what: "Remind you about the docs", when: "time", at: at(30).toISOString() })["commitment"]); }, "answered", "slack");
    expect(getCommitment(store, phone)).toMatchObject({ channel: "telegram" });
    expect(getCommitment(store, slack)).toMatchObject({ channel: "slack" });

    await pass(at(31));
    // The shared conversation keeps both lines; each chat gets its own promise as the lead's message to its owner.
    expect(said()).toEqual(["It is time. (I said I would ping you at noon.)", "It is time. (I said I would remind you about the docs.)"]);
    const notices = store.handle.prepare("SELECT dedupe_key, kind, recipient, body FROM notification WHERE dedupe_key LIKE 'lead-promise:%' ORDER BY id").all();
    expect(notices).toEqual([
      { dedupe_key: `lead-promise:telegram:${phone}`, kind: "lead-say", recipient: "operator", body: "It is time. (I said I would ping you at noon.)" },
      { dedupe_key: `lead-promise:slack:${slack}`, kind: "lead-say", recipient: "operator", body: "It is time. (I said I would remind you about the docs.)" },
    ]);
    expect(notices.map(one => promiseChannelOf({ dedupeKey: String(one["dedupe_key"]) }))).toEqual(["telegram", "slack"]);

    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let next = 100;
    const transport: TelegramTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === "getUpdates") return { ok: true, result: [] };
      if (method === "sendMessage" || method === "editMessageText") return { ok: true, result: { message_id: next++ } };
      return { ok: true, result: true };
    };
    await bridgePass(store, { botId: "777000", transport, clock: () => at(32), readProjects: async () => [repo], conversation: { evidenceRoot: root, phoneOrigin: () => "https://console.example" } });
    expect(calls.filter(one => one.method === "sendMessage" && String(one.params["chat_id"]) === "4242").map(one => one.params["text"]))
      .toEqual(["Lead\n\nIt is time. (I said I would ping you at noon.)"]);
    expect(store.handle.prepare("SELECT d.receipt FROM notification_delivery d JOIN notification n ON n.id = d.notification WHERE n.dedupe_key = ?").get(`lead-promise:slack:${slack}`))
      .toMatchObject({ receipt: TELEGRAM_SKIPPED_OTHER_CHAT });
    // Reported once: a later pass sends nothing more.
    await pass(at(40));
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE 'lead-promise:%'").get()).toMatchObject({ n: 2 });
  });

  test.each(["slack", "discord", "teams"] as const)("c1: a promise made on %s is delivered there as the lead's message, and one made on another chat is not", async channel => {
    const sent: string[] = [];
    let next = 100;
    const installation = `installation-${channel}`;
    const base = { store, owner: "test", readProjects: async () => [repo], evidenceRoot: root, current: () => true, origin: () => "https://console.example", clock: () => at(32) };
    let plan: () => Promise<void>, deliver: () => Promise<boolean>;
    if (channel === "slack") {
      const identity = { installation, team: "TTEST", app: "ATEST", bot: "UBOT", workspace: "Test workspace" };
      const api: SlackApi = async (method, args = {}) => {
        if (method === "users.info") return { user: { id: "UTEST", team_id: "TTEST", deleted: false, is_bot: false } };
        if (method === "conversations.info") return { channel: { id: "DTEST", is_im: true, user: "UTEST" } };
        if (method === "chat.postMessage" || method === "chat.update") { sent.push(String(args["text"])); return { ts: `1789700000.${String(next++).padStart(6, "0")}` }; }
        return {};
      };
      const state = new ChatState(store, "slack"), options: SlackChatOptions = { ...base, identity, api };
      state.lease(installation, "test", at(32));
      expect(state.pair(identity, chatHash(state.pairing(installation, "operator", store.accountOf("operator")!.generation, t0)), "UTEST", "DTEST", t0)).not.toBeNull();
      plan = () => planSlackNotifications(options); deliver = () => deliverSlackPart(options);
    } else if (channel === "discord") {
      const identity = { installation, app: "200000000000000001", bot: "100000000000000001", workspace: "Discord" };
      const api: DiscordApi = async (method, path, body = {}) => {
        if (path === "/users/300000000000000001") return { id: "300000000000000001" };
        if (path === "/channels/400000000000000001") return { id: "400000000000000001", type: 1, recipients: [{ id: "300000000000000001" }] };
        if (method === "GET") return { items: [] };
        sent.push(JSON.stringify(body));
        return { id: String(500000000000000000n + BigInt(next++)), channel_id: "400000000000000001", author: { id: identity.bot } };
      };
      const state = new ChatState(store, "discord"), options: DiscordChatOptions = { ...base, identity, api };
      state.lease(installation, "test", at(32));
      expect(state.pair(identity, chatHash(state.pairing(installation, "operator", store.accountOf("operator")!.generation, t0)), "300000000000000001", "400000000000000001", t0)).not.toBeNull();
      plan = () => planDiscordNotifications(options); deliver = () => deliverDiscordPart(options);
    } else {
      const identity = { installation, team: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", app: "11111111-2222-4333-8444-555555555555", bot: "28:11111111-2222-4333-8444-555555555555", workspace: "Teams" };
      const api: TeamsApi = async (method, _service, path, body) => {
        if (method === "GET") return { id: decodeURIComponent(path.split("/members/")[1] ?? "") };
        sent.push(String(body?.["text"] ?? JSON.stringify(body)));
        return { id: `act-${next++}` };
      };
      const state = new ChatState(store, "teams"), options = { ...base, identity, api } as TeamsChatOptions;
      state.lease(installation, "test", at(32));
      state.setMeta(installation, "serviceUrl:a:1dm-operator-conversation", "https://smba.trafficmanager.net/teams/", t0);
      expect(state.pair(identity, chatHash(state.pairing(installation, "operator", store.accountOf("operator")!.generation, t0)), "29:1operator-user-id-xxxxxxxxx", "a:1dm-operator-conversation", t0)).not.toBeNull();
      plan = () => planTeamsNotifications(options); deliver = () => deliverTeamsPart(options);
    }
    const other = channel === "slack" ? "discord" : "slack";
    turn(at(1), ctx => { call(ctx, "commit_to", { what: "I'll ping you at noon", when: "time", at: at(30).toISOString() }); }, "answered", channel);
    turn(at(2), ctx => { call(ctx, "commit_to", { what: "Remind you about the docs", when: "time", at: at(30).toISOString() }); }, "answered", other);
    await pass(at(31));
    for (let round = 0; round < 2; round++) {
      await plan();
      for (let i = 0; i < 20 && (await deliver()); i++);
    }
    expect(sent.filter(text => text.includes("I said I would"))).toEqual([expect.stringContaining("It is time. (I said I would ping you at noon.)")]);
  });

  test("c1: an interrupted reply whose text was shown keeps its promises; one that showed nothing drops them", async () => {
    const shown = turn(t0, ctx => { call(ctx, "commit_to", { what: "Tell you at one", when: "time", at: at(60).toISOString() }); }, "failed");
    store.appendLeadMessage({ thread, turn: shown, role: "assistant", text: "I'll tell you at one." }, t0);
    turn(at(1), ctx => { call(ctx, "commit_to", { what: "Tell you at two", when: "time", at: at(120).toISOString() }); }, "failed");
    expect(openCommitments(store, "operator")).toMatchObject([{ what: "Tell you at one" }]);
    await pass(at(2));
    expect(store.handle.prepare("SELECT what, state FROM lead_commitment ORDER BY id").all()).toEqual([
      { what: "Tell you at one", state: "open" }, { what: "Tell you at two", state: "cancelled" }]);
    await pass(at(61));
    expect(said()).toEqual(["It is time. (I said I would tell you at one.)"]);
  });

  test("c1: a promise from a reply still being written is not listed until that reply is answered", async () => {
    const running = turn(t0, ctx => { call(ctx, "commit_to", { what: "Tell you at one", when: "time", at: at(60).toISOString() }); }, "running");
    expect(openCommitments(store, "operator")).toEqual([]);
    await pass(at(1));
    expect(store.handle.prepare("SELECT state FROM lead_commitment").get()).toMatchObject({ state: "open" });
    const live = store.getLeadTurn(running)!;
    store.finalizeLeadTurn(running, live.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "I'll tell you at one.", activity: "" } }, at(2));
    expect(openCommitments(store, "operator")).toMatchObject([{ what: "Tell you at one" }]);
  });

  test("c1: a reply still running is not listed even once it has written text; failing without showing it drops its promise", async () => {
    const running = turn(t0, ctx => { call(ctx, "commit_to", { what: "Tell you at one", when: "time", at: at(0.2).toISOString() }); }, "running");
    store.appendLeadMessage({ thread, turn: running, role: "assistant", text: "Partial reply" }, t0);
    expect(openCommitments(store, "operator")).toEqual([]);
    await pass(at(0.5));
    expect(store.handle.prepare("SELECT state FROM lead_commitment").get()).toMatchObject({ state: "open" });
    expect(said()).toEqual([]);
    store.handle.prepare("DELETE FROM lead_message WHERE turn = ?").run(running);
    const live = store.getLeadTurn(running)!;
    store.finalizeLeadTurn(running, live.generation, { state: "failed", settledMicrousd: 0, unknownSpend: false, tokensIn: 0, tokensOut: 0, failureReason: "provider-error" }, at(0.6));
    expect(openCommitments(store, "operator")).toEqual([]);
    await pass(at(0.7));
    expect(store.handle.prepare("SELECT state FROM lead_commitment").get()).toMatchObject({ state: "cancelled" });
    expect(said()).toEqual([]);
  });

  test("c2: a confirmed correction stays in the bundle after a promise report or follow update; only the lead's next reply clears it", async () => {
    let card = 0;
    turn(t0, ctx => {
      call(ctx, "commit_to", { what: "Tell you in five minutes", when: "time", at: at(5).toISOString() });
      card = Number(call(ctx, "remember", { repo: "r1", kind: "decision", text: "Use quick checks on this project", why: "The operator said full checks are too slow here." })["proposal"]);
    });
    expect(confirmLeadProposal(store, who, card, at(1), { via: "telegram", evidenceRoot: root })).toMatchObject({ ok: true });
    // A turn-less line after the confirmation: a promise report, then a follow update.
    await pass(at(6));
    expect(said()).toHaveLength(1);
    store.appendLeadMessage({ thread, turn: null, role: "assistant", text: "Crew updates handled." }, at(7));
    let bundle = JSON.parse(leadContext(store, who.repos, at(8), { evidenceRoot: root, owner: who.name, thread }));
    expect(bundle.corrections).toEqual([{ proposal: card, change: expect.stringContaining("Use quick checks on this project") }]);
    turn(at(9), () => {});
    bundle = JSON.parse(leadContext(store, who.repos, at(10), { evidenceRoot: root, owner: who.name, thread }));
    expect(bundle.corrections).toEqual([]);
  });

  test("c2: remember cards refuse a stale instruction revision and never duplicate a card still waiting", () => {
    let first = 0;
    turn(t0, ctx => {
      // The lead read revision 0 (no instructions yet); omitting it or naming another is refused.
      expect(executeLeadTool(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies short." })).toMatchObject({ ok: false });
      expect(executeLeadTool(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies short.", revision: 3 })).toMatchObject({ ok: false, message: expect.stringContaining("changed since you read them") });
      first = Number(call(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies short.", revision: 0 })["proposal"]);
      // A second instruction card while the first waits would overwrite it: refused, as is the same decision twice.
      expect(executeLeadTool(ctx, "remember", { repo: "r1", kind: "instruction", text: "Use plain words.", revision: 0 })).toMatchObject({ ok: false, message: expect.stringContaining(`Card ${first}`) });
      call(ctx, "remember", { repo: "r1", kind: "decision", text: "No full checks here", why: "Too slow for this project." });
      expect(executeLeadTool(ctx, "remember", { repo: "r1", kind: "decision", text: "no full checks here ", why: "Again." })).toMatchObject({ ok: false, message: expect.stringContaining("already proposes this decision") });
    });
    expect(store.listLeadProposals(thread, ["pending"])).toHaveLength(2);
    // The instructions change elsewhere (Knowledge, another card) before the waiting card is confirmed: it is refused, not applied over them.
    const elsewhere = prepareSharedAction(store, who, "knowledge_instructions", { repo, instructions: "Edited on the Knowledge page." }, root, at(1));
    turn(at(1), ctx => { expect(ctx.draft("action", { ...elsewhere })).not.toBeNull(); });
    const other = store.listLeadProposals(thread, ["pending"]).at(-1)!.id;
    expect(confirmLeadProposal(store, who, other, at(2), { via: "telegram", evidenceRoot: root })).toMatchObject({ ok: true });
    expect(confirmLeadProposal(store, who, first, at(3), { via: "telegram", evidenceRoot: root })).toMatchObject({ ok: false });
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe("Edited on the Knowledge page.");
    // Once it is no longer waiting, a fresh card against the current revision is accepted.
    turn(at(4), ctx => { expect(executeLeadTool(ctx, "remember", { repo: "r1", kind: "instruction", text: "Keep replies short.", revision: 1 })).toMatchObject({ ok: true }); });
  });
});
