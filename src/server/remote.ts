import type { Registration } from './handler-registry.js';
/** tasks handlers, moved without changing their route bodies. */
import { type IncomingMessage,type ServerResponse } from "node:http";
import { handleCliHttp,type RunOperateAs } from '../cli-http.js';
import { CodingWorkspace } from '../coding-workspace.js';
import { createMcpHttp } from "../mcp-http.js";
import { createOAuthHttp,resourceMetadataUrl } from "../mcp-oauth.js";
import { reproveRemote,type Principal } from "../operate-remote.js";
import {
rowVisible
} from "../project.js";
import { RequestBudget,SourceAdmission,type Admission } from "../request-budget.js";
import { authenticateAccount } from "../scope.js";
import { createSessionEndpoint } from '../session-server.js';
import {
type Store
} from "../store.js";
import type { TeamResponse } from '../team-contract.js';
import { handleTeamHttp, TEAM_PASSWORD_REVERIFY_MS } from '../team-http.js';
import { handleTeamsHttp } from "../teams.js";
import type { EdgeContext } from './handler-context.js';
import { flowHook,telegramHook,type RemoteHookContext } from "./remote-hooks.js";
import { respond,type ServeOptions,type Who } from "./shared.js";

export interface RemoteRuntime {
  identify: (request: IncomingMessage, touch?: boolean, limited?: boolean, refusedToken?: { principal?: Principal; }) => Who | null;
  store: Store;
  admitPasswordSource: (request: IncomingMessage) => Admission;
  admitBearer: (request: IncomingMessage, actor: { name: string; principal?: Principal; }) => Admission;
  allowedHost: (host: string | undefined) => boolean;
  team: { execute: import("../team-contract.js").TeamExecute; start: () => void; close: () => Promise<void>; pass: () => Promise<void>; cursor: (actor: import("../team-contract.js").TeamActor, conversationId?: string) => number | null; domain: import("../team-leads.js").TeamLeads; };
  teamBrowserReply: (reply: TeamResponse, actor: { name: string; generation: number; }, csrf: string) => TeamResponse;
  teamStreams: Set<ServerResponse<IncomingMessage>>;
  requestBudget: RequestBudget;
  options: ServeOptions;
  coding: CodingWorkspace | null;
  codingProjects: () => string[];
  liveCeiling: () => { repos: string[]; roots: readonly string[]; };
  clock: () => Date;
  evidenceRoot: string;
  consoleOrigin: (host: string | undefined) => string | null;
  managedRepos: () => string[];
  joinSourceOf: (request: IncomingMessage) => string;
  ssoSettings: () => import("../oidc.js").OidcSettings | null;
  SSO_FRESH_MS: number;
  oauthTokenBudget: SourceAdmission;
  hookContext: RemoteHookContext;
  teamsSourceBudget: SourceAdmission;
  teamsTenantBudget: SourceAdmission;
}
export function createRemoteHandlers(runtime: RemoteRuntime) {
  const { identify, store, admitPasswordSource, admitBearer, allowedHost, team, teamBrowserReply, teamStreams, requestBudget, options, coding, codingProjects, liveCeiling, clock, evidenceRoot, consoleOrigin, managedRepos, joinSourceOf, ssoSettings, SSO_FRESH_MS, oauthTokenBudget, hookContext, teamsSourceBudget, teamsTenantBudget } = runtime;

  /**
   * The full principal a live `so_` API token stands for: its person and their generation, the token's own read/act
   * scope, its project limit narrowed by the person's current access, and its id. Every route that accepts an API token
   * builds its identity here and carries it whole, so no route can drop the token's narrower scope or projects.
   */
  const tokenPrincipalOf = (request: IncomingMessage): Principal | null => {
    const who = identify(request, false, true);
    return who?.via === "bearer" ? who.principal ?? null : null;
  };
  const presentsToken = (request: IncomingMessage): boolean => /^Bearer so_\S+$/.test(request.headers.authorization ?? "");
  /** When each live request's password bearer last proved its password: kept only while the request is. */
  const passwordProvedAt = new WeakMap<IncomingMessage, number>();
  const teamEndpoint = (request: IncomingMessage, response: ServerResponse) => handleTeamHttp(request, response, {
    authenticate: request => {
      if (presentsToken(request)) {
        const principal = tokenPrincipalOf(request);
        return principal === null ? null : { name: principal.account, generation: principal.generation, principal };
      }
      const who = identify(request, request.method === 'POST');
      const account = who === null ? null : store.accountOf(who.name);
      if (!who || !account || account.revokedAt !== null) return null;
      if (who.via === 'bearer') passwordProvedAt.set(request, clock().getTime());
      return { name: who.name, generation: account.generation, role: account.role };
    },
    admit: admitPasswordSource,
    admitAuthenticated: admitBearer,
    revalidate: (request, actor) => {
      const account = store.accountOf(actor.name);
      if (!account || account.revokedAt !== null || account.generation !== actor.generation) return false;
      // An API token is re-proved against the store every time: unrevoked, unexpired, inside its project limit.
      if (actor.principal !== undefined) {
        const live = reproveRemote(store, actor.principal, new Date());
        if (!live.ok) return false;
        // The post-body mutation check must see a scope lowered since authentication, too.
        actor.principal = { ...actor.principal, scope: live.scope };
        return true;
      }
      // A password bearer was proved when this connection opened, and is proved again (the password checked, through
      // the same per-source tries and locks) once TEAM_PASSWORD_REVERIFY_MS has passed since. Cookie expiry/revocation
      // is rechecked without allowing a passive stream to extend its lifetime.
      if (request.headers.authorization) {
        const now = clock().getTime(), provedAt = passwordProvedAt.get(request);
        if (provedAt !== undefined && now - provedAt < TEAM_PASSWORD_REVERIFY_MS) return true;
        const who = identify(request, false);
        if (who?.via !== 'bearer' || who.name !== actor.name || who.generation !== actor.generation) return false;
        passwordProvedAt.set(request, now);
        return true;
      }
      const who = identify(request, false);
      return who?.name === actor.name && who.via === 'cookie' && who.session.generation === actor.generation;
    },
    authorizeMutation: (request, actor) => {
      if (actor.principal !== undefined) return request.headers.origin === undefined;
      const who = identify(request, false);
      if (!who || who.name !== actor.name) return false;
      if (who.via === 'bearer') return request.headers.origin === undefined;
      const origin = request.headers.origin, referer = request.headers.referer;
      const named = typeof origin === 'string' && origin !== 'null' ? origin : typeof referer === 'string' ? referer : null;
      if (named !== null && !allowedHost(named.replace(/^https?:\/\//, '').split('/')[0])) return false;
      return request.headers['x-csrf-token'] === who.session.csrf;
    },
    execute: async (actor, input) => {
      const reply = await team.execute(actor, input);
      if (actor.principal !== undefined) return reply;
      const who = identify(request, false);
      return who?.via === 'cookie' ? teamBrowserReply(reply, actor, who.session.csrf) : reply;
    }, cursor: team.cursor, streams: teamStreams,
  });
  // Remote CLI: one live API token names the person; the shared command boundary decides everything else.
  const cliEndpoint = (request: IncomingMessage, response: ServerResponse) => handleCliHttp(request, response, {
    admit: principal => requestBudget.admit(principal.tokenId, "api"),
    authenticate: tokenPrincipalOf,
    run: async () => options.cliRunner ?? ((await import("../operate.js")) as { runOperateAs?: RunOperateAs }).runOperateAs ?? null,
    modeOf: options.cliModeOf,
    store,
  });
  const sessionEndpoint = createSessionEndpoint({ store, workspace: coding, projects: codingProjects, projectAllowed: repo => rowVisible(liveCeiling(), repo),
    admit: admitPasswordSource, admitAuthenticated: admitBearer });

  const mcpHttp = createMcpHttp({ store, clock, evidenceRoot, ...(options.requestBudgetClock === undefined ? {} : { requestBudgetClock: options.requestBudgetClock }), signedIn: request => identify(request, true, true) !== null, admit: person => requestBudget.admit(person.principal.tokenId, "mcp"),
    resourceMetadata: request => { const origin = consoleOrigin(request.headers.host); return origin === null ? null : resourceMetadataUrl(origin); },
    enrolled: () => [...new Set([...managedRepos(), ...store.listProjects().map(project => project.path)])], ...(options.runOperateAs === undefined ? {} : { runAs: options.runOperateAs }) });

  // MCP sign-in: the console's own sign-in and step-up, a same-site consent form, and the person's current projects.
  const oauthHttp = createOAuthHttp({ store, clock,
    originOf: request => consoleOrigin(request.headers.host),
    requesterKey: joinSourceOf,
    session: request => {
      const who = identify(request, false);
      if (who === null || who.via !== "cookie") return null;
      return { name: who.name, role: who.role, csrf: who.session.csrf,
        sso: who.session.sso === undefined ? null : { label: ssoSettings()?.label ?? "your identity provider", fresh: Date.now() - who.session.sso.at < SSO_FRESH_MS } };
    },
    sameSite: request => {
      const origin = request.headers.origin, referer = request.headers.referer;
      const named = typeof origin === "string" && origin !== "null" ? origin : typeof referer === "string" ? referer : null;
      return named !== null && allowedHost(named.replace(/^https?:\/\//, "").split("/")[0]);
    },
    // The step-up for a credential: the person's password, or (empty) a fresh identity-provider check. What they may
    // grant (their role, their projects) is checked beside it.
    confirm: (session, typed) => typed === "" ? session.sso?.fresh === true : authenticateAccount(store, session.name, typed).ok,
    projectsFor: account => store.knownRepos().filter(repo => store.accountCanAccess(account, repo)).sort(),
    admitToken: request => oauthTokenBudget.admit(joinSourceOf(request)),
  });
  async function edge(ctx: EdgeContext): Promise<void> {
    const { request, response, url, route } = ctx;
    switch (route.id) {
      case 'edge.telegram-hook': return telegramHook(hookContext, request, response);
      case 'edge.flow-hook': case 'edge.flow-form': case 'edge.flow-form-send': return flowHook(hookContext, request, response, url);
      case 'edge.mcp': return mcpHttp(request, response);
      case 'edge.oauth-discovery': case 'edge.oauth-register': case 'edge.oauth-token': case 'edge.oauth-authorize': case 'edge.oauth-consent':
        await oauthHttp(request, response, url); return;
      // D5: native coding sessions and the central team service are deprecated (still served this release); each
      // answer says so in a Deprecation header (RFC 9745).
      case 'edge.sessions-list': case 'edge.sessions-show': case 'edge.sessions-changes': case 'edge.sessions-start': case 'edge.sessions-send': case 'edge.sessions-stop': case 'edge.sessions-resume': case 'edge.sessions-recover':
        response.setHeader('Deprecation', 'true'); await sessionEndpoint(request, response); return;
      case 'edge.team-read': case 'edge.team-send': case 'edge.team-events': response.setHeader('Deprecation', 'true'); await teamEndpoint(request, response); return;
      case 'edge.cli': await cliEndpoint(request, response); return;
      case 'edge.teams':
        if (options.configDir !== undefined && await handleTeamsHttp(request, response, { store, dir: options.configDir, ...(options.teamsFetcher ? { fetcher: options.teamsFetcher } : {}), clock,
          admitSource: request => teamsSourceBudget.admit(joinSourceOf(request)), admitTenant: tenant => teamsTenantBudget.admit(tenant) })) return;
        return respond(response, 404, 'text/plain; charset=utf-8', 'No such address.');
    }
    throw new Error('Unregistered remote route');
  }
  const registrations: Registration[] = [
    { id: "edge.telegram-hook", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.flow-form", domain: "remote", stage: "edge", method: "GET,HEAD", handle: edge },
    { id: "edge.flow-form-send", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.flow-hook", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.mcp", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.oauth-discovery", domain: "remote", stage: "edge", method: "GET,HEAD", handle: edge },
    { id: "edge.oauth-register", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.oauth-token", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.oauth-authorize", domain: "remote", stage: "edge", method: "GET,HEAD", handle: edge },
    { id: "edge.oauth-consent", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-list", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-show", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-changes", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-start", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-send", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-stop", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-resume", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.sessions-recover", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.team-read", domain: "remote", stage: "edge", method: "GET", handle: edge },
    { id: "edge.team-send", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.team-events", domain: "remote", stage: "edge", method: "GET", handle: edge },
    { id: "edge.cli", domain: "remote", stage: "edge", method: "POST", handle: edge },
    { id: "edge.teams", domain: "remote", stage: "edge", method: "POST", handle: edge },
  ];
  return { registrations, edge };
}
