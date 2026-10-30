/**
 * The release tool's one way through a short network failure on the way to GitHub (git or gh): a read that failed for a
 * transient reason — a connection refused or reset, a name that didn't resolve, a time limit, a 5xx, a truncated or
 * unparseable answer, GitHub's secondary rate limit — is asked again with backoff for up to about three minutes, then
 * fails with its original error. A definitive answer (404, 401/403, bad credentials, a missing program) is never asked
 * again. Nothing here ever turns "couldn't read" into an answer: the caller still sees the failure and fails closed.
 *
 * Only a read is retried blindly. A call that changes something (a merge, a tag, a branch push, a release, a tap
 * change) goes through `writeWithRecheck`: after a transient failure it re-reads GitHub to learn whether the write
 * happened, and asks again only when it provably didn't.
 */
import type { Exec } from "./release-adapters.js";

export type ExecResult = { code: number; stdout: string; stderr: string };

/** How long one call may keep asking, and how far apart. */
export const NET_RETRY_BUDGET_MS = 180_000;
export const NET_RETRY_MAX_ATTEMPTS = 12;
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const netBackoff = (retry: number): number => BACKOFF_MS[Math.min(retry, BACKOFF_MS.length - 1)]!;

export type RetryOptions = {
  say: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  budgetMs?: number;
  maxAttempts?: number;
};

/** Secondary rate limit or 429: transient, and GitHub may say how long to wait. */
const RATE_LIMITED = /secondary rate limit|abuse detection|HTTP 429|Too Many Requests/i;
/** A definitive answer: GitHub (or git) answered, and the answer is no. Checked before the transient phrases. */
const DEFINITIVE = /Not Found|Unauthorized|Forbidden|Bad Request|Bad credentials|Requires authentication|authentication required|Authentication failed|Permission denied|Repository not found|Resource not accessible|Must have admin rights|could not read Username|not protected|not enabled|Reference already exists|Validation Failed|Head branch was modified|not mergeable|API rate limit exceeded|GH00[136]|protected branch update failed|\[rejected\]|updates were rejected|stale info|required status check|repository rule violations/i;
/** Transport failures and server-side trouble: nothing was answered yet. */
const TRANSIENT = new RegExp([
  "error connecting to", "Could not resolve host", "no such host", "Temporary failure in name resolution", "nodename nor servname",
  "Connection refused", "Connection reset", "connection reset by peer", "Failed to connect to", "Couldn't connect to server", "Network is unreachable", "No route to host",
  "Recv failure", "Send failure", "TLS handshake timeout", "SSL_ERROR_SYSCALL", "SSL_read", "gnutls_handshake", "Operation timed out", "Connection timed out", "i/o timeout",
  "timeout awaiting", "context deadline exceeded", "Client\\.Timeout", "unexpected EOF", "early EOF", "The remote end hung up unexpectedly", "RPC failed", "broken pipe",
  "unexpected end of JSON input", "invalid character .{1,12} looking for beginning of value", "Unexpected end of JSON input",
  "HTTP 5\\d\\d", "returned error: 5\\d\\d", "\\b50[0234] (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)", "Server Error", "Bad Gateway", "Service Unavailable", "Gateway Timeout",
].join("|"), "i");

/**
 * Whether a failure (its words, and the exit code when it came from a program) is transient: the phrase worth saying,
 * and how long GitHub asked to wait (Retry-After) when it said. Null for a definitive answer or anything unknown —
 * an unknown failure is never retried.
 */
export function transientFailure(text: string, code?: number): { words: string; retryAfterMs: number | null } | null {
  if (code === 127) return null;
  if (DEFINITIVE.test(text)) return null;
  const limited = RATE_LIMITED.exec(text);
  // A rate-limit hint never overrides an independent refusal. Only 403/429 may
  // describe a secondary limit; git prints HTTP errors differently from gh.
  const statuses = [...text.matchAll(/(?:HTTP(?:\/[\d.]+)?\s+|returned error:\s*)(4\d\d)\b/gi)].map(match => Number(match[1]));
  if (statuses.some(status => limited === null || (status !== 403 && status !== 429))) return null;
  if (limited !== null) {
    const after = /Retry-After:\s*(\d{1,4})/i.exec(text) ?? /(?:try again|retry) in (\d{1,4}) ?s(?:econds?)?/i.exec(text);
    return { words: limited[0], retryAfterMs: after === null ? null : Number(after[1]) * 1000 };
  }
  const found = TRANSIENT.exec(text);
  // The phrase and the rest of its line ("Could not resolve host: github.com"), kept short.
  if (found !== null) return { words: text.slice(found.index).split("\n")[0]!.trim().slice(0, 80), retryAfterMs: null };
  // The coordinator's own time limit on the child (exec answers 124 when it killed it).
  if (code === 124) return { words: "the call timed out", retryAfterMs: null };
  return null;
}

const failureText = (result: ExecResult) => `${result.stderr}\n${result.stdout}`;

/** Whether one exec result failed transiently (exit 0 never did, unless its answer doesn't parse; see readOnlyCall). */
export function transientResult(result: ExecResult): ReturnType<typeof transientFailure> {
  return result.code === 0 ? null : transientFailure(failureText(result), result.code);
}

/** The git subcommand among the arguments: the first that isn't an option or an option's value. */
function gitSubcommand(args: readonly string[]): string | null {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "-c" || arg === "-C") { at++; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * Whether a call only reads (and so may be asked again blindly): `git ls-remote` and `git fetch` (which only moves the
 * coordinator's own remote-tracking refs); REST repository `gh api` reads with only the flags below (gh turns
 * fields or input into a POST); `gh pr list|view|checks`, `gh release view`, `gh repo view`. Anything else is a write, or
 * unknown, and is never retried by `retryingExec`.
 */
export function readOnlyCall(command: string, args: readonly string[]): { kind: "git" | "gh-api" | "gh"; jsonBody: boolean } | null {
  const name = command.split("/").pop() ?? command;
  if (name === "git") {
    const sub = gitSubcommand(args);
    return sub === "ls-remote" || sub === "fetch" ? { kind: "git", jsonBody: false } : null;
  }
  if (name !== "gh") return null;
  if (args[0] === "api") {
    let endpoint: string | null = null, shaped = false;
    for (let at = 1; at < args.length; at++) {
      const arg = args[at]!;
      // Parse only spellings we know. In particular, pflag accepts -iXPOST and -ifbody=...;
      // a blacklist of tokens beginning with -X/-f cannot prove those calls read-only.
      if (arg === "--paginate" || arg === "--slurp") { shaped = true; continue; }
      const flag = /^(--(?:method|hostname|jq|template))(?:=(.*))?$/.exec(arg) ?? /^(-[Xqt])(.*)$/.exec(arg);
      if (flag !== null) {
        const value = flag[2] || args[++at];
        if (value === undefined || value.startsWith("-")) return null;
        if (flag[1] === "-X" || flag[1] === "--method") { if (value !== "GET") return null; }
        else if (flag[1] !== "--hostname") shaped = true;
        continue;
      }
      if (arg.startsWith("-") || endpoint !== null || !/^\/?repos\/[^\s]+$/.test(arg)) return null;
      endpoint = arg;
    }
    return endpoint === null ? null : { kind: "gh-api", jsonBody: !shaped };
  }
  const pair = `${args[0] ?? ""} ${args[1] ?? ""}`;
  if (!["pr list", "pr view", "pr checks", "release view", "repo view"].includes(pair)) return null;
  const shaped = args.some(arg => arg === "--jq" || arg === "-q" || arg === "--template" || arg === "-t" || /^--(?:jq|template)=/.test(arg));
  return { kind: "gh", jsonBody: !shaped && args.some(arg => arg === "--json" || arg.startsWith("--json=")) };
}

/** A short name for a call, said once when it is asked again: `gh api repos/…/check-runs`, `git ls-remote`. */
export function callLabel(command: string, args: readonly string[]): string {
  const name = command.split("/").pop() ?? command;
  if (name === "git") return `git ${gitSubcommand(args) ?? ""}`.trim();
  if (args[0] === "api") {
    const path = args.find(one => one.startsWith("repos/")) ?? args.find((one, at) => at > 0 && !one.startsWith("-")) ?? "";
    return `gh api ${path.split("?")[0]!.replace(/[0-9a-f]{40}/g, sha => sha.slice(0, 7))}`.trim();
  }
  return `gh ${args.slice(0, 2).join(" ")}`;
}

/**
 * An Exec that asks a read again after a transient failure, with backoff, for up to `budgetMs` (about three minutes)
 * and `maxAttempts` calls; it says why once per call. When the budget runs out it answers the FIRST failure, exactly as
 * the program gave it, so the caller stops with the original error. A definitive answer or a success is returned at
 * once. A call that isn't provably a read (readOnlyCall) is passed straight through, never retried.
 */
export function retryingExec(run: Exec, options: RetryOptions): Exec {
  return async (command, args, execOptions) => {
    const read = readOnlyCall(command, args);
    if (read === null) return run(command, args, execOptions);
    return retryCall(() => run(command, args, execOptions), callLabel(command, args), options, read.jsonBody);
  };
}

/** Whether a 0-exit plain JSON body parses; a truncated one is a transient failure. */
const bodyParses = (stdout: string): boolean => { try { JSON.parse(stdout); return true; } catch { return false; } };

/** One read, asked again as retryingExec describes. `call` may do more than the read itself (the release's Git
 * re-checks the checkout's config first); anything it throws ends the read at once. */
export async function retryCall(call: () => Promise<ExecResult>, label: string, options: RetryOptions, jsonBody = false): Promise<ExecResult> {
  const now = () => (options.now ?? (() => new Date()))().getTime();
  const deadline = now() + (options.budgetMs ?? NET_RETRY_BUDGET_MS);
  const maxAttempts = options.maxAttempts ?? NET_RETRY_MAX_ATTEMPTS;
  let first: ExecResult | null = null;
  for (let attempt = 0; ; attempt++) {
    const result = await call();
    let why = transientResult(result);
    if (why === null && result.code === 0 && jsonBody && !bodyParses(result.stdout)) why = { words: "an answer cut short", retryAfterMs: null };
    if (why === null) return result;
    // The original failure is what the caller sees; a truncated 0-exit body becomes an explicit failure.
    first ??= result.code !== 0 ? result : { code: 1, stdout: result.stdout, stderr: "unexpected end of JSON input (GitHub's answer was cut short)" };
    const wait = why.retryAfterMs ?? netBackoff(attempt);
    if (attempt + 1 >= maxAttempts || now() + wait > deadline) return first;
    if (attempt === 0) options.say(`  GitHub didn't answer ${label} (${why.words}); asking again for up to ${Math.round((options.budgetMs ?? NET_RETRY_BUDGET_MS) / 60_000)} min.`);
    await options.sleep(wait);
  }
}

/**
 * A write that may be asked again only once GitHub says it didn't happen (idempotency). `write` makes the call;
 * `accept` reads a successful answer into the value (a SyntaxError there is an answer cut short: transient);
 * `refuse` throws for a failure. After a transient failure, `recheck` reads the state (its own reads retried): `done`
 * with the value when the write happened, `not-done` when it provably didn't (only then is it asked again), and
 * anything else — or a recheck that can't read — stops with the write's original error.
 */
export async function writeWithRecheck<T>(label: string, options: RetryOptions, steps: {
  write: () => Promise<ExecResult>;
  accept: (result: ExecResult) => T;
  refuse: (result: ExecResult) => never;
  recheck: () => Promise<{ state: "done"; value: T } | { state: "not-done" } | { state: "other"; why: string }>;
}): Promise<T> {
  const now = () => (options.now ?? (() => new Date()))().getTime();
  const deadline = now() + (options.budgetMs ?? NET_RETRY_BUDGET_MS);
  const maxAttempts = options.maxAttempts ?? NET_RETRY_MAX_ATTEMPTS;
  let first: ExecResult | null = null;
  for (let attempt = 0; ; attempt++) {
    const result = await steps.write();
    let why = transientResult(result);
    if (result.code === 0) {
      try { return steps.accept(result); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        why = { words: "an answer cut short", retryAfterMs: null };
      }
    }
    if (why === null) return steps.refuse(result);
    first ??= result.code !== 0 ? result : { code: 1, stdout: result.stdout, stderr: "unexpected end of JSON input (GitHub's answer was cut short)" };
    if (attempt === 0) options.say(`  GitHub didn't answer ${label} (${why.words}); reading GitHub to learn whether it happened.`);
    let state: Awaited<ReturnType<typeof steps.recheck>>;
    try { state = await steps.recheck(); }
    catch (error) { return steps.refuse({ ...first, stderr: `${first.stderr.trim()} (and whether it happened couldn't be read: ${String((error as Error)?.message ?? error).slice(0, 200)})` }); }
    if (state.state === "done") return state.value;
    if (state.state === "other") return steps.refuse({ ...first, stderr: `${first.stderr.trim()} (${state.why})` });
    const wait = why.retryAfterMs ?? netBackoff(attempt);
    if (attempt + 1 >= maxAttempts || now() + wait > deadline) return steps.refuse(first);
    await options.sleep(wait);
  }
}
