/** Whose event is this (stream-scope.ts; docs/plans/agents-view.md §2.1): a subagent's init, words and result never
 * drive the parent session's receipt, result, saved session, identity conflict, live input, turn and tool marks,
 * activity, or billing. One table per consumer. */
import { describe, expect, test } from "vitest";
import { withAgentTurns, turnSignalOf, type OpenTool } from "./agent-turns.js";
import { runClaudeStreamJsonl } from "./exec.js";
import { observeClaudeBilling, type ClaudeBillingSeen } from "./invoke.js";
import { LiveInput, type LiveCloseReason } from "./live-input.js";
import { liveActivityKind } from "./live.js";
import { adapterFor } from "./provider.js";
import { claudeStreamReader } from "./lead-progress.js";
import { touchesPlanFile } from "./scout.js";
import { claudeLimitsOf, pushLimitSink, type LimitReading } from "./provider-limits.js";
import { claudeBillingFrom } from "./spend.js";
import { primaryResultEvent, topLevelEvent } from "./stream-scope.js";
import { performSubscriptionLeadRequest } from "./subscription-chat.js";

const CHILD = "toolu_child_1";
const childInit = { type: "system", subtype: "init", session_id: "s-child", model: "child-model", apiKeySource: "ANTHROPIC_API_KEY", parent_tool_use_id: CHILD };
const childAssistant = { type: "assistant", message: { id: "m-child", content: [{ type: "tool_use", id: "c1", name: "Bash", input: {} }] }, parent_tool_use_id: CHILD };
const childResult = { type: "result", subtype: "success", is_error: false, result: "child says done", session_id: "s-child", total_cost_usd: 9, parent_tool_use_id: CHILD };
const childHumanResult = { ...childResult, origin: { kind: "human" } };
const rateLimit = { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 2_000_000_000 } } } };
const childRateLimit = { ...rateLimit, parent_tool_use_id: CHILD };
const CHILD_EVENTS: [string, Record<string, unknown>][] = [["init", childInit], ["assistant", childAssistant], ["rate limit", childRateLimit], ["result", childResult], ["human-origin result", childHumanResult]];

describe("the predicate", () => {
  test.each([
    [{ type: "assistant" }, true],
    [{ type: "assistant", parent_tool_use_id: null }, true],
    [{ type: "assistant", parent_tool_use_id: CHILD }, false],
    [{ type: "assistant", parent_tool_use_id: "" }, false],
    [{ type: "assistant", parent_tool_use_id: 0 }, false],
    [{ type: "assistant", parent_tool_use_id: {} }, false],
  ])("top-level %j → %s", (event, expected) => expect(topLevelEvent(event)).toBe(expected));

  test.each([
    [{ type: "result" }, true],
    [{ type: "result", origin: null }, true],
    [{ type: "result", origin: { kind: "human" } }, true],
    [{ type: "result", origin: { kind: "task-notification" } }, false],
    [{ type: "result", origin: "human" }, false],
    [{ type: "result", parent_tool_use_id: CHILD }, false],
    [{ type: "result", origin: { kind: "human" }, parent_tool_use_id: CHILD }, false],
    [{ type: "assistant" }, false],
  ])("primary result %j → %s", (event, expected) => expect(primaryResultEvent(event)).toBe(expected));
});

describe("a subagent's events are not the parent's", () => {
  test.each(CHILD_EVENTS)("child %s: no turn signal and no activity", (_name, event) => {
    expect(turnSignalOf(event)).toBeNull();
    expect(liveActivityKind(event)).toBeNull();
  });

  test("a child's result never marks the parent idle or clears its open tools", () => {
    const states: string[] = [];
    const tools: OpenTool[] = [];
    const turns = withAgentTurns(null, state => states.push(state), () => new Date(0), open => tools.push(open));
    turns.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "task-1", name: "Task", input: {} }] }, parent_tool_use_id: null });
    for (const [, event] of CHILD_EVENTS) turns.observe(event);
    expect(states).toEqual(["busy"]);
    expect(tools).toEqual([{ kind: "tool", at: new Date(0) }]);
    expect(turns.state).toBe("busy");
    turns.observe({ type: "result", subtype: "success", is_error: false });
    expect(states).toEqual(["busy", "idle"]);
  });

  test.each(CHILD_EVENTS)("child %s never closes or settles the parent's live input", (_name, event) => {
    const closes: LiveCloseReason[] = [];
    let ended = false;
    const session = new LiveInput({ maxTurns: 1, finished: () => true, onClose: why => { closes.push(why); } });
    session.begin("brief");
    session.attach({ write: () => {}, end: () => { ended = true; } });
    session.observe({ type: "assistant", message: { id: "m1" }, parent_tool_use_id: null });
    session.observe(event);
    expect(ended).toBe(false);
    expect(closes).toEqual([]);
    expect(session.open).toBe(true);
  });

  test("billing reads only the session's own init and result", () => {
    const seen: ClaudeBillingSeen = { keySource: null, model: null, planWindows: false, answered: false };
    for (const [, event] of CHILD_EVENTS) observeClaudeBilling(seen, event);
    expect(seen).toEqual({ keySource: null, model: null, planWindows: false, answered: false });
    observeClaudeBilling(seen, { type: "system", subtype: "init", model: "parent-model", apiKeySource: "none" });
    observeClaudeBilling(seen, { type: "result", subtype: "success", is_error: false });
    expect(seen).toEqual({ keySource: "none", model: "parent-model", planWindows: false, answered: true });
    // A gateway's key ("none", no windows) stays a key: a child's limit window never turns it into the plan.
    observeClaudeBilling(seen, childRateLimit);
    expect(claudeBillingFrom(seen)).toBe("api-key");
    // The session's own window is the plan's sign, as before.
    observeClaudeBilling(seen, rateLimit);
    expect(claudeBillingFrom(seen)).toBe("subscription");
  });

  test("a child's rate-limit event is never a limit reading; the session's own still is", () => {
    expect(claudeLimitsOf(childRateLimit)).toBeNull();
    expect(claudeLimitsOf({ ...rateLimit, parent_tool_use_id: "" })).toBeNull();
    expect(claudeLimitsOf(rateLimit)).toMatchObject({ provider: "claude", windows: [{ window: "five_hour", usedPercent: 40 }] });
  });

  test("the envelope parser: a child's init never names or conflicts the session, a child's result never stands", () => {
    const stdout = [childInit, { type: "system", subtype: "init", session_id: "s-parent" }, childResult, childHumanResult,
      { type: "result", subtype: "success", is_error: false, result: "parent done", session_id: "s-parent", total_cost_usd: 0.25 }]
      .map(event => JSON.stringify(event)).join("\n");
    const parsed = adapterFor("claude").parse(stdout);
    expect(parsed.sessionId).toBe("s-parent");
    expect(parsed.finalMessage).toBe("parent done");
    expect(parsed.costUsd).toBe(0.25);
    expect(parsed.protocolError ?? null).toBeNull(); // no identity conflict
    expect(JSON.stringify(parsed)).not.toContain("s-child");
  });
});

describe("a subagent's events are not the parent's (round 1 review)", () => {
  const parentResult = { type: "result", subtype: "success", is_error: false, result: "parent done", session_id: "s-parent", total_cost_usd: 0.25 };
  const parse = (events: Record<string, unknown>[]) => adapterFor("claude").parse(events.map(event => JSON.stringify(event)).join("\n"));

  test("the envelope parser: a child's legacy envelope or overflow witness never stands; the transport's own witness does", () => {
    const childLegacy = { result: "child envelope", session_id: "s-child", total_cost_usd: 9, parent_tool_use_id: CHILD };
    const witness = { type: "result", subtype: "standing-orders-stream-event-overflow", is_error: true };
    expect(parse([childLegacy, parentResult])).toMatchObject({ sessionId: "s-parent", finalMessage: "parent done", costUsd: 0.25 });
    expect(parse([parentResult, { ...witness, parent_tool_use_id: CHILD }]).structuralTerminal).not.toMatchObject({ failed: true });
    expect(parse([parentResult, witness]).structuralTerminal).toMatchObject({ failed: true, code: "standing-orders-stream-event-overflow" });
  });

  test("a child's control answer never reports the parent paused", () => {
    let paused = 0;
    const session = new LiveInput({ maxTurns: 50, onPaused: () => { paused += 1; } });
    session.begin("brief");
    session.attach({ write: () => {}, end: () => {} });
    session.observe({ type: "assistant", message: { id: "m1" }, parent_tool_use_id: null });
    expect(session.interrupt("pause-1")).toBe("sent");
    const answer = { type: "control_response", response: { subtype: "success", request_id: "pause-1" } };
    session.observe({ ...answer, parent_tool_use_id: CHILD });
    expect(paused).toBe(0);
    session.observe(answer);
    expect(paused).toBe(1);
  });

  test("the lead's streamed reply: a child's frames neither show nor suppress the parent's text", () => {
    const frame = (inner: Record<string, unknown>, parent: string | null = null) => JSON.stringify({ type: "stream_event", event: inner, parent_tool_use_id: parent }) + "\n";
    const start = { type: "content_block_start", content_block: { type: "tool_use", name: "StructuredOutput", input: {} } };
    const other = { type: "content_block_start", content_block: { type: "text" } };
    const delta = (partial: string) => ({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: partial } });
    const seen: string[] = [];
    const read = claudeStreamReader(text => seen.push(text));
    read(frame(start, CHILD) + frame(delta('{"text": "Child'), CHILD));
    read(frame(start) + frame(other, CHILD) + frame(delta('{"text": "Par')) + frame(delta(' child', ), CHILD) + frame(delta('ent"')));
    expect(seen).toEqual(["Par", "Parent"]);
  });

  test("the scout's plan-file mark: a child's ExitPlanMode or plan-file write is not the scout's", () => {
    const call = (block: Record<string, unknown>, parent: string | null) => ({ type: "assistant", message: { content: [{ type: "tool_use", ...block }] }, parent_tool_use_id: parent });
    const exit = { name: "ExitPlanMode", input: {} };
    const write = { name: "Write", input: { file_path: "/Users/a/.claude/plans/p.md" } };
    expect([call(exit, CHILD), call(write, CHILD)].map(touchesPlanFile)).toEqual([false, false]);
    expect([call(exit, null), call(write, null)].map(touchesPlanFile)).toEqual([true, true]);
  });
});

describe("the claude streaming transport", () => {
  const line = (event: Record<string, unknown>): string => `process.stdout.write(${JSON.stringify(JSON.stringify(event))}+"\\n");`;

  test("child events fire no receipt, save no session, raise no conflict, and are not the result", async () => {
    const readings: LimitReading[] = [];
    const release = pushLimitSink(reading => readings.push(reading));
    const childOnly = await (async () => {
      let receipts = 0;
      const sessions: string[] = [];
      const result = await runClaudeStreamJsonl(process.execPath, ["-e", CHILD_EVENTS.map(([, event]) => line(event)).join("\n")], {
        timeoutMs: 30_000, onReceipt: () => { receipts += 1; }, onSessionId: id => { sessions.push(id); },
      });
      return { receipts, sessions, stdout: result.stdout };
    })();
    expect(childOnly).toEqual({ receipts: 0, sessions: [], stdout: expect.not.stringContaining("s-child") });
    expect(readings).toEqual([]); // a child's limit window is never published

    let receipts = 0;
    const sessions: string[] = [];
    const script = [
      line(childInit),
      line({ type: "system", subtype: "init", session_id: "s-parent" }),
      line(childInit),
      line(childAssistant),
      line(childResult),
      line({ type: "result", subtype: "success", is_error: false, result: "parent done", session_id: "s-parent", total_cost_usd: 0.25 }),
    ].join("\n");
    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 30_000, onReceipt: () => { receipts += 1; }, onSessionId: id => { sessions.push(id); },
    });
    expect(sessions).toEqual(["s-parent"]);
    expect(receipts).toBe(1); // the parent's own success result, once
    expect(result.stdout).not.toContain("s-child");
    const parsed = adapterFor("claude").parse(result.stdout);
    expect(parsed).toMatchObject({ sessionId: "s-parent", finalMessage: "parent done", costUsd: 0.25 });
    expect(parsed.protocolError ?? null).toBeNull();
    // The session's own window still publishes.
    await runClaudeStreamJsonl(process.execPath, ["-e", line(rateLimit)], { timeoutMs: 30_000 });
    release();
    expect(readings).toHaveLength(1);
  });
});

describe("the lead's subscription turn", () => {
  test("a child's init and result are neither its billing nor its answer", async () => {
    const answer = { type: "result", subtype: "success", is_error: false, structured_output: { text: "Parent answer", calls: [] }, usage: { input_tokens: 3, output_tokens: 4 } };
    const childAnswer = { ...answer, structured_output: { text: "Child answer", calls: [] }, parent_tool_use_id: CHILD };
    const stdout = [{ type: "system", subtype: "init" }, childInit, childRateLimit, answer, childAnswer].map(event => JSON.stringify(event)).join("\n") + "\n";
    const readings: LimitReading[] = [];
    const release = pushLimitSink(reading => readings.push(reading));
    const result = await performSubscriptionLeadRequest({
      provider: "claude-subscription", model: "default", system: "s", dataDocument: "d", history: [{ role: "operator", text: "hi" }], tools: [], timeoutMs: 5_000, onText: () => undefined,
    }, async () => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false }));
    expect(result).toMatchObject({ ok: true, answer: { text: "Parent answer" } });
    release();
    // No limit window from the child; billing from the parent's own init alone (no key source, no windows) says nothing.
    expect(readings.filter(reading => reading.windows.length > 0)).toEqual([]);
  });
});
