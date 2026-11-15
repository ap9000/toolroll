/**
 * Flexible threads, slice F2c (flexible-agents.ts, flexible-levels.ts, flexible-launch.ts): the relay stand-in refuses
 * every call; each relay-tier agent's Full access and nothing else; the proven matrix under each ceiling; a turn start
 * that refuses (its admission no longer stands, its agent or level isn't offered, another agent still runs) spawns
 * nothing and leaves custody as it was; lowering mid-turn stops the agent and interrupts its turn, or stays pending
 * while something survives; recovery after a crash (a launch left spawning, survivors of a live one); removal and a
 * project's deletion wait for custody. Real processes stand in for an agent where custody is the point (no sandbox:
 * the fenced rows are test/attacks/flexible-thread-custody.slow.test.ts). No model is called anywhere.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { FLEXIBLE_START_GATE, prepareFlexibleThread, removeFlexibleThread, flexibleThread, type FlexibleThreadPaths } from "./flexible-thread.js";
import { spawnSync } from "node:child_process";
import { flexibleAgentLaunch, lowerFlexibleThreadLevel, recoverFlexibleLaunchesOf, RELAY_STUB_REFUSAL, startFlexibleRelayStub, startFlexibleTurn, type FlexibleRelayStub } from "./flexible-agents.js";
import { FLEXIBLE_PROVEN, threadLevelAllowed } from "./flexible-levels.js";
import { flexibleLaunch, unsettledLaunch } from "./flexible-launch.js";
import { realCustodyIO, startIdentityOf } from "./flexible-custody.js";
import { deleteProject, projectRunning } from "./project-delete.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

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
  relay: { url: "http://127.0.0.1:1", token: "relay-token", revoke: () => {} }, storage: STORAGE, ...over });
/** A real process standing in for a thread's agent: its own group, working in the thread's repository. */
function agent(paths: FlexibleThreadPaths, script = "sleep 30"): { pid: number; start: string; closed: Promise<void> } {
  const child = spawn("/bin/sh", ["-c", script], { cwd: paths.repo, detached: true, stdio: "ignore" });
  children.push(child);
  return { pid: child.pid!, start: startIdentityOf(child.pid!, io)!, closed: new Promise(done => child.once("close", () => done())) };
}
/** A live launch on the record for `pid`, as flexibleThreadSpawn registers one. */
function live(id: string, pid: number, start: string, over: { level?: string; state?: string; holder?: string } = {}): string {
  const launch = `${pid.toString(16).padStart(8, "0")}${"0".repeat(24)}`;
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, 'claude', ?, ?, ?, 'here', ?, ?, ?, ?, ?)`).run(launch, id, over.level ?? "full", "f".repeat(32), over.holder ?? "h1", "9".repeat(32), pid, start, over.state ?? "live", NOW.toISOString());
  world.store.handle.prepare("UPDATE flexible_thread SET live_pid = ?, live_since = ? WHERE id = ?").run(pid, NOW.toISOString(), id);
  return launch;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await new Promise(done => setTimeout(done, 100)); expect(test()).toBe(true); };

describe("the relay's stand-in", () => {
  let stub: FlexibleRelayStub;
  beforeEach(async () => { const made = await startFlexibleRelayStub(); if ("ok" in made) throw new Error(made.message); stub = made; });
  afterEach(async () => { await stub.close(); });

  test("refuses every call, with a token, without one, after it was revoked, on every route and method; tunnels and upgrades get nothing", async () => {
    const endpoint = stub.issue();
    expect(endpoint.url).toBe(stub.url);
    expect(stub.live()).toBe(1);
    const tries: [string, RequestInit][] = [
      ["/v1/messages", { method: "POST", headers: { "x-api-key": endpoint.token, authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1, messages: [] }) }],
      ["/v1/messages/count_tokens", { method: "POST", headers: { authorization: `Bearer ${endpoint.token}` }, body: "{}" }],
      ["/v1/models", { method: "GET" }],
      ["/../../etc/passwd", { method: "GET" }],
      ["/v1beta/models/gemini:generateContent", { method: "POST", headers: { "x-goog-api-key": endpoint.token }, body: "{}" }],
    ];
    for (const [path, init] of tries) {
      const answer = await fetch(`${stub.url}${path}`, init);
      expect(answer.status, path).toBe(503);
      expect(await answer.json()).toEqual({ type: "error", error: { type: "relay_unavailable", message: RELAY_STUB_REFUSAL } });
    }
    endpoint.revoke();
    expect(stub.live()).toBe(0);
    expect((await fetch(`${stub.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}` }, body: "{}" })).status).toBe(503);
    const { connect } = await import("node:net");
    const tunnel = await new Promise<string>(done => {
      const socket = connect(Number(new URL(stub.url).port), "127.0.0.1", () => socket.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n"));
      let said = "";
      socket.on("data", chunk => { said += chunk; });
      socket.on("close", () => done(said));
    });
    expect(tunnel).toMatch(/^HTTP\/1\.1 403/);
    expect(stub.refused()).toBe(tries.length + 2);
  });
});

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

  test("a level the agent isn't offered at (the matrix changed since admission), or another agent still running: withdrawn, nothing stopped or started", async () => {
    const { id, paths } = await thread();
    const turn = admit(id);
    const closed = { proxy: 0, relay: 0 };
    const noClaude = { ...FLEXIBLE_PROVEN, claude: { ...FLEXIBLE_PROVEN.claude, full: { offered: false as const, why: "test" } } };
    expect(await startFlexibleTurn(world.store, startInput(turn, { proven: noClaude, network: { proxyPort: 41_000, token: "t", proxyEnv: {}, close: () => { closed.proxy++; } } }))).toMatchObject({ ok: false, reason: "level-unavailable" });
    expect(flexibleTurn(world.store, turn)!.status).toBe("withdrawn");
    // Another agent of the thread's still runs at another level: the turn waits for it, and it is left as it is.
    const other = agent(paths);
    const launch = live(id, other.pid, other.start, { level: "auto" });
    const next = admitFlexibleTurn(world.store, { thread: id, starter: { name: "alex", generation: gen() }, digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5",
      billing: "subscription", requestKey: "m-x", holder: "h1", clock: () => NOW });
    expect(next).toMatchObject({ ok: false, reason: "level-pending" });
    world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), launch);
    const raced = admit(id);
    world.store.handle.prepare("DELETE FROM flexible_thread_launch").run();
    live(id, other.pid, other.start, { level: "auto" });
    expect(await startFlexibleTurn(world.store, startInput(raced, { relay: { url: "http://127.0.0.1:1", token: "r", revoke: () => { closed.relay++; } } }))).toMatchObject({ ok: false, reason: "level-pending" });
    expect(flexibleTurn(world.store, raced)!.status).toBe("withdrawn");
    expect(alive(other.pid)).toBe(true);
    expect(unsettledLaunch(world.store, id)!.state).toBe("live");
    expect(closed).toEqual({ proxy: 0, relay: 0 });
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

  test("removal: refused while the agent runs; a survivor of a gone agent is found and stopped first, then the thread goes", async () => {
    const { id, paths } = await thread();
    const running = agent(paths);
    live(id, running.pid, running.start);
    expect(await removeFlexibleThread(world.store, { id, by: "alex", now: NOW, io })).toMatchObject({ ok: false, reason: "thread-running" });
    // The agent's own process ends, leaving a setsid + double-forked survivor in the thread's folder.
    world.store.handle.prepare("DELETE FROM flexible_thread_launch").run();
    const file = join(world.dir, "survivor.pid");
    const leader = agent(paths, `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; open(my $f, ">", "${file}"); print $f $$; close $f; sleep 30'; sleep 0.3`);
    live(id, leader.pid, leader.start);
    await leader.closed;
    await until(() => existsSync(file));
    const survivor = Number((await import("node:fs")).readFileSync(file, "utf8"));
    expect(alive(survivor)).toBe(true);
    // Relaunch and removal wait on custody: a project's deletion too.
    expect(projectRunning(world.store, world.project, NOW)).toEqual(["a Flexible thread's agent is still running", "1 Flexible thread is still open (remove it first)"]);
    expect(await removeFlexibleThread(world.store, { id, by: "alex", now: NOW, io })).toMatchObject({ ok: true });
    await until(() => !alive(survivor));
    expect(existsSync(paths.folder)).toBe(false);
    expect(launches()).toEqual([expect.objectContaining({ state: "exited" })]);
    expect(world.store.handle.prepare("SELECT action FROM action_ledger WHERE action = 'flexible agent stopped'").all()).toHaveLength(1);
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
