import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HARDENED_GIT_ARGS } from "./agent-fence.js";
import { currentBootId, provenDeadByBootChange } from "./boot-identity.js";
import { type CustodyIO, type ProcessWitness } from "./flexible-custody.js";
import { defaultCustodyIO } from "./flexible-launch.js";
import { cleanLiveText, HIDDEN_LINE, liveSecretHit } from "./live-records.js";
import { projectName } from "./project.js";
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
  assistantText: string;
  errorText: string | null;
  createdAt: string;
  finishedAt: string | null;
  tools: DirectChatToolRow[];
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
  branch: string;
  baseSha: string;
  provider: DirectChatProvider;
  modelId: string;
  providerSessionId: string | null;
  mainDirtyFiles: string[];
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
  | { kind: "text_delta"; delta: string }
  | { kind: "text_replace"; text: string }
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
const MAX_LINE_BYTES = 1_048_576;
const MAX_DIFF_BYTES = 40_000;
const HANDOFF_MAX_TURNS = 6;
const HANDOFF_MAX_CHARS = 6_000;
const STRIPPED_ENV_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "VERCEL_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "NETLIFY_AUTH_TOKEN",
  "FLY_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SSH_AUTH_SOCK",
]);

function sanitizeDisplay(raw: string): string {
  const cleaned = cleanLiveText(raw);
  return cleaned
    .split("\n")
    .map(line => (liveSecretHit(line) ? HIDDEN_LINE : line))
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

function parseClaudeJson(json: Record<string, unknown>): DirectChatStreamEvent[] {
  const events: DirectChatStreamEvent[] = [];
  if (typeof json["session_id"] === "string" && json["session_id"] !== "") {
    events.push({ kind: "session_id", sessionId: json["session_id"] });
  }
  const type = typeof json["type"] === "string" ? json["type"] : "";
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
  prompt: string;
  sessionId: string | null;
}): string[] {
  const { provider, modelId, prompt, sessionId } = input;
  switch (provider) {
    case "claude": {
      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "auto"];
      if (modelId !== "") args.push("--model", modelId);
      if (sessionId !== null && sessionId !== "") args.push("--resume", sessionId);
      return args;
    }
    case "codex": {
      if (sessionId !== null && sessionId !== "") {
        const args = ["exec", "resume", "--json", "--skip-git-repo-check"];
        if (modelId !== "") args.push("-m", modelId);
        args.push(sessionId, prompt);
        return args;
      }
      const args = ["exec", "--json", "--approve-for-me", "--skip-git-repo-check"];
      if (modelId !== "") args.push("-m", modelId);
      args.push(prompt);
      return args;
    }
    case "gemini": {
      const args = ["-p", prompt, "--output-format", "stream-json", "--mode", "auto", "--sandbox"];
      if (modelId !== "") args.push("--model", modelId);
      if (sessionId !== null && sessionId !== "") args.push("--conversation", sessionId);
      return args;
    }
  }
}

export function locateDirectChatBinary(provider: DirectChatProvider, homeDir = homedir()): string | null {
  const candidates: Record<DirectChatProvider, string[]> = {
    claude: [`${homeDir}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
    codex: [`${homeDir}/.local/bin/codex`, "/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
    gemini: [`${homeDir}/.local/bin/agy`, `${homeDir}/.gemini/bin/agy`, "/opt/homebrew/bin/agy", "/usr/local/bin/agy"],
  };
  for (const candidate of candidates[provider]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function buildSanitizedChildEnv(baseEnv: NodeJS.ProcessEnv = process.env, homeDir = homedir()): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV_KEYS.has(key)) continue;
    out[key] = value;
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
      `[Workspace boundary: you are working in an isolated local clone on branch ${input.branch} with no remote. Work only inside this directory; never push, force-reset, or delete files outside this workspace.]`
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

function hardenedGit(args: readonly string[], cwd?: string): string {
  return execFileSync(
    "git",
    [...HARDENED_GIT_ARGS, "-c", "protocol.ext.allow=never", "-c", "credential.helper=", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: homedir(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

export type DirectChatHostSeams = {
  stateRoot: string;
  now?: () => Date;
  custody?: CustodyIO;
  bootId?: () => string | null;
  locateBinary?: (provider: DirectChatProvider) => string | null;
  spawnTurn?: (input: {
    binary: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
    stderrPath: string;
  }) => { pid: number; pgid: number; startIdentity: string | null };
  prepareClone?: (input: { repo: string; clonePath: string; branch: string }) => { baseSha: string; mainDirtyFiles: string[] };
  readDiff?: (input: { clonePath: string; baseSha: string }) => DirectChatDiffSummary;
  onNotify?: (note: DirectChatNotification) => void;
};

function defaultPrepareClone(input: { repo: string; clonePath: string; branch: string }): { baseSha: string; mainDirtyFiles: string[] } {
  mkdirSync(dirname(input.clonePath), { recursive: true, mode: 0o700 });
  const baseSha = hardenedGit(["rev-parse", "HEAD"], input.repo).trim();
  let mainDirtyFiles: string[] = [];
  try {
    const status = hardenedGit(["status", "--porcelain"], input.repo);
    mainDirtyFiles = status
      .split("\n")
      .map(line => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 20)
      .map(sanitizeLine);
  } catch {
    mainDirtyFiles = [];
  }
  hardenedGit(["-c", "protocol.file.allow=always", "clone", "--local", "--", input.repo, input.clonePath]);
  try {
    hardenedGit(["remote", "remove", "origin"], input.clonePath);
  } catch {
    // clone may have no origin
  }
  hardenedGit(["checkout", "-b", input.branch, baseSha], input.clonePath);
  return { baseSha, mainDirtyFiles };
}

function defaultReadDiff(input: { clonePath: string; baseSha: string }): DirectChatDiffSummary {
  if (!existsSync(input.clonePath)) return { changedFiles: [], diffText: "", dirty: false };
  try {
    const statusLines = hardenedGit(["status", "--porcelain"], input.clonePath)
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    const committedFiles = hardenedGit(["diff", "--name-only", input.baseSha], input.clonePath)
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
      diffText = hardenedGit(["diff", "--no-color", input.baseSha], input.clonePath);
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
  input: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logPath: string; stderrPath: string }
): { pid: number; pgid: number; startIdentity: string | null } {
  mkdirSync(dirname(input.logPath), { recursive: true, mode: 0o700 });
  const outFd = openSync(input.logPath, "a", 0o600);
  const errFd = openSync(input.stderrPath, "a", 0o600);
  try {
    const opts: SpawnOptions = {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", outFd, errFd],
    };
    const child = spawn(input.binary, input.args, opts);
    if (child.pid === undefined) {
      throw new Error(`Could not start ${basename(input.binary)}.`);
    }
    child.unref();
    const pid = child.pid;
    const row = custody.table()?.find(one => one.pid === pid) ?? null;
    return { pid, pgid: row?.pgid ?? pid, startIdentity: row?.start ?? null };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

export class DirectChatHost {
  private readonly store: Store;
  private readonly stateRoot: string;
  private readonly now: () => Date;
  private readonly custody: CustodyIO;
  private readonly bootId: () => string | null;
  private readonly locateBinary: (provider: DirectChatProvider) => string | null;
  private readonly spawnTurnFn: NonNullable<DirectChatHostSeams["spawnTurn"]>;
  private readonly prepareCloneFn: NonNullable<DirectChatHostSeams["prepareClone"]>;
  private readonly readDiffFn: NonNullable<DirectChatHostSeams["readDiff"]>;
  private readonly onNotify: (note: DirectChatNotification) => void;
  private readonly partialLineByTurn = new Map<string, string>();
  private readonly sawTerminalByTurn = new Set<string>();
  private readonly pendingSwitchFrom = new Map<string, DirectChatProvider>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, seams: DirectChatHostSeams) {
    this.store = store;
    this.stateRoot = seams.stateRoot;
    this.now = seams.now ?? (() => new Date());
    this.custody = seams.custody ?? defaultCustodyIO();
    this.bootId = seams.bootId ?? (() => currentBootId());
    this.locateBinary = seams.locateBinary ?? (provider => locateDirectChatBinary(provider));
    this.spawnTurnFn = seams.spawnTurn ?? (input => defaultSpawnTurn(this.custody, input));
    this.prepareCloneFn = seams.prepareClone ?? defaultPrepareClone;
    this.readDiffFn = seams.readDiff ?? defaultReadDiff;
    this.onNotify = seams.onNotify ?? (() => {});
  }

  startPolling(intervalMs = 250): void {
    if (this.pollTimer !== null) return;
    this.reconcileRunningTurns();
    this.pollTimer = setInterval(() => {
      this.reconcileRunningTurns();
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  close(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
      const diff = this.readDiffFn({ clonePath: thread.clonePath, baseSha: thread.baseSha });
      out.push({
        ...thread,
        running: lastStatus === "running",
        lastStatus,
        changedFilesCount: diff.changedFiles.length,
      });
    }
    return out;
  }

  getThread(owner: string, threadId: string): { thread: DirectChatThreadRow; turns: DirectChatTurnRow[]; diff: DirectChatDiffSummary; running: boolean } | null {
    if (!HEX32.test(threadId)) return null;
    const raw = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(threadId, owner) as Record<string, unknown> | undefined;
    if (!raw) return null;
    const thread = this.mapThread(raw);
    const turns = this.loadTurns(thread.id);
    const diff = this.readDiffFn({ clonePath: thread.clonePath, baseSha: thread.baseSha });
    const running = turns.some(t => t.status === "running");
    return { thread, turns, diff, running };
  }

  createThread(input: {
    owner: string;
    localGeneration: number | null;
    accountGeneration: number;
    requestId: string;
    repo: string;
    provider: DirectChatProvider;
    modelId?: string;
    prompt: string;
  }): { ok: true; thread: DirectChatThreadRow; turn: DirectChatTurnRow; created: boolean } | { ok: false; status: number; error: string } {
    const trimmedPrompt = input.prompt.trim();
    if (trimmedPrompt === "") return { ok: false, status: 400, error: "Write a message to start a chat." };
    if (!HEX32.test(input.requestId)) return { ok: false, status: 400, error: "Invalid request id." };

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
    const branch = `toolroll/chat-${shortId}`;

    let baseSha: string;
    let mainDirtyFiles: string[];
    try {
      const prep = this.prepareCloneFn({ repo: input.repo, clonePath, branch });
      baseSha = prep.baseSha;
      mainDirtyFiles = prep.mainDirtyFiles;
    } catch (error) {
      return { ok: false, status: 500, error: `Could not prepare isolated clone: ${error instanceof Error ? error.message : String(error)}` };
    }

    const firstLine = trimmedPrompt.split(/\r?\n/)[0]?.trim() ?? trimmedPrompt;
    const title = sanitizeLine(firstLine.slice(0, 72)) || "New chat";
    const modelId = (input.modelId && input.modelId.trim() !== "") ? input.modelId.trim() : defaultModelForProvider(input.provider);
    const stamp = this.now().toISOString();

    this.store.handle.prepare(`
      INSERT INTO direct_chat_thread (
        id, owner, local_generation, account_generation, create_request_id,
        title, repo, clone_path, branch, base_sha, provider, model_id,
        provider_session_id, main_dirty_files, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    `).run(
      threadId,
      input.owner,
      input.localGeneration,
      input.accountGeneration,
      input.requestId,
      title,
      input.repo,
      clonePath,
      branch,
      baseSha,
      input.provider,
      modelId,
      mainDirtyFiles.length > 0 ? JSON.stringify(mainDirtyFiles) : null,
      stamp,
      stamp
    );

    const started = this.sendMessage({
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

  sendMessage(input: {
    owner: string;
    threadId: string;
    requestId: string;
    prompt: string;
  }): { ok: true; turn: DirectChatTurnRow; created: boolean } | { ok: false; status: number; error: string } {
    if (!HEX32.test(input.threadId) || !HEX32.test(input.requestId)) {
      return { ok: false, status: 400, error: "Invalid thread or request id." };
    }
    const trimmed = input.prompt.trim();
    if (trimmed === "") return { ok: false, status: 400, error: "Write a message first." };

    const rawThread = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(input.threadId, input.owner) as Record<string, unknown> | undefined;
    if (!rawThread) return { ok: false, status: 404, error: "Chat thread not found." };
    const thread = this.mapThread(rawThread);

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
      return { ok: false, status: 409, error: "A turn is already running in this chat." };
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
      prompt: effectivePrompt,
      sessionId: thread.providerSessionId,
    });
    const stamp = this.now().toISOString();

    let launched: { pid: number; pgid: number; startIdentity: string | null };
    try {
      launched = this.spawnTurnFn({
        binary,
        args,
        cwd: thread.clonePath,
        env: buildSanitizedChildEnv(),
        logPath,
        stderrPath,
      });
    } catch (error) {
      return { ok: false, status: 500, error: `Could not launch ${thread.provider}: ${error instanceof Error ? error.message : String(error)}` };
    }

    const switchedFrom = this.pendingSwitchFrom.get(thread.id) ?? null;
    this.pendingSwitchFrom.delete(thread.id);

    this.store.handle.prepare(`
      INSERT INTO direct_chat_turn (
        id, thread_id, seq, request_id, user_prompt, switched_from_provider,
        log_path, stderr_path, byte_offset, pid, start_identity, pgid, boot_id,
        status, assistant_text, error_text, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'running', '', NULL, ?, NULL)
    `).run(
      turnId,
      thread.id,
      nextSeq,
      input.requestId,
      trimmed,
      switchedFrom,
      logPath,
      stderrPath,
      launched.pid,
      launched.startIdentity,
      launched.pgid,
      this.bootId(),
      stamp
    );
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
    const stamp = this.now().toISOString();
    this.store.handle.prepare(`
      UPDATE direct_chat_thread
      SET provider = ?, model_id = ?, provider_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(input.provider, nextModel, providerChanged ? null : thread.providerSessionId, stamp, thread.id);
    this.onNotify({ threadId: thread.id, turnId: null, event: "change" });
    const updated = this.store.handle.prepare(`SELECT * FROM direct_chat_thread WHERE id = ?`).get(thread.id) as Record<string, unknown>;
    return { ok: true, thread: this.mapThread(updated) };
  }

  stopThread(owner: string, threadId: string): { ok: true; stopped: boolean } | { ok: false; status: number; error: string } {
    if (!HEX32.test(threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const raw = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(threadId, owner) as Record<string, unknown> | undefined;
    if (!raw) return { ok: false, status: 404, error: "Chat thread not found." };

    const running = this.store.handle
      .prepare(`SELECT * FROM direct_chat_turn WHERE thread_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1`)
      .get(threadId) as Record<string, unknown> | undefined;
    if (!running) return { ok: true, stopped: false };

    const turn = this.mapTurn(running);
    this.signalTurnProcess(turn, "SIGTERM");
    this.reconcileSingleTurn(this.mapThread(raw), turn, { forceStopped: true });
    return { ok: true, stopped: true };
  }

  deleteThread(input: {
    owner: string;
    threadId: string;
    discardChanges?: boolean;
    keepClone?: boolean;
  }): { ok: true; removedClone: boolean } | { ok: false; status: number; error: string; code?: string } {
    if (!HEX32.test(input.threadId)) return { ok: false, status: 400, error: "Invalid thread id." };
    const raw = this.store.handle
      .prepare(`SELECT * FROM direct_chat_thread WHERE id = ? AND owner = ? AND archived_at IS NULL`)
      .get(input.threadId, input.owner) as Record<string, unknown> | undefined;
    if (!raw) return { ok: false, status: 404, error: "Chat thread not found." };
    const thread = this.mapThread(raw);

    const diff = this.readDiffFn({ clonePath: thread.clonePath, baseSha: thread.baseSha });
    if (diff.dirty && !input.discardChanges && !input.keepClone) {
      return {
        ok: false,
        status: 409,
        code: "unmerged_changes",
        error: "This chat has unmerged changes. Confirm discarding changes or choose to keep the branch.",
      };
    }

    this.stopThread(input.owner, thread.id);
    const stamp = this.now().toISOString();
    this.store.handle.prepare(`UPDATE direct_chat_thread SET archived_at = ?, updated_at = ? WHERE id = ?`).run(stamp, stamp, thread.id);

    let removedClone = false;
    if (!input.keepClone && (!diff.dirty || input.discardChanges === true) && existsSync(thread.clonePath)) {
      const clonesRoot = resolve(join(this.stateRoot, "direct-chat", "clones"));
      const resolvedClone = resolve(thread.clonePath);
      if (resolvedClone.startsWith(`${clonesRoot}/`)) {
        rmSync(resolvedClone, { recursive: true, force: true });
        removedClone = true;
      }
    }
    this.onNotify({ threadId: thread.id, turnId: null, event: "change" });
    return { ok: true, removedClone };
  }

  reconcileRunningTurns(): void {
    const runningRows = this.store.handle
      .prepare(`SELECT t.* FROM direct_chat_turn t JOIN direct_chat_thread th ON th.id = t.thread_id WHERE t.status = 'running' AND th.archived_at IS NULL`)
      .all() as Record<string, unknown>[];
    for (const rawTurn of runningRows) {
      const turn = this.mapTurn(rawTurn);
      const rawThread = this.store.handle
        .prepare(`SELECT * FROM direct_chat_thread WHERE id = ?`)
        .get(turn.threadId) as Record<string, unknown> | undefined;
      if (!rawThread) continue;
      this.reconcileSingleTurn(this.mapThread(rawThread), turn);
    }
  }

  private reconcileSingleTurn(thread: DirectChatThreadRow, turn: DirectChatTurnRow, opts?: { forceStopped?: boolean }): void {
    const advanced = this.drainTurnLog(thread, turn);
    const alive = !opts?.forceStopped && this.isTurnProcessAlive(turn);
    if (alive) {
      if (advanced) {
        this.onNotify({ threadId: thread.id, turnId: turn.id, event: "turn" });
      }
      return;
    }

    // Drain once more after exit so the tail is never missed.
    this.drainTurnLog(thread, this.reloadTurn(turn.id) ?? turn, true);
    const latest = this.reloadTurn(turn.id) ?? turn;
    if (latest.status !== "running") {
      this.cleanupTurnState(turn.id);
      this.onNotify({ threadId: thread.id, turnId: turn.id, event: "change" });
      return;
    }

    const stamp = this.now().toISOString();
    let finalStatus: DirectChatTurnStatus = opts?.forceStopped ? "stopped" : "completed";
    let errorText: string | null = latest.errorText;

    if (!opts?.forceStopped && !this.sawTerminalByTurn.has(turn.id)) {
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
    if (fileSize <= turn.byteOffset && !flushPartial) return false;

    let chunk = "";
    let nextOffset = turn.byteOffset;
    if (fileSize > turn.byteOffset) {
      const length = Math.min(fileSize - turn.byteOffset, 4 * 1024 * 1024);
      const buf = Buffer.allocUnsafe(length);
      const fd = openSync(turn.logPath, "r");
      try {
        const bytesRead = readSync(fd, buf, 0, length, turn.byteOffset);
        nextOffset = turn.byteOffset + bytesRead;
        chunk = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        closeSync(fd);
      }
    }

    const combined = (this.partialLineByTurn.get(turn.id) ?? "") + chunk;
    const parts = combined.split("\n");
    const trailing = flushPartial ? "" : (parts.pop() ?? "");
    if (trailing !== "") {
      this.partialLineByTurn.set(turn.id, trailing);
    } else {
      this.partialLineByTurn.delete(turn.id);
    }

    let changed = nextOffset !== turn.byteOffset;
    let assistantText = turn.assistantText;
    let nextStatus: DirectChatTurnStatus = turn.status;
    let errorText: string | null = turn.errorText;
    let finishedAt: string | null = turn.finishedAt;
    let nextSessionId: string | null = null;
    let ordinalCounter = turn.tools.length;
    const stamp = this.now().toISOString();

    for (const line of parts) {
      if (line.trim() === "") continue;
      const events = parseDirectChatLine(line, thread.provider);
      for (const ev of events) {
        changed = true;
        switch (ev.kind) {
          case "session_id":
            nextSessionId = ev.sessionId;
            break;
          case "text_delta":
            assistantText += sanitizeDisplay(ev.delta);
            break;
          case "text_replace":
            assistantText = sanitizeDisplay(ev.text);
            break;
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
        SET byte_offset = ?, assistant_text = ?, status = ?, error_text = ?, finished_at = ?
        WHERE id = ?
      `).run(nextOffset, assistantText, nextStatus, errorText, finishedAt, turn.id);
      if (nextSessionId !== null) {
        this.store.handle.prepare(`UPDATE direct_chat_thread SET provider_session_id = ?, updated_at = ? WHERE id = ?`)
          .run(nextSessionId, stamp, thread.id);
      } else {
        this.store.handle.prepare(`UPDATE direct_chat_thread SET updated_at = ? WHERE id = ?`).run(stamp, thread.id);
      }
    }
    return changed;
  }

  private isTurnProcessAlive(turn: DirectChatTurnRow): boolean {
    if (turn.pid === null) return false;
    const curBoot = this.bootId();
    if (turn.bootId !== null && provenDeadByBootChange({ host: hostname(), bootId: turn.bootId }, { host: hostname(), bootId: curBoot })) return false;
    const table = this.custody.table();
    if (table === null) return false;
    const row = table.find(one => one.pid === turn.pid);
    if (!row || row.zombie) return false;
    if (turn.startIdentity !== null && row.start !== null && row.start !== turn.startIdentity) return false;
    return true;
  }

  private signalTurnProcess(turn: DirectChatTurnRow, signal: NodeJS.Signals): void {
    if (turn.pid === null) return;
    if (turn.startIdentity !== null) {
      const witnesses: ProcessWitness[] = [{ pid: turn.pid, start: turn.startIdentity }];
      const table = this.custody.table() ?? [];
      if (turn.pgid !== null) {
        for (const row of table) {
          if (row.pgid === turn.pgid && row.pid !== turn.pid && row.start !== null) {
            witnesses.push({ pid: row.pid, start: row.start });
          }
        }
      }
      this.custody.signal(witnesses, signal);
    } else {
      try {
        process.kill(-turn.pid, signal);
      } catch {
        try { process.kill(turn.pid, signal); } catch { /* already gone */ }
      }
    }
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
    this.partialLineByTurn.delete(turnId);
    this.sawTerminalByTurn.delete(turnId);
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
      assistantText: String(raw["assistant_text"] ?? ""),
      errorText: typeof raw["error_text"] === "string" ? raw["error_text"] : null,
      createdAt: String(raw["created_at"]),
      finishedAt: typeof raw["finished_at"] === "string" ? raw["finished_at"] : null,
      tools: toolRows.map(t => ({
        id: String(t["id"]),
        ordinal: Number(t["ordinal"]),
        name: String(t["name"]),
        detail: String(t["detail"] ?? ""),
        status: String(t["status"]) as DirectChatToolStatus,
        updatedAt: String(t["updated_at"]),
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
      branch: String(raw["branch"]),
      baseSha: String(raw["base_sha"]),
      provider: String(raw["provider"]) as DirectChatProvider,
      modelId: String(raw["model_id"]),
      providerSessionId: typeof raw["provider_session_id"] === "string" ? raw["provider_session_id"] : null,
      mainDirtyFiles,
      archivedAt: typeof raw["archived_at"] === "string" ? raw["archived_at"] : null,
      createdAt: String(raw["created_at"]),
      updatedAt: String(raw["updated_at"]),
    };
  }
}

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
        title, repo, clone_path, branch, base_sha, provider, model_id,
        provider_session_id, main_dirty_files, archived_at, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, '', ?, ?, ?, NULL, NULL, ?, ?)
    `).run(rawId, input.owner, input.accountGeneration, title, repo, repo, `imported/${rawId.slice(0, 8)}`, provider, modelId, sessionId, createdAt, updatedAt);

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
            status, assistant_text, error_text, created_at, finished_at
          ) VALUES (?, ?, ?, NULL, ?, NULL, '', '', 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
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
}

export function writeDirectChatLogFixture(logPath: string, lines: readonly string[]): void {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  writeFileSync(logPath, `${lines.join("\n")}\n`, { mode: 0o600 });
}
