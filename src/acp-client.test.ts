import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ACP_AGENT_REQUESTS_CAP, ACP_LINE_CAP, acpParse, createAcpConversation, permissionAnswer, type AcpConversation } from "./acp-client.js";

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

  test("Gemini: the model chosen by set_model; a quota error on the prompt is a failed terminal, never success", () => {
    const model = gemini["session/new"].models.availableModels[1].modelId as string;
    const conversation = createAcpConversation({ cwd: "<work>", prompt: "x", model, expect: GEMINI });
    const [init] = sent(conversation.start());
    const [open] = sent(conversation.receive(answer(init!.id, gemini["initialize"])).send);
    const [choose] = sent(conversation.receive(answer(open!.id, gemini["session/new"])).send);
    expect(choose).toMatchObject({ method: "session/set_model", params: { sessionId: gemini["sessionId"], modelId: model } });
    const [prompt] = sent(conversation.receive(answer(choose!.id, {})).send);
    conversation.receive(update(gemini["sessionId"], gemini["updates"][0]));
    conversation.receive(failWith(prompt!.id, gemini["promptError"]));
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
    for (const bad of ["{not json", JSON.stringify({ id: 1, result: {} }), JSON.stringify([1]), `"${"x".repeat(ACP_LINE_CAP)}"`]) {
      const { conversation } = ready();
      conversation.receive(bad);
      expect(conversation.failure()).toMatchObject({ kind: "protocol" });
      expect(acpParse(conversation.retained()).protocolError).not.toBeNull();
    }
  });

  test("a response nobody asked for, a second answer, or one with both result and error fails", () => {
    const stray = ready();
    stray.conversation.receive(answer(999, {}));
    expect(stray.conversation.failure()).toMatchObject({ kind: "protocol" });

    const twice = ready();
    twice.conversation.receive(answer(twice.prompt.id, { stopReason: "end_turn" }));
    twice.conversation.receive(answer(twice.prompt.id, { stopReason: "end_turn" }));
    expect(acpParse(twice.conversation.retained())).toMatchObject({ promptConsumed: false });
    expect(twice.conversation.failure()).toMatchObject({ kind: "protocol" });

    const both = ready();
    both.conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: both.prompt.id, result: { stopReason: "end_turn" }, error: { code: 1, message: "x" } }));
    expect(acpParse(both.conversation.retained())).toMatchObject({ promptConsumed: false });
  });

  test("an update or permission request for another session fails", () => {
    const other = ready();
    other.conversation.receive(update("ses_someone_else", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }));
    expect(other.conversation.failure()).toMatchObject({ kind: "protocol" });
    const asking = ready();
    asking.conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "nope", options: [] } }));
    expect(asking.conversation.failure()).toMatchObject({ kind: "protocol" });
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
    const onlyAlways = conversation.receive(ask(6, [{ optionId: "always", kind: "allow_always" }, { optionId: "never", kind: "reject_always" }]));
    expect(sent(onlyAlways.send)[0]).toMatchObject({ id: 6, error: { code: -32602 } });
    const refused = conversation.receive(ask(8, [{ optionId: "no", kind: "reject_once" }]));
    expect(sent(refused.send)[0]).toMatchObject({ id: 8, result: { outcome: { optionId: "no" } } });
    expect(permissionAnswer({ options: "x" })).toBeNull();
  });

  test("every client method the plane doesn't offer is refused, and an agent that asks without end is stopped", () => {
    const conversation = ready();
    for (const method of ["fs/read_text_file", "fs/write_text_file", "terminal/create"]) {
      const reply = sent(conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} })).send);
      expect(reply).toEqual([{ jsonrpc: "2.0", id: method, error: { code: -32601, message: "this client offers no such method" } }]);
    }
    for (let i = 0; i < ACP_AGENT_REQUESTS_CAP; i += 1) conversation.receive(JSON.stringify({ jsonrpc: "2.0", id: `r${i}`, method: "fs/read_text_file", params: {} }));
    expect(conversation.failure()).toMatchObject({ kind: "protocol" });
  });

  test("cancel is a notification for this session, only while the prompt runs; the final message is the words after the last step", () => {
    const conversation = ready();
    conversation.receive(update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking around." } }));
    conversation.receive(update(sid, opencode["updates"][1]));
    conversation.receive(update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Stopped." } }));
    expect(sent(conversation.cancel())).toEqual([{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } }]);
    const prompt = 4; // initialize 1, session/new 2, model 3, prompt 4
    conversation.receive(answer(prompt, { stopReason: "cancelled" }));
    expect(conversation.cancel()).toEqual([]);
    expect(acpParse(conversation.retained())).toMatchObject({ finalMessage: "Stopped.", terminal: { code: "cancelled" } });
  });

  test("the agent's usage report is kept apart, unpriced", () => {
    const conversation = ready();
    conversation.receive(update(sid, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.42, currency: "USD" } }));
    conversation.receive(answer(4, { stopReason: "end_turn" }));
    const parsed = acpParse(conversation.retained());
    expect(parsed.reportedUsage).toContain("0.42");
    expect(parsed).not.toHaveProperty("costUsd");
  });
});
