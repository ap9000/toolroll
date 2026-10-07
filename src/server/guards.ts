import { OWNER_ACTIONS,sharedActionPayload } from '../chat-actions.js';
import { CONSOLE_FORMS,readForm,type FormFieldOf,type FormView } from "../contracts/console-api.js";
import type { TaskFamily } from "../store.js";

import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage,type ServerResponse } from "node:http";
import { parseApiToken,secretMatches,tokenLive,tokenProjects } from "../api-tokens.js";
import { oauthProjects,oauthTokenAllowed } from "../mcp-oauth.js";
import { REMOTE_MESSAGES,reproveRemote,type Principal } from "../operate-remote.js";
import {
canonicalProject,
rowVisible
} from "../project.js";
import {
authenticateAccount,
authenticateApprover as checkApproverPassword
} from "../scope.js";
import { SourceBudget } from "../sign-in-guard.js";
import {
type Run,
type Store
} from "../store.js";
import type { RouteDeclaration } from './route-table.js';
import { matchTaskPath,PersistentSessions,refuse,requestContext,SESSION_ABSOLUTE_MS,SESSION_COOKIE,SESSION_IDLE_MS,type Session,type Who } from "./shared.js";
/** Shared browser, credential and project guards. Runtime access is lazy to preserve server initialization order. */
export interface GuardsRuntime {
  store: Store;
  liveCeiling: () => { repos: string[]; roots: readonly string[]; };
  codingProjects: () => string[];
  unscopedMode: boolean;
  managedRepos: () => string[];
  ceiling: import("../project.js").ProjectCeiling;
  allowedHost: (host: string | undefined) => boolean;
  defaultProject: string | null;
  actionTarget: (url: URL, who: Who, request: IncomingMessage, body?: FormView<FormFieldOf<"ledgerTarget">> | null) => { repo: string | null; taskId: string | null; runId: number | null; action: string; };
  team: { execute: import("../team-contract.js").TeamExecute; start: () => void; close: () => Promise<void>; pass: () => Promise<void>; cursor: (actor: import("../team-contract.js").TeamActor, conversationId?: string) => number | null; domain: import("../team-leads.js").TeamLeads; };
  joinSourceOf: (request: IncomingMessage) => string;
  signInBudget: SourceBudget;
  passwordAllowed: (name: string) => boolean;
  sessions: PersistentSessions;
}
export function createSharedGuards(runtime: GuardsRuntime) {

  // v99: wrong passwords. One address guessing across names runs out of tries here; each name
  // locks on its own (sign-in-guard.ts), and every lock, whatever road it came by, is kept.
  /**
   * Every step-up in the console (v100): a person the identity provider
   * checked in the last ten minutes confirms with that (an empty password
   * field); anyone else types their password. Standing (an approver, with
   * access to the project) is checked either way.
   */
  // v100: the shared check honours a fresh identity-provider sign-in itself (freshIdentitySignIn, set per request below).
  function authenticateApprover(who: Who, token: string, repo?: string | null): ReturnType<typeof checkApproverPassword> {
    // Re-entering a password never upgrades a machine credential into a browser ceremony.
    if (who.via !== "cookie") return { ok: false, reason: "not-an-approver" };
    return checkApproverPassword(runtime.store, who.name, token, repo);
  }
  // Native tools share the installation's login and can read beyond a project.
  // Account project membership cannot provide an OS read boundary.
  function codingActorAllowed(actor: { name: string; generation: number }): boolean {
    return runtime.store.isInstanceOperator(actor.name) && runtime.store.accountOf(actor.name)?.generation === actor.generation;
  }

  const restricted = (): boolean => {
    const actor = requestContext.getStore()?.actor;
    return actor !== undefined && runtime.store.accountOf(actor)?.projects !== null;
  };
  const visible = (repo: string | null): boolean => {
    const actor = requestContext.getStore()?.actor;
    return rowVisible(runtime.liveCeiling(), repo) && (actor === undefined || runtime.store.accountCanAccess(actor, repo));
  };
  function codingProjectAllowed(repo: string): boolean { return runtime.codingProjects().includes(repo); }
  /** The enumerable admission list for roll-up SQL: repos-only ceilings
   * enumerate themselves; root ceilings enumerate the STORED repos that
   * pass the ceiling (Codex roll-up review, finding 11); unscoped = null. */
  const admissionList = (): string[] | null =>
    restricted() ? [...(runtime.store.accountOf(requestContext.getStore()!.actor!)?.projects ?? [])].filter(visible) : runtime.unscopedMode
      ? null
      : [...new Set([...runtime.managedRepos(), ...(runtime.ceiling.roots.length === 0 ? [] : runtime.store.knownRepos().filter(visible))])];
  /** The task behind a resource, for the ceiling check; null = no ref (visible). */
  const taskRepoOf = (taskRef: number): string | null => runtime.store.refForId(taskRef)?.repo ?? null;

  /**
   * The one gate every POST passes — parse elsewhere, authorize here. A
   * refusal names its status; null means proceed. Duplicated security fields
   * are refused outright: two `csrf` values in one body is not a preference,
   * it is a smuggling attempt.
   */
  function authorizeMutation(
    request: IncomingMessage,
    who: Who,
    body: FormView<FormFieldOf<"mutationGuard">>,
  ): { status: number; message: string } | null {
    // A read token never mutates, whatever its person's role (operate-remote.ts says the same to the remote CLI).
    if (who.via === "bearer") {
      if (who.principal !== undefined) {
        const live = reproveRemote(runtime.store, who.principal, new Date());
        if (!live.ok) return { status: 403, message: REMOTE_MESSAGES.stale };
        if (live.scope !== "act") return { status: 403, message: REMOTE_MESSAGES.read };
      }
    }
    const current = runtime.store.accountOf(who.name);
    if (current === null || current.revokedAt !== null || current.role !== who.role || current.generation !== (who.via === "cookie" ? who.session.generation : who.generation)) {
      return { status: 403, message: "Your access changed. Sign in again." };
    }
    const type = request.headers["content-type"] ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      return { status: 415, message: "forms only" };
    }
    for (const field of ["csrf", "token", "digest", "nonce", "confirm"] as const) {
      if (body.getAll(field).length > 1) {
        return { status: 400, message: `duplicated ${field} field` };
      }
    }
    if (who.via === "cookie") {
      // A PRESENT Origin must name this server. An ABSENT one is not a
      // forgery: iOS Safari and some in-app browsers omit Origin on
      // same-origin form posts, and refusing them locked the console on
      // the operator's own phone. The per-session CSRF token below is the
      // primary proof either way — a cross-site attacker can post, but
      // cannot read the token to include it.
      const origin = request.headers.origin;
      const referer = request.headers.referer;
      const named = typeof origin === "string" && origin !== "null" ? origin : typeof referer === "string" ? referer : null;
      if (named !== null && !runtime.allowedHost(named.replace(/^https?:\/\//, "").split("/")[0])) {
        return { status: 403, message: "origin not allowed" };
      }
      if (body.get("csrf") !== who.session.csrf) {
        return { status: 403, message: "stale form — reload and try again" };
      }
    }
    return null;
  }

  /**
   * The project a request views through — cookie sessions carry their open
   * project; bearer callers may name one per request, constrained by the
   * ceiling. Returns undefined when a named project is outside the ceiling:
   * that is a refusal, not a fallback.
   */
  function projectOf(who: Who, request: IncomingMessage): string | null | undefined {
    const fallback = () => restricted() ? admissionList()?.[0] ?? null : runtime.defaultProject;
    if (who.via === "cookie") {
      const selected = who.session.project;
      if (!restricted()) {
        if (selected === null || visible(selected)) return selected;
        // A saved selection can outlive the live ceiling, including its startup default.
        const project = fallback();
        return visible(project) ? project : null;
      }
      return selected !== null && visible(selected) ? selected : fallback();
    }
    const header = request.headers["x-standing-orders-project"];
    if (header === undefined) return fallback();
    if (Array.isArray(header)) return undefined;
    const canonical = canonicalProject(header);
    if (canonical === null || !visible(canonical)) return undefined;
    return canonical;
  }

  /**
   * What a project-limited account may do at this address: a projection of the route table's `limited` column
   * (server/route-table.ts), never a hand-kept list. An address the table does not declare is instance-only.
   */
  function resolveRouteProject(source: RouteDeclaration['project'], url: URL, who: Who, request: IncomingMessage, body: URLSearchParams | null): string | null {
    const id = Number(url.pathname.split('/')[2]);
    const runRepo = (runId: number | null | undefined): string | null => {
      const run = runId == null ? null : runtime.store.getRun(runId);
      return run === null ? null : runtime.store.refForId(run.taskRef)?.repo ?? null;
    };
    switch (source) {
      case 'none': return null;
      case 'session': return projectOf(who, request) ?? null;
      case 'form': return body?.get('repo')?.trim() || projectOf(who, request) || null;
      case 'form-path': {
        const path = body?.get('path')?.trim() ?? '';
        // Invalid/missing paths keep the opener's existing 400 response and recoverable form.
        return path === '' ? null : canonicalProject(path);
      }
      case 'task': {
        const task = matchTaskPath(url.pathname, '(?:/[a-z-]+)?$');
        return task === null ? null : runtime.store.lookupRef(task.taskId)?.repo ?? null;
      }
      case 'run': return runRepo(id);
      case 'decision': return runRepo(runtime.store.getDecision(id)?.run);
      case 'incident': return runRepo(runtime.store.openIncidents().find(one => one.id === id)?.run);
      case 'routine': return runtime.store.getRoutine(id)?.repo ?? null;
      case 'flow': return runtime.store.getFlow(id)?.repo ?? null;
      case 'proposal': case 'coding': return runtime.actionTarget(url, who, request, body === null ? null : readForm(body, CONSOLE_FORMS.ledgerTarget)).repo;
      case 'conversation': return projectOf(who, request) ?? null;
      case 'adapter': throw new Error('A console route cannot delegate project admission to a protocol adapter');
    }
  }

  function projectRequestAllowed(route: RouteDeclaration, source: RouteDeclaration['project'], url: URL, who: Who, request: IncomingMessage, response: ServerResponse, body: URLSearchParams | null): boolean {
    const path = url.pathname;
    const project = resolveRouteProject(source, url, who, request, body);
    if (restricted() && body !== null) {
      const repos = body.getAll("repo");
      if (repos.length > 1 || repos.some(repo => repo.trim() !== "" && !visible(repo.trim()))) {
        refuse(response, who, 403, "That project is outside your access.", "/projects"); return false;
      }
    }
    if (!restricted()) {
      if (project !== null && !visible(project)) {
        if (source === 'form-path') refuse(response, who, 403, "that project is outside this console's reach", "/projects");
        else if (source === 'form') refuse(response, who, 403, "that project is outside what this server was configured to show", "/projects");
        else refuse(response, who, 404, "No such resource in your projects.", "/projects");
        return false;
      }
      return true;
    }
    if (source === 'form-path' && project !== null && !visible(project)) {
      refuse(response, who, 403, "that project is outside this console's reach", "/projects"); return false;
    }
    // Shared coordination has its own complete audience/project admission.
    // A person's open-project filter does not deny an explicitly scoped room.
    if (route?.limited === 'conversation' && request.method === 'GET' && who.via === 'cookie' && url.searchParams.get('private') !== '1' && ((!url.searchParams.has('task') && !url.searchParams.has('result')) || url.searchParams.has('conversation'))) {
      try {
        const snapshot = runtime.team.domain.snapshot({ name: who.name, generation: who.session.generation }, url.searchParams.get('conversation') ?? undefined, url.searchParams.get('lead') ?? undefined);
        if ((snapshot.leads.length > 0 || url.searchParams.get('team') === '1') && (!snapshot.selected || snapshot.selected.projects.every(visible))) return true;
      } catch { refuse(response, who, 404, 'This conversation is unavailable.', '/projects'); return false; }
    }
    // The person's own settings and saved objects (personal pairing, their chat-approval setting, their coding
    // sessions): each route separately proves cookie, standing, password and every project it names.
    if (route?.limited === "self") return true;
    if (route?.limited === "proposal") {
      const proposal=runtime.store.getMateProposal(Number(path.split('/')[3])),action=proposal?.kind==='action'?sharedActionPayload(proposal.payload):null;
      const shared = proposal ? runtime.store.handle.prepare('SELECT id FROM team_conversation WHERE thread=?').get(proposal.thread) : null;
      if (shared && who.via === 'cookie') {
        try { const access = runtime.team.domain.access({ name: who.name, generation: who.session.generation }, String(shared['id']), 'contributor'); if (access.conversation.projects.every(visible)) return true; }
        catch { /* The same scoped refusal below also covers revoked membership. */ }
      }
      if(action&&proposal&&runtime.store.getMateThread(proposal.thread)?.approver===who.name&&visible(action.repo)&&runtime.store.accountCanAccess(who.name,action.repo))return true;
      // A card about the person themselves (what their lead knows about them) is in no project.
      if(action&&proposal&&action.repo===''&&OWNER_ACTIONS.has(action.operation)&&runtime.store.getMateThread(proposal.thread)?.approver===who.name)return true;
      refuse(response,who,404,'No such action in your projects.','/projects');return false;
    }
    // A task address whose id does not decode names no task.
    const undecodable = route?.project === "task" && matchTaskPath(path, "(?:/[a-z-]+)?$") === null;
    if (route === null || route.limited === "deny" || route.limited === "conversation" || undecodable) {
      refuse(response, who, 403, "This area requires instance access. Your account operates within its assigned projects.", "/projects");
      return false;
    }
    if (route.limited === "resource") {
      if (!visible(project)) {
        refuse(response, who, 404, "No such resource in your projects.", "/projects"); return false;
      }
    }
    // Every collection except the unscoped ones must have a concrete project;
    // NULL otherwise means all rows in legacy store APIs.
    if (route.limited !== "unscoped" && !visible(projectOf(who, request) ?? null)) {
      refuse(response, who, 403, "No assigned project is available. Ask an instance operator for access.", "/projects"); return false;
    }
    if (route.id === "board") {
      url.searchParams.delete("scope");
      if (url.searchParams.get("view") === "order") url.searchParams.delete("view");
    }
    return true;
  }

  function workAccess() {
    // The reader's own lead's claims read "<name> is on it" (lead-voice.ts); nobody else's.
    return { principal: 'operator' as const, repos: admissionList(), includeUnplaced: visible(null), viewer: requestContext.getStore()?.actor ?? null };
  }
  function familyOf(taskId: string): TaskFamily | null {
    return runtime.store.taskFamilyOf(taskId, admissionList(), visible(null));
  }

  // ---- identity ------------------------------------------------------------

  function identify(request: IncomingMessage, touch = true, limited = false, refusedToken?: { principal?: Principal }): Who | null {
    // v101: an API token. Wrong ones spend the address's tries like a wrong password; expired or revoked ones, and a removed account's, name no one.
    const presented = /^Bearer (so_\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (presented !== undefined) {
      const source = runtime.joinSourceOf(request), at = Date.now();
      if (runtime.signInBudget.waitFor(source, at) > 0) return null;
      const parsed = parseApiToken(presented);
      const kept = parsed === null ? null : runtime.store.apiTokenSecret(parsed.id);
      if (parsed === null || kept === null || !secretMatches(parsed.secret, kept.secretHash)) { runtime.signInBudget.failed(source, at); return null; }
      if (!tokenLive(kept.row, at)) return null;
      // v111: a token limited to some projects signs in only where its limit travels with it (the remote CLI and MCP,
      // through Principal.projects); the console's own pages and APIs check the account's access alone, so it is refused there.
      const account = runtime.store.accountOf(kept.row.account);
      if (account === null || account.revokedAt !== null) return null;
      const principal: Principal = { kind: "person", account: kept.row.account, generation: account.generation, scope: kept.row.access, tokenId: kept.row.id,
        projects: tokenProjects(tokenProjects(account.projects, kept.row.projects), oauthProjects(runtime.store, kept.row.id)) };
      // Preserve proof only for a refusal and its admission charge. This never makes an OAuth token a console login.
      if (!oauthTokenAllowed(runtime.store, kept.row.id, new URL(request.url ?? "/", "http://placeholder").pathname, new Date(at)) ||
          (kept.row.projects !== null && !limited)) {
        if (refusedToken !== undefined) refusedToken.principal = principal;
        return null;
      }
      runtime.store.touchApiToken(kept.row.id, new Date(at));
      return { name: kept.row.account, via: "bearer", role: kept.row.access === "read" ? "viewer" : account.role, token: kept.row.name, generation: account.generation, principal };
    }
    const bearer = /^Bearer (.+):(.+)$/.exec(request.headers.authorization ?? "");
    if (bearer !== null) {
      // A password on a request is a sign-in too: the same per-address tries and per-name lock.
      const source = runtime.joinSourceOf(request), at = Date.now();
      if (runtime.signInBudget.waitFor(source, at) > 0) return null;
      const authenticated = authenticateAccount(runtime.store, bearer[1] as string, bearer[2] as string);
      if (!authenticated.ok && authenticated.reason === "unknown") runtime.signInBudget.failed(source, at);
      return authenticated.ok && runtime.passwordAllowed(bearer[1] as string) ? { name: bearer[1] as string, via: "bearer", role: authenticated.role, generation: authenticated.generation } : null;
    }
    const cookies = request.headers.cookie ?? "";
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
    if (match === null) return null;
    const session = lookupSession(match[1] as string, touch);
    return session === null ? null : { name: session.name, via: "cookie", session, role: session.role };
  }

  /**
   * Constant-time against the session table, small as it is — and every hit
   * is re-proved against time and the approver's credential generation. A
   * rotated credential kills its cookies the same way it kills its Telegram
   * bindings: authority derived from the old secret does not outlive it.
   */
  function lookupSession(candidate: string, touch = true): Session | null {
    const bytes = Buffer.from(candidate, "utf8");
    let found: [string, Session] | null = null;
    for (const [id, session] of runtime.sessions) {
      const stored = Buffer.from(id, "utf8");
      if (stored.length === bytes.length && timingSafeEqual(stored, bytes)) { found = [id, session]; break; }
    }
    // v101: not in memory, maybe from before a restart.
    if (found === null) { const loaded = runtime.sessions.load(candidate); if (loaded !== null) found = [candidate, loaded]; }
    for (const [id, session] of found === null ? [] : [found]) {
      const now = Date.now();
      if (now - session.lastSeen > SESSION_IDLE_MS || now - session.createdAt > SESSION_ABSOLUTE_MS) {
        runtime.sessions.delete(id);
        return null;
      }
      if (runtime.store.approverGeneration(session.name) !== session.generation) {
        runtime.sessions.delete(id);
        return null;
      }
      if (touch) { session.lastSeen = now; runtime.sessions.persist(session, true); }
      return session;
    }
    return null;
  }

  /**
   * When this server is scoped to a repo, a run whose task belongs to a
   * different repo does not exist here — its evidence may hold that other
   * repo's diffs, and one console instance is one trust domain.
   */
  function runVisible(run: Run): boolean {
    return visible(taskRepoOf(run.taskRef));
  }
  return { authenticateApprover, authorizeMutation, projectOf, resolveRouteProject, projectRequestAllowed, identify, lookupSession, restricted, visible, admissionList, codingActorAllowed, codingProjectAllowed, workAccess, familyOf, taskRepoOf, runVisible };
}
