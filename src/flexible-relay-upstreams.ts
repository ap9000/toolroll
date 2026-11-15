/**
 * The model services a Flexible thread's sign-in relay (flexible-relay.ts, slice F2b) may forward to, as data: where a
 * call goes, which routes it may take, how Toolroll's own credential is presented, which request headers pass, how the
 * answer's usage is read, which models and how much. Adding another service (Codex/OpenAI, Gemini, OpenRouter) is
 * another entry here plus its usage reader; nothing else in the relay changes. Only Claude is listed in this slice.
 *
 * A compile-time constant, never a setting: no environment variable, config key, database row, flag or argument reads
 * or changes it, and nothing exports a way to. Tests reach a scripted stand-in only by replacing this module with
 * vi.mock; src/flexible-disabled.test.ts pins the production origin and keeps this module plain data imported by name.
 */

/** How Toolroll's stored credential for a service is presented upstream, by the credential's kind. */
export type RelayCredentialKind = "api-key" | "setup-token";
export type RelayUpstream = {
  /** The service's own origin, exactly: the only place a call is ever sent. Never followed elsewhere (no redirects). */
  origin: string;
  /** The request paths a call may take, exactly, with the only query strings each may carry ("" is none). */
  routes: readonly { path: string; kind: "messages" | "count-tokens"; queries: readonly string[] }[];
  /** How each kind of stored credential is sent: its header, the text before it, the betas that kind needs, and how
   * turns on it are billed. The value's own shape is checked before it is ever sent. */
  auth: Readonly<Record<RelayCredentialKind, { header: string; prefix: string; betas: readonly string[]; billing: "api-key" | "subscription"; shape: RegExp }>>;
  /** Request headers an agent's call may carry upstream (lowercase), each with the shape its value must have. Every
   * other header is dropped, and the ones in `refused` refuse the call. */
  passHeaders: Readonly<Record<string, RegExp>>;
  /** Headers that select or carry a credential, or override the service's behaviour: a call that sends one (beyond the
   * relay token itself) is refused, never forwarded. */
  refused: RegExp;
  /** `anthropic-beta` values an agent may ask for; any other refuses the call. None of them selects a credential. */
  betas: readonly string[];
  /** Body fields that would have the service itself reach the network or run code for the agent (server tools, MCP
   * connectors, containers): outside the thread's proxy, so refused. Tool types a call may name (no type: the agent's
   * own client tools). */
  refusedFields: readonly string[];
  clientToolTypes: readonly string[];
  /** Content blocks a call may carry (in system, messages and nested tool results), each with the only `source` types
   * it may have: inline data only. A block or source not listed (a URL, a stored file id, a server tool's result)
   * would have the service fetch something itself, outside the thread's proxy, so it refuses the call. */
  contentBlocks: Readonly<Record<string, readonly string[]>>;
  /** Models a call may name: the turn's own model, or a helper model the agent uses for small background requests. */
  models: RegExp;
  helperModels: RegExp;
  /** How the answer's usage is read (flexible-relay.ts USAGE_READERS). */
  usage: "anthropic-messages";
  /** Per call: the largest body read, the largest `max_tokens`; per thread: calls at once. */
  limits: { maxBodyBytes: number; maxTokens: number; concurrency: number };
};

/** Every service the relay knows, by the agent it serves. */
export const FLEXIBLE_RELAY_UPSTREAMS: Readonly<{ claude: RelayUpstream }> = Object.freeze({
  claude: Object.freeze({
    origin: "https://api.anthropic.com",
    routes: Object.freeze([
      Object.freeze({ path: "/v1/messages", kind: "messages", queries: Object.freeze(["", "beta=true"]) }),
      Object.freeze({ path: "/v1/messages/count_tokens", kind: "count-tokens", queries: Object.freeze(["", "beta=true"]) }),
    ]),
    auth: Object.freeze({
      // `claude setup-token`: the person's plan, as Claude Code itself signs in with it.
      "setup-token": Object.freeze({ header: "authorization", prefix: "Bearer ", betas: Object.freeze(["oauth-2025-04-20"]), billing: "subscription", shape: /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,400}$/ }),
      "api-key": Object.freeze({ header: "x-api-key", prefix: "", betas: Object.freeze([]), billing: "api-key", shape: /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,400}$/ }),
    }),
    passHeaders: Object.freeze({
      "content-type": /^application\/json(?:;\s*charset=utf-8)?$/i,
      accept: /^[A-Za-z0-9*/+.;=, -]{1,200}$/,
      "anthropic-version": /^\d{4}-\d{2}-\d{2}$/,
      "anthropic-beta": /^[a-z0-9-]{1,80}(?:\s*,\s*[a-z0-9-]{1,80}){0,30}$/,
      "user-agent": /^[\x20-\x7e]{1,200}$/,
      "x-app": /^[a-z0-9-]{1,40}$/,
    }),
    refused: /^(?:x-api-key|authorization|proxy-authorization|cookie|anthropic-(?!version$|beta$).+|x-goog-api-key|.*api[-_]?key.*|.*auth[-_]?token.*)$/,
    betas: Object.freeze([
      "claude-code-20250219", "interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14", "context-management-2025-06-27",
      "context-1m-2025-08-07", "prompt-caching-2024-07-31", "token-counting-2024-11-01", "effort-2025-11-24", "tool-examples-2025-10-29",
    ]),
    refusedFields: Object.freeze(["mcp_servers", "container"]),
    clientToolTypes: Object.freeze(["custom"]),
    contentBlocks: Object.freeze({
      text: Object.freeze([]), image: Object.freeze(["base64"]), document: Object.freeze(["base64", "text", "content"]),
      tool_use: Object.freeze([]), tool_result: Object.freeze([]), thinking: Object.freeze([]), redacted_thinking: Object.freeze([]),
    }),
    models: /^claude-(?:opus|sonnet|haiku|fable)-\d{1,2}(?:-\d{1,2})?(?:-\d{8})?$/,
    helperModels: /^claude-haiku-\d{1,2}(?:-\d{1,2})?(?:-\d{8})?$/,
    usage: "anthropic-messages",
    limits: Object.freeze({ maxBodyBytes: 32 * 1024 * 1024, maxTokens: 128_000, concurrency: 6 }),
  }),
});
