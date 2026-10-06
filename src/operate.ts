import { UNSENT_REPLY_MS } from "./telegram-settings.js";
import { leadNameOf } from "./lead-identity.js";
import { maybeTriggerRepair } from "./dispose.js";
import { CHECK_LEVEL_HINTS, CHECK_LEVEL_WORDS, isCheckLevel, liveQuickCommand, projectCheckLevel, quickVerifyKey, setProjectCheckLevel, setTaskCheckLevel, suggestQuickCommand } from "./check-levels.js";
import { fileAddTestsTask, followUpChecksOf, requestFollowUpChecks, runFollowUpCheck, runWaitingChecks } from "./result-follow-ups.js";
import { runBatchChecks } from "./batch-checks.js";
import { BATCH_HINT, BATCH_WINDOW_MS, projectBatchChecks, setProjectBatchChecks } from "./batch-policy.js";
import { buildReviewPass } from "./build-review.js";
import { buildReviewLines, buildReviewOf } from "./review-switch.js";
import { parseProtectedPaths } from "./approval-policy.js";
import { rulesSummary } from "./approval-rules-ui.js";
import { evidencePack, exportDay, ledgerExportChunks, standaloneEvidenceHtml, type LedgerExport } from "./evidence-pack.js";
import { matchesOutsideCheckpoint } from "./ledger-chain.js";
import { CLEANUP_CHOICES, bytesWords, cleanupWords, diskBytes, parseCleanup, storageReport } from "./storage.js";
import { removeStaleTestTemp, tempRoots, testTempFolders } from "./test-temp.js";
import { dailyStorageSweep, lastSweep, nextSweepAt, saveSweep, storageSweepOff as storageSweepOffNow, sweepDetails, sweepWords as storageSweepWords, type SweepPart, type SweepRecord } from "./storage-sweep.js";
import { removeShared, sharedDepsRoot, sharedUse, unusedShared, type SharedUse } from "./shared-deps.js";
import { checkoutPlan, cleanCheckouts, discardCheckout, finishedCheckouts, slimKeptCheckouts, whyWords, type CheckoutItem, type CheckoutPlan } from "./checkout-cleanup.js";
import { closeOutCheckouts, closeOutRuns, stoppedWords } from "./run-closeout.js";
import { MIN_DAYS, RETENTION_KINDS, countWords, dailyRetention, isRetentionKind, lastSweepAt, parsePeriod, periodLabel, periodWords, retentionPlan, sweepWords, type RetentionKind, type RetentionSweep } from "./retention.js";
import { checkPolicy, parseList, policyParts, type SavedPolicy } from "./policy.js";
import { billingOf, budgetHoldWords, budgetLabel, budgetStates, monthNamed, monthOf, spendItems, teammateNames, usd as spendUsd, type BudgetAgent, type BudgetHold } from "./spend.js";
import { spendCsv } from "./spend-ui.js";
import { buildExport, exportSummary, exportZip, writeExportFolder } from "./export.js";
import { startBudgetAlerts } from "./budget-alerts.js";
import { liftAuthPause, openAuthPauses, signInGate, signInWords, startSignInProbes, type SignInGate } from "./provider-auth.js";
import { createConnectionChecker } from "./provider-connection.js";
import { checkIntegrations, integrationsBrokenLine, integrationsNow, renderIntegrations, type Integration, type IntegrationIo } from "./integrations.js";
import { buildHandoff, handoffLines, loginAccount, runOnboard, type HandoffLogin, type OnboardIo } from "./agent-onboard.js";
import { backupFiles, backupFolderOf, backupOwner, backupNow, restoreDatabase, startBackups } from "./backup.js";
import { pushLimitSink } from "./provider-limits.js";
import { heuristicSizing, installFilingSizer, ownerSizer, refineFiledSizing, settleSizings, type Sizer } from "./task-sizing.js";
import { tierLines, tierReport } from "./tier-report.js";
import { limitsView } from "./limits-ui.js";
import { startCodexLimits } from "./codex-limits.js";
import { packageVersion, startMonitoring, targetOf } from "./monitoring.js";
import { origin, readMonitoring } from "./monitoring-settings.js";
import { logEvent } from "./log.js";
import type { FlowAdvance } from "./flow-engine.js";
import { FLOW_EVERY_MS, flowHousekeeping, moveCards, moveCardsAfter, type FlowIo } from "./flow-cadence.js";
import { readHooksBase, type TriggerIo } from "./flow-triggers.js";
import { sendTeammateSummaries } from "./teammate-admin.js";
import { runRequestedUndos, sendTeammateWeeklies } from "./teammate-week.js";
import { refreshConnections } from "./mcp-connect.js";
import type { StepIo } from "./flow-steps.js";
import {followDiscord} from "./discord.js";
import { followTeams } from "./teams.js";
import {loadDiscordCredentials} from "./discord-api.js";
import { loadSlackCredentials } from "./slack-api.js";
import { followSlack } from "./slack.js";
import { validateScopeText } from "./task-text.js";
import { runMemoryCommand } from "./memory-cli.js";
import { runKnowledgeApply, runKnowledgeCommand } from "./knowledge-cli.js";
import { FLOWS_VALUE_FLAGS, runFlowsCommand } from "./flows-cli.js";
import type { FetchLike } from "./flow-share.js";
import { runAssignmentCommand } from "./assignment-adapters.js";
import { applyProjectProfile, runProjectCommand } from "./project-cli.js";
import { pullRequestLines, runTaskMergeCommand, runTaskOutcomeCommand } from "./task-outcome-cli.js";
import { taskReviewBrief, renderReviewBrief } from "./task-review-brief.js";
/**
 * The commands that actually move work: authoring tasks, and the claim loop.
 *
 * These are written for an agent first and a person second, because the agent
 * is the one that will run them ten thousand times unattended. Four rules fall
 * out of that, and they are worth stating because each one has a failure it
 * prevents.
 *
 * **Every outcome is data.** `--json` returns the same envelope from every
 * command — `{ ok, command, ... }` — including failures. An agent that has to
 * regex stderr to find out what happened will eventually match the wrong line
 * and act on it.
 *
 * **Exit codes separate "no" from "broken".** Losing a claim race is a correct
 * answer, not an error; so is asking for the ready set and finding it empty. If
 * those exited non-zero alongside real failures, every caller would either stop
 * on a normal outcome or ignore genuine breakage. So: 0 got it, 3 ran fine and
 * the answer is no, 2 you typed it wrong, 1 something broke.
 *
 * **Every mutation takes `--key`.** An agent whose command succeeded but whose
 * output was lost will retry. Without a key that retry is a second, different
 * mutation — a second lease, a second task. With one it is the same answer
 * handed back. This is the single most important flag here.
 *
 * **Nothing ever prompts.** There is no terminal on the other end at 3am.
 */

import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { releaseStalledUpdate, waitingUpdate } from "./toolroll-update.js";
import {
  openStore,
  openStoreNoMigrate,
  CONCURRENT_WRITER_WAIT_MS,
  isDatabaseBusy,
  databasePath,
  BUILT_IN,
  DEFAULT_ACTOR,
  parseCapabilityKey,
  verifiedAuthor,
  contestantProfileOf,
  isDigestTime,
  RESULT_SCREENSHOTS,
  type ResultScreenshots,
  type Capability,
  type ReviewRetryState,
  type Store,
  type TaskState,
} from "./store.js";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { authorizePlanUnderMode } from "./plan-auto.js";
import { ghDispatchAdapter, mirrorTaskId, syncPass, type DispatchAdapter } from "./sync.js";
import { sweepLiveLogs } from "./live.js";
import { configPath, addRepos, removeRepos, updateRepos, loadRepos, loadProjectRegistry, updateProjectRegistry } from "./repos.js";
import { deleteProject, holdingsWords, projectHoldings, projectRunning } from "./project-delete.js";
import { pushPass } from "./push.js";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, writeFileSync, mkdirSync } from "node:fs";
import { BRANCH_PREFIX, envTwins, envValue, existingOrFirst, namedPath, taskBranches } from "./names.js";
import { claimActor, currentActor, parseLeadToken, withActor, type Actor } from "./actor.js";
import { admissionRecorded, admitProject, commandLineActor } from "./project-admission.js";
import { leadClaim, leadSay, noteLeadWork } from "./lead-voice.js";
import { createServer as createNetServer } from "node:net";
import { spawn as spawnChild } from "node:child_process";
// Every envelope is checked against its command's schema (logged, never refused), then serialized unchanged.
import { checkedEnvelopeJson as envelopeJson } from "./contracts/cli.js";
import { hasDisguisedText, hasForbiddenControls, validateNote } from "./decision.js";
import { readVerifiedArtifact, readVerifiedReport, storeEvidence } from "./evidence.js";
import { contractChangesOf, decodePlanContractRecord, describeContractChanges, encodePlannerSource, plannerSourceOf } from "./planner-source.js";

/**
 * The drafted plan's contract standing, in terminal lines (contract
 * handoff, task 1): preserved exactly, amended (every change and the
 * planner's reason), or drafted with nothing filed — the same facts the
 * task page and approval ceremony show, so a yes at a terminal reads the
 * amendment too. Nothing when no draft record exists.
 */
function planContractLines(store: Store, evidenceRoot: string, taskId: string): string[] {
  const ref = store.lookupRef(taskId);
  if (ref === null || ref.plan !== "drafted") return [];
  const artifact = store.latestPlanContractArtifact(ref.id);
  if (artifact === null) return [];
  let record: ReturnType<typeof decodePlanContractRecord>;
  try {
    const verified = readVerifiedArtifact(evidenceRoot, artifact);
    if (!verified.ok) return [`  filed contract: record does not verify — ${verified.problem} (run ${artifact.run})`];
    record = decodePlanContractRecord(verified.content);
  } catch {
    return [`  filed contract: record could not be read (run ${artifact.run})`];
  }
  if (record === null) return [`  filed contract: record is not the JSON it was sealed as (run ${artifact.run})`];
  const scope = store.getScope(taskId);
  const stale = scope !== null && contractChangesOf(record.proposed, scope).length > 0 ? " (the scope was edited after this draft)" : "";
  if (record.filed === null) return [`  filed contract: none — the planner drafted every term from the title and repository${stale}`];
  if (record.changes.length === 0) return [`  filed contract: preserved exactly by the plan — approval binds the terms you filed${stale}`];
  return [
    `  filed contract: AMENDED by the plan — ${record.changes.length} change${record.changes.length === 1 ? "" : "s"}; approval binds the amended terms${stale}`,
    `    why: ${record.amendment ?? "(the planner stated no reason)"}`,
    ...describeContractChanges(record.changes).map(line => `    ${line}`),
  ];
}
import { verdictWords as proofVerdictWords, matrixWords, semanticCoverage, coverageWords } from "./proof.js";
import { probeRepo, isVerified } from "./probe.js";
import {
  diagnoseTaskDispatch,
  diagnosisIsDispatchable,
  scopeApprovedForDispatch,
} from "./dispatch.js";

import { createDecisionServer } from "./serve.js";
import { readTailnetNames } from "./tailnet.js";
import {
  daemonLaunchCommand,
  daemonStatus,
  installReplacingLegacy,
  installedLegacyDaemon,
  planDaemon,
  uninstallDaemon,
  type SupervisorRunner,
  awaitFreshHeartbeat,
} from "./daemon.js";
import {
  bridgePass,
  clearBotToken,
  createTransport,
  followBridge,
  hashPairingCode,
  loadBotToken,
  mintPairingCode,
  networkFence,
  networkFenceLine,
  redactToken,
  saveBotToken,
  PAIRING_TTL_MS,
  TOKEN_ENV,
  telegramHookSecret,
  telegramPushUrl,
  type FollowReport,
  type TelegramTransport,
} from "./telegram.js";
import type { TelegramConversationOptions } from "./telegram-mate.js";
import { scanRepo } from "./capscan.js";
import { computeGaps, describeCapability, type Gap } from "./gaps.js";
import { ask, askHidden, confirm, interactive, underAgent } from "./prompt.js";
import { runMateCli, answerContextLines, type MateCliSeams } from "./mate-cli.js";
import { confirmCoordinatorProposal, dismissCoordinatorProposal } from "./mate-doors.js";
import { verifyApproverByPassword } from "./principal.js";
import { authorizedProject, canonicalProject, projectName, resolveCeiling } from "./project.js";
import { tally, spendLine } from "./summary.js";
import {
  bodyHashOf,
  describePublicationGrant,
  observeChecks,
  publicationBody,
  publishPass,
  type PublishExec,
  sweepMerges,
} from "./publish.js";
import { checkPublishing, publishingOf, savePublishing, followPullRequests, newestPullRequestOf } from "./pull-request-flow.js";
import { starterOf, startersFor, switchOnStarter } from "./flow-starters.js";

type CapabilityKind = Capability["kind"];
import {
  acquire,
  acquireFallback,
  acquireIfReady,
  completeFenced,
  finalizeFailureFenced,
  finalizeMalformedFenced,
  finalizeParkFenced,
  finalizePlanFenced,
  finalizePlanFailureFenced,
  finalizeScoutFenced,
  finalizeScoutFailureFenced,
  type FailureClass,
  heartbeat,
  release,
  reap,
  currentClaim,
  DEFAULT_LEASE_MS,
  SYNC_MAX_AGE_MS,
  acquireContinuation,
} from "./claim.js";
import { disposeBuildOutcome, holdStaleApproval, regateTask } from "./dispose.js";
import { attendedLivenessState } from "./liveness.js";
import { HeldSessionCoordinator, sweepHeldOrphans } from "./held.js";
import {
  proposeGrant,
  describeGrant,
  describeWithheld,
  permits,
  MUTATION_CLASSES,
  DEFAULT_MUTATIONS,
  type MutationClass,
} from "./grant.js";
import { builtIn, guarded, type GraphBackend } from "./backend.js";
import {
  register,
  authenticate,
  heartbeat as heartbeatRunner,
  isAlive,
  recoverDead,
  recoveredAnything,
  acquireWatchLeaseAuthed,
  heartbeatWatchLeaseAuthed,
  addRunnerReposAuthed,
  removeRunnerRepoAuthed,
  registerRunnerIfIdle,
  retireRunnerIfCurrent,
  normalizeRunnerName,
  validRunnerName,
  canonicalRepos,
  RUNNER_NAME_MAX,
  RUNNER_CAPACITY_MAX,
  parseRunnerCapacity,
} from "./runner.js";
import { mintCoordinator, revokeCoordinator, listCoordinators } from "./coordinator.js";
import { serveMcp } from "./mcp.js";
import { createInterface } from "node:readline";
import { propose, approve, addApprover, authenticateAccount, authenticateApprover, describeScope, approvalOf, hashToken as hashApproverToken, profileFromJson, fileAndSealUnderMode, type ExecutionProfile, modeFilingCoverage, acceptanceLinesToInput, parseAcceptanceCriteria, splitAcceptanceRubric, rubricIsPlaceholder, isCommitSha } from "./scope.js";
import { presetTerms, modeTermsJson, modeDigestOf, modeTermsFromJson, modeWords, MODE_MAX_DAYS, type ModeName } from "./modes.js";
import { WorktreePool } from "./worktree.js";
import { requestTaskStop, resumeTaskStop, taskControlOf } from "./task-control.js";
import { worktreeAdoptionNotice } from "./worktree-notices.js";
import { workIndexPage, WorkIndexCursorError } from "./work-index.js";
import { parseWorkView } from "./workspace-ui.js";
import { taskWorkSummaryOf } from "./work-summary.js";
import { assignmentOf, assignmentBrief, syncAssignmentHandoffs } from "./assignment.js";
import {
  approveRoutine,
  describeRoutine,
  fireRoutine,
  refreshRoutineAgents,
  routineAgentsState,
  routineDigestOf,
  validateRoutineTerms,
  ROUTINE_NAME,
  type RoutineTerms,
} from "./routine.js";
import { fileTaskProposal, fileRoutineProposal, validateTaskText } from "./proposal.js";
import { TEMPLATES, templateByName } from "./templates.js";
import { planTournament, planComparison, contestNoun, jointApprovalDigest, admitContest, crossReadyBarrier, finalizeContestant, recoverContests, maybeAggregate as contestMaybeAggregate, sweepContestCleanup, escalateOverdueContests } from "./contest.js";
import { isDirectChatProvider, isSubscriptionChatProvider, priceOf, PRICED_MODELS } from "./converse.js";
import { resolvePhaseAgent, resolveScopeProfile, resolveScopeChain, resolveRouteCandidates, routeOfTask, INSTALLATION_SCOPE, type TaskRoute } from "./agentconfig.js";
import { isRiskLevel, isTaskSize, legOf, projectRoute, riskConsequence, routeDigestOf, routeWords, RISK_LEVELS, TASK_SIZES, PHASES as ROUTE_PHASES, type TaskSize, type ReadinessLookup, type ReadinessObservation, type RiskLevel, type RouteOverride, type RouteStamp } from "./phase-routing.js";
import { observeProviderReadiness, reportProviderReadinessAuthed } from "./runner.js";
import { parseDemoUrl, projectDemoUrl, saveProjectDemo } from "./project-demo.js";
import { effectiveConcurrency, maySlotTake, parseProjectConcurrency, PROJECT_CONCURRENCY_DEFAULT, ProjectPasses, projectConcurrency, saveProjectConcurrency, savedProjectConcurrency, type SlotFacts } from "./project-concurrency.js";
import { clearWebhook, effectivePrimary, isMessagingChannel, loadConsoleUrl, loadPrimary, loadWebhookTargets, phoneOrigin, saveConsoleUrl, savePrimary, saveWebhook, webhookPass, SLACK_ENV, DISCORD_ENV } from "./webhooks.js";
import { auditOf, inspectionOf, isProviderId, MONEY_CAPABILITIES, PROVIDER_IDS, validModelId, validateSpec, type ProviderAudit, type ProviderId, ALL_CREDENTIAL_ENV } from "./provider.js";
import { attestProvider, attestationOf, versionInRange, type AttestOutcome, type AttestationRange } from "./attest.js";
import { recognizesEligible } from "./exhaustion.js";
import {
  build,
  proveApprovedProfile,
  type Runner as CommandRunner,
} from "./builder.js";
import { plan as planTask } from "./planner.js";
import { attachTmux, elapsedWords, openInTmux, PEEK_TAIL_LINES, runPeek, snapshotLiveRuns } from "./peek-cli.js";
import { scout as scoutTask } from "./scout.js";
import { profileDigestOf, chainDigestOf, entryDigestOf } from "./scope.js";
import { PROVIDER_KEY_ENV, SUBSCRIPTION_CAPABLE, clearProviderKey, keyStatus, readAuthMode, readAuthModeStrict, readProviderKey, saveProviderKey, setAuthMode, verifyProviderKey, verdictWords, type AuthMode } from "./keys.js";
import { run, terminateLiveProviders, run as execRun } from "./exec.js";
import { containmentNotice, containmentStatus, currentContainment, describeContainment, resolveContainment, type EffectiveContainment } from "./containment.js";
import { readPulls } from "./pulls.js";
import { startMaintenance } from "./maintenance.js";
import { livePin, modelWatchPass } from "./model-catalog.js";
import { runModelsCommand } from "./models-cli.js";
import { updateAdmissionPaused, UPDATE_PAUSED } from "./desktop-update-gate.js";
import { beads } from "./beads.js";
import { githubIssues } from "./issues.js";
import { installationStatus, renderInstallationStatus, renderTaskWait, repairStaleStatuses, taskWaitSnapshot } from "./lead-status.js";
import { latestRelease, newerRelease, notifySecurityRelease, notifyVersionLive, recordRunnerVersion, startUpdateChecks, updateLine, type ReleaseIo } from "./releases.js";
import { installMethod } from "./install-method.js";
import { PACKAGE_VERSION } from "./version.js";

export type Write = (line: string) => void;

/**
 * 0 done · 1 broke · 2 bad usage · 3 ran fine, the answer is no.
 *
 * 3 is the one that matters. `toolroll claim` losing a race and
 * `toolroll claim` failing to open the database must not look the same to a
 * caller deciding whether to try the next task or wake somebody up.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

export type OperateOptions = {
  /** Native-shell proof key, passed in memory rather than command-line arguments. */
  desktopIdentity?: string;
  /** A desktop service directory is state, never an implicitly enrolled project. */
  inferProjectFromCwd?: boolean;
  /** Exact additions approved by the native project picker, independent of the enrollment registry. */
  additionalProjectRepos?: () => readonly string[];
  /** Overridden by tests and by an agent that wants its own queue. */
  databaseFile?: string;
  /** Injected by tests: how `status` and the console ask for the latest release. */
  releaseIo?: ReleaseIo;
  /** Injected by tests: the bin whose real path says how Toolroll was installed. */
  installBin?: string;
  /** Injected by tests: where `storage` looks for leftover test temp folders (default: the temp folder and /tmp). */
  tempRoots?: readonly string[];
  openDatabase?: (file: string) => Store;
  now?: Date;
  /**
   * Injected by tests: the processes `tick` and `build` run. The agent runner
   * is what spends money, so a test that forgets to stub it fails loudly on a
   * missing `claude` binary rather than quietly building something.
   */
  agentRunner?: CommandRunner;
  gitRunner?: CommandRunner;
  /** Injected by tests: the Telegram Bot API. Production dials the real one. */
  telegramTransport?: TelegramTransport;
  /** Injected by tests: the environment checked for a fenced network before Telegram is reached (default: this process's, with the real transport). */
  telegramEnv?: Record<string, string | undefined>;
  publishExec?: PublishExec;
  /** Injected by tests: the stop fence a watch would set. */
  shouldStop?: () => boolean;
  /** Injected by tests: the external-dispatch gh surface. */
  dispatchAdapter?: DispatchAdapter;
  /** Injected by tests: how flow triggers reach GitHub (gh) and Linear (fetch), and where their secrets live. */
  flowTriggerIo?: Partial<TriggerIo>;
  /** Injected by tests: how flow check and update steps run commands and reach GitHub and Linear. */
  flowStepIo?: Partial<StepIo>;
  /** Injected by tests: how often a worker's flow passes run beside its builds (default FLOW_EVERY_MS). */
  flowEveryMs?: number;
  /** Injected by tests: how `flows import` fetches a flow file's address. */
  flowFetch?: FetchLike;
  /** Injected by tests: how `integrations` checks reach services (fetch, gh, sign-in checks, mail servers). */
  integrationIo?: Partial<IntegrationIo>;
  /** Injected by tests: the mate's provider fetch, key environment, and stdin lines. */
  mateSeams?: MateCliSeams;
  /** Injected by tests: a held-session coordinator, so a `tick` exercises
   * the attended road exactly as a co-located `up` would (production wires
   * one only inside `up`). */
  heldCoordinator?: import("./held.js").HeldSessionCoordinator;
  /** Test seam for the short indexed wait loop. */
  waitSleep?: (milliseconds: number) => Promise<void>;
  /** Injected by tests: `onboard`'s home folder, terminal and probes. */
  onboardSeams?: OnboardSeams;
  /** Injected by tests: whether `up` has a person at a terminal, and how it opens a browser. */
  upSeams?: { terminal?: boolean; env?: Record<string, string | undefined>; openBrowser?: (url: string) => void };
  /** Injected by tests: the classifier that sizes filed tasks (none by default under test). */
  filingSizer?: Sizer;
};

export type OnboardSeams = Partial<Pick<OnboardIo, "home" | "env" | "cwd" | "interactive" | "confirm" | "findRepo" | "checkConnection" | "pullRequests">>;

const STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

export const OPERATE_HELP = `toolroll — operating the queue

  toolroll status                    running, queued, ready results, release check and plan windows
  toolroll ready                     what could be dispatched right now
  toolroll task add <title>          queue work (--replaces <id>: it replaces that task, which reads "Replaced by"; --checks quick|full|off overrides the project's checks)
  toolroll lead token                mint the lead's credential for you (your password; --revoke ends it);
                                        the lead passes it as --token, or TOOLROLL_LEAD_TOKEN, and its work pings nobody
  toolroll task ask <id> --person <name> --why "<text>"
                                        hand a task to a person: it pings them, and it is theirs
  toolroll task list [--view <v>] [--limit <n>] [--cursor <c>]   paginated saved task status
  toolroll task show <id>
  toolroll task wait <id> [--timeout <seconds>]
                                        wait for this attempt to finish or need a person
  toolroll project use <path>        remember a saved project (optional --token-file)
  toolroll project show              show the current project and credential reference
  toolroll project rules --repo <p>  a project's approval rules; an instance operator changes them with
                                        --not-requester on|off, --protect none|project, --protect-paths "a/**,b/**"
  toolroll project concurrency [<n>] --repo <p>
                                        how many of a project's tasks build at once (default 2, never past the
                                        worker's capacity); an approver changes it with <n>
  toolroll project demo [<url>|off] --repo <p>
                                        the project's own demo or dev server, the one non-public address a
                                        report's scout may screenshot
  toolroll task evidence <id>        the task's evidence pack as JSON (--html for a printable page; --out <file>)
  toolroll storage                   where the disk goes: database, build checkouts, releases, evidence, leftover test temp folders
  toolroll storage clean [--yes]     preview removing finished tasks' clean checkouts (their branches stay) and test temp folders older than a day; --yes removes them
  toolroll storage cleanup <when>    remove a finished task's clean checkout: finished|2d|7d|never (instance operator)
  toolroll storage discard <path> --yes   throw away a checkout kept for its changes; its branch stays
  toolroll integrations [--json]     which integrations work: Connected, Not set up or Broken, and what to do (--saved: no new checks)
  toolroll monitoring                where the audit stream and traces go, and how each destination is doing
  toolroll check-progress <run>      current or final approved check progress
  toolroll spend [--month YYYY-MM] [--csv]   what agent work cost, by project, person, teammate and model
  toolroll export --out <path> [--zip]   everything Toolroll knows, in a folder or .zip (no secrets)
  toolroll budget list|set|remove    monthly budgets (--all | --project <p> | --person <name> | --teammate <id>) --usd <n> [--alerts-only]
  toolroll notifications [quiet|all]   how chats reach you: only when you're needed (the default), or every step
  toolroll notifications digest <HH:MM>|off   one evening message: what finished, what waits, what failed
  toolroll notifications mute|unmute --repo <p>   no pings for a project; the console and digest keep it
  toolroll notifications screenshots off|first|all   a result's saved screenshots with its chat message: none, the first one, or up to 4
  toolroll retention show|preview    how long evidence, checkout records, chat and notifications are kept; what the daily sweep would remove
  toolroll retention set <kind> <period>   evidence|checkouts|chat|notifications, 1d|30d|1y|forever (instance operator)
  toolroll backup now|list          back the database up now; list backups and how the last ones went
  toolroll restore <file> [--dry-run]  put a backup back (Toolroll stopped; the current database is kept)
  toolroll review show|on|off --repo <path>  one automatic review of each finished build; only HIGH findings send it back
  toolroll task review <id> --brief   compact saved result, checks and findings; --run <id>, --all, --json
  toolroll policy show|set          the organisation policy; an instance operator sets it with --providers claude,codex|any,
                                        --models <m,…>|any, --tools <t,…>|any, --ceiling safe|standard|escalated
  toolroll ledger verify             check the action ledger's hash chain (--checkpoint <n:hash> to compare a copied head)
  toolroll ledger checkpoint         record the chain's head to copy off this machine (instance operator)
  toolroll ledger export --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--out <file>]
                                        every sealed entry in the range, with an evidence pack per task
  toolroll task complete <id>        mark the current result complete (--digest for JSON/agents);
      [--pull-request]                  --pull-request also opens its pull request
  toolroll task merge <id> --as <you> --token <t>
                                        merge the task's pull request once checks pass
      [--anyway]                        merge without waiting for the full check
  toolroll task checks <id> [--level quick|full]
                                        run checks on the result's exact commit now
  toolroll task add-tests <id>       file a small task to write tests for that change
  toolroll task revise <id> --feedback "requested change"
  toolroll assignment show <task>    root, current work and exact handoff
  toolroll assignment updates        durable updates (--after <cursor>)
  toolroll assignment brief          catch up from the local database
  toolroll assignment inbox --consumer <name>  receive saved status changes
  toolroll assignment ack --consumer <name> --batch <id>  acknowledge delivery
  toolroll assignment claim <task>   record your lead ownership
  toolroll assignment check <task> --digest <receipt>
      claim/check use --token-env NAME or --token-file PATH for a coordinator;
      checking a receipt never approves work, accepts proof or deploys it
  toolroll task state <id> <state> [--reason <text>]   queued|running|done|failed|cancelled
      [--replaced-by <id>]              cancelled because <id> replaces it: it reads "Replaced by <id>"
  toolroll task block <id> --on <id> <id> waits for <on>
  toolroll task unblock <id> --on <id>  stop waiting for <on>
  toolroll task next <id> [--undo]   move it to the front of ITS
                                        queue (scheduling only — approval
                                        is still required); --undo puts it
                                        back in filing order
  toolroll task steer <id> --note "..."
                                        guidance for the next attempt — it
                                        reads the note before starting; a
                                        running agent is not interrupted
  toolroll task assign <id> --runner <name> | --anyone
                                        reserve it for one worker (it joins
                                        the back of that worker's queue) or
                                        return it to the shared queue
  toolroll task reopen <id> --as <you> --token <t>
                                        resume external work its tracker
                                        closed and has been SEEN open again

External trackers — build what a tracker nominates, under local approvals
  toolroll enroll <repo> --backend github-issues --github <owner/name>
      --allow-dispatch [--selector ours|all] --yes
                                        the dispatch grant: its own explicit
                                        yes, never in any default; writes a
                                        plane marker label to the repository
  toolroll publish setup [--repo <path>] [--merge-method squash|merge|rebase]
      [--merge-when-green] --yes      one-step pull requests: checks gh sign-in
                                        and push rights, then Complete offers
                                        "Complete and open a pull request"
  toolroll publish grant --github <owner/name> --allow-merge
      --merge-method squash|merge|rebase [--merge-delete-branch] --yes
                                        auto-merge this plane's own PRs —
                                        ONLY after CI was OBSERVED green on
                                        the exact head commit; drafts,
                                        merge queues, and unreadable
                                        protection refuse, typed and paged
  toolroll publish unblock <pr> --as <you> --token <t>
                                        lift a repair's merge hold
  toolroll publish rearm <pr> --as <you> --token <t>
                                        re-arm a refused merge after you
                                        fixed the named cause
  toolroll sync [--repo <path>]      pull nominated work in as ordinary
                                        local tasks (titles only, validated;
                                        bodies never), refresh every mirror
                                        INDIVIDUALLY, verify the marker, and
                                        deliver write-backs — zero tokens,
                                        fail closed; runs with reconcile and
                                        under watch automatically
  toolroll task hold <id> --reason <why> [--until <iso>]
  toolroll task unhold <id>

  toolroll approver add <name> [--password <p>]
                                        mint the credential that lets a
                                        person say yes; the bootstrap for
                                        every approving act
  toolroll approver list
  toolroll task scope <id> --goal <what success is>
      [--not <text>] [--touches a,b] [--budget-usd <n>]
      [--race provider:model[,provider:model…]] [--race-count 2..4]
      [--race-per-usd <n>] [--race-total-usd <n>]
      [--compare provider:model[,provider:model…]]  (labeled comparison — no dollar caps; needs a lane no budget can bound)
                                        a tournament races 2-4 agents on the
                                        task; you compare and pick one
  toolroll task approve <id>         the yes — interactive, or
      --yes --digest <d> --as <you> --token <t> for scripts; a tournament
      approves both documents with one yes, on the joint fingerprint
  toolroll task requeue <id> --as <you> --token <t>
                                        exit a stall: incidents resolved,
                                        strikes cleared, queued again
  toolroll task regate <id> --as <you> --token <t>
                                        run the approved check again on the
                                        last attempt's exact commit — a new
                                        attempt, no agent, saved result
  toolroll config set budgets [--build-usd <n>] [--race-per-usd <n>]
      [--race-total-usd <n>] [--race-agents 2..4] --as <you> --token <t>
                                        spend defaults new filings pre-fill
                                        from; config clear budgets resets

  toolroll claim <id> --runner <name> [--ttl <seconds>]
  toolroll heartbeat <lease>         still working; extends the lease
  toolroll release <lease>           done with it; fenced if superseded
  toolroll reap                      release every lease that ran out

  toolroll tick --runner <name> --token <t> --repo <path>
                                        one unattended pass: claim what is
                                        ready and approved, build it in a
                                        leased worktree, commit to a branch.
                                        [--max <n>] tasks (default 1),
                                        [--base <ref>] for first attempts.
                                        Never pushes.
  toolroll up [--project-root <dir>] one command to a working cockpit:
                                        app + builder + browser. Mints
                                        your login on first run (saved to
                                        up-login.txt beside the database),
                                        remembers the projects folder, and
                                        reconnects every saved repository.
                                        Add local or GitHub projects in the
                                        app; they start without a restart.
                                        --repo still adds an exact path;
                                        --no-open skips the browser;
                                        --host 0.0.0.0 --allow-host name:port
                                        reaches a phone over a tailnet;
                                        --runner names the worker;
                                        --capacity <n> sets how many tasks
                                        it runs at once (kept across starts);
                                        --editor vscode links changed files
                                        to VS Code on the device you browse
                                        from (turn on per device, in the
                                        build page's review section).
                                        --containment observed|preferred|required
                                        (or TOOLROLL_CONTAINMENT)
                                        bounds every provider, setup and
                                        check process in a native OS object
                                        (delegated cgroup v2 on Linux, a
                                        Job Object on Windows); required
                                        refuses to spawn where none exists
                                        (macOS) instead of downgrading.
                                        Also read by watch, tick and
                                        daemon install. --verbose prints
                                        the exact containment status (a
                                        service log always has it).
  toolroll reconcile --repo <path>   the morning sweep: recover dead
                                        runners, reap expired leases, adopt
                                        or forget orphaned worktrees. Run it
                                        before tick.

Capabilities — what the work needs, recorded and probed, never valued
  toolroll cap add <name> [--kind env|cli|mcp|ci|other] [--probe <cmd>]
                                        env kind synthesizes test -n "$NAME"
  toolroll cap list [--repo <path>]
  toolroll cap probe [<kind:name>…]  ask the environment; exit 0 all
                                        verified, 3 any gap
  toolroll task require <id> --cap <kind:name>[,…]
                                        nothing dispatches it until every
                                        one is verified (--cap none clears)
  toolroll gaps [--repo <path>]      what is missing, ranked by how many
                                        tasks filling it would start

  toolroll task plan <id> --as <you> --token <t>
                                        plan before building: an agent reads
                                        the repo, asks you questions, and
                                        proposes a scope you approve
  toolroll task route <id> [--risk routine|elevated|high]
      [--size small|medium|large] [--risky yes|no]
      [--phase plan|build|repair --provider <p> [--model <m>] | --clear-phase <phase>]
      --as <you> --token <t>            which agent plans, builds, and repairs
                                        this task, with the reason for
                                        each; declare its risk or override a
                                        phase — approval seals the route

Routines — tasks that fire on a schedule, each instance isolated
  toolroll template list             common routines, shipped
  toolroll template show <name>      the full prefill + what to edit
  toolroll template apply <name> --repo <path> [--file]
      previews the exact filing; --file files it UNAPPROVED through the
      same door as a manual filing — a template carries no authority

  toolroll routine add <name> --repo <path> --goal <text>
      --schedule every:<min>|daily:<HH:MM>[@Zone]|weekly:<0-6>:<HH:MM>[@Zone] (UTC by default)
      [--not <text>] [--touches a,b] [--require kind:name,…] [--ceiling <usd>]
      [--budget-usd <n>]                    what each firing may spend
  toolroll routine approve <name>    the step-up: approving means each
                                        firing builds WITHOUT asking, inside
                                        exactly the stated terms; editing any
                                        term voids the approval
  toolroll routine list | show <name>
  toolroll routine refresh <name>    re-resolve the agents it freezes from
                                        today's configuration; approve again
                                        afterwards — nothing fires until then
  toolroll routine pause|resume <name>
  toolroll routine run-now <name> --as <you> --token <t>

Flows — processes cards move through; the console's rules
  toolroll flows list [--repo <path>] | show <id>
  toolroll flows create --repo <path> --name <name> (--template <id> | --steps <file|->)
  toolroll flows edit <id> --steps <file|-> [--name <name>]
  toolroll flows trigger add <id> <json|file|->
  toolroll flows trigger pause|resume|remove|check <id> <trigger>
  toolroll flows script save --repo <path> --name <name> (--file <path in project> | --body <file>)
      --about "<one line>" [--language shell|python|node] [--timeout-minutes <n>]
  toolroll flows card add <id> --title <t> [--description <d>] [--zone <zone>]
  toolroll flows archive <id>
      writes take --as <you> --token <t> (or the remembered login); create,
      edit, archive and trigger add preview until --yes

Agents — which provider and model each phase runs on
  toolroll providers                 what is installed, logged in, and
                                        configured on this machine — without
                                        spending anything to find out
  toolroll providers --report --runner <name> --token <t>
                                        record this machine's readiness per
                                        provider under its runner name
  toolroll providers resume <provider> after signing in again, start its
                                        paused tasks now
  toolroll config set chat --provider claude-subscription|codex-subscription|anthropic-api|openrouter-api
      [--model <m>] [--weekly-usd <n>] [--daily-turns <n>] --as <you> --token <t>
      membership providers reuse a logged-in local harness with no dollar
      maximum; direct API providers require a key and weekly dollar ceiling
  toolroll chat --as <you> [--repo <path>…] [--say "…"] [--end]
      [--ceiling-usd <n>] [--json]                 (password at the prompt;
      --token <t> only for scripts — it lands in shell history)
      the mate: one conversation across your projects, the same thread the
      console shows; the password mints a spending session once; it reads
      and proposes, you confirm cards (confirm N / dismiss N / open N;
      confirm N yes for an irreversible answer)
  toolroll proposals [list [--all]] | confirm <id> [--yes] | dismiss <id>
      what coordinators proposed over the MCP gateway; confirming runs the
      same door the console runs, under your password
  toolroll config show [--repo <path>]
  toolroll config set <phase> --provider claude|codex|openrouter
      [--model <m>] [--repo <path>] --as <you> --token <t>
                                        phases: plan | build | repair. The
                                        repo form is a project override;
                                        without it, installation-wide.
                                        Repair's PROVIDER always inherits
                                        the build it mends.
  toolroll config set <phase> --tier strong --provider <p> --model <m>
      [--repo <path>] --as <you> --token <t>
                                        the STRONG agent high-risk, strict,
                                        screenshot-proof, and automerge
                                        routes reach for; never inferred
  toolroll config set build --tier light --provider <p> --model <m>
      [--repo <path>] --as <you> --token <t>
                                        the fast agent small changes build
                                        on, with no plan
  toolroll config set <plan|build> [--tier light|strong] --also
      --provider <p> --model <m> [--repo <path>] --as <you> --token <t>
                                        another provider's agent on the same
                                        tier; each task runs the one whose
                                        plan has more room
  toolroll config clear <plan|build> [--tier light|strong] --also
      [--provider <p>] [--repo <path>] --as <you> --token <t>
  toolroll config clear <phase> [--repo <path>] --as <you> --token <t>

  toolroll setup show --repo <path>  what a fresh checkout runs first
  toolroll setup set --repo <path> --command "npm ci"
      [--timeout-seconds <n>] --as <you> --token <t> [--yes]
                                        approve the command every fresh
                                        worktree runs before any agent —
                                        a failed setup blocks the build
  toolroll setup clear --repo <path> --as <you> --token <t>
  toolroll verify show --repo <path> what re-runs after each build
  toolroll verify set --repo <path> --command "npm test"
      [--timeout-seconds <n>] [--self-heal [--setup-digest <shown>]]
      --as <you> --token <t> [--yes]
                                        --self-heal may replay the exact
                                        approved setup once when a project
                                        executable is missing, then retry
                                        this check once; approval requires
                                        its previewed setup digest
  toolroll verify clear --repo <path> --as <you> --token <t>   (--level quick clears the quick command)
  toolroll verify level quick|full|off --repo <path> --as <you> --token <t>
                                        how much checks after each build: Quick (the
                                        quick command), Full, or Off (no check)
  toolroll verify set --repo <path> --quick "<cmd>" --as <you> --token <t> [--yes]
                                        approve the fast check Quick runs; verify show
                                        suggests one from the project's scripts
  Pass flags still win for one pass: --provider/--model,
  --plan-provider/--plan-model, --repair-model. A routine instance is
  pinned at fire time and ignores all of them.
  toolroll peek [<run-id>] [--tmux]  watch live agents: one pane per
                                        open run — stage, clock, and what
                                        the agent is saying; digits focus,
                                        q leaves; --tmux opens a window per
                                        run in a real tmux session
  toolroll brief [--repo <path>] [--local] [--since <iso>]
                                        the report: recent runs, gaps,
                                        PRs (--local skips the network and
                                        says REVIEW was not read)

The outbox — facts that want a person, durably
  toolroll webhook set slack|discord <url>
                                        UI-only chat mirrors: every page a
                                        message with a console link; acting
                                        stays in the console. Delivers when
                                        Telegram is not configured.
  toolroll webhook set console-url <http://host:port>
  toolroll webhook primary telegram|slack|discord
                                        which service receives alerts when
                                        several are connected (asked once,
                                        the first time you add a second)
  toolroll webhook status | test | clear slack|discord
  toolroll outbox list [--all]
  toolroll outbox deliver --cmd <c>  runs once per pending row, reading
                                        $TOOLROLL_KIND / _SUBJECT / _BODY;
                                        exit 0 delivered receipts, 1 any fail

Runners — the machines that may be given work
  toolroll runner register <name> [--capacity <n>] [--token-file <path>]
                                        mints a token, shown once
  toolroll runner list               who is registered, and answering
  toolroll runner heartbeat <name> --token <token>
  toolroll runner reap               take back what a dead runner held
  toolroll runner retire <name>
  toolroll runner capacity <name> <n> --as <you> --token <t>
                                        how many tasks it runs at once (1–64);
                                        running work carries on, the new
                                        number applies at the next claim

Write access — discovery stays read-only until you grant it
  toolroll enroll [repo] --backend <name> --paths <p>[,<p>]
                                        show what it would grant; --yes agrees
  toolroll grants                    what has been granted, and to what
  toolroll revoke [repo] --backend <name>

  --allow <a,b>     mutation classes (default: ${DEFAULT_MUTATIONS.join(",")})
  --selector ours|all   which tasks (default: ours — never a whole backlog)
  --credentials <name>  which credential scope it may use

Options
  --help            this, from any queue command — nothing runs, nothing is created
  --json            one envelope per command: { ok, command, ... }
  --key <key>       idempotency key; a retry returns the first answer
  --db <path>       use a different queue; waits up to 15 seconds for another writer
  --backend <name>  which backend the id belongs to (default: built-in)

Exit codes
  0  it happened          2  bad usage
  1  something broke      3  ran fine, the answer is no`;

/** Parsed flags, with the positionals left over. */
type Args = {
  positional: string[];
  flags: Map<string, string | true>;
  /** EVERY --repo occurrence, in order (arc 2 finding 22): the Map keeps its
   * last-wins behavior for every existing verb; only `up` reads this. */
  repoList: string[];
};

/**
 * The subcommand inventories the dispatchers consult (arc 5): each verb's
 * runner refuses an action outside its list BEFORE its switch, so these
 * exports are behavior, not commentary — and the declared command guide
 * (surface.ts) is tested for exact equality against them.
 */
export const TASK_ACTIONS = [
  "add", "list", "show", "wait", "state", "block", "unblock", "next", "steer", "assign",
  "reopen", "scope", "approve", "hold", "unhold", "require", "requeue", "regate", "plan",
  "review", "accept", "repair", "route", "stop", "resume", "complete", "revise", "merge", "ask",
  "checks", "add-tests",
] as const;
export const PUBLISH_ACTIONS = ["setup", "grant", "revoke", "status", "unblock", "rearm", "merge", "refire"] as const;
export const CONFIG_ACTIONS = ["show", "set", "clear"] as const;
export const APPROVER_ACTIONS = ["list", "add"] as const;
export const ROUTINE_ACTIONS = ["list", "add", "show", "approve", "refresh", "pause", "resume", "run-now"] as const;
export const CONTEST_ACTIONS = ["show", "exclude"] as const;
export const PEOPLE_ACTIONS = ["list", "invite", "projects", "revoke"] as const;
export const KEYS_ACTIONS = ["status", "set", "clear", "verify", "auth"] as const;

/**
 * The GLOBAL flag vocabulary (exported for the command guide's drift
 * tests): every value-taking flag any verb reads, and every boolean.
 * A --flag in neither set is a typo, refused by name.
 */
export const OPERATE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "key", "db", "runner", "ttl", "state", "on", "reason", "until", "id", "backend",
  "allow", "selector", "paths", "credentials", "repo", "token", "capacity",
  "goal", "not", "touches", "acceptance", "candidate", "by", "digest", "as", "branch", "pool", "base", "model", "turns",
  "max", "cap", "probe", "kind", "expires", "cmd", "since", "repair-model",
  "choose", "note", "max-open-decisions", "max-held-sessions", "name", "days", "publication", "auto-approve", "review-auto", "entries", "port", "host", "allow-host",
  "for", "tick-every", "bridge-every", "reconcile-every", "incarnation",
  "say", "ceiling-usd",
  "token-file", "bin", "poll", "github", "remote", "head-prefix", "password",
  // v102: project rules.
  "not-requester", "protect", "protect-paths",
  // v103: the ledger chain and evidence packs.
  "checkpoint", "out", "from", "to",
  // v105: spend and budgets.
  "month", "usd", "person", "teammate",
  // Sprint 8: the organisation policy.
  "providers", "models", "tools",
  "project-root", "schedule", "ceiling", "require",
  "provider", "plan-model", "plan-provider", "public-url", "editor",
  "command", "timeout-seconds", "setup-digest", "stop-grace", "title", "name", "every", "lines",
  "label", "reviewers", "limit", "role", "key-file", "weekly-usd", "daily-turns", "per-hour", "token-file", "race", "compare", "race-per-usd", "race-total-usd", "race-count", "race-agents", "budget-usd", "build-usd", "sync-max-age", "merge-method",
  "phase", "risk", "tier", "clear-phase", "size", "risky",
  "run", "containment", "agent",
  // onboard: the starter flows to switch on.
  "starter",
  // flows: templates, steps, scripts and cards.
  "template", "steps", "about", "language", "timeout-minutes", "body", "description", "zone",
  "token-env", "after", "repair-max-attempts", "consumer", "batch", "feedback", "source", "view", "cursor", "why", "supersedes", "decision", "sessions", "timeout",
  // pings follow responsibility: replacements.
  "replaced-by", "replaces",
  // Check levels: a project's level, the quick command, a task's choice.
  "quick", "level", "checks",
  // lead say: the task the lead's words are about.
  "task",
]);
export const OPERATE_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json", "yes", "all", "brief", "local", "history", "latest-watch", "dry-run", "file", "allow-paid-fallback",
  "clear", "follow", "ready", "all-tasks", "inbound-only", "help", "undo", "anyone", "allow-dispatch", "allow-merge", "merge-delete-branch",
  "no-open", "remove", "no-verify", "no-follow", "end", "report", "off", "tmux",
  "self-heal", "plan-auto", "chat-approve", "repair-auto", "review-retry-auto", "no-local",
  "html", "csv", "alerts-only",
  // v105: the full export.
  "zip",
  // Settings → Integrations: the last checks, without checking again.
  "saved",
  // task complete: also open the result's pull request.
  "pull-request",
  // up: the exact start-up details (containment) in the terminal too.
  "verbose",
  // lead token: end the lead's credential.
  "revoke",
  // task merge: merge without waiting for the full check (Quick or Off results).
  "anyway",
  // config set/clear: another provider's candidate on the same tier.
  "also",
]);

export function parseOperateArgs(argv: readonly string[], ownValues: ReadonlySet<string> = new Set()): Args | { error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repoList: string[] = [];
  const wantsValue = new Set([...OPERATE_VALUE_FLAGS, ...ownValues]);

  // Every boolean flag any verb reads. A --flag in neither set is a typo,
  // and a typo silently becoming `true` (with its intended value demoted to
  // a positional) surfaces later as a different, wronger error — refuse it
  // here by name instead (Codex round-4 findings 3/8).
  // A verb may read a global switch's name as a value of its own (`flows script save --file <path>`).
  const booleans = new Set([...OPERATE_BOOLEAN_FLAGS].filter(name => !ownValues.has(name)));

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith("--")) {
      // `-h` is the one short flag people type from habit; only `--` forms
      // are flags here, so normalize it rather than scanning it as data.
      if (argument === "-h") {
        flags.set("help", true);
        continue;
      }
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (booleans.has(name)) {
      if (equals !== -1) return { error: `--${name} does not take a value` };
      flags.set(name, true);
      continue;
    }
    if (!wantsValue.has(name)) {
      return { error: `unknown option --${name} — add --help to any queue command for the whole surface` };
    }
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    // A following --flag is not a value — consuming it would swallow a real
    // flag and leave this one holding a name-shaped lie.
    // Minted 32-byte base64url credentials may begin with two hyphens.
    // Accept that exact token shape without swallowing a following flag.
    // Explicit --name=value also carries arbitrary literal leading hyphens.
    const mintedToken = name === "token" && value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
    if (value === undefined || (equals === -1 && value.startsWith("--") && !mintedToken)) return { error: `--${name} needs a value` };
    // `flows import --param a=1 --param b=2`: each value kept, one per line.
    flags.set(name, name === "param" && typeof flags.get(name) === "string" ? `${flags.get(name)}\n${value}` : value);
    if (name === "repo") {
      for (const one of value.split(",").map(part => part.trim()).filter(part => part !== "")) repoList.push(one);
    }
  }

  return { positional, flags, repoList };
}

/** Route an `operate` command. Returns the process exit code. */
export async function runOperate(
  command: string,
  argv: readonly string[],
  write: Write,
  options: OperateOptions = {},
): Promise<number> {
  const parsed = parseOperateArgs(argv, command === "flows" ? FLOWS_VALUE_FLAGS : undefined);
  // A parse error precedes the flags map, so JSON mode is read from the raw
  // argv — the envelope contract holds even for the earliest refusal.
  if ("error" in parsed) return fail(write, argv.includes("--json"), command, "usage", parsed.error, EXIT.usage);

  const { positional, flags } = parsed;
  const json = flags.has("json");

  // Help answers BEFORE the database opens: asking what the commands are
  // must not create ~/.config/toolroll/orders.db as a side effect,
  // and `serve --help` must print help, never start a server (round-4
  // findings 2/7).
  if (flags.has("help")) {
    if (json) {
      write(envelopeJson({ ok: true, command: "help", help: OPERATE_HELP }));
    } else {
      write(OPERATE_HELP);
    }
    return EXIT.ok;
  }

  const file = text(flags, "db") ?? options.databaseFile ?? databasePath(process.env, homedir());
  const now = options.now ?? new Date();
  try { applyProjectProfile(command, positional, flags, file); }
  catch (error) { return fail(write, json, command, "configuration", describe(error), EXIT.refused); }

  // THE CONTAINMENT POLICY, pinned for this process before any database
  // opens (OS containment plan): `--containment observed|preferred|required`,
  // else TOOLROLL_CONTAINMENT (or STANDING_ORDERS_CONTAINMENT), else observed. A word that is none of
  // the three refuses here — nothing is assumed from a corrupt value, and a
  // pinned requirement is never weakened by a later flag.
  try {
    const containment = resolveContainment(text(flags, "containment"));
    if (!containment.ok) return fail(write, json, command, "usage", containment.problem, EXIT.usage);
  } catch (error) {
    return fail(write, json, command, "usage", describe(error), EXIT.usage);
  }

  // The MCP server never touches the migrating open below — it goes
  // through the non-migrating door with its own refusal words (spec v6).
  if (command === "mcp") {
    return mcpCommand(file, flags, write, json);
  }
  // Restore replaces the database file itself, so it opens (and closes) the database on its own.
  if (command === "restore") {
    return restoreCommand(file, positional, flags, write, json, now);
  }

  let store: Store;
  try {
    store = (options.openDatabase ?? openStore)(file);
  } catch (error) {
    return databaseFailure(write, json, command, file, error);
  }
  // The lead (a lead token, as --token or TOOLROLL_LEAD_TOKEN) acts for its owner in single commands; its work
  // pings nobody. Anyone else who signs in inside one of these commands is who acted. Services name nobody.
  const presentedFlag = text(flags, "token");
  const flagLead = presentedFlag !== undefined && parseLeadToken(presentedFlag) !== null;
  const envLead = envValue(process.env, "LEAD_TOKEN");
  const presented = flagLead ? presentedFlag : LEAD_COMMANDS.has(command) && envLead !== undefined && envLead !== "" ? envLead : undefined;
  let actor: Actor | null = null;
  if (presented !== undefined) {
    if (!LEAD_COMMANDS.has(command)) {
      store.close();
      return fail(write, json, command, "usage", `A lead token works for ${[...LEAD_COMMANDS].filter(one => one !== "lead").join(", ")}. Use your own sign-in for ${command}.`, EXIT.usage);
    }
    const lead = store.leadFor(presented);
    if (lead === null) {
      store.close();
      return fail(write, json, command, "unauthenticated", "That lead token is not valid (revoked, replaced, or its owner can no longer approve). The owner mints a new one with: toolroll lead token", EXIT.refused);
    }
    if (flagLead) flags.delete("token");
    actor = { account: lead.owner, lead: true };
  }
  // v105: a Claude turn anywhere in this command says its plan's usage windows; keep the latest.
  const dropLimitSink = pushLimitSink(reading => store.recordProviderLimits(reading, new Date()));
  // Filed tasks are sized by the owner's own fast classifier (never in tests, the demo, or with NO_TASK_CLASSIFIER).
  const sizer = options.filingSizer ?? (process.env["VITEST"] !== undefined || envValue(process.env, "NO_TASK_CLASSIFIER") !== undefined || store.isDemo() ? null : ownerSizer());
  const dropSizer = sizer === null ? () => {} : installFilingSizer(sizer);

  // One `Date` per command is fine for a lookup and wrong for a pass that
  // runs an agent for half an hour: leases granted, extended, and released
  // with the same stale stamp. Injected time stays frozen — a test's clock
  // must not advance under it — while real time is read again at each step.
  const clock = options.now === undefined ? () => new Date() : () => now;

  try {
    const run = (): Promise<number> => dispatch(command, positional, flags, {
      ...(actor === null ? {} : { leadToken: presented! }),
      store,
      write,
      json,
      repoList: parsed.repoList,
      now,
      clock,
      // Evidence lives beside the database for the same reason the database
      // lives beside repos.json: somebody will want to back it up, sync it,
      // or delete it, and files hidden somewhere clever cannot be found when
      // it matters.
      evidenceRoot: join(dirname(file), "evidence"),
      databaseFile: file,
      ...(options.tempRoots === undefined ? {} : { tempRoots: options.tempRoots }),
      // The bot token's file home. Never a column; see telegram.ts.
      telegramTokenFile: join(dirname(file), "telegram-token"),
      ...(options.desktopIdentity === undefined ? {} : { desktopIdentity: options.desktopIdentity }),
      ...(options.inferProjectFromCwd === undefined ? {} : { inferProjectFromCwd: options.inferProjectFromCwd }),
      ...(options.additionalProjectRepos === undefined ? {} : { additionalProjectRepos: options.additionalProjectRepos }),
      ...(options.agentRunner === undefined ? {} : { agentRunner: options.agentRunner }),
      ...(options.gitRunner === undefined ? {} : { gitRunner: options.gitRunner }),
      ...(options.telegramTransport === undefined ? {} : { telegramTransport: options.telegramTransport }),
      ...(options.telegramEnv === undefined ? {} : { telegramEnv: options.telegramEnv }),
      ...(options.publishExec === undefined ? {} : { publishExec: options.publishExec }),
      ...(options.dispatchAdapter === undefined ? {} : { dispatchAdapter: options.dispatchAdapter }),
      ...(options.flowTriggerIo === undefined ? {} : { flowTriggerIo: options.flowTriggerIo }),
      ...(options.flowStepIo === undefined ? {} : { flowStepIo: options.flowStepIo }),
      ...(options.flowEveryMs === undefined ? {} : { flowEveryMs: options.flowEveryMs }),
      ...(options.flowFetch === undefined ? {} : { flowFetch: options.flowFetch }),
      ...(options.integrationIo === undefined ? {} : { integrationIo: options.integrationIo }),
      ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
      ...(options.mateSeams === undefined ? {} : { mateSeams: options.mateSeams }),
      ...(options.heldCoordinator === undefined ? {} : { heldCoordinator: options.heldCoordinator }),
      ...(options.waitSleep === undefined ? {} : { waitSleep: options.waitSleep }),
      ...(options.releaseIo === undefined ? {} : { releaseIo: options.releaseIo }),
      ...(options.installBin === undefined ? {} : { installBin: options.installBin }),
      ...(options.onboardSeams === undefined ? {} : { onboardSeams: options.onboardSeams }),
      ...(options.upSeams === undefined ? {} : { upSeams: options.upSeams }),
    });
    return await (LEAD_COMMANDS.has(command) ? withActor(actor, run) : run());
  } catch (error) {
    if (isDatabaseBusy(error)) return databaseFailure(write, json, command, file, error);
    return fail(write, json, command, "failed", describe(error), EXIT.failed);
  } finally {
    // A classification still in flight (at most its five-second budget) lands before the database closes.
    await settleSizings();
    dropSizer();
    dropLimitSink();
    store.close();
  }
}

/** The short commands a lead token works for, and where whoever signs in is recorded as the actor. */
const LEAD_COMMANDS: ReadonlySet<string> = new Set(["task", "assignment", "status", "ready", "brief", "peek", "check-progress", "notifications", "lead"]);

type Context = {
  /** The lead token this command runs under: it signs in as its owner. */
  leadToken?: string;
  desktopIdentity?: string;
  /** A desktop service directory is state, never an implicitly enrolled project. */
  inferProjectFromCwd?: boolean;
  /** Exact additions approved by the native project picker, independent of the enrollment registry. */
  additionalProjectRepos?: () => readonly string[];
  store: Store;
  write: Write;
  json: boolean;
  /** Every --repo occurrence in order (arc 2) — only `up` reads it. */
  repoList?: string[];
  now: Date;
  clock: () => Date;
  evidenceRoot: string;
  /** The directory holding the database — where credential files live. */
  databaseFile: string;
  /** Where `storage` looks for leftover test temp folders; default the temp folder and /tmp. */
  tempRoots?: readonly string[];
  telegramTokenFile: string;
  agentRunner?: CommandRunner;
  gitRunner?: CommandRunner;
  telegramTransport?: TelegramTransport;
  telegramEnv?: Record<string, string | undefined>;
  /** Injected by tests: what `publish` runs for git and gh. */
  publishExec?: PublishExec;
  mateSeams?: MateCliSeams;
  /** Injected by tests: the external-dispatch gh surface. */
  dispatchAdapter?: DispatchAdapter;
  /** Injected by tests: how flow triggers reach GitHub (gh) and Linear (fetch), and where their secrets live. */
  flowTriggerIo?: Partial<TriggerIo>;
  /** Injected by tests: how flow check and update steps run commands and reach GitHub and Linear. */
  flowStepIo?: Partial<StepIo>;
  /** Injected by tests: how often a worker's flow passes run beside its builds (default FLOW_EVERY_MS). */
  flowEveryMs?: number;
  /** Injected by tests: how `flows import` fetches a flow file's address. */
  flowFetch?: FetchLike;
  integrationIo?: Partial<IntegrationIo>;
  /**
   * The stop fence (Codex M5-M8 audit, IV-1): set by the watch when a
   * signal lands. A pass that sees true admits NOTHING more — no routine
   * fires, no claim, no run, no spawn. The in-flight build finishes under
   * its own bounds (or the grace kill); admission is what stops.
   */
  shouldStop?: () => boolean;
  /** A failed recovery pass pauses new admissions without stopping an owned build. */
  shouldPauseAdmission?: () => boolean;
  /** The held-session coordinator (Phase 2, attended road) — co-located
   * `up` only; its absence means attended tasks stay attended-only skips. */
  heldCoordinator?: import("./held.js").HeldSessionCoordinator;
  /** This up process's incarnation, for held custody rows. */
  upIncarnation?: string;
  /** Short directory for held control sockets (sun_path bound). */
  heldSocketDir?: string;
  /** Test seams for the held transport. */
  heldStarter?: typeof import("./exec.js").startClaudeHeldSession;
  heldGraceMs?: number;
  /** v28: optional attended-session cap; absent = unbounded. */
  maxHeldSessions?: number;
  /** Test seam for task wait; production uses a timer. */
  waitSleep?: (milliseconds: number) => Promise<void>;
  releaseIo?: ReleaseIo;
  installBin?: string;
  onboardSeams?: OnboardSeams;
  upSeams?: { terminal?: boolean; env?: Record<string, string | undefined>; openBrowser?: (url: string) => void };
  /** Test seam: this computer's tailnet names (production asks `tailscale status`). */
  tailnetNames?: () => Promise<readonly string[]>;
};


/**
 * The enrolled-project registry lives beside the database — the same rule
 * as evidence and the bot token — so an isolated installation (`--db` in a
 * sandbox, a test's temp dir) never enrolls into the person's real
 * ~/.config/toolroll/repos.json (2026-09-03: `up` tests had left
 * 888 dead temp paths there).
 */
function registryPathOf(context: { databaseFile: string }): string {
  return join(dirname(context.databaseFile), "repos.json");
}

/** Phone reads use enrollment, never opened-project history or a worker's
 * incidental single-project view. Reload per request so removal takes effect
 * without restarting the follower; no Git/filesystem access to projects. */
function telegramReadProjects(context: { databaseFile: string }): () => Promise<readonly string[]> {
  return async () => {
    const loaded = await loadProjectRegistry(registryPathOf(context));
    if ("error" in loaded) throw new Error("project registry unavailable");
    return loaded.repos;
  };
}

/** A running follower must observe channel changes and token removal too. */
function telegramCanDeliver(context: { databaseFile: string; telegramTokenFile: string }, token: string): () => boolean {
  return () => {
    const current = loadBotToken(process.env, context.telegramTokenFile);
    return current?.token === token && effectivePrimary(process.env, dirname(context.databaseFile), true).channel === "telegram";
  };
}

/** Ordinary paired text talks to the shared assistant: the same evidence
 * root the console reads results from, the same membership harness seam
 * the CLI's chat uses, and this process's held-session supervisor for a
 * confirmed stop. The pass, the follower and the watch all wire it. */
function telegramConversation(context: Context, options: { serverOrigin?: string } = {}): TelegramConversationOptions {
  return {
    evidenceRoot: context.evidenceRoot,
    ...(context.mateSeams?.subscriptionRunner === undefined ? {} : { subscriptionRunner: context.mateSeams.subscriptionRunner }),
    ...(context.heldCoordinator === undefined ? {} : { held: context.heldCoordinator }),
    // Re-read on every card and every `/task`: the same console-url the
    // mirrors use, held to an https origin, and — inside `up`, where this
    // process also serves the console — equal to that console's own
    // `--public-url`, or no link at all.
    phoneOrigin: () => phoneOrigin(process.env, dirname(context.databaseFile), { serverOrigin: options.serverOrigin ?? null }),
  };
}


/** A revision's verified start: its source build's sealed head, while the revision brief still binds that head and scope. */
function revisionSourceHead(store: Store, evidenceRoot: string, taskRef: number, revisionOf: string): { ok: true; head: string } | { ok: false; problem: string } {
  const source = store.revisionSourceOf(taskRef);
  const sourceRun = source === null ? null : store.getRun(source.sourceRun);
  if (source === null || sourceRun === null || store.externalIdFor(sourceRun.taskRef) !== revisionOf || sourceRun.headRevision === null) return { ok: false, problem: "the revision source has no matching sealed head" };
  try {
    const verified = readVerifiedArtifact(evidenceRoot, source.briefArtifact);
    const brief = verified.ok ? JSON.parse(verified.content.toString("utf8")) as { head?: unknown; sourceScopeDigest?: unknown } : null;
    if (brief === null || brief.head !== sourceRun.headRevision || brief.sourceScopeDigest !== sourceRun.scopeDigest) return { ok: false, problem: "the revision brief no longer binds the source head and scope" };
    return { ok: true, head: sourceRun.headRevision };
  } catch {
    return { ok: false, problem: "the revision source brief cannot be verified" };
  }
}

async function dispatch(
  command: string,
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  switch (command) {
    case "status":
      return statusCommand(positional, flags, context);
    case "ready":
      return readyCommand(flags, context);
    case "task":
      return taskCommand(positional, flags, context);
    case "ledger":
      return ledgerCommand(positional, flags, context);
    case "spend":
      return spendCommand(flags, context);
    case "budget":
      return budgetCommand(positional, flags, context);
    case "retention":
      return retentionCommand(positional, flags, context);
    case "notifications":
      return notificationsCommand(positional, flags, context);
    case "lead":
      return leadCommand(positional, flags, context);
    case "backup":
      return backupCommand(positional, flags, context);
    case "export":
      return exportCommand(positional, flags, context);
    case "policy":
      return policyCommand(positional, flags, context);
    case "storage":
      return storageCommand(positional, flags, context);
    case "integrations":
      return integrationsCommand(positional, flags, context);
    case "review":
      return reviewSwitchCommand(positional, flags, context);
    case "monitoring": {
      // Where the audit stream and traces go, and how each destination is doing. Settings → Monitoring changes it.
      const settings = readMonitoring(dirname(context.databaseFile));
      const head = context.store.ledgerHeadId();
      // Origins only: an address's path or query may carry a key.
      const destinations = [
        ...(settings.webhook === null ? [] : [{ sink: "webhook", to: origin(settings.webhook.url), address: settings.webhook.url }]),
        ...(settings.folder === null ? [] : [{ sink: "folder", to: settings.folder.path, address: settings.folder.path }]),
        ...(settings.traces === null ? [] : [{ sink: "traces", to: origin(settings.traces.endpoint), address: settings.traces.endpoint }]),
      ].map(one => ({ ...one, status: context.store.monitoringStatus(one.sink).find(row => row.target === targetOf(one.address)) ?? null }));
      return succeed(context.write, context.json, "monitoring", { destinations, ledgerHead: head }, () => destinations.length === 0 ? ["Monitoring is off. Settings → Monitoring sets it up."] :
        destinations.map(one => `${one.sink.padEnd(8)} ${one.to} — ${one.status === null ? "starting" : one.status.failures > 0 ? `failing: ${one.status.lastError ?? "?"}` : `sent through #${one.status.through}${one.sink === "traces" ? "" : ` (${Math.max(0, head - one.status.through)} to go)`}`}`));
    }
    case "check-progress":
      return checkProgressCommand(positional, context);
    case "project":
      if (positional[0] === "rules") return projectRulesCommand(positional, flags, context);
      if (positional[0] === "delete") return projectDeleteCommand(positional, flags, context);
      if (positional[0] === "concurrency") return projectConcurrencyCommand(positional, flags, context);
      if (positional[0] === "checks") return projectChecksCommand(positional, flags, context);
      if (positional[0] === "demo") return projectDemoCommand(positional, flags, context);
      return runProjectCommand(positional, flags, context);
    case "assignment":
      // The person's own lead (its lead token) claims as the lead; coordinator credentials keep their own path.
      if (positional[0] === "claim" && currentActor()?.lead === true && !flags.has("token-env") && !flags.has("token-file")) return leadClaimCommand(positional, flags, context);
      return runAssignmentCommand(positional, flags, context);
    case "knowledge": {
      if (positional[0] !== "apply") return runKnowledgeCommand(positional, flags, { ...context, now: context.clock() });
      if (positional.length !== 1) return fail(context.write, context.json, "knowledge apply", "usage", "knowledge apply takes no query.", EXIT.usage);
      // A person's password, never the lead's token: the lead may not carry knowledge forward.
      const acting = currentActor()?.lead === true ? null : await askCredentials(flags, context);
      const repo = text(flags, "repo");
      const lead = acting !== null && parseLeadToken(acting.token) !== null;
      const verified = acting === null || lead ? null : authenticateApprover(context.store, acting.name, acting.token, repo === undefined ? null : resolve(repo));
      return runKnowledgeApply(flags, { ...context, now: context.clock(), actor: verified !== null && verified.ok ? acting!.name : null });
    }
    case "models": {
      const acting = await askCredentials(flags, context);
      const verified = acting === null ? null : authenticateApprover(context.store, acting.name, acting.token);
      return runModelsCommand(positional, flags, { store: context.store, write: context.write, json: context.json, now: context.clock(), actor: verified !== null && verified.ok ? acting!.name : null });
    }
    case "memory": {
      // The remembered local login (or --as/--token) names the person; reads
      // and writes both record who asked.
      const acting = await askCredentials(flags, context);
      const verified = acting === null ? null : verifyApproverByPassword(context.store, acting.name, acting.token, context.store.knownRepos().filter(repo => context.store.accountCanAccess(acting.name, repo)));
      const who = verified !== null && verified.ok ? verified.who : null;
      return runMemoryCommand(positional, flags, { store: context.store, write: context.write, json: context.json, now: context.clock(), actor: who?.name ?? null, repos: who?.repos ?? [], configDir: dirname(context.databaseFile), ...(context.evidenceRoot === undefined ? {} : { evidenceRoot: context.evidenceRoot }) });
    }
    case "claim":
      return claimCommand(positional, flags, context);
    case "heartbeat":
      return leaseCommand("heartbeat", positional, flags, context);
    case "release":
      return leaseCommand("release", positional, flags, context);
    case "reap":
      return reapCommand(context);
    case "runner":
      return runnerCommand(positional, flags, context);
    case "approver":
      return approverCommand(positional, flags, context);
    case "coordinator":
      return coordinatorCommand(positional, flags, context);
    case "build":
      return buildCommand(positional, flags, context);
    case "tick":
      return tickCommand(flags, context);
    case "reconcile":
      return reconcileCommand(flags, context);
    case "run":
      return runCommand(positional, flags, context);
    case "cap":
      return capCommand(positional, flags, context);
    case "gaps":
      return gapsCommand(flags, context);
    case "outbox":
      return outboxCommand(positional, flags, context);
    case "peek":
      return peekCommand(positional, flags, context);
    case "brief":
      if (["history", "local", "since", "latest-watch"].some(flag => flags.has(flag))) return briefCommand(flags, context);
      return runAssignmentCommand(["brief"], flags, { ...context, commandName: "brief" });
    case "decide":
      return decideCommand(positional, flags, context);
    case "incident":
      return incidentCommand(positional, flags, context);
    case "routine":
      return routineCommand(positional, flags, context);
    case "flows":
      return flowsCommand(positional, flags, context);
    case "config":
      return configCommand(positional, flags, context);
    case "chat":
      return chatCommand(flags, context);
    case "proposals":
      return proposalsCommand(positional, flags, context);
    case "mode":
      return modeCommand(positional, flags, context);
    case "people":
      return peopleCommand(positional, flags, context);
    case "keys":
      return keysCommand(positional, flags, context);
    case "setup":
      return setupCommand(positional, flags, context);
    case "verify":
      return verifyCommand(positional, flags, context);
    case "intake":
      return intakeCommand(positional, flags, context);
    case "providers":
      if (positional[0] === "resume") return resumeProviderCommand(positional.slice(1), flags, context);
      return providersCommand(flags, context);
    case "template":
      return templateCommand(positional, flags, context);
    case "contest":
      return contestCommand(positional, flags, context);
    case "webhook":
      return webhookCommand(positional, flags, context);
    case "sync":
      return syncCommand(flags, context);
    case "serve":
      return serveCommand(flags, context);
    case "watch":
      return watchCommand(flags, context);
    case "up":
      return upCommand(flags, context);
    case "onboard":
      return onboardCommand(flags, context);
    case "daemon":
      return daemonCommand(positional, flags, context);
    case "bridge":
      return bridgeCommand(positional, flags, context);
    case "publish":
      return publishCommand(positional, flags, context);
    case "enroll":
      return enrollCommand(positional, flags, context);
    case "grants":
      return grantsCommand(context);
    case "revoke":
      return revokeCommand(positional, flags, context);
    default:
      return fail(
        context.write,
        context.json,
        command,
        "usage",
        `unknown command \`${command}\``,
        EXIT.usage,
      );
  }
}


/**
 * The backend a command is talking to, already wrapped in its guard.
 *
 * Constructed here rather than at each call site so that no command can
 * accidentally reach an adapter that has not been through `guarded` — the
 * unguarded constructors exist for tests and for this function, and for
 * nothing else.
 */
function openBackend(name: string, store: Store, repo: string): GraphBackend | null {
  if (name === BUILT_IN) return builtIn(store);
  if (name === "beads") return guarded(beads({ repo }), { store, repo });
  if (name === "github-issues") return guarded(githubIssues({ repo }), { store, repo });
  return null;
}

/** The repository a backend command applies to, normalised like the grant is. */
function repoFrom(flags: Map<string, string | true>): string {
  return resolve(text(flags, "repo") ?? process.cwd());
}

// ---- the dispatch loop ----------------------------------------------------

/**
 * The ready set: everything a runner could legitimately start on right now.
 *
 * An empty ready set is exit 3 rather than 0. There is nothing wrong, but a
 * caller in a loop needs to tell "here is work" from "there is none" without
 * parsing anything, and the alternative is every scheduler re-implementing
 * that check against an empty array.
 */
async function readyCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const backendName = text(flags, "backend") ?? BUILT_IN;

  // An external tracker is asked directly. This is a network or subprocess
  // round trip and is deliberately not somewhere a scheduler should sit in a
  // tight loop — §4 wants a materialised snapshot for that, which belongs with
  // the scheduler rather than here.
  if (backendName !== BUILT_IN) {
    const repo = repoFrom(flags);
    const backend = openBackend(backendName, store, repo);
    if (backend === null) {
      return fail(write, json, "ready", "usage", `no backend \`${backendName}\``, EXIT.usage);
    }

    const result = await backend.listReady();
    if (!result.ok) return fail(write, json, "ready", result.reason, result.message, EXIT.failed);

    const tasks = result.value;
    if (json) {
      write(envelopeJson({ ok: tasks.length > 0, command: "ready", ...(tasks.length > 0 ? {} : { reason: "empty", message: "nothing is ready to dispatch" }), backend: backendName, count: tasks.length, tasks }));
      return tasks.length > 0 ? EXIT.ok : EXIT.refused;
    }
    if (tasks.length === 0) {
      write(`Nothing is ready in ${backendName}.`);
      return EXIT.refused;
    }
    write(`${tasks.length} ready in ${backendName}:`);
    for (const task of tasks) write(`  ${task.id}  ${task.title}`);
    return EXIT.ok;
  }

  const ready = store.listReady(now);

  const described = ready.map(ref => describeRef(store, ref, now));
  const dispatchableCount = described.filter(one => diagnosisIsDispatchable(one.dispatch)).length;
  const pauses = openAuthPauses(store);

  if (json) {
    write(envelopeJson({
      ok: ready.length > 0,
      command: "ready",
      ...(ready.length > 0 ? {} : { reason: "empty", message: "nothing is task-locally ready" }),
      count: ready.length,
      dispatchableCount,
      signIn: pauses.map(one => ({ provider: one.provider, message: signInWords(one), since: one.openedAt })),
      tasks: described,
    }));
    return ready.length > 0 ? EXIT.ok : EXIT.refused;
  }

  // A paused provider first: nothing on it runs until someone signs in.
  for (const one of pauses) write(signInWords(one));
  if (ready.length === 0) {
    write("Nothing is ready to dispatch.");
    return EXIT.refused;
  }

  write(`${ready.length} task-local candidate${ready.length === 1 ? "" : "s"} (${dispatchableCount} can dispatch with the fleet as it stands):`);
  for (const ref of ready) {
    const task = store.getTask(ref.externalId);
    const diagnosis = diagnoseTaskDispatch(store, ref.externalId, now);
    write(`  ${ref.externalId}  ${task === null ? "" : task.title}${ref.assignedRunner === null ? "" : `  (reserved for ${ref.assignedRunner})`}${diagnosis === null ? "" : ` — ${diagnosis.code === "signed-out" ? diagnosis.summary : diagnosis.summary.toLowerCase()}`}`);
  }
  return EXIT.ok;
}

function describeRef(store: Store, ref: { externalId: string; backend: string; id: number; assignedRunner?: string | null }, now: Date) {
  const task = store.getTask(ref.externalId);
  return {
    id: ref.externalId,
    ref: ref.id,
    backend: ref.backend,
    title: task?.title ?? null,
    state: task?.state ?? null,
    reservedFor: ref.assignedRunner ?? null,
    claim: currentClaim(store, ref.id, now),
    dispatch: diagnoseTaskDispatch(store, ref.externalId, now),
  };
}

/**
 * Take a task.
 *
 * The refusal carries who holds it and until when, because a caller that only
 * learns "no" has to poll blindly, while one that learns "runner-b until
 * 22:14" can go and do something else until then.
 */
function claimCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  const runner = text(flags, "runner");

  if (id === undefined) return fail(write, json, "claim", "usage", "which task? `toolroll claim <id> --runner <name> --token <token>`", EXIT.usage);
  if (runner === undefined) return fail(write, json, "claim", "usage", "--runner names who is taking it", EXIT.usage);

  // Taking work requires proving who you are. Accepting a runner *name* alone
  // would make the credential decorative: anyone who could reach the queue
  // could mint leases under somebody else's identity, and the fencing that
  // protects those leases would be protecting the wrong thing. This is what
  // "auth from the first commit" is for — it is only cheap now.
  const token = text(flags, "token");
  if (token === undefined) {
    return fail(write, json, "claim", "usage", "--token proves the runner is who it says", EXIT.usage);
  }
  const auth = authenticate(store, runner, token);
  if (!auth.ok) {
    return fail(write, json, "claim", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }

  const backend = text(flags, "backend") ?? BUILT_IN;
  if (backend === BUILT_IN && store.getTask(id) === null) {
    return fail(write, json, "claim", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const ttl = readTtl(flags);
  if (ttl === null) return fail(write, json, "claim", "usage", "--ttl takes whole seconds", EXIT.usage);

  // Taking a task in somebody else's tracker is a write to it — the claim
  // transitions their task and, for a repo-local backend, touches their files.
  // So this is where the grant is checked rather than assumed, and the
  // built-in store is exempt because it is ours by construction.
  if (backend !== BUILT_IN) {
    // Resolved, because `enroll` resolves too. Storing a grant under an
    // absolute path and looking it up under `.` denies a permission that was
    // genuinely given, which is a failure mode that looks exactly like the
    // security check working and is therefore the hardest kind to diagnose.
    const repo = resolve(text(flags, "repo") ?? process.cwd());
    const verdict = permits(store.grantFor(repo, backend), {
      repo,
      backend,
      mutation: "transition",
      // Read from the store, never from the caller: a rule that says "only our
      // tasks" while letting the asker declare which those are is not a rule.
      origin: store.originOf(backend, id),
    });
    if (!verdict.ok) {
      return fail(write, json, "claim", verdict.reason, verdict.message, EXIT.refused);
    }
  }

  const ref = store.refFor(backend, id);
  const result = acquire(store, ref.id, runner, {
    now,
    token,
    ttlMs: ttl,
    mutation: mutationFrom(flags, now),
  });

  if (!result.ok) {
    // Two distinct refusals: somebody HOLDS it right now, or it is
    // RESERVED for a specific worker whoever asks (queue columns, v19).
    if (result.reason === "reserved") {
      return fail(
        write,
        json,
        "claim",
        "reserved",
        `${id} is reserved for ${result.reservedFor} — only that worker takes it`,
        EXIT.refused,
        { reservedFor: result.reservedFor },
      );
    }
    if (result.reason === "external") {
      const said: Record<string, string> = {
        "stale-mirror": "this tracker item has not been seen recently — run `toolroll sync` first",
        "external-closed": "the tracker closed this — reopen it first, or leave it be",
        "dispatch-revoked": "this tracker's building permission was revoked or narrowed",
        "plane-blocked": "this tracker's plane marker could not be verified — building is paused",
      };
      return fail(write, json, "claim", "external", said[result.detail] ?? "external work is not dispatchable right now", EXIT.refused, {
        detail: result.detail,
      });
    }
    if (result.reason === "attended-held") {
      return fail(write, json, "claim", "attended-held", `an attended session holds this task for ${result.runner}`, EXIT.refused, {
        runner: result.runner,
      });
    }
    if (result.reason === "attended-only") {
      return fail(
        write,
        json,
        "claim",
        "attended-only",
        "this task runs only while its operator watches — it needs a live attended authorization or a real approval",
        EXIT.refused,
      );
    }
    if (result.reason === "mode-ended") {
      return fail(write, json, "claim", "mode-ended", result.message, EXIT.refused);
    }
    if (result.reason === "unauthenticated") {
      return fail(write, json, "claim", "unauthenticated", describeAuth(result.detail, runner), EXIT.refused);
    }
    if (result.reason === "unplaced") {
      return fail(
        write,
        json,
        "claim",
        "unplaced",
        "this task has no repository — preserve its history and file a replacement with `task add <title> --repo <path>`, then approve the new scope",
        EXIT.refused,
      );
    }
    if (result.reason === "unauthorized-repo") {
      return fail(
        write,
        json,
        "claim",
        "unauthorized-repo",
        `this runner is not bound to ${result.repo} — \`runner bind\` adds it`,
        EXIT.refused,
      );
    }
    if (result.reason === "coordinator-filed") {
      return fail(
        write,
        json,
        "claim",
        "coordinator-filed",
        "a coordinator filed this — nothing runs until the operator signs its scope",
        EXIT.refused,
      );
    }
    return fail(
      write,
      json,
      "claim",
      result.reason,
      `held by ${result.by} until ${result.until}`,
      EXIT.refused,
      { holder: result.by, until: result.until },
    );
  }

  // Taking a task is what makes it running; leaving that to the caller would
  // let a claimed task keep showing up as queued to anything reading state.
  // On an idempotent REPLAY the transition runs only as the ONE narrow
  // repair (external dispatch, finding 36): the stored claim is still the
  // live lease and the task never left queued — anything else (cancelled,
  // done, reopened elsewhere) mutates nothing.
  if (result.replayed === true) {
    const task = store.getTask(id);
    const ref = store.lookupRef(id);
    const stillMine = ref !== null && store.currentLiveLease(ref.id, now) === result.claim.leaseId;
    if (task !== null && task.state === "queued" && stillMine) store.setTaskState(id, "running", now);
  } else {
    store.setTaskState(id, "running", now);
  }

  return succeed(write, json, "claim", { lease: result.claim, reclaimed: result.reclaimed }, () => [
    `Claimed ${id} as ${runner}.`,
    `  lease   ${result.claim.leaseId}`,
    `  expires ${result.claim.expiresAt}`,
  ]);
}

/**
 * Heartbeat and release differ by one word and share every failure mode, so
 * they share a path — including the one that matters, where `fenced` means a
 * runner has been superseded and should stop rather than retry.
 */
function leaseCommand(
  command: "heartbeat" | "release",
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const lease = positional[0];
  if (lease === undefined) return fail(write, json, command, "usage", `which lease? \`toolroll ${command} <lease>\``, EXIT.usage);

  const ttl = readTtl(flags);
  if (ttl === null) return fail(write, json, command, "usage", "--ttl takes whole seconds", EXIT.usage);

  const result =
    command === "heartbeat" ? heartbeat(store, lease, now, ttl) : release(store, lease, now);

  if (!result.ok) {
    const message =
      result.reason === "fenced"
        ? "superseded — another runner holds this task now; stop rather than retry"
        : "no such lease";
    return fail(write, json, command, result.reason, message, EXIT.refused);
  }

  if (command === "release") {
    const task = store.getTask(String(refExternalId(store, result.claim.taskRef)));
    // Releasing says the runner is finished with it, not that it succeeded, so
    // a task left running is put back rather than marked done.
    if (task !== null && task.state === "running") store.setTaskState(task.id, "queued", now);
  }

  return succeed(write, json, command, { lease: result.claim }, () => [
    command === "heartbeat"
      ? `Still yours until ${result.claim.expiresAt}.`
      : `Released ${result.claim.leaseId}.`,
  ]);
}

function reapCommand(context: Context): number {
  const { store, write, json, now } = context;
  const reaped = reap(store, now);

  if (json) {
    write(envelopeJson({ ok: true, command: "reap", count: reaped.length, released: reaped }));
    return EXIT.ok;
  }

  if (reaped.length === 0) {
    write("No leases had run out.");
    return EXIT.ok;
  }
  write(`Released ${reaped.length}:`);
  for (const claim of reaped) write(`  ${claim.leaseId}  held by ${claim.runner}`);
  return EXIT.ok;
}

// ---- runners --------------------------------------------------------------

/**
 * Registering, checking in, and taking back what a dead machine was holding.
 *
 * The token is printed once and never again — there is no command that
 * recovers it, because a control plane able to hand back a runner's credential
 * is one whose database is worth stealing.
 */
async function runnerCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const [action, name] = positional;

  if (action === "list" || action === undefined) {
    const runners = store.listRunners().map(one => ({ ...one, alive: isAlive(one, now) }));
    if (json) {
      write(envelopeJson({ ok: true, command: "runner list", count: runners.length, runners }));
      return EXIT.ok;
    }
    if (runners.length === 0) {
      write("No runners registered.");
      write("  toolroll runner register <name>");
      return EXIT.ok;
    }
    for (const one of runners) {
      write(`  ${one.name}  ${one.alive ? "alive" : "not answering"}  last heard ${one.heartbeatAt}`);
    }
    return EXIT.ok;
  }

  if (action === "register") {
    if (name === undefined) {
      return fail(write, json, "runner register", "usage", "a runner needs a name", EXIT.usage);
    }
    const capacity = Number(text(flags, "capacity") ?? "1");
    if (!Number.isInteger(capacity) || capacity < 1) {
      return fail(write, json, "runner register", "usage", "--capacity is a whole number of tasks", EXIT.usage);
    }

    // Minting runner authority is an operator act (MCP gateway spec v6,
    // Codex round-1 finding 3): the CLI door now matches the console's —
    // password-signed, and the authority is BOUND to named repositories
    // at the mint. A caller flag never grants what the mint did not.
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "runner register", "usage", "`runner register <name> --repo <path> --as <you> --token <t>` — minting runner authority is an operator act", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, "runner register", authenticated.reason, describeApproveFailure(authenticated.reason, name), EXIT.refused);
    }
    const repos = context.repoList ?? [];
    if (repos.length === 0) {
      return fail(write, json, "runner register", "usage", "--repo names at least one repository this runner may build — authority binds at the mint", EXIT.usage);
    }
    // --token-file (setup review): the token lands 0600 in the file a
    // watch will read, and is never printed — one command from password to
    // a worker, no paste step. The file must not already exist: a second
    // mint never silently overwrites a credential a running watch holds.
    const tokenFile = text(flags, "token-file");
    if (tokenFile !== undefined && existsSync(tokenFile)) {
      return fail(write, json, "runner register", "token-file-exists", `${tokenFile} already exists — remove it first if that worker is gone, or name another file`, EXIT.refused);
    }
    const { runner, token, reclaimed } = register(store, {
      name,
      host: hostname(),
      capacity,
      repos,
      now,
      mutation: mutationFrom(flags, now),
    });
    if (tokenFile !== undefined) {
      try {
        writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
        chmodSync(tokenFile, 0o600);
      } catch (error) {
        return fail(write, json, "runner register", "token-file", `registered ${runner.name}, but the token could not be written to ${tokenFile} (${describe(error)}) — register again with a writable path`, EXIT.failed, { runner, reclaimed });
      }
    }

    return succeed(write, json, "runner register", { runner, ...(tokenFile === undefined ? { token } : { tokenFile }), reclaimed }, () => [
      `Registered ${runner.name} on ${runner.host}, capacity ${runner.capacity}.`,
      "",
      ...(tokenFile === undefined
        ? [`  token  ${token}`, "", "That token is shown once and is not stored — only a hash of it is."]
        : [`  token written to ${tokenFile} (owner-only) — \`toolroll watch --runner ${runner.name} --token-file ${tokenFile} --repo <path>\` uses it.`, "", "The token is not stored anywhere else — only a hash of it is."]),
      "If it is lost, register again to mint a new one.",
      // Taking work back from the previous holder of this name is a side
      // effect somebody should hear about, not one they discover later from a
      // task that mysteriously requeued itself.
      ...(reclaimed === null
        ? []
        : [
            "",
            `A previous ${runner.name} was still holding work; it has been taken back:`,
            ...reclaimed.claims.map(lease => `  claim     ${lease}`),
            ...reclaimed.worktrees.map(path => `  worktree  ${path} (unverified)`),
          ]),
    ]);
  }

  if (action === "heartbeat") {
    const token = text(flags, "token");
    if (name === undefined || token === undefined) {
      return fail(write, json, "runner heartbeat", "usage", "`runner heartbeat <name> --token <token>`", EXIT.usage);
    }

    const result = heartbeatRunner(store, name, token, now);
    if (!result.ok) {
      return fail(write, json, "runner heartbeat", result.reason, describeAuth(result.reason, name), EXIT.refused);
    }
    return succeed(write, json, "runner heartbeat", { runner: result.runner }, () => [
      `${name} checked in.`,
    ]);
  }

  if (action === "reap") {
    // Claims, open runs, and worktrees together: they are halves of one
    // fact, and recovering only one leaves a task dispatchable with its
    // working copy still checked out to a process that no longer exists —
    // or an attempt that reads as still running long after its lease went.
    // A dead runner whose only leftover is an open run is still reported
    // (P0.1a): the runs line is the whole point of that pass.
    const recovered = recoverDead(store, now).filter(recoveredAnything);

    if (json) {
      write(envelopeJson({ ok: true, command: "runner reap", recovered }));
      return EXIT.ok;
    }
    if (recovered.length === 0) {
      write("Every runner is answering, or held nothing.");
      return EXIT.ok;
    }
    for (const one of recovered) {
      write(`${one.runner} is not answering — took back:`);
      for (const lease of one.claims) write(`  claim     ${lease}`);
      for (const id of one.runs) write(`  run       #${id} (finished as interrupted)`);
      for (const id of one.requeued) write(`  task      ${id} (requeued)`);
      for (const path of one.worktrees) write(`  worktree  ${path} (unverified)`);
    }
    return EXIT.ok;
  }

  if (action === "retire") {
    if (name === undefined) {
      return fail(write, json, "runner retire", "usage", "which runner?", EXIT.usage);
    }
    // Retiring is revoking authority — the same operator act as minting it.
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "runner retire", "usage", "`runner retire <name> --as <you> --token <t>` — revoking runner authority is an operator act", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, "runner retire", authenticated.reason, describeApproveFailure(authenticated.reason, name), EXIT.refused);
    }
    const retired = store.retireRunner(name, now, mutationFrom(flags, now));
    if (!retired) {
      return fail(write, json, "runner retire", "unknown", `no runner \`${name}\``, EXIT.refused);
    }
    return succeed(write, json, "runner retire", { name }, () => [`${name} is retired.`]);
  }

  if (action === "bind") {
    if (name === undefined) {
      return fail(write, json, "runner bind", "usage", "which runner?", EXIT.usage);
    }
    // The one-time migration ceremony for pre-gate runners (MCP spec v6):
    // an empty binding is deny-all at the claim gate, and this is the road
    // the refusal names. Binding REPLACES the list with what is given —
    // stated authority, never accumulation nobody can read back.
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "runner bind", "usage", "`runner bind <name> --repo <path> --as <you> --token <t>` — binding repositories is an operator act", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, "runner bind", authenticated.reason, describeApproveFailure(authenticated.reason, name), EXIT.refused);
    }
    const repos = context.repoList ?? [];
    if (repos.length === 0) {
      return fail(write, json, "runner bind", "usage", "--repo names at least one repository", EXIT.usage);
    }
    const bound = store.bindRunnerRepos(name, canonicalRepos(repos), now);
    if (!bound.ok) {
      return fail(write, json, "runner bind", bound.reason, describeAuth(bound.reason, name), EXIT.refused);
    }
    return succeed(write, json, "runner bind", { name, repos: bound.repos }, () => [
      `${name} may build in:`,
      ...bound.repos.map(one => `  ${one}`),
    ]);
  }

  if (action === "capacity") {
    // Changing how much a worker takes on is an operator act, kept in the
    // ledger as before → after. It never stops running work: claims already
    // held keep going, and the new number applies at the next claim.
    const given = positional[2];
    if (name === undefined || given === undefined || positional.length > 3) {
      return fail(write, json, "runner capacity", "usage", "`runner capacity <name> <n> --as <you> --token <t>`", EXIT.usage);
    }
    const capacity = parseRunnerCapacity(given);
    if (capacity === null) {
      return fail(write, json, "runner capacity", "usage", `capacity is a whole number of tasks, 1 to ${RUNNER_CAPACITY_MAX}`, EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
    if (acting === null || verified === null || !verified.ok || !store.isInstanceOperator(acting.name)) {
      return fail(write, json, "runner capacity", "refused", "An instance operator changes a worker's capacity: pass --as and --token (or use the remembered login).", EXIT.refused);
    }
    const changed = store.setRunnerCapacity(name, capacity, acting.name, now);
    if (!changed.ok) {
      return fail(write, json, "runner capacity", changed.reason, changed.reason === "retired" ? `${name} is retired` : `no runner \`${name}\``, EXIT.refused);
    }
    const running = store.liveClaimCount(name, now);
    return succeed(write, json, "runner capacity", { name, before: changed.before, after: changed.after, running }, () => [
      changed.before === changed.after
        ? `${name} already runs up to ${changed.after} at once.`
        : `${name} now runs up to ${changed.after} at once (was ${changed.before}).`,
      ...(running > changed.after ? [`It is running ${running} now; those carry on, and it takes nothing new until fewer than ${changed.after} are running.`] : []),
    ]);
  }

  return fail(
    write,
    json,
    "runner",
    "usage",
    `unknown \`runner ${action}\` — try list, register, bind, capacity, heartbeat, reap, retire`,
    EXIT.usage,
  );
}

/**
 * The coordinator principal's ceremonies (MCP gateway spec v6, DESIGN.md
 * 9b): minting is an operator act that binds repos and a rate at the
 * mint; the token prints once; revocation is immediate and audited.
 */
async function coordinatorCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const [action, name] = positional;

  if (action === "list" || action === undefined) {
    const rows = listCoordinators(store);
    if (json) {
      write(envelopeJson({ ok: true, command: "coordinator list", coordinators: rows }));
      return EXIT.ok;
    }
    if (rows.length === 0) {
      write("No coordinators. `toolroll coordinator mint <name> --repo <path> --as <you> --token <t>`");
      return EXIT.ok;
    }
    for (const one of rows) {
      const state = one.revokedAt === null ? `${one.perHour}/h` : "revoked";
      write(`  ${one.name}#${one.cid.slice(0, 4)}  ${state}  ${one.repos.join(", ")}  last filed ${one.lastFiledAt ?? "never"}`);
    }
    return EXIT.ok;
  }

  if (action === "mint") {
    if (name === undefined) {
      return fail(write, json, "coordinator mint", "usage", "a coordinator needs a name", EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "coordinator mint", "usage", "`coordinator mint <name> --repo <path> --as <you> --token <t>` — minting filing authority is an operator act", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, "coordinator mint", authenticated.reason, describeApproveFailure(authenticated.reason, name), EXIT.refused);
    }
    const repos = context.repoList ?? [];
    if (repos.length === 0) {
      return fail(write, json, "coordinator mint", "usage", "--repo names at least one repository this coordinator may file into", EXIT.usage);
    }
    const perHourGiven = text(flags, "per-hour");
    const perHour = perHourGiven === undefined ? undefined : Number(perHourGiven);
    const daysGiven = text(flags, "days");
    const days = daysGiven === undefined ? undefined : Number(daysGiven);
    const made = mintCoordinator(store, {
      name,
      repos,
      ...(perHour === undefined ? {} : { perHour }),
      ...(days === undefined ? {} : { days }),
      by: acting.name,
      now,
    });
    if (!made.ok) {
      const said: Record<string, string> = {
        "bad-name": "a coordinator name is 1-32 characters of a-z, 0-9, and dashes",
        "name-taken": `a live coordinator already answers to \`${name}\` — revoke it first, or pick another name`,
        "bad-rate": "--per-hour is a whole number from 1 to 60, and --days from 1 to 365",
        "no-repos": "--repo names at least one repository",
      };
      return fail(write, json, "coordinator mint", made.reason, said[made.reason] ?? made.reason, made.reason === "name-taken" ? EXIT.refused : EXIT.usage);
    }
    return succeed(write, json, "coordinator mint", { cid: made.cid, token: made.token, repos: made.repos }, () => [
      `Minted ${name}#${made.cid.slice(0, 4)} — may file into:`,
      ...made.repos.map(one => `  ${one}`),
      "",
      `  token  ${made.token}`,
      "",
      `It expires in ${days ?? 90} days: mint a new one before then.`,
      "That token is shown once and is not stored — only a hash of it is.",
      "Give it to the MCP server via a 0600 token file or TOOLROLL_COORDINATOR.",
    ]);
  }

  if (action === "revoke") {
    if (name === undefined) {
      return fail(write, json, "coordinator revoke", "usage", "which coordinator? (`coordinator list` shows cids)", EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "coordinator revoke", "usage", "`coordinator revoke <cid> --as <you> --token <t>` — revoking is an operator act", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, "coordinator revoke", authenticated.reason, describeApproveFailure(authenticated.reason, name), EXIT.refused);
    }
    const revoked = revokeCoordinator(store, name, acting.name, now);
    if (!revoked.ok) {
      const said = revoked.reason === "unknown" ? `no coordinator \`${name}\` — \`coordinator list\` shows cids` : "already revoked";
      return fail(write, json, "coordinator revoke", revoked.reason, said, EXIT.refused);
    }
    return succeed(write, json, "coordinator revoke", { cid: name }, () => [`${name} is revoked — its filings stand, its token does not.`]);
  }

  return fail(write, json, "coordinator", "usage", `unknown \`coordinator ${action}\` — try list, mint, revoke`, EXIT.usage);
}

/**
 * `toolroll mcp` (MCP gateway spec v6): stdio server, coordinator
 * credential from a 0600 token file XOR the environment, non-migrating
 * store open, demo refusal, startup death on a dead credential. stdout
 * is protocol bytes only; everything human goes to stderr.
 */
async function mcpCommand(
  file: string,
  flags: Map<string, string | true>,
  write: Write,
  json: boolean,
): Promise<number> {
  const said = (message: string): number => {
    // Refusals precede protocol traffic. Machine callers (--json) get the
    // standard envelope on stdout — no protocol bytes have flowed yet;
    // humans get stderr, keeping stdout pure for a piped client.
    if (json) write(envelopeJson({ ok: false, command: "mcp", reason: "refused", message }));
    else process.stderr.write(`${message}\n`);
    return EXIT.refused;
  };

  const fromFile = text(flags, "token-file");
  const fromEnv = envValue(process.env, "COORDINATOR");
  if (fromFile !== undefined && fromEnv !== undefined && fromEnv !== "") {
    return said("both --token-file and TOOLROLL_COORDINATOR are set — pick one");
  }
  let token: string;
  if (fromFile !== undefined) {
    // Through the fd (spec v6): no symlink, no FIFO hang, regular file,
    // our uid, exactly 0600, bounded read. Anything else refuses by name.
    let fd: number;
    try {
      fd = openSync(fromFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
      return said(`${fromFile}: cannot open (missing, or a symlink — the token file must be the real file)`);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return said(`${fromFile}: not a regular file`);
      if (stat.uid !== process.getuid?.()) return said(`${fromFile}: owned by somebody else`);
      if ((stat.mode & 0o7777) !== 0o600) return said(`${fromFile}: mode must be exactly 0600 — special bits included`);
      if (stat.size > 4096) return said(`${fromFile}: too large for a token file`);
      const buffer = Buffer.alloc(4096);
      const read = readSync(fd, buffer, 0, 4096, 0);
      token = buffer.subarray(0, read).toString("utf8").trim();
    } finally {
      closeSync(fd);
    }
  } else if (fromEnv !== undefined && fromEnv !== "") {
    token = fromEnv.trim();
  } else {
    return said("no credential — pass --token-file <path> (0600) or set TOOLROLL_COORDINATOR");
  }

  // WAL/SHM are recreated by ANY writer, this server included: nothing
  // this process creates is ever group- or world-readable, and existing
  // db-adjacent files are repaired to 0600 best-effort (review finding 9).
  process.umask?.(0o077);
  const door = openStoreNoMigrate(file);
  if (!door.ok) return said(door.message);
  const store = door.store;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(`${file}${suffix}`, 0o600);
    } catch {
      // Absent (no WAL yet) or not ours — the umask covers what we make.
    }
  }
  try {
    chmodSync(dirname(file), 0o700);
  } catch {
    // Not ours to repair — the boundary statement covers creation.
  }
  if (store.isDemo()) {
    store.close();
    return said("demo console — no gateway");
  }

  // The enrolled-project registry: list_repos answers allowlist ∩ enrolled
  // when it reads; an unreadable registry leaves this null and the tool
  // REFUSES rather than inventing an empty or full answer (fail-closed).
  let enrolled: string[] | null = null;
  try {
    const loaded = await loadRepos(registryPathOf({ databaseFile: file }));
    if (!("error" in loaded)) enrolled = loaded.repos;
  } catch {
    enrolled = null;
  }

  return await new Promise<number>(resolvePromise => {
    let lineHandler: (line: string) => void = () => {};
    let eofHandler: () => void = () => {};
    const reader = createInterface({ input: process.stdin, terminal: false });
    reader.on("line", line => lineHandler(line));
    reader.on("close", () => eofHandler());
    const outcome = serveMcp(store, token, {
      onLine: handler => { lineHandler = handler; },
      onEof: handler => { eofHandler = handler; },
      write: line => process.stdout.write(`${line}\n`),
      log: line => process.stderr.write(`${line}\n`),
      exit: code => {
        reader.close();
        store.close();
        resolvePromise(code);
      },
    }, undefined, enrolled, join(dirname(file), "evidence"));
    if (!outcome.ok) {
      reader.close();
      store.close();
      // The startup death honors the same contract as every other
      // refusal here: an envelope for machine callers, stderr for
      // humans — no protocol bytes ever flowed.
      resolvePromise(said(outcome.message));
    }
  });
}

function describeAuth(reason: string, name: string): string {
  if (reason === "unknown") return `no runner \`${name}\` — register it first`;
  if (reason === "retired") return `${name} has been retired`;
  if (reason === "expired") return `${name}'s token expired a year after it registered — register it again`;
  return "that token does not match";
}

/**
 * Dispatch one task to a builder: lease a checkout, run it, hand it back.
 *
 * Every gate lives in `build()` rather than here, so this cannot forget one.
 * What this owns is the worktree lifecycle around it — including handing the
 * checkout back afterwards, and *not* handing it back when the agent left
 * uncommitted work in it, because that work is somebody's and gets kept.
 */
async function buildCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const demoFence = refuseDemo(context, "build");
  if (demoFence !== null) return demoFence;
  const id = positional[0];
  if (id !== undefined && store.mirrorByTask(id) !== null) {
    // D2 (external dispatch): the debug verb keeps zero mirror surface —
    // tick/watch is the product path, where the completion gate lives.
    return fail(write, json, "build", "external-task", "external work dispatches through tick/watch — the completion gate lives there", EXIT.refused);
  }
  const runner = text(flags, "runner");
  const token = text(flags, "token");
  const branch = text(flags, "branch");

  if (id === undefined || runner === undefined || token === undefined || branch === undefined) {
    return fail(write, json, "build", "usage", "`toolroll build <id> --runner <name> --token <t> --branch <b> --repo <path>`", EXIT.usage);
  }

  const auth = authenticate(store, runner, token);
  if (!auth.ok) {
    return fail(write, json, "build", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }

  const repo = repoFrom(flags);
  // Standalone build proves membership BEFORE leasing anything (MCP spec
  // v6, round-4 finding 2): the caller's --repo is a claim, not authority.
  if (!auth.runner.repos.includes(canonicalProject(repo) ?? resolve(repo))) {
    return fail(write, json, "build", "unauthorized-repo", `${runner} is not bound to ${repo} — \`runner bind\` adds it`, EXIT.refused);
  }
  // Only a task that exists: a lookup must never register an id before the task is filed (its ledger history would be the task's).
  if (store.getTask(id) === null) return fail(write, json, "build", "unknown-task", `No task ${id}.`, EXIT.refused);
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");
  const ref = store.refFor(BUILT_IN, id);

  const worktrees = new WorktreePool(store, { root: pool });
  const leased = await worktrees.lease({
    repo,
    branch,
    runner,
    taskRef: ref.id,
    now,
    ...(text(flags, "base") === undefined ? {} : { base: text(flags, "base") as string }),
  });
  if (!leased.ok) {
    return fail(write, json, "build", leased.reason, leased.message, EXIT.refused);
  }

  // The standalone road records its attempt and carries its exact lease the
  // same as tick's — a park sealed here goes through the same fenced
  // transaction, because a gate one road bypasses is a suggestion. No claim
  // yet is fine: build() refuses no-claim itself, and the run row records
  // that the attempt was made.
  const held = currentClaim(store, ref.id, now);
  // The standalone road PRESENTS the route authority it holds (v48 authority repair): the
  // sealed build leg of a routed task, or nothing on a pre-routing row —
  // the same proof the tick's admission wears, refused in words here.
  // Every road stamps at insert (v48 integrity): a routed row's sealed
  // build leg, a pre-routing row's sealed profile, the bare word on a task
  // with no scope — and a chain approval's base custody rides the same
  // insert (the standalone road never resumes a parked chain tail; the
  // tick's proven transfer does that).
  const standaloneModel = text(flags, "model");
  const authority = store.routeAuthorityFor(ref.id, "builder", null, { provider: "claude", model: standaloneModel ?? null });
  if (authority !== null && !authority.ok) {
    await worktrees.release(leased.worktree.path, now);
    return fail(write, json, "build", "admission-refused", `${id}: ${authority.problem}`, EXIT.refused);
  }
  // The auth mode, strictly, before any row (atomic authority closure):
  // the standalone road opens nothing under a mode file that says
  // neither word — the same reader every other door uses.
  const standaloneMode = readAuthModeStrict(authority === null ? "claude" : (authority.stamp.provider as ProviderId));
  if (!standaloneMode.ok) {
    await worktrees.release(leased.worktree.path, now);
    return fail(write, json, "build", "auth-mode", `${id}: ${standaloneMode.problem}`, EXIT.refused);
  }
  // v105: a used-up budget holds this road too, when the work is billed to an API key.
  const standaloneProvider = authority === null ? "claude" : authority.stamp.provider;
  const standaloneHold = store.budgetGate(now)({ ...store.budgetSubject(ref.id), agents: [{ provider: standaloneProvider, billing: standaloneMode.mode === "api-key" ? "api-key" : billingOf(standaloneProvider, store.handle) }] });
  if (standaloneHold.over !== null) {
    await worktrees.release(leased.worktree.path, now);
    return fail(write, json, "build", "budget", `${id}: ${budgetHoldWords(standaloneHold, monthOf(now).name)}`, EXIT.refused);
  }
  let runId: number;
  try {
    runId = store.startRun({
      taskRef: ref.id,
      leaseId: held?.leaseId ?? "unclaimed",
      runner,
      branch,
      worktree: leased.worktree.path,
      ...(authority === null ? {} : { provider: authority.stamp.provider, route: authority.stamp }),
      ...(standaloneModel === undefined ? {} : { model: standaloneModel }),
      ...(store.approvedChainOf(id) === null ? {} : { custody: { kind: "base" as const } }),
      now,
    });
  } catch (error) {
    await worktrees.release(leased.worktree.path, now);
    return fail(write, json, "build", "admission-refused", error instanceof Error ? error.message : String(error), EXIT.refused);
  }

  const result = await build(store, {
    taskId: id,
    taskRef: ref.id,
    runner,
    ...(held === null ? {} : { leaseId: held.leaseId }),
    runnerToken: token,
    runId,
    evidenceRoot: context.evidenceRoot,
    worktree: leased.worktree.path,
    branch,
    now,
    clock: context.clock,
    ...(text(flags, "model") === undefined ? {} : { model: text(flags, "model") as string }),
    ...(text(flags, "repair-model") === undefined ? {} : { repairModel: text(flags, "repair-model") as string }),
    ...(text(flags, "turns") === undefined ? {} : { maxTurns: Number(text(flags, "turns")) }),
    ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
    ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
  });

  // Handed back either way. A tree with work still in it comes back
  // unverified and is reported rather than cleaned.
  const handedBack = await worktrees.release(leased.worktree.path, now);

  // Disposition through the shared service (Phase 2C), on the standalone
  // policy: run records only — no task completion, no strikes, no
  // publication — exactly this road's historical shape.
  const disposition = disposeBuildOutcome(
    {
      store,
      policy: "standalone",
      leaseId: held?.leaseId,
      runId,
      taskId: id,
      taskRef: ref.id,
      runner,
      repo,
      branch,
      origin: ref.origin,
      provider: "claude",
      model: text(flags, "model") ?? null,
      worktreePath: leased.worktree.path,
      clock: context.clock,
    },
    result,
  );

  if (result.ok && result.parked !== undefined) {
    if (disposition.kind !== "parked") {
      return fail(write, json, "build", "fenced", `${id} parked, but the lease was gone before the decision could be sealed`, EXIT.refused, {
        worktree: leased.worktree.path,
      });
    }
    return succeed(
      write,
      json,
      "build",
      { parked: true, decision: disposition.decisionId, worktree: leased.worktree.path },
      () => [
        `${id} parked a decision instead of guessing.`,
        `  decision  ${disposition.decisionId} — \`toolroll decide ${disposition.decisionId}\``,
        `  worktree  ${leased.worktree.path} (work in progress preserved)`,
      ],
    );
  }

  if (!result.ok) {
    // The exit-code contract separates "no" from "broken", and a build whose
    // agent crashed or timed out *broke* — 3 here taught callers that a dead
    // model and an unapproved scope were the same kind of news. Refusals —
    // the gates saying no — stay 3, which is them working.
    const broke =
      result.reason === "agent" ||
      result.reason === "agent-reported" ||
      result.reason === "no-op" ||
      result.reason === "no-handoff" ||
      result.reason === "moved-head" ||
      result.reason === "timeout" ||
      result.reason === "git" ||
      result.reason === "malformed-decision";
    return fail(write, json, "build", result.reason, result.message, broke ? EXIT.failed : EXIT.refused, {
      worktree: leased.worktree.path,
    });
  }

  return succeed(
    write,
    json,
    "build",
    { ...result, worktree: leased.worktree.path, clean: handedBack.ok },
    () => [
      result.committed
        ? `Built ${id} and committed to ${branch}.`
        : `${id}: no change needed — the agent said so and the tree agrees.`,
      `  worktree  ${leased.worktree.path}`,
      "",
      result.summary,
      "",
      "Nothing has been pushed. Look at the branch before it goes anywhere.",
    ],
  );
}

// ---- the unattended pass --------------------------------------------------

/** An attended authorization whose signed head the leased worktree no
 * longer matches (final authority closure): thrown BEFORE admission so no
 * run opens and no attempt is spent, reported as its own skip reason. */
class StaleAuthorization extends Error {}

/** What happened to one task this pass looked at. */
type TickOutcome = {
  id: string;
  outcome: "built" | "planned" | "reported" | "parked" | "skipped" | "failed" | "contest" | "held" | "stopped" | "reviewed" | "not-reviewed";
  /** Why it was skipped or how it failed; absent on a build. */
  reason?: string;
  /** The gap's own words, when the reason is a capability. */
  detail?: string;
  committed?: boolean;
  branch?: string;
  worktree?: string;
};

/** How a worker's flow pass reaches outside: the tests' seams, or the real commands, network and folders. */
function flowIoOf(context: Context, pool: string, git: CommandRunner, base: string): FlowIo {
  const dir = dirname(context.databaseFile);
  return {
    triggers: { gh: context.flowTriggerIo?.gh ?? run, fetch: context.flowTriggerIo?.fetch ?? fetch, dir: context.flowTriggerIo?.dir ?? dir,
      // A schedule's script (v90) runs like a code step: the same runner, in a clean folder beside the step copies.
      shell: context.flowTriggerIo?.shell ?? context.flowStepIo?.shell ?? run, scratch: context.flowTriggerIo?.scratch ?? context.flowStepIo?.scratch ?? join(pool, "flow-checks"),
      ...(context.flowTriggerIo?.mail === undefined ? {} : { mail: context.flowTriggerIo.mail }) },
    // Replies to cards' emails (v91): read about once a minute, and only while a card is in an email conversation.
    replies: { fetch: context.flowTriggerIo?.fetch ?? fetch, dir: context.flowTriggerIo?.dir ?? dir,
      ...(context.flowTriggerIo?.mail === undefined ? {} : { mail: context.flowTriggerIo.mail }) },
    // Check and update steps run outside a model: an approved command in a fresh copy of the card's work, or a comment on the issue it came from.
    steps: { gh: context.flowStepIo?.gh ?? run, git: context.flowStepIo?.git ?? git, shell: context.flowStepIo?.shell ?? run, fetch: context.flowStepIo?.fetch ?? fetch,
      dir: context.flowStepIo?.dir ?? dir, scratch: context.flowStepIo?.scratch ?? join(pool, "flow-checks"), base,
      ...(context.evidenceRoot === undefined ? {} : { evidenceRoot: context.evidenceRoot }) },
    ...(context.evidenceRoot === undefined ? {} : { evidenceRoot: context.evidenceRoot }),
  };
}

/**
 * One scheduling pass: the M1 loop, without the human typing each step.
 *
 * This is deliberately a pass and not a daemon. M4 owns the loop, the failure
 * taxonomy, and the economics of staying awake; what M1 needs is that a task
 * can go queued → branch → commit with nobody present, and a single pass a
 * cron job can call is the smallest honest shape of that. Run it twice and
 * the fences hold: the second pass finds the first's claims and skips them.
 *
 * The pass never decides what to build — only whether each ready task has
 * already been agreed to. Approval is checked here once to avoid burning a
 * claim on a task the builder would refuse, and checked again inside
 * `build()`, which trusts no caller, this one included.
 *
 * Refusals are sorted by what they mean, not treated alike:
 *
 *   unapproved, scope-changed   waiting on a person — left queued, untouched
 *   lease/branch invariants     this machine's problem — left queued, pass fails
 *   agent, timeout, git         the attempt itself broke — task marked failed
 *
 * The lease is granted for longer than the build may run, so a healthy build
 * cannot outlive its own claim and be reaped mid-commit by the next pass.
 */
async function tickCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const demoFence = refuseDemo(context, "tick");
  if (demoFence !== null) return demoFence;
  const runner = text(flags, "runner");
  const token = text(flags, "token");

  if (runner === undefined || token === undefined) {
    return fail(write, json, "tick", "usage", "`toolroll tick --runner <name> --token <t> --repo <path> [--max <n>] [--base <ref>]`", EXIT.usage);
  }

  // Heartbeat rather than bare auth: a pass that is about to hold leases for
  // half an hour should also be on record as alive.
  const auth = heartbeatRunner(store, runner, token, clock());
  if (!auth.ok) {
    return fail(write, json, "tick", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }
  if (updateAdmissionPaused(store.raw())) return fail(write, json, "tick", "updating", UPDATE_PAUSED, EXIT.refused);

  const maxGiven = text(flags, "max");
  const maxAsked = maxGiven === undefined ? 1 : Number(maxGiven);
  if (!Number.isInteger(maxAsked) || maxAsked <= 0) {
    return fail(write, json, "tick", "usage", "--max takes a whole number of tasks", EXIT.usage);
  }
  // The service's build lanes (project-concurrency.ts): a lane over its
  // project's fair share still runs its housekeeping but starts no
  // unattended build this pass; an extra lane only builds.
  const max = flags.has("yield-builds") ? 0 : maxAsked;
  const buildsOnly = flags.has("builds-only");
  const syncAgeGiven = text(flags, "sync-max-age");
  const syncMaxAgeMs = syncAgeGiven === undefined ? SYNC_MAX_AGE_MS : Number(syncAgeGiven) * 1000;
  if (!Number.isInteger(syncMaxAgeMs) || syncMaxAgeMs <= 0) {
    return fail(write, json, "tick", "usage", "--sync-max-age takes whole seconds", EXIT.usage);
  }

  const repo = repoFrom(flags);
  // THE PRE-I/O MEMBERSHIP CHECK (MCP spec v6, round-4 finding 1): the
  // pass proves its canonical repo is in the runner's BOUND list before
  // any git access, probe, or routine fires. The --repo flag stops being
  // authority on every runner road, not only at the claim.
  if (!auth.runner.repos.includes(canonicalProject(repo) ?? resolve(repo))) {
    return fail(write, json, "tick", "unauthorized-repo", `${runner} is not bound to ${repo} — \`runner bind\` adds it`, EXIT.refused);
  }
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");
  const model = text(flags, "model");
  const repairModel = text(flags, "repair-model");
  const providerFlag = text(flags, "provider");
  const planModel = text(flags, "plan-model");
  const planProvider = text(flags, "plan-provider");
  const turns = text(flags, "turns");
  // The ordinary lease is enough: the build's own pulse extends it while the
  // agent runs, which is the correct causality — the lease stays alive
  // because the build is alive. A fat TTL would only mask a dead pulse and
  // delay recovery by exactly its margin.
  const leaseTtlMs = DEFAULT_LEASE_MS;

  const git = context.gitRunner ?? run;
  const worktrees = new WorktreePool(store, {
    root: pool,
    ...(context.gitRunner === undefined ? {} : { runner: context.gitRunner }),
  });

  // Where a first attempt's branch grows from, resolved once per pass. A
  // detached HEAD refuses the pass rather than guessing: an unattended commit
  // onto "wherever the operator happened to be" is not a default.
  let base = text(flags, "base");
  if (base === undefined) {
    const head = await git("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: repo });
    if (head.code !== 0 || head.stdout.trim() === "") {
      return fail(write, json, "tick", "git", `${repo} has no branch checked out — say --base explicitly`, EXIT.refused);
    }
    base = head.stdout.trim();
  }

  // Probes run at every checkpoint (§3): a key revoked overnight is caught
  // here, before any claim exists — not by the agent, forty thousand tokens
  // in. Statuses land in the store; the gate inside the claim transaction is
  // what acts on them.
  await probeRepo(store, repo, runner, clock());

  // Standing orders fire before the ready set is read, so a fresh instance
  // joins THIS pass. dueRoutines only nominates; every proof — approval
  // digest, pause, due, single-flight, budget — is re-made inside
  // fireRoutine's own transaction, and skipped slots ledger and page
  // themselves there. This loop just reports.
  const routines: { routine: string; outcome: string; taskId?: string; detail?: string }[] = [];
  for (const routine of buildsOnly ? [] : store.dueRoutines(repo, clock())) {
    // The stop fence (audit IV-1): a signal that landed mid-pass stops
    // every further admission — a routine not yet fired stays unfired.
    if (context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true) break;
    const outcome = fireRoutine(store, routine.id, clock());
    routines.push(
      outcome.ok
        ? { routine: routine.name, outcome: "fired", taskId: outcome.taskId }
        : {
            routine: routine.name,
            outcome: outcome.reason,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          },
    );
  }

  // Flows move before the ready set is read, like routines: a card entering
  // a build or research zone files its task now, and that task joins THIS
  // pass. The engine is model-free; approvals the task needs still apply.
  // Triggers first: a schedule, GitHub, Linear or another flow may start
  // cards, which then move in the same pass. Checking an outside service is
  // `gh` or one HTTPS request, never a model, and only when it is due.
  // Each part is one at a time per project, so the worker's own flow cadence (runWatchLoop) and this pass never
  // run the same part twice at once.
  const housekeeping = buildsOnly ? null : await flowHousekeeping(store, repo, clock, flowIoOf(context, pool, git, base),
    () => context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true);
  const triggerPass = housekeeping?.triggers ?? { added: 0, checked: 0, problems: [] };
  const replyPass = housekeeping?.replies ?? { read: 0, taken: 0, problem: null };
  const stepPass = housekeeping?.steps ?? { ran: 0, problems: [] };
  const flowPass: FlowAdvance = housekeeping?.flows ?? { moved: 0, filed: [], problems: [] };
  // Each AI teammate's daily summary to its manager (v92), once, after 5 pm; its weekly report (v97), Monday mornings.
  if (!buildsOnly) try { sendTeammateSummaries(store, repo, clock()); sendTeammateWeeklies(store, repo, clock()); } catch (error) { flowPass.problems.push(`teammate summaries: ${error instanceof Error ? error.message : "could not send"}`); }
  // Undoing a teammate's tool call asked for in chat (v97): made here, as the person who asked.
  if (!buildsOnly && context.shouldStop?.() !== true) {
    try { await runRequestedUndos(store, {}, clock()); }
    catch (error) { flowPass.problems.push(`teammate undo: ${error instanceof Error ? error.message : "could not run"}`); }
  }
  // Tools connected by signing in: a sign-in that runs out within ten minutes is renewed here, so a build or a teammate's call starts with a fresh one.
  if (!buildsOnly && context.shouldStop?.() !== true) {
    try { flowPass.problems.push(...(await refreshConnections(store, [repo], clock(), context.flowStepIo?.fetch === undefined ? {} : { fetcher: context.flowStepIo.fetch })).problems); }
    catch (error) { flowPass.problems.push(`tool sign-ins: ${error instanceof Error ? error.message : "could not renew"}`); }
  }
  // A build, research or check finishing below moves its card at once (moveCardsAfter), not a pass later: by then
  // other builds may hold the worker for minutes.
  let settled = 0;
  const settleFinished = (): void => {
    const finished = dispatched.slice(settled).filter(one => one.outcome !== "skipped" && one.outcome !== "contest").map(one => one.id);
    settled = dispatched.length;
    if (finished.length === 0) return;
    const after = moveCardsAfter(store, repo, finished, clock(), context.evidenceRoot);
    flowPass.moved += after.moved;
    flowPass.filed.push(...after.filed);
    flowPass.problems.push(...after.problems);
  };

  // Tournament housekeeping before the ordinary pass (stage 4): interrupted
  // races recover by CAS, and an ANSWERED question re-admits its parked
  // agent — fresh claim, fresh slot, remaining budget only, the SAME
  // verified checkout on the SAME runner (finding 29's custody rule).
  if (!buildsOnly) recoverContests(store, clock());
  // Expired ceremony nonces are litter with a bound (round-3 finding 30):
  // the mint refuses past 50 open per approver, so the sweep keeps the
  // ceiling meaningful rather than letting dead rows consume it.
  store.sweepCeremonyNonces(clock());
  // Decided tournaments give their checkouts back (stage 6) — this runner's
  // custody only; a checkout that will not release cleanly is flagged and
  // paged, never force-cleaned. Undecided ones escalate once at 14 days.
  if (!buildsOnly) {
    await sweepContestCleanup(store, path => worktrees.release(path, clock()), runner, clock());
    escalateOverdueContests(store, clock());
  }
  const resumed: TickOutcome[] = [];
  // v105: monthly budgets, read when first needed and again after any build (its spend counts): a used-up hard-stop
  // budget holds back new work billed to an API key, on every road below.
  let budgetGate: ReturnType<Store["budgetGate"]> | null = null;
  const budgetHold = (taskRef: number, agents: readonly BudgetAgent[]) => (budgetGate ??= store.budgetGate(clock()))({ ...store.budgetSubject(taskRef), agents });
  const budgetWords = (hold: BudgetHold) => budgetHoldWords(hold, monthOf(clock()).name);
  // Sprint 8: the organisation policy, asked before any claim on every road below: a provider or model it doesn't
  // allow never starts (the task waits, saying which rule and where to change it); terms above its permission ceiling
  // start and run lowered (build() lowers them and says so), except an attended session's, signed at exactly those.
  const policyHold = (agents: readonly ({ profile: ExecutionProfile; attended?: boolean } | { provider: string; model: string | null; session?: string })[]): string | null => {
    for (const agent of agents) {
      if ("profile" in agent) {
        const refused = agent.attended === true ? store.attendedPolicyRefusal(agent.profile) : null;
        if (refused !== null) return refused;
        const verdict = store.runPolicy(agent.profile);
        if (!verdict.ok) return verdict.message;
      } else {
        // A planner or scout has no profile to lower: the ceiling stops one whose provider can't run that low.
        const refused = agent.session !== undefined ? store.sessionPolicyRefusal(agent.provider, agent.model, agent.session) : store.agentPolicyRefusal(agent.provider, agent.model);
        if (refused !== null) return refused;
      }
    }
    return null;
  };
  for (const waiting of buildsOnly ? [] : store.contestsInStates(["decision-wait"])) {
    if (context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true) break;
    // D1 belt-and-braces (external dispatch, finding 41): a mirror and a
    // contest should never coexist; if one ever does, its race resumes
    // NOTHING — no claim, no run, no worktree, no spend.
    const waitingTaskId = store.externalIdFor(waiting.taskRef);
    if (waitingTaskId !== null && store.mirrorByTask(waitingTaskId) !== null) {
      resumed.push({ id: waitingTaskId, outcome: "skipped", reason: "external-race" });
      continue;
    }
    // THE ANSWERED BATCH IS MARKED ACTIVE FIRST (Codex slice-B finding 2):
    // resuming lanes one at a time let the FIRST finisher aggregate the
    // contest while later answered lanes were still 'parked' — excluded
    // from active, their decisions no longer open — stranding them in a
    // contest that had already moved on. 'ready' counts as active, so
    // aggregation waits for the whole batch. Any lane that bails before
    // its build reverts to 'parked' so the next pass retries it.
    const batch: { racer: ReturnType<Store["contestants"]>[number] }[] = [];
    for (const racer of store.contestants(waiting.id).filter(one => one.state === "parked")) {
      if (store.answeredDecisionForContestant(racer.id) === null) continue;
      if (store.casContestantState(racer.id, ["parked"], "ready", racer.generation)) {
        batch.push({ racer });
      }
    }
    for (const { racer } of batch) {
      const backToParked = (): void => {
        const current = store.getContestant(racer.id);
        if (current !== null) store.casContestantState(racer.id, ["ready"], "parked", current.generation);
      };
      if (context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true) {
        backToParked();
        continue;
      }
      const custody = racer.custody === null ? null : (JSON.parse(racer.custody) as { branch: string; head: string | null; runner: string });
      const taskId = store.externalIdFor(waiting.taskRef);
      if (custody === null || custody.runner !== runner || taskId === null) {
        backToParked();
        continue;
      }
      const lanePolicy = policyHold([racer.profile == null ? { provider: racer.provider, model: racer.model } : { profile: racer.profile }]);
      if (lanePolicy !== null) {
        backToParked();
        resumed.push({ id: taskId, outcome: "skipped", reason: "policy", detail: lanePolicy });
        continue;
      }
      const laneBudget = budgetHold(waiting.taskRef, store.agentsFor([racer.provider]));
      if (laneBudget.over !== null) {
        backToParked();
        resumed.push({ id: taskId, outcome: "skipped", reason: "budget", detail: budgetWords(laneBudget) });
        continue;
      }
      // The sign-in pause holds a resumed lane too: it waits, parked, instead of failing.
      const laneGate = signInGate(store, [racer.provider], clock());
      if (laneGate.waiting !== null) {
        backToParked();
        resumed.push({ id: taskId, outcome: "skipped", reason: "signed-out", detail: signInWords(laneGate.waiting) });
        continue;
      }
      // Legacy comparison lanes carried an absolute clock. New profiles use
      // a progress watchdog and may remain alive indefinitely while useful
      // work is observable; only legacy approvals retain their cumulative
      // wall-clock contract.
      const remaining = waiting.kind === "comparison" ? null : racer.budgetMicrousd - racer.accountedMicrousd;
      if (remaining !== null && remaining <= 0) {
        laneGate.giveBack();
        const current = store.getContestant(racer.id);
        if (current !== null) store.casContestantState(racer.id, ["ready"], "stopped", current.generation);
        contestMaybeAggregate(store, waiting.id, clock());
        resumed.push({ id: taskId, outcome: "skipped", reason: "over-ceiling" });
        continue;
      }
      if (waiting.kind === "comparison") {
        const laneProfile = racer.profile ?? contestantProfileOf(racer.provider, racer.model, racer.repairModel);
        const clockCapMs = 3 * laneProfile.timeoutSeconds * 1000;
        if (laneProfile.timeoutKind !== "idle" && store.contestantCumulativeMs(racer.id) >= clockCapMs) {
          laneGate.giveBack();
          const current = store.getContestant(racer.id);
          if (current !== null) store.casContestantState(racer.id, ["ready"], "stopped", current.generation);
          contestMaybeAggregate(store, waiting.id, clock());
          resumed.push({ id: taskId, outcome: "skipped", reason: "over-ceiling" });
          continue;
        }
      }
      const reclaimed = acquire(store, waiting.taskRef, runner, { now: clock(), token, ttlMs: leaseTtlMs });
      if (!reclaimed.ok) {
        laneGate.giveBack();
        backToParked();
        continue;
      }
      const freshContest = store.getContest(waiting.id);
      if (freshContest === null || !store.casContestState(waiting.id, ["decision-wait", "racing"], "racing", freshContest.generation)) {
        release(store, reclaimed.claim.leaseId, clock());
        laneGate.giveBack();
        backToParked();
        continue;
      }
      store.stampContestLease(waiting.id, reclaimed.claim.leaseId, runner, text(flags, "incarnation") ?? null);
      const leased = await worktrees.lease({ repo, branch: racer.branch, runner, taskRef: waiting.taskRef, now: clock() });
      const headCheck = leased.ok ? await git("git", ["rev-parse", "HEAD"], { cwd: leased.worktree.path }) : null;
      if (!leased.ok || (custody.head !== null && headCheck !== null && headCheck.stdout.trim() !== custody.head)) {
        // The tree cannot be proved to be the one the agent left — stop the
        // agent rather than cold-starting against a different history.
        if (leased.ok) await worktrees.release(leased.worktree.path, clock());
        const current = store.getContestant(racer.id);
        if (current !== null) store.casContestantState(racer.id, ["ready"], "stopped", current.generation);
        store.setContestantCleanup(racer.id, "attention");
        contestMaybeAggregate(store, waiting.id, clock());
        release(store, reclaimed.claim.leaseId, clock());
        resumed.push({ id: taskId, outcome: "failed", reason: "contest-custody" });
        continue;
      }
      const [resumeSlot] = store.reserveExecutionSlots(runner, 1, clock());
      const parkedRun = racer.activeRun;
      // A contest lane spends under its race-approved profile and says so
      // at insert (v48 integrity): the lane's proven profile digest, the
      // exact pair it will spend as — the store's own answer, re-proved
      // and bound to the lane inside the admission.
      const laneStamp = store.laneAuthorityFor(racer.id);
      if (laneStamp === null) {
        await worktrees.release(leased.worktree.path, clock());
        release(store, reclaimed.claim.leaseId, clock());
        backToParked();
        resumed.push({ id: taskId, outcome: "failed", reason: "admission-refused", detail: `contestant ${racer.id} is gone` });
        continue;
      }
      // THE LANE ADMISSION (atomic authority closure): the resume opens on
      // the lane under the contest's live custody — this lease, this
      // runner, this watch incarnation, stamped on the contest just above
      // — presenting the lane's stored sealed profile; value-shaped.
      const admittedResume = store.admitContestLane({
        taskRef: waiting.taskRef,
        leaseId: reclaimed.claim.leaseId,
        runner,
        incarnation: text(flags, "incarnation") ?? null,
        branch: racer.branch,
        worktree: leased.worktree.path,
        provider: racer.provider,
        model: racer.model,
        contestant: racer.id,
        ...(parkedRun === null ? {} : { parentRun: parkedRun }),
        now: clock(),
        route: laneStamp,
      });
      if (!admittedResume.ok) {
        await worktrees.release(leased.worktree.path, clock());
        release(store, reclaimed.claim.leaseId, clock());
        backToParked();
        resumed.push({ id: taskId, outcome: "failed", reason: "admission-refused", detail: admittedResume.problem });
        continue;
      }
      const resumeRun = admittedResume.runId;
      // The lane's pointer moved to the resume INSIDE its admission (raw
      // authority repair): from the parked attempt it continues, proved
      // there — no release-then-claim window exists any more.
      const afterClaim = store.getContestant(racer.id);
      if (afterClaim !== null) store.casContestantState(racer.id, ["ready"], "building", afterClaim.generation);
      budgetGate = null; // this build's spend counts toward the next check
      const resumeResult = await build(store, {
        taskId,
        taskRef: waiting.taskRef,
        runner,
        leaseId: reclaimed.claim.leaseId,
        runnerToken: token,
        runId: resumeRun,
        evidenceRoot: context.evidenceRoot,
        worktree: leased.worktree.path,
        branch: racer.branch,
        now: clock(),
        clock,
        provider: racer.provider as ProviderId,
        // v24: the contestant's OWN sealed profile is the authority — the
        // proof holds the lane to it (model, limits, permissions), so no
        // flag-shaped overrides ride along.
        contestProfile: racer.profile ?? contestantProfileOf(racer.provider, racer.model, racer.repairModel),
        ...(remaining === null ? {} : { maxBudgetUsd: Math.min(remaining, laneBudget.remainingMicrousd ?? Infinity) / 1_000_000 }),
        onProviderSpawn: (pid: number) => {
          worktrees.recordProviderOccupancy(leased.worktree.path, runner, pid, leased.worktree.leaseEpoch);
          if (resumeSlot !== undefined) {
            const facts = { run: resumeRun, contestant: racer.id, incarnation: text(flags, "incarnation") ?? null, processGroup: pid };
            if (!store.markSlotRunning(resumeSlot, facts, clock()) && !store.refreshSlotProcess(resumeSlot, facts)) throw new Error("the provider's execution slot no longer belongs to this attempt");
          }
        },
        ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
        ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
        ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
      });
      const resumedRunRow = store.getRun(resumeRun);
      const resumeMeasured =
        resumedRunRow === null || resumedRunRow.providerStartedAt === null
          ? 0
          : resumedRunRow.costUsd !== null
            ? Math.round(resumedRunRow.costUsd * 1_000_000)
            : null;
      let resumedOutcome: "built" | "failed" | "parked" | "stopped" = "failed";
      let resumedCommitted = false;
      if (resumeResult.ok && resumeResult.parked !== undefined) {
        resumedOutcome = "parked";
        const asked = resumeResult.parked.decision;
        const racerDecision = store.saveDecision(
          {
            run: resumeRun,
            contestant: racer.id,
            urgency: asked.urgency,
            recap: asked.recap,
            question: asked.question,
            options: asked.options,
            recommendation: asked.recommendation,
            ...(asked.assignee === null ? {} : { assignee: asked.assignee }),
            ...(asked.deadline === null ? {} : { deadline: asked.deadline }),
          },
          clock(),
        );
        // A racing agent's question pages like any other (arc 3 finding 21):
        // aggregation stays quiet ASSUMING this row already spoke.
        store.enqueueNotification(
          {
            source: { run: resumeRun },
            dedupeKey: `decision:${racerDecision}`,
            kind: "decision",
            subject: `${taskId} parked a decision (${contestNoun(waiting.kind)} agent)`,
            body: `\`toolroll decide ${racerDecision}\``,
            pushClass: "decision",
            link: `/d/${racerDecision}`,
          },
          clock(),
        );
      } else if (resumeResult.ok) {
        resumedOutcome = "built";
        resumedCommitted = resumeResult.committed;
      } else if (resumeResult.reason === "stopped") {
        resumedOutcome = "stopped";
      }
      if (resumedRunRow !== null && resumedRunRow.outcome === null) {
        // The reason rides the resumed run too (Codex slice-B finding 7):
        // both settlement paths, one honesty.
        const resumeReason = !resumeResult.ok ? resumeResult.reason : undefined;
        store.finishRun(resumeRun, {
          outcome: resumedOutcome === "built" && !resumedCommitted ? "no-change" : resumedOutcome === "stopped" ? "failed" : resumedOutcome === "parked" ? "parked" : resumedOutcome,
          committed: resumedCommitted,
          ...(resumeReason === undefined ? {} : { reason: resumeReason }),
          now: clock(),
        });
      }
      if (resumedOutcome === "parked") {
        // Custody refreshes on EVERY park (Codex slice-B finding 9): a
        // re-parked lane whose custody still named the pre-resume head
        // would falsely stop as contest-custody on its next answer.
        const headNow = await git("git", ["rev-parse", "HEAD"], { cwd: leased.worktree.path });
        const dirtyNow = await git("git", ["status", "--porcelain"], { cwd: leased.worktree.path });
        store.setContestantCustody(
          racer.id,
          JSON.stringify({
            branch: racer.branch,
            head: headNow.code === 0 ? headNow.stdout.trim() : null,
            runner,
            dirty: dirtyNow.stdout.trim() !== "",
            at: clock().toISOString(),
          }),
        );
      }
      await worktrees.release(leased.worktree.path, clock());
      const resumedFinal = finalizeContestant(
        store,
        {
          contestId: waiting.id,
          contestantId: racer.id,
          runId: resumeRun,
          outcome: resumedOutcome,
          measuredMicrousd: resumeMeasured,
          slotId: resumeSlot ?? null,
        },
        clock(),
      );
      resumed.push({ id: taskId, outcome: "contest", reason: resumedFinal.aggregated ?? "racing" });
    }
  }

  // THE CHAIN RECONCILER (E3d, review finding 3): a crash between a run's
  // disposition and its cycle resolution leaves an OPEN cycle with a
  // concluded tail — resolve each through the SAME resolver the disposition
  // uses, before any admission can re-tag or race it. Advancing here lands
  // the cycle in pending-admission for THIS pass's chain admission below.
  // One shared piece with the fault tests (F+G review, finding 5).
  if (!buildsOnly) store.reconcileStrandedChains(repo, clock());

  // The DISPATCH view of the queue (queue columns, v19): this runner's own
  // reserved work first, then the shared queue; work reserved for other
  // workers is absent. The claim primitive re-proves the reservation.
  const ready = store.listReady(clock(), runner);
  const considered = ready.length;
  const dispatched: TickOutcome[] = [...resumed];
  // Expired attended authorizations close durably each pass (round-6
  // finding 8): the partial unique frees, and the claim gates stop
  // honoring corpses.
  store.sweepExpiredAuthorizations(clock());
  // The stale-scan (dispatch v3, finding 20): mirrors the courtesy filter
  // kept out of ready are REPORTED here, typed, with a paged episode —
  // an undispatakable tracker item is a 9am fact, not a silent absence.
  const MIRROR_WORDS: Record<string, string> = {
    "stale-mirror": "its tracker has not been synced recently — `toolroll sync` restores freshness",
    "external-closed": "the tracker closed it — reopen it there, then `toolroll task reopen`",
    "dispatch-revoked": "the tracker's building permission was revoked or narrowed",
    "plane-blocked": "the tracker's plane marker could not be verified — building is paused",
  };
  for (const skippedMirror of store.ineligibleMirrors(repo, clock(), syncMaxAgeMs)) {
    dispatched.push({ id: skippedMirror.taskId, outcome: "skipped", reason: skippedMirror.why });
    store.enqueueNotification(
      {
        source: { taskRef: store.lookupRef(skippedMirror.taskId)?.id ?? -1 },
        dedupeKey: `mirror:${skippedMirror.taskId}:${skippedMirror.why}`,
        kind: "external-skipped",
        subject: `${skippedMirror.taskId} cannot dispatch`,
        body: MIRROR_WORDS[skippedMirror.why] ?? "the tracker item is not dispatchable right now",
      },
      clock(),
    );
  }

  let built = 0;
  let parked = 0;
  let broke = 0;

  // One attestation verdict per provider per pass (Phase 3 A3): the
  // gateway re-checks freshly at spawn; this cache only keeps a skipped
  // queue from probing once per task.
  const attestedThisPass = new Map<ProviderId, AttestOutcome | null>();
  let untakenTrial: SignInGate | null = null;
  for (const ref of ready) {
    settleFinished();
    untakenTrial?.giveBack();
    untakenTrial = null;
    // The build budget governs UNATTENDED admissions (round-1 finding 4):
    // once it is spent, the pass keeps SCANNING for attended
    // authorizations — operator-invoked sessions launch regardless —
    // while declining every further ordinary admission.
    if (built >= max) {
      const openAuth = store.openAuthorizationFor(ref.id);
      if (openAuth === null || openAuth.runner !== runner || openAuth.attemptRun !== null) continue;
    }
    // The stop fence (audit IV-1): checked before every claim. The build
    // already in flight finishes under its own bounds; nothing NEW is
    // admitted once the operator has said stop.
    if (context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true) break;
    const id = ref.externalId;

    // A task placed in another repository is not this pass's to build.
    if (ref.repo !== null && ref.repo !== repo) {
      dispatched.push({ id, outcome: "skipped", reason: "other-repo" });
      continue;
    }

    // EVERY live fallback cycle defers the ordinary road (Codex E3d review,
    // finding 5) — a pending admission belongs to the chain pass below, and
    // an open cycle's custody moves only through proven roads, never an
    // in-passing re-tag. The ONE exception: an open cycle whose tail PARKED
    // — the paused lineage — proceeds, and the new run takes custody through
    // the proven parked-resume transfer after it is created.
    const liveCycle = store.fallbackCycleFor(ref.id);
    const parkedChainTail =
      liveCycle !== null && liveCycle.state === "open" && liveCycle.tailRun !== null
        ? store.getRun(liveCycle.tailRun)
        : null;
    if (liveCycle !== null && !(parkedChainTail !== null && parkedChainTail.outcome === "parked")) {
      dispatched.push({ id, outcome: "skipped", reason: "fallback-active" });
      continue;
    }

    // A plan the operator asked for dispatches a PLANNER — the one
    // legitimate spend on a task with no approved scope. Everything else
    // unapproved is a person's pending decision: skip, not refuse — EXCEPT
    // the attended road (Phase 2, v6 W1): a live attended authorization
    // naming THIS runner is authority for one watched attempt, and the
    // skip for everything short of that is its own typed word, never the
    // generic `unapproved` the round-5 review caught masking it.
    const scopeApproved = scopeApprovedForDispatch(store, ref.id, clock());
    const wantsPlan = ref.plan === "requested" && !scopeApproved;
    // A report task with an approved scope dispatches a SCOUT (mate arc
    // §10): the same approval, the planner's read-only road, a report back.
    const wantsScout = ref.deliverable === "report" && scopeApproved;
    let attendedDispatch: import("./store.js").AttendedAuthorization | null = null;
    if (!wantsPlan && !scopeApproved) {
      const open = store.openAuthorizationFor(ref.id);
      const watching =
        open === null
          ? null
          : attendedLivenessState(
              open.lastBeatAt === null ? null : Date.parse(open.lastBeatAt),
              clock().getTime(),
              Date.parse(open.absoluteExpiry),
            );
      if (
        open !== null &&
        open.runner === runner &&
        (watching === "live" || watching === "grace") &&
        open.attemptRun === null &&
        context.heldCoordinator !== undefined
      ) {
        // v28: sessions are unbounded by default; an operator-set cap
        // skips FURTHER launches in words. The gauge is durable custody
        // rows, never the in-process map — a restarted up with orphans
        // pending must count them.
        if (context.maxHeldSessions !== undefined && store.openHeldSessionCount(runner) >= context.maxHeldSessions) {
          dispatched.push({
            id,
            outcome: "skipped",
            reason: "session-cap",
            detail: `this machine holds ${store.openHeldSessionCount(runner)} of ${context.maxHeldSessions} attended sessions — end one, or raise --max-held-sessions`,
          });
          continue;
        }
        attendedDispatch = open;
      } else if (open !== null) {
        dispatched.push({ id, outcome: "skipped", reason: "attended-only" });
        continue;
      } else {
        dispatched.push({ id, outcome: "skipped", reason: "unapproved" });
        continue;
      }
    }

    // TOURNAMENT TERMS FIRST (foundations finding 8's reorder): an approved
    // race's admission is governed by its own fingerprinted terms, and pass
    // flags must not be able to shape it — so the terms are discovered
    // before any flag-shaped resolution runs, and a raced task's build
    // resolution ignores the flags outright.
    const racedAhead = wantsPlan || wantsScout || attendedDispatch !== null ? null : store.activeTournamentTerms(ref.id);
    // The attended spec comes from the authorization's PINNED terms — the
    // courtesy half of the proof; the coordinator's transaction re-proves
    // byte-for-byte at the actual HEAD (v6 W1).
    let attendedSpec: { provider: ProviderId; model: string | null; digest: string; profile: ExecutionProfile } | null = null;
    if (attendedDispatch !== null) {
      try {
        const terms = JSON.parse(attendedDispatch.termsJson) as { profileJson?: unknown };
        const pinned = profileFromJson(typeof terms.profileJson === "string" ? terms.profileJson : null);
        if (pinned !== null) attendedSpec = { provider: pinned.provider, model: pinned.model, digest: profileDigestOf(pinned), profile: pinned };
      } catch {
        attendedSpec = null;
      }
      if (attendedSpec === null) {
        dispatched.push({ id, outcome: "skipped", reason: "attended-only", detail: "the authorization's pinned profile cannot be read" });
        continue;
      }
    }
    // The phase agent, resolved BEFORE anything is claimed and snapshotted
    // into the run: pin > flags > project > installation > default. Planner
    // flags fall back to the pass flags, which is exactly today's behavior
    // when no plan-specific flag is given.
    // THE ROUTE (v47): the sealed route when the approval stands, else the
    // working proposed route, else — with no scope yet — a live
    // recommendation from the task's own risk, overrides, and pins; a row
    // proven to predate routing is the LEGACY road (its sealed profile,
    // then flags and configuration); a routed row whose route cannot be
    // read FAILS CLOSED here, in words. Dispatch resolves each phase from
    // ITS leg: the plan leg for a planner (pass flags may restate it, never
    // contradict it), the SEALED build leg for every routed approval
    // (mutable configuration cannot reroute an approved build).
    const taskRoute = attendedSpec !== null || racedAhead !== null ? null : routeOfTask(store, id, ref, clock());
    if (taskRoute !== null && taskRoute.kind === "unreadable") {
      dispatched.push({ id, outcome: "skipped", reason: "agent-config", detail: taskRoute.problem });
      continue;
    }
    const route = taskRoute !== null && taskRoute.kind === "route" ? taskRoute : null;
    // THE PLANNER'S CLAIM RE-PROVES THE STRICT SCOPE PROJECTION (final
    // authority closure): a planner on a filed, unapproved scope runs
    // under the WORKING route only as the whole scope proves — exact raw
    // terms (a proposed-via marker this code never writes), a resolved
    // profile, a whole fallback chain (an unresolved `[]` is none), route
    // parity with the signed risk, the digest, and the live auth mode
    // agreeing with a chain's pinned base mode. One disagreement skips the
    // task in words before any claim; the admission and the spawn ask the
    // same question again.
    if (wantsPlan && route !== null && route.source === "proposed") {
      const working = store.workingPlanRouteOf(id);
      if (!working.ok) {
        dispatched.push({ id, outcome: "skipped", reason: "agent-config", detail: `${id}: ${working.problem}` });
        continue;
      }
    }
    const planLeg = route === null ? null : legOf(route.route, "plan");
    const sealedBuildLeg = route !== null && route.source === "approved" ? legOf(route.route, "build") : null;
    // A parked chain tail PAST the base (v48 authority repair): its successor resumes the
    // entry's custody and spends as that entry — the exact approved pair
    // under `fallback` provenance — never as the sealed build leg. An
    // entry the approved chain no longer carries under the tail's digest
    // is refused here, in words, before any claim moves.
    let parkedEntry: { index: number; provider: ProviderId; model: string } | null = null;
    if (parkedChainTail !== null && parkedChainTail.chainIndex != null && parkedChainTail.chainIndex > 0 && !wantsPlan && !wantsScout && attendedSpec === null && racedAhead === null) {
      const chain = store.approvedChainOf(id);
      const entry = chain === null ? undefined : chain[parkedChainTail.chainIndex];
      if (entry === undefined || entryDigestOf(entry) !== parkedChainTail.entryDigest) {
        dispatched.push({ id, outcome: "skipped", reason: "stale-approval", detail: `${id}: the parked attempt #${parkedChainTail.id} is bound to fallback entry ${parkedChainTail.chainIndex}, which the approved chain no longer carries — nothing resumes it` });
        continue;
      }
      parkedEntry = { index: parkedChainTail.chainIndex, provider: entry.profile.provider, model: entry.profile.model };
    }
    const planFlagged = planProvider !== undefined || planModel !== undefined || providerFlag !== undefined || model !== undefined;
    if (wantsPlan && planLeg !== null && planFlagged) {
      // Pass flags cannot contradict the task's plan leg: a flag that names
      // a different provider or model is a mismatch, refused in words —
      // `task route --phase plan` is the road to change the planner.
      const flaggedProvider = planProvider ?? providerFlag;
      const flaggedModel = planModel ?? model;
      if ((flaggedProvider !== undefined && flaggedProvider !== planLeg.provider) || (flaggedModel !== undefined && flaggedModel !== planLeg.model)) {
        dispatched.push({
          id,
          outcome: "skipped",
          reason: "agent-config",
          detail: `the pass flags name ${flaggedProvider ?? planLeg.provider}${flaggedModel === undefined ? "" : ` · ${flaggedModel}`} but ${id}'s planner is ${planLeg.provider} · ${planLeg.model} — flags cannot reroute a task; override the plan phase with \`task route\``,
        });
        continue;
      }
    }
    const resolution = attendedSpec !== null
      ? null
      : wantsPlan
        ? planLeg !== null
          ? resolvePhaseAgent(store, "plan", repo, { provider: planLeg.provider, model: planLeg.model })
          : resolvePhaseAgent(store, "plan", repo, {
              // The legacy road (P2/C7 precedence): the task's plan PIN
              // beats every flag and config row; flags beat config.
              provider: ref.planProvider ?? planProvider ?? providerFlag,
              model: ref.planProvider !== null ? (ref.planModel ?? undefined) : (planModel ?? model),
            })
        : racedAhead !== null
          ? resolvePhaseAgent(store, "build", repo, {}, ref)
          : parkedEntry !== null
            ? resolvePhaseAgent(store, "build", repo, { provider: parkedEntry.provider, model: parkedEntry.model })
            : sealedBuildLeg !== null
              ? resolvePhaseAgent(store, "build", repo, { provider: sealedBuildLeg.provider, model: sealedBuildLeg.model }, ref)
              : resolvePhaseAgent(store, "build", repo, { provider: providerFlag, model }, ref);
    if (resolution !== null && !resolution.ok) {
      dispatched.push({ id, outcome: "skipped", reason: "agent-config", detail: resolution.problem });
      continue;
    }
    const spec = resolution === null ? (attendedSpec as { provider: ProviderId; model: string | null }) : resolution.spec;
    // THE AUTH MODE, strictly, before any claim or row (atomic authority
    // closure): a present mode file for the provider this pass would spend
    // as that says neither word is a stated problem — the same reader the
    // filing, the seal, and the spawn use — and the task is skipped in
    // words with nothing opened, never dispatched to be refused later.
    const modeProviders: ProviderId[] = racedAhead !== null ? racedAhead.agents.filter(agent => isProviderId(agent.provider)).map(agent => agent.provider as ProviderId) : [spec.provider];
    const brokenMode = [...new Set(modeProviders)].map(one => readAuthModeStrict(one)).find(one => !one.ok);
    if (brokenMode !== undefined && !brokenMode.ok) {
      dispatched.push({ id, outcome: "skipped", reason: "auth-mode", detail: brokenMode.problem });
      continue;
    }
    // THE SIGN-IN PAUSE: a provider whose sign-in stopped working takes no
    // new work — no claim, no run, never a substitute (a lapsed login must not
    // reach a paid fallback) — until a run or check on it works again or a
    // person resumes it. Other providers keep working.
    // One task every AUTH_TRIAL_MS goes ahead as the trial: a sign-in check
    // can say "logged in" for a session that cannot refresh, so a real run
    // decides — it lifts the pause, or fails into the same incident.
    const gate = signInGate(store, modeProviders, clock(), ref.id);
    if (gate.waiting !== null) {
      dispatched.push({ id, outcome: "skipped", reason: "signed-out", detail: signInWords(gate.waiting) });
      continue;
    }
    // A trial whose task is skipped before its claim succeeds is given back
    // at the next task (or after the pass), so the next pass may take it.
    untakenTrial = gate;
    // The leg is the authority: what resolved must BE the leg, exactly —
    // the sealed build leg, or the parked fallback entry's own pair.
    const governingLeg = wantsPlan ? planLeg : parkedEntry !== null ? { provider: parkedEntry.provider, model: parkedEntry.model, chosen: "fallback" as const } : sealedBuildLeg;
    if (governingLeg !== null && (spec.provider !== governingLeg.provider || spec.model !== governingLeg.model)) {
      dispatched.push({ id, outcome: "skipped", reason: "agent-config", detail: `${id}: the ${wantsPlan ? "plan" : "build"} leg names ${governingLeg.provider} · ${governingLeg.model} but resolution produced ${spec.provider} · ${spec.model ?? "(no model)"} — nothing substitutes` });
      continue;
    }
    // Route provenance for the run this pass opens (v47): PRESENTED to the
    // admission transaction, from the leg that governs it — the store
    // dictates nothing (v48 authority repair). A parked fallback entry's successor presents
    // `fallback` under the sealed route — there is no chain-only digest
    // (raw authority repair): with no sealed route it presents nothing,
    // and the admission refuses in words.
    // Every road presents at insert (v48 integrity): an attended session
    // its pinned profile; a pre-routing row its sealed profile (or the
    // bare word on a task with no scope) — the store's own answer, so the
    // admission proves exactly what the row holds.
    const routeStamp = (phase: "plan" | "build"): RouteStamp | null => {
      if (attendedSpec !== null && phase === "build") {
        return { routeDigest: `profile:${attendedSpec.digest}`, phase, provider: spec.provider, model: spec.model, chosen: "legacy" };
      }
      // A task with NO scope holds no filed route (final authority
      // closure): its planner presents the bare word `legacy` for the pair
      // the live recommendation resolved — the recommendation chose the
      // agent, but nothing anybody filed is the authority it spends under.
      if (governingLeg === null || route === null || (phase === "plan" && route.source === "live")) {
        const legacy = store.routeAuthorityFor(ref.id, phase === "plan" ? "planner" : "builder", null, { provider: spec.provider, model: spec.model });
        return legacy !== null && legacy.ok ? legacy.stamp : null;
      }
      if (parkedEntry !== null && phase === "build") {
        return { routeDigest: routeDigestOf(route.route), phase, provider: spec.provider, model: spec.model, chosen: "fallback" };
      }
      return { routeDigest: routeDigestOf(route.route), phase, provider: spec.provider, model: spec.model, chosen: governingLeg.chosen };
    };

    // THE LEGACY STALE CHECK, before any claim or row (v48 integrity): a
    // pre-routing row's sealed profile is the only authority its build
    // can present, and what resolved from today's flags and configuration
    // must BE that pair. A disagreement used to open a row and refuse it
    // at the dispatch proof; now nothing opens — the task is held under
    // the same backoff the approval door lifts, and paged once.
    if (!wantsPlan && !wantsScout && attendedSpec === null && racedAhead === null && route === null) {
      const legacyStamp = routeStamp("build");
      if (legacyStamp !== null && (legacyStamp.provider !== spec.provider || legacyStamp.model !== spec.model)) {
        const message = `${id}: the sealed profile builds on ${legacyStamp.provider} · ${legacyStamp.model ?? "(no model)"} but today's routing resolved ${spec.provider} · ${spec.model ?? "(no model)"} — nothing runs on it (stale-approval)`;
        holdStaleApproval(store, { taskRef: ref.id, taskId: id, message }, clock());
        dispatched.push({ id, outcome: "skipped", reason: "stale-approval", detail: message });
        continue;
      }
    }

    // THE READINESS HALT (v47): a provider THIS runner has reported
    // unavailable never claims and never spends — no substitution, no
    // second-best; the skip names the observation and the ways out.
    // Unknown readiness passes (every existing gate still applies); a
    // raced task halts if any lane's provider is unavailable, because a
    // subset is a different contest than the one signed. The ONE road
    // onward is an EXPLICITLY APPROVED fallback chain: when the sealed
    // build leg's provider is unavailable, the task moves to the approved
    // next entry — that one and no other — and the chain admission pass
    // below runs it after re-proving everything; otherwise it fails closed.
    {
      const providersToProve = racedAhead !== null ? racedAhead.agents.map(agent => agent.provider) : [spec.provider];
      const unavailable = providersToProve
        .map(candidate => store.runnerReadinessOf(runner, candidate))
        .find(seen => seen !== null && seen.state === "unavailable");
      if (unavailable !== undefined && unavailable !== null) {
        const observed = `${unavailable.provider} is reported unavailable on ${runner} (${unavailable.reason}; observed ${unavailable.observedAt})`;
        const onward =
          !wantsPlan && !wantsScout && racedAhead === null && attendedSpec === null && sealedBuildLeg !== null
            ? store.skipUnavailablePrimary(ref.id, id, repo, runner, clock())
            : null;
        dispatched.push({
          id,
          outcome: "skipped",
          reason: "provider-unavailable",
          detail:
            onward !== null && onward.ok
              ? `${observed} — moving to the approved fallback ${onward.next.provider} · ${onward.next.model}, the only substitution the approval allows; it is admitted next`
              : `${observed} — nothing substitutes for a routed provider${onward === null || onward.reason === "no-chain" ? "" : ` (${onward.detail})`}: override the phase with \`task route\` or restore the provider and report readiness again`,
        });
        continue;
      }
    }

    // THE PRE-CLAIM ATTESTATION SKIP (Phase 3 A3/B4/C2): an attested
    // provider outside its range never claims — no lease, no run row, no
    // worktree, no wake churn. The provider source is the AUTHORITATIVE
    // one per road: the sealed approval snapshot for ordinary builds (the
    // same snapshot the dispatch proof enforces), the plan resolver for
    // planner runs. Attended work is claude-only and excluded; tournament
    // contestants cannot be tier-2 today (the money gate refuses them at
    // filing). A missing or malformed snapshot is NOT skipped here — the
    // existing approval refusals own that road, and attestation must
    // never mask them. The gateway re-checks before spawn; this skip only
    // keeps the normal road cheap.
    const skipProviders: ProviderId[] =
      attendedSpec !== null
        ? []
        : racedAhead !== null
          ? // The contest road (slice B): every lane's provider, so an
            // out-of-range attested lane skips the WHOLE contest before
            // any claim — running a subset is a different contest than
            // the one the operator signed.
            racedAhead.agents.filter(agent => isProviderId(agent.provider)).map(agent => agent.provider as ProviderId)
          : wantsPlan
            ? [spec.provider]
            : ([store.getScope(id)?.approvedProfile?.provider].filter((one): one is ProviderId => one !== null && one !== undefined) as ProviderId[]);
    let unattestedLane: string | null = null;
    for (const candidate of new Set(skipProviders)) {
      if (attestationOf(candidate) === null) continue;
      let verdict = attestedThisPass.get(candidate);
      if (verdict === undefined) {
        verdict = await attestProvider(candidate, inspectionOf(candidate).binary);
        attestedThisPass.set(candidate, verdict);
      }
      if (verdict !== null && !verdict.ok) {
        unattestedLane = verdict.problem;
        break;
      }
    }
    if (unattestedLane !== null) {
      dispatched.push({ id, outcome: "skipped", reason: "provider-unattested", detail: unattestedLane });
      continue;
    }

    // Sprint 8: the organisation policy before the claim (build() looks again before spawn, and lowers).
    {
      const sealed = wantsPlan || wantsScout ? null : store.approvedChainOf(id)?.[0]?.profile ?? store.getScope(id)?.approvedProfile ?? null;
      const refused = racedAhead !== null ? policyHold(racedAhead.agents.map(agent => ({ provider: agent.provider, model: agent.model })))
        : policyHold([attendedSpec !== null ? { profile: attendedSpec.profile, attended: true } : sealed !== null ? { profile: sealed }
          : { provider: spec.provider, model: spec.model, ...(wantsPlan ? { session: "planning" } : wantsScout ? { session: "scouting" } : {}) }]);
      if (refused !== null) {
        dispatched.push({ id, outcome: "skipped", reason: "policy", detail: refused });
        continue;
      }
    }

    // v105: a monthly budget that stops new API work, used up: the task waits in the queue until the month turns or the
    // budget is raised (the 100% alert went out; the task page and the spend page say why).
    // Budgets are dollars: work that runs only on subscriptions passes (see Store.budgetGate).
    // A chain's base entry says how it bills (a pinned key); otherwise each provider as it bills now.
    const chainBase = wantsPlan || wantsScout ? undefined : store.approvedChainOf(id)?.[0];
    const budgeted = budgetHold(ref.id, chainBase !== undefined ? [{ provider: chainBase.profile.provider, billing: chainBase.authMode }] : store.agentsFor([spec.provider, ...skipProviders]));
    if (budgeted.over !== null) {
      dispatched.push({ id, outcome: "skipped", reason: "budget", detail: budgetWords(budgeted) });
      continue;
    }

    // THE DAILY RAIL (modes chain D4): a live mode's run cap reserves at
    // admission — atomic, so two watch loops cannot both slip under it.
    // Attended sessions and raced tasks reserve on their own roads below;
    // an ordinary/planner start reserves ONE here. No mode = no-op.
    if (attendedDispatch === null && racedAhead === null && repo !== null) {
      const railed = store.reserveModeRail(repo, 1, clock());
      if (!railed.ok) {
        dispatched.push({ id, outcome: "skipped", reason: railed.rail, detail: railed.detail });
        continue;
      }
    }

    const claimed = acquireIfReady(store, ref.id, runner, {
      ...(wantsPlan ? { dispatchRole: "planner" as const } : wantsScout ? { dispatchRole: "scout" as const } : {}),
      now: clock(),
      token,
      ttlMs: leaseTtlMs,
      syncMaxAgeMs,
      repo,
      provider: spec.provider,
      ...(spec.model === null ? {} : { model: spec.model }),
      ...(text(flags, "incarnation") === undefined ? {} : { incarnation: text(flags, "incarnation") as string }),
      ...(text(flags, "max-open-decisions") === undefined
        ? {}
        : { maxOpenDecisions: Number(text(flags, "max-open-decisions")) }),
    });
    if (claimed.ok) untakenTrial = null;
    if (!claimed.ok) {
      // Losing a race, finding the task no longer ready, and a machine that
      // lacks what the task needs are all the system working. None fails the
      // pass; a capability gap names itself so the gaps report can too.
      if (claimed.reason === "capability" && "message" in claimed) {
        // A gap is a fact that wants a person. One notification per episode:
        // the dedupe key holds until the capability verifies, then the next
        // failure is a new fact and says so again.
        const key = /needs (\S+)/.exec(claimed.message)?.[1];
        const parsed = key === undefined ? null : parseCapabilityKey(key);
        if (parsed !== null) {
          const home = ref.repo ?? repo;
          store.enqueueNotification(
            {
              source: { taskRef: ref.id },
              dedupeKey: `gap:${home}:${parsed.kind}:${parsed.name}`,
              kind: "gap",
              // A gap that blocks work wants a person NOW (v4 review,
              // finding 6): it pages singly whatever the digest cadence.
              pushClass: "attention",
              link: "/caps",
              subject: `${key} blocks work in ${home}`,
              body: `${id} (and possibly others) cannot dispatch: ${claimed.message}. \`toolroll gaps --repo ${home}\``,
            },
            clock(),
          );
        }
      }
      dispatched.push({
        id,
        outcome: "skipped",
        reason: claimed.reason,
        ...("message" in claimed && claimed.reason === "capability" ? { detail: claimed.message } : {}),
      });
      continue;
    }
    const lease = claimed.claim.leaseId;

    // A tournament rides this claim (stage 3b): approved race terms send N
    // agents instead of one builder. Everything after admission either
    // reaches the ready barrier for ALL agents or interrupts the whole
    // tournament — a partial race is never dispatched (finding 19).
    const raceTerms = racedAhead;
    if (raceTerms !== null && raceTerms.approvedDigest === raceTerms.raceDigest) {
      const admittedKind = raceTerms.kind;
      // The rail reserves every lane at once (D4) — a tournament is N
      // starts from one filing. Refused before any skeleton exists.
      if (repo !== null) {
        const railedRace = store.reserveModeRail(repo, raceTerms.n, clock());
        if (!railedRace.ok) {
          dispatched.push({ id, outcome: "skipped", reason: railedRace.rail, detail: railedRace.detail });
          continue;
        }
      }
      const scopeRow = store.getScope(id);
      const admitted = admitContest(
        store,
        {
          taskId: id,
          taskRef: ref.id,
          runner,
          leaseId: lease,
          incarnation: text(flags, "incarnation") ?? null,
          scopeDigest: scopeRow?.digest ?? "",
          scopeApproved: scopeRow !== null && scopeApprovedForDispatch(store, ref.id, clock()),
          // 'tasks' capacity mode keeps the claim-counted contract; the
          // slot ledger records regardless (finding 26).
          capacity: null,
          quotaBlocked: (provider, model) => store.quotaState(runner, provider, model, clock())?.state ?? null,
        },
        clock(),
      );
      if (!admitted.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "skipped", reason: admitted.reason });
        continue;
      }
      const interrupt = async (why: string, leasedPaths: string[]): Promise<void> => {
        const fresh = store.getContest(admitted.contestId);
        if (fresh !== null) store.casContestState(admitted.contestId, ["dispatching", "racing"], "interrupted", fresh.generation);
        store.releaseSlotsForContest(admitted.contestId, clock());
        for (const path of leasedPaths) await worktrees.release(path, clock());
        release(store, lease, clock());
        dispatched.push({ id, outcome: "failed", reason: why });
        broke++;
      };
      const baseRead = await git("git", ["rev-parse", "HEAD"], { cwd: repo });
      if (baseRead.code !== 0) {
        await interrupt("contest-base", []);
        continue;
      }
      const baseSha = baseRead.stdout.trim();
      store.stampContestDispatch(admitted.contestId, baseSha, store.liveWorktreeSetup(repo)?.digest ?? null);
      const agents = store.contestants(admitted.contestId);
      const prepared: { contestantId: number; slotId: number; runId: number; worktree: string; branch: string; leaseEpoch: string | null }[] = [];
      let prepFailed = false;
      for (const [index, agent] of agents.entries()) {
        const leased = await worktrees.lease({ repo, branch: agent.branch, runner, taskRef: ref.id, now: clock(), base: baseSha });
        if (!leased.ok) {
          prepFailed = true;
          break;
        }
        store.setContestantWorktree(agent.id, leased.worktree.path);
        // The lane's provenance rides its insert (v48 integrity): the
        // race-approved profile it will be proved against, exactly — the
        // store's own answer, re-proved and bound to the lane there.
        const laneStamp = store.laneAuthorityFor(agent.id);
        if (laneStamp === null) {
          prepFailed = true;
          break;
        }
        // THE LANE ADMISSION (atomic authority closure): under the custody
        // admitContest stamped — this lease, runner, and incarnation.
        const admittedLane = store.admitContestLane({
          taskRef: ref.id,
          leaseId: lease,
          runner,
          incarnation: text(flags, "incarnation") ?? null,
          branch: agent.branch,
          worktree: leased.worktree.path,
          provider: agent.provider,
          model: agent.model,
          contestant: agent.id,
          now: clock(),
          route: laneStamp,
        });
        if (!admittedLane.ok) {
          prepFailed = true;
          break;
        }
        const contestantRun = admittedLane.runId;
        // The lane's pointer was bound inside the insert above (raw
        // authority repair); nothing claims it after the fact.
        prepared.push({
          contestantId: agent.id,
          slotId: admitted.slotIds[index] ?? -1,
          runId: contestantRun,
          worktree: leased.worktree.path,
          branch: agent.branch,
          leaseEpoch: leased.worktree.leaseEpoch ?? null,
        });
      }
      const freshContest = store.getContest(admitted.contestId);
      if (prepFailed || freshContest === null || !crossReadyBarrier(store, freshContest, admitted.contestantIds)) {
        await interrupt("contest-admission", prepared.map(one => one.worktree));
        continue;
      }
      // Every agent is READY and nothing has spawned: cross into racing and
      // spend. The builds run concurrently; the stop fence stops them all.
      budgetGate = null; // the race's spend counts toward the next check
      // v105: the lanes run at once, so they share what's left of a monthly budget.
      const laneShare = budgeted.remainingMicrousd === null ? null : Math.max(1, Math.floor(budgeted.remainingMicrousd / Math.max(1, prepared.length)));
      const settled = await Promise.allSettled(
        prepared.map(async entry => {
          const agent = store.getContestant(entry.contestantId);
          if (agent === null) throw new Error("contestant vanished");
          store.casContestantState(entry.contestantId, ["ready"], "building", agent.generation);
          return build(store, {
            taskId: id,
            taskRef: ref.id,
            runner,
            leaseId: lease,
            runId: entry.runId,
            evidenceRoot: context.evidenceRoot,
            worktree: entry.worktree,
            branch: entry.branch,
            now: clock(),
            clock,
            provider: agent.provider as ProviderId,
            contestProfile: contestantProfileOf(agent.provider, agent.model, agent.repairModel),
            // A comparison lane has no dollar cap — the sealed clock is the
            // bound; only race lanes carry the harness stop (E1).
            ...(agent.budgetMicrousd > 0 ? { maxBudgetUsd: Math.min(agent.budgetMicrousd, laneShare ?? Infinity) / 1_000_000 } : {}),
            onProviderSpawn: pid => {
              worktrees.recordProviderOccupancy(entry.worktree, runner, pid, entry.leaseEpoch);
              const facts = { run: entry.runId, contestant: entry.contestantId, incarnation: text(flags, "incarnation") ?? null, processGroup: pid };
              if (!store.markSlotRunning(entry.slotId, facts, clock()) && !store.refreshSlotProcess(entry.slotId, facts)) throw new Error("the provider's execution slot no longer belongs to this attempt");
            },
            ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
            ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
            ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
          });
        }),
      );
      let lastAggregate: string | null = null;
      for (const [index, entry] of prepared.entries()) {
        const outcome = settled[index];
        const run = store.getRun(entry.runId);
        const measured =
          run === null || run.providerStartedAt === null
            ? 0
            : run.costUsd !== null
              ? Math.round(run.costUsd * 1_000_000)
              : null;
        let contestantOutcome: "built" | "failed" | "parked" | "stopped" = "failed";
        let committed = false;
        if (outcome !== undefined && outcome.status === "fulfilled") {
          const result = outcome.value;
          if (result.ok && result.parked !== undefined) {
            contestantOutcome = "parked";
            // The question still reaches the operator, tagged with its agent;
            // decision-wait mechanics land in stage 4 — the card works today.
            const asked = result.parked.decision;
            const contestantDecision = store.saveDecision(
              {
                run: entry.runId,
                contestant: entry.contestantId,
                urgency: asked.urgency,
                recap: asked.recap,
                question: asked.question,
                options: asked.options,
                recommendation: asked.recommendation,
                ...(asked.assignee === null ? {} : { assignee: asked.assignee }),
                ...(asked.deadline === null ? {} : { deadline: asked.deadline }),
              },
              clock(),
            );
            store.enqueueNotification(
              {
                source: { run: entry.runId },
                dedupeKey: `decision:${contestantDecision}`,
                kind: "decision",
                subject: `${id} parked a decision (${contestNoun(admittedKind)} agent)`,
                body: `\`toolroll decide ${contestantDecision}\``,
                pushClass: "decision",
                link: `/d/${contestantDecision}`,
              },
              clock(),
            );
          } else if (result.ok) {
            contestantOutcome = "built";
            committed = result.committed;
          } else if (result.reason === "stopped") {
            contestantOutcome = "stopped";
          }
        }
        if (run !== null && run.outcome === null) {
          // The reason rides the run (slice B, E2 — kind-agnostic): "lane 3
          // failed" with no words when a binary drifted out of its attested
          // range is exactly the silence the attested runtime rules out.
          const laneReason =
            outcome !== undefined && outcome.status === "fulfilled" && !outcome.value.ok
              ? outcome.value.reason
              : undefined;
          store.finishRun(entry.runId, {
            outcome: contestantOutcome === "built" && !committed ? "no-change" : contestantOutcome === "stopped" ? "failed" : contestantOutcome === "parked" ? "parked" : contestantOutcome,
            committed,
            ...(laneReason === undefined ? {} : { reason: laneReason }),
            now: clock(),
          });
        }
        if (contestantOutcome === "parked") {
          // Custody (round-3 finding 29): who owns this checkout while the
          // question waits, and what exact state it was left in — the
          // resume verifies all of it before trusting the tree again.
          const headNow = await git("git", ["rev-parse", "HEAD"], { cwd: entry.worktree });
          const dirtyNow = await git("git", ["status", "--porcelain"], { cwd: entry.worktree });
          store.setContestantCustody(
            entry.contestantId,
            JSON.stringify({
              branch: entry.branch,
              head: headNow.code === 0 ? headNow.stdout.trim() : null,
              runner,
              dirty: dirtyNow.stdout.trim() !== "",
              at: clock().toISOString(),
            }),
          );
        }
        await worktrees.release(entry.worktree, clock());
        const final = finalizeContestant(
          store,
          {
            contestId: admitted.contestId,
            contestantId: entry.contestantId,
            runId: entry.runId,
            outcome: contestantOutcome,
            measuredMicrousd: measured,
            slotId: entry.slotId >= 0 ? entry.slotId : null,
          },
          clock(),
        );
        if (final.aggregated !== null) lastAggregate = final.aggregated;
      }
      dispatched.push({ id, outcome: "contest", reason: lastAggregate ?? "racing" });
      continue;
    }

    if (wantsPlan) {
      // THE FILED REQUEST, FIRST (contract handoff, task 1): everything the
      // operator filed — scope, rubric, terms, revision brief, earlier
      // answers — assembled and measured against its byte cap BEFORE a
      // workspace is leased or a provider spends. Over the cap, or a brief
      // that cannot be read, is a refusal in words here: nothing trims a
      // criterion silently, and nothing plans against half a contract.
      const answers = store
        .answeredDecisionsFor(id, 6)
        .map(one => ({ question: one.question, choice: one.choice ?? "", note: one.note }));
      const sourced = plannerSourceOf(store, context.evidenceRoot, id, answers);
      if (!sourced.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "skipped", reason: `planner-source-${sourced.reason}`, detail: sourced.message });
        continue;
      }
      // The planner's workspace is disposable and its branch namespace is
      // its own — never the builder's, so a later build starts from base
      // with nothing a planning session could have left as an ancestor
      // (Codex planning review, finding 1).
      const planBranch = await existingOrFirst([`toolroll-plan/${id}`, `standing-orders-plan/${id}`], async one => (await git("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${one}`], { cwd: repo })).code === 0);
      // A revision is planned on the work it revises: the verified head its build will start from.
      const revised = ref.revisionOf === null ? null : revisionSourceHead(store, context.evidenceRoot, ref.id, ref.revisionOf);
      if (revised !== null && !revised.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "skipped", reason: "revision-brief", detail: revised.problem });
        continue;
      }
      const planLeased = await worktrees.lease({
        repo,
        branch: planBranch,
        runner,
        taskRef: ref.id,
        now: clock(),
        base: revised?.head ?? base,
        // A plan branch from an earlier plan (its checkout removed by storage retention) is reused, as its kept checkout was.
        reuseBranch: true,
        reclaim: { evidenceRoot: context.evidenceRoot },
      });
      if (!planLeased.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "failed", reason: planLeased.reason });
        broke++;
        continue;
      }
      // Route provenance (v47): the planner names the route it ran under —
      // a live recommendation before any scope exists — and its exact leg,
      // stamped in the admission transaction.
      const planStamp = routeStamp("plan");
      const planRunId = store.startRun({
        taskRef: ref.id,
        leaseId: lease,
        runner,
        role: "planner",
        provider: spec.provider,
        branch: planBranch,
        worktree: planLeased.worktree.path,
        ...(spec.model === null ? {} : { model: spec.model }),
        now: clock(),
        ...(planStamp === null ? {} : { route: planStamp }),
      });
      // The source is RECORDED on the attempt before the brief is even
      // composed: the exact bytes the planner reads, sealed as evidence,
      // and the filed scope's digest stamped as what this run was proved
      // against. A record that cannot be written ends the attempt here —
      // an unrecorded input is the loss this road exists to prevent.
      let sourceArtifact: number;
      try {
        sourceArtifact = storeEvidence(
          store,
          context.evidenceRoot,
          planRunId,
          "plan-contract",
          "planner-source.json",
          encodePlannerSource(sourced.source),
          `planner source ${sourced.source.sourceDigest.slice(0, 12)} — the filed request quoted into the brief, recorded before spend (${sourced.bytes} bytes)`,
          clock(),
          { captureStatus: "ok" },
        );
      } catch (error) {
        await worktrees.release(planLeased.worktree.path, clock());
        const unrecorded = finalizePlanFailureFenced(store, {
          leaseId: lease,
          runId: planRunId,
          taskId: id,
          kind: "failure",
          message: `the planner's source could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
          now: clock(),
        });
        dispatched.push({ id, outcome: "failed", reason: "evidence" });
        if (!unrecorded.ok) release(store, lease, clock());
        broke++;
        continue;
      }
      store.stampRun(planRunId, { scopeDigest: sourced.source.contract.scope?.digest ?? "" });
      budgetGate = null; // this planner's spend counts toward the next check
      const outcome = await planTask(store, {
        ...(budgeted.remainingMicrousd === null ? {} : { maxBudgetUsd: Math.max(1, budgeted.remainingMicrousd) / 1_000_000 }),
        taskId: id,
        taskTitle: store.getTask(id)?.title ?? id,
        taskRef: ref.id,
        runner,
        leaseId: lease,
        runnerToken: token,
        runId: planRunId,
        worktree: planLeased.worktree.path,
        branch: planBranch,
        now: clock(),
        clock,
        onProviderSpawn: pid => { worktrees.recordProviderOccupancy(planLeased.worktree.path, runner, pid, planLeased.worktree.leaseEpoch); },
        evidenceRoot: context.evidenceRoot,
        answers,
        source: sourced.source,
        provider: spec.provider,
        ...(spec.model === null ? {} : { model: spec.model }),
        ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
        ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
      });
      await worktrees.release(planLeased.worktree.path, clock());

      if (outcome.ok && "parked" in outcome) {
        const sealed = finalizeParkFenced(store, {
          leaseId: lease,
          runId: planRunId,
          taskId: id,
          decision: outcome.parked.decision,
          artifactIds: outcome.parked.artifactIds,
          repairRunId: outcome.parked.repairRunId,
          now: clock(),
        });
        if (sealed.ok) {
          store.resetPlanStrikes(ref.id);
          dispatched.push({ id, outcome: "parked", reason: `decision:${sealed.decisionId}` });
          parked++;
        } else if (sealed.reason === "stopped") {
          dispatched.push({ id, outcome: "stopped", reason: `stop:${planRunId}` });
        } else {
          dispatched.push({ id, outcome: "failed", reason: "fenced" });
          broke++;
        }
        continue;
      }
      if (outcome.ok) {
        const sealed = finalizePlanFenced(store, {
          leaseId: lease,
          runId: planRunId,
          taskId: id,
          plan: outcome.drafted.plan,
          artifact: outcome.drafted.artifact,
          repairRunId: outcome.drafted.repairRunId,
          source: sourced.source,
          sourceArtifact,
          evidenceRoot: context.evidenceRoot,
          now: clock(),
        });
        if (sealed.ok) {
          store.clearQuota(runner, spec.provider, spec.model ?? "");
          dispatched.push({ id, outcome: "planned", ...(sealed.changes === 0 ? {} : { detail: `${sealed.changes} contract change${sealed.changes === 1 ? "" : "s"} proposed${sealed.amendment === null ? "" : " with an amendment"}` }) });
        } else if (sealed.reason === "stale-source" || sealed.reason === "source-invalid") {
          // The newer source stands; the draft is not ingested and the
          // task stays requested — the next pass plans against what is
          // filed now. Not a strike: the planner did nothing wrong.
          dispatched.push({ id, outcome: "skipped", reason: sealed.reason, detail: sealed.detail });
        } else if (sealed.reason === "stopped") {
          // An operator's stop (v52) won before the draft was ingested:
          // the planner attempt ends interrupted, nothing is proposed,
          // and the task waits under the stop's hold. Not a strike.
          dispatched.push({ id, outcome: "stopped", reason: `stop:${planRunId}` });
        } else {
          dispatched.push({ id, outcome: "failed", reason: "fenced" });
          broke++;
        }
        continue;
      }
      const sealedFailure = finalizePlanFailureFenced(store, {
        leaseId: lease,
        runId: planRunId,
        taskId: id,
        kind: outcome.kind,
        ...(outcome.kind === "malformed" ? { malformed: outcome.reason === "malformed-decision" ? ("decision" as const) : ("plan" as const) } : {}),
        message: outcome.message,
        now: clock(),
      });
      if (!sealedFailure.ok && sealedFailure.reason === "stopped") {
        dispatched.push({ id, outcome: "stopped", reason: `stop:${planRunId}` });
        continue;
      }
      dispatched.push({ id, outcome: "failed", reason: outcome.reason });
      if (!sealedFailure.ok) release(store, lease, clock());
      broke++;
      continue;
    }

    if (wantsScout) {
      // The scout's workspace is disposable and its branch namespace is
      // its own (mate arc §10) — a later build starts from base with
      // nothing a scouting session could have left as an ancestor.
      // One branch per ATTEMPT (v4 review, finding 3): a fresh checkout
      // from base every time, and the checkout discarded after — a parked
      // scout resumes against today's base, not the tree it parked on.
      const scoutBranch = `toolroll-scout/${id}/${randomBytes(4).toString("hex")}`;
      const scopeRow = store.getScope(id);
      // Approvals bind exact routing for a scout exactly as for a build:
      // the pinned profile is proved BEFORE the workspace is leased.
      const proof = proveApprovedProfile(scopeRow, null, {
        provider: spec.provider,
        model: spec.model ?? undefined,
        maxTurns: undefined,
        timeoutMs: undefined,
        skipPermissions: false,
      });
      if (!proof.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "skipped", reason: "stale-approval", detail: proof.message });
        continue;
      }
      const scoutLeased = await worktrees.lease({
        repo,
        branch: scoutBranch,
        runner,
        taskRef: ref.id,
        now: clock(),
        base,
      });
      if (!scoutLeased.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "failed", reason: scoutLeased.reason });
        broke++;
        continue;
      }
      // Route provenance (v47): a scout runs the sealed build leg's agent
      // (the same sealed profile a build proves against) and says so — a
      // legacy row's scout is keyed by its proven profile.
      const scoutStamp: RouteStamp = routeStamp("build") ?? { routeDigest: `profile:${profileDigestOf(proof.effective.profile)}`, phase: "build", provider: spec.provider, model: proof.effective.model, chosen: "legacy" };
      const scoutRunId = store.startRun({
        taskRef: ref.id,
        leaseId: lease,
        runner,
        role: "scout",
        provider: spec.provider,
        branch: scoutBranch,
        worktree: scoutLeased.worktree.path,
        model: proof.effective.model,
        now: clock(),
        route: scoutStamp,
      });
      store.stampRun(scoutRunId, { scopeDigest: scopeRow?.approvedDigest ?? "", profileDigest: profileDigestOf(proof.effective.profile) });
      const scoutAnswers = store
        .answeredDecisionsFor(id, 6)
        .map(one => ({ question: one.question, choice: one.choice ?? "", note: one.note }));
      budgetGate = null; // this scout's spend counts toward the next check
      const scouted = await scoutTask(store, {
        ...(budgeted.remainingMicrousd === null ? {} : { maxBudgetUsd: Math.max(1, budgeted.remainingMicrousd) / 1_000_000 }),
        taskId: id,
        taskTitle: store.getTask(id)?.title ?? id,
        goal: scopeRow?.goal ?? "",
        outOfScope: scopeRow?.outOfScope ?? null,
        taskRef: ref.id,
        runner,
        leaseId: lease,
        runnerToken: token,
        runId: scoutRunId,
        worktree: scoutLeased.worktree.path,
        branch: scoutBranch,
        now: clock(),
        clock,
        onProviderSpawn: pid => { worktrees.recordProviderOccupancy(scoutLeased.worktree.path, runner, pid, scoutLeased.worktree.leaseEpoch); },
        evidenceRoot: context.evidenceRoot,
        answers: scoutAnswers,
        demoUrl: projectDemoUrl(context.databaseFile, repo),
        provider: spec.provider,
        model: proof.effective.model,
        ...(proof.effective.maxTurns === undefined ? {} : { maxTurns: proof.effective.maxTurns }),
        timeoutMs: proof.effective.timeoutMs,
        ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
        ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
      });
      await worktrees.release(scoutLeased.worktree.path, clock());
      const discarded = await worktrees.discard(scoutLeased.worktree.path, clock());
      // A checkout that could not be discarded is SAID on the outcome —
      // never silently kept; `toolroll worktrees` lists it.
      const leftover = discarded.ok ? {} : { detail: `checkout kept: ${discarded.message}` };

      if (scouted.ok && "parked" in scouted) {
        const sealed = finalizeParkFenced(store, {
          leaseId: lease,
          runId: scoutRunId,
          taskId: id,
          decision: scouted.parked.decision,
          artifactIds: scouted.parked.artifactIds,
          now: clock(),
        });
        if (sealed.ok) {
          dispatched.push({ id, outcome: "parked", reason: `decision:${sealed.decisionId}`, ...leftover });
          parked++;
        } else {
          dispatched.push({ id, outcome: "failed", reason: "fenced", ...leftover });
          broke++;
        }
        continue;
      }
      if (scouted.ok) {
        const sealed = finalizeScoutFenced(store, {
          leaseId: lease,
          runId: scoutRunId,
          taskId: id,
          report: scouted.reported.report,
          artifact: scouted.reported.artifact,
          now: clock(),
        });
        if (sealed.ok) {
          store.clearQuota(runner, spec.provider, spec.model ?? "");
          dispatched.push({ id, outcome: "reported", ...leftover });
        } else if (sealed.reason === "stopped") {
          dispatched.push({ id, outcome: "stopped", reason: `stop:${scoutRunId}`, ...leftover });
        } else {
          dispatched.push({ id, outcome: "failed", reason: "fenced", ...leftover });
          broke++;
        }
        continue;
      }
      const sealedFailure = finalizeScoutFailureFenced(store, {
        leaseId: lease,
        runId: scoutRunId,
        taskId: id,
        kind: scouted.kind,
        ...(scouted.kind === "malformed" ? { malformed: scouted.reason === "malformed-decision" ? ("decision" as const) : ("report" as const) } : {}),
        message: scouted.message,
        now: clock(),
      });
      if (!sealedFailure.ok && sealedFailure.reason === "stopped") {
        dispatched.push({ id, outcome: "stopped", reason: `stop:${scoutRunId}`, ...leftover });
        continue;
      }
      dispatched.push({ id, outcome: "failed", reason: scouted.reason, ...leftover });
      if (!sealedFailure.ok) release(store, lease, clock());
      broke++;
      continue;
    }

    // A retry of this task reuses its branch (a standing-orders/<id> one from
    // before the rename included); a first attempt creates toolroll/<id> from
    // base. Suffixing instead would scatter one logical attempt across
    // branches nobody asked for.
    const branch = await existingOrFirst(taskBranches(id), async one => (await git("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${one}`], { cwd: repo })).code === 0);
    const exists = await git(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repo },
    );

    let buildBase = base;
    if (ref.revisionOf !== null) {
      const source = revisionSourceHead(store, context.evidenceRoot, ref.id, ref.revisionOf);
      let problem: string | null = source.ok ? null : source.problem;
      if (source.ok) {
        if (exists.code !== 0 && text(flags, "base") === undefined) buildBase = source.head;
        else {
          const descendant = exists.code === 0 ? branch : base;
          const ancestry = await git("git", ["--no-lazy-fetch", "--no-replace-objects", "merge-base", "--is-ancestor", source.head, descendant], { cwd: repo });
          if (ancestry.code !== 0) problem = "the requested revision base does not contain its source head";
        }
      }
      if (problem !== null) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "skipped", reason: "revision-brief", detail: problem });
        continue;
      }
    }
    const leased = await worktrees.lease({
      repo,
      branch,
      runner,
      taskRef: ref.id,
      now: clock(),
      ...(exists.code === 0 ? {} : { base: buildBase }),
      reclaim: { evidenceRoot: context.evidenceRoot },
    });
    if (!leased.ok) {
      // The task is fine; this machine's pool is not. Hand the claim back so
      // a healthier pass can take it, and let the exit code say we broke.
      release(store, lease, clock());
      dispatched.push({ id, outcome: "failed", reason: leased.reason });
      broke++;
      continue;
    }

    // The record opens before the money is spent, so a crash mid-agent leaves
    // a row with no outcome — an attempt that vanished, visible by morning.
    // Its route provenance (v47) is written in the same admission
    // transaction; build() then refuses to spend as anything else.
    // The chain custody for this run (E3b/E3d, atomic since the v48 authority repair): a parked
    // chain tail hands custody to this successor through the PROVEN resume
    // transfer, otherwise a chain approval opens its fresh cycle bound to
    // this run — both proved and written IN the run's own insert. A
    // single-profile approval — every task until an operator configures a
    // fallback chain — binds nothing, so this is inert by default. A
    // binding that cannot be proved, or a stamp the task's authority does
    // not admit, rolls the insert back: no row, no claim kept, said why.
    const buildStamp = routeStamp("build");
    let runId: number;
    try {
      if (parkedEntry !== null && parkedChainTail !== null && liveCycle !== null && buildStamp !== null) {
        // A parked FALLBACK tail's successor is admitted by the one
        // fallback road (v48 integrity): every fact the tail's binding
        // states is presented and re-proved — cycle, index, digest, auth
        // mode, provider, exact model, repair binding, the sealed-profile
        // mirror, the approved chain — with the parked run as the live
        // tail, before any row exists.
        const chain = store.approvedChainOf(id);
        const entry = chain === null ? undefined : chain[parkedEntry.index];
        const mirror = store.getScope(id)?.approvedProfile ?? null;
        if (chain === null || entry === undefined || mirror === null || parkedChainTail.entryDigest == null || parkedChainTail.authMode == null || spec.model === null) {
          throw new Error(`${id}: the parked attempt #${parkedChainTail.id}'s fallback binding cannot be restated against the approved chain — nothing resumes it`);
        }
        const admitted = store.admitFallback(
          {
            kind: "resume",
            parkedRun: parkedChainTail.id,
            cycleId: liveCycle.id,
            expectCursor: parkedEntry.index,
            expectTail: parkedChainTail.id,
            entryDigest: parkedChainTail.entryDigest,
            authMode: parkedChainTail.authMode,
            repairModel: entry.profile.repairModel === "inherit" ? entry.profile.model : entry.profile.repairModel,
            approved: { chainDigest: chainDigestOf(chain), profile: mirror },
            run: {
              taskRef: ref.id, leaseId: lease, runner, branch, worktree: leased.worktree.path, provider: spec.provider, model: spec.model,
              // The recovered draft's lineage rides the insert (raw
              // authority repair) — never a later stamp.
              ...(leased.resumedFromRun === undefined ? {} : { recoveredFrom: leased.resumedFromRun }),
            },
            route: buildStamp,
          },
          clock(),
        );
        if (!admitted.ok) throw new Error(admitted.problem);
        runId = admitted.runId;
      } else if (attendedDispatch !== null && attendedSpec !== null) {
        // THE ATTENDED ADMISSION (atomic authority closure): the one
        // watched attempt opens under exactly this authorization — named
        // by id, runner, and generation — and the insert consumes its
        // attempt and binds the row to it in one transaction.
        if (buildStamp === null) throw new Error(`${id}: the attended authorization's pinned profile presents no build authority`);
        // THE SIGNED HEAD, BEFORE THE ATTEMPT IS SPENT (final authority
        // closure): the authorization signed the exact commit the watched
        // attempt would start from. The leased worktree's HEAD is read
        // here and held to it BEFORE admission — a head that moved opens
        // no run and spends no attempt; the authorization closes in the
        // refusal's words so the operator sees why and may authorize
        // again at today's head. The coordinator's final proof re-reads
        // the same term against the captured base revision.
        let signedHead: string | null = null;
        try {
          const terms = JSON.parse(attendedDispatch.termsJson) as { head?: unknown };
          signedHead = typeof terms.head === "string" && terms.head !== "" ? terms.head : null;
        } catch {
          signedHead = null;
        }
        if (signedHead === null) {
          store.closeAuthorization(attendedDispatch.id, "refused:stale-authorization", clock());
          throw new StaleAuthorization(`${id}: the attended authorization ${attendedDispatch.id} signs no readable head — nothing opens under it`);
        }
        const headRead = await git("git", ["rev-parse", "HEAD"], { cwd: leased.worktree.path });
        const headNow = headRead.code === 0 ? headRead.stdout.trim() : "";
        if (headNow !== signedHead) {
          store.closeAuthorization(attendedDispatch.id, "refused:stale-authorization", clock());
          throw new StaleAuthorization(`${id}: the head moved since the attended authorization ${attendedDispatch.id} was signed (${signedHead.slice(0, 12)} → ${headNow === "" ? "unreadable" : headNow.slice(0, 12)}) — no run opened, no attempt spent; authorize it again at today's head`);
        }
        const admittedAttended = store.admitAttended({
          taskRef: ref.id,
          leaseId: lease,
          runner,
          branch,
          worktree: leased.worktree.path,
          provider: spec.provider,
          ...(spec.model === null ? {} : { model: spec.model }),
          authorization: { id: attendedDispatch.id, runner: attendedDispatch.runner, generation: attendedDispatch.runnerGeneration },
          now: clock(),
          route: buildStamp,
        });
        if (!admittedAttended.ok) throw new Error(admittedAttended.problem);
        runId = admittedAttended.runId;
      } else if (leased.resumedFromRun !== undefined) {
        // THE RECOVERED-DRAFT ADMISSION (atomic authority closure): the
        // fresh attempt inherits the interrupted attempt's draft, proved
        // this task's own interrupted builder in this very worktree.
        if (buildStamp === null) throw new Error(`${id}: the recovered attempt presents no build authority`);
        const admittedRecovered = store.admitRecoveredBuilder({
          taskRef: ref.id,
          leaseId: lease,
          runner,
          branch,
          worktree: leased.worktree.path,
          provider: spec.provider,
          ...(spec.model === null ? {} : { model: spec.model }),
          recoveredFrom: leased.resumedFromRun,
          now: clock(),
          route: buildStamp,
          custody: parkedChainTail !== null && liveCycle !== null ? { kind: "resume" as const, parkedRun: parkedChainTail.id } : { kind: "base" as const },
        });
        if (!admittedRecovered.ok) throw new Error(admittedRecovered.problem);
        runId = admittedRecovered.runId;
      } else {
        runId = store.startRun({
          taskRef: ref.id,
          leaseId: lease,
          runner,
          branch,
          worktree: leased.worktree.path,
          provider: spec.provider,
          ...(spec.model === null ? {} : { model: spec.model }),
          now: clock(),
          ...(buildStamp === null ? {} : { route: buildStamp }),
          custody: parkedChainTail !== null && liveCycle !== null ? { kind: "resume" as const, parkedRun: parkedChainTail.id } : { kind: "base" as const },
        });
      }
    } catch (error) {
      await worktrees.release(leased.worktree.path, clock());
      release(store, lease, clock());
      dispatched.push({ id, outcome: "skipped", reason: error instanceof StaleAuthorization ? "stale-authorization" : "admission-refused", detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (leased.resumedFromRun !== undefined) {
      store.addRunNote(
        runId,
        "Toolroll",
        `Recovered the ${leased.recoveryKind === "completed" ? "completed source draft" : "work-in-progress draft"} from interrupted attempt #${leased.resumedFromRun}. This fresh attempt is reviewing and verifying it; the safety patch is retained.`,
        clock(),
      );
    }

    // The per-attempt dollar cap (v15): the scope's approved term and the
    // installation backstop, the smaller of the two. A provider that
    // cannot hold a cap does not run capped work (ruling 3: enforce only
    // explicit budgets; never pretend).
    const scopeBudget = store.getScope(id)?.budgetMicrousd ?? null;
    const backstop = store.getSpendDefaults()?.buildPerRunMicrousd ?? null;
    // v105: what's left of a monthly budget caps a provider that can hold a cap (the rest stop at the gate above).
    const budgetLeft = budgeted.remainingMicrousd !== null && MONEY_CAPABILITIES[spec.provider].nativeDollarCapFlag !== null ? Math.max(1, budgeted.remainingMicrousd) : null;
    const capMicrousd = [scopeBudget, backstop, budgetLeft].reduce<number | null>((least, one) => one === null ? least : least === null ? one : Math.min(least, one), null);
    if (capMicrousd !== null && MONEY_CAPABILITIES[spec.provider].nativeDollarCapFlag === null) {
      // The run row and any chain cycle already exist — FINISH and RESOLVE
      // them (E3d verify, R6): a refused-but-open run would defer a chain
      // task forever and read as a vanished attempt everywhere else.
      store.finishRun(runId, { outcome: "refused", reason: "budget-unenforceable", now: clock() });
      store.resolveChainOnRunEnd(ref.id, id, repo, runId, clock());
      release(store, lease, clock());
      await worktrees.release(leased.worktree.path, clock());
      dispatched.push({ id, outcome: "skipped", reason: "budget-unenforceable" });
      continue;
    }
    budgetGate = null; // this build's spend counts toward the next check
    const result = await build(store, {
      taskId: id,
      taskRef: ref.id,
      runner,
      leaseId: lease,
      runnerToken: token,
      runId,
      evidenceRoot: context.evidenceRoot,
      worktree: leased.worktree.path,
      branch,
      now: clock(),
      clock,
      // No timeoutMs here, deliberately (Phase 3): the tick asks for
      // nothing, so the SEALED profile's clock governs. Passing the old
      // 30-minute constant read as an operator's ask and stale-approved
      // every profile whose honest clock is shorter (codex-shaped, gemini).
      ...(capMicrousd === null ? {} : { maxBudgetUsd: capMicrousd / 1_000_000 }),
      onProviderSpawn: pid => {
        worktrees.recordProviderOccupancy(leased.worktree.path, runner, pid, leased.worktree.leaseEpoch);
      },
      provider: spec.provider,
      ...(spec.model === null ? {} : { model: spec.model }),
      ...(repairModel === undefined ? {} : { repairModel }),
      ...(turns === undefined ? {} : { maxTurns: Number(turns) }),
      ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
      ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
      // The stop fence rides into the builder (audit IV-1): re-proved at
      // the last gate before the commit, so an operator's stop beats an
      // agent's finish even mid-build.
      ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
      ...(leased.resumedFromRun === undefined ? {} : { recoveredDraftRun: leased.resumedFromRun }),
      ...(leased.recoveryKind === undefined ? {} : { recoveredDraftKind: leased.recoveryKind }),
      ...(attendedDispatch === null || context.heldCoordinator === undefined
        ? {}
        : {
            attended: {
              authorization: attendedDispatch,
              coordinator: context.heldCoordinator,
              upIncarnation: context.upIncarnation ?? "unknown",
              socketDir: context.heldSocketDir ?? tmpdir(),
              releaseWorktree: async (path: string) => worktrees.release(path, clock()),
              dispose: { repo, origin: ref.origin, provider: spec.provider, model: spec.model },
              ...(context.heldStarter === undefined ? {} : { starter: context.heldStarter }),
              ...(context.heldGraceMs === undefined ? {} : { graceMs: context.heldGraceMs }),
              ...(context.maxHeldSessions === undefined ? {} : { maxHeldSessions: context.maxHeldSessions }),
            },
          }),
    });

    // THE HELD HANDOFF (Phase 2, v2 S0d): ownership transferred — the
    // coordinator owns run, lease, and worktree; this pass releases and
    // settles NOTHING and moves on. Nonblocking is the whole point.
    if (result.ok && result.parked === undefined && result.held === true) {
      dispatched.push({ id, outcome: "held", branch, worktree: leased.worktree.path });
      continue;
    }

    // Handed back either way; a tree with somebody's work in it comes back
    // unverified rather than cleaned, same as `build`.
    await worktrees.release(leased.worktree.path, clock());

    // Disposition through the ONE shared service (Phase 2C): sealing,
    // completion fences, publication intents, strikes, and failure classes
    // all live in disposeBuildOutcome now; this loop only reports.
    const disposition = disposeBuildOutcome(
      {
        store,
        policy: "tick",
        leaseId: lease,
        runId,
        taskId: id,
        taskRef: ref.id,
        runner,
        repo,
        branch,
        origin: ref.origin,
        provider: spec.provider,
        model: spec.model,
        worktreePath: leased.worktree.path,
        evidenceRoot: context.evidenceRoot,
        clock,
      },
      result,
    );

    // The chain step (E3c/E3d): EVERY concluded run resolves its cycle
    // through the one resolver — success closes, an ordinary end closes, a
    // parked tail stays open for repair, and a recognized eligible
    // exhaustion advances to pending-admission (fail-closed at every gate,
    // the live grant re-proved in its own transaction). Inert unless the
    // task filed under an explicit chain — no cycle, fast no-op.
    store.resolveChainOnRunEnd(ref.id, id, repo, runId, clock());

    switch (disposition.kind) {
      case "parked":
        dispatched.push({ id, outcome: "parked", reason: `decision:${disposition.decisionId}`, worktree: leased.worktree.path });
        parked++;
        break;
      case "park-fenced":
        dispatched.push({ id, outcome: "failed", reason: "fenced", worktree: leased.worktree.path });
        broke++;
        break;
      case "disowned":
        dispatched.push({ id, outcome: "failed", reason: "external-closed", branch, worktree: leased.worktree.path });
        broke++;
        break;
      case "built":
        dispatched.push({ id, outcome: "built", committed: disposition.committed, branch, worktree: leased.worktree.path });
        built++;
        break;
      case "built-fenced":
        dispatched.push({ id, outcome: "failed", reason: "fenced", branch, worktree: leased.worktree.path });
        broke++;
        break;
      case "skipped":
        dispatched.push({ id, outcome: "skipped", reason: disposition.reason });
        break;
      case "fenced":
        dispatched.push({ id, outcome: "failed", reason: "fenced", worktree: leased.worktree.path });
        broke++;
        break;
      case "malformed":
        dispatched.push({ id, outcome: "failed", reason: disposition.sealed ? "malformed-decision" : "fenced", worktree: leased.worktree.path });
        broke++;
        break;
      case "failed":
        dispatched.push({
          id,
          outcome: "failed",
          reason: disposition.sealed
            ? disposition.disposition === "auth-expired"
              ? "auth-expired — requeued, sign-in needed"
              : `${disposition.failureClass}${disposition.disposition === "backoff" ? ` — retry ${disposition.strikes}/3` : disposition.disposition === "stalled" ? " — stalled" : ""}`
            : "fenced",
          ...(result.ok ? {} : { detail: result.message.slice(0, 200) }),
          worktree: leased.worktree.path,
        });
        broke++;
        break;
      case "recorded":
        // The standalone-only arm; unreachable under the tick policy.
        break;
      case "stopped":
        // An operator's stop (v52): interrupted with its work preserved —
        // not a break, not a strike; the task waits under the stop's hold.
        dispatched.push({ id, outcome: "stopped", reason: `stop:${disposition.stopRun}`, branch, worktree: leased.worktree.path });
        break;
      case "handed-back":
        // The service is stopping: the work is kept and the task requeued
        // to resume on the next pass — not a break, not a strike.
        dispatched.push({ id, outcome: "stopped", reason: "service-stop", detail: result.ok ? "" : result.message.slice(0, 200), branch, worktree: leased.worktree.path });
        break;
      case "invariant":
        dispatched.push({ id, outcome: "failed", reason: disposition.reason });
        broke++;
        break;
    }
  }
  untakenTrial?.giveBack();

  // THE CHAIN ADMISSION PASS (E3d): cycles a recognized exhaustion advanced
  // to pending-admission dispatch their NEXT approved entry here — the ONLY
  // road that runs a fallback entry. Every authority is re-derived inside
  // admitNextChainEntry (approved chain standing + digest match + LIVE
  // paid-fallback grant + the single-use pending edge); this loop carries
  // only claim, worktree, and rail, and its run then re-proves the
  // chain-entry dispatch proof inside build() before any money moves.
  for (const pending of buildsOnly ? [] : store.pendingChainAdmissions(repo)) {
    settleFinished();
    if (context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true) break;
    if (built >= max) break;
    // v105: a fallback billed to an API key spends dollars: a used-up budget holds it like any new work.
    const chainEntry = store.approvedChainOf(pending.taskId)?.[pending.cursor];
    const chainAgents = chainEntry === undefined ? [] : [{ provider: chainEntry.profile.provider, billing: chainEntry.authMode }];
    // Sprint 8: a fallback entry the organisation policy doesn't allow never starts.
    const chainPolicy = chainEntry === undefined ? null : policyHold([{ profile: chainEntry.profile }]);
    if (chainPolicy !== null) {
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: "policy", detail: chainPolicy });
      continue;
    }
    const chainBudget = budgetHold(pending.taskRef, chainAgents);
    if (chainBudget.over !== null) {
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: "budget", detail: budgetWords(chainBudget) });
      continue;
    }
    const railed = store.reserveModeRail(repo, 1, clock());
    if (!railed.ok) {
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: railed.rail, detail: railed.detail });
      continue;
    }
    // A peek proves the entry EXISTS and carries an enforceable budget
    // BEFORE any claim or run row exists (review findings 4/6); the
    // admission below re-derives the entry as authority in its transaction.
    const peek = store.approvedChainOf(pending.taskId)?.[pending.cursor];
    if (peek === undefined) {
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: "fallback-unadmittable" });
      continue;
    }
    const scopeBudget = store.getScope(pending.taskId)?.budgetMicrousd ?? null;
    const backstop = store.getSpendDefaults()?.buildPerRunMicrousd ?? null;
    const capMicrousd =
      scopeBudget === null ? backstop : backstop === null ? scopeBudget : Math.min(scopeBudget, backstop);
    if (capMicrousd !== null && MONEY_CAPABILITIES[peek.profile.provider].nativeDollarCapFlag === null) {
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: "budget-unenforceable" });
      continue;
    }
    // The sign-in pause holds a fallback entry too: the admission stays pending until its provider works.
    const entryGate = signInGate(store, [peek.profile.provider], clock(), pending.taskRef);
    if (entryGate.waiting !== null) {
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: "signed-out", detail: signInWords(entryGate.waiting) });
      continue;
    }
    // The FALLBACK claim (finding 4): every acquireIfReady gate — task
    // state, non-backoff holds, blockers, approved scope + mode belt,
    // capability, capacity, and quota keyed by the PINNED credential —
    // with only the predecessor's backoff exempted.
    const claimed = acquireFallback(store, pending.taskRef, runner, {
      now: clock(),
      token,
      ttlMs: leaseTtlMs,
      repo,
      provider: peek.profile.provider,
      model: peek.profile.model,
      authMode: peek.authMode,
      // The watch incarnation rides the claim (F+G review, finding 3): a
      // daemon that dies after this claim — admitted or not — must be
      // recoverable by its successor's incarnation takeover, exactly like
      // the ordinary road.
      ...(text(flags, "incarnation") === undefined ? {} : { incarnation: text(flags, "incarnation") as string }),
      ...(text(flags, "max-open-decisions") === undefined
        ? {}
        : { maxOpenDecisions: Number(text(flags, "max-open-decisions")) }),
    });
    if (!claimed.ok) {
      entryGate.giveBack();
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: claimed.reason });
      continue;
    }
    const lease = claimed.claim.leaseId;
    const branch = await existingOrFirst(taskBranches(pending.taskId), async one => (await git("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${one}`], { cwd: repo })).code === 0);
    const exists = await git("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo });
    const leased = await worktrees.lease({
      repo,
      branch,
      runner,
      taskRef: pending.taskRef,
      now: clock(),
      ...(exists.code === 0 ? {} : { base }),
      reclaim: { evidenceRoot: context.evidenceRoot },
    });
    if (!leased.ok) {
      release(store, lease, clock());
      dispatched.push({ id: pending.taskId, outcome: "failed", reason: leased.reason });
      broke++;
      continue;
    }
    const admitted = store.admitNextChainEntry(
      pending.cycleId,
      { leaseId: lease, runner, branch, worktree: leased.worktree.path, ...(leased.resumedFromRun === undefined ? {} : { recoveredFrom: leased.resumedFromRun }) },
      clock(),
    );
    if (!admitted.ok) {
      await worktrees.release(leased.worktree.path, clock());
      release(store, lease, clock());
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: `fallback-${admitted.reason}`, ...(admitted.detail === undefined ? {} : { detail: admitted.detail }) });
      continue;
    }
    if (leased.resumedFromRun !== undefined) {
      store.addRunNote(
        admitted.runId,
        "Toolroll",
        `Recovered the ${leased.recoveryKind === "completed" ? "completed source draft" : "work-in-progress draft"} from interrupted attempt #${leased.resumedFromRun}. This fresh attempt is reviewing and verifying it; the safety patch is retained.`,
        clock(),
      );
    }
    // The effective cap, RE-DERIVED after admission (E3d verify, R6): the
    // pre-claim value is a survey; a backstop set while the claim and
    // worktree awaits ran must govern the spend that actually happens. The
    // belt then re-proves capability against the ADMITTED provider — and on
    // refusal the run is FINISHED and its cycle resolved, never abandoned.
    const scopeBudgetNow = store.getScope(pending.taskId)?.budgetMicrousd ?? null;
    const backstopNow = store.getSpendDefaults()?.buildPerRunMicrousd ?? null;
    const budgetNow = chainEntry?.authMode === "api-key" ? budgetHold(pending.taskRef, chainAgents).remainingMicrousd : null;
    const capNow = [scopeBudgetNow, backstopNow, budgetNow === null ? null : Math.max(1, budgetNow)]
      .reduce<number | null>((least, one) => one === null ? least : least === null ? one : Math.min(least, one), null);
    if (capNow !== null && MONEY_CAPABILITIES[admitted.provider as ProviderId].nativeDollarCapFlag === null) {
      store.finishRun(admitted.runId, { outcome: "refused", reason: "budget-unenforceable", now: clock() });
      store.resolveChainOnRunEnd(pending.taskRef, admitted.taskId, repo, admitted.runId, clock());
      release(store, lease, clock());
      await worktrees.release(leased.worktree.path, clock());
      dispatched.push({ id: pending.taskId, outcome: "skipped", reason: "budget-unenforceable" });
      continue;
    }
    budgetGate = null; // this build's spend counts toward the next check
    const result = await build(store, {
      taskId: pending.taskId,
      taskRef: pending.taskRef,
      runner,
      leaseId: lease,
      runnerToken: token,
      runId: admitted.runId,
      evidenceRoot: context.evidenceRoot,
      worktree: leased.worktree.path,
      branch,
      now: clock(),
      clock,
      ...(capNow === null ? {} : { maxBudgetUsd: capNow / 1_000_000 }),
      onProviderSpawn: pid => {
        worktrees.recordProviderOccupancy(leased.worktree.path, runner, pid, leased.worktree.leaseEpoch);
      },
      provider: admitted.provider as ProviderId,
      model: admitted.model,
      ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
      ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
      ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
      ...(leased.resumedFromRun === undefined ? {} : { recoveredDraftRun: leased.resumedFromRun }),
      ...(leased.recoveryKind === undefined ? {} : { recoveredDraftKind: leased.recoveryKind }),
    });
    await worktrees.release(leased.worktree.path, clock());
    const disposition = disposeBuildOutcome(
      {
        store,
        policy: "tick",
        leaseId: lease,
        runId: admitted.runId,
        taskId: pending.taskId,
        taskRef: pending.taskRef,
        runner,
        repo,
        branch,
        origin: "ours",
        provider: admitted.provider as ProviderId,
        model: admitted.model,
        worktreePath: leased.worktree.path,
        evidenceRoot: context.evidenceRoot,
        clock,
      },
      result,
    );
    // The same one resolver: a fallback entry that itself exhausts advances
    // again; one that succeeds or ordinarily ends closes its cycle.
    store.resolveChainOnRunEnd(pending.taskRef, pending.taskId, repo, admitted.runId, clock());
    switch (disposition.kind) {
      case "built":
        dispatched.push({ id: pending.taskId, outcome: "built", committed: disposition.committed, branch, worktree: leased.worktree.path });
        built++;
        break;
      case "stopped":
        dispatched.push({ id: pending.taskId, outcome: "stopped", reason: `stop:${disposition.stopRun}`, branch, worktree: leased.worktree.path });
        break;
      case "handed-back":
        dispatched.push({ id: pending.taskId, outcome: "stopped", reason: "service-stop", branch, worktree: leased.worktree.path });
        break;
      case "parked":
        dispatched.push({ id: pending.taskId, outcome: "parked", reason: `decision:${disposition.decisionId}`, worktree: leased.worktree.path });
        parked++;
        break;
      case "skipped":
        dispatched.push({ id: pending.taskId, outcome: "skipped", reason: disposition.reason });
        break;
      default:
        dispatched.push({ id: pending.taskId, outcome: "failed", reason: "fallback-attempt", worktree: leased.worktree.path });
        broke++;
        break;
    }
  }

  // THE CONTINUATION PASS (Phase 2E, A4): open continuation authorizations
  // named to this runner dispatch here — the finished parent task never
  // re-enters the queue; the authorization is the claimable unit (v3 R7).
  // Only a co-located coordinator can hold the session, and everything
  // else (liveness, one attempt, the final proof at the parent's exact
  // head) is re-proved on the way in.
  if (context.heldCoordinator !== undefined && !buildsOnly) {
    for (const continuation of store.openContinuationAuthorizations(runner)) {
      if (context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true) break;
      const watching = attendedLivenessState(
        continuation.lastBeatAt === null ? null : Date.parse(continuation.lastBeatAt),
        clock().getTime(),
        Date.parse(continuation.absoluteExpiry),
      );
      if (watching !== "live" && watching !== "grace") continue;
      const parent = continuation.parentRun === null ? null : store.getRun(continuation.parentRun);
      const parentRef = parent === null ? null : store.refForId(parent.taskRef);
      if (parent === null || parentRef === null) continue;
      // A continuation continues WORK: a branchless parent (the reviewer
      // role, v29) has no workspace to lease and can never be continued —
      // and this guard is what keeps "null" out of `git worktree add`.
      if (parent.branch === null) continue;
      const parentBranch = parent.branch;
      if (parentRef.repo !== null && parentRef.repo !== repo) continue;
      const taskId = parentRef.externalId;

      let pinned: { provider: ProviderId; model: string | null; digest: string; profile: ExecutionProfile } | null = null;
      try {
        const terms = JSON.parse(continuation.termsJson) as { profileJson?: unknown };
        const profile = profileFromJson(typeof terms.profileJson === "string" ? terms.profileJson : null);
        if (profile !== null) pinned = { provider: profile.provider, model: profile.model, digest: profileDigestOf(profile), profile };
      } catch {
        pinned = null;
      }
      if (pinned === null) {
        dispatched.push({ id: taskId, outcome: "skipped", reason: "attended-only", detail: "the continuation's pinned profile cannot be read" });
        continue;
      }
      // Sprint 8: an attended continuation runs at exactly its signed terms, or not at all.
      const continuationPolicy = policyHold([{ profile: pinned.profile, attended: true }]);
      if (continuationPolicy !== null) {
        dispatched.push({ id: taskId, outcome: "skipped", reason: "policy", detail: continuationPolicy });
        continue;
      }
      const continuationBudget = budgetHold(parent.taskRef, store.agentsFor([pinned.provider]));
      if (continuationBudget.over !== null) {
        dispatched.push({ id: taskId, outcome: "skipped", reason: "budget", detail: budgetWords(continuationBudget) });
        continue;
      }
      // The sign-in pause holds a continuation too: its authorization stays open and it starts once the sign-in works.
      const continuationGate = signInGate(store, [pinned.provider], clock(), parent.taskRef);
      if (continuationGate.waiting !== null) {
        dispatched.push({ id: taskId, outcome: "skipped", reason: "signed-out", detail: signInWords(continuationGate.waiting) });
        continue;
      }

      const claimed = acquireContinuation(store, continuation, runner, { now: clock(), token, ttlMs: leaseTtlMs });
      if (!claimed.ok) {
        continuationGate.giveBack();
        dispatched.push({ id: taskId, outcome: "skipped", reason: claimed.reason, ...("message" in claimed ? { detail: claimed.message } : {}) });
        continue;
      }
      const lease = claimed.claim.leaseId;
      // The parent's branch, at the head the terms signed — a moved branch
      // fails the final proof with words naming the head.
      const leased = await worktrees.lease({ repo, branch: parentBranch, runner, taskRef: parent.taskRef, now: clock() });
      if (!leased.ok) {
        release(store, lease, clock());
        dispatched.push({ id: taskId, outcome: "failed", reason: leased.reason });
        broke++;
        continue;
      }
      // THE SIGNED HEAD, BEFORE THE ATTEMPT IS SPENT (final admission
      // closure): the continuation's terms signed the exact commit the
      // parent finished at, and the leased worktree's HEAD is read here
      // and held to it BEFORE admitAttended — the same order the queue's
      // attended road keeps. A head the terms do not sign, or one that
      // moved, opens no run, spends no attempt, invokes no provider: the
      // worktree and claim are released and the authorization closes in
      // the refusal's words — one terminal refusal, recorded once — so
      // the operator authorizes again at today's head.
      let signedContinuationHead: string | null = null;
      try {
        const terms = JSON.parse(continuation.termsJson) as { head?: unknown };
        signedContinuationHead = typeof terms.head === "string" && terms.head !== "" ? terms.head : null;
      } catch {
        signedContinuationHead = null;
      }
      const continuationHeadRead = signedContinuationHead === null ? null : await git("git", ["rev-parse", "HEAD"], { cwd: leased.worktree.path });
      if (continuationHeadRead !== null && continuationHeadRead.code !== 0) {
        // The worktree's HEAD could not be READ — the head did not move,
        // so nothing terminal is said about the authorization: custody is
        // released and this tick records the failure; the next one reads
        // again under the same open authorization.
        await worktrees.release(leased.worktree.path, clock());
        release(store, lease, clock());
        dispatched.push({ id: taskId, outcome: "failed", reason: "head-unreadable", detail: `${taskId}: the leased worktree's HEAD could not be read (${continuationHeadRead.stderr.trim() || `git exited ${continuationHeadRead.code}`}) — the continuation authorization ${continuation.id} stays open; no run opened, no attempt spent` });
        broke++;
        continue;
      }
      const continuationHeadNow = continuationHeadRead === null ? "" : continuationHeadRead.stdout.trim();
      if (signedContinuationHead === null || continuationHeadNow !== signedContinuationHead) {
        await worktrees.release(leased.worktree.path, clock());
        release(store, lease, clock());
        store.closeAuthorization(continuation.id, "refused:stale-authorization", clock());
        dispatched.push({
          id: taskId,
          outcome: "skipped",
          reason: "stale-authorization",
          detail:
            signedContinuationHead === null
              ? `${taskId}: the continuation authorization ${continuation.id} signs no readable head — nothing opens under it; no run opened, no attempt spent`
              : `${taskId}: the head moved since the continuation authorization ${continuation.id} was signed (${signedContinuationHead.slice(0, 12)} → ${continuationHeadNow === "" ? "empty" : continuationHeadNow.slice(0, 12)}) — no run opened, no attempt spent; authorize it again at today's head`,
        });
        continue;
      }
      // The continuation spends under the authorization's pinned profile
      // and says so at insert (v48 integrity).
      // THE ATTENDED ADMISSION (atomic authority closure): the continuation
      // opens under exactly this authorization — id, runner, generation —
      // continuing the finished parent it names; the insert consumes the
      // one attempt and binds the row to it.
      const admittedContinuation = store.admitAttended({
        taskRef: parent.taskRef,
        leaseId: lease,
        runner,
        branch: parentBranch,
        worktree: leased.worktree.path,
        parentRun: parent.id,
        provider: pinned.provider,
        ...(pinned.model === null ? {} : { model: pinned.model }),
        authorization: { id: continuation.id, runner: continuation.runner, generation: continuation.runnerGeneration },
        now: clock(),
        route: { routeDigest: `profile:${pinned.digest}`, phase: "build", provider: pinned.provider, model: pinned.model, chosen: "legacy" },
      });
      if (!admittedContinuation.ok) {
        await worktrees.release(leased.worktree.path, clock());
        release(store, lease, clock());
        dispatched.push({ id: taskId, outcome: "skipped", reason: "admission-refused", detail: admittedContinuation.problem });
        continue;
      }
      const runId = admittedContinuation.runId;
      budgetGate = null; // this build's spend counts toward the next check
      const result = await build(store, {
        taskId,
        taskRef: parent.taskRef,
        runner,
        leaseId: lease,
        runnerToken: token,
        runId,
        evidenceRoot: context.evidenceRoot,
        worktree: leased.worktree.path,
        branch: parentBranch,
        now: clock(),
        clock,
        provider: pinned.provider,
        ...(pinned.model === null ? {} : { model: pinned.model }),
        ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
        ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
        ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
        attended: {
          authorization: continuation,
          coordinator: context.heldCoordinator,
          upIncarnation: context.upIncarnation ?? "unknown",
          socketDir: context.heldSocketDir ?? tmpdir(),
          releaseWorktree: async (path: string) => worktrees.release(path, clock()),
          dispose: { repo, origin: parentRef.origin, provider: pinned.provider, model: pinned.model, policy: "continuation" },
          ...(context.heldStarter === undefined ? {} : { starter: context.heldStarter }),
          ...(context.heldGraceMs === undefined ? {} : { graceMs: context.heldGraceMs }),
              ...(context.maxHeldSessions === undefined ? {} : { maxHeldSessions: context.maxHeldSessions }),
        },
      });
      if (result.ok && result.parked === undefined && result.held === true) {
        dispatched.push({ id: taskId, outcome: "held", branch: parentBranch, worktree: leased.worktree.path });
        continue;
      }
      // A refusal before the hold (stale proof, spawn failure): record it
      // through the continuation policy — taskless, always — and release.
      await worktrees.release(leased.worktree.path, clock());
      const disposition = disposeBuildOutcome(
        {
          store,
          policy: "continuation",
          leaseId: lease,
          runId,
          taskId,
          taskRef: parent.taskRef,
          runner,
          repo,
          branch: parentBranch,
          origin: parentRef.origin,
          provider: pinned.provider,
          model: pinned.model,
          worktreePath: leased.worktree.path,
          evidenceRoot: context.evidenceRoot,
          clock,
        },
        result,
      );
      dispatched.push({
        id: taskId,
        outcome: disposition.kind === "built" ? "built" : disposition.kind === "stopped" ? "stopped" : "failed",
        ...(disposition.kind === "stopped" ? { reason: `stop:${disposition.stopRun}` } : result.ok ? {} : { reason: result.reason }),
        worktree: leased.worktree.path,
      });
      if (disposition.kind !== "built" && disposition.kind !== "stopped") broke++;
    }
  }

  // The one automatic review each finished build gets when its project's
  // switch is on, before the result is handed on below. Other queued review
  // asks close unrun. Reauthenticated first; only admitted projects.
  if (!buildsOnly && authenticate(store, runner, token).ok) {
    const reviewed = await buildReviewPass(store, {
      runner, token, repos: auth.runner.repos, clock,
      root: context.evidenceRoot,
      ...(text(flags, "incarnation") === undefined ? {} : { watchIncarnation: text(flags, "incarnation") as string }),
      ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
      shouldStop: () => context.shouldStop?.() === true || context.shouldPauseAdmission?.() === true,
    });
    for (const one of reviewed) dispatched.push({ id: `review of run ${one.run}`, outcome: one.outcome === "not-reviewed" ? "not-reviewed" : "reviewed", reason: one.detail });
  }
  // Existing worker pass owns durable lead handoffs; reads never create events.
  if (!buildsOnly) syncAssignmentHandoffs(store, clock(), auth.runner.repos, context.evidenceRoot);

  settleFinished();
  const replied = replyPass.taken > 0 || replyPass.problem !== null;
  const flows = flowPass.moved + flowPass.filed.length + flowPass.problems.length + triggerPass.added + triggerPass.problems.length + stepPass.ran + stepPass.problems.length === 0 && !replied ? {} : { flows: { ...flowPass,
    ...(triggerPass.added + triggerPass.problems.length === 0 ? {} : { triggers: triggerPass }), ...(stepPass.ran + stepPass.problems.length === 0 ? {} : { steps: stepPass }), ...(replied ? { replies: replyPass } : {}) } };

  const summary = () => {
    const lines = [`Considered ${considered}, built ${built}, parked ${parked}, broke ${broke}.`];
    for (const entry of routines) {
      lines.push(
        entry.outcome === "fired"
          ? `  routine ${entry.routine.padEnd(16)} fired  ${entry.taskId ?? ""}`.trimEnd()
          : `  routine ${entry.routine.padEnd(16)} skipped  ${entry.detail ?? entry.outcome}`,
      );
    }
    for (const entry of dispatched) {
      const detail =
        entry.outcome === "built"
          ? entry.committed === true
            ? `committed to ${entry.branch}`
            : "no changes reported; see the result's proof status"
          : entry.outcome === "parked"
            ? `${entry.reason} — \`toolroll decide\``
            : entry.reason ?? "";
      lines.push(`  ${entry.id.padEnd(24)} ${entry.outcome}  ${detail}`.trimEnd());
    }
    if (built > 0) {
      lines.push("", "Nothing has been pushed. Look at the branches before they go anywhere.");
    }
    if (parked > 0) {
      lines.push("", `${parked} decision${parked === 1 ? "" : "s"} waiting — \`toolroll decide\`, or \`toolroll brief\`.`);
    }
    return lines;
  };

  // One broken build fails the pass even if others succeeded: exit 0 must
  // mean "nothing needs you", and a half-broken pass does not qualify.
  if (broke > 0) {
    return fail(write, json, "tick", "build-failed", `${broke} of ${dispatched.length} dispatched tasks broke`, EXIT.failed, {
      considered,
      dispatched,
      routines,
    });
  }
  if (built > 0 || parked > 0 || dispatched.some(one => one.outcome === "planned" || one.outcome === "reported" || one.outcome === "held" || one.outcome === "reviewed" || one.outcome === "not-reviewed")) {
    return succeed(write, json, "tick", { considered, dispatched, routines, ...flows }, summary);
  }
  if (considered === 0) {
    return fail(write, json, "tick", "empty", "nothing is ready", EXIT.refused, {
      considered,
      dispatched,
      routines,
      ...flows,
    });
  }
  return fail(
    write,
    json,
    "tick",
    "nothing-dispatched",
    "everything ready is waiting on a person or held by somebody else",
    EXIT.refused,
    { considered, dispatched, routines, ...flows },
  );
}

/**
 * The recovery sweep: everything an unattended stretch may have left behind, in one pass.
 *
 * Three recoveries, in an order that matters. Dead runners first, because
 * recovery is the only path that *requeues* the tasks they held — reaping an
 * expired claim first would release it quietly and leave its task stranded
 * in `running`, unclaimable and unoffered, which is the most expensive kind
 * of bug because nothing anywhere reports it. Then expired leases. Then the
 * worktrees: rows whose directory is gone are dropped, and directories the
 * pool made but never recorded — a crash between `git worktree add` and the
 * row — are adopted, released and unverified, so they stop being invisible.
 *
 * Adoption fails closed: a git listing that errored is not a listing that
 * came back empty, and nothing is written or forgotten on its word. Run it
 * from cron before `tick`; a pass that trips over an orphan it could have
 * adopted is a dead loop at 3am.
 */
async function reconcileCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const demoFence = refuseDemo(context, "reconcile");
  if (demoFence !== null) return demoFence;
  const repo = repoFrom(flags);
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");

  // External trackers sync at reconcile cadence — the daemon inherits it
  // (watch runs reconcile periodically), and a FAILED pass is reported,
  // never swallowed: stale mirrors refuse dispatch on their own clock.
  const syncReports = [];
  for (const dispatchGrant of store.listGrants().filter(one => one.dispatch === true && one.remoteRepo != null && one.repo === repo)) {
    syncReports.push(await syncPass(store, dispatchGrant, context.dispatchAdapter ?? ghDispatchAdapter(), clock));
  }
  for (const report of syncReports) {
    if (report.outcome === "failed" || report.outcome === "blocked") {
      // Episodic and stamped (arc 3 findings 14/23): one open episode per
      // remote nags, a clean pass closes it, a recurrence pages again.
      store.enqueueEpisode(
        `sync:${report.remoteRepo}`,
        {
          source: { project: repo },
          kind: "sync-failed",
          pushClass: "attention",
          link: "/system",
          subject: `syncing ${report.remoteRepo} ${report.outcome === "blocked" ? "is blocked" : "failed"}`,
          body: `${report.detail ?? "the pass did not finish"} — external work keeps its last verified state and stops dispatching past its freshness window.`,
        },
        clock().toISOString(),
        clock(),
      );
    } else {
      store.resolveEpisodes(`sync:${report.remoteRepo}`, clock());
    }
  }

  const recovered = recoverDead(store, clock());
  // A run that ended, whatever its outcome, leaves nothing running: what is still in its process groups is stopped
  // (SIGTERM, then SIGKILL after 10 s) and the ledger names it. Never the live service.
  const closedRuns = await closeOutRuns(store, clock, { repo });
  // A finished run's processes that have since gone get their exits recorded,
  // so its task stops waiting on a person by itself.
  store.recordFinishedRunExits(clock());
  // A witness reserved for a spawn that never made a process (a crash or a
  // thrown spawn) settles once its run's process groups are proven gone.
  store.settleUnspawnedWitnesses(clock());
  store.settleQuiescentStops(clock());
  // An update whose updater ended while letting work finish must not leave new work paused.
  try { releaseStalledUpdate(dirname(context.databaseFile), clock()); } catch { /* status and the console say it */ }
  for (const one of recovered) {
    for (const leaseId of one.claims) {
      // Lease ids are unique forever, so each recovery is its own episode.
      store.enqueueNotification(
        {
          source: { taskRef: Number(store.handle.prepare("SELECT task_ref FROM claim WHERE lease_id = ?").get(leaseId)?.["task_ref"] ?? -1) },
          dedupeKey: `recover:${leaseId}`,
          kind: "runner-recovered",
          subject: `${one.runner} went dead holding work`,
          body: `Its claims were requeued and its worktrees handed back unverified. Lease ${leaseId}.`,
        },
        clock(),
      );
    }
    for (const runId of one.runs) {
      // Run ids are unique forever too (P0.1a): an attempt the dead machine
      // left open — its lease possibly long released — is finished as
      // interrupted exactly once, and said so exactly once.
      store.enqueueNotification(
        {
          source: { run: runId },
          dedupeKey: `recover-run:${runId}`,
          kind: "runner-recovered",
          subject: `${one.runner} went dead mid-attempt`,
          body: `Run #${runId} was still open with no live lease; it is now finished as interrupted. Check this task's current state in the console.`,
          link: `/r/${runId}`,
        },
        clock(),
      );
    }
  }
  const reaped = reap(store, clock());

  // Live-window display files age out here (arc 1): finalized runs after a
  // day, orphans on mtime, active runs untouchable. Never evidence, never
  // load-bearing — a sweep that finds nothing is the common case.
  const liveSwept = sweepLiveLogs(store, context.evidenceRoot, clock());

  const worktrees = new WorktreePool(store, {
    root: pool,
    ...(context.gitRunner === undefined ? {} : { runner: context.gitRunner }),
  });
  const adoption = await worktrees.adopt(repo, clock());
  if (adoption.ok) {
    const now = clock();
    const notice = worktreeAdoptionNotice(repo, adoption.adopted, now);
    if (notice !== null) store.enqueueNotification(notice, now);
  }
  if (!adoption.ok) {
    // The claim and lease work above is real and stands; only the worktree
    // half could not be trusted, and the exit code says the sweep is not done.
    return fail(write, json, "reconcile", "git", adoption.message, EXIT.failed, {
      recovered,
      reaped: reaped.map(claim => claim.leaseId),
    });
  }

  // Checkout cleanup (Settings → Storage): finished work's clean checkouts go as the setting says (by default when
  // the task is complete or cancelled); their branches stay. Each removal is in the ledger.
  // Completing or cancelling a task stops anything still running from its checkout first.
  const closedCheckouts = await closeOutCheckouts(store, clock, finishedCheckouts(store, clock(), repo));
  const pruned = await cleanCheckouts(store, worktrees, clock, { manual: false, actor: "worker", repo });
  // What stays for review or for its changes drops its dependencies and build output; the next run's setup restores them.
  const slimmed = await slimKeptCheckouts(store, worktrees, clock, { actor: "worker", repo });

  // Retention (Settings → Retention): once a day, what's older than its setting goes; one ledger entry says what.
  let retention: RetentionSweep | null = null;
  try { retention = dailyRetention(store, context.evidenceRoot, clock()); } catch { retention = null; /* the next pass tries again */ }
  const retained = retention === null ? [] : retention.counts.filter(one => one.count > 0);

  // The daily storage sweep (storage-sweep.ts): stale test temp folders, orphans Toolroll left running, finished
  // checkouts, extra staged runtimes and dependency installs unused for a week; saved for Settings → Storage.
  let storageSwept: SweepRecord | null = null;
  try {
    storageSwept = await dailyStorageSweep(store, { databaseFile: context.databaseFile, pool: worktrees, tempRoots: context.tempRoots ?? tempRoots() }, clock);
  } catch { storageSwept = null; /* the next pass tries again */ }
  const swept = storageSwept === null ? [] : storageSwept.parts.filter(one => one.count > 0);

  const nothing =
    retained.length === 0 &&
    swept.length === 0 &&
    recovered.length === 0 &&
    reaped.length === 0 &&
    adoption.adopted.length === 0 &&
    adoption.forgotten.length === 0 &&
    pruned.removed.length === 0 &&
    closedRuns.length === 0 &&
    closedCheckouts.length === 0 &&
    slimmed.slimmed.length === 0 &&
    liveSwept.removed.length === 0;

  return succeed(
    write,
    json,
    "reconcile",
    {
      recovered,
      reaped: reaped.map(claim => claim.leaseId),
      adopted: adoption.adopted,
      forgotten: adoption.forgotten,
      checkoutsRemoved: pruned.removed.map(one => one.path),
      checkoutsKept: pruned.kept,
      processesStopped: [...closedRuns.map(one => ({ run: one.runId, pids: one.done.stopped.map(row => row.pid) })), ...closedCheckouts.map(one => ({ checkout: one.path, pids: one.done.stopped.map(row => row.pid) }))],
      checkoutsSlimmed: slimmed.slimmed.map(one => one.path),
      liveViewsSwept: liveSwept.removed.length,
      retention: retention === null ? null : { counts: retention.counts, freedBytes: retention.freed },
      storageSweep: storageSwept,
    },
    () =>
      nothing
        ? ["Nothing to reconcile. Everything is where it should be."]
        : [
            ...recovered.map(
              one =>
                `Recovered ${one.runner}: ${one.claims.length} claim(s) requeued, ${one.worktrees.length} worktree(s) handed back unverified.`,
            ),
            ...(reaped.length === 0 ? [] : [`Reaped ${reaped.length} expired lease(s).`]),
            ...adoption.adopted.map(path => `Adopted ${path} — released, unverified, somebody should look.`),
            ...adoption.forgotten.map(path => `Forgot ${path} — its directory is gone.`),
            ...(pruned.removed.length === 0 ? [] : [`Removed ${pruned.removed.length} finished task checkout(s), about ${bytesWords(pruned.freed)}; their branches stay.`]),
            ...closedRuns.map(one => `Run #${one.runId} ended; stopped ${stoppedWords(one.done)}.`),
            ...closedCheckouts.map(one => `${one.path}: its task finished; stopped ${stoppedWords(one.done)}.`),
            ...(slimmed.slimmed.length === 0 ? [] : [`Dropped dependencies and build output from ${slimmed.slimmed.length} kept checkout(s), about ${bytesWords(slimmed.slimmed.reduce((sum, one) => sum + one.bytes, 0))}.`]),
            ...(liveSwept.removed.length === 0 ? [] : [`Cleared ${liveSwept.removed.length} finished live view(s).`]),
            ...(retention === null || retained.length === 0 ? [] : [`Retention removed ${sweepWords(retention.counts, retention.freed)}.`]),
            ...(storageSwept === null || swept.length === 0 ? [] : [`Storage sweep: ${storageSweepWords(storageSwept.parts)}`]),
          ],
  );
}

// ---- gaps -----------------------------------------------------------------
// The computation lives in gaps.ts, shared with the web console; the CLI
// keeps only its own presentation.

/** `toolroll gaps` — the BLOCKED section of the morning, standalone. */
function gapsCommand(flags: Map<string, string | true>, context: Context): number {
  const { store, write, json, clock } = context;
  const repo = repoFrom(flags);
  const gaps = computeGaps(store, repo, clock());

  if (json) {
    write(envelopeJson({ ok: true, command: "gaps", repo, gaps }));
    return gaps.length === 0 ? EXIT.ok : EXIT.refused;
  }
  if (gaps.length === 0) {
    write(`No gaps for ${repo}. Everything recorded is verified.`);
    return EXIT.ok;
  }
  for (const gap of gaps) {
    const freed =
      gap.unblocks.length > 0
        ? `fills → ${gap.unblocks.length} task(s) start: ${gap.unblocks.join(", ")}`
        : gap.alsoBlocks.length > 0
          ? `part of what holds: ${gap.alsoBlocks.join(", ")}`
          : "nothing queued needs it yet";
    write(`  ${gap.key.padEnd(28)} ${gap.state}`);
    write(`    ${freed}`);
    write(`    verify: ${gap.verify}`);
    write(`    ${gap.instructions}`);
  }
  return EXIT.refused;
}

// ---- the report -----------------------------------------------------------

/**
 * `toolroll brief` — one ritual (§6). The recent runs from the run table,
 * the blocked gaps ranked by what filling them frees, the PRs waiting on a
 * person, and where decisions will go when M3 gives them a shape.
 *
 * REVIEW is a live network read through `gh`, so it distinguishes three
 * states a lazy version would collapse: read and empty, read and full, and
 * *not read* — offline (--local) or failed — because "no PRs" and "could
 * not look" send the reader in different directions. Token and dollar
 * figures wait until run records carry usage (M4's economics); a briefing
 * that printed $0.00 it never measured would be lying with precision.
 */
async function briefCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const repo = repoFrom(flags);

  // --latest-watch bounds the report to one service window's actual edges
  // (§6): the last watch episode's window and runner, instead of "the last
  // 24 hours" — which can mix two windows, or none.
  const episode = flags.has("latest-watch") ? store.latestWatchEpisode(repo) : null;
  if (flags.has("latest-watch") && episode === null) {
    return fail(write, json, "brief", "no-watch", "no watch episode recorded for this repo yet — run `toolroll watch` first", EXIT.refused);
  }
  const since =
    episode?.startedAt ??
    text(flags, "since") ??
    new Date(clock().getTime() - 24 * 60 * 60_000).toISOString();

  let runs = store.runsSince(since);
  if (episode !== null) {
    runs = runs.filter(
      one =>
        one.runner === episode.runner &&
        (episode.endedAt === null || one.startedAt <= episode.endedAt),
    );
  }
  // One arithmetic, shared with the console — see summary.ts for why the
  // measured/invoked distinction exists.
  const { built, failed, refused, cutDown, invoked, measured, spend, tokens } = tally(runs);

  const gaps = computeGaps(store, repo, clock());
  // What still wants a person: routine progress facts (Telegram task
  // updates) are delivery, not attention, and never pad this tally — but a
  // task update the live pairing tried and failed to send is trouble, and
  // is counted rather than hidden behind quiet progress.
  const pending = store.pendingForAttention();

  // Deadlines are swept wherever decisions are shown, so "overdue" is a fact
  // the brief computes rather than one it hopes somebody else computed.
  // A report never expires or changes a saved decision.
  const decisions = store.listDecisions("unanswered");
  // No time window on incidents: a task held by a malformed park last
  // Tuesday is still held, and a brief that let it age out of view would
  // make the stall silent — which is the one thing an incident exists to
  // prevent.
  const incidents = store.openIncidents();
  // Nor on stranded work: a queued task behind a terminally failed blocker
  // never becomes ready, silently, forever — unless it is said here.
  const stranded = store.strandedTasks();

  let review:
    | { state: "read"; pulls: { number: number; title: string }[] }
    | { state: "not-read"; why: string };
  if (flags.has("local")) {
    review = { state: "not-read", why: "--local, the network was not asked" };
  } else {
    const read = await readPulls(repo);
    review =
      read.problems.length > 0 && read.pulls.length === 0
        ? { state: "not-read", why: read.problems[0] ?? "unreadable" }
        : { state: "read", pulls: read.pulls.map(one => ({ number: one.number, title: one.title })) };
  }

  if (json) {
    write(
      envelopeJson(
        {
          ok: true,
          command: "brief",
          repo,
          since,
          episode,
          tally: { built, failed, refused, cutDown },
          economics: {
            invocations: invoked.length,
            measured: measured.length,
            costUsd: spend,
            tokens,
          },
          gaps,
          review,
          outboxPending: pending.length,
          decide: decisions,
          incidents,
          stranded,
        },
      ),
    );
    return EXIT.ok;
  }

  const lines: string[] = [`toolroll — the report ─ ${repo}`];
  if (episode !== null) {
    lines.push(
      `  episode      watch #${episode.id} on ${episode.runner} · ${episode.startedAt} → ${
        episode.endedAt ?? "never ended — it is running, or it died without saying"
      }`,
    );
  }
  lines.push(
    `  runs         ${built.length} built · ${failed.length} failed · ${refused.length} refused${
      cutDown.length > 0 ? ` · ${cutDown.length} cut down mid-flight` : ""
    }`,
  );
  // The closed machine-authored verdict (Priority 2), one batched read —
  // never re-derived here, and never a reason to hide a built run's row.
  const proofVerdicts = store.proofVerdictsFor(built.map(one => one.id));
  for (const one of built) {
    const verdict = proofVerdicts.get(one.id);
    const accepted = verdict !== undefined && store.proofAcceptance(one.id) !== null;
    const proofNote =
      verdict === undefined || accepted || (verdict.verdict !== "short" && verdict.verdict !== "refuted")
        ? ""
        : ` — ${proofVerdictWords(verdict.verdict, verdict.reasons).word}`;
    lines.push(`      ${one.taskId.padEnd(20)} ${one.committed === true ? `committed to ${one.branch}` : "changed nothing, which is a real answer"}${proofNote}`);
  }
  for (const one of failed) {
    lines.push(`      ${one.taskId.padEnd(20)} failed: ${one.reason ?? "?"}${one.worktree === null ? "" : ` — work kept in ${one.worktree}`}`);
  }
  for (const one of cutDown) {
    lines.push(`      ${one.taskId.padEnd(20)} never finished — the process died with it; \`task show ${one.taskId}\``);
  }

  lines.push(`  spend        ${spendLine({ built, failed, refused, cutDown, invoked, measured, spend, tokens })}`);

  if (gaps.length > 0) {
    const best = gaps[0] as Gap;
    lines.push(`  ▸ BLOCKED    ${gaps.length} gap(s)${best.unblocks.length > 0 ? ` — filling ${best.key} starts ${best.unblocks.length} task(s)` : ""}`);
    for (const gap of gaps) {
      lines.push(`      ${gap.key.padEnd(28)} ${gap.state}`);
    }
    lines.push(`      → toolroll gaps --repo ${repo}`);
  }

  lines.push(
    review.state === "read"
      ? `  ▸ REVIEW     ${review.pulls.length} PR(s)${review.pulls.length > 0 ? "" : " — nothing waits"}`
      : `  ▸ REVIEW     not read — ${review.why}`,
  );
  if (review.state === "read") {
    for (const pull of review.pulls) lines.push(`      #${pull.number}  ${pull.title}`);
  }

  if (pending.length > 0) {
    lines.push(`  ▸ OUTBOX     ${pending.length} undelivered — toolroll outbox deliver --cmd …`);
  }

  if (decisions.length > 0) {
    const overdue = decisions.filter(one => one.state === "expired").length;
    lines.push(
      `  ▸ DECIDE     ${decisions.length} waiting${overdue > 0 ? ` (${overdue} overdue)` : ""} — toolroll decide`,
    );
    for (const one of decisions) {
      lines.push(`      ${String(one.id).padEnd(4)} ${one.taskId.padEnd(20)} ${one.question}`);
    }
  } else {
    lines.push("  ▸ DECIDE     nothing waits on you");
  }

  if (stranded.length > 0) {
    lines.push(`  ▸ STRANDED   ${stranded.length} task(s) behind failed blockers — they will never become ready on their own`);
    for (const one of stranded) {
      lines.push(`      ${one.id.padEnd(20)} waits on ${one.blockedBy.join(", ")} — \`toolroll task requeue ${one.blockedBy[0]}\``);
    }
  }

  if (incidents.length > 0) {
    lines.push(`  ▸ INCIDENTS  ${incidents.length} unresolved — these do not age out`);
    for (const incident of incidents) {
      lines.push(
        `      ${incident.taskId.padEnd(20)} ${incident.kind} since ${incident.createdAt} — read run ${incident.run}'s evidence, then \`toolroll incident resolve ${incident.id}\``,
      );
    }
  }

  write(lines.join("\n"));
  return EXIT.ok;
}

// ---- decisions ------------------------------------------------------------

/**
 * `toolroll decide` — the attention surface, in the terminal.
 *
 *   decide                          what waits, oldest first
 *   decide <id>                     one decision, whole, with its evidence
 *   decide <id> --choose <option> --as <you> --token <t> [--note …] [--key …]
 *
 * Who decided is recorded, never asserted: answering takes the same
 * authenticated identity as approving a scope, because "the operator chose
 * this" is exactly the sentence a later agent will act on — an agent or any
 * local process typing `--by operator` must not be able to write it.
 * Expiry runs first and never chooses: an overdue decision gets louder, and
 * stays answerable.
 */
async function decideCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  store.expireOverdueDecisions(clock());

  const [idText] = positional;
  if (idText === undefined) {
    const waiting = store.listDecisions("unanswered");
    if (json) {
      write(envelopeJson({ ok: true, command: "decide", waiting }));
      return waiting.length === 0 ? EXIT.ok : EXIT.refused;
    }
    if (waiting.length === 0) {
      write("Nothing waits on you. No decisions were parked.");
      return EXIT.ok;
    }
    for (const one of waiting) {
      const overdue = one.state === "expired" ? "  OVERDUE" : "";
      write(`  ${String(one.id).padEnd(4)} ${one.taskId.padEnd(20)} ${one.question}${overdue}`);
      write(`       options: ${one.options.map(option => option.id).join(" · ")}   recommended: ${one.recommendation}`);
    }
    write("");
    write("  → toolroll decide <id>       the whole screen");
    write("  → toolroll decide <id> --choose <option> --as <you> --token <t>");
    return EXIT.refused;
  }

  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(write, json, "decide", "usage", "`toolroll decide [<id>] [--choose <option>]`", EXIT.usage);
  }
  const decision = store.getDecision(id);
  if (decision === null) {
    return fail(write, json, "decide", "unknown-decision", `no decision ${id}`, EXIT.refused);
  }

  const choice = text(flags, "choose");
  if (choice === undefined) {
    const evidence = store.evidenceFor(id);
    const run = store.getRun(decision.run);
    const taskId = run === null ? "?" : store.externalIdFor(run.taskRef) ?? "?";
    if (json) {
      write(envelopeJson({ ok: true, command: "decide", decision, taskId, evidence }));
      return EXIT.ok;
    }
    write(`${taskId} — ${decision.state.toUpperCase()}${decision.deadline === null ? "" : ` · deadline ${decision.deadline}`}`);
    write("");
    write(`  ${decision.recap}`);
    write("");
    write(`  ${decision.question}`);
    write("");
    for (const option of decision.options) {
      const marks = [
        option.id === decision.recommendation ? "recommended" : "",
        option.reversible ? "reversible" : "IRREVERSIBLE",
      ]
        .filter(mark => mark !== "")
        .join(" · ");
      write(`  [${option.id}] ${option.label}  (${marks})`);
      write(`      ${option.consequence}`);
    }
    if (decision.state === "answered") {
      write("");
      write(`  answered: ${decision.choice} by ${decision.answeredBy} at ${decision.answeredAt}${decision.note === null ? "" : ` — ${decision.note}`}`);
    }
    if (evidence.length > 0) {
      write("");
      for (const artifact of evidence) {
        write(`  evidence  ${artifact.kind.padEnd(14)} ${artifact.key}${artifact.truncated ? "  (truncated)" : ""}`);
      }
    }
    write("");
    write(`  → toolroll decide ${id} --choose <option> --as <you> --token <t>`);
    return EXIT.ok;
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(
      write,
      json,
      "decide",
      "usage",
      "answering takes `--as <you> --token <t>` — who decided is recorded, not asserted",
      EXIT.usage,
    );
  }
  const { name: asWho, token } = acting;
  const authenticated = authenticateApprover(store, asWho, token);
  if (!authenticated.ok) {
    return fail(write, json, "decide", authenticated.reason, describeApproveFailure(authenticated.reason, String(id)), EXIT.refused);
  }

  const note = text(flags, "note");
  const answered = store.answerDecision(
    { id, choice, by: asWho, via: "cli", ...(note === undefined ? {} : { note }) },
    clock(),
    mutationFrom(flags, clock()),
  );
  if (!answered.ok) {
    const why =
      answered.reason === "bad-option"
        ? `"${choice}" is not one of this decision's options — \`toolroll decide ${id}\` shows them`
        : answered.reason === "already-answered"
          ? `decision ${id} was already answered differently — "decided" is not negotiable; park a new task if the answer must change`
          : answered.reason === "bad-note"
            ? "the note is too long or carries control characters"
            : `no decision ${id}`;
    return fail(write, json, "decide", answered.reason, why, EXIT.refused);
  }

  return succeed(write, json, "decide", { decision: answered.decision, duplicate: answered.duplicate === true }, () =>
    answered.duplicate === true
      ? [`Decision ${id} was already answered with ${choice} — nothing changed.`]
      : [
          `Decided: ${choice} for decision ${id}, as ${asWho}.`,
          "The task returns to the ready set; the next tick resumes it with your answer in hand.",
        ],
  );
}

/**
 * `toolroll serve [--port N] [--host H] [--allow-host name:port …]` —
 * the decision view, on a phone. Signing in takes the approver credential;
 * there is no unauthenticated bind, localhost included. Plain HTTP: put a
 * TLS proxy in front for anything beyond a trusted network — Tailscale is
 * the intended road, with its name passed via --allow-host.
 */
/**
 * The extracted console starter (arc 2 finding 5/20): binds and resolves —
 * or rejects — with NO signal handlers and NO output. serveCommand wraps it
 * with its historical greeting and Ctrl-C wait; `up` supervises it beside
 * the watch loops.
 */
async function startConsole(options: {
  context: Context;
  host: string;
  port: number;
  localRunner?: string;
  poolRoot: string;
  allowedHosts?: string[];
  setupCode?: string;
  repos?: string[];
  projectRoots?: string[];
  currentRepos?: () => readonly string[];
  admittedRepos?: () => readonly string[];
  publicUrl?: string;
  registryPath?: string;
  upConsole?: boolean;
  editorLinks?: "vscode";
  attended?: import("./serve.js").ServeOptions["attended"];
}): Promise<{ server: ReturnType<typeof createDecisionServer>; port: number; url: string }> {
  const { context } = options;
  const server = createDecisionServer({
    store: context.store,
    ...(context.desktopIdentity === undefined ? {} : { desktopIdentity: context.desktopIdentity }),
    ...(context.additionalProjectRepos === undefined || options.currentRepos === undefined ? {} : { additionalProjectRepos: options.currentRepos }),
    evidenceRoot: context.evidenceRoot,
    clock: context.clock,
    telegramTokenFile: context.telegramTokenFile,
    configDir: dirname(context.databaseFile),
    ...(options.localRunner === undefined ? {} : { localRunner: options.localRunner }),
    poolRoot: options.poolRoot,
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    // This computer's own tailnet names are admitted on the served port without an --allow-host (onboarding).
    tailnetNames: context.tailnetNames ?? (() => readTailnetNames()),
    // With no lead set up yet, the agent signed in on this computer runs it (onboarding).
    leadByDefault: true,
    ...(options.setupCode === undefined ? {} : { setupCode: options.setupCode }),
    ...(options.repos === undefined ? {} : { repos: options.repos }),
    ...(options.projectRoots === undefined ? {} : { projectRoots: options.projectRoots }),
    ...(options.currentRepos === undefined ? {} : { currentRepos: options.currentRepos }),
    ...(options.admittedRepos === undefined ? {} : { admittedRepos: options.admittedRepos }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.registryPath === undefined ? {} : { registryPath: options.registryPath }),
    ...(options.upConsole === undefined ? {} : { upConsole: options.upConsole }),
    ...(options.editorLinks === undefined ? {} : { editorLinks: options.editorLinks }),
    ...(options.attended === undefined ? {} : { attended: options.attended }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  }).catch(error => {
    throw new Error(`could not listen on ${options.host}:${options.port} — ${describe(error)}`);
  });
  // v104: monitoring runs beside the console (every setup has one): one loop sends the audit stream and traces where
  // Settings → Monitoring says, and stops when the console does. A lease keeps a second process from sending too.
  const stopMonitoring = startMonitoring({
    store: context.store, settings: () => readMonitoring(dirname(context.databaseFile)),
    instance: options.publicUrl ?? hostname(), version: packageVersion(),
  });
  server.on("close", stopMonitoring);
  // v105: budget alerts at 50/80/100 %, a pass a minute.
  server.on("close", startBudgetAlerts(context.store));
  // A paused provider's sign-in is checked every two minutes (no model, nothing spent); the pause lifts when it works.
  server.on("close", startSignInProbes(context.store, createConnectionChecker()));
  // Sprint 8: scheduled backups, a pass a minute; its lease also tells a restore that the console is running.
  server.on("close", startBackups(context.store, context.databaseFile));
  server.on("close", startCodexLimits(context.store));
  // At most one anonymous look a day for a newer Toolroll (Settings → Updates can switch it off).
  server.on("close", startUpdateChecks(context.store, dirname(context.databaseFile), PACKAGE_VERSION, installMethod(context.installBin).updateCommand, context.releaseIo ?? {}));
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : options.port;
  // A bind-everywhere address is not a place a browser can go: the URL
  // we print and open names localhost, which the console always admits.
  const shown = options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host;
  return { server, port, url: `http://${shown}:${port}/` };
}

async function serveCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const portGiven = text(flags, "port");
  const port = Number(portGiven ?? 4180);
  // Validated like demo's --port — a NaN handed to listen() surfaced as a
  // baffling bind failure instead of a usage answer (round-4 finding 11).
  if (portGiven !== undefined && (!Number.isInteger(port) || port < 1 || port >= 65536)) {
    return fail(write, json, "serve", "usage", "--port is a whole number under 65536", EXIT.usage);
  }
  const host = text(flags, "host") ?? "127.0.0.1";
  const allow = text(flags, "allow-host");
  // The authorization ceiling: --repo (comma-separable) names repos this
  // server may show; --project-root authorizes any git repo under a
  // directory. Neither given = legacy unscoped mode, everything visible.
  const repoFlag = text(flags, "repo");
  const rootFlag = text(flags, "project-root");

  // The live peek's locality assertion (live-peek v3 §3): --runner names
  // the runner this machine owns — an ADMINISTRATOR ASSERTION, documented
  // as such, and the peek stays off entirely without it. --pool overrides
  // the checkout pool root the peek confines itself to.
  const localRunner = text(flags, "runner");
  const poolRoot = text(flags, "pool") ?? join(dirname(context.databaseFile), "worktrees");
  const publicUrl = text(flags, "public-url");
  // Editor deep links (arc 6): a deployment capability whose value is an
  // allow-list of one, and which is meaningless without the machine's
  // runner assertion — links bind to runs this machine owns.
  const editor = text(flags, "editor");
  if (editor !== undefined && editor !== "vscode") {
    return fail(write, json, "serve", "usage", "--editor supports: vscode", EXIT.usage);
  }
  if (editor !== undefined && localRunner === undefined) {
    return fail(write, json, "serve", "usage", "--editor needs --runner <name> — links bind to the worktrees this machine's runner owns", EXIT.usage);
  }

  // The first-account road (setup review): with no approver, the login
  // page offers to create one, gated by this code — printed below, once.
  const setupCode = store.listApprovers().length === 0 ? String(randomInt(100_000, 1_000_000)) : undefined;
  const console_ = await startConsole({
    context,
    host,
    port,
    ...(setupCode === undefined ? {} : { setupCode }),
    ...(localRunner === undefined ? {} : { localRunner }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(editor === undefined ? {} : { editorLinks: "vscode" as const }),
    registryPath: registryPathOf(context),
    poolRoot,
    ...(allow === undefined ? {} : { allowedHosts: allow.split(",") }),
    ...(repoFlag === undefined ? {} : { repos: repoFlag.split(",").map(one => one.trim()).filter(one => one !== "") }),
    ...(rootFlag === undefined ? {} : { projectRoots: rootFlag.split(",").map(one => one.trim()).filter(one => one !== "") }),
  });
  const server = console_.server;
  const actual = console_.port;
  if (json) {
    write(envelopeJson({ ok: true, command: "serve", host, port: actual, ...(setupCode === undefined ? {} : { setupCode }) }));
  } else if (setupCode !== undefined) {
    write(`The console is on http://${host}:${actual}/`);
    write(`No account yet. Open http://${host === "0.0.0.0" ? "localhost" : host}:${actual}/login and enter setup code ${setupCode} to create the first one.`);
    write("Plain HTTP: keep it on localhost or a tailnet, and put TLS in front for anything else.");
    write("Ctrl-C stops it.");
  } else {
    write(`The console is on http://${host}:${actual}/ — sign in with your username and password.`);
    write("Plain HTTP: keep it on localhost or a tailnet, and put TLS in front for anything else.");
    write("Ctrl-C stops it.");
  }

  await new Promise<void>(resolve => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT.ok;
}

/**
 * `toolroll task requeue <id>` — the authenticated way back from a stall.
 * Resolves the task's open incidents (their holds lift with them), clears
 * strikes and backoff, and returns the task to the queue in one
 * transaction. Nothing else moves a stalled task: retrying by hand-editing
 * state would leave the incident claiming the task is stopped.
 */
async function requeueTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [id] = positional;
  if (id === undefined) {
    return fail(write, json, "task requeue", "usage", "`toolroll task requeue <id> --as <you> --token <t>`", EXIT.usage);
  }
  const racingGuard = refuseWhileRacing(context, "task requeue", id);
  if (racingGuard !== null) return racingGuard;
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task requeue", "usage", "requeueing takes `--as <you> --token <t>` — who overrode the stall is recorded, not asserted", EXIT.usage);
  }
  const { name: asWho, token } = acting;
  const authenticated = authenticateApprover(store, asWho, token);
  if (!authenticated.ok) {
    return fail(write, json, "task requeue", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }

  const result = store.requeueTask(id, asWho, clock());
  if (!result.ok) {
    const why: Record<typeof result.reason, string> = {
      "unknown-task": `no task ${id}`,
      "not-stalled": `${id} has nothing to rerun: it is queued or running, or it finished without a rejected result`,
      claimed: `a runner holds ${id} right now — wait for the attempt to end, or stop it`,
      "accepted-result": `${id}'s last result was accepted; change it through a revision, not a rerun`,
      published: `${id}'s last result is published; revise it through its pull request`,
    };
    return fail(write, json, "task requeue", result.reason, why[result.reason], EXIT.refused);
  }
  return succeed(write, json, "task requeue", { id, resolvedIncidents: result.resolvedIncidents, rejectedRun: result.rejectedRun }, () => [
    result.rejectedRun !== null
      ? `${id} is queued again: attempt #${result.rejectedRun} was not accepted, so the next attempt continues on the same branch under the current scope. Re-scope first if the candidate changed.`
      : `${id} is queued again${result.resolvedIncidents > 0 ? `, ${result.resolvedIncidents} incident(s) resolved` : ""}. Strikes cleared; the next pass may take it.`,
  ]);
}

/**
 * `toolroll task regate <id>` — the approved check again on the last
 * attempt's exact commit (v70). A new attempt whose prepared candidate is
 * that commit: no agent, a fresh receipt and proof, the ordinary review.
 * The operator's yes seals the rerun scope; who asked is recorded.
 */
async function regateTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [id] = positional;
  if (id === undefined) {
    return fail(write, json, "task regate", "usage", "`toolroll task regate <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task regate", "usage", "rerunning the check takes `--as <you> --token <t>` — the rerun scope is approved in your name", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, "task regate", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }
  const result = regateTask(store, id, clock(), { kind: "operator", name: acting.name, token: acting.token });
  if (!result.ok) return fail(write, json, "task regate", result.reason, result.message, EXIT.refused);
  return succeed(write, json, "task regate", { id, run: result.run, head: result.head }, () => [
    `${id} is queued again: the approved check runs on commit ${result.head.slice(0, 7)} exactly as attempt #${result.run} left it, with no agent. A fresh review follows.`,
  ]);
}

/**
 * `toolroll task plan <id>` — ask for a plan before any promise exists.
 * Authenticated like every act that spends money on the operator's behalf:
 * a planner agent will read the repository and interrogate you over the
 * decision surface, and who asked for that is recorded, not asserted.
 */
async function planTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [id] = positional;
  if (id === undefined) {
    return fail(write, json, "task plan", "usage", "`toolroll task plan <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task plan", "usage", "planning takes `--as <you> --token <t>` — it dispatches an agent that spends", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, "task plan", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task plan", "refused", `no task ${id}`, EXIT.refused);
  }
  const ref = store.refFor(BUILT_IN, id);
  // Plan pins (P2/C7): a named pair binds the PLAN phase only, refused
  // while a live plan claim is spending on the previous answer.
  const pinProvider = text(flags, "provider");
  const pinModel = text(flags, "model");
  if (pinProvider !== undefined) {
    if (!isProviderId(pinProvider)) {
      return fail(write, json, "task plan", "usage", `unknown provider \`${pinProvider}\``, EXIT.usage);
    }
    // A plan pin is an exact pair (v47): the route freezes model ids, and
    // a pin with no model would bind nothing exact.
    if (pinModel === undefined || pinModel === "") {
      return fail(write, json, "task plan", "usage", "a plan pin names an exact --model with --provider — approvals bind exact routing", EXIT.usage);
    }
    const valid = validateSpec({ provider: pinProvider, model: pinModel });
    if (!valid.ok) return fail(write, json, "task plan", "invalid", valid.problem, EXIT.usage);
    const pinned = store.setPlanPins(ref.id, pinProvider, pinModel, clock());
    if (!pinned.ok) {
      return fail(write, json, "task plan", "refused", "a planner holds this task right now — the pin would reroute a live spend", EXIT.refused);
    }
  } else if (pinModel !== undefined) {
    return fail(write, json, "task plan", "usage", "--model rides --provider for a plan pin", EXIT.usage);
  }
  const result = store.requestPlan(ref.id, clock());
  if (!result.ok) {
    return fail(write, json, "task plan", "refused", result.reason, EXIT.refused);
  }
  const autoPlan = authorizePlanUnderMode(store, id, acting.name, clock());
  return succeed(write, json, "task plan", { id, autoPlan, ...(pinProvider === undefined ? {} : { planProvider: pinProvider, planModel: pinModel ?? null }) }, () => [
    `${id} will be planned before it is built: the next pass dispatches a planner${pinProvider === undefined ? "" : ` on ${pinProvider}${pinModel === undefined ? "" : ` \u00b7 ${pinModel}`}`}.`,
    autoPlan ? "An unchanged, verified plan can auto-approve under your signed mode. Amendments and questions still wait for you." : "Its questions reach you like any decision; its plan lands as a scope for you to edit and approve.",
  ]);
}

/** Read saved work; neither form requests a new provider review. */
async function reviewTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  if (flags.has("brief")) {
    const allowed = new Set(["brief", "all", "run", "json", "db", "as", "token"]);
    for (const name of flags.keys()) if (!allowed.has(name)) return fail(write, json, "task review", "usage", `--${name} is not a task review --brief option.`, EXIT.usage);
    const task = positional[0], selected = flags.get("run");
    if (positional.length !== 1 || !task || task.length > 64 || /[\x00-\x1f\x7f]/.test(task) ||
        selected !== undefined && (typeof selected !== "string" || !/^[1-9]\d*$/.test(selected) || !Number.isSafeInteger(Number(selected)))) {
      return fail(write, json, "task review", "usage", "Use toolroll task review <task> --brief [--run <id>] [--all] [--json].", EXIT.usage);
    }
    // The normal CLI entry has already authenticated lead tokens. Local reads
    // stay available; a signed-in lead sees only its owner's admitted projects.
    let viewer = currentActor()?.account ?? null;
    if (viewer === null && (flags.has("as") || flags.has("token"))) {
      const acting = await askCredentials(flags, context);
      if (acting === null || !authenticateApprover(store, acting.name, acting.token).ok) return fail(write, json, "task review", "unauthenticated", "That sign-in is not valid.", EXIT.refused);
      viewer = acting.name;
    }
    const repos = viewer === null ? null : store.knownRepos().filter(repo => store.accountCanAccess(viewer!, repo));
    const result = taskReviewBrief(store, task, context.evidenceRoot, context.now, { principal: "operator", repos, includeUnplaced: viewer === null },
      { ...(selected === undefined ? {} : { run: Number(selected) }), all: flags.has("all"), secrets: [context.leadToken ?? "", text(flags, "token") ?? ""] });
    if (!result.ok) return fail(write, json, "task review", result.reason, result.message, EXIT.refused);
    return succeed(write, json, "task review", { brief: result.brief }, () => renderReviewBrief(result.brief));
  }
  if (flags.has("run") || flags.has("all")) return fail(write, json, "task review", "usage", "--run and --all require --brief.", EXIT.usage);
  const [runText] = positional;
  const runId = Number(runText ?? "");
  if (runText === undefined || !Number.isInteger(runId) || runId < 1) {
    return fail(write, json, "task review", "usage", "`toolroll task review <run-id>`", EXIT.usage);
  }
  // Read-only: the run's one automatic review, when it had one.
  const review = buildReviewOf(store, runId);
  if (review !== null) {
    return succeed(write, json, "task review", { run: runId, review }, () => [`Run ${runId}`, ...buildReviewLines(review)]);
  }
  return fail(write, json, "task review", "model-review-retired",
    `Run ${runId} has no automatic review. Manual review requests have been removed; a project's builds are reviewed automatically when its switch is on (\`toolroll review on --repo <path>\`). Inspect the saved work and checks, then give feedback or request a revision.`, EXIT.refused);
}

/**
 * `toolroll incident list|resolve <id>` — the parks that never became
 * decisions. Resolving is an authenticated human act, the same credential as
 * approving and deciding, and it is the only thing that lifts the
 * incident's hold: `task unhold` deliberately cannot, because an operator
 * pause and a broken park are different facts owned by different acts.
 */
async function incidentCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, idText] = positional;

  if (action === undefined || action === "list") {
    const incidents = store.openIncidents();
    if (json) {
      write(envelopeJson({ ok: true, command: "incident list", incidents }));
      return incidents.length === 0 ? EXIT.ok : EXIT.refused;
    }
    if (incidents.length === 0) {
      write("No unresolved incidents.");
      return EXIT.ok;
    }
    for (const incident of incidents) {
      write(`  ${String(incident.id).padEnd(4)} ${incident.taskId.padEnd(20)} ${incident.kind}  since ${incident.createdAt}  run ${incident.run}`);
    }
    write("");
    write("  → toolroll incident resolve <id> --as <you> --token <t>");
    return EXIT.refused;
  }

  if (action !== "resolve") {
    return fail(write, json, "incident", "usage", "`toolroll incident [list|resolve <id>]`", EXIT.usage);
  }
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(write, json, "incident resolve", "usage", "`toolroll incident resolve <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "incident resolve", "usage", "resolving takes `--as <you> --token <t>` — who looked is recorded, not asserted", EXIT.usage);
  }
  const { name: asWho, token } = acting;
  const authenticated = authenticateApprover(store, asWho, token);
  if (!authenticated.ok) {
    return fail(write, json, "incident resolve", authenticated.reason, describeApproveFailure(authenticated.reason, String(id)), EXIT.refused);
  }

  const resolved = store.resolveIncident(id, asWho, clock());
  if (!resolved) {
    return fail(write, json, "incident resolve", "unknown-or-resolved", `no unresolved incident ${id}`, EXIT.refused);
  }
  return succeed(write, json, "incident resolve", { id, by: asWho }, () => [
    `Resolved incident ${id}, as ${asWho}. The task's hold is lifted; the next tick may take it.`,
  ]);
}

/**
 * `toolroll webhook …` — Slack and Discord as UI-ONLY mirrors: every
 * page is a message with a console link; acting stays in the console
 * behind its own authentication. The URL is a credential: 0600 file
 * beside the database, or the environment, never anywhere else.
 */
async function webhookCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const dir = dirname(context.databaseFile);
  const [action, which, value] = positional;

  const telegramConfigured = loadBotToken(process.env, context.telegramTokenFile) !== null;

  if (action === undefined || action === "status") {
    const targets = loadWebhookTargets(process.env, dir);
    const consoleUrl = loadConsoleUrl(process.env, dir);
    const primary = effectivePrimary(process.env, dir, telegramConfigured);
    if (json) {
      write(envelopeJson({ ok: true, command: "webhook status", configured: primary.configured, primary: primary.channel, implicit: primary.implicit, consoleUrl }));
      return EXIT.ok;
    }
    write(`Messaging${primary.configured.length === 0 ? ": nothing configured" : ""}`);
    for (const channel of primary.configured) {
      write(`  ${channel.padEnd(8)} connected${channel === primary.channel ? "  ← receives alerts" : "  (silent — not primary)"}`);
    }
    if (primary.implicit && primary.channel !== null) {
      write(`  ! several services are connected and none was chosen — ${primary.channel} receives alerts by default.`);
      write(`    Choose: toolroll webhook primary telegram|slack|discord`);
    }
    write(`  links    ${consoleUrl ?? "NOT SET — messages will carry no console link; toolroll webhook set console-url http://host:port"}`);
    if (targets.length === 0) {
      write("");
      write("  toolroll webhook set slack https://hooks.slack.com/services/…");
      write("  toolroll webhook set discord https://discord.com/api/webhooks/…");
      write(`  (or export ${SLACK_ENV} / ${DISCORD_ENV})`);
    }
    write("");
    write("  Mirrors deliver when Telegram is not configured; with a paired Telegram");
    write("  chat, Telegram carries the page (it can hold buttons) and mirrors stay quiet.");
    return EXIT.ok;
  }

  if (action === "test") {
    const targets = loadWebhookTargets(process.env, dir);
    if (targets.length === 0) {
      return fail(write, json, "webhook test", "unconfigured", "no webhook configured — `toolroll webhook set slack|discord <url>`", EXIT.refused);
    }
    store.enqueueNotification(
      { source: { installation: true }, dedupeKey: `webhook-test:${clock().getTime()}`, kind: "test", subject: "toolroll webhook test", body: "If you can read this, the mirror works. Acting happens in the console." },
      clock(),
    );
    const report = await webhookPass(store, { targets, consoleUrl: loadConsoleUrl(process.env, dir), clock });
    if (report.problems.length > 0) {
      return fail(write, json, "webhook test", "delivery", report.problems.join("; "), EXIT.failed);
    }
    return succeed(write, json, "webhook test", { sent: report.sent }, () => [`Sent ${report.sent} message(s). Check the channel.`]);
  }

  if (action === "primary") {
    if (which === undefined || !isMessagingChannel(which)) {
      return fail(write, json, "webhook primary", "usage", "primary is one of telegram, slack, discord", EXIT.usage);
    }
    const primary = effectivePrimary(process.env, dir, telegramConfigured);
    if (!primary.configured.includes(which)) {
      return fail(write, json, "webhook primary", "unconfigured", `${which} is not configured — set it up first, then choose it`, EXIT.refused);
    }
    savePrimary(dir, which);
    return succeed(write, json, "webhook primary", { primary: which }, () => [
      `Alerts now go to ${which}. ${which === "telegram" ? "Buttons and replies work there as always." : "Telegram (if configured) still accepts taps and replies — it just stops sending alerts."}`,
    ]);
  }

  if (action === "clear" && (which === "slack" || which === "discord")) {
    clearWebhook(dir, which);
    return succeed(write, json, "webhook clear", { which }, () => [`${which} mirror cleared.`]);
  }

  if (action !== "set" || which === undefined || value === undefined) {
    return fail(write, json, "webhook", "usage", "`toolroll webhook [status|test|set slack|discord|console-url <value>|clear slack|discord]`", EXIT.usage);
  }
  if (which === "console-url") {
    const saved = saveConsoleUrl(dir, value);
    if (!saved.ok) return fail(write, json, "webhook set", "invalid", saved.message, EXIT.usage);
    return succeed(write, json, "webhook set", { which }, () => [`Console links will open ${value.replace(/\/+$/, "")}.`]);
  }
  if (which !== "slack" && which !== "discord") {
    return fail(write, json, "webhook set", "usage", "set what? slack, discord, or console-url", EXIT.usage);
  }
  const saved = saveWebhook(dir, which, value);
  if (!saved.ok) return fail(write, json, "webhook set", "invalid", saved.message, EXIT.usage);

  // The first moment more than one service exists is the moment to ask
  // which one pages — once, right here, not at 3am when both fire.
  const after = effectivePrimary(process.env, dir, telegramConfigured);
  let chosen: string | null = null;
  if (after.implicit && loadPrimary(process.env, dir) === null && after.configured.length > 1 && interactive() && !json) {
    write(`You now have ${after.configured.join(" and ")} connected.`);
    const answer = (await ask(`Which service should receive alerts? [${after.configured.join("/")}] `)).trim().toLowerCase();
    if (isMessagingChannel(answer) && after.configured.includes(answer)) {
      savePrimary(dir, answer);
      chosen = answer;
    } else {
      write(`Left unchosen — ${after.channel} receives alerts by default. Decide any time: toolroll webhook primary <service>`);
    }
  }
  return succeed(write, json, "webhook set", { which, ...(chosen === null ? {} : { primary: chosen }) }, () => [
    `${which} mirror configured — the URL lives in a private file beside the database.`,
    ...(chosen === null ? [] : [`${chosen} carries the pages.`]),
    ...(after.implicit && chosen === null && !interactive() ? [`Several services are configured — choose the pager: toolroll webhook primary <service>`] : []),
    `Send yourself a proof: toolroll webhook test`,
  ]);
}

/**
 * `toolroll providers resume <provider>` — a person says the sign-in works
 * again (after `claude /login`, say): the provider's sign-in pause lifts, its
 * tasks may start, and one short message says how many resumed. A pause that
 * lifted by itself answers so; nothing is paused twice.
 */
function resumeProviderCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const command = "providers resume";
  const provider = positional[0];
  if (provider === undefined || !isProviderId(provider) || positional.length > 1) {
    return fail(write, json, command, "usage", `Use \`toolroll providers resume <${PROVIDER_IDS.join("|")}>\`.`, EXIT.usage);
  }
  const who = text(flags, "as") ?? process.env["USER"] ?? "operator";
  const lifted = liftAuthPause(store, provider, "person", who, context.clock());
  if (lifted === null) return succeed(write, json, command, { provider, resumed: 0, paused: false }, () => [`${provider} is not paused.`]);
  return succeed(write, json, command, { provider, resumed: lifted.resumed, paused: false }, () => [
    `${provider} resumed — ${lifted.resumed} ${lifted.resumed === 1 ? "task" : "tasks"} can start again.`,
  ]);
}

/**
 * `toolroll providers` — identification, never integration theater.
 *
 * Four different claims, kept apart on purpose (Codex provider review):
 * INSTALLED (the binary answered --version), CONFIGURED (a phase names
 * it), HISTORICALLY SUCCESSFUL (a stamped run concluded — proof of login
 * AT THAT TIME), and CURRENTLY AUTHENTICATED (only where a cheap,
 * non-spending probe exists — codex's \`login status\`). Claude has no
 * probe that does not risk spend, and this report says so instead of
 * guessing; an OpenRouter key's PRESENCE proves neither validity nor
 * authorization, and is reported as exactly that.
 */
async function providersCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const probe = context.gitRunner ?? run;
  const configured = new Map<string, string[]>();
  for (const scope of [INSTALLATION_SCOPE]) {
    for (const row of store.listPhaseConfig(scope)) {
      configured.set(row.provider, [...(configured.get(row.provider) ?? []), row.phase]);
    }
  }

  // Probed CONCURRENTLY: each --version is a whole CLI start, and a report
  // that serializes four of them reads as a hang (Phase 3).
  const probed = await Promise.all(
    PROVIDER_IDS.map(async id => {
      const facts = inspectionOf(id);
      // A version probe carries no key (Codex gemini verify, finding 2).
      const version = await probe(facts.binary, ["--version"], { timeoutMs: 5_000, omitEnv: ALL_CREDENTIAL_ENV });
      const installed = version.code === 0 && !version.notFound;
      let identity: string | null = null;
      if (installed && facts.identityProbe !== null) {
        const asked = await probe(facts.binary, [...facts.identityProbe], { timeoutMs: 5_000, omitEnv: ALL_CREDENTIAL_ENV });
        identity = asked.code === 0 ? (asked.stdout.trim().split("\n")[0] ?? null) : "not logged in";
      }
      return { id, facts, version, installed, identity };
    }),
  );
  const report: Record<string, unknown>[] = [];
  for (const { id, facts, version, installed, identity } of probed) {
    const lastSuccess = store.providerLastSuccess(id);
    const keyPresent = facts.requiresEnv === null ? null : (process.env[facts.requiresEnv] ?? "") !== "";
    const installedVersion = installed ? (version.stdout.trim().split("\n")[0] ?? "") : null;
    const authMode = readAuthMode(id);
    const attestation = attestationOf(id);
    const versionProvenAtSpawn =
      installedVersion !== null && attestation !== null && versionInRange(installedVersion, attestation);
    const exhaustionRecognized =
      versionProvenAtSpawn && recognizesEligible(id, installedVersion, authMode);
    report.push({
      provider: id,
      binary: facts.binary,
      installed,
      version: installedVersion,
      identity,
      lastSuccessfulRun: lastSuccess,
      ...(keyPresent === null ? {} : { keyPresent, keyEnv: facts.requiresEnv }),
      measuresCost: facts.measuresCost,
      configuredPhases: configured.get(id) ?? [],
      fallbackReadiness: {
        authMode,
        versionProvenAtSpawn,
        exhaustionRecognized,
        automaticSwitchArmed: exhaustionRecognized,
        reason: exhaustionRecognized
          ? "this build can recognize an exhausted credential for the installed provider version"
          : attestation === null
            ? "this provider does not yet prove its version at spawn, so exhaustion classification fails closed"
            : !versionProvenAtSpawn
              ? "the installed provider version is not inside this build's attested range"
              : "no reviewed exhaustion fixture recognizes this auth mode at the installed provider version",
      },
      // The audit: facts about the harness, reported before any of them is
      // enforced. What transport we read, whether a session can resume,
      // which init signal exists, what hermetic flag we deliberately do NOT
      // pass, and which user-global config can reach an unattended run.
      audit: auditOf(id),
      // Tier-2 attestation (Phase 3): the range this adapter's conformance
      // fixtures cover, against what is installed right now. Tier-1
      // providers carry no entry — their runs are not version-gated.
      ...(attestationOf(id) === null
        ? {}
        : {
            attestation: {
              ...(attestationOf(id) as object),
              installedInRange:
                installed && versionInRange((version.stdout.trim().split("\n")[0] ?? ""), attestationOf(id) as AttestationRange),
            },
          }),
    });
  }

  // READINESS REPORTING (v47): `--report --runner <n> --token <t>` records
  // this machine's non-spending observations under the runner's OWN name
  // — authenticated, so nobody reports for a machine they do not hold —
  // and the route projections then say ready / unavailable / unknown per
  // provider. The observation runs the same version and identity probes
  // this report prints, plus key presence and the attestation range.
  let recorded: Omit<ReadinessObservation, "runner" | "observedAt">[] | null = null;
  if (flags.has("report")) {
    const runnerName = text(flags, "runner");
    const runnerToken = text(flags, "token");
    if (runnerName === undefined || runnerToken === undefined) {
      return fail(write, json, "providers", "usage", "`toolroll providers --report --runner <name> --token <t>` records readiness under that runner", EXIT.usage);
    }
    const observed = await observeProviderReadiness((file, args, options) => probe(file, args, { timeoutMs: options?.timeoutMs ?? 5_000, ...(options?.omitEnv === undefined ? {} : { omitEnv: options.omitEnv }) }));
    const reported = reportProviderReadinessAuthed(store, { name: runnerName, token: runnerToken, observations: observed }, context.clock());
    if (!reported.ok) {
      return fail(write, json, "providers", reported.reason, describeAuth(reported.reason, runnerName), EXIT.refused);
    }
    recorded = observed;
  }

  if (json) {
    write(envelopeJson({ ok: true, command: "providers", providers: report, ...(recorded === null ? {} : { readiness: recorded }) }));
    return EXIT.ok;
  }
  if (recorded !== null) {
    write(`readiness recorded for ${text(flags, "runner") ?? ""}:`);
    for (const one of recorded) write(`  ${one.provider.padEnd(11)}${one.state.toUpperCase()} — ${one.reason} [${one.probe}]`);
    write("");
  }
  for (const one of report) {
    const name = String(one["provider"]);
    write(`${name}`);
    write(`  installed      ${one["installed"] === true ? `yes — ${String(one["version"])}` : `no — \`${String(one["binary"])}\` did not answer`}`);
    if (one["identity"] !== null && one["identity"] !== undefined) {
      write(`  authenticated  ${String(one["identity"])} (probed just now, without spending)`);
    } else if (name === "claude") {
      write(`  authenticated  not probed — no non-spending check exists; a real run is the proof`);
    }
    write(`  last success   ${one["lastSuccessfulRun"] === null ? "never on this installation" : `${String(one["lastSuccessfulRun"])} — login was valid then`}`);
    if (one["keyEnv"] !== undefined) {
      write(`  ${String(one["keyEnv"])}  ${one["keyPresent"] === true ? "present (not validated — presence is not authorization)" : "ABSENT — runs will fail until the runner exports it"}`);
    }
    write(`  cost           ${one["measuresCost"] === true ? "measured in dollars per run" : "tokens only — runs land as UNMEASURED; ceilinged routines fail closed on them"}`);
    const phases = one["configuredPhases"] as string[];
    if (phases.length > 0) write(`  configured     ${phases.join(", ")} (installation)`);
    const fallback = one["fallbackReadiness"] as {
      automaticSwitchArmed: boolean;
      reason: string;
    };
    write(
      `  auto fallback  ${
        fallback.automaticSwitchArmed
          ? "armed — a configured and approved chain may advance after proven exhaustion"
          : `not armed — ${fallback.reason}`
      }`,
    );
    const audit = one["audit"] as ProviderAudit;
    write(`  transport      ${audit.transport}${audit.initSignal === "none" ? " — no init signal; a failed run cannot say whether the harness came up" : ` — init signal: ${audit.initSignal}`}`);
    write(`  resume         ${audit.resume}`);
    const attested = one["attestation"] as (AttestationRange & { installedInRange: boolean }) | undefined;
    if (attested !== undefined) {
      write(
        `  attested       ${attested.floor} up to (not including) ${attested.ceiling}, fixtures at ${attested.fixturesAt} — ${
          attested.installedInRange
            ? "the installed version is inside the range"
            : "the INSTALLED VERSION IS OUTSIDE THE RANGE; dispatch will refuse until re-attestation"
        }`,
      );
    }
    write(
      `  isolation      ${
        audit.isolation.flag === null
          ? "no hermetic flag"
          : `${audit.isolation.flag} exists, not passed${audit.isolation.resumeSafe === false ? " — it would break session resume" : audit.isolation.resumeSafe === null ? " — its effect on resume is unvalidated" : ""}`
      }`,
    );
    write(`  config surface ${audit.configSurface.join("; ")}`);
    write("");
  }
  write("  \u2192 toolroll config show    which provider each phase actually resolves to");
  return EXIT.ok;
}

/**
 * \`toolroll config …\` — which provider and model each phase runs on.
 *
 * Two scopes: the installation, and one project's override. Mutations are
 * AUTHENTICATED and AUDITED — spend routing is authority, not preference
 * (Codex provider review, Q4): an unauthenticated verb here would let
 * anything that can run a shell reroute every future build. Rows are
 * complete pairs; `show` prints what each phase actually resolves to.
 */
/**
 * `toolroll keys …` — provider API keys as managed files, never
 * ambient environment. The value NEVER rides an argv (visible in ps):
 * `set` reads it from --key-file or stdin. Authority is the filesystem's
 * own — these are 0600 files under the operator's home, and whoever can
 * write them already owns the machine's spend.
 */
async function keysCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { write, json } = context;
  const [action, provider, ...rest] = positional;
  if (action === undefined || !(KEYS_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "keys", "usage", `unknown \`keys ${action ?? ""}\` — try ${KEYS_ACTIONS.join(", ")}`, EXIT.usage);
  }
  if (action === "status") {
    const rows = PROVIDER_IDS.map(one => ({
      provider: one,
      envName: PROVIDER_KEY_ENV[one],
      ...keyStatus(one),
      ambient: (process.env[PROVIDER_KEY_ENV[one]] ?? "") !== "",
    }));
    if (json) {
      write(envelopeJson({ ok: true, command: "keys status", keys: rows }));
      return EXIT.ok;
    }
    for (const row of rows) {
      const mode = readAuthMode(row.provider);
      const state = row.set
        ? `stored${row.updatedAt === null ? "" : ` (${row.updatedAt.slice(0, 10)})`}`
        : row.ambient
          ? "environment only"
          : "not set";
      write(`  ${row.provider.padEnd(12)} ${row.envName.padEnd(22)} ${mode.padEnd(13)} ${state}`);
    }
    write("  → subscription-mode providers use their own login; api-key mode hands over the stored (or ambient) key");
    write("  → `keys auth <provider> subscription|api-key` switches; stored keys are kept either way");
    return EXIT.ok;
  }
  if (provider === undefined || !isProviderId(provider)) {
    return fail(write, json, `keys ${action}`, "usage", `which provider? ${PROVIDER_IDS.join(", ")}`, EXIT.usage);
  }
  if (action === "clear") {
    const cleared = clearProviderKey(provider);
    const mode = readAuthMode(provider);
    return succeed(write, json, "keys clear", { provider, cleared, mode }, () => [
      !cleared
        ? "No stored key to remove."
        : mode === "subscription"
          ? `The ${provider} key is removed. ${provider} uses its own login (subscription mode), so builds are unaffected.`
          : `The ${provider} key is removed — an environment variable, if one exists, takes over.`,
    ]);
  }
  if (action === "verify") {
    const stored = readProviderKey(provider);
    if (stored === null) {
      return fail(write, json, "keys verify", "refused", `no stored ${provider} key to verify`, EXIT.refused);
    }
    const verdict = await verifyProviderKey(provider, stored);
    return succeed(write, json, "keys verify", { provider, verdict }, () => [verdictWords(provider, verdict)]);
  }
  if (action === "auth") {
    const [wanted] = rest;
    if (wanted !== "subscription" && wanted !== "api-key") {
      return fail(write, json, "keys auth", "usage", `\`toolroll keys auth ${provider} subscription|api-key\``, EXIT.usage);
    }
    const set = setAuthMode(provider, wanted as AuthMode);
    if (!set.ok) {
      return fail(write, json, "keys auth", "refused", `${provider} has no subscription login — it is api-key only`, EXIT.refused);
    }
    return succeed(write, json, "keys auth", { provider, mode: wanted }, () => [
      wanted === "subscription"
        ? `${provider} now uses its own login; its stored key is kept as the fallback you can switch to.`
        : `${provider} now uses its API key; switch back with \`keys auth ${provider} subscription\`.`,
    ]);
  }
  const file = text(flags, "key-file");
  let value: string;
  if (file !== undefined) {
    try {
      value = readFileSync(file, "utf8");
    } catch {
      return fail(write, json, "keys set", "usage", `cannot read \`${file}\``, EXIT.usage);
    }
  } else {
    if (process.stdin.isTTY) {
      return fail(write, json, "keys set", "usage", "pipe the key in (\`toolroll keys set gemini < key.txt\` or via --key-file) — a key on an argv is visible to every process list", EXIT.usage);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    value = Buffer.concat(chunks).toString("utf8");
  }
  const saved = saveProviderKey(provider, value);
  if (!saved.ok) {
    return fail(write, json, "keys set", "implausible", "that does not look like an API key — check the paste", EXIT.refused);
  }
  // Save is instant (shape-checked); verification is a live credential
  // check that spends no tokens — skip it with --no-verify for an offline
  // machine or a provider you cannot reach right now.
  const verdict = flag(flags, "no-verify") ? null : await verifyProviderKey(provider, value);
  return succeed(write, json, "keys set", { provider, ...(verdict === null ? {} : { verdict }) }, () => [
    `The ${provider} key is stored (a private file, handed only to ${provider}'s own process at spawn).`,
    ...(verdict === null ? [] : [verdictWords(provider, verdict)]),
  ]);
}

/**
 * `toolroll people …` — who can sign in, and the doors in (v29,
 * U2/U3/D7). `invite` mints the single-use join link (approver-only, no
 * escalation road exists: the role is pinned at mint); `revoke` is the
 * severing act — sessions, invites, and the modes they signed all end,
 * history stays. The last active approver cannot be removed.
 */
async function peopleCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, ...rest] = positional;
  if (action === undefined || !(PEOPLE_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "people", "usage", `unknown \`people ${action ?? ""}\` — try ${PEOPLE_ACTIONS.join(", ")}`, EXIT.usage);
  }

  if (action === "list") {
    const accounts = store.accountFacts();
    const invites = store.openInvites(clock());
    if (json) {
      write(envelopeJson({ ok: true, command: "people list", accounts, invites }));
      return EXIT.ok;
    }
    if (accounts.length === 0) {
      write("Nobody yet — `toolroll approver add <name>` bootstraps the first.");
      return EXIT.ok;
    }
    for (const one of accounts) {
      const standing = one.revokedAt !== null ? `revoked ${one.revokedAt.slice(0, 10)} by ${one.revokedBy ?? "?"}` : one.role === "approver" ? "approves" : "watches";
      write(`  ${one.name.padEnd(20)} ${standing.padEnd(28)} joined ${one.addedAt.slice(0, 10)} · ${one.projects === null ? "all projects" : one.projects.length === 0 ? "no projects" : one.projects.join(", ")}`);
    }
    for (const one of invites) {
      write(`  (invite)             ${one.role} invite from ${one.mintedBy}, expires ${one.expiresAt.slice(0, 16).replace("T", " ")}`);
    }
    return EXIT.ok;
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, `people ${action}`, "usage", `\`toolroll people ${action} … --as <you> --token <t>\``, EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, `people ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, acting.name), EXIT.refused);
  }

  const repoGiven = text(flags, "repo");
  const allProjects = flags.has("all-projects");
  const noProjects = flags.has("no-projects");
  if ([repoGiven !== undefined, allProjects, noProjects].filter(Boolean).length > 1) return fail(write, json, `people ${action}`, "usage", "Choose --repo <path>, --all-projects, or --no-projects.", EXIT.usage);
  const repo = repoGiven === undefined ? null : canonicalProject(repoGiven);
  if (repoGiven !== undefined && repo === null) return fail(write, json, `people ${action}`, "usage", "The project folder must exist.", EXIT.usage);
  const projects = repo !== null ? [repo] : noProjects ? [] : null;
  if (action === "projects") {
    const name = rest[0]?.trim();
    if (!name || (repoGiven === undefined && !allProjects && !noProjects)) return fail(write, json, "people projects", "usage", "people projects <name> --repo <path> | --all-projects | --no-projects --as <you> --token <t>", EXIT.usage);
    const changed = store.setAccountProjects(name, projects, acting.name, clock());
    if (!changed.ok) return fail(write, json, "people projects", changed.reason, "Project access was not changed: " + changed.reason, EXIT.refused);
    return succeed(write, json, "people projects", { name, projects }, () => [`${name}: ${projects === null ? "all projects" : projects.length === 0 ? "no project access" : projects.join(", ")}. Access changes end existing sign-in sessions and derived authority.`]);
  }

  if (action === "invite") {
    const roleFlag = text(flags, "role") ?? "viewer";
    if (roleFlag !== "viewer" && roleFlag !== "approver") {
      return fail(write, json, "people invite", "usage", "--role viewer|approver (viewer is the default)", EXIT.usage);
    }
    if (noProjects) return fail(write, json, "people invite", "usage", "An invitation needs --repo <path> or all-project access.", EXIT.usage);
    const minted = store.mintInvite(roleFlag, acting.name, clock(), undefined, projects);
    return succeed(write, json, "people invite", { role: roleFlag, projects, path: `/join/${minted.token}`, expiresAt: minted.expiresAt }, () => [
      `The invite link's path — shown once, single-use, ${roleFlag === "approver" ? "they can approve and act" : "they can read work"} in ${projects === null ? "all projects" : projects.join(", ")}:`,
      `  /join/${minted.token}`,
      `Open it on this console's address. It dies ${minted.expiresAt.slice(0, 16).replace("T", " ")} UTC, or when you cancel it on the people screen.`,
    ]);
  }

  const [name] = rest;
  if (name === undefined || name.trim() === "") {
    return fail(write, json, "people revoke", "usage", "`toolroll people revoke <name> --as <you> --token <t>`", EXIT.usage);
  }
  const severed = store.revokeAccount(name.trim(), acting.name, clock());
  if (!severed.ok) {
    const words =
      severed.reason === "last-approver"
        ? "that is the last account that can approve — add another approver first"
        : severed.reason === "already-revoked"
          ? `${name} is already removed`
          : `no account \`${name}\``;
    return fail(write, json, "people revoke", severed.reason, words, EXIT.refused);
  }
  return succeed(write, json, "people revoke", { name: name.trim(), ...severed }, () => [
    `${name.trim()} can no longer sign in. Their open sessions, invites, and the ${severed.modesRevoked} mode(s) they signed ended with them.`,
    "Everything they ever approved or decided stays in the ledger, under their name.",
  ]);
}

const MODE_ACTIONS = ["set", "show", "revoke"] as const;

async function modeCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action] = positional;
  if (action === undefined || !(MODE_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "mode", "usage", `unknown \`mode ${action ?? ""}\` — try ${MODE_ACTIONS.join(", ")}`, EXIT.usage);
  }
  const repoGiven = text(flags, "repo");
  // The same canonical string every other road stores for the repository
  // (a symlinked path — /var vs /private/var — must name the same mode).
  const repo = repoGiven === undefined ? undefined : canonicalProject(repoGiven) ?? resolve(repoGiven);
  if (repo === undefined) {
    return fail(write, json, "mode", "usage", "`mode` needs --repo <canonical path> — a mode is per-repository", EXIT.usage);
  }
  const now = clock();

  if (action === "show") {
    const mode = store.activeMode(repo, now);
    if (mode === null) {
      return succeed(write, json, "mode show", { repo, active: null }, () => [`${repo}: locked — every act keeps its own ceremony (the default).`]);
    }
    const terms = modeTermsFromJson(mode.termsJson);
    return succeed(write, json, "mode show", { repo, active: { name: mode.name, signedBy: mode.signedBy, expiry: mode.absoluteExpiry, digest: mode.digest } }, () => [
      `${repo}: ${mode.name}, signed by ${mode.signedBy}`,
      ...(terms === null ? [] : modeWords(terms).map(w => `  ${w}`)),
      `  → mode revoke --repo ${repo} --as ${mode.signedBy} --token <t>   (or any approver; one click)`,
    ]);
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "mode", "usage", "signing or revoking a mode takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authed = authenticateApprover(store, acting.name, acting.token);
  if (!authed.ok) {
    return fail(write, json, "mode", authed.reason, "that is not an active approver, or the token does not match", EXIT.refused);
  }

  if (action === "revoke") {
    // Lowering authority is one click for ANY approver (v4 doctrine).
    const revoked = store.revokeMode(repo, acting.name, "operator", now);
    if (!revoked) return fail(write, json, "mode revoke", "no-mode", `${repo} has no active mode`, EXIT.refused);
    return succeed(write, json, "mode revoke", { repo }, () => [`${repo}: mode revoked. Every act it covered falls back to its own ceremony; running work is untouched.`]);
  }

  // set: RAISING authority — the password ceremony above already ran.
  const nameGiven = text(flags, "name") ?? "standard";
  if (nameGiven !== "standard" && nameGiven !== "hands-off") {
    return fail(write, json, "mode set", "usage", "--name is standard or hands-off", EXIT.usage);
  }
  const daysGiven = Number(text(flags, "days") ?? "1");
  if (!Number.isInteger(daysGiven) || daysGiven < 1 || daysGiven > MODE_MAX_DAYS) {
    return fail(write, json, "mode set", "usage", `--days is 1 to ${MODE_MAX_DAYS} (a mode always expires)`, EXIT.usage);
  }
  const expiry = new Date(now.getTime() + daysGiven * 24 * 60 * 60_000).toISOString();
  const terms = presetTerms(nameGiven as ModeName, expiry);
  // Explicit term overrides ride the same flags (all optional):
  if (text(flags, "publication") === "automerge") terms.publication = "automerge";
  if (text(flags, "publication") === "notify") terms.publication = "notify";
  if (flag(flags, "auto-approve")) terms.autoApproveFiling = true;
  if (flag(flags, "plan-auto")) terms.planAuto = true;
  if (["review-auto", "review-retry-auto", "repair-auto", "repair-max-attempts"].some(name => flags.has(name))) {
    return fail(write, json, "mode set", "invalid", "Separate model review and automatic correction loops have been removed; finished work goes to the lead or user.", EXIT.refused);
  }
  if (terms.planAuto && !terms.autoApproveFiling) {
    return fail(write, json, "mode set", "invalid", "--plan-auto requires automatic filing approval", EXIT.refused);
  }
  // The paid-fallback grant (R8): NEVER a preset default — only this
  // explicit flag lets an exhausted subscription switch to another account.
  if (flag(flags, "allow-paid-fallback")) terms.allowPaidFallback = true;
  // Approving plans and merges from the signer's paired chat: never a preset default, only this flag.
  if (flag(flags, "chat-approve")) terms.chatApprove = true;
  // Automerge requires a live merge-capable grant on the repo (D1).
  if (terms.publication === "automerge" && !store.hasMergeCapableGrant(repo, now)) {
    return fail(write, json, "mode set", "no-grant", "automerge needs a merge-capable publication grant on this repo — file one first", EXIT.refused);
  }
  const digest = modeDigestOf(terms);
  const id = store.signMode(
    { repo, name: nameGiven, termsJson: modeTermsJson(terms), digest, signedBy: acting.name, absoluteExpiry: expiry, publication: terms.publication },
    now,
  );
  return succeed(write, json, "mode set", { repo, id, digest, terms }, () => [
    `${repo}: ${nameGiven} mode signed by ${acting.name}, until ${expiry.slice(0, 16).replace("T", " ")}.`,
    ...modeWords(terms).map(w => `  ${w}`),
  ]);
}

async function configCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, phase] = positional;
  if (action !== undefined && !(CONFIG_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "config", "usage", `unknown \`config ${action}\` — try ${CONFIG_ACTIONS.join(", ")}`, EXIT.usage);
  }
  const repoGiven = text(flags, "repo");
  const scope = repoGiven === undefined ? INSTALLATION_SCOPE : canonicalProject(repoGiven) ?? resolve(repoGiven);

  if (action === undefined || action === "show") {
    const installation = store.listPhaseConfig(INSTALLATION_SCOPE);
    const project = scope === INSTALLATION_SCOPE ? [] : store.listPhaseConfig(scope);
    const resolved = (["plan", "build", "repair", "review"] as const).map(one => {
      const answer = resolvePhaseAgent(store, one, scope === INSTALLATION_SCOPE ? null : scope, {});
      return {
        phase: one,
        ...(answer.ok
          ? { provider: answer.spec.provider, model: answer.spec.model, source: answer.source }
          : { problem: answer.problem }),
      };
    });
    const fallback = scope === INSTALLATION_SCOPE ? [] : store.fallbackConfig(scope);
    // The STRONG tier (v47): the named strongest agent per phase, which
    // high-risk, strict, evidence-sensitive, and publication-sensitive
    // routes reach for. Never inferred — absent means "the default, said".
    const candidates = resolveRouteCandidates(store, scope === INSTALLATION_SCOPE ? null : scope);
    const strong = (["plan", "build", "repair", "review"] as const).map(one => ({
      phase: one,
      strong: candidates.ok ? candidates.candidates[one].strong : null,
    }));
    const alsoRows = [...store.listPhaseTierAlternates(INSTALLATION_SCOPE), ...(scope === INSTALLATION_SCOPE ? [] : store.listPhaseTierAlternates(scope))];
    // A light planner from before light became build-only is never used: said, with how to clear it.
    const unusedLight = [INSTALLATION_SCOPE, ...(scope === INSTALLATION_SCOPE ? [] : [scope])].filter(one => store.phaseTierConfig(one, "plan", "light") !== null);
    if (json) {
      write(envelopeJson({ ok: true, command: "config show", installation, project, resolved, fallback, strong, installationStrong: store.listPhaseTierConfig(INSTALLATION_SCOPE), projectStrong: scope === INSTALLATION_SCOPE ? [] : store.listPhaseTierConfig(scope), installationAlso: store.listPhaseTierAlternates(INSTALLATION_SCOPE), projectAlso: scope === INSTALLATION_SCOPE ? [] : store.listPhaseTierAlternates(scope) }));
      return EXIT.ok;
    }
    write(`Effective phase agents${scope === INSTALLATION_SCOPE ? "" : ` for ${scope}`}:`);
    for (const one of resolved) {
      if ("problem" in one) {
        write(`  ${one.phase.padEnd(8)} MISCONFIGURED — ${one.problem}`);
      } else {
        write(`  ${one.phase.padEnd(8)} ${one.provider}${one.model === null ? " (harness default model)" : ` · ${one.model}`}  [${one.source}]`);
      }
    }
    write("");
    write("  strong tier (high-risk, strict, screenshot-proof, and automerge routes reach for these):");
    for (const one of strong) {
      write(`  ${one.phase.padEnd(8)} ${one.strong === null ? "none configured — such routes keep the default above and say so" : `${one.strong.provider}${one.strong.model === null ? " (harness default model)" : ` · ${one.strong.model}`}  [${one.strong.source}]`}`);
    }
    write("  set one with: toolroll config set <phase> --tier strong --provider <p> --model <m> --as <you> --token <t>");
    write("");
    write("  light tier (small changes build on this, with no plan):");
    const light = candidates.ok ? candidates.candidates.build.light ?? null : null;
    write(`  ${"build".padEnd(8)} ${light === null ? "none configured — small changes keep the default above and say so" : `${light.provider} · ${light.model}  [${light.source}]`}`);
    for (const one of unusedLight) write(`  ${"plan".padEnd(8)} not used — a small change makes no plan; \`config clear plan --tier light${one === INSTALLATION_SCOPE ? "" : ` --repo ${one}`}\` removes it`);
    write("  set one with: toolroll config set build --tier light --provider <p> --model <m> --as <you> --token <t>");
    write("");
    if (candidates.ok) {
      const also = (["plan", "build"] as const).flatMap(one => Object.entries(candidates.candidates[one].alternates ?? {}).flatMap(([tier, list]) => (list ?? []).map(spec => `  ${one.padEnd(8)} ${tier.padEnd(8)} also ${spec.provider} · ${spec.model}  [${spec.source}]`)));
      if (also.length > 0 || alsoRows.length > 0) {
        write("  other providers on a tier (each task runs the one whose plan has more room):");
        for (const line of also) write(line);
        write("");
      }
    }
    write("  repair note: the repair PROVIDER always inherits the build it mends — only its model is configurable.");
    if (fallback.length > 0) {
      write("");
      write("  if the build agent's subscription runs out, NEW approvals bind this fallback chain:");
      fallback.forEach((one, i) => {
        write(`    ${i + 1}. ${one.provider} (${one.model}) — ${one.authMode === "subscription" ? "its subscription login" : "your API key"}`);
      });
      write("  it fires only when a signed mode allows the paid fallback (`mode set --allow-paid-fallback`).");
    }
    if (installation.length === 0 && project.length === 0) {
      write("  nothing configured — every phase runs the default (claude).");
      write("  toolroll config set build --provider claude --model sonnet --as <you> --token <t>");
    }
    return EXIT.ok;
  }

  if (action !== "set" && action !== "clear") {
    return fail(write, json, "config", "usage", "`toolroll config [show|set <phase> --provider <p> [--model <m>]|clear <phase>] [--repo <path>] --as <you> --token <t>`", EXIT.usage);
  }

  // Global dollar thresholds (v15, operator request): defaults for filings
  // and an installation-wide backstop. Authenticated like every spend
  // routing act; the per-task digest stays the authority.
  if (phase === "budgets") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `config ${action}`, "usage", "changing spend defaults takes `--as <you> --token <t>`", EXIT.usage);
    }
    const authedBudget = authenticateApprover(store, acting.name, acting.token);
    if (!authedBudget.ok) {
      return fail(write, json, `config ${action}`, "unauthenticated", "that is not an approver, or the token does not match", EXIT.refused);
    }
    if (action === "clear") {
      store.setSpendDefaults({ buildPerRunMicrousd: null, racePerAgentMicrousd: null, raceTotalMicrousd: null }, acting.name, clock());
      return succeed(write, json, "config clear", { budgets: null }, () => ["Spend defaults cleared — filings state their own numbers again."]);
    }
    const parseUsd = (flag: string): number | null | false => {
      const given = text(flags, flag);
      if (given === undefined) return null;
      const value = Number(given);
      return Number.isFinite(value) && value > 0 ? Math.round(value * 1_000_000) : false;
    };
    const build = parseUsd("build-usd");
    const racePer = parseUsd("race-per-usd");
    const raceTotal = parseUsd("race-total-usd");
    // Name the flag that was bad — "budgets are positive dollar amounts"
    // over four candidates left the caller diffing their own command line.
    const badFlag = build === false ? "--build-usd" : racePer === false ? "--race-per-usd" : raceTotal === false ? "--race-total-usd" : null;
    if (badFlag !== null || build === false || racePer === false || raceTotal === false) {
      return fail(write, json, "config set", "usage", `${badFlag ?? "--build-usd"} is a positive dollar amount`, EXIT.usage);
    }
    // The default competing-agent count (operator request): applied only
    // where a filing names one agent and no explicit count; a race digest
    // always binds the actual lineup.
    const agentsGiven = text(flags, "race-agents");
    const raceAgents = agentsGiven === undefined ? null : Number(agentsGiven);
    if (raceAgents !== null && (!Number.isInteger(raceAgents) || raceAgents < 2 || raceAgents > 4)) {
      return fail(write, json, "config set", "usage", "--race-agents is how many agents compete by default: a whole number from 2 to 4", EXIT.usage);
    }
    store.setSpendDefaults({ buildPerRunMicrousd: build, racePerAgentMicrousd: racePer, raceTotalMicrousd: raceTotal, raceAgents }, acting.name, clock());
    return succeed(write, json, "config set", { budgets: store.getSpendDefaults() }, () => [
      "Spend defaults set. New filings pre-fill from these; every approval still restates its own numbers:",
      ...(build === null ? [] : [`  each ordinary build attempt: $${(build / 1_000_000).toFixed(2)} (also the installation backstop)`]),
      ...(racePer === null ? [] : [`  each tournament agent: $${(racePer / 1_000_000).toFixed(2)}`]),
      ...(raceTotal === null ? [] : [`  each tournament total: $${(raceTotal / 1_000_000).toFixed(2)}`]),
      ...(raceAgents === null ? [] : [`  tournaments race ${raceAgents} agents unless a filing says otherwise`]),
    ]);
  }

  // The FALLBACK CHAIN (Layer F): the ordered entries a repository's NEW
  // approvals bind after the base agent. Per-repo only — a chain names
  // credentials for one project's work — and inert on its own: it only
  // ever fires when a signed mode also allows the paid fallback.
  if (phase === "fallback") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `config ${action}`, "usage", "configuring fallbacks takes `--as <you> --token <t>`", EXIT.usage);
    }
    const authedFallback = authenticateApprover(store, acting.name, acting.token);
    if (!authedFallback.ok) {
      return fail(write, json, `config ${action}`, "unauthenticated", "that is not an approver, or the token does not match", EXIT.refused);
    }
    if (scope === INSTALLATION_SCOPE) {
      return fail(write, json, `config ${action}`, "usage", "fallbacks are per repository — say --repo <path>", EXIT.usage);
    }
    if (action === "clear") {
      const had = store.clearFallbackConfig(scope);
      return succeed(write, json, "config clear", { repo: scope, fallback: null }, () => [
        had
          ? `${scope}: fallback chain cleared — new approvals bind the single configured agent again.`
          : `${scope}: no fallback chain was configured.`,
      ]);
    }
    const entriesGiven = text(flags, "entries");
    if (entriesGiven === undefined) {
      return fail(
        write, json, "config set", "usage",
        "`config set fallback --repo <path> --entries provider:model:auth-mode[,…]` — auth-mode is subscription or api-key; 1 to 3 entries",
        EXIT.usage,
      );
    }
    const entries: { provider: ProviderId; model: string; authMode: "subscription" | "api-key" }[] = [];
    for (const one of entriesGiven.split(",")) {
      // First and LAST colon split the three parts (F+G review, finding 1):
      // model ids legitimately carry colons (openrouter's ":free" suffixes),
      // so the model is everything between the provider and the auth mode.
      const trimmed = one.trim();
      const firstColon = trimmed.indexOf(":");
      const lastColon = trimmed.lastIndexOf(":");
      if (firstColon === -1 || lastColon === firstColon) {
        return fail(write, json, "config set", "usage", `"${trimmed}" is not provider:model:auth-mode`, EXIT.usage);
      }
      const provider = trimmed.slice(0, firstColon);
      const model = trimmed.slice(firstColon + 1, lastColon);
      const authMode = trimmed.slice(lastColon + 1);
      if (!isProviderId(provider)) {
        return fail(write, json, "config set", "usage", `unknown provider "${provider}" — one of ${PROVIDER_IDS.join(", ")}`, EXIT.usage);
      }
      if (authMode !== "subscription" && authMode !== "api-key") {
        return fail(write, json, "config set", "usage", `auth-mode is subscription or api-key, not "${authMode}"`, EXIT.usage);
      }
      if (authMode === "subscription" && !SUBSCRIPTION_CAPABLE[provider]) {
        return fail(write, json, "config set", "usage", `${provider} has no subscription login — this entry must use api-key`, EXIT.usage);
      }
      // The model rides provider argv: the SAME argv-safety validation every
      // other sealed model passes (never a leading dash or control bytes).
      const argvSafe = validateSpec({ provider, model: model === "" ? null : model });
      if (model === "" || !argvSafe.ok) {
        return fail(write, json, "config set", "usage", model === "" ? "each entry names an exact model — approvals bind exact routing" : argvSafe.ok ? "invalid entry" : argvSafe.problem, EXIT.usage);
      }
      entries.push({ provider, model, authMode });
    }
    if (entries.length < 1 || entries.length > 3) {
      return fail(write, json, "config set", "usage", "1 to 3 fallback entries (the approval binds the whole chain)", EXIT.usage);
    }
    // The WHOLE chain must file against the CURRENT base (F+G review,
    // finding 4): a fallback that duplicates the base — or another entry —
    // refuses NOW, in words, not at some future filing. Set, prove through
    // the same resolver filing uses, and restore the old config on refusal.
    const previous = store.fallbackConfig(scope);
    store.setFallbackConfig(scope, entries, acting.name, clock());
    const baseAgent = resolvePhaseAgent(store, "build", scope, {});
    if (baseAgent.ok) {
      const proven = resolveScopeChain(store, scope, undefined, {}, readAuthMode(baseAgent.spec.provider));
      // An UNRESOLVED base (no explicit routing configured yet) cannot be
      // duplicate-checked — the filing-time resolver holds that line; only
      // a chain that provably cannot file refuses here.
      if (!proven.ok && proven.reason !== "base-unresolved") {
        if (previous.length > 0) store.setFallbackConfig(scope, previous, acting.name, clock());
        else store.clearFallbackConfig(scope);
        return fail(write, json, "config set", "usage", `this chain cannot file: ${proven.problem}`, EXIT.usage);
      }
    }
    return succeed(write, json, "config set", { repo: scope, fallback: entries }, () => [
      `${scope}: fallback chain set — NEW approvals bind it; existing approvals are untouched.`,
      ...entries.map((one, i) => `  ${i + 1}. ${one.provider} (${one.model}) — ${one.authMode === "subscription" ? "its subscription login" : "your API key"}`),
      "  it fires only when a signed mode allows the paid fallback: `toolroll mode set --allow-paid-fallback …`",
    ]);
  }

  // Chat is its OWN configuration, deliberately not a phase (Codex v3
  // review, change 1): a shared table would admit build+anthropic-api.
  // Installation-scoped only — a per-repo chat would splinter the spend
  // ceiling that makes the ledger a ceiling at all.
  if (phase === "chat") {
    if (repoGiven !== undefined) {
      return fail(write, json, `config ${action}`, "usage", "chat is installation-scoped — no --repo", EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `config ${action}`, "usage", "changing chat spend takes `--as <you> --token <t>`", EXIT.usage);
    }
    const authedChat = authenticateApprover(store, acting.name, acting.token);
    if (!authedChat.ok) {
      return fail(write, json, `config ${action}`, "unauthenticated", "that is not an approver, or the token does not match", EXIT.refused);
    }
    if (action === "clear") {
      store.clearChatConfig();
      return succeed(write, json, "config clear", { chat: null }, () => ["Chat is off — the config row is gone."]);
    }
    const provider = text(flags, "provider");
    const requestedModel = text(flags, "model");
    const weeklyUsd = text(flags, "weekly-usd");
    const dailyGiven = text(flags, "daily-turns");
    if (provider !== "anthropic-api" && provider !== "openrouter-api" && provider !== "claude-subscription" && provider !== "codex-subscription") {
      return fail(write, json, "config set", "usage", "chat provider is one of claude-subscription, codex-subscription, anthropic-api, openrouter-api", EXIT.usage);
    }
    const model = requestedModel ?? (isSubscriptionChatProvider(provider) ? "default" : "");
    if (!validModelId(model)) {
      return fail(write, json, "config set", "usage", "--model must be 1–128 letters, digits, dots, slashes, colons, underscores, or dashes", EXIT.usage);
    }
    const priced = isDirectChatProvider(provider) ? livePin(store, provider, model) ?? priceOf(model) : null;
    if (isDirectChatProvider(provider) && priced === null) {
      return fail(write, json, "config set", "unpriced-model", `chat reserves worst-case spend up front, so the model needs a price — run "toolroll models check" to load live prices, or pick one priced today: ${PRICED_MODELS.join(", ")}`, EXIT.refused);
    }
    const weekly = Number(weeklyUsd);
    if (isDirectChatProvider(provider) && (weeklyUsd === undefined || !Number.isFinite(weekly) || weekly <= 0)) {
      return fail(write, json, "config set", "usage", "--weekly-usd <dollars> is required — chat without a ceiling is not configured, it is unbounded", EXIT.usage);
    }
    const daily = dailyGiven === undefined ? 50 : Number(dailyGiven);
    if (!Number.isInteger(daily) || daily <= 0 || daily > 1_000) {
      return fail(write, json, "config set", "usage", "--daily-turns is a whole number between 1 and 1000", EXIT.usage);
    }
    // The CLI pins from the compiled table (the console additionally offers
    // OpenRouter's live catalog — priced by the party that bills it).
    const pinned = isDirectChatProvider(provider) ? priced : { inMicrousd: 0, outMicrousd: 0 };
    if (pinned === null) {
      return fail(write, json, "config set", "unpriced-model", `no compiled price for ${model}`, EXIT.refused);
    }
    store.setChatConfig(
      {
        provider,
        model,
        dailyTurns: daily,
        weeklyCeilingMicrousd: isDirectChatProvider(provider) ? Math.round(weekly * 1_000_000) : 0,
        priceInMicrousd: pinned.inMicrousd,
        priceOutMicrousd: pinned.outMicrousd,
      },
      acting.name,
      clock(),
    );
    return succeed(write, json, "config set", { chat: store.getChatConfig() }, () => [
      isDirectChatProvider(provider)
        ? `Chat answers with ${provider} · ${model}, at most ${daily} turns/day, at most $${weekly.toFixed(2)} per rolling week.`
        : `Chat answers through the logged-in ${provider === "codex-subscription" ? "Codex" : "Claude"} harness${model === "default" ? " using its default model" : ` · ${model}`}, at most ${daily} turns/day, with no dollar ceiling.`,
      isDirectChatProvider(provider)
        ? `The key rides the serve environment (${provider === "anthropic-api" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY"}) — never this database.`
        : `The harness reuses its cached membership login; authenticate first with ${provider === "codex-subscription" ? "`codex login`" : "the `claude` CLI"}.`,
      ...(isSubscriptionChatProvider(provider) && weeklyUsd !== undefined
        ? ["The supplied --weekly-usd value was ignored because membership usage has no dollar meter."]
        : []),
    ]);
  }

  if (phase === undefined || !["plan", "build", "repair", "review"].includes(phase)) {
    return fail(write, json, `config ${action}`, "usage", "which phase? plan, build, repair, review — or chat", EXIT.usage);
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, `config ${action}`, "usage", "changing spend routing takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, `config ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, phase), EXIT.refused);
  }

  // The STRONG tier (v47): a second, named row per phase the routing policy
  // reaches for when risk, quality, evidence, or publication demand it.
  // Authenticated and audited exactly like the routine row; existing
  // approvals are untouched — a sealed route never re-resolves.
  // The LIGHT tier (v2): the fast agent a small change builds on.
  const tierGiven = text(flags, "tier");
  if (tierGiven !== undefined && tierGiven !== "strong" && tierGiven !== "light") {
    return fail(write, json, `config ${action}`, "usage", "--tier is `light` or `strong` — the routine tier is the plain phase row", EXIT.usage);
  }
  // A light planner would never run (a small change makes no plan): refused rather than kept and ignored.
  // Clearing one left from before stays possible.
  if (tierGiven === "light" && phase !== "build" && !(action === "clear" && phase === "plan" && !flag(flags, "also"))) {
    return fail(write, json, `config ${action}`, "usage", "--tier light is for build only — a small change makes no plan, and repairs resume the builder's session", EXIT.usage);
  }

  // Another provider's candidate on the same tier (`--also`): one per provider, and at filing the one whose plan
  // has more room runs.
  if (flag(flags, "also")) {
    if (phase !== "plan" && phase !== "build") {
      return fail(write, json, `config ${action}`, "usage", "--also is for plan or build — repairs follow the build's provider", EXIT.usage);
    }
    const tier = (tierGiven ?? "routine") as "light" | "routine" | "strong";
    const alsoProvider = text(flags, "provider");
    if (alsoProvider !== undefined && !isProviderId(alsoProvider)) {
      return fail(write, json, `config ${action}`, "usage", `--provider is one of ${PROVIDER_IDS.join(", ")}`, EXIT.usage);
    }
    if (action === "clear") {
      const removed = store.clearPhaseTierAlternates(scope, phase, tier, alsoProvider ?? null);
      return succeed(write, json, "config clear", { scope, phase, tier, also: true, provider: alsoProvider ?? null, cleared: removed }, () => [
        removed > 0 ? `Removed ${removed} other-provider ${tier} ${phase} agent${removed === 1 ? "" : "s"} at ${scope}; sealed routes are untouched.` : `No other-provider ${tier} ${phase} agent${alsoProvider === undefined ? "" : ` on ${alsoProvider}`} was configured at ${scope}.`,
      ]);
    }
    const alsoModel = text(flags, "model");
    if (alsoProvider === undefined || alsoModel === undefined) {
      return fail(write, json, "config set", "usage", "--also names an exact --provider and --model — approvals bind exact routing", EXIT.usage);
    }
    const alsoValid = validateSpec({ provider: alsoProvider, model: alsoModel });
    if (!alsoValid.ok) return fail(write, json, "config set", "invalid", alsoValid.problem, EXIT.usage);
    store.setPhaseTierAlternate(scope, phase, tier, alsoProvider, alsoModel, acting.name, clock());
    const resolvedNow = resolveRouteCandidates(store, scope === INSTALLATION_SCOPE ? null : scope);
    const own = !resolvedNow.ok ? null : tier === "routine" ? resolvedNow.candidates[phase].routine : tier === "light" ? resolvedNow.candidates[phase].light ?? null : resolvedNow.candidates[phase].strong;
    return succeed(write, json, "config set", { scope, phase, tier, also: true, provider: alsoProvider, model: alsoModel }, () => [
      `${tier} ${phase} at ${scope === INSTALLATION_SCOPE ? "the installation" : scope} can also run ${alsoProvider} · ${alsoModel}, set by ${acting.name}.`,
      own !== null && own.provider === alsoProvider && !own.source.includes("also")
        ? `  ! the ${tier} ${phase} agent already runs ${alsoProvider} (${own.model}) — this one is not used while it does.`
        : "  tasks filed from now on run on whichever provider's plan has more room; sealed routes are untouched.",
    ]);
  }

  if (action === "clear") {
    if (tierGiven === "light") {
      const clearedLight = store.clearPhaseTierConfig(scope, phase, "light");
      return succeed(write, json, "config clear", { scope, phase, tier: "light", cleared: clearedLight }, () => [
        clearedLight ? `Cleared the light ${phase} agent at ${scope} — small changes keep the default and say so; sealed routes are untouched.` : `No light ${phase} agent was configured at ${scope}.`,
      ]);
    }
    if (tierGiven === "strong") {
      const clearedStrong = store.clearPhaseTierConfig(scope, phase, "strong");
      return succeed(write, json, "config clear", { scope, phase, tier: "strong", cleared: clearedStrong }, () => [
        clearedStrong ? `Cleared the strong ${phase} agent at ${scope} — demanding routes keep the default and say so; sealed routes are untouched.` : `No strong ${phase} agent was configured at ${scope}.`,
      ]);
    }
    const cleared = store.clearPhaseConfig(scope, phase);
    return succeed(write, json, "config clear", { scope, phase, cleared }, () => [
      cleared ? `Cleared ${phase} at ${scope} — it resolves one layer down now.` : `Nothing was configured for ${phase} at ${scope}.`,
    ]);
  }

  const providerGiven = text(flags, "provider");
  if (providerGiven === undefined || !isProviderId(providerGiven)) {
    return fail(write, json, "config set", "usage", `--provider is one of ${PROVIDER_IDS.join(", ")}`, EXIT.usage);
  }
  const modelGiven = text(flags, "model") ?? null;
  const valid = validateSpec({ provider: providerGiven, model: modelGiven });
  if (!valid.ok) {
    return fail(write, json, "config set", "invalid", valid.problem, EXIT.usage);
  }
  if (tierGiven === "light") {
    if (modelGiven === null) {
      return fail(write, json, "config set", "usage", `a light ${phase} agent names an exact --model — approvals bind exact routing`, EXIT.usage);
    }
    store.setPhaseTierConfig(scope, phase, "light", providerGiven, modelGiven, acting.name, clock());
    return succeed(write, json, "config set", { scope, phase, tier: "light", provider: providerGiven, model: modelGiven }, () => [
      `light ${phase} at ${scope === INSTALLATION_SCOPE ? "the installation" : scope} is ${providerGiven} · ${modelGiven}, set by ${acting.name}.`,
      "  small changes filed from now on build on it with no plan; sealed routes are untouched.",
    ]);
  }
  if (tierGiven === "strong") {
    if (phase === "review" && providerGiven === "gemini") {
      return fail(write, json, "config set", "invalid", "gemini has no isolation posture for the review phase yet — name claude or codex as the strong reviewer", EXIT.usage);
    }
    if (modelGiven === null) {
      return fail(write, json, "config set", "usage", `a strong ${phase} agent names an exact --model — approvals bind exact routing`, EXIT.usage);
    }
    store.setPhaseTierConfig(scope, phase, "strong", providerGiven, modelGiven, acting.name, clock());
    return succeed(write, json, "config set", { scope, phase, tier: "strong", provider: providerGiven, model: modelGiven }, () => [
      `strong ${phase} at ${scope === INSTALLATION_SCOPE ? "the installation" : scope} is ${providerGiven}${modelGiven === null ? "" : ` · ${modelGiven}`}, set by ${acting.name}.`,
      "  high-risk, strict, screenshot-proof, and automerge routes filed from now on reach for it; sealed routes are untouched.",
      ...(phase === "repair" ? ["  a strong repair agent applies only when its provider is the build's — cross-provider repair does not exist."] : []),
    ]);
  }
  store.setPhaseConfig(scope, phase, providerGiven, modelGiven, acting.name, clock());
  const warnings: string[] = [];
  if (modelGiven === null) {
    warnings.push(`no --model named: approvals bind exact routing, so scopes cannot file until ${phase} has an exact model — \`config set ${phase} --provider ${providerGiven} --model <model>\``);
  }
  if (providerGiven === "openrouter" && (process.env["OPENROUTER_API_KEY"] ?? "") === "") {
    warnings.push("OPENROUTER_API_KEY is not present in this environment — runs will fail until the runner exports it.");
  }
  if (providerGiven !== "claude") {
    warnings.push(`${providerGiven} does not report dollar cost: its runs land as UNMEASURED, and any routine with a cost ceiling fails closed on them by design.`);
  }
  return succeed(write, json, "config set", { scope, phase, provider: providerGiven, model: modelGiven, warnings }, () => [
    `${phase} at ${scope === INSTALLATION_SCOPE ? "the installation" : scope} now runs ${providerGiven}${modelGiven === null ? "" : ` · ${modelGiven}`}, set by ${acting.name}.`,
    ...warnings.map(one => `  ! ${one}`),
  ]);
}

/**
 * `toolroll setup …` — the per-repo worktree setup (M5.7). What a
 * fresh checkout runs before any agent spawns in it: dependencies, .env
 * copies, generated code. Approval is authority (an approved command runs
 * unattended in every future worktree), so `set` and `clear` take the
 * approver's credential and `set` restates the exact terms — command,
 * timeout, digest — before `--yes` lands them. The command TEXT is stored;
 * secret values never are.
 */
async function setupCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const clock = context.clock ?? (() => new Date());
  const action = positional[0] ?? "show";
  const repo = text(flags, "repo");

  if (action === "show") {
    if (repo === undefined) {
      return fail(write, json, "setup show", "usage", "which repo? --repo <path>", EXIT.usage);
    }
    const live = store.liveWorktreeSetup(repo);
    if (json) {
      write(envelopeJson({ ok: true, command: "setup show", repo, setup: live }));
      return EXIT.ok;
    }
    write(
      live === null
        ? `No worktree setup for ${repo}. Fresh checkouts run nothing before the agent.`
        : `${repo} runs before every agent:\n  ${live.command}\n  timeout ${Math.round(live.timeoutMs / 1000)}s · digest ${live.digest} · approved by ${live.approvedBy} at ${live.approvedAt}`,
    );
    return EXIT.ok;
  }

  if (action !== "set" && action !== "clear") {
    return fail(write, json, "setup", "usage", "`toolroll setup [show|set --command <cmd> [--timeout-seconds <n>] --yes|clear] --repo <path> --as <you> --token <t>`", EXIT.usage);
  }
  if (repo === undefined) {
    return fail(write, json, `setup ${action}`, "usage", "which repo? --repo <path>", EXIT.usage);
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, `setup ${action}`, "usage", "an approved setup runs unattended in every future worktree — changing it takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, `setup ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, repo), EXIT.refused);
  }

  if (action === "clear") {
    const cleared = store.clearWorktreeSetup(repo, acting.name, clock());
    return succeed(write, json, "setup clear", { repo, cleared }, () => [
      cleared ? `Cleared — fresh checkouts of ${repo} run nothing now.` : `Nothing was set for ${repo}.`,
    ]);
  }

  const command = text(flags, "command");
  if (command === undefined || command.trim() === "") {
    return fail(write, json, "setup set", "usage", "--command <cmd> is what every fresh checkout will run", EXIT.usage);
  }
  if (command.length > 2000 || hasDisguisedText(command)) {
    return fail(write, json, "setup set", "invalid", "the command must be under 2000 characters with no control or bidi characters", EXIT.usage);
  }
  // Literal credentials never become standing rows (audit IV-5): a command
  // that embeds a token is stored forever in plain text. Reference an
  // environment variable the runner already exports instead. `$TOKEN` is
  // a reference and passes; `=secret123` is a value and refuses.
  const credentialShaped =
    /([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api_key|authorization|bearer|credential)[A-Za-z0-9_-]*\s*[=:]\s*)(?![$"']?\$)\S+/i.test(command) ||
    /\/\/[^\s/@]+:[^\s/@]+@/.test(command);
  if (credentialShaped) {
    return fail(write, json, "setup set", "credential-shaped", "the command appears to embed a credential — reference an environment variable the runner exports (e.g. $NPM_TOKEN) instead of a literal value", EXIT.usage);
  }
  const timeoutSeconds = Number(text(flags, "timeout-seconds") ?? "300");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    return fail(write, json, "setup set", "invalid", "--timeout-seconds is 1..3600", EXIT.usage);
  }

  if (flags.get("yes") !== true) {
    if (json) {
      write(envelopeJson({ ok: false, command: "setup set", reason: "unconfirmed", repo, setupCommand: command, timeoutSeconds }));
      return EXIT.refused;
    }
    for (const line of [
      `The terms, exactly:`,
      `  repo     ${repo}`,
      `  command  ${command}`,
      `  timeout  ${timeoutSeconds}s`,
      ``,
      `Every FUTURE worktree of this repo runs this command unattended,`,
      `before any agent spawns in it, under an ALLOWLISTED environment`,
      `(PATH, HOME, locale, temp — no credentials). A failed setup blocks`,
      `the build as an environment problem. Re-run with --yes to approve.`,
    ]) {
      write(line);
    }
    return EXIT.refused;
  }

  const saved = store.setWorktreeSetup(
    { repo, command, timeoutMs: timeoutSeconds * 1000, approvedBy: acting.name },
    clock(),
  );
  return succeed(write, json, "setup set", { repo, digest: saved.digest, timeoutSeconds }, () => [
    `Approved: fresh checkouts of ${repo} run \`${command}\` (digest ${saved.digest}, ${timeoutSeconds}s) before any agent.`,
  ]);
}

/**
 * `toolroll verify [show|set|clear]` (Priority 2): the ONE shell
 * command the plane re-runs, unattended, in a leased worktree after a
 * build commits — cloned from `setupCommand` line for line, because
 * approving this is the same authority under a different name: a
 * credential, restated terms, a digest, `--yes`. Setup prepares a fresh
 * checkout; this checks a finished one.
 */
async function verifyCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const clock = context.clock ?? (() => new Date());
  const action = positional[0] ?? "show";
  const repo = text(flags, "repo");

  if (action === "show") {
    if (repo === undefined) {
      return fail(write, json, "verify show", "usage", "which repo? --repo <path>", EXIT.usage);
    }
    const live = store.liveVerifyCommand(repo);
    const quick = liveQuickCommand(store, repo);
    const level = projectCheckLevel(store, repo);
    const suggestion = quick === null ? suggestQuickCommand(repo) : null;
    if (json) {
      write(envelopeJson({ ok: true, command: "verify show", repo, verify: live, quick, level: level.level, ...(suggestion === null ? {} : { suggestedQuick: suggestion }) }));
      return EXIT.ok;
    }
    write(
      live === null
        ? `No verification command for ${repo}. A build's proof lands "attested" at best — nothing re-runs it.`
        : `${repo} re-runs after every commit:\n  ${live.command}\n  timeout ${Math.round(live.timeoutMs / 1000)}s · digest ${live.digest} · approved by ${live.approvedBy} at ${live.approvedAt}${live.recoverySetupDigest === null ? "" : `\n  self-healing on · approved setup ${live.recoverySetupDigest}`}`,
    );
    write(`Check level: ${CHECK_LEVEL_WORDS[level.level]}${level.setBy === null ? " (not set; projects from before levels keep the full check)" : ` · set by ${level.setBy}`}`);
    if (quick !== null) write(`Quick check:\n  ${quick.command}\n  timeout ${Math.round(quick.timeoutMs / 1000)}s · digest ${quick.digest} · approved by ${quick.approvedBy}`);
    else if (level.level === "quick") write(`No quick command yet, so Quick runs the full check.${suggestion === null ? "" : ` Suggested from the project's scripts:\n  toolroll verify set --repo ${repo} --quick "${suggestion}"`}`);
    return EXIT.ok;
  }

  // An approver's act: the project's check level. The ledger keeps before → after.
  if (action === "level") {
    if (repo === undefined) return fail(write, json, "verify level", "usage", "which repo? --repo <path>", EXIT.usage);
    const wanted = positional[1];
    if (!isCheckLevel(wanted)) return fail(write, json, "verify level", "usage", "`toolroll verify level quick|full|off --repo <path> --as <you> --token <t>`", EXIT.usage);
    const acting = await askCredentials(flags, context);
    if (acting === null) return fail(write, json, "verify level", "usage", "changing a project's checks takes `--as <you> --token <t>`", EXIT.usage);
    const authenticated = authenticateApprover(store, acting.name, acting.token, repo);
    if (!authenticated.ok) return fail(write, json, "verify level", authenticated.reason, describeApproveFailure(authenticated.reason, repo), EXIT.refused);
    const changed = setProjectCheckLevel(store, repo, wanted, acting.name, clock());
    const runsFull = wanted === "quick" && liveQuickCommand(store, repo) === null;
    return succeed(write, json, "verify level", { repo, level: wanted, before: changed.before, changed: changed.changed }, () => [
      `${repo}: checks are ${CHECK_LEVEL_WORDS[wanted]}${changed.changed ? ` (was ${CHECK_LEVEL_WORDS[changed.before]})` : ""}. ${CHECK_LEVEL_HINTS[wanted]}`,
      ...(runsFull ? [`No quick command is approved yet, so builds run the full check. Approve one with \`toolroll verify set --repo ${repo} --quick "<cmd>"\`.`] : []),
      ...(wanted !== "full" ? ["The full check still runs when a pull request opens, and Merge waits for it unless a person merges anyway."] : []),
    ]);
  }

  if (action !== "set" && action !== "clear") {
    return fail(write, json, "verify", "usage", "`toolroll verify [show|level quick|full|off|set --command <cmd>|--quick <cmd> [--timeout-seconds <n>] [--self-heal --setup-digest <shown>] --yes|clear [--level quick]] --repo <path> --as <you> --token <t>`", EXIT.usage);
  }
  // The quick command is its own approved grant beside the full one.
  const quickValue = text(flags, "quick");
  const quickClear = action === "clear" && text(flags, "level") === "quick";
  const grantKey = repo === undefined ? undefined : quickValue !== undefined || quickClear ? quickVerifyKey(repo) : repo;
  if (repo === undefined) {
    return fail(write, json, `verify ${action}`, "usage", "which repo? --repo <path>", EXIT.usage);
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, `verify ${action}`, "usage", "an approved verification command runs unattended after every future build — changing it takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, `verify ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, repo), EXIT.refused);
  }

  if (action === "clear") {
    const cleared = store.clearVerifyCommand(grantKey!, acting.name, clock());
    if (quickClear) return succeed(write, json, "verify clear", { repo, cleared, level: "quick" }, () => [
      cleared ? `Cleared the quick command — Quick builds of ${repo} run the full check now.` : `No quick command was set for ${repo}.`,
    ]);
    return succeed(write, json, "verify clear", { repo, cleared }, () => [
      cleared ? `Cleared — builds of ${repo} land "attested" at best now; nothing re-runs.` : `Nothing was set for ${repo}.`,
    ]);
  }

  const command = quickValue ?? text(flags, "command");
  if (quickValue !== undefined && text(flags, "command") !== undefined) {
    return fail(write, json, "verify set", "usage", "give the quick command with --quick \"<cmd>\" or the full one with --command, not both", EXIT.usage);
  }
  if (quickValue !== undefined && flags.get("self-heal") === true) {
    return fail(write, json, "verify set", "usage", "--self-heal applies to the full command only", EXIT.usage);
  }
  if (command === undefined || command.trim() === "") {
    return fail(write, json, "verify set", "usage", "--command <cmd> is what the plane re-runs after every commit", EXIT.usage);
  }
  if (command.length > 2000 || hasDisguisedText(command)) {
    return fail(write, json, "verify set", "invalid", "the command must be under 2000 characters with no control or bidi characters", EXIT.usage);
  }
  // Same rule as an approved setup command (audit IV-5): a command that
  // embeds a literal credential is stored forever in plain text.
  const credentialShaped =
    /([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api_key|authorization|bearer|credential)[A-Za-z0-9_-]*\s*[=:]\s*)(?![$"']?\$)\S+/i.test(command) ||
    /\/\/[^\s/@]+:[^\s/@]+@/.test(command);
  if (credentialShaped) {
    return fail(write, json, "verify set", "credential-shaped", "the command appears to embed a credential — reference an environment variable the runner exports (e.g. $NPM_TOKEN) instead of a literal value", EXIT.usage);
  }
  const timeoutSeconds = Number(text(flags, "timeout-seconds") ?? "300");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    return fail(write, json, "verify set", "invalid", "--timeout-seconds is 1..3600", EXIT.usage);
  }
  const selfHeal = flags.get("self-heal") === true;
  const expectedSetupDigest = text(flags, "setup-digest");
  if (!selfHeal && expectedSetupDigest !== undefined) {
    return fail(write, json, "verify set", "usage", "--setup-digest is only valid with --self-heal", EXIT.usage);
  }
  const recoverySetup = selfHeal ? store.liveWorktreeSetup(repo) : null;
  if (selfHeal && recoverySetup === null) {
    return fail(
      write,
      json,
      "verify set",
      "setup-required",
      "self-healing needs an approved project setup first — set the exact preparation command, then approve verification again with --self-heal",
      EXIT.refused,
    );
  }

  if (flags.get("yes") !== true) {
    if (json) {
      write(envelopeJson({
        ok: false,
        command: "verify set",
        reason: "unconfirmed",
        repo,
        ...(quickValue === undefined ? {} : { level: "quick" }),
        verifyCommand: command,
        timeoutSeconds,
        selfHeal,
        recoverySetup: recoverySetup === null ? null : { command: recoverySetup.command, digest: recoverySetup.digest },
      }));
      return EXIT.refused;
    }
    for (const line of [
      `The terms, exactly:`,
      `  repo     ${repo}`,
      `  command  ${command}`,
      `  timeout  ${timeoutSeconds}s`,
      ``,
      quickValue === undefined ? `Every FUTURE build of this repo re-runs this command unattended,` : `Every FUTURE Quick build of this repo runs this command unattended,`,
      `once, right after it commits — under an ALLOWLISTED environment`,
      `(PATH, HOME, locale, temp — no credentials). A pass lands the`,
      `build "verified"; a failure lands it "refuted", never blocked.`,
      ...(recoverySetup === null
        ? []
        : [
            ``,
            `Self-healing, exactly: if this check cannot start because a`,
            `required project executable is unavailable, Toolroll may replay`,
            `the approved setup \`${recoverySetup.command}\` (digest ${recoverySetup.digest}) once,`,
            `then retry this exact check once. It stops if custody changes,`,
            `setup fails, or setup changes tracked files after the commit.`,
          ]),
      recoverySetup === null
        ? `Re-run with --yes to approve.`
        : `Re-run with --setup-digest ${recoverySetup.digest} --yes to approve.`,
    ]) {
      write(line);
    }
    return EXIT.refused;
  }

  if (selfHeal && expectedSetupDigest === undefined) {
    return fail(
      write,
      json,
      "verify set",
      "setup-digest-required",
      `confirm self-healing with --setup-digest ${recoverySetup?.digest} exactly as previewed`,
      EXIT.refused,
    );
  }
  if (selfHeal && expectedSetupDigest !== recoverySetup?.digest) {
    return fail(
      write,
      json,
      "verify set",
      "stale-approval",
      `the approved setup changed after preview — expected ${expectedSetupDigest}, current ${recoverySetup?.digest}; preview verification again before approving`,
      EXIT.refused,
    );
  }

  const saved = store.setVerifyCommand(
    {
      repo: grantKey!,
      command,
      timeoutMs: timeoutSeconds * 1000,
      approvedBy: acting.name,
      recoverySetupDigest: recoverySetup?.digest ?? null,
    },
    clock(),
  );
  if (quickValue !== undefined) {
    return succeed(write, json, "verify set", { repo, level: "quick", digest: saved.digest, timeoutSeconds }, () => [
      `Approved the quick check: Quick builds of ${repo} run \`${command}\` (digest ${saved.digest}, ${timeoutSeconds}s) right after commit.`,
    ]);
  }
  return succeed(write, json, "verify set", { repo, digest: saved.digest, timeoutSeconds, selfHeal }, () => [
    `Approved: builds of ${repo} re-run \`${command}\` (digest ${saved.digest}, ${timeoutSeconds}s) right after commit${selfHeal ? "; a missing required project executable gets one bounded approved-setup recovery" : ""}.`,
  ]);
}

const GITHUB_REPO_SHAPE = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;
const LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:_. -]{0,49}$/;

/** `ghi-owner-name-123` — deterministic, so existence IS the dedupe. */
function intakeTaskId(github: string, issueNumber: number): string {
  // The suffix IS the identity; the slug gives way to it (audit C-7) —
  // truncating the issue number off a long owner/repo would silently map
  // distinct issues onto one task id.
  const suffix = `-${issueNumber}`;
  const slug = github.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `ghi-${slug}`.slice(0, 64 - suffix.length) + suffix;
}

/**
 * `toolroll intake …` (M8.16) — labeled GitHub issues become LOCAL
 * UNAPPROVED task proposals, preview-first, under an explicit grant.
 *
 * Detection is not authorization: enrolling a repo with four hundred open
 * issues is not volunteering them, so the grant names the exact repository
 * AND the exact label, and its terms are restated before --yes. The run
 * pass mutates nothing remote — reads make proposals, people approve them,
 * and external-backend dispatch remains unshipped and says so. Issue
 * titles are untrusted text: control/bidi characters refuse the candidate
 * rather than importing a disguise, and the issue BODY is never imported
 * at all — the proposal links to GitHub where a person reads it.
 */
async function intakeCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const clock = context.clock ?? (() => new Date());
  const gh = context.gitRunner ?? run;
  const action = positional[0] ?? "show";
  const repo = repoFrom(flags);

  if (action === "pr-comments" || action === "preview" || action === "run") {
    // Reads too: a demo sandbox makes no gh call at all (finding 8).
    const demoFence = refuseDemo(context, `intake ${action}`);
    if (demoFence !== null) return demoFence;
  }

  if (action === "show") {
    const grant = store.liveIntakeGrant(repo);
    if (json) {
      write(envelopeJson({ ok: true, command: "intake show", repo, grant }));
      return EXIT.ok;
    }
    write(
      grant === null
        ? `No intake grant for ${repo}. Nothing on GitHub becomes a proposal here.`
        : `${repo} intakes GitHub issues from ${grant.github} labeled "${grant.label}"${grant.reviewers === null ? "" : `; PR comments from: ${grant.reviewers.join(", ")}`} — granted by ${grant.approvedBy} at ${grant.approvedAt}.`,
    );
    return EXIT.ok;
  }

  if (action === "grant" || action === "clear") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `intake ${action}`, "usage", "an intake grant is standing authority — it takes `--as <you> --token <t>`", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, `intake ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, repo), EXIT.refused);
    }
    if (action === "clear") {
      const cleared = store.clearIntakeGrant(repo, acting.name, clock());
      return succeed(write, json, "intake clear", { repo, cleared }, () => [
        cleared ? `Revoked — nothing on GitHub becomes a proposal for ${repo} now.` : `Nothing was granted for ${repo}.`,
      ]);
    }
    const github = text(flags, "github");
    const label = text(flags, "label");
    if (github === undefined || !GITHUB_REPO_SHAPE.test(github)) {
      return fail(write, json, "intake grant", "usage", "--github <owner/name> names the repository on GitHub", EXIT.usage);
    }
    if (label === undefined || !LABEL_SHAPE.test(label)) {
      return fail(write, json, "intake grant", "usage", "--label <label> names the exact label that nominates an issue", EXIT.usage);
    }
    const reviewersRaw = text(flags, "reviewers");
    const reviewers =
      reviewersRaw === undefined
        ? null
        : reviewersRaw.split(",").map(one => one.trim()).filter(one => /^[A-Za-z0-9-]{1,39}$/.test(one));
    if (flags.get("yes") !== true) {
      if (json) {
        write(envelopeJson({ ok: false, command: "intake grant", reason: "unconfirmed", repo, github, label, reviewers }));
        return EXIT.refused;
      }
      for (const line of [
        `The terms, exactly:`,
        `  local repo   ${repo}`,
        `  github       ${github}`,
        `  label        ${label}`,
        `  pr comments  ${reviewers === null || reviewers.length === 0 ? "nobody's — PR-comment intake stays off" : `from ${reviewers.join(", ")} only`}`,
        ``,
        `Open issues carrying exactly this label become LOCAL, UNAPPROVED task`,
        `proposals when \`toolroll intake run\` passes. Nothing builds`,
        `without a scope you approve; nothing on GitHub is ever written to.`,
        `Re-run with --yes to grant.`,
      ]) {
        write(line);
      }
      return EXIT.refused;
    }
    const granted = store.setIntakeGrant({ repo, github, label, reviewers, approvedBy: acting.name }, clock());
    return succeed(write, json, "intake grant", { repo, github, label, reviewers: granted.reviewers }, () => [
      `Granted: issues in ${github} labeled "${label}" become unapproved proposals for ${repo}.`,
    ]);
  }

  if (action !== "preview" && action !== "run" && action !== "pr-comments") {
    return fail(write, json, "intake", "usage", "`toolroll intake [show|grant|clear|preview|run|pr-comments] --repo <path> …`", EXIT.usage);
  }

  const grant = store.liveIntakeGrant(repo);
  if (grant === null) {
    return fail(write, json, `intake ${action}`, "no-grant", `no intake grant for ${repo} — \`toolroll intake grant\` states the terms`, EXIT.refused);
  }

  if (action === "pr-comments") {
    // PR review comments become LOCAL diff comments (M8.17): own PRs only
    // (the publication table IS the list of ours), named reviewers only,
    // the GitHub comment id the idempotency key, every body through the
    // shared validator. Nothing here authorizes a spawn — ingested
    // comments wait on the run page for the same one-tap seal and the
    // same scope approval as comments typed in the console.
    if (grant.reviewers === null || grant.reviewers.length === 0) {
      return fail(write, json, "intake pr-comments", "no-reviewers", "the grant names no reviewers — `intake grant --reviewers <logins>` is the authority for this", EXIT.refused);
    }
    const publications = store
      .openedPublications()
      .filter(
        one =>
          one.prNumber !== null &&
          store.refForId(one.taskRef)?.repo === repo &&
          // The grant names ONE GitHub repository; a publication opened
          // against another must not have that repo's PR numbers fetched
          // onto its runs (audit C-5).
          one.githubRepo === grant.github,
      );
    let ingested = 0;
    let duplicates = 0;
    let refused = 0;
    const skippedPrs: { pr: number; reason: string }[] = [];
    for (const publication of publications) {
      const pr = publication.prNumber as number;
      const terminal = store.artifactsFor(publication.run).find(one => one.kind === "terminal-diff");
      if (terminal === undefined) {
        skippedPrs.push({ pr, reason: "no terminal diff to bind comments to" });
        continue;
      }
      const proven = readVerifiedArtifact(context.evidenceRoot, terminal);
      if (!proven.ok) {
        skippedPrs.push({ pr, reason: `the terminal diff no longer verifies — ${proven.problem}` });
        continue;
      }
      const asked = await gh("gh", ["api", "--paginate", `repos/${grant.github}/pulls/${pr}/comments`], { timeoutMs: 60_000 });
      if (asked.code !== 0) {
        skippedPrs.push({ pr, reason: "github unreachable" });
        continue;
      }
      let remote: { id?: unknown; user?: { login?: unknown }; path?: unknown; line?: unknown; original_line?: unknown; body?: unknown }[];
      try {
        remote = JSON.parse(asked.stdout) as typeof remote;
      } catch {
        skippedPrs.push({ pr, reason: "github answered without its promised JSON" });
        continue;
      }
      if (!Array.isArray(remote)) {
        skippedPrs.push({ pr, reason: "github answered with JSON that is not the promised array" });
        continue;
      }
      for (const comment of remote) {
        const login = String(comment.user?.login ?? "");
        // GitHub logins are case-insensitive; the allowlist match is too.
        if (!grant.reviewers.some(one => one.toLowerCase() === login.toLowerCase())) continue;
        const id = Number(comment.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const body = validateNote(String(comment.body ?? ""));
        if (!body.ok) {
          refused += 1;
          continue;
        }
        const rawPath = String(comment.path ?? "");
        const lineRaw = comment.line ?? comment.original_line;
        const line = typeof lineRaw === "number" && Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : null;
        const added = store.addDiffComment(
          {
            artifactId: terminal.id,
            runId: publication.run,
            path: rawPath !== "" && rawPath.length <= 300 && !hasDisguisedText(rawPath) ? rawPath : null,
            line,
            note: body.note,
            author: `github:${login}`,
            sourceKey: `gh:${grant.github}:${id}`,
          },
          clock(),
        );
        if (added === null) duplicates += 1;
        else ingested += 1;
      }
    }
    return succeed(write, json, "intake pr-comments", { repo, prs: publications.length, ingested, duplicates, refused, skippedPrs }, () => [
      `${ingested} comment(s) ingested across ${publications.length} PR(s)${duplicates > 0 ? `, ${duplicates} already known` : ""}${refused > 0 ? `, ${refused} refused by the validator` : ""}.`,
      ...skippedPrs.map(one => `  PR #${one.pr} skipped: ${one.reason}`),
      ingested > 0 ? "Seal them into revision tasks from each build's page — every revision takes its own approval." : "",
    ]);
  }

  const limit = Math.min(Math.max(Number(text(flags, "limit") ?? "50"), 1), 200);
  const asked = await gh(
    "gh",
    ["issue", "list", "--repo", grant.github, "--label", grant.label, "--state", "open", "--limit", String(limit), "--json", "number,title,updatedAt"],
    { timeoutMs: 20_000 },
  );
  if (asked.code !== 0) {
    return fail(write, json, `intake ${action}`, "github-unreachable", `gh could not list ${grant.github}: ${(asked.stderr.split("\n")[0] ?? "").slice(0, 200)}`, EXIT.failed);
  }
  let issues: { number: number; title: string; updatedAt?: string }[];
  try {
    issues = JSON.parse(asked.stdout) as typeof issues;
  } catch {
    return fail(write, json, `intake ${action}`, "github-unreadable", "gh answered, but not with the JSON it promised", EXIT.failed);
  }

  const candidates = issues
    .filter(issue => Number.isInteger(issue.number) && issue.number > 0)
    .map(issue => {
      const id = intakeTaskId(grant.github, issue.number);
      const title = String(issue.title ?? "");
      const clean = title.length > 0 && title.length <= 180 && !hasDisguisedText(title);
      return {
        id,
        number: issue.number,
        title,
        clean,
        exists: store.getTask(id) !== null,
      };
    });

  if (action === "preview") {
    if (json) {
      write(envelopeJson({ ok: true, command: "intake preview", repo, github: grant.github, label: grant.label, candidates }));
      return EXIT.ok;
    }
    if (candidates.length === 0) {
      write(`Nothing open in ${grant.github} carries "${grant.label}".`);
      return EXIT.ok;
    }
    write(`Would intake from ${grant.github} ("${grant.label}"):`);
    for (const one of candidates) {
      write(`  #${one.number}  ${one.exists ? "already here as" : one.clean ? "→" : "REFUSED (title carries control characters)"} ${one.id}${one.clean ? ` — ${one.title}` : ""}`);
    }
    write(`Nothing was created. \`toolroll intake run\` makes the proposals.`);
    return EXIT.ok;
  }

  // run: create the missing, clean proposals — local, unapproved, deduped
  // by their deterministic id. The remote is never written.
  const created: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const one of candidates) {
    if (one.exists) continue;
    if (!one.clean) {
      skipped.push({ id: one.id, reason: "title-refused" });
      continue;
    }
    const made = store.transact(() => {
      const filed = fileTaskProposal(
        store,
        {
          id: one.id,
          title: `GH#${one.number}: ${one.title}`,
          repo,
          goal: `Imported from GitHub issue #${one.number} in ${grant.github} (label "${grant.label}"). Only the title was imported — read the issue at https://github.com/${grant.github}/issues/${one.number} for full context, then edit and approve this scope before anything builds.`,
          acceptance: [
            { id: "c1", statement: "The linked GitHub issue's request is read and addressed.", how: null, evidence: ["manual-review"] },
          ],
          filedVia: "intake",
        },
        clock(),
      );
      if (!filed.ok) return filed;
      // The mirror row rides the SAME transaction (v3 §4): provenance is
      // this intake grant, immutably — never inferred later from a label.
      const established = store.establishMirror(
        {
          localTaskId: filed.id,
          backend: "github-issues",
          remoteRepo: grant.github,
          remoteId: String(one.number),
          provenance: "intake",
          intakeGrant: grant.id,
          establishedBy: "intake",
        },
        clock(),
      );
      if (!established.ok && established.reason !== "duplicate") {
        throw new Error(`mirror not established: ${established.reason}`);
      }
      return filed;
    });
    if (made.ok) created.push(made.id);
    else skipped.push({ id: one.id, reason: made.reason });
  }
  return succeed(write, json, "intake run", { repo, github: grant.github, label: grant.label, created, skipped }, () => [
    `${created.length} proposal(s) created${skipped.length > 0 ? `, ${skipped.length} skipped` : ""} — each awaits its own scope approval.`,
    ...created.map(one => `  ${one}`),
    ...skipped.map(one => `  skipped ${one.id}: ${one.reason}`),
  ]);
}


/**
 * `toolroll contest …` — the tournament from the terminal: `show`
 * for the machine-readable state, `exclude` to stop a racing agent whose
 * question you will not answer (authenticated: it cancels paid-for work
 * and un-sticks the race). The pick itself stays a console ceremony.
 */
function contestCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> | number {
  const { store, write, json, clock } = context;
  const [action, idGiven, ordinalGiven] = positional;
  if (action === undefined || !(CONTEST_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "contest", "usage", `unknown \`contest ${action ?? ""}\` — try ${CONTEST_ACTIONS.join(", ")}`, EXIT.usage);
  }
  if (action === "show") {
    const contest = store.getContest(Number(idGiven));
    if (contest === null) return fail(write, json, "contest show", "unknown", "no tournament or comparison with that id", EXIT.refused);
    const agents = store.contestants(contest.id);
    if (json) {
      write(envelopeJson({ ok: true, command: "contest show", contest, agents }));
      return EXIT.ok;
    }
    write(`${contestNoun(contest.kind)} #${contest.id} — ${contest.state}`);
    for (const racer of agents) {
      const money =
        contest.kind === "comparison"
          ? racer.unknownSpend
            ? "spend unmeasured (tokens only)"
            : `$${(racer.measuredMicrousd / 1_000_000).toFixed(2)} measured`
          : `charged $${(racer.accountedMicrousd / 1_000_000).toFixed(2)}${racer.unknownSpend ? " (exact figure unknown — charged the reserved worst case)" : ""}`;
      write(`  agent ${racer.ordinal}: ${racer.provider} · ${racer.model} — ${racer.state} · ${money}`);
    }
    return EXIT.ok;
  }
  if (action === "exclude") {
    return (async () => {
      const contest = store.getContest(Number(idGiven));
      const ordinal = Number(ordinalGiven);
      if (contest === null || !Number.isInteger(ordinal)) {
        return fail(write, json, "contest exclude", "usage", "`toolroll contest exclude <tournament-id> <agent-number> --as <you> --token <t>`", EXIT.usage);
      }
      const acting = await askCredentials(flags, context);
      if (acting === null) {
        return fail(write, json, "contest exclude", "usage", "stopping a racing agent takes `--as <you> --token <t>`", EXIT.usage);
      }
      const authed = authenticateApprover(store, acting.name, acting.token);
      if (!authed.ok) {
        return fail(write, json, "contest exclude", "unauthenticated", "that is not an approver, or the token does not match", EXIT.refused);
      }
      const racer = store.contestants(contest.id).find(one => one.ordinal === ordinal);
      if (racer === undefined || racer.state !== "parked") {
        return fail(write, json, "contest exclude", "not-waiting", "that agent is not waiting on an answer", EXIT.refused);
      }
      const question = store.openDecisionForContestant(racer.id);
      const moved = store.transact(() => {
        if (question !== null && !store.excludeDecision(question, acting.name, clock())) return false;
        if (!store.casContestantState(racer.id, ["parked"], "stopped", racer.generation)) return false;
        contestMaybeAggregate(store, contest.id, clock());
        return true;
      });
      if (!moved) return fail(write, json, "contest exclude", "changed", "the tournament moved while you were reading — look again", EXIT.refused);
      const after = store.getContest(contest.id);
      return succeed(write, json, "contest exclude", { contest: after }, () => [
        `Agent ${ordinal} stopped; its question is closed as excluded. The tournament is now ${after?.state ?? "?"}.`,
      ]);
    })();
  }
  return fail(write, json, "contest", "usage", "`toolroll contest show <id> | exclude <id> <agent-number>`", EXIT.usage);
}

/**
 * `toolroll template …` — the shipped library of common standing
 * orders (adoption track, step 2). A template is a pre-filled form:
 * `apply` PREVIEWS by default and files only under `--file`, through the
 * same one door as every manual filing, landing UNAPPROVED. Recipes
 * (issue-intake, ci-babysitter) display existing ceremonies and cannot be
 * applied — the authority they would need is a separate authenticated act
 * a template must never perform (adoption review, finding 10).
 */
function templateCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, clock } = context;
  const [action, name] = positional;

  if (action === undefined || action === "list") {
    if (json) {
      write(envelopeJson({
        ok: true,
        command: "template list",
        templates: TEMPLATES.map(one => ({ name: one.name, kind: one.kind, purpose: one.purpose })),
      }));
      return EXIT.ok;
    }
    write("Templates — common routines you edit to fit. Nothing a template");
    write("files is approved; recipes only show existing ceremonies.");
    write("");
    for (const one of TEMPLATES) {
      write(`  ${one.name.padEnd(16)} ${one.kind.padEnd(9)} ${one.purpose}`);
    }
    write("");
    write("`toolroll template show <name>` · `template apply <name> --repo <path>`");
    return EXIT.ok;
  }

  if (action !== "show" && action !== "apply") {
    return fail(write, json, `template ${action}`, "usage", "`toolroll template list | show <name> | apply <name> --repo <path> [--file]`", EXIT.usage);
  }
  if (name === undefined) {
    return fail(write, json, `template ${action}`, "usage", "which template? `toolroll template list` names them", EXIT.usage);
  }
  const template = templateByName(name);
  if (template === null) {
    return fail(write, json, `template ${action}`, "unknown", `no template named ${name} — \`toolroll template list\``, EXIT.refused);
  }

  if (action === "show") {
    if (json) {
      write(envelopeJson({ ok: true, command: "template show", template }));
      return EXIT.ok;
    }
    write(`${template.name} — ${template.purpose}`);
    if (template.kind === "recipe") {
      write("");
      write(`This one is a recipe, not an application: ${template.why}`);
      for (const step of template.steps) {
        write("");
        write(`  ${step.say}`);
        write(`    ${step.run}`);
      }
      return EXIT.ok;
    }
    write("");
    if (template.kind === "task") {
      write(`  files      one task (unapproved until you approve its scope)`);
      write(`  title      ${template.title}`);
    } else {
      write(`  files      one routine (cannot fire until you approve its terms)`);
      write(`  name       ${template.routineName}`);
      write(`  schedule   ${template.schedule}`);
    }
    write(`  goal       ${template.goal}`);
    if (template.outOfScope !== null) write(`  not        ${template.outOfScope}`);
    if (template.touches.length > 0) write(`  touches    ${template.touches.join(", ")}`);
    write("");
    write("You will probably edit:");
    for (const hint of template.edit) write(`  - ${hint}`);
    write("");
    write(`\`toolroll template apply ${template.name} --repo <path>\` previews the exact filing.`);
    return EXIT.ok;
  }

  // apply
  if (template.kind === "recipe") {
    return fail(
      write,
      json,
      "template apply",
      "recipe",
      `${template.name} cannot be applied: ${template.why} \`toolroll template show ${template.name}\` walks the ceremonies.`,
      EXIT.refused,
    );
  }
  const repoGiven = text(flags, "repo");
  if (repoGiven === undefined) {
    return fail(write, json, "template apply", "usage", "which repository? --repo <path> — a template never guesses where work lands", EXIT.usage);
  }
  const goal = text(flags, "goal") ?? template.goal;
  const outOfScope = text(flags, "not") ?? template.outOfScope;
  const touches =
    text(flags, "touches") === undefined
      ? template.touches
      : (text(flags, "touches") ?? "").split(",").map(one => one.trim()).filter(one => one !== "");

  if (template.kind === "task") {
    const title = text(flags, "title") ?? template.title;
    const draft = {
      kind: "task" as const,
      title,
      repo: canonicalProject(repoGiven) ?? resolve(repoGiven),
      goal,
      outOfScope,
      touches,
      filedVia: `template:${template.name}`,
    };
    if (!flags.has("file")) {
      if (json) {
        write(envelopeJson({ ok: false, command: "template apply", reason: "unconfirmed", draft }));
        return 3;
      }
      write("Would file, exactly (edit with --title/--goal/--not/--touches):");
      write("");
      write(`  task    ${draft.title}`);
      write(`  repo    ${draft.repo}`);
      write(`  goal    ${draft.goal}`);
      if (draft.outOfScope !== null) write(`  not     ${draft.outOfScope}`);
      if (draft.touches.length > 0) write(`  touches ${draft.touches.join(", ")}`);
      write("");
      write("Nothing was filed. Re-run with --file to file it — UNAPPROVED either way.");
      return 3;
    }
    const made = fileTaskProposal(
      store,
      { title, repo: repoGiven, goal, outOfScope, touches, acceptance: template.acceptance, filedVia: `template:${template.name}` },
      clock(),
    );
    if (!made.ok) return fail(write, json, "template apply", made.reason, made.message, made.reason === "duplicate" ? EXIT.refused : EXIT.usage);
    const filedLink = consoleLinkFor(context, `/t/${encodeURIComponent(made.id)}`);
    return succeed(
      write,
      json,
      "template apply",
      { filed: "task", id: made.id, approved: false, ...(filedLink === null ? {} : { links: { task: filedLink } }) },
      () => [
        `Filed ${made.id} from template ${template.name}.`,
        "",
        "UNAPPROVED — NO AUTHORITY GRANTED. It builds only after you approve its scope:",
        `  toolroll task show ${made.id}`,
        ...(filedLink === null ? [] : [`  ${filedLink}`]),
      ],
    );
  }

  const routineName = text(flags, "name") ?? template.routineName;
  const schedule = text(flags, "schedule") ?? template.schedule;
  const ceilingGiven = text(flags, "ceiling");
  const costCeilingUsd = ceilingGiven === undefined ? template.costCeilingUsd : Number(ceilingGiven);
  if (!flags.has("file")) {
    const draft = {
      kind: "routine" as const,
      name: routineName,
      repo: canonicalProject(repoGiven) ?? resolve(repoGiven),
      goal,
      outOfScope,
      touches,
      acceptance: template.acceptance,
      requirements: template.requirements,
      schedule,
      costCeilingUsd,
      filedVia: `template:${template.name}`,
    };
    if (json) {
      write(envelopeJson({ ok: false, command: "template apply", reason: "unconfirmed", draft }));
      return 3;
    }
    write("Would file, exactly (edit with --name/--goal/--not/--touches/--schedule/--ceiling):");
    write("");
    write(`  routine  ${draft.name}`);
    write(`  repo     ${draft.repo}`);
    write(`  schedule ${draft.schedule}${draft.schedule.startsWith("every:10080") ? "  (weekly)" : ""}`);
    write(`  goal     ${draft.goal}`);
    if (draft.outOfScope !== null) write(`  not      ${draft.outOfScope}`);
    if (draft.touches.length > 0) write(`  touches  ${draft.touches.join(", ")}`);
    if (draft.costCeilingUsd !== null) write(`  ceiling  $${draft.costCeilingUsd}/week`);
    write("");
    write("Nothing was filed. Re-run with --file to file it — UNAPPROVED either way; it cannot fire until you approve it.");
    return 3;
  }
  const made = fileRoutineProposal(
    store,
    {
      name: routineName,
      repo: repoGiven,
      goal,
      outOfScope,
      touches,
      acceptance: template.acceptance,
      requirements: template.requirements,
      schedule,
      costCeilingUsd,
      filedVia: `template:${template.name}`,
    },
    clock(),
  );
  if (!made.ok) return fail(write, json, "template apply", made.reason, made.message, made.reason === "duplicate" ? EXIT.refused : EXIT.usage);
  return succeed(write, json, "template apply", { filed: "routine", id: made.id, approved: false }, () => [
    `Filed routine ${routineName} from template ${template.name}.`,
    "",
    "UNAPPROVED — NO AUTHORITY GRANTED. It cannot fire until you approve the standing order:",
    `  toolroll routine approve ${routineName}`,
  ]);
}

/**
 * `toolroll routine …` — standing orders. Filing one is cheap; the
 * expensive act is the approval, which restates every term including "each
 * firing builds without asking" and takes the approver's credential, same
 * as a scope. Pausing needs no ceremony because stopping spend never does.
 */
async function routineCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, name] = positional;
  if (action !== undefined && !(ROUTINE_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "routine", "usage", `unknown \`routine ${action}\` — try ${ROUTINE_ACTIONS.join(", ")}`, EXIT.usage);
  }

  if (action === undefined || action === "list") {
    const repoFilter = text(flags, "repo");
    const routines = store.listRoutines(
      repoFilter === undefined ? null : canonicalProject(repoFilter) ?? resolve(repoFilter),
    );
    if (json) {
      write(envelopeJson({ ok: true, command: "routine list", routines }));
      return EXIT.ok;
    }
    if (routines.length === 0) {
      write("No routines. `toolroll routine add <name> --repo <path> --goal <text> --schedule every:60` files one.");
      return EXIT.ok;
    }
    for (const routine of routines) {
      const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
      const status = routine.paused ? "paused" : approved ? "live" : "awaiting approval";
      write(`  ${routine.name.padEnd(20)} ${status.padEnd(18)} ${routine.schedule.padEnd(14)} ${routine.repo}`);
    }
    return EXIT.ok;
  }

  if (action === "add") {
    if (name === undefined || !ROUTINE_NAME.test(name)) {
      return fail(write, json, "routine add", "usage", "a routine's name is lowercase letters, digits, and dashes — it becomes each instance's id", EXIT.usage);
    }
    const repoGiven = text(flags, "repo");
    const goal = text(flags, "goal");
    const schedule = text(flags, "schedule");
    if (repoGiven === undefined || goal === undefined || schedule === undefined) {
      return fail(write, json, "routine add", "usage", "`toolroll routine add <name> --repo <path> --goal <text> --schedule every:<min>|daily:<HH:MM>[@Zone]|weekly:<0-6>:<HH:MM>[@Zone] --acceptance <rubric> [--not <text>] [--touches a,b] [--require kind:name,…] [--ceiling <usd>] [--budget-usd <n>]`", EXIT.usage);
    }
    const acceptanceGiven = text(flags, "acceptance");
    if (acceptanceGiven === undefined) {
      return fail(
        write, json, "routine add", "acceptance-required",
        "a standing order needs at least one signed acceptance criterion — `--acceptance \"<statement>|<evidence,kinds>\"`, `;`-separated for more than one; evidence kinds are check, screenshot, changed-path, manual-review",
        EXIT.usage,
      );
    }
    const ceilingGiven = text(flags, "ceiling");
    // --budget-usd on a routine caps EACH instance (v16): it becomes the
    // instance scope's digest-bound budget term, enforced by the same
    // native-cap plumbing as any other scope budget.
    const perRunGiven = text(flags, "budget-usd");
    if (perRunGiven !== undefined && (!Number.isFinite(Number(perRunGiven)) || Number(perRunGiven) <= 0)) {
      return fail(write, json, "routine add", "bad-budget", "--budget-usd is a positive dollar amount — what each firing may spend", EXIT.usage);
    }
    // One filing door for every surface (Codex adoption review, finding 7):
    // validation, canonicalization, digest, and provenance live in the
    // service, not here.
    const created = fileRoutineProposal(
      store,
      {
        name,
        repo: repoGiven,
        goal,
        outOfScope: text(flags, "not") ?? null,
        touches: (text(flags, "touches") ?? "").split(",").map(one => one.trim()).filter(one => one !== ""),
        acceptance: acceptanceLinesToInput(splitAcceptanceRubric(acceptanceGiven)),
        requirements: (text(flags, "require") ?? "").split(",").map(one => one.trim()).filter(one => one !== ""),
        schedule,
        costCeilingUsd: ceilingGiven === undefined ? null : Number(ceilingGiven),
        ...(perRunGiven === undefined ? {} : { budgetPerRunMicrousd: Math.round(Number(perRunGiven) * 1_000_000) }),
        filedVia: "cli",
      },
      clock(),
    );
    if (!created.ok) {
      return fail(write, json, "routine add", created.reason, created.message, created.reason === "duplicate" ? EXIT.refused : EXIT.usage);
    }
    const routine = store.getRoutine(created.id);
    return succeed(write, json, "routine add", { routine }, () => [
      `Filed ${name}. Nothing fires until somebody approves the standing order:`,
      ...(routine === null ? [] : describeRoutine(routine)),
      "",
      `  toolroll routine approve ${name}`,
    ]);
  }

  if (name === undefined) {
    return fail(write, json, `routine ${action}`, "usage", "which routine? give its name", EXIT.usage);
  }
  const routine = store.routineByName(name);
  if (routine === null) {
    return fail(write, json, `routine ${action}`, "unknown", `no routine named ${name}`, EXIT.refused);
  }

  switch (action) {
    case "show": {
      const fires = store.routineFires(routine.id, 14);
      if (json) {
        write(envelopeJson({ ok: true, command: "routine show", routine, fires }));
        return EXIT.ok;
      }
      const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
      write(`${routine.name} — ${routine.paused ? "paused" : approved ? "live" : "awaiting approval"}`);
      for (const line of describeRoutine(routine)) write(line);
      if (routine.nextFireAt !== null && !routine.paused && approved) write(`  next fire    ${routine.nextFireAt}`);
      if (fires.length > 0) {
        write("");
        write("  recent firings, newest first:");
        for (const fire of fires) {
          const said =
            fire.outcome === "fired"
              ? `${fire.instanceTaskId ?? "instance"}${fire.instanceState === null ? "" : ` (${fire.instanceState})`}${fire.reason === "manual" ? "  (run now)" : ""}`
              : `skipped — ${fire.reason ?? ""}`;
          write(`    ${fire.scheduledFor.replace(/^manual:/, "")}  ${said}`);
        }
      }
      return EXIT.ok;
    }
    case "approve": {
      let saw = text(flags, "digest");
      let { name: asWho, token } = credentialsFrom(flags, context);
      let confirmedAloud = false;
      if ((!flags.has("yes") || saw === undefined || asWho === undefined || token === undefined) && interactive() && !json) {
        write(`Approving ${name} makes it a STANDING order:`);
        write("");
        for (const line of describeRoutine(routine)) write(line);
        write("");
        const agreed = await confirm("Approve exactly this standing order?");
        if (!agreed) {
          write("Nothing approved.");
          return EXIT.refused;
        }
        saw ??= routine.digest;
        const acting = await askCredentials(flags, context);
        if (acting === null) return fail(write, json, "routine approve", "usage", "approval needs who is agreeing", EXIT.usage);
        asWho = acting.name;
        token = acting.token;
        confirmedAloud = true;
      }
      const armed = (flags.has("yes") || confirmedAloud) && saw !== undefined && asWho !== undefined && token !== undefined;
      if (!armed) {
        if (json) {
          write(envelopeJson({ ok: false, command: "routine approve", reason: "unconfirmed", routine }));
          return EXIT.refused;
        }
        write(`Would approve this standing order — every firing of it builds without asking:`);
        write("");
        for (const line of describeRoutine(routine)) write(line);
        write("");
        write("Nothing has been approved. Agree to exactly this with:");
        write(`  toolroll routine approve ${name} --yes --digest ${routine.digest} --as <you> --token <your password>`);
        // A preview reached by omitting --yes is the answer "no, not yet" —
        // exit 3 in both modes, matching the JSON path (round-4 finding 10).
        return EXIT.refused;
      }
      const approved = approveRoutine(store, routine.id, asWho as string, clock(), saw as string, token as string);
      if (!approved.ok) {
        return fail(write, json, "routine approve", approved.reason, describeApproveFailure(approved.reason, name), EXIT.refused);
      }
      return succeed(write, json, "routine approve", { routine: approved.routine }, () => [
        `Approved. ${name} fires on its schedule from now on; first at ${approved.routine.nextFireAt}.`,
        `Pause it any time: toolroll routine pause ${name}`,
      ]);
    }
    case "refresh": {
      // THE RECOVERY ROAD (v48): re-resolve the agents from today's
      // configuration and file them as the order's working agents. Nothing
      // is approved here — the refreshed order waits for the yes.
      const before = routineAgentsState(routine);
      const refreshed = refreshRoutineAgents(store, routine.id, clock());
      if (!refreshed.ok) {
        return fail(write, json, "routine refresh", refreshed.reason, `${name}: ${refreshed.problem}`, EXIT.refused);
      }
      return succeed(write, json, "routine refresh", { routine: refreshed.routine, changed: refreshed.changed, before: before.state }, () => [
        refreshed.changed
          ? `Refreshed ${name}'s agents from today's configuration. Nothing is approved yet — read them and agree:`
          : `${name} already names exactly these agents; nothing changed.`,
        ...describeRoutine(refreshed.routine),
        "",
        `  toolroll routine approve ${name}`,
      ]);
    }
    case "pause":
    case "resume": {
      store.setRoutinePaused(routine.id, action === "pause", clock());
      return succeed(write, json, `routine ${action}`, { name }, () => [
        action === "pause"
          ? `${name} is paused — no firing until you resume it. Already-running instances finish.`
          : `${name} resumed — the next due slot fires again.`,
      ]);
    }
    case "run-now": {
      const acting = await askCredentials(flags, context);
      if (acting === null) {
        return fail(write, json, "routine run-now", "usage", "run-now takes `--as <you> --token <t>` — it dispatches work that spends", EXIT.usage);
      }
      const authenticated = authenticateApprover(store, acting.name, acting.token);
      if (!authenticated.ok) {
        return fail(write, json, "routine run-now", authenticated.reason, describeApproveFailure(authenticated.reason, name), EXIT.refused);
      }
      const outcome = fireRoutine(store, routine.id, clock(), { manual: true });
      if (!outcome.ok) {
        return fail(write, json, "routine run-now", outcome.reason, outcome.detail ?? outcome.reason, EXIT.refused);
      }
      return succeed(write, json, "routine run-now", { taskId: outcome.taskId }, () => [
        `Spawned ${outcome.taskId} — it builds on the next pass. The regular schedule is untouched.`,
      ]);
    }
    default:
      return fail(write, json, "routine", "usage", "`toolroll routine [add|list|show|approve|refresh|pause|resume|run-now]`", EXIT.usage);
  }
}

/** A credential from a 0600 file, for units that must not carry it inline. */
function readTokenFile(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw === "" ? undefined : raw;
  } catch {
    return undefined;
  }
}

// ---- the daemon ------------------------------------------------------------

/**
 * `toolroll daemon install|status|uninstall|logs` — the loop as a
 * service, no crontab. Writes the platform's own supervision unit (launchd
 * on macOS, systemd --user on Linux) pointed at `toolroll watch`, with
 * the runner token in a 0600 file beside the database rather than inside
 * the unit. The OS restarts it across crashes and reboots, and watch's
 * incarnation recovery is what makes those restarts safe.
 */
async function daemonCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const demoFence = refuseDemo(context, "daemon");
  if (demoFence !== null) return demoFence;
  const [action = "status"] = positional;
  const repo = repoFrom(flags);
  const configDir = dirname(context.telegramTokenFile);
  const supervise: SupervisorRunner = context.gitRunner ?? run;

  const binFlag = text(flags, "bin");
  const resolveBin = async (): Promise<{ bin: string; binArgs: string[] } | null> => {
    const direct = daemonLaunchCommand({
      execPath: process.execPath,
      ...(process.argv[1] === undefined ? {} : { entry: resolve(process.argv[1]) }),
      ...(binFlag === undefined ? {} : { explicitBin: resolve(binFlag) }),
    });
    if (direct !== null) return direct;
    const found = await supervise("sh", ["-lc", "command -v toolroll || command -v standing-orders"]);
    if (found.code === 0 && found.stdout.trim() !== "") {
      // Even the PATH fallback is run by this process's absolute Node binary:
      // npm's package bin is a JS symlink whose env-node shebang is precisely
      // what a minimal launchd environment cannot resolve.
      return { bin: process.execPath, binArgs: [found.stdout.trim()] };
    }
    return null;
  };

  if (action === "install") {
    const runnerName = text(flags, "runner");
    const inlineToken = text(flags, "token");
    const tokenPath = text(flags, "token-file");
    if (inlineToken !== undefined && tokenPath !== undefined) {
      return fail(write, json, "daemon install", "usage", "choose one credential source: --token or --token-file", EXIT.usage);
    }
    const token = inlineToken ?? readTokenFile(tokenPath);
    if (runnerName === undefined || token === undefined) {
      return fail(write, json, "daemon install", "usage", "`toolroll daemon install --runner <name> (--token <t> | --token-file <path>) --repo <path>` (plus any watch flags to bake in)", EXIT.usage);
    }
    const auth = authenticate(store, runnerName, token);
    if (!auth.ok) {
      return fail(write, json, "daemon install", auth.reason, describeAuth(auth.reason, runnerName), EXIT.refused);
    }
    const heartbeatBefore = store.getRunner(runnerName)?.runner.heartbeatAt ?? null;
    const located = await resolveBin();
    if (located === null) {
      return fail(
        write,
        json,
        "daemon install",
        "no-bin",
        "`toolroll` is not on the PATH the service would use — run `toolroll link` first, or pass --bin <absolute path>",
        EXIT.refused,
      );
    }

    const watchFlags: string[] = [];
    for (const name of ["pool", "model", "repair-model", "provider", "plan-model", "plan-provider", "max", "turns", "tick-every", "bridge-every", "reconcile-every", "max-open-decisions", "containment"]) {
      const value = text(flags, name);
      if (value !== undefined) watchFlags.push(`--${name}`, value);
    }

    if (!watchFlags.includes("--containment")) watchFlags.push("--containment", currentContainment().policy);
    const plan = planDaemon({
      platform: process.platform,
      bin: located.bin,
      binArgs: located.binArgs,
      runner: runnerName,
      repo,
      configDir,
      watchFlags,
    });
    if ("error" in plan) return fail(write, json, "daemon install", "unsupported", plan.error, EXIT.refused);
    // A watch installed under the label from before the rename is replaced, never left running beside this one.
    const legacy = installedLegacyDaemon({ platform: process.platform, bin: located.bin, binArgs: located.binArgs, runner: runnerName, repo, configDir, watchFlags });

    if (flags.has("dry-run")) {
      if (json) {
        write(envelopeJson({ ok: true, command: "daemon install", dryRun: true, plan, replaces: legacy?.label ?? null }));
        return EXIT.ok;
      }
      write(`Would write ${plan.unitPath}:`);
      write("");
      write(plan.unitContent);
      write(`Token (0600): ${plan.tokenFile} · logs: ${plan.logPath}`);
      if (legacy !== null) write(`Would stop and remove ${legacy.label} (${legacy.unitPath}), the same watch under its older name.`);
      write("Nothing was written. Re-run without --dry-run to install.");
      return EXIT.ok;
    }

    const installed = await installReplacingLegacy(plan, token, legacy, supervise);
    if (!installed.ok) {
      return fail(write, json, "daemon install", "supervisor", installed.message, EXIT.failed);
    }
    // The legacy watch beat for this runner until it stopped: only a beat after that proves the new one.
    const readySince = legacy === null ? heartbeatBefore : store.getRunner(runnerName)?.runner.heartbeatAt ?? null;
    const started = await daemonStatus(plan, supervise);
    if (started.state !== "running") {
      return fail(
        write,
        json,
        "daemon install",
        "not-running",
        `the service was installed but did not stay running (${started.detail}) — read ${plan.logPath}; no work will be claimed until this is fixed`,
        EXIT.failed,
      );
    }
    // A supervisor PID is necessary but not sufficient: macOS can leave a
    // process stuck behind a protected-folder access check before it ever
    // opens the queue. The credentialed runner heartbeat is the end-to-end
    // readiness receipt that proves this service reached the work loop —
    // a FRESH one when the service was (re)started; the one already
    // standing when a healthy running service was left alone.
    const fresh = await awaitFreshHeartbeat(store, runnerName, installed.action === "running" && legacy === null ? null : readySince);
    const liveRunner = fresh.ok ? store.getRunner(runnerName)?.runner ?? null : null;
    if (liveRunner === null) {
      const macHint = process.platform === "darwin" && repo.startsWith(join(homedir(), "Documents"))
        ? " macOS may be blocking background access to Documents; grant the Node executable Full Disk Access, move the repository outside a protected folder, or keep `toolroll up` running from your terminal."
        : "";
      return fail(
        write,
        json,
        "daemon install",
        "not-ready",
        `the supervisor has a process, but ${runnerName} never reached its worker heartbeat.${macHint} Read ${plan.logPath}; no work will be claimed until the heartbeat appears`,
        EXIT.failed,
      );
    }
    return succeed(write, json, "daemon install", { label: plan.label, unit: plan.unitPath, logs: plan.logPath, state: started.state, pid: started.pid, heartbeatAt: liveRunner.heartbeatAt, action: installed.action, changed: installed.changed, replaced: legacy?.label ?? null, containment: containmentStatus(currentContainment()) }, () => [
      installed.action === "running" ? `${plan.label} was already running under this exact definition; left alone.` : installed.action === "reloaded" ? `Reloaded ${plan.label} under its changed definition.` : `Installed and started ${plan.label}.`,
      ...(legacy === null ? [] : [`  replaced ${legacy.label} (stopped and removed)`]),
      `  verified ${started.detail}`,
      `  worker   ${runnerName} answered at ${liveRunner.heartbeatAt}`,
      `  unit    ${plan.unitPath}`,
      `  token   ${plan.tokenFile} (0600 — the unit never carries it)`,
      `  logs    ${plan.logPath}`,
      "",
      "It survives reboots and restarts itself after crashes; watch's",
      "incarnation recovery makes those restarts safe. `toolroll daemon",
      "status` to check on it, `daemon uninstall` to take it back off.",
    ]);
  }

  // status / uninstall / logs share the computed plan; the bin is cosmetic there.
  const planArgs = {
    platform: process.platform,
    bin: binFlag ?? "toolroll",
    binArgs: [],
    runner: text(flags, "runner") ?? "runner",
    repo,
    configDir,
    watchFlags: [],
  };
  const current = planDaemon(planArgs);
  if ("error" in current) return fail(write, json, `daemon ${action}`, "unsupported", current.error, EXIT.refused);
  // Until it is reinstalled, a watch installed before the rename is found under its older label.
  const legacy = installedLegacyDaemon(planArgs);
  const plan = legacy !== null && !existsSync(current.unitPath) ? legacy : current;

  if (action === "status") {
    const state = await daemonStatus(plan, supervise);
    const containment = currentContainment();
    if (json) {
      write(envelopeJson({ ok: true, command: "daemon status", ...state, label: plan.label, logs: plan.logPath, containment: containmentStatus(containment) }));
      return state.state === "running" ? EXIT.ok : EXIT.refused;
    }
    write(`${plan.label}: ${state.detail}`);
    write(`  logs  ${plan.logPath}`);
    write(`  ${describeContainment(containment)}`);
    if (state.state === "not-installed") write("  → toolroll daemon install --runner <name> --token <t> --repo <path>");
    if (state.state === "disabled") write("  → the service is disabled: `toolroll daemon install` re-enables and loads it");
    return state.state === "running" ? EXIT.ok : EXIT.refused;
  }

  if (action === "uninstall") {
    const gone = await uninstallDaemon(current, supervise);
    const legacyGone = legacy === null ? null : await uninstallDaemon(legacy, supervise);
    return succeed(write, json, "daemon uninstall", { removed: gone.existed || legacyGone?.existed === true }, () => [
      ...(gone.existed || legacyGone === null ? [gone.existed ? `Stopped and removed ${current.label}.` : `${current.label} was not installed; nothing to remove.`] : []),
      ...(legacyGone === null ? [] : [`Stopped and removed ${legacy!.label}.`]),
    ]);
  }

  if (action === "logs") {
    return succeed(write, json, "daemon logs", { logs: plan.logPath }, () => [
      plan.logPath,
      `  → tail -f ${plan.logPath}`,
    ]);
  }

  return fail(write, json, "daemon", "usage", "`toolroll daemon [install|status|uninstall|logs]`", EXIT.usage);
}

// ---- the watch loop --------------------------------------------------------

const WATCH_LEASE_MS = 90_000;
const WATCH_HEARTBEAT_MS = 30_000;

/**
 * `toolroll watch` — the loop (§5, §6): the cron chain as one
 * work-conserving process, still spending zero tokens while idle.
 *
 * Composition, not new semantics: every pass it runs — tick, reconcile, the
 * bridge — is the same tested command cron calls, and cron remains
 * first-class; ordinary claims make watch-and-cron coexistence safe, so
 * only watch+watch contends (per runner and repo, loudly, `watch-busy`).
 *
 * Work-conserving by the wake sequence: every readiness-changing write
 * bumps a durable counter; watch records what it saw before a pass and
 * runs again immediately if the world moved while it worked — a decision
 * answered from a phone triggers the next tick in seconds, not at the next
 * interval. Timers are the fallback, not the mechanism.
 *
 * Crash-safe by incarnation: this process's claims carry its UUID, and a
 * successor taking over the lease recovers exactly the superseded
 * incarnation's claims, runs, and worktrees before dispatching anything —
 * the case liveness cannot see, because the successor IS the runner,
 * alive and heartbeating.
 *
 * Graceful stop: a signal stops admitting new passes; the in-flight one
 * finishes under its own bounded timeouts while the lease keeps beating,
 * then the lease is handed back. A second signal, or the grace clock
 * (--stop-grace, default 30s), SIGKILLs every live provider's process
 * group (M6.12): runs finalize as failures, worktrees are preserved, and
 * fences keep late output out of every commit.
 */
/**
 * The extracted watch loop (arc 2 finding 5/20): NON-EMITTING — every line
 * goes through `args.progress`, every stop decision through the caller's
 * fences, and the answer is a typed result, never an envelope. watchCommand
 * wraps it with its historical signals and output; `up` supervises several
 * of them beside a console. The lease and heartbeat ride the CREDENTIALED
 * doors (findings 15/25): after a takeover rotates this runner's token,
 * acquisition refuses and the very next renewal is FATAL — a loop that has
 * lost its lease or its credential stops admitting work immediately.
 */
type WatchLoopResult =
  | { ok: true; ticks: number; built: number; broke: number; incarnation: string }
  | { ok: false; reason: "watch-busy" | "lease-lost" | "reconciliation-failed" | "loop-failed"; detail: string; ticks: number; built: number; broke: number };

/** The start repair runs once per process, not once per project loop. */
/**
 * The Telegram follower: one actor on the wire that sends notifications and
 * replies and reads what arrives, all over the same transport. Null when no
 * bot token is saved, or when this process's network is fenced (it says so
 * once instead of failing every send).
 */
function startTelegramFollower(args: {
  context: Context;
  publicUrl: string | undefined;
  signal: AbortSignal;
  progress: (line: string) => void;
  label: string;
  died: { prefix: string; then: string };
  owner?: string;
}): Promise<FollowReport | null> | null {
  const { context, progress, label } = args;
  const source = loadBotToken(process.env, context.telegramTokenFile);
  if (source === null) return null;
  const fence = networkFence(context.telegramEnv ?? (context.telegramTransport === undefined ? process.env : {}));
  if (fence !== null) {
    progress(networkFenceLine(fence));
    return null;
  }
  const transport = context.telegramTransport ?? createTransport(source.token);
  // v98: with a public hooks address (Tailscale Funnel covers /hooks), Telegram pushes updates to it instead.
  const pushUrl = telegramPushUrl(readHooksBase(dirname(context.databaseFile)));
  return followBridge(context.store, {
    push: pushUrl === null ? null : { url: pushUrl, secret: telegramHookSecret(dirname(context.databaseFile), true)! },
    readProjects: telegramReadProjects(context),
    canDeliver: telegramCanDeliver(context, source.token),
    conversation: telegramConversation(context, args.publicUrl === undefined ? {} : { serverOrigin: args.publicUrl }),
    botId: source.botId,
    transport,
    signal: args.signal,
    ...(args.owner === undefined ? {} : { owner: args.owner }),
    onCycle: cycle => {
      // progress(), not write(): under --json this line went to stdout
      // BESIDE the final envelope — the one stdout contamination in the
      // watch (round-4 finding 12).
      progress(
        `${label} sent ${cycle.sent}, answered ${cycle.answered}, paired ${cycle.paired}` +
          ((cycle.statusReplies ?? 0) > 0 ? `, status replies ${cycle.statusReplies}` : "") +
          ((cycle.chatQueued ?? 0) > 0 ? `, chat received ${cycle.chatQueued}` : "") +
          ((cycle.chatAnswered ?? 0) > 0 ? `, chat replied ${cycle.chatAnswered}` : "") +
          ((cycle.chatConfirmed ?? 0) > 0 ? `, chat confirmed ${cycle.chatConfirmed}` : "") +
          (cycle.problems.length > 0 ? ` — ${cycle.problems.length} problem(s): ${cycle.problems[0]!.slice(0, 200)}` : ""),
      );
    },
  }).catch(error => {
    progress(`${args.died.prefix}the telegram follower died — ${describe(error)}; ${args.died.then}`);
    return null;
  });
}

/** How long a stopping service waits for the aborted Telegram follower. */
const TELEGRAM_STOP_WAIT_MS = 5_000;

let staleStatusesRepaired = false;

async function runWatchLoop(args: {
  flags: Map<string, string | true>;
  context: Context;
  runner: string;
  token: string;
  repo: string;
  progress: (line: string) => void;
  /** The caller's admission fence — true stops the loop at the next gate. */
  isStopping: () => boolean;
  /** Hands the caller the follower's controller so its stop can abort the long poll. */
  onFollowController?: (controller: AbortController) => void;
  /** Resolves the caller's readiness: fired after the lease is held. */
  onReady?: () => void;
  /** The start's containment words; the exact status line when absent. */
  containmentLines?: (effective: EffectiveContainment) => readonly string[];
  /** Shared by every project loop of one service, for fair scheduling. */
  passes?: ProjectPasses;
  /** The service sends and receives Telegram itself; this loop never touches the bot. */
  serviceBridge?: boolean;
}): Promise<WatchLoopResult> {
  const { context, flags, runner, token, repo, progress } = args;
  const { store } = context;

  const tickEveryMs = Number(text(flags, "tick-every") ?? 60_000);
  const bridgeEveryMs = Number(text(flags, "bridge-every") ?? 45_000);
  const reconcileEveryMs = Number(text(flags, "reconcile-every") ?? 5 * 60_000);
  const runFor = text(flags, "for") === undefined ? null : Number(text(flags, "for"));
  if (!Number.isSafeInteger(reconcileEveryMs) || reconcileEveryMs < 1 || reconcileEveryMs > 2_147_483_647) {
    throw new Error("--reconcile-every must be an integer from 1 to 2147483647 milliseconds");
  }

  const incarnation = randomUUID();
  const lease = acquireWatchLeaseAuthed(
    store,
    { runner, token, repo, owner: incarnation, ttlMs: WATCH_LEASE_MS },
    new Date(),
  );
  if (!lease.ok) {
    return {
      ok: false,
      reason: "watch-busy",
      detail:
        lease.reason === "watch-busy"
          ? `another watch holds ${runner} on ${repo} until ${lease.until} — one watch per runner and repo; cron ticks may coexist, watches may not`
          : describeAuth(lease.reason, runner),
      ticks: 0,
      built: 0,
      broke: 0,
    };
  }
  if (lease.superseded !== null && lease.recovered > 0) {
    progress(`Recovered ${lease.recovered} claim(s) from the previous watch (${lease.superseded.slice(0, 8)}…) before dispatching anything.`);
  }
  // What this runner's spawns actually get, in one honest line: native
  // and which backend, observed, or a required policy that will refuse.
  for (const line of args.containmentLines?.(currentContainment()) ?? [`watch: ${describeContainment(currentContainment())}`]) progress(line);

  // The night is a row, not "the last 24 hours": everything this watch does
  // attributes to this episode by runner and window, and `brief
  // --latest-watch` bounds itself to exactly it.
  store.startWatchEpisode({ repo, runner, incarnation }, new Date());
  // A deploy's one chat line, "Toolroll <version> is live.", when this worker last ran an older version.
  try { notifyVersionLive(store, dirname(context.databaseFile), PACKAGE_VERSION, new Date()); } catch { /* A display fact; never blocks the worker. */ }
  recordRunnerVersion(dirname(context.databaseFile), runner, PACKAGE_VERSION, new Date());
  args.onReady?.();
  // Once per worker start, before any pass: statuses an older build left
  // stale (unrecorded exits of finished runs) are re-derived and clear.
  if (!staleStatusesRepaired) {
    staleStatusesRepaired = true;
    const repaired = repairStaleStatuses(store, new Date());
    if (repaired.exitsRecorded > 0) progress(`watch: recorded ${repaired.exitsRecorded} finished process exit(s) left open by an earlier version`);
  }

  // A false renewal is FATAL (arc 2 finding 15): the lease or the
  // credential is gone, and admitting one more pass would be work done for
  // an authority this process no longer holds.
  let leaseLost = false;
  const followController = new AbortController();
  args.onFollowController?.(followController);
  const stopping = (): boolean => args.isStopping() || leaseLost;

  const heartbeat = setInterval(() => {
    let renewed = false;
    let problem = "the lease or credential was taken";
    try {
      renewed = heartbeatWatchLeaseAuthed(
        store,
        { runner, token, repo, owner: incarnation, ttlMs: WATCH_LEASE_MS },
        new Date(),
      );
    } catch (error) {
      problem = `renewal could not be proved: ${describe(error)}`;
    }
    if (!renewed && !leaseLost) {
      leaseLost = true;
      followController.abort();
      progress(`watch: ${runner} on ${repo}: ${problem} — stopping without admitting more work`);
    }
  }, WATCH_HEARTBEAT_MS);
  heartbeat.unref?.();

  // The follower rides along when Telegram is configured: taps apply the
  // moment they arrive, and answering bumps the wake sequence, so the very
  // loop below wakes and resumes the freed task — phone to build, seconds.
  // The poll lease keeps this the only live poller; a cron `bridge
  // telegram` overlapping it loses the lease race and reports busy. Under
  // `up` the service runs the one follower itself and project loops leave
  // Telegram to it.
  const serviceBridge = args.serviceBridge === true;
  const follower: Promise<FollowReport | null> | null = serviceBridge
    ? null
    : startTelegramFollower({ context, publicUrl: text(flags, "public-url"), signal: followController.signal, progress, label: "watch: bridge", died: { prefix: "watch: ", then: "taps wait for the next watch" } });

  const slackFollower = followSlack({store,dir:dirname(context.databaseFile),signal:followController.signal,
    readProjects:telegramReadProjects(context),evidenceRoot:context.evidenceRoot,
    ...(context.mateSeams?.subscriptionRunner ? {subscriptionRunner:context.mateSeams.subscriptionRunner} : {}),
    ...(context.heldCoordinator ? {held:context.heldCoordinator} : {}),
    origin:()=>phoneOrigin(process.env,dirname(context.databaseFile),{serverOrigin:text(flags,"public-url")??null}),
    notifications:()=>effectivePrimary(process.env,dirname(context.databaseFile),loadBotToken(process.env,context.telegramTokenFile)!==null).channel==="slack",
  }).catch(()=>progress("watch: Slack stopped. Check Slack settings before reconnecting."));

  const teamsFollower = followTeams({store,dir:dirname(context.databaseFile),signal:followController.signal,
    readProjects:telegramReadProjects(context),evidenceRoot:context.evidenceRoot,
    ...(context.mateSeams?.subscriptionRunner ? {subscriptionRunner:context.mateSeams.subscriptionRunner} : {}),
    ...(context.heldCoordinator ? {held:context.heldCoordinator} : {}),
    origin:()=>phoneOrigin(process.env,dirname(context.databaseFile),{serverOrigin:text(flags,"public-url")??null}),
    notifications:()=>effectivePrimary(process.env,dirname(context.databaseFile),loadBotToken(process.env,context.telegramTokenFile)!==null).channel==="teams",
  }).catch(()=>progress("watch: Teams stopped. Check Teams settings before reconnecting."));

  const discordFollower = followDiscord({store,dir:dirname(context.databaseFile),signal:followController.signal,
    readProjects:telegramReadProjects(context),evidenceRoot:context.evidenceRoot,
    ...(context.mateSeams?.subscriptionRunner ? {subscriptionRunner:context.mateSeams.subscriptionRunner} : {}),
    ...(context.heldCoordinator ? {held:context.heldCoordinator} : {}),
    origin:()=>phoneOrigin(process.env,dirname(context.databaseFile),{serverOrigin:text(flags,"public-url")??null}),
    notifications:()=>effectivePrimary(process.env,dirname(context.databaseFile),loadBotToken(process.env,context.telegramTokenFile)!==null).channel==="discord",
  }).catch(()=>progress("watch: Discord stopped. Check Discord settings before reconnecting."));

  // Passes reuse the tested commands with a quiet sink; watch narrates one
  // line per pass that did something instead of streaming their reports.
  const quiet: string[] = [];
  const sink: Write = line => quiet.push(line);
  const passFlags = (extra: Record<string, string> = {}): Map<string, string | true> => {
    const copy = new Map(flags);
    copy.set("json", true);
    copy.set("incarnation", incarnation);
    for (const [key, value] of Object.entries(extra)) copy.set(key, value);
    return copy;
  };
  let reconciliationReady = false;
  let reconciliationFailure: string | null = null;
  const paused = (): boolean => !reconciliationReady || updateAdmissionPaused(store.raw()) || context.shouldPauseAdmission?.() === true;
  const admissionStopped = (): boolean => stopping() || paused();
  const quietContext: Context = { ...context, write: sink, json: true, shouldStop: stopping, shouldPauseAdmission: paused };

  const startedAt = Date.now();
  const deadline = runFor === null ? null : startedAt + runFor;
  let lastTick = 0;
  let lastBridge = 0;
  let lastPush = 0;
  let ticks = 0;
  let built = 0;
  let brokeCount = 0;

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // Reconciliation has its own cadence and sink. Sharing tick's sink would
  // interleave envelopes while a build awaits its provider or project check.
  const maintenance = startMaintenance({
    intervalMs: reconcileEveryMs,
    shouldStop: stopping,
    onError: error => {
      reconciliationReady = false;
      const detail = describe(error);
      if (detail !== reconciliationFailure) progress(`watch: reconciliation failed — ${detail}; new work is paused until a recovery pass succeeds`);
      reconciliationFailure = detail;
    },
    run: async () => {
      const maintenanceLines: string[] = [];
      const maintenanceContext: Context = { ...quietContext, write: line => maintenanceLines.push(line) };
      const code = await reconcileCommand(passFlags(), maintenanceContext);
      if (code !== EXIT.ok) throw new Error(maintenanceLines.join(" "));
      if (reconciliationFailure !== null) progress("watch: reconciliation recovered — new work may resume");
      reconciliationFailure = null;
      reconciliationReady = true;
      if (!stopping() && store.openedPublications().length > 0) {
        try {
          const checks = await observeChecks(store, {
            ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
          });
          if (checks.failing > 0) progress(`watch: CI is red on ${checks.failing} published PR(s) — the outbox has it`);
          const followed = await followPullRequests(store, checks.seen, {
            evidenceRoot: context.evidenceRoot,
            ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
          });
          if (followed.revisions > 0) progress(`watch: filed ${followed.revisions} CI revision(s)`);
          if (followed.merged > 0) progress(`watch: merged ${followed.merged} pull request(s) whose checks passed`);
        } catch (error) {
          progress(`watch: CI observation failed — ${describe(error)}; retrying on its next interval`);
        }
      }
    },
  });

  // Settings → Models: a quiet check of the public model lists and CLI
  // versions, only when the person turned it on. It never touches work.
  // Follow-up checks (Run checks, and the full check a pull request waits for):
  // each waiting request runs once, on its exact commit, in a fresh checkout.
  const followUpChecks = startMaintenance({
    intervalMs: 5_000,
    shouldStop: stopping,
    onError: error => progress(`watch: a follow-up check failed to run — ${describe(error)}; it is recorded on the result`),
    run: async () => {
      if (store.isDemo()) return;
      // Batch checks first: a cohort that is ready runs one check for all its results.
      const batched = await runBatchChecks(store, context.evidenceRoot, { now: context.clock, shouldStop: stopping });
      if (batched > 0) progress(`watch: settled ${batched} batch-checked result(s)`);
      const ran = await runWaitingChecks(store, context.evidenceRoot, { now: context.clock, shouldStop: stopping });
      if (ran > 0) progress(`watch: ran ${ran} follow-up check(s)`);
      // A finished check may send a build's card down its failure path: now, not on the next beat.
      if (ran + batched > 0) moveCards(store, repo, context.clock(), context.evidenceRoot);
    },
  });

  // Flows on their own cadence (flow-cadence.ts), not between builds: while builds hold every slot of this
  // project, a card whose step finished still moves within one beat. Moves run apart from triggers, replies
  // and steps, so a long check script doesn't hold them either. Neither starts a build: a card entering a
  // build zone files its task, which waits for a free slot like any other.
  const flowEveryMs = context.flowEveryMs ?? FLOW_EVERY_MS;
  const flowPool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");
  const flowGit = context.gitRunner ?? run;
  const flowsDid = (moved: number, filed: number, did: string): void => {
    if (moved + filed === 0) return;
    store.bumpWake();
    progress(`watch: ${did}`);
  };
  const flowMoves = startMaintenance({
    intervalMs: flowEveryMs,
    shouldStop: stopping,
    onError: error => progress(`watch: flow cards couldn't move — ${describe(error)}; they try again shortly`),
    run: async () => {
      if (paused()) return;
      const moved = moveCards(store, repo, context.clock(), context.evidenceRoot);
      flowsDid(moved.moved, moved.filed.length, `moved ${moved.moved} flow card(s), filed ${moved.filed.length} task(s)`);
    },
  });
  const flowSteps = startMaintenance({
    intervalMs: flowEveryMs,
    shouldStop: stopping,
    onError: error => progress(`watch: a flow pass failed — ${describe(error)}; it runs again shortly`),
    run: async () => {
      if (paused()) return;
      let base = text(flags, "base");
      if (base === undefined) {
        const head = await flowGit("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: repo });
        // A detached HEAD: the tick says so; steps wait for a branch rather than guessing one.
        if (head.code !== 0 || head.stdout.trim() === "") return;
        base = head.stdout.trim();
      }
      const pass = await flowHousekeeping(store, repo, context.clock, flowIoOf(context, flowPool, flowGit, base), admissionStopped);
      flowsDid(pass.flows.moved + pass.triggers.added + pass.steps.ran + pass.replies.taken, pass.flows.filed.length,
        `flow pass — ${pass.triggers.added} card(s) added, ${pass.replies.taken} reply(ies) taken, ${pass.steps.ran} step(s) run, ${pass.flows.moved} moved`);
    },
  });

  const modelWatch = startMaintenance({
    intervalMs: 15 * 60_000,
    shouldStop: stopping,
    onError: error => progress(`watch: the model check failed — ${describe(error)}; it retries later`),
    run: async () => { if (await modelWatchPass(store, context.clock())) progress("watch: checked models and CLI versions"); },
  });

  // Parallel builds (project-concurrency.ts): this loop is the project's
  // first build lane and keeps every housekeeping duty; extra lanes, up to
  // the project's own number (never past the worker's capacity), only
  // build — each attempt in its own checkout, each under its own claim,
  // lease and run, so reconcile, retries, the update drain and status count
  // every one. A lane over the project's fair share leaves the free slot to
  // a project building fewer, until that project has had a pass to take it.
  const passes = args.passes ?? new ProjectPasses();
  const slotFacts = (yieldingSince: number | null): SlotFacts => {
    const now = new Date();
    const found = store.getRunner(runner);
    const bound = new Set(found?.runner.repos ?? [repo]);
    const saved = savedProjectConcurrency(context.databaseFile);
    return {
      repo,
      capacity: found?.runner.capacity ?? 1,
      running: store.liveClaimCountsByRepo(runner, now),
      limitOf: one => saved.get(one) ?? PROJECT_CONCURRENCY_DEFAULT,
      waiting: new Set(store.listReady(now, runner).map(one => one.repo).filter((one): one is string => one !== null && bound.has(one))),
      yieldingSince,
      passes,
    };
  };
  const lanes: Promise<void>[] = [];
  const buildLane = async (index: number): Promise<void> => {
    const laneLines: string[] = [];
    const laneContext: Context = { ...quietContext, write: line => laneLines.push(line) };
    let yieldingSince: number | null = null;
    let yieldingTo: string | null = null;
    while (!stopping() && (deadline === null || Date.now() < deadline)) {
      const seqBefore = store.wakeSeq();
      let broke = false;
      if (!paused()) {
        const facts = slotFacts(yieldingSince);
        const answer = index < effectiveConcurrency(facts.limitOf(repo), facts.capacity) ? maySlotTake(facts) : null;
        if (answer !== null && answer.take) {
          yieldingSince = null;
          yieldingTo = null;
          laneLines.length = 0;
          let code: number = EXIT.failed;
          try {
            code = await tickCommand(passFlags({ "builds-only": "1" }), laneContext);
          } catch (error) {
            laneLines.push(JSON.stringify({ dispatched: [{ id: "?", outcome: "failed", reason: "lane", detail: describe(error) }] }));
          }
          passes.passed(repo);
          if (code === EXIT.ok) {
            built++;
            progress(`watch: build ${index + 1} did work (${new Date().toISOString()})`);
            continue;
          }
          if (code === EXIT.failed) {
            brokeCount++;
            broke = true;
            progress(`watch: build ${index + 1} — ${brokenWords(laneLines)}`);
          }
        } else if (answer !== null && !answer.take && answer.why === "fair-share") {
          if (yieldingSince === null) {
            yieldingSince = passes.stamp();
            store.bumpWake();
          }
          yieldingTo = answer.to ?? null;
        } else {
          yieldingSince = null;
          yieldingTo = null;
        }
      }
      if (!broke && store.wakeSeq() !== seqBefore) continue;
      const seqIdle = store.wakeSeq();
      const dozeUntil = Math.min(Date.now() + tickEveryMs, deadline ?? Number.MAX_SAFE_INTEGER);
      const theirTurnEnded = (): boolean => yieldingTo !== null && yieldingSince !== null && passes.lastPass(yieldingTo) > yieldingSince;
      while (!stopping() && Date.now() < dozeUntil && store.wakeSeq() === seqIdle && !theirTurnEnded()) {
        await sleep(paused() ? 250 : 50);
      }
    }
  };
  const ensureLanes = (): void => {
    const facts = slotFacts(null);
    const wanted = effectiveConcurrency(facts.limitOf(repo), facts.capacity);
    while (lanes.length + 1 < wanted && !stopping()) lanes.push(buildLane(lanes.length + 1));
  };
  let firstLaneYieldingSince: number | null = null;
  let firstLaneYieldingTo: string | null = null;

  try {
    // Startup recovery still precedes the first dispatch.
    await maintenance.runNow();
    while (!stopping() && (deadline === null || Date.now() < deadline)) {
      if (paused()) {
        await sleep(250);
        continue;
      }
      ensureLanes();
      // This lane builds only within the project's number and its fair
      // share; over either, its pass still does every housekeeping duty.
      const share = maySlotTake(slotFacts(firstLaneYieldingSince));
      const yieldBuilds = !share.take && share.why !== "capacity";
      if (!share.take && share.why === "fair-share") {
        if (firstLaneYieldingSince === null) {
          firstLaneYieldingSince = passes.stamp();
          store.bumpWake();
        }
        firstLaneYieldingTo = share.to ?? null;
      } else {
        firstLaneYieldingSince = null;
        firstLaneYieldingTo = null;
      }
      const seqBefore = store.wakeSeq();
      const now = Date.now();

      // The tick pass runs whenever the loop spins — and the loop only
      // spins when the sequence moved, a timer came due, or work just
      // finished, so this IS the schedule.
      let tickDidWork = false;
      let tickBroke = false;
      {
        lastTick = now;
        quiet.length = 0;
        store.expireOverdueDecisions(new Date());
        const code = await tickCommand(passFlags(yieldBuilds ? { "yield-builds": "1" } : {}), quietContext);
        passes.passed(repo);
        ticks++;
        if (code === EXIT.ok) {
          tickDidWork = true;
          built++;
          progress(`watch: pass ${ticks} did work (${new Date().toISOString()})`);
        } else if (code === EXIT.failed) {
          // A broken pass is NOT work (setup review): it must not re-spin
          // the loop — the next look waits for the tick cadence or a wake,
          // and the line says WHAT broke, from the pass's own envelope.
          brokeCount++;
          tickBroke = true;
          progress(`watch: pass ${ticks} — ${brokenWords(quiet)}`);
        }
      }

      // v103: seal whatever the ledger gained since the last pass into its chain (a no-op when nothing did).
      try { store.sealLedger(); } catch (error) { progress(`watch: the ledger chain could not be sealed this pass (${error instanceof Error ? error.message : String(error)})`); }

      // Built work goes out in the same window it was built: the pass is one
      // SELECT when nothing is owed, and each phase is durable if we crash.
      // Except under a stop (audit IV-1): once the signal lands, nothing
      // more is published this incarnation — the durable intent keeps the
      // work safe for the successor.
      if (!admissionStopped() && store.pendingPublications().length > 0) {
        const published = await publishPass(store, {
          repo,
          evidenceRoot: context.evidenceRoot,
          ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
        });
        if (published.pushed + published.opened + published.adopted + published.failed > 0) {
          progress(
            `watch: published — pushed ${published.pushed}, opened ${published.opened}, adopted ${published.adopted}` +
              (published.failed > 0 ? `, gave up on ${published.failed}` : ""),
          );
        }
      }

      // Push rides its OWN cadence, whether or not Telegram holds the wire
      // (arc 3 finding 8): the pair ledger's claims fence concurrent loops.
      if (now - lastPush >= 45_000) {
        lastPush = now;
        try {
          await pushPass(context.store, { configDir: dirname(context.databaseFile), clock: () => new Date() });
        } catch {
          // Push is additive; a broken pass never stops the watch.
        }
      }

      // The embedded follower owns the wire while it lives; the timer-driven
      // pass is the fallback shape for a watch started before a token existed.
      if (follower === null && now - lastBridge >= bridgeEveryMs) {
        lastBridge = now;
        const source = serviceBridge ? null : loadBotToken(process.env, context.telegramTokenFile);
        const dir = dirname(context.databaseFile);
        // Exactly ONE service carries the pages — the chosen primary, or
        // the sensible implicit one. Telegram keeps draining taps and
        // replies even when another service is primary: answering is its
        // job whether or not paging is.
        const primary = effectivePrimary(process.env, dir, source !== null);
        if (source !== null) {
          quiet.length = 0;
          await bridgeCommand(
            ["telegram"],
            passFlags(primary.channel === "telegram" ? {} : { "inbound-only": "1" }),
            quietContext,
          );
        }
        if (primary.channel !== null && primary.channel !== "telegram") {
          const targets = loadWebhookTargets(process.env, dir).filter(one => one.kind === primary.channel && (one.kind !== "slack" || loadSlackCredentials(dir) === null) && (one.kind !== "discord" || loadDiscordCredentials(dir) === null));
          if (targets.length > 0) {
            await webhookPass(store, { targets, consoleUrl: loadConsoleUrl(process.env, dir), clock: context.clock });
          }
        }
      }

      // Work-conserving: if the world moved while we worked — or we just
      // finished something that may have freed a dependent — go again now.
      // A BROKEN pass moves the sequence itself (it claimed and handed back)
      // and must not count as the world moving, or the loop spins on its own
      // failure without a pause (2026-09-04: 331,000 passes on one dirty
      // checkout). The next look waits for the cadence or a real wake.
      if (tickDidWork || (!tickBroke && store.wakeSeq() !== seqBefore)) continue;

      // Idle: doze in short steps until the sequence moves, a timer comes
      // due, a signal lands, or the trial window (--for) ends. Reading one
      // integer from SQLite twice a second is the entire idle cost — no
      // token has anywhere to be spent from here.
      const idleUntil =
        Math.min(
          lastTick + tickEveryMs,
          lastBridge + bridgeEveryMs,
          deadline ?? Number.MAX_SAFE_INTEGER,
        ) - Date.now();
      // Doze for the WHOLE idle window, waking early only for a signal or a
      // sequence move — not for one 500ms step and then another pass
      // (2026-09-05: that read as two ticks a second, all night, with
      // nothing to do). The 50ms poll is what keeps a stop prompt.
      const seqIdle = store.wakeSeq();
      const dozeUntil = Date.now() + Math.max(idleUntil, 0);
      const theirTurnEnded = (): boolean =>
        firstLaneYieldingTo !== null && firstLaneYieldingSince !== null && passes.lastPass(firstLaneYieldingTo) > firstLaneYieldingSince;
      while (!stopping() && Date.now() < dozeUntil && store.wakeSeq() === seqIdle && !theirTurnEnded()) {
        await sleep(50);
      }
    }
  } finally {
    // Every build lane finishes or hands its attempt back before the
    // loop's lease and episode end.
    await Promise.all(lanes);
    await maintenance.stop();
    await followUpChecks.stop();
    await flowMoves.stop();
    await flowSteps.stop();
    await modelWatch.stop();
    clearInterval(heartbeat);
    followController.abort();
    if (follower !== null) await follower;
    await slackFollower;
    await teamsFollower;
    await discordFollower;
    store.endWatchEpisode(incarnation, { ticks, built, broke: brokeCount }, new Date());
    store.releaseWatchLease(runner, repo, incarnation, new Date());
  }

  if (leaseLost) {
    return { ok: false, reason: "lease-lost", detail: `the watch lease for ${runner} on ${repo} stopped renewing — another process may have taken this worker over`, ticks, built, broke: brokeCount };
  }
  if (reconciliationFailure !== null) {
    return { ok: false, reason: "reconciliation-failed", detail: reconciliationFailure, ticks, built, broke: brokeCount };
  }
  return { ok: true, ticks, built, broke: brokeCount, incarnation };
}

/** The failed and skipped entries of a quiet tick, as one line. */
function brokenWords(lines: readonly string[]): string {
  try {
    const envelope = JSON.parse(lines[lines.length - 1] ?? "") as { dispatched?: { id: string; outcome: string; reason?: string; detail?: string }[] };
    const failed = (envelope.dispatched ?? []).filter(one => one.outcome === "failed");
    if (failed.length === 0) return "a pass broke something — the run records have it";
    const named = failed.slice(0, 3).map(one => `${one.id} failed (${one.reason ?? "?"}${one.detail === undefined ? "" : `: ${one.detail}`})`);
    return `${named.join("; ")}${failed.length > 3 ? `; and ${failed.length - 3} more` : ""}`;
  } catch {
    return "a pass broke something — the run records have it";
  }
}

async function watchCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const demoFence = refuseDemo(context, "watch");
  if (demoFence !== null) return demoFence;
  const runner = text(flags, "runner");
  const token = text(flags, "token") ?? readTokenFile(text(flags, "token-file"));
  if (runner === undefined || token === undefined) {
    return fail(write, json, "watch", "usage", "`toolroll watch --runner <name> --token <t>|--token-file <path> --repo <path> [--for <ms>]`", EXIT.usage);
  }
  // Passes built from these flags authenticate with the resolved token.
  flags.set("token", token);
  const auth = authenticate(store, runner, token);
  if (!auth.ok) {
    return fail(write, json, "watch", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }
  const repo = repoFrom(flags);

  // The envelope contract holds for long commands too (Codex M5-M8 audit,
  // C-1): in --json mode every progress line goes to stderr, and stdout
  // receives exactly the final envelope.
  const progress = (line: string): void => {
    // v99: with TOOLROLL_LOG_FORMAT=json, each line is one JSON event on stderr for a log shipper.
    if (envValue(process.env, "LOG_FORMAT") === "json") return logEvent(/\b(fail|failed|died|stopped|error|red)\b/i.test(line) ? "warn" : "info", "worker", { message: line });
    if (json) process.stderr.write(`${line}\n`);
    else write(line);
  };

  // The historical signal shell, wrapped around the extracted loop: first
  // signal stops admission and starts the grace clock; the second — or the
  // clock — SIGKILLs every live provider group (M6.12).
  let stopping = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let followAbort: AbortController | null = null;
  const stopGraceMs = Number(text(flags, "stop-grace") ?? 30_000);
  const hardStop = () => {
    const terminated = terminateLiveProviders();
    if (terminated > 0) {
      progress(`Hard stop: ${terminated} provider process group(s) terminated. Their work is saved and kept in each checkout, and each task resumes from it when the builder runs again; fences keep late output out of every commit.`);
    }
  };
  const stop = () => {
    if (stopping) {
      hardStop();
      return;
    }
    stopping = true;
    followAbort?.abort();
    graceTimer = setTimeout(hardStop, stopGraceMs);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const startedAt = Date.now();
  let result: WatchLoopResult;
  try {
    result = await runWatchLoop({
      flags,
      context,
      runner,
      token,
      repo,
      progress,
      // An injected fence (tests) stops admission exactly as a signal does.
      isStopping: () => stopping || context.shouldStop?.() === true,
      onFollowController: controller => {
        followAbort = controller;
      },
    });
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }

  if (!result.ok) {
    return fail(write, json, "watch", result.reason, result.detail, result.reason === "reconciliation-failed" || result.reason === "loop-failed" ? EXIT.failed : EXIT.refused, {
      ticks: result.ticks,
      built: result.built,
      broke: result.broke,
    });
  }
  return succeed(write, json, "watch", { ticks: result.ticks, built: result.built, broke: result.broke, incarnation: result.incarnation }, () => [
    `Watched ${repo} for ${Math.round((Date.now() - startedAt) / 1000)}s: ${result.ticks} pass(es), ${result.built} with work, ${result.broke} broke.`,
    "The lease is handed back; cron or the next watch may take it.",
  ]);
}

// ---- one command to a working cockpit (arc 2) ------------------------------

/**
 * `toolroll up` — cold start to an open, working cockpit.
 *
 * COMPOSITION ONLY: identities mint through the atomic doors (a first
 * approver only while none exists; a runner only while its name is idle),
 * then the extracted console and one watch loop per repository run in this
 * one process, under one supervisor, over one shared store. Nothing here
 * loosens a ceremony: approval, budgets, publication, and every fence work
 * exactly as they do for the long-hand verbs.
 */
const UP_LOGIN_FILE = "up-login.txt";

/** Durably create the login file BEFORE the bootstrap commits (arc 2
 * finding 27): exclusive, 0600, fsynced — file and directory both — so the
 * row only ever follows a durable secret. Throws on any failure. */
export function writeLoginFileDurably(path: string, name: string, password: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeSync(fd, `${name} ${password}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(dirname(path), fsConstants.O_RDONLY);
  try {
    fsyncSync(dir);
  } catch {
    // Some filesystems refuse directory fsync; the file's own fsync stands.
  } finally {
    closeSync(dir);
  }
}

function readLoginFile(path: string): { name: string; password: string } | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const cut = raw.indexOf(" ");
    if (cut <= 0) return null;
    const name = raw.slice(0, cut);
    const password = raw.slice(cut + 1);
    if (name === "" || password === "") return null;
    return { name, password };
  } catch {
    return null;
  }
}

type UpApprover = {
  approver: string | null;
  approvers: string[];
  verified: boolean;
  passwordFile: string | null;
  /** The password to print once — set ONLY when this run minted it. */
  mintedPassword: string | null;
  notes: string[];
};

/** The approver decision tree (arc 2 findings 8/21/29/32), exhaustively. */
async function resolveUpApprover(
  context: Context,
  flags: Map<string, string | true>,
  canPrompt: boolean,
): Promise<UpApprover | { refusal: string }> {
  const { store, clock } = context;
  const loginFile = join(dirname(context.databaseFile), UP_LOGIN_FILE);
  const asFlag = text(flags, "as");
  const notes: string[] = [];

  let names = store.listApprovers().map(one => one.name);
  if (names.length === 0) {
    // Adoption first (finding 27/32): an orphan file from a crashed
    // bootstrap is a valid intent — and never OURS to unlink.
    const orphan = readLoginFile(loginFile);
    if (orphan !== null) {
      const adopted = store.bootstrapApproverIfNone(orphan.name, hashApproverToken(orphan.password), clock());
      if (adopted.ok) {
        notes.push(`adopted the login from ${UP_LOGIN_FILE} — a previous start was interrupted before it finished`);
        return { approver: orphan.name, approvers: [orphan.name], verified: true, passwordFile: loginFile, mintedPassword: null, notes };
      }
      names = store.listApprovers().map(one => one.name); // a winner appeared; fall through
    } else {
      // Mint: the FILE is the durable intent, written and fsynced before
      // the insert (finding 27). A refused insert unlinks only when an
      // UNRELATED approver won (finding 32).
      const name = asFlag ?? process.env["USER"] ?? process.env["USERNAME"] ?? "operator";
      const password = randomBytes(12).toString("base64url");
      try {
        writeLoginFileDurably(loginFile, name, password);
      } catch (error) {
        return {
          refusal: `could not create ${UP_LOGIN_FILE} beside the database (${describe(error)}) — if a file is already there, another \`up\` may be starting; wait a moment, your login will be in it`,
        };
      }
      const made = store.bootstrapApproverIfNone(name, hashApproverToken(password), clock());
      if (made.ok) {
        return { approver: name, approvers: [name], verified: true, passwordFile: loginFile, mintedPassword: password, notes };
      }
      // Lost the race. Keep the file if the winner IS our identity (an
      // adopter beat us to our own file); otherwise it is ours to remove.
      if (authenticateApprover(store, name, password).ok) {
        return { approver: name, approvers: store.listApprovers().map(one => one.name), verified: true, passwordFile: loginFile, mintedPassword: null, notes };
      }
      try {
        unlinkSync(loginFile);
      } catch {
        // already gone
      }
      names = store.listApprovers().map(one => one.name);
    }
  }

  // Approvers exist. The stale-or-current file is advertised only when it
  // still authenticates (finding 32).
  let fileLogin: { name: string; password: string } | null = null;
  const present = readLoginFile(loginFile);
  if (present !== null) {
    if (authenticateApprover(store, present.name, present.password).ok) {
      fileLogin = present;
    } else {
      notes.push(`${UP_LOGIN_FILE} no longer matches any login — it is stale; your current password is the one you know`);
    }
  }

  let selected: string | null = null;
  if (asFlag !== undefined) {
    if (!names.includes(asFlag)) {
      return { refusal: `no approver named \`${asFlag}\` — known: ${names.join(", ")}` };
    }
    selected = asFlag;
  } else if (names.length === 1) {
    selected = names[0] as string;
  }

  let verified = false;
  let passwordFile: string | null = null;
  if (selected !== null && fileLogin !== null && fileLogin.name === selected) {
    verified = true;
    passwordFile = loginFile;
  } else if (selected !== null && canPrompt) {
    const { askHidden } = await import("./prompt.js");
    let remembered: string | null = null;
    for (let attempt = 1; attempt <= 3 && !verified; attempt += 1) {
      const typed = await askHidden(`password for ${selected} (${attempt}/3): `);
      if (typed !== "" && authenticateApprover(store, selected, typed).ok) {
        verified = true;
        remembered = typed;
      }
    }
    // Ask once, ever (install review): a login `up` just verified is
    // written beside the database exactly as a fresh install's would have
    // been — 0600, durable, this machine only — so the next start needs
    // nothing typed. An account that predates `up` joins the same road.
    if (verified && remembered !== null && readLoginFile(loginFile) === null) {
      try {
        writeLoginFileDurably(loginFile, selected, remembered);
        passwordFile = loginFile;
        notes.push(`remembered your login on this machine in ${UP_LOGIN_FILE} (owner-only) — the next \`up\` asks for nothing`);
      } catch {
        notes.push(`could not save your login beside the database — the next \`up\` will ask again`);
      }
    }
    if (!verified) {
      notes.push(
        `could not verify ${selected}'s password — the console will still ask at login. If it is lost: another approver can add you (\`approver add\`), or restore the database/${UP_LOGIN_FILE}.`,
      );
    }
  }
  return { approver: selected, approvers: names, verified, passwordFile, mintedPassword: null, notes };
}

/** The platform browser opener — detached, silent, never load-bearing. */
function openBrowser(url: string): void {
  // TOOLROLL_BROWSER_COMMAND names another program to open it with (it gets the address as its one argument).
  const chosen = envValue(process.env, "BROWSER_COMMAND");
  const command =
    chosen !== undefined && chosen !== "" ? [chosen, url]
    : process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    const child = spawnChild(command[0] as string, command.slice(1), { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // A browser that will not open is a URL the greeting already printed.
  }
}

/** Where `up` last served its console, kept beside the database so `onboard` names the same address. */
const UP_CONSOLE_FILE = "up-console.json";

function recordUpConsoleUrl(dir: string, url: string, now: Date): void {
  try {
    const file = join(dir, UP_CONSOLE_FILE), temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ url, at: now.toISOString() })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // A display fact: a failed write only leaves onboard on the default port.
  }
}

export function readUpConsoleUrl(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, UP_CONSOLE_FILE), "utf8")) as { url?: unknown };
    return typeof parsed.url === "string" && /^https?:\/\/[^\s]+$/.test(parsed.url) ? parsed.url.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** How onboard says to sign in: the saved login file only while it still works (as `up` advertises it), else the
 * account and its password; null only when there is no account yet. Never the password itself. */
function onboardLogin(store: Store, loginFile: string): HandoffLogin | null {
  const names = store.listApprovers().map(one => one.name);
  const saved = readLoginFile(loginFile);
  if (names.length === 0) return saved === null ? null : { account: saved.name, file: loginFile }; // the next `up` adopts it
  if (saved !== null && authenticateApprover(store, saved.name, saved.password).ok) return { account: saved.name, file: loginFile };
  return { account: names.length === 1 ? (names[0] as string) : null, file: null };
}

/**
 * `onboard`: the agent that installed Toolroll becomes its lead. The work
 * lives in agent-onboard.ts; this wires it to the installation: the same
 * registry and project row Projects → add writes, and the same sign-in
 * checks Settings → AI providers makes.
 */
async function onboardCommand(flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json, clock } = context;
  const seams = context.onboardSeams ?? {};
  const portGiven = text(flags, "port");
  const port = Number(portGiven ?? 4180);
  if (portGiven !== undefined && (!Number.isInteger(port) || port < 1 || port >= 65536)) {
    return fail(write, json, "onboard", "usage", "--port is a whole number under 65536", EXIT.usage);
  }
  // The console where `up` last served, unless --port says otherwise.
  const served = portGiven === undefined ? readUpConsoleUrl(dirname(context.databaseFile)) : null;
  const home = seams.home ?? homedir();
  const env = seams.env ?? process.env;
  const loginFile = join(dirname(context.databaseFile), UP_LOGIN_FILE);
  const gitRun = context.gitRunner ?? ((file: string, args: readonly string[], opts?: { cwd?: string }) => run(file, [...args], { ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }), timeoutMs: 10_000 }));
  const registryPath = registryPathOf(context);
  const checker = createConnectionChecker({ home, env });
  const code = await runOnboard({
    write,
    json,
    yes: flag(flags, "yes"),
    remove: flag(flags, "remove"),
    agentFlag: text(flags, "agent"),
    url: served ?? `http://127.0.0.1:${port}`,
    login: onboardLogin(store, loginFile),
    home,
    worktrees: join(dirname(context.databaseFile), "worktrees"),
    env,
    version: PACKAGE_VERSION,
    cwd: seams.cwd ?? process.cwd(),
    // An agent's shell may be a terminal, but nobody answers y/N there.
    interactive: seams.interactive ?? (interactive() && !underAgent(env)),
    confirm: seams.confirm ?? (async question => /^y(es)?$/i.test(await ask(`${question} `))),
    findRepo: seams.findRepo ?? (async cwd => {
      const top = await gitRun("git", ["rev-parse", "--show-toplevel"], { cwd });
      const topPath = top.code === 0 ? canonicalProject(top.stdout.trim()) : null;
      if (topPath === null) return null;
      // A linked worktree's project is its main checkout: the folder whose .git is the common one.
      const common = await gitRun("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
      const commonDir = common.code === 0 ? common.stdout.trim() : "";
      const main = basename(commonDir) === ".git" ? canonicalProject(dirname(commonDir)) : null;
      return { top: topPath, main: main ?? topPath };
    }),
    enrolled: async repo => {
      const registry = await loadProjectRegistry(registryPath);
      return !("error" in registry) && registry.repos.includes(repo);
    },
    enroll: async repo => {
      // The same admission as `repos add` and the console's Add a project.
      const actor = commandLineActor(store, { databaseFile: context.databaseFile });
      if ("ok" in actor) return { ok: false, message: actor.message };
      const before = await loadProjectRegistry(registryPath);
      const admitted = await admitProject(store, { registryFile: registryPath, path: repo, actor, now: clock() });
      if (!admitted.ok) return { ok: false, message: admitted.message };
      return { ok: true, added: "error" in before || !before.repos.includes(admitted.repo) };
    },
    checkConnection: seams.checkConnection ?? (agent => checker(agent)),
    pullRequests: seams.pullRequests ?? (async repo => {
      const publishing = publishingOf(store, repo);
      if (publishing.on) return `on for ${publishing.githubRepo} into ${publishing.base}`;
      const checked = await checkPublishing(repo, context.publishExec === undefined ? {} : { exec: context.publishExec });
      if (!checked.ok) return `off: ${checked.message}`;
      return `off: turn on with toolroll publish setup --repo ${repo} --yes (asks your password), or in Settings → Projects`;
    }),
    starterFlag: text(flags, "starter"),
    // Starter flows belong to a person: the flow's decisions ask them. With no account yet, none can be switched on.
    starters: {
      list: async repo => {
        const views = startersFor(store, repo);
        return store.listApprovers().length > 0 ? views : views.map(one => ({ ...one, blocked: one.blocked ?? "Needs your account first: run toolroll up, then onboard again." }));
      },
      switchOn: async (repo, id) => {
        const owner = onboardLogin(store, loginFile)?.account ?? store.listApprovers()[0]?.name ?? null;
        const starter = starterOf(id);
        if (owner === null || starter === null) return { ok: false, said: "Needs your account first: run toolroll up, then onboard again." };
        return switchOnStarter(store, starter, repo, owner, clock(), dirname(context.databaseFile));
      },
    },
  });
  // One line when an integration is Broken, from the last checks only (never a new check here).
  if (!json) {
    const line = integrationsBrokenLine(await savedIntegrations(context).catch(() => []));
    if (line !== null) write(line);
  }
  return code;
}

async function upCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const demoFence = refuseDemo(context, "up");
  if (demoFence !== null) return demoFence;

  // 1. Validation, before anything at all.
  const portGiven = text(flags, "port");
  const port = Number(portGiven ?? 4180);
  if (portGiven !== undefined && (!Number.isInteger(port) || port < 1 || port >= 65536)) {
    return fail(write, json, "up", "usage", "--port is a whole number under 65536", EXIT.usage);
  }
  const editorGiven = text(flags, "editor");
  if (editorGiven !== undefined && editorGiven !== "vscode") {
    return fail(write, json, "up", "usage", "--editor supports: vscode", EXIT.usage);
  }
  const forGiven = text(flags, "for");
  if (forGiven !== undefined && (!Number.isInteger(Number(forGiven)) || Number(forGiven) <= 0)) {
    return fail(write, json, "up", "usage", "--for takes a positive whole number of milliseconds", EXIT.usage);
  }
  const capacityGiven = text(flags, "capacity");
  const capacityFlag = capacityGiven === undefined ? null : parseRunnerCapacity(capacityGiven);
  if (capacityGiven !== undefined && capacityFlag === null) {
    return fail(write, json, "up", "usage", `--capacity is a whole number of tasks, 1 to ${RUNNER_CAPACITY_MAX}`, EXIT.usage);
  }
  const runnerFlag = text(flags, "runner");
  if (runnerFlag !== undefined && !validRunnerName(runnerFlag)) {
    return fail(write, json, "up", "usage", `a worker name is 1–${RUNNER_NAME_MAX} characters with no control characters`, EXIT.usage);
  }
  // --host / --allow-host (setup review): `up` reaches a phone over a
  // tailnet exactly as `serve` does, so one process is the whole install.
  const hostFlag = text(flags, "host") ?? "127.0.0.1";
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(hostFlag)) {
    return fail(write, json, "up", "usage", "--host is an address or a name", EXIT.usage);
  }
  const allowFlag = text(flags, "allow-host");

  const progress = (line: string): void => {
    // v99: with TOOLROLL_LOG_FORMAT=json, each line is one JSON event on stderr for a log shipper.
    if (envValue(process.env, "LOG_FORMAT") === "json") return logEvent(/\b(fail|failed|died|stopped|error|red)\b/i.test(line) ? "warn" : "info", "worker", { message: line });
    if (json) process.stderr.write(`${line}\n`);
    else write(line);
  };

  // 2. Load the machine's durable project registry. Repositories and the
  // folders they may be added from are installation state, not arguments a
  // person must repeat on every start.
  const registryPath = registryPathOf(context);
  const loadedRegistry = await loadProjectRegistry(registryPath);
  if ("error" in loadedRegistry) {
    return fail(write, json, "up", "registry", loadedRegistry.error, EXIT.refused);
  }
  let sweptHeldOrphans = false;
  const gitRun = context.gitRunner ?? ((file: string, args: readonly string[], opts?: { cwd?: string }) => run(file, [...args], { ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }), timeoutMs: 10_000 }));

  const rootInputs = (text(flags, "project-root") ?? "")
    .split(",")
    .map(one => one.trim())
    .filter(one => one !== "");
  const explicitRoots: string[] = [];
  for (const input of rootInputs) {
    const canonical = canonicalProject(input);
    if (canonical === null) {
      return fail(write, json, "up", "project-root", `${input} is not a directory this machine can use`, EXIT.refused);
    }
    if (!explicitRoots.includes(canonical)) explicitRoots.push(canonical);
  }
  const projectRoots = [...resolveCeiling([], addRepos(loadedRegistry.roots, explicitRoots)).ceiling.roots];

  // Every saved repository reconnects automatically. Explicit --repo paths
  // still work for first use; with none, a Git working directory joins the
  // saved list for backwards compatibility. Starting elsewhere is valid as
  // soon as a projects folder or saved repository exists.
  const repos: string[] = [];
  const proveRepo = async (input: string): Promise<string | null> => {
    const top = await gitRun("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(input) });
    if (top.code !== 0) return null;
    try {
      return realpathSync(top.stdout.trim());
    } catch {
      return null;
    }
  };
  for (const input of loadedRegistry.repos) {
    const root = await proveRepo(input);
    if (root === null) {
      progress(`saved project unavailable — skipped ${input}`);
    } else if (!repos.includes(root)) {
      repos.push(root);
    }
  }
  const explicitRepos = context.repoList ?? [];
  // Repositories this start was told to serve stay served while it runs: removing one from the saved list takes
  // effect at the next start, never under the process that was pinned to it.
  const pinnedRepos = new Set<string>();
  if (explicitRepos.length > 0) {
    for (const input of explicitRepos) {
      const root = await proveRepo(input);
      if (root === null) {
        return fail(
          write,
          json,
          "up",
          "not-a-repository",
          `${input} is not inside a git repository — choose a repository, set a projects folder once with \`--project-root <dir>\`, or try the sandbox with \`toolroll demo\``,
          EXIT.refused,
        );
      }
      if (!repos.includes(root)) repos.push(root);
      pinnedRepos.add(root);
    }
  } else if (context.inferProjectFromCwd !== false) {
    const cwdRepo = await proveRepo(process.cwd());
    if (cwdRepo !== null && !repos.includes(cwdRepo)) repos.push(cwdRepo);
    if (cwdRepo !== null) pinnedRepos.add(cwdRepo);
  }
  if (repos.length === 0 && projectRoots.length === 0) {
    return fail(
      write,
      json,
      "up",
      "no-projects",
      "choose where your projects live once: `toolroll up --project-root <dir>`",
      EXIT.refused,
    );
  }
  // A person at a terminal reads three lines (onboarding); the folders are for --verbose, a service log, or an agent.
  const quietStart = !json && !flags.has("verbose") && (context.upSeams?.terminal ?? process.stdout.isTTY === true) && !underAgent(context.upSeams?.env ?? process.env);
  if (!quietStart) {
    for (const repo of repos) progress(`repository  ${repo}`);
    for (const root of projectRoots) progress(`projects    ${root}`);
  }

  // 3. Reserve the port BEFORE any identity or enrollment mutation
  // (finding 7/19): a busy port must refuse while the world is untouched.
  const probe = createNetServer();
  const reserved = await new Promise<boolean>(resolveProbe => {
    probe.once("error", () => resolveProbe(false));
    probe.listen(port, "127.0.0.1", () => resolveProbe(true));
  });
  if (!reserved) {
    return fail(
      write,
      json,
      "up",
      "port-busy",
      `port ${port} is taken — another \`up\` or \`serve\` may already be running; stop it, or pick a different --port`,
      EXIT.refused,
    );
  }

  // Under a coding agent nothing is asked and no secret is printed, even in a real terminal: what is shown lands in
  // its transcript.
  const agentRunning = underAgent(context.upSeams?.env ?? process.env);
  const canPrompt = !json && !agentRunning && process.stdin.isTTY === true && process.stdout.isTTY === true;
  let runnerName = "";
  let runnerToken = "";
  let approver: UpApprover | null = null;
  try {
    // 4. The approver (findings 2/8/17/21/27/29/32).
    const approverPlan = await resolveUpApprover(context, flags, canPrompt);
    if ("refusal" in approverPlan) {
      return fail(write, json, "up", "login", approverPlan.refusal, EXIT.refused);
    }
    approver = approverPlan;
    for (const note of approverPlan.notes) progress(note);

    // The verified gate (MCP spec v6, Codex round-3 finding 2): minting or
    // recovering runner authority on an UNVERIFIED operator identity was a
    // registration road around the ceremony. No verified password, no
    // runner — the login file or another approver restores the road.
    if (!approverPlan.verified) {
      return fail(
        write,
        json,
        "up",
        "login",
        `${approverPlan.approver}'s password could not be verified — a runner only registers under a proven operator. Type it correctly, restore ${UP_LOGIN_FILE}, or have another approver re-add you.`,
        EXIT.refused,
      );
    }

    // 5. The runner, through the atomic door (findings 1/16/26/31), with
    // the suffix budget (finding 24) for generated names only.
    const base = runnerFlag ?? normalizeRunnerName(hostname());
    let doorAnswer: ReturnType<typeof registerRunnerIfIdle> | null = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const name = attempt === 1 ? base : `${base.slice(0, RUNNER_NAME_MAX - suffix.length)}${suffix}`;
      // The held orphan fence runs BEFORE any recovery road (v6 W6): a
      // crashed predecessor's held session is seized, killed through its
      // supervisor, and settled — or paged — before registration's
      // recovery may touch its run or worktree.
      if (!sweptHeldOrphans) {
        sweptHeldOrphans = true;
        const swept = await sweepHeldOrphans(store, `up:${hostname()}:${process.pid}`, clock);
        if (swept.fenced > 0) progress(`fenced ${swept.fenced} orphaned held session(s) from a previous up`);
        if (swept.paged > 0) progress(`${swept.paged} held session(s) could not be stopped — see the inbox`);
      }
      // The runner's authority is BOUND to the canonical roots this up
      // serves (MCP spec v6): the claim gate enforces membership, so an
      // unbound registration would deny-all its own dispatches.
      const answer = registerRunnerIfIdle(store, { name, host: hostname(), repos, now: clock() });
      if (answer.ok) {
        runnerName = name;
        runnerToken = answer.token;
        if (answer.recoveredRuns > 0) progress(`recovered ${answer.recoveredRuns} interrupted attempt(s) left by the previous ${name}`);
        doorAnswer = answer;
        break;
      }
      doorAnswer = answer;
      if (runnerFlag !== undefined) break; // an explicit name is never suffixed around
    }
    if (runnerName === "") {
      const detail = doorAnswer !== null && !doorAnswer.ok ? doorAnswer.detail : "no worker name could be taken";
      return fail(
        write,
        json,
        "up",
        "runner-alive",
        `${detail} — that worker looks alive; stop the other \`up\` or watch, or name a different worker with --runner`,
        EXIT.refused,
      );
    }

    // 6. Enrollment: repositories and project roots are one atomic machine
    // registry. A later `up` reconnects all of them without cwd or flags.
    {
      // The locked registry primitive (onboarding findings 9/17/25): a
      // refusal here also retires the runner this start just registered —
      // never today's silent empty-registry fallback.
      const enrolled = await updateProjectRegistry(registryPath, current => ({
        repos: addRepos(current.repos, repos),
        roots: addRepos(current.roots, projectRoots),
      }));
      if (!enrolled.ok) {
        retireRunnerIfCurrent(store, runnerName, runnerToken, clock());
        return fail(write, json, "up", "registry", `${enrolled.message} — nothing started`, EXIT.refused);
      }
    }

    // --capacity: the built-in worker's own number, set under the verified
    // login and kept in the ledger. Without it a restart keeps the last one.
    if (capacityFlag !== null) {
      const changed = store.setRunnerCapacity(runnerName, capacityFlag, approverPlan.approver ?? "operator", clock());
      if (changed.ok && changed.before !== changed.after) progress(`${runnerName} now runs up to ${changed.after} task(s) at once (was ${changed.before})`);
    }
  } finally {
    await new Promise<void>(done => probe.close(() => done()));
  }

  // 6b. The held-session coordinator (Phase 2): one per up process, shared
  // by the console and every watch loop through the context. Its socket
  // directory is deliberately SHORT and flat — sun_path is unforgiving.
  const heldDir = namedPath(homedir(), ["held"], { dot: true });
  try {
    mkdirSync(heldDir, { recursive: true, mode: 0o700 });
  } catch {
    // The launch's own path check refuses with words if this failed.
  }
  context.heldCoordinator = new HeldSessionCoordinator();
  context.upIncarnation = randomUUID();
  context.heldSocketDir = heldDir;
  // v28: sessions are unbounded unless the operator caps them.
  const heldCap = text(flags, "max-held-sessions");
  if (heldCap !== undefined) {
    const cap = Number(heldCap);
    if (!Number.isInteger(cap) || cap < 1) {
      return fail(write, json, "up", "usage", "--max-held-sessions is a whole number of concurrent attended sessions, at least 1", EXIT.usage);
    }
    context.maxHeldSessions = cap;
  }

  // 7. The console, on the just-released port. The tiny window between the
  // probe closing and this bind can lose a race; that failure tears down
  // cleanly below instead of leaving identities half-claimed silently.
  const pool = join(dirname(context.databaseFile), "worktrees");
  // Mutated only by the registry supervisor below. The console reads this
  // proved set on each request, so its project rail and unified chat move
  // with the live builder instead of freezing at process start.
  const activeRepos = new Set<string>(repos);
  let console_: Awaited<ReturnType<typeof startConsole>>;
  try {
    console_ = await startConsole({
      context,
      host: hostFlag,
      port,
      ...(allowFlag === undefined ? {} : { allowedHosts: allowFlag.split(",").map(one => one.trim()).filter(one => one !== "") }),
      localRunner: runnerName,
      poolRoot: pool,
      repos,
      currentRepos: () => [...activeRepos],
      admittedRepos: () => [...activeRepos],
      upConsole: true,
      attended: {
        runner: runnerName,
        coordinator: context.heldCoordinator,
        headOf: async (repo: string) => {
          const answer = await gitRun("git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: repo });
          return answer.code === 0 ? answer.stdout.trim() : null;
        },
      },
      registryPath,
      projectRoots,
      ...(text(flags, "public-url") === undefined ? {} : { publicUrl: text(flags, "public-url") as string }),
      ...(text(flags, "editor") === undefined ? {} : { editorLinks: "vscode" as const }),
    });
  } catch (error) {
    retireRunnerIfCurrent(store, runnerName, runnerToken, clock());
    return fail(write, json, "up", "port-busy", `${describe(error)} — the port was taken while starting; try again`, EXIT.refused);
  }

  // 8. The project supervisor: one watch loop per proved repository, plus a
  // tiny registry poll that can add more while this process stays up. The
  // poll is deliberately plain filesystem I/O (portable across macOS,
  // Linux, and Windows) and never invokes an agent while nothing changed.
  let stopping = false;
  let fatal: string | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  const followControllers: AbortController[] = [];
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>(resolveStop => (resolveStopped = resolveStop));
  const stopGraceMs = Number(text(flags, "stop-grace") ?? 30_000);
  const hardStop = () => {
    const terminated = terminateLiveProviders();
    if (terminated > 0) progress(`Stopped ${terminated} running build(s). Their work is saved, and each resumes when the builder starts again.`);
  };
  const stop = () => {
    if (stopping) {
      hardStop();
      return;
    }
    stopping = true;
    resolveStopped();
    for (const controller of followControllers) controller.abort();
    // The coding owner record is released first, whatever else is still
    // finishing: launchd kills a service that outlasts its exit window, and a
    // killed process cannot release it. Its outcome is read again at close.
    console_.server.closeCoding().catch(() => {});
    const building = store.liveClaimCount(runnerName, clock());
    if (building > 0) {
      progress(`Stopping: ${building} build(s) running. Waiting up to ${Math.round(stopGraceMs / 1000)}s for them to finish; any still running then is saved and resumes when the builder starts again.`);
    }
    graceTimer = setTimeout(hardStop, stopGraceMs);
    graceTimer.unref?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (forGiven !== undefined) {
    runTimer = setTimeout(stop, Number(forGiven));
    runTimer.unref?.();
  }

  const loopFlagsFor = (repo: string): Map<string, string | true> => {
    const copy = new Map<string, string | true>();
    copy.set("runner", runnerName);
    copy.set("token", runnerToken);
    copy.set("repo", repo);
    copy.set("pool", pool);
    // The co-hosted console's stated origin rides into each loop's follower:
    // a phone link must name THIS console, or not exist.
    const publicUrl = text(flags, "public-url");
    if (publicUrl !== undefined) copy.set("public-url", publicUrl);
    return copy;
  };
  const prefix = (repo: string): string => (activeRepos.size > 1 ? `[${projectName(repo)}] ` : "");
  // Containment at start: one plain sentence, once, for a person at a
  // terminal; the exact status line with --verbose, in a service log (no
  // terminal), and always when a required policy will refuse spawns.
  const containmentDetail = flags.has("verbose") || !(context.upSeams?.terminal ?? process.stdout.isTTY === true);
  let containmentSaid = false;
  const containmentLines = (effective: EffectiveContainment): string[] => {
    const notice = containmentNotice(effective);
    if (notice !== null && !containmentSaid) progress(notice);
    containmentSaid = true;
    return containmentDetail || effective.refusal !== null ? [`watch: ${describeContainment(effective)}`] : [];
  };
  const loopResults = new Map<string, Promise<{ repo: string; result: WatchLoopResult }>>();
  // One record of project passes for the whole service: fair scheduling
  // across its projects (project-concurrency.ts).
  const projectPasses = new ProjectPasses();
  // Projects removed while running: each one's watch stops admitting work, finishes what it holds, then lets go.
  const releasedRepos = new Set<string>();

  const launchRepo = async (repo: string, bind: boolean): Promise<void> => {
    if (loopResults.has(repo) || stopping) return;
    if (bind) {
      const bound = addRunnerReposAuthed(store, { name: runnerName, token: runnerToken, repos: [repo] }, clock());
      if (!bound.ok) {
        fatal = `the builder identity changed while adding ${repo} (${bound.reason})`;
        stop();
        return;
      }
      activeRepos.add(repo);
      if (!store.listProjects().some(one => one.path === repo)) {
        store.upsertProject(repo, projectName(repo), clock());
      }
    }
    let markReady: () => void = () => {};
    const ready = new Promise<void>(resolveReady => (markReady = resolveReady));
    const loop = runWatchLoop({
      flags: loopFlagsFor(repo),
      context,
      runner: runnerName,
      token: runnerToken,
      repo,
      progress: line => progress(`${prefix(repo)}${line}`),
      isStopping: () => stopping || releasedRepos.has(repo),
      onFollowController: controller => followControllers.push(controller),
      containmentLines,
      passes: projectPasses,
      serviceBridge: true,
      onReady: () => {
        markReady();
        if (bind) progress(`${prefix(repo)}builder connected — queued work can start`);
      },
    }).then(
      result => ({ repo, result }),
      error => ({ repo, result: { ok: false as const, reason: "loop-failed" as const, detail: describe(error), ticks: 0, built: 0, broke: 0 } }),
    );
    loopResults.set(repo, loop);
    void loop.then(({ repo: endedRepo, result }) => {
      if (releasedRepos.has(endedRepo) && !stopping) {
        // A removed project's watch has stopped: only now does the builder let go of it.
        const unbound = removeRunnerRepoAuthed(store, { name: runnerName, token: runnerToken, repo: endedRepo }, clock());
        if (!unbound.ok) {
          fatal = `the builder identity changed while removing ${endedRepo} (${unbound.reason})`;
          stop();
        }
        loopResults.delete(endedRepo);
        releasedRepos.delete(endedRepo);
        progress(`project removed — ${projectName(endedRepo)} is no longer built here`);
        markReady();
        return;
      }
      // A loop that dies while its siblings live must not leave a partial
      // cockpit standing silently (finding 5).
      if (!result.ok && !stopping) {
        fatal = `${prefix(endedRepo)}${result.detail}`;
        stop();
      }
      markReady(); // acquisition failures must not strand startup readiness
    });
    await ready;
  };

  await Promise.all(repos.map(repo => launchRepo(repo, false)));

  // Telegram: one follower for the whole service, never one per project
  // loop. Replies and notifications go out from it, over the same transport
  // in the same cycle (Oct 2: a reply sent by a project loop's own follower
  // failed "fetch failed" while notifications went out). A token saved
  // while the service runs connects within seconds; a follower that dies
  // is started again.
  const telegramController = new AbortController();
  followControllers.push(telegramController);
  const telegramSupervisor = (async (): Promise<void> => {
    const pause = (ms: number) => new Promise<void>(resolvePause => {
      const timer = setTimeout(done, ms);
      function done(): void { clearTimeout(timer); telegramController.signal.removeEventListener("abort", done); resolvePause(); }
      // An aborted signal never fires again: without this a stop waited the whole pause.
      if (telegramController.signal.aborted) done();
      else telegramController.signal.addEventListener("abort", done, { once: true });
    });
    while (!stopping && !telegramController.signal.aborted) {
      const follower = startTelegramFollower({
        context, publicUrl: text(flags, "public-url"), signal: telegramController.signal, progress, label: "telegram:",
        died: { prefix: "", then: "starting it again" }, owner: `service-${randomUUID()}`,
      });
      if (follower !== null) await follower;
      // Without a token (or on a fenced network) look again shortly; the fence line is said once.
      if (follower === null && loadBotToken(process.env, context.telegramTokenFile) !== null) break;
      await pause(follower === null ? 2_000 : 5_000);
    }
  })();

  const dynamicCeiling = resolveCeiling(repos, projectRoots).ceiling;
  const rejected = new Set<string>();
  const registrySupervisor = (async (): Promise<void> => {
    const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
    while (!stopping) {
      const loaded = await loadProjectRegistry(registryPath);
      if ("error" in loaded) {
        fatal = loaded.error;
        stop();
        break;
      }
      // Removed from the saved list: stop building it and take it out of the console. A pinned start keeps its own.
      const saved = new Set(loaded.repos.map(one => canonicalProject(one) ?? one));
      for (const repo of [...activeRepos]) {
        if (stopping || pinnedRepos.has(repo) || saved.has(repo)) continue;
        activeRepos.delete(repo);
        releasedRepos.add(repo);
        if (!loopResults.has(repo)) releasedRepos.delete(repo);
      }
      for (const candidate of loaded.repos) {
        if (stopping) break;
        const canonical = canonicalProject(candidate);
        // Still letting go of an earlier removal: it rejoins on the next pass after its watch has stopped.
        if (canonical !== null && (activeRepos.has(canonical) || releasedRepos.has(canonical))) continue;
        const approvedAdditions = context.additionalProjectRepos?.() ?? [];
        const admittedCeiling = resolveCeiling([...dynamicCeiling.repos, ...approvedAdditions], dynamicCeiling.roots).ceiling;
        // A project added after this start (`repos add`, the lead, the console) carries its recorded admission; a
        // registry line alone is not authority. Either way the folder is proved to be that Git checkout again.
        const allowed = canonical !== null &&
          ((await authorizedProject(admittedCeiling, canonical)) || admissionRecorded(store, canonical)) &&
          (await proveRepo(canonical)) === canonical;
        if (!allowed) {
          if (!rejected.has(candidate)) {
            rejected.add(candidate);
            progress(`project not connected — ${candidate} isn't a Git repository added with \`toolroll repos add\` or the console`);
          }
          continue;
        }
        rejected.delete(candidate);
        await launchRepo(canonical, true);
      }
      if (!stopping) await sleep(500);
    }
  })().catch(error => {
    fatal = `the project registry stopped (${describe(error)})`;
    stop();
  });

  // A runner with no projects still stays visibly alive while the UI waits
  // for the first addition. Watch loops heartbeat during their passes; this
  // machine-level pulse also covers the intentionally empty state.
  // Provider readiness (v47): this machine's non-spending observations,
  // recorded under its own runner name ONCE at start — so every route
  // projection can say ready / unavailable / unknown per provider, and
  // the dispatch gate can halt a leg this machine cannot run. There is no
  // periodic readiness daemon: startup, an explicit `providers --report`,
  // and the narrow pre-dispatch observation are the roads. Production
  // only: a test's injected agent runner is a fake, and its readiness
  // would be a fiction.
  const observeReadiness = (): void => {
    if (context.agentRunner !== undefined) return;
    void observeProviderReadiness((file, args, options) => run(file, args, { timeoutMs: options?.timeoutMs ?? 5_000, ...(options?.omitEnv === undefined ? {} : { omitEnv: options.omitEnv }) }))
      .then(observed => {
        if (!stopping) reportProviderReadinessAuthed(store, { name: runnerName, token: runnerToken, observations: observed }, clock());
      })
      .catch(() => {
        // A probe that cannot run leaves readiness unknown — never a fiction.
      });
  };
  observeReadiness();
  try { notifyVersionLive(context.store, dirname(context.databaseFile), PACKAGE_VERSION, clock()); } catch { /* A display fact; never blocks the worker. */ }
  recordRunnerVersion(dirname(context.databaseFile), runnerName, PACKAGE_VERSION, clock());
  const runnerHeartbeat = setInterval(() => {
    const beat = heartbeatRunner(store, runnerName, runnerToken, clock());
    if (!beat.ok && !stopping) {
      fatal = `the builder identity changed (${beat.reason})`;
      stop();
    }
  }, 60_000);
  runnerHeartbeat.unref?.();

  // 9. Readiness, then the ONE startup envelope / greeting (finding 11/20).
  const approverPlan2 = approver as UpApprover;
  const url = console_.url;
  const terminal = !agentRunning && (context.upSeams?.terminal ?? process.stdout.isTTY === true);
  const upHandoff = buildHandoff({
    url,
    login: { account: approverPlan2.passwordFile === null ? approverPlan2.approver : loginAccount(approverPlan2.passwordFile) ?? approverPlan2.approver, file: approverPlan2.passwordFile },
  });
  recordUpConsoleUrl(dirname(context.databaseFile), url, clock());
  if (fatal === null) {
    if (json) {
      write(
        envelopeJson({
          ok: true,
          command: "up",
          url,
          repos,
          runner: runnerName,
          approver: approverPlan2.approver,
          approvers: approverPlan2.approvers,
          approverVerified: approverPlan2.verified,
          ...(approverPlan2.passwordFile === null ? {} : { passwordFile: approverPlan2.passwordFile }),
          handoff: upHandoff,
        }),
      );
    } else if (!terminal) {
      // No person at a terminal: an agent started this. It gets the
      // handoff to relay, never the password, and no browser opens.
      write("");
      for (const line of handoffLines(upHandoff)) write(line);
      write("Run `toolroll onboard` inside a repository to add it and install the Toolroll skill for your agent.");
    } else {
      // Three lines (onboarding): where it is, that it opens signed in, and what to do if it doesn't. The browser gets a
      // one-time sign-in link (single use, ten minutes, this computer only); it is never printed. The password stays
      // saved beside the database, for later and for other devices, and is never printed either.
      const account = approverPlan2.approver;
      const link = account === null || flags.has("no-open") ? null : console_.server.mintSignInLink(account);
      const home = homedir();
      const file = approverPlan2.passwordFile === null ? null : approverPlan2.passwordFile.startsWith(`${home}/`) ? `~${approverPlan2.passwordFile.slice(home.length)}` : approverPlan2.passwordFile;
      const signInWords = account === null
        ? `sign in as one of ${approverPlan2.approvers.join(", ")}`
        : file === null ? `sign in as ${account} with your password` : `sign in as ${account}: the password is in ${file}`;
      write("");
      write(`Toolroll is on ${url}`);
      if (link !== null) {
        write("Opening it in your browser now, already signed in.");
        write(`If it doesn't open, go to that address and ${signInWords}.`);
        (context.upSeams?.openBrowser ?? openBrowser)(new URL(link, url).toString());
      } else {
        write(`${signInWords.charAt(0).toUpperCase()}${signInWords.slice(1)}.`);
        write("Ctrl-C stops it.");
      }
    }
  }

  // 10. Supervise to the end.
  await stopped;
  await registrySupervisor;
  await Promise.all([...loopResults.values()]);
  // The follower was aborted with the stop. A send or a chat turn it is still
  // finishing keeps its own durable record; the service does not wait past
  // this for it.
  await new Promise<void>(done => {
    const timer = setTimeout(done, TELEGRAM_STOP_WAIT_MS);
    const finish = (): void => { clearTimeout(timer); done(); };
    void telegramSupervisor.then(finish, finish);
  });
  clearInterval(runnerHeartbeat);
  if (runTimer !== undefined) clearTimeout(runTimer);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  // Held sessions fence before the runner retires (v2 S0f): bounded, and
  // every controller settles conservatively or is paged.
  if (context.heldCoordinator !== undefined) {
    const unsettled = await context.heldCoordinator.close();
    for (const runId of unsettled) {
      // The shutdown deadline won: say so durably — the orphan sweep of
      // the NEXT up owns the cleanup, and silence would contradict
      // "settled conservatively or paged".
      store.enqueueNotification(
        {
          source: { run: runId },
          dedupeKey: `held-shutdown-unsettled:${runId}`,
          kind: "attended-unsettled",
          subject: `an attended session did not settle before shutdown (run #${runId})`,
          body: `The shutdown deadline passed before run #${runId}'s session finished fencing. The next \`toolroll up\` will fence and settle it; its worktree is preserved.`,
        },
        clock(),
      );
    }
  }
  retireRunnerIfCurrent(store, runnerName, runnerToken, clock());
  await new Promise<void>(done => console_.server.close(() => done()));

  if (fatal !== null) {
    // The startup envelope (when json) already went out; the exit code is
    // the health signal (finding 11/20) — never a second envelope.
    process.stderr.write(`up: ${fatal}\n`);
    return EXIT.failed;
  }
  progress("Toolroll stopped. Run `toolroll up` anywhere on this machine to start it again with every saved project.");
  return EXIT.ok;
}

// ---- the telegram bridge ---------------------------------------------------

/**
 * `toolroll bridge telegram …` — decisions out, answers back, no LLM in
 * the path.
 *
 *   bridge telegram                      one pass: send pending, apply taps
 *   bridge telegram --follow             stay on the wire: long poll, apply as they arrive
 *   bridge telegram pair --as <you> --token <approver-token>
 *   bridge telegram unpair --as <you> --token <approver-token>
 *   bridge telegram token [<bot-token>|--clear]   set the credential file
 *   bridge telegram status
 *   bridge telegram digest [--every 30m|2h|24h | --off]   away mode: routine facts batch, decisions still page
 *   bridge telegram retry                send unsent assistant replies again now
 *
 * The bot token comes from ${TOKEN_ENV} or the credential file this command
 * writes (0600, beside the database). Cron the pass right after tick; a
 * second concurrent pass loses the poll lease and reports `bridge-busy`,
 * which is the fences working, not an error to fix.
 */
function digestWords(everyMs: number): string {
  return everyMs % 3_600_000 === 0 ? `${everyMs / 3_600_000}h` : `${Math.round(everyMs / 60_000)}m`;
}

async function bridgeCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const demoFence = refuseDemo(context, "bridge");
  if (demoFence !== null) return demoFence;
  const [channel, action] = positional;
  if (channel !== "telegram") {
    return fail(write, json, "bridge", "usage", "`toolroll bridge telegram [pair|unpair|token|status|digest|retry]`", EXIT.usage);
  }

  if (action === "retry") {
    // Replies already written and fenced on the pairing like every send: this only moves their next attempt to now.
    const retried = store.retryTelegramReplies(null, clock());
    return succeed(write, json, "bridge retry", { retried }, () => [
      retried === 0 ? "No unsent Telegram replies." : `Sending ${retried} Telegram ${retried === 1 ? "reply" : "replies"} again on the next bridge pass.`,
    ]);
  }

  if (action === "token") {
    const value = positional[2];
    if (flags.has("clear")) {
      const removed = clearBotToken(context.telegramTokenFile);
      return succeed(write, json, "bridge token", { cleared: removed }, () => [
        removed ? "Token file removed." : "There was no token file to remove.",
      ]);
    }
    if (value === undefined) {
      return fail(
        write,
        json,
        "bridge token",
        "usage",
        "`toolroll bridge telegram token <bot-token>` (from @BotFather), or --clear",
        EXIT.usage,
      );
    }
    const saved = saveBotToken(context.telegramTokenFile, value);
    if (!saved.ok) return fail(write, json, "bridge token", "bad-token", saved.message, EXIT.refused);
    return succeed(write, json, "bridge token", { saved: true, file: context.telegramTokenFile }, () => [
      `Saved (owner-only) to ${context.telegramTokenFile}.`,
      `${TOKEN_ENV} in the environment would take precedence over it.`,
    ]);
  }

  if (action === "digest") {
    // Away mode (mate arc §10): the cadence, or off. A closed shape of
    // durations — minutes or hours — never a free number.
    const every = text(flags, "every");
    if (flags.has("off")) {
      store.setTelegramDigest(null, "cli", clock());
      return succeed(write, json, "bridge digest", { everyMs: null }, () => ["Digest off — every fact pages as it lands."]);
    }
    if (every === undefined) {
      const current = store.telegramDigest();
      const held = store.countRoutinePending();
      return succeed(write, json, "bridge digest", { ...current, held }, () => [
        current.everyMs === null
          ? "Digest off — every fact pages as it lands. `bridge telegram digest --every 2h` turns it on."
          : `Digest every ${digestWords(current.everyMs)}; ${held} routine fact(s) held; next no earlier than ${
              current.lastSentAt === null ? "the next bridge pass" : new Date(new Date(current.lastSentAt).getTime() + current.everyMs).toISOString()
            }.`,
      ]);
    }
    const parsed = /^([1-9][0-9]{0,3})(m|h)$/.exec(every);
    if (parsed === null) {
      return fail(write, json, "bridge digest", "usage", "--every takes minutes or hours: 30m, 2h, 24h — or --off", EXIT.usage);
    }
    const everyMs = Number(parsed[1]) * (parsed[2] === "h" ? 3_600_000 : 60_000);
    if (everyMs < 5 * 60_000 || everyMs > 7 * 24 * 3_600_000) {
      return fail(write, json, "bridge digest", "usage", "the digest cadence is between 5 minutes and 7 days", EXIT.usage);
    }
    store.setTelegramDigest(everyMs, "cli", clock());
    return succeed(write, json, "bridge digest", { everyMs }, () => [
      `Digest every ${digestWords(everyMs)}. Routine facts are held and sent together; decisions and anything that needs you now still page at once.`,
    ]);
  }

  const source = loadBotToken(process.env, context.telegramTokenFile);

  if (action === "status") {
    const bindings = source === null ? [] : store.liveTelegramBindings(source.botId);
    const binding = bindings[0] ?? null;
    const pending = store.listNotifications("pending").length;
    const digest = store.telegramDigest();
    if (json) {
      write(
        envelopeJson(
          {
            ok: true,
            command: "bridge status",
            token: source === null ? null : { source: source.source, botId: source.botId, redacted: redactToken(source.token) },
            paired: binding !== null,
            approver: binding?.approver ?? null,
            people: bindings.map(one => one.approver),
            outboxPending: pending,
            digest: { everyMs: digest.everyMs, lastSentAt: digest.lastSentAt, held: digest.everyMs === null ? 0 : store.countRoutinePending() },
          },
        ),
      );
      return EXIT.ok;
    }
    write(source === null
      ? `No bot token. Set ${TOKEN_ENV}, run \`toolroll bridge telegram token <t>\`, or use the serve settings card.`
      : `Token ${redactToken(source.token)} (${source.source}), bot ${source.botId}.`);
    write(binding === null ? "No chat is paired." : `Paired: ${bindings.length === 1 ? `chat answers as ${binding.approver}` : `${bindings.length} chats answer as ${bindings.map(one => one.approver).join(", ")}`}.`);
    write(`Outbox pending: ${pending}.`);
    write(digest.everyMs === null ? "Digest off." : `Digest every ${digestWords(digest.everyMs)}; ${store.countRoutinePending()} routine fact(s) held.`);
    return EXIT.ok;
  }

  if (action === "pair" || action === "unpair") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `bridge ${action}`, "usage", "`--as <you> --token <your password>` — pairing hands your authority to a chat, so it takes your credential", EXIT.usage);
    }
    const { name: asWho, token } = acting;
    const authenticated = authenticateApprover(store, asWho, token);
    if (!authenticated.ok) {
      return fail(write, json, `bridge ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, asWho), EXIT.refused);
    }

    if (action === "unpair") {
      if (source === null) {
        return fail(write, json, "bridge unpair", "no-token", "no bot token, so no bot to unpair", EXIT.refused);
      }
      const revoked = store.unpairTelegram(source.botId, asWho, clock());
      return succeed(write, json, "bridge unpair", { revoked }, () => [
        revoked
          ? "Unpaired. Every outstanding button from that chat is dead. Rotate the bot token with @BotFather if it may have leaked."
          : "Nothing was paired.",
      ]);
    }

    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: asWho, by: asWho, ttlMs: PAIRING_TTL_MS },
      clock(),
    );
    return succeed(write, json, "bridge pair", { code, expiresInMs: PAIRING_TTL_MS }, () => [
      "From your phone, send your bot this message within 10 minutes:",
      "",
      `  /pair ${code}`,
      "",
      "The next bridge pass completes it. The code works once, in a private",
      "chat only, and the chat will answer as you — treat it accordingly.",
    ]);
  }

  if (action !== undefined) {
    return fail(write, json, "bridge", "usage", "`toolroll bridge telegram [pair|unpair|token|status]`", EXIT.usage);
  }

  // The pass.
  if (source === null) {
    return fail(
      write,
      json,
      "bridge",
      "no-token",
      `no bot token — set ${TOKEN_ENV}, run \`toolroll bridge telegram token <t>\`, or use the serve settings card`,
      EXIT.refused,
    );
  }
  const fenced = networkFence(context.telegramEnv ?? (context.telegramTransport === undefined ? process.env : {}));
  if (fenced !== null) return fail(write, json, "bridge", "network-fenced", networkFenceLine(fenced), EXIT.refused);
  const transport = context.telegramTransport ?? createTransport(source.token);

  // --follow: stay on the wire. One long-poll actor holds the poll lease;
  // an answer tapped on a phone lands in seconds instead of at the next
  // cron firing. Ctrl-C (or --for, for trials) stops it cleanly — the
  // in-flight long poll is aborted, not waited out.
  if (flags.has("follow")) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const runFor = text(flags, "for");
    const timer = runFor === undefined ? null : setTimeout(() => controller.abort(), Number(runFor));
    timer?.unref?.();
    // An injected fence (tests) ends the follow exactly as a signal does.
    const fence = context.shouldStop === undefined ? null : setInterval(() => { if (context.shouldStop?.() === true) controller.abort(); }, 50);
    fence?.unref?.();
    if (!json) write(`Following bot ${source.botId} — taps apply as they arrive. Ctrl-C stops it.`);
    try {
      const report = await followBridge(store, {
        readProjects: telegramReadProjects(context),
        canDeliver: telegramCanDeliver(context, source.token),
        conversation: telegramConversation(context),
        ...(flags.has("inbound-only") ? { deliver: false } : {}),
        botId: source.botId,
        transport,
        signal: controller.signal,
        clock,
        ...(text(flags, "poll") === undefined ? {} : { pollSeconds: Number(text(flags, "poll")) }),
        onCycle: cycle => {
          if (!json) {
            write(
              `bridge: sent ${cycle.sent}, answered ${cycle.answered}, paired ${cycle.paired}` +
                ((cycle.statusReplies ?? 0) > 0 ? `, status replies ${cycle.statusReplies}` : "") +
                (cycle.problems.length > 0 ? ` — ${cycle.problems.length} problem(s): ${cycle.problems[0]!.slice(0, 200)}` : ""),
            );
          }
        },
      });
      return succeed(write, json, "bridge follow", { report }, () => [
        `Followed for ${report.cycles} cycle(s): sent ${report.sent}, answered ${report.answered}, paired ${report.paired}, ignored ${report.ignored}, status replies ${report.statusReplies ?? 0}.`,
        ...report.problems.slice(-5).map(problem => `  problem: ${problem}`),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (fence !== null) clearInterval(fence);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }

  const passed = await bridgePass(store, {
    readProjects: telegramReadProjects(context),
    canDeliver: telegramCanDeliver(context, source.token),
    conversation: telegramConversation(context),
    botId: source.botId,
    transport,
    clock,
    ...(flags.has("inbound-only") ? { deliver: false } : {}),
  });
  if (!passed.ok) {
    return fail(write, json, "bridge", passed.reason, passed.message, EXIT.refused);
  }

  const { report } = passed;
  const broke = report.problems.length > 0;
  const idle = report.sent === 0 && report.answered === 0 && report.paired === 0 && (report.statusReplies ?? 0) === 0
    && (report.chatQueued ?? 0) === 0 && (report.chatAnswered ?? 0) === 0 && (report.chatRefused ?? 0) === 0 && (report.chatConfirmed ?? 0) === 0;
  const lines = () => [
    `Sent ${report.sent}, answered ${report.answered}, paired ${report.paired}, ignored ${report.ignored}, status replies ${report.statusReplies ?? 0}, chat received ${report.chatQueued ?? 0}, chat replied ${report.chatAnswered ?? 0}, chat confirmed ${report.chatConfirmed ?? 0}.`,
    ...(report.backlog ? ["Telegram still holds more updates than one pass's budget — run it again."] : []),
    ...report.problems.map(problem => `  problem: ${problem}`),
  ];
  if (broke) {
    return fail(write, json, "bridge", "telegram-transport", lines().join("\n"), EXIT.failed, { report });
  }
  if (idle) {
    return fail(write, json, "bridge", "idle", "nothing to send, nothing arrived", EXIT.refused, { report });
  }
  return succeed(write, json, "bridge", { report }, lines);
}

// ---- publication -----------------------------------------------------------

/**
 * `toolroll publish …` — built work to a pushed branch and a PR, under a
 * grant whose terms were shown before the yes.
 *
 *   publish                              one pass: push intents, open/adopt PRs
 *   publish grant --github <owner/name> [--base main] [--remote origin]
 *                 [--head-prefix toolroll/] [--all-tasks] [--ready]
 *                 --as <you> --token <approver-token> [--yes]
 *   publish revoke --as <you> --token <approver-token>
 *   publish status
 *
 * Granting without --yes prints the exact terms and does nothing — the same
 * see-it-first ceremony as a scope approval. Revocation is immediate: the
 * next pass pushes nothing, whatever intents exist.
 */
async function publishCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const demoFence = refuseDemo(context, "publish");
  if (demoFence !== null) return demoFence;
  const repo = repoFrom(flags);
  const [action] = positional;
  // Bare `publish` IS an action: the publication pass (push branches,
  // open PRs, sweep merges) — only a NAMED unknown action refuses.
  if (action !== undefined && !(PUBLISH_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "publish", "usage", `unknown \`publish ${action}\` — try ${PUBLISH_ACTIONS.join(", ")}, or bare \`publish\` for the publication pass`, EXIT.usage);
  }

  if (action === "setup") {
    const mergeMethod = text(flags, "merge-method") ?? "squash";
    if (!["squash", "merge", "rebase"].includes(mergeMethod)) {
      return fail(write, json, "publish setup", "usage", "--merge-method is squash, merge or rebase", EXIT.usage);
    }
    const checked = await checkPublishing(repo, context.publishExec === undefined ? {} : { exec: context.publishExec });
    if (!checked.ok) return fail(write, json, "publish setup", checked.reason, checked.message, EXIT.refused);
    const settings = { mergeMethod: mergeMethod as "squash" | "merge" | "rebase", mergeWhenGreen: flags.has("merge-when-green") };
    const plan = checked.plan;
    const terms = [
      `Pull requests for ${plan.githubRepo} into ${plan.base}${plan.account === null ? "" : `, as ${plan.account}`}.`,
      "Complete will offer \"Complete and open a pull request\"; the pull request opens from the exact completed commit.",
      `Merges ${settings.mergeMethod} and delete the branch${settings.mergeWhenGreen ? ", by themselves once checks pass" : " when a person selects Merge"}.`,
    ];
    if (!flags.has("yes")) {
      if (json) {
        write(envelopeJson({ ok: false, command: "publish setup", reason: "unconfirmed", proposed: { ...plan, ...settings } }));
        return EXIT.refused;
      }
      for (const line of terms) write(line);
      write("Nothing is set up yet. Repeat with --yes --as <you> --token <password> to turn it on.");
      return EXIT.refused;
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "publish setup", "usage", "turning on pull requests takes --as <you> --token <your password>", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token, repo);
    if (!authenticated.ok) {
      return fail(write, json, "publish setup", authenticated.reason, describeApproveFailure(authenticated.reason, acting.name), EXIT.refused);
    }
    savePublishing(store, plan, acting.name, settings, clock());
    return succeed(write, json, "publish setup", { publishing: publishingOf(store, repo) }, () => ["Pull requests are on.", ...terms]);
  }

  if (action === "grant") {
    const github = text(flags, "github");
    if (github === undefined || !/^[\w.-]+\/[\w.-]+$/.test(github)) {
      return fail(write, json, "publish grant", "usage", "`--github <owner/name>` is required, exactly", EXIT.usage);
    }
    const wantsMerge = flags.has("allow-merge");
    const mergeMethod = text(flags, "merge-method");
    if (wantsMerge && (mergeMethod === undefined || !["squash", "merge", "rebase"].includes(mergeMethod))) {
      return fail(write, json, "publish grant", "usage", "--allow-merge names its method: --merge-method squash|merge|rebase", EXIT.usage);
    }
    const spec = {
      repo,
      githubRepo: github,
      remote: text(flags, "remote") ?? "origin",
      headPrefix: text(flags, "head-prefix") ?? BRANCH_PREFIX,
      base: text(flags, "base") ?? "main",
      capabilities: ["push-branch", "open-pr"] as ("push-branch" | "open-pr")[],
      selector: (flags.has("all-tasks") ? "all" : "ours") as "all" | "ours",
      draft: !flags.has("ready"),
      merge: wantsMerge,
      mergeMethod: wantsMerge ? (mergeMethod as "squash" | "merge" | "rebase") : null,
      mergeDeleteBranch: wantsMerge && flags.has("merge-delete-branch"),
    };
    // The merge terms are restated with the ACTUAL credential that would
    // act (round-2 finding c): the account is shown, and named unpinned.
    const mergeTerms: string[] = [];
    if (wantsMerge) {
      const whoAmI = await (context.publishExec ?? undefined) ?.("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 10_000 })
        ?? await (await import("./exec.js")).run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 10_000 });
      const account = whoAmI.code === 0 ? whoAmI.stdout.trim() : "(gh is not signed in — merges will refuse)";
      mergeTerms.push(
        "",
        "AND auto-merge: pull requests this plane opened or adopted, on " + github + " into " + spec.base + ",",
        "merge as " + mergeMethod + (spec.mergeDeleteBranch ? " and delete the remote branch" : "") + " — ONLY after CI was OBSERVED green on the exact",
        "head commit (silence, running, or a moved head never merge; drafts never merge;",
        "a base with a merge queue, or protection this plane cannot read, pauses with a page).",
        "Merging acts as the GitHub account signed into gh on the machine that runs the",
        "sweep — currently: " + account + " — and is NOT pinned; changing gh auth changes who merges.",
        "CI can turn red on the same commit between the last look and the merge; the",
        "exact-commit match cannot see that. An all-skipped check rollup reads as passing.",
      );
    }

    if (!flags.has("yes")) {
      // Unconfirmed, like every other grant preview: ok:false, reason
      // "unconfirmed", exit 3 — this one alone said ok:true (round-4
      // finding 10 / round-3 finding B5).
      if (json) {
        write(envelopeJson({ ok: false, command: "publish grant", reason: "unconfirmed", proposed: spec, granted: false }));
        return EXIT.refused;
      }
      write("This grant would allow, unattended:");
      for (const line of describePublicationGrant(spec)) write(line);
      for (const line of mergeTerms) write(line);
      write("");
      write("Nothing is granted yet. Repeat with --yes --as <you> --token <approver-token> to agree to exactly this.");
      return EXIT.refused;
    }

    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "publish grant", "usage", "granting takes --as <you> --token <your password> — pushing your repos is a person's yes", EXIT.usage);
    }
    const { name: asWho, token } = acting;
    const authenticated = authenticateApprover(store, asWho, token);
    if (!authenticated.ok) {
      return fail(write, json, "publish grant", authenticated.reason, describeApproveFailure(authenticated.reason, asWho), EXIT.refused);
    }

    store.savePublicationGrant({ ...spec, grantedBy: asWho }, clock());
    return succeed(write, json, "publish grant", { granted: true, grant: spec }, () => [
      `Granted by ${asWho}:`,
      ...describePublicationGrant(spec),
      "Revoke any time: `toolroll publish revoke --as <you> --token <t>`.",
    ]);
  }

  if (action === "revoke") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "publish revoke", "usage", "`--as <you> --token <your password>`", EXIT.usage);
    }
    const { name: asWho, token } = acting;
    const authenticated = authenticateApprover(store, asWho, token);
    if (!authenticated.ok) {
      return fail(write, json, "publish revoke", authenticated.reason, describeApproveFailure(authenticated.reason, asWho), EXIT.refused);
    }
    const revoked = store.revokePublicationGrant(repo, asWho, clock());
    return succeed(write, json, "publish revoke", { revoked }, () => [
      revoked
        ? "Revoked. The next pass pushes nothing, whatever intents exist."
        : "There was no live grant to revoke.",
    ]);
  }

  if (action === "status") {
    const grant = store.publicationGrantFor(repo);
    const pending = store.pendingPublications();
    if (json) {
      write(envelopeJson({ ok: true, command: "publish status", grant, pending }));
      return EXIT.ok;
    }
    write(grant === null ? "No live publication grant." : `Granted by ${grant.grantedBy} at ${grant.grantedAt}:`);
    if (grant !== null) for (const line of describePublicationGrant(grant)) write(line);
    write(pending.length === 0 ? "Nothing owed." : `Owed: ${pending.length} publication(s) pending.`);
    return EXIT.ok;
  }

  if (action === "merge" || action === "refire") {
    const prGiven = positional[1];
    const pr = Number(prGiven);
    if (prGiven === undefined || !Number.isInteger(pr) || pr <= 0) {
      return fail(write, json, `publish ${action}`, "usage", `\`toolroll publish ${action} <pr> --as <you> --token <t>\``, EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `publish ${action}`, "usage", "authorizing a merge takes `--as <you> --token <t>` — who said yes is recorded, not asserted", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, `publish ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, acting.name), EXIT.refused);
    }
    const publication = store.openedPublications().find(one => one.prNumber === pr);
    if (publication === undefined) {
      return fail(write, json, `publish ${action}`, "unknown", `no open publication holds PR #${pr}`, EXIT.refused);
    }
    const intent = store.mergeIntentFor(publication.id);
    if (intent === null) {
      return fail(write, json, `publish ${action}`, "no-intent", `PR #${pr} has no merge intent yet — the sweep writes one when a merge-capable grant covers it`, EXIT.refused);
    }
    if (action === "merge") {
      // The EXACT-INTENT ceremony (E1): the yes covers this head and no
      // other — a moved head refuses rather than authorizing the unseen.
      const released = store.authorizeMergeIntent(intent.id, intent.headSha, acting.name, clock());
      if (!released.ok) {
        return fail(
          write, json, "publish merge",
          released.reason,
          released.reason === "not-waiting"
            ? `PR #${pr} is not waiting for you (it is ${intent.state}) — only a waiting merge takes this yes`
            : `PR #${pr}'s commit moved since this intent was written — the sweep will re-prove and re-ask`,
          EXIT.refused,
        );
      }
      store.resolveEpisodes(`merge-attn:${publication.id}`, context.clock());
      return succeed(write, json, "publish merge", { pr, headSha: intent.headSha }, () => [
        `Your yes covers PR #${pr} at ${intent.headSha.slice(0, 12)} — the next sweep merges it once CI is seen green on that exact commit.`,
      ]);
    }
    const refired = store.refireMergeIntent(intent.id, acting.name, clock());
    if (!refired.ok) {
      return fail(
        write, json, "publish refire",
        refired.reason,
        refired.reason === "not-firing"
          ? `PR #${pr} has no half-fired merge (it is ${intent.state})`
          : `PR #${pr}'s merge claim is still live — its owner may finish; refire only recovers one gone silent past its deadline`,
        EXIT.refused,
      );
    }
    store.resolveEpisodes(`merge-attn:${publication.id}`, context.clock());
    return succeed(write, json, "publish refire", { pr }, () => [
      `PR #${pr} re-enters the full merge road — claim, re-proof, and the firing gate, from the top.`,
    ]);
  }

  if (action === "unblock" || action === "rearm") {
    const prGiven = positional[1];
    const pr = Number(prGiven);
    if (prGiven === undefined || !Number.isInteger(pr) || pr <= 0) {
      return fail(write, json, `publish ${action}`, "usage", `\`toolroll publish ${action} <pr> --as <you> --token <t>\``, EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `publish ${action}`, "usage", `${action === "unblock" ? "lifting a repair hold" : "re-arming a refused merge"} takes \`--as <you> --token <t>\` — who decided is recorded, not asserted`, EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, `publish ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, acting.name), EXIT.refused);
    }
    const publication = store.openedPublications().find(one => one.prNumber === pr);
    if (publication === undefined) {
      return fail(write, json, `publish ${action}`, "unknown", `no open publication holds PR #${pr}`, EXIT.refused);
    }
    if (action === "unblock") {
      const lifted = store.liftMergeBlocker(publication.id, acting.name, context.clock());
      store.resolveEpisodes(`merge-attn:${publication.id}`, context.clock());
      return succeed(write, json, "publish unblock", { pr, lifted }, () => [
        lifted
          ? `PR #${pr} no longer holds for its repair — the next sweep may merge it under the granted terms.`
          : `PR #${pr} was not held by a repair.`,
      ]);
    }
    const rearmed = store.rearmMergeIntent(publication.id);
    store.resolveEpisodes(`merge-attn:${publication.id}`, context.clock());
    return succeed(write, json, "publish rearm", { pr, rearmed }, () => [
      rearmed
        ? `PR #${pr}'s merge is re-armed — the next sweep re-proves everything and tries again.`
        : `PR #${pr} had no refused merge to re-arm.`,
    ]);
  }

  if (action !== undefined) {
    return fail(write, json, "publish", "usage", "`toolroll publish [grant|revoke|status|unblock|rearm]`", EXIT.usage);
  }

  // The pass.
  const report = await publishPass(store, {
    repo,
    clock,
    evidenceRoot: context.evidenceRoot,
    ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
  });
  // The merge sweep rides every publish pass: green, proved, granted work
  // leaves as MERGED PRs (v21; four review rounds are the spec).
  const merges = await sweepMerges(store, {
    repo,
    clock,
    ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
  });
  const idle =
    report.pushed === 0 && report.opened === 0 && report.adopted === 0 && report.failed === 0 && merges.merged === 0 && merges.refused === 0;
  const lines = () => [
    `Pushed ${report.pushed}, opened ${report.opened}, adopted ${report.adopted}, gave up on ${report.failed}.` +
      (merges.merged + merges.refused + merges.skipped > 0 ? ` Merged ${merges.merged}, refused ${merges.refused}, holding ${merges.skipped}.` : ""),
    ...report.problems.map(problem => `  problem: ${problem}`),
    ...merges.problems.map(problem => `  merge: ${problem}`),
  ];
  if (report.problems.length > 0) {
    return fail(write, json, "publish", "publish-problems", lines().join("\n"), EXIT.failed, { report });
  }
  if (idle) {
    return fail(write, json, "publish", "idle", "nothing owed — no pending publications", EXIT.refused, { report });
  }
  return succeed(write, json, "publish", { report }, lines);
}

// ---- the outbox -----------------------------------------------------------

/**
 * `toolroll outbox list|deliver` — reading and draining the durable
 * outbox. Delivery runs an operator-supplied command once per pending row;
 * the notification's text reaches it as environment variables, never
 * substituted into the command line, because subjects and bodies quote
 * things agents and repositories said and a shell must not meet those.
 *
 *   toolroll outbox deliver --cmd 'curl -d "$TOOLROLL_SUBJECT" ntfy.sh/mine'
 *
 * Exit 0 when everything pending delivered (or nothing was pending);
 * 1 when any delivery failed — a broken channel is breakage, not a "no".
 */
/**
 * `toolroll peek [<run>] [--tmux] [--lines <n>]` — watch live agents
 * in the terminal: one pane per open run with its stage and transcript
 * tail; a run id follows that one until it finishes; --tmux opens a real
 * tmux session with a window per run. Outside a TTY or under --json: one
 * snapshot, enveloped. A look, never a write.
 */
async function peekCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [given] = positional;
  let runId: number | undefined;
  if (given !== undefined) {
    if (!/^[1-9][0-9]{0,14}$/.test(given)) return fail(write, json, "peek", "usage", "`toolroll peek [<run-id>] [--tmux]`", EXIT.usage);
    runId = Number(given);
    if (store.getRun(runId) === null) return fail(write, json, "peek", "unknown-run", `no run #${runId}`, EXIT.refused);
  }
  const linesGiven = text(flags, "lines");
  const lines = linesGiven === undefined ? 12 : Number(linesGiven);
  if (!Number.isInteger(lines) || lines < 1 || lines > PEEK_TAIL_LINES) {
    return fail(write, json, "peek", "usage", `--lines is a whole number from 1 to ${PEEK_TAIL_LINES}`, EXIT.usage);
  }
  const interactive = !json && process.stdout.isTTY === true && process.stdin.isTTY === true;

  if (flags.has("tmux")) {
    if (!interactive) return fail(write, json, "peek", "usage", "--tmux needs a terminal", EXIT.usage);
    const panes = snapshotLiveRuns(store, context.evidenceRoot, clock());
    const opened = await openInTmux(panes, [process.execPath, process.argv[1] ?? "toolroll", ...(text(flags, "db") === undefined ? [] : ["--db", text(flags, "db") as string])], async (file, args) => {
      const answer = await execRun(file, args);
      return { code: answer.code, stderr: answer.stderr };
    });
    if (!opened.ok) return fail(write, json, "peek", "tmux", opened.message, EXIT.refused);
    return attachTmux();
  }

  if (!interactive) {
    const panes = snapshotLiveRuns(store, context.evidenceRoot, clock()).filter(one => runId === undefined || one.runId === runId);
    const body = panes.map(one => ({ ...one, lines: one.lines.slice(-lines) }));
    return succeed(write, json, "peek", { runs: body }, () =>
      body.length === 0
        ? ["No agent is working right now."]
        : body.flatMap(one => [
            `#${one.runId} ${one.title} — ${one.runner} · ${one.role} · ${one.phase} · ${elapsedWords(one.startedAt, clock())}`,
            ...(one.lines.length === 0 ? ["    (no transcript yet)"] : one.lines.map(line => `    ${line}`)),
            "",
          ]),
    );
  }
  return runPeek(store, context.evidenceRoot, { ...(runId === undefined ? {} : { runId }), io: { stdout: process.stdout, stdin: process.stdin }, clock });
}

async function outboxCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action] = positional;

  if (action === "list" || action === undefined) {
    const wanted = flags.has("all") ? "all" : "pending";
    const notifications = store.listNotifications(wanted);
    if (json) {
      write(envelopeJson({ ok: true, command: "outbox list", notifications }));
      return EXIT.ok;
    }
    if (notifications.length === 0) {
      write(wanted === "pending" ? "Nothing waiting to be delivered." : "The outbox is empty.");
      return EXIT.ok;
    }
    for (const one of notifications) {
      const state =
        one.deliveredAt !== null
          ? `delivered ${one.deliveredAt}`
          : one.attempts > 0
            ? `pending, ${one.attempts} failed attempt(s): ${one.lastError ?? ""}`
            : "pending";
      write(`  #${one.id} ${one.kind.padEnd(18)} ${one.subject}`);
      write(`      ${state}`);
    }
    return EXIT.ok;
  }

  if (action === "deliver") {
    const demoFence = refuseDemo(context, "outbox deliver");
    if (demoFence !== null) return demoFence;
    const command = text(flags, "cmd");
    if (command === undefined) {
      return fail(write, json, "outbox deliver", "usage", "--cmd says how: it runs once per notification, reading $TOOLROLL_KIND, $TOOLROLL_SUBJECT, $TOOLROLL_BODY", EXIT.usage);
    }

    // Claimed, not merely listed: the Telegram bridge drains this same
    // outbox, and select-then-send-then-record from two deliverers pages a
    // person twice. The claim is a short lease on the act of sending; a
    // deliverer that dies mid-send leaves rows that unclaim by expiry.
    const owner = `outbox-${randomUUID()}`;
    // Push first, independently (arc 3 finding 8): its pair ledger does not
    // depend on globally-undelivered notifications — Telegram or a webhook
    // may already have stamped delivered_at.
    let pushed = 0;
    try {
      pushed = (await pushPass(store, { configDir: dirname(context.databaseFile), clock })).accepted;
    } catch {
      // additive; the shell delivery below still runs
    }
    const pending = store.claimDeliveries(owner, 2 * 60_000, clock());
    if (pending.length === 0) {
      return succeed(write, json, "outbox deliver", { delivered: 0, failed: 0, pushed }, () => [
        pushed > 0 ? `Nothing for the shell command; ${pushed} push(es) accepted.` : "Nothing waiting to be delivered.",
      ]);
    }

    let delivered = 0;
    let failed = 0;
    for (const one of pending) {
      const sent = await run("sh", ["-lc", command], {
        timeoutMs: 30_000,
        env: {
          ...envTwins("KIND", one.kind),
          ...envTwins("SUBJECT", one.subject),
          ...envTwins("BODY", one.body),
          ...envTwins("DEDUPE_KEY", one.dedupeKey),
        },
      });
      if (sent.code === 0) {
        const receipt = sent.stdout.split("\n")[0]?.trim() ?? "";
        store.finalizeDelivery(one.id, owner, { ok: true, receipt: receipt === "" ? null : receipt }, clock());
        delivered++;
      } else {
        const error = sent.timedOut
          ? "timed out"
          : sent.stderr.split("\n")[0]?.trim() || `exit ${sent.code}`;
        store.finalizeDelivery(one.id, owner, { ok: false, error }, clock());
        failed++;
      }
    }

    const code = failed > 0 ? EXIT.failed : EXIT.ok;
    if (json) {
      write(envelopeJson({ ok: failed === 0, command: "outbox deliver", delivered, failed }));
      return code;
    }
    write(`Delivered ${delivered}, failed ${failed}.`);
    return code;
  }

  return fail(write, json, "outbox", "usage", `unknown \`outbox ${action}\` — try list, deliver`, EXIT.usage);
}

// ---- write access ---------------------------------------------------------

/**
 * Hand a repository over, deliberately.
 *
 * Like `link`, this shows what it would do and does nothing without `--yes` —
 * for a stronger reason. `link` writes one file into a directory the operator
 * named; this one is the moment discovery stops being read-only, and the
 * grant's own terms are what somebody is agreeing to. Printing them after the
 * fact would be a receipt, not consent.
 */
async function enrollCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const repo = positional[0] === undefined ? process.cwd() : resolve(positional[0]);
  const backend = text(flags, "backend") ?? BUILT_IN;

  const mutations = readMutations(flags);
  if (mutations === null) {
    return fail(write, json, "enroll", "usage", `--allow takes ${MUTATION_CLASSES.join(", ")}`, EXIT.usage);
  }

  const selectorFlag = text(flags, "selector") ?? "ours";
  if (selectorFlag !== "ours" && selectorFlag !== "all") {
    return fail(write, json, "enroll", "usage", "--selector is `ours` or `all`", EXIT.usage);
  }

  const paths = readPaths(flags, backend);
  if (paths.length === 0) {
    return fail(
      write,
      json,
      "enroll",
      "usage",
      `--paths says what may be written for backend \`${backend}\``,
      EXIT.usage,
    );
  }

  // External dispatch (v20): its own explicit yes, never in any default.
  // A dispatch grant binds EXACTLY ONE remote repository and mints this
  // plane's marker identity.
  const wantsDispatch = flags.has("allow-dispatch");
  const dispatchRepo = text(flags, "github");
  if (wantsDispatch && backend !== "github-issues") {
    return fail(write, json, "enroll", "usage", "--allow-dispatch is a github-issues authority in this release", EXIT.usage);
  }
  if (wantsDispatch && (dispatchRepo === undefined || !GITHUB_REPO_SHAPE.test(dispatchRepo))) {
    return fail(write, json, "enroll", "usage", "--allow-dispatch binds exactly one tracker: name it with `--github <owner/name>`", EXIT.usage);
  }

  const grant = await proposeGrant({
    repo,
    backend,
    paths,
    mutations,
    selector: selectorFlag,
    credentialScope: text(flags, "credentials") ?? null,
    now,
  });
  if (wantsDispatch) {
    const previous = store.grantFor(repo, backend);
    grant.dispatch = true;
    grant.remoteRepo = dispatchRepo as string;
    // Re-enrolling keeps the plane identity — that is exactly how a
    // marker is repaired after a semantic block.
    grant.planeId = previous?.planeId ?? randomBytes(8).toString("hex");
    grant.dispatchBlocked = "pending-marker";
  }

  if (!flags.has("yes")) {
    if (json) {
      write(envelopeJson({ ok: false, command: "enroll", reason: "unconfirmed", grant }));
      return EXIT.refused;
    }
    write("Would grant write access:");
    write("");
    for (const line of describeGrant(grant)) write(line);
    for (const line of describeWithheld(grant)) write(line);
    if (wantsDispatch) {
      write("");
      write(`AND external dispatch: this plane will BUILD what ${dispatchRepo} nominates,`);
      write("under scopes approved here, and spend accordingly. Write-back stays limited");
      write("to the classes above. Enrolling writes a plane marker label to the repository");
      write("(needs push permission there); a second plane's marker pauses building here.");
    }
    write("");
    write("Nothing has been granted. Re-run with --yes to agree to this.");
    // Unconfirmed is "no, not yet" — exit 3 in both modes (round-4 finding 10).
    return EXIT.refused;
  }

  store.saveGrant(grant, mutationFrom(flags, now));

  // The marker, AFTER the grant row (v3 §5): a partial failure leaves the
  // grant honestly blocked 'pending-marker'; re-running enroll repairs it.
  if (wantsDispatch) {
    const adapter = ghDispatchAdapter();
    const wrote = await adapter.writeMarker(dispatchRepo as string, grant.planeId as string);
    if (wrote.ok) {
      store.setDispatchBlocked(repo, backend, null, now);
    } else {
      store.setDispatchBlocked(repo, backend, "pending-marker", now, wrote.message);
    }
    if (!wrote.ok) {
      return succeed(write, json, "enroll", { grant, marker: "pending" }, () => [
        `Granted, but the plane marker could not be written (${wrote.message}).`,
        "Building stays paused until it is — re-run this enroll to retry.",
      ]);
    }
  }

  return succeed(write, json, "enroll", { grant }, () => [
    `Granted. Toolroll may now write to ${backend} in ${repo}.`,
    ...describeGrant(grant),
    ...describeWithheld(grant),
    ...(wantsDispatch ? ["", `External dispatch is ON for ${dispatchRepo} — \`toolroll sync\` pulls its nominated work.`] : []),
    "",
    "Take it back with `toolroll revoke`.",
  ]);
}

function grantsCommand(context: Context): number {
  const { store, write, json } = context;
  const grants = store.listGrants();

  if (json) {
    write(envelopeJson({ ok: true, command: "grants", count: grants.length, grants }));
    return EXIT.ok;
  }
  if (grants.length === 0) {
    write("Nothing is enrolled. Discovery is read-only until something is.");
    write("  toolroll enroll <repo> --backend <name> --paths <path>");
    return EXIT.ok;
  }
  for (const grant of grants) {
    write(`${grant.repo}  ${grant.backend}`);
    for (const line of describeGrant(grant).slice(2)) write(line);
    write("");
  }
  return EXIT.ok;
}

function checkProgressCommand(positional: readonly string[], context: Context): number {
  if (positional.length !== 1 || !/^[1-9][0-9]{0,14}$/.test(positional[0] ?? "")) {
    return fail(context.write, context.json, "check-progress", "usage", "use check-progress <run>", EXIT.usage);
  }
  const run = Number(positional[0]);
  if (!Number.isSafeInteger(run) || context.store.getRun(run) === null) {
    return fail(context.write, context.json, "check-progress", "unknown-run", "no such run", EXIT.refused);
  }
  const progress = context.store.checkProgress(run);
  if (progress === null) {
    return fail(context.write, context.json, "check-progress", "no-progress", "this run has no saved check progress", EXIT.refused);
  }
  return succeed(context.write, context.json, "check-progress", { run, progress }, () => [progress.line]);
}

function revokeCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const repo = positional[0] === undefined ? process.cwd() : resolve(positional[0]);
  const backend = text(flags, "backend") ?? BUILT_IN;

  // No --yes here on purpose: taking permission away is the safe direction,
  // and a confirmation prompt on the brakes is how people stop using them.
  const outgoing = store.grantFor(repo, backend);
  const revoked = store.revokeGrant(repo, backend, mutationFrom(flags, now));
  // Best-effort marker cleanup: a failure leaves a stale label another
  // plane will read as foreign — stated, and repairable there by enroll.
  if (revoked && outgoing?.dispatch === true && outgoing.remoteRepo != null) {
    void ghDispatchAdapter().deleteMarker(outgoing.remoteRepo);
  }
  if (!revoked) {
    return fail(write, json, "revoke", "no-grant", `${repo} was not enrolled for ${backend}`, EXIT.refused);
  }

  return succeed(write, json, "revoke", { repo, backend }, () => [
    `Revoked. ${backend} in ${repo} is read-only again.`,
  ]);
}

/** null when a name was given that is not a mutation class. */
function readMutations(flags: Map<string, string | true>): MutationClass[] | null {
  const given = text(flags, "allow");
  if (given === undefined) return [...DEFAULT_MUTATIONS];

  const wanted = given.split(",").map(one => one.trim()).filter(Boolean);
  if (wanted.some(one => !MUTATION_CLASSES.includes(one as MutationClass))) return null;
  return wanted as MutationClass[];
}

/**
 * What may be written. The built-in store is ours and needs no path, so it
 * gets one implicitly; every other backend has to be told, because guessing
 * where somebody's tracker keeps its data and then writing there is exactly
 * the move this whole module exists to prevent.
 */
function readPaths(flags: Map<string, string | true>, backend: string): string[] {
  const given = text(flags, "paths");
  if (given !== undefined) return given.split(",").map(one => one.trim()).filter(Boolean);
  return backend === BUILT_IN ? [BUILT_IN] : [];
}

// ---- authoring ------------------------------------------------------------

async function statusCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const command = "status";
  const allowed = new Set(["db", "json"]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a status option.`, EXIT.usage);
  }
  if (positional.length > 0) return fail(context.write, context.json, command, "usage", "Use `toolroll status [--json]`.", EXIT.usage);
  // Whose lead the status line follows: the lead's own person, else the remembered login; nobody shows no lead.
  const viewer = currentActor()?.account ?? readLoginFile(join(dirname(context.databaseFile), UP_LOGIN_FILE))?.name ?? null;
  const status = installationStatus(context.store, context.clock(), viewer);
  // One line, only when a newer Toolroll exists; offline or switched off says nothing.
  const current = PACKAGE_VERSION;
  const method = installMethod(context.installBin);
  const release = newerRelease(await latestRelease(dirname(context.databaseFile), { now: context.clock, ...context.releaseIo }), current);
  if (release !== null) notifySecurityRelease(context.store, release, current, method.updateCommand, context.clock());
  const line = updateLine(release, current, method.updateCommand);
  const update = release === null ? {} : { update: { current, latest: release.version, security: release.security, updateCommand: method.updateCommand, url: release.url } };
  // One line when an integration is Broken, from the last checks only: status never waits on a check.
  const brokenIntegrations = await savedIntegrations(context).then(list => list.filter(one => one.state === "broken"), () => []);
  const brokenLine = integrationsBrokenLine(brokenIntegrations);
  const integrations = brokenIntegrations.length === 0 ? {} : { integrations: { broken: brokenIntegrations.map(one => ({ key: one.key, name: one.name, fix: one.action.kind === "fix" ? one.action.words : null })) } };
  // An update waiting, on what, and the action: before anything else, as it holds up new work.
  const waiting = waitingUpdate(context.databaseFile, run => context.store.stopQuiescenceProblem(run) !== null, context.clock());
  const updateWaiting = waiting === null ? {} : { updateWaiting: { app: waiting.app, version: waiting.version, stopped: waiting.stopped, run: waiting.run, on: waiting.on, action: waiting.action } };
  const projects = projectBuildsStatus(context);
  const projectsLine = projects.length === 0 ? null
    : `Builds by project: ${projects.slice(0, 8).map(one => `${one.name} ${one.running} of ${one.limit}`).join(", ")}${projects.length > 8 ? ", …" : ""}`;
  // A Telegram reply written but still not sent after two minutes, with its Retry.
  const unsent = context.store.unsentTelegramReplies(null, null, new Date(context.clock().getTime() - UNSENT_REPLY_MS));
  const unsentLine = unsentRepliesLine(unsent);
  const unsentReplies = unsent.length === 0 ? {} : { unsentReplies: unsent.map(one => ({ ...one, retry: "toolroll bridge telegram retry" })) };
  return succeed(context.write, context.json, command, { ...status, projects, ...update, ...integrations, ...updateWaiting, ...unsentReplies }, () => [...(waiting === null ? [] : [waiting.words]), ...(unsentLine === null ? [] : [unsentLine]), ...renderInstallationStatus(status), ...(projectsLine === null ? [] : [projectsLine]), ...(line === null ? [] : [line]), ...(brokenLine === null ? [] : [brokenLine])]);
}

function unsentRepliesLine(unsent: readonly { since: string; error: string | null }[]): string | null {
  if (unsent.length === 0) return null;
  const oldest = unsent[0]!;
  const what = unsent.length === 1 ? "A Telegram reply hasn't" : `${unsent.length} Telegram replies haven't`;
  return `${what} been sent since ${oldest.since.slice(11, 16)} UTC${oldest.error === null ? "" : ` (${oldest.error})`}. Retry: toolroll bridge telegram retry`;
}

/** Each known project's running builds against its limit: its own number, never past its workers' capacity. */
function projectBuildsStatus(context: Context): { repo: string; name: string; running: number; limit: number }[] {
  const now = context.clock();
  const running = context.store.runningBuildsByRepo(now);
  const saved = savedProjectConcurrency(context.databaseFile);
  const workers = context.store.listRunners().filter(one => one.retiredAt === null);
  const repos = [...new Set([...context.store.listProjects().map(one => one.path), ...context.store.knownRepos(), ...running.keys()])].sort();
  return repos.map(repo => {
    const capacities = workers.filter(one => one.repos.includes(repo)).map(one => one.capacity);
    const setting = saved.get(repo) ?? PROJECT_CONCURRENCY_DEFAULT;
    return { repo, name: projectName(repo), running: running.get(repo) ?? 0, limit: capacities.length === 0 ? setting : effectiveConcurrency(setting, Math.max(...capacities)) };
  });
}

/** Where `integrations` looks: the installation's files beside the database, and every project it knows. */
async function integrationIoFor(context: Context): Promise<IntegrationIo> {
  const registered = await loadProjectRegistry(registryPathOf(context)).catch(() => ({ error: "unreadable" as const }));
  const repos = [...new Set([...("error" in registered ? [] : registered.repos), ...context.store.listProjects().map(one => one.path)])];
  const seams = context.integrationIo ?? {};
  return {
    store: context.store,
    dir: dirname(context.databaseFile),
    telegramTokenFile: context.telegramTokenFile,
    env: process.env,
    repos,
    gh: (file, args, options) => run(file, [...args], options),
    checkConnection: createConnectionChecker(),
    clock: context.clock,
    ...seams,
  };
}

/** The integrations from files and the last checks: no network, for `status` and `onboard`. */
async function savedIntegrations(context: Context): Promise<Integration[]> {
  return integrationsNow(await integrationIoFor(context));
}

/** `toolroll integrations [--json]`: check every integration now and say which work. `--saved` skips the checks. */
async function integrationsCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const command = "integrations";
  const allowed = new Set(["db", "json", "saved"]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not an integrations option.`, EXIT.usage);
  }
  if (positional.length > 0) return fail(context.write, context.json, command, "usage", "Use `toolroll integrations [--saved] [--json]`.", EXIT.usage);
  const io = await integrationIoFor(context);
  const list = flag(flags, "saved") ? integrationsNow(io) : await checkIntegrations(io);
  const counts = { connected: 0, "not-set-up": 0, broken: 0 };
  for (const one of list) counts[one.state] += 1;
  return succeed(context.write, context.json, command, { integrations: list, counts }, () => renderIntegrations(list));
}

async function waitTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const command = "task wait";
  const allowed = new Set(["db", "json", "timeout"]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a task wait option.`, EXIT.usage);
  }
  if (positional.length !== 1) {
    return fail(context.write, context.json, command, "usage", "Use `toolroll task wait <id> [--timeout <seconds>]`.", EXIT.usage);
  }
  const givenTimeout = text(flags, "timeout");
  const timeoutSeconds = givenTimeout === undefined ? null : Number(givenTimeout);
  if (timeoutSeconds !== null && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) {
    return fail(context.write, context.json, command, "usage", "--timeout must be zero or a positive number of seconds.", EXIT.usage);
  }

  const task = positional[0]!;
  const startedAt = Date.now();
  const timeoutMs = timeoutSeconds === null ? null : timeoutSeconds * 1_000;
  const sleep = context.waitSleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let watchedRun: number | undefined;
  while (true) {
    const snapshot = taskWaitSnapshot(context.store, task, context.clock(), watchedRun);
    if (snapshot === null) return fail(context.write, context.json, command, "unknown-task", `No task named ${task}.`, EXIT.failed, { task });
    if (watchedRun === undefined && snapshot.outcome === "Running" && snapshot.run !== null) watchedRun = snapshot.run;
    const data = {
      task: snapshot.task,
      outcome: snapshot.outcome,
      run: snapshot.run,
      replacedRun: snapshot.replacedRun,
      phase: snapshot.phase,
      check: snapshot.check,
      next: snapshot.next,
    };
    if (snapshot.terminal) {
      const line = renderTaskWait(snapshot);
      if (snapshot.exitCode === EXIT.ok) return succeed(context.write, context.json, command, data, () => [line]);
      return fail(context.write, context.json, command, snapshot.reason ?? "failed", line, EXIT.failed, data);
    }
    const elapsed = Date.now() - startedAt;
    if (timeoutMs !== null && elapsed >= timeoutMs) {
      const line = renderTaskWait(snapshot, "Timed out");
      return fail(context.write, context.json, command, "timeout", line, EXIT.usage, { ...data, outcome: "Timed out" });
    }
    const remaining = timeoutMs === null ? 250 : Math.max(1, Math.min(250, timeoutMs - elapsed));
    await sleep(remaining);
  }
}

function taskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number | Promise<number> {
  const [action, ...rest] = positional;

  // `task` on its own is somebody asking what this can do, not a mistake.
  if (action === undefined) {
    context.write(OPERATE_HELP);
    return EXIT.ok;
  }

  // The lead's work on a task it took on counts as acting on it (lead-voice.ts): its claim stays fresh.
  const actor = currentActor();
  if (actor?.lead === true && rest[0] !== undefined && LEAD_WORK_VERBS.has(action)) {
    const noted = (code: number): number => { if (code === EXIT.ok) noteLeadWork(context.store, actor, rest[0]!, action, context.clock()); return code; };
    const done = taskAction(action, rest, flags, context);
    return typeof done === "number" ? noted(done) : done.then(noted);
  }
  return taskAction(action, rest, flags, context);
}

/** Task verbs that are the lead working on a task, not reading it. */
const LEAD_WORK_VERBS: ReadonlySet<string> = new Set(["state", "steer", "reopen", "requeue", "regate", "repair", "resume", "stop", "scope", "approve", "plan", "checks", "revise", "hold", "unhold", "route", "require"]);

function taskAction(
  action: string,
  rest: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number | Promise<number> {
  switch (action) {
    case "complete":
    case "revise":
      return runTaskOutcomeCommand(action, rest, flags, { ...context, operator: async () => {
        const acting = await askCredentials(flags, context);
        if (acting === null) return null;
        const authenticated = verifyApproverByPassword(context.store, acting.name, acting.token, context.store.knownRepos().filter(repo => context.store.accountCanAccess(acting.name, repo)));
        return authenticated.ok ? authenticated.who : null;
      } });
    case "merge":
      return runTaskMergeCommand(rest, flags, { store: context.store, json: context.json, write: context.write, clock: context.clock,
        demo: context.store.isDemo(), credentials: () => askCredentials(flags, context), ...(context.publishExec === undefined ? {} : { exec: context.publishExec }) });
    case "add":
      return addTask(rest, flags, context);
    case "checks":
      return runTaskChecks(rest, flags, context);
    case "add-tests":
      return addTestsTask(rest, flags, context);
    case "list":
      return listTasks(flags, context);
    case "show":
      return showTask(rest, context);
    case "wait":
      return waitTask(rest, flags, context);
    case "evidence":
      return taskEvidenceCommand(rest, flags, context);
    case "state":
      return stateTask(rest, flags, context);
    case "ask":
      return askTask(rest, flags, context);
    case "block":
      return blockTask(rest, flags, context);
    case "unblock":
      return unblockTask(rest, flags, context);
    case "next":
      return nextTask(rest, flags, context);
    case "steer":
      return steerTask(rest, flags, context);
    case "assign":
      return assignTask(rest, flags, context);
    case "reopen":
      return reopenTask(rest, flags, context);
    case "scope":
      return scopeTask(rest, flags, context);
    case "approve":
      return approveTask(rest, flags, context);
    case "hold":
      return holdTask(rest, flags, context);
    case "unhold":
      return unholdTask(rest, flags, context);
    case "stop":
      return stopTaskCommand(rest, flags, context);
    case "resume":
      return resumeTaskCommand(rest, flags, context);
    case "require":
      return requireTask(rest, flags, context);
    case "requeue":
      return requeueTask(rest, flags, context);
    case "regate":
      return regateTaskCommand(rest, flags, context);
    case "plan":
      return planTaskCommand(rest, flags, context);
    case "review":
      return reviewTaskCommand(rest, flags, context);
    case "accept":
      return acceptTaskProof(rest, flags, context);
    case "repair":
      return repairTaskCommand(rest, flags, context);
    case "route":
      return routeTaskCommand(rest, flags, context);
    default:
      return fail(
        context.write,
        context.json,
        "task",
        "usage",
        `unknown \`task ${action ?? ""}\` — try ${TASK_ACTIONS.join(", ")}`,
        EXIT.usage,
      );
  }
}

async function addTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const title = positional.join(" ").trim();
  if (title === "") return fail(write, json, "task add", "usage", "a task needs a title", EXIT.usage);
  // --checks quick|full|off: this task's checks, overriding the project's level.
  const checks = text(flags, "checks");
  if (checks !== undefined && !isCheckLevel(checks)) return fail(write, json, "task add", "usage", "--checks is quick, full or off", EXIT.usage);
  // The same text rules every filing door applies (Codex adoption review,
  // finding 7): the bare CLI path must not accept a title the console or a
  // template would refuse.
  const badText = validateTaskText({ title });
  if (badText !== null) return fail(write, json, "task add", badText.reason, badText.message, EXIT.usage);

  const backendName = text(flags, "backend") ?? BUILT_IN;
  // A scout task lives in the built-in backend (v4 review, finding 2):
  // the deliverable is a column on OUR task_ref, stamped in the same
  // transaction as the filing — a tracker's item has no such promise.
  if (flags.has("report") && backendName !== BUILT_IN) {
    return fail(write, json, "task add", "usage", "--report files a scout task in the built-in backend only — drop --backend", EXIT.usage);
  }
  if (backendName !== BUILT_IN) {
    const repo = repoFrom(flags);
    const backend = openBackend(backendName, store, repo);
    if (backend === null) {
      return fail(write, json, "task add", "usage", `no backend \`${backendName}\``, EXIT.usage);
    }

    const created = await backend.create({ title });
    if (!created.ok) {
      // A denial is a refusal, not a breakage: the tool worked exactly as
      // asked and the answer is that permission was never given.
      const code = created.reason === "denied" ? EXIT.refused : EXIT.failed;
      return fail(write, json, "task add", created.reason, created.message, code);
    }

    // Created through Toolroll, so it is ours — recorded here rather than
    // asserted later, which is what the grant's default selector rests on.
    store.refFor(backendName, created.value, "ours");
    // With a dispatch grant standing, the created item ALSO becomes a local
    // mirror (provenance local-create) — established at creation, the only
    // moment "we made this" is a fact rather than a claim (v3 §4).
    const dispatchGrant = store.grantFor(repoFrom(flags), backendName);
    let mirrored: string | null = null;
    if (backendName === "github-issues" && dispatchGrant?.dispatch === true && dispatchGrant.remoteRepo != null) {
      const localId = mirrorTaskId(dispatchGrant.remoteRepo, created.value);
      const made = store.transact(() => {
        const filed = fileTaskProposal(store, { id: localId, title, repo: dispatchGrant.repo, filedVia: "cli" }, now);
        if (!filed.ok) return filed;
        const established = store.establishMirror(
          {
            localTaskId: filed.id,
            backend: backendName,
            remoteRepo: dispatchGrant.remoteRepo as string,
            remoteId: created.value,
            provenance: "local-create",
            establishedBy: "cli",
          },
          now,
        );
        if (!established.ok) throw new Error(`mirror not established: ${established.reason}`);
        return filed;
      });
      if (made.ok) mirrored = made.id;
    }
    return succeed(write, json, "task add", { id: created.value, backend: backendName, ...(mirrored === null ? {} : { mirror: mirrored }) }, () => [
      `Filed ${created.value} in ${backendName}.`,
      ...(mirrored === null ? [] : [`Mirrored locally as ${mirrored} — scope and approve it, and this plane builds it.`]),
    ]);
  }

  const id = text(flags, "id") ?? slug(title, now);
  // Re-filing: the new task replaces an earlier one, which is cancelled and reads "Replaced by <id>".
  const replaces = text(flags, "replaces");
  if (replaces !== undefined && (replaces === id || store.getTask(replaces) === null)) {
    return fail(write, json, "task add", "unknown-task", `no task \`${replaces}\` to replace`, EXIT.refused);
  }
  noteActingPerson(flags, context);

  // The existence check goes *inside* the replayed body. Outside it, a retry
  // with the same key hits "already exists" and reports failure for a task the
  // first attempt created — which is precisely the retry idempotency exists to
  // make safe. The inner createTask takes no key of its own, so only this
  // outer result is recorded, and only when it succeeded.
  const outcome = store.replay(
    mutationFrom(flags, now),
    "task add",
    () => {
      if (store.getTask(id) !== null) return { ok: false as const };
      // The deliverable rides the SAME transaction as the filing (v4
      // review, finding 2): a crash can never leave a scout ask as a
      // branch task.
      return { ok: true as const, task: store.createTask({ id, title, ...(flags.has("report") ? { deliverable: "report" as const } : {}) }, now) };
    },
    result => result.ok,
  );

  if (!outcome.ok) {
    return fail(write, json, "task add", "exists", `\`${id}\` already exists`, EXIT.refused);
  }

  store.stampFiledVia(store.refFor(BUILT_IN, id).id, "cli");

  // Placement is explicit, never inferred from where the command happened to
  // run: a task filed from the wrong directory would silently bind to it.
  const placedIn = text(flags, "repo");
  if (placedIn !== undefined) {
    const placed = store.placeTask(store.refFor(BUILT_IN, id).id, canonicalProject(placedIn) ?? resolve(placedIn));
    if (typeof placed === "object" && !placed.ok) {
      return fail(write, json, "task add", "scoped", "this task already has a scope — placement is immutable once somebody could have approved it", EXIT.refused);
    }
  }

  if (replaces !== undefined) store.setTaskState(replaces, "cancelled", now, {}, undefined, outcome.task.id);

  if (checks !== undefined) {
    const chosen = setTaskCheckLevel(store, outcome.task.id, checks, "cli", now);
    if (!chosen.ok) return fail(write, json, "task add", "checks-fixed", chosen.message, EXIT.refused);
  }
  const link = consoleLinkFor(context, `/t/${encodeURIComponent(outcome.task.id)}`);
  return succeed(
    write,
    json,
    "task add",
    {
      task: outcome.task,
      ...(replaces === undefined ? {} : { replaces }),
      repo: placedIn === undefined ? null : resolve(placedIn),
      ...(checks === undefined ? {} : { checks }),
      ...(link === null ? {} : { links: { task: link } }),
    },
    () => [`Queued ${outcome.task.id} — ${outcome.task.title}${flags.has("report") ? " (a scout task: it delivers a report)" : ""}${checks === undefined ? "" : ` · checks: ${CHECK_LEVEL_WORDS[checks]}`}`, ...(replaces === undefined ? [] : [`  It replaces ${replaces}.`]), ...(link === null ? [] : [`  ${link}`])],
  );
}

/** The newest finished build result of a task (any version), for follow-ups. */
function latestBuildResult(store: Store, taskId: string): { runId: number; head: string } | null {
  const family = store.taskFamilyOf(taskId, null, true);
  const versions = family === null ? [taskId] : [family.current.id, ...family.versions.map(one => one.id).filter(id => id !== family.current.id)];
  for (const id of versions) {
    const ref = store.lookupRef(id);
    const run = ref === null ? undefined : store.runsFor(ref.id).find(one => one.role === "builder" && one.finishedAt !== null && one.headRevision !== null);
    if (run !== undefined) return { runId: run.id, head: run.headRevision! };
  }
  return null;
}

/**
 * `toolroll task checks <task> [--level quick|full]` — Run checks on the
 * result's exact commit, now, in the foreground. A pass upgrades what the
 * result says; a failure stays visible. Asking again while one runs is the same ask.
 */
async function runTaskChecks(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json } = context;
  const clock = context.clock ?? (() => new Date());
  const taskId = positional[0];
  if (taskId === undefined) return fail(write, json, "task checks", "usage", "`toolroll task checks <task> [--level quick|full]`", EXIT.usage);
  const level = text(flags, "level") ?? "quick";
  if (level !== "quick" && level !== "full") return fail(write, json, "task checks", "usage", "--level is quick or full", EXIT.usage);
  const demoFence = refuseDemo(context, "task checks");
  if (demoFence !== null) return demoFence;
  const result = latestBuildResult(store, taskId);
  if (result === null) return fail(write, json, "task checks", "no-result", `${taskId} has no finished result to check`, EXIT.refused);
  const asked = requestFollowUpChecks(store, { runId: result.runId, level, actor: "cli" }, clock());
  if (!asked.ok) return fail(write, json, "task checks", asked.reason, asked.message, EXIT.refused);
  const done = await runFollowUpCheck(store, context.evidenceRoot, asked.request, { now: clock });
  const state = done?.state ?? "waiting";
  const words = `${CHECK_LEVEL_WORDS[asked.level]} checks`;
  const payload = { task: taskId, run: result.runId, head: result.head, request: asked.request, level: asked.level, state, exitCode: done?.exitCode ?? null };
  if (state === "failed") {
    if (json) { write(envelopeJson({ ok: false, command: "task checks", reason: "checks-failed", ...payload })); return EXIT.failed; }
    write(`${words} failed on ${result.head.slice(0, 7)}${done?.exitCode == null ? "" : ` (exit ${done.exitCode})`}. The result shows the failure.`);
    return EXIT.failed;
  }
  return succeed(write, json, "task checks", payload, () => [
    state === "passed" ? `${words} passed on ${result.head.slice(0, 7)}. The result's status is upgraded.`
      : state === "running" ? `${words} are already running on ${result.head.slice(0, 7)}.`
      : state === "not-run" ? `${words} didn't run: ${done?.note ?? "see the result's log"}`
      : `${words} are queued on ${result.head.slice(0, 7)}.`,
  ]);
}

/** `toolroll task add-tests <task>` — file a small task to write tests for its change. */
function addTestsTask(positional: readonly string[], _flags: Map<string, string | true>, context: Context): number {
  const { store, write, json, now } = context;
  const taskId = positional[0];
  if (taskId === undefined) return fail(write, json, "task add-tests", "usage", "`toolroll task add-tests <task>`", EXIT.usage);
  const result = latestBuildResult(store, taskId);
  if (result === null) return fail(write, json, "task add-tests", "no-result", `${taskId} has no finished result to write tests for`, EXIT.refused);
  const filed = fileAddTestsTask(store, context.evidenceRoot, { runId: result.runId, actor: "cli", filedVia: "cli" }, now);
  if (!filed.ok) return fail(write, json, "task add-tests", filed.reason, filed.message, EXIT.refused);
  return succeed(write, json, "task add-tests", { task: taskId, filed: filed.id, existing: filed.existing }, () => [
    filed.existing ? `Tests for ${taskId} are already filed as ${filed.id}.` : `Filed ${filed.id} to add tests for ${taskId}. Approve its scope to start.`,
  ]);
}

/**
 * Say what a task needs before it may run: capability keys, `kind:name`.
 *
 * Keys are qualified because names are not identities — `env:supabase` and
 * `mcp:supabase` are different facts about a machine, and a requirement that
 * names only "supabase" would verify against whichever one answered first.
 * The given list replaces the old one; requirements are a statement, not a
 * pile of appends.
 */
function requireTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  const given = text(flags, "cap");
  if (id === undefined || given === undefined) {
    return fail(write, json, "task require", "usage", "`toolroll task require <id> --cap <kind:name>[,<kind:name>]` — or --cap none to clear", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task require", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const keys = given === "none" ? [] : given.split(",").map(one => one.trim()).filter(Boolean);
  for (const key of keys) {
    if (parseCapabilityKey(key) === null) {
      return fail(write, json, "task require", "usage", `\`${key}\` is not a capability key — say kind:name, like env:SUPABASE_KEY or cli:gh`, EXIT.usage);
    }
  }

  store.setRequirements(store.refFor(BUILT_IN, id).id, keys, mutationFrom(flags, now));

  return succeed(write, json, "task require", { id, requirements: keys }, () => [
    keys.length === 0
      ? `${id} requires nothing.`
      : `${id} now requires: ${keys.join(", ")}. Nothing dispatches it until every one is verified.`,
  ]);
}

// ---- capabilities ---------------------------------------------------------

/**
 * What a repo's work needs from the machine it runs on — recorded, probed,
 * and never valued. `cap add` stores an operator-authored probe; `cap probe`
 * asks the environment; verification is a stamped claim about this machine
 * at that moment. There is deliberately no `cap verify --yes`: presence is
 * not enough and an assertion is even less, so a capability nothing can
 * probe stays a visible gap instead of becoming a quiet lie.
 */
async function capCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, name] = positional;
  const repo = repoFrom(flags);

  if (action === "add") {
    if (name === undefined) {
      return fail(write, json, "cap add", "usage", "`toolroll cap add <name> [--kind env|cli|mcp|ci|other] [--probe <cmd>] [--expires <iso>]`", EXIT.usage);
    }
    const kind = (text(flags, "kind") ?? "env") as CapabilityKind;
    if (!["env", "cli", "mcp", "ci", "other"].includes(kind)) {
      return fail(write, json, "cap add", "usage", "--kind takes env, cli, mcp, ci or other", EXIT.usage);
    }

    // An env capability can have its probe synthesized from a fixed template
    // — but only over a validated identifier, because the name lands inside
    // a shell line. Anything else the operator writes explicitly.
    let probe = text(flags, "probe") ?? null;
    if (probe === null && kind === "env") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return fail(write, json, "cap add", "usage", `\`${name}\` is not an environment variable name — give --probe explicitly`, EXIT.usage);
      }
      probe = `test -n "$${name}"`;
    }

    const expires = text(flags, "expires") ?? null;
    store.saveCapability(
      {
        repo,
        kind,
        name,
        probe,
        status: "unprobed",
        addedBy: `operator@${hostname()}`,
        createdAt: clock().toISOString(),
        lastVerifiedAt: null,
        verifiedBy: null,
        lastResult: null,
        expiresAt: expires,
      },
      mutationFrom(flags, clock()),
    );
    return succeed(write, json, "cap add", { repo, kind, name, probe }, () => [
      `Recorded ${kind}:${name} for ${repo}.`,
      probe === null
        ? "No probe — nothing can verify it, so it will stand as a gap until it has one."
        : `Probe: ${probe}`,
      "Nothing is verified yet: `toolroll cap probe`.",
    ]);
  }

  if (action === "list" || action === undefined) {
    const capabilities = store.listCapabilities(repo);
    if (json) {
      write(envelopeJson({ ok: true, command: "cap list", repo, capabilities }));
      return EXIT.ok;
    }
    if (capabilities.length === 0) {
      write(`No capabilities recorded for ${repo}. \`toolroll cap add\` or \`cap scan\`.`);
      return EXIT.ok;
    }
    for (const one of capabilities) {
      const state = describeCapability(one, clock());
      write(`  ${`${one.kind}:${one.name}`.padEnd(32)} ${state}`);
    }
    return EXIT.ok;
  }

  if (action === "scan") {
    const report = scanRepo(repo);
    let recorded = 0;
    for (const one of report.found) {
      // Scan proposes; it never overwrites. A capability the operator wrote
      // — or a probe they tuned — outranks anything a file implies.
      if (store.getCapability(repo, one.kind, one.name) !== null) continue;
      store.saveCapability({
        repo,
        kind: one.kind,
        name: one.name,
        probe: one.probe,
        status: "unprobed",
        addedBy: `scan:${one.source}`,
        createdAt: clock().toISOString(),
        lastVerifiedAt: null,
        verifiedBy: null,
        lastResult: null,
        expiresAt: null,
      });
      recorded++;
    }
    if (json) {
      write(envelopeJson({ ok: true, command: "cap scan", repo, recorded, ...report }));
      return EXIT.ok;
    }
    if (report.found.length === 0) {
      write(`Nothing detected in ${repo}. Detection reads .env.example, .mcp.json, supabase/config.toml and workflow files.`);
      return EXIT.ok;
    }
    for (const one of report.found) {
      write(`  ${`${one.kind}:${one.name}`.padEnd(32)} ${one.source}${one.probe === null ? "  (no probe)" : ""}`);
    }
    for (const bad of report.rejected) {
      write(`  rejected ${bad.name} from ${bad.source} — not a valid identifier`);
    }
    write("");
    write(`${recorded} new, ${report.found.length - recorded} already recorded. Nothing is verified: \`toolroll cap probe\`.`);
    return EXIT.ok;
  }

  if (action === "probe") {
    const only = positional.slice(1);
    for (const key of only) {
      if (parseCapabilityKey(key) === null) {
        return fail(write, json, "cap probe", "usage", `\`${key}\` is not a capability key — say kind:name`, EXIT.usage);
      }
    }
    const outcomes = await probeRepo(store, repo, `operator@${hostname()}`, clock(), {
      ...(only.length === 0 ? {} : { only: new Set(only) }),
    });
    if (outcomes.length === 0) {
      return fail(write, json, "cap probe", "empty", `nothing to probe for ${repo}`, EXIT.refused);
    }

    const unverified = outcomes.filter(one => one.status !== "verified");
    const lines = () =>
      outcomes.map(one =>
        `  ${`${one.kind}:${one.name}`.padEnd(32)} ${one.status}${one.detail === undefined ? "" : `  ${one.detail}`}`,
      );
    if (json) {
      write(envelopeJson({ ok: true, command: "cap probe", repo, outcomes }));
    } else {
      write(lines().join("\n"));
    }
    // All yes is 0; any no is 3 — a caller scripting "probe, then tick" needs
    // to branch on the answer without parsing prose.
    return unverified.length === 0 ? EXIT.ok : EXIT.refused;
  }

  return fail(write, json, "cap", "usage", `unknown \`cap ${action}\` — try add, list, scan, probe`, EXIT.usage);
}

function listTasks(flags: Map<string, string | true>, context: Context): number {
  const { store, write, json, now } = context;
  const wanted = text(flags, 'state');
  const rawView = text(flags, 'view');
  const rawLimit = text(flags, 'limit');
  const limit = rawLimit === undefined ? 40 : Number(rawLimit);
  if (wanted !== undefined && !STATES.includes(wanted as TaskState)) {
    return fail(write, json, 'task list', 'usage', `--state takes one of ${STATES.join(', ')}`, EXIT.usage);
  }
  if (rawView !== undefined && !['all', 'needs-you', 'running', 'completed'].includes(rawView) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return fail(write, json, 'task list', 'usage', '--view takes all, needs-you, running or completed; --limit takes 1–100', EXIT.usage);
  }
  let page;
  try {
    page = workIndexPage(store, now, { principal: 'operator', repos: null, includeUnplaced: true }, {
      view: parseWorkView(rawView ?? null), limit, cursor: text(flags, 'cursor') ?? null,
      ...(wanted === undefined ? {} : { state: wanted as TaskState }),
      ...(text(flags, 'repo') === undefined ? {} : { project: text(flags, 'repo')! }),
    });
  } catch (error) {
    if (!(error instanceof WorkIndexCursorError)) throw error;
    return fail(write, json, 'task list', 'usage', 'Invalid page cursor. Start again without --cursor.', EXIT.usage);
  }
  const tasks = page.items.map(item => ({ ...item, id: item.rootId }));
  if (json) {
    write(envelopeJson({ ok: true, command: 'task list', count: tasks.length, tasks,
      totals: page.totals, nextCursor: page.nextCursor, limit: page.limit, view: page.view, evidence: 'recorded' }));
    return EXIT.ok;
  }
  if (tasks.length === 0) write(wanted === undefined ? 'The task list is empty.' : `Nothing is ${wanted}.`);
  const width = Math.max(0, ...tasks.map(task => task.id.length));
  for (const task of tasks) write(`  ${task.id.padEnd(width)}  ${task.status.label.padEnd(16)}  ${task.title}`);
  if (page.nextCursor !== null) write(`Next page: --cursor ${page.nextCursor}`);
  return EXIT.ok;
}

function showTask(positional: readonly string[], context: Context): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  if (id === undefined) return fail(write, json, "task show", "usage", "which task?", EXIT.usage);

  const task = store.getTask(id);
  if (task === null) return fail(write, json, "task show", "unknown-task", `no task \`${id}\``, EXIT.refused);

  const ref = store.refFor(BUILT_IN, id);
  const scope = store.getScope(id);
  const runs = store.runsFor(ref.id);
  // v40 fix: a reviewer run finishes after the build it reviews and
  // carries no proof verdict of its own — excluded so its outcome never
  // hijacks the task's own reported verdict.
  const latestFinished = runs.find(one => one.finishedAt !== null && (one.role === "builder" || one.role === "scout")) ?? null;
  const proofVerdict = latestFinished === null ? null : store.proofVerdictFor(latestFinished.id);
  const proofAccepted = latestFinished !== null && store.proofAcceptance(latestFinished.id) !== null;
  // The route (v47), from the ONE projection every surface renders, with
  // whatever readiness this task's runners have reported.
  const routed = routeOfTask(store, id, ref, now);
  const readiness = store.readinessLookupFor(ref.repo, ref.assignedRunner, now);
  const detail = {
    task,
    work: taskWorkSummaryOf(store, id, now, { principal: "operator", repos: null, includeUnplaced: true }),
    assignment: assignmentBrief(assignmentOf(store, id, now, { principal: "operator", repos: null, includeUnplaced: true }, context.evidenceRoot)),
    ref: ref.id,
    blockedBy: store.blockers(id),
    position: store.queuePosition(id),
    reservedFor: ref.assignedRunner,
    hold: store.activeHold(ref.id, now),
    claim: currentClaim(store, ref.id, now),
    scope,
    approval: approvalOf(scope),
    risk: ref.riskLevel ?? scope?.riskLevel ?? "routine",
    route: taskRouteView(routed, readiness),
    runs: runs.map(one => ({ ...one, route: store.runRoute(one.id) })),
    deliverable: ref.deliverable,
    report: readVerifiedReport(store, context.evidenceRoot, ref.id),
    proofVerdict: proofVerdict?.verdict ?? null,
    proofReasons: proofVerdict?.reasons ?? [],
    proofMatrix: proofVerdict?.matrix ?? [],
    proofAccepted,
    // v51: semantic coverage — what an independent reviewer settled under
    // the run's signed policy, with every context gap named — the same
    // projection the console prints, never re-derived here.
    semanticCoverage: latestFinished === null ? null : semanticCoverage(proofVerdict?.matrix ?? [], latestFinished.qualityMode ?? "default"),
    // v50: the latest build's bounded review history — every root attempt
    // in order, the open request, and the one state they add up to.
    review: latestFinished === null ? null : store.reviewRetryStateOf(latestFinished.id),
    // The one automatic review of the latest build: HIGH findings, suggested
    // follow-ups (MEDIUM/LOW), or why it was not reviewed.
    automaticReview: latestFinished === null ? null : buildReviewOf(store, latestFinished.id),
    dispatch: diagnoseTaskDispatch(store, id, now),
    // v52: the exact-run control the console shows — Stop, Stopping,
    // Paused (resume), or the review-retry door — and every stop on record.
    control: taskControlOf(store, ref.id, now),
    stops: store.stopsForTask(ref.id),
    // The pull request Complete opened (any version), with its CI state and merge commit — the console's view.
    pullRequest: newestPullRequestOf(store, store.taskFamilyOf(id, null, true)?.versions.map(one => one.id) ?? [id]),
  };

  return succeed(write, json, "task show", detail, () => [
    `${task.id}  ${task.state}${ref.deliverable === "report" ? "  (scout — delivers a report)" : ""}`,
    `  ${task.title}`,
    ...(detail.work === null ? [] : [
      `  status: ${detail.work.status.label}`,
      ...(detail.work.primaryAction === null ? [] : [`  next: ${detail.work.primaryAction.label}${detail.work.primaryAction.target.decisionId === null ? "" : ` — decision #${detail.work.primaryAction.target.decisionId}`}`]),
    ]),
    // The closed machine-authored verdict (Priority 2), computed once at
    // completion — never re-derived here. Same words `verdictWords`
    // gives every other surface, so the CLI and the console agree.
    ...(task.state !== "done" || detail.proofVerdict === null
      ? []
      : [
          `  proof: ${proofVerdictWords(detail.proofVerdict, detail.proofReasons).word}${detail.proofAccepted ? " (accepted)" : ""}`,
          ...(detail.proofReasons.length > 0 ? [`    ${detail.proofReasons.join("; ")}`] : []),
          ...matrixWords(detail.proofMatrix),
          ...(detail.semanticCoverage === null ? [] : coverageWords(detail.semanticCoverage).map(line => `  ${line}`)),
        ]),
    ...(detail.report === null
      ? []
      : detail.report.ok
        ? [
            `  report: ${detail.report.report.title} (run ${detail.report.run})`,
            `    ${detail.report.report.summary}`,
            ...detail.report.report.followUps.map((one, index) => `    follow-up ${index + 1}: ${one.title}`),
          ]
        : [`  report: ${detail.report.problem} (run ${detail.report.run})`]),
    ...pullRequestLines(detail.pullRequest),
    ...(detail.blockedBy.length > 0 ? [`  waits for ${detail.blockedBy.join(", ")}`] : []),
    ...(detail.position === null
      ? []
      : [`  position  ${detail.position.position} of ${detail.position.total}${detail.position.column === null ? " in the shared queue" : ` in ${detail.position.column}'s queue`}`]),
    ...(detail.hold === null ? [] : [`  held: ${detail.hold.reason}`]),
    ...(detail.claim === null ? [] : [`  claimed by ${detail.claim.runner} until ${detail.claim.expiresAt}`]),
    ...(detail.dispatch === null ? [] : [`  dispatch: ${detail.dispatch.summary} — ${detail.dispatch.detail}`]),
    ...(detail.control.kind === "none"
      ? []
      : detail.control.kind === "stop"
        ? [`  control: run #${detail.control.run} is live — \`task stop ${task.id} --run ${detail.control.run} --as <you> --token <t>\``]
        : detail.control.kind === "stopping"
          ? [`  control: run #${detail.control.run} is stopping (asked by ${detail.control.stop.requestedBy} at ${detail.control.stop.requestedAt})${detail.control.unsettledRun ? " — its processes are not yet established gone" : " — the run ended but the stop is unsettled; needs attention"}`]
          : detail.control.kind === "paused"
            ? [`  control: paused — run #${detail.control.run} was stopped by ${detail.control.stop.requestedBy} (${detail.control.stop.settlement ?? "?"})${detail.control.committed ? "; its commit is on the branch" : ""}; work preserved${detail.control.worktree === null ? "" : ` in ${detail.control.worktree}`} — \`task resume ${task.id} --run ${detail.control.run} --as <you> --token <t>\``]
            : [`  control: review #${detail.control.run} was stopped by ${detail.control.stop.requestedBy} — inspect its saved result and give feedback; separate model review has been removed`]),
    ...(detail.automaticReview === null ? reviewStatusLines(detail.review, latestFinished?.id ?? null) : buildReviewLines(detail.automaticReview)),
    ...(scope === null
      ? ["  no scope — nothing will build this until one is written and approved"]
      : describeScope(scope, readiness)),
    ...planContractLines(store, context.evidenceRoot, id),
    // The route's standing (v47): sealed, proposed, legacy, or unreadable —
    // the projection itself is in describeScope's lines above.
    ...taskRouteStandingLines(id, routed),
    // Provenance per run (v47): the actual provider and model each phase
    // spent as, and the route it spent under.
    ...detail.runs
      .filter(one => one.route !== null)
      .slice(0, 8)
      .map(one => `  run #${one.id}  ${one.role.padEnd(8)} ${one.route!.provider}${one.route!.model === null ? "" : ` · ${one.route!.model}`}  [${one.route!.chosen}] route ${one.route!.routeDigest}`),
  ]);
}

/** The review status lines `task show` prints (v50): the state word, the
 * attempt count against the fixed cap, every root attempt's outcome, and
 * the one explicit next act — never an automatic one. */
function reviewStatusLines(review: ReviewRetryState | null, sourceRun: number | null): string[] {
  if (review === null || sourceRun === null || review.state === "unrequested") return [];
  const word: Record<ReviewRetryState["state"], string> = {
    unrequested: "not requested",
    queued: "legacy request retained; the worker will close it without running a model review",
    running: `running — attempt ${review.live?.attempt ?? review.attempts.length} of ${review.cap}`,
    succeeded: `succeeded on attempt ${review.succeeded?.attempt ?? 1} of ${review.cap}`,
    retryable: `${review.latest?.outcome === "interrupted" || review.latest?.reason === "interrupted" ? "interrupted" : "failed"} on attempt ${review.latest?.attempt ?? review.attempts.length} of ${review.cap} — inspect the saved result; model reviews no longer retry`,
    exhausted: `exhausted — all ${review.cap} attempts ended without a review; nothing retries a fourth time`,
  };
  const first = review.state === "queued" && review.attempts.length === 0 ? "queued — waiting for a worker" : word[review.state];
  return [
    `  review: ${first}`,
    ...review.attempts.map(one => `    attempt ${one.attempt}: run #${one.runId} ${one.outcome === null ? "open" : one.outcome === "no-change" ? "reviewed" : `${one.outcome}${one.reason === null ? "" : ` (${one.reason})`}`}`),
  ];
}

/** The route as `task show` / `task route --json` report it (v47): one
 * projection for a routed task, the sealed profile for a proven pre-routing
 * row, the words for an unreadable one — never a guess dressed as a route. */
function taskRouteView(routed: TaskRoute | null, readiness: ReadinessLookup): Record<string, unknown> | null {
  if (routed === null) return null;
  if (routed.kind === "route") return { kind: "route", source: routed.source, ...projectRoute(routed.route, readiness) };
  if (routed.kind === "legacy") {
    return { kind: "legacy", source: "legacy", approved: routed.approved, profile: { provider: routed.profile.provider, model: routed.profile.model, repairModel: routed.profile.repairModel === "inherit" ? routed.profile.model : routed.profile.repairModel } };
  }
  return { kind: "unreadable", source: null, problem: routed.problem };
}

function taskRouteStandingLines(id: string, routed: TaskRoute | null): string[] {
  if (routed === null) return [];
  if (routed.kind === "route") {
    return [`  agents       ${routed.source === "approved" ? "sealed by the approval — configuration changes cannot reroute it" : routed.source === "proposed" ? "proposed — the next approval seals them" : "recommended live — no scope filed yet"}`];
  }
  if (routed.kind === "legacy") {
    return [`  agents       approved before agent routing existed — ${routed.profile.provider} · ${routed.profile.model} builds and repairs (repair model ${routed.profile.repairModel === "inherit" ? routed.profile.model : routed.profile.repairModel}); the planner and reviewer resolve from configuration at run time`];
  }
  return [`  agents       UNREADABLE — ${routed.problem}`, `               nothing runs for ${id} until its scope is re-filed and approved again`];
}

/**
 * `task accept <id>` (Priority 2): the operator's explicit acceptance of a
 * short or refuted proof verdict — the one act that lets the task read
 * done despite incomplete evidence. Credentialed like approving a scope:
 * accepting bad news is still authority.
 */
async function acceptTaskProof(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const id = positional[0];
  if (id === undefined) return fail(write, json, "task accept", "usage", "`toolroll task accept <id> [--note <text>] --as <you> --token <t>`", EXIT.usage);

  const task = store.getTask(id);
  if (task === null) return fail(write, json, "task accept", "unknown-task", `no task \`${id}\``, EXIT.refused);

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task accept", "usage", "accepting incomplete proof is a person's act — it takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, "task accept", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }

  const ref = store.refFor(BUILT_IN, id);
  // v40 fix: a reviewer run is never the attempt whose proof is accepted.
  const latest = store.runsFor(ref.id).find(
    one => one.finishedAt !== null && (one.role === "builder" || one.role === "scout"),
  );
  if (latest === undefined) {
    return fail(write, json, "task accept", "no-run", `${id} has no finished attempt to accept`, EXIT.refused);
  }
  const rawNote = text(flags, "note");
  let note: string | null = null;
  if (rawNote !== undefined && rawNote.trim() !== "") {
    const validated = validateNote(rawNote);
    if (!validated.ok) return fail(write, json, "task accept", "invalid", validated.problem, EXIT.usage);
    note = validated.note;
  }
  store.acceptProof(latest.id, acting.name, note, now);
  return succeed(write, json, "task accept", { id, run: latest.id, acceptedBy: acting.name }, () => [
    `Accepted: ${id}'s build #${latest.id} reads done despite its proof, on ${acting.name}'s say-so.`,
  ]);
}

/**
 * `task repair <run-id>` (v40, evidence-review-v1) — the first CLI road to
 * a revision at all. Reads the chain the trigger already drafted for that
 * source run; `--yes` approves it, the same act `approve()` already offers
 * on any scope. For a historical review missing observations, authenticated
 * --yes with the exact repository can invoke the same bounded draft trigger.
 */
async function repairTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [runText] = positional;
  const runId = Number(runText ?? "");
  if (runText === undefined || !Number.isInteger(runId) || runId < 1) {
    return fail(write, json, "task repair", "usage", "`toolroll task repair <run-id> [--yes] --as <you> --token <t>`", EXIT.usage);
  }
  let chain = store.repairChainFor(runId);
  if (chain === null && flags.get("yes") === true) {
    const acting = await askCredentials(flags, context);
    if (acting === null) return fail(write, json, "task repair", "usage", "Evidence collection requires --as and --token.", EXIT.usage);
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) return fail(write, json, "task repair", authenticated.reason, describeApproveFailure(authenticated.reason, String(runId)), EXIT.refused);
    const run = store.getRun(runId), proof = store.proofVerdictFor(runId);
    const repo = run && store.refById(run.taskRef)?.repo;
    if (repo && repo === repoFrom(flags) && proof?.matrix.some(row => row.assessment && row.review?.judgement === "cannot-tell") &&
        !proof.matrix.some(row => row.review?.judgement === "contradicts")) {
      maybeTriggerRepair(store, repo, context.evidenceRoot, runId, proof.verdict, clock());
      chain = store.repairChainFor(runId);
    }
  }
  if (chain === null) {
    return fail(write, json, "task repair", "unknown-task", `run ${runId} has no drafted repair — a repair is only drafted after a review names unmet criteria`, EXIT.refused);
  }
  if (chain.draftTask === null) {
    return fail(write, json, "task repair", "refused", `no draft was ever made for run ${runId} — the chain stopped at ${chain.outcome} before drafting one`, EXIT.refused);
  }
  const draftId = chain.draftTask;
  const yes = flags.get("yes") === true;
  if (!yes) {
    const draftScope = store.getScope(draftId);
    return succeed(
      write,
      json,
      "task repair",
      { run: runId, draft: draftId, attempt: chain.attempt, unresolved: chain.unresolved, basis: chain.basis, outcome: chain.outcome, approved: draftScope?.approvedAt !== null && draftScope?.approvedAt !== undefined },
      () => [
        `${draftId} — attempt ${chain.attempt}, drafted by ${chain.basis === "mode" ? "a signed mode" : "the review pass"}, repairing: ${chain.unresolved.join(", ")}.`,
        draftScope?.approvedAt != null ? "Already approved — it builds on the next dispatch." : "Unapproved. Add --yes --as <you> --token <t> to approve it now.",
      ],
    );
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task repair", "usage", "approving a repair draft is a person's act — it takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, "task repair", authenticated.reason, describeApproveFailure(authenticated.reason, draftId), EXIT.refused);
  }
  const draftScope = store.getScope(draftId);
  if (draftScope === null) {
    return fail(write, json, "task repair", "no-scope", `${draftId} has no scope to approve`, EXIT.refused);
  }
  const approved = approve(store, draftId, acting.name, clock(), draftScope.digest, acting.token);
  if (!approved.ok) {
    return fail(write, json, "task repair", approved.reason, approved.reason === "policy" ? `${draftId}: ${approved.message}` : describeApproveFailure(approved.reason, draftId), EXIT.refused);
  }
  return succeed(write, json, "task repair", { run: runId, draft: draftId, approvedBy: acting.name }, () => [
    `Approved: ${draftId} (attempt ${chain.attempt}) will build on the next dispatch.`,
  ]);
}

async function stateTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const [id, state] = positional;
  if (id === undefined || state === undefined) {
    return fail(write, json, "task state", "usage", "`toolroll task state <id> <state>`", EXIT.usage);
  }
  if (!STATES.includes(state as TaskState)) {
    return fail(write, json, "task state", "usage", `state is one of ${STATES.join(", ")}`, EXIT.usage);
  }

  const backendName = text(flags, "backend") ?? BUILT_IN;
  if (backendName !== BUILT_IN) {
    const repo = repoFrom(flags);
    const backend = openBackend(backendName, store, repo);
    if (backend === null) {
      return fail(write, json, "task state", "usage", `no backend \`${backendName}\``, EXIT.usage);
    }

    const moved = await backend.setState(id, state as TaskState);
    if (!moved.ok) {
      const code = moved.reason === "denied" || moved.reason === "unsupported" ? EXIT.refused : EXIT.failed;
      return fail(write, json, "task state", moved.reason, moved.message, code);
    }
    return succeed(write, json, "task state", { id, state, backend: backendName }, () => [
      `${id} is now ${state} in ${backendName}.`,
    ]);
  }

  const replacedBy = text(flags, "replaced-by");
  if (replacedBy !== undefined) {
    if (state !== "cancelled") return fail(write, json, "task state", "usage", "--replaced-by goes with cancelled: `task state <id> cancelled --replaced-by <id>`", EXIT.usage);
    if (replacedBy === id || store.getTask(replacedBy) === null) return fail(write, json, "task state", "unknown-task", `no task \`${replacedBy}\` to replace it`, EXIT.refused);
  }
  noteActingPerson(flags, context);
  const moved = store.setTaskState(id, state as TaskState, now, mutationFrom(flags, now), text(flags, "reason"), replacedBy);
  if (!moved.ok) {
    if (moved.reason === "reason-required" || moved.reason === "bad-reason") {
      return fail(write, json, "task state", moved.reason,
        moved.reason === "reason-required"
          ? "a coordinator filed this task — add --reason with why you are cancelling it"
          : "--reason must be at most 500 plain characters, without hidden or control characters", EXIT.refused);
    }
    return moved.reason === "external-closed"
      ? fail(write, json, "task state", "external-closed", "the tracker closed this — reopen it first, or leave it cancelled", EXIT.refused)
      : fail(write, json, "task state", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  return succeed(write, json, "task state", { id, state, ...(replacedBy === undefined ? {} : { replacedBy }) }, () => [replacedBy === undefined ? `${id} is now ${state}.` : `${id} is replaced by ${replacedBy}.`]);
}

/** Who acts in this command, for pings: a lead is already known; a person only by a sign-in that verifies here (never asked for). */
function noteActingPerson(flags: Map<string, string | true>, context: Context): void {
  if (currentActor() !== null) return;
  const name = text(flags, "as"), token = text(flags, "token");
  // A typed password is checked (a success names the person); the remembered login was checked when it was saved.
  if (token !== undefined) {
    if (name !== undefined && name !== "" && token !== "") authenticateAccount(context.store, name, token);
    return;
  }
  const remembered = readLoginFile(join(dirname(context.databaseFile), UP_LOGIN_FILE));
  if (remembered !== null && (name === undefined || name === remembered.name)) claimActor(remembered.name);
}

/** `task ask <id> --person <name> --why "…"`: the lead hands a task to a person. It pings them once, and the task is theirs. */
function askTask(positional: readonly string[], flags: Map<string, string | true>, context: Context): number {
  const { store, write, json, now } = context;
  const [id, ...extra] = positional;
  const person = text(flags, "person"), why = text(flags, "why")?.trim();
  if (id === undefined || extra.length > 0 || person === undefined || why === undefined || why === "") {
    return fail(write, json, "task ask", "usage", "`toolroll task ask <id> --person <name> --why \"what they need to do\"`", EXIT.usage);
  }
  if (why.length > 500 || /[\u0000-\u001f\u007f]/.test(why)) return fail(write, json, "task ask", "usage", "--why is at most 500 plain characters on one line", EXIT.usage);
  noteActingPerson(flags, context);
  if (currentActor() === null) return fail(write, json, "task ask", "unauthenticated", "Hand a task on as the lead (its lead token) or with your sign-in (--as and --token, or the remembered login).", EXIT.refused);
  const asked = store.askPerson(id, person, why, now);
  if (!asked.ok) {
    return fail(write, json, "task ask", asked.reason, asked.reason === "unknown-task" ? `no task \`${id}\``
      : asked.reason === "unplaced" ? `${id} has no project yet, so nobody can be asked about it` : `${person} is not someone who can see this task's project`, EXIT.refused);
  }
  return succeed(write, json, "task ask", { id, person, why }, () => [`Asked ${person} about ${id}. It is theirs now, and its updates reach them.`]);
}

/** `lead token [--revoke]`: the owner (behind their password) mints the credential their lead acts with. */
async function leadCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json } = context;
  const [action, ...extra] = positional;
  if (action === "say") return leadSayCommand(extra, flags, context);
  const command = "lead token";
  if (action !== "token" || extra.length > 0) return fail(write, json, `lead ${action ?? ""}`.trim(), "usage", "`toolroll lead token [--revoke] --as <you> --token <password>` · `toolroll lead say \"<text>\" [--task <id>]` with the lead token", EXIT.usage);
  for (const name of flags.keys()) if (!["as", "token", "revoke", "db", "json"].includes(name)) return fail(write, json, command, "usage", `--${name} is not a lead token option.`, EXIT.usage);
  if (currentActor()?.lead === true) return fail(write, json, command, "refused", "A lead cannot mint lead tokens. The person it acts for runs this with their password.", EXIT.refused);
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok) {
    return fail(write, json, command, "unauthenticated", "A lead token is minted behind your password: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const now = context.clock();
  if (flags.has("revoke")) {
    const ended = store.revokeLeadCredentials(acting.name, acting.name, now);
    return succeed(write, json, command, { owner: acting.name, revoked: ended }, () => [ended === 0 ? "You had no lead token." : "Your lead token no longer works."]);
  }
  const minted = store.mintLeadCredential(acting.name, acting.name, now);
  return succeed(write, json, command, { owner: acting.name, id: minted.id, token: minted.token, actor: `lead for ${acting.name}` }, () => [
    minted.token,
    `Lead for ${acting.name}. Shown once; it replaces any earlier lead token.`,
    "Your lead passes it as --token <it> (or TOOLROLL_LEAD_TOKEN) on task and assignment commands. Its own work pings nobody;",
    "it reaches you when the lead asks you (task ask), when it fails with nothing left to try, or for a security alert.",
  ]);
}

/** `lead say "<text>" [--task <id>]` with the lead token: one short message in its person's chat from "Your lead".
 * Several within two minutes are one message. */
function leadSayCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): number {
  const { store, write, json } = context;
  const command = "lead say";
  for (const name of flags.keys()) if (!["task", "db", "json"].includes(name)) return fail(write, json, command, "usage", `--${name} is not a lead say option.`, EXIT.usage);
  const task = flags.get("task");
  if (positional.length === 0 || task === true) return fail(write, json, command, "usage", "`toolroll lead say \"<what you're doing>\" [--task <id>]` with the lead token", EXIT.usage);
  const actor = currentActor();
  if (actor?.lead !== true) return fail(write, json, command, "unauthenticated", "Only the lead speaks as the lead: pass its lead token (--token or TOOLROLL_LEAD_TOKEN).", EXIT.refused);
  const said = leadSay(store, actor, positional.join(" "), task ?? null, context.clock());
  if (!said.ok) return fail(write, json, command, said.reason, said.message, said.reason === "usage" ? EXIT.usage : EXIT.refused);
  return succeed(write, json, command, { owner: actor.account, task: task ?? null, joined: said.joined, notification: said.notification },
    () => [said.joined ? `Added to your last message to ${actor.account}.` : `Told ${actor.account}.`]);
}

/** `assignment claim <task>` with the lead token: the task reads "Your lead is on it" and leaves Needs you until the
 * lead completes it, hands it on (task ask), or two hours pass with no lead act on it. */
function leadClaimCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): number {
  const { store, write, json } = context;
  const command = "assignment claim";
  for (const name of flags.keys()) if (!["db", "json"].includes(name)) return fail(write, json, command, "usage", `--${name} is not an assignment claim option.`, EXIT.usage);
  const id = positional[1];
  if (id === undefined || positional.length !== 2) return fail(write, json, command, "usage", "assignment claim takes exactly one task id.", EXIT.usage);
  const actor = currentActor()!;
  const claimed = leadClaim(store, actor, id, context.clock());
  if (!claimed.ok) return fail(write, json, command, claimed.reason, claimed.message, claimed.reason === "usage" ? EXIT.usage : EXIT.refused);
  return succeed(write, json, command, { task: id, root: claimed.root, lead: claimed.claim },
    () => [`${id} is yours: it reads "${leadNameOf(store, actor.account)} is on it" until you complete it, hand it on with task ask, or go two hours without acting on it.`]);
}

function blockTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  const on = text(flags, "on");
  if (id === undefined || on === undefined) {
    return fail(write, json, "task block", "usage", "`toolroll task block <id> --on <id>`", EXIT.usage);
  }
  for (const each of [id, on]) {
    if (store.getTask(each) === null) {
      return fail(write, json, "task block", "unknown-task", `no task \`${each}\``, EXIT.refused);
    }
  }
  const racingGuard = refuseWhileRacing(context, "task block", id);
  if (racingGuard !== null) return racingGuard;

  const result = store.addEdge(id, on, mutationFrom(flags, context.now));
  if (!result.ok) return fail(write, json, "task block", "rejected", result.reason, EXIT.refused);

  return succeed(write, json, "task block", { blocked: id, blocker: on }, () => [
    `${id} now waits for ${on}.`,
  ]);
}

/**
 * File a steering note (arc 1): guidance the next attempt's brief quotes,
 * fenced, inside the approved scope. Scheduling-adjacent like block/next —
 * no credential; the recorded author is "cli" or --as when given.
 */
async function steerTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const id = positional[0];
  const note = text(flags, "note");
  if (id === undefined || note === undefined) {
    return fail(write, json, "task steer", "usage", "`toolroll task steer <id> --note \"...\" --as <you> --token <t>` — steering speaks with the operator's voice, so it takes your credential; the note reaches the next attempt's brief, fenced, inside the approved scope", EXIT.usage);
  }
  // Ruling 11: authorship derives from a VERIFIED principal, never a flag.
  // Missing credentials are usage (the invocation is incomplete); present
  // but wrong is not-an-approver — the same taxonomy as every ceremony.
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task steer", "usage", "steering takes `--as <you> --token <t>` — anonymous notes never reach an agent's brief", EXIT.usage);
  }
  const authed = authenticateApprover(store, acting.name, acting.token);
  if (!authed.ok) {
    return fail(write, json, "task steer", "not-an-approver", "that is not an approver, or the token does not match", EXIT.refused);
  }
  const filed = store.fileSteerNote(id, verifiedAuthor(acting.name), note, context.now, mutationFrom(flags, context.now));
  if (!filed.ok) {
    const detail =
      filed.reason === "unknown-task"
        ? `no task \`${id}\``
        : filed.reason === "task-finished"
          ? `${id} is finished — a note has no next attempt to reach`
          : filed.reason === "contest-open"
            ? "agents are racing on this task — steering waits until the tournament settles"
            : (filed.problem ?? "that note will not store");
    return fail(write, json, "task steer", filed.reason, detail, EXIT.refused);
  }
  return succeed(write, json, "task steer", { task: id, note: filed.id }, () => [
    `Noted. The next attempt at ${id} reads it before starting — a running agent is not interrupted.`,
  ]);
}

/** The mirror of block: stop waiting. Removal cannot create a cycle. */
function unblockTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  const on = text(flags, "on");
  if (id === undefined || on === undefined) {
    return fail(write, json, "task unblock", "usage", "`toolroll task unblock <id> --on <id>`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task unblock", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }
  const racingGuard = refuseWhileRacing(context, "task unblock", id);
  if (racingGuard !== null) return racingGuard;

  const result = store.removeEdge(id, on, mutationFrom(flags, context.now));
  if (!result.ok) {
    return fail(write, json, "task unblock", "not-waiting", `${id} was not waiting on ${on}`, EXIT.refused);
  }
  return succeed(write, json, "task unblock", { blocked: id, blocker: on }, () => [
    `${id} no longer waits for ${on}.`,
  ]);
}

/**
 * Move a task to the front of the queue — or put it back with --undo.
 * Scheduling only: the rank changes when the next free worker looks,
 * and approval is still required for anything to build.
 */
function nextTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task next", "usage", "`toolroll task next <id> [--undo]`", EXIT.usage);
  }
  if (flags.has("undo")) {
    const cleared = store.clearTaskPriority(id, mutationFrom(flags, context.now));
    if (!cleared.ok) return fail(write, json, "task next", "unknown-task", `no task \`${id}\``, EXIT.refused);
    return succeed(write, json, "task next", { task: id, priority: 0 }, () => [
      `${id} is back in filing order.`,
    ]);
  }
  const moved = store.moveTaskNext(id, context.clock(), mutationFrom(flags, context.now));
  if (!moved.ok) {
    const message =
      moved.reason === "unknown-task"
        ? `no task \`${id}\``
        : moved.reason === "not-queued"
          ? `${id} is not queued — only queued work can move up`
          : moved.reason === "claimed"
            ? `${id} is being built right now — it needs no place in line`
            : moved.reason === "contest-open"
              ? "a tournament is running on this task — let it finish, then pick or abandon it from the tournament screen in the console (the task's page links to it)"
              : "the queue rank could not be raised any further";
    return fail(write, json, "task next", moved.reason, message, EXIT.refused);
  }
  return succeed(write, json, "task next", { task: id, priority: moved.priority }, () => [
    `${id} moved to the front of its queue — a worker takes its own reserved work first, then the shared queue (approval still required).`,
  ]);
}

/**
 * Reserve a task for one worker, or return it to the shared queue.
 * Scheduling, never authority — the claim primitive enforces it, and
 * approval still decides what may build.
 */
function assignTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  const runner = text(flags, "runner");
  const anyone = flags.has("anyone");
  if (id === undefined || (runner === undefined && !anyone) || (runner !== undefined && anyone)) {
    return fail(write, json, "task assign", "usage", "`toolroll task assign <id> --runner <name> | --anyone`", EXIT.usage);
  }
  const moved = store.moveTask(
    { taskId: id, toRunner: runner ?? null, beforeTaskId: null },
    context.clock(),
    mutationFrom(flags, context.now),
  );
  if (!moved.ok) {
    const message =
      moved.reason === "unknown-task"
        ? `no task \`${id}\``
        : moved.reason === "not-queued"
          ? `${id} is not queued — only queued work can be reserved`
          : moved.reason === "claimed"
            ? `${id} is being built right now — it needs no reservation`
            : moved.reason === "contest-open"
              ? "a tournament is running on this task — let it finish, then pick or abandon it from the tournament screen in the console (the task's page links to it)"
              : moved.reason === "no-such-worker"
                ? `no worker named \`${runner}\` — \`toolroll runner list\` names them`
                : moved.reason === "worker-retired"
                  ? `${runner} is retired — register the name again, or reserve for another worker`
                  : "the queue did not accept the move";
    return fail(write, json, "task assign", moved.reason, message, EXIT.refused);
  }
  return succeed(write, json, "task assign", { task: id, reservedFor: runner ?? null }, () => [
    runner === undefined
      ? `${id} is back in the shared queue — any free worker takes it.`
      : `${id} is reserved for ${runner}, at the back of that worker's queue — only that worker takes it.`,
  ]);
}

/**
 * Reopen an externally-closed mirror: an authenticated act that needs the
 * tracker SEEN open again after the close, and the task clean — the
 * refusals point at the existing acts that clear each blocker.
 */
async function reopenTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task reopen", "usage", "`toolroll task reopen <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task reopen", "usage", "reopening takes `--as <you> --token <t>` — who resumed external work is recorded, not asserted", EXIT.usage);
  }
  const reopened = store.reopenMirror(id, acting.name, context.clock());
  if (!reopened.ok) {
    const said: Record<string, string> = {
      "unknown-task": `no external task \`${id}\``,
      "not-latched": `${id} was never closed on its tracker — there is nothing to reopen`,
      "not-seen-open": "the tracker has not been SEEN open again since the close — reopen it there, then `toolroll sync`",
      claimed: `${id} is being built right now`,
      "contest-open": "a tournament is open on this task — decide it first",
      held: "a hold stands — lift it first (`task unhold`, or wait out the timer)",
      "question-open": "an unanswered question stands — answer or close it first (it is on the task page)",
      "incident-open": "an unresolved incident stands — resolve it first",
      "bad-state": `${id} is not in a state reopen can take (it may already be done)`,
    };
    return fail(write, json, "task reopen", reopened.reason, said[reopened.reason] ?? "the mirror could not be reopened", EXIT.refused);
  }
  return succeed(write, json, "task reopen", { task: id, by: acting.name }, () => [
    `${id} is queued again — the tracker was seen open, the approved scope stands, and the next pass may take it.`,
  ]);
}

/**
 * The sync pass, by hand: every dispatch-granted tracker (or one repo's),
 * through the same engine the daemon runs. Zero tokens; fail closed.
 */
async function syncCommand(flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json } = context;
  const demoFence = refuseDemo(context, "sync");
  if (demoFence !== null) return demoFence;
  const only = text(flags, "repo");
  const grants = store
    .listGrants()
    .filter(grant => grant.dispatch === true && grant.remoteRepo != null)
    .filter(grant => only === undefined || grant.repo === resolve(only));
  if (grants.length === 0) {
    return fail(write, json, "sync", "no-grant", "no tracker has a dispatch grant — `toolroll enroll <repo> --backend github-issues --github <owner/name> --allow-dispatch` states the terms", EXIT.refused);
  }
  const adapter = ghDispatchAdapter();
  const reports = [];
  for (const grant of grants) {
    reports.push(await syncPass(store, grant, adapter, context.clock));
  }
  const failed = reports.filter(one => one.outcome === "failed" || one.outcome === "blocked");
  if (json) {
    write(envelopeJson({ ok: failed.length === 0, command: "sync", ...(failed.length === 0 ? {} : { reason: "sync-failed", message: failed[0]?.detail ?? "a pass failed" }), reports }));
    return failed.length === 0 ? EXIT.ok : EXIT.failed;
  }
  for (const report of reports) {
    write(
      `${report.remoteRepo}  ${report.outcome}` +
        `${report.outcome === "complete" || report.outcome === "capped" ? ` — ${report.candidates} open, ${report.mirrored} newly mirrored, ${report.latched} closed there, ${report.delivered} write-back(s) delivered` : ""}` +
        `${report.detail === null ? "" : `  (${report.detail})`}`,
    );
  }
  if (failed.length > 0) {
    write("A failed or blocked pass advances nothing — external work keeps its last verified state and will not dispatch past its freshness window.");
    return EXIT.failed;
  }
  return EXIT.ok;
}

/**
 * Write down what a task is allowed to become.
 *
 * Proposing never approves. The two are separate commands because they are
 * separate acts by, usually, separate parties: an agent may draft a scope, and
 * only a person may agree to it.
 */
async function scopeTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const id = positional[0];
  const goal = text(flags, "goal");
  if (id === undefined || goal === undefined) {
    return fail(write, json, "task scope", "usage", "`toolroll task scope <id> --goal <what success is> --acceptance <rubric> [--not <text>] [--touches a,b] [--candidate <commit>] [--budget-usd <n>] [--race provider:model[,provider:model…]] [--race-count 2..4] [--race-per-usd <n>] [--race-total-usd <n>]`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task scope", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }
  // v39: this road bypasses proposeGuarded (a trusted local operator, not a
  // web form re-authenticating staleness) but not the rubric requirement —
  // every scope-producing road signs one, this one included.
  const acceptanceGiven = text(flags, "acceptance");
  if (acceptanceGiven === undefined) {
    return fail(
      write, json, "task scope", "acceptance-required",
      "a scope needs at least one signed acceptance criterion — `--acceptance \"<statement>|<evidence,kinds>\"`, `;`-separated for more than one; evidence kinds are check, screenshot, changed-path, manual-review",
      EXIT.usage,
    );
  }
  const acceptanceParse = parseAcceptanceCriteria(acceptanceLinesToInput(splitAcceptanceRubric(acceptanceGiven)));
  if (acceptanceParse.problems.length > 0) {
    return fail(write, json, "task scope", "bad-acceptance",
      `${acceptanceParse.problems.map(p => p.message).join("; ")} — each criterion is \`<statement>|<evidence,kinds>\`, criteria are \`;\`-separated, and \`--acceptance plan\` asks the planner to write the rubric`, EXIT.usage);
  }
  const riskGiven = text(flags, "risk");
  if (riskGiven !== undefined && !isRiskLevel(riskGiven)) {
    return fail(write, json, "task scope", "usage", `--risk is one of ${RISK_LEVELS.join(", ")}`, EXIT.usage);
  }
  // v69: a prepared commit. The machine checks it out as the attempt and
  // runs the gate and the review; no agent is dispatched for it.
  const candidateGiven = text(flags, "candidate");
  if (candidateGiven !== undefined && !isCommitSha(candidateGiven)) {
    return fail(write, json, "task scope", "usage", "--candidate is the full 40-character commit hash the machine will check out", EXIT.usage);
  }
  if (acceptanceParse.criteria.length === 0) {
    return fail(write, json, "task scope", "acceptance-required", "--acceptance named no valid criteria", EXIT.usage);
  }

  const touches = (text(flags, "touches") ?? "").split(",").map(one => one.trim()).filter(Boolean);

  const badText = validateScopeText({ goal, outOfScope: text(flags, "not") ?? null, touches });
  if (badText !== null) return fail(write, json, "task scope", badText.reason, badText.message, EXIT.usage);

  // A tournament rides the same filing (stage 3): --race names the agents,
  // the dollar terms are REQUIRED, and everything lands unapproved — the
  // one yes later covers scope AND race terms as a single fingerprint.
  const budgetGiven = text(flags, "budget-usd");
  const defaults = store.getSpendDefaults();
  const budgetUsd =
    budgetGiven !== undefined
      ? Number(budgetGiven)
      : defaults?.buildPerRunMicrousd != null
        ? defaults.buildPerRunMicrousd / 1_000_000
        : null;
  if (budgetGiven !== undefined && (!Number.isFinite(Number(budgetGiven)) || Number(budgetGiven) <= 0)) {
    return fail(write, json, "task scope", "bad-budget", "--budget-usd is a positive dollar amount", EXIT.usage);
  }
  const raceGiven = text(flags, "race");
  const raceCountGiven = text(flags, "race-count");
  // The comparison road (Phase 3 slice B): labeled lanes, no dollar terms,
  // any registered provider — refused outright when every lane could hold
  // a real budget (the discipline gate: race those instead).
  const compareGiven = text(flags, "compare");
  const permissionMode = store.refFor(BUILT_IN, id).permissionMode ?? store.permissionDefault().mode;
  let plannedComparison: ReturnType<typeof planComparison> | null = null;
  if (compareGiven !== undefined) {
    if (raceGiven !== undefined || raceCountGiven !== undefined || text(flags, "race-per-usd") !== undefined || text(flags, "race-total-usd") !== undefined) {
      return fail(write, json, "task scope", "usage", "--compare and the --race flags are different ceremonies — file one or the other", EXIT.usage);
    }
    if (store.mirrorByTask(id) !== null) {
      return fail(write, json, "task scope", "external-race", "external work compares in a follow-up release — file the comparison on a local task", EXIT.refused);
    }
    const lanes = compareGiven.split(",").map(one => {
      const [provider = "", model = ""] = one.trim().split(":");
      return { provider, model, permissionMode };
    });
    plannedComparison = planComparison({ agents: lanes });
    if (!plannedComparison.ok) {
      return fail(write, json, "task scope", plannedComparison.reason, plannedComparison.message, EXIT.refused);
    }
  }
  let plannedRace: ReturnType<typeof planTournament> | null = null;
  if (raceCountGiven !== undefined && raceGiven === undefined) {
    return fail(write, json, "task scope", "usage", "--race-count needs --race to name the competing agent, e.g. `--race claude:claude-sonnet-5 --race-count 3`", EXIT.usage);
  }
  if (raceGiven !== undefined) {
    // Explicit flags win; absent ones fall back to the configured defaults
    // (operator request) — the digest binds the ACTUAL numbers either way,
    // and the approval restates them. A budget that is simply MISSING is
    // named as the missing flag here, before planTournament's generic
    // positive-amount backstop turns it into a riddle (round-4 finding 11).
    if (text(flags, "race-per-usd") === undefined && defaults?.racePerAgentMicrousd == null) {
      return fail(write, json, "task scope", "bad-budget", "--race-per-usd is missing and no default is set — pass it, or set one with `toolroll config set budgets --race-per-usd <n>`", EXIT.usage);
    }
    if (text(flags, "race-total-usd") === undefined && defaults?.raceTotalMicrousd == null) {
      return fail(write, json, "task scope", "bad-budget", "--race-total-usd is missing and no default is set — pass it, or set one with `toolroll config set budgets --race-total-usd <n>`", EXIT.usage);
    }
    const perUsd = Number(text(flags, "race-per-usd") ?? (defaults?.racePerAgentMicrousd == null ? Number.NaN : defaults.racePerAgentMicrousd / 1_000_000));
    const totalUsd = Number(text(flags, "race-total-usd") ?? (defaults?.raceTotalMicrousd == null ? Number.NaN : defaults.raceTotalMicrousd / 1_000_000));
    if (store.mirrorByTask(id) !== null) {
      return fail(write, json, "task scope", "external-race", "external work races in a follow-up release — file the tournament on a local task", EXIT.refused);
    }
    let agents = raceGiven.split(",").map(one => {
      const [provider = "", model = ""] = one.trim().split(":");
      return { provider, model, permissionMode };
    });
    // The competing-agent COUNT (operator request): an explicit --race-count
    // replicates a single named agent; with several named agents it may only
    // agree with the list — a count that contradicts an explicit lineup is a
    // question, not an instruction. Absent both, the configured default
    // count replicates a single agent; an explicit list is always itself.
    if (raceCountGiven !== undefined) {
      const count = Number(raceCountGiven);
      if (!Number.isInteger(count) || count < 2 || count > 4) {
        return fail(write, json, "task scope", "usage", "--race-count is how many agents compete: a whole number from 2 to 4", EXIT.usage);
      }
      if (agents.length === 1) {
        agents = Array.from({ length: count }, () => ({ ...(agents[0] as { provider: string; model: string; permissionMode: typeof permissionMode }) }));
      } else if (agents.length !== count) {
        return fail(write, json, "task scope", "usage", `--race names ${agents.length} agents but --race-count says ${count} — make them agree, or name one agent and let the count replicate it`, EXIT.usage);
      }
    } else if (agents.length === 1 && defaults?.raceAgents != null) {
      agents = Array.from({ length: defaults.raceAgents }, () => ({ ...(agents[0] as { provider: string; model: string; permissionMode: typeof permissionMode }) }));
    }
    plannedRace = planTournament({
      agents,
      perAgentBudgetUsd: perUsd,
      totalBudgetUsd: totalUsd,
    });
    if (!plannedRace.ok) {
      return fail(write, json, "task scope", plannedRace.reason, plannedRace.message, EXIT.refused);
    }
  }

  // v24 routing flags (foundations finding 5 — these used to be silently
  // swallowed by the global parser): explicit flags resolve HERE, and an
  // explicit ask that cannot resolve refuses rather than filing unresolved.
  const routingAsked =
    text(flags, "provider") !== undefined || text(flags, "model") !== undefined || text(flags, "repair-model") !== undefined;
  let explicitProfile: ExecutionProfile | undefined;
  if (routingAsked) {
    const scopeRef = store.lookupRef(id);
    const resolvedRouting = resolveScopeProfile(
      store,
      scopeRef?.repo ?? null,
      scopeRef === null ? undefined : { agentProvider: scopeRef.agentProvider, agentModel: scopeRef.agentModel },
      { provider: text(flags, "provider"), model: text(flags, "model"), repairModel: text(flags, "repair-model") },
    );
    if (!resolvedRouting.ok) {
      return fail(write, json, "task scope", resolvedRouting.reason, resolvedRouting.problem, EXIT.usage);
    }
    explicitProfile = resolvedRouting.profile;
  }
  // The race branch shares ONE transaction with the scope save (round-6
  // finding 5): the attended exclusion refuses BEFORE anything writes, and
  // a filing failure rolls the proposal back — a refused race never leaves
  // a rewritten scope behind it.
  //
  // C1/M3, the credentialed-CLI road: when --as/--token authenticate the
  // MODE'S SIGNER and their live mode auto-approves filings, the scope
  // seals in the same transaction it files — plain scopes only, and the
  // ledger shows the mode provenance. Anonymous filings never auto-seal.
  const { name: asGiven, token: tokenGiven } = credentialsFrom(flags, context);
  const actor =
    asGiven !== undefined && tokenGiven !== undefined && authenticateApprover(store, asGiven, tokenGiven).ok
      ? asGiven
      : null;
  // Size the new goal before filing its route. A replay must not classify
  // again or change the task behind the original answer. This probe does
  // not record a result; the composite filing below still owns the receipt.
  let refinement: Promise<void> | null = null;
  store.replay(mutationFrom(flags, now), "task-scope-filed", () => {
    const ref = store.lookupRef(id);
    const previous = store.getScope(id);
    if (ref === null || ref.deliverable === "report" || candidateGiven !== undefined ||
        ref.sizing?.source === "person" || approvalOf(previous).approved ||
        previous?.proposedVia === "coordinator" || store.filedViaOf(id)?.startsWith("mcp:") ||
        ((plannedRace !== null || plannedComparison !== null) && store.openAuthorizationFor(ref.id) !== null)) return null;
    const input = { title: store.getTask(id)!.title, goal, outOfScope: text(flags, "not") ?? null, touches };
    const sized = store.applySizing(id, heuristicSizing(input), { followPlanning: true }, now);
    if (sized.ok) refinement = refineFiledSizing(store, id, input, true, context.clock);
    return null;
  }, () => false);
  // Wait for bounded classification before filing so any approval in the
  // transaction below binds the final size and route.
  await refinement;
  // ONE replayed composite (surfaces round 1, finding 3): the filing, any
  // race/comparison terms, AND the mode seal record as a single operation —
  // a replayed key returns the FIRST answer whole instead of re-sealing
  // whatever scope happens to be current.
  const filed = store.replay(mutationFrom(flags, now), "task-scope-filed", () =>
    store.transact(():
    | { ok: true; scope: ReturnType<typeof propose>; sealedUnderMode: boolean; modeRefusedCoordinator?: boolean }
    | { ok: false; reason: string; message: string } => {
    if (plannedRace !== null && plannedRace.ok) {
      const raceRef = store.refFor(BUILT_IN, id);
      if (store.openAuthorizationFor(raceRef.id) !== null) {
        return {
          ok: false,
          reason: "attended-open",
          message: "an attended authorization is open on this task — revoke it before filing a tournament",
        };
      }
    }
    const coverage =
      plannedRace === null && plannedComparison === null && actor !== null
        ? modeFilingCoverage(store, store.refFor(BUILT_IN, id).repo, actor, now)
        : null;
    const proposed = propose(store, {
      ...(candidateGiven === undefined ? {} : { candidate: candidateGiven }),
      taskId: id,
      goal,
      outOfScope: text(flags, "not") ?? null,
      touches,
      acceptance: acceptanceParse.criteria,
      // v47: the declared risk — a durable task choice the route reads.
      ...(riskGiven === undefined ? {} : { riskLevel: riskGiven }),
      ...(budgetUsd !== null
        ? { budgetMicrousd: Math.round(budgetUsd * 1_000_000) }
        : coverage?.defaultBudgetMicrousd != null
          ? { budgetMicrousd: coverage.defaultBudgetMicrousd }
          : {}),
      ...(explicitProfile === undefined ? {} : { profile: explicitProfile }),
      ...(coverage?.escalated === true ? { posture: "escalated" as const } : {}),
      now,
    });
    let sealedUnderMode = false;
    let modeRefusedCoordinator = false;
    // A placeholder rubric is a request for a plan, not a promise to build
    // against: under a mode that plans automatically, the planner writes the
    // real criteria first, exactly as a console-filed scout follow-up does.
    if (coverage !== null && rubricIsPlaceholder(proposed.acceptance) && store.lookupRef(id)?.plan == null) {
      const mode = store.activeMode(store.lookupRef(id)?.repo ?? "", now);
      const terms = mode === null ? null : modeTermsFromJson(mode.termsJson);
      if (terms?.planAuto === true) store.requestPlan(store.refFor(BUILT_IN, id).id, now);
    }
    if (coverage !== null && store.lookupRef(id)?.plan === "requested") {
      authorizePlanUnderMode(store, id, actor as string, now);
    } else if (coverage !== null && proposed.profileState === "resolved") {
      sealedUnderMode = store.sealScopeApproval(id, actor as string, now, {}, { kind: "mode", modeDigest: coverage.digest });
      modeRefusedCoordinator = !sealedUnderMode;
    }
    if (plannedRace !== null && plannedRace.ok) {
      const plan = plannedRace.plan;
      const raceRef = store.refFor(BUILT_IN, id);
      store.fileTournamentTerms(
        {
          taskRef: raceRef.id,
          raceDigest: plan.raceDigest,
          agents: plan.agents,
          perAgentBudgetMicrousd: plan.perAgentBudgetMicrousd,
          overrunReserveMicrousd: plan.overrunReserveMicrousd,
          totalBudgetMicrousd: plan.totalBudgetMicrousd,
          priceVersion: plan.priceVersion,
          publicationPolicy: plan.publicationPolicy,
        },
        now,
      );
    }
    if (plannedComparison !== null && plannedComparison.ok) {
      const plan = plannedComparison.plan;
      const compareRef = store.refFor(BUILT_IN, id);
      if (store.openAuthorizationFor(compareRef.id) !== null) {
        return {
          ok: false,
          reason: "attended-open",
          message: "an attended authorization is open on this task — revoke it before filing a comparison",
        };
      }
      store.fileTournamentTerms(
        {
          taskRef: compareRef.id,
          kind: "comparison",
          raceDigest: plan.comparisonDigest,
          agents: plan.agents,
          perAgentBudgetMicrousd: 0,
          overrunReserveMicrousd: 0,
          totalBudgetMicrousd: 0,
          priceVersion: 0,
          publicationPolicy: plan.publicationPolicy,
        },
        now,
      );
    }
    return { ok: true, scope: proposed, sealedUnderMode, modeRefusedCoordinator };
  }));
  if (!filed.ok) {
    return fail(write, json, "task scope", filed.reason, filed.message, EXIT.refused);
  }
  const scope = filed.scope;
  if (filed.modeRefusedCoordinator === true) {
    return succeed(write, json, "task scope", { scope, approvedUnderMode: false, quarantined: true }, () => [
      `Scope written for ${id} — but coordinator-filed: mode coverage cannot admit it; sign the scope.`,
      ...describeScope(scope),
    ]);
  }
  if (filed.sealedUnderMode) {
    return succeed(write, json, "task scope", { scope, approvedUnderMode: true }, () => [
      `Scope written AND approved for ${id} — your operating mode covered it; it dispatches on the next pass.`,
      ...describeScope(scope),
    ]);
  }

  if (plannedComparison !== null && plannedComparison.ok) {
    const plan = plannedComparison.plan;
    return succeed(write, json, "task scope", { scope, comparison: plan }, () => [
      `Scope and comparison written for ${id}. Nothing builds until somebody approves BOTH, with one yes:`,
      ...describeScope(scope),
      "",
      ...plan.laneWords.map(lane => `  ${lane}`),
      "  no dollar caps exist on a comparison — each agent runs until it finishes or stops making progress;",
      "  spend lands measured only where the harness reports dollars",
      "",
      `  toolroll task approve ${id} --yes`,
    ]);
  }

  if (plannedRace !== null && plannedRace.ok) {
    const plan = plannedRace.plan;
    const worst = plan.perAgentReserveMicrousd.reduce((sum, reserve) => sum + plan.perAgentBudgetMicrousd + reserve, 0);
    return succeed(write, json, "task scope", { scope, race: plan }, () => [
      `Scope and tournament written for ${id}. Nothing builds until somebody approves BOTH, with one yes:`,
      ...describeScope(scope),
      "",
      `  tournament: ${plan.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`,
      `  each agent may spend $${(plan.perAgentBudgetMicrousd / 1_000_000).toFixed(2)}, plus its stated overrun reserve;` +
        ` worst case $${(worst / 1_000_000).toFixed(2)} total`,
      "",
      `  toolroll task approve ${id} --yes`,
    ]);
  }

  return succeed(write, json, "task scope", { scope }, () => [
    `Scope written for ${id}. Nothing will build it until somebody approves it.`,
    ...describeScope(scope),
    "",
    `  toolroll task approve ${id} --yes`,
  ]);
}

/**
 * A person says yes.
 *
 * `--yes` is required for the same reason `enroll` requires it: this is the
 * moment an agent is allowed to write code against somebody's repository, and
 * a command that did it as a side effect of being run would be the wrong shape
 * entirely.
 */
/**
 * `toolroll task route <id>` (v47): the explainable phase route —
 * shown from the ONE projection every surface renders, and edited only by
 * an approver: `--risk <routine|elevated|high>` declares the task's risk;
 * `--phase <p> --provider <p> --model <m>` records a per-phase override
 * (an exact pair — approvals bind exact routing) with attribution;
 * `--clear-phase <p>` removes one; `--digest <d>` names the scope digest
 * you read, so the edit lands only on what you saw. The edit is ONE
 * authenticated transaction: it re-files the scope (the same words, a
 * recomputed route), so an approval sealed under the old route goes
 * visibly stale; a plan override becomes the planner pin, and a drafted
 * plan from the old planner is re-requested rather than relabeled.
 * Refused under a live claim — the running work read its route at start.
 */
async function routeTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task route", "usage", "`toolroll task route <id> [--risk <level>] [--phase <p> --provider <p> --model <m> | --clear-phase <p>] [--digest <d>] --as <you> --token <t>`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task route", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }
  const ref = store.refFor(BUILT_IN, id);
  const riskGiven = text(flags, "risk");
  const phaseGiven = text(flags, "phase");
  const clearGiven = text(flags, "clear-phase");
  const providerGiven = text(flags, "provider");
  const modelGiven = text(flags, "model");
  const digestGiven = text(flags, "digest");
  const sizeGiven = text(flags, "size");
  const riskyGiven = text(flags, "risky");
  const editing = riskGiven !== undefined || phaseGiven !== undefined || clearGiven !== undefined || sizeGiven !== undefined || riskyGiven !== undefined;

  const show = (): number => {
    const scope = store.getScope(id);
    const current = store.refFor(BUILT_IN, id);
    const routed = routeOfTask(store, id, current, clock());
    const readiness = store.readinessLookupFor(ref.repo, ref.assignedRunner, clock());
    const view = taskRouteView(routed, readiness);
    const projection = routed !== null && routed.kind === "route" ? projectRoute(routed.route, readiness) : null;
    return succeed(
      write,
      json,
      "task route",
      { id, risk: current.riskLevel ?? scope?.riskLevel ?? "routine", riskConsequence: riskConsequence(current.riskLevel ?? scope?.riskLevel ?? "routine"), size: current.sizing ?? null, source: routed !== null && routed.kind === "route" ? routed.source : routed?.kind ?? null, route: view, overrides: current.routeOverrides ?? [], digest: scope?.digest ?? null, approval: approvalOf(scope) },
      () =>
        routed === null
          ? [`${id}: no route can be recommended yet — ${scope === null ? "place the task in a repository and file a scope" : scope.unresolvedReason ?? "the phase configuration cannot resolve"}`]
          : [
              ...(projection === null
                ? taskRouteStandingLines(id, routed)
                : [
                    `${id}: route ${routed.kind === "route" && routed.source === "approved" ? "SEALED by the approval" : routed.kind === "route" && routed.source === "proposed" ? "proposed — the next approval seals it" : "recommended live — no scope filed yet"}`,
                    ...routeWords(projection),
                    // The declared risk, in the words the console and chat
                    // use — and the one CLI hint that belongs here, not in
                    // the route's own reasons: how a stronger tier is named.
                    `  risk         ${current.riskLevel ?? scope?.riskLevel ?? "routine"} — ${riskConsequence(current.riskLevel ?? scope?.riskLevel ?? "routine")}`,
                    ...(projection.legs.some(leg => leg.reasons.some(reason => reason.startsWith("no stronger")))
                      ? [`               name a stronger agent once with \`config set <phase> --tier strong --provider … --model …\``]
                      : []),
                  ]),
              ...(scope === null
                ? []
                : (() => {
                    const approval = approvalOf(scope);
                    return [
                      ...(scope.unresolvedReason === null || scope.unresolvedReason === undefined ? [] : [`  unresolved   ${scope.unresolvedReason}`]),
                      `  reference    ${scope.digest}`,
                      `  approved     ${approval.approved ? `yes, by ${approval.by}` : approval.reason === "changed" ? "no — approved once, then the terms changed; approve again" : "no"}`,
                    ];
                  })()),
            ],
    );
  };
  if (!editing) return show();

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task route", "usage", "changing a route takes `--as <you> --token <t>` — it reroutes spend", EXIT.usage);
  }
  if (riskGiven !== undefined && !isRiskLevel(riskGiven)) {
    return fail(write, json, "task route", "usage", `--risk is one of ${RISK_LEVELS.join(", ")}`, EXIT.usage);
  }
  if (sizeGiven !== undefined && !isTaskSize(sizeGiven)) {
    return fail(write, json, "task route", "usage", `--size is one of ${TASK_SIZES.join(", ")}`, EXIT.usage);
  }
  if (riskyGiven !== undefined && riskyGiven !== "yes" && riskyGiven !== "no") {
    return fail(write, json, "task route", "usage", "--risky is yes or no", EXIT.usage);
  }
  // A person's size outranks the classifier's; an unnamed half keeps what the task has.
  const sizeEdit = sizeGiven === undefined && riskyGiven === undefined ? undefined : {
    size: (sizeGiven as TaskSize | undefined) ?? ref.sizing?.size ?? "medium",
    risky: riskyGiven === undefined ? ref.sizing?.risky ?? false : riskyGiven === "yes",
  };
  if (phaseGiven !== undefined && clearGiven !== undefined) {
    return fail(write, json, "task route", "usage", "say --phase … --provider … --model … OR --clear-phase …, not both", EXIT.usage);
  }
  const phase = phaseGiven ?? clearGiven;
  if (phase !== undefined && !(ROUTE_PHASES as readonly string[]).includes(phase)) {
    return fail(write, json, "task route", "usage", `--${phaseGiven !== undefined ? "phase" : "clear-phase"} is one of ${ROUTE_PHASES.join(", ")}`, EXIT.usage);
  }
  if (phaseGiven === "review") return fail(write, json, "task route", "model-review-retired", "Separate model review has been removed; no reviewer route is needed.", EXIT.refused);
  if (phaseGiven !== undefined) {
    if (providerGiven === undefined || !isProviderId(providerGiven)) {
      return fail(write, json, "task route", "usage", `--provider is one of ${PROVIDER_IDS.join(", ")}`, EXIT.usage);
    }
    if (modelGiven === undefined || modelGiven === "") {
      return fail(write, json, "task route", "usage", "an override names an exact --model — approvals bind exact routing", EXIT.usage);
    }
    const valid = validateSpec({ provider: providerGiven, model: modelGiven });
    if (!valid.ok) return fail(write, json, "task route", "invalid", valid.problem, EXIT.usage);

  }
  const edited = store.editTaskRoute(
    ref.id,
    {
      by: acting.name,
      authenticate: () => {
        const authenticated = authenticateApprover(store, acting.name, acting.token);
        return authenticated.ok ? { ok: true } : { ok: false, reason: authenticated.reason };
      },
      ...(riskGiven === undefined ? {} : { risk: riskGiven as RiskLevel }),
      ...(sizeEdit === undefined ? {} : { size: sizeEdit }),
      ...(phase === undefined
        ? {}
        : { override: phaseGiven !== undefined ? { phase: phase as RouteOverride["phase"], provider: providerGiven as ProviderId, model: modelGiven as string } : { phase: phase as RouteOverride["phase"], clear: true as const } }),
      ...(digestGiven === undefined ? {} : { expectDigest: digestGiven === "none" ? null : digestGiven }),
    },
    clock(),
  );
  if (!edited.ok) {
    if (edited.reason === "unauthenticated") {
      return fail(write, json, "task route", edited.detail, describeApproveFailure(edited.detail as "no-approvers" | "not-an-approver", id), EXIT.refused);
    }
    const code: Record<typeof edited.reason, string> = { "no-task": "unknown-task", "live-claim": "claimed", "contest-open": "contest-open", changed: "changed", nothing: "usage", "not-configured": "not-configured" };
    return fail(write, json, "task route", code[edited.reason], `${id}: ${edited.detail}`, edited.reason === "nothing" ? EXIT.usage : EXIT.refused);
  }
  const code = show();
  if (!json) {
    if (edited.staled) write(`  ! the approval sealed under the previous route is now stale — approve ${id} again to seal this one`);
    if (edited.replanned) write(`  ! the planner changed after a draft landed — a new planner run was requested; approval waits for its draft`);
  }
  return code;
}

async function approveTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task approve", "usage", "which task?", EXIT.usage);
  }

  const scope = store.getScope(id);
  if (scope === null) {
    return fail(write, json, "task approve", "no-scope", `${id} has no scope to approve — write one first`, EXIT.refused);
  }
  // Console parity (v47): a plan leg changed after a draft asks for a real
  // re-plan — nothing approves the obsolete draft while the planner is owed.
  if (store.lookupRef(id)?.plan === "requested") {
    return fail(write, json, "task approve", "planning", `${id} is waiting on a planner — approval is blocked until the drafted plan lands`, EXIT.refused);
  }

  let saw = text(flags, "digest");
  let { name: asWho, token } = credentialsFrom(flags, context);

  let confirmedAloud = false;
  // At a terminal, approval is a conversation, not flag assembly: the scope
  // prints, a person says yes to exactly what printed, and the digest that
  // binds the yes is the one this very process just displayed — approve()
  // still re-proves it transactionally, so a scope swapped mid-read refuses.
  if ((!flags.has("yes") || saw === undefined || asWho === undefined || token === undefined) &&
      interactive() && !json) {
    write(`Approving lets a builder work on ${id}, within exactly this:`);
    write("");
    for (const line of describeScope(scope)) write(line);
    for (const line of planContractLines(store, context.evidenceRoot, id)) write(line);
    const interactiveRace = store.activeTournamentTerms(store.refFor(BUILT_IN, id).id);
    if (interactiveRace !== null) {
      write("");
      write(`  AND it starts a tournament: ${interactiveRace.n} agents build this independently —`);
      write(`  ${interactiveRace.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`);
      write(`  each may spend $${(interactiveRace.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} plus its overrun reserve;`);
      write(`  the whole tournament is capped at $${(interactiveRace.totalBudgetMicrousd / 1_000_000).toFixed(2)}. You pick the winner; only the winner publishes.`);
    }
    write("");
    const agreed = await confirm("Approve exactly this?");
    if (!agreed) {
      write("Nothing approved.");
      return EXIT.refused;
    }
    saw ??= scope.digest;
    const acting = await askCredentials(flags, context);
    if (acting === null) return fail(write, json, "task approve", "usage", "approval needs who is agreeing", EXIT.usage);
    asWho = acting.name;
    token = acting.token;
    confirmedAloud = true;
  }

  const armed =
    (flags.has("yes") || confirmedAloud) &&
    saw !== undefined && asWho !== undefined && token !== undefined;
  if (!armed) {
    if (json) {
      write(envelopeJson({ ok: false, command: "task approve", reason: "unconfirmed", scope }));
      return EXIT.refused;
    }
    write(`Would approve this, and let a builder work on ${id}:`);
    write("");
    for (const line of describeScope(scope)) write(line);
    for (const line of planContractLines(store, context.evidenceRoot, id)) write(line);
    write("");
    const previewRace = store.activeTournamentTerms(store.refFor(BUILT_IN, id).id);
    if (previewRace !== null) {
      write(`  AND the tournament: ${previewRace.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`);
      write(`  each capped at $${(previewRace.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} + reserve, total $${(previewRace.totalBudgetMicrousd / 1_000_000).toFixed(2)}`);
      write("");
    }
    write("Nothing has been approved. Agree to this exact scope with:");
    write(
      `  toolroll task approve ${id} --yes --digest ${
        previewRace === null ? scope.digest : jointApprovalDigest(scope.digest, previewRace.raceDigest)
      } --as <you> --token <your password>`,
    );
    // Unconfirmed is "no, not yet" — exit 3 in both modes (round-4 finding 10).
    return EXIT.refused;
  }
  if (saw === undefined || asWho === undefined || token === undefined) {
    return fail(write, json, "task approve", "usage", "approving non-interactively takes --yes --digest <d> --as <you> --token <t>", EXIT.usage);
  }

  // The digest is named rather than assumed, so an operator who read one scope
  // cannot approve a different one that replaced it while they were reading.
  // The credential is required for a different reason: an agent that can run
  // these commands can read the digest out of `task show`, and an approval
  // nobody has to authenticate would let it agree to its own brief.
  //
  // A tournament task's yes covers BOTH documents (finding 31): the named
  // digest is tournament-approval/v1 = H(scope, race), and the scope and
  // the race terms approve together, in one transaction, or not at all.
  const raceTerms = store.activeTournamentTerms(store.refFor(BUILT_IN, id).id);
  if (raceTerms !== null) {
    const joint = jointApprovalDigest(scope.digest, raceTerms.raceDigest);
    if (saw !== joint && saw !== scope.digest) {
      return fail(write, json, "task approve", "changed", `this task races a tournament — approve the JOINT fingerprint: ${joint}`, EXIT.refused);
    }
    if (saw === scope.digest && !confirmedAloud) {
      return fail(write, json, "task approve", "changed", `this task races a tournament — the yes must name the joint fingerprint ${joint}, which covers the race terms too`, EXIT.refused);
    }
    const both = store.transact(() => {
      const scopeApproved = approve(store, id, asWho as string, now, scope.digest, token as string, mutationFrom(flags, now));
      if (!scopeApproved.ok) return scopeApproved;
      if (!store.approveTournamentTerms(raceTerms.id, asWho as string, raceTerms.raceDigest, now)) {
        throw new Error("the race terms changed while you were reading — nothing was approved");
      }
      return scopeApproved;
    });
    if (!both.ok) {
      return fail(write, json, "task approve", both.reason, both.reason === "policy" ? `${id}: ${both.message}` : describeApproveFailure(both.reason, id), EXIT.refused);
    }
    return succeed(write, json, "task approve", { scope: both.scope, race: raceTerms }, () => [
      `Approved — scope AND tournament, with one yes. ${raceTerms.n} agents will build ${id} independently:`,
      ...describeScope(both.scope),
      `  ${raceTerms.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`,
      `  each may spend $${(raceTerms.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} plus its overrun reserve; total cap $${(raceTerms.totalBudgetMicrousd / 1_000_000).toFixed(2)}`,
    ]);
  }

  const approved = approve(store, id, asWho, now, saw, token, mutationFrom(flags, now));
  if (!approved.ok) {
    if (approved.reason === "policy") return fail(write, json, "task approve", "policy", `${id}: ${approved.message}`, EXIT.refused);
    return fail(write, json, "task approve", approved.reason, describeApproveFailure(approved.reason, id), EXIT.refused);
  }

  return succeed(write, json, "task approve", { scope: approved.scope }, () => [
    `Approved. A builder may now work on ${id}, within this scope:`,
    ...describeScope(approved.scope),
  ]);
}

function describeApproveFailure(reason: string, id: string): string {
  if (reason === "changed") return "the scope changed since you read it — look again before approving";
  // v102: the project's approval rules.
  if (reason === "requester") return `you filed ${id}, and this project needs someone else to approve it`;
  if (reason === "person-required") return `${id} is protected work: a person has to approve it, not an operating mode, a routine or an AI teammate`;
  if (reason === "second-approver") return `your approval of ${id} is recorded; it is protected work, so a second person needs to approve it (toolroll task approve ${id} as them)`;
  if (reason === "no-approvers") {
    return "nobody can approve anything yet — `toolroll approver add <you>` mints the credential that lets a person say yes";
  }
  if (reason === "not-an-approver") return "that is not an approver, or the token does not match";
  if (reason === "unrouted") return `${id} was filed before agent routing and its old approval no longer stands — an approval now names exactly which agent plans, builds, repairs, and reviews: file the scope again (\`task scope ${id} …\`) so it is routed under today's agents, then approve it`;
  if (reason === "profile-unresolved") return `${id} cannot name an exact agent for every role — configure the project's agents (\`config set <phase> --provider … --model …\`), then \`routine refresh ${id}\` and approve it again`;
  return `${id} has no scope to approve`;
}

/**
 * The people allowed to agree to a scope.
 *
 * Kept apart from runners deliberately: a runner credential takes work, and an
 * approver credential agrees to it. One token that did both would collapse the
 * gate into a formality the moment an agent held it.
 */
/**
 * Who is acting, from flags — or from a person at the terminal. Scripts and
 * agents pass --as/--token and never see a prompt; a human who left them off
 * is simply asked, with the password hidden. Under --json (or any non-TTY)
 * missing credentials stay a usage refusal, exactly as before.
 */
export const PROPOSALS_ACTIONS = ["list", "confirm", "dismiss"] as const;

/**
 * `toolroll proposals` (mate arc v3): what coordinators proposed
 * over the gateway, and the doors that confirm or dismiss one — the same
 * doors the console runs, under a password-minted principal whose ceiling
 * is the `--repo` list or the enrolled registry.
 */
async function proposalsCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json, now } = context;
  const [action = "list", idGiven] = positional;
  if (!(PROPOSALS_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "proposals", "usage", `unknown \`proposals ${action}\` — try ${PROPOSALS_ACTIONS.join(", ")}`, EXIT.usage);
  }
  store.sweepCoordinatorProposals(now);
  let repos: string[] | null;
  if (context.repoList !== undefined && context.repoList.length > 0) {
    repos = context.repoList;
  } else {
    const loaded = await loadRepos(join(dirname(context.databaseFile), "repos.json")).catch(() => ({ error: "unreadable" }));
    if ("error" in loaded) return fail(write, json, `proposals ${action}`, "registry", "the enrolled-project registry could not be read — name projects with --repo", EXIT.refused);
    repos = loaded.repos;
  }
  if (action === "list") {
    const rows = store.listCoordinatorProposals({ repos, states: flags.has("all") ? ["pending", "confirming", "confirmed", "refused", "dismissed", "expired"] : ["pending"] });
    return succeed(write, json, "proposals list", { proposals: rows.map(one => ({ id: one.id, kind: one.kind, by: one.name, repo: one.repo, state: one.state, payload: one.payload, outcome: one.outcome, createdAt: one.createdAt })) }, () =>
      rows.length === 0
        ? ["No coordinator proposals are pending."]
        : rows.map(one => {
            const t = (key: string): string => (typeof one.payload[key] === "string" ? (one.payload[key] as string) : "");
            const what =
              one.kind === "answer"
                ? `answer decision #${String(one.payload["decision"])} on ${t("task")} with "${t("optionLabel")}"${one.payload["reversible"] === false ? " (irreversible — confirm with --yes)" : ""}: ${t("rationale")}`
                : one.kind === "next"
                  ? `move ${t("task")} to the front`
                  : one.kind === "reserve"
                    ? `${one.payload["worker"] === null ? `release ${t("task")} to the shared queue` : `reserve ${t("task")} for ${t("worker")}`}`
                    : one.kind === "hold"
                      ? `hold ${t("task")}: ${t("reason")}`
                      : one.kind === "unhold"
                        ? `release ${t("task")} from its hold`
                        : one.kind === "scope"
                          ? `rewrite the scope of ${t("task")}`
                          : `cancel ${t("task")}: ${t("reason")} (arm it yourself: toolroll task cancel ${t("task")})`;
            const head = `  #${one.id} ${what} — by ${one.name} in ${projectName(one.repo)} [${one.state}]`;
            return one.kind === "answer" ? [head, ...answerContextLines(store, one.payload)].join("\n") : head;
          }),
    );
  }
  const id = Number(idGiven);
  if (idGiven === undefined || !Number.isInteger(id) || id < 1) return fail(write, json, `proposals ${action}`, "usage", `which proposal? toolroll proposals ${action} <id>`, EXIT.usage);
  const acting = await askCredentials(flags, context);
  if (acting === null) return fail(write, json, `proposals ${action}`, "usage", "confirming or dismissing takes your name and password — `--as <you>` and the hidden prompt", EXIT.usage);
  const admitted = repos.length === 0 ? [] : repos;
  const verified = verifyApproverByPassword(store, acting.name, acting.token, admitted);
  if (!verified.ok) return fail(write, json, `proposals ${action}`, "unauthenticated", "that is not an approver, or the password does not match", EXIT.refused);
  if (action === "dismiss") {
    const done = dismissCoordinatorProposal(store, verified.who, id, now);
    return done
      ? succeed(write, json, "proposals dismiss", { proposal: id }, () => [`dismissed #${id}`])
      : fail(write, json, "proposals dismiss", "not-pending", "no pending proposal by that id in your projects", EXIT.refused);
  }
  // An answer is confirmed only after its context was shown (finding 4): the
  // confirm prints the question, every consequence, and the recommendation
  // before the door runs, and an irreversible one needs --yes on top.
  const row = store.getCoordinatorProposal(id);
  if (row !== null && row.kind === "answer" && !json) {
    for (const line of answerContextLines(store, row.payload)) write(line);
  }
  const outcome = confirmCoordinatorProposal(store, verified.who, id, now, { confirm: flags.has("yes"), via: "cli" });
  if (!outcome.ok) return fail(write, json, "proposals confirm", outcome.reason, outcome.reason === "needs-confirm" ? `${outcome.said} — read the consequences above, then pass --yes` : outcome.said, EXIT.refused);
  return succeed(write, json, "proposals confirm", { proposal: id, kind: outcome.kind, said: outcome.said, ...(outcome.taskId === null ? {} : { task: outcome.taskId }) }, () => [
    outcome.said,
    ...(outcome.kind === "scope" && outcome.taskId !== null ? [`approve it with your password: toolroll task approve ${outcome.taskId}`] : []),
  ]);
}

/**
 * `toolroll chat` (mate arc §6): the console's thread from a
 * terminal. The password mints the session once; the REPL runs turns and
 * confirms cards through the same doors the console uses.
 */
async function chatCommand(flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json } = context;
  if (flags.has("follow") && flags.has("no-follow")) return fail(write, json, "chat", "usage", "Choose --follow or --no-follow.", EXIT.usage);
  const credentials = await askCredentials(flags, context);
  if (credentials === null) {
    return fail(write, json, "chat", "usage", "the mate takes your name and password — `--as <you>` and the hidden prompt; `--token <t>` only where a script must (it lands in shell history)", EXIT.usage);
  }
  const ceilingGiven = text(flags, "ceiling-usd");
  // The ceiling: the `--repo` list, or the ENROLLED registry beside the
  // database (slice-2 review, finding 5) — never the opened-project history.
  // An unreadable registry refuses rather than inventing a ceiling.
  let repos: string[];
  if (context.repoList !== undefined && context.repoList.length > 0) {
    repos = context.repoList;
  } else {
    const loaded = await loadRepos(join(dirname(context.databaseFile), "repos.json")).catch(() => ({ error: "unreadable" }));
    if ("error" in loaded) return fail(write, json, "chat", "registry", "the enrolled-project registry could not be read — name projects with --repo", EXIT.refused);
    repos = loaded.repos;
  }
  const result = await runMateCli({
    store,
    databaseFile: context.databaseFile,
    write,
    json,
    credentials,
    repos,
    say: text(flags, "say"),
    end: flags.has("end"),
    ...(flags.has("follow") || flags.has("no-follow") ? { follow: flags.has("follow") && !flags.has("no-follow") } : {}),
    ceilingUsd: ceilingGiven === undefined ? undefined : Number(ceilingGiven),
    ...(context.mateSeams === undefined ? {} : { seams: { ...context.mateSeams, clock: context.mateSeams.clock ?? context.clock } }),
    ...(context.evidenceRoot === undefined ? {} : { evidenceRoot: context.evidenceRoot }),
    // The console's own address (and its public one): links there read as "the task", "the result", "Settings → Lead".
    appOrigin: [loadConsoleUrl(process.env, dirname(context.databaseFile)), phoneOrigin(process.env, dirname(context.databaseFile))],
  });
  return result.code;
}

/**
 * --as/--token, else the login `up` remembered beside the database
 * (owner-only, this machine). The person proved it once; asking again on
 * each act was the friction that pushed people back to the console. Flags
 * win, and a different --as than the remembered name is not answered.
 */
function credentialsFrom(
  flags: Map<string, string | true>,
  context: { databaseFile: string; leadToken?: string },
): { name: string | undefined; token: string | undefined } {
  // The lead signs in as its owner with its own token, never the owner's password.
  const lead = currentActor();
  if (context.leadToken !== undefined && lead?.lead === true) return { name: lead.account, token: context.leadToken };
  let name = text(flags, "as");
  let token = text(flags, "token");
  if (token === undefined) {
    const remembered = readLoginFile(join(dirname(context.databaseFile), UP_LOGIN_FILE));
    if (remembered !== null && (name === undefined || name === remembered.name)) {
      name = remembered.name;
      token = remembered.password;
    }
  }
  return { name, token };
}

async function askCredentials(
  flags: Map<string, string | true>,
  context: Context,
): Promise<{ name: string; token: string } | null> {
  let { name, token } = credentialsFrom(flags, context);
  if ((name === undefined || token === undefined) && interactive() && !context.json) {
    name ??= await ask("username: ");
    token ??= await askHidden("password: ");
  }
  if (name === undefined || token === undefined || name === "" || token === "") return null;
  return { name, token };
}

/** `flows …`: the console's flow rules from a terminal. Writes are an approver's (--as/--token or the remembered login). */
async function flowsCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store } = context;
  const registered = await loadRepos(registryPathOf(context)).catch(() => ({ error: "unreadable" }));
  const projects = [...new Set([...store.knownRepos(), ...store.listProjects().map(one => one.path), ...("error" in registered ? [] : registered.repos)])];
  const writes = positional[0] !== undefined && positional[0] !== "list" && positional[0] !== "show" && positional[0] !== "export";
  const acting = writes && !flags.has("help") ? await askCredentials(flags, context) : null;
  const dir = dirname(context.databaseFile);
  return runFlowsCommand(positional, flags, {
    store, write: context.write, json: context.json, clock: context.clock, credentials: acting, projects, configDir: dir, evidenceRoot: context.evidenceRoot,
    ...(context.flowFetch === undefined ? {} : { fetchFlow: context.flowFetch }),
    // "Check now": the same io the worker's pass checks triggers with.
    triggerIo: { gh: context.flowTriggerIo?.gh ?? run, fetch: context.flowTriggerIo?.fetch ?? fetch, dir: context.flowTriggerIo?.dir ?? dir,
      shell: context.flowTriggerIo?.shell ?? context.flowStepIo?.shell ?? run, scratch: context.flowTriggerIo?.scratch ?? join(dir, "flow-scratch"),
      ...(context.flowTriggerIo?.mail === undefined ? {} : { mail: context.flowTriggerIo.mail }) },
  });
}

async function approverCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const [action, name] = positional;
  if (action !== undefined && !(APPROVER_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "approver", "usage", `unknown \`approver ${action}\` — try ${APPROVER_ACTIONS.join(", ")}`, EXIT.usage);
  }

  if (action === "list" || action === undefined) {
    const approvers = store.listApprovers();
    if (json) {
      write(envelopeJson({ ok: true, command: "approver list", approvers }));
      return EXIT.ok;
    }
    if (approvers.length === 0) {
      write("Nobody can approve a scope yet, so nothing can be built.");
      write("  toolroll approver add <your name>");
      return EXIT.ok;
    }
    for (const one of approvers) write(`  ${one.name}  since ${one.addedAt}`);
    return EXIT.ok;
  }

  if (action === "add") {
    if (name === undefined) {
      return fail(write, json, "approver add", "usage", "an approver needs a name", EXIT.usage);
    }
    let password = text(flags, "password");
    const bootstrap = store.listApprovers().length === 0;
    let by: { name: string; token: string } | undefined;
    if (!bootstrap) {
      const vouched = await askCredentials(flags, context);
      if (vouched !== null) by = vouched;
    }
    if (password === undefined && interactive() && !json) {
      const chosen = await askHidden(`password for ${name} (enter to auto-generate): `);
      if (chosen !== "") {
        const again = await askHidden("again: ");
        if (again !== chosen) {
          return fail(write, json, "approver add", "mismatch", "the two passwords did not match", EXIT.refused);
        }
        password = chosen;
      }
    }

    const added = addApprover(store, name, now, by, undefined, mutationFrom(flags, now), password);
    if (!added.ok) {
      return fail(
        write,
        json,
        "approver add",
        added.reason,
        added.reason === "weak-password"
          ? "a password needs at least 8 characters"
          : "only an existing approver can add another — `--as <you> --token <your password>`",
        EXIT.refused,
      );
    }

    return succeed(write, json, "approver add", { ...added, ...(added.chosen ? { token: "(chosen)" } : {}) }, () => [
      `${added.name} may now sign in and approve scopes.`,
      "",
      ...(added.chosen
        ? ["Password set — stored salted and stretched, never readable again."]
        : [
            `  password  ${added.token}`,
            "",
            "Shown once, stored only as a hash. Keep it somewhere an agent cannot read",
            "(or choose your own next time: `approver add <name> --password <yours>`).",
          ]),
      ...(added.bootstrap
        ? [
            "",
            "This was the first approver, so nothing had to vouch for it. Adding any",
            "further approver now requires an existing one — do this before anything",
            "else can reach this queue.",
          ]
        : []),
    ]);
  }

  return fail(write, json, "approver", "usage", `unknown \`approver ${action}\` — try list or add`, EXIT.usage);
}

function holdTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  const reason = text(flags, "reason");
  if (id === undefined || reason === undefined) {
    return fail(write, json, "task hold", "usage", "`toolroll task hold <id> --reason <why>`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task hold", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const untilText = text(flags, "until");
  const until = untilText === undefined ? null : new Date(untilText);
  if (until !== null && Number.isNaN(until.getTime())) {
    return fail(write, json, "task hold", "usage", "--until takes a date, e.g. 2026-08-12T09:00:00Z", EXIT.usage);
  }

  store.hold(store.refFor(BUILT_IN, id).id, reason, until, now, mutationFrom(flags, now));
  return succeed(write, json, "task hold", { id, reason, until: until?.toISOString() ?? null }, () => [
    `${id} is on hold${until === null ? "" : ` until ${until.toISOString()}`}: ${reason}`,
  ]);
}

function unholdTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  if (id === undefined) return fail(write, json, "task unhold", "usage", "which task?", EXIT.usage);
  if (store.getTask(id) === null) {
    return fail(write, json, "task unhold", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }
  const racingGuard = refuseWhileRacing(context, "task unhold", id);
  if (racingGuard !== null) return racingGuard;

  const lifted = store.unhold(store.refFor(BUILT_IN, id).id, mutationFrom(flags, context.now));
  if (!lifted) return fail(write, json, "task unhold", "not-held", `${id} was not on hold`, EXIT.refused);

  return succeed(write, json, "task unhold", { id }, () => [`${id} is off hold.`]);
}

/**
 * `toolroll task stop <id> --run <n> --as <you> --token <t>` (v52):
 * the authenticated stop of ONE exact active attempt. The answer is "stop
 * requested" — the request is durable before any process is signalled;
 * settlement is reported by `task show` once the attempt's own processes
 * are established gone. A repeated request answers the same; a stale one
 * (an attempt that already ended, or one that no longer holds the task)
 * is refused in words and touches nothing.
 */
async function stopTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const id = positional[0];
  const runText = text(flags, "run");
  const runId = Number(runText ?? "");
  if (id === undefined || runText === undefined || !Number.isInteger(runId) || runId < 1) {
    return fail(write, json, "task stop", "usage", "`toolroll task stop <id> --run <run-id> --as <you> --token <t>` — the stop names one exact attempt", EXIT.usage);
  }
  if (store.getTask(id) === null) return fail(write, json, "task stop", "unknown-task", `no task \`${id}\``, EXIT.refused);
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task stop", "usage", "stopping takes `--as <you> --token <t>` — it is an operator's act and is recorded against your name", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, "task stop", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }
  const asked = requestTaskStop(store, { taskId: id, runId, by: acting.name, via: "cli" }, clock());
  if (!asked.ok) return fail(write, json, "task stop", asked.reason, asked.detail, EXIT.refused, { run: runId });
  const control = taskControlOf(store, store.refFor(BUILT_IN, id).id, clock());
  return succeed(write, json, "task stop", { id, run: runId, requested: !asked.repeated, repeated: asked.repeated, terminated: asked.terminated, stop: asked.stop, control }, () => [
    asked.repeated
      ? `Run #${runId} of ${id} was already asked to stop (by ${asked.stop.requestedBy} at ${asked.stop.requestedAt}); nothing changed.`
      : `Stop requested for run #${runId} of ${id}.`,
    asked.stop.settledAt === null
      ? `  It is stopping: its own processes are being ended${asked.terminated > 0 ? ` (${asked.terminated} process group${asked.terminated === 1 ? "" : "s"} signalled here)` : ""}; \`task show ${id}\` reports when it has settled.`
      : `  Settled (${asked.stop.settlement}).`,
    "  Its branch, uncommitted work, evidence, and decisions are preserved; the task stays paused until this exact attempt is resumed.",
  ]);
}

/**
 * `toolroll task resume <id> --run <n> --as <you> --token <t>` (v52):
 * resume the exact stopped attempt the operator reviewed. Refuses until it
 * is quiescent; lifts only the hold that stop owns; approves nothing — the
 * next pass re-proves the signed scope and takes a fresh claim. The gate
 * that still keeps work from starting, if any, is printed rather than
 * hidden behind "resumed".
 */
async function resumeTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const id = positional[0];
  const runText = text(flags, "run");
  const runId = Number(runText ?? "");
  if (id === undefined || runText === undefined || !Number.isInteger(runId) || runId < 1) {
    return fail(write, json, "task resume", "usage", "`toolroll task resume <id> --run <run-id> --as <you> --token <t>` — the resume names the exact stopped attempt", EXIT.usage);
  }
  if (store.getTask(id) === null) return fail(write, json, "task resume", "unknown-task", `no task \`${id}\``, EXIT.refused);
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task resume", "usage", "resuming takes `--as <you> --token <t>` — it lets the next pass spend again", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, "task resume", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");
  const worktrees = new WorktreePool(store, { root: pool });
  const resumed = resumeTaskStop(store, { taskId: id, runId, by: acting.name, via: "cli", occupied: path => worktrees.inUse(path) }, clock());
  if (!resumed.ok) {
    if (resumed.reason === "review") {
      return fail(write, json, "task resume", "review", `${resumed.detail} — separate model review has been removed; inspect the saved source result`, EXIT.refused, { run: runId });
    }
    return fail(write, json, "task resume", resumed.reason, resumed.detail, EXIT.refused, { run: runId });
  }
  const control = taskControlOf(store, store.refFor(BUILT_IN, id).id, clock());
  return succeed(write, json, "task resume", { id, run: runId, stop: resumed.stop, gate: resumed.gate, control }, () => [
    `Resumed ${id} from run #${runId}: the stop's hold is lifted; every other hold stands.`,
    resumed.gate === null
      ? "  The next pass takes a fresh claim, re-proves the signed scope, and inherits the preserved draft with fresh proof."
      : `  Not starting yet — ${resumed.gate.summary}: ${resumed.gate.detail}`,
  ]);
}

/**
 * `toolroll run settle <id> --why "<text>" --as <you> --token <t>`: an
 * approver's last resort for a finished run whose process witnesses can be
 * proven neither exited nor alive (a spawn interrupted before its pid was
 * written). Refuses while anything of the run is alive; the reason is kept
 * in the ledger against the approver's name. Signals nothing.
 */
async function runCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, id, ...extra] = positional;
  const command = "run settle";
  const usage = "`toolroll run settle <run-id> --why \"<reason>\" --as <you> --token <t>`";
  if (action !== "settle") return fail(write, json, "run", "usage", usage, EXIT.usage);
  const runId = Number(id ?? "");
  const why = text(flags, "why")?.trim();
  if (id === undefined || extra.length > 0 || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(runId)) return fail(write, json, command, "usage", usage, EXIT.usage);
  if (why === undefined || why === "" || why.length > 300 || /[\x00-\x1f\x7f]/.test(why)) {
    return fail(write, json, command, "usage", "say why in one line with --why (at most 300 characters) — it is kept in the ledger", EXIT.usage);
  }
  const run = store.getRun(runId);
  if (run === null) return fail(write, json, command, "unknown-run", `no run #${runId}`, EXIT.refused);
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, command, "usage", "settling takes `--as <you> --token <t>` — it is an approver's act and is recorded against your name", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  const repo = store.refById(run.taskRef)?.repo ?? null;
  if (!authenticated.ok || !store.accountCanAccess(acting.name, repo)) {
    return fail(write, json, command, "not-an-approver", "that is not an approver for this run's project, or the token does not match", EXIT.refused);
  }
  const settled = store.settleRunWitnessesByApprover({ runId, by: acting.name, why }, clock());
  if (!settled.ok) return fail(write, json, command, settled.reason, settled.detail, EXIT.refused, { run: runId });
  return succeed(write, json, command, { run: runId, witnesses: settled.witnesses, repeated: settled.repeated }, () => [
    settled.repeated
      ? `Run #${runId} has no unsettled process witness; nothing changed.`
      : `Settled run #${runId}: ${settled.witnesses.length} process witness${settled.witnesses.length === 1 ? "" : "es"} recorded as ended, with your reason in the ledger.`,
  ]);
}

// ---- shared ---------------------------------------------------------------

/**
 * `project rules --repo <path>` shows a project's approval rules (v102);
 * with --not-requester on|off, --protect none|project or --protect-paths
 * "a/**,b/**" an instance operator changes them (with --as/--token, or the
 * remembered login). The ledger keeps before → after, as in Settings.
 */
async function projectRulesCommand(positional: readonly string[], flags: Map<string, string | true>, context: Parameters<typeof taskCommand>[2]): Promise<number> {
  const command = "project rules";
  const allowed = new Set(["repo", "not-requester", "protect", "protect-paths", "as", "token", "token-file", "token-env", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a project rules option.`, EXIT.usage);
  const repoFlag = text(flags, "repo");
  if (positional.length > 1 || repoFlag === undefined) return fail(context.write, context.json, command, "usage", "Use project rules --repo <project path> [--not-requester on|off] [--protect none|project] [--protect-paths \"infra/**,migrations/**\"].", EXIT.usage);
  // The projects Settings shows: those with work, and those registered (enrolled) with none yet.
  const registered = await loadRepos(registryPathOf(context)).catch(() => ({ error: "unreadable" }));
  const known = [...new Set([...context.store.knownRepos(), ...("error" in registered ? [] : registered.repos)])];
  const repo = known.find(one => one === repoFlag || one === resolve(repoFlag));
  if (repo === undefined) return fail(context.write, context.json, command, "not-found", "That isn't a project Toolroll knows.", EXIT.refused);
  const current = context.store.approvalRules(repo);
  const changing = ["not-requester", "protect", "protect-paths"].some(name => flags.has(name));
  if (!changing) {
    return succeed(context.write, context.json, command, { repo, rules: current }, () => [`${repo}: ${rulesSummary(current)}`]);
  }
  const onOff = text(flags, "not-requester");
  if (onOff !== undefined && onOff !== "on" && onOff !== "off") return fail(context.write, context.json, command, "usage", "--not-requester takes on or off.", EXIT.usage);
  const protect = text(flags, "protect");
  if (protect !== undefined && protect !== "none" && protect !== "project") return fail(context.write, context.json, command, "usage", "--protect takes none or project; list paths with --protect-paths.", EXIT.usage);
  const pathsFlag = text(flags, "protect-paths");
  const paths = pathsFlag === undefined ? null : parseProtectedPaths(pathsFlag);
  if (paths !== null && !paths.ok) return fail(context.write, context.json, command, "usage", paths.problem, EXIT.usage);
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(context.store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok || !context.store.isInstanceOperator(acting.name)) {
    return fail(context.write, context.json, command, "refused", "An instance operator changes approval rules: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const next = {
    notRequester: onOff === undefined ? current.notRequester : onOff === "on",
    protectProject: protect === undefined ? (paths !== null && paths.ok ? false : current.protectProject) : protect === "project",
    protectedPaths: protect !== undefined ? [] : paths !== null && paths.ok ? paths.paths : current.protectedPaths,
  };
  context.store.setApprovalRules(repo, next, acting.name, context.clock());
  return succeed(context.write, context.json, command, { repo, rules: next }, () => [`${repo}: ${rulesSummary(next)}`]);
}

/** `project concurrency [<n>] --repo <p>`: how many of a project's tasks build at once. Changing it is an approver's act. */
async function projectConcurrencyCommand(positional: readonly string[], flags: Map<string, string | true>, context: Parameters<typeof taskCommand>[2]): Promise<number> {
  const command = "project concurrency";
  const allowed = new Set(["repo", "as", "token", "token-file", "token-env", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a project concurrency option.`, EXIT.usage);
  const repoFlag = text(flags, "repo");
  if (positional.length > 2 || repoFlag === undefined) return fail(context.write, context.json, command, "usage", "Use project concurrency [<n>] --repo <project path>.", EXIT.usage);
  const registered = await loadRepos(registryPathOf(context)).catch(() => ({ error: "unreadable" }));
  const known = [...new Set([...context.store.knownRepos(), ...("error" in registered ? [] : registered.repos)])];
  const repo = known.find(one => one === repoFlag || one === resolve(repoFlag) || one === canonicalProject(repoFlag));
  if (repo === undefined) return fail(context.write, context.json, command, "not-found", "That isn't a project Toolroll knows.", EXIT.refused);
  const workers = context.store.listRunners().filter(one => one.retiredAt === null && one.repos.includes(repo));
  const capacity = workers.length === 0 ? null : Math.max(...workers.map(one => one.capacity));
  const words = (n: number): string =>
    `${repo}: builds up to ${n} at once${capacity !== null && capacity < n ? ` (its worker runs ${capacity} at once, so ${capacity} for now)` : ""}.`;
  const given = positional[1];
  if (given === undefined) {
    const current = projectConcurrency(context.databaseFile, repo);
    return succeed(context.write, context.json, command, { repo, concurrency: current, workerCapacity: capacity }, () => [words(current)]);
  }
  const n = parseProjectConcurrency(given);
  if (n === null) return fail(context.write, context.json, command, "usage", `Builds at once is a whole number from 1 to ${RUNNER_CAPACITY_MAX}.`, EXIT.usage);
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(context.store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok || !context.store.accountCanAccess(acting.name, repo)) {
    return fail(context.write, context.json, command, "refused", "An approver for this project changes how many tasks build at once: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const changed = saveProjectConcurrency(context.databaseFile, repo, n);
  context.store.recordProjectConcurrency(acting.name, repo, changed.before, changed.after, context.clock());
  context.store.bumpWake();
  return succeed(context.write, context.json, command, { repo, before: changed.before, concurrency: changed.after, workerCapacity: capacity }, () => [
    words(changed.after),
    ...(changed.before > changed.after ? ["Builds already running carry on; the new number applies to the next one."] : []),
  ]);
}

/** `project checks [--batch on|off] --repo <p>`: whether the project's results share one full check when they
 * finish close together (batch-checks.ts). Off by default; changing it is an approver's act, in the ledger. */
async function projectChecksCommand(positional: readonly string[], flags: Map<string, string | true>, context: Parameters<typeof taskCommand>[2]): Promise<number> {
  const command = "project checks";
  const allowed = new Set(["repo", "batch", "as", "token", "token-file", "token-env", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a project checks option.`, EXIT.usage);
  const repoFlag = text(flags, "repo");
  const wanted = flags.get("batch");
  if (positional.length > 1 || repoFlag === undefined || (wanted !== undefined && wanted !== "on" && wanted !== "off")) {
    return fail(context.write, context.json, command, "usage", "Use project checks [--batch on|off] --repo <project path>.", EXIT.usage);
  }
  const registered = await loadRepos(registryPathOf(context)).catch(() => ({ error: "unreadable" }));
  const known = [...new Set([...context.store.knownRepos(), ...context.store.listProjects().map(one => one.path), ...("error" in registered ? [] : registered.repos)])];
  const repo = known.find(one => one === repoFlag || one === resolve(repoFlag) || one === canonicalProject(repoFlag));
  if (repo === undefined) return fail(context.write, context.json, command, "not-found", "That isn't a project Toolroll knows.", EXIT.refused);
  const level = projectCheckLevel(context.store, repo).level;
  const words = (on: boolean): string[] => [
    `${repo}: batch checks are ${on ? "on" : "off"}. ${on ? BATCH_HINT : "Each result runs its own full check."}`,
    ...(on && level !== "full" ? [`Checks are ${CHECK_LEVEL_WORDS[level]} for this project, so nothing is batched until they are Full.`] : []),
  ];
  if (wanted === undefined) {
    const current = projectBatchChecks(context.store, repo);
    return succeed(context.write, context.json, command, { repo, batch: current.on, windowMinutes: current.windowMs / 60_000, level, setBy: current.setBy }, () => words(current.on));
  }
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(context.store, acting.name, acting.token, repo);
  if (acting === null || verified === null || !verified.ok || !context.store.accountCanAccess(acting.name, repo)) {
    return fail(context.write, context.json, command, "refused", "An approver for this project changes batch checks: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const on = wanted === "on";
  const changed = setProjectBatchChecks(context.store, repo, on, acting.name, context.clock());
  return succeed(context.write, context.json, command, { repo, batch: on, before: changed.before, changed: changed.changed, windowMinutes: BATCH_WINDOW_MS / 60_000, level }, () => [
    ...words(on),
    ...(changed.changed && !on ? ["Results already waiting are checked now."] : []),
  ]);
}

/** `project demo [<url>|off] --repo <p>` (review 827): the project's own demo or dev server, which its scouts may
 * screenshot. Changing it is an approver's act. */
async function projectDemoCommand(positional: readonly string[], flags: Map<string, string | true>, context: Parameters<typeof taskCommand>[2]): Promise<number> {
  const command = "project demo";
  const allowed = new Set(["repo", "as", "token", "token-file", "token-env", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a project demo option.`, EXIT.usage);
  const repoFlag = text(flags, "repo");
  if (positional.length > 2 || repoFlag === undefined) return fail(context.write, context.json, command, "usage", "Use project demo [<url>|off] --repo <project path>.", EXIT.usage);
  const registered = await loadRepos(registryPathOf(context)).catch(() => ({ error: "unreadable" }));
  const known = [...new Set([...context.store.knownRepos(), ...("error" in registered ? [] : registered.repos)])];
  const repo = known.find(one => one === repoFlag || one === resolve(repoFlag) || one === canonicalProject(repoFlag));
  if (repo === undefined) return fail(context.write, context.json, command, "not-found", "That isn't a project Toolroll knows.", EXIT.refused);
  const words = (url: string | null): string => url === null ? `${repo}: no demo; scouts screenshot public pages only.` : `${repo}: scouts may also screenshot ${url}.`;
  const given = positional[1];
  if (given === undefined) {
    const current = projectDemoUrl(context.databaseFile, repo);
    return succeed(context.write, context.json, command, { repo, demoUrl: current }, () => [words(current)]);
  }
  const url = given.trim().toLowerCase() === "off" ? null : parseDemoUrl(given);
  if (url === null && given.trim().toLowerCase() !== "off") return fail(context.write, context.json, command, "usage", "The demo is an http or https address without a sign-in, or off.", EXIT.usage);
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(context.store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok || !context.store.accountCanAccess(acting.name, repo)) {
    return fail(context.write, context.json, command, "refused", "An approver for this project sets its demo: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const changed = saveProjectDemo(context.databaseFile, repo, url);
  context.store.recordProjectDemo(acting.name, repo, changed.before, changed.after, context.clock());
  return succeed(context.write, context.json, command, { repo, before: changed.before, demoUrl: changed.after }, () => [words(changed.after)]);
}

/** Write a pack or export where asked (never over an existing file), or to the terminal. */
function writeOut(context: Context, command: string, out: string | undefined, content: string, summary: Record<string, unknown>, line: string, data: Record<string, unknown>): number {
  if (out === undefined) { context.write(context.json ? envelopeJson({ ok: true, command, ...summary, ...data }) : content.replace(/\n$/, "")); return EXIT.ok; }
  try { writeFileSync(resolve(out), content, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    return fail(context.write, context.json, command, exists ? "exists" : "unwritable", exists ? "That file exists already; choose another name." : "That file couldn't be written.", EXIT.failed);
  }
  return succeed(context.write, context.json, command, { ...summary, out: resolve(out) }, () => [`${line} Saved to ${resolve(out)}.`]);
}

/** `project delete --repo <path> [--yes]`: without --yes, what would go; with it, everything Toolroll holds for the
 * project goes (never its repository or branches it didn't make). An instance operator; refused while its work runs. */
async function projectDeleteCommand(positional: readonly string[], flags: Map<string, string | true>, context: Parameters<typeof taskCommand>[2]): Promise<number> {
  const command = "project delete";
  const allowed = new Set(["repo", "yes", "as", "token", "token-file", "token-env", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a project delete option.`, EXIT.usage);
  const repoFlag = text(flags, "repo");
  if (positional.length > 1 || repoFlag === undefined) return fail(context.write, context.json, command, "usage", "Use project delete --repo <project path> [--yes].", EXIT.usage);
  const registryFile = registryPathOf(context);
  const registered = await loadRepos(registryFile).catch(() => ({ error: "unreadable" }));
  const known = [...new Set([...context.store.knownRepos(), ...context.store.listProjects().map(one => one.path), ...("error" in registered ? [] : registered.repos)])];
  const repo = known.find(one => one === repoFlag || one === resolve(repoFlag));
  if (repo === undefined) return fail(context.write, context.json, command, "not-found", "That isn't a project Toolroll knows.", EXIT.refused);
  const store = context.store;
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok || !store.isInstanceOperator(acting.name)) {
    return fail(context.write, context.json, command, "refused", "An instance operator deletes projects: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const holdings = projectHoldings(store, repo);
  const running = projectRunning(store, repo, context.clock());
  if (running.length > 0) return fail(context.write, context.json, command, "running", `Nothing was deleted: ${running.join(", ")}. Stop it, then try again.`, EXIT.refused);
  if (!flags.has("yes")) {
    return succeed(context.write, context.json, command, { repo, deleted: false, holdings }, () => [
      `${repo}: Toolroll holds ${holdingsWords(holdings)} for it, and the checkouts and toolroll/ (or older standing-orders/) branches it made.`,
      "Deleting removes all of it; the repository and its own branches stay. There's no undo. Add --yes to delete.",
    ]);
  }
  const done = await deleteProject(store, repo, { actor: acting.name, via: "command line", now: context.clock(), evidenceRoot: context.evidenceRoot ?? join(dirname(context.databaseFile), "evidence"), poolRoot: join(dirname(context.databaseFile), "worktrees") });
  if (!done.ok) return fail(context.write, context.json, command, done.reason, done.said, done.reason === "running" ? EXIT.refused : EXIT.failed);
  if (!("error" in registered) && registered.repos.includes(repo)) await updateRepos(registryFile, repos => removeRepos(repos, [repo])).catch(() => undefined);
  return succeed(context.write, context.json, command, { repo, deleted: true, removed: done.removed, left: done.left, ledgerEntry: done.ledgerId }, () => [
    `Deleted ${repo}: ${holdingsWords(done.removed)}.`, ...done.left.map(one => `Git kept ${one}.`), `The ledger records it as entry #${done.ledgerId}.`,
  ]);
}

/** `spend [--month YYYY-MM] [--csv]` (v105): what agent work cost in a month, by project, person, teammate and model. */
function spendCommand(flags: Map<string, string | true>, context: Context): number {
  const command = "spend";
  for (const name of flags.keys()) if (!["month", "csv", "db", "json"].includes(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a spend option.`, EXIT.usage);
  const month = text(flags, "month") === undefined ? monthOf(context.clock()) : monthNamed(text(flags, "month") ?? null);
  if (month === null) return fail(context.write, context.json, command, "usage", "Use spend --month YYYY-MM.", EXIT.usage);
  const items = spendItems(context.store.handle, month.from, month.to);
  const names = teammateNames(context.store.handle);
  if (flags.has("csv")) { context.write(spendCsv(items, names).replace(/^\ufeff/, "").trimEnd()); return EXIT.ok; }
  const budgets = budgetStates(context.store.budgets(), items);
  const total = items.reduce((sum, item) => sum + (item.microusd ?? 0), 0);
  const unpriced = items.filter(item => item.microusd === null && (item.tokensIn !== null || item.kind !== "run")).length;
  const byProject = new Map<string, number>();
  for (const item of items) if (item.project !== null) byProject.set(item.project, (byProject.get(item.project) ?? 0) + (item.microusd ?? 0));
  // v105: subscription work is $0; what binds it is its plan's windows, as the provider last said.
  const limits = context.store.providerLimits();
  const windows = limitsView(limits, [], { project: repo => basename(repo), teammate: id => String(id) }, context.clock())?.tiles ?? [];
  // Sized routing: each tier's tasks, time to a result and plan use, and what the tiers saved.
  const tiers = tierReport(context.store.handle, month.from, month.to, items);
  return succeed(context.write, context.json, command, { month: month.name, totalMicrousd: total, unpriced, items: items.length, budgets, limits, tiers: { rows: tiers.rows, saved: tiers.saved } }, () => [
    `${month.name}: ${spendUsd(total)} (${items.length} pieces of work${unpriced > 0 ? `, ${unpriced} unpriced` : ""}; subscription work is $0)`,
    ...windows.map(tile => `  ${`${tile.name} ${tile.window}`.padEnd(24)} ${tile.value}% · ${tile.detail}`),
    ...[...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([repo, microusd]) => `  ${basename(repo).padEnd(24)} ${spendUsd(microusd)}`),
    ...budgets.map(one => `  budget ${budgetLabel(one, names.get(Number(one.key))).replace(/'s$/, "").padEnd(24)} ${spendUsd(one.spentMicrousd)} of ${spendUsd(one.limitMicrousd)} (${one.percent}%)${one.hardStop ? "" : " alerts only"}`),
    ...tierLines(tiers, spendUsd),
  ]);
}

/** `backup now | list` (sprint 8): back the database up now, or list backups and how the latest ones went. */
async function backupCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const [action, ...extra] = positional;
  const command = `backup ${action ?? ""}`.trim();
  for (const name of flags.keys()) if (!["db", "json"].includes(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a backup option.`, EXIT.usage);
  if (extra.length > 0 || (action !== "now" && action !== "list")) return fail(context.write, context.json, command, "usage", "Use backup now or backup list.", EXIT.usage);
  const store = context.store;
  if (action === "now") {
    const made = await backupNow(store, context.databaseFile, "manual", context.clock);
    if (!made.ok) return fail(context.write, context.json, command, "failed", `The backup failed: ${made.error}`, EXIT.failed, { backup: made.id });
    return succeed(context.write, context.json, command, { backup: made }, () => [
      `Backed up to ${made.file} (${bytesWords(made.bytes)}).${made.removed === 0 ? "" : ` Removed ${made.removed} older ${made.removed === 1 ? "backup" : "backups"}.`}`,
    ]);
  }
  const settings = store.backupSettings();
  const folder = backupFolderOf(settings, context.databaseFile);
  const files = backupFiles(folder, backupOwner(store, context.databaseFile));
  const runs = store.backupRuns(10);
  const last = runs[0] ?? null;
  return succeed(context.write, context.json, command, { settings, folder, files, runs }, () => [
    settings.enabled ? `Every ${settings.everyHours === 1 ? "hour" : `${settings.everyHours} hours`}, keeping the newest ${settings.keep}, in ${folder}.` : `Scheduled backups are off. Backups are kept in ${folder}.`,
    last === null ? "No backup has run yet." : last.ok === true ? `Last backup ${last.startedAt.slice(0, 16).replace("T", " ")} UTC: succeeded.` : last.ok === false ? `Last backup ${last.startedAt.slice(0, 16).replace("T", " ")} UTC: FAILED (${last.error ?? "no reason recorded"}).` : `A backup started ${last.startedAt.slice(0, 16).replace("T", " ")} UTC is still running.`,
    ...(files.length === 0 ? ["No backups of this database in the folder."] : files.map(one => `  ${one.name}  ${bytesWords(one.bytes)}`)),
  ]);
}

/** `restore <file> [--dry-run]` (sprint 8): put a backup back. Refuses while Toolroll is running; checks the
 * backup's schema version and ledger chain; keeps the current database as a copy first. */
async function restoreCommand(file: string, positional: readonly string[], flags: Map<string, string | true>, write: Write, json: boolean, now: Date): Promise<number> {
  const command = "restore";
  for (const name of flags.keys()) if (!["db", "json", "dry-run"].includes(name)) return fail(write, json, command, "usage", `--${name} is not a restore option.`, EXIT.usage);
  const [backupFile, ...extra] = positional;
  if (backupFile === undefined || extra.length > 0) return fail(write, json, command, "usage", "Use restore <backup file> [--dry-run].", EXIT.usage);
  const dryRun = flags.has("dry-run");
  let report;
  try { report = await restoreDatabase({ databaseFile: file, file: backupFile, dryRun, now }); }
  catch (error) { return fail(write, json, command, "failed", `The restore failed: ${describe(error)}. The database is unchanged.`, EXIT.failed); }
  if (!report.ok) {
    return fail(write, json, command, report.refusals[0]?.reason ?? "refused", ["Nothing was restored.", ...report.refusals.map(one => `  ${one.words}`)].join("\n"), EXIT.refused, { report });
  }
  const checked = `schema ${report.schemaVersion}, ledger chain verified (${report.ledger?.entries ?? 0} entries)`;
  return succeed(write, json, command, { report }, () => dryRun
    ? [`Dry run: ${report.file} can be restored (${checked}). Nothing was changed.`]
    : [`Restored ${report.file} (${checked}).`, `The database as it was is kept at ${report.savedAs}.`]);
}

/** `export --out <path> [--zip]` (v105): everything Toolroll knows, in a new folder or .zip, without secrets. */
function exportCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): number {
  const command = "export";
  for (const name of flags.keys()) if (!["out", "zip", "db", "json"].includes(name)) return fail(context.write, context.json, command, "usage", `--${name} is not an export option.`, EXIT.usage);
  const out = text(flags, "out");
  if (positional.length > 0 || out === undefined || out === "") return fail(context.write, context.json, command, "usage", "Use export --out <path> [--zip].", EXIT.usage);
  const target = resolve(out);
  if (existsSync(target)) return fail(context.write, context.json, command, "exists", "That path exists already; choose a new one.", EXIT.failed);
  // Reading the database file needs no login, so the ledger names the road, not a person it can't vouch for.
  const who = "command line";
  const now = context.clock();
  const zip = flags.has("zip");
  context.store.recordAction({ at: now.toISOString(), actor: who, repo: null, taskId: null, runId: null, action: "everything exported", outcome: "exported", source: "access", detail: zip ? "as a .zip" : "as a folder" });
  const exported = buildExport(context.store, { who, now, evidenceRoot: context.evidenceRoot, configDir: dirname(context.databaseFile) });
  try {
    if (zip) writeFileSync(target, exportZip(exported), { mode: 0o600, flag: "wx" });
    else writeExportFolder(target, exported);
  } catch {
    return fail(context.write, context.json, command, "unwritable", "The export couldn't be written there.", EXIT.failed);
  }
  return succeed(context.write, context.json, command, { out: target, zip, files: exported.files.length, tables: exported.tables, packs: exported.packs },
    () => [`Exported ${exportSummary(exported)} to ${target}.`, "manifest.json lists every file with its SHA-256; README.md explains the layout."]);
}

/** `budget list | set | remove` (v105): monthly budgets. Setting and removing take an instance operator. */
async function budgetCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const [action] = positional;
  const command = `budget ${action ?? ""}`.trim();
  const store = context.store;
  if (action === undefined || action === "list") {
    const budgets = store.monthSpend(context.clock()).budgets;
    return succeed(context.write, context.json, command, { budgets }, () => budgets.length === 0 ? ["No budgets. `budget set --all|--project <path>|--person <name>|--teammate <id> --usd <n>` makes one."]
      : budgets.map(one => `#${one.id} ${budgetLabel(one).replace(/'s$/, "")}: ${spendUsd(one.spentMicrousd)} of ${spendUsd(one.limitMicrousd)} this month (${one.percent}%)${one.hardStop ? ", stops API work at 100%" : ", alerts only"}`));
  }
  if (action !== "set" && action !== "remove") return fail(context.write, context.json, command, "usage", "Use budget list, budget set or budget remove.", EXIT.usage);
  const allowed = new Set(["all", "project", "person", "teammate", "usd", "alerts-only", "as", "token", "token-file", "token-env", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a budget option.`, EXIT.usage);
  const chosen = [flags.has("all") ? { scope: "installation" as const, key: "*" } : null,
    text(flags, "project") === undefined ? null : { scope: "project" as const, key: resolve(text(flags, "project")!) },
    text(flags, "person") === undefined ? null : { scope: "person" as const, key: text(flags, "person")! },
    text(flags, "teammate") === undefined ? null : { scope: "teammate" as const, key: text(flags, "teammate")! }].filter(one => one !== null);
  if (chosen.length !== 1) return fail(context.write, context.json, command, "usage", "Name one of --all, --project <path>, --person <name> or --teammate <id>.", EXIT.usage);
  const target = chosen[0]!;
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok || !store.isInstanceOperator(acting.name)) {
    return fail(context.write, context.json, command, "refused", "An instance operator sets budgets: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const known = target.scope === "installation" || (target.scope === "project" ? store.knownRepos().includes(target.key)
    : target.scope === "person" ? store.accountFacts().some(one => one.name === target.key && one.revokedAt === null)
    : store.handle.prepare("SELECT 1 FROM teammate WHERE id = ?").get(Number(target.key)) !== undefined);
  if (!known) return fail(context.write, context.json, command, "not-found", "That isn't a project, person or teammate here.", EXIT.refused);
  if (action === "remove") {
    const existing = store.budgets().find(one => one.scope === target.scope && one.key === target.key);
    if (existing === undefined || !store.removeBudget(existing.id, acting.name, context.clock())) return fail(context.write, context.json, command, "not-found", "There's no such budget.", EXIT.refused);
    return succeed(context.write, context.json, command, { removed: existing.id }, () => [`Removed the ${budgetLabel(existing).replace(/'s$/, "")} budget.`]);
  }
  const dollars = Number(text(flags, "usd") ?? "");
  if (!Number.isFinite(dollars) || dollars < 1 || dollars > 10_000_000) return fail(context.write, context.json, command, "usage", "--usd is a whole number of dollars, at least 1.", EXIT.usage);
  const saved = store.setBudget({ scope: target.scope, key: target.key, limitMicrousd: Math.round(dollars) * 1_000_000, hardStop: !flags.has("alerts-only") }, acting.name, context.clock());
  return succeed(context.write, context.json, command, { budget: saved }, () => [`${budgetLabel(saved).replace(/'s$/, "")}: ${spendUsd(saved.limitMicrousd)} a month${saved.hardStop ? ", API work stops at 100%" : ", alerts only"}.`]);
}

/** `notifications [quiet | all | digest <HH:MM> | digest off | screenshots off|first|all]`: how chats reach this
 * person — only when they are needed (the default), every step, an optional evening digest, and whether a result's
 * saved screenshots follow its message. Each person sets their own. */
async function notificationsCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const [action, value, ...extra] = positional;
  const command = `notifications${action === undefined ? "" : ` ${action}`}`;
  const store = context.store;
  const muting = action === "mute" || action === "unmute";
  for (const name of flags.keys()) if (!["as", "token", "token-file", "token-env", "db", "json", ...(muting ? ["repo"] : [])].includes(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a notifications option.`, EXIT.usage);
  const usage = "Use notifications quiet, notifications all, notifications digest <HH:MM>|off, notifications screenshots off|first|all, or notifications mute|unmute --repo <project>.";
  const valued = action === "digest" || action === "screenshots";
  if (extra.length > 0 || (action !== undefined && !["quiet", "all", "digest", "screenshots", "mute", "unmute"].includes(action)) || valued !== (value !== undefined) || (muting && (value !== undefined || text(flags, "repo") === undefined))) {
    return fail(context.write, context.json, command, "usage", usage, EXIT.usage);
  }
  if (action === "screenshots" && !RESULT_SCREENSHOTS.includes(value as ResultScreenshots)) return fail(context.write, context.json, command, "usage", "Screenshots with results is off, first (the first one) or all (up to 4).", EXIT.usage);
  if (action === "digest" && value !== "off" && !isDigestTime(value!)) return fail(context.write, context.json, command, "usage", "The digest time is HH:MM on a 24-hour clock, like 18:30, or off.", EXIT.usage);
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok) {
    return fail(context.write, context.json, command, "refused", "Notifications are set per person: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const now = context.clock();
  if (muting) {
    const typed = text(flags, "repo")!;
    const repo = canonicalProject(typed) ?? resolve(typed);
    const known = new Set([...store.knownRepos(), ...store.listProjects().map(one => one.path)]);
    if (!known.has(repo) || !store.accountCanAccess(acting.name, repo)) return fail(context.write, context.json, command, "unknown-project", `${typed} is not a project you can see.`, EXIT.refused);
    store.setProjectMuted(acting.name, repo, action === "mute", now);
    const muted = store.mutedProjects(acting.name);
    return succeed(context.write, context.json, command, { repo, muted: action === "mute", mutedProjects: muted }, () => [
      action === "mute" ? `${basename(repo)} is muted: no pings for it. The console and your evening digest still show it.` : `${basename(repo)} pings you again.`,
    ]);
  }
  const preference = action === "quiet" || action === "all" ? store.setNotificationPreference(acting.name, { mode: action }, acting.name, now)
    : action === "digest" ? store.setNotificationPreference(acting.name, { digestAt: value === "off" ? null : value! }, acting.name, now)
    : action === "screenshots" ? store.setNotificationPreference(acting.name, { screenshots: value as ResultScreenshots }, acting.name, now)
    : store.notificationPreference(acting.name);
  const muted = store.mutedProjects(acting.name);
  return succeed(context.write, context.json, command, { mode: preference.mode, digestAt: preference.digestAt, screenshots: preference.screenshots, mutedProjects: muted }, () => [
    preference.mode === "quiet" ? "Only when you're needed: one message per task, updated as it moves, and a new one when something needs you." : "Every step: a message for each update.",
    preference.digestAt === null ? "No evening digest." : `Evening digest at ${preference.digestAt}: what finished, what waits and what failed.`,
    preference.screenshots === "off" ? "Screenshots with results: off." : `Screenshots with results: ${preference.screenshots === "first" ? "the first one" : "up to 4"}.`,
    ...(muted.length === 0 ? [] : [`Muted: ${muted.map(one => basename(one)).join(", ")}.`]),
  ]);
}

/** `retention show | preview | set <kind> <period>` (v105): how long each kind of data is kept, and what the daily
 * sweep would remove now. Setting takes an instance operator. */
async function retentionCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const [action, ...rest] = positional;
  const command = `retention ${action ?? ""}`.trim();
  const store = context.store;
  const allowed = new Set(action === "set" ? ["as", "token", "token-file", "token-env", "db", "json"] : ["db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a ${command} option.`, EXIT.usage);
  const label = (kind: RetentionKind) => RETENTION_KINDS.find(one => one.kind === kind)!.label;
  if (action === undefined || action === "show") {
    const periods = store.retentionPeriods();
    const chosen = store.retentionChosen();
    const defaulted = RETENTION_KINDS.map(one => one.kind).filter(kind => !(kind in chosen));
    const last = lastSweepAt(store);
    return succeed(context.write, context.json, command, { periods, defaulted, lastSweep: last }, () => [
      ...RETENTION_KINDS.map(one => `  ${one.kind.padEnd(14)} ${periodLabel(one.kind, periods[one.kind], one.kind in chosen).toLowerCase().padEnd(18)} ${one.label}`),
      last === null ? "No sweep yet; the worker runs one a day." : `Last sweep ${last.slice(0, 16).replace("T", " ")} UTC.`,
    ]);
  }
  if (action === "preview") {
    const plan = retentionPlan(store, context.evidenceRoot, context.clock());
    const kept = plan.counts.filter(one => one.days === null).map(one => one.kind);
    return succeed(context.write, context.json, command, { counts: plan.counts }, () => [
      ...plan.counts.filter(one => one.days !== null).map(one => `  ${label(one.kind).padEnd(26)} ${countWords(one)} older than ${periodWords(one.days)}, about ${bytesWords(one.bytes)}${one.more ? " (more after this sweep)" : ""}`),
      kept.length === RETENTION_KINDS.length ? "Everything is kept forever; nothing would be removed." : `Nothing was removed.${kept.length === 0 ? "" : ` Kept forever: ${kept.join(", ")}.`}`,
    ]);
  }
  if (action !== "set") return fail(context.write, context.json, command, "usage", "Use retention show, retention preview or retention set <kind> <period>.", EXIT.usage);
  const [kind, period, ...extra] = rest;
  if (kind === undefined || !isRetentionKind(kind) || period === undefined || extra.length > 0) {
    return fail(context.write, context.json, command, "usage", `Use retention set <${RETENTION_KINDS.map(one => one.kind).join("|")}> <days, like 1d, 90d or 1y, or forever>.`, EXIT.usage);
  }
  const days = parsePeriod(period);
  if (days === undefined) return fail(context.write, context.json, command, "usage", `A period is forever, or ${MIN_DAYS} day to 10 years (1d, 90d, 12w, 1y).`, EXIT.usage);
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok || !store.isInstanceOperator(acting.name)) {
    return fail(context.write, context.json, command, "refused", "An instance operator sets retention: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const periods = store.setRetentionPeriod(kind, days, acting.name, context.clock());
  return succeed(context.write, context.json, command, { periods }, () => [`${label(kind)}: kept ${days === null ? "forever" : `for ${periodWords(days)}`}.`]);
}

/** `storage`, `storage cleanup [<when>]`, `storage clean [--yes]`, `storage discard <path> --yes`: where the disk goes,
 * and task checkouts: when a finished task's clean checkout is removed, cleaning up now, and throwing away one kept for
 * its changes. Changing anything takes an instance operator. */
async function storageCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const [action, ...rest] = positional;
  const command = `storage ${action ?? ""}`.trim();
  const store = context.store;
  const changes = (action === "cleanup" && rest.length > 0) || (action === "clean" && flags.has("yes")) || action === "discard";
  const allowed = new Set([...(changes ? ["as", "token", "token-file", "token-env"] : []), ...(action === "clean" || action === "discard" ? ["yes"] : []), "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a ${command} option.`, EXIT.usage);
  const pool = new WorktreePool(store, { root: join(dirname(context.databaseFile), "worktrees"), ...(context.gitRunner === undefined ? {} : { runner: context.gitRunner }) });
  const operator = async (): Promise<string | null> => {
    const acting = await askCredentials(flags, context);
    const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
    return acting !== null && verified !== null && verified.ok && store.isInstanceOperator(acting.name) ? acting.name : null;
  };
  const refused = (what: string) => fail(context.write, context.json, command, "refused", `An instance operator ${what}: pass --as and --token (or use the remembered login).`, EXIT.refused);
  const summary = (plan: CheckoutPlan): string[] => [
    `Checkouts: ${plan.count}, ${bytesWords(plan.totalBytes)}. ${plan.waitingReview} waiting for review, ${plan.withChanges} kept because they have changes.`,
    plan.go.length === 0 ? "A clean up now would free nothing." : `A clean up now would free about ${bytesWords(plan.freeBytes)} (${plan.go.length} checkout${plan.go.length === 1 ? "" : "s"}): toolroll storage clean`,
    `A finished task's clean checkout is removed ${cleanupWords(plan.cleanup)}; its branch stays.`,
  ];
  const itemLine = (one: CheckoutItem) => `  ${bytesWords(one.bytes).padStart(8)}  ${one.path}${one.why === null ? "" : `  (${whyWords(one)})`}`;
  // Test temp folders the tests, journeys and scripts left (a killed run, an older version): those nothing touched for a day go.
  const roots = context.tempRoots ?? tempRoots();
  // Counting is quick; sizing thousands of folders isn't, so only a clean-up measures them.
  const leftovers = (measure: boolean) => {
    const found = testTempFolders(roots, context.clock());
    const sizes = measure ? diskBytes(found.stale.map(one => one.path)) : new Map<string, number>();
    return { count: found.all.length, stale: found.stale.length, staleBytes: [...sizes.values()].reduce((sum, one) => sum + one, 0) };
  };
  const leftoverLine = (temp: ReturnType<typeof leftovers>) => temp.count === 0 ? "Test temp folders: none." :
    `Test temp folders: ${temp.count}; ${temp.stale === 0 ? "none older than a day." : `${temp.stale} older than a day: toolroll storage clean removes them.`}`;
  // Shared dependencies (shared-deps.ts): one install per lockfile, linked into checkouts.
  const depsRoot = sharedDepsRoot(context.databaseFile);
  const checkoutRows = () => store.listWorktrees().map(row => ({ path: row.path, repo: row.repo }));
  const sharedFacts = (copies: readonly SharedUse[]) => {
    const sizes = diskBytes(copies.map(one => one.dir));
    return copies.map(one => ({ key: one.key, repo: one.repo, path: one.dir, bytes: sizes.get(one.dir) ?? 0, checkouts: one.checkouts.length, usedBy: one.checkouts, retired: one.retired, node: one.node, createdAt: one.createdAt, usedAt: one.usedAt }));
  };
  const sharedLine = (one: ReturnType<typeof sharedFacts>[number]) =>
    `  ${bytesWords(one.bytes).padStart(8)}  ${projectName(one.repo)} ${one.key.slice(0, 8)}: ${one.checkouts === 1 ? "1 checkout uses it" : `${one.checkouts} checkouts use it`}${one.retired ? " (changed after install; never linked again)" : ""}`;

  // What the latest sweep (automatic, or a clean-up by hand) did and when (storage-sweep.ts).
  const sweepFacts = () => {
    const last = lastSweep(store);
    const automatic = last?.source === "automatic" ? last : lastSweep(store, "automatic");
    return { last, lastAutomatic: automatic, next: nextSweepAt(store) };
  };
  const sweepLines = (facts: ReturnType<typeof sweepFacts>): string[] => {
    const when = (at: string) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const one = facts.last;
    const head = one === null ? (facts.next === null && storageSweepOffNow() ? "Automatic sweep: off." : "Automatic sweep: not run yet; it runs once a day.")
      : `Last swept ${when(one.at)}${one.source === "manual" ? ` by ${one.actor}` : " automatically"}: ${storageSweepWords(one.parts)}`;
    const auto = one !== null && one.source === "manual" && facts.lastAutomatic !== null ? [`Last automatic sweep ${when(facts.lastAutomatic.at)}: ${storageSweepWords(facts.lastAutomatic.parts)}`] : [];
    return [head, ...auto, ...(one === null ? [] : sweepDetails(one.parts).slice(0, 8).map(line => `  ${line}`))];
  };

  if (action === undefined) {
    const plan = await checkoutPlan(store, pool, context.clock(), { manual: true });
    const report = storageReport(store, context.databaseFile, plan.go.length === 0 ? "nothing to clean up" : `about ${bytesWords(plan.freeBytes)} to clean up`);
    const { staleBytes: _, ...temp } = leftovers(false);
    const shared = sharedFacts(sharedUse(depsRoot, checkoutRows()));
    const sweep = sweepFacts();
    return succeed(context.write, context.json, "storage", { ...report, checkouts: checkoutSummary(plan), testTemp: temp, shared, sweep }, () => [
      `${report.folder}: ${bytesWords(report.total)}`,
      ...report.lines.map(one => `  ${one.what.padEnd(19)} ${bytesWords(one.bytes).padStart(8)}${one.count === undefined ? "" : `  (${one.count})`}${one.note === undefined ? "" : `  ${one.note}`}`),
      ...(shared.length === 0 ? [] : ["Shared dependencies:", ...shared.map(sharedLine)]),
      ...summary(plan),
      leftoverLine({ ...temp, staleBytes: 0 }),
      ...sweepLines(sweep),
    ]);
  }
  if (action === "cleanup") {
    if (rest.length === 0) {
      const cleanup = store.checkoutCleanup();
      return succeed(context.write, context.json, command, { cleanup }, () => [`A finished task's clean checkout is removed ${cleanupWords(cleanup)}; its branch stays.`]);
    }
    const cleanup = rest.length === 1 ? parseCleanup(rest[0]!) : undefined;
    if (cleanup === undefined) return fail(context.write, context.json, command, "usage", `Use storage cleanup <${CLEANUP_CHOICES.map(one => one.value).join("|")}>.`, EXIT.usage);
    const actor = await operator();
    if (actor === null) return refused("sets checkout cleanup");
    const saved = store.setCheckoutCleanup(cleanup, actor, context.clock());
    return succeed(context.write, context.json, command, { cleanup: saved }, () => [`Saved. A finished task's clean checkout is removed ${cleanupWords(saved)}; its branch stays.`]);
  }
  if (action === "clean") {
    if (rest.length > 0) return fail(context.write, context.json, command, "usage", "Use storage clean to preview, then storage clean --yes.", EXIT.usage);
    if (!flags.has("yes")) {
      const plan = await checkoutPlan(store, pool, context.clock(), { manual: true });
      const temp = leftovers(true);
      // A shared copy goes when no checkout uses it, counting the checkouts this clean-up would remove.
      const leaving = new Set(plan.go.map(one => one.path));
      const unused = unusedShared(depsRoot, checkoutRows().filter(row => !leaving.has(row.path)), context.clock());
      const sharedGo = sharedFacts(unused.copies);
      const sharedBytes = sharedGo.reduce((sum, one) => sum + one.bytes, 0);
      const anything = plan.go.length > 0 || temp.stale > 0 || sharedGo.length > 0;
      return succeed(context.write, context.json, command, { preview: true, go: plan.go, stay: plan.stay, freeBytes: plan.freeBytes, testTemp: temp, sharedGo, sharedFreeBytes: sharedBytes }, () => [
        ...(plan.go.length === 0 ? [anything ? "No checkouts to clean up." : "Nothing to clean up."] : [`Would remove ${plan.go.length} checkout${plan.go.length === 1 ? "" : "s"}, freeing about ${bytesWords(plan.freeBytes)} (their branches stay):`, ...plan.go.map(itemLine)]),
        ...(sharedGo.length === 0 ? [] : [`Would remove ${sharedGo.length} shared dependency install${sharedGo.length === 1 ? "" : "s"} no checkout uses, about ${bytesWords(sharedBytes)}:`, ...sharedGo.map(sharedLine)]),
        ...(plan.stay.length === 0 ? [] : [`Stays (${plan.stay.length}):`, ...plan.stay.map(itemLine)]),
        ...(temp.stale === 0 ? [] : [`Would remove ${temp.stale} test temp folder${temp.stale === 1 ? "" : "s"} older than a day, about ${bytesWords(temp.staleBytes)}.`]),
        anything ? "Nothing was removed. Run toolroll storage clean --yes to remove them." : "Nothing was removed.",
      ]);
    }
    const actor = await operator();
    if (actor === null) return refused("cleans up checkouts");
    const done = await cleanCheckouts(store, pool, context.clock, { manual: true, actor });
    const temp = leftovers(true);
    const swept = removeStaleTestTemp(roots, context.clock());
    if (swept.removed.length > 0) {
      store.recordAction({ at: context.clock().toISOString(), actor, repo: null, taskId: null, runId: null, action: "test temp folders removed", outcome: "removed", source: "request",
        detail: `${swept.removed.length} older than a day, about ${bytesWords(temp.staleBytes)}${swept.failed.length === 0 ? "" : `; ${swept.failed.length} couldn't be removed`}` });
    }
    // After the checkouts go: a shared copy none of the remaining ones uses goes too.
    const unused = unusedShared(depsRoot, checkoutRows(), context.clock());
    const sharedRemoved = sharedFacts(unused.copies).filter(one => removeShared(one.path));
    for (const one of sharedRemoved) {
      store.recordAction({ at: context.clock().toISOString(), actor, repo: one.repo, taskId: null, runId: null, action: "shared dependencies removed", outcome: "removed", source: "request",
        detail: `${one.key} (about ${bytesWords(one.bytes)}); no checkout used it` });
    }
    for (const debris of unused.debris) removeShared(debris);
    const sharedFreed = sharedRemoved.reduce((sum, one) => sum + one.bytes, 0);
    // Saved like an automatic sweep, so Storage shows what this clean-up did and when.
    const parts: SweepPart[] = [
      { kind: "checkouts", count: done.removed.length, bytes: done.freed, failed: done.kept.filter(one => one.why === "git refused").length, items: done.removed.slice(0, 20).map(one => one.path) },
      { kind: "test temp", count: swept.removed.length, bytes: temp.staleBytes, failed: swept.failed.length, items: swept.removed.slice(0, 20) },
      { kind: "dependencies", count: sharedRemoved.length, bytes: sharedFreed, failed: unused.copies.length - sharedRemoved.length, items: sharedRemoved.slice(0, 20).map(one => one.path) },
    ];
    saveSweep(store, { at: context.clock().toISOString(), source: "manual", actor, parts });
    return succeed(context.write, context.json, command, { removed: done.removed, kept: done.kept, freedBytes: done.freed, testTempRemoved: swept.removed.length, testTempFailed: swept.failed, sharedRemoved, sharedFreedBytes: sharedFreed }, () => [
      done.removed.length === 0 ? (swept.removed.length === 0 && sharedRemoved.length === 0 ? "Nothing to clean up." : "No checkouts to clean up.") : `Removed ${done.removed.length} checkout${done.removed.length === 1 ? "" : "s"}, about ${bytesWords(done.freed)}; their branches stay.`,
      ...done.removed.map(itemLine),
      ...(sharedRemoved.length === 0 ? [] : [`Removed ${sharedRemoved.length} shared dependency install${sharedRemoved.length === 1 ? "" : "s"} no checkout used, about ${bytesWords(sharedFreed)}.`, ...sharedRemoved.map(sharedLine)]),
      ...done.kept.map(one => `  kept ${one.path} (${whyWords({ why: one.why })})`),
      ...(swept.removed.length === 0 ? [] : [`Removed ${swept.removed.length} test temp folder${swept.removed.length === 1 ? "" : "s"} older than a day, about ${bytesWords(temp.staleBytes)}.`]),
      ...(swept.failed.length === 0 ? [] : [`Couldn't remove ${swept.failed.length} test temp folder${swept.failed.length === 1 ? "" : "s"}: ${swept.failed.slice(0, 3).join(", ")}${swept.failed.length > 3 ? " …" : ""}`]),
    ]);
  }
  if (action === "discard") {
    const [path, ...extra] = rest;
    if (path === undefined || extra.length > 0) return fail(context.write, context.json, command, "usage", "Use storage discard <path> --yes.", EXIT.usage);
    const target = resolve(path);
    if (store.getWorktree(target) === null) return fail(context.write, context.json, command, "not-found", `${target} is not a task checkout. toolroll storage clean lists them.`, EXIT.refused);
    if (!flags.has("yes")) return fail(context.write, context.json, command, "usage", `This throws away ${target} and its uncommitted changes (its branch stays). Add --yes to discard it.`, EXIT.usage);
    const actor = await operator();
    if (actor === null) return refused("discards a checkout");
    const done = await discardCheckout(store, pool, target, context.clock(), actor);
    if (!done.ok) return fail(context.write, context.json, command, "refused", done.message, EXIT.refused);
    return succeed(context.write, context.json, command, { discarded: target, freedBytes: done.bytes }, () => [`Discarded ${target}, about ${bytesWords(done.bytes)}; its branch stays.`]);
  }
  return fail(context.write, context.json, command, "usage", "Use storage, storage cleanup <when>, storage clean [--yes] or storage discard <path> --yes.", EXIT.usage);
}

function checkoutSummary(plan: CheckoutPlan) {
  return { count: plan.count, totalBytes: plan.totalBytes, waitingReview: plan.waitingReview, withChanges: plan.withChanges, cleanBytes: plan.freeBytes, cleanCount: plan.go.length, cleanup: plan.cleanup };
}

/** `review [show] | on | off --repo <path>`: the project's one automatic review
 * of finished builds. Changing it takes an approver of that project; the
 * policy log keeps before → after. */
async function reviewSwitchCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json } = context;
  const [action = "show", ...extra] = positional;
  const command = `review ${action}`;
  if (extra.length > 0 || !["show", "on", "off"].includes(action)) return fail(write, json, command, "usage", "Use toolroll review show|on|off --repo <path>.", EXIT.usage);
  const allowed = new Set(["repo", "db", "json", ...(action === "show" ? [] : ["as", "token", "token-file", "token-env"])]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(write, json, command, "usage", `--${name} is not a ${command} option.`, EXIT.usage);
  const given = text(flags, "repo");
  if (given === undefined) return fail(write, json, command, "usage", "Name the project: toolroll review " + action + " --repo <path>.", EXIT.usage);
  const repo = canonicalProject(given) ?? resolve(given);
  const words = (on: boolean, source: string) => `${projectName(repo)}: automatic review is ${on ? "on" : "off"}${source === "hands-off" ? " (on while the hands-off mode lasts)" : source === "default" ? " (the default)" : ""}.`;
  if (action === "show") {
    const state = store.reviewSwitch(repo, context.clock());
    return succeed(write, json, command, { repo, ...state }, () => [words(state.on, state.source)]);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) return fail(write, json, command, "usage", `Sign in first, or pass --as <you> --token <t>: toolroll review ${action} --repo <path>.`, EXIT.usage);
  const verified = authenticateApprover(store, acting.name, acting.token, repo);
  if (!verified.ok) return fail(write, json, command, verified.reason, `Only an approver of ${projectName(repo)} can change its review switch.`, EXIT.refused);
  const changed = store.setReviewSwitch(repo, action === "on", acting.name, context.clock());
  return succeed(write, json, command, { repo, ...changed.after, before: changed.before }, () => [
    words(changed.after.on, changed.after.source),
    changed.after.on ? "Each finished build whose check passes gets one read-only review; only HIGH findings send it back, once." : "Finished builds go straight to you.",
  ]);
}

/** `policy show | set` (sprint 8): the organisation policy. Setting it takes an instance operator's credentials; each rule
 * that changed is in the ledger, before → after. A flag left out keeps its rule; "any" lifts it. */
async function policyCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const [action, ...extra] = positional;
  const command = `policy ${action ?? ""}`.trim();
  const store = context.store;
  const shown = (policy: SavedPolicy): string[] => {
    const parts = policyParts(policy);
    return [`Providers: ${parts.providers}`, `Models:    ${parts.models}`, `Tools:     ${parts.tools}`, `Ceiling:   ${parts.ceiling}`,
      ...(policy.updatedBy === null ? [] : [`Changed by ${policy.updatedBy} at ${policy.updatedAt}.`])];
  };
  if (extra.length > 0 || (action !== undefined && action !== "show" && action !== "set")) return fail(context.write, context.json, command, "usage", "Use policy show or policy set.", EXIT.usage);
  if (action === undefined || action === "show") {
    for (const name of flags.keys()) if (!["history", "db", "json"].includes(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a policy show option.`, EXIT.usage);
    const policy = store.orgPolicy();
    const history = flags.has("history") ? store.policyHistory(50) : [];
    return succeed(context.write, context.json, command, { policy, ...(flags.has("history") ? { history } : {}) }, () => [
      ...shown(policy),
      ...history.map(one => `  ${one.at.slice(0, 16).replace("T", " ")}  ${one.actor}  ${one.action.replace(/^organisation policy: /, "")}: ${one.detail ?? ""}`),
    ]);
  }
  const allowed = new Set(["providers", "models", "tools", "ceiling", "as", "token", "token-file", "token-env", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a policy set option.`, EXIT.usage);
  if (!["providers", "models", "tools", "ceiling"].some(name => flags.has(name))) return fail(context.write, context.json, command, "usage", "Say what to set: --providers, --models, --tools or --ceiling.", EXIT.usage);
  const acting = await askCredentials(flags, context);
  const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
  if (acting === null || verified === null || !verified.ok || !store.isInstanceOperator(acting.name)) {
    return fail(context.write, context.json, command, "refused", "An instance operator sets the policy: pass --as and --token (or use the remembered login).", EXIT.refused);
  }
  const current = store.orgPolicy();
  const listFlag = (name: string, now: readonly string[] | null): readonly string[] | null => {
    if (!flags.has(name)) return now;
    const given = text(flags, name) ?? "";
    return given.trim().toLowerCase() === "any" ? null : parseList(given) ?? [];
  };
  const checked = checkPolicy({ providers: listFlag("providers", current.providers), models: listFlag("models", current.models), tools: listFlag("tools", current.tools), ceiling: text(flags, "ceiling") ?? current.ceiling });
  if (!checked.ok) return fail(context.write, context.json, command, "usage", `${checked.problem} Nothing changed.`, EXIT.usage);
  const saved = store.setOrgPolicy(checked.policy, acting.name, context.clock());
  return succeed(context.write, context.json, command, { policy: saved }, () => ["Policy saved.", ...shown(saved)]);
}

/** `task evidence <id>`: everything an auditor asks about one task (v103). Read locally; needs no login. */
function taskEvidenceCommand(rest: readonly string[], flags: Map<string, string | true>, context: Context): number {
  const command = "task evidence";
  const allowed = new Set(["html", "out", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a task evidence option.`, EXIT.usage);
  const [taskId, ...extra] = rest;
  if (taskId === undefined || extra.length > 0) return fail(context.write, context.json, command, "usage", "Use task evidence <id> [--html] [--out <file>].", EXIT.usage);
  const pack = evidencePack(context.store, taskId, { principal: "operator", repos: null, includeUnplaced: true }, "command line", context.clock(), context.evidenceRoot);
  if (pack === null) return fail(context.write, context.json, command, "unknown-task", `No task ${taskId}.`, EXIT.refused);
  const content = flags.has("html") ? standaloneEvidenceHtml(pack) : `${JSON.stringify(pack, null, 2)}\n`;
  return writeOut(context, command, text(flags, "out"), content, { task: pack.task.id, digest: pack.digest, chainOk: pack.ledger.chain.ok },
    `Evidence pack for ${pack.task.id} (${pack.ledger.entries.length} ledger entries, chain ${pack.ledger.chain.ok ? "verified" : "BROKEN"}).`, flags.has("html") ? { html: content } : { pack });
}

/** `ledger verify | checkpoint | export` (v103): the action ledger's hash chain. */
async function ledgerCommand(positional: readonly string[], flags: Map<string, string | true>, context: Context): Promise<number> {
  const [action, ...extra] = positional;
  const command = `ledger ${action ?? ""}`.trim();
  const allowed = new Set(action === "verify" ? ["checkpoint", "db", "json"] : action === "checkpoint" ? ["as", "token", "token-file", "token-env", "db", "json"] : ["from", "to", "out", "db", "json"]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail(context.write, context.json, command, "usage", `--${name} is not a ${command} option.`, EXIT.usage);
  if (extra.length > 0 || (action !== "verify" && action !== "checkpoint" && action !== "export")) {
    return fail(context.write, context.json, command, "usage", "Use ledger verify, ledger checkpoint or ledger export --from <day> --to <day>.", EXIT.usage);
  }
  const store = context.store;
  if (action === "verify") {
    // The command walks the whole chain, every time.
    const report = store.ledgerChain({ full: true });
    const copied = text(flags, "checkpoint");
    const outside = copied === undefined ? null : matchesOutsideCheckpoint(store.handle, copied);
    const inside = store.ledgerCheckpoints(1)[0] ?? null;
    const ok = report.ok && (outside === null || outside.ok);
    const lines = [
      report.ok ? `Chain verified: ${report.entries} entries through #${report.through ?? 0}, head ${report.head}.` : `Chain BROKEN: ${report.problem?.what ?? "it doesn't verify"}.`,
      ...(report.checkpoints > 0 && report.ok ? [`All ${report.checkpoints} checkpoints kept here still match${inside === null ? "" : `; the latest is ${inside.through}:${inside.hash}`}.`] : []),
      ...(outside === null ? [] : [outside.what]),
    ];
    context.write(context.json ? envelopeJson({ ok, command, chain: report, outside }) : lines.join("\n"));
    return ok ? EXIT.ok : EXIT.failed;
  }
  if (action === "checkpoint") {
    const acting = await askCredentials(flags, context);
    const verified = acting === null ? null : authenticateApprover(store, acting.name, acting.token);
    if (acting === null || verified === null || !verified.ok || !store.isInstanceOperator(acting.name)) {
      return fail(context.write, context.json, command, "refused", "An instance operator makes checkpoints: pass --as and --token (or use the remembered login).", EXIT.refused);
    }
    const made = store.ledgerCheckpoint(acting.name, context.clock());
    if (made === null) return fail(context.write, context.json, command, "empty", "The ledger has no entries yet.", EXIT.refused);
    if ("problem" in made) return fail(context.write, context.json, command, "broken", `No checkpoint: the chain doesn't verify (${made.problem}).`, EXIT.failed);
    return succeed(context.write, context.json, command, { through: made.through, hash: made.hash, checkpoint: `${made.through}:${made.hash}` },
      () => [`${made.through}:${made.hash}`, "Copy this somewhere outside this machine; ledger verify --checkpoint <it> proves nothing before it was rewritten."]);
  }
  const from = exportDay(text(flags, "from") ?? null), last = exportDay(text(flags, "to") ?? null);
  if (from === null || last === null) return fail(context.write, context.json, command, "usage", "Use ledger export --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--out <file>].", EXIT.usage);
  const to = new Date(Date.parse(last) + 86_400_000).toISOString();
  if (to <= from) return fail(context.write, context.json, command, "usage", "--to is on or after --from.", EXIT.usage);
  // Reading the database file needs no login, so the ledger names the road, not a person it can't vouch for.
  const who = "command line";
  const content = [...ledgerExportChunks(store, { from, to }, { repos: null, instance: true }, { principal: "operator", repos: null, includeUnplaced: true }, who, context.clock(), context.evidenceRoot)].join("");
  const bundle = JSON.parse(content) as LedgerExport;
  store.recordAction({ at: context.clock().toISOString(), actor: who, repo: null, taskId: null, runId: null, action: "ledger exported", outcome: "exported", source: "access",
    detail: `${from.slice(0, 10)} to ${last.slice(0, 10)} · ${bundle.entries.length} entries · ${bundle.packs.length} evidence packs` });
  return writeOut(context, command, text(flags, "out"), `${content}\n`, { entries: bundle.entries.length, packs: bundle.packs.length, chainOk: bundle.chain.ok },
    `${bundle.entries.length} ledger entries and ${bundle.packs.length} evidence packs (chain ${bundle.chain.ok ? "verified" : "BROKEN"}).`, { export: bundle });
}

function succeed(
  write: Write,
  json: boolean,
  command: string,
  data: Record<string, unknown>,
  lines: () => string[],
): number {
  write(json ? envelopeJson({ ok: true, command, ...data }) : lines().join("\n"));
  return EXIT.ok;
}

/**
 * Failures are data too. The `reason` is a stable token an agent can branch on
 * — `fenced`, `held`, `unknown-task` — while `message` is for the human who
 * reads the transcript afterwards. Prose changes; tokens must not.
 */
function fail(
  write: Write,
  json: boolean,
  command: string,
  reason: string,
  message: string,
  code: number,
  extra: Record<string, unknown> = {},
): number {
  write(json ? envelopeJson({ ok: false, command, reason, message, ...extra }) : message);
  return code;
}

function text(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flag(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === "true";
}

/** A running tournament owns its task (round-1 finding 5): the generic
 * doors refuse until it finishes, is picked, or is abandoned. */
function refuseWhileRacing(context: Context, command: string, taskId: string): number | null {
  const ref = context.store.lookupRef(taskId);
  if (ref === null || context.store.openContestFor(ref.id) === null) return null;
  return fail(
    context.write,
    context.json,
    command,
    "contest-open",
    "a tournament is running on this task — let it finish, then pick or abandon it from the tournament screen in the console (the task's page links to it)",
    EXIT.refused,
  );
}

/**
 * The demo fence (Codex adoption review, finding 8): a database stamped as
 * a demo sandbox NEVER spends money or touches the world outside — no
 * agent spawns, no PR, no message, no gh call. The stamp is an append-only
 * installation fact, so a kept sandbox stays fenced forever even when a
 * real worker is pointed at it by mistake. A banner is decoration; this
 * is the enforcement.
 */
/**
 * Deep links (attended A5): when a console URL is configured (`webhook set
 * console-url`), CLI answers print it beside ids so the attended eye can
 * jump. Absent configuration prints nothing — a link nobody configured is
 * a guess, and stale guesses are worse than none.
 */
function consoleLinkFor(context: Context, path: string): string | null {
  const base = loadConsoleUrl(process.env, dirname(context.databaseFile));
  if (base === null) return null;
  return `${base}${path}`;
}

function refuseDemo(context: Context, command: string): number | null {
  if (!context.store.isDemo()) return null;
  return fail(
    context.write,
    context.json,
    command,
    "demo-database",
    "this database is a demo sandbox — it never spends money or touches a remote; point this command at a real database",
    EXIT.refused,
  );
}

/** null means it was given and was not a whole number of seconds. */
function readTtl(flags: Map<string, string | true>): number | null {
  const given = text(flags, "ttl");
  if (given === undefined) return DEFAULT_LEASE_MS;
  const seconds = Number(given);
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  return seconds * 1_000;
}

function mutationFrom(flags: Map<string, string | true>, now: Date) {
  const key = text(flags, "key");
  return key === undefined ? { at: now } : { idempotencyKey: key, at: now };
}

/** Readable, sortable, and unique enough for a queue one person is filling. */
function slug(title: string, now: Date): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  const stamp = now.toISOString().slice(11, 19).replace(/:/g, "");
  return words === "" ? `task-${stamp}` : `${words}-${stamp}`;
}

function refExternalId(store: Store, taskRef: number): string | null {
  return store.externalIdFor(taskRef);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function databaseFailure(
  write: Write,
  json: boolean,
  command: string,
  file: string,
  error: unknown,
): number {
  if (!isDatabaseBusy(error)) return fail(write, json, command, "database", describe(error), EXIT.failed);
  return fail(
    write,
    json,
    command,
    "database-busy",
    `The database ${file} stayed busy for ${CONCURRENT_WRITER_WAIT_MS / 1_000} seconds. Wait for the other Toolroll process to finish, then try again.`,
    EXIT.failed,
  );
}
