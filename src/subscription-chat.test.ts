import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { run } from "./exec.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import {
  composeSubscriptionMatePrompt,
  parseSubscriptionMateAnswer,
  performSubscriptionMateRequest,
  type SubscriptionMateRequest,
} from "./subscription-chat.js";

const TOOLS = [{ name: "recap", description: "summarize", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] as const;

const request = (provider: SubscriptionMateRequest["provider"]): SubscriptionMateRequest => ({
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
      const result = await performSubscriptionMateRequest(request(provider), async () => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false }));
      expect(result).toMatchObject({ ok: false, problem: "malformed-reply" });
    }
  });

  test("the prompt gives the harness no ambient-state authority", () => {
    const prompt = composeSubscriptionMatePrompt(request("codex-subscription"));
    expect(prompt).toContain("Do not use any harness tools or inspect the computer");
    expect(prompt).toContain("SYSTEM-CANARY");
    expect(prompt).toContain("DATA-CANARY");
    expect(prompt).toContain('"name":"recap"');
  });

  // Regression (gate run 2026-09-30): the lead tried the host's project search as its own tool call, which the harness
  // refuses, then answered a question about the project's files saying the search wasn't available.
  test("the prompt says host tools, project search among them, are requested only through calls and are available that way", () => {
    const prompt = composeSubscriptionMatePrompt(request("claude-subscription"));
    expect(prompt).toContain("calling one directly always fails. Request one only by listing it in calls");
    expect(prompt).toContain("Every AVAILABLE HOST TOOL below is available this way; never say one is unavailable.");
    expect(prompt).toContain("request get_project_context");
  });

  test("strict output accepts bounded calls and refuses smuggled or duplicate fields", () => {
    const valid = parseSubscriptionMateAnswer(JSON.stringify({
      text: "Let me recap.",
      calls: [{ id: "c1", name: "recap", argumentsJson: "{}" }],
    }), { tokensIn: 11, tokensOut: 7 });
    expect(valid).toMatchObject({ ok: true, answer: { text: "Let me recap.", tokensIn: 11, tokensOut: 7, reportedCostMicrousd: null } });
    if (valid.ok) expect(valid.answer.calls).toEqual([{ id: "c1", name: "recap", args: {} }]);
    expect(parseSubscriptionMateAnswer('{"text":"a","text":"b","calls":[]}')).toMatchObject({ ok: false, problem: "duplicate-key" });
    expect(parseSubscriptionMateAnswer('{"text":"a","calls":[],"extra":true}')).toMatchObject({ ok: false, problem: "wrong-shape" });
    expect(parseSubscriptionMateAnswer(JSON.stringify({ text: "a", calls: [{ id: "c", name: "recap", argumentsJson: "[]" }] }))).toMatchObject({ ok: false, problem: "bad-tool-call" });
  });

  test("Codex runs ephemerally in a deleted empty directory with tools, web, apps, rules, and credential env disabled", async () => {
    let seen: { file: string; args: readonly string[]; cwd: string; omitEnv: readonly string[]; timeoutMs: number | undefined } | null = null;
    const result = await performSubscriptionMateRequest(request("codex-subscription"), async (file, args, options) => {
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
    const result = await performSubscriptionMateRequest({ ...request("claude-subscription"), onText: text => seen.push(text) }, async (_file, args, options) => {
      expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose", "--include-partial-messages", "--safe-mode", "--tools", ""]));
      for (let at = 0; at < stdout.length; at += 23) options?.onStdout?.(stdout.slice(at, at + 23));
      return { code: 0, stdout, stderr: "", timedOut: false, notFound: false };
    });
    expect(seen).toEqual(["Rea", 'Ready "now"', 'Ready "now".\nDone']);
    expect(result).toMatchObject({ ok: true, answer: { text: 'Ready "now".\nDone', tokensIn: 8, tokensOut: 2 } });
    // Without a watcher, and for Codex, the buffered run is unchanged.
    await performSubscriptionMateRequest(request("claude-subscription"), async (_file, args, options) => {
      expect(args).toEqual(expect.arrayContaining(["--output-format", "json"]));
      expect(options?.onStdout).toBeUndefined();
      return { code: 0, stdout: "{}", stderr: "", timedOut: false, notFound: false };
    });
    await performSubscriptionMateRequest({ ...request("codex-subscription"), onText: () => undefined }, async (_file, args, options) => {
      expect(args).not.toContain("stream-json");
      expect(options?.onStdout).toBeUndefined();
      return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
    });
  });

  test("Claude runs in safe print mode with an empty tool and MCP surface", async () => {
    let seen: { args: readonly string[]; cwd: string } | null = null;
    const result = await performSubscriptionMateRequest(request("claude-subscription"), async (_file, args, options) => {
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
      const pending = performSubscriptionMateRequest({ ...request("claude-subscription"), timeoutMs: 600_000, signal: controller.signal }, (_file, _args, options) => {
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
