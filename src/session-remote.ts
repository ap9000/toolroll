import { realpathSync } from 'node:fs';
import type { Store } from './store.js';
import type { CodingWorkspace } from './coding-workspace.js';
import { envelopeJson } from './envelope.js';
import { REMOTE_MESSAGES, reproveRemote, type Principal } from './operate-remote.js';
import { SESSION_RESPONSE_BYTES, isSessionResponse, type SessionDescriptor, type SessionResponse } from './session-contract.js';
import { parseSessionArguments, renderSessionResponse, sessionExitCode, sessionRequestOf } from './session-cli.js';
import { SessionService } from './session-service.js';

/**
 * The server half of `toolroll session …` over `POST /api/cli` (D7, replacing the separate /api/sessions transport and
 * its password sign-in). /api/cli has already proved the API token and charged its budget; this binds the token's
 * person to the existing session owner, which rechecks the account and project on every operation. Native sessions
 * stay installation-wide operator authority: only an instance operator's act token, limited to no projects, may
 * change one. Every request is in the action ledger like any remote command, and every answer is one session
 * envelope: a mutation whose outcome is unknown says so, and is never retried here.
 */
export type SessionRunner = (principal: Principal, argv: readonly string[], files: Readonly<Record<string, string>>, write: (line: string) => void) => Promise<number>;

export function createSessionRunner(options: {
  store: Store;
  workspace: CodingWorkspace | null;
  projects: () => readonly string[];
  projectAllowed: (repo: string) => boolean;
  clock?: () => Date;
}): SessionRunner {
  const { store } = options;
  const clock = options.clock ?? (() => new Date());
  const authorized = (actor: { name: string; generation: number }, repo?: string): boolean => {
    const account = store.accountOf(actor.name);
    return account !== null && account.revokedAt === null && account.generation === actor.generation && store.isInstanceOperator(actor.name)
      && (repo === undefined || (options.projectAllowed(repo) && options.projects().includes(repo)));
  };
  const service = options.workspace === null || store.isDemo() ? null : new SessionService({ workspace: options.workspace, authorized,
    project: (actor, input) => {
      const path = realpathSync(input);
      if (!authorized(actor, path) || !options.projects().includes(path)) throw Error('Choose a project already admitted to this installation.');
      return path;
    },
  });

  return async (principal, argv, files, write) => {
    const json = argv.includes('--json');
    const parsed = parseSessionArguments(argv.slice(1), 'server');
    const operation = 'problem' in parsed ? null : parsed.spec.operation;
    const command = `session ${operation ?? '(unknown)'}`;
    let tokenName: string | null = null;
    const record = (outcome: string, repo: string | null, why: string | null): void => {
      store.recordAction({ at: clock().toISOString(), actor: principal.account, repo, taskId: null, runId: null, action: `remote command: ${command}`, outcome, source: 'api',
        detail: `token ${tokenName ?? principal.tokenId}${why === null ? '' : ` · ${why}`}` });
    };
    const answer = (response: SessionResponse): number => {
      write(json ? envelopeJson({ ...response, command }) : renderSessionResponse(response));
      return sessionExitCode(response);
    };
    const refuse = (spec: SessionDescriptor | null, reason: string, message: string): number => {
      record('refused', null, reason);
      if (spec === null) { write(json ? envelopeJson({ ok: false, command, reason, message }) : message); return 2; }
      return answer({ version: 1, operation: spec.operation, ok: false, status: 'rejected', delivery: 'not-sent', retry: spec.mutation ? 'never' : 'safe-read', reason, message, nextActions: [] });
    };

    const proved = reproveRemote(store, principal, clock());
    if (!proved.ok) return refuse('problem' in parsed ? null : parsed.spec, 'unauthenticated', REMOTE_MESSAGES.stale);
    tokenName = proved.tokenName;
    if ('problem' in parsed) return refuse(null, 'usage', parsed.problem);
    const { spec } = parsed;
    if (spec.mutation && proved.scope !== 'act') return refuse(spec, 'read-only', REMOTE_MESSAGES.read);
    // A session reaches every project this installation admits: a project-limited token never stands for that.
    if (principal.projects !== null || !store.isInstanceOperator(principal.account)) return refuse(spec, 'all-projects', 'Native sessions need instance operator access to every project. Use a token without a project limit.');
    const file = parsed.flags['file'];
    if (file !== undefined && (typeof file !== 'string' || !Object.hasOwn(files, file))) return refuse(spec, 'usage', REMOTE_MESSAGES.files);
    const validated = sessionRequestOf(parsed, typeof file === 'string' ? files[file] : undefined);
    if (!validated.ok) return refuse(spec, 'invalid-request', validated.message);
    if (service === null) return refuse(spec, 'session-unavailable', 'The session owner is not ready.');
    const repo = 'project' in validated.request && spec.operation === 'start' ? (validated.request as { project: string }).project : null;
    record('requested', repo, null);

    const uncertain = (reason: string, message: string): SessionResponse => {
      const sessionId = 'sessionId' in validated.request ? validated.request.sessionId : undefined;
      return { version: 1, operation: spec.operation, ok: false, status: 'uncertain', delivery: 'unknown', retry: 'inspect-first', reason, message,
        nextActions: [{ operation: sessionId ? 'show' : 'list', label: sessionId ? 'Inspect session' : 'Inspect saved sessions', ...(sessionId ? { sessionId } : {}) }] };
    };
    let reply: SessionResponse;
    try {
      reply = await service.execute({ name: principal.account, generation: principal.generation }, spec.operation, validated.request);
      if (!isSessionResponse(reply, spec.operation)) throw new Error('Invalid owner response');
      if (Buffer.byteLength(JSON.stringify(reply)) > SESSION_RESPONSE_BYTES) reply = uncertain('response-too-large', 'The owner response is too large to deliver. Inspect saved activity before continuing; this request was not retried.');
    } catch {
      reply = uncertain('unconfirmed-response', 'The owner response could not be confirmed. Inspect saved activity before continuing; this request was not retried.');
    }
    record(reply.ok ? 'done' : reply.status === 'uncertain' ? 'failed' : 'refused', repo, reply.ok ? null : reply.reason ?? null);
    return answer(reply);
  };
}
