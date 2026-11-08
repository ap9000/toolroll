/**
 * How a finished attempt ended, classified where the evidence still exists
 * (the provider adapter's structural terminal record), never in disposal.
 * The one class that changes what happens next is `auth-expired`: a sign-in
 * or API key that no longer works pauses dispatch for that provider until
 * someone signs in, instead of burning attempts. Everything else is the
 * ordinary failure road.
 *
 * `usage-exhausted` moves the work to the next agent a person approved
 * (fallback.ts), so it comes only from a recogniser below, and a recogniser
 * comes only from a real run (docs/plans/fallback-chains.md). A provider with
 * none never reads as exhausted. `credits-depleted` and `transient-throttle`
 * are only ever read from older runs' records.
 */

export type TerminalClass =
  | "usage-exhausted"
  | "credits-depleted"
  | "transient-throttle"
  /** The provider's sign-in or API key no longer works — no retry:
   * dispatch for that provider pauses until someone signs in. */
  | "auth-expired"
  /** A definite structural failure terminal (ordinary failure). */
  | "not-exhausted"
  /** No structural signal — the ordinary failure/strike road. */
  | "unknown";

/**
 * The structural terminal a provider's parser retained. `failed` marks a
 * structural FAILURE terminal (codex turn.failed, a gemini error terminal):
 * its presence blocks success ingestion regardless of exit code. `text` is
 * the bounded terminal message; `code` its machine code if the harness
 * typed one.
 */
export type StructuralTerminal = {
  failed: boolean;
  text: string | null;
  code: string | null;
};

/** Classify a finished attempt: a sign-in that no longer works first, for
 * any provider or version; then a recognised plan limit, on the exact provider,
 * auth mode and CLI line it was seen on; then a structural failure terminal is
 * `not-exhausted`, and anything else `unknown`. */
export function classifyTerminal(args: {
  terminal: StructuralTerminal | null;
  /** The run's own provider, its auth mode, and the version the installed CLI reports to the gateway: never the checkout's word. */
  run?: { provider: string; authMode: string; version: string | null };
  /** What a run that failed within seconds, having produced nothing, said
   * on its way out (stderr and unstructured stdout) — read ONLY for the
   * sign-in signal: a CLI that is not logged in often exits before its
   * structured stream begins. */
  earlyExit?: string | null;
}): TerminalClass {
  const { terminal } = args;
  if (terminal !== null && terminal.failed === true && isAuthFailure(`${terminal.code ?? ""}\n${terminal.text ?? ""}`)) return "auth-expired";
  if (typeof args.earlyExit === "string" && isAuthFailure(args.earlyExit)) return "auth-expired";
  if (terminal === null || terminal.failed !== true) return "unknown";
  if (args.run !== undefined && terminal.text !== null && planLimitReached(args.run, terminal.text)) return "usage-exhausted";
  return "not-exhausted";
}

/**
 * The recognisers: every entry needs a real run behind it, with its fixture under test/fixtures/fallback. Nothing adds
 * one at runtime; a new one is a reviewed source edit, because it can move work and spend money.
 *
 * Claude, subscription. Six real builder runs on 2.1.290 ended with this structural failure result; two of them
 * mid-task. Claude Code's published errors page names the family: session, weekly, Opus and Sonnet limits, each
 * "· resets <time>". The whole terminal must match, so a build's own output quoting these words does not, and neither
 * does the spend-cap family ("your monthly spend limit") or a throttle. Wording that changes misses and fails closed.
 */
type Recogniser = {
  provider: string;
  authMode: string;
  /** Seen on this CLI version; recognised up to, not including, `below`. */
  from: readonly [number, number, number];
  below: readonly [number, number, number];
  terminal: RegExp;
};
const RECOGNISERS: readonly Recogniser[] = Object.freeze([
  {
    provider: "claude", authMode: "subscription", from: [2, 1, 290], below: [2, 2, 0],
    terminal: /^You've hit your (?:session|weekly|Opus|Sonnet) limit · resets [^\n]{1,64}$/,
  },
]);

function versionOf(version: string | null): readonly [number, number, number] | null {
  const parts = version === null ? null : /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:\s|$)/.exec(version);
  return parts === null ? null : [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

function before(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  for (let at = 0; at < 3; at++) if (a[at] !== b[at]) return a[at]! < b[at]!;
  return false;
}

function planLimitReached(run: { provider: string; authMode: string; version: string | null }, text: string): boolean {
  const version = versionOf(run.version);
  if (version === null) return false;
  const words = text.trim();
  return RECOGNISERS.some(one => one.provider === run.provider && one.authMode === run.authMode
    && !before(version, one.from) && before(version, one.below) && one.terminal.test(words));
}

/** Whether a terminal reads as a limit for this provider and auth mode, before its CLI version is asked. */
export function terminalMatchesLimit(provider: string, authMode: string, terminal: StructuralTerminal | null): boolean {
  if (terminal === null || terminal.failed !== true || terminal.text === null) return false;
  const words = terminal.text.trim();
  return RECOGNISERS.some(one => one.provider === provider && one.authMode === authMode && one.terminal.test(words));
}

/** Whether Toolroll can recognise this agent running out at all: the words every surface shows beside an entry. */
export function limitRecognised(provider: string, authMode: string): boolean {
  return RECOGNISERS.some(one => one.provider === provider && one.authMode === authMode);
}

/**
 * The sign-in signals, provider-neutral: Claude's expired or unrefreshable
 * OAuth session and its "Please run /login", an API key the provider calls
 * invalid or revoked, Codex's and Gemini's "not logged in", and an HTTP 401
 * the harness reports as its terminal. Ordinary failures (a test that
 * failed, a timeout, a usage limit) match none of these.
 */
const AUTH_FAILURE: readonly RegExp[] = [
  // Provider-specific phrasings only: a build's own output (a login feature's
  // tests, an HTTP 401 in a log) must never read as the agent's sign-in.
  /\bOAuth (?:session|token)\b[^\n]{0,80}\b(?:expired|could not be refreshed|revoked|invalid)/i,
  /\bFailed to authenticate\b[^\n]{0,40}\b(?:OAuth|token|session|credentials|API key)/i,
  /\bPlease run \/login\b/i,
  /\binvalid[ _-](?:x-)?api[ _-]?key\b/i,
  /\binvalid bearer token\b/i,
  /\bapi[ _-]?key\b[^\n]{0,40}\b(?:is )?(?:invalid|revoked|expired|not valid)\b/i,
  /"type"\s*:\s*"authentication_error"/i,
  /\bMissing bearer (?:or basic )?authentication\b/i,
  /^Not logged in\b/m,
];

/** Whether a provider's own words say its sign-in or key no longer works. */
export function isAuthFailure(text: string): boolean {
  const bounded = text.slice(0, 8192);
  return AUTH_FAILURE.some(re => re.test(bounded));
}
