/**
 * Sign-in pauses: an agent whose sign-in (or API key) stopped working is
 * classified `auth-expired`, takes no strike and no retry, requeues its task,
 * pauses dispatch for that provider only, tells a person exactly once per
 * incident on every connected channel, and lifts on the next working run,
 * sign-in check, or a person's resume — with one short "signed in again".
 * Scripted transports only; no live provider, Telegram or Slack is claimed.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { classifyTerminal, isFallbackEligible, isAuthFailure } from "./exhaustion.js";
import { acquire, finalizeFailureFenced, finalizePlanFailureFenced } from "./claim.js";
import { register } from "./runner.js";
import { invokeAgent } from "./invoke.js";
import { addApprover } from "./scope.js";
import { AUTH_TRIAL_MS, authPauseOf, authWaitOf, claimAuthTrial, giveBackAuthTrial, liftAuthPause, noteSignInProbe, openAuthPauses, pauseForAuth, signInGate, signInNotices } from "./provider-auth.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { workIndexPage } from "./work-index.js";
import { installationStatus, renderInstallationStatus } from "./lead-status.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { ChatState, chatHash } from "./chat-delivery-state.js";
import { deliverSlackPart, planSlackNotifications, type SlackChatOptions } from "./slack-chat.js";
import type { SlackApi } from "./slack-api.js";

const T0 = new Date("2026-09-29T21:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const REPO = "/test/auth-project";
const RUNNER = "builder-1";
const TTL = 10 * 365 * 24 * 3600 * 1000;
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const ASK = { phase: "build" as const, brief: "hi", maxTurns: 10, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null };
const legacy = (provider: string, phase: "build" | "plan" = "build") => ({ route: { routeDigest: "legacy", phase, provider, model: null, chosen: "legacy" as const } });
const CLAUDE_EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";
const claude = (text: string | null, failed = true) => classifyTerminal({ provider: "claude", version: null, authMode: "subscription", terminal: { failed, text, code: failed ? "error_during_execution" : "success" } });

describe("c1: the auth-expired class", () => {
  test("Claude, Codex, Gemini and API-key sign-in failures classify as auth-expired for any provider or version", () => {
    expect(claude(CLAUDE_EXPIRED)).toBe("auth-expired");
    expect(claude("Invalid API key · Please run /login")).toBe("auth-expired");
    expect(claude("OAuth token has expired. Please obtain a new token or refresh your existing token.")).toBe("auth-expired");
    // An API key the provider refuses, on an API-key account.
    const revoked = ["API Error: 401", JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })].join(" ");
    expect(classifyTerminal({ provider: "claude", version: "2.1.0", authMode: "api-key", terminal: { failed: true, text: revoked, code: null } })).toBe("auth-expired");
    expect(classifyTerminal({ provider: "openrouter", version: null, authMode: "api-key", terminal: { failed: true, text: "The API key is revoked", code: null } })).toBe("auth-expired");
    // Codex's typed failure terminal and its plain 401.
    expect(classifyTerminal({ provider: "codex", version: "0.145.0", authMode: "subscription", terminal: { failed: true, text: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", code: null } })).toBe("auth-expired");
    // A CLI that is not logged in exits within seconds before its stream starts: its stderr counts.
    expect(classifyTerminal({ provider: "codex", version: null, authMode: "subscription", terminal: null, earlyExit: "Not logged in. Run `codex login` first." })).toBe("auth-expired");
    expect(isFallbackEligible("auth-expired")).toBe(false);
  });

  test("an ordinary failure still classifies exactly as before", () => {
    expect(claude("The tests failed: 3 assertions did not hold.")).toBe("not-exhausted");
    expect(classifyTerminal({ provider: "codex", version: "1.0.0", authMode: "subscription", terminal: { failed: true, text: "You've hit your usage limit. Try again later.", code: "usage_limit_reached" } })).toBe("not-exhausted");
    expect(claude("anything", false)).toBe("unknown");
    expect(classifyTerminal({ provider: "claude", version: null, authMode: "subscription", terminal: null })).toBe("unknown");
    // Early-exit words that are not about signing in change nothing.
    expect(classifyTerminal({ provider: "claude", version: null, authMode: "subscription", terminal: null, earlyExit: "error: unknown option --frobnicate" })).toBe("unknown");
    expect(isAuthFailure("process exited with code 1 after 401 lines of output were written")).toBe(false);
  });

  test("a build's own output about logins and 401s is never the agent's sign-in", () => {
    // What an agent building a login feature, or its tests, prints (review H2).
    for (const text of ["Please log in", "Please login to continue", "user is not logged in", "status: 401", "HTTP 401 returned from /api/me",
      "received 401 Unauthorized", "run codex login first", "expected the page to say Please sign in"]) {
      expect(isAuthFailure(text), text).toBe(false);
    }
    // Early exit reads stderr and plain lines, never a JSON event's command output.
    expect(classifyTerminal({ provider: "codex", version: null, authMode: "subscription", terminal: null, earlyExit: "3 failed: Please log in expected" })).toBe("unknown");
  });
});

describe("sign-in pauses", () => {
  let store: Store;
  let serial = 0;
  beforeEach(() => {
    store = openStore(":memory:");
    register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => `tok-${RUNNER}` });
    // The instance operator: sign-in messages are addressed to them.
    expect(addApprover(store, "alex", T0).ok).toBe(true);
    serial = 0;
  });
  afterEach(() => store.close());

  /** An open, claimed builder attempt on `provider` for a placed task. */
  const attempt = (taskId: string, provider = "claude", role: "builder" | "planner" = "builder") => {
    if (store.getTask(taskId) === null) store.createTask({ id: taskId, title: taskId }, T0);
    const ref = store.refFor("built-in", taskId).id;
    store.placeTask(ref, REPO);
    const lease = `lease-${++serial}`;
    const took = acquire(store, ref, RUNNER, { now: T0, token: `tok-${RUNNER}`, newLeaseId: () => lease, ttlMs: TTL });
    if (!took.ok) throw new Error(`claim refused: ${took.reason}`);
    const runId = store.startRun({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "b", worktree: "/w", provider, role, ...legacy(provider, role === "planner" ? "plan" : "build"), now: T0 });
    return { ref, lease, runId };
  };
  const failAuth = (taskId: string, provider = "claude", now = at(1_000)) => {
    const one = attempt(taskId, provider);
    store.stampTerminalClass(one.runId, "subscription", "auth-expired");
    const sealed = finalizeFailureFenced(store, { leaseId: one.lease, runId: one.runId, taskId, failureClass: "unknown", message: CLAUDE_EXPIRED, worktree: "/w", now });
    return { ...one, sealed };
  };
  const authNotices = () => store.handle.prepare("SELECT dedupe_key, kind, subject, body FROM notification WHERE kind IN ('auth-expired', 'auth-restored') ORDER BY id").all();

  test("c2: an auth-expired run takes no strike and no retry, requeues its task, and pauses only its provider", () => {
    const { ref, runId, sealed } = failAuth("t-1");
    expect(sealed).toEqual({ ok: true, disposition: "auth-expired", provider: "claude" });
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "auth-expired" });
    expect(store.lookupRef("t-1")?.strikes).toBe(0);
    expect(store.activeHold(ref, at(2_000))).toBeNull();
    expect(store.getTask("t-1")?.state).toBe("queued");
    expect(store.hasLiveClaim(ref, at(2_000))).toBe(false);
    // No retry notice: the incident's own message is the only one.
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'build-failed'").get()?.["n"]).toBe(0);
    expect(authPauseOf(store, "claude")).toMatchObject({ provider: "claude", runs: 1 });
    expect(authPauseOf(store, "codex")).toBeNull();

    // The same failure on a planner is not a planning strike either.
    const plan = attempt("t-plan", "claude", "planner");
    store.stampTerminalClass(plan.runId, "subscription", "auth-expired");
    expect(finalizePlanFailureFenced(store, { leaseId: plan.lease, runId: plan.runId, taskId: "t-plan", kind: "failure", message: CLAUDE_EXPIRED, now: at(1_500) })).toMatchObject({ ok: true, disposition: "auth-expired" });
    expect(store.refForId(plan.ref)?.planStrikes ?? 0).toBe(0);

    // An ordinary failure beside it still strikes and backs off, as before.
    const other = attempt("t-2", "codex");
    const ordinary = finalizeFailureFenced(store, { leaseId: other.lease, runId: other.runId, taskId: "t-2", failureClass: "unknown", message: "tests failed", worktree: "/w", now: at(1_000) });
    expect(ordinary).toMatchObject({ ok: true, disposition: "backoff", strikes: 1 });
  });

  test("c2: the task says plainly that the provider needs a sign-in; a task on another provider does not", () => {
    failAuth("t-1");
    store.createTask({ id: "t-codex", title: "codex work" }, T0);
    store.placeTask(store.refFor("built-in", "t-codex").id, REPO);
    const claudeTask = diagnoseTaskDispatch(store, "t-1", at(2_000));
    // No scope on these bare fixture tasks: the pause shows through status and the console banner.
    expect(claudeTask?.code).not.toBe("retry-scheduled");
    const status = installationStatus(store, at(2_000));
    expect(status.signIn).toEqual([{ provider: "claude", reason: "Claude needs you to sign in again", command: "claude /login", since: at(1_000).toISOString() }]);
    expect(renderInstallationStatus(status)[0]).toBe("Claude needs you to sign in again — run `claude /login`. Its tasks wait until then.");
    expect(signInNotices(store)).toEqual([{ provider: "claude", title: "Claude needs you to sign in again", command: "claude /login", detail: "", resumeLabel: "Resume Claude", resumeHref: "/providers/claude/resume" }]);
  });

  test("c3: one incident is exactly one outbox notification, however many runs hit it", () => {
    failAuth("t-1", "claude", at(1_000));
    failAuth("t-2", "claude", at(2_000));
    failAuth("t-3", "claude", at(3_000));
    expect(authPauseOf(store, "claude")?.runs).toBe(3);
    expect(authNotices()).toEqual([{
      dedupe_key: "signin:auth-expired:claude:1:alex",
      kind: "auth-expired",
      subject: "Claude needs you to sign in again",
      body: expect.stringContaining("Run `claude auth login` on this computer."),
    }]);
    // A later incident is a new ordinal: it notifies once again.
    liftAuthPause(store, "claude", "person", "alex", at(4_000));
    failAuth("t-4", "claude", at(5_000));
    failAuth("t-5", "claude", at(6_000));
    expect(authNotices().filter(one => one["kind"] === "auth-expired").map(one => one["dedupe_key"])).toEqual(["signin:auth-expired:claude:1:alex", "signin:auth-expired:claude:2:alex"]);
    // A Codex incident says what to run for Codex.
    failAuth("t-6", "codex", at(7_000));
    expect(authNotices().at(-1)).toMatchObject({ dedupe_key: "signin:auth-expired:codex:1:alex", subject: "Codex needs you to sign in again", body: expect.stringContaining("`codex login`") });
  });

  test("c4: the pause lifts on a person's resume with one resumed message naming how many tasks", () => {
    failAuth("t-1"); failAuth("t-2");
    expect(liftAuthPause(store, "claude", "person", "alex", at(5_000))).toMatchObject({ resumed: 2 });
    expect(authPauseOf(store, "claude")).toBeNull();
    expect(authNotices().at(-1)).toMatchObject({ dedupe_key: "signin:auth-restored:claude:1:alex", kind: "auth-restored", subject: "Claude is signed in again, 2 tasks resumed" });
    // Resuming again is a no-op: no second message.
    expect(liftAuthPause(store, "claude", "person", "alex", at(6_000))).toBeNull();
    expect(authNotices().filter(one => one["kind"] === "auth-restored")).toHaveLength(1);
    expect(store.handle.prepare("SELECT action FROM action_ledger WHERE actor = 'alex'").all().map(one => one["action"])).toContain("resumed Claude after a sign-in pause");
  });

  test("c4: a sign-in check lifts it only after one saw the provider signed out", () => {
    failAuth("t-1");
    // A check that says "connected" while runs fail to refresh proves nothing yet.
    expect(noteSignInProbe(store, "claude", "connected", at(2_000))).toBeNull();
    expect(authPauseOf(store, "claude")).not.toBeNull();
    expect(noteSignInProbe(store, "claude", "signed-out", at(3_000))).toBeNull();
    expect(noteSignInProbe(store, "claude", "connected", at(4_000))).toEqual({ resumed: 1 });
    expect(authPauseOf(store, "claude")).toBeNull();
    expect(authNotices().filter(one => one["kind"] === "auth-restored").map(one => one["subject"])).toEqual(["Claude is signed in again, 1 task resumed"]);
  });

  test("c1+c4: the gateway stamps auth-expired from the run itself, and the next working run lifts the pause", async () => {
    const keyHome = mkdtempSync(join(tmpdir(), "so-auth-home-"));
    const first = attempt("t-1");
    const failed = await invokeAgent(store, first.runId, { provider: "claude", model: null }, ASK, {
      keyHome,
      runner: async () => ({ ...OK, code: 1, stdout: JSON.stringify({ is_error: true, subtype: "error_during_execution", result: CLAUDE_EXPIRED }) }),
    });
    // The failed terminal may also refuse the handoff; either way the class is stamped first.
    expect(["ran", "refused"]).toContain(failed.kind);
    expect(store.getRun(first.runId)?.terminalClass).toBe("auth-expired");
    // A run that dies in seconds with nothing but stderr is read too.
    const quiet = attempt("t-2");
    await invokeAgent(store, quiet.runId, { provider: "claude", model: null }, ASK, {
      keyHome,
      runner: async () => ({ ...OK, code: 1, stderr: "Invalid API key · Please run /login" }),
    });
    expect(store.getRun(quiet.runId)?.terminalClass).toBe("auth-expired");
    // An ordinary quiet failure is not.
    const plain = attempt("t-3");
    await invokeAgent(store, plain.runId, { provider: "claude", model: null }, ASK, { keyHome, runner: async () => ({ ...OK, code: 1, stderr: "segmentation fault" }) });
    expect(store.getRun(plain.runId)?.terminalClass).not.toBe("auth-expired");

    finalizeFailureFenced(store, { leaseId: first.lease, runId: first.runId, taskId: "t-1", failureClass: "unknown", message: CLAUDE_EXPIRED, worktree: "/w", now: at(1_000) });
    expect(authPauseOf(store, "claude")).not.toBeNull();
    const worked = attempt("t-4");
    await invokeAgent(store, worked.runId, { provider: "claude", model: null }, ASK, {
      keyHome,
      runner: async () => ({ ...OK, stdout: JSON.stringify({ result: "done", subtype: "success", is_error: false }) }),
      clock: () => at(9_000),
    });
    expect(authPauseOf(store, "claude")).toBeNull();
    expect(openAuthPauses(store)).toEqual([]);
    expect(authNotices().filter(one => one["kind"] === "auth-restored").map(one => one["subject"])).toEqual(["Claude is signed in again, 1 task resumed"]);
    rmSync(keyHome, { recursive: true, force: true });
  });

  test("a paused provider lets one task through as a trial every ten minutes", () => {
    failAuth("t-1", "claude", at(1_000));
    const pause = authPauseOf(store, "claude")!;
    expect(claimAuthTrial(store, pause, at(2_000))).toBeNull();
    expect(claimAuthTrial(store, pause, at(1_000 + AUTH_TRIAL_MS))).not.toBeNull();
    // Only one trial per window, however many tasks ask.
    expect(claimAuthTrial(store, pause, at(1_000 + AUTH_TRIAL_MS + 5_000))).toBeNull();
    expect(claimAuthTrial(store, pause, at(1_000 + 2 * AUTH_TRIAL_MS))).not.toBeNull();
    // A trial that fails the same way stays inside the incident: nobody is told twice.
    failAuth("t-2", "claude", at(1_000 + 2 * AUTH_TRIAL_MS + 1_000));
    expect(authNotices().filter(one => one["kind"] === "auth-expired")).toHaveLength(1);
  });

  test("every road beside the queue asks the same gate: it waits, noted on its task, until the trial or the sign-in lets it go", () => {
    failAuth("t-1", "claude", at(1_000));
    store.createTask({ id: "t-review", title: "a follow-up on the same provider" }, T0);
    const waiting = store.refFor("built-in", "t-review").id;
    const note = () => store.handle.prepare("SELECT auth_wait_pause FROM task_ref WHERE id = ?").get(waiting)?.["auth_wait_pause"];
    // Paused: it waits (no failure, no retry of its own), and the task says why.
    expect(signInGate(store, ["claude"], at(2_000), waiting).waiting).toMatchObject({ provider: "claude" });
    expect(authWaitOf(store, waiting)).toMatchObject({ provider: "claude" });
    // Another provider is not held.
    expect(signInGate(store, ["codex"], at(2_000)).waiting).toBeNull();
    // The one trial goes ahead and clears its note; the next asker waits again.
    expect(signInGate(store, ["claude"], at(1_000 + AUTH_TRIAL_MS), waiting).waiting).toBeNull();
    expect(note()).toBeNull();
    expect(signInGate(store, ["claude"], at(1_000 + AUTH_TRIAL_MS + 1_000), waiting).waiting).not.toBeNull();
    // A person's resume lets everything go; a note left behind names a lifted pause and says nothing.
    liftAuthPause(store, "claude", "person", "alex", at(1_000 + AUTH_TRIAL_MS + 2_000));
    expect(authWaitOf(store, waiting)).toBeNull();
    expect(signInGate(store, ["claude"], at(1_000 + AUTH_TRIAL_MS + 3_000), waiting).waiting).toBeNull();
    expect(note()).toBeNull();
  });

  test("a trial whose claim then fails is given back: the next pass takes it instead of waiting ten minutes", () => {
    failAuth("t-1", "claude", at(1_000));
    const trialTime = () => store.handle.prepare("SELECT last_trial_at FROM provider_auth_pause WHERE provider = 'claude'").get()?.["last_trial_at"];
    const first = at(1_000 + AUTH_TRIAL_MS);
    // The trial is taken; the task's claim then fails (capacity, a lease held elsewhere), so it is given back.
    const lost = signInGate(store, ["claude"], first);
    expect(lost.waiting).toBeNull();
    expect(trialTime()).toBe(first.toISOString());
    lost.giveBack();
    expect(trialTime()).toBeNull();
    // Giving back twice changes nothing.
    lost.giveBack();
    expect(trialTime()).toBeNull();
    // The next pass, seconds later, still has its trial.
    const next = signInGate(store, ["claude"], at(1_000 + AUTH_TRIAL_MS + 5_000));
    expect(next.waiting).toBeNull();
    // Kept this time: the window closes behind it.
    expect(signInGate(store, ["claude"], at(1_000 + AUTH_TRIAL_MS + 6_000)).waiting).toMatchObject({ provider: "claude" });
    // A second trial given back restores the earlier trial time, not an empty one.
    const later = claimAuthTrial(store, authPauseOf(store, "claude")!, at(1_000 + 3 * AUTH_TRIAL_MS))!;
    expect(later.previous).toBe(at(1_000 + AUTH_TRIAL_MS + 5_000).toISOString());
    giveBackAuthTrial(store, later);
    expect(trialTime()).toBe(at(1_000 + AUTH_TRIAL_MS + 5_000).toISOString());
    // With nothing paused there is nothing to give back.
    liftAuthPause(store, "claude", "person", "alex", at(1_000 + 3 * AUTH_TRIAL_MS + 1_000));
    const free = signInGate(store, ["claude"], at(1_000 + 3 * AUTH_TRIAL_MS + 2_000));
    expect(free.waiting).toBeNull();
    expect(() => free.giveBack()).not.toThrow();
  });

  test("a task re-routed to another provider stops saying it waits on the old provider's sign-in", () => {
    failAuth("t-1", "claude", at(1_000));
    store.createTask({ id: "t-plan", title: "plan it first" }, T0);
    const ref = store.refFor("built-in", "t-plan").id;
    store.placeTask(ref, REPO);
    expect(store.requestPlan(ref, T0).ok).toBe(true);
    const status = () => workIndexPage(store, at(2_000), { principal: "operator", repos: null, includeUnplaced: true }).items.find(one => one.activeTaskId === "t-plan")?.status;
    // An unpinned planner: configuration picked Claude, and the gate left it waiting on Claude's pause.
    expect(signInGate(store, ["claude"], at(2_000), ref).waiting).toMatchObject({ provider: "claude" });
    expect(diagnoseTaskDispatch(store, "t-plan", at(2_000))?.code).toBe("signed-out");
    expect(status()).toMatchObject({ label: "Needs you", detail: expect.stringContaining("Claude needs you to sign in again") });
    // Pinned to Claude, it still waits.
    expect(store.setPlanPins(ref, "claude", null, at(2_000)).ok).toBe(true);
    expect(authWaitOf(store, ref)).toMatchObject({ provider: "claude" });
    expect(status()).toMatchObject({ label: "Needs you", detail: expect.stringContaining("Claude needs you to sign in again") });
    // Re-routed to Codex: the old note no longer speaks for it, in dispatch or the work index.
    expect(store.setPlanPins(ref, "codex", null, at(2_000)).ok).toBe(true);
    expect(authWaitOf(store, ref)).toBeNull();
    expect(diagnoseTaskDispatch(store, "t-plan", at(2_000))?.code).not.toBe("signed-out");
    expect(status()).toMatchObject({ label: "Queued", detail: "A connected worker can draft the plan." });
  });

  test("a run that started before the pause opened does not lift it", () => {
    failAuth("t-1", "claude", at(5_000));
    expect(liftAuthPause(store, "claude", "run", "run #1", at(9_000), at(1_000))).toBeNull();
    expect(authPauseOf(store, "claude")).not.toBeNull();
    expect(liftAuthPause(store, "claude", "run", "run #2", at(9_000), at(6_000))).toMatchObject({ resumed: 1 });
  });

  test("pausing is idempotent inside one incident and never touches another provider", () => {
    const one = attempt("t-1");
    expect(pauseForAuth(store, { provider: "claude", authMode: "subscription", runId: one.runId, taskRef: one.ref, now: T0 }).opened).toBe(true);
    expect(pauseForAuth(store, { provider: "claude", authMode: "subscription", runId: one.runId, taskRef: one.ref, now: T0 }).opened).toBe(false);
    expect(openAuthPauses(store).map(pause => pause.provider)).toEqual(["claude"]);
  });
});

describe("c3: the one notification reaches Telegram and Slack", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-auth-expired-"));
    store = openStore(join(dir, "state.db"));
    register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => `tok-${RUNNER}` });
    expect(addApprover(store, "alex", T0).ok).toBe(true);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const incident = (count: number) => {
    for (let index = 1; index <= count; index++) {
      const taskId = `t-${index}`;
      store.createTask({ id: taskId, title: taskId }, T0);
      const ref = store.refFor("built-in", taskId).id;
      store.placeTask(ref, REPO);
      const lease = `lease-${index}`;
      const took = acquire(store, ref, RUNNER, { now: T0, token: `tok-${RUNNER}`, newLeaseId: () => lease, ttlMs: TTL });
      if (!took.ok) throw new Error(took.reason);
      const runId = store.startRun({ taskRef: ref, leaseId: lease, runner: RUNNER, branch: "b", worktree: "/w", provider: "claude", ...legacy("claude"), now: T0 });
      store.stampTerminalClass(runId, "subscription", "auth-expired");
      finalizeFailureFenced(store, { leaseId: lease, runId, taskId, failureClass: "unknown", message: CLAUDE_EXPIRED, worktree: "/w", now: at(index * 1_000) });
    }
  };
  const signInTexts = (texts: string[]) => texts.filter(text => text.includes("needs you to sign in again"));

  test("Telegram sends it once for an incident of several runs", async () => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, T0);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "777000", chatId: "4242", userId: "31337", updateId: 1 }, T0).ok).toBe(true);
    incident(3);
    const sent: string[] = [];
    let id = 100;
    const transport: TelegramTransport = async (method, params) => {
      if (method === "sendMessage") { sent.push(String(params["text"])); return { ok: true, result: { message_id: id++ } }; }
      return { ok: true, result: method === "getUpdates" ? [] : true };
    };
    for (const step of [10_000, 20_000]) await bridgePass(store, { botId: "777000", transport, clock: () => at(step), readProjects: async () => [REPO] });
    expect(signInTexts(sent)).toHaveLength(1);
    expect(signInTexts(sent)[0]).toContain("`claude auth login`");
  });

  test("Slack sends it once for an incident of several runs", async () => {
    const identity = { installation: "installation-test", team: "TTEST", app: "ATEST", bot: "UBOT", workspace: "Test workspace" };
    const state = new ChatState(store, "slack");
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    let ts = 100;
    const api: SlackApi = vi.fn(async (method, args = {}) => {
      calls.push({ method, args });
      if (method === "users.info") return { user: { id: "UTEST", team_id: "TTEST", deleted: false, is_bot: false } };
      if (method === "conversations.info") return { channel: { id: "DTEST", is_im: true, user: "UTEST" } };
      if (method === "chat.postMessage") return { ts: `1789700000.${String(ts++).padStart(6, "0")}` };
      return {};
    });
    const options: SlackChatOptions = { store, identity, api, owner: "test", readProjects: async () => [REPO], evidenceRoot: join(dir, "evidence"), current: () => true, origin: () => "https://console.example", clock: () => at(10_000) };
    state.lease(identity.installation, "test", T0);
    const pairing = state.pairing(identity.installation, "alex", store.accountOf("alex")!.generation, T0);
    expect(state.pair(identity, chatHash(pairing), "UTEST", "DTEST", T0)).not.toBeNull();
    incident(3);
    for (let pass = 0; pass < 2; pass++) {
      await planSlackNotifications(options);
      for (let i = 0; i < 20 && (await deliverSlackPart(options)); i++);
    }
    const texts = calls.filter(call => call.method === "chat.postMessage").map(call => String(call.args["text"]));
    expect(signInTexts(texts)).toHaveLength(1);
    expect(signInTexts(texts)[0]).toContain("claude auth login");
  });
});
