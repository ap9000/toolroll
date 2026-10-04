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

import { adapterFor, auditOf, type AgentSpec, type Invocation, type ProviderRunner, type AgentEnding } from "./provider.js";
import { readProviderKey, readAuthModeStrict, PROVIDER_KEY_ENV, OWN_KEY_ENV } from "./keys.js";
import { classifyTerminal } from "./exhaustion.js";
import { liftAuthPause } from "./provider-auth.js";
import { attestProvider, type VersionProbe } from "./attest.js";
import { run as runCommand, runOwnerTag, startClaudeHeldSession } from "./exec.js";
import { currentContainment } from "./containment.js";
import type { Store } from "./store.js";
import type { RunOptions } from "./exec.js";
import { witnessedRunner, recordProcessObservationFailure, preserveObservedProcesses } from "./process-custody.js";
import { underStopWatch } from "./task-control.js";
import { childDatabaseEnv, isolatedChildDatabase, removeChildDatabase as removeAgentDatabase } from "./child-database.js";
import { noToolsArgs, prepareRunTools, type ToolLaunchArgs } from "./project-tools.js";
import { realpathSync } from "node:fs";
import { agentFence, claudeFenceSettings, linuxFenceAvailable, macosFenceAvailable, type FenceMethod } from "./agent-fence.js";
import { billingOf, claudeBillingFrom, seenBilling, type Billing } from "./spend.js";

export type { ProviderRunner } from "./provider.js";

/** The claude binary name — kept for the legacy quota rows and tests that
 * describe history; new code carries a resolved AgentSpec instead. */
export const PROVIDER_BINARY = "claude";

/** "Within seconds": how soon a silent failed run must end for its stderr to
 * be read for the sign-in signal. */
const AUTH_EARLY_EXIT_MS = 30_000;

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
      reason: "provider-unattested" | "provider-protocol" | "chain-credential" | "chain-custody" | "runner-custody" | "auth-mode" | "route-authority" | "stopped" | "containment";
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
  const { startSessionId: _untrustedStartSessionId, ...invocationWithoutStart } = invocation;
  const resolvedInvocation = {
    ...invocationWithoutStart,
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
  // A CHAIN-BOUND run carries a PINNED mode sealed into its approved entry
  // (E3d, review finding 5): the pin IS the authority — a per-provider
  // mode-file flip between admission and spawn must never move the spend
  // onto a credential the operator didn't approve for this entry. Every
  // other run reads the operator's live setting, as always.
  const {
    runner,
    clock: _clock,
    versionProbe: _probe,
    keyHome,
    timeoutMs: _hardTimeout,
    idleTimeoutMs: _idleTimeout,
    stdin: _callerStdin,
    accumulateUsage: _accumulateUsage,
    ...runOptions
  } = options;
  // The live setting is read STRICTLY (atomic authority closure): a
  // present mode file that says neither word is a value-shaped refusal
  // before any stamp or process — never the subscription default a
  // lenient read would coerce it to, which would spend on a credential
  // the seal never proved. The same reader gates filing and the seal.
  let authMode: "subscription" | "api-key";
  if (run.chainCycle != null && run.authMode != null) {
    authMode = run.authMode;
  } else {
    const strict = readAuthModeStrict(spec.provider, keyHome);
    if (!strict.ok) {
      return {
        kind: "refused",
        reason: "auth-mode",
        providerVersion: attested === null ? null : attested.version,
        diagnostic: strict.problem,
      };
    }
    authMode = strict.mode;
  }
  const ownKeyEnv = OWN_KEY_ENV[spec.provider];
  const managedKey =
    authMode === "api-key"
      ? readProviderKey(spec.provider, keyHome) ?? (process.env[PROVIDER_KEY_ENV[spec.provider]] || null)
      : null;
  // A pinned api-key entry with NO key is REFUSED, not spawned (Codex E3d
  // review, finding 1): with nothing to inject, the provider CLI would
  // quietly fall back to its cached subscription login — spend on a
  // credential the entry never approved. A value-shaped refusal before any
  // stamp: no process, no spend, no strike.
  if (run.chainCycle != null && authMode === "api-key" && managedKey === null) {
    return {
      kind: "refused",
      reason: "chain-credential",
      providerVersion: attested === null ? null : attested.version,
      diagnostic: `the approved entry is pinned to a ${spec.provider} API key, and no managed or ambient key exists — add one on the keys screen`,
    };
  }

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

  // The stamp precedes the spawn, so a crash between the two leaves a run
  // that claims spend which never happened — the honest direction. A spawn
  // before the stamp would leave spend no record claims, which is the lie
  // the invariant exists to rule out. For attested providers the probed
  // version rides the SAME durable write (B2). A CHAIN-BOUND run's stamp is
  // the PRE-SPAWN CUSTODY PROOF (Codex E3d review, finding 3): one
  // transaction re-derives the approval, cycle, entry, pin, and (past the
  // base) the live paid-fallback grant, and stamps ONLY if all still stand
  // — a grant revoked between admission and this instant refuses here.
  // The spawn leg of the runner gate (MCP spec v6, review finding 4):
  // the tuple re-proven against LIVE rows AFTER every awaited step, in
  // the same breath as the stamp — a takeover during the attestation
  // await can no longer slip a stale process through.
  // THE PLANNER'S ROUTE, RE-PROVED AT THE SPAWN (final authority closure):
  // the provenance the planner was admitted under is held to the authority
  // its task holds RIGHT NOW — the strict working projection of a filed
  // scope (exact terms, resolved profile, whole chain, route parity, digest,
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

  if (run.chainCycle != null) {
    const custody =
      attested !== null
        ? store.proveChainCustodyForSpawn(runId, clock(), attested.version)
        : store.proveChainCustodyForSpawn(runId, clock());
    if (!custody) {
      return {
        kind: "refused",
        reason: "chain-custody",
        providerVersion: attested === null ? null : attested.version,
        diagnostic: "the run's chain custody lapsed before spawn — the approval, cycle, entry pin, or paid-fallback grant no longer stands",
      };
    }
  } else if (attested !== null) store.stampProviderStart(runId, clock(), attested.version);
  else store.stampProviderStart(runId, clock());

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
  // The project's tools (v80): exactly its MCP servers, and none of the
  // operator's global or a repository's own. A review keeps its isolation.
  const tools = invocation.phase === "review" ? null : runTools(store, runId, spec, options.keyHome, clock, invocation.readOnlyTools);
  // The agent fence: Toolroll's own secrets, database and other runs'
  // evidence stay out of reach, whatever the permission mode. A review is
  // already confined to its sealed files.
  const baseFence = invocation.phase === "review" ? [] : runFence(store, runId, options.keyHome);
  const toolsDir = (spec.provider === "codex" || spec.provider === "openrouter") && baseFence.length > 0 ? tools?.privateDir : undefined;
  const fence = toolsDir === undefined ? baseFence : [...baseFence, realpathSync(toolsDir)];
  const launchArgv = tools === null ? argv : adapter.argv({ ...resolvedInvocation, toolArgv: tools.argv, fence });
  const fenced = fenceLaunch(spec.provider, fence);
  if (invocation.phase !== "review") store.recordRunFence(runId, { method: fenced.method, paths: fence.length }, clock());
  const billingSeen: { keySource: string | null; model: string | null; planWindows: boolean; answered: boolean } = { keySource: null, model: null, planWindows: false, answered: false };
  // v105: a Codex run on its sign-in bills as Codex says it's signed in (a ChatGPT plan, or a saved key, or Bedrock),
  // read right before it runs. Never with an injected runner: tests don't start a real Codex.
  const codexLogin = spec.provider === "codex" && authMode === "subscription" && runner === undefined
    ? await codexLoginBilling(attested !== null ? attested.executable : adapter.binary, [...(runOptions.omitEnv ?? []), ...adapter.extraOmitEnv, ...ownKeyEnv])
    : null;
  let result: Awaited<ReturnType<typeof spawn>>;
  const spawnedAt = Date.now();
  try {
    // Under the stop watch (v52): the run's stop row is re-read while the
    // provider runs, and a stop kills THIS run's process group through the
    // handle registered under its owner tag — the exact-attempt road,
    // never the global sweep. Settlement then reads the same row.
    result = await underStopWatch(store, runId, () => spawn(attested !== null ? attested.executable : adapter.binary, launchArgv, {
      ...(fenced.wrap.length === 0 ? {} : { fence: fenced.wrap }),
      ...runOptions,
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
      ...(hardTimeoutMs === undefined ? {} : { timeoutMs: hardTimeoutMs }),
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
      ...(defaultTimeoutMs === undefined ? {} : { timeoutMs: defaultTimeoutMs }),
      env: {
        ...(runOptions.env ?? {}),
        ...(tools?.env ?? {}),
        ...(managedKey === null ? {} : { [PROVIDER_KEY_ENV[spec.provider]]: managedKey }),
        // This key is deliberately last: no caller may point an agent back at
        // the live control database through a generic RunOptions override.
        ...childDatabaseEnv(isolatedDb.file),
      },
      omitEnv: [
        ...(runOptions.omitEnv ?? []),
        ...adapter.extraOmitEnv,
        // Subscription mode: shed this provider's OWN key too, so an ambient
        // one cannot force API billing over the login the operator prefers.
        // Api-key mode: shed every OTHER own-key alias (finding 1) — gemini
        // reads GOOGLE_API_KEY as well as GEMINI_API_KEY, and a stray alias
        // must not override the ONE canonical key this mode injected.
        ...(authMode === "subscription"
          ? ownKeyEnv
          : ownKeyEnv.filter(name => name !== PROVIDER_KEY_ENV[spec.provider])),
      ],
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
    }));
  } finally {
    removeAgentDatabase(isolatedDb.dir);
    tools?.cleanup();
  }

  // v105: the run's billing, fixed from evidence before its usage is priced: a key it was given is a key; otherwise
  // what the CLI said (Claude's stream) or was last seen doing (Codex's account), and the setting only when neither.
  const evidence = spec.provider === "claude" ? claudeBillingFrom(billingSeen)
    // Codex signed in with ChatGPT is its plan, unless its plan is itself billed by use (seen by the console's probe).
    : codexLogin === "subscription" ? seenBilling(store.handle, "codex") ?? "subscription" : codexLogin;
  // What this computer's Claude does with no key from us (teammates and drafts bill the same way): learnt only from a
  // run we gave no key that got as far as an answer.
  if (spec.provider === "claude" && managedKey === null && authMode === "subscription" && billingSeen.answered && evidence !== null) {
    store.recordProviderBilling("claude", evidence, new Date());
  }
  store.fixRunBilling(runId, authMode === "api-key" ? "api-key" : evidence ?? billingOf(spec.provider, store.handle), new Date());

  const envelope = adapter.parse(result.stdout);
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
  store.recordUsage(runId, {
    ...(envelope.tokensIn === null ? {} : { tokensIn: envelope.tokensIn + (options.accumulateUsage ? run.tokensIn ?? 0 : 0) }),
    ...(envelope.tokensOut === null ? {} : { tokensOut: envelope.tokensOut + (options.accumulateUsage ? run.tokensOut ?? 0 : 0) }),
    ...(envelope.costUsd === null ? {} : { costUsd: envelope.costUsd + (options.accumulateUsage ? run.costUsd ?? 0 : 0) }),
    ...(envelope.usageRaw === null ? {} : { usageJson: envelope.usageRaw }),
  });

  // The fallback taxonomy stamp (E2): classify HERE, where the evidence
  // still exists — the structural terminal off this exact envelope, the
  // AUTHORITATIVE version the gateway proved at spawn, and the auth mode
  // that spawned it. `classifyTerminal` is fail-closed: with no
  // fixture-backed recognizer for this (provider, version) — the state
  // every build ships in — it can only ever return a non-eligible class,
  // so this stamp authorizes nothing. It is the honest disposal record the
  // dispatch's C8 gate later re-checks against `hasRecognizer` before it
  // reads the class as anything more than history. Tier-1 providers prove
  // no version here yet (attested === null), so they classify fail-closed
  // until their exhaustion fixture — and the version proving it needs — is
  // captured and reviewed.
  // A run that failed within seconds having produced nothing is read for
  // the sign-in signal too: a CLI that is not logged in often says so on
  // stderr before its structured stream starts.
  const quietEarlyExit =
    result.code !== 0 && !result.timedOut && !result.notFound &&
    Date.now() - spawnedAt <= AUTH_EARLY_EXIT_MS &&
    envelope.promptConsumed !== true && (envelope.tokensOut ?? 0) === 0;
  const terminalClass = classifyTerminal({
    provider: spec.provider,
    version: attested === null ? null : attested.version,
    authMode,
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
        costUsd: envelope.costUsd,
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

/**
 * The HELD invocation gateway (Parity II Phase 2, spec v2 S0b): the only
 * door to the held-session transport, symmetric with invokeAgent — same
 * open-run verification, same provider-match rule (claude only in Phase
 * 2: nothing else can hold), same stamp-before-spawn honesty. It returns
 * the live handle rather than awaiting session end: ownership of the
 * hold belongs to the coordinator, never to a promise chain that would
 * stall the watch.
 */
export async function invokeHeldAgent(
  store: Store,
  runId: number,
  spec: AgentSpec,
  argv: readonly string[],
  options: import("./exec.js").RunOptions & {
    socketPath: string;
    cookie: string;
    graceMs?: number;
    events?: import("./exec.js").HeldSessionEvents;
    readyTimeoutMs?: number;
    clock?: () => Date;
    starter?: typeof startClaudeHeldSession;
    keyHome?: string;
  },
): Promise<import("./exec.js").HeldSessionStart> {
  const clock = options.clock ?? (() => new Date());
  const run = store.getRun(runId);
  if (run === null || run.outcome !== null) {
    throw new Error(
      `run ${runId} is not an open attempt — nothing spends without a run record that will outlive it`,
    );
  }
  if (spec.provider !== "claude" || run.provider !== "claude") {
    throw new Error(
      `run ${runId}: only claude can hold a session in Phase 2 — ${run.provider}/${spec.provider} cannot`,
    );
  }

  const adapter = adapterFor("claude");
  const { clock: _clock, starter, socketPath, cookie, graceMs, events, readyTimeoutMs, keyHome, ...runOptions } = options;

  // The spawn leg of the runner gate (MCP spec v6) — held sessions are a
  // provider spawn like any other; a lapsed custody throws, because the
  // held road's contract is exceptions, not refusal values.
  if (!store.proveRunnerCustodyForSpawn(runId, clock())) {
    throw new Error(
      `run ${runId}: runner custody lapsed before the held spawn — the lease, the runner, or its repo binding no longer stands`,
    );
  }

  // The held road reads the mode STRICTLY too (atomic authority closure),
  // before the start stamp: a mode file that says neither word throws in
  // its words — the held road's contract — and no spend is claimed.
  const heldStrict = readAuthModeStrict("claude", keyHome);
  if (!heldStrict.ok) throw new Error(`run ${runId}: ${heldStrict.problem}`);
  const heldMode = heldStrict.mode;

  // The containment fence, same direction as the one-shot gateway: a
  // required policy this runner cannot meet throws in its words before
  // the start stamp, and no supervisor spawns.
  const heldContainment = currentContainment();
  if (heldContainment.refusal !== null) throw new Error(`run ${runId}: ${heldContainment.refusal}`);

  // The stamp precedes the spawn — same direction as the one-shot gateway.
  store.stampProviderStart(runId, clock());

  const heldKey =
    heldMode === "api-key" ? readProviderKey("claude", keyHome) ?? (process.env[PROVIDER_KEY_ENV.claude] || null) : null;
  const heldSeen = { keySource: null as string | null, model: null as string | null, planWindows: false, decided: false };
  // A session given a key bills the key from its first byte.
  if (heldMode === "api-key") store.fixRunBilling(runId, "api-key", clock());
  const start = starter ?? startClaudeHeldSession;
  const isolatedDb = isolatedAgentDatabase(runId);
  // The project's tools (v80), as for every build: exactly its MCP servers;
  // and the agent fence around Toolroll's own secrets.
  const heldTools = runTools(store, runId, spec, keyHome, clock, undefined);
  const heldFence = runFence(store, runId, keyHome);
  argv = [...argv, ...heldTools.argv, ...(heldFence.length > 0 ? ["--settings", claudeFenceSettings(heldFence)] : [])];
  const heldLaunch = fenceLaunch("claude", heldFence);
  store.recordRunFence(runId, { method: heldLaunch.method, paths: heldFence.length }, clock());
  let started: import("./exec.js").HeldSessionStart;
  let heldWitness: number | undefined;
  let unknownTree = false;
  let nativeHeld = false;
  try {
    started = await start(adapter.binary, argv, {
      ...(heldLaunch.wrap.length === 0 ? {} : { fence: heldLaunch.wrap }),
      ...runOptions,
      beforeSpawn: () => {
        if (store.applicableStopFor(runId) !== null) return false;
        heldWitness = store.reserveRunProcess(runId, clock(), false);
        return true;
      },
      onSpawn: pid => {
        store.recordRunProcess(runId, pid, clock(), false, heldWitness);
        runOptions.onSpawn?.(pid);
      },
      onSpawnFailed: () => {
        if (heldWitness !== undefined) store.finishUnspawnedProcess(heldWitness, clock());
        runOptions.onSpawnFailed?.();
      },
      onContainer: info => {
        nativeHeld = true;
        if (heldWitness !== undefined) store.recordRunContainer(heldWitness, info.backend, info.id, info.identity);
        runOptions.onContainer?.(info);
      },
      onContainerEmpty: () => {
        if (heldWitness !== undefined) store.markRunContainerEmpty(heldWitness, clock());
        runOptions.onContainerEmpty?.();
      },
      onDescendant: (pid, group) => {
        store.recordRunProcess(runId, pid, clock(), group);
        runOptions.onDescendant?.(pid, group);
      },
      onDescendantWriteFailure: rows => runOptions.onDescendant === undefined
        && preserveObservedProcesses(store, runId, clock(), rows),
      onDescendantExit: (pid, group) => {
        store.recordRunProcessExits(runId, clock(), { pid, group });
        runOptions.onDescendantExit?.(pid, group);
      },
      onObservationFailure: failure => {
        recordProcessObservationFailure(store, runId, clock(), failure);
        runOptions.onObservationFailure?.(failure);
      },
      onUnknown: () => {
        if (!nativeHeld && !unknownTree) { store.reserveRunProcess(runId, clock()); unknownTree = true; }
        runOptions.onUnknown?.();
      },
      env: {
        ...(runOptions.env ?? {}),
        ...heldTools.env,
        ...(heldKey === null ? {} : { [PROVIDER_KEY_ENV.claude]: heldKey }),
        ...childDatabaseEnv(isolatedDb.file),
      },
      omitEnv: [
        ...(runOptions.omitEnv ?? []),
        ...adapter.extraOmitEnv,
        ...(heldMode === "subscription" ? OWN_KEY_ENV.claude : []),
      ],
      socketPath,
      cookie,
      ...(graceMs === undefined ? {} : { graceMs }),
      ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
      events: {
        ...events,
        // v105: the session's billing from its own stream. A sign-in can't change inside one process, and Claude reports
        // its plan's windows on a process's first answer but later only when they move: so the first answer decides, and
        // after it only a named key source or a cloud model can make the session a key.
        onStreamEvent: event => {
          if (event["type"] === "system" && event["subtype"] === "init") {
            if (typeof event["apiKeySource"] === "string") heldSeen.keySource = event["apiKeySource"].slice(0, 80);
            if (typeof event["model"] === "string") heldSeen.model = event["model"].slice(0, 200);
          } else if (event["type"] === "rate_limit_event") {
            heldSeen.planWindows = true;
          } else if (event["type"] === "result" && event["is_error"] !== true && event["subtype"] === "success") {
            // Only an answer decides: a failure before the first answer (a startup or sign-in error) says nothing yet.
            const billing = heldMode === "api-key" ? "api-key"
              : !heldSeen.decided ? claudeBillingFrom(heldSeen)
              : claudeBillingFrom({ ...heldSeen, keySource: heldSeen.keySource === "none" ? null : heldSeen.keySource, planWindows: false }) === "api-key" ? "api-key" : null;
            if (billing !== null) {
              store.fixRunBilling(runId, billing, new Date());
              if (!heldSeen.decided && heldMode === "subscription" && heldKey === null) store.recordProviderBilling("claude", billing, new Date());
            }
            heldSeen.decided = true;
          }
          events?.onStreamEvent?.(event);
        },
        onSessionId: id => {
          const normalized = transportSessionId(id);
          if (normalized === null) return;
          store.stampRun(runId, { sessionId: normalized });
          try {
            events?.onSessionId?.(normalized);
          } catch {
            // Observational.
          }
        },
      },
    });
  } catch (error) {
    removeAgentDatabase(isolatedDb.dir);
    heldTools.cleanup();
    throw error;
  }
  if (!started.ok) {
    removeAgentDatabase(isolatedDb.dir);
    heldTools.cleanup();
  } else {
    void started.handle.exited.then(
      () => { removeAgentDatabase(isolatedDb.dir); heldTools.cleanup(); },
      () => { removeAgentDatabase(isolatedDb.dir); heldTools.cleanup(); },
    );
  }
  return started;
}

/** The paths this run's agent may not reach: the state folder around the live database (but not its own worktree) and ~/.toolroll (or its older name). */
function runFence(store: Store, runId: number, keyHome: string | undefined): string[] {
  try {
    // A plane always has a database file; an in-memory store (a test) has nothing to fence.
    const databaseFile = store.databaseFile();
    if (databaseFile === null) return [];
    return agentFence({ databaseFile, worktree: store.getRun(runId)?.worktree ?? null, ...(keyHome === undefined ? {} : { home: keyHome }) });
  } catch {
    return [];
  }
}

/** How the fence reaches a provider: Codex through its own sandbox profile
 * (already in its argv; wrapping it would nest sandboxes), Claude and
 * Gemini inside the macOS sandbox the spawn road applies (`wrap`), Claude
 * elsewhere through its own file-tool rules only. */
function fenceLaunch(provider: AgentSpec["provider"], fence: readonly string[]): { wrap: readonly string[]; method: FenceMethod } {
  if (fence.length === 0) return { wrap: [], method: "none" };
  if (provider === "codex" || provider === "openrouter") return { wrap: [], method: "codex-profile" };
  if (macosFenceAvailable()) return { wrap: fence, method: "macos-sandbox" };
  if (linuxFenceAvailable()) return { wrap: fence, method: "linux-bubblewrap" };
  return { wrap: [], method: provider === "claude" ? "claude-rules" : "none" };
}

/** One launch's tools, or — when they cannot be prepared — the same isolation with none, never the operator's global servers. */
function runTools(store: Store, runId: number, spec: AgentSpec, keyHome: string | undefined, clock: () => Date, readOnly: Readonly<Record<string, readonly string[]>> | undefined): ToolLaunchArgs {
  try {
    return prepareRunTools(store, runId, spec.provider, { ...(keyHome === undefined ? {} : { home: keyHome }), now: clock(), includeModel: spec.model === null, ...(readOnly === undefined ? {} : { readOnly }) });
  } catch {
    return noToolsArgs(spec.provider, spec.model === null);
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
