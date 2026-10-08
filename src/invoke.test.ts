/**
 * The invocation gateway: the only door to any provider, and the anchor of
 * the zero-token invariant — provider spawns == runs stamped before the
 * spawn, and every completed process's usage is read, exit code be damned.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resetAttestationCache } from "./attest.js";
import { dirname, join } from "node:path";
import { openStore, type Store } from "./store.js";
import { invokeAgent, type InvokeResult } from "./invoke.js";
import { register, retireRunnerIfCurrent } from "./runner.js";
import { acquire } from "./claim.js";
import { fakePid } from "../test/fake-pid.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

/** Most of this suite exercises the RAN arm; the union's refusal arms have
 * their own describe below. */
async function invokeRan(...args: Parameters<typeof invokeAgent>) {
  const result: InvokeResult = await invokeAgent(...args);
  if (result.kind !== "ran") throw new Error(`expected a ran outcome, got refused: ${result.reason}`);
  return result.outcome;
}

const T0 = new Date("2026-08-12T06:00:00.000Z");
/** Long enough that the lease is unexpired at every clock a test uses,
 * including the tests that run on the real wall clock. */
const TTL = 10 * 365 * 24 * 3600 * 1000;
const REPO = "/repo/invoke";
const RUNNER = "builder-1";

/** The runner gate's spawn leg (MCP spec v6) re-proves custody immediately
 * before any provider process exists: the runner registered and bound to
 * the task's repo, the task placed, and the run's lease the task's CURRENT
 * live claim. Every run a test invokes gets this real fixture first. */
function registerBuilder(store: Store): void {
  register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => `tok-${RUNNER}` });
}
function claimTask(store: Store, taskId: string, leaseId: string): number {
  const ref = store.refFor("built-in", taskId).id;
  store.placeTask(ref, REPO);
  const took = acquire(store, ref, RUNNER, { now: T0, token: `tok-${RUNNER}`, newLeaseId: () => leaseId, ttlMs: TTL });
  if (!took.ok) throw new Error(`fixture claim refused: ${took.reason}`);
  return ref;
}
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const CLAUDE = { provider: "claude" as const, model: null };
const ASK = {
  phase: "build" as const,
  brief: "hi",
  maxTurns: 10,
  permissionMode: "acceptEdits",
  skipPermissions: false,
  resumeSession: null,
};

describe("the invocation gateway", () => {
  let store: Store;
  let runId: number;

  beforeEach(() => {
    store = openStore(":memory:");
    registerBuilder(store);
    store.createTask({ id: "t-1", title: "w" }, T0);
    const ref = claimTask(store, "t-1", "lease-1");
    runId = store.startRun({
      taskRef: ref,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      ...bareLegacy("build", "claude", null), now: T0,
    });
  });

  afterEach(() => store.close());

  test("v105: a run's billing comes from its own stream, and only a keyless run that answered teaches what this computer's Claude does", async () => {
    const home = mkdtempSync(join(tmpdir(), "so-billing-"));
    const keys = join(home, ".standing-orders", "keys");
    mkdirSync(keys, { recursive: true });
    const result = JSON.stringify({ type: "result", subtype: "success", result: "ok", total_cost_usd: 1.5, usage: { input_tokens: 10, output_tokens: 5 } });
    const streaming = (init: Record<string, unknown>, windows: boolean) => async (_file: string, _args: readonly string[], options: { onStreamEvent?: (event: Record<string, unknown>) => void } = {}) => {
      options.onStreamEvent?.({ type: "system", subtype: "init", ...init });
      if (windows) options.onStreamEvent?.({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1 } } } });
      options.onStreamEvent?.(JSON.parse(result));
      return { ...OK, stdout: `${result}\n` };
    };
    const spend = () => store.handle.prepare("SELECT microusd, billing FROM run_spend WHERE run = ?").get(runId);
    const seen = () => store.handle.prepare("SELECT billing FROM provider_account WHERE provider = 'claude'").get()?.["billing"] ?? null;
    const fresh = (id: string) => {
      store.finishRun(runId, { outcome: "built", now: T0 });
      store.createTask({ id, title: id }, T0);
      runId = store.startRun({ taskRef: claimTask(store, id, `lease-${id}`), leaseId: `lease-${id}`, runner: RUNNER, branch: id, worktree: `/w/${id}`, ...bareLegacy("build", "claude", null), now: T0 });
    };
    try {
      writeFileSync(join(keys, "claude.auth"), "subscription");
      // On the plan: its windows prove it; $0, and the computer's Claude is its plan.
      await invokeRan(store, runId, CLAUDE, ASK, { runner: streaming({ apiKeySource: "none", model: "claude-sonnet-5" }, true), keyHome: home });
      expect(spend()).toEqual({ microusd: 0, billing: "subscription" });
      expect(seen()).toBe("subscription");
      // "none" without windows (a gateway's token): a key, and now the computer's Claude bills one.
      fresh("t-gateway");
      await invokeRan(store, runId, CLAUDE, ASK, { runner: streaming({ apiKeySource: "none", model: "claude-sonnet-5" }, false), keyHome: home });
      expect(spend()).toEqual({ microusd: 1_500_000, billing: "api-key" });
      expect(seen()).toBe("api-key");
      // A key we gave it bills the key, and teaches nothing about the computer's own Claude.
      store.handle.prepare("UPDATE provider_account SET billing = 'subscription'").run();
      writeFileSync(join(keys, "claude.auth"), "api-key");
      writeFileSync(join(keys, "claude"), `sk-ant-${"x".repeat(24)}`);
      fresh("t-keyed");
      await invokeRan(store, runId, CLAUDE, ASK, { runner: streaming({ apiKeySource: "ANTHROPIC_API_KEY", model: "claude-sonnet-5" }, false), keyHome: home });
      expect(spend()).toEqual({ microusd: 1_500_000, billing: "api-key" });
      expect(seen()).toBe("subscription");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("nothing spends without an open run", async () => {
    await expect(
      invokeRan(store, 999, CLAUDE, ASK, { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);

    store.finishRun(runId, { outcome: "built", now: T0 });
    await expect(
      invokeRan(store, runId, CLAUDE, ASK, { runner: async () => OK }),
    ).rejects.toThrow(/not an open attempt/);
  });

  test("a run opened for one provider refuses to spawn another", async () => {
    // The run row says claude (the default); codex about to spawn against
    // it is a session id that means nothing — refused structurally.
    await expect(
      invokeRan(store, runId, { provider: "codex", model: null }, ASK, {
        runner: async () => OK,
      }),
    ).rejects.toThrow(/about to spawn/);
    // Nothing was stamped: the refusal precedes the spend.
    expect(store.getRun(runId)?.providerStartedAt).toBeNull();
  });

  test("the stamp precedes the spawn — a crash between the two lies in the honest direction", async () => {
    let stampAtSpawn: string | null = null;
    await invokeRan(store, runId, CLAUDE, ASK, {
      clock: () => T0,
      runner: async () => {
        stampAtSpawn = store.getRun(runId)?.providerStartedAt ?? null;
        return OK;
      },
    });

    expect(stampAtSpawn).toBe(T0.toISOString());
  });

  test("the provider gets a disposable control database, never the caller's live one", async () => {
    let childDb: string | undefined;
    await invokeRan(store, runId, CLAUDE, ASK, {
      env: { STANDING_ORDERS_DB: "/operator/live/orders.db" },
      runner: async (_file, _args, options) => {
        childDb = options.env?.["STANDING_ORDERS_DB"];
        expect(childDb).toBeDefined();
        expect(childDb).not.toBe("/operator/live/orders.db");
        expect(existsSync(dirname(childDb!))).toBe(true);
        return OK;
      },
    });

    expect(childDb).toBeDefined();
    expect(existsSync(dirname(childDb!))).toBe(false);
  });

  test("usage is read off every completed process, nonzero exits included", async () => {
    const envelope = JSON.stringify({
      result: "half done, then it broke",
      usage: { input_tokens: 41_000, output_tokens: 2_500 },
      total_cost_usd: 0.4321,
    });
    const result = await invokeRan(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: envelope, stderr: "boom" }),
    });

    expect(result.code).toBe(1);
    expect(result.finalMessage).toBe("half done, then it broke");
    expect(result.usage).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: 41_000, tokensOut: 2_500, costUsd: 0.4321 });
  });

  test("what was not measured stays NULL — never a fabricated zero", async () => {
    await invokeRan(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, stdout: "not json at all" }),
    });

    expect(store.getRun(runId)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null });
    // But the spawn itself is on the record regardless.
    expect(store.getRun(runId)?.providerStartedAt).not.toBeNull();
  });

  test("negative or non-numeric usage is a lie, not a measurement", async () => {
    await invokeRan(store, runId, CLAUDE, ASK, {
      runner: async () => ({
        ...OK,
        stdout: JSON.stringify({ usage: { input_tokens: -5, output_tokens: "many" }, total_cost_usd: "cheap" }),
      }),
    });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null });
  });

  test("a codex run parses the retained JSONL — tokens measured, dollars honestly NULL", async () => {
    store.createTask({ id: "t-2", title: "w2" }, T0);
    const ref2 = claimTask(store, "t-2", "lease-2");
    const codexRun = store.startRun({
      taskRef: ref2, leaseId: "lease-2", runner: "builder-1",
      branch: "b", worktree: "/w", provider: "codex", ...bareLegacy("build", "codex", null), now: T0,
    });
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-abc" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done and dusted" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9_000, output_tokens: 800, cached_input_tokens: 5_000 } }),
    ].join("\n");
    const result = await invokeRan(
      store, codexRun, { provider: "codex", model: "gpt-5-codex" }, ASK,
      { runner: async () => ({ ...OK, stdout: jsonl }) },
    );
    expect(result.sessionId).toBe("thread-abc");
    expect(result.finalMessage).toBe("done and dusted");
    expect(result.initFailed).toBe(false);
    // cached tokens ride the raw record only — input is input.
    expect(store.getRun(codexRun)).toMatchObject({ sessionId: "thread-abc", tokensIn: 9_000, tokensOut: 800, costUsd: null });
  });

  /** M5 provider audit: init failure is observed structurally, never guessed. */
  const codexRunFor = (id: string) => {
    store.createTask({ id, title: "w" }, T0);
    return store.startRun({
      taskRef: claimTask(store, id, `lease-${id}`), leaseId: `lease-${id}`, runner: "builder-1",
      branch: "b", worktree: "/w", provider: "codex", ...bareLegacy("build", "codex", null), now: T0,
    });
  };

  test("a codex turn with no thread.started and nothing to show is an init failure", async () => {
    const id = codexRunFor("t-init-1");
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: "", stderr: "error: bad config.toml" }),
    });
    expect(result.initFailed).toBe(true);
  });

  test("a completed turn without the init event is NOT an init failure — a renamed event must not read as broken", async () => {
    const id = codexRunFor("t-init-2");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fine" } });
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, stdout: jsonl }),
    });
    expect(result.initFailed).toBe(false);
  });

  test("a nonzero exit WITH an agent message is a failed turn, never an init failure (audit C-8)", async () => {
    const id = codexRunFor("t-init-4");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I tried and failed" } });
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: jsonl, stderr: "turn failed" }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.finalMessage).toBe("I tried and failed");
  });

  test("a timeout is a timeout, not an init failure — even with no init event seen", async () => {
    const id = codexRunFor("t-init-3");
    const result = await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: "", timedOut: true }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  test("claude gained the init signal with the streaming transport — an empty failed stream is an init failure", async () => {
    const result = await invokeRan(store, runId, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stderr: "exploded before the harness" }),
    });
    expect(result.initFailed).toBe(true);
  });

  test("an error result's prose never suppresses provider-init (arc 1 finding 15)", async () => {
    // A startup death that still emitted an origin-less error result: the
    // diagnostic text lands in finalMessage, but text is not an attempt.
    store.createTask({ id: "t-err", title: "w" }, T0);
    const errRun = store.startRun({
      taskRef: claimTask(store, "t-err", "lease-err"), leaseId: "lease-err", runner: "builder-1",
      branch: "b", worktree: "/w", provider: "claude", ...bareLegacy("build", "claude", null), now: T0,
    });
    const stream = JSON.stringify({
      type: "result", subtype: "error_during_execution", is_error: true,
      result: "credential rejected before any turn", session_id: "s-dead",
    });
    const result = await invokeRan(store, errRun, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: stream, stderr: "" }),
    });
    expect(result.finalMessage).toBe("credential rejected before any turn");
    expect(result.initFailed).toBe(true);
  });

  test("a present auth-mode file that says neither word is REFUSED at the spawn before any stamp — never the lenient subscription default (atomic authority closure)", async () => {
    // The C3 reproduction: claude.auth set to `not-a-mode` used to be read
    // leniently as `subscription`, so an ordinary approved scope spawned
    // under a credential nothing had proved. The strict reader refuses in
    // words, value-shaped, with no process and no start stamp.
    const home = mkdtempSync(join(tmpdir(), "so-auth-mode-"));
    try {
      mkdirSync(join(home, ".standing-orders", "keys"), { recursive: true });
      writeFileSync(join(home, ".standing-orders", "keys", "claude.auth"), "not-a-mode");
      let spawned = false;
      const result = await invokeAgent(store, runId, CLAUDE, ASK, {
        runner: async () => {
          spawned = true;
          return OK;
        },
        keyHome: home,
      });
      expect(result).toMatchObject({ kind: "refused", reason: "auth-mode", diagnostic: expect.stringContaining('says "not-a-mode", not subscription or api-key') });
      expect(spawned).toBe(false);
      expect(store.getRun(runId)?.providerStartedAt ?? null).toBeNull();
      // Restated, the same run spawns.
      writeFileSync(join(home, ".standing-orders", "keys", "claude.auth"), "subscription");
      const again = await invokeAgent(store, runId, CLAUDE, ASK, { runner: async () => OK, keyHome: home });
      expect(again.kind).toBe("ran");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the spawn leg refuses after a takeover between acquire and invoke — the lease is no longer current (runner-custody)", async () => {
    // The takeover: a new process registers the same name. register()
    // reclaims whatever the old holder had, so lease-1 stops being the
    // task's live claim — and the custody proof at the spawn stamp, not any
    // earlier check, is what notices.
    register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-rotated" });
    let spawned = false;
    const result = await invokeAgent(store, runId, CLAUDE, ASK, {
      runner: async () => {
        spawned = true;
        return OK;
      },
    });
    expect(result).toMatchObject({ kind: "refused", reason: "runner-custody" });
    // No process, no spend: the start stamp never landed.
    expect(spawned).toBe(false);
    expect(store.getRun(runId)?.providerStartedAt).toBeNull();
  });

  test("the spawn leg refuses a runner retired between acquire and invoke, even with the claim still live (runner-custody)", async () => {
    // Retirement releases nothing — the claim row stays live — so this pins
    // the retired-runner arm of the custody proof specifically, not a lease
    // side effect.
    const retired = retireRunnerIfCurrent(store, RUNNER, `tok-${RUNNER}`, T0);
    expect(retired).toMatchObject({ ok: true });
    let spawned = false;
    const result = await invokeAgent(store, runId, CLAUDE, ASK, {
      runner: async () => {
        spawned = true;
        return OK;
      },
    });
    expect(result).toMatchObject({ kind: "refused", reason: "runner-custody" });
    expect(spawned).toBe(false);
    expect(store.getRun(runId)?.providerStartedAt).toBeNull();
  });

  test("an observed init is never an init failure, whatever else went wrong", async () => {
    store.createTask({ id: "t-init-ok", title: "w" }, T0);
    const okRun = store.startRun({
      taskRef: claimTask(store, "t-init-ok", "lease-io"), leaseId: "lease-io", runner: "builder-1",
      branch: "b", worktree: "/w", provider: "claude", ...bareLegacy("build", "claude", null), now: T0,
    });
    const stream = JSON.stringify({ type: "system", subtype: "init", session_id: "s-up" });
    const result = await invokeRan(store, okRun, CLAUDE, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: stream, stderr: "died mid-turn" }),
    });
    expect(result.initFailed).toBe(false);
    expect(result.sessionId).toBe("s-up");
  });

  test("Claude init/result session disagreement is a typed provider-protocol refusal", async () => {
    store.createTask({ id: "t-session-conflict", title: "w" }, T0);
    const conflictRun = store.startRun({
      taskRef: claimTask(store, "t-session-conflict", "lease-session-conflict"),
      leaseId: "lease-session-conflict",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      provider: "claude",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-init" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-result",
        usage: { input_tokens: 11, output_tokens: 2 },
      }),
    ].join("\n");
    const result = await invokeAgent(store, conflictRun, CLAUDE, ASK, {
      runner: async (_file, _args, options) => {
        options?.onSessionId?.("s-init");
        return { ...OK, stdout: stream };
      },
    });
    expect(result).toMatchObject({
      kind: "refused",
      reason: "provider-protocol",
      diagnostic: expect.stringMatching(/different session ids/),
    });
    // Spend and the first announced identity remain durable, but neither
    // can pass this turn into a handoff or correction.
    expect(store.getRun(conflictRun)).toMatchObject({ sessionId: "s-init", tokensIn: 11, tokensOut: 2 });
  });

  test("conflicting Claude init events are a typed provider-protocol refusal", async () => {
    store.createTask({ id: "t-init-session-conflict", title: "w" }, T0);
    const conflictRun = store.startRun({
      taskRef: claimTask(store, "t-init-session-conflict", "lease-init-session-conflict"),
      leaseId: "lease-init-session-conflict",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      provider: "claude",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-first" }),
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-second" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-first",
        usage: { input_tokens: 17, output_tokens: 4 },
      }),
    ].join("\n");
    const result = await invokeAgent(store, conflictRun, CLAUDE, ASK, {
      runner: async (_file, _args, options) => {
        options?.onSessionId?.("s-first");
        options?.onSessionId?.("s-second");
        return { ...OK, stdout: stream };
      },
    });
    expect(result).toMatchObject({
      kind: "refused",
      reason: "provider-protocol",
      diagnostic: expect.stringMatching(/conflicting system\/init session ids/),
    });
    expect(store.getRun(conflictRun)).toMatchObject({ sessionId: "s-first", tokensIn: 17, tokensOut: 4 });
  });

  test("the callback and retained envelope reconcile through one trimmed durable identity", async () => {
    store.createTask({ id: "t-session-canonical", title: "w" }, T0);
    const canonicalRun = store.startRun({
      taskRef: claimTask(store, "t-session-canonical", "lease-session-canonical"),
      leaseId: "lease-session-canonical",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      provider: "claude",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "\t session-one " }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: " session-one\n",
      }),
    ].join("\n");
    const result = await invokeAgent(store, canonicalRun, CLAUDE, ASK, {
      runner: async (_file, _args, options) => {
        options?.onSessionId?.("  session-one  ");
        return { ...OK, stdout: stream };
      },
    });
    expect(result).toMatchObject({ kind: "ran", outcome: { sessionId: "session-one" } });
    expect(store.getRun(canonicalRun)?.sessionId).toBe("session-one");
  });

  test("a resume must match the session already bound to its run before spawn", async () => {
    store.stampRun(runId, { sessionId: "session-on-row" });
    let spawned = false;

    await expect(
      invokeAgent(store, runId, CLAUDE, { ...ASK, resumeSession: "session-on-argv" }, {
        runner: async () => {
          spawned = true;
          return OK;
        },
      }),
    ).rejects.toThrow(/records session session-on-row but was asked to resume session-on-argv/);

    expect(spawned).toBe(false);
    expect(store.getRun(runId)).toMatchObject({ sessionId: "session-on-row", providerStartedAt: null });
  });

  test("a resumed provider must return the exact durable session, never a fork", async () => {
    store.stampRun(runId, { sessionId: "session-original" });
    const forked = JSON.stringify({ result: "done", session_id: "session-forked" });

    const result = await invokeAgent(store, runId, CLAUDE, { ...ASK, resumeSession: "session-original" }, {
      runner: async (_file, _args, options) => {
        options?.onSessionId?.("session-forked");
        return { ...OK, stdout: forked };
      },
    });

    expect(result).toMatchObject({
      kind: "refused",
      reason: "provider-protocol",
      diagnostic: expect.stringMatching(/different from the exact identity recorded for resume/),
      finalMessage: "done",
    });
    expect(store.getRun(runId)?.sessionId).toBe("session-original");
  });

  test("a durable callback identity that differs from the retained envelope fails closed", async () => {
    store.createTask({ id: "t-session-durable-conflict", title: "w" }, T0);
    const durableRun = store.startRun({
      taskRef: claimTask(store, "t-session-durable-conflict", "lease-session-durable-conflict"),
      leaseId: "lease-session-durable-conflict",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      provider: "claude",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-from-envelope" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "session-from-envelope",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    ].join("\n");
    const result = await invokeAgent(store, durableRun, CLAUDE, ASK, {
      runner: async (_file, _args, options) => {
        options?.onSessionId?.("session-from-callback");
        return { ...OK, stdout: stream };
      },
    });
    expect(result).toMatchObject({
      kind: "refused",
      reason: "provider-protocol",
      diagnostic: expect.stringMatching(/transport callback/),
    });
    expect(store.getRun(durableRun)).toMatchObject({
      sessionId: "session-from-callback",
      tokensIn: 7,
      tokensOut: 3,
    });
  });

  test("an explicit failed terminal cannot become success through process exit 0", async () => {
    store.createTask({ id: "t-zero-failed", title: "w" }, T0);
    const failedRun = store.startRun({
      taskRef: claimTask(store, "t-zero-failed", "lease-zero-failed"),
      leaseId: "lease-zero-failed",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      provider: "claude",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "failed-session" }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "the turn failed",
        session_id: "failed-session",
        usage: { input_tokens: 13, output_tokens: 1 },
      }),
    ].join("\n");
    const result = await invokeAgent(store, failedRun, CLAUDE, ASK, {
      runner: async () => ({ ...OK, stdout: stream }),
    });
    expect(result).toMatchObject({
      kind: "refused",
      reason: "provider-protocol",
      diagnostic: expect.stringMatching(/failed terminal/),
    });
    expect(store.getRun(failedRun)).toMatchObject({ sessionId: "failed-session", tokensIn: 13, tokensOut: 1 });
  });

  test("a late Claude transport-overflow witness refuses an otherwise valid result without losing its usage", async () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-overflow-order" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-overflow-order",
        usage: { input_tokens: 23, output_tokens: 6 },
      }),
      JSON.stringify({
        type: "result",
        subtype: "standing-orders-stream-event-overflow",
        is_error: true,
        result: '{"type":"standing-orders.stream-event-overflow"}',
      }),
    ].join("\n");

    const result = await invokeAgent(store, runId, CLAUDE, ASK, {
      runner: async (_file, _args, options) => {
        options?.onSessionId?.("s-overflow-order");
        return { ...OK, stdout: stream };
      },
    });

    expect(result).toMatchObject({
      kind: "refused",
      reason: "provider-protocol",
      diagnostic: expect.stringMatching(/failed terminal/),
      finalMessage: "done",
    });
    expect(store.getRun(runId)).toMatchObject({ sessionId: "s-overflow-order", tokensIn: 23, tokensOut: 6 });
  });
});

describe("the attested gateway (Phase 3): gemini refusals are values", () => {
  let store: Store;
  let dir: string;
  let savedPath: string | undefined;

  const fakeGemini = (version: string): void => {
    const path = join(dir, "gemini");
    writeFileSync(path, `#!/bin/sh\necho "${version}"\n`);
    chmodSync(path, 0o755);
  };

  const geminiRun = (id: string): number => {
    store.createTask({ id, title: "w" }, T0);
    return store.startRun({
      taskRef: claimTask(store, id, `lease-${id}`), leaseId: `lease-${id}`, runner: "builder-1",
      branch: "b", worktree: "/w", provider: "gemini", ...bareLegacy("build", "gemini", null), now: T0,
    });
  };

  const GEMINI = { provider: "gemini" as const, model: "gemini-2.5-pro" };

  beforeEach(() => {
    store = openStore(":memory:");
    registerBuilder(store);
    dir = mkdtempSync(join(tmpdir(), "invoke-attest-"));
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${dir}:${savedPath ?? ""}`;
    resetAttestationCache();
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env["PATH"] = savedPath;
    rmSync(dir, { recursive: true, force: true });
    resetAttestationCache();
    store.close();
  });

  test("out of range: refused as a VALUE, version stamped, provider_started_at honestly NULL", async () => {
    fakeGemini("0.58.9");
    const runId = geminiRun("g-1");
    const result = await invokeAgent(store, runId, GEMINI, ASK, { runner: async () => OK });
    expect(result).toMatchObject({ kind: "refused", reason: "provider-unattested", providerVersion: "0.58.9" });
    const run = store.getRun(runId);
    expect(run?.providerVersion).toBe("0.58.9");
    expect(run?.providerStartedAt).toBeNull();
  });

  test("in range: the version rides the SAME pre-spawn durable write as the start stamp", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-2");
    let stampedAtSpawn: { version: string | null; started: string | null } | null = null;
    const stream = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 5, output_tokens: 5 } }),
    ].join("\n");
    const result = await invokeAgent(store, runId, GEMINI, ASK, {
      runner: async () => {
        const run = store.getRun(runId);
        stampedAtSpawn = { version: run?.providerVersion ?? null, started: run?.providerStartedAt ?? null };
        return { ...OK, stdout: stream };
      },
    });
    expect(result.kind).toBe("ran");
    expect(stampedAtSpawn).toMatchObject({ version: "0.57.0" });
    expect((stampedAtSpawn as unknown as { started: string | null }).started).not.toBeNull();
  });

  test("the terminal contract: exit 0 without the success terminal is provider-protocol, never a build", async () => {
    fakeGemini("0.57.0");
    const truncated = geminiRun("g-3");
    const initOnly = JSON.stringify({ type: "init", session_id: "s-1", model: "m" });
    const result = await invokeAgent(store, truncated, GEMINI, ASK, {
      runner: async () => ({ ...OK, stdout: initOnly }),
    });
    expect(result).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((result as { diagnostic: string }).diagnostic).toContain("success terminal");

    const dead = geminiRun("g-4");
    const noInit = await invokeAgent(store, dead, GEMINI, ASK, { runner: async () => OK });
    expect(noInit).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((noInit as { diagnostic: string }).diagnostic).toContain("initializing");
  });

  test("exit 0 with an error-status terminal: refused, and the spend was still recorded", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-5");
    const stream = [
      JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
      JSON.stringify({ type: "result", status: "error", error: { type: "X", message: "invalid stream" }, stats: { input_tokens: 7, output_tokens: 3 } }),
    ].join("\n");
    const result = await invokeAgent(store, runId, GEMINI, ASK, { runner: async () => ({ ...OK, stdout: stream }) });
    expect(result).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect(store.getRun(runId)).toMatchObject({ tokensIn: 7, tokensOut: 3 });
  });

  test("a nonzero exit keeps today's classification road — the contract gates only believed successes", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-6");
    const result = await invokeAgent(store, runId, GEMINI, ASK, {
      runner: async () => ({ ...OK, code: 41, stderr: "set an auth method" }),
    });
    expect(result.kind).toBe("ran");
    expect((result as { outcome: { initFailed: boolean } }).outcome.initFailed).toBe(true);
  });

  test("minted identity: stamped before spawn, and the init echo must MATCH it", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-7");
    const minted = "11111111-2222-4333-8444-555555555555";
    let sessionAtSpawn: string | null = null;
    const wrong = [
      JSON.stringify({ type: "init", session_id: "not-the-minted-one", model: "m" }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n");
    const result = await invokeAgent(store, runId, GEMINI, { ...ASK, startSessionId: minted }, {
      runner: async () => {
        sessionAtSpawn = store.getRun(runId)?.sessionId ?? null;
        return { ...OK, stdout: wrong };
      },
    });
    expect(sessionAtSpawn).toBe(minted);
    expect(result).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((result as { diagnostic: string }).diagnostic).toContain("different");

    const silent = geminiRun("g-8");
    const noId = [
      JSON.stringify({ type: "init", model: "m" }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n");
    const absent = await invokeAgent(store, silent, GEMINI, { ...ASK, startSessionId: minted }, {
      runner: async () => ({ ...OK, stdout: noId }),
    });
    expect(absent).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect((absent as { diagnostic: string }).diagnostic).toContain("without announcing");

    const honest = geminiRun("g-9");
    const echoed = [
      JSON.stringify({ type: "init", session_id: minted, model: "m" }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n");
    const good = await invokeAgent(store, honest, GEMINI, { ...ASK, startSessionId: minted }, {
      runner: async () => ({ ...OK, stdout: echoed }),
    });
    expect(good.kind).toBe("ran");
  });

  test("conflicting Gemini init ids are provider-protocol even when the first echoes the minted identity", async () => {
    fakeGemini("0.57.0");
    const runId = geminiRun("g-conflicting-init");
    const minted = "11111111-2222-4333-8444-555555555555";
    const stream = [
      JSON.stringify({ type: "init", session_id: minted, model: "m" }),
      JSON.stringify({ type: "init", session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", model: "m" }),
      JSON.stringify({ type: "synthetic_message", content: "done" }),
      JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 13, output_tokens: 2 } }),
    ].join("\n");

    const result = await invokeAgent(store, runId, GEMINI, { ...ASK, startSessionId: minted }, {
      runner: async () => ({ ...OK, stdout: stream }),
    });

    expect(result).toMatchObject({
      kind: "refused",
      reason: "provider-protocol",
      diagnostic: expect.stringMatching(/conflicting init session ids/),
      finalMessage: "done",
    });
    // The spend and plane-minted identity remain auditable, but neither
    // contradictory provider id becomes resumable authority.
    expect(store.getRun(runId)).toMatchObject({ sessionId: minted, tokensIn: 13, tokensOut: 2 });
  });

  test("tier-1 spawns never probe: claude runs with NO gemini on PATH at all", async () => {
    process.env["PATH"] = dir; // gemini absent, everything absent
    store.createTask({ id: "c-1", title: "w" }, T0);
    const runId = store.startRun({
      taskRef: claimTask(store, "c-1", "lease-c1"), leaseId: "lease-c1", runner: "builder-1",
      branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0,
    });
    const result = await invokeAgent(store, runId, CLAUDE, ASK, { runner: async () => OK });
    expect(result.kind).toBe("ran");
  });
});

describe("the terminal-class stamp (E2): honest disposal", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    registerBuilder(store);
  });
  afterEach(() => store.close());

  const codexRunFor = (id: string) => {
    store.createTask({ id, title: "w" }, T0);
    return store.startRun({
      taskRef: claimTask(store, id, `lease-${id}`), leaseId: `lease-${id}`, runner: "builder-1",
      branch: "b", worktree: "/w", provider: "codex", ...bareLegacy("build", "codex", null), now: T0,
    });
  };

  test("EVERY ran attempt is stamped with an auth mode and a terminal class", async () => {
    const id = codexRunFor("e2-ok");
    const jsonl = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fine" } });
    await invokeRan(store, id, { provider: "codex", model: null }, ASK, { runner: async () => ({ ...OK, stdout: jsonl }) });
    // Codex defaults to the subscription; a clean turn carries NO structural
    // failure terminal, so it classifies 'unknown'.
    expect(store.getRun(id)).toMatchObject({ authMode: "subscription", terminalClass: "unknown" });
  });

  test("a codex FAILED turn stamps not-exhausted — a usage-limit message is an ordinary failure", async () => {
    const id = codexRunFor("e2-fail");
    // A structural failure terminal (turn.failed) shaped exactly like a real
    // usage-limit message: an ordinary failure, nothing switches provider.
    const jsonl = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "You've hit your usage limit." } }),
      JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } }),
    ].join("\n");
    await invokeRan(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, code: 1, stdout: jsonl, stderr: "usage limit" }),
    });
    const run = store.getRun(id);
    expect(run?.terminalClass).toBe("not-exhausted");
    expect(run?.terminalClass).not.toBe("usage-exhausted");
    expect(run?.terminalClass).not.toBe("credits-depleted");
  });

  test("Codex turn.failed plus exit 0 is provider-protocol, never a successful result", async () => {
    const id = codexRunFor("e2-zero-fail");
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-failed-session" }),
      JSON.stringify({ type: "turn.failed", error: { message: "the model turn failed", type: "turn_failed" } }),
    ].join("\n");
    const result = await invokeAgent(store, id, { provider: "codex", model: null }, ASK, {
      runner: async () => ({ ...OK, stdout: jsonl }),
    });
    expect(result).toMatchObject({ kind: "refused", reason: "provider-protocol" });
    expect(store.getRun(id)).toMatchObject({ sessionId: "codex-failed-session", terminalClass: "not-exhausted" });
  });

  test("a refused-before-spawn attempt is NEVER classified — no process ran, terminal_class stays NULL", async () => {
    // A gemini out-of-range attestation refuses before any spawn: no
    // envelope, so no honest classification is possible.
    const dir = mkdtempSync(join(tmpdir(), "e2-attest-"));
    writeFileSync(join(dir, "gemini"), "#!/bin/sh\necho 0.1.0\n");
    chmodSync(join(dir, "gemini"), 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    resetAttestationCache();
    try {
      store.createTask({ id: "e2-refused", title: "w" }, T0);
      const id = store.startRun({
        taskRef: claimTask(store, "e2-refused", "lease-e2r"), leaseId: "lease-e2r", runner: "builder-1",
        branch: "b", worktree: "/w", provider: "gemini", ...bareLegacy("build", "gemini", null), now: T0,
      });
      const result = await invokeAgent(store, id, { provider: "gemini" as const, model: null }, ASK, { runner: async () => OK });
      expect(result.kind).toBe("refused");
      expect(store.getRun(id)?.terminalClass ?? null).toBeNull();
    } finally {
      process.env["PATH"] = savedPath;
      resetAttestationCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the architecture rule", () => {
  /**
   * The zero-token invariant is only enforceable if there is exactly one
   * place that can start an LLM. Provider IDS are ordinary words that
   * legitimately appear in config, schema, and UI — so the boundary is
   * asserted on IMPORTS, not string literals (Codex provider review, Q1):
   * only invoke.ts may import the registry's spawning surface, and only
   * builder/planner/scout may import the gateway itself. The retired
   * reviewer must remain unable to spend.
   */
  test("only the gateway imports the spawning surface; only builder, planner, scout and the one build review spend", () => {
    const src = join(process.cwd(), "src");
    const spawners: string[] = [];
    const invokers: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(src, name), "utf8");
      if (name !== "invoke.ts" && name !== "provider.ts" && /\badapterFor\b/.test(text)) {
        spawners.push(name);
      }
      if (name !== "invoke.ts" && /\binvokeAgent\b/.test(text)) {
        invokers.push(name);
      }
    }
    expect(spawners).toEqual([]);
    // build-review.ts: the one automatic read-only review per build, admitted through admitReview's run and budget.
    expect(invokers.sort()).toEqual(["build-review.ts", "builder.ts", "planner.ts", "scout.ts"]);
  });
});
