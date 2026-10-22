/**
 * An ACP agent through the one spawning gateway and the real runner (docs/plans/acp-adapter.md § Gateway, runner,
 * custody): a stand-in agent (test/fixtures/fake-acp-agent.mjs) admitted by an attestation of its exact files, run
 * inside the OS fence. Success is the prompt's end_turn answer and a clean exit; everything else fails closed, and an
 * agent that isn't checked, or whose files changed since, never starts.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { launchOf } from "./acp-attest.js";
import type { AcpControl } from "./exec.js";
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { acquire } from "./claim.js";
import { invokeAgent, type InvokeResult } from "./invoke.js";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";

const T0 = new Date();
const TTL = 10 * 365 * 24 * 3600 * 1000;
const RUNNER = "builder-1";
const FENCED = macosFenceAvailable() || linuxFenceAvailable();
const FIXTURE = join(import.meta.dirname, "..", "test", "fixtures", "fake-acp-agent.mjs");
const SPEC = { provider: "opencode" as const, model: "fake/model" };
const ASK = { phase: "build" as const, brief: "Write done.txt.", maxTurns: 1, permissionMode: "bypassPermissions", skipPermissions: true, resumeSession: null };

let dir: string;
let store: Store;
let runId: number;
let worktree: string;
let agent: string;
let home: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-acp-gw-")));
  home = join(dir, "home");
  mkdirSync(home);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  // The plane's own checkout pool sits beside its database: the fence binds a checkout recorded there.
  mkdirSync(join(dir, "worktrees"));
  worktree = join(dir, "worktrees", "wt");
  git(repo, "worktree", "add", "-q", "-b", "task", worktree);
  // The agent lives in its own folder, copied so a test can change it after its check.
  mkdirSync(join(dir, "agent"));
  agent = join(dir, "agent", "fake-acp");
  copyFileSync(FIXTURE, agent);
  execFileSync("chmod", ["+x", agent]);
  store = openStore(join(dir, "state.db"));
  register(store, { name: RUNNER, host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => `tok-${RUNNER}` });
  store.createTask({ id: "t-1", title: "w" }, T0);
  const ref = store.refFor("built-in", "t-1").id;
  store.placeTask(ref, repo);
  const took = acquire(store, ref, RUNNER, { now: T0, token: `tok-${RUNNER}`, newLeaseId: () => "lease-1", ttlMs: TTL });
  if (!took.ok) throw new Error(took.reason);
  store.saveWorktree({ path: worktree, repo, branch: "task", runner: RUNNER, taskRef: ref, createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true });
  runId = store.startRun({ taskRef: ref, leaseId: "lease-1", runner: RUNNER, branch: "task", worktree, route: { routeDigest: "legacy", phase: "build", provider: "opencode", model: "fake/model", chosen: "legacy" }, now: T0 });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function check(): void {
  const launch = launchOf(realpathSync(agent), process.env["PATH"] ?? "");
  if ("problem" in launch) throw new Error(launch.problem);
  store.recordAcpAttestation({ provider: "opencode", runner: RUNNER, launch, agent: { name: "FakeCode", version: "1.0.0" }, cliVersion: "1.0.0", models: ["fake/model"], checks: ["test"], recordedBy: "test" }, T0);
}

function run(mode: string, extra: { idleTimeoutMs?: number; timeoutMs?: number; onControl?: (control: AcpControl) => void; handshakeMs?: number } = {}): Promise<InvokeResult> {
  const env = { FAKE_ACP: mode, FAKE_ACP_LOG: join(worktree, ".agent.log"), FAKE_ACP_RAN: join(worktree, ".ran") };
  return invokeAgent(store, runId, SPEC, ASK, {
    keyHome: home, env, idleTimeoutMs: extra.idleTimeoutMs ?? 20_000, timeoutMs: extra.timeoutMs ?? 60_000,
    ...(extra.onControl === undefined && extra.handshakeMs === undefined ? {} : { acp: { prompt: "", model: "", expect: null, ...(extra.onControl === undefined ? {} : { onControl: extra.onControl }), ...(extra.handshakeMs === undefined ? {} : { handshakeMs: extra.handshakeMs }) } }),
  });
}
const ran = () => existsSync(join(worktree, ".ran"));
const agentLog = () => existsSync(join(worktree, ".agent.log")) ? readFileSync(join(worktree, ".agent.log"), "utf8").trim().split("\n") : [];

describe.skipIf(!FENCED)("an ACP agent through the gateway, inside the fence", () => {
  test("a checked agent builds: the handshake, the sealed model, the brief, end_turn, a clean close — and the run says so", async () => {
    check();
    const result = await run("ok");
    if (result.kind !== "ran") throw new Error(JSON.stringify(result));
    expect(result.outcome.code).toBe(0);
    expect(readFileSync(join(worktree, "done.txt"), "utf8")).toBe("ok\n");
    expect(agentLog()).toEqual(["initialize", "session/new", "session/set_config_option", "session/prompt", "prompt:Write done.txt.", "session/close", "eof"]);
    // What a conformance check reads: who it said it is, what it offered, and that it left on its own once stdin closed.
    expect(result.outcome.acp).toMatchObject({ agent: { name: "FakeCode", version: "1.0.0" }, offered: ["fake/default", "fake/model"], stop: "end_turn", exit: { how: "eof", leftover: false } });
    const row = store.getRun(runId)!;
    expect(row.sessionId).toBe("ses_fake_1");
    expect(row.providerVersion).toBe("1.0.0");
  });

  test("NODE_OPTIONS can't make the pinned interpreter run other code", async () => {
    check();
    const marker = join(dir, "injected");
    writeFileSync(join(dir, "inject.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    const result = await invokeAgent(store, runId, SPEC, ASK, {
      keyHome: home, idleTimeoutMs: 20_000, timeoutMs: 60_000,
      env: { FAKE_ACP: "ok", NODE_OPTIONS: `--require ${join(dir, "inject.cjs")}` },
    });
    expect(result.kind).toBe("ran");
    expect(existsSync(marker)).toBe(false);
  });

  test("a run admitted on the agent's declared plan settles at $0 as a plan, after the gateway is done with it", async () => {
    check();
    store.finishRun(runId, { outcome: "refused", reason: "test", now: T0 });
    store.declareAcpBilling({ provider: "opencode", runner: RUNNER, model: "fake/model", kind: "plan", by: "test" }, T0);
    const ref = store.getRun(runId)!.taskRef;
    const planned = store.startRun({ taskRef: ref, leaseId: "lease-1", runner: RUNNER, branch: "task", worktree, route: { routeDigest: "legacy", phase: "build", provider: "opencode", model: "fake/model", chosen: "legacy" }, now: T0 });
    const result = await invokeAgent(store, planned, SPEC, ASK, { keyHome: home, env: { FAKE_ACP: "ok" }, idleTimeoutMs: 20_000, timeoutMs: 60_000 });
    expect(result.kind).toBe("ran");
    store.settleRunSpend(planned, T0);
    expect(store.handle.prepare("SELECT microusd, billing FROM run_spend WHERE run = ?").get(planned)).toEqual({ microusd: 0, billing: "subscription" });
  });

  test("a hard monthly budget stops metered work at the spawn, whatever the declaration says by then", async () => {
    check();
    store.setBudget({ scope: "installation", key: "", limitMicrousd: 1_000_000, hardStop: true }, "test", T0);
    // Admitted metered (no declaration); a plan declared after admission doesn't change what the run bills.
    store.declareAcpBilling({ provider: "opencode", runner: RUNNER, model: "fake/model", kind: "plan", by: "test" }, T0);
    const result = await run("ok");
    expect(result).toMatchObject({ kind: "refused", reason: "provider-unattested", diagnostic: expect.stringContaining("(budget)") });
    expect(ran()).toBe(false);
  });

  test("an unchecked agent never starts", async () => {
    const result = await run("ok");
    expect(result).toMatchObject({ kind: "refused", reason: "provider-unattested", diagnostic: expect.stringContaining("toolroll agents check opencode") });
    expect(ran()).toBe(false);
  });

  test("an agent whose file changed since its check never starts", async () => {
    check();
    writeFileSync(agent, `${readFileSync(agent, "utf8")}\n// changed\n`);
    const result = await run("ok");
    expect(result).toMatchObject({ kind: "refused", reason: "provider-unattested", diagnostic: expect.stringContaining("changed since the check") });
    expect(ran()).toBe(false);
  });

  test("a model it didn't offer at its check, or a cap it can't hold, never starts", async () => {
    check();
    const other = await invokeAgent(store, runId, { provider: "opencode", model: "fake/other" }, ASK, { keyHome: home });
    expect(other).toMatchObject({ kind: "refused", reason: "provider-unattested", diagnostic: expect.stringContaining("didn't offer fake/other") });
    const capped = await invokeAgent(store, runId, SPEC, { ...ASK, maxBudgetUsd: 1 }, { keyHome: home });
    expect(capped).toMatchObject({ kind: "refused", diagnostic: expect.stringContaining("budget-unenforceable") });
    expect(ran()).toBe(false);
  });

  for (const [mode, why] of [["wrong-version", "an agent that isn't the checked one"], ["refuse-model", "an agent that doesn't make the sealed model current"], ["quiet-exit", "updates and a clean exit with no answer"]] as const) {
    test(`${why} is never a success`, async () => {
      check();
      const result = await run(mode);
      // Refused as a protocol failure, or a run that failed: never a clean success.
      expect(result.kind === "refused" || result.outcome.code !== 0).toBe(true);
      expect(existsSync(join(worktree, "done.txt"))).toBe(false);
    });
  }

  test("an agent that goes silent is stopped by its idle clock", async () => {
    check();
    const started = Date.now();
    const result = await run("stall", { idleTimeoutMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.kind === "ran" ? result.outcome.timedOut : true).toBe(true);
  });

  test("what the agent started in its own group ends with it", async () => {
    check();
    const result = await run("descendant");
    if (result.kind !== "ran") throw new Error(JSON.stringify(result));
    // The runner says something of the group was still alive at the reap — and the reap ended it.
    expect(result.outcome.acp?.exit).toEqual({ how: "eof", leftover: true, timedOut: false });
    const pid = Number(readFileSync(join(worktree, "descendant.pid"), "utf8"));
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  test("a check revoked or replaced while the run was being set up starts nothing", async () => {
    check();
    const real = store.acpAttestationFor.bind(store);
    let reads = 0;
    vi.spyOn(store, "acpAttestationFor").mockImplementation((provider, runner) => (++reads === 1 ? real(provider, runner) : null));
    const result = await run("ok");
    expect(result).toMatchObject({ kind: "refused", reason: "provider-unattested", diagnostic: expect.stringContaining("revoked or replaced") });
    expect(ran()).toBe(false);
  });

  test("a second, conflicting answer — even one with no newline before the exit — is never a success", async () => {
    check();
    const result = await run("double-answer");
    expect(result.kind === "refused" || result.outcome.code !== 0).toBe(true);
  });

  for (const mode of ["pipe-holder", "escaped-pipe-holder"] as const) {
    test(`a stray holding the agent's pipes (${mode === "pipe-holder" ? "in its group" : "in a group of its own"}) doesn't hold the run open`, async () => {
      check();
      const started = Date.now();
      const result = await run(mode);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(result.kind).toBe("ran");
      const pid = Number(readFileSync(join(worktree, "stray.pid"), "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch { /* reaped already */ }
    });
  }

  test("an agent that ignores EOF and SIGTERM after answering is killed by the ladder — and the answered build still succeeds", async () => {
    check();
    const result = await run("ignore-term");
    if (result.kind !== "ran") throw new Error(JSON.stringify(result));
    expect(result.outcome.code).toBe(0);
    expect(result.outcome.acp?.exit?.how).toBe("kill");
  }, 30_000);

  test("an agent that never answers initialize is stopped by the handshake deadline", async () => {
    check();
    const started = Date.now();
    const result = await run("silent-init", { handshakeMs: 1_000, idleTimeoutMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.kind === "refused" || result.outcome.code !== 0).toBe(true);
  });

  test("a cancel mid-prompt is answered cancelled, is not a success, and what was alive at the cancel is gone after", async () => {
    check();
    let witnessed: { pid: number; group: number }[] = [];
    const result = await run("slow", { onControl: control => {
      // Cancel only once a live descendant is seen, from the plane's own reading of the agent's tree.
      const poll = setInterval(() => {
        const live = control.liveDescendants();
        if (live !== null && live.length > 0) { witnessed = live; clearInterval(poll); control.cancel(); }
      }, 100);
      setTimeout(() => clearInterval(poll), 20_000).unref();
    } });
    expect(witnessed.length).toBeGreaterThan(0);
    expect(witnessed.map(one => one.pid)).toContain(Number(readFileSync(join(worktree, "slow.pid"), "utf8")));
    expect(result.kind === "ran" ? result.outcome.code : -1).not.toBe(0);
    expect(agentLog()).toContain("session/cancel");
    for (const { pid } of witnessed) expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe.skipIf(FENCED)("without an OS fence", () => {
  test("an ACP agent never starts", async () => {
    check();
    const result = await run("ok");
    expect(result).toMatchObject({ kind: "refused", reason: "containment", diagnostic: expect.stringContaining("fence-unavailable") });
    expect(ran()).toBe(false);
  });
});
