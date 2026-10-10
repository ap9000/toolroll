/**
 * Remote CLI, the client half (Phase 1). With an API token saved by `toolroll connect`, a command whose contract row
 * says `remote: "yes"` is sent to the central server's `POST /api/cli` and runs there as you; its stdout, stderr and
 * exit code come back byte for byte. `remote: "no"` runs on this computer exactly as before, and `remote: "step-up"`
 * (approvals, people and policy) is refused here: those stay in the console or chat.
 *
 * Nothing here opens the local database or reads a saved owner login; it never prompts, and an uncertain answer to
 * a mutation is never retried.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { envelopeJson } from './envelope.js';
import { COMMAND_GUIDE } from './surface.js';
import { centralProfile, UsageError, type TeamCliOptions } from './team-cli.js';
import { CLI_FILES_BYTES, CLI_WAIT_SECONDS, type CliRequest } from './cli-http.js';
import { TOKEN_REPLACEMENT } from './password-bearer.js';
import { contractRow, fileArguments, STEP_UP_MESSAGE, type RemoteCommand, type RemoteCommandLookup } from './remote-command.js';

export { contractRow, STEP_UP_MESSAGE, type RemoteMode } from './remote-command.js';
const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;
/** Team commands own their own central path (team-cli.ts); `session` sends its own checked request (session-cli.ts). */
const TEAM_COMMANDS = new Set(['connect', 'lead', 'conversation', 'chat', 'brief', 'session']);
const RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = (CLI_WAIT_SECONDS + 35) * 1_000;

export type RemoteExecOptions = TeamCliOptions & {
  cwd?: string;
  /** Raw output streams; remote bytes are written exactly as the server returned them. */
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  /** Injected by tests: the contract row lookup (default: COMMAND_GUIDE's `remote` field). */
  modeOf?: RemoteCommandLookup;
};

type Answer = { exitCode: number; stdout: string; stderr: string };
export type Outcome = { kind: 'answer'; answer: Answer } | { kind: 'refused'; status: number; code: string; message: string } | { kind: 'unconfirmed' };

async function bounded(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > RESPONSE_BYTES) { await reader.cancel(); throw new Error('too-large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/** One request, never retried. */
export async function postCli(origin: string, token: string, request: CliRequest, options: RemoteExecOptions): Promise<Outcome> {
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await (options.fetch ?? fetch)(`${origin}/api/cli`, {
      method: 'POST', redirect: 'manual', credentials: 'omit', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request),
    });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { kind: 'unconfirmed' }; }
    const payload = await bounded(response) as Record<string, unknown> | null;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'unconfirmed' };
    if (response.status === 200 && Number.isInteger(payload.exitCode) && Number(payload.exitCode) >= 0 && Number(payload.exitCode) <= 255 && typeof payload.stdout === 'string' && typeof payload.stderr === 'string') {
      return { kind: 'answer', answer: { exitCode: Number(payload.exitCode), stdout: payload.stdout, stderr: payload.stderr } };
    }
    if (response.status >= 400 && payload.ok === false && typeof payload.code === 'string' && typeof payload.message === 'string') {
      return { kind: 'refused', status: response.status, code: payload.code, message: payload.message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') };
    }
    return { kind: 'unconfirmed' };
  } catch { return { kind: 'unconfirmed' }; }
}

/** The declared file arguments' contents, keyed by the argument exactly as typed. argv is never rewritten. */
function inlineFiles(argv: readonly string[], row: RemoteCommand, cwd: string): Record<string, string> {
  const paths = fileArguments(argv, row);
  if ('problem' in paths) throw new UsageError(paths.problem);
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  let size = 0;
  for (const value of paths) {
    if (Object.hasOwn(files, value)) continue;
    const path = resolve(cwd, value);
    let isFile = false;
    try { isFile = statSync(path).isFile(); } catch { isFile = false; }
    if (!isFile) throw new UsageError('A remote input must be a readable file.');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); }
    catch { throw new UsageError('A remote input must be a readable UTF-8 file.'); }
    size += Buffer.byteLength(content);
    if (size > CLI_FILES_BYTES) throw new UsageError('Files sent with a remote command are limited to 256 KiB in total. Use --local to run it here.');
    files[value] = content;
  }
  return files;
}

/**
 * null: run locally with argv unchanged. `{ local }`: run locally with this argv (`--local` removed).
 * A number: the command ran remotely (or was refused before sending) and this is its exit code.
 */
export async function maybeRunRemoteCommand(argv: readonly string[], options: RemoteExecOptions = {}): Promise<number | { local: string[] } | null> {
  const first = argv[0];
  if (first === undefined || first.startsWith('-') || TEAM_COMMANDS.has(first) || first === 'help') return null;
  const out = options.stdout ?? (chunk => { process.stdout.write(chunk); });
  const err = options.stderr ?? (chunk => { process.stderr.write(chunk); });
  const json = argv.includes('--json');
  const lookup = options.modeOf ?? contractRow;
  const row = lookup(argv);
  const command = row?.invocation ?? first;
  const refuse = (reason: string, message: string, code: number): number => {
    if (json) out(`${envelopeJson({ ok: false, command, reason, message })}\n`); else err(`${message}\n`);
    return code;
  };
  const profileAt = argv.indexOf('--profile');
  const mode = row?.mode ?? 'no';
  const explicit = profileAt >= 0;
  // Local commands never read the profile, and their own flags (the scan's --local) stay exactly as typed.
  if (mode === 'no' && !explicit) return null;
  if (argv.includes('--local')) {
    if (explicit) return refuse('usage', '--local cannot be combined with --profile.', EXIT.usage);
    // A row declaring --local keeps its own meaning; elsewhere it only means "run here".
    const declared = COMMAND_GUIDE.find(one => one.invocation === row?.invocation)?.flags?.some(flag => flag.name === 'local') ?? false;
    return { local: declared ? [...argv] : argv.filter(one => one !== '--local') };
  }
  let profile: ReturnType<typeof centralProfile>;
  try {
    if (profileAt >= 0 && (argv.filter(one => one === '--profile').length > 1 || !argv[profileAt + 1] || argv[profileAt + 1]!.startsWith('-'))) throw new UsageError('Use --profile <name> once.');
    profile = centralProfile(options, profileAt >= 0 ? argv[profileAt + 1] : undefined);
  } catch (error) { return refuse('usage', error instanceof UsageError ? error.message : 'The remote profile cannot be read.', EXIT.usage); }
  // No saved token: today's local behaviour. A profile saved with a password serves chat only.
  if (profile === null || !profile.apiToken) {
    if (!explicit) return null;
    return refuse('usage', `This profile has no API token. ${TOKEN_REPLACEMENT}, then connect again with it (toolroll connect <origin> --token-stdin).`, EXIT.usage);
  }
  if (row === null || mode === 'no') {
    return refuse('usage', `${command} runs only on this computer. Drop --profile to run it here.`, EXIT.usage);
  }
  if (mode === 'step-up') return refuse('step-up', STEP_UP_MESSAGE, EXIT.refused);
  const sent = explicit ? argv.filter((_one, index) => index !== profileAt && index !== profileAt + 1) : [...argv];
  let files: Record<string, string>;
  try { files = inlineFiles(sent, row, options.cwd ?? process.cwd()); }
  catch (error) { return refuse('usage', error instanceof UsageError ? error.message : 'A file could not be read.', EXIT.usage); }

  const deliver = (outcome: Outcome): number => {
    if (outcome.kind === 'answer') {
      // Byte for byte. --json answers are also captured so -o writes the same envelope a local run would.
      if (json) { try { const parsed: unknown = JSON.parse(outcome.answer.stdout); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envelopeJson(parsed as Parameters<typeof envelopeJson>[0]); } catch { /* not one envelope */ } }
      if (outcome.answer.stdout) out(outcome.answer.stdout);
      if (outcome.answer.stderr) err(outcome.answer.stderr);
      return outcome.answer.exitCode;
    }
    if (outcome.kind === 'refused') return refuse(outcome.code, outcome.message, outcome.status === 401 || outcome.status === 403 || outcome.status === 501 ? EXIT.refused : outcome.status < 500 ? EXIT.usage : EXIT.failed);
    return refuse('unconfirmed', row?.mutation === 'none'
      ? `${profile.origin} could not be reached or answered unexpectedly.`
      : `The answer from ${profile.origin} could not be confirmed. Check the task's state before running this again; it was not retried.`, EXIT.failed);
  };
  if (row?.invocation === 'task wait') return waitRemotely(sent, files, profile, options, deliver);
  return deliver(await postCli(profile.origin, profile.token, { argv: sent, files }, options));
}

/**
 * `task wait` holds the server for at most CLI_WAIT_SECONDS per request; the client keeps asking within the caller's
 * own --timeout (none: until the task settles or the wait is interrupted). The final answer is the server's own.
 */
async function waitRemotely(argv: string[], files: Record<string, string>, profile: { origin: string; token: string }, options: RemoteExecOptions, deliver: (outcome: Outcome) => number): Promise<number> {
  const at = argv.indexOf('--timeout');
  const given = at < 0 ? null : Number(argv[at + 1]);
  const base = at < 0 ? argv : argv.filter((_one, index) => index !== at && index !== at + 1);
  if (given !== null && (!Number.isFinite(given) || given < 0)) return deliver(await postCli(profile.origin, profile.token, { argv, files }, options));
  const json = base.includes('--json');
  const probe = json ? base : [...base, '--json'];
  const started = Date.now();
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const signal = options.signal ?? new AbortController().signal;
  while (true) {
    const remaining = given === null ? CLI_WAIT_SECONDS : Math.max(0, given - (Date.now() - started) / 1_000);
    const slice = Math.min(CLI_WAIT_SECONDS, Math.floor(remaining * 1_000) / 1_000);
    const outcome = await postCli(profile.origin, profile.token, { argv: [...probe, '--timeout', String(slice)], files }, options);
    if (outcome.kind !== 'answer') return deliver(outcome);
    let reason: unknown;
    try { reason = (JSON.parse(outcome.answer.stdout) as { reason?: unknown }).reason; } catch { return deliver(outcome); }
    const timedOut = reason === 'timeout';
    if (!timedOut || slice <= 0 || given !== null && remaining - slice <= 0) {
      if (json) return deliver(outcome);
      // Settled (or out of time): the server renders the final answer in the person's own format.
      return deliver(await postCli(profile.origin, profile.token, { argv: [...base, '--timeout', '0'], files }, options));
    }
    if (signal.aborted) return deliver(outcome);
    try { await sleep(250, signal); } catch { return deliver(outcome); }
  }
}
