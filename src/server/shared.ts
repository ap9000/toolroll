/** Shared console rendering, types and request guards, moved from serve.ts. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash,randomBytes,timingSafeEqual } from "node:crypto";
import { closeSync,constants as fsConstants,lstatSync,openSync,readSync } from "node:fs";
import { type IncomingMessage,type Server,type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACCENT_PRESETS,accentStyle,DEFAULT_ACCENT } from "../accent-colors.js";
import type { RunActivity } from "../activity-line.js";
import { type AgentChoice } from "../agentconfig.js";
import { gateWords } from "../approval-policy.js";
import { APPROVAL_RULES_CSS } from "../approval-rules-ui.js";
import { assignmentPresentationOf,historicalAssessmentReason,shortenedMaterialReason } from '../assignment-presentation.js';
import { ASSIGNMENT_CSS,assignmentActionHref,assignmentCardOf,assignmentStatusOf,assignmentSummaryHtml,assignmentWithEvidence,type AssignmentCard } from '../assignment-ui.js';
import { owedAcceptance,type AssignmentSnapshot } from '../assignment.js';
import { BACKUP_CSS } from "../backup-ui.js";
import type { BoardCard } from "../board.js";
import { holdOwnerWords } from "../board.js";
import type { BrandIconId } from "../brand-icons.js";
import { BRAND_MARK_CSS,brandIconHtml } from "../brand-mark.js";
import { browserWorkActionHref,type BrowserActionCard,type BrowserCheckItem,type BrowserLimits,type BrowserNeedAction,type BrowserPhoneCard,type BrowserProjectRow,type BrowserProjectsView,type BrowserResultPanel,type BrowserResultView,type BrowserSettingsGroup,type BrowserSettingsView,type BrowserSignIn,type BrowserTaskDetailGroup,type BrowserTaskFact,type BrowserTaskSection,type BrowserTasksView,type BrowserTaskThreadItem,type BrowserTaskView,type BrowserUpdateNotice,type BrowserUpdates,type BrowserWorkspace } from '../browser-workspace.js';
import { CHAT_ACTIONS,sharedActionNeedsReview,sharedActionPayload,sharedActionReviewPath } from '../chat-actions.js';
import { CHAT_CONTINUITY_SCRIPT } from "../chat-continuity.js";
import { CHAT_CONTROLS,chatControlHref,isChatControl,chatResultHref as sharedResultHref } from "../chat-controls.js";
import { permissionPlainWords } from "../chat-decide.js";
import { CHAT_POLISH_CSS,chatActivityDetailsHtml,chatWorkingHtml,completedWorkHtml } from "../chat-polish.js";
import { CHAT_TASK_ACTIONS,isChatTaskAction } from "../chat-task-actions.js";
import { CHECK_SETTINGS_CSS } from '../check-levels-ui.js';
import { CHECK_LEVEL_WORDS,isCheckLevel,liveQuickCommand,type CheckLevel } from '../check-levels.js';
import { type CliHttpOptions,type RunOperateAs } from '../cli-http.js';
import { CODING_SHIPPING_CSS } from '../coding-shipping-ui.js';
import { CODING_CSS } from '../coding-ui.js';
import { CodingWorkspace } from '../coding-workspace.js';
import { type FormView } from "../contracts/console-api.js";
import { connectionWords,hiddenFields } from "../control-ui.js";
import {
isSubscriptionChatProvider,
PRICED_MODELS,
type ChatDraft
} from "../converse.js";
import { CREDENTIALS_CSS } from "../credentials-ui.js";
import { hasForbiddenControls,LIMITS } from "../decision.js";
import { digestTimes } from "../digest-times.js";
import { DISCLOSURE_CSS } from "../disclosure.js";
import { type DispatchDiagnosis } from "../dispatch.js";
import { EVIDENCE_PACK_CSS } from "../evidence-pack.js";
import { readVerifiedArtifact,readVerifiedProofForRun,reportShotsOf,type ReportShot,type ReportView } from "../evidence.js";
import { run as execRun } from "../exec.js";
import { EXPORT_CSS } from "../export-ui.js";
import { firstTaskJourney,START_COMMAND,type FirstRunStep } from "../first-run.js";
import { type MailSender } from "../flow-actions.js";
import { FLOW_HREF } from "../flow-engine.js";
import { GALLERY_CSS } from "../flow-gallery-ui.js";
import { type FetchLike } from "../flow-share.js";
import { STARTERS_CSS } from "../flow-starters-ui.js";
import { starterForWork } from "../flow-starters.js";
import { type TriggerIo } from "../flow-triggers.js";
import { FLOWS_CSS } from "../flows-ui.js";
import { describeCapability,type Gap } from "../gaps.js";
import { type InstallMethod } from "../install-method.js";
import { INTEGRATIONS_CSS } from "../integrations-ui.js";
import { type IntegrationIo } from "../integrations.js";
import { readAuthModeStrict } from "../keys.js";
import { KITS_CSS } from "../kits-ui.js";
import { KNOWLEDGE_CSS } from "../knowledge-ui.js";
import { ABOUT_YOU_LINE_MAX,ABOUT_YOU_MAX_LINES } from "../lead-about.js";
import { LEAD_CONTEXT_CSS } from '../lead-context.js';
import { LEAD_NAME_MAX,LEAD_PERSONA_MAX,type LeadIdentity } from "../lead-identity.js";
import { LIMITS_CSS,limitsHtml } from "../limits-ui.js";
import { PROPOSAL_WAIT_REASON,proposalActGate } from "../lead-doors.js";
import type { LeadLiveStep } from "../lead-progress.js";
import { LEAD_MESSAGE_MAX_CHARS } from "../lead.js";
import { MOBILE_VIEWPORT_SCRIPT } from "../mobile-viewport.js";
import { type VersionRunner } from "../model-catalog.js";
import { MODELS_CSS } from "../models-ui.js";
import { MONITORING_CSS } from "../monitoring-ui.js";
import { ASK_LABEL,ASKS,failedAttemptSentence,isInternalErrorReason,NEEDS,retryNoteOf,runReasonWords,type Ask,type FailureExplanation } from '../needs-you.js';
import { cloneGithubRepo,listGithubRepos,previewGithubRepo,type ListOutcome } from "../onboard.js";
import { type Principal } from "../operate-remote.js";
import { parseBaseTreeSnapshot } from "../peek.js";
import { PEOPLE_AUDIT_CSS } from "../people-audit-ui.js";
import { agentsSummary,chosenWords,makesNoPlan,postureWords,projectRoute,PHASES as ROUTE_PHASES,TASK_SIZES,type PhaseRoute,type RouteOverride,type RouteProjection,type RouteStamp } from "../phase-routing.js";
import { parseExecutionPlanDocument,type MilestoneState } from "../plan.js";
import { type ContractChange } from "../planner-source.js";
import { POLICY_CSS } from "../policy-ui.js";
import { PROJECT_DELETE_CSS } from "../project-delete-ui.js";
import {
projectName
} from "../project.js";
import { coverageStateWords,coverageWords,dispatchStatusToken,GOAL_ASSESSMENT_PENDING,manualReviewCriterionOf,manualReviewOnly,passFraction,personCheckWords,plainReasonWords,reviewConflict,semanticCoverage,type CriterionEvidenceRef,type CriterionMatrixRow,type ProofVerdict } from "../proof.js";
import { providerName } from "../provider-auth.js";
import { type ProviderConnection } from "../provider-connection.js";
import { type Phase,type ProviderId } from "../provider.js";
import type { PublishExec } from '../publish.js';
import { type PullRequestView } from '../pull-request-flow.js';
import { PULL_REQUEST_SETTINGS_CSS } from '../pull-request-ui.js';
import { qualityModeTitle,type QualityMode } from "../quality.js";
import { RECIPE_CSS } from "../recipe-ui.js";
import { latestVersionNow } from "../releases.js";
import { replyHtmlInline,shapeReply } from "../reply-shape.js";
import { REQUEST_LIMITS_CSS } from "../request-budget-ui.js";
import { acceptWithChecksOf,resultActsOf,type ResultActFacts } from "../result-acts.js";
import { SCREENSHOT_CAPTURE,structuredHandoffView,terminalDiffView,type StructuredHandoffView,type TerminalDiffView } from "../result-evidence-readers.js";
import { ADD_TESTS_ACTION,followUpChecksOf,type FollowUpCheck } from '../result-follow-ups.js';
import {
evidenceHealthOf,
evidenceProblemDetailsOf,
evidenceResultStatusOf,evidenceShortenedWords,
isRevisionFeedback,
RESULT_REVIEW_SCRIPT,
RESULT_TABS,
resultFactsAttributeMap,
resultFactsAttributes,
resultLeadOf,
revisionBatchOf,
revisionSourceOf,
type ResultScreenshot,
type ResultTab,
type SharedResultFacts
} from "../result-review.js";
import { RESULT_SHOT_CHOICES } from "../result-shots.js";
import { RETENTION_CSS } from "../retention-ui.js";
import { findingWords,type BuildReviewView } from "../review-switch.js";
import { describeSchedule,parseSchedule } from "../flow-schedule.js";
import type { Runner } from "../runner.js";
import { isAlive as runnerAlive } from "../runner.js";
import {
acceptanceToLines,
approvalOf,
scopeAuthorityOf,
type AcceptanceCriterion,
type Scope,
type UnattendedPermissionMode
} from "../scope.js";
import { parseReport,type ReportItem } from "../scout-report.js";
import { ASSISTANTS } from "../setup-guide.js";
import { SKILLS_CSS } from "../skills-ui.js";
import { SPEND_CSS } from "../spend-ui.js";
import { SSO_CSS } from "../sso-ui.js";
import { STORAGE_CSS } from "../storage-ui.js";
import type { ChatConfig,ChatProviderId,ChatSnapshot,ChatTurn,CoordinatorProposal,DirectChatProviderId,LeadMessage,LeadProposal,LeadSession,LeadTurn,PlanRevisionKind,PlanRevisionStatus,PublicationGrant,PushSubscription,RepairChainRow,ReviewRetryState,RevisionLineage,SteerNote,SubscriptionChatProviderId,TaskFamily } from "../store.js";
import {
LEAD_ASK_OTHER,
type Artifact,
type Capability,
type CheckProgress,
type Decision,
type DiffComment,
type ExternalMirror,
type Hold,
type Incident,
type LeadAsk,
type Publication,
type ResultScreenshots,
type Run,
type Store,
type Task,
type TaskState,
type WorktreeRow,
} from "../store.js";
import { styleAsset } from "../style-asset.js";
import type { SubscriptionLeadRunner } from "../subscription-chat.js";
import { runCostWords,spendLine,tally } from "../summary.js";
import { scheduleEditorHtml,scheduleEditorScript } from "../task-composer.js";
import { type TaskControlView } from "../task-control.js";
import { assignmentStageOf,demoChecksOf,pullRequestFactOf,requirementsOf,requirementWordOf,stageOfCode,stageOfDispatch,STATUS_MORE,statusDetailsHtml,statusIconSvg,statusWhyHtml,TASK_STATUS_CSS,taskStatusOf,type PullRequestFact,type TaskStatus } from '../task-status.js';
import type { TeamChatProviderResolver } from '../team-chat-authorization.js';
import type { TeamSnapshot } from '../team-contract.js';
import { SUBAGENT_CSS } from "../subagents-ui.js";
import { redactToken,TOKEN_ENV,type TokenSource } from "../telegram.js";
import { TEMPLATES } from "../templates.js";
import { UPDATES_CSS } from "../toolroll-update-ui.js";
import { launchRuntimeUpdate } from "../toolroll-update.js";
import { TOOLS_CSS } from "../tools-ui.js";
import { TRANSITIONS_CSS } from "../transitions-recipes.js";
import { updateNoticeWords } from "../update-notice.js";
import { whenHtml } from "../when-html.js";
import { workCountsByProject,type WorkIndexGroup,type WorkIndexItem,type WorkIndexPage } from "../work-index.js";
import { WORKSPACE_MOTION_CSS } from "../workspace-motion.js";
import {
ACCEPT_NEEDS_REASON,
acceptWordsOf,buildProgressOf,cantAcceptYetOf,
dispatchActionLabel,
earlierAttemptsWords,evidenceProblemOf,
MISMATCH_HEADLINE,
primaryDestinationOf,
receiptHeadingOf,receiptPublicationWords,
reportMismatchesOf,
RESULT_DECISION_SENTENCE,
resultHeadlineOf,
resultStatusOf,
REVIEW_TOKENS,
WORK_VIEWS,
workStatusOf,
type DisplayStatus,type PublicationFacts,type ReviewFacts,
type WorkFacts,type WorkStatus,
type WorkView
} from "../workspace-ui.js";


/** A user agent, reduced to safe display words — never echoed raw. */
export function oneLineUa(raw: string | string[] | undefined): string {
  const text = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  if (/iphone|ipad/i.test(text)) return "an iPhone or iPad";
  if (/android/i.test(text)) return "an Android device";
  if (/mac os/i.test(text)) return "a Mac";
  if (/windows/i.test(text)) return "a Windows machine";
  return "a device";
}

export type ServeOptions = {
  /** Tests: runs a person's command for the HTTP MCP gateway instead of operate.ts's. */
  runOperateAs?: import("../mcp-person.js").RunOperateAs;
  /** `toolroll demo`: the scripted lead that answers Chat instead of a model. */
  demoLead?: import("../demo.js").DemoLead;
  /** Tests: the bin whose real path says how Toolroll was installed (Settings → Updates' command). */
  installBin?: string;
  /** Native coding workspace injection for isolated integration tests. */
  codingWorkspace?: CodingWorkspace;
  /** Read-only worker connections for heavy reads (read-executor.ts); 0 reads in-process. Default: off under tests. */
  readWorkers?: number;
  store: Store;
  evidenceRoot: string;
  clock?: () => Date;
  /**
   * The console's canonical https origin, when TLS terminates in front
   * (arc 3 finding 2/16): EXACTLY an origin — no path, query, credentials.
   * The one trust anchor for secure-context features: it joins the allowed
   * hosts, its origin authorizes POSTs, cookies turn Secure, and the
   * install/push cards light up. X-Forwarded-* is consulted only from a
   * loopback peer, the same-host proxy (public-access.ts).
   */
  publicUrl?: string;
  /** Tests: the shared command boundary `POST /api/cli` runs (default: operate.ts's runOperateAs). */
  cliRunner?: RunOperateAs;
  /** Tests: remote command metadata until the shared contract declares it. */
  cliModeOf?: CliHttpOptions['modeOf'];
  /** Tests: the clock request budgets for API tokens count by (request-budget.ts). */
  requestBudgetClock?: () => number;
  /** Where repos.json lives — every enrollment locks exactly this file. */
  registryPath?: string;
  /** This console fronts an `up` process: onboarding copy says how to watch. */
  upConsole?: boolean;
  /**
   * The lead on by default (onboarding): with no lead set up, the agent CLI
   * signed in on this computer runs it, once. `up` and `serve` turn this on;
   * tests opt in.
   */
  leadByDefault?: boolean;
  /** Test seam: the operating system the sign-in command is written for. */
  platform?: NodeJS.Platform;
  /** Extra Host values this server answers as (a Tailscale name, a LAN ip:port). */
  allowedHosts?: readonly string[];
  /**
   * This computer's names on its tailnet (onboarding): read at start and every
   * few minutes; the console answers to each on its own port without an
   * --allow-host, and the phone card names the address. Absent = none.
   */
  tailnetNames?: () => Promise<readonly string[]>;
  /**
   * The first-account road (setup review): while NO approver exists, the
   * login page offers "create the first account", gated by this code —
   * printed once by the process that started the server, never stored.
   * Five wrong codes close the road until the server restarts. The moment
   * an approver exists, the page is the ordinary sign-in.
   */
  setupCode?: string;
  /**
   * Where the Telegram bot token lives when set from here. Present = the
   * settings card renders; absent = no settings surface at all.
   */
  telegramTokenFile?: string;
  /** Where messaging config files live (beside the database) — enables the
   * primary-messenger selector on the settings screen. */
  configDir?: string;
  /** Test seam for the Slack setup handshake. */
  slackFetcher?: typeof fetch;
  /** Settings → Updates seams: the latest release, how this Toolroll was
   * installed, its version, and how the updater job starts. Tests and
   * screenshots inject these; production reads the registry and launchd. */
  updates?: { latest?: () => Promise<{ version: string }>; method?: InstallMethod; current?: string; dist?: string; launch?: typeof launchRuntimeUpdate };
  discordFetcher?: typeof fetch;
  /** Injected by tests: Microsoft sign-in, key metadata and Teams conversation calls. */
  teamsFetcher?: typeof fetch;
  /** Injected by tests: how "Check now" reaches GitHub (gh) and Linear (fetch). */
  flowTriggerIo?: Partial<TriggerIo>;
  /**
   * The repo this console serves. Scopes run evidence to that repo's tasks
   * (and unplaced ones) and turns on the gaps and capabilities views —
   * without it those pages say so instead of guessing.
   */
  repo?: string;
  /**
   * The full authorization ceiling (v2 review, finding 1): `repos` this
   * server may show and operate on, plus `projectRoots` under which any git
   * repository qualifies. `repo` above is sugar for one entry in `repos`.
   * No configuration at all is the legacy unscoped mode — everything
   * visible, and stated as such where the code decides.
   */
  repos?: readonly string[];
  projectRoots?: readonly string[];
  /** Repositories the co-located `up` process has proved and is watching.
   * Kept as a callback so projects added after startup appear immediately
   * without turning the durable registry itself into an authorization source. */
  currentRepos?: () => readonly string[];
  /** Injected by tests: the fetch direct-API chat turns use, and where chat
   * keys are read from (defaults to process.env). */
  chatFetcher?: typeof fetch;
  /** Subscription-backed mate transport; injected in tests so no real
   * Codex or Claude membership turn is consumed. */
  subscriptionChatRunner?: SubscriptionLeadRunner;
  /** Tests: stands in for `codex mcp list --json` in the project (the Tools page's "Found on this computer"). */
  codexToolList?: (cwd: string) => Promise<string | null>;
  /** Tests: the home whose ~/.toolroll (or older ~/.standing-orders) tool-secrets and ~/.claude.json the Tools page uses. */
  toolHome?: string;
  /** v87: sends Send email steps' mail and the settings test (tests inject one). */
  mailSender?: MailSender;
  /** Injected by tests: how Flows → Import fetches a flow file's address. */
  flowFetch?: FetchLike;
  /** v89: Google's token endpoint (tests inject a scripted one). */
  googleFetch?: typeof fetch;
  /** Tests: every request a one-click connection makes (discovery, registration, tokens). */
  connectFetch?: typeof fetch;
  /** Tests: every request sign-in with the identity provider makes (discovery, keys, tokens). */
  ssoFetch?: typeof fetch;
  chatEnv?: Record<string, string | undefined>;
  /**
   * The live peek's locality ASSERTION (live-peek v3 §3): the administrator
   * who starts serve names the runner this machine owns. This is documented
   * as an assertion, not machine-bound credential enforcement — the product
   * has none anywhere. Absent = the peek is off, and says so.
   */
  desktopIdentity?: string;
  /** Trusted native admission callback; enrollment rows alone never supply this authority. */
  additionalProjectRepos?: () => readonly string[];
  /** The co-located `up`'s exact admitted repositories, read on every request: its startup projects plus those
   * added since (`repos add`, the lead, the console) and minus those removed. When given it replaces `repos` as
   * the exact part of the ceiling, so an addition or removal shows without a restart. */
  admittedRepos?: () => readonly string[];
  connectionProbe?: typeof execRun;
  connectionHome?: string;
  /** Test seam for Chat's first tasks: the `gh` and `git grep` reads. */
  firstTaskRunner?: typeof execRun;
  /** Test seam for Settings → Integrations: how its checks reach services (fetch, gh, mail servers). */
  integrationIo?: Partial<IntegrationIo>;
  modelCatalogFetcher?: typeof fetch;
  /** Test seams for Settings → Models: CLI version probes and the PATH they search. */
  modelRunner?: VersionRunner;
  modelPath?: string;
  localRunner?: string;
  /** The checkout pool root the peek confines itself to (realpath-proved). */
  poolRoot?: string;
  /**
   * Editor deep links (arc 6): a DEPLOYMENT capability, not an activation.
   * vscode:// links open on the BROWSER's machine, so links render only
   * when three statements align: the operator started serve with
   * --editor vscode AND --runner (this machine owns the worktrees), the
   * run belongs to that runner, and THIS session turned links on for
   * this device. "vscode" is the only value; the scheme is never data.
   */
  editorLinks?: "vscode";
  /** Injected by tests: the onboarding ceremony's gh-facing halves — the
   * ceremony's gating, nonce, and enrollment logic is what the HTTP tests
   * prove; gh itself is proved by onboard.test.ts. */
  ghPreview?: typeof previewGithubRepo;
  ghClone?: typeof cloneGithubRepo;
  ghList?: typeof listGithubRepos;
  /** Injected by tests: the git and gh calls pull-request setup and Merge make. */
  publishExec?: PublishExec;
};

export const SESSION_COOKIE = "standing-orders_session";
/** Stands in for "no project" in a ceiling: no folder resolves to it, so it admits nothing. */
export const NO_PROJECT = "/\0no-project";
/** Where `up`'s one-time sign-in link points, and how long it works. */
export const SIGN_IN_LINK_PATH = "/login/once/";
export const SIGN_IN_LINK_MS = 10 * 60_000;
/** The installation fact that the lead was turned on by default, once (its value: the provider). */
export const LEAD_BY_DEFAULT_FACT = "lead-on-by-default";
/** The installation fact that the phone card was put away. */
export const PHONE_CARD_FACT = "phone-card-dismissed";
// A note is at most NOTE_BYTE_CAP (16,000) UTF-8 bytes, which URL encoding
// can triple: room for one whole, before canonical text validation.
export const BODY_CAP = 64 * 1024;
// URL encoding can triple UTF-8 bytes. Admit the existing bounded task
// fields (a goal and exclusions of 32,000 bytes each, paths and rubric)
// before canonical text validation.
export const TASK_FORM_BODY_CAP = 1024 * 1024;
/** A cookie idles out after half a day and dies outright after a week. */
export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
/** An approval nonce is a rendered form, not a standing right — it ages out fast. */
export const NONCE_TTL_MS = 15 * 60_000;
export const NONCE_CAP = 500;
export const RUNS_PAGE = 50;

export const TASK_STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

/** Read-only fragment polls that must never refresh session activity (arc 1). */
export const NO_TOUCH_FRAGMENTS: ReadonlySet<string> = new Set(["1", "facts", "peek", "rail", "transcript"]);


export type Session = {
  name: string;
  csrf: string;
  /** v29: the account's standing at login — the central gate reads it;
   * the revocation cascade kills the session outright. */
  role: "approver" | "viewer";
  /** The approver generation at login: credential rotation kills the cookie. */
  generation: number;
  createdAt: number;
  lastSeen: number;
  /** The open project — a VIEW FILTER chosen inside the ceiling, never authorization. */
  project: string | null;
  /** Bumped on every open: stale tabs carry the revision they were rendered under. */
  projectRevision: number;
  /** v100: signed in with the identity provider, and when it last checked them (a step-up within 10 minutes needs no password). */
  sso?: { at: number };
  /** v101: the browser and address it signed in from, for the person to recognise it. */
  agent?: string | null;
  address?: string | null;
  /** Onboarding preview records (arc: repo onboarding, finding 14) —
   * session-held, swept at mint, at most 3, consumed exactly once. */
  onboard?: Map<string, { nameWithOwner: string; rootIndex: number; target: string; diskUsageKib: number | null; large: boolean; mintedAt: number }>;
  /** When this session last READ the board — the anchor for "since you
   * last looked". Full page loads move it; fragment polls never do. */
  sawBoardAt: number | null;
  /** Fleet chat (v13): drafts and the last reply live HERE and nowhere
   * durable — restart or logout loses them by design (v2 finding 12). */
  chat?: SessionChat;
  /** Editor links (arc 6): the SESSION's half of the activation — "this
   * browser runs on the machine that holds the worktrees" is a statement
   * only the person at the browser can make. Dies with the session. */
  editorLinks?: boolean;
};

export type ChatCandidate = {
  key: string;
  draft: ChatDraft;
  /** Resolved server-side at parse time from the opaque repoId. */
  repoPath: string;
  provider: string;
  approver: string;
  /** Digest of the frozen explicit repo list at turn time — filing
   * re-proves it (v2 new finding 5). */
  ceilingDigest: string;
  createdAt: number;
  state: "pending" | "filing";
};

export type SessionChat = {
  candidates: Map<string, ChatCandidate>;
  lastTurn: { id: number; reply: string | null; staticError: string | null; proposalsDiscarded: boolean } | null;
};

/** One rendered approval form: who saw which digest of which task, once. */
export type ApprovalNonce = {
  name: string;
  taskId: string;
  digest: string;
  expiresAt: number;
};

export type Who = { name: string; via: "cookie"; session: Session; role: "approver" | "viewer" } | { name: string; via: "bearer"; role: "approver" | "viewer"; /** v101: the API token it came with. */ token?: string;
  /** The complete proved API-token authority, retained across body reads. */ principal?: Principal; generation: number };

/**
 * v101: browser sessions in memory and in the database (by a hash of the
 * cookie, never the cookie), so a restart signs no one out and a person can
 * see and end their sessions. The in-memory map is the working set; a cookie
 * it hasn't seen is looked up by its hash.
 */
export class PersistentSessions extends Map<string, Session> {
  private readonly ids = new WeakMap<Session, string>();
  private readonly savedAt = new WeakMap<Session, number>();
  constructor(private readonly db: Store) { super(); }
  static hash(id: string): string { return createHash("sha256").update(id, "utf8").digest("hex"); }
  override set(id: string, session: Session): this {
    super.set(id, session);
    this.ids.set(session, id);
    this.persist(session);
    return this;
  }
  override delete(id: string): boolean {
    this.db.dropWebSession(PersistentSessions.hash(id));
    return super.delete(id);
  }
  /** Keep a changed session (its project, its provider check); `seen` only once a minute. */
  persist(session: Session, seen = false): void {
    const id = this.ids.get(session);
    if (id === undefined || (seen && Date.now() - (this.savedAt.get(session) ?? 0) < 60_000)) return;
    this.savedAt.set(session, Date.now());
    this.db.saveWebSession({ idHash: PersistentSessions.hash(id), account: session.name, csrf: session.csrf, role: session.role, generation: session.generation, createdAt: session.createdAt,
      lastSeen: session.lastSeen, project: session.project, projectRevision: session.projectRevision, ssoAt: session.sso?.at ?? null, agent: session.agent ?? null, address: session.address ?? null });
  }
  /** A cookie from before a restart, if its session is still kept. */
  load(id: string): Session | null {
    const row = this.db.webSession(PersistentSessions.hash(id));
    if (row === null) return null;
    const session: Session = { name: row.account, csrf: row.csrf, role: row.role, generation: row.generation, createdAt: row.createdAt, lastSeen: row.lastSeen, sawBoardAt: null,
      project: row.project, projectRevision: row.projectRevision, agent: row.agent, address: row.address, ...(row.ssoAt === null ? {} : { sso: { at: row.ssoAt } }) };
    super.set(id, session);
    this.ids.set(session, id);
    this.savedAt.set(session, Date.now());
    return session;
  }
  /** End one session by its kept hash (from the Sessions page). */
  endByHash(idHash: string): void {
    for (const id of [...this.keys()]) if (PersistentSessions.hash(id) === idHash) super.delete(id);
    this.db.dropWebSession(idHash);
  }
  hashOf(session: Session): string | null { const id = this.ids.get(session); return id === undefined ? null : PersistentSessions.hash(id); }
}

/** The console's server, and the one-time sign-in link `up` opens: a path on this server, or null for no such approver.
 * closeCoding starts the coding shutdown on its own, ahead of the rest of a stop; close() awaits the same promise. */
export type DecisionServer = Server & { mintSignInLink(account: string): string | null; closeCoding(): Promise<void> };

/** How long a stop waits for subagents and the lead's follow pass before closing anyway. */
export const SHUTDOWN_WAIT_MS = 5_000;

// ---- path plumbing ---------------------------------------------------------

/**
 * Match `/t/<id>` (suffix "") or `/t/<id>/<verb>` — the id percent-decoded
 * exactly once, refused when it does not decode, is oversized, or carries
 * control characters. Legacy CLI-created ids are free-form; the URL is not.
 */
export function matchTaskPath(pathname: string, suffixPattern: string): { taskId: string; verb: string } | null {
  const match = new RegExp(`^/t/([^/]+)${suffixPattern === "" ? "$" : suffixPattern}`).exec(pathname);
  if (match === null) return null;
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
  if (taskId.length === 0 || taskId.length > 64 || hasForbiddenControls(taskId)) return null;
  return { taskId, verb: match[2] ?? "" };
}

export function taskHref(taskId: string): string {
  return `/t/${encodeURIComponent(taskId)}`;
}

/** The spend line for a 7am reader: whole cents, "runs", the gap still named. */
export function consoleSpend(summary: ReturnType<typeof tally<Run & { taskId: string }>>): string {
  if (summary.invoked.length === 0) return "nothing — no provider was invoked";
  if (summary.measured.some(run => run.authMode === "subscription")) return spendLine(summary);
  const dollars = `$${summary.spend.toFixed(2)}`;
  // The measured count rides the SAME clause as the total (Phase 3 A6):
  // a bare sum over a mixed fleet reads as complete, and is not.
  if (summary.measured.length === summary.invoked.length) {
    return `${dollars} across ${summary.invoked.length} run(s)`;
  }
  return `${dollars} measured across ${summary.measured.length} of ${summary.invoked.length} runs — the rest report tokens only`;
}

/** ISO to the minute — "2026-08-12 17:56" — for anywhere a person reads a time. */
export function when(iso: string | null): string {
  return iso === null ? "" : iso.slice(0, 16).replace("T", " ");
}

/** The same minute as a `<time>`: the full stamp on a desk, "16:39" / "Yesterday 16:39" / "Sep 28" on a phone. */
export function whenTime(iso: string | null): string {
  return iso === null ? "" : whenHtml(iso, when(iso));
}

/** Overdue is derived at render — display never writes. */
export function isOverdue(decision: Decision, now: Date): boolean {
  if (decision.state === "expired") return true;
  return (
    decision.state === "open" && decision.deadline !== null && decision.deadline <= now.toISOString()
  );
}

// ---- rendering -------------------------------------------------------------

export const SAFETY = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

export function respond(response: ServerResponse, status: number, type: string, body: string): void {
  // A route that set its OWN policy (the service worker's default-src
  // 'none') or its own caching (the pre-auth assets) keeps it —
  // writeHead's headers would otherwise win.
  const own = response.getHeader("content-security-policy");
  const cache = response.getHeader("cache-control");
  response.writeHead(status, {
    ...SAFETY,
    ...(own === undefined ? {} : { "content-security-policy": own as string }),
    ...(cache === undefined ? {} : { "Cache-Control": cache as string }),
    "Content-Type": type,
  });
  response.end(body);
}

/**
 * A page response. With a nonce, this response's CSP admits exactly the one
 * inline script the shell stamped with the same value — generated per
 * response, never shared, never 'unsafe-inline' (Codex board review,
 * finding 9). Everything else keeps the constant script-free policy.
 */
export function page(response: ServerResponse, status: number, html: string, nonce?: string, fetches?: boolean): void {
  if (nonce === undefined) return respond(response, status, "text/html; charset=utf-8", html);
  response.writeHead(status, {
    ...SAFETY,
    "Content-Security-Policy":
      `default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; ` +
      // connect-src only when the page's script actually fetches (a region
      // poller, the full chrome beat, or the minimal sensitive-page beat).
      `${fetches === true ? "connect-src 'self'; " : ""}form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

/**
 * An outside sign-in comes back only to the browser that started it: the
 * start leaves the visit's state in this cookie (Lax, so it rides the
 * service's redirect back; the session cookie is Strict and doesn't), and a
 * return whose state isn't the one this browser holds is refused. So nobody
 * can start a sign-in and have someone else finish it into their project.
 */
/** A moment's page on the way to or back from another site's sign-in: no stylesheet may load there, so the palette rides inline. */
export const HANDOFF_STYLE = `<style>body{font:15px/1.5 "Geist",system-ui,sans-serif;margin:2rem;background:#efefef;color:#171717}a{color:#171717;text-decoration-color:#8f8f8f;text-underline-offset:3px}@media(prefers-color-scheme:dark){body{background:#0b0b0b;color:#ededed}a{color:#ededed;text-decoration-color:#ff6fb5}}</style>`;
export const SIGN_IN_COOKIE = "so-sign-in";
export function startedHere(request: IncomingMessage, state: string): boolean {
  const held = new RegExp(`(?:^|;\\s*)${SIGN_IN_COOKIE}=([A-Za-z0-9_-]{16,128})`).exec(request.headers.cookie ?? "")?.[1];
  return held !== undefined && held.length === state.length && timingSafeEqual(Buffer.from(held), Buffer.from(state));
}
export const signInSpent = (path: string) => `${SIGN_IN_COOKIE}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;

/**
 * Off to another site's sign-in (Google, a service's one-click connection):
 * a page that moves on by itself. Not a redirect: every page's form-action
 * 'self' also covers where a form's answer redirects, so a browser stops a
 * form that is answered with another site's address.
 */
export function goOutside(response: ServerResponse, to: string, words: string, bind: { state: string; path: string; secure: boolean }): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "set-cookie": `${SIGN_IN_COOKIE}=${bind.state}; Path=${bind.path}; Max-Age=900; HttpOnly; SameSite=Lax${bind.secure ? "; Secure" : ""}`,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${escape(to)}"><title>Toolroll</title>${HANDOFF_STYLE}<p>${escape(words)} <a href="${escape(to)}">Continue</a></p>`);
}

export function redirect(response: ServerResponse, to: string): void {
  response.writeHead(303, { ...SAFETY, Location: to });
  response.end();
}

/**
 * A refusal that stays inside the console: same shell, a problem banner, and
 * a way back — the error path is the one place a console must not stop
 * being a console. Bearer callers still get plain text; they parse, not read.
 */
export function refuse(
  response: ServerResponse,
  who: Who | null,
  status: number,
  message: string,
  backHref = "/",
): void {
  if (who === null || who.via === "bearer") {
    return respond(response, status, "text/plain; charset=utf-8", message);
  }
  const body = [
    `<h1>${status === 404 ? "Not found" : "Request refused"}</h1>`,
    // A missing page is plain news, not an error.
    status === 404 ? `<p>${escape(message)}</p>` : `<div class="problem">${escape(message)}</div>`,
    `<p class="meta refusal-back"><a href="${escape(backHref)}">\u2190 Back</a></p>`,
  ].join("\n");
  // A signed-in browser keeps the workspace around it: the same navigation as every page.
  const framed = requestContext.getStore()?.refusal;
  if (framed !== undefined && who.via === "cookie") return framed(response, status, body);
  return page(response, status, shell("refused", body));
}

/**
 * A vscode://file href, or null (arc 6, finding 2): the link exists only
 * when every part is provably tame — an absolute, control-free worktree;
 * a relative, single-line path whose segments contain no empty, dot,
 * dot-dot, or backslash components (so lexical resolution stays below the
 * worktree); a line inside the same 1..1,000,000 range the comment form
 * enforces. Encoding failures return null — a file row degrades to plain
 * text, never to a 500. The scheme is a constant, never data.
 */
export function editorFileHref(worktree: string, path: string, line?: number | null): string | null {
  if (!worktree.startsWith("/") || /[\u0000-\u001f\u007f]/.test(worktree)) return null;
  if (path === "" || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith("/") || path.includes("\\")) return null;
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return null;
  const rootSegments = worktree.replace(/\/+$/, "").split("/");
  if (rootSegments.some(segment => segment === "." || segment === "..")) return null;
  try {
    const root = rootSegments.map(segment => encodeURIComponent(segment)).join("/");
    const file = segments.map(segment => encodeURIComponent(segment)).join("/");
    const at = line !== undefined && line !== null && Number.isInteger(line) && line >= 1 && line <= 1_000_000 ? `:${line}` : "";
    return `vscode://file${root}/${file}${at}`;
  } catch {
    return null;
  }
}

/** The execution profile in plain words (v24): what the password signs
 * says WHAT RUNS — provider, exact model, permissions, and the real
 * bounds — or says honestly that it cannot yet. */
/** The state badges the criterion-to-evidence matrix renders with — one
 * shared vocabulary, so a "failed" row reads the same shade of trouble on
 * the task page, the run page, the board, done, builds, the inbox, and
 * chat (v39, extending Priority 2's "one surface, six places" rule from
 * the verdict word to the per-criterion state). */
export function matrixStateBadge(state: CriterionMatrixRow["state"]): string {
  // Red belongs to a Failed headline alone (task-status.ts); an unmet requirement is an amber note.
  const cls = state === "pass" ? "badge-done" : state === "failed" ? "badge-note" : state === "missing" ? "badge-note" : "badge-manual-review";
  // The same words as the Checks tab and the card's Requirements row (task-status.ts).
  return `<span class="badge ${cls}" data-matrix-state="${escape(state)}">${escape(requirementWordOf({ state }))}</span>`;
}

/** v40: the bounded repair chain's own line — presented as the user-facing
 * recovery it represents, without exposing the internal workflow name.
 * Renders on the task page and the run page identically. */
export function repairChainHtml(chain: RepairChainRow | null): string {
  if (chain === null) return "";
  const basisWords = chain.basis === "mode" ? "approved automatically" : "ready for your approval";
  const outcomeWords =
    chain.outcome === "drafted"
      ? chain.draftTask === null ? "No fix could be prepared" : `Targeted fix ${basisWords}`
      : chain.outcome === "resolved"
        ? `Completed on attempt ${chain.attempt}`
        : chain.outcome === "attempts-spent"
          ? `Stopped after ${chain.attempt} attempt${chain.attempt === 1 ? "" : "s"}`
          : chain.outcome === "no-progress"
            ? "Stopped because two attempts made no progress"
            : "Stopped because the evidence may conflict with the approved work";
  const link = chain.draftTask === null ? "" : ` <a href="${taskHref(chain.draftTask)}">${escape(chain.draftTask)}</a>`;
  const details = chain.unresolved.length === 0
    ? ""
    : `<details><summary>What it is fixing</summary><p class="meta">${escape(chain.unresolved.join(", "))}</p></details>`;
  return `<div class="card repair-chain" data-repair-outcome="${escape(chain.outcome)}"><p class="row"><strong>Automatic recovery</strong> — ${escape(outcomeWords)}${link}</p>${details}</div>`;
}

/**
 * The bounded review-retry panel (v50), shared by the task page and the
 * result cockpit so both say the same thing: which attempt is running or
 * queued, how the latest one ended, every root attempt on record, and the
 * ONE explicit act — a Retry review form — rendered only while the store's
 * allowance admits it and this session may ask (an approver's cookie
 * session). Every other state shows the same control disabled, in words,
 * so a person always sees why nothing more will happen by itself. Empty
 * when no review was ever asked for.
 */
export function reviewRetryPanel(
  _taskId: string,
  _sourceRun: number,
  retry: ReviewRetryState | null,
  _options: { csrf: string; canAct: boolean; returnTo: string | null },
): string {
  if (retry === null || retry.state === "unrequested") return "";
  const attempts = retry.attempts.map(one =>
    `<li data-review-attempt="${one.attempt}" data-review-outcome="${escape(one.outcome ?? "open")}"><a href="/r/${one.runId}">Run #${one.runId}</a> · ${escape(one.outcome ?? "unfinished")}${one.reason === null ? "" : ` · ${escape(one.reason)}`}</li>`).join("");
  return `<details class="review-history" data-review-state="${escape(retry.state)}"><summary>Previous assessments</summary><p class="meta">Saved history; no separate review will be started.</p>${attempts === "" ? "" : `<ol aria-label="previous assessments">${attempts}</ol>`}</details>`;
}

/** A one-line summary of the matrix for list rows too dense for the full
 * table (done, builds, board, inbox) — "2/3 criteria", plus a worst-state
 * badge so trouble is visible without opening the row. `[]` renders
 * nothing. */
export function criterionMatrixSummary(matrix: readonly CriterionMatrixRow[]): string {
  if (matrix.length === 0) return "";
  const { passed, total } = passFraction(matrix);
  const worst = matrix.some(row => row.state === "missing" || row.state === "failed")
    ? "failed"
    : matrix.some(row => row.state === "manual-review")
      ? "manual-review"
      : "pass";
  return worst === "pass"
    ? ` <span class="badge badge-done">${passed}/${total} criteria</span>`
    : `${matrixStateBadge(worst)} <span class="badge">${passed}/${total} criteria</span>`;
}

/** Where a criterion's own typed evidence ref resolves to a stored
 * artifact, keyed `${kind}:${ref}` — built once per run from its
 * artifacts (v39 review finding: "link artifacts where possible"). A
 * `changed-path` ref never gets its own per-file artifact, so every one of
 * those shares the single terminal-diff patch, under the wildcard key. A
 * `manual-review` ref never resolves — it names nothing machine-checkable. */
export type EvidenceLinkMap = ReadonlyMap<string, number>;
export const CHECK_LOG_CAPTURE = /^sh -c "(.+)" \(exit \d+(?:, timed out)?\)$/;
export function evidenceLinksFor(artifacts: readonly Artifact[]): EvidenceLinkMap {
  const map = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.kind === "screenshot") {
      const path = SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1];
      if (path !== undefined) map.set(`screenshot:${path}`, artifact.id);
    } else if (artifact.kind === "check-log") {
      const command = CHECK_LOG_CAPTURE.exec(artifact.capture)?.[1];
      if (command !== undefined) map.set(`check:${command}`, artifact.id);
    } else if (artifact.kind === "terminal-diff") {
      map.set("changed-path:*", artifact.id);
    }
  }
  return map;
}

/** Read the approved requirement first; inspect its saved evidence on demand.
 * Machine results, reviewer judgements and missing context remain separate.
 * Warnings stay outside the disclosure, including on compact surfaces. */
export function criterionMatrixHtml(
  matrix: readonly CriterionMatrixRow[],
  options: { compact?: boolean; runId?: number; links?: EvidenceLinkMap; fileAnchors?: ReadonlyMap<string, string>; verdict?: string | null } = {},
): string {
  if (matrix.length === 0) return "";
  const kinds: Record<CriterionEvidenceRef["kind"], string> = {
    check: "Checks", "changed-path": "Changed files", screenshot: "Screenshots", "manual-review": "You check",
  };
  const evidenceLink = (a: CriterionEvidenceRef): string => {
    const text = `<code>${escape(a.ref)}</code>`;
    const anchor = a.kind === "changed-path" ? options.fileAnchors?.get(a.ref) : undefined;
    if (anchor !== undefined) return `<a href="#${escape(anchor)}">${text}</a>`;
    const artifactId = options.links?.get(`${a.kind}:${a.ref}`) ?? (a.kind === "changed-path" ? options.links?.get("changed-path:*") : undefined);
    return artifactId !== undefined && options.runId !== undefined
      ? `<a href="/r/${options.runId}/evidence/${artifactId}">${text}</a>`
      : text;
  };
  const rows = matrix.map((row, index) => {
    const state = row.state;
    const awaitingAssessment = row.assessment?.evidenceState === "pass" && row.review === null;
    const confirmed = row.assessment !== undefined && state === "pass";
    // Plain words (task-status brief): the retired assessment step is not a state a person acts on.
    // The card's Requirements row reads the same words from the same source (task-status.ts), so they agree.
    const label = requirementWordOf(row, options.verdict);
    const cls = label === "Met" ? "badge-done" : label === "You check" ? "badge-manual-review" : "badge-note";
    const warnings: string[] = [];
    // Only replace the known boilerplate. Other recorded failure details
    // remain verbatim, so concision cannot hide a different problem.
    const detail = row.detail.filter(line => !(row.assessment && row.review && line === `${row.review.author} ${row.review.judgement === "contradicts" ? "contradicts" : "needs more evidence for"} criterion "${row.id}": ${row.review.note}`) && !(state === "manual-review" && /^criterion "[^"\n]+" requires manual-review evidence — an operator must accept it before this can verify$/.test(line)));
    if (!awaitingAssessment && state !== "pass" && detail.length > 0) warnings.push(`<ul class="requirement-issues">${detail.map(line => `<li>${escape(line)}</li>`).join("")}</ul>`);
    const review = row.review;
    if (review !== null && review.judgement !== "upholds") {
      warnings.push(`<div class="requirement-warning" data-review-judgement="${escape(review.judgement)}"><strong>${review.judgement === "contradicts" ? "Reviewer found a problem" : "Reviewer could not confirm this"}</strong><p>${escape(review.note)}</p></div>`);
    }
    const coverage = row.coverage;
    if (coverage !== undefined && (coverage.state === "gap" || coverage.gaps.length > 0)) {
      warnings.push(`<div class="requirement-warning" data-context-coverage="${escape(coverage.state)}"><strong>Review context is missing</strong>${coverage.gaps.length === 0 ? `<p>The saved context cannot support this requirement.</p>` : `<ul>${coverage.gaps.map(gap => `<li>${escape(gap)}</li>`).join("")}</ul>`}${coverage.priorSupport === "invalid" ? `<p>The earlier review no longer supports this requirement.</p>` : ""}</div>`);
    }
    const answered = row.answered ?? [];
    const groups = Object.entries(kinds).flatMap(([kind, name]) => {
      const refs = answered.filter(one => one.kind === kind);
      return refs.length === 0 ? [] : [`<div class="requirement-evidence-group"><strong>${name} · ${refs.length}</strong><ul>${refs.map(ref => `<li>${evidenceLink(ref)}</li>`).join("")}</ul></div>`];
    }).join("");
    const reviewDetails = review === null ? "" : `<div class="requirement-evidence-group"><strong>Previous assessment</strong><p>${review.judgement === "upholds" ? `${escape(review.note)} ` : ""}<span class="meta">${escape(review.author)}</span></p></div>`;
    return `<li class="requirement" data-criterion-id="${escape(row.id)}">` +
      `<div class="requirement-heading"><span>Requirement ${index + 1}</span><span class="badge ${cls}" data-matrix-state="${escape(state)}">${label}</span></div>` +
      `<p class="requirement-statement">${escape(row.statement)}</p>` +
      (review?.judgement === "upholds" && !confirmed ? `<p class="requirement-review" data-review-judgement="upholds">Reviewer confirmed</p>` : "") +
      warnings.join("") +
      `<details class="requirement-evidence"><summary>View evidence</summary><div class="requirement-evidence-body">` +
      `<p class="meta">Required: ${row.requiredEvidence.map(kind => kinds[kind]).join(", ") || "No evidence types specified"}</p>` +
      (answered.length === 0 ? `<p class="meta">No evidence was submitted for this requirement.</p>` : groups) +
      (state !== "pass" || detail.length === 0 ? "" : `<div class="requirement-evidence-group"><strong>Verification notes</strong><ul>${detail.map(line => `<li>${escape(line)}</li>`).join("")}</ul></div>`) +
      reviewDetails +
      (coverage === undefined ? "" : `<p class="meta"${coverage.state === "gap" ? "" : ` data-context-coverage="${escape(coverage.state)}"`}>Review context: ${escape(coverageStateWords(coverage))}</p>`) +
      (coverage?.assets === undefined ? "" : `<p class="meta" data-context-assets>${escape(coverage.assets)}</p>`) +
      `<p class="meta">Requirement ID: <code>${escape(row.id)}</code></p></div></details></li>`;
  }).join("");
  return `<div class="result-section criterion-matrix"><strong>Requirements · ${matrix.length}</strong><ol class="requirement-list">${rows}</ol></div>`;
}

/** What the task and approval views show about a drafted plan's contract
 * (contract handoff, task 1). A problem is a named problem, never a blank. */
export type PlanContractView =
  | { run: number; problem: string }
  | {
      run: number;
      sourceDigest: string;
      /** Whether a scope was filed before planning (false: legacy road). */
      filed: boolean;
      amendment: string | null;
      changes: ContractChange[];
      changeWords: string[];
      /** The proposed terms are still exactly the scope row. */
      current: boolean;
      /** A revision: the terms before planning were copied from the previous version, not filed by a person. */
      revision?: boolean;
    };

export function contractChangeHtml(change: ContractChange): string {
  const tag = `<span class="contract-change-kind contract-change-${change.kind}">${change.kind}</span>`;
  switch (change.field) {
    case "goal":
      return `<li>${tag} <strong>goal</strong><div class="contract-before">was: ${escape(change.before)}</div><div class="contract-after">now: ${escape(change.after)}</div></li>`;
    case "outOfScope":
      return `<li>${tag} <strong>not this</strong>${change.before === null ? "" : `<div class="contract-before">was: ${escape(change.before)}</div>`}${change.after === null ? `<div class="contract-after">now: <em>no exclusions</em></div>` : `<div class="contract-after">now: ${escape(change.after)}</div>`}</li>`;
    case "touches":
      return `<li>${tag} <strong>touches</strong> <span class="mono">${escape(change.path)}</span></li>`;
    case "acceptance": {
      const criterion = (one: { statement: string; evidence: readonly string[]; how: string | null } | null): string =>
        one === null ? "" : `${escape(one.statement)} <span class="meta">[requires: ${one.evidence.map(escape).join(", ")}]</span>${one.how === null ? "" : `<div class="meta">how: ${escape(one.how)}</div>`}`;
      return (
        `<li>${tag} <strong>criterion <code>${escape(change.id)}</code></strong>${change.kind === "changed" ? ` <span class="meta">(${change.moved.map(escape).join(", ")})</span>` : ""}` +
        (change.before === null ? "" : `<div class="contract-before">${change.kind === "removed" ? "removed: " : "was: "}${criterion(change.before)}</div>`) +
        (change.after === null ? "" : `<div class="contract-after">${change.kind === "added" ? "added: " : "now: "}${criterion(change.after)}</div>`) +
        `</li>`
      );
    }
  }
}

/**
 * The contract panel (contract handoff, task 1): whether the drafted plan
 * reproduced the filed goal, exclusions, touches, and rubric exactly, or
 * proposes an amendment — every addition, change, and removal listed, the
 * planner's stated reason beside them, and the plain consequence that
 * approving binds the AMENDED terms. "full" is the task page's card;
 * "ceremony" is the restatement inside the approval form and /next.
 */
export function planContractHtml(view: PlanContractView | null, mode: "full" | "ceremony"): string {
  if (view === null) {
    return mode === "full" ? "" : `<p class="meta contract-note">no contract record for this draft — compare the scope above against what you filed before signing</p>`;
  }
  if ("problem" in view) {
    return `<div class="contract-panel contract-problem"><p class="approval-label">filed contract</p><p class="meta">${escape(view.problem)} · <a href="/r/${view.run}">run ${view.run}</a></p></div>`;
  }
  const stale = view.current ? "" : `<p class="meta">The scope was edited after this draft landed — the record below describes the draft as the planner proposed it</p>`;
  if (!view.filed) {
    return mode === "full"
      ? `<div class="contract-panel contract-drafted"><p class="approval-label">filed contract</p><p class="meta">No scope was filed before planning — the planner drafted this contract from the title and the repository; review every term as new</p>${stale}</div>`
      : `<p class="meta contract-note">no scope was filed before planning — every term above is the planner's proposal</p>`;
  }
  if (view.revision === true) {
    // A send-back: the terms were copied from the previous version, and the planner updated them with the notes.
    if (view.changes.length === 0) {
      return `<div class="contract-panel contract-preserved"><p class="approval-label">updated plan</p><p><strong>Same terms as before</strong> <span class="meta">your notes fit the previous plan · <a href="/r/${view.run}">run ${view.run}</a></span></p>${stale}</div>`;
    }
    return (
      `<div class="contract-panel contract-amended"${mode === "full" ? ` id="contract-amendment"` : ""}><p class="approval-label">updated plan</p>` +
      `<p><strong>${view.changes.length} change${view.changes.length === 1 ? "" : "s"} from your notes</strong> <span class="meta">— approving accepts the updated terms ${mode === "full" ? "in the scope" : "above"} · <a href="/r/${view.run}">run ${view.run}</a></span></p>` +
      (view.amendment === null ? "" : `<p class="recap contract-reason"><strong>Why:</strong> ${escape(view.amendment)}</p>`) +
      `<ul class="recap contract-changes">${view.changes.map(contractChangeHtml).join("")}</ul>` +
      stale +
      `</div>`
    );
  }
  if (view.changes.length === 0) {
    return `<div class="contract-panel contract-preserved"><p class="approval-label">filed contract</p><p><strong>Preserved exactly</strong> <span class="meta">the plan reproduces the filed goal, exclusions, touches, and acceptance criteria — approving binds the terms you filed · <a href="/r/${view.run}">run ${view.run}</a></span></p>${stale}</div>`;
  }
  return (
    `<div class="contract-panel contract-amended"${mode === "full" ? ` id="contract-amendment"` : ""}><p class="approval-label">filed contract · amendment proposed</p>` +
    `<p><strong>${view.changes.length} change${view.changes.length === 1 ? "" : "s"} to what you filed</strong> <span class="meta">— approving binds the AMENDED terms shown ${mode === "full" ? "in the scope" : "above"}, not the ones you filed · <a href="/r/${view.run}">run ${view.run}</a></span></p>` +
    (view.amendment === null
      ? `<p class="meta">The planner stated no reason for the amendment</p>`
      : `<p class="recap contract-reason"><strong>Why:</strong> ${escape(view.amendment)}</p>`) +
    `<ul class="recap contract-changes">${view.changes.map(contractChangeHtml).join("")}</ul>` +
    stale +
    `</div>`
  );
}

/** One policy summary beneath the requirements. Per-requirement concerns
 * are already visible in the matrix; do not repeat their full text here. */
export function semanticCoverageHtml(matrix: readonly CriterionMatrixRow[], qualityMode: "default" | "strict"): string {
  if (!matrix.some(row => row.review != null || row.assessment !== undefined)) return "";
  const coverage = semanticCoverage(matrix, qualityMode);
  return `<details class="result-section semantic-coverage" data-semantic-coverage="${coverage.satisfied === true ? "satisfied" : coverage.satisfied === null ? "unsettled" : "unsatisfied"}" data-coverage-policy="${coverage.policy}"><summary>Previous assessment</summary><p class="meta">The saved assessment confirmed ${coverage.upheld.length} of ${coverage.total} requirements.</p></details>`;
}

/** The exact path limits, one per line (UI polish 2026-09-13): a long
 * comma run was the least readable term on a phone. Every path, verbatim. */
export function approvalPathsHtml(touches: readonly string[]): string {
  if (touches.length === 0) return `<p>anything</p>`;
  return `<ul class="approval-paths">${touches.map(one => `<li><span class="mono">${escape(one)}</span></li>`).join("")}</ul>`;
}

/** The rubric, restated above the seal (v39) — the same claim the digest
 * line already makes ("approval binds to this exact wording") extended to
 * the acceptance terms: an id in Geist Mono (a machine fact the proof must
 * answer by), a statement in Geist, the signed evidence kinds after
 * it. `how` never renders here — it is advisory, never signed. Empty
 * renders nothing: a grandfathered scope's ceremony is unchanged. */
export function acceptanceCeremonyHtml(criteria: readonly AcceptanceCriterion[]): string {
  if (criteria.length === 0) return "";
  return (
    `<p class="meta">Acceptance</p><ul class="recap acceptance-rubric">` +
    criteria
      .map(
        c =>
          `<li><code>${escape(c.id)}</code> ${escape(c.statement)} <span class="meta">[requires: ${c.evidence.map(escape).join(", ")}]</span></li>`,
      )
      .join("") +
    `</ul>`
  );
}

/** "claude" + "opus" → "Claude Opus"; "claude-opus-5-5" → "Claude Opus 5.5"; anything else keeps its exact id. */
export function agentNameWords(provider: string, model: string | null): string {
  const name = providerName(provider);
  if (model === null || model === "" || model === "default") return name;
  const bare = model.startsWith(`${provider}-`) ? model.slice(provider.length + 1) : model;
  const title = (word: string): string => `${word[0]!.toUpperCase()}${word.slice(1)}`;
  if (/^[a-z]+$/.test(bare)) return `${name} ${title(bare)}`;
  const versioned = /^([a-z]+)-(\d+(?:-\d+)*)$/.exec(bare);
  if (versioned !== null) return `${name} ${title(versioned[1]!)} ${versioned[2]!.replace(/-/g, ".")}`;
  return `${name} ${model}`;
}

/** The permission a sealed profile grants, in two or three words. */
export function permissionWordsOf(profile: Scope["profile"] | null | undefined): string | null {
  if (profile === null || profile === undefined) return null;
  return profile.provider === "claude"
    ? profile.permissionArgv === "bypassPermissions" ? "Full access" : "Auto permissions"
    : profile.provider === "gemini"
      ? profile.approvalArgv === "yolo" ? "Full access" : "Auto permissions"
      : profile.sandboxMode === "danger-full-access" ? "Full access" : "Workspace sandbox";
}

/** One plain sentence for a revision (approval critique, Oct 2):
 * "Fixes what build #9 missed: <criterion>." The notes, paths and lineage
 * stay in the Details fold. */
export function revisionSentence(revision: Extract<RevisionView, { sourceRun: number }>, acceptance: readonly AcceptanceCriterion[]): string {
  const build = `build #${revision.sourceRun}`;
  if (revision.kind === "ci-repair") return `Fixes the checks that failed in ${build}.`;
  const clean = (text: string): string => oneLineOf(text, 280).replace(/[.\s]+$/, "");
  if (revision.kind === "criterion-repair") {
    const ids = revision.comments.flatMap(one => (/Unmet: ([^.]+)\./.exec(one.note)?.[1] ?? "").split(",").map(id => id.trim()).filter(id => id !== ""));
    const missed = ids.map(id => acceptance.find(one => one.id === id)?.statement ?? null).filter((one): one is string => one !== null);
    if (missed.length > 0) return `Fixes what ${build} missed: ${missed.map(clean).join("; ")}.`;
  }
  const notes = revision.comments.map(one => clean(one.note)).filter(one => one !== "");
  return notes.length === 0 ? `Revises ${build}.` : `Fixes what ${build} missed: ${notes.join("; ")}.`;
}

/** A planner's amendment, said plainly and kept in view: approving binds
 * the amended terms, so this is never folded away. */
export function approvalAmendmentHtml(view: PlanContractView | null | undefined): string {
  if (view === null || view === undefined || "problem" in view || !view.filed && view.revision !== true || view.changes.length === 0) return "";
  const line = (change: ContractChange): string => {
    switch (change.field) {
      case "goal": return `Goal was: ${escape(change.before)}`;
      case "outOfScope": return change.after === null ? "No longer rules anything out" : change.before === null ? `Now rules out: ${escape(change.after)}` : `Won't touch was: ${escape(change.before)}`;
      case "touches": return `${change.kind === "added" ? "Adds the path" : "Drops the path"} <span class="mono">${escape(change.path)}</span>`;
      case "acceptance": return change.kind === "added" ? `Adds a check: ${escape(change.after?.statement ?? "")}` : change.kind === "removed" ? `Drops a check: ${escape(change.before?.statement ?? "")}` : `Rewords a check: ${escape(change.after?.statement ?? "")}`;
    }
  };
  const count = `${view.changes.length} change${view.changes.length === 1 ? "" : "s"}`;
  return (
    `<div class="approval-amendment" id="contract-amendment">` +
    `<p><strong>${view.revision === true ? `The plan makes ${count} from your notes` : `The plan makes ${count} to what you filed`}</strong></p>` +
    `<ul>${view.changes.map(one => `<li>${line(one)}</li>`).join("")}</ul>` +
    (view.amendment === null ? "" : `<p class="meta">Why: ${escape(view.amendment)}</p>`) +
    `</div>`
  );
}

/**
 * The approval sheet (approval critique, Oct 2): the plan open, in plain
 * rows — Goal, Changes, Won't touch, Done when — one line of who builds,
 * one Approve & start beside the password, and every remaining signed
 * term (lineage, routing, runtime limits, the seal) in one Details fold.
 * Presentation only: the same hidden fields, nonce, digest and password
 * post to the same route, and the task page and chat card share it.
 */
export function approvalSheetHtml(input: {
  surface: "task" | "chat";
  action: string;
  csrf: string;
  nonce: string;
  digest: string;
  returnTo: string | null;
  scope: Scope;
  planDocument: string | null;
  planContract: PlanContractView | null | undefined;
  revision: Extract<RevisionView, { sourceRun: number }> | null;
  revisionSourceHref: string;
  /** A machine-drafted repair: the build it repairs. */
  repairChain: RepairChainRow | null;
  route: RouteView | null | undefined;
  coordinator: { label: string; filedAgo: string | null } | null;
  deliverable: "branch" | "report";
  editHref: string;
  notNowHref: string;
  sticky: boolean;
  /** Earlier versions of this task still queued or running, and how many of them are running. */
  earlier: { active: number; running: number };
  /** The in-place editor (task page): the scope route, a draft the server
   * refused (with why), whether it opens on arrival, and the plan's steps editor. */
  edit: { action: string; draft: URLSearchParams | null; problem: string | null; open: boolean; stepsHref: string | null } | null;
}): string {
  const { scope, route } = input;
  // A machine-drafted repair appends its brief to the signed goal; the row
  // shows the goal and one sentence says what the repair fixes. The whole
  // signed goal stays in Details.
  const repairText = / — (repair exactly the unmet criteria named below; a comment cannot widen the scope\. Unmet: ([^.]+)\.|Collect only the missing observations for ([^.]+)\. .*|Diagnose the saved failed project check and repair within the original scope\. .*)$/s.exec(scope.goal);
  const goalShown = repairText === null ? scope.goal : scope.goal.slice(0, repairText.index);
  const statementsOf = (ids: string): string => ids.split(",").map(id => id.trim()).map(id => scope.acceptance.find(one => one.id === id)?.statement ?? id).map(one => one.replace(/[.\s]+$/, "")).join("; ");
  const repairBuild = input.revision?.sourceRun ?? input.repairChain?.sourceRun ?? null;
  const builtBy = repairBuild === null ? "the last build" : `build #${repairBuild}`;
  const sentence = input.revision !== null && (repairText === null || input.revision.comments.length > 0) ? revisionSentence(input.revision, scope.acceptance)
    : repairText === null ? null
    : repairText[2] !== undefined ? `Fixes what ${builtBy} missed: ${statementsOf(repairText[2])}.`
    : repairText[3] !== undefined ? `Collects the evidence ${builtBy} was missing for: ${statementsOf(repairText[3])}. The saved code stays the same.`
    : `Fixes the checks that failed in ${builtBy}.`;
  const plan = input.planDocument === null ? null : parseExecutionPlanDocument(input.planDocument);
  const milestones = plan !== null && plan.ok ? plan.document.milestones : [];
  const permission = permissionWordsOf(scope.profile);
  const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
  const row = (label: string, body: string): string => `<div class="approval-row"><dt>${label}</dt><dd>${body}</dd></div>`;
  const changes =
    (milestones.length > 0 ? `<ol class="approval-steps">${milestones.map(one => `<li>${escape(one)}</li>`).join("")}</ol>` : "") +
    (scope.touches.length > 0
      ? `<p>Only in these paths:</p>${approvalPathsHtml(scope.touches)}`
      : `<p${milestones.length > 0 ? ` class="meta"` : ""}>Any file in the project.</p>`);
  const doneWhen = scope.acceptance.length === 0
    ? `<p>You decide when you review the result.</p>`
    : `<ul class="approval-done">${scope.acceptance.map(one => `<li>${escape(one.statement)}</li>`).join("")}</ul>`;
  // Who builds, in one line: the builder and planner by name, the cap, and full access when granted.
  const legs = route?.projection?.legs ?? [];
  const legOf = (phase: Phase) => legs.find(one => one.phase === phase);
  const who: string[] = [];
  const builder = legOf("build");
  if (builder !== undefined) who.push(`Builder ${agentNameWords(builder.provider, builder.model)}`);
  else if (route?.legacy != null) who.push(`Builder ${agentNameWords(route.legacy.provider, route.legacy.model)}`);
  else if (scope.profile != null) who.push(`Builder ${agentNameWords(scope.profile.provider, scope.profile.model)}`);
  const planner = legOf("plan");
  // A small change makes no plan: no planner is named (a person's chosen planner still is).
  const sized = route?.projection?.size ?? null;
  const unplanned = route?.projection != null && makesNoPlan(sized, route.projection.risk) && planner?.chosen === "recommended";
  if (planner !== undefined && !unplanned) who.push(`Planner ${agentNameWords(planner.provider, planner.model)}`);
  // What the yes allows, in plain words, right above it: the agent's
  // permissions, the per-attempt limit, and an earlier version still running.
  const allowing: string[] = [];
  const allowed = permissionPlainWords(scope.profile);
  if (allowed !== null) allowing.push(allowed);
  allowing.push(scope.budgetMicrousd === null ? "no attempt limit" : `up to ${money(scope.budgetMicrousd)} per attempt`);
  const earlier = earlierVersionsWords(input.earlier.active, input.earlier.running);
  if (earlier !== null) allowing.push(earlier);
  const yoursToCheck = scope.acceptance.filter(one => one.evidence.includes("manual-review")).map(one => one.statement.trim().replace(/[.\s]+$/, ""));
  const consent =
    (allowing.length === 0 ? "" : `<p class="approval-allowing" data-approval-allowing>You’re allowing: ${allowing.map(escape).join(" · ")}</p>`) +
    (yoursToCheck.length === 0 ? "" : `<p class="approval-you-check" data-approval-you-check>You’ll check: ${yoursToCheck.map(escape).join("; ")}</p>`);
  const after = input.deliverable === "report"
    ? "An agent investigates without changing the repository. You'll hear when its report is ready."
    : "An agent starts in its own branch. You'll hear when it's ready to review.";
  const submit = "Approve & start";

  // Everything else the digest binds, one tap away.
  const detail = (title: string, body: string, attrs = ""): string => body === "" ? "" : `<section class="approval-detail"${attrs}><h3>${title}</h3>${body}</section>`;
  const revisionDetail = input.revision === null ? "" : detail("Earlier build",
    `<div class="revision-card" data-revision-feedback>` +
    `<p><a href="${escape(input.revisionSourceHref)}"${input.surface === "chat" ? " data-revision-source" : ""}>${input.surface === "chat" ? `Original result: build #${input.revision.sourceRun} →` : `build #${input.revision.sourceRun}`}</a></p>` +
    (input.revision.comments.length === 0 ? "" : `<ul>${input.revision.comments.map(one => `<li>${one.path === null ? "" : `<span class="mono">${escape(one.path)}${one.line === null ? "" : `:${one.line}`}</span> · `}${escape(one.note)} <span class="meta">— ${escape(one.author)}</span></li>`).join("")}</ul>`) +
    revisionLineageHtml(input.revision.lineage) +
    `</div>`);
  const contract = input.planContract;
  const contractDetail = input.planDocument === null || approvalAmendmentHtml(contract) !== "" ? ""
    : contract === null || contract === undefined ? `<p class="meta">No record compares this plan with what was filed. Check the rows above against your request.</p>`
    : "problem" in contract ? `<p class="meta">${escape(contract.problem)} · <a href="/r/${contract.run}">run ${contract.run}</a></p>`
    : !contract.filed && contract.revision !== true ? `<p class="meta">Nothing was filed before planning, so every term is the planner's proposal.</p>`
    : `<p class="meta">${contract.revision === true ? "Same terms as the previous version." : "The plan keeps exactly what you filed."} <a href="/r/${contract.run}">Planning run ${contract.run}</a></p>`;
  const criteriaDetail = scope.acceptance.length === 0 ? ""
    : `<ul class="approval-signed-criteria">${scope.acceptance.map(one => `<li><code>${escape(one.id)}</code> ${escape(one.statement)} <span class="meta">shown by ${one.evidence.map(kind => escape(EVIDENCE_PLAIN[kind] ?? kind)).join(", ")}</span></li>`).join("")}</ul>`;
  const projection = route?.projection ?? null;
  const agentsDetail = route === null || route === undefined ? ""
    : projection === null
      ? route.legacy === null ? "" : `<p>${escape(agentsSummaryWords(route))}</p>`
      : `<p>${escape(projection.summary)}</p>` +
        `<p class="meta">Uses ${escape(projection.postureWords)}.</p>` +
        (projection.demands.length === 0 ? "" : `<ul class="meta">${projection.demands.map(one => `<li>${escape(one)}</li>`).join("")}</ul>`) +
        `<dl class="approval-roles">${projection.legs.map(leg =>
          `<div><dt>${escape(ROLE_NOUN[leg.phase])}</dt><dd><span class="mono">${escape(leg.provider)} · ${escape(leg.model)}</span> <span class="meta">${escape(chosenWords(leg))}</span>` +
          `<ul>${leg.reasons.map(reason => `<li>${escape(reason)}</li>`).join("")}${leg.problem === null ? "" : `<li><strong>${escape(leg.problem)}</strong></li>`}</ul></dd></div>`).join("")}</dl>` +
        `<p class="meta">These exact agents are part of what you approve. Changing any of them asks for a fresh approval.</p>`;
  const limits =
    profileWords(scope) +
    `<p class="meta">Checks level: ${escape(qualityModeTitle(scope.qualityMode ?? "default"))}${permission === null ? "" : ` · ${escape(permission)}`}</p>` +
    (scope.budgetMicrousd === null ? "" : `<p class="meta">Each build attempt has a ${money(scope.budgetMicrousd)} agent-reported usage cap. On a subscription this limits work; it is not an API charge.</p>`);
  const details =
    `<details class="approval-details"><summary>Plan details</summary>` +
    revisionDetail +
    (repairText === null ? "" : detail("Signed goal", `<p>${escape(scope.goal)}</p>`)) +
    detail("Plan record", contractDetail) +
    detail("Signed criteria", criteriaDetail) +
    detail("Why these agents", agentsDetail, ` id="${input.surface === "task" ? "approval-agents" : "chat-approval-agents"}"`) +
    detail("Runtime limits", limits) +
    (scope.candidate ? detail("Saved commit", `<p><code class="approval-commit">${escape(scope.candidate)}</code></p>`) : "") +
    detail("Seal", `<p class="meta">Approval binds to this exact wording. <span class="seal mono">signs ${shortDigest(scope.digest)}</span></p>`) +
    `</details>`;
  const passwordNote = input.surface === "task" ? "approval-password-note" : "chat-approval-password-note";

  // Edit plan, in place (task page): the rows become fields and save
  // through the scope's own route. The fields belong to a form after this
  // one (forms never nest), so Approve never carries them.
  const edit = input.edit;
  const draft = edit?.draft ?? null;
  const editForm = "plan-editor-form";
  // Each field opens tall enough for what it holds (up to ten lines).
  const field = (name: string, value: string, rows: number, label: string, hint = ""): string =>
    `<label class="approval-field"><span class="approval-field-label">${label}</span>${hint === "" ? "" : `<span class="approval-field-hint">${hint}</span>`}` +
    `<textarea name="${name}" rows="${Math.min(10, Math.max(rows, value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 80)), 0)))}" form="${editForm}">${escape(value)}</textarea></label>`;
  // Done when, one line per requirement in the signed order; the server
  // matches them back by position (the digest guard keeps that order).
  const requirement = (name: string, value: string, label: string, placeholder = ""): string =>
    `<li><input type="text" name="${name}" value="${escape(value)}" aria-label="${label}"${placeholder === "" ? "" : ` placeholder="${placeholder}"`} form="${editForm}"></li>`;
  const requirements = draft?.getAll("requirement") ?? scope.acceptance.map(one => one.statement);
  const added = draft?.get("requirement-new") ?? "";
  const editor = edit === null ? null :
    `<details class="approval-edit" id="plan-editor"${draft === null && !edit.open ? "" : " open"}>` +
    `<summary class="approval-link"><span class="approval-edit-open">Edit plan</span><span class="approval-edit-close">Cancel</span></summary>` +
    `<div class="approval-editor">` +
    (edit.problem === null ? "" : `<p class="problem" role="alert">${escape(edit.problem)}</p>`) +
    field("goal", draft?.get("goal") ?? goalShown, 3, "Goal") +
    field("touches", draft?.get("touches") ?? scope.touches.join("\n"), 2, "Changes", "Only in these paths, one per line. Leave empty for any file.") +
    field("not", draft?.get("not") ?? scope.outOfScope ?? "", 2, "Won’t touch") +
    `<fieldset class="approval-field"><legend class="approval-field-label">Done when</legend>` +
    `<span class="approval-field-hint">Clear a line to drop it.</span><ul class="approval-requirements">` +
    requirements.map((one, index) => requirement("requirement", one, `Requirement ${index + 1}`)).join("") +
    requirement("requirement-new", added, "Add a requirement", "Add a requirement") +
    `</ul></fieldset>` +
    `<div class="approval-edit-act"><button type="submit" form="${editForm}">Save plan</button>` +
    // A plan with written steps keeps its own editor for them.
    (edit.stepsHref === null ? "" : `<a class="approval-link" href="${escape(edit.stepsHref)}">Edit steps</a>`) + `</div>` +
    `</div></details>`;
  const keptMode = permissionModeOfProfile(scope.profile);
  const editorForm = edit === null ? "" :
    `<form method="post" action="${edit.action}" id="${editForm}" class="approval-editor-form">` +
    `<input type="hidden" name="csrf" value="${escape(input.csrf)}">` +
    // A refused save keeps the version its draft was edited from, so a
    // plan that changed meanwhile is never silently overwritten.
    `<input type="hidden" name="sawDigest" value="${escape(draft?.get("sawDigest") ?? scope.digest)}">` +
    // The terms the editor doesn't show ride along unchanged: a repair's
    // brief after its goal (it stays in Details), permissions, checks, cap.
    (repairText === null ? "" : `<input type="hidden" name="goal-brief" value="${escape(repairText[0])}">`) +
    (keptMode === null ? "" : `<input type="hidden" name="permission-mode" value="${keptMode}">`) +
    `<input type="hidden" name="quality-mode" value="${escape(scope.qualityMode ?? "default")}">` +
    // The cap rides in exact millionths ("none" keeps no limit).
    `<input type="hidden" name="budget-microusd" value="${scope.budgetMicrousd === null ? "none" : String(scope.budgetMicrousd)}">` +
    `</form>`;

  return (
    `<form method="post" action="${input.action}" class="approve-form approval-sheet"${input.surface === "task" ? ` id="approve"` : ""}${input.sticky ? " data-sticky" : ""}>` +
    `<input type="hidden" name="csrf" value="${escape(input.csrf)}">` +
    `<input type="hidden" name="nonce" value="${escape(input.nonce)}">` +
    `<input type="hidden" name="digest" value="${escape(input.digest)}">` +
    (input.returnTo === null ? "" : `<input type="hidden" name="return" value="${escape(input.returnTo)}">`) +
    `<input type="text" name="username" autocomplete="username" class="visually-hidden" tabindex="-1" aria-hidden="true">` +
    `<h2 class="approval-sheet-title">${input.deliverable === "report" ? "The investigation" : "The plan"}</h2>` +
    (sentence === null ? "" : `<p class="approval-revision">${escape(sentence)}</p>`) +
    (input.coordinator === null ? "" : `<p class="approval-note">An agent filed this: <span class="mono">${escape(input.coordinator.label)}</span>${input.coordinator.filedAgo === null ? "" : `, ${escape(input.coordinator.filedAgo)}`}. Nothing runs until you approve, and approving runs its request.</p>`) +
    (input.deliverable === "report" ? `<p class="approval-note">Read-only: it reports back and changes nothing in the repository.</p>` : "") +
    `<dl class="approval-rows">` +
    row("Goal", `<p class="approval-goal">${escape(goalShown)}</p>`) +
    row("Changes", changes) +
    row("Won’t touch", `<p>${scope.outOfScope === null ? "Nothing is ruled out." : escape(scope.outOfScope)}</p>`) +
    row("Done when", doneWhen) +
    `</dl>` +
    approvalAmendmentHtml(contract) +
    // The size, said once and plainly beside who builds: "Small change: fast model, no plan".
    (projection === null ? "" : sizeLineHtml(projection)) +
    (who.length === 0 ? "" : `<p class="approval-who">${who.map(escape).join(" · ")}</p>`) +
    consent +
    `<div class="approval-act" id="${input.surface === "task" ? "approval-confirm" : "chat-approval-confirm"}">` +
    `<label class="approval-password"><span class="visually-hidden">Your password</span><input type="password" name="token" autocomplete="current-password" placeholder="Your password" aria-describedby="${passwordNote}"></label>` +
    `<p class="approval-password-note" id="${passwordNote}">Your password signs this approval.</p>` +
    `<button type="submit" data-primary-action>${submit}</button></div>` +
    `<p class="approval-after">${after}</p>` +
    `<div class="approval-secondary">${editor ?? `<a class="approval-link" href="${escape(input.editHref)}">Edit plan</a>`}<a class="approval-link" href="${escape(input.notNowHref)}">Not now</a></div>` +
    details +
    `</form>` +
    editorForm
  );
}

/** Earlier versions of a task still in flight, in plain words: queued
 * while they only wait, running once one has started; null when none. */
export function earlierVersionsWords(active: number, running: number): string | null {
  if (active <= 0) return null;
  const still = running >= active ? "running" : running <= 0 ? "queued" : "queued or running";
  return active === 1 ? `an earlier version is still ${still}` : `${active} earlier versions are still ${still}`;
}

/** An in-place plan edit that would change the agent's permissions: thrown to roll the save back. */
export class PermissionsWouldChange extends Error {}

/** Evidence kinds in plain words, for the signed criteria in Details. */
export const EVIDENCE_PLAIN: Record<string, string> = { check: "the project check", screenshot: "screenshots", "changed-path": "changed files", "manual-review": "your own check" };

/** The permission choice a sealed profile carries, as the scope form names it. */
export function permissionModeOfProfile(profile: Scope["profile"] | null | undefined): UnattendedPermissionMode | null {
  if (profile === null || profile === undefined) return null;
  return profile.provider === "claude"
    ? profile.permissionArgv === "bypassPermissions" ? "bypassPermissions" : "auto"
    : profile.provider === "gemini"
      ? profile.approvalArgv === "yolo" ? "bypassPermissions" : "auto"
      : profile.sandboxMode === "danger-full-access" ? "bypassPermissions" : "auto";
}

/** Done when, from the in-place editor: each line keeps its requirement's
 * id by position, and its evidence and guidance while its words stand; a
 * rewritten one is yours to check, like an added one; an emptied one is
 * dropped. */
export function requirementsFromEditor(body: FormView<"requirement" | "requirement-new">, current: readonly AcceptanceCriterion[]): unknown[] {
  const used = new Set(current.map(one => one.id));
  let next = 1;
  while (used.has(`c${next}`)) next++;
  const plain = (raw: string): string => raw.replace(/\s+/g, " ").trim();
  const kept = body.getAll("requirement").slice(0, current.length).flatMap((raw, index) => {
    const statement = plain(raw);
    const criterion = current[index]!;
    if (statement === "") return [];
    return statement === plain(criterion.statement)
      ? [{ id: criterion.id, statement: criterion.statement, evidence: [...criterion.evidence], how: criterion.how }]
      : [{ id: criterion.id, statement, evidence: ["manual-review" as const], how: null }];
  });
  const added = plain(body.get("requirement-new") ?? "");
  return added === "" ? kept : [...kept, { id: `c${next}`, statement: added, evidence: ["manual-review"], how: null }];
}

/**
 * THE CONSENT DOOR (v48): whether a yes can be given on this scope right
 * now — one answer for the task page, the focused chat, and /next, so no
 * surface mints a nonce or shows a password the others would refuse.
 * Closed when the scope cannot say exactly what would run: an unresolved
 * profile, a routed row whose route cannot be read, a route with a stated
 * problem, or a pre-routing row whose old approval no longer stands (its
 * profile alone can no longer be agreed to — re-filing routes it). An
 * approved legacy row never reaches here: its old yes is grandfathered.
 * Every closed answer carries the words and the one road that opens it.
 */
export type ConsentDoor = { open: true } | { open: false; title: string; why: string; road: "scope" | "agents" };

export function consentDoorOf(scope: Scope | null, route: RouteView | null | undefined): ConsentDoor {
  if (scope === null) return { open: false, title: "There is no scope to approve yet", why: "write the scope first", road: "scope" };
  if (scope.profileState === "unresolved") {
    return { open: false, title: "The agent setup isn’t ready yet", why: scope.unresolvedReason ?? "the scope cannot say exactly what would run", road: "scope" };
  }
  // THE SAME STRICT PROJECTION THE SEAL USES (v48 integrity): before any
  // nonce, password field, or approve action renders, the stored scope
  // must prove exactly — exact-key profile, chain, and route; safe and
  // timer-safe numbers; a well-formed auth mode on every chain entry;
  // build/repair parity; the profile as the chain's entry zero; the
  // digest re-derived complete. What the seal would refuse, no surface
  // offers.
  const authority = scopeAuthorityOf(scope, { authMode: provider => readAuthModeStrict(provider) });
  if (!authority.ok) {
    if (authority.reason === "auth-mode") {
      return { open: false, title: "The provider’s auth mode can’t be read", why: `${authority.problem} — restate it, then approve`, road: "agents" };
    }
    if (authority.reason === "unrouted") {
      return { open: false, title: "This scope predates agent routing", why: "its approval no longer stands, and an approval now must name exactly which agent plans, builds, and revises — re-file the scope (edit and save it) to route it under today’s agents, then approve it", road: "scope" };
    }
    return { open: false, title: "The agents on file can’t be read", why: `${authority.problem} — re-file the scope (edit and save it) so it is routed again under today’s agents`, road: "scope" };
  }
  if (route === null || route === undefined) return { open: true };
  if (route.kind === "unreadable") {
    return { open: false, title: "The agents on file can’t be read", why: `${route.problem} — re-file the scope (edit and save it) so it is routed again under today’s agents`, road: "scope" };
  }
  if (route.kind === "legacy") {
    return { open: false, title: "This scope predates agent routing", why: "its approval no longer stands, and an approval now must name exactly which agent plans, builds, and revises — re-file the scope (edit and save it) to route it under today’s agents, then approve it", road: "scope" };
  }
  if (route.projection !== null && route.projection.problems.length > 0) {
    return { open: false, title: "The agents on file can’t run", why: `${route.projection.problems.join("; ")} — change the agents, then approve`, road: "agents" };
  }
  return { open: true };
}

/** The closed door, rendered: no nonce, no password, no approve button —
 * the reason and the one act that opens it. */
export function consentClosedHtml(taskId: string, door: ConsentDoor & { open: false }, surface: "task" | "chat" | "next"): string {
  const href = `${taskHref(taskId)}#${door.road === "agents" ? "agents" : "scope"}`;
  const act = door.road === "agents" ? "Change the agents →" : "Edit and re-file the scope →";
  if (surface === "chat") {
    return `<section class="card chat-action-card consent-closed" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>${escape(door.title)}</h2><p class="meta">${escape(door.why)}</p><a class="button-link" href="${href}">${act}</a></section>`;
  }
  if (surface === "next") {
    return `<div class="card approve-form consent-closed"><p><strong>${escape(door.title)}: approval is closed.</strong></p><p class="meta">${escape(door.why)}</p><p class="ceremony-road"><a class="button-link" href="${href}">${act}</a></p></div>`;
  }
  return `<div class="card approve-form consent-closed" id="approve"><p><strong>This task is waiting on you: ${escape(door.title.toLowerCase())}.</strong></p><p class="meta">${escape(door.why)}</p><p class="ceremony-road"><a class="button-link" href="${href}">${act.toLowerCase()}</a></p></div>`;
}

export function profileWords(scope: Pick<Scope, "profile" | "profileState" | "unresolvedReason" | "digestVersion">): string {
  if (scope.profileState === "unresolved") {
    return `<p class="meta"><strong>Filed but unapprovable</strong> — ${escape(scope.unresolvedReason ?? "the scope cannot say exactly what would run")}. Restate the scope to fix it.</p>`;
  }
  const profile = scope.profile ?? null;
  if (profile === null) {
    return (scope.digestVersion ?? 1) < 2
      ? `<p class="meta">Approved before routing was bound — pinned at upgrade to the configuration of that day</p>`
      : "";
  }
  const repair = profile.repairModel === "inherit" ? "same model" : profile.repairModel;
  const base =
    profile.provider === "claude"
      ? `<p class="meta">Runs on <span class="mono">claude · ${escape(profile.model)}</span> — ${
          profile.permissionArgv === "bypassPermissions"
            ? "FULL permissions; claude runs with --dangerously-skip-permissions and nothing asks"
            : profile.permissionArgv === "auto"
              ? "safe unattended permissions; routine project commands and edits proceed, risky acts stop"
              : "legacy acceptEdits; edits proceed, commands that ask are denied unattended"
        }, stops after ${profile.maxTurns} turns, ${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}; repairs on ${escape(repair)}, ${profile.repairMaxTurns} turns / ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
      : profile.provider === "gemini"
        ? `<p class="meta">Runs on <span class="mono">gemini · ${escape(profile.model)}</span> — ${profile.approvalArgv === "yolo" ? "Full access via --approval-mode yolo; every tool auto-approved" : "Auto via --approval-mode auto_edit; edits auto-approved, other tools refused"}, no turn limit (${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}), spend reported in tokens only; repairs on ${escape(repair)}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
        : `<p class="meta">Runs on <span class="mono">${escape(profile.provider)} · ${escape(profile.model)}</span> — ${profile.sandboxMode === "danger-full-access" ? "FULL permissions via --dangerously-bypass-approvals-and-sandbox; nothing asks" : "workspace-write sandbox"}, no turn limit (${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}); repairs on ${escape(repair)}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`;
  return base;
}

/** The Agents view every console surface renders (v47): the SAME
 * projection the CLI prints — who plans, builds, and revises,
 * whether each was recommended, overridden, or pinned, its reasons, and
 * the readiness the task's runners have reported (ready / unavailable /
 * unknown — an unknown is said, never upgraded). Readiness is volatile and
 * never part of what an approval signs, so the ceremony shows the agents
 * and their reasons only. */
export type RouteView = {
  kind: "route" | "legacy" | "unreadable";
  source: "approved" | "proposed" | "live" | null;
  projection: RouteProjection | null;
  /** A proven pre-routing row: its approved agent profile, nothing more. */
  legacy: { provider: string; model: string; repairModel: string; approved: boolean } | null;
  /** A routed row whose agents cannot be read — fail closed, in words. */
  problem: string | null;
  overrides: RouteOverride[];
  /** An approver may edit: a live claim or a viewer session refuses. */
  editable: boolean;
  editableWhy: string | null;
  /** A planner change after a draft landed asks for a real re-plan. */
  replanOnPlanChange: boolean;
  /** The scope digest the change forms CAS against; null = no scope yet. */
  digest: string | null;
  /** v48: the configured, role-valid agents an approver may choose from —
   * every option an exact pair the operator named once in configuration.
   * The form offers these and nothing else. */
  choices: Record<Phase, AgentChoice[]>;
};

export const ROLE_NOUN: Record<RouteProjection["legs"][number]["phase"], string> = { plan: "Planner", build: "Builder", repair: "Repair", review: "Reviewer" };

export function agentsStandingWords(view: RouteView): string {
  return view.kind === "legacy"
    ? view.legacy?.approved === true ? "approved earlier" : "not approved"
    : view.kind === "unreadable"
      ? "cannot be read"
      : view.source === "approved"
        ? "approved"
        : view.source === "proposed"
          ? "awaiting approval"
          : "recommended";
}

/** The size line an approval leads its agents with — "Small change: fast
 * model, no plan" — and, quietly, why it was sized so. */
export function sizeLineHtml(projection: RouteProjection): string {
  if (projection.sizeWords === null) return "";
  return `<p class="agents-size"><strong>${escape(projection.sizeWords)}.</strong>${projection.sizeReason === null ? "" : ` <span class="meta">${escape(projection.sizeReason)}</span>`}</p>`;
}

/** What a size does, for a proposal card. */
export function sizeConsequence(size: string, risky: boolean): string {
  if (size === "small" && !risky) return "Small change: fast model, no plan";
  if (size === "large" || risky) return `${size === "large" ? "Large" : "Risky"} change: strongest agents plan and build`;
  return "Medium change: everyday agents";
}

/** The one plain-English line: who does what. */
export function agentsSummaryWords(view: RouteView): string {
  if (view.projection !== null) return view.projection.summary;
  if (view.legacy !== null) return `${view.legacy.provider} · ${view.legacy.model} builds and repairs (repair model ${view.legacy.repairModel}); the planner and reviewer come from configuration at run time`;
  return view.problem ?? "the agents cannot be read";
}

/** A risk badge only when there is something to say: a risky change, or an
 * older route sealed at elevated or high risk. */
export function riskBadgeHtml(projection: RouteProjection): string {
  return projection.riskTitle === "Routine" ? "" : `<span class="badge">${escape(sentenceCase(projection.riskTitle))}</span>`;
}

/** Neutral metadata badges: risk (when not routine), posture, and standing. */
export function agentsBadgesHtml(view: RouteView): string {
  const p = view.projection;
  return (
    (p === null ? "" : riskBadgeHtml(p)) +
    (p === null ? "" : `<span class="badge">${escape(sentenceCase(p.postureWords))}</span>`) +
    `<span class="badge">${escape(sentenceCase(agentsStandingWords(view)))}</span>`
  );
}

/** Volatile availability, per provider on the route — shown beside the
 * agents, never inside the approval's terms. */
export function agentsAvailabilityHtml(projection: RouteProjection): string {
  const seen = new Map<string, RouteProjection["legs"][number]>();
  for (const leg of projection.legs) if (!seen.has(leg.provider)) seen.set(leg.provider, leg);
  const items = [...seen.values()].map(leg => {
    const state = leg.readiness === "ready" ? "ready" : leg.readiness === "unavailable" ? "unavailable" : "not yet checked";
    const detail = leg.readiness === "unavailable" && leg.readinessReason !== null ? ` (${escape(leg.readinessReason)})` : "";
    return `<li class="agents-availability-${escape(leg.readiness)}"><span class="mono">${escape(leg.provider)}</span> ${state}${detail}${leg.readinessRunner === null ? "" : ` <span class="meta">— ${escape(leg.readinessRunner)}${leg.observedAt === null ? "" : `, ${whenTime(leg.observedAt)}`}</span>`}</li>`;
  });
  return `<p class="meta agents-availability-label">Availability right now</p><ul class="agents-availability">${items.join("")}</ul>`;
}

/** The closed details: one row per role, with the reasons. */
export function agentsWhyHtml(projection: RouteProjection, summaryLabel = "Why these agents"): string {
  return (
    `<details class="agents-why"><summary>${escape(summaryLabel)}</summary>` +
    (projection.demands.length === 0 ? "" : `<ul class="agents-demands">${projection.demands.map(one => `<li>${escape(one)}</li>`).join("")}</ul>`) +
    `<dl class="agents-roles">` +
    projection.legs
      .map(leg => {
        const chosen = chosenWords(leg);
        return (
          `<dt>${escape(ROLE_NOUN[leg.phase])}</dt>` +
          `<dd><span class="mono">${escape(leg.provider)} · ${escape(leg.model)}</span> <span class="badge">${escape(sentenceCase(chosen))}</span>` +
          `<ul class="agents-reasons">${leg.reasons.map(reason => `<li>${escape(reason)}</li>`).join("")}${leg.problem === null ? "" : `<li><strong>${escape(leg.problem)}</strong></li>`}</ul></dd>`
        );
      })
      .join("") +
    `</dl></details>`
  );
}

/** The ceremony's agents block: what the yes agrees to — the agents and
 * their reasons. Availability is volatile and deliberately absent here. */
export function agentsCeremonyHtml(view: RouteView | null | undefined): string {
  if (view === null || view === undefined) return "";
  if (view.projection === null) {
    // A proven pre-routing approval: its sealed profile is the whole
    // agents term, said in the same place with the same label.
    if (view.legacy !== null) {
      return `<div class="agents-ceremony"><p class="approval-label">agents</p><p class="agents-summary">${escape(agentsSummaryWords(view))}</p></div>`;
    }
    return "";
  }
  return (
    `<div class="agents-ceremony"><p class="approval-label">agents</p>` +
    sizeLineHtml(view.projection) +
    `<p class="agents-summary">${escape(view.projection.summary)}</p>` +
    `<div class="agents-badges">${riskBadgeHtml(view.projection)}<span class="badge">${escape(sentenceCase(view.projection.postureWords))}</span></div>` +
    agentsWhyHtml(view.projection) +
    `<p class="meta">These exact agents are part of what you approve; changing any of them asks for a fresh approval.</p></div>`
  );
}

/** The runtime limits the sealed profile binds — permissions, turn and
 * time bounds, repairs — restated on the ceremony as
 * a CLOSED disclosure (v48): a term the yes covers, one tap away, never a
 * wall of switches between the reader and the password. An unresolved
 * profile still speaks in the open: that is a refusal, not a detail. */
export function runtimeDetailsHtml(scope: Pick<Scope, "profile" | "profileState" | "unresolvedReason" | "digestVersion">): string {
  if (scope.profileState === "unresolved") return profileWords(scope);
  const words = profileWords(scope);
  if (words === "") return "";
  return `<details class="agents-runtime"><summary>Runtime limits</summary>${words}</details>`;
}

/** The task page's Agents card: the summary, availability, closed reasons,
 * and — for an approver — closed change controls. Every change re-files
 * the scope; an approval given under the earlier agents needs renewing. */
export function agentsCardHtml(taskId: string, view: RouteView | null | undefined, csrf: string, canEdit: boolean): string {
  if (view === null || view === undefined) return "";
  const p = view.projection;
  const sawDigest = view.digest ?? "";
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="sawDigest" value="${escape(sawDigest)}">`;
  const overrides =
    view.overrides.length === 0
      ? ""
      : `<ul class="agents-overrides">${view.overrides
          .map(
            one =>
              `<li><span>${escape(ROLE_NOUN[one.phase])} → <span class="mono">${escape(one.provider)} · ${escape(one.model)}</span> <span class="meta">by ${escape(one.by)} ${whenTime(one.at)}</span></span>` +
              (canEdit && view.editable ? `<form method="post" action="${taskHref(taskId)}/route" class="agents-clear">${hidden}<input type="hidden" name="clear-phase" value="${escape(one.phase)}"><button type="submit" class="secondary" aria-label="clear the ${escape(ROLE_NOUN[one.phase].toLowerCase())} choice">Clear</button></form>` : "") +
              `</li>`,
          )
          .join("")}</ul>`;
  // The controls (v48): a size choice that says what each size does, and
  // — per role — ONLY the configured, role-valid agents the operator may
  // pick from. Nothing is typed free-hand, no command line is quoted; the
  // reasons above already say why the current agents were chosen.
  const roleForms = ROUTE_PHASES.filter(phase => phase !== "review").map(phase => {
    // Selectable choices are the role's own configured agents; a current
    // agent the configuration no longer names is DISPLAY-ONLY — said
    // beside the control, never an option the form could re-pick.
    const options = view.choices[phase].filter(one => one.selectable);
    const stale = view.choices[phase].find(one => one.current && !one.selectable) ?? null;
    const staleNote = stale === null ? "" : `<p class="meta agents-stale">Runs today on <span class="mono">${escape(`${stale.provider} · ${stale.model}`)}</span>, which is no longer in your configuration — pick a configured agent to replace it.</p>`;
    if (options.length === 0) {
      return `<div class="agents-role-row"><span class="agents-role-name">${escape(ROLE_NOUN[phase])}</span><p class="meta">No configured agent can take this role for this task.</p>${staleNote}</div>`;
    }
    return (
      `<form method="post" action="${taskHref(taskId)}/route" class="agents-form" aria-label="choose the ${escape(ROLE_NOUN[phase].toLowerCase())}">${hidden}` +
      `<input type="hidden" name="phase" value="${escape(phase)}">` +
      `<label>${escape(ROLE_NOUN[phase])}<select name="agent" aria-label="${escape(ROLE_NOUN[phase].toLowerCase())} agent">` +
      options.map(one => `<option value="${escape(`${one.provider}|${one.model}`)}"${one.current ? " selected" : ""}>${escape(`${one.provider} · ${one.model}`)}${one.current ? " — current" : ""}</option>`).join("") +
      `</select></label><button type="submit" class="secondary">Use</button></form>${staleNote}`
    );
  });
  const change = !canEdit
    ? ""
    : !view.editable
      ? `<p class="meta">${escape(view.editableWhy ?? "the agents cannot change right now")}</p>`
      : `<details class="agents-change"><summary>Change agents</summary>` +
        `<form method="post" action="${taskHref(taskId)}/route" class="agents-form-risk">${hidden}` +
        `<label>Size<select name="size" aria-label="task size">${TASK_SIZES.map(one => `<option value="${one}"${one === (p?.size?.size ?? "medium") ? " selected" : ""}>${escape(sizeConsequence(one, false))}</option>`).join("")}</select></label>` +
        // The hidden "no" says the form showed the box: unticked means not risky; a request without either keeps the flag.
        `<input type="hidden" name="risky" value="no"><label class="agents-risky"><input type="checkbox" name="risky" value="yes"${p?.size?.risky === true ? " checked" : ""}> Risky</label>` +
        `<button type="submit" class="secondary">Set size</button></form>` +
        `<div class="agents-role-forms">${roleForms.join("")}</div>` +
        `<p class="meta">Only agents you have configured are offered; each choice is recorded as you. ${view.replanOnPlanChange ? "Changing the planner asks for a new plan — the drafted one is not relabeled. " : ""}An approval given under the earlier agents needs renewing.</p>` +
        overrides +
        `</details>`;
  return (
    `<section class="card agents-card" id="agents" aria-label="agents">` +
    `<div class="agents-head"><h3>Agents</h3><div class="agents-badges">${agentsBadgesHtml(view)}</div></div>` +
    `<p class="agents-summary">${escape(agentsSummaryWords(view))}</p>` +
    (p === null
      ? view.kind === "unreadable"
        ? `<p class="agents-halted">Nothing runs for this task until its scope is filed again and approved.</p>`
        : ""
      : (p.halted ? `<p class="agents-halted">Paused: a provider these agents need is reported unavailable. Nothing else is used in its place — choose another agent below, or restore the provider and report readiness again.</p>` : "") +
        (p.problems.length === 0 ? "" : `<ul class="agents-problems">${p.problems.map(one => `<li>${escape(one)}</li>`).join("")}</ul>`) +
        agentsAvailabilityHtml(p) +
        agentsWhyHtml(p)) +
    (canEdit || overrides === "" ? change : overrides) +
    `</section>`
  );
}

/** The chat's always-visible strip: the summary and a way to the details. */
export function agentsStripHtml(view: RouteView | null, taskId: string): string {
  if (view === null) return "";
  // A broken setup is not secondary detail: keep its failure visible.
  if (view.kind === "unreadable") return `<p class="task-chat-agents">${escape(agentsSummaryWords(view))} <a href="${taskHref(taskId)}#agents">Review agent setup</a></p>`;
  return `<details class="task-chat-agents"><summary>Agent setup</summary><p>${escape(agentsSummaryWords(view))}</p><a href="${taskHref(taskId)}#agents">View agents</a></details>`;
}

/** The demo's one-line promise, on every page. */
export const DEMO_BANNER = `Demo: a scripted lead and sample projects. Nothing calls a model, reaches outside or spends. For your own project, run ${START_COMMAND} in its folder.`;
/** The demo notice on a phone: one line. */
export const DEMO_BANNER_SHORT = "Demo: sample projects. Nothing calls a model or spends.";

/** Every character that could open a tag or an attribute, dead at the sink. */
export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The Operations Ledger: the design system Alex approved in Figma and the
 * design/ shadcn package, carried as pure CSS on server-rendered HTML.
 * Deliberately not the React library: the console ships zero dependencies
 * and zero page JavaScript under a CSP that forbids scripts, and a look is
 * not worth that posture. The same semantic tokens render both system light
 * and dark themes.
 */
/** The shared palette, light and dark (2026-09-27, "Signal"): neutral grey
 * grounds, ink for every act a person can take, and one chart magenta, the
 * colour nautical charts print lights and cautions in, for what needs a
 * person (the needs-you count, the act that resolves a screen, focus and
 * selection). Status keeps its own four hues; magenta never means "failed".
 * The frame is the ground the sidebar sits on; work sits on paper sheets
 * inset into it. Semantic names only; every surface (server pages, the
 * React workspace, the pre-script fallback) reads these. */
export const THEME_LIGHT = `
    --so-ground: #efefef; --so-paper: #ffffff; --so-sidebar: #efefef; --so-raised: #f5f5f5;
    --so-ink: #171717; --so-muted: #666666; --so-line: #e6e6e6; --so-input-line: #d4d4d4;
    --so-accent: #171717; --so-accent-hover: #383838; --so-accent-text: #171717; --so-on-accent: #ffffff; --so-soft: #f2f2f2;
    --so-nav-ink: #525252; --so-nav-hover: #e4e4e4; --so-nav-current: #ffffff; --so-nav-current-ink: #171717;
    --so-signal: #171717; --so-signal-hover: #383838; --so-on-signal: #ffffff; --so-signal-soft: #e8e8e8;
    --so-danger: #c4320a; --so-danger-soft: #feebe7; --so-success: #218358; --so-success-soft: #e6f6eb;
    --so-warning: #ab6400; --so-warning-soft: #fff4d5; --so-info: #0d74ce; --so-info-soft: #e6f4fe;
    --so-neutral-ink: #525252; --so-neutral-soft: #f0f0f0; --so-live: #0d74ce;
    --so-attention: var(--so-signal); --so-on-attention: var(--so-on-signal); --so-attention-soft: var(--so-signal-soft);
    --so-sheet-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .04), 0 4px 12px -6px rgb(0 0 0 / .06);
    --so-pill-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .06);
    --so-overlay: rgb(0 0 0 / .32); --so-shadow-overlay: 0 0 0 1px rgb(0 0 0 / .08), 0 24px 48px -12px rgb(0 0 0 / .22);
    --so-selection: #d4d4d4; --so-scroll: #cfcfcf; --so-code-bg: #fafafa; --so-user-bubble: #f2f2f2;`;
export const THEME_DARK = `
    --so-ground: #0b0b0b; --so-paper: #161616; --so-sidebar: #0b0b0b; --so-raised: #1c1c1c;
    --so-ink: #ededed; --so-muted: #a1a1a1; --so-line: #262626; --so-input-line: #363636;
    --so-accent: #ededed; --so-accent-hover: #ffffff; --so-accent-text: #ededed; --so-on-accent: #0a0a0a; --so-soft: #1f1f1f;
    --so-nav-ink: #a1a1a1; --so-nav-hover: #171717; --so-nav-current: #1f1f1f; --so-nav-current-ink: #ededed;
    --so-signal: #ededed; --so-signal-hover: #ffffff; --so-on-signal: #0a0a0a; --so-signal-soft: #2e2e2e;
    --so-danger: #ff977d; --so-danger-soft: rgb(255 151 125 / .12); --so-success: #3dd68c; --so-success-soft: rgb(61 214 140 / .12);
    --so-warning: #ffca16; --so-warning-soft: rgb(255 202 22 / .12); --so-info: #70b8ff; --so-info-soft: rgb(112 184 255 / .12);
    --so-neutral-ink: #b4b4b4; --so-neutral-soft: #1f1f1f; --so-live: #70b8ff;
    --so-attention: var(--so-signal); --so-on-attention: var(--so-on-signal); --so-attention-soft: var(--so-signal-soft);
    --so-sheet-shadow: 0 0 0 1px #262626, 0 1px 2px rgb(0 0 0 / .4);
    --so-pill-shadow: 0 0 0 1px #2a2a2a, 0 1px 2px rgb(0 0 0 / .5);
    --so-overlay: rgb(0 0 0 / .6); --so-shadow-overlay: 0 0 0 1px #2e2e2e, 0 24px 48px -12px rgb(0 0 0 / .7);
    --so-selection: #3a3a3a; --so-scroll: #333333; --so-code-bg: #111111; --so-user-bubble: #202020;`;
/** The console's original token names, now views onto the palette. */
export const THEME_MAPPING = `
    --background: var(--so-ground); --foreground: var(--so-ink); --card: var(--so-paper);
    --muted: var(--so-raised); --muted-foreground: var(--so-muted); --border: var(--so-line); --input: var(--so-input-line);
    --primary: var(--so-accent); --primary-foreground: var(--so-on-accent); --secondary: var(--so-raised); --secondary-foreground: var(--so-ink);
    --accent: var(--so-soft); --destructive: var(--so-danger); --destructive-strong: var(--so-danger); --destructive-soft: var(--so-danger-soft);
    --success: var(--so-success); --success-soft: var(--so-success-soft); --warning: var(--so-warning); --warning-soft: var(--so-warning-soft);
    --running: var(--so-info); --running-soft: var(--so-info-soft); --ring: var(--so-signal);
    /* Magenta means one thing: a person is needed (approve, answer, decide). */
    --brand: var(--so-attention); --brand-foreground: var(--so-on-attention); --brand-soft: var(--so-attention-soft);
    --glass: var(--so-paper); --glass-strong: var(--so-paper); --glass-border: var(--so-line); --glass-highlight: transparent;
    --ambient-one: transparent; --ambient-two: transparent; --user-message: var(--so-user-bubble);
    --surface: var(--so-paper); --ok: var(--so-success); --danger: var(--so-danger); --fg-muted: var(--so-muted);
    --shadow: none; --shadow-overlay: var(--so-shadow-overlay);`;

export const STYLE = `
/* The Console — the design system, v4 "Signal" (2026-09-27). A neutral
   frame with paper sheets inset into it (Arc, Linear), compact Raycast
   density, Geist for words and Geist Mono for machine facts. Ink is every
   act a person can take; the accent (ink by default) means "waits on you" and nothing
   else; blue means live. Flat surfaces: hairlines and one soft sheet
   shadow, no glass. Zero dependencies, zero page JS beyond the nonce'd
   chrome layer. */
  @font-face {
    font-family: "Geist"; font-style: normal; font-weight: 400;
    font-display: swap; src: url("/fonts/geist-sans-400.woff2") format("woff2");
  }
  @font-face {
    font-family: "Geist"; font-style: normal; font-weight: 500;
    font-display: swap; src: url("/fonts/geist-sans-500.woff2") format("woff2");
  }
  @font-face {
    font-family: "Geist"; font-style: normal; font-weight: 600;
    font-display: swap; src: url("/fonts/geist-sans-600.woff2") format("woff2");
  }
  @font-face {
    font-family: "Geist Mono"; font-style: normal; font-weight: 400;
    font-display: swap; src: url("/fonts/geist-mono-400.woff2") format("woff2");
  }
  @font-face {
    font-family: "Geist Mono"; font-style: normal; font-weight: 500;
    font-display: swap; src: url("/fonts/geist-mono-500.woff2") format("woff2");
  }
  @font-face {
    font-family: "Geist Mono"; font-style: normal; font-weight: 600;
    font-display: swap; src: url("/fonts/geist-mono-600.woff2") format("woff2");
  }
  /* One palette for every page (2026-09-27): neutral grey and paper with
   * one chart magenta, light by day and dark after hours. The device decides unless
   * the person pins a theme (html[data-theme], set from their cookie). The
   * console's older token names map onto it, so the React workspace, the
   * server-rendered pages and the pre-script fallback all paint the same. */
  :root {
    color-scheme: light;
${THEME_LIGHT}
${THEME_MAPPING}
    --radius: 0.625rem;
    --so-ease-out: cubic-bezier(.23, 1, .32, 1);
    --font-sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: "Geist Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    /* Phone spacing steps (760px and narrower): side gutter, gap under the
       header, gap between page blocks, between rows, and inside a card. */
    --so-phone-gutter: 16px; --so-phone-gap: 12px; --so-phone-block: 14px; --so-phone-row: 8px; --so-phone-card: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
${THEME_DARK}
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
${THEME_DARK}
  }
  * { box-sizing: border-box; }
  /* Touch: no grey flash on a tap, no double-tap zoom wait on a control,
     and a long press never selects a control's label. Text stays selectable. */
  html { -webkit-tap-highlight-color: transparent; }
  a, button, summary, [role=button], [role=tab] { touch-action: manipulation; }
  button, [role=button], [role=tab], .task-context-chip, .approval-chip, .verdict-chip { -webkit-user-select: none; user-select: none; }
  ::selection { background: var(--so-selection); color: var(--so-ink); }
  ::placeholder { color: var(--muted-foreground); }
  body {
    margin: 0; color: var(--foreground);
    background: var(--background);
    caret-color: var(--so-signal);
    font: 400 0.875rem/1.5 var(--font-sans); font-feature-settings: "ss01" 0;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  /* Scrollbars belong to the theme, not the platform default. */
  * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }

  .topbar {
    position: sticky; top: 0; z-index: 10;
    border-bottom: 1px solid var(--border); background: var(--background);
  }
  .topbar-inner {
    max-width: 44rem; margin-inline: auto; padding: 0 1.25rem; height: 3.25rem;
    display: flex; align-items: center; gap: 1.25rem;
  }
  .brand { font-weight: 600; letter-spacing: -0.01em; color: var(--foreground); text-decoration: none;
           display: flex; align-items: center; height: 100%; }
  .brand .dot { color: var(--muted-foreground); }
  .topbar nav { display: flex; gap: .25rem; margin-left: auto; height: 100%; }
  .topbar nav a {
    color: var(--muted-foreground); text-decoration: none; font-size: 0.8125rem; font-weight: 500;
    display: flex; align-items: center; padding: 0 .625rem; transition: color .15s;
  }
  @media (hover: hover) and (pointer: fine) { .topbar nav a:hover { color: var(--foreground); } }
  main { max-width: 44rem; margin-inline: auto; padding: 1.75rem 1.25rem 4rem; }
  h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 .25rem; line-height: 1.3; }
  h1 .meta { font-weight: 400; letter-spacing: 0; }
  /* Section headers speak in the human voice (mono is for machine facts
     only): small, semibold, dim — Linear's "In Progress 5" register. */
  h2 {
    font-size: 0.8125rem; font-weight: 600; letter-spacing: -0.005em;
    color: var(--muted-foreground); margin: 2rem 0 .5rem; font-family: var(--font-sans);
  }
  a { color: var(--foreground); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
  @media (hover: hover) and (pointer: fine) { a:hover { text-decoration-color: var(--muted-foreground); } }
  p { margin: .4rem 0; }
  code { background: var(--muted); border-radius: .3rem; padding: .1rem .35rem; font-family: var(--font-mono); font-size: .8125rem; }
  .mono { font-family: var(--font-mono); font-size: .8125rem; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }

  .meta { font-size: 0.8125rem; color: var(--muted-foreground); }
  .meta a { color: var(--muted-foreground); }
  .hint { font-size: 0.75rem; color: var(--muted-foreground); margin: -.375rem 0 .625rem; }
  .eyebrow {
    display: block; color: var(--muted-foreground); font-size: .625rem;
    font-weight: 500; letter-spacing: .08em; line-height: 1.3; text-transform: uppercase;
    font-family: var(--font-mono);
  }
  .num { font-variant-numeric: tabular-nums; }

  /* Utility classes replacing the old inline style= attributes. */
  .tight { margin-top: 0; }
  .card > h2:first-child, .card > h3:first-child { margin-top: 0; }
  .w-xs { width: 4.5rem; } .w-sm { width: 8rem; } .w-md { width: 12rem; } .w-lg { width: 14rem; }
  .field-cap { width: 100%; max-width: 28rem; }
  .field-cap-sm { width: 100%; max-width: 22rem; }
  .field-cap-lg { width: 100%; max-width: 34rem; }
  .prewrap { white-space: pre-wrap; }
  .wrap-any { overflow-wrap: anywhere; }
  .grab { cursor: grab; user-select: none; }

  .palette {
    position: fixed; top: 18vh; left: 50%; transform: translateX(-50%); width: min(32rem, 90vw);
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow-overlay);
    padding: .625rem; z-index: 50;
  }
  .palette input { width: 100%; margin: 0; }
  .palette ul { list-style: none; margin: .5rem 0 0; padding: 0; max-height: 40vh; overflow-y: auto; }
  .palette li { padding: .4375rem .625rem; border-radius: calc(var(--radius) - 4px); cursor: pointer; font-size: .875rem; }
  .palette li[aria-selected="true"] { background: var(--muted); }

  /* The ledger: the window's harvest as strong figures in a sentence. */
  .ledger { font-size: 0.9375rem; color: var(--muted-foreground); margin: .875rem 0 0; line-height: 1.9; }
  .ledger b { font-weight: 600; font-size: 1.25rem; color: var(--foreground); font-variant-numeric: tabular-nums; padding-right: .1rem; font-family: var(--font-mono); }
  .ledger .good b { color: var(--success); }
  .ledger .bad b { color: var(--destructive); }

  /* Status labels are quiet metadata, not decoration. Their words carry
     the meaning; the restrained tint only speeds scanning. Count badges
     remain round so a number cannot be confused with a state. */
  .badge {
    display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: .375rem;
    padding: .0625rem .4rem; font-size: 0.6875rem; font-weight: 500; line-height: 1.45;
    background: color-mix(in srgb, var(--card) 58%, transparent); color: var(--muted-foreground); vertical-align: middle;
    font-family: var(--font-sans); font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .badge-done, .badge-answered, .badge-verified, .badge-built {
    background: color-mix(in srgb, var(--muted) 58%, var(--card)); color: var(--foreground);
    border-color: var(--border);
  }
  .badge-failed {
    background: color-mix(in srgb, var(--muted) 58%, var(--card));
    color: color-mix(in srgb, var(--destructive) 68%, var(--foreground)); border-color: var(--border);
  }
  .badge-note {
    background: color-mix(in srgb, var(--muted) 58%, var(--card));
    color: var(--so-warning, #ab6400); border-color: var(--border);
  }
  .badge-overdue {
    background: color-mix(in srgb, var(--muted) 58%, var(--card)); color: var(--foreground);
    border-color: var(--border);
  }
  /* The criterion matrix's fourth state (v39): neither a pass nor a
     failure — evidence resolved everywhere except a manual-review kind,
     which by design nothing here can machine-verify. Quieter than
     badge-failed; still visibly distinct from a plain pass. */
  .badge-manual-review {
    background: color-mix(in srgb, var(--muted) 58%, var(--card));
    color: color-mix(in srgb, var(--muted-foreground) 80%, var(--foreground)); border-color: var(--border);
  }
  /* "open" and "parked" are neutral facts (an open PR, a parked decision);
     the MAGENTA form is the attention count — the number that waits on you.
     One accent, two places (reduction pass §3): the needs-you count and
     the act that resolves the screen. Cards, frames, and seals are neutral. */
  .badge-open, .badge-parked { color: var(--foreground); }
  .count {
    min-width: 1.25rem; padding-inline: .35rem; border-radius: 9999px;
  }
  .count.badge-open {
    background: var(--brand-soft); color: var(--brand);
    border-color: color-mix(in srgb, var(--brand) 24%, var(--border));
  }
  .badge-running {
    background: color-mix(in srgb, var(--muted) 58%, var(--card));
    color: color-mix(in srgb, var(--running) 72%, var(--foreground)); border-color: var(--border);
  }
  .badge-cut { background: var(--muted); }

  .card {
    border: 1px solid var(--glass-border); border-radius: var(--radius); background: var(--glass);
    padding: 1rem 1.125rem; margin: .75rem 0;
  }
  .problem {
    border: 1px solid color-mix(in srgb, var(--destructive) 35%, transparent);
    background: var(--destructive-soft); color: var(--destructive);
    border-radius: var(--radius); padding: .625rem .875rem; margin: .75rem 0; font-size: 0.8125rem;
  }
  /* A row is 2.25rem of quiet: hairline below, hover fills, nothing else. */
  .row {
    display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap;
    padding: .5rem .375rem; min-height: 2.25rem; border-bottom: 1px solid var(--border);
    margin: 0; border-radius: calc(var(--radius) - 4px);
  }
  .row:last-of-type { border-bottom: none; }
  .row .right { margin-left: auto; }
  a.row { text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { a.row:hover { background: var(--muted); } }

  /* A parked decision: the question in full weight, the whole card the
     tap target, the neutral border — the "needs you" header above it
     carries the colour for every card beneath. */
  .decide-card {
    display: block; border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card); padding: .875rem 1.125rem; margin: .625rem 0;
    text-decoration: none; transition: border-color .15s;
  }
  @media (hover: hover) and (pointer: fine) { .decide-card:hover { border-color: color-mix(in srgb, var(--border) 55%, var(--muted-foreground)); } }
  .decide-card .q { font-weight: 600; margin: 0 0 .25rem; }

  /* Buttons: secondary by default (paper + hairline); a form's one
     submit is primary (ink on paper, paper on ink); the approve act is
     the accent; danger is red and outlined. 2.125rem at a desk, 2.75rem to a thumb. */
  button {
    font: 500 0.8125rem/1.4 var(--font-sans); cursor: pointer; border-radius: calc(var(--radius) - 3px);
    border: 1px solid var(--input); background: var(--card); color: var(--foreground);
    padding: .35rem .75rem; min-height: 2.125rem;
    transition: background .12s var(--so-ease-out), border-color .12s var(--so-ease-out), color .12s var(--so-ease-out);
  }
  @media (hover: hover) and (pointer: fine) { button:hover { background: var(--so-soft); } }
  button:active { background: var(--so-nav-hover); }
  form.card > button[type=submit], .sticky-actions button[type=submit], form.card .sticky-actions button {
    background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600;
  }
  @media (hover: hover) and (pointer: fine) { form.card > button[type=submit]:hover, .sticky-actions button[type=submit]:hover {
    background: color-mix(in srgb, var(--primary) 85%, var(--background)); border-color: color-mix(in srgb, var(--primary) 85%, var(--background));
  } }
  /* The approve act is the one magenta verb: it resolves what waits on you.
     The ceremony's frame is neutral so the button is the only coloured thing
     in it; a danger act stays red even inside one. */
  .approve-form button[type=submit], .approve-form .sticky-actions button[type=submit] {
    background: var(--brand); color: var(--brand-foreground); border-color: var(--brand); font-weight: 600;
  }
  @media (hover: hover) and (pointer: fine) { .approve-form button[type=submit]:hover, .approve-form .sticky-actions button[type=submit]:hover { background: color-mix(in srgb, var(--brand) 85%, var(--foreground)); border-color: color-mix(in srgb, var(--brand) 85%, var(--foreground)); } }
  button.danger, .approve-form button[type=submit].danger {
    color: var(--destructive); border-color: color-mix(in srgb, var(--destructive) 50%, transparent);
    background: transparent; font-weight: 500;
  }
  @media (hover: hover) and (pointer: fine) { button.danger:hover, .approve-form button[type=submit].danger:hover { background: var(--destructive-soft); } }
  /* Removing a credential takes a second, deliberate tap. */
  details.confirm-remove { display: inline-block; margin: 0 0 0 .5rem; vertical-align: top; }
  details.confirm-remove > summary { cursor: pointer; color: var(--destructive); font-size: .8125rem; min-height: 2.5rem; display: inline-flex; align-items: center; }
  details.confirm-remove[open] { display: block; margin: .75rem 0 0; }
  .project-card .project-name:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: .375rem; }

  label { display: block; font-size: 0.8125rem; font-weight: 500; margin: .75rem 0 0; color: var(--foreground); }
  input[type=text], input[type=password], input[type=number], input[type=url], input[type=email], input[type=search], input[type=time], textarea, select {
    width: 100%; margin: .35rem 0 0; padding: .45rem .7rem; font: 400 0.875rem/1.4 var(--font-sans);
    color: var(--foreground); background: var(--card); min-height: 2.125rem;
    border: 1px solid var(--input); border-radius: calc(var(--radius) - 3px);
    transition: border-color .15s, box-shadow .15s;
  }
  @media (hover: hover) and (pointer: fine) { input:hover, textarea:hover, select:hover { border-color: var(--muted-foreground); } }
  input[type=number] { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  input[type=radio], input[type=checkbox] { accent-color: var(--ring); }
  .permission-field { border: 0; padding: 0; margin: 1rem 0 0; min-width: 0; }
  .permission-field legend { padding: 0; font-size: .8125rem; font-weight: 600; }
  .permission-toggle { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; margin-top: .5rem; }
  .permission-choice {
    display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .6rem; align-items: start;
    margin: 0; padding: .72rem .78rem; border: 1px solid var(--glass-border);
    border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--card) 66%, transparent);
    cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s;
  }
  @media (hover: hover) and (pointer: fine) { .permission-choice:hover { background: var(--muted); } }
  .permission-choice:has(input:checked) {
    border-color: color-mix(in srgb, var(--foreground) 42%, var(--border));
    background: var(--card); box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent), var(--shadow);
  }
  .permission-choice input { margin: .14rem 0 0; }
  .permission-choice strong, .permission-choice small { display: block; }
  .permission-choice strong { font-size: .8125rem; }
  .permission-choice small { margin-top: .16rem; color: var(--muted-foreground); font-size: .8125rem; font-weight: 400; line-height: 1.4; }
  .permission-note { margin: .55rem 0 0; }
  .scope-editor .permission-toggle { grid-template-columns: 1fr; }
  .scope-editor .problem { color: var(--foreground); }
  /* New work starts like a conversation, not a configuration sheet. The
     planner turns the one intent into the detailed, signed contract; these
     controls expose the uncommon overrides without making them the door. */
  main:has(.task-intake) { max-width: 68rem; }
  .task-intake { width: min(100%, 50rem); margin: clamp(1rem, 5vh, 4rem) auto 0; }
  .task-intake-hero { text-align: center; margin: 0 auto 1.35rem; max-width: 38rem; }
  .task-intake-mark {
    display: grid; place-items: center; width: 3rem; height: 3rem; margin: 0 auto .85rem;
    border: 1px solid var(--border); border-radius: .75rem;
    background: var(--card); box-shadow: var(--so-pill-shadow);
    font: 600 .72rem/1 var(--font-mono); letter-spacing: -.05em;
  }
  .task-intake-hero h1 { margin: 0; font-size: clamp(1.65rem, 4vw, 2.2rem); letter-spacing: -.045em; }
  .task-intake-hero p { margin: .45rem 0 0; color: var(--muted-foreground); }
  .task-composer { padding: .75rem; border-radius: 1.45rem; box-shadow: var(--shadow-overlay); }
  .task-prompt { margin: 0; font-size: 0; }
  .task-prompt textarea {
    min-height: 8.5rem; max-height: 18rem; margin: 0; padding: .9rem 1rem; resize: vertical;
    border: 0; background: transparent; box-shadow: none; font-size: 1.05rem; line-height: 1.55;
  }
  .task-prompt textarea:focus-visible { border: 0; box-shadow: none; }
  @media (hover: hover) and (pointer: fine) { .task-prompt textarea:hover { border: 0; box-shadow: none; } }
  .task-repo { margin: .25rem .45rem .7rem; }
  .task-composer-footer { display: flex; align-items: center; gap: .5rem; padding: .25rem; }
  .task-context { display: flex; align-items: center; gap: .4rem; flex: 1 1 auto; min-width: 0; }
  .task-context-chip {
    display: inline-flex; align-items: center; min-height: 2rem; max-width: 13rem; padding: .25rem .65rem;
    border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground);
    background: color-mix(in srgb, var(--glass) 76%, transparent); font-size: .72rem; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .task-quality { margin: 0; flex: none; font-size: 0; }
  .task-quality select {
    width: auto; min-height: 2rem; margin: 0; padding: .25rem 1.75rem .25rem .65rem;
    border-radius: 999px; color: var(--muted-foreground); font-size: .72rem; background-color: var(--glass);
  }
  .task-submit {
    flex: none; min-height: 2.45rem; padding: .45rem .95rem; border-radius: 999px;
    background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600;
  }
  @media (hover: hover) and (pointer: fine) { .task-submit:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); border-color: transparent; } }
  details.task-options {
    margin: .65rem .25rem 0; padding: .15rem .5rem 0; border: 0; border-top: 1px solid var(--glass-border);
    border-radius: 0; background: transparent;
  }
  details.task-options[open] { padding-bottom: .25rem; }
  .task-options > summary { display: flex; align-items: center; gap: .5rem; list-style: none; }
  .task-options > summary::-webkit-details-marker { display: none; }
  .task-options > summary::after {
    content: ""; width: .4rem; height: .4rem; margin-left: auto; margin-right: .25rem;
    border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
    transform: rotate(45deg) translateY(-.1rem); transition: transform .15s;
  }
  .task-options[open] > summary::after { transform: rotate(225deg) translateY(-.1rem); }
  .task-options > summary small { color: var(--muted-foreground); font-weight: 400; }
  .task-options-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 .8rem; padding: 0 .25rem .5rem; }
  .task-options-grid .wide, .task-options-grid .permission-field { grid-column: 1 / -1; }
  .task-check { display: flex; gap: .55rem; align-items: flex-start; }
  .task-check input { margin-top: .2rem; }
  .task-check > span { display: grid; gap: .1rem; }
  .task-check small { display: block; font-weight: 400; line-height: 1.45; }
  .task-agent-note { text-align: center; max-width: 42rem; margin: .85rem auto 0; }
  .visually-hidden {
    position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important;
    margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important;
    white-space: nowrap !important; border: 0 !important;
  }
  input[type=password] { font-family: var(--font-mono); }
  input:focus-visible, textarea:focus-visible, select:focus-visible {
    outline: none; border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 25%, transparent);
  }
  button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  .inline { display: inline-block; width: auto; margin: 0 .375rem .375rem 0; vertical-align: middle; }
  .assistant-picker .button-link[aria-current=page] { outline: 2px solid var(--ring); outline-offset: 2px; }
  .inline input[type=text] { display: inline-block; width: auto; margin: 0 .375rem 0 0; vertical-align: middle; }
  .inline button { width: auto; }

  /* One option = one container: consequence first, then the act. */
  form.option {
    margin: .75rem 0; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card); padding: .875rem 1rem;
  }
  form.option button {
    display: block; width: 100%; text-align: left; font-size: 0.9375rem; font-weight: 600;
    min-height: 2.75rem;
  }
  /* Recommended is a suggestion, not attention: neutral emphasis, no magenta. */
  form.option.recommended { border-color: color-mix(in srgb, var(--foreground) 30%, var(--border)); }
  form.option.recommended .badge { background: var(--muted); color: var(--foreground); }
  .consequence { font-size: 0.8125rem; color: var(--muted-foreground); margin: 0 0 .625rem; white-space: pre-wrap; }
  form.option input[type=text] { font-size: 0.8125rem; margin-top: .5rem; min-height: 2.25rem; }

  .recap { color: var(--muted-foreground); margin: .75rem 0; white-space: pre-wrap; }
  #scope .recap, #scope .scope-paths, .approval-goal { overflow-wrap: anywhere; }
  .result-card {
    margin: 1.25rem 0; border-color: color-mix(in srgb, var(--success) 32%, var(--glass-border));
    background: var(--card);
    box-shadow: var(--shadow-card);
  }
  .result-card h2 { margin: 0; }
  .completion-receipt {
    position: relative; overflow: hidden; margin: 1rem 0 1.25rem; padding: 1.15rem;
    border-color: color-mix(in srgb, var(--foreground) 13%, var(--glass-border));
    background: var(--card);
    box-shadow: var(--shadow-card);
  }
  .completion-receipt::after {
    content: ""; position: absolute; width: 11rem; height: 11rem; right: -5rem; top: -7rem;
    border-radius: 50%; background: color-mix(in srgb, var(--running) 9%, transparent); filter: blur(4px); pointer-events: none;
  }
  .receipt-head { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
  .receipt-head h2 { margin: .15rem 0 0; font-size: 1.15rem; }
  /* The receipt's status line is the shared component (.status-line);
     the head keeps it from wrapping under the heading. */
  .receipt-head .status-line { flex: none; font-size: .8125rem; }
  .receipt-summary { position: relative; z-index: 1; max-width: 43rem; margin: .75rem 0 1rem; font-size: 1rem; line-height: 1.55; }
  .receipt-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .55rem; }
  .receipt-facts > span { min-width: 0; padding: .7rem .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--glass-strong) 64%, transparent); }
  .receipt-facts strong, .receipt-facts small { display: block; overflow-wrap: anywhere; }
  .receipt-facts strong { font-size: .78rem; font-weight: 600; }
  .receipt-facts small { margin-top: .18rem; color: var(--muted-foreground); font-size: .75rem; line-height: 1.4; }
  /* Thumbnails, never a full-width poster: auto-fill leaves a lone
     screenshot at thumbnail size (UI polish 2026-09-13). */
  .receipt-visuals { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 14rem)); gap: .55rem; margin-top: .75rem; }
  .receipt-shot { display: grid; gap: .35rem; color: var(--muted-foreground); font-size: .75rem; text-decoration: none; }
  .receipt-shot img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: var(--muted); }
  @media (hover: hover) and (pointer: fine) { .receipt-shot:hover { color: var(--foreground); } }
  .report-items ol { margin: .35rem 0 .75rem; padding-left: 1.25rem; display: grid; gap: .75rem; }
  .report-items li p { margin: .15rem 0; }
  .report-link { overflow-wrap: anywhere; }
  .receipt-caveats, .receipt-coverage { margin-top: .8rem; padding: .7rem .8rem; border-left: 1px solid var(--border); border-radius: 0 calc(var(--radius) - 3px) calc(var(--radius) - 3px) 0; background: color-mix(in srgb, var(--muted) 62%, transparent); font-size: .78rem; }
  .receipt-caveats ul, .receipt-coverage ul { margin: .3rem 0 0; padding-left: 1.15rem; }
  /* Secondary receipt detail (concise pass, 2026-09-13): native
     disclosures in the receipt's own quiet tone — no card chrome. */
  details.receipt-coverage, details.receipt-coverage[open] { padding: 0 .8rem .1rem; border-top: 0; border-right: 0; border-bottom: 0; }
  details.receipt-coverage > summary { padding: .5rem 0; font-weight: 600; color: var(--foreground); font-size: .78rem; }
  details.receipt-coverage[open] > summary { padding-bottom: .2rem; }
  details.receipt-coverage ul { margin: 0 0 .5rem; }
  .receipt-history, .receipt-history[open] { margin: .35rem 0 0; padding: 0; border: 0; background: none; border-radius: 0; }
  .receipt-history > summary { padding: .35rem 0; min-height: 2.25rem; display: inline-flex; align-items: center; gap: .25rem; font-size: .8125rem; list-style: none; }
  .receipt-history > summary::-webkit-details-marker { display: none; }
  .receipt-history > summary::before { content: "▸"; }
  .receipt-history[open] > summary::before { content: "▾"; }
  .receipt-history .receipt-review { margin: 0 0 .35rem; }
  .semantic-coverage p { margin: .2rem 0; }
  .receipt-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem 1rem; margin-top: .9rem; }
  .receipt-actions > a:not(.button-link) { font-size: .78rem; font-weight: 550; }
  /* The review cockpit (Priority 5): a master/detail over completed work.
     The queue is a ranked list, the detail one scan path — intent, proof,
     changes, publication — and the primary act sits under the header. */
  main:has(.cockpit) { max-width: 82rem; }
  .cockpit { display: grid; grid-template-columns: minmax(15rem, 19rem) minmax(0, 1fr); gap: 0 1.5rem; align-items: start; }
  .cockpit-queue { position: sticky; top: 1rem; min-width: 0; }
  .cockpit-queue h2 { display: flex; align-items: center; gap: .4rem; margin: 0 0 .25rem; }
  .cockpit-queue .lane-count { border: 1px solid var(--border); border-radius: 999px; padding: .04rem .5rem; font-weight: 500; color: var(--muted-foreground); font-size: .6875rem; }
  .cockpit-queue-hint { margin: 0 0 .6rem; font-size: .7rem; line-height: 1.4; }
  .cockpit-queue-list { list-style: none; margin: 0; padding: 0; max-height: calc(100vh - 9rem); overflow-y: auto; }
  .cockpit-row {
    display: grid; gap: .2rem; padding: .55rem .65rem; margin-bottom: .2rem; min-width: 0;
    border: 1px solid transparent; border-radius: calc(var(--radius) - 3px); text-decoration: none; color: var(--foreground);
  }
  @media (hover: hover) and (pointer: fine) { .cockpit-row:hover { background: var(--card); } }
  .cockpit-row.current { background: var(--muted); border-color: color-mix(in srgb, var(--foreground) 12%, var(--border)); }
  .cockpit-row-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; min-width: 0; }
  .cockpit-row-head strong { min-width: 0; overflow-wrap: anywhere; font-size: .8125rem; font-weight: 550; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .cockpit-row-meta { display: block; color: var(--muted-foreground); font-size: .68rem; overflow-wrap: anywhere; }
  .cockpit-why { display: block; color: var(--muted-foreground); font-size: .7rem; line-height: 1.35; overflow-wrap: anywhere; }
  .refusal-back a { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; }
  .cockpit-primary { margin: .85rem 0 1rem; }
  .cockpit-primary .button-link { white-space: nowrap; }
  .cockpit-detail { min-width: 0; }
  .cockpit-head h1 { margin: .2rem 0 .55rem; color: var(--foreground); font-size: clamp(1.2rem, 2vw, 1.45rem); font-weight: 600; line-height: 1.3; letter-spacing: -.025em; overflow-wrap: anywhere; }
  .cockpit-chips { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .75rem; margin: 0 0 .35rem; }
  .cockpit-next { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: .85rem 0 1rem; padding: .85rem 1rem;
    border-color: var(--glass-border); background: var(--glass-strong); }
  .cockpit-next > div { display: grid; gap: .2rem; min-width: 0; overflow-wrap: anywhere; }
  .cockpit-next .meta { font-size: .78rem; line-height: 1.45; }
  .cockpit-next form { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 0; }
  .cockpit-next form input[type=text] { min-width: 9rem; margin: 0; }
  .cockpit-next .button-link, .cockpit-next button[type=submit] { white-space: nowrap; }
  .cockpit-section { margin: .85rem 0; padding: .95rem 1.05rem; }
  .cockpit-section h3 { margin: 0 0 .5rem; font-size: .8rem; letter-spacing: .02em; text-transform: uppercase; color: var(--muted-foreground); }
  .cockpit-section .recap { margin: .35rem 0; }
  .cockpit-section .result-section { margin-top: .6rem; }
  .cockpit-section .result-section ul, .cockpit-section ul { margin: .25rem 0 0; padding-left: 1.15rem; }
  .cockpit-section li { overflow-wrap: anywhere; }
  .cockpit-drift { margin: .6rem 0; font-size: .8rem; }
  .cockpit-files { margin: .4rem 0 .6rem; padding-left: 1.25rem; font-size: .78rem; }
  .cockpit-files li { margin: .2rem 0; }
  .cockpit-files .pick-file { min-height: 1.75rem; padding: 0 .55rem; font-size: .75rem; }
  .cockpit-section .diff-review { margin-top: .6rem; }
  .cockpit-section .receipt-visuals { margin-top: .6rem; grid-template-columns: repeat(auto-fill, minmax(9rem, 14rem)); }
  .cockpit-disclosure { padding: 0; overflow: hidden; }
  .cockpit-disclosure > summary {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 4rem;
    padding: .85rem 1.05rem; list-style: none; cursor: pointer;
  }
  .cockpit-disclosure > summary::-webkit-details-marker { display: none; }
  .cockpit-disclosure > summary > h3 { display: grid; gap: .12rem; min-width: 0; margin: 0; font-size: .82rem; }
  .cockpit-disclosure > summary small { color: var(--muted-foreground); font-size: .72rem; font-weight: 400; }
  .cockpit-disclosure-action { color: var(--muted-foreground); font-size: .72rem; white-space: nowrap; }
  .cockpit-disclosure-action::after { content: "↓"; margin-left: .35rem; }
  .cockpit-disclosure[open] .cockpit-disclosure-action::after { content: "↑"; }
  .cockpit-disclosure-body { padding: 0 1.05rem .95rem; border-top: 1px solid var(--glass-border); }
  .cockpit-proof-group { margin: .65rem 0; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--glass-strong) 62%, transparent); }
  .cockpit-proof-group > summary { padding: .65rem .75rem; cursor: pointer; font-weight: 550; }
  .cockpit-proof-group .criterion-matrix { padding: 0 .75rem .7rem; }
  .cockpit-proof-summary { display: grid; gap: .25rem; margin: .15rem 0 .75rem; line-height: 1.45; }
  .cockpit-proof-summary strong { font-size: .88rem; }
  .cockpit-evidence-group { margin: .65rem 0 0; scroll-margin-top: 6rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); overflow: hidden; }
  .cockpit-evidence-group > summary { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .75rem; cursor: pointer; list-style: none; font-weight: 550; }
  .cockpit-evidence-group > summary::-webkit-details-marker { display: none; }
  .cockpit-evidence-group > summary > span { flex: none; white-space: nowrap; }
  .cockpit-evidence-group > summary small { min-width: 0; color: var(--muted-foreground); font-size: .7rem; font-weight: 400; text-align: right; }
  .cockpit-evidence-group [data-primary-evidence] { scroll-margin-top: 6rem; }
  .cockpit-evidence-body { padding: 0 .75rem .75rem; border-top: 1px solid var(--glass-border); }
  .cockpit-accept { margin-top: .65rem; padding-top: .65rem; border-top: 1px solid var(--glass-border); }
  .cockpit-accept > summary { cursor: pointer; font-size: .78rem; font-weight: 600; }
  .cockpit-accept[open] > summary { margin-bottom: .55rem; }
  .cockpit-accept p { margin: 0 0 .55rem; }
  .cockpit-accept-form { display: flex; gap: .5rem; margin: 0; }
  .cockpit-accept-form input { margin: 0; min-width: 10rem; }
  .cockpit-accept-form button { flex: none; background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  .diff-review {
    overflow: hidden; margin: .8rem 0 .5rem; border: 1px solid var(--glass-border);
    border-radius: var(--radius); background: color-mix(in srgb, var(--card) 82%, transparent);
    
  }
  .diff-review-bar {
    display: flex; align-items: center; justify-content: space-between; gap: .75rem;
    min-height: 2.8rem; padding: .4rem .55rem .4rem .85rem;
    border-bottom: 1px solid var(--glass-border); background: color-mix(in srgb, var(--glass-strong) 68%, transparent);
  }
  .diff-modes { display: inline-flex; padding: .18rem; border: 1px solid var(--glass-border); border-radius: 999px; background: var(--muted); }
  .diff-modes button {
    min-height: 1.75rem; padding: .2rem .7rem; border: 0; border-radius: 999px;
    background: transparent; box-shadow: none; color: var(--muted-foreground); font-size: .7rem;
  }
  @media (hover: hover) and (pointer: fine) { .diff-modes button:hover { transform: none; color: var(--foreground); } }
  .diff-modes button[aria-pressed="true"] { background: var(--card); color: var(--foreground); box-shadow: 0 1px 3px color-mix(in srgb, var(--background) 20%, transparent); }
  .diff-review-help {
    margin: 0; padding: .62rem .85rem; border-bottom: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--running) 7%, transparent); color: var(--muted-foreground); font-size: .75rem;
  }
  .diff-review[data-mode="view"] .diff-review-help { display: none; }
  .diff-file { margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  .diff-file + .diff-file { border-top: 1px solid var(--glass-border); }
  .diff-file[open] { padding-bottom: 0; }
  .diff-file > summary {
    display: flex; align-items: center; gap: .7rem; min-height: 2.75rem; padding: .45rem .85rem;
    list-style: none; color: var(--foreground); background: color-mix(in srgb, var(--glass) 55%, transparent);
  }
  .diff-file > summary::-webkit-details-marker { display: none; }
  .diff-file > summary::before {
    content: ""; flex: none; width: .35rem; height: .35rem;
    border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
    transform: rotate(-45deg); transition: transform .15s ease;
  }
  .diff-file[open] > summary::before { transform: rotate(45deg) translateY(-.1rem); }
  .diff-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 .75rem/1.4 var(--font-mono); }
  .diff-file-counts { display: inline-flex; gap: .45rem; flex: none; margin-left: auto; font: 500 .75rem/1 var(--font-mono); }
  .diff-file-counts b { color: var(--success); font-weight: 500; }
  .diff-file-counts i { color: var(--destructive); font-style: normal; }
  .diff-rename { margin: 0; padding: .4rem .85rem; border-top: 1px solid var(--glass-border); }
  .diff-hunk + .diff-hunk { border-top: 1px solid var(--glass-border); }
  .diff-hunk-head {
    overflow-x: auto; padding: .42rem .85rem; border-top: 1px solid var(--glass-border); border-bottom: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--running) 8%, var(--card)); color: color-mix(in srgb, var(--running) 72%, var(--foreground));
    font: 500 .75rem/1.4 var(--font-mono); white-space: pre;
  }
  .diff-lines { max-width: 100%; overflow-x: auto; background: color-mix(in srgb, var(--background) 48%, var(--card)); }
  .diff-line {
    display: grid; grid-template-columns: 2rem 3.2rem 3.2rem minmax(max-content, 1fr); align-items: stretch;
    min-width: max-content; min-height: 1.8rem; font: 400 .75rem/1.55 var(--font-mono);
  }
  @media (hover: hover) and (pointer: fine) { .diff-line:hover { background: color-mix(in srgb, var(--foreground) 4%, transparent); } }
  .diff-line code { display: flex; min-width: 0; padding: .3rem .75rem .3rem .6rem; color: inherit; white-space: pre; }
  .diff-line code b { display: inline-block; width: 1rem; flex: none; font-weight: 500; opacity: .72; }
  .diff-gutter {
    display: flex; align-items: flex-start; justify-content: flex-end; min-width: 0; padding: .3rem .45rem;
    border-right: 1px solid color-mix(in srgb, var(--border) 72%, transparent); color: var(--muted-foreground); user-select: none;
  }
  .diff-addition { background: color-mix(in srgb, var(--success) 10%, transparent); color: color-mix(in srgb, var(--success) 38%, var(--foreground)); }
  .diff-deletion { background: color-mix(in srgb, var(--destructive) 9%, transparent); color: color-mix(in srgb, var(--destructive) 38%, var(--foreground)); }
  .diff-meta { color: var(--muted-foreground); }
  .diff-annotate, .diff-annotate-space {
    position: sticky; left: 0; z-index: 1; display: grid; place-items: center; width: 2rem; min-width: 2rem; min-height: 1.8rem;
    border: 0; border-right: 1px solid color-mix(in srgb, var(--border) 72%, transparent); border-radius: 0;
  }
  .diff-annotate { padding: 0; background: color-mix(in srgb, var(--card) 94%, transparent); color: var(--muted-foreground); box-shadow: none; opacity: .35; }
  .diff-annotate svg { width: .78rem; height: .78rem; }
  @media (hover: hover) and (pointer: fine) { .diff-annotate:hover { transform: none; background: color-mix(in srgb, var(--running) 15%, var(--card)); color: var(--running); opacity: 1; } }
  .diff-annotate-space { background: color-mix(in srgb, var(--card) 94%, transparent); }
  .diff-review[data-mode="view"] .diff-line { grid-template-columns: 0 3.2rem 3.2rem minmax(max-content, 1fr); }
  .diff-review[data-mode="view"] .diff-annotate,
  .diff-review[data-mode="view"] .diff-annotate-space { visibility: hidden; width: 0; min-width: 0; overflow: hidden; border: 0; pointer-events: none; }
  .diff-review[data-mode="annotate"] .diff-annotate { opacity: .72; }
  .diff-cut { margin: 0; padding: .65rem .85rem; border-top: 1px solid var(--glass-border); color: var(--warning); font-size: .75rem; }
  .diff-comments { display: grid; gap: .5rem; margin: .7rem 0; }
  .diff-comment {
    position: relative; padding: .7rem .8rem .7rem 1rem; border: 1px solid var(--glass-border);
    border-radius: calc(var(--radius) - 2px); background: color-mix(in srgb, var(--glass) 76%, transparent);
  }
  .diff-comment-pin { position: absolute; left: -.2rem; top: .75rem; width: .38rem; height: 1.2rem; border-radius: 999px; background: var(--running); }
  .diff-comment p { margin: 0 0 .25rem; overflow-wrap: anywhere; }
  .diff-comment .meta { font-size: .68rem; }
  .diff-comment-form { display: grid; gap: .65rem; margin: .75rem 0; padding: .85rem; }
  .diff-comment-target { display: grid; grid-template-columns: minmax(0, 1fr) 5.5rem; gap: .6rem; }
  .diff-comment-form label { margin: 0; color: var(--muted-foreground); font-size: .68rem; font-weight: 550; }
  .diff-comment-form input, .diff-comment-form textarea { margin-top: .28rem; }
  .diff-comment-form button { justify-self: start; }
  .diff-comment-limit { margin-top: -.35rem; font-size: .66rem; font-variant-numeric: tabular-nums; }
  .revision-from-comments {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    margin: .75rem 0; padding: .85rem; border-color: color-mix(in srgb, var(--running) 24%, var(--glass-border));
    background: var(--card);
  }
  .revision-from-comments > div { display: grid; gap: .15rem; }
  .revision-from-comments > div > span { display: block; }
  .revision-from-comments button { flex: none; }
  .result-section { margin-top: .875rem; }
  .result-section > strong {
    display: block; font: 600 .6875rem/1.3 var(--font-mono); color: var(--muted-foreground);
    letter-spacing: .06em; text-transform: uppercase;
  }
  .result-section ul { margin: .375rem 0 0; padding-left: 1.25rem; }
  .result-section li { margin: .25rem 0; }
  .criterion-matrix .requirement-list { list-style: none; margin: .4rem 0 0; padding: 0; }
  .criterion-matrix .requirement { margin: 0; padding: 1rem 0; border-bottom: 1px solid var(--border); min-width: 0; overflow-wrap: anywhere; }
  .criterion-matrix .requirement:last-child { border-bottom: 0; }
  .requirement-heading { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem .75rem; font-size: .75rem; color: var(--muted-foreground); }
  .requirement-heading .badge { margin: 0; white-space: normal; }
  .requirement-statement { margin: .5rem 0; line-height: 1.55; white-space: pre-wrap; }
  .requirement-review { margin: .4rem 0; font-size: .78rem; color: var(--muted-foreground); }
  .requirement-warning { margin: .65rem 0; padding: .6rem .75rem; border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border)); border-radius: 8px; background: var(--warning-soft); font-size: .8125rem; }
  .requirement-warning strong { font-size: .78rem; }
  .requirement-warning p { margin: .3rem 0 0; }
  .requirement-issues { font-size: .8125rem; }
  .criterion-matrix .requirement-evidence { margin: .35rem 0 0; padding: 0; border: 0; border-radius: 0; background: none; }
  .requirement-evidence > summary { display: flex; align-items: center; gap: .5rem; min-height: 44px; width: fit-content; padding: .35rem .1rem; cursor: pointer; list-style: none; font-size: .8125rem; }
  .requirement-evidence > summary::-webkit-details-marker { display: none; }
  .requirement-evidence > summary::after { content: "+"; color: var(--muted-foreground); }
  .requirement-evidence[open] > summary::after { content: "−"; }
  .requirement-evidence-body { padding: .25rem .75rem .65rem; border-left: 1px solid var(--border); }
  .requirement-evidence-body p { margin: .35rem 0; }
  .requirement-evidence-group { margin: .7rem 0; }
  .requirement-evidence-group > strong { font-size: .75rem; color: var(--muted-foreground); }
  .requirement-evidence-group code { white-space: normal; overflow-wrap: anywhere; font-size: .75rem; }
  .requirement-evidence-group a { display: inline-block; padding: .4rem 0; }
  .question { font-size: 1.125rem; font-weight: 600; letter-spacing: -0.01em; margin: 1rem 0; white-space: pre-wrap; }
  .answered {
    border: 1px solid color-mix(in srgb, var(--success) 35%, transparent); background: var(--success-soft);
    border-radius: var(--radius); padding: .875rem 1rem; margin: 1rem 0;
  }
  details {
    margin: .75rem 0; border: 1px solid var(--border); border-radius: var(--radius);
    padding: .25rem .875rem; background: var(--card);
  }
  details[open] { padding-bottom: .875rem; }
  details.arm-danger { border-color: color-mix(in srgb, var(--destructive) 30%, transparent); }
  summary { padding: .5rem 0; cursor: pointer; font-weight: 500; font-size: 0.8125rem; color: var(--muted-foreground); min-height: 2.25rem; }
  @media (hover: hover) and (pointer: fine) { summary:hover { color: var(--foreground); } }
  details form.option { border: none; padding: .25rem 0 0; margin: 0; }
  .evidence { margin-top: 1.5rem; font-size: 0.8125rem; }
  .evidence a { display: block; padding: .55rem 0; border-bottom: 1px solid var(--border); text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { .evidence a:hover { color: var(--muted-foreground); } }
  .evidence strong { display: block; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted-foreground); font-family: var(--font-mono); }

  .filters { font-size: 0.8125rem; color: var(--muted-foreground); }
  .filters a, .filters strong {
    display: inline-block; padding: .25rem .625rem; border-radius: 9999px; text-decoration: none;
    color: var(--muted-foreground); font-weight: 500;
  }
  .filters strong { background: var(--muted); color: var(--foreground); }
  @media (hover: hover) and (pointer: fine) { .filters a:hover { color: var(--foreground); } }

  .seal {
    display: inline-block; font-family: var(--font-mono); font-size: .75rem;
    background: var(--muted); border: 1px solid var(--border);
    color: var(--foreground); border-radius: calc(var(--radius) - 4px); padding: .25rem .625rem;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }

  /* The workspace shell: sidebar + content, an optional list pane between. */
  /* The rail collapse is instant: a layout dimension is never animated (UI polish 2026-09-13). */
  .app { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
  .side {
    border-right: 1px solid var(--glass-border);
    background: var(--glass-strong);
    padding: 1rem .875rem 1.125rem; display: flex; flex-direction: column; gap: .175rem;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
    box-shadow: 1px 0 0 var(--glass-highlight) inset;
  }
  .side-head { display: flex; align-items: center; gap: .25rem; min-height: 2.5rem; margin-bottom: .45rem; }
  .side .brand { flex: 1; min-width: 0; padding: .25rem .625rem; font-size: 1rem; height: auto; letter-spacing: -.025em; }
  .brand-short { display: none; font-family: var(--font-mono); letter-spacing: -.06em; }
  .side-toggle {
    display: grid; place-items: center; flex: 0 0 2rem; width: 2rem; min-height: 2rem; padding: 0;
    border-color: transparent; background: transparent; color: var(--muted-foreground); box-shadow: none;
  }
  @media (hover: hover) and (pointer: fine) { .side-toggle:hover { background: var(--glass); color: var(--foreground); transform: none; } }
  .side-toggle svg { width: 1rem; height: 1rem; }
  /* The scope bar: one hairline row, the single scope truth on every
   * screen; its name is the switcher. Magenta never appears here except
   * the needs-you count. */
  .scope-bar {
    display: flex; align-items: baseline; gap: .625rem; flex-wrap: wrap;
    position: sticky; top: 0; z-index: 20;
    padding: .625rem 2rem; border-bottom: 1px solid var(--glass-border);
    background: var(--glass-strong); font-size: .8125rem;
  }
  .scope-bar .eyebrow { font-size: .6875rem; font-weight: 500; color: var(--muted-foreground); }
  .scope-bar .name { font-weight: 600; }
  /* The switcher: a folded menu of enrolled projects under the scope's name. */
  .switcher { position: relative; }
  .switcher > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: .25rem; }
  .switcher > summary::-webkit-details-marker { display: none; }
  .switcher .chevron { width: .875rem; height: .875rem; color: var(--muted-foreground); transition: transform .15s; }
  .switcher[open] > summary .chevron { transform: rotate(180deg); }
  .switcher-menu {
    position: absolute; top: calc(100% + .375rem); left: 0; z-index: 40; min-width: 15rem; max-width: 22rem;
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow-overlay); padding: .375rem; display: flex; flex-direction: column; gap: .125rem;
  }
  .switcher-menu form { margin: 0; }
  .switcher-menu button {
    display: flex; align-items: center; gap: .5rem; width: 100%; text-align: left; margin: 0;
    background: transparent; border: 0; min-height: 2.5rem; padding: 0 .75rem;
    border-radius: calc(var(--radius) - 4px); font: inherit; font-size: .875rem; color: var(--foreground);
  }
  .switcher-menu button.current { font-weight: 600; }
  .switcher-menu button.current::after {
    content: ""; margin-left: auto; width: .375rem; height: .625rem; flex: none;
    border-right: 1.75px solid var(--foreground); border-bottom: 1.75px solid var(--foreground);
    transform: rotate(45deg) translateY(-.125rem);
  }
  @media (hover: hover) and (pointer: fine) { .switcher-menu button:hover { background: var(--muted); } }
  .switcher-menu .manage {
    display: block; margin-top: .25rem; padding: .625rem .75rem; border-top: 1px solid var(--border);
    font-size: .75rem; color: var(--muted-foreground); text-decoration: none;
  }
  .scope-status {
    display: flex; gap: .5rem; flex-wrap: wrap;
    color: var(--muted-foreground); font-size: .6875rem; font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
  }
  .scope-status .hot { color: var(--brand); font-weight: 500; }
  .scope-status a { color: inherit; text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { .scope-status a:hover { text-decoration: underline; } }
  /* A project card's name and counts are forms or links dressed as text and chips. */
  .project-card button.project-name, .project-card a.project-name {
    all: unset; cursor: pointer; font-weight: 600; color: var(--foreground);
  }
  @media (hover: hover) and (pointer: fine) { .project-card a.project-name:hover, .project-card button.project-name:hover { text-decoration: underline; } }
  .project-card button.badge { min-height: auto; box-shadow: none; cursor: pointer; }
  @media (hover: hover) and (pointer: fine) { .project-card button.badge:hover, .project-card a.badge:hover { border-color: var(--input); } }
  /* Adding a project is the page's primary job, not badge-sized metadata.
   * Two roomy action tiles make both roads obvious on a desk and give each
   * one a generous thumb target on a phone. The manual path stays tertiary. */
  .project-add-card { margin-top: 1.25rem; padding: 1.25rem; }
  .project-add-card h2.project-add-title {
    margin: 0; color: var(--foreground); font-size: 1.0625rem; line-height: 1.35;
    letter-spacing: -.015em;
  }
  .project-add-intro { margin: .25rem 0 0; max-width: 36rem; }
  .project-add-actions {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: .625rem; margin-top: 1rem;
  }
  .project-add-action {
    display: grid; grid-template-columns: 2.75rem minmax(0, 1fr) auto;
    align-items: center; gap: .75rem; min-height: 5rem; padding: .75rem .875rem;
    border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 1px);
    background: var(--glass-strong);
    color: var(--foreground); text-decoration: none;
    
    transition: transform .15s ease, background .15s, border-color .15s, box-shadow .15s;
  }
  @media (hover: hover) and (pointer: fine) { .project-add-action:hover {
    border-color: color-mix(in srgb, var(--border) 50%, var(--muted-foreground));
    background: var(--card); text-decoration: none;
    box-shadow: var(--shadow);
  } }
  .project-add-action:active { transform: translateY(0); }
  .project-add-icon {
    display: grid; place-items: center; width: 2.75rem; height: 2.75rem;
    border: 1px solid var(--border); border-radius: .75rem;
    background: var(--muted); color: var(--foreground);
  }
  .project-add-icon svg { width: 1.125rem; height: 1.125rem; }
  .project-add-copy { min-width: 0; }
  .project-add-copy strong { display: block; font-size: .9375rem; line-height: 1.35; }
  .project-add-copy small {
    display: block; margin-top: .175rem; color: var(--muted-foreground);
    font-size: .75rem; font-weight: 400; line-height: 1.4;
  }
  .project-add-arrow { color: var(--muted-foreground); font-size: 1rem; }
  .project-add-more { margin-top: .875rem; border-top: 1px solid var(--border); }
  .project-add-more > summary {
    display: flex; align-items: center; min-height: 2.75rem; width: fit-content;
    color: var(--muted-foreground); cursor: pointer; font-size: .8125rem; font-weight: 500;
  }
  @media (hover: hover) and (pointer: fine) { .project-add-more > summary:hover { color: var(--foreground); } }
  .project-add-more > .card { margin: 0 0 .25rem; }
  .side nav { display: flex; flex-direction: column; gap: .125rem; }
  /* Inline decision options: neutral buttons — the card's magenta outline is
   * the attention signal; recommendation is a neutral badge, never magenta. */
  .decide-options { margin-top: .5rem; display: flex; flex-direction: column; gap: .375rem; }
  .decide-option { margin: 0; display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
  .decide-option button { margin: 0; }
  .decide-option .meta { flex: 1 1 12rem; }
  /* The rail's two accordion groups (sidebar rework): collapsed by
   * default, the active page's group open, opening one closes the other
   * (client toggle in chromeScript). Native <details>/<summary> carries
   * the expanded state and keyboard operation for free — the same pattern
   * the switcher already uses. */
  .side .nav-groups { display: flex; flex-direction: column; gap: .125rem; margin-top: .375rem; }
  .nav-group > summary {
    display: flex; align-items: center; justify-content: space-between; gap: .5rem;
    list-style: none; cursor: pointer; padding: .4375rem .625rem; min-height: 2.125rem;
    border-radius: calc(var(--radius) - 3px); text-decoration: none;
    color: var(--muted-foreground); font-size: .6875rem; font-weight: 500;
    font-family: var(--font-sans);
  }
  .nav-group > summary::-webkit-details-marker { display: none; }
  @media (hover: hover) and (pointer: fine) { .nav-group > summary:hover { background: var(--glass); color: var(--foreground); } }
  .nav-group > summary .chevron { width: .875rem; height: .875rem; flex: none; transition: transform .15s; }
  .nav-group[open] > summary .chevron { transform: rotate(180deg); }
  .nav-group .nav-group-items { display: flex; flex-direction: column; gap: .125rem; margin: .125rem 0 .25rem; }
  .side .nav-settings { margin-top: .375rem; }
  .side nav a {
    position: relative;
    display: flex; align-items: center; gap: .625rem; padding: .4375rem .625rem; min-height: 2.125rem;
    border-radius: calc(var(--radius) - 3px); text-decoration: none;
    color: var(--muted-foreground); font-size: .8125rem; font-weight: 500;
    transition: color .15s, background .15s, transform .15s;
  }
  .side nav a .glyph { display: inline-flex; width: 1rem; height: 1rem; color: var(--muted-foreground); flex: none; }
  .side nav a .glyph svg { width: 1rem; height: 1rem; }
  @media (hover: hover) and (pointer: fine) { .side nav a:hover { background: var(--glass); color: var(--foreground); transform: translateX(2px); } }
  .side nav a:active { background: var(--glass); color: var(--foreground); }
  .app.sidebar-collapsed { grid-template-columns: 64px minmax(0, 1fr); }
  .app.sidebar-collapsed .side { padding-inline: .625rem; }
  .app.sidebar-collapsed .side-head { flex-direction: column; gap: .2rem; margin-bottom: .55rem; }
  .app.sidebar-collapsed .side .brand { flex: none; padding: .2rem 0; font-size: .75rem; }
  .app.sidebar-collapsed .brand-long { display: none; }
  .app.sidebar-collapsed .brand-short { display: block; }
  .app.sidebar-collapsed .side-toggle svg { transform: rotate(180deg); }
  .app.sidebar-collapsed .side nav a {
    justify-content: center; gap: 0; min-height: 2.5rem; padding: .5rem; font-size: 0;
  }
  .app.sidebar-collapsed .side nav a .glyph { width: 1.125rem; height: 1.125rem; }
  .app.sidebar-collapsed .side nav a .glyph svg { width: 1.125rem; height: 1.125rem; }
  .app.sidebar-collapsed .side nav a .count {
    position: absolute; top: .15rem; right: .05rem; min-width: 1rem; padding: 0 .25rem; font-size: .55rem;
  }
  .app.sidebar-collapsed .side .new-task { min-height: 2.5rem; padding: .4rem 0; font-size: 0; }
  .app.sidebar-collapsed .side .new-task::after { content: "+"; font-size: 1rem; }
  .app.sidebar-collapsed .side .nav-groups { display: none; }
  .side nav a.active {
    background: var(--card);
    color: var(--foreground); box-shadow: 0 1px 0 var(--glass-highlight) inset;
  }
  .side nav a.active .glyph { color: var(--foreground); }
  .side nav a .count { margin-left: auto; }
  .side .grow { flex: 1; }
  .side .new-task {
    display: block; text-align: center; text-decoration: none; font-weight: 600; font-size: .8125rem;
    background: var(--primary); color: var(--primary-foreground);
    border: 1px solid var(--primary);
    border-radius: calc(var(--radius) - 3px); padding: .525rem; margin: .75rem 0 .125rem;
    box-shadow: 0 10px 28px -18px rgb(255 255 255 / .5);
  }
  @media (hover: hover) and (pointer: fine) { .side .new-task:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); } }
  /* The same action link outside the sidebar reads as a real button. */
  .content .new-task {
    display: inline-block; text-decoration: none; font-weight: 500; font-size: .8125rem;
    background: var(--secondary); color: var(--foreground); border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px); padding: .5rem .875rem;
  }
  @media (hover: hover) and (pointer: fine) { .content .new-task:hover { background: color-mix(in srgb, var(--secondary) 70%, var(--border)); } }
  .content { min-width: 0; }
  .content > main { max-width: 54rem; margin: 0; padding: 2rem 2.5rem 4rem; }

  /* Banners: honest labels, quiet strips. */
  .banner {
    border-bottom: 1px solid var(--glass-border); background: var(--glass);
    padding: .375rem .9rem; font-size: .8125rem; color: var(--muted-foreground);
  }
  .banner .badge { margin-right: .5rem; }
  /* Chat in \`toolroll demo\`: the scripted lead's conversation. */
  .demo-chat { display: flex; flex-direction: column; gap: 1rem; max-width: 46rem; margin: 0 auto; padding-bottom: 1rem; }
  .demo-thread { display: flex; flex-direction: column; gap: 1.25rem; }
  .demo-turn { display: flex; flex-direction: column; gap: .75rem; scroll-margin-top: 1rem; }
  .demo-said p { margin: 0; }
  .demo-you { align-self: flex-end; max-width: min(34rem, 85%); background: var(--so-ink); color: var(--so-paper); border-radius: .875rem .875rem .25rem .875rem; padding: .55rem .85rem; overflow-wrap: anywhere; }
  .demo-lead { max-width: 40rem; }
  .demo-who { font-size: .75rem; font-weight: 600; color: var(--so-muted); margin-bottom: .15rem !important; }
  .demo-chat .card { margin: 0; padding: 1rem 1.125rem; }
  .demo-chat .card h2 { font-size: .9375rem; margin: .1rem 0 .4rem; }
  .demo-chat .card h3 { font-size: .75rem; font-weight: 600; color: var(--so-muted); margin: .75rem 0 .25rem; }
  .demo-chat .card ul { margin: 0; padding-left: 1.1rem; }
  .demo-chat .card li { margin: .15rem 0; }
  .demo-chat .card > p { margin: .25rem 0; }
  .demo-kicker { font-size: .75rem; color: var(--so-muted); margin: 0 !important; }
  .demo-actions { display: flex; flex-wrap: wrap; align-items: flex-start; gap: .5rem; margin-top: .9rem; }
  .demo-actions form { margin: 0; }
  .demo-actions button, .demo-more > summary { min-height: 2.5rem; }
  .demo-chat button.demo-primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  .demo-chat details.demo-more { flex: 1 1 12rem; margin: 0; padding: 0; border: 0; border-radius: 0; background: none; }
  .demo-chat details.demo-more[open] { padding-bottom: 0; }
  .demo-chat .demo-more > summary { display: inline-flex; align-items: center; color: var(--so-ink); padding: .35rem .85rem; border: 1px solid var(--so-input-line); border-radius: calc(var(--radius) - 3px); background: var(--so-paper); font-weight: 500; font-size: .8125rem; cursor: pointer; list-style: none; }
  .demo-more > summary::-webkit-details-marker { display: none; }
  .demo-more[open] > summary { margin-bottom: .5rem; }
  .demo-more form, .demo-composer { display: flex; flex-direction: column; gap: .4rem; }
  .demo-more label { font-size: .8125rem; font-weight: 500; }
  .demo-more textarea, .demo-composer textarea { width: 100%; font: inherit; font-size: 1rem; resize: vertical; }
  .demo-more form button { align-self: flex-start; }
  .demo-steps { display: flex; flex-wrap: wrap; gap: .4rem 1rem; list-style: none; padding: 0 !important; margin: .4rem 0 !important; }
  .demo-steps li { display: inline-flex; align-items: center; gap: .4rem; color: var(--so-muted); font-size: .8125rem; margin: 0 !important; }
  .demo-steps li::before { content: ""; width: .55rem; height: .55rem; border-radius: 50%; border: 1.5px solid currentColor; }
  .demo-steps li.done { color: var(--so-ink); }
  .demo-steps li.done::before { background: var(--so-success); border-color: var(--so-success); }
  .demo-steps li.now { color: var(--so-ink); font-weight: 600; }
  .demo-steps li.now::before { border-color: var(--so-info); background: var(--so-info); animation: demo-pulse 1.2s ease-in-out infinite; }
  @keyframes demo-pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .demo-steps li.now::before { animation: none; } }
  .demo-state { display: flex; align-items: center; gap: .5rem; margin: 0 !important; }
  .demo-chat .demo-handoff { border-color: var(--so-input-line); }
  .demo-command { margin: .4rem 0 .5rem; padding: .6rem .8rem; border-radius: calc(var(--radius) - 3px); background: var(--so-raised); font: 500 .8125rem/1.5 var(--font-mono); overflow-wrap: anywhere; white-space: pre-wrap; }
  .demo-chat .badge.demo-ready { background: var(--so-info-soft); color: var(--so-info); }
  .demo-chat .badge.demo-complete { background: var(--so-success-soft); color: var(--so-success); }
  .demo-pass { color: var(--so-success); font-weight: 500; }
  .demo-fail { color: var(--so-danger); font-weight: 500; }
  .demo-chat details.demo-evidence { margin: .5rem 0 0; padding: 0; border: 0; border-top: 1px solid var(--so-line); border-radius: 0; background: none; box-shadow: none; }
  .demo-evidence > summary { min-height: 2.5rem; display: list-item; padding-block: .55rem; cursor: pointer; font-weight: 500; font-size: .8125rem; }
  .demo-evidence pre { margin: 0 0 .5rem; max-height: 22rem; overflow: auto; padding: .6rem .75rem; border-radius: .5rem; background: var(--so-raised); font: 400 .75rem/1.55 var(--font-mono); white-space: pre; overflow-wrap: normal; }
  .demo-diff span { display: block; min-width: max-content; }
  .demo-diff-add { background: var(--so-success-soft); color: var(--so-success); }
  .demo-diff-del { background: var(--so-danger-soft); color: var(--so-danger); }
  .demo-diff-hunk, .demo-diff-meta { color: var(--so-muted); }
  .demo-diff-file { font-weight: 600; }
  .demo-evidence figure { margin: 0 0 .5rem; }
  .demo-evidence img { display: block; width: 100%; height: auto; border: 1px solid var(--so-line); border-radius: .5rem; }
  .demo-evidence figcaption { margin-top: .35rem; }
  .demo-hint { padding: 1.25rem 0 .25rem; }
  .demo-hint-title { font-size: .9375rem; font-weight: 600; margin: 0 0 .75rem; }
  .demo-suggestions { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0; }
  .demo-suggestions button { min-height: 2.5rem; border-radius: 999px; padding: .35rem .95rem; }
  .demo-composer { position: sticky; bottom: 0; padding: .75rem 0 .25rem; background: var(--so-paper); flex-direction: row; align-items: flex-end; }
  .demo-chat .demo-composer textarea { flex: 1 1 auto; width: auto; min-width: 0; min-height: 2.75rem; }
  .demo-chat .demo-composer button { flex: none; width: auto; min-height: 2.75rem; padding-inline: 1.1rem; }
  .banner a { color: var(--muted-foreground); }
  .sign-in-banner form { display: inline; margin: 0 0 0 .5rem; padding: 0; border: 0; background: transparent; }

  .split { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); min-height: 100vh; }
  .list-pane {
    border-right: 1px solid var(--border); overflow-y: auto; height: 100vh;
    position: sticky; top: 0; padding: 1rem .75rem;
  }
  .list-pane h2 { margin-top: .25rem; }
  .list-pane a.item {
    display: block; padding: .5rem .625rem; border-radius: calc(var(--radius) - 4px);
    text-decoration: none; font-size: .8125rem; margin-bottom: .125rem;
  }
  @media (hover: hover) and (pointer: fine) { .list-pane a.item:hover { background: var(--card); } }
  .list-pane a.item.current { background: var(--muted); }
  .list-pane a.item .t { display: block; font-weight: 500; color: var(--foreground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .list-pane a.item .m { display: flex; gap: .375rem; align-items: center; color: var(--muted-foreground);
    font-size: .75rem; margin-top: .125rem; }
  .split > .detail { min-width: 0; }
  .split > .detail > main { max-width: 52rem; padding: 1.5rem 2rem 4rem; }
  .split:has(#wb-rail) { grid-template-columns: minmax(320px, 360px) minmax(0, 1fr); }
  .list-pane:has(#wb-rail) { padding: 0; background: var(--background); }
  #wb-rail { padding: 1rem .75rem 1.5rem; }
  #wb-rail-stamp { padding: 0 .75rem; }
  .workbench-mobile-rail, .workbench-mobile-back { display: none; }
  /* The task page (slice 1c): main column beside a rail; one column narrow. */
  .task-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(16rem, 19rem); gap: 0 2rem; align-items: start; }
  /* The task page (task page pass): title, the acts in one row,
     then folding sections; the rail is the property list. */
  .task-identity { overflow-wrap: anywhere; }
  .task-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .task-title-row .task-main-title { min-width: 0; margin-bottom: .85rem; }
  .task-view-switch {
    display: inline-grid; grid-template-columns: repeat(2, auto); flex: none; padding: .2rem;
    border: 1px solid var(--glass-border); border-radius: .72rem; background: color-mix(in srgb, var(--glass) 82%, transparent);
    
  }
  .task-view-switch a {
    min-width: 4.6rem; padding: .4rem .72rem; border-radius: .52rem; color: var(--muted-foreground);
    font-size: .72rem; font-weight: 550; text-align: center; text-decoration: none;
  }
  @media (hover: hover) and (pointer: fine) { .task-view-switch a:hover { color: var(--foreground); background: color-mix(in srgb, var(--muted) 70%, transparent); } }
  .task-view-switch a.active { color: var(--foreground); background: var(--glass-strong); box-shadow: 0 1px 5px rgb(0 0 0 / .1); }
  .acts-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .75rem 0 .25rem; }
  .acts-bar form.inline { margin: 0; display: inline-flex; align-items: center; gap: .375rem; }
  .acts-bar form.inline button { width: auto; }
  .acts-bar .primary button { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  @media (hover: hover) and (pointer: fine) { .acts-bar .primary button:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); } }
  .acts-bar .act-hold input[type=text] { width: 10rem; min-height: 2.25rem; margin: 0; font-size: .8125rem; }
  .acts-why { margin: 0 0 .5rem; }
  .dispatch-status { padding: .8rem .9rem; border-radius: var(--radius); overflow: hidden; }
  .dispatch-copy { display: flex; align-items: baseline; flex-wrap: wrap; gap: .2rem .35rem; min-width: 0; }
  .dispatch-copy .meta { min-width: 0; }
  .dispatch-action-link { margin-top: .65rem; }
  .dispatch-status[data-dispatch-status="proof-refuted"],
  .dispatch-status[data-dispatch-status="needs-verification"] {
    color: var(--foreground); border-color: var(--glass-border); background: var(--glass);
  }
  .dispatch-status[data-dispatch-status="proof-refuted"] .dispatch-copy > strong::before,
  .dispatch-status[data-dispatch-status="needs-verification"] .dispatch-copy > strong::before {
    content: ""; display: inline-block; width: .45rem; height: .45rem; margin-right: .45rem; border-radius: 50%; vertical-align: .08rem;
    background: var(--so-warning, #ab6400);
  }
  .problem.dispatch-status[data-dispatch-status="proof-refuted"] .dispatch-copy > strong::before { background: var(--destructive); }
  .dispatch-status[data-dispatch-status="needs-verification"] .dispatch-copy > strong::before { background: var(--muted-foreground); }
  /* A review in flight (review fixes): the box reads neutral — neither the
     green of a settled verdict nor the red of a problem — with the dot in
     the review's own tone. */
  .dispatch-status[data-work-status="reviewing"], .dispatch-status[data-work-status="review-pending"],
  .dispatch-status[data-work-status="review-failed"], .dispatch-status[data-work-status="review-exhausted"] {
    color: var(--foreground); border-color: var(--glass-border); background: var(--glass);
  }
  .dispatch-status[data-work-status="reviewing"] .dispatch-copy > strong::before, .dispatch-status[data-work-status="review-pending"] .dispatch-copy > strong::before,
  .dispatch-status[data-work-status="review-failed"] .dispatch-copy > strong::before, .dispatch-status[data-work-status="review-exhausted"] .dispatch-copy > strong::before {
    content: ""; display: inline-block; width: .45rem; height: .45rem; margin-right: .45rem; border-radius: 50%; vertical-align: .08rem; background: var(--warning);
  }
  .dispatch-status[data-work-status="reviewing"] .dispatch-copy > strong::before { background: var(--running); }
  .review-retry { margin-bottom: .65rem; }
  .task-control { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .6rem .9rem; margin: .65rem 0; padding: .8rem .9rem; }
  .task-control-copy { display: flex; flex-direction: column; gap: .15rem; min-width: 0; flex: 1 1 16rem; }
  .task-control-copy strong { display: flex; align-items: center; gap: .4rem; overflow-wrap: anywhere; }
  .task-control-copy .meta { overflow-wrap: anywhere; }
  .task-control-form { margin: 0; flex: none; }
  .task-control-button { width: auto; min-width: 7.5rem; white-space: nowrap; }
  .task-control-button.primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  .task-control-button[disabled] { opacity: .65; cursor: not-allowed; }
  .task-control[data-task-control="stopping"] { border-color: color-mix(in srgb, var(--destructive) 45%, var(--glass-border)); }
  .task-control[data-task-control="stopping"] .live-dot { background: var(--destructive); }
  .task-control[data-task-control="paused"] .eyebrow { color: var(--destructive); }
  .resume-ceremony .row { margin: .3rem 0; }
  @media (max-width: 480px) { .task-control { align-items: stretch; } .task-control-form, .task-control-button { width: 100%; } .task-control-form .task-control-button { width: 100%; } }
  .review-attempts { margin: .55rem 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: .2rem; font-size: .8125rem; }
  .review-attempts li { display: flex; flex-wrap: wrap; align-items: baseline; gap: .2rem .45rem; min-width: 0; }
  .review-attempts .review-attempt-ordinal { font-weight: 600; }
  .review-attempts .meta { min-width: 0; overflow-wrap: anywhere; }
  .review-retry-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .55rem; margin-top: .65rem; }
  .review-retry-actions form.inline { margin: 0; }
  .review-retry-button { width: auto; max-width: 100%; white-space: normal; }
  .review-retry-form .review-retry-button { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  .review-retry-button[disabled] { opacity: .65; cursor: not-allowed; }
  .proof-review-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .55rem; margin: .65rem 0; }
  .proof-review-actions > .button-link { flex: none; }
  details.proof-exception { margin: 0; }
  details.proof-exception > summary { cursor: pointer; color: var(--muted-foreground); font-size: .78rem; font-weight: 600; }
  details.proof-exception[open] { flex: 1 1 100%; padding: .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: var(--glass); }
  details.proof-exception[open] > summary { margin-bottom: .6rem; color: var(--foreground); }
  .proof-exception-form { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0; }
  .proof-exception-form input { margin: 0; min-width: 12rem; }
  .proof-exception-form button[type=submit] { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  .dispatch-proof-details { margin: .65rem 0 .85rem; border: 1px solid var(--glass-border); border-radius: var(--radius); background: var(--glass); }
  .dispatch-proof-details > summary { padding: .75rem .9rem; cursor: pointer; color: var(--muted-foreground); font-size: .78rem; font-weight: 600; }
  .dispatch-proof-body { padding: 0 .9rem .85rem; border-top: 1px solid var(--glass-border); }
  details.dispatch-recovery { margin-top: .65rem; border: 0; padding: 0; background: transparent; box-shadow: none; }
  details.dispatch-recovery > summary {
    display: inline-flex; align-items: center; min-height: 2.25rem; padding: 0 .875rem; list-style: none;
    border: 1px solid var(--primary); border-radius: calc(var(--radius) - 2px); cursor: pointer;
    background: var(--primary); color: var(--primary-foreground); font-size: .8125rem; font-weight: 600;
  }
  details.dispatch-recovery > summary::-webkit-details-marker { display: none; }
  .dispatch-recovery-body { margin-top: .65rem; padding: .7rem .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: var(--glass); color: var(--foreground); }
  .dispatch-recovery-body p { margin: 0; }
  .dispatch-recovery-body p + p { margin-top: .5rem; }
  .dispatch-recovery-command { display: block; margin-top: .45rem; padding: .55rem .65rem; overflow-wrap: anywhere; border-radius: .5rem; background: var(--muted); }
  .dispatch-status[data-dispatch-status="no-worker-registered"],
  .dispatch-status[data-dispatch-status="no-worker-online"] {
    color: var(--foreground); border-color: color-mix(in srgb, var(--warning) 30%, var(--border));
    background: color-mix(in srgb, var(--warning-soft) 48%, var(--glass));
  }
  .dispatch-status[data-dispatch-status="no-worker-registered"] .dispatch-copy > strong,
  .dispatch-status[data-dispatch-status="no-worker-online"] .dispatch-copy > strong { color: color-mix(in srgb, var(--warning) 72%, var(--foreground)); }
  .builder-notice { border-color: color-mix(in srgb, var(--warning) 30%, var(--border)); background: color-mix(in srgb, var(--warning-soft) 48%, var(--glass)); }
  .builder-notice strong { color: color-mix(in srgb, var(--warning) 72%, var(--foreground)); }
  .dispatch-status[data-dispatch-status="terminal-dependency"] {
    color: var(--foreground); border-color: color-mix(in srgb, var(--warning) 42%, var(--border));
    background: color-mix(in srgb, var(--warning-soft) 72%, var(--glass));
  }
  .dispatch-status[data-dispatch-status="terminal-dependency"] .dispatch-copy > strong { color: var(--warning); }
  .dispatch-status[data-dispatch-status="waiting-dependency"] {
    color: var(--foreground); border-color: var(--glass-border); background: var(--glass);
  }
  .dependency-repair-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; margin-top: .7rem; }
  .dependency-repair-help { flex: 1 0 100%; margin: 0 0 .1rem; }
  .dependency-repair-actions form { display: inline-flex; align-items: center; gap: .4rem; min-width: 0; max-width: 100%; margin: 0; }
  .dependency-repair-label { flex: 1 1 16rem; min-width: 0; margin: 0; color: var(--foreground); font-size: .75rem; }
  .dependency-repair-label select { display: block; margin: .3rem 0 0; }
  .dependency-repair-actions select { width: auto; max-width: 16rem; min-height: 2rem; margin: 0; font-size: .75rem; }
  .dependency-repair-actions button { min-height: 2rem; padding: .3rem .65rem; font-size: .75rem; }
  .approve-form { margin: .75rem 0; }
  .approve-form .ceremony-head { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; margin: 0 0 .5rem; }
  .approve-form .ceremony-head a { font-size: .8125rem; color: var(--muted-foreground); white-space: nowrap; }
  .approve-form .recap { margin: .125rem 0 .5rem; }
  .approval-card { padding: 1.2rem 1.3rem; border-radius: calc(var(--radius) + 3px); }
  .approval-card .ceremony-head { align-items: flex-start; padding-bottom: .85rem; border-bottom: 1px solid var(--glass-border); }
  .approval-title { display: grid; gap: .15rem; }
  .approval-kicker { color: var(--muted-foreground); font: 500 .66rem/1.3 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
  .approval-title strong { font-size: 1.05rem; letter-spacing: -.02em; }
  .approval-label { display: block; margin: .9rem 0 .2rem; color: var(--muted-foreground); font: 500 12px/1.4 var(--font-sans); }
  .approval-label::first-letter, .planner-plan .eyebrow::first-letter { text-transform: uppercase; }
  .planner-plan .eyebrow { font: 500 12px/1.4 var(--font-sans); letter-spacing: 0; text-transform: none; }
  .approval-goal { margin: 0; font-size: 1rem; line-height: 1.55; white-space: pre-wrap; }
  .approval-boundaries { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; margin-top: .75rem; }
  .approval-boundary { padding: .7rem .8rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--muted) 45%, transparent); }
  .approval-boundary .approval-label { margin: 0 0 .2rem; }
  .approval-boundary p { margin: 0; color: var(--muted-foreground); font-size: .8rem; overflow-wrap: anywhere; }
  .approval-chips { display: flex; flex-wrap: wrap; gap: .4rem; margin: .8rem 0 .3rem; }
  /* The filed contract (contract handoff, task 1): preserved, amended, or
     drafted from nothing — the same panel on the task page, in the
     ceremony, and on /next, so an amendment is never a surprise after the
     yes. An amendment is the one state that asks for a second look. */
  .contract-panel { margin-top: .8rem; padding: .7rem .85rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--muted) 45%, transparent); }
  .contract-panel .approval-label { margin: 0 0 .25rem; }
  .contract-panel p { margin: .2rem 0; }
  .contract-amended { border-color: color-mix(in srgb, var(--warning, #c98a1b) 55%, var(--glass-border)); background: color-mix(in srgb, var(--warning, #c98a1b) 9%, transparent); }
  .contract-reason { font-size: .9rem; }
  .contract-changes { margin: .5rem 0 0; padding-left: 1.1rem; display: grid; gap: .45rem; }
  .contract-changes li { overflow-wrap: anywhere; }
  .contract-change-kind { display: inline-block; margin-right: .3rem; padding: .05rem .4rem; border-radius: 999px; font: 600 .62rem/1.5 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; background: color-mix(in srgb, var(--muted) 70%, transparent); }
  .contract-change-added { background: color-mix(in srgb, var(--success, #2f9e5f) 18%, transparent); }
  .contract-change-removed { background: color-mix(in srgb, var(--danger, #c8453d) 18%, transparent); }
  .contract-change-changed { background: color-mix(in srgb, var(--warning, #c98a1b) 22%, transparent); }
  .contract-before, .contract-after { margin-top: .15rem; font-size: .85rem; }
  .contract-before { color: var(--muted-foreground); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted-foreground) 55%, transparent); }
  .contract-note { margin-top: .5rem; }
  /* The agents (v47): one compact summary, rendered identically on the task
     page, in the approval ceremony, and in the focused chat; reasons and
     change controls stay closed until asked for. */
  .agents-card { margin-top: .75rem; }
  .agents-head { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; }
  .agents-head h3 { margin: 0; font-size: .95rem; letter-spacing: -.02em; }
  .agents-badges { display: flex; flex-wrap: wrap; gap: .3rem; }
  .agents-summary { margin: .55rem 0 0; font-size: .86rem; line-height: 1.5; overflow-wrap: anywhere; }
  .agents-availability-label { margin: .6rem 0 .15rem; }
  .agents-availability { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .25rem .9rem; font-size: .8125rem; }
  .agents-availability li { overflow-wrap: anywhere; }
  .agents-availability-unavailable { color: var(--destructive); font-weight: 600; }
  .agents-availability-ready { color: var(--success); }
  .agents-availability-unknown { color: var(--muted-foreground); }
  .agents-halted { margin: .6rem 0 0; padding: .55rem .7rem; border: 1px solid color-mix(in srgb, var(--destructive) 40%, var(--border)); border-radius: calc(var(--radius) - 3px); background: var(--destructive-soft); font-size: .8rem; }
  .agents-problems { margin: .5rem 0 0; padding-left: 1.1rem; color: var(--destructive); font-size: .78rem; }
  .agents-why, .agents-change { margin-top: .65rem; }
  .agents-why > summary, .agents-change > summary { display: flex; align-items: center; min-height: 2.75rem; padding: .35rem .2rem; cursor: pointer; font-size: .8rem; font-weight: 600; }
  .agents-demands { margin: .35rem 0 0; padding-left: 1.1rem; color: var(--muted-foreground); font-size: .76rem; line-height: 1.45; }
  .agents-roles { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: .45rem .6rem; margin: .5rem 0 0; }
  .agents-roles dt { color: var(--muted-foreground); font: 500 .66rem/1.8 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
  .agents-roles dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .agents-roles .agents-reasons { margin: .2rem 0 0; padding-left: 1rem; color: var(--muted-foreground); font-size: .74rem; line-height: 1.45; }
  .agents-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; align-items: end; margin: 0; }
  .agents-form label, .agents-form-risk label { display: grid; gap: .2rem; margin: 0; min-width: 0; font-size: .74rem; }
  .agents-form input, .agents-form select, .agents-form-risk select { width: 100%; min-width: 0; min-height: 2.75rem; }
  .agents-form button, .agents-form-risk button, .agents-clear button { min-height: 2.75rem; }
  .agents-form-risk { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; margin-top: .5rem; }
  .agents-form-risk label.agents-risky { display: flex; align-items: center; gap: .4rem; min-height: 2.75rem; font-size: .85rem; }
  .agents-overrides { list-style: none; margin: .5rem 0 0; padding: 0; display: grid; gap: .35rem; font-size: .78rem; }
  .agents-overrides li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem .6rem; }
  .agents-clear { margin: 0; }
  .agents-clear button { padding-inline: .8rem; font-size: .72rem; }
  .agents-ceremony { margin: .5rem 0 0; }
  .agents-ceremony .agents-badges { margin-top: .35rem; }
  .agents-runtime { margin-top: .5rem; }
  .agents-runtime > summary { display: flex; align-items: center; min-height: 2.75rem; padding: .35rem .2rem; cursor: pointer; font-size: .8rem; font-weight: 600; }
  .agents-role-forms { display: grid; gap: .45rem; margin-top: .6rem; }
  .agents-role-row { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: .5rem; align-items: center; }
  .agents-role-name { color: var(--muted-foreground); font: 500 .66rem/1.8 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
  .task-chat-agents { display: flex; flex-wrap: wrap; align-items: baseline; gap: .3rem .55rem; margin: .1rem 0 .2rem; padding: .55rem .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--muted) 45%, transparent); font-size: .78rem; line-height: 1.45; overflow-wrap: anywhere; }
  .task-chat-agents a { white-space: nowrap; }
  .task-chat-agents-aside { margin-top: .85rem; }
  .task-chat-agents-aside .agents-summary { font-size: .74rem; }
  .task-chat-agents-aside .agents-badges { margin-top: .35rem; }
  .task-chat-agents-aside .agents-roles { grid-template-columns: 1fr; }
  .approval-chip { padding: .25rem .6rem; border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground); background: var(--glass); font-size: .7rem; }
  .approval-confirm { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: end; margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--glass-border); }
  .approval-confirm label { margin: 0; }
  .approval-card .approval-confirm button { min-height: 44px; white-space: nowrap; }
  /* The ceremony's orientation and exact-terms group (UI polish 2026-09-13). */
  /* Neutral by law: magenta belongs to the count and the approve act alone. */
  .approval-orient { margin: .85rem 0 .25rem; }
  .approval-terms { scroll-margin-top: 5rem; }
  .approval-confirm { scroll-margin-top: 5rem; }
  .approval-paths { margin: 0; padding: 0; list-style: none; display: grid; gap: .15rem; }
  .approval-paths li { color: var(--muted-foreground); font-size: .8rem; overflow-wrap: anywhere; }
  /* The approval sheet (approval critique, Oct 2): the plan open in plain
     rows, who builds in one line, one Approve & start beside the password,
     and every other signed term in one Details fold at the end. Sentence
     case, Geist, 12px and up; prose capped at 75ch. */
  .approval-sheet { display: grid; gap: 16px; margin: 0; padding: 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
  .approval-sheet.approve-form > :not(input) { margin: 0; }
  .approval-sheet-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; letter-spacing: -.01em; }
  .approval-revision, .approval-note { max-width: 75ch; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
  .approval-note { color: var(--muted-foreground); }
  .approval-rows { display: grid; gap: 14px; margin: 0; }
  .approval-row { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 16px; }
  .approval-row dt { margin: 0; color: var(--muted-foreground); font-size: 13px; font-weight: 500; line-height: 1.6; }
  .approval-row dd { min-width: 0; max-width: 75ch; margin: 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
  .approval-row dd p, .approval-sheet .approval-goal { margin: 0; font-size: 14px; line-height: 1.6; }
  .approval-row dd :is(ol, ul) { display: grid; gap: 4px; margin: 0; padding-left: 1.25rem; }
  .approval-row dd ol + p { margin-top: 6px; }
  .approval-row dd .approval-paths { margin-top: 2px; padding-left: 0; }
  .approval-row dd .approval-paths li { font-size: 13px; }
  .approval-amendment { max-width: 75ch; padding: 12px 14px; border-radius: 8px; background: var(--muted); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
  .approval-amendment p { margin: 0; }
  .approval-amendment ul { display: grid; gap: 4px; margin: 6px 0; padding-left: 1.25rem; }
  .agents-size { margin: 0; font-size: 13px; line-height: 1.5; }
  .approval-who { max-width: 75ch; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
  .approval-act { display: grid; grid-template-columns: minmax(0, 20rem) auto; justify-content: start; align-items: center; gap: 8px; }
  .approval-password { margin: 0; }
  .approval-act input[type=password] { margin: 0; font-family: var(--font-sans); }
  .approval-act button { margin: 0; min-height: 2.125rem; white-space: nowrap; }
  .approval-after { max-width: 75ch; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
  .approval-allowing, .approval-you-check { max-width: 75ch; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
  .approval-sheet .approval-allowing + .approval-you-check { margin-top: -10px; }
  .approval-act > button { grid-column: 2; grid-row: 1; }
  .approval-password-note { grid-column: 1; grid-row: 2; margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
  .approval-secondary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  details.approval-edit, details.approval-edit[open] { margin: 0; padding: 0; border: 0; border-radius: 0; background: none; }
  /* Edit plan, in place: the rows become fields where they stood; the
     approval act and Details step aside until it is saved or cancelled. */
  .approval-sheet { position: relative; }
  .approval-edit > summary { list-style: none; cursor: pointer; }
  .approval-edit > summary::-webkit-details-marker { display: none; }
  .approval-edit-close, .approval-edit[open] .approval-edit-open { display: none; }
  .approval-edit[open] .approval-edit-close { display: inline; }
  .approval-edit[open] > summary { position: absolute; top: 14px; right: 20px; }
  .approval-sheet:has(.approval-edit[open]) > :not(.approval-sheet-title, .approval-secondary) { display: none; }
  .approval-secondary:has(> .approval-edit[open]) { display: block; }
  .approval-secondary:has(> .approval-edit[open]) > a { display: none; }
  .approval-editor { display: grid; gap: 14px; }
  .approval-editor .problem { margin: 0; }
  .approval-field { display: grid; gap: 4px; min-width: 0; margin: 0; padding: 0; border: 0; }
  .approval-field-label { padding: 0; color: var(--muted-foreground); font-size: 13px; font-weight: 500; line-height: 1.6; }
  .approval-field-hint { color: var(--muted-foreground); font-size: 12px; line-height: 1.5; }
  .approval-field textarea, .approval-field input[type=text] { width: 100%; max-width: 75ch; margin: 0; font-family: var(--font-sans); font-size: 14px; line-height: 1.55; }
  .approval-requirements { display: grid; gap: 6px; margin: 2px 0 0; padding: 0; list-style: none; }
  .approval-edit-act { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .approval-edit-act button { margin: 0; min-height: 2.125rem; white-space: nowrap; }
  .approval-link { display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--foreground); font-size: 13px; font-weight: 500; text-decoration: none; }
  .approval-secondary > .approval-link:not(:first-child) { border-color: transparent; background: none; color: var(--muted-foreground); }
  @media (hover: hover) and (pointer: fine) { .approval-link:hover { background: var(--muted); color: var(--foreground); } }
  details.approval-details { margin: 0; padding: 0; border: 0; border-top: 1px solid var(--border); border-radius: 0; background: none; }
  details.approval-details[open] { padding-bottom: 0; }
  .approval-details > summary { display: flex; align-items: center; min-height: 40px; padding: 4px 0 0; font-size: 13px; }
  .approval-detail { max-width: 75ch; margin: 12px 0 0; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
  .approval-detail h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; letter-spacing: 0; text-transform: none; }
  .approval-detail p, .approval-detail ul, .approval-detail dl { margin: 4px 0; }
  .approval-detail ul { padding-left: 1.25rem; }
  .approval-detail .revision-card { margin: 0; padding: 0; border: 0; background: none; }
  .approval-roles { display: grid; gap: 8px; }
  .approval-roles > div { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: 12px; }
  .approval-roles dt { color: var(--muted-foreground); font-weight: 500; }
  .approval-roles dd { margin: 0; }
  .approval-roles dd ul { margin: 2px 0 0; color: var(--muted-foreground); }
  .chat-plan .approval-sheet { padding: 0; border: 0; background: none; }
  @media (max-width: 760px) {
    .approval-sheet { gap: 12px; padding: 14px; }
    .approval-row { grid-template-columns: 1fr; gap: 2px; }
    .approval-act { grid-template-columns: 1fr; }
    .approval-act > button, .approval-password-note { grid-column: auto; grid-row: auto; }
    .approval-act input[type=password], .approval-act button { min-height: 44px; font-size: 16px; }
    .approval-act button { width: 100%; }
    /* The one act stays under the thumb: sticky at the bottom, clear of the home indicator. */
    .approval-sheet[data-sticky] .approval-act {
      position: sticky; bottom: 0; z-index: 20; margin: 0 -14px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom, 0px));
      border-top: 1px solid var(--border); background: var(--card);
    }
    .approval-link { min-height: 44px; padding: 0 16px; }
    .approval-edit[open] > summary { top: 6px; right: 6px; }
    .approval-field textarea, .approval-field input[type=text] { font-size: 16px; }
    .approval-edit-act button { width: 100%; min-height: 44px; font-size: 16px; }
    .approval-details > summary { min-height: 44px; }
    .approval-roles > div { grid-template-columns: 1fr; gap: 2px; }
  }
  .run-facts-details { margin-top: 1.25rem; }
  .run-facts-details > summary { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
  .run-facts-details > summary .meta { font-size: .75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-main-title, .chat-project-name strong, .proposal h3 { overflow-wrap: anywhere; }
  .planner-plan { margin-top: .75rem; padding: 1.15rem 1.2rem; overflow: hidden; background: color-mix(in srgb, var(--glass) 82%, transparent); }
  .execution-plan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: .95rem; }
  .execution-plan-head h2 { margin: .15rem 0 0; font-size: 1.05rem; letter-spacing: -.025em; }
  .execution-plan-head p { margin: .25rem 0 0; max-width: 38rem; }
  details.planner-plan-collapsed { padding: 0; }
  .planner-plan-collapsed > summary.execution-plan-head {
    position: relative; list-style: none; align-items: center; min-height: 4.25rem; margin: 0; padding: .9rem 3rem .9rem 1.1rem; cursor: pointer;
  }
  .planner-plan-collapsed > summary::-webkit-details-marker { display: none; }
  .planner-plan-collapsed > summary::after {
    content: ""; position: absolute; right: 1.2rem; top: 50%; width: .45rem; height: .45rem;
    border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
    transform: translateY(-65%) rotate(45deg); transition: transform .15s ease;
  }
  .planner-plan-collapsed[open] > summary::after { transform: translateY(-35%) rotate(225deg); }
  .planner-plan-collapsed[open] > summary { border-bottom: 1px solid var(--glass-border); }
  .planner-plan-body { padding: 1rem 1.15rem 1.15rem; }
  .plan-lock { flex: none; padding: .3rem .6rem; border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground); background: color-mix(in srgb, var(--muted) 50%, transparent); font-size: .7rem; }
  .execution-plan { display: grid; gap: .75rem; }
  .execution-plan p { margin: .2rem 0 0; line-height: 1.55; white-space: pre-wrap; }
  .execution-plan ol, .execution-plan ul { display: grid; gap: .45rem; margin: .35rem 0 0; padding-left: 1.3rem; }
  .execution-plan li { padding-left: .15rem; line-height: 1.45; overflow-wrap: anywhere; }
  .execution-milestones { padding: .85rem .9rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 2px); background: color-mix(in srgb, var(--muted) 36%, transparent); }
  .execution-milestones li::marker { color: var(--muted-foreground); font: 500 .7rem var(--font-mono); }
  .execution-support { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
  .execution-support > div, .execution-proof { padding: .8rem .85rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--glass) 74%, transparent); }
  .execution-proof li::marker { content: "✓  "; color: var(--running); }
  .execution-plan-compact { gap: .55rem; margin-top: .4rem; }
  .execution-plan-compact .execution-support { grid-template-columns: 1fr; }
  .plan-editor { margin-top: .9rem; padding-top: .75rem; border-top: 1px solid var(--glass-border); }
  .plan-editor > summary { width: fit-content; color: var(--muted-foreground); cursor: pointer; font-size: .8rem; font-weight: 600; }
  .plan-editor form { margin-top: .7rem; }
  .plan-editor textarea { width: 100%; font-family: var(--font-mono); font-size: .75rem; line-height: 1.55; }
  .milestone-progress-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .milestone-progress-head h2 { margin: .15rem 0 0; }
  .milestone-progress-count { flex: none; padding: .28rem .58rem; border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground); background: color-mix(in srgb, var(--muted) 45%, transparent); font-size: .7rem; font-weight: 600; }
  .milestone-list { list-style: none; margin: .75rem 0 0; padding: 0; display: grid; gap: .4rem; }
  .milestone { display: flex; align-items: baseline; gap: .5rem; padding: .5rem .65rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--glass) 74%, transparent); overflow-wrap: anywhere; }
  .milestone-badge { display: inline-flex; align-items: center; gap: .35rem; flex: none; padding: .08rem .45rem; border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground); background: color-mix(in srgb, var(--muted) 36%, transparent); font-size: .67rem; font-weight: 600; letter-spacing: .01em; }
  .milestone-badge::before { content: ""; width: .38rem; height: .38rem; border-radius: 999px; background: color-mix(in srgb, var(--muted-foreground) 55%, transparent); }
  .milestone-current .milestone-badge { color: var(--foreground); }
  .milestone-current .milestone-badge::before { background: var(--running); box-shadow: 0 0 0 2px color-mix(in srgb, var(--running) 13%, transparent); }
  .milestone-completed .milestone-badge::before { background: var(--success, var(--running)); }
  .milestone-blocked .milestone-badge::before { background: var(--warning); }
  .milestone-progress-note { margin: .7rem .1rem 0; }
  .plan-revision-pending { margin-top: .85rem; padding: .85rem .9rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 2px); background: color-mix(in srgb, var(--running-soft) 30%, transparent); }
  .plan-revision-pending h3 { margin: .15rem 0 .35rem; font-size: 1rem; letter-spacing: -.02em; }
  .plan-revision-pending > p { margin: .3rem 0; }
  .plan-revision-pending form { margin-top: .6rem; display: inline-flex; gap: .4rem; align-items: center; }
  .plan-revision-pending form + form { margin-left: .5rem; }
  .plan-revision > h2 { margin: .15rem 0 .35rem; color: var(--foreground); font-size: 1rem; letter-spacing: -.02em; }
  .plan-revision > p.meta { margin-top: 0; }
  .plan-revision-history { margin-top: .85rem; }
  .plan-revision-history > summary { cursor: pointer; color: var(--muted-foreground); font-size: .8rem; font-weight: 600; }
  .planner-status { display: flex; gap: .8rem; align-items: flex-start; }
  .planner-orb { position: relative; flex: 0 0 2.15rem; width: 2.15rem; height: 2.15rem; border-radius: .75rem; background: var(--running-soft); }
  .planner-orb::after { content: ""; position: absolute; inset: .65rem; border-radius: 999px; background: var(--running); animation: pulse 1.25s ease-in-out infinite; }
  .planner-status p { margin: 0; }
  .planner-status .meta { display: block; margin-top: .2rem; }
  .ceremony-road { margin: .75rem 0 0; }
  .button-link {
    display: inline-flex; align-items: center; justify-content: center; min-height: 2.25rem; padding: 0 .875rem;
    border-radius: calc(var(--radius) - 2px); background: var(--primary); color: var(--primary-foreground);
    font-weight: 600; font-size: .8125rem; text-decoration: none; border: 1px solid var(--primary);
  }
  .props .row { padding: .4375rem .375rem; align-items: baseline; }
  .props .row .meta { flex: 0 0 6.5rem; }
  .props .row .mono { flex: 1 1 10rem; min-width: 0; overflow-wrap: anywhere; }
  .props .row .seal { margin-right: .375rem; }
  details.section { border: 0; background: transparent; padding: 0; margin: 1.25rem 0 0; border-radius: 0; box-shadow: none; }
  details.section[open] { padding-bottom: 0; }
  details.section > summary { list-style: none; display: flex; align-items: center; padding: .25rem 0; min-height: 2.25rem; }
  details.section > summary::-webkit-details-marker { display: none; }
  details.section > summary h2 { margin: 0; flex: 1; display: flex; align-items: center; gap: .4rem; }
  details.section > summary h2 .lane-count { border: 1px solid var(--border); border-radius: 999px; padding: .04rem .5rem; font-weight: 500; color: var(--muted-foreground); font-size: .6875rem; }
  details.section > summary::after {
    content: ""; width: .45rem; height: .45rem; flex: none; margin-right: .375rem;
    border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
    transform: rotate(45deg) translateY(-.125rem); transition: transform .15s;
  }
  details.section[open] > summary::after { transform: rotate(225deg) translateY(-.125rem); }
  @media (hover: hover) and (pointer: fine) { details.section > summary:hover h2 { color: var(--foreground); } }
  .task-layout > .task-main { min-width: 0; }
  .task-rail { position: sticky; top: 1rem; }
  .task-rail .card { margin-top: .75rem; }
  .task-rail .mono { overflow-wrap: anywhere; }
  main:has(.task-layout) { max-width: 76rem; }
  @media (max-width: 980px) {
    .task-layout { grid-template-columns: 1fr; }
    .cockpit { grid-template-columns: 1fr; }
    .cockpit-queue { position: static; padding-bottom: .75rem; margin-bottom: .5rem; border-bottom: 1px solid var(--border); }
    .cockpit-queue-list { max-height: 15rem; }
    .task-rail { position: static; order: -1; border-bottom: 1px solid var(--border); padding-bottom: .75rem; margin-bottom: .75rem; }
    .acts-bar form.inline, .acts-bar .primary, .acts-bar .primary form { flex: 1 1 auto; }
    .acts-bar .primary { flex-basis: 100%; }
    .acts-bar .primary button { width: 100%; }
    .acts-bar .act-hold { flex-wrap: wrap; }
    .acts-bar .act-hold input[type=text] { flex: 1 1 8rem; width: auto; }
    .dependency-repair-actions { align-items: stretch; }
    .dependency-repair-actions form { flex: 1 1 10rem; }
    .dependency-repair-actions .dependency-repair-replace { flex-basis: 100%; }
    .dependency-repair-actions select { flex: 1 1 auto; min-width: 0; max-width: none; }
    .dependency-repair-actions button { white-space: nowrap; }
    .split { grid-template-columns: 1fr; }
    .list-pane { display: none; }
    .workbench-mobile-rail, .workbench-mobile-back { display: block; }
    .workbench-mobile-rail { margin-top: 1.75rem; border-top: 1px solid var(--border); padding-top: .75rem; }
    .workbench-mobile-back { margin: 0 0 1rem; }
  }
  @media (max-width: 620px) {
    .planner-plan { padding: 1rem; }
    details.planner-plan-collapsed { padding: 0; }
    .planner-plan-collapsed > summary.execution-plan-head { padding: .8rem 2.5rem .8rem .9rem; }
    .planner-plan-collapsed > summary .plan-lock { display: none; }
    .planner-plan-body { padding: .85rem .9rem 1rem; }
    .execution-plan-head { flex-direction: column; align-items: flex-start; gap: .55rem; }
    .execution-support { grid-template-columns: 1fr; }
    .plan-lock { white-space: nowrap; }
    .milestone-progress-head { align-items: center; }
    .milestone-progress-count { padding-inline: .48rem; }
    .milestone { align-items: flex-start; padding: .55rem; }
    .plan-revision-pending form { display: flex; width: 100%; }
    .plan-revision-pending form + form { margin-left: 0; margin-top: .4rem; }
    .plan-revision-pending button { width: 100%; }
  }

  /* Work (workspace package 1): a quiet list of rows and dividers, never
     another grid of cards. The status line is the same component every
     surface renders for a run — a small dot in the tone, neutral words. */
  .work-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .work-head h1 { margin-bottom: .25rem; }
  .work-tools { display: none; position: relative; flex: none; margin: .25rem 0 0; border: 0; padding: 0; background: none; border-radius: 0; }
  .app.sidebar-collapsed .work-tools { display: block; }
  .work-tools > summary {
    list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: .3rem;
    min-height: 2.25rem; padding: 0 .75rem; border: 1px solid var(--border); border-radius: 999px;
    font-size: .8125rem; font-weight: 500; color: var(--foreground); background: var(--card);
  }
  .work-tools > summary::-webkit-details-marker { display: none; }
  .work-tools > summary .chevron { width: .875rem; height: .875rem; }
  .work-tools[open] > summary .chevron { transform: rotate(180deg); }
  .work-tools-menu {
    position: absolute; right: 0; top: calc(100% + .375rem); z-index: 20; min-width: 11rem; max-width: calc(100vw - 2rem);
    display: flex; flex-direction: column; padding: .375rem; border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px);
    background: var(--card); box-shadow: var(--shadow);
  }
  .work-tools-menu a { display: block; padding: .5rem .625rem; border-radius: .5rem; text-decoration: none; color: var(--foreground); font-size: .875rem; }
  @media (hover: hover) and (pointer: fine) { .work-tools-menu a:hover { background: var(--muted); } }
  /* The result panel (workspace package 3): one presentation of a finished
     result for the run page, the review cockpit, and the chat's result
     detail — the deliverable first, problems ahead of readiness words,
     three local views, and Request changes beside it. */
  .result-panel { position: relative; padding: 1.1rem 1.2rem 1rem; min-width: 0; }
  .result-back { margin: 0 0 .4rem; font-size: .8125rem; }
  /* A comfortable target at every width (repair 2026-09-14): 44px tall. */
  .result-back a { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 .35rem; margin-left: -.35rem; border-radius: .375rem; text-decoration: none; font-weight: 550; }
  .result-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
  .result-head h2 { margin: .15rem 0 0; font-size: 1.15rem; }
  .result-head .eyebrow { overflow-wrap: anywhere; }
  .result-head .status-line { flex: none; font-size: .8125rem; }
  .result-summary { max-width: 46rem; margin: .6rem 0 0; font-size: .95rem; line-height: 1.5; }
  .result-action { margin: .7rem 0 0; }
  .result-action form { margin: 0; }
  .result-action .button-link { min-height: 2.5rem; gap: .35rem; }
  .result-action .button-link .meta { color: inherit; opacity: .78; font-weight: 500; }
  .result-notes, .result-details, .result-notes[open], .result-details[open] { margin: .6rem 0 0; padding: 0; border: 0; background: none; box-shadow: none; }
  .result-notes > summary, .result-details > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; gap: .5rem; min-height: 2.5rem; padding: 0 .25rem; margin: 0 -.25rem;
    border-radius: .375rem; font-size: .8125rem; font-weight: 550; color: var(--muted-foreground);
  }
  .result-notes > summary::-webkit-details-marker, .result-details > summary::-webkit-details-marker { display: none; }
  .result-notes > summary::before, .result-details > summary::before { content: "▸"; }
  .result-notes[open] > summary::before, .result-details[open] > summary::before { content: "▾"; }
  @media (hover: hover) and (pointer: fine) { .result-notes > summary:hover, .result-details > summary:hover { color: var(--foreground); } }
  .result-details > summary .meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: .68rem; font-weight: 400; }
  .result-notes .recap { margin: .25rem 0 .4rem; font-size: .875rem; }
  .result-attention { margin: .75rem 0 .25rem; padding: .7rem .85rem; border-left: 1px solid var(--warning); border-radius: 0 calc(var(--radius) - 3px) calc(var(--radius) - 3px) 0; background: var(--warning-soft); font-size: .8125rem; }
  .result-attention strong { display: block; font-size: .78rem; }
  .result-you-check { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem .75rem; margin: .75rem 0; padding: .65rem .85rem; border-radius: calc(var(--radius) - 3px); background: var(--muted); font-size: .8125rem; }
  .result-you-check ul { flex: 1 1 14rem; min-width: 0; margin: 0; padding: 0; list-style: none; }
  .result-you-check form { margin: 0; }
  .result-attention ul { margin: .3rem 0 0; padding-left: 1.15rem; }
  .result-attention li { margin: .15rem 0; overflow-wrap: anywhere; }
  .result-tabs { display: flex; gap: .25rem; margin: .9rem 0 .75rem; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
  .result-tabs::-webkit-scrollbar { display: none; }
  .result-tabs a {
    display: inline-flex; align-items: center; gap: .4rem; flex: none; min-height: 2.5rem; padding: 0 .625rem;
    margin-bottom: -1px; border-bottom: 2px solid transparent; text-decoration: none;
    color: var(--muted-foreground); font-size: .875rem; font-weight: 500;
  }
  .result-tabs a .count { font-family: var(--font-mono); font-size: .6875rem; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
  .result-tabs a[aria-selected="true"] { color: var(--foreground); border-bottom-color: var(--foreground); }
  .result-tabs a[aria-selected="true"] .count { color: var(--foreground); }
  .result-view { min-width: 0; }
  .result-view[hidden] { display: none; }
  .result-visuals { margin-top: .25rem; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); }
  .result-unavailable { margin: .5rem 0 0; padding-left: 1.15rem; font-size: .78rem; }
  .result-changes { margin: .25rem 0 .5rem; padding-left: 1.15rem; font-size: .875rem; }
  .result-changes li { margin: .2rem 0; overflow-wrap: anywhere; }
  .result-files li, .result-files .mono { overflow-wrap: anywhere; white-space: normal; }
  .result-files li { min-width: 0; }
  .result-section[data-cockpit-source="reviewer"] li { overflow-wrap: anywhere; }
  @media (max-width: 760px) { .result-panel .pick-file, .result-panel .pick-line, .diff-modes button { min-height: 44px; min-width: 44px; white-space: nowrap; } }
  .result-files-lead { margin: .25rem 0 .5rem; font-size: .8125rem; overflow-wrap: anywhere; }
  .result-report h3 { margin: .2rem 0 .3rem; font-size: 1rem; }
  .result-report .plan-doc { max-height: 28rem; overflow: auto; }
  .result-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .5rem; margin: .4rem 0 0; }
  .result-facts > div { min-width: 0; padding: .6rem .7rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--glass-strong) 64%, transparent); }
  .result-facts dt { color: var(--muted-foreground); font: 500 .75rem/1.3 var(--font-sans); }
  .result-facts dd { margin: .2rem 0 0; font-size: .78rem; line-height: 1.4; overflow-wrap: anywhere; }
  .result-facts dd p { margin: 0; }
  .result-facts dd form { margin: .35rem 0 0; }
  .result-stat { margin: .2rem 0 .4rem; }
  .result-files { margin: .4rem 0 .6rem; }
  .result-label { display: block; margin: .5rem 0 .25rem; font: 600 .6875rem/1.3 var(--font-mono); color: var(--muted-foreground); letter-spacing: .06em; text-transform: uppercase; }
  .result-verdict { align-items: center; }
  .result-verdict > .meta { min-width: 0; overflow-wrap: anywhere; }
  .result-request { margin-top: 1.1rem; padding-top: .9rem; border-top: 1px solid var(--border); }
  .result-request h3 { margin: 0 0 .5rem; font-size: .8rem; letter-spacing: .02em; text-transform: uppercase; color: var(--muted-foreground); }
  .result-request .diff-comment-form { margin: .5rem 0 0; padding: 0; border: 0; background: none; box-shadow: none; }
  .result-request .diff-comment-form textarea { width: 100%; box-sizing: border-box; }
  .result-pin, .result-pin[open] { margin: 0; padding: 0 .2rem; border: 0; background: none; }
  .result-pin > summary { min-height: 2.25rem; display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; font-size: .78rem; font-weight: 550; cursor: pointer; list-style: none; }
  .result-pin > summary::-webkit-details-marker { display: none; }
  .result-pin > summary::before { content: "▸"; }
  .result-pin[open] > summary::before { content: "▾"; }
  .result-pin > summary .meta { font-weight: 400; }
  .result-pin .diff-comment-target { margin: .25rem 0 .5rem; }
  .revision-card, .revision-lineage, .task-history, .diff-comment p { min-width: 0; overflow-wrap: anywhere; }
  .result-feedback-history > summary, .task-history > summary, .task-history a { display: inline-flex; align-items: center; min-height: 44px; padding: .25rem .5rem; }
  .task-history > summary::before { content: "▸"; margin-right: .35rem; }
  .task-history[open] > summary::before { content: "▾"; }
  .task-history li { margin: .25rem 0; }
  .result-revision { margin: .6rem 0; padding: .6rem .75rem; border: 1px solid color-mix(in srgb, var(--running) 24%, var(--glass-border)); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--running) 6%, var(--glass-strong)); font-size: .8125rem; overflow-wrap: anywhere; }
  .result-links { display: flex; flex-wrap: wrap; gap: .25rem .5rem; margin: .6rem 0 0; }
  .result-links a { font-weight: 550; }
  .result-links a + a::before { content: "·"; margin-right: .5rem; color: var(--muted-foreground); font-weight: 400; }
  .cockpit-detail .result-panel { margin: .85rem 0; }
  .cockpit-accept { margin-top: .75rem; }
  /* The result beside the conversation (package 3): with room, two
     columns and no second auxiliary panel; without it, the dedicated
     result view with Back to chat and the conversation out of the way. */
  .chat-result { min-width: 0; }
  .task-chat-workspace.result-open { grid-template-columns: minmax(0, 30rem) minmax(0, 1fr); align-items: start; }
  .task-chat-workspace.result-open .chat-main { max-width: none; }
  /* Said once: while the result detail is open beside the conversation,
     the receipt in the thread keeps its heading, status, and roads only. */
  .result-open .completion-receipt > :not(.receipt-head):not(.receipt-actions) { display: none; }
  @media (max-width: 1199px) {
    .task-chat-workspace.result-open { display: block; }
    .task-chat-workspace.result-open .chat-main, .task-chat-workspace.result-open .task-chat-agents { display: none; }
    main:has(.chat-workspace.result-open) { padding-bottom: calc(5rem + env(safe-area-inset-bottom, 0rem)); }
  }
  @media (max-width: 359px) {
    .result-tabs a .count { display: none; }
    .result-panel { padding-inline: .7rem; }
  }
  .work-views { display: flex; gap: .25rem; margin: .75rem 0 .5rem; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
  .work-views::-webkit-scrollbar { display: none; }
  .work-views a {
    display: inline-flex; align-items: center; gap: .4rem; flex: none; min-height: 2.5rem; padding: 0 .625rem;
    margin-bottom: -1px; border-bottom: 2px solid transparent; text-decoration: none;
    color: var(--muted-foreground); font-size: .875rem; font-weight: 500;
  }
  .work-views a .count { font-family: var(--font-mono); font-size: .6875rem; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
  .work-views a.active { color: var(--foreground); border-bottom-color: var(--foreground); }
  .work-views a.active .count { color: var(--foreground); }
  .work-list { display: flex; flex-direction: column; }
  .work-row {
    display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: .5rem 1.5rem; align-items: start;
    padding: .75rem 0; border-bottom: 1px solid var(--border);
  }
  .work-row:last-child { border-bottom: 0; }
  .work-row-main, .work-row-status { min-width: 0; }
  /* Concise rows (2026-09-13): the status, the next act, and the Details
     toggle share one wrapping line; an opened disclosure is wider than
     its summary, so it wraps onto its own full-width line by itself. */
  .work-row-status { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .875rem; }
  .work-details, .work-details[open] { max-width: 100%; margin: 0; padding: 0; border: 0; background: none; border-radius: 0; }
  .work-details > summary {
    list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: .25rem;
    min-height: 2.25rem; padding: 0 .25rem; margin: 0 -.25rem; border-radius: .375rem;
    font-size: .8125rem; font-weight: 500; color: var(--muted-foreground);
  }
  .work-details > summary::-webkit-details-marker { display: none; }
  .work-details > summary::before { content: "▸"; }
  .work-details[open] > summary::before { content: "▾"; }
  @media (hover: hover) and (pointer: fine) { .work-details > summary:hover { color: var(--foreground); } }
  .work-title { display: block; font-weight: 600; font-size: .9375rem; line-height: 1.35; color: var(--foreground); text-decoration: none; overflow-wrap: anywhere; }
  @media (hover: hover) and (pointer: fine) { .work-title:hover { text-decoration: underline; } }
  .work-meta { display: flex; flex-wrap: wrap; gap: .25rem .625rem; margin: .25rem 0 0; font-size: .75rem; color: var(--muted-foreground); }
  .work-meta .mono { overflow-wrap: anywhere; }
  .project-label { display: inline-block; padding: 0 .4rem; border: 1px solid var(--border); border-radius: 999px; font-size: .6875rem; line-height: 1.5; color: var(--foreground); }
  .work-detail { margin: 0 0 .25rem; font-size: .8125rem; line-height: 1.45; color: var(--muted-foreground); overflow-wrap: anywhere; }
  .work-details .work-id { margin: 0 0 .25rem; }
  .work-action { display: inline-flex; align-items: center; min-height: 44px; font-size: .8125rem; font-weight: 500; }
  .work-empty { padding: 2rem 0 1rem; max-width: 34rem; }
  .work-empty p { margin: 0 0 .75rem; color: var(--muted-foreground); line-height: 1.5; }
  .work-empty .row { display: flex; align-items: center; gap: 1rem; }
  .work-empty .row > a { display: inline-flex; align-items: center; min-height: 44px; }
  .work-bound { margin-top: .75rem; }
  .status-line { display: inline-flex; align-items: center; gap: .45rem; min-width: 0; font-size: .875rem; font-weight: 600; color: var(--foreground); }
  .status-line .status-label { min-width: 0; overflow-wrap: anywhere; }
  .status-line .status-dot { flex: none; width: .5rem; height: .5rem; border-radius: 50%; background: var(--muted-foreground); }
  .status-line[data-tone="attention"] .status-dot { background: var(--warning); }
  .status-line[data-tone="problem"] .status-dot { background: var(--destructive); }
  .status-line[data-tone="live"] .status-dot { background: var(--running); box-shadow: 0 0 0 3px var(--running-soft); }
  .status-line[data-tone="ready"] .status-dot, .status-line[data-tone="done"] .status-dot { background: var(--success); }
  .status-line[data-tone="muted"] { color: var(--muted-foreground); font-weight: 500; }
  .status-line[data-tone="muted"] .status-dot { background: var(--border); }
  .pull-request { display: grid; gap: .35rem; }
  .pull-request p { margin: 0; overflow-wrap: anywhere; }
  .pull-request-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .75rem; }
  .pull-request-head a, .pull-request .meta a { display: inline-flex; align-items: center; min-height: 44px; }
  .pull-request-head strong { font-size: 1.0625rem; font-weight: 600; color: var(--foreground); display: inline-flex; align-items: center; gap: .5rem; }
  .pull-request-head strong::before { content: ""; width: .5rem; height: .5rem; border-radius: 999px; background: var(--muted-foreground); }
  .pull-request--ok .pull-request-head strong::before { background: var(--success, #15803d); }
  .pull-request--problem .pull-request-head strong::before { background: var(--so-warning, #ab6400); }
  .pull-request-act { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .5rem .75rem; margin: .25rem 0 0; }
  .pull-request-act .meta { flex: 1 1 100%; }
  .pull-request-act label { display: grid; gap: .25rem; flex: 1 1 12rem; margin: 0; }
  .pull-request-act label input { margin: 0; min-height: 44px; box-sizing: border-box; width: 100%; }
  .pull-request-act button { min-height: 44px; white-space: nowrap; }
  .result-complete-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  .result-complete-actions button { white-space: nowrap; }
  .result-complete-actions button[name=publish], .pull-request-act button { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  @media (max-width: 480px) { .pull-request-act button, .result-complete-actions button { flex: 1 1 100%; } }
  .receipt-publication { position: relative; z-index: 1; margin: .35rem 0 0; font-size: .8125rem; color: var(--muted-foreground); }
  /* A raw repository path in ordinary copy wraps at any point rather than
     widening the page (the phone task-list overflow, package 1). */
  .path-words { overflow-wrap: anywhere; word-break: break-word; }
  @media (max-width: 760px) {
    .work-row { grid-template-columns: minmax(0, 1fr); gap: .125rem; padding: .625rem 0; }
    .work-head { align-items: center; }
    .work-head h1 { margin-bottom: 0; }
    .work-details > summary, .work-action { min-height: 44px; }
    /* The tools control sits at the head's right edge on every width, so
       its menu keeps the desk's right-aligned anchor here too. A phone
       override once re-anchored it at left: 0, which pushed the opened
       menu past the viewport (right edge 441.5px at 390px) and widened
       the document — found by the independent concise-UI review. */
    /* All four filters share the row (review fixes, finding 3): each tab
       takes an equal share, no tab scrolls out of view, the count sits on
       the label, and every target stays ≥ 40px tall. */
    .work-views { gap: 0; margin: .5rem 0 .25rem; overflow: visible; }
    .work-views a { flex: 1 1 0; min-width: 0; justify-content: center; padding: 0 .25rem; font-size: .8125rem; gap: .3rem; white-space: nowrap; }
  }
  @media (max-width: 400px) {
    .work-views a { font-size: .75rem; gap: .2rem; padding: 0 .125rem; }
    .work-views a .count { font-size: .625rem; }
  }
  /* The narrowest phones (≤ 360px): four labels with counts cannot share
     288px at legible type, so the strip becomes two rows of two — every
     filter wholly visible, unclipped, 40px tall, never scrolled away. */
  @media (max-width: 360px) {
    .work-views { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .work-views a { font-size: .8125rem; gap: .3rem; padding: 0 .25rem; }
    .work-views a .count { font-size: .6875rem; }
  }

  /* The phone shell: the sidebar disappears; a top bar carries the project
     and quick capture; a bottom tab bar carries the destinations a thumb
     visits. Desktop is untouched. */
  .mobile-top, .tabbar { display: none; }
  @media (max-width: 760px) {
    .app { display: block; }
    .side { display: none; }
    .mobile-top {
      display: flex; align-items: center; gap: .5rem; position: sticky; top: 0; z-index: 30;
      background: var(--glass-strong); border-bottom: 1px solid var(--glass-border);
      padding: calc(.375rem + env(safe-area-inset-top, 0rem)) .75rem .375rem;
    }
    /* One header row: the pill carries scope, counts, and the switch. */
    .scope-bar { display: none; }
    .mobile-top .brand-mini { font-weight: 600; font-size: .9375rem; text-decoration: none; color: var(--foreground); font-family: var(--font-mono); }
    .mobile-top .project-pill { flex: 1; min-width: 0; position: static; margin: 0; padding: 0; border: 0; background: none; box-shadow: none; }
    .mobile-top a.project-pill, .mobile-top .project-pill > summary {
      /* align-items: stretch, not the switcher's center: a centered column
         item takes its content width, and a long project name then widens
         the document (the 320px overflow, workspace package 1). */
      min-width: 0; display: flex; flex-direction: column; justify-content: center; align-items: stretch; gap: .0625rem;
      border: 1px solid var(--border); border-radius: 1.375rem; background: var(--card);
      min-height: 2.75rem; padding: .25rem .875rem; text-decoration: none; color: var(--foreground);
      font-size: .875rem; font-weight: 500; line-height: 1.25; cursor: pointer;
    }
    .mobile-top .project-pill > summary .name { display: inline-flex; align-items: center; gap: .25rem; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mobile-top .project-pill > summary .name .chevron { flex: none; }
    .mobile-top a.project-pill:active, .mobile-top .project-pill > summary:active { background: var(--muted); }
    /* On a phone the menu drops from the header it belongs to (UI polish
       2026-09-13). It was a fixed sheet, but the header's backdrop-filter
       makes the header the containing block for fixed descendants, so the
       sheet landed above the header, off-screen. Absolute to the sticky
       header is exact, and never taller than the screen. */
    .mobile-top .switcher-menu {
      position: absolute; left: .5rem; right: .5rem; top: calc(100% - .25rem); bottom: auto; max-width: none;
      max-height: calc(100dvh - 8rem); overflow-y: auto; z-index: 45;
    }
    .mobile-top .switcher-menu button { min-height: 2.75rem; }
    .mobile-top .pill-status {
      display: flex; flex-wrap: wrap; gap: .125rem .5rem;
      font-family: var(--font-mono); font-size: .6875rem; font-weight: 500;
      color: var(--muted-foreground); font-variant-numeric: tabular-nums;
    }
    .mobile-top .pill-status > span { white-space: nowrap; }
    .mobile-top .pill-status .hot { color: var(--brand); }
    .mobile-top .project-pill .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mobile-top .mobile-new {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      min-height: 2.75rem; padding: 0 .875rem; border-radius: 999px;
      background: var(--secondary); border: 1px solid var(--border); color: var(--foreground);
      font-weight: 500; font-size: .875rem; text-decoration: none;
    }
    /* Tools and settings: a header action, never a fourth tab (workspace
       package 1). A 44px target, the same quiet pill as quick capture. */
    .mobile-top .mobile-more {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      width: 2.75rem; min-height: 2.75rem; border-radius: 999px;
      border: 1px solid var(--border); background: var(--card); color: var(--foreground);
    }
    .mobile-top .mobile-more svg { width: 1.125rem; height: 1.125rem; }
    @media (max-width: 360px) { .mobile-top .mobile-new { padding: 0 .625rem; } }
    .tabbar {
      display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
      background: var(--glass-strong); border-top: 1px solid var(--glass-border);
      padding: .25rem max(.25rem, env(safe-area-inset-right, 0rem)) calc(.25rem + env(safe-area-inset-bottom, 0rem)) max(.25rem, env(safe-area-inset-left, 0rem));
    }
    .tabbar a {
      flex: 1; display: flex; flex-direction: column; align-items: center; gap: .125rem;
      padding: .375rem 0 .25rem; min-height: 3rem; text-decoration: none;
      color: var(--muted-foreground); font-size: .6875rem; font-weight: 500;
      font-family: var(--font-sans);
    }
    .tabbar a .glyph { display: flex; align-items: center; justify-content: center; height: 1.125rem; }
    .tabbar a .glyph svg { width: 1rem; height: 1rem; }
    .tabbar a.active { color: var(--foreground); }
    .tabbar a.active .glyph { background: var(--muted); border-radius: 999px; box-shadow: 0 0 0 .35rem var(--muted); }
    .tabbar a { position: relative; }
    .tabbar a .dot-badge {
      position: absolute; top: .3125rem; left: calc(50% + .375rem);
      width: .375rem; height: .375rem; border-radius: 9999px; background: var(--brand);
    }
    .content > main { padding: 1rem 1rem calc(4.5rem + env(safe-area-inset-bottom, 0rem)); }
    .project-add-card { padding: 1rem; }
    .project-add-actions { grid-template-columns: minmax(0, 1fr); }
    .project-add-action { min-height: 5.25rem; padding: .75rem; }
    .project-add-more > summary { width: 100%; }
  }

  /* /menu mirrors the rail's workflows/admin grouping as plain headed
   * sections — no collapse: it is already one tap behind the tab bar. */
  .menu-group-label {
    margin: 1.5rem 0 .25rem; font-size: .75rem; font-weight: 600;
    color: var(--muted-foreground); font-family: var(--font-sans);
  }
  .menu-group-label:first-of-type { margin-top: .75rem; }
  .menu-list { display: flex; flex-direction: column; gap: .375rem; margin-top: .75rem; }
  .menu-row {
    display: flex; flex-direction: column; gap: .125rem; text-decoration: none;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
    padding: .75rem .875rem; color: var(--foreground); min-height: 44px; justify-content: center;
  }
  @media (hover: hover) and (pointer: fine) { .menu-row:hover { border-color: color-mix(in srgb, var(--border) 60%, var(--muted-foreground)); } }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr)); gap: .625rem; margin: .5rem 0; }
  .stat-card {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
    padding: .75rem .875rem; min-width: 0;
  }
  .stat-card .k { font-weight: 600; font-size: .875rem; display: flex; align-items: center; gap: .4rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat-card .v { font-size: .75rem; color: var(--muted-foreground); margin-top: .25rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 9999px; flex: none; }
  .dot-ok { background: var(--success); }
  /* Caution without a claim on the operator: quiet, not magenta. */
  .dot-warn { background: var(--muted-foreground); }
  .dot-off { background: var(--muted-foreground); opacity: .5; }
  .dot-bad { background: var(--destructive); }
  .pulse { animation: pulse 2s ease-in-out infinite; }
  .dot-ok.pulse { background: var(--running); }
  @keyframes pulse { 50% { opacity: .35; } }

  .login-viewport { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem 1.25rem; }
  .login-shell { width: 100%; max-width: 23rem; }
  .login-shell h1 { text-align: center; margin: 0 0 .375rem; font-size: 1.5rem; letter-spacing: -0.02em; }
  .login-shell > .hint { text-align: center; margin: 0 0 2rem; font-size: 0.875rem; }
  .login-card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 1.5rem 1.5rem 1.625rem;
  }
  .login-card label:first-child { margin-top: 0; }
  .login-card .problem { margin: 0 0 1rem; }
  .login-shell button {
    width: 100%; margin-top: 1.25rem;
    background: var(--so-accent); color: var(--so-on-accent); border-color: var(--so-accent); font-weight: 600;
  }
  @media (hover: hover) and (pointer: fine) { .login-shell button:hover { background: var(--so-accent-hover); border-color: var(--so-accent-hover); } }
  .login-foot { text-align: center; margin: 1.5rem 0 0; font-size: 0.75rem; color: var(--muted-foreground); line-height: 1.9; }
  .login-foot code { background: none; padding: 0; color: var(--muted-foreground); white-space: nowrap; }
  .so-wordmark { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; letter-spacing: -.02em; color: var(--foreground); }
  .so-brand-mark { width: 18px; height: 22px; display: flex; align-items: center; gap: 3px; transform: skewY(-10deg); }
  .so-brand-mark i { display: block; width: 4px; height: 15px; background: var(--so-signal); border-radius: 1px; }
  .so-brand-mark i:nth-child(2) { height: 22px; }
  .login-shell .login-brand { justify-content: center; font-size: 1.125rem; margin: 0 0 1.5rem; }
  .sso-step-up { display: inline-flex; align-items: center; min-height: 36px; font-size: .9rem; }
  .sso-step-up[data-sso-step-up="confirmed"] { color: var(--so-success); }
  .sso-step-up[data-sso-step-up="confirmed"]::before { content: "✓"; margin-right: 6px; }
  .login-shell .login-sso { display: flex; justify-content: center; align-items: center; min-height: 44px; border-radius: 8px; background: var(--so-accent); color: var(--so-on-accent); font-weight: 600; text-decoration: none; margin: 0 0 1rem; }
  @media (hover: hover) and (pointer: fine) { .login-shell .login-sso:hover { background: var(--so-accent-hover); } }
  .login-shell .login-password > summary { text-align: center; font-size: .875rem; color: var(--muted-foreground); cursor: pointer; margin: 0 0 .75rem; }
  .focus-page { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
  .focus-page .focus-brand { display: inline-flex; margin: 0 0 2.5rem; }
  .focus-page h1 { margin: 0 0 1rem; }
  .secret-value { overflow-wrap: anywhere; font-size: .95rem; padding: .75rem .875rem; margin: .75rem 0; border: 1px solid var(--border); border-radius: 8px; background: var(--background); user-select: all; }

  @media (max-width: 640px) {
    button, form.option button { min-height: 2.75rem; }
    .topbar nav a { padding: 0 .5rem; }
  }

  /* The board: lanes as columns, the pipeline left to right. */
  .content > main:has(.board) { max-width: none; }
  .board {
    display: grid; grid-template-columns: repeat(5, minmax(12.5rem, 1fr));
    gap: .625rem; overflow-x: auto; padding-bottom: .75rem; align-items: start;
  }
  /* The phone board (board pass): lanes stack as sections that fold, the
     counts readable before a single card — what needs you, then what is
     building, then the rest. A header is a 2.75rem tap; a drawn chevron
     says which way it folds. */
  @media (max-width: 760px) {
    .board { display: flex; flex-direction: column; gap: .5rem; padding-bottom: 0; }
    .board .lane { min-height: 0; padding: 0 .625rem .125rem; }
    .board .lane > summary {
      cursor: pointer; display: flex; align-items: center; min-height: 2.75rem; margin: 0;
      -webkit-tap-highlight-color: transparent;
    }
    .board .lane > summary h2 { flex: 1; font-size: .75rem; }
    .board .lane > summary .lane-count { border: 1px solid var(--border); border-radius: 999px; padding: .04rem .5rem; margin-left: .25rem; }
    .board .lane > summary::after {
      content: ""; width: .5rem; height: .5rem; flex: none; margin-right: .25rem;
      border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
      transform: rotate(45deg) translateY(-.125rem); transition: transform .15s;
    }
    .board .lane[open] > summary::after { transform: rotate(225deg) translateY(-.125rem); }
    .board .lane .hint { margin-bottom: .25rem; }
    .board .lane .lane-card:last-of-type { margin-bottom: .5rem; }
    .board .lane-attention { order: 0; }
    .board .lane-building { order: 1; }
    .board .lane-queued { order: 2; }
    .board .lane-waiting { order: 3; }
    .board .lane-done { order: 4; }
  }
  .lane {
    background: color-mix(in srgb, var(--card) 45%, var(--background)); border: 1px solid var(--border);
    border-radius: var(--radius); padding: .625rem; min-height: 12rem;
  }
  .lane > summary { list-style: none; cursor: default; margin: 0 0 .125rem; }
  .lane > summary::-webkit-details-marker { display: none; }
  .lane h2 { display: flex; align-items: center; gap: .4rem; margin: 0; font-size: .6875rem; }
  .lane h2 a { color: inherit; text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { .lane h2 a:hover { text-decoration: underline; } }
  .lane .hint { margin-top: 0; }
  .lane-count { color: var(--muted-foreground); font-weight: 400; font-variant-numeric: tabular-nums; }
  .lane h2::before {
    content: ""; width: .375rem; height: .375rem; border-radius: 9999px; flex: none;
    background: var(--muted-foreground); opacity: .55;
  }
  .lane-attention h2::before { background: var(--brand); opacity: 1; }
  .lane-building h2::before { background: var(--running); opacity: 1; }
  .lane-done h2::before { background: var(--success); opacity: 1; }
  .lane-card {
    display: block; text-decoration: none; color: inherit;
    background: var(--card); border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px); padding: .5rem .625rem; margin-top: .5rem;
  }
  @media (hover: hover) and (pointer: fine) { .lane-card:hover { border-color: color-mix(in srgb, var(--border) 55%, var(--muted-foreground)); } }
  .lane-card .id { display: block; font-family: var(--font-mono); font-size: .6875rem; color: var(--muted-foreground); margin-bottom: .125rem; overflow-wrap: anywhere; }
  .lane-card .t { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; }
  .lane-card .dot { margin-right: .4rem; }
  .lane-card .meta, .lane-card .mono { display: block; margin-top: .125rem; font-size: .75rem; }
  .lane-card .why { display: block; margin-top: .125rem; font-size: .75rem; color: var(--muted-foreground); }
  /* The facts: mono key–value pairs, keys dim, values ink — one grammar on every lane. */
  .lane-card .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .0625rem .625rem; margin-top: .4rem; font-size: .6875rem; line-height: 1.5; }
  .lane-card .fact { display: contents; }
  .lane-card .fact .k { color: var(--muted-foreground); font-family: var(--font-mono); }
  .lane-card .fact .v { font-family: var(--font-mono); color: var(--foreground); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .lane-card .chips { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .4rem; }
  .lane-card .chips .badge { margin: 0; }
  /* The live strip on a building card: stage and clock in an inset well —
     the run's own facts, never a percent. */
  .lane-card .live-line {
    display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-top: .375rem;
    padding: .3rem .5rem; border-radius: calc(var(--radius) - 4px); background: var(--muted);
    font-family: var(--font-mono); font-size: .6875rem; color: var(--running); font-variant-numeric: tabular-nums;
  }
  .lane-card .live-line .clock { color: var(--muted-foreground); }
  .lane-empty { margin: .75rem 0 .25rem; }
  .plan-doc { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8125rem; max-height: 24rem; overflow-y: auto; }
  .lane-more { display: block; margin-top: .5rem; font-size: .75rem; }

  /* The attended control room: one cross-workspace pulse, then a dense
     master rail. */
  .control-room-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 1rem; margin-bottom: 1.1rem;
  }
  .control-room-head h1 { font-size: 1.375rem; margin-top: .08rem; }
  .control-room-head .actions { display: flex; gap: .45rem; flex-wrap: wrap; justify-content: flex-end; }
  .control-room-head .actions a { text-decoration: none; }
  .command-metrics {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: .625rem; margin: .85rem 0 1.5rem;
  }
  .command-metric {
    border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); background: var(--card);
    padding: .8rem .9rem; min-width: 0;
  }
  .command-metric .value { display: block; margin-top: .25rem; font-size: 1.5rem; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
  .command-metric .label { display: flex; align-items: center; gap: .4rem; font-weight: 500; font-size: .8125rem; }
  .command-metric .label::before {
    content: ""; width: .375rem; height: .375rem; border-radius: 9999px;
    background: var(--muted-foreground); flex: none;
  }
  .command-metric .detail { display: block; color: var(--muted-foreground); font-size: .6875rem; margin-top: .18rem; }
  .command-metric.attention .label::before { background: var(--brand); }
  .command-metric.live .label::before { background: var(--running); }
  .workspace-pulse { margin: .4rem 0 1.5rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); gap: .625rem; }
  /* The workspace card: name and status word, four counts, the same counts
     as a bar, and the one tap to its board. Neutral border always; the
     needs-you count and the bar's segment carry the accent. */
  .workspace-card {
    padding: .75rem .9rem; border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px); background: var(--card); font-size: .8125rem; min-width: 0;
  }
  /* The lead's unified workspace: a glass project navigator beside one
     long-lived conversation. The content stays calm and legible; the
     atmosphere belongs to the shell and edges, never behind the prose. */
  main:has(.chat-workspace) { max-width: 86rem; padding-top: 1.5rem; }
  .chat-workspace {
    display: grid; grid-template-columns: minmax(16rem, 18.5rem) minmax(0, 56rem);
    align-items: start; gap: clamp(1.25rem, 3vw, 2.75rem);
  }
  .chat-workspace.projects-hidden { grid-template-columns: minmax(0, 56rem); }
  .chat-workspace.projects-hidden .chat-projects { display: none; }
  .chat-main { min-width: 0; max-width: 56rem; }
  .task-chat-workspace { grid-template-columns: minmax(15rem, 18rem) minmax(0, 56rem); }
  .task-chat-context {
    position: sticky; top: 6rem; align-self: start; padding: 1rem;
    border: 1px solid var(--glass-border); border-radius: calc(var(--radius) + 3px);
    background: var(--glass); box-shadow: var(--shadow);
  }
  .task-chat-context-head { display: flex; align-items: center; justify-content: space-between; gap: .65rem; }
  .task-chat-context h2 { margin: .7rem 0 .25rem; color: var(--foreground); font-size: 1rem; line-height: 1.35; letter-spacing: -.025em; }
  .task-chat-context > .meta { margin: 0; overflow-wrap: anywhere; font-size: .65rem; }
  .task-chat-status { display: grid; gap: .2rem; margin-top: .85rem; padding: .7rem; border-radius: calc(var(--radius) - 3px); background: var(--warning-soft); }
  .task-chat-status.ready { background: var(--running-soft); }
  .task-chat-status strong { font-size: .75rem; }
  .task-chat-status span { color: var(--muted-foreground); font-size: .68rem; line-height: 1.45; }
  .task-chat-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; margin: .65rem 0; }
  .task-chat-facts div { min-width: 0; padding: .45rem .5rem; border-radius: calc(var(--radius) - 5px); background: color-mix(in srgb, var(--muted) 58%, transparent); }
  .task-chat-facts dt { color: var(--muted-foreground); font: 400 .58rem/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: .04em; }
  .task-chat-facts dd { margin: .15rem 0 0; font-size: .68rem; overflow-wrap: anywhere; }
  .task-chat-overview-actions { display: grid; justify-items: start; gap: .55rem; margin-top: .75rem; }
  .task-chat-overview-link { display: block; font-size: .72rem; text-decoration: none; }
  .task-chat-recovery-link { min-height: 2rem; padding-inline: .7rem; font-size: .7rem; }
  #task-chat-live { display: grid; gap: 1rem; margin-bottom: 1.1rem; }
  .task-journey {
    position: relative; overflow: hidden; padding: 1rem 1.05rem;
    border-color: color-mix(in srgb, var(--accent) 16%, var(--glass-border));
    background: var(--card);
  }
  .task-journey::after { content: ""; position: absolute; width: 9rem; height: 9rem; right: -4rem; top: -5rem; border-radius: 50%; background: color-mix(in srgb, var(--accent) 8%, transparent); filter: blur(12px); pointer-events: none; }
  .task-journey-head { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .task-journey h2 { margin: .2rem 0 0; font-size: 1rem; letter-spacing: -.025em; }
  .task-journey > ol { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 0; margin: 1rem 0 .75rem; padding: 0; list-style: none; }
  .task-journey > ol::before { content: ""; position: absolute; top: .7rem; left: 10%; right: 10%; height: 1px; background: var(--border); }
  .task-journey li { position: relative; z-index: 1; display: grid; justify-items: center; gap: .35rem; color: var(--muted-foreground); font-size: .625rem; text-align: center; }
  .task-journey li i { display: grid; place-items: center; width: 1.4rem; height: 1.4rem; border: 1px solid var(--border); border-radius: 50%; background: var(--card); font: 600 .58rem/1 var(--font-mono); font-style: normal; }
  .task-journey li.complete i { color: var(--success); border-color: color-mix(in srgb,var(--success) 32%,var(--border)); background: color-mix(in srgb,var(--success) 9%,var(--card)); }
  .task-journey li.complete span { color: var(--foreground); }
  .task-journey li.active i { color: white; border-color: var(--accent); background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent); }
  .task-journey li.active span { color: var(--foreground); font-weight: 650; }
  .task-journey > .meta { margin: 0; line-height: 1.45; }
  .task-journey-action { margin-top: .75rem; min-height: 44px; }
  .check-progress {
    margin: .5rem 0 0; color: var(--running); font-size: clamp(.625rem,2.2vw,.75rem);
    line-height: 1.5; font-variant-numeric: tabular-nums; white-space: nowrap;
    overflow-x: auto; scrollbar-width: thin;
  }
  .check-progress[data-final="passed"] { color: var(--success); }
  .check-progress[data-final="failed"] { color: var(--destructive); }
  .check-progress[data-final="unknown"] { color: var(--warning); }
  .receipt-actions [data-primary-action] { min-height: 44px; }
  .task-status-reason { margin-top: .75rem; }
  .task-status-reason summary, .task-status-details > summary { color: var(--muted-foreground); }
  .task-status-details > summary { min-height: 44px; }
  .task-status-details, #task-control-details { margin: 1rem 0; }
  .task-control-copy { min-width: 0; overflow-wrap: anywhere; }
  [data-primary-action] { max-width: 100%; }

  .task-live-build { display: flex; align-items: center; flex-wrap: wrap; gap: .3rem; margin: .75rem 0 0; font-size: .72rem; }
  .task-live-build .live-dot { width: .45rem; height: .45rem; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px color-mix(in srgb,var(--success) 10%,transparent); }
  .chat-action-card { padding: 0; overflow: hidden; }
  .chat-action-card:not(details) { padding: 1rem 1.05rem; }
  .chat-action-card > summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.05rem; cursor: pointer; list-style: none; }
  .chat-action-card > summary::-webkit-details-marker { display: none; }
  .chat-action-card > summary > span:first-child { display: grid; gap: .18rem; }
  .chat-action-card > summary strong { font-size: .92rem; }
  .chat-action-card > summary small { color: var(--muted-foreground); font-size: .68rem; font-weight: 400; }
  .chat-action-card[open] > summary { border-bottom: 1px solid var(--border); }
  .chat-run-details { padding: .65rem .75rem; border: 1px solid var(--border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb,var(--muted) 45%,transparent); }
  .chat-run-details > summary { color: var(--muted-foreground); cursor: pointer; font-size: .68rem; }
  .chat-run-details > .meta { margin-bottom: 0; }
  .chat-decisions { display: grid; gap: .7rem; }
  .chat-section-head { margin: .15rem .15rem 0; }
  .chat-section-head h2 { margin: .2rem 0 0; font-size: 1rem; }
  .chat-decisions .decide-card { margin: 0; background: var(--glass); box-shadow: var(--shadow); }
  .chat-publication { margin: -.25rem .25rem .25rem; }
  .chat-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: .5rem .25rem 0; }
  .chat-head h1 { margin-bottom: .2rem; font-size: 1.65rem; letter-spacing: -.04em; }
  .chat-head .badge-running { margin-top: .2rem; background: color-mix(in srgb, var(--success) 11%, var(--glass)); color: var(--success); }
  .chat-head-actions { display: flex; align-items: center; justify-content: flex-end; gap: .45rem; flex-wrap: wrap; }
  .task-chat-head > div { min-width: 0; flex: 1; }
  .chat-task-back { margin: 0 0 .55rem; font-size: .6875rem; }
  .chat-task-back a { text-decoration: none; }
  .task-chat-title-line { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .task-chat-title-line > div { min-width: 0; }
  .chat-project-toggle {
    display: inline-flex; align-items: center; gap: .4rem; min-height: 2rem; padding: .25rem .55rem;
    color: var(--muted-foreground); font-size: .6875rem; box-shadow: none;
  }
  .chat-project-toggle svg { width: .9rem; height: .9rem; }
  .chat-project-toggle .badge { padding-inline: .38rem; font-size: .6rem; }
  .chat-budget {
    display: flex; flex-wrap: wrap; gap: .4rem; margin: 1rem 0 1.25rem;
    color: var(--muted-foreground); font-size: .6875rem; font-variant-numeric: tabular-nums;
  }
  .chat-budget > span {
    white-space: nowrap; padding: .32rem .58rem; border: 1px solid var(--glass-border);
    border-radius: 999px; background: color-mix(in srgb, var(--glass) 74%, transparent);
  }
  /* Provider, model, and limits behind one quiet disclosure (UI polish 2026-09-13). */
  .chat-limits { margin: .5rem 0 .75rem; padding: 0 .9rem; border-color: var(--glass-border); background: color-mix(in srgb, var(--glass) 70%, transparent); }
  .chat-limits > summary { display: flex; align-items: center; justify-content: space-between; gap: .75rem; min-height: 2.5rem; padding: .45rem 0; font-size: .75rem; }
  .chat-limits > summary .meta { font-size: .75rem; }
  .chat-limits[open] { padding-bottom: .6rem; }
  .chat-limits .chat-budget { margin: .2rem 0 .1rem; }
  .chat-main .chat-limits + .chat-fleet-context, .chat-main .chat-fleet-context + .chat-limits { margin-top: .5rem; }
  .chat-overview {
    margin: 0 0 1.35rem; padding: 1rem; border-radius: calc(var(--radius) + 2px);
    background: var(--glass);
    box-shadow: var(--shadow);
  }
  .chat-overview-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .chat-overview-head h2 { margin: .1rem 0 0; color: var(--foreground); font-size: .95rem; letter-spacing: -.02em; }
  .chat-overview-head form { margin: 0; }
  .chat-overview-head button, .chat-overview-link {
    min-height: 2rem; padding: .25rem .7rem; font-size: .6875rem; text-decoration: none;
  }
  .chat-overview-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .45rem; margin-top: .85rem; }
  .chat-overview-stat {
    display: flex; flex-direction: column; min-width: 0; padding: .65rem .7rem;
    border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px);
    background: color-mix(in srgb, var(--glass-strong) 64%, transparent); text-decoration: none;
  }
  @media (hover: hover) and (pointer: fine) { .chat-overview-stat:hover { background: var(--glass-strong); } }
  .chat-overview-stat b { color: var(--foreground); font: 600 1.2rem/1.2 var(--font-mono); font-variant-numeric: tabular-nums; }
  .chat-overview-stat span { overflow: hidden; color: var(--muted-foreground); font-size: .65rem; text-overflow: ellipsis; white-space: nowrap; }
  .chat-overview-stat.attention b { color: var(--warning); }
  .chat-overview-stat.live b { color: var(--running); }
  .chat-overview-items { display: grid; gap: .35rem; margin-top: .7rem; }
  .chat-overview-item {
    display: grid; grid-template-columns: 1.75rem minmax(0, 1fr) auto; align-items: center; gap: .6rem;
    padding: .48rem .55rem; border-radius: calc(var(--radius) - 4px); color: inherit; text-decoration: none;
  }
  @media (hover: hover) and (pointer: fine) { .chat-overview-item:hover { background: color-mix(in srgb, var(--muted) 72%, transparent); } }
  .chat-overview-icon { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: .55rem; background: var(--muted); color: var(--muted-foreground); }
  .chat-overview-icon svg { width: .9rem; height: .9rem; }
  .chat-overview-item.decision .chat-overview-icon { color: var(--warning); background: var(--warning-soft); }
  .chat-overview-item.failed .chat-overview-icon { color: var(--destructive); background: var(--destructive-soft); }
  .chat-overview-item.running .chat-overview-icon { color: var(--running); background: var(--running-soft); }
  .chat-overview-copy { min-width: 0; }
  .chat-overview-copy strong, .chat-overview-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-overview-copy strong { font-size: .75rem; font-weight: 500; }
  .chat-overview-copy span { color: var(--muted-foreground); font-size: .65rem; margin-top: .05rem; }
  .chat-overview-arrow { color: var(--muted-foreground); }
  .chat-overview-clear { display: flex; align-items: center; gap: .45rem; margin: .8rem .2rem 0; color: var(--muted-foreground); font-size: .75rem; }
  .chat-overview-note { margin: .65rem .2rem 0; font-size: .6875rem; }
  .chat-readonly { margin-top: 1rem; padding: 1rem; }
  .chat-projects {
    position: sticky; top: 4rem; align-self: start; max-height: calc(100vh - 5rem); overflow-y: auto;
    padding: 1rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) + 3px);
    background: var(--glass); box-shadow: var(--shadow);
  }
  .chat-projects-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .75rem; padding: 0 .15rem; }
  .chat-projects-head h2 { margin: 0; color: var(--foreground); font-size: .8125rem; letter-spacing: -.01em; }
  .chat-project-close { display: none; margin-left: auto; width: 2rem; min-height: 2rem; padding: 0; font-size: 1rem; box-shadow: none; }
  .chat-project-card {
    padding: .8rem; margin-top: .5rem; border: 1px solid transparent; border-radius: var(--radius);
    background: color-mix(in srgb, var(--muted) 58%, transparent);
    transition: transform .16s ease, background .16s, border-color .16s, box-shadow .16s;
  }
  @media (hover: hover) and (pointer: fine) { .chat-project-card:hover {
    border-color: var(--glass-border); background: color-mix(in srgb, var(--muted) 82%, transparent);
    box-shadow: 0 12px 28px -24px rgb(0 0 0 / .8);
  } }
  .chat-project-name { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .45rem; }
  .chat-project-name strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8125rem; }
  .chat-project-name .mono { color: var(--running); font-size: .6875rem; }
  .chat-project-name .badge { background: var(--glass); font-size: .625rem; }
  .chat-project-stats { display: grid; grid-template-columns: 1fr 1fr; gap: .3rem .55rem; margin-top: .65rem; }
  .chat-project-stats span { color: var(--muted-foreground); font-size: .6875rem; white-space: nowrap; }
  .chat-project-stats b { color: var(--foreground); font-family: var(--font-mono); font-weight: 600; font-variant-numeric: tabular-nums; }
  .chat-project-stats span.hot, .chat-project-stats span.hot b { color: var(--brand); }
  .chat-project-actions { display: flex; gap: .35rem; margin-top: .65rem; }
  .chat-project-actions form { margin-bottom: 0; }
  .chat-project-actions button { min-height: 1.8rem; padding: .2rem .6rem; font-size: .6875rem; box-shadow: none; background: transparent; }
  .thread {
    display: flex; flex-direction: column; gap: 1rem; margin: 1rem 0 1.25rem;
    min-height: min(32rem, 48vh); padding: .25rem;
  }
  .thread .msg { max-width: 48rem; line-height: 1.65; overflow-wrap: anywhere; }
  .chat-previous-divider { display: flex; align-items: center; gap: .6rem; margin: 1rem 0; color: var(--so-muted); font-size: .8rem; }
  .chat-previous-divider::before, .chat-previous-divider::after { content: ""; flex: 1; border-top: 1px solid var(--so-line); }
  .thread .msg p { margin: .3rem 0; }
  .thread .msg.op {
    align-self: flex-end; max-width: min(82%, 40rem); padding: .75rem 1rem;
    border: 1px solid var(--glass-border); border-radius: 1.2rem 1.2rem .35rem 1.2rem;
    background: var(--user-message); color: var(--so-ink);
    box-shadow: 0 10px 30px -24px rgb(0 0 0 / .9), 0 1px 0 rgb(255 255 255 / .07) inset;
  }
  .thread .msg.mate {
    position: relative; align-self: stretch; padding: .75rem .5rem .75rem 3.45rem;
    border: 0; background: transparent;
  }
  .thread .msg.mate::before {
    content: "T"; position: absolute; top: .7rem; left: .1rem; width: 2.35rem; height: 2.35rem;
    display: grid; place-items: center; border: 1px solid var(--glass-border); border-radius: .8rem;
    background: var(--glass-strong);
    color: var(--foreground); font: 600 .6875rem/1 var(--font-mono); letter-spacing: -.04em;
    box-shadow: var(--so-pill-shadow);
  }
  .chat-copy > :first-child { margin-top: 0; }
  .chat-copy > :last-child { margin-bottom: 0; }
  .chat-copy p { margin: .35rem 0 .7rem; }
  .chat-copy h3 { margin: 1rem 0 .35rem; color: var(--foreground); font-size: .8125rem; }
  .chat-copy ul, .chat-copy ol { margin: .4rem 0 .75rem; padding-left: 1.3rem; }
  .chat-copy li { margin: .24rem 0; padding-left: .15rem; }
  .chat-message-foot { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-top: .75rem; }
  .chat-message-foot time { color: var(--muted-foreground); font: 400 .625rem/1 var(--font-mono); white-space: nowrap; }
  .chat-activity { display: flex; flex-wrap: wrap; gap: .3rem; }
  .chat-activity span { padding: .15rem .42rem; border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground); font: 400 .625rem/1.25 var(--font-mono); }
  .proposal { margin: .9rem 0 0; padding: 0; overflow: hidden; background: var(--glass); }
  .proposal-head { display: grid; grid-template-columns: 2rem minmax(0, 1fr) auto; align-items: center; gap: .65rem; padding: .75rem .85rem; border-bottom: 1px solid var(--glass-border); }
  .proposal-head > span:nth-child(2) { min-width: 0; }
  .proposal-head strong, .proposal-head small { display: block; }
  .proposal-head strong { font-size: .75rem; }
  .proposal-head small { margin-top: .05rem; color: var(--muted-foreground); font-size: .625rem; }
  .proposal-icon { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: .6rem; color: var(--running); background: var(--running-soft); }
  .proposal-icon svg { width: 1rem; height: 1rem; }
  .proposal-cancel .proposal-icon { color: var(--destructive); background: var(--destructive-soft); }
  .proposal-answer .proposal-icon { color: var(--warning); background: var(--warning-soft); }
  .proposal-repair .proposal-icon { color: var(--warning); background: var(--warning-soft); }
  .proposal-body { padding: .85rem; }
  .proposal-body h3 { margin: 0; color: var(--foreground); font-size: .9rem; letter-spacing: -.015em; }
  .proposal-summary { margin: .45rem 0 0; color: var(--foreground); white-space: pre-wrap; }
  .proposal-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .35rem; margin: .75rem 0 0; }
  .proposal-facts div { min-width: 0; padding: .45rem .55rem; border-radius: calc(var(--radius) - 5px); background: color-mix(in srgb, var(--muted) 65%, transparent); }
  .proposal-facts dt { color: var(--muted-foreground); font: 400 .6rem/1.25 var(--font-mono); text-transform: uppercase; letter-spacing: .04em; }
  .proposal-facts dd { margin: .18rem 0 0; overflow-wrap: anywhere; font-size: .72rem; }
  .proposal-rationale { margin-top: .75rem; padding: .65rem .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: var(--muted); }
  .proposal-rationale strong { display: block; margin-top: .2rem; }
  .proposal-rationale p { margin: .2rem 0 0; color: var(--muted-foreground); }
  .proposal-disclosure { margin-top: .7rem !important; font-size: .6875rem; }
  .proposal-actions { padding: 0 .85rem .85rem; }
  .proposal-actions .acts { display: flex; align-items: center; gap: .5rem; }
  .proposal-actions form { margin: 0; }
  /* The confirm is the card's one primary; dismiss stays quiet (UI polish 2026-09-13). */
  .proposal-actions .acts form:first-child button[type=submit] { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  @media (hover: hover) and (pointer: fine) { .proposal-actions .acts form:first-child button[type=submit]:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); border-color: color-mix(in srgb, var(--primary) 85%, var(--background)); } }
  .proposal-actions .done, .proposal-actions .refused, .proposal-wait { margin: 0; padding: .55rem .65rem; border-radius: calc(var(--radius) - 5px); font-size: .72rem; }
  .proposal-actions .done { color: var(--success); background: var(--success-soft); }
  .proposal-actions .refused { color: var(--destructive); background: var(--destructive-soft); }
  .proposal.confirmed { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
  .proposal.refused { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
  .proposal .done { color: var(--ok); }
  .proposal .refused { color: var(--danger); }
  .chat-empty { margin: auto; padding: clamp(3rem, 9vh, 6rem) 1rem 3rem; text-align: center; }
  .chat-empty::before {
    content: "T"; display: grid; place-items: center; width: 3.5rem; height: 3.5rem; margin: 0 auto 1.1rem;
    border: 1px solid var(--glass-border); border-radius: 1.15rem;
    background: var(--glass-strong);
    box-shadow: var(--so-pill-shadow);
    font: 600 .8rem/1 var(--font-mono); letter-spacing: -.05em;
  }
  .chat-empty > strong { display: block; font-size: 1.2rem; letter-spacing: -.025em; }
  .chat-empty > .meta { margin-top: .4rem; }
  .chat-prompts { display: flex; justify-content: center; flex-wrap: wrap; gap: .5rem; margin-top: 1.25rem; }
  /* The composer's status line takes no room until it has a state to report. */
  .composer-hint:empty { display: none; }
  .chat-prompts form { margin: 0; }
  .chat-prompts button { min-height: 2.35rem; box-shadow: none; background: var(--glass); padding-inline: .9rem; }
  /* The New update action (package 2): sticks above the composer, takes no
     room while hidden, and is the only thing that moves a reader who sat
     above the latest message when a live update landed. */
  .chat-new-update-holder { position: sticky; bottom: 1rem; z-index: 28; display: flex; justify-content: center; height: 0; margin: 0; pointer-events: none; }
  .chat-new-update { pointer-events: auto; transform: translateY(-100%); min-height: 2.35rem; padding-inline: .9rem; border-radius: 999px; box-shadow: var(--shadow-overlay); }
  .chat-new-update[hidden] { display: none; }
  /* The concise plan (package 2): a title, the outcome, one line of
     counts and limits, then one Review plan disclosure over the unchanged
     exact-terms form. */
  .chat-approval-stale { margin: .75rem 0 0; }
  .chat-approval-stale a { font-weight: 600; }
  form.approve-form[data-stale="1"] .approval-confirm, form.approve-form[data-stale="1"] .approval-act { opacity: .55; }
  .proposal-filed { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem; margin: .5rem 0 0; }
  .chat-thinking { display: flex; align-items: center; gap: .75rem; padding: .75rem .85rem; }
  .chat-thinking p { flex: 1; margin: 0; }
  .chat-thinking p strong, .chat-thinking p span { display: block; }
  .chat-thinking p span { margin-top: .08rem; }
  .chat-thinking form { margin: 0; }
  /* On a desk the overview is its own card — no second frame around it. */
  .chat-fleet-context, .chat-fleet-context[open] { margin: 0; padding: 0; border: 0; background: transparent; }
  .chat-fleet-context > summary { display: none; }
  /* The summary's needs-you count is magenta wherever the summary shows (a count, by the law). */
  .chat-fleet-context > summary .hot { color: var(--brand); font-weight: 600; }
  @media (min-width: 761px) {
    /* A fresh conversation on a desk (annotation on build 1540): the
       overview folds behind one summary row that still carries its two
       counts, and the empty state gives up its centering slack, so the whole
       composer and its send control sit inside the first 1280×800 viewport. */
    .chat-main:has(.chat-empty) .chat-fleet-context { margin: 0 0 .25rem; border: 1px solid var(--glass-border); border-radius: 1rem; background: color-mix(in srgb, var(--glass) 70%, transparent); }
    .chat-main:has(.chat-empty) .chat-fleet-context[open] { padding-bottom: .5rem; }
    .chat-main:has(.chat-empty) .chat-fleet-context > summary { display: flex; align-items: center; gap: .6rem; min-height: 2.5rem; padding: .5rem .9rem; color: var(--muted-foreground); font-size: .78rem; cursor: pointer; }
    .chat-main:has(.chat-empty) .chat-fleet-context > summary::before { content: "▸"; flex: none; font-size: .7rem; }
    .chat-main:has(.chat-empty) .chat-fleet-context[open] > summary::before { content: "▾"; }
    .chat-main:has(.chat-empty) .chat-fleet-context > summary .meta { margin-left: auto; font-size: .68rem; white-space: nowrap; }
    .chat-main:has(.chat-empty) .chat-fleet-context .chat-overview { margin: 0 .5rem; box-shadow: none; }
    .chat-main:has(.chat-empty) .thread { min-height: 0; margin: .75rem 0 .75rem; }
    .chat-main:has(.chat-empty) .chat-empty { padding: clamp(1.25rem, 4vh, 2.25rem) 1rem 1rem; }
  }
  .thinking-orb { position: relative; width: 2rem; height: 2rem; flex: none; border-radius: 999px; background: var(--running-soft); }
  .thinking-orb::after { content: ""; position: absolute; inset: .55rem; border-radius: inherit; background: var(--running); animation: pulse 1.25s ease-in-out infinite; }
  .composer {
    display: flex; align-items: flex-end; gap: .75rem; padding: .7rem; margin-top: .5rem;
    border-radius: 1.35rem; background: var(--glass-strong);
  }
  .composer label { flex: 1; min-width: 0; margin: 0; font-size: 0; }
  .composer textarea {
    width: 100%; min-height: 3.5rem; max-height: 13rem; margin: 0; padding: .75rem .85rem;
    resize: vertical; border: 0; background: transparent; box-shadow: none; font-size: 1rem;
  }
  .composer textarea:focus-visible { border: 0; box-shadow: none; }
  @media (hover: hover) and (pointer: fine) { .composer textarea:hover { border: 0; box-shadow: none; } }
  .composer button {
    flex: 0 0 2.75rem; width: 2.75rem; min-height: 2.75rem; padding: 0; border-radius: 999px;
    font-size: 0; box-shadow: 0 10px 24px -16px rgb(255 255 255 / .65);
  }
  .composer button::after { content: "↑"; font: 600 1.15rem/1 var(--font-sans); }
  .chat-main > details { margin-top: 1rem; background: color-mix(in srgb, var(--glass) 70%, transparent); }
  @media (min-width: 761px) {
    /* Keep the desktop composer in the document flow. A sticky bottom
     * constraint pulled it over proposal cards on long conversations (and
     * into the middle of full-page captures), hiding the very acts it asks
     * the operator to confirm. The #latest anchor still brings this form
     * into view after every turn without making it an overlay. */
    .chat-workspace .composer { position: static; width: 100%; box-shadow: var(--shadow); }
    /* The agents summary is said ONCE per screen (v48): the context panel
     * carries it on desktop, so the compact strip — the phone's copy —
     * steps aside wherever that panel is visible. */
    .task-chat-workspace .task-chat-agents { display: none; }
  }
  @media (min-width: 761px) and (max-width: 1199px) {
    .chat-workspace { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    .chat-main { max-width: none; }
    .chat-projects { display: none; }
    .chat-workspace.projects-open::before {
      content: ""; position: fixed; inset: 0 0 0 232px; z-index: 23; background: rgb(0 0 0 / .18);
    }
    .chat-workspace.projects-open .chat-projects {
      display: block; position: fixed; top: 4rem; left: calc(232px + 1.25rem); z-index: 25;
      width: min(18.5rem, calc(100vw - 232px - 2.5rem)); max-height: calc(100vh - 5rem);
    }
    .app.sidebar-collapsed .chat-workspace.projects-open::before { inset: 0 0 0 64px; }
    .app.sidebar-collapsed .chat-workspace.projects-open .chat-projects { left: calc(64px + 1.25rem); }
    .chat-project-close { display: grid; place-items: center; }
  }
  @media (min-width: 900px) and (max-width: 1199px) {
    .task-chat-workspace { grid-template-columns: minmax(14rem, 16rem) minmax(0, 1fr); gap: 1.25rem; }
  }
  @media (max-width: 760px) {
    main:has(.chat-workspace) { padding: 1rem max(1rem, env(safe-area-inset-right, 0rem)) calc(var(--composer-height, 4rem) + 5rem + env(safe-area-inset-bottom, 0rem)) max(1rem, env(safe-area-inset-left, 0rem)); }
    /* Above the fixed composer and the tab bar, never beneath them. */
    .chat-new-update-holder { bottom: calc(var(--composer-height, 4rem) + 4.5rem + env(safe-area-inset-bottom, 0rem)); }
    .chat-main:has(.proposal.pending) .chat-new-update-holder, .chat-main:has(.chat-empty) .chat-new-update-holder { bottom: calc(4.5rem + env(safe-area-inset-bottom, 0rem)); }
    .chat-workspace, .chat-workspace.projects-hidden { display: block; }
    .chat-workspace.projects-hidden .chat-projects, .chat-projects { display: none; }
    .chat-project-toggle { display: inline-flex; min-height: 2.75rem; }
    .chat-project-close { display: grid; place-items: center; min-height: 2.75rem; min-width: 2.75rem; }
    .chat-workspace.projects-open::before { content: ""; position: fixed; inset: 0; z-index: 30; background: rgb(0 0 0 / .18); }
    .chat-workspace.projects-open .chat-projects { display: block; position: fixed; top: 5rem; left: 1rem; right: 1rem; width: auto; max-height: calc(100dvh - 10rem); overflow-y: auto; overscroll-behavior: contain; z-index: 31; background: var(--card); }
    .chat-project-list { display: grid; gap: 0; padding: 0; }
    .chat-project-card {
      margin: 0; padding: .85rem .4rem; border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent;
    }
    .chat-projects { position: static; max-height: none; overflow: hidden; padding: .65rem; margin-bottom: .85rem; }
    .chat-projects-head { margin-bottom: .35rem; }
    .chat-project-stats { display: flex; flex-wrap: wrap; gap: .15rem .7rem; margin-top: .35rem; }
    .chat-project-stats span { font-size: .625rem; }
    .chat-project-stats span:last-child { display: none; }
    .chat-project-actions { margin-top: .5rem; }
    .chat-project-actions button { min-height: 2.75rem; padding-inline: .85rem; font-size: .8125rem; }
    .chat-head { padding-inline: 0; }
    .chat-head h1 { font-size: 1.4rem; }
    .chat-head-actions { align-items: flex-start; }
    .task-chat-workspace .task-chat-context { display: none; }
    .result-panel { padding: .25rem 0 1rem; border: 0; border-radius: 0; box-shadow: none; background: transparent; }
    .result-head { display: grid; gap: .45rem; }
    .result-head .status-line { justify-self: start; }
    .result-tabs { gap: 0; }
    .result-tabs a { flex: 1 1 auto; min-width: 0; justify-content: center; padding: 0 .25rem; font-size: .8125rem; gap: .3rem; white-space: nowrap; min-height: 2.75rem; overflow: hidden; }
    .result-facts { grid-template-columns: 1fr; }
    .result-request .diff-comment-form button, .result-request .revision-from-comments button { width: 100%; }
    .result-action .button-link, .result-action form button { width: 100%; box-sizing: border-box; min-height: 2.75rem; }
    .result-request .revision-from-comments { display: grid; }
    .result-links { display: grid; gap: 0; }
    .result-links a { min-height: 2.75rem; display: inline-flex; align-items: center; }
    .result-links a + a::before { content: none; }
    .task-chat-head { display: block; }
    .task-chat-head > .badge { display: none; }
    .task-chat-title-line { display: grid; gap: .65rem; }
    .task-chat-title-line .task-view-switch { justify-self: start; }
    #task-chat-live { gap: .75rem; }
    .task-journey { padding: .85rem; }
    .task-journey > ol { margin: .85rem -.2rem .65rem; }
    .task-journey > ol::before { left: 9%; right: 9%; }
    .task-journey li { font-size: .56rem; }
    .task-journey li i { width: 1.25rem; height: 1.25rem; }
    .chat-action-card > summary { align-items: flex-start; padding: .85rem; }
    .chat-action-card > summary .button-link { min-height: 2.1rem; padding-inline: .6rem; font-size: .65rem; white-space: nowrap; }
    .chat-action-card > summary small { max-width: 14rem; }
    .chat-budget { gap: .3rem; margin: .65rem 0 .9rem; }
    .chat-budget > span { padding: .25rem .48rem; }
    .chat-budget > span:first-child { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .chat-overview { padding: .8rem; }
    .chat-fleet-context { margin: .5rem 0 .75rem; border: 1px solid var(--glass-border); border-radius: 1rem; background: var(--glass); }
    .chat-fleet-context[open] { padding-bottom: .25rem; }
    .chat-fleet-context > summary { display: flex; align-items: center; justify-content: space-between; gap: .75rem; min-height: 2.75rem; padding: .75rem .9rem; color: var(--muted-foreground); font-size: .8rem; cursor: pointer; }
    .chat-fleet-context > summary::before { content: "▸"; flex: none; margin-right: .35rem; font-size: .7rem; }
    .chat-fleet-context[open] > summary::before { content: "▾"; }
    .chat-fleet-context > summary .meta { margin-left: auto; font-size: .68rem; white-space: nowrap; }
    .chat-fleet-context .chat-overview { border: 0; box-shadow: none; margin: 0; }
    .chat-overview-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .chat-overview-head { align-items: flex-start; }
    .chat-overview-copy strong, .chat-overview-copy span { white-space: normal; }
    .thread { min-height: 18rem; padding: 0; }
    .thread .msg.op { max-width: 90%; }
    .thread .msg.mate { padding-left: 2.8rem; padding-right: 0; }
    .thread .msg.mate::before { width: 2.15rem; height: 2.15rem; border-radius: .7rem; }
    .proposal-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .proposal-actions .acts { align-items: stretch; flex-direction: row; flex-wrap: wrap; }
    .proposal-actions .acts form { flex: 1 1 8rem; width: auto; }
    .proposal-actions .acts form:has(.arm) { flex-basis: 100%; }
    .proposal-actions .acts button { width: 100%; }
    .chat-prompts {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: .5rem; width: 100%; max-width: 100%; overflow: visible; padding: 0;
    }
    .chat-prompts form, .chat-prompts button { min-width: 0; width: 100%; }
    .chat-prompts form:last-child:nth-child(odd) { grid-column: 1 / -1; }
    .chat-main { padding-bottom: 0; }
    .chat-main #latest { scroll-margin-top: 7rem; }
    .chat-workspace .composer {
      position: fixed; left: 1rem; right: 1rem; bottom: calc(3.75rem + env(safe-area-inset-bottom, 0rem));
      z-index: 29; margin: 0; padding: .45rem; border-radius: 1.1rem; box-shadow: var(--shadow-overlay);
    }
    /* A confirmation is the primary act. Let the composer return to the
       document flow while one is pending so it can never cover the card's
       explanation or buttons on a short phone viewport. */
    .chat-main:has(.proposal.pending) { padding-bottom: 0; }
    .chat-main:has(.proposal.pending) .composer { position: static; width: 100%; margin-top: .5rem; }
    /* …and the suggestion chips step aside for the same reason: on a phone
       the card, its buttons, and the composer then share one screen. */
    .chat-main:has(.proposal.pending) .chat-prompts { display: none; }
    /* First use is one cohesive intake card: prompt, suggestions, then the
       box. A fixed box belongs to an established thread; here it would sit
       above the very question it is asking the person to answer. */
    .chat-main:has(.chat-empty) { padding-bottom: 0; }
    .chat-main:has(.chat-empty) .thread { min-height: 0; margin-bottom: .5rem; }
    .chat-main:has(.chat-empty) .chat-empty {
      width: 100%; min-width: 0; max-width: 100%; margin: 0; padding: 2rem 0 .75rem;
    }
    .chat-main:has(.chat-empty) .chat-empty > strong,
    .chat-main:has(.chat-empty) .chat-empty > .meta { max-width: 22rem; margin-inline: auto; }
    .chat-main:has(.chat-empty) .chat-empty > .meta { margin-top: .45rem; }
    .chat-main:has(.chat-empty) .composer { position: static; width: 100%; margin-top: .5rem; }
    .composer textarea { min-height: 2.75rem; padding: .55rem .65rem; font-size: 1rem; }
    /* Hide bottom navigation only when viewport shrink indicates a soft
       keyboard; hardware-keyboard focus and pinch zoom keep it available. */
    html[data-mobile-keyboard] .tabbar { display: none; }
    html[data-mobile-keyboard] .chat-workspace .composer { bottom: calc(var(--keyboard-inset, 0px) + .5rem); }
    /* The raised composer needs the same room beneath the thread as the
       resting one, or the newest message hides behind it while typing. */
    html[data-mobile-keyboard] main:has(.chat-workspace) { padding-bottom: calc(var(--keyboard-inset, 0px) + var(--composer-height, 4rem) + 1.5rem); }
    html[data-mobile-keyboard] main:has(.chat-workspace) :is(input, textarea, button, summary, a) { scroll-margin-block: 6rem calc(var(--keyboard-inset, 0px) + var(--composer-height, 4rem) + 1.5rem); }
    html[data-mobile-keyboard] .chat-new-update-holder { bottom: calc(var(--keyboard-inset, 0px) + var(--composer-height, 4rem) + 1rem); }
    html[data-mobile-keyboard] .sticky-actions { bottom: .5rem; }
    .work-tools { display: block; }
    .work-tools > summary, .work-tools-menu a, .work-views a { min-height: 2.75rem; }
    .work-tools-menu a { display: flex; align-items: center; }
    main :is(input, textarea, button, summary, a) { scroll-margin-block: 6rem calc(var(--composer-height, 4rem) + 5rem); }
  }
  main:has(.mate-mint) { max-width: 68rem; }
  main:has(.mate-mint) > h1 { margin-top: .5rem; font-size: 1.7rem; letter-spacing: -.04em; }
  .mate-mint { position: relative; max-width: 46rem; margin-top: 1.5rem; padding: 1.5rem; border-radius: calc(var(--radius) + 4px); }
  .mate-mint::before {
    content: "T"; position: absolute; top: 1.4rem; left: 1.4rem; width: 3rem; height: 3rem;
    display: grid; place-items: center; border: 1px solid var(--glass-border); border-radius: 1rem;
    background: var(--glass-strong);
    box-shadow: var(--so-pill-shadow);
    font: 600 .75rem/1 var(--font-mono); letter-spacing: -.05em;
  }
  .mate-mint > p:first-child { min-height: 3rem; margin: 0; padding: .15rem 0 1.25rem 4rem; font-size: .95rem; }
  .mate-mint > p:first-child strong { display: block; margin-bottom: .2rem; font-size: 1.1rem; letter-spacing: -.02em; }
  .mate-mint form { border-top: 1px solid var(--glass-border); padding-top: .5rem; }
  /* The start act is the page's one primary (UI polish 2026-09-13). */
  .mate-mint form > button[type=submit] { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  @media (hover: hover) and (pointer: fine) { .mate-mint form > button[type=submit]:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); border-color: color-mix(in srgb, var(--primary) 85%, var(--background)); } }
  .mate-terms { display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline; padding: .35rem 0; }
  .mate-terms .inline-field { white-space: nowrap; }
  button.quiet { background: transparent; color: var(--fg-muted); border-color: var(--border); }
  .answer-options { list-style: none; padding: 0; margin: 0.4rem 0; }
  .answer-options li { padding: 0.35rem 0.6rem; border-left: 1px solid var(--border); margin: 0.25rem 0; }
  .answer-options li.picked { border-left-color: var(--foreground); }
  .shared-action { max-width: 49rem; overflow-wrap: anywhere; }
  .shared-action form { margin-top: 1.5rem; }
  .shared-action label.arm { display: flex; align-items: center; gap: .6rem; min-height: 44px; padding-block: .4rem; }
  .shared-action label.arm input { flex: none; width: 20px; height: 20px; }
  .shared-action button { white-space: nowrap; }
  .proposal label.arm { display: inline-flex; gap: 0.35rem; align-items: center; margin-right: 0.5rem; font-size: 0.85rem; }
  .coordinator-proposals .card { margin: 0.5rem 0; }
  .workspace-head { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .workspace-head .workspace-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-family: var(--font-mono); font-size: .8125rem; }
  .workspace-head .badge { flex: none; }
  .workspace-head form { margin: 0 0 0 auto; }
  .workspace-head form button { min-height: 2rem; padding: 0 .625rem; font-size: .75rem; width: auto; }
  .workspace-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .375rem; margin-top: .625rem; }
  .workspace-stats .pulse-stat {
    color: var(--muted-foreground); font-size: .6875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: var(--muted); border-radius: calc(var(--radius) - 4px); padding: .375rem .5rem; text-align: center;
  }
  .workspace-stats .pulse-stat b { display: block; color: var(--foreground); font-weight: 600; font-family: var(--font-mono); font-size: 1.125rem; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .workspace-stats .pulse-stat.hot b { color: var(--brand); }
  .workspace-bar { display: flex; gap: 2px; height: .375rem; margin-top: .625rem; border-radius: 9999px; overflow: hidden; background: var(--muted); }
  .workspace-bar .seg { flex: 1 1 0; }
  .workspace-bar .seg.attention { background: var(--brand); }
  .workspace-bar .seg.building { background: var(--running); }
  .workspace-bar .seg.waiting { background: var(--muted-foreground); }
  .workspace-bar .seg.queued { background: color-mix(in srgb, var(--muted-foreground) 45%, transparent); }
  .attention-stack { display: grid; gap: .55rem; }
  .attention-stack .decide-card { margin: 0; }
  .attention-stack .q { display: flex; gap: .5rem; align-items: center; justify-content: space-between; }
  .wb-rail-head {
    display: flex; align-items: flex-end; justify-content: space-between; gap: .75rem;
    padding: 0 .15rem .6rem; border-bottom: 1px solid var(--border);
  }
  .wb-rail-head h2 { margin: .1rem 0 0; color: var(--foreground); font-size: .875rem; letter-spacing: -.01em; text-transform: none; font-family: var(--font-sans); }
  .wb-rail-head a { font-size: .75rem; color: var(--muted-foreground); }
  .wb-group { margin-top: 1.05rem; }
  .wb-group > h2 {
    display: flex; align-items: center; justify-content: space-between; margin: 0 .2rem .35rem;
    font-size: .65rem;
  }
  .wb-group > h2 .lane-count { border: 1px solid var(--border); border-radius: 999px; padding: .04rem .42rem; }
  .wb-row {
    display: block; padding: .58rem .65rem; margin: .16rem 0; border: 1px solid transparent;
    border-radius: calc(var(--radius) - 4px); color: inherit; text-decoration: none;
  }
  @media (hover: hover) and (pointer: fine) { .wb-row:hover { background: var(--card); border-color: var(--border); } }
  .wb-row.wb-selected { background: var(--muted); border-color: var(--border); }
  .wb-row .wb-title { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; }
  .wb-row .wb-meta { display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; margin-top: .22rem; }
  .wb-row .badge { padding: .04rem .42rem; font-size: .65rem; }
  .wb-row .wb-reason { display: block; color: var(--muted-foreground); font-size: .72rem; margin-top: .22rem; line-height: 1.35; }
  @media (max-width: 720px) {
    .control-room-head { display: block; }
    .control-room-head .actions { justify-content: flex-start; margin-top: .75rem; }
    .command-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .workspace-pulse { grid-template-columns: 1fr; }
    .workspace-stats .pulse-stat { padding: .375rem .125rem; font-size: .625rem; letter-spacing: -.01em; }
    .permission-toggle { grid-template-columns: 1fr; }
    .task-intake { margin-top: .25rem; }
    .task-intake-hero { text-align: left; margin-bottom: .9rem; }
    .task-intake-mark { display: none; }
    .task-composer { margin-inline: 0; padding: .55rem; border-radius: 1.15rem; }
    .task-prompt textarea { min-height: 7.25rem; padding: .75rem; font-size: 1rem; }
    .task-composer-footer { flex-wrap: wrap; }
    .task-context { order: 1; flex-basis: calc(100% - 7rem); }
    .task-context-chip:first-child { max-width: 9.5rem; }
    .task-context-chip:nth-child(2) { display: none; }
    .task-quality { order: 2; }
    .task-submit { order: 3; width: 100%; }
    .task-options { order: 4; }
    .task-options-grid { grid-template-columns: 1fr; }
    .task-options-grid .wide, .task-options-grid .permission-field { grid-column: auto; }
    .agents-form { grid-template-columns: 1fr; }
    .agents-roles { grid-template-columns: 1fr; }
    .agents-role-row { grid-template-columns: 1fr; }
    .approval-card { padding: 1rem; }
    /* The orientation block says the wait on a phone; the kicker would say it twice. */
    .approval-card .approval-kicker { display: none; }
    .approval-boundaries, .approval-confirm { grid-template-columns: 1fr; }
    /* The approval stays IN FLOW on phones: the password field comes
       first and the button follows it — never a sticky control floating
       over the field it confirms. */
    .approval-confirm .sticky-actions { position: static; margin-top: 0; padding: 0; border-top: 0; }
  }

  /* Runner lanes (queue + fleet): one column per worker. */
  .content > main:has(.lanes) { max-width: none; }
  .lanes {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: .625rem; padding-bottom: .75rem; align-items: start;
  }
  @media (max-width: 40rem) {
    .lanes { display: flex; flex-direction: column; }
    .lanes .lane { min-height: 0; }
  }
  .runner-note { width: 100%; }
  .queue-handle {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 2rem; height: 2rem; margin: -.375rem .125rem -.375rem -.5rem; vertical-align: middle;
    color: var(--muted-foreground); cursor: grab; user-select: none; touch-action: none; border-radius: calc(var(--radius) - 4px);
  }
  .queue-handle svg { width: 1.125rem; height: 1.125rem; }
  .queue-handle:active { cursor: grabbing; background: var(--muted); }
  .icon-button, .inline button.icon-button { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 2.75rem; min-width: 2.75rem; padding: 0; }
  .icon-button svg { width: 1rem; height: 1rem; }
  .queue-card p { margin: 0; }
  .queue-card a { text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { .queue-card a:hover { text-decoration: underline; } }
  .queue-card .row + .row { margin-top: .125rem; border-bottom: none; }
  .queue-card p.row { padding: 0; border-bottom: none; }
  .tracks { margin-top: 1.5rem; }
  .tracks > .hint { margin-bottom: .75rem; }
  .track-row { margin-bottom: .6rem; }
  .track-row p { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .track-row p .right { margin-left: auto; }
  .track-row a { text-decoration: none; }
  @media (hover: hover) and (pointer: fine) { .track-row a:hover { text-decoration: underline; } }
  .track-strip { display: inline-flex; gap: .3rem; align-items: center; vertical-align: middle; }
  .fire {
    display: inline-block; width: .65rem; height: .65rem; border-radius: 50%;
    background: var(--muted);
  }
  .fire-ok { background: var(--success); }
  .fire-bad { background: var(--destructive); }
  .fire-live { background: var(--running); animation: pulse 1.6s ease-in-out infinite; }
  .fire-skip { background: transparent; border: 1.5px solid var(--muted); }

/* the phone: fingers, not cursors — tested at 320/390px */
input, select, textarea { font-size: 16px; }
button { min-height: 44px; }
@media (max-width: 40rem) {
  form.card button[type=submit], form > button[type=submit] { width: 100%; }
  input[type=text], input[type=password] { width: 100%; max-width: 100%; box-sizing: border-box; }
  main { padding-bottom: calc(1rem + env(safe-area-inset-bottom)); }
  /* Task actions are composed for a thumb, not allowed to wrap according
     to their intrinsic text widths. Every row owns the available width. */
  .task-title-row { display: grid; gap: .6rem; margin-bottom: .8rem; }
  .task-title-row .task-main-title { margin-bottom: 0; }
  .task-title-row .task-view-switch { justify-self: start; }
  .task-main-title { display: flex; align-items: center; flex-wrap: wrap; gap: .3rem .4rem; }
  .dispatch-copy { display: grid; gap: .2rem; }
  .dispatch-copy > strong { line-height: 1.35; }
  .dispatch-action-link, details.dispatch-recovery > summary { width: 100%; box-sizing: border-box; justify-content: center; }
  .proof-review-actions { display: grid; }
  .proof-review-actions > .button-link { width: 100%; box-sizing: border-box; text-align: center; }
  details.proof-exception[open] { width: 100%; }
  .dispatch-recovery-body { padding: .7rem; }
  .dependency-repair-actions { display: grid; grid-template-columns: 1fr; gap: .5rem; margin-top: .75rem; }
  .dependency-repair-actions form { display: flex; width: 100%; max-width: none; margin: 0; }
  .dependency-repair-actions form > button[type=submit] { width: 100%; }
  .dependency-repair-actions .dependency-repair-replace {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem;
  }
  .dependency-repair-actions .dependency-repair-label { width: 100%; min-width: 0; }
  .dependency-repair-actions .dependency-repair-label > select { width: 100%; min-width: 0; max-width: none; }
  .dependency-repair-actions .dependency-repair-replace > button[type=submit] { width: auto; }
  .acts-bar { display: grid; grid-template-columns: minmax(0, 1fr); gap: .5rem; margin: .75rem 0 .35rem; }
  .acts-bar > *, .acts-bar form.inline { min-width: 0; margin: 0; }
  .acts-bar .primary { display: block; width: 100%; }
  .acts-bar .primary form { width: 100%; margin: 0; }
  .acts-bar .primary form.inline > button[type=submit] { width: 100%; margin: 0; }
  .acts-bar .act-hold {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
    gap: .5rem; width: 100%;
  }
  .acts-bar .act-hold input[type=text] { width: 100%; min-width: 0; margin: 0; }
  .acts-bar .act-hold > button[type=submit] { width: auto; white-space: nowrap; }
  .acts-why { margin: .25rem 0 .85rem; font-size: .75rem; line-height: 1.5; }
  .acts-why-plan { display: none; }
  .task-scope-needed { padding: .85rem 1rem; }
  .task-scope-needed p { margin: .2rem 0; }
  .receipt-head { display: grid; gap: .45rem; }
  .receipt-head .status-line { justify-self: start; }
  .receipt-facts { grid-template-columns: 1fr; }
  .receipt-actions { display: grid; grid-template-columns: 1fr; }
  .receipt-actions .button-link { width: 100%; box-sizing: border-box; text-align: center; }
  /* The cockpit already stacks at 980px (above); only the phone-width
     act card and section padding are decided here. */
  .cockpit-detail { grid-row: 1; }
  .cockpit-queue { grid-row: 2; margin-top: .85rem; padding-top: .85rem; border-top: 1px solid var(--border); border-bottom: 0; }
  .cockpit-next { display: grid; }
  .cockpit-next form, .cockpit-next .button-link { width: 100%; box-sizing: border-box; }
  .cockpit-next form input[type=text] { flex: 1 1 100%; }
  .cockpit-next form button[type=submit] { width: 100%; }
  .cockpit-section { padding: .85rem .8rem; }
  .cockpit-disclosure { padding: 0; }
  .cockpit-disclosure > summary { padding: .8rem; }
  .cockpit-disclosure-body { padding: 0 .8rem .85rem; }
  .cockpit-accept-form { display: grid; }
  .cockpit-accept-form button { width: 100%; }
  .diff-review { margin-inline: -.1rem; }
  .diff-review-bar { padding-left: .7rem; }
  .diff-file > summary { padding-inline: .7rem; }
  .diff-line { grid-template-columns: 2.75rem 2.65rem 2.65rem minmax(max-content, 1fr); min-height: 2.75rem; }
  .diff-annotate, .diff-annotate-space { width: 2.75rem; min-width: 2.75rem; min-height: 2.75rem; }
  .diff-review[data-mode="view"] .diff-line { grid-template-columns: 0 2.65rem 2.65rem minmax(max-content, 1fr); }
  .diff-review[data-mode="view"] .diff-annotate,
  .diff-review[data-mode="view"] .diff-annotate-space { width: 0; min-width: 0; }
  .diff-line code, .diff-gutter { padding-top: .72rem; padding-bottom: .72rem; }
  .diff-comment-target { grid-template-columns: minmax(0, 1fr) 4.75rem; }
  .diff-comment-form button { width: 100%; }
  .revision-from-comments { display: grid; }
  .revision-from-comments button { width: 100%; }
  /* A decision option on a phone: the answer is the full-width thumb
     target; its recommendation and consequence share the line beneath. */
  .decide-option > button { flex: 0 0 100%; width: 100%; }
  .decide-option .badge { flex: none; }
  .decide-option .meta { flex: 1 1 10rem; }
  /* A queue card's controls read as one row under the id: to-front · reserve (stretching) · move. */
  .queue-card p.row.meta { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .queue-card p.row.meta > .mono { flex: 0 0 100%; }
  .queue-card .inline { margin: 0; display: inline-flex; align-items: center; gap: .375rem; }
  .queue-card .inline:last-child { flex: 1 1 auto; min-width: 0; }
  .queue-card .inline > button[type=submit]:not(.icon-button) { width: auto; }
  .queue-card .inline select { flex: 1 1 6rem; min-width: 0; width: auto; min-height: 2.75rem; margin: 0; }
  .queue-card .mono { overflow-wrap: anywhere; }
  .queue-card .row + .row { margin-top: .5rem; }
  /* The title sits beside the grip and wraps within its own box; the
     chips flow after it, never above the name. */
  .queue-card p.row > a:first-of-type { flex: 1 1 12rem; min-width: 0; }
}
/* A phone reads a long changed line wrapped, never scrolled sideways: the
   line keeps its numbers and marker, the code column takes what is left. */
@media (max-width: 760px) {
  .diff-lines { overflow-x: visible; }
  .diff-line, .diff-review .diff-line { min-width: 0; grid-template-columns: 2.75rem 2.65rem 2.65rem minmax(0, 1fr); }
  .diff-review[data-mode="view"] .diff-line { grid-template-columns: 0 2.65rem 2.65rem minmax(0, 1fr); }
  .diff-line code { white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff-hunk-head { overflow-x: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
}
@media (max-width: 30rem) {
  .dependency-repair-actions .dependency-repair-replace { grid-template-columns: minmax(0, 1fr); }
  .dependency-repair-actions .dependency-repair-replace > button[type=submit] { width: 100%; }
}
@media (max-width: 26rem) {
  .acts-bar .act-hold { grid-template-columns: minmax(0, 1fr); }
  .acts-bar .act-hold > button[type=submit] { width: 100%; }
}
.next-pager { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem .75rem; margin: 0 0 .75rem; }
.next-pager .skip {
  margin-left: auto; display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem;
  padding: 0 .875rem; border: 1px solid var(--border); border-radius: 999px;
  text-decoration: none; color: var(--foreground); background: var(--card);
}
@media (hover: hover) and (pointer: fine) { .next-pager .skip:hover { border-color: color-mix(in srgb, var(--border) 60%, var(--muted-foreground)); } }

/* Motion: only where a human caused the change — navigation, presses,
   overlays. Liveness swaps stay instant; the pulse dot is the one "alive"
   signal. Everything dies under prefers-reduced-motion; auto-refresh pages
   opt out of the navigation cross-fade separately (see shell()). */
@view-transition { navigation: auto; }
/* A page change fades THROUGH, not across: the old page leaves before the new
   one arrives, so two pages' text is never on screen at once. The sidebar,
   the same on both, swaps in place instead of fading (each shell names its
   own, so a page can never carry the name twice). */
::view-transition-old(root) { animation: so-page-leave 80ms ease-in both; }
::view-transition-new(root) { animation: so-page-arrive 140ms ease-out 60ms both; }
@keyframes so-page-leave { to { opacity: 0; } }
@keyframes so-page-arrive { from { opacity: 0; } }
.side { view-transition-name: so-nav-page; }
.so-sidebar { view-transition-name: so-nav-app; }
::view-transition-group(so-nav-page), ::view-transition-group(so-nav-app),
::view-transition-old(so-nav-page), ::view-transition-new(so-nav-page),
::view-transition-old(so-nav-app), ::view-transition-new(so-nav-app) { animation: none; }
/* UI polish 2026-09-13 — the motion contract. Feedback transitions run
   140–200 ms on color, border, shadow, opacity, and transform only; an
   overlay's entrance is at most 220 ms of opacity + transform. Nothing
   animates a width, height, margin, grid track, or blur, and nothing
   pulses for decoration. The reduce block below is universal: every
   animation and transition dies, and no page reads differently for it. */
@media (prefers-reduced-motion: no-preference) {
  .tabbar a, .side nav a { transition: color .15s, background .15s; }
  button:active { transform: scale(.985); }
  /* Anchor buttons press like buttons; nav links fill instead. The palette
     and shortcuts overlay are keyboard-summoned, so they appear at once. */
  .button-link, .side .new-task, .content .new-task, .result-feedback-link, .next-pager .skip { transition: transform 160ms var(--so-ease-out); }
  :is(.button-link, .side .new-task, .content .new-task, .result-feedback-link, .next-pager .skip):active { transform: scale(.985); }
  .chat-workspace.projects-open .chat-projects { animation: rise 200ms ease-out; }
  .chat-workspace.projects-open::before { animation: fade 180ms ease-out; }
  .switcher[open] .switcher-menu { animation: rise 160ms ease-out; }
  @media (hover: hover) and (pointer: fine) {
    .lane-card, .decide-card, .menu-row, .chat-overview-item, .proposal { transition: border-color .15s, transform .15s, box-shadow .15s; }
    .lane-card:hover, .decide-card:hover, .menu-row:hover {
     
      box-shadow: 0 2px 8px -2px rgb(0 0 0 / .35);
    }
  }
}
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
@keyframes fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  ::view-transition-group(*), ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  button:active, :is(.button-link, .side .new-task, .content .new-task, .result-feedback-link, .next-pager .skip):active { transform: none; }
  @media (hover: hover) and (pointer: fine) { button:hover, .side nav a:hover, .chat-project-card:hover, .lane-card:hover, .decide-card:hover, .menu-row:hover { transform: none; } }
}

/* The shortcuts overlay: display-only, toggled by the chrome layer, absent
   from sensitive pages. */
.kbd-help {
  position: fixed; top: 18vh; left: 50%; transform: translateX(-50%); width: min(26rem, 92vw);
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-overlay);
  padding: 1rem 1.25rem; z-index: 50;
}
.kbd-help h2 { margin: 0 0 .5rem; font-size: .8125rem; }
.kbd-help table { width: 100%; border-collapse: collapse; font-size: .8125rem; }
.kbd-help td { padding: .25rem 0; vertical-align: top; }
.kbd-help td:first-child { width: 7.5rem; color: var(--muted-foreground); white-space: nowrap; }
.kbd-help kbd {
  font-family: var(--font-mono); font-size: .75rem; background: var(--muted);
  border: 1px solid var(--border); border-radius: .3rem; padding: .05rem .35rem;
}
@media (max-width: 760px) {
  .kbd-help {
    top: auto; bottom: 0; left: 0; right: 0; transform: none; width: auto;
    border-radius: var(--radius) var(--radius) 0 0;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0rem));
  }
}

/* The per-file comment button: a small real button beside a diff row. */
button.pick-file { min-height: 1.75rem; padding: 0 .55rem; font-size: .75rem; }

/* Sticky ceremony actions: single-primary-action forms keep their submit
   within thumb reach on phones. Desktop: plain flow. */
@media (max-width: 760px) {
  .sticky-actions {
    position: sticky; bottom: calc(3.5rem + env(safe-area-inset-bottom, 0rem)); z-index: 20;
    background: var(--background); border-top: 1px solid var(--border);
    padding: .625rem 0; margin-top: .75rem;
  }
  .sticky-actions button { margin: 0; }
}

/* A time a person reads (when-html.ts): the full stamp on a desk, the short
   one on a phone; the full stamp stays in the title. */
.so-when-short { display: none; }
@media (max-width: 760px) {
  .so-when-full { display: none; }
  .so-when-short { display: inline; }
  /* Server pages outside the workspace keep the same phone rhythm. */
  main { padding: var(--so-phone-gap) var(--so-phone-gutter) 3rem; }
  h2 { margin: 1.25rem 0 .375rem; }
  .card { padding: var(--so-phone-card); margin: var(--so-phone-row) 0; }
  .problem { padding: .5rem .625rem; margin: var(--so-phone-row) 0; }
  .meta, .hint { line-height: 1.35; }
  details { margin: var(--so-phone-row) 0; }
}
`;

/** Appearance: a three-way segmented switch, one tap per choice. */
export const THEME_CONTROLS_CSS = `.task-repo select{width:100%;min-height:2.75rem;font-size:1rem}.task-repo-add{margin:.35rem .1rem .5rem}.task-repo-add a{display:inline-flex;align-items:center;min-height:2.25rem}details.result-request-open.result-request-form>summary{border:0;background:transparent;padding:.5rem 0;min-height:2.75rem;font-weight:600;display:list-item;list-style:revert}details.result-request-open.result-request-form>summary::-webkit-details-marker{display:revert}form.js-autosave button[type=submit]{display:none}.provider-row{border-bottom:1px solid var(--so-line);padding:.35rem 0}.provider-row:first-of-type{border-top:1px solid var(--so-line)}.provider-head{display:flex;align-items:center;gap:.75rem;margin:.4rem 0 0}.provider-status{display:inline-flex;align-items:center;gap:.4rem;color:var(--so-muted);font-size:.875rem}.provider-status i{width:.5rem;height:.5rem;border-radius:50%;background:var(--so-muted)}.provider-status--ok i{background:var(--so-success)}.provider-status--warn i{background:var(--so-attention)}.provider-status--off i{background:transparent;border:1.5px solid var(--so-muted)}details.provider-manage>summary{cursor:pointer;color:var(--so-accent-text);font-size:.875rem;min-height:2.5rem;display:list-item;padding-block:.5rem}.card.props .row{display:grid;gap:.1rem;margin:0 0 .75rem}.card.props .row>.meta{display:block;font-size:.75rem}.card.props .row>.meta::first-letter{text-transform:uppercase}.card.props .row>.mono{font-family:var(--font-sans);font-size:.875rem}.card.props .row>.mono .seal{font-family:var(--font-mono);font-size:.8125rem}details.evidence-files{margin:1rem 0}details.evidence-files>summary{cursor:pointer;min-height:2.75rem;display:list-item;padding-block:.7rem;font-weight:600}details.evidence-files ul{list-style:none;margin:0;padding:0}details.evidence-files li{display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--so-line)}.result-action .result-feedback-link{display:inline-flex;align-items:center;min-height:2.5rem;padding:.5rem 1rem;border:1px solid var(--so-input-line);border-radius:.5rem;background:var(--so-paper);color:var(--so-ink);font-weight:600;text-decoration:none}@media(hover:hover) and (pointer:fine){.result-action .result-feedback-link:hover{background:var(--so-raised)}}.so-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.verdict{margin:.5rem 0 .75rem}.verdict-chips{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0;margin:0}.verdict-chip{display:inline-flex;align-items:center;gap:.3rem;min-height:1.75rem;padding:.2rem .65rem;border-radius:999px;font-size:.8125rem;font-weight:600;background:var(--so-neutral-soft);color:var(--so-neutral-ink)}.verdict-chip svg{width:.9rem;height:.9rem}.verdict-chip--success{background:var(--so-success-soft);color:var(--so-success)}.verdict-chip--danger{background:var(--so-danger-soft);color:var(--so-danger)}.verdict-chip--warning{background:var(--so-warning-soft);color:var(--so-warning)}.verdict-chip--info{background:var(--so-info-soft);color:var(--so-info)}.verdict-by{margin:.4rem 0 0}details.result-request-open{margin:.5rem 0}details.result-request-open>summary{display:inline-flex;align-items:center;min-height:2.5rem;padding:.5rem 1rem;border:1px solid var(--so-input-line);border-radius:.5rem;background:var(--so-paper);color:var(--so-ink);font-weight:600;cursor:pointer;list-style:none}details.result-request-open>summary::-webkit-details-marker{display:none}details.result-request-open[open]>summary{margin-bottom:.75rem}.settings-tiles{display:grid;gap:1.25rem;margin:0 0 2rem}.settings-tiles h2{margin:0 0 .5rem;font-size:.875rem;font-weight:600;color:var(--so-muted)}.settings-tiles section>div{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.5rem}.settings-tiles a>span{display:grid;gap:.1rem;min-width:0}.settings-tiles .provider-status{font-weight:400;font-size:.8125rem}.settings-tiles a{display:flex;align-items:center;gap:.6rem;min-height:3rem;padding:.65rem .8rem;border:1px solid var(--so-line);border-radius:.625rem;background:var(--so-paper);color:var(--so-ink);text-decoration:none;font-weight:550;font-size:.875rem}@media(hover:hover) and (pointer:fine){.settings-tiles a:hover{border-color:var(--so-input-line);background:var(--so-raised)}}.settings-tiles a>svg{width:1.1rem;height:1.1rem;flex-shrink:0;color:var(--so-accent-text)}details.settings-more{margin:.25rem 0 1.25rem}details.settings-more>summary{cursor:pointer;min-height:2.75rem;display:list-item;padding-block:.7rem;font-weight:550}details.settings-more>summary .meta{font-weight:400;margin-left:.35rem}.settings-changed{margin-top:-.25rem}.appearance{margin:0 0 28px}.appearance h2{margin:0 0 10px}.theme-switch{display:inline-flex;flex-wrap:nowrap;max-width:100%;gap:4px;padding:4px;margin:0;border:1px solid var(--so-line);border-radius:10px;background:var(--so-raised)}.theme-switch .theme-choice,.so-native-region .theme-switch .theme-choice{flex:1 1 0;width:auto;white-space:nowrap;min-height:40px;padding:8px 16px;border:0;border-radius:7px;background:transparent;color:var(--so-muted);font:inherit;font-weight:550;box-shadow:none;cursor:pointer}@media(hover:hover) and (pointer:fine){.theme-switch .theme-choice:hover{color:var(--so-ink)}}.theme-switch .theme-choice[aria-pressed="true"]{background:var(--so-paper);color:var(--so-ink);box-shadow:0 1px 2px rgb(0 0 0 / .1)}.appearance .meta{margin:8px 0 0}@media(max-width:600px){.theme-switch .theme-choice{min-height:44px}}.update-notes{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:18rem;overflow:auto}`;
/** The page CSS this module writes itself (not the imported modules'), for the stylesheet contract tests. */
export const PAGE_CSS = STYLE + THEME_CONTROLS_CSS;
/** The Inbox tabs (console v2): a segmented track of real links; the dot marks a tab with something new, on phones only. */
export const INBOX_TABS_CSS = '.inbox-tabs{display:inline-flex;gap:2px;max-width:100%;overflow-x:auto;margin:4px 0 14px;padding:2px;border-radius:12px;background:var(--so-raised);scrollbar-width:none}' +
  '.inbox-tabs a{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 10px;border-radius:8px;color:var(--so-muted);font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap}' +
  '.inbox-tabs a[aria-current="page"]{background:var(--so-paper);color:var(--so-ink);box-shadow:var(--so-pill-shadow)}' +
  '.inbox-tab-count{min-width:18px;padding:0 5px;border-radius:9999px;font:500 11px/18px var(--so-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;text-align:center}' +
  '.inbox-tab-count--needs{background:var(--so-signal);color:var(--so-on-signal)}' +
  '.inbox-ask{margin:18px 0 0}.inbox-ask>h2{display:flex;align-items:baseline;gap:8px;margin:0 0 4px;font-size:15px;font-weight:600}.inbox-ask>h2 .count{font:500 12px var(--so-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;color:var(--so-muted)}.inbox-ask h3{font-size:13px;font-weight:600;margin:12px 0 4px}' +
  '.inbox-unread{display:none;position:absolute;top:4px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--so-signal)}' +
  '@media (max-width:760px){.inbox-tabs{display:flex;width:100%}.inbox-tabs a{flex:1;justify-content:center;min-height:44px;padding:0 6px}.inbox-unread{display:block}}';
export const WORKSPACE_STYLE = styleAsset(STYLE + BRAND_MARK_CSS + INBOX_TABS_CSS + APPROVAL_RULES_CSS + SPEND_CSS + RETENTION_CSS + STORAGE_CSS + UPDATES_CSS + LIMITS_CSS + MONITORING_CSS + INTEGRATIONS_CSS + BACKUP_CSS + EXPORT_CSS + PROJECT_DELETE_CSS + POLICY_CSS + EVIDENCE_PACK_CSS + THEME_CONTROLS_CSS + CODING_CSS + CODING_SHIPPING_CSS + RECIPE_CSS + SKILLS_CSS + TOOLS_CSS + FLOWS_CSS + SUBAGENT_CSS + KITS_CSS + STARTERS_CSS + GALLERY_CSS + SSO_CSS + CREDENTIALS_CSS + REQUEST_LIMITS_CSS + PEOPLE_AUDIT_CSS + KNOWLEDGE_CSS + MODELS_CSS + CHAT_POLISH_CSS + TRANSITIONS_CSS + WORKSPACE_MOTION_CSS + ASSIGNMENT_CSS + TASK_STATUS_CSS + LEAD_CONTEXT_CSS + PULL_REQUEST_SETTINGS_CSS + CHECK_SETTINGS_CSS + DISCLOSURE_CSS + '.learning{min-width:0;overflow-wrap:anywhere}.learning .card{min-width:0}.learning code,.learning blockquote,.learning pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.learning button,.learning summary,.learning .button-link{min-height:44px}.learning button{white-space:nowrap}.learning summary{padding:12px 0;cursor:pointer}.learning form{margin:12px 0}.learning select{max-width:100%}.learning blockquote{margin:8px 0}.learning ul{padding-left:20px}');

/** Everything the sidebar needs to draw itself for one request. */
export type Chrome = {
  projectScoped?: boolean;
  active: "code" | "inbox" | "board" | "queue" | "fleet" | "workbench" | "work" | "done" | "activity" | "review" | "system" | "tasks" | "runs" | "caps" | "recipes" | "projects" | "flows" | "settings" | "chat" | "people" | "ledger" | "spend" | "mode" | "menu" | "none";
  project: string | null;
  /** The surface's scope for the scope bar — which rows this screen can
   * show. Derived from the ROUTE, not the session: portfolio and fleet are
   * all-project even while a project is open; the board says which of its
   * two modes it is in. Absent = the session default (open project, else
   * all projects). Display only — switching stays POST + CSRF. */
  scope?: "all" | "project" | "board-all";
  /** The saturated inbox count — never a sum of unbounded list reads. */
  inboxCount: number;
  /** The project the Tasks count covers: the request's own project view
   * (the open project, or /work's ?project=), null for every admitted project. */
  inboxProject?: string | null;
  /** The Tasks badge's words, naming what it covers: "3 need you in shop". */
  inboxLabel?: string;
  inboxSaturated: boolean;
  settings: boolean;
  /** This database is a demo sandbox: banner every page, spend fenced. */
  demo?: boolean;
  /** The active operating mode's banner (M1): rides every page scoped to
   * a repo with a live mode — a signed posture is never invisible. */
  modeBanner?: { words: string; name: string };
  /** Providers whose sign-in stopped working: every page says so, once. */
  signIn?: BrowserSignIn[];
  /** A newer Toolroll: a quiet notice for an operator until they dismiss this version. */
  update?: BrowserUpdateNotice;
  /** An update waiting on something, what, and the action that clears it: every page, for an operator. */
  updateWaiting?: { words: string };
  /** The chat tab renders only where chat could ever be allowed. */
  chat?: boolean;
  code?: boolean;
  /** A rendered list pane makes the page master-detail. */
  listPane?: string;
  /** A compact pulse for the currently open workspace. Null in the
   * cross-workspace view; absent only when the store could not answer. */
  projectPeek?: ProjectPeek | null;
  /** The switcher (board pass): every enrolled project inside the ceiling,
   * most recently opened first — the one-tap switch on any screen. */
  projects?: { path: string; name: string }[];
  /** The session's csrf token, for the switcher's forms; "" when the
   * request has no cookie session (bearer), which renders the switcher
   * inert. */
  csrf?: string;
  /** Where a switch made on this screen returns to. */
  returnTo?: string;
};

/**
 * The board's liveness: fetch this page's own fragment on a timer and swap
 * it in place — no flicker, no scroll reset, no long-lived stream to manage,
 * and correct by cadence rather than by trusting the scheduler's wake
 * sequence to narrate every UI-visible change (Codex board review, finding
 * 3 chose this over SSE). A redirect or auth failure navigates to /login
 * instead of ever inserting the login page into the region (finding 4).
 * The swapped markup is this server's own rendering of the same route —
 * escaped at the sink like every page, fetched same-origin — and the
 * nonce'd CSP refuses to execute anything the region could smuggle.
 */
export function regionScript(regionId: string, fragmentName: string, everySeconds: number, path?: string): string {
  const ms = Math.max(5, Math.floor(everySeconds)) * 1000;
  // Where the fragment lives: the page's own URL by default; an explicit
  // path when a page embeds another entity's region (the task page embeds
  // the live run's peek, slice 1c — no proxy route exists for it).
  const target = path === undefined ? "location.pathname+q" : JSON.stringify(`${path}?fragment=${fragmentName}`);
  // The named-region poller (attended review, finding 2): swaps exactly one
  // element, never a form-bearing pane. Failures are VISIBLE — a frozen
  // page must never look live (finding 6): the stamp says how old the
  // region is, retries back off exponentially, and a hidden tab stops
  // polling entirely. One poll in flight at a time.
  return (
    `(function(){var region=document.getElementById(${JSON.stringify(regionId)});if(!region)return;` +
    `var stamp=document.getElementById(${JSON.stringify(regionId)}+"-stamp");` +
    `var wait=${ms};var last=Date.now();var busy=false;` +
    // The swap must not steal what the reader was holding (arc 4,
    // findings 1/15/16): before replacing the region, remember the
    // focused row (roving set only), each scrolled lane's first visible
    // card, and which board lane was centered; put them back after —
    // scroll first, focus last with preventScroll so it cannot undo the
    // scroll pass. All coordinates come from bounding rects, never
    // offsetLeft against an unpositioned parent (finding 21).
    `function laneKey(l){var m=/(^|\\s)(lane-[a-z]+)(\\s|$)/.exec(l.className);return m?m[2]:null;}` +
    `function keep(){var data={lanes:[],focus:null,pager:-1,fold:{}};` +
    `region.querySelectorAll("details.lane").forEach(function(d){var k=laneKey(d);if(k)data.fold[k]=d.open;});` +
    `var act=document.activeElement;` +
    `if(act&&region.contains(act)&&act.matches&&act.matches("a.row, a.lane-card"))data.focus=act.getAttribute("href");` +
    `var board=region.querySelector(".board");` +
    `if(board&&board.scrollLeft>0){var lanes=board.querySelectorAll(".lane");` +
    `var bc=board.getBoundingClientRect();var mid=bc.left+bc.width/2;var best=-1,bd=1e9;` +
    `for(var i=0;i<lanes.length;i++){var r=lanes[i].getBoundingClientRect();var d=Math.abs(r.left+r.width/2-mid);if(d<bd){bd=d;best=i;}}` +
    `data.pager=best;}` +
    `var ls=region.querySelectorAll(".lane");` +
    `for(var i=0;i<ls.length;i++){var l=ls[i];if(l.scrollTop<=0)continue;var key=laneKey(l);if(!key)continue;` +
    `var first=null,off=0;var cards=l.querySelectorAll("a.lane-card");var lr=l.getBoundingClientRect();` +
    `for(var j=0;j<cards.length;j++){var cr=cards[j].getBoundingClientRect();if(cr.bottom>lr.top){first=cards[j].getAttribute("href");off=cr.top-lr.top;break;}}` +
    `data.lanes.push({key:key,href:first,off:off,top:l.scrollTop});}` +
    `return data;}` +
    `function restore(data){` +
    `region.querySelectorAll("details.lane").forEach(function(d){var k=laneKey(d);if(k&&k in data.fold){if(data.fold[k])d.setAttribute("open","");else d.removeAttribute("open");}});` +
    `for(var i=0;i<data.lanes.length;i++){var d=data.lanes[i];var l=region.querySelector(".lane."+d.key);if(!l)continue;` +
    `var done=false;` +
    `if(d.href){var cards=l.querySelectorAll("a.lane-card");` +
    `for(var j=0;j<cards.length;j++){if(cards[j].getAttribute("href")===d.href){` +
    `l.scrollTop=Math.max(0,l.scrollTop+cards[j].getBoundingClientRect().top-l.getBoundingClientRect().top-d.off);done=true;break;}}}` +
    `if(!done)l.scrollTop=d.top;}` +
    `if(data.pager>=0){var board=region.querySelector(".board");` +
    `if(board){var lanes=board.querySelectorAll(".lane");var at=Math.min(data.pager,lanes.length-1);` +
    `if(at>=0){var br=board.getBoundingClientRect();var lr=lanes[at].getBoundingClientRect();` +
    `board.scrollLeft=board.scrollLeft+(lr.left+lr.width/2)-(br.left+br.width/2);}}}` +
    `if(data.focus!==null){var links=region.querySelectorAll("a.row, a.lane-card");` +
    `for(var i=0;i<links.length;i++){if(links[i].getAttribute("href")===data.focus){links[i].focus({preventScroll:true});break;}}}}` +
    `function tell(){if(!stamp)return;var s=Math.round((Date.now()-last)/1000);` +
    `stamp.textContent=wait>${ms}?"stale — retrying ("+s+"s old)":"updated "+s+"s ago";}` +
    `setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy){setTimeout(cycle,wait);return;}busy=true;` +
    `var q=location.search?location.search+"&fragment="+${JSON.stringify(fragmentName)}:"?fragment="+${JSON.stringify(fragmentName)};` +
    `fetch(${target},{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t){var kept=keep();region.innerHTML=t;restore(kept);last=Date.now();wait=${ms};}else{wait=Math.min(wait*2,${ms}*8);}})` +
    `.catch(function(){wait=Math.min(wait*2,${ms}*8);})` +
    // A fragment that marks itself final stops the poller: a finished or
    // abandoned build must not be fetched every beat forever.
    `.then(function(){busy=false;tell();if(region.querySelector("[data-region-stop]")){if(stamp)stamp.textContent="";return;}setTimeout(cycle,wait);});}` +
    `setTimeout(cycle,wait);})();`
  );
}

/**
 * The live transcript's DEDICATED poller (arc 1 §4): a JSON byte-offset
 * protocol, not an HTML fragment — the response is raw sanitized text and
 * the ONLY sink is textContent, so nothing here can become markup. One
 * request in flight, visibility-paused, stops on `final`, and a `replaced`
 * answer restarts from zero with a visible line — never a silent re-read.
 */
export function transcriptScript(path?: string, elementId = "live-transcript"): string {
  const base = path === undefined ? "location.pathname" : JSON.stringify(path);
  return (
    `(function(){var out=document.getElementById(${JSON.stringify(elementId)});if(!out)return;` +
    `var from=0,busy=false,stopped=false;` +
    `function near(){return out.scrollHeight-out.scrollTop-out.clientHeight<40;}` +
    `function go(){if(stopped)return;if(busy||document.hidden){later();return;}busy=true;` +
    `fetch(${base}+"?fragment=transcript&from="+from,{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){stopped=true;return null;}` +
    `if(r.status===409)return{error:"replaced"};return r.ok?r.json():null;})` +
    `.then(function(d){busy=false;if(d===null){later();return;}if(stopped)return;` +
    `if(d.error==="replaced"){from=0;out.textContent="[the view restarted]\\n";later();return;}` +
    `if(d.error){stopped=true;return;}` +
    `var stick=near();` +
    `if(typeof d.text==="string"&&d.text!==""){out.appendChild(document.createTextNode(d.text));if(stick)out.scrollTop=out.scrollHeight;}` +
    `if(typeof d.nextOffset==="number"&&d.nextOffset>=from){from=d.nextOffset;}` +
    `if(d.final===true){stopped=true;var m=document.getElementById(${JSON.stringify(`${elementId}-state`)});` +
    `if(m)m.textContent="the agent finished — the record on this page is the story";return;}` +
    `later();})` +
    `.catch(function(){busy=false;later();});}` +
    `function later(){setTimeout(go,2000);}go();})();`
  );
}

/**
 * The chrome layer: the jump palette and elapsed tickers. Pure
 * navigation — no key ever posts, so the palette cannot approve anything;
 * ceremonies stay POST + password + CSRF, untouched. Reads its index from
 * a non-executable JSON script tag rendered by the same authorized page.
 */
/** The rail's presentation-only state is safe beside a password ceremony:
 * it never reads a field or sends a request, and keeps the chat collapsible
 * from its very first screen while the palette and global keys remain absent. */
export function sidebarScript(): string {
  return (
    MOBILE_VIEWPORT_SCRIPT +
    `(function(){var app=document.querySelector(".app"),sideToggle=document.querySelector(".side-toggle");` +
    `function setSide(collapsed){if(!app||!sideToggle)return;app.classList.toggle("sidebar-collapsed",collapsed);` +
    `sideToggle.setAttribute("aria-expanded",String(!collapsed));sideToggle.setAttribute("aria-label",collapsed?"expand sidebar":"collapse sidebar");` +
    `sideToggle.setAttribute("title",collapsed?"expand sidebar":"collapse sidebar");}` +
    `if(app&&sideToggle){var sideCollapsed=false;try{sideCollapsed=localStorage.getItem("standing-orders:sidebar-collapsed")==="1";}catch(e){}` +
    `setSide(sideCollapsed);sideToggle.addEventListener("click",function(){var next=!app.classList.contains("sidebar-collapsed");setSide(next);` +
    `try{localStorage.setItem("standing-orders:sidebar-collapsed",next?"1":"0");}catch(e){}});}})();`
  );
}

export function chromeScript(): string {
  return (
    sidebarScript() +
    `(function(){` +
    // The app-icon badge (Phase 2E): the page's server-rendered waiting
    // count is authoritative over any stale push — synced on every chrome
    // page load through the worker, cleared at zero, honest no-op where
    // push never enrolled.
    `try{var waiting=document.querySelector("[data-waiting]");` +
    `if(waiting&&navigator.serviceWorker&&navigator.serviceWorker.controller){` +
    `navigator.serviceWorker.controller.postMessage({badge:Number(waiting.getAttribute("data-waiting"))||0});}}catch(e){}` +
    // elapsed tickers: server timestamps, client arithmetic, display only
    `function tick(){var nodes=document.querySelectorAll("time[data-elapsed-since]");` +
    `for(var i=0;i<nodes.length;i++){var t=Date.parse(nodes[i].getAttribute("data-elapsed-since"));` +
    `if(!isFinite(t))continue;var s=Math.max(0,Math.floor((Date.now()-t)/1000));` +
    `var m=Math.floor(s/60);var h=Math.floor(m/60);` +
    `nodes[i].textContent=h>0?h+"h "+(m%60)+"m":m>0?m+"m "+(s%60)+"s":s+"s";}}` +
    `setInterval(tick,1000);tick();` +
    // The rail's two accordion groups stay exclusive: opening one closes
    // the other. Each <details> already carries its own open/closed state
    // and keyboard operation natively — this only enforces "at most one
    // open" on top of that, and no-ops wherever the groups are absent.
    `var navGroups=document.querySelectorAll(".nav-group");` +
    `navGroups.forEach(function(g){g.addEventListener("toggle",function(){` +
    `if(g.open){navGroups.forEach(function(o){if(o!==g)o.removeAttribute("open");});}});});` +
    // the palette
    `var raw=document.getElementById("palette-index");if(!raw)return;` +
    `var index;try{index=JSON.parse(raw.textContent||"[]");}catch(e){return;}` +
    `var open=false,box=null,list=null,input=null,items=[],paletteBack=null;` +
    `function close(){if(!open)return;open=false;box.remove();box=null;if(paletteBack&&paletteBack.isConnected)paletteBack.focus();paletteBack=null;}` +
    `function go(href){location.href=href;}` +
    `function render(filter){list.textContent="";items=[];var n=0;` +
    `for(var i=0;i<index.length&&n<12;i++){var e=index[i];` +
    `if(filter&&(e.label.toLowerCase().indexOf(filter.toLowerCase())===-1))continue;` +
    `var li=document.createElement("li");li.setAttribute("role","option");li.textContent=e.label;` +
    `li.setAttribute("data-href",e.href);if(n===0)li.setAttribute("aria-selected","true");` +
    `li.addEventListener("click",function(ev){go(ev.currentTarget.getAttribute("data-href"));});` +
    `list.appendChild(li);items.push(li);n++;}}` +
    `function pick(delta){var at=-1;for(var i=0;i<items.length;i++)if(items[i].getAttribute("aria-selected")==="true")at=i;` +
    `if(at>=0)items[at].removeAttribute("aria-selected");var next=Math.max(0,Math.min(items.length-1,at+delta));` +
    `if(items[next])items[next].setAttribute("aria-selected","true");}` +
    `function show(){if(open)return;paletteBack=document.activeElement;open=true;` +
    `box=document.createElement("div");box.className="palette";box.setAttribute("role","dialog");box.setAttribute("aria-label","jump to");` +
    `input=document.createElement("input");input.type="text";input.placeholder="jump to\u2026";input.setAttribute("autocomplete","off");` +
    `list=document.createElement("ul");list.setAttribute("role","listbox");` +
    `box.appendChild(input);box.appendChild(list);document.body.appendChild(box);` +
    `input.addEventListener("input",function(){render(input.value);});` +
    `input.addEventListener("keydown",function(ev){` +
    `if(ev.key==="Escape"){close();ev.preventDefault();}` +
    `else if(ev.key==="ArrowDown"){pick(1);ev.preventDefault();}` +
    `else if(ev.key==="ArrowUp"){pick(-1);ev.preventDefault();}` +
    `else if(ev.key==="Enter"){for(var i=0;i<items.length;i++)if(items[i].getAttribute("aria-selected")==="true")go(items[i].getAttribute("data-href"));ev.preventDefault();}});` +
    `render("");input.focus();}` +
    // the shortcuts overlay: display-only; focus moves in on open and
    // back out on close; every other shortcut sleeps while it is up
    `var help=document.querySelector(".kbd-help");var helpBack=null;` +
    `function helpOpen(){return help!==null&&!help.hidden;}` +
    `function toggleHelp(){if(!help)return;` +
    `if(help.hidden){helpBack=document.activeElement;help.hidden=false;help.focus();}` +
    `else{help.hidden=true;if(helpBack&&helpBack.focus)helpBack.focus();helpBack=null;}}` +
    `document.addEventListener("click",function(ev){if(helpOpen()&&!help.contains(ev.target))toggleHelp();` +
    `document.querySelectorAll("details.switcher[open],details.work-tools[open]").forEach(function(d){if(!d.contains(ev.target))d.removeAttribute("open");});});` +
    `document.addEventListener("keydown",function(ev){if(ev.key!=="Escape"||ev.isComposing)return;var d=ev.target.closest&&ev.target.closest("details.switcher[open],details.work-tools[open]");if(d){d.open=false;d.querySelector("summary").focus();ev.preventDefault();}});` +
    // j/k: a roving focus over the page's rows — only from body or from
    // inside the set, clamped at the ends, preventDefault only on a real
    // move (finding 9); held keys may repeat
    `function rove(delta,ev){` +
    `var set=Array.prototype.slice.call(document.querySelectorAll("a.row, a.lane-card"));` +
    `if(set.length===0)return;` +
    `var cur=document.activeElement;var at=set.indexOf(cur);` +
    `if(cur&&cur!==document.body&&cur!==document.documentElement&&at===-1)return;` +
    `var next=at===-1?(delta>0?0:set.length-1):Math.max(0,Math.min(set.length-1,at+delta));` +
    `if(next===at)return;` +
    `set[next].focus();ev.preventDefault();}` +
    // key routing: never inside editable targets, no modifiers, no IME
    // composition (finding 4); repeats allowed only for j/k
    `var pending=null;` +
    `document.addEventListener("keydown",function(ev){` +
    `if(ev.isComposing||ev.metaKey||ev.ctrlKey||ev.altKey)return;` +
    `var t=ev.target;var tag=t&&t.tagName?t.tagName.toLowerCase():"";` +
    `if(tag==="input"||tag==="textarea"||tag==="select"||tag==="button"||(t&&t.isContentEditable))return;` +
    `if(ev.key==="Escape"){if(helpOpen()){toggleHelp();ev.preventDefault();return;}close();return;}` +
    `if(helpOpen())return;` +
    `if(ev.repeat&&ev.key!=="j"&&ev.key!=="k")return;` +
    `if(ev.key==="/"){show();ev.preventDefault();return;}` +
    `if(ev.key==="?"){toggleHelp();ev.preventDefault();return;}` +
    `if(ev.key==="j"||ev.key==="k"){rove(ev.key==="j"?1:-1,ev);return;}` +
    `if(pending==="g"){pending=null;` +
    `var map={b:"/board",i:"/",w:"/workbench",d:"/done",q:"/board?view=order",f:"/fleet",t:"/tasks",a:"/activity",p:"/projects"};` +
    `if(map[ev.key]){go(map[ev.key]);ev.preventDefault();}return;}` +
    `if(ev.key==="g"){pending="g";setTimeout(function(){pending=null;},800);}});` +
    `})();`
  );
}

/**
 * A page described, not yet rendered (arc 4): every chromed HTML route
 * returns one of these and ONE helper (sendScreen, inside the server)
 * owns the nonce, the palette index, the shortcuts overlay, script
 * composition, and the CSP. Renderers stopped calling shell() themselves
 * so those five things cannot drift apart per route.
 */
export type Screen = {
  title: string;
  body: string;
  chrome?: Chrome;
  /** The page's own executable behavior (a region poller, the push
   * enrollment script). fetches: true when it calls fetch — connect-src
   * is granted only then. */
  functional?: { script: string; fetches?: boolean };
  refreshSeconds?: number;
  /** Render sensitive even when no password field is visible — one-time
   * secrets and judgment calls the classifier cannot see. */
  forceSensitive?: boolean;
  /** Structured conversation; complex guarded forms stay native islands. */
  workspace?: Partial<Pick<BrowserWorkspace, 'conversation' | 'team' | 'focus' | 'result' | 'catchUpHtml' | 'controlsHtml' | 'notices' | 'pageHtml' | 'view' | 'firstRun' | 'phone' | 'home'>>;
};

export const ROLE_TITLES: Record<"plan" | "build" | "review" | "repair", string> = { plan: "Planner", build: "Builder", review: "Reviewer", repair: "Repair" };

export function screen(
  title: string,
  body: string,
  options: Omit<Screen, "title" | "body"> = {},
): Screen {
  return { title, body, ...options };
}

/**
 * The sensitivity classifier (arc 4, findings 3/17): a body showing a
 * password input renders WITHOUT the chrome additions (palette, overlay,
 * global keys) — the page's own functional script still ships. Tolerant
 * of quoting, casing, and whitespace; `data-type="password"` and prose
 * mentioning passwords do not match. This is defense-in-depth over a
 * file whose only HTML producer is its own double-quoted template
 * convention — forceSensitive is the escape hatch for what a regex
 * cannot judge.
 */
export const SENSITIVE_INPUT = /<input\b[^>]*[\s"']type\s*=\s*["']?password/i;

/** The design contract every page carries (impeccable direction, 2026-09-27). */
export const DESIGN_CONTRACT = `<!-- THESIS: a control plane that stays quiet until a person is needed; it refuses the dashboard default of coloured status everywhere and an accent on every button.
OWN-WORLD: a neutral grey frame with paper sheets inset into it (Arc, Linear), Geist for words and Geist Mono for machine facts, ink for every act a person can take, one chart magenta only for what waits on a person plus focus and selection; hairlines and one soft sheet shadow, no glass, no gradients.
STORY: glance, see the accent count, open the one thing that needs you, act with the one accent verb, leave.
FIRST VIEWPORT: sidebar on the frame (accent mark, ink New task, the current page as a raised pill, the accent needs-you count); the main sheet with a 52px header over compact 13px rows; the Crew sheet beside it.
FORM: the Raycast and Arc canon, user-pinned; seed 9c849086.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md -->`;

/** The shortcuts overlay: display-only, toggled by the chrome layer,
 * absent from sensitive pages. Navigation help in plain words — no key
 * ever posts. */
export const KBD_HELP =
  `<div class="kbd-help" hidden role="dialog" aria-label="keyboard shortcuts" tabindex="-1">` +
  `<h2>Keyboard shortcuts</h2><table>` +
  `<tr><td><kbd>/</kbd></td><td>jump to a page or an open task</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>i</kbd></td><td>go to the inbox</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>b</kbd></td><td>go to the board</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>q</kbd></td><td>go to the queue</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>f</kbd></td><td>go to the fleet</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>w</kbd></td><td>go to the workbench</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>t</kbd></td><td>go to the task list</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>a</kbd></td><td>go to the activity view</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>p</kbd></td><td>go to the projects</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>d</kbd></td><td>go to what is done</td></tr>` +
  `<tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>move through the rows on this page</td></tr>` +
  `<tr><td><kbd>Escape</kbd></td><td>close this</td></tr>` +
  `</table></div>`;

export function shell(
  title: string,
  body: string,
  options: {
    nav?: boolean;
    chrome?: Chrome;
    /** A password ceremony is on this page: the chrome gains no forms, so
     * the switcher renders inert — the name, and the one /projects link. */
    sensitive?: boolean;
    /** Whether the presentation-only desktop rail control has a nonce'd
     * handler. Sensitive pages may opt in; one-time-secret pages do not. */
    sidebarToggle?: boolean;
    refreshSeconds?: number;
    /** The page's one nonce'd script: region pollers + the chrome layer,
     * composed by sendScreen. Read-only regions only; one nonce per
     * response. fallbackRefresh marks a page whose script POLLS — only
     * those earn the noscript meta-refresh (a chrome-layer-only page with
     * forms must never re-render what someone was typing). */
    live?: { nonce: string; script: string; fallbackRefresh?: boolean };
  } = {},
): string {
  const head = [
    "<!doctype html>",
    `<html lang="en"${themeAttribute()}><head><meta charset="utf-8">`,
    // viewport-fit=cover is what makes env(safe-area-inset-*) non-zero on a
    // notched phone; without it the tab bar sits under the home indicator.
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
    ...(requestContext.getStore()?.theme
      ? [`<meta name="theme-color" content="${requestContext.getStore()?.theme === "dark" ? "#0b0b0b" : "#efefef"}">`]
      : [`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0b0b">`, `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#efefef">`]),
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
    `<link rel="icon" href="/icon.svg" type="image/svg+xml">`,
    // Live status with zero JavaScript: the page asks the browser to fetch
    // it again. Only ever on read-only briefing pages — a refresh on a page
    // with a form would eat what somebody was typing.
    // A refresh is a reload, and reloads never cross-fade. No page opts
    // out of the fade either: opening one from a page that fades makes
    // the browser report the aborted fade as an error.
    ...(options.refreshSeconds === undefined
      ? []
      : [`<meta http-equiv="refresh" content="${Math.max(5, Math.floor(options.refreshSeconds))}">`]),
    // With the in-place swapper, the whole-page refresh survives only as
    // the no-JavaScript fallback — and CSS view transitions run without
    // JavaScript, so the fallback carries its own opt-out.
    ...(options.live?.fallbackRefresh !== true
      ? []
      : [`<noscript><meta http-equiv="refresh" content="30"><style>@view-transition { navigation: none; }</style></noscript>`]),
    `<title>${escape(title)}</title><link rel="stylesheet" href="${WORKSPACE_STYLE.path}">${accentHead()}</head><body>${DESIGN_CONTRACT}`,
  ].join("\n");
  const tail =
    options.live === undefined
      ? `</body></html>`
      : `<script nonce="${options.live.nonce}">${options.live.script}</script></body></html>`;

  if (options.chrome === undefined) {
    // Chromeless: the login page and refusal pages.
    return [head, `<main>`, body, `</main>`, tail].join("\n");
  }

  const chrome = options.chrome;
  const item = (key: Chrome["active"], href: string, label: string, count?: number): string =>
    `<a href="${href}" aria-label="${escape(label)}" title="${escape(label)}"${chrome.active === key ? ' class="active"' : ""}${key === "inbox" && count !== undefined ? ` data-waiting="${count}"` : ""}>` +
    `${label}` +
    `${count !== undefined && count > 0 ? ` <span class="count badge badge-open">${count}${key === "inbox" && chrome.inboxSaturated ? "+" : ""}</span>` : ""}</a>`;

  // The scope bar (portfolio arc §1): ONE row naming which rows this screen
  // can show — derived from the route's declared scope, falling back to the
  // session default. It replaced the sidebar workspace card and the mobile
  // pill's link as the single scope truth. Display and GET navigation only;
  // switching projects stays the POST + CSRF /projects flow.
  const effectiveScope: "all" | "project" | "board-all" =
    chrome.scope ?? (chrome.project === null ? "all" : "project");
  const peekCounts = chrome.active === "code" || chrome.projectPeek === null || chrome.projectPeek === undefined || effectiveScope !== "project" ? null : chrome.projectPeek;
  const scopeCounts = peekCounts === null
    ? ""
    : (peekCounts.waiting > 0 ? `<span class="hot">${peekCounts.waiting} needs you</span>` : `<span>0 needs you</span>`) +
      `<span>${peekCounts.running} live</span><span>${peekCounts.queued} queued</span>`;
  // On a desk each count is the road to what it counts; inside the phone
  // pill's summary they stay text, since the pill itself is the switcher.
  const scopeStatus = peekCounts === null
    ? ""
    : `<span class="scope-status">` +
      (peekCounts.waiting > 0 ? `<a class="hot" href="/work?view=needs-you">${peekCounts.waiting} needs you</a>` : `<a href="/work?view=needs-you">0 needs you</a>`) +
      `<a href="/runs">${peekCounts.running} live</a><a href="/board?view=order">${peekCounts.queued} queued</a></span>`;
  const scopeName = effectiveScope === "project" && chrome.project !== null ? escape(projectName(chrome.project)) : "All projects";
  // The switcher (board pass): the scope's name opens a menu of every
  // enrolled project — one tap to open one, or to widen to all — as plain
  // POST forms carrying the session's csrf, returning to this screen.
  // Inert wherever the chrome may carry no forms: a sensitive page, or a
  // request without a cookie session.
  const canSwitch =
    options.sensitive !== true && chrome.csrf !== undefined && chrome.csrf !== "" && chrome.projects !== undefined;
  const switcherMenu = (foot: string): string => {
    if (!canSwitch) return "";
    const hidden =
      `<input type="hidden" name="csrf" value="${escape(chrome.csrf as string)}">` +
      `<input type="hidden" name="return" value="${escape(chrome.returnTo ?? "/")}">`;
    const allCurrent = effectiveScope !== "project";
    const rows = [
      `<form method="post" action="/projects/select">${hidden}<input type="hidden" name="path" value="">` +
        `<button type="submit"${allCurrent ? ' class="current" aria-current="true"' : ""}>All projects</button></form>`,
      ...(chrome.projects ?? []).map(
        one =>
          `<form method="post" action="/projects/open">${hidden}<input type="hidden" name="path" value="${escape(one.path)}">` +
          `<button type="submit"${!allCurrent && chrome.project === one.path ? ' class="current" aria-current="true"' : ""}>${escape(one.name)}</button></form>`,
      ),
    ];
    return `<div class="switcher-menu" role="menu">${rows.join("")}${foot}</div>`;
  };
  // No "scope" label word: in this product "scope" names a task's approved
  // terms — the bar just states which projects the screen is showing.
  const scopeBar =
    `<div class="scope-bar">` +
    (canSwitch
      ? `<details class="switcher"><summary class="name">${scopeName}${CHEVRON_ICON}</summary>${switcherMenu("")}</details>`
      : `<span class="name">${scopeName}</span>`) +
    scopeStatus +
    `</div>`;
  // The rail's own accordion (sidebar rework): open the group holding the
  // active page, closed otherwise — the client toggle keeps it exclusive.
  const navGroup = (key: "tools" | "settings", label: string, rows: NavRow[], open: boolean): string =>
    `<details class="nav-group" data-group="${key}"${open ? " open" : ""}>` +
    `<summary>${label}${CHEVRON_ICON}</summary>` +
    `<nav class="nav-group-items">${rows.map(row => item(row.key, row.href, row.label)).join("")}</nav>` +
    `</details>`;
  // The three primary destinations (workspace package 1): Chat, Work,
  // Projects — every old page keeps its own active key and lights the
  // destination it now lives under. The count rides Work: it is the
  // saturated needs-you count, exactly as the inbox row wore it.
  const primary = chrome.active === "code" ? "work" : primaryDestinationOf(chrome.active);
  const primaryItem = (key: "code" | "chat" | "work" | "projects" | "flows", href: string, label: string, count?: number): string =>
    `<a href="${href}" aria-label="${escape(key === "work" && count !== undefined && count > 0 && chrome.inboxLabel !== undefined ? `${label}, ${chrome.inboxLabel}` : label)}" title="${escape(label)}"${primary === key ? ' class="active" aria-current="page"' : ""}${key === "work" && count !== undefined ? ` data-waiting="${count}"` : ""}>` +
    `<span class="glyph">${NAV_ICONS[key] ?? ""}</span>${label}` +
    `${count !== undefined && count > 0 ? ` <span${chrome.inboxLabel === undefined ? "" : ` aria-label="${escape(chrome.inboxLabel)}" title="${escape(chrome.inboxLabel)}"`} class="count badge badge-open">${count}${chrome.inboxSaturated ? "+" : ""}</span>` : ""}</a>`;
  const side = [
    `<aside class="side">`,
    `<div class="side-head"><a class="brand" href="${chrome.chat === true ? "/chat" : "/work"}"><span class="brand-long">Toolroll</span><span class="brand-short">T</span></a>`,
    ...(options.sidebarToggle === true
      ? [`<button type="button" class="side-toggle" aria-label="collapse sidebar" aria-expanded="true" title="collapse sidebar">${strokeIcon(`<path d="m15 18-6-6 6-6"/>`)}</button>`]
      : []),
    `</div>`,
    `<nav>`,
    // Chat is present only where the ceiling ever allows it (unchanged
    // gating); Work and Projects always. Every specialist tool is a dim
    // text row inside one of the two accordion groups below.
    ...(chrome.chat ? [primaryItem("chat", "/chat", "Chat")] : []),
    primaryItem("work", "/work", "Tasks", chrome.inboxCount),
    primaryItem("flows", "/flows", "Flows"),
    primaryItem("projects", "/projects", "Projects"),
    `</nav>`,
    ...(chrome.active === "code" ? [] : [`<a class="new-task" href="/tasks/new" aria-label="New task">+ New task</a>`]),
    `<nav class="nav-groups">`,
    navGroup("tools", "Work tools", workToolRows(chrome.projectScoped, chrome.chat, chrome.code), TOOL_KEYS.has(chrome.active)),
    navGroup("settings", "Settings", settingsRows(chrome.projectScoped, chrome.settings), SETTINGS_KEYS.has(chrome.active)),
    `</nav>`,
    `<span class="grow"></span>`,
    `</aside>`,
  ].join("\n");

  // The sandbox banner: every page, no dismissal — a screenshot of a demo
  // must not pass as production (adoption review, finding 8; the FENCE is
  // the refuseDemo gate in operate.ts, this is the honest label).
  const demoBanner =
    (chrome.demo === true
      ? `<div class="banner"><span class="badge">Demo</span>${escape(DEMO_BANNER.replace(/^Demo: /, ""))}</div>`
      : "") +
    (chrome.modeBanner === undefined
      ? ""
      : `<div class="banner"><span class="badge badge-running">Mode</span>${escape(chrome.modeBanner.words)} \u00b7 <a href="/mode">the terms \u00b7 end it</a></div>`) +
    (chrome.signIn ?? []).map(one => `<div class="banner sign-in-banner" data-sign-in="${escape(one.provider)}"><strong>${escape(one.title)}</strong> \u00b7 run <code>${escape(one.command)}</code> on this computer, then resume.${one.detail === "" ? "" : ` ${escape(one.detail)}`}` +
      `<form method="post" action="${escape(one.resumeHref)}" class="inline"><input type="hidden" name="csrf" value="${escape(chrome.csrf ?? "")}"><button type="submit">${escape(one.resumeLabel)}</button></form></div>`).join("") +
    (chrome.updateWaiting === undefined
      ? ""
      : `<div class="banner update-waiting" role="status">${escape(chrome.updateWaiting.words)} \u00b7 <a href="/settings/updates">Update status</a></div>`) +
    (chrome.update === undefined
      ? ""
      : `<div class="banner update-banner" data-update="${escape(chrome.update.version)}">${escape(updateNoticeWords(chrome.update))} \u00b7 <a href="${escape(chrome.update.href)}">What's new</a>` +
        `<form method="post" action="${escape(chrome.update.dismissHref)}" class="inline"><input type="hidden" name="csrf" value="${escape(chrome.csrf ?? "")}"><input type="hidden" name="version" value="${escape(chrome.update.version)}"><button type="submit">Dismiss</button></form></div>`);
  // The scope bar sits between the banners and the main/split body, so it
  // can never disappear with a responsive pane (portfolio arc §1).
  const content =
    chrome.listPane === undefined
      ? `<div class="content">${demoBanner}${scopeBar}<main>${body}</main></div>`
      : `<div class="content">${demoBanner}${scopeBar}<div class="split">` +
        `<div class="list-pane">${chrome.listPane}</div>` +
        `<div class="detail"><main>${body}</main></div>` +
        `</div></div>`;

  // The phone chrome (arc 4): a top bar with the project one tap from
  // switching and quick capture, and a bottom tab bar with the always-
  // visible destinations (chat where allowed, inbox, board, builds,
  // projects) a thumb visits — everything else behind /menu. CSS shows
  // these only below 760px; desktop keeps the sidebar untouched.
  const mobileTop = [
    `<header class="mobile-top">`,
    `<a class="brand-mini" href="${chrome.chat === true ? "/chat" : "/work"}">T</a>`,
    // On a phone the pill IS the scope row (mobile pass): the project's
    // name, its three counts, and the one /projects link at that
    // breakpoint — the scope bar hides below 760px so the header is one
    // row, not three. Desktop keeps the scope bar's link and hides this.
    canSwitch
      ? `<details class="project-pill switcher"><summary><span class="name">${scopeName}${CHEVRON_ICON}</span>${
          scopeCounts === "" ? "" : `<span class="pill-status">${scopeCounts}</span>`
          }</summary>${switcherMenu(`<a class="manage" href="/projects">manage projects</a>`)}</details>`
      : `<a class="project-pill" href="/projects"><span class="name">${scopeName}</span>${
          scopeCounts === "" ? "" : `<span class="pill-status">${scopeCounts}</span>`
        }</a>`,
    ...(chrome.active === "code" ? [] : [`<a class="mobile-new" href="/tasks/new">+ task</a>`]),
    // Settings and the specialist tools are a header action on a phone,
    // never a fourth primary tab (workspace package 1).
    `<a class="mobile-more" href="/menu" aria-label="tools and settings" title="tools and settings">${strokeIcon(`<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>`)}</a>`,
    `</header>`,
  ].join("");
  // Drawn icons, one stroke weight, inline and CSP-safe — never unicode
  // glyphs standing in for an icon system.
  const icon = (paths: string): string =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const TAB_ICONS = {
    code: icon(`<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>`),
    chat: icon(CHAT_PATHS),
    work: icon(WORK_PATHS),
    projects: icon(FOLDER_PATHS),
    flows: icon(`<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>`),
  } as const;
  const tab = (key: keyof typeof TAB_ICONS, href: string, label: string, count?: number): string =>
    // A phone tab says THAT something waits, with a dot; the number is on
    // the Work views themselves (Linear Mobile's rule — one tap away).
    `<a href="${href}"${primary === key ? ' class="active" aria-current="page"' : ""}><span class="glyph">${TAB_ICONS[key]}</span>${label}` +
    `${count !== undefined && count > 0 ? `<span class="dot-badge" role="img" aria-label="${escape(chrome.inboxLabel ?? `${count} waiting`)}"></span>` : ""}</a>`;
  // Three primary tabs, the same three as the rail: chat where allowed,
  // work, projects. Tools and settings sit behind the header's menu action.
  const tabbar = [
    `<nav class="tabbar">`,
    ...(chrome.chat ? [tab("chat", "/chat", "Chat")] : []),
    tab("work", "/work", "Tasks", chrome.inboxCount),
    tab("flows", "/flows", "Flows"),
    tab("projects", "/projects", "Projects"),
    `</nav>`,
  ].join("");

  return [head, `<div class="app">`, side, mobileTop, content, tabbar, `</div>`, tail].join("\n");
}


/** ONE way a person is named on any surface (U3): the same chip everywhere. */
export function personChip(name: string): string {
  return `<span class="mono">${escape(name)}</span>`;
}

/** The invite's front door: cookie-free, script-free, sensitive by shape.
 * Rendered only for a LIVE token — everything dead gets joinDeadPage. */
export function joinFormPage(token: string, problem: string | null, name: string): string {
  return shell("Join Toolroll", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>`,
    `<p class="meta hint">You were invited. Pick a name and a password to sign in.</p>`,
    `<div class="login-card">`,
    problem === null ? "" : `<div class="problem" role="alert">${escape(problem)}</div>`,
    `<form method="post" action="/join/${escape(token)}">`,
    `<label>Username<input type="text" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escape(name)}" autofocus></label>`,
    `<label>Password<input type="password" name="password" autocomplete="new-password"></label>`,
    `<button type="submit">Create my sign-in</button>`,
    "</form>",
    `</div>`,
    `<p class="login-foot">This link works once, for you.</p>`,
    `</div></div>`,
  ].join("\n"), { nav: false });
}

/** Unknown, expired, revoked, consumed, attempts spent: ONE page (D6). */
export function joinDeadPage(): string {
  return shell("Join Toolroll", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>`,
    `<div class="login-card">`,
    `<p>This invite link can't be used.</p>`,
    `<p class="meta">Links work once and expire. Ask the person who invited you for a fresh one.</p>`,
    `</div>`,
    `</div></div>`,
  ].join("\n"), { nav: false });
}

/**
 * v100: for someone signed in with the identity provider, every step-up
 * password field (autocomplete="current-password"; a secret like a bot token
 * is never one) becomes that sign-in: confirmed, when the provider checked
 * them in the last ten minutes, or a link to be checked again, then back here.
 */
export function ssoStepUps(html: string, sso: { label: string; fresh: boolean }, returnTo: string): string {
  const stepUp = (attributes: string) => /\btype="password"/.test(attributes) && /\bautocomplete="current-password"/.test(attributes);
  const swap = (attributes: string) => {
    const name = /\bname="([^"]+)"/.exec(attributes)?.[1] ?? "token";
    return `<input type="hidden" name="${name}" value="">` + (sso.fresh
      ? `<span class="sso-step-up" data-sso-step-up="confirmed">Confirmed with ${escape(sso.label)}</span>`
      : `<a class="sso-step-up" data-sso-step-up="confirm" href="/login/sso?reauth=1&amp;return=${escape(encodeURIComponent(returnTo))}">Confirm with ${escape(sso.label)}</a>`);
  };
  return html
    .replace(/<label>[^<]*<input\b([^>]*)>\s*<\/label>/g, (whole, attributes: string) => stepUp(attributes) ? swap(attributes) : whole)
    .replace(/<input\b([^>]*)>/g, (whole, attributes: string) => stepUp(attributes) ? swap(attributes) : whole);
}

/** The brand, as the workspace sidebar shows it. */
export const BRAND_HTML = `<span class="so-brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>Toolroll`;

/** A page on its own, in the workspace's look but with no script: the brand, then the page. */
export function focusDocument(title: string, body: string): string {
  return shell(title, `<div class="focus-page"><a class="so-wordmark focus-brand" href="/chat">${BRAND_HTML}</a>${body}</div>`);
}

export function loginPage(problem: string | null, returnTo = "/", sso: { label: string; operatorsOnly: boolean } | null = null): string {
  // v100: with an identity provider, its button comes first and passwords wait behind "Use a password".
  const provider = sso === null ? "" : `<a class="button-link login-sso" href="/login/sso${returnTo === "/" ? "" : `?return=${encodeURIComponent(returnTo)}`}">Sign in with ${escape(sso.label)}</a>`;
  return shell("Toolroll", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>`,
    problem === null || sso === null ? "" : `<div class="problem" role="alert">${escape(problem)}</div>`,
    provider,
    sso === null ? "" : `<details class="login-password"><summary>${sso.operatorsOnly ? "Instance operators: use a password" : "Use a password"}</summary>`,
    `<div class="login-card">`,
    problem === null || sso !== null ? "" : `<div class="problem" role="alert">${escape(problem)}</div>`,
    `<form method="post" action="/login">`,
    returnTo === "/" ? "" : `<input type="hidden" name="return" value="${escape(returnTo)}">`,
    `<label>Username<input type="text" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>`,
    `<label>Password<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">Sign in</button>`,
    "</form>",
    `</div>`,
    sso === null ? "" : `</details>`,
    `<p class="login-foot">${sso === null ? "Your login was shown when Toolroll first started, and saved beside its database as <code>up-login.txt</code>.<br>" : ""}No account? Ask whoever runs it for an invite link.</p>`,
    `</div></div>`,
  ].join("\n"), { nav: false });
}

/**
 * The page for an address the console doesn't answer to (onboarding): what was opened, where it answers, and the exact
 * command that admits this address. It stands alone (styles inline, no script, no font), because every other asset
 * would be refused at this address too; and it holds nothing a stranger's page doesn't already know.
 */
export function wrongHostPage(facts: { opened: string | null; served: string; command: string | null }): string {
  const code = (text: string) => `<code>${escape(text)}</code>`;
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light dark"><title>Toolroll isn't set up for this address</title>`,
    `<style>`,
    `:root{color-scheme:light dark;--ground:#efefef;--paper:#fff;--ink:#171717;--muted:#666;--line:#e6e6e6;--soft:#f2f2f2}`,
    `@media (prefers-color-scheme:dark){:root{--ground:#0b0b0b;--paper:#161616;--ink:#ededed;--muted:#a1a1a1;--line:#262626;--soft:#1f1f1f}}`,
    `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--ground);color:var(--ink);`,
    `font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}`,
    `main{width:100%;max-width:520px;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:28px}`,
    `.mark{font-weight:600;letter-spacing:-.01em;color:var(--muted);margin:0 0 16px}h1{font-size:18px;line-height:1.375;margin:0 0 8px;letter-spacing:-.01em}`,
    `p{margin:0 0 12px}code{font:12.5px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:var(--soft);border-radius:5px;padding:1px 5px;overflow-wrap:anywhere}`,
    `pre{margin:0 0 16px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px 14px;white-space:pre-wrap;overflow-wrap:anywhere}pre code{background:none;padding:0}`,
    `.meta{color:var(--muted);font-size:13px;margin:0}`,
    `</style></head><body><main>`,
    `<p class="mark">Toolroll</p>`,
    `<h1>Toolroll isn't set up for this address</h1>`,
    facts.opened === null
      ? `<p>It answers at ${code(facts.served)} on the computer running it.</p>`
      : `<p>You opened it at ${code(facts.opened)}. It answers at ${code(facts.served)} on the computer running it.</p>`,
    facts.command === null ? "" : `<p>To use this address, stop Toolroll (Ctrl-C) and start it again with:</p><pre><code>${escape(facts.command)}</code></pre>`,
    `<p class="meta">On that computer, ${code(`http://${facts.served}/`)} always works. Other addresses need your say-so, so no other website can reach it.</p>`,
    `</main></body></html>`,
  ].join("\n");
}

/** The first-account page (setup review): shown only while no approver exists. */
export function signupPage(problem: string | null, attemptsLeft: number): string {
  return shell("Toolroll", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>`,
    `<div class="login-card">`,
    `<p><strong>Create the first account</strong></p>`,
    `<p class="meta">There are no accounts yet. The terminal that started Toolroll printed a setup code; enter it here with the username and password you want.</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    attemptsLeft <= 0
      ? ""
      : [
          `<form method="post" action="/signup">`,
          `<label>Setup code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus></label>`,
          `<label>Username<input type="text" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>`,
          `<label>Password<input type="password" name="password" autocomplete="new-password"></label>`,
          `<button type="submit">Create account and sign in</button>`,
          "</form>",
        ].join("\n"),
    `</div>`,
    `</div></div>`,
  ].join("\n"), { nav: false });
}

/**
 * The inbox (v3): only things stalling progress without a person, one card
 * per underlying stall, each with its verb inline or one step away. No
 * auto-refresh — approval links lead to the step-up screen, and a page
 * that might hold typed input never re-renders itself.
 */
export type InboxTab = "needs-you" | "ready" | "running" | "all";
export const INBOX_TABS: readonly { id: InboxTab; label: string }[] = [
  { id: "needs-you", label: "Needs you" }, { id: "ready", label: "Ready" }, { id: "running", label: "Running" }, { id: "all", label: "All" },
];
export function parseInboxTab(raw: string | null): InboxTab | undefined {
  return INBOX_TABS.some(one => one.id === raw) ? raw as InboxTab : undefined;
}
/** What each tab holds, as a short fingerprint: a tab is unread when its
 * fingerprint differs from the one this browser saw there last. */
export function inboxFingerprints(data: Pick<Parameters<typeof inboxPage>[1], "decisions" | "approvals" | "requeueables" | "cancelledBlockers" | "gaps" | "needsVerification" | "ready" | "running">): Record<InboxTab, string> {
  const print = (keys: string[]) => createHash("sha256").update([...keys].sort().join("\n")).digest("hex").slice(0, 8);
  const needs = [...data.decisions.map(one => `d${one.id}`), ...data.approvals.map(one => `a${one.taskId}@${one.proposedAt}`), ...data.requeueables.map(one => `q${one.taskId}:${one.strikes}`),
    ...data.cancelledBlockers.map(one => `c${one.blockerId}`), ...data.gaps.map(one => `g${one.key}`)];
  const ready = [...data.needsVerification.map(one => `v${one.taskId}`), ...(data.ready ?? []).map(one => `r${one.taskId}`)];
  const running = (data.running ?? []).map(one => `u${one.taskId}`);
  return { "needs-you": print(needs), ready: print(ready), running: print(running), all: print([...needs, ...ready, ...running]) };
}

export function inboxPage(chrome: Chrome, data: {
  csrf: string;
  revision: number;
  /** No project open in scoped mode: every admitted project at once,
   * chips on every row, links only — acting means opening the project. */
  rollup: boolean;
  /** A project is OPEN: only then do decisions answer on the card. The
   * legacy unscoped projectless inbox stays links-only too (commit-1
   * review, finding 4) — the partial belongs to a chosen project. */
  interactive: boolean;
  decisions: (Decision & { taskId: string; repo?: string | null })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string; repo?: string | null; /** v48 authority repair: the closed consent door's title, or null when a yes could bind. */ closed?: string | null }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo?: string | null }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string; repo?: string | null; blockerRepo?: string | null }[];
  gaps: Gap[];
  /** A completed task whose proof is short or refuted and not yet accepted
   * (Priority 2) — reads "needs verification" here too, never silently
   * "done" just because the inbox does not otherwise look at finished work. */
  needsVerification: { taskId: string; title: string; verdict: "short" | "refuted"; repo?: string | null; matrix?: CriterionMatrixRow[]; repairChain?: RepairChainRow | null }[];
  /** The first-run steps; null once the installation has had its first Ready result. */
  wizard: FirstRunStep[] | null;
  /** Whether any worker is answering right now — said at the top when none is. */
  worker: { answering: number; registered: number; lastHeard: string | null };
  now: Date;
  /** Console v2: the tab shown, results ready to review, work running now,
   * and the tabs holding something this browser hasn't seen (dots on a phone). */
  tab?: InboxTab;
  ready?: { taskId: string; title: string; detail: string; repo: string | null }[];
  running?: { taskId: string; title: string; detail: string; repo: string | null }[];
  unread?: readonly InboxTab[];
}): Screen {
  /** The row's project, worn openly in the roll-up — null is UNPLACED,
   * said as such, never a silent missing chip (finding 13). */
  const chip = (repo: string | null | undefined): string =>
    !data.rollup ? "" : repo === null || repo === undefined
      ? ` <span class="badge">Unplaced</span>`
      : ` <span class="badge">${escape(projectName(repo))}</span>`;
  const empty =
    data.decisions.length + data.approvals.length + data.requeueables.length +
    data.cancelledBlockers.length + data.gaps.length + data.needsVerification.length === 0;

  // The roll-up inbox keeps its links-only contract — acting means opening
  // the project. A SELECTED project's inbox answers reversible options on
  // the card itself (portfolio arc §2).
  const decisions =
    data.decisions.length === 0
      ? ""
      : `<h2>Answer a question</h2><p class="hint">an agent stopped mid-build to ask — nothing proceeds until you answer</p>` +
        data.decisions
          .map(decision =>
            data.interactive && !data.rollup
              ? decisionAnswerCard(decision, data.csrf, data.now, false)
              : `<a class="decide-card" href="/d/${decision.id}">` +
                `<p class="q">${escape(decision.question)}</p>` +
                `<span class="mono meta">${escape(decision.taskId)}</span>${chip(decision.repo)}` +
                `${isOverdue(decision, data.now) ? ` <span class="badge badge-overdue">Overdue</span>` : ""}` +
                `</a>`,
          )
          .join("\n");

  const approvals =
    data.approvals.length === 0
      ? ""
      : `<h2>Approve a scope</h2><p class="hint">scopes waiting for your approval — each binds to the exact wording you sign</p>` +
        data.approvals
          .map(
            one =>
              `<a class="decide-card" href="${taskHref(one.taskId)}">` +
              `<p class="q">${escape(one.title)}</p>` +
              `<span class="meta">${escape(one.goal.length > 120 ? one.goal.slice(0, 120) + "\u2026" : one.goal)}</span><br>` +
              `<span class="mono meta">${escape(one.taskId)}</span>${chip(one.repo)} <span class="right meta">${one.closed == null ? "review &amp; approve \u2192" : `needs attention: ${escape(one.closed.toLowerCase())} \u2192`}</span>` +
              `</a>`,
          )
          .join("\n");

  const requeueables =
    data.requeueables.length === 0
      ? ""
      : `<h2>Retry stalled work</h2><p class="hint">failed builds waiting for a person — retry clears the incidents and requeues</p>` +
        data.requeueables
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> ${escape(one.title)}${chip(one.repo)}` +
              `${one.incidentCount > 0 ? ` <span class="badge badge-failed">${one.incidentCount} incident${one.incidentCount > 1 ? "s" : ""}</span>` : ""}` +
              `${one.strikes > 0 ? ` <span class="meta">${one.strikes} failed attempt${one.strikes > 1 ? "s" : ""}</span>` : ""}` +
              (data.rollup
                ? `<span class="right meta">open its project to retry \u2192</span></p>`
                : `<span class="right"><form method="post" action="${taskHref(one.taskId)}/requeue" class="inline">` +
                  `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
                  `<input type="hidden" name="return" value="inbox">` +
                  `<button type="submit">Retry</button></form></span></p>`),
          )
          .join("\n");

  const needsVerification =
    data.needsVerification.length === 0
      ? ""
      : `<h2>Needs review</h2><p class="hint">finished, but the evidence needs your attention before accepting</p>` +
        data.needsVerification
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> ${escape(one.title)}${chip(one.repo)}` +
              ` <span class="badge badge-failed">${one.verdict === "refuted" ? "conflicting evidence" : "missing evidence"}</span>${criterionMatrixSummary(one.matrix ?? [])}` +
              (one.repairChain == null ? "" : ` <span class="meta">— repair ${one.repairChain.outcome === "drafted" ? "drafted, awaiting approval" : one.repairChain.outcome}</span>`) +
              `</p>`,
          )
          .join("\n");

  const cancelled =
    data.cancelledBlockers.length === 0
      ? ""
      : `<h2>Choose how waiting tasks continue</h2><p class="hint">these tasks were waiting for work that was cancelled — open one and choose what happens next</p>` +
        data.cancelledBlockers
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.exampleDependent)}">${escape(one.exampleDependent)}</a>${chip(one.repo)} ` +
              `<span class="meta">${one.dependentCount > 1 ? `one of ${one.dependentCount} tasks waiting` : "waiting"} for cancelled task ${escape(one.blockerId)}` +
              `${data.rollup && one.repo !== one.blockerRepo ? ` \u00b7 across projects${one.repo === null || one.repo === undefined ? "" : ` \u2014 waits in ${escape(projectName(one.repo))}`}` : ""}</span></p>`,
          )
          .join("\n");

  const gaps =
    data.gaps.length === 0
      ? ""
      : `<h2>Supply a requirement</h2><p class="hint">approved work is ready except for these — fill one and its tasks start</p>` +
        data.gaps
          .map(
            gap =>
              `<p class="row"><a href="/caps">${escape(gap.key)}</a> ` +
              `<span class="meta">frees ${gap.unblocks.length} task${gap.unblocks.length > 1 ? "s" : ""}</span>` +
              `<span class="right meta">how to fix \u2192</span></p>`,
          )
          .join("\n");

  // The first-run steps, until the first Ready result: each is done or
  // shows the one action that does it.
  const wizard =
    data.wizard === null
      ? ""
      : `<div class="card" data-first-run>` +
        `<p><strong>Get to your first result</strong></p>` +
        data.wizard
          .map(
            step =>
              `<p class="row" data-step="${step.key}"><span class="mono" aria-hidden="true">${step.done ? "\u2713" : "\u25cb"}</span> <strong>${escape(step.title)}</strong>` +
              (step.checking ? ` <span class="meta">checking…</span>` : step.action === null ? ` <span class="meta">done</span>`
                : step.action.kind === "link" ? ` <a href="${escape(step.action.href)}">${escape(step.action.label)}</a>`
                : ` <code>${escape(step.action.command)}</code>`) +
              `</p>`,
          )
          .join("\n") +
        `</div>`;

  const noWorker =
    data.worker.answering > 0
      ? ""
      : `<div class="card builder-notice" data-builder-status="${data.worker.registered === 0 ? "not-connected" : "disconnected"}">` +
        (data.worker.registered === 0
          ? `<strong>No builder is connected yet.</strong> Toolroll is open, but no machine is connected to do project work. On the machine where the project lives, open that folder and run <span class="mono">toolroll up</span>. Keep Toolroll running; approved work starts automatically.`
          : `<strong>Builder disconnected.</strong> ${data.worker.registered} builder${data.worker.registered === 1 ? " is" : "s are"} configured, last checked in ${data.worker.lastHeard === null ? "never" : whenTime(data.worker.lastHeard)}. Reopen Toolroll on that machine. Queued work starts automatically when a builder reconnects.`) +
        `</div>`;

  // Console v2: Needs you · Ready · Running · All, as real links (Back and
  // bookmarks work). Each section belongs to one tab; All shows every one.
  const tab = data.tab ?? "all";
  const shows = (one: Exclude<InboxTab, "all">): boolean => tab === "all" || tab === one;
  const listRows = (rows: { taskId: string; title: string; detail: string; repo: string | null }[]): string =>
    rows.map(one => `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.title)}</a>${chip(one.repo)} <span class="meta">${escape(one.detail)}</span></p>`).join("\n");
  const ready = (data.ready ?? []).length === 0 ? "" : `<h2>Ready to review</h2>` + listRows(data.ready ?? []);
  const running = (data.running ?? []).length === 0 ? "" : `<h2>Running now</h2>` + listRows(data.running ?? []);
  const asks = { decide: data.decisions.length + data.approvals.length, unblock: data.requeueables.length + data.cancelledBlockers.length + data.gaps.length };
  const counts: Record<InboxTab, number> & typeof asks = { ...asks,
    "needs-you": asks.decide + asks.unblock,
    ready: data.needsVerification.length + (data.ready ?? []).length,
    running: (data.running ?? []).length,
    all: 0,
  };
  counts.all = counts["needs-you"] + counts.ready + counts.running;
  // Each ask is a small heading with its count over its sections (their own headings one step down).
  const askGroup = (ask: Ask, count: number, sections: string[]): string => count === 0 ? ""
    : `<section class="inbox-ask" data-ask="${ask}"><h2>${ASK_LABEL[ask]} <span class="count">${count}</span></h2>${sections.join("").replace(/<(\/?)h2>/g, "<$1h3>")}</section>`;
  const tabs = data.tab === undefined ? "" : `<nav class="inbox-tabs" aria-label="Inbox views">` + INBOX_TABS.map(one =>
    `<a href="/inbox?tab=${one.id}"${one.id === tab ? ` aria-current="page"` : ""} data-inbox-tab="${one.id}">${one.label}` +
    `<span class="inbox-tab-count${one.id === "needs-you" && counts[one.id] > 0 ? " inbox-tab-count--needs" : ""}">${counts[one.id]}</span>` +
    `${one.id !== tab && (data.unread ?? []).includes(one.id) ? `<span class="inbox-unread" aria-label="new"></span>` : ""}</a>`).join("") + `</nav>`;
  const tabEmpty = data.tab !== undefined && tab !== "all" && counts[tab] === 0
    ? `<div class="card"><p class="meta">${tab === "needs-you" ? "Nothing needs you." : tab === "ready" ? "No results are waiting for review." : "Nothing is running."}</p></div>` : "";
  return screen("inbox", [
    `<h1>Inbox</h1>`,
    `<p class="meta">Everything that waits on you \u2014 empty means the fleet is working</p>`,
    tabs,
    noWorker,
    wizard,
    empty || !shows("needs-you") ? "" : `<p><a class="new-task" style="display:inline-block" href="/next">clear the queue \u2192 one thing at a time</a></p>`,
    empty && data.wizard === null && shows("needs-you") && counts.all === 0 ? `<div class="card"><p><strong>Nothing needs you.</strong></p><p class="meta">The queue is either working or waiting on its own timers. <a href="/board">Watch the board</a> or <a href="/activity">read the activity report</a>.</p></div>` : tabEmpty,
    // What waits on a person, grouped by what it asks: Decide, then Review, then Unblock.
    shows("needs-you") ? askGroup("decide", counts.decide, [approvals, decisions]) : "",
    shows("ready") ? askGroup("review", counts.ready, [needsVerification, ready]) : "",
    shows("needs-you") ? askGroup("unblock", counts.unblock, [requeueables, cancelled, gaps]) : "",
    shows("running") ? running : "",
    data.rollup
      ? `<p class="meta">Requirement gaps are checked one project at a time \u2014 open a project to see and fill its gaps · <a href="/projects">open a project</a></p>`
      : "",
    // Quick capture: the shortest path from "I want this done" to the
    // approve card — title and goal here, the yes on the next screen. The
    // one-shot form posts to the same guarded handler as the full page.
    data.rollup ? "" : `<h2>Capture new work</h2>`,
    data.rollup ? "" : `<form method="post" action="/tasks/add" class="card">`,
    ...(data.rollup
      ? []
      : [
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<input type="hidden" name="projectRevision" value="${data.revision}">`,
          `<label>What should get done<input type="text" name="title" placeholder="task title" maxlength="200"></label>`,
          `<label>What success looks like <span class="meta">(becomes the scope you approve on the next screen)</span><textarea name="goal" rows="2"></textarea></label>`,
          `<button type="submit">Queue it \u2192 approve its scope next</button>`,
          `</form>`,
        ]),
  ].join("\n"), {
    chrome,
    // The inline-answer enhancement rides only where its forms render; it
    // touches one card and nothing else, so quick-capture input survives.
    ...(data.interactive && !data.rollup && data.decisions.length > 0
      ? { functional: { script: decisionAnswerScript(), fetches: true } }
      : {}),
  });
}

/** System: the machinery — workers, background service, workspaces. */
export function systemPage(chrome: Chrome, data: {
  agents: {
    phase: "plan" | "build" | "repair" | "review";
    provider?: string;
    model?: string | null;
    source?: "pinned" | "flag" | "project" | "installation" | "default";
    problem?: string;
    setBy: string | null;
  }[];
  building: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null }[];
  runners: Runner[];
  worktrees: WorktreeRow[];
  episode: { id: number; startedAt: string; endedAt: string | null; ticks: number; built: number; broke: number } | null;
  outboxPending: number;
  externalWork?: { remoteRepo: string; blocked: string | null; openEpisode: string | null }[];
  now: Date;
}): Screen {
  const nowMs = data.now.getTime();
  const runnerCards = data.runners
    .filter(one => one.retiredAt === null)
    .map(one => {
      const age = nowMs - new Date(one.heartbeatAt).getTime();
      const dot = age < 5 * 60_000 ? "dot-ok" : age < 60 * 60_000 ? "dot-warn" : "dot-off";
      const said = age < 5 * 60_000 ? "alive" : age < 60 * 60_000 ? `quiet ${Math.round(age / 60_000)}m` : "not heard from";
      const busy = data.building.filter(claim => claim.runner === one.name).length;
      return (
        `<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${escape(one.name)}</span>` +
        `<span class="v">builder \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building</span></div>`
      );
    });
  const worktreeCards = data.worktrees.map(tree => {
    const leased = tree.leasedAt !== null && tree.releasedAt === null;
    const dot = leased ? "dot-ok" : tree.verified ? "dot-off" : "dot-warn";
    const state = leased ? "building" : tree.verified ? "free" : "needs review";
    const name = tree.path.split("/").pop() ?? tree.path;
    return (
      `<div class="stat-card"><span class="k"><span class="dot ${dot}${leased ? " pulse" : ""}"></span><span class="mono">${escape(name)}</span></span>` +
      `<span class="v">workspace \u00b7 ${escape(tree.branch)} \u00b7 ${state}</span></div>`
    );
  });
  const watchCard =
    data.episode === null
      ? ""
      : `<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>Toolroll</span>` +
        `<span class="v">${
          data.episode.endedAt === null
            ? `running since ${whenTime(data.episode.startedAt)}`
            : `last run: ${data.episode.built} built, ${data.episode.broke} broke \u00b7 ended ${whenTime(data.episode.endedAt)}`
        }</span></div>`;
  const cards = [...runnerCards, watchCard, ...worktreeCards].filter(one => one !== "");
  const PHASE_SAID: Record<string, string> = {
    plan: "planning sessions ask questions and draft the plan you approve",
    build: "builds do the work, unattended, inside the approved scope",
    repair: "repair turns mend a malformed handoff in the same session",
  };
  const agentLines = data.agents
    .map(one => {
      if (one.problem !== undefined) {
        return `<p class="row"><span class="mono">${escape(one.phase)}</span> <span class="badge badge-failed">Misconfigured</span> <span class="meta">${escape(one.problem)}</span></p>`;
      }
      const who =
        one.source === "project"
          ? `chosen for this project${one.setBy === null ? "" : ` by ${escape(one.setBy)}`}`
          : one.source === "installation"
            ? `set for the whole installation${one.setBy === null ? "" : ` by ${escape(one.setBy)}`}`
            : "the default — nothing configured";
      const dollars = one.provider === "claude" ? "" : ` · <span title="this provider reports tokens, not dollars — its runs land as unmeasured spend">no dollar costs</span>`;
      return (
        `<p class="row"><span class="mono">${escape(one.phase)}</span> ` +
        `<strong>${escape(one.provider ?? "")}</strong>` +
        `${one.model === null || one.model === undefined ? ` <span class="meta">(its default model)</span>` : ` · <span class="mono">${escape(one.model)}</span>`}` +
        `<span class="right meta">${who}${dollars}</span></p>` +
        `<p class="meta" style="margin-top:0">${PHASE_SAID[one.phase] ?? ""}</p>`
      );
    })
    .join("\n");
  const agentsCard =
    `<h2>Agents</h2>` +
    `<p class="meta">Which AI provider runs each phase — changed from the terminal with your credentials (<code>toolroll config</code>), never by a browser click</p>` +
    `<div class="card">${agentLines}` +
    `<p class="meta">Repair always stays on the provider that built — only its model can differ. A schedule's task filed under an approval moved from a routine is pinned to the agents approved then.</p>` +
    `</div>`;

  return screen("system", [
    `<h1>System</h1>`,
    `<p class="hint">builders execute tasks in isolated temporary copies of each project</p>`,
    agentsCard,
    cards.length === 0
      ? `<p class="meta">No builder is connected yet. On the machine where the project lives, open that folder and run <code>toolroll up</code>.</p>`
      : `<div class="cards">${cards.join("")}</div>`,
    data.outboxPending > 0 ? `<p class="meta">Notifications: ${data.outboxPending} pending delivery</p>` : "",
    (data.externalWork ?? []).length === 0
      ? ""
      : `<h2>External work</h2>` +
        (data.externalWork ?? [])
          .map(
            one =>
              `<p class="row"><span class="mono">${escape(one.remoteRepo)}</span> ` +
              (one.blocked !== null
                ? `<span class="badge badge-failed">Dispatch blocked</span> <span class="meta">the tracker connection needs repair — \`toolroll sync\` says why</span>`
                : one.openEpisode !== null
                  ? `<span class="badge badge-failed">Sync failing</span> <span class="meta">${escape(one.openEpisode)}</span>`
                  : `<span class="meta">syncing normally</span>`) +
              `</p>`,
          )
          .join("\n"),
  ].join("\n"), { chrome, refreshSeconds: data.building.length > 0 ? 10 : 60 });
}

/**
 * The board: the pipeline as lanes, position as meaning — attention, then
 * queued, then waiting, then building, then recently done. Read-only by
 * construction (every card is a link, no forms, no nonces), which is what
 * makes it safe to re-render itself while somebody watches.
 */
export function boardBody(
  data: {
    cards: BoardCard[];
    done: ReturnType<Store["listCompletedWorkScoped"]>;
    saturated: boolean;
    now: Date;
    /** The rolled-up view: every project inside the ceiling at once. */
    all: boolean;
    project: string | null;
    delta: { agoMinutes: number; built: number; failed: number; questions: number } | null;
  },
  ciRed: (pr: number) => boolean,
): string {
  const chip = (repo: string | null): string =>
    !data.all || repo === null ? "" : ` <span class="badge">${escape(projectName(repo))}</span>`;
  const CAP = 30;
  const age = (iso: string): string => {
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(iso).getTime()) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / (24 * 60))}d`;
  };

  const lane = (
    key: "attention" | "queued" | "waiting" | "building",
    title: string,
    hint: string,
    renderOne: (card: BoardCard, index: number) => string,
  ): string => {
    const cards = data.cards.filter(card => card.lane === key);
    // The longest-stalled card leads the board: attention sorts by how
    // long it has waited, everything else stays newest-first — except the
    // queued lane, which reads in DISPATCH order: moved-up work first,
    // exactly as the next free worker will pick it.
    if (key === "attention") {
      cards.sort((a, b) =>
        (a.stalledSince ?? "9999").localeCompare(b.stalledSince ?? "9999"),
      );
    }
    if (key === "queued") {
      // Group: the shared queue first, then reserved columns by worker;
      // dispatch order (rank) within each — never a cross-column rank race.
      cards.sort((a, b) => {
        const ka = a.assignedRunner ?? "";
        const kb = b.assignedRunner ?? "";
        if (ka !== kb) return ka.localeCompare(kb);
        return b.priority - a.priority;
      });
    }
    const shown = cards.slice(0, CAP);
    const more = cards.length - shown.length;
    // A lane is a section that can fold (board pass): open when it holds
    // cards, folded when empty, so a phone reads the counts first and a
    // desktop column never spends its height on "nothing here".
    return (
      `<details class="lane lane-${key}"${shown.length === 0 ? "" : " open"}>` +
      `<summary><h2>${title} <span class="lane-count">${cards.length}${data.saturated ? "+" : ""}</span></h2></summary>` +
      `<p class="hint">${hint}</p>` +
      (shown.length === 0 ? `<p class="meta lane-empty">nothing here</p>` : shown.map((card, index) => renderOne(card, index)).join("")) +
      (more > 0 ? `<a class="lane-more" href="/tasks">+${more} more in the task list</a>` : "") +
      `</details>`
    );
  };

  // The card's facts: mono key–value pairs under the title (board pass) —
  // task, worker, runtime — the same grammar on every lane, so the eye
  // learns one card. Chips carry the words (project, reservation).
  const facts = (rows: [string, string][]): string =>
    rows.length === 0
      ? ""
      : `<span class="facts">${rows
          .map(([k, v]) => `<span class="fact"><span class="k">${escape(k)}</span><span class="v">${escape(v)}</span></span>`)
          .join("")}</span>`;
  const chips = (parts: string[]): string => {
    const kept = parts.filter(one => one !== "");
    return kept.length === 0 ? "" : `<span class="chips">${kept.join(" ")}</span>`;
  };

  const plain = (card: BoardCard): string =>
    `<a class="lane-card" href="${card.href}">` +
    `<span class="id">${escape(card.taskId)}</span>` +
    `<span class="t">${escape(card.title)}</span>` +
    `<span class="why">${escape(card.reason)}</span>` +
    facts([
      ...(card.stalledSince === null ? [] : [["waiting", age(card.stalledSince)] as [string, string]]),
    ]) +
    chips([
      chip(card.repo).trim(),
    ]) +
    `</a>`;

  // The queued lane: ranks compare only within a COLUMN (queue-columns
  // review, finding 14), so the badge is per column head — the shared
  // queue's front card says "next up"; a reserved column's front card
  // says whose turn it is. No cross-column comparison is claimed.
  const queuedHeads = (() => {
    const heads = new Map<string, string>();
    for (const card of data.cards.filter(one => one.lane === "queued")) {
      const key = `${card.assignedRunner ?? ""}|${card.repo ?? ""}`;
      if (!heads.has(key)) heads.set(key, card.taskId);
    }
    return heads;
  })();
  const queuedCard = (card: BoardCard): string =>
    `<a class="lane-card" href="${card.href}">` +
    `<span class="id">${escape(card.taskId)}</span>` +
    `<span class="t">${escape(card.title)}</span>` +
    `<span class="why">${escape(card.reason)}</span>` +
    facts([
      ["worker", card.assignedRunner === null ? "any free worker" : card.assignedRunner],
    ]) +
    chips([
      queuedHeads.get(`${card.assignedRunner ?? ""}|${card.repo ?? ""}`) === card.taskId
        ? `<span class="badge">${card.assignedRunner === null ? "next up" : `next for ${escape(card.assignedRunner)}`}</span>`
        : "",
      card.assignedRunner === null ? "" : `<span class="badge">Reserved</span>`,
      chip(card.repo).trim(),
    ]) +
    `</a>`;

  const building = (card: BoardCard): string => {
    const claim = card.claim;
    if (claim === null) return plain(card);
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000));
    const workspace = claim.worktree === null ? null : (claim.worktree.split("/").pop() ?? claim.worktree);
    // Chip copy: unknown phases show nothing rather than raw tokens.
    const phase = claim.phase === null ? undefined : PHASE_WORDS[claim.phase];
    // The live strip is the run's own phase and clock — never a percent:
    // a build has no honest progress figure, only a stage and an elapsed.
    const live = claim.model === null ? "preparing workspace" : (phase ?? "the agent is working");
    return (
      `<a class="lane-card building" href="${card.href}">` +
      `<span class="id">${escape(card.taskId)}</span>` +
      `<span class="t"><span class="dot dot-ok pulse"></span>${escape(card.title)}</span>` +
      `<span class="live-line"><span class="stage">${escape(live)}</span><span class="clock">${minutes}m</span></span>` +
      facts([
        ["worker", claim.runner],
        ...(claim.model === null
          ? []
          : [["model", `${claim.provider !== null && claim.provider !== "claude" ? `${claim.provider} · ` : ""}${claim.model}`] as [string, string]]),
        ...(claim.branch === null ? [] : [["branch", `${claim.branch}${workspace === null ? "" : ` · ${workspace}`}`] as [string, string]]),
      ]) +
      chips([
        card.attempt === null ? "" : `<span class="badge">Attempt ${card.attempt}</span>`,
        chip(card.repo).trim(),
      ]) +
      `</a>`
    );
  };

  const doneCards =
    data.done.length === 0
      ? `<p class="meta lane-empty">nothing finished yet</p>`
      : data.done
          .map(row => {
            const pr =
              row.prNumber === null
                ? ""
                : ` <span class="badge badge-open">PR #${row.prNumber}</span>` +
                  (ciRed(row.prNumber) ? ` <span class="badge badge-failed">CI failing</span>` : "");
            return (
              `<a class="lane-card" href="${taskHref(row.taskId)}">` +
              `<span class="id">${escape(row.taskId)}</span>` +
              `<span class="t">${escape(row.title)}</span>` +
              `${row.handoff === null ? "" : `<span class="why">${escape(row.handoff.length > 120 ? row.handoff.slice(0, 120) + "\u2026" : row.handoff)}</span>`}` +
              facts([
                ...(row.ranMinutes === null ? [] : [["ran", `${row.ranMinutes}m`] as [string, string]]),
                ["usage", runCostWords({ authMode: row.authMode, costUsd: row.costUsd, tokensIn: null, tokensOut: null })],
              ]) +
              chips([
                `<span class="badge badge-done">${row.outcome === "no-change" ? "No change" : "Built"}</span>`,
                pr.trim(),
                data.all && row.repo !== null ? `<span class="badge">${escape(projectName(row.repo))}</span>` : "",
              ]) +
              `</a>`
            );
          })
          .join("");

  const toggle =
    data.project === null && !data.all
      ? ""
      : `<p class="meta board-scope">` +
        (data.all
          ? (data.project === null
              ? `<strong>All projects</strong>`
              : `<a href="/board">${escape(projectName(data.project))}</a> \u00b7 <strong>all projects</strong>`) +
            ` \u2014 every project this server serves, each card wearing its project`
          : `<strong>${escape(projectName(data.project as string))}</strong> \u00b7 <a href="/board?scope=all">all projects</a>`) +
        `</p>`;


  const ago = (minutes: number): string =>
    minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (24 * 60))}d`;
  const deltaLine =
    data.delta === null
      ? ""
      : `<p class="meta"><strong>Since you last looked</strong> (${ago(data.delta.agoMinutes)} ago): ` +
        [
          data.delta.built > 0 ? `<span class="good">${data.delta.built} built</span>` : "",
          data.delta.failed > 0 ? `<span class="bad">${data.delta.failed} failed</span>` : "",
          data.delta.questions > 0
            ? `${data.delta.questions} question${data.delta.questions > 1 ? "s" : ""} \u2014 <a href="/next">answer \u2192</a>`
            : "",
        ].filter(one => one !== "").join(" \u00b7 ") +
        `</p>`;

  return [
    `<h1>Board</h1>`,
    data.all ? "" : `<p class="meta board-view"><strong>State</strong> \u00b7 <a href="/board?view=order">order \u2192</a> <span class="meta">drag to reorder, or to reserve a task for one worker</span></p>`,
    deltaLine,
    toggle,
    `<div class="board">`,
    lane("attention", "needs you", "these wait for a person", plain),
    lane("queued", "queued", "starts when a worker is free", queuedCard),
    lane("waiting", "waiting", "paused until a time, another task, or a requirement is ready", plain),
    lane("building", "building", "one agent per card, in its own workspace", building),
    `<details class="lane lane-done"${data.done.length === 0 ? "" : " open"}><summary><h2><a href="/done">done recently</a></h2></summary><p class="hint">the most recent \u2014 the full list is under done</p>${doneCards}</details>`,
    `</div>`,
  ].join("\n");
}

/** Completed work: one row per done task, its final run and PR attached. */
export function donePage(
  chrome: Chrome,
  rows: ReturnType<Store["listCompletedWorkScoped"]>,
  ciRed: (pr: number) => boolean,
): Screen {
  const list =
    rows.length === 0
      ? `<p class="meta">No finished tasks yet.</p>`
      : rows
          .map(row => {
            const pr =
              row.prNumber === null
                ? row.publicationState === null
                  ? ""
                  : ` <span class="badge">${escape(sentenceCase(row.publicationState))}</span>`
                : ` <a href="${escape(row.prUrl ?? "#")}" class="badge badge-open">PR #${row.prNumber}</a>` +
                  (ciRed(row.prNumber) ? ` <span class="badge badge-failed">CI failing</span>` : "");
            const needsVerification =
              (row.proofVerdict === "short" || row.proofVerdict === "refuted") && !row.proofAccepted
                ? ` <span class="badge badge-failed">${row.proofVerdict === "refuted" ? "conflicting evidence" : "missing evidence"}</span>`
                : "";
            return (
              `<div class="card"><p><a href="${taskHref(row.taskId)}"><strong>${escape(row.title)}</strong></a>` +
              `${row.outcome === "no-change" ? ` <span class="badge">No change needed</span>` : ""}${pr}${needsVerification}${criterionMatrixSummary(row.proofMatrix)}</p>` +
              `${row.handoff === null ? "" : `<p class="meta">${escape(row.handoff.length > 200 ? row.handoff.slice(0, 200) + "\u2026" : row.handoff)}</p>`}` +
              `<p class="meta mono">${escape(row.taskId)} \u00b7 ${whenTime(row.completedAt)}${row.ranMinutes === null ? "" : ` \u00b7 ran ${row.ranMinutes}m`}${row.provider === null ? "" : ` \u00b7 ${escape(runCostWords({ authMode: row.authMode, costUsd: row.costUsd, tokensIn: null, tokensOut: null }))}`}` +
              ` \u00b7 <a href="${reviewHref(row.taskId)}">review \u2192</a></p></div>`
            );
          })
          .join("\n");
  return screen("done", [
    `<h1>Done</h1>`,
    buildsViews("done"),
    `<p class="hint">completed work in order of completion \u2014 each with its final build, the agent's conclusion, usage, and its pull request; <a href="/review">review</a> opens the same saved work and its checks</p>`,
    list,
  ].join("\n"), { chrome });
}

export function chatMoney(microusd: number | null): string {
  return microusd === null ? "unknown" : `$${(microusd / 1_000_000).toFixed(2)}`;
}

export type ChatProjectPulse = {
  id: string;
  label: string;
  path: string;
  peek: ProjectPeek | null;
};

/** A ceremony nonce as stored: the sha256 hex of the value the form carried. */
export function nonceHashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The approve POST's refusal, in words a person can act on. */
export function approveRefusalWords(reason: string): string {
  if (reason === "requester" || reason === "person-required") return gateWords({ verdict: "refuse", reason });
  if (reason === "unrouted") return "not approved: this scope predates agent routing and its old approval no longer stands — edit and re-file the scope so it is routed under today’s agents, then approve it";
  if (reason === "profile-unresolved") return "not approved: the scope cannot name an exact agent for every role — fix the agent setup and re-file it";
  return `not approved: ${reason}`;
}

/** The browser's one-click approval binds not only the signed scope but the
 * exact advisory plan revision shown beside it. The scope digest remains the
 * durable authority; this composite makes a stale open tab fail when somebody
 * edits the plan before approval. The empty middle slot keeps the bytes of
 * forms already open (it once held other terms, always empty here). */
export function approvalFormDigest(scopeDigest: string, planSha: string | null): string {
  if (planSha === null) return scopeDigest;
  return createHash("sha256")
    .update("standing-orders/browser-approval/v1\0", "utf8")
    .update(scopeDigest, "utf8")
    .update("\0", "utf8")
    .update("", "utf8")
    .update("\0", "utf8")
    .update(planSha ?? "", "utf8")
    .digest("hex");
}

/** A task attached by the server to one chat turn. The thread remains the
 * unified conversation; this is a focused lens, not a second chat silo. */
export type TaskChatFocus = {
  executionId: string;
  /** A failed task: what its latest attempt missed and what to change (the task page's own words). */
  failure?: FailureExplanation | null;
  /** Until this installation's first Ready result, the task shows where it stands on Plan → You approve → Build → Checks → Ready. */
  guide?: boolean;
  family: TaskFamily;
  history: string;
  status: DisplayStatus;
  assignment: AssignmentSnapshot | null;
  id: string;
  title: string;
  state: TaskState;
  project: string | null;
  now: Date;
  dispatch: DispatchDiagnosis | null;
  scope: "none" | "needs approval" | "approved";
  plan: "requested" | "drafted" | null;
  /** Adaptive execution plans (v44): the identical ledger/progress
   * projection the task page renders (c2). */
  planRevisions: PlanRevisionLedgerView | null;
  milestoneProgress: MilestoneProgressView[] | null;
  claimed: boolean;
  liveRun: { id: number; runner: string; startedAt: string; phase: string | null } | null;
  checkProgress: CheckProgress | null;
  /** v52: the exact-run control — the task page's own projection. */
  control: TaskControlView;
  /** The phase route (v47): the task page's exact projection, so chat and
   * page can never disagree about which agent runs which phase. */
  route: RouteView | null;
  /** Approval uses the task page's exact nonce and joint digest. */
  approval: {
    scope: Scope;
    nonce: string;
    digest: string;
    planDocument: string | null;
    /** The drafted plan's contract record (contract handoff, task 1): the
     * same panel the task page and /next show inside the ceremony. */
    planContract: PlanContractView | null;
    deliverable: "branch" | "report";
    revision: RevisionView | null;
    coordinator: { label: string; filedAgo: string | null } | null;
    /** The repair chain row when this task is a machine-drafted repair. */
    repairChain: RepairChainRow | null;
  } | null;
  decisions: (Decision & { taskId: string; repo: string | null })[];
  publication: Publication | null;
  /** The same compact, evidence-backed receipt shown on the task page.
   * Chat is a lens over durable workflow state, never a second copy. */
  result: CompletionReceiptView | null;
};

export const taskChatHref = (taskId: string): string => `/chat?task=${encodeURIComponent(taskId)}`;
/** The task composer's modes (console v2), as the words the lead reads for that one turn. */
export type TaskComposerMode = "build" | "plan" | "answer";
export const TASK_COMPOSER_MODES: Record<TaskComposerMode, string> = {
  build: "The operator chose Build: if they ask for a change to the result, read it with get_result and propose a revision of this task with propose_review (operation revise) for them to confirm. Nothing builds until they confirm the card.",
  plan: "The operator chose Plan only: answer with a short plan for what they ask. Do not propose a revision, a new task or any other action this turn.",
  answer: "The operator chose Just answer: answer from what you can read. Do not propose any action this turn.",
};
/** A project's own lead thread (v77). */
export const projectChatHref = (repo: string): string => `/chat?project=${encodeURIComponent(repo)}`;

/** The one task-level road from a truthful dispatch diagnosis to its nearest
 * existing repair. This is navigation, never authority: every destination
 * still owns its original confirmation, password, CSRF, and transactional
 * checks. Keeping the map here also means the focused chat and task overview
 * cannot send a person to different fixes for the same gate. */
export function taskRecoveryHref(taskId: string, diagnosis: DispatchDiagnosis | null): string | null {
  if (diagnosis?.action === null || diagnosis?.action === undefined) return null;
  const task = taskHref(taskId);
  switch (diagnosis.action) {
    case "start-worker":
    case "repair-dependency":
      return `${task}#run-status`;
    case "retry-task":
    case "unhold":
    case "write-scope":
      return `${task}#task-actions`;
    case "select-agent":
      return `${task}#scope`;
    case "approve-scope":
      return `${task}#approve`;
    case "answer-decision":
      return `${task}#decisions`;
    case "inspect-hold":
      return `${task}#holds`;
    case "repair-capability":
      return "/caps";
    case "place-task":
      return "/projects";
    case "open-result":
      return task;
    case "retry-review":
      return `${task}#run-status`;
    case "resume-run":
      return `${task}#task-control`;
  }
}

/** The resume ceremony's digest (v52): the exact run, its settlement, and
 * the scope approval as it stands — a nonce minted over one set of facts
 * cannot confirm a resume under another. */
export function resumeDigestOf(taskId: string, runId: number, settledAt: string, scope: Scope | null): string {
  return createHash("sha256")
    .update(JSON.stringify([taskId, runId, settledAt, scope?.digest ?? null, scope?.approvedDigest ?? null, scope?.approvedAt ?? null, scope?.approvedBy ?? null]))
    .digest("hex");
}

export const stopWhen = (iso: string): string => iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");

/**
 * The exact-run control (v52): ONE component on the task page, the
 * focused chat, and the status fragment, so every surface names the same
 * run and shows the same state. Stop is one guarded post naming the run;
 * Stopping… is a disabled control with who asked and when; Resume opens
 * the password ceremony; a stopped review points at Review again. Forms
 * carry the CSRF token and the exact run id, nothing else.
 */
/** Presentation only: the same projected words and action on all task
 * surfaces. Approval keeps its action on the exact-terms disclosure. */
export function taskStatusCard(status: DisplayStatus & { diagnostics?: WorkStatus["diagnostics"] }, taskId: string, dispatch: DispatchDiagnosis | null, runId: number | null, approvalAction = false): string {
  const task = taskHref(taskId);
  const recovery = status.token === "waiting-decision" ? `${task}#task-questions` : status.token === "stopping" || status.token === "stopped"
    ? `${task}#task-control`
    : taskRecoveryHref(taskId, dispatch);
  const href = status.action?.kind === "open-task"
    ? recovery ?? `${task}#scope`
    : statusActionHref(status, taskId, runId, null);
  return `<section class="card task-journey" aria-label="task progress" data-work-status="${escape(status.token)}" data-task-status>` +
    `<h2>${escape(status.label)}</h2>` +
    (!approvalAction && status.action !== null && href !== null ? `<a class="button-link task-journey-action" href="${escape(href)}" data-primary-action>${escape(status.action.label)}</a>` : "") +
    `<details class="task-status-reason"><summary>Status details</summary><p class="meta">${escape(status.detail)}</p>${workDiagnosticsHtml(status.diagnostics)}</details></section>`;
}

export function checkProgressHtml(progress: CheckProgress | null, id = "check-progress"): string {
  if (progress === null) return `<p id="${id}" class="check-progress mono" data-check-progress hidden></p>`;
  const state = !progress.final ? "live" : Object.values(progress.suites).some(one => one.state === "failed") ? "failed"
    : Object.values(progress.suites).every(one => one.state === "passed") ? "passed" : "unknown";
  return `<p id="${id}" class="check-progress mono" data-check-progress data-final="${escape(state)}" role="status" aria-live="polite">${escape(progress.line)}</p>`;
}

export function taskControlDetailsHtml(control: TaskControlView, taskId: string, csrf: string, surface: "task" | "chat", inert = false, stopElsewhere = false): string {
  const html = taskControlHtml(control, taskId, csrf, surface, inert, stopElsewhere);
  return control.kind === "paused" || control.kind === "review-stopped" || control.kind === "stopping"
    ? `<details id="task-control-details"><summary>${control.kind === "paused" ? "Preserved work and resume" : "Stop details"}</summary>${html}</details>` : html;
}

/** `stopElsewhere`: the Building card already carries this exact run's Stop, so the control card keeps only its details. */
export function taskControlHtml(control: TaskControlView, taskId: string, csrf: string, surface: "task" | "chat", inert = false, stopElsewhere = false): string {
  if (control.kind === "none") return "";
  const back = `<input type="hidden" name="return" value="${surface}">`;
  const guarded = csrf !== "" && !inert;
  const role = (word: TaskControlView & { kind: "stop" | "stopping" | "paused" }): string =>
    word.role === "planner" ? "plan attempt" : word.role === "scout" ? "scouting attempt" : word.role === "reviewer" ? "review" : "build";
  if (control.kind === "stop" && surface === "chat") {
    return `<section class="card task-control" id="task-control" data-task-control="stop" data-control-run="${control.run}"><details class="chat-stop-confirm"><summary>Stop task</summary>` +
      `<p>${escape(taskId)} · ${escape(role(control))} #${control.run}</p><p>${escape(CHAT_TASK_ACTIONS.stop.detail)}</p>` +
      (guarded ? `<form method="post" action="${taskHref(taskId)}/stop" class="task-stop-form"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="run" value="${control.run}">${back}<button type="submit" class="danger">Stop task</button></form>` : "") + `</details></section>`;
  }
  if (control.kind === "stop") {
    return (
      `<section class="card task-control" id="task-control" data-task-control="stop" data-control-run="${control.run}" aria-label="stop this attempt">` +
      `<div class="task-control-copy"><details><summary>Stop details · ${escape(role(control))} #${control.run}</summary><p class="meta">Stopping ends only this attempt's own processes. Its branch, uncommitted work, evidence, and decisions stay preserved; other tasks keep running.</p></details></div>` +
      (stopElsewhere ? "" : guarded
        ? `<form method="post" action="${taskHref(taskId)}/stop" class="inline task-control-form task-stop-form"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="run" value="${control.run}">${back}<button type="submit" class="danger task-control-button">Stop</button></form>`
        : `<button type="button" class="danger task-control-button" disabled>Stop</button>`) +
      `</section>`
    );
  }
  if (control.kind === "stopping") {
    return (
      `<section class="card task-control" id="task-control" data-task-control="stopping" data-control-run="${control.run}" aria-label="stopping this attempt" aria-busy="true">` +
      `<div class="task-control-copy"><span class="eyebrow">stop requested</span><strong><span class="live-dot" aria-hidden="true"></span>Stopping ${escape(role(control))} #${control.run}…</strong>` +
      `<span class="meta">Asked by <span class="mono">${escape(control.stop.requestedBy)}</span> at ${escape(stopWhen(control.stop.requestedAt))}. ${control.unsettledRun ? "Its own processes are being ended; this reads Paused once they are established gone." : escape(control.detail ?? "The run ended; a recovery pass still needs to establish that its processes exited.")}</span></div>` +
      `<button type="button" class="task-control-button" disabled aria-disabled="true">Stopping…</button>` +
      `</section>`
    );
  }
  if (control.kind === "paused") {
    const settled = control.stop.settledAt === null ? "" : ` · settled ${escape(stopWhen(control.stop.settledAt))} (${escape(control.stop.settlement ?? "?")})`;
    const kept = control.stop.settlement === "finished"
      ? `The attempt reached its own ending (${escape(control.outcome ?? "?")}) before the stop took effect; that outcome stands.`
      : `${control.committed ? "Its commit is on the branch as a reviewable artifact; a" : "A"}ny uncommitted work is preserved${control.worktree === null ? "" : ` in <span class="mono">${escape(control.worktree)}</span>`}. Resuming takes a fresh claim, re-proves the signed scope, and requires fresh proof — nothing is approved by resuming.`;
    return (
      `<section class="card task-control" id="task-control" data-task-control="paused" data-control-run="${control.run}" aria-label="paused attempt">` +
      `<div class="task-control-copy"><span class="eyebrow">paused</span><strong>${escape(role(control))} #${control.run} was stopped by <span class="mono">${escape(control.stop.requestedBy)}</span></strong>` +
      `<span class="meta">Asked ${escape(stopWhen(control.stop.requestedAt))}${settled}. ${kept}</span></div>` +
      (guarded
        ? `<form method="post" action="${taskHref(taskId)}/resume-arm" class="inline task-control-form task-resume-form"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="run" value="${control.run}">${back}<button type="submit" class="task-control-button primary">Resume</button></form>`
        : `<button type="button" class="task-control-button" disabled>Resume</button>`) +
      `</section>`
    );
  }
  return `<details class="card task-control" id="task-control" data-task-control="review-stopped"><summary>Previous assessment stopped</summary><p>Run #${control.run} was stopped by ${escape(control.stop.requestedBy)}. The saved result is unchanged.</p></details>`;
}

/** The resume confirmation (v52): the exact run restated, what resuming
 * does and does not do, the gate that would still keep work from
 * starting, and the password typed again. */
export function resumeCeremonyPage(chrome: Chrome, data: {
  taskId: string;
  taskTitle: string;
  control: TaskControlView & { kind: "paused" };
  nonceValue: string;
  csrf: string;
  returnTo: "task" | "chat";
  gate: DispatchDiagnosis | null;
  approved: boolean;
}): Screen {
  const back = `<p class="meta"><a href="${data.returnTo === "chat" ? taskChatHref(data.taskId) : taskHref(data.taskId)}">Keep paused</a></p>`;
  const control = data.control;
  return screen("resume", [
    `<h1>Resume task?</h1><p class="resume-target"><strong>${escape(data.taskTitle)}</strong> · ${escape(data.taskId)} · Run #${control.run}</p>`,
    `<div class="card resume-ceremony">`,
    `<p class="row">Lifts this stop’s hold. Other holds stay in place.</p>`,
    `<p class="row">Continues saved work${control.committed ? " and its commit" : ""} under the current approved scope. The next attempt needs fresh evidence; the earlier handoff cannot count as a new result.</p>`,
    `<p class="row">Resuming grants no new approval or publishing permission. Scope, budget, agents, verification, and review limits still apply.</p>`,
    `<details><summary>Stop record and saved work</summary><p>Run #${control.run} was stopped by <span class="mono">${escape(control.stop.requestedBy)}</span> at ${escape(stopWhen(control.stop.requestedAt))}${control.stop.settledAt === null ? "" : ` and settled ${escape(stopWhen(control.stop.settledAt))} (${escape(control.stop.settlement ?? "?")})`}.</p>${control.worktree === null ? "" : `<p class="mono">${escape(control.worktree)}</p>`}</details>`,
    data.approved ? "" : `<p class="row problem-words"><strong>The scope is not approved as it stands</strong> — resuming lifts the pause, but no worker spends until the scope is approved again</p>`,
    data.gate === null ? "" : `<p class="row"><strong>Before work starts:</strong> ${escape(data.gate.summary)} — ${escape(data.gate.detail)}</p>`,
    `</div>`,
    `<form method="post" action="${taskHref(data.taskId)}/resume" class="card resume-form">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="nonce" value="${escape(data.nonceValue)}">`,
    `<input type="hidden" name="run" value="${control.run}">`,
    `<input type="hidden" name="return" value="${data.returnTo}">`,
    `<label>Confirm with your password<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">Resume task</button>`,
    `</form>`,
    back,
  ].join("\n"), { chrome });
}

export function taskViewSwitch(taskId: string, active: "overview" | "ask"): string {
  return (
    `<nav class="task-view-switch" aria-label="task view">` +
    `<a href="${taskHref(taskId)}"${active === "overview" ? ' class="active" aria-current="page"' : ""}>Overview</a>` +
    `<a href="${taskChatHref(taskId)}"${active === "ask" ? ' class="active" aria-current="page"' : ""}>Ask</a>` +
    `</nav>`
  );
}

export function taskChatContext(focus: TaskChatFocus): string {
  return (
    `<aside class="task-chat-context" aria-label="current task">` +
    `<div class="task-chat-context-head"><span class="eyebrow">current task</span></div>` +
    `<h2>${escape(focus.title)}</h2>` +
    `<p class="meta mono">${escape(focus.id)}${focus.project === null ? "" : ` · ${escape(focus.project)}`}</p>` +
    // The agents in chat (v47): the same summary the task page and CLI
    // print — who does what — with the reasons one tap away, so a
    // conversation never hides which agent runs.
    (focus.route === null
      ? ""
      : `<div class="task-chat-agents-aside"><span class="eyebrow">agents</span><p class="agents-summary">${escape(agentsSummaryWords(focus.route))}</p><div class="agents-badges">${agentsBadgesHtml(focus.route)}</div>` +
        (focus.route.projection === null ? "" : agentsAvailabilityHtml(focus.route.projection) + agentsWhyHtml(focus.route.projection)) +
        `<p class="meta"><a href="${taskHref(focus.id)}#agents">Change agents on the task →</a></p></div>`) +
    `<div class="task-chat-overview-actions">` +
    `<a class="task-chat-overview-link" href="${taskHref(focus.id)}">Open full overview →</a></div>` +
    `</aside>`
  );
}

export function taskChatApproval(focus: TaskChatFocus, csrf: string): string {
  const approval = focus.approval;
  if (focus.plan === "requested") {
    // The task status already names planning. No second status card.
    return "";
  }
  if (approval === null) return "";
  const scope = approval.scope;
  const returnTo = taskChatHref(focus.id);
  if (approval.revision !== null && "problem" in approval.revision) {
    return `<section class="card chat-action-card" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>The revision brief can’t be verified</h2><p class="meta">${escape(approval.revision.problem)}</p><a class="button-link" href="${taskHref(focus.id)}#approve">Fix this on the task →</a></section>`;
  }
  const door = consentDoorOf(scope, focus.route);
  if (!door.open) return consentClosedHtml(focus.id, door, "chat");
  if (approval.nonce === "") {
    return `<section class="card chat-action-card" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>The agent setup isn’t ready yet</h2>${profileWords(scope)}<a class="button-link" href="${taskHref(focus.id)}#scope">Fix the agent setup →</a></section>`;
  }
  // The same sheet as the task page (approval critique, Oct 2): the plan
  // open in plain rows, one Approve & start, the rest in Details.
  return (
    `<section class="card chat-action-card chat-plan" id="task-chat-action" data-approval="${escape(approval.digest)}">` +
    approvalSheetHtml({
      surface: "chat",
      action: `${taskHref(focus.executionId)}/approve`,
      csrf,
      nonce: approval.nonce,
      digest: approval.digest,
      returnTo,
      scope,
      planDocument: approval.planDocument,
      planContract: approval.planDocument === null ? null : approval.planContract,
      revision: approval.revision,
      revisionSourceHref: approval.revision === null ? "" : chatResultHref(focus.id, approval.revision.sourceRun),
      repairChain: approval.repairChain,
      route: focus.route,
      coordinator: approval.coordinator,
      deliverable: approval.deliverable,
      // Edit plan opens the task page's sheet with its fields open for editing.
      editHref: `${taskHref(focus.id)}?edit=plan#plan-editor`,
      notNowHref: "/chat",
      sticky: false,
      earlier: { active: focus.assignment?.earlierActive ?? 0, running: focus.assignment?.earlierRunning ?? 0 },
      edit: null,
    }) +
    `</section>`
  );
}

/** The chat's status sentence, worded as the task page words it: what a failed attempt missed, or which step a live
 * build is on (and the step it is stuck on). Undefined keeps the shared status sentence. */
export function chatStatusSentence(focus: TaskChatFocus): string | undefined {
  if (focus.state === "failed" && focus.failure != null) return [focus.failure.line, focus.failure.evidence].filter(Boolean).join(" ");
  const steps = focus.liveRun === null ? null : buildProgressOf(focus.milestoneProgress);
  return steps === null ? undefined : steps.line;
}

/** One live, server-derived journey from request to proof. The fragment is
 * safe to refresh independently, so an in-progress message is never lost. */
export function taskChatLiveRegion(focus: TaskChatFocus, csrf: string, fragment = false, inert = false, approvalHref = taskChatHref(focus.id) + "#task-chat-action"): string {
  const receiptLeads = focus.state === "done" && focus.result !== null;
  const approvalContent = (inert && focus.approval !== null && focus.plan !== "requested"
      ? `<section class="card chat-action-card"><span class="eyebrow">approval ready</span><h2>Finish the current chat response first</h2><p class="meta">The secure approval step appears here as soon as this response lands.</p></section>`
      : fragment && focus.approval !== null && focus.plan !== "requested"
        ? `<section class="card chat-action-card chat-refresh-action"><a class="button-link" href="${escape(approvalHref)}" data-primary-action>Approve plan</a></section>`
        : taskChatApproval(focus, csrf));
  const approvalCard = focus.approval !== null && focus.dispatch?.action !== "approve-scope"
    ? `<details class="task-secondary-approval"><summary>Updated approval terms</summary>${approvalContent}</details>` : approvalContent;
  const polling = !inert && ((focus.approval === null || focus.plan === "requested") && focus.state !== "done" && focus.state !== "cancelled" || focus.control.kind === "stopping" || focus.control.kind === "stop");
  return (
    `<section id="task-chat-live" aria-live="polite" data-task="${escape(focus.id)}" data-execution="${escape(focus.executionId)}" data-source="/chat/task-status?task=${encodeURIComponent(focus.id)}" data-poll="${polling ? "1" : "0"}" data-approval="${escape(focus.approval?.digest ?? "")}" data-plan="${escape(focus.plan ?? "")}">` +
    (focus.guide === true && focus.state !== "cancelled" ? firstTaskJourneyHtml(focus) : "") +
    `<div class="task-live-summary">` +
    (focus.assignment !== null ? assignmentSummaryHtml(focus.assignment, { workStatus: focus.status, hideAction: focus.approval !== null && focus.dispatch?.action === "approve-scope", sentence: chatStatusSentence(focus), ...(receiptLeads ? { resultHref: chatResultHref(focus.id, focus.result!.runId) } : {}) }) + (receiptLeads ? completionReceiptCard(focus.result!, focus.id, "chat", focus.status, focus.assignment, false) : "") : receiptLeads ? completionReceiptCard(focus.result!, focus.id, "chat", focus.status) : taskStatusCard(focus.status, focus.id, focus.dispatch, focus.liveRun?.id ?? null, focus.approval !== null && focus.dispatch?.action === "approve-scope")) +
    checkProgressHtml(focus.checkProgress) +
    // The exact-run control (v52): the SAME component the task page
    // renders, refreshed with the live region — typed input in the
    // composer is untouched because only this region is replaced.
    taskControlDetailsHtml(focus.control, focus.executionId, csrf, "chat", inert) +
    // The compact agents strip (v47): always visible, phones included,
    // where the desktop context panel is hidden.
    agentsStripHtml(focus.route, focus.executionId) +
    `</div>` +
    milestoneProgressHtml(focus.milestoneProgress) +
    planRevisionLedgerHtml(focus.planRevisions, focus.executionId, csrf) +
    approvalCard + focus.history +
    (focus.decisions.length === 0
      ? ""
      : `<section class="chat-decisions"><div class="chat-section-head"><h2>Needs your answer</h2></div>${focus.decisions.map(one => focus.approval !== null || inert
        ? `<div class="decide-card"><p class="q">${escape(one.question)}</p><p class="meta">${escape(oneLineOf(one.recap, 160))}</p><a href="/d/${one.id}?return=${encodeURIComponent(taskChatHref(focus.id))}">Review and answer →</a></div>`
        : decisionAnswerCard(one, csrf, focus.now, false, taskChatHref(focus.id))).join("")}</section>`) +
    (focus.result === null || receiptLeads ? "" : `<details class="task-previous-result"><summary>Previous result</summary>${completionReceiptCard(focus.result, focus.id, "chat")}</details>`) +
    (focus.publication === null ? "" : `<p class="chat-publication meta">Published as ${safePrUrl(focus.publication.prUrl) === null ? `<span class="mono">PR #${focus.publication.prNumber ?? "?"}</span>` : `<a href="${escape(safePrUrl(focus.publication.prUrl) as string)}">PR #${focus.publication.prNumber ?? "?"}</a>`} · ${escape(focus.publication.state)}${focus.publication.lastCheckState === null ? "" : ` · CI ${escape(focus.publication.lastCheckState)}`}</p>`) +
    `</section>`
  );
}

/** The first task's way to Ready, filled in as it moves (onboarding): the same stage every surface reads. */
export function firstTaskJourneyHtml(focus: TaskChatFocus): string {
  const planning = focus.plan === "requested" && focus.approval === null;
  const read = focus.assignment !== null ? assignmentStageOf(focus.assignment, { token: focus.status.token }, planning) : stageOfCode(focus.status.token, { planning });
  const steps = firstTaskJourney(read, focus.scope === "approved", focus.state === "done");
  const current = steps.find(one => one.state === "current" || one.state === "stuck");
  return `<ol class="first-task-journey" aria-label="Where this task is${current === undefined ? ": Ready" : `: ${escape(current.label)}`}" data-first-task-journey>` +
    steps.map(one => `<li data-step="${one.key}" data-state="${one.state}"${one.state === "current" || one.state === "stuck" ? ` aria-current="step"` : ""}><span class="first-task-journey-mark" aria-hidden="true"></span><span>${escape(one.label)}</span></li>`).join("") +
    `</ol>`;
}

export function taskChatHeading(focus: TaskChatFocus): string {
  return (
    `<div class="chat-head task-chat-head"><div>` +
    `<p class="meta chat-task-back"><a href="${taskHref(focus.id)}">← task overview</a></p>` +
    `<div class="task-chat-title-line"><div><h1>${escape(focus.title)}</h1></div>${taskViewSwitch(focus.id, "ask")}</div>` +
    `</div></div>`
  );
}

export function chatWorkspace(content: string, projects: readonly ChatProjectPulse[], csrf: string, inert: boolean, focus: TaskChatFocus | null, resultPanel: string | null = null): string {
  if (focus === null) return `<div class="chat-workspace">${chatProjectRail(projects, csrf, inert)}<section class="chat-main">${content}</section></div>`;
  // The result detail (package 3) is the ONE auxiliary panel when open:
  // it takes the context panel's place beside the conversation on a wide
  // screen and becomes the dedicated view, with Back to chat, when the
  // screen has no room for both (CSS decides; the markup is the same).
  if (resultPanel !== null) {
    return `<div class="chat-workspace task-chat-workspace result-open" data-chat-result-open><section class="chat-main">${content}</section><aside class="chat-result t-panel-slide" data-open="true" aria-label="result">${resultPanel}</aside></div>`;
  }
  return `<div class="chat-workspace task-chat-workspace">${taskChatContext(focus)}<section class="chat-main">${content}</section></div>`;
}

/** The folded overview's one-line summary (UI polish 2026-09-13): the
 * two counts a phone reader scans before deciding to open it. */
export function chatOverviewSummaryHtml(projects: readonly ChatProjectPulse[], attention?: { count: number; saturated: boolean }): string {
  const total = (key: keyof ProjectPeek): number => projects.reduce((sum, one) => sum + (one.peek?.[key] ?? 0), 0);
  const needsYou = attention?.count ?? total("waiting");
  const running = total("running");
  return `<summary>Project overview<span class="meta">${needsYou > 0 ? `<span class="hot">${needsYou}${attention?.saturated ? "+" : ""} need${needsYou === 1 ? "s" : ""} you</span>` : "nothing waiting"} · ${running} building</span></summary>`;
}

/** A live, server-derived portfolio card. It is deliberately independent
 * of the model's prose: the numbers and links always reflect the current
 * control plane, while chat remains the place to ask what they mean. */
export type AssignmentChatSnapshot = ChatSnapshot & { assignmentStates?: Record<string, { state: AssignmentSnapshot['state']; label: string; detail: string }>; attentionCount?: { count: number; saturated: boolean } };

export function chatFleetOverview(
  snapshot: AssignmentChatSnapshot | null,
  projects: readonly ChatProjectPulse[],
  csrf: string,
  interactive: boolean,
): string {
  if (snapshot === null) {
    return `<section class="card chat-overview"><h2>Project summary unavailable</h2><p class="meta">Reload to try again. You can still use chat.</p></section>`;
  }
  const total = (key: keyof ProjectPeek): number => projects.reduce((sum, one) => sum + (one.peek?.[key] ?? 0), 0);
  const needsYou = snapshot.attentionCount?.count ?? total("waiting");
  const running = total("running");
  const queued = total("queued");
  const done = total("doneRecently");
  const projectOf = (index: number): string => projects[index]?.label ?? `r${index + 1}`;
  const rows: string[] = [];
  for (const decision of snapshot.decisions.slice(0, 2)) {
    rows.push(
      `<a class="chat-overview-item decision" href="/d/${decision.id}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><path d="M12 18h.01"/><circle cx="12" cy="12" r="9"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(decision.question)}</strong><span>${escape(projectOf(decision.repoIndex))} · ${escape(decision.taskId)} · decision #${decision.id}</span></span>` +
      `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks
    .filter(one => one.dispatch?.condition === "waiting" && one.state !== "done")
    .slice(0, Math.max(0, 3 - rows.length))) {
    const dispatch = task.dispatch as DispatchDiagnosis;
    rows.push(
      `<a class="chat-overview-item decision" href="${taskHref(task.rootId ?? task.id)}" data-dispatch-status="${escape(dispatch.code)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M12 8v4"/><path d="M12 16h.01"/><circle cx="12" cy="12" r="9"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(task.id)} · ${escape(dispatchHeadline(dispatch))}</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks.filter(one => one.state === "failed").slice(0, Math.max(0, 3 - rows.length))) {
    rows.push(
      `<a class="chat-overview-item failed" href="${taskHref(task.rootId ?? task.id)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M12 9v4"/><path d="M12 17h.01"/><path d="m10.3 2.9-8.6 15A2 2 0 0 0 3.4 21h17.2a2 2 0 0 0 1.7-3.1l-8.6-15a2 2 0 0 0-3.4 0z"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(task.id)} · failed</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  // Current assignments own attention. The saved assessment is history,
  // never a second queue after the lead marked the result complete.
  for (const task of snapshot.tasks
    .filter(one => one.state === "done" && ["ready-to-check", "needs-decision"].includes(snapshot.assignmentStates?.[one.id]?.state ?? ""))
    .slice(0, Math.max(0, 3 - rows.length))) {
    rows.push(
      `<a class="chat-overview-item failed" href="${taskHref(task.rootId ?? task.id)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(snapshot.assignmentStates![task.id]!.label)} · ${escape(snapshot.assignmentStates![task.id]!.detail)}</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks.filter(one => one.state === "running").slice(0, Math.max(0, 4 - rows.length))) {
    rows.push(
      `<a class="chat-overview-item running" href="${taskHref(task.rootId ?? task.id)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(task.id)} · building now</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  const saturated = snapshot.tasksSaturated || snapshot.decisionsSaturated || snapshot.incidentsSaturated;
  const briefing = "Brief me on what needs my attention, what is building, and the highest-leverage next action across every project.";
  return (
    `<section class="card chat-overview" aria-label="live portfolio overview" data-card-kind="fleet-overview">` +
    `<div class="chat-overview-head"><h2>${projects.length} project${projects.length === 1 ? "" : "s"}</h2>` +
    (interactive
      ? `<form method="post" action="/chat" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}"><button type="submit" name="message" value="${escape(briefing)}" class="quiet">Brief me</button></form>`
      : `<a href="/board?scope=all" class="chat-overview-link">open board</a>`) +
    `</div>` +
    `<div class="chat-overview-stats">` +
    `<a href="/work?view=needs-you" class="chat-overview-stat attention"><b>${needsYou}${snapshot.attentionCount?.saturated ? "+" : ""}</b><span>need you</span></a>` +
    `<a href="/board?scope=all" class="chat-overview-stat live"><b>${running}</b><span>building</span></a>` +
    `<a href="/board?scope=all&amp;view=order" class="chat-overview-stat"><b>${queued}</b><span>queued</span></a>` +
    `<a href="/work" class="chat-overview-stat"><b>${done}</b><span>finished today</span></a>` +
    `</div>` +
    (rows.length === 0 ? `<p class="chat-overview-clear">${needsYou === 0 && running === 0 ? `<span class="dot dot-ok"></span>No tasks are waiting and no builds are running.` : `<a href="/work">Open Tasks to inspect current work.</a>`}</p>` : `<div class="chat-overview-items">${rows.join("")}</div>`) +
    completedWorkHtml(snapshot, projects.map(project => project.label), snapshot.assignmentStates) +
    (saturated ? `<p class="meta chat-overview-note">Some items aren’t shown. Open Work to see more.</p>` : "") +
    `</section>`
  );
}

/**
 * The lead's project rail: one bounded pulse per admitted project, plus
 * two roads that preserve the plane's contracts. "ask" sends the stable
 * rN alias the model already sees; "board" uses the existing POST switch
 * instead of smuggling a project change through a GET parameter.
 */
export function chatProjectRail(projects: readonly ChatProjectPulse[], csrf: string, inert: boolean): string {
  const statusOf = (peek: ProjectPeek | null): string =>
    peek === null
      ? "unavailable"
      : peek.waiting > 0
        ? "needs you"
        : peek.running > 0
          ? "building"
          : peek.queued > 0
            ? "queued"
            : "quiet";
  const rows = projects.map(one => {
    const peek = one.peek;
    const ask = `Give me a concise status for ${one.id} (${one.label}) and recommend the next reversible action.`;
    return (
      `<div class="chat-project-card">` +
      `<div class="chat-project-name"><span class="mono">${escape(one.id)}</span><strong>${escape(one.label)}</strong>` +
      `<span class="badge">${escape(sentenceCase(statusOf(peek)))}</span></div>` +
      (peek === null
        ? `<p class="meta">Pulse unavailable</p>`
        : `<div class="chat-project-stats">` +
          `<span${peek.waiting > 0 ? ' class="hot"' : ""}><b>${peek.waiting}</b> need you</span>` +
          `<span><b>${peek.running}</b> live</span><span><b>${peek.queued}</b> queued</span>` +
          `<span><b>${peek.doneRecently}</b> done today</span></div>`) +
      `<div class="chat-project-actions">` +
      (inert
        ? ""
        : `<form method="post" action="/chat" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">` +
          `<button type="submit" name="message" value="${escape(ask)}" class="quiet" aria-label="ask about ${escape(one.label)}">Ask</button></form>`) +
      `<form method="post" action="/projects/open" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">` +
      `<input type="hidden" name="path" value="${escape(one.path)}"><input type="hidden" name="return" value="/board">` +
      `<button type="submit" class="quiet" aria-label="open ${escape(one.label)} board">Board</button></form></div></div>`
    );
  }).join("");
  return (
    `<aside class="chat-projects" id="chat-project-panel" aria-label="projects in this conversation">` +
    `<div class="chat-projects-head"><h2>Projects</h2><span class="badge">${projects.length}</span>` +
    `<button type="button" class="chat-project-close quiet" aria-label="close projects">×</button></div>` +
    `<div class="chat-project-list">${rows}</div></aside>`
  );
}

/** Spend-authorized one-click questions: ordinary /chat posts, not a new door. */
export function leadPromptStarters(csrf: string, focus: TaskChatFocus | null = null): string {
  const prompts = focus === null
    ? [
        ["brief me", "Brief me on what needs my attention, what is building, and the highest-leverage next action across every project."],
        ["decisions", "Walk me through the open decisions, their options, and what you recommend I inspect first."],
        ["new task", "Help me define a new task. Ask only about choices that materially change the result; otherwise use your judgment and sensible reversible defaults."],
      ] as const
    : [
        ["What’s happening", "Read this task and explain its current status, what is blocking it, and what should happen next."],
        ["Review results", "Review the evidence recorded for this task and tell me what is proven and what is still unverified."],
        ["Adjust the plan", "Read this task and propose a tighter scope if that would improve the outcome. Explain why before I confirm anything."],
      ] as const;
  return `<div class="chat-prompts" aria-label="suggested questions">${prompts.map(([label, message]) =>
    `<form method="post" action="/chat" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">` +
    (focus === null ? "" : `<input type="hidden" name="task" value="${escape(focus.id)}">`) +
    `<button type="submit" name="message" value="${escape(message)}" class="quiet">${escape(label)}</button></form>`,
  ).join("")}</div>`;
}

export function chatHeading(copy: string, projectCount: number, showProjectToggle = true): string {
  return (
    `<div class="chat-head"><div><h1>Chat</h1>${copy === "" ? "" : `<p class="meta">${escape(copy)}</p>`}</div>` +
    `<div class="chat-head-actions">` +
    (showProjectToggle
      ? `<button type="button" class="chat-project-toggle quiet" aria-controls="chat-project-panel" aria-expanded="false" title="show or hide projects">` +
        `${strokeIcon(`<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>`)}<span>projects</span><span class="badge">${projectCount}</span></button>`
      : "") + `</div></div>`
  );
}

/** A deliberately small rich-text grammar for model copy. The reply is shaped first (the lead's voice, enforced:
 * no headers, at most three bold anchors, labelled links, no internal ids unless `asked` wanted them); input is
 * escaped before tags are introduced: bullets, numbered steps, bold, inline code and labelled http(s) links are
 * presentation only—never executable HTML. */
export function renderChatText(raw: string, asked?: string): string {
  const inline = replyHtmlInline;
  const text = shapeReply(raw, { appOrigin: requestContext.getStore()?.appOrigins ?? null, ...(asked === undefined ? {} : { asked }) });
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (list === null) return;
    out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d{1,9})[.)]\s+(.+)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const wanted = bullet !== null ? "ul" : "ol";
      if (list !== wanted) { closeList(); out.push(`<${wanted}>`); list = wanted; }
      // Model replies often separate steps with blank lines. Each remains
      // its stated number even when that blank line starts another <ol>.
      out.push(`<li${numbered === null ? "" : ` value="${Number(numbered[1])}"`}>${inline(bullet?.[1] ?? numbered?.[2] ?? "")}</li>`);
    } else if (line.trim() === "") {
      flushParagraph(); closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph(); closeList();
  return `<div class="chat-copy">${out.join("")}</div>`;
}

export function chatActivity(activity: string | null): string {
  return chatActivityDetailsHtml(activity);
}

export const CHAT_UI_SCRIPT =
  `(function(){var workspace=document.querySelector(".chat-workspace"),projectPanel=document.getElementById("chat-project-panel"),projectToggle=document.querySelector(".chat-project-toggle"),projectClose=document.querySelector(".chat-project-close");` +
  `var fleet=document.querySelector(".chat-fleet-context");if(fleet&&!document.querySelector(".chat-empty")){var desktop=window.matchMedia("(min-width: 761px)");fleet.open=desktop.matches;desktop.addEventListener("change",function(){fleet.open=desktop.matches;});}` +
  `if(workspace&&projectPanel&&projectToggle){var wide=window.matchMedia("(min-width: 1200px)");var saved="";try{saved=localStorage.getItem("standing-orders:chat-projects")||"";}catch(e){}` +
  `var background=[];function restoreBackground(){background.forEach(function(n){n.inert=false;});background=[];}` +
  `function apply(open){var was=workspace.classList.contains("projects-open");restoreBackground();workspace.classList.toggle("projects-open",open);workspace.classList.toggle("projects-hidden",!open);projectToggle.setAttribute("aria-expanded",String(open));` +
  `if(open&&!wide.matches){projectPanel.setAttribute("role","dialog");projectPanel.setAttribute("aria-modal","true");projectPanel.setAttribute("aria-label","Projects");` +
  `document.querySelectorAll(".side,.mobile-top,.tabbar,.chat-main,.task-chat-context,.task-chat-agents").forEach(function(n){if(!n.contains(projectPanel)&&!n.inert){n.inert=true;background.push(n);}});if(projectClose)projectClose.focus();}` +
  `else{projectPanel.removeAttribute("role");projectPanel.removeAttribute("aria-modal");projectPanel.removeAttribute("aria-label");if(was&&!open)projectToggle.focus();}}` +
  `projectPanel.addEventListener("keydown",function(ev){if(ev.key!=="Tab"||wide.matches)return;var nodes=Array.from(projectPanel.querySelectorAll("a[href],button,input,select,textarea,summary,[tabindex='0']")).filter(function(n){return !n.disabled&&n.getClientRects().length;});var first=nodes[0],last=nodes[nodes.length-1];if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}});` +
  `function preferred(){return wide.matches&&saved==="open";}apply(preferred());` +
  `projectToggle.addEventListener("click",function(){var next=!workspace.classList.contains("projects-open");apply(next);if(wide.matches){saved=next?"open":"closed";try{localStorage.setItem("standing-orders:chat-projects",saved);}catch(e){}}});` +
  `if(projectClose)projectClose.addEventListener("click",function(){apply(false);projectToggle.focus();});` +
  `document.addEventListener("click",function(ev){if(wide.matches||!workspace.classList.contains("projects-open"))return;var target=ev.target;if(target instanceof Node&&!projectPanel.contains(target)&&!projectToggle.contains(target))apply(false);});` +
  `wide.addEventListener("change",function(){apply(preferred());});document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&workspace.classList.contains("projects-open")){apply(false);projectToggle.focus();}});}` +
  `var taskLive=document.querySelector(".composer[data-chat-session]")?null:document.getElementById("task-chat-live");` +
  `function taskEditing(){return taskLive.contains(document.activeElement)||taskLive.querySelector("details[open]")||Array.from(taskLive.querySelectorAll("input:not([type=hidden]),textarea,select")).some(function(el){return el.tagName==="SELECT"?Array.from(el.options).some(function(o){return o.selected!==o.defaultSelected;}):el.type==="checkbox"||el.type==="radio"?el.checked!==el.defaultChecked:el.value!==el.defaultValue;});}` +
  `function refreshTask(){if(!taskLive||taskLive.getAttribute("data-poll")!=="1")return;` +
  `if(document.hidden||taskEditing()){setTimeout(refreshTask,5000);return;}var source=taskLive.getAttribute("data-source");if(!source)return;` +
  `fetch(source,{cache:"no-store",signal:AbortSignal.timeout(10000)}).then(function(r){if(r.status===401||r.status===403||r.redirected){location.href="/login";return null;}if(!r.ok)throw new Error("connection");return r.text();})` +
  `.then(function(html){if(html===null||!taskLive)return;var parsed=new DOMParser().parseFromString(html,"text/html"),next=parsed.getElementById("task-chat-live");if(!next)throw new Error("response");if(taskEditing()){setTimeout(refreshTask,5000);return;}taskLive.replaceWith(next);taskLive=next;` +
  `if(taskLive.getAttribute("data-poll")==="1")setTimeout(refreshTask,5000);}).catch(function(){setTimeout(refreshTask,10000);});}` +
  `if(taskLive&&taskLive.getAttribute("data-poll")==="1")setTimeout(refreshTask,5000);` +
  `var box=document.querySelector(".composer textarea");if(box){` +
  `function size(){box.style.height="auto";box.style.height=Math.min(box.scrollHeight,208)+"px";}size();box.addEventListener("input",size);` +
  `box.addEventListener("keydown",function(ev){if(ev.isComposing||ev.key!=="Enter"||ev.shiftKey||!window.matchMedia("(min-width: 761px)").matches)return;ev.preventDefault();if(box.value.trim()!=="")box.form.requestSubmit();});}})();`;

/** Provider, model, and limits under ONE disclosure (UI polish
 * 2026-09-13): the facts stay one tap away on every chat surface, and a
 * membership never shows a dollar figure as if it were a charge. */
export function chatLimitsHtml(facts: {
  provider: string; model: string; turnsToday: number; dailyTurns: number; subscription: boolean;
  weekly: { spent: number; ceiling: number } | null;
}): string {
  const rows: string[] = [
    `<span class="mono">${escape(facts.provider)} · ${escape(facts.model)}</span>`,
    `<span>${facts.turnsToday} / ${facts.dailyTurns} turns today</span>`,
  ];
  if (facts.subscription) rows.push(`<span>membership login · no dollar ceiling</span>`);
  else if (facts.weekly !== null) rows.push(`<span>this week ${chatMoney(facts.weekly.spent)} of ${chatMoney(facts.weekly.ceiling)}</span>`);
  return `<details class="chat-limits"><summary>Model &amp; limits<span class="meta">${escape(facts.subscription ? "membership" : facts.provider)}</span></summary><div class="chat-budget">${rows.join("")}</div></details>`;
}

/** What the lead's settings form shows beside the saved configuration: where keys come from (never the keys), the
 * live model lists, and where saving goes back to. */
export type LeadFormFacts = {
  keyFacts: { provider: string; state: "environment" | "stored" | "none"; tail: string | null }[];
  openrouterModels: string[] | null;
  liveModels?: { value: string; label: string }[];
  csrf: string;
  returnTo: string;
};

/** Settings → Lead: one line for what runs the lead and one action; the full form, turning it off and stored keys under Advanced. */
export function leadSettingsHtml(data: { config: import("../store.js").ChatConfig | null; facts: LeadFormFacts; words: string | null; signedIn: string | null; command: string; said: string | null;
  saved?: boolean; identity?: LeadIdentity;
  about?: string[]; aboutSaved?: boolean;
  /** D5: the lead's subagents in the projects this person can use: name and role, project, and whether it's paused. */
  subagents?: { id: number; label: string; project: string; paused: boolean }[];
  promises?: { id: number; what: string; when: string; until: string }[] }): string {
  const { config, facts } = data;
  const hidden = `<input type="hidden" name="csrf" value="${escape(facts.csrf)}"><input type="hidden" name="return" value="/settings/lead">`;
  const summary = config === null
    ? data.signedIn !== null
      ? `<p>The lead is off.</p><form method="post" action="/settings/lead/on">${hidden}<button type="submit">Use your ${escape(data.signedIn)} sign-in</button></form>`
      : `<p>The lead is off. Sign in an agent on this computer to turn it on:</p><p><code>${escape(data.command)}</code></p>`
    : data.words !== null
      ? `<p>The lead uses ${escape(data.words)}.</p><p class="meta">${config.model === "default" ? "Its default model" : `Model ${escape(config.model)}`} · up to ${config.dailyTurns} turns a day · no dollar spend. Every action it proposes waits for you to confirm it.</p>`
      : `<p>The lead uses the ${escape(config.provider === "anthropic-api" ? "Anthropic" : "OpenRouter")} API with ${escape(config.model)}.</p><p class="meta">Up to ${chatMoney(config.weeklyCeilingMicrousd)} a week · up to ${config.dailyTurns} turns a day.</p>`;
  const forget = facts.keyFacts.filter(one => one.state === "stored").map(one =>
    `<form method="post" action="/chat/config" class="inline">${hidden}<input type="hidden" name="forget-key" value="${escape(one.provider)}">` +
    `<input type="password" name="token" placeholder="your password" autocomplete="current-password" aria-label="Your password"><button type="submit" class="secondary">Forget the stored ${escape(one.provider)} key</button></form>`).join("");
  return [
    `<p><a href="/settings">Settings</a></p><h1>Lead</h1>`,
    data.said === null ? "" : `<p class="problem" role="status">${escape(data.said)}</p>`,
    `<section class="card lead-settings" data-lead-settings>${summary}</section>`,
    data.identity === undefined ? "" : `<form method="post" action="/settings/lead/identity" class="card lead-identity" data-lead-identity>` +
      `<input type="hidden" name="csrf" value="${escape(facts.csrf)}">` +
      `<label>Name your lead<input name="name" value="${escape(data.identity.name)}" maxlength="${LEAD_NAME_MAX}" autocomplete="off" required></label>` +
      `<label>Persona<textarea name="persona" rows="4" maxlength="${LEAD_PERSONA_MAX}">${escape(data.identity.persona)}</textarea></label>` +
      `<button type="submit">Save</button>${data.saved === true ? ` <span class="meta" role="status">Saved.</span>` : ""}</form>`,
    // What the lead knows about this person: lines they confirmed in chat or wrote here. Every project, every chat.
    data.about === undefined ? "" : `<form method="post" action="/settings/lead/about" class="card lead-about" data-lead-about>` +
      `<input type="hidden" name="csrf" value="${escape(facts.csrf)}">` +
      `<label>What your lead knows about you<textarea name="about" rows="${Math.min(10, Math.max(4, data.about.length + 1))}" maxlength="${ABOUT_YOU_MAX_LINES * (ABOUT_YOU_LINE_MAX + 1)}" placeholder="Keep copy terse.&#10;I test changes myself.">${escape(data.about.join("\n"))}</textarea></label>` +
      `<p class="meta">One per line, up to ${ABOUT_YOU_MAX_LINES}.</p>` +
      `<button type="submit">Save</button>${data.aboutSaved === true ? ` <span class="meta" role="status">Saved.</span>` : ""}</form>`,
    // What the lead promised to follow up on; it reports each once, here in chat, and drops it after 7 days.
    (data.promises ?? []).length === 0 ? "" : `<section class="card lead-promises" data-lead-promises><h2>Promises</h2><ul class="lead-promise-list">${data.promises!.map(one =>
      `<li data-promise="${one.id}"><p>${escape(one.what)}</p><p class="meta">${escape(one.when.charAt(0).toUpperCase() + one.when.slice(1))} · <span class="nowrap">until ${escape(new Date(one.until).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }))}</span></p>` +
      `<form method="post" action="/settings/lead/promise/cancel" class="inline">${hidden}<input type="hidden" name="promise" value="${one.id}"><button type="submit" class="secondary">Cancel</button></form></li>`).join("")}</ul></section>`,
    // D5: the lead's subagents, one line each; everything else about one is on its own page.
    data.subagents === undefined ? "" : `<section class="card lead-subagents" id="subagents" data-lead-subagents><h2>Subagents</h2>` +
      (data.subagents.length === 0 ? `<p class="meta">None yet. Your lead can ask one for help once it's here.</p>`
        : `<ul class="lead-subagent-list">${data.subagents.map(one => `<li data-subagent="${one.id}"><a href="/settings/lead/subagents/${one.id}">${escape(one.label)}</a><span class="meta">${escape(one.project)}${one.paused ? " · Paused" : ""}</span></li>`).join("")}</ul>`) +
      `<p><a class="button-link" href="/settings/lead/subagents?add=1#add" data-add-subagent>Add subagent</a></p></section>`,
    `<details class="lead-advanced" data-lead-advanced><summary>Advanced</summary>`,
    leadConfigForm(config, facts),
    config === null ? "" : `<form method="post" action="/chat/config" class="inline">${hidden}<input type="hidden" name="off" value="1">` +
      `<input type="password" name="token" placeholder="your password" autocomplete="current-password" aria-label="Your password"><button type="submit" class="secondary">Turn the lead off</button></form>`,
    forget,
    `</details>`,
  ].join("\n");
}

/** The lead's full settings (Settings → Lead → Advanced): provider, model, limits and a direct API key. */
export function leadConfigForm(current: import("../store.js").ChatConfig | null, data: LeadFormFacts): string {
  const anthropicModels = PRICED_MODELS.filter(one => !one.includes("/"));
  const openrouterModels = data.openrouterModels ?? PRICED_MODELS.filter(one => one.includes("/"));
  const currentSubscription = current !== null && isSubscriptionChatProvider(current.provider);
  const labels = new Map((data.liveModels ?? []).map(one => [one.value, one.label]));
  const models = [...new Set(["default", ...labels.keys(), ...anthropicModels, ...openrouterModels, ...(current === null ? [] : [current.model])])];
  return [
    `<form method="post" action="/chat/config" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="return" value="${escape(data.returnTo)}">`,
    `<label>Provider<select name="provider">`,
    `<option value="codex-subscription"${current?.provider === "codex-subscription" ? " selected" : ""}>Codex membership (logged-in CLI)</option>`,
    `<option value="claude-subscription"${current?.provider === "claude-subscription" ? " selected" : ""}>Anthropic membership (logged-in CLI)</option>`,
    `<option value="anthropic-api"${current?.provider === "anthropic-api" ? " selected" : ""}>anthropic-api (direct API)</option>`,
    `<option value="openrouter-api"${current?.provider === "openrouter-api" ? " selected" : ""}>openrouter-api (direct API)</option>`,
    `</select></label>`,
    `<label>Model <span class="meta">(use default for your membership's current model; direct API models need a pinned price)</span>` +
      `<input name="model" list="chat-models" value="${escape(current?.model ?? "default")}"><datalist id="chat-models">` +
      `${models.map(model => `<option value="${escape(model)}">${escape(labels.get(model) ?? "")}</option>`).join("")}</datalist></label>`,
    data.openrouterModels === null
      ? `<p class="meta">With OPENROUTER_API_KEY in the serve environment, this list becomes OpenRouter's full live catalog — each model priced by the party that bills it</p>`
      : `<p class="meta">${data.openrouterModels.length} models live from OpenRouter's catalog; saving pins today's price — re-save to re-pin</p>`,
    currentSubscription
      ? `<p class="meta"><strong>No dollar maximum.</strong> Membership chat uses the plan attached to the logged-in CLI; the conversation stays live until you end it, and the daily turn limit still applies.</p>`
      : `<label>Weekly ceiling <span class="meta">(direct API only; leave blank when choosing a membership)</span>` +
        `<input type="text" name="weekly-usd" inputmode="decimal" style="width:8rem" value="${current === null ? "" : (current.weeklyCeilingMicrousd / 1_000_000).toFixed(2)}"></label>`,
    `<label>Daily turns <span class="meta">(default 50)</span>` +
      `<input type="text" name="daily-turns" inputmode="numeric" style="width:8rem" value="${current === null ? "" : String(current.dailyTurns)}"></label>`,
    currentSubscription
      ? `<p class="meta">Authenticate on this machine first with ${current?.provider === "codex-subscription" ? `<span class="mono">codex login</span>` : `the <span class="mono">claude</span> CLI`}. Toolroll reuses that cached login and never stores it.</p>`
      : `<label>API key <span class="meta">(${data.keyFacts
        .map(one =>
          one.state === "none"
            ? `${escape(one.provider)}: none yet`
            : one.state === "environment"
              ? `${escape(one.provider)}: from the environment`
              : `${escape(one.provider)}: stored ${escape(one.tail ?? "")}`,
        )
        .join(" · ")})</span>` +
        `<input type="password" name="key" placeholder="direct API only — leave empty to keep" autocomplete="off"></label>`,
    `<label>Your password <span class="meta">(typed again to change the provider)</span>` +
      `<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">${current === null ? "turn chat on" : "save"}</button>`,
    `</form>`,
    currentSubscription
      ? `<p class="meta">The membership provider runs without repository tools in a temporary directory; Toolroll remains the only layer that can turn a proposed action into a confirmation card.</p>`
      : `<p class="meta">A pasted key is written once to a mode-0600 file beside the database — never INTO the database, never shown again beyond its last characters; an environment variable (` +
        `<span class="mono">ANTHROPIC_API_KEY</span> / <span class="mono">OPENROUTER_API_KEY</span>) always wins when set</p>`,
  ].join("\n");
}

export function chatPage(chrome: Chrome, data: {
  enabled: { ok: true } & Record<string, unknown> | { ok: false; why: string };
  pending: ChatTurn | null;
  latched: ChatTurn[];
  chat: { candidates: Map<string, { key: string; draft: ChatDraft; repoPath: string }>; lastTurn: { id: number; reply: string | null; staticError: string | null; proposalsDiscarded: boolean } | null } | null;
  recent: ChatTurn[];
  turnsToday: number;
  weeklySpent: number;
  projects: ChatProjectPulse[];
  fleetSnapshot: AssignmentChatSnapshot | null;
  catchUp?: string;
  /** Optional task lens into the same unified conversation. */
  focusTask: TaskChatFocus | null;
  canManage: boolean;
  config: import("../store.js").ChatConfig | null;
  /** Where each provider's key comes from — never the key itself. */
  keyFacts: { provider: string; state: "environment" | "stored" | "none"; tail: string | null }[];
  /** OpenRouter's live catalog when the key is present and reachable. */
  openrouterModels: string[] | null;
  /** Claude and Codex models from the saved live catalog, labelled with prices. */
  liveModels?: { value: string; label: string }[];
  csrf: string;
  problem: string | null;
  /** The card that mints a lead session (mate arc §5), approvers only. */
  leadMint?: string;
  /** Pending coordinator proposals as cards (mate arc v3), approvers only. */
  coordinatorProposals?: string;
  /** The task's result detail (package 3), when the URL opened one. */
  resultPanel?: string | null;
  /** Opened from "Chat settings": show them expanded. */
  settingsOpen?: boolean;
  /** Chat's first run is on the page: it already says what to do while there is no lead. */
  firstRunShown?: boolean;
}): Screen {
  const formFacts: LeadFormFacts = { keyFacts: data.keyFacts, openrouterModels: data.openrouterModels, ...(data.liveModels === undefined ? {} : { liveModels: data.liveModels }), csrf: data.csrf,
    returnTo: data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id) };
  const parts: string[] = [
    data.focusTask === null
      ? chatHeading("", data.projects.length, data.enabled.ok)
      : taskChatHeading(data.focusTask),
    data.focusTask === null ? (data.catchUp ?? "") : taskChatLiveRegion(data.focusTask, data.csrf, false, data.pending !== null),
  ];
  if (data.problem !== null) parts.push(`<div class="problem">${escape(data.problem)}</div>`);
  if (!data.enabled.ok) {
    const code = (data.enabled as { code?: string }).code;
    // The sandbox shows no conversation at all: chat evidence is a real
    // subscription-backed plane, never a seeded transcript (v48 authority repair).
    // With no lead yet, the first run says what happens next (it turns on with the signed-in agent, or shows the one
    // command to run); otherwise one line, and its settings live in Settings → Lead (onboarding).
    const settingsLink = data.canManage ? ` <a href="/settings/lead">Settings → Lead</a>` : "";
    if (!(code === "unconfigured" && data.firstRunShown === true)) parts.push(
      code === "demo"
        ? `<div class="card" id="latest"><p><strong>Chat isn’t available in demo mode</strong></p><p class="meta">Demo data never contacts an external model. Start Toolroll with a real project to use chat: <code>${escape(START_COMMAND)}</code> in your repository.</p></div>`
        : code === "unconfigured"
          ? `<div class="card" id="latest" data-lead-off><p><strong>The lead is off.</strong></p><p class="meta">${data.canManage ? `Turn it on in${settingsLink}.` : "An approver can turn it on."}</p></div>`
          : code === "unpriced" || code === "no-key"
            ? `<div class="card" id="latest"><p><strong>The lead can’t run yet.</strong></p><p class="meta">${escape(data.enabled.why)}${data.canManage ? ` ·${settingsLink}` : ""}</p></div>`
            : `<div class="card" id="latest"><p><strong>Chat is off.</strong></p><p class="meta">${escape(data.enabled.why)}</p></div>`,
    );
    return screen("chat", chatWorkspace(parts.join("\n"), data.projects, data.csrf, true, data.focusTask, data.resultPanel ?? null), { chrome, functional: { script: CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: data.focusTask !== null } });
  }
  const config = (data.enabled as unknown as { config: { provider: ChatProviderId; model: string; dailyTurns: number; weeklyCeilingMicrousd: number } }).config;
  const subscription = isSubscriptionChatProvider(config.provider);
  // The saved catch-up owns orientation. Keep the older overview only as
  // a fallback; provider and spend terms remain available before consent.
  if (!data.canManage) {
    parts.push(`<div class="card chat-readonly"><strong>Read-only view</strong><p class="meta">An approver can start the unified conversation and confirm its proposed actions. You can still open every live card and project board here.</p></div>`);
  }
  if (data.canManage && data.leadMint !== undefined) parts.push(data.leadMint);
  if (data.canManage && data.coordinatorProposals !== undefined) parts.push(data.coordinatorProposals);
  parts.push(
    data.focusTask === null && !data.catchUp ? `<details class="chat-fleet-context">${chatOverviewSummaryHtml(data.projects, data.fleetSnapshot?.attentionCount)}${chatFleetOverview(data.fleetSnapshot, data.projects, data.csrf, false)}</details>` : "",
    chatLimitsHtml({ provider: config.provider, model: config.model, turnsToday: data.turnsToday, dailyTurns: config.dailyTurns, subscription, weekly: subscription ? null : { spent: data.weeklySpent, ceiling: config.weeklyCeilingMicrousd } }),
  );
  for (const turn of data.latched) {
    parts.push(
      `<div class="problem"><strong>Chat is paused.</strong> An earlier reply stopped before its cost was known; it may have cost up to ${chatMoney(turn.reservedMicrousd)}. ` +
        `<a href="/chat/ack/${turn.id}">Confirm that cost</a> to turn chat back on.</div>`,
    );
  }
  if (data.pending !== null) {
    parts.push(chatWorkingHtml({details:`Turn #${data.pending.id}${subscription ? " · subscription" : ` · up to ${chatMoney(data.pending.reservedMicrousd)} reserved`}`}));
    parts.push(`<p class="meta"><a href="/chat">refresh now</a></p>`);
    return screen("chat", chatWorkspace(parts.join("\n"), data.projects, data.csrf, true, data.focusTask, data.resultPanel ?? null), { chrome, functional: { script: CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: data.focusTask !== null }, refreshSeconds: 3 });
  }
  const last = data.chat?.lastTurn ?? null;
  if (last !== null) {
    if (last.staticError !== null) {
      parts.push(`<div class="card" id="latest"><p class="meta">${escape(last.staticError)}</p></div>`);
    } else if (last.reply !== null) {
      parts.push(`<div class="card" id="latest">${renderChatText(last.reply)}` +
        (last.proposalsDiscarded ? `<p class="meta">A draft block in this answer was malformed and was discarded whole</p>` : "") +
        `</div>`);
    }
  }
  const candidates = data.chat === null ? [] : [...data.chat.candidates.values()];
  for (const one of candidates) {
    const draft = one.draft;
    parts.push(
      `<div class="card">` +
        `<p><strong>${escape(draft.title)}</strong> <span class="badge">Draft ${escape(draft.kind)}</span></p>` +
        `<p class="meta">Drafted by the model from fleet context — nothing is filed; drafts do not survive a restart</p>` +
        `<p style="white-space:pre-wrap">${escape(draft.goal)}</p>` +
        (draft.outOfScope === null ? "" : `<p class="meta">Not: ${escape(draft.outOfScope)}</p>`) +
        (draft.touches.length > 0 ? `<p class="meta">Touches: ${escape(draft.touches.join(", "))}</p>` : "") +
        `<p class="meta">Repo: <span class="mono">${escape(projectName(one.repoPath))}</span></p>` +
        `<form method="post" action="/chat/file/${escape(one.key)}" class="inline">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<input type="password" name="token" placeholder="your password" autocomplete="current-password">` +
        `<button type="submit">File unapproved</button></form>` +
        `</div>`,
    );
  }
  if (!subscription && data.canManage && data.focusTask === null) {
    parts.push(
      `<h2>Ask</h2>`,
      `<form method="post" action="/chat" class="card">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<label>Message<textarea name="message" rows="3" maxlength="2000"></textarea></label>`,
      `<label>Your password <span class="meta">(every message — chat spends)</span><input type="password" name="token" autocomplete="current-password"></label>`,
      `<button type="submit">Ask</button>`,
      `</form>`,
    );
  }
  if (data.canManage) {
    parts.push(
      `<p class="meta" id="chat-settings"><a href="/settings/lead">Lead settings</a> · provider, model and limits</p>`,
    );
  }
  if (data.recent.length > 0) {
    parts.push(`<details class="chat-turn-history"><summary>Conversation activity <span class="meta">${data.recent.length} recent turns</span></summary>`);
    for (const turn of data.recent) {
      parts.push(
        `<p class="row"><span class="mono">#${turn.id}</span> ${escape(turn.state)}` +
          `${turn.failureReason === null ? "" : ` · ${escape(turn.failureReason)}`}` +
          ` <span class="right meta">${turn.tokensIn ?? "–"} in / ${turn.tokensOut ?? "–"} out · ${subscription ? "membership" : `${chatMoney(turn.settledMicrousd ?? turn.reservedMicrousd)}${turn.settledMicrousd === null ? " reserved" : ""}`}</span></p>`,
      );
    }
    parts.push(`</details>`);
  }
  return screen("chat", chatWorkspace(parts.join("\n"), data.projects, data.csrf, true, data.focusTask, data.resultPanel ?? null), { chrome, functional: { script: CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: data.focusTask !== null } });
}

export function chatAckPage(chrome: Chrome, turn: ChatTurn, nonce: string, csrf: string): Screen {
  return screen("chat", [
    `<h1>Unknown spend</h1>`,
    `<div class="card">`,
    `<p>Turn <span class="mono">#${turn.id}</span> on <span class="mono">${escape(turn.provider)} · ${escape(turn.model)}</span> ` +
      `may have started before it failed (${escape(turn.failureReason ?? "crashed")}), and its cost could not be measured.</p>`,
    `<p><strong>Acknowledging charges the reserved worst case, ${chatMoney(turn.reservedMicrousd)}, to the ledger and re-enables chat on this credential.</strong></p>`,
    `<p class="meta">Check the provider's own usage dashboard if you want the exact figure first; the ledger keeps whichever is known.</p>`,
    `<form method="post" action="/chat/ack/${turn.id}">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<input type="hidden" name="nonce" value="${escape(nonce)}">`,
    `<label>Your password<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">Accept the charge — re-enable chat</button>`,
    `</form>`,
    `</div>`,
  ].join("\n"), { chrome });
}

/** The card that starts a conversation: the one password ceremony (mate arc §1). */
export function leadMintCard(
  csrf: string,
  enabled: { billing: "metered" | "subscription"; config: { provider: ChatProviderId; weeklyCeilingMicrousd: number } },
  returnTo = "/chat",
): string {
  const subscription = enabled.billing === "subscription";
  return [
    `<div class="card mate-mint" id="latest">`,
    `<p><strong>Start a conversation</strong></p>`,
    `<form method="post" action="/chat/mate/mint">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<input type="hidden" name="return" value="${escape(returnTo)}">`,
    `<div class="mate-terms">`,
    subscription
      ? `<span class="meta">Uses your ${enabled.config.provider === "codex-subscription" ? "Codex" : "Anthropic"} membership · no dollar limit · daily turn limits apply</span>`
      : `<label>Spend up to <span class="inline-field">$<input type="text" name="ceiling-usd" inputmode="decimal" value="5" style="width:5rem"></span> <span class="meta">(weekly chat ceiling ${chatMoney(enabled.config.weeklyCeilingMicrousd)} still applies)</span></label>`,
    `</div>`,
    `<label class="arm"><input type="checkbox" name="follow" value="yes"> Let the lead follow crew updates</label>`,
    `<button type="submit">Start chat</button>`,
    `</form>`,
    `</div>`,
  ].join("\n");
}

/** The decisions the cards on a page name, for the answer card's consequences and the builder's recommendation. */
export function decisionsFor(store: Store, proposals: readonly { kind: string; payload: Record<string, unknown> }[]): Map<number, Decision> {
  const out = new Map<number, Decision>();
  for (const one of proposals) {
    if (one.kind !== "answer" || typeof one.payload["decision"] !== "number") continue;
    const decision = store.getDecision(one.payload["decision"]);
    if (decision !== null) out.set(decision.id, decision);
  }
  return out;
}

export type ProposalCardView = {
  id: number;
  kind: LeadProposal["kind"];
  payload: Record<string, unknown>;
  state: string;
  outcome: Record<string, unknown> | null;
  /** Who proposed: the lead, or a coordinator by name. */
  by: { mate: true } | { mate: false; name: string; ago: string };
  /** Where confirm/dismiss post: `/chat/proposal` for the lead's, `/proposals` for a coordinator's. */
  actionBase: string;
};

/**
 * A proposal card: what, then confirm/dismiss, or the door's answer. An
 * `answer` card shows the question, every option WITH its consequence,
 * the builder's recommendation beside the proposer's pick, and — for an
 * irreversible option — the explicit confirmation field the decision
 * page itself uses (ruling 12).
 */
export function proposalCard(view: ProposalCardView, csrf: string, inert: boolean, decision: Decision | null, returnTo: string | null = null): string {
  return proposalCardParts(view, csrf, inert, decision, returnTo).html;
}

/** The card's HTML and, for the chat's confirm-in-place cards, the same
 * card as data: the body is the HTML's own, the act is the same door. */
export function proposalCardParts(view: ProposalCardView, csrf: string, inert: boolean, decision: Decision | null, returnTo: string | null = null): { html: string; card: BrowserActionCard } {
  const payload = view.payload;
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const task = text("task");
  const repoId = text("repoId");
  const presentations: Record<LeadProposal["kind"], { label: string; action: string; icon: string }> = {
    task: { label: payload["report"] === true ? "Scout investigation" : "New task", action: "file task", icon: `<path d="M12 5v14"/><path d="M5 12h14"/>` },
    next: { label: "Queue priority", action: "move to front", icon: `<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>` },
    reserve: { label: "Worker assignment", action: payload["worker"] === null ? "release" : "reserve", icon: `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>` },
    hold: { label: "Pause work", action: "hold", icon: `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>` },
    unhold: { label: "Resume work", action: "release hold", icon: `<path d="m7 4 13 8-13 8z"/>` },
    steer: { label: "Guidance for next attempt", action: "add guidance", icon: `<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>` },
    scope: { label: "Scope revision", action: "save scope", icon: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>` },
    answer: { label: "Decision answer", action: "confirm answer", icon: `<path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><path d="M12 18h.01"/><circle cx="12" cy="12" r="9"/>` },
    cancel: { label: "Cancel task", action: "open task", icon: `<path d="m15 9-6 6"/><path d="m9 9 6 6"/><circle cx="12" cy="12" r="9"/>` },
    repair: {
      label: "Task is waiting",
      action: text("operation") === "retry" ? "try again" : text("operation") === "replace" ? "wait for another task" : "continue without it",
      icon: `<path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3z"/>`,
    },
    agents: { label: "Agents change", action: "change agents", icon: `<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="m4.9 4.9 2.2 2.2"/><path d="m16.9 16.9 2.2 2.2"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m4.9 19.1 2.2-2.2"/><path d="m16.9 7.1 2.2-2.2"/>` },
    review: { label: text("operation") === "revise" ? "Changes to make" : "Note for later", action: text("operation") === "revise" ? "Request changes" : "Save for later", icon: `<path d="M4 5h16v12H8l-4 3z"/>` },
    control: { label: "Open control", action: "Open", icon: `<path d="M5 12h14m-6-6 6 6-6 6"/>` },
    action: { label: text("title") || "Review action", action: sharedActionPayload(payload) ? CHAT_ACTIONS[sharedActionPayload(payload)!.operation].label : "Unavailable", icon: `<path d="M5 12h14m-6-6 6 6-6 6"/>` },
    task_action: { label: payload["operation"] === "stop" ? "Stop task?" : payload["operation"] === "resume" ? "Resume task?" : "Task update", action: isChatTaskAction(payload["operation"]) ? CHAT_TASK_ACTIONS[payload["operation"]].label : "Unavailable", icon: `<path d="M5 12h14m-6-6 6 6-6 6"/>` },
  };
  const presentation = presentations[view.kind];
  const facts = (...rows: [string, string][]): string => {
    const visible = rows.filter(([, value]) => value !== "");
    return visible.length === 0 ? "" : `<dl class="proposal-facts">${visible.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
  };
  let what: string;
  if (view.kind === "task") {
    const planning = text("planning") || "auto";
    const planningWords = payload["report"] === true
      ? "not needed — this is an investigation"
      : planning === "required"
        ? "inspect the project and draft a plan first"
        : planning === "skip"
          ? "start from this proposed scope"
          : "inspect first when the work needs repository context";
    what =
      `<h3>${escape(text("title"))}</h3><p class="proposal-summary">${escape(text("goal"))}</p>` +
      facts(
        ["project", `<span class="mono">${escape(repoId)}</span>`],
        ["deliverable", payload["report"] === true ? "report only" : "branch"],
        ["planning", planningWords],
        ["checks", isCheckLevel(payload["checks"]) ? { quick: "Quick checks", full: "Full checks", off: "Off — built, not checked" }[payload["checks"]] : ""],
        ["out of scope", escape(text("not"))],
        ["may touch", Array.isArray(payload["touches"]) ? (payload["touches"] as string[]).map(one => `<span class="mono">${escape(one)}</span>`).join("<br>") : ""],
      );
  } else if (view.kind === "action") {
    const action=sharedActionPayload(payload);
    what=action===null?'<p>This action is unavailable.</p>':(sharedActionNeedsReview(action)?'':action.terms.map(term=>`<p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(term)}</p>`).join(''));
  } else if (view.kind === "task_action") {
    const operation = payload["operation"];
    what = `<h3>${escape(text("taskTitle") || task)}</h3>` +
      (operation === "stop" || operation === "resume" ? `<p class="meta">${escape(task)} · Run #${escape(String(payload["run"] ?? "?"))}</p>` : "") +
      `<p>${escape(isChatTaskAction(operation) ? CHAT_TASK_ACTIONS[operation].detail : "Action unavailable.")}</p>` +
      (text("dependency") === "" ? "" : `<p>${escape(text("dependencyTitle"))}</p>`);
  } else if (view.kind === "control") {
    const control = payload["control"];
    const label = isChatControl(control) ? CHAT_CONTROLS[control].label : "Control unavailable";
    // Navigation does not wait for approval. Give it a destination and one
    // link, not a proposal header that falsely reads as unfinished work.
    if (isChatControl(control) && view.state === "pending" && !inert) {
      const title = text("taskTitle");
      const href = chatControlHref(control, task, payload["run"], payload["project"]);
      return {
        html: `<article class="card proposal proposal-control" data-card-kind="control">` +
          (title === "" ? "" : `<div class="proposal-body"><h3>${escape(title)}</h3></div>`) +
          `<footer class="proposal-actions"><a class="button-link" href="${escape(href)}" aria-label="${escape(title === "" ? label : `${label}: ${title}`)}">${escape(label)}</a></footer></article>`,
        card: { id: view.id, kind: view.kind, label: title === "" ? label : title, state: "pending", body: "", said: null, links: [], primary: { kind: "link", label, href }, dismissable: false, note: null },
      };
    }
    what = `<h3>${escape(label)}</h3>${text("taskTitle") === "" ? "" : `<p>${escape(text("taskTitle"))}</p>`}`;
  } else if (view.kind === "review") {
    const snapshot = payload["snapshot"] as import("../chat-review.js").ReviewSnapshot | undefined;
    const ids = Array.isArray(payload["notes"]) ? payload["notes"] as number[] : [];
    const selected = snapshot?.notes.filter(one => ids.includes(one.id)) ?? [];
    const notes = [...selected, ...(text("note") === "" ? [] : [{ note: text("note"), path: text("path") || null, line: typeof payload["line"] === "number" ? payload["line"] : null }])];
    what = `<h3>${escape(text("taskTitle") || task)}</h3><ul class="proposal-review-notes">` +
      notes.map(one => `<li>${one.path === null ? "" : `<span class="mono">${escape(one.path)}${one.line === null ? "" : `:${one.line}`}</span> · `}${escape(one.note)}</li>`).join("") +
      `</ul>` + (text("operation") === "revise" ? `<p class="meta">Updates this task. Your approval settings apply.</p>` : `<p class="meta">No work starts.</p>`);
  } else if (view.kind === "next") {
    what = `<h3>Move <a href="${taskHref(task)}">${escape(task)}</a> to the front</h3>` + facts(["current position", `${escape(String(payload["position"] ?? "?"))} of ${escape(String(payload["of"] ?? "?"))}`], ["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "reserve") {
    what = `<h3>${payload["worker"] === null ? "Release" : "Reserve"} <a href="${taskHref(task)}">${escape(task)}</a></h3>` + facts(["destination", payload["worker"] === null ? "shared queue" : escape(text("worker"))], ["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "hold") {
    what = `<h3>Hold <a href="${taskHref(task)}">${escape(task)}</a></h3><p class="proposal-summary">${escape(text("reason"))}</p>` + facts(["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "unhold") {
    what = `<h3>Release <a href="${taskHref(task)}">${escape(task)}</a> from its hold</h3>` + facts(["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "steer") {
    const taskTitle = text("taskTitle") || task;
    what =
      `<h3>Guide <a href="${taskHref(task)}">${escape(taskTitle)}</a>'s next attempt</h3>` +
      `<p class="proposal-summary">${escape(text("note"))}</p>` +
      facts(["when", "next attempt"], ["project", `<span class="mono">${escape(repoId)}</span>`]) +
      `<p class="meta proposal-disclosure">This guides the next attempt without changing the task’s scope. It does not interrupt work already running.</p>`;
  } else if (view.kind === "agents") {
    // The agents card (v48): exactly what changes, in the same words the
    // task page uses — the role, the exact agent, the size — and the
    // consequence for the standing approval.
    const taskTitle = text("taskTitle") || task;
    const role = text("role");
    const clear = payload["clear"] === true;
    const agentWords = text("provider") === "" ? "" : `${text("provider")} · ${text("model")}`;
    const size = text("size");
    const sizeLine = size === "" ? "" : `${size}${payload["risky"] === true ? ", risky" : ""} change`;
    const heading = role !== "" && !clear
      ? `Run <a href="${taskHref(task)}">${escape(taskTitle)}</a>'s ${escape(role)} on <span class="mono">${escape(agentWords)}</span>`
      : role !== "" && clear
        ? `Let the recommended ${escape(role)} stand for <a href="${taskHref(task)}">${escape(taskTitle)}</a>`
        : size !== ""
          ? `Treat <a href="${taskHref(task)}">${escape(taskTitle)}</a> as a ${escape(sizeLine)}`
          : `Change the agents for <a href="${taskHref(task)}">${escape(taskTitle)}</a>`;
    what =
      `<h3>${heading}</h3>` +
      (text("why") === "" ? "" : `<p class="proposal-summary">${escape(text("why"))}</p>`) +
      facts(
        ["agents now", escape(text("before"))],
        ["size", size === "" ? "" : escape(sizeConsequence(size, payload["risky"] === true))],
        ["role", role === "" ? "" : `${escape(role)} → ${clear ? "the recommendation" : `<span class="mono">${escape(agentWords)}</span>`}`],
        ["project", `<span class="mono">${escape(repoId)}</span>`],
      ) +
      `<p class="meta proposal-disclosure">Recorded under your name when you confirm. ${text("approval") === "approved" ? "The current approval no longer covers the task afterwards — approve it again on the task." : "The next approval seals these agents."}</p>`;
  } else if (view.kind === "scope") {
    what =
      `<h3>Rewrite <a href="${taskHref(task)}">${escape(task)}</a></h3><p class="proposal-summary">${escape(text("goal"))}</p>` +
      // One path per line (UI polish 2026-09-13): a comma run broke mid-token on a phone.
      facts(["out of scope", escape(text("not"))], ["may touch", Array.isArray(payload["touches"]) ? (payload["touches"] as string[]).map(one => `<span class="mono">${escape(one)}</span>`).join("<br>") : ""], ["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "repair") {
    const blocker = text("blocker");
    const operation = text("operation");
    const replacement = text("replacement");
    const taskTitle = text("taskTitle") || task;
    const blockerTitle = text("blockerTitle") || blocker;
    const replacementTitle = text("replacementTitle") || replacement;
    const taskLink = `<a href="${taskHref(task)}">${escape(taskTitle)}</a>`;
    const blockerLink = `<a href="${taskHref(blocker)}">${escape(blockerTitle)}</a>`;
    const replacementLink = replacement === "" ? "" : `<a href="${taskHref(replacement)}">${escape(replacementTitle)}</a>`;
    const heading =
      operation === "retry"
        ? `Try ${blockerLink} again`
        : operation === "replace"
          ? `Have ${taskLink} wait for different work`
          : `Let ${taskLink} continue without ${blockerLink}`;
    const consequence =
      operation === "retry"
        ? `${escape(taskTitle)} will keep waiting while ${escape(blockerTitle)} gets another attempt.`
        : operation === "replace"
          ? `${escape(taskTitle)} will wait for ${escape(replacementTitle)} instead.`
          : `${escape(taskTitle)} may be ready to run once it no longer waits for ${escape(blockerTitle)}.`;
    what =
      `<h3>${heading}</h3><p class="proposal-summary">${consequence}</p>` +
      facts(
        ["task that is waiting", taskLink],
        ["work it needed", `${blockerLink} · ${escape(text("sawBlockerState"))}`],
        ["wait for instead", replacementLink],
        ["project", `<span class="mono">${escape(repoId)}</span>`],
      );
  } else if (view.kind === "answer") {
    const decisionId = typeof payload["decision"] === "number" ? payload["decision"] : 0;
    const pick = text("option");
    const options =
      decision === null
        ? `<p class="meta">The decision is gone</p>`
        : `<ul class="answer-options">` +
          decision.options
            .map(
              one =>
                `<li${one.id === pick ? ' class="picked"' : ""}><strong>${escape(one.label)}</strong>${one.reversible ? "" : ' <span class="badge">Irreversible</span>'}` +
                `${one.id === decision.recommendation ? ' <span class="meta">— the builder recommends this</span>' : ""}` +
                `${one.id === pick ? ' <span class="meta">— proposed</span>' : ""}` +
                `<p class="meta">${escape(one.consequence)}</p></li>`,
            )
            .join("") +
          `</ul>`;
    what =
      `<h3>Answer <a href="/d/${decisionId}">decision #${decisionId}</a> on <a href="${taskHref(task)}">${escape(task)}</a></h3>` +
      (decision === null ? "" : `<p class="proposal-summary">${escape(decision.question)}</p>`) +
      options +
      `<div class="proposal-rationale"><span class="eyebrow">proposed answer</span><strong>${escape(text("optionLabel"))}</strong><p>${escape(text("rationale"))}</p></div>` +
      `<p class="meta proposal-disclosure">${payload["readConsequences"] === true ? `${view.by.mate ? "The lead" : "The coordinator"} read every consequence but not the builder's recommendation` : `${view.by.mate ? "The lead" : "The coordinator"} did not read the consequences`}. You see both here${decision !== null && decision.state !== "open" ? " · this decision is no longer open" : ""}.</p>`;
  } else {
    what = `<h3>Cancel <a href="${taskHref(task)}">${escape(task)}</a></h3><p class="proposal-summary">${escape(text("reason"))}</p>` + facts(["project", `<span class="mono">${escape(repoId)}</span>`]);
  }
  const outcome = view.outcome as { said?: unknown; taskId?: unknown; href?: unknown } | null;
  const said = outcome !== null && typeof outcome.said === "string" ? outcome.said : null;
  const flowHref = view.state === "confirmed" && outcome !== null && typeof outcome.href === "string" && FLOW_HREF.test(outcome.href) ? outcome.href : null;
  const irreversible = view.kind === "answer" && payload["reversible"] === false;
  const provenance = view.by.mate ? "mate" : `${escape(view.by.name)} · ${escape(view.by.ago)}`;
  const returnField = returnTo === null ? "" : `<input type="hidden" name="return" value="${escape(returnTo)}">`;
  let acts = "";
  if (view.state === "pending" && !inert) {
    acts =
      view.kind === "action" && sharedActionPayload(payload)!==null && sharedActionNeedsReview(sharedActionPayload(payload)!)
        ? `<a class="button-link" href="${sharedActionReviewPath(view.id)}">Review action</a><form method="post" action="${view.actionBase}/${view.id}/dismiss" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">${returnField}<button class="quiet">Dismiss</button></form>`
        : view.kind === "control"
        ? (isChatControl(payload["control"]) ? `<a class="button-link" href="${escape(chatControlHref(payload["control"], task, payload["run"], payload["project"]))}">${escape(CHAT_CONTROLS[payload["control"]].label)}</a>` : `<p>Control unavailable.</p>`)
        : view.kind === "cancel"
        ? `<p class="meta">Cancelling is armed on the task itself — <a href="${taskHref(task)}">open ${escape(task)}</a></p>` +
          `<form method="post" action="${view.actionBase}/${view.id}/dismiss" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">${returnField}<button type="submit" class="quiet">Dismiss</button></form>`
        : `<div class="acts">` +
          `<form method="post" action="${view.actionBase}/${view.id}/confirm" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">${returnField}` +
          (irreversible ? `<label class="arm"><input type="checkbox" name="confirm" value="yes"> I understand this cannot be undone</label>` : "") +
          `<button type="submit">${escape(presentation.action)}</button></form>` +
          `<form method="post" action="${view.actionBase}/${view.id}/dismiss" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">${returnField}<button type="submit" class="quiet">Dismiss</button></form>` +
          `</div>`;
  } else if (view.state === "pending") {
    acts = `<p class="meta proposal-wait">${escape(PROPOSAL_WAIT_REASON)}</p>`;
  } else if (view.state === "confirmed") {
    const filed = outcome !== null && typeof outcome.taskId === "string" ? outcome.taskId : null;
    acts =
      `<p class="done">${escape(said ?? "confirmed")}` +
      ((view.kind === "scope" || view.kind === "agents" || (view.kind === "review" && text("operation") === "revise")) && filed !== null
        ? ` — <a href="${taskChatHref(filed)}#task-chat-action">review & start in chat</a>`
        : "") +
      (flowHref === null ? "" : ` — <a href="${escape(flowHref)}">open the flow</a>`) +
      `</p>` +
      // The created task, by its recorded id (package 2): one clear road
      // into its lens — the same conversation, focused — and the overview.
      (filed !== null && view.kind === "task"
        ? `<p class="proposal-filed"><a class="button-link" href="${taskChatHref(filed)}" data-filed-task="${escape(filed)}">Open task <span class="mono">${escape(filed)}</span> →</a> <a href="${taskHref(filed)}">overview</a></p>`
        : "");
  } else if (view.state === "refused") {
    acts = `<p class="refused">${escape(said ?? "refused")}</p>`;
  } else {
    acts = `<p class="meta">${escape(view.state)}</p>`;
  }
  const stateClass = view.state === "confirmed" ? "badge-done" : view.state === "refused" ? "badge-failed" : "";
  const html = (
    `<article class="card proposal proposal-${escape(view.kind)} ${escape(view.state)}" data-card-kind="${escape(view.kind)}">` +
    `<header class="proposal-head"><span class="proposal-icon">${strokeIcon(presentation.icon)}</span>` +
    `<span><strong>${escape(presentation.label)}</strong><small>proposed by ${provenance}</small></span>` +
    `<span class="badge ${stateClass}">${escape(sentenceCase(view.state))}</span></header>` +
    `<div class="proposal-body">${what}</div>` +
    `<footer class="proposal-actions">${acts}</footer></article>`
  );
  // The same card as data (chat cards): one act, in the door's own words.
  const filedTask = outcome !== null && typeof outcome.taskId === "string" ? outcome.taskId : null;
  const reviewAction = view.kind === "action" ? sharedActionPayload(payload) : null;
  const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);
  const pending = view.state === "pending" && !inert;
  const primary: BrowserActionCard["primary"] = !pending ? null
    : reviewAction !== null && sharedActionNeedsReview(reviewAction) ? { kind: "link", label: "Review action", href: sharedActionReviewPath(view.id) }
    : view.kind === "control" ? (isChatControl(payload["control"]) ? { kind: "link", label: CHAT_CONTROLS[payload["control"]].label, href: chatControlHref(payload["control"], task, payload["run"], payload["project"]) } : null)
    : view.kind === "cancel" ? { kind: "link", label: "Open task", href: taskHref(task) }
    : { kind: "confirm", label: sentence(presentation.action), irreversible, native: view.kind === "task_action" && payload["operation"] === "resume" };
  const card: BrowserActionCard = {
    id: view.id, kind: view.kind, label: presentation.label, state: view.state as BrowserActionCard["state"], body: what,
    said: view.state === "confirmed" || view.state === "refused" ? said : null,
    links: view.state !== "confirmed" ? [] : [
      ...(filedTask === null ? [] : [{ label: view.kind === "task" ? "Open the new task" : "Open the task", href: taskHref(filedTask) }]),
      ...(flowHref === null ? [] : [{ label: "Open the flow", href: flowHref }]),
    ],
    primary,
    dismissable: pending && view.kind !== "control",
    note: view.state === "pending" && inert ? PROPOSAL_WAIT_REASON
      : pending && view.kind === "cancel" ? "Cancelling is confirmed on the task itself."
      : view.state === "dismissed" ? "Dismissed." : view.state === "expired" ? "Expired — this conversation moved on." : null,
  };
  return { html, card };
}

export function leadProposalCard(proposal: LeadProposal, csrf: string, inert: boolean, decision: Decision | null, returnTo: string | null = null): string {
  return leadProposalCardParts(proposal, csrf, inert, decision, returnTo).html;
}
export function leadProposalCardParts(proposal: LeadProposal, csrf: string, inert: boolean, decision: Decision | null, returnTo: string | null = null): { html: string; card: BrowserActionCard } {
  return proposalCardParts({ id: proposal.id, kind: proposal.kind, payload: proposal.payload, state: proposal.state, outcome: proposal.outcome, by: { mate: true }, actionBase: "/chat/proposal" }, csrf, inert, decision, returnTo);
}

/** Review and inline team cards share the same server-decided controls and reasons. */
export function teamProposalCardParts(store: Store, actor: { name: string; generation: number }, proposal: LeadProposal, snapshot: TeamSnapshot, csrf: string, decision: Decision | null, now: Date, provider: TeamChatProviderResolver): { html: string; card: BrowserActionCard } {
  const gate = proposalActGate(store, actor, proposal.thread, now, provider);
  const reason = !gate.ok ? gate.said : null;
  const back = '/chat?conversation=' + encodeURIComponent(snapshot.selected!.id);
  const parts = leadProposalCardParts(proposal, csrf, reason !== null, decision, back);
  if (reason !== null && reason !== PROPOSAL_WAIT_REASON && proposal.state === 'pending') {
    parts.html = parts.html.replace(PROPOSAL_WAIT_REASON, reason);
    parts.card = { ...parts.card, note: reason };
  }
  return parts;
}

export function coordinatorProposalCard(proposal: CoordinatorProposal, csrf: string, now: Date, decision: Decision | null, returnTo: string | null = null): string {
  return proposalCard(
    { id: proposal.id, kind: proposal.kind, payload: proposal.payload, state: proposal.state, outcome: proposal.outcome, by: { mate: false, name: proposal.name, ago: relativeAge(proposal.createdAt, now) }, actionBase: "/proposals" },
    csrf,
    false,
    decision,
    returnTo,
  );
}

export function relativeAge(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The section shared by /chat (both modes) and the task page: pending coordinator proposals as cards. */
export function coordinatorProposalsSection(proposals: readonly CoordinatorProposal[], decisions: Map<number, Decision>, csrf: string, now: Date, heading = true, returnTo: string | null = null): string {
  if (proposals.length === 0) return "";
  return (
    (heading ? `<h2>Proposed by coordinators <span class="meta">${proposals.length}</span></h2>` : "") +
    `<div class="coordinator-proposals">` +
    proposals.map(one => coordinatorProposalCard(one, csrf, now, decisions.get(typeof one.payload["decision"] === "number" ? one.payload["decision"] : -1) ?? null, returnTo)).join("") +
    `</div>`
  );
}

/** The lead thread a change in reachable projects closed (mate arc ruling 9): its saved words and card outcomes, never continued. */
export type ReplacedThread = { messages: LeadMessage[]; proposals: LeadProposal[]; decisions: Map<number, Decision> };
export const REPLACED_THREAD_DIVIDER = "New conversation — the projects I can reach changed";

/** The replaced thread as the React conversation renders it: words and card outcomes, no buttons. */
export function replacedBrowserMessages(previous: ReplacedThread, csrf: string): import("../browser-workspace.js").BrowserMessage[] {
  return leadBrowserMessages({ ...previous, pending: null, ask: null, asks: new Map() }, csrf, null).map(message => ({
    ...message, cardsHtml: "",
    cards: (message.cards ?? []).map(card => ({ ...card, primary: null, dismissable: false })),
  }));
}

/** The replaced thread for the server-rendered page: read only, then the divider. */
export function replacedThreadHtml(previous: ReplacedThread | null | undefined): string {
  if (previous == null) return "";
  return `<section class="thread chat-previous" aria-label="Earlier conversation" data-previous-thread>` +
    previous.messages.map(one => one.role === "operator"
      ? `<div class="msg op" data-previous-message="${one.id}"><p style="white-space:pre-wrap">${escape(one.text)}</p></div>`
      : `<div class="msg mate" data-previous-message="${one.id}">${renderChatText(one.text)}</div>`).join("") +
    `<p class="chat-previous-divider" role="separator" data-thread-divider>${escape(REPLACED_THREAD_DIVIDER)}</p></section>`;
}

export type LeadThreadRows = {
  /** The lead thread a change in reachable projects replaced; shown only. */
  previous?: ReplacedThread | null;
  messages: LeadMessage[];
  proposals: LeadProposal[];
  /** The decisions the answer cards name. */
  decisions: Map<number, Decision>;
  coordinatorProposals: CoordinatorProposal[];
  pending: LeadTurn | null;
  recent: LeadTurn[];
  /** Optional task lens into the same unified thread. */
  focusTask: TaskChatFocus | null;
  /** The lead's open question to this reader, drawn as buttons under its reply. */
  ask?: LeadAsk | null;
  /** Every question the lead asked in these messages, by turn: answered ones show their words without buttons. */
  asks?: Map<number, LeadAsk>;
};

/** The lead's question as buttons: each option sends itself as the next message (the same POST as a typed one);
 * "Something else" moves to the composer. Nothing shows while a reply is running. */
export function leadAskHtml(ask: LeadAsk, csrf: string, target: { task: string | null; project: string | null }, composer: string, open = true): string {
  if (!open) return `<div class="so-owner-ask" data-ask="${ask.turn}"><p class="so-owner-ask-question"><strong>${escape(ask.question)}</strong></p></div>`;
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
    (target.task !== null ? `<input type="hidden" name="task" value="${escape(target.task)}">` : target.project !== null ? `<input type="hidden" name="project" value="${escape(target.project)}">` : "");
  return `<div class="so-owner-ask" data-ask="${ask.turn}"><p class="so-owner-ask-question"><strong>${escape(ask.question)}</strong></p>` +
    `<div class="so-owner-ask-options" role="group" aria-label="Answer options">` +
    ask.options.map(option => `<form method="post" action="/chat" class="inline">${hidden}<button type="submit" name="message" value="${escape(option)}" class="so-suggestion quiet">${escape(option)}</button></form>`).join("") +
    `<label for="${escape(composer)}" class="so-suggestion so-owner-ask-other">${escape(LEAD_ASK_OTHER)}</label></div></div>`;
}

/** The thread's messages as the React conversation renders them, each
 * with the proposal cards its turn produced; `back` is where a card's
 * confirm or dismiss returns. */
export function leadBrowserMessages(rows: Pick<LeadThreadRows, "messages" | "proposals" | "decisions" | "pending" | "ask" | "asks">, csrf: string, back: string | null, target: { task: string | null; project: string | null } = { task: null, project: null }): import("../browser-workspace.js").BrowserMessage[] {
  const open = rows.pending === null ? rows.ask?.turn ?? null : null;
  const asked = (turn: number | null): string => {
    const ask = turn === null ? undefined : rows.asks?.get(turn);
    return ask === undefined ? "" : leadAskHtml(ask, csrf, target, target.task === null ? "lead-message" : "task-message", ask.turn === open);
  };
  // The owner's message each reply answers: when it asked for ids, the reply keeps them.
  const askedBy = new Map<number, string>();
  rows.messages.reduce<string | undefined>((last, message) => { if (message.role === 'operator') return message.text; if (last !== undefined) askedBy.set(message.id, last); return last; }, undefined);
  return rows.messages.map(message => ({
    id: message.id, role: message.role, text: message.text,
    html: message.role === 'operator' ? `<p>${escape(message.text)}</p>` : renderChatText(message.text, askedBy.get(message.id)) + asked(message.turn),
    activity: message.activity, createdAt: message.createdAt,
    ...(() => {
      // Under the lead's message only, as the server-rendered thread does: the person's message shares the turn.
      const parts = message.turn === null || message.role === 'operator' ? [] : rows.proposals.filter(one => one.turn === message.turn)
        .map(one => leadProposalCardParts(one, csrf, rows.pending !== null, rows.decisions.get(typeof one.payload['decision'] === 'number' ? one.payload['decision'] : -1) ?? null, back));
      return { cardsHtml: parts.map(one => one.html).join(''), cards: parts.map(one => one.card) };
    })(),
  }));
}

/** The version of the DISPLAYED conversation (package 2): every fact a
 * thread or task fragment renders — message identities, card states and
 * outcomes, the live turn and its step count, the last turn's state, the
 * decisions the cards name, and the task lens's own facts — and nothing
 * that merely ticks: no relative age, no freshly minted nonce, no csrf.
 * Equal versions mean equal fragments; the poll fetches nothing else. */
export function leadChatVersion(rows: LeadThreadRows): string {
  const focus = rows.focusTask;
  const facts = [
    rows.messages.map(one => [one.id, one.role, one.turn]),
    rows.previous == null ? null : rows.previous.messages.map(one => one.id),
    rows.proposals.map(one => [one.id, one.state, one.outcome === null ? null : JSON.stringify(one.outcome)]),
    rows.coordinatorProposals.map(one => [one.id, one.state, one.outcome === null ? null : JSON.stringify(one.outcome)]),
    [...rows.decisions.values()].map(one => [one.id, one.state, one.choice ?? null]),
    rows.pending === null ? null : [rows.pending.id, rows.pending.steps],
    rows.ask?.turn ?? null,
    rows.recent[0] === undefined ? null : [rows.recent[0].id, rows.recent[0].state, rows.recent[0].failureReason],
    focus === null
      ? null
      : [
          focus.id, focus.executionId, focus.history, focus.title, focus.state, focus.scope, focus.plan, focus.claimed,
          focus.approval === null ? null : [focus.approval.digest, focus.approval.nonce === "" ? "closed" : "open", focus.approval.revision !== null && "problem" in focus.approval.revision ? focus.approval.revision.problem : null],
          focus.liveRun === null ? null : [focus.liveRun.id, focus.liveRun.phase, focus.liveRun.runner],
          focus.control,
          focus.dispatch === null ? null : [focus.dispatch.code, focus.dispatch.summary, focus.dispatch.detail],
          focus.decisions.map(one => [one.id, one.state]),
          focus.result === null ? null : [focus.result.runId, focus.result.outcome, focus.result.verdict],
          focus.publication === null ? null : [focus.publication.id, focus.publication.state, focus.publication.lastCheckState],
          focus.milestoneProgress === null ? null : focus.milestoneProgress.map(one => [one.id, one.state, one.note]),
          focus.planRevisions === null ? null : [focus.planRevisions.current?.sha256 ?? null, focus.planRevisions.current?.status ?? null, focus.planRevisions.pending?.sha256 ?? null, focus.planRevisions.pending?.status ?? null, focus.planRevisions.history.length],
          focus.route === null ? null : [focus.route.kind, focus.route.digest, focus.route.editable, focus.route.problem],
        ],
  ];
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 16);
}

/** The thread region — the one safe region the live refresh reconciles
 * (package 2): coordinator cards, the operator/assistant messages with
 * their cards, the reply-in-progress card, and the starters that follow a
 * populated thread. Every child carries a stable `data-key` so the page
 * keeps an unchanged node (its open disclosures, its focus) and replaces
 * only what the server rendered differently. The composer is never here. */
export function leadThreadHtml(data: LeadThreadRows & { csrf: string; now: Date; problem: string | null; chatProject?: string | null }): string {
  const returnTo = data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id);
  const parts: string[] = [];
  if (data.problem !== null) parts.push(`<div class="problem" data-key="said">${escape(data.problem)}</div>`);
  const byTurn = new Map<number, LeadProposal[]>();
  for (const one of data.proposals) {
    const list = byTurn.get(one.turn) ?? [];
    list.push(one);
    byTurn.set(one.turn, list);
  }
  const inert = data.pending !== null;
  const lastMessage = data.messages.at(-1);
  const latestReply = data.pending === null && lastMessage?.role === "assistant" ? lastMessage.id : null;
  const coordinator = coordinatorProposalsSection(data.coordinatorProposals, data.decisions, data.csrf, data.now, true, data.focusTask === null ? null : returnTo);
  if (coordinator !== "") parts.push(`<div data-key="coordinators" data-chat-list>${coordinator}</div>`);
  parts.push(`<div class="thread" data-key="thread" data-chat-list>`);
  if (data.messages.length === 0) {
    parts.push(
      `<div class="chat-empty" data-key="empty"><strong>${data.focusTask === null ? "What do you want to get done?" : "What do you want to understand or change?"}</strong>` +
      `<p class="meta">${data.focusTask === null ? "Describe a task or ask about your projects." : "Ask about progress, review results, or adjust the plan."}</p></div>`,
    );
  }
  let asked: string | undefined;
  for (const message of data.messages) {
    if (message.role === "operator") {
      asked = message.text;
      parts.push(`<div class="msg op" data-message-role="operator" data-key="m${message.id}"><p style="white-space:pre-wrap">${escape(message.text)}</p></div>`);
      continue;
    }
    const cards = message.turn === null ? [] : (byTurn.get(message.turn) ?? []);
    parts.push(
      `<div class="msg mate" data-message-role="assistant" data-key="m${message.id}"${message.id === latestReply ? ' id="latest"' : ""}>` +
        renderChatText(message.text, asked) +
        (() => {
          const ask = message.turn === null ? undefined : data.asks?.get(message.turn);
          return ask === undefined ? "" : leadAskHtml(ask, data.csrf, { task: data.focusTask?.id ?? null, project: data.chatProject ?? null }, "chat-message", data.pending === null && data.ask?.turn === ask.turn);
        })() +
        cards.map(one => leadProposalCard(one, data.csrf, inert, data.decisions.get(typeof one.payload["decision"] === "number" ? one.payload["decision"] : -1) ?? null, data.focusTask === null ? null : returnTo)).join("") +
        `<div class="chat-message-foot">${chatActivity(message.activity)}<time datetime="${escape(message.createdAt)}">${escape(relativeAge(message.createdAt, data.now))}</time></div>` +
        `</div>`,
    );
  }
  parts.push(`</div>`);
  if (data.pending !== null) {
    const subscription = data.pending.reservedMicrousd === 0;
    parts.push(chatWorkingHtml({keyed:true,
      details:`Turn #${data.pending.id} · ${data.pending.steps} step${data.pending.steps === 1 ? "" : "s"}${subscription ? " · subscription" : ` · up to ${chatMoney(data.pending.reservedMicrousd)} reserved`}`,
      stopForm:`<form method="post" action="/chat/mate/stop" class="inline"><input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="return" value="${escape(returnTo)}"><input type="hidden" name="turn" value="${data.pending.id}"><button type="submit" class="quiet" aria-label="Stop chat response">Stop</button></form>`,
    }));
  }
  // Suggestions help start a conversation; repeating them after every
  // response competes with the actual result and its available actions.
  return `<div id="chat-thread" data-chat-region="thread">${parts.join("\n")}</div>`;
}

/** What follows the composer (package 2): the starters of an EMPTY thread
 * sit under the box; once the first message lands they move above it. */
export function leadAfterComposerHtml(data: { messages: LeadMessage[]; pending: LeadTurn | null; focusTask: TaskChatFocus | null; csrf: string }): string {
  return `<div id="chat-after-composer" data-chat-region="after">${data.messages.length === 0 && data.pending === null ? leadPromptStarters(data.csrf, data.focusTask) : ""}</div>`;
}

export function leadPage(chrome: Chrome, data: LeadThreadRows & {
  session: LeadSession;
  /** A project's own thread (v77); null for the lead conversation or a task. */
  chatProject?: string | null;
  follow?: { enabled: boolean; detail: string };
  resultRunId?: number | null;
  latched: ChatTurn[];
  config: import("../store.js").ChatConfig;
  turnsToday: number;
  weeklySpent: number;
  projects: ChatProjectPulse[];
  fleetSnapshot: AssignmentChatSnapshot | null;
  catchUp?: string;
  csrf: string;
  problem: string | null;
  now: Date;
  /** The task's result detail (package 3), when the URL opened one. */
  resultPanel?: string | null;
}): Screen {
  const subscription = isSubscriptionChatProvider(data.config.provider);
  const chatProject = data.focusTask === null ? data.chatProject ?? null : null;
  const returnTo = data.focusTask !== null ? taskChatHref(data.focusTask.id) : chatProject !== null ? projectChatHref(chatProject) : "/chat";
  const controlsHtml = [
    `<details class="lead-follow"><summary>Automatic crew updates${data.follow?.enabled ? ' · On' : ''}</summary><p class="meta">${escape(data.follow?.detail ?? 'Automatic crew updates are off.')}</p><form method="post" action="/chat/mate/follow"><input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="return" value="${escape(returnTo)}"><input type="hidden" name="enabled" value="${data.follow?.enabled ? 'no' : 'yes'}">${data.follow?.enabled ? '' : `<p>The lead responds when results or decisions arrive. Uses this conversation’s ${subscription ? 'membership usage, with no dollar maximum' : 'remaining spend allowance'} and daily turn limit. Existing task approvals still apply.</p>`}<button type="submit" class="quiet">${data.follow?.enabled ? 'Pause updates' : 'Enable updates'}</button></form></details>`,
    `<details class="chat-limits chat-session-details"><summary>Conversation details<span class="meta">${escape(subscription ? "membership" : data.config.provider)}</span></summary>`,
    `<div class="chat-budget"><span class="mono">${escape(data.config.provider)} · ${escape(data.config.model)}</span><span>${data.turnsToday} / ${data.config.dailyTurns} turns today</span>` +
      (subscription
        ? `<span>membership login · no dollar ceiling</span>`
        : `<span>this conversation: ${chatMoney(data.session.spentMicrousd)} of ${chatMoney(data.session.ceilingMicrousd)}</span>` +
          `<span>this week ${chatMoney(data.weeklySpent)} of ${chatMoney(data.config.weeklyCeilingMicrousd)}</span>`) +
      `</div>`,
    `<p class="meta">Started ${escape(data.session.mintedAt.slice(0, 16).replace("T", " "))}Z. It stays open until you end it; only bounded recent context is sent to the model.</p>`,
    `<form method="post" action="/chat/mate/end" class="inline"><input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="return" value="${escape(returnTo)}"><button type="submit" class="quiet">End the conversation and forget the thread</button></form>`,
    data.recent.length === 0
      ? ""
      : `<p class="meta">Recent turns: ${data.recent
          .map(turn => `<span class="mono">#${turn.id}</span> ${escape(turn.state)}${turn.failureReason === null ? "" : ` · ${escape(turn.failureReason)}`} · ${subscription ? "membership" : chatMoney(turn.settledMicrousd ?? turn.reservedMicrousd)}`)
          .join(" · ")}</p>`,
    `<p class="meta"><a href="/settings/lead">Lead settings</a> · provider, model and limits</p>`,
    `</details>`,
  ].join("\n");
  const conversation: string[] = [
    data.focusTask === null
      ? chatHeading("", data.projects.length)
      : taskChatHeading(data.focusTask),
    data.focusTask === null ? (data.catchUp ?? "") : taskChatLiveRegion(data.focusTask, data.csrf, false, data.pending !== null),
    // The DB catch-up replaces the older, duplicate portfolio summary.
    data.focusTask === null && !data.catchUp ? `<details class="chat-fleet-context">${chatOverviewSummaryHtml(data.projects, data.fleetSnapshot?.attentionCount)}${chatFleetOverview(data.fleetSnapshot, data.projects, data.csrf, data.pending === null)}</details>` : "",
  ];
  if (data.problem !== null) conversation.push(`<div class="problem">${escape(data.problem)}</div>`);
  for (const turn of data.latched) {
    conversation.push(
      `<div class="problem"><strong>Chat is paused.</strong> An earlier reply stopped before its cost was known; it may have cost up to ${chatMoney(turn.reservedMicrousd)}. ` +
        `<a href="/chat/ack/${turn.id}">Confirm that cost</a> to turn chat back on.</div>`,
    );
  }
  const lastMessage = data.messages.at(-1);
  const latestReply = data.pending === null && lastMessage?.role === "assistant" ? lastMessage.id : null;
  conversation.push(replacedThreadHtml(data.previous));
  conversation.push(leadThreadHtml({ ...data, problem: null, chatProject }));
  conversation.push(
    // The New update action (package 2): hidden until a live update lands
    // while the reader is above the latest message; a real button, so the
    // keyboard reaches it. Only this act moves the reader.
    `<div class="chat-new-update-holder"><button type="button" class="chat-new-update" id="chat-new-update" hidden>New update ↓</button></div>`,
    `<form method="post" action="/chat" class="card composer" id="${latestReply === null && data.pending === null ? "latest" : "chat-composer"}" aria-label="message the lead" data-chat-session="${data.session.id}" data-chat-task="${escape(data.focusTask?.id ?? "")}" data-chat-user="${escape(data.session.approver)}" data-chat-busy="${data.pending === null ? "0" : "1"}" data-chat-version="${leadChatVersion(data)}" data-chat-approval="${escape(data.focusTask?.approval?.digest ?? "")}">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="request" value="${randomBytes(16).toString("hex")}"><input type="hidden" name="request-session" value="${data.session.id}">`,
    data.focusTask === null ? "" : `<input type="hidden" name="task" value="${escape(data.focusTask.id)}">`,
    chatProject === null ? "" : `<input type="hidden" name="project" value="${escape(chatProject)}">`,
    data.resultRunId == null ? "" : `<input type="hidden" name="result" value="${data.resultRunId}">`,
    `<label>Message<textarea id="chat-message" name="message" rows="1" maxlength="${LEAD_MESSAGE_MAX_CHARS}" placeholder="${data.focusTask !== null ? "Ask about this task…" : chatProject !== null ? `Ask about ${escape(projectName(chatProject))}…` : "Describe what you want done…"}"></textarea></label>`,
    `<button type="submit" aria-label="${data.pending === null ? "send message" : "wait for the current reply before sending"}"${data.pending === null ? "" : " disabled"}>Send</button>`,
    `</form>`,
    // Concise pass (2026-09-13): the status line speaks only when there is
    // a state to report — a reply in progress here, the connection from
    // the continuity script — and the composer carries no second intro.
    `<p class="meta composer-hint" id="chat-connection" role="status" aria-live="polite">${data.pending === null ? "" : "Reply in progress. You can draft your next message or come back later."}</p>`,
    // The explicit reconnection (package 2): shown only once the session
    // or sign-in changed under this page; it reloads on the reader's act.
    `<p class="meta composer-hint" id="chat-reconnect" hidden><button type="button" class="quiet">Reconnect</button></p>`,
    leadAfterComposerHtml(data),
    controlsHtml,

  );
  return screen(
    "chat",
    chatWorkspace(conversation.join("\n"), data.projects, data.csrf, false, data.focusTask, data.resultPanel ?? null),
    { chrome, functional: { script: CHAT_CONTINUITY_SCRIPT + CHAT_UI_SCRIPT + (data.focusTask === null ? "" : RESULT_REVIEW_SCRIPT), fetches: true },
      workspace: {
        conversation: {
          sessionId: data.session.id, user: data.session.approver, version: leadChatVersion(data),
          messages: leadBrowserMessages(data, data.csrf, data.focusTask === null && chatProject === null ? null : returnTo, { task: data.focusTask?.id ?? null, project: chatProject }),
          pendingTurnId: data.pending?.id ?? null, requestId: randomBytes(16).toString('hex'), maxChars: LEAD_MESSAGE_MAX_CHARS,
          taskId: data.focusTask?.id ?? null, resultRunId: data.resultRunId ?? null, project: chatProject,
          ...(data.previous == null ? {} : { previous: { messages: replacedBrowserMessages(data.previous, data.csrf) } }),
        },
        focus: data.focusTask === null ? null : { id: data.focusTask.id, title: data.focusTask.title,
          html: taskChatLiveRegion(data.focusTask, data.csrf, requestContext.getStore()?.workspaceRead === true, data.pending !== null) },
        result: data.resultPanel && data.resultRunId != null ? { runId: data.resultRunId, html: data.resultPanel } : null,
        catchUpHtml: (data.focusTask === null ? data.catchUp ?? '' : '')
          + coordinatorProposalsSection(data.coordinatorProposals, data.decisions, data.csrf, data.now, true, data.focusTask === null ? null : returnTo)
          + data.latched.map(turn => `<p class="problem">Chat is paused because usage is unconfirmed. <a href="/chat/ack/${turn.id}">Inspect turn #${turn.id}</a>.</p>`).join(''),
        controlsHtml,
        notices: data.problem === null ? [] : [data.problem], pageHtml: null,
      },
    },
  );
}

export function homePage(chrome: Chrome, data: {
  csrf: string;
  taskCount: number;
  repo: string | null;
  building: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null }[];
  runners: Runner[];
  worktrees: WorktreeRow[];
  episode: { id: number; startedAt: string; endedAt: string | null; ticks: number; built: number; broke: number } | null;
  summary: ReturnType<typeof tally<Run & { taskId: string }>>;
  decisions: (Decision & { taskId: string })[];
  incidents: (Incident & { taskId: string })[];
  stranded: { id: string; blockedBy: string[] }[];
  gaps: Gap[] | null;
  outboxPending: number;
  settings: boolean;
  now: Date;
}): Screen {
  const { summary } = data;
  // The night's harvest is the page's reason to exist — strong figures in a
  // sentence, colored by what they mean, never a metric-card grid.
  const ledger =
    `<p class="ledger"><span class="good"><b>${summary.built.length}</b> built</span> · ` +
    `<span${summary.failed.length > 0 ? ' class="bad"' : ""}><b>${summary.failed.length}</b> failed</span> · ` +
    `<b>${summary.refused.length}</b> refused` +
    (summary.cutDown.length > 0 ? ` · <span class="bad"><b>${summary.cutDown.length}</b> cut down mid-flight</span>` : "") +
    `</p>`;

  const decide =
    data.decisions.length === 0
      ? `<p class="meta">Nothing waits on you. No questions came up.</p>`
      : data.decisions
          .map(
            decision =>
              `<a class="decide-card" href="/d/${decision.id}">` +
              `<p class="q">${escape(decision.question)}</p>` +
              `<span class="mono meta">${escape(decision.taskId)}</span>` +
              `${isOverdue(decision, data.now) ? ` <span class="badge badge-overdue">Overdue</span>` : ""}` +
              `</a>`,
          )
          .join("\n");

  const incidents =
    data.incidents.length === 0
      ? ""
      : `<h2>Incidents</h2><p class="hint">builds that stopped and need a person — resolve here, or open the task to retry it</p>` +
        data.incidents
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> — ${escape(incidentWords(one.kind))}` +
              `<span class="right"><form method="post" action="/i/${one.id}/resolve" class="inline">` +
              `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
              `<button type="submit">Resolve</button></form></span></p>`,
          )
          .join("\n");

  const stranded =
    data.stranded.length === 0
      ? ""
      : `<h2>Tasks waiting on failed work</h2><p class="hint">open a task and choose whether to try the failed work again, wait for something else, or continue without it</p>` +
        data.stranded
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.id)}">${escape(one.id)}</a> waits on ${one.blockedBy
                .map(blocker => `<a href="${taskHref(blocker)}">${escape(blocker)}</a>`)
                .join(", ")} <span class="right meta">choose what happens →</span></p>`,
          )
          .join("\n");

  const gaps =
    data.gaps === null
      ? ""
      : data.gaps.length === 0
        ? ""
        : `<h2>Missing requirements</h2><p class="hint">tools or credentials builds need — checked before any money is spent</p>` +
          data.gaps
            .map(gap => `<p class="row"><a href="/caps">${escape(gap.key)}</a> — ${escape(gap.state)}<span class="right meta">how to fix →</span></p>`)
            .join("\n") +
          ``;

  // Live at the fidelity the moment deserves: fast while something builds,
  // gentle when the page is just a briefing. GET-only, so refresh is safe.
  const refresh = data.building.length > 0 ? 10 : 60;

  // BUILDING RIGHT NOW: each live claim as a pulsing card — the one moment
  // an operator actually watches this page, so it re-renders itself.
  const building =
    data.building.length === 0
      ? ""
      : `<h2>Building now</h2><p class="hint">live builds — this page refreshes itself every 10 seconds while anything runs</p><div class="cards">` +
        data.building
          .map(
            claim =>
              `<a class="stat-card" href="${taskHref(claim.taskId)}" style="text-decoration:none">` +
              `<span class="k"><span class="dot dot-ok pulse"></span>${escape(claim.taskId)}</span>` +
              `<span class="v">${escape(claim.runner)} \u00b7 ${Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000))}m elapsed${claim.model === null ? "" : ` \u00b7 ${escape(claim.model)}`}</span></a>`,
          )
          .join("") +
        `</div>`;

  // THE FLEET: runners by heartbeat age, worktrees by lease state, the watch.
  const nowMs = data.now.getTime();
  const runnerCards = data.runners
    .filter(one => one.retiredAt === null)
    .map(one => {
      const age = nowMs - new Date(one.heartbeatAt).getTime();
      const dot = age < 5 * 60_000 ? "dot-ok" : age < 60 * 60_000 ? "dot-warn" : "dot-off";
      const said = age < 5 * 60_000 ? "alive" : age < 60 * 60_000 ? `quiet ${Math.round(age / 60_000)}m` : "not heard from";
      const busy = data.building.filter(claim => claim.runner === one.name).length;
      return (
        `<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${escape(one.name)}</span>` +
        `<span class="v">builder \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building</span></div>`
      );
    });
  const worktreeCards = data.worktrees.map(tree => {
    const leased = tree.leasedAt !== null && tree.releasedAt === null;
    const dot = leased ? "dot-ok" : tree.verified ? "dot-off" : "dot-warn";
    const state = leased ? "building" : tree.verified ? "free" : "needs review";
    const name = tree.path.split("/").pop() ?? tree.path;
    return (
      `<div class="stat-card"><span class="k"><span class="dot ${dot}${leased ? " pulse" : ""}"></span><span class="mono">${escape(name)}</span></span>` +
      `<span class="v">workspace \u00b7 ${escape(tree.branch)} \u00b7 ${state}</span></div>`
    );
  });
  const watchCard =
    data.episode === null
      ? ""
      : `<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>Toolroll</span>` +
        `<span class="v">${
          data.episode.endedAt === null
            ? `running since ${whenTime(data.episode.startedAt)}`
            : `last window: ${data.episode.built} built, ${data.episode.broke} broke \u00b7 ended ${whenTime(data.episode.endedAt)}`
        }</span></div>`;
  const fleetCards = [...runnerCards, watchCard, ...worktreeCards].filter(one => one !== "");
  const fleet =
    fleetCards.length === 0
      ? `<h2>System status</h2><p class="hint">No builder is connected yet. On the machine where the project lives, open that folder and run <code>toolroll up</code>.</p>`
      : `<h2>System status</h2><p class="hint">builders execute tasks in isolated temporary copies of each project</p><div class="cards">${fleetCards.join("")}</div>`;

  const startHere =
    data.taskCount === 0
      ? [
          `<div class="card">`,
          `<p><strong>Nothing is queued yet — here is the whole loop:</strong></p>`,
          `<p>1. <a href="/tasks">Add a task</a> — plain words for work you want done${data.repo === null ? "" : ` in <span class="mono">${escape(data.repo)}</span>`}.</p>`,
          `<p>2. Open it and write its scope — the goal, and what it must not become. Approve exactly that.</p>`,
          `<p>3. Keep Toolroll running on the builder machine. Approved tasks build unattended, each on its own branch.</p>`,
          `<p class="meta">When an agent is unsure it stops and asks — those questions land here, under \u201cwaiting on you\u201d.</p>`,
          `</div>`,
        ].join("\n")
      : "";

  return screen("activity", [
    `<h1>Activity</h1>`,
    buildsViews("activity"),
    data.repo === null
      ? ""
      : `<p class="meta"><strong>${escape(projectName(data.repo))}</strong> — the last 24 hours, honestly labeled: a rolling window, whatever your hours are</p>`,
    startHere,
    ledger,
    `<p class="meta">Spend: ${escape(consoleSpend(summary))}</p>`,
    data.outboxPending > 0 ? `<p class="meta">Notifications: ${data.outboxPending} pending delivery</p>` : "",
    building,
    `<h2>Needs your decision</h2><p class="hint">an agent stopped mid-build to ask — nothing proceeds until you answer</p>`,
    decide,
    incidents,
    stranded,
    gaps,
    fleet,
  ].join("\n"), { chrome, refreshSeconds: refresh });
}

export type TaskComposerPrefill = { title: string; goal: string; not: string; touches: string; acceptance: string; values?: URLSearchParams };

/** The one front door for new work. The common path is one prompt and one
 * button; the detailed contract remains available in-place for templates,
 * experts, and the rare task that should skip repository-aware planning. */
/** Where new work goes when no project is open: a choice from the projects
 * this person already has, never a typed path; a new project is one link
 * away. Same-named checkouts show their parent folder to tell them apart. */
export function projectPickerHtml(projects: { path: string; name: string }[], chosen: string): string {
  if (projects.length === 0) {
    return `<label class="task-repo">Project folder <span class="meta">— no project is open, so the task must say where it belongs</span><input type="text" name="repo" value="${escape(chosen)}" required placeholder="/path/to/repository"></label>` +
      `<p class="meta task-repo-add">No projects yet. <a href="/projects?return=%2Ftasks%2Fnew">Add a project</a> to pick it here next time.</p>`;
  }
  const counts = new Map<string, number>();
  for (const one of projects) counts.set(one.name, (counts.get(one.name) ?? 0) + 1);
  const label = (one: { path: string; name: string }): string => {
    if ((counts.get(one.name) ?? 0) < 2) return one.name;
    const parent = one.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? one.path;
    return `${one.name} (${parent})`;
  };
  const selected = projects.some(one => one.path === chosen) ? chosen : projects[0]!.path;
  return `<label class="task-repo">Project<select name="repo" required>` +
    projects.map(one => `<option value="${escape(one.path)}" title="${escape(one.path)}"${one.path === selected ? " selected" : ""}>${escape(label(one))}</option>`).join("") +
    `</select></label><p class="meta task-repo-add"><a href="/projects?return=%2Ftasks%2Fnew">Add a project</a></p>`;
}

export function taskComposerHtml(data: {
  csrf: string;
  project: string | null;
  projectRevision?: number;
  prefill?: TaskComposerPrefill | null;
  candidates?: { id: string; title: string }[];
  permissionDefault: UnattendedPermissionMode;
  qualityDefault: QualityMode;
  /** Projects this person may place work in, most recently opened first. */
  projects?: { path: string; name: string }[];
}): string {
  const prefill = data.prefill ?? null;
  const values = prefill?.values;
  const after = values?.get("after") ?? "";
  const candidates = data.candidates ?? (after === "" ? [] : [{ id: after, title: after }]);
  const projectLabel = data.project === null ? "repository required" : projectName(data.project);
  const showPicker = data.project === null || (data.projects !== undefined && data.projects.length > 1);
  return [
    `<form method="post" action="/tasks/add" class="card task-composer">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    data.projectRevision === undefined && values?.get("projectRevision") == null
      ? ""
      : `<input type="hidden" name="projectRevision" value="${escape(String(data.projectRevision ?? values?.get("projectRevision") ?? ""))}">`,
    `<input type="hidden" name="planning-policy" value="choice">`,
    prefill === null || values !== undefined
      ? ""
      : `<p class="meta" style="margin:.35rem .75rem .15rem">pre-filled from a template. Change anything; it still waits for your approval.</p>`,
    `<label class="task-prompt"><span class="visually-hidden">What should get done?</span>` +
      `<textarea name="title" rows="4" maxlength="200" required autofocus placeholder="Describe the outcome you want. The planner will inspect the repository and work out the implementation details.">${prefill === null ? "" : escape(prefill.title)}</textarea></label>`,
    // The project is always a visible, changeable choice when the page knows
    // the person's projects; the open project is simply preselected.
    showPicker ? projectPickerHtml(data.projects ?? [], values?.get("repo") ?? data.project ?? "") : "",
    `<div class="task-composer-footer">`,
    `<div class="task-context">` +
      (showPicker || data.project === null ? "" : `<span class="task-context-chip" title="${escape(data.project)}">${escape(projectLabel)}</span>`) +
      `<span class="task-context-chip">planner inspects first</span>` +
      `</div>`,
    `<label class="task-quality"><span class="visually-hidden">quality mode</span><select name="quality-mode" aria-label="quality mode">` +
      `<option value="default"${(values?.get("quality-mode") ?? data.qualityDefault) === "default" ? " selected" : ""}>Default quality</option>` +
      `<option value="strict"${(values?.get("quality-mode") ?? data.qualityDefault) === "strict" ? " selected" : ""}>Strict / release</option>` +
      `</select></label>`,
    `<button type="submit" class="task-submit">${prefill === null ? "Plan task" : "Continue"} →</button>`,
    `</div>`,
    `<details class="task-options"${prefill === null ? "" : " open"}>`,
    `<summary><span>Edit details</span><small>optional · defaults are remembered</small></summary>`,
    `<div class="task-options-grid">`,
    `<label class="wide">Goal <span class="meta">— provide upfront for automatic approval of an unchanged plan</span>` +
      `<textarea name="goal" rows="3" placeholder="What success looks like">${prefill === null ? "" : escape(prefill.goal)}</textarea></label>`,
    `<label class="wide">Acceptance <span class="meta">— required with a goal; one per line: <code>statement | evidence,kinds | how</code></span>` +
      `<textarea name="acceptance" rows="3" placeholder="Requests over the limit return 429 | check">${prefill === null ? "" : escape(prefill.acceptance)}</textarea></label>`,
    `<label>Not this <span class="meta">— optional boundary</span><input type="text" name="not" value="${prefill === null ? "" : escape(prefill.not)}"></label>`,
    `<label>Likely touches <span class="meta">— paths, comma-separated</span><input type="text" name="touches" value="${prefill === null ? "" : escape(prefill.touches)}"></label>`,
    `<label class="wide task-check"><input type="checkbox" name="plan-first" value="1"${values === undefined || values.get("plan-first") === "1" ? " checked" : ""}><span><strong>Let the planner inspect first</strong><small class="meta">Recommended. It drafts the goal, acceptance criteria, and implementation approach, and asks only when a missing answer materially changes the work.</small></span></label>`,
    `<label class="wide task-check"><input type="checkbox" name="scout" value="1"${values?.get("scout") === "1" ? " checked" : ""}><span><strong>Research only</strong><small class="meta">Deliver a read-only report instead of changing the repository.</small></span></label>`,
    `<label>Task id <span class="meta">— optional</span><input type="text" name="id" value="${escape(values?.get("id") ?? "")}" placeholder="made from the request"></label>`,
    candidates.length === 0
      ? ""
      : `<label>Starts after <span class="meta">— optional</span><select name="after"><option value="">right away</option>` +
        candidates.map(one => `<option value="${escape(one.id)}"${one.id === after ? " selected" : ""}>${escape(one.id)} — ${escape(one.title)}</option>`).join("") +
        `</select></label>`,
    `<fieldset class="permission-field"><legend>Agent permissions</legend>${permissionModeChoices("permission-mode", values?.get("permission-mode") === "bypassPermissions" ? "bypassPermissions" : values?.get("permission-mode") === "auto" ? "auto" : data.permissionDefault)}` +
      `<p class="meta permission-note">Inherited from Settings. You can still change it on the proposed scope before approval.</p></fieldset>`,
    `</div>`,
    `</details>`,
    `</form>`,
  ].join("\n");
}

export type WorkRow = WorkFacts & { assignment?: AssignmentSnapshot | null; assignmentProblem?: boolean; executionId?: string; familyNotice?: string | null; status: WorkStatus; resultRunId: number | null };

export function publicationFactsOf(publication: Publication | null): PublicationFacts {
  return publication === null
    ? null
    : { state: publication.state, prNumber: publication.prNumber, prUrl: publication.prUrl, remoteState: publication.remoteState, lastCheckState: publication.lastCheckState };
}

/** Where a status's next act lives, for a row that links out. */
export function statusActionHref(status: DisplayStatus, taskId: string, runId: number | null, prUrl: string | null, repo?: string | null): string | null {
  if (status.action === null) return null;
  switch (status.action.kind) {
    case "open-result": return runId === null ? taskHref(taskId) : `/r/${runId}`;
    case "open-review": return repo === undefined ? reviewHref(taskId) : reviewHref(taskId, runId);
    case "open-run": return runId === null ? taskHref(taskId) : `/r/${runId}`;
    case "open-pr": return safePrUrl(prUrl) ?? (repo === undefined ? reviewHref(taskId) : reviewHref(taskId, runId));
    case "open-task":
    default: return taskHref(taskId);
  }
}

/** The one status line every surface renders: a dot in the tone, the
 * label, and the `data-work-status` token tests and CSS key off. */
/** A not-yet-finished task's shared headline from its dispatch diagnosis (task-status.ts). */
export function dispatchHeadline(d: DispatchDiagnosis): string {
  const read = stageOfDispatch(d);
  return taskStatusOf({ stage: read.stage, ...(read.need === undefined ? {} : { need: read.need }) }).headline;
}

export function statusLineHtml(status: DisplayStatus, extra = ""): string {
  return `<span class="status-line" data-work-status="${escape(status.token)}" data-tone="${escape(status.tone)}"><i class="status-dot" aria-hidden="true"></i><span class="status-label">${escape(status.label)}</span>${extra}</span>`;
}

export function workDiagnosticsHtml(diagnostics: WorkStatus["diagnostics"]): string {
  return (diagnostics ?? []).map(one => `<p class="work-detail" data-work-diagnostic="${escape(one.token)}"><strong>${escape(one.label)}</strong> · ${escape(one.detail)}</p>`).join("");
}

export const TASK_GROUP_LABEL: Readonly<Record<WorkIndexGroup, string>> = { ...ASK_LABEL, building: 'Building', rest: 'Recent' };

export function workPage(
  chrome: Chrome,
  data: { view: WorkView; projectFilter?: string; work: WorkIndexPage; previous: boolean; multiProject: boolean; now: Date; limits?: BrowserLimits | null },
): Screen {
  const href = (view: WorkView, cursor?: string): string => {
    const query = new URLSearchParams();
    if (data.projectFilter !== undefined) query.set('project', data.projectFilter);
    if (view !== 'all') query.set('view', view);
    if (cursor !== undefined) query.set('cursor', cursor);
    return `/work${query.size ? `?${query}` : ''}`;
  };
  const tabs = `<nav class="work-views" aria-label="Task views">` + WORK_VIEWS.map(one =>
    `<a href="${escape(href(one.key))}"${one.key === data.view ? ' class="active" aria-current="page"' : ''}>${one.label}<span class="count">${data.work.totals[one.key]}</span></a>`
  ).join('') + `</nav>`;
  const rowHtml = (row: WorkIndexItem): string => {
    const target = row.primaryAction?.target;
    const actionHref = row.primaryAction?.code === 'open-result' && target?.runId != null
      ? `/review?result=${encodeURIComponent(target.taskId)}&run=${target.runId}`
      : browserWorkActionHref(row);
    const action = actionHref === null || row.primaryAction === null ? '' : `<a class="work-action" data-primary-action href="${escape(actionHref)}">${escape(row.primaryAction.label)} →</a>`;
    const project = data.multiProject || row.repo === null ? `<span class="project-label">${row.repo === null ? 'Unplaced' : escape(projectName(row.repo))}</span>` : '';
    return `<article class="work-row" data-task="${escape(row.rootId)}" data-work-status="${escape(row.status.token)}" data-work-views="${row.status.views.join(' ')}">` +
      `<div class="work-row-main"><a class="work-title" href="${taskHref(row.rootId)}">${escape(row.title)}</a>` +
      `<p class="work-meta">${project}<span>${escape(relativeAge(row.updatedAt, data.now))}</span></p></div>` +
      `<div class="work-row-status">${statusLineHtml(row.status)}${action}` +
      (row.familyProblem === null ? '' : `<p class="problem">${escape(row.familyProblem)}</p>`) +
      (row.status.views.includes('needs-you') && !['write-scope', 'approve-scope'].includes(row.primaryAction?.code ?? '') && row.status.detail !== row.status.label && row.status.detail !== row.familyProblem ? `<p class="work-detail">${escape(row.status.detail)}</p>` : '') +
      workDiagnosticsHtml(row.status.diagnostics) + `</div></article>`;
  };
  const current = WORK_VIEWS.find(one => one.key === data.view)!;
  const list = data.work.items.length === 0
    ? `<div class="work-empty" data-work-empty="${data.view}"><p>${escape(data.previous ? 'There are no more tasks on this page.' : current.empty)}</p>` +
      (data.view === 'all' && !data.previous ? `<p><a class="button-link" href="${chrome.chat === true ? '/chat' : '/tasks/new'}">${chrome.chat === true ? 'Start in chat' : 'Add a task'}</a></p>` : `<a href="${escape(href('all'))}">See all tasks →</a>`) + `</div>`
    : `<div class="work-list">${data.work.items.map(rowHtml).join('')}</div>`;
  const pages = !data.previous && data.work.nextCursor === null ? '' : `<nav class="row work-pagination" aria-label="Task pages">` +
    (data.previous ? `<a class="button-link" href="${escape(href(data.view))}">First page</a>` : '') +
    (data.work.nextCursor === null ? '' : `<a class="button-link" rel="next" href="${escape(href(data.view, data.work.nextCursor))}">Next page</a>`) + `</nav>`;
  const tools = `<details class="work-tools"><summary>Work tools${CHEVRON_ICON}</summary><nav class="work-tools-menu">` +
    [['/inbox', 'Inbox'], ['/board', 'Board'], ['/board?view=order', 'Order'], ['/tasks', 'Task list'], ['/recipes', 'Recipes'], ...(chrome.projectScoped ? [] : [['/workbench', 'Portfolio']]), ['/ledger', 'Action ledger']]
      .map(([path, label]) => `<a href="${path}">${label}</a>`).join('') + `</nav></details>`;
  const toolLinks = [['/inbox', 'Inbox'], ['/board', 'Board'], ['/board?view=order', 'Order'], ['/tasks', 'Task list'], ['/recipes', 'Recipes'], ...(chrome.projectScoped ? [] : [['/workbench', 'Portfolio']])];
  const view: BrowserTasksView = {
    kind: 'tasks',
    tabs: WORK_VIEWS.map(one => ({ label: one.label, href: href(one.key), count: data.work.totals[one.key], active: one.key === data.view })),
    needsYou: data.work.totals['needs-you'],
    groups: data.view !== 'all' && data.view !== 'needs-you' ? null
      : ([...ASKS, ...(data.view === 'all' ? ['building', 'rest'] as const : [])] as WorkIndexGroup[])
        .map(key => ({ key, label: TASK_GROUP_LABEL[key], count: data.work.groups[key] })).filter(one => one.count > 0),
    rows: data.work.items.map(row => {
      const target = row.primaryAction?.target;
      const actionHref = row.primaryAction?.code === 'open-result' && target?.runId != null
        ? `/review?result=${encodeURIComponent(target.taskId)}&run=${target.runId}`
        : browserWorkActionHref(row);
      const needsYouDetail = (row.status.views.includes('needs-you') || row.status.label === 'Failed') && !['write-scope', 'approve-scope'].includes(row.primaryAction?.code ?? '') && row.status.label !== 'Ready for review' && row.status.detail !== row.status.label && row.status.detail !== row.familyProblem;
      return {
        id: row.rootId, title: row.title, href: taskHref(row.rootId),
        project: data.multiProject || row.repo === null ? (row.repo === null ? 'Unplaced' : projectName(row.repo)) : null,
        age: relativeAge(row.updatedAt, data.now),
        status: { label: row.status.label, tone: row.status.tone, token: row.status.token },
        ask: row.ask, chip: row.chip, group: row.ask ?? (row.status.rank === 1 ? 'building' : 'rest'),
        action: actionHref === null || row.primaryAction === null ? null : { label: row.primaryAction.label, href: actionHref },
        detail: needsYouDetail ? row.status.detail : (row as { progress?: string }).progress ?? null,
        problem: row.familyProblem,
        notes: (row.status.diagnostics ?? []).map(one => `${one.label} · ${one.detail}`),
      };
    }),
    empty: data.work.items.length > 0 ? null : {
      text: data.previous ? 'There are no more tasks on this page.' : current.empty,
      action: data.view === 'all' && !data.previous ? { label: chrome.chat === true ? 'Start in chat' : 'Add a task', href: chrome.chat === true ? '/chat' : '/tasks/new' } : { label: 'See all tasks', href: href('all') },
    },
    pages: { first: data.previous ? href(data.view) : null, next: data.work.nextCursor === null ? null : href(data.view, data.work.nextCursor) },
    tools: toolLinks.map(([path, label]) => ({ label: label!, href: path! })),
    newTask: { label: 'New task', href: '/tasks/new' },
    limits: data.limits ?? null,
  };
  return screen('work', `<div class="work-head"><h1>Tasks</h1>${tools}</div>${limitsHtml(data.limits ?? null)}${tabs}${list}${pages}`, { chrome, workspace: { view } });
}

export function tasksPage(
  chrome: Chrome,
  tasks: Task[],
  state: TaskState | null,
  csrf: string,
  problem: string | null,
  repo: string | null = null,
  prefill: TaskComposerPrefill | null = null,
  permissionDefault: UnattendedPermissionMode = "auto",
  qualityDefault: QualityMode = "default",
  replaced: ReadonlyMap<string, string> = new Map(),
): Screen {
  const filters = TASK_STATES.map(
    one => (one === state ? `<strong>${one}</strong>` : `<a href="/tasks?state=${one}">${one}</a>`),
  ).join(" · ");
  const rows =
    tasks.length === 0
      ? `<p class="meta">${
          state === null
            ? "The queue is empty \u2014 add the first task below. It builds once you approve its scope."
            : `Nothing is ${escape(state)}.`
        }</p>`
      : tasks
          .map(
            task =>
              `<a class="row" href="${taskHref(task.id)}"><span class="mono">${escape(task.id)}</span> ` +
              `${escape(task.title)} <span class="right badge badge-${escape(task.state)}">${escape(task.state === "cancelled" && replaced.has(task.id) ? `replaced by ${replaced.get(task.id)}` : task.state)}</span></a>`,
          )
          .join("\n");
  return screen("tasks", [
    "<h1>Tasks</h1>",
    `<p class="meta">Work you want done${repo === null ? "" : ` in <strong>${escape(projectName(repo))}</strong>`} \u2014 a task builds unattended only after its scope is approved; open one to write or approve its scope</p>`,
    repo === null ? "" : `<p class="meta path-words"><span class="mono">${escape(repo)}</span></p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<p class="meta">Filter: <a href="/tasks">all</a> · ${filters}</p>`,
    rows,
    `<h2>Add a task</h2>`,
    taskComposerHtml({ csrf, project: repo, prefill, permissionDefault, qualityDefault }),
  ].join("\n"), { chrome });
}


export function browsePage(chrome: Chrome, data: {
  at: string;
  root: string;
  roots: string[];
  parent: string | null;
  entries: { name: string; path: string; git: boolean }[];
  csrf: string;
}): Screen {
  const crumb = data.at === data.root ? projectName(data.root) : `${projectName(data.root)}${data.at.slice(data.root.length)}`;
  const openForm = (path: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<button type="submit">Open</button>`,
      `</form>`,
    ].join("");
  return screen("projects", [
    `<h1>Choose a folder</h1>`,
    `<p class="meta">git repositories float to the top and can be opened; anything else can be entered — only folders under ${
      data.roots.length === 1 ? `<span class="mono">${escape(projectName(data.root))}</span>` : "the configured roots"
    } are visible here</p>`,
    data.roots.length > 1
      ? `<p class="meta">Roots: ${data.roots.map(one => `<a href="/projects/browse?at=${encodeURIComponent(one)}" class="mono">${escape(projectName(one))}</a>`).join(" · ")}</p>`
      : "",
    `<p class="mono meta">${escape(crumb)}</p>`,
    data.parent === null
      ? ""
      : `<p class="row"><a href="/projects/browse?at=${encodeURIComponent(data.parent)}">\u2190 up one level</a></p>`,
    data.entries.length === 0
      ? `<p class="meta">No folders here</p>`
      : data.entries
          .map(
            one =>
              `<p class="row">` +
              `<a href="/projects/browse?at=${encodeURIComponent(one.path)}"><strong>${escape(one.name)}</strong></a>` +
              `${one.git ? ` <span class="badge badge-done">git</span>` : ""}` +
              `<span class="right">${one.git ? openForm(one.path) : `<a class="meta" href="/projects/browse?at=${encodeURIComponent(one.path)}">enter \u2192</a>`}</span>` +
              `</p>`,
          )
          .join("\n"),
    `<p class="meta"><a href="/projects">\u2190 back to projects</a></p>`,
  ].join("\n"), { chrome });
}


/** The compact completed row shared by both halves of the control room. */
export type WorkbenchDone = { taskId: string; title: string; outcome: string | null; repo: string | null };

/**
 * The control-room rail (attended A1): every state that matters while a
 * person supervises, ordered by intervention cost. The project chip is
 * deliberately repeated on every row — a title is not a workspace, and
 * switching context must never depend on remembering which repo is open.
 */
export function workbenchRail(data: {
  attention: BoardCard[];
  building: BoardCard[];
  waiting: BoardCard[];
  queued: BoardCard[];
  done: WorkbenchDone[];
  selected: string | null;
  saturated: boolean;
}): string {
  const workspace = (repo: string | null): string =>
    `<span class="badge">${repo === null ? "Unplaced" : escape(projectName(repo))}</span>`;
  const row = (card: BoardCard, reason: string): string =>
    `<a class="wb-row${card.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(card.taskId)}"` +
    `${card.taskId === data.selected ? ` aria-current="true"` : ""}>` +
    `<span class="wb-title">${escape(card.title)}</span>` +
    `<span class="wb-meta"><span class="mono meta">${escape(card.taskId)}</span>${workspace(card.repo)}</span>` +
    `<span class="wb-reason">${reason}</span></a>`;
  const group = (title: string, cards: BoardCard[], empty: string, render: (card: BoardCard) => string): string =>
    `<section class="wb-group"><h2>${title} <span class="lane-count">${cards.length}</span></h2>` +
    (cards.length === 0 ? `<p class="meta">${empty}</p>` : cards.slice(0, 100).map(render).join("\n")) +
    `</section>`;
  const parts: string[] = [];
  parts.push(
    `<div class="wb-rail-head"><div><span class="eyebrow">portfolio</span><h2>All projects</h2></div>` +
    `<a href="/projects">manage →</a></div>`,
  );
  parts.push(group("needs you", data.attention, "Nothing needs your input.", card => row(card, escape(card.reason))));
  parts.push(group("in progress", data.building, "No agent is working right now.", card => {
    const claim = card.claim;
    const phase = claim?.phase == null ? "working" : phaseWords(claim.phase);
    return row(
      card,
      `${escape(phase)}${claim?.provider ? ` · ${escape(claim.provider)}` : ""}` +
        `${claim?.claimedAt ? ` · <time data-elapsed-since="${escape(claim.claimedAt)}"></time>` : ""}`,
    );
  }));
  parts.push(group("blocked & waiting", data.waiting, "Nothing is blocked or paused.", card => row(card, escape(card.reason))));
  parts.push(group("up next", data.queued, "The ready queue is empty.", card => row(
    card,
    `${escape(card.reason)}${card.assignedRunner === null ? "" : ` · reserved for ${escape(card.assignedRunner)}`}`,
  )));
  if (data.done.length > 0) {
    parts.push(`<section class="wb-group"><h2>Just finished <span class="lane-count">${data.done.length}</span></h2>`);
    parts.push(
      data.done
        .map(
          one =>
            `<a class="wb-row${one.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(one.taskId)}">` +
            `<span class="wb-title">${escape(one.title)}</span>` +
            `<span class="wb-meta"><span class="mono meta">${escape(one.taskId)}</span>${workspace(one.repo)} ` +
            `<span class="badge badge-${one.outcome === "built" || one.outcome === "no-change" ? "done" : "failed"}">${escape(sentenceCase(one.outcome ?? "?"))}</span></span></a>`,
        )
        .join("\n"),
    );
    parts.push(`</section>`);
  }
  if (data.saturated) parts.push(`<p class="meta">More exists — this rail is capped; the <a href="/board?scope=all">board</a> holds the rest</p>`);
  return parts.join("\n");
}

/** The project chip every all-scope row wears: null is UNPLACED, said so. */
export function projectChip(repo: string | null | undefined): string {
  return repo === null || repo === undefined
    ? ` <span class="badge">Unplaced</span>`
    : ` <span class="badge">${escape(projectName(repo))}</span>`;
}

/**
 * The decision card everywhere a person may ANSWER (portfolio, the
 * selected-project inbox; the task page joins in slice 3): a reversible
 * option answers with one tap on the card, labeled with its own words —
 * never a letter; an irreversible option is a LINK to the decision page,
 * where the server-side confirm=yes guard lives. The roll-up inbox keeps
 * its links-only cards and never renders this partial. The recommended
 * option wears a neutral badge — recommendation is not urgency, and magenta
 * stays on the card's outline.
 */
export function decisionAnswerCard(
  decision: Decision & { taskId: string; repo?: string | null },
  csrf: string,
  now: Date,
  chip: boolean,
  returnTo: string | null = null,
): string {
  const returnField = returnTo === null ? "" : `<input type="hidden" name="return" value="${escape(returnTo)}">`;
  const options = decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation
        ? ` <span class="badge">Recommended</span>`
        : "";
      if (!option.reversible) {
        return (
          `<p class="decide-option"><a href="/d/${decision.id}${returnTo === null ? "" : `?return=${encodeURIComponent(returnTo)}`}">${escape(option.label)}</a>` +
          ` <span class="badge badge-overdue">Irreversible</span>${recommended}` +
          ` <span class="meta">${escape(option.consequence)}</span></p>`
        );
      }
      return (
        `<form class="decide-option decide-inline" method="post" action="/d/${decision.id}/answer">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        returnField +
        `<input type="hidden" name="choice" value="${escape(option.id)}">` +
        `<button type="submit">${escape(option.label)}</button>${recommended}` +
        ` <span class="meta">${escape(option.consequence)} · reversible</span></form>`
      );
    })
    .join("\n");
  return (
    `<div class="decide-card" data-decision-id="${decision.id}">` +
    `<p class="q">${escape(decision.question)}</p>` +
    `<details class="decision-context"><summary>Context</summary><p class="meta">${escape(decision.recap)}</p><span class="meta mono">${escape(decision.taskId)}</span></details>` +
    `<p class="meta">${chip ? projectChip(decision.repo) : ""}` +
    `${isOverdue(decision, now) ? ` <span class="badge badge-overdue">Overdue</span>` : ""}` +
    ` <a href="/d/${decision.id}${returnTo === null ? "" : `?return=${encodeURIComponent(returnTo)}`}">View details →</a></p>` +
    `<div class="decide-options">${options}</div></div>`
  );
}

/**
 * The inline-answer enhancement (portfolio arc §2): submits a reversible
 * option's form as the urlencoded POST the forms-only gate expects, follows
 * the redirect, and — because an answered decision leaves the open list —
 * replaces ONLY that card with the answered receipt parsed from the
 * decision page's own rendering, or removes the card. Anything unexpected
 * (auth, a page that is not the decision's) navigates instead of inserting.
 * Nothing else on the page is touched: typed input elsewhere survives.
 */
export function decisionAnswerScript(): string {
  return (
    `document.addEventListener("submit",function(e){` +
    `var f=e.target;if(!f||!f.classList||!f.classList.contains("decide-inline"))return;` +
    `e.preventDefault();` +
    `var card=f.closest("[data-decision-id]");` +
    `var page=f.action.replace(/\\/answer$/,"");` +
    `fetch(f.action,{method:"POST",credentials:"same-origin",` +
    `headers:{"content-type":"application/x-www-form-urlencoded"},` +
    `body:new URLSearchParams(new FormData(f)).toString()})` +
    `.then(function(r){return r.text().then(function(t){return{r:r,t:t}})})` +
    `.then(function(x){` +
    `var landed="";try{landed=new URL(x.r.url).pathname}catch(err){}` +
    `if(!x.r.ok||landed!==new URL(page,location.href).pathname){location.href=page;return}` +
    `var doc=new DOMParser().parseFromString(x.t,"text/html");` +
    `var receipt=doc.querySelector(".answered");` +
    `if(!card){location.href=page;return}` +
    `if(receipt){card.replaceChildren(document.importNode(receipt,true))}else{card.remove()}` +
    `},function(){location.href=page})});`
  );
}

/**
 * The portfolio overview (arc slice 1a): what waits on you, what the last
 * 24 hours of run starts amounted to, what is running, and the terminal-run
 * ledger — all of it across every admitted project, a project chip on every
 * row. The caller has already applied admission and per-row visibility.
 */
export function portfolioOverview(data: {
  attention: BoardCard[];
  building: BoardCard[];
  waiting: BoardCard[];
  queued: BoardCard[];
  done: WorkbenchDone[];
  saturated: boolean;
  decisions: (Decision & { taskId: string; repo?: string | null })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string; repo?: string | null; /** v48 authority repair: the closed consent door's title, or null when a yes could bind. */ closed?: string | null }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo?: string | null }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string; repo?: string | null; blockerRepo?: string | null }[];
  gaps: Gap[];
  gapsProject: string | null;
  runs24: (Run & { taskId: string })[];
  live: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null; repo: string | null }[];
  ledger: {
    runId: number; taskId: string; title: string; repo: string | null; outcome: string; role: string;
    provider: string | null; model: string | null; startedAt: string; ranMinutes: number | null;
    costUsd: number | null; authMode: "subscription" | "api-key" | null; prNumber: number | null; prUrl: string | null;
  }[];
  csrf: string;
  now: Date;
}): string {
  type Pulse = { repo: string | null; attention: number; building: number; waiting: number; queued: number; done: number };
  const pulses = new Map<string, Pulse>();
  const pulseFor = (repo: string | null): Pulse => {
    const key = repo ?? "";
    const existing = pulses.get(key);
    if (existing !== undefined) return existing;
    const made = { repo, attention: 0, building: 0, waiting: 0, queued: 0, done: 0 };
    pulses.set(key, made);
    return made;
  };
  for (const card of [...data.attention, ...data.building, ...data.waiting, ...data.queued]) {
    pulseFor(card.repo)[card.lane] += 1;
  }
  for (const one of data.done) pulseFor(one.repo).done += 1;
  const pulseRows = [...pulses.values()].sort((a, b) =>
    b.attention - a.attention || b.building - a.building || b.waiting - a.waiting ||
    (a.repo === null ? 1 : b.repo === null ? -1 : projectName(a.repo).localeCompare(projectName(b.repo))),
  );
  const workspace = (repo: string | null): string => repo === null ? "Unplaced work" : projectName(repo);
  // A workspace card (board pass): the repo's name and one status word,
  // its four counts, a bar of the same counts in proportion, and — for a
  // real repo, with a session token — the one tap to its own board. The
  // status word is the loudest true thing: needs you beats building beats
  // waiting beats queued; a repo with nothing in flight is idle.
  const statusOf = (one: (typeof pulseRows)[number]): { word: string; cls: string } =>
    one.attention > 0
      ? { word: "needs you", cls: "badge-open" }
      : one.building > 0
        ? { word: "building", cls: "badge-running" }
        : one.waiting > 0
          ? { word: "waiting", cls: "" }
          : one.queued > 0
            ? { word: "queued", cls: "" }
            : { word: "idle", cls: "" };
  const workspaceRows = pulseRows.map(one => {
    const status = statusOf(one);
    const total = one.attention + one.building + one.waiting + one.queued;
    const seg = (cls: string, count: number): string =>
      count === 0 ? "" : `<span class="seg ${cls}" style="flex-grow:${count}"></span>`;
    const boardForm =
      one.repo === null || data.csrf === ""
        ? ""
        : `<form method="post" action="/projects/open" class="inline">` +
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
          `<input type="hidden" name="path" value="${escape(one.repo)}">` +
          `<input type="hidden" name="return" value="/board">` +
          `<button type="submit">Board →</button></form>`;
    return (
      `<div class="workspace-card${one.attention > 0 ? " hot" : ""}">` +
      `<div class="workspace-head"><span class="workspace-name">${escape(workspace(one.repo))}</span>` +
      `<span class="badge ${status.cls}">${sentenceCase(status.word)}</span>${boardForm}${one.repo === null || data.csrf === "" ? "" : `<form method="post" action="/projects/open" class="inline">${hiddenFields({ csrf: data.csrf, path: one.repo, return: "/control" })}<button>Set up →</button></form>`}</div>` +
      `<div class="workspace-stats">` +
      `<span class="pulse-stat${one.attention > 0 ? " hot" : ""}"><b>${one.attention}</b> need you</span>` +
      `<span class="pulse-stat"><b>${one.building}</b> live</span>` +
      `<span class="pulse-stat"><b>${one.waiting}</b> waiting</span>` +
      `<span class="pulse-stat"><b>${one.queued}</b> next</span></div>` +
      `<div class="workspace-bar${total === 0 ? " empty" : ""}" aria-hidden="true">` +
      seg("attention", one.attention) + seg("building", one.building) + seg("waiting", one.waiting) + seg("queued", one.queued) +
      `</div></div>`
    );
  }).join("\n");

  // ---- waits on you: everything a person must resolve, across projects ----
  const waitCount =
    data.decisions.length + data.approvals.length + data.requeueables.length +
    data.cancelledBlockers.length + data.gaps.length;
  const decisionCards = data.decisions.map(one => decisionAnswerCard(one, data.csrf, data.now, true)).join("\n");
  const approvalCards = data.approvals
    .map(
      one =>
        `<a class="decide-card" href="${taskHref(one.taskId)}">` +
        `<p class="q">${escape(one.title)}</p>` +
        `<span class="meta">${escape(one.goal.length > 120 ? one.goal.slice(0, 120) + "…" : one.goal)}</span><br>` +
        `<span class="mono meta">${escape(one.taskId)}</span>${projectChip(one.repo)} <span class="right meta">review and sign →</span>` +
        `</a>`,
    )
    .join("\n");
  const requeueRows = data.requeueables
    .map(
      one =>
        `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> ${escape(one.title)}${projectChip(one.repo)}` +
        `${one.incidentCount > 0 ? ` <span class="badge badge-failed">${one.incidentCount} incident${one.incidentCount > 1 ? "s" : ""}</span>` : ""}` +
        `${one.strikes > 0 ? ` <span class="meta">${one.strikes} failed attempt${one.strikes > 1 ? "s" : ""}</span>` : ""}` +
        `<span class="right meta">open the task to retry →</span></p>`,
    )
    .join("\n");
  const cancelledRows = data.cancelledBlockers
    .map(
      one =>
        `<p class="row"><a href="${taskHref(one.exampleDependent)}">${escape(one.exampleDependent)}</a>${projectChip(one.repo)} ` +
        `<span class="meta">${one.dependentCount > 1 ? `one of ${one.dependentCount} tasks waiting` : "waiting"} for cancelled task ${escape(one.blockerId)}</span>` +
        `<span class="right meta">choose what happens →</span></p>`,
    )
    .join("\n");
  const gapRows = data.gaps
    .map(
      gap =>
        `<p class="row"><a href="/caps">${escape(gap.key)}</a>${data.gapsProject === null ? "" : projectChip(data.gapsProject)} ` +
        `<span class="meta">frees ${gap.unblocks.length} task${gap.unblocks.length > 1 ? "s" : ""}</span>` +
        `<span class="right meta">how to fix →</span></p>`,
    )
    .join("\n");

  // ---- the last 24 hours: runs STARTED in the window, outcomes exhaustive ----
  const groups: [string, number][] = [
    ["built", data.runs24.filter(one => one.outcome === "built").length],
    ["no change", data.runs24.filter(one => one.outcome === "no-change").length],
    ["failed", data.runs24.filter(one => one.outcome === "failed").length],
    ["refused", data.runs24.filter(one => one.outcome === "refused").length],
    ["parked", data.runs24.filter(one => one.outcome === "parked").length],
    ["interrupted", data.runs24.filter(one => one.outcome === "interrupted").length],
    ["unfinished", data.runs24.filter(one => one.outcome === null).length],
  ];
  const outcomeWords = groups.filter(([, count]) => count > 0).map(([word, count]) => `${count} ${word}`).join(" · ");
  const summary = tally(data.runs24);

  // ---- running: current live claims, project chips on ----
  const liveRows = data.live
    .map(
      one =>
        `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a>${projectChip(one.repo)} ` +
        `<span class="badge badge-running">Running</span> ` +
        `<span class="mono meta">${escape(one.runner)}${one.model === null ? "" : ` · ${escape(one.model)}`} · ` +
        `<time data-elapsed-since="${escape(one.claimedAt)}"></time></span></p>`,
    )
    .join("\n");

  // ---- the ledger: terminal runs started in the window, one chip each ----
  const chipClass = (outcome: string): string =>
    outcome === "built" || outcome === "no-change" ? "badge-done" : outcome === "failed" ? "badge-failed" : "";
  const ledgerRows = data.ledger
    .map(
      one =>
        `<p class="row"><a href="/r/${one.runId}">${escape(one.title)}</a>${projectChip(one.repo)} ` +
        `<span class="badge ${chipClass(one.outcome)}">${escape(sentenceCase(one.outcome))}</span> ` +
        `${one.role === "scout" ? `<a class="badge" href="${taskHref(one.taskId)}#report">Report</a> ` : ""}` +
        `<span class="mono meta">${one.provider === null ? "" : escape(one.provider)}${one.model === null ? "" : ` · ${escape(one.model)}`}` +
        `${one.ranMinutes === null ? "" : ` · ${one.ranMinutes}m`}` +
        ` · ${escape(runCostWords({ authMode: one.authMode, costUsd: one.costUsd, tokensIn: null, tokensOut: null }))}` +
        `${(() => {
          if (one.prNumber === null) return "";
          // The URL-sink rule (audit IV-11): only a verified github pull
          // URL earns an anchor; a corrupted row renders as text.
          const safe = safePrUrl(one.prUrl);
          return safe === null ? ` · PR #${one.prNumber}` : ` · <a href="${escape(safe)}">PR #${one.prNumber}</a>`;
        })()}</span></p>`,
    )
    .join("\n");

  return [
    `<div class="control-room-head"><div><h1>Portfolio</h1>` +
      `<p class="meta">Every project and live build in one place</p></div>` +
      `<div class="actions"><a class="badge" href="/tasks/new">+ New task</a><a class="badge" href="/board?scope=all">Full board →</a></div></div>`,
    data.saturated ? `<div class="problem">This overview reached its 200-task display cap; the task list holds the rest.</div>` : "",
    `<h2>Waits on you</h2>`,
    waitCount === 0
      ? `<div class="answered"><strong>Nothing needs you.</strong> <span class="meta">You can leave this open; live state updates in the rail.</span></div>`
      : [
          decisionCards,
          approvalCards,
          requeueRows,
          cancelledRows,
          gapRows,
          `<p class="meta"><a href="/next">clear the queue → one thing at a time</a></p>`,
        ].filter(part => part !== "").join("\n"),
    data.gapsProject === null
      ? `<p class="meta">Requirement gaps are checked one project at a time — open a project to see and fill its gaps · <a href="/projects">open a project</a></p>`
      : "",
    `<h2>Project pulse</h2>`,
    `<p class="hint">one row per repository</p>`,
    pulseRows.length === 0
      ? `<div class="card"><p><strong>No active work yet.</strong></p><p class="meta">Queue a task and its progress will show here across every workspace.</p></div>`
      : `<div class="workspace-pulse">${workspaceRows}</div>`,
    `<h2>The last 24 hours</h2>`,
    `<p class="hint">runs started in the last 24 hours</p>`,
    data.runs24.length === 0
      ? `<p class="meta">No runs started in the window</p>`
      : `<p class="row"><span class="meta">runs started</span> <span class="mono">${data.runs24.length}</span></p>` +
        `<p class="row"><span class="meta">outcomes</span> <span class="mono">${escape(outcomeWords)}</span></p>` +
        `<p class="row"><span class="meta">spend</span> <span class="mono">${escape(spendLine(summary))}</span></p>` +
        // Tokens stand on their own: invocations that reported usage —
        // independent of whether cost was measured (spec §2; spendLine's
        // mixed branch omits them).
        (summary.tokens > 0
          ? `<p class="row"><span class="meta">tokens</span> <span class="mono">${summary.tokens.toLocaleString()}</span></p>`
          : ""),
    `<h2>Running</h2>`,
    data.live.length === 0 ? `<p class="meta">No agent is working right now</p>` : liveRows,
    `<h2>Terminal runs started in the last 24 hours</h2>`,
    data.ledger.length === 0 ? `<p class="meta">None yet</p>` : ledgerRows,
  ].join("\n");
}

export type OnboardCardState =
  | { enabled: false; why: string }
  | { enabled: true; roots: readonly string[]; record: [string, { nameWithOwner: string; rootIndex: number; target: string; diskUsageKib: number | null; large: boolean; mintedAt: number }] | null };

export type ProjectPeek = { waiting: number; queued: number; running: number; doneRecently: number };

/**
 * owner/name from a git remote URL — FULLY ANCHORED https/ssh github.com
 * forms only (ghlist review, finding 2): a foreign host carrying
 * "github.com" in its path, or a non-github host, must never read as a
 * GitHub identity. Everything else is null.
 */
export function githubIdentityOf(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const https = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https !== null) return `${https[1]}/${https[2]}`;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/**
 * The `origin` remote's url from a repository's OWN .git/config. BOUNDED
 * I/O by construction (ghlist review, finding 1): the final component may
 * not be a symlink (O_NOFOLLOW + lstat), must be a REGULAR file under a
 * size cap, and at most 64 KiB are ever read — a sparse monster or a fifo
 * planted as a "config" reads as null, never as a hang. Parsed LINE BY
 * LINE with real section tracking (finding 2): a `[remote "origin"]`
 * embedded inside some other value never opens the section. null when
 * unreadable or origin-less; a worktree-style `.git` FILE (gitdir pointer)
 * reads null too, which is honest — its identity lives elsewhere. The
 * answer is ADVISORY metadata for offering a button: the /projects/open
 * road re-proves path, ceiling, and git-ness before anything mutates, and
 * a config that lies about its origin can only mislabel a repository the
 * operator was already allowed to open.
 */
export function originUrlOf(repoPath: string): string | null {
  const file = join(repoPath, ".git", "config");
  let fd: number | null = null;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const config = buffer.toString("utf8", 0, read);
    let inOrigin = false;
    for (const line of config.split("\n")) {
      if (/^\s*\[/.test(line)) {
        inOrigin = /^\s*\[remote "origin"\]\s*$/.test(line);
        continue;
      }
      if (!inOrigin) continue;
      const url = /^\s*url\s*=\s*(.+)$/.exec(line)?.[1];
      if (url !== undefined) return url.trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** The GitHub listing page: the account's repositories with ONE honest
 * action each. Names, descriptions, and paths are gh/filesystem DATA —
 * escaped at the sink like everything else. */
export function githubReposPage(
  chrome: Chrome,
  data: {
    listed: ListOutcome;
    local: Map<string, string>;
    registered: Set<string>;
    csrf: string;
    cloneReady: boolean;
    openProject: string | null;
  },
): Screen {
  const openForm = (path: string, label: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<button type="submit">${escape(label)}</button>`,
      `</form>`,
    ].join("");
  const cloneForm = (nameWithOwner: string): string =>
    [
      `<form method="post" action="/projects/onboard-preview" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="repo" value="${escape(nameWithOwner)}">`,
      `<input type="hidden" name="root" value="0">`,
      `<button type="submit">Clone here →</button>`,
      `</form>`,
    ].join("");
  const rows =
    !data.listed.ok
      ? `<p class="meta">${escape(data.listed.message)}</p>`
      : data.listed.repos.length === 0
        ? `<p class="meta">The signed-in GitHub account has no repositories to list</p>`
        : data.listed.repos
            .map(repo => {
              const localPath = data.local.get(repo.nameWithOwner.toLowerCase()) ?? null;
              const action =
                localPath !== null && data.openProject === localPath
                  ? `<span class="badge badge-done">Open now</span>`
                  : localPath !== null
                    ? openForm(localPath, data.registered.has(localPath) ? "open →" : "add + open →")
                    : data.cloneReady
                      ? cloneForm(repo.nameWithOwner)
                      : `<span class="meta">choose a projects folder first</span>`;
              return [
                `<div class="card project-card">`,
                `<div class="row"><strong>${escape(repo.nameWithOwner)}</strong>${repo.isPrivate ? ` <span class="badge">Private</span>` : ""}`,
                `<span class="right">${action}</span></div>`,
                localPath === null
                  ? `<p class="meta">Not on this machine yet${/^\d{4}-\d{2}-\d{2}T/.test(repo.updatedAt) ? ` · pushed ${whenTime(repo.updatedAt)}` : ""}</p>`
                  : `<p class="meta mono" style="overflow-wrap:anywhere;margin:.2rem 0">${escape(localPath)}</p>`,
                repo.description === "" ? "" : `<p class="meta">${escape(repo.description)}</p>`,
                `</div>`,
              ].join("\n");
            })
            .join("\n");
  return screen("projects", [
    `<h1>Your GitHub repositories</h1>`,
    `<p class="meta">Repositories available to the GitHub account signed in on this machine — open one you already have, or clone a new one after a quick preview.</p>`,
    rows,
    `<p class="row" style="margin-top:.6rem"><a class="badge" href="/projects">← back to projects</a></p>`,
  ].join("\n"), { chrome });
}

export function projectsPage(
  chrome: Chrome,
  recent: { path: string; name: string; lastOpenedAt: string }[],
  candidates: string[],
  open: string | null,
  csrf: string,
  problem: string | null,
  _unscopedMode: boolean,
  browsable = false,
  onboard: OnboardCardState | null = null,
  peeks: Record<string, ProjectPeek | null> = {},
  returnTo = "/",
  pullRequestsOn?: (path: string) => boolean,
  checkLevelOf?: (path: string) => CheckLevel,
): Screen {
  // The onboarding card (repo onboarding, findings 1-39): preview first,
  // then a password-confirmed clone into a configured root. Disabled
  // states explain themselves in words (finding 28/39).
  const onboardCard =
    onboard === null
      ? ""
      : !onboard.enabled
        ? `<p class="meta">${escape(onboard.why)}</p>`
        : [
            `<details class="project-add-more"${onboard.record === null ? '' : ' open'}><summary>${onboard.record === null ? 'Paste a GitHub link' : 'Review repository'}</summary>`,
            `<p class="meta">Paste a GitHub repository — you will preview it before anything is downloaded. It goes into your saved projects folder and the builder connects automatically. Large-file (LFS) objects are not downloaded.</p>`,
            onboard.record === null
              ? [
                  `<form method="post" action="/projects/onboard-preview" class="card">`,
                  `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
                  `<label>Repository <input type="text" name="repo" placeholder="owner/name or https://github.com/owner/name"></label>`,
                  onboard.roots.length > 1
                    ? `<label>Into <select name="root">${onboard.roots.map((one, index) => `<option value="${index}">${escape(one)}</option>`).join("")}</select></label>`
                    : `<input type="hidden" name="root" value="0"><p class="meta">Into ${escape(onboard.roots[0] ?? "")}</p>`,
                  `<button type="submit">Preview</button>`,
                  `</form>`,
                ].join("\n")
              : [
                  `<div class="card">`,
                  `<p><strong>${escape(onboard.record[1].nameWithOwner)}</strong> <span class="meta">${
                    onboard.record[1].diskUsageKib === null ? "size unknown" : `${Math.max(1, Math.round(onboard.record[1].diskUsageKib / 1024))} MiB`
                  } — will land at ${escape(onboard.record[1].target)}</span></p>`,
                  `<form method="post" action="/projects/onboard-confirm">`,
                  `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
                  `<input type="hidden" name="nonce" value="${escape(onboard.record[0])}">`,
                  onboard.record[1].large
                    ? `<label class="row"><input type="checkbox" name="big-ok" value="1"> this is a large repository (or its size is unknown) — clone it anyway</label>`
                    : "",
                  `<label>Your password, typed again <input type="password" name="token" autocomplete="current-password"></label>`,
                  `<div class="sticky-actions"><button type="submit">Clone and open</button></div>`,
                  `</form>`,
                  `</div>`,
                ].join("\n"),
            `</details>`,
          ].join("\n");
  // Opening a project is a POST (the session's scope changes); a card's
  // name and counts are the same form, returning to the screen that count
  // names — so every number on this page is a road, not a fact to admire.
  const openForm = (path: string, label: string, destination = returnTo, className?: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<input type="hidden" name="return" value="${escape(destination)}">`,
      `<button type="submit"${className === undefined ? "" : ` class="${className}"`}${className === "button-link" ? ' style="min-height:44px"' : ''}>${escape(label)}</button>`,
      `</form>`,
    ].join("");

  // A project switcher CARD (v30 UI): the name and path, an at-a-glance
  // peek — what waits on a person, what is queued or running, what built
  // in the last day — and the open action. A vertical stack that reads on
  // a phone, not a dense row.
  const peekChips = (path: string, peek: ProjectPeek | null): string => {
    if (peek === null) return `<span class="meta">not scanned</span>`;
    const isOpen = open !== null && open === path;
    const chip = (text: string, href: string, cls: string): string =>
      isOpen ? `<a class="badge ${cls}" href="${href}">${text}</a>` : openForm(path, text, href, `badge ${cls}`);
    const bits: string[] = [];
    if (peek.waiting > 0) bits.push(chip(`${peek.waiting} waiting on you`, "/", "badge-open"));
    if (peek.running > 0) bits.push(chip(`${peek.running} running`, "/runs", "badge-parked"));
    if (peek.queued > 0) bits.push(chip(`${peek.queued} queued`, "/board?view=order", "badge-queued"));
    if (peek.doneRecently > 0) bits.push(chip(`${peek.doneRecently} built today`, "/done", "badge-parked"));
    return bits.length === 0 ? `<span class="meta">quiet — nothing queued or waiting</span>` : bits.join(" ");
  };
  const projectCard = (one: { path: string; name: string; note: string; peek: ProjectPeek | null }): string =>
    [
      `<div class="card project-card">`,
      `<div class="row">${
        open !== null && open === one.path
          ? `<a class="project-name" href="${escape(returnTo)}"><strong>${escape(one.name)}</strong></a>`
          : openForm(one.path, one.name, returnTo, "project-name")
      }`,
      `<span class="right">${
        open !== null && open === one.path ? `<span class="badge badge-done">Open now</span>` : openForm(one.path, "Open", returnTo, "button-link")
      }</span></div>`,
      `<p class="meta mono" style="overflow-wrap:anywhere;margin:.2rem 0">${escape(one.path)}</p>`,
      `<p class="row" style="gap:.35rem;flex-wrap:wrap">${peekChips(one.path, one.peek)}</p>`,
      `<p class="meta row" style="justify-content:space-between;margin-bottom:0"><span>${escape(one.note)}</span><a href="/settings/knowledge?repo=${encodeURIComponent(one.path)}" style="display:inline-flex;align-items:center;min-height:44px">Knowledge</a></p>`,
      `</div>`,
    ].join("\n");
  const cards = (items: { path: string; name: string; note: string }[]): string =>
    items.map(one => projectCard({ ...one, peek: peeks[one.path] ?? null })).join("\n");

  const recentItems = recent.map(one => ({ path: one.path, name: one.name, note: `last opened ${when(one.lastOpenedAt)}` }));
  const candidateItems = candidates.map(path => ({ path, name: projectName(path), note: "seen in the queue" }));
  // The rebuilt page's rows (shadcn/ui): the same projects, peeks and roads.
  const home = homedir();
  const rowOf = (path: string, name: string, openedAt: string | null): BrowserProjectRow => {
    const peek = peeks[path] ?? null;
    return {
      name, path, shortPath: path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path, open: open !== null && open === path, openedAt,
      knowledgeHref: `/settings/knowledge?repo=${encodeURIComponent(path)}`,
      ...(pullRequestsOn === undefined ? {} : { pullRequests: { href: `/settings/pull-requests?repo=${encodeURIComponent(path)}`, on: pullRequestsOn(path) } }),
      ...(checkLevelOf === undefined ? {} : { checks: { href: `/settings/checks?repo=${encodeURIComponent(path)}`, level: CHECK_LEVEL_WORDS[checkLevelOf(path)] } }),
      peek: peek === null ? null : [
        ...(peek.waiting > 0 ? [{ label: `${peek.waiting} waiting on you`, href: "/", tone: "attention" as const }] : []),
        ...(peek.running > 0 ? [{ label: `${peek.running} running`, href: "/runs", tone: "neutral" as const }] : []),
        ...(peek.queued > 0 ? [{ label: `${peek.queued} queued`, href: "/board?view=order", tone: "neutral" as const }] : []),
        ...(peek.doneRecently > 0 ? [{ label: `${peek.doneRecently} built today`, href: "/done", tone: "neutral" as const }] : []),
      ],
    };
  };

  // The two ways to ADD a project are the page's large, primary actions:
  // browse this machine, or choose a GitHub repository. Manual path entry
  // stays available as the clearly secondary expert road.
  const addAction = (href: string, paths: string, title: string, detail: string): string =>
    `<a class="project-add-action" href="${href}">` +
    `<span class="project-add-icon">${strokeIcon(paths)}</span>` +
    `<span class="project-add-copy"><strong>${escape(title)}</strong><small>${escape(detail)}</small></span>` +
    `<span class="project-add-arrow" aria-hidden="true">\u2192</span></a>`;
  const addForms = [
    browsable || onboard !== null && !onboard.enabled && onboard.why.includes('--project-root')
      ? ""
      : `<p class="meta">Choose a projects folder once with <code>toolroll up --project-root &lt;dir&gt;</code>. Toolroll remembers it after that.</p>`,
    onboardCard === "" ? "" : `<div style="margin-top:.5rem">${onboardCard}</div>`,
    `<details class="project-add-more"><summary>Enter an exact path instead</summary>`,
    `<form method="post" action="/projects/open" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<input type="hidden" name="return" value="${escape(returnTo)}">`,
    `<label>Path on this server<input type="text" name="path" placeholder="/Users/you/code/your-repo"></label>`,
    `<button type="submit">Open project</button>`,
    `</form></details>`,
  ].join("\n");
  const addCard = [
    `<div class="card project-add-card">`,
    `<h2 class="project-add-title">Add a project</h2>`,
    `<div class="project-add-actions">`,
    browsable
      ? addAction("/projects/browse", FOLDER_PATHS, "Choose a local folder", "Browse the project folders on this machine")
      : "",
    onboard === null
      ? ""
      : addAction(
          "/projects/github",
          `<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
          "Add from GitHub",
          "Choose from repositories available to your GitHub login",
        ),
    `</div>`,
    addForms,
    `</div>`,
  ].join("\n");

  // Arriving from New task with no project open: say what this step is for.
  const choosing = returnTo.startsWith("/tasks/new");
  return screen("projects", [
    choosing ? `<h1>New task</h1><p class="meta">Choose the project it belongs to.</p>` : `<h1>Projects</h1>`,
    choosing ? "" : `<p class="meta">Add a folder or GitHub repository once. Its tasks and chat stay here.</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    recentItems.length === 0 && candidateItems.length === 0
      ? `<div class="card"><p><strong>Nothing to open yet.</strong></p><p class="meta">Add one below \u2014 opening it registers it here for next time.</p></div>`
      : "",
    recentItems.length > 0 ? `<h2>Recent</h2>${cards(recentItems)}` : "",
    candidateItems.length > 0 ? `<h2>Available</h2>${cards(candidateItems)}` : "",
    addCard,
  ].join("\n"), { chrome, workspace: { view: {
    kind: "projects", choosing, problem, returnTo,
    recent: recent.map(one => rowOf(one.path, one.name, one.lastOpenedAt)),
    available: candidates.map(path => rowOf(path, projectName(path), null)),
    add: { browse: browsable ? "/projects/browse" : null, github: onboard === null ? null : "/projects/github", html: addForms },
  } satisfies BrowserProjectsView } });
}

/**
 * Creating work is the product's first verb, so it gets a whole calm page:
 * a title, the goal that becomes the scope draft, and the project it lands
 * in — then straight to the approve card, which is the aha the flow serves.
 */
/** One queue card. Taken work renders pinned — visible, never draggable. */
/**
 * The request's own session facts, readable from anywhere below the
 * dispatcher without threading them through forty call sites: the csrf
 * token the chrome's switcher forms carry, and the path a switch returns
 * to. AsyncLocalStorage follows the request's own async chain, so two
 * interleaved requests never read each other's token.
 */
/** The person's pinned theme from their own cookie; null follows the device. */
export function pinnedTheme(cookieHeader: string | undefined): "light" | "dark" | null {
  const value = /(?:^|;\s*)so-theme=(light|dark)(?:;|$)/.exec(cookieHeader ?? "")?.[1];
  return value === "light" || value === "dark" ? value : null;
}
export function themeAttribute(): string {
  const theme = requestContext.getStore()?.theme ?? null;
  return theme === null ? "" : ` data-theme="${theme}"`;
}
/** A chosen accent (Settings → Appearance) re-pigments the signal tokens only, after the shared stylesheet. */
export function accentHead(): string {
  const accent = requestContext.getStore()?.accent ?? null;
  return accent === null ? "" : `<style data-accent="${accent}">${accentStyle(accent)}</style>`;
}
export const requestContext = new AsyncLocalStorage<{ appOrigins?: readonly (string | null)[]; sso?: { label: string; fresh: boolean } | undefined; refusal?: (response: ServerResponse, status: number, body: string) => void; theme?: "light" | "dark" | null; accent?: string | null; updateSeen?: string | null; csrf: string; returnTo: string; actor?: string; createdTask?: string; browser?: boolean; workspaceRead?: boolean; workspaceRequest?: string | null; workCounts?: ReturnType<typeof workCountsByProject>; workCrew?: { project: string | null; page: WorkIndexPage }; lens?: string | null; workspaceValidator?: { key: string; revision: string; expiresAt: number; etag: string } }>();

/** A same-site path or "/": never a scheme, a host, or a protocol-relative road. */
/** The words a result page shows for a refusal its own form led to, by the fixed code a redirect carries. */
export const ACCEPT_ANYWAY_NEEDS_REASON = "Accepting anyway needs a reason.";
export const RESULT_REFUSALS: Record<string, string> = { reason: ACCEPT_ANYWAY_NEEDS_REASON };

/** A same-site page address with a refusal code added, before any fragment. */
export function withRefusal(href: string, code: keyof typeof RESULT_REFUSALS): string {
  const at = href.indexOf("#");
  const [path, hash] = at === -1 ? [href, ""] : [href.slice(0, at), href.slice(at)];
  return `${path}${path.includes("?") ? "&" : "?"}refused=${code}${hash}`;
}

export function safeReturn(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "/";
  // A backslash is a slash to a browser's URL parser (`/\evil` → `//evil`), so it is refused too (v3 review, finding 10).
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\r\n\t\u0000-\u001f]/.test(raw) || raw.length > 512) return "/";
  try {
    const path = decodeURIComponent(new URL(raw, "http://standing-orders.local").pathname);
    if (path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return "/";
  } catch { return "/"; }
  return raw;
}

/**
 * The destination a sign-in returns to (a phone's deep link to an exact
 * task or result): `safeReturn`, then narrower still — never the sign-in,
 * sign-up, join or sign-out roads themselves (a loop, or a token in a
 * path), never an encoded second scheme or host once the browser decodes
 * it, never a query key that could carry a secret, and never a region
 * fetch (`?fragment=`), which is a piece of a page and not a place to
 * land. Only the app's own pages qualify: the task lens, the chat, the
 * work and board views, and the fixed control destinations a phone
 * button can name. Nothing here is a second redirect framework: one
 * same-site path, or "/".
 */
export const LOGIN_RETURN_PAGES = /^\/(oauth\/authorize|t\/[^/]+|r\/[1-9]\d*|code(?:\/[a-f0-9]{32}(?:\/ship)?)?|review|chat|work|board|projects|routines|recipes|fleet|settings(\/[a-z-]+)?|mode)$/;
export function loginReturn(raw: string | null | undefined): string {
  const safe = safeReturn(raw);
  if (safe === "/") return "/";
  let parsed: URL;
  try {
    parsed = new URL(safe, "http://standing-orders.local");
  } catch {
    return "/";
  }
  if (parsed.origin !== "http://standing-orders.local" || parsed.username !== "" || parsed.password !== "") return "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return "/";
  }
  if (/^\/\/|\\|[\r\n\t\u0000-\u001f]/.test(decodedPath) || /^\/(login|logout|signup|join)(\/|$)/.test(decodedPath)) return "/";
  if (!LOGIN_RETURN_PAGES.test(decodedPath) || parsed.searchParams.has("fragment")) return "/";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/token|password|secret|csrf|code|key|auth/i.test(key)) parsed.searchParams.delete(key);
  }
  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query === "" ? "" : `?${query}`}`;
}

/** A request path fit for a log: the one-time sign-in link's code is left out. */
export function redactedPath(path: string): string {
  return path.startsWith(SIGN_IN_LINK_PATH) ? `${SIGN_IN_LINK_PATH}…` : path;
}

/** The sign-in page that comes back to `path` afterwards, or plain /login when the path is not one to come back to. */
export function loginHref(path: string): string {
  const back = loginReturn(path);
  return back === "/" ? "/login" : `/login?return=${encodeURIComponent(back)}`;
}

/** Chat actions may return only to the unified chat or one task-focused
 * lens. Other same-site paths are valid elsewhere, but not for chat forms. */
export function safeChatReturn(raw: string | null | undefined): string {
  const safe = safeReturn(raw);
  try {
    const parsed = new URL(safe, "http://standing-orders.local");
    if (parsed.pathname !== "/chat") return "/chat";
    const conversation=parsed.searchParams.get('conversation');
    if(conversation&&/^[a-f0-9-]{36}$/.test(conversation))return `/chat?conversation=${encodeURIComponent(conversation)}`;
    if(parsed.searchParams.get('private')==='1')return '/chat?private=1';
    const task = parsed.searchParams.get("task");
    return task !== null && task.length > 0 && task.length <= 64 && !hasForbiddenControls(task)
      ? taskChatHref(task)
      : "/chat";
  } catch {
    return "/chat";
  }
}

export function chatReturnWithSaid(back: string, said: string): string {
  return `${back}${back.includes("?") ? "&" : "?"}said=${encodeURIComponent(said)}`;
}

export const chatReturnWithLatest = (back: string): string => `${back}#latest`;

/** The no-script "move to the front" sentinel: the form cannot name the
 * front of a partition, so the handler resolves it (slice 1b, fix 1). */
export const QUEUE_FRONT = "__TOP__";

/** Drawn, one stroke weight, like the tab bar's icons — never a glyph. */
export const GRIP_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">` +
  `<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/>` +
  `<circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
export const TO_FRONT_ICON =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
/** One stroke weight, from the tab bar's set: the sidebar's primary rows
 * wear an icon each; the foot's list stays text, the way Linear's does. */
export const strokeIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
/** Where the queue lives now: the board, flipped to dispatch order. */
export const QUEUE_VIEW = "/board?view=order";
export const FOLDER_PATHS = `<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>`;
export const CHAT_PATHS = `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`;
export const WORK_PATHS = `<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m4 6 1 1 2-2"/><path d="m4 12 1 1 2-2"/><path d="m4 18 1 1 2-2"/>`;
export const NAV_ICONS: Partial<Record<Chrome["active"], string>> = {
  code: strokeIcon(`<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>`),
  chat: strokeIcon(CHAT_PATHS),
  work: strokeIcon(WORK_PATHS),
  projects: strokeIcon(FOLDER_PATHS),
  flows: strokeIcon(`<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>`),
};

/** One grouped destination inside an accordion group or the /menu overflow. */
export type NavRow = { key: Chrome["active"]; href: string; label: string; hint: string };

/**
 * The workspace shell (package 1): three primary rows (chat, work,
 * projects) above two accordion groups. Work tools is where work is
 * arranged, planned, and scheduled — the board, its order view, the
 * flat task list, recipes, the portfolio, and the action
 * ledger. Settings is who and what the fleet runs on — fleet,
 * requirements, people, operating mode, system — plus the agent-defaults
 * page where the console offers it. Both draw from the same two lists on
 * a desk (accordion groups) and on a phone (/menu sections), so the two
 * never disagree, and a project-scoped login sees exactly the rows it
 * saw before: moving a link never widens role or project visibility.
 */
export function workToolRows(scoped = false, _offersChat = false, offersCode = false): NavRow[] {
  const rows: NavRow[] = [
    // D5: coding sessions are deprecated; /code still opens this release, but nothing links to it.
    { key: "inbox", href: "/inbox", label: "Inbox", hint: "questions, approvals, and repairs to act on" },
    { key: "board", href: "/board", label: "Board", hint: "lanes by state, with the order view" },
    { key: "tasks", href: "/tasks", label: "Task list", hint: "everything, filterable by state" },
    { key: "recipes", href: "/recipes", label: "Recipes", hint: "choose, customize, and reuse a workflow" },
    { key: "workbench", href: "/workbench", label: "Portfolio", hint: "every project and live build in one place" },
    { key: "ledger", href: "/ledger", label: "Action ledger", hint: "who acted, what happened, and the result" },
    { key: "spend", href: "/spend", label: "Spend", hint: "what agent work cost, and monthly budgets" },
  ];
  return scoped ? rows.filter(row => row.key !== "workbench" && row.key !== "spend") : rows;
}
export function settingsRows(scoped = false, offersSettings = false): NavRow[] {
  const rows: NavRow[] = [
    ...(offersSettings ? [{ key: "settings" as const, href: "/settings", label: "Settings", hint: "agent defaults, alerts, credentials" }] : []),
    { key: "fleet", href: "/fleet", label: "Fleet", hint: "who is working, and on what" },
    { key: "caps", href: "/caps", label: "Requirements", hint: "tools and credentials builds need" },
    { key: "people", href: "/people", label: "People", hint: "who can sign in, and what they have done" },
    { key: "mode", href: "/mode", label: "Operating mode", hint: "the signed posture this repository runs under" },
    { key: "system", href: "/system", label: "System", hint: "workers, providers, and grants" },
  ];
  return scoped ? rows.filter(row => row.key === "people" || row.key === "settings") : rows;
}
/** Which accordion group opens by default for a given active page. */
export const TOOL_KEYS = new Set<Chrome["active"]>(["code", "inbox", "board", "queue", "tasks", "workbench", "recipes", "ledger", "spend"]);
export const SETTINGS_KEYS = new Set<Chrome["active"]>(["settings", "fleet", "caps", "people", "mode", "system"]);

/** The builds screen's views (reduction pass §1): done, the review queue,
 * and activity are ways of looking at builds, not destinations. */
export function buildsViews(current: "builds" | "done" | "review" | "activity"): string {
  const views: [typeof current, string, string][] = [
    ["builds", "/runs", "builds"],
    ["done", "/done", "done"],
    ["review", "/review", "review"],
    ["activity", "/activity", "activity"],
  ];
  return `<p class="meta board-view">${views
    .map(([key, href, label]) => (key === current ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`))
    .join(" \u00b7 ")}</p>`;
}

export const CHEVRON_ICON =
  `<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<path d="m6 9 6 6 6-6"/></svg>`;
/** The drag grip: a 2rem touch-sized handle that owns its touches
 * (touch-action: none), so a finger on it drags instead of scrolling. */
export const GRIP_HANDLE = `<span class="queue-handle" aria-hidden="true">${GRIP_ICON}</span>`;

export type QueueCardTask = ReturnType<Store["queueScoped"]>[number] & { dispatch?: DispatchDiagnosis | null };

export function queueCard(one: QueueCardTask, csrf: string, revision: number, queueRevision: number, workers: { name: string; retired: boolean }[], column: string): string {
  // Presentation over queueScoped()'s shape only: state, scope, blockers,
  // and the reservation owner. Money is not in this query and is not
  // invented here — it stays on the task page, labeled.
  const state = one.taken
    ? `<span class="badge">Being taken — keeps its claim</span>`
    : column === "anyone"
      ? `<span class="badge">Queued</span>`
      : `<span class="badge">Reserved for ${escape(column)}</span>`;
  const chips =
    ` ${state}` +
    `${one.dispatch === null || one.dispatch === undefined ? "" : ` <a class="badge" href="${taskHref(one.id)}" title="${escape(one.dispatch.summary)}">${escape(dispatchHeadline(one.dispatch))}</a>`}`;
  const hidden =
    `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
    `<input type="hidden" name="projectRevision" value="${revision}">` +
    `<input type="hidden" name="queueRevision" value="${queueRevision}">` +
    `<input type="hidden" name="task" value="${escape(one.id)}">`;
  const controls = one.taken
    ? ""
    : `<form method="post" action="/queue/move" class="inline">${hidden}` +
      `<input type="hidden" name="column" value="${escape(column)}">` +
      `<input type="hidden" name="before" value="${QUEUE_FRONT}">` +
      `<button type="submit" class="icon-button" aria-label="move to the front">${TO_FRONT_ICON}</button></form>` +
      `<form method="post" action="/queue/move" class="inline">${hidden}` +
      `<select name="column" aria-label="reserve for">` +
      `<option value="anyone"${column === "anyone" ? " selected" : ""}>anyone</option>` +
      workers.filter(worker => !worker.retired).map(worker => `<option value="${escape(worker.name)}"${column === worker.name ? " selected" : ""}>${escape(worker.name)}</option>`).join("") +
      `</select><button type="submit">Move</button></form>`;
  return (
    `<div class="card queue-card" data-task="${escape(one.id)}" data-taken="${one.taken ? "1" : "0"}"${one.dispatch === null || one.dispatch === undefined ? "" : ` data-dispatch-status="${escape(one.dispatch.code)}"`}>` +
    `<p class="row">${one.taken ? "" : `${GRIP_HANDLE}`}` +
    `<a href="${taskHref(one.id)}">${escape(one.title)}</a>${chips}</p>` +
    `<p class="row meta"><span class="mono">${escape(one.id)}</span> ${controls}</p>` +
    `</div>`
  );
}

/** The queue columns fragment — shared queue first, then each worker. */
export function queueBody(
  tasks: QueueCardTask[],
  workers: { name: string; retired: boolean; note: string | null; capacity: number; building: number }[],
  csrf: string,
  revision: number,
  queueRevision: number,
): string {
  const columnOf = (runner: string | null) => tasks.filter(one => one.assignedRunner === runner);
  const projectChips = (rows: typeof tasks) => {
    const repos = [...new Set(rows.map(one => one.repo).filter((one): one is string => one !== null))];
    return repos.map(repo => `<span class="badge">${escape(repo.split("/").pop() ?? repo)}</span>`).join(" ");
  };
  const shared = columnOf(null);
  const allWorkersBusy = workers.filter(one => !one.retired).length > 0 && workers.filter(one => !one.retired).every(one => columnOf(one.name).length > 0);
  const column = (title: string, key: string, head: string, rows: typeof tasks, empty: string): string =>
    `<section class="lane queue-column" data-column="${escape(key)}"><h2>${escape(title)}</h2>${head}` +
    `<p class="meta">${projectChips(rows)}</p>` +
    (rows.length === 0
      ? `<p class="meta lane-empty">${escape(empty)}</p>`
      : rows
          .map((one, index) =>
            index === 0 && key === "anyone" && allWorkersBusy && !one.taken
              ? queueCard(one, csrf, revision, queueRevision, workers, key).replace(
                  '</p>\n',
                  "</p>",
                ).replace(
                  `<p class="row meta">`,
                  `<p class="meta">Every worker has reserved work — this waits until a column empties</p><p class="row meta">`,
                )
              : queueCard(one, csrf, revision, queueRevision, workers, key),
          )
          .join("\n")) +
    `</section>`;
  const noteForm = (worker: { name: string; retired: boolean; note: string | null; capacity: number; building: number }): string =>
    worker.retired
      ? `<p class="meta">This worker is retired — drag these elsewhere, or register the name again</p>`
      : `<p class="meta mono">${worker.building} building in this project · unattended capacity ${worker.capacity}</p>` +
        `<form method="post" action="/queue/note" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="hidden" name="projectRevision" value="${revision}">` +
        `<input type="hidden" name="runner" value="${escape(worker.name)}">` +
        `<input type="text" name="note" value="${worker.note === null ? "" : escape(worker.note)}" data-initial="${worker.note === null ? "" : escape(worker.note)}" placeholder="what this worker is working through" aria-label="column note" maxlength="200">` +
        `<button type="submit">Save</button></form>` +
        `<p class="meta">Takes from the shared queue when this column is empty</p>`;
  return (
    `<div class="lanes" data-queue-revision="${queueRevision}">` +
    column("shared queue", "anyone", `<p class="meta">Workers take from here when their column is empty — top card first</p>`, shared, "nothing waiting — every task is reserved or running") +
    workers
      .map(worker => column(worker.name + (worker.retired ? " (retired)" : ""), worker.name, noteForm(worker), columnOf(worker.name), "nothing queued — this worker will take from the shared queue"))
      .join("\n") +
    `</div>`
  );
}

/**
 * The fleet screen — one lane per runner, and the work in front of it.
 * Building claims pin to the top of their worker's lane (live — never
 * draggable); queued reservations sit below it (draggable to another
 * worker, re-reserving them). Every card wears its project chip, which is
 * the whole point: which agent is on which project is the page's answer.
 * Form-free like the board, except the per-worker note, so the lane stack
 * can re-render itself while somebody watches.
 */
export function fleetBody(
  queued: ReturnType<Store["fleetQueue"]>,
  building: ReturnType<Store["liveClaims"]>,
  runners: Runner[],
  csrf: string,
  queueRevision: number,
  visibleRepo: (repo: string | null) => boolean,
): string {
  const chip = (repo: string | null): string =>
    repo === null ? "" : ` <span class="badge">${escape(projectName(repo))}</span>`;
  const lanes = runners.map(runner => {
    const own = queued.filter(one => one.assignedRunner === runner.name && visibleRepo(one.repo));
    const live = building.filter(one => one.runner === runner.name);
    const retired = runner.retiredAt !== null;
    const head =
      retired
        ? `<p class="meta">This worker is retired — drag these elsewhere, or register the name again</p>`
        : `<form method="post" action="/queue/note" class="row">` +
          `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
          `<input type="hidden" name="from" value="fleet">` +
          `<input type="hidden" name="runner" value="${escape(runner.name)}">` +
          `<input type="text" name="note" class="runner-note" value="${runner.queueNote === null || runner.queueNote === undefined ? "" : escape(runner.queueNote)}" data-initial="${runner.queueNote === null || runner.queueNote === undefined ? "" : escape(runner.queueNote)}" placeholder="what this worker is working through" aria-label="column note" maxlength="200">` +
          `</form>` +
          `<p class="meta">${runnerAlive(runner, new Date()) ? "alive" : "quiet"} · ${live.length}/${runner.capacity} building</p>`;
    const buildingCards = live
      .map(
        claim =>
          `<div class="lane-card" data-taken="1"><p class="row"><span class="dot dot-ok pulse"></span> ${escape(claim.taskId)}</p>` +
          `<p class="row meta">building${chip(claim.repo ?? null)}${claim.model === null ? "" : ` · ${escape(claim.model)}`} · ${Math.max(1, Math.round((Date.now() - new Date(claim.claimedAt).getTime()) / 60_000))}m</p></div>`,
      )
      .join("\n");
    const queuedCards = own
      .map(
        one =>
          `<div class="lane-card queue-card" data-task="${escape(one.id)}" data-taken="${one.taken ? "1" : "0"}">` +
          `<p class="row">${one.taken ? "" : `${GRIP_HANDLE}`}` +
          `<a href="${taskHref(one.id)}">${escape(one.title)}</a></p>` +
          `<p class="row meta"><span class="mono">${escape(one.id)}</span>${chip(one.repo)}` +
          `${one.approved ? "" : ` <span class="badge">Unapproved scope</span>`}` +
          `${one.blockers > 0 ? ` <span class="badge">Waits for ${one.blockers}</span>` : ""}` +
          `${one.taken ? ` <span class="badge">Being taken</span>` : ""}</p></div>`,
      )
      .join("\n");
    const empty =
      live.length === 0 && own.length === 0
        ? `<p class="meta lane-empty">${retired ? "nothing left" : "idle — will take from the shared queue"}</p>`
        : "";
    return (
      `<section class="lane queue-column${live.length > 0 ? " lane-live" : ""}" data-column="${escape(runner.name)}">` +
      `<h2>${escape(runner.name)}${retired ? " (retired)" : ""}</h2>${head}${buildingCards}${queuedCards}${empty}</section>`
    );
  });
  // The shared queue: anything reserved for nobody.
  const shared = queued.filter(one => one.assignedRunner === null && visibleRepo(one.repo));
  const sharedCards = shared
    .map(
      one =>
        `<div class="lane-card queue-card" data-task="${escape(one.id)}" data-taken="${one.taken ? "1" : "0"}">` +
        `<p class="row">${one.taken ? "" : `${GRIP_HANDLE}`}` +
        `<a href="${taskHref(one.id)}">${escape(one.title)}</a></p>` +
        `<p class="row meta"><span class="mono">${escape(one.id)}</span>${chip(one.repo)}` +
        `${one.approved ? "" : ` <span class="badge">Unapproved scope</span>`}` +
        `${one.blockers > 0 ? ` <span class="badge">Waits for ${one.blockers}</span>` : ""}` +
        `${one.taken ? ` <span class="badge">Being taken</span>` : ""}</p></div>`,
    )
    .join("\n");
  const sharedLane =
    `<section class="lane queue-column" data-column="anyone"><h2>Shared queue</h2>` +
    `<p class="meta">Any free worker takes from here, top first</p>${sharedCards}` +
    (shared.length === 0 ? `<p class="meta lane-empty">nothing waiting — every task is reserved or running</p>` : "") +
    `</section>`;
  return (
    `<div class="lanes" data-queue-revision="${queueRevision}">` +
    sharedLane +
    lanes.join("\n") +
    `</div>`
  );
}

/** Identical drag mechanics to the queue — the pointer events land on the worker's column. */
export function fleetScript(): string {
  return (
    `(function(){var region=document.getElementById("fleet-region");if(!region)return;` +
    `var stamp=document.getElementById("fleet-region-stamp");var dragging=null;` +
    `function dirty(){if(region.contains(document.activeElement)&&document.activeElement!==document.body)return true;` +
    `var inputs=region.querySelectorAll("input[type=text]");for(var i=0;i<inputs.length;i++){` +
    `if(inputs[i].value!==(inputs[i].getAttribute("data-initial")||""))return true;}` +
    `return false;}` +
    `function paused(){return dragging!==null||dirty();}` +
    `var wait=12000;var last=Date.now();var busy=false;` +
    `function tell(){if(!stamp)return;if(paused()){stamp.textContent="paused while you edit";return;}` +
    `stamp.textContent="updated "+Math.round((Date.now()-last)/1000)+"s ago";}setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy||paused()){setTimeout(cycle,wait);return;}busy=true;` +
    `fetch("/fleet?fragment=1",{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}})` +
    `.catch(function(){})` +
    `.then(function(){busy=false;tell();setTimeout(cycle,wait);});}setTimeout(cycle,wait);` +
    `region.addEventListener("pointerdown",function(e){var handle=e.target.closest(".queue-handle");if(!handle)return;` +
    `var card=handle.closest(".queue-card");if(!card||card.getAttribute("data-taken")==="1")return;` +
    `e.preventDefault();dragging={task:card.getAttribute("data-task"),card:card};card.style.opacity="0.5";});` +
    `region.addEventListener("pointermove",function(e){if(!dragging)return;e.preventDefault();` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over)return;` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");` +
    `region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `if(target&&target!==dragging.card){target.style.outline="2px solid currentColor";}` +
    `else if(lane){lane.style.outline="2px dashed currentColor";}});` +
    `region.addEventListener("pointerup",function(e){if(!dragging)return;var drag=dragging;dragging=null;` +
    `drag.card.style.opacity="";region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over){tell();return;}` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");if(!lane){tell();return;}` +
    `var column=lane.getAttribute("data-column");var before=target&&target!==drag.card?target.getAttribute("data-task"):"";` +
    `if(target&&target.getAttribute("data-taken")==="1"){before="";}` +
    `var wrap=region.querySelector("[data-queue-revision]");` +
    `var fields={respond:"fragment",csrf:(region.querySelector("input[name=csrf]")||{value:""}).value,` +
    `queueRevision:wrap?wrap.getAttribute("data-queue-revision"):"",task:drag.task,column:column,before:before};` +
    `var post=new URLSearchParams();Object.keys(fields).forEach(function(k){post.append(k,fields[k]);});` +
    `fetch("/queue/move",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:post.toString(),redirect:"manual"})` +
    `.then(function(r){return r.ok?fetch("/fleet?fragment=1",{cache:"no-store"}).then(function(f){return f.ok?f.text():null;}):null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/fleet";}})` +
    `.catch(function(){})` +
    `.then(function(){tell();});});` +
    `})();`
  );
}

/** The /queue page's one nonce'd script: delegated pointer-event drag (it
 * survives every fragment swap — finding 17) plus a poller that re-checks
 * focus, dirty inputs, and an in-flight drag AT SWAP TIME, never only
 * before the fetch. Select dirtiness compares against data-initial
 * (finding 18); missing that, a select counts clean.
 */
export function queueScript(): string {
  return (
    `(function(){var region=document.getElementById("queue-region");if(!region)return;` +
    `var stamp=document.getElementById("queue-region-stamp");var dragging=null;var ghost=null;` +
    `function dirty(){if(region.contains(document.activeElement)&&document.activeElement!==document.body)return true;` +
    `var inputs=region.querySelectorAll("input[type=text]");for(var i=0;i<inputs.length;i++){` +
    `if(inputs[i].value!==(inputs[i].getAttribute("data-initial")||""))return true;}` +
    `var selects=region.querySelectorAll("select");for(var j=0;j<selects.length;j++){` +
    `var base=selects[j].getAttribute("data-initial");if(base!==null&&selects[j].value!==base)return true;}` +
    `return false;}` +
    `function paused(){return dragging!==null||dirty();}` +
    // the poller: pause is re-checked at SWAP time
    `var wait=15000;var last=Date.now();var busy=false;` +
    `function tell(){if(!stamp)return;if(paused()){stamp.textContent="paused while you edit";return;}` +
    `stamp.textContent="updated "+Math.round((Date.now()-last)/1000)+"s ago";}setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy||paused()){setTimeout(cycle,wait);return;}busy=true;` +
    `fetch("/queue?fragment=1",{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}})` +
    `.catch(function(){})` +
    `.then(function(){busy=false;tell();setTimeout(cycle,wait);});}setTimeout(cycle,wait);` +
    // the drag: delegated from the stable region element
    `region.addEventListener("pointerdown",function(e){var handle=e.target.closest(".queue-handle");if(!handle)return;` +
    `var card=handle.closest(".queue-card");if(!card||card.getAttribute("data-taken")==="1")return;` +
    `e.preventDefault();dragging={task:card.getAttribute("data-task"),card:card};card.style.opacity="0.5";});` +
    `region.addEventListener("pointermove",function(e){if(!dragging)return;e.preventDefault();` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over)return;` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");` +
    `region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `if(target&&target!==dragging.card){target.style.outline="2px solid currentColor";}` +
    `else if(lane){lane.style.outline="2px dashed currentColor";}});` +
    `region.addEventListener("pointerup",function(e){if(!dragging)return;var drag=dragging;dragging=null;` +
    `drag.card.style.opacity="";region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over){tell();return;}` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");if(!lane){tell();return;}` +
    `var column=lane.getAttribute("data-column");var before=target&&target!==drag.card?target.getAttribute("data-task"):"";` +
    `if(target&&target.getAttribute("data-taken")==="1"){before="";}` +
    `var wrap=region.querySelector("[data-queue-revision]");` +
    `var fields={respond:"fragment",csrf:(region.querySelector("input[name=csrf]")||{value:""}).value,projectRevision:(region.querySelector("input[name=projectRevision]")||{value:""}).value,` +
    `queueRevision:wrap?wrap.getAttribute("data-queue-revision"):"",task:drag.task,column:column,before:before};` +
    `var post=new URLSearchParams();Object.keys(fields).forEach(function(k){if(fields[k]!==""||k==="respond")post.append(k,fields[k]);});` +
    // A refused move (slice 1b, fix 2): the handler's typed text/plain 409
    // lands on the card as a problem row — textContent, never markup. Only
    // an authenticated plain-text 409 is inlined; an HTML refusal (the
    // stale-project page), a login bounce, or anything unexpected navigates.
    `function problem(task,text){var card=region.querySelector('.queue-card[data-task="'+task.replace(/["\\\\]/g,"")+'"]');if(!card)return false;` +
    `var old=card.querySelector(".queue-problem");if(old)old.remove();` +
    `var row=document.createElement("p");row.className="problem queue-problem";row.setAttribute("role","alert");row.textContent=text;card.appendChild(row);return true;}` +
    `fetch("/queue/move",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:post.toString(),redirect:"manual"})` +
    `.then(function(r){if(r.ok)return fetch("/queue?fragment=1",{redirect:"manual",cache:"no-store"}).then(function(f){` +
    `if(f.type==="opaqueredirect"||f.status===401||f.status===403){location.href="/login";return false;}return f.ok?f.text():null;});` +
    `if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return false;}` +
    `var kind=(r.headers&&r.headers.get?r.headers.get("content-type"):"")||"";` +
    `if(r.status===409&&kind.indexOf("text/plain")===0){return r.text().then(function(text){return problem(drag.task,text)?false:null;});}` +
    `return null;})` +
    `.then(function(t){if(t===false)return;if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/board?view=order";}})` +
    `.catch(function(){})` +
    `.then(function(){tell();});});` +
    `})();`
  );
}

export function newTaskPage(
  chrome: Chrome,
  project: string | null,
  csrf: string,
  projectRevision: number,
  problem: string | null,
  candidates: { id: string; title: string }[] = [],
  permissionDefault: UnattendedPermissionMode = "auto",
  qualityDefault: QualityMode = "default",
  projects: { path: string; name: string }[] = [],
): Screen {
  return screen("New task", [
    `<section class="task-intake">`,
    `<div class="task-intake-hero"><h1>What should get done?</h1></div>`,
    `<p class="meta">Work you do often? <a href="/recipes">Use a saved recipe</a> or <a href="/recipes/new">create one</a>.</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    taskComposerHtml({
      csrf,
      project,
      projectRevision,
      candidates,
      permissionDefault,
      qualityDefault,
      projects,
    }),
    `<p class="meta task-agent-note">Nothing builds until you approve the plan. <a href="/chat">Or start in chat.</a></p>`,
    `</section>`,
  ].join("\n"), { chrome });
}

/** A plan is stored as inert Markdown for portability into the builder
 * brief, but the console renders its known structure as a useful control
 * surface. Historical free-form plans keep their safe plain-text fallback. */
export const MILESTONE_STATE_WORDS: Record<MilestoneState, string> = {
  pending: "Pending",
  current: "In progress",
  completed: "Completed",
  blocked: "Blocked",
};

/** Badges, labels and buttons read in sentence case, whatever word a record stores. */
export const sentenceCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export function milestoneStateWord(state: MilestoneState): string {
  return MILESTONE_STATE_WORDS[state] ?? "Pending";
}

/** Adaptive execution plans (v44): the live milestone projection a running
 * (or finished) build has reported. A shared render used by BOTH the task
 * page and the focused chat's live region (c2) — labeled clearly as an
 * agent's own report, since a milestone claim is never completion proof
 * (Priority 2's proof contract is the only thing that adjudicates "done"). */
export function milestoneProgressHtml(milestones: MilestoneProgressView[] | null | undefined): string {
  if (milestones === null || milestones === undefined || milestones.length === 0) return "";
  const completed = milestones.filter(one => one.state === "completed").length;
  return (
    `<section class="card milestone-progress"><div class="milestone-progress-head"><div><span class="eyebrow">live execution</span><h2>Build progress</h2></div>` +
    `<span class="milestone-progress-count">${completed} of ${milestones.length} complete</span></div><ul class="milestone-list">` +
    milestones
      .map(
        one =>
          `<li class="milestone milestone-${one.state}"><span class="milestone-badge">${milestoneStateWord(one.state)}</span> ` +
          `${escape(one.description)}${one.note === null ? "" : ` <span class="meta">— ${escape(one.note)}</span>`}</li>`,
      )
      .join("\n") +
    `</ul><p class="meta milestone-progress-note">Live checkpoints from the agent.</p></section>`
  );
}

/** Adaptive execution plans (v44): the current plan revision's own reason
 * and evidence, any revision still awaiting an operator's accept/reject,
 * and the immutable history. A shared render used by BOTH the task page
 * and the focused chat's live region (c2), reading a document already
 * verified before a byte reached this function (c5). */
export function planRevisionLedgerHtml(ledger: PlanRevisionLedgerView | null | undefined, taskId: string, csrf: string): string {
  // Nothing to show yet unless a plan has actually been revised: a task
  // still on its synthetic revision-1 projection, with no pending proposal
  // and no persisted history, is exactly what the plan card already shows.
  if (ledger === null || ledger === undefined || ledger.current === null || (ledger.pending === null && ledger.history.length === 0)) return "";
  const current = ledger.current;
  const changedAuthority = (field: string): string => {
    if (field === "scopeDigest" || field === "signed-scope") return "the work you approved";
    if (field === "deliverable" || field === "publication-authority") return "what the task may deliver";
    return field.replace(/[-_]+/g, " ");
  };
  const pending =
    ledger.pending === null
      ? ""
      : `<div class="plan-revision-pending"><span class="eyebrow">decision needed</span><h3>The agent recommends a plan change</h3>` +
        `<p>${escape(ledger.pending.reason)}</p>` +
        `<p class="meta">Revision ${ledger.pending.revision}${ledger.pending.authorityKind === "authority-change" ? ` changes ${ledger.pending.changedFields.map(changedAuthority).map(escape).join(" and ")} from what you approved, so work is paused until you decide.` : " only changes the route, not the approved outcome."}` +
        `${ledger.pending.evidenceLink === null ? "" : ` Evidence: ${escape(ledger.pending.evidenceLink)}.`}</p>` +
        executionPlanHtml(ledger.pending.document, true) +
        (csrf === "" || ledger.pending.id === null
          ? ""
          : `<form method="post" action="${taskHref(taskId)}/accept-revision" class="inline">` +
            `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="revision-id" value="${ledger.pending.id}">` +
            (ledger.pending.authorityKind === "authority-change"
              ? `<input type="password" name="token" placeholder="approval password" required autocomplete="current-password">`
              : "") +
            `<button type="submit">${ledger.pending.authorityKind === "authority-change" ? "Approve changes &amp; continue" : "Use revised plan &amp; continue"}</button></form>` +
            `<form method="post" action="${taskHref(taskId)}/reject-revision" class="inline">` +
            `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="revision-id" value="${ledger.pending.id}">` +
            `<button type="submit" class="quiet">Keep current plan</button></form>`) +
        `</div>`;
  const history =
    ledger.history.length <= 1
      ? ""
      : `<details class="plan-revision-history"><summary>Revision history (${ledger.history.length})</summary>` +
        ledger.history
          .map(
            one =>
              `<p class="row"><span class="mono">rev ${one.revision}</span> <span class="badge">${escape(sentenceCase(one.status))}</span> ` +
              `<span class="meta">${escape(one.author)} · ${whenTime(one.createdAt)}</span> — ${escape(one.reason)}</p>`,
          )
          .join("\n") +
        `</details>`;
  return (
    `<div class="card plan-revision"><span class="eyebrow">plan updated</span><h2>Using plan revision ${current.revision}</h2>` +
    `<p class="meta">${escape(current.reason)}${current.evidenceLink === null ? "" : ` · evidence: ${escape(current.evidenceLink)}`}</p>` +
    pending +
    history +
    `</div>`
  );
}

export function executionPlanHtml(document: string, compact = false): string {
  const parsed = parseExecutionPlanDocument(document);
  if (!parsed.ok) return `<pre class="recap plan-doc">${escape(document)}</pre>`;
  const plan = parsed.document;
  const items = (values: string[], ordered = false): string =>
    `<${ordered ? "ol" : "ul"}>${values.map(value => `<li>${escape(value)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`;
  return (
    `<div class="execution-plan${compact ? " execution-plan-compact" : ""}">` +
    `<div class="execution-approach"><span class="approval-label">approach</span><p>${escape(plan.approach)}</p></div>` +
    `<div class="execution-milestones"><span class="approval-label">milestones</span>${items(plan.milestones, true)}</div>` +
    `<div class="execution-support"><div><span class="approval-label">dependencies</span>${items(plan.dependencies)}</div>` +
    `<div><span class="approval-label">risks &amp; mitigations</span>${items(plan.risks)}</div></div>` +
    `<div class="execution-proof"><span class="approval-label">proof of done</span>${items(plan.proof)}</div>` +
    `</div>`
  );
}

/** One plan revision, its document verified before a byte renders — the
 * same verify-then-read discipline as `planViewOf`, just carrying the
 * ledger row's own facts alongside the text. `id: null` marks the
 * read-only revision-1 projection for a task with no `plan_revision` rows
 * yet (c1). */
export type RevisionDocView = {
  id: number | null;
  revision: number;
  status: PlanRevisionStatus;
  reason: string;
  evidenceLink: string | null;
  author: string;
  kind: PlanRevisionKind;
  authorityKind: "plan-only" | "authority-change";
  changedFields: string[];
  document: string;
  sha256: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

export type PlanRevisionLedgerView = { current: RevisionDocView | null; pending: RevisionDocView | null; history: RevisionDocView[] };

export type MilestoneProgressView = { id: string; description: string; state: MilestoneState; note: string | null };

/** The revision batch a task's approval screen restates, or the named reason it cannot. */
export type RevisionView =
  | {
      sourceTask: string;
      sourceRun: number;
      /** What kind of brief this is — annotations, a CI repair, a criterion repair. */
      kind: "annotations" | "ci-repair" | "criterion-repair";
      comments: { path: string | null; line: number | null; note: string; author: string }[];
      /** The lineage and ACTUAL terms (contract handoff task 2), read from
       * the child's own rows — the same projection chat and the approval
       * card restate. */
      lineage: RevisionLineage | null;
    }
  | { problem: string };

/**
 * A revision's lineage and ACTUAL terms, in the same words on the task
 * page, the approval card, and chat (contract handoff task 2): which
 * source and build it revises, the ancestry to its root, the terms the
 * child really carries (read from its own scope — never restated from the
 * brief), what is re-resolved for THIS approval, what never inherits, and
 * — when the task continues a repair chain — the attempts used against
 * the signed cap.
 */
export function revisionLineageWords(lineage: RevisionLineage): string[] {
  const words: string[] = [];
  if (lineage.problem !== undefined) words.push(`lineage verification gap: ${lineage.problem}; no automatic repair allowance can be inferred`);
  const chain = lineage.ancestors.length > 1 ? ` · lineage ${lineage.ancestors.join(" → ")}` : "";
  words.push(`revises ${lineage.sourceTask}${lineage.sourceRun === null ? "" : ` (build #${lineage.sourceRun})`}${chain}`);
  if (!lineage.sourceHadScope) {
    words.push("the source had no scope — nothing was inherited; the placeholder rubric waits for a real one");
  } else if (lineage.terms !== null) {
    const terms = lineage.terms;
    words.push(
      `inherited terms, as they stand now: ${qualityModeTitle(terms.qualityMode)} quality · ` +
        `${terms.permissionMode === "bypassPermissions" ? "full access" : "auto permissions"} · ` +
        `${terms.budgetMicrousd === null ? "no attempt cap" : `$${(terms.budgetMicrousd / 1_000_000).toFixed(2)} attempt cap`} · ` +
        `${terms.exclusions ? "its exclusions" : "no exclusions"} · ${terms.touches === 0 ? "any path" : `${terms.touches} path limit${terms.touches === 1 ? "" : "s"}`} · ` +
        `${terms.criteria} criteri${terms.criteria === 1 ? "on" : "a"}${terms.routeOverrides === 0 ? "" : ` · ${terms.routeOverrides} agent override${terms.routeOverrides === 1 ? "" : "s"}`}`,
    );
  }
  words.push("re-resolved for this approval: the agents route — a yes on the source never covers it");
  words.push("never inherited: the source's approval, publication and merge grants");
  if (lineage.repair !== null) {
    const repair = lineage.repair;
    words.push(
      `repair chain rooted at ${repair.rootTask}: ${repair.attemptsUsed} attempt${repair.attemptsUsed === 1 ? "" : "s"} used` +
        `${repair.cap === null ? " — each further attempt needs your yes" : ` of ${repair.cap} automatic · ${repair.remaining} remaining`}` +
        `${repair.thisAttempt === null ? "" : ` · this is attempt ${repair.thisAttempt}`}${repair.via === null ? "" : ` · continued through ${repair.via}`}`,
    );
  }
  return words;
}

export function revisionLineageHtml(lineage: RevisionLineage | null): string {
  if (lineage === null) return "";
  return `<ul class="meta revision-lineage">${revisionLineageWords(lineage).map(one => `<li>${escape(one)}</li>`).join("")}</ul>`;
}

export function taskBodyParts(data: {
  /** Until the first Ready result: show the task's way there (onboarding). */
  guide?: boolean;
  /** What the last attempt missed and what to change, shown when the task failed. */
  failure?: FailureExplanation | null;
  /** Run checks in place, for a status row that offers it. */
  runChecks?: { action: string; level: "quick" | "full"; returnTo: string } | null;
  /** The demo database: no check runs here, and the Checks row says so. */
  demo?: boolean;
  assignment?: AssignmentSnapshot | null;
  checkProgress?: CheckProgress | null;
  rootId?: string;
  rootTitle?: string;
  history?: string;
  versionLabel?: string | null;
  status?: DisplayStatus;
  task: Task;
  /** Shared read-side lifecycle answer; the atomic claim still re-proves it. */
  dispatch?: DispatchDiagnosis | null;
  /** v52: the exact-run Stop / Stopping / Resume control. */
  control?: TaskControlView;
  strikes: number;
  /** v102: who filed it, and the project's approval rules as they bear on this task (null: none apply). */
  filer?: { name: string | null; kind: string } | null;
  budgetHold?: string | null;
  policyHold?: string | null;
  approvalRules?: { words: string; votes: string[]; needsTwo: boolean } | null;
  plan: "requested" | "drafted" | null;
  planDocument: string | null;
  planAuto?: boolean;
  /** Hash of the verified plan artifact currently shown. */
  planSha?: string | null;
  /** The drafted plan's contract record (contract handoff, task 1). */
  planContract?: PlanContractView | null;
  /** Adaptive execution plans (v44): the revision ledger and live milestone
   * projection — null for a task with no plan at all. */
  planRevisions?: PlanRevisionLedgerView | null;
  milestoneProgress?: MilestoneProgressView[] | null;
  /** v34: what this task delivers, and the scout's report when one exists. */
  deliverable?: "branch" | "report";
  report?: ReportView | null;
  revision?: RevisionView | null;
  /** v40: this task's own place in a bounded repair chain — computed
   * independent of `completion` (a freshly drafted, unapproved repair has
   * no run yet, so it must not wait for one to say so). `completion`'s own
   * branches render it too, once a run exists; this is the fallback for
   * the moment before that, so "awaiting approval" is never invisible. */
  repairChain?: RepairChainRow | null;
  publication?: Publication | null;
  repo: string | null;
  /** Immutable filing provenance (v12) — the approver sees which door
   * filed this (console, cli, intake, template:<name>) at the yes. */
  filedVia?: string | null;
  /** Coordinator provenance when an agent filed this; null otherwise. */
  coordinator?: { label: string; filedAgo: string | null } | null;
  holds: Hold[];
  claimed: boolean;
  /** What this task waits for — blockers outside this console's ceiling
   * are named but carry no state and no link. */
  waitsFor?: { id: string; title: string | null; state: string | null; admitted: boolean }[];
  /** Open tasks a "wait for" select may offer (this console's view only). */
  waitCandidates?: { id: string; title: string }[];
  /** The run whose lease is the CURRENT live claim — computed by the data
   * layer; the renderer never guesses liveness from a null outcome. */
  liveRunId?: number | null;
  /** What the agent did last on that live run, and when (task-activity.ts). */
  activity?: RunActivity | null;
  /** Workers that are both alive and authorized for this task's project. */
  worker?: { answering: number; registered: number; totalRegistered: number; lastHeard: string | null };
  /** Unmet capabilities that keep this exact task out of dispatch. */
  gaps?: Gap[];
  /** Whether this serve asserted its runner — the live file view exists. */
  peekable?: boolean;
  /** Where the task stands in its own column, from the data layer. */
  position?: { position: number; total: number; column: string | null } | null;
  /** The tracker item this task stands for, when it is external work. */
  mirror?: ExternalMirror | null;
  scope: Scope | null;
  /** What the approval nonce/digest bind: scope digest, or the joint fingerprint. */
  approvalDigest?: string | null;
  spendDefaults?: { buildPerRunMicrousd: number | null } | null;
  /** Installation starting value for a task that has no profile yet. */
  permissionDefault?: UnattendedPermissionMode;
  /** Durable choice for this task, when one was explicitly made. */
  permissionMode?: UnattendedPermissionMode | null;
  /** Installation starting value and this task's explicit evidence depth. */
  qualityDefault?: QualityMode;
  qualityMode?: QualityMode | null;
  /** The phase route (v47) and whether this session may edit it. */
  route?: RouteView | null;
  canEditRoute?: boolean;
  runs: Run[];
  /** Proof produced by the newest finished attempt. The two booleans are
   * machine facts about immutable, hash-addressed artifacts — never inferred
   * from the agent's prose. `proofVerdict` is the closed machine-authored
   * verdict (Priority 2), computed once at completion and never re-derived
   * here — null only for a run that predates the proof system. */
  completion?: {
    runId: number;
    outcome: string | null;
    hasTerminalDiff: boolean;
    hasHandoff: boolean;
    proofVerdict: ProofVerdict | null;
    /** v40: the verdict BEFORE an independent reviewer's judgements were
     * folded in — null when no review has folded (every run before this
     * migration, and every run no review has touched). */
    machineVerdict: ProofVerdict | null;
    proofReasons: string[];
    proofMatrix: CriterionMatrixRow[];
    proofMatrixLinks: EvidenceLinkMap;
    proofAccepted: boolean;
    /** v51: the run's signed quality mode — the policy semantic coverage is
     * read under (default: review optional; strict: review required). */
    qualityMode?: "default" | "strict";
    /** v40: this run's own place in a bounded repair chain, if any. */
    repairChain: RepairChainRow | null;
    /** v50: every root review attempt of this result and what the
     * allowance still admits; null when no review was ever asked for. */
    reviewRetry?: ReviewRetryState | null;
    /** The same review, as the shared projection reads it (review fixes). */
    review?: ReviewFacts | null;
    /** Priority 2's concise, shared result package. */
    receipt: CompletionReceiptView | null;
  } | null;
  /** v50: whether this session may ask for a review retry (an approver's
   * browser session — the same standing `task review` demands). */
  canRetryReview?: boolean;
  decisions: Decision[];
  incidents: Incident[];
  /** Pending coordinator proposals on this task (mate arc v3), with the decisions their answer cards name. */
  coordinatorProposals?: { rows: CoordinatorProposal[]; decisions: Map<number, Decision>; now: Date } | null;
  /** Operator steering notes (arc 1), delivery state included. */
  steering?: SteerNote[];
  /** The publication grant the publisher would act under — from
   * publicationGrantFor(repo) only; null when none, or no project. */
  grant?: PublicationGrant | null;
  /** The pull request opened through Complete (its state, link, CI and merge), or the offer to open one for a
   * result already marked complete; null when neither applies. */
  pullRequest?: TaskPullRequest | null;
  /** The task's whole family (the original and its revisions) and every attempt across it, for the thread. */
  family?: { root: { id: string; title: string; createdAt: string; goal?: string | null }; versions: { id: string; title: string; state: string }[]; runs: (Run & { taskId: string })[] } | null;
  /** Degraded composition (slice 1c). "sensitive": the page carries a
   * password ceremony, so no live poller runs, the attempt panel is a
   * static line, and open decisions render link-only — decided by the page
   * wrapper from the rendered body itself. "pane": the body is embedded in
   * the workbench's selected-task pane, which carries no run pollers, so
   * only the attempt panel degrades. */
  degraded?: "sensitive" | "pane";
  csrf: string;
  nonce: string;
  scopeDraft?: URLSearchParams;
  /** Arrived to edit the plan (?edit=plan): the approval sheet opens its editor. */
  editPlan?: boolean;
  cancelDraft?: string;
  problem: string | null;
  now: Date;
}): { html: string; view: BrowserTaskView } {
  const { task, scope } = data;
  const stopControlsActive = data.control !== undefined && ["stopping", "paused", "review-stopped"].includes(data.control.kind);
  // The result's shared status (workspace package 1): the same projection
  // the Work row, the focused chat, and the review cockpit render for this
  // run, so a done task with failed or missing proof never wears a bare
  // "done" badge here while another surface says otherwise.
  // The receipt re-verified the stored bytes (repair 2026-09-14), so the
  // box wears the receipt's own status whenever a receipt exists — the
  // two never disagree on one page about damaged evidence.
  const resultStatus =
    task.state !== "done"
      ? null
      : data.completion?.receipt !== null && data.completion?.receipt !== undefined
      ? receiptStatusOf(data.completion.receipt)
      : resultStatusOf(
          data.completion === null || data.completion === undefined
            ? null
            : {
                runId: data.completion.runId,
                role: data.runs.find(one => one.id === data.completion?.runId)?.role ?? null,
                outcome: data.completion.outcome,
                verdict: data.completion.proofVerdict,
                reasons: data.completion.proofReasons,
                accepted: data.completion.proofAccepted,
                recordComplete: data.completion.hasHandoff && data.completion.hasTerminalDiff,
                review: data.completion.review ?? null,
              },
          publicationFactsOf(data.publication ?? null),
        );
  const status = data.status ?? workStatusOf({ id: task.id, title: task.title, repo: data.repo, state: task.state, updatedAt: task.updatedAt, dispatch: data.dispatch ?? null, result: null, publication: null, liveRunId: data.liveRunId ?? null, control: data.control ?? { kind: "none" } }, resultStatus ?? undefined);
  // A review in flight leads the status box too (review fixes, finding
  // 4): the box keeps its recorded-verdict sentence as history under the
  // review's own words, and reads neutral rather than ok/problem while the
  // machine is still deciding.
  const inReview = resultStatus !== null && REVIEW_TOKENS.has(resultStatus.token);
  const act = (verb: string, label: string, extra = ""): string =>
    [
      `<form method="post" action="${taskHref(task.id)}/${verb}" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      extra,
      `<button type="submit">${escape(label)}</button>`,
      `</form>`,
    ].join("");

  // The active attempt panel (slice 1c): the run whose lease is the task's
  // CURRENT claim, named by its one unambiguous identity — build number and
  // worker (runsFor mixes roles newest-first, so an "attempt N" ordinal is
  // undefined and not used). The live peek and transcript embed here,
  // polled from the RUN's own authenticated fragments; a serve that never
  // asserted its runner says so in the same words the run page uses; a
  // page carrying a password ceremony degrades to the static line.
  const liveRunId = data.liveRunId ?? null;
  const liveRun = liveRunId === null ? undefined : data.runs.find(one => one.id === liveRunId);
  const liveHistoryRunId = data.control?.kind === "stop" && data.control.role === "reviewer" && data.completion?.review?.reviewerAlive === true ? data.control.run : liveRunId;
  const degraded = data.degraded === "sensitive";
  const attemptPanel = (() => {
    if (liveRunId === null || liveRun === undefined) return "";
    const minutes = Math.max(0, Math.round((data.now.getTime() - new Date(liveRun.startedAt).getTime()) / 60_000));
    const head =
      `<p><strong>Build #${liveRun.id} · ${escape(liveRun.runner)} · running ` +
      `<time data-elapsed-since="${escape(liveRun.startedAt)}">${minutes}m</time></strong></p>`;
    const door = `<p class="row"><a href="/r/${liveRun.id}">full build view →</a></p>`;
    if (data.degraded !== undefined) {
      return `<div class="card attempt-live" data-live-run="${liveRun.id}">${head}` +
        `<p class="meta">${data.degraded === "sensitive" ? "This page carries a password ceremony, so the live view stays on the build page" : "The live view is on the build page"}</p>${door}</div>`;
    }
    // With the live file view off there is nothing live to show here: no panel (the build's own page says why).
    if (data.peekable !== true) return "";
    const peek =
      `<p class="meta">What is changing right now</p>` +
      `<div id="run-peek"><p class="meta">Watching\u2026 the first look lands within 15 seconds</p></div>` +
      `<p class="meta" id="run-peek-stamp"></p>`;
    const transcript =
      liveRun.provider !== "claude"
          ? `<p class="meta">The live transcript needs the claude harness for now \u2014 this build runs on ${escape(liveRun.provider)}</p>`
          : `<p class="meta">What the agent is saying · display only \u2014 this is not evidence, and the machine running the agent could alter it</p>` +
            `<pre id="live-transcript" class="mono" style="max-height:18rem;overflow:auto;white-space:pre-wrap"></pre>` +
            `<p class="meta" id="live-transcript-state"></p>`;
    return `<div class="card attempt-live" data-live-run="${liveRun.id}">${head}${peek}${transcript}${door}</div>`;
  })();

  // One truthful answer to the first question on a queued task: "will this
  // run?" The badge alone cannot distinguish approval, dependency,
  // capability, and worker gates. This card does, in priority order, and
  // gives the nearest concrete repair rather than making the operator infer
  // it from the rest of the page.
  const dispatchStatus = (() => {
    // data-work-status is the shared projection's token (package 1) —
    // the same one the Work row, chat, and cockpit carry for this task.
    const workToken = resultStatus?.token ?? data.dispatch?.code ?? "unknown";
    // A diagnosis under Task options: the exact technical reason, one tap
    // away from the shared headline (task-status.ts). Red only when that
    // headline is Failed.
    const headline = status.label;
    const box = (kind: "ok" | "problem", title: string, detail: string, code?: string, controls = ""): string =>
      `<div class="${kind === "problem" && !inReview && headline === "Failed" ? "problem" : "answered"} dispatch-status" id="run-status" data-dispatch-status="${escape(code ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}" data-work-status="${escape(workToken)}">` +
      `<div class="dispatch-copy"><strong>${escape(inReview ? "Recorded checks" : title)}</strong><span class="meta">${detail}</span></div>${controls}</div>`;

    if (task.state !== "done") {
      const diagnosis = data.dispatch ?? null;
      if (diagnosis === null) return box("problem", "Dispatch unknown", "Refresh this task before relying on its scheduler state.", "unknown");
      if (diagnosis.code === "running" && liveRun !== undefined) {
        return box("ok", diagnosis.summary, `Worker <span class="mono">${escape(liveRun.runner)}</span> owns <a href="/r/${liveRun.id}">build #${liveRun.id}</a>.`, diagnosis.code);
      }
      const blocker = diagnosis.blockerTaskId === null
        ? null
        : (data.waitsFor ?? []).find(one => one.id === diagnosis.blockerTaskId);
      const action = (() => {
        switch (diagnosis.action) {
          case "start-worker": return "";
          case "write-scope": return ` <a href="#scope">Write the success contract</a> or use <strong>plan first</strong>.`;
          case "select-agent": return ` <a href="#scope">Choose an available provider and model</a>.`;
          case "approve-scope": return ` <a href="#approve">Review and sign the exact scope</a>.`;
          case "answer-decision": return ` <a href="#decisions">Answer the waiting question</a>.`;
          case "unhold": return ` Use <strong>Remove hold</strong> when it can continue.`;
          // The reason is the detail itself; Retry is the status card's own act, said once.
          case "retry-task": return "";
          case "repair-capability": return ` <a href="/caps">Repair the requirement</a>.`;
          case "repair-dependency":
            return blocker?.admitted === true
              ? ` <a href="${taskHref(blocker.id)}">Review that task</a>.`
              : "";
          default: return "";
        }
      })();
      const repairControls = (() => {
        if (diagnosis.action !== "repair-dependency" || blocker == null || data.csrf === "") return "";
        const endpoint = `${taskHref(task.id)}/repair-dependency`;
        const common =
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
          `<input type="hidden" name="blocker" value="${escape(blocker.id)}">`;
        const retry = blocker.admitted && blocker.state === "failed"
          ? `<form method="post" action="${endpoint}" class="dependency-repair-retry">${common}<input type="hidden" name="operation" value="retry"><button type="submit">Try that task again</button></form>`
          : "";
        const unlink =
          `<form method="post" action="${endpoint}" class="dependency-repair-unlink">${common}<input type="hidden" name="operation" value="unlink"><button type="submit" class="quiet">Continue without it</button></form>`;
        const standing = new Set((data.waitsFor ?? []).map(one => one.id));
        const replacements = (data.waitCandidates ?? []).filter(one => !standing.has(one.id));
        const replace = replacements.length === 0
          ? ""
          : `<form method="post" action="${endpoint}" class="dependency-repair-replace">${common}<input type="hidden" name="operation" value="replace">` +
            `<label class="dependency-repair-label">Choose another task that must finish first<select name="replacement" aria-label="another task that must finish first">${replacements.map(one => `<option value="${escape(one.id)}">${escape(one.title)}</option>`).join("")}</select></label>` +
            `<button type="submit" class="quiet">Wait for selected task</button></form>`;
        return `<div class="dependency-repair-actions" aria-label="ways to continue this task"><p class="meta dependency-repair-help">Choose another task that must finish first, or let this task continue without it.</p>${retry}${replace}${unlink}</div>`;
      })();
      const recoveryControl = (() => {
        if (stopControlsActive || diagnosis.action === null || diagnosis.action === "repair-dependency") return "";
        if (diagnosis.action === "start-worker") {
          const firstConnection = diagnosis.code === "no-worker-registered";
          return (
            `<details class="dispatch-recovery" open><summary>${escape(dispatchActionLabel(diagnosis))}</summary><div class="dispatch-recovery-body">` +
            (firstConnection
              ? `<p>Toolroll is open, but this project has not been connected to a builder yet.</p><p>On the machine where the project lives, open that folder and run:</p>`
              : `<p>Toolroll is open, but this project's builder stopped checking in. Reopen Toolroll on the machine where the project lives.</p><p>If you normally start it from a terminal, open the project folder and run:</p>`) +
            `<code class="dispatch-recovery-command">toolroll up</code>` +
            (firstConnection
              ? `<p class="meta">This is the normal start command: it opens the app, connects the project, and starts its builder. Keep Toolroll running; approved tasks begin automatically.</p>`
              : `<p class="meta">This task resumes automatically when the builder reconnects. You do not need to file or approve it again.</p>`) +
            `<p><a href="/system">See connection status →</a></p></div></details>`
          );
        }
        // Never a link to this page's own acts: Retry sits on the status card and below.
        const href = diagnosis.action === "retry-task" ? null : taskRecoveryHref(task.id, diagnosis);
        return href === null ? "" : `<a class="button-link dispatch-action-link" href="${href}">${escape(dispatchActionLabel(diagnosis))}</a>`;
      })();
      const positive = diagnosis.code === "running" || diagnosis.code === "ready" || diagnosis.code === "planning-ready" || diagnosis.code === "scouting-ready";
      const status = diagnosis.code === "ready" ? "ready-to-run" : diagnosis.code;
      const repairingDependency = diagnosis.action === "repair-dependency" && blocker !== null;
      const dependencyDetail =
        blocker?.admitted === true
          ? `This task was waiting for <strong>${escape(blocker.title ?? blocker.id)}</strong>, but that task was ${escape(blocker.state ?? "stopped")}.${action}`
          : "This task is waiting for other work that did not finish.";
      return box(
        positive ? "ok" : "problem",
        repairingDependency ? "Choose what happens next" : diagnosis.summary,
        repairingDependency ? dependencyDetail : `${escape(diagnosis.detail)}${action}`,
        status,
        repairControls || recoveryControl,
      );
    }

    if (task.state === "done") {
      const proof = data.completion ?? null;
      if (proof === null || resultStatus === null) {
        return box("problem", "Marked done without a build record", "The task is done, but no finished attempt is recorded, so there is nothing to verify.", "no-build-record");
      }
      if (data.assignment?.receipt?.runId === proof.runId) {
        const accepted = data.assignment.receipt.proofAcceptance;
        return `<details class="dispatch-proof-details"><summary>Previous assessment</summary><div class="dispatch-proof-body">` +
          `<p class="meta">Saved assessment history. Current task status and checks are shown above.</p>` +
          (accepted === null ? "" : `<p class="meta">Accepted with an exception by ${escape(accepted.approver)}. Check results are unchanged.${accepted.note === null ? "" : ` ${escape(accepted.note)}`}</p>`) +
          (proof.proofReasons.length === 0 ? "" : `<ul>${[...new Set(proof.proofReasons.map(plainReasonWords))].map(reason => `<li>${escape(reason)}</li>`).join("")}</ul>`) +
          criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks, verdict: proof.proofVerdict }) +
          semanticCoverageHtml(proof.proofMatrix, proof.qualityMode ?? "default") + `</div></details>`;
      }
      // v50: the independent review's own card — attempt counts, what is
      // running or queued, the latest failure in words, and the ONE
      // explicit act (Retry review) exactly when the allowance admits it.
      const reviewCard = reviewRetryPanel(task.id, proof.runId, proof.reviewRetry ?? null, {
        csrf: data.csrf,
        canAct: data.canRetryReview === true,
        returnTo: null,
      });
      const withReview = (html: string): string => reviewCard + html;
      // A no-change conclusion never owes a proof — there is no diff to
      // check acceptance criteria or a changed-path claim against — so it
      // keeps reading on the two presence facts alone, exactly as before
      // the proof system existed (the "attested floor" this preserves).
      if (proof.outcome === "no-change") {
        const missing = [proof.hasHandoff ? null : "agent handoff", proof.hasTerminalDiff ? null : "terminal diff"]
          .filter((one): one is string => one !== null);
        return withReview(missing.length > 0
          ? box(
              "problem",
              resultStatus.label,
              `<a href="/r/${proof.runId}">Build #${proof.runId}</a> concluded no change was needed, but its ${escape(missing.join(" and "))} is missing.`,
              resultStatus.token,
            )
          : box(
              "ok",
              resultStatus.label,
              `<a href="/r/${proof.runId}">Build #${proof.runId}</a> concluded no change was needed; its handoff and machine-captured diff are on record.`,
              resultStatus.token,
            ));
      }
      // A built run's verdict is the machine's own — computed once at
      // completion by adjudicate() (Priority 2), never re-derived here.
      // Acceptance changes the CLASS (problem → ok) and the words, never
      // the underlying token: the surfaces still agree on what happened.
      const accepted = proof.proofAccepted;
      const humanReview = manualReviewOnly({ verdict: proof.proofVerdict ?? "", reasons: proof.proofReasons, matrix: proof.proofMatrix });
      // Accepting contradictory or incomplete evidence is an explicit,
      // recorded exception—not the ordinary magenta approval ceremony.
      const acceptForm =
        accepted || data.csrf === ""
          ? ""
          : `<details class="proof-exception"><summary>${humanReview ? "Accept result" : "Accept with exception"}</summary>` +
            `<form method="post" action="${taskHref(task.id)}/accept-proof" class="proof-exception-form">` +
              `<input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="run" value="${proof.runId}">` +
              `<input type="text" name="note" maxlength="500" placeholder="${humanReview ? "What did you verify?" : "Why is this safe to accept?"}" aria-label="${humanReview ? "review note" : "exception reason"}" required>` +
              `<button type="submit">${humanReview ? "Accept result" : "Accept with exception"}</button></form></details>`;
      // v40: the machine's own pre-fold verdict, restated when a review
      // moved it — "the machine attested it; reviewer:codex contradicted
      // c2" — never pretending the machine always disagreed.
      const machineNote =
        !reviewConflict(proof.proofMatrix, proof.machineVerdict, proof.proofVerdict)
          ? ""
          : `<p class="meta">An independent review found conflicting evidence.</p>`;
      const chainHtml = repairChainHtml(proof.repairChain);
      // v51: semantic coverage sits beside the matrix, never inside the
      // verdict word — what the independent reviewer settled, under the
      // signed policy, with every context gap named.
      const coverageHtml = semanticCoverageHtml(proof.proofMatrix, proof.qualityMode ?? "default");
      const proofDetails =
        proof.proofMatrix.length === 0 && machineNote === "" && chainHtml === ""
          ? ""
          : `<details class="dispatch-proof-details"><summary>${proof.proofMatrix.length === 0 ? "Verification details" : `${proof.proofMatrix.length} requirement${proof.proofMatrix.length === 1 ? "" : "s"}`} · View details</summary>` +
            `<div class="dispatch-proof-body">${criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks, verdict: proof.proofVerdict })}${coverageHtml}${machineNote}${chainHtml}</div></details>`;
      // The publication fact is separate from the evidence fact: a PR or
      // an observed merge is named from its record; nothing is "deployed".
      const publicationWords =
        (data.publication === null || data.publication === undefined ? "" : ` ${escape(receiptPublicationWords(publicationFactsOf(data.publication)))}`) +
        // Shortened records say so here too (repair 2026-09-14).
        (proof.receipt === null ? "" : ` ${escape(evidenceShortenedWords(proof.receipt.facts.evidenceHealth))}`).replace(/ $/, "");
      // Damaged evidence (repair 2026-09-14): the box wears the receipt's
      // own problem words — never "ok" with a verdict that predates the damage.
      if (resultStatus.token === "evidence-damaged") {
        return withReview(
          box("problem", resultStatus.label, `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished. ${escape(resultStatus.detail)}${publicationWords}`, "evidence-damaged") +
            `<div class="proof-review-actions"><a class="button-link" href="/r/${proof.runId}">Review the evidence problems</a></div>` +
            proofDetails,
        );
      }
      if (proof.proofVerdict === "verified" && !accepted) {
        const recovered = verificationRecovered(proof.proofReasons);
        return withReview(box(
          "ok",
          resultStatus.label,
          (recovered
            ? `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished. <span data-automatic-recovery="succeeded">Toolroll ran the approved setup automatically, then the project check passed.</span>`
            : `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished as ${escape(proof.outcome ?? "terminal")}, and the repository's approved verification command passed against it.`) + publicationWords,
          dispatchStatusToken("verified"),
        ) + proofDetails);
      }
      if (proof.proofVerdict === "attested" && !accepted) {
        return withReview(box("ok", resultStatus.label, `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished as ${escape(proof.outcome ?? "terminal")}. No independent project check ran: the checks listed are the agent's own report, and each item below is labeled by source.${publicationWords}`, dispatchStatusToken("attested")) + proofDetails);
      }
      // A refuted, short, or absent verdict — and an accepted one, which
      // stays visibly an exception: the words never say checks passed.
      const machineToken = proof.proofVerdict === "refuted" ? dispatchStatusToken("refuted") : dispatchStatusToken("short");
      return withReview(
        box(
          accepted ? "ok" : "problem",
          resultStatus.label,
          `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished. ${escape(verificationExplanation(proof.proofVerdict, proof.proofReasons))}${accepted ? " An approver accepted it by hand; that acceptance leaves the machine's verdict above unchanged." : ""}${publicationWords}`,
          machineToken,
        ) + `<div class="proof-review-actions"><a class="button-link" href="${reviewHref(task.id)}">${accepted ? "Review the recorded exception" : resultStatus.action?.label ?? "Review evidence"}</a>${acceptForm}</div>` + proofDetails,
      );
    }
    return box("problem", "Dispatch unknown", "Refresh this task before relying on its scheduler state.", "unknown");
  })();

  // Operator steering (arc 1): notes for the agent, each wearing exactly
  // where it stands — waiting, attached, proven delivered, or superseded.
  const steering = data.steering ?? [];
  const steerState = (one: SteerNote): string =>
    one.authorshipState !== "verified"
      ? "recorded before steering required a credential — never delivered"
      : one.supersededAt !== null
      ? "the task ended before this landed"
      : one.deliveredAt !== null
        ? `reached build #${one.attachedRun}`
        : one.attachedRun !== null
          ? `attached to build #${one.attachedRun} — delivery not yet proven`
          : "waiting for the next attempt";
  const steerRows = steering
    .map(
      one =>
        `<p class="row"><span class="meta">${escape(one.author)} · ${whenTime(one.createdAt)} · ${escape(steerState(one))}</span> ` +
        `${escape(one.note)}</p>`,
    )
    .join("\n");
  const steerForm =
    data.csrf === "" || task.state === "done" || task.state === "cancelled"
      ? ""
      : `<form method="post" action="${taskHref(task.id)}/steer" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<input type="text" name="note" placeholder="guidance for the next attempt" aria-label="steering note" style="width:100%;max-width:28rem">` +
        `<button type="submit">Steer</button></form>` +
        `<p class="meta">Lands when the next attempt starts — a running agent is not interrupted, and a note cannot widen the approved scope</p>`;
  const steeringCard =
    steerRows === "" && steerForm === "" ? "" : `<h2>Steering</h2>${steerRows}${steerForm}`;

  const holds =
    data.holds.length === 0
      ? ""
      : `<h2>Holds</h2>` +
        data.holds
          .map(
            hold =>
              `<p class="row">${escape(holdOwnerWords(hold.ownerKind))} — ${escape(hold.reason)}` +
              `${hold.until === null ? "" : ` <span class="meta">until ${whenTime(hold.until)}</span>`}</p>`,
          )
          .join("\n") +
        `<p class="meta">Only your hold can be lifted here — waits caused by questions, incidents, or retry delays clear on their own</p>`;

  const approval = approvalOf(scope);
  // A refused save from the sheet's in-place editor reopens that editor with
  // its draft; the full scope form below stays as it was.
  const inlineScopeDraft = data.scopeDraft?.has("requirement-new") === true;
  const scopeDraft = inlineScopeDraft ? undefined : data.scopeDraft;
  const scopeCard =
    scope === null
      ? `<p class="meta">No scope proposed — nothing builds this until one is approved</p>`
      : [
          `<div class="card">`,
          `<p><strong>Goal</strong></p><p class="recap">${escape(scope.goal)}</p>`,
          scope.outOfScope === null ? "" : `<p><strong>Not this</strong></p><p class="recap">${escape(scope.outOfScope)}</p>`,
          scope.touches.length === 0 ? "" : `<p class="scope-paths"><strong>Touches</strong> ${scope.touches.map(one => escape(one)).join(", ")}</p>`,
          `<p><strong>Quality</strong> ${escape(qualityModeTitle(scope.qualityMode ?? "default"))}</p>`,
          acceptanceCeremonyHtml(scope.acceptance),
          approval.approved
            ? `<p class="meta scope-seal">Approved by ${escape(approval.by)} · ${whenTime(approval.at)} · <span class="seal">signs ${shortDigest(scope.digest)}</span><span class="so-sr-only"> — approval binds to this exact wording</span></p>`
            : `<p class="meta"><span class="seal">signs ${shortDigest(scope.digest)}</span> — approval binds to this exact wording</p>` +
              `<p class="meta">Not approved${approval.reason === "changed" ? " — approved once, then rewritten" : ""}</p>`,
          `</div>`,
        ].join("\n");

  // The scout's report (mate arc §10): title, summary, the document inert,
  // and each follow-up as a filing the operator makes with one tap. A
  // report that exists but cannot be verified is a named problem, never a
  // blank — the same rule as the revision brief.
  const reportCard =
    data.report === null || data.report === undefined
      ? data.deliverable === "report"
        ? `<div class="card"><p><strong>Scout task</strong> <span class="meta">delivers a report, never a branch — a read-only session investigates the goal and its report appears here when it finishes</span></p></div>`
        : ""
      : !data.report.ok
        ? `<div class="card"><p><strong>The report</strong></p><p class="meta">${escape(data.report.problem)} · <a href="/r/${data.report.run}">run ${data.report.run}</a></p></div>`
        : [
            `<div class="card report">`,
            `<p><strong>${escape(data.report.report.title)}</strong> <span class="meta">the scout's report · <a href="/r/${data.report.run}">run ${data.report.run}</a></span></p>`,
            `<p class="report-summary">${escape(data.report.report.summary)}</p>`,
            reportItemsHtml(data.report.report.items, data.report.shots, data.report.run),
            `<pre class="recap plan-doc">${escape(data.report.report.report)}</pre>`,
            ...(data.report.report.followUps.length === 0
              ? []
              : [
                  `<p><strong>Follow-ups the scout proposes</strong> <span class="meta">each files as a task in this repository; its scope still needs your approval</span></p>`,
                  ...data.report.report.followUps.map(
                    (one, index) =>
                      `<div class="follow-up"><p><strong>${escape(one.title)}</strong></p><p class="meta">${escape(one.goal)}</p>` +
                      (data.csrf === "" || data.repo === null
                        ? `<p class="meta">${data.repo === null ? "this task has no repository — file it by hand" : ""}</p>`
                        : `<form method="post" action="${taskHref(task.id)}/follow-up" class="inline"><input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="index" value="${index}"><button type="submit">File this follow-up</button></form>`) +
                      `</div>`,
                  ),
                ]),
            `</div>`,
          ].join("\n");

  // The plan a planner drafted, when one exists: rendered inert above the
  // approval it proposes. The scope stays the contract; this is the road.
  // Adaptive execution plans (v44): once approved, the CURRENT revision's
  // text displays here — the same document the builder actually reads —
  // rather than the original artifact frozen at approval time; the edit
  // form and its staleness guard stay bound to that original artifact,
  // since editing is a pre-approval act this ledger does not touch.
  const currentRevisionForDisplay = data.planRevisions?.current ?? null;
  const displayedPlanDocument =
    currentRevisionForDisplay !== null && currentRevisionForDisplay.revision > 1
      ? currentRevisionForDisplay.document
      : data.planDocument;
  const displayedPlan = displayedPlanDocument === null ? null : parseExecutionPlanDocument(displayedPlanDocument);
  const planMilestoneCount = displayedPlan !== null && displayedPlan.ok ? displayedPlan.document.milestones.length : null;
  const planStanding =
    currentRevisionForDisplay !== null && currentRevisionForDisplay.revision > 1
      ? `approved · revision ${currentRevisionForDisplay.revision}`
      : approval.approved
        ? "approved"
        : "review before starting";
  // While the approval sheet is open it states any amendment; the plan
  // card does not repeat it (one #contract-amendment on the page).
  const sheetStatesContract = scope !== null && !approval.approved && data.plan === "drafted" && data.dispatch?.action !== "repair-dependency" &&
    !(data.revision != null && "problem" in data.revision) && scope.profileState !== "unresolved" && consentDoorOf(scope, data.route).open;
  const planCard =
    data.planDocument === null
      ? data.plan === "requested"
        ? data.revision != null && !("problem" in data.revision)
          ? `<div class="card planner-status"><span class="planner-orb" aria-hidden="true"></span><p><strong>Updating the plan</strong>` +
            `<span class="meta">Adding your notes to the plan. You approve any change before it builds.</span></p></div>`
          : `<div class="card planner-status"><span class="planner-orb" aria-hidden="true"></span><p><strong>Planning requested</strong>` +
            `<span class="meta">${data.planAuto ? "Automatic approval is enabled for a verified plan that preserves your filed contract. Amendments and unanswered questions still pause." : "The agent is inspecting the repository and drafting the goal, acceptance criteria, and approach. It will ask only if a missing answer changes the work."}</span></p></div>`
        : ""
      : `${approval.approved ? `<details class="card planner-plan planner-plan-collapsed"><summary class="execution-plan-head">` : `<section class="card planner-plan"><div class="execution-plan-head">`}` +
        `<div><span class="eyebrow">execution plan</span><h2>${approval.approved ? `${planMilestoneCount ?? "Full"} step${planMilestoneCount === 1 ? "" : "s"} · open to review` : "How the agent will tackle this"}</h2>` +
        (approval.approved ? `<p class="meta">The agent can adapt this route when evidence changes; your approved outcome stays fixed.</p>` : "") +
        `</div><span class="plan-lock">${planStanding}</span>${approval.approved ? `</summary><div class="planner-plan-body">` : `</div>`}` +
        executionPlanHtml(displayedPlanDocument ?? data.planDocument) +
        (approval.approved || sheetStatesContract ? "" : planContractHtml(data.planContract ?? null, "full")) +
        (data.csrf === "" || data.planSha == null || approval.approved
          ? ""
          : `<details class="plan-editor" id="plan-edit"><summary>Edit plan</summary><form method="post" action="${taskHref(task.id)}/plan-edit">` +
            `<input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="saw-plan" value="${escape(data.planSha)}">` +
            `<label>Plan details <span class="meta">Keep the five headings. Approval locks this version for the build.</span>` +
            `<textarea name="plan-document" rows="14">${escape(data.planDocument)}</textarea></label>` +
            `<button type="submit">Save plan</button></form></details>`) +
        `${approval.approved ? `</div></details>` : `</section>`}`;

  const progressCard = milestoneProgressHtml(data.milestoneProgress);
  const revisionLedgerCard = planRevisionLedgerHtml(data.planRevisions, task.id, data.csrf);

  // The revision batch (M6.8), restated on the SAME screen as the approval
  // it belongs to: the approver sees exactly the comments the brief carries.
  // A brief that cannot be verified is a named problem, never a blank.
  const revisionCard =
    data.revision === null || data.revision === undefined
      ? ""
      : "problem" in data.revision
        ? `<div class="card"><p><strong>Revision brief</strong></p><p class="meta">${escape(data.revision.problem)}</p></div>`
        : [
            `<div class="revision-card" data-revision-feedback>`,
            `<p><strong>${data.revision.kind === "ci-repair" ? "CI repair" : data.revision.kind === "criterion-repair" ? "Criterion repair" : "Revision feedback"}</strong> <span class="meta">from <a href="/r/${data.revision.sourceRun}">build #${data.revision.sourceRun}</a></span></p>`,
            ...data.revision.comments.map(
              one =>
                `<p class="row"><span class="meta">${escape(one.author)}</span> ` +
                `${one.path === null ? "" : `<span class="mono">${escape(one.path)}${one.line === null ? "" : `:${one.line}`}</span> `}` +
                `${escape(one.note)}</p>`,
            ),
            revisionLineageHtml(data.revision.lineage),
            `</div>`,
          ].join("\n");

  // The approval form restates every field the digest binds — an operator
  // approves what is on this form, not what is elsewhere on the page — and
  // requires the token typed again. The session got you here; only the
  // token agrees. The sheet shows the plan open in plain rows with one
  // Approve & start; the rest of the signed terms sit in its Details fold.
  // An unapprovable scope gets the problem and the edit road instead of a
  // password it cannot use.
  const consentDoor = consentDoorOf(scope, data.route);
  const revisionInApproval = scope !== null && !approval.approved && data.plan !== "requested" &&
    scope.profileState !== "unresolved" && consentDoor.open && data.dispatch?.action !== "repair-dependency" &&
    (data.revision == null || !("problem" in data.revision));
  const approveForm =
    scope === null || approval.approved || data.plan === "requested"
      ? ""
      : data.revision !== null && data.revision !== undefined && "problem" in data.revision
        ? `<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: approval is blocked.</strong></p><p class="meta">${escape(data.revision.problem)} — a revision approves only against a brief that verifies</p></div>`
        : scope.profileState === "unresolved"
          ? `<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: its scope cannot be approved yet.</strong></p>` +
            profileWords(scope) +
            `<p class="ceremony-road"><a class="button-link" href="#scope">Edit the scope to fix it →</a></p></div>`
        : !consentDoor.open
          ? consentClosedHtml(task.id, consentDoor, "task")
        : approvalSheetHtml({
          surface: "task",
          action: `${taskHref(task.id)}/approve`,
          csrf: data.csrf,
          nonce: data.nonce,
          digest: data.approvalDigest ?? scope.digest,
          returnTo: null,
          scope,
          planDocument: data.plan === "drafted" ? data.planDocument : null,
          planContract: data.plan === "drafted" ? data.planContract ?? null : null,
          revision: data.revision == null || "problem" in data.revision ? null : data.revision,
          revisionSourceHref: data.revision == null || "problem" in data.revision ? "" : `/r/${data.revision.sourceRun}`,
          repairChain: data.repairChain ?? null,
          route: data.route,
          coordinator: data.coordinator ?? null,
          deliverable: data.deliverable ?? "branch",
          editHref: data.csrf !== "" && data.planSha != null && data.planDocument !== null ? "#plan-edit" : "#scope",
          notNowHref: "/work",
          sticky: data.dispatch?.action === "approve-scope",
          earlier: { active: data.assignment?.earlierActive ?? 0, running: data.assignment?.earlierRunning ?? 0 },
          edit: data.csrf === "" ? null
            : { action: `${taskHref(task.id)}/scope`, draft: inlineScopeDraft ? data.scopeDraft ?? null : null, problem: inlineScopeDraft ? data.problem : null,
              open: data.editPlan === true, stepsHref: data.planSha != null && data.planDocument !== null ? "#plan-edit" : null },
        });

  const scopeForm = [
    `<details${scope === null || scopeDraft !== undefined ? " open" : ""}><summary>${scope === null ? "Write the scope" : "Edit the scope"}${
      approval.approved ? " (editing voids the approval)" : ""
    }</summary>`,
    `<form method="post" action="${taskHref(task.id)}/scope" class="scope-editor">`,
    scopeDraft === undefined || data.problem === null ? "" : `<div class="problem" role="alert" id="scope-error">${escape(data.problem)}</div>`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="sawDigest" value="${escape(scopeDraft?.get("sawDigest") ?? scope?.digest ?? "")}">`,
    `<label>Goal<textarea name="goal" rows="3"${scopeDraft === undefined ? "" : ' autofocus aria-describedby="scope-error"'}>${escape(scopeDraft?.get("goal") ?? scope?.goal ?? "")}</textarea></label>`,
    `<label>Not this<textarea name="not" rows="2">${escape(scopeDraft?.get("not") ?? scope?.outOfScope ?? "")}</textarea></label>`,
    `<label>Touches <span class="meta">(one per line)</span><textarea name="touches" rows="2">${escape(
      scopeDraft?.get("touches") ?? (scope?.touches ?? []).join("\n"),
    )}</textarea></label>`,
    `<label>Acceptance <span class="meta">(required — one criterion per line: <code>statement | evidence,kinds | how</code>; evidence kinds are check, screenshot, changed-path, manual-review; id is optional and auto-numbered)</span><textarea name="acceptance" rows="3" placeholder="The button opens the settings panel | screenshot">${escape(
      scopeDraft?.get("acceptance") ?? acceptanceToLines(scope?.acceptance ?? []).join("\n"),
    )}</textarea></label>`,
    (() => {
      const defaults = data.spendDefaults ?? null;
      const budgetPrefill =
        scope?.budgetMicrousd != null
          ? (scope.budgetMicrousd / 1_000_000).toFixed(2)
          : defaults?.buildPerRunMicrousd != null
            ? (defaults.buildPerRunMicrousd / 1_000_000).toFixed(2)
            : "";
      return `<label>Agent-reported usage cap <span class="meta">(optional — leave blank for uncapped subscription work)</span>` +
        `<input type="number" name="budget-usd" step="0.01" min="0.01" value="${escape(scopeDraft?.get("budget-usd") ?? budgetPrefill)}" placeholder="no cap"></label>` +
        `<p class="meta">Claude expresses this limiter in API-equivalent dollars even on a membership. It does not switch the run to API billing.</p>`;
    })(),
    (() => {
      const profileMode: UnattendedPermissionMode | null =
        scope?.profile?.provider === "claude"
          ? scope.profile.permissionArgv === "bypassPermissions" ? "bypassPermissions" : "auto"
          : scope?.profile?.provider === "gemini"
            ? scope.profile.approvalArgv === "yolo" ? "bypassPermissions" : "auto"
            : scope?.profile?.provider === "codex" || scope?.profile?.provider === "openrouter"
              ? scope.profile.sandboxMode === "danger-full-access" ? "bypassPermissions" : "auto"
              : null;
      const selected: UnattendedPermissionMode = scopeDraft?.get("permission-mode") === "bypassPermissions" ? "bypassPermissions" : scopeDraft?.get("permission-mode") === "auto" ? "auto" : data.permissionMode ?? profileMode ?? data.permissionDefault ?? "auto";
      return `<fieldset class="permission-field"><legend>Agent permissions</legend>` +
        permissionModeChoices("permission-mode", selected) +
        `<p class="meta permission-note">This task’s choice is sealed into its scope. Full access prevents permission prompts or sandbox limits from pausing supported unattended agents.</p></fieldset>`;
    })(),
    (() => {
      const selected: QualityMode = scopeDraft?.get("quality-mode") === "strict" ? "strict" : scopeDraft?.get("quality-mode") === "default" ? "default" : scope?.qualityMode ?? data.qualityMode ?? data.qualityDefault ?? "default";
      return `<fieldset class="permission-field"><legend>Quality</legend>` +
        qualityModeChoices("quality-mode", selected) +
        `<p class="meta permission-note">This choice is signed into the scope. Inspect the saved work and actual check results when it is ready. Publication and deployment need their own authorization.</p></fieldset>`;
    })(),
    `<button type="submit">Save scope</button>`,
    `</form></details>`,
  ].join("\n");

  // 41_237 → "41k": token counts read at a glance; exactness lives on the run page.
  const compactCount = (count: number): string =>
    count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);

  // The attempt ledger (M5.5): every attempt with its provider, duration,
  // tokens, and dollars — or the honest word "unmeasured" — so a retry
  // storm reads as the spike it is instead of hiding inside a total.
  const minutesOf = (run: Run): string | null => {
    if (run.finishedAt === null) return null;
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    return ms >= 0 ? `${Math.max(1, Math.round(ms / 60_000))}m` : null;
  };
  const tokensOf = (run: Run): string | null =>
    run.tokensIn === null && run.tokensOut === null
      ? null
      : `${run.tokensIn === null ? "?" : compactCount(run.tokensIn)}/${run.tokensOut === null ? "?" : compactCount(run.tokensOut)} tok`;
  // Ledger rows (slice 1c): the same row grammar as the portfolio's terminal
  // ledger — identity, outcome chip, one mono meta run of provider · model ·
  // duration · tokens · measured-or-unmeasured cost.
  const runs =
    data.runs.length === 0
      ? ""
      : `<h2>Attempts</h2>` +
        data.runs
          .map(run => {
            const bits = [
              run.provider,
              run.model,
              minutesOf(run),
              tokensOf(run),
              runCostWords(run, run.id === liveRunId),
              run.parentRun !== null ? `↳ of #${run.parentRun}` : null,
            ].filter((bit): bit is string => bit !== null);
            return (
              `<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              runOutcomeBadge(run, run.id === liveHistoryRunId) +
              `${run.reason === null ? "" : ` <span class="meta">${escape(reasonWords(run.reason))}</span>`}` +
              ` <span class="meta mono">${escape(bits.join(" · "))}</span>` +
              `<span class="right meta mono">${whenTime(run.startedAt)}</span></p>`
            );
          })
          .join("\n");

  // ---- the right rail (slice 1c) ------------------------------------------
  // Dollars stated per attempt set, measured or unmeasured in words — a
  // missing figure is never summed as $0.
  const spendWords = (rows: Run[]): string => {
    if (rows.length === 0) return "no attempt yet";
    const measured = rows.filter(one => one.costUsd !== null);
    const dollars = measured.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    const subscription = measured.filter(one => one.authMode === "subscription");
    const subscriptionEquivalent = subscription.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    const metered = measured.filter(one => one.authMode !== "subscription");
    const meteredDollars = metered.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    // Tokens count only where an attempt reported them; a null report is
    // said, never summed as zero (commit-3 review, finding 2).
    const reported = rows.filter(one => one.tokensIn !== null || one.tokensOut !== null);
    const tokens = reported.reduce((sum, one) => sum + (one.tokensIn ?? 0) + (one.tokensOut ?? 0), 0);
    const tokenWords =
      reported.length === 0
        ? "tokens unreported"
        : reported.length < rows.length
          ? `${compactCount(tokens)} tokens from ${reported.length}/${rows.length} attempts`
          : `${compactCount(tokens)} tokens`;
    if (subscription.length > 0) {
      return [
        ...(metered.length > 0 ? [`$${meteredDollars.toFixed(2)} API-key usage`] : []),
        `$${subscriptionEquivalent.toFixed(2)} API-price equivalent from subscription usage (not an API charge)`,
        tokenWords,
        ...(measured.length < rows.length ? [`${rows.length - measured.length} attempt(s) unmeasured`] : []),
      ].join(" · ");
    }
    if (measured.length === rows.length) return `$${dollars.toFixed(2)} · ${tokenWords} · measured`;
    if (measured.length === 0) {
      return reported.length > 0
        ? `unmeasured — ${tokenWords}, no dollar figure reported`
        : rows.some(one => one.id === liveRunId)
          ? "unmeasured so far — the figure lands when the attempt finishes"
          : "not reported";
    }
    return `$${dollars.toFixed(2)} measured across ${measured.length}/${rows.length} attempts — ${rows.length - measured.length} unmeasured · ${tokenWords}`;
  };
  const thisAttempt = liveRun ?? data.runs[0];
  const prop = (key: string, value: string): string =>
    `<p class="row"><span class="meta">${key}</span> <span class="mono">${value}</span></p>`;
  const economics =
    prop("this attempt", escape(thisAttempt === undefined ? "no attempt yet" : spendWords([thisAttempt]))) +
    prop("task total", escape(spendWords(data.runs)));
  // "publishes as": push, open-PR, and merge are INDEPENDENT fields on the
  // grant — each phrased on its own; absent means exactly that.
  const publishesAs = (() => {
    const grant = data.grant ?? null;
    if (data.repo === null) return "no project — no publication grant can apply";
    if (grant === null) return "branch only — publishing is not set up";
    if (grant.publishOn === "complete") {
      return `pull requests to ${grant.githubRepo} into ${grant.base} when completed · ${grant.mergeWhenGreen === true ? "merges when checks pass" : "a person merges"} (${grant.mergeMethod ?? "squash"})`;
    }
    return [
      grant.capabilities.includes("push-branch") ? `may push ${grant.headPrefix}* to ${grant.githubRepo}` : "cannot push",
      grant.capabilities.includes("open-pr") ? `may open a PR against ${grant.base}${grant.draft ? " (draft)" : ""}` : null,
      grant.merge === true ? `may merge${grant.mergeMethod == null ? "" : ` (${grant.mergeMethod})`}` : "cannot merge",
    ].filter((part): part is string => part !== null).join(" · ");
  })();
  const publishesRow = prop("publishes as", escape(publishesAs));
  // The property list (task page pass): worker and attempt, queue place,
  // the scope's standing with its seal, publication, spend — the key
  // facts a reader scans before anything else, in one row grammar.
  const workerRow =
    liveRun !== undefined
      ? prop("worker", `${escape(liveRun.runner)} · <a href="/r/${liveRun.id}">build #${liveRun.id}</a> running`)
      : data.runs[0] !== undefined
        ? prop("last attempt", `<a href="/r/${data.runs[0].id}">${runNoun(data.runs[0])} #${data.runs[0].id}</a> · ${escape(data.runs[0].role === "planner" && data.runs[0].reason === "plan-drafted" ? "planned" : data.runs[0].reason === "interrupted" ? "interrupted" : data.runs[0].id === liveHistoryRunId ? "running" : data.runs[0].outcome ?? "never finished")} · ${escape(data.runs[0].runner)}`)
        : "";
  const queueRow =
    data.position !== null && data.position !== undefined && task.state === "queued"
      ? prop("queue", `${data.position.position} of ${data.position.total}${data.position.column === null ? " in the shared queue" : ` in ${escape(data.position.column)}'s queue`} · <a href="/board?view=order">reorder</a>`)
      : "";
  const scopeRow =
    scope === null
      ? prop("scope", "none yet")
      : approval.approved
        ? prop("approved scope", `<span class="seal">signs ${shortDigest(scope.digest)}</span> · ${escape(qualityModeTitle(scope.qualityMode ?? "default"))} · approved by ${escape(approval.by)} · ${whenTime(approval.at)}`)
        : prop("scope", approval.reason === "changed" ? "rewritten since its approval — needs a new yes" : "not approved");
  const strikesRow = data.strikes > 0 ? prop("strikes", `${data.strikes} failed attempt(s)`) : "";
  const propsCard = `<div class="card props">${workerRow}${queueRow}${scopeRow}${publishesRow}${economics}${strikesRow}</div>`;
  // The same facts for the rebuilt page, row for row.
  const facts: BrowserTaskFact[] = [];
  const lastRun = data.runs[0];
  if (liveRun !== undefined) facts.push({ label: "Worker", parts: [`${liveRun.runner} · `, { label: `build #${liveRun.id}`, href: `/r/${liveRun.id}` }, " running"] });
  else if (lastRun !== undefined) facts.push({ label: "Last attempt", parts: [{ label: `${runNoun(lastRun)} #${lastRun.id}`, href: `/r/${lastRun.id}` },
    ` · ${lastRun.role === "planner" && lastRun.reason === "plan-drafted" ? "planned" : lastRun.reason === "interrupted" ? "interrupted" : lastRun.id === liveHistoryRunId ? "running" : lastRun.outcome ?? "never finished"} · ${lastRun.runner}`] });
  if (data.position !== null && data.position !== undefined && task.state === "queued") {
    facts.push({ label: "Queue", parts: [`${data.position.position} of ${data.position.total}${data.position.column === null ? " in the shared queue" : ` in ${data.position.column}'s queue`} · `, { label: "Reorder", href: "/board?view=order" }] });
  }
  facts.push(scope === null ? { label: "Scope", parts: ["none yet"] }
    : approval.approved ? { label: "Approved scope", parts: [{ seal: `signs ${scope.digest.length <= 12 ? scope.digest : `${scope.digest.slice(0, 12)}…`}` }, ` · ${qualityModeTitle(scope.qualityMode ?? "default")} · approved by ${approval.by}`, ...(approval.at === null ? [] : [" · ", { at: approval.at }])] }
    : { label: "Scope", parts: [approval.reason === "changed" ? "rewritten since its approval — needs a new yes" : "not approved"] });
  facts.push({ label: "Publishes as", parts: [publishesAs] });
  // v102: who asked for it, and what the project's approval rules need.
  if (data.filer != null) facts.push({ label: "Filed by", parts: [data.filer.name === null ? "automation" : data.filer.kind === "coordinator" ? `${data.filer.name}, through a coordinator` : data.filer.name] });
  if (data.approvalRules != null) {
    const votes = data.approvalRules.votes;
    facts.push({ label: "Approval rules", parts: [data.approvalRules.needsTwo && !approval.approved
      ? (votes.length === 0 ? "needs two approvers" : `approved by ${votes.join(", ")} · needs one more`)
      : data.approvalRules.words] });
  }
  // v103: everything an auditor asks about this task, printable or as JSON.
  facts.push({ label: "Audit", parts: [{ label: "Evidence pack", href: `${taskHref(task.id)}/evidence` }] });
  if (data.budgetHold != null) facts.push({ label: "Budget", parts: [`${data.budgetHold} · `, { label: "Spend", href: "/spend" }] });
  if (data.policyHold != null) facts.push({ label: "Policy", parts: [`${data.policyHold} · `, { label: "Policy", href: "/settings/policy" }] });
  // The pull-request card already says this once, with its action.
  if (data.publication !== null && data.publication !== undefined && data.pullRequest?.view == null) {
    const prHref = safePrUrl(data.publication.prUrl), pr = `PR #${data.publication.prNumber ?? "?"}`;
    facts.push({ label: "Published", parts: [prHref === null ? pr : { label: pr, href: prHref },
      ` · ${data.publication.state}${data.publication.remoteState !== null ? ` · ${data.publication.remoteState.toLowerCase()} on GitHub` : ""}${data.publication.lastCheckState !== null ? ` · CI ${data.publication.lastCheckState} at last observation` : " · no checks observed"}`] });
  }
  facts.push({ label: "This attempt", parts: [thisAttempt === undefined ? "no attempt yet" : spendWords([thisAttempt])] });
  facts.push({ label: "Task total", parts: [spendWords(data.runs)] });
  if (data.strikes > 0) facts.push({ label: "Strikes", parts: [`${data.strikes} failed attempt(s)`] });
  // Open decisions as the shared partial — answerable inline when the
  // page is not sensitive; link-only cards otherwise.
  const openDecisions = data.decisions.filter(one => one.state === "open" || one.state === "expired");
  const decisionRail =
    openDecisions.length === 0
      ? ""
      : `<p id="task-questions"><strong>Questions</strong></p>` +
        openDecisions
          .map(decision =>
            degraded
              ? `<div class="decide-card" data-decision-id="${decision.id}"><p class="q">${escape(decision.question)}</p>` +
                `<p class="meta">${escape(oneLineOf(decision.recap, 160))}</p>` +
                `<p class="meta"><a href="/d/${decision.id}">the full question →</a></p></div>`
              : decisionAnswerCard({ ...decision, taskId: task.id, repo: data.repo }, data.csrf, data.now, false),
          )
          .join("\n");
  const rail = [decisionRail, propsCard].filter(part => part !== "").join("\n");

  // Spend by provider, from the same rows — dollars only where a provider
  // measured them, and the unmeasured said in words, never summed as $0.
  const spendCard = (() => {
    if (data.runs.length === 0) return "";
    const byProvider = new Map<string, { runs: number; tokensIn: number; tokensOut: number; costUsd: number; measured: number }>();
    for (const run of data.runs) {
      const entry = byProvider.get(run.provider) ?? { runs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, measured: 0 };
      entry.runs += 1;
      entry.tokensIn += run.tokensIn ?? 0;
      entry.tokensOut += run.tokensOut ?? 0;
      if (run.costUsd !== null) {
        entry.costUsd += run.costUsd;
        entry.measured += 1;
      }
      byProvider.set(run.provider, entry);
    }
    const lines = [...byProvider.entries()].map(([provider, spend]) => {
      const providerRuns = data.runs.filter(run => run.provider === provider);
      const subscriptionRuns = providerRuns.filter(run => run.authMode === "subscription" && run.costUsd !== null);
      const subscriptionEquivalent = subscriptionRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      const meteredRuns = providerRuns.filter(run => run.authMode !== "subscription" && run.costUsd !== null);
      const meteredCost = meteredRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      const dollars = subscriptionRuns.length > 0
        ? [
            ...(meteredRuns.length > 0 ? [`$${meteredCost.toFixed(2)} API-key usage`] : []),
            `$${subscriptionEquivalent.toFixed(2)} subscription API-price equivalent — not an API charge`,
            ...(spend.measured < spend.runs ? [`${spend.runs - spend.measured} unmeasured`] : []),
          ].join(" · ")
        : spend.measured === spend.runs
          ? `$${spend.costUsd.toFixed(2)}`
          : spend.measured === 0
            ? "dollar cost unmeasured"
            : `$${spend.costUsd.toFixed(2)} across ${spend.measured}/${spend.runs} measured`;
      return (
        `<p class="row"><span class="mono">${escape(provider)}</span> ` +
        `<span class="meta">${spend.runs} attempt(s) · ${compactCount(spend.tokensIn)} in / ${compactCount(spend.tokensOut)} out · ${escape(dollars)}</span></p>`
      );
    });
    return lines.join("\n");
  })();

  const decisions =
    data.decisions.length === 0
      ? ""
      : `<h2>Decisions</h2>` +
        data.decisions
          .map(
            decision =>
              `<p class="row"><a href="/d/${decision.id}">${escape(decision.question)}</a> ` +
              `<span class="meta">${escape(decision.state)}${isOverdue(decision, data.now) ? " · overdue" : ""}</span></p>`,
          )
          .join("\n");

  const incidents =
    data.incidents.length === 0
      ? ""
      : `<h2>Incidents</h2>` +
        data.incidents
          .map(one =>
            one.resolvedAt === null
              ? `<p class="row">${escape(incidentWords(one.kind))} ` +
                `<form method="post" action="/i/${one.id}/resolve" class="inline">` +
                `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
                `<button type="submit">Resolve</button></form></p>`
              : `<p class="row meta">${escape(incidentWords(one.kind))} — resolved by ${escape(one.resolvedBy ?? "?")}</p>`,
          )
          .join("\n");

  const stalled =
    task.state === "failed" || data.incidents.some(one => one.resolvedAt === null);
  const dependencyChoiceNeeded = data.dispatch?.action === "repair-dependency";

  // The chain: what this task waits for, editable in place. Blockers
  // outside this console's view are named without state or link — the same
  // redaction the board applies. Adding and removing are ordinary
  // re-proved POSTs; the loop refusal comes back as the problem banner.
  const waitsFor = data.waitsFor ?? [];
  const candidates = (data.waitCandidates ?? []).filter(one => !waitsFor.some(existing => existing.id === one.id));
  const waitRows = waitsFor
    .map(
      one =>
        `<p class="row">${
          one.admitted ? `<a href="${taskHref(one.id)}" class="mono">${escape(one.id)}</a>` : `<span class="mono">${escape(one.id)}</span>`
        }${one.state === null ? "" : ` <span class="badge badge-${escape(one.state)}">${escape(sentenceCase(one.state))}</span>`}` +
        `<form method="post" action="${taskHref(task.id)}/unblock" class="inline">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<input type="hidden" name="on" value="${escape(one.id)}">` +
        `<button type="submit">Don't wait for this</button></form></p>`,
    )
    .join("\n");
  const waitAdd =
    data.csrf === "" || candidates.length === 0
      ? ""
      : `<form method="post" action="${taskHref(task.id)}/block" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<select name="on" aria-label="task to wait for">` +
        candidates.map(one => `<option value="${escape(one.id)}">${escape(one.id)} — ${escape(one.title)}</option>`).join("") +
        `</select>` +
        `<button type="submit">Wait for this task</button>` +
        `<span class="meta"> — this task starts only after it finishes</span></form>`;
  const waitsForCard =
    waitRows === "" && waitAdd === ""
      ? ""
      : `<h2>Waits for</h2>${waitRows === "" ? `<p class="meta">Nothing — it starts when a worker is free</p>` : waitRows}${waitAdd}`;

  // The acts bar (task page pass): every verb in one row under the title,
  // the one that resolves this task's state first and primary — retry on a
  // stalled task, build-next in the queue, plan-first with no scope. The
  // hold's reason sits beside its button; cancel stays armed at the foot,
  // far from the primary. A live claim is never disturbed by an operator
  // hold (the hold governs the NEXT start), and requeue refuses while a
  // claim is live — so the words say exactly when each becomes real.
  const canPlan = data.plan === null && !approval.approved && !data.claimed && task.state === "queued" && (data.coordinator === null || data.coordinator === undefined);
  // A failed task's status card carries Retry itself (the same requeue); here it would be a second ink act.
  const cardRetries = task.state === "failed" && data.assignment != null && data.csrf !== "";
  const primaryAct =
    stopControlsActive || cardRetries ? null : stalled && !data.claimed
      ? { html: act("requeue", "Retry, keeping the branch and workspace"), why: "Resolves the incidents, clears the failed attempts and queues the task again. The branch and workspace are kept.", whyClass: "retry" }
      : canPlan
        ? { html: act("plan", "plan first"), why: "plan first sends an agent to read the repository, ask you questions, and propose a scope — nothing builds until you approve it", whyClass: "plan" }
        : data.plan === "requested"
          ? null
        : task.state === "queued" && !data.claimed && (data.position?.position ?? 1) > 1
          ? { html: act("next", "build this next"), why: "moves it to the front of its queue — the next free worker looks here first; approval is still required", whyClass: "next" }
          : null;
  const holdAct =
    `<form method="post" action="${taskHref(task.id)}/hold" class="inline act-hold">` +
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
    `<input type="text" name="reason" class="inline" placeholder="reason (optional)" aria-label="hold reason">` +
    `<button type="submit">Hold the next attempt</button></form>`;
  const canHold = task.state === "queued" || task.state === "running" || task.state === "failed";
  const actsBar = [
    `<span id="task-actions"></span><div class="acts-bar">`,
    // While a ceremony leads the page, no other act competes as primary.
    primaryAct === null ? "" : approveForm === "" ? `<span class="primary">${primaryAct.html}</span>` : primaryAct.html,
    task.state === "queued" && (data.position?.position ?? 2) === 1 && task.priority > 0
      ? act("next", "back to filing order", `<input type="hidden" name="undo" value="1">`)
      : "",
    // A task with no scope is already unable to start. Showing a hold next
    // to "plan first" adds a second, unnecessary decision at the exact
    // moment the page should have one obvious action.
    stopControlsActive || canPlan || !canHold ? "" : holdAct,
    data.holds.some(hold => hold.ownerKind === "operator") ? act("unhold", "Remove hold") : "",
    `</div>`,
    primaryAct === null ? "" : `<p class="meta acts-why acts-why-${primaryAct.whyClass}">${primaryAct.why}</p>`,
    data.claimed && !stopControlsActive
      ? `<p class="meta acts-why">a worker is building this right now — <em>Hold the next attempt</em> stops the one after it; cancel waits for the current build to finish${
          stalled ? "; retry becomes available after this attempt finishes" : ""
        }</p>`
      : "",
  ].join("\n");
  // Cancel gets the same ceremony as an irreversible answer: armed behind
  // one deliberate tap, styled as the destructive act it is.
  const cancelForm =
    task.state === "queued" || task.state === "running" || task.state === "failed"
      ? [
          `<form method="post" action="${taskHref(task.id)}/cancel">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          data.coordinator == null ? "" : `<label>Reason for cancellation<textarea name="reason" rows="3" maxlength="500" required>${escape(data.cancelDraft ?? "")}</textarea></label>`,
          `<button type="submit" class="danger">Confirm cancellation</button>`,
          `</form>`,
        ].join("")
      : "";
  const cancelAct = cancelForm === "" ? "" : `<details class="arm-danger"${data.cancelDraft === undefined ? "" : " open"}><summary>Cancel task</summary>${cancelForm}</details>`;
  // Long sections fold, each with its count in the header: what needs
  // reading stays open; a ledger or a form folds until asked. The rebuilt
  // page receives the same bodies, so its folds carry the same forms.
  const sectionParts: BrowserTaskSection[] = [];
  const section = (title: string, html: string, open: boolean, count?: number, id = title.replace(/\s+/g, "-")): string => {
    if (html === "") return "";
    const heading = sentenceCase(title);
    const inner = html.replace(`<h2>${title}</h2>`, "").replace(`<h2>${heading}</h2>`, "");
    sectionParts.push({ id, title: heading, html: inner, open, count: count ?? null });
    return `<details class="section" id="${id}"${open ? " open" : ""}><summary><h2>${heading}${count === undefined ? "" : ` <span class="lane-count">${count}</span>`}</h2></summary>` + inner + `</details>`;
  };

  const receiptLeads = data.assignment == null && task.state === "done" && data.completion?.receipt != null;
  // Exact identity stays available in Task options; failures stay in the
  // status and property rail, and approval provenance stays in the ceremony.
  const identity = `<p class="meta task-identity">Task ID <span class="mono">${escape(task.id)}</span>` +
      (data.rootTitle !== undefined && data.rootTitle !== task.title ? ` · Execution: ${escape(task.title)}` : "") +
      `${data.repo === null ? "" : ` · ${escape(projectName(data.repo))}`}` +
      `${
        data.coordinator !== null && data.coordinator !== undefined
          ? ` · filed by <span class="mono">${escape(data.coordinator.label)}</span>${data.coordinator.filedAgo === null ? "" : ` ${escape(data.coordinator.filedAgo)}`}`
          : data.filedVia === null || data.filedVia === undefined
            ? ""
            : ` · filed via ${escape(data.filedVia)}`
      }${data.deliverable === "report" ? ` · <span class="badge">Scout</span>` : ""}</p>`;
  // A pull request that can be merged (or opened) owns the one primary action; the result stays in its section.
  const pullRequestActs = data.csrf !== "" && (data.pullRequest?.view?.canMerge === true || (data.pullRequest?.view == null && data.pullRequest?.offer != null));
  const pullRequestFact = data.pullRequest?.fact != null && data.pullRequest.view?.runId === data.assignment?.receipt?.runId ? data.pullRequest.fact : undefined;
  const assignmentOptions = data.assignment == null ? null : { workStatus: status, hideAction: (approveForm !== "" && data.dispatch?.action === "approve-scope") || pullRequestActs, problem: status.tone === "problem",
    planning: data.dispatch?.code === "running" && data.dispatch.role === "planner", ...(pullRequestFact === undefined ? {} : { pullRequest: pullRequestFact }),
    diagnostics: [...((status as WorkStatus).diagnostics ?? []), ...(status.tone === "problem" && status.detail !== data.assignment.detail ? [status] : [])] };
  // Say it once: a pull request that couldn't open, or merged, is the status
  // card's own row (its reason or merge commit under Details), not a second card.
  const pullRequestCard = data.pullRequest == null || (pullRequestFact !== undefined && (data.pullRequest.view?.state === "failed" || data.pullRequest.view?.state === "merged")) ? "" : pullRequestCardHtml(data.pullRequest, data.csrf);
  // The result takes over from the task status as soon as it is ready.
  const statusHtml = (data.assignment != null && assignmentOptions !== null ? assignmentSummaryHtml(data.assignment, assignmentOptions) : receiptLeads ? completionReceiptCard(data.completion!.receipt!, task.id, "task", status) : taskStatusCard(status, task.id, data.dispatch ?? null, liveRunId, approveForm !== "" && data.dispatch?.action === "approve-scope")) + checkProgressHtml(data.checkProgress ?? null);
  // The exact-run control (v52), directly under the scheduler's answer:
  // the one place a person stops or resumes THIS attempt.
  const controlHtml = taskControlDetailsHtml(data.control ?? { kind: "none" }, task.id, data.csrf, "task");
  const previousResult = data.completion?.receipt == null || receiptLeads ? null : {
    title: data.assignment != null && task.state === "done" ? "Result" : "Previous result",
    html: completionReceiptCard(data.completion.receipt, task.id, "task", data.assignment == null ? receiptStatusOf(data.completion.receipt) : assignmentStatusOf(data.assignment), data.assignment ?? null, data.assignment == null),
  };
  // External work wears its tracker on the page: the link, the last
  // observed state, and — when the tracker closed it and has been seen
  // open again — the authenticated reopen act. Done + closed is display
  // only: completed here stays completed.
  const mirrorCard = (() => {
    const mirror = data.mirror ?? null;
    if (mirror === null) return "";
    const link =
      mirror.backend === "github-issues"
        ? `<a href="https://github.com/${escape(mirror.remoteRepo)}/issues/${escape(mirror.remoteId)}">${escape(mirror.remoteRepo)}#${escape(mirror.remoteId)}</a>`
        : `<span class="mono">${escape(mirror.remoteRepo)}#${escape(mirror.remoteId)}</span>`;
    const state =
      task.state === "done" && mirror.remoteState !== "open"
        ? "completed here; closed on the tracker"
        : mirror.remoteState === "open"
          ? mirror.dispatchOk
            ? "open on the tracker"
            : "seen open again — reopen below to resume"
          : mirror.remoteState === "closed"
            ? "closed on the tracker"
            : "gone from the tracker";
    const reopenable =
      mirror.remoteState === "open" && !mirror.dispatchOk && mirror.closeGeneration !== null &&
      mirror.syncGeneration > mirror.closeGeneration && ["cancelled", "failed", "queued"].includes(task.state) && data.csrf !== "";
    return (
      `<div class="card"><p><strong>External work</strong> <span class="meta">${link} · ${escape(state)}</span></p>` +
      (reopenable
        ? `<form method="post" action="${taskHref(task.id)}/reopen" class="row">` +
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
          `<input type="password" name="token" placeholder="your password" aria-label="your password" autocomplete="current-password">` +
          `<button type="submit">Reopen — the approved scope stands</button></form>`
        : "") +
      `</div>`
    );
  })();
  const problemHtml = data.problem === null || data.scopeDraft !== undefined ? "" : `<div class="problem">${escape(data.problem)}</div>`;
  // The board sent them here saying "needs you" — the page must open by
  // saying WHY and pointing at the act, not read as a fact sheet
  // (operator finding: clicking a needs-you card landed with no context).
  const needsScopeCard =
    scope === null && data.plan === null && task.state === "queued" && data.dispatch?.code !== "needs-scope" && data.dispatch?.code !== "waiting-dependency" && !dependencyChoiceNeeded
      ? data.coordinator !== null && data.coordinator !== undefined
        // The quarantine speaks here too (round-2 finding 5): the planner
        // is as fenced as the builder on a coordinator filing, so "plan
        // first" would recommend a road that refuses.
        ? `<div class="card"><p><strong>This task is waiting on you: an agent filed it, and it has no scope.</strong></p>` +
          `<p class="meta">Filed by <span class="mono">${escape(data.coordinator.label)}</span> — nothing plans, claims, or runs until you write a scope below and sign it. Your signature runs their request.</p></div>`
        : `<div class="card task-scope-needed"><p><strong>No approved scope yet</strong></p>` +
          `<p class="meta"><strong>Plan first</strong> drafts it from the repository, or <a href="#scope">write it yourself</a>.</p></div>`
      : "";
  const approvalHtml = dependencyChoiceNeeded || approveForm === "" ? "" : data.dispatch?.action === "approve-scope"
    ? `<section class="task-plan-review" aria-label="Approve the plan">${approveForm}</section>`
    : `<details class="task-secondary-approval"><summary>Updated approval terms</summary>${approveForm}</details>`;
  const optionsHtml = `${identity}${dispatchStatus}${dependencyChoiceNeeded ? "" : actsBar}`;
  const optionsOpen = data.assignment?.primaryAction?.code === "unhold" || data.assignment?.primaryAction?.code === "retry-task";
  const html = [
    // The title is bare; the receipt or shared task status leads once.
    `<div class="task-title-row"><h1 class="task-main-title">${escape(data.rootTitle ?? task.title)}</h1>${data.csrf === "" ? "" : taskViewSwitch(data.rootId ?? task.id, "overview")}</div>`,
    data.versionLabel == null ? "" : `<p class="meta">${escape(data.versionLabel)} · <a href="${taskHref(data.rootId ?? task.id)}">Current work</a></p>`,
    data.history ?? "",
    statusHtml,
    controlHtml,
    previousResult === null ? "" : `<details class="task-previous-result"><summary>${previousResult.title}</summary>${previousResult.html}</details>`,
    progressCard,
    revisionLedgerCard,
    planCard,
    mirrorCard,
    problemHtml,
    needsScopeCard,
    approvalHtml,
    `<details class="task-status-details" id="task-diagnostics"${optionsOpen ? " open" : ""}><summary>Task options</summary>${optionsHtml}</details>`,
    // Evidence-first (M5.5): what needs you, then what happened — decisions
    // and incidents above the attempt ledger and spend, the mechanics
    // (scope, holds, acts) after. Only trustworthy facts moved up. The rail
    // (slice 1c) rides beside the main column on wide screens and above it
    // on narrow ones.
    `<div class="task-layout"><div class="task-main">`,
    attemptPanel,
    data.coordinatorProposals == null || data.coordinatorProposals.rows.length === 0
      ? ""
      : section(
          "proposals",
          `<h2>Proposed by coordinators</h2>` +
            coordinatorProposalsSection(
              data.coordinatorProposals.rows,
              data.coordinatorProposals.decisions,
              data.csrf,
              data.coordinatorProposals.now,
              false,
            ).replace(/<form method="post" action="\/proposals\/(\d+)\/(confirm|dismiss)" class="inline">/g, (_m, id: string, verb: string) => `<form method="post" action="/proposals/${id}/${verb}" class="inline"><input type="hidden" name="return" value="${escape(taskHref(data.task.id))}">`),
          true,
          data.coordinatorProposals.rows.length,
        ),
    section("decisions", decisions, true, data.decisions.length),
    section("incidents", incidents, true, data.incidents.length),
    data.publication === null || data.publication === undefined
      ? ""
      : `<p class="row"><span class="meta">published</span> ` +
        `${safePrUrl(data.publication.prUrl) === null ? `<span class="mono">PR #${data.publication.prNumber ?? "?"}</span>` : `<a href="${escape(safePrUrl(data.publication.prUrl) as string)}" class="mono">PR #${data.publication.prNumber ?? "?"}</a>`}` +
        ` <span class="meta">${escape(data.publication.state)}${
          data.publication.remoteState !== null ? ` · ${data.publication.remoteState.toLowerCase()} on GitHub` : ""
        }${
          data.publication.lastCheckState !== null
            ? ` · CI ${data.publication.lastCheckState} at last observation`
            : " · no checks observed"
        }</span></p>`,
    section("report", reportCard, true),
    data.assignment == null ? section("attempts", runs, true, data.runs.length) : section("Build activity", runs.replace("<h2>Attempts</h2>", ""), false, data.runs.length, "attempts"),
    section("usage", spendCard, false),
    section("steering", steeringCard, (data.steering ?? []).length > 0, (data.steering ?? []).length),
    section(
      "scope",
      // The recipe road rides with the scope it reuses (UI polish
      // 2026-09-13), off the title-to-action path.
      ["<h2>Scope</h2>", scopeCard, data.repo !== null && data.scope !== null ? `<p class="meta"><a href="/recipes/from-task?task=${encodeURIComponent(task.id)}">Reuse this scope as a recipe →</a></p>` : "", agentsCardHtml(task.id, data.route, data.csrf, data.canEditRoute === true), revisionInApproval ? "" : revisionCard, data.completion != null ? "" : repairChainHtml(data.repairChain ?? null), scopeForm].join("\n"),
      scopeDraft !== undefined || (data.plan !== "requested" && approveForm === "" && !(scope === null && canPlan)),
    ),
    dependencyChoiceNeeded ? "" : section("waits for", waitsForCard, (data.waitsFor ?? []).length > 0, (data.waitsFor ?? []).length),
    section("holds", holds, true, data.holds.length),
    cancelAct,
    `</div><aside class="task-rail">${rail}</aside></div>`,
  ].join("\n");

  // Console v2: one thread in time order (the plan, the agent's notes and
  // results, its questions, the person's replies) and the metadata grouped
  // for a Details panel. Every form below keeps its own route and fields.
  const familyRuns = data.family?.runs ?? data.runs.map(run => ({ ...run, taskId: task.id }));
  const versionLabelOf = (taskId: string): string => {
    const index = data.family?.versions.findIndex(one => one.id === taskId) ?? -1;
    return index <= 0 ? "" : ` · revision ${index}`;
  };
  const thread: BrowserTaskThreadItem[] = [];
  const filedBy = data.filer?.name ?? data.coordinator?.label ?? null;
  const rootFiled = data.family?.root.createdAt ?? task.createdAt;
  thread.push({ key: "filed", at: rootFiled, kind: "filed", who: "person", author: filedBy ?? "", title: "Filed the task",
    text: (() => { const goal = data.family?.root.goal ?? scope?.goal ?? null; return goal === null ? null : oneLineOf(goal, 280); })(), link: null, html: "", more: null });
  const newestBuilt = familyRuns.filter(run => run.outcome === "built" && run.role !== "planner" && run.role !== "reviewer").sort((a, b) => b.id - a.id)[0];
  // Failed: the card says what went wrong in one line, and its one act is Retry itself (the same requeue), never a link to
  // this page; someone who can't retry here (a viewer, a live claim) gets no act at all.
  const statusCard = data.assignment != null && assignmentOptions !== null ? assignmentCardOf(data.assignment, assignmentOptions) : null;
  // A live build says which step it is on, or which step it is stuck on and why.
  const building = statusCard?.status.headline === "Building" && liveRun !== undefined && liveRun.role !== "planner" && liveRun.role !== "reviewer";
  // While a build runs, the attempts that stopped before it fold into one quiet line under its Building card. Only
  // there: with any other card (or none) they stay in the thread, never vanish.
  const earlierStopped = !building ? []
    : familyRuns.filter(run => run.id < liveRun.id && (run.role === "builder" || run.role === "scout") && run.outcome !== "built" && run.outcome !== "no-change" && run.id !== liveHistoryRunId);
  const foldedAttempts = new Set(earlierStopped.map(run => run.id));
  for (const run of familyRuns) {
    if (foldedAttempts.has(run.id)) continue;
    const live = run.id === liveHistoryRunId || (run.outcome === null && run.id === liveRunId);
    const noun = runNoun(run);
    const href = { label: `${noun[0]!.toUpperCase()}${noun.slice(1)} #${run.id}`, href: `/r/${run.id}` };
    const revision = versionLabelOf(run.taskId);
    if (run.role === "planner") {
      thread.push({ key: `run-${run.id}`, at: run.finishedAt ?? run.startedAt, kind: "plan", who: "agent", author: run.runner,
        title: live ? "Planning" : run.reason === "plan-drafted" ? "Drafted a plan" : `Planning ended · ${run.outcome === null ? "never finished" : run.reason === null ? run.outcome : reasonWords(run.reason)}`,
        text: null, link: href, html: "", more: null });
      continue;
    }
    if (live) {
      thread.push({ key: `run-${run.id}`, at: run.startedAt, kind: "progress", who: "agent", author: run.runner,
        title: `${run.role === "reviewer" ? "Reviewing" : run.role === "scout" ? "Investigating" : "Building"}${revision}`,
        text: `${homePhaseWords(run)}.`, link: href, html: "", more: null });
      continue;
    }
    const title = run.role === "reviewer" ? "Reviewed the result"
      : run.outcome === "built" ? (run.role === "scout" ? "Report ready" : "Result ready")
      : run.outcome === "no-change" ? "Finished with no change"
      : run.outcome === "parked" ? "Stopped to ask"
      : run.outcome === null ? "Attempt never finished"
      : `${noun[0]!.toUpperCase()}${noun.slice(1)} ${run.outcome}`;
    thread.push({ key: `run-${run.id}`, at: run.finishedAt ?? run.startedAt, kind: "result", who: "agent", author: run.runner,
      title: `${title}${revision}`, text: run.handoff === null ? (run.outcome === "failed" ? failedAttemptSentence(run.reason) : run.reason === null || run.outcome === "built" ? null : reasonWords(run.reason)) : oneLineOf(run.handoff, 600),
      link: href, html: "",
      more: previousResult !== null && run.id === newestBuilt?.id && run.taskId === task.id ? { summary: STATUS_MORE, html: previousResult.html } : null });
  }
  // What the agent is working through now, and how its plan changed.
  const liveAt = liveRun?.startedAt ?? task.updatedAt;
  if (planCard !== "") thread.push({ key: "plan", at: familyRuns.filter(run => run.role === "planner").map(run => run.finishedAt ?? run.startedAt).sort().at(-1) ?? task.updatedAt,
    kind: "plan", who: "agent", author: "", title: "The plan", text: null, link: null, html: planCard, more: null });
  if (progressCard !== "") thread.push({ key: "progress", at: liveAt, kind: "progress", who: "agent", author: "", title: "Progress", text: null, link: null, html: progressCard, more: null });
  if (revisionLedgerCard !== "") thread.push({ key: "plan-revisions", at: liveAt, kind: "progress", who: "agent", author: "", title: "Plan changes", text: null, link: null, html: revisionLedgerCard, more: null });
  // The change a person asked for: the revision's own brief.
  if (data.revision != null && !("problem" in data.revision)) {
    const feedback = data.revision;
    thread.push({ key: "revision", at: task.createdAt, kind: "reply", who: "person", author: feedback.comments[0]?.author ?? "You",
      title: feedback.kind === "ci-repair" ? "Asked for a CI repair" : feedback.kind === "criterion-repair" ? "Asked for a repair" : "Asked for changes",
      text: feedback.comments.map(one => `${one.path === null ? "" : `${one.path}${one.line === null ? "" : `:${one.line}`} — `}${one.note.trim()}`).filter(one => one !== "").join("\n") || null,
      link: { label: `From build #${feedback.sourceRun}`, href: `/r/${feedback.sourceRun}` }, html: "", more: null });
  }
  for (const decision of data.decisions) {
    if (decision.state === "open" || decision.state === "expired") continue;
    thread.push({ key: `question-${decision.id}`, at: decision.createdAt, kind: "question", who: "agent", author: "", title: "Asked",
      text: decision.question, link: { label: "Question", href: `/d/${decision.id}` }, html: "", more: null });
    if (decision.answeredAt !== null) {
      const chosen = decision.options.find(one => one.id === decision.choice)?.label ?? decision.choice;
      thread.push({ key: `answer-${decision.id}`, at: decision.answeredAt, kind: "reply", who: "person", author: decision.answeredBy ?? "You", title: "Answered",
        text: [chosen, decision.note].filter((one): one is string => one !== null && one !== "").join(" — ") || null, link: null, html: "", more: null });
    }
  }
  // Open questions keep their answer card (and its #task-questions anchor).
  if (decisionRail !== "") thread.push({ key: "questions", at: openDecisions.map(one => one.createdAt).sort()[0] ?? task.updatedAt, kind: "question", who: "agent", author: "",
    title: openDecisions.length === 1 ? "Asked you a question" : `Asked you ${openDecisions.length} questions`, text: null, link: null, html: decisionRail, more: null });
  for (const note of data.steering ?? []) {
    thread.push({ key: `steer-${note.id}`, at: note.createdAt, kind: "reply", who: "person", author: note.author, title: "Note to the agent", text: note.note, link: null, html: "", more: null });
  }
  thread.sort((a, b) => a.at === b.at ? 0 : a.at < b.at ? -1 : 1);

  // The Details panel: the same facts, grouped and said once.
  const lastRunForAgent = liveRun ?? familyRuns.filter(run => run.role !== "reviewer").sort((a, b) => b.id - a.id)[0];
  const work: BrowserTaskFact[] = [];
  work.push({ label: "Status", parts: [data.assignment != null && assignmentOptions !== null ? assignmentCardOf(data.assignment, assignmentOptions).status.headline : status.label] });
  if (data.repo !== null) work.push({ label: "Project", parts: [projectName(data.repo)] });
  work.push({ label: "Agent", parts: [lastRunForAgent !== undefined ? `${lastRunForAgent.provider}${lastRunForAgent.model === null ? "" : ` · ${lastRunForAgent.model}`} on ${lastRunForAgent.runner}`
    : data.route?.legacy != null ? `${data.route.legacy.provider} · ${data.route.legacy.model}` : "The project's default"] });
  if (scope !== null) work.push({ label: "Checks level", parts: [qualityModeTitle(scope.qualityMode ?? "default")] });
  for (const label of ["Worker", "Last attempt", "Queue", "Budget", "Policy", "Strikes"]) {
    const fact = facts.find(one => one.label === label);
    if (fact !== undefined) work.push(fact);
  }
  const links: BrowserTaskFact[] = [];
  if (data.family != null && data.family.root.id !== task.id) links.push({ label: "Parent", parts: [{ label: data.family.root.title, href: `${taskHref(data.family.root.id)}?version=${encodeURIComponent(data.family.root.id)}` }] });
  const blockers = data.waitsFor ?? [];
  if (blockers.length > 0) links.push({ label: "Blocked by", parts: blockers.flatMap((one, index) => [...(index === 0 ? [] : [", "]), one.admitted ? { label: one.title ?? one.id, href: taskHref(one.id) } : one.id]) });
  const laterVersions = (data.family?.versions ?? []).filter((one, index, all) => index > all.findIndex(version => version.id === task.id) && all.findIndex(version => version.id === task.id) >= 0);
  if (laterVersions.length > 0) links.push({ label: "Follow-ups", parts: laterVersions.flatMap((one, index) => [...(index === 0 ? [] : [", "]), { label: one.title, href: `${taskHref(data.family!.root.id)}?version=${encodeURIComponent(one.id)}` }]) });
  const published = facts.find(one => one.label === "Published");
  if (published !== undefined) links.push({ ...published, label: "Pull request" });
  else if (data.pullRequest?.view != null) {
    const pr = data.pullRequest.view;
    const prHref = safePrUrl(pr.prUrl);
    links.push({ label: "Pull request", parts: [prHref === null ? `#${pr.prNumber ?? "?"}` : { label: `#${pr.prNumber ?? "?"}`, href: prHref }, ` · ${pr.label}`] });
  }
  const review: BrowserTaskFact[] = [];
  const approvedScope = facts.find(one => one.label === "Approved scope" || one.label === "Scope");
  if (approvedScope !== undefined) review.push({ ...approvedScope, label: approvedScope.label === "Approved scope" ? "Approvals" : "Scope" });
  review.push({ label: "Who reviews", parts: [facts.find(one => one.label === "Approval rules")?.parts[0] as string | undefined ?? "Any approver in this project"] });
  review.push({ label: "Publishes as", parts: [publishesAs] });
  const about: BrowserTaskFact[] = [];
  const filedFact = facts.find(one => one.label === "Filed by");
  about.push(filedFact ?? { label: "Filed by", parts: [filedBy ?? (data.filedVia == null ? "Not recorded" : `via ${data.filedVia}`)] });
  about.push({ label: "Filed", parts: [{ at: rootFiled }] });
  about.push({ label: "Updated", parts: [{ at: task.updatedAt }] });
  for (const label of ["Audit", "This attempt", "Task total"]) {
    const fact = facts.find(one => one.label === label);
    if (fact !== undefined) about.push({ ...fact, label: label === "Audit" ? "Audit" : label === "This attempt" ? "Usage, this attempt" : "Usage, all attempts" });
  }
  const details: BrowserTaskDetailGroup[] = [
    { title: "Work", facts: work }, { title: "Links", facts: links }, { title: "Review", facts: review }, { title: "About", facts: about },
  ];

  // The rebuilt page (shadcn/ui): the same parts in a calmer order — what
  // needs a person, then facts, then folds; the mechanics under Manage.
  const MANAGE = new Set(["steering", "waits-for", "holds"]);
  const finished = task.state === "done" || task.state === "cancelled";
  const failedCard = statusCard?.status.headline === "Failed";
  // A link to this very page, with no section to open, goes nowhere: a card never offers one.
  const bareSelfLink = (href: string): boolean => {
    if (href.includes("#")) return false;
    const [path, query = ""] = href.split("?");
    const version = new URLSearchParams(query).get("version");
    return [data.assignment?.rootId, data.rootId, task.id].some(id => id != null && path === `/t/${encodeURIComponent(id)}`) && (version === null || version === task.id);
  };
  // Build again, in place, names its form after the card's own act.
  const rebuild = data.csrf !== "" && data.assignment?.primaryAction?.code === "retry-task" && data.assignment.need != null && "key" in data.assignment.need && data.assignment.need.key === "rebuild"
    ? { action: `${taskHref(data.assignment.rootId)}/requeue` } : null;
  const retry = failedCard && task.state === "failed" && !data.claimed && !stopControlsActive && data.csrf !== ""
    ? { action: `${taskHref(task.id)}/requeue`, ...(data.failure == null ? {} : { note: retryNoteOf(data.failure.suggestion) }) } : null;
  // Run checks happens in place: a status row's Run checks posts here and comes back; with nothing to run, the row offers nothing.
  const runChecks = data.runChecks ?? null;
  // A row's link to a result in Chat opens that result's own page instead: Chat would only lead back here.
  const resultPageOf = (href: string | null): string | null => {
    const chat = href === null ? null : /^\/chat\?task=([A-Za-z0-9._~%-]{1,200})&result=([0-9]{1,15})(?:&tab=(changes|checks))?(#[A-Za-z0-9_-]{1,80})?$/.exec(href);
    return chat === null ? href : `/review?result=${chat[1]}&run=${chat[2]}${chat[3] === undefined ? "" : `&tab=${chat[3]}`}${chat[4] ?? ""}`;
  };
  const inPlaceChecks = (card: AssignmentCard): AssignmentCard => {
    const status = data.demo === true ? demoChecksOf(card.status) : card.status;
    return { ...card, status: { ...status, details: status.details.map(one =>
      one.action?.href?.endsWith("#follow-ups") === true ? { ...one, action: runChecks === null ? null : { label: one.action.label, href: runChecks.action } }
        : { ...one, href: resultPageOf(one.href), action: one.action === null ? null : { ...one.action, href: resultPageOf(one.action.href) } }) } };
  };
  const steps = building ? buildProgressOf(data.milestoneProgress ?? null) : null;
  const progress = steps === null ? null : { line: steps.line,
    stuck: steps.stuck === null ? null : { ...steps.stuck, action: data.csrf === "" ? null : { label: "Send the agent a note", href: "#steering" } } };
  // The Building card carries Stop for the build it describes (the same form), in place of a second card below it.
  const stop = building && data.control?.kind === "stop" && data.control.run === liveRun!.id && data.csrf !== ""
    ? { action: `${taskHref(task.id)}/stop`, run: data.control.run } : null;
  // The Building card keeps its way to the build's own record (/r/<id>), whatever act it shows.
  const record = building ? { label: `Build #${liveRun!.id} record`, href: `/r/${liveRun!.id}` } : null;
  const earlier = earlierStopped.length === 0 ? null : {
    summary: earlierAttemptsWords(earlierStopped.length),
    attempts: [...earlierStopped].sort((a, b) => a.id - b.id).map(run => ({ label: `${runNoun(run)[0]!.toUpperCase()}${runNoun(run).slice(1)} #${run.id}`, href: `/r/${run.id}`,
      text: run.outcome === null ? "Never finished." : run.outcome === "failed" ? failedAttemptSentence(run.reason) : run.reason === null ? null : (words => `${words.charAt(0).toUpperCase()}${words.slice(1)}.`)(reasonWords(run.reason)) })),
  };
  const view: BrowserTaskView = {
    kind: "task",
    id: task.id,
    title: data.rootTitle ?? task.title,
    project: data.repo === null ? null : projectName(data.repo),
    scout: data.deliverable === "report",
    tabs: data.csrf === "" ? [] : [
      { label: "Overview", href: taskHref(data.rootId ?? task.id), active: true },
      { label: "Ask", href: taskChatHref(data.rootId ?? task.id), active: false },
    ],
    version: data.versionLabel == null ? null : { label: data.versionLabel, current: { label: "Current work", href: taskHref(data.rootId ?? task.id) } },
    status: statusCard === null ? null : inPlaceChecks(failedCard ? { ...statusCard, action: null, status: { ...statusCard.status, sentence: data.failure?.line ?? statusCard.status.sentence } }
      : progress !== null || record !== null ? { ...statusCard, action: statusCard.action?.href === record?.href ? null : statusCard.action, status: { ...statusCard.status, sentence: progress?.line ?? statusCard.status.sentence } }
      : statusCard.action !== null && rebuild === null && bareSelfLink(statusCard.action.href) ? { ...statusCard, action: null } : statusCard),
    statusHtml,
    failure: failedCard && data.failure != null ? { line: data.failure.line, evidence: data.failure.evidence, suggestion: data.failure.suggestion, link: data.failure.link } : null,
    retry,
    runChecks,
    progress,
    // One quiet line under the step: what the agent did last, and when.
    activity: liveRun === undefined ? null : data.activity ?? null,
    stop,
    record,
    earlier,
    approval: approvalHtml,
    confirmStopped: data.csrf !== "" && data.assignment?.primaryAction?.code === "confirm-stopped" && data.assignment.primaryAction.target.runId !== null
      ? { action: `${taskHref(data.assignment.rootId)}/confirm-stopped`, run: data.assignment.primaryAction.target.runId, checked: needsCheck(data.assignment) } : null,
    rebuild,
    // The plan, progress and plan changes are thread entries now; the rest still needs a person here.
    lead: [
      { key: "history", html: data.history ?? "" }, { key: "control", html: stop === null ? controlHtml : taskControlDetailsHtml(data.control!, task.id, data.csrf, "task", false, true) }, { key: "problem", html: problemHtml },
      { key: "pull-request", html: pullRequestCard },
      { key: "needs-scope", html: needsScopeCard },
      { key: "mirror", html: mirrorCard }, { key: "attempt", html: attemptPanel },
    ].filter(one => one.html !== ""),
    // Open questions are answered in the thread.
    questions: "",
    facts,
    sections: [
      ...(previousResult === null || thread.some(one => one.more !== null) ? [] : [{ id: "result", title: previousResult.title, html: previousResult.html, open: false, count: null }]),
      // Questions are in the thread; the scope and the ledgers fold here until asked.
      ...sectionParts.filter(one => !MANAGE.has(one.id) && one.id !== "decisions").map(one => one.id === "scope" && scopeDraft === undefined && (finished || approval.approved) ? { ...one, open: false } : one),
    ],
    manage: [
      ...sectionParts.filter(one => MANAGE.has(one.id)),
      { id: "task-diagnostics", title: "Task options", html: optionsHtml, open: optionsOpen, count: null },
    ],
    cancel: cancelForm === "" ? null : { html: cancelForm, open: data.cancelDraft !== undefined },
    journey: data.guide !== true || task.state === "cancelled" || data.status === undefined ? null : (() => {
      const planning = data.plan === "requested" && approveForm === "";
      const read = data.assignment != null ? assignmentStageOf(data.assignment, { token: data.status.token }, planning) : stageOfCode(data.status.token, { planning });
      return firstTaskJourney(read, scope !== null && approvalOf(scope).approved, task.state === "done");
    })(),
    // "Do this every time…": the starter flow that does this kind of work on its own, one yes away.
    thread,
    details,
    chatHref: data.csrf === "" ? null : taskChatHref(data.rootId ?? task.id),
    everyTime: data.repo === null || data.csrf === "" ? null : (() => {
      const starter = starterForWork(`${task.title}\n${scope?.goal ?? ""}`);
      return { href: `/settings/flows?repo=${encodeURIComponent(data.repo)}&starter=${starter.id}#starter-${starter.id}`, starter: starter.name };
    })(),
  };
  return { html, view };
}

export function taskBody(data: Parameters<typeof taskBodyParts>[0]): string {
  return taskBodyParts(data).html;
}

export function taskPage(chrome: Chrome, data: Parameters<typeof taskBody>[0]): Screen {
  // The sensitive-page composition guard (slice 1c): this page may carry a
  // password ceremony. sendScreen() would keep a functional script on such
  // a page — so the decision is made HERE, from the rendered body itself:
  // when the body (or the chrome's list pane) shows a password input, the
  // page re-renders degraded — no poller, static attempt line, link-only
  // decisions — and ships no functional script at all.
  const first = taskBodyParts(data);
  const sensitive =
    SENSITIVE_INPUT.test(first.html) || (chrome.listPane !== undefined && SENSITIVE_INPUT.test(chrome.listPane));
  if (sensitive) {
    const degraded = taskBodyParts({ ...data, degraded: "sensitive" });
    return screen(`task \u00b7 ${data.task.id}`, degraded.html, { chrome, workspace: { view: degraded.view } });
  }
  const liveRunId = data.liveRunId ?? null;
  const liveRun = liveRunId === null ? undefined : data.runs.find(one => one.id === liveRunId);
  const script =
    (liveRun === undefined ? "" : regionScript("check-progress", "check", 5, `/r/${liveRun.id}`)) +
    (liveRun !== undefined && data.peekable === true ? regionScript("run-peek", "peek", 15, `/r/${liveRun.id}`) : "") +
    (liveRun !== undefined && data.peekable === true && liveRun.provider === "claude" ? transcriptScript(`/r/${liveRun.id}`) : "") +
    (data.csrf !== "" && data.decisions.some(one => one.state === "open" || one.state === "expired") ? decisionAnswerScript() : "");
  return screen(`task \u00b7 ${data.task.id}`, first.html, {
    chrome,
    workspace: { view: first.view },
    ...(script === "" ? {} : { functional: { script, fetches: true } }),
  });
}

/** Only an https github.com pull URL earns an anchor (audit IV-11) — a
 * corrupted row renders as text, never as navigation. */
export function safePrUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
    if (!/^\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(parsed.pathname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// ---- the review cockpit (Priority 5) ----------------------------------------
// The field parallelizes generation and lets review pile up (M8.19); this
// page compresses it. Read-only by design — ranked advice and deep links,
// no merge button, because the PR is the terminus and the person merges
// on GitHub.

/** The queue reads at most this many completed tasks — the store's own
 * page ceiling, admission bound before it. */
export const REVIEW_QUEUE_CAP = 100;

/** The one return road the comment endpoint honors besides its own run
 * page: the cockpit's selected-result link, exactly. */
export const REVIEW_RETURN = /^\/review\?result=[A-Za-z0-9._~%-]{1,200}$/;

/** Review priority: a deterministic, LABELED presentation aid over facts
 * the done list already carries. Band 0 goes first; the words name why.
 * It is never a verdict — the stored proof verdict stays the authority,
 * and an operator's acceptance lowers a band without touching it. */
export type ReviewPriority = { band: 0 | 1 | 2; label: "needs action" | "review" | "no flags"; reasons: string[] };

export type ReviewQueueFacts = {
  /** Only an exact current task/run match carries the assignment status. */
  assignment?: AssignmentSnapshot | null;
  proofReasons?: readonly string[];
  runId: number | null;
  outcome: string | null;
  proofVerdict: ProofVerdict | null;
  proofAccepted: boolean;
  proofMatrix: readonly CriterionMatrixRow[];
  ciFailing: boolean;
  publicationState: string | null;
};

export const PRIORITY_LABELS: Record<ReviewPriority["band"], ReviewPriority["label"]> = { 0: "needs action", 1: "review", 2: "no flags" };

export function reviewPriorityOf(row: ReviewQueueFacts): ReviewPriority {
  if (row.assignment != null && (row.assignment.receipt?.runId ?? null) === row.runId) {
    const presentation = assignmentPresentationOf(row.assignment);
    const band = row.assignment.state === "needs-decision" ? 0 : row.assignment.state === "ready-to-check" ? 1 : 2;
    return { band, label: PRIORITY_LABELS[band], reasons: band === 2 ? [] : [presentation.status.label] };
  }
  const reasons: string[] = [];
  let band: ReviewPriority["band"] = 2;
  const raise = (to: ReviewPriority["band"], why: string): void => {
    if (to < band) band = to;
    reasons.push(why);
  };
  if (row.runId === null) {
    raise(1, "no build record");
    return { band, label: PRIORITY_LABELS[band], reasons };
  }
  const ids = (predicate: (one: CriterionMatrixRow) => boolean): string => row.proofMatrix.filter(predicate).map(one => one.id).join(", ");
  const contradicted = ids(one => one.review?.judgement === "contradicts");
  const broken = ids(one => one.state === "failed" || one.state === "missing");
  const manual = ids(one => one.state === "manual-review");
  const humanReview = manualReviewOnly({ verdict: row.proofVerdict ?? "", reasons: row.proofReasons ?? [], matrix: row.proofMatrix });
  if (row.proofVerdict === "refuted") {
    raise(row.proofAccepted ? 1 : 0, row.proofAccepted ? "conflicting evidence — accepted with exception" : "conflicting evidence");
  } else if (humanReview) {
    raise(1, row.proofAccepted ? "accepted after human review" : "human review needed");
  } else if (row.proofVerdict === "short") {
    raise(row.proofAccepted ? 1 : 0, row.proofAccepted ? "missing evidence — accepted with exception" : "missing evidence");
  }
  if (contradicted !== "") raise(row.proofAccepted ? 1 : 0, `reviewer raised a concern with ${contradicted}`);
  if (broken !== "") raise(row.proofAccepted ? 1 : 0, `missing or failed evidence for ${broken}`);
  if (row.ciFailing) raise(0, "CI failing on its pull request — observed, not inferred");
  if (row.publicationState === "failed") raise(1, "publication failed — the branch never reached its remote");
  if (manual !== "" && !row.proofAccepted && !humanReview) raise(1, `manual review needed for ${manual}`);
  if (row.proofVerdict === null && row.outcome !== "no-change") raise(1, "no verification result");
  return { band, label: PRIORITY_LABELS[band], reasons };
}

/** Ranked, stable: band first, then newest completion, then task id — the
 * same input always yields the same queue, whoever loads it. */
export function rankReviewQueue<T extends ReviewQueueFacts & { completedAt: string; taskId: string }>(rows: readonly T[]): (T & { priority: ReviewPriority })[] {
  return rows
    .map(row => ({ ...row, priority: reviewPriorityOf(row) }))
    .sort((a, b) =>
      a.priority.band !== b.priority.band
        ? a.priority.band - b.priority.band
        : a.ciFailing !== b.ciFailing
          ? Number(b.ciFailing) - Number(a.ciFailing)
        : a.completedAt !== b.completedAt
          ? b.completedAt.localeCompare(a.completedAt)
          : a.taskId.localeCompare(b.taskId),
    );
}

/** Whether a changed path sits inside the scope's signed "touches" — an
 * exact file, a directory prefix (with or without its slash), or a plain
 * `*` / `**` glob. Touches are advisory in the scope; here they only
 * decide which files wear the "outside the signed touches" flag. */
export function withinSignedTouches(path: string, touches: readonly string[]): boolean {
  return touches.some(raw => {
    const touch = raw.trim().replace(/^\.\//, "");
    if (touch === "") return false;
    if (touch.includes("*")) return touchGlob(touch).test(path);
    const dir = touch.endsWith("/") ? touch : `${touch}/`;
    return path === touch || path.startsWith(dir);
  });
}

/** A signed touch's glob as a regular expression, gitignore-style: `*`
 * stays inside one segment; `**` followed by `/` spans zero or more
 * directories, so `src/**` followed by `/*.ts` matches `src/a.ts` as well
 * as `src/nested/a.ts` (v2 review, comment 2); a bare `**` spans anything.
 * Whatever the glob names, its contents are inside it too. */
export function touchGlob(raw: string): RegExp {
  // A trailing slash names a directory; the contents clause below covers it.
  const touch = raw.replace(/\/+$/, "");
  let pattern = "";
  for (let at = 0; at < touch.length; ) {
    if (touch.startsWith("**/", at)) {
      pattern += "(?:[^/]*/)*";
      at += 3;
    } else if (touch.startsWith("**", at)) {
      pattern += ".*";
      at += 2;
    } else if (touch[at] === "*") {
      pattern += "[^/]*";
      at += 1;
    } else {
      pattern += (touch[at] as string).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      at += 1;
    }
  }
  return new RegExp(`^${pattern}(?:/.*)?$`);
}

/** A stable, attribute-safe anchor for one file of the sealed patch —
 * derived from the path's bytes, never from the path's characters, so a
 * hostile file name can neither break the id nor escape the attribute. */
export function diffFileAnchor(path: string): string {
  return `diff-file-${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16)}`;
}

export type ReviewFileRow = {
  path: string;
  additions: number | null;
  deletions: number | null;
  renamedFrom: string | null;
  anchor: string | null;
  outsideTouches: boolean;
  cited: boolean;
};

/** Paths whose churn a reviewer reads first — dependency manifests and
 * locks, CI workflows, container and schema definitions, migrations, the
 * environment files secrets live in, and files NAMED for credentials.
 * The credential words match only as whole `-`/`_`/`.`-delimited pieces
 * of the file name (v2 review, comment 4): `auth.ts`, `api-token.ts`,
 * `secrets.json` count; `author.ts`, `tokenizer.ts`, and `.envelope.ts`
 * are ordinary names and do not. `permission` is not a credential word
 * at all — `permissions-ui.tsx` is a screen, not a secret. */
export const SENSITIVE_PATH =
  /(^|\/)(\.github|migrations?)\/|(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile|\.env(\.[^/]+)?|schema[^/]*\.(sql|prisma)|(?:[^/]*[-_.])?(auth|secrets?|tokens?|credentials?)(?:[-_.][^/]*)?)$/i;
export const LARGE_CHANGE_LINES = 200;

/** The changed-file list's own review priority: outside the signed
 * touches first, then files a machine cannot diff or a criterion never
 * cited, then the rest by churn. Presentation only — the sealed patch
 * keeps its own order beneath, byte for byte. */
export function reviewFilePriority(file: ReviewFileRow, proofCitesPaths: boolean): ReviewPriority {
  const reasons: string[] = [];
  let band: ReviewPriority["band"] = 2;
  const raise = (to: ReviewPriority["band"], why: string): void => {
    if (to < band) band = to;
    reasons.push(why);
  };
  if (file.outsideTouches) raise(0, "outside approved paths");
  if (file.additions === null || file.deletions === null) raise(1, "binary file — preview unavailable");
  if (SENSITIVE_PATH.test(file.path)) raise(1, "dependencies, CI, schema, or credentials");
  if (proofCitesPaths && !file.cited) raise(1, "not referenced by a requirement");
  if (file.additions !== null && file.deletions !== null && file.additions + file.deletions >= LARGE_CHANGE_LINES) raise(1, "a large change");
  if (file.anchor === null) raise(1, "not in the recorded diff — see the full diff");
  return { band, label: PRIORITY_LABELS[band], reasons };
}

export function orderChangedFiles(files: readonly ReviewFileRow[], proofCitesPaths: boolean): (ReviewFileRow & { priority: ReviewPriority })[] {
  const churn = (file: ReviewFileRow): number => (file.additions ?? 0) + (file.deletions ?? 0);
  return files
    .map(file => ({ ...file, priority: reviewFilePriority(file, proofCitesPaths) }))
    .sort((a, b) =>
      a.priority.band !== b.priority.band
        ? a.priority.band - b.priority.band
        : churn(a) !== churn(b)
          ? churn(b) - churn(a)
          : a.path.localeCompare(b.path),
    );
}

export type CompletedWorkRow = ReturnType<Store["listCompletedWorkScoped"]>[number] & { historyProblem?: string | null };
export type RankedReviewRow = CompletedWorkRow & { ciFailing: boolean; priority: ReviewPriority; assignment?: AssignmentSnapshot | null };

/** What the cockpit shows of one selected result — a projection of the
 * scope, plan, run, artifact, verdict, and publication records,
 * each read through the verifier the run page already uses. */
export type ReviewCockpitView = {
  taskId: string;
  title: string;
  repo: string | null;
  completedAt: string;
  historyProblem: string | null;
  priority: ReviewPriority;
  assignment: AssignmentSnapshot | null;
  /** null = no scope was ever filed (a task marked done by hand). */
  intent: {
    goal: string;
    outOfScope: string | null;
    touches: string[];
    acceptance: AcceptanceCriterion[];
    approval: ReturnType<typeof approvalOf>;
    approvedBy: string | null;
  } | null;
  plan: { revision: number; sha256: string; approach: string | null } | null;
  /** null = the task is done with no finished build attempt on record. */
  run: {
    id: number;
    role: string;
    outcome: string | null;
    runner: string;
    provider: string;
    model: string | null;
    finishedAt: string | null;
    branch: string | null;
    headRevision: string | null;
    ranMinutes: number | null;
    cost: string;
    summary: string | null;
  } | null;
  /** The shared result detail (package 3) — the same records, the same
   * panel, as the run page and the chat's result view. */
  detail: ResultDetail | null;
  /** v50: the result's bounded review-retry history, null when never asked. */
  reviewRetry: ReviewRetryState | null;
  /** The same history as the shared projection's facts (review fixes). */
  review: ReviewFacts | null;
  notes: { id: number; author: string; note: string; createdAt: string }[];
  /** The demo database: no check runs here, and the Checks row says so. */
  demo?: boolean;
  /** A build that didn't deliver a result: what it missed, the suggestion, and Retry when the task can be retried here. */
  failure?: (FailureExplanation & { retry: { action: string; note: string } | null; acceptAnyway?: { action: string; run: number } | null }) | null;
};

/** The one result page's address: the task and its run, never a project path
 * (the page finds the result's project itself and keeps the person's own). */
export const reviewHref = (taskId: string, runId: number | null = null): string =>
  `/review?result=${encodeURIComponent(taskId)}${runId === null ? "" : `&run=${runId}`}`;

/** The receipt's own proof-state word, so the cockpit and the task page
 * never disagree on the state's name or its precedence: the stored
 * verdict decides, whatever the run's outcome — a no-change run with a
 * refuted proof reads as refuted, never as "no change needed". The one
 * word the receipt never needs is "No build record": a manual completion
 * has no receipt to share it with. */
/** The cockpit's headline status: the shared projection over the same
 * verdict, acceptance, and publication rows the task page reads. */
export function cockpitStatusOf(view: ReviewCockpitView): DisplayStatus {
  // The receipt's own status (package 3): the same projection the chat
  // receipt and the run page print, read from the shared detail.
  if (view.run === null || view.detail === null) return view.assignment === null ? resultHeadlineOf(resultStatusOf(null, null)) : assignmentPresentationOf(view.assignment).status;
  const receiptStatus = receiptStatusOf(view.detail.receipt);
  if (view.assignment !== null) return assignmentStatusOf(assignmentWithEvidence(view.assignment, receiptStatus, view.run.id));
  return resultHeadlineOf(receiptStatus);
}

/** Turn verifier records into one sentence a project owner can act on.
 * A command-not-found result means the check could not start, not that the
 * product itself failed. The stored record remains unchanged. */
export function verificationExplanation(verdict: ProofVerdict | null, reasons: readonly string[]): string {
  const plain = reasons.map(reason => {
    if (
      reason === "the approved verification command passed after the approved setup command ran"
      || reason === "the approved verification command passed after the approved setup command restored project dependencies"
    ) {
      return "Toolroll ran the approved setup automatically, then the project check passed.";
    }
    if (
      reason === "the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled"
      || reason === "the approved verification command could not start because a project dependency was unavailable and no approved recovery was enabled"
    ) {
      return "The project check couldn't start because a required project executable was missing. Automatic recovery wasn't enabled for this check.";
    }
    if (
      reason === "automatic recovery stopped because the approved setup changed after self-healing was authorized"
      || reason === "automatic recovery stopped because its approved setup or project-check settings changed"
      || reason === "automatic recovery stopped because the project setup or check changed"
    ) {
      return "Automatic recovery stopped because the project setup or check changed. Review and reapprove automatic recovery before retrying.";
    }
    if (
      reason === "the approved setup command failed during automatic recovery"
      || reason === "the approved setup command could not restore the project dependencies"
    ) {
      return "The approved project setup failed, so automatic recovery stopped before retrying the project check.";
    }
    if (reason === "automatic recovery stopped because the setup command changed tracked files after the build") {
      return "Automatic recovery stopped because project setup changed files after the build. Review those changes before retrying.";
    }
    if (reason === "automatic recovery stopped because tracked files no longer matched the built result") {
      return "Automatic recovery stopped because files changed after the build was saved. Review those changes before retrying.";
    }
    if (reason === "automatic recovery stopped because the checkout moved away from the built commit") {
      return "Automatic recovery stopped because Toolroll found a different project version than the one it built. Review the build log before retrying.";
    }
    if (reason === "automatic recovery stopped because Toolroll could not confirm that the built checkout was unchanged") {
      return "Automatic recovery stopped because Toolroll couldn't confirm that no files changed after the build was saved. Review the build log, then try again.";
    }
    if (
      reason === "the required project executable was still unavailable after replaying the approved setup command"
      || reason === "project dependencies were still unavailable after replaying the approved setup command"
    ) {
      return "Automatic recovery ran once, but the required project executable was still missing.";
    }
    if (reason === "the retried verification command timed out after automatic recovery") {
      return "Automatic recovery ran the approved setup, but the retried project check timed out.";
    }
    if (reason === "the retried verification command could not be started after automatic recovery") {
      return "Automatic recovery ran the approved setup, but Toolroll still couldn't start the project check.";
    }
    if (reason === "automatic recovery stopped because this worker no longer owned the build") {
      return "Automatic recovery stopped because this worker no longer owned the build. A current worker can retry safely.";
    }
    if (reason === "the approved verification command could not be run") {
      return "Toolroll couldn't run the project check.";
    }
    const recoveredFailure = /^the repository's approved verification command exited (-?[0-9]+) after the approved setup command was replayed$/.exec(reason);
    if (recoveredFailure !== null) {
      return `Automatic recovery ran the approved setup, but the project check still failed (exit ${Number(recoveredFailure[1])}).`;
    }
    const exit = /^the repository's approved verification command exited (-?[0-9]+)$/.exec(reason);
    if (exit !== null) {
      const code = Number(exit[1]);
      return code === 127
        ? "Toolroll couldn't run the project check because a required command wasn't available."
        : `The project check failed (exit ${code}).`;
    }
    if (reason === "the sealed diff is unavailable or truncated; the claimed changed paths cannot be verified against it") {
      return "The recorded changes were incomplete, so they could not be verified.";
    }
    const plainWords = plainReasonWords(reason);
    if (plainWords !== reason) return plainWords;
    const sentence = reason.trim();
    return sentence === "" ? "" : `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}${/[.!?]$/.test(sentence) ? "" : "."}`;
  }).filter(Boolean);
  if (plain.length > 0) return [...new Set(plain)].join(" ");
  if (verdict === "verified") return "Toolroll independently verified this result.";
  if (verdict === "attested") return "The agent supplied evidence, but no independent project check was available.";
  if (verdict === "short") return "Some approved requirements still need evidence.";
  if (verdict === "refuted") return "Recorded evidence conflicts with this result.";
  return "No verification result is available for this build.";
}

export function verificationRecovered(reasons: readonly string[]): boolean {
  return reasons.some(reason =>
    reason === "the approved verification command passed after the approved setup command ran"
    || reason === "the approved verification command passed after the approved setup command restored project dependencies"
  );
}

/** Whether a reviewer can annotate this result's diff here: the shared
 * detail's own answer (a verified, non-empty sealed patch read by a
 * session that holds a CSRF token) — decided once, in `resultDetailOf`. */
export function canAnnotateDiff(view: ReviewCockpitView | null, csrf: string): boolean {
  return view !== null && view.detail !== null && csrf !== "" && view.detail.canAnnotate;
}

export function reviewCockpitPage(
  chrome: Chrome,
  data: {
    queue: readonly RankedReviewRow[];
    /** The queue's ceiling — printed when the queue reaches it. */
    queueCap: number;
    selected: ReviewCockpitView | null;
    /** The deep link resolved a completion older than the queue shows. */
    beyondQueue: boolean;
    missing: string | null;
    csrf: string;
    /** v50: an approver's session may ask for a review retry here. */
    canRetryReview: boolean;
    noted: boolean;
    /** What this person's last post from this page was refused for, in words (`refused=` on the address). */
    refusal?: string | null;
    /** Package 3: the selected local result view and the panel's draft keys. */
    tab: ResultTab;
    user: string;
    now: Date;
  },
): Screen {
  const { queue, selected, csrf } = data;
  const elevated = queue.filter(one => one.priority.band < 2).length;
  const queueRows =
    queue.length === 0
      ? `<p class="meta">No results in this review list.</p>`
      : `<ol class="cockpit-queue-list">` +
        queue
          .map(row => {
            const current = selected !== null && selected.taskId === row.taskId;
            const status = row.assignment == null ? null : assignmentPresentationOf(row.assignment).status;
            const reasons = row.priority.reasons;
            const why = status === null
              ? reasons.length === 0 ? "" : `<span class="cockpit-why">${escape(reasons[0] as string)}${reasons.length > 1 ? ` · +${reasons.length - 1} more` : ""}</span>`
              : `<span class="cockpit-why">${statusLineHtml(status)}</span>`;
            return (
              `<li data-review-priority="${row.priority.band}"><a class="cockpit-row${current ? " current" : ""}" href="${escape(reviewHref(row.taskId, row.runId))}"${current ? ` aria-current="page"` : ""}>` +
              `<span class="cockpit-row-head"><strong>${escape(row.title)}</strong></span>` +
              `<span class="cockpit-row-meta">${whenTime(row.completedAt)}${row.runId === null ? " · no build" : row.outcome === "no-change" ? " · no change" : ""}${row.prNumber === null ? "" : ` · PR #${row.prNumber}`}</span>` +
              (row.historyProblem ? `<span class="cockpit-why" data-history-problem>History unavailable</span>` : why) +
              (status !== null && row.ciFailing ? `<span class="cockpit-why">CI is failing</span>` : "") +
              `</a></li>`
            );
          })
          .join("\n") +
        `</ol>`;
  const queuePane =
    `<aside class="cockpit-queue" aria-label="review queue"><h2>Recent results <span class="lane-count">${queue.length}</span></h2>` +
    (elevated > 0 || queue.length >= data.queueCap ? `<p class="meta cockpit-queue-hint">${elevated === 0 ? "" : `${elevated} ${elevated === 1 ? "needs" : "need"} your attention`}${queue.length >= data.queueCap ? `${elevated > 0 ? ". " : ""}Showing the newest ${data.queueCap}; older results still open from their task` : ""}</p>` : "") +
    queueRows +
    `</aside>`;
  const missingNote =
    data.missing === null
      ? ""
      : `<p class="problem">No completed task <span class="mono">${escape(data.missing)}</span> is in view here — it may not be finished, or it is outside this console's projects. ${selected === null ? "" : "Showing the top of the queue instead."}</p>`;
  const beyondNote =
    !data.beyondQueue || selected === null
      ? ""
      : `<p class="meta cockpit-beyond" data-cockpit-beyond="1">This result is not in the current review list.</p>`;
  const detailParts = selected === null ? null : reviewCockpitDetailParts(selected, csrf, data.noted, data.canRetryReview, data.tab, data.user);
  const detail = detailParts === null ? `<section class="cockpit-detail"><p class="meta">Nothing to review yet.</p></section>` : detailParts.html;
  // The rebuilt page (shadcn/ui): the selected result at full width, the
  // list one tap away in the header.
  const view: BrowserResultView = {
    kind: "result",
    results: queue.map(row => {
      const status = row.assignment == null ? null : assignmentPresentationOf(row.assignment).status;
      const reasons = row.priority.reasons;
      return {
        title: row.title, href: reviewHref(row.taskId, row.runId), at: row.completedAt,
        status: status === null ? null : { label: status.label, tone: status.tone },
        notes: [...(row.historyProblem ? ["History unavailable"] : status === null && reasons.length > 0 ? [reasons[0] as string] : []), ...(status !== null && row.ciFailing ? ["CI is failing"] : [])],
        current: selected !== null && selected.taskId === row.taskId,
        needsYou: row.priority.band < 2,
      };
    }),
    attention: elevated,
    capped: queue.length >= data.queueCap ? data.queueCap : null,
    missing: data.missing === null ? null : `No completed task ${data.missing} is in view here — it may not be finished, or it is outside this console's projects.`,
    beyond: data.beyondQueue && selected !== null,
    selected: detailParts === null ? null : data.refusal == null ? detailParts.selected : { ...detailParts.selected, problem: data.refusal },
  };
  return screen("review", [
    selected === null ? `<h1>Results</h1>` : "",
    missingNote,
    beyondNote,
    data.refusal == null || selected === null ? "" : `<p class="problem" data-result-refusal>${escape(data.refusal)}</p>`,
    `<div class="cockpit">${queuePane}${detail}</div>`,
  ].join("\n"), {
    chrome,
    workspace: { view },
    functional: { script: reviewEvidenceScript() + (selected !== null && selected.detail !== null ? RESULT_REVIEW_SCRIPT : ""), fetches: false },
  });
}

/** The selected result: intent → proof → changes → publication → acts,
 * one scan path, every fact labeled by its source. */
export function reviewCockpitDetail(view: ReviewCockpitView, csrf: string, noted: boolean, canRetryReview = false, tab: ResultTab = "summary", user = ""): string {
  return reviewCockpitDetailParts(view, csrf, noted, canRetryReview, tab, user).html;
}

/** The selected result's HTML and, for the rebuilt page, the same result
 * as data: every form and panel body is the one the HTML carries. */
export function reviewCockpitDetailParts(view: ReviewCockpitView, csrf: string, noted: boolean, canRetryReview: boolean, tab: ResultTab, user: string): { html: string; selected: NonNullable<BrowserResultView["selected"]> } {
  const parts: string[] = [];
  const run = view.run;
  const proof = view.detail?.proof ?? null;
  const accepted = proof?.accepted !== null && proof?.accepted !== undefined;
  const canAnnotate = canAnnotateDiff(view, csrf);
  const status = cockpitStatusOf(view);

  // Header: what this is, its verdict word, and why it sits where it does.
  parts.push(
    `<header class="cockpit-head" data-review-task="${escape(view.taskId)}">` +
      `<h1>${escape(view.title)}</h1>` +
      `<p class="meta">${run === null ? "No build" : `Build #${run.id}`} · <a href="${taskHref(view.taskId)}">Open task</a>${projectChip(view.repo)}</p>` +
      `<p class="cockpit-chips">${statusLineHtml(status)}</p>` +
      `</header>`,
  );

  if (view.detail === null && view.historyProblem !== null) parts.push(`<p class="problem" data-history-problem>${escape(view.historyProblem)} <a href="${taskHref(view.taskId)}">Open task</a></p>`);
  // The primary next act — exactly one road, chosen from the state.
  parts.push(reviewNextAction(view, csrf, accepted, canAnnotate));

  // Approved intent: the signed scope's words, the plan's approach.
  const intent = view.intent;
  let intentView: { approval: string; approvedAt: string | null; html: string } | null = null;
  if (intent === null) {
    parts.push(`<section class="card cockpit-section" data-cockpit-section="intent"><h3>Approved scope</h3><p class="meta">No scope was filed for this task, so there is no approved goal or boundary to review.</p></section>`);
  } else {
    // The time itself goes to the page as a stamp: the one formatter words it in the viewer's zone.
    const approvalWords = intent.approval.approved
      ? `Approved by ${intent.approvedBy ?? "an operator"}`
      : intent.approval.reason === "changed"
        ? "The scope changed after approval. The words below are the current text, not the signed one."
        : "Never approved. The result was built without a signed scope.";
    const approval = intent.approval.approved
      ? `Approved by ${escape(intent.approvedBy ?? "an operator")} · ${whenTime(intent.approval.at)}`
      : escape(approvalWords);
    const body =
      `<p class="recap" style="margin-top:.25rem"><strong>Goal</strong> ${escape(intent.goal)}</p>` +
      (intent.outOfScope === null ? `<p class="meta">No boundary was stated</p>` : `<p class="recap"><strong>Not this</strong> ${escape(intent.outOfScope)}</p>`) +
      (intent.touches.length === 0
        ? `<p class="meta">No expected paths were signed — every changed file reads as in bounds</p>`
        : `<p class="row"><span class="meta">Expected to touch</span> ${intent.touches.map(one => `<span class="mono">${escape(one)}</span>`).join(" ")}</p>`) +
      (view.plan === null
        ? ""
        : `<p class="meta">Plan revision ${view.plan.revision} · <span class="mono" title="${escape(view.plan.sha256)}">${escape(view.plan.sha256.slice(0, 12))}…</span>${view.plan.approach === null ? "" : ` — ${escape(view.plan.approach)}`}</p>`);
    intentView = { approval: approvalWords, approvedAt: intent.approval.approved ? intent.approval.at ?? null : null, html: body };
    parts.push(
      `<details class="card cockpit-section cockpit-disclosure" data-cockpit-section="intent"><summary><h3>Approved scope<small>What this build was asked to do · ${approval}</small></h3><span class="cockpit-disclosure-action">View</span></summary>` +
        `<div class="cockpit-disclosure-body">` + body + `</div></details>`,
    );
  }

  const selected: NonNullable<BrowserResultView["selected"]> = {
    taskId: view.taskId, title: view.title, project: view.repo === null ? null : projectName(view.repo), build: run === null ? null : run.id,
    taskHref: taskHref(view.taskId), chatHref: taskChatHref(view.taskId),
    status: { label: status.label, tone: status.tone, token: status.token },
    problem: view.detail === null ? view.historyProblem : null,
    next: reviewNextActionOf(view, csrf), complete: null, decision: null, checks: null, intent: intentView, noRun: null, panel: null,
    notes: view.notes.map(one => ({ author: one.author, at: one.createdAt, note: one.note })),
    acts: { primary: null, secondary: null, line: null }, runChecks: null, mismatch: null,
    // The raw run record lives under Details now (2026-10-02): /r/<id> for this result redirects here.
    record: run === null ? null : { build: run.id, href: `/r/${run.id}?record=1`, facts: [
      { label: "Agent", value: [run.provider, run.model].filter(Boolean).join(" · ") },
      { label: "Worker", value: run.runner },
      ...(run.branch === null ? [] : [{ label: "Branch", value: run.branch }]),
      ...(run.finishedAt === null ? [] : [{ label: "Finished", value: when(run.finishedAt) }]),
      ...(run.ranMinutes === null ? [] : [{ label: "Ran", value: `${run.ranMinutes} min` }]),
    ] },
  };

  if (run === null || view.detail === null) {
    parts.push(
      `<section class="card cockpit-section" id="verification" data-cockpit-section="proof"><h3>Verification</h3>` +
        `<p class="meta">This task has no finished build record, so there are no captured changes or checks to review.</p>` +
        `<p class="row"><a href="${taskHref(view.taskId)}">Open the task →</a></p></section>`,
    );
    return { html: `<section class="cockpit-detail">${parts.join("\n")}</section>`, selected: { ...selected, noRun: "This task has no finished build record, so there are no captured changes or checks to review." } };
  }

  // The result itself (package 3): the same panel the run page and the
  // chat's result view render — Summary / Changes / Checks with Request
  // changes beside it. The cockpit adds its own acts under Checks: the
  // v50 review-retry panel and the accept-with-exception form.
  const extraChecks = reviewRetryPanel(view.taskId, run.id, view.reviewRetry, { csrf, canAct: false, returnTo: null });
  const here = reviewHref(view.taskId);
  const assignment = view.assignment === null ? null : assignmentWithEvidence(view.assignment, receiptStatusOf(view.detail.receipt), run.id);
  const checks = assignment?.receipt?.checks;
  if (checks !== undefined) parts.push(`<p class="${checks.status === "failed" || checks.status === "unavailable" ? "problem" : "meta"}" data-actual-checks="${checks.status}">${escape(checks.detail)}${checks.logArtifactId === null ? "" : ` <a href="/r/${run.id}/evidence/${checks.logArtifactId}">Open check output</a>`}</p>`);
  if (assignment?.completion != null) parts.push(`<p class="meta" data-result-completed>Marked complete by ${escape(assignment.completion.actor.replace(/^operator:/, ""))}.</p>`);
  const panel = resultPanelParts(view.detail, {
    place: "review",
    tab,
    csrf,
    user,
    noted,
    requestToken: randomBytes(16).toString("hex"),
    hrefFor: one => `${here}&run=${run.id}${one === "summary" ? "" : `&tab=${one}`}`,
    returnTo: `${here}&run=${run.id}`,
    back: null,
    extraChecks,
    headStatus: false,
    action: false,
  });
  parts.push(`<div id="verification" data-cockpit-section="result">` + panel.html + `</div>`);

  const blocked = cantAcceptYetOf(proof?.verdict ?? null, proof?.reasons ?? [], accepted);
  const youCheck = panel.panel.youCheck;
  // Accept and finish posts the completion; when an acceptance is owed (the person's own checks, or a reason a
  // report that doesn't match its changes asks for), the same request records it first.
  const owed = accepted ? null : youCheck?.accept != null ? { note: null } : panel.panel.need?.accept != null ? { note: panel.panel.need.accept.note }
    : blocked === ACCEPT_NEEDS_REASON ? { note: "Why is this safe to accept?" } : null;
  const complete = assignment?.state === "ready-to-check" && assignment.receipt !== null && canRetryReview && csrf !== ""
    ? { action: `${taskHref(view.taskId)}/complete`, receipt: assignment.receipt.digest, run: run.id, accept: owed } : null;
  if (complete !== null) parts.push(completionForm(view.taskId, run.id, complete.receipt, csrf, view.detail?.pullRequestTo ?? null, owed));
  // The one decision, after the evidence: Accept and finish only when every requirement is met and the checks passed.
  const acceptsHere = complete !== null || panel.panel.need?.accept != null || youCheck?.accept != null;
  const matrix = proof === null || proof.proofProblem !== null ? [] : proof.matrix;
  const unanswered = accepted || youCheck == null ? [] : youCheck.items.length > 0 ? youCheck.items.map(one => one.statement === "" ? one.words : one.statement) : youCheck.lines;
  const base = !acceptsHere ? null : acceptWordsOf({
    checks: checks === undefined ? null : checks.running != null ? "running" : checks.level === "off" && checks.status !== "passed" ? "off" : checks.status,
    unmet: matrix.filter(row => row.state !== "pass" && row.state !== "manual-review").length,
    action: complete !== null ? "complete" : "accept",
    publishing: view.detail?.publishing ?? "other",
    proof: proof !== null && proof.proof !== null && proof.proofProblem === null,
  });
  // Refuted: plain Accept and finish stays as allowed, in outline, and the one line before the acts (acts.line) says why.
  const settled = base === null || blocked === null ? base : { ...base, label: "Accept and finish" as const, ready: false };
  const decision = settled === null ? null : { sentence: RESULT_DECISION_SENTENCE, ...settled, ...acceptWithChecksOf(settled, { unanswered, notRight: [] }),
    base: { label: settled.label, ready: settled.ready, why: settled.why } };
  // Run checks: no check ran on this result (or its saved one can't be read), the project has one, and an approver may run it.
  const followUps = view.detail.followUps ?? null;
  const checksRunning = checks?.running != null || (followUps?.checks.some(one => one.state === "waiting" || one.state === "running") ?? false);
  const runChecks = canRetryReview && csrf !== "" && followUps !== null && (followUps.full || followUps.quick) && !checksRunning &&
    (checks === undefined || checks.status === "not-run" || checks.status === "unavailable")
    // Back on this result's Checks tab, where #follow-ups shows the run it started.
    ? { action: `/r/${run.id}/checks`, level: followUps.full ? "full" as const : "quick" as const, returnTo: `${here}&run=${run.id}&tab=checks` } : null;
  const need = panel.panel.need;
  const nextKind = selected.next?.kind;
  // A failed build: what went wrong is the card, Retry the act; a link to this same page goes nowhere, so it isn't one.
  const failure = view.failure == null ? null : { line: view.failure.line, evidence: view.failure.evidence, suggestion: view.failure.suggestion, retry: view.failure.retry,
    link: view.failure.link === null || (view.failure.link.href.startsWith(`${here}&run=${run.id}`) && !view.failure.link.href.includes("#")) ? null : view.failure.link,
    ...(view.failure.acceptAnyway == null ? {} : { acceptAnyway: { ...view.failure.acceptAnyway, returnTo: `${here}&run=${run.id}` } }) };
  const actFacts: ResultActFacts = failure !== null
    ? { accept: null, runChecks: runChecks !== null, checksRunning, blocked: null, canRequest: false, need: null, next: null, failed: { retry: failure.retry !== null, acceptAnyway: failure.acceptAnyway !== undefined } }
    : {
    accept: settled === null ? null : { ready: settled.ready },
    runChecks: runChecks !== null,
    checksRunning,
    blocked,
    canRequest: panel.panel.canRequest && panel.panel.request !== null,
    need: need === null || need.accept != null ? null : need.rebuild != null ? "rebuild" : need.confirm !== null ? "confirm-stopped" : null,
    next: nextKind === "revise" || nextKind === "draft-repair" ? nextKind : null,
    unanswered: settled === null ? 0 : unanswered.length,
    notRight: 0,
  };
  const acts = resultActsOf(actFacts);

  // A refuted result's card lists every recorded disagreement, each tied to its lines; when the report itself doesn't
  // match the changes (not a failed check), that is the headline.
  const mismatch = failure !== null || proof === null || accepted || proof.verdict !== "refuted" ? null : (() => {
    const patch = view.detail?.terminal?.patch ?? null;
    const files = patch === null || "problem" in patch ? [] : parseReviewDiff(patch.text).files;
    // Each file's first change: the lines it added (else every line it shows), and where that change starts (its link target).
    const hunkStart = new Map<string, number>();
    const changes = new Map(files.map(file => {
      const shown = file.hunks[0]?.lines.filter(line => line.newLine !== null && line.kind !== "meta") ?? [];
      if (shown[0]?.newLine != null) hunkStart.set(file.path, shown[0].newLine);
      const added = shown.filter(line => line.kind === "addition");
      const lines = (added.length > 0 ? added : shown).map(line => line.newLine as number);
      return [file.path, lines.length === 0 ? null : { from: Math.min(...lines), to: Math.max(...lines) }] as const;
    }));
    const changesHref = `${here}&run=${run.id}&tab=changes`;
    const found = reportMismatchesOf(proof.reasons, proof.proofProblem === null ? proof.matrix : [], changes);
    // The saved report itself can't be read: that is the evidence problem, said once.
    if (proof.proofProblem !== null) found.push({ text: `The saved report can't be read: ${proof.proofProblem}`, path: null, lines: null, inChanges: null, note: null, reason: proof.proofProblem });
    if (found.length === 0) return null;
    return {
      headline: evidenceProblemOf(proof.verdict, proof.reasons) === "mismatched" ? MISMATCH_HEADLINE : null,
      rows: found.map(one => ({
        text: one.text, path: one.path, absent: one.inChanges === false,
        lines: one.lines === null ? null : one.lines.from === one.lines.to ? `line ${one.lines.from}` : `lines ${one.lines.from}–${one.lines.to}`,
        href: one.path !== null && one.inChanges === true ? `${changesHref}#${diffFileAnchor(one.path)}${hunkStart.has(one.path) ? `-L${hunkStart.get(one.path)}` : ""}`
          : one.note !== null && (proof.proof?.caveats.length ?? 0) >= one.note ? `${here}&run=${run.id}#report-note-${one.note}` : null,
        noteLabel: one.path === null && one.note !== null ? `The report, note ${one.note}` : null,
      })),
      said: [...new Set([...proof.reasons, ...found.map(one => one.reason)].flatMap(reason => [reason, plainReasonWords(reason)]))],
    };
  })();

  if (view.notes.length > 0) {
    parts.push(
      `<section class="card cockpit-section" data-cockpit-section="notes"><h3>Operator notes</h3>` +
        view.notes.map(one => `<p class="row"><span class="meta">${escape(one.author)} · ${whenTime(one.createdAt)}</span> ${escape(one.note)}</p>`).join("\n") +
        `</section>`,
    );
  }

  return {
    html: `<section class="cockpit-detail">${parts.join("\n")}</section>`,
    selected: {
      ...selected, complete: failure === null ? complete : null, decision: failure === null ? decision : null, acts, actFacts, runChecks, mismatch, failure,
      // A failed build reads Failed, whatever its task has done since; its outcome is what went wrong.
      // Run checks is the decision's own act on this page; a status row never sends the person to Chat for it.
      panel: (() => {
        // A Chat link to this same result would lead back here: it isn't one.
        const elsewhere = (href: string | null): boolean => href !== null && !href.endsWith("#follow-ups") && !new RegExp(`^/chat\\?task=[^&]+&result=${run.id}(?:&|$)`).test(href);
        const shown = panel.panel.status === null ? null : view.demo === true ? demoChecksOf(panel.panel.status) : panel.panel.status;
        const missed = proof === null || proof.proofProblem !== null ? 0 : requirementsOf(proof.matrix)?.missed ?? 0;
        const status = shown === null ? null : { ...shown, details: shown.details.map(one => ({ ...one,
          href: elsewhere(one.href) ? one.href : null, action: one.action !== null && elsewhere(one.action.href) ? one.action : null })) };
        return failure === null ? { ...panel.panel, status }
          : { ...panel.panel, outcome: failure.line, need: null, youCheck: null, status: status === null ? null : { ...status, headline: "Failed" as const, tone: "danger" as const, sentence: failure.line, need: null,
              // Read as Failed, the Requirements row counts what it missed, as the task's card does.
              details: status.details.map(one => one.key !== "requirements" || missed === 0 ? one : { ...one, text: `${missed} missed`, mark: "failed" as const, action: null }) },
            // What it missed is said once, in plain words above; the recorded wording stays under Details.
            attention: panel.panel.attention.filter(one => !(proof?.reasons ?? []).includes(one) && !(proof?.matrix ?? []).some(row => row.detail.includes(one))) };
      })(),
      ...(failure === null ? {} : { status: { label: "Failed", tone: "problem" as const, token: "failed" } }),
      checks: checks === undefined ? null : { detail: checks.detail, problem: checks.status === "failed" || checks.status === "unavailable", logHref: checks.logArtifactId === null ? null : `/r/${run.id}/evidence/${checks.logArtifactId}` },
    },
  };
}

/** What Accept and finish owes before it completes, as the form asks for it: the server's own rule
 * (owedAcceptance), so the form asks for exactly what the completion requires. */
export function owedAcceptanceOf(receipt: AssignmentSnapshot["receipt"]): { note: string | null } | null {
  const owed = owedAcceptance(receipt);
  return owed === null ? null : owed === "person-check" ? { note: null } : { note: "Why is this safe to accept?" };
}

export function completionForm(taskId: string, runId: number, digest: string, csrf: string, pullRequestTo: string | null = null, accept: { note: string | null } | null = null): string {
  // Accept and finish, in one request: with an acceptance owed (the person's own checks, or an exception and
  // its reason, asked for right here), the same post records it first.
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="receipt" value="${escape(digest)}"><input type="hidden" name="run" value="${runId}">${accept === null ? "" : `<input type="hidden" name="accept" value="1">`}` +
    (accept?.note == null ? "" : `<label class="meta" for="complete-reason-${runId}">${escape(ACCEPT_NEEDS_REASON)}</label><input type="text" id="complete-reason-${runId}" name="note" maxlength="500" required placeholder="${escape(accept.note)}">`);
  if (pullRequestTo !== null) {
    // With pull requests set up: the PR is the primary road, a bare finish the quiet one beside it.
    return `<form method="post" action="${taskHref(taskId)}/complete" class="card result-complete">${hidden}<p class="meta">Finishes the task. A pull request opens on ${escape(pullRequestTo)} from this exact commit when you ask for one.</p><div class="result-complete-actions"><button type="submit" name="publish" value="1" style="min-height:44px">Complete and open a pull request</button><button type="submit" class="secondary" style="min-height:44px">Accept and finish</button></div></form>`;
  }
  return `<form method="post" action="${taskHref(taskId)}/complete" class="card result-complete">${hidden}<p class="meta">Finishes the task. Checks stay unchanged; nothing is published or deployed.</p><button type="submit" style="min-height:44px">Accept and finish</button></form>`;
}

/** What the task page shows about a result's pull request: the view, or the offer to open one. */
export type TaskPullRequest = { taskId: string; view: PullRequestView | null; offer: { taskId: string; runId: number; digest: string } | null; target: string | null;
  /** The same pull request as the shared status's detail row reads it. */
  fact?: PullRequestFact | null };

/** The pull request, in one card: its state and link, one line of detail, and the one action it needs — Merge
 * behind the password when checks passed, or Open a pull request for a result completed without one. */
export function pullRequestCardHtml(pr: TaskPullRequest, csrf: string): string {
  if (pr.view === null) {
    if (pr.offer === null || csrf === "") return "";
    return `<section class="card pull-request" id="merge" data-pull-request="none"><div class="pull-request-head"><strong>No pull request</strong></div>` +
      `<p class="meta">This result was completed without one.</p>` +
      `<form method="post" action="${taskHref(pr.offer.taskId)}/complete" class="pull-request-act"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="receipt" value="${escape(pr.offer.digest)}"><input type="hidden" name="run" value="${pr.offer.runId}"><input type="hidden" name="publish" value="1">` +
      `<button type="submit" class="secondary">Open a pull request</button></form></section>`;
  }
  const view = pr.view;
  const url = safePrUrl(view.prUrl);
  const link = view.prNumber === null ? "" : url === null ? `<span class="mono">PR #${view.prNumber}</span>` : `<a href="${escape(url)}" class="mono" rel="noreferrer" target="_blank">PR #${view.prNumber}</a>`;
  // A pull request's trouble never undoes the result: amber, never red.
  const tone = view.state === "ready" || view.state === "merged" ? "ok" : view.state === "failing" || view.state === "failed" ? "problem" : "waiting";
  const revision = view.revisionTask === null || view.state !== "failing" ? "" : ` <a href="${taskHref(view.revisionTask)}">Open revision</a>`;
  const merged = view.mergeCommit === null ? "" : `<p class="meta">Merge commit <span class="mono">${escape(view.mergeCommit.slice(0, 12))}</span></p>`;
  const target = pr.target === null ? "the base branch" : pr.target;
  const act = !view.canMerge || csrf === "" || view.prNumber === null ? "" :
    `<form method="post" action="${taskHref(pr.taskId)}/merge" class="pull-request-act" data-merge-form>` +
    `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="run" value="${view.runId}">` +
    `<p class="meta">${escape(view.mergeMethod === "squash" ? "Squash-merges" : view.mergeMethod === "rebase" ? "Rebase-merges" : "Merges")} PR #${view.prNumber} into ${escape(target)} and deletes its branch.</p>` +
    `<label>Password<input type="password" name="token" autocomplete="current-password" required></label>` +
    (view.fullCheck === null ? `<button type="submit">Merge</button>` : `<input type="hidden" name="anyway" value="1"><button type="submit" class="secondary">Merge anyway</button>`) + `</form>`;
  return `<section class="card pull-request pull-request--${tone}" id="merge" data-pull-request="${escape(view.state)}">` +
    `<div class="pull-request-head"><strong>${escape(view.label)}</strong>${link}</div>` +
    `<p class="meta">${escape(view.detail)}${revision}</p>${merged}${act}</section>`;
}

/** Exactly one primary road per result, chosen from its state; the
 * others stay reachable from their own sections. Every form posts to the
 * endpoint that already owns the act, with the session's CSRF token; a
 * bearer session (no token) sees the road named, never a form. */
export function reviewNextAction(view: ReviewCockpitView, csrf: string, _accepted: boolean, _canAnnotate: boolean): string {
  const next = reviewNextActionOf(view, csrf);
  return next === null ? "" : `<div class="card cockpit-next" data-next-action="${escape(next.kind)}"><div><strong>${escape(next.title)}</strong><span class="meta">${escape(next.detail)}</span></div>${next.control}</div>`;
}

export function reviewNextActionOf(view: ReviewCockpitView, csrf: string): { kind: string; title: string; detail: string; control: string } | null {
  const run = view.run;
  const detail = view.detail;
  const card = (kind: string, title: string, detailWords: string, control: string) => ({ kind, title, detail: detailWords, control });
  if (run === null || detail === null) {
    return card("inspect-task", "No build to review", "This task was marked complete without a build record.", `<a class="button-link" href="${taskHref(view.taskId)}">Open the task</a>`);
  }
  if (detail.ciFailing && csrf !== "") {
    return card("draft-repair", "CI is failing on its pull request", "Toolroll confirmed the failure. Draft one repair task, then approve it before it runs.", `<form method="post" action="/r/${run.id}/draft-repair"><input type="hidden" name="csrf" value="${escape(csrf)}"><button type="submit">Draft a repair task</button></form>`);
  }
  if (detail.comments.length > 0 && csrf !== "") {
    return card("revise", `${detail.comments.length} note${detail.comments.length === 1 ? "" : "s"} ready`, "Create one revision from these notes. You approve it before it runs.", `<form method="post" action="/r/${run.id}/revise"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="return" value="${escape(reviewHref(view.taskId))}">${revisionSealFields(detail.comments, detail.sourceDigest)}<button type="submit">Revise</button></form>`);
  }
  return null;
}

/**
 * Plain words for the machine's own vocabulary — no internal token ever
 * reaches a page. Every map here has a generic fallback: a kind a newer
 * daemon invents degrades to honest generic prose, never to its raw name.
 */
export const PHASE_WORDS: Record<string, string> = {
  "agent-running": "agent working",
  "validating-handoff": "checking the handoff",
  "correcting-proof": "correcting evidence",
  "capturing-evidence": "capturing evidence",
  committing: "committing",
};

/** An agent's phase on the home card, from the machine's own vocabulary. */
export function homePhaseWords(run: Pick<Run, "role" | "phase">): string {
  if (run.role === "planner") return "Planning";
  if (run.role === "reviewer") return "Reviewing";
  if (run.role === "scout") return "Investigating";
  const words: Record<string, string> = { "agent-running": "Writing the change", "validating-handoff": "Checking its handoff", "capturing-evidence": "Saving its evidence",
    committing: "Committing", "verifying-proof": "Running the checks", "correcting-proof": "Correcting its evidence" };
  return run.phase === null ? "Starting" : words[run.phase] ?? "Working";
}

export function phaseWords(phase: string): string {
  return PHASE_WORDS[phase] ?? "the agent is working";
}

/** A recorded reason in one plain line; machine output (a stack trace, a path, "Error:" text) waits on the run record. */
export function reasonWords(reason: string): string {
  return isInternalErrorReason(reason) ? "stopped with an internal error" : oneLineOf(runReasonWords(reason.trim().split(/\r?\n/, 1)[0] ?? ""), 140);
}

export const INCIDENT_WORDS: Record<string, string> = {
  "malformed-decision": "the agent's question was malformed",
  "attempts-exhausted": "failed too many times in a row",
  "commit-failure": "the commit failed",
  "malformed-plan": "the plan was malformed",
  "plan-attempts-exhausted": "planning failed too many times",
  "malformed-report": "the scout's report was malformed",
};

export function incidentWords(kind: string): string {
  return INCIDENT_WORDS[kind] ?? "something went wrong — the run records have the detail";
}

export const EVIDENCE_WORDS: Record<string, string> = {
  diff: "Diff",
  status: "Build status",
  "park-payload": "Question record",
  plan: "Plan",
  "terminal-diff": "Final diff",
  "diff-stat": "Change summary",
  "base-tree": "Starting files",
  handoff: "Agent handoff",
  "revision-brief": "Revision brief",
  report: "Report",
  proof: "Agent proof",
  "check-log": "Check log",
  screenshot: "Screenshot",
  "structured-output": "Agent response",
  "plan-contract": "Plan contract",
  "review-context": "Review context",
};

/** Byte counts as people read them. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function evidenceWords(kind: string): string {
  return EVIDENCE_WORDS[kind] ?? "a stored record";
}

/** A shortened fingerprint for display — enough to compare by eye; the
 * full value rides in the title attribute and in every form field. */
export function shortDigest(digest: string): string {
  return digest.length <= 12 ? escape(digest) : `<span title="${escape(digest)}">${escape(digest.slice(0, 12))}…</span>`;
}

/** The badge for a run's outcome. A null outcome reads "running" ONLY when
 * the caller proved the run's lease is the task's current live claim — an
 * orphaned run keeps saying what actually became of it. */
export function runOutcomeBadge(run: Run, live: boolean): string {
  if (!live && run.role === "planner" && run.reason === "plan-drafted") {
    return `<span class="badge">Planned</span>`;
  }
  if (!live && run.reason === "interrupted") return `<span class="badge">Interrupted</span>`;
  return live
    ? `<span class="badge badge-running">Running</span>`
    : `<span class="badge badge-${escape(run.outcome ?? "cut")}">${escape(sentenceCase(run.outcome ?? "never finished"))}</span>`;
}

export const runNoun = (run: Pick<Run, "role">): string =>
  run.role === "planner" ? "plan" : run.role === "reviewer" ? "review" : run.role === "scout" ? "report" : "build";


export function runsPage(
  chrome: Chrome,
  rows: (Run & { taskId: string })[],
  liveIds: ReadonlySet<number>,
  nextCursor: number | null,
  verdicts: Map<number, { verdict: ProofVerdict; matrix?: CriterionMatrixRow[] }> = new Map(),
  accepted: ReadonlySet<number> = new Set(),
): Screen {
  const list =
    rows.length === 0
      ? `<p class="meta">No builds yet \u2014 they appear once an approved task is dispatched.</p>`
      : rows
          .map(run => {
            const verdict = verdicts.get(run.id)?.verdict ?? null;
            const needsVerification =
              (verdict === "short" || verdict === "refuted") && !accepted.has(run.id)
                ? ` <span class="badge badge-failed">${verdict === "refuted" ? "conflicting evidence" : "missing evidence"}</span>`
                : "";
            return (
              `<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              `<a href="${taskHref(run.taskId)}" class="mono">${escape(run.taskId)}</a> ` +
              runOutcomeBadge(run, liveIds.has(run.id)) +
              `${run.qualityMode === "strict" ? ` <span class="badge">Strict review</span>` : ""}` +
              needsVerification +
              criterionMatrixSummary(verdicts.get(run.id)?.matrix ?? []) +
              `${run.provider === "claude" ? "" : ` <span class="meta mono">${escape(run.provider)}</span>`}` +
              `<span class="right meta mono">${whenTime(run.startedAt)}` +
              `${run.providerStartedAt === null && run.tokensIn === null && run.tokensOut === null && run.costUsd === null ? "" : ` \u00b7 ${escape(runCostWords(run, liveIds.has(run.id)))}`}</span></p>`
            );
          })
          .join("\n");
  const older = nextCursor === null ? "" : `<p><a href="/runs?before=${nextCursor}">older →</a></p>`;
  return screen("builds", [`<h1>Builds <a class="badge" href="/peek">Peek at the live ones \u2192</a></h1>`, buildsViews("builds"), `<p class="hint">one build = one attempt by an agent to complete a task, on its own branch</p>`, list, older].join("\n"), { chrome });
}

/** The evidence bundle (Priority 2): the closed machine-authored verdict,
 * the agent's proof (or why it cannot be shown), the plane's own re-run
 * check, and every validated screenshot — each row labeled by source so
 * "the agent said" and "the machine proved" never blur together. */
export type ProofBundleView = {
  verdict: ProofVerdict | null;
  reasons: string[];
  accepted: { by: string; note: string | null; at: string } | null;
  proof: { criteria: { statement: string; verdict: string; how: string }[]; checks: { command: string; exitCode: number; summary: string }[]; caveats: string[] } | null;
  proofProblem: string | null;
  /** The check log as stored: its text when the bytes verify, else the
   * `problem` (repair 2026-09-14) — a log that no longer verifies shows no
   * text and offers no download. `bytesOriginal`/`bytesStored` let a
   * shortened log's download be described as the stored part only. */
  checkLog: { text: string; artifactId: number; truncated: boolean; problem: string | null; bytesOriginal: number; bytesStored: number } | null;
  /** Every stored screenshot artifact; one whose bytes no longer verify
   * carries its `problem` and is never rendered or called validated
   * (workspace package 3). */
  screenshots: ResultScreenshot[];
  /** Screenshot paths the proof cites that no stored artifact answers. */
  uncapturedScreenshots: string[];
  /** v39: the criterion-to-evidence matrix, one row per signed criterion —
   * `[]` when the scope this run built against signed no rubric. */
  matrix: CriterionMatrixRow[];
  /** v39 review finding: where a row's answered evidence ref resolves to a
   * stored artifact, for `criterionMatrixHtml` to link. */
  matrixLinks: EvidenceLinkMap;
  /** v40: the verdict BEFORE an independent reviewer's judgements were
   * folded in — null when no review has folded. */
  machineVerdict: ProofVerdict | null;
  /** v40: this run's own place in a bounded repair chain, if any. */
  repairChain: RepairChainRow | null;
  /** v51: the policy semantic coverage is read under. */
  qualityMode: "default" | "strict";
};

/** The smallest complete answer to "what did this task deliver?". It is a
 * projection of the same sealed handoff, proof, screenshot, and diff records
 * used by the run page—not a new persistence layer or another verdict. */
export type CompletionReceiptView = {
  runId: number;
  /** The run's role — a scout's receipt is a report, not a diff. */
  role: string;
  outcome: string | null;
  summary: string | null;
  verdict: ProofVerdict | null;
  /** The verdict's recorded reasons — what tells a failed check from
   * mismatched evidence (package 1). */
  reasons: string[];
  accepted: boolean;
  /** A no-change conclusion's two records — handoff and sealed diff. */
  recordComplete: boolean;
  /** The run's own publication record, when one exists: the heading names
   * a PR or a merge only from this, never from the outcome. */
  publication: PublicationFacts;
  /** This run's independent review, when one was asked (review fixes). */
  review: ReviewFacts | null;
  matrix: CriterionMatrixRow[];
  /** v51: the semantic-coverage lines (`coverageWords`) — independent
   * review standing under the run's policy, plus every named context gap.
   * Rendered beside the machine verdict on the task and chat receipts. */
  coverage: string[];
  /** Concise pass (2026-09-13): the coverage lines are secondary — behind a
   * disclosure — only while nothing is owed: review optional and not yet
   * settled, or satisfied. A strict-quality shortfall, a strict review
   * still pending, or a named context gap stays in the open. */
  coverageSecondary: boolean;
  diff:
    | { fileCount: number; additions: number; deletions: number; binaryCount: number; filesTruncated: boolean }
    | { problem: string }
    | null;
  screenshots: ResultScreenshot[];
  caveats: string[];
  /** The run's own report artifact (a scout's deliverable), verified at
   * render — the investigation's result leads with it (package 3). */
  report: RunReportView | null;
  /** The facts every result surface prints identically (package 3). */
  facts: SharedResultFacts;
};

/** A scout run's report as this run stored it: verified and parsed, or
 * the reason it cannot be shown. The download link serves the exact
 * stored bytes as text — never as a page. */
export type RunReportView =
  | { ok: true; artifactId: number; title: string; summary: string; document: string; followUps: number; truncated: boolean; items: ReportItem[]; shots: ReportShot[] }
  | { ok: false; artifactId: number; problem: string };

/** What a scout found, each with its link and picture, then any screenshot no item shows. Every link is the cited
 * http(s) address the report parser admitted; every picture is served from verified evidence. */
export function reportItemsHtml(items: readonly ReportItem[], shots: readonly ReportShot[], runId: number): string {
  const picture = (shot: ReportShot): string =>
    shot.artifactId === null
      ? `<p class="meta">Screenshot unavailable: ${escape(shot.problem ?? "it can't be shown")}</p>`
      : `<a class="receipt-shot" href="/r/${runId}/evidence/${shot.artifactId}"><img src="/r/${runId}/evidence/${shot.artifactId}" alt="${escape(shot.caption)}" loading="lazy"><span>${escape(shot.caption)}</span></a>`;
  const link = (url: string): string => `<a href="${escape(url)}" rel="noopener noreferrer nofollow" target="_blank" class="report-link">${escape(url)}</a>`;
  const shown = new Set(items.map(one => one.image).filter((one): one is string => one !== null));
  const loose = shots.filter(one => !shown.has(one.file));
  if (items.length === 0 && loose.length === 0) return "";
  return `<div class="report-items" data-report-items="${items.length}">` +
    (items.length === 0 ? "" : `<p><strong>What it found</strong></p><ol>${items.map(item => {
      const shot = item.image === null ? undefined : shots.find(one => one.file === item.image);
      return `<li data-report-item><p><strong>${escape(item.title)}</strong></p><p class="meta">${escape(item.why)}</p><p class="meta">${link(item.url)}</p>` +
        (shot === undefined ? "" : `<div class="receipt-visuals">${picture(shot)}</div>`) + `</li>`;
    }).join("")}</ol>`) +
    (loose.length === 0 ? "" : `<p><strong>Screenshots</strong></p><div class="receipt-visuals" aria-label="the scout's screenshots">${loose.map(picture).join("")}</div>`) +
    `</div>`;
}

export function runReportView(artifacts: Artifact[], root: string): RunReportView | null {
  const artifact = [...artifacts].reverse().find(one => one.kind === "report");
  if (artifact === undefined) return null;
  let read: ReturnType<typeof readVerifiedArtifact>;
  try {
    read = readVerifiedArtifact(root, artifact);
  } catch {
    return { ok: false, artifactId: artifact.id, problem: "the report file could not be read" };
  }
  if (!read.ok) return { ok: false, artifactId: artifact.id, problem: read.problem };
  const parsed = parseReport(read.content.toString("utf8"), { stored: true });
  if (!parsed.ok) return { ok: false, artifactId: artifact.id, problem: artifact.truncated ? "the report was shortened at storage and cannot be read; the missing part was never captured" : "the stored report is not a report this console can read" };
  return { ok: true, artifactId: artifact.id, title: parsed.report.title, summary: parsed.report.summary, document: parsed.report.report, followUps: parsed.report.followUps.length, truncated: artifact.truncated,
    items: parsed.report.items, shots: reportShotsOf(artifacts, root, artifact.run, parsed.report.images) };
}

/** The shared facts (package 3), computed ONCE from the same verified
 * records every surface reads: the head from the sealed diff summary when
 * it verifies (else the run record, and the source is named), the signed
 * criteria passed from the machine's matrix, the proof's caveats, every
 * evidence problem in words, and the observed publication state. */
export function sharedResultFactsOf(
  run: Run,
  proof: ProofBundleView | null,
  terminal: TerminalDiffView | null,
  handoff: StructuredHandoffView | null,
  report: RunReportView | null,
  publication: PublicationFacts,
): SharedResultFacts {
  const stat = terminal?.stat ?? null;
  const statOk = stat !== null && !("problem" in stat);
  const passed = proof === null || proof.matrix.length === 0 ? null : passFraction(proof.matrix);
  const patch = terminal?.patch ?? null;
  const evidenceProblems = evidenceProblemDetailsOf({
    proofProblem: proof?.proofProblem ?? null,
    diff: patch === null ? null : "problem" in patch ? { problem: patch.problem } : { truncated: patch.truncated },
    stat: stat === null ? null : "problem" in stat ? { problem: stat.problem } : { filesTruncated: stat.filesTruncated },
    checkLog:
      proof?.checkLog === null || proof?.checkLog === undefined
        ? null
        : proof.checkLog.problem === null ? { truncated: proof.checkLog.truncated } : { problem: proof.checkLog.problem },
    screenshots: proof?.screenshots ?? [],
    uncapturedScreenshots: proof?.uncapturedScreenshots ?? [],
    report: report === null ? null : report.ok ? { ok: true, truncated: report.truncated } : { problem: report.problem },
    reportExpected: run.role === "scout",
    handoffPresent: handoff !== null,
    outcome: run.outcome,
  });
  return {
    runId: run.id,
    base: statOk ? stat.base : run.baseRevision,
    head: statOk ? stat.head : run.headRevision,
    headSource: statOk ? "sealed diff" : run.headRevision === null ? null : "run record",
    checks: passed === null ? null : { passed: passed.passed, total: passed.total },
    caveats: proof?.proof?.caveats ?? [],
    evidenceProblems: evidenceProblems.map(one => one.words),
    evidenceHealth: evidenceHealthOf(evidenceProblems),
    publicationState: publication === null ? "none" : publication.state,
    publicationWords: receiptPublicationWords(publication),
  };
}


export function proofBundleView(store: Store, run: Run, artifacts: Artifact[], root: string): ProofBundleView | null {
  const verdictRow = store.proofVerdictFor(run.id);
  const acceptanceRow = store.proofAcceptance(run.id);
  const proofView = readVerifiedProofForRun(store, root, run.id);
  const checkLogArtifact = artifacts.find(one => one.kind === "check-log") ?? null;
  const screenshotArtifacts = artifacts.filter(one => one.kind === "screenshot");

  if (verdictRow === null && proofView === null && checkLogArtifact === null && screenshotArtifacts.length === 0) {
    return null;
  }

  const proof = proofView !== null && proofView.ok ? proofView.proof : null;
  const captionFor = (path: string): string => proof?.screenshots.find(one => one.path === path)?.caption ?? path;
  const screenshots = screenshotArtifacts.flatMap((artifact): ResultScreenshot[] => {
    const path = SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1];
    if (path === undefined) return [];
    // The bytes are re-verified at render (workspace package 3): a shot
    // whose file is gone or altered is named as unavailable, never shown
    // as validated visual proof.
    let problem: string | null = null;
    try {
      const read = readVerifiedArtifact(root, artifact);
      if (!read.ok) problem = read.problem;
    } catch {
      problem = "the file could not be read";
    }
    return [{ path, caption: captionFor(path), artifactId: artifact.id, problem }];
  });
  const stored = new Set(screenshots.map(one => one.path));
  const uncapturedScreenshots = (proof?.screenshots ?? []).map(one => one.path).filter(path => !stored.has(path));

  let checkLog: ProofBundleView["checkLog"] = null;
  if (checkLogArtifact !== null) {
    // Re-verified at render: a log whose bytes no longer hash to their
    // record is a named evidence problem, never shown as output.
    let read: ReturnType<typeof readVerifiedArtifact>;
    try {
      read = readVerifiedArtifact(root, checkLogArtifact);
    } catch {
      read = { ok: false, problem: "the file could not be read" };
    }
    const sizes = { bytesOriginal: checkLogArtifact.bytesOriginal, bytesStored: checkLogArtifact.bytesStored };
    checkLog = read.ok
      ? { text: read.content.toString("utf8"), artifactId: checkLogArtifact.id, truncated: checkLogArtifact.truncated, problem: null, ...sizes }
      : { text: "", artifactId: checkLogArtifact.id, truncated: checkLogArtifact.truncated, problem: read.problem, ...sizes };
  }

  return {
    verdict: verdictRow?.verdict ?? null,
    reasons: verdictRow?.reasons ?? [],
    accepted: acceptanceRow === null ? null : { by: acceptanceRow.approver, note: acceptanceRow.note, at: acceptanceRow.acceptedAt },
    proof:
      proof === null
        ? null
        : {
            criteria: proof.criteria.map(one => ({ statement: one.statement, verdict: one.verdict, how: one.how })),
            checks: proof.checks,
            caveats: proof.caveats,
          },
    proofProblem: proofView !== null && !proofView.ok ? proofView.problem : null,
    checkLog,
    screenshots,
    uncapturedScreenshots,
    matrix: verdictRow?.matrix ?? [],
    // A matrix row links only to records that still verify (repair
    // 2026-09-14): a damaged screenshot or check log is named as a
    // problem above, never offered as a download.
    matrixLinks: (() => {
      const damaged = new Set([...screenshots.filter(one => one.problem !== null).map(one => one.artifactId), ...(checkLog !== null && checkLog.problem !== null ? [checkLog.artifactId] : [])]);
      return new Map([...evidenceLinksFor(artifacts)].filter(([, id]) => !damaged.has(id)));
    })(),
    machineVerdict: verdictRow?.machineVerdict ?? null,
    qualityMode: run.qualityMode ?? "default",
    repairChain: store.repairChainFor(run.id) ?? (() => {
      const ref = store.refById(run.taskRef);
      return ref === null ? null : store.repairChainForDraft(ref.externalId);
    })(),
  };
}

export function completionReceiptView(store: Store, run: Run, artifacts: Artifact[], root: string, review: ReviewFacts | null = null): CompletionReceiptView {
  const handoff = structuredHandoffView(artifacts, root);
  const proof = proofBundleView(store, run, artifacts, root);
  const terminal = terminalDiffView(artifacts, root);
  const report = runReportView(artifacts, root);
  const stat = terminal?.stat ?? null;
  const coverage = semanticCoverage(proof?.matrix ?? [], run.qualityMode ?? "default");
  const publication = publicationFactsOf(store.publicationForRun(run.id));
  return {
    runId: run.id,
    role: run.role,
    outcome: run.outcome,
    summary: run.role === "scout" ? report?.ok ? report.summary : "The report needs attention." : handoff?.conclusion ?? run.handoff,
    verdict: proof?.verdict ?? null,
    reasons: proof?.reasons ?? [],
    accepted: proof?.accepted !== null && proof?.accepted !== undefined,
    recordComplete: handoff !== null && terminal !== null,
    publication,
    review,
    matrix: proof?.matrix ?? [],
    diff:
      stat === null || "problem" in stat
        ? stat
        : {
            fileCount: stat.fileCount,
            additions: stat.additions,
            deletions: stat.deletions,
            binaryCount: stat.binaryCount,
            filesTruncated: stat.filesTruncated,
          },
    screenshots: proof?.screenshots ?? [],
    caveats: proof?.proof?.caveats ?? [],
    coverage: coverage.contextGaps.length > 0 || (proof?.matrix ?? []).some(row => row.review != null || row.assessment !== undefined) ? coverageWords(coverage) : [],
    coverageSecondary: coverage.contextGaps.length === 0 && (coverage.satisfied === true || (coverage.satisfied === null && !coverage.required)),
    report,
    facts: sharedResultFactsOf(run, proof, terminal, handoff, report, publication),
  };
}

export type ReviewDiffLine = {
  kind: "context" | "addition" | "deletion" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};
export type ReviewDiffHunk = { header: string; lines: ReviewDiffLine[] };
export type ReviewDiffFile = { path: string; oldPath: string | null; meta: string[]; hunks: ReviewDiffHunk[] };
export type ReviewDiff = { files: ReviewDiffFile[]; linesTruncated: boolean };

export const REVIEW_DIFF_LINE_CAP = 4_000;

/** Parse only the stable structure Git's unified patch format guarantees.
 * Unknown metadata remains visible, and a patch that cannot be structured
 * falls back to the sealed raw record—presentation never becomes proof. */
export function parseReviewDiff(text: string): ReviewDiff {
  const files: ReviewDiffFile[] = [];
  let file: ReviewDiffFile | null = null;
  let hunk: ReviewDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let rendered = 0;
  let linesTruncated = false;

  const pathOf = (raw: string): string => {
    const withoutTimestamp = raw.split("\t", 1)[0]?.trim() ?? raw.trim();
    let decoded = withoutTimestamp;
    if (decoded.startsWith('"') && decoded.endsWith('"')) {
      try { decoded = JSON.parse(decoded) as string; } catch { decoded = decoded.slice(1, -1); }
    }
    return decoded === "/dev/null" ? decoded : decoded.replace(/^[ab]\//, "");
  };

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const at = raw.lastIndexOf(" b/");
      file = { path: at === -1 ? "changed file" : pathOf(raw.slice(at + 1)), oldPath: null, meta: [raw], hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith("--- ")) {
      file.oldPath = pathOf(raw.slice(4));
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const nextPath = pathOf(raw.slice(4));
      if (nextPath !== "/dev/null") file.path = nextPath;
      file.meta.push(raw);
      continue;
    }
    const hunkHeader = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@(.*)$/.exec(raw);
    if (hunkHeader !== null) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) {
      if (raw !== "") file.meta.push(raw);
      continue;
    }
    if (rendered >= REVIEW_DIFF_LINE_CAP) {
      linesTruncated = true;
      continue;
    }
    rendered += 1;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      hunk.lines.push({ kind: "addition", text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      hunk.lines.push({ kind: "deletion", text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      hunk.lines.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
    }
  }
  return { files, linesTruncated };
}

export function reviewDiffHtml(
  patch: { text: string; truncated: boolean; artifactId: number },
  stat: TerminalDiffView["stat"],
  runId: number,
  commentable: boolean,
  anchors: ReadonlyMap<string, string> = new Map(),
): string {
  const parsed = parseReviewDiff(patch.text);
  const structured = parsed.files.some(file => file.hunks.length > 0);
  if (!structured) {
    return (
      `<details><summary>The patch${patch.truncated ? " (TRUNCATED — the raw record says how much was cut)" : ""}</summary>` +
      `<pre class="mono" style="overflow-x:auto">${escape(patch.text)}</pre></details>` +
      storedDownloadLink(runId, patch.artifactId, "diff", patch.truncated)
    );
  }
  const stats = stat !== null && !("problem" in stat) ? new Map(stat.files.map(one => [one.path, one] as const)) : new Map();
  const annotateIcon = strokeIcon(`<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8"/>`);
  const files = parsed.files.map((one, fileIndex) => {
    const counts = stats.get(one.path);
    const countWords = counts === undefined
      ? ""
      : counts.additions === null || counts.deletions === null
        ? `<span class="diff-file-counts">binary</span>`
        : `<span class="diff-file-counts"><b>+${counts.additions}</b><i>−${counts.deletions}</i></span>`;
    const fileAnchor = anchors.get(one.path);
    // Each change is a link target of its own (#<file anchor>-L<first new line>): a result names the exact lines.
    const hunks = one.hunks.map(hunk => {
      const first = hunk.lines.find(line => line.newLine !== null && line.kind !== "meta")?.newLine ?? null;
      return `<section class="diff-hunk"${fileAnchor === undefined || first === null ? "" : ` id="${fileAnchor}-L${first}"`}><div class="diff-hunk-head">${escape(hunk.header)}</div>` +
      `<div class="diff-lines">${hunk.lines.map(line => {
        const lineNumber = line.newLine ?? line.oldLine;
        const side = line.newLine === null && line.oldLine !== null ? "old" : "new";
        const annotate = !commentable || lineNumber === null || line.kind === "meta"
          ? `<span class="diff-annotate-space"></span>`
          : `<button type="button" class="diff-annotate pick-line" data-path="${escape(one.path)}" data-line="${lineNumber}" data-side="${side}" aria-label="Annotate ${escape(one.path)}, ${side} line ${lineNumber}" title="Annotate this line">${annotateIcon}</button>`;
        const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : line.kind === "context" ? " " : "·";
        return (
          `<div class="diff-line diff-${line.kind}">${annotate}` +
          `<span class="diff-gutter">${line.oldLine ?? ""}</span><span class="diff-gutter">${line.newLine ?? ""}</span>` +
          `<code><b aria-hidden="true">${marker}</b>${escape(line.text)}</code></div>`
        );
      }).join("")}</div></section>`;
    }).join("");
    const anchor = anchors.get(one.path);
    return (
      `<details class="diff-file"${fileIndex === 0 ? " open" : ""}${anchor === undefined ? "" : ` id="${anchor}"`}>` +
      `<summary><span class="diff-file-name">${escape(one.path)}</span>${countWords}</summary>` +
      (one.oldPath !== null && one.oldPath !== "/dev/null" && one.oldPath !== one.path ? `<p class="diff-rename meta">from ${escape(one.oldPath)}</p>` : "") +
      hunks + `</details>`
    );
  }).join("");
  return (
    `<div class="diff-review" data-review-diff>` +
    (commentable
      ? `<div class="diff-review-bar"><span class="meta">${parsed.files.length} changed file${parsed.files.length === 1 ? "" : "s"}</span>` +
        `<div class="diff-modes" role="group" aria-label="diff mode"><button type="button" data-diff-mode="view" aria-pressed="true">View</button>` +
        `<button type="button" data-diff-mode="annotate" aria-pressed="false">Annotate</button></div></div>` +
        `<p class="diff-review-help">Select a line, then describe what should change. Nothing is revised until you create the revision below.</p>`
      : "") +
    files +
    (patch.truncated
      ? `<p class="diff-cut">The sealed diff was shortened at storage: the rest of the change was never captured, here or in the download.</p>`
      : parsed.linesTruncated ? `<p class="diff-cut">This visual diff is shortened. Review the sealed patch before approving.</p>` : "") +
    `</div>` + storedDownloadLink(runId, patch.artifactId, "diff", patch.truncated)
  );
}

/** The check log as stored (repair 2026-09-14): its output behind a
 * disclosure when the bytes verify — a shortened log says so in the
 * summary and its download is the stored part; a log that no longer
 * verifies is a named problem with no output and no download. */
export function checkLogHtml(log: NonNullable<ProofBundleView["checkLog"]>, runId: number, attributes: string): string {
  if (log.problem !== null) {
    return `<p class="problem" data-check-log="damaged"${attributes}>The check log no longer verifies (${escape(log.problem)}). Its output is not shown, and there is nothing to download.</p>`;
  }
  return (
    `<details data-check-log="${log.truncated ? "shortened" : "ok"}"${attributes}><summary>Check output${log.truncated ? ` (shortened — ${log.bytesStored} of ${log.bytesOriginal} bytes stored)` : ""}</summary><pre class="mono" style="overflow-x:auto;max-height:18rem">${
      // Each line is a link target (#check-log-L<n>): a failed task names the exact line its check ended on.
      log.text.split("\n").map((line, index) => `<span id="check-log-L${index + 1}">${escape(line)}</span>`).join("\n")}</pre></details>` +
    storedDownloadLink(runId, log.artifactId, "check log", log.truncated)
  );
}

/** The download link for a stored record (repair 2026-09-14): a shortened
 * record's link says it holds the stored part only — never "the full"
 * bytes that were cut at storage and exist nowhere. */
export function storedDownloadLink(runId: number, artifactId: number, what: string, truncated: boolean): string {
  return `<p class="meta"><a href="/r/${runId}/evidence/${artifactId}">${truncated ? `Download the stored part of the ${what} (shortened at storage — not the full ${what})` : `Download the ${what}`}</a></p>`;
}

/** Render the terminal diff card: stat and capture health first, the bounded
 * patch beneath a fold. `editor` (arc 6) links file rows to vscode:// on the
 * reviewing device; `commentable` adds a per-file "comment" button the
 * page's prefill script reads — a real button, keyboard-reachable, separate
 * from the link so the two never fight over one click (finding 4). */
export function terminalDiffCard(
  view: TerminalDiffView,
  runId: number,
  editor: { worktree: string } | null = null,
  commentable = false,
): string {
  const parts: string[] = ["<h2>What changed</h2>"];

  if (view.stat === null) {
    parts.push(`<p class="meta">No change summary was captured for this build</p>`);
  } else if ("problem" in view.stat) {
    parts.push(`<p class="meta">Stat: ${escape(view.stat.problem)}</p>`);
  } else {
    const s = view.stat;
    const zero = s.fileCount === 0;
    parts.push(
      `<p class="row"><span class="mono">${escape(s.base.slice(0, 12))} → ${escape(s.head.slice(0, 12))}</span> — ` +
        (zero
          ? "no changes, verified"
          : `${s.fileCount} file(s) · +${s.additions} −${s.deletions}` +
            (s.binaryCount > 0 ? ` · ${s.binaryCount} binary` : "") +
            (s.filesTruncated ? " · file list cut, counts complete" : "")) +
        `</p>`,
    );
    if (!zero) {
      const fileName = (path: string): string => {
        const href = editor === null ? null : editorFileHref(editor.worktree, path);
        return href === null ? escape(path) : `<a href="${escape(href)}">${escape(path)}</a>`;
      };
      parts.push(
        `<div class="evidence">` +
          s.files
            .slice(0, 40)
            .map(
              file =>
                `<p class="row mono">${fileName(file.path)}${file.renamedFrom === undefined ? "" : ` (was ${escape(file.renamedFrom)})`} ` +
                `<span class="meta">${file.additions === null || file.deletions === null ? "binary" : `+${file.additions} −${file.deletions}`}</span>` +
                `${commentable ? ` <button type="button" class="pick-file" data-path="${escape(file.path)}">Comment</button>` : ""}</p>`,
            )
            .join("\n") +
          (s.files.length > 40 ? `<p class="meta">…and ${s.files.length - 40} more file(s)</p>` : "") +
          `</div>`,
      );
      if (editor !== null) {
        parts.push(`<p class="meta">File links open in VS Code on THIS device — if the build's worktree is gone, a link opens nothing</p>`);
      }
    }
  }

  if (view.patch === null) {
    parts.push(`<p class="meta">The final diff was not captured for this build</p>`);
  } else if ("problem" in view.patch) {
    parts.push(`<p class="meta">Patch: ${escape(view.patch.problem)}</p>`);
  } else if (view.patch.text.trim() === "") {
    parts.push(`<p class="meta">Empty diff — captured successfully, nothing changed</p>`);
  } else {
    parts.push(reviewDiffHtml(view.patch, view.stat, runId, commentable));
  }

  return parts.join("\n");
}

/**
 * The evidence bundle (Priority 2): the closed verdict first — the one
 * sentence every other surface agrees with — then criteria, the agent's
 * declared checks, the plane's own re-run (labeled "re-run here", never
 * confused with the agent's own claim), caveats, and every validated
 * screenshot as a thumbnail linking to the full image. Renders nothing
 * when the run predates the proof system.
 */
export function evidenceBundleCard(view: ProofBundleView | null, run: Pick<Run, "id" | "role" | "outcome">, publication: PublicationFacts = null, review: ReviewFacts | null = null): string {
  if (view === null) return "";
  const runId = run.id;
  const parts: string[] = ["<h2>Verification and evidence</h2>"];

  if (view.verdict !== null) {
    // The same status line every other surface renders for this run
    // (workspace package 1), beside the verdict's own explanation.
    const status = resultStatusOf({ runId, role: run.role, outcome: run.outcome, verdict: view.verdict, reasons: view.reasons, accepted: view.accepted !== null, review }, publication);
    parts.push(`<p class="row" data-proof-verdict="${escape(dispatchStatusToken(view.verdict))}">${statusLineHtml(status)} <span class="meta">${escape(verificationExplanation(view.verdict, view.reasons))}</span></p>`);
  }
  if (view.accepted !== null) {
    parts.push(
      `<p class="meta">Accepted with an exception by <span class="mono">${escape(view.accepted.by)}</span> · ${whenTime(view.accepted.at)}${view.accepted.note === null ? "" : ` — ${escape(view.accepted.note)}`}</p>`,
    );
  }

  parts.push(criterionMatrixHtml(view.matrix, { runId, links: view.matrixLinks, verdict: view.verdict }));
  parts.push(semanticCoverageHtml(view.matrix, view.qualityMode));
  if (reviewConflict(view.matrix, view.machineVerdict, view.verdict)) {
    parts.push(`<p class="meta">An independent review found conflicting evidence.</p>`);
  }
  parts.push(repairChainHtml(view.repairChain));

  if (view.proofProblem !== null) {
    parts.push(`<p class="meta">Verification details are unavailable: ${escape(view.proofProblem)}</p>`);
  } else if (view.proof !== null) {
    if (view.proof.criteria.length > 0) {
      parts.push(
        `<div class="result-section"><strong>Acceptance criteria</strong><ul>` +
          view.proof.criteria
            .map(one => `<li><span class="badge${one.verdict === "met" ? " badge-done" : one.verdict === "not-met" ? " badge-failed" : ""}">${escape(sentenceCase(one.verdict))}</span> ${escape(one.statement)} <span class="meta">— ${escape(one.how)}</span></li>`)
            .join("") +
          `</ul></div>`,
      );
    }
    if (view.proof.checks.length > 0) {
      parts.push(
        `<div class="result-section"><strong>Checks reported by the agent</strong><ul>` +
          view.proof.checks.map(one => `<li><span class="mono">${escape(one.command)}</span> <span class="meta">(exit ${one.exitCode}) — ${escape(one.summary)}</span></li>`).join("") +
          `</ul></div>`,
      );
    }
    if (view.proof.caveats.length > 0) {
      parts.push(`<div class="result-section"><strong>Caveats</strong><ul>${view.proof.caveats.map(one => `<li>${escape(one)}</li>`).join("")}</ul></div>`);
    }
  }

  if (view.checkLog !== null) parts.push(checkLogHtml(view.checkLog, runId, ""));

  if (view.screenshots.length > 0) {
    parts.push(
      `<div class="result-section"><strong>Screenshots</strong>` +
        view.screenshots
          .map(
            shot =>
              `<p class="row"><a href="/r/${runId}/evidence/${shot.artifactId}">` +
              `<img src="/r/${runId}/evidence/${shot.artifactId}" alt="${escape(shot.caption)}" style="max-width:12rem;max-height:9rem;border-radius:var(--radius);border:1px solid var(--border)"></a> ` +
              `<span class="meta">${escape(shot.caption)} · <span class="mono">${escape(shot.path)}</span></span></p>`,
          )
          .join("\n") +
        `</div>`,
    );
  }

  return parts.length === 1 ? "" : parts.join("\n");
}

/** A calm, scan-first result receipt for the task and its focused chat.
 * The full ledger remains one click away; this card carries only the facts
 * needed to decide whether to inspect, discuss, or move on. */
/** The receipt's proof-state word and tone, from the stored verdict and
 * the operator's acceptance alone — shared with the review cockpit's
 * header chip so the two surfaces never name one state differently. */
/** The receipt's facts as the shared projection reads them. */
/** A result's follow-ups: checks run on its commit since it finished, and its tests task. */
export function followUpsFor(store: Store, evidenceRoot: string, run: Run, now: Date): NonNullable<ResultDetail["followUps"]> | null {
  if (run.role !== "builder" || run.finishedAt === null || run.headRevision === null) return null;
  const repo = store.refById(run.taskRef)?.repo ?? null;
  const tests = store.handle.prepare("SELECT outcome FROM action_ledger WHERE run_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(run.id, ADD_TESTS_ACTION);
  return { repo, checks: followUpChecksOf(store, run.id, now, evidenceRoot), testsTask: tests === undefined ? null : String(tests["outcome"]),
    quick: repo !== null && liveQuickCommand(store, repo) !== null, full: repo !== null && store.liveVerifyCommand(repo) !== null };
}

export const FOLLOW_UP_WORDS: Record<FollowUpCheck["state"], string> = { waiting: "waiting for a worker", running: "running", passed: "passed", failed: "failed", "not-run": "didn't run" };
/** Run checks and Add tests, under the result's Checks: what ran since, then the two acts. */
export function followUpsHtml(followUps: NonNullable<ResultDetail["followUps"]>, runId: number, o: ResultPanelOptions): string {
  // A batch check names every result it ran with and the exact commit it tested (batch-checks.ts).
  const batchHow = (one: FollowUpCheck): string => {
    const peers = one.batch?.members.filter(member => member.run !== runId).map(member => member.task) ?? [];
    return one.batch?.mode === "together" && peers.length > 0 ? ` together with ${peers.map(escape).join(", ")}`
      : one.batch?.mode === "split" ? " on its own after its batch failed" : one.batch?.mode === "conflict" ? " on its own (it conflicted with another result)" : "";
  };
  const rows = followUps.checks.map(one => `<li data-follow-up-check="${one.state}"${one.why === "batch" ? ` data-batch="${escape(one.batch?.mode ?? "waiting")}"` : ""}>${escape(CHECK_LEVEL_WORDS[one.level])} checks ` +
    `${escape(one.why === "batch" && one.state === "waiting" ? "waiting to check with other results" : FOLLOW_UP_WORDS[one.state])}${batchHow(one)}` +
    `${one.exitCode === null || one.state === "passed" ? "" : ` (exit ${one.exitCode})`} on <span class="mono">${escape((one.tested ?? one.head).slice(0, 7))}</span>` +
    `<span class="meta"> · ${one.why === "pull-request" ? "for the pull request" : one.why === "batch" ? "batch check" : escape(one.actor)}${one.note === null ? "" : ` · ${escape(one.note)}`}</span>` +
    `${one.logArtifactId === null ? "" : ` <a href="/r/${runId}/evidence/${one.logArtifactId}">Log</a>`}</li>`).join("");
  const hidden = `<input type="hidden" name="csrf" value="${escape(o.csrf)}"><input type="hidden" name="return" value="${escape(o.returnTo)}">`;
  const canCheck = followUps.quick || followUps.full;
  const checkActs = !canCheck || o.csrf === "" ? "" : `<form method="post" action="/r/${runId}/checks" class="follow-up-act">${hidden}` +
    (followUps.quick && followUps.full ? `<button type="submit" name="level" value="quick">Run quick checks</button><button type="submit" name="level" value="full" class="secondary">Run full checks</button>`
      : `<button type="submit" name="level" value="${followUps.quick ? "quick" : "full"}">Run checks</button>`) + `</form>`;
  const tests = followUps.testsTask !== null ? `<p class="meta">Tests task: <a href="${taskHref(followUps.testsTask)}">${escape(followUps.testsTask)}</a></p>`
    : o.csrf === "" ? "" : `<form method="post" action="/r/${runId}/add-tests" class="follow-up-act">${hidden}<button type="submit" class="secondary">Add tests</button></form>`;
  return `<section class="result-section follow-ups" id="follow-ups" data-follow-ups><strong>Follow-ups</strong>` +
    (rows === "" ? "" : `<ul class="follow-up-list">${rows}</ul>`) +
    (canCheck || followUps.repo === null ? "" : `<p class="meta">No approved check to run. <a href="/settings/checks?repo=${encodeURIComponent(followUps.repo)}">Set one up</a>.</p>`) +
    (checkActs === "" && tests === "" ? "" : `<div class="follow-up-acts">${checkActs}${tests}</div>`) + `</section>`;
}

export function receiptStatusOf(view: CompletionReceiptView, review: ReviewFacts | null = view.review): DisplayStatus {
  // The evidence health rides the status (repair 2026-09-14): a result
  // whose stored records are damaged is never called ready on the strength
  // of a verdict recorded before the damage.
  return evidenceResultStatusOf(
    { runId: view.runId, role: view.role, outcome: view.outcome, verdict: view.verdict, reasons: view.reasons, accepted: view.accepted, recordComplete: view.recordComplete, review },
    view.publication, view.facts.evidenceHealth,
  );
}

export function completionReceiptCard(view: CompletionReceiptView, taskId: string, place: "task" | "chat", standing: DisplayStatus = receiptStatusOf(view), assignment: AssignmentSnapshot | null = null, headline = true): string {
  const current = assignment?.receipt?.runId === view.runId ? assignment : null;
  const presentation = current === null ? null : assignmentPresentationOf(current);
  const status = presentation?.status ?? standing;
  // The verdict on record, whatever review is in flight: the criteria
  // count's source label reads from it, never from the review's tone.
  const stored = receiptStatusOf(view, null);
  const inReview = REVIEW_TOKENS.has(status.token);
  const facts = view.facts;
  const shown = view.screenshots.filter(one => one.problem === null);
  const unavailable = view.screenshots.length - shown.length;
  const diff =
    view.diff === null
      ? "Change summary unavailable"
      : "problem" in view.diff
        ? "Change summary unavailable"
        : view.diff.fileCount === 0
          ? "No repository changes"
          : `${view.diff.fileCount} file${view.diff.fileCount === 1 ? "" : "s"} · +${view.diff.additions} −${view.diff.deletions}` +
            (view.diff.binaryCount > 0 ? ` · ${view.diff.binaryCount} binary` : "") +
            (view.diff.filesTruncated ? " · list shortened" : "");
  const criteria =
    facts.checks === null
      ? "No requirements set"
      : `${facts.checks.passed}/${facts.checks.total} requirements met`;
  // The deliverable leads (package 3): a scout's report by its title, UI
  // work by its validated screenshots. Unverifiable shots are counted as
  // unavailable, never shown, never called validated.
  const lead =
    view.report !== null
      ? view.report.ok
        ? `<p class="receipt-report"><strong>${escape(view.report.title)}</strong> <span class="meta">${escape(oneLineOf(view.report.summary, 240))}</span></p>`
        : `<p class="receipt-report problem">The report cannot be shown: ${escape(view.report.problem)}.</p>`
      : shown.length === 0
        ? ""
        : `<div class="receipt-visuals" aria-label="validated screenshots">${shown
            .slice(0, 4)
            .map(
              shot =>
                `<a class="receipt-shot" href="/r/${view.runId}/evidence/${shot.artifactId}">` +
                `<img src="/r/${view.runId}/evidence/${shot.artifactId}" alt="${escape(shot.caption)}">` +
                `<span>${escape(shot.caption)}</span></a>`,
            )
            .join("")}</div>`;
  // Caveats and evidence problems stay in the open, ahead of the counts
  // and any readiness words below them.
  const attention = current === null ? [...facts.evidenceProblems, ...view.caveats] : [];
  const caveats =
    attention.length === 0
      ? ""
      : `<div class="receipt-caveats" data-result-attention="${attention.length}"><strong>Before you move on</strong><ul>${attention.map(one => `<li>${escape(plainReasonWords(one))}</li>`).join("")}</ul></div>`;
  // v51: semantic coverage, distinct from the machine proof word above —
  // the same lines the CLI prints, so chat and terminal cannot disagree.
  // Nothing owed (optional and unsettled, or satisfied) folds behind a
  // disclosure; a strict shortfall or a context gap stays in the open.
  const coverage =
    view.coverage.length === 0
      ? ""
      : current !== null || view.coverageSecondary
        ? `<details class="receipt-coverage" data-semantic-coverage="secondary"><summary>Previous assessment</summary><ul>${view.coverage.map(one => `<li>${escape(one)}</li>`).join("")}</ul></details>`
        : `<div class="receipt-coverage" data-semantic-coverage=""><strong>Previous assessment</strong><ul>${view.coverage.map(one => `<li>${escape(one)}</li>`).join("")}</ul></div>`;
  const resultHref = status.token === "review-failed" ? reviewHref(taskId) : place === "chat" ? chatResultHref(taskId, view.runId, status.action?.kind === "open-review" ? "checks" : "summary") : statusActionHref(status, taskId, view.runId, view.publication?.prUrl ?? null) ?? `/r/${view.runId}`;
  return (
    `<section class="card completion-receipt" data-card-kind="result-receipt"${resultFactsAttributes(facts)}>` +
    `<div class="receipt-head"><div><h2>${escape(receiptHeadingOf(view.outcome, view.publication, view.role))}</h2></div>` +
    `${headline ? statusLineHtml(status) : ""}</div>` +
    // The agent's handoff is its narrative, labeled as such; the
    // publication line is the observed record — never "shipped".
    lead +
    `<p class="receipt-summary">${escape(conciseOutcomeOf(view.summary ?? (view.outcome === "no-change" ? "The agent found that no repository change was needed." : "The build finished without a concise handoff.")))}</p>` +
    (headline ? `<div class="receipt-actions"><a class="button-link" href="${escape(resultHref)}" data-open-result data-primary-action>${escape(status.action?.label ?? "Open result")}</a></div>` : "") +
    // A pull request that couldn't open never undoes the result: an amber note, not red.
    (view.publication?.state === "failed" ? `<p class="receipt-note">${statusIconSvg("note")} Pull request couldn't open. The commit is safe locally.</p>` : "") +
    caveats +
    coverage +
    `<details class="receipt-details"><summary>${STATUS_MORE}</summary>` +
    (view.summary !== null && view.summary !== conciseOutcomeOf(view.summary) ? `<p class="recap">${escape(view.summary)}</p>` : "") +
    `<p class="receipt-publication" data-receipt-publication="${escape(facts.publicationState)}">${escape(facts.publicationWords)}</p>` +
    // A review in flight is the receipt's primary status too (its chip
    // above); the detail — the earlier verdict as history (review fixes,
    // finding 4) — is secondary, behind a native disclosure that reads the
    // same words on the task page and in chat.
    (inReview ? `<details class="receipt-history"><summary>Review history</summary><p class="receipt-review meta" data-receipt-review="${escape(status.token)}">${escape(status.detail)}</p></details>` : "") +
    // The matrix count is the proof's own citation; it reads as verified
    // only when the machine verified the result (workspace package 1).
    `<div class="receipt-facts"><span><strong>${escape(criteria)}</strong><small>${stored.tone === "problem" ? "the agent's own claim — not checked" : stored.token === "agent-attested" ? "the agent's own claim, no project check" : "against the approved scope"}</small></span>` +
    `<span><strong>${escape(diff)}</strong><small>${facts.head === null ? "no commit recorded" : `head ${escape(facts.head.slice(0, 12))} · ${escape(facts.headSource ?? "")}`}</small></span>` +
    `<span><strong>${view.screenshots.length} screenshot${view.screenshots.length === 1 ? "" : "s"}</strong><small>${view.screenshots.length === 0 ? "none required or captured" : unavailable === 0 ? "validated visual proof" : `${unavailable} unavailable — not validated`}</small></span></div>` +
    `<div class="receipt-actions">` +
    (place === "task"
      ? `<a href="${taskChatHref(taskId)}">Discuss in chat →</a>`
      : `<a href="/r/${view.runId}">Full build record →</a>`) +
    // The cockpit (Priority 5): the same records, arranged for a reviewer.
    `<a href="${reviewHref(taskId)}">Open result →</a>` +
    `</div></details></section>`
  );
}

/** The chat's result detail (package 3): the same panel the run page
 * and the cockpit render, opened beside the conversation when the screen
 * has room and as a dedicated view with Back to chat when it does not. */
export const chatResultHref = (taskId: string, runId: number, tab: ResultTab = "summary"): string => sharedResultHref(taskId, runId, tab);

/**
 * ONE result presentation (workspace package 3) for the run page, the
 * review cockpit, and the chat's result detail. Every fact here comes
 * from the same verified records the receipt reads; the surfaces differ
 * only in where the panel sits and which links lead away from it.
 */
export type ResultDetail = {
  /** Where "Complete and open a pull request" opens one; null when only "Mark complete" is offered. */
  pullRequestTo?: string | null;
  /** Where publishing stands: a pull request can be opened, publishing isn't set up, or neither said. Accept never publishes. */
  publishing?: "pull-request" | "off" | "other";
  learning?: string;
  skillTest?: boolean;
  rootId?: string;
  history?: string;
  taskId: string;
  run: Run;
  receipt: CompletionReceiptView;
  assignment?: AssignmentSnapshot | null;
  handoff: StructuredHandoffView | null;
  proof: ProofBundleView | null;
  terminal: TerminalDiffView | null;
  publication: Publication | null;
  ciFailing: boolean;
  files: (ReviewFileRow & { priority: ReviewPriority })[];
  outsideTouches: string[];
  fileAnchors: ReadonlyMap<string, string>;
  comments: DiffComment[];
  pastComments?: DiffComment[];
  reviewerFindings: DiffComment[];
  /** The build's one automatic review, when its project had review on. */
  automaticReview?: BuildReviewView | null;
  /** Revisions already sealed from this run — the forward link. Each
   * carries the shared status projection's own words for the child
   * (repair 2026-09-14): CURRENT exact approval and actual activity, so
   * held or paused work is never called building because it was once
   * approved, and a rescoped child reads as needing approval again. */
  revisions: { id: string; title: string; state: TaskState; approved: boolean; standing: string; tone: string }[];
  /** The source scope digest the panel was rendered against (null = no
   * scope) — the revision form's source binding. */
  sourceDigest: string | null;
  route: RouteStamp | null;
  editor: { worktree: string } | null;
  /** Signed criteria on the scope this run built against. */
  signedCriteria: number;
  /** Whether a reviewer can annotate here (sealed non-empty patch verifies, cookie session). */
  canAnnotate: boolean;
  /** Follow-ups on this result (result-follow-ups.ts): checks run since, the tests task, and what can run. */
  followUps?: { repo: string | null; checks: FollowUpCheck[]; testsTask: string | null; quick: boolean; full: boolean } | null;
};

export type ResultPanelOptions = {
  place: "run" | "review" | "chat";
  tab: ResultTab;
  csrf: string;
  /** The server-named account, for the browser's bounded draft keys. */
  user: string;
  /** The page carries a receipt for a just-posted note: focus the box. */
  noted: boolean;
  /** This render's request token for the note form (replay dedupe). */
  requestToken: string;
  hrefFor: (tab: ResultTab) => string;
  /** Where the forms send the reader back (validated server-side too). */
  returnTo: string;
  back: { href: string; label: string } | null;
  /** Surface-specific acts that belong under Checks (the cockpit's review
   * retry panel and its accept-with-exception form). */
  extraChecks?: string;
  /** The cockpit's header already carries the status chip: said once. */
  headStatus?: boolean;
  /** The cockpit renders its own next-action card: no panel action. */
  action?: boolean;
  /** Accept and finish sits beside the panel: it records the person's own checks too, so the panel offers no separate Accept. */
  finishes?: boolean;
};

/** The revision form's binding (repair 2026-09-14): the exact ids of the
 * notes this page displays and the source terms it was rendered against.
 * The server seals these ids and no others. */
export function revisionSealFields(comments: readonly { id: number }[], sourceDigest: string | null): string {
  return `<input type="hidden" name="batch" value="${escape(revisionBatchOf(comments))}"><input type="hidden" name="source" value="${escape(revisionSourceOf(sourceDigest))}">`;
}

/** Older machine-checked results saved a mechanical sentence; say the same
 * facts in plain words (the version id stays, shortened). */
export function plainConclusionOf(conclusion: string): string {
  const prepared = /^Prepared candidate ([0-9a-f]{7,40}) was checked out by the machine; no agent ran\. (The branch already matched it\.|The sealed diff spans this task's base to that candidate\.)/.exec(conclusion);
  if (prepared === null) return conclusion;
  const rest = conclusion.slice(prepared[0].length).trim();
  return `Checked the prepared version ${prepared[1]!.slice(0, 7)}; no agent ran. ${prepared[2]!.startsWith("The branch") ? "The branch already matched it." : "The changes cover everything since the task started."}${rest === "" ? "" : ` ${rest}`}`;
}

export function resultPanelHtml(detail: ResultDetail, o: ResultPanelOptions): string {
  return resultPanelParts(detail, o).html;
}

/** The panel's HTML and the same panel in parts, for the rebuilt result page. */
export function resultPanelParts(detail: ResultDetail, o: ResultPanelOptions): { html: string; panel: BrowserResultPanel } {
  const { run, receipt, proof, terminal, handoff } = detail;
  const facts = receipt.facts;
  const current = detail.assignment?.receipt?.runId === run.id ? detail.assignment : null;
  const followUps = detail.followUps ?? null;
  const resultLinks = { result: o.hrefFor("summary"), checks: o.hrefFor("checks"), pullRequest: `${taskHref(detail.rootId ?? detail.taskId)}#merge`,
    ...(followUps !== null && (followUps.quick || followUps.full) && o.csrf !== "" ? { runChecks: `${o.hrefFor("checks")}#follow-ups` } : {}) };
  const presentation = current == null ? null : assignmentPresentationOf(current, { additionalAttention: [...facts.evidenceProblems, ...receipt.caveats],
    ...(detail.publication === null ? {} : { pullRequest: pullRequestFactOf({ ...detail.publication, lastCheckState: detail.ciFailing ? "failing" : detail.publication.lastCheckState }) }),
    evidence: { damaged: facts.evidenceHealth.damaged, missing: facts.evidenceHealth.missing, shortened: facts.evidenceHealth.shortened }, links: resultLinks });
  const taskStatus = presentation?.taskStatus ?? null;
  const status = presentation?.status ?? resultHeadlineOf(receiptStatusOf(receipt));
  const stored = receiptStatusOf(receipt, null);
  const humanReview = manualReviewOnly(proof === null ? null : { ...proof, verdict: proof.verdict ?? "" });
  // Needs you: the action that resolves it comes first; Request changes stays beside it, never alone.
  // On the result itself, "Review result" would link here: accepting it is what resolves it.
  const need = needActionOf(current, taskStatus, o.csrf, o.returnTo, {
    accepted: proof?.accepted != null, humanReview, run: run.id, action: `${taskHref(detail.taskId)}/accept-proof`, refuted: proof?.verdict === "refuted",
    // What Store.finalResultReason refuses: a verified, attested, accepted or published result.
    rebuildable: proof?.accepted == null && proof?.verdict !== "verified" && proof?.verdict !== "attested" && !(detail.publication !== null && ["pushed", "opened"].includes(detail.publication.state)) });
  const directAssessment = proof?.matrix.some(row => row.assessment !== undefined) === true;
  const awaitingGoalReview = directAssessment && proof?.reasons.length === 1 && proof.reasons[0] === GOAL_ASSESSMENT_PENDING;
  const assessmentReasons = directAssessment ? new Set(proof!.matrix.flatMap(row => row.review ? [`${row.review.author} ${row.review.judgement === "contradicts" ? "contradicts" : "needs more evidence for"} criterion "${row.id}": ${row.review.note}`] : [])) : new Set<string>();
  const physicalReasons = receipt.reasons.filter(reason => !assessmentReasons.has(reason));
  const runId = run.id;
  const shots = proof?.screenshots ?? [];
  const shown = shots.filter(one => one.problem === null);
  const stat = terminal?.stat ?? null;
  const statOk = stat !== null && !("problem" in stat);
  const patch = terminal?.patch ?? null;
  const patchOk = patch !== null && !("problem" in patch);
  const lead = resultLeadOf({ role: run.role, report: receipt.report !== null, screenshots: shown.length, diff: (patchOk && patch.text.trim() !== "") || (statOk && stat.fileCount > 0) });
  const tabHref = (tab: ResultTab): string => escape(o.hrefFor(tab));

  // ---- attention: problems and caveats, ahead of every readiness word ----
  const publication = detail.publication;
  const prUrl = publication === null ? null : safePrUrl(publication.prUrl);
  const attention: string[] = [];
  // The visible status already says verification is needed. Only omit the
  // generic repeat; failed checks, specific reasons and damaged evidence stay.
  const missingVerdictNamed = o.headStatus !== false && status.token === "verification-needed" && receipt.verdict === null && receipt.reasons.length === 0;
  if (current == null && !humanReview && !awaitingGoalReview && (!directAssessment || physicalReasons.length > 0) && !missingVerdictNamed && stored.token !== "evidence-damaged" && (stored.tone === "problem" || stored.tone === "attention")) attention.push(verificationExplanation(receipt.verdict, physicalReasons));
  // Exact criterion assessment notes are already shown in Requirements;
  // do not repeat them as a second current attention message.
  if (presentation !== null) attention.push(...presentation.attention.map(one => one.detail).filter(detail => !assessmentReasons.has(detail)));
  if (current == null) attention.push(...facts.evidenceProblems);
  if (detail.outsideTouches.length > 0) attention.push(`${detail.outsideTouches.length} changed file${detail.outsideTouches.length === 1 ? "" : "s"} outside the approved paths: ${detail.outsideTouches.join(", ")}.`);
  // A failed caveat can already be quoted in full by its verification
  // reason. Keep that explanation once and retain every other caveat.
  if (current == null) attention.push(...receipt.caveats.filter(caveat => !historicalAssessmentReason(caveat) && !attention.some(problem => problem.includes(caveat))));
  attention.push(...(handoff?.followUps ?? []).map(one => `Follow-up: ${one}`));
  // The automatic review: a HIGH that did not send the work back, or a review
  // that could not finish, is the person's to see. (Said once when the
  // current assignment already carries it.)
  const automatic = detail.automaticReview ?? null;
  if (automatic !== null && automatic.sentBackAs === null) {
    const reviewed = [...(automatic.state === "not-reviewed" ? [`Not reviewed: ${automatic.reason ?? "the automatic review did not finish"}.`] : []), ...automatic.high.map(one => `Review: ${findingWords(one)}`)];
    for (const line of reviewed) if (!attention.includes(line)) attention.push(line);
  }
  // Publication risks stay in the open (repair 2026-09-14); the routine
  // publication fact lives with the build details below.
  // With the shared status, the pull request is its own quiet row (its reason under Details).
  if (publication !== null && publication.state === "failed" && taskStatus === null) {
    attention.push(`Publication failed after ${publication.attempts} attempt${publication.attempts === 1 ? "" : "s"}${publication.lastError === null ? "" : ` — ${oneLineOf(publication.lastError, 200)}`}. No pull request or merge is recorded.`);
  }
  if (detail.ciFailing && publication !== null && taskStatus === null) attention.push(`CI is failing on PR #${publication.prNumber} at the last check.`);
  // Requirements only a person can confirm: plain words and one Accept,
  // in neutral ink — nothing failed. Accepting records the person's
  // decision and leaves the recorded checks as they are.
  const personChecks = proof === null || proof.accepted !== null ? [] : [
    ...proof.matrix.filter(row => row.state === "manual-review").map(row => personCheckWords(row.statement)),
    ...(proof.matrix.length > 0 ? [] : proof.reasons.filter(reason => manualReviewCriterionOf(reason) !== null).map(() => personCheckWords(null))),
  ];
  const acceptable = personChecks.length > 0 && humanReview && o.csrf !== "" && (current != null || detail.assignment == null);
  const youCheck: BrowserResultPanel["youCheck"] = personChecks.length === 0 ? null : {
    lines: [...new Set(personChecks)],
    items: personCheckItems(proof!, patchOk ? patch.text : null, shown, runId),
    accept: acceptable && need?.accept == null ? { action: `${taskHref(detail.taskId)}/accept-proof`, run: run.id, returnTo: o.returnTo } : null,
  };
  const youCheckForm = youCheck?.accept != null && o.finishes !== true ? youCheck.accept : null;
  const youCheckHtml = youCheck === null ? "" :
    `<div class="result-you-check" data-result-you-check="${youCheck.lines.length}"><ul>${youCheck.lines.map(one => `<li>${escape(one)}</li>`).join("")}</ul>` +
    (youCheckForm === null ? "" : `<form method="post" action="${escape(youCheckForm.action)}"><input type="hidden" name="csrf" value="${escape(o.csrf)}"><input type="hidden" name="run" value="${youCheckForm.run}"><input type="hidden" name="return" value="${escape(youCheckForm.returnTo)}"><button type="submit" data-accept-result>Accept</button></form>`) +
    `</div>`;
  const attentionHtml =
    attention.length === 0
      ? ""
      : `<div class="result-attention" data-result-attention="${attention.length}"><ul>${attention.map(one => `<li>${escape(plainReasonWords(one))}</li>`).join("")}</ul></div>`;

  // ---- one outcome, one action (repair 2026-09-14) ------------------------
  // The outcome is the handoff's first sentence, bounded; the agent's full
  // account waits behind a disclosure in Summary so nothing is said twice.
  const conclusion = plainConclusionOf(receipt.summary ?? (run.outcome === "no-change" ? "The agent found that no repository change was needed." : "The build finished without a concise handoff."));
  const outcome = conciseOutcomeOf(conclusion);
  // A failing pull request keeps its repair draft beside the need's action.
  const action = o.action === false ? "" : need !== null ? resultNeedAction(need, o, detail.canAnnotate) + (detail.ciFailing && o.csrf !== "" ? resultPrimaryAction(detail, o, prUrl) : "") : resultPrimaryAction(detail, o, prUrl);

  // ---- summary: the deliverable first ----------------------------------
  const summaryParts: string[] = [];
  const report = receipt.report;
  if (lead === "report") {
    if (report === null) {
      summaryParts.push(`<p class="problem" data-result-report="missing">This investigation stored no report.</p>`);
    } else if (!report.ok) {
      summaryParts.push(`<p class="problem" data-result-report="problem">The report cannot be shown: ${escape(report.problem)}.</p>`);
    } else {
      // Escaped text in a fenced block, never markup, never a page: the
      // download serves the exact stored bytes as text. The summary is
      // already the outcome line above (and, when shortened there, waits
      // in "What the agent reported"), so the article never repeats it.
      summaryParts.push(
        `<article class="result-report" data-result-report="ok"><h3>${escape(report.title)}</h3>` +
          reportItemsHtml(report.items, report.shots, runId) +
          `<pre class="recap plan-doc">${escape(report.document)}</pre>` +
          `<p class="meta"><a href="/r/${runId}/evidence/${report.artifactId}">${report.truncated ? "Download the stored part of the report (shortened at storage — not the full report)" : "Download the report"}</a>${report.followUps === 0 ? "" : ` · ${report.followUps} proposed follow-up${report.followUps === 1 ? "" : "s"} on <a href="${taskHref(detail.rootId ?? detail.taskId)}">the task</a>`}</p></article>`,
      );
    }
  } else if (lead === "screenshots") {
    summaryParts.push(
      `<div class="receipt-visuals result-visuals" aria-label="validated screenshots">${shown
        .map(shot => `<a class="receipt-shot" href="/r/${runId}/evidence/${shot.artifactId}"><img src="/r/${runId}/evidence/${shot.artifactId}" alt="${escape(shot.caption)}"><span>${escape(shot.caption)}</span></a>`)
        .join("")}</div>`,
    );
  }
  const unavailableShots = shots.filter(one => one.problem !== null);
  if (lead === "changes") {
    // Code work: the changed files ARE the deliverable; the diff is one tap away.
    summaryParts.push(
      `<p class="result-files-lead">${detail.files.length === 0 ? "" : `<span class="mono">${detail.files.slice(0, 6).map(one => escape(one.path)).join("</span>, <span class=\"mono\">")}</span>${detail.files.length > 6 ? ` and ${detail.files.length - 6} more` : ""} — `}<a href="${tabHref("changes")}" data-result-goto="changes">see the diff</a></p>`,
    );
  }
  if (lead === "summary" && run.outcome === "no-change") summaryParts.push(`<p class="meta">The agent found that no repository change was needed${statOk && stat.fileCount === 0 ? "; the sealed diff is empty" : ""}.</p>`);
  // The agent's own account — its full conclusion (when the outcome line
  // shortened it), what it says it changed, and how it checked — on demand.
  const agentAccount = [
    ...(conclusion !== outcome ? [`<p class="recap">${escape(conclusion)}</p>`] : []),
    ...(handoff !== null && handoff.changes.length > 0 ? [`<ul class="result-changes">${handoff.changes.map(one => `<li>${escape(one)}</li>`).join("")}</ul>`] : []),
    ...(handoff !== null && handoff.verification.length > 0 ? [`<p class="meta">Checked by the agent:</p><ul class="result-changes" data-cockpit-source="agent-words">${handoff.verification.map(one => `<li>${escape(one)}</li>`).join("")}</ul>`] : []),
    // The report's own notes, each a link target (#report-note-<n>) a mismatch can point at.
    ...(proof?.proof == null || proof.proof.caveats.length === 0 ? [] : [`<p class="meta">Its notes:</p><ol class="result-changes" data-report-notes>${proof.proof.caveats.map((one, index) => `<li id="report-note-${index + 1}">${escape(one)}</li>`).join("")}</ol>`]),
  ];
  if (agentAccount.length > 0) summaryParts.push(`<details class="result-notes" data-result-notes-agent><summary>What the agent reported</summary>${agentAccount.join("")}</details>`);
  // MEDIUM and LOW never block: suggested follow-ups, on request.
  if (automatic !== null && automatic.followUps.length > 0) {
    summaryParts.push(`<details class="result-notes" data-review-followups="${automatic.followUps.length}"><summary>Suggested follow-ups · ${automatic.followUps.length}</summary><ul class="result-changes">${
      automatic.followUps.map(one => `<li><span class="badge">${one.severity === "MEDIUM" ? "Medium" : "Low"}</span> <span class="mono">${escape(`${one.file}:${one.line}`)}</span> ${escape(one.scenario)}</li>`).join("")
    }</ul></details>`);
  }
  const evidenceSources = [
    ...(report !== null ? [report.ok ? `verified report${report.truncated ? " (shortened)" : ""}` : "report (unverifiable)"] : []),
    ...(patch !== null ? [patchOk ? `sealed diff${patch.truncated ? " (shortened)" : ""}` : "diff (unverifiable)"] : []),
    ...(proof === null ? [] : proof.proofProblem !== null ? ["proof (unreadable)"] : proof.proof !== null ? ["agent proof"] : []),
    ...(proof?.checkLog !== null && proof?.checkLog !== undefined ? [proof.checkLog.problem !== null ? "check log (unverifiable)" : `check log${proof.checkLog.truncated ? " (shortened)" : ""}`] : []),
    ...(shots.length > 0 ? [`${shown.length} validated screenshot${shown.length === 1 ? "" : "s"}${unavailableShots.length > 0 ? `, ${unavailableShots.length} unavailable` : ""}`] : []),
  ];
  const publicationHtml =
    `<p class="result-publication" data-receipt-publication="${escape(facts.publicationState)}">${escape(facts.publicationWords)}` +
    (publication === null || publication.prNumber === null
      ? ""
      : ` ${prUrl === null ? `<span class="mono">PR #${publication.prNumber}</span>` : `<a href="${escape(prUrl)}">PR #${publication.prNumber}</a>`}` +
        `<span class="meta" data-ci-observed="${escape(detail.ciFailing ? "failing" : (publication.lastCheckState ?? "none"))}"> · ${
          detail.ciFailing ? "CI failing at the last check" : publication.lastCheckState === "passing" ? `CI passing, observed ${whenTime(publication.lastCheckAt)}` : publication.lastCheckState === "running" ? "CI still running at the last check" : "no CI checks found — verify on GitHub"
        }</span>`) +
    `</p>`;
  const agent = runAgentWords(detail.route);
  const links: string[] = [];
  if (o.place !== "run") links.push(`<a href="/r/${runId}">Full build record →</a>`);
  if (o.place !== "review") links.push(`<a href="${reviewHref(detail.taskId)}">Open result →</a>`);
  if (o.place !== "chat") links.push(`<a href="${taskChatHref(detail.rootId ?? detail.taskId)}">Discuss in chat →</a>`);
  links.push(`<a href="${taskHref(detail.rootId ?? detail.taskId)}">Task overview →</a>`);
  // Technical facts on demand: build, agent, exact commits, evidence
  // sources, the publication record, and the other pages for this result.
  summaryParts.push(
    `<details class="result-details" data-result-details><summary>Build details</summary>` +
      (unavailableShots.length === 0 ? "" : `<ul class="result-unavailable meta" data-result-unavailable="${unavailableShots.length}">${unavailableShots.map(one => `<li>Screenshot unavailable — <span class="mono">${escape(one.path)}</span>: ${escape(one.problem ?? "")}</li>`).join("")}</ul>`) +
      `<dl class="result-facts">` +
      `<div><dt>Build</dt><dd>#${runId} · ${escape(run.runner)}${agent === null ? ` · ${escape(run.provider)}` : ""}${run.finishedAt === null ? "" : ` · ${whenTime(run.finishedAt)}`}</dd></div>` +
      (agent === null ? "" : `<div><dt>Agent</dt><dd>${escape(agent)}</dd></div>`) +
      `<div><dt>Commits</dt><dd>${
        facts.head === null
          ? facts.base === null ? "no commit recorded" : `<span class="mono">${escape(facts.base.slice(0, 12))}</span> <span class="meta">base · no head recorded</span>`
          : `<span class="mono">${facts.base === null ? "" : `${escape(facts.base.slice(0, 12))} → `}${escape(facts.head.slice(0, 12))}</span> <span class="meta">from the ${escape(facts.headSource ?? "record")}</span>`
      }</dd></div>` +
      `<div><dt>Evidence</dt><dd>${evidenceSources.length === 0 ? "nothing was captured" : escape(evidenceSources.join(" · "))}</dd></div>` +
      `<div><dt>Publication</dt><dd>${publicationHtml}</dd></div>` +
      `</dl>` +
      `<p class="result-links meta">${links.join("")}</p>` +
      `</details>`,
  );

  // ---- changes -----------------------------------------------------------
  const changeParts: string[] = [];
  if (terminal === null) {
    changeParts.push(`<p class="meta">No final diff or change summary was captured for this build${run.role === "scout" ? " — an investigation changes nothing in the repository" : ""}.</p>`);
  } else {
    if (stat === null) changeParts.push(`<p class="meta">No change summary was captured.</p>`);
    else if (!statOk) changeParts.push(`<p class="problem">Change summary unavailable: ${escape(stat.problem)}.</p>`);
    else {
      changeParts.push(
        `<p class="row result-stat"><span class="mono">${escape(stat.base.slice(0, 12))} → ${escape(stat.head.slice(0, 12))}</span> — ` +
          (stat.fileCount === 0
            ? "no changes, verified"
            : `${stat.fileCount} file${stat.fileCount === 1 ? "" : "s"} · +${stat.additions} −${stat.deletions}${stat.binaryCount > 0 ? ` · ${stat.binaryCount} binary` : ""}${stat.filesTruncated ? " · file list cut, counts complete" : ""}`) +
          `</p>`,
      );
    }
    if (detail.outsideTouches.length > 0) {
      changeParts.push(`<p class="problem cockpit-drift" data-cockpit-drift="${detail.outsideTouches.length}"><strong>${detail.outsideTouches.length} changed file${detail.outsideTouches.length === 1 ? "" : "s"} outside the approved paths</strong> — ${detail.outsideTouches.map(path => `<span class="mono">${escape(path)}</span>`).join(", ")}. Review these files before accepting the result.</p>`);
    }
    if (detail.files.length > 0) {
      const fileName = (file: ReviewFileRow): string => {
        const href = detail.editor === null ? null : editorFileHref(detail.editor.worktree, file.path);
        if (href !== null) return `<a class="mono" href="${escape(href)}">${escape(file.path)}</a>`;
        return file.anchor === null ? `<span class="mono">${escape(file.path)}</span>` : `<a class="mono" href="#${file.anchor}">${escape(file.path)}</a>`;
      };
      changeParts.push(
        `<ol class="cockpit-files result-files">` +
          detail.files
            .map(file => {
              const counts = file.additions === null || file.deletions === null ? "binary" : `+${file.additions} −${file.deletions}`;
              const flags = (file.outsideTouches ? ` <span class="badge badge-failed" data-outside-touches="1">Outside touches</span>` : "") + (file.cited ? ` <span class="badge badge-done">Cited</span>` : "");
              const why = file.priority.reasons.length === 0 ? "" : ` <span class="meta">— ${file.priority.reasons.map(escape).join("; ")}</span>`;
              return `<li data-file-priority="${file.priority.band}">${fileName(file)}${file.renamedFrom === null ? "" : ` <span class="meta">(was ${escape(file.renamedFrom)})</span>`} <span class="meta">${counts}</span>${flags}${detail.canAnnotate ? ` <button type="button" class="pick-file" data-path="${escape(file.path)}">Comment</button>` : ""}${why}</li>`;
            })
            .join("") +
          `</ol>` +
          (detail.editor === null ? "" : `<p class="meta">File links open in VS Code on THIS device — if the build's worktree is gone, a link opens nothing.</p>`),
      );
    }
    if (patch === null) changeParts.push(`<p class="meta">The final diff was not captured for this build.</p>`);
    else if (!patchOk) changeParts.push(`<p class="problem">Diff unavailable: ${escape(patch.problem)}.</p>`);
    else if (patch.text.trim() === "") changeParts.push(`<p class="meta">Empty diff — captured successfully, nothing changed.</p>`);
    else changeParts.push(reviewDiffHtml(patch, stat, runId, detail.canAnnotate, detail.fileAnchors));
  }

  // ---- checks --------------------------------------------------------------
  const checkParts: string[] = [];
  const reviewerNotes = detail.reviewerFindings.map(one => `<li><span class="badge${one.severity === "problem" ? " badge-failed" : ""}">${escape(one.severity ?? "note")}</span> ${one.path === null ? "" : `<span class="mono">${escape(one.path)}${one.line === null ? "" : `:${one.line}`}</span> `}${escape(one.note)} <span class="meta">— ${escape(one.author)}</span>${!isRevisionFeedback(one) && detail.canAnnotate && o.csrf !== "" ? ` <button type="button" class="pick-file" data-path="${escape(one.path ?? "")}" data-line="${one.line ?? ""}" data-review-note="${escape(one.note)}">Request change</button>` : ""}</li>`).join("");
  if (proof === null && reviewerNotes !== "") checkParts.push(`<div class="result-section" data-cockpit-source="reviewer"><strong>Previous assessment</strong><ul>${reviewerNotes}</ul></div>`);
  if (run.outcome === "no-change" && !directAssessment) checkParts.push(`<p class="meta">The build concluded that no repository change was needed. A no-change conclusion owes no proof — its handoff and machine-captured diff are the record.</p>`);
  if (proof === null) {
    if (run.outcome !== "no-change") checkParts.push(`<p class="meta" data-proof-verdict="none">This build has no verification result or captured evidence. Review its recorded changes yourself.</p>`);
  } else {
    if (proof.verdict !== null && !directAssessment) {
      // The same status line the panel leads with (one status per surface,
      // workspace package 1), beside the machine verdict's own explanation.
      checkParts.push(`<p class="row result-verdict" data-proof-verdict="${escape(dispatchStatusToken(proof.verdict))}"><span class="meta">At completion: ${escape(humanReview ? "Human review required for the requirements below." : verificationExplanation(proof.verdict, proof.reasons))}</span></p>`);
    } else if (proof.verdict === null && run.outcome !== "no-change") {
      checkParts.push(`<p class="meta" data-proof-verdict="none">No verification result is available for this build.</p>`);
    }
    if (proof.accepted !== null) checkParts.push(`<p class="meta">${humanReview ? "Accepted after human review" : "Accepted with an exception"} by <span class="mono">${escape(proof.accepted.by)}</span> · ${whenTime(proof.accepted.at)}${proof.accepted.note === null ? "" : ` — ${escape(proof.accepted.note)}`}</p>`);
    if (proof.matrix.length === 0) {
      checkParts.push(detail.signedCriteria > 0 ? `<p class="meta">The approved scope has ${detail.signedCriteria} requirement${detail.signedCriteria === 1 ? "" : "s"}, but this build has no requirement-by-requirement verification.</p>` : `<p class="meta">This scope signed no acceptance checks.</p>`);
    } else {
      checkParts.push(criterionMatrixHtml(proof.matrix, { runId, links: proof.matrixLinks, fileAnchors: detail.fileAnchors, verdict: proof.verdict }));
    }
    checkParts.push(semanticCoverageHtml(proof.matrix, proof.qualityMode));
    if (reviewConflict(proof.matrix, proof.machineVerdict, proof.verdict)) checkParts.push(`<p class="meta">An independent review found conflicting evidence.</p>`);
    checkParts.push(repairChainHtml(proof.repairChain));
    if (detail.reviewerFindings.length > 0) {
      checkParts.push(
        `<div class="result-section" data-cockpit-source="reviewer"><strong>Independent review</strong><ul>` +
          reviewerNotes +
          `</ul></div>`,
      );
    }
    if (proof.proofProblem !== null) checkParts.push(`<p class="problem">Verification details are unavailable: ${escape(proof.proofProblem)}</p>`);
    checkParts.push(proof.checkLog === null ? `<p class="meta" data-cockpit-source="machine">${current?.receipt?.checks.level === "off" ? "Checks were off for this build." : "No automated check was configured for this build."}</p>` : checkLogHtml(proof.checkLog, runId, ' data-cockpit-source="machine"'));
    checkParts.push(
      proof.proof === null || proof.proof.checks.length === 0
        ? directAssessment ? "" : `<p class="meta" data-cockpit-source="agent">The agent reported no checks.</p>`
        : `<details class="cockpit-proof-group" data-cockpit-source="agent"><summary>Agent checks · ${proof.proof.checks.length}</summary><div class="result-section"><ul>` +
          proof.proof.checks.map(one => `<li><span class="mono">${escape(one.command)}</span> <span class="meta">(exit ${one.exitCode}) — ${escape(one.summary)}</span></li>`).join("") +
          `</ul></div></details>`,
    );
    const screenshotRequired = proof.matrix.some(one => one.requiredEvidence.includes("screenshot"));
    checkParts.push(
      shots.length === 0
        ? directAssessment && !screenshotRequired ? "" : `<p class="meta" data-cockpit-source="screenshots">No screenshots${screenshotRequired ? " were captured, although one was required" : " were needed"}.</p>`
        : lead === "screenshots"
          ? `<p class="meta" data-cockpit-source="screenshots">${shown.length} validated screenshot${shown.length === 1 ? "" : "s"} shown in Summary${unavailableShots.length > 0 ? `; ${unavailableShots.length} unavailable` : ""}.</p>`
          : `<details class="cockpit-proof-group" data-cockpit-source="screenshots"><summary>Screenshots · ${shown.length}${unavailableShots.length > 0 ? ` (${unavailableShots.length} unavailable)` : ""}</summary><div class="receipt-visuals" aria-label="validated screenshots">` +
            shown.map(shot => `<a class="receipt-shot" href="/r/${runId}/evidence/${shot.artifactId}"><img src="/r/${runId}/evidence/${shot.artifactId}" alt="${escape(shot.caption)}"><span>${escape(shot.caption)}</span></a>`).join("") +
            `</div></details>`,
    );
    checkParts.push(
      receipt.caveats.length === 0
        ? directAssessment ? "" : `<p class="meta" data-cockpit-source="caveats">No caveats were reported.</p>`
        : `<details class="cockpit-proof-group" data-cockpit-source="caveats"><summary>Agent caveats · ${receipt.caveats.length}</summary><ul>${receipt.caveats.map(one => `<li>${escape(one)}</li>`).join("")}</ul></details>`,
    );
  }
  if (followUps !== null && run.role === "builder") checkParts.push(followUpsHtml(followUps, runId, o));
  // The handoff's own account of its checks — the agent's words, labeled
  // as such, whether or not a proof exists.
  if (!directAssessment && handoff !== null && handoff.verification.length > 0) checkParts.push(`<div class="result-section" data-cockpit-source="agent-words"><strong>The agent's own account</strong><ul>${handoff.verification.map(one => `<li>${escape(one)}</li>`).join("")}</ul></div>`);
  if (o.extraChecks !== undefined) checkParts.push(o.extraChecks);

  // ---- request changes: both feedback styles, one sealed road ------------
  const requestParts: string[] = [`<h3 class="so-sr-only">What should change?</h3>`];
  const pathWords = (path: string, line: number | null): string => {
    const shownPath = `${path}${line === null ? "" : `:${line}`}`;
    const href = detail.editor === null ? null : editorFileHref(detail.editor.worktree, path, line);
    return href === null ? `<span class="mono">${escape(shownPath)}</span> ` : `<a class="mono" href="${escape(href)}">${escape(shownPath)}</a> `;
  };
  if (detail.comments.length > 0) {
    requestParts.push(
      `<p class="meta">Saved for later · ${detail.comments.length}</p><div class="diff-comments" data-result-notes="${detail.comments.length}">` +
        detail.comments.map(one => `<div class="diff-comment"><span class="diff-comment-pin" aria-hidden="true"></span><p>${one.path === null ? "" : pathWords(one.path, one.line)}${escape(one.note)}</p><span class="meta">${escape(one.author)} · ${whenTime(one.createdAt)}</span></div>`).join("") +
        `</div>`,
    );
    if (o.csrf !== "" && !detail.canAnnotate) {
      requestParts.push(
        `<form method="post" action="/r/${runId}/revise" class="card revision-from-comments"><input type="hidden" name="csrf" value="${escape(o.csrf)}"><input type="hidden" name="return" value="${escape(o.returnTo)}">${revisionSealFields(detail.comments, detail.sourceDigest)}` +
          `<div><strong>${detail.comments.length} note${detail.comments.length === 1 ? "" : "s"} ready</strong></div>` +
          `<button type="submit">Request changes</button></form>`,
      );
    }
  }
  if ((detail.pastComments?.length ?? 0) > 0) {
    requestParts.push(`<details class="result-feedback-history"><summary>Earlier feedback</summary><div class="diff-comments" data-past-feedback>${detail.pastComments!.map(one => `<div class="diff-comment"><p>${one.path === null ? "" : pathWords(one.path, one.line)}${escape(one.note)}</p><span class="meta">${escape(one.author)} · ${whenTime(one.createdAt)}</span></div>`).join("")}</div></details>`);
  }
  for (const revision of detail.revisions) {
    // The child's standing is the shared status projection's own words
    // (repair 2026-09-14): current exact approval and actual activity.
    requestParts.push(`<p class="result-revision" data-result-revision="${escape(revision.id)}" data-result-revision-approved="${revision.approved ? "1" : "0"}" data-tone="${escape(revision.tone)}"><strong>Revision</strong> <a href="${taskHref(revision.id)}">${escape(revision.title)}</a> <span class="meta">· ${escape(revision.standing)}</span></p>`);
  }
  if (o.csrf === "") {
    requestParts.push(`<p class="meta">Sign in with a browser session to request changes.</p>`);
  } else if (!detail.canAnnotate) {
    requestParts.push(`<p class="meta" data-result-feedback="unavailable">${terminal === null ? "This result has no sealed diff to attach notes to." : "The sealed diff no longer verifies, so notes cannot attach to it."} <a href="${taskChatHref(detail.rootId ?? detail.taskId)}">Discuss in chat →</a></p>`);
  } else {
    requestParts.push(
      `<details class="result-request-open result-request-form"${detail.comments.length > 0 ? " open" : ""}><summary>What should change?</summary>` +
      `<form method="post" action="/r/${runId}/comment" class="diff-comment-form" id="comment-form">` +
        `<input type="hidden" name="csrf" value="${escape(o.csrf)}">` +
        `<input type="hidden" name="tab" value="${o.tab}">` +
        `<input type="hidden" name="return" value="${escape(o.returnTo)}">` +
        `<input type="hidden" name="request" value="${escape(o.requestToken)}">${revisionSealFields(detail.comments, detail.sourceDigest)}` +
        `<input type="hidden" data-recorded-requests value="${escape([...detail.comments, ...(detail.pastComments ?? [])].filter(one => one.sourceKey?.startsWith(`review:${o.user}:`)).map(one => one.sourceKey!.slice(`review:${o.user}:`.length)).join(","))}">` +
        `<textarea name="note" rows="2" maxlength="${LIMITS.note}" placeholder="Describe the change…" aria-label="review comment" aria-describedby="comment-note-limit"${o.noted ? " autofocus" : ""}></textarea>` +
        `<span class="meta diff-comment-limit" id="comment-note-limit">up to ${LIMITS.note} characters</span>` +
        `<details class="result-pin"><summary>Attach to a file or line</summary>` +
        `<div class="diff-comment-target"><label>File<input type="text" name="path" placeholder="src/…" aria-label="file" class="mono"></label>` +
        `<label>Line<input type="text" name="line" placeholder="—" aria-label="line" inputmode="numeric"></label></div></details>` +
        `<div class="result-feedback-actions"><button type="submit" name="intent" value="revise" data-request-changes>Request changes</button><button type="submit" name="intent" value="note" class="quiet" data-save-feedback>Save for later</button></div></form></details>`,
    );
  }

  // ---- the panel ---------------------------------------------------------
  const tabCounts: Record<ResultTab, string> = {
    summary: "",
    changes: statOk ? (stat.fileCount === 0 ? "none" : `${stat.fileCount} file${stat.fileCount === 1 ? "" : "s"}`) : terminal === null ? "none" : "",
    checks: "",
  };
  const tabs =
    `<nav class="result-tabs" role="tablist" aria-label="result views">` +
    RESULT_TABS.map(tab => `<a role="tab" href="${tabHref(tab.key)}" data-result-tab="${tab.key}" aria-selected="${tab.key === o.tab ? "true" : "false"}"${tab.key === o.tab ? "" : ' tabindex="-1"'}>${tab.key === "checks" && proof?.matrix.some(row => row.assessment !== undefined) ? "Requirements" : tab.label}${tabCounts[tab.key] === "" ? "" : `<span class="count">${escape(tabCounts[tab.key])}</span>`}</a>`).join("") +
    `</nav>`;
  const view = (tab: ResultTab, parts: string[]): string =>
    `<div class="result-view" role="tabpanel" data-result-view="${tab}"${tab === o.tab ? "" : " hidden"}>${parts.join("\n")}</div>`;
  const heading = receiptHeadingOf(run.outcome, receipt.publication, run.role);
  const html = (
    `<section class="card result-panel" id="result" data-result-panel data-result-place="${o.place}" data-result-lead="${lead}" data-result-task="${escape(detail.rootId ?? detail.taskId)}" data-result-user="${escape(o.user)}"${resultFactsAttributes(facts)}>` +
      (o.back === null ? "" : `<p class="result-back"><a href="${escape(o.back.href)}" data-result-back>← ${escape(o.back.label)}</a></p>`) +
      (detail.history ?? "") +
      // One headline: with the shared status, its words lead (task-status.ts); "Changes saved" would compete with them.
      (taskStatus !== null && o.headStatus !== false
        ? `<header class="result-head"><div data-headline-tone="${taskStatus.tone}"><h2 class="status-headline" data-work-status="${escape(status.token)}"><i aria-hidden="true"></i>${escape(taskStatus.headline)}</h2><p class="status-sentence">${escape(taskStatus.sentence)}</p></div></header>`
        : `<header class="result-head"><div><h2>${escape(heading)}</h2></div>${o.headStatus === false ? "" : statusLineHtml(status)}</header>`) +
      `<p class="result-summary">${escape(outcome)}</p>` +
      (current == null || o.place === "review" && (current.state === "ready-to-check" || current.state === "complete") ? "" :
        `<div class="verdict" data-current-outcome data-headline="${escape(taskStatus!.headline)}">${statusDetailsHtml(taskStatus!)}${statusWhyHtml(taskStatus!)}</div>`) +
      attentionHtml +
      youCheckHtml +
      action +
      (REVIEW_TOKENS.has(status.token) ? `<details class="receipt-history"><summary>Review history</summary><p class="receipt-review meta" data-receipt-review="${escape(status.token)}">${escape(status.detail)}</p></details>` : "") +
      tabs +
      view("summary", summaryParts) +
      view("changes", changeParts) +
      view("checks", checkParts) +
      (detail.learning ?? "") +
      (detail.skillTest ? "" : `<section class="result-request" id="request-changes">${requestParts.join("\n")}</section>`) +
    `</section>`
  );
  const panel: BrowserResultPanel = {
    attributes: { "data-result-panel": "", "data-result-place": o.place, "data-result-lead": lead, "data-result-task": detail.rootId ?? detail.taskId, "data-result-user": o.user, ...resultFactsAttributeMap(facts) },
    heading, outcome,
    status: taskStatus,
    reviewHistory: REVIEW_TOKENS.has(status.token) ? status.detail : null,
    attention: attention.filter(one => !shortenedMaterialReason(one)).map(plainReasonWords),
    youCheck,
    // The same counts as the Requirements row (a refuted report verifies none of them, and says Unverified).
    requirements: proof === null || proof.verdict === "refuted" ? null : requirementsOf(proof.matrix),
    limits: attention.filter(one => shortenedMaterialReason(one)),
    tabs: RESULT_TABS.map(tab => ({ key: tab.key, label: tab.key === "checks" && proof?.matrix.some(row => row.assessment !== undefined) ? "Requirements" : tab.label, count: tabCounts[tab.key], href: o.hrefFor(tab.key), active: tab.key === o.tab })),
    views: [{ key: "summary", html: summaryParts.join("\n") }, { key: "changes", html: changeParts.join("\n") }, { key: "checks", html: checkParts.join("\n") }],
    history: detail.history ?? "",
    learning: detail.learning ?? "",
    request: detail.skillTest ? null : requestParts.join("\n"),
    canRequest: detail.canAnnotate && o.csrf !== "",
    need,
    requestQuiet: detail.canAnnotate && o.csrf !== "" && detail.comments.length === 0 && (detail.pastComments?.length ?? 0) === 0 && detail.revisions.length === 0,
  };
  return { html, panel };
}

/** Changed lines shown beside one "You check this one" item: at most this many per file, three files. */
export const CHECK_EXCERPT_LINES = 12;

/** Each requirement only a person can confirm, with the evidence to judge
 * it by, inline: the changed lines in the files it cites (citing none, the
 * change's first file, labelled as not cited), the screenshots it cites
 * (none cited: every validated one), and the agent's own note. */
export function personCheckItems(proof: ProofBundleView, patchText: string | null, shots: readonly ResultScreenshot[], runId: number): BrowserCheckItem[] {
  const rows = proof.matrix.filter(row => row.state === "manual-review");
  if (rows.length === 0) return proof.reasons.some(reason => manualReviewCriterionOf(reason) !== null)
    ? [{ id: "you-check", statement: "", words: personCheckWords(null), note: null, excerpts: [], shots: [] }] : [];
  const diff = patchText === null ? null : parseReviewDiff(patchText);
  const excerptOf = (file: ReviewDiffFile, cited: boolean): BrowserCheckItem["excerpts"][number] => {
    const changed = file.hunks.flatMap(hunk => hunk.lines).filter((line): line is ReviewDiffLine & { kind: "addition" | "deletion" } => line.kind === "addition" || line.kind === "deletion");
    return { path: file.path, cited, lines: changed.slice(0, CHECK_EXCERPT_LINES).map(line => ({ kind: line.kind, line: line.newLine ?? line.oldLine, text: line.text })), more: Math.max(0, changed.length - CHECK_EXCERPT_LINES) };
  };
  return rows.map(row => {
    const refs = row.answered ?? [];
    const paths = refs.filter(one => one.kind === "changed-path").map(one => one.ref);
    const files = diff === null ? [] : paths.length > 0 ? diff.files.filter(file => paths.includes(file.path)).map(file => excerptOf(file, true))
      : diff.files.slice(0, 1).map(file => excerptOf(file, false));
    const cited = refs.filter(one => one.kind === "screenshot").map(one => one.ref);
    const pictures = cited.length > 0 ? shots.filter(shot => cited.includes(shot.path)) : shots;
    const notes = refs.filter(one => one.kind === "manual-review").map(one => one.ref.trim()).filter(one => one !== "");
    return {
      id: row.id, statement: row.statement, words: personCheckWords(row.statement), note: notes.length === 0 ? null : notes.join(" "),
      excerpts: files.filter(one => one.lines.length > 0).slice(0, 3),
      shots: pictures.slice(0, 4).map(shot => ({ src: `/r/${runId}/evidence/${shot.artifactId}`, href: `/r/${runId}/evidence/${shot.artifactId}`, caption: shot.caption })),
    };
  });
}

/** A Needs you result's one action (needs-you.ts): a link to the act that resolves it, or Confirm it
 * stopped behind the password. Null under every other headline. */
export function needActionOf(assignment: AssignmentSnapshot | null, status: TaskStatus | null, csrf: string, returnTo: string,
  result?: { accepted: boolean; humanReview: boolean; run: number; action: string; rebuildable?: boolean; refuted?: boolean }): BrowserNeedAction | null {
  if (assignment === null || status === null || status.headline !== "Needs you" || status.need == null) return null;
  const action = assignment.primaryAction;
  const rebuild = { href: null, confirm: null, rebuild: { action: `${taskHref(assignment.rootId)}/requeue` } };
  // Built to an earlier plan: Build again, in place (the task page's requeue).
  if (action?.code === "retry-task" && status.need.key === "rebuild" && csrf !== "") return { label: status.need.action.label, ...rebuild };
  if (result !== undefined) {
    if ((status.need.key === "review-result" || result.refuted === true) && !result.accepted && csrf !== "") return { label: result.humanReview ? "Accept result" : "Accept with exception", href: null, confirm: null,
      accept: { action: result.action, run: result.run, returnTo, note: result.humanReview ? null : "Why is this safe to accept?" } };
    // The task page sends the person here: never back to it. What this page can do leads — Accept
    // a check only a person can make, or Build again a result that may run again.
    const here = (action?.code === "open-result" || action?.code === "inspect-run") && action.target.runId === result.run;
    if (here && csrf !== "" && !result.accepted && result.humanReview) return { label: "Accept result", href: null, confirm: null, accept: { action: result.action, run: result.run, returnTo, note: null } };
    if (here && csrf !== "" && result.rebuildable === true) return { label: NEEDS.rebuild.action.label, ...rebuild };
    // Nothing here resolves it: no act at all, never a link back to the task (which sends the person here).
    if (status.need.key === "review-result" || here) return null;
  }
  const confirm = action?.code === "confirm-stopped" && action.target.runId !== null && csrf !== ""
    ? { action: `${taskHref(assignment.rootId)}/confirm-stopped`, run: action.target.runId, returnTo, checked: needsCheck(assignment) } : null;
  return { label: status.need.action.label, href: assignmentActionHref(assignment) ?? taskHref(assignment.rootId), confirm };
}

/** A build Toolroll can't check at all: the approver ticks that they checked before confirming. */
export const needsCheck = (assignment: AssignmentSnapshot): boolean => assignment.need != null && "key" in assignment.need && assignment.need.key === "check-stopped";

/** The server page's form of the same: the need's action first, Request changes as the quiet second. */
export function resultNeedAction(need: BrowserNeedAction, o: ResultPanelOptions, canRequest: boolean): string {
  const control = need.accept != null
    ? `<form method="post" action="${escape(need.accept.action)}" class="accept-result"><input type="hidden" name="csrf" value="${escape(o.csrf)}"><input type="hidden" name="run" value="${need.accept.run}"><input type="hidden" name="return" value="${escape(need.accept.returnTo)}">` +
      (need.accept.note === null ? "" : `<input type="text" name="note" maxlength="500" required placeholder="${escape(need.accept.note)}" aria-label="${escape(need.accept.note)}">`) +
      `<button type="submit" data-primary-action data-accept-result style="min-height:44px">${escape(need.label)}</button></form>`
    : need.rebuild != null
    ? `<form method="post" action="${escape(need.rebuild.action)}" class="rebuild"><input type="hidden" name="csrf" value="${escape(o.csrf)}"><button type="submit" data-primary-action data-rebuild style="min-height:44px">${escape(need.label)}</button></form>`
    : need.confirm !== null
    ? `<form method="post" action="${escape(need.confirm.action)}" id="confirm-stopped" class="confirm-stopped"><input type="hidden" name="csrf" value="${escape(o.csrf)}"><input type="hidden" name="run" value="${need.confirm.run}"><input type="hidden" name="return" value="${escape(need.confirm.returnTo)}">` +
      (need.confirm.checked === true ? `<label><input type="checkbox" name="checked" value="yes" required> Nothing from build #${need.confirm.run} is running</label>` : "") +
      `<label>Your password<input type="password" name="token" autocomplete="current-password" required></label><button type="submit" style="min-height:44px">${escape(need.label)}</button></form>`
    : `<a class="button-link" href="${escape(need.href ?? "#")}" data-primary-action>${escape(need.label)}</a>`;
  return `<div class="result-action" data-result-action="need">${control}${canRequest && o.csrf !== "" ? `<a class="result-feedback-link" href="#request-changes">Request changes</a>` : ""}</div>`;
}

/** The outcome in one bounded sentence (repair 2026-09-14): the handoff's
 * first sentence, cut at a word when it runs past 180 characters. The
 * full conclusion stays available behind the Summary's disclosure. */
export function conciseOutcomeOf(conclusion: string): string {
  const flat = oneLineOf(conclusion, 2_000);
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  const bounded = sentence.length <= 140 ? sentence : `${sentence.slice(0, 140).replace(/\s+\S*$/, "")}…`;
  return bounded.trim();
}

/** Exactly one primary act for the result (repair 2026-09-14), chosen from
 * its state: draft the CI repair, create the revision the notes are
 * waiting for, open the pull request, or request changes. A bearer session
 * (no token) gets no control; the cockpit renders its own next-action
 * card instead (`action: false`). */
export function resultPrimaryAction(detail: ResultDetail, o: ResultPanelOptions, prUrl: string | null): string {
  const wrap = (kind: string, control: string): string => `<div class="result-action" data-result-action="${kind}">${control}</div>`;
  if (detail.ciFailing && o.csrf !== "") {
    return wrap("draft-repair", `<form method="post" action="/r/${detail.run.id}/draft-repair"><input type="hidden" name="csrf" value="${escape(o.csrf)}"><button type="submit">Draft a repair task</button></form>`);
  }
  if (detail.comments.length > 0 && o.csrf !== "") return wrap("revise", `<a class="result-feedback-link" href="#request-changes">Review saved notes</a>`);
  if (detail.publication !== null && detail.publication.prNumber !== null && prUrl !== null) return wrap("open-pr", `<a class="button-link" href="${escape(prUrl)}">Open PR #${detail.publication.prNumber}</a>`);
  if (detail.assignment == null && detail.proof?.matrix.some(row => row.assessment !== undefined) && detail.proof.reasons.includes(GOAL_ASSESSMENT_PENDING)) return wrap("open-result", `<a class="button-link" href="${reviewHref(detail.taskId)}">Open result</a>`);
  if (detail.assignment == null && detail.proof?.matrix.some(row => row.assessment !== undefined && row.review?.judgement === "cannot-tell")) return wrap("review-evidence", `<a class="button-link" href="${escape(o.hrefFor("checks"))}">Review evidence</a>`);
  if (detail.canAnnotate && o.csrf !== "") return wrap("request-changes", `<a class="result-feedback-link" href="#request-changes">Request changes</a>`);
  return "";
}

/** The run's facts as rows — one renderer for the page and its live
 * fragment (A4). Elapsed ticks client-side while the run is open. */
/** The run's route provenance in plain words (v47): the exact agent it
 * spent as, in which role, and how that agent was chosen. */
export function runAgentWords(route: RouteStamp | null | undefined): string | null {
  if (route === null || route === undefined) return null;
  const role = route.phase === "plan" ? "planner" : route.phase === "build" ? "builder" : route.phase === "repair" ? "repair" : "reviewer";
  const how =
    route.chosen === "fallback"
      ? "the approved fallback"
      : route.chosen === "override"
        ? "chosen by an approver"
        : route.chosen === "pinned"
          ? "pinned"
          : route.chosen === "legacy"
            ? "from the approved profile"
            : "recommended";
  return `${route.provider}${route.model === null ? "" : ` · ${route.model}`} as the ${role} — ${how}`;
}

export function runFactsRows(run: Run, taskId: string, live: boolean, route: RouteStamp | null = null): string {
  const facts: [string, string | null, boolean?][] = [
    ["task", taskId, true],
    ["role", run.role],
    ["agent", runAgentWords(route)],
    ["quality", qualityModeTitle(run.qualityMode ?? "default")],
    ["outcome", live ? "running" : (run.outcome ?? "never finished")],
    ["phase", live && run.phase !== null ? phaseWords(run.phase) : null],
    ["reason", run.reason === null ? null : isInternalErrorReason(run.reason) ? "stopped with an internal error (below)" : reasonWords(run.reason)],
    ["runner", run.runner, true],
    ["branch", run.branch, true],
    ["model", run.model, true],
    ["starting point", run.baseRevision === null ? null : `${run.baseRevision.slice(0, 12)}…`, true],
    ["ended at", run.headRevision === null ? null : `${run.headRevision.slice(0, 12)}…`, true],
    ["started", when(run.startedAt), true],
    ["finished", when(run.finishedAt), true],
    ["provider started", when(run.providerStartedAt), true],
    ["tokens in", run.tokensIn === null ? null : run.tokensIn.toLocaleString(), true],
    ["tokens out", run.tokensOut === null ? null : run.tokensOut.toLocaleString(), true],
    // Auth is part of the economic fact: Claude's subscription harness
    // reports an API-price equivalent, not a separate API-key charge.
    [
      "usage",
      run.providerStartedAt === null && run.tokensIn === null && run.tokensOut === null && run.costUsd === null ? null : runCostWords(run, live),
      run.costUsd !== null && run.authMode !== "subscription",
    ],
  ];
  const elapsed =
    live && run.startedAt !== null
      ? `<p class="row"><span class="meta" style="min-width:8.5rem">elapsed</span> <time class="mono" data-elapsed-since="${escape(run.startedAt)}"></time></p>`
      : "";
  return (
    facts
      .filter((fact): fact is [string, string, boolean?] => fact[1] !== null && fact[1] !== "")
      .map(
        ([label, value, mono]) =>
          `<p class="row"><span class="meta" style="min-width:8.5rem">${escape(label)}</span> ` +
          `<span${mono === true ? ` class="mono"` : ""}>${escape(value)}</span></p>`,
      )
      .join("\n") + elapsed +
    // Machine output (a stack trace, a path, "Error:" text) reads as an internal error everywhere else; its detail is here, as recorded.
    (run.reason !== null && isInternalErrorReason(run.reason)
      ? `<p class="row"><span class="meta" style="min-width:8.5rem">recorded error</span></p><pre class="mono" id="run-reason-detail" style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(run.reason)}</pre>`
      : "")
  );
}

export function runPage(
  chrome: Chrome,
  run: Run,
  taskId: string,
  artifacts: Artifact[],
  terminal: TerminalDiffView | null = null,
  notes: { id: number; author: string; note: string; createdAt: string }[] = [],
  csrf = "",
  comments: DiffComment[] = [],
  ciRepair: { pr: number } | null = null,
  liveScript?: string,
  peekable = false,
  running = false,
  editor: { worktree: string } | null = null,
  editorToggle: { on: boolean } | null = null,
  noted = false,
  structuredHandoff: StructuredHandoffView | null = null,
  proofBundle: ProofBundleView | null = null,
  route: RouteStamp | null = null,
  publicationRow: Publication | null = null,
  review: ReviewFacts | null = null,
  result: { detail: ResultDetail; tab: ResultTab; user: string; requestToken: string } | null = null,
  sourceDigest: string | null = null,
): Screen {
  const rows = runFactsRows(run, taskId, running, route);
  // The live peek region (A2): the poller fills it only on a serve that
  // asserted its runner. Without the assertion the section still appears
  // for a running build and says honestly why it is empty \u2014 a page that
  // silently lacked the region while the task screen promised a live view
  // read as broken (round-4, A1).
  const peek = !running
    ? ""
    : peekable
      ? `<h2>What is changing right now</h2>` +
        `<div id="run-peek"><p class="meta">Watching\u2026 the first look lands within 15 seconds</p></div>` +
        `<p class="meta" id="run-peek-stamp"></p>`
      : `<h2>What is changing right now</h2>` +
        `<p class="meta">The live file view is off \u2014 start serve with ${escape("--runner <name>")} naming this machine's worker, and it appears here</p>`;
  // The live transcript (arc 1): the agent's own words, streamed to a file
  // beside the run and polled as raw text. Honesty stated on the surface:
  // this is display only, and the machine running the agent could alter it.
  const transcript = !running
    ? ""
    : !peekable
      ? `<h2>What the agent is saying</h2>` +
        `<p class="meta">The live transcript is off \u2014 start serve with ${escape("--runner <name>")} naming this machine's worker, and it appears here</p>`
      : run.provider !== "claude"
        ? `<h2>What the agent is saying</h2>` +
          `<p class="meta">The live transcript needs the claude harness for now \u2014 this build runs on ${escape(run.provider)}</p>`
        : `<h2>What the agent is saying</h2>` +
          `<p class="meta">Display only \u2014 this is not evidence, and the machine running the agent could alter it</p>` +
          `<pre id="live-transcript" class="mono" style="max-height:24rem;overflow:auto;white-space:pre-wrap"></pre>` +
          `<p class="meta" id="live-transcript-state"></p>`;
  const resultSummary = structuredHandoff?.conclusion ?? run.handoff;
  const resultList = (label: string, items: string[]): string =>
    items.length === 0
      ? ""
      : `<div class="result-section"><strong>${escape(label)}</strong><ul>${items.map(one => `<li>${escape(one)}</li>`).join("")}</ul></div>`;
  const handoff =
    resultSummary === null
      ? ""
      : `<section class="card result-card"><h2>Result</h2><p class="recap">${escape(resultSummary)}</p>` +
        (structuredHandoff === null
          ? ""
          : resultList("completed", structuredHandoff.changes) +
            resultList("checks reported by the agent", structuredHandoff.verification) +
            resultList("follow-up", structuredHandoff.followUps)) +
        `</section>`;
  const evidence =
    artifacts.length === 0
      ? ""
      : `<details class="evidence-files"><summary>Saved files <span class="meta">(${artifacts.length})</span></summary><ul>` +
        artifacts
          .map(
            artifact =>
              `<li><a href="/r/${run.id}/evidence/${artifact.id}">${escape(evidenceWords(artifact.kind))}</a>` +
              ` <span class="meta" title="${artifact.bytesStored} bytes stored${artifact.truncated ? ` of ${artifact.bytesOriginal}` : ""}">${artifact.truncated ? `${humanBytes(artifact.bytesStored)} of ${humanBytes(artifact.bytesOriginal)} · partial` : humanBytes(artifact.bytesStored)}</span></li>`,
          )
          .join("") +
        "</ul></details>";
  // Review comments on the immutable terminal diff (M6.8): listed, added,
  // and sealed into ONE unapproved revision task. The seal is deliberately
  // plain — the ceremony lives on the revision task's approval screen,
  // which restates the batch; this button only creates the unapproved task.
  const hasTerminalDiff = terminal !== null && terminal.patch !== null && !("problem" in (terminal.patch as object));
  const commentPathWords = (path: string, line: number | null): string => {
    const shown = `${path}${line === null ? "" : `:${line}`}`;
    const href = editor === null ? null : editorFileHref(editor.worktree, path, line);
    return href === null
      ? `<span class="mono">${escape(shown)}</span> `
      : `<a class="mono" href="${escape(href)}">${escape(shown)}</a> `;
  };
  const commentRows = comments
    .map(
      one =>
        `<div class="diff-comment"><span class="diff-comment-pin" aria-hidden="true"></span><p>` +
        `${one.path === null ? "" : commentPathWords(one.path, one.line)}` +
        `${escape(one.note)}</p><span class="meta">${escape(one.author)} · ${whenTime(one.createdAt)}</span></div>`,
    )
    .join("\n");
  const commentForm =
    csrf === "" || !hasTerminalDiff
      ? ""
      : `<form method="post" action="/r/${run.id}/comment" class="card diff-comment-form" id="comment-form">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<div class="diff-comment-target"><label>File<input type="text" name="path" placeholder="select a line above" aria-label="file" class="mono"></label>` +
        `<label>Line<input type="text" name="line" placeholder="—" aria-label="line" inputmode="numeric"></label></div>` +
        `<label>Change requested<textarea name="note" rows="2" maxlength="${LIMITS.note}" placeholder="Explain what should change and why" aria-label="review comment" aria-describedby="comment-note-limit"${noted ? " autofocus" : ""}></textarea></label>` +
        `<span class="meta diff-comment-limit" id="comment-note-limit">up to ${LIMITS.note} characters</span>` +
        `<button type="submit">Add annotation</button></form>`;
  // The device-side half of the editor-link activation (arc 6, finding 1):
  // rendered only when the server capability exists and this run belongs
  // to this machine's runner — the person at the browser flips it.
  const editorToggleForm =
    editorToggle === null || csrf === ""
      ? ""
      : `<form method="post" action="/session/editor-links" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="hidden" name="on" value="${editorToggle.on ? "0" : "1"}">` +
        `<input type="hidden" name="return" value="/r/${run.id}">` +
        `<button type="submit">${editorToggle.on ? "stop opening files in VS Code from this device" : "open files in VS Code from this device"}</button>` +
        `<span class="meta"> — only useful when this browser runs on the machine that holds the worktrees</span></form>`;
  const reviseForm =
    csrf === "" || comments.length === 0
      ? ""
      : `<form method="post" action="/r/${run.id}/revise" class="card revision-from-comments">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">${revisionSealFields(comments, sourceDigest)}` +
        `<div><strong>${comments.length} annotation${comments.length === 1 ? "" : "s"} ready</strong>` +
        `<span class="meta">Creates one revision carrying this exact batch. You review its scope before anything builds.</span></div>` +
        `<button type="submit">Create revision from annotations</button></form>`;
  // CI repair, suggestion-first (M8.18): the observed red episode earns a
  // button; the button drafts ONE unapproved task; a person approves it.
  const repairCard =
    ciRepair === null || csrf === ""
      ? ""
      : `<div class="card"><p><strong>CI is failing on PR #${ciRepair.pr}</strong> <span class="meta">observed by the episode watcher</span></p>` +
        `<form method="post" action="/r/${run.id}/draft-repair">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<button type="submit">Draft a repair task</button>` +
        `<span class="meta"> — one unapproved task; you approve its scope before anything builds</span></form></div>`;

  const reviewCard =
    (commentRows === "" && commentForm === "" ? "" : `<h2 id="review">Review and revise</h2>` +
      `<p class="meta">Annotate the diff above. When the batch is ready, create one scoped revision task from it.</p>` +
      `${commentRows === "" ? "" : `<div class="diff-comments">${commentRows}</div>`}${commentForm}${reviseForm}${editorToggleForm}`) + repairCard;

  const noteRows =
    notes.length === 0
      ? ""
      : notes
          .map(
            one =>
              `<p class="row"><span class="meta">${escape(one.author)} · ${whenTime(one.createdAt)}</span> ` +
              `${escape(one.note)}</p>`,
          )
          .join("\n");
  const noteForm =
    csrf === ""
      ? ""
      : `<form method="post" action="/r/${run.id}/note" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="text" name="note" placeholder="a note for whoever reads this run next" aria-label="run note" style="width:100%;max-width:28rem">` +
        `<button type="submit">Add note</button></form>`;
  const notesCard = noteRows === "" && noteForm === "" ? "" : `<h2>Operator notes</h2>${noteRows}${noteForm}`;

  // Outcome first (UI polish 2026-09-13): a finished build leads with its
  // result, proof, and diff; the machine facts fold under "Build details".
  // A live build keeps the facts open — they are what a watcher polls.
  const facts =
    running
      ? `<div id="run-facts">${rows}</div><p class="meta" id="run-facts-stamp"></p>`
      : `<details class="run-facts-details"><summary>Run record<span class="meta">${escape([run.runner, run.provider, run.outcome ?? "never finished"].join(" · "))}</span></summary><div id="run-facts">${rows}</div></details>`;
  // A finished result (package 3) is the ONE shared panel — Summary /
  // Changes / Checks with Request changes beside it — the same markup the
  // review cockpit and the chat's result view render. Every other run
  // (live, failed, interrupted) keeps its record-by-record page.
  const resultPanel =
    result === null
      ? null
      : resultPanelHtml(result.detail, {
          place: "run",
          tab: result.tab,
          csrf,
          user: result.user,
          noted,
          requestToken: result.requestToken,
          hrefFor: one => (one === "summary" ? `/r/${run.id}` : `/r/${run.id}?tab=${one}`),
          returnTo: `/r/${run.id}`,
          back: null,
        });
  return screen(`build #${run.id}`, [
    `<h1>Build #${run.id} <span class="meta"><a href="${taskHref(taskId)}">${escape(taskId)}</a></span></h1>`,
    running ? facts : "",
    transcript,
    peek,
    ...(resultPanel === null
      ? [
          handoff,
          evidenceBundleCard(proofBundle, run, publicationFactsOf(publicationRow), review),
          terminal === null ? "" : terminalDiffCard(terminal, run.id, editor, commentForm !== ""),
          reviewCard,
        ]
      : [resultPanel, editorToggleForm]),
    running ? "" : facts,
    evidence,
    notesCard,
  ].join("\n"), {
    chrome,
    // One composed functional script (arc 4 contract): the pollers when the
    // run is live, the result panel's tabs/draft script or the legacy
    // comment prefill when a form exists. Neither fetches — they earn
    // neither connect-src nor the noscript refresh.
    ...(liveScript === undefined && commentForm === "" && resultPanel === null
      ? {}
      : {
          functional: {
            script: (liveScript ?? "") + (resultPanel !== null ? RESULT_REVIEW_SCRIPT : commentForm === "" ? "" : prefillScript()),
            fetches: liveScript !== undefined,
          },
        }),
  });
}

/**
 * Click-to-prefill (arc 6, finding 4): client-side FORM mutation, named as
 * such — normal viewing stays the default; "Annotate" reveals line pins.
 * A pin or file button copies its target into the comment form and focuses
 * the note field. No fetch, endpoint, or submit: comments still leave
 * through the same CSRF'd form POST. Reads data attributes, writes input
 * values, and flips presentational state — never markup. The note counter
 * (follow-up on build 1540) reads the textarea's own maxlength — the
 * server's LIMITS.note — into the helper text, so the two cannot drift.
 */
export function prefillScript(): string {
  return (
    `(function(){var form=document.getElementById("comment-form");if(!form)return;var review=document.querySelector("[data-review-diff]");` +
    `var noteBox=form.querySelector("[name=note]"),limit=document.getElementById("comment-note-limit");if(noteBox&&limit&&noteBox.maxLength>0){` +
    `function tally(){limit.textContent=noteBox.value.length===0?"up to "+noteBox.maxLength+" characters":noteBox.value.length+" of "+noteBox.maxLength+" characters";}tally();noteBox.addEventListener("input",tally);}` +
    `if(review){review.setAttribute("data-mode","view");review.addEventListener("click",function(ev){` +
    `var mode=ev.target&&ev.target.closest?ev.target.closest("button[data-diff-mode]"):null;if(!mode)return;` +
    `var value=mode.getAttribute("data-diff-mode")==="annotate"?"annotate":"view";review.setAttribute("data-mode",value);` +
    `review.querySelectorAll("button[data-diff-mode]").forEach(function(one){one.setAttribute("aria-pressed",String(one===mode));});});}` +
    `document.addEventListener("click",function(ev){` +
    `var button=ev.target&&ev.target.closest?ev.target.closest("button.pick-file,button.pick-line"):null;if(!button)return;` +
    `var path=form.querySelector("[name=path]");var line=form.querySelector("[name=line]");var note=form.querySelector("[name=note]");` +
    `if(path)path.value=button.getAttribute("data-path")||"";` +
    `if(line)line.value=button.getAttribute("data-line")||"";` +
    `form.scrollIntoView({behavior:"smooth",block:"center"});if(note)note.focus();});})();`
  );
}

/** The primary review act opens the Checks view it names. The anchor
 * still lands on the result without JavaScript (the server honours
 * `?tab=checks`); this only removes the reload. */
export function reviewEvidenceScript(): string {
  return (
    `(function(){var link=document.querySelector("[data-open-evidence]"),tab=document.querySelector('[data-result-tab="checks"]'),panel=document.getElementById("result");` +
    `if(!link||!tab||!panel)return;link.addEventListener("click",function(ev){ev.preventDefault();tab.click();panel.scrollIntoView({behavior:"smooth",block:"start"});});})();`
  );
}

/** The facts region alone, for the open-run poll (A4). A finished run's
 * fragment says so instead of quietly growing forms (finding 5), and a run
 * that stopped being the task's live claim says so too — both carry the
 * stop marker, so an open tab quits refetching a dead build (round-4
 * finding 15). */
export function runFactsFragment(run: Run, taskId: string, live: boolean, route: RouteStamp | null = null): string {
  if (run.outcome !== null) {
    return `<p class="meta" data-region-stop>finished — <a href="/r/${run.id}">reload for the final record</a></p>`;
  }
  if (!live) {
    return `<p class="meta" data-region-stop>this build stopped without finishing — <a href="/r/${run.id}">reload for the record</a></p>`;
  }
  return runFactsRows(run, taskId, live, route);
}

/** One accessible two-choice control everywhere permissions are selected.
 * The words describe behavior; the raw flag stays secondary detail. */
export function permissionModeChoices(name: string, selected: UnattendedPermissionMode): string {
  const choice = (value: UnattendedPermissionMode, title: string, detail: string): string =>
    `<label class="permission-choice"><input type="radio" name="${escape(name)}" value="${escape(value)}"${value === selected ? " checked" : ""}>` +
    `<span><strong>${escape(title)}</strong><small>${escape(detail)}</small></span></label>`;
  return `<div class="permission-toggle" role="radiogroup" aria-label="agent permissions">` +
    choice("auto", "Auto", "Asks before risky actions.") +
    choice("bypassPermissions", "Full access", "Never asks and can change files anywhere on this computer. Trusted repositories only.") +
    `</div>`;
}

/** Quality selects the configured agent route; permissions remain separate. */
export function qualityModeChoices(name: string, selected: QualityMode): string {
  const choice = (value: QualityMode, title: string, detail: string): string =>
    `<label class="permission-choice"><input type="radio" name="${escape(name)}" value="${escape(value)}"${value === selected ? " checked" : ""}>` +
    `<span><strong>${escape(title)}</strong><small>${escape(detail)}</small></span></label>`;
  return `<div class="permission-toggle" role="radiogroup" aria-label="quality mode">` +
    choice("default", "Default", "Everyday agents and the repository check.") +
    choice("strict", "Strict / release", "Strongest agents. Release approval stays separate.") +
    `</div>`;
}

export function capsPage(chrome: Chrome, caps: Capability[] | null, gaps: Gap[], repo: string, now?: Date): Screen {
  if (caps === null) {
    return screen("requirements", [
      `<h1>Requirements</h1>`,
      `<p class="meta">Open a project to see its requirements — <a href="/projects">projects</a></p>`,
    ].join("\n"), { chrome });
  }
  const list =
    caps.length === 0
      ? "<p>Nothing recorded.</p>"
      : caps
          .map(
            capability =>
              `<p class="row">${escape(capability.kind)}:${escape(capability.name)} — ` +
              `${escape(describeCapability(capability, now ?? new Date()))}</p>`,
          )
          .join("\n");
  const blocked =
    gaps.length === 0
      ? `<p class="meta">No gaps — everything recorded is verified</p>`
      : gaps
          .map(
            gap =>
              `<div class="card"><p>${escape(gap.key)} — ${escape(gap.state)}</p>` +
              `<p class="meta">${
                gap.unblocks.length > 0
                  ? `fills → ${gap.unblocks.length} task(s) start: ${gap.unblocks.map(one => escape(one)).join(", ")}`
                  : gap.alsoBlocks.length > 0
                    ? `part of what holds: ${gap.alsoBlocks.map(one => escape(one)).join(", ")}`
                    : "nothing queued needs it yet"
              }</p>` +
              `<p class="meta">Verify: ${escape(gap.verify)}</p>` +
              `<p class="meta">${escape(gap.instructions)}</p></div>`,
          )
          .join("\n");
  return screen("requirements", [
    `<h1>Requirements</h1>`,
    `<p class="hint">tools and credentials builds need — each is probed on the worker before any build spends money; values never leave your machine</p>`,
    list,
    `<h2>Missing, ranked by what filling them frees</h2>`,
    blocked,
    `<p class="meta">Read-only here: checks are shell commands you wrote, and a web button that runs shell would need its own security review</p>`,
  ].join("\n"), { chrome });
}

/** Whether the bot's saved delivery state reports a problem (no new check runs). */
export function telegramTrouble(store: Store, bot: TokenSource | null): boolean {
  return bot !== null && (store.telegramPush(bot.botId)?.problem ?? null) !== null;
}

/** v98: how the bot's messages reach Toolroll, in words: pushed to the public address, or asked for. */
export function telegramDeliveryWords(store: Store, bot: TokenSource | null): string | null {
  if (bot === null) return null;
  const state = store.telegramPush(bot.botId);
  if (state?.url) return `Telegram pushes new messages to ${state.url}${state.problem === null ? "." : `, but ${state.problem.charAt(0).toLowerCase()}${state.problem.slice(1)}.`}`;
  return `Toolroll asks Telegram for new messages every few seconds${state?.problem ? ` (${state.problem})` : ""}.`;
}

/** The projects this person can see, by name, and whether they muted each one's pings. */
export function notificationProjects(store: Store, account: string): { repo: string; name: string; muted: boolean }[] {
  const muted = new Set(store.mutedProjects(account));
  return store.listProjects().filter(one => store.accountCanAccess(account, one.path))
    .map(one => ({ repo: one.path, name: one.name, muted: muted.has(one.path) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function settingsPage(
  chrome: Chrome,
  existing: TokenSource | null,
  hasEnv: boolean,
  csrf: string,
  problem: string | null,
  messaging: { channel: string | null; implicit: boolean; configured: string[]; legacyWarning?: string } | null = null,
  push: { available: boolean; devices: PushSubscription[] } | null = null,
  providerKeys: { provider: string; envName: string; set: boolean; updatedAt: string | null; ambient: boolean; mode: "subscription" | "api-key"; subscriptionCapable: boolean; connection?: ProviderConnection }[] | null = null,
  digest: { everyMs: number | null; lastSentAt: string | null; held: number } | null = null,
  permissionDefault: { mode: UnattendedPermissionMode; updatedAt: string | null; updatedBy: string | null; canManage: boolean } | null = null,
  qualityDefault: { mode: QualityMode; updatedAt: string | null; updatedBy: string | null; canManage: boolean } | null = null,
  email: NonNullable<BrowserSettingsView["email"]> | null = null,
  telegramDelivery: string | null = null,
  workers: NonNullable<BrowserSettingsView["workers"]> | null = null,
  updates: BrowserUpdates | null = null,
  firstResult: string | null = null,
  chatNotices: { mode: "quiet" | "all"; digestAt: string | null; screenshots?: ResultScreenshots; projects?: { repo: string; name: string; muted: boolean }[] } | null = null,
  telegramFailing = false,
  phone: BrowserPhoneCard | null = null,
): Screen {
  const permissionCard =
    permissionDefault === null
      ? ""
      : [
          "<h2>Unattended permissions</h2>",
          permissionDefault.canManage && csrf !== ""
            ? `<form method="post" action="/settings/permission-default" class="card permission-policy" data-autosave>` +
              `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
              permissionModeChoices("permission-mode", permissionDefault.mode) +
              `<button type="submit">Save default</button></form>`
            : `<div class="card"><p><strong>${permissionDefault.mode === "bypassPermissions" ? "Full access" : "Auto"}</strong></p><p class="meta">An approver can change this default</p></div>`,
          permissionDefault.updatedAt === null
            ? ""
            : `<p class="meta settings-changed">Changed ${whenTime(permissionDefault.updatedAt)}${permissionDefault.updatedBy === null ? "" : ` by ${escape(permissionDefault.updatedBy)}`}</p>`,
        ].join("\n");
  const qualityCard =
    qualityDefault === null
      ? ""
      : [
          "<h2>Quality mode</h2>",
          qualityDefault.canManage && csrf !== ""
            ? `<form method="post" action="/settings/quality-default" class="card permission-policy" data-autosave>` +
              `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
              qualityModeChoices("quality-mode", qualityDefault.mode) +
              `<button type="submit">Save default</button></form>`
            : `<div class="card"><p><strong>${escape(qualityModeTitle(qualityDefault.mode))}</strong></p><p class="meta">An approver can change this default</p></div>`,
          qualityDefault.updatedAt === null
            ? ""
            : `<p class="meta settings-changed">Changed ${whenTime(qualityDefault.updatedAt)}${qualityDefault.updatedBy === null ? "" : ` by ${escape(qualityDefault.updatedBy)}`}</p>`,
        ].join("\n");
  // Quiet chat: this person's own choice. The installation's Telegram cadence only bundles Every step updates.
  const chatCard =
    chatNotices === null || csrf === ""
      ? ""
      : [
          "<h3>Chat messages</h3>",
          `<form method="post" action="/settings/notifications" class="card" data-autosave>`,
          `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
          `<label><input type="radio" name="mode" value="quiet"${chatNotices.mode === "quiet" ? " checked" : ""}> Only when I'm needed <span class="meta">· one message per task, updated as it moves</span></label>`,
          `<label><input type="radio" name="mode" value="all"${chatNotices.mode === "all" ? " checked" : ""}> Every step <span class="meta">· a new message for each update</span></label>`,
          `<label>Evening digest<select name="digest">` +
            digestTimes(chatNotices.digestAt).map(([value, label]) => `<option value="${value}"${value === (chatNotices.digestAt ?? "off") ? " selected" : ""}>${label}</option>`).join("") +
            `</select></label>`,
          `<p class="meta">One message: what finished, what waits, what failed.</p>`,
          `<label>Screenshots with results<select name="screenshots">` +
            RESULT_SHOT_CHOICES.map(([value, label]) => `<option value="${value}"${value === (chatNotices.screenshots ?? "off") ? " selected" : ""}>${label}</option>`).join("") +
            `</select></label>`,
          `<button type="submit">Save</button>`,
          `</form>`,
          ...((chatNotices.projects ?? []).length === 0 ? [] : [
            "<h3>Projects</h3>",
            `<ul class="card">${chatNotices.projects!.map(one => `<li><form method="post" action="/settings/notifications/mute">` +
              `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="repo" value="${escape(one.repo)}">` +
              (one.muted ? "" : `<input type="hidden" name="pings" value="on">`) +
              `${escape(one.name)} <span class="meta">· ${one.muted ? "muted" : "pings on"}</span> <button type="submit">${one.muted ? "Unmute" : "Mute"}</button></form></li>`).join("")}</ul>`,
            `<p class="meta">Muted projects still show in Tasks and the evening digest.</p>`,
          ]),
        ].join("\n");
  const digestCard =
    digest === null || csrf === "" || chatNotices?.mode === "quiet"
      ? ""
      : [
          "<h3>Telegram digest</h3>",
          `<p class="meta">Bundle routine updates. Anything that needs you still arrives at once.</p>`,
          `<form method="post" action="/settings/telegram-digest" class="card" data-autosave>`,
          `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
          `<label>Send a digest<select name="every">` +
            [
              ["off", "Off: send each update"],
              ["30", "every 30 minutes"],
              ["60", "every hour"],
              ["240", "every 4 hours"],
              ["720", "every 12 hours"],
              ["1440", "once a day"],
            ]
              .map(([value, label]) => {
                const selected = value === "off" ? digest.everyMs === null : digest.everyMs === Number(value) * 60_000;
                return `<option value="${value}"${selected ? " selected" : ""}>${label}</option>`;
              })
              .join("") +
            `</select></label>`,
          `<p class="meta">${
            digest.everyMs === null
              ? ""
              : `${digest.held} routine fact(s) held · next digest ${digest.lastSentAt === null ? "at the next bridge pass" : `no earlier than ${escape(new Date(new Date(digest.lastSentAt).getTime() + digest.everyMs).toISOString())}`}`
          }</p>`,
          `<button type="submit">Save digest</button>`,
          `</form>`,
        ].join("\n");
  const keysCard =
    providerKeys === null || csrf === ""
      ? ""
      : [
          '<h2 id="providers">AI providers</h2><p><a href="/control">Set up this project</a></p>',
          `<p class="meta">Keys stay on this computer and are never shown again.</p>`,
          `<details class="settings-more"><summary>How keys are used</summary><p class="meta">A key is used only when that provider’s sign-in is set to API key. With a subscription sign-in the key is kept out of the agent, so your membership never turns into API billing. Keys are private files beside the database, never stored in it.</p></details>`,
          ...providerKeys.map(one => {
            // One status row per provider; the controls wait behind Manage.
            const name = ASSISTANTS[one.provider as ProviderId]?.name ?? one.provider;
            const status = one.connection !== undefined && one.connection.state === "connected"
              ? { tone: "ok", words: [connectionWords(one.connection), one.connection.plan].filter(Boolean).join(" · ") }
              : one.mode === "subscription"
                ? { tone: one.connection === undefined ? "neutral" : "warn", words: one.connection === undefined ? "Uses its own sign-in" : connectionWords(one.connection) }
                : one.connection?.state === "key-works" ? { tone: "ok", words: "API key works" } : one.connection?.state === "key-refused" ? { tone: "warn", words: "API key refused" }
                : one.set ? { tone: "ok", words: "API key saved" } : one.ambient ? { tone: "ok", words: "Key from this computer’s environment" } : { tone: "off", words: "Not set up" };
            return [
              `<div class="provider-row" data-provider="${escape(one.provider)}">`,
              `<p class="provider-head"><strong>${escape(name)}</strong> <span class="provider-status provider-status--${status.tone}"><i aria-hidden="true"></i>${status.words}</span></p>`,
              `<details class="provider-manage"><summary>Manage</summary>`,
              `<form method="post" action="/settings/provider-key" class="card">`,
              `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
              `<input type="hidden" name="provider" value="${escape(one.provider)}">`,
              one.connection === undefined ? "" : `<p class="provider-connection"><strong>${connectionWords(one.connection)}</strong> ${[one.connection.email, one.connection.plan, one.connection.method].filter(Boolean).map(value => escape(value!)).join(" · ")} · <a href="/settings?check-connection=${encodeURIComponent(one.provider)}#providers">Check again</a></p>`,
              `<p class="meta">${one.mode === "subscription" ? "Uses its own sign-in, so no API-key spend" : "Uses the API key"} · <span class="mono">${escape(one.envName)}</span> · ${
                one.set ? `key stored${one.updatedAt === null ? "" : ` ${escape(one.updatedAt.slice(0, 10))}`}` : one.ambient ? "key in this server's environment" : "no key stored"}</p>`,
              one.subscriptionCapable
                ? `<label>Sign-in<select name="auth-mode">` +
                  `<option value="subscription"${one.mode === "subscription" ? " selected" : ""}>${escape(name)} subscription</option>` +
                  `<option value="api-key"${one.mode === "api-key" ? " selected" : ""}>API key</option>` +
                  `</select></label>`
                : "",
              `<label>API key<input type="password" name="value" autocomplete="off" placeholder="${one.set ? "Paste to replace the stored key" : "Paste a key"}"></label>`,
              `<button type="submit">Save ${escape(name)}</button>`,
              one.set
                ? ` <details class="confirm-remove"><summary>Remove the stored key</summary><p class="meta">Runs that use this API key stop until you add one again.</p><button type="submit" formaction="/settings/provider-key-clear" class="danger">Remove key</button></details>`
                : "",
              `</form></details></div>`,
            ].join("\n");
          }),
        ].join("\n");
  const pushCard =
    push === null || csrf === ""
      ? ""
      : [
          "<h3>This device</h3>",
          push.available
            ? [
                `<p class="meta">A notification when something needs you. On iPhone, add this app to your Home Screen first.</p>`,
                `<form method="post" action="/push/subscribe" id="push-form" class="card">`,
                `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
                `<input type="hidden" name="endpoint" value=""><input type="hidden" name="p256dh" value=""><input type="hidden" name="auth" value="">`,
                `<label>Your password <input type="password" name="token" autocomplete="current-password"></label>`,
                `<button type="submit" id="push-enable">Get alerts on this device</button>`,
                `<p class="meta" id="push-state"></p>`,
                `</form>`,
              ].join("\n")
            : `<p class="meta">Alerts need a secure (https) address for this app.</p>`,
          ...push.devices
            .filter(one => one.retiredAt === null || one.retiredReason === "gone")
            .map(
              one =>
                `<p class="row">${escape(one.uaWords)} · since ${whenTime(one.createdAt)}` +
                `${one.retiredAt !== null ? ` · <span class="meta">expired</span>` : one.consecutiveFailures >= 20 ? ` · <span class="meta">failing</span>` : ""}` +
                (one.retiredAt === null
                  ? ` <form method="post" action="/push/remove" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="id" value="${one.id}"><button type="submit">Remove</button></form>`
                  : "") +
                `</p>`,
            ),
        ].join("\n");
  // The enrollment behavior rides the ONE composed script (arc 4, finding
  // 18) — it fills the subscription fields the form posts; it never reads
  // the password field beside them (the named functional exception).
  const pushScript =
    push === null || !push.available || csrf === ""
      ? null
      : `(function(){` +
        `if(!("serviceWorker" in navigator)||!("PushManager" in window))return;` +
        `var link=document.createElement("link");link.rel="manifest";link.href="/manifest.webmanifest";document.head.appendChild(link);` +
        `navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(function(){});` +
        `var form=document.getElementById("push-form");if(!form)return;` +
        `form.addEventListener("submit",function(event){` +
        `if(form.dataset.ready==="1")return;` +
        `event.preventDefault();var state=document.getElementById("push-state");` +
        `Notification.requestPermission().then(function(granted){` +
        `if(granted!=="granted"){if(state)state.textContent="notifications are blocked for this site in the browser settings";return;}` +
        `return fetch("/push/key").then(function(r){return r.json();}).then(function(d){` +
        `return navigator.serviceWorker.ready.then(function(reg){` +
        `return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(d.key.replace(/-/g,"+").replace(/_/g,"/")),function(c){return c.charCodeAt(0);})});});` +
        `}).then(function(sub){var raw=sub.toJSON();` +
        `form.querySelector("[name=endpoint]").value=sub.endpoint;` +
        `form.querySelector("[name=p256dh]").value=(raw.keys.p256dh||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
        `form.querySelector("[name=auth]").value=(raw.keys.auth||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
        `form.dataset.ready="1";form.submit();});` +
        `}).catch(function(){if(state)state.textContent="could not subscribe — the browser said no";});});` +
        `})();`;
  const messagingCard =
    messaging === null || messaging.configured.length === 0
      ? ""
      : messaging.configured.length === 1 && !messaging.implicit
        ? `<h3>Alert service</h3><p class="provider-head"><strong>${escape(messaging.configured[0]!)}</strong> <span class="provider-status provider-status--ok"><i aria-hidden="true"></i>Receiving alerts</span></p>`
      : [
          "<h3>Alert service</h3>",
          `<p class="meta">Alerts go through one service, so you are never notified twice${
            messaging.implicit ? " · <strong>Several are connected and none was chosen. Pick one.</strong>" : ""
          }</p>`,
          `<form method="post" action="/settings/messaging" class="card">`,
          `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
          ...messaging.configured.map(
            channel =>
              `<label style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="primary" value="${escape(channel)}"${
                channel === messaging.channel ? " checked" : ""
              }> ${escape(channel)}${channel === messaging.channel ? ` <span class="meta">— receiving alerts now${messaging.implicit ? " (by default, not by choice)" : ""}</span>` : ""}${
                channel === "telegram" ? ` <span class="meta">· can carry answer buttons and reply-notes</span>` : ` <span class="meta">· messages with console links; acting stays here</span>`
              }</label>`,
          ),
          `<button type="submit">Use this service</button>`,
          `</form>`,
          `<p class="meta">Telegram still accepts taps and replies when another service sends alerts.</p>`,
        ].join("\n");
  const current =
    hasEnv
      ? `set in the environment (${escape(TOKEN_ENV)}) — that takes precedence over anything saved here`
      : existing === null
        ? "not set"
        : `saved: ${escape(redactToken(existing.token))} (bot ${escape(existing.botId)})`;
  const theme = requestContext.getStore()?.theme ?? "system";
  const view: BrowserSettingsView = {
    kind: "settings",
    said: problem,
    groups: settingsGroups(messaging, telegramFailing),
    ...(messaging?.legacyWarning ? { legacyWebhookWarning: messaging.legacyWarning } : {}),
    theme,
    accent: requestContext.getStore()?.accent ?? DEFAULT_ACCENT,
    accentPresets: ACCENT_PRESETS,
    permission: permissionDefault === null ? null : { mode: permissionDefault.mode, canManage: permissionDefault.canManage && csrf !== "", changed: permissionDefault.updatedAt === null ? null : `Changed ${when(permissionDefault.updatedAt)}${permissionDefault.updatedBy === null ? "" : ` by ${permissionDefault.updatedBy}`}` },
    quality: qualityDefault === null ? null : { mode: qualityDefault.mode, canManage: qualityDefault.canManage && csrf !== "", changed: qualityDefault.updatedAt === null ? null : `Changed ${when(qualityDefault.updatedAt)}${qualityDefault.updatedBy === null ? "" : ` by ${qualityDefault.updatedBy}`}` },
    providers: providerKeys === null || csrf === "" ? null : providerKeys.map(one => {
      const name = ASSISTANTS[one.provider as ProviderId]?.name ?? one.provider;
      const status = one.connection !== undefined && one.connection.state === "connected"
        ? { tone: "ok" as const, words: [connectionWords(one.connection), one.connection.plan].filter(Boolean).join(" · ") }
        : one.mode === "subscription"
          ? { tone: one.connection === undefined ? "neutral" as const : "warn" as const, words: one.connection === undefined ? "Uses its own sign-in" : connectionWords(one.connection) }
          : one.connection?.state === "key-works" ? { tone: "ok" as const, words: "API key works" } : one.connection?.state === "key-refused" ? { tone: "warn" as const, words: "API key refused" }
          : one.set ? { tone: "ok" as const, words: "API key saved" } : one.ambient ? { tone: "ok" as const, words: "Key from this computer’s environment" } : { tone: "off" as const, words: "Not set up" };
      return {
        provider: one.provider, name, tone: status.tone, words: status.words,
        connection: one.connection === undefined ? null : { words: connectionWords(one.connection), facts: [one.connection.email, one.connection.plan, one.connection.method].filter(Boolean).join(" · "), checkHref: `/settings?check-connection=${encodeURIComponent(one.provider)}#providers` },
        usage: `${one.mode === "subscription" ? "Uses its own sign-in, so no API-key spend" : "Uses the API key"} · ${one.set ? `key stored${one.updatedAt === null ? "" : ` ${one.updatedAt.slice(0, 10)}`}` : one.ambient ? "key in this server's environment" : "no key stored"}`,
        envName: one.envName, subscriptionCapable: one.subscriptionCapable, mode: one.mode, set: one.set,
      };
    }),
    services: messaging === null || messaging.configured.length === 0 ? null : { configured: messaging.configured, channel: messaging.channel, implicit: messaging.implicit },
    push: push === null || csrf === "" ? null : { available: push.available, devices: push.devices.filter(one => one.retiredAt === null || one.retiredReason === "gone").map(one => ({ id: one.id, words: `${one.uaWords} · since ${when(one.createdAt)}`, state: one.retiredAt !== null ? "expired" : one.consecutiveFailures >= 20 ? "failing" : "ok", removable: one.retiredAt === null })) },
    chat: chatNotices === null || csrf === "" ? null : chatNotices,
    digest: digest === null || csrf === "" || chatNotices?.mode === "quiet" ? null : { every: digest.everyMs === null ? "off" : String(Math.round(digest.everyMs / 60_000)), held: digest.everyMs === null ? null : `${digest.held} routine fact(s) held` },
    telegram: { state: hasEnv ? "from the environment" : existing === null ? "not set" : "saved", current, delivery: telegramDelivery },
    email,
    workers,
    updates,
    firstResult,
    ...(phone === null ? {} : { phone }),
  };
  return screen("Settings", [
    "<h1>Settings</h1>",
    messaging?.legacyWarning ? `<p data-legacy-webhooks>Legacy webhooks are deprecated. Connect <a href="/settings/slack" style="display:inline-flex;min-height:44px;align-items:center">Slack</a> or <a href="/settings/discord" style="display:inline-flex;min-height:44px;align-items:center">Discord</a> in Chat settings.</p>` : "",
    settingsTiles(view.groups),
    phone === null ? "" : phoneSetupHtml(phone),
    appearanceCard(csrf),
    permissionCard,
    qualityCard,
    keysCard,
    workersCard(workers),
    updatesCard(updates, csrf),
    firstResult === null ? "" : `<p class="meta" data-first-result>${escape(firstResult)}</p>`,
    pushCard === "" && messagingCard === "" && digestCard === "" && chatCard === "" ? "" : `<h2>Notifications</h2>`,
    chatCard,
    messagingCard,
    pushCard,
    digestCard,
    problem === null ? "" : `<p class="problem" role="alert">${escape(problem)}</p>`,
    `<details class="settings-more" id="telegram-token"><summary>Telegram bot token <span class="meta">${hasEnv ? "from the environment" : existing === null ? "not set" : "saved"}</span></summary>`,
    `<p class="meta">Current: ${current}</p>`,
    telegramDelivery === null ? "" : `<p class="meta" data-telegram-delivery>${escape(telegramDelivery)}</p>`,
    `<form method="post" action="/settings/telegram-token">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<label>Token from @BotFather<input type="password" name="token" autocomplete="off"></label>`,
    `<button type="submit">Save token</button>`,
    "</form>",
    `<p class="meta">Stored privately on this computer. Then pair your phone under <a href="/settings/telegram">Telegram</a>. In Telegram, send <code>/status</code>, <code>/task &lt;id&gt;</code> or <code>/help</code>; these use no AI model.</p>`,
    `</details>`,
  ].join("\n"), { chrome, workspace: { view }, functional: { script: SETTINGS_AUTOSAVE_SCRIPT + (pushScript ?? ""), ...(pushScript === null ? {} : { fetches: true }) } });
}

/** The phone setup for the server-rendered Settings page: the same choices as the React card. */
export function phoneSetupHtml(phone: BrowserPhoneCard): string {
  const [first, ...others] = phone.chatApps;
  return `<section class="card" id="phone" aria-labelledby="phone-card-title" data-phone-card><h2 id="phone-card-title">Use it from your phone</h2>` +
    `<p>${first === undefined ? "" : `<a href="${escape(first.href)}">Pair ${escape(first.label)}</a>`}${others.length === 0 ? "" : ` · or ${others.map(one => `<a href="${escape(one.href)}">${escape(one.label)}</a>`).join(", ")}`}</p>` +
    `<p class="meta" data-phone-tailnet>${phone.tailnet === null ? `Or install <a href="https://tailscale.com/download">Tailscale</a> on this computer and your phone, then reload this page for the address.`
      : phone.tailnet.restart === null ? `Or on your phone open <code>${escape(phone.tailnet.address)}</code> and sign in.`
      : `Or start Toolroll with <code>${escape(phone.tailnet.restart)}</code>, then on your phone open <code>${escape(phone.tailnet.address)}</code> and sign in.`}</p></section>`;
}

/** Every worker that is not retired: its capacity, and the tasks it holds now. */
export function settingsWorkers(store: Store, now: Date): NonNullable<BrowserSettingsView["workers"]> {
  const claims = store.liveClaims(null, now);
  return store.listRunners().filter(one => one.retiredAt === null).map(one => {
    const age = now.getTime() - new Date(one.heartbeatAt).getTime();
    const alive = runnerAlive(one, now);
    return {
      name: one.name,
      tone: alive ? "ok" as const : age < 60 * 60_000 ? "warn" as const : "off" as const,
      state: alive ? "Connected" : age < 60 * 60_000 ? `Quiet for ${Math.max(1, Math.round(age / 60_000))} min` : "Not connected",
      capacity: one.capacity,
      busy: store.liveClaimCount(one.name, now),
      running: claims.filter(claim => claim.runner === one.name).map(claim => ({
        taskId: claim.taskId,
        title: store.getTask(claim.taskId)?.title ?? claim.taskId,
        href: taskHref(claim.taskId),
        project: claim.repo === null ? null : projectName(claim.repo),
      })),
    };
  });
}

/** The page's workers section, for browsers without the app script. */
export function workersCard(workers: NonNullable<BrowserSettingsView["workers"]> | null): string {
  if (workers === null) return "";
  return `<section id="workers" aria-labelledby="workers-title"><h2 id="workers-title">Workers</h2>` +
    (workers.length === 0
      ? `<p class="meta">No worker is connected. Run <code>toolroll up</code> on the computer with your projects.</p>`
      : workers.map(one =>
          `<div class="card" data-worker="${escape(one.name)}"><p class="row"><strong>${escape(one.name)}</strong> <span class="meta">${escape(one.state)}</span>` +
          `<span class="right">${one.busy} of ${one.capacity} running</span></p>` +
          (one.running.length === 0
            ? `<p class="meta">Nothing running.</p>`
            : `<ul>${one.running.map(task => `<li><a href="${escape(task.href)}">${escape(task.title)}</a>${task.project === null ? "" : ` <span class="meta">${escape(task.project)}</span>`}</li>`).join("")}</ul>`) +
          `</div>`).join("") +
        `<p class="meta">To change how many a worker runs at once: <code>toolroll runner capacity &lt;name&gt; &lt;n&gt;</code></p>`) +
    `</section>`;
}

/** Settings → Updates, for browsers without the app script. */
export function updatesCard(updates: BrowserUpdates | null, csrf: string): string {
  if (updates === null) return "";
  const latest = updates.latest;
  return `<section id="updates" aria-labelledby="updates-title"><h2 id="updates-title">Updates</h2>` +
    `<p class="row">This version <span class="mono">${escape(updates.current)}</span> \u00b7 ${
      !updates.check.on ? "Update checks are off" : latest === null ? "Not checked yet" : latest.newer ? `Latest <span class="mono">${escape(latest.version)}</span>` : "Up to date"}</p>` +
    (latest !== null && latest.newer
      ? `<p>Update with <code>${escape(updates.updateCommand)}</code> \u00b7 <a href="${escape(latest.url)}">Release notes</a></p>` +
        (latest.notes === "" ? "" : `<details class="settings-more"><summary>What's new in ${escape(latest.version)}</summary><pre class="update-notes">${escape(latest.notes)}</pre></details>`)
      : "") +
    (updates.check.canManage && !updates.check.byEnv
      ? `<form method="post" action="/settings/updates/checks" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="check" value="${updates.check.on ? "off" : "on"}"><button type="submit">${updates.check.on ? "Turn off daily check" : "Turn on daily check"}</button></form>`
      : updates.check.byEnv ? `<p class="meta">Off by TOOLROLL_NO_UPDATE_CHECK.</p>` : "") +
    (updates.workers.length === 0 ? "" : `<ul>${updates.workers.map(one => `<li data-worker-version="${escape(one.name)}">${escape(one.name)} <span class="mono">${escape(one.version ?? "unknown")}</span>${one.older ? " \u00b7 older" : ""}</li>`).join("")}</ul>`) +
    `</section>`;
}

/** Choices save the moment they change; without the script the Save
 * button stays and the form works the same. */
export const SETTINGS_AUTOSAVE_SCRIPT = `(function(){document.querySelectorAll('form[data-autosave]').forEach(function(form){form.classList.add('js-autosave');form.addEventListener('change',function(ev){var t=ev.target;if(t&&(t.type==='radio'||t.tagName==='SELECT')){if(form.requestSubmit)form.requestSubmit();else form.submit();}});});})();`;

/** The newest release, remembered for a while so the page stays quick. */
export let latestSeen: { at: number; value: { version: string } | { problem: string } } | null = null;
export async function latestReleaseFor(latest: (() => Promise<{ version: string }>) | undefined): Promise<{ version: string } | { problem: string }> {
  if (latest === undefined && latestSeen !== null && Date.now() - latestSeen.at < ("problem" in latestSeen.value ? 60_000 : 900_000)) return latestSeen.value;
  let value: { version: string } | { problem: string };
  try { value = { version: (await (latest ?? latestVersionNow)()).version }; } catch (error) { value = { problem: (error as Error).message }; }
  if (latest === undefined) latestSeen = { at: Date.now(), value };
  return value;
}

/** Settings destinations under short headings: an icon and a name each, and a chat app's logo and state. */
export function settingsTiles(groups: BrowserSettingsGroup[]): string {
  return `<nav class="settings-tiles" aria-label="Settings sections">${groups.map(group =>
    `<section aria-label="${escape(group.title)}"><h2>${escape(group.title)}</h2><div>${group.tiles.map(tile =>
      `<a href="${escape(tile.href)}">${tile.brand === undefined ? strokeIcon(SETTINGS_TILE_ICONS.get(tile.href) ?? "") : brandIconHtml(tile.brand)}<span>${escape(tile.label)}${tile.status === undefined ? "" :
        `<span class="provider-status provider-status--${tile.status.tone}"><i aria-hidden="true"></i>${escape(tile.status.words)}</span>`}</span></a>`).join("")}</div></section>`).join("")}</nav>`;
}

/** Each destination once, in order: a group's heading, then its [href, label, icon] tiles. */
export const SETTINGS_GROUPS: [string, [string, string, string][]][] = [
  ["Agents", [
    ["/settings/lead", "Lead", `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>`],
    ["/settings/models", "Models", `<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>`],
    ["/settings/skills", "Skills", `<path d="m12 3 1.9 5.8L20 10l-5 3.6L16.8 20 12 16.4 7.2 20 9 13.6 4 10l6.1-1.2z"/>`],
    ["/settings/tools", "Tools", `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`],
    ["/settings/knowledge", "Knowledge", `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>`],
    ["/settings/learning", "Learning", `<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>`],
  ]],
  ["Automation", [
    ["/settings/flows", "Flows", `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4a3 3 0 0 1 3 3V14"/>`],
    ["/settings/integrations", "Integrations", `<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>`],
  ]],
  ["Chat apps", [
    ["/settings/telegram", "Telegram", ""],
    ["/settings/slack", "Slack", ""],
    ["/settings/discord", "Discord", ""],
    ["/settings/teams", "Teams", ""],
  ]],
  ["Access and rules", [
    ["/settings/sign-in", "Sign-in", `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`],
    ["/settings/sessions", "Sessions & tokens", `<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>`],
    ["/settings/project", "Project", `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`],
    ["/settings/policy", "Policy", `<path d="M9 12l2 2 4-4"/><rect x="4" y="3" width="16" height="18" rx="2"/>`],
    ["/settings/approval", "Approval rules", `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>`],
  ]],
  ["System", [
    ["/settings/monitoring", "Monitoring", `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`],
    ["/settings/retention", "Retention", `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`],
    ["/settings/storage", "Storage", `<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>`],
    ["/settings/updates", "Updates", `<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>`],
    ["/settings/backups", "Backups", `<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>`],
    ["/settings/data", "Data", `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`],
  ]],
];
export const SETTINGS_TILE_ICONS = new Map(SETTINGS_GROUPS.flatMap(([, tiles]) => tiles.map(([href, , icon]) => [href, icon] as const)));
export const CHAT_APP_TILES: Record<string, BrandIconId> = { "/settings/telegram": "telegram", "/settings/slack": "slack", "/settings/discord": "discord", "/settings/teams": "teams" };

/**
 * The settings groups, with each chat app's state from what the server already holds: not set up,
 * connected, or getting alerts (only when that service was chosen, or is the only one).
 * A Telegram bot whose saved delivery state reports a problem says so instead. With no config folder
 * the state is unknown, so the tiles carry none.
 */
export function settingsGroups(messaging: { channel: string | null; implicit: boolean; configured: string[] } | null, telegramFailing = false): BrowserSettingsGroup[] {
  return SETTINGS_GROUPS.map(([title, tiles]) => ({
    title,
    tiles: tiles.map(([href, label]) => {
      const app = CHAT_APP_TILES[href];
      if (app === undefined) return { href, label };
      if (messaging === null) return { href, label, brand: app };
      if (!messaging.configured.includes(app)) return { href, label, brand: app, status: { tone: "off" as const, words: "Not set up" } };
      if (app === "telegram" && telegramFailing) return { href, label, brand: app, status: { tone: "warn" as const, words: "Has a problem" } };
      return { href, label, brand: app, status: { tone: "ok" as const, words: messaging.channel === app && !messaging.implicit ? "Gets alerts" : "Connected" } };
    }),
  }));
}

/** Light, dark or the device's choice, one tap each. Per browser (a cookie). */
export function appearanceCard(csrf: string): string {
  if (csrf === "") return "";
  const pinned = requestContext.getStore()?.theme ?? null;
  const current = pinned ?? "system";
  const option = (value: string, label: string) =>
    `<button type="submit" name="theme" value="${value}" class="theme-choice" aria-pressed="${current === value}">${label}</button>`;
  return `<section class="appearance" aria-labelledby="appearance-title"><h2 id="appearance-title">Appearance</h2>` +
    `<form method="post" action="/settings/appearance" class="theme-switch"><input type="hidden" name="csrf" value="${escape(csrf)}">` +
    option("system", "Match device") + option("light", "Light") + option("dark", "Dark") +
    `</form><p class="meta">Saved in this browser.</p></section>`;
}

/**
 * The triage flow: everything waiting on a person, one card at a time.
 * Full context ON the card, the act inline, and every act lands back here
 * — clearing the queue is taps, not navigation. Read state travels in the
 * URL (the bounded skip cursor), never in the session: two tabs cannot
 * fight, and a shared link shows the same queue.
 */
export function nextPage(chrome: Chrome, data: {
  item:
    | { key: string; kind: "decision"; decision: Decision & { taskId: string } }
    | { key: string; kind: "approval"; approval: { taskId: string; title: string; goal: string; digest: string; proposedAt: string } }
    | { key: string; kind: "requeue"; stalled: { taskId: string; title: string; strikes: number; incidentCount: number } }
    | { key: string; kind: "gap"; gap: Gap }
    | null;
  scope: Scope | null;
  planDocument: string | null;
  planContract?: PlanContractView | null;
  approvalDigest: string | null;
  /** v34: said inside the ceremony when the yes buys a report, not a branch. */
  deliverable?: "branch" | "report";
  /** v48: the agents the yes freezes — the one block every ceremony shows. */
  route: RouteView | null;
  csrf: string;
  nonce: string;
  remaining: number;
  skipped: string[];
  now: Date;
}): Screen {
  const { item } = data;
  if (item === null) {
    const held = data.skipped.length;
    return screen("next", [
      `<h1>All clear</h1>`,
      held > 0
        ? `<p>Nothing left except the ${held} you set aside. <a href="/next">Look at those again</a>, or come back later.</p>`
        : `<p>Nothing needs you. The machine is either working or waiting on its own clocks.</p>`,
      `<p class="meta"><a href="/board">the board</a> shows what is moving · <a href="/inbox">the inbox</a> lists everything at once</p>`,
    ].join("\n"), { chrome });
  }

  const skipHref = `/next?skip=${encodeURIComponent([...data.skipped, item.key].join(","))}`;
  const header =
    `<p class="meta next-pager"><span>${data.remaining === 1 ? "the last thing waiting on you" : `1 of ${data.remaining} waiting on you`}</span>` +
    `<a class="skip" href="${skipHref}">not now — next \u2192</a></p>`;

  let card = "";
  if (item.kind === "decision") {
    const { decision } = item;
    card =
      `<h1>${escape(decision.taskId)} <span class="meta">asked ${whenTime(decision.createdAt)}</span></h1>` +
      `<div class="recap">${escape(decision.recap)}</div>` +
      `<div class="question">${escape(decision.question)}</div>` +
      decisionOptionForms(decision, data.csrf, "next");
  } else if (item.kind === "approval" && !consentDoorOf(data.scope, data.route).open) {
    const door = consentDoorOf(data.scope, data.route) as ConsentDoor & { open: false };
    card =
      `<h1>${escape(item.approval.taskId)}</h1>` +
      `<p>${escape(item.approval.title)}</p>` +
      consentClosedHtml(item.approval.taskId, door, "next") +
      `<p class="meta"><a href="${taskHref(item.approval.taskId)}">open the full task</a></p>`;
  } else if (item.kind === "approval") {
    const scope = data.scope;
    card =
      `<h1>${escape(item.approval.taskId)}</h1>` +
      `<p>${escape(item.approval.title)}</p>` +
      (data.planDocument === null
        ? ""
        : `<div class="card"><p><strong>The plan</strong> <span class="meta">drafted by a planning session</span></p>${executionPlanHtml(data.planDocument, true)}${planContractHtml(data.planContract ?? null, "ceremony")}</div>`) +
      `<form method="post" action="${taskHref(item.approval.taskId)}/approve" class="card approve-form">` +
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
      `<input type="hidden" name="nonce" value="${escape(data.nonce)}">` +
      `<input type="hidden" name="digest" value="${escape(data.approvalDigest ?? item.approval.digest)}">` +
      `<input type="hidden" name="return" value="next">` +
      `<p><strong>Approve exactly this:</strong></p>` +
      (data.deliverable === "report" ? `<p class="meta"><span class="badge">Scout</span> a read-only session investigates this goal and delivers a report — no branch, nothing changes in the repository</p>` : "") +
      (scope === null || scope.profileState !== "unresolved" ? "" : profileWords(scope)) +
      `<p class="meta">Goal</p><p class="recap" style="margin-top:0">${escape(scope?.goal ?? item.approval.goal)}</p>` +
      `<p class="meta">Not this</p><p class="recap" style="margin-top:0">${scope?.outOfScope == null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p>` +
      `<p class="meta">Touches · ${scope === null || scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p>` +
      (scope === null ? "" : acceptanceCeremonyHtml(scope.acceptance)) +
      // The AGENTS the yes freezes (v48): the same concise block the task
      // page and chat sign under, before the password — runtime limits one
      // tap away, never in the way.
      agentsCeremonyHtml(data.route) +
      (scope === null ? "" : runtimeDetailsHtml(scope)) +
      `<label>Your password, typed again — a signed-in session alone cannot agree to work<input type="password" name="token" autocomplete="current-password"></label>` +
      `<div class="sticky-actions"><button type="submit">Approve this scope</button></div>` +
      `</form>` +
      `<p class="meta"><a href="${taskHref(item.approval.taskId)}">open the full task</a> to edit the scope first</p>`;
  } else if (item.kind === "requeue") {
    card =
      `<h1>${escape(item.stalled.taskId)}</h1>` +
      `<p>${escape(item.stalled.title)}</p>` +
      `<p class="meta">Stopped — ${item.stalled.incidentCount} incident(s)${item.stalled.strikes > 0 ? ` after ${item.stalled.strikes} attempt(s)` : ""}</p>` +
      `<form method="post" action="${taskHref(item.stalled.taskId)}/requeue" class="card">` +
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
      `<input type="hidden" name="return" value="next">` +
      `<p class="meta">Requeue resolves the incidents, clears the failed attempts, and puts it back in line</p>` +
      `<button type="submit">Retry this work</button>` +
      `</form>` +
      `<p class="meta"><a href="${taskHref(item.stalled.taskId)}">open the full task</a> to read the runs first</p>`;
  } else {
    const { gap } = item;
    card =
      `<h1>Supply ${escape(gap.key)}</h1>` +
      `<p class="meta">${escape(gap.state)}</p>` +
      `<p>Filling this starts ${gap.unblocks.length} task(s): ${gap.unblocks.map(one => `<span class="mono">${escape(one)}</span>`).join(", ")}</p>` +
      `<div class="card"><p class="meta">Prove it filled from the terminal:</p><pre class="recap">${escape(gap.verify)}</pre></div>`;
  }

  return screen("next", [header, card].join("\n"), { chrome });
}

/**
 * A decision's answer forms — one source of truth for the decision screen
 * and the triage flow. The consequence reads BEFORE the button that buys
 * it; irreversible options arm behind one deliberate tap AND the server
 * independently requires the confirm field. `returnTo` is allow-listed by
 * the answer handler, never an arbitrary URL.
 */
export function decisionOptionForms(decision: Decision, csrf: string, returnTo: string | null): string {
  return decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation;
      const inner = [
        `<form class="option${recommended ? " recommended" : ""}" method="post" action="/d/${decision.id}/answer">`,
        `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
        `<input type="hidden" name="choice" value="${escape(option.id)}">`,
        ...(returnTo === null ? [] : [`<input type="hidden" name="return" value="${escape(returnTo)}">`]),
        ...(option.reversible ? [] : [`<input type="hidden" name="confirm" value="yes">`]),
        recommended ? `<p class="meta" style="margin:0 0 .375rem"><span class="badge">Recommended</span></p>` : "",
        `<p class="consequence">${escape(option.consequence)}</p>`,
        `<button type="submit">${escape(option.label)}${option.reversible ? "" : ` <span class="badge badge-overdue">Irreversible</span>`}</button>`,
        `<input type="text" name="note" placeholder="optional note — travels with this answer" aria-label="optional note">`,
        `</form>`,
      ].join("\n");
      return option.reversible
        ? inner
        : `<details class="arm-danger"><summary>${escape(option.label)} — irreversible, tap to arm</summary>${inner}</details>`;
    })
    .join("\n");
}

export function decisionPage(
  chrome: Chrome,
  decision: Decision,
  taskId: string,
  artifacts: Artifact[],
  who: Who,
  now: Date,
  returnTo: string | null = null,
): Screen {
  const csrf = who.via === "cookie" ? who.session.csrf : "";
  const options = decisionOptionForms(decision, csrf, returnTo);

  const answered =
    decision.state === "answered"
      ? `<div class="answered">Answered: <strong>${escape(decision.choice ?? "")}</strong> by ${escape(
          decision.answeredBy ?? "",
        )}${decision.note === null ? "" : ` — ${escape(decision.note)}`}</div>`
      : "";

  const evidence =
    artifacts.length === 0
      ? ""
      : `<div class="evidence"><strong>Evidence</strong>` +
        artifacts
          .map(
            artifact =>
              `<a href="/d/${decision.id}/evidence/${artifact.id}">${escape(evidenceWords(artifact.kind))}` +
              `${artifact.truncated ? " (truncated)" : ""} · ${artifact.bytesStored} bytes</a>`,
          )
          .join("\n") +
        "</div>";

  return screen(`decide \u00b7 ${taskId}`, [
    `<h1>${escape(taskId)} <span class="badge badge-${escape(decision.state)}">${escape(decision.state)}</span>${
      isOverdue(decision, now) ? ` <span class="badge badge-overdue">Overdue</span>` : ""
    }${decision.deadline === null ? "" : ` <span class="meta">deadline ${escape(decision.deadline)}</span>`}</h1>`,
    `<div class="recap">${escape(decision.recap)}</div>`,
    `<div class="question">${escape(decision.question)}</div>`,
    decision.state === "answered" ? answered : options,
    evidence,
    `<p class="meta"><a href="${returnTo === null ? "/" : escape(returnTo)}">← ${returnTo === null ? "everything waiting" : "back to the task chat"}</a></p>`,
  ].join("\n"), { chrome });
}

export function taskOf(store: Store, decision: Decision): string {
  const run = store.getRun(decision.run);
  return run === null ? "?" : store.externalIdFor(run.taskRef) ?? "?";
}

// ---- request plumbing ------------------------------------------------------

export async function form(request: IncomingMessage, cap = BODY_CAP): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** One display line, bounded — turn text is data, never layout. */
export function oneLineOf(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}
  // v100: sign-in with the identity provider. A visit waits for the provider (15 minutes); a hand-off
  // carries the proved person from the callback (reached from the provider's site, so without the
  // Strict session cookie) to /login/sso/finish on this site (a minute).
  export type SsoIntent = "sign-in" | "reauth" | "link";
  /** Live replies (chat streaming): per thread, the turn being answered —
   * each step's tools in plain words and its text as it is written. Memory
   * only and display only; the saved turn stays the record. */
  export type LiveTurn = { steps: LeadLiveStep[]; done: boolean; ok: boolean; listeners: Set<() => void>; expiry?: NodeJS.Timeout };

  export type ChatEnablement =
    | { ok: true; billing: "metered"; config: ChatConfig & { provider: DirectChatProviderId }; key: string; keySource: "environment" | "stored"; price: import("../converse.js").ModelPrice; credentialKey: string }
    | { ok: true; billing: "subscription"; config: ChatConfig & { provider: SubscriptionChatProviderId }; key: null; keySource: null; price: null; credentialKey: string }
    | { ok: false; code: "demo" | "unscoped" | "roots" | "unresolved" | "empty" | "unconfigured" | "unpriced" | "no-key"; why: string };

  export type PeekAdmission = {
    run: Run;
    /** The run's checkout, PROVEN non-null by the guards: a reviewer run
     * (v29, artifact-only) is refused before admission ever forms. */
    worktree: string;
    epoch: string;
    entries: ReturnType<typeof parseBaseTreeSnapshot>;
  };