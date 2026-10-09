import { html, htmlString, jsonScript, textHtml, type Html } from "./html.js";
import type { RunActivity } from "./activity-line.js";
import { browserAssetsAvailable,browserWorkspaceDocument } from './browser-shell.js';
import { browserCrewFromIndex,browserCrewOf,browserNavigationOf,browserProjectsOf,needsYouLabelOf,type BrowserChatLink,type BrowserPhoneCard,type BrowserUpdates,type BrowserWorkspace } from './browser-workspace.js';
import { sharedActionPayload } from './chat-actions.js';
import { prepareCodingContext } from './coding-context.js';
import { CodingWorkspace } from './coding-workspace.js';
import { CONSOLE_FORMS,readForm,type FormFieldOf,type FormView } from "./contracts/console-api.js";
import type { DemoLead } from "./demo.js";
import { createFlowRooms,flowFingerprint } from "./flow-live.js";
import { type GoogleVisit } from "./google-mail.js";
import { configureLeadFollow,runLeadFollowPass } from './lead-follow.js';
import { leadNameOf } from "./lead-identity.js";
import { createLiveBus,followWorkspace } from "./live-bus.js";
import { startMaintenance } from './maintenance.js';
import { connectionsOf,localConnectOf,oneClickOf,type ConnectVisit } from "./mcp-connect.js";
import { MOBILE_VIEWPORT_SCRIPT } from "./mobile-viewport.js";
import { projectAuthority } from "./project-access.js";
import { discoverTools,projectToolsOf,secretsSetFor,TOOL_CATALOG } from "./project-tools.js";
import { isEdgeAddress,refuseEdge } from "./server/edge-refusal.js";
import { createSharedGuards } from "./server/guards.js";
import { createHandlerRegistry } from "./server/handler-registry.js";
import { type RemoteHookContext } from "./server/remote-hooks.js";
import { createRemoteHandlers,type RemoteRuntime } from "./server/remote.js";
import { evaluateRoutePolicy,withEdgePolicy } from "./server/route-policy.js";
import { matchRoute,ROUTES } from "./server/route-table.js";
import { createTaskViews } from "./server/task-views.js";
import { runActivityOf } from "./task-activity.js";
import { createTaskRooms,taskFingerprint } from "./task-live.js";
import type { TeamChatProviderResolver } from './team-chat-authorization.js';
import type { TeamResponse } from './team-contract.js';
import { createTeamRuntime } from './team-runtime.js';
import { type ToolsView } from "./tools-ui.js";
import { workCountsByProject } from "./work-index.js";
import { WORKSPACE_MOTION_SCRIPT } from "./workspace-motion.js";
import { prepareWorkspaceRevision,WorkspaceValidatorCache } from "./workspace-revision.js";
/**
 * The web console (§7, grown per the console review): the whole built-in
 * queue, visible and operable from a phone. `toolroll serve` — node:http,
 * no dependencies, no JavaScript in the page. TLS is a proxy's job and the
 * docs say so; what is not delegated is everything else:
 *
 * **Authentication is required on every bind, localhost included.** The
 * credential is the approver's — the same name-and-token that approves a
 * scope and answers in the CLI — because `answered_by` must be an identity
 * somebody proved, not a string a request asserted. A browser logs in once
 * (POST /login) and carries an HttpOnly SameSite=Strict session cookie; an
 * API caller sends `Authorization: Bearer <name>:<token>` per request. The
 * token never travels in a URL, where it would land in history and logs.
 *
 * **Every request proves its Host** against the names this server was told
 * it answers as. Cookie-authenticated mutations additionally pass one
 * centralized gate — `authorizeMutation` — that proves content type, an
 * allowed Origin, and the per-session CSRF nonce, and refuses duplicated
 * security fields; a mutation route cannot forget a check it never wrote.
 * Bearer mutations carry no cookie for a hostile page to ride, so they skip CSRF.
 * Step-up ceremonies still require a cookie session; repeating a bearer password cannot approve.
 *
 * **Approval is step-up.** A session alone never approves a scope: the
 * approval form restates the goal, the exclusions, and the touches — the
 * three fields the digest binds — and requires the approver token typed
 * again, plus (for browsers) a single-use nonce minted when the form was
 * rendered, bound server-side to who saw which digest of which task. A
 * stolen cookie can read; it cannot agree to work.
 *
 * **GET never mutates.** Overdue-ness is derived at render time from the
 * deadline on the row; the durable expiry sweep belongs to the CLI's
 * surfaces and the loop, not to a crawler hitting a page.
 *
 * **Everything rendered is escaped at the sink**, and every identifier in an
 * href is URL-encoded first — HTML escaping does not make `a/b?x=1` a valid
 * path segment. The CSP is belt to those suspenders.
 *
 * **Evidence goes through one verified reader** (`readVerifiedArtifact`) and
 * membership is enforced by the lookup — a decision serves only its linked
 * artifacts, a run only its own rows, and when this server was scoped to a
 * repo, only runs whose task belongs to that repo (or to no repo yet).
 */

import { createHash,randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer,type IncomingMessage,type Server,type ServerResponse } from "node:http";
import { homedir,hostname } from "node:os";
import { dirname,join } from "node:path";
import { pinnedAccent } from "./accent-colors.js";
import {
CHAT_KEY_ENV,
credentialKeyOf,
fetchOpenRouterCatalog,
isSubscriptionChatProvider,
priceForConfig,
subscriptionCredentialKey
} from "./converse.js";
import { hasForbiddenControls } from "./decision.js";
import { UPDATE_PAUSED,updateAdmissionPaused } from "./desktop-update-gate.js";
import { scanForSecrets } from "./evidence.js";
import { run as execRun } from "./exec.js";
import { firstRunSteps,signInCommandFor,type FirstRunStep,type FirstTaskSuggestion } from "./first-run.js";
import { installMethod } from "./install-method.js";
import { createIntegrationMonitor } from "./integrations.js";
import { logEvent } from "./log.js";
import { LEAD_MESSAGE_MAX_CHARS } from "./lead.js";
import { type CatalogSeams } from "./model-catalog.js";
import { modeTermsFromJson } from "./modes.js";
import { envValue } from "./names.js";
import { discoverOidc,type OidcClaims,type OidcProvider,type OidcVisit } from "./oidc.js";
import { openRouterModelsCache } from "./openrouter-models.js";
import { REMOTE_MESSAGES,type Principal } from "./operate-remote.js";
import { verifyApproverStanding,type VerifiedApprover } from "./principal.js";
import { PROJECT_CONCURRENCY_DEFAULT,projectConcurrency } from "./project-concurrency.js";
import { type ProjectSettingsView } from "./project-delete-ui.js";
import { projectHoldings,projectRunning } from "./project-delete.js";
import {
canonicalProject,
projectName,
resolveCeiling,
rowVisible
} from "./project.js";
import { noteSignInProbe,signInNotices } from "./provider-auth.js";
import { createConnectionChecker,type ProviderConnection } from "./provider-connection.js";
import { ALL_CREDENTIAL_ENV,type ProviderId } from "./provider.js";
import { hstsFor,LOOPBACK_PEERS,plainHttpRefusal,transportOf } from "./public-access.js";
import { attachReadExecutor,defaultReadWorkers,ReadExecutor } from "./read-executor.js";
import { cachedRelease,isNewer,runnerVersions,updateChecksOff,type Release } from "./releases.js";
import { limitWords,FLUSH_MS as REQUEST_BUDGET_FLUSH_MS,RequestBudget,SOURCE_BUDGET_DEFAULTS,SourceAdmission,type Admission } from "./request-budget.js";
import {
REQUEST_TOKEN,
RESULT_REVIEW_SCRIPT
} from "./result-review.js";
import { buildReviewOf } from "./review-switch.js";
import { isAlive as runnerAlive } from "./runner.js";
import {
freshIdentitySignIn
} from "./scope.js";
import { instrumentRequest } from "./server-telemetry.js";
import { createChatHandlers } from './server/chat.js';
import { createLiveHandlers } from './server/live.js';
import { createFlowsHandlers } from './server/flows.js';
import type { HandlerContext } from './server/handler-context.js';
import { createPagesHandlers } from './server/pages.js';
import { createPeopleHandlers } from './server/people-tokens.js';
import type { RouteDeclaration } from './server/route-table.js';
import type { ServerRuntime } from './server/runtime.js';
import { createSettingsHandlers } from './server/settings.js';
import { requestContext } from "./server/request-context.js";
import { chromeScript,DEMO_BANNER,DEMO_BANNER_SHORT,focusDocument,KBD_HELP,pinnedTheme,QUEUE_VIEW,refuse,screen,SENSITIVE_INPUT,shell,sidebarScript,type Chrome,type Screen } from "./server/chrome.js";
import { BODY_CAP,form,loginHref,matchTaskPath,page,projectChatHref,redactedPath,redirect,respond,safeReturn,SHUTDOWN_WAIT_MS,taskChatHref,type ServeOptions } from "./server/http.js";
import { decisionsFor,LEAD_BY_DEFAULT_FACT,leadBrowserMessages,leadChatVersion,teamProposalCardParts,type ChatEnablement,type LiveTurn,type ReplacedThread,type TaskChatFocus } from "./server/render-chat.js";
import { type ProjectPeek } from "./server/render-pages.js";
import { ssoStepUps,wrongHostPage } from "./server/render-people.js";
import { NO_PROJECT,NO_TOUCH_FRAGMENTS,NONCE_CAP,NONCE_TTL_MS,PersistentSessions,SESSION_ABSOLUTE_MS,SESSION_IDLE_MS,SIGN_IN_LINK_MS,SIGN_IN_LINK_PATH,type ApprovalNonce,type DecisionServer,type SsoIntent,type Who } from "./server/session.js";
import { createTasksHandlers } from './server/tasks.js';
import { DEFAULT_GUARD_POLICY,passwordGuardOf,provenPasswordAccount,SourceBudget,withPasswordSource } from "./sign-in-guard.js";
import { sourceKey } from "./source-key.js";
import { readSsoSettings } from "./sso-settings.js";
import type { ChatConfig,CoordinatorProposal,DirectChatProviderId,LeadMessage,LeadProposal,LeadTurn,SubscriptionChatProviderId } from "./store.js";
import {
LEAD_THREAD,
type Decision,
type LeadAsk,type LeadThreadScope
} from "./store.js";
import { waitingUpdate } from "./toolroll-update.js";
import { PACKAGE_VERSION } from "./version.js";
import { loadConsoleUrl } from "./webhooks.js";
import {
reviewFactsOf,
type ReviewFacts
} from "./workspace-ui.js";
import { WorktreePool } from "./worktree.js";
export function createDecisionServer(options: ServeOptions): DecisionServer {
  const { guided, projectFamilyPeek, familiesInView, familyTasksInView, revisionDestination, earlierLiveVersions, familyHistory, freshAssignment, workRowOf, taskListPane, runIsLive, runIsTaskResult, revisionViewOf, taskViewData, routeViewOf, taskChatFocus, pullRequestTargetOf, taskPullRequestOf, failureOf, explainAttempt, runChecksHere, taskScreen, armTaskResume, planViewOf, planContractViewOf, revisionDocOf, revisionLedgerOf, progressOf, resultDetailOf } = createTaskViews({
    get store() { return store; },
    get projectCounts() { return projectCounts; },
    get admissionList() { return admissionList; },
    get visible() { return visible; },
    get familyOf() { return familyOf; },
    get clock() { return clock; },
    get reviewFactsFor() { return reviewFactsFor; },
    get evidenceRoot() { return evidenceRoot; },
    get workAccess() { return workAccess; },
    get mintApprovalNonce() { return mintApprovalNonce; },
    get restricted() { return restricted; },
    get options() { return options; },
    get sendScreen() { return sendScreen; },
    get chromeFor() { return chromeFor; },
    get unscopedMode() { return unscopedMode; },
    get dockedConversation() { return dockedConversation; },
    get liveRefreshSeconds() { return liveRefreshSeconds; },
  });

  const { authenticateApprover, authorizeMutation, projectOf, resolveRouteProject, projectRequestAllowed, identify, lookupSession, restricted, visible, admissionList, codingActorAllowed, codingProjectAllowed, workAccess, familyOf, taskRepoOf, runVisible } = createSharedGuards({
    get store() { return store; },
    get liveCeiling() { return liveCeiling; },
    get codingProjects() { return codingProjects; },
    get unscopedMode() { return unscopedMode; },
    get managedRepos() { return managedRepos; },
    get ceiling() { return ceiling; },
    get allowedHost() { return allowedHost; },
    get defaultProject() { return defaultProject; },
    get actionTarget() { return actionTarget; },
    get team() { return team; },
    get joinSourceOf() { return joinSourceOf; },
    get signInBudget() { return signInBudget; },
    get passwordAllowed() { return passwordAllowed; },
    get sessions() { return sessions; },
  });

  const { store, evidenceRoot } = options;
  let coding = options.codingWorkspace ?? null;
  let codingProblem: string | undefined;
  if (coding === null && options.localRunner !== undefined && !store.isDemo()) {
    const database = store.handle.prepare('PRAGMA database_list').all().find(row => row['name'] === 'main')?.['file'];
    if (typeof database === 'string' && database !== '') {
      try { coding = new CodingWorkspace({ database: `${database}.coding.sqlite`, worktreeRoot: join(dirname(database), 'coding-worktrees'), admissionPaused: () => updateAdmissionPaused(store.raw()), authorize: (actor, repo) => codingActorAllowed(actor) && codingProjectAllowed(repo), context: input => prepareCodingContext(store, { ...input, root: join(dirname(database), 'coding-context') }) }); }
      catch (error) { codingProblem = error instanceof Error ? error.message : 'The coding workspace could not open.'; }
    }
  }
  const clock = options.clock ?? (() => new Date());
  // Heavy reads (the work index behind `task list`) run on read-only worker connections, off the request loop.
  const readFile = store.isDemo() ? null : store.databaseFile();
  const readWorkers = options.readWorkers ?? (process.env["VITEST"] !== undefined ? 0 : defaultReadWorkers());
  const reads = readFile === null || readWorkers < 1 ? null : new ReadExecutor(readFile, readWorkers);
  const detachReads = reads === null ? () => {} : attachReadExecutor(store, reads);
  /** Task checkouts, for Settings → Storage: the pool's own root, or the folder beside the database. */
  const storagePool = (databaseFile: string) => new WorktreePool(store, { root: options.poolRoot ?? join(dirname(databaseFile), "worktrees") });
  const install = installMethod(options.installBin);
  /** What the last daily check found (the cache only, never the network), or nothing while checks are off. */
  const updateFacts = (): { release: Release | null; newer: boolean; on: boolean; byEnv: boolean } | null => {
    if (options.configDir === undefined) return null;
    const switched = updateChecksOff(process.env, options.configDir);
    const release = switched.off ? null : cachedRelease(options.configDir);
    return { release, newer: release !== null && isNewer(release.version, PACKAGE_VERSION), on: !switched.off, byEnv: switched.byEnv };
  };
  /** Settings → Updates, for everyone who can open Settings; only an operator may flip the switch. */
  const settingsUpdates = (actor: string, csrf: string): BrowserUpdates | null => {
    const facts = updateFacts();
    if (facts === null) return null;
    const known = new Map(runnerVersions(options.configDir!).map(one => [one.runner, one.version]));
    return {
      current: PACKAGE_VERSION,
      latest: facts.release === null ? null : { version: facts.release.version, newer: facts.newer, security: facts.release.security, notes: facts.release.notes, url: facts.release.url },
      updateCommand: install.updateCommand,
      check: { on: facts.on, byEnv: facts.byEnv, canManage: csrf !== "" && store.isInstanceOperator(actor) },
      workers: store.listRunners().filter(one => one.retiredAt === null).map(one => {
        const version = known.get(one.name) ?? null;
        return { name: one.name, version, older: version !== null && isNewer(PACKAGE_VERSION, version) };
      }),
    };
  };
  const workspaceRevision = prepareWorkspaceRevision(store);
  const workspaceIncarnation = randomBytes(16).toString('hex');
  const workspaceValidators = new WorkspaceValidatorCache();
  const providerHome = options.connectionHome ?? homedir();
  const checkConnection = createConnectionChecker({ home: providerHome, clock, ...(options.connectionProbe === undefined ? {} : { probe: options.connectionProbe }) });
  // Every sign-in check the console makes also answers a sign-in pause.
  const connectionCheck = async (provider: ProviderId, fresh?: boolean): Promise<ProviderConnection> => {
    const value = await checkConnection(provider, fresh);
    try { noteSignInProbe(store, provider, value.state, clock()); } catch { /* the pause keeps its own state */ }
    return value;
  };
  // Settings → Integrations: checked in the background with a short cache, as the first-run suggestions are.
  const integrations = createIntegrationMonitor(() => ({
    store,
    dir: options.configDir ?? null,
    telegramTokenFile: options.telegramTokenFile ?? null,
    env: process.env,
    repos: managedRepos(),
    gh: options.firstTaskRunner ?? execRun,
    checkConnection: connectionCheck,
    toolHome,
    clock,
    ...options.integrationIo,
  }));
  const modelCatalog = openRouterModelsCache(options.modelCatalogFetcher);
  const modelSeams: CatalogSeams = {
    home: providerHome,
    ...(options.modelCatalogFetcher === undefined ? {} : { fetcher: options.modelCatalogFetcher }),
    ...(options.modelRunner === undefined ? {} : { runner: options.modelRunner }),
    ...(options.modelPath === undefined ? {} : { path: options.modelPath }),
  };
  const sessions = new PersistentSessions(store);
  // Sessions from before a restart that ran out, or whose account changed since, go now.
  store.sweepWebSessions(Date.now(), SESSION_IDLE_MS, SESSION_ABSOLUTE_MS);
  /** Where a new session signs in from: the browser (its user agent, short) and the address. */
  const arrival = (request: IncomingMessage) => ({ agent: (request.headers["user-agent"] ?? "").slice(0, 300) || null, address: forwardedSourceOf(request).replace(/^fwd:/, "") });
  /** Wrong setup codes left before the first-account road closes. */
  let setupAttemptsLeft = 5;
  // The /join road's limiter (D6; Codex people round 1, finding 4):
  // PER-SOURCE buckets so one stranger cannot drain sign-up capacity for
  // everyone, under a global ceiling that bounds total KDF work. Spent
  // only by WELL-FORMED submissions — malformed requests are refused by
  // the shape guards for free. The per-invite attempt counter remains the
  // durable meter; these buckets only price the trying.
  const joinBySource = new Map<string, { tokens: number; refilledAt: number }>();
  /** The per-source key (round 2, finding 4): the direct peer — except
   * behind the documented same-host TLS proxy, where every client would
   * share the proxy's one bucket. A LOOPBACK peer is that proxy, and only
   * then is the forwarded chain believed, taking the LAST hop (the one
   * the trusted proxy itself appended; earlier entries are client-typed). */
  function forwardedSourceOf(request: IncomingMessage): string {
    const peer = request.socket.remoteAddress ?? "unknown";
    const loopback = LOOPBACK_PEERS.has(peer);
    if (!loopback) return peer;
    const forwarded = request.headers["x-forwarded-for"];
    const chain = Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "";
    const lastHop = chain.split(",").pop()?.trim() ?? "";
    return lastHop === "" ? peer : `fwd:${lastHop.slice(0, 64)}`;
  }
  /** That source as every per-source budget counts it: a native IPv6 caller by its /64 (source-key.ts). */
  function joinSourceOf(request: IncomingMessage): string { return sourceKey(forwardedSourceOf(request)); }
  const signInBudget = new SourceBudget();
  const ssoVisits = new Map<string, { visit: OidcVisit; provider: OidcProvider; redirect: string; intent: SsoIntent; returnTo: string; expires: number }>();
  const ssoHandoffs = new Map<string, { claims: OidcClaims; issuer: string; intent: SsoIntent; returnTo: string; expires: number }>();
  let ssoProvider: { issuer: string; provider: OidcProvider; at: number } | null = null;
  const ssoSettings = () => readSsoSettings(options.configDir);
  const ssoOffer = () => { const settings = ssoSettings(); return settings === null ? null : { label: settings.label, operatorsOnly: settings.passwords === "operators" }; };
  /** A step-up within this long of the provider checking someone needs no password. */
  const SSO_FRESH_MS = 10 * 60_000;
  // The one-time sign-in link `up` opens in the browser: single use, ten minutes, from this computer only. Only a hash
  // of the code is kept, in memory; the code itself is never written to a log or the ledger.
  const signInLinks = new Map<string, { account: string; expires: number }>();
  const linkKey = (code: string) => createHash("sha256").update(code).digest("hex");
  function mintSignInLink(account: string): string | null {
    const known = store.accountOf(account);
    if (known === null || known.role !== "approver" || known.revokedAt !== null) return null;
    for (const [key, one] of signInLinks) if (one.expires < Date.now()) signInLinks.delete(key);
    while (signInLinks.size >= 20) signInLinks.delete(signInLinks.keys().next().value!);
    const code = randomBytes(32).toString("base64url");
    signInLinks.set(linkKey(code), { account, expires: Date.now() + SIGN_IN_LINK_MS });
    return `${SIGN_IN_LINK_PATH}${code}`;
  }
  /** This computer, and nothing in front of it: a loopback peer that names a loopback address, with no forwarding proxy. */
  const fromThisComputer = (request: IncomingMessage): boolean => {
    const peer = request.socket.remoteAddress ?? "";
    const loopback = LOOPBACK_PEERS.has(peer);
    return loopback && request.headers["x-forwarded-for"] === undefined && request.headers["forwarded"] === undefined
      && /^(localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(request.headers.host ?? "");
  };
  async function providerFor(issuer: string): Promise<{ ok: true; provider: OidcProvider } | { ok: false; said: string }> {
    if (ssoProvider !== null && ssoProvider.issuer === issuer && Date.now() - ssoProvider.at < 10 * 60_000) return { ok: true, provider: ssoProvider.provider };
    const found = await discoverOidc(issuer, options.ssoFetch ?? fetch);
    if (found.ok) ssoProvider = { issuer, provider: found.provider, at: Date.now() };
    return found;
  }
  /** Password sign-in is only for instance operators when the provider says so (a way in if it's down). */
  const passwordAllowed = (name: string) => { const settings = ssoSettings(); return settings === null || settings.passwords === "everyone" || store.isInstanceOperator(name); };
  const minutesWords = (ms: number) => { const minutes = Math.max(1, Math.ceil(ms / 60_000)); return minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? "" : "s"}`; };
  /** A sign-in event names the account only when it exists: what someone typed into the name box stays out of history. */
  const signInActor = (name: string | null): string => name !== null && store.accountOf(name) !== null ? name : "unknown account";
  const recordSignIn = (actor: string, action: string, outcome: string, detail: string | null = null) => {
    try { store.recordAction({ at: clock().toISOString(), actor, repo: null, taskId: null, runId: null, action, outcome, source: "sign-in", detail }); }
    catch (error) { logEvent("error", "ledger.write-failed", { action, error: error instanceof Error ? error.message : String(error) }); }
  };
  passwordGuardOf(store).onLock = (account, lockMs) => {
    const actor = signInActor(account);
    recordSignIn(actor, "account locked", "locked", `${DEFAULT_GUARD_POLICY.failuresBeforeLock} wrong passwords in a row; locked for ${minutesWords(lockMs)}`);
    logEvent("warn", "sign-in.locked", { account: actor, minutes: Math.ceil(lockMs / 60_000) });
  };
  let joinGlobal = { tokens: 30, refilledAt: Date.now() };
  const approvalNonces = new Map<string, ApprovalNonce>();

  // Resolve startup authority once. Missing paths remain restrictive.
  // Native additions come only from the controller after its admission checks.
  const { ceiling, unresolved: unresolvedRepos } = resolveCeiling(
    [...(options.repo === undefined ? [] : [options.repo]), ...(options.repos ?? [])],
    options.projectRoots ?? [],
  );
  /** The project every fresh session opens with: the sole configured repo, else none. */
  const defaultProject = ceiling.repos.length === 1 && ceiling.roots.length === 0 ? ceiling.repos[0] as string : null;

  /** No ceiling configured at all: the legacy trust-everything mode, named. */
  const unscopedMode = ceiling.repos.length === 0 && ceiling.roots.length === 0;
  /** Per-row visibility under the ceiling — the authorization question for reads. */
  /** The exact repositories this console serves now: `up`'s live admitted set when it supplies one, else startup's. */
  const exactRepos = (): readonly string[] => options.admittedRepos?.() ?? ceiling.repos;
  const liveCeiling = () => {
    const repos = [...exactRepos(), ...(options.additionalProjectRepos?.() ?? [])];
    // An admitted set that is empty for now is an empty ceiling, never the legacy unscoped mode.
    return { repos: repos.length === 0 && ceiling.roots.length === 0 && !unscopedMode ? [NO_PROJECT] : repos, roots: ceiling.roots };
  };
  /** The explicit, currently proved project list. The callback is supplied
   * only by `up`, after it has independently checked git-ness and the root
   * ceiling; this server still filters every row through its own ceiling. */
  /** Projects deleted while this console runs: gone from its lists though a builder started with them still watches. */
  const deletedRepos = new Set<string>();
  /** Those still gone: a project added again (from here, `repos add`, or the lead) has its row back and shows again. */
  const goneRepos = (): ReadonlySet<string> => {
    if (deletedRepos.size === 0) return deletedRepos;
    for (const one of store.listProjects()) deletedRepos.delete(one.path);
    return deletedRepos;
  };
  const managedRepos = (): string[] => {
    const seen = new Set<string>();
    const repos: string[] = [];
    const gone = goneRepos();
    for (const path of [...exactRepos(), ...(options.currentRepos?.() ?? [])]) {
      const canonical = canonicalProject(path) ?? path;
      if (seen.has(canonical) || !visible(canonical) || gone.has(canonical)) continue;
      seen.add(canonical);
      repos.push(canonical);
    }
    return repos;
  };
  /** Settings → Project's view of a project: what's held for it, what's running, and whether this person may delete it. */
  const projectViewOf = (repo: string, who: Who): ProjectSettingsView => ({
    repo, name: projectName(repo), holdings: projectHoldings(store, repo), running: projectRunning(store, repo, clock()),
    canDelete: who.via === "cookie" && store.isInstanceOperator(who.name),
    builds: projectBuildsOf(repo, who),
  });
  /** Settings → Project → Builds at once: the saved number, its workers' capacity, and what builds now. */
  const projectBuildsOf = (repo: string, who: Who): NonNullable<ProjectSettingsView["builds"]> => {
    const capacities = store.listRunners().filter(one => one.retiredAt === null && one.repos.includes(repo)).map(one => one.capacity);
    return {
      setting: (() => { const file = store.databaseFile(); return file === null ? PROJECT_CONCURRENCY_DEFAULT : projectConcurrency(file, repo); })(),
      capacity: capacities.length === 0 ? null : Math.max(...capacities),
      building: store.runningBuildsByRepo(clock()).get(repo) ?? 0,
      canChange: who.via === "cookie" && who.role === "approver" && store.accountCanAccess(who.name, repo),
    };
  };
  /** Codex's own MCP servers for a project (`codex mcp list --json`), for "Found on this computer"; null when Codex can't say. */
  const codexServers = async (repo: string): Promise<unknown[] | null> => {
    try {
      const listed = await (options.codexToolList ?? (async (cwd: string) => {
        const result = await execRun("codex", ["mcp", "list", "--json"], { cwd, timeoutMs: 10_000, omitEnv: ALL_CREDENTIAL_ENV });
        return result.code === 0 ? result.stdout : null;
      }))(repo);
      const parsed = listed === null ? null : JSON.parse(listed) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  /** One project's Tools page: its tools with which secrets are set (never values), the common tools not yet added, and what this computer already has. */
  const toolHome = options.toolHome ?? homedir();
  const toolsViewOf = (repo: string, codex: unknown[] | null, kit: string | null = null, wanted: string | null = null): ToolsView => {
    const tools = projectToolsOf(store, repo);
    const names = new Set(tools.map(one => one.name));
    return {
      repo, project: repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo,
      tools: tools.map(tool => ({ tool, secretsSet: secretsSetFor(repo, tool.spec, toolHome) })),
      // A service that connects by signing in (or an app's own Connect) is offered only that way.
      catalog: TOOL_CATALOG.filter(one => !names.has(one.name) && oneClickOf(one.name) === null && localConnectOf(one.name) === null),
      connections: connectionsOf(store, repo, toolHome), kit, wanted,
      found: discoverTools(repo, codex, toolHome).filter(one => !names.has(one.spec.name)),
    };
  };
  const codingProjects = (): string[] => [...new Set([...managedRepos(), ...store.listProjects().map(project => project.path)])].filter(repo => rowVisible(liveCeiling(), repo));
  /** Open chat streams (live replies), ended when the server closes. */
  let liveTurnStarted: (thread: number) => void = () => {};
  /** Google sign-ins in progress (v89): each consent visit's state, for 10 minutes. */
  const googleVisits = new Map<string, GoogleVisit>();
  /** One-click connections on their way: the service's sign-in page and back, 15 minutes at most. */
  const connectVisits = new Map<string, ConnectVisit>();
  /** Flows open in a browser (v88): who's here, and a nudge when one changes. */
  // Live views push on write (live-bus.ts): each commit moves the workspace revision, the rooms hear it.
  const liveBus = createLiveBus();
  const liveFollower = followWorkspace(store, () => workspaceRevision.current(), liveBus, { file: store.databaseFile() });
  const flowRooms = createFlowRooms(flow => flowFingerprint(store, flow), { bus: liveBus });
  const taskRooms = createTaskRooms(root => taskFingerprint(store, root, clock()), { bus: liveBus });
  const teamChatProvider: TeamChatProviderResolver = () => { const enabled = chatEnablement(); return enabled.ok ? { config: enabled.config, key: enabled.key } : null; };
  const team = createTeamRuntime({ store, repos: codingProjects, evidenceRoot, clock, workspaceRevision,
    ...(options.chatFetcher ? { fetcher: options.chatFetcher } : {}),
    provider: teamChatProvider,
    ...(options.subscriptionChatRunner ? { subscriptionRunner: options.subscriptionChatRunner } : {}),
  });
  // Only browser sessions receive HTML cards. The CLI keeps its summary contract.
  const teamBrowserReply = (reply: TeamResponse, actor: { name: string; generation: number }, csrf: string): TeamResponse => {
    const snapshot = reply.snapshot;
    if (!snapshot?.selected || !snapshot.proposals) return reply;
    return { ...reply, snapshot: { ...snapshot, proposals: snapshot.proposals.map(summary => {
      const proposal = store.getLeadProposal(summary.id);
      if (!proposal || proposal.thread !== snapshot.selected!.threadId) return summary;
      const decision = proposal.kind === 'answer' && typeof proposal.payload['decision'] === 'number' ? store.getDecision(proposal.payload['decision']) : null;
      return { ...summary, card: teamProposalCardParts(store, actor, proposal, snapshot, csrf, decision, clock(), teamChatProvider).card };
    }) } };
  };
  // v112: one request budget per server for person API tokens, shared by every route a token signs in at (request-budget.ts).
  const requestBudget = new RequestBudget({ store, ...(options.requestBudgetClock === undefined ? {} : { clock: options.requestBudgetClock }) });
  // Unproved password attempts share a source budget. Only successful proof spends an account budget.
  const sourceClock = options.requestBudgetClock === undefined ? {} : { clock: options.requestBudgetClock };
  const passwordSourceBudget = new SourceAdmission({ perMinute: SOURCE_BUDGET_DEFAULTS.password, ...sourceClock });
  const passwordAccountBudget = new SourceAdmission({ perMinute: SOURCE_BUDGET_DEFAULTS.password, keyMode: "exact", ...sourceClock });
  const teamsSourceBudget = new SourceAdmission({ perMinute: SOURCE_BUDGET_DEFAULTS.teamsSource, ...sourceClock });
  const teamsTenantBudget = new SourceAdmission({ perMinute: SOURCE_BUDGET_DEFAULTS.teamsTenant, ...sourceClock });
  const oauthTokenBudget = new SourceAdmission({ perMinute: SOURCE_BUDGET_DEFAULTS.oauthToken, ...sourceClock });
  const presentsPassword = (request: IncomingMessage): boolean => /^Bearer (.+):(.+)$/.test(request.headers.authorization ?? "");
  const admitPasswordSource = (request: IncomingMessage): Admission =>
    presentsPassword(request) ? passwordSourceBudget.admit(joinSourceOf(request)) : { ok: true };
  /** Called only with a proved identity; cookies spend neither bearer budget. */
  const admitBearer = (request: IncomingMessage, actor: { name: string; principal?: Principal }): Admission => {
    if (actor.principal !== undefined) return requestBudget.admit(actor.principal.tokenId, "api");
    return presentsPassword(request) ? passwordAccountBudget.admit(actor.name) : { ok: true };
  };
  /** Every project this person may pick in the console — the switcher, Projects, Settings, Tools and Flows read this
   * one list: the live admitted set (taskless projects included) and every project with saved work, each through
   * the ceiling and this account's project grants. A project removed or deleted here is gone from it. */
  const consoleProjects = (): string[] => {
    const gone = goneRepos();
    return [...new Set([...(admissionList() ?? []), ...managedRepos(), ...store.knownRepos()])].filter(one => visible(one) && !gone.has(one));
  };

  const server = createServer((request, response) => {
    instrumentRequest(store.telemetry, request, response);
    // Every password checked while answering counts against where this request came from (sign-in-guard.ts).
    void withPasswordSource(joinSourceOf(request), () => handle(request, response)).catch(error => {
      // Every unhandled error is logged (v99): the path and the message, never the request's body or query.
      logEvent("error", "serve.error", { method: request.method, path: redactedPath(new URL(request.url ?? "/", "http://placeholder").pathname), error: error instanceof Error ? error.message : String(error) });
      if (envValue(process.env, "SERVE_DEBUG") === "1") console.error("SERVE ERROR:", error);
      if (!response.headersSent) {
        const updating = error instanceof Error && error.message.includes(UPDATE_PAUSED);
        if (updating) response.setHeader("Retry-After", "5");
        respond(response, updating ? 503 : 500, "text/plain; charset=utf-8", updating ? UPDATE_PAUSED : "something broke");
      } else {
        response.end();
      }
    });
  });

  server.once('listening', () => store.telemetry.start());
  server.once('close', () => store.telemetry.stop());

  // --public-url (arc 3): validated to EXACTLY an https origin. Its host
  // joins the allowed set, its origin authorizes POSTs, and cookies turn
  // Secure. Anything malformed refuses at startup, loudly.
  const publicOrigin = (() => {
    if (options.publicUrl === undefined) return null;
    let parsed: URL;
    try {
      parsed = new URL(options.publicUrl);
    } catch {
      throw new Error("--public-url is not a URL");
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.search !== "" || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new Error("--public-url is exactly an https origin — no path, query, or credentials");
    }
    return parsed;
  })();
  const cookieSecure = publicOrigin === null ? "" : "; Secure";
  /** Where Google may send someone back to (v89): the public https address, or this computer's own. */
  const consoleOrigin = (host: string | undefined): string | null =>
    host === undefined ? null : publicOrigin !== null && host === publicOrigin.host ? publicOrigin.origin : /^(localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(host) ? `http://${host}` : null;

  /** This computer's tailnet names, the last ones read (onboarding). */
  let tailnet: readonly string[] = [];
  if (options.tailnetNames !== undefined) {
    const readTailnet = options.tailnetNames;
    const refresh = () => { void readTailnet().then(names => { tailnet = names; }, () => {}); };
    refresh();
    const timer = setInterval(refresh, 5 * 60_000);
    timer.unref?.();
    server.on("close", () => clearInterval(timer));
  }
  {
    const flushBudget = () => { try { requestBudget.flush(); } catch { /* the next admit refuses if the database is unwell */ } };
    const timer = setInterval(flushBudget, REQUEST_BUDGET_FLUSH_MS);
    timer.unref?.();
    server.on("close", () => { clearInterval(timer); flushBudget(); });
  }
  const servedPort = (): number | null => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : null;
  };
  /** The names this server answers as. Anything else is a rebind, refused. */
  const allowedHost = (host: string | undefined): boolean => {
    if (host === undefined) return false;
    const port = servedPort();
    const locals =
      port === null ? [] : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...tailnet.map(name => `${name}:${port}`)];
    return [...locals, ...(options.allowedHosts ?? []), ...(publicOrigin === null ? [] : [publicOrigin.host])].includes(host);
  };
  /** The exact command that starts this console again as it runs now, plus a listening address or one more allowed host. */
  const consoleCommand = (change: { host?: string; allow?: string }): string => {
    const port = servedPort() ?? 4180;
    const address = server.address();
    const bound = typeof address === "object" && address !== null ? address.address : "127.0.0.1";
    const host = change.host ?? (bound === "127.0.0.1" || bound === "::1" ? null : bound === "::" ? "0.0.0.0" : bound);
    const allowed = [...(options.allowedHosts ?? []), ...(change.allow === undefined ? [] : [change.allow])];
    return [`toolroll ${options.upConsole === true ? "up" : "serve"}`, ...(host === null ? [] : [`--host ${host}`]), ...(port === 4180 ? [] : [`--port ${port}`]),
      ...(allowed.length === 0 ? [] : [`--allow-host ${allowed.join(",")}`])].join(" ");
  };
  /** The wrong-host page's facts: the address opened, where the console answers, and the exact command that admits it. */
  const wrongHost = (host: string | undefined) => {
    const opened = host !== undefined && /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$|^\[[0-9A-Fa-f:.]{2,45}\](:[0-9]{1,5})?$/.test(host) ? host : null;
    return { opened, served: `127.0.0.1:${servedPort() ?? 4180}`, command: opened === null ? null : consoleCommand({ allow: opened }) };
  };

  function mintApprovalNonce(name: string, taskId: string, digest: string): string {
    const nonce = randomBytes(16).toString("hex");
    if (approvalNonces.size >= NONCE_CAP) {
      const oldest = approvalNonces.keys().next().value;
      if (oldest !== undefined) approvalNonces.delete(oldest);
    }
    approvalNonces.set(nonce, { name, taskId, digest, expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Single use, bound to who saw which digest of which task, and young. */
  function consumeApprovalNonce(nonce: string, name: string, taskId: string, digest: string): boolean {
    const held = approvalNonces.get(nonce);
    if (held === undefined) return false;
    approvalNonces.delete(nonce);
    return (
      held.name === name &&
      held.taskId === taskId &&
      held.digest === digest &&
      held.expiresAt >= Date.now()
    );
  }

  const hookContext: RemoteHookContext = { store, clock, options };
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Webhooks come through a public relay (Tailscale Funnel, a reverse
    // proxy) that forwards its own host name. The host check guards pages a
    // signed-in browser reads; a delivery carries no session and its answer
    // reveals nothing, so /hooks/ is answered before it, and only there.
    const hook = new URL(request.url ?? "/", "http://placeholder");
    // v99: a liveness probe for a load balancer or orchestrator. It answers before the host check (a probe
    // uses the address it reached), reads one row, and says nothing else about the installation.
    const method = request.method ?? "GET";
    const matchedRoute = matchRoute(method, hook.pathname);
    const edgeRoute = matchedRoute?.stage === 'edge' ? matchedRoute : null;
    const wrongMethodEdge = edgeRoute === null ? ROUTES.find(row => row.stage === 'edge' && new RegExp(row.pattern).test(hook.pathname)) ?? null : null;
    if (edgeRoute?.host === 'before') return dispatchEdge(edgeRoute, { url: hook, who: null, request, response, method });
    if (wrongMethodEdge?.host === 'before') return refuseEdge(request, response, hook.pathname, wrongMethodEdge);
    if (!allowedHost(request.headers.host)) {
      return respond(response, 421, "text/html; charset=utf-8", wrongHostPage(wrongHost(request.headers.host)));
    }
    // A real domain (public-access.ts): HSTS for the public https host reached over HTTPS, and no API token over
    // plain HTTP from outside this computer and the tailnet — refused before anything reads or checks it.
    const transport = transportOf({ peer: request.socket.remoteAddress, joinSource: forwardedSourceOf(request), forwardedProto: request.headers["x-forwarded-proto"], forwarded: request.headers["forwarded"] });
    const hsts = hstsFor(publicOrigin?.host ?? null, request.headers.host, transport);
    if (hsts !== null) response.setHeader("Strict-Transport-Security", hsts);
    const insecure = plainHttpRefusal(transport, hook.pathname, request.headers.authorization);
    if (insecure !== null) {
      request.resume();
      return respond(response, 403, "text/plain; charset=utf-8", insecure);
    }

    const url = new URL(request.url ?? "/", "http://placeholder");
    // A token in a URL is a token in history, logs, and referers. Refused
    // outright rather than ignored, so nobody learns the habit works.
    if (url.searchParams.has("token")) {
      return respond(response, 400, "text/plain; charset=utf-8", "credentials never travel in URLs");
    }
    if (edgeRoute === null && isEdgeAddress(url.pathname)) return refuseEdge(request, response, url.pathname, wrongMethodEdge);
    // Live rooms share the browser identity/context below; their adapter carries token limits into each room.
    if (edgeRoute !== null && edgeRoute.domain !== 'people' && edgeRoute.domain !== 'live') return dispatchEdge(edgeRoute, { url, who: null, request, response, method });
    // Passive polls authenticate without extending the browser session.
    const fragmentName = url.searchParams.get("fragment");
    const workspaceRead = method === "GET" && url.searchParams.get('format') === 'workspace';
    const touch = !(method === "GET" && (edgeRoute?.domain === 'live' || workspaceRead || (fragmentName !== null && NO_TOUCH_FRAGMENTS.has(fragmentName)) || /^\/code\/[a-f0-9]{32}\/state$/.test(url.pathname)));
    const refuseBudget = (admitted: Admission): boolean => {
      if (admitted.ok) return false;
      request.resume();
      if (admitted.status === 429) response.setHeader("Retry-After", String(admitted.retryAfter));
      respond(response, admitted.status, "text/plain; charset=utf-8", admitted.status === 429 ? limitWords(admitted.limit, admitted.retryAfter) : "Request limits could not be checked; nothing ran. Try again shortly.");
      return true;
    };
    // One source charge before password proof and one account/token charge after it, including GET /login.
    if (refuseBudget(admitPasswordSource(request))) return;
    const refusedToken: { principal?: Principal } = {};
    const who = identify(request, touch, edgeRoute?.domain === 'live', refusedToken);
    if (refusedToken.principal !== undefined) {
      if (refuseBudget(requestBudget.admit(refusedToken.principal.tokenId, "api"))) return;
      if (method === "POST") {
        request.resume();
        return respond(response, 403, "text/plain; charset=utf-8", REMOTE_MESSAGES["step-up"]);
      }
    }
    if (who?.via === "bearer" && refuseBudget(admitBearer(request, who))) return;
    const passwordProof = who?.via === 'cookie' ? { name: who.name, generation: who.session.generation } : null;
    if (edgeRoute?.domain === 'people') return provenPasswordAccount.run(passwordProof, () => dispatchEdge(edgeRoute, { url, who, request, response, method }));


    if (who === null) {
      // A GET to an exact task or result (a phone's deep link) signs in and
      // comes back to it — the destination is a same-site path only.
      return method === "GET"
        ? redirect(response, loginHref(url.pathname + url.search))
        : respond(response, 401, "text/plain; charset=utf-8", "authenticate first");
    }

    const requestFacts = {
      theme: pinnedTheme(request.headers.cookie),
      accent: pinnedAccent(request.headers.cookie),
      updateSeen: /(?:^|;\s*)so-update-seen=([0-9A-Za-z.-]{1,60})(?:;|$)/.exec(request.headers.cookie ?? "")?.[1] ?? null,
      actor: who.name,
      csrf: who.via === "cookie" ? who.session.csrf : "",
      returnTo: safeReturn(url.pathname + url.search),
      // This console's own addresses: a lead reply's links there read as "the task", "the result", "Settings → Lead".
      appOrigins: [consoleOrigin(request.headers.host), publicOrigin?.origin ?? null, options.configDir === undefined ? null : loadConsoleUrl(process.env, options.configDir)],
      // Every signed-in page shares the workspace shell; pages showing a one-time secret opt out (forceSensitive).
      browser: who.via === 'cookie',
      // v100: signed in with the identity provider: its label, and whether it checked them recently enough to stand in for a password.
      sso: who.via === 'cookie' && who.session.sso !== undefined ? { label: ssoSettings()?.label ?? "your identity provider", fresh: Date.now() - who.session.sso.at < SSO_FRESH_MS } : undefined,
      refusal: (answer: ServerResponse, status: number, body: Html) => sendScreen(answer, status,
        screen(status === 404 ? "Not found" : "Request refused", body, { chrome: chromeFor(who.via === "cookie" ? who.session.project : null, "work") })),
      workspaceRead,
      workspaceRequest: url.searchParams.get('request'),
    };
    // An empty password stands for a fresh identity-provider sign-in, for this person only (v100).
    if (method === "GET" || method === "POST") return freshIdentitySignIn.run({ actor: requestFacts.sso?.fresh === true ? who.name : null }, () => provenPasswordAccount.run(passwordProof, () => requestContext.run(requestFacts, async () => {
      if (edgeRoute?.domain === 'live') return dispatchEdge(edgeRoute, { url, who, request, response, method });
      const body = method === "POST" ? await form(request, (matchedRoute?.stage === "console" ? matchedRoute.bodyCap : undefined) ?? BODY_CAP) : null;
      const target = actionTarget(url, who, request, body === null ? null : readForm(body, CONSOLE_FORMS.ledgerTarget));
      const execute = async () => {
        // THE ROUTE TABLE (server/route-table.ts): nothing reaches a handler unless a row declares this method and
        // path and admits this kind of caller. Undeclared addresses retain the legacy instance-access refusal
        // for project-limited accounts, before the unrestricted router's not-found response.
        const route = matchedRoute?.stage === "console" ? matchedRoute : null;
        if (route === null) return restricted()
          ? refuse(response, who, 403, "This area requires instance access. Your account operates within its assigned projects.", "/projects")
          : refuse(response, who, 404, "There's no page at this address.", "/chat");
        const policy = evaluateRoutePolicy(route, { caller: who.via, capability: who.via === "bearer" && who.principal !== undefined ? who.principal.scope : who.role === "approver" ? "act" : "read", viewer: who.role === "viewer", token: who.via === "bearer" && who.principal !== undefined },
          source => projectRequestAllowed(route, source, url, who, request, response, body));
        if (!policy.ok) {
          if (policy.reason === "project") return;
          request.resume();
          if (method === "POST" && who.via === "bearer" && who.principal?.scope === "read") return refuse(response, who, 403, REMOTE_MESSAGES.read);
          // A viewer's act stays refused even when the table rejects their caller first (for example a
          // password bearer at a step-up route). Preserve the viewer wording and explicit protocol refusals.
          if (policy.reason === "scope" || (method === "POST" && who.role === "viewer" && !route.viewer && route.callerRefusal === undefined)) {
            return refuse(response, who, 403, route.scopeRefusal ?? "your login can watch, not act — ask an approver to upgrade you");
          }
          return route.callerRefusal === undefined
            ? refuse(response, who, 403, "This address needs a browser sign-in.")
            : respond(response, route.callerRefusal.status, route.callerRefusal.type, route.callerRefusal.body);
        }
        if (method === "GET") {
          // Authorize every read before considering a conditional response.
          // Task/result opening and receipt reconciliation always re-read work.
          const facts = requestContext.getStore();
          if (facts?.workspaceRead && who.via === 'cookie' && route.id === 'chat.page' &&
              !url.searchParams.has('task') && !url.searchParams.has('result') && !url.searchParams.has('request')) {
            const key = createHash('sha256').update(JSON.stringify([workspaceIncarnation, who.name,
              who.session.generation, who.session.csrf, who.session.project, who.session.projectRevision,
              admissionList(), url.pathname + url.search, localSignIn?.signedIn ?? null])).digest('hex');
            const revision = workspaceRevision.current(), now = clock();
            const prior = workspaceValidators.get(key);
            if (prior && prior.revision === revision && prior.expiresAt > now.getTime() && request.headers['if-none-match'] === prior.etag) {
              response.setHeader('ETag', prior.etag);
              return respond(response, 304, 'application/json; charset=utf-8', '');
            }
            const expiresAt = workspaceRevision.expiresAt(now);
            // A clock-bound refresh receives a different validator even when
            // no database row changed (for example an expired worker lease).
            facts.workspaceValidator = { key, revision, expiresAt,
              etag: '"' + createHash('sha256').update(`${key}:${revision}:${expiresAt}`).digest('hex') + '"' };
          }
          return handleGet(route, url, who, request, response);
        }
        return handlePost(route, url, who, request, response, body!);
      };
      if (method === "GET") return projectAuthority.run({ actor: who.name, repo: target.repo }, execute);
      // Request acceptance is separate from durable work completion. Never
      // persist a body, query string, token, password, or arbitrary URL.
      const entry = { at: clock().toISOString(), actor: who.name, ...target, source: "request" as const, ...(who.via === "bearer" && who.token !== undefined ? { detail: `API token: ${who.token}` } : {}) };
      store.recordAction({ ...entry, outcome: "requested" });
      try {
        await projectAuthority.run({ actor: who.name, repo: target.repo }, execute);
        const createdTask = requestContext.getStore()?.createdTask;
        const placement = createdTask === undefined ? null : store.lookupRef(createdTask);
        store.recordAction({ ...entry, ...(placement === null ? {} : { repo: placement.repo, taskId: placement.externalId }), at: clock().toISOString(), outcome: response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "refused" : "accepted" });
      } catch (error) {
        store.recordAction({ ...entry, at: clock().toISOString(), outcome: "error" });
        throw error;
      }
    })));
    return respond(response, 405, "text/plain; charset=utf-8", "no such method here");
  }

  function actionTarget(url: URL, who: Who, request: IncomingMessage, body: FormView<FormFieldOf<"ledgerTarget">> | null = null): { repo: string | null; taskId: string | null; runId: number | null; action: string } {
    if (url.pathname === '/code' || url.pathname.startsWith('/code/')) {
      let repo = body?.get('repo') ?? null;
      const match = /^\/code\/([a-f0-9]{32})/.exec(url.pathname);
      if (match && coding && who.via === 'cookie') {
        try { repo = coding.get(match[1]!, { name: who.name, generation: who.session.generation }).repo; } catch { /* The route refuses unknown/foreign sessions. */ }
      }
      return { repo, taskId: null, runId: null, action: `coding ${body ? url.pathname.split('/').at(-1) : 'view'}` };
    }
    const shared=/^\/chat\/(?:action\/([0-9]{1,15})|proposal\/([0-9]{1,15})\/(?:confirm|dismiss))$/.exec(url.pathname);
    if (shared) {
      const proposal = store.getLeadProposal(Number(shared[1] ?? shared[2]));
      const action = proposal?.kind === 'action' ? sharedActionPayload(proposal.payload) : null;
      const room = proposal ? store.handle.prepare('SELECT id FROM team_conversation WHERE thread=?').get(proposal.thread) : null;
      let admitted = proposal && store.getLeadThread(proposal.thread)?.approver === who.name;
      if (room && who.via === 'cookie') {
        try { team.domain.access({ name: who.name, generation: who.session.generation }, String(room['id']), 'contributor'); admitted = true; }
        catch { admitted = false; }
      }
      if (admitted && proposal) {
        const taskId = typeof action?.request['task'] === 'string' ? action.request['task'] : typeof proposal.payload['task'] === 'string' ? proposal.payload['task'] : null;
        const repo = (action?.repo || null) ?? (taskId ? store.lookupRef(taskId)?.repo : null) ?? (typeof proposal.payload['repo'] === 'string' ? proposal.payload['repo'] : null);
        return { repo, taskId, runId: typeof action?.request['run'] === 'number' ? action.request['run'] : null, action: action?.operation ?? `chat ${proposal.kind}` };
      }
    }
    if (url.pathname.startsWith('/settings/skills')) return {repo:body?.get('repo')??url.searchParams.get('repo')??projectOf(who,request)??null,taskId:null,runId:null,action:body?'project skills change':'project skills view'};
    if (url.pathname.startsWith('/settings/knowledge')) return {repo:body?.get('repo')??url.searchParams.get('repo')??projectOf(who,request)??null,taskId:null,runId:null,action:body?'project knowledge change':'project knowledge view'};
    const task = matchTaskPath(url.pathname, "(?:/([a-z-]+))?$");
    if (task !== null) return { repo: store.lookupRef(task.taskId)?.repo ?? null, taskId: task.taskId, runId: null, action: `task ${task.verb || "view"}` };
    const resource = /^\/(r|d|i)\/([0-9]{1,15})(?:\/([a-z-]+)(?:\/[0-9]+)?)?$/.exec(url.pathname);
    if (resource !== null) {
      const id = Number(resource[2]);
      const runId = resource[1] === "r" ? id : resource[1] === "d" ? store.getDecision(id)?.run ?? null : store.openIncidents().find(one => one.id === id)?.run ?? null;
      const run = runId === null ? null : store.getRun(runId);
      const ref = run === null ? null : store.refForId(run.taskRef);
      return { repo: ref?.repo ?? null, taskId: ref?.externalId ?? null, runId, action: `${resource[1] === "d" ? "decision" : resource[1] === "i" ? "incident" : "run"} ${resource[3] ?? "view"}` };
    }
    const known = new Set(["/recipes/prepare", "/recipes/preview", "/recipes/import", "/recipes/save", "/recipes/launch", "/tasks/add", "/queue/move", "/queue/note", "/people/invite", "/people/invite-revoke", "/people/revoke", "/people/projects", "/projects/select", "/projects/open", "/mode/confirm", "/mode/sign", "/mode/revoke", "/settings/chat-approval/save", "/settings/chat-approval/off"]);
    const placed = url.pathname === "/tasks/add" ? body?.get("repo")?.trim() : null;
    return { repo: url.pathname.startsWith("/people/") ? null : placed ? canonicalProject(placed) ?? placed : projectOf(who, request) ?? null, taskId: null, runId: null,
      action: known.has(url.pathname) ? url.pathname.slice(1).replaceAll("/", " ") : "console request" };
  }

  async function handleGet(route: RouteDeclaration, url: URL, who: Who, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const now = clock();
    let project = projectOf(who, request);
    if (project === undefined) {
      return refuse(response, who, 403, "that project is outside what this server was configured to show");
    }
    // A project link is a read context, not a session-changing operation.
    // Prove it against both admission and the known project catalog before
    // collection queries; unknown/foreign paths reveal no work.
    if ((route.id === 'work' || route.id === 'system') && url.searchParams.has('project')) {
      const wanted = url.searchParams.get('project') ?? '';
      if (url.searchParams.getAll('project').length !== 1 || !visible(wanted) ||
          ![...managedRepos(), ...store.listProjects().map(one => one.path)].includes(wanted)) {
        return refuse(response, who, 404, 'That project is not available in this workspace.', '/projects');
      }
      project = wanted;
    }
    // Every page's Tasks count covers this one project view, whatever project the page itself shows.
    const facts = requestContext.getStore();
    if (facts !== undefined) facts.lens = project;
    // Exact result links carry their own read context. Check the stored
    // placement against both account and instance access before using it;
    // viewing a result never changes the session's selected project, and
    // the page's project switch keeps showing the person's own choice.
    const chosenProject = project;
    if (route.id === "review" && url.searchParams.has("result")) {
      const wanted = url.searchParams.get("result") ?? "";
      const ref = wanted.length > 0 && wanted.length <= 64 && !hasForbiddenControls(wanted) ? store.lookupRef(wanted) : null;
      const namedProject = url.searchParams.get("project");
      if (url.searchParams.getAll("result").length !== 1 || url.searchParams.getAll("run").length > 1 || url.searchParams.getAll("project").length > 1 ||
          (namedProject !== null && (ref === null || !visible(ref.repo) || namedProject !== ref.repo))) {
        return refuse(response, who, 404, "No such result in your projects.", "/work");
      }
      if (who.via === "cookie" && ref !== null && visible(ref.repo)) project = ref.repo;
    }

    // Nothing open and more than one thing to choose: land on the opener.
    // Decisions and their evidence stay reachable — answering must never be
    // blocked by project state — and the opener itself must not loop.
    // A run's page and its evidence (workspace package 1): a bookmarked
    // `/r/<id>` from All projects used to bounce to the opener until a
    // project was chosen. The handler below re-proves the run's repo
    // against the ceiling and the account (`runVisible`) before a byte
    // renders, so letting the path through widens nothing.
    // The chat's two read-only refresh routes (package 2 revision): the
    // page itself is allowed from All projects, so its status poll and
    // task fragment must be too — a 303 to the opener answered the poll
    // with HTML and the page wrongly said the sign-in was lost. Each
    // route keeps its own cookie, role, session, ceiling, and task
    // admission checks. Shared action links likewise recheck the saved
    // owner and project in their handler, so they stay reachable from All
    // projects without changing the selected project or granting access.
    // Which reads first need an open project is the route table's `needsProject` column; an exact result link
    // and the all-projects board carry their own read context.
    const needsProject =
      who.via === "cookie" && project === null && !unscopedMode &&
      route.needsProject &&
      !(route.id === "review" && url.searchParams.has("result")) &&
      !(route.id === "board" && url.searchParams.get("scope") === "all");
    if (needsProject) return redirect(response, `/projects?return=${encodeURIComponent(safeReturn(url.pathname + url.search))}`);
    return dispatchConsole(route, { url, who, request, response, route, now, project, chosenProject, posted: new URLSearchParams() });
  }

  /**
   * The first run (adoption track, step 3): three plain steps derived from
   * live state on every render, never a stored cursor, and retired
   * PERMANENTLY by the first-success installation fact (Codex adoption
   * review, finding 14). Each step is either something this console can do,
   * or the exact command where only the CLI can (finding e).
   */
  function firstRunStepsNow(now: Date): FirstRunStep[] | null {
    if (restricted() || store.isDemo() || store.firstSuccessAt(now) !== null) return null;
    return firstRunSteps({ agentSignedIn: agentSignedIn(now), projects: managedRepos().length, hasTask: store.hasAnyWork(), firstResultAt: null, signInCommand: agentSignInCommand() });
  }
  /**
   * Whether a coding agent is signed in where the work runs. This machine's
   * own checks (the ones Settings makes) speak only for a worker on this
   * machine, or for the first one while none is registered yet (it is started
   * here); a worker elsewhere speaks through its own readiness report, and
   * the console never claims to have checked that machine (finding 15).
   * Nothing here waits on a probe: this machine's answer is the last one
   * seen, refreshed in the background, and null until the first one is in.
   */
  function agentSignedIn(now: Date): boolean | null {
    const here = hostname();
    const registered = store.listRunners().filter(one => one.retiredAt === null);
    const workers = registered.filter(one => runnerAlive(one, now));
    if (workers.some(one => one.host !== here && store.providerReadiness(one.name).some(seen => seen.state === "ready"))) return true;
    return options.localRunner !== undefined || registered.length === 0 || workers.some(one => one.host === here) ? localAgentSignedIn() : false;
  }
  let localSignIn: { at: number; signedIn: boolean; states: Record<"claude" | "codex", ProviderConnection["state"] | "unverified"> } | null = null;
  let localSignInChecking: Promise<void> | null = null;
  let leadRecheckedAt = 0;
  /** Ask this computer's agent CLIs again (no model, nothing spent); `fresh` skips their 30-second cache. */
  function checkLocalAgents(fresh = false): Promise<void> {
    if (localSignInChecking !== null) return localSignInChecking;
    localSignInChecking = Promise.all((["claude", "codex"] as const).map(one => connectionCheck(one, fresh).then(value => value.state, () => "unverified" as const)))
      .then(([claude, codex]) => {
        localSignIn = { at: Date.now(), signedIn: [claude, codex].some(state => state === "connected" || state === "key-works" || state === "key-present"), states: { claude: claude!, codex: codex! } };
        leadByDefault();
      })
      .catch(() => {})
      .finally(() => { localSignInChecking = null; });
    return localSignInChecking;
  }
  function localAgentSignedIn(): boolean | null {
    if (localSignInChecking === null && (localSignIn === null || Date.now() - localSignIn.at > 30_000)) void checkLocalAgents();
    return localSignIn?.signedIn ?? null;
  }
  /**
   * The lead on by default (onboarding): with no lead set up yet, the agent CLI signed in on this computer runs it
   * (Claude Code first, else Codex) on its membership with today's safe defaults: the CLI's own default model, 50 turns
   * a day, no dollar spend, and every action it proposes still a card a person confirms. Once only, ever: a lead
   * someone turned off stays off, and Settings → Lead changes it.
   */
  function leadByDefault(): void {
    if (options.leadByDefault !== true || store.isDemo() || store.getChatConfig() !== null || store.installationFact(LEAD_BY_DEFAULT_FACT) !== null) return;
    const provider = localSignIn?.states.claude === "connected" ? "claude-subscription" : localSignIn?.states.codex === "connected" ? "codex-subscription" : null;
    if (provider === null) return;
    const now = clock();
    store.setChatConfig({ provider, model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "toolroll", now);
    store.recordInstallationFact(LEAD_BY_DEFAULT_FACT, provider, now);
  }
  // Look once at start, so the lead is on by the time the browser opens.
  if (options.leadByDefault === true && !store.isDemo() && store.getChatConfig() === null) void checkLocalAgents();
  /** What the lead runs on, in words for one line ("your Claude Code sign-in"); null for a direct API or no lead. */
  function leadWords(): string | null {
    const config = store.getChatConfig();
    return config?.provider === "claude-subscription" ? "your Claude Code sign-in" : config?.provider === "codex-subscription" ? "your Codex sign-in" : null;
  }
  /** The one command that gets an agent signed in here, for this operating system: sign in when its CLI is installed, else install Claude Code and sign in. */
  function agentSignInCommand(): string {
    return signInCommandFor(localSignIn?.states ?? null, options.platform ?? process.platform);
  }
  /** First tasks per project: the last ones found (safe generic ones until then), re-read in the background at most
   * every ten minutes. A render never waits on `gh` or `git grep`. */
  const firstTasks = new Map<string, { until: number; found: FirstTaskSuggestion[] | null; reading: boolean }>();
  /** The phone setup itself (Settings → Chat apps): a chat app, or this console over Tailscale. */
  function phoneSetup(who: Who): BrowserPhoneCard | undefined {
    if (who.role !== "approver" || store.isDemo()) return undefined;
    const port = servedPort() ?? 4180;
    const address = server.address();
    const bound = typeof address === "object" && address !== null ? address.address : "127.0.0.1";
    const name = tailnet[0] ?? null;
    const reachable = bound !== "127.0.0.1" && bound !== "::1";
    return {
      chatApps: [{ label: "Telegram", href: "/settings/telegram" }, { label: "Slack", href: "/settings/slack" }, { label: "Discord", href: "/settings/discord" }, { label: "Teams", href: "/settings/teams" }],
      tailnet: name === null ? null : { address: `http://${name}:${port}/`, restart: reachable ? null : consoleCommand({ host: "0.0.0.0" }) },
      dismissHref: "/onboarding/phone/dismiss",
    };
  }


  // ---- fleet chat (v13) ----------------------------------------------------

  const chatFetcher = options.chatFetcher ?? fetch;
  const chatEnv = options.chatEnv ?? process.env;
  /** The lead's last non-answer per BROWSER session (keyed by its csrf —
   * never by name, so two browsers on one account do not read each other's
   * notes), bound to the mate turn it came from so a note from a session
   * that has since ended never shows; bounded; read once. */
  const leadSaid = new Map<string, { turn: number | null; message: string }>();
  /** The unified conversation's rows for one reader (package 2): the SAME
   * rows the page renders and the status poll's fragments re-render, so a
   * live update can never show a card the page would not. A task lens
   * keeps only that task's coordinator cards; the lead's own thread is one
   * thread regardless of lens. */
  function leadConversationRows(who: Who & { via: "cookie" }, principal: VerifiedApprover, focusTask: TaskChatFocus | null, now: Date, chatProject: string | null = null): {
    messages: LeadMessage[]; proposals: LeadProposal[]; decisions: Map<number, Decision>; coordinatorProposals: CoordinatorProposal[]; pending: LeadTurn | null; recent: LeadTurn[]; ask: LeadAsk | null; asks: Map<number, LeadAsk>;
    previous: ReplacedThread | null;
  } {
    const allCoordinatorRows = store.listCoordinatorProposals({ repos: managedRepos(), states: ["pending", "confirmed", "refused"], limit: 30 });
    const coordinatorProposals = focusTask !== null ? allCoordinatorRows.filter(one => focusTask.family.versions.some(version => version.id === one.payload["task"]))
      : chatProject !== null ? allCoordinatorRows.filter(one => one.repo === chatProject) : allCoordinatorRows;
    const opened = store.openLeadThread(who.name, principal.ceilingDigest, now, chatScopeOf(focusTask, chatProject));
    const proposals = store.listLeadProposals(opened.thread.id);
    // One reply runs at a time per person; this thread shows it only when
    // the reply is its own.
    const live = store.liveLeadTurnFor(who.name);
    const messages = store.listLeadMessages(opened.thread.id, 40);
    // The lead's question with buttons, while its reply is the last word in the thread.
    const last = messages.at(-1);
    const ask = last?.role === "assistant" && last.turn !== null && store.getLeadTurn(last.turn)?.approver === who.name ? store.leadAskOpen(last.turn, now) : null;
    // Answered questions stay readable above the answer; only their buttons go.
    const asks = new Map(messages.flatMap(one => { const asked = one.role === "assistant" && one.turn !== null ? store.leadAsk(one.turn) : null; return asked === null ? [] : [[asked.turn, asked] as const]; }));
    // The thread a ceiling change replaced (ruling 9): read after the open, display only.
    const replaced = store.replacedLeadThread(opened.thread);
    const previousProposals = replaced === null ? [] : store.listLeadProposals(replaced.id);
    return {
      previous: replaced === null ? null : { messages: store.listLeadMessages(replaced.id, 40), proposals: previousProposals, decisions: decisionsFor(store, previousProposals) },
      messages,
      ask,
      asks,
      proposals,
      decisions: decisionsFor(store, [...proposals, ...coordinatorProposals]),
      coordinatorProposals,
      pending: live !== null && live.thread === opened.thread.id ? live : null,
      recent: store.recentLeadTurns(who.name, 5),
    };
  }
  /** The thread a chat surface speaks in (v77): the task's own thread, the
   * project's, or the lead conversation across every project. */
  function chatScopeOf(focusTask: TaskChatFocus | null, chatProject: string | null): LeadThreadScope {
    return focusTask !== null ? { kind: "task", key: focusTask.id } : chatProject !== null ? { kind: "project", key: chatProject } : LEAD_THREAD;
  }
  const liveTurns = new Map<number, LiveTurn>();

  /** The Ask panel (v77): the conversation a task, result or project page
   * docks beside itself — that page's own thread, the same session and
   * cards as /chat. Null when this person has no lead chat here. A page
   * view may start a membership conversation, as /chat does. */
  function dockedConversation(who: Who, focusTask: TaskChatFocus | null, chatProject: string | null, now: Date, back: string, resultRunId: number | null = null): import("./browser-workspace.js").BrowserConversation | null {
    if (who.via !== "cookie" || who.role !== "approver" || (focusTask === null && chatProject === null)) return null;
    const enabled = chatEnablement();
    const principal = enabled.ok ? leadPrincipal(who) : null;
    if (!enabled.ok || principal === null) return null;
    let session = store.activeLeadSession(who.name);
    if ((session === null || session.ceilingDigest !== principal.ceilingDigest) && enabled.billing === "subscription" && !requestContext.getStore()?.workspaceRead) {
      startLeadConversation(who, principal, enabled, 0, false, now);
      session = store.activeLeadSession(who.name);
    }
    if (session === null || session.ceilingDigest !== principal.ceilingDigest || session.approverGeneration !== principal.generation) return null;
    const rows = leadConversationRows(who, principal, focusTask, now, chatProject);
    return {
      sessionId: session.id, user: session.approver, version: leadChatVersion({ ...rows, focusTask }),
      messages: leadBrowserMessages(rows, back, { task: focusTask?.id ?? null, project: chatProject }),
      pendingTurnId: rows.pending?.id ?? null, requestId: randomBytes(16).toString("hex"), maxChars: LEAD_MESSAGE_MAX_CHARS,
      taskId: focusTask?.id ?? null, resultRunId, project: focusTask === null ? chatProject : null,
    };
  }
  /** The session-layer principal (ruling 3): cookie, csrf, and role were
   * proved at the edge; the row and the generation are re-proved here. */
  /** Start the person's lead conversation: the session every later turn
   * debits (a membership spends nothing; direct API gets a per-conversation
   * ceiling) and its thread. Starting ends any older session. */
  function startLeadConversation(who: Who & { via: "cookie" }, principal: VerifiedApprover, enabled: Extract<ChatEnablement, { ok: true }>, ceilingUsd: number, follow: boolean, now: Date): number {
    const ceilingMicrousd = enabled.billing === "subscription" ? 0 : Math.round(ceilingUsd * 1_000_000);
    const termsDigest = createHash("sha256").update(`${ceilingMicrousd}\n${principal.ceilingDigest}`).digest("hex");
    const sessionId = store.mintLeadSession(
      { approver: who.name, approverGeneration: principal.generation, credentialKey: enabled.credentialKey, ceilingMicrousd, ceilingDigest: principal.ceilingDigest, termsDigest },
      now,
    );
    const thread = store.openLeadThread(who.name, principal.ceilingDigest, now).thread;
    if (follow) configureLeadFollow(store, principal, store.getLeadSession(sessionId)!, thread, true, now);
    leadSaid.delete(who.session.csrf);
    return sessionId;
  }
  function leadPrincipal(who: Who & { via: "cookie" }): VerifiedApprover | null {
    const verified = verifyApproverStanding(store, who.name, who.session.generation, managedRepos());
    return verified.ok ? verified.who : null;
  }
  const CHAT_CANDIDATES_PER_APPROVER = 9;
  const CHAT_CANDIDATE_TTL_MS = 30 * 60_000;

  /** The frozen explicit repo list, digested canonically (sorted) — every
   * candidate binds to it and filing re-proves it (v2 new finding 5). */
  const chatCeilingDigest = (repos: readonly string[] = managedRepos()): string =>
    createHash("sha256").update([...repos].sort().join("\n")).digest("hex");

  /** The scripted lead answers only inside a demo database. */
  function demoLeadHere(): DemoLead | null {
    return options.demoLead !== undefined && store.isDemo() ? options.demoLead : null;
  }

  /** Every condition re-proved per request — the render and the POST each
   * ask again; nothing is cached into authority. */
  function chatEnablement(): ChatEnablement {
    if (store.isDemo()) return { ok: false, code: "demo", why: "this is a demo database — chat cannot contact an external model" };
    if (unscopedMode) return { ok: false, code: "unscoped", why: "chat needs at least one added project" };
    if (options.currentRepos === undefined && unresolvedRepos.length > 0) {
      return { ok: false, code: "unresolved", why: "a configured project path did not resolve at startup — fix it and restart before chat will run" };
    }
    if (managedRepos().length === 0) return { ok: false, code: "empty", why: "add a project first — chat will include it automatically" };
    const config = store.getChatConfig();
    if (config === null) return { ok: false, code: "unconfigured", why: "the lead is off — turn it on in Settings → Lead, or from the terminal: toolroll config set chat" };
    if (isSubscriptionChatProvider(config.provider)) {
      return {
        ok: true,
        billing: "subscription",
        config: config as ChatConfig & { provider: SubscriptionChatProviderId },
        key: null,
        keySource: null,
        price: null,
        credentialKey: subscriptionCredentialKey(config.provider),
      };
    }
    const price = priceForConfig(config);
    if (price === null) return { ok: false, code: "unpriced", why: `no pinned price for ${config.model} — re-save the configuration to pin one` };
    const key = chatKeyFor(config.provider);
    if (key === null) return { ok: false, code: "no-key", why: `no ${config.provider} key — paste one below (stored 0600 beside the database, never in it), or export ${CHAT_KEY_ENV[config.provider]} in the serve environment` };
    return { ok: true, billing: "metered", config: config as ChatConfig & { provider: DirectChatProviderId }, key: key.key, keySource: key.source, price, credentialKey: credentialKeyOf(config.provider, key.key) };
  }

  /**
   * Where a chat key comes from, in priority order: the serve process
   * environment, then the 0600 key file under the config directory (the
   * Telegram bot-token precedent — settable from the console, never the
   * database, never echoed whole). The file exists so onboarding lives
   * in the UI; the environment exists so operators who prefer it keep it.
   */
  function chatKeyFor(provider: DirectChatProviderId): { key: string; source: "environment" | "stored" } | null {
    const fromEnv = chatEnv[CHAT_KEY_ENV[provider]];
    if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, source: "environment" };
    if (options.configDir === undefined) return null;
    try {
      const read = readFileSync(join(options.configDir, `chat-key-${provider}`), "utf8").trim();
      return read === "" ? null : { key: read, source: "stored" };
    } catch {
      return null;
    }
  }

  /** OpenRouter's live catalog, cached briefly: every selectable model
   * arrives WITH the price the config will pin (operator request — the
   * whole catalog, not a hand-pinned shortlist). null = no key or the
   * catalog is unreachable; callers fall back to the compiled table. */
  let catalogCache: { at: number; models: import("./converse.js").CatalogModel[] } | null = null;

  async function chatCatalog(): Promise<import("./converse.js").CatalogModel[] | null> {
    const key = chatKeyFor("openrouter-api")?.key;
    if (key === undefined) return null;
    if (catalogCache !== null && Date.now() - catalogCache.at < 600_000) return catalogCache.models;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const got = await fetchOpenRouterCatalog(key, chatFetcher, controller.signal);
      if (!got.ok) return null;
      catalogCache = { at: Date.now(), models: got.models };
      return got.models;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The palette's server-rendered index (attended review, finding 4): a
   * non-executable JSON block on an already-authorized page — the same
   * titles the page itself may render, bounded, saturation declared.
   */
  function paletteIndexTag(project: string | null): Html {
    const admitted = project === null ? admissionList() : null;
    const entries: { label: string; href: string }[] = [
      { label: "work", href: "/work" },
      { label: "needs you", href: "/work?view=needs-you" },
      { label: "inbox", href: "/" },
      { label: "board", href: "/board?scope=all" },
      { label: "queue", href: QUEUE_VIEW },
      { label: "workbench", href: "/workbench" },
      { label: "flows", href: "/flows" },
      { label: "done", href: "/done" },
      { label: "review cockpit", href: "/review" },
      { label: "task list", href: "/tasks" },
      { label: "fleet", href: "/fleet" },
      { label: "activity", href: "/activity" },
      { label: "action ledger", href: "/ledger" },
      { label: "system", href: "/system" },
      { label: "builds", href: "/runs" },
      { label: "requirements", href: "/caps" },
      { label: "projects", href: "/projects" },
      ...(options.telegramTokenFile !== undefined ? [{ label: "settings", href: "/settings" }] : []),
    ];
    const open = store.paletteTasks(project, 201, admitted, visible(null));
    for (const one of open.slice(0, 200)) {
      entries.push({ label: `${one.id} — ${one.title}`, href: `/t/${encodeURIComponent(one.id)}` });
    }
    const saturated = open.length > 200;
    const safeEntries = restricted() ? entries.filter(one => ["/work", "/work?view=needs-you", "/", "/board", "/flows", "/done", "/review", "/tasks", "/runs", "/projects", "/ledger"].includes(one.href) || one.href.startsWith("/t/")) : entries;
    return jsonScript(saturated ? [...safeEntries, { label: "… more in the task list", href: "/tasks" }] : safeEntries, { id: "palette-index" });
  }

  /**
   * The palette cache (arc 4, finding 6), and its honest contract: a
   * render may be up to five seconds stale after OUT-OF-PROCESS changes;
   * an accepted in-process mutation invalidates immediately (bustBadge),
   * so "one query per five seconds" holds only between invalidations;
   * and an OPEN page keeps its navigation-time snapshot until the next
   * navigation — no refresh mechanism exists or is promised. The key
   * carries the one configuration bit the entries vary by.
   */
  const paletteCache = new Map<string, { at: number; tag: Html }>();
  function paletteTagCached(project: string | null): Html {
    const actor = requestContext.getStore()?.actor;
    const key = `${actor ?? ""}:${actor === undefined ? "" : store.accountOf(actor)?.generation}:${project ?? "(none)"} ${options.telegramTokenFile !== undefined}`;
    const hit = paletteCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < 5000) return hit.tag;
    const tag = paletteIndexTag(project);
    paletteCache.set(key, { at: Date.now(), tag });
    return tag;
  }

  /**
   * Every chromed HTML response leaves through here (arc 4, findings
   * 5/18): one place owns the sensitivity call, the nonce, the palette
   * index, the shortcuts overlay, script composition, and the CSP —
   * at most one nonce-bearing script per response, connect-src only when
   * that script fetches. The named exception: /fleet and /settings keep
   * their FUNCTIONAL scripts beside credential fields (a poller and the
   * push enrollment — neither reads the fields); the chrome additions
   * are what sensitivity strips.
   */
  function sendScreen(response: ServerResponse, status: number, s: Screen): void {
    // v100: signed in with the identity provider, a step-up's password field is that sign-in instead.
    const ssoFacts = requestContext.getStore()?.sso;
    if (ssoFacts !== undefined) {
      const back = requestContext.getStore()?.returnTo ?? "/";
      s = { ...s, body: ssoStepUps(s.body, ssoFacts, back), ...(s.workspace?.pageHtml == null ? {} : { workspace: { ...s.workspace, pageHtml: ssoStepUps(s.workspace.pageHtml, ssoFacts, back) } }) };
      if (s.workspace?.view?.kind === "flow") s = { ...s, workspace: { ...s.workspace, view: { ...s.workspace.view, stepUp: { label: ssoFacts.label, fresh: ssoFacts.fresh, confirmHref: `/login/sso?reauth=1&return=${encodeURIComponent(back)}` } } } };
    }
    // D5: team chat (the central team service) is deprecated; /chat?team=1 still opens this release, but nothing links to it.
    const sensitive =
      s.forceSensitive === true ||
      SENSITIVE_INPUT.test(htmlString(s.body)) ||
      (s.chrome?.listPane !== undefined && SENSITIVE_INPUT.test(htmlString(s.chrome.listPane)));
    const requestFacts = requestContext.getStore();
    if (requestFacts?.browser && s.chrome && !s.forceSensitive && (requestFacts.workspaceRead || browserAssetsAvailable())) {
      const path = new URL(requestFacts.returnTo, 'http://standing-orders.local');
      path.searchParams.delete('format');
      path.searchParams.delete('request');
      const currentPath = path.pathname + path.search;
      path.searchParams.set('format', 'workspace');
      // The legacy list pane (every task or build as links) duplicates the
      // Crew panel and Tasks page; inside the workspace the page stands alone.
      const pageHtml = htmlString(s.body);
      const extras = s.workspace ?? {};
      const notices = [...(extras.notices ?? [])];
      if (s.chrome.modeBanner) notices.push(s.chrome.modeBanner.words);
      if (s.chrome.updateWaiting) notices.push(s.chrome.updateWaiting.words);
      let crew: Pick<BrowserWorkspace, 'crew' | 'crewTruncated'> = { crew: [], crewTruncated: false };
      try {
        const project = s.chrome.active === 'chat' ? null : s.chrome.project;
        crew = extras.team?.tasks ? browserCrewFromIndex(extras.team.tasks, extras.team.selected?.id) : requestFacts.workCrew?.project === project ? browserCrewFromIndex(requestFacts.workCrew.page)
          // The reader's own lead's claims read "<name> is on it" here too.
          : browserCrewOf(store, clock(), { principal: 'operator', repos: managedRepos(), includeUnplaced: false, viewer: requestFacts.actor ?? null }, { evidenceRoot, project });
      } catch { notices.push('Crew updates are unavailable. Open Tasks to inspect saved work.'); }
      // A running row says what its agent did last, and when (the task page's own line).
      try {
        const now = clock(), live = new Map<string, RunActivity>();
        if (crew.crew.length > 0) for (const run of store.liveRuns(now)) {
          const root = familyOf(run.taskId)?.root.id;
          if (root !== undefined && !live.has(root)) live.set(root, runActivityOf(store, run, now));
        }
        if (live.size > 0) crew = { ...crew, crew: crew.crew.map(item => { const activity = live.get(item.id); return activity === undefined ? item : { ...item, activity }; }) };
      } catch { /* the rows keep their status; the line returns on the next read */ }
      // "Wake me only for these": the navigation carries the sidebar's own
      // Tasks count (chromeFor) and links to the project view it covers, so
      // it matches that page's Needs you tab on every screen.
      const needsYou = s.chrome.inboxCount;
      const tasksProject = s.chrome.inboxProject === undefined ? s.chrome.project : s.chrome.inboxProject;
      // The person's own project and task conversations (v77), for the
      // sidebar's chat list; a thread whose project is out of view is left out.
      let chats: BrowserChatLink[] = [];
      try {
        const actor = requestFacts.actor ?? '';
        if (actor !== '') {
          chats = store.listLeadThreads(actor, 16).flatMap((thread): Omit<BrowserChatLink, 'active'>[] => {
            if (thread.scope.kind === 'project') {
              const repo = thread.scope.key;
              return visible(repo) && managedRepos().includes(repo) ? [{ kind: 'project', title: projectName(repo), href: projectChatHref(repo), at: thread.lastMessageAt }] : [];
            }
            if (thread.scope.kind === 'task') {
              const ref = store.lookupRef(thread.scope.key), task = store.getTask(thread.scope.key);
              return ref !== null && task !== null && visible(ref.repo) ? [{ kind: 'task', title: task.title, href: taskChatHref(thread.scope.key), at: thread.lastMessageAt }] : [];
            }
            return [];
          }).slice(0, 6).map(one => ({ ...one, active: one.href === currentPath }));
        }
      } catch { chats = []; }
      const conversation = extras.conversation ?? null;
      const request = requestFacts.workspaceRequest;
      const workspace: BrowserWorkspace = {
        version: 1, path: currentPath, title: s.title, user: requestFacts.actor ?? '', csrf: requestFacts.csrf, sensitive,
        ...(requestFacts.actor ? { leadName: leadNameOf(store, requestFacts.actor) } : {}),
        refreshUrl: path.pathname + path.search,
        receipt: conversation !== null && request && REQUEST_TOKEN.test(request)
          ? { request, received: store.leadRequestReceipt(conversation.sessionId, request) !== null } : null,
        projects: browserProjectsOf(s.chrome.projects ?? []), ...crew,
        conversation, ...(extras.team ? { team: extras.team } : {}), focus: extras.focus ?? null, result: extras.result ?? null,
        catchUpHtml: extras.catchUpHtml === undefined ? '' : htmlString(extras.catchUpHtml), controlsHtml: extras.controlsHtml === undefined ? '' : htmlString(extras.controlsHtml), notices, view: extras.view ?? null,
        ...(s.chrome.demo ? { demo: { text: DEMO_BANNER, short: DEMO_BANNER_SHORT } } : {}),
        pageHtml: extras.pageHtml === undefined ? (conversation === null ? pageHtml : null) : extras.pageHtml === null ? null : htmlString(extras.pageHtml),
        navigation: [...browserNavigationOf(currentPath, s.chrome.project, needsYou, tasksProject, s.chrome.inboxLabel), { label: 'Workspace tools', href: '/menu', active: path.pathname === '/menu' }],
        chats,
        ...(s.refreshSeconds === undefined ? {} : { refreshSeconds: Math.max(5, Math.floor(s.refreshSeconds)) }),
        ...(s.chrome.signIn === undefined ? {} : { signIn: s.chrome.signIn }),
        ...(s.chrome.update === undefined ? {} : { update: s.chrome.update }),
        ...(extras.firstRun === undefined ? {} : { firstRun: extras.firstRun }),
        ...(extras.phone === undefined ? {} : { phone: extras.phone }),
        ...(extras.home == null ? {} : { home: extras.home }),
      };
      if (requestFacts.workspaceRead) {
        const validator = requestFacts.workspaceValidator;
        if (status === 200 && validator !== undefined) {
          workspaceValidators.set(validator.key, validator);
          response.setHeader('ETag', validator.etag);
        }
        return respond(response, status, 'application/json; charset=utf-8', JSON.stringify(workspace));
      }
      const nonce = randomBytes(16).toString('base64');
      // React owns the conversation and its refresh/draft lifecycle. Native
      // guarded forms keep their current behavior after React inserts them.
      // A page with its own view keeps its script; the chat page runs the result script.
      const functional = conversation === null || extras.view ? (s.functional?.script ?? '') : RESULT_REVIEW_SCRIPT;
      const document = shell(s.title, s.body, { chrome: s.chrome, sensitive });
      return page(response, status, browserWorkspaceDocument(document, workspace, nonce,
        functional + MOBILE_VIEWPORT_SCRIPT), nonce, true);
    }
    // A one-time secret on screen (a token, an invite link, a pairing code): the
    // page carries no script of any kind, so it leaves the workspace for a
    // focused page in the same look: the brand, the one card, and the way back.
    if (s.forceSensitive === true) return page(response, status, focusDocument(s.title, s.body));
    const chromeLayer = !sensitive && s.chrome !== undefined;
    const functional = s.functional?.script ?? "";
    // Sensitive pages strip the palette and keys but keep the sidebar toggle.
    const sensitiveChrome = sensitive && s.chrome !== undefined ? sidebarScript() : "";
    const script = functional + (chromeLayer ? chromeScript() + WORKSPACE_MOTION_SCRIPT : sensitiveChrome);
    const nonce = script === "" ? undefined : randomBytes(16).toString("base64");
    const body = chromeLayer
      ? html`${s.body}\n${paletteTagCached(s.chrome?.project ?? null)}\n${KBD_HELP}`
      : s.body;
    const document = shell(s.title, body, {
      ...(s.chrome === undefined ? {} : { chrome: s.chrome }),
      ...(sensitive ? { sensitive: true } : {}),
      ...(s.chrome !== undefined ? { sidebarToggle: true } : {}),
      ...(s.refreshSeconds === undefined ? {} : { refreshSeconds: s.refreshSeconds }),
      ...(nonce === undefined ? {} : { live: { nonce, script, fallbackRefresh: s.functional?.fetches === true } }),
    });
    // Pages that ship the chrome layer keep connect-src (v28 granted it for
    // the since-removed watched-session beat), beside pages whose own
    // functional script polls.
    return page(response, status, document, nonce, s.functional?.fetches === true || chromeLayer || sensitiveChrome !== "");
  }
  /** The needs-you count every surface wears, read from this request's own
   * Work counts (one query per request, never a cached earlier one), so a
   * live page's badge and its Needs you tab always agree. */
  function needsYouBadge(project: string | null): { count: number; saturated: boolean } {
    return needsYouCount(project);
  }
  const bustBadge = (): void => {
    paletteCache.clear();
  };

  /** The sidebar's facts for this request. */
  function chromeFor(
    project: string | null,
    active: Chrome["active"],
    listPane?: Html,
    scope?: Chrome["scope"],
  ): Chrome {
    if (restricted() && !visible(project)) project = null;
    const actor = requestContext.getStore()?.actor;
    // One Tasks count per request: Needs you in the request's project view
    // (the open project, else every admitted project), never the page's own
    // project — a flow or task in another project shows the same number.
    const lens = requestContext.getStore()?.lens;
    const inboxProject = lens !== undefined && (!restricted() || visible(lens)) ? lens : project;
    const badge = needsYouBadge(inboxProject);
    const liveMode = project === null ? null : store.activeMode(project, clock());
    const liveModeTerms = liveMode === null ? null : modeTermsFromJson(liveMode.termsJson);
    let projectPeek: ProjectPeek | null | undefined = project === null ? null : undefined;
    if (project !== null) {
      try {
        projectPeek = projectFamilyPeek(project, clock());
      } catch {
        // Chrome is orientation, never a reason to fail the actual screen.
        projectPeek = undefined;
      }
    }
    const facts = requestContext.getStore();
    return {
      active,
      code: Boolean(facts?.csrf && actor && store.isInstanceOperator(actor)),
      project,
      projectScoped: restricted(),
      ...(projectPeek === undefined ? {} : { projectPeek }),
      // Enrolled projects first (most recently opened), then the repos this
      // server was told to serve that nobody has opened yet — the switcher
      // lists every project it is allowed to show, each exactly once.
      projects: (() => {
        const seen = new Set<string>();
        const rows: { path: string; name: string }[] = [];
        for (const one of [
          ...store.listProjects().map(one => ({ path: one.path, name: one.name })),
          ...managedRepos().map(path => ({ path, name: projectName(path) })),
        ]) {
          if (seen.has(one.path) || !visible(one.path) || goneRepos().has(one.path)) continue;
          seen.add(one.path);
          rows.push(one);
        }
        return rows;
      })(),
      ...(facts === undefined ? {} : { csrf: facts.csrf, returnTo: facts.returnTo }),
      inboxCount: badge.count,
      inboxSaturated: badge.saturated,
      inboxProject,
      inboxLabel: needsYouLabelOf(badge.count, inboxProject === null ? null
        : store.listProjects().find(one => one.path === inboxProject)?.name ?? projectName(inboxProject), badge.saturated),
      settings: true,
      ...(store.isDemo() ? { demo: true } : {}),
      ...(() => { const signIn = signInNotices(store); return signIn.length === 0 ? {} : { signIn }; })(),
      ...(() => {
        // Operators only (only someone at this computer can update it), and gone once this version is dismissed.
        if (!facts?.csrf || !actor || !store.isInstanceOperator(actor)) return {};
        const update = updateFacts();
        if (update === null || !update.newer || update.release === null || facts.updateSeen === update.release.version) return {};
        return { update: { version: update.release.version, security: update.release.security, href: "/settings#updates", dismissHref: "/settings/updates/dismiss" } };
      })(),
      ...(() => {
        const databaseFile = store.databaseFile();
        // Settings → Updates says a `toolroll update` in full; every other page (and the app's update everywhere) names it once.
        if (!actor || databaseFile === null || !store.isInstanceOperator(actor)) return {};
        const waiting = waitingUpdate(databaseFile, run => store.stopQuiescenceProblem(run) !== null, clock());
        return waiting === null || (!waiting.app && facts?.returnTo?.startsWith("/settings/updates")) ? {} : { updateWaiting: { words: waiting.short } };
      })(),
      ...(liveMode === null || liveModeTerms === null
        ? {}
        : {
            modeBanner: {
              name: liveMode.name,
              words: `${liveMode.name} mode until ${liveMode.absoluteExpiry.slice(0, 16).replace("T", " ")} UTC${
                liveModeTerms.autoApproveFiling ? ` — every scope ${liveMode.signedBy} files builds without further ceremony` : ""
              }${liveModeTerms.permissionDefault === "escalated" ? " — FULL permissions by default" : ""}${liveModeTerms.publication === "automerge" ? " — merges fire themselves on green" : ""}`,
            },
          }),
      ...(!restricted() && !unscopedMode && managedRepos().length > 0 ? { chat: true } : {}),
      ...(listPane === undefined ? {} : { listPane }),
      ...(scope === undefined ? {} : { scope }),
    };
  }
  // All project counts are read together. No task artifacts or processes are
  // inspected to paint a badge or a project switcher.
  function projectCounts(now: Date) {
    const facts = requestContext.getStore();
    if (facts?.workCounts !== undefined) return facts.workCounts;
    const counts = workCountsByProject(store, now, workAccess());
    if (facts !== undefined) facts.workCounts = counts;
    return counts;
  }
  function needsYouCount(project: string | null): { count: number; saturated: boolean } {
    const count = projectCounts(clock()).filter(one => project === null || one.repo === project)
      .reduce((sum, one) => sum + one.totals['needs-you'], 0);
    return { count, saturated: false };
  }
  /** A live page's own beat without a docked chat: 10 s while any admitted task is building, else 30 s. */
  function liveRefreshSeconds(): number {
    return projectCounts(clock()).some(one => one.totals.running > 0) ? 10 : 30;
  }

  /** This exact run's review facts for the shared projection (review
   * fixes, finding 4): the store's bounded retry projection plus the live
   * reviewer's own liveness — read per run, so an older selected result
   * never wears a newer run's review. */
  const reviewFactsFor = (runId: number): ReviewFacts | null =>
    reviewFactsOf(store.reviewRetryStateOf(runId), runner => {
      const one = store.getRunner(runner)?.runner;
      return one !== undefined && runnerAlive(one, clock());
    }, buildReviewOf(store, runId)?.state === "pending");


  // ---- the live peek (A2; three review rounds' findings are the spec) ----
  //
  // Names and counts only, never content; nothing durable, ever. The cache
  // holds finished ESCAPED fragments keyed by run:base:epoch — the epoch
  // rotates with every lease AND release, so a stale entry's key can never
  // be asked for again; hits still re-prove the whole guard list.
  const peekCache = new Map<string, { fragment: Html; bytes: number; at: number }>();
  let peekCacheBytes = 0;
  const peekInFlight = new Map<string, Promise<Html>>();
  const peekBySession = new Map<string, number>();
  const PEEK_CACHE_TTL_MS = 10_000;
  const PEEK_CACHE_ENTRIES = 8;
  const PEEK_CACHE_BYTES = 256 * 1024;
  const PEEK_FRAGMENT_BYTES = 32 * 1024;
  const PEEK_GLOBAL_INFLIGHT = 4;
  const PEEK_SESSION_INFLIGHT = 2;

  const peekEvict = () => {
    for (const [key, entry] of peekCache) {
      if (peekCache.size <= PEEK_CACHE_ENTRIES && peekCacheBytes <= PEEK_CACHE_BYTES) break;
      peekCache.delete(key);
      peekCacheBytes -= entry.bytes;
    }
  };

  /** One typed sentence inside the region — plain words, no raw errors.
   * `final` marks conditions that cannot heal for this run (finished,
   * superseded, wrong machine): the region poller reads the marker and
   * stops, instead of refetching a dead build every beat forever. */
  const peekSay = (message: string, final = false): Html =>
    html`<p class="meta"${final ? html` data-region-stop` : ""}>${message}</p>`;

  /** The sanitize pipeline (finding 30/35): normalize → mask → escape. */
  const peekName = (path: string): Html => {
    const normalized = path.replace(/[\u0000-\u001f\u007f]/g, "");
    const masked = scanForSecrets(normalized).length > 0 ? "[redacted: a credential-shaped name]" : normalized;
    return textHtml(masked);
  };

  async function handlePost(
    route: RouteDeclaration,
    url: URL,
    who: Who,
    request: IncomingMessage,
    response: ServerResponse,
    posted: URLSearchParams,
  ): Promise<void> {
    // Every POST passes the shared mutation guard. Caller, scope, project (including a limited account's posted repo)
    // and role were admitted by the route table.
    const denied = authorizeMutation(request, who, readForm(posted, CONSOLE_FORMS.mutationGuard));
    if (denied !== null) return refuse(response, who, denied.status, denied.message);
    // Standing can change after a token was minted: a viewer's act stays refused, cookie and bearer alike, except
    // the row's session-local acts.
    if (who.role === "viewer" && !route.viewer) return refuse(response, who, 403, "your login can watch, not act — ask an approver to upgrade you");
    const now = clock();
    // Any accepted mutation may change what the inbox owes; the badge
    // re-counts within five seconds either way, this just makes it exact.
    bustBadge();
    return dispatchConsole(route, { url, who, request, response, route, now, project: projectOf(who, request) ?? null, chosenProject: projectOf(who, request) ?? null, posted });
  }

  // Only explicitly authorized conversations receive automatic turns. The
  // deterministic scan is idle without new meaningful work; shutdown drains it.
  let leadMaintenance: ReturnType<typeof startMaintenance> | null = null;
  let leadClosing = false;
  server.once('listening', () => {
    team.start();
    leadMaintenance = startMaintenance({ intervalMs: 5_000, shouldStop: () => leadClosing,
      run: () => runLeadFollowPass({ store, repos: managedRepos, evidenceRoot, clock,
        provider: () => { const enabled = chatEnablement(); return enabled.ok ? { config: enabled.config, key: enabled.key } : null; },
        fetcher: chatFetcher, ...(options.subscriptionChatRunner ? { subscriptionRunner: options.subscriptionChatRunner } : {}) }),
      onError: () => { /* Pending delivery is durable and will be read on the next service pass. */ },
    });
  });
  // Keep native process custody until shutdown has verified agent/tool exit.
  // Coding custody does not depend on subagents or the lead's follow pass, so
  // it closes at once and never waits behind a model turn: a stop must release
  // the owner record well inside the service's exit window (Oct 2: deploys
  // over 0.9.11 found it still held by a killed process).
  let codingClosing: Promise<void> | null = null;
  const closeCoding = (): Promise<void> => {
    leadClosing = true;
    return codingClosing ??= Promise.resolve().then(() => coding?.close());
  };
  const bounded = (work: Promise<unknown> | undefined): Promise<void> => new Promise<void>(done => {
    const timer = setTimeout(done, SHUTDOWN_WAIT_MS);
    void Promise.resolve(work).catch(() => {}).finally(() => { clearTimeout(timer); done(); });
  });
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    leadClosing = true;
    try { requestBudget.flush(); } catch { /* saved again on the close event when it can be */ }
    flowRooms.close();
    taskRooms.close();
    liveHandlers.close();
    detachReads();
    liveFollower.close();
    void Promise.all([closeCoding(), bounded(team.close()), bounded(leadMaintenance?.stop()), bounded(reads?.close())]).then(() => closeServer(callback)).catch(error => {
      if (callback) callback(error instanceof Error ? error : Error('Coding session shutdown failed.'));
      else server.emit('error', error);
    });
    return server;
  }) as Server['close'];

  const handlerRuntime: ServerRuntime = {
    get codingActorAllowed(): ServerRuntime['codingActorAllowed'] { return codingActorAllowed; },
    get coding(): ServerRuntime['coding'] { return coding; },
    set coding(value) { coding = value; },
    get codingProjectAllowed(): ServerRuntime['codingProjectAllowed'] { return codingProjectAllowed; },
    get store(): ServerRuntime['store'] { return store; },
    get sendScreen(): ServerRuntime['sendScreen'] { return sendScreen; },
    get chromeFor(): ServerRuntime['chromeFor'] { return chromeFor; },
    get visible(): ServerRuntime['visible'] { return visible; },
    get managedRepos(): ServerRuntime['managedRepos'] { return managedRepos; },
    get codingProblem(): ServerRuntime['codingProblem'] { return codingProblem; },
    set codingProblem(value) { codingProblem = value; },
    get unscopedMode(): ServerRuntime['unscopedMode'] { return unscopedMode; },
    get admissionList(): ServerRuntime['admissionList'] { return admissionList; },
    get routeViewOf(): ServerRuntime['routeViewOf'] { return routeViewOf; },
    get workAccess(): ServerRuntime['workAccess'] { return workAccess; },
    get evidenceRoot(): ServerRuntime['evidenceRoot'] { return evidenceRoot; },
    get firstRunStepsNow(): ServerRuntime['firstRunStepsNow'] { return firstRunStepsNow; },
    get restricted(): ServerRuntime['restricted'] { return restricted; },
    get revisionDocOf(): ServerRuntime['revisionDocOf'] { return revisionDocOf; },
    get familyOf(): ServerRuntime['familyOf'] { return familyOf; },
    get failureOf(): ServerRuntime['failureOf'] { return failureOf; },
    get dockedConversation(): ServerRuntime['dockedConversation'] { return dockedConversation; },
    get planViewOf(): ServerRuntime['planViewOf'] { return planViewOf; },
    get mintApprovalNonce(): ServerRuntime['mintApprovalNonce'] { return mintApprovalNonce; },
    get planContractViewOf(): ServerRuntime['planContractViewOf'] { return planContractViewOf; },
    get familiesInView(): ServerRuntime['familiesInView'] { return familiesInView; },
    get runIsTaskResult(): ServerRuntime['runIsTaskResult'] { return runIsTaskResult; },
    get explainAttempt(): ServerRuntime['explainAttempt'] { return explainAttempt; },
    get taskChatFocus(): ServerRuntime['taskChatFocus'] { return taskChatFocus; },
    get familyTasksInView(): ServerRuntime['familyTasksInView'] { return familyTasksInView; },
    get clock(): ServerRuntime['clock'] { return clock; },
    get taskRooms(): ServerRuntime['taskRooms'] { return taskRooms; },
    get identify(): ServerRuntime['identify'] { return identify; },
    get liveCeiling(): ServerRuntime['liveCeiling'] { return liveCeiling; },
    get taskScreen(): ServerRuntime['taskScreen'] { return taskScreen; },
    get runVisible(): ServerRuntime['runVisible'] { return runVisible; },
    get runIsLive(): ServerRuntime['runIsLive'] { return runIsLive; },
    get options(): ServerRuntime['options'] { return options; },
    get reviewFactsFor(): ServerRuntime['reviewFactsFor'] { return reviewFactsFor; },
    get resultDetailOf(): ServerRuntime['resultDetailOf'] { return resultDetailOf; },
    get taskRepoOf(): ServerRuntime['taskRepoOf'] { return taskRepoOf; },
    get ceiling(): ServerRuntime['ceiling'] { return ceiling; },
    get taskViewData(): ServerRuntime['taskViewData'] { return taskViewData; },
    get consoleProjects(): ServerRuntime['consoleProjects'] { return consoleProjects; },
    get flowRooms(): ServerRuntime['flowRooms'] { return flowRooms; },
    get providerHome(): ServerRuntime['providerHome'] { return providerHome; },
    get toolHome(): ServerRuntime['toolHome'] { return toolHome; },
    get leadPrincipal(): ServerRuntime['leadPrincipal'] { return leadPrincipal; },
    get chatScopeOf(): ServerRuntime['chatScopeOf'] { return chatScopeOf; },
    get liveTurns(): ServerRuntime['liveTurns'] { return liveTurns; },
    get liveTurnStarted(): ServerRuntime['liveTurnStarted'] { return liveTurnStarted; },
    get leadConversationRows(): ServerRuntime['leadConversationRows'] { return leadConversationRows; },
    get demoLeadHere(): ServerRuntime['demoLeadHere'] { return demoLeadHere; },
    get teamBrowserReply(): ServerRuntime['teamBrowserReply'] { return teamBrowserReply; },
    get team(): ServerRuntime['team'] { return team; },
    get teamChatProvider(): ServerRuntime['teamChatProvider'] { return teamChatProvider; },
    get pullRequestTargetOf(): ServerRuntime['pullRequestTargetOf'] { return pullRequestTargetOf; },
    get chatEnablement(): ServerRuntime['chatEnablement'] { return chatEnablement; },
    get startLeadConversation(): ServerRuntime['startLeadConversation'] { return startLeadConversation; },
    get projectFamilyPeek(): ServerRuntime['projectFamilyPeek'] { return projectFamilyPeek; },
    get needsYouBadge(): ServerRuntime['needsYouBadge'] { return needsYouBadge; },
    get liveRefreshSeconds(): ServerRuntime['liveRefreshSeconds'] { return liveRefreshSeconds; },
    get chatKeyFor(): ServerRuntime['chatKeyFor'] { return chatKeyFor; },
    get chatCatalog(): ServerRuntime['chatCatalog'] { return chatCatalog; },
    get leadRecheckedAt(): ServerRuntime['leadRecheckedAt'] { return leadRecheckedAt; },
    set leadRecheckedAt(value) { leadRecheckedAt = value; },
    get checkLocalAgents(): ServerRuntime['checkLocalAgents'] { return checkLocalAgents; },
    get localSignIn(): ServerRuntime['localSignIn'] { return localSignIn; },
    set localSignIn(value) { localSignIn = value; },
    get agentSignInCommand(): ServerRuntime['agentSignInCommand'] { return agentSignInCommand; },
    get connectionCheck(): ServerRuntime['connectionCheck'] { return connectionCheck; },
    get modelCatalog(): ServerRuntime['modelCatalog'] { return modelCatalog; },
    get modelSeams(): ServerRuntime['modelSeams'] { return modelSeams; },
    get toolsViewOf(): ServerRuntime['toolsViewOf'] { return toolsViewOf; },
    get codexServers(): ServerRuntime['codexServers'] { return codexServers; },
    get projectViewOf(): ServerRuntime['projectViewOf'] { return projectViewOf; },
    get sessions(): ServerRuntime['sessions'] { return sessions; },
    get integrations(): ServerRuntime['integrations'] { return integrations; },
    get consoleOrigin(): ServerRuntime['consoleOrigin'] { return consoleOrigin; },
    get storagePool(): ServerRuntime['storagePool'] { return storagePool; },
    get ssoSettings(): ServerRuntime['ssoSettings'] { return ssoSettings; },
    get leadWords(): ServerRuntime['leadWords'] { return leadWords; },
    get settingsUpdates(): ServerRuntime['settingsUpdates'] { return settingsUpdates; },
    get phoneSetup(): ServerRuntime['phoneSetup'] { return phoneSetup; },
    get authenticateApprover(): ServerRuntime['authenticateApprover'] { return authenticateApprover; },
    get projectOf(): ServerRuntime['projectOf'] { return projectOf; },
    get bustBadge(): ServerRuntime['bustBadge'] { return bustBadge; },
    get revisionDestination(): ServerRuntime['revisionDestination'] { return revisionDestination; },
    get deletedRepos(): ServerRuntime['deletedRepos'] { return deletedRepos; },
    get lookupSession(): ServerRuntime['lookupSession'] { return lookupSession; },
    get authorizeMutation(): ServerRuntime['authorizeMutation'] { return authorizeMutation; },
    get leadSaid(): ServerRuntime['leadSaid'] { return leadSaid; },
    get armTaskResume(): ServerRuntime['armTaskResume'] { return armTaskResume; },
    get chatFetcher(): ServerRuntime['chatFetcher'] { return chatFetcher; },
    get chatCeilingDigest(): ServerRuntime['chatCeilingDigest'] { return chatCeilingDigest; },
    get consumeApprovalNonce(): ServerRuntime['consumeApprovalNonce'] { return consumeApprovalNonce; },
    get recordSignIn(): ServerRuntime['recordSignIn'] { return recordSignIn; },
    get ssoProvider(): ServerRuntime['ssoProvider'] { return ssoProvider; },
    set ssoProvider(value) { ssoProvider = value; },
    get providerFor(): ServerRuntime['providerFor'] { return providerFor; },
    get connectVisits(): ServerRuntime['connectVisits'] { return connectVisits; },
    get defaultProject(): ServerRuntime['defaultProject'] { return defaultProject; },
    get googleVisits(): ServerRuntime['googleVisits'] { return googleVisits; },
    get setupAttemptsLeft(): ServerRuntime['setupAttemptsLeft'] { return setupAttemptsLeft; },
    set setupAttemptsLeft(value) { setupAttemptsLeft = value; },
    get ssoOffer(): ServerRuntime['ssoOffer'] { return ssoOffer; },
    get signInLinks(): ServerRuntime['signInLinks'] { return signInLinks; },
    get linkKey(): ServerRuntime['linkKey'] { return linkKey; },
    get fromThisComputer(): ServerRuntime['fromThisComputer'] { return fromThisComputer; },
    get passwordAllowed(): ServerRuntime['passwordAllowed'] { return passwordAllowed; },
    get arrival(): ServerRuntime['arrival'] { return arrival; },
    get cookieSecure(): ServerRuntime['cookieSecure'] { return cookieSecure; },
    get ssoVisits(): ServerRuntime['ssoVisits'] { return ssoVisits; },
    get ssoHandoffs(): ServerRuntime['ssoHandoffs'] { return ssoHandoffs; },
    get joinSourceOf(): ServerRuntime['joinSourceOf'] { return joinSourceOf; },
    get signInBudget(): ServerRuntime['signInBudget'] { return signInBudget; },
    get signInActor(): ServerRuntime['signInActor'] { return signInActor; },
    get minutesWords(): ServerRuntime['minutesWords'] { return minutesWords; },
    get joinGlobal(): ServerRuntime['joinGlobal'] { return joinGlobal; },
    set joinGlobal(value) { joinGlobal = value; },
    get joinBySource(): ServerRuntime['joinBySource'] { return joinBySource; },
    get catalogCache(): ServerRuntime['catalogCache'] { return catalogCache; },
    set catalogCache(value) { catalogCache = value; },
    get CHAT_CANDIDATE_TTL_MS(): ServerRuntime['CHAT_CANDIDATE_TTL_MS'] { return CHAT_CANDIDATE_TTL_MS; },
    get CHAT_CANDIDATES_PER_APPROVER(): ServerRuntime['CHAT_CANDIDATES_PER_APPROVER'] { return CHAT_CANDIDATES_PER_APPROVER; },
    get peekSay(): ServerRuntime['peekSay'] { return peekSay; },
    get peekCache(): ServerRuntime['peekCache'] { return peekCache; },
    get PEEK_CACHE_TTL_MS(): ServerRuntime['PEEK_CACHE_TTL_MS'] { return PEEK_CACHE_TTL_MS; },
    get peekCacheBytes(): ServerRuntime['peekCacheBytes'] { return peekCacheBytes; },
    set peekCacheBytes(value) { peekCacheBytes = value; },
    get peekInFlight(): ServerRuntime['peekInFlight'] { return peekInFlight; },
    get PEEK_GLOBAL_INFLIGHT(): ServerRuntime['PEEK_GLOBAL_INFLIGHT'] { return PEEK_GLOBAL_INFLIGHT; },
    get peekBySession(): ServerRuntime['peekBySession'] { return peekBySession; },
    get PEEK_SESSION_INFLIGHT(): ServerRuntime['PEEK_SESSION_INFLIGHT'] { return PEEK_SESSION_INFLIGHT; },
    get peekName(): ServerRuntime['peekName'] { return peekName; },
    get PEEK_FRAGMENT_BYTES(): ServerRuntime['PEEK_FRAGMENT_BYTES'] { return PEEK_FRAGMENT_BYTES; },
    get peekEvict(): ServerRuntime['peekEvict'] { return peekEvict; },
    get allowedHost(): ServerRuntime['allowedHost'] { return allowedHost; },
    get revisionViewOf(): ServerRuntime['revisionViewOf'] { return revisionViewOf; },
    get revisionLedgerOf(): ServerRuntime['revisionLedgerOf'] { return revisionLedgerOf; },
    get firstTasks(): ServerRuntime['firstTasks'] { return firstTasks; },
  };
  const tasksHandlers = createTasksHandlers(handlerRuntime);
  const pagesHandlers = createPagesHandlers(handlerRuntime);
  const flowsHandlers = createFlowsHandlers(handlerRuntime);
  const chatHandlers = createChatHandlers(handlerRuntime);
  const settingsHandlers = createSettingsHandlers(handlerRuntime);
  const peopleHandlers = createPeopleHandlers(handlerRuntime);

  const remoteRuntime: RemoteRuntime = {
    get identify() { return identify; },
    get store() { return store; },
    get admitPasswordSource() { return admitPasswordSource; },
    get admitBearer() { return admitBearer; },
    get allowedHost() { return allowedHost; },
    get team() { return team; },
    get teamBrowserReply() { return teamBrowserReply; },
    get requestBudget() { return requestBudget; },
    get options() { return options; },
    get coding() { return coding; },
    get codingProjects() { return codingProjects; },
    get liveCeiling() { return liveCeiling; },
    get clock() { return clock; },
    get evidenceRoot() { return evidenceRoot; },
    get consoleOrigin() { return consoleOrigin; },
    get managedRepos() { return managedRepos; },
    get joinSourceOf() { return joinSourceOf; },
    get ssoSettings() { return ssoSettings; },
    get SSO_FRESH_MS() { return SSO_FRESH_MS; },
    get oauthTokenBudget() { return oauthTokenBudget; },
    get hookContext() { return hookContext; },
    get teamsSourceBudget() { return teamsSourceBudget; },
    get teamsTenantBudget() { return teamsTenantBudget; },
  };
  const liveHandlers = createLiveHandlers(handlerRuntime, { bus: liveBus, workspaceRevision, chatProjectOf: chatHandlers.chatProjectOf });
  liveTurnStarted = liveHandlers.turnStarted;
  const remoteHandlers = createRemoteHandlers(remoteRuntime);
  const registry = createHandlerRegistry([
    ...tasksHandlers.registrations, ...flowsHandlers.registrations, ...chatHandlers.registrations,
    ...settingsHandlers.registrations, ...peopleHandlers.registrations, ...pagesHandlers.registrations,
    ...remoteHandlers.registrations, ...liveHandlers.registrations,
  ]);
  /** The row's role, after admission and before its one handler. */
  function dispatchConsole(route: RouteDeclaration, ctx: HandlerContext): Promise<void> {
    const { who, response } = ctx;
    const held = route.role === "any" || ((!route.roleBrowser || who.via === "cookie") &&
      (route.role === "approver" ? who.role === "approver" : store.isInstanceOperator(who.name)));
    if (!held) {
      ctx.request.resume();
      const refusal = route.roleRefusal!;
      return Promise.resolve("message" in refusal ? refuse(response, who, 403, refusal.message, refusal.back) : respond(response, refusal.status, refusal.type, refusal.body));
    }
    return registry.console(route, ctx);
  }
  async function dispatchEdge(route: RouteDeclaration, ctx: Omit<import('./server/handler-context.js').EdgeContext, 'route'>): Promise<void> {
    if (route.callers.length === 1 && route.callers[0] === 'cookie' && ctx.request.headers.authorization !== undefined) {
      return respond(ctx.response, 403, 'text/plain; charset=utf-8', 'This address needs a browser sign-in.');
    }
    if (route.proof === 'public') {
      const policy = evaluateRoutePolicy(route, { caller: 'anonymous', capability: 'none' }, source => source === 'none');
      if (!policy.ok) return respond(ctx.response, policy.status, 'text/plain; charset=utf-8', 'This address needs a browser sign-in.');
    }
    return withEdgePolicy(route, () => registry.edge(route, { ...ctx, route }));
  }

  return Object.assign(server, { mintSignInLink, closeCoding });
}

export { PAGE_CSS,pinnedTheme,SENSITIVE_INPUT } from "./server/chrome.js";
export { redactedPath,SHUTDOWN_WAIT_MS,type ServeOptions } from "./server/http.js";
export { TASK_COMPOSER_MODES,type TaskComposerMode } from "./server/render-chat.js";
export { inboxFingerprints,parseInboxTab,queueScript,type InboxTab } from "./server/render-pages.js";
export { ssoStepUps,wrongHostPage } from "./server/render-people.js";
export { diffFileAnchor,editorFileHref,needActionOf,orderChangedFiles,plainConclusionOf,rankReviewQueue,reviewFilePriority,reviewPriorityOf,runFactsFragment,withinSignedTouches,type ReviewFileRow,type ReviewPriority,type ReviewQueueFacts } from "./server/render-results.js";
export { settingsGroups,settingsTiles } from "./server/render-settings.js";
export { decisionAnswerScript,earlierVersionsWords,revisionLineageWords,type RouteView } from "./server/render-tasks.js";
export { SIGN_IN_LINK_MS,SIGN_IN_LINK_PATH,type DecisionServer } from "./server/session.js";
