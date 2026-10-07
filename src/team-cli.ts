import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { envelopeJson } from './envelope.js';
import { sessionServiceOrigin } from './session-cli.js';
import { databasePath } from './store.js';
import type { TeamChatAuthorization, TeamMessage, TeamOperation, TeamRequest, TeamResponse, TeamSnapshot } from './team-contract.js';
import { configBase, namedPath } from './names.js';
import { parseApiToken } from './api-tokens.js';

export type TeamCliOptions = {
  fetch?: typeof fetch; env?: NodeJS.ProcessEnv; home?: string; profileFile?: string;
  readStdin?: () => Promise<string>; readLine?: (prompt: string) => Promise<string | null>;
  isTTY?: boolean; stderr?: (line: string) => void; signal?: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
export const TEAM_CLI_ACTIONS = ['connect', 'lead list', 'lead create', 'lead update', 'lead member', 'lead transfer', 'conversation list', 'conversation create', 'conversation show', 'conversation member', 'conversation edit', 'conversation withdraw', 'conversation read', 'conversation follow', 'conversation stop'] as const;
const HELP = `toolroll connect <HTTPS-origin> --as <account> --token-stdin
  Pipe your API token (so_…, from Settings → API tokens) or use --token-file <private-file>;
  --local-login uses your existing local sign-in for chat only.
  With an API token saved, other commands run on that server as you (--local runs here).
  Optional: --profile <name> (saved as the active profile).
toolroll lead list|create|update|member|transfer [--profile <name>] [--json]
  create: --name <name> --instructions <text> --project <server-path> (repeatable)
  update: --lead <id> --revision <number> with --name, --instructions or --status
  member: --lead <id> --account <name> --role viewer|contributor|manager
          --active true|false --revision <lead-revision>
  transfer: --task <id> --lead <id> --revision <number>
toolroll conversation list|create|show|member|edit|withdraw|read|follow|stop
  list: [--lead <id>]
  create: --lead <id> --title <title> --visibility private|team --project <server-path>
  member: --conversation <id> --account <name> --role viewer|contributor|manager
          --active true|false --revision <conversation-revision>
  edit/withdraw: --conversation <id> --message <id> --revision <message-revision> [--text <text>]
  read/stop: --conversation <id> --message <id>
  follow: --conversation <id> --enabled true|false (automatic summaries within authorized limits)
toolroll chat --lead <id> --conversation <id> [--say <text>] [--follow] [--json]
  Without --say, a terminal opens interactive chat. --follow only reads updates.
  Enable paid chat with --authorize --terms-digest <digest> after reviewing its terms.
  --request-id <32-hex-id> identifies one message; after a lost response, inspect it
  with brief --conversation <id> --request-id <id>, without sending it again.
toolroll brief --lead <id> --conversation <id> [--json]

Saved profiles select the central service for chat and brief. Use --local for the
existing local commands. Credentials stay in a private file, never in URLs or arguments.
Reads and attachment do not start model work. Server permissions remain authoritative.`;
export class UsageError extends Error {}
type Profile = { origin: string; account: string; token: string };
type Profiles = { version: 1; active: string; profiles: Record<string, Profile> };
type Flags = Record<string, string | true | string[]>;
/** Transport metadata stays local to the CLI; only an actual HTTP 429 permits a follower read retry. */
const RETRY_AFTER_MS = Symbol('retry-after-ms');
type TeamReply = TeamResponse & { [RETRY_AFTER_MS]?: number };
type TeamCall = (operation: TeamOperation, args: Record<string, unknown>, signal?: AbortSignal) => Promise<TeamReply>;
function retryDelay(header: string | null): number {
  const raw = header?.trim() ?? '';
  const delay = /^\d+$/.test(raw) ? Number(raw) * 1000
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(raw) ? Date.parse(raw) - Date.now() : NaN;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(1000, Math.min(300_000, delay)) : 5000;
}
const value = (flags: Flags, name: string): string => typeof flags[name] === 'string' ? flags[name] as string : '';
const required = (flags: Flags, name: string): string => { const result = value(flags, name); if (!result) throw new UsageError(`--${name} is required.`); return result; };
const number = (flags: Flags, name: string): number => { const result = required(flags, name); if (!/^\d+$/.test(result) || !Number.isSafeInteger(Number(result))) throw new UsageError(`--${name} must be a whole number.`); return Number(result); };
const bool = (flags: Flags, name: string): boolean => { const result = required(flags, name); if (!['true', 'false'].includes(result)) throw new UsageError(`--${name} must be true or false.`); return result === 'true'; };
const text = (raw: string): string => raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
const strings = (input: unknown): input is string[] => Array.isArray(input) && input.every(one => typeof one === 'string');
const accountValid = (input: string): boolean => !!input && input.length <= 200 && !/[\s:\x00-\x1f\x7f]/.test(input);
const tokenValid = (input: string): boolean => !!input && input.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(input);
const profilePath = (options: TeamCliOptions): string => options.profileFile ?? namedPath(configBase(options.env ?? process.env, options.home ?? homedir()), ['remote', 'profiles.json']);

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
function profiles(options: TeamCliOptions): Profiles | null {
  const path = profilePath(options);
  // lstat distinguishes a dangling symlink from a missing profile.
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new UsageError('The remote profile cannot be read.'); }
  const raw = privateFile(path, 128 * 1024);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== 1 || typeof parsed.active !== 'string' || !record(parsed.profiles)) throw new Error();
    for (const [name, one] of Object.entries(parsed.profiles)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !record(one) || typeof one.origin !== 'string' || sessionServiceOrigin(one.origin) !== one.origin || typeof one.account !== 'string' || !accountValid(one.account) || typeof one.token !== 'string' || !tokenValid(one.token)) throw new Error();
    }
    if (!Object.hasOwn(parsed.profiles, parsed.active)) throw new Error();
    return parsed as Profiles;
  } catch { throw new UsageError('The remote profile is invalid. Connect again using a private credential source.'); }
}
function saveProfile(options: TeamCliOptions, name: string, profile: Profile): void {
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
export function centralProfile(options: TeamCliOptions, name?: string): { name: string; origin: string; account: string; token: string; apiToken: boolean } | null {
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
function parse(argv: readonly string[]): { command: string; action: string; flags: Flags; positions: string[] } {
  const command = argv[0] ?? '', action = ['lead', 'conversation'].includes(command) ? argv[1] ?? '' : '';
  const start = action ? 2 : 1;
  const common = ['profile', 'json', 'help'];
  const allowed = new Set([...common, ...(command === 'connect' ? ['as', 'token-stdin', 'token-file', 'local-login', 'login-file'] : command === 'chat' ? ['lead', 'conversation', 'say', 'follow', 'authorize', 'terms-digest', 'request-id'] : command === 'brief' ? ['lead', 'conversation', 'request-id'] : command === 'lead' ? action === 'list' ? [] : action === 'create' ? ['name', 'instructions', 'project'] : action === 'update' ? ['lead', 'revision', 'name', 'instructions', 'status'] : action === 'member' ? ['lead', 'account', 'role', 'active', 'revision'] : action === 'transfer' ? ['task', 'lead', 'revision'] : [] : action === 'list' ? ['lead'] : action === 'create' ? ['lead', 'title', 'visibility', 'project'] : action === 'member' ? ['conversation', 'account', 'role', 'active', 'revision'] : action === 'edit' ? ['conversation', 'message', 'revision', 'text'] : action === 'withdraw' ? ['conversation', 'message', 'revision'] : action === 'read' || action === 'stop' ? ['conversation', 'message'] : action === 'follow' ? ['conversation', 'enabled'] : ['conversation'])]);
  const switches = new Set(['json', 'help', 'token-stdin', 'local-login', 'follow', 'authorize']);
  const flags: Flags = {}, positions: string[] = [];
  for (let index = start; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) { positions.push(arg); continue; }
    const name = arg.slice(2);
    if (!allowed.has(name)) throw new UsageError('Unsupported option. Use --help for this command; secrets must come from stdin or a private file.');
    if (Object.hasOwn(flags, name) && name !== 'project') throw new UsageError(`Use --${name} only once.`);
    if (switches.has(name)) flags[name] = true;
    else {
      const next = argv[++index]; if (!next || next.startsWith('--')) throw new UsageError(`--${name} needs a value.`);
      if (name === 'project') flags[name] = [...(Array.isArray(flags[name]) ? flags[name] : []), next]; else flags[name] = next;
    }
  }
  if (positions.length !== (command === 'connect' ? 1 : 0) && !flags.help) throw new UsageError(command === 'connect' ? 'Name one service origin.' : 'Use named options for this command.');
  return { command, action, flags, positions };
}
function isMessage(one: unknown): one is TeamMessage {
  return record(one) && Number.isSafeInteger(one.id) && typeof one.author === 'string' && ['operator', 'assistant'].includes(String(one.role)) && typeof one.text === 'string' && ['queued', 'running', 'answered', 'failed', 'cancelled', 'uncertain'].includes(String(one.status)) && Number.isSafeInteger(one.revision) && typeof one.createdAt === 'string' && (one.requestId === null || typeof one.requestId === 'string') && (one.turnId === null || Number.isSafeInteger(one.turnId)) && (one.error === null || typeof one.error === 'string');
}
function isSnapshot(one: unknown): one is TeamSnapshot {
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
async function responseBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function failure(code: string, message: string, result?: unknown): TeamResponse { return { version: 1, ok: false, code, message, ...(result === undefined ? {} : { result }) }; }
async function perform(profile: Profile, request: TeamRequest, options: TeamCliOptions): Promise<TeamReply> {
  const reading = ['list', 'show'].includes(request.operation);
  const receipt = { operation: request.operation, ...(request.args.conversationId ? { conversationId: request.args.conversationId } : {}), ...(request.args.requestId ? { requestId: request.args.requestId } : {}) };
  const unconfirmed = () => failure(reading ? 'service-unavailable' : 'delivery-unconfirmed', reading ? 'The service response could not be read.' : 'The response could not be confirmed. Inspect saved messages before continuing; this request was not retried.', receipt);
  try {
    const response = await (options.fetch ?? fetch)(`${profile.origin}/api/team`, { method: 'POST', redirect: 'manual', credentials: 'omit', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), headers: { authorization: bearerOf(profile), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return unconfirmed(); }
    if (response.status === 429) {
      await response.body?.cancel();
      return { ...failure('rate-limited', reading ? 'Request limit reached. Try again shortly.' : 'Request limit reached. Inspect saved messages before continuing; this request was not retried.', receipt), [RETRY_AFTER_MS]: retryDelay(response.headers.get('retry-after')) };
    }
    const payload = await responseBody(response);
    if (!record(payload) || payload.version !== 1 || typeof payload.ok !== 'boolean' || typeof payload.code !== 'string' || typeof payload.message !== 'string' || payload.snapshot !== undefined && !isSnapshot(payload.snapshot) || payload.ok && !response.ok) return unconfirmed();
    const reply = payload as TeamResponse;
    if (reply.ok && reading && !reply.snapshot) return unconfirmed();
    if (reply.ok && request.args.conversationId && reply.snapshot && reply.snapshot.selected?.id !== request.args.conversationId) return unconfirmed();
    if (reply.ok && request.operation === 'send' && !reply.snapshot?.messages.some(message => message.requestId === request.args.requestId && message.role === 'operator' && message.author === profile.account && message.text === request.args.text)) return unconfirmed();
    return request.operation === 'send'
      ? { ...reply, result: { ...(record(reply.result) ? reply.result : {}), requestId: request.args.requestId, conversationId: request.args.conversationId } }
      : reply;
  } catch { return unconfirmed(); }
}
function terms(grant: TeamChatAuthorization): string {
  return `Paid chat: ${grant.provider ?? 'not configured'} / ${grant.model ?? 'not configured'}\nDaily turns: ${grant.dailyTurns}\nWeekly ceiling: ${grant.weeklyCeilingUsd === null ? 'not set' : `$${grant.weeklyCeilingUsd}`}\nConversation ceiling: ${grant.conversationCeilingUsd === null ? 'not set' : `$${grant.conversationCeilingUsd}`}\nTerms: ${grant.termsDigest}${grant.waitingReason ? `\n${grant.waitingReason}` : ''}`;
}
function render(reply: TeamResponse, listing?: 'leads' | 'conversations'): string {
  const lines = [reply.message], snapshot = reply.snapshot;
  if (snapshot && listing) {
    if (listing === 'leads') for (const lead of snapshot.leads) lines.push(`${lead.id}  ${lead.name} · ${lead.status} · revision ${lead.revision}`);
    else for (const conversation of snapshot.conversations) lines.push(`${conversation.id}  ${conversation.title} · lead ${conversation.leadId} · ${conversation.visibility} · revision ${conversation.revision}`);
    if (lines.length === 1) lines.push(listing === 'leads' ? 'No leads yet.' : 'No conversations yet.');
    return text(lines.join('\n'));
  }
  if (snapshot) {
    if (snapshot.selected) lines.push(`${snapshot.selected.title} · ${snapshot.selected.id} · revision ${snapshot.selected.revision}`, `Lead: ${snapshot.selected.leadId}`);
    else { for (const lead of snapshot.leads) lines.push(`${lead.id}  ${lead.name}`); for (const conversation of snapshot.conversations) lines.push(`${conversation.id}  ${conversation.title}  (${conversation.leadId})`); }
    for (const message of snapshot.messages) lines.push(`${message.author} · ${message.status} · message ${message.id} · revision ${message.revision}${message.requestId ? ` · request ${message.requestId}` : ''}\n${message.text}${message.error ? `\n${message.error}` : ''}`);
    if (snapshot.tasks) {
      const totals = snapshot.tasks.totals;
      lines.push(`Work: ${totals.all} total · ${totals['needs-you']} need you · ${totals.running} running · ${totals.completed} complete`);
      for (const task of snapshot.tasks.items) lines.push(`${task.activeTaskId}  ${task.status.label}  ${task.title}`);
      if (snapshot.tasks.nextCursor) lines.push('More tasks are available in the browser.');
    }
    for (const proposal of snapshot.proposals ?? []) lines.push(`Proposal ${proposal.id} · ${proposal.state}: ${proposal.title}\n${proposal.href}`);
    if (snapshot.truncated) lines.push('Earlier messages are available in the browser.');
  }
  if (reply.code === 'grant-needed' && snapshot?.chatAuthorization) lines.push(terms(snapshot.chatAuthorization), 'Review these terms, then use --authorize --terms-digest with this exact digest.');
  if (record(reply.result)) {
    for (const [key, label] of [['leadId', 'Lead'], ['conversationId', 'Conversation'], ['taskId', 'Task'], ['messageId', 'Message'], ['revision', 'Revision'], ['requestId', 'Request']] as const) {
      if (typeof reply.result[key] === 'string' || typeof reply.result[key] === 'number') lines.push(`${label}: ${reply.result[key]}`);
    }
  }
  return text(lines.join('\n'));
}

/** null means preserve the existing local command path. Nothing here opens a database. */
export async function maybeRunTeamCommand(argv: readonly string[], write: (line: string) => void, options: TeamCliOptions = {}): Promise<number | null> {
  const command = argv[0];
  // `lead token` is local: the credential a lead agent acts with on this computer.
  if (command === 'lead' && (argv[1] === 'token' || argv[1] === 'say')) return null;
  if (!['connect', 'lead', 'conversation', 'chat', 'brief'].includes(command ?? '') && !argv.includes('--profile')) return null;
  const json = argv.includes('--json');
  let secret = '';
  const stderr = (line: string) => (options.stderr ?? (line => process.stderr.write(`${line}\n`)))(text(secret ? line.replaceAll(secret, '[redacted]') : line));
  const emit = (reply: TeamResponse) => {
    const safe = JSON.parse(JSON.stringify(reply, (_key, one: unknown) => typeof one === 'string' && secret ? one.replaceAll(secret, '[redacted]') : one)) as TeamResponse;
    const listing = argv[1] === 'list' ? command === 'lead' ? 'leads' : command === 'conversation' ? 'conversations' : undefined : undefined;
    write(json ? envelopeJson({ ...safe, command: `team ${command}` }) : render(safe, listing));
  };
  try {
    if (!['connect', 'lead', 'conversation', 'chat', 'brief'].includes(command ?? '')) throw new UsageError('--profile is supported by lead, conversation, chat and brief. No local command was run.');
    if ((command === 'chat' || command === 'brief') && argv.includes('--local')) {
      if (argv.some(arg => ['--profile', '--lead', '--conversation', '--authorize', '--terms-digest', '--request-id'].includes(arg))) throw new UsageError('--local cannot be combined with central team options.');
      return null;
    }
    const explicit = ['connect', 'lead', 'conversation'].includes(command!) || argv.some(arg => ['--profile', '--lead', '--conversation', '--authorize', '--terms-digest', '--request-id'].includes(arg));
    if (explicit && (argv.includes('--help') || ['lead', 'conversation'].includes(command!) && argv.length === 1)) { write(HELP); return 0; }
    const saved = profiles(options);
    if (!explicit && !saved) return null;
    const parsed = parse(argv), { flags, action } = parsed;
    if (flags.help || ((command === 'lead' || command === 'conversation') && !action)) { write(HELP); return 0; }
    const profileName = value(flags, 'profile') || (command === 'connect' ? 'default' : saved?.active ?? 'default');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profileName)) throw new UsageError('Profile names use 1–64 letters, digits, underscores or hyphens.');
    if (command === 'connect') {
      let origin: string;
      try { origin = sessionServiceOrigin(parsed.positions[0]!); } catch { throw new UsageError('Use an HTTPS service origin (loopback HTTP is allowed), without credentials, paths, query or fragment.'); }
      if (['token-stdin', 'token-file', 'local-login'].filter(name => flags[name]).length !== 1) throw new UsageError('Choose one credential source: --token-stdin, --token-file or --local-login.');
      if (flags['login-file'] && !flags['local-login']) throw new UsageError('--login-file requires --local-login.');
      let account = value(flags, 'as');
      if (flags['local-login']) {
        const login = privateFile(value(flags, 'login-file') || join(dirname(databasePath(options.env ?? process.env, options.home ?? homedir())), 'up-login.txt'), 8192).trim().split(/\s+/);
        if (login.length !== 2 || account && account !== login[0]) throw new UsageError('The local sign-in does not match the requested account.');
        account = login[0]!; secret = login[1]!;
      } else secret = (flags['token-file'] ? privateFile(value(flags, 'token-file'), 8192) : await (options.readStdin ?? stdinSecret)()).trim();
      if (!accountValid(account) || !tokenValid(secret)) throw new UsageError('Provide an account name and a valid sign-in secret from your selected source.');
      const profile = { origin, account, token: secret }, checked = await perform(profile, { operation: 'list', args: {} }, options);
      if (!checked.ok) { emit(checked); return 1; }
      saveProfile(options, profileName, profile);
      emit({ version: 1, ok: true, code: 'connected', message: `Connected to ${origin} as ${account}.`, result: { profile: profileName, origin, account } }); return 0;
    }
    const profile = saved?.profiles[profileName];
    if (!profile || !Object.hasOwn(saved!.profiles, profileName)) throw new UsageError('No saved connection. Use connect with your individual sign-in first.');
    secret = profile.token;
    const call: TeamCall = (operation, args, signal) => perform(profile, { operation, args }, { ...options, ...(signal === undefined ? {} : { signal }) });
    if (command === 'chat' || command === 'brief') return await chat(command, flags, profile.account, call, emit, options, stderr);
    let operation: TeamOperation, args: Record<string, unknown> = {};
    if (action === 'list') { operation = 'list'; if (flags.lead) args.leadId = value(flags, 'lead'); }
    else if (command === 'lead') {
      if (action === 'create') { operation = 'create-lead'; args = { name: required(flags, 'name'), instructions: required(flags, 'instructions'), projects: flags.project ?? [] }; }
      else if (action === 'update') { operation = 'update-lead'; args = { leadId: required(flags, 'lead'), expectedRevision: number(flags, 'revision') }; for (const name of ['name', 'instructions', 'status']) if (flags[name]) args[name] = value(flags, name); }
      else if (action === 'member') { operation = 'member'; args = { leadId: required(flags, 'lead'), account: required(flags, 'account'), role: required(flags, 'role'), active: bool(flags, 'active'), expectedRevision: number(flags, 'revision') }; }
      else if (action === 'transfer') { operation = 'transfer'; args = { leadId: required(flags, 'lead'), taskId: required(flags, 'task'), expectedRevision: number(flags, 'revision') }; }
      else throw new UsageError('Choose lead list, create, update, member or transfer.');
    } else if (action === 'create') { operation = 'create-conversation'; args = { leadId: required(flags, 'lead'), title: required(flags, 'title'), visibility: required(flags, 'visibility'), projects: flags.project ?? [] }; }
    else {
      args.conversationId = required(flags, 'conversation');
      if (action === 'show') operation = 'show';
      else if (action === 'member') { operation = 'member'; Object.assign(args, { account: required(flags, 'account'), role: required(flags, 'role'), active: bool(flags, 'active'), expectedRevision: number(flags, 'revision') }); }
      else if (action === 'edit' || action === 'withdraw') { operation = action; Object.assign(args, { messageId: number(flags, 'message'), expectedRevision: number(flags, 'revision'), ...(action === 'edit' ? { text: required(flags, 'text') } : {}) }); }
      else if (action === 'read' || action === 'stop') { operation = action; args.messageId = number(flags, 'message'); }
      else if (action === 'follow') { operation = 'follow'; args.enabled = bool(flags, 'enabled'); }
      else throw new UsageError('Choose a conversation operation from --help.');
    }
    const reply = await call(operation, args); emit(reply); return reply.ok ? 0 : 1;
  } catch (error) { const reply = failure('usage', error instanceof UsageError ? error.message : 'The remote command could not be prepared. Check the private profile and credential files.'); if (json) emit(reply); else stderr(text(reply.message)); return 2; }
}

async function chat(command: string, flags: Flags, account: string, call: TeamCall, emit: (reply: TeamResponse) => void, options: TeamCliOptions, stderr: (line: string) => void): Promise<number> {
  const conversationId = required(flags, 'conversation'), leadId = value(flags, 'lead'), requestId = value(flags, 'request-id');
  if (requestId && !/^[0-9a-f]{32}$/.test(requestId)) throw new UsageError('--request-id must be 32 lowercase hexadecimal characters.');
  if (flags['terms-digest'] && !flags.authorize) throw new UsageError('--terms-digest requires --authorize.');
  if (command === 'chat' && requestId && !flags.say) throw new UsageError('Use brief --request-id to inspect a previous message.');
  const show = async (signal?: AbortSignal): Promise<TeamReply> => {
    const reply = await call('show', { conversationId }, signal);
    if (reply.ok && (!reply.snapshot || reply.snapshot.selected?.id !== conversationId || leadId && reply.snapshot.selected.leadId !== leadId)) return failure('conversation-mismatch', 'The service returned a different conversation or lead. Nothing was sent.');
    return reply;
  };
  let current = await show();
  if (!current.ok) { emit(current); return 1; }
  if (command === 'brief') {
    if (requestId) {
      const message = current.snapshot!.messages.find(one => one.requestId === requestId && one.author === account && one.role === 'operator');
      current = { ...current, result: { requestId, receipt: message ?? null, receiptStatus: message ? 'recorded' : 'not-in-current-page' }, message: message ? `Saved message ${message.id}: ${message.status}.` : 'This request is not in the current message page. Inspect the conversation before sending anything again.' };
    }
    emit(current); return 0;
  }
  const interactive = !flags.say && !flags.follow && !flags.json && (options.isTTY ?? process.stdin.isTTY ?? false);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const readline = interactive && !options.readLine ? createInterface({ input: process.stdin, output: process.stderr, terminal: true }) : undefined;
  const interrupt = () => controller.abort();
  if (interactive || flags.follow) process.once('SIGINT', interrupt);
  const ask = options.readLine ?? (async (prompt: string) => { try { return await readline!.question(prompt, { signal }); } catch { return null; } });
  const observed = new Map<number, string>();
  let observedView = '';
  const viewKey = (reply: TeamResponse) => JSON.stringify(reply.snapshot && { selected: reply.snapshot.selected, participants: reply.snapshot.participants, tasks: reply.snapshot.tasks, proposals: reply.snapshot.proposals, authorization: reply.snapshot.chatAuthorization, canSend: reply.snapshot.canSend });
  const remember = (reply: TeamResponse) => { observedView = viewKey(reply); for (const message of reply.snapshot?.messages ?? []) observed.set(message.id, JSON.stringify(message)); };
  const updated = (reply: TeamResponse) => {
    const changes = reply.snapshot?.messages.filter(message => observed.get(message.id) !== JSON.stringify(message)) ?? [];
    if (changes.length || viewKey(reply) !== observedView) { emit({ ...reply, message: 'Conversation updated.', snapshot: { ...reply.snapshot!, messages: changes } }); remember(reply); }
  };
  const authorize = async (explicit: boolean): Promise<boolean> => {
    const grant = current.snapshot?.chatAuthorization;
    if (grant?.enabled) return true;
    if (!grant) { emit(failure('grant-unavailable', 'Paid chat terms are unavailable. Open this conversation in the browser.')); return false; }
    if (explicit) {
      if (value(flags, 'terms-digest') !== grant.termsDigest) { emit({ ...failure('grant-needed', 'Review the current paid chat terms before enabling chat.'), snapshot: current.snapshot! }); return false; }
    } else if (interactive) {
      stderr(text(terms(grant)));
      if ((await ask('Enable paid chat with these terms? [y/N] '))?.trim().toLowerCase() !== 'y') return false;
    } else { emit({ ...failure('grant-needed', 'Enable paid chat before sending a message.'), snapshot: current.snapshot! }); return false; }
    const reply = await call('authorize', { conversationId, termsDigest: grant.termsDigest });
    if (!reply.ok || !reply.snapshot?.chatAuthorization?.enabled) { emit(reply.ok ? failure('grant-unconfirmed', 'Chat authorization was not confirmed. Inspect the conversation before continuing.') : reply); return false; }
    current = reply; return true;
  };
  const send = async (message: string): Promise<boolean> => {
    if (message.length > 2000 || !message.trim()) throw new UsageError('Messages must contain 1–2,000 characters.');
    // Re-read current permissions and terms before each explicit message. Attachment never authorizes.
    current = await show();
    if (!current.ok) { emit(current); return false; }
    if (!await authorize(!!flags.authorize)) return false;
    if (!current.snapshot?.canSend) { emit(failure('forbidden', 'This account cannot send to the selected conversation.')); return false; }
    const id = requestId || randomBytes(16).toString('hex');
    const reply = await call('send', { conversationId, requestId: id, text: message.trim() });
    emit(reply); if (reply.ok) { current = reply; remember(reply); } return reply.ok;
  };
  let pollResult = 0;
  const poll = async () => {
    let waitMs = 2_000;
    while (!signal.aborted) {
      try { await (options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(waitMs, signal); } catch { break; }
      if (signal.aborted) break;
      const next = await show(signal);
      if (signal.aborted) break;
      // Only this follower's read poll retries. Sends, authorizations and uncertain deliveries are never replayed.
      if (!next.ok && next[RETRY_AFTER_MS] !== undefined) { waitMs = next[RETRY_AFTER_MS]; continue; }
      if (!next.ok) { emit(next); pollResult = 1; controller.abort(); break; }
      waitMs = 2_000;
      current = next; updated(next);
    }
  };
  let polling: Promise<void> | undefined;
  try {
    if (flags.say) { if (!await send(required(flags, 'say'))) return 1; }
    else { if (flags.authorize && !await authorize(true)) return 1; emit(current); remember(current); }
    if (flags.follow) { await poll(); return pollResult; }
    if (!interactive) return 0;
    polling = poll();
    while (!signal.aborted) {
      const line = await ask('You> ');
      if (line === null || line.trim() === '/quit') break;
      if (!line.trim()) continue;
      if (!await send(line)) { pollResult = 1; break; }
    }
    return pollResult;
  } finally { controller.abort(); readline?.close(); process.removeListener('SIGINT', interrupt); await polling; }
}
