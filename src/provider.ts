/**
 * The provider registry: every way this plane can spend money on an agent,
 * in one file (§5's "one door", widened to three harness shapes).
 *
 * A provider here is how to SPAWN a harness and how to READ its envelope —
 * argv dialect, transport, session identity, usage. The briefs, the mailbox
 * protocol, and every custody proof are provider-neutral and live where
 * they always did; this module owns only the dialect differences.
 *
 * Boundary (the architecture test enforces it): only `invoke.ts` may import
 * the spawning surface (`adapterFor`); everything else that needs provider
 * facts uses the non-spending inspection surface (`PROVIDERS`,
 * `inspectionOf`) — identification must never be a way to start an LLM.
 *
 * `openrouter` is deliberately not a fourth transport: it is the codex
 * harness pointed at OpenRouter through `-c` overrides whose keys and
 * values are CONSTANTS below — no caller-supplied dotted keys, values
 * TOML-quoted deterministically, and the API key excluded from every
 * shell the model itself launches (Codex provider review, Q5).
 */

import { claudeFenceSettings, codexFenceArgv } from "./agent-fence.js";
import { type ExecResult, type RunOptions } from "./exec.js";
import { runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl } from "./exec.js";
import { scanForSecrets } from "./evidence.js";
import { FINDINGS_MODEL_SCHEMA } from "./contracts/review-findings.js";
import { REVIEW_OUTPUT_LIMITS } from "./structured-output.js";
import { agentSpecSchema, MODEL_ID, modelIdSchema, PROVIDER_ID_VALUES, providerIdSchema, type AgentSpec, type ProviderId } from "./contracts/provider.js";

export type { AgentSpec, ProviderId } from "./contracts/provider.js";
export const PROVIDER_IDS: readonly ProviderId[] = PROVIDER_ID_VALUES;

export function isProviderId(value: string): value is ProviderId {
  return providerIdSchema.safeParse(value).success;
}

/** 'review' (v29) is the reviewer's artifact-only pass — plan-shaped in
 * every clamp: read, comment, never build. */
export type Phase = "plan" | "build" | "repair" | "review";

/**
 * Model ids cross providers ("anthropic/claude-sonnet-4.5", "gpt-5-codex",
 * "opus"). Bounded and printable, never leading-dash (argv safety), and no
 * TOML-hostile characters — but NOT alphanumeric-only, which would refuse
 * real ids carrying `/ . : -` (Codex provider review, Q5).
 */
export { MODEL_ID };

export function validModelId(model: string | null): boolean {
  // Not a string reads as its text, as the regex always read it (an untyped row's `undefined` passes as "undefined").
  return model === null || modelIdSchema.safeParse(String(model)).success;
}

/** The one semantic request every provider renders into its own argv. */
export type Invocation = {
  phase: Phase;
  brief: string;
  model: string | null;
  /** Claude's turn bound. Codex has no equivalent — see `clampTimeout`. */
  maxTurns: number;
  permissionMode: string;
  skipPermissions: boolean;
  /** Resume this session (repair). Meaningless across providers. */
  resumeSession: string | null;
  /** Claude's native dollar cap — the harness stops
   * itself when spend reaches this. Ignored by providers without one. */
  maxBudgetUsd?: number;
  /** A plane-minted session identity, for providers that can START under a
   * caller-chosen id (gemini `--session-id`). The gateway stamps it
   * durably BEFORE spawn and requires the envelope's init id to EQUAL it
   * (Phase 3 A5) — a mismatch is a provider-protocol failure, never a
   * silent survivor. */
  startSessionId?: string;
  /** Sealed reviewer screenshots, attached explicitly by transports without a read tool. */
  reviewImages?: readonly string[];
  /** The project's tools for this launch (v80): the provider's own flags
   * naming exactly those MCP servers and no others. Never rendered for a
   * review, which keeps its own no-tools isolation. */
  toolArgv?: readonly string[];
  /** The agent fence (agent-fence.ts): paths no agent may read or write.
   * Codex renders it as its own sandbox profile; Claude as deny rules for
   * its file tools (its shell is fenced by the macOS sandbox around it). */
  fence?: readonly string[];
  /** Claude's structured-output floor for a non-review phase: the scout's
   * report rides the terminal result event instead of a file plan mode
   * would refuse to write. Ignored by providers without `--json-schema`. */
  jsonSchema?: Readonly<Record<string, unknown>>;
  /** Claude tools allowed without asking, for a `dontAsk` launch: the scout's
   * research and screenshot tools, and nothing that edits or runs commands. */
  allowedTools?: readonly string[];
  /** More MCP servers for this launch only, beside the project's own (the
   * scout's headless browser). Claude-only; ignored for a review. */
  extraMcpServers?: Readonly<Record<string, unknown>>;
  /** A research step's project tools: only these servers, each offering only
   * these read-only actions (Codex's `enabled_tools`). Others are left out. */
  readOnlyTools?: Readonly<Record<string, readonly string[]>>;
  /** Why a research step's connected service was left out, by server, when it isn't the usual reason (its grant writes). */
  researchWithheld?: Readonly<Record<string, string>>;
};

export type ProviderRunner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/** The harness's own account of how a turn ended. */
export type AgentEnding = { subtype: string | null; turns: number | null };

/** What every envelope normalizes to, whatever dialect produced it. */
export type ParsedEnvelope = {
  sessionId: string | null;
  /**
   * A structurally impossible provider envelope. Unlike diagnostic prose,
   * this is a control signal consumed by the invocation gateway: the
   * process spent, but its output may not authorize a handoff or resume.
   */
  protocolError: string | null;
  /** The agent's spoken conclusion — diagnostics only, never the handoff. */
  finalMessage: string | null;
  /** Claude's schema-validated `structured_output` alone, re-serialized —
   * never the prose result, even when that prose is JSON. Absent or null
   * when the turn ran without `--json-schema` or returned none. */
  structuredOutput?: string | null;
  /** How the harness said the turn ended (claude: the result's subtype and
   * turn count) — absent on dialects that carry no such record. */
  ending?: AgentEnding | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  usageRaw: string | null;
  /**
   * Whether the provider was seen to initialize (codex: thread.started;
   * claude streaming: system/init). null = this transport carries no init
   * signal (legacy buffered fixtures), so absence proves nothing. A `false`
   * here on a failed run means the harness never came up — config, auth,
   * or install — and the turn must not be treated as an agent's attempt
   * (M5 provider audit).
   */
  initObserved: boolean | null;
  /**
   * Structural proof the MAIN QUERY consumed the prompt (arc 1 finding 15):
   * true only when the primary result is a success. null = this transport
   * carries no such signal, and the gateway falls back to its historical
   * nothing-to-show rule. Never derived from result PROSE — an error
   * result's diagnostic text must not read as an agent's attempt.
   */
  promptConsumed: boolean | null;
  /**
   * The harness's own first error message, bounded (2 KiB UTF-8), kept for
   * refusal words and evidence — DIAGNOSTICS ONLY, control-normalized and
   * secret-scanned at render, never classification (Phase 3 B6). null =
   * the transport carries none or none was seen.
   */
  diagnostic: string | null;
  /**
   * The structural FAILURE terminal, when the harness emitted a typed one
   * (codex turn.failed, a gemini error terminal) — retained to classify
   * how the attempt ended (a sign-in that no longer works) AND to block
   * success ingestion on a failed-but-exit-0 run (C5). null = no structural
   * failure terminal seen.
   */
  structuralTerminal: import("./exhaustion.js").StructuralTerminal | null;
};

type Adapter = {
  binary: string;
  argv(invocation: Invocation): string[];
  /** Prompt input for transports that use stdin instead of a bounded OS argument. */
  stdin?(invocation: Invocation): string | undefined;
  parse(stdout: string): ParsedEnvelope;
  /** The production transport when no runner was injected. */
  defaultRunner: ProviderRunner;
  /** Other providers' keys, stripped from this provider's environment. Its
   * own key (API-key mode only) stays: the provider needs it, and its
   * agent's shell inherits the environment. */
  extraOmitEnv: readonly string[];
  /** Normalize the phase's bounded interval. For ordinary current profiles
   * this is the no-progress watchdog; for repair and legacy profiles it is
   * a hard wall clock. */
  clampTimeout(phase: Phase, requestedMs: number): number;
};

const USAGE_JSON_CAP = 8 * 1024;

/** Empty and whitespace-only identities are absence, never resumable ids. */
function sessionIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id === "" ? null : id;
}

/** Deterministic TOML basic-string quoting for -c values — never the CLI's raw fallback. */
function toml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** OpenRouter rides codex under a PRIVATE provider key, isolated from user config. */
const OPENROUTER_PROVIDER_KEY = "standing-orders_openrouter";
export const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Reviewer isolation (fail-closed for the phase that must never mutate):
 * the SAME flag family `subscription-chat.ts` already uses for its own
 * sealed-scratch turn — no tool but reading the sealed files, no prompt
 * that can stall a headless run waiting on an
 * approval nobody can answer, and no MCP server (global OR project) loaded
 * at all. A reviewer that goes looking for tools beyond its scratch
 * directory is exactly the leak this closes: `--permission-mode plan`
 * alone governs EDITS, not an MCP server's own tools or an interactive
 * prompt, and a headless `-p` turn that stalls on either just sits idle
 * until the timeout kills it, having spent the money on nothing.
 */
const CLAUDE_REVIEW_ISOLATION_ARGV: readonly string[] = [
  "--restricted",
  "--safe-mode",
  "--tools",
  "Read",
  "--permission-prompts",
  "none",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
];

/**
 * Run 1467's fix: Opus's reply to a review turn came back as JSON that
 * `parseReview` refused outright — prose around the object, a stray code
 * fence, a shape close but not exact. `--json-schema` is claude's own
 * structured-output enforcement, so the CLI (not this codebase) is what
 * makes the model's final message parse as JSON shaped like a review — it
 * is a formatting floor, never a validator: an id absent from the signed
 * rubric, a duplicate id, or a judgement word outside the three legal ones
 * still only `parseReview` can catch, because only `parseReview` is handed
 * the run's actual signed criteria. Claude-only and review-phase-only: no
 * other provider has this flag, and no other phase asks for structured
 * output.
 *
 * Run 1638's fix: ONE flat object, never a top-level union. The evidence
 * read channel (`readEvidence`, review-evidence.ts) shares this reply
 * schema and session, and the first draft expressed "a review OR a read
 * request" as a root `anyOf`. The API refuses that before any model turn
 * (`tools.N.custom.input_schema.type: Field required`), and a root
 * `type: "object"` beside the `anyOf` is refused the same way — top-level
 * unions are unsupported for structured output. So the two reply shapes
 * are merged into one property set with only `version` required, and
 * the machine's own parsers do the discrimination the schema cannot:
 * `isEvidenceOnlyReply`/`evidenceRequest` accept exactly
 * `{version, readEvidence}` and nothing else; `parseReview` refuses any
 * reply carrying `readEvidence` (a mixed reply is neither), and still
 * refuses a review missing its comments or any signed criterion. Nothing
 * a looser floor lets through lands anywhere but a typed refusal.
 */
const CLAUDE_REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    // Optional advice is not a review gate. project-learning validates its
    // shape, UTF-8 byte limits, secrets and provenance after core ingestion,
    // recording invalid advice without changing the review. Duplicating that
    // contract here made a 126-character observation kill a valid review.
    learningAssessment: {},
    learning: {},
    version: { type: "integer", enum: [1] },
    comments: {
      type: "array",
      maxItems: REVIEW_OUTPUT_LIMITS.comments,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: ["integer", "null"], minimum: 1 },
          // Text limits belong to parseReview and its bounded same-session
          // correction, not a second provider retry loop counting code points.
          note: { type: "string" },
          severity: { type: "string", enum: ["note", "question", "problem"] },
        },
        required: ["path", "note"],
        additionalProperties: false,
      },
    },
    criteria: {
      type: "array",
      maxItems: REVIEW_OUTPUT_LIMITS.criteria,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          judgement: { type: "string", enum: ["upholds", "contradicts", "cannot-tell"] },
          note: { type: "string" },
        },
        required: ["id", "judgement", "note"],
        additionalProperties: false,
      },
    },
    // The automatic build review's reply (build-review.ts), from its one
    // schema (src/contracts/review-findings.ts); parseBuildFindings reads it.
    findings: FINDINGS_MODEL_SCHEMA,
    // The read request rides the same structured reply channel and
    // session. The machine validates the exact allowlist/hash/range
    // before supplying bytes; this only shapes the request.
    readEvidence: {
      type: "object", properties: {
        file: { type: "string", minLength: 1, maxLength: 100 },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1, maximum: 65536 },
      }, required: ["file", "sha256", "offset", "length"], additionalProperties: false,
    },
  },
  required: ["version"],
  additionalProperties: false,
} as const;

/** Claude's own tools that only make sense with a person to wake them. */
export const HEADLESS_DISALLOWED_TOOLS: readonly string[] = ["ScheduleWakeup", "CronCreate", "Monitor"];

const claudeArgv = (invocation: Invocation): string[] => [
  "-p",
  invocation.brief,
  ...(invocation.resumeSession === null ? [] : ["--resume", invocation.resumeSession]),
  // stream-json (arc 1): the terminal result event IS the old buffered
  // envelope, now arriving as one line of many — the streaming transport
  // retains it structurally instead of buffering the whole session into
  // an 8 MiB kill. --verbose is required by the harness for stream-json
  // with -p and changes nothing else.
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  String(invocation.maxTurns),
  ...(invocation.phase === "review"
    ? ["--permission-mode", invocation.permissionMode === "bypassPermissions" ? "plan" : invocation.permissionMode]
    : invocation.skipPermissions
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", invocation.permissionMode]),
  ...(invocation.model === null ? [] : ["--model", invocation.model]),
  ...(invocation.maxBudgetUsd === undefined ? [] : ["--max-budget-usd", String(invocation.maxBudgetUsd)]),
  ...(invocation.phase === "review"
    ? [...CLAUDE_REVIEW_ISOLATION_ARGV, "--json-schema", JSON.stringify(CLAUDE_REVIEW_JSON_SCHEMA)]
    : [
        // Headless (run 2085): a wakeup, cron job or monitor needs a later
        // turn that a -p process never gets. Denied at the harness too.
        "--disallowedTools", HEADLESS_DISALLOWED_TOOLS.join(","),
        ...(invocation.allowedTools === undefined || invocation.allowedTools.length === 0 ? [] : ["--allowedTools", invocation.allowedTools.join(",")]),
        ...(invocation.toolArgv ?? []),
        ...(invocation.extraMcpServers === undefined ? [] : ["--mcp-config", JSON.stringify({ mcpServers: invocation.extraMcpServers })]),
        ...(invocation.fence !== undefined && invocation.fence.length > 0 ? ["--settings", claudeFenceSettings(invocation.fence)] : []),
        ...(invocation.jsonSchema === undefined ? [] : ["--json-schema", JSON.stringify(invocation.jsonSchema)])]),
];

/** A claude envelope object, whichever line carried it. */
type ClaudeResultShape = {
  result?: unknown;
  /** Present only when the turn ran under `--json-schema` (the review
   * phase's structured-output floor, run 1467's fix): the model's reply,
   * already schema-validated by the CLI itself. */
  structured_output?: unknown;
  session_id?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  total_cost_usd?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  num_turns?: unknown;
  origin?: unknown;
};

/**
 * The turn's own words, preferring the schema-validated structured field
 * (present only under `--json-schema`) over the plain result string — the
 * same preference `subscription-chat.ts`'s `claudeOutput` already applies
 * for its own `--json-schema` turn. Re-serialized (never the CLI's raw
 * text) so downstream parsing (`parseReview`) sees canonical JSON either
 * way.
 */
function claudeFinalMessage(result: ClaudeResultShape | null): string | null {
  if (result === null) return null;
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return JSON.stringify(result.structured_output);
  }
  return typeof result.result === "string" ? result.result : null;
}

/**
 * The primary-result allowlist (arc 1 finding 10): only an absent origin or
 * an explicit human origin can be the main query's accounting envelope.
 * Every other kind — task-notification, channel, peer, coordinator, and
 * anything the SDK grows later — fails closed as a non-primary result.
 */
function claudePrimaryOrigin(event: ClaudeResultShape): boolean {
  if (event.origin === undefined || event.origin === null) return true;
  return typeof event.origin === "object" && String((event.origin as Record<string, unknown>)["kind"] ?? "") === "human";
}

function claudeEnvelopeOf(
  result: ClaudeResultShape | null,
  sessionFromInit: string | null,
  initObserved: boolean | null,
  initSessionConflict = false,
): ParsedEnvelope {
  const input = result?.usage?.input_tokens;
  const output = result?.usage?.output_tokens;
  const cost = result?.total_cost_usd;
  const sessionFromResult = sessionIdOf(result?.session_id);
  const resultSessionConflict =
    sessionFromInit !== null && sessionFromResult !== null && sessionFromInit !== sessionFromResult;
  const sessionConflict = initSessionConflict || resultSessionConflict;
  return {
    // Never choose one side of a contradictory identity. A repair must not
    // resume either session until the gateway has refused this turn.
    sessionId: sessionConflict ? null : sessionFromResult ?? sessionFromInit,
    protocolError: initSessionConflict
      ? "Claude emitted conflicting system/init session ids"
      : resultSessionConflict
        ? "the Claude init event and terminal result announced different session ids"
        : null,
    finalMessage: claudeFinalMessage(result),
    structuredOutput:
      result === null || result.structured_output === undefined || result.structured_output === null
        ? null
        : JSON.stringify(result.structured_output),
    ending: result === null ? null : {
      subtype: typeof result.subtype === "string" ? result.subtype : null,
      turns: typeof result.num_turns === "number" && result.num_turns >= 0 ? result.num_turns : null,
    },
    tokensIn: typeof input === "number" && input >= 0 ? input : null,
    tokensOut: typeof output === "number" && output >= 0 ? output : null,
    costUsd: typeof cost === "number" && cost >= 0 ? cost : null,
    usageRaw: result?.usage === undefined ? null : JSON.stringify(result.usage).slice(0, USAGE_JSON_CAP),
    initObserved,
    // Structural, never prose (finding 15): consumed means the primary
    // result says SUCCESS. An error result keeps its text as diagnostics
    // while proving nothing about delivery; when the transport carries no
    // signal (legacy buffered), null defers to the gateway's old rule.
    promptConsumed:
      initObserved === null
        ? null
        : result !== null && result.is_error !== true && String(result.subtype ?? "") === "success",
    diagnostic: null,
    // Claude's usage-limit signal, when a fixture exists, is recognized
    // from the error result's text at classification; the parser records a
    // structural failure terminal when the result is a non-success error.
    structuralTerminal:
      result !== null &&
      (result.is_error === true ||
        (typeof result.subtype === "string" && result.subtype !== "success") ||
        (initObserved !== null && typeof result.subtype !== "string"))
        ? { failed: true, text: typeof result.result === "string" ? result.result.slice(0, 2048) : null, code: typeof result.subtype === "string" ? result.subtype.slice(0, 128) : null }
        : null,
  };
}

/**
 * Reads the streaming runner's retained lines: a bounded set of
 * `system`/`init` identity witnesses and one primary `result`, re-proved here
 * (the parser trusts no transport to have selected correctly). A single
 * object without a `type` field is the
 * legacy buffered envelope — kept for recorded fixtures, carrying no init
 * signal, exactly as before the transport switch.
 */
function claudeParse(stdout: string): ParsedEnvelope {
  let initSeen = false;
  let sessionFromInit: string | null = null;
  let initSessionConflict = false;
  let primary: ClaudeResultShape | null = null;
  let transportFailure: ClaudeResultShape | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const type = event["type"];
    if (type === undefined) {
      // Legacy buffered envelope: one JSON object, no event framing.
      return claudeEnvelopeOf(event as ClaudeResultShape, null, null);
    }
    if (String(type) === "system" && String(event["subtype"] ?? "") === "init") {
      initSeen = true;
      const id = sessionIdOf(event["session_id"]);
      if (id !== null) {
        if (sessionFromInit === null) sessionFromInit = id;
        else if (id !== sessionFromInit) initSessionConflict = true;
      }
    } else if (String(type) === "result") {
      const result = event as ClaudeResultShape;
      if (
        result.is_error === true &&
        result.subtype === "standing-orders-stream-event-overflow" &&
        transportFailure === null
      ) {
        // The transport may append this bounded witness after an otherwise
        // valid result when a later oversized init could conceal a second
        // session identity. It is an independent protocol failure, not a
        // replacement for the primary result's usage/accounting envelope.
        transportFailure = result;
      }
      if (primary === null && claudePrimaryOrigin(result)) primary = result;
    }
  }
  const envelope = claudeEnvelopeOf(primary, sessionFromInit, initSeen, initSessionConflict);
  if (transportFailure === null) return envelope;
  return {
    ...envelope,
    structuralTerminal: {
      failed: true,
      text: typeof transportFailure.result === "string" ? transportFailure.result.slice(0, 2048) : null,
      code: "standing-orders-stream-event-overflow",
    },
  };
}

/**
 * The sandbox on a RESUME rides as a config override (`-c sandbox_mode=…`),
 * never as `--sandbox`: `codex exec resume` (0.145.0, probed 2026-09-11)
 * has no `--sandbox` flag and exits 2 before initializing when handed one
 * — every structured correction and repair-by-resume was an immediately
 * doomed turn that never echoed its thread. The override names the same
 * exact mode the fresh turn was sealed with; the bypass flag and every
 * `-c` override are accepted by both subcommands.
 */
const codexSandboxArgv = (mode: "read-only" | "workspace-write", resuming: boolean): string[] =>
  resuming ? ["-c", `sandbox_mode="${mode}"`] : ["--sandbox", mode];

/**
 * Codex's own fail-closed equivalent of `CLAUDE_REVIEW_ISOLATION_ARGV`:
 * read-only sandbox rather than the ordinary `workspace-write` (a reviewer
 * dispatched to codex was, until this, handed a write-capable sandbox —
 * the same class of leak the claude side had), approvals that REFUSE
 * rather than wait on a prompt a headless turn can never answer, and the
 * user's own `~/.codex/config.toml` — which can name arbitrary MCP
 * servers, exactly the surface `--strict-mcp-config` closes for claude —
 * ignored outright.
 */
const CODEX_REVIEW_ISOLATION_ARGV = (resuming: boolean): readonly string[] => [
  "--ignore-user-config",
  ...codexSandboxArgv("read-only", resuming),
  "-c",
  'approval_policy="never"',
  "-c",
  'web_search="disabled"',
  "-c",
  "features.shell_tool=false",
  "-c",
  "features.unified_exec=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "apps._default.enabled=false",
];

/**
 * Codex argv. The brief is the positional prompt; resume is a subcommand.
 * Auto uses `workspace-write` because the protocol REQUIRES workspace
 * writes (the mailbox, the handoff). Full access uses Codex's one explicit
 * combined bypass flag; that exact choice came from the sealed profile.
 * Never `--ephemeral`: repair resumes.
 */
const codexArgv = (extra: readonly string[]) => (invocation: Invocation): string[] => {
  const resuming = invocation.resumeSession !== null;
  return [
    "exec",
    ...(invocation.resumeSession === null ? [] : ["resume", invocation.resumeSession]),
    "--json",
    "--skip-git-repo-check",
    ...(invocation.phase === "review"
      ? CODEX_REVIEW_ISOLATION_ARGV(resuming)
      // The agent fence: Codex's own sandbox with Toolroll's secrets
      // denied. Full access becomes that sandbox widened to write anywhere
      // with network, instead of no sandbox (which fenced nothing).
      : invocation.fence !== undefined && invocation.fence.length > 0
        ? codexFenceArgv(invocation.fence, invocation.skipPermissions)
        : invocation.skipPermissions
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : codexSandboxArgv("workspace-write", resuming)),
    ...(invocation.model === null ? [] : ["-m", invocation.model]),
    ...extra,
    // After `extra`: the tools' shell_environment_policy must be the last word (it keeps OpenRouter's key out too).
    ...(invocation.phase === "review" ? [] : invocation.toolArgv ?? []),
    ...(invocation.phase === "review" ? (invocation.reviewImages ?? []).flatMap(path => ["--image", path]) : []),
    // Review includes the sealed text itself: no shell/read tool exists in
    // this posture. stdin avoids both per-argument and Windows argv limits.
    invocation.phase === "review" ? "-" : invocation.brief,
  ];
};

/**
 * The retained JSONL lines (the streaming transport keeps only these):
 * thread.started (session), turn.completed (usage), the last agent_message.
 * Unknown events were dropped at the transport; unknown here are ignored
 * too. Missing terminal usage stays NULL — unmeasured, and said so.
 */
function codexParse(stdout: string): ParsedEnvelope {
  let sessionId: string | null = null;
  let sessionConflict = false;
  let finalMessage: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let usageRaw: string | null = null;
  let initObserved = false;
  let structuralTerminal: import("./exhaustion.js").StructuralTerminal | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event["type"] ?? "");
    if (type === "thread.started") {
      // The init signal, id or no id: the harness came up. A malformed
      // thread_id loses the session, not the fact of initialization.
      initObserved = true;
      const announced = sessionIdOf(event["thread_id"]);
      if (announced !== null) {
        if (sessionId === null) sessionId = announced;
        else if (announced !== sessionId) sessionConflict = true;
      }
    } else if (type === "turn.completed") {
      const usage = event["usage"] as Record<string, unknown> | undefined;
      const input = usage?.["input_tokens"];
      const output = usage?.["output_tokens"];
      // cached_input_tokens deliberately NOT summed into input — it rides
      // only in the raw record (Codex provider review, Q2).
      if (typeof input === "number" && input >= 0) tokensIn = input;
      if (typeof output === "number" && output >= 0) tokensOut = output;
      if (usage !== undefined) usageRaw = JSON.stringify(usage).slice(0, USAGE_JSON_CAP);
    } else if (type === "item.completed") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item !== undefined && String(item["type"] ?? "") === "agent_message") {
        const text = item["text"];
        if (typeof text === "string") finalMessage = text;
      }
    } else if (type === "turn.failed") {
      // RETAIN the structural failure terminal (Codex verify, finding 1):
      // a turn.failed carries the usage-limit or sign-in signal, and
      // dropping it here is where the evidence used to die. The error
      // object's message + typed code ride into the taxonomy; its mere
      // presence blocks success ingestion downstream.
      const error = event["error"] as Record<string, unknown> | undefined;
      const message = error?.["message"];
      const code = error?.["type"] ?? error?.["code"];
      structuralTerminal = {
        failed: true,
        text: typeof message === "string" ? message.slice(0, 2048) : null,
        code: typeof code === "string" ? code.slice(0, 128) : null,
      };
    }
  }
  // Codex reports no dollars. NULL is the honest cost — unmeasured — and
  // every surface downstream already says so instead of summing a lie.
  // promptConsumed stays null: codex carries no structural consumption
  // signal, and the gateway keeps its historical rule for it.
  return {
    // As with Claude, never let either side of a contradictory identity
    // become repair state. The gateway records the spend, then refuses it.
    sessionId: sessionConflict ? null : sessionId,
    protocolError: sessionConflict
      ? "Codex emitted conflicting thread.started session ids"
      : null,
    finalMessage,
    tokensIn,
    tokensOut,
    costUsd: null,
    usageRaw,
    initObserved,
    promptConsumed: null,
    diagnostic: null,
    structuralTerminal,
  };
}

/** Codex interval caps: inactivity for current profiles, wall clock for
 * repair and legacy profiles. */
const CODEX_TIMEOUT_CAP_MS: Record<Phase, number> = {
  build: 20 * 60_000,
  plan: 20 * 60_000,
  repair: 5 * 60_000,
  review: 20 * 60_000,
};

/**
 * Gemini argv (Phase 3, v0.57.0 audit). The brief is `-p` (headless);
 * `--approval-mode` is the ONE sealed autonomy dial — skipPermissions
 * maps to yolo exactly where claude maps it to bypass, anything else is
 * auto_edit (fail-closed: never `default`, whose headless behavior is
 * tool failure, and never `plan`, which cannot write the mailbox).
 * Session identity is minted by the plane (`--session-id`) or resumed
 * (`--resume`) — never both. No turn bound and no dollar cap exist to
 * render (the audit and money capabilities say so instead).
 */
const geminiArgv = (invocation: Invocation): string[] => [
  "-p",
  invocation.brief,
  // S2 (live spike, v0.57.0): headless REFUSES untrusted directories, and
  // a freshly leased worktree is always untrusted. --skip-trust grants
  // this run's trust — and honestly (Codex gemini verify, finding 1): the
  // CLI implements the flag by setting GEMINI_CLI_TRUST_WORKSPACE in its
  // OWN process, which descendants inherit, and trusted mode is what lets
  // gemini load a worktree's .gemini/ config (hooks, MCP). We accept that
  // because gemini is dispatched ONLY on EXPLICIT operator selection (a
  // phase-config row, a task pin, or a flag — never a default or fallback;
  // the resolver's default is always claude), so trusting the workspace is
  // the operator's own deliberate choice, not an ambient grant. A per-run
  // config-isolation boundary (isolated GEMINI_DIR) is the tracked
  // follow-up if gemini ever becomes a default. Until that lands, gemini
  // has no fail-closed equivalent of the claude/codex review isolation
  // above — `resolvePhaseAgent` (agentconfig.ts) refuses gemini for the
  // review phase outright rather than let a documented, untracked leak
  // pose as a confined reviewer.
  "--skip-trust",
  "--output-format",
  "stream-json",
  "--approval-mode",
  invocation.skipPermissions ? "yolo" : "auto_edit",
  ...(invocation.resumeSession !== null
    ? ["--resume", invocation.resumeSession]
    : invocation.startSessionId !== undefined
      ? ["--session-id", invocation.startSessionId]
      : []),
  ...(invocation.model === null ? [] : ["-m", invocation.model]),
  ...(invocation.toolArgv ?? []),
];

/** Gemini interval caps: inactivity for current profiles, wall clock for
 * repair and legacy profiles. */
const GEMINI_TIMEOUT_CAP_MS: Record<Phase, number> = {
  build: 20 * 60_000,
  plan: 20 * 60_000,
  repair: 5 * 60_000,
  review: 20 * 60_000,
};

const DIAGNOSTIC_CAP = 2 * 1024;

/**
 * Reads the gemini retention runner's synthetic stdout (Phase 3 D2/A7):
 * a bounded set of `init` identity witnesses (result events carry no id, so
 * identity is init-or-nothing), one `synthetic_message` (the runner-assembled
 * assistant text; a type the real CLI cannot emit, so fixtures and transport
 * share an unambiguous contract), the LAST `result` (tokens + structural
 * status), and the first error line (diagnostics only). No legacy branch:
 * the attestation floor is the only dialect this parser has ever had to honor.
 */
function geminiParse(stdout: string): ParsedEnvelope {
  let initSeen = false;
  let sessionId: string | null = null;
  let sessionConflict = false;
  let finalMessage: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let usageRaw: string | null = null;
  let resultStatus: string | null = null;
  let diagnostic: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const type = String(event["type"] ?? "");
    if (type === "init") {
      initSeen = true;
      const announced = sessionIdOf(event["session_id"]);
      if (announced !== null) {
        if (sessionId === null) sessionId = announced;
        else if (announced !== sessionId) sessionConflict = true;
      }
    } else if (type === "synthetic_message") {
      const content = event["content"];
      if (typeof content === "string") finalMessage = content;
    } else if (type === "result") {
      resultStatus = String(event["status"] ?? "");
      const stats = event["stats"] as Record<string, unknown> | undefined;
      const input = stats?.["input_tokens"];
      const output = stats?.["output_tokens"];
      if (typeof input === "number" && input >= 0) tokensIn = input;
      if (typeof output === "number" && output >= 0) tokensOut = output;
      if (stats !== undefined) usageRaw = JSON.stringify(stats).slice(0, USAGE_JSON_CAP);
      const resultError = event["error"] as Record<string, unknown> | undefined;
      const message = resultError?.["message"];
      if (diagnostic === null && typeof message === "string" && message !== "") {
        diagnostic = safeDiagnostic(message);
      }
    } else if (type === "error") {
      const message = event["message"];
      if (diagnostic === null && String(event["severity"] ?? "") === "error" && typeof message === "string" && message !== "") {
        diagnostic = safeDiagnostic(message);
      }
    }
  }
  return {
    // A plane-minted id is useful only while the provider tells one
    // consistent story about it. Never select either side of contradictory
    // init events; the gateway records usage and refuses the turn.
    sessionId: sessionConflict ? null : sessionId,
    protocolError: sessionConflict ? "Gemini emitted conflicting init session ids" : null,
    finalMessage,
    tokensIn,
    tokensOut,
    // Gemini reports tokens, never dollars. NULL is the honest cost.
    costUsd: null,
    usageRaw,
    initObserved: initSeen,
    // Structural, never prose: consumed means the terminal result said
    // SUCCESS. Missing or error results prove nothing about delivery —
    // and for this provider the gateway's terminal contract REQUIRES the
    // proof before exit 0 is believed (Phase 3 A4).
    promptConsumed: resultStatus === "success",
    diagnostic,
    // A structural failure terminal ONLY when an ACTUAL non-success RESULT
    // was seen (Codex foundation review, finding 2): a MISSING result
    // (resultStatus null) is not evidence of anything — never fabricate a
    // failure terminal from its absence (terminalContract already handles
    // the exit-0-without-success case as protocol, not exhaustion).
    structuralTerminal:
      resultStatus === null || resultStatus === "success"
        ? null
        : { failed: true, text: diagnostic, code: String(resultStatus).slice(0, 128) },
  };
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
function capUtf8(text: string, bytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  // The ellipsis lives INSIDE the byte budget, not on top of it.
  const buffer = Buffer.from(text, "utf8").subarray(0, Math.max(0, bytes - 3));
  return buffer.toString("utf8").replace(/�+$/, "") + "…";
}

/**
 * The diagnostic discipline (Phase 3 B6/C6): the harness's own words are
 * untrusted bytes headed for refusal screens and notifications — controls
 * and line separators collapse to spaces (the fence's character class),
 * and a line that trips the secret scanner is REPLACED, never quoted.
 */
export function safeDiagnostic(text: string): string | null {
  const normalized = text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").trim();
  if (normalized === "") return null;
  if (scanForSecrets(normalized).length > 0) return "the harness's error text was withheld — it matched a secret pattern";
  return capUtf8(normalized, DIAGNOSTIC_CAP);
}

/** Every provider credential the plane knows about, by owner. A spawned
 * provider gets its OWN keys and nobody else's: S4 (live spike) confirmed
 * what inheritance makes true by construction — an agent's shell reads its
 * process env, so a foreign key in that env is a foreign key disclosed. */
const CREDENTIAL_ENV: Record<ProviderId, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  openrouter: [OPENROUTER_ENV_KEY],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};
const foreignCredentialEnv = (own: ProviderId): string[] =>
  (Object.entries(CREDENTIAL_ENV) as [ProviderId, readonly string[]][])
    .filter(([provider]) => provider !== own)
    .flatMap(([, keys]) => [...keys]);

/** EVERY provider credential — what a version/help/which PROBE strips,
 * since a feature check needs no key at all (Codex gemini verify,
 * finding 2). Agent spawns keep their own; probes keep none. */
export const ALL_CREDENTIAL_ENV: readonly string[] = Object.values(CREDENTIAL_ENV).flat();

const ADAPTERS: Record<ProviderId, Adapter> = {
  claude: {
    binary: "claude",
    argv: claudeArgv,
    parse: claudeParse,
    defaultRunner: runClaudeStreamJsonl,
    extraOmitEnv: foreignCredentialEnv("claude"),
    clampTimeout: (_phase, requested) => requested,
  },
  codex: {
    binary: "codex",
    argv: codexArgv([]),
    stdin: invocation => invocation.phase === "review" ? invocation.brief : undefined,
    parse: codexParse,
    defaultRunner: runStreamJsonl,
    extraOmitEnv: foreignCredentialEnv("codex"),
    clampTimeout: (phase, requested) => Math.min(requested, CODEX_TIMEOUT_CAP_MS[phase]),
  },
  openrouter: {
    binary: "codex",
    stdin: invocation => invocation.phase === "review" ? invocation.brief : undefined,
    argv: codexArgv([
      "-c",
      `model_provider=${toml(OPENROUTER_PROVIDER_KEY)}`,
      "-c",
      `model_providers.${OPENROUTER_PROVIDER_KEY}.name=${toml("OpenRouter")}`,
      "-c",
      `model_providers.${OPENROUTER_PROVIDER_KEY}.base_url=${toml(OPENROUTER_BASE_URL)}`,
      "-c",
      `model_providers.${OPENROUTER_PROVIDER_KEY}.env_key=${toml(OPENROUTER_ENV_KEY)}`,
      // Asks Codex to keep the key out of the agent's shells. codex-cli
      // 0.156 ignores shell_environment_policy, so the key IS readable from
      // the agent's shell in practice; kept for Codex builds that honour it.
      // What does hold is the agent fence: nothing else of Toolroll's
      // (other keys, logins, tokens, the database) is reachable.
      "-c",
      `shell_environment_policy.exclude=[${toml(OPENROUTER_ENV_KEY)}]`,
    ]),
    parse: codexParse,
    defaultRunner: runStreamJsonl,
    extraOmitEnv: foreignCredentialEnv("openrouter"),
    clampTimeout: (phase, requested) => Math.min(requested, CODEX_TIMEOUT_CAP_MS[phase]),
  },
  gemini: {
    binary: "gemini",
    argv: geminiArgv,
    parse: geminiParse,
    defaultRunner: runGeminiStreamJsonl,
    extraOmitEnv: foreignCredentialEnv("gemini"),
    clampTimeout: (phase, requested) => Math.min(requested, GEMINI_TIMEOUT_CAP_MS[phase]),
  },
};

/**
 * The spawning surface. Imported by invoke.ts and NOWHERE else — the
 * architecture test reads imports, not string literals, because provider
 * ids and binary names are legitimately the same words elsewhere.
 */
export function adapterFor(provider: ProviderId): Adapter {
  return ADAPTERS[provider];
}

/**
 * The provider audit: what each harness supports, what we actually pass,
 * and what user-global configuration can leak into an unattended run.
 * REPORT BEFORE ENFORCEMENT (Codex roadmap review, item 10): none of this
 * changes an invocation — it states facts an operator reads on `providers`,
 * so hermetic mode can later be turned on per provider from evidence
 * instead of hope. `enforced` is a literal false until that day.
 */
export type ProviderAudit = {
  /** How output reaches us — and therefore which signals can exist at all. */
  transport: "buffered-json" | "streaming-jsonl";
  /** Whether a later invocation can resume this provider's session. */
  resume: "native" | "none";
  /** The event whose absence on a failed run means "never initialized".
   * CAPABILITY metadata, not a per-run observation (arc 1 finding 16):
   * whether a given run actually saw it lives in ParsedEnvelope.initObserved. */
  initSignal: "thread.started" | "system-init" | "init-event" | "none";
  /** How session identity is established: "announced" = read back from the
   * harness's own stream; "minted" = the PLANE chooses the id pre-spawn
   * (gemini --session-id) and the envelope must echo it (Phase 3 A5). */
  sessionIdentity: "announced" | "minted";
  /**
   * Whether exit 0 is believed on its own (Phase 3 A4). "required" =
   * the transport carries a structural terminal signal and the gateway
   * accepts a zero exit ONLY with init observed AND promptConsumed true —
   * a missing, truncated, or error-status terminal is a provider-protocol
   * failure BEFORE handoff ingestion. "none" = today's exit-code
   * discipline, byte-identical for tier-1 providers.
   */
  terminalContract: "required" | "none";
  isolation: {
    /** The harness's hermetic flag, if it has one. We do not pass it. */
    flag: string | null;
    /** Whether that flag preserves resume. false = documented conflict. */
    resumeSafe: boolean | null;
    enforced: false;
  };
  /** User-global surfaces that can reach an invocation today. */
  configSurface: readonly string[];
};

const AUDITS: Record<ProviderId, ProviderAudit> = {
  claude: {
    transport: "streaming-jsonl",
    resume: "native",
    initSignal: "system-init",
    sessionIdentity: "announced",
    terminalContract: "none",
    // Restricted mode is resume-safe and is enforced for sealed reviewer
    // turns. `enforced` remains false here because this provider-wide audit
    // also covers ordinary build turns, where the flag is not applied.
    isolation: { flag: "--restricted", resumeSafe: true, enforced: false },
    configSurface: [
      "~/.claude/CLAUDE.md and settings (hooks, MCP servers, plugins)",
      "repository CLAUDE.md / .claude directory",
    ],
  },
  codex: {
    transport: "streaming-jsonl",
    resume: "native",
    initSignal: "thread.started",
    sessionIdentity: "announced",
    terminalContract: "none",
    // --ephemeral exists and is deliberately not passed: repair resumes
    // sessions, and ephemeral runs have none to resume.
    isolation: { flag: "--ephemeral", resumeSafe: false, enforced: false },
    configSurface: ["~/.codex/config.toml", "repository AGENTS.md"],
  },
  openrouter: {
    transport: "streaming-jsonl",
    resume: "native",
    initSignal: "thread.started",
    sessionIdentity: "announced",
    terminalContract: "none",
    isolation: { flag: "--ephemeral", resumeSafe: false, enforced: false },
    // The constant -c overrides pin the model provider per invocation, so
    // user config cannot reroute the spend — but the file still loads.
    configSurface: ["~/.codex/config.toml (model_provider pinned per invocation)", "repository AGENTS.md"],
  },
  gemini: {
    transport: "streaming-jsonl",
    // S1 (live spike 2026-08-29, v0.57.0) PROVED headless persistence AND
    // resume-by-uuid in the same cwd — the flip from "none" is the
    // re-attestation the comment always demanded, now earned. Repair
    // resumes the session instead of paying for a fresh one; geminiArgv
    // must mint OR resume, never both (see the repair caller).
    resume: "native",
    initSignal: "init-event",
    sessionIdentity: "minted",
    terminalContract: "required",
    isolation: { flag: "--sandbox", resumeSafe: null, enforced: false },
    configSurface: [
      "~/.gemini/settings.json (HOOKS — BeforeAgent/AfterTool commands run inside every invocation — plus MCP servers and model settings)",
      "project .gemini/settings.json",
      "GEMINI.md (global and repository)",
      "extensions, skills, and policy files",
      "GEMINI_API_KEY / GOOGLE_GENAI_USE_* environment (an API key in env is visible to the gemini agent's own shells — S4; every OTHER provider's spawn now sheds it, and cached login remains the tighter posture)",
      "trusted-folder store (S2, live at 0.57.0: headless REFUSES untrusted directories; the plane grants --skip-trust per-invocation to its own leased worktrees)",
    ],
  },
};

/** Read-only facts about a provider — safe anywhere, spawns nothing. */

/**
 * The money capability matrix (design v3 finding 14): what each harness
 * can PROVE about money, stated as data. Codex and OpenRouter report
 * billable usage only at turn end (cumulative across resumed sessions),
 * so no mid-run cap exists to hold.
 */
export type ProviderMoneyCapabilities = {
  /** Usage events arrive during the run, not only at the end. */
  incrementalUsage: boolean;
  /** The harness's own dollar-cap flag, when one exists. */
  nativeDollarCapFlag: string | null;
  usageSemantics: "per-invocation" | "cumulative-session";
};

export const MONEY_CAPABILITIES: Record<ProviderId, ProviderMoneyCapabilities> = {
  claude: {
    incrementalUsage: true,
    nativeDollarCapFlag: "--max-budget-usd",
    usageSemantics: "per-invocation",
  },
  codex: {
    incrementalUsage: false,
    nativeDollarCapFlag: null,
    usageSemantics: "cumulative-session",
  },
  openrouter: {
    incrementalUsage: false,
    nativeDollarCapFlag: null,
    usageSemantics: "cumulative-session",
  },
  gemini: {
    incrementalUsage: false,
    nativeDollarCapFlag: null,
    // Stats come from a per-process telemetry service: an invocation's
    // numbers cover that invocation only (conformance fixture j).
    usageSemantics: "per-invocation",
  },
};

/**
 * The fail-closed budget-flag probe (finding 24's amendment): resolve
 * the EXACT executable that will spawn, read its version, and prove the
 * flag exists in that binary's own help — presence is a feature check
 * and nothing more.
 */
export async function probeBudgetCap(
  provider: ProviderId,
  runner: (command: string, argv: readonly string[], options: { timeoutMs?: number; omitEnv?: readonly string[] }) => Promise<ExecResult>,
): Promise<{ ok: true; executable: string; version: string } | { ok: false; problem: string }> {
  const flag = MONEY_CAPABILITIES[provider].nativeDollarCapFlag;
  if (flag === null) return { ok: false, problem: `${provider} has no native dollar cap` };
  const binary = provider === "claude" ? "claude" : provider;
  // A feature probe needs no credential (round 2, finding 2): strip them all.
  const strip = { omitEnv: ALL_CREDENTIAL_ENV } as const;
  const where = await runner("which", [binary], { timeoutMs: 5_000, ...strip });
  if (where.code !== 0) return { ok: false, problem: `${binary} is not on PATH` };
  const executable = where.stdout.trim().split("\n")[0] ?? "";
  const version = await runner(executable, ["--version"], { timeoutMs: 10_000, ...strip });
  if (version.code !== 0) return { ok: false, problem: `${executable} did not answer --version` };
  const help = await runner(executable, ["--help"], { timeoutMs: 10_000, ...strip });
  if (help.code !== 0 || !help.stdout.includes(flag)) {
    return { ok: false, problem: `${executable} does not advertise ${flag} — the dollar cap cannot be enforced` };
  }
  return { ok: true, executable, version: version.stdout.trim() };
}

export function auditOf(provider: ProviderId): ProviderAudit {
  return AUDITS[provider];
}

/**
 * A spec a person or a config row proposed, validated to a complete pair.
 * openrouter REQUIRES a model: there is no meaningful harness default
 * across a 300-model catalog.
 */
export function validateSpec(spec: AgentSpec): { ok: true } | { ok: false; problem: string } {
  // A refusal names the field, never the value: a pasted credential must not travel on in a problem.
  const parsed = agentSpecSchema.safeParse({ provider: spec.provider, model: spec.model === null ? null : String(spec.model) });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "provider") return { ok: false, problem: `provider: unknown provider — one of ${PROVIDER_IDS.join(", ")}` };
    return { ok: false, problem: "model: a model id is 1–128 characters of letters, digits, and . _ : / - (never leading with a dash)" };
  }
  if (spec.provider === "openrouter" && spec.model === null) {
    return { ok: false, problem: "model: openrouter needs an explicit model — there is no default across its catalog" };
  }
  if (spec.provider === "gemini" && spec.model === null) {
    return { ok: false, problem: "model: gemini needs an explicit model — the harness default drifts with its releases" };
  }
  return { ok: true };
}

/**
 * Whether this provider reports dollar cost. A schedule's weekly limit interacts:
 * a ceiling against an unmeasured provider fails closed by design, so the
 * approval surfaces refuse the combination outright.
 */
export function reportsCost(provider: ProviderId): boolean {
  return provider === "claude";
}

/** The non-spending inspection surface: what `toolroll providers` reports. */
export type ProviderInspection = {
  id: ProviderId;
  binary: string;
  /** argv of a CHEAP identity probe, or null when none exists without spend. */
  identityProbe: readonly string[] | null;
  /** Env var whose PRESENCE matters (never its value). */
  requiresEnv: string | null;
  measuresCost: boolean;
};

export function inspectionOf(provider: ProviderId): ProviderInspection {
  const adapter = ADAPTERS[provider];
  return {
    id: provider,
    binary: adapter.binary,
    identityProbe:
      provider === "codex" || provider === "openrouter" ? ["login", "status"] : null,
    requiresEnv: provider === "openrouter" ? OPENROUTER_ENV_KEY : null,
    measuresCost: reportsCost(provider),
  };
}
