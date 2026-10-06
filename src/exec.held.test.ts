import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClaudeHeldSession, heldSocketPathProblem, HELD_SOCKET_PATH_LIMIT } from "./exec.js";
import { fakePid } from "../test/fake-pid.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

/**
 * The held transport against REAL processes: a fake agent that speaks just
 * enough stream-json, under the real supervisor.mjs, with the real byte
 * relay, control sockets, and fences. No claude binary is involved.
 */

/**
 * The tool a fake agent leaves behind. It writes its PID to a checkpoint so the
 * test can end it, and it ends itself once that checkpoint is removed (the test
 * directory goes in afterAll) or after a minute, so a missed cleanup can never
 * leave it running after the suite.
 */
const TOOL_FIXTURE = [
  "const fs=require('node:fs');const at=process.argv[1];const born=Date.now();",
  "fs.writeFileSync(at,String(process.pid));",
  "setInterval(()=>{if(!fs.existsSync(at)||Date.now()-born>60000)process.exit(0)},100)",
].join("");

/** The process group the fake agent forges in a control frame of its own. */
const FORGED_PGID = fakePid(1);

const FAKE_AGENT = `
const TOOL_FIXTURE = ${JSON.stringify(TOOL_FIXTURE)};
process.stdin.setEncoding("utf8");
let buf = "";
let n = 0;
const mode = process.argv[2] ?? "echo";
if(mode === "detached" || mode === "inherited" || mode === "escaped-relay") {
 const {spawn}=require("node:child_process");
 spawn(process.execPath,["-e",TOOL_FIXTURE,process.argv[3]],{detached:mode !== "inherited",stdio:mode === "detached" ? "ignore" : ["ignore","inherit","inherit"]}).unref();
}
process.stdin.on("data", c => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (mode === "silent") continue;
    n += 1;
    if (mode === "frame-noise" && n === 1) {
      console.log(JSON.stringify({ so_supervisor: "ready", agentPgid: ${FORGED_PGID} }));
      console.log(JSON.stringify({ so_supervisor: "observation-failed", failure: { phase: "final-exit", operation: "snapshot", code: "EMFILE", rootPid: process.pid, at: new Date().toISOString(), identityUnknown: false } }));
    }
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "  sess-fake  " }));
    console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: null }));
    // One JSON line emitted in TWO chunks: the relay and the transport's
    // line assembly must be byte-exact across the seam.
    const result = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: n * 0.01, usage: { output_tokens: n }, result: "turn " + n });
    const cut = Math.floor(result.length / 2);
    process.stdout.write(result.slice(0, cut));
    setTimeout(() => process.stdout.write(result.slice(cut) + "\\n"), 15);
  }
});
process.stdin.on("end", () => {
  if (mode === "unsettled") { process.exit(126); }
  if (mode === "silent" || mode === "detached") { setInterval(() => {}, 1000); return; }
  setTimeout(() => process.exit(0), 40);
});
`;

let dir = "";
let agentPath = "";
let socketN = 0;
const socket = (): string => {
  socketN += 1;
  return join(tmpdir(), `so-held-${process.pid}-${socketN}.sock`);
};
const turn = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
/** Poll until `ready` returns a value, or fail naming what never happened. */
const waitFor = async <T>(what: string, ms: number, ready: () => T | undefined): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = ready();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
    await new Promise(pass => setTimeout(pass, 20));
  }
};
/** The PID a tool fixture wrote. The file exists before its bytes land, so
 * an empty read is "not yet", never PID 0 (which kill() takes as our group). */
const checkpointPid = (checkpoint: string): number | undefined => {
  const pid = existsSync(checkpoint) ? Number(readFileSync(checkpoint, "utf8")) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};
/** End every tool fixture that wrote a checkpoint, whether or not the product
 * fenced it. Runs after each test, pass or fail, so no fixture outlives it. */
const releaseFixtures = async (): Promise<void> => {
  if (!dir || !existsSync(dir)) return;
  const pids = readdirSync(dir).filter(name => name.endsWith("-pid")).map(name => {
    const path = join(dir, name);
    const pid = Number(readFileSync(path, "utf8"));
    rmSync(path, { force: true });
    return pid;
  }).filter(pid => Number.isInteger(pid) && pid > 0);
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise(pass => setTimeout(pass, 20));
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "so-held-test-"));
  agentPath = join(dir, "fake-agent.cjs");
  writeFileSync(agentPath, FAKE_AGENT);
});
afterEach(releaseFixtures);
afterAll(async () => {
  await releaseFixtures();
  rmSync(dir, { recursive: true, force: true });
});

describe("the held-session transport under the real supervisor", () => {
  test("an unsettled supervisor records custody uncertainty before the exit callback", async () => {
    const order: string[] = [];
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "unsettled"], {
      socketPath: socket(), cookie: "c".repeat(32),
      onUnknown: () => { order.push("unknown"); },
      events: { onExit: info => { order.push(`exit:${info.code}`); } },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    start.handle.endInput();
    expect(await start.handle.exited).toEqual({ code: 126 });
    expect(order).toEqual(["unknown", "exit:126"]);
  });
  test("ready frame, per-turn init/result counting, session id, clean EOF exit", async () => {
    const inits: number[] = [];
    const results: Array<{ seq: number; cost: unknown }> = [];
    let sessionId = "";
    const start = await startClaudeHeldSession(process.execPath, [agentPath], {
      socketPath: socket(),
      cookie: "c".repeat(32),
      events: {
        onTurnInit: seq => inits.push(seq),
        onTurnResult: (seq, event) => results.push({ seq, cost: event["total_cost_usd"] }),
        onSessionId: id => {
          sessionId = id;
        },
      },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.handle.agentPgid).toBeGreaterThan(0);
    expect(start.handle.supervisorPid).toBeGreaterThan(0);

    expect(start.handle.writeTurn(turn("one"))).toBe(true);
    await new Promise(pass => setTimeout(pass, 300));
    expect(inits).toEqual([1]);
    expect(results).toEqual([{ seq: 1, cost: 0.01 }]);
    expect(sessionId).toBe("sess-fake");

    expect(start.handle.writeTurn(turn("two"))).toBe(true);
    await new Promise(pass => setTimeout(pass, 300));
    expect(inits).toEqual([1, 2]);
    expect(results.map(one => one.seq)).toEqual([1, 2]);
    // cumulative totals rode through the relay byte-exact across the split write
    expect(results[1]?.cost).toBe(0.02);

    start.handle.endInput();
    const exit = await start.handle.exited;
    expect(exit.code).toBe(0);
  });

  test("a fake control frame mid-stream is dropped — never a second start, never a stream event", async () => {
    const seen: string[] = [];
    const diagnostics: unknown[] = [];
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "frame-noise"], {
      onObservationFailure: failure => diagnostics.push(failure),
      socketPath: socket(),
      cookie: "c".repeat(32),
      events: { onStreamEvent: event => seen.push(String(event["type"] ?? event["so_supervisor"] ?? "?")) },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    // the REAL frame carried a real pgid, not the agent's forged one
    expect(start.handle.agentPgid).not.toBe(FORGED_PGID);
    start.handle.writeTurn(turn("one"));
    await new Promise(pass => setTimeout(pass, 300));
    expect(seen).not.toContain("undefined");
    expect(diagnostics).toEqual([]);
    expect(seen.filter(one => one === "system").length).toBe(1);
    start.handle.endInput();
    await start.handle.exited;
  });

  test("a missing agent binary answers spawn-failed through the two-hop handshake", async () => {
    const start = await startClaudeHeldSession(join(dir, "no-such-binary"), [], {
      socketPath: socket(),
      cookie: "c".repeat(32),
    });
    expect(start).toMatchObject({ ok: false, reason: "spawn-failed" });
  });

  test("rejected supervisor custody is reaped before spawn failure returns", async () => {
    let pid = 0;
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "silent"], {
      socketPath: socket(), cookie: "c".repeat(32),
      onSpawn: child => { pid = child; throw new Error("custody write refused"); },
    });
    expect(start).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("an oversized socket path refuses BEFORE anything spawns", async () => {
    const long = join(tmpdir(), `${"x".repeat(HELD_SOCKET_PATH_LIMIT)}.sock`);
    expect(heldSocketPathProblem(long)).not.toBeNull();
    const start = await startClaudeHeldSession(process.execPath, [agentPath], {
      socketPath: long,
      cookie: "c".repeat(32),
    });
    expect(start).toMatchObject({ ok: false, reason: "socket-path" });
  });

  test("the control socket: status with the cookie, refusal without, kill settles the group", async () => {
    const path = socket();
    const cookie = "d".repeat(32);
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "silent"], {
      socketPath: path,
      cookie,
      graceMs: 60_000,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    const ask = (payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((pass, fail) => {
        const wire = connect(path, () => {
          wire.write(`${JSON.stringify(payload)}\n`);
        });
        let answer = "";
        wire.on("data", chunk => {
          answer += String(chunk);
        });
        wire.on("end", () => {
          try {
            pass(JSON.parse(answer) as Record<string, unknown>);
          } catch (error) {
            fail(error as Error);
          }
        });
        wire.on("error", fail);
      });

    const status = await ask({ cookie, verb: "status" });
    expect(status).toMatchObject({ ok: true, alive: true });
    expect(status["agentPgid"]).toBe(start.handle.agentPgid);

    const refused = await ask({ cookie: "wrong", verb: "kill" });
    expect(refused).toMatchObject({ ok: false });
    // the wrong cookie killed nothing
    expect(await ask({ cookie, verb: "status" })).toMatchObject({ ok: true, alive: true });

    const killed = await ask({ cookie, verb: "kill" });
    expect(killed).toMatchObject({ ok: true, killed: true, settled: true });
    const exit = await start.handle.exited;
    expect(exit.code === 0).toBe(false);
  }, 20_000);

  test.each(["detached", "inherited"])("held shutdown drains a %s tool even when it retains the relay", async mode => {
    const checkpoint = join(dir, `${mode}-pid`);
    const start = await startClaudeHeldSession(process.execPath, [agentPath, mode, checkpoint], {
      socketPath: socket(), cookie: "c".repeat(32), graceMs: 200,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    try {
      const pid = await waitFor(`the ${mode} tool to write its PID to ${checkpoint}`, 15_000, () => checkpointPid(checkpoint));
      start.handle.terminate();
      const exited = await start.handle.exited;
      if (mode === "inherited") expect(exited.code).toBe(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { start.handle.terminate(); await start.handle.exited; }
  });

  test("stdin EOF fences autonomously: grace, then the group dies without any order", async () => {
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "silent"], {
      socketPath: socket(),
      cookie: "e".repeat(32),
      graceMs: 1_200,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    start.handle.endInput();
    const exit = await start.handle.exited;
    // killed, not clean — the silent agent never honors EOF
    expect(exit.code === 0).toBe(false);
  }, 20_000);

  test("an escaped tool retaining the relay yields bounded uncertainty rather than a hung or successful hold", async () => {
    const checkpoint = join(dir, "escaped-relay-pid");
    let unknown = false;
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "escaped-relay", checkpoint], {
      socketPath: socket(), cookie: "c".repeat(32), onUnknown: () => { unknown = true; },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(checkpoint) && Date.now() < deadline) await new Promise(pass => setTimeout(pass, 20));
      expect(existsSync(checkpoint)).toBe(true);
      start.handle.endInput();
      expect(await start.handle.exited).toEqual({ code: 126 });
      expect(unknown).toBe(true);
    } finally {
      // The fixture deliberately leaves a live tool beyond observed custody.
      // afterEach releases only that fixture process; production recovery
      // never signals a saved PID after its owned ancestry has disappeared.
      start.handle.terminate(); await start.handle.exited;
    }
  }, 12000);

  test("SIGTERM takes the same fence road (the hard-stop sweep's contract)", async () => {
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "silent"], {
      socketPath: socket(),
      cookie: "f".repeat(32),
      graceMs: 1_200,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    start.handle.terminate();
    const exit = await start.handle.exited;
    expect(exit.code === 0).toBe(false);
  }, 20_000);
});

describe("the tool fixture never outlives the suite", () => {
  const orphan = async (checkpoint: string): Promise<number> => {
    // The fake agent alone, with no supervisor to fence it: its detached tool
    // is orphaned once the agent dies, just as when a real fence fails.
    const agent = spawn(process.execPath, [agentPath, "detached", checkpoint], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      return await waitFor(`the detached tool to write its PID to ${checkpoint}`, 15_000, () => checkpointPid(checkpoint));
    } finally {
      agent.kill("SIGKILL");
      await new Promise(pass => { if (agent.exitCode !== null || agent.signalCode !== null) pass(null); else agent.once("exit", pass); });
    }
  };
  // Well inside the fixture's own one-minute limit, so ending in time proves
  // the path under test rather than that fallback.
  const gone = async (pid: number, after: string): Promise<boolean> =>
    waitFor(`tool ${pid} to end ${after}`, 15_000, () => (alive(pid) ? undefined : true));

  test("the cleanup after each test ends a tool that escaped every fence", async () => {
    const pid = await orphan(join(dir, "orphan-pid"));
    expect(alive(pid)).toBe(true);
    await releaseFixtures();
    expect(await gone(pid, "after the cleanup")).toBe(true);
  });

  test("a tool ends itself once its checkpoint is removed", async () => {
    const checkpoint = join(dir, "self-ending-pid");
    const pid = await orphan(checkpoint);
    rmSync(checkpoint);
    expect(await gone(pid, "once its checkpoint was removed")).toBe(true);
  });
});

describe("the held invocation gateway", () => {
  test("verifies the open run, refuses non-claude, stamps provider start BEFORE the spawn, and threads the session id", async () => {
    const { openStore } = await import("./store.js");
    const { invokeHeldAgent } = await import("./invoke.js");
    const { register } = await import("./runner.js");
    const { acquire } = await import("./claim.js");
    const T0 = new Date("2026-08-25T22:00:00.000Z");
    const store = openStore(":memory:");
    store.createTask({ id: "t-gw", title: "gateway" }, T0);
    const ref = store.refFor("built-in", "t-gw");
    // The runner gate's spawn leg (MCP spec v6): the run's lease is REAL —
    // registered runner, placed task, acquired claim. The TTL outlives the
    // gateway's wall clock.
    const REPO = "/repo/held-gw";
    store.placeTask(ref.id, REPO);
    register(store, { name: "w", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-w" });
    const claimed = acquire(store, ref.id, "w", {
      now: T0,
      token: "tok-w",
      ttlMs: 10 * 365 * 24 * 3_600_000,
      newLeaseId: () => "lease-gw",
    });
    expect(claimed.ok).toBe(true);
    const run = store.startRun({ taskRef: ref.id, leaseId: "lease-gw", runner: "w", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const starter = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ file, args });
      // the provider-start stamp must already be durable at spawn time
      expect(store.getRun(run)?.providerStartedAt).not.toBeNull();
      (options["events"] as { onSessionId?: (id: string) => void }).onSessionId?.("  sess-gw  ");
      return Promise.resolve({ ok: false as const, reason: "spawn-failed" as const, message: "fake" });
    }) as never;

    const start = await invokeHeldAgent(
      store,
      run,
      { provider: "claude", model: "sonnet" },
      ["-p", "--input-format", "stream-json"],
      { socketPath: "/tmp/so-gw.sock", cookie: "c".repeat(32), starter },
    );
    expect(start).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.file).toBe("claude");
    expect(store.getRun(run)?.sessionId).toBe("sess-gw");

    // a finished run never spawns
    store.finishRun(run, { outcome: "failed", reason: "test", now: T0 });
    await expect(
      invokeHeldAgent(store, run, { provider: "claude", model: null }, [], {
        socketPath: "/tmp/so-gw.sock",
        cookie: "c".repeat(32),
        starter,
      }),
    ).rejects.toThrow(/not an open attempt/);
    store.close();
  });
});
