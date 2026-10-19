/**
 * The invocation gateway: the only door to any provider binary (§5).
 *
 * "Never let an LLM poll" is only enforceable if there is exactly one place
 * that can start an LLM, and this is it. Every call verifies an open run
 * record WHOSE RECORDED PROVIDER MATCHES the one about to spawn (a repair
 * resumed on the wrong harness is a meaningless session id and a silent
 * fresh spend — refused here, structurally), stamps `provider_started_at`
 * the instant before the process spawns, and parses usage off the envelope
 * of EVERY completed process — nonzero exits included, because a failed
 * turn still spent money and a cost report that skips failures is a
 * smaller number, not a truer one.
 *
 * The architecture test asserts the boundary by imports, not by string
 * scan: only this module imports the registry's spawning surface
 * (`adapterFor`), and only builder, planner, reviewer, and scout import
 * `invokeAgent`.
 */

import { adapterFor, auditOf, claudePluginEnv, isolationUnsupported, ALL_CREDENTIAL_ENV, type AgentSpec, type Invocation, type ProviderRunner, type AgentEnding } from "./provider.js";
import { readProviderKey, readAuthModeStrict, PROVIDER_KEY_ENV, OWN_KEY_ENV, type AuthMode } from "./keys.js";
import { isKeyedProvider } from "./acp-agents.js";
import { classifyTerminal } from "./exhaustion.js";
import { liftAuthPause } from "./provider-auth.js";
import { attestProvider, type VersionProbe } from "./attest.js";
import { run as runCommand, runOwnerTag, streamsInput } from "./exec.js";
import { currentContainment } from "./containment.js";
import type { Store } from "./store.js";
import type { RunOptions } from "./exec.js";
import { witnessedRunner } from "./process-custody.js";
import { underStopWatch } from "./task-control.js";
import { childDatabaseEnv, isolatedChildDatabase, removeChildDatabase as removeAgentDatabase } from "./child-database.js";
import { RunSignInError, noToolsArgs, prepareRunTools, type ToolContainment, type ToolLaunchArgs } from "./project-tools.js";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { poolRootOf } from "./worktree.js";
import { agentFence, CheckoutBindingError, trustedWorktreeBinding, checkoutGitEnv, HARDENED_GIT_ARGS, codexFenceArgv, fenceGrants, fencedGitEnv, linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenced, NO_GRANTS, runFolders, taskBoundary, type FenceGrants, type FenceMethod } from "./agent-fence.js";
import type { BrokerOptions } from "./tool-broker.js";
import { claudeConfigDir, claudeDefaults, codexDefaults, codexHomeDir, isolatedCodexHome, type ProviderDefaults } from "./provider-home.js";
import { billingOf, claudeBillingFrom, seenBilling, type Billing } from "./spend.js";

export type { ProviderRunner } from "./provider.js";

/** The claude binary name — kept for the legacy quota rows and tests that
 * describe history; new code carries a resolved AgentSpec instead. */
export const PROVIDER_BINARY = "claude";

/** "Within seconds": how soon a silent failed run must end for its stderr to
 * be read for the sign-in signal. */
const AUTH_EARLY_EXIT_MS = 30_000;

// Fixed names only: neither setting values nor arbitrary JSON keys belong in
// diagnostics. The CLI's existing login stays where it is; no config is copied.
const CLAUDE_AUTH_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
] as const;

/** A value-only preflight: a settings-dependent login cannot survive empty setting sources. */
function claudeSettingsAuthProblem(configDir: string): string | null {
  let text: string;
  try { text = readFileSync(join(configDir, "settings.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "Can't read your Claude settings.json to check sign-in. Restore access to that file and try again. Isolated builds do not load it.";
  }
  let settings: unknown;
  try { settings = JSON.parse(text); }
  catch { return "Your Claude settings.json is not valid JSON. Fix that file and try again. Isolated builds do not load it, so Toolroll must check whether sign-in depends on it first."; }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return "Your Claude settings.json must contain an object. Fix that file and try again. Isolated builds do not load it.";
  }
  const value = settings as Record<string, unknown>;
  const keys = ["apiKeyHelper", "forceLoginMethod"].filter(key => Object.hasOwn(value, key));
  const env = value["env"];
  if (env !== null && typeof env === "object" && !Array.isArray(env)) {
    keys.push(...CLAUDE_AUTH_ENV.filter(key => Object.hasOwn(env, key)).map(key => `env.${key}`));
  }
  return keys.length === 0 ? null
    : `Your Claude settings.json defines sign-in settings: ${keys.join(", ")}. Isolated builds do not load that file. Use a Claude login that works without these settings, or select another build provider in Settings. Toolroll has not changed your login or copied these values.`;
}

/**
 * A provider can run the repository's own CLI. In a self-hosting build that
 * must never mean "open the database that launched me": a migration from the
 * candidate checkout would change the live schema underneath the older
 * supervisor, and even a read can contend with its watch transaction. Every
 * provider process therefore sees a unique disposable Toolroll
 * database while retaining its normal HOME/XDG environment for subscriptions
 * and unrelated developer tools.
 */
function isolatedAgentDatabase(runId: number): { dir: string; file: string } {
  return isolatedChildDatabase(`agent-${runId}`);
}

/** Defend the durable registry even when a test or alternate transport calls
 * the callback directly instead of passing through an in-tree JSONL runner. */
function transportSessionId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const normalized = id.trim();
  return normalized === "" ? null : normalized;
}

export type ProviderUsage = {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
};

export type AgentOutcome = {
  code: number;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
  /** The harness session, for repair-by-resume on the SAME provider. */
  sessionId: string | null;
  /** The agent's spoken conclusion — diagnostics, never the handoff. */
  finalMessage: string | null;
  /** Claude's `structured_output` alone (see ParsedEnvelope) — the only
   * field a structured handback may be read from. */
  structuredOutput?: string | null;
  /** The harness's own account of the ending, when its dialect has one. */
  ending?: AgentEnding | null;
  usage: ProviderUsage;
  /**
   * The harness never came up: the provider has an init signal, it was not
   * seen, and the turn also has nothing to show. Config, auth, or install —
   * not an agent's attempt, and callers must not treat it as one (M5
   * provider audit: init failure is retryable infrastructure, and its
   * distinct reason keeps a broken environment from reading as three
   * strikes of bad agent work).
   */
  initFailed: boolean;
};

/**
 * The value-shaped gateway result (Phase 3 B5): a refusal is a VALUE, so
 * every caller's try/finally worktree release and disposition run exactly
 * as they do for any other outcome — nothing here throws for these.
 *
 * - `provider-unattested`: the pre-spawn check failed (races past the
 *   tick's pre-claim skip — an executable swap mid-tick). No process
 *   started; the refused version is stamped on the run.
 * - `provider-protocol`: the harness ran and broke its own contract — a
 *   zero exit without the required terminal proof (A4), or an init
 *   identity that does not match the minted one (A5). Spend was recorded;
 *   the handoff must never be ingested.
 */
export type InvokeResult =
  | { kind: "ran"; outcome: AgentOutcome }
  | {
      kind: "refused";
      reason: "provider-unattested" | "provider-protocol" | "runner-custody" | "auth-mode" | "route-authority" | "stopped" | "containment";
      providerVersion: string | null;
      diagnostic: string | null;
      /** Bounded agent reply when a spawned turn later failed a protocol
       * gate. Pre-spawn refusals omit it because no reply can exist. */
      finalMessage?: string | null;
    };

/**
 * Spend money, on the record. Throws — never refuses quietly — when the run
 * is missing, already finished, or recorded against a different provider:
 * a caller that reaches for a harness without a matching open run is a
 * bug, not a case. Attestation and protocol refusals are VALUES (above),
 * not throws — those are cases, and they must dispose cleanly.
 */
export async function invokeAgent(
  store: Store,
  runId: number,
  spec: AgentSpec,
  invocation: Omit<Invocation, "model">,
  options: RunOptions & { runner?: ProviderRunner; clock?: () => Date; versionProbe?: VersionProbe; keyHome?: string; accumulateUsage?: boolean },
): Promise<InvokeResult> {
  const clock = options.clock ?? (() => new Date());
  if (options.accumulateUsage && (invocation.phase !== "review" || invocation.resumeSession === null)) {
    throw new Error("accumulated usage is only for evidence reads in an existing reviewer session");
  }
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null) {
    throw new Error(
      `run ${runId} is not an open attempt — nothing spends without a run record that will outlive it`,
    );
  }
  if (run.provider !== spec.provider) {
    throw new Error(
      `run ${runId} was opened for ${run.provider} but ${spec.provider} is about to spawn — a session resumed across harnesses is not a session`,
    );
  }

  // Session selection is durable authority, not an argv-only hint. A resumed
  // turn must name exactly the canonical identity already recorded on THIS
  // run before anything awaits or spawns. That makes a wrong child-row id a
  // caller bug in the same class as a wrong provider, and prevents COALESCE's
  // first-write rule from leaving row A while the process actually resumes B.
  const recordedSessionId = transportSessionId(run.sessionId);
  if (run.sessionId !== null && recordedSessionId === null) {
    throw new Error(`run ${runId} carries an empty durable session identity — nothing resumes an identity the registry cannot name`);
  }
  const requestedResumeSessionId =
    invocation.resumeSession === null ? null : transportSessionId(invocation.resumeSession);
  if (invocation.resumeSession !== null && requestedResumeSessionId === null) {
    throw new Error(`run ${runId} was asked to resume an empty session identity`);
  }
  if (requestedResumeSessionId !== null && recordedSessionId !== requestedResumeSessionId) {
    throw new Error(
      recordedSessionId === null
        ? `run ${runId} has no durable session identity matching the requested resume ${requestedResumeSessionId}`
        : `run ${runId} records session ${recordedSessionId} but was asked to resume ${requestedResumeSessionId}`,
    );
  }

  const requestedStartSessionId =
    requestedResumeSessionId !== null || invocation.startSessionId === undefined
      ? undefined
      : transportSessionId(invocation.startSessionId);
  if (requestedResumeSessionId === null && invocation.startSessionId !== undefined && requestedStartSessionId === null) {
    throw new Error(`run ${runId} was asked to start under an empty session identity`);
  }
  const startSessionId = requestedResumeSessionId !== null ? undefined : (requestedStartSessionId ?? undefined);
  if (recordedSessionId !== null && requestedResumeSessionId === null && startSessionId !== recordedSessionId) {
    throw new Error(
      `run ${runId} already records session ${recordedSessionId} but this invocation neither resumes nor starts under it`,
    );
  }

  const adapter = adapterFor(spec.provider);
  const { startSessionId: _untrustedStartSessionId, streamInput: _untrustedStreamInput, ...invocationWithoutStart } = invocation;
  // Live input (live-input.ts): only Claude's builds, only through a transport that keeps stdin open. The brief is
  // the session's first stdin message and never rides the argv; every other road keeps its prompt where it was.
  const liveInput = spec.provider === "claude" && invocation.phase === "build" && options.liveInput !== undefined && streamsInput(options.runner ?? adapter.defaultRunner)
    ? options.liveInput
    : null;
  const resolvedInvocation = {
    ...invocationWithoutStart,
    ...(liveInput === null ? {} : { streamInput: true }),
    model: spec.model,
    resumeSession: requestedResumeSessionId,
    ...(startSessionId === undefined ? {} : { startSessionId }),
  };
  const argv = adapter.argv(resolvedInvocation);
  const stdin = adapter.stdin?.(resolvedInvocation);
  // Long-running phases pass idleTimeoutMs: the process has no absolute
  // deadline and is stopped only after a full no-output interval. Bounded
  // callers (notably repair) keep timeoutMs and its hard wall clock. A
  // legacy caller that names neither retains the historic bounded default.
  const hardTimeoutMs =
    options.timeoutMs === undefined ? undefined : adapter.clampTimeout(invocation.phase, options.timeoutMs);
  const idleTimeoutMs =
    options.idleTimeoutMs === undefined ? undefined : adapter.clampTimeout(invocation.phase, options.idleTimeoutMs);
  const defaultTimeoutMs =
    hardTimeoutMs === undefined && idleTimeoutMs === undefined
      ? adapter.clampTimeout(invocation.phase, 30 * 60_000)
      : undefined;

  // Tier-2 attestation (A2/B3): the authoritative check, immediately
  // before the spawn it authorizes. Tier-1 providers return null here and
  // keep their road byte-identical.
  const attested = await attestProvider(spec.provider, adapter.binary, options.versionProbe);
  if (attested !== null && !attested.ok) {
    if (attested.version !== null) store.stampProviderVersion(runId, attested.version);
    return {
      kind: "refused",
      reason: "provider-unattested",
      providerVersion: attested.version,
      diagnostic: attested.problem,
    };
  }

  // Auth mode decides how the credential reaches the process (the operator
  // keeps BOTH and prefers the subscription): in "api-key" mode the
  // managed file wins, the ambient env is a real fallback (explicit
  // re-supply survives resolveChildEnv's chat-key strip); in
  // "subscription" mode the key is STRIPPED from the child so the CLI's
  // own login is used — its key is retained, just not handed over.
  const {
    runner,
    clock: _clock,
    versionProbe: _probe,
    keyHome,
    timeoutMs: _hardTimeout,
    idleTimeoutMs: _idleTimeout,
    stdin: _callerStdin,
    accumulateUsage: _accumulateUsage,
    liveInput: _liveInput,
    ...runOptions
  } = options;
  // The live setting is read STRICTLY (atomic authority closure): a
  // present mode file that says neither word is a value-shaped refusal
  // before any stamp or process — never the subscription default a
  // lenient read would coerce it to, which would spend on a credential
  // the seal never proved. The same reader gates filing and the seal.
  const strict = readAuthModeStrict(spec.provider, keyHome);
  if (!strict.ok) {
    return {
      kind: "refused",
      reason: "auth-mode",
      providerVersion: attested === null ? null : attested.version,
      diagnostic: strict.problem,
    };
  }
  const authMode: AuthMode = strict.mode;
  if (spec.provider === "claude" && invocation.phase !== "review") {
    const problem = claudeSettingsAuthProblem(options.env?.["CLAUDE_CONFIG_DIR"] ?? process.env["CLAUDE_CONFIG_DIR"] ?? join(keyHome ?? homedir(), ".claude"));
    if (problem !== null) return { kind: "refused", reason: "auth-mode", providerVersion: attested?.version ?? null, diagnostic: problem };
  }
  // An ACP agent has no key Toolroll holds or injects: its own and everyone else's are shed (adapter.extraOmitEnv).
  const keyed = isKeyedProvider(spec.provider) ? spec.provider : null;
  const ownKeyEnv = keyed === null ? [] : OWN_KEY_ENV[keyed];
  const keyEnvName = keyed === null ? null : PROVIDER_KEY_ENV[keyed];
  const managedKey =
    authMode === "api-key" && keyed !== null && keyEnvName !== null
      ? readProviderKey(keyed, keyHome) ?? (process.env[keyEnvName] || null)
      : null;
  // Resume XOR mint, enforced at the GATEWAY (Codex gemini verify round 2,
  // finding 3): a resume and a minted start id are mutually exclusive —
  // geminiArgv silently prefers --resume, so a minted id that rides
  // alongside a resume would be stamped and later enforced against an
  // envelope that never carried it, a paid protocol refusal. When resuming,
  // the minted id is dropped here, before it is ever stamped.
  // The minted session identity (A5): stamped durably BEFORE the start
  // stamp — intent precedes the process, and the envelope must later
  // MATCH this id or the run fails typed.
  if (startSessionId !== undefined) {
    store.stampRun(runId, { sessionId: startSessionId });
  }

  const spawn = witnessedRunner(store, runId, clock, runner ?? adapter.defaultRunner);
  let transportAnnouncedSessionId: string | null = null;
  let transportSessionConflict = false;
  // B3: the attested executable IS the spawned executable — one resolution.
  // A MANAGED key reaches exactly its own provider's child environment
  // (keys.ts): the foreign-credential strip already shed everybody
  // else's, and the plane's own env never needed to carry it. A key
  // already ambient in the environment keeps working; the managed file,
  // being deliberate, wins.
  const isolatedDb = isolatedAgentDatabase(runId);
  // Where the build runs: Claude reads the repository's CLAUDE.md from here.
  const workspace = invocation.phase === "review" ? null : runOptions.cwd ?? run.worktree ?? null;
  // How a tool server the broker starts is fenced: as its agent is, once that fence is fixed below.
  let serverFence: ((file: string, args: readonly string[]) => { file: string; args: string[] }) | null = null;
  // The run's containment, fixed before any tool is prepared: this platform and the OS fence its run gets (a build
  // has one wherever the plane has a database to fence). It decides which tools may hold secrets in a process the
  // build could otherwise read; nothing the launch or the checkout writes feeds it.
  const containment: ToolContainment = { platform: process.platform, fence: invocation.phase === "review" ? "none" : fenceMethod(spec.provider, store.databaseFile() !== null) };
  // The project's tools (v80): exactly its MCP servers, and none of the
  // operator's global or a repository's own, served by this launch's broker
  // (tool-broker.ts), which alone holds their secrets. A review keeps its isolation.
  const launchTools = invocation.phase === "review" ? null : await runTools(store, runId, spec, options.keyHome, clock, invocation.readOnlyTools, invocation.researchWithheld, containment, {
    env: { ...process.env, ...(runOptions.env ?? {}) },
    omitEnv: [...(runOptions.omitEnv ?? []), ...ALL_CREDENTIAL_ENV],
    pass: childDatabaseEnv(isolatedDb.file),
    ...(workspace === null ? {} : { cwd: workspace }),
    wrap: () => serverFence,
  });
  if (launchTools !== null && "refused" in launchTools) {
    removeAgentDatabase(isolatedDb.dir);
    return { kind: "refused", reason: "containment", providerVersion: attested?.version ?? null, diagnostic: launchTools.refused };
  }
  const tools = launchTools;
  const codexHarness = spec.provider === "codex" || spec.provider === "openrouter";
  // A Codex build's own CODEX_HOME (provider-home.ts): the operator's sign-in and sessions, linked, and nothing else.
  let codexHome: { dir: string; cleanup: () => void } | null = null;
  if (codexHarness && invocation.phase !== "review") {
    try { codexHome = isolatedCodexHome(codexHomeDir({ ...process.env, ...(runOptions.env ?? {}) }, keyHome ?? homedir())); }
    catch {
      tools?.cleanup();
      removeAgentDatabase(isolatedDb.dir);
      return { kind: "refused", reason: "containment", providerVersion: attested?.version ?? null, diagnostic: "The build's private Codex home could not be created; check access to its sign-in and sessions folders, then retry." };
    }
  }
  // The agent fence: Toolroll's own secrets, database and other runs'
  // evidence stay out of reach, whatever the permission mode. A review is
  // already confined to its sealed files.
  // A build's fence also holds its task boundary: home configuration and
  // the repositories beside its own, fresh and resumed alike. Codex starts
  // tool servers outside its command sandbox, so its own launch folder is
  // fenced too; Claude reads its config from there, inside the sandbox.
  const ownTools = tools?.privateDir === undefined ? null : realpathSync(tools.privateDir);
  const fenceOf = invocation.phase === "review" ? { fence: [], fileTools: [], grants: NO_GRANTS, problem: undefined } : runFence(store, runId, spec.provider, options.keyHome, codexHarness ? null : ownTools);
  if (fenceOf.problem !== undefined) {
    tools?.cleanup();
    codexHome?.cleanup();
    removeAgentDatabase(isolatedDb.dir);
    return { kind: "refused", reason: "containment", providerVersion: attested?.version ?? null, diagnostic: fenceOf.problem };
  }
  const fence = [...fenceOf.fence, ...(fenceOf.fence.length > 0 && codexHarness ? [ownTools, codexHome === null ? null : realpathSync(codexHome.dir)].filter((path): path is string => path !== null) : [])];
  const grants = fenceOf.grants;
  const inherited = spec.model === null && invocation.phase !== "review" ? inheritedDefaults(spec.provider, { ...process.env, ...(runOptions.env ?? {}) }, keyHome ?? homedir()) : undefined;
  const buildInvocation = { ...resolvedInvocation, ...(tools === null ? {} : { toolArgv: tools.argv, fence, fenceGrants: grants, fileToolFence: fenceOf.fileTools }), ...(workspace === null ? {} : { workspace }), ...(inherited === undefined ? {} : { inherited }) };
  const launchArgv = tools === null ? argv : adapter.argv(buildInvocation);
  const fenced = fenceLaunch(spec.provider, fence);
  // The tools were chosen for the fence decided above: a launch that got any other starts nothing.
  // Only a prepared project-tool broker depends on the earlier decision. Empty Claude configs also have a privateDir.
  if (tools?.serverPids !== undefined && fenced.method !== containment.fence) {
    tools.cleanup();
    codexHome?.cleanup();
    removeAgentDatabase(isolatedDb.dir);
    return { kind: "refused", reason: "containment", providerVersion: attested?.version ?? null, diagnostic: "The build's fence changed while its tools were prepared. Nothing was started; retry the task." };
  }
  // A tool server the broker starts is fenced by what this platform supports, whatever the provider: Codex's own
  // profile fences only its agent's commands, and the broker starts servers outside it.
  if (fence.length > 0) {
    if (macosFenceAvailable()) serverFence = (file, args) => macosFenced(file, args, fence, grants);
    else if (linuxFenceAvailable()) serverFence = (file, args) => linuxFenced(file, args, fence, grants);
  }
  if (invocation.phase !== "review") store.recordRunFence(runId, { method: fenced.method, paths: fence.length }, clock());
  const billingSeen: { keySource: string | null; model: string | null; planWindows: boolean; answered: boolean } = { keySource: null, model: null, planWindows: false, answered: false };
  // v105: a Codex run on its sign-in bills as Codex says it's signed in (a ChatGPT plan, or a saved key, or Bedrock),
  // read right before it runs. Never with an injected runner: tests don't start a real Codex.
  const codexLogin = spec.provider === "codex" && authMode === "subscription" && runner === undefined
    ? await codexLoginBilling(attested !== null ? attested.executable : adapter.binary, [...(runOptions.omitEnv ?? []), ...adapter.extraOmitEnv, ...ownKeyEnv])
    : null;
  const childEnv = {
    ...(runOptions.env ?? {}),
    ...(adapter.env?.(buildInvocation) ?? {}),
    ...(tools?.env ?? {}),
    // A fenced build's git never expires a reflog, so gc never rewrites another task's (agent-fence.ts).
    ...(fence.length > 0 ? fencedGitEnv({ ...process.env, ...(runOptions.env ?? {}) }) : {}),
    ...(codexHome === null ? {} : { CODEX_HOME: codexHome.dir }),
    ...(managedKey === null || keyEnvName === null ? {} : { [keyEnvName]: managedKey }),
    // This key is deliberately last: no caller may point an agent back at
    // the live control database through a generic RunOptions override.
    ...childDatabaseEnv(isolatedDb.file),
  };
  const childOmitEnv = [
    ...(runOptions.omitEnv ?? []),
    ...adapter.extraOmitEnv,
    // A Claude build loads no plugin, from settings or the environment (a review's safe mode already loads none).
    ...(spec.provider === "claude" && invocation.phase !== "review" ? claudePluginEnv({ ...process.env, ...(runOptions.env ?? {}) }) : []),
    // Subscription mode: shed this provider's OWN key too, so an ambient
    // one cannot force API billing over the login the operator prefers.
    // Api-key mode: shed every OTHER own-key alias (finding 1) — gemini
    // reads GOOGLE_API_KEY as well as GEMINI_API_KEY, and a stray alias
    // must not override the ONE canonical key this mode injected.
    ...(authMode === "subscription"
      ? ownKeyEnv
      : ownKeyEnv.filter(name => name !== keyEnvName)),
  ];
  const launchOptions: RunOptions = {
    ...(fenced.wrap.length === 0 ? {} : { fence: fenced.wrap, fenceGrants: grants }),
    ...runOptions,
    ...(workspace === null ? {} : { cwd: workspace }),
    // v105: how the CLI really billed this turn (its key source, its plan's windows), read off its own stream.
    onStreamEvent: event => {
      if (event["type"] === "system" && event["subtype"] === "init") {
        if (typeof event["apiKeySource"] === "string") billingSeen.keySource = event["apiKeySource"].slice(0, 80);
        if (typeof event["model"] === "string") billingSeen.model = event["model"].slice(0, 200);
      } else if (event["type"] === "rate_limit_event") {
        billingSeen.planWindows = true;
      } else if (event["type"] === "result" && event["is_error"] !== true && event["subtype"] === "success") {
        billingSeen.answered = true;
      }
      runOptions.onStreamEvent?.(event);
    },
    owner: runOwnerTag(store, runId),
    beforeSpawn: () => store.applicableStopFor(runId) === null && store.getRun(runId)?.outcome === null,
    onSpawn: pid => {
      runOptions.onSpawn?.(pid);
      if (store.applicableStopFor(runId) !== null) throw new Error("the attempt was stopped before spawn custody completed");
    },
    ...(stdin === undefined ? {} : { stdin }),
    ...(liveInput === null ? {} : { liveInput }),
    ...(hardTimeoutMs === undefined ? {} : { timeoutMs: hardTimeoutMs }),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(defaultTimeoutMs === undefined ? {} : { timeoutMs: defaultTimeoutMs }),
    env: childEnv,
    omitEnv: childOmitEnv,
    // Providers run in their own process group (M6.12): the harness spawns
    // shells and tools of its own, and both the timeout and the watch's
    // hard stop must end the whole tree, not orphan the grandchildren.
    processGroup: true,
    // The session registry's crash guarantee (M6.9): the id is stamped the
    // moment the stream announces it, first write wins — a daemon that
    // dies mid-turn still knows which session to offer the successor.
    onSessionId: id => {
      const normalized = transportSessionId(id);
      if (normalized === null) return;
      if (transportAnnouncedSessionId === null) transportAnnouncedSessionId = normalized;
      else if (transportAnnouncedSessionId !== normalized) transportSessionConflict = true;
      store.stampRun(runId, { sessionId: normalized });
    },
  };
  let result: Awaited<ReturnType<typeof spawn>>;
  let spawnedAt: number;
  try {
    if (fence.length > 0 && workspace !== null && (codexHarness || launchOptions.fence !== undefined)) {
      const inheritedEnv = launchOptions.envAllowlist === undefined ? process.env
        : Object.fromEntries(launchOptions.envAllowlist.map(name => [name, process.env[name]]));
      const probeOptions: RunOptions = {
        cwd: workspace, env: checkoutGitEnv({ ...inheritedEnv, ...childEnv }), omitEnv: childOmitEnv, envAllowlist: [],
      };
      // A broken checkout is not evidence of a broken fence. No provider is invoked by either check.
      const gitArgs = [...HARDENED_GIT_ARGS, "rev-parse", "HEAD"];
      const control = await runCommand("git", gitArgs, probeOptions);
      if (control.code === 0) {
        const executable = attested !== null ? attested.executable : adapter.binary;
        const insideFence = (file: string, args: readonly string[]) => codexHarness
          ? runCommand(executable, ["sandbox", ...codexFenceArgv(fence, invocation.skipPermissions, grants),
            "-P", "standing-orders", "--", file, ...args], probeOptions)
          : runCommand(file, args, { ...probeOptions, fence: launchOptions.fence!,
            ...(launchOptions.fenceGrants === undefined ? {} : { fenceGrants: launchOptions.fenceGrants }) });
        const check = await insideFence("git", gitArgs);
        if (check.code !== 0) {
          const trivial = await insideFence("true", []);
          if (trivial.code === 0) return { kind: "refused", reason: "containment", providerVersion: attested?.version ?? null,
            diagnostic: "The build fence blocks this checkout's own Git data.\n\nDetails:\n" + check.stderr.slice(0, 2000) + "\nDenied paths:\n" + fence.join("\n").slice(0, 12000) };
        }
      }
    }
    // The stamp precedes the spawn, so a crash between the two leaves a run
    // that claims spend which never happened — the honest direction. A spawn
    // before the stamp would leave spend no record claims, which is the lie
    // the invariant exists to rule out. For attested providers the probed
    // version rides the SAME durable write (B2).
    // The spawn leg of the runner gate (MCP spec v6, review finding 4):
    // the tuple re-proven against LIVE rows AFTER every awaited step, in
    // the same breath as the stamp — a takeover during the attestation
    // await can no longer slip a stale process through.
    // THE PLANNER'S ROUTE, RE-PROVED AT THE SPAWN (final authority closure):
    // the provenance the planner was admitted under is held to the authority
    // its task holds RIGHT NOW — the strict working projection of a filed
    // scope (exact terms, resolved profile, route parity, digest,
    // live auth mode), or the bare word `legacy` on a task with no scope. A
    // scope rewritten, corrupted, or unresolved between the claim and this
    // instant invokes no provider: a value-shaped refusal, no spend.
    if (run.role === "planner") {
      const proved = store.proveRouteForSpawn(runId, clock());
      if (!proved.ok) {
        return {
          kind: "refused",
          reason: "route-authority",
          providerVersion: attested === null ? null : attested.version,
          diagnostic: `the planner's route authority lapsed before spawn — ${proved.problem}`,
        };
      }
    }
    if (!store.proveRunnerCustodyForSpawn(runId, clock())) {
      return {
        kind: "refused",
        reason: "runner-custody",
        providerVersion: attested === null ? null : attested.version,
        diagnostic: "the run's runner custody lapsed before spawn — the lease, the runner, or its repo binding no longer stands",
      };
    }
    // THE STOP FENCE at the spawn (v52): a stop recorded against this run
    // — or the attempt it runs under — before this instant spawns nothing.
    // A value-shaped refusal, no stamp, no process, no spend; the road's
    // settlement seals the attempt as interrupted.
    const stopBeforeSpawn = store.applicableStopFor(runId);
    if (stopBeforeSpawn !== null) {
      return {
        kind: "refused",
        reason: "stopped",
        providerVersion: attested === null ? null : attested.version,
        diagnostic: `stopped by ${stopBeforeSpawn.requestedBy} (run #${stopBeforeSpawn.run}) before the provider spawned — nothing was spent`,
      };
    }

    // THE CONTAINMENT FENCE at the spawn (OS containment plan): a required
    // native policy this runner cannot meet — macOS, an undelegated cgroup,
    // a missing helper — spawns nothing. A value-shaped refusal in the
    // policy's own words, no stamp, no process, no spend.
    const containment = currentContainment();
    if (containment.refusal !== null) {
      return {
        kind: "refused",
        reason: "containment",
        providerVersion: attested === null ? null : attested.version,
        diagnostic: containment.refusal,
      };
    }

    if (attested !== null) store.stampProviderStart(runId, clock(), attested.version);
    else store.stampProviderStart(runId, clock());
    // The brief is queued only once the checkout has passed the fence check.
    liveInput?.begin(invocation.brief);
    spawnedAt = Date.now();
    // Under the stop watch (v52): the run's stop row is re-read while the
    // provider runs, and a stop kills THIS run's process group through the
    // handle registered under its owner tag — the exact-attempt road,
    // never the global sweep. Settlement then reads the same row.
    result = await underStopWatch(store, runId, () => spawn(attested !== null ? attested.executable : adapter.binary, launchArgv, launchOptions));
  } finally {
    removeAgentDatabase(isolatedDb.dir);
    tools?.cleanup();
    codexHome?.cleanup();
  }

  // v105: the run's billing, fixed from evidence before its usage is priced: a key it was given is a key; otherwise
  // what the CLI said (Claude's stream) or was last seen doing (Codex's account), and the setting only when neither.
  const evidence = spec.provider === "claude" ? claudeBillingFrom(billingSeen)
    // Codex signed in with ChatGPT is its plan, unless its plan is itself billed by use (seen by the console's probe).
    : codexLogin === "subscription" ? seenBilling(store.handle, "codex") ?? "subscription" : codexLogin;
  // What this computer's Claude does with no key from us (subagents and drafts bill the same way): learnt only from a
  // run we gave no key that got as far as an answer.
  if (spec.provider === "claude" && managedKey === null && authMode === "subscription" && billingSeen.answered && evidence !== null) {
    store.recordProviderBilling("claude", evidence, new Date());
  }
  store.fixRunBilling(runId, authMode === "api-key" ? "api-key" : evidence ?? billingOf(spec.provider, store.handle), new Date());

  const envelope = adapter.parse(result.stdout);
  // An installed CLI too old for a build's own setup refuses its flags
  // before it starts: nothing ran, and the run says what to update.
  const unsupported = result.code !== 0 && envelope.initObserved !== true && invocation.phase !== "review" ? isolationUnsupported(spec.provider, result.stderr) : null;
  if (unsupported !== null) {
    // The CLI refused its flags before any model turn: the run never started, whatever the stamp said.
    store.withdrawProviderStart(runId);
    return { kind: "refused", reason: "provider-unattested", providerVersion: attested === null ? null : attested.version, diagnostic: unsupported };
  }
  // The callback is the crash-safe early stamp; the parsed envelope is the
  // authoritative completed-stream account. Stamp it as a fallback for an
  // alternate transport. On fresh runs COALESCE makes callback/parser
  // disagreement visible in the durable row; resumed runs need the separate
  // callback latch because their row deliberately carries the input session.
  if (envelope.sessionId !== null) {
    store.stampRun(runId, { sessionId: envelope.sessionId });
  }
  const durableSessionId = store.getRun(runId)?.sessionId ?? null;
  // The durable id, callback id, and retained envelope must all resolve to
  // ONE identity. This deliberately includes resumed turns: a provider that
  // returns a fork has not proved the same-session repair/warm-resume
  // contract, and COALESCE must not disguise row A / process B as success.
  const sessionIdentityProblem = transportSessionConflict
    ? "the provider transport announced conflicting session ids"
    : transportAnnouncedSessionId !== null && transportAnnouncedSessionId !== envelope.sessionId
      ? "the retained provider envelope did not match the session identity announced through the transport callback"
      : durableSessionId !== envelope.sessionId
        ? envelope.sessionId === null
          ? "the retained provider envelope did not confirm the durably recorded session id"
          : requestedResumeSessionId !== null
            ? "the provider returned a session id different from the exact identity recorded for resume"
            : "the provider session id was different from the identity durably recorded when the stream initialized"
        : null;
  // A run whose cost could not be read may still have spent up to its cap: it is charged the cap, never nothing, so
  // the next run's remaining budget stays honest. With no cap it is unmeasured, as a Codex run is, and says so.
  const unknownCost = envelope.costUnknown === true;
  const cap = typeof invocation.maxBudgetUsd === "number" && Number.isFinite(invocation.maxBudgetUsd) && invocation.maxBudgetUsd > 0 ? invocation.maxBudgetUsd : null;
  const costUsd = unknownCost ? cap : envelope.costUsd;
  const usageJson = unknownCost
    ? JSON.stringify({ cost_note: cap === null ? "cost unknown, no dollar cap applied: unmeasured" : "cost unknown, charged at the cap", ...usageOf(envelope.usageRaw) })
    : envelope.usageRaw;
  store.recordUsage(runId, {
    ...(envelope.tokensIn === null ? {} : { tokensIn: envelope.tokensIn + (options.accumulateUsage ? run.tokensIn ?? 0 : 0) }),
    ...(envelope.tokensOut === null ? {} : { tokensOut: envelope.tokensOut + (options.accumulateUsage ? run.tokensOut ?? 0 : 0) }),
    ...(costUsd === null ? {} : { costUsd: costUsd + (options.accumulateUsage ? run.costUsd ?? 0 : 0) }),
    ...(usageJson === null ? {} : { usageJson }),
  });

  // How the attempt ended, classified HERE where the structural terminal
  // still exists; a sign-in that no longer works pauses its provider.
  // A run that failed within seconds having produced nothing is read for
  // the sign-in signal too: a CLI that is not logged in often says so on
  // stderr before its structured stream starts.
  const quietEarlyExit =
    result.code !== 0 && !result.timedOut && !result.notFound &&
    Date.now() - spawnedAt <= AUTH_EARLY_EXIT_MS &&
    envelope.promptConsumed !== true && (envelope.tokensOut ?? 0) === 0;
  const terminalClass = classifyTerminal({
    terminal: envelope.structuralTerminal,
    // stderr and plain stdout only: a JSON event line can carry the agent's
    // own command output (codex aggregated_output), never its sign-in.
    earlyExit: quietEarlyExit ? `${result.stderr.slice(-4096)}\n${plainLines(result.stdout).slice(-4096)}` : null,
  });
  store.stampTerminalClass(runId, authMode, terminalClass);

  // Contradictory structural identity is a provider protocol failure, not
  // a session selection problem. Usage above remains recorded because the
  // process ran and spent, but no downstream handoff or repair may trust
  // either id from this envelope.
  if (envelope.protocolError !== null) {
    return {
      kind: "refused",
      reason: "provider-protocol",
      providerVersion: attested === null ? null : attested.version,
      diagnostic: envelope.protocolError,
      finalMessage: envelope.finalMessage,
    };
  }

  // The minted-identity proof (A5): once the harness initialized, the id
  // it announced must be the id the plane minted — anything else means
  // the session on disk is not the session on record, and repair must
  // never resume it. Usage above is already recorded: the spend happened.
  if (
    startSessionId !== undefined &&
    envelope.initObserved === true &&
    envelope.sessionId !== startSessionId
  ) {
    return {
      kind: "refused",
      reason: "provider-protocol",
      providerVersion: attested === null ? null : attested.version,
      diagnostic:
        envelope.sessionId === null
          ? "the harness initialized without announcing its session id"
          : "the harness announced a session id different from the one it was started under",
      finalMessage: envelope.finalMessage,
    };
  }

  // An early transport announcement, a pre-existing resume identity, and
  // the completed retained envelope must resolve to one canonical id. If
  // either side is missing or different, no handoff or warm resume may use
  // this run even though its spend remains on the record.
  if (sessionIdentityProblem !== null) {
    return {
      kind: "refused",
      reason: "provider-protocol",
      providerVersion: attested === null ? null : attested.version,
      diagnostic: sessionIdentityProblem,
      finalMessage: envelope.finalMessage,
    };
  }

  // A provider's explicit failure terminal always wins over its process exit
  // status. Exit 0 only proves the wrapper closed cleanly; it cannot turn a
  // failed model turn into a successful build.
  if (result.code === 0 && envelope.structuralTerminal?.failed === true) {
    return {
      kind: "refused",
      reason: "provider-protocol",
      providerVersion: attested === null ? null : attested.version,
      diagnostic: "the provider reported a failed terminal despite exiting with code 0",
      finalMessage: envelope.finalMessage,
    };
  }

  // The terminal contract (A4): when the audit requires it, a zero exit is
  // believed ONLY with initialization observed and the structural success
  // terminal present. A missing, truncated, or error-status terminal on
  // exit 0 is the harness breaking its own protocol — never a completed
  // build, and the handoff is never ingested.
  if (
    auditOf(spec.provider).terminalContract === "required" &&
    result.code === 0 &&
    !(envelope.initObserved === true && envelope.promptConsumed === true)
  ) {
    return {
      kind: "refused",
      reason: "provider-protocol",
      providerVersion: attested === null ? null : attested.version,
      diagnostic:
        envelope.diagnostic ??
        (envelope.initObserved === true
          ? "the harness exited 0 without its success terminal — the stream ended mid-protocol"
          : "the harness exited 0 without ever initializing"),
      finalMessage: envelope.finalMessage,
    };
  }

  // A run that worked proves its provider's sign-in works: a sign-in pause
  // on it lifts, and its waiting tasks may start again.
  if (result.code === 0 && envelope.structuralTerminal === null && envelope.promptConsumed !== false) {
    try { liftAuthPause(store, spec.provider, "run", `run #${runId}`, clock(), new Date(spawnedAt)); } catch { /* the pause stays until the next proof */ }
  }

  return {
    kind: "ran",
    outcome: {
      code: result.code,
      stderr: result.stderr,
      timedOut: result.timedOut,
      notFound: result.notFound,
      sessionId: envelope.sessionId,
      finalMessage: envelope.finalMessage,
      structuredOutput: envelope.structuredOutput ?? null,
      ending: envelope.ending ?? null,
      usage: {
        tokensIn: envelope.tokensIn,
        tokensOut: envelope.tokensOut,
        costUsd,
      },
      // Gated on the run having NOTHING to show (Codex M5-M8 audit, C-8),
      // where "nothing to show" is STRUCTURAL when the transport can say so
      // (arc 1 finding 15): a retained error result carries diagnostic text
      // in finalMessage, and that prose must not read as an agent's attempt.
      // Transports without the consumption signal keep the historical
      // no-final-message rule. A nonzero exit WITH a consumed prompt is a
      // failed agent turn — the agent ran, spoke, and failed — and must be
      // classified as that, never as the harness failing to come up.
      initFailed:
        envelope.initObserved === false &&
        (envelope.promptConsumed === null
          ? envelope.finalMessage === null
          : envelope.promptConsumed === false) &&
        !result.timedOut &&
        !result.notFound,
    },
  };
}

/** The reported usage, when its kept text is whole JSON, to sit beside a cost note. */
function usageOf(raw: string | null): { usage?: unknown } {
  if (raw === null) return {};
  try { return { usage: JSON.parse(raw) as unknown }; } catch { return {}; }
}

/** What the plane recorded of a checkout's setup: its project and the setup stamped on it (null: none recorded). */
function linkedFor(store: Store, worktree: string | null): { repo: string; setupDigest: string | null } | null {
  const row = worktree === null ? null : store.getWorktree(worktree);
  return row === null ? null : { repo: row.repo, setupDigest: row.setupDigest ?? null };
}

/** The paths this run's agent may not reach: the state folder around the live database (but not its own worktree),
 * ~/.toolroll (or its older name), its task boundary and other launches' private folders; what the fence gives back
 * (FenceGrants); and what only Claude's file tools refuse. */
function runFence(store: Store, runId: number, provider: AgentSpec["provider"], keyHome: string | undefined, ownTools: string | null): { fence: string[]; fileTools: string[]; grants: FenceGrants; problem?: string } {
  try {
    // A plane always has a database file; an in-memory store (a test) has nothing to fence.
    const databaseFile = store.databaseFile();
    if (databaseFile === null) return { fence: [], fileTools: [], grants: NO_GRANTS };
    const worktree = store.getRun(runId)?.worktree ?? null;
    const home = keyHome === undefined ? {} : { home: keyHome };
    const row = worktree === null ? null : store.getWorktree(worktree);
    if (worktree !== null && row === null) throw new CheckoutBindingError("The checkout's Git pointer was changed or its trusted binding could not be verified.");
    const poolRoots = [join(dirname(databaseFile), "worktrees"), ...store.listWorktrees().map(record => poolRootOf(record.path, record.repo))];
    const binding = worktree === null || row === null ? null : trustedWorktreeBinding(row.repo, worktree, poolRoots);
    const boundary = worktree === null ? null : taskBoundary({ worktree, provider, ...home, binding });
    const folders = runFolders(ownTools);
    return {
      fence: agentFence({ databaseFile, worktree, ...home, boundary, binding, runFolders: folders }),
      fileTools: boundary?.fileTools ?? [],
      // The shared install is granted only as the plane linked it: this checkout's project and stamped setup.
      // Every plane checkout pool is denied around this one: the plane's own beside the database, and the one this
      // checkout was recorded in (a --pool elsewhere), so another project's worktree, present at launch, is out of reach. Native wrappers also cover later creations.
      grants: fenceGrants({ databaseFile, worktree, boundary, runFolders: folders, linked: linkedFor(store, worktree), binding, ...home,
        poolRoots }),
    };
  } catch (error) {
    return { fence: [], fileTools: [], grants: NO_GRANTS, problem: error instanceof CheckoutBindingError ? error.message : "The build fence could not be prepared." };
  }
}

/** The operator's own model choices a build routed with no model keeps (provider-home.ts). */
function inheritedDefaults(provider: AgentSpec["provider"], env: Readonly<Record<string, string | undefined>>, home: string): ProviderDefaults | undefined {
  if (provider === "claude") return claudeDefaults(claudeConfigDir(env, home));
  if (provider === "codex") return codexDefaults(codexHomeDir(env, home));
  return undefined;
}

/** How the fence reaches a provider: Codex through its own sandbox profile
 * (already in its argv; wrapping it would nest sandboxes), Claude and
 * Gemini inside the macOS sandbox the spawn road applies (`wrap`), Claude
 * elsewhere through its own file-tool rules only. */
function fenceLaunch(provider: AgentSpec["provider"], fence: readonly string[]): { wrap: readonly string[]; method: FenceMethod } {
  const method = fenceMethod(provider, fence.length > 0);
  return { wrap: method === "macos-sandbox" || method === "linux-bubblewrap" ? fence : [], method };
}

/** The fence a launch gets, from its provider, whether it has anything to fence, and what this platform supports. */
function fenceMethod(provider: AgentSpec["provider"], fenced: boolean): FenceMethod {
  if (!fenced) return "none";
  if (provider === "codex" || provider === "openrouter") return "codex-profile";
  if (macosFenceAvailable()) return "macos-sandbox";
  if (linuxFenceAvailable()) return "linux-bubblewrap";
  return provider === "claude" ? "claude-rules" : "none";
}

/** One launch's tools, or — when they cannot be prepared — the same isolation with none, never the operator's global servers. */
async function runTools(store: Store, runId: number, spec: AgentSpec, keyHome: string | undefined, clock: () => Date, readOnly: Readonly<Record<string, readonly string[]>> | undefined, withheld: Readonly<Record<string, string>> | undefined, containment: ToolContainment, broker: BrokerOptions): Promise<ToolLaunchArgs | { refused: string }> {
  try {
    return await prepareRunTools(store, runId, spec.provider, { ...(keyHome === undefined ? {} : { home: keyHome }), now: clock(), containment, ...(readOnly === undefined ? {} : { readOnly }), ...(withheld === undefined ? {} : { withheld }), broker });
  } catch (error) {
    // Sign-ins made for this run couldn't all be kept (and were revoked): it doesn't start.
    if (error instanceof RunSignInError) return { refused: error.message };
    return noToolsArgs(spec.provider);
  }
}

/** How Codex says it's signed in (`codex login status`): a ChatGPT sign-in is its plan; a key or Bedrock is a key;
 * null when it says neither (not signed in, or it didn't answer). */
async function codexLoginBilling(binary: string, omitEnv: readonly string[]): Promise<Billing | null> {
  try {
    const status = await runCommand(binary, ["login", "status"], { timeoutMs: 15_000, omitEnv, processGroup: true });
    const said = `${status.stdout}\n${status.stderr}`;
    return /using chatgpt/i.test(said) ? "subscription" : /api key|bedrock/i.test(said) ? "api-key" : null;
  } catch {
    return null;
  }
}

/** The lines of a harness's stdout that are not JSON events. */
function plainLines(stdout: string): string {
  return stdout.split("\n").filter(line => !line.trimStart().startsWith("{")).join("\n");
}
