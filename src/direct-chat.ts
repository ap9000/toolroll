import { spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { resolveExecutable } from "./attest.js";
import { currentBootId, provenDeadByBootChange } from "./boot-identity.js";
import { scanCustody, type CustodyIO, type LaunchCustody, type ProcessWitness, type ProcRow } from "./flexible-custody.js";
import { defaultCustodyIO } from "./flexible-launch.js";
import { plainAgentEnv } from "./agent-fence.js";
import { directChatFence, type DirectChatFenceFn, type DirectChatTurnFence } from "./direct-chat-fence.js";
import { confined } from "./exec.js";
import { cleanLiveText, HIDDEN_LINE, liveSecretHit } from "./live-records.js";
import { projectName } from "./project.js";
import {
  captureNewWorkspaceArtifacts,
  extractBase64ImagesFromLine,
  getDirectChatArtifact,
  listArtifactsForThread,
  saveDirectChatArtifact,
  snapshotWorkspaceImages,
  type DirectChatArtifactRow,
  type WorkspaceImageSnapshot,
} from "./direct-chat-artifacts.js";
import {
  assertManagedClonePath,
  assertTrustedCloneGit,
  cloneIsolatedRepoAsync,
  pinnedConfigBackupPath,
  repairCloneGitBinding,
  runTrustedCloneGit,
  type TrustedCloneBinding,
} from "./direct-chat-git.js";
import { applyMainDirtyPatch, cloneSafeNodeModulesAsync, type ApplyMainDirtyPatchResult } from "./direct-chat-workspace.js";
import { defaultContextWindowFor, normalizeDirectChatEffort, resolveAgyModelForEffort, type DirectChatEffort } from "./direct-chat-catalog.js";
import type { Store } from "./store.js";

export type DirectChatProvider = "claude" | "codex" | "gemini";
export const DIRECT_CHAT_PROVIDERS: readonly DirectChatProvider[] = Object.freeze(["claude", "codex", "gemini"]);
export type DirectChatTurnStatus = "running" | "completed" | "stopped" | "failed" | "interrupted";
export type DirectChatToolStatus = "running" | "done" | "error";

export function isDirectChatProvider(value: unknown): value is DirectChatProvider {
  return value === "claude" || value === "codex" || value === "gemini";
}

export type DirectChatPosture = {
  summary: string;
  detail: string;
  sandboxed: boolean;
};

export function directChatPostureOf(provider: DirectChatProvider): DirectChatPosture {
  switch (provider) {
    case "claude":
      return {
        summary: "Runs commands without asking",
        detail: "Uses Claude auto mode inside this chat's isolated clone (no OS sandbox).",
        sandboxed: false,
      };
    case "codex":
      return {
        summary: "Runs commands without asking",
        detail: "Uses Codex workspace-write sandbox inside this chat's isolated clone.",
        sandboxed: true,
      };
    case "gemini":
      return {
        summary: "Runs commands without asking",
        detail: "Uses Antigravity auto mode with sandbox inside this chat's isolated clone.",
        sandboxed: true,
      };
  }
}

export function defaultModelForProvider(provider: DirectChatProvider): string {
  switch (provider) {
    case "claude": return "opus";
    case "codex": return "gpt-6-astra";
    case "gemini": return "gemini-4-neon-high";
  }
}

export type DirectChatUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
  contextTokens: number;
  contextWindow: number | null;
  costUsd: number | null;
};

export type DirectChatToolRow = {
  id: string;
  ordinal: number;
  name: string;
  detail: string;
  status: DirectChatToolStatus;
  updatedAt: string;
};

export type DirectChatTurnRow = {
  id: string;
  threadId: string;
  seq: number;
  requestId: string | null;
  userPrompt: string;
  switchedFromProvider: DirectChatProvider | null;
  logPath: string;
  stderrPath: string;
  byteOffset: number;
  pid: number | null;
  startIdentity: string | null;
  pgid: number | null;
  bootId: string | null;
  status: DirectChatTurnStatus;
  stopRequestedAt: string | null;
  assistantText: string;
  errorText: string | null;
  createdAt: string;
  finishedAt: string | null;
  usage: DirectChatUsage | null;
  tools: DirectChatToolRow[];
  artifacts: DirectChatArtifactRow[];
};

export type DirectChatThreadRow = {
  id: string;
  owner: string;
  localGeneration: number | null;
  accountGeneration: number;
  createRequestId: string | null;
  title: string;
  repo: string;
  project: string;
  clonePath: string;
  gitDir: string | null;
  configSha256: string | null;
  branch: string;
  baseSha: string;
  provider: DirectChatProvider;
  modelId: string;
  effort: DirectChatEffort | null;
  providerSessionId: string | null;
  mainDirtyFiles: string[];
  diffCache: DirectChatDiffSummary;
  usage: DirectChatUsage | null;
  isLegacy: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DirectChatDiffSummary = {
  changedFiles: string[];
  diffText: string;
  dirty: boolean;
};

export type DirectChatStreamEvent =
  | { kind: "session_id"; sessionId: string }
  | { kind: "message_start" }
  | { kind: "text_delta"; delta: string }
  | { kind: "text_replace"; text: string }
  | { kind: "usage"; usage: Partial<DirectChatUsage>; cumulative?: boolean }
  | { kind: "tool"; id: string; name: string; detail: string; status: DirectChatToolStatus }
  | { kind: "tool_status"; id: string; status: DirectChatToolStatus }
  | { kind: "completed" }
  | { kind: "failed"; message: string };

export type DirectChatNotification = {
  threadId: string;
  turnId: string | null;
  event: "turn" | "change";
};

const HEX32 = /^[0-9a-f]{32}$/;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 40_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const EMPTY_DIFF: DirectChatDiffSummary = Object.freeze({ changedFiles: [], diffText: "", dirty: false });
const HANDOFF_MAX_TURNS = 6;
const HANDOFF_MAX_CHARS = 6_000;

function sanitizeDisplay(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => {
      const cleaned = cleanLiveText(line);
      return liveSecretHit(cleaned) ? HIDDEN_LINE : cleaned;
    })
    .join("\n");
}

function sanitizeLine(raw: string): string {
  const cleaned = cleanLiveText(raw).replace(/\s+/g, " ").trim();
  if (cleaned === "") return "";
  return liveSecretHit(cleaned) ? HIDDEN_LINE : cleaned;
}

function friendlyToolName(raw: string): string {
  switch (raw.toLowerCase()) {
    case "view_file":
    case "read":
    case "read_file":
      return "Read";
    case "list_dir":
    case "find_by_name":
      return "Browse";
    case "grep_search":
    case "search_web":
      return "Search";
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "edit":
      return "Edit";
    case "write_to_file":
    case "write":
      return "Write";
    case "run_command":
    case "bash":
      return "Run";
    default:
      return raw.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
}

function summarizeToolInput(input: Record<string, unknown> | null | undefined, homeDir = homedir()): string {
  if (!input || typeof input !== "object") return "";
  const keys = [
    "CommandLine", "command",
    "TargetFile", "AbsolutePath", "DirectoryPath", "SearchDirectory", "SearchPath", "Path",
    "file_path", "path",
    "Query", "Pattern", "pattern", "query",
    "Url", "url",
    "description",
  ];
  for (const key of keys) {
    const val = input[key];
    if (typeof val === "string" && val.trim() !== "") {
      let cleaned = val.split(homeDir).join("~");
      if (cleaned.startsWith("~/") || cleaned.startsWith("/")) {
        const parts = cleaned.split("/").filter(Boolean);
        if (parts.length > 3) cleaned = parts.slice(-2).join("/");
      }
      return sanitizeLine(cleaned.slice(0, 120));
    }
  }
  return "";
}

export function parseDirectChatLine(line: string, provider: DirectChatProvider): DirectChatStreamEvent[] {
  const trimmed = line.trim();
  if (trimmed === "" || Buffer.byteLength(trimmed, "utf8") > MAX_LINE_BYTES) return [];
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    json = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  switch (provider) {
    case "claude": return parseClaudeJson(json);
    case "codex": return parseCodexJson(json);
    case "gemini": return parseGeminiJson(json);
  }
}

function finiteNonNeg(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 ? Math.round(val) : 0;
}

function emptyUsage(contextWindow: number | null = null): DirectChatUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    contextTokens: 0,
    contextWindow,
    costUsd: null,
  };
}

function parseUsageJson(raw: unknown): DirectChatUsage | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DirectChatUsage> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      inputTokens: finiteNonNeg(parsed.inputTokens),
      outputTokens: finiteNonNeg(parsed.outputTokens),
      cacheReadTokens: finiteNonNeg(parsed.cacheReadTokens),
      cacheCreationTokens: finiteNonNeg(parsed.cacheCreationTokens),
      thinkingTokens: finiteNonNeg(parsed.thinkingTokens),
      contextTokens: finiteNonNeg(parsed.contextTokens),
      contextWindow: typeof parsed.contextWindow === "number" && Number.isFinite(parsed.contextWindow) && parsed.contextWindow > 0
        ? Math.round(parsed.contextWindow)
        : null,
      costUsd: typeof parsed.costUsd === "number" && Number.isFinite(parsed.costUsd) && parsed.costUsd >= 0
        ? parsed.costUsd
        : null,
    };
  } catch {
    return null;
  }
}

function parseClaudeJson(json: Record<string, unknown>): DirectChatStreamEvent[] {
  const events: DirectChatStreamEvent[] = [];
  if (typeof json["session_id"] === "string" && json["session_id"] !== "") {
    events.push({ kind: "session_id", sessionId: json["session_id"] });
  }
  const type = typeof json["type"] === "string" ? json["type"] : "";
  if (type === "stream_event" && json["parent_tool_use_id"] == null && json["event"] && typeof json["event"] === "object" && !Array.isArray(json["event"])) {
    const inner = json["event"] as Record<string, unknown>;
    const innerType = typeof inner["type"] === "string" ? inner["type"] : "";
    if (innerType === "message_start") {
      events.push({ kind: "message_start" });
    } else if (innerType === "content_block_start" && inner["content_block"] && typeof inner["content_block"] === "object") {
      const block = inner["content_block"] as Record<string, unknown>;
      if (block["type"] === "tool_use") {
        const name = typeof block["name"] === "string" ? block["name"] : "Tool";
        const id = typeof block["id"] === "string" && block["id"] !== "" ? block["id"] : randomBytes(8).toString("hex");
        events.push({ kind: "tool", id, name, detail: "", status: "running" });
      }
    } else if (innerType === "content_block_delta" && inner["delta"] && typeof inner["delta"] === "object") {
      const delta = inner["delta"] as Record<string, unknown>;
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string" && delta["text"] !== "") {
        events.push({ kind: "text_delta", delta: delta["text"] });
      }
    }
    return events;
  }
  if (type === "assistant" && json["message"] && typeof json["message"] === "object") {
    const message = json["message"] as Record<string, unknown>;
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    const textParts: string[] = [];
    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as Record<string, unknown>;
      const bType = typeof block["type"] === "string" ? block["type"] : "";
      if (bType === "text" && typeof block["text"] === "string" && block["text"] !== "") {
        textParts.push(block["text"]);
      } else if (bType === "tool_use") {
        const name = typeof block["name"] === "string" ? block["name"] : "Tool";
        const input = (block["input"] && typeof block["input"] === "object") ? (block["input"] as Record<string, unknown>) : null;
        const id = typeof block["id"] === "string" && block["id"] !== "" ? block["id"] : randomBytes(8).toString("hex");
        events.push({ kind: "tool", id, name, detail: summarizeToolInput(input), status: "running" });
      }
    }
    if (textParts.length > 0) {
      events.push({ kind: "text_replace", text: sanitizeDisplay(textParts.join("\n")) });
    }
    if (message["usage"] && typeof message["usage"] === "object") {
      const u = message["usage"] as Record<string, unknown>;
      const inputTokens = finiteNonNeg(u["input_tokens"]);
      const cacheReadTokens = finiteNonNeg(u["cache_read_input_tokens"]);
      const cacheCreationTokens = finiteNonNeg(u["cache_creation_input_tokens"]);
      const outputTokens = finiteNonNeg(u["output_tokens"]);
      const contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
      if (contextTokens > 0 || outputTokens > 0) {
        events.push({
          kind: "usage",
          usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextTokens },
          cumulative: false,
        });
      }
    }
  } else if (type === "user" && json["message"] && typeof json["message"] === "object") {
    const message = json["message"] as Record<string, unknown>;
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as Record<string, unknown>;
      if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string" && block["tool_use_id"] !== "") {
        events.push({ kind: "tool_status", id: block["tool_use_id"], status: block["is_error"] === true ? "error" : "done" });
      }
    }
  } else if (type === "result") {
    const rawUsage = json["usage"] && typeof json["usage"] === "object" ? (json["usage"] as Record<string, unknown>) : null;
    const rawModelUsage = json["modelUsage"] && typeof json["modelUsage"] === "object" ? (json["modelUsage"] as Record<string, unknown>) : null;
    let contextWindow: number | null = null;
    let thinkingTokens = 0;
    let modelCost: number | null = null;
    if (rawModelUsage) {
      for (const entry of Object.values(rawModelUsage)) {
        if (!entry || typeof entry !== "object") continue;
        const m = entry as Record<string, unknown>;
        if (typeof m["contextWindow"] === "number" && Number.isFinite(m["contextWindow"]) && m["contextWindow"] > 0) {
          contextWindow = Math.round(m["contextWindow"]);
        }
        thinkingTokens += finiteNonNeg(m["thinkingTokens"]);
        if (typeof m["costUSD"] === "number" && Number.isFinite(m["costUSD"]) && m["costUSD"] >= 0) {
          modelCost = (modelCost ?? 0) + m["costUSD"];
        }
      }
    }
    const costUsd = typeof json["total_cost_usd"] === "number" && Number.isFinite(json["total_cost_usd"]) && json["total_cost_usd"] >= 0
      ? json["total_cost_usd"]
      : modelCost;
    if (rawUsage) {
      const outDetails = rawUsage["output_tokens_details"] && typeof rawUsage["output_tokens_details"] === "object"
        ? (rawUsage["output_tokens_details"] as Record<string, unknown>)
        : null;
      if (thinkingTokens === 0 && outDetails) {
        thinkingTokens = finiteNonNeg(outDetails["thinking_tokens"]);
      }
      const inputTokens = finiteNonNeg(rawUsage["input_tokens"]);
      const cacheReadTokens = finiteNonNeg(rawUsage["cache_read_input_tokens"]);
      const cacheCreationTokens = finiteNonNeg(rawUsage["cache_creation_input_tokens"]);
      const outputTokens = finiteNonNeg(rawUsage["output_tokens"]);
      events.push({
        kind: "usage",
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          thinkingTokens,
          ...(contextWindow !== null ? { contextWindow } : {}),
          ...(costUsd !== null ? { costUsd } : {}),
        },
        cumulative: true,
      });
    } else if (contextWindow !== null || costUsd !== null) {
      events.push({
        kind: "usage",
        usage: {
          ...(contextWindow !== null ? { contextWindow } : {}),
          ...(costUsd !== null ? { costUsd } : {}),
        },
        cumulative: true,
      });
    }
    const isError = json["is_error"] === true;
    const resultText = typeof json["result"] === "string" ? json["result"] : "";
    const denials = Array.isArray(json["permission_denials"]) ? json["permission_denials"] : [];
    if (isError) {
      events.push({ kind: "failed", message: resultText !== "" ? resultText : "Claude returned an error." });
    } else if (resultText !== "") {
      events.push({ kind: "text_replace", text: resultText });
      events.push({ kind: "completed" });
    } else if (denials.length > 0) {
      const names = denials
        .map(d => (d && typeof d === "object" && typeof (d as Record<string, unknown>)["tool_name"] === "string" ? String((d as Record<string, unknown>)["tool_name"]) : "tool"))
        .join(", ");
      events.push({ kind: "failed", message: `Blocked by permission policy (${names}).` });
    } else {
      events.push({ kind: "completed" });
    }
  }
  return events;
}

function parseCodexJson(json: Record<string, unknown>): DirectChatStreamEvent[] {
  const events: DirectChatStreamEvent[] = [];
  const type = typeof json["type"] === "string" ? json["type"] : "";
  if (type === "thread.started" && typeof json["thread_id"] === "string" && json["thread_id"] !== "") {
    events.push({ kind: "session_id", sessionId: json["thread_id"] });
  } else if ((type === "item.completed" || type === "item.started") && json["item"] && typeof json["item"] === "object") {
    const item = json["item"] as Record<string, unknown>;
    const itemType = typeof item["type"] === "string" ? item["type"] : "";
    const itemId = typeof item["id"] === "string" && item["id"] !== "" ? item["id"] : randomBytes(8).toString("hex");
    if (itemType === "agent_message" && typeof item["text"] === "string" && item["text"] !== "") {
      events.push({ kind: "text_replace", text: item["text"] });
    } else if (itemType === "command_execution") {
      const cmd = typeof item["command"] === "string" ? item["command"] : "shell";
      const status: DirectChatToolStatus = type === "item.completed"
        ? (typeof item["exit_code"] === "number" && item["exit_code"] !== 0 ? "error" : "done")
        : "running";
      events.push({ kind: "tool", id: itemId, name: "Run", detail: sanitizeLine(cmd.slice(0, 120)), status });
    } else if (itemType === "file_change") {
      const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
      const paths = changes
        .map(c => (c && typeof c === "object" && typeof (c as Record<string, unknown>)["path"] === "string" ? String((c as Record<string, unknown>)["path"]) : ""))
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");
      events.push({ kind: "tool", id: itemId, name: "Edit", detail: paths !== "" ? sanitizeLine(paths) : "Updated files", status: "done" });
    } else if (itemType === "mcp_tool_call") {
      const tool = typeof item["tool"] === "string" ? item["tool"] : "Tool";
      const server = typeof item["server"] === "string" ? item["server"] : "";
      events.push({ kind: "tool", id: itemId, name: tool, detail: sanitizeLine(server), status: type === "item.completed" ? "done" : "running" });
    }
  } else if (type === "turn.completed") {
    if (json["usage"] && typeof json["usage"] === "object") {
      const u = json["usage"] as Record<string, unknown>;
      const inputTokens = finiteNonNeg(u["input_tokens"]);
      const cacheReadTokens = finiteNonNeg(u["cached_input_tokens"]);
      const outputTokens = finiteNonNeg(u["output_tokens"]);
      const contextTokens = inputTokens;
      if (inputTokens > 0 || outputTokens > 0) {
        events.push({
          kind: "usage",
          usage: { inputTokens, outputTokens, cacheReadTokens, contextTokens },
          cumulative: true,
        });
      }
    }
    events.push({ kind: "completed" });
  } else if (type === "turn.failed" || type === "error") {
    const errObj = (json["error"] && typeof json["error"] === "object") ? (json["error"] as Record<string, unknown>) : null;
    const msg = (typeof errObj?.["message"] === "string" ? errObj["message"] : null)
      ?? (typeof json["message"] === "string" ? json["message"] : null)
      ?? "Codex turn failed.";
    events.push({ kind: "failed", message: msg });
  }
  return events;
}

function parseGeminiJson(json: Record<string, unknown>): DirectChatStreamEvent[] {
  const events: DirectChatStreamEvent[] = [];
  if (typeof json["conversation_id"] === "string" && json["conversation_id"] !== "") {
    events.push({ kind: "session_id", sessionId: json["conversation_id"] });
  }
  const event = typeof json["event"] === "string" ? json["event"] : "";
  if (event === "step_update" && json["step_update"] && typeof json["step_update"] === "object") {
    const step = json["step_update"] as Record<string, unknown>;
    const stepType = typeof step["step_type"] === "string" ? step["step_type"] : "";
    const state = (typeof step["state"] === "string" ? step["state"] : "").toUpperCase();
    if (stepType === "agent_response" && typeof step["text_delta"] === "string" && step["text_delta"] !== "") {
      events.push({ kind: "text_delta", delta: step["text_delta"] });
    } else if (stepType === "tool") {
      const idx = typeof step["step_index"] === "number" ? step["step_index"] : 0;
      const toolInfo = (step["tool_info"] && typeof step["tool_info"] === "object") ? (step["tool_info"] as Record<string, unknown>) : null;
      const rawName = (typeof step["tool_name"] === "string" ? step["tool_name"] : null)
        ?? (typeof toolInfo?.["name"] === "string" ? toolInfo["name"] : null)
        ?? "Tool";
      const params = (toolInfo?.["parameters"] && typeof toolInfo["parameters"] === "object") ? (toolInfo["parameters"] as Record<string, unknown>) : null;
      const status: DirectChatToolStatus = state === "DONE" ? "done" : state === "ERROR" ? "error" : "running";
      events.push({
        kind: "tool",
        id: `agy-${idx}`,
        name: friendlyToolName(rawName),
        detail: summarizeToolInput(params),
        status,
      });
    }
  } else if (event === "result" && json["result"] && typeof json["result"] === "object") {
    const result = json["result"] as Record<string, unknown>;
    const stats = (result["usage"] && typeof result["usage"] === "object"
      ? (result["usage"] as Record<string, unknown>)
      : (result["stats"] && typeof result["stats"] === "object" ? (result["stats"] as Record<string, unknown>) : null));
    if (stats) {
      const inputTokens = finiteNonNeg(stats["input_tokens"] ?? stats["prompt_tokens"] ?? stats["inputTokens"]);
      const outputTokens = finiteNonNeg(stats["output_tokens"] ?? stats["completion_tokens"] ?? stats["outputTokens"]);
      const cacheReadTokens = finiteNonNeg(stats["cached_tokens"] ?? stats["cache_read_input_tokens"] ?? stats["cachedInputTokens"]);
      const thinkingTokens = finiteNonNeg(stats["thinking_tokens"] ?? stats["thoughts_token_count"] ?? stats["thinkingTokens"]);
      if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
        events.push({
          kind: "usage",
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            thinkingTokens,
            contextTokens: inputTokens + cacheReadTokens,
          },
          cumulative: true,
        });
      }
    }
    if (typeof result["conversation_id"] === "string" && result["conversation_id"] !== "") {
      events.push({ kind: "session_id", sessionId: result["conversation_id"] });
    }
    const status = (typeof result["status"] === "string" ? result["status"] : "").toUpperCase();
    const rawResponse = typeof result["response"] === "string" ? result["response"] : "";
    const trimmed = rawResponse.trim();
    if (status === "SUCCESS" || status === "") {
      if (trimmed !== "") {
        events.push({ kind: "text_replace", text: rawResponse });
        events.push({ kind: "completed" });
      } else if (Array.isArray(result["denied_actions"]) && result["denied_actions"].length > 0) {
        const names = result["denied_actions"]
          .map(d => (d && typeof d === "object"
            ? String((d as Record<string, unknown>)["display_name"] ?? (d as Record<string, unknown>)["action"] ?? "tool")
            : "tool"))
          .join(", ");
        events.push({ kind: "failed", message: `Blocked by permission policy (${names}).` });
      } else {
        events.push({ kind: "completed" });
      }
    } else {
      const msg = (typeof result["error"] === "string" ? result["error"] : null)
        ?? (trimmed !== "" ? rawResponse : null)
        ?? "Gemini run failed.";
      events.push({ kind: "failed", message: msg });
    }
  }
  return events;
}

export function buildProviderCommand(input: {
  provider: DirectChatProvider;
  modelId: string;
  effort?: string | null;
  prompt: string;
  sessionId: string | null;
}): string[] {
  const { provider, modelId, prompt, sessionId } = input;
  const effort = normalizeDirectChatEffort(input.effort, provider);
  switch (provider) {
    case "claude": {
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "auto"];
      if (modelId !== "") args.push("--model", modelId);
      if (effort !== null) args.push("--effort", effort);
      if (sessionId !== null && sessionId !== "") args.push("--resume", sessionId);
      args.push("--", prompt);
      return args;
    }
    case "codex": {
      const resuming = sessionId !== null && sessionId !== "";
      const args = [
        "exec",
        ...(resuming
          ? ["resume", sessionId, "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"']
          : ["--sandbox", "workspace-write", "-c", 'approval_policy="never"']),
        "--json",
        "--skip-git-repo-check",
      ];
      if (modelId !== "") args.push("-m", modelId);
      if (effort !== null) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("--", prompt);
      return args;
    }
    case "gemini": {
      const safePrompt = prompt.startsWith("-") ? ` ${prompt}` : prompt;
      const args = ["-p", safePrompt, "--output-format", "stream-json", "--mode", "auto", "--sandbox"];
      const effectiveModel = modelId !== "" ? resolveAgyModelForEffort(modelId, effort) : "";
      if (effectiveModel !== "") args.push("--model", effectiveModel);
      if (effort !== null) args.push("--effort", effort);
      if (sessionId !== null && sessionId !== "") args.push("--conversation", sessionId);
      return args;
    }
  }
}

const DIRECT_CHAT_BINARIES: Record<DirectChatProvider, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "agy",
};

export function locateDirectChatBinary(provider: DirectChatProvider): string | null {
  return resolveExecutable(DIRECT_CHAT_BINARIES[provider]);
}

/** Where each provider CLI keeps its own sign-in, when its person moved it (folders, never keys). */
const SIGN_IN_LOCATION_ENV: Readonly<Record<DirectChatProvider, readonly string[]>> = {
  claude: ["CLAUDE_CONFIG_DIR"],
  codex: ["CODEX_HOME"],
  gemini: [],
};
const XDG_FOLDERS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;

/**
 * The environment a Direct Chat agent starts with, exactly (never Toolroll's own with some names taken out): the plain
 * settings every agent launch keeps (agent-fence.ts plainAgentEnv), the home and temp folders, and where this
 * provider's CLI keeps its own sign-in. The CLI signs in from its own files there; no API key, token or other secret
 * of the server's reaches the agent or the commands it runs.
 */
export function buildSanitizedChildEnv(provider: DirectChatProvider, baseEnv: NodeJS.ProcessEnv = process.env, homeDir = homedir()): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...plainAgentEnv(baseEnv) };
  out["HOME"] = baseEnv["HOME"] ?? homeDir;
  for (const name of ["TMPDIR", ...XDG_FOLDERS, ...SIGN_IN_LOCATION_ENV[provider]]) {
    const value = baseEnv[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  const extraPath = `${homeDir}/.local/bin:${homeDir}/.gemini/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  out["PATH"] = out["PATH"] ? `${extraPath}:${out["PATH"]}` : extraPath;
  out["GIT_TERMINAL_PROMPT"] = "0";
  return out;
}

export function buildTurnPrompt(input: {
  userPrompt: string;
  branch: string;
  isFirstTurnForProvider: boolean;
  priorTurns: readonly Pick<DirectChatTurnRow, "userPrompt" | "assistantText">[];
}): string {
  const parts: string[] = [];
  if (input.isFirstTurnForProvider) {
    parts.push(
      `[Workspace boundary: you are working in an isolated local clone on branch ${input.branch} with no remote. Work only inside this directory; never push, force-reset, or delete files outside this workspace. Leave your changes in the working tree — do not run git commit or git push, because Toolroll commits and ships snapshots for you.]`
    );
    if (input.priorTurns.length > 0) {
      const slice = input.priorTurns.slice(-HANDOFF_MAX_TURNS);
      let handoff = "[Context handed off from earlier turns in this chat:]\n";
      for (const turn of slice) {
        const entry = `User: ${turn.userPrompt.slice(0, 600)}\nAssistant: ${turn.assistantText.slice(0, 800)}\n`;
        if (handoff.length + entry.length > HANDOFF_MAX_CHARS) break;
        handoff += entry;
      }
      parts.push(handoff.trim());
    }
  }
  parts.push(input.userPrompt);
  return parts.join("\n\n");
}

export type DirectChatHostSeams = {
  stateRoot: string;
  now?: () => Date;
  custody?: CustodyIO;
  bootId?: () => string | null;
  stopGraceMs?: number;
  locateBinary?: (provider: DirectChatProvider) => string | null;
  spawnTurn?: (input: {
    binary: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
    stderrPath: string;
    /** The outer fence Claude's turn runs in (direct-chat-fence.ts); absent for the other agents. */
    fence?: DirectChatTurnFence;
  }) => { pid: number; pgid: number; startIdentity: string | null };
  /** How a Claude turn's fence is made (default: direct-chat-fence.ts directChatFence). A test that injects spawnTurn
   * and no fenceTurn makes none (no proxy or storage walk starts); production never injects spawnTurn. */
  fenceTurn?: DirectChatFenceFn;
  prepareClone?: (input: { stateRoot: string; repo: string; clonePath: string; gitDir: string; branch: string }) => Promise<{
    baseSha: string;
    gitDir: string;
    configSha256: string;
    mainDirtyFiles: string[];
  }> | {
    baseSha: string;
    gitDir: string;
    configSha256: string;
    mainDirtyFiles: string[];
  };
  readDiff?: (input: { binding: TrustedCloneBinding; baseSha: string }) => DirectChatDiffSummary;
  onNotify?: (note: DirectChatNotification) => void;
};

async function defaultPrepareCloneAsync(input: { stateRoot: string; repo: string; clonePath: string; gitDir: string; branch: string }): Promise<{
  baseSha: string;
  gitDir: string;
  configSha256: string;
  mainDirtyFiles: string[];
}> {
  const cloned = await cloneIsolatedRepoAsync(input);
  await cloneSafeNodeModulesAsync({ repo: input.repo, clonePath: input.clonePath });
  return {
    baseSha: cloned.baseSha,
    gitDir: cloned.gitDir,
    configSha256: cloned.configSha256,
    mainDirtyFiles: cloned.mainDirtyFiles.map(sanitizeLine),
  };
}

function defaultReadDiff(input: { binding: TrustedCloneBinding; baseSha: string }): DirectChatDiffSummary {
  if (!existsSync(input.binding.clonePath)) return { changedFiles: [], diffText: "", dirty: false };
  const verified = assertTrustedCloneGit(input.binding);
  if (!verified.ok) return { changedFiles: [], diffText: "", dirty: false };
  try {
    const statusLines = runTrustedCloneGit(input.binding, ["status", "--porcelain"])
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    const committedFiles = runTrustedCloneGit(input.binding, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", input.baseSha])
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    const untracked = statusLines
      .filter(line => line.startsWith("?? "))
      .map(line => line.slice(3).trim())
      .filter(Boolean);
    const allFiles = [...new Set([...committedFiles, ...untracked])];
    let diffText = "";
    if (allFiles.length > 0) {
      diffText = runTrustedCloneGit(input.binding, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", input.baseSha]);
      if (diffText.length > MAX_DIFF_BYTES) {
        diffText = `${diffText.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated)`;
      }
    }
    return {
      changedFiles: allFiles.map(sanitizeLine),
      diffText: sanitizeDisplay(diffText),
      dirty: allFiles.length > 0 || statusLines.length > 0,
    };
  } catch {
    return { changedFiles: [], diffText: "", dirty: false };
  }
}

function defaultSpawnTurn(
  custody: CustodyIO,
  input: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logPath: string; stderrPath: string; fence?: DirectChatTurnFence }
): { pid: number; pgid: number; startIdentity: string | null } {
  // Inside the turn's fence when it has one (confined refuses rather than run it bare where no OS fence applies).
  const launch = input.fence === undefined ? { file: input.binary, args: input.args, env: {} as Record<string, string> }
    : confined(input.binary, input.args, { fence: input.fence.launch.fence, fenceGrants: input.fence.launch.fenceGrants, confinement: input.fence.launch.confinement, cwd: input.cwd, temp: input.fence.temp });
  mkdirSync(dirname(input.logPath), { recursive: true, mode: 0o700 });
  const outFd = openSync(input.logPath, "a", 0o600);
  const errFd = openSync(input.stderrPath, "a", 0o600);
  try {
    const opts: SpawnOptions = {
      cwd: input.cwd,
      env: input.fence === undefined ? input.env : { ...input.env, ...input.fence.env, ...launch.env },
      detached: true,
      stdio: ["ignore", outFd, errFd],
    };
    const child = spawn(launch.file, launch.args, opts);
    if (child.pid === undefined) {
      throw new Error(`Could not start ${basename(input.binary)}.`);
    }
    child.unref();
    const pid = child.pid;
    let row: ProcRow | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      row = custody.table()?.find(one => one.pid === pid) ?? null;
      if (row !== null) break;
    }
    return { pid, pgid: row?.pgid ?? pid, startIdentity: row?.start ?? null };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

export class DirectChatHost {
  private readonly store: Store;
  readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly custody: CustodyIO;
  private readonly bootId: () => string | null;
  private readonly stopGraceMs: number;
  private readonly locateBinary: (provider: DirectChatProvider) => string | null;
  private readonly spawnTurnFn: NonNullable<DirectChatHostSeams["spawnTurn"]>;
  private readonly fenceTurnFn: DirectChatFenceFn | null;
  /** Each running Claude turn's fence closer (its proxy and temp folder), closed when the turn settles. */
  private readonly turnFences = new Map<string, () => Promise<void>>();
  private readonly prepareCloneFn: NonNullable<DirectChatHostSeams["prepareClone"]>;
  private readonly readDiffFn: NonNullable<DirectChatHostSeams["readDiff"]>;
  private readonly hasCustomReadDiff: boolean;
  private readonly onNotify: (note: DirectChatNotification) => void;
  private readonly sawTerminalByTurn = new Set<string>();
  private readonly resetOnNextTextDelta = new Set<string>();
  private readonly pendingSwitchFrom = new Map<string, DirectChatProvider>();
  private readonly preTurnImages = new Map<string, WorkspaceImageSnapshot>();
  private readonly inFlightCreates = new Map<string, Promise<{ ok: true; thread: DirectChatThreadRow; turn: DirectChatTurnRow; created: boolean } | { ok: false; status: number; error: string }>>();
  private readonly pendingCleanups = new Set<Promise<void>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollTicks = 0;

  constructor(store: Store, seams: DirectChatHostSeams) {
    this.store = store;
    this.stateRoot = seams.stateRoot;
    this.now = seams.now ?? (() => new Date());
    this.custody = seams.custody ?? defaultCustodyIO();
    this.bootId = seams.bootId ?? (() => currentBootId());
    this.stopGraceMs = seams.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.locateBinary = seams.locateBinary ?? (provider => locateDirectChatBinary(provider));
    this.spawnTurnFn = seams.spawnTurn ?? (input => defaultSpawnTurn(this.custody, input));
    this.fenceTurnFn = seams.fenceTurn ?? (seams.spawnTurn === undefined ? directChatFence(store) : null);
    this.prepareCloneFn = seams.prepareClone ?? defaultPrepareCloneAsync;
    this.hasCustomReadDiff = seams.readDiff !== undefined;
    this.readDiffFn = seams.readDiff ?? defaultReadDiff;
    this.onNotify = seams.onNotify ?? (() => {});
  }

  startPolling(intervalMs = 80): void {
    if (this.pollTimer !== null) return;
    this.pollTicks = 0;
    this.sweepTrash();
    const custodyEvery = Math.max(1, Math.round(500 / Math.max(20, intervalMs)));
    this.reconcileRunningTurns();
    this.pollTimer = setInterval(() => {
      this.pollTicks += 1;
      if (this.pollTicks % custodyEvery === 0) {
        this.reconcileRunningTurns();
      } else {
        this.drainRunningTurnLogs();
      }
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  close(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const turnId of [...this.turnFences.keys()]) this.closeTurnFence(turnId);
  }

  private closeTurnFence(turnId: string): void {
    const close = this.turnFences.get(turnId);
    if (close === undefined) return;
    this.turnFences.delete(turnId);
    // A fence that didn't close cleanly is said, in the server's log and on the turn itself, never swallowed.
    this.trackCleanup(close().catch((error: unknown) => {
      const said = `Toolroll couldn't finish closing this turn's sandbox: ${error instanceof Error ? error.message : String(error)}.`;
      console.warn(`direct chat turn ${turnId}: ${said}`);
      try {
        this.store.handle.prepare(`UPDATE direct_chat_turn SET error_text = CASE WHEN error_text IS NULL OR error_text = '' THEN ? ELSE error_text || char(10) || ? END WHERE id = ?`)
          .run(said, said, turnId);
      } catch { /* the log above still says it */ }
    }));
  }

  /** Await any background trash deletions scheduled by deleteThread(). */
  async drainPendingCleanups(): Promise<void> {
    while (this.pendingCleanups.size > 0) {
      await Promise.allSettled([...this.pendingCleanups]);
    }
  }

  private trackCleanup(task: Promise<void>): void {
    const wrapped = task.catch(() => {}).finally(() => {
      this.pendingCleanups.delete(wrapped);
    });
    this.pendingCleanups.add(wrapped);
  }

  /**
   * Atomically relocate a managed clone or git-dir into `direct-chat/trash/` in O(1) via renameSync, then
   * unlink it asynchronously off the event loop so deleting a clone with node_modules never stalls the server.
   */
  private scheduleAsyncDelete(targetPath: string): void {
    if (!existsSync(targetPath)) return;
    const trashRoot = join(this.stateRoot, "direct-chat", "trash");
    let toRemove = targetPath;
    try {
      mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
      const staged = join(trashRoot, `${randomBytes(8).toString("hex")}-${basename(targetPath)}`);
      renameSync(targetPath, staged);
      toRemove = staged;
    } catch {
      // Cross-device or race: fall back to async removal of the original managed path.
    }
    this.trackCleanup(rm(toRemove, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  }

  /** Sweep any leftover entries under `direct-chat/trash/` left behind by a prior hard crash. */
  private sweepTrash(): void {
    const trashRoot = join(this.stateRoot, "direct-chat", "trash");
    if (!existsSync(trashRoot)) return;
    this.trackCleanup((async () => {
      const entries = await readdir(trashRoot);
      await Promise.allSettled(
        entries.map(name => rm(join(trashRoot, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
      );
    })());
  }

  /** Fast boolean dirty check for delete protection: avoids generating full diff patches or DB cache writes. */
  private hasUnmergedChanges(thread: DirectChatThreadRow): boolean {
    const binding = this.bindingOf(thread);
    if (binding === null) return false;
    if (this.hasCustomReadDiff) {
      return this.readDiffFn({ binding, baseSha: thread.baseSha }).dirty;
    }
    if (!existsSync(binding.clonePath)) return false;
    const verified = assertTrustedCloneGit(binding);
    if (!verified.ok) return false;
    try {
      if (runTrustedCloneGit(binding, ["status", "--porcelain"]).trim() !== "") return true;
      if (runTrustedCloneGit(binding, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", thread.baseSha]).trim() !== "") return true;
      return false;
    } catch {
      return false;
    }
  }

  bindingOf(thread: Pick<DirectChatThreadRow, "clonePath" | "gitDir" | "configSha256">): TrustedCloneBinding | null {
    if (!thread.gitDir || !thread.configSha256) return null;
    return {
      stateRoot: this.stateRoot,
      clonePath: thread.clonePath,
      gitDir: thread.gitDir,
      configSha256: thread.configSha256,
    };
  }

  refreshDiffCache(thread: DirectChatThreadRow): DirectChatDiffSummary {
    const binding = this.bindingOf(thread);
    const diff = binding === null ? { ...EMPTY_DIFF } : this.readDiffFn({ binding, baseSha: thread.baseSha });
    this.store.handle
      .prepare(`UPDATE direct_chat_thread SET diff_cache_json = ? WHERE id = ?`)
      .run(JSON.stringify(diff), thread.id);
    return diff;
  }

  getThreadRecord(owner: string, threadId: string): DirectChatThreadRow | null {
    if (!HEX32.test(threadId)) return null;
    const raw = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(threadId, owner) as Record<string, unknown> | undefined;
    return raw ? this.mapThread(raw) : null;
  }

  listThreads(owner: string, projectFilter?: string | null): Array<DirectChatThreadRow & { running: boolean; lastStatus: DirectChatTurnStatus | null; changedFilesCount: number }> {
    const rows = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE owner = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 80`)
      .all(owner) as Record<string, unknown>[];
    const out: Array<DirectChatThreadRow & { running: boolean; lastStatus: DirectChatTurnStatus | null; changedFilesCount: number }> = [];
    for (const raw of rows) {
      const thread = this.mapThread(raw);
      if (projectFilter && projectFilter !== "" && thread.project.toLowerCase() !== projectFilter.toLowerCase() && thread.repo !== projectFilter) {
        continue;
      }
      const last = this.store.handle
        .prepare(`SELECT status FROM direct_chat_turn WHERE thread_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(thread.id) as Record<string, unknown> | undefined;
      const lastStatus = (typeof last?.["status"] === "string" ? last["status"] as DirectChatTurnStatus : null);
      // Read cached diff only — GET list NEVER spawns git in an agent-writable folder.
      out.push({
        ...thread,
        running: lastStatus === "running",
        lastStatus,
        changedFilesCount: thread.diffCache.changedFiles.length,
      });
    }
    return out;
  }

  getThread(owner: string, threadId: string): { thread: DirectChatThreadRow; turns: DirectChatTurnRow[]; attachments: DirectChatArtifactRow[]; diff: DirectChatDiffSummary; running: boolean } | null {
    if (!HEX32.test(threadId)) return null;
    const raw = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(threadId, owner) as Record<string, unknown> | undefined;
    if (!raw) return null;
    const thread = this.mapThread(raw);
    const turns = this.loadTurns(thread.id);
    const attachments = listArtifactsForThread(this.store, thread.id).filter(a => a.kind === "attachment");
    const running = turns.some(t => t.status === "running");
    // Read cached diff only — GET detail NEVER spawns git in an agent-writable folder.
    return { thread, turns, attachments, diff: thread.diffCache, running };
  }

  attachFile(input: {
    owner: string;
    threadId: string;
    filename: string;
    mimeType?: string | undefined;
    bytes: Buffer;
  }): { ok: true; artifact: DirectChatArtifactRow; cloneRelativePath: string | null } | { ok: false; status: number; error: string } {
    if (!HEX32.test(input.threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const thread = this.getThreadRecord(input.owner, input.threadId);
    if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };
    const managed = assertManagedClonePath(this.stateRoot, thread.clonePath);
    if (!managed.ok) return { ok: false, status: 409, error: managed.error };

    const saved = saveDirectChatArtifact(this.store, {
      stateRoot: this.stateRoot,
      threadId: thread.id,
      turnId: null,
      kind: "attachment",
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: input.bytes,
      clonePath: thread.clonePath,
      gitDir: thread.gitDir,
      now: this.now(),
    });
    if (saved.ok) {
      this.store.handle.prepare(`UPDATE direct_chat_thread SET updated_at = ? WHERE id = ?`).run(this.now().toISOString(), thread.id);
      this.onNotify({ threadId: thread.id, turnId: null, event: "change" });
    }
    return saved;
  }

  getArtifact(owner: string, threadId: string, artifactId: string): { row: DirectChatArtifactRow; bytes: Buffer } | null {
    if (!HEX32.test(threadId) || !HEX32.test(artifactId)) return null;
    const raw = this.store.handle
      .prepare(`SELECT id FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(threadId, owner) as Record<string, unknown> | undefined;
    if (!raw) return null;
    return getDirectChatArtifact(this.store, this.stateRoot, threadId, artifactId);
  }

  applyMainEdits(owner: string, threadId: string): ApplyMainDirtyPatchResult {
    if (!HEX32.test(threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const thread = this.getThreadRecord(owner, threadId);
    if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };
    const binding = this.bindingOf(thread);
    if (binding === null) return { ok: false, status: 409, error: "This chat has no isolated clone workspace (read-only)." };
    const active = this.store.handle
      .prepare(`SELECT id FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' LIMIT 1`)
      .get(thread.id) as Record<string, unknown> | undefined;
    if (active) return { ok: false, status: 409, error: "Stop the running turn before bringing in uncommitted edits." };
    const res = applyMainDirtyPatch({ repo: thread.repo, binding });
    if (res.ok) {
      const stamp = this.now().toISOString();
      this.store.handle.prepare(`UPDATE direct_chat_thread SET main_dirty_files = NULL, updated_at = ? WHERE id = ?`).run(stamp, thread.id);
      this.refreshDiffCache(thread);
      this.onNotify({ threadId: thread.id, turnId: null, event: "change" });
    }
    return res;
  }

  repairCloneGit(owner: string, threadId: string): { ok: true; said: string } | { ok: false; status: number; error: string } {
    if (!HEX32.test(threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const thread = this.getThreadRecord(owner, threadId);
    if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };
    if (thread.isLegacy) {
      return { ok: false, status: 409, error: "Imported chats are read-only history." };
    }
    const active = this.store.handle
      .prepare(`SELECT id FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' LIMIT 1`)
      .get(thread.id) as Record<string, unknown> | undefined;
    if (active) return { ok: false, status: 409, error: "Stop the running turn before repairing the workspace git binding." };
    const binding = this.bindingOf(thread);
    if (binding === null) return { ok: false, status: 409, error: "This chat has no isolated clone workspace (read-only)." };
    const repaired = repairCloneGitBinding(binding);
    if (!repaired.ok) return { ok: false, status: 409, error: repaired.error };
    const stamp = this.now().toISOString();
    this.store.handle.prepare(`UPDATE direct_chat_thread SET updated_at = ? WHERE id = ?`).run(stamp, thread.id);
    this.refreshDiffCache(thread);
    this.onNotify({ threadId: thread.id, turnId: null, event: "change" });
    return { ok: true, said: "Workspace git binding repaired." };
  }

  async createThread(input: {
    owner: string;
    localGeneration: number | null;
    accountGeneration: number;
    requestId: string;
    repo: string;
    provider: DirectChatProvider;
    modelId?: string;
    effort?: string | null;
    prompt: string;
  }): Promise<{ ok: true; thread: DirectChatThreadRow; turn: DirectChatTurnRow; created: boolean } | { ok: false; status: number; error: string }> {
    const trimmedPrompt = input.prompt.trim();
    if (trimmedPrompt === "") return { ok: false, status: 400, error: "Write a message to start a chat." };
    if (!HEX32.test(input.requestId)) return { ok: false, status: 400, error: "Invalid request id." };

    const dedupeKey = `${input.owner}:${input.requestId}`;
    const existingPromise = this.inFlightCreates.get(dedupeKey);
    if (existingPromise !== undefined) {
      return existingPromise;
    }

    const work = this.createThreadImpl(input, trimmedPrompt);
    this.inFlightCreates.set(dedupeKey, work);
    try {
      return await work;
    } finally {
      this.inFlightCreates.delete(dedupeKey);
    }
  }

  private async createThreadImpl(
    input: {
      owner: string;
      localGeneration: number | null;
      accountGeneration: number;
      requestId: string;
      repo: string;
      provider: DirectChatProvider;
      modelId?: string;
      effort?: string | null;
      prompt: string;
    },
    trimmedPrompt: string,
  ): Promise<{ ok: true; thread: DirectChatThreadRow; turn: DirectChatTurnRow; created: boolean } | { ok: false; status: number; error: string }> {
    const existing = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE owner = ? AND create_request_id = ?`)
      .get(input.owner, input.requestId) as Record<string, unknown> | undefined;
    if (existing) {
      const thread = this.mapThread(existing);
      const turns = this.loadTurns(thread.id);
      if (turns[0]) return { ok: true, thread, turn: turns[0], created: false };
    }

    const binary = this.locateBinary(input.provider);
    if (binary === null) {
      return { ok: false, status: 409, error: `${input.provider} CLI is not installed on this computer.` };
    }

    const threadId = randomBytes(16).toString("hex");
    const shortId = threadId.slice(0, 8);
    const safeRepo = basename(input.repo).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
    const clonePath = join(this.stateRoot, "direct-chat", "clones", `${safeRepo}-${shortId}`);
    const gitDir = join(this.stateRoot, "direct-chat", "gitdirs", threadId);
    const branch = `toolroll/chat-${shortId}`;

    let baseSha: string;
    let resolvedGitDir: string;
    let configSha256: string;
    let mainDirtyFiles: string[];
    try {
      const prep = await this.prepareCloneFn({ stateRoot: this.stateRoot, repo: input.repo, clonePath, gitDir, branch });
      baseSha = prep.baseSha;
      resolvedGitDir = prep.gitDir;
      configSha256 = prep.configSha256;
      mainDirtyFiles = prep.mainDirtyFiles;
    } catch (error) {
      try {
        if (existsSync(clonePath)) rmSync(clonePath, { recursive: true, force: true });
        if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true });
        const backup = pinnedConfigBackupPath(gitDir);
        if (existsSync(backup)) rmSync(backup, { force: true });
      } catch {
        // Best-effort cleanup of failed clone preparation.
      }
      return { ok: false, status: 500, error: `Could not prepare isolated clone: ${error instanceof Error ? error.message : String(error)}` };
    }

    const firstLine = trimmedPrompt.split(/\r?\n/)[0]?.trim() ?? trimmedPrompt;
    const title = sanitizeLine(firstLine.slice(0, 72)) || "New chat";
    const modelId = (input.modelId && input.modelId.trim() !== "") ? input.modelId.trim() : defaultModelForProvider(input.provider);
    const effort = normalizeDirectChatEffort(input.effort, input.provider) ?? "";
    const stamp = this.now().toISOString();

    this.store.handle.prepare(`
      INSERT INTO direct_chat_thread (
        id, owner, local_generation, account_generation, create_request_id,
        title, repo, clone_path, git_dir, config_sha256, diff_cache_json, is_legacy,
        branch, base_sha, provider, model_id, effort,
        provider_session_id, main_dirty_files, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    `).run(
      threadId,
      input.owner,
      input.localGeneration,
      input.accountGeneration,
      input.requestId,
      title,
      input.repo,
      clonePath,
      resolvedGitDir,
      configSha256,
      JSON.stringify(EMPTY_DIFF),
      branch,
      baseSha,
      input.provider,
      modelId,
      effort,
      mainDirtyFiles.length > 0 ? JSON.stringify(mainDirtyFiles) : null,
      stamp,
      stamp
    );

    const started = await this.sendMessage({
      owner: input.owner,
      threadId,
      requestId: input.requestId,
      prompt: trimmedPrompt,
    });
    if (!started.ok) {
      return started;
    }
    const thread = this.mapThread(
      this.store.handle.prepare(`SELECT * FROM direct_chat_thread WHERE id = ?`).get(threadId) as Record<string, unknown>
    );
    return { ok: true, thread, turn: started.turn, created: true };
  }

  /**
   * Starts a turn. A Claude turn runs inside its outer fence (direct-chat-fence.ts), made first (it waits on the
   * storage check and the proxy); everything after it, the checks and the spawn, runs in one synchronous step as before,
   * and a turn that doesn't start closes the fence it was given.
   */
  async sendMessage(input: {
    owner: string;
    threadId: string;
    requestId: string;
    prompt: string;
  }): Promise<{ ok: true; turn: DirectChatTurnRow; created: boolean } | { ok: false; status: number; error: string }> {
    const thread = HEX32.test(input.threadId) ? this.getThreadRecord(input.owner, input.threadId) : null;
    if (thread === null || thread.provider !== "claude" || thread.isLegacy || this.fenceTurnFn === null) return this.sendMessageNow(input, null);
    if (thread.gitDir === null) return { ok: false, status: 409, error: "This chat has no isolated Git folder, so its agent can't be fenced. Start a new chat instead." };
    const known = this.store.handle.prepare(`SELECT 1 FROM direct_chat_turn WHERE thread_id = ? AND request_id = ?`).get(thread.id, input.requestId);
    if (known !== undefined) return this.sendMessageNow(input, null);
    const made = await this.fenceTurnFn({ stateRoot: this.stateRoot, repo: thread.repo, clone: thread.clonePath, gitDir: thread.gitDir });
    if ("problem" in made) return { ok: false, status: 409, error: made.problem };
    const fence = "unfenced" in made ? null : made;
    let started: Awaited<ReturnType<DirectChatHost["sendMessage"]>>;
    try { started = this.sendMessageNow(input, fence); }
    catch (error) { if (fence !== null) await fence.close(); throw error; }
    if (fence !== null && (!started.ok || !started.created)) await fence.close();
    return started;
  }

  private sendMessageNow(input: {
    owner: string;
    threadId: string;
    requestId: string;
    prompt: string;
  }, fence: DirectChatTurnFence | null): { ok: true; turn: DirectChatTurnRow; created: boolean } | { ok: false; status: number; error: string } {
    if (!HEX32.test(input.threadId) || !HEX32.test(input.requestId)) {
      return { ok: false, status: 400, error: "Invalid thread or request id." };
    }
    const trimmed = input.prompt.trim();
    if (trimmed === "") return { ok: false, status: 400, error: "Write a message first." };

    const thread = this.getThreadRecord(input.owner, input.threadId);
    if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };
    if (thread.isLegacy) {
      return { ok: false, status: 409, error: "Imported chats are read-only history. Start a new chat to continue." };
    }
    const managed = assertManagedClonePath(this.stateRoot, thread.clonePath);
    if (!managed.ok) return { ok: false, status: 409, error: managed.error };

    const dupTurn = this.store.handle
      .prepare(`SELECT * FROM direct_chat_turn WHERE thread_id = ? AND request_id = ?`)
      .get(thread.id, input.requestId) as Record<string, unknown> | undefined;
    if (dupTurn) {
      return { ok: true, turn: this.mapTurn(dupTurn), created: false };
    }

    const active = this.store.handle
      .prepare(`SELECT id FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' LIMIT 1`)
      .get(thread.id) as Record<string, unknown> | undefined;
    if (active) {
      return { ok: false, status: 409, error: "A turn is already running or stopping in this chat." };
    }

    const binary = this.locateBinary(thread.provider);
    if (binary === null) {
      return { ok: false, status: 409, error: `${thread.provider} CLI is not installed on this computer.` };
    }

    const priorTurns = this.loadTurns(thread.id);
    const nextSeq = (priorTurns.at(-1)?.seq ?? 0) + 1;
    const turnId = randomBytes(16).toString("hex");
    const logPath = join(this.stateRoot, "direct-chat", "turns", thread.id, `${turnId}.jsonl`);
    const stderrPath = join(this.stateRoot, "direct-chat", "turns", thread.id, `${turnId}.stderr`);
    const isFirstForProvider = thread.providerSessionId === null || thread.providerSessionId === "";
    const effectivePrompt = buildTurnPrompt({
      userPrompt: trimmed,
      branch: thread.branch,
      isFirstTurnForProvider: isFirstForProvider,
      priorTurns: priorTurns.filter(t => t.assistantText !== "" || t.userPrompt !== ""),
    });
    const args = buildProviderCommand({
      provider: thread.provider,
      modelId: thread.modelId,
      effort: thread.effort,
      prompt: effectivePrompt,
      sessionId: thread.providerSessionId,
    });
    const stamp = this.now().toISOString();
    const beforeImages = snapshotWorkspaceImages(thread.clonePath);
    const switchedFrom = this.pendingSwitchFrom.get(thread.id) ?? null;

    // Insert the turn row BEFORE spawning the child process so a DB failure can never leak an untracked process.
    this.store.handle.prepare(`
      INSERT INTO direct_chat_turn (
        id, thread_id, seq, request_id, user_prompt, switched_from_provider,
        log_path, stderr_path, byte_offset, pid, start_identity, pgid, boot_id,
        status, stop_requested_at, assistant_text, error_text, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, 'running', NULL, '', NULL, ?, NULL)
    `).run(
      turnId,
      thread.id,
      nextSeq,
      input.requestId,
      trimmed,
      switchedFrom,
      logPath,
      stderrPath,
      this.bootId(),
      stamp
    );

    let launched: { pid: number; pgid: number; startIdentity: string | null };
    try {
      launched = this.spawnTurnFn({
        binary,
        args,
        cwd: managed.realClone,
        env: buildSanitizedChildEnv(thread.provider),
        logPath,
        stderrPath,
        ...(fence === null ? {} : { fence }),
      });
    } catch (error) {
      const msg = `Could not launch ${thread.provider}: ${error instanceof Error ? error.message : String(error)}`;
      this.store.handle.prepare(`
        UPDATE direct_chat_turn SET status = 'failed', error_text = ?, finished_at = ? WHERE id = ?
      `).run(msg, this.now().toISOString(), turnId);
      return { ok: false, status: 500, error: msg };
    }

    this.pendingSwitchFrom.delete(thread.id);
    this.preTurnImages.set(turnId, beforeImages);
    if (fence !== null) this.turnFences.set(turnId, fence.close);

    this.store.handle.prepare(`
      UPDATE direct_chat_turn SET pid = ?, start_identity = ?, pgid = ? WHERE id = ?
    `).run(launched.pid, launched.startIdentity, launched.pgid, turnId);
    this.store.handle.prepare(`UPDATE direct_chat_thread SET updated_at = ? WHERE id = ?`).run(stamp, thread.id);
    this.onNotify({ threadId: thread.id, turnId, event: "change" });

    const createdRow = this.store.handle.prepare(`SELECT * FROM direct_chat_turn WHERE id = ?`).get(turnId) as Record<string, unknown>;
    return { ok: true, turn: this.mapTurn(createdRow), created: true };
  }

  switchModel(input: {
    owner: string;
    threadId: string;
    provider: DirectChatProvider;
    modelId: string;
    effort?: string | null;
  }): { ok: true; thread: DirectChatThreadRow } | { ok: false; status: number; error: string } {
    if (!HEX32.test(input.threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const raw = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(input.threadId, input.owner) as Record<string, unknown> | undefined;
    if (!raw) return { ok: false, status: 404, error: "Chat thread not found." };
    const thread = this.mapThread(raw);
    const active = this.store.handle
      .prepare(`SELECT id FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' LIMIT 1`)
      .get(thread.id) as Record<string, unknown> | undefined;
    if (active) return { ok: false, status: 409, error: "Stop the running turn before switching models." };

    const providerChanged = thread.provider !== input.provider;
    if (providerChanged) {
      this.pendingSwitchFrom.set(thread.id, thread.provider);
    }
    const nextModel = input.modelId.trim() !== "" ? input.modelId.trim() : defaultModelForProvider(input.provider);
    const nextEffort = input.effort !== undefined
      ? (normalizeDirectChatEffort(input.effort, input.provider) ?? "")
      : (thread.effort ?? "");
    const stamp = this.now().toISOString();
    this.store.handle.prepare(`
      UPDATE direct_chat_thread
      SET provider = ?, model_id = ?, effort = ?, provider_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(input.provider, nextModel, nextEffort, providerChanged ? null : thread.providerSessionId, stamp, thread.id);
    this.onNotify({ threadId: thread.id, turnId: null, event: "change" });
    const updated = this.store.handle.prepare(`SELECT * FROM direct_chat_thread WHERE id = ?`).get(thread.id) as Record<string, unknown>;
    return { ok: true, thread: this.mapThread(updated) };
  }

  stopThread(owner: string, threadId: string): { ok: true; stopped: boolean; stopping: boolean } | { ok: false; status: number; error: string } {
    if (!HEX32.test(threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const thread = this.getThreadRecord(owner, threadId);
    if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };

    const running = this.store.handle
      .prepare(`SELECT * FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1`)
      .get(threadId) as Record<string, unknown> | undefined;
    if (!running) return { ok: true, stopped: false, stopping: false };

    const turn = this.mapTurn(running);
    const stamp = this.now().toISOString();
    if (turn.stopRequestedAt === null) {
      this.store.handle
        .prepare(`UPDATE direct_chat_turn SET stop_requested_at = ? WHERE id = ? AND status = 'running'`)
        .run(stamp, turn.id);
    }
    const updatedTurn = this.reloadTurn(turn.id) ?? { ...turn, stopRequestedAt: turn.stopRequestedAt ?? stamp };
    const beforeStop = this.assessTurnCustody(updatedTurn, this.custody.table());
    if (beforeStop.state === "alive" && beforeStop.members.length > 0) {
      this.custody.signal(beforeStop.members, "SIGTERM");
    }

    // Re-verify process exit via custody: ONLY mark stopped once proven gone.
    const afterTable = this.custody.table();
    this.reconcileSingleTurn(thread, updatedTurn, afterTable);
    const latest = this.reloadTurn(turn.id);
    const finished = latest !== null && latest.status !== "running";
    return { ok: true, stopped: finished, stopping: !finished };
  }

  deleteThread(input: {
    owner: string;
    threadId: string;
    discardChanges?: boolean;
    keepClone?: boolean;
  }): { ok: true; removedClone: boolean } | { ok: false; status: number; error: string; code?: string } {
    if (!HEX32.test(input.threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const thread = this.getThreadRecord(input.owner, input.threadId);
    if (!thread) return { ok: false, status: 404, error: "Chat thread not found." };

    // Refuse to delete while any turn is still running or stopping (prevents deleting a clone under a live agent).
    const active = this.store.handle
      .prepare(`SELECT id FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' LIMIT 1`)
      .get(thread.id) as Record<string, unknown> | undefined;
    if (active) {
      const stopAttempt = this.stopThread(input.owner, thread.id);
      if (!stopAttempt.ok) return stopAttempt;
      if (stopAttempt.stopping) {
        return {
          ok: false,
          status: 409,
          code: "turn_stopping",
          error: "This chat's agent is still stopping. Wait a moment for it to exit, then delete.",
        };
      }
    }

    // Skip git dirty checks completely when the caller already confirmed discarding changes or keeping the clone.
    if (!input.discardChanges && !input.keepClone) {
      if (this.hasUnmergedChanges(thread)) {
        return {
          ok: false,
          status: 409,
          code: "unmerged_changes",
          error: "This chat has unmerged changes. Confirm discarding changes or choose to keep the branch.",
        };
      }
    }

    const stamp = this.now().toISOString();
    this.store.handle.prepare(`UPDATE direct_chat_thread SET archived_at = ?, updated_at = ? WHERE id = ?`).run(stamp, stamp, thread.id);

    let removedClone = false;
    if (!input.keepClone) {
      const managed = assertManagedClonePath(this.stateRoot, thread.clonePath);
      if (managed.ok) {
        this.scheduleAsyncDelete(managed.realClone);
        removedClone = true;
      }
      if (thread.gitDir && existsSync(thread.gitDir)) {
        const gitDirsRoot = join(this.stateRoot, "direct-chat", "gitdirs");
        if (existsSync(gitDirsRoot)) {
          try {
            const realRoot = realpathSync(gitDirsRoot);
            const realGd = realpathSync(thread.gitDir);
            const rel = relative(realRoot, realGd);
            if (rel !== "" && rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel)) {
              this.scheduleAsyncDelete(realGd);
              const backup = pinnedConfigBackupPath(realGd);
              if (existsSync(backup)) this.scheduleAsyncDelete(backup);
            }
          } catch {
            // Best-effort cleanup of separate git-dir.
          }
        }
      }
    }
    this.onNotify({ threadId: thread.id, turnId: null, event: "change" });
    return { ok: true, removedClone };
  }

  drainRunningTurnLogs(): void {
    const runningRows = this.store.handle
      .prepare(`SELECT t.* FROM direct_chat_turn t JOIN direct_chat_thread th ON th.id = t.thread_id WHERE t.status = 'running' AND th.archived_at IS NULL`)
      .all() as Record<string, unknown>[];
    if (runningRows.length === 0) return;
    for (const rawTurn of runningRows) {
      const turn = this.mapTurn(rawTurn);
      const rawThread = this.store.handle
        .prepare(`SELECT * FROM direct_chat_thread WHERE id = ?`)
        .get(turn.threadId) as Record<string, unknown> | undefined;
      if (!rawThread) continue;
      const thread = this.mapThread(rawThread);
      const advanced = this.drainTurnLog(thread, turn, false);
      if (!advanced) continue;
      const latest = this.reloadTurn(turn.id) ?? turn;
      if (latest.status !== "running") {
        const preImages = this.preTurnImages.get(turn.id);
        const sinceMs = Date.parse(turn.createdAt);
        captureNewWorkspaceArtifacts(this.store, {
          stateRoot: this.stateRoot,
          threadId: thread.id,
          turnId: turn.id,
          clonePath: thread.clonePath,
          ...(preImages !== undefined ? { before: preImages } : Number.isFinite(sinceMs) ? { sinceMs } : {}),
          now: this.now(),
        });
        this.refreshDiffCache(thread);
        this.cleanupTurnState(turn.id);
        this.onNotify({ threadId: thread.id, turnId: turn.id, event: "change" });
      } else {
        this.onNotify({ threadId: thread.id, turnId: turn.id, event: "turn" });
      }
    }
  }

  reconcileRunningTurns(): void {
    const runningRows = this.store.handle
      .prepare(`SELECT t.* FROM direct_chat_turn t JOIN direct_chat_thread th ON th.id = t.thread_id WHERE t.status = 'running' AND th.archived_at IS NULL`)
      .all() as Record<string, unknown>[];
    if (runningRows.length === 0) return;
    // Read the OS process table ONCE per poll tick for all running turns.
    const tableSnapshot = this.custody.table();
    for (const rawTurn of runningRows) {
      const turn = this.mapTurn(rawTurn);
      const rawThread = this.store.handle
        .prepare(`SELECT * FROM direct_chat_thread WHERE id = ?`)
        .get(turn.threadId) as Record<string, unknown> | undefined;
      if (!rawThread) continue;
      this.reconcileSingleTurn(this.mapThread(rawThread), turn, tableSnapshot);
    }
  }

  private assessTurnCustody(
    turn: DirectChatTurnRow,
    tableSnapshot: ProcRow[] | null,
  ): { state: "alive" | "dead" | "unknown"; members: ProcessWitness[] } {
    if (turn.pid === null) return { state: "dead", members: [] };
    const curBoot = this.bootId();
    if (turn.bootId !== null && provenDeadByBootChange({ host: hostname(), bootId: turn.bootId }, { host: hostname(), bootId: curBoot })) {
      return { state: "dead", members: [] };
    }
    // Unreadable process table is ALWAYS unknown — never settle a potentially live agent as dead.
    if (tableSnapshot === null) return { state: "unknown", members: [] };
    // Never signal or guess identity without a recorded startIdentity.
    if (turn.startIdentity === null) {
      const row = tableSnapshot.find(one => one.pid === turn.pid && !one.zombie);
      return row ? { state: "unknown", members: [] } : { state: "dead", members: [] };
    }

    const launch: LaunchCustody = {
      host: hostname(),
      machineId: null,
      bootId: turn.bootId,
      leader: { pid: turn.pid, start: turn.startIdentity },
      namespaces: [],
      witnesses: [{ pid: turn.pid, start: turn.startIdentity }],
      folder: "",
    };
    const scan = scanCustody(launch, {
      ...this.custody,
      table: () => tableSnapshot,
    }, { holders: false });
    if (scan.incomplete !== null) return { state: "unknown", members: [] };
    if (scan.members.length > 0) {
      return {
        state: "alive",
        members: scan.members.map(m => ({ pid: m.pid, start: m.start })),
      };
    }
    return { state: "dead", members: [] };
  }

  private reconcileSingleTurn(
    thread: DirectChatThreadRow,
    turn: DirectChatTurnRow,
    tableSnapshot: ProcRow[] | null,
  ): void {
    const advanced = this.drainTurnLog(thread, turn, false);
    const custodyState = this.assessTurnCustody(turn, tableSnapshot);

    if (custodyState.state === "alive" || custodyState.state === "unknown") {
      if (turn.stopRequestedAt !== null && custodyState.state === "alive" && custodyState.members.length > 0) {
        const elapsedMs = this.now().getTime() - Date.parse(turn.stopRequestedAt);
        if (Number.isFinite(elapsedMs) && elapsedMs >= this.stopGraceMs) {
          this.custody.signal(custodyState.members, "SIGKILL");
        }
      }
      // Escape hatch for missing startIdentity (e.g., ps briefly missed the process at spawn and the PID
      // was reused): never signal an unproven PID, but once the owner requests Stop and stopGraceMs has
      // elapsed (or the turn log already recorded a terminal event), settle cleanly instead of wedging forever.
      const latestAfterDrain = this.reloadTurn(turn.id) ?? turn;
      const missingIdentityExpiredStop =
        custodyState.state === "unknown"
        && turn.startIdentity === null
        && latestAfterDrain.stopRequestedAt !== null
        && Number.isFinite(this.now().getTime() - Date.parse(latestAfterDrain.stopRequestedAt))
        && (this.now().getTime() - Date.parse(latestAfterDrain.stopRequestedAt)) >= this.stopGraceMs;
      const missingIdentityTerminalLog =
        custodyState.state === "unknown"
        && turn.startIdentity === null
        && latestAfterDrain.status !== "running";
      if (!missingIdentityExpiredStop && !missingIdentityTerminalLog) {
        if (advanced) {
          this.onNotify({ threadId: thread.id, turnId: turn.id, event: "turn" });
        }
        return;
      }
      if (missingIdentityExpiredStop && latestAfterDrain.status === "running") {
        this.drainTurnLog(thread, latestAfterDrain, true);
        const stamp = this.now().toISOString();
        this.store.handle.prepare(`
          UPDATE direct_chat_turn
          SET status = 'interrupted', error_text = COALESCE(error_text, ?), finished_at = ?
          WHERE id = ? AND status = 'running'
        `).run("Stopped without verified process identity; check if an agent process is still running.", stamp, turn.id);
        this.store.handle.prepare(`
          UPDATE direct_chat_tool SET status = 'done', updated_at = ? WHERE turn_id = ? AND status = 'running'
        `).run(stamp, turn.id);
        this.store.handle.prepare(`UPDATE direct_chat_thread SET updated_at = ? WHERE id = ?`).run(stamp, thread.id);
      }
      this.refreshDiffCache(thread);
      this.cleanupTurnState(turn.id);
      this.onNotify({ threadId: thread.id, turnId: turn.id, event: "change" });
      return;
    }

    // Verified dead: flush any remaining partial line at EOF, capture artifacts, and refresh cached diff.
    this.drainTurnLog(thread, this.reloadTurn(turn.id) ?? turn, true);
    const latest = this.reloadTurn(turn.id) ?? turn;
    const preImages = this.preTurnImages.get(turn.id);
    const sinceMs = Date.parse(turn.createdAt);
    captureNewWorkspaceArtifacts(this.store, {
      stateRoot: this.stateRoot,
      threadId: thread.id,
      turnId: turn.id,
      clonePath: thread.clonePath,
      ...(preImages !== undefined ? { before: preImages } : Number.isFinite(sinceMs) ? { sinceMs } : {}),
      now: this.now(),
    });
    this.refreshDiffCache(thread);

    if (latest.status !== "running") {
      this.cleanupTurnState(turn.id);
      this.onNotify({ threadId: thread.id, turnId: turn.id, event: "change" });
      return;
    }

    const stamp = this.now().toISOString();
    const wasStopRequested = latest.stopRequestedAt !== null;
    let finalStatus: DirectChatTurnStatus = wasStopRequested ? "stopped" : "completed";
    let errorText: string | null = latest.errorText;

    if (!wasStopRequested && !this.sawTerminalByTurn.has(turn.id)) {
      const stderrTail = this.readStderrTail(latest.stderrPath);
      if (latest.assistantText.trim() === "" && stderrTail !== "") {
        finalStatus = "failed";
        errorText = sanitizeDisplay(stderrTail);
      } else if (latest.assistantText.trim() === "" && latest.tools.length === 0) {
        finalStatus = "interrupted";
        errorText = "Turn ended before a response was recorded.";
      }
    }

    this.store.handle.prepare(`
      UPDATE direct_chat_turn
      SET status = ?, error_text = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(finalStatus, errorText, stamp, turn.id);
    this.store.handle.prepare(`
      UPDATE direct_chat_tool
      SET status = 'done', updated_at = ?
      WHERE turn_id = ? AND status = 'running'
    `).run(stamp, turn.id);
    this.store.handle.prepare(`UPDATE direct_chat_thread SET updated_at = ? WHERE id = ?`).run(stamp, thread.id);
    this.cleanupTurnState(turn.id);
    this.onNotify({ threadId: thread.id, turnId: turn.id, event: "change" });
  }

  private drainTurnLog(thread: DirectChatThreadRow, turn: DirectChatTurnRow, flushPartial = false): boolean {
    if (!existsSync(turn.logPath)) return false;
    let fileSize: number;
    try {
      fileSize = statSync(turn.logPath).size;
    } catch {
      return false;
    }
    if (fileSize <= turn.byteOffset) return false;

    const length = Math.min(fileSize - turn.byteOffset, MAX_LINE_BYTES);
    const buf = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    const fd = openSync(turn.logPath, "r");
    try {
      bytesRead = readSync(fd, buf, 0, length, turn.byteOffset);
    } finally {
      closeSync(fd);
    }
    if (bytesRead <= 0) return false;

    const slice = buf.subarray(0, bytesRead);
    // Advance byte_offset ONLY up to the last newline byte so a partial line (or split UTF-8 codepoint)
    // is never lost across a restart. Only consume trailing bytes without '\n' on final EOF flush.
    const lastNewline = slice.lastIndexOf(0x0a);
    let consumedBytes = 0;
    if (lastNewline >= 0) {
      consumedBytes = lastNewline + 1;
    } else if (flushPartial || bytesRead >= MAX_LINE_BYTES) {
      consumedBytes = bytesRead;
    } else {
      return false;
    }

    const nextOffset = turn.byteOffset + consumedBytes;
    const chunk = slice.subarray(0, consumedBytes).toString("utf8");
    const parts = chunk.split("\n");

    let changed = nextOffset !== turn.byteOffset;
    let assistantText = turn.assistantText;
    let turnUsage: DirectChatUsage | null = turn.usage ? { ...turn.usage } : null;
    let usageUpdated = false;
    let nextStatus: DirectChatTurnStatus = turn.status;
    let errorText: string | null = turn.errorText;
    let finishedAt: string | null = turn.finishedAt;
    let nextSessionId: string | null = null;
    let ordinalCounter = turn.tools.length;
    const stamp = this.now().toISOString();

    for (const line of parts) {
      if (line.trim() === "") continue;
      const embeddedImages = extractBase64ImagesFromLine(line, thread.provider);
      for (const img of embeddedImages) {
        saveDirectChatArtifact(this.store, {
          stateRoot: this.stateRoot,
          threadId: thread.id,
          turnId: turn.id,
          kind: "output",
          filename: img.filename,
          bytes: img.bytes,
          now: this.now(),
        });
        changed = true;
      }
      const events = parseDirectChatLine(line, thread.provider);
      for (const ev of events) {
        changed = true;
        switch (ev.kind) {
          case "session_id":
            nextSessionId = ev.sessionId;
            break;
          case "message_start":
            if (assistantText !== "") {
              this.resetOnNextTextDelta.add(turn.id);
            }
            break;
          case "text_delta":
            if (this.resetOnNextTextDelta.has(turn.id)) {
              assistantText = "";
              this.resetOnNextTextDelta.delete(turn.id);
            }
            // Run redaction across the full accumulated text so secrets split across deltas are caught.
            assistantText = sanitizeDisplay(assistantText + ev.delta);
            break;
          case "text_replace":
            this.resetOnNextTextDelta.delete(turn.id);
            assistantText = sanitizeDisplay(ev.text);
            break;
          case "usage": {
            const base = turnUsage ?? emptyUsage(defaultContextWindowFor(thread.provider, thread.modelId));
            const patch = ev.usage;
            if (ev.cumulative) {
              if (patch.inputTokens !== undefined) base.inputTokens = patch.inputTokens;
              if (patch.outputTokens !== undefined) base.outputTokens = patch.outputTokens;
              if (patch.cacheReadTokens !== undefined) base.cacheReadTokens = patch.cacheReadTokens;
              if (patch.cacheCreationTokens !== undefined) base.cacheCreationTokens = patch.cacheCreationTokens;
              if (patch.thinkingTokens !== undefined) base.thinkingTokens = patch.thinkingTokens;
              if (patch.contextTokens !== undefined && patch.contextTokens > 0) base.contextTokens = patch.contextTokens;
              if (patch.contextWindow !== undefined && patch.contextWindow !== null) base.contextWindow = patch.contextWindow;
              if (patch.costUsd !== undefined && patch.costUsd !== null) base.costUsd = patch.costUsd;
            } else {
              if (patch.contextTokens !== undefined && patch.contextTokens > 0) base.contextTokens = patch.contextTokens;
              if (patch.inputTokens !== undefined) base.inputTokens += patch.inputTokens;
              if (patch.outputTokens !== undefined) base.outputTokens += patch.outputTokens;
              if (patch.cacheReadTokens !== undefined) base.cacheReadTokens = Math.max(base.cacheReadTokens, patch.cacheReadTokens);
              if (patch.cacheCreationTokens !== undefined) base.cacheCreationTokens += patch.cacheCreationTokens;
              if (patch.contextWindow !== undefined && patch.contextWindow !== null) base.contextWindow = patch.contextWindow;
            }
            if (base.contextWindow === null) {
              base.contextWindow = defaultContextWindowFor(thread.provider, thread.modelId);
            }
            turnUsage = base;
            usageUpdated = true;
            break;
          }
          case "tool": {
            const existing = this.store.handle
              .prepare(`SELECT ordinal FROM direct_chat_tool WHERE turn_id = ? AND id = ?`)
              .get(turn.id, ev.id) as Record<string, unknown> | undefined;
            const ord = typeof existing?.["ordinal"] === "number" ? existing["ordinal"] : ++ordinalCounter;
            this.store.handle.prepare(`
              INSERT INTO direct_chat_tool (id, turn_id, ordinal, name, detail, status, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(turn_id, id) DO UPDATE SET
                name = excluded.name,
                detail = excluded.detail,
                status = excluded.status,
                updated_at = excluded.updated_at
            `).run(ev.id, turn.id, ord, sanitizeLine(ev.name), sanitizeLine(ev.detail), ev.status, stamp);
            break;
          }
          case "tool_status":
            this.store.handle.prepare(`
              UPDATE direct_chat_tool SET status = ?, updated_at = ? WHERE turn_id = ? AND id = ?
            `).run(ev.status, stamp, turn.id, ev.id);
            break;
          case "completed":
            this.sawTerminalByTurn.add(turn.id);
            nextStatus = "completed";
            finishedAt = stamp;
            this.store.handle.prepare(`
              UPDATE direct_chat_tool SET status = 'done', updated_at = ? WHERE turn_id = ? AND status = 'running'
            `).run(stamp, turn.id);
            break;
          case "failed":
            this.sawTerminalByTurn.add(turn.id);
            nextStatus = "failed";
            errorText = sanitizeDisplay(ev.message);
            finishedAt = stamp;
            break;
        }
      }
    }

    if (changed) {
      this.store.handle.prepare(`
        UPDATE direct_chat_turn
        SET byte_offset = ?, assistant_text = ?, status = ?, error_text = ?, finished_at = ?, usage_json = ?
        WHERE id = ?
      `).run(nextOffset, assistantText, nextStatus, errorText, finishedAt, turnUsage ? JSON.stringify(turnUsage) : null, turn.id);
      const threadUsageJson = usageUpdated ? this.recomputeThreadUsageJson(thread) : null;
      if (nextSessionId !== null && threadUsageJson !== null) {
        this.store.handle.prepare(`UPDATE direct_chat_thread SET provider_session_id = ?, usage_json = ?, updated_at = ? WHERE id = ?`)
          .run(nextSessionId, threadUsageJson, stamp, thread.id);
      } else if (nextSessionId !== null) {
        this.store.handle.prepare(`UPDATE direct_chat_thread SET provider_session_id = ?, updated_at = ? WHERE id = ?`)
          .run(nextSessionId, stamp, thread.id);
      } else if (threadUsageJson !== null) {
        this.store.handle.prepare(`UPDATE direct_chat_thread SET usage_json = ?, updated_at = ? WHERE id = ?`)
          .run(threadUsageJson, stamp, thread.id);
      } else {
        this.store.handle.prepare(`UPDATE direct_chat_thread SET updated_at = ? WHERE id = ?`).run(stamp, thread.id);
      }
    }
    return changed;
  }

  private recomputeThreadUsageJson(thread: DirectChatThreadRow): string | null {
    const rows = this.store.handle
      .prepare(`SELECT usage_json FROM direct_chat_turn WHERE thread_id = ? AND usage_json IS NOT NULL ORDER BY seq ASC`)
      .all(thread.id) as Array<{ usage_json: string | null }>;
    if (rows.length === 0) return null;
    const total = emptyUsage(defaultContextWindowFor(thread.provider, thread.modelId));
    let anyCost = false;
    let costSum = 0;
    for (const row of rows) {
      const u = parseUsageJson(row.usage_json);
      if (!u) continue;
      total.inputTokens += u.inputTokens;
      total.outputTokens += u.outputTokens;
      total.cacheReadTokens += u.cacheReadTokens;
      total.cacheCreationTokens += u.cacheCreationTokens;
      total.thinkingTokens += u.thinkingTokens;
      if (u.contextTokens > 0) total.contextTokens = u.contextTokens;
      if (u.contextWindow !== null) total.contextWindow = u.contextWindow;
      if (u.costUsd !== null) {
        anyCost = true;
        costSum += u.costUsd;
      }
    }
    total.costUsd = anyCost ? costSum : null;
    return JSON.stringify(total);
  }

  private readStderrTail(stderrPath: string): string {
    if (!existsSync(stderrPath)) return "";
    try {
      const raw = readFileSync(stderrPath, "utf8");
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      return lines.slice(-3).join("\n");
    } catch {
      return "";
    }
  }

  private cleanupTurnState(turnId: string): void {
    this.closeTurnFence(turnId);
    this.sawTerminalByTurn.delete(turnId);
    this.resetOnNextTextDelta.delete(turnId);
    this.preTurnImages.delete(turnId);
  }

  private reloadTurn(turnId: string): DirectChatTurnRow | null {
    const raw = this.store.handle.prepare(`SELECT * FROM direct_chat_turn WHERE id = ?`).get(turnId) as Record<string, unknown> | undefined;
    return raw ? this.mapTurn(raw) : null;
  }

  private loadTurns(threadId: string): DirectChatTurnRow[] {
    const rows = this.store.handle
      .prepare(`SELECT * FROM direct_chat_turn WHERE thread_id = ? ORDER BY seq ASC`)
      .all(threadId) as Record<string, unknown>[];
    return rows.map(row => this.mapTurn(row));
  }

  private mapTurn(raw: Record<string, unknown>): DirectChatTurnRow {
    const turnId = String(raw["id"]);
    const toolRows = this.store.handle
      .prepare(`SELECT * FROM direct_chat_tool WHERE turn_id = ? ORDER BY ordinal ASC`)
      .all(turnId) as Record<string, unknown>[];
    const artifactRows = this.store.handle
      .prepare(`SELECT * FROM direct_chat_artifact WHERE turn_id = ? ORDER BY created_at ASC`)
      .all(turnId) as Record<string, unknown>[];
    return {
      id: turnId,
      threadId: String(raw["thread_id"]),
      seq: Number(raw["seq"]),
      requestId: typeof raw["request_id"] === "string" ? raw["request_id"] : null,
      userPrompt: String(raw["user_prompt"]),
      switchedFromProvider: isDirectChatProvider(raw["switched_from_provider"]) ? raw["switched_from_provider"] : null,
      logPath: String(raw["log_path"]),
      stderrPath: String(raw["stderr_path"]),
      byteOffset: Number(raw["byte_offset"] ?? 0),
      pid: typeof raw["pid"] === "number" ? raw["pid"] : null,
      startIdentity: typeof raw["start_identity"] === "string" ? raw["start_identity"] : null,
      pgid: typeof raw["pgid"] === "number" ? raw["pgid"] : null,
      bootId: typeof raw["boot_id"] === "string" ? raw["boot_id"] : null,
      status: String(raw["status"]) as DirectChatTurnStatus,
      stopRequestedAt: typeof raw["stop_requested_at"] === "string" ? raw["stop_requested_at"] : null,
      assistantText: String(raw["assistant_text"] ?? ""),
      errorText: typeof raw["error_text"] === "string" ? raw["error_text"] : null,
      createdAt: String(raw["created_at"]),
      finishedAt: typeof raw["finished_at"] === "string" ? raw["finished_at"] : null,
      usage: parseUsageJson(raw["usage_json"]),
      tools: toolRows.map(t => ({
        id: String(t["id"]),
        ordinal: Number(t["ordinal"]),
        name: String(t["name"]),
        detail: String(t["detail"] ?? ""),
        status: String(t["status"]) as DirectChatToolStatus,
        updatedAt: String(t["updated_at"]),
      })),
      artifacts: artifactRows.map(a => ({
        id: String(a["id"]),
        threadId: String(a["thread_id"]),
        turnId: typeof a["turn_id"] === "string" ? a["turn_id"] : null,
        kind: a["kind"] === "attachment" ? "attachment" : "output",
        filename: String(a["filename"]),
        mimeType: String(a["mime_type"]),
        byteSize: Number(a["byte_size"]),
        sha256: String(a["sha256"]),
        storagePath: String(a["storage_path"]),
        sourcePath: typeof a["source_path"] === "string" ? a["source_path"] : null,
        createdAt: String(a["created_at"]),
      })),
    };
  }

  private mapThread(raw: Record<string, unknown>): DirectChatThreadRow {
    const repo = String(raw["repo"]);
    let mainDirtyFiles: string[] = [];
    if (typeof raw["main_dirty_files"] === "string" && raw["main_dirty_files"] !== "") {
      try {
        const parsed = JSON.parse(raw["main_dirty_files"]);
        if (Array.isArray(parsed)) mainDirtyFiles = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        mainDirtyFiles = [];
      }
    }
    let diffCache: DirectChatDiffSummary = { changedFiles: [], diffText: "", dirty: false };
    if (typeof raw["diff_cache_json"] === "string" && raw["diff_cache_json"] !== "") {
      try {
        const parsed = JSON.parse(raw["diff_cache_json"]) as Partial<DirectChatDiffSummary>;
        diffCache = {
          changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.filter((x): x is string => typeof x === "string") : [],
          diffText: typeof parsed.diffText === "string" ? parsed.diffText : "",
          dirty: parsed.dirty === true,
        };
      } catch {
        diffCache = { changedFiles: [], diffText: "", dirty: false };
      }
    }
    return {
      id: String(raw["id"]),
      owner: String(raw["owner"]),
      localGeneration: typeof raw["local_generation"] === "number" ? raw["local_generation"] : null,
      accountGeneration: Number(raw["account_generation"]),
      createRequestId: typeof raw["create_request_id"] === "string" ? raw["create_request_id"] : null,
      title: String(raw["title"]),
      repo,
      project: projectName(repo),
      clonePath: String(raw["clone_path"]),
      gitDir: typeof raw["git_dir"] === "string" && raw["git_dir"] !== "" ? raw["git_dir"] : null,
      configSha256: typeof raw["config_sha256"] === "string" && raw["config_sha256"] !== "" ? raw["config_sha256"] : null,
      branch: String(raw["branch"]),
      baseSha: String(raw["base_sha"]),
      provider: String(raw["provider"]) as DirectChatProvider,
      modelId: String(raw["model_id"]),
      effort: normalizeDirectChatEffort(typeof raw["effort"] === "string" ? raw["effort"] : null, String(raw["provider"]) as DirectChatProvider),
      providerSessionId: typeof raw["provider_session_id"] === "string" ? raw["provider_session_id"] : null,
      mainDirtyFiles,
      diffCache,
      usage: parseUsageJson(raw["usage_json"]),
      isLegacy: Number(raw["is_legacy"] ?? 0) === 1,
      archivedAt: typeof raw["archived_at"] === "string" ? raw["archived_at"] : null,
      createdAt: String(raw["created_at"]),
      updatedAt: String(raw["updated_at"]),
    };
  }
}

/**
 * Imports legacy Mac `chat-threads.json` strictly as archived, read-only history
 * inside a single transaction (`archived_at = updatedAt`, `is_legacy = 1`,
 * `clone_path = ''`, never pointing at the user's real checkout).
 */
export function importLegacyDirectChatJson(input: {
  store: Store;
  owner: string;
  accountGeneration: number;
  jsonPath?: string;
}): number {
  const path = input.jsonPath ?? join(homedir(), ".config", "toolroll", "chat-threads.json");
  if (!existsSync(path)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  return input.store.transact(() => {
    let imported = 0;
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const rawId = typeof item["id"] === "string" ? item["id"].toLowerCase().replace(/-/g, "") : "";
      if (!HEX32.test(rawId)) continue;
      const provider = isDirectChatProvider(item["provider"]) ? item["provider"] : "claude";
      const repo = typeof item["projectPath"] === "string" && item["projectPath"] !== ""
        ? item["projectPath"]
        : (typeof item["project"] === "string" && item["project"] !== "" ? item["project"] : homedir());
      const title = typeof item["title"] === "string" && item["title"] !== "" ? sanitizeLine(item["title"]) : "Imported chat";
      const modelId = typeof item["modelId"] === "string" && item["modelId"] !== ""
        ? item["modelId"]
        : (typeof item["modelID"] === "string" && item["modelID"] !== "" ? item["modelID"] : defaultModelForProvider(provider));
      const createdAt = typeof item["createdAt"] === "string" ? item["createdAt"] : new Date().toISOString();
      const updatedAt = typeof item["updatedAt"] === "string" ? item["updatedAt"] : createdAt;
      const sessionId = typeof item["sessionId"] === "string" && item["sessionId"] !== ""
        ? item["sessionId"]
        : (typeof item["providerSessionID"] === "string" && item["providerSessionID"] !== "" ? item["providerSessionID"] : null);

      const inserted = input.store.handle.prepare(`
        INSERT OR IGNORE INTO direct_chat_thread (
          id, owner, local_generation, account_generation, create_request_id,
          title, repo, clone_path, git_dir, config_sha256, diff_cache_json, is_legacy,
          branch, base_sha, provider, model_id,
          provider_session_id, main_dirty_files, archived_at, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, NULL, ?, ?, '', NULL, NULL, NULL, 1, ?, '', ?, ?, ?, NULL, ?, ?, ?)
      `).run(rawId, input.owner, input.accountGeneration, title, repo, `imported/${rawId.slice(0, 8)}`, provider, modelId, sessionId, updatedAt, createdAt, updatedAt);

      if (Number(inserted.changes) === 0) continue;
      imported += 1;

      const messages = Array.isArray(item["messages"]) ? item["messages"] : [];
      let seq = 0;
      let pendingUserPrompt: string | null = null;
      for (const rawMsg of messages) {
        if (!rawMsg || typeof rawMsg !== "object") continue;
        const msg = rawMsg as Record<string, unknown>;
        const role = typeof msg["role"] === "string" ? msg["role"] : "";
        const text = typeof msg["text"] === "string" ? msg["text"] : "";
        if (role === "user") {
          pendingUserPrompt = text;
        } else if (role === "assistant" && pendingUserPrompt !== null) {
          seq += 1;
          const turnId = randomBytes(16).toString("hex");
          const isError = msg["isError"] === true;
          const ts = typeof msg["timestamp"] === "string" ? msg["timestamp"] : updatedAt;
          input.store.handle.prepare(`
            INSERT OR IGNORE INTO direct_chat_turn (
              id, thread_id, seq, request_id, user_prompt, switched_from_provider,
              log_path, stderr_path, byte_offset, pid, start_identity, pgid, boot_id,
              status, stop_requested_at, assistant_text, error_text, created_at, finished_at
            ) VALUES (?, ?, ?, NULL, ?, NULL, '', '', 0, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?)
          `).run(turnId, rawId, seq, pendingUserPrompt, isError ? "failed" : "completed", isError ? "" : sanitizeDisplay(text), isError ? sanitizeDisplay(text) : null, ts, ts);
          const tools = Array.isArray(msg["tools"]) ? msg["tools"] : [];
          let ord = 0;
          for (const rawTool of tools) {
            if (!rawTool || typeof rawTool !== "object") continue;
            const t = rawTool as Record<string, unknown>;
            ord += 1;
            const tid = typeof t["id"] === "string" && t["id"] !== "" ? t["id"] : `imp-${ord}`;
            const tname = typeof t["name"] === "string" ? t["name"] : "Tool";
            const tdetail = typeof t["detail"] === "string" ? t["detail"] : "";
            const tstatus: DirectChatToolStatus = t["status"] === "error" ? "error" : "done";
            input.store.handle.prepare(`
              INSERT OR IGNORE INTO direct_chat_tool (id, turn_id, ordinal, name, detail, status, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(tid, turnId, ord, sanitizeLine(tname), sanitizeLine(tdetail), tstatus, ts);
          }
          pendingUserPrompt = null;
        }
      }
    }
    return imported;
  });
}

export function writeDirectChatLogFixture(logPath: string, lines: readonly string[]): void {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  writeFileSync(logPath, `${lines.join("\n")}\n`, { mode: 0o600 });
}
