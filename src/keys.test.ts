/**
 * Managed provider keys: 0600 files, write-only surfaces, and the
 * gateway injection that hands a key to exactly its own provider's
 * process — composed with the foreign-credential strip proved in the
 * provider suite.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { openStore, type Store } from "./store.js";
import { saveProviderKey, readProviderKey, clearProviderKey, keyStatus, keyFileFor, verifyProviderKey, verdictWords, readAuthMode, readAuthModeStrict, setAuthMode, PROVIDER_KEY_ENV, OWN_KEY_ENV } from "./keys.js";
import { invokeAgent, invokeHeldAgent } from "./invoke.js";
import { runOperate } from "./operate.js";
import { register } from "./runner.js";
import { acquire, release } from "./claim.js";
import type { RunOptions } from "./exec.js";
import { fakePid } from "../test/fake-pid.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-29T12:00:00.000Z");
/** Long enough that the lease is unexpired at every clock a test uses. */
const TTL = 10 * 365 * 24 * 3600 * 1000;
const REPO = "/repo/keys";

describe("the key files", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "so-keys-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("round trip: 0600 file, trimmed value, status without bytes", () => {
    const saved = saveProviderKey("gemini", "  AIzaFakeKeyForTesting123  \n", home);
    expect(saved.ok).toBe(true);
    expect(readProviderKey("gemini", home)).toBe("AIzaFakeKeyForTesting123");
    const mode = statSync(keyFileFor("gemini", home)).mode & 0o777;
    expect(mode).toBe(0o600);
    const status = keyStatus("gemini", home);
    expect(status.set).toBe(true);
    expect(status.updatedAt).not.toBeNull();
    expect(JSON.stringify(status)).not.toContain("AIza");
    // Clear releases; a second clear says so.
    expect(clearProviderKey("gemini", home)).toBe(true);
    expect(clearProviderKey("gemini", home)).toBe(false);
    expect(readProviderKey("gemini", home)).toBeNull();
    expect(keyStatus("gemini", home).set).toBe(false);
  });

  test("implausible pastes refuse: whitespace inside, control bytes, too short", () => {
    expect(saveProviderKey("gemini", "short", home)).toEqual({ ok: false, reason: "implausible" });
    expect(saveProviderKey("gemini", "a key with spaces inside it", home)).toEqual({ ok: false, reason: "implausible" });
    expect(saveProviderKey("gemini", "key\u0000withnull-and-length", home)).toEqual({ ok: false, reason: "implausible" });
    expect(keyStatus("gemini", home).set).toBe(false);
    // A corrupted file on disk reads as no key, never as a broken spawn.
    saveProviderKey("gemini", "AIzaValidThenCorrupted99", home);
    writeFileSync(keyFileFor("gemini", home), "two words", { mode: 0o600 });
    expect(readProviderKey("gemini", home)).toBeNull();
  });
});

describe("live key verification (no tokens, injectable fetcher)", () => {
  const stubFetch = (status: number, body = "", throws = false): typeof fetch =>
    (async (_url: string, init?: { headers?: Record<string, string> }) => {
      if (throws) throw new Error("network down");
      // The gemini key must ride the HEADER, never the URL (finding 6).
      if (typeof _url === "string" && _url.includes("generativelanguage")) {
        if (_url.includes("key=")) throw new Error("key leaked into the URL");
      }
      void init;
      return { status, text: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;

  test("200 works; 401/403 reject; a 400 rejects ONLY when the body names the key; a throw is unreachable", async () => {
    expect(await verifyProviderKey("gemini", "AIzaPlausibleKeyValue123", stubFetch(200))).toEqual({ ok: true });
    expect(await verifyProviderKey("codex", "sk-PlausibleKeyValue123", stubFetch(401))).toEqual({ ok: false, reason: "rejected", status: 401 });
    expect(await verifyProviderKey("openrouter", "sk-or-PlausibleKeyValue1", stubFetch(403))).toEqual({ ok: false, reason: "rejected", status: 403 });
    // A 400 whose body names an API-key failure is a rejection...
    expect(await verifyProviderKey("gemini", "AIzaPlausibleKeyValue123", stubFetch(400, "API key not valid. Please pass a valid API key."))).toEqual({ ok: false, reason: "rejected", status: 400 });
    // ...but a 400 that is NOT about the key reads as unexpected, never a false rejection.
    expect(await verifyProviderKey("gemini", "AIzaPlausibleKeyValue123", stubFetch(400, "malformed page size"))).toEqual({ ok: false, reason: "unexpected", status: 400 });
    // Even a body that MENTIONS the key without a negative marker is not a rejection (round 3, finding 6).
    expect(await verifyProviderKey("gemini", "AIzaPlausibleKeyValue123", stubFetch(400, "API key accepted; malformed page size"))).toEqual({ ok: false, reason: "unexpected", status: 400 });
    expect(await verifyProviderKey("claude", "sk-ant-PlausibleKeyValue", stubFetch(500))).toEqual({ ok: false, reason: "unexpected", status: 500 });
    expect(await verifyProviderKey("gemini", "AIzaPlausibleKeyValue123", stubFetch(0, "", true))).toEqual({ ok: false, reason: "unreachable" });
  });

  test("the gemini key travels in the x-goog-api-key header, not the URL", async () => {
    let sawHeader: string | undefined;
    let sawUrl = "";
    const spy = (async (url: string, init?: { headers?: Record<string, string> }) => {
      sawUrl = url;
      sawHeader = init?.headers?.["x-goog-api-key"];
      return { status: 200, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    await verifyProviderKey("gemini", "AIzaSecretKeyValue12345", spy);
    expect(sawHeader).toBe("AIzaSecretKeyValue12345");
    expect(sawUrl).not.toContain("AIzaSecretKeyValue12345");
  });

  test("an implausible value is rejected without a network call", async () => {
    let called = false;
    const spy = (async () => { called = true; return { status: 200, text: async () => "" } as unknown as Response; }) as unknown as typeof fetch;
    expect(await verifyProviderKey("gemini", "short", spy)).toEqual({ ok: false, reason: "rejected", status: 0 });
    expect(called).toBe(false);
  });

  test("verdict words never carry the key and name the actionable difference", () => {
    expect(verdictWords("gemini", { ok: true })).not.toContain("AIza");
    expect(verdictWords("gemini", { ok: false, reason: "rejected", status: 400 })).toContain("rejected");
    expect(verdictWords("gemini", { ok: false, reason: "unreachable" })).toContain("reach");
  });
});

describe("the keys CLI: auth switching works and preserves the key (round 4, finding 1)", () => {
  let home: string;
  let priorHome: string | undefined;
  const lines: string[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "so-keys-cli-"));
    priorHome = process.env["HOME"];
    process.env["HOME"] = home; // keys.ts default home resolves here
    lines.length = 0;
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = priorHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("keys auth <provider> <mode> actually changes the mode (the destructuring bug)", async () => {
    saveProviderKey("claude", "sk-ant-KeptAcrossSwitches9", home);
    // The bug: `keys auth claude api-key` used to always return usage.
    const code = await runOperate("keys", ["auth", "claude", "api-key"], l => lines.push(l), { databaseFile: join(home, "db.sqlite"), now: T0 });
    expect(code).toBe(0);
    expect(readAuthMode("claude", home)).toBe("api-key");
    // The stored key survived the switch — it is the retained fallback.
    expect(readProviderKey("claude", home)).toBe("sk-ant-KeptAcrossSwitches9");
    // And back.
    await runOperate("keys", ["auth", "claude", "subscription"], l => lines.push(l), { databaseFile: join(home, "db.sqlite"), now: T0 });
    expect(readAuthMode("claude", home)).toBe("subscription");
    expect(readProviderKey("claude", home)).toBe("sk-ant-KeptAcrossSwitches9");
  });

  test("keys auth refuses subscription for openrouter (api-key only)", async () => {
    const code = await runOperate("keys", ["auth", "openrouter", "subscription"], l => lines.push(l), { databaseFile: join(home, "db.sqlite"), now: T0 });
    expect(code).not.toBe(0);
    expect(readAuthMode("openrouter", home)).toBe("api-key");
  });
});

describe("auth mode: subscription first, key as fallback", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "so-authmode-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("the strict read (raw authority repair): an absent file is the default, a stored word is that word, and a file that says neither is a stated problem — never the subscription default", () => {
    expect(readAuthModeStrict("claude", home)).toEqual({ ok: true, mode: "subscription" });
    expect(readAuthModeStrict("gemini", home)).toEqual({ ok: true, mode: "api-key" });
    expect(setAuthMode("claude", "api-key", home)).toEqual({ ok: true });
    expect(readAuthModeStrict("claude", home)).toEqual({ ok: true, mode: "api-key" });
    writeFileSync(join(home, ".toolroll", "keys", "claude.auth"), "bogus\n");
    // The lenient reader coerces; the strict one refuses in words.
    expect(readAuthMode("claude", home)).toBe("subscription");
    expect(readAuthModeStrict("claude", home)).toMatchObject({ ok: false, problem: expect.stringContaining('says "bogus", not subscription or api-key') });
    // A provider with no subscription login is the key whatever the file says.
    writeFileSync(join(home, ".toolroll", "keys", "openrouter.auth"), "subscription");
    expect(readAuthModeStrict("openrouter", home)).toEqual({ ok: true, mode: "api-key" });
    // A file its permissions make unreadable is a stated problem too (only the agents' fence, EPERM, reads as absent).
    writeFileSync(join(home, ".toolroll", "keys", "claude.auth"), "api-key");
    chmodSync(join(home, ".toolroll", "keys", "claude.auth"), 0o000);
    if (process.getuid?.() !== 0) expect(readAuthModeStrict("claude", home)).toMatchObject({ ok: false, problem: expect.stringContaining("cannot be read (EACCES)") });
  });

  test("defaults: claude/codex subscription, gemini/openrouter api-key; openrouter cannot go subscription", () => {
    expect(readAuthMode("claude", home)).toBe("subscription");
    expect(readAuthMode("codex", home)).toBe("subscription");
    expect(readAuthMode("gemini", home)).toBe("api-key");
    expect(readAuthMode("openrouter", home)).toBe("api-key");
    expect(setAuthMode("openrouter", "subscription", home)).toEqual({ ok: false, reason: "no-subscription" });
    expect(readAuthMode("openrouter", home)).toBe("api-key"); // unchanged
  });

  test("switching persists and round-trips; the key is untouched by a mode change", () => {
    saveProviderKey("claude", "sk-ant-StoredFallbackKey12", home);
    expect(setAuthMode("claude", "api-key", home)).toEqual({ ok: true });
    expect(readAuthMode("claude", home)).toBe("api-key");
    expect(setAuthMode("claude", "subscription", home)).toEqual({ ok: true });
    expect(readAuthMode("claude", home)).toBe("subscription");
    // The stored key survived both switches — it is the retained fallback.
    expect(readProviderKey("claude", home)).toBe("sk-ant-StoredFallbackKey12");
  });
});

describe("the gateway injection", () => {
  let home: string;
  let store: Store;
  let runId: number;
  let priorPath: string | undefined;

  /** The runner gate's spawn leg (MCP spec v6): before any spawn the run's
   * runner must be registered against the task's repo, the task placed,
   * and the run's lease the task's CURRENT live claim — so every run a
   * test hands to the gateway gets a real claim, and a later run on the
   * same task releases the previous lease first. */
  const claimT1 = (leaseId: string) => {
    const ref = store.refFor("built-in", "t-1").id;
    const took = acquire(store, ref, "b-1", { now: T0, token: "tok-b-1", newLeaseId: () => leaseId, ttlMs: TTL });
    if (!took.ok) throw new Error(`fixture claim refused: ${took.reason}`);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "so-keys-inject-"));
    // Gemini is a tier-2 provider: the real gateway resolves and attests its
    // executable before spawning. Keep this unit fixture hermetic instead of
    // silently depending on a developer (or CI image) having Gemini installed.
    const bin = join(home, "bin");
    mkdirSync(bin);
    const gemini = join(bin, "gemini");
    writeFileSync(gemini, "#!/bin/sh\necho 0.57.0\n");
    chmodSync(gemini, 0o755);
    priorPath = process.env["PATH"];
    process.env["PATH"] = `${bin}${delimiter}${priorPath ?? ""}`;
    store = openStore(":memory:");
    register(store, { name: "b-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-b-1" });
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    store.placeTask(ref, REPO);
    claimT1("l-1");
    runId = store.startRun({
      taskRef: ref,
      leaseId: "l-1",
      runner: "b-1",
      branch: "b",
      worktree: "/w",
      provider: "gemini",
      ...bareLegacy("build", "gemini", null), now: T0,
    });
  });
  afterEach(() => {
    store.close();
    if (priorPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = priorPath;
    rmSync(home, { recursive: true, force: true });
  });

  test("a stored key reaches its own provider's child env; foreign strips still apply", async () => {
    saveProviderKey("gemini", "AIzaFakeKeyForTesting123", home);
    let seen: RunOptions | undefined;
    const runner = async (_file: string, _args: readonly string[], options?: RunOptions) => {
      seen = options;
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: "init", session_id: "s-1", model: "m" }),
          JSON.stringify({ type: "synthetic_message", content: "done" }),
          JSON.stringify({ type: "result", status: "success" }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        notFound: false,
      };
    };
    const result = await invokeAgent(
      store,
      runId,
      { provider: "gemini", model: "gemini-2.5-pro" },
      { phase: "build", brief: "do it", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession: null, startSessionId: "s-1" },
      { cwd: home, timeoutMs: 30_000, runner, keyHome: home, clock: () => T0 },
    );
    expect(result.kind).toBe("ran");
    expect(seen?.env?.[PROVIDER_KEY_ENV.gemini]).toBe("AIzaFakeKeyForTesting123");
    // The adapter's own strip list still sheds everyone else's keys.
    expect(seen?.omitEnv).toContain("ANTHROPIC_API_KEY");
    expect(seen?.omitEnv).toContain("OPENAI_API_KEY");
    expect(seen?.omitEnv).toContain("OPENROUTER_API_KEY");
    expect(seen?.omitEnv).not.toContain("GEMINI_API_KEY");
  });

  test("no managed key falls back to the ambient env — real, not merely claimed (finding 5)", async () => {
    let seen: RunOptions | undefined;
    const runner = async (_file: string, _args: readonly string[], options?: RunOptions) => {
      seen = options;
      return { code: 1, stdout: "", stderr: "no auth", timedOut: false, notFound: false };
    };
    const invoke = () =>
      invokeAgent(
        store,
        runId,
        { provider: "gemini", model: "gemini-2.5-pro" },
        { phase: "build", brief: "do it", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession: null, startSessionId: "s-1" },
        { cwd: home, timeoutMs: 30_000, runner, keyHome: home, clock: () => T0 },
      );
    // No managed key AND no ambient var: nothing injected.
    const priorEnv = process.env[PROVIDER_KEY_ENV.gemini];
    delete process.env[PROVIDER_KEY_ENV.gemini];
    try {
      await invoke();
      expect(seen?.env?.[PROVIDER_KEY_ENV.gemini]).toBeUndefined();
      // Ambient var present, no managed file: the gateway re-supplies it,
      // so a key that lives only in the environment still authenticates.
      process.env[PROVIDER_KEY_ENV.gemini] = "AIzaAmbientFallbackValue1";
      // The run row is spent after the first invoke; open a fresh one — and
      // the new run's lease must be the task's CURRENT claim, so l-1 is
      // handed back before l-2 is taken.
      release(store, "l-1", T0);
      claimT1("l-2");
      const ref2 = store.refFor("built-in", "t-1").id;
      const run2 = store.startRun({ taskRef: ref2, leaseId: "l-2", runner: "b-1", branch: "b2", worktree: "/w2", provider: "gemini", ...bareLegacy("build", "gemini", null), now: T0 });
      await invokeAgent(
        store,
        run2,
        { provider: "gemini", model: "gemini-2.5-pro" },
        { phase: "build", brief: "do it", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession: null, startSessionId: "s-2" },
        { cwd: home, timeoutMs: 30_000, runner, keyHome: home, clock: () => T0 },
      );
      expect(seen?.env?.[PROVIDER_KEY_ENV.gemini]).toBe("AIzaAmbientFallbackValue1");
    } finally {
      if (priorEnv === undefined) delete process.env[PROVIDER_KEY_ENV.gemini];
      else process.env[PROVIDER_KEY_ENV.gemini] = priorEnv;
    }
  });

  test("a managed key WINS over the ambient env", async () => {
    saveProviderKey("gemini", "AIzaManagedWinsValue12345", home);
    const prior = process.env[PROVIDER_KEY_ENV.gemini];
    process.env[PROVIDER_KEY_ENV.gemini] = "AIzaAmbientLoserValue1234";
    let seen: RunOptions | undefined;
    const runner = async (_file: string, _args: readonly string[], options?: RunOptions) => {
      seen = options;
      return { code: 1, stdout: "", stderr: "", timedOut: false, notFound: false };
    };
    try {
      await invokeAgent(
        store,
        runId,
        { provider: "gemini", model: "gemini-2.5-pro" },
        { phase: "build", brief: "do it", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession: null, startSessionId: "s-1" },
        { cwd: home, timeoutMs: 30_000, runner, keyHome: home, clock: () => T0 },
      );
      expect(seen?.env?.[PROVIDER_KEY_ENV.gemini]).toBe("AIzaManagedWinsValue12345");
    } finally {
      if (prior === undefined) delete process.env[PROVIDER_KEY_ENV.gemini];
      else process.env[PROVIDER_KEY_ENV.gemini] = prior;
    }
  });

  test("subscription mode STRIPS the provider's own key so the login wins, even with a key stored", async () => {
    // claude with a stored key but subscription mode (the default): the
    // key is NOT injected, and its env name is stripped so an ambient one
    // cannot force API billing over the subscription.
    saveProviderKey("claude", "sk-ant-StoredButSubscription", home);
    const prior = process.env[PROVIDER_KEY_ENV.claude];
    process.env[PROVIDER_KEY_ENV.claude] = "sk-ant-AmbientAlsoIgnored12";
    let seen: RunOptions | undefined;
    const runner = async (_f: string, _a: readonly string[], options?: RunOptions) => {
      seen = options;
      return { code: 1, stdout: "", stderr: "", timedOut: false, notFound: false };
    };
    release(store, "l-1", T0); // the new run's lease must be the current claim
    claimT1("l-c");
    const claudeRun = store.startRun({ taskRef: store.refFor("built-in", "t-1").id, leaseId: "l-c", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", ...bareLegacy("build", "claude", null), now: T0 });
    try {
      await invokeAgent(
        store, claudeRun, { provider: "claude", model: "sonnet" },
        { phase: "build", brief: "x", maxTurns: 5, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null, startSessionId: "s-c" },
        { cwd: home, timeoutMs: 30_000, runner, keyHome: home, clock: () => T0 },
      );
      expect(seen?.env?.[PROVIDER_KEY_ENV.claude]).toBeUndefined(); // not injected
      expect(seen?.omitEnv).toContain(PROVIDER_KEY_ENV.claude); // and stripped
    } finally {
      if (prior === undefined) delete process.env[PROVIDER_KEY_ENV.claude];
      else process.env[PROVIDER_KEY_ENV.claude] = prior;
    }
  });

  test("switching claude to api-key mode injects the stored key", async () => {
    saveProviderKey("claude", "sk-ant-NowUsingTheKey123", home);
    setAuthMode("claude", "api-key", home);
    let seen: RunOptions | undefined;
    const runner = async (_f: string, _a: readonly string[], options?: RunOptions) => {
      seen = options;
      return { code: 1, stdout: "", stderr: "", timedOut: false, notFound: false };
    };
    release(store, "l-1", T0); // the new run's lease must be the current claim
    claimT1("l-c2");
    const claudeRun = store.startRun({ taskRef: store.refFor("built-in", "t-1").id, leaseId: "l-c2", runner: "b-1", branch: "b2", worktree: "/w2", provider: "claude", ...bareLegacy("build", "claude", null), now: T0 });
    await invokeAgent(
      store, claudeRun, { provider: "claude", model: "sonnet" },
      { phase: "build", brief: "x", maxTurns: 5, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null, startSessionId: "s-c2" },
      { cwd: home, timeoutMs: 30_000, runner, keyHome: home, clock: () => T0 },
    );
    expect(seen?.env?.[PROVIDER_KEY_ENV.claude]).toBe("sk-ant-NowUsingTheKey123");
    expect(seen?.omitEnv).not.toContain(PROVIDER_KEY_ENV.claude);
  });

  test("held claude honors subscription mode: no key handed to the held session (finding 5)", async () => {
    saveProviderKey("claude", "sk-ant-HeldButSubscription9", home);
    const prior = process.env[PROVIDER_KEY_ENV.claude];
    process.env[PROVIDER_KEY_ENV.claude] = "sk-ant-AmbientHeldIgnored12";
    let seen: Record<string, unknown> | undefined;
    const starter = (async (_file: string, _argv: readonly string[], options: Record<string, unknown>) => {
      seen = options;
      return { pid: fakePid(1), socketPath: "/tmp/x", waitUntilReady: async () => ({ ready: true as const }) };
    }) as unknown as Parameters<typeof invokeHeldAgent>[4]["starter"];
    release(store, "l-1", T0); // the new run's lease must be the current claim
    claimT1("l-h");
    const heldRun = store.startRun({ taskRef: store.refFor("built-in", "t-1").id, leaseId: "l-h", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", ...bareLegacy("build", "claude", null), now: T0 });
    try {
      await invokeHeldAgent(
        store, heldRun, { provider: "claude", model: "sonnet" }, ["-p"],
        { socketPath: "/tmp/x", cookie: "c", keyHome: home, clock: () => T0, starter },
      );
      const env = seen?.["env"] as Record<string, string> | undefined;
      const omit = seen?.["omitEnv"] as string[] | undefined;
      expect(env?.[PROVIDER_KEY_ENV.claude]).toBeUndefined(); // not injected
      expect(omit).toContain(PROVIDER_KEY_ENV.claude); // stripped so login wins
    } finally {
      if (prior === undefined) delete process.env[PROVIDER_KEY_ENV.claude];
      else process.env[PROVIDER_KEY_ENV.claude] = prior;
    }
  });

  test("the gateway drops a minted start id when resuming — resume XOR mint (finding 3)", async () => {
    saveProviderKey("gemini", "AIzaResumeXorMintValue12", home);
    // Resume authority lives on the run before the gateway can spawn. The
    // conflicting start id below is still intentionally supplied so this
    // fixture continues to prove that resume wins and the mint is dropped.
    store.stampRun(runId, { sessionId: "built-session" });
    const prior = process.env[PROVIDER_KEY_ENV.gemini];
    delete process.env[PROVIDER_KEY_ENV.gemini];
    const runner = async () => ({
      code: 0,
      stdout: [JSON.stringify({ type: "init", session_id: "built-session" }), JSON.stringify({ type: "result", status: "success" })].join("\n"),
      stderr: "",
      timedOut: false,
      notFound: false,
    });
    try {
      // Resume AND a minted id both supplied: the gateway must NOT stamp the
      // minted id, so the envelope's own session id is not judged against it.
      const result = await invokeAgent(
        store,
        runId,
        { provider: "gemini", model: "gemini-2.5-pro" },
        { phase: "repair", brief: "fix", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession: "built-session", startSessionId: "unused-mint" },
        { cwd: home, timeoutMs: 30_000, runner, keyHome: home, clock: () => T0 },
      );
      // The stamped id is never the dropped mint, AND the run RAN — no
      // protocol refusal formed from validating an id that was suppressed
      // (round 3, finding 3): both "not stamped" and "not validated".
      expect(store.getRun(runId)?.sessionId).not.toBe("unused-mint");
      expect(result.kind).toBe("ran");
    } finally {
      if (prior === undefined) delete process.env[PROVIDER_KEY_ENV.gemini];
      else process.env[PROVIDER_KEY_ENV.gemini] = prior;
    }
  });
});
