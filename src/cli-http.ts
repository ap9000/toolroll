import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.js';

/**
 * `POST /api/cli` (remote CLI, Phase 1): a teammate's laptop sends the argv it would have run locally, and the central
 * server runs that same command as that person. There is no per-resource API here and no second policy: the transport
 * authenticates one API token, carries who it names, and hands the argv to the shared command boundary
 * (`runOperateAs`), which owns scope, project grants, step-up refusals and attribution.
 *
 * Only `Authorization: Bearer so_…` is accepted — never a password, cookie or the owner's saved login — and a request
 * carrying a browser Origin is refused, so a page can never drive it.
 */

/** Who a remote command runs as. The shared seam with operate.ts (remote-principal). */
export type Principal = { kind: 'person'; account: string; generation: number; scope: 'read' | 'act'; tokenId: string; projects: string[] | null };
export type RunOperateAs = (argv: string[], opts: { principal: Principal; store: Store; write: (s: string) => void; files?: Record<string, string>; source?: 'api' | 'mcp' }) => Promise<number>;

export type CliRequest = { argv: string[]; files: Record<string, string> };
export type CliReply = { exitCode: number; stdout: string; stderr: string };
export type CliFailure = { ok: false; code: string; message: string };

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
  store: Store;
};

function send(response: ServerResponse, status: number, value: CliReply | CliFailure): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
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

/** The request's own shape, or why not. Nothing here reads a path: a file key is only the argument it stands for. */
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
    // A file stands for one argument the person actually typed; argv itself is never rewritten.
    if (typeof content !== 'string' || !argv.includes(key) || key.startsWith('-')) return { problem: 'Each file must name one of the command\'s arguments.' };
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
  if (!/^Bearer so_\S+$/.test(request.headers.authorization ?? '')) return reject(401, 'unauthenticated', 'Sign in with your API token: toolroll connect <origin> --token-stdin.');
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return reject(415, 'invalid-content-type', 'Send application/json.');
  if (Number(request.headers['content-length'] ?? 0) > CLI_REQUEST_BYTES) return reject(413, 'request-too-large', 'Files are limited to 256 KiB in total.');
  let principal: Principal | null;
  try { principal = options.authenticate(request); }
  catch { return reject(503, 'authentication-unavailable', 'Sign-in could not be checked.'); }
  if (!principal) return reject(401, 'unauthenticated', 'This API token is not valid (expired, revoked or its person removed).');
  let value: unknown;
  try { value = await body(request); }
  catch (error) { return reject(error instanceof Error && error.message === 'too-large' ? 413 : 400, 'invalid-body', 'Send a valid JSON request; files are limited to 256 KiB in total.'); }
  const parsed = cliRequest(value);
  if ('problem' in parsed) return reject(parsed.tooLarge ? 413 : 400, 'invalid-request', parsed.problem);
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
