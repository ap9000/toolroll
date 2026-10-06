/**
 * Subscription-backed transport for the mate.
 *
 * The direct API transport owns dollar reservations and native function
 * calls. A cached Codex or Claude login has neither an API key nor a
 * truthful dollar meter, so this adapter runs the local harness in a clean
 * temporary directory and asks for the same tool-call envelope as strict
 * structured JSON. The harness receives no repository path, no project
 * instructions, no MCP servers, and no executable tool surface. Tool calls
 * are still interpreted and executed by mate.ts, where every act remains a
 * proposal that needs a human confirmation card.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MATE_MAX_CALLS_PER_STEP,
  MATE_STEP_TEXT_CAP_BYTES,
  MATE_TOOL_CALL_CAP_BYTES,
  MATE_TOOL_CALL_ID_CAP_BYTES,
  strictJsonParse,
  tokenCount,
  type MateHistoryMessage,
  type MateProviderAnswer,
  type MateToolCall,
  type MateToolSchema,
} from "./converse.js";
import { run, type ExecResult } from "./exec.js";
import { claudeStreamReader } from "./mate-progress.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import type { SubscriptionChatProviderId } from "./store.js";
import { claudeLimitsOf, noteLimits } from "./provider-limits.js";
import { claudeBillingFrom } from "./spend.js";

export type SubscriptionMateRequest = {
  provider: SubscriptionChatProviderId;
  /** `default` lets the authenticated harness choose its current default. */
  model: string;
  system: string;
  dataDocument: string;
  history: readonly MateHistoryMessage[];
  tools: readonly MateToolSchema[];
  /** A structured answer of another shape (the memory pass's verdict): this JSON Schema is the harness's
   * `--json-schema` (Codex's `--output-schema`) in place of the mate envelope, and its JSON text comes back as the
   * answer's text, unread, for the caller's own schema to parse. */
  outputSchema?: Record<string, unknown>;
  timeoutMs: number;
  /** The turn's own deadline: aborting it ends the harness's whole process group. */
  signal?: AbortSignal;
  /** The reply as it is written, cumulative, when the harness can stream it
   * (Claude). Display only: the finished answer is still parsed whole. */
  onText?: (text: string) => void;
};

export type SubscriptionMateRunner = (
  request: SubscriptionMateRequest,
) => Promise<{ ok: true; answer: MateProviderAnswer } | { ok: false; problem: string }>;

type CommandRunner = (file: string, args: readonly string[], options: Parameters<typeof run>[2]) => Promise<ExecResult>;

const RESPONSE_CAP_BYTES = 65_536;

function outputSchema(tools: readonly MateToolSchema[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      text: { type: "string", maxLength: MATE_STEP_TEXT_CAP_BYTES },
      // With no tools offered there is nothing to name: an empty enum is not
      // a valid schema, so the calls array is simply required to be empty.
      calls: tools.length === 0 ? { type: "array", maxItems: 0 } : {
        type: "array",
        maxItems: MATE_MAX_CALLS_PER_STEP,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: MATE_TOOL_CALL_ID_CAP_BYTES },
            name: { type: "string", enum: tools.map(tool => tool.name) },
            argumentsJson: { type: "string", maxLength: MATE_TOOL_CALL_CAP_BYTES },
          },
          required: ["id", "name", "argumentsJson"],
          additionalProperties: false,
        },
      },
    },
    required: ["text", "calls"],
    additionalProperties: false,
  };
}

/** The model-visible request. Tool results are already redacted by mateView. */
export function composeSubscriptionMatePrompt(request: Omit<SubscriptionMateRequest, "provider" | "model" | "timeoutMs" | "signal">): string {
  return [
    request.system,
    "SUBSCRIPTION HARNESS PROTOCOL:",
    "Do not use any harness tools or inspect the computer. The only current state is DATA and TOOL RESULTS below.",
    // The model tried host tools as its own tool calls, which the harness refuses, and sometimes then told the operator the
    // project search "wasn't available" (gate run, 2026-09-30). Host tools are requested only through calls.
    "Host tools are not tools you can call yourself here: calling one directly always fails. Request one only by listing it in calls of the JSON object you return. Every AVAILABLE HOST TOOL below is available this way; never say one is unavailable. For what a project's files or code say, request get_project_context.",
    "Return the required JSON object. To request a host tool, append {id, name, argumentsJson} to calls; argumentsJson is the JSON serialization of that tool's argument object.",
    "The host validates and runs those calls, then gives you another step. When finished, return a non-empty text and an empty calls array.",
    `AVAILABLE HOST TOOLS:\n${JSON.stringify(request.tools)}`,
    `DATA:\n${request.dataDocument}`,
    `CONVERSATION:\n${JSON.stringify(request.history)}`,
  ].join("\n\n");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

/** Strictly turn the harness's structured output into the provider-neutral answer. */
export function parseSubscriptionMateAnswer(
  text: string,
  usage: { tokensIn?: unknown; tokensOut?: unknown } = {},
): { ok: true; answer: MateProviderAnswer } | { ok: false; problem: string } {
  const parsed = strictJsonParse(Buffer.from(text, "utf8"), RESPONSE_CAP_BYTES, 8);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, problem: parsed.ok ? "not-an-object" : parsed.problem };
  }
  const body = parsed.value as Record<string, unknown>;
  if (!exactKeys(body, ["text", "calls"]) || typeof body["text"] !== "string" || !Array.isArray(body["calls"])) {
    return { ok: false, problem: "wrong-shape" };
  }
  if (Buffer.byteLength(body["text"], "utf8") > MATE_STEP_TEXT_CAP_BYTES || body["calls"].length > MATE_MAX_CALLS_PER_STEP) {
    return { ok: false, problem: "over-cap" };
  }
  const calls: MateToolCall[] = [];
  for (const raw of body["calls"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problem: "bad-tool-call" };
    const call = raw as Record<string, unknown>;
    if (!exactKeys(call, ["id", "name", "argumentsJson"])) return { ok: false, problem: "bad-tool-call" };
    if (typeof call["id"] !== "string" || call["id"] === "" || Buffer.byteLength(call["id"], "utf8") > MATE_TOOL_CALL_ID_CAP_BYTES) {
      return { ok: false, problem: "bad-tool-call" };
    }
    if (typeof call["name"] !== "string" || call["name"] === "" || call["name"].length > 64 || typeof call["argumentsJson"] !== "string") {
      return { ok: false, problem: "bad-tool-call" };
    }
    const argumentsBytes = Buffer.from(call["argumentsJson"], "utf8");
    if (argumentsBytes.byteLength > MATE_TOOL_CALL_CAP_BYTES) return { ok: false, problem: "bad-tool-call" };
    const args = strictJsonParse(argumentsBytes, MATE_TOOL_CALL_CAP_BYTES, 6);
    if (!args.ok || typeof args.value !== "object" || args.value === null || Array.isArray(args.value)) return { ok: false, problem: "bad-tool-call" };
    const normalized = { id: call["id"], name: call["name"], args: args.value as Record<string, unknown> };
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MATE_TOOL_CALL_CAP_BYTES) return { ok: false, problem: "bad-tool-call" };
    calls.push(normalized);
  }
  const tokensIn = typeof usage.tokensIn === "number" && tokenCount(usage.tokensIn) ? usage.tokensIn : 0;
  const tokensOut = typeof usage.tokensOut === "number" && tokenCount(usage.tokensOut) ? usage.tokensOut : 0;
  return { ok: true, answer: { text: body["text"], calls, tokensIn, tokensOut, reportedCostMicrousd: null } };
}

function codexOutput(stdout: string): { text: string | null; tokensIn: number; tokensOut: number } {
  let text: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let completed = 0;
  let invalid = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { invalid = true; continue; }
    if (event === null || typeof event !== "object" || Array.isArray(event)) { invalid = true; continue; }
    if (event["type"] === "turn.failed") invalid = true;
    if (event["type"] === "item.completed") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] === "agent_message" && typeof item["text"] === "string") {
        if (completed !== 0) invalid = true;
        text = item["text"];
      }
    } else if (event["type"] === "turn.completed") {
      completed += 1;
      const usage = event["usage"] as Record<string, unknown> | undefined;
      if (typeof usage?.["input_tokens"] === "number" && tokenCount(usage["input_tokens"])) tokensIn = usage["input_tokens"];
      if (typeof usage?.["output_tokens"] === "number" && tokenCount(usage["output_tokens"])) tokensOut = usage["output_tokens"];
    }
  }
  // A partial answer is not authority to run host tools. Process exit zero
  // alone is insufficient; the harness must finish this one turn successfully.
  return { text: !invalid && completed === 1 ? text : null, tokensIn, tokensOut };
}

function claudeOutput(stdout: string): { text: string | null; tokensIn: number; tokensOut: number } {
  const parsed = strictJsonParse(Buffer.from(stdout, "utf8"), RESPONSE_CAP_BYTES, 12);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return { text: null, tokensIn: 0, tokensOut: 0 };
  const body = parsed.value as Record<string, unknown>;
  if (body["type"] !== "result" || body["subtype"] !== "success" || body["is_error"] !== false) {
    return { text: null, tokensIn: 0, tokensOut: 0 };
  }
  const usage = body["usage"] as Record<string, unknown> | undefined;
  const tokensIn = typeof usage?.["input_tokens"] === "number" && tokenCount(usage["input_tokens"]) ? usage["input_tokens"] : 0;
  const tokensOut = typeof usage?.["output_tokens"] === "number" && tokenCount(usage["output_tokens"]) ? usage["output_tokens"] : 0;
  const structured = body["structured_output"];
  if (typeof structured === "object" && structured !== null) return { text: JSON.stringify(structured), tokensIn, tokensOut };
  return { text: typeof body["result"] === "string" ? body["result"] : null, tokensIn, tokensOut };
}

/** The streamed run's closing `result` event: the same body the buffered
 * `--output-format json` run prints. */
function lastResultLine(stdout: string): string {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (typeof event === "object" && event !== null && (event as Record<string, unknown>)["type"] === "result") return line;
    } catch { /* not an event line */ }
  }
  return "";
}

/** Production runner; injectable so tests never consume a subscription turn. */
export async function performSubscriptionMateRequest(
  request: SubscriptionMateRequest,
  runner: CommandRunner = run,
): Promise<{ ok: true; answer: MateProviderAnswer } | { ok: false; problem: string }> {
  const dir = mkdtempSync(join(tmpdir(), "standing-orders-mate-"));
  try {
    const prompt = composeSubscriptionMatePrompt(request);
    const streaming = request.provider !== "codex-subscription" && request.onText !== undefined;
    const schema = request.outputSchema ?? outputSchema(request.tools);
    let command: string;
    let args: string[];
    if (request.provider === "codex-subscription") {
      const schemaFile = join(dir, "response-schema.json");
      writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
      command = "codex";
      args = [
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "--sandbox", "read-only", "--output-schema", schemaFile,
        "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
        "-c", "features.shell_tool=false", "-c", "features.unified_exec=false",
        "-c", "features.multi_agent=false", "-c", "features.skill_mcp_dependency_install=false",
        "-c", "apps._default.enabled=false",
        ...(request.model === "default" ? [] : ["--model", request.model]),
        "-",
      ];
    } else {
      command = "claude";
      args = [
        // Streaming (someone is watching): the same answer, delivered as
        // events whose final `result` line is the whole structured reply.
        "-p", ...(streaming ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"] : ["--output-format", "json"]), "--json-schema", JSON.stringify(schema),
        "--safe-mode", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk",
        "--permission-prompts", "none", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        ...(request.model === "default" ? [] : ["--model", request.model]),
      ];
    }
    const result = await runner(command, args, {
      cwd: dir,
      stdin: prompt,
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      // Events repeat the answer (deltas, the message, the result line).
      maxBuffer: streaming ? RESPONSE_CAP_BYTES * 16 : RESPONSE_CAP_BYTES,
      omitEnv: ALL_CREDENTIAL_ENV,
      processGroup: true,
      ...(streaming ? { onStdout: claudeStreamReader(request.onText!) } : {}),
    });
    if (result.timedOut) return { ok: false, problem: "timeout" };
    if (result.notFound) return { ok: false, problem: "not-found" };
    // v105: a streamed Claude turn says its plan's usage windows, and (once it answered) how this computer's Claude bills
    // with no key from us: the chat ran with every key left out.
    if (command === "claude" && streaming) {
      const seen = { keySource: null as string | null, model: null as string | null, planWindows: false };
      let answered = false;
      for (const line of result.stdout.split("\n")) {
        if (!line.includes('"rate_limit_event"') && !line.includes('"apiKeySource"') && !line.includes('"type":"result"')) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const reading = claudeLimitsOf(event);
        if (reading !== null) { seen.planWindows = true; noteLimits(reading); }
        else if (event["type"] === "system" && event["subtype"] === "init") {
          seen.keySource = typeof event["apiKeySource"] === "string" ? event["apiKeySource"] : null;
          seen.model = typeof event["model"] === "string" ? event["model"] : null;
        } else if (event["type"] === "result") answered = true;
      }
      const billing = answered ? claudeBillingFrom(seen) : null;
      if (billing !== null) noteLimits({ provider: "claude", plan: null, windows: [], partial: true, billing });
    }
    if (result.code !== 0) return { ok: false, problem: `status-${result.code}` };
    const output = request.provider === "codex-subscription" ? codexOutput(result.stdout) : claudeOutput(streaming ? lastResultLine(result.stdout) : result.stdout);
    if (output.text === null) return { ok: false, problem: "malformed-reply" };
    if (request.outputSchema !== undefined) {
      return { ok: true, answer: { text: output.text, calls: [], tokensIn: output.tokensIn, tokensOut: output.tokensOut, reportedCostMicrousd: null } };
    }
    return parseSubscriptionMateAnswer(output.text, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
