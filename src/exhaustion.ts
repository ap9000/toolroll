/**
 * How a finished attempt ended, classified where the evidence still exists
 * (the provider adapter's structural terminal record), never in disposal.
 * The one class that changes what happens next is `auth-expired`: a sign-in
 * or API key that no longer works pauses dispatch for that provider until
 * someone signs in, instead of burning attempts. Everything else is the
 * ordinary failure road.
 *
 * `usage-exhausted`, `credits-depleted` and `transient-throttle` are only
 * ever read from older runs' records (they were stamped by a removed
 * feature); this build never produces them.
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
 * any provider or version; then a structural failure terminal is
 * `not-exhausted`, and anything else `unknown`. */
export function classifyTerminal(args: {
  terminal: StructuralTerminal | null;
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
  return "not-exhausted";
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
