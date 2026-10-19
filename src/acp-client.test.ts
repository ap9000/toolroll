import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ACP_LINE_CAP, acpParse, createAcpConversation, permissionAnswer, type AcpConversation } from "./acp-client.js";

// Real transcripts, recorded 2026-10-19 (docs/plans/acp-adapter.md § Evidence).
const opencode = JSON.parse(readFileSync(new URL("./fixtures/acp/opencode-1.18.18.json", import.meta.url), "utf8")) as Record<string, any>;
const gemini = JSON.parse(readFileSync(new URL("./fixtures/acp/gemini-0.60.0.json", import.meta.url), "utf8")) as Record<string, any>;

const OPENCODE = { name: "OpenCode", version: "1.18.18" };
const GEMINI = { name: "gemini-cli", version: "0.60.0" };

type Sent = { id?: number; method?: string; params?: any; result?: any; error?: any };
const sent = (lines: string[]): Sent[] => lines.map(one => JSON.parse(one) as Sent);
const answer = (id: number | undefined, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const failWith = (id: number | undefined, error: unknown) => JSON.stringify({ jsonrpc: "2.0", id, error });
const update = (sessionId: string, body: unknown) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });

/** Drive a conversation through the handshake with the recorded answers; returns the prompt request. */
function handshake(conversation: AcpConversation, fixture: Record<string, any>, modelAnswer: unknown = fixture["set_config_option"] ?? {}): Sent {
  const [init] = sent(conversation.start());
  expect(init).toMatchObject({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
  const [open] = sent(conversation.receive(answer(init!.id, fixture["initialize"])).send);
  expect(open).toMatchObject({ method: "session/new", params: { cwd: "<work>", mcpServers: [] } });
  const [choose] = sent(conversation.receive(answer(open!.id, fixture["session/new"])).send);
  const [prompt] = sent(conversation.receive(answer(choose!.id, modelAnswer)).send);
  return prompt!;
}

describe("the ACP conversation, against real agents", () => {
  test("OpenCode: handshake, the model chosen by config option and seen current, the brief sent, the steps streamed", () => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "Build the thing.", model: "google/gemini-2.5-flash", expect: OPENCODE });
    const prompt = handshake(conversation, opencode);
    expect(conversation.mechanism()).toBe("config-option");
    expect(conversation.offered()).toContain("opencode/big-pickle");
    expect(prompt).toMatchObject({ method: "session/prompt", params: { sessionId: opencode["sessionId"], prompt: [{ type: "text", text: "Build the thing." }] } });
    const live = opencode["updates"].flatMap((one: unknown) => conversation.receive(update(opencode["sessionId"], one)).live);
    expect(live.map((one: any) => one.sessionUpdate)).toEqual(opencode["updates"].map((one: any) => one.sessionUpdate));
    expect(conversation.phase()).toBe("prompt");
    // The recorded turn stalled here: no answer, no success — whatever the exit code.
    const stalled = acpParse(conversation.retained());
    expect(stalled).toMatchObject({ sessionId: opencode["sessionId"], initObserved: true, promptConsumed: false, terminal: null, protocolError: null });
    conversation.receive(update(opencode["sessionId"], { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: " } }));
    conversation.receive(update(opencode["sessionId"], { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "made done.txt." } }));
    conversation.receive(answer(prompt.id, { stopReason: "end_turn" }));
    expect(acpParse(conversation.retained())).toMatchObject({ promptConsumed: true, terminal: null, finalMessage: "Done: made done.txt.", protocolError: null });
    // OpenCode offers session/close.
    const [close] = sent(conversation.close());
    expect(close).toMatchObject({ method: "session/close", params: { sessionId: opencode["sessionId"] } });
    expect(conversation.closeAnswered()).toBe(false);
    conversation.receive(answer(close!.id, {}));
    expect(conversation.closeAnswered()).toBe(true);
  });

  test("OpenCode: a model it doesn't offer is never set and no prompt is sent; a refused or unechoed choice stops it too", () => {
    const unknown = createAcpConversation({ cwd: "<work>", prompt: "x", model: "nope/not-a-model", expect: OPENCODE });
    const [init] = sent(unknown.start());
    const [open] = sent(unknown.receive(answer(init!.id, opencode["initialize"])).send);
    expect(unknown.receive(answer(open!.id, opencode["session/new"])).send).toEqual([]);
    expect(unknown.failure()).toMatchObject({ kind: "model-unavailable" });

    const refused = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    const [i2] = sent(refused.start());
    const [o2] = sent(refused.receive(answer(i2!.id, opencode["initialize"])).send);
    const [c2] = sent(refused.receive(answer(o2!.id, opencode["session/new"])).send);
    expect(refused.receive(failWith(c2!.id, opencode["set_config_option_unknown"])).send).toEqual([]);
    expect(refused.failure()).toMatchObject({ kind: "model-unavailable" });

    // The agent answers but leaves a different model current.
    const unechoed = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    const wrong = JSON.parse(JSON.stringify(opencode["set_config_option"]));
    wrong.configOptions[0].currentValue = "opencode/big-pickle";
    const [i3] = sent(unechoed.start());
    const [o3] = sent(unechoed.receive(answer(i3!.id, opencode["initialize"])).send);
    const [c3] = sent(unechoed.receive(answer(o3!.id, opencode["session/new"])).send);
    expect(unechoed.receive(answer(c3!.id, wrong)).send).toEqual([]);
    expect(unechoed.failure()).toMatchObject({ kind: "model-unavailable" });
    expect(acpParse(unechoed.retained())).toMatchObject({ promptConsumed: false, terminal: { failed: true, code: "model-unavailable" } });
  });

  test("Gemini: an agent that can only set_model (nothing to observe) is refused before any prompt", () => {
    const model = gemini["session/new"].models.availableModels[1].modelId as string;
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model, expect: GEMINI });
    const [init] = sent(conversation.start());
    const [open] = sent(conversation.receive(answer(init!.id, gemini["initialize"])).send);
    expect(conversation.receive(answer(open!.id, gemini["session/new"])).send).toEqual([]);
    expect(conversation.mechanism()).toBe("set-model");
    expect(conversation.failure()).toMatchObject({ kind: "model-unavailable" });
  });

  test("Gemini's real quota error, answering a prompt, is a failed terminal — never success", () => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    const prompt = handshake(conversation, opencode);
    conversation.receive(failWith(prompt.id, gemini["promptError"]));
    expect(conversation.phase()).toBe("ended");
    const parsed = acpParse(conversation.retained());
    expect(parsed).toMatchObject({ promptConsumed: false, terminal: { failed: true, code: "rpc:429" } });
    expect(parsed.diagnostic).toMatch(/exceeded your current quota/);
  });
});

describe("the ACP conversation fails closed", () => {
  const ready = (): { conversation: AcpConversation; prompt: Sent } => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    return { conversation, prompt: handshake(conversation, opencode) };
  };
  const sid = opencode["sessionId"] as string;

  test("an agent that is not the checked one is stopped before a session opens", () => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "m", expect: { name: "OpenCode", version: "1.18.19" } });
    const [init] = sent(conversation.start());
    expect(conversation.receive(answer(init!.id, opencode["initialize"])).send).toEqual([]);
    expect(conversation.failure()).toMatchObject({ kind: "identity" });
    const nameless = createAcpConversation({ cwd: "<work>", prompt: "x", model: "m", expect: null });
    const [i2] = sent(nameless.start());
    nameless.receive(answer(i2!.id, { ...opencode["initialize"], agentInfo: undefined }));
    expect(nameless.failure()).toMatchObject({ kind: "identity" });
    const v2 = createAcpConversation({ cwd: "<work>", prompt: "x", model: "m", expect: null });
    const [i3] = sent(v2.start());
    v2.receive(answer(i3!.id, { ...opencode["initialize"], protocolVersion: 2 }));
    expect(v2.failure()).toMatchObject({ kind: "protocol" });
  });

  test("updates alone — and exit — never make a success", () => {
    const { conversation } = ready();
    conversation.receive(update(sid, opencode["updates"][0]));
    expect(acpParse(conversation.retained())).toMatchObject({ promptConsumed: false, terminal: null });
  });

  test("every stop reason but end_turn fails; an unknown or missing one is a protocol failure", () => {
    for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "cancelled"]) {
      const { conversation, prompt } = ready();
      conversation.receive(answer(prompt.id, { stopReason }));
      expect(acpParse(conversation.retained())).toMatchObject({ promptConsumed: false, terminal: { failed: true, code: stopReason } });
    }
    for (const result of [{ stopReason: "done" }, {}, { stopReason: 1 }]) {
      const { conversation, prompt } = ready();
      conversation.receive(answer(prompt.id, result));
      expect(acpParse(conversation.retained())).toMatchObject({ promptConsumed: false, protocolError: expect.stringMatching(/protocol/) });
    }
  });

  test("malformed, oversized and non-JSON-RPC lines are protocol failures", () => {
    // The cap is in bytes: a line of three-byte characters under the cap in characters is still over it.
    for (const bad of ["{not json", JSON.stringify({ id: 1, result: {} }), JSON.stringify([1]), `"${"x".repeat(ACP_LINE_CAP)}"`, `"${"€".repeat(400_000)}"`]) {
      const { conversation } = ready();
      conversation.receive(bad);
      expect(conversation.failure()).toMatchObject({ kind: "protocol" });
      expect(acpParse(conversation.retained()).protocolError).not.toBeNull();
    }
  });

  test("a response nobody asked for, a second answer, or one with both result and error fails", () => {
    // An answer to our prompt must name its id exactly: 4.0000000000000001 is not 4.
    const rounded = ready();
    rounded.conversation.receive(`{"jsonrpc":"2.0","id":4.0000000000000001,"result":{"stopReason":"end_turn"}}`);
    expect(acpParse(rounded.conversation.retained())).toMatchObject({ promptConsumed: false });
    expect(rounded.conversation.failure()).toMatchObject({ kind: "protocol" });
    const stray = ready();
    stray.conversation.receive(answer(999, {}));
    expect(stray.conversation.failure()).toMatchObject({ kind: "protocol" });

    const twice = ready();
    twice.conversation.receive(answer(twice.prompt.id, { stopReason: "end_turn" }));
    twice.conversation.receive(answer(twice.prompt.id, { stopReason: "end_turn" }));
    expect(acpParse(twice.conversation.retained())).toMatchObject({ promptConsumed: false });
    expect(twice.conversation.failure()).toMatchObject({ kind: "protocol" });

    for (const error of [{ code: 1, message: "x" }, null, { code: "1", message: "x" }]) {
      const both = ready();
      both.conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: both.prompt.id, result: { stopReason: "end_turn" }, error }));
      expect(acpParse(both.conversation.retained())).toMatchObject({ promptConsumed: false });
      expect(both.conversation.failure()).toMatchObject({ kind: "protocol" });
    }
    const malformed = ready();
    malformed.conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: malformed.prompt.id, error: { message: "no code" } }));
    expect(malformed.conversation.failure()).toMatchObject({ kind: "protocol" });
  });

  test("an update or permission request for another session fails", () => {
    const other = ready();
    other.conversation.receive(update("ses_someone_else", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }));
    expect(other.conversation.failure()).toMatchObject({ kind: "protocol" });
    const asking = ready();
    asking.conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "nope", options: [] } }));
    expect(asking.conversation.failure()).toMatchObject({ kind: "protocol" });
    // Any notification naming another session, and an update with no kind, fail too.
    const stranger = ready();
    stranger.conversation.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/something_new", params: { sessionId: "ses_other" } }));
    expect(stranger.conversation.failure()).toMatchObject({ kind: "protocol" });
    for (const body of [
      {}, { sessionUpdate: 3 }, { sessionUpdate: "tool_call" }, { sessionUpdate: "tool_call_update" }, { sessionUpdate: "agent_message_chunk", content: "hi" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text" } },
      { sessionUpdate: "plan", entries: [{ content: 1 }] },
      { sessionUpdate: "tool_call", toolCallId: "t", title: "x", kind: "teleport" },
      { sessionUpdate: "tool_call_update", toolCallId: "t", status: "done" },
      { sessionUpdate: "tool_call_update", toolCallId: "t", locations: [{ line: 3 }] },
      { sessionUpdate: "tool_call_update", toolCallId: "t", content: [{ type: "content", content: { type: "text" } }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "resource", resource: { uri: "file:///x" } } },
      { sessionUpdate: "plan", entries: [{ content: "x", priority: "urgent", status: "pending" }] },
      { sessionUpdate: "plan", entries: [{ content: "x", priority: "high", status: "skipped" }] },
      { sessionUpdate: "tool_call_update", toolCallId: "t", locations: [{ path: "/a", line: "3" }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "resource", resource: { uri: "file:///x", text: "t", mimeType: 123 } } },
      { sessionUpdate: "tool_call_update", toolCallId: "t", content: [{ type: "content", content: { type: "resource_link", uri: "file:///x", name: "x", description: 123 } }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi", annotations: "x" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "u", name: "n", size: 1.5 } },
    ]) {
      const kindless = ready();
      kindless.conversation.receive(update(sid, body));
      expect(kindless.conversation.failure()).toMatchObject({ kind: "protocol" });
    }
  });

  test("a sign-in the agent wants is its own failure", () => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "m", expect: OPENCODE });
    const [init] = sent(conversation.start());
    const [open] = sent(conversation.receive(answer(init!.id, opencode["initialize"])).send);
    conversation.receive(failWith(open!.id, { code: -32000, message: "Authentication required" }));
    expect(conversation.failure()).toMatchObject({ kind: "auth-required" });
    expect(acpParse(conversation.retained())).toMatchObject({ initObserved: false, terminal: { code: "auth-required" } });
  });
});

describe("what the plane answers the agent", () => {
  const sid = opencode["sessionId"] as string;
  const ready = () => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    handshake(conversation, opencode);
    return conversation;
  };
  const ask = (id: number, options: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "t1", title: "rm", kind: "execute" }, options } });

  test("a permission request is granted once — never always — and refused when only refusal is offered", () => {
    const conversation = ready();
    const granted = conversation.receive(ask(5, [
      { optionId: "always", kind: "allow_always", name: "Always" },
      { optionId: "once", kind: "allow_once", name: "Once" },
      { optionId: "no", kind: "reject_once", name: "No" },
    ]));
    expect(sent(granted.send)).toEqual([{ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "once" } } }]);
    expect(granted.live).toEqual([{ sessionUpdate: "permission", toolCallId: "t1", title: "rm", kind: "execute", granted: true }]);
    const onlyAlways = conversation.receive(ask(6, [{ optionId: "always", kind: "allow_always", name: "Always" }, { optionId: "never", kind: "reject_always", name: "Never" }]));
    expect(sent(onlyAlways.send)[0]).toMatchObject({ id: 6, error: { code: -32602 } });
    expect(onlyAlways.live).toEqual([{ sessionUpdate: "permission", toolCallId: "t1", title: "rm", kind: "execute", granted: false }]);
    const refused = conversation.receive(ask(8, [{ optionId: "no", kind: "reject_once", name: "No" }]));
    expect(sent(refused.send)[0]).toMatchObject({ id: 8, result: { outcome: { optionId: "no" } } });
    // A request without a tool call is never granted, and still shows.
    const callless = conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { sessionId: sid, options: [{ optionId: "once", kind: "allow_once", name: "Once" }] } }));
    expect(sent(callless.send)[0]).toMatchObject({ id: 9, error: { code: -32602 } });
    expect(callless.live).toEqual([{ sessionUpdate: "permission", toolCallId: null, title: null, kind: null, granted: false }]);
    // Nor is a request whose tool call is malformed further down.
    for (const toolCall of [
      { toolCallId: "t5", content: [{ type: "content", content: { type: "text", text: "x", annotations: { audience: ["system"] } } }] },
      { toolCallId: "t7", locations: [{ path: "/a", _meta: 123 }] },
      { toolCallId: "t8", name: 123 },
      { toolCallId: "t6", _meta: 123 },
      { toolCallId: "t2", content: [{ type: "content", content: { type: "resource", resource: { uri: "file:///x" } } }] },
      { toolCallId: "t3", locations: [{ path: "/a", line: "3" }] },
      { toolCallId: "t4", kind: "teleport" },
    ]) {
      const malformed = conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: `m-${toolCall.toolCallId}`, method: "session/request_permission", params: { sessionId: sid, toolCall, options: [{ optionId: "once", kind: "allow_once", name: "Once" }] } }));
      expect(sent(malformed.send)[0]).toMatchObject({ error: { code: -32602 } });
      expect(malformed.live[0]).toMatchObject({ granted: false });
    }
    // Once the prompt is answered, nothing more is granted.
    conversation.receive(answer(4, { stopReason: "end_turn" }));
    const after = conversation.receive(ask(10, [{ optionId: "once", kind: "allow_once", name: "Once" }]));
    expect(sent(after.send)[0]).toMatchObject({ id: 10, result: { outcome: { outcome: "cancelled" } } });
    expect(permissionAnswer({ options: "x" })).toBeNull();
    // The whole list must be well formed: a malformed entry, an unknown kind or an id twice chooses nothing.
    expect(permissionAnswer({ options: [{ optionId: "once", kind: "allow_once", name: "Once" }, "junk"] })).toBeNull();
    expect(permissionAnswer({ options: [{ optionId: "once", kind: "allow_once", name: "Once" }, { optionId: "x", kind: "allow_sometimes", name: "x" }] })).toBeNull();
    expect(permissionAnswer({ options: [{ optionId: "same", kind: "allow_once", name: "a" }, { optionId: "same", kind: "allow_always", name: "b" }] })).toBeNull();
    expect(permissionAnswer({ options: [] })).toBeNull();
    expect(permissionAnswer({ options: [{ optionId: "once", kind: "allow_once" }] })).toBeNull();
    expect(permissionAnswer({ _meta: 123, options: [{ optionId: "once", kind: "allow_once", name: "Once" }] })).toBeNull();
    expect(permissionAnswer({ _meta: { a: 1 }, options: [{ optionId: "once", kind: "allow_once", name: "Once", _meta: null }] })).toEqual({ optionId: "once", granted: true });
    // An id that wouldn't come back as sent is never answered with a grant.
    for (const raw of ['{"jsonrpc":"2.0","id":1.0000000000000001,"method":"session/request_permission","params":{}}', '{"jsonrpc":"2.0","id":1.5,"method":"session/request_permission","params":{}}', '{"jsonrpc":"2.0","id":9223372036854775808,"method":"session/request_permission","params":{}}', '{"jsonrpc":"2.0","id":1e999,"method":"session/request_permission","params":{}}']) {
      const fresh = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
      handshake(fresh, opencode);
      expect(fresh.receive(raw.replace("{}", JSON.stringify({ sessionId: sid, toolCall: { toolCallId: "t" }, options: [{ optionId: "once", kind: "allow_once", name: "Once" }] }))).send).toEqual([]);
      expect(fresh.failure()).toMatchObject({ kind: "protocol" });
    }
    // An integer id is answered under exactly the integer it writes — past 2^53, as 4e0, as -0 — and null under null.
    for (const [token, echoed] of [["9007199254740993", "9007199254740993"], ["4e0", "4"], ["-0", "0"], ["1.0", "1"], ["null", "null"]]) {
      const fresh = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
      handshake(fresh, opencode);
      const sent = fresh.receive(`{"jsonrpc":"2.0","id":${token},"method":"session/request_permission","params":${JSON.stringify({ sessionId: sid, toolCall: { toolCallId: "t" }, options: [{ optionId: "once", kind: "allow_once", name: "Once" }] })}}`).send;
      expect(sent).toEqual([`{"jsonrpc":"2.0","id":${echoed},"result":{"outcome":{"outcome":"selected","optionId":"once"}}}`]);
      expect(fresh.failure()).toBeNull();
    }
  });

  test("every client method the plane doesn't offer is refused, each answered at once — however many", () => {
    const conversation = ready();
    for (const method of ["fs/read_text_file", "fs/write_text_file", "terminal/create"]) {
      const reply = sent(conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} })).send);
      expect(reply).toEqual([{ jsonrpc: "2.0", id: method, error: { code: -32601, message: "this client offers no such method" } }]);
    }
    for (let i = 0; i < 1500; i += 1) expect(conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: `r${i}`, method: "fs/read_text_file", params: {} })).send).toHaveLength(1);
    expect(conversation.failure()).toBeNull();
  });

  test("cancel is a notification for this session, only while the prompt runs; the final message is the words after the last step", () => {
    const conversation = ready();
    conversation.receive(update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking around." } }));
    conversation.receive(update(sid, opencode["updates"][1]));
    conversation.receive(update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Stopped." } }));
    expect(sent(conversation.cancel())).toEqual([{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } }]);
    // After a cancel, nothing more is granted: a permission request is answered "cancelled".
    const late = conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "t9" }, options: [{ optionId: "once", kind: "allow_once", name: "Once" }] } }));
    expect(sent(late.send)).toEqual([{ jsonrpc: "2.0", id: 50, result: { outcome: { outcome: "cancelled" } } }]);
    expect(late.live[0]).toMatchObject({ granted: false });
    const prompt = 4; // initialize 1, session/new 2, model 3, prompt 4
    conversation.receive(answer(prompt, { stopReason: "cancelled" }));
    expect(conversation.cancel()).toEqual([]);
    expect(acpParse(conversation.retained())).toMatchObject({ finalMessage: "Stopped.", terminal: { code: "cancelled" } });
  });

  test("the agent's usage reports are kept apart, unpriced — both of them, whatever the outcome", () => {
    const conversation = ready();
    conversation.receive(update(sid, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.42, currency: "USD" } }));
    conversation.receive(answer(4, { stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 300 } }));
    const parsed = acpParse(conversation.retained());
    expect(parsed.reportedUsage).toContain("0.42");
    expect(parsed.reportedUsage).toContain("900");
    expect(parsed).not.toHaveProperty("costUsd");
    const failed = ready();
    failed.receive(update(sid, { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.07, currency: "USD" } }));
    failed.receive(failWith(4, { code: 429, message: "quota" }));
    expect(acpParse(failed.retained()).reportedUsage).toContain("0.07");
  });
});

describe("the schema, as it is written", () => {
  const sid = opencode["sessionId"] as string;
  const handshakeWith = (initialize: Record<string, unknown>) => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    const [init] = sent(conversation.start());
    conversation.receive(answer(init!.id, initialize));
    return conversation;
  };

  test("capabilities may be left out but never null; unknown session capabilities are left alone", () => {
    for (const bad of [
      { agentCapabilities: null }, { authMethods: null },
      { agentCapabilities: { ...opencode["initialize"].agentCapabilities, promptCapabilities: null } },
      { agentCapabilities: { ...opencode["initialize"].agentCapabilities, auth: { logout: 3 } } },
    ]) expect(handshakeWith({ ...opencode["initialize"], ...bad }).failure()).toMatchObject({ kind: "protocol" });
    const future = handshakeWith({ ...opencode["initialize"], agentCapabilities: { ...opencode["initialize"].agentCapabilities, sessionCapabilities: { close: {}, _future: true } } });
    expect(future.failure()).toBeNull();
    // fork and load aren't in v1's session capabilities: the agent's own, and not read.
    const unread = handshakeWith({ ...opencode["initialize"], agentCapabilities: { ...opencode["initialize"].agentCapabilities, sessionCapabilities: { fork: true, load: 3 } } });
    expect(unread.failure()).toBeNull();
  });

  test("integers are judged only where the client reads them, exactly and in their schema's range", () => {
    const line = (raw: string) => {
      const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
      handshake(conversation, opencode);
      conversation.receive(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":${raw}}}`);
      return conversation.failure();
    };
    // Exact integers, however written: zero at any exponent, trailing zeros past the point.
    for (const ok of ["0e-999", "0e999", `1.${"0".repeat(401)}`, "3.0e1"]) expect(line(`{"sessionUpdate":"tool_call_update","toolCallId":"t","locations":[{"path":"/a","line":${ok}}]}`)).toBeNull();
    for (const bad of ["1.0000000000000001", "4294967296", "-1", "1e-1"]) expect(line(`{"sessionUpdate":"tool_call_update","toolCallId":"t","locations":[{"path":"/a","line":${bad}}]}`)).toMatchObject({ kind: "protocol" });
    // 64-bit fields hold 64-bit values, past JavaScript's safe range.
    expect(line(`{"sessionUpdate":"usage_update","used":9007199254740993,"size":18446744073709551615}`)).toBeNull();
    expect(line(`{"sessionUpdate":"usage_update","used":1,"size":18446744073709551616}`)).toMatchObject({ kind: "protocol" });
    // …and are shown and kept as the agent wrote them, never rounded to the nearest double.
    const exact = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    handshake(exact, opencode);
    const shown = exact.receive(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"usage_update","used":9007199254740993,"size":18446744073709551615}}}`).live;
    expect(shown).toEqual([{ sessionUpdate: "usage_update", used: "9007199254740993", size: "18446744073709551615" }]);
    expect(exact.retained()).toContain('\\"used\\":\\"9007199254740993\\"');
    // Opaque data is never judged: raw input, metadata, a nested message-looking object.
    expect(line(`{"sessionUpdate":"tool_call_update","toolCallId":"t","rawInput":{"line":1.0000000000000001,"size":1e400,"jsonrpc":"2.0","id":1e3},"_meta":{"code":0.5}}`)).toBeNull();
    // An embedded resource matches one shape; the other shape's field, malformed, is the agent's own.
    expect(line(`{"sessionUpdate":"agent_message_chunk","content":{"type":"resource","resource":{"uri":"u","text":"ok","blob":123}}}`)).toBeNull();
    expect(line(`{"sessionUpdate":"agent_message_chunk","content":{"type":"resource","resource":{"uri":"u","blob":"b","text":123}}}`)).toBeNull();
    expect(line(`{"sessionUpdate":"agent_message_chunk","content":{"type":"resource","resource":{"uri":"u","text":123,"blob":123}}}`)).toMatchObject({ kind: "protocol" });
  });

  test("an integer may be written 1e3; an update's fields may be null; a choice with an extra list is still just a choice", () => {
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    handshake(conversation, opencode);
    conversation.receive(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"tool_call_update","toolCallId":"t","locations":[{"path":"/a","line":1e3}],"title":null,"kind":null,"status":null}}}`);
    expect(conversation.failure()).toBeNull();
    // Validation and extraction agree: a flat choice carrying "options" offers its own value, not the nested one.
    const odd = createAcpConversation({ cwd: "<work>", prompt: "x", model: "google/gemini-2.5-flash", expect: OPENCODE });
    const [init] = sent(odd.start());
    const [open] = sent(odd.receive(answer(init!.id, opencode["initialize"])).send);
    odd.receive(answer(open!.id, { sessionId: sid, configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "other", options: [{ value: "other", name: "Other", options: [{ value: "google/gemini-2.5-flash" }] }] }] }));
    expect(odd.offered()).toEqual(["other"]);
    expect(odd.failure()).toMatchObject({ kind: "model-unavailable" });
  });
});

