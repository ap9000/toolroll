import { open } from 'node:fs/promises';
import { envelopeJson } from './envelope.js';
import {
  SESSION_DESCRIPTORS, SESSION_PROMPT_BYTES,
  isSessionResponse, sessionCapabilities, sessionDescriptor, validateSessionRequest,
  type SessionDescriptor, type SessionRequest, type SessionResponse,
} from './session-contract.js';
import { centralProfile, UsageError, type TeamCliOptions } from './team-cli.js';
import { postCli } from './remote-exec.js';
import { TOKEN_REPLACEMENT } from './password-bearer.js';

/**
 * `toolroll session …` (D7): native session operations run on the central server over `POST /api/cli`, signed in with
 * the API token `toolroll connect` saved, like every other remote command. The client checks and sends the exact
 * request; the server (session-remote.ts) runs it through the existing session owner and answers one session envelope.
 */
export type SessionCliOptions = TeamCliOptions & { readStdin?: () => Promise<string>; stderr?: (line: string) => void };
/** The files key the prompt travels under: the server reads no paths, only what the request carries. */
export const SESSION_PROMPT_FILE = 'prompt';
export const SESSION_CLI_ACTIONS = ['capabilities', ...SESSION_DESCRIPTORS.map(one => one.operation)] as const;
/** Before D7 the session client signed in with an operator password on every request. */
const RETIRED_FLAGS = new Set(['url', 'as', 'token-env', 'token-file']);
export const SESSION_TOKEN_REQUIRED = `Session commands use your saved API token. ${TOKEN_REPLACEMENT}, then save it with \`toolroll connect <origin> --as <account> --token-stdin\`.`;

/** The flags an operation takes: on this computer (where the prompt may come from a file or stdin, and a saved
 * profile is chosen), or on the server (where the prompt is only ever the request's own file). */
export function sessionCliFlags(spec: SessionDescriptor, side: 'client' | 'server' = 'client'): Record<string, 'value' | 'flag'> {
  const prompt = spec.operation === 'start' || spec.operation === 'send';
  return { json: 'flag', help: 'flag', ...(side === 'client' ? { profile: 'value' as const } : {}),
    ...Object.fromEntries(Object.keys(spec.flags).map(name => [name, 'value' as const])),
    ...(prompt ? { file: 'value' as const, ...(side === 'client' ? { stdin: 'flag' as const } : {}) } : {}) };
}
function help(spec?: SessionDescriptor): string {
  if (!spec) return `toolroll session <operation>\n\n${SESSION_DESCRIPTORS.map(one => `  ${one.operation.padEnd(12)} ${one.synopsis}`).join('\n')}\n  capabilities  Show this client's schemas and authority requirements\n\nUse session <operation> --help for required flags. Sessions run on the server you connected to with your API token (toolroll connect); they need instance operator access.`;
  const fields = spec.inputSchema.required.filter(one => !['version', 'sessionId', 'prompt'].includes(one));
  const required = fields.map(field => Object.entries(spec.flags).find(([, value]) => value.field === field)?.[0]).filter(Boolean);
  return `toolroll session ${spec.operation}${'sessionId' in spec.inputSchema.properties ? ' <session-id>' : ''}\n${spec.synopsis}.\n\n${required.length > 0 ? `Required:\n${required.map(name => `  --${name} <value>`).join('\n')}\n` : ''}${'prompt' in spec.inputSchema.properties ? '  --file <path> or --stdin (complete prompt, up to 64 KB)\n' : ''}${'expectedRevision' in spec.inputSchema.properties ? '\nUse the revision, nativeThreadId and turnId from session show. Use none for a null thread or turn.\n' : ''}\nOptions: ${Object.keys(sessionCliFlags(spec)).map(name => `--${name}`).join(' ')}\nRuns on the saved connection (or --profile <name>) over /api/cli with your API token. Mutations are never retried automatically.`;
}

export type SessionArguments = { spec: SessionDescriptor; flags: Record<string, string | true>; positionals: string[] };
/** One parser for both sides of /api/cli: `<operation> [<session-id>] --flag value …`. */
export function parseSessionArguments(argv: readonly string[], side: 'client' | 'server'): SessionArguments | { problem: string } {
  const operation = argv[0] ?? '';
  const spec = sessionDescriptor(operation);
  if (!spec) return { problem: `Unknown session operation. Use: ${SESSION_CLI_ACTIONS.join(', ')}.` };
  const allowed = sessionCliFlags(spec, side); const flags: Record<string, string | true> = {}; const positionals: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith('-')) { positionals.push(argument); continue; }
    const name = argument === '-h' ? 'help' : argument.startsWith('--') ? argument.slice(2) : '';
    if (side === 'client' && RETIRED_FLAGS.has(name)) return { problem: SESSION_TOKEN_REQUIRED };
    if (!Object.hasOwn(allowed, name)) return { problem: `Unknown option ${argument} for session ${operation}.` };
    if (Object.hasOwn(flags, name)) return { problem: `Option --${name} was repeated.` };
    if (allowed[name] === 'flag') flags[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('-')) return { problem: `--${name} requires a value.` };
      flags[name] = value;
    }
  }
  return { spec, flags, positionals };
}

/** The validated request the parsed arguments and prompt spell. */
export function sessionRequestOf({ spec, flags, positionals }: SessionArguments, prompt: string | undefined): { ok: true; request: SessionRequest } | { ok: false; message: string } {
  const request: Record<string, unknown> = { version: 1 };
  if ('sessionId' in spec.inputSchema.properties) {
    if (positionals.length !== 1) return { ok: false, message: 'Name exactly one session ID.' };
    request['sessionId'] = positionals[0];
  } else if (positionals.length) return { ok: false, message: 'This operation takes no positional arguments.' };
  for (const [name, field] of Object.entries(spec.flags)) {
    const raw = flags[name];
    if (typeof raw !== 'string') continue;
    if (field.kind === 'integer' && !/^\d+$/.test(raw)) return { ok: false, message: `--${name} must be a whole number.` };
    request[field.field] = field.kind === 'integer' ? Number(raw) : field.kind === 'nullable-id' && raw === 'none' ? null : raw;
  }
  if (prompt !== undefined) request['prompt'] = prompt;
  return validateSessionRequest(spec.operation, request);
}

/** The exact argv the server runs for a validated request: always --json, the prompt as the request's one file. */
export function sessionArgv(spec: SessionDescriptor, request: SessionRequest): string[] {
  const fields = request as Record<string, unknown>;
  const argv = ['session', spec.operation];
  if (typeof fields['sessionId'] === 'string') argv.push(fields['sessionId']);
  for (const [name, field] of Object.entries(spec.flags)) {
    const value = fields[field.field];
    if (value !== undefined) argv.push(`--${name}`, value === null ? 'none' : String(value));
  }
  if (typeof fields['prompt'] === 'string') argv.push('--file', SESSION_PROMPT_FILE);
  argv.push('--json');
  return argv;
}

async function readBoundedFile(path: string, limit: number, label: string): Promise<string> {
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch { throw new UsageError(`${label} must be a readable UTF-8 regular file of at most ${limit} bytes.`); }
  finally { await file?.close(); }
}
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('Pipe the complete prompt into --stdin, or use --file.');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > SESSION_PROMPT_BYTES) throw new UsageError('The prompt exceeds 64 KB.');
    chunks.push(buffer);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new UsageError('The prompt must be UTF-8 text.'); }
}

function unconfirmed(spec: SessionDescriptor, request: SessionRequest): SessionResponse {
  const sessionId = 'sessionId' in request ? request.sessionId : undefined;
  return { version: 1, operation: spec.operation, ok: false, status: spec.mutation ? 'uncertain' : 'rejected',
    delivery: spec.mutation ? 'unknown' : 'not-sent', retry: spec.mutation ? 'inspect-first' : 'safe-read',
    reason: spec.mutation ? 'delivery-unknown' : 'service-unavailable',
    message: spec.mutation ? 'The service response could not be confirmed. Inspect the saved session before continuing; the request was not retried.' : 'The service response could not be read. Check the service address and connection.',
    nextActions: [{ operation: sessionId ? 'show' : 'list', label: sessionId ? 'Inspect session' : 'List sessions', ...(sessionId ? { sessionId } : {}) }] };
}
/** One request over /api/cli, never retried. Only an answer whose identity matches the request counts as delivered. */
async function perform(spec: SessionDescriptor, request: SessionRequest, profile: { origin: string; token: string }, options: SessionCliOptions): Promise<SessionResponse> {
  const files = typeof (request as { prompt?: unknown }).prompt === 'string' ? { [SESSION_PROMPT_FILE]: (request as { prompt: string }).prompt } : {};
  const outcome = await postCli(profile.origin, profile.token, { argv: sessionArgv(spec, request), files }, options);
  if (outcome.kind === 'unconfirmed') return unconfirmed(spec, request);
  if (outcome.kind === 'refused') {
    // /api/cli refuses before it runs anything, except a command that stopped on the server: that one may have acted.
    if (outcome.status >= 500 && outcome.status !== 501 && outcome.status !== 503) return unconfirmed(spec, request);
    return { version: 1, operation: spec.operation, ok: false, status: 'rejected', delivery: 'not-sent', retry: spec.mutation ? 'never' : 'safe-read',
      reason: /^[a-z][a-z0-9-]*$/.test(outcome.code) ? outcome.code : 'refused', message: outcome.message, nextActions: [] };
  }
  let payload: unknown;
  try { payload = JSON.parse(outcome.answer.stdout); } catch { return unconfirmed(spec, request); }
  if (!isSessionResponse(payload, spec.operation)) return unconfirmed(spec, request);
  if ('sessionId' in request && payload.result?.session && payload.result.session.id !== request.sessionId) return unconfirmed(spec, request);
  if (payload.ok && 'key' in request && payload.result?.receipt?.key !== request.key) return unconfirmed(spec, request);
  if (payload.ok && 'expectedThreadId' in request && request.expectedThreadId !== null && payload.result?.session?.nativeThreadId !== request.expectedThreadId) return unconfirmed(spec, request);
  return payload;
}
const terminalText = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
/** The plain-text answer, the same on either side of the transport. */
export function renderSessionResponse(response: SessionResponse): string {
  const result = response.result;
  const lines = response.ok && response.operation === 'show' && result?.brief ? [] : [response.message];
  for (const session of result?.sessions ?? []) lines.push(`${session.id}  ${session.status}  ${session.title}`);
  if (result?.session) {
    const session = result.session;
    lines.push(result?.brief?.summary ?? `${session.title} · ${session.status}`, `Session: ${session.id}`, `Revision: ${session.revision} · Thread: ${session.nativeThreadId ?? 'none'} · Turn: ${session.turnId ?? 'none'}`);
    if (session.error && !result?.brief) lines.push(session.error);
  }
  for (const item of result?.items ?? []) lines.push(`\n${item.type}: ${item.text}`);
  for (const request of result?.requests ?? []) lines.push(`\n${request.title}\n${request.detail}`);
  if (result?.changes) lines.push(result.changes.status, result.changes.diff, ...(result.changes.truncated ? ['Changes were truncated. Open the workspace for the full diff.'] : []));
  if (result?.truncated) lines.push('The response is shortened. Open the workspace for complete activity.');
  for (const action of response.nextActions) lines.push(`${action.label}: ${action.operation === 'open-ui' ? 'open the coding workspace' : `toolroll session ${action.operation}${action.sessionId ? ` ${action.sessionId}` : ''}`}`);
  return terminalText(lines.join('\n'));
}
/** 0 delivered · 1 unknown (inspect first) · 3 refused. */
export const sessionExitCode = (response: SessionResponse): number => response.ok ? 0 : response.status === 'uncertain' || response.reason === 'service-unavailable' ? 1 : 3;

export async function runSessionCommand(argv: readonly string[], write: (line: string) => void, options: SessionCliOptions = {}): Promise<number> {
  const json = argv.includes('--json');
  const stderr = options.stderr ?? (line => process.stderr.write(`${line}\n`));
  const operation = argv[0]; const command = operation ? `session ${operation}` : 'session';
  const fail = (message: string): number => {
    const payload = { ok: false, command, reason: 'usage', status: 'rejected', delivery: 'not-sent', retry: 'never', message };
    if (json) write(envelopeJson(payload)); else stderr(message);
    return 2;
  };
  if (!operation || operation === '--help' || operation === '-h') {
    if (json) write(envelopeJson({ ok: true, command: 'session', ...sessionCapabilities() })); else write(help());
    return 0;
  }
  if (operation === 'capabilities') {
    if (argv.slice(1).some(arg => !['--json', '--help', '-h'].includes(arg))) return fail('session capabilities accepts only --json or --help.');
    write(json ? envelopeJson({ ok: true, command, ...sessionCapabilities() }) : help()); return 0;
  }
  const parsed = parseSessionArguments(argv, 'client');
  if ('problem' in parsed) return fail(parsed.problem);
  const { spec, flags } = parsed;
  if (flags['help']) { write(json ? envelopeJson({ ok: true, command, descriptor: spec, help: help(spec) }) : help(spec)); return 0; }
  let request: SessionRequest;
  let profile: ReturnType<typeof centralProfile>;
  try {
    let prompt: string | undefined;
    if ('prompt' in spec.inputSchema.properties) {
      if (Boolean(flags['file']) === Boolean(flags['stdin'])) throw new UsageError('Choose exactly one prompt source: --file <path> or --stdin.');
      prompt = typeof flags['file'] === 'string' ? await readBoundedFile(flags['file'], SESSION_PROMPT_BYTES, 'The prompt file') : await (options.readStdin ?? readStdin)();
    }
    const validated = sessionRequestOf(parsed, prompt);
    if (!validated.ok) throw new UsageError(validated.message);
    request = validated.request;
    profile = centralProfile(options, typeof flags['profile'] === 'string' ? flags['profile'] : undefined);
  } catch (error) { return fail(error instanceof UsageError ? error.message : 'The session request could not be prepared. Check the prompt and saved connection.'); }
  if (profile === null || !profile.apiToken) return fail(SESSION_TOKEN_REQUIRED);
  const response = await perform(spec, request, profile, options);
  if (json) write(envelopeJson({ ...response, command, ...('key' in request ? { key: request.key } : {}) }));
  else if (response.ok) write(renderSessionResponse(response)); else stderr(renderSessionResponse(response));
  return sessionExitCode(response);
}
