/**
 * The Agent Client Protocol, from the plane's side (docs/plans/acp-adapter.md).
 *
 * ACP is JSON-RPC 2.0, one message per line, over the agent's stdio. This
 * module is the whole conversation as a pure state machine: it is handed the
 * agent's lines one at a time and answers with the lines to send back. It
 * never spawns, reads a clock or touches a file — the runner (exec.ts) owns
 * the process, the timers and the shutdown.
 *
 * One conversation is one build: `initialize`, `session/new` in the
 * worktree, the sealed model selected and seen to be current, one
 * `session/prompt` carrying the brief, then `session/update`s until the
 * response to that prompt. Success is that response with
 * `stopReason: "end_turn"` and nothing else — no update, exit code or
 * message text can stand in for it.
 *
 * The plane offers no client capabilities (no file system, no terminal), so
 * every agent request except `session/request_permission` is answered
 * "method not found". A model is chosen only through a `model` config option,
 * whose answer shows the model current: `session/set_model` answers with
 * nothing to observe, so an agent that offers only that is refused until a
 * fixture proves how it confirms. Builds are full access inside the OS fence, so a
 * permission request is granted once (`allow_once`, never `allow_always`);
 * the fence, not this answer, is the boundary — OpenCode runs commands
 * without asking at all.
 *
 * What the runner keeps is not the agent's stream but a short synthetic
 * record (`retained()`), one JSON object per line, typed `acp.*` — a type
 * no agent can emit — which `acpParse` reads into the gateway's envelope.
 */

/** How many offered models a conversation keeps (each id ≤ 200 characters). */
export const ACP_OFFERED_CAP = 2000;

/** The largest line (UTF-8 bytes) the plane reads from an agent; a longer one is a protocol failure. */
export const ACP_LINE_CAP = 1024 * 1024;
const MESSAGE_CAP = 64 * 1024;
const TEXT_CAP = 2048;
const USAGE_CAP = 8 * 1024;
const PROTOCOL_VERSION = 1;

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
const STOP_REASONS = new Set<string>(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);

/** How the agent lets a client choose its model: a `model` config option, or `session/set_model`. */
export type AcpModelMechanism = "config-option" | "set-model";

export type AcpFailureKind =
  /** The agent broke the protocol: malformed or oversized line, unknown or repeated response, a stranger's session. */
  | "protocol"
  /** The agent is not the one attested (name or version). */
  | "identity"
  /** The sealed model is not offered, or the agent did not make it current. */
  | "model-unavailable"
  /** The agent wants a sign-in. */
  | "auth-required";

export type AcpFailure = { kind: AcpFailureKind; text: string };

/** The response to our prompt: a stop reason, or a JSON-RPC error. */
export type AcpTerminal =
  | { stopReason: AcpStopReason }
  | { error: { code: number | null; message: string } };

export type AcpPhase = "initialize" | "session" | "model" | "prompt" | "ended" | "failed";

export type AcpConversationOptions = {
  /** The working directory the session is opened in (the worktree). */
  cwd: string;
  /** The brief, sent as one text block. */
  prompt: string;
  /** The sealed model: must be offered and become current. */
  model: string;
  /** The agent the attestation names; null only for the conformance probe's first look. */
  expect: { name: string; version: string } | null;
  /** MCP servers offered to the session (http entries only). */
  mcpServers?: readonly { type: "http"; name: string; url: string; headers: readonly { name: string; value: string }[] }[];
};

/** What one received line asks of the runner. */
export type AcpReaction = {
  /** Lines to write to the agent's stdin, in order. */
  send: string[];
  /** Session updates for the live view (`{acp: update}` is how the recorder recognizes them). */
  live: Record<string, unknown>[];
};

export type AcpConversation = {
  /** The first line to send (`initialize`). */
  start(): string[];
  /** Hand over one line the agent wrote. */
  receive(line: string): AcpReaction;
  /** Ask the agent to stop the prompt in flight (a notification; the prompt still answers, with `cancelled`). */
  cancel(): string[];
  /** The transport saw something the conversation can't read (an oversized line): a protocol failure. */
  refuse(text: string): void;
  /** The `session/close` request to send after the terminal, when the agent offers it; else nothing. */
  close(): string[];
  /** Whether a line sent by close() has been answered (or failed). */
  closeAnswered(): boolean;
  phase(): AcpPhase;
  failure(): AcpFailure | null;
  terminal(): AcpTerminal | null;
  sessionId(): string | null;
  agent(): { name: string; version: string } | null;
  mechanism(): AcpModelMechanism | null;
  /** The models the agent offered, as it listed them. */
  offered(): string[];
  /** The synthetic record `acpParse` reads. */
  retained(): string;
};

type Pending = "initialize" | "session/new" | "model" | "prompt" | "close";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

function line(message: Record<string, unknown>): string {
  return JSON.stringify(message);
}

/** The model a `session/new` (or `set_config_option`) result offers, by mechanism. */
function modelOffer(result: Record<string, unknown>): { mechanism: AcpModelMechanism; offered: string[]; current: string | null } | null {
  const options = result["configOptions"];
  if (Array.isArray(options)) {
    const model = options.find(one => isRecord(one) && one["id"] === "model" && one["type"] === "select");
    if (isRecord(model) && Array.isArray(model["options"])) {
      // Choices, or groups of choices — read as the same variant validation accepted: all choices, or all groups.
      const options = model["options"];
      const choices = options.every(configChoice) ? options : options.every(configGroup) ? options.flatMap(one => (one as Record<string, unknown>)["options"] as unknown[]) : [];
      const offered = choices.flatMap(one => isRecord(one) && typeof one["value"] === "string" ? [one["value"]] : []);
      return { mechanism: "config-option", offered, current: typeof model["currentValue"] === "string" ? model["currentValue"] : null };
    }
  }
  const models = result["models"];
  if (isRecord(models) && Array.isArray(models["availableModels"])) {
    const offered = models["availableModels"].flatMap(one => isRecord(one) && typeof one["modelId"] === "string" ? [one["modelId"]] : []);
    return { mechanism: "set-model", offered, current: typeof models["currentModelId"] === "string" ? models["currentModelId"] : null };
  }
  return null;
}

const OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

/**
 * The answer to a permission request: the `allow_once` option, else the `reject_once` one. The whole list must be
 * well formed — every option an object with a non-empty id and a known kind, no id twice — or nothing is chosen: an
 * id shared by "once" and "always" would make the answer mean either.
 */
export function permissionAnswer(params: unknown): { optionId: string; granted: boolean } | null {
  if (!isRecord(params) || !meta(params) || !Array.isArray(params["options"]) || params["options"].length === 0 || params["options"].length > 16) return null;
  const options: { optionId: string; kind: string }[] = [];
  const ids = new Set<string>();
  for (const one of params["options"]) {
    if (!isRecord(one) || typeof one["optionId"] !== "string" || one["optionId"] === "" || one["optionId"].length > 256) return null;
    if (typeof one["kind"] !== "string" || !OPTION_KINDS.has(one["kind"])) return null;
    if (typeof one["name"] !== "string" || !meta(one)) return null;
    if (ids.has(one["optionId"])) return null;
    ids.add(one["optionId"]);
    options.push({ optionId: one["optionId"], kind: one["kind"] });
  }
  const allow = options.find(one => one.kind === "allow_once");
  if (allow !== undefined) return { optionId: allow.optionId, granted: true };
  const reject = options.find(one => one.kind === "reject_once");
  if (reject !== undefined) return { optionId: reject.optionId, granted: false };
  return null;
}

const str = (value: unknown): value is string => typeof value === "string";
const TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const PLAN_PRIORITIES = new Set(["high", "medium", "low"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** An optional field: absent, null, or of its type. */
const optional = (value: unknown, is: (one: unknown) => boolean): boolean => value === undefined || value === null || is(value);
/** Each parsed wire object's number tokens, by key, exactly as written (acp-client's JSON.parse reviver records them). */
const NUMBER_SOURCES = new WeakMap<object, Map<string, string>>();

/** The integer a JSON number token writes exactly (1e3, 1000.0, 0e-999 and 1.000…0 do), or null when it writes none. */
function exactInteger(source: string): bigint | null {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (parts === null) return null;
  let digits = `${parts[2]}${parts[3] ?? ""}`.replace(/^0+/, "");
  if (digits === "") return 0n; // zero, at any exponent
  const trailing = digits.length - digits.replace(/0+$/, "").length;
  digits = digits.slice(0, digits.length - trailing);
  const exponent = Number(parts[4] ?? "0") - (parts[3]?.length ?? 0) + trailing;
  if (!Number.isSafeInteger(exponent) || exponent < 0) return null; // a fraction, or no number at all
  if (digits.length + exponent > 400) return null; // far past any field's range
  const exact = BigInt(digits) * 10n ** BigInt(exponent);
  return parts[1] === "-" ? -exact : exact;
}

/** `holder[key]` as an integer in [min, max]: on the wire, exactly the integer its token writes; built in memory, a safe one. */
function wireInteger(holder: Record<string, unknown>, key: string, min: bigint, max: bigint): boolean {
  const value = holder[key];
  if (typeof value !== "number") return false;
  // Every number the client reads came off the wire with its token: one without is refused, never taken as it reads.
  const source = NUMBER_SOURCES.get(holder)?.get(key);
  const exact = source === undefined ? null : exactInteger(source);
  return exact !== null && exact >= min && exact <= max;
}

/** A deep copy of a wire value in which every integer JavaScript would round (past 2^53) is its exact decimal string,
 * so what is shown and kept is what the agent said. */
function exactCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(exactCopy);
  if (!isRecord(value)) return value;
  const sources = NUMBER_SOURCES.get(value);
  const copy: Record<string, unknown> = {};
  for (const [key, one] of Object.entries(value)) {
    if (typeof one === "number" && !Number.isSafeInteger(one)) {
      const source = sources?.get(key);
      const exact = source === undefined ? null : exactInteger(source);
      copy[key] = exact === null ? one : exact.toString();
    } else copy[key] = exactCopy(one);
  }
  return copy;
}
const optionalInteger = (holder: Record<string, unknown>, key: string, min: bigint, max: bigint): boolean =>
  holder[key] === undefined || holder[key] === null || wireInteger(holder, key, min, max);
const INT64 = [-(2n ** 63n), 2n ** 63n - 1n] as const;
const UINT64 = [0n, 2n ** 64n - 1n] as const;
const UINT32 = [0n, 2n ** 32n - 1n] as const;
const INT32 = [-(2n ** 31n), 2n ** 31n - 1n] as const;
const bool = (value: unknown): boolean => typeof value === "boolean";
/** A list whose every entry passes. */
const listOf = (is: (one: unknown) => boolean) => (value: unknown): boolean => Array.isArray(value) && value.every(is);
/** `_meta`, wherever the protocol allows it: absent, null, or an object. */
const meta = (value: Record<string, unknown>): boolean => optional(value["_meta"], isRecord);
const ROLES = new Set(["user", "assistant"]);
const annotations = (value: unknown): boolean => optional(value, one => isRecord(one) && meta(one)
  && optional(one["audience"], list => Array.isArray(list) && list.every(role => str(role) && ROLES.has(role)))
  && optional(one["priority"], n => typeof n === "number" && Number.isFinite(n))
  && optional(one["lastModified"], str));

/** One ACP content block, every field the protocol defines for its type checked (text, image, audio, a resource link, an embedded resource). */
function wellFormedContent(block: unknown): boolean {
  if (!isRecord(block) || !str(block["type"]) || !annotations(block["annotations"]) || !meta(block)) return false;
  switch (block["type"]) {
    case "text": return str(block["text"]);
    case "image": return str(block["data"]) && str(block["mimeType"]) && optional(block["uri"], str);
    case "audio": return str(block["data"]) && str(block["mimeType"]);
    case "resource_link":
      return str(block["uri"]) && str(block["name"]) && optional(block["mimeType"], str) && optional(block["title"], str)
        && optional(block["description"], str) && optionalInteger(block, "size", ...INT64);
    case "resource": {
      // An embedded resource is one of two shapes — text contents or blob contents — beside its uri; a field the
      // matched shape doesn't define is the agent's own, and isn't read.
      const resource = block["resource"];
      return isRecord(resource) && meta(resource) && str(resource["uri"]) && (str(resource["text"]) || str(resource["blob"]))
        && optional(resource["mimeType"], str);
    }
    default: return false;
  }
}

/** A tool call's content: content blocks, diffs, or terminals. */
function wellFormedToolContent(item: unknown): boolean {
  if (!isRecord(item) || !str(item["type"]) || !meta(item)) return false;
  if (item["type"] === "content") return wellFormedContent(item["content"]);
  if (item["type"] === "diff") return str(item["path"]) && str(item["newText"]) && (item["oldText"] === undefined || item["oldText"] === null || str(item["oldText"]));
  if (item["type"] === "terminal") return str(item["terminalId"]);
  return false;
}

/** The fields a tool call or its update may carry: each, when present, of the type the protocol gives it. */
/** `initial`: a tool call's first report, whose fields are never null when present; an update's may be (unchanged). */
function wellFormedToolFields(update: Record<string, unknown>, initial = false): boolean {
  if (!meta(update)) return false;
  const field = (key: string, is: (one: unknown) => boolean) => initial ? absentOr(update[key], is) : optional(update[key], is);
  if (!field("title", str)) return false;
  if (!field("kind", one => str(one) && TOOL_KINDS.has(one))) return false;
  if (!field("status", one => str(one) && TOOL_STATUSES.has(one))) return false;
  if (!field("locations", list => Array.isArray(list) && list.every(one =>
    isRecord(one) && meta(one) && str(one["path"]) && optionalInteger(one, "line", ...UINT32)))) return false;
  if (!optional(update["name"], str)) return false;
  if (update["content"] !== undefined && update["content"] !== null && !(Array.isArray(update["content"]) && update["content"].every(wellFormedToolContent))) return false;
  return true;
}

/** A session config option, every field its schema gives (a select's current value and choices, or groups of them). */
const configChoice = (one: unknown): boolean => isRecord(one) && meta(one) && str(one["value"]) && str(one["name"]) && optional(one["description"], str);
const configGroup = (one: unknown): boolean => isRecord(one) && meta(one) && str(one["group"]) && str(one["name"]) && listOf(configChoice)(one["options"]);
function wellFormedConfigOption(option: unknown): boolean {
  if (!isRecord(option) || !meta(option) || !str(option["id"]) || !str(option["name"]) || !optional(option["description"], str)
    || !optional(option["category"], str) || !str(option["type"])) return false;
  if (option["type"] !== "select") return false;
  const choices = option["options"];
  return str(option["currentValue"]) && Array.isArray(choices) && (choices.every(configChoice) || choices.every(configGroup));
}
const wellFormedConfigOptions = listOf(wellFormedConfigOption);
const sessionModes = (value: unknown): boolean => isRecord(value) && meta(value) && str(value["currentModeId"])
  && listOf(mode => isRecord(mode) && meta(mode) && str(mode["id"]) && str(mode["name"]) && optional(mode["description"], str))(value["availableModes"]);
const sessionModels = (value: unknown): boolean => isRecord(value) && meta(value) && str(value["currentModelId"])
  && listOf(model => isRecord(model) && meta(model) && str(model["modelId"]) && str(model["name"]) && optional(model["description"], str))(value["availableModels"]);
/** A field that may be left out but, when present, is never null. */
const absentOr = (value: unknown, is: (one: unknown) => boolean): boolean => value === undefined || is(value);
const capabilities = (value: unknown, flags: readonly string[]): boolean => absentOr(value, one => isRecord(one) && meta(one) && flags.every(flag => absentOr(one[flag], bool)));
/** The session capabilities the schema names (each an optional, nullable object); others are left uninterpreted. */
const SESSION_CAPABILITIES = ["list", "delete", "additionalDirectories", "resume", "close"];

/** initialize's answer, every field the schema gives it. */
function wellFormedInitialize(result: Record<string, unknown>): boolean {
  const info = result["agentInfo"];
  if (!meta(result) || !isRecord(info) || !meta(info) || !str(info["name"]) || !str(info["version"]) || !optional(info["title"], str)) return false;
  if (!absentOr(result["authMethods"], listOf(method => isRecord(method) && meta(method) && str(method["id"]) && str(method["name"]) && optional(method["description"], str)))) return false;
  return absentOr(result["agentCapabilities"], caps => isRecord(caps) && meta(caps) && absentOr(caps["loadSession"], bool)
    && capabilities(caps["promptCapabilities"], ["image", "audio", "embeddedContext"])
    && capabilities(caps["mcpCapabilities"], ["http", "sse"])
    && absentOr(caps["sessionCapabilities"], sessions => isRecord(sessions) && meta(sessions)
      && SESSION_CAPABILITIES.every(name => optional(sessions[name], entry => isRecord(entry) && meta(entry))))
    && absentOr(caps["auth"], auth => isRecord(auth) && meta(auth) && optional(auth["logout"], logout => isRecord(logout) && meta(logout))));
}

/** session/new's answer: the id, and every field of the modes, models and config options it may carry. */
function wellFormedNewSession(result: Record<string, unknown>): boolean {
  return meta(result) && optional(result["configOptions"], wellFormedConfigOptions) && optional(result["modes"], sessionModes) && optional(result["models"], sessionModels);
}

/** Whether a known update kind carries what it must; an unknown kind is left alone (not shown, not trusted). */
function wellFormedUpdate(kind: string, update: Record<string, unknown>): boolean {
  const id = (key: string) => str(update[key]) && update[key] !== "" && (update[key] as string).length <= 256;
  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      return wellFormedContent(update["content"]) && optional(update["messageId"], str);
    case "tool_call":
      // The first report of a call carries its content as a list when it carries any (null is for updates).
      return id("toolCallId") && str(update["title"]) && update["content"] !== null && wellFormedToolFields(update, true);
    case "tool_call_update":
      return id("toolCallId") && wellFormedToolFields(update);
    case "plan":
      return Array.isArray(update["entries"]) && update["entries"].every(one =>
        isRecord(one) && meta(one) && str(one["content"]) && str(one["priority"]) && PLAN_PRIORITIES.has(one["priority"]) && str(one["status"]) && PLAN_STATUSES.has(one["status"]));
    case "available_commands_update":
      return Array.isArray(update["availableCommands"]) && update["availableCommands"].every(one =>
        isRecord(one) && meta(one) && str(one["name"]) && str(one["description"])
        && optional(one["input"], input => isRecord(input) && meta(input) && str(input["hint"])));
    case "current_mode_update":
      return str(update["currentModeId"]);
    case "config_option_update":
      return wellFormedConfigOptions(update["configOptions"]);
    case "session_info_update":
      return optional(update["title"], str) && optional(update["updatedAt"], str);
    case "usage_update":
      return wireInteger(update, "used", ...UINT64) && wireInteger(update, "size", ...UINT64)
        && optional(update["cost"], cost => isRecord(cost) && meta(cost) && typeof cost["amount"] === "number" && Number.isFinite(cost["amount"]) && str(cost["currency"]));
    case "notice":
      return str(update["severity"]) && str(update["title"]) && update["title"] !== "" && optional(update["description"], str);
    case "compaction_update":
      return str(update["compactionId"]) && str(update["status"]) && optional(update["summary"], listOf(wellFormedContent)) && optional(update["error"], str);
    case "compaction_summary_chunk":
      return str(update["compactionId"]) && wellFormedContent(update["content"]);
    default:
      return true;
  }
}

/** The update kinds passed on to the live view: the ones the plane knows and never declined. Notices and compaction,
 * which this client does not advertise, are validated when sent anyway, and go no further. */
const KNOWN_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk", "tool_call", "tool_call_update", "plan",
  "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update"]);

const AUTH_REQUIRED = -32000;

export function createAcpConversation(options: AcpConversationOptions): AcpConversation {
  let phase: AcpPhase = "initialize";
  let failure: AcpFailure | null = null;
  let terminal: AcpTerminal | null = null;
  let sessionId: string | null = null;
  let agent: { name: string; version: string } | null = null;
  let canClose = false;
  let closeId: number | null = null;
  let closeDone = false;
  let mechanism: AcpModelMechanism | null = null;
  let offered: string[] = [];
  let nextId = 0;
  /** Set once the plane asked the prompt to stop: from then on every permission request is answered "cancelled". */
  let cancelled = false;
  /** Our requests not yet answered, by id. */
  const pending = new Map<number, Pending>();
  /** Ids we have seen answered — a second answer to any of them is a protocol failure. */
  const answered = new Set<number>();
  /** The words since the last tool call: the agent's last message. */
  let message = "";
  /** The agent's own accounts of what it used: the prompt answer's `usage`, and the last `usage_update`. Never priced. */
  let promptUsage: unknown = null;
  let usageUpdate: unknown = null;
  const retained: string[] = [];

  const keep = (record: Record<string, unknown>) => { retained.push(line(record)); };
  const fail = (kind: AcpFailureKind, text: string): AcpReaction => {
    if (failure === null) {
      failure = { kind, text: bounded(text, TEXT_CAP) };
      keep({ type: "acp.failure", kind, text: failure.text });
    }
    phase = "failed";
    return { send: [], live: [] };
  };
  const request = (method: string, params: Record<string, unknown>, purpose: Pending): string => {
    const id = ++nextId;
    pending.set(id, purpose);
    return line({ jsonrpc: "2.0", id, method, params });
  };
  /** A reply under the request's id, written as its token: an integer exactly (int64, past 2^53 too), a string, or null. */
  const reply = (idToken: string, outcome: { result: unknown } | { error: { code: number; message: string } }): string => {
    const body = line({ jsonrpc: "2.0", ...outcome });
    return `{"jsonrpc":"2.0","id":${idToken},${body.slice('{"jsonrpc":"2.0",'.length)}`;
  };

  const promptLine = (): string => {
    phase = "prompt";
    return request("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] }, "prompt");
  };

  const onResult = (purpose: Pending, result: unknown, error: Record<string, unknown> | null): AcpReaction => {
    const errorText = error === null ? "" : typeof error["message"] === "string" ? error["message"] : "the agent answered with an error";
    const errorCode = error === null ? null : typeof error["code"] === "number" ? error["code"] : null;
    if (purpose === "close") {
      closeDone = true;
      // An error to close is the agent's to have; an answer must be the empty object the schema gives it.
      if (error === null && !(isRecord(result) && meta(result))) return fail("protocol", "session/close was answered with something other than an object");
      return { send: [], live: [] };
    }
    if (purpose === "prompt") {
      if (error !== null) {
        terminal = { error: { code: errorCode, message: bounded(errorText, TEXT_CAP) } };
        keep({ type: "acp.terminal", error: terminal.error });
        if (errorCode === AUTH_REQUIRED) return fail("auth-required", errorText);
        phase = "ended";
        return { send: [], live: [] };
      }
      const stop = isRecord(result) ? result["stopReason"] : undefined;
      if (typeof stop !== "string" || !STOP_REASONS.has(stop)) return fail("protocol", "the prompt's answer carried no known stop reason");
      if (!isRecord(result) || !meta(result)) return fail("protocol", "the prompt's answer carried a malformed _meta");
      terminal = { stopReason: stop as AcpStopReason };
      if (isRecord(result) && result["usage"] !== undefined) promptUsage = exactCopy(result["usage"]);
      if (message !== "") keep({ type: "acp.message", content: bounded(message, MESSAGE_CAP) });
      keep({ type: "acp.terminal", stopReason: stop });
      phase = "ended";
      return { send: [], live: [] };
    }
    if (error !== null) {
      if (errorCode === AUTH_REQUIRED) return fail("auth-required", errorText);
      return fail(purpose === "model" ? "model-unavailable" : "protocol", `${purpose}: ${errorText}`);
    }
    if (!isRecord(result)) return fail("protocol", `${purpose}: the answer was not an object`);
    if (purpose === "initialize") {
      if (!wireInteger(result, "protocolVersion", 0n, 65_535n) || result["protocolVersion"] !== PROTOCOL_VERSION) return fail("protocol", `the agent speaks protocol version ${String(result["protocolVersion"])}, not ${PROTOCOL_VERSION}`);
      const info = result["agentInfo"];
      if (!isRecord(info) || typeof info["name"] !== "string" || typeof info["version"] !== "string") return fail("identity", "the agent did not say its name and version");
      if (!wellFormedInitialize(result)) return fail("protocol", "initialize was answered with fields the protocol doesn't allow");
      agent = { name: bounded(info["name"], 128), version: bounded(info["version"], 64) };
      if (options.expect !== null && (agent.name !== options.expect.name || agent.version !== options.expect.version)) {
        return fail("identity", `the agent is ${agent.name} ${agent.version}, not the checked ${options.expect.name} ${options.expect.version}`);
      }
      const capabilities = result["agentCapabilities"];
      const sessions = isRecord(capabilities) ? capabilities["sessionCapabilities"] : undefined;
      canClose = isRecord(sessions) && isRecord(sessions["close"]);
      keep({ type: "acp.agent", name: agent.name, version: agent.version });
      phase = "session";
      return { send: [request("session/new", { cwd: options.cwd, mcpServers: options.mcpServers ?? [] }, "session/new")], live: [] };
    }
    if (purpose === "session/new") {
      const id = result["sessionId"];
      if (typeof id !== "string" || id.trim() === "" || id.length > 256) return fail("protocol", "the session had no id");
      if (!wellFormedNewSession(result)) return fail("protocol", "session/new was answered with fields the protocol doesn't allow");
      sessionId = id;
      keep({ type: "acp.session", sessionId: id });
      const offer = modelOffer(result);
      if (offer === null) return fail("model-unavailable", "the agent offers no way to choose a model");
      mechanism = offer.mechanism;
      // An agent can offer many hundreds (OpenCode lists every model of every provider it knows): kept bounded, and
      // the model asked for is always among them when offered.
      offered = offer.offered.filter(one => one.length <= 200).slice(0, ACP_OFFERED_CAP);
      if (offer.offered.includes(options.model) && !offered.includes(options.model)) offered.push(options.model);
      keep({ type: "acp.offered", models: offered });
      if (offer.mechanism !== "config-option") return fail("model-unavailable", "the agent can't confirm which model it uses (it offers only session/set_model)");
      if (!offer.offered.includes(options.model)) return fail("model-unavailable", `the agent doesn't offer ${options.model}`);
      phase = "model";
      return { send: [request("session/set_config_option", { sessionId: id, configId: "model", value: options.model }, "model")], live: [] };
    }
    // purpose === "model": the answer must be a well-formed set of config options, showing the model current.
    if (!meta(result) || !wellFormedConfigOptions(result["configOptions"])) return fail("model-unavailable", "the model choice was answered with malformed config options");
    const chosen = modelOffer(result);
    if (chosen === null || chosen.mechanism !== "config-option" || chosen.current !== options.model) return fail("model-unavailable", `the agent did not make ${options.model} current`);
    keep({ type: "acp.model", model: options.model, mechanism });
    return { send: [promptLine()], live: [] };
  };

  const onUpdate = (params: unknown): AcpReaction => {
    if (!isRecord(params) || !isRecord(params["update"])) return fail("protocol", "a session update without an update");
    if (sessionId === null || params["sessionId"] !== sessionId) return fail("protocol", "an update for another session");
    const update = params["update"];
    const kind = update["sessionUpdate"];
    if (typeof kind !== "string" || kind === "" || kind.length > 64) return fail("protocol", "a session update without a kind");
    if (!meta(update) || !meta(params)) return fail("protocol", "a session update whose _meta isn't an object");
    if (!wellFormedUpdate(kind, update)) return fail("protocol", `a malformed ${kind} update`);
    if (kind === "agent_message_chunk") {
      const content = update["content"];
      if (isRecord(content) && content["type"] === "text" && typeof content["text"] === "string" && message.length < MESSAGE_CAP) {
        message = bounded(message + content["text"], MESSAGE_CAP);
      }
    } else if (kind === "tool_call") {
      message = "";
    } else if (kind === "usage_update") {
      usageUpdate = exactCopy(update);
    }
    return { send: [], live: KNOWN_UPDATES.has(kind) ? [exactCopy(update) as Record<string, unknown>] : [] };
  };

  return {
    start() {
      return [request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, "initialize")];
    },
    receive(raw) {
      if (phase === "failed") return { send: [], live: [] };
      if (raw.length > ACP_LINE_CAP || Buffer.byteLength(raw, "utf8") > ACP_LINE_CAP) return fail("protocol", "the agent wrote a line too long to read");
      if (raw.trim() === "") return { send: [], live: [] };
      let incoming: unknown;
      try {
        // Every number's token is kept beside it: where the client reads an integer (a location's line, a resource's
        // size, an error's code, a usage count), it is exactly the integer on the wire — 1e3 is 1000, but
        // 1.0000000000000001 is not 1. Opaque data (raw input and output, metadata) is never read, so never judged.
        incoming = JSON.parse(raw, function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
          if (typeof value === "number" && context?.source !== undefined && this !== null && typeof this === "object") {
            const holder = this as object;
            const sources = NUMBER_SOURCES.get(holder) ?? new Map<string, string>();
            sources.set(key, context.source);
            NUMBER_SOURCES.set(holder, sources);
          }
          return value;
        });
      } catch {
        return fail("protocol", "the agent wrote a line that is not JSON");
      }
      if (!isRecord(incoming) || incoming["jsonrpc"] !== "2.0") return fail("protocol", "the agent wrote something that is not JSON-RPC 2.0");
      // The message's own id is read by its token, as an exact integer (4, 4e0 and 4.0 are one id; 1.0000000000000001
      // is none), so no reply goes out under, and no answer is taken for, an id other than the one on the wire.
      const hasId = Object.prototype.hasOwnProperty.call(incoming, "id");
      const id = incoming["id"];
      let idToken: string | null = null;
      let idNumber: number | null = null;
      if (typeof id === "number") {
        const source = NUMBER_SOURCES.get(incoming)?.get("id");
        const exact = source === undefined ? null : exactInteger(source);
        if (exact === null || exact < INT64[0] || exact > INT64[1]) return fail("protocol", "a message whose id isn't an integer");
        idToken = exact.toString();
        if (BigInt(Number(exact)) === exact && Number.isSafeInteger(Number(exact))) idNumber = Number(exact);
      } else if (typeof id === "string" && id.length <= 256) idToken = JSON.stringify(id);
      else if (id === null && hasId) idToken = "null";
      const method = incoming["method"];
      if (typeof method === "string") {
        const params = incoming["params"];
        // Anything that names a session must name ours.
        if (isRecord(params) && params["sessionId"] !== undefined && params["sessionId"] !== sessionId) return fail("protocol", "a message for another session");
        if (!hasId) {
          // A notification. Only session updates mean anything; the rest are ignored.
          return method === "session/update" ? onUpdate(params) : { send: [], live: [] };
        }
        // An id we answer under goes back exactly as sent: an integer, a bounded string, or null.
        if (idToken === null) return fail("protocol", "an agent request with a malformed id");
        if (method === "session/request_permission") {
          if (!isRecord(params) || sessionId === null || params["sessionId"] !== sessionId) return fail("protocol", "a permission request for another session");
          const call = params["toolCall"];
          // The tool call it asks about must be as well formed as one sent in an update, or nothing is granted.
          const answer = isRecord(call) && typeof call["toolCallId"] === "string" && call["toolCallId"] !== "" && call["toolCallId"].length <= 256 && wellFormedToolFields(call)
            ? permissionAnswer(params)
            : null;
          const step = {
            sessionUpdate: "permission",
            toolCallId: isRecord(call) && typeof call["toolCallId"] === "string" ? call["toolCallId"] : null,
            title: isRecord(call) && typeof call["title"] === "string" ? call["title"] : null,
            kind: isRecord(call) && typeof call["kind"] === "string" ? call["kind"] : null,
          };
          // Granted only while our prompt runs and was not cancelled: before the model is confirmed, after the answer,
          // or after a cancel, the request is answered "cancelled".
          if (cancelled || phase !== "prompt") {
            return { send: [reply(idToken, { result: { outcome: { outcome: "cancelled" } } })], live: [{ ...step, granted: false }] };
          }
          if (answer === null) {
            return { send: [reply(idToken, { error: { code: -32602, message: "a permission request needs a tool call and an option this client can choose" } })], live: [{ ...step, granted: false }] };
          }
          return {
            send: [reply(idToken, { result: { outcome: { outcome: "selected", optionId: answer.optionId } } })],
            live: [{ ...step, granted: answer.granted }],
          };
        }
        return { send: [reply(idToken, { error: { code: -32601, message: "this client offers no such method" } })], live: [] };
      }
      // A response to one of ours.
      if (idNumber === null) return fail("protocol", "a response with an id the plane never sent");
      if (answered.has(idNumber)) return fail("protocol", "a second answer to the same request");
      const purpose = pending.get(idNumber);
      if (purpose === undefined) return fail("protocol", "a response with an id the plane never sent");
      pending.delete(idNumber);
      answered.add(idNumber);
      const hasResult = Object.prototype.hasOwnProperty.call(incoming, "result");
      const hasError = Object.prototype.hasOwnProperty.call(incoming, "error");
      if (hasResult === hasError) return fail("protocol", "a response must carry a result or an error, not both or neither");
      const error = incoming["error"];
      if (hasError && !(isRecord(error) && wireInteger(error, "code", ...INT32) && typeof error["message"] === "string")) {
        return fail("protocol", "a response with a malformed error");
      }
      return onResult(purpose, incoming["result"], hasError ? error as Record<string, unknown> : null);
    },
    cancel() {
      if (phase !== "prompt" || sessionId === null) return [];
      cancelled = true;
      return [line({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })];
    },
    refuse(text) {
      fail("protocol", text);
    },
    close() {
      if (!canClose || sessionId === null || closeId !== null) return [];
      const sent = request("session/close", { sessionId }, "close");
      closeId = nextId;
      return [sent];
    },
    closeAnswered: () => closeDone || phase === "failed",
    phase: () => phase,
    failure: () => failure,
    terminal: () => terminal,
    sessionId: () => sessionId,
    agent: () => agent,
    mechanism: () => mechanism,
    offered: () => offered.slice(),
    retained: () => {
      // The agent's own usage accounts ride every outcome — a failure spent too.
      const usage = promptUsage === null && usageUpdate === null ? [] : [line({ type: "acp.reported", usage: bounded(JSON.stringify({ prompt: promptUsage, update: usageUpdate }), USAGE_CAP) })];
      const all = [...retained, ...usage];
      return all.length === 0 ? "" : `${all.join("\n")}\n`;
    },
  };
}

/** What the gateway reads back from a conversation's retained record. */
export type AcpEnvelope = {
  sessionId: string | null;
  protocolError: string | null;
  finalMessage: string | null;
  /** The agent's own usage report, unattested: never priced. */
  reportedUsage: string | null;
  initObserved: boolean;
  /** True only when the prompt's answer was `end_turn`. */
  promptConsumed: boolean;
  diagnostic: string | null;
  /** A failure terminal, when the prompt was answered with anything but end_turn or the conversation failed. */
  terminal: { failed: true; text: string | null; code: string } | null;
  /** The models the agent offered at session/new (the conformance check records them). */
  offered: string[];
  /** Who the agent said it is at initialize. */
  agent: { name: string; version: string } | null;
  /** The prompt's stop reason, when it answered with one. */
  stop: string | null;
  /** How the agent's process ended, as the runner saw it: on its own after stdin closed, or by our SIGTERM or kill;
   * and whether anything of its group was still alive at the reap. Null when the runner wrote none. */
  exit: { how: "eof" | "term" | "kill" | "self" | "error"; leftover: boolean; timedOut: boolean } | null;
};

/** Read a conversation's retained record. Lines not typed `acp.*` are ignored. */
export function acpParse(stdout: string): AcpEnvelope {
  let agentSeen = false;
  let sessionId: string | null = null;
  let conflict = false;
  let finalMessage: string | null = null;
  let reportedUsage: string | null = null;
  let stop: string | null = null;
  let rpcError: { code: number | null; message: string } | null = null;
  let terminals = 0;
  let failure: { kind: string; text: string } | null = null;
  let offered: string[] = [];
  let agent: AcpEnvelope["agent"] = null;
  let exit: AcpEnvelope["exit"] = null;
  for (const raw of stdout.split("\n")) {
    if (raw.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const type = event["type"];
    if (type === "acp.agent") {
      agentSeen = true;
      if (agent === null && typeof event["name"] === "string" && typeof event["version"] === "string") agent = { name: event["name"], version: event["version"] };
    }
    else if (type === "acp.session" && typeof event["sessionId"] === "string") {
      if (sessionId === null) sessionId = event["sessionId"];
      else if (sessionId !== event["sessionId"]) conflict = true;
    } else if (type === "acp.message" && typeof event["content"] === "string") finalMessage = event["content"];
    else if (type === "acp.reported" && typeof event["usage"] === "string") reportedUsage = event["usage"];
    else if (type === "acp.terminal") {
      terminals += 1;
      if (typeof event["stopReason"] === "string") stop = event["stopReason"];
      else if (isRecord(event["error"])) {
        const error = event["error"];
        rpcError = { code: typeof error["code"] === "number" ? error["code"] : null, message: typeof error["message"] === "string" ? error["message"] : "" };
      }
    } else if (type === "acp.offered" && Array.isArray(event["models"])) {
      offered = event["models"].filter((one): one is string => typeof one === "string").slice(0, ACP_OFFERED_CAP + 1);
    } else if (type === "acp.exit" && typeof event["how"] === "string" && ["eof", "term", "kill", "self", "error"].includes(event["how"])) {
      exit = { how: event["how"] as NonNullable<AcpEnvelope["exit"]>["how"], leftover: event["leftover"] === true, timedOut: event["timedOut"] === true };
    } else if (type === "acp.failure" && failure === null) {
      failure = { kind: typeof event["kind"] === "string" ? event["kind"] : "protocol", text: typeof event["text"] === "string" ? event["text"] : "" };
    }
  }
  const protocolError = conflict
    ? "the agent named two sessions"
    : terminals > 1
      ? "the prompt was answered twice"
      : failure !== null && failure.kind === "protocol"
        ? `the agent broke the protocol: ${failure.text}`
        : null;
  const success = protocolError === null && failure === null && terminals === 1 && stop === "end_turn";
  const diagnostic = failure?.text ?? rpcError?.message ?? null;
  const code = failure !== null
    ? failure.kind
    : rpcError !== null
      ? `rpc:${rpcError.code ?? "?"}`
      : stop !== null && stop !== "end_turn"
        ? stop
        : null;
  return {
    sessionId: conflict ? null : sessionId,
    protocolError,
    finalMessage,
    reportedUsage,
    initObserved: agentSeen && sessionId !== null,
    promptConsumed: success,
    diagnostic: diagnostic === "" ? null : diagnostic,
    terminal: success || code === null ? null : { failed: true, text: diagnostic === "" ? null : diagnostic, code },
    offered,
    exit,
    agent,
    stop: terminals === 1 ? stop : null,
  };
}
