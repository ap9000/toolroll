/**
 * `toolroll connect`: saves a central server's origin and your API token in a private profile file. Remote commands
 * (remote-exec.ts) and `toolroll health` sign in with it; nothing here opens the local database except to find the
 * existing local sign-in for --local-login.
 */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { envelopeJson } from './envelope.js';
import { databasePath } from './store.js';
import { configBase, namedPath } from './names.js';
import { parseApiToken } from './api-tokens.js';
import { deprecationWarning } from './deprecations.js';
import { PASSWORD_PROFILE_WARNING } from './password-bearer.js';

export type ConnectOptions = {
  fetch?: typeof fetch; env?: NodeJS.ProcessEnv; home?: string; profileFile?: string;
  readStdin?: () => Promise<string>; stderr?: (line: string) => void; signal?: AbortSignal;
};
const HELP = `toolroll connect <HTTPS-origin> --as <account> --token-stdin
  Pipe your API token (so_…, from Settings → API tokens) or use --token-file <private-file>;
  --local-login uses your existing local sign-in.
  With an API token saved, other commands run on that server as you (--local runs here).
  Optional: --profile <name> (saved as the active profile).`;
export class UsageError extends Error {}
/** Credentials are never sent to a URL with embedded authority, an API path, query, fragment or an insecure remote
 * host. Fetch cannot follow redirects. */
export function serviceOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UsageError('The service origin must be HTTPS or loopback HTTP.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new UsageError('The service origin must contain only the origin, with no credentials, path, query or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new UsageError('The service origin requires HTTPS except for loopback HTTP.');
  return url.origin;
}
type Profile = { origin: string; account: string; token: string };
type Profiles = { version: 1; active: string; profiles: Record<string, Profile> };
type Flags = Record<string, string | true>;
const value = (flags: Flags, name: string): string => typeof flags[name] === 'string' ? flags[name] as string : '';
const text = (raw: string): string => raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
const strings = (input: unknown): input is string[] => Array.isArray(input) && input.every(one => typeof one === 'string');
const accountValid = (input: string): boolean => !!input && input.length <= 200 && !/[\s:\x00-\x1f\x7f]/.test(input);
const tokenValid = (input: string): boolean => !!input && input.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(input);
const profilePath = (options: ConnectOptions): string => options.profileFile ?? namedPath(configBase(options.env ?? process.env, options.home ?? homedir()), ['remote', 'profiles.json']);

/** Open the file itself without following a symlink; nonblocking also rejects FIFOs safely. */
function privateFile(path: string, limit: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > limit) throw new Error();
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new UsageError('The credential file must be an owned, private (chmod 600), regular UTF-8 file.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function profiles(options: ConnectOptions): Profiles | null {
  const path = profilePath(options);
  // lstat distinguishes a dangling symlink from a missing profile.
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new UsageError('The remote profile cannot be read.'); }
  const raw = privateFile(path, 128 * 1024);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== 1 || typeof parsed.active !== 'string' || !record(parsed.profiles)) throw new Error();
    for (const [name, one] of Object.entries(parsed.profiles)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !record(one) || typeof one.origin !== 'string' || serviceOrigin(one.origin) !== one.origin || typeof one.account !== 'string' || !accountValid(one.account) || typeof one.token !== 'string' || !tokenValid(one.token)) throw new Error();
    }
    if (!Object.hasOwn(parsed.profiles, parsed.active)) throw new Error();
    return parsed as Profiles;
  } catch { throw new UsageError('The remote profile is invalid. Connect again using a private credential source.'); }
}
function saveProfile(options: ConnectOptions, name: string, profile: Profile): void {
  const path = profilePath(options), directory = dirname(path);
  const saved = profiles(options) ?? { version: 1, active: name, profiles: {} };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || (process.getuid && parent.uid !== process.getuid())) throw new UsageError('The remote profile directory must be owned and private (chmod 700).');
  saved.active = name; Object.defineProperty(saved.profiles, name, { value: profile, enumerable: true, configurable: true, writable: true });
  const temporary = join(directory, `.profile-${randomBytes(16).toString('hex')}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(saved)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    fd = openSync(directory, constants.O_RDONLY); fsyncSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
}
/** An API token (so_…) is sent bare; an older saved sign-in keeps its account:secret form. */
export const bearerOf = (profile: Profile): string => parseApiToken(profile.token) !== null ? `Bearer ${profile.token}` : `Bearer ${profile.account}:${profile.token}`;

/** The saved central profile remote commands use: the named one (or the active one), and whether it holds an API token.
 * null when nothing is saved. Reads only the private profile file — never a local login or the database. */
export function hasCentralProfile(options: ConnectOptions): boolean {
  // An unreadable or invalid profile file still names a central service: the caller refuses rather than run locally.
  try { return profiles(options) !== null; } catch { return true; }
}

export function centralProfile(options: ConnectOptions, name?: string): { name: string; origin: string; account: string; token: string; apiToken: boolean } | null {
  const saved = profiles(options);
  if (saved === null) return null;
  const chosen = name ?? saved.active;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(chosen) || !Object.hasOwn(saved.profiles, chosen)) throw new UsageError(`No saved connection named ${chosen}. Use connect with your API token first.`);
  const profile = saved.profiles[chosen]!;
  return { name: chosen, ...profile, apiToken: parseApiToken(profile.token) !== null };
}

async function stdinSecret(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('Pipe your sign-in secret into --token-stdin, or use --token-file.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of process.stdin) { const chunk = Buffer.from(part); size += chunk.length; if (size > 8192) throw new UsageError('The sign-in secret is too large.'); chunks.push(chunk); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new UsageError('The sign-in secret must be UTF-8.'); }
}
async function responseBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
type ConnectReply = { version: 1; ok: boolean; code: string; message: string; result?: unknown };
function parse(argv: readonly string[]): { flags: Flags; positions: string[] } {
  const allowed = new Set(['profile', 'json', 'help', 'as', 'token-stdin', 'token-file', 'local-login', 'login-file']);
  const switches = new Set(['json', 'help', 'token-stdin', 'local-login']);
  const flags: Flags = {}, positions: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) { positions.push(arg); continue; }
    const name = arg.slice(2);
    if (!allowed.has(name)) throw new UsageError('Unsupported option. Use --help for this command; secrets must come from stdin or a private file.');
    if (Object.hasOwn(flags, name)) throw new UsageError(`Use --${name} only once.`);
    if (switches.has(name)) flags[name] = true;
    else { const next = argv[++index]; if (!next || next.startsWith('--')) throw new UsageError(`--${name} needs a value.`); flags[name] = next; }
  }
  if (positions.length !== 1 && !flags.help) throw new UsageError('Name one service origin.');
  return { flags, positions };
}
function isMessage(one: unknown): boolean {
  return record(one) && Number.isSafeInteger(one.id) && typeof one.author === 'string' && ['operator', 'assistant'].includes(String(one.role)) && typeof one.text === 'string' && ['queued', 'running', 'answered', 'failed', 'cancelled', 'uncertain'].includes(String(one.status)) && Number.isSafeInteger(one.revision) && typeof one.createdAt === 'string' && (one.requestId === null || typeof one.requestId === 'string') && (one.turnId === null || Number.isSafeInteger(one.turnId)) && (one.error === null || typeof one.error === 'string');
}
/** The listing a central service answers `list` with; a reply without a well-formed one is no proof of a service. */
function isSnapshot(one: unknown): boolean {
  if (!record(one) || !Array.isArray(one.leads) || !one.leads.every(lead => record(lead) && typeof lead.id === 'string' && typeof lead.name === 'string') || !Array.isArray(one.conversations) || !one.conversations.every(conversation => record(conversation) && typeof conversation.id === 'string' && typeof conversation.leadId === 'string' && typeof conversation.title === 'string') || !(one.selected === null || record(one.selected) && typeof one.selected.id === 'string' && typeof one.selected.leadId === 'string' && typeof one.selected.title === 'string') || !Array.isArray(one.participants) || !one.participants.every(participant => record(participant) && typeof participant.account === 'string' && ['viewer', 'contributor', 'manager'].includes(String(participant.role)) && typeof participant.active === 'boolean') || !Array.isArray(one.messages) || !one.messages.every(isMessage) || typeof one.canManage !== 'boolean' || typeof one.canSend !== 'boolean' || !Number.isSafeInteger(one.cursor) || typeof one.truncated !== 'boolean' || !strings(one.projects) || !strings(one.accounts)) return false;
  if (one.chatAuthorization !== undefined) {
    const grant = one.chatAuthorization;
    if (!record(grant) || typeof grant.enabled !== 'boolean' || !(grant.provider === null || typeof grant.provider === 'string') || !(grant.model === null || typeof grant.model === 'string') || !Number.isSafeInteger(grant.dailyTurns) || ![grant.weeklyCeilingUsd, grant.conversationCeilingUsd].every(amount => amount === null || typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) || typeof grant.termsDigest !== 'string') return false;
  }
  if (one.tasks !== undefined) {
    const tasks = one.tasks;
    if (!record(tasks) || !record(tasks.totals) || !['all', 'needs-you', 'running', 'completed'].every(key => Number.isSafeInteger((tasks.totals as Record<string, unknown>)[key])) || !Array.isArray(tasks.items) || !tasks.items.every(task => record(task) && typeof task.rootId === 'string' && typeof task.activeTaskId === 'string' && typeof task.title === 'string' && record(task.status) && typeof task.status.label === 'string') || !(tasks.nextCursor === null || typeof tasks.nextCursor === 'string')) return false;
  }
  if (one.proposals !== undefined && (!Array.isArray(one.proposals) || !one.proposals.every(proposal => record(proposal) && Number.isSafeInteger(proposal.id) && typeof proposal.title === 'string' && typeof proposal.state === 'string' && typeof proposal.href === 'string'))) return false;
  return true;
}
/** The server must accept the credential before it is saved: one read of POST /api/team, never retried. A success
 * proves itself with a well-formed listing, as the central `list` it is. */
async function verify(profile: Profile, options: ConnectOptions): Promise<ConnectReply> {
  const unconfirmed: ConnectReply = { version: 1, ok: false, code: 'service-unavailable', message: 'The service response could not be read.' };
  try {
    const response = await (options.fetch ?? fetch)(`${profile.origin}/api/team`, { method: 'POST', redirect: 'manual', credentials: 'omit', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), headers: { authorization: bearerOf(profile), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ operation: 'list', args: {} }) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return unconfirmed; }
    if (response.status === 429) { await response.body?.cancel(); return { ...unconfirmed, code: 'rate-limited', message: 'Request limit reached. Try again shortly.' }; }
    const payload = await responseBody(response);
    if (!record(payload) || payload.version !== 1 || typeof payload.ok !== 'boolean' || typeof payload.code !== 'string' || typeof payload.message !== 'string' || payload.snapshot !== undefined && !isSnapshot(payload.snapshot) || payload.ok && !response.ok) return unconfirmed;
    if (payload.ok && payload.snapshot === undefined) return unconfirmed;
    return { version: 1, ok: payload.ok, code: payload.code, message: payload.message };
  } catch { return unconfirmed; }
}

/** `toolroll connect …`; null for every other command. Nothing here opens a database. */
export async function maybeRunConnectCommand(argv: readonly string[], write: (line: string) => void, options: ConnectOptions = {}): Promise<number | null> {
  if (argv[0] !== 'connect') return null;
  const json = argv.includes('--json');
  let secret = '';
  const stderr = (line: string) => (options.stderr ?? (line => process.stderr.write(`${line}\n`)))(text(secret ? line.replaceAll(secret, '[redacted]') : line));
  const emit = (reply: ConnectReply) => {
    // A server's words can echo the credential it was sent: every string it says is redacted before it is shown.
    const safe = JSON.parse(JSON.stringify(reply, (_key, one: unknown) => typeof one === 'string' && secret ? one.replaceAll(secret, '[redacted]') : one)) as ConnectReply;
    write(json ? envelopeJson({ ...safe, command: 'team connect' }) : text(safe.message));
  };
  try {
    // D5: `connect` belongs to the deprecated central team service; it still saves the profile remote commands use.
    stderr(deprecationWarning('connect', 'team'));
    if (argv.includes('--help')) { write(HELP); return 0; }
    const { flags, positions } = parse(argv);
    if (flags.help) { write(HELP); return 0; }
    const profileName = value(flags, 'profile') || 'default';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profileName)) throw new UsageError('Profile names use 1–64 letters, digits, underscores or hyphens.');
    let origin: string;
    try { origin = serviceOrigin(positions[0]!); } catch { throw new UsageError('Use an HTTPS service origin (loopback HTTP is allowed), without credentials, paths, query or fragment.'); }
    if (['token-stdin', 'token-file', 'local-login'].filter(name => flags[name]).length !== 1) throw new UsageError('Choose one credential source: --token-stdin, --token-file or --local-login.');
    if (flags['login-file'] && !flags['local-login']) throw new UsageError('--login-file requires --local-login.');
    let account = value(flags, 'as');
    if (flags['local-login']) {
      const login = privateFile(value(flags, 'login-file') || join(dirname(databasePath(options.env ?? process.env, options.home ?? homedir())), 'up-login.txt'), 8192).trim().split(/\s+/);
      if (login.length !== 2 || account && account !== login[0]) throw new UsageError('The local sign-in does not match the requested account.');
      account = login[0]!; secret = login[1]!;
    } else secret = (flags['token-file'] ? privateFile(value(flags, 'token-file'), 8192) : await (options.readStdin ?? stdinSecret)()).trim();
    if (!accountValid(account) || !tokenValid(secret)) throw new UsageError('Provide an account name and a valid sign-in secret from your selected source.');
    if (parseApiToken(secret) === null) stderr(PASSWORD_PROFILE_WARNING);
    const profile = { origin, account, token: secret }, checked = await verify(profile, options);
    if (!checked.ok) { emit(checked); return 1; }
    saveProfile(options, profileName, profile);
    emit({ version: 1, ok: true, code: 'connected', message: `Connected to ${origin} as ${account}.`, result: { profile: profileName, origin, account } }); return 0;
  } catch (error) {
    const reply: ConnectReply = { version: 1, ok: false, code: 'usage', message: error instanceof UsageError ? error.message : 'The connection could not be prepared. Check the private profile and credential files.' };
    if (json) emit(reply); else stderr(text(reply.message)); return 2;
  }
}
