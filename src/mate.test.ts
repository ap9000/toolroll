import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mateTimeoutNotice, openStore, type ChatConfig, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { propose } from "./scope.js";
import { ceilingDigestOf, isVerifiedApprover, reproveApprover, verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { MATE_MAX_STEPS, MATE_STEP_TEXT_CAP_BYTES, TURN_WALL_CLOCK_MS, MATE_TOOL_CALL_CAP_BYTES, MATE_TOOL_RESULT_CAP_BYTES, MAX_OUTPUT_TOKENS, credentialKeyOf, mateWorstCaseForPrice, parseMateProviderWrapper, subscriptionCredentialKey } from "./converse.js";
import { runMateTurn, historyFor, MATE_ABORT_GRACE_MS, MATE_CHANNEL_COPY, MATE_FAILURE_COPY, MATE_REFUSAL_COPY } from "./mate.js";
import { NOTHING_ATTACHED, deliverableClaim } from "./reply-shape.js";
import { MATE_MAX_PROPOSALS_PER_TURN, MATE_TOOLS, executeMateTool, redactForMate } from "./mate-tools.js";
import { TEXT_LIMITS } from "./text-limits.js";
import { MATE_CONTRACT, MATE_CONTRACT_VERSION } from "./mate-contract.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-09-02T12:00:00.000Z");
const INSIDE = "/repo/inside-PATH-CANARY";
const OTHER = "/repo/other-PATH-CANARY";
const OUTSIDE = "/repo/outside-SECRET-PATH";
const KEY = "sk-ant-test-key";
const CREDENTIAL = credentialKeyOf("anthropic-api", KEY);
const CONFIG: ChatConfig = {
  provider: "anthropic-api",
  model: "claude-sonnet-5",
  dailyTurns: 50,
  weeklyCeilingMicrousd: 25_000_000,
  priceInMicrousd: 3,
  priceOutMicrousd: 15,
  updatedAt: T0.toISOString(),
  updatedBy: "alex",
};
const PRICE = { inMicrousd: 3, outMicrousd: 15 };
const PER_STEP = 100 * PRICE.inMicrousd + 20 * PRICE.outMicrousd;

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = (blocks: Block[], usage: unknown = { input_tokens: 100, output_tokens: 20 }) => json({ type: "message", content: blocks, usage });
const text = (value: string) => answer([{ type: "text", text: value }]);
const call = (name: string, input: Record<string, unknown> = {}, id = `${name}-${Math.random().toString(36).slice(2, 8)}`): Block => ({ type: "tool_use", id, name, input });

/** A scripted provider: each request pops the next response; every outbound body is kept for the canary. */
function scripted(responses: (Response | (() => Response))[]) {
  const bodies: string[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const next = responses.shift();
    if (next === undefined) throw new Error("the script ran out of responses");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

describe("the mate's turn", () => {
  let store: Store;
  let who: VerifiedApprover;
  let clockAt = T0.getTime();
  const clock = () => new Date(clockAt);

  const principal = (name: string, repos: string[]): VerifiedApprover => {
    const generation = store.accountOf(name)?.generation ?? -1;
    const verified = verifyApproverStanding(store, name, generation, repos);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    clockAt = T0.getTime();
    store.saveApprover("root", "r".repeat(64), T0);
    store.saveApprover("alex", "h".repeat(64), T0);
    who = principal("alex", [INSIDE, OTHER]);
    const mk = (id: string, repo: string, title: string) => {
      const filed = fileTaskProposal(store, { id, title, repo, filedVia: "cli" }, T0);
      if (!filed.ok) throw new Error(filed.reason);
    };
    mk("in-1", INSIDE, "tighten the payout guard");
    mk("in-2", INSIDE, "rotate the webhook secret");
    mk("in-3", INSIDE, `see ${INSIDE}/notes by alex, digest ${"d".repeat(64)}`);
    mk("other-1", OTHER, "wire the nightly digest");
    mk("out-1", OUTSIDE, "the confidential acquisition plan");
    const run = store.startRun({ taskRef: store.refFor("built-in", "in-1").id, leaseId: "l-in", runner: "runner-1", branch: "standing-orders/in-1", worktree: "/pool/in-1", ...bareLegacy("build", "claude", null), now: T0 });
    store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "RECAP-CANARY must never reach the model",
        question: "Fail open or closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "CONSEQUENCE-CANARY", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "CONSEQUENCE-CANARY-2", reversible: false },
        ],
        recommendation: "closed",
      },
      T0,
    );
  });

  afterEach(() => store.close());

  // Successful fixture sessions allow the current worst-case tool envelope; explicit exhaustion cases keep their exact caps.
  const session = (ceilingMicrousd = 10_000_000, approver = "alex", credentialKey = CREDENTIAL) => {
    const id = store.mintMateSession(
      { approver, approverGeneration: who.generation, credentialKey, ceilingMicrousd, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) },
      clock(),
    );
    const row = store.getMateSession(id);
    if (row === null) throw new Error("no session");
    return row;
  };
  const thread = (approver = "alex") => store.openMateThread(approver, who.ceilingDigest, clock()).thread;
  const turn = (message: string, fetcher: typeof fetch, overrides: Partial<Parameters<typeof runMateTurn>[0]> = {}) =>
    runMateTurn({
      store,
      who,
      session: overrides.session ?? session(),
      thread: overrides.thread ?? thread(),
      config: CONFIG,
      key: KEY,
      message,
      fetcher,
      clock,
      ...overrides,
    });

  test("the intake contract treats one outcome as enough and asks only material questions", () => {
    expect(MATE_CONTRACT_VERSION).toBe(47);
    expect(MATE_CONTRACT).toContain("Ready is a saved result, not a reviewer stage");
    expect(MATE_CONTRACT).toContain("Historical missing assessments never require rerunning work");
    expect(MATE_CONTRACT).toContain("call get_result_images for that exact execution and run");
    expect(MATE_CONTRACT).toContain("say they follow, never that they were delivered");
    expect(MATE_CONTRACT).toContain("call it again with that offset or with the image ids it listed");
    expect(MATE_CONTRACT).toContain("read get_agents and answer in its words");
    expect(MATE_CONTRACT).toContain("never an agent that is not listed");
    expect(MATE_CONTRACT).toContain("a plain-language outcome is enough to draft a task");
    expect(MATE_CONTRACT).toContain("at most three questions");
    expect(MATE_CONTRACT).toContain("Do not ask the operator for a title, paths, implementation details, acceptance wording, model, budget");
    expect(MATE_CONTRACT).toContain("use your judgment");
    expect(MATE_CONTRACT).toContain("Set propose_task planning to 'required'");
    expect(MATE_CONTRACT).toContain("call commit_to in the same turn");
    expect(MATE_CONTRACT).toContain("call remember at once");
  });

  test("the organisation policy stops a chat on a provider or model it doesn't allow, before anything is admitted or sent", async () => {
    const neverSent = (async () => { throw new Error("a refused turn sends nothing"); }) as unknown as typeof fetch;
    store.setOrgPolicy({ providers: ["codex"], models: null, tools: null, ceiling: "escalated" }, "root", T0);
    expect(await turn("what needs me?", neverSent)).toEqual({ ok: false, refused: "policy", message: "The organisation policy doesn't allow Claude. An instance operator can change it in Settings → Policy." });
    store.setOrgPolicy({ providers: null, models: ["claude-opus-*"], tools: null, ceiling: "escalated" }, "root", T0);
    expect(await turn("what needs me?", neverSent)).toMatchObject({ ok: false, refused: "policy", message: expect.stringContaining("doesn't allow the model claude-sonnet-5") });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM mate_turn").get()).toEqual({ n: 0 });
  });

  test("saved context fits the existing allowance by bounding steps, without increasing spend authority", async () => {
    const live = session(5_000_000), script = scripted(Array.from({ length: 8 }, (_, i) => answer([{ type: "tool_use", id: `r${i}`, name: "list_repos", input: {} }])));
    const result = await turn("Catch me up", script.fetcher, { session: live, context: "Saved project context. ".repeat(500) });
    expect(result).toMatchObject({ ok: true, stoppedAtCap: true });
    if (!result.ok) throw Error("turn refused");
    expect(result.steps).toBeLessThan(8);
    expect(result.reply).toContain("remaining spending allows");
    expect(store.getMateSession(live.id)!.ceilingMicrousd).toBe(5_000_000);
    expect(store.getMateTurn(result.turn)!.reservedMicrousd).toBeLessThanOrEqual(5_000_000);
  });

  test("task intake records an explicit planning choice and defaults it to auto", () => {
    const drafted: Record<string, unknown>[] = [];
    const ctx = {
      store,
      who,
      now: clock(),
      draft: (_kind: "task", payload: Record<string, unknown>) => {
        drafted.push(payload);
        return drafted.length;
      },
      step: 1,
      readDecisions: new Map<number, number>(),
    };
    const base = {
      repo: "r1",
      title: "Make project intake conversational",
      goal: "Let a person describe the outcome once and infer routine task details.",
      acceptance: [{ id: "c1", statement: "A plain-language request produces a reviewable task proposal.", evidence: ["manual-review"] }],
    };
    expect(executeMateTool(ctx, "propose_task", { ...base, planning: "required" })).toMatchObject({
      ok: true,
      body: { planning: "required" },
    });
    expect(drafted[0]).toMatchObject({ planning: "required", touches: [], not: null });
    expect(executeMateTool(ctx, "propose_task", base)).toMatchObject({ ok: true, body: { planning: "auto" } });
    expect(drafted[1]).toMatchObject({ planning: "auto" });
    expect(executeMateTool(ctx, "propose_task", { ...base, planning: "sometimes" })).toMatchObject({
      ok: false,
      message: 'planning: must be one of "auto", "required", "skip"',
    });
  });

  test("a loop: two tool steps, then text — steps ledgered, session debited, only text kept", async () => {
    const script = scripted([
      answer([{ type: "text", text: "Let me look." }, call("recap"), call("list_tasks", { repo: "r1" })]),
      answer([call("get_task", { task: "in-1" })]),
      text("One decision waits on you in r1 (task in-1). Two tasks are queued there."),
    ]);
    const live = session();
    const outcome = await turn("how do things stand?", script.fetcher, { session: live });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, steps: 3, proposals: 0, stoppedAtCap: false, activity: "read 3 · proposed 0 · 3 steps" });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.settledMicrousd).toBe(3 * PER_STEP);
    expect(store.getMateTurn(outcome.turn)).toMatchObject({ state: "answered", steps: 3, settledMicrousd: 3 * PER_STEP, tokensIn: 300, tokensOut: 60 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(3 * PER_STEP);
    // The weekly ledger sees the mate's settled turn once, not its zero-reserved steps twice.
    expect(store.chatWeeklySpendMicrousd(CREDENTIAL, clock())).toBe(3 * PER_STEP);
    // Ruling 11: the thread holds operator text and assistant text only.
    const messages = store.listMateMessages(thread().id, 10);
    expect(messages.map(one => one.role)).toEqual(["operator", "assistant"]);
    expect(messages[1]?.activity).toBe("read 3 · proposed 0 · 3 steps");
    expect(JSON.stringify(messages)).not.toContain("tighten the payout guard");
    expect(script.bodies[1]).toContain("tool_result");
    expect(script.bodies[1]).toContain("\"queued\"");
    // The key rides in the header, never the body.
    expect(script.bodies[0]).not.toContain(KEY);
  });

  test("server-authored task context reaches the model without cluttering the visible conversation", async () => {
    const script = scripted([text("I will focus on that task.")]);
    const outcome = await turn("what should happen next?", script.fetcher, {
      context: "Current task: in-2. Read it with get_task before proposing changes.",
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(script.bodies[0]).toContain("Current task: in-2");
    expect(script.bodies[0]).toContain("what should happen next?");
    expect(store.listMateMessages(thread().id, 10).map(one => one.text)).toEqual([
      "what should happen next?",
      "I will focus on that task.",
    ]);
  });

  test("a conversation remains live across days until it is explicitly ended", async () => {
    const live = session();
    const first = scripted([text("I will remember that.")]);
    expect(await turn("remember the alpha launch", first.fetcher, { session: live })).toMatchObject({ ok: true });
    clockAt += 30 * 24 * 3_600_000;
    const later = scripted([text("Still here.")]);
    const outcome = await turn("pick up where we left off", later.fetcher, { session: live });
    expect(outcome).toMatchObject({ ok: true, reply: "Still here." });
    expect(store.activeMateSession("alex")?.id).toBe(live.id);
    expect(later.bodies[0]).toContain("remember the alpha launch");
  });

  test("a membership-backed turn needs no API key or dollar ceiling, but keeps the tool loop and daily ledger", async () => {
    const config: ChatConfig = {
      ...CONFIG,
      provider: "codex-subscription",
      model: "default",
      weeklyCeilingMicrousd: 0,
      priceInMicrousd: 0,
      priceOutMicrousd: 0,
    };
    const credential = subscriptionCredentialKey("codex-subscription");
    const live = session(0, "alex", credential);
    const requests: Parameters<SubscriptionMateRunner>[0][] = [];
    const subscriptionRunner: SubscriptionMateRunner = async request => {
      requests.push(request);
      return requests.length === 1
        ? { ok: true, answer: { text: "I will look.", calls: [{ id: "r1", name: "recap", args: {} }], tokensIn: 100, tokensOut: 20, reportedCostMicrousd: null } }
        : { ok: true, answer: { text: "One decision needs you.", calls: [], tokensIn: 90, tokensOut: 12, reportedCostMicrousd: null } };
    };
    const outcome = await runMateTurn({ store, who, session: live, thread: thread(), config, key: null, message: "what needs me?", subscriptionRunner, clock });
    expect(outcome).toMatchObject({ ok: true, reply: "One decision needs you.", steps: 2, settledMicrousd: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.history.some(message => message.role === "tool")).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(store.getMateTurn(outcome.turn)).toMatchObject({ state: "answered", reservedMicrousd: 0, settledMicrousd: 0, tokensIn: 190, tokensOut: 32 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(0);
    expect(store.chatWeeklySpendMicrousd(credential, clock())).toBe(0);
    expect(store.raw().prepare("SELECT provider FROM chat_turn WHERE mate_turn = ? ORDER BY id").all(outcome.turn).map(row => row["provider"])).toEqual(["codex-subscription", "codex-subscription"]);
    expect(store.latchedChatTurns(credential)).toEqual([]);
    expect(store.chatTurnsToday("alex", clock())).toBe(1);
  });
  test("a watched turn reports its steps, its tools in plain words and its reply as it is written", async () => {
    const config: ChatConfig = { ...CONFIG, provider: "claude-subscription", model: "default", weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 };
    const live = session(0, "alex", subscriptionCredentialKey("claude-subscription"));
    const events: import("./mate-progress.js").MateProgress[] = [];
    let step = 0;
    const subscriptionRunner: SubscriptionMateRunner = async request => {
      step++;
      if (step === 1) {
        request.onText?.("Let me look.");
        return { ok: true, answer: { text: "Let me look.", calls: [{ id: "r1", name: "recap", args: {} }], tokensIn: 10, tokensOut: 2, reportedCostMicrousd: null } };
      }
      request.onText?.("One decision");
      request.onText?.("sk-ant-api03-" + "A".repeat(90));
      request.onText?.("One decision needs you.");
      return { ok: true, answer: { text: "One decision needs you.", calls: [], tokensIn: 10, tokensOut: 4, reportedCostMicrousd: null } };
    };
    const outcome = await runMateTurn({ store, who, session: live, thread: thread(), config, key: null, message: "what needs me?", subscriptionRunner, clock, onProgress: event => events.push(event) });
    expect(outcome).toMatchObject({ ok: true, reply: "One decision needs you." });
    if (!outcome.ok) throw new Error("unreachable");
    expect(events.map(event => event.kind === "tool" ? `tool:${event.label}` : event.kind === "text" ? `text:${event.step}:${event.text}` : event.kind === "step" ? `step:${event.step}` : event.kind)).toEqual([
      "started", "step:1", "text:1:Let me look.", "tool:Recapping", "step:2", "text:2:One decision", "text:2:One decision needs you.",
    ]);
    expect(events.every(event => event.turn === outcome.turn)).toBe(true);
  });

  test('project knowledge reads are counted without granting a write tool',async()=>{
    const script=scripted([answer([call('get_project_knowledge',{repo:'r1'})]),text('Project knowledge is unavailable; no changes made.')]);
    const outcome=await turn('Read project knowledge',script.fetcher);
    expect(outcome).toMatchObject({ok:true,activity:expect.stringContaining('read 1'),proposals:0});
    expect(script.bodies[0]).toContain('get_project_knowledge');expect(script.bodies[0]).not.toContain('save_project_knowledge');
  });

  test("a turn refuses a task proposed before get_capabilities ran in an earlier step, and drafts it once it has", async () => {
    const task = { repo: "r1", title: "a new one", goal: "do the thing", acceptance: [{ id: "c1", statement: "the thing is done", evidence: ["manual-review"] }] };
    const script = scripted([
      answer([call("propose_task", task)]),
      answer([call("get_capabilities", { repo: "r1" })]),
      answer([call("propose_task", task)]),
      text("drafted"),
    ]);
    const outcome = await turn("add the thing", script.fetcher);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, proposals: 1 });
    expect(script.bodies[1]).toContain("Read get_capabilities first");
  });

  test("canary: only admitted project display metadata names basenames; paths, accounts and free text stay scrubbed", async () => {
    store.hold(store.refFor("built-in", "in-3").id, `blocked on ${OTHER} per alex`, null, T0);
    const script = scripted([
      answer([call("recap"), call("list_repos"), call("list_decisions"), call("queue", { repo: "r1" })]),
      answer([call("get_capabilities", { repo: "r2" })]),
      answer([call("get_task", { task: "in-3" }), call("list_tasks", {}), call("propose_next", { task: "in-2" }), call("propose_task", { repo: "r2", title: "a new one", goal: "do the thing", touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "the thing is done", evidence: ["manual-review"] }] })]),
      text("done looking"),
    ]);
    const outcome = await turn("look at everything", script.fetcher);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, proposals: 2 });
    const sent = script.bodies.join("\n");
    for (const canary of [INSIDE, OTHER, OUTSIDE, "alex", "RECAP-CANARY", "CONSEQUENCE-CANARY", "confidential acquisition", who.ceilingDigest, "d".repeat(64)]) {
      expect(sent).not.toContain(canary);
    }
    // A basename may appear only in the exact list_repos display metadata,
    // never by exempting a title, hold reason or arbitrary tool string.
    const withoutLabels = sent.replaceAll('\\"name\\":\\"inside-PATH-CANARY\\"', '').replaceAll('\\"name\\":\\"other-PATH-CANARY\\"', '');
    expect(withoutLabels).not.toContain("PATH-CANARY");
    expect(sent).not.toMatch(/[0-9a-f]{32}/);
    // The redactions are visible where the text was — the title and the hold reason.
    expect(sent).toContain("[path]");
    expect(sent).toContain("[approver]");
    expect(sent).toContain("[digest]");
    // The task outside the ceiling is unreachable even by id.
    const outside = executeMateTool({ store, who, now: clock(), draft: () => null, step: 1, readDecisions: new Map() }, "get_task", { task: "out-1" });
    expect(outside).toMatchObject({ ok: false, message: expect.stringContaining("not-found") });
  });

  test("project lookup gives names without exposing paths, sensitive labels or unadmitted projects", () => {
    const projects = ["/private/standing-orders", "C:\\private\\job-scraper", "/private/alex", "/private/" + "a".repeat(64), "/private/<script>bad</script>", "/private/" + "AKIA" + "ABCDEFGHIJKLMNOP", "/private/" + "x".repeat(81)];
    const admitted = principal("alex", projects);
    const ctx = { store, who: admitted, now: clock(), draft: () => null, step: 1, readDecisions: new Map<number, number>() };
    const result = executeMateTool(ctx, "list_repos", {});
    expect(result).toEqual({ ok: true, body: { repos: [
      { repo: "r1", name: "standing-orders" }, { repo: "r2", name: "job-scraper" },
      ...[3, 4, 5, 6, 7].map(index => ({ repo: `r${index}`, name: `Project ${index}` })),
    ] } });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain(OUTSIDE);
    expect(executeMateTool(ctx, "list_tasks", { repo: "r8" })).toMatchObject({ ok: false });
  });

  test("redactForMate scrubs paths, basenames, digests, and names but leaves relative paths and ids", () => {
    const view = { repos: [INSIDE], names: ["alex", "root"] };
    expect(redactForMate(`edit ${INSIDE}/src/a.ts and src/b.ts for alex (Alex) in inside-PATH-CANARY`, view)).toBe("edit [path]/src/a.ts and src/b.ts for [approver] ([approver]) in [path]");
    expect(redactForMate(`digest ${"a".repeat(32)} and task in-1 at /Users/someone/private`, view)).toBe("digest [digest] and task in-1 at [path]");
    expect(redactForMate("alexander is not alex", view)).toBe("alexander is not [approver]");
  });

  test("proposals draft under the turn and go pending only when it answers, carrying their CAS material", async () => {
    store.hold(store.refFor("built-in", "in-2").id, "wait for the key rotation", null, T0);
    const script = scripted([
      answer([call("propose_next", { task: "in-2" }), call("propose_unhold", { task: "in-2" }), call("propose_hold", { task: "other-1", reason: "not this week" }), call("propose_reserve", { task: "in-2", worker: null })]),
      () => {
        // Mid-turn: every row is still `drafting` — inert.
        expect(store.listMateProposals(thread().id).map(one => one.state)).toEqual(["drafting", "drafting", "drafting"]);
        return text("I propose three things; confirm the ones you want.");
      },
    ]);
    const outcome = await turn("tidy the queue", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: 3, activity: "read 0 · proposed 3 · 2 steps" });
    // The fourth call was refused (already in the shared column) and drafted nothing.
    expect(script.bodies[1]).toContain("already in that column");
    const rows = store.listMateProposals(thread().id, ["pending"]);
    expect(rows.map(one => one.kind)).toEqual(["next", "unhold", "hold"]);
    expect(rows[0]?.payload).toMatchObject({ task: "in-2", repoId: "r1", queueRevision: store.queueRevision(), position: 2, of: 3, column: null });
    expect(rows[1]?.payload).toMatchObject({ task: "in-2", holdId: expect.any(Number) });
    expect(rows[2]?.payload).toMatchObject({ task: "other-1", repoId: "r2", reason: "not this week", sawHold: null });
    expect(rows.every(one => one.ceilingDigest === who.ceilingDigest)).toBe(true);
    // A hold proposed over an existing operator hold carries that hold's id.
    const seen = executeMateTool({ store, who, now: clock(), draft: (_kind, payload) => (payload["sawHold"] === rows[1]?.payload["holdId"] ? 99 : null), step: 1, readDecisions: new Map() }, "propose_hold", { task: "in-2", reason: "again" });
    expect(seen).toMatchObject({ ok: true, body: { proposal: 99 } });
  });

  test("a malformed call is read by the tool's schema: the next step is told each path, and the corrected call drafts", async () => {
    const script = scripted([
      answer([call("propose_hold", { task: "in-1", why: "not this week" }, "bad")]),
      answer([call("propose_hold", { task: "in-1", reason: "not this week" }, "good")]),
      text("Held."),
    ]);
    const outcome = await turn("hold in-1", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: 1 });
    // Unknown lead keys are ignored; the repair still names the required field the call left out.
    expect(script.bodies[1]).toContain("reason: required");
    expect(script.bodies[1]).not.toContain("unknown key");
    expect(store.listMateProposals(thread().id, ["pending"]).map(one => one.payload["reason"])).toEqual(["not this week"]);
  });

  test("a turn holds at most five proposals; the sixth is a typed refusal to the model", async () => {
    const holds = Array.from({ length: 6 }, (_, index) => call("propose_hold", { task: index % 2 === 0 ? "in-1" : "in-2", reason: `reason ${index}` }, `h${index}`));
    const script = scripted([answer(holds.slice(0, 4)), answer(holds.slice(4)), text("proposed what I could")]);
    const outcome = await turn("hold everything", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: MATE_MAX_PROPOSALS_PER_TURN });
    expect(script.bodies[2]).toContain(`already holds ${MATE_MAX_PROPOSALS_PER_TURN} proposals`);
    expect(store.listMateProposals(thread().id, ["pending"])).toHaveLength(MATE_MAX_PROPOSALS_PER_TURN);
  });

  test("chat task and scope rubrics enforce UTF-8 byte limits before drafting", () => {
    // The rubric is lead-tools' `acceptance` (the plan's criterion); its byte limits run after parsing, before a draft.
    const draft = vi.fn(() => 1);
    const ctx = { store, who, now: clock(), draft };
    const base = { repo: "r1", task: "in-1", title: "Task", goal: "valid" };
    const criterion = { id: "c1", statement: "Works", how: null, evidence: ["check"] };
    for (const tool of ["propose_task", "propose_scope"]) {
      for (const [field, limit] of [["id", TEXT_LIMITS.acceptanceIdBytes], ["statement", TEXT_LIMITS.acceptanceStatementBytes], ["how", TEXT_LIMITS.acceptanceHowBytes]] as const) {
        draft.mockClear();
        const atLimit = { ...criterion, [field]: "é".repeat(limit / 2) };
        expect(executeMateTool(ctx, tool, { ...base, acceptance: [atLimit] })).toMatchObject({ ok: true });
        expect(draft).toHaveBeenCalledExactlyOnceWith(tool === "propose_task" ? "task" : "scope", expect.objectContaining({ acceptance: [atLimit] }));
        draft.mockClear();
        const overLimit = { ...atLimit, [field]: atLimit[field]! + "é" };
        expect(executeMateTool(ctx, tool, { ...base, acceptance: [overLimit] })).toMatchObject({ ok: false });
        expect(draft).not.toHaveBeenCalled();
      }
    }
  });

  test("chat task and scope tools share new-text limits and expose no inheritance option", () => {
    let drafts = 0;
    const ctx = { store, who, now: clock(), draft: () => ++drafts };
    const shared = { goal: "valid", acceptance: [{ id: "c1", statement: "Works", evidence: ["check"] }] };
    for (const tool of ["propose_task", "propose_scope"]) {
      // Each tool ignores keys outside its own arguments, as the older handlers did.
      const base = tool === "propose_task" ? { repo: "r1", title: "Task", ...shared } : { task: "in-1", ...shared };
      const before = drafts;
      expect(executeMateTool(ctx, tool, { ...base, ...(tool === "propose_task" ? { task: "in-1" } : { repo: "r1" }) })).toMatchObject({ ok: true });
      for (const field of ["goal", "not"]) {
        for (const value of ["a".repeat(8001), "😀".repeat(4001), "界".repeat(8001), "bad\u0000", "bad\u202e", "ok\r"]) {
          expect(executeMateTool(ctx, tool, { ...base, [field]: value })).toMatchObject({ ok: false, message: expect.stringMatching(/over 8,000 characters|the limit is 8,000|control or hidden/) });
          expect(executeMateTool(ctx, tool, { ...base, [field]: value, inheritLegacy: true, filedVia: "revision" })).toMatchObject({ ok: false });
        }
      }
      expect(drafts).toBe(before + 1);
      expect(executeMateTool(ctx, tool, { ...base, goal: "😀".repeat(4000), not: "界".repeat(8000) })).toMatchObject({ ok: true });
    }
  });

  test("lead list limits keep the 0.9.36 clamp, floor and fallback behavior", () => {
    const ctx = { store, who, now: clock(), draft: () => null, step: 1, readDecisions: new Map() };
    for (let i = 0; i < 55; i++) expect(fileTaskProposal(store, { id: `page-${i}`, title: `Page ${i}`, repo: INSIDE, filedVia: "cli" }, T0).ok).toBe(true);
    const taskThread = store.openMateThread(who.name, who.ceilingDigest, T0, { kind: "task", key: "in-1" }).thread;
    for (let i = 0; i < 35; i++) store.appendMateMessage({ thread: taskThread.id, turn: null, role: "operator", text: `Message ${i}` }, new Date(T0.getTime() + i));
    for (const [limit, tasks, messages] of [
      [undefined, 20, 12], [0, 1, 1], [-5, 1, 1], [100, 50, 30], [2.9, 2, 12],
      [null, 20, 12], ["3", 20, 12], [{}, 20, 12], [Number.MAX_SAFE_INTEGER + 1, 50, 12],
    ] as const) {
      const listed = executeMateTool(ctx, "list_tasks", { limit, zz_unknown: true });
      const conversation = executeMateTool(ctx, "get_task_conversation", { task: "in-1", limit, zz_unknown: true });
      expect(listed.ok, `list_tasks limit ${JSON.stringify(limit)}`).toBe(true);
      expect(conversation.ok, `get_task_conversation limit ${JSON.stringify(limit)}`).toBe(true);
      if (!listed.ok || !conversation.ok) throw Error("call refused");
      expect((listed.body as { tasks: unknown[] }).tasks).toHaveLength(tasks);
      expect((conversation.body as { messages: unknown[] }).messages).toHaveLength(messages);
    }
  });

  test("lead flow insight days keep the 0.9.36 safe-integer fallback", () => {
    const ctx = { store, who, now: clock(), draft: () => null, step: 1, readDecisions: new Map() };
    for (const [days, expected] of [[undefined, 30], [0, 0], [-5, -5], [100, 100], [2.9, 30], [null, 30], ["7", 30], [{}, 30], [Number.MAX_SAFE_INTEGER + 1, 30]] as const) {
      expect(executeMateTool(ctx, "get_flow_insights", { days, zz_unknown: true })).toMatchObject({ ok: true, body: { days: expected, flows: [] } });
    }
  });

  test("a tool still returns its real result when the output contract reports a mismatch under Vitest", () => {
    const tool = MATE_TOOLS.find(one => one.name === "get_actions")!;
    const handle = vi.spyOn(tool, "handle").mockReturnValue({ ok: true, body: { actual: "the handler result" } });
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(executeMateTool({ store, who, now: clock(), draft: () => null, step: 1, readDecisions: new Map() }, "get_actions", {}))
        .toEqual({ ok: true, body: { actual: "the handler result" } });
      expect(write).toHaveBeenCalledWith(expect.stringContaining("lead tool get_actions: its result disagrees with its output schema"));
    } finally {
      handle.mockRestore();
      write.mockRestore();
    }
  });

  test("a proposal field that looks like a credential is refused before it is drafted, and the call never goes back out", async () => {
    const ctx = { store, who, now: clock(), draft: () => 1 };
    expect(executeMateTool(ctx, "propose_hold", { task: "in-1", reason: "use AKIAABCDEFGHIJKLMNOP" })).toMatchObject({ ok: false, message: expect.stringContaining("plain text") });
    expect(executeMateTool(ctx, "propose_task", { repo: "r1", title: "t", goal: "token xoxb-1234567890-abcdef" })).toMatchObject({ ok: false });
    // In a turn, the model's own call carried the credential: the next body would repeat it, so the turn stops there.
    const script = scripted([answer([call("propose_hold", { task: "in-1", reason: "use AKIAABCDEFGHIJKLMNOP" })]), text("ok")]);
    const outcome = await turn("hold it", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "secret-refused", unknownSpend: false });
    expect(store.listMateProposals(thread().id)).toHaveLength(0);
    expect(script.bodies).toHaveLength(1);
  });

  test("the step cap: a model that never stops is stopped after the eighth step, its text kept", async () => {
    const responses = Array.from({ length: MATE_MAX_STEPS + 2 }, (_, index) => answer([{ type: "text", text: `step ${index + 1}` }, call("recap")]));
    const script = scripted(responses);
    const outcome = await turn("keep looking", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, steps: MATE_MAX_STEPS, stoppedAtCap: true });
    if (!outcome.ok) throw new Error("unreachable");
    if (outcome.replayed) throw new Error("unreachable replay");
    expect(outcome.reply).toBe(`step ${MATE_MAX_STEPS}\n\n(I stopped here: this answer needed more steps than one reply allows. Ask me to carry on.)`);
    expect(script.bodies).toHaveLength(MATE_MAX_STEPS);
  });

  test("chat error copy is plain: what happened, what it means and one next step, with no internal words", () => {
    for (const words of [...Object.values(MATE_REFUSAL_COPY), ...Object.values(MATE_FAILURE_COPY), ...Object.values(MATE_CHANNEL_COPY)]) {
      expect(words).not.toMatch(/\b(?:lease[sd]?|digests?|latch(?:ed)?|mint(?:ed)?|ceilings?|sessions?|reservations?|credentials?|dispatch(?:ed)?|this turn|turn #|steps?|superseded|malformed)\b/i);
      expect(words.split(/(?<=[.!?])\s+/).length).toBeGreaterThanOrEqual(2);
      expect(words).toMatch(/[.!?]$/);
    }
  });

  describe("a reply that claims an attachment it does not carry", () => {
    const reply = (outcome: Awaited<ReturnType<typeof runMateTurn>>): string => {
      if (!outcome.ok || outcome.replayed) throw new Error("expected an answered turn");
      return outcome.reply;
    };
    test("gets one repair step telling the lead to attach it or drop the claim", async () => {
      const script = scripted([text("Here's the screenshot of the payout page."), text("That result has no screenshots saved yet. Open it to check the page yourself.")]);
      const outcome = await turn("show me the payout page", script.fetcher);
      expect(script.bodies).toHaveLength(2);
      expect(script.bodies[1]).toContain("nothing is attached or linked this turn");
      expect(reply(outcome)).toBe("That result has no screenshots saved yet. Open it to check the page yourself.");
      expect(outcome).toMatchObject({ steps: 2 });
    });
    test("is never sent alone: a claim that survives the repair is dropped, said plainly once", async () => {
      const script = scripted([text("Here's the screenshot."), text("The guard is fixed. I've attached the log. Sending the report now.")]);
      const words = reply(await turn("did it work?", script.fetcher));
      expect(script.bodies).toHaveLength(2);
      expect(words).toBe(`The guard is fixed. ${NOTHING_ATTACHED}`);
      expect(deliverableClaim(words)).toBeNull();
    });
    test("a reply that lists what it names is not a claim: no repair step, nothing dropped", async () => {
      const listed = scripted([text("Here are the files I changed: a.ts, b.ts. I've included the logs I read:\n- build.log\n- test.log")]);
      expect(reply(await turn("what did you change?", listed.fetcher))).toBe("Here are the files I changed: a.ts, b.ts. I've included the logs I read:\n- build.log\n- test.log");
      expect(listed.bodies).toHaveLength(1);
    });
    test("a claim the turn backs — a link in the reply, or a page shown — goes out as written, with no repair step", async () => {
      const linked = scripted([text("Here's the link to the task: https://so.example.com/chat?task=in-1")]);
      expect(reply(await turn("link me the task", linked.fetcher))).toBe("Here's the link to the task: https://so.example.com/chat?task=in-1");
      expect(linked.bodies).toHaveLength(1);
      const shown = scripted([answer([{ type: "text", text: "Opening it." }, call("show_control", { control: "settings" })]), text("Here's the link to Settings.")]);
      expect(reply(await turn("where are settings?", shown.fetcher))).toBe("Here's the link to Settings.");
      expect(shown.bodies).toHaveLength(2);
    });
  });

  describe("a reply over its channel's message limit", () => {
    const words = (outcome: Awaited<ReturnType<typeof runMateTurn>>): string => {
      if (!outcome.ok || outcome.replayed) throw new Error("expected an answered turn");
      return outcome.reply;
    };
    const long = "The payout guard is fixed and its test passes. ".repeat(60).trim();
    test("gets one step asking the lead to shorten it to the channel's limit", async () => {
      expect(long.length).toBeGreaterThan(2_000);
      const script = scripted([text(long), text("The payout guard is fixed and its test passes.")]);
      const outcome = await turn("did it work?", script.fetcher, { channel: "discord" });
      expect(script.bodies).toHaveLength(2);
      expect(script.bodies[0]).toContain("Keep each reply within 2,000 characters, one message");
      expect(script.bodies[1]).toContain(`Your reply is ${long.length.toLocaleString("en-US")} characters; the limit is 2,000.`);
      expect(words(outcome)).toBe("The payout guard is fixed and its test passes.");
    });
    test("still over after that one step, it is kept whole (delivery splits it across messages)", async () => {
      const script = scripted([text(long), text(`${long} Ship it.`), text("never asked")]);
      expect(words(await turn("did it work?", script.fetcher, { channel: "discord" }))).toBe(`${long} Ship it.`);
      expect(script.bodies).toHaveLength(2);
      // Within Telegram's 4,096, the same reply needs no shorten step there.
      const telegram = scripted([text(long)]);
      expect(words(await turn("did it work?", telegram.fetcher, { channel: "telegram" }))).toBe(long);
      expect(telegram.bodies).toHaveLength(1);
    });
    test("the console has no message limit: no shorten step", async () => {
      const script = scripted([text(long)]);
      expect(words(await turn("did it work?", script.fetcher, { channel: "console" }))).toBe(long);
      expect(script.bodies).toHaveLength(1);
    });
  });

  test("a malformed reply mid-loop charges the WHOLE reservation to both ledgers, latches, and acknowledging refunds nothing", async () => {
    const script = scripted([answer([call("recap")]), new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })]);
    const live = session(50_000_000);
    const outcome = await turn("hello", script.fetcher, { session: live });
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: true });
    if (outcome.ok || !("turn" in outcome)) throw new Error("unreachable");
    const row = store.getMateTurn(outcome.turn);
    expect(row).toMatchObject({ state: "failed", failureReason: "malformed-reply", steps: 2 });
    expect(row?.settledMicrousd).toBe(row?.reservedMicrousd);
    expect(row!.reservedMicrousd).toBeGreaterThan(PER_STEP);
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(row?.reservedMicrousd);
    expect(store.chatWeeklySpendMicrousd(CREDENTIAL, clock())).toBe(row?.reservedMicrousd);
    const again = await turn("hello again", scripted([text("hi")]).fetcher, { session: live });
    expect(again).toMatchObject({ ok: false, refused: "latched", message: MATE_REFUSAL_COPY.latched });
    // Acknowledging the unknown step re-enables the credential and changes no ledger.
    const latched = store.recentChatTurns("alex", 5).find(one => one.unknownSpend);
    expect(latched).toBeDefined();
    expect(store.acknowledgeChatTurn(latched!.id, "alex", clock())).toBe(true);
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(row?.reservedMicrousd);
    expect(store.chatWeeklySpendMicrousd(CREDENTIAL, clock())).toBe(row?.reservedMicrousd);
    expect(await turn("hello again", scripted([text("hi")]).fetcher, { session: live })).toMatchObject({ ok: true });
    // No assistant row for the failed turn; the operator's text stays.
    expect(store.listMateMessages(thread().id, 10).map(one => one.role)).toEqual(["operator", "operator", "assistant"]);
  });

  test("a provider error answers with nothing billed and no latch", async () => {
    const script = scripted([json({}, 529)]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "provider-error", unknownSpend: false });
    expect(await turn("hello", scripted([text("hi")]).fetcher)).toMatchObject({ ok: true });
  });

  test("a call to a tool that does not exist ends the turn as malformed with its cost known — and its drafts deleted", async () => {
    const script = scripted([answer([call("propose_hold", { task: "in-1", reason: "x" }), call("delete_everything", {})])]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: false });
    expect(store.listMateProposals(thread().id)).toEqual([]);
    expect(await turn("hello", scripted([text("hi")]).fetcher)).toMatchObject({ ok: true });
  });

  test("usage that cannot be true is malformed, never a discount: coerced counts, output over the allowance, input over the bytes sent", async () => {
    for (const usage of [{ input_tokens: null, output_tokens: false }, { input_tokens: "100", output_tokens: 20 }, { input_tokens: 100, output_tokens: MAX_OUTPUT_TOKENS + 1 }, undefined]) {
      const parsed = parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text: "hi" }], usage })));
      expect(parsed).toMatchObject({ ok: false, problem: "no-usage" });
    }
    const outcome = await turn("hello", scripted([answer([{ type: "text", text: "hi" }], { input_tokens: 10_000_000, output_tokens: 1 })]).fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "malformed-reply", unknownSpend: true });
    // OpenRouter: a cost that is present must be a finite non-negative number.
    for (const cost of ["0.01", -1, 1e300]) {
      const parsed = parseMateProviderWrapper("openrouter-api", Buffer.from(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost } })));
      expect(parsed).toMatchObject({ ok: false, problem: "bad-cost" });
    }
  });

  test("a tool call is bounded whole — a long id or oversized text is malformed", () => {
    const big = (id: string) => parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "tool_use", id, name: "recap", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } })));
    expect(big("x".repeat(65))).toMatchObject({ ok: false, problem: "bad-tool-call" });
    expect(big("x".repeat(64))).toMatchObject({ ok: true });
    const wide = parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "tool_use", id: "a", name: "recap", input: { pad: "p".repeat(MATE_TOOL_CALL_CAP_BYTES) } }], usage: { input_tokens: 1, output_tokens: 1 } })));
    expect(wide).toMatchObject({ ok: false, problem: "bad-tool-call" });
    const chatty = parseMateProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text: "t".repeat(MATE_STEP_TEXT_CAP_BYTES + 1) }], usage: { input_tokens: 1, output_tokens: 1 } })));
    expect(chatty).toMatchObject({ ok: false, problem: "text-over-cap" });
  });

  test("the reservation covers the worst history the caps allow, escaped once more on the wire", () => {
    const worst = mateWorstCaseForPrice(PRICE, 1_000);
    let expected = 0;
    for (let s = 1; s <= MATE_MAX_STEPS; s++) {
      expected += Math.ceil((1_000 + (s - 1) * (4 * 2 * (MATE_TOOL_RESULT_CAP_BYTES + MATE_TOOL_CALL_CAP_BYTES) + 2 * MATE_STEP_TEXT_CAP_BYTES)) / 3) * PRICE.inMicrousd;
    }
    expected += MATE_MAX_STEPS * MAX_OUTPUT_TOKENS * PRICE.outMicrousd;
    expect(worst).toBe(expected);
    // The pathological result — every byte escapes — still fits twice its cap.
    const escaped = JSON.stringify("\"".repeat(MATE_TOOL_RESULT_CAP_BYTES / 2));
    expect(Buffer.byteLength(escaped, "utf8")).toBeLessThanOrEqual(2 * MATE_TOOL_RESULT_CAP_BYTES);
  });

  test("a crash mid-loop: the sweep charges the whole reservation when a step is unproven, keeps the drafts with its notice, and latches", () => {
    const live = session();
    const t = thread();
    const opened = store.openMateTurn(
      { approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 10_000, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 130_000 },
      T0,
    );
    if (!opened.ok) throw new Error(opened.reason);
    const started = store.startMateTurn(opened.id, T0);
    if (!started.ok) throw new Error("start");
    store.draftMateProposal({ thread: t.id, turn: opened.id, kind: "hold", payload: { task: "in-1" }, ceilingDigest: who.ceilingDigest }, T0);
    const step = () =>
      store.openMateStep({ mateTurn: opened.id, generation: started.generation, approver: "alex", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", deadlineMs: 130_000 }, T0);
    const first = step();
    if (!first.ok) throw new Error(first.reason);
    const firstStarted = store.startChatTurn(first.id, T0);
    if (!firstStarted.ok) throw new Error("start");
    store.finalizeChatTurn(first.id, firstStarted.generation, { state: "answered", settledMicrousd: 700, tokensIn: 10, tokensOut: 10 }, T0);
    const second = step();
    if (!second.ok) throw new Error(second.reason);
    store.startChatTurn(second.id, T0);
    // The process dies here. Later, the sweep runs.
    const later = new Date(T0.getTime() + 200_000);
    store.sweepStaleMateTurns(later);
    expect(store.getMateTurn(opened.id)).toMatchObject({ state: "failed", failureReason: "crashed", settledMicrousd: 10_000, steps: 2 });
    expect(store.getMateSession(live.id)?.spentMicrousd).toBe(10_000);
    // The completed tool call's proposal stands; the thread says the reply took too long and that its cost paused chat.
    expect(store.listMateProposals(t.id)).toMatchObject([{ turn: opened.id, state: "pending" }]);
    expect(store.listMateMessages(t.id, 5).at(-1)).toMatchObject({ role: "assistant", turn: opened.id, text: mateTimeoutNotice(true, true) });
    expect(store.openMateTurn({ approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 10, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1000 }, later)).toMatchObject({ ok: false, reason: "latched" });
  });

  // Release check 2438: propose_flow succeeded, then the provider never finished its final step and the person saw nothing.
  describe("a turn past its deadline", () => {
    const SUB: ChatConfig = { ...CONFIG, provider: "claude-subscription", model: "default", weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 };
    const proposed = { ok: true as const, answer: { text: "Holding it.", calls: [{ id: "h1", name: "propose_hold", args: { task: "other-1", reason: "not this week" } }], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null } };
    const replied = (text: string) => ({ ok: true as const, answer: { text, calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null } });
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
    afterEach(() => { vi.useRealTimers(); });

    test("a provider that answers a tool call and then never finishes: the notice and the proposal are saved by the deadline plus grace, its run is aborted, and a late answer changes nothing", async () => {
      const live = session(0, "alex", subscriptionCredentialKey("claude-subscription"));
      const t = thread();
      const signals: AbortSignal[] = [];
      let finishLate: ((value: ReturnType<typeof replied>) => void) | null = null;
      let hung!: () => void;
      const hanging = new Promise<void>(resolve => { hung = resolve; });
      const subscriptionRunner: SubscriptionMateRunner = request => {
        signals.push(request.signal!);
        if (signals.length === 1) return Promise.resolve(proposed);
        hung();
        // Ignores its abort entirely, like a harness stuck in swap.
        return new Promise(resolve => { finishLate = resolve; });
      };
      let settled = false;
      const running = runMateTurn({ store, who, session: live, thread: t, config: SUB, key: null, message: "hold the nightly digest", subscriptionRunner, clock })
        .finally(() => { settled = true; });
      await hanging;
      await vi.advanceTimersByTimeAsync(TURN_WALL_CLOCK_MS);
      expect(signals[1]?.aborted).toBe(true);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(MATE_ABORT_GRACE_MS);
      const outcome = await running;
      expect(outcome).toMatchObject({ ok: false, failed: "timeout", saved: true, unknownSpend: false, message: mateTimeoutNotice(true) });
      const turnId = (outcome as { turn: number }).turn;
      expect(store.getMateTurn(turnId)).toMatchObject({ state: "failed", failureReason: "timeout" });
      expect(store.listMateMessages(t.id, 5).map(one => [one.role, one.text])).toEqual([["operator", "hold the nightly digest"], ["assistant", mateTimeoutNotice(true)]]);
      expect(store.listMateProposals(t.id)).toMatchObject([{ turn: turnId, kind: "hold", state: "pending" }]);
      expect(store.raw().prepare("SELECT state, failure_reason FROM chat_turn WHERE mate_turn = ? ORDER BY id").all(turnId).map(row => [row["state"], row["failure_reason"]]))
        .toEqual([["answered", null], ["failed", "timeout"]]);
      // The provider answers long after: nothing it says is saved or acted on.
      finishLate!(replied("Done, all held."));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.listMateMessages(t.id, 5)).toHaveLength(2);
      expect(store.getMateTurn(turnId)?.state).toBe("failed");
      // The next message is not blocked by the stuck one.
      const next = await runMateTurn({ store, who, session: live, thread: t, config: SUB, key: null, message: "anything else?", subscriptionRunner: async () => replied("Nothing else needs you."), clock });
      expect(next).toMatchObject({ ok: true, reply: "Nothing else needs you." });
    });

    test("a very slow provider: the turn ends at its deadline with the notice, and nothing was proposed", async () => {
      const live = session(0, "alex", subscriptionCredentialKey("claude-subscription"));
      const t = thread();
      let started!: () => void;
      const waiting = new Promise<void>(resolve => { started = resolve; });
      const subscriptionRunner: SubscriptionMateRunner = request => {
        started();
        // Honours its abort, but would have answered at four minutes.
        return new Promise(resolve => {
          const late = setTimeout(() => resolve(replied("Finally.")), 240_000);
          request.signal?.addEventListener("abort", () => { clearTimeout(late); resolve({ ok: false, problem: "timeout" }); });
        });
      };
      const running = runMateTurn({ store, who, session: live, thread: t, config: SUB, key: null, message: "what needs me?", subscriptionRunner, clock });
      await waiting;
      await vi.advanceTimersByTimeAsync(TURN_WALL_CLOCK_MS);
      expect(await running).toMatchObject({ ok: false, failed: "timeout", saved: true, message: MATE_FAILURE_COPY.tooLong });
      expect(store.listMateMessages(t.id, 5).at(-1)).toMatchObject({ role: "assistant", text: MATE_FAILURE_COPY.tooLong });
      expect(MATE_FAILURE_COPY.tooLong).toBe("The reply took too long and was stopped. Send your message again, or ask for less at once.");
      expect(store.listMateProposals(t.id)).toEqual([]);
    });

    test("a direct request whose body never ends is abandoned at the deadline plus grace and latches its unknown cost", async () => {
      const t = thread();
      let started!: () => void;
      const waiting = new Promise<void>(resolve => { started = resolve; });
      let step = 0;
      const fetcher = (async () => {
        if (++step === 1) return answer([call("propose_hold", { task: "other-1", reason: "not this week" })]);
        started();
        return new Promise<Response>(() => undefined);
      }) as unknown as typeof fetch;
      const running = turn("hold the digest", fetcher, { thread: t });
      await waiting;
      await vi.advanceTimersByTimeAsync(TURN_WALL_CLOCK_MS + MATE_ABORT_GRACE_MS);
      expect(await running).toMatchObject({ ok: false, failed: "timeout", saved: true, unknownSpend: true, message: mateTimeoutNotice(true, true) });
      expect(store.listMateProposals(t.id)).toMatchObject([{ kind: "hold", state: "pending" }]);
      expect(store.latchedChatTurns(CREDENTIAL)).toHaveLength(1);
    });

    test("a channel check that never answers cannot hold the turn open", async () => {
      const live = session(0, "alex", subscriptionCredentialKey("claude-subscription"));
      const t = thread();
      let checks = 0;
      let stuck!: () => void;
      const waiting = new Promise<void>(resolve => { stuck = resolve; });
      const running = runMateTurn({ store, who, session: live, thread: t, config: SUB, key: null, message: "hold it", clock,
        subscriptionRunner: async () => proposed,
        revalidate: () => { if (++checks < 4) return Promise.resolve({ ok: true as const }); stuck(); return new Promise(() => undefined); } });
      await waiting;
      await vi.advanceTimersByTimeAsync(TURN_WALL_CLOCK_MS + MATE_ABORT_GRACE_MS);
      expect(await running).toMatchObject({ ok: false, failed: "timeout", saved: true });
      expect(store.listMateProposals(t.id)).toMatchObject([{ state: "pending" }]);
    });
  });

  test("the latch is re-checked before every step: another approver's unknown-cost turn stops this loop between steps", async () => {
    const script = scripted([
      answer([call("recap")]),
      () => {
        // Between steps, someone else's turn on the shared credential latches it.
        const other = store.openChatTurn({ approver: "root", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", reservedMicrousd: 1, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1000 }, clock());
        if (!other.ok) throw new Error(other.reason);
        const startedOther = store.startChatTurn(other.id, clock());
        if (!startedOther.ok) throw new Error("start");
        store.finalizeChatTurn(other.id, startedOther.generation, { state: "failed", failureReason: "timeout", settledMicrousd: null, unknownSpend: true }, clock());
        return answer([call("recap")]);
      },
      text("never reached"),
    ]);
    const outcome = await turn("hello", script.fetcher);
    expect(outcome).toMatchObject({ ok: false, failed: "latched", unknownSpend: false });
    expect(script.bodies).toHaveLength(2);
  });

  test("the reservation is triangular and refuses before any dispatch against the session, the week, and the day", async () => {
    const script = scripted([text("hi")]);
    expect(await turn("hello", script.fetcher, { session: session(10) })).toMatchObject({ ok: false, refused: "session-exhausted" });
    expect(await turn("hello", script.fetcher, { config: { ...CONFIG, weeklyCeilingMicrousd: 10 } })).toMatchObject({ ok: false, refused: "over-budget" });
    const ended = session();
    store.endMateSession(ended.id, "alex", clock());
    expect(await turn("hello", script.fetcher, { session: ended })).toMatchObject({ ok: false, refused: "session-ended" });
    expect(await turn("hello", script.fetcher, { config: { ...CONFIG, priceInMicrousd: null, priceOutMicrousd: null, model: "no-such-model" } })).toMatchObject({ ok: false, refused: "unpriced" });
    expect(script.bodies).toHaveLength(0);
    const live = session();
    const good = await turn("hello", script.fetcher, { session: live });
    expect(good).toMatchObject({ ok: true });
    if (!good.ok) throw new Error("unreachable");
    expect(store.getMateTurn(good.turn)?.reservedMicrousd).toBe(mateWorstCaseForPrice(PRICE, Buffer.byteLength(script.bodies[0]!, "utf8")));
    // The day counts mate turns as one turn each, and closes chat and mate alike.
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: live, config: { ...CONFIG, dailyTurns: 1 } })).toMatchObject({ ok: false, refused: "daily-cap" });
    expect(store.chatTurnsToday("alex", clock())).toBe(1);
  });

  test("admission binds the session and the thread to the approver and the credential", async () => {
    const bobs = session(5_000_000, "root");
    const bobsThread = thread("root");
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: bobs })).toMatchObject({ ok: false, refused: "not-yours" });
    expect(await turn("hello", scripted([text("hi")]).fetcher, { thread: bobsThread })).toMatchObject({ ok: false, refused: "not-yours" });
    expect(store.listMateMessages(bobsThread.id, 10)).toEqual([]);
    // A session minted under another credential cannot be spent by this key.
    const otherKey = session(5_000_000, "alex", credentialKeyOf("anthropic-api", "sk-ant-other"));
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: otherKey })).toMatchObject({ ok: false, refused: "not-yours" });
    // A closed thread cannot be continued.
    const live = session();
    const t = thread();
    store.closeMateThreadsFor("alex", clock());
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: live, thread: t })).toMatchObject({ ok: false, refused: "thread-closed" });
  });

  test("the brand is runtime: a structural copy or a mutated principal is refused", async () => {
    expect(isVerifiedApprover(who)).toBe(true);
    const copy = { ...who, repos: [...who.repos] } as unknown as VerifiedApprover;
    expect(isVerifiedApprover(copy)).toBe(false);
    expect(reproveApprover(store, copy)).toMatchObject({ ok: false, reason: "forged" });
    expect(await turn("hello", scripted([text("hi")]).fetcher, { who: copy })).toMatchObject({ ok: false, refused: "standing" });
    expect(() => {
      (who.repos as string[])[0] = OUTSIDE;
    }).toThrow();
    expect(() => {
      (who as { name: string }).name = "root";
    }).toThrow();
    expect(who.repos[0]).toBe(INSIDE);
    // Minting takes the generation the session holds; a stale one refuses.
    expect(verifyApproverStanding(store, "alex", who.generation + 1, [INSIDE])).toMatchObject({ ok: false, reason: "generation" });
  });

  test("the ceiling binds: a surface under other repos cannot continue the session or the thread", async () => {
    const live = session();
    const narrowed = principal("alex", [INSIDE]);
    expect(narrowed.ceilingDigest).not.toBe(who.ceilingDigest);
    // Order is part of the ceiling: rN is an index (slice-2 review, finding 3).
    expect(ceilingDigestOf([OTHER, INSIDE])).not.toBe(who.ceilingDigest);
    expect(ceilingDigestOf([INSIDE, OTHER])).toBe(who.ceilingDigest);
    expect(await turn("hello", scripted([text("hi")]).fetcher, { who: narrowed, session: live })).toMatchObject({ ok: false, refused: "ceiling-changed" });
    // The thread under the old ceiling closes when a new ceiling opens one, and its pending proposals expire.
    const old = thread();
    const drafted = store.draftMateProposal({ thread: old.id, turn: 0, kind: "hold", payload: {}, ceilingDigest: who.ceilingDigest }, clock());
    expect(store.promoteMateProposals(0)).toBe(0); // no answered turn 0: nothing promotes
    expect(store.casMateProposal(drafted, "drafting", "pending", null, null, clock())).toBe(true);
    const reopened = store.openMateThread("alex", narrowed.ceilingDigest, clock());
    expect(reopened.ceilingChanged).toBe(true);
    expect(reopened.thread.id).not.toBe(old.id);
    expect(store.getMateThread(old.id)?.closedAt).not.toBeNull();
    expect(store.listMateProposals(old.id).map(one => one.state)).toEqual(["expired"]);
  });

  test("revocation DURING the model's answer ends the turn with nothing kept and the reservation charged; afterwards the principal is dead", async () => {
    const live = session();
    const t = thread();
    const script = scripted([
      answer([call("propose_hold", { task: "in-1", reason: "x" })]),
      () => {
        store.revokeAccount("alex", "root", clock());
        return text("here is what I propose");
      },
    ]);
    const outcome = await turn("hello", script.fetcher, { session: live, thread: t });
    expect(outcome).toMatchObject({ ok: false, failed: "superseded" });
    const row = store.getMateTurn((outcome as { turn: number }).turn);
    expect(row).toMatchObject({ state: "failed", failureReason: "revoked" });
    expect(row?.settledMicrousd).toBe(row?.reservedMicrousd);
    expect(store.getMateSession(live.id)).toMatchObject({ endedAt: expect.any(String), spentMicrousd: row?.reservedMicrousd });
    expect(store.listMateProposals(t.id)).toEqual([]);
    expect(store.listMateMessages(t.id, 10)).toEqual([]);
    expect(store.getMateThread(t.id)?.closedAt).not.toBeNull();
    expect(await turn("hello", scripted([text("hi")]).fetcher, { session: live })).toMatchObject({ ok: false, refused: "standing" });
  });

  test("a mate-written scope never seals under mode coverage; a human rewrite clears the mark; filing carries it", () => {
    // v47: a routed scope seals only when every phase names an exact agent.
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    propose(store, { taskId: "in-2", goal: "the mate's goal", now: T0, proposedVia: "mate" });
    expect(store.sealScopeApproval("in-2", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
    propose(store, { taskId: "in-2", goal: "the operator's goal", now: T0 });
    expect(store.sealScopeApproval("in-2", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(true);
    const filed = fileTaskProposal(store, { id: "mate-1", title: "filed by the mate", repo: INSIDE, goal: "g", acceptance: [{ id: "c1", statement: "g happens.", evidence: ["manual-review"] }], filedVia: "mate", proposedVia: "mate" }, T0);
    expect(filed).toMatchObject({ ok: true });
    expect(store.sealScopeApproval("mate-1", "alex", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
  });

  test("secrets refuse before any row exists, in the message and in the reply", async () => {
    const script = scripted([text("hi")]);
    expect(await turn("use AKIAABCDEFGHIJKLMNOP please", script.fetcher)).toMatchObject({ ok: false, refused: "secret-in-message" });
    expect(store.listMateMessages(thread().id, 10)).toHaveLength(0);
    expect(script.bodies).toHaveLength(0);
    const leaky = await turn("hello", scripted([text("the key is AKIAABCDEFGHIJKLMNOP")]).fetcher);
    expect(leaky).toMatchObject({ ok: false, failed: "secret-refused", unknownSpend: false });
    expect(store.listMateMessages(thread().id, 10).map(one => one.role)).toEqual(["operator"]);
  });

  test("one live turn per approver across chat and mate, and the history the next turn sees is text only, operator first", async () => {
    const first = await turn("first question", scripted([text("first answer")]).fetcher);
    expect(first).toMatchObject({ ok: true });
    expect(historyFor(store, thread().id)).toEqual([
      { role: "operator", text: "first question" },
      { role: "assistant", text: "first answer", calls: [] },
    ]);
    const live = session();
    const t = thread();
    const blocking = store.openMateTurn({ approver: "alex", session: live.id, thread: t.id, credentialKey: CREDENTIAL, reservedMicrousd: 1, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 60_000 }, clock());
    expect(blocking).toMatchObject({ ok: true });
    expect(await turn("second", scripted([text("x")]).fetcher, { session: live, thread: t })).toMatchObject({ ok: false, refused: "concurrent" });
    // Fleet chat sees the live mate turn too.
    expect(store.openChatTurn({ approver: "alex", credentialKey: CREDENTIAL, provider: "anthropic-api", model: "m", reservedMicrousd: 1, dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, deadlineMs: 1000 }, clock())).toMatchObject({ ok: false, reason: "concurrent" });
  });

  test("the OpenRouter loop: tool_calls in, tool messages out, the same ledger", async () => {
    const or = (message: Record<string, unknown>) => json({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0009 } });
    const script = scripted([
      or({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tasks", arguments: JSON.stringify({ repo: "r1" }) } }] }),
      or({ content: "two tasks are queued in r1" }),
    ]);
    // The worst-case reservation grows with the tool contract; this ceiling only has to admit one priced turn.
    const live = session(6_000_000, "alex", credentialKeyOf("openrouter-api", "or-key"));
    const outcome = await turn("what is queued?", script.fetcher, { session: live, config: { ...CONFIG, provider: "openrouter-api", model: "openai/gpt-5" }, key: "or-key" });
    expect(outcome).toMatchObject({ ok: true, steps: 2, activity: "read 1 · proposed 0 · 2 steps" });
    if (!outcome.ok) throw new Error("unreachable");
    // The reported cost ($0.0009 = 900 µ$) is higher than the pinned 360 and wins, per step.
    expect(outcome.settledMicrousd).toBe(2 * 900);
    const second = JSON.parse(script.bodies[1]!) as { messages: { role: string; tool_call_id?: string; content?: unknown }[] };
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(second.messages.at(-1)?.content)).toContain("\"queued\"");
  });

  test("get_decision shows consequences through mateView but never the recap or the recommendation; propose_answer carries the pick", async () => {
    const readDecisions = new Map<number, number>();
    const ctx = { store, who, now: clock(), draft: (_k: string, payload: Record<string, unknown>) => (payload["option"] === "closed" ? 7 : null), step: 1, readDecisions };
    const got = executeMateTool(ctx, "get_decision", { decision: 1 });
    expect(got).toMatchObject({ ok: true, body: { decision: 1, task: "in-1", repo: "r1", state: "open", options: [{ id: "open", reversible: true }, { id: "closed", reversible: false }] } });
    const serialized = JSON.stringify(got);
    expect(serialized).toContain("CONSEQUENCE-CANARY");
    expect(serialized).not.toContain("RECAP-CANARY");
    expect(serialized).not.toContain("recommend");
    expect(executeMateTool(ctx, "get_decision", { decision: 99 })).toMatchObject({ ok: false, message: expect.stringContaining("not-found") });
    // Read in THIS step: the model chose before the consequences arrived — refused (v3 review, finding 6).
    expect(executeMateTool(ctx, "propose_answer", { decision: 1, option: "closed", rationale: "safer under load" })).toMatchObject({ ok: false, message: expect.stringContaining("get_decision") });
    const later = { ...ctx, step: 2 };
    expect(executeMateTool(later, "propose_answer", { decision: 1, option: "nope", rationale: "x" })).toMatchObject({ ok: false, message: expect.stringContaining("option must be one of") });
    expect(executeMateTool(later, "propose_answer", { decision: 1, option: "closed", rationale: "safer under load" })).toMatchObject({ ok: true, body: { proposal: 7, kind: "answer", awaiting: expect.stringContaining("irreversible") } });
    // In a turn: the read and the proposal in ONE response is refused; read, then propose in the next step, goes pending.
    const script = scripted([
      answer([call("get_decision", { decision: 1 }), call("propose_answer", { decision: 1, option: "open", rationale: "guessing" })]),
      answer([call("propose_answer", { decision: 1, option: "open", rationale: "reversible, and unblocks the build" })]),
      text("I propose failing open."),
    ]);
    const outcome = await turn("what about the decision?", script.fetcher);
    expect(outcome).toMatchObject({ ok: true, proposals: 1, activity: "read 1 · proposed 1 · 3 steps" });
    expect(script.bodies[1]).toContain("get_decision");
    const row = store.listMateProposals(thread().id, ["pending"])[0];
    expect(row).toMatchObject({ kind: "answer", payload: { decision: 1, task: "in-1", option: "open", optionLabel: "Fail open", reversible: true } });
    expect(script.bodies.join("\n")).not.toContain("RECAP-CANARY");
  });

  test("same task conversation identifies current execution while proposals keep their exact target", () => {
    const root = store.lookupRef("in-1")!;
    const run = store.runsFor(root.id)[0]!;
    const artifact = store.saveArtifact({ run: run.id, kind: "revision-brief", key: "synthetic-brief.json", bytesOriginal: 2, bytesStored: 2, sha256: "a".repeat(64), truncated: false, capture: "synthetic family fixture" }, T0);
    store.markRevision(store.lookupRef("in-2")!.id, "in-1", artifact);
    let payload: Record<string, unknown> | null = null;
    const ctx = { store, who, now: clock(), draft: (_kind: string, value: Record<string, unknown>) => { payload = value; return 12; }, step: 1, readDecisions: new Map<number, number>() };
    const listed = executeMateTool(ctx, "list_tasks", {});
    expect(listed).toMatchObject({ ok: true, body: { tasks: expect.arrayContaining([expect.objectContaining({ task: "in-1", execution: "in-2" })]) } });
    const tasks = (listed as { ok: true; body: { tasks: { task: string }[] } }).body.tasks;
    expect(tasks.filter(one => one.task === "in-1")).toHaveLength(1);
    expect(tasks.some(one => one.task === "in-2")).toBe(false);
    expect(executeMateTool(ctx, "get_task", { task: "in-1" })).toMatchObject({ ok: true, body: { task: "in-1", root: "in-1", currentExecution: "in-2" } });
    expect(executeMateTool(ctx, "propose_hold", { task: "in-1", reason: "Hold this exact execution." })).toMatchObject({ ok: true });
    expect(payload).toMatchObject({ task: "in-1" });
    expect(executeMateTool(ctx, "get_task", { task: "out-1" })).toMatchObject({ ok: false });
    for (let i = 0; i < 65; i++) {
      store.createTask({ id: `other-new-${i}`, title: "Other project" }, new Date(T0.getTime() + i + 1));
      store.placeTask(store.lookupRef(`other-new-${i}`)!.id, OTHER);
    }
    expect(executeMateTool(ctx, "list_tasks", { repo: "r1", limit: 2 })).toMatchObject({ ok: true, body: { tasks: expect.arrayContaining([expect.objectContaining({ task: "in-1", execution: "in-2", repo: "r1" })]) } });
  });

  test("get_task exposes dependency state and repair proposals capture the exact graph seen", () => {
    store.setTaskState("in-3", "failed", clock());
    store.addEdge("in-2", "in-3");
    let drafted: { kind: string; payload: Record<string, unknown> } | null = null;
    const ctx = {
      store,
      who,
      now: clock(),
      draft: (kind: string, payload: Record<string, unknown>) => {
        drafted = { kind, payload };
        return 12;
      },
      step: 1,
      readDecisions: new Map<number, number>(),
    };

    expect(executeMateTool(ctx, "get_task", { task: "in-2" })).toMatchObject({
      ok: true,
      body: { dependencies: [{ task: "in-3", state: "failed" }], dispatch: { code: "terminal-dependency" } },
    });
    expect(executeMateTool(ctx, "propose_dependency_repair", { task: "in-2", blocker: "in-3", operation: "retry" })).toMatchObject({
      ok: true,
      body: { proposal: 12, kind: "repair", operation: "retry" },
    });
    expect(drafted).toEqual({
      kind: "repair",
      payload: {
        task: "in-2",
        taskTitle: "rotate the webhook secret",
        repoId: "r1",
        blocker: "in-3",
        blockerTitle: `see ${INSIDE}/notes by alex, digest ${"d".repeat(64)}`,
        operation: "retry",
        sawBlockerState: "failed",
      },
    });
    expect(executeMateTool(ctx, "propose_dependency_repair", { task: "in-2", blocker: "in-3", operation: "replace", replacement: "other-1" })).toMatchObject({ ok: true });
    expect(executeMateTool(ctx, "propose_dependency_repair", { task: "in-2", blocker: "in-1", operation: "unlink" })).toMatchObject({ ok: false, message: expect.stringContaining("no longer waiting") });

    store.setTaskState("in-3", "cancelled", clock());
    expect(executeMateTool(ctx, "propose_dependency_repair", { task: "in-2", blocker: "in-3", operation: "retry" })).toMatchObject({ ok: false, message: expect.stringContaining("cancelled") });
  });

  test("steering is drafted as a confirmation card and never writes guidance directly", () => {
    let drafted: { kind: string; payload: Record<string, unknown> } | null = null;
    const result = executeMateTool({
      store,
      who,
      now: clock(),
      draft: (kind, payload) => {
        drafted = { kind, payload };
        return 14;
      },
      step: 1,
      readDecisions: new Map(),
    }, "propose_steer", { task: "in-2", note: "Polish the narrow layout first." });
    expect(result).toMatchObject({ ok: true, body: { proposal: 14, kind: "steer", task: "in-2" } });
    expect(drafted).toEqual({
      kind: "steer",
      payload: { task: "in-2", taskTitle: "rotate the webhook secret", repoId: "r1", note: "Polish the narrow layout first." },
    });
    expect(store.listSteerNotes(store.refFor("built-in", "in-2").id)).toEqual([]);
  });

  test("the tools refuse bad arguments with typed messages, count decisions per task, and place the queue by column", () => {
    const ctx = { store, who, now: clock(), draft: () => 1, step: 1, readDecisions: new Map<number, number>() };
    expect(executeMateTool(ctx, "queue", { repo: "r9" })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "list_tasks", { repo: INSIDE })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "propose_task", { repo: "r1", title: "x", goal: "<script>alert(1)</script>", acceptance: [{ id: "c1", statement: "x", evidence: ["manual-review"] }] })).toMatchObject({ ok: true });
    expect(executeMateTool(ctx, "propose_unhold", { task: "in-1" })).toMatchObject({ ok: false, message: expect.stringContaining("no hold") });
    expect(executeMateTool(ctx, "propose_reserve", { task: "in-1", worker: "nobody" })).toMatchObject({ ok: false });
    expect(executeMateTool(ctx, "propose_cancel", { task: "out-1", reason: "r" })).toMatchObject({ ok: false, message: expect.stringContaining("not-found") });
    expect(executeMateTool(ctx, "recap", { since: "yesterday" })).toMatchObject({ ok: false });
    // Decisions are the task's own: in-2 shares the repo with in-1's decision and reports none.
    expect(executeMateTool(ctx, "get_task", { task: "in-1" })).toMatchObject({ ok: true, body: { repo: "r1", scope: "none", decisionsOpen: 1 } });
    expect(executeMateTool(ctx, "get_task", { task: "in-1" })).toMatchObject({ ok: true, body: { work: { taskId: "in-1", nextActions: [
      { code: "write-scope", access: "proposal-only" },
      { code: "answer-decision", access: "proposal-only", target: { taskId: "in-1", decisionId: 1 } },
    ] } } });
    expect(executeMateTool(ctx, "get_task", { task: "in-2" })).toMatchObject({ ok: true, body: { decisionsOpen: 0 } });
    const decisions = executeMateTool(ctx, "list_decisions", {});
    expect(decisions).toMatchObject({ ok: true, body: { decisions: [{ decision: 1, task: "in-1", options: [{ id: "open", reversible: true }, { id: "closed", reversible: false }], ageHours: 0 }] } });
    expect(JSON.stringify(decisions)).not.toContain("CONSEQUENCE");
    const queue = executeMateTool(ctx, "queue", { repo: "r1" });
    expect(queue).toMatchObject({ ok: true, body: { columns: [{ column: "shared", tasks: [{ position: 1 }, { position: 2 }, { position: 3 }] }] } });
    const recap = executeMateTool(ctx, "recap", { since: new Date(clockAt - 3_600_000).toISOString() });
    expect(recap).toMatchObject({ ok: true, body: { waitsOnYou: { decisions: [{ decision: 1, task: "in-1" }] }, repos: [{ repo: "r1", queued: 3 }, { repo: "r2", queued: 1 }] } });
    expect(JSON.stringify(executeMateTool(ctx, "get_task", { task: "in-3" }))).not.toContain("PATH");
  });

  test("a channel's own revalidation runs before admission and after the wait: refused before, failed as revoked after — nothing proposed is kept", async () => {
    const live = session();
    const t = thread();
    // Before admission: a typed refusal, no turn, no row.
    const closed = await turn("hello", scripted([text("hi")]).fetcher, { session: live, thread: t, revalidate: async () => ({ ok: false, reason: "unpaired" }) });
    expect(closed).toMatchObject({ ok: false, refused: "channel", message: MATE_REFUSAL_COPY.channel });
    expect(store.listMateMessages(t.id, 10)).toEqual([]);
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM mate_turn").get()?.["n"]).toBe(0);
    // After the provider wait: the model proposed something; the channel changed meanwhile; the tool never runs.
    let channelOk = true;
    const script = scripted([
      () => { channelOk = false; return answer([call("propose_hold", { task: "in-1", reason: "x" })]); },
      text("never reached"),
    ]);
    const outcome = await turn("hello", script.fetcher, {
      session: live, thread: t,
      revalidate: async () => channelOk ? { ok: true } : { ok: false, reason: "projects-changed" },
    });
    // Plain words for the reason, never the reason's own code.
    expect(outcome).toMatchObject({ ok: false, failed: "revoked", message: MATE_CHANNEL_COPY["projects-changed"] });
    expect(script.bodies).toHaveLength(1);
    expect(store.getMateTurn((outcome as { turn: number }).turn)).toMatchObject({ state: "failed", failureReason: "revoked" });
    expect(store.listMateProposals(t.id)).toEqual([]);
    expect(store.activeHolds(store.refFor("built-in", "in-1").id, clock())).toEqual([]);
  });

  test.each(["api", "subscription"] as const)("%s rechecks channel access before the next provider gets tool context", async route => {
    let calls = 0;
    let checksAfterFirst = 0;
    const fetched = scripted([
      () => { calls++; return answer([call("list_tasks", { repo: "r1" })]); },
      () => { calls++; return text("must not receive context"); },
    ]);
    const subscription = route === "subscription";
    const outcome = await turn("read the tasks then summarize", fetched.fetcher, {
      ...(subscription ? {
        config: { ...CONFIG, provider: "codex-subscription" as const }, key: null,
        session: session(0, "alex", subscriptionCredentialKey("codex-subscription")),
        subscriptionRunner: async () => {
          calls++;
          return { ok: true as const, answer: { text: "Reading.", calls: [{ id: `read-${calls}`, name: "list_tasks", args: { repo: "r1" } }], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null } };
        },
      } : {}),
      revalidate: async () => {
        if (calls > 0 && ++checksAfterFirst > 1) return { ok: false, reason: "projects-changed" };
        return { ok: true };
      },
    });
    expect(outcome).toMatchObject({ ok: false, failed: "revoked", message: MATE_CHANNEL_COPY["projects-changed"] });
    expect(calls).toBe(1);
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM chat_turn").get()?.["n"]).toBe(1);
  });

  test.each(["account", "session"] as const)("rechecks %s authority after an awaited channel lookup, before sending anything", async changed => {
    const live = session();
    const t = thread();
    let checks = 0;
    const script = scripted([text("must not run")]);
    const outcome = await turn("hello", script.fetcher, {
      session: live, thread: t,
      revalidate: async () => {
        await Promise.resolve();
        if (++checks === 2) {
          if (changed === "account") store.revokeAccount("alex", "root", clock());
          else store.endMateSession(live.id, "alex", clock());
        }
        return { ok: true };
      },
    });
    expect(outcome.ok).toBe(false);
    expect(script.bodies).toEqual([]);
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM chat_turn").get()?.["n"]).toBe(0);
  });
});
