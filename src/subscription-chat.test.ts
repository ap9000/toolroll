import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { run } from "./exec.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import {
  composeSubscriptionLeadPrompt,
  parseSubscriptionLeadAnswer,
  performSubscriptionLeadRequest,
  type SubscriptionLeadRequest,
} from "./subscription-chat.js";

const TOOLS = [{ name: "recap", description: "summarize", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] as const;

const request = (provider: SubscriptionLeadRequest["provider"]): SubscriptionLeadRequest => ({
  provider,
  model: "default",
  system: "SYSTEM-CANARY",
  dataDocument: "DATA-CANARY",
  history: [{ role: "operator", text: "hello" }],
  tools: TOOLS,
  timeoutMs: 12_345,
});

describe("subscription chat's isolated harness adapter", () => {
  test.each(["claude-subscription", "codex-subscription"] as const)("%s rejects failed or incomplete turns even with a valid tool proposal", async provider => {
    const answer = { text: "Synthetic proposal", calls: [{ id: "c1", name: "recap", argumentsJson: "{}" }] };
    const message = { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } };
    const cases = provider === "claude-subscription"
      ? [
          { type: "result", subtype: "error_max_turns", is_error: true, structured_output: answer },
          { type: "result", subtype: "success", is_error: true, structured_output: answer },
          { structured_output: answer },
        ].map(value => JSON.stringify(value))
      : [
          [message, { type: "turn.failed", error: { message: "Synthetic network failure" } }],
          [message],
          [message, { type: "turn.completed" }, { type: "turn.failed" }],
          [null, message, { type: "turn.completed" }],
        ].map(events => events.map(value => JSON.stringify(value)).join("\n"));
    for (const stdout of cases) {
      const result = await performSubscriptionLeadRequest(request(provider), async () => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false }));
      expect(result).toMatchObject({ ok: false, problem: "malformed-reply" });
    }
  });

  test("the prompt gives the harness no ambient-state authority", () => {
    const prompt = composeSubscriptionLeadPrompt(request("codex-subscription"));
    expect(prompt).toContain("Do not use any harness tools or inspect the computer");
    expect(prompt).toContain("SYSTEM-CANARY");
    expect(prompt).toContain("DATA-CANARY");
    expect(prompt).toContain('"name":"recap"');
  });

  test("strict output accepts bounded calls and refuses smuggled or duplicate fields", () => {
    const valid = parseSubscriptionLeadAnswer(JSON.stringify({
      text: "Let me recap.",
      calls: [{ id: "c1", name: "recap", argumentsJson: "{}" }],
    }), { tokensIn: 11, tokensOut: 7 });
    expect(valid).toMatchObject({ ok: true, answer: { text: "Let me recap.", tokensIn: 11, tokensOut: 7, reportedCostMicrousd: null } });
    if (valid.ok) expect(valid.answer.calls).toEqual([{ id: "c1", name: "recap", args: {} }]);
    expect(parseSubscriptionLeadAnswer('{"text":"a","text":"b","calls":[]}')).toMatchObject({ ok: false, problem: "duplicate-key" });
    expect(parseSubscriptionLeadAnswer('{"text":"a","calls":[],"extra":true}')).toMatchObject({ ok: false, problem: "wrong-shape" });
    expect(parseSubscriptionLeadAnswer(JSON.stringify({ text: "a", calls: [{ id: "c", name: "recap", argumentsJson: "[]" }] }))).toMatchObject({ ok: false, problem: "bad-tool-call" });
  });

  test("Codex runs ephemerally in a deleted empty directory with tools, web, apps, rules, and credential env disabled", async () => {
    let seen: { file: string; args: readonly string[]; cwd: string; omitEnv: readonly string[]; timeoutMs: number | undefined } | null = null;
    const result = await performSubscriptionLeadRequest(request("codex-subscription"), async (file, args, options) => {
      seen = { file, args, cwd: options?.cwd ?? "", omitEnv: options?.omitEnv ?? [], timeoutMs: options?.timeoutMs };
      expect(options?.stdin).toContain("SYSTEM-CANARY");
      expect(args).not.toContain(options?.stdin);
      expect(args.at(-1)).toBe("-");
      const answer = JSON.stringify({ text: "All quiet.", calls: [] });
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        notFound: false,
      };
    });
    expect(result).toMatchObject({ ok: true, answer: { text: "All quiet.", tokensIn: 12, tokensOut: 4 } });
    expect(seen).not.toBeNull();
    const call = seen!;
    expect(call.file).toBe("codex");
    expect(call.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "read-only", 'web_search="disabled"', "features.shell_tool=false", "features.multi_agent=false", "apps._default.enabled=false"]));
    expect(call.args).not.toContain("--model");
    expect(call.omitEnv).toEqual(ALL_CREDENTIAL_ENV);
    expect(call.timeoutMs).toBe(12_345);
    expect(existsSync(call.cwd)).toBe(false);
  });

  test("Claude streams the reply while it is written; the closing result stays the answer", async () => {
    const seen: string[] = [];
    const stdout = [
      { type: "system", subtype: "init" },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "StructuredOutput", input: {} } } },
      ...['{"text": "Rea', 'dy \\"now\\"', '.\\nDone", "calls": []}'].map(partial => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: partial } } })),
      { usage: { input_tokens: 8, output_tokens: 2 }, type: "result", subtype: "success", is_error: false, structured_output: { text: 'Ready "now".\nDone', calls: [] } },
    ].map(line => JSON.stringify(line)).join("\n") + "\n";
    const result = await performSubscriptionLeadRequest({ ...request("claude-subscription"), onText: text => seen.push(text) }, async (_file, args, options) => {
      expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose", "--include-partial-messages", "--safe-mode", "--tools", ""]));
      for (let at = 0; at < stdout.length; at += 23) options?.onStdout?.(stdout.slice(at, at + 23));
      return { code: 0, stdout, stderr: "", timedOut: false, notFound: false };
    });
    expect(seen).toEqual(["Rea", 'Ready "now"', 'Ready "now".\nDone']);
    expect(result).toMatchObject({ ok: true, answer: { text: 'Ready "now".\nDone', tokensIn: 8, tokensOut: 2 } });
    // Without a watcher, and for Codex, the buffered run is unchanged.
    await performSubscriptionLeadRequest(request("claude-subscription"), async (_file, args, options) => {
      expect(args).toEqual(expect.arrayContaining(["--output-format", "json"]));
      expect(options?.onStdout).toBeUndefined();
      return { code: 0, stdout: "{}", stderr: "", timedOut: false, notFound: false };
    });
    await performSubscriptionLeadRequest({ ...request("codex-subscription"), onText: () => undefined }, async (_file, args, options) => {
      expect(args).not.toContain("stream-json");
      expect(options?.onStdout).toBeUndefined();
      return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
    });
  });

  // v140 (docs/plans/evals-nightly.md B1): only the harness's own events report the model, its turns, its cost and its
  // cache use; the answer's text never does, and anything it didn't report stays null (never 0).
  const answerText = { text: "claude-opus-9 answered this", calls: [] };
  const cachedUsage = { input_tokens: 8, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens: 2 };
  const claudeResult = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", is_error: false, structured_output: answerText, ...extra });
  const streamed = (...events: Record<string, unknown>[]) => events.map(line => JSON.stringify(line)).join("\n") + "\n";
  test.each([
    ["streamed: the init's model, the result's turns, cost and cache", true,
      streamed({ type: "system", subtype: "init", model: "claude-sonnet-4-5-20250929", apiKeySource: "none" },
        claudeResult({ num_turns: 2, total_cost_usd: 0.0123, usage: cachedUsage, modelUsage: { "claude-haiku-4-5": {} } })),
      { modelReported: "claude-sonnet-4-5-20250929", providerTurns: 2, reportedCostUsd: 0.0123, tokensIn: 348, cacheReadTokens: 300, cacheWriteTokens: 40 }],
    ["streamed: inits that disagree leave the model unknown, never chosen", true,
      streamed({ type: "system", subtype: "init", model: "claude-sonnet-4-5" }, { type: "system", subtype: "init", model: "claude-opus-4-1" },
        claudeResult({ num_turns: 1, usage: cachedUsage, modelUsage: { "claude-sonnet-4-5": {} } })),
      { modelReported: null, providerTurns: 1, reportedCostUsd: null, tokensIn: 348, cacheReadTokens: 300, cacheWriteTokens: 40 }],
    ["streamed: a subagent's init is not the session's", true,
      streamed({ type: "system", subtype: "init", model: "claude-opus-4-1", parent_tool_use_id: "toolu_1" },
        claudeResult({ usage: { input_tokens: 8, output_tokens: 2 } })),
      { modelReported: null, providerTurns: null, reportedCostUsd: null, tokensIn: 8 }],
    ["buffered: the result's one modelUsage model", false,
      JSON.stringify(claudeResult({ num_turns: 1, total_cost_usd: 0.004, usage: cachedUsage, modelUsage: { "claude-sonnet-4-5-20250929": { inputTokens: 8 } } })),
      { modelReported: "claude-sonnet-4-5-20250929", providerTurns: 1, reportedCostUsd: 0.004, tokensIn: 348, cacheReadTokens: 300, cacheWriteTokens: 40 }],
    ["buffered: several modelUsage models name no one model; malformed counts are unknown", false,
      JSON.stringify(claudeResult({ num_turns: -1, total_cost_usd: "0.01", usage: { input_tokens: 8, output_tokens: 2 }, modelUsage: { "claude-sonnet-4-5": {}, "claude-haiku-4-5": {} } })),
      { modelReported: null, providerTurns: null, reportedCostUsd: null, tokensIn: 8 }],
  ] as const)("Claude keeps what its own result reported — %s", async (_name, watch, stdout, expected) => {
    const result = await performSubscriptionLeadRequest({ ...request("claude-subscription"), ...(watch ? { onText: () => undefined } : {}) },
      async () => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer).toMatchObject(expected);
    // API money stays apart: a subscription's reported cost is never the API charge.
    expect(result.answer.reportedCostMicrousd).toBeNull();
    if (!("cacheReadTokens" in expected)) expect(result.answer.cacheReadTokens).toBeUndefined();
  });

  test("Codex keeps its cache reads (its input already counts them) and reports no model, turns or cost", async () => {
    const result = await performSubscriptionLeadRequest(request("codex-subscription"), async () => ({
      code: 0,
      stdout: [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ text: "All quiet.", calls: [] }) } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 4 } }),
      ].join("\n"),
      stderr: "", timedOut: false, notFound: false,
    }));
    expect(result).toMatchObject({ ok: true, answer: { tokensIn: 120, cacheReadTokens: 100, modelReported: null, providerTurns: null, reportedCostUsd: null, reportedCostMicrousd: null } });
    if (result.ok) expect(result.answer.cacheWriteTokens).toBeUndefined();
  });

  test("Claude runs in safe print mode with an empty tool and MCP surface", async () => {
    let seen: { args: readonly string[]; cwd: string } | null = null;
    const result = await performSubscriptionLeadRequest(request("claude-subscription"), async (_file, args, options) => {
      seen = { args, cwd: options?.cwd ?? "" };
      expect(options?.stdin).toContain("SYSTEM-CANARY");
      expect(args).not.toContain(options?.stdin);
      return {
        code: 0,
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { text: "Ready.", calls: [] }, usage: { input_tokens: 8, output_tokens: 2 } }),
        stderr: "",
        timedOut: false,
        notFound: false,
      };
    });
    expect(result).toMatchObject({ ok: true, answer: { text: "Ready.", tokensIn: 8, tokensOut: 2 } });
    expect(seen?.args).toEqual(expect.arrayContaining(["-p", "--safe-mode", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", '{"mcpServers":{}}']));
    expect(existsSync(seen?.cwd ?? "missing")).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the turn's abort ends the harness and everything it started, and the run reads timed out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "so-sub-abort-"));
    try {
      const pids = join(dir, "pids");
      const controller = new AbortController();
      let spawned!: () => void;
      const started = new Promise<void>(resolve => { spawned = resolve; });
      // A stand-in harness: it starts a grandchild, records both pids, then never answers.
      const pending = performSubscriptionLeadRequest({ ...request("claude-subscription"), timeoutMs: 600_000, signal: controller.signal }, (_file, _args, options) => {
        expect(options?.signal).toBe(controller.signal);
        return run("/bin/sh", ["-c", `sleep 600 & echo "$$ $!" > "${pids}"; echo ready; wait`], { ...options, onStdout: () => spawned() });
      });
      await started;
      const [shell, grandchild] = readFileSync(pids, "utf8").trim().split(" ").map(Number);
      controller.abort();
      expect(await pending).toEqual({ ok: false, problem: "timeout" });
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(alive(shell!)).toBe(false);
      // The grandchild was in the killed group; its exit is reaped by init, so give the OS a bounded moment to show it.
      for (let tries = 0; tries < 100 && alive(grandchild!); tries++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(alive(grandchild!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
