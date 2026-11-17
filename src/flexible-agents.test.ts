/**
 * Flexible threads, slice F2c (flexible-agents.ts, flexible-levels.ts, flexible-launch.ts): each relay-tier agent's Full
 * access and nothing else (the sign-in relay itself: flexible-relay.test.ts); the proven matrix under each ceiling; a turn start
 * that refuses (its admission no longer stands, its agent or level isn't offered, another agent still runs) spawns
 * nothing and leaves custody as it was; lowering mid-turn stops the agent and interrupts its turn, or stays pending
 * while something survives; recovery after a crash (a launch left spawning, survivors of a live one); removal and a
 * project's deletion wait for custody. Real processes stand in for an agent where custody is the point (no sandbox:
 * the fenced rows are test/attacks/flexible-thread-custody.slow.test.ts). No model is called anywhere.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { FLEXIBLE_START_GATE, prepareFlexibleThread, removeFlexibleThread, flexibleThread, stopFlexibleThreadAgent, type FlexibleThreadPaths } from "./flexible-thread.js";
import { spawnSync } from "node:child_process";
import { flexibleAgentLaunch, lowerFlexibleThreadLevel, recoverFlexibleLaunchesOf, startFlexibleTurn } from "./flexible-agents.js";
import { startFlexibleRelay } from "./flexible-relay.js";
import { FLEXIBLE_PROVEN, threadLevelAllowed } from "./flexible-levels.js";
import { flexibleLaunch, freshProviderFolder, holdLaunch, onLaunchStopped, revokeLaunch, unsettledLaunch, watchLaunch } from "./flexible-launch.js";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realCustodyIO, startIdentityOf } from "./flexible-custody.js";
import { deleteProject, projectRunning } from "./project-delete.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));

const NOW = new Date("2026-11-14T12:00:00.000Z");
const STORAGE = { names: [], denies: [] };
const io = realCustodyIO(() => null);
let world: ThreadWorld, digest: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  world = threadWorld();
  world.store.saveApprover("alex", "hash-a", NOW);
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: gen(), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
});
afterEach(() => {
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});
function gen(): number { return world.store.accountOf("alex")!.generation; }
async function thread(): Promise<{ id: string; paths: FlexibleThreadPaths }> {
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  return { id: made.thread.id, paths: made.paths };
}
let keys = 0;
function admit(id: string, over: Partial<Parameters<typeof admitFlexibleTurn>[1]> = {}): string {
  const made = admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: gen() }, digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5",
    billing: "subscription", requestKey: `m-${++keys}`, holder: "h1", clock: () => NOW, ...over });
  if (!made.ok) throw new Error(`${made.reason}: ${made.message}`);
  return made.turn;
}
const launches = () => world.store.handle.prepare("SELECT id, state FROM flexible_thread_launch ORDER BY started_at").all().map(row => ({ ...row }));
const startInput = (turn: string, over: Partial<Parameters<typeof startFlexibleTurn>[1]> = {}) => ({
  turn, holder: "h1", clock: () => NOW, network: { proxyPort: 41_000, token: "run-token", proxyEnv: {}, close: () => {} },
  relay: { url: "http://127.0.0.1:1", port: 1, issue: () => ({ url: "http://127.0.0.1:1", token: "relay-token", revoke: () => {} }) }, storage: STORAGE, ...over });
/** A real process standing in for a thread's agent: its own group, working in the thread's repository. */
function agent(paths: FlexibleThreadPaths, script = "sleep 30"): { pid: number; start: string; closed: Promise<void> } {
  const child = spawn("/bin/sh", ["-c", script], { cwd: paths.repo, detached: true, stdio: "ignore" });
  children.push(child);
  spawnedHere.set(child.pid!, child);
  return { pid: child.pid!, start: startIdentityOf(child.pid!, io)!, closed: new Promise(done => child.once("close", () => done())) };
}
/** A live launch on the record for `pid`, as flexibleThreadSpawn registers one. */
const spawnedHere = new Map<number, ChildProcess>();
function live(id: string, pid: number, start: string, over: { level?: string; state?: string; holder?: string; fence?: string; held?: boolean } = {}): string {
  const launch = `${pid.toString(16).padStart(8, "0")}${randomBytes(12).toString("hex")}`;
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, 'claude', ?, ?, ?, 'here', ?, ?, ?, ?, ?)`).run(launch, id, over.level ?? "full", over.fence ?? "f".repeat(32), over.holder ?? "h1", "9".repeat(32), pid, start, over.state ?? "live", NOW.toISOString());
  world.store.handle.prepare("UPDATE flexible_thread SET live_pid = ?, live_since = ? WHERE id = ?").run(pid, NOW.toISOString(), id);
  // This process started it, as flexibleThreadSpawn does: it holds the leader's handle and confirms its own network.
  const child = spawnedHere.get(pid);
  if (child !== undefined && over.held !== false) holdLaunch(launch, child);
  return launch;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await new Promise(done => setTimeout(done, 100)); expect(test()).toBe(true); };

describe("each agent at its level, and the proven matrix", () => {
  const relay = { url: "http://127.0.0.1:9", token: "tr-relay-x" };

  test("Claude at Full access: no prompts inside the fence, none of anyone's settings, signed in only through the relay", () => {
    const made = flexibleAgentLaunch("claude", "full", { model: "claude-sonnet-4-5", relay, configHome: "/state/threads/t/cache/provider-home" });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.spec.file).toBe("claude");
    expect(made.spec.args).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--model", "claude-sonnet-4-5"]));
    expect(made.spec.args).not.toContain("--dangerously-skip-permissions");
    expect(made.spec.env).toEqual({ ANTHROPIC_BASE_URL: relay.url, ANTHROPIC_AUTH_TOKEN: relay.token, CLAUDE_CONFIG_DIR: "/state/threads/t/cache/provider-home", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(Object.keys(made.spec.env).filter(name => /API_KEY|OAUTH|SESSION/.test(name))).toEqual([]);
  });

  test("Codex and OpenRouter stay refused (enable gate 3); no level but Full access is built; a model that isn't one is refused", () => {
    for (const provider of ["codex", "openrouter"] as const) expect(flexibleAgentLaunch(provider, "full", { model: "gpt-5", relay, configHome: "/h" })).toMatchObject({ ok: false, reason: "codex-unsupported" });
    for (const level of ["supervised", "auto"] as const) expect(flexibleAgentLaunch("claude", level, { model: "claude-sonnet-4-5", relay, configHome: "/h" })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(flexibleAgentLaunch("claude", "full", { model: "--dangerously-skip-permissions x", relay, configHome: "/h" })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(flexibleAgentLaunch("gemini", "full", { model: "gemini-3-pro", relay, configHome: "/h" })).toMatchObject({ ok: true, spec: { args: expect.arrayContaining(["--approval-mode", "yolo"]), env: { GEMINI_API_KEY: relay.token } } });
  });

  test("threadLevelAllowed: only Claude at Full access, under an escalated ceiling; never traded for another level", () => {
    expect(threadLevelAllowed({ ceiling: "escalated" }, "claude", "full")).toMatchObject({ ok: true });
    expect(threadLevelAllowed({ ceiling: "standard" }, "claude", "full")).toMatchObject({ ok: false, reason: "above-ceiling" });
    expect(threadLevelAllowed({ ceiling: "safe" }, "claude", "full")).toMatchObject({ ok: false, reason: "above-ceiling" });
    for (const level of ["supervised", "auto"] as const) expect(threadLevelAllowed({ ceiling: "escalated" }, "claude", level)).toMatchObject({ ok: false, reason: "level-unavailable" });
    for (const agent of ["codex", "openrouter", "gemini"] as const) expect(threadLevelAllowed({ ceiling: "escalated" }, agent, "full")).toMatchObject({ ok: false, reason: "level-unavailable" });
    expect(threadLevelAllowed({ ceiling: "nonsense" as never }, "claude", "full")).toMatchObject({ ok: false, reason: "above-ceiling" });
    // A safe ceiling allows only a Supervised proven to ask before every step.
    const proven = { ...FLEXIBLE_PROVEN, claude: { ...FLEXIBLE_PROVEN.claude, supervised: { offered: true as const, how: "x" } } };
    expect(threadLevelAllowed({ ceiling: "safe" }, "claude", "supervised", proven)).toMatchObject({ ok: false, reason: "above-ceiling" });
    const asks = { ...FLEXIBLE_PROVEN, claude: { ...FLEXIBLE_PROVEN.claude, supervised: { offered: true as const, how: "x", asksBeforeEveryAction: true as const } } };
    expect(threadLevelAllowed({ ceiling: "safe" }, "claude", "supervised", asks)).toMatchObject({ ok: true });
  });
});

describe("a turn start that refuses spawns nothing and leaves custody as it was", () => {
  test("its admission no longer stands at start: the day passed, a plan window filled, the terms were turned off and on", async () => {
    const { id } = await thread();
    const expired = admit(id);
    expect(await startFlexibleTurn(world.store, startInput(expired, { clock: () => new Date("2026-11-15T00:00:01.000Z") }))).toMatchObject({ ok: false, reason: "turn-expired" });
    const planned = admit(id);
    world.store.recordProviderLimits({ provider: "claude", plan: null, windows: [{ window: "five_hour", usedPercent: 100, windowMinutes: 300, resetsAt: "2026-11-14T15:00:00.000Z", reached: true }] }, NOW);
    expect(await startFlexibleTurn(world.store, startInput(planned))).toMatchObject({ ok: false, reason: "cap-reached", cap: "plan" });
    world.store.handle.prepare("DELETE FROM provider_limit").run();
    const waiting = admit(id);
    const row = world.store.handle.prepare("SELECT terms_json, digest FROM flexible_terms WHERE ended_at IS NULL").get()!;
    world.store.handle.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = 'alex', end_reason = 'off' WHERE ended_at IS NULL").run(NOW.toISOString());
    world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, row["terms_json"], row["digest"], row["terms_json"], row["digest"], NOW.toISOString(), NOW.toISOString());
    expect(await startFlexibleTurn(world.store, startInput(waiting))).toMatchObject({ ok: false, reason: "terms-changed" });
    for (const turn of [expired, planned, waiting]) expect(flexibleTurn(world.store, turn)!.status).toBe("withdrawn");
    expect(launches()).toEqual([]);
    expect(flexibleThread(world.store, id)!.livePid).toBeNull();
  });

  test("a level the agent isn't offered at (the matrix changed since admission): withdrawn, nothing started, the caller's proxy closed", async () => {
    const { id } = await thread();
    const turn = admit(id);
    let closed = 0;
    const noClaude = { ...FLEXIBLE_PROVEN, claude: { ...FLEXIBLE_PROVEN.claude, full: { offered: false as const, why: "test" } } };
    expect(await startFlexibleTurn(world.store, startInput(turn, { proven: noClaude, network: { proxyPort: 41_000, token: "t", proxyEnv: {}, close: () => { closed++; } } }))).toMatchObject({ ok: false, reason: "level-unavailable" });
    expect(flexibleTurn(world.store, turn)!.status).toBe("withdrawn");
    expect(launches()).toEqual([]);
    expect(closed).toBe(1);
  });

  test("a running agent is reused only when it is provably the same launch in the same fence: another fence digest, holder or leader start means it is stopped first", async () => {
    const { id, paths } = await thread();
    // A stand-in `claude` (never the real one) for the launch that follows.
    const bin = join(world.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nsleep 30\n");
    chmodSync(join(bin, "claude"), 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:${path ?? "/usr/bin:/bin"}`;
    try {
    for (const stale of [{ fence: "f".repeat(32) }, { holder: "h2" }, { start: "t1" }]) {
      const old = agent(paths);
      const launch = live(id, old.pid, stale.start ?? old.start, { holder: stale.holder ?? "h1", fence: stale.fence });
      const turn = admit(id);
      const started = await startFlexibleTurn(world.store, startInput(turn));
      expect(started, JSON.stringify(stale)).not.toMatchObject({ launched: "reused" });
      if (stale.start === undefined) {
        // Proven the launch's: stopped, its exit verified, then a new launch was tried (inside the fence where there is one).
        await old.closed;
        expect(flexibleLaunch(world.store, launch)).toMatchObject({ state: "exited", stopReason: "its agent was replaced" });
      } else {
        // A leader whose start doesn't match the record isn't proven the launch's: never signalled; the turn waits.
        expect(started).toMatchObject({ ok: false, reason: "level-pending" });
        expect(alive(old.pid)).toBe(true);
        process.kill(-old.pid, "SIGKILL");
        await old.closed;
      }
      if (started.ok && started.launched === "started") { started.child.stdin!.end(); await stopFlexibleThreadAgent(world.store, { id, reason: "test", io }); }
      world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE state <> 'exited'").run(NOW.toISOString());
      world.store.handle.prepare("UPDATE thread_turn SET status = 'withdrawn', ended_at = ? WHERE status = 'admitted'").run(NOW.toISOString());
      world.store.handle.prepare("UPDATE thread_turn SET status = 'finished', ended_at = ?, cost_basis = 'unknown' WHERE status = 'running'").run(NOW.toISOString());
    }
    } finally { process.env["PATH"] = path; }
  }, 60_000);

  test("a link the agent planted in its cache (at the cache, or at cache/provider) refuses the next turn, and nothing outside the thread is removed", async () => {
    const { id, paths } = await thread();
    // A stand-in `claude` and only the system's folders on PATH: no real agent program can start, whatever happens.
    const bin = join(world.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
    const start = async (turn: string) => {
      const started = await startFlexibleTurn(world.store, startInput(turn));
      if (started.ok && started.launched === "started") { started.child.stdin!.end(); await stopFlexibleThreadAgent(world.store, { id, reason: "test", io }); }
      return started;
    };
    try {
    const outside = join(world.dir, "outside");
    mkdirSync(join(outside, "provider"), { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    writeFileSync(join(outside, "provider", "keep.txt"), "keep\n");
    // At cache/provider: the folder Toolroll empties before each launch.
    symlinkSync(outside, join(paths.cache, "provider"));
    const first = admit(id);
    expect(await start(first)).toMatchObject({ ok: false, reason: "setup-failed" });
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(lstatSync(join(paths.cache, "provider")).isSymbolicLink()).toBe(true); // refused, never repaired by deleting
    expect(flexibleTurn(world.store, first)).toMatchObject({ status: "unknown" });
    expect(world.store.handle.prepare("SELECT detail FROM action_ledger WHERE action = 'flexible turn refused'").get()!["detail"]).toContain("provider folder isn't a real folder");
    expect(launches()).toEqual([]);
    // At the cache itself: the cache's provider folder would resolve outside.
    rmSync(join(paths.cache, "provider"));
    rmSync(paths.cache, { recursive: true });
    symlinkSync(outside, paths.cache);
    const second = admit(id);
    expect(await start(second)).toMatchObject({ ok: false });
    expect(readFileSync(join(outside, "provider", "keep.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(launches()).toEqual([]);
    } finally { process.env["PATH"] = path; }
  });
});

describe("the provider folder is emptied only while the thread is quiet", () => {
  test("while an earlier launch of the thread is unsettled (custody not verified), nothing in its cache is touched", async () => {
    const { id, paths } = await thread();
    const provider = join(paths.cache, "provider");
    mkdirSync(join(provider, "old"), { recursive: true });
    writeFileSync(join(provider, "old", "keep.txt"), "keep\n");
    for (const state of ["live", "stopping", "unresolved"]) {
      const launch = live(id, fakePid(7), "t7", { state, held: false });
      expect(freshProviderFolder(world.store, id, paths, join(provider, "next")), state).toBe("an earlier agent of the thread isn't proved stopped, so its folders weren't touched");
      expect(readFileSync(join(provider, "old", "keep.txt"), "utf8")).toBe("keep\n");
      world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), launch);
    }
    // Quiet: emptied and made again.
    expect(freshProviderFolder(world.store, id, paths, join(provider, "next"))).toBeNull();
    expect(existsSync(join(provider, "old"))).toBe(false);
    expect(existsSync(join(provider, "next"))).toBe(true);
  });
});

describe("lowering a thread's level at runtime", () => {
  test("mid-turn: the agent above the new level is stopped at once, its network closed, its turn interrupted; the next turn needs a fresh proof to go back up", async () => {
    const { id, paths } = await thread();
    const turn = admit(id);
    expect(beginFlexibleTurn(world.store, { turn, holder: "h1", clock: () => NOW })).toMatchObject({ ok: true });
    const running = agent(paths, "sh -c 'sleep 30' & sleep 30"); // the agent and a child of its own
    const launch = live(id, running.pid, running.start);
    const lowered = await lowerFlexibleThreadLevel(world.store, { thread: id, by: { name: "alex", generation: gen() }, level: "supervised", clock: () => NOW, io });
    expect(lowered).toEqual({ ok: true, level: "supervised", stopped: "stopped", message: "Lowered to Supervised; the current step was stopped." });
    await running.closed;
    expect(flexibleLaunch(world.store, launch)).toMatchObject({ state: "exited", stopReason: "lowered to Supervised" });
    expect(flexibleThread(world.store, id)!.livePid).toBeNull();
    expect(flexibleTurn(world.store, turn)).toMatchObject({ status: "interrupted" });
    expect(world.store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(id)!["level"]).toBe("supervised");
    // Going back up is a raise: a fresh proof. (Supervised itself isn't offered for any agent yet.)
    const again = (freshProof: boolean, level: "full" | "supervised") => admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: gen() }, digest, level, freshProof, provider: "claude",
      model: "claude-sonnet-4-5", billing: "subscription", requestKey: `r-${level}-${freshProof}`, holder: "h1", clock: () => NOW });
    expect(again(false, "full")).toMatchObject({ ok: false, reason: "proof-required" });
    expect(again(false, "supervised")).toMatchObject({ ok: false, reason: "level-unavailable" });
    expect(again(true, "full")).toMatchObject({ ok: true });
  }, 30_000);

  test("only the owner, only down; while something of the old agent survives, lowering is pending and no turn starts", async () => {
    const { id, paths } = await thread();
    expect(await lowerFlexibleThreadLevel(world.store, { thread: id, by: { name: "lee", generation: 1 }, level: "auto", clock: () => NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(await lowerFlexibleThreadLevel(world.store, { thread: id, by: { name: "alex", generation: gen() }, level: "auto", clock: () => NOW })).toMatchObject({ ok: true, stopped: "none" });
    expect(await lowerFlexibleThreadLevel(world.store, { thread: id, by: { name: "alex", generation: gen() }, level: "full", clock: () => NOW })).toMatchObject({ ok: false, reason: "not-lower" });
    // A program that isn't the agent's (older than it) works in the thread's folder: never signalled, custody pending.
    const outsider = agent(paths);
    await new Promise(done => setTimeout(done, 1_100));
    const running = agent(paths);
    live(id, running.pid, running.start, { level: "auto" });
    const lowered = await lowerFlexibleThreadLevel(world.store, { thread: id, by: { name: "alex", generation: gen() }, level: "supervised", clock: () => NOW, io });
    expect(lowered).toMatchObject({ ok: true, stopped: "pending", message: expect.stringContaining("Some of the agent's processes are still running") });
    expect(alive(outsider.pid)).toBe(true);
    expect(unsettledLaunch(world.store, id)!.state).toBe("unresolved");
    expect(admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: gen() }, digest, level: "full", freshProof: true, provider: "claude", model: "claude-sonnet-4-5",
      billing: "subscription", requestKey: "after", holder: "h1", clock: () => NOW })).toMatchObject({ ok: false, reason: "level-pending" });
    process.kill(-outsider.pid, "SIGKILL");
    await outsider.closed;
    expect(await recoverFlexibleLaunchesOf(world.store, { holder: "h1", clock: () => NOW, io })).toMatchObject({ ok: true, settled: 1, unresolved: 0 });
    expect(unsettledLaunch(world.store, id)).toBeNull();
  }, 30_000);
});

describe("the start gate", () => {
  test("the agent runs only after Toolroll writes `start`: if its input closes first (Toolroll died, or the registration failed), nothing runs", () => {
    const ran = join(world.dir, "gate-ran");
    const gate = (input: string | null) => spawnSync("/bin/sh", ["-c", FLEXIBLE_START_GATE, "toolroll-start-gate", "/bin/sh", "-c", `echo ran > ${JSON.stringify(ran)}; cat`], { input: input ?? "", encoding: "utf8" });
    expect(gate(null).status).toBe(125);
    expect(gate("go\n").status).toBe(125);
    expect(gate("start").status).toBe(125); // a line cut short by a crash isn't one
    expect(existsSync(ran)).toBe(false);
    const opened = gate("start\nhello agent\n");
    expect(opened.status).toBe(0);
    expect(opened.stdout).toBe("hello agent\n"); // the rest of the input is the agent's own
    expect(existsSync(ran)).toBe(true);
  });
});

describe("lowering and a turn start are never interleaved", () => {
  test("lowering withdraws every turn admitted above the new level, even one not started yet, so it can never begin", async () => {
    const { id } = await thread();
    const waiting = admit(id);
    expect(await lowerFlexibleThreadLevel(world.store, { thread: id, by: { name: "alex", generation: gen() }, level: "auto", clock: () => NOW })).toMatchObject({ ok: true, stopped: "none" });
    expect(flexibleTurn(world.store, waiting)).toMatchObject({ status: "withdrawn" });
    expect(beginFlexibleTurn(world.store, { turn: waiting, holder: "h1", clock: () => NOW })).toMatchObject({ ok: false, reason: "turn-not-admitted" });
    expect(await startFlexibleTurn(world.store, startInput(waiting))).toMatchObject({ ok: false, reason: "turn-not-admitted" });
    expect(launches()).toEqual([]);
  });
});

describe("a stopped launch's network ends at once, whichever process stops it", () => {
  test("a handle that fails to close is kept and tried again until it does", async () => {
    let tries = 0;
    onLaunchStopped("a".repeat(32), () => { tries++; if (tries === 1) throw new Error("busy"); });
    expect(await revokeLaunch("a".repeat(32))).toBe(1);
    expect(await revokeLaunch("a".repeat(32))).toBe(0);
    expect(tries).toBe(2);
    expect(await revokeLaunch("a".repeat(32))).toBe(0);
    expect(tries).toBe(2);
  });

  test("stopped by a process that doesn't hold the launch, with no confirmation from its holder: never called cut, unresolved", async () => {
    const { id, paths } = await thread();
    const running = agent(paths);
    const launch = live(id, running.pid, running.start, { held: false });
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "test", io })).toMatchObject({ ok: false, why: "the Toolroll process that started it hasn't confirmed its network handles closed yet" });
    await running.closed;
    expect(flexibleLaunch(world.store, launch)).toMatchObject({ state: "unresolved", networkClosedAt: null });
    // A holder proven gone (a restart) closed them with its process.
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "test", io, holderGone: true })).toMatchObject({ ok: true });
  }, 30_000);

  test("a network handle that fails to close keeps the launch unresolved (its processes are stopped anyway); once it closes, the stop settles", async () => {
    const { id, paths } = await thread();
    const running = agent(paths);
    const launch = live(id, running.pid, running.start);
    let failing = true;
    onLaunchStopped(launch, () => { if (failing) throw new Error("the proxy wouldn't close"); });
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "test", io })).toMatchObject({ ok: false, why: "1 of its network handles couldn't be closed yet; Toolroll keeps trying" });
    await running.closed; // the processes were stopped regardless
    expect(flexibleLaunch(world.store, launch)).toMatchObject({ state: "unresolved", networkClosedAt: null });
    failing = false;
    expect(await stopFlexibleThreadAgent(world.store, { id, reason: "test", io })).toMatchObject({ ok: true });
    expect(flexibleLaunch(world.store, launch)!.networkClosedAt).not.toBeNull();
  }, 30_000);

  test("the holder's watcher keeps trying through database errors, then closes its handles and confirms", async () => {
    const { id, paths } = await thread();
    const running = agent(paths);
    const launch = live(id, running.pid, running.start, { held: false });
    world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'unresolved' WHERE id = ?").run(launch); // stopped elsewhere
    let fails = 5, closed = 0;
    const flaky = new Proxy(world.store, { get(target, prop) {
      if (prop === "handle" && fails > 0) { fails--; throw new Error("database is locked"); }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    onLaunchStopped(launch, () => { closed++; });
    const stopWatching = watchLaunch(flaky, launch, paths.folder, io, 50);
    try {
      await until(() => closed === 1 && flexibleLaunch(world.store, launch)!.networkClosedAt !== null);
      expect(fails).toBe(0);
    } finally { stopWatching(); }
  }, 30_000);

  test("a second Toolroll process stops the thread: the relay grant is revoked in the database, and this holder's proxy closes as its watcher sees it", async () => {
    const { id, paths } = await thread();
    const turn = admit(id);
    expect(beginFlexibleTurn(world.store, { turn, holder: "h1", clock: () => NOW })).toMatchObject({ ok: true });
    const running = agent(paths);
    const launch = live(id, running.pid, running.start, { held: false }); // as if this process's watcher were the holder's
    const made = await startFlexibleRelay(world.store, { thread: id });
    if ("ok" in made) throw new Error(made.message);
    const endpoint = made.issue({ thread: id, turn, launch });
    // A call the token authorizes (it reaches the credential step: no Claude sign-in is kept here, so nothing is sent).
    const call = () => fetch(`${made.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1, messages: [] }) });
    let proxyClosed = 0;
    onLaunchStopped(launch, () => { proxyClosed++; });
    const stopWatching = watchLaunch(world.store, launch, paths.folder, io, 100);
    try {
      expect((await call()).status).toBe(503);
      const stopped = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SECOND_HOLDER], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 60_000,
          env: { ...process.env, FLEXIBLE_SECOND: JSON.stringify({ file: world.databaseFile, thread: id,
            modules: { store: new URL("./store.ts", import.meta.url).href, thread: new URL("./flexible-thread.ts", import.meta.url).href } }) } },
        (error, stdout, stderr) => error === null ? resolve(stdout) : reject(new Error(`${error.message}\n${stderr}`)));
      });
      // The other process stops every process of it and revokes its relay grant at once, but can't call the network cut
      // until this holder confirms its own proxy closed: unresolved, and it says why.
      // (This holder's watcher may confirm before the other process finishes; then that stop settles at once.)
      const result = JSON.parse(stopped) as { ok: boolean; why?: string };
      await running.closed;
      expect((await call()).status).toBe(401);
      await until(() => proxyClosed === 1);
      await until(() => flexibleLaunch(world.store, launch)!.networkClosedAt !== null);
      if (!result.ok) {
        expect(result.why).toBe("the Toolroll process that started it hasn't confirmed its network handles closed yet");
        // Confirmed: the next stop settles it.
        expect(await stopFlexibleThreadAgent(world.store, { id, reason: "test", io })).toMatchObject({ ok: true });
      }
      expect(flexibleLaunch(world.store, launch)!.state).toBe("exited");
      expect(flexibleTurn(world.store, turn)!.status).toBe("interrupted");
    } finally { stopWatching(); await made.close(); }
  }, 60_000);
});

describe("after a crash, and before removal or a project's deletion", () => {
  test("a launch left spawning (Toolroll died between the spawn and its registration) never ran: recovery settles it and ends the holder's turns", async () => {
    const { id } = await thread();
    const turn = admit(id, { holder: "gone" });
    expect(beginFlexibleTurn(world.store, { turn, holder: "gone", clock: () => NOW })).toMatchObject({ ok: true });
    world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, state, started_at)
      VALUES (?, ?, 'claude', 'full', ?, 'gone', 'here', ?, 'spawning', ?)`).run("d".repeat(32), id, "f".repeat(32), "9".repeat(32), NOW.toISOString());
    expect(await recoverFlexibleLaunchesOf(world.store, { holder: "gone", clock: () => NOW, io })).toEqual({ ok: true, settled: 1, unresolved: 0, withdrawn: 0, interrupted: 1 });
    expect(flexibleLaunch(world.store, "d".repeat(32))).toMatchObject({ state: "exited", endDetail: "its start gate never opened, so its agent never ran" });
    expect(flexibleTurn(world.store, turn)!.status).toBe("interrupted");
  });

  test("removal: refused while the agent runs; a survivor of a gone agent that only shares the thread's folder blocks it (named, never signalled) until it's gone", async () => {
    const { id, paths } = await thread();
    const running = agent(paths);
    live(id, running.pid, running.start);
    expect(await removeFlexibleThread(world.store, { id, by: "alex", now: NOW, io })).toMatchObject({ ok: false, reason: "thread-running" });
    // The agent's own process ends, leaving a setsid + double-forked survivor in the thread's folder.
    process.kill(-running.pid, "SIGKILL");
    await running.closed;
    world.store.handle.prepare("DELETE FROM flexible_thread_launch").run();
    const file = join(world.dir, "survivor.pid");
    const leader = agent(paths, `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; open(my $f, ">", "${file}"); print $f $$; close $f; sleep 30'; sleep 0.3`);
    live(id, leader.pid, leader.start);
    await leader.closed;
    await until(() => existsSync(file));
    const survivor = Number((await import("node:fs")).readFileSync(file, "utf8"));
    // Relaunch, removal and a project's deletion wait on custody.
    expect(projectRunning(world.store, world.project, NOW)).toEqual(["a Flexible thread's agent is still running", "1 Flexible thread is still open (remove it first)"]);
    expect(await removeFlexibleThread(world.store, { id, by: "alex", now: NOW, io })).toMatchObject({ ok: false, reason: "thread-running", message: expect.stringContaining(`process ${survivor} is using the thread's folder`) });
    expect(alive(survivor)).toBe(true);
    expect(existsSync(paths.folder)).toBe(true);
    process.kill(survivor, "SIGKILL");
    await until(() => !alive(survivor));
    expect(await removeFlexibleThread(world.store, { id, by: "alex", now: NOW, io })).toMatchObject({ ok: true });
    expect(existsSync(paths.folder)).toBe(false);
    expect(launches()).toEqual([expect.objectContaining({ state: "exited" })]);
  }, 30_000);

  test("a project with an open Flexible thread isn't deleted; once its threads are removed, it is, with their records", async () => {
    const { id } = await thread();
    const refused = await deleteProject(world.store, world.project, { actor: "alex", via: "command line", now: NOW, evidenceRoot: null, poolRoot: null });
    expect(refused).toMatchObject({ ok: false, reason: "running", said: "Nothing was deleted: 1 Flexible thread is still open (remove it first). Stop it, then try again." });
    expect(await removeFlexibleThread(world.store, { id, by: "alex", now: NOW, io })).toMatchObject({ ok: true });
    expect(await deleteProject(world.store, world.project, { actor: "alex", via: "command line", now: NOW, evidenceRoot: null, poolRoot: null })).toMatchObject({ ok: true });
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()!["n"]).toBe(0);
  });
});

/** Another Toolroll process (its own database handle; the build's constant replaced by a module hook as vi.mock does
 * here) stopping a thread. */
const SECOND_HOLDER = `
const env = JSON.parse(process.env.FLEXIBLE_SECOND);
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent("export async function resolve(specifier, context, next) { if (/flexible-available\\\\.(js|ts)$/.test(specifier)) return { url: 'data:text/javascript,export const flexibleAvailable = () => true; export const flexibleSetting = () => ({ on: true, by: null, at: null }); export const setFlexibleSetting = () => ({ changed: false }); export const FLEXIBLE_SETTING_ACTION = null;', shortCircuit: true }; return next(specifier, context); }"));
const { openStore } = await import(env.modules.store);
const { stopFlexibleThreadAgent } = await import(env.modules.thread);
const store = openStore(env.file);
const result = await stopFlexibleThreadAgent(store, { id: env.thread, reason: "stopped from another process" });
store.close();
process.stdout.write(JSON.stringify(result));
`;
