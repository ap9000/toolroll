import { describe, test, expect } from "vitest";
import {
  strictJsonParse,
  parseAssistantEnvelope,
  parseProviderWrapper,
  performChatRequest,
  performLeadRequest,
  composeRequest,
  worstCaseMicrousd,
  settleMicrousd,
  credentialKeyOf,
  fetchOpenRouterCatalog,
  MAX_OUTPUT_TOKENS,
  REPLY_CAP_BYTES,
} from "./converse.js";

describe("strict JSON — what JSON.parse forgives, this refuses", () => {
  const parse = (text: string) => strictJsonParse(Buffer.from(text, "utf8"), 10_000, 4);

  test("duplicate keys are refused at every level", () => {
    expect(parse('{"a":1,"a":2}')).toMatchObject({ ok: false, problem: "duplicate-key" });
    expect(parse('{"a":{"b":1,"b":2}}')).toMatchObject({ ok: false, problem: "duplicate-key" });
    expect(parse('{"a":[{"x":1},{"x":1}]}')).toMatchObject({ ok: true }); // same key, different objects: fine
  });

  test("depth, size, and encoding are bounded", () => {
    expect(parse('{"a":{"b":{"c":{"d":{"e":1}}}}}')).toMatchObject({ ok: false, problem: "too-deep" });
    expect(strictJsonParse(Buffer.alloc(10_001, 0x20), 10_000)).toMatchObject({ ok: false, problem: "over-size" });
    expect(strictJsonParse(Buffer.from([0x22, 0xff, 0xfe, 0x22]), 10_000)).toMatchObject({ ok: false, problem: "not-utf8" });
    expect(parse('{"a":"escaped \\" quote","b":2}')).toMatchObject({ ok: true });
  });
});

describe("the assistant envelope — exactly one shape, atomic proposals", () => {
  const good = {
    chatEnvelope: 1,
    reply: "Two tasks are stalled behind the vendor hold.",
    proposals: [
      {
        kind: "task", repoId: "r1", title: "Fix the flaky webhook test", goal: "Deflake it.", outOfScope: null, touches: [],
        acceptance: [{ id: "c1", statement: "The webhook test no longer flakes.", how: null, evidence: ["check"] }],
      },
    ],
  };

  test("a valid envelope parses whole", () => {
    const parsed = parseAssistantEnvelope(JSON.stringify(good));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.envelope.proposals).toHaveLength(1);
    expect(parsed.proposalsDiscarded).toBe(false);
  });

  test("extra keys, wrong version, and oversize replies refuse the whole document", () => {
    expect(parseAssistantEnvelope(JSON.stringify({ ...good, extra: 1 }))).toMatchObject({ ok: false, problem: "wrong-keys" });
    expect(parseAssistantEnvelope(JSON.stringify({ ...good, chatEnvelope: 2 }))).toMatchObject({ ok: false, problem: "wrong-version" });
    expect(
      parseAssistantEnvelope(JSON.stringify({ ...good, reply: "x".repeat(REPLY_CAP_BYTES + 1) })),
    ).toMatchObject({ ok: false, problem: "bad-reply" });
    expect(parseAssistantEnvelope("the answer is: " + JSON.stringify(good))).toMatchObject({ ok: false });
  });

  test("one bad proposal discards ALL proposals but keeps the reply", () => {
    const mixed = {
      ...good,
      proposals: [
        ...good.proposals,
        { kind: "task", repoId: "r1", title: "ok", goal: "ok", outOfScope: null, touches: [], smuggled: true },
      ],
    };
    const parsed = parseAssistantEnvelope(JSON.stringify(mixed));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.proposalsDiscarded).toBe(true);
    expect(parsed.envelope.proposals).toHaveLength(0);
    expect(parsed.envelope.reply).toBe(good.reply);
  });

  test("proposal fields hold the door's honesty rules", () => {
    const bidi = { ...good, proposals: [{ ...good.proposals[0], title: "fix ‮gnihtemos" }] };
    expect(parseAssistantEnvelope(JSON.stringify(bidi))).toMatchObject({ ok: true, proposalsDiscarded: true });
    const badRepo = { ...good, proposals: [{ ...good.proposals[0], repoId: "/etc" }] };
    expect(parseAssistantEnvelope(JSON.stringify(badRepo))).toMatchObject({ ok: true, proposalsDiscarded: true });
    // Routines became scheduled flows (v115): a routine-shaped proposal is no longer a draft.
    const routine = {
      ...good,
      proposals: [
        {
          kind: "routine", repoId: "r2", name: "nightly-deps", goal: "g", outOfScope: null, touches: [], schedule: "daily:03:30",
          acceptance: [{ id: "c1", statement: "g happens.", how: null, evidence: ["manual-review"] }],
        },
      ],
    };
    expect(parseAssistantEnvelope(JSON.stringify(routine))).toMatchObject({ ok: true, proposalsDiscarded: true });
    const four = { ...good, proposals: Array.from({ length: 4 }, () => good.proposals[0]) };
    expect(parseAssistantEnvelope(JSON.stringify(four))).toMatchObject({ ok: false, problem: "bad-proposals" });
  });
});

describe("the provider wrapper — layer one", () => {
  test("anthropic: one text block with usage, tool use refused", () => {
    const valid = parseProviderWrapper(
      "anthropic-api",
      Buffer.from(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "{}" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      ),
    );
    expect(valid).toMatchObject({ ok: true, answer: { tokensIn: 100, tokensOut: 50 } });
    expect(
      parseProviderWrapper(
        "anthropic-api",
        Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text: "x" }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } })),
      ),
    ).toMatchObject({ ok: false, problem: "tool-call" });
    expect(
      parseProviderWrapper(
        "anthropic-api",
        Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], usage: { input_tokens: 1, output_tokens: 1 } })),
      ),
    ).toMatchObject({ ok: false, problem: "not-one-block" });
    expect(
      parseProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text: "x" }] }))),
    ).toMatchObject({ ok: false, problem: "no-usage" });
  });

  test("openrouter: one choice, tool calls refused, usage required", () => {
    const valid = parseProviderWrapper(
      "openrouter-api",
      Buffer.from(
        JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      ),
    );
    expect(valid).toMatchObject({ ok: true, answer: { tokensIn: 7, tokensOut: 3 } });
    expect(
      parseProviderWrapper(
        "openrouter-api",
        Buffer.from(JSON.stringify({ choices: [{ message: { content: "x", tool_calls: [] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })),
      ),
    ).toMatchObject({ ok: false, problem: "tool-call" });
  });
});

describe("money — pinned prices, integer micro-dollars, fail closed", () => {
  test("worst case covers every prompt byte and the whole output allowance", () => {
    const worst = worstCaseMicrousd("claude-sonnet-5", 3_000);
    expect(worst).toBe(1_000 * 3 + MAX_OUTPUT_TOKENS * 15);
    expect(worstCaseMicrousd("some-unpriced-model", 100)).toBeNull();
    expect(settleMicrousd("claude-sonnet-5", 100, 10)).toBe(300 + 150);
    expect(settleMicrousd("mystery", 1, 1)).toBeNull();
  });

  test("the credential identity is full-width and domain-separated", () => {
    const a = credentialKeyOf("anthropic-api", "sk-ant-xxx");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialKeyOf("openrouter-api", "sk-ant-xxx")).not.toBe(a);
  });
});

describe("the one network call", () => {
  test.each(["anthropic-api", "openrouter-api"] as const)("%s tool chat refuses auth, quota, service, and connection failures", async provider => {
    const request = { url: "https://provider.invalid/chat", headers: {}, body: "{}" };
    for (const status of [401, 429, 503]) {
      expect(await performLeadRequest(request, provider, new AbortController().signal, async () => new Response("{}", { status })))
        .toEqual({ ok: false, problem: `status-${status}` });
    }
    const failedFetch: typeof fetch = async () => { throw new Error("connection closed"); };
    expect(await performLeadRequest(request, provider, new AbortController().signal, failedFetch))
      .toEqual({ ok: false, problem: "network" });
    const aborted = new AbortController();
    aborted.abort();
    expect(await performLeadRequest(request, provider, aborted.signal, failedFetch))
      .toEqual({ ok: false, problem: "timeout" });
  });

  const args = {
    provider: "anthropic-api" as const,
    model: "claude-sonnet-5",
    key: "sk-test",
    dataDocument: '{"repos":[]}',
    userMessage: "what is stalled?",
    signal: new AbortController().signal,
  };

  const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

  test("a clean answer comes back parsed with usage", async () => {
    const result = await performChatRequest(args, async () =>
      jsonResponse({ type: "message", content: [{ type: "text", text: "{\"ok\":1}" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }),
    );
    expect(result).toMatchObject({ ok: true, answer: { text: '{"ok":1}' } });
  });

  test("bad status, wrong content type, and oversize bodies refuse typed", async () => {
    expect(await performChatRequest(args, async () => jsonResponse({}, { status: 500 }))).toMatchObject({ ok: false, problem: "status-500" });
    expect(
      await performChatRequest(args, async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })),
    ).toMatchObject({ ok: false, problem: "not-json-content" });
    const huge = new Response(new Uint8Array(300_000), { status: 200, headers: { "content-type": "application/json" } });
    expect(await performChatRequest(args, async () => huge)).toMatchObject({ ok: false, problem: "over-size" });
  });

  test("the request itself carries no tools and pins max_tokens", () => {
    const request = composeRequest({ provider: "anthropic-api", model: "m", key: "k", dataDocument: "{}", userMessage: "hi" });
    const body = JSON.parse(request.body);
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(request.headers["x-api-key"]).toBe("k");
    expect(body.system).toContain("one plain-language outcome is enough");
    expect(body.system).toContain("Ask at most three grouped questions");
    expect(body.system).toContain("use your judgment");
    // The operator message rides as JSON-encoded data, not instructions.
    expect(body.messages[0].content).toContain('"hi"');
  });
});

describe("the OpenRouter catalog — every model arrives with the price that will be pinned", () => {
  const catalog = (data: unknown) =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

  test("models parse with ceil'd micro-dollar prices; dynamic pricing is excluded, not guessed", async () => {
    const got = await fetchOpenRouterCatalog("sk-or-test", async () =>
      catalog([
        { id: "anthropic/claude-sonnet-5", pricing: { prompt: "0.000003", completion: "0.000015" } },
        { id: "cheap/model", pricing: { prompt: "0.0000001", completion: "0.0000002" } },
        { id: "free/model", pricing: { prompt: "0", completion: "0" } },
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "broken/model", pricing: { prompt: "soon", completion: "0.001" } },
      ]),
    );
    if (!got.ok) throw new Error(got.problem);
    const ids = got.models.map(one => one.id);
    expect(ids).toContain("anthropic/claude-sonnet-5");
    expect(ids).toContain("free/model");
    expect(ids).not.toContain("openrouter/auto");
    expect(ids).not.toContain("broken/model");
    const sonnet = got.models.find(one => one.id === "anthropic/claude-sonnet-5");
    expect(sonnet?.price).toEqual({ inMicrousd: 3, outMicrousd: 15 });
    // Sub-micro-dollar prices round UP to 1 — a paid model never reads free.
    const cheap = got.models.find(one => one.id === "cheap/model");
    expect(cheap?.price).toEqual({ inMicrousd: 1, outMicrousd: 1 });
    const free = got.models.find(one => one.id === "free/model");
    expect(free?.price).toEqual({ inMicrousd: 0, outMicrousd: 0 });
  });

  test("a broken catalog refuses typed — never an empty 'everything is free' list", async () => {
    expect(await fetchOpenRouterCatalog("k", async () => new Response("nope", { status: 500 }))).toMatchObject({
      ok: false,
      problem: "status-500",
    });
    expect(
      await fetchOpenRouterCatalog("k", async () => catalog("not-an-array")),
    ).toMatchObject({ ok: false, problem: "wrong-shape" });
  });
});
