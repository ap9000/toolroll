/** The quick-answer router (docs/plans/responsive-chat.md §8) and the lead's v158 step records: the routing rule, a
 * quick reply's read-only tools, escalation that discards a quick step's calls unrun, and what each step saves. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openStore, leadQuickAnswersOn, setLeadQuickAnswers, type ChatConfig, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { subscriptionCredentialKey } from "./converse.js";
import { LEAD_FAILURE_COPY, leadFailureText, runLeadTurn } from "./lead.js";
import { LEAD_TOOL_SCHEMAS } from "./lead-tools.js";
import { QUICK_READ_TOOLS, modelName, quickLeadModel, quickQuestion, quickRoute, quickStepEscalates } from "./lead-route.js";
import type { SubscriptionLeadRequest, SubscriptionLeadRunner } from "./subscription-chat.js";
import type { LeadProgress } from "./lead-progress.js";

const T0 = new Date("2026-11-08T12:00:00.000Z");
const REPO = "/repo/quick";
const CONFIG: ChatConfig = { provider: "claude-subscription", model: "opus", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0, updatedAt: T0.toISOString(), updatedBy: "alex" };
const replied = (text: string, calls: { id: string; name: string; args: Record<string, unknown> }[] = []) =>
  ({ ok: true as const, answer: { text, calls, tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } });

describe("which model answers (the routing rule)", () => {
  const route = (message: string, extra: Partial<Parameters<typeof quickRoute>[0]> = {}) => quickRoute({
    enabled: true, provider: "claude-subscription", mainModel: "opus", message, hasContext: false, hasReplyImage: false, askOpen: false,
    quickModel: "claude-sonnet-5-5", quickAllowed: true, ...extra }).route;

  test.each([
    ["what's running?", "fast"],
    ["What needs me", "fast"],
    ["status", "fast"],
    ["which tasks are ready?", "fast"],
    ["why did the payout guard fail?", "fast"],
    ["show my open tasks on toolroll", "fast"],
    ["How is the nightly flow doing", "fast"],
    ["is anything queued?", "fast"],
    // A state asked about stays quick; an act word in its plain form keeps the main model.
    ["why was it cancelled?", "fast"],
    ["what's merged today?", "fast"],
    ["can you fix the payout guard?", "default"],
    ["what should we merge first?", "default"],
    ["file a task for the webhook", "default"],
    ["cancel the nightly?", "default"],
    ["retry the failed one?", "default"],
    ["can you plan tomorrow?", "default"],
    ["please show the queue", "default"],
    ["what's left? also, release it", "default"],
    // Not a question at all, too long, or several lines.
    ["the nightly digest looks great", "default"],
    [`what ${"really ".repeat(40)}needs me?`, "default"],
    ["what's running?\nand what's queued?", "default"],
  ])("%s → %s", (message, expected) => { expect(route(message)).toBe(expected); });

  test("every other condition keeps the main model", () => {
    expect(route("what's running?", { enabled: false })).toBe("default");
    expect(route("what's running?", { provider: "codex-subscription" })).toBe("default");
    expect(route("what's running?", { provider: "anthropic-api" })).toBe("default");
    expect(route("what's running?", { quickAllowed: false })).toBe("default");
    expect(route("what's running?", { hasContext: true })).toBe("default");
    expect(route("what's running?", { hasReplyImage: true })).toBe("default");
    expect(route("what's running?", { askOpen: true })).toBe("default");
    expect(route("what's running?", { mainModel: "claude-sonnet-5-5" })).toBe("default");
  });

  test("a quick reply's tools are registered reads, and anything else escalates", () => {
    const registered = new Set(LEAD_TOOL_SCHEMAS.map(one => one.name));
    for (const name of QUICK_READ_TOOLS) {
      expect(registered.has(name)).toBe(true);
      expect(name).not.toMatch(/^(propose_|offer_|show_|remember|commit_to|ask_owner|release_commitment|refresh_|tidy_)/);
    }
    expect(QUICK_READ_TOOLS.has("find_tools")).toBe(false);
    expect(quickStepEscalates([{ name: "list_tasks" }, { name: "get_task" }])).toBe(false);
    for (const name of ["propose_task", "remember", "commit_to", "ask_owner", "show_card", "show_control", "find_tools", "propose_flow", "not_a_tool"]) {
      expect(quickStepEscalates([{ name: "list_tasks" }, { name }])).toBe(true);
    }
    expect(quickQuestion("")).toBe(false);
    expect(modelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelName("opus")).toBe("Opus");
  });
});

describe("a routed reply", () => {
  let store: Store;
  let who: VerifiedApprover;
  const clock = () => T0;
  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
    const filed = fileTaskProposal(store, { id: "q-1", title: "tighten the payout guard", repo: REPO, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
  });
  afterEach(() => { store.close(); vi.restoreAllMocks(); });

  const session = () => store.getLeadSession(store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: subscriptionCredentialKey("claude-subscription"),
    ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0))!;
  const thread = () => store.openLeadThread("alex", who.ceilingDigest, T0).thread;
  const steps = (turn: number) => store.handle.prepare("SELECT model, tools, failure_detail FROM chat_turn WHERE mate_turn = ? ORDER BY id").all(turn)
    .map(row => ({ model: row["model"], tools: row["tools"] === null ? null : JSON.parse(String(row["tools"])), detail: row["failure_detail"] }));
  const turnRow = (turn: number) => store.getLeadTurn(turn)!;

  test("switch off (the default): the main model answers with every tool, the route says so, and each step saves its tool names", async () => {
    expect(leadQuickAnswersOn(store)).toBe(false);
    const seen: SubscriptionLeadRequest[] = [];
    const runner: SubscriptionLeadRunner = async request => { seen.push(request); return seen.length === 1 ? replied("Looking.", [{ id: "a", name: "list_tasks", args: {} }, { id: "b", name: "recap", args: {} }]) : replied("One task is waiting."); };
    const outcome = await runLeadTurn({ store, who, session: session(), thread: thread(), config: CONFIG, key: null, message: "what's running?", subscriptionRunner: runner, clock });
    if (!outcome.ok || outcome.replayed) throw new Error("no answer");
    expect(seen.map(one => one.model)).toEqual(["opus", "opus"]);
    expect(seen[0]!.tools.some(one => one.name === "propose_task")).toBe(true);
    expect(turnRow(outcome.turn).route).toBe("default");
    expect(steps(outcome.turn)).toEqual([{ model: "opus", tools: ["list_tasks", "recap"], detail: null }, { model: "opus", tools: [], detail: null }]);
    expect(outcome.activity).not.toMatch(/answered by|moved to/);
  });

  test("switch on, a read question: the faster model answers with reads only, and the reply says which model answered", async () => {
    setLeadQuickAnswers(store, true, "alex", T0);
    const quick = quickLeadModel(store);
    const seen: SubscriptionLeadRequest[] = [];
    const runner: SubscriptionLeadRunner = async request => { seen.push(request); return seen.length === 1 ? replied("Looking.", [{ id: "a", name: "list_tasks", args: {} }]) : replied("One task is waiting."); };
    const outcome = await runLeadTurn({ store, who, session: session(), thread: thread(), config: CONFIG, key: null, message: "what's running?", subscriptionRunner: runner, clock });
    if (!outcome.ok || outcome.replayed) throw new Error("no answer");
    expect(seen.map(one => one.model)).toEqual([quick, quick]);
    for (const request of seen) for (const tool of request.tools) expect(QUICK_READ_TOOLS.has(tool.name) || tool.name === "find_tools").toBe(true);
    expect(seen[0]!.tools.some(one => one.name === "find_tools")).toBe(true);
    expect(turnRow(outcome.turn).route).toBe("fast");
    expect(steps(outcome.turn).map(one => one.model)).toEqual([quick, quick]);
    expect(outcome.activity).toContain(`answered by ${modelName(quick)}`);
  });

  test("a quick step that asks to change something: its calls are discarded unrun and the main model takes the reply over", async () => {
    setLeadQuickAnswers(store, true, "alex", T0);
    const quick = quickLeadModel(store);
    const seen: SubscriptionLeadRequest[] = [];
    const events: LeadProgress[] = [];
    const runner: SubscriptionLeadRunner = async request => {
      seen.push(request);
      if (seen.length === 1) return replied("I'll file it.", [{ id: "r", name: "list_tasks", args: {} }, { id: "p", name: "propose_task", args: { repo: "repo-1", title: "x", goal: "y" } }]);
      return replied("Nothing to change.");
    };
    const outcome = await runLeadTurn({ store, who, session: session(), thread: thread(), config: CONFIG, key: null, message: "what's running?", subscriptionRunner: runner, clock, onProgress: event => events.push(event) });
    if (!outcome.ok || outcome.replayed) throw new Error("no answer");
    expect(seen.map(one => one.model)).toEqual([quick, "opus"]);
    // The discarded step left nothing behind: no proposal, no tool step shown, and the next request's history never saw its calls.
    expect(outcome.proposals).toBe(0);
    expect(store.listLeadProposals(store.getLeadTurn(outcome.turn)!.thread)).toEqual([]);
    expect(events.some(one => one.kind === "tool")).toBe(false);
    expect(seen[1]!.history.some(one => one.role !== "operator")).toBe(false);
    expect(seen[1]!.tools.some(one => one.name === "propose_task")).toBe(true);
    expect(turnRow(outcome.turn).route).toBe("escalated");
    expect(steps(outcome.turn)).toEqual([{ model: quick, tools: ["list_tasks", "propose_task"], detail: null }, { model: "opus", tools: [], detail: null }]);
    expect(outcome.activity).toContain("moved to Opus");
  });

  test("context, an open question, or a policy that refuses the faster model keep the main model", async () => {
    setLeadQuickAnswers(store, true, "alex", T0);
    const models: string[] = [];
    const runner: SubscriptionLeadRunner = async request => { models.push(request.model); return replied("Fine."); };
    const withContext = await runLeadTurn({ store, who, session: session(), thread: thread(), config: CONFIG, key: null, message: "what's running?", context: "Task q-1 is open on this page.", subscriptionRunner: runner, clock });
    if (!withContext.ok || withContext.replayed) throw new Error("no answer");
    expect(turnRow(withContext.turn).route).toBe("default");

    // The thread's newest reply asked a question: the next message may be its answer.
    const asked = thread();
    const asking = await runLeadTurn({ store, who, session: session(), thread: asked, config: CONFIG, key: null, message: "file the webhook task", clock,
      subscriptionRunner: async request => request.history.some(one => one.role === "tool") ? replied("Which project?") : replied("Asking.", [{ id: "q", name: "ask_owner", args: { question: "Which project?", options: ["quick", "other"] } }]) });
    if (!asking.ok || asking.replayed) throw new Error("no answer");
    expect(store.leadAsk(asking.turn)).not.toBeNull();
    const answer = await runLeadTurn({ store, who, session: session(), thread: asked, config: CONFIG, key: null, message: "which one is quicker?", subscriptionRunner: runner, clock });
    if (!answer.ok || answer.replayed) throw new Error("no answer");
    expect(turnRow(answer.turn).route).toBe("default");

    const quick = quickLeadModel(store);
    vi.spyOn(store, "agentPolicyRefusal").mockImplementation((_provider, model) => model === quick ? "not allowed" : null);
    const refused = await runLeadTurn({ store, who, session: session(), thread: thread(), config: CONFIG, key: null, message: "what's running?", subscriptionRunner: runner, clock });
    if (!refused.ok || refused.replayed) throw new Error("no answer");
    expect(turnRow(refused.turn).route).toBe("default");
    expect(models.every(one => one === "opus")).toBe(true);
  });
});

describe("a failed reply saves its exact cause (v158)", () => {
  let store: Store;
  let who: VerifiedApprover;
  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO]);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
  });
  afterEach(() => store.close());
  const fails = async (problem: { ok: false; problem: string; quiet?: boolean }) => {
    const session = store.getLeadSession(store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: subscriptionCredentialKey("claude-subscription"),
      ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0))!;
    const outcome = await runLeadTurn({ store, who, session, thread: store.openLeadThread("alex", who.ceilingDigest, T0).thread, config: CONFIG, key: null, message: "what's running?", subscriptionRunner: async () => problem, clock: () => T0 });
    if (outcome.ok || !("turn" in outcome)) throw new Error("expected a failed turn");
    const turn = store.getLeadTurn(outcome.turn)!;
    const step = store.handle.prepare("SELECT failure_detail FROM chat_turn WHERE mate_turn = ?").get(outcome.turn)!;
    return { turn, live: outcome.message, step: step["failure_detail"] };
  };

  test.each([
    [{ ok: false as const, problem: "not-found" }, "provider-error", "not-installed", LEAD_FAILURE_COPY.notInstalled],
    [{ ok: false as const, problem: "status-1" }, "provider-error", "sign-in", LEAD_FAILURE_COPY.signIn],
    [{ ok: false as const, problem: "malformed-reply" }, "malformed-reply", null, LEAD_FAILURE_COPY.unreadable],
    [{ ok: false as const, problem: "timeout", quiet: true }, "timeout", "timeout-silent", LEAD_FAILURE_COPY.tooLong],
    [{ ok: false as const, problem: "timeout", quiet: false }, "timeout", "timeout-output", LEAD_FAILURE_COPY.tooLong],
    [{ ok: false as const, problem: "timeout" }, "timeout", null, LEAD_FAILURE_COPY.tooLong],
  ])("%j → %s / %s", async (problem, reason, detail, words) => {
    const { turn, step } = await fails(problem);
    expect(turn.failureReason).toBe(reason);
    expect(turn.failureDetail).toBe(detail);
    expect(step).toBe(detail);
    // What a page reads back after a restart is the same words the person saw live.
    expect(leadFailureText(turn.failureReason, false, turn.failureDetail ?? null)).toBe(words);
  });

  test("a turn saved before v158 (no detail) reads as it did", () => {
    expect(leadFailureText("provider-error")).toBe(LEAD_FAILURE_COPY.refused);
    expect(leadFailureText("provider-error", false, null)).toBe(LEAD_FAILURE_COPY.refused);
  });
});

describe("toolroll config set|clear|show quick-answers (the Settings switch's twin)", () => {
  test("an instance operator turns it on and off with their password; a wrong one changes nothing", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runOperate, EXIT } = await import("./operate.js");
    const base = mkdtempSync(join(tmpdir(), "toolroll-quick-"));
    const db = join(base, "orders.db");
    let lines: string[] = [];
    const run = (argv: string[]) => { lines = []; const [command = "", ...rest] = argv; return runOperate(command, rest, line => lines.push(line), { databaseFile: db }); };
    const payload = () => JSON.parse(lines.slice(lines.findLastIndex(line => line.startsWith("{"))).join("\n"));
    try {
      expect(await run(["approver", "add", "alex", "--json"])).toBe(EXIT.ok);
      const token = payload().token as string;
      expect(await run(["config", "show", "quick-answers", "--json"])).toBe(EXIT.ok);
      expect(payload().quickAnswers.on).toBe(false);
      expect(await run(["config", "set", "quick-answers", "--as", "alex", "--token", "wrong", "--json"])).toBe(EXIT.refused);
      expect(await run(["config", "set", "quick-answers", "--as", "alex", "--token", token, "--json"])).toBe(EXIT.ok);
      expect(payload().quickAnswers).toMatchObject({ on: true });
      const store = openStore(db);
      expect(leadQuickAnswersOn(store)).toBe(true);
      store.close();
      expect(await run(["config", "clear", "quick-answers", "--as", "alex", "--token", token, "--json"])).toBe(EXIT.ok);
      expect(payload().quickAnswers.on).toBe(false);
      expect(await run(["config", "set", "quick-answers", "--repo", base, "--as", "alex", "--token", token, "--json"])).toBe(EXIT.usage);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
