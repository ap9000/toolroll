import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { credentialKeyOf, subscriptionCredentialKey } from "./converse.js";
import { confirmLeadProposal, dismissLeadProposal, proposalActGate, PROPOSAL_CHAT_REASON, PROPOSAL_WAIT_REASON, TEAM_UNBOUND_CLAIM_MS } from "./lead-doors.js";
import { TeamLeads } from './team-leads.js';
import { teamChatAuthorization, subscriptionTeamChatProvider } from './team-chat-authorization.js';
import { executeLeadTool } from "./lead-tools.js";
import { approve, approvalOf, hashToken, propose } from "./scope.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { chatTaskStamp } from "./chat-task-actions.js";
import * as taskControls from "./task-control.js";
import { routeDigestOf } from "./phase-routing.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-09-02T12:00:00.000Z");
const REPO = "/repo/doors";
const CREDENTIAL = credentialKeyOf("anthropic-api", "sk-test");

describe("the lead's confirm doors (mate arc, ruling 7; slice-2 review)", () => {
  let store: Store;
  let who: VerifiedApprover;
  let clockAt = T0.getTime();
  const clock = () => new Date(clockAt);

  const principal = (): VerifiedApprover => {
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };
  const session = () =>
    store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: CREDENTIAL, ceilingMicrousd: 5_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, clock());
  /** An answered turn holding one pending proposal of the given kind. */
  const pending = (kind: "task" | "next" | "reserve" | "hold" | "steer" | "answer" | "repair" | "agents" | "task_action" | "control", payload: Record<string, unknown>, scope?: import("./store.js").LeadThreadScope): number => {
    const thread = store.openLeadThread("alex", who.ceilingDigest, clock(), scope).thread;
    const live = store.activeLeadSession("alex")!;
    const opened = store.openLeadTurn({ approver: "alex", session: live.id, thread: thread.id, credentialKey: CREDENTIAL, reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, clock());
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startLeadTurn(opened.id, clock());
    if (!started.ok) throw new Error("start");
    const id = store.draftLeadProposal({ thread: thread.id, turn: opened.id, kind, payload, ceilingDigest: who.ceilingDigest }, clock());
    store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 1, tokensIn: 1, tokensOut: 1 }, clock());
    return id;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    clockAt = T0.getTime();
    store.saveApprover("root", "r".repeat(64), T0);
    store.saveApprover("alex", "h".repeat(64), T0);
    who = principal();
    for (const id of ["a", "b", "c"]) {
      const filed = fileTaskProposal(store, { id, title: `task ${id}`, repo: REPO, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    }
  });
  afterEach(() => store.close());

  test("a card about a task confirmed outside that task's chat is recorded there, and the lead can read that chat", () => {
    session();
    const fromPhone = pending("steer", { task: "a", taskTitle: "task a", note: "Start with the mobile flow." });
    expect(confirmLeadProposal(store, who, fromPhone, clock(), { via: "telegram" })).toMatchObject({ ok: true });
    const taskChat = store.liveLeadThreadFor("alex", { kind: "task", key: "a" })!;
    expect(store.listLeadMessages(taskChat.id, 10).map(one => [one.role, one.text])).toEqual([["assistant", expect.stringMatching(/^From Telegram — Guidance for the next attempt: \S/)]]);
    const ctx = { store, who, now: clock(), step: 1, readDecisions: new Map(), draft: () => 1 };
    expect(executeLeadTool(ctx, "get_task_conversation", { task: "a" })).toMatchObject({ ok: true, body: { task: "a", title: "task a", messages: [{ from: "lead", text: expect.stringContaining("From Telegram") }] } });
    expect(executeLeadTool(ctx, "get_task_conversation", { task: "b" })).toMatchObject({ ok: true, body: { messages: [], notice: "No conversation about this task yet." } });
    expect(executeLeadTool(ctx, "get_task_conversation", { task: "nope" })).toMatchObject({ ok: false });
    // A card drafted in the task's own chat is already there: nothing is added.
    clockAt += 60_000;
    const inPlace = pending("steer", { task: "a", taskTitle: "task a", note: "Then the desktop flow." }, { kind: "task", key: "a" });
    expect(confirmLeadProposal(store, who, inPlace, clock(), { via: "web" })).toMatchObject({ ok: true });
    expect(store.listLeadMessages(taskChat.id, 10)).toHaveLength(1);
    // From the lead chat on the web it says so.
    clockAt += 60_000;
    const fromLead = pending("steer", { task: "b", taskTitle: "task b", note: "Keep it small." });
    expect(confirmLeadProposal(store, who, fromLead, clock(), { via: "web" })).toMatchObject({ ok: true });
    expect(store.listLeadMessages(store.liveLeadThreadFor("alex", { kind: "task", key: "b" })!.id, 10)[0]!.text).toMatch(/^From the lead chat — Guidance for the next attempt: /);
  });

  test("a proposal kept by a turn stopped at its deadline confirms; a draft of a turn that failed otherwise never existed", () => {
    session();
    const turnWith = (outcome: { failureReason: string; keepProposals: boolean }) => {
      const thread = store.openLeadThread("alex", who.ceilingDigest, clock()).thread;
      const opened = store.openLeadTurn({ approver: "alex", session: store.activeLeadSession("alex")!.id, thread: thread.id, credentialKey: CREDENTIAL, reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, clock());
      if (!opened.ok) throw new Error(opened.reason);
      const started = store.startLeadTurn(opened.id, clock());
      if (!started.ok) throw new Error("start");
      const id = store.draftLeadProposal({ thread: thread.id, turn: opened.id, kind: "hold", payload: { task: "a", reason: "later" }, ceilingDigest: who.ceilingDigest }, clock());
      store.finalizeLeadTurn(opened.id, started.generation, { state: "failed", settledMicrousd: 0, tokensIn: 1, tokensOut: 1, ...outcome }, clock());
      clockAt += 1_000;
      return id;
    };
    const kept = turnWith({ failureReason: "timeout", keepProposals: true });
    expect(store.getLeadProposal(kept)?.state).toBe("pending");
    expect(confirmLeadProposal(store, who, kept, clock(), { via: "web" })).toMatchObject({ ok: true });
    const dropped = turnWith({ failureReason: "malformed-reply", keepProposals: false });
    expect(store.getLeadProposal(dropped)).toBeNull();
    expect(confirmLeadProposal(store, who, dropped, clock(), { via: "web" })).toMatchObject({ ok: false });
  });

  test("chat task actions share retry, planning and dependency records; stale cards and cycles refuse", () => {
    session();
    const make = (task: string, operation: string, dependency?: string) => {
      let payload: Record<string, unknown> | null = null;
      const result = executeLeadTool({ store, who, now: clock(), step: 1, readDecisions: new Map(),
        draft: (_kind, value) => { payload = value; return 1; } }, "propose_task_action", { task, operation, ...(dependency ? { dependency } : {}) });
      expect(result).toMatchObject({ ok: true });
      return pending("task_action", payload!);
    };
    const wait = make("a", "wait_for", "b");
    expect(store.blockers("a")).toEqual([]);
    expect(confirmLeadProposal(store, who, wait, clock(), { via: "cli" })).toMatchObject({ ok: true });
    expect(store.blockers("a")).toEqual(["b"]);
    const cycle = make("b", "wait_for", "a");
    expect(confirmLeadProposal(store, who, cycle, clock(), { via: "cli" })).toMatchObject({ ok: false });
    expect(store.blockers("b")).toEqual([]);
    const remove = make("a", "stop_waiting", "b");
    expect(confirmLeadProposal(store, who, remove, clock(), { via: "cli" })).toMatchObject({ ok: true });
    expect(store.blockers("a")).toEqual([]);
    const plan = make("a", "plan");
    expect(confirmLeadProposal(store, who, plan, clock(), { via: "cli" })).toMatchObject({ ok: true });
    expect(store.lookupRef("a")?.plan).toBe("requested");
    store.setTaskState("b", "failed", clock());
    const retry = make("b", "retry");
    expect(confirmLeadProposal(store, who, retry, clock(), { via: "cli" })).toMatchObject({ ok: true });
    expect(store.getTask("b")?.state).toBe("queued");
    const stale = make("c", "plan");
    store.setTaskState("c", "done", clock());
    expect(confirmLeadProposal(store, who, stale, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "stale" });
    const controls = pending("control", { control: "providers", task: "" });
    expect(confirmLeadProposal(store, who, controls, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "not-confirmable" });
    fileTaskProposal(store, { id: "private-task", title: "Private title", repo: "/not-admitted", filedVia: "cli" }, T0);
    const ctx = { store, who, now: clock(), step: 1, readDecisions: new Map(), draft: () => 1 };
    expect(executeLeadTool(ctx, "show_control", { control: "projects", task: "private-task" })).toMatchObject({ ok: false });
    expect(executeLeadTool(ctx, "propose_task_action", { task: "b", operation: "retry", dependency: "private-task" })).toMatchObject({ ok: false });
    expect(executeLeadTool(ctx, "show_control", { control: "https://example.com" })).toMatchObject({ ok: false });
    expect(executeLeadTool(ctx, "show_control", { control: "providers" })).toMatchObject({ ok: true });
  });

  test("stop confirmation commits its receipt before signalling; rollback and replay signal nothing", () => {
    store.saveApprover("alex", hashToken("password"), clock()); who = principal(); session();
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", clock());
    propose(store, { taskId: "a", goal: "Keep the saved work", now: clock() });
    expect(approve(store, "a", "alex", clock(), store.getScope("a")!.digest, "password").ok).toBe(true);
    register(store, { name: "worker", host: "test", capacity: 1, repos: [REPO], now: clock(), newToken: () => "worker-token" });
    const ref = store.lookupRef("a")!.id;
    const claim = acquire(store, ref, "worker", { token: "worker-token", now: clock() });
    if (!claim.ok) throw new Error(claim.reason);
    const route = store.routeAuthorityFor(ref, "builder");
    if (!route?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "worker", branch: "branch", worktree: "/pool/a", route: route.stamp, now: clock() });
    const id = pending("task_action", { task: "a", operation: "stop", run, stamp: chatTaskStamp(store, who, "a") });
    const signal = vi.fn(() => expect(store.getLeadProposal(id)?.state).toBe("confirmed"));
    const original = taskControls.requestTaskStop;
    const service = vi.spyOn(taskControls, "requestTaskStop").mockImplementation((s, request, now) => original(s, { ...request,
      deferSignal: effect => request.deferSignal!(() => { signal(); effect(); }),
    }, now));
    const cas = store.casLeadProposal.bind(store);
    const failing = vi.spyOn(store, "casLeadProposal").mockImplementation((...args) => {
      if (args[2] === "confirmed") throw new Error("receipt failed");
      return cas(...args);
    });
    try {
      expect(() => confirmLeadProposal(store, who, id, clock(), { via: "web" })).toThrow("receipt failed");
      expect(signal).not.toHaveBeenCalled();
      expect(store.stopOf(run)).toBeNull();
      expect(store.getLeadProposal(id)?.state).toBe("pending");
      failing.mockRestore();
      expect(confirmLeadProposal(store, who, id, clock(), { via: "web" }).ok).toBe(true);
      expect(signal).toHaveBeenCalledTimes(1);
      expect(confirmLeadProposal(store, who, id, clock(), { via: "web" }).ok).toBe(false);
      expect(signal).toHaveBeenCalledTimes(1);
    } finally { failing.mockRestore(); service.mockRestore(); }
  });

  test("every surface meets the card's gate: a live turn in the thread refuses with the card's words until it finishes", () => {
    session();
    const id = pending("steer", { task: "a", taskTitle: "task a", note: "Start with the mobile flow." });
    const live = store.activeLeadSession("alex")!;
    const opened = store.openLeadTurn({ approver: "alex", session: live.id, thread: store.getLeadProposal(id)!.thread, credentialKey: CREDENTIAL, reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, clock());
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startLeadTurn(opened.id, clock());
    if (!started.ok) throw new Error("start");
    expect(proposalActGate(store, who, store.getLeadProposal(id)!.thread, clock())).toEqual({ ok: false, reason: "turn-running", said: PROPOSAL_WAIT_REASON });
    for (const via of ["cli", "telegram"] as const) expect(confirmLeadProposal(store, who, id, clock(), { via })).toMatchObject({ ok: false, reason: "turn-running", said: PROPOSAL_WAIT_REASON });
    expect(store.getLeadProposal(id)?.state).toBe("pending");
    store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 1, tokensIn: 1, tokensOut: 1 }, clock());
    expect(confirmLeadProposal(store, who, id, clock(), { via: "telegram" })).toMatchObject({ ok: true });
  });

  const teamProposal = () => {
    store.setChatConfig({ provider: 'claude-subscription', model: 'default', dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, 'alex', clock());
    const domain = new TeamLeads(store, () => [REPO]);
    const lead = domain.execute(who, { operation: 'create-lead', args: { name: 'Launch lead', projects: [REPO] } }, clock());
    const leadId = (lead.result as { leadId: string }).leadId;
    const created = domain.execute(who, { operation: 'create-conversation', args: { leadId, title: 'Launch', visibility: 'team', projects: [REPO] } }, clock());
    const conversation = created.snapshot!.selected!;
    const terms = teamChatAuthorization(store, who, conversation, subscriptionTeamChatProvider(store));
    const credentialKey = subscriptionCredentialKey('claude-subscription');
    const session = store.mintTeamMateSession({ approver: who.name, approverGeneration: who.generation, thread: conversation.threadId, credentialKey, ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest: terms.termsDigest }, clock());
    const open = () => {
      const turn = store.openLeadTurn({ approver: who.name, session, thread: conversation.threadId, credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, clock());
      if (!turn.ok) throw Error(turn.reason);
      return turn.id;
    };
    const turn = open(), started = store.startLeadTurn(turn, clock());
    if (!started.ok) throw Error('start');
    const proposal = store.draftLeadProposal({ thread: conversation.threadId, turn, kind: 'hold', payload: { task: 'a', reason: 'Wait for the audit.', sawHold: null }, ceilingDigest: who.ceilingDigest }, clock());
    store.finalizeLeadTurn(turn, started.generation, { state: 'answered', settledMicrousd: 0, tokensIn: 0, tokensOut: 0 }, clock());
    return { domain, conversation, proposal, open };
  };

  test('changed team provider terms refuse every confirmation surface without changing the proposal or action', () => {
    const { proposal, conversation } = teamProposal();
    const config = store.getChatConfig()!;
    expect(proposalActGate(store, who, conversation.threadId, clock())).toEqual({ ok: true });
    store.setChatConfig({ ...config, dailyTurns: config.dailyTurns + 1 }, 'alex', clock());
    expect(proposalActGate(store, who, conversation.threadId, clock())).toEqual({ ok: false, reason: 'session-ended', said: PROPOSAL_CHAT_REASON });
    const before = store.getLeadProposal(proposal);
    for (const via of ['web', 'cli', 'telegram', 'slack', 'discord', 'teams'] as const) {
      expect(confirmLeadProposal(store, who, proposal, clock(), { via })).toMatchObject({ ok: false, reason: 'session-ended', said: PROPOSAL_CHAT_REASON });
      expect(store.getLeadProposal(proposal)).toEqual(before);
      expect(store.handle.prepare('SELECT 1 FROM hold').get()).toBeUndefined();
    }
    store.setChatConfig(config, 'alex', clock());
    expect(confirmLeadProposal(store, who, proposal, clock(), { via: 'cli' })).toMatchObject({ ok: true });
    expect(store.getLeadProposal(proposal)?.state).toBe('confirmed');
  });

  test('an unbound team claim blocks only before its deadline; bound queued and running turns still block after it', () => {
    const { domain, conversation, proposal, open } = teamProposal();
    domain.execute(who, { operation: 'send', args: { conversationId: conversation.id, text: 'Check the launch plan.', requestId: 'unbound' } }, clock());
    const claim = domain.claimNext('fixture', clock())!;
    const before = store.getLeadProposal(proposal);
    const gate = () => proposalActGate(store, who, conversation.threadId, clock());
    clockAt += TEAM_UNBOUND_CLAIM_MS - 1;
    expect(confirmLeadProposal(store, who, proposal, clock(), { via: 'cli' })).toMatchObject({ ok: false, said: PROPOSAL_WAIT_REASON });
    expect(store.getLeadProposal(proposal)).toEqual(before);
    clockAt += 1;
    expect(gate()).toEqual({ ok: true });
    clockAt += 1;
    expect(gate()).toEqual({ ok: true });
    const bound = open();
    expect(domain.bindTurn(claim, bound)).toBe(true);
    expect(gate()).toMatchObject({ ok: false, said: PROPOSAL_WAIT_REASON });
    const started = store.startLeadTurn(bound, clock());
    if (!started.ok) throw Error('start');
    clockAt += TEAM_UNBOUND_CLAIM_MS * 2;
    expect(confirmLeadProposal(store, who, proposal, clock(), { via: 'telegram' })).toMatchObject({ ok: false, said: PROPOSAL_WAIT_REASON });
    store.finalizeLeadTurn(bound, started.generation, { state: 'answered', settledMicrousd: 0, tokensIn: 0, tokensOut: 0 }, clock());
    expect(store.handle.prepare('SELECT status FROM team_message WHERE message=?').get(claim.messageId)).toMatchObject({ status: 'running' });
    expect(confirmLeadProposal(store, who, proposal, clock(), { via: 'cli' })).toMatchObject({ ok: true });
  });

  test("an explicitly ended conversation refuses an old card although the principal still stands", () => {
    const sessionId = session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    store.endLeadSession(sessionId, "alex", clock());
    expect(confirmLeadProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "session-ended" });
    expect(store.getLeadProposal(id)?.state).toBe("pending");
    expect(store.queuePosition("c")?.position).toBe(3);
  });

  test("a credential rotation ends the session, deletes the thread's proposals, and the old principal is dead", () => {
    session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    store.saveApprover("alex", "n".repeat(64), clock());
    expect(store.activeLeadSession("alex")).toBeNull();
    expect(store.getLeadProposal(id)).toBeNull();
    expect(confirmLeadProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "standing" });
    // The new generation mints its own principal and finds nothing to confirm.
    const fresh = principal();
    expect(fresh.generation).toBe(who.generation + 1);
    expect(confirmLeadProposal(store, fresh, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "not-yours" });
  });

  test("the place the lead saw is part of the CAS: a neighbour leaving the queue refuses a stale next", () => {
    session();
    const seen = store.transact(() => ({ queueRevision: store.queueRevision(), position: store.queuePosition("c")! }));
    const id = pending("next", { task: "c", queueRevision: seen.queueRevision, position: seen.position.position, column: seen.position.column });
    // `b` is cancelled — no queue move, no revision bump, but c is now 2 of 2.
    expect(store.cancelTask("b", clock())).toMatchObject({ ok: true });
    expect(store.queueRevision()).toBe(seen.queueRevision);
    expect(store.queuePosition("c")?.position).toBe(2);
    expect(confirmLeadProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getLeadProposal(id)?.state).toBe("refused");
  });

  test("a hold card confirms as the operator's own hold, once; a second confirm and a dismiss both answer in words", () => {
    session();
    const id = pending("hold", { task: "a", reason: "wait", sawHold: null });
    expect(confirmLeadProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: true, said: "a held: wait" });
    expect(store.activeHolds(store.refFor("built-in", "a").id, clock()).map(one => one.reason)).toEqual(["wait"]);
    expect(confirmLeadProposal(store, who, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "not-pending" });
    expect(dismissLeadProposal(store, who, id, clock())).toBe(false);
    // A hand-placed hold after the proposal: the stale card must not overwrite it.
    const again = pending("hold", { task: "b", reason: "model text", sawHold: null });
    store.hold(store.refFor("built-in", "b").id, "by hand", null, clock());
    expect(confirmLeadProposal(store, who, again, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.activeHolds(store.refFor("built-in", "b").id, clock()).map(one => one.reason)).toEqual(["by hand"]);
  });

  test("a confirmed intake card honors plan-first instead of pretending its draft is ready to approve", () => {
    session();
    const id = pending("task", {
      repo: REPO,
      repoId: "r1",
      title: "Modernize the whole navigation",
      goal: "Make navigation coherent across desktop and mobile.",
      not: null,
      touches: [],
      acceptance: [{ id: "c1", statement: "Navigation works coherently at desktop and mobile widths.", evidence: ["screenshot"] }],
      planning: "required",
      report: false,
    });
    const outcome = confirmLeadProposal(store, who, id, clock(), { via: "web" });
    expect(outcome).toMatchObject({
      ok: true,
      said: expect.stringContaining("the planner is reading the project before you approve anything"),
      taskId: expect.any(String),
    });
    if (!outcome.ok || outcome.taskId === null) throw new Error("task was not filed");
    expect(store.lookupRef(outcome.taskId)?.plan).toBe("requested");
    expect(store.getScope(outcome.taskId)?.approvedAt).toBeNull();
  });

  test("a steering card becomes verified guidance for the next attempt only after confirmation", () => {
    session();
    const id = pending("steer", { task: "a", taskTitle: "task a", note: "Start with the mobile flow." });
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toEqual([]);
    expect(confirmLeadProposal(store, who, id, clock(), { via: "web" })).toMatchObject({
      ok: true,
      said: "Guidance saved for task a's next attempt",
      taskId: "a",
    });
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toMatchObject([
      { author: "alex", authorshipState: "verified", note: "Start with the mobile flow.", deliveredAt: null },
    ]);
  });

  test("dependency repair cards retry, atomically replace, unlink, and refuse stale graph state", () => {
    session();
    store.setTaskState("a", "failed", clock());
    store.addEdge("b", "a");
    const retry = pending("repair", { task: "b", blocker: "a", operation: "retry", sawBlockerState: "failed" });
    expect(confirmLeadProposal(store, who, retry, clock(), { via: "web" })).toMatchObject({ ok: true, said: expect.stringContaining("queued again") });
    expect(store.getTask("a")?.state).toBe("queued");
    expect(store.blockers("b")).toEqual(["a"]);

    store.setTaskState("a", "cancelled", clock());
    const replace = pending("repair", { task: "b", blocker: "a", operation: "replace", replacement: "c", sawBlockerState: "cancelled" });
    expect(confirmLeadProposal(store, who, replace, clock(), { via: "web" })).toMatchObject({ ok: true, said: "b will now wait for c instead of a" });
    expect(store.blockers("b")).toEqual(["c"]);

    store.setTaskState("c", "cancelled", clock());
    const unlink = pending("repair", { task: "b", blocker: "c", operation: "unlink", sawBlockerState: "cancelled" });
    expect(confirmLeadProposal(store, who, unlink, clock(), { via: "web" })).toMatchObject({ ok: true, said: "b can now continue without c" });
    expect(store.blockers("b")).toEqual([]);

    store.addEdge("b", "a");
    const stale = pending("repair", { task: "b", blocker: "a", operation: "unlink", sawBlockerState: "cancelled" });
    store.removeEdge("b", "a");
    expect(confirmLeadProposal(store, who, stale, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.blockers("b")).toEqual([]);
  });

  test("an answer card answers the decision as the operator; an irreversible option needs the explicit field; an answered decision refuses", () => {
    session();
    const run = store.startRun({ taskRef: store.refFor("built-in", "a").id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    store.saveDecision(
      { run, urgency: "blocking", recap: "r", question: "Which?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }, { id: "y", label: "Y", consequence: "cy", reversible: false }], recommendation: "x" },
      T0,
    );
    const irreversible = pending("answer", { decision: 1, task: "a", option: "y", optionLabel: "Y", reversible: false, rationale: "because" });
    expect(confirmLeadProposal(store, who, irreversible, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getLeadProposal(irreversible)?.state).toBe("pending");
    expect(store.getDecision(1)?.state).toBe("open");
    expect(confirmLeadProposal(store, who, irreversible, clock(), { confirm: true, via: "cli" })).toMatchObject({ ok: true, said: "decision #1 answered: Y", taskId: "a" });
    expect(store.getDecision(1)).toMatchObject({ state: "answered", answeredBy: "alex", answeredVia: "cli" });
    const late = pending("answer", { decision: 1, task: "a", option: "x", optionLabel: "X", reversible: true, rationale: "too late" });
    expect(confirmLeadProposal(store, who, late, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "already-answered" });
    // The SAME choice landing first elsewhere is not this card's answer either (v3 review, finding 5).
    const run2 = store.startRun({ taskRef: store.refFor("built-in", "b").id, leaseId: "l2", runner: "r", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    store.saveDecision({ run: run2, urgency: "blocking", recap: "r", question: "Again?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }], recommendation: "x" }, T0);
    const same = pending("answer", { decision: 2, task: "b", option: "x", optionLabel: "X", reversible: true, rationale: "x" });
    store.answerDecision({ id: 2, choice: "x", by: "root", via: "cli" }, clock());
    expect(confirmLeadProposal(store, who, same, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "already-answered" });
    expect(store.getDecision(2)).toMatchObject({ answeredBy: "root", answeredVia: "cli" });
    // A decision past its deadline is not "open" for a card, swept or not (finding 7).
    const run3 = store.startRun({ taskRef: store.refFor("built-in", "c").id, leaseId: "l3", runner: "r", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    store.saveDecision({ run: run3, urgency: "blocking", recap: "r", question: "Late?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }], recommendation: "x", deadline: new Date(clockAt + 60_000).toISOString() }, T0);
    const timed = pending("answer", { decision: 3, task: "c", option: "x", optionLabel: "X", reversible: true, rationale: "x" });
    clockAt += 120_000;
    expect(confirmLeadProposal(store, who, timed, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getDecision(3)?.state).toBe("open");
  });

  test("chat-steer: get_agents reads the size and agents in the route's own words; propose_agents drafts only a configured, role-valid choice; the confirmed card changes the agents through the authenticated route edit and stales the approval", () => {
    // A routed installation: everyday and strong agents named once, in configuration.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "ops", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "ops", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "ops", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "ops", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "gemini", "gemini-2.5-pro", "ops", T0);
    store.setPhaseTierConfig("installation", "plan", "strong", "codex", "gpt-5", "ops", T0);
    // alex's real password, so the approval ceremony below can run.
    store.saveApprover("alex", hashToken("alex-password"), T0);
    who = principal();
    propose(store, { taskId: "a", goal: "Harden the payouts flow", acceptance: [{ id: "c1", statement: "Payouts never double-send", how: null, evidence: ["check"] }], now: T0 });
    session();
    const ctx = { store, who, now: clock(), draft: (kind: string, payload: Record<string, unknown>) => pending(kind as "agents", payload), step: 1, readDecisions: new Map<number, number>() };
    const read = executeLeadTool(ctx, "get_agents", { task: "a" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const body = read.body as Record<string, unknown>;
    expect(body).toMatchObject({
      task: "a",
      standing: "awaiting approval",
      // A short, single-path goal is a small change: it makes no plan, so no planner works on it.
      summary: "claude · sonnet builds and repairs",
      editable: true,
      approval: "not approved",
    });
    // A declared risk level is gone (v115): nothing to read or choose.
    expect(body["risk"]).toBeUndefined();
    expect(body["riskChoices"]).toBeUndefined();
    expect((body["agents"] as { role: string; provider: string; reasons: string[] }[]).map(one => one.role)).toEqual(["planner", "builder", "repair"]);
    const choices = body["choices"] as Record<string, { provider: string; model: string; current: boolean }[]>;
    // Only active roles are offered; historical reviewer configuration stays out of the choices.
    expect(choices["reviewer"]).toBeUndefined();
    expect(executeLeadTool(ctx, "propose_agents", { task: "a", role: "reviewer", agent: { provider: "claude", model: "sonnet" } })).toMatchObject({ ok: false });
    expect(choices["builder"]).toEqual([{ provider: "claude", model: "sonnet", current: true }, { provider: "gemini", model: "gemini-2.5-pro", current: false }]);
    expect(choices["planner"]).toEqual([{ provider: "claude", model: "sonnet", current: true }, { provider: "codex", model: "gpt-5", current: false }]);
    expect(choices["repair"]).toEqual([{ provider: "claude", model: "sonnet", current: true }]);
    // The planner's strong agent is the planner's — never offered to build.
    expect(choices["builder"].some(one => one.model === "gpt-5")).toBe(false);
    // An unlisted agent is refused, naming the choices; so is a no-op.
    expect(executeLeadTool(ctx, "propose_agents", { task: "a", role: "builder", agent: { provider: "claude", model: "opus" } })).toMatchObject({ ok: false, message: expect.stringContaining("one of the builder choices") });
    expect(executeLeadTool(ctx, "propose_agents", { task: "a", role: "builder", agent: { provider: "codex", model: "gpt-5-codex" } })).toMatchObject({ ok: false });
    expect(executeLeadTool(ctx, "propose_agents", { task: "a", role: "builder", agent: { provider: "claude", model: "sonnet" } })).toMatchObject({ ok: false, message: expect.stringContaining("already runs") });
    expect(executeLeadTool(ctx, "propose_agents", { task: "a", risk: "high" })).toMatchObject({ ok: false, message: expect.stringContaining("say what changes") });
    expect(executeLeadTool(ctx, "propose_agents", { task: "a", role: "builder", clear: true })).toMatchObject({ ok: false, message: expect.stringContaining("nothing to clear") });
    // Approve the scope as it stands, then propose a real change.
    const first = store.getScope("a")!;
    expect(approve(store, "a", "alex", T0, first.digest, "alex-password").ok).toBe(true);
    const sealedBefore = store.approvedRouteOf("a")!;
    // A card naming an agent that is no longer configured for that role
    // refuses INSIDE the edit transaction — even with the right digest —
    // and the approval stands untouched: the proof is against the
    // configuration standing at confirmation, not at drafting.
    const gone = pending("agents", { task: "a", phase: "plan", role: "planner", provider: "codex", model: "gpt-5", sawDigest: first.digest });
    store.clearPhaseTierConfig("installation", "plan", "strong");
    expect(confirmLeadProposal(store, who, gone, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale", said: expect.stringContaining("no longer one of the configured agents") });
    expect(approvalOf(store.getScope("a")!).approved).toBe(true);
    expect(store.refFor("built-in", "a").routeOverrides ?? []).toHaveLength(0);
    // A pair configured for ANOTHER role is not this role's choice either.
    const borrowed = pending("agents", { task: "a", phase: "build", role: "builder", provider: "codex", model: "gpt-5-codex", sawDigest: first.digest });
    expect(confirmLeadProposal(store, who, borrowed, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale" });
    expect(approvalOf(store.getScope("a")!).approved).toBe(true);
    const proposed = executeLeadTool({ ...ctx, now: clock() }, "propose_agents", { task: "a", role: "builder", agent: { provider: "gemini", model: "gemini-2.5-pro" }, why: "payouts move money" });
    expect(proposed).toMatchObject({ ok: true, body: { kind: "agents", task: "a", role: "builder", agent: { provider: "gemini", model: "gemini-2.5-pro" }, awaiting: expect.stringContaining("renewing") } });
    if (!proposed.ok) return;
    const id = (proposed.body as { proposal: number }).proposal;
    expect(store.getLeadProposal(id)?.payload).toMatchObject({ task: "a", phase: "build", role: "builder", provider: "gemini", model: "gemini-2.5-pro", sawDigest: first.digest, approval: "approved" });
    // Confirmed: the ONE authenticated route edit — recorded as the
    // operator, the approval staled, the sealed route gone.
    const outcome = confirmLeadProposal(store, who, id, clock(), { via: "web" });
    expect(outcome).toMatchObject({ ok: true, kind: "agents", taskId: "a", said: expect.stringContaining("the builder is now gemini · gemini-2.5-pro — the earlier approval no longer covers this task; approve it again") });
    const ref = store.refFor("built-in", "a");
    expect(ref.routeOverrides).toEqual([expect.objectContaining({ phase: "build", provider: "gemini", model: "gemini-2.5-pro", by: "alex" })]);
    const after = store.getScope("a")!;
    expect(approvalOf(after)).toMatchObject({ approved: false, reason: "changed" });
    expect(store.approvedRouteOf("a")).toBeNull();
    expect(routeDigestOf(sealedBefore)).not.toBe(after.proposedRouteJson === null ? "" : routeDigestOf(JSON.parse(after.proposedRouteJson!) as never));
    // A stale card — drafted against the earlier digest — refuses; nothing moves again.
    const stale = pending("agents", { task: "a", phase: "build", role: "builder", provider: "claude", model: "sonnet", sawDigest: first.digest });
    expect(confirmLeadProposal(store, who, stale, clock(), { via: "web" })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.refFor("built-in", "a").routeOverrides).toHaveLength(1);
    // Clearing the hand-picked builder restores the recommendation.
    const clear = executeLeadTool({ ...ctx, now: clock() }, "propose_agents", { task: "a", role: "builder", clear: true });
    expect(clear).toMatchObject({ ok: true, body: { role: "builder", clear: true } });
    if (!clear.ok) return;
    expect(confirmLeadProposal(store, who, (clear.body as { proposal: number }).proposal, clock(), { via: "web" })).toMatchObject({ ok: true, said: expect.stringContaining("the builder choice was cleared") });
    expect(store.refFor("built-in", "a").routeOverrides).toEqual([]);
  });

  test("a structural principal never confirms", () => {
    session();
    const id = pending("hold", { task: "a", reason: "wait", sawHold: null });
    const copy = { ...who } as unknown as VerifiedApprover;
    expect(confirmLeadProposal(store, copy, id, clock(), { via: "cli" })).toMatchObject({ ok: false, reason: "standing" });
    expect(store.getLeadProposal(id)?.state).toBe("pending");
  });

  test("the paired phone is a door surface of its own: the outcome names it, the decision records it, and a composing caller's commit hook orders the stop signal after its own commit", () => {
    session();
    const run = store.startRun({ taskRef: store.refFor("built-in", "a").id, leaseId: "l-a", runner: "r", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    store.saveDecision({ run, urgency: "blocking", recap: "r", question: "Which?", options: [{ id: "x", label: "X", consequence: "cx", reversible: true }], recommendation: "x" }, T0);
    const decision = store.listDecisions("open")[0]!.id;
    const answer = pending("answer", { decision, task: "a", option: "x", optionLabel: "X", reversible: true, rationale: "x" });
    expect(confirmLeadProposal(store, who, answer, clock(), { via: "telegram" })).toMatchObject({ ok: true, kind: "answer" });
    expect(store.getDecision(decision)).toMatchObject({ answeredBy: "alex", answeredVia: "telegram" });
    expect(store.getLeadProposal(answer)?.outcome).toMatchObject({ ok: true, via: "telegram" });
    // A caller already inside a transaction hands the door its commit hook: nothing signals until it commits.
    const hold = pending("hold", { task: "b", reason: "wait", sawHold: null });
    const deferred: (() => void)[] = [];
    const outcome = store.transact(() => confirmLeadProposal(store, who, hold, clock(), { via: "telegram", deferSignal: signal => deferred.push(signal) }));
    expect(outcome).toMatchObject({ ok: true, kind: "hold" });
    expect(store.getLeadProposal(hold)?.outcome).toMatchObject({ said: "b held: wait", via: "telegram" });
    expect(deferred).toEqual([]);
  });
});
