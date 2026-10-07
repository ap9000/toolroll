import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import type { Store } from './store.js';
import type { CodingWorkspace } from './coding-workspace.js';
import { authenticateAccount } from './scope.js';
import { handleSessionHttp, type SessionHttpActor } from './session-http.js';
import { SessionService } from './session-service.js';
import type { Admission } from './request-budget.js';

/** Bind the transport to createDecisionServer's existing catalog owner and
 * live project admission. No cookie, coordinator token or caller-supplied actor
 * can acquire installation-wide native coding authority through this adapter. */
export function createSessionEndpoint(options: {
  store: Store;
  workspace: CodingWorkspace | null;
  projects: () => readonly string[];
  projectAllowed: (repo: string) => boolean;
  /** The request's source budget (request-budget.ts), charged once before the password is checked. */
  admit?: (request: IncomingMessage) => Admission;
  admitAuthenticated?: (request: IncomingMessage, actor: SessionHttpActor) => Admission;
}): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const { store } = options;
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
  return (request, response) => handleSessionHttp(request, response, {
    ...(options.admit === undefined ? {} : { admit: options.admit }),
    ...(options.admitAuthenticated === undefined ? {} : { admitAuthenticated: options.admitAuthenticated }),
    authenticate: request => {
      const bearer = /^Bearer (.+):(.+)$/.exec(request.headers.authorization ?? '');
      if (!bearer) return null;
      const name = bearer[1]!;
      const authentication = authenticateAccount(store, name, bearer[2]!);
      if (!authentication.ok) return null;
      const actor = { name, generation: authentication.generation };
      return authorized(actor) ? actor : null;
    },
    execute: service === null ? null : (actor, operation, request) => service.execute(actor, operation, request),
  });
}
