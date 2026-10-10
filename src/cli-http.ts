import { adapterPolicy } from "./server/route-policy.js";
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.js';
import type { Principal } from './operate.js';
import { contractRow, fileArguments, STEP_UP_MESSAGE, type RemoteCommandLookup } from './remote-command.js';
import { limitWords, type Admission, type BudgetLimit } from './request-budget.js';
import { TOKEN_REPLACEMENT } from './password-bearer.js';
import type { SessionRunner } from './session-remote.js';

/**
 * `POST /api/cli` (remote CLI, Phase 1): a teammate's laptop sends the argv it would have run locally, and the central
 * server runs that same command as that person. There is no per-resource API here and no second policy: the transport
 * authenticates one API token, checks the shared command contract and transport arguments, and hands the argv to
 * `runOperateAs`, which owns scope, project grants and attribution.
 *
 * Only `Authorization: Bearer so_…` is accepted — never a password, cookie or the owner's saved login — and a request
 * carrying a browser Origin is refused, so a page can never drive it.
 *
 * `session …` (D7) is the one command the server answers through its own owner rather than runOperateAs: native
 * session operations need the server's live coding workspace (session-remote.ts). They are admitted, budgeted and
 * refused here exactly like every other command.
 */

/** Who a remote command runs as, and the runner: operate.ts's own types, so a change there breaks this build instead of
 * drifting. Type-only: the value is loaded lazily through `run` (operate.ts imports the server that imports this). */
export type { Principal } from './operate.js';
export type RunOperateAs = typeof import('./operate.js').runOperateAs;

export type CliRequest = { argv: string[]; files: Record<string, string> };
export type CliReply = { exitCode: number; stdout: string; stderr: string };
export type CliFailure = { ok: false; code: string; message: string; limit?: BudgetLimit; retryAfter?: number };

/** Inlined file contents, summed as UTF-8 bytes. */
export const CLI_FILES_BYTES = 256 * 1024;
/** The whole JSON body: the files plus argv and JSON escaping headroom. */
export const CLI_REQUEST_BYTES = 2 * CLI_FILES_BYTES;
const ARGV_MAX = 256;
const ARG_BYTES = 16 * 1024;
const FILES_MAX = 16;

export type CliHttpOptions = {
  /** The live API token's person, or null. Only called for a single, well-formed `Bearer so_…` header. */
  authenticate: (request: IncomingMessage) => Principal | null;
  /** The shared command boundary; null when this server cannot run remote commands. */
  run: () => Promise<RunOperateAs | null>;
  /** Tests: command policy while the parallel command contract is not yet available. Defaults to COMMAND_GUIDE. */
  modeOf?: RemoteCommandLookup | undefined;
  /** The token's request budget (request-budget.ts), charged once per request before its body is read. */
  admit?: ((principal: Principal) => Admission) | undefined;
  /** Native session operations (`session …`), run by the server's session owner; absent where none is ready. */
  session?: SessionRunner | undefined;
  store: Store;
};
/** What a missing or unusable token hears: how to get one, and how to save it. */
const SIGN_IN = `Sign in with an API token: ${TOKEN_REPLACEMENT.charAt(0).toLowerCase()}${TOKEN_REPLACEMENT.slice(1)}, then toolroll connect <origin> --token-stdin.`;

function send(response: ServerResponse, status: number, value: CliReply | CliFailure, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  // A declared length: the client can tell a complete answer from a cut-off one.
  const text = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(text);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > CLI_REQUEST_BYTES) throw new Error('too-large');
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/** Decode the request's shape and byte limits. The endpoint checks file references against its command policy. */
export function cliRequest(value: unknown): CliRequest | { problem: string; tooLarge?: true } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problem: 'Send {argv, files}.' };
  const row = value as Record<string, unknown>;
  if (!Object.keys(row).every(key => key === 'argv' || key === 'files')) return { problem: 'Send only argv and files.' };
  const argv = row.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > ARGV_MAX || !argv.every(one => typeof one === 'string' && Buffer.byteLength(one) <= ARG_BYTES && !one.includes('\0'))) return { problem: 'argv must be 1–256 strings.' };
  const files = row.files ?? {};
  if (!files || typeof files !== 'object' || Array.isArray(files)) return { problem: 'files must map an argument to its contents.' };
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > FILES_MAX) return { problem: 'Too many files.' };
  let size = 0;
  const kept: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, content] of entries) {
    if (typeof content !== 'string' || key === '' || key.includes('\0')) return { problem: 'files must map file paths to text contents.' };
    size += Buffer.byteLength(content);
    if (size > CLI_FILES_BYTES) return { problem: 'Files are limited to 256 KiB in total.', tooLarge: true };
    kept[key] = content;
  }
  return { argv: argv as string[], files: kept };
}

/** The longest one request may hold the server: the client polls again for longer waits. */
export const CLI_WAIT_SECONDS = 25;
function longPollBounded(argv: readonly string[]): boolean {
  const words = argv.filter(one => !one.startsWith('-'));
  if (words[0] !== 'task' || words[1] !== 'wait') return true;
  const at = argv.indexOf('--timeout'), given = at < 0 ? NaN : Number(argv[at + 1]);
  return argv.filter(one => one === '--timeout').length === 1 && Number.isFinite(given) && given >= 0 && given <= CLI_WAIT_SECONDS;
}

/** Handles exactly `/api/cli`; false for any other path. */
export async function handleCliHttp(request: IncomingMessage, response: ServerResponse, options: CliHttpOptions): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://standing-orders.local');
  if (url.pathname !== '/api/cli') return false;
  const reject = (status: number, code: string, message: string) => { send(response, status, { ok: false, code, message }); request.resume(); return true; };
  if (url.search !== '' || url.username !== '' || url.password !== '') return reject(400, 'credentials-in-url', 'Send the command in the request body; nothing travels in the URL.');
  if (request.method !== 'POST') return reject(405, 'method-not-allowed', 'Use POST.');
  // A browser always names its page. The remote CLI never does, so a page can never drive this endpoint.
  if (request.headers.origin !== undefined) return reject(403, 'browser-origin', 'Remote commands come from the CLI, not a browser.');
  const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
  const count = names.filter(name => name === 'authorization').length;
  if (count > 1) return reject(400, 'ambiguous-credentials', 'Send one authorization header.');
  if (names.includes('cookie')) return reject(400, 'cookie-refused', 'Remote commands sign in with an API token only.');
  if (!/^Bearer so_\S+$/.test(request.headers.authorization ?? '')) return reject(401, 'unauthenticated', SIGN_IN);
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return reject(415, 'invalid-content-type', 'Send application/json.');
  if (Number(request.headers['content-length'] ?? 0) > CLI_REQUEST_BYTES) return reject(413, 'request-too-large', 'Files are limited to 256 KiB in total.');
  let principal: Principal | null;
  try { principal = options.authenticate(request); }
  catch { return reject(503, 'authentication-unavailable', 'Sign-in could not be checked.'); }
  if (!principal) return reject(401, 'unauthenticated', `This API token is not valid (expired, revoked or its person removed). ${TOKEN_REPLACEMENT}.`);
  // Counted once here, however long the command then holds the request (a task wait is one request).
  const admitted = options.admit === undefined ? { ok: true as const } : options.admit(principal);
  if (!admitted.ok && admitted.status === 503) return reject(503, 'limits-unavailable', 'Request limits could not be checked; nothing ran. Try again shortly.');
  if (!admitted.ok) {
    send(response, 429, { ok: false, code: 'rate-limited', message: limitWords(admitted.limit, admitted.retryAfter), limit: admitted.limit, retryAfter: admitted.retryAfter }, { 'retry-after': String(admitted.retryAfter) });
    request.resume();
    return true;
  }
  if (!adapterPolicy({ caller: "bearer", capability: principal.scope, token: true }).ok) return reject(403, "read-only", "Your token reads only. Use an act token for this.");
  let value: unknown;
  try { value = await body(request); }
  catch (error) { return reject(error instanceof Error && error.message === 'too-large' ? 413 : 400, 'invalid-body', 'Send a valid JSON request; files are limited to 256 KiB in total.'); }
  const parsed = cliRequest(value);
  if ('problem' in parsed) return reject(parsed.tooLarge ? 413 : 400, 'invalid-request', parsed.problem);
  if (parsed.argv[0] === 'session') return runSession(response, options, principal, parsed);
  const row = (options.modeOf ?? contractRow)(parsed.argv);
  if (row?.mode === 'step-up') return reject(403, 'step-up', STEP_UP_MESSAGE);
  if (row?.mode !== 'yes') return reject(403, 'remote-refused', 'This command cannot run remotely.');
  const paths = fileArguments(parsed.argv, row);
  if ('problem' in paths) return reject(403, paths.code, paths.problem);
  const missing = paths.find(path => !Object.hasOwn(parsed.files, path));
  if (missing !== undefined) return reject(403, 'missing-file', 'Send every input file\'s contents in files; remote commands cannot read a server file.');
  if (Object.keys(parsed.files).some(path => !paths.includes(path))) return reject(400, 'invalid-request', 'Each file must name a declared input file argument.');
  if (!longPollBounded(parsed.argv)) return reject(400, 'wait-too-long', `A remote task wait holds the server for at most ${CLI_WAIT_SECONDS} seconds; give --timeout ${CLI_WAIT_SECONDS} or less.`);
  let run: RunOperateAs | null;
  try { run = await options.run(); } catch { run = null; }
  if (run === null) return reject(501, 'remote-unavailable', 'This server cannot run remote commands yet. Update it, or use --local.');
  // Files stay in memory: runOperateAs reads them by their argument, so nothing is written to disk here.
  const out: string[] = [];
  let exitCode: number;
  try { exitCode = await run([...parsed.argv], { principal, store: options.store, write: line => { out.push(`${line}\n`); }, files: parsed.files, source: 'api' }); }
  catch { return reject(500, 'command-failed', 'The command stopped unexpectedly on the server. Check its state before running it again.'); }
  send(response, 200, { exitCode, stdout: out.join(''), stderr: '' });
  return true;
}

/** `session …`: the prompt is the request's one file; the session owner answers one session envelope on stdout. */
async function runSession(response: ServerResponse, options: CliHttpOptions, principal: Principal, parsed: CliRequest): Promise<true> {
  const refuse = (status: number, code: string, message: string): true => { send(response, status, { ok: false, code, message }); return true; };
  if (options.session === undefined) return refuse(501, 'remote-unavailable', 'This server cannot run session commands. Update it, or use the console.');
  const at = parsed.argv.indexOf('--file'), file = at < 0 ? undefined : parsed.argv[at + 1];
  if (Object.keys(parsed.files).some(path => path !== file)) return refuse(400, 'invalid-request', 'Each file must name a declared input file argument.');
  const out: string[] = [];
  let exitCode: number;
  try { exitCode = await options.session(principal, parsed.argv, parsed.files, line => { out.push(`${line}\n`); }); }
  catch { return refuse(500, 'command-failed', 'The command stopped unexpectedly on the server. Check its state before running it again.'); }
  send(response, 200, { exitCode, stdout: out.join(''), stderr: '' });
  return true;
}
