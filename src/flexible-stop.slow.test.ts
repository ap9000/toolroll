/**
 * Interactive agent threads turned off while a thread's agent RUNS (flexible-available.ts), with the real switch and a
 * real stand-in process tree for the agent (`sh` and its `sleep`, its own process group, recorded by pid and start
 * identity as flexibleThreadSpawn records a launch): no model, no fence needed for the stop itself.
 * - The console's scheduled upkeep (serve.ts's five-second tick) stops it: the tree gone, the launch exited, the turn
 *   interrupted.
 * - A stop that can't be verified the first time keeps its retry target (the session, and the launch unresolved on the
 *   record), and a later upkeep stops it.
 * - `toolroll config set flexible off` with no console at all (the one that started it crashed) stops it by the
 *   recorded identities, interrupts its turn and says what it stopped.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { flexibleAvailable, setFlexibleSetting } from "./flexible-available.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { prepareFlexibleThread } from "./flexible-thread.js";
import { defaultCustodyIO, holdLaunch } from "./flexible-launch.js";
import { startIdentityOf, type CustodyIO } from "./flexible-custody.js";
import { FLEXIBLE_RELAY_CREDENTIAL } from "./flexible-relay.js";
import { attachFlexibleAgent, openFlexibleSessions, settleFlexibleStops, startFlexibleThreadSession, type FlexibleSessions } from "./flexible-session.js";
import { writeHeldSecret } from "./tool-secret-store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate, EXIT } from "./operate.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";

const NOW = new Date();
const io = defaultCustodyIO();
let world: ThreadWorld, password: string, digest: string, thread: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  world = threadWorld();
  const alex = addApprover(world.store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  password = alex.token;
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: world.store.accountOf("alex")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full",
    max: "full", default: "full", network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  writeHeldSecret(world.state, FLEXIBLE_RELAY_CREDENTIAL.name, FLEXIBLE_RELAY_CREDENTIAL.file, JSON.stringify({ kind: "setup-token", value: ["sk", "ant", "oat01", randomBytes(24).toString("hex")].join("-") }));
  setFlexibleSetting(world.store, true, "alex", NOW);
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  thread = made.thread.id;
});
afterEach(() => {
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

/** A running stand-in agent: `sh` with a `sleep` under it, its own process group, in the thread's own copy. */
function agent(): ChildProcess {
  const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { cwd: join(world.state, "threads", thread, "repo"), detached: true, stdio: ["pipe", "pipe", "ignore"] });
  children.push(child);
  return child;
}
/** Its turn (admitted and running) and its launch, live on the record under `holder`, as a thread start leaves them. */
function launched(child: ChildProcess, holder: string): { turn: string; launch: string } {
  const admitted = admitFlexibleTurn(world.store, { thread, starter: { name: "alex", generation: world.store.accountOf("alex")!.generation }, digest, level: "full", freshProof: true,
    provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${randomBytes(4).toString("hex")}`, holder, clock: () => NOW });
  if (!admitted.ok) throw new Error(admitted.message);
  const begun = beginFlexibleTurn(world.store, { turn: admitted.turn, holder, clock: () => NOW });
  if (!begun.ok) throw new Error(begun.message);
  const launch = randomBytes(16).toString("hex");
  const start = startIdentityOf(child.pid!, io);
  if (start === null) throw new Error("the stand-in's start identity can't be read");
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, ?, 'live', ?)`).run(launch, thread, admitted.turn, "f".repeat(32), holder, "9".repeat(32), child.pid!, start, NOW.toISOString());
  world.store.handle.prepare("UPDATE flexible_thread SET live_pid = ?, live_since = ? WHERE id = ?").run(child.pid!, NOW.toISOString(), thread);
  return { turn: admitted.turn, launch };
}
const groupGone = (pid: number): boolean => { try { process.kill(-pid, 0); return false; } catch { return true; } };
const launchState = (launch: string) => world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(launch)?.["state"];
/** Waits on a fact, polling it, up to a ceiling. */
async function until(fact: () => boolean, ceilingMs: number): Promise<void> {
  const end = Date.now() + ceilingMs;
  while (!fact() && Date.now() < end) await new Promise(done => setTimeout(done, 100)); // guard: bound poll interval; the wait is on the fact
  expect(fact()).toBe(true);
}
/** This process named as a console holds threads (flexible-session.ts holderOf). */
const consoleHolder = (): string => `console:${process.pid}:${createHash("sha256").update(startIdentityOf(process.pid, io)!, "utf8").digest("hex").slice(0, 16)}`;

describe("turned off while an agent runs", () => {
  test("the console's scheduled upkeep stops the running tree: gone, launch exited, turn interrupted", async () => {
    const child = agent();
    const { turn, launch } = launched(child, consoleHolder());
    // The console's own handles on it, as flexibleThreadSpawn holds the child it spawned.
    holdLaunch(launch, child);
    const server: Server = createDecisionServer({ store: world.store, evidenceRoot: join(world.dir, "evidence"), repos: [world.project], clock: () => new Date() });
    try {
      expect(groupGone(child.pid!)).toBe(false);
      setFlexibleSetting(world.store, false, "alex", new Date());
      // Nothing here stops it but the console's own tick (every five seconds).
      await until(() => launchState(launch) === "exited", 20_000);
      await until(() => groupGone(child.pid!), 5_000);
      expect(flexibleTurn(world.store, turn)!.status).toBe("interrupted");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60_000);

  test("a stop that can't be verified keeps its retry target, and a later upkeep stops the tree", async () => {
    // The first stop's signals never leave (a stand-in for a process that survives it); later ones do.
    let blocked = true;
    const flaky: CustodyIO = { ...io, signal: (targets, signal) => blocked ? new Map(targets.map(one => [one.pid, "unavailable" as const])) : io.signal(targets, signal) };
    const opened = openFlexibleSessions(world.store, { io: flaky });
    if (!opened.ok) throw new Error(opened.message);
    const sessions: FlexibleSessions = opened.sessions;
    try {
      const child = agent();
      const { turn, launch } = launched(child, sessions.holder);
      holdLaunch(launch, child);
      expect(await startFlexibleThreadSession(world.store, sessions, { thread })).toMatchObject({ ok: true });
      expect(attachFlexibleAgent(world.store, sessions, { thread, turn, launch, stdout: child.stdout ?? new PassThrough(), stdin: child.stdin!, exited: listener => { child.once("exit", listener); } })).toEqual({ ok: true });
      setFlexibleSetting(world.store, false, "alex", new Date());
      expect(await settleFlexibleStops(world.store, sessions)).toEqual({ ok: true, stopped: 0, pending: 1 });
      expect(groupGone(child.pid!)).toBe(false);
      expect(launchState(launch)).toBe("unresolved");
      expect(sessions.threads.has(thread)).toBe(true);
      expect(flexibleTurn(world.store, turn)!.status).toBe("running");
      blocked = false;
      expect(await settleFlexibleStops(world.store, sessions)).toEqual({ ok: true, stopped: 1, pending: 0 });
      await until(() => groupGone(child.pid!), 5_000);
      expect(launchState(launch)).toBe("exited");
      expect(sessions.threads.has(thread)).toBe(false);
      expect(flexibleTurn(world.store, turn)!.status).toBe("interrupted");
    } finally {
      for (const one of sessions.threads.values()) await one.relay?.close();
      sessions.catalog.close();
    }
  }, 60_000);

  test("`toolroll config set flexible off` with no console running stops it by its recorded identity, ends its turn and says so", async () => {
    // The console that started it crashed: its holder names a process that isn't real.
    const child = agent();
    const { turn, launch } = launched(child, `console:${fakePid(9)}:${"0".repeat(16)}`);
    const lines: string[] = [];
    const code = await runOperate("config", ["set", "flexible", "off", "--json", "--as", "alex", "--token", password], line => lines.push(line), { databaseFile: world.databaseFile });
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, flexible: { on: false }, stopped: [{ thread, network: false }], survivors: [] });
    expect(flexibleAvailable(world.store)).toBe(false);
    await until(() => groupGone(child.pid!), 5_000);
    expect(launchState(launch)).toBe("exited");
    expect(flexibleTurn(world.store, turn)!.status).toBe("interrupted");
    // Said in words too.
    const words: string[] = [];
    expect(await runOperate("config", ["set", "flexible", "off", "--as", "alex", "--token", password], line => words.push(line), { databaseFile: world.databaseFile })).toBe(EXIT.ok);
    expect(words.join("\n")).toContain("Interactive agent threads (beta) are off.");
  }, 60_000);
});
