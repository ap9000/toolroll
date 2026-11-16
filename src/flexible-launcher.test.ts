/**
 * The console's launcher for a Flexible thread's network and storage (flexible-launcher.ts), with the constant mocked on
 * (tests only, vi.mock; the build's is false and flexible-disabled.test.ts proves nothing here runs then): the thread's
 * network from Toolroll's records (never a provider host, never local services); the launch's own proxy started after
 * the storage check, and closed exactly once however it ends: the agent stopped (its tree verified gone), its exit, a
 * stop seen from elsewhere, the console stopping, or a turn that launches nothing. Real loopback proxies; fake
 * processes (fakePid) stand in for every agent: no agent process, no model.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { startEgressProxy, type EgressProxy } from "./egress.js";
import { createFlexibleLauncher, flexibleNetworkDigest, flexibleThreadNetwork, type FlexibleLauncher } from "./flexible-launcher.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { holdLaunch, onLaunchStopped, watchLaunch, flexibleLaunch } from "./flexible-launch.js";
import { stopFlexibleThreadAgent } from "./flexible-thread.js";
import { realCustodyIO } from "./flexible-custody.js";
import { FLEXIBLE_PROVEN } from "./flexible-levels.js";
import { beginFlexibleThreadTurn, openFlexibleSessions, startFlexibleThread, type FlexibleSessions } from "./flexible-session.js";
import { FLEXIBLE_RELAY_CREDENTIAL } from "./flexible-relay.js";
import { writeHeldSecret } from "./tool-secret-store.js";
import { readdirSync } from "node:fs";
import { tgit } from "../test/flexible-thread-world.js";
import { randomBytes } from "node:crypto";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date("2026-11-15T10:00:00.000Z");
const tid = (k: number) => k.toString(16).padStart(32, "0");
const T1 = tid(1);
const STORAGE = { names: [], denies: [] };
const io = realCustodyIO(() => null);
let world: ThreadWorld, digest: string;
const launchers: FlexibleLauncher[] = [];
const sessionsOpen: FlexibleSessions[] = [];

beforeEach(() => {
  world = threadWorld();
  world.store.saveApprover("pat", "hash-p", NOW);
  const folder = join(world.state, "threads", T1);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(join(world.state, "threads"), 0o700);
  world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(T1, world.project, world.second, `refs/toolroll/threads/${T1}/base`, folder, NOW.toISOString());
});
afterEach(async () => {
  for (const one of launchers.splice(0)) await one.close();
  for (const one of sessionsOpen.splice(0)) { for (const thread of one.threads.values()) await thread.relay?.close(); one.catalog.close(); }
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

/** The relay's own Claude credential, of one kind (built here, never a real one). */
function signIn(kind: "setup-token" | "api-key"): void {
  const value = ["sk", "ant", kind === "setup-token" ? "oat01" : "api03", randomBytes(24).toString("hex")].join("-");
  writeHeldSecret(world.state, FLEXIBLE_RELAY_CREDENTIAL.name, FLEXIBLE_RELAY_CREDENTIAL.file, JSON.stringify({ kind, value }));
}
/** pat's signed terms for the project, at its network posture now. */
function plantTerms(caps: Partial<FlexibleTerms["caps"]> = {}): void {
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "pat", signerGeneration: world.store.accountOf("pat")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full",
    max: "full", default: "full", network: world.store.projectNetwork(world.project).mode === "open" ? "open" : "confined",
    caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null, ...caps } };
  digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'pat', ?, 'password-now', 'pat', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
}
/** A launcher whose proxies are real loopback proxies, each one counted, and whose storage check is a stand-in. */
function counted(storage: () => Promise<{ names: string[]; denies: string[] }> = async () => STORAGE) {
  const asked: { hosts: readonly string[]; open?: true }[] = [];
  const proxies: EgressProxy[] = [];
  const made = createFlexibleLauncher(world.store, { storage, startProxy: async options => { asked.push(options); const proxy = await startEgressProxy(options); proxies.push(proxy); return proxy; } });
  if (!("prepare" in made)) throw new Error(made.message);
  launchers.push(made);
  return { launcher: made, asked, proxies };
}
/** Whether something listens on `port` (the proxy) right now. */
const listening = (port: number) => new Promise<boolean>(done => {
  const socket = connect(port, "127.0.0.1", () => { socket.destroy(); done(true); });
  socket.on("error", () => done(false));
});
/** A live launch of T1 on the record, led by a process that isn't real, held by this process (as flexibleThreadSpawn
 * holds the child it spawned) through a stand-in whose process has already ended. */
function liveLaunch(offset: number): string {
  const launch = tid(0xa0 + offset);
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, 'claude', 'full', ?, 'h1', 'here', ?, ?, 't1', 'live', ?)`).run(launch, T1, "f".repeat(32), "9".repeat(32), fakePid(offset), NOW.toISOString());
  const child = Object.assign(new EventEmitter(), { pid: fakePid(offset), exitCode: 0, signalCode: null, kill: () => false }) as unknown as ChildProcess;
  holdLaunch(launch, child);
  return launch;
}
const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100 && !(await check()); i++) await new Promise(done => setTimeout(done, 20)); expect(await check()).toBe(true); };

describe("a thread's network, from Toolroll's records", () => {
  test("confined: the project's hosts and its registries, never a provider's host, never this computer's services; open: any host, still through the proxy", () => {
    writeFileSync(join(world.project, "package.json"), "{}\n");
    world.store.setProjectNetwork(world.project, { mode: "allowlist", hosts: ["api.example.com"], loopback: "any" }, "pat", NOW);
    const confined = flexibleThreadNetwork(world.store, world.project);
    expect(confined).toMatchObject({ mode: "allowlist", loopback: "proxy-only" });
    if ("ok" in confined) return;
    expect(confined.hosts).toContain("api.example.com");
    expect(confined.hosts).toContain("registry.npmjs.org");
    expect(confined.hosts.filter(host => /anthropic|openai|googleapis|openrouter/.test(host))).toEqual([]);
    world.store.setProjectNetwork(world.project, { mode: "open", hosts: [], loopback: "any" }, "pat", NOW);
    const open = flexibleThreadNetwork(world.store, world.project);
    expect(open).toEqual({ version: 1, mode: "open", hosts: [], loopback: "proxy-only" });
    if (!("ok" in open)) expect(flexibleNetworkDigest(open)).not.toBe(flexibleNetworkDigest(confined));
  });
});

describe("the launch's own proxy lives exactly as long as its launch", () => {
  test("start: the storage check, then a proxy under the project's network; its variables point at it; closing twice is one close", async () => {
    const order: string[] = [];
    const { launcher, asked, proxies } = counted(async () => { order.push("storage"); return STORAGE; });
    const prepared = await launcher.prepare({ id: T1, repo: world.project });
    if (!prepared.ok) throw new Error(prepared.message);
    order.push("proxy");
    expect(order).toEqual(["storage", "proxy"]);
    expect(asked).toEqual([{ hosts: [] }]);
    expect(prepared.network.proxyPort).toBe(proxies[0]!.port);
    expect(prepared.network.token).toBe(proxies[0]!.secret);
    expect(prepared.network.proxyEnv["HTTPS_PROXY"]).toBe(proxies[0]!.url);
    expect(prepared.network.proxyEnv["NO_PROXY"]).toBe("");
    expect(launcher.open()).toBe(1);
    expect(await listening(prepared.network.proxyPort)).toBe(true);
    await prepared.network.close();
    await prepared.network.close();
    expect(launcher.open()).toBe(0);
    expect(await listening(prepared.network.proxyPort)).toBe(false);
    // An open project's launch asks for an open proxy.
    world.store.setProjectNetwork(world.project, { mode: "open", hosts: [], loopback: "proxy-only" }, "pat", NOW);
    const open = await launcher.prepare({ id: T1, repo: world.project });
    expect(open.ok).toBe(true);
    expect(asked.at(-1)).toEqual({ hosts: [], open: true });
  });

  test("refusals start nothing: a storage check that can't finish, a network that moved since the card was shown, a launcher already closed", async () => {
    const { launcher, asked } = counted(async () => { throw new Error("walk unfinished"); });
    expect(await launcher.prepare({ id: T1, repo: world.project })).toMatchObject({ ok: false, reason: "storage" });
    const fine = counted();
    const shown = flexibleThreadNetwork(world.store, world.project);
    if ("ok" in shown) throw new Error("network");
    world.store.setProjectNetwork(world.project, { mode: "allowlist", hosts: ["added.example.com"], loopback: "proxy-only" }, "pat", NOW);
    expect(await fine.launcher.prepare({ id: T1, repo: world.project }, { network: flexibleNetworkDigest(shown) })).toMatchObject({ ok: false, reason: "network-changed" });
    await fine.launcher.close();
    expect(await fine.launcher.prepare({ id: T1, repo: world.project })).toMatchObject({ ok: false, reason: "no-network" });
    expect([...asked, ...fine.asked]).toEqual([]);
  });

  test("stop: the agent stopped and its whole tree verified gone closes its launch's proxy at once", async () => {
    const { launcher } = counted();
    const prepared = await launcher.prepare({ id: T1, repo: world.project });
    if (!prepared.ok) throw new Error(prepared.message);
    const launch = liveLaunch(1);
    // As startFlexibleTurn registers it: the proxy closes the moment the launch is stopped.
    onLaunchStopped(launch, prepared.network.close);
    const stopped = await stopFlexibleThreadAgent(world.store, { id: T1, reason: "the person stopped it", clock: () => NOW, io });
    expect(stopped).toMatchObject({ ok: true, launch });
    expect(flexibleLaunch(world.store, launch)?.state).toBe("exited");
    expect(launcher.open()).toBe(0);
    expect(await listening(prepared.network.proxyPort)).toBe(false);
  });

  test("crash: the agent's exit (its exit watcher's stop) and a stop seen from another process each close the proxy", async () => {
    const { launcher } = counted();
    const exited = await launcher.prepare({ id: T1, repo: world.project });
    if (!exited.ok) throw new Error(exited.message);
    const first = liveLaunch(2);
    onLaunchStopped(first, exited.network.close);
    expect(await stopFlexibleThreadAgent(world.store, { id: T1, reason: "its agent exited", io })).toMatchObject({ ok: true, launch: first });
    expect(await listening(exited.network.proxyPort)).toBe(false);
    // Stopped elsewhere: the record moves without this process; the holder's watcher sees it and closes its proxy.
    const elsewhere = await launcher.prepare({ id: T1, repo: world.project });
    if (!elsewhere.ok) throw new Error(elsewhere.message);
    const second = liveLaunch(3);
    onLaunchStopped(second, elsewhere.network.close);
    const stopWatching = watchLaunch(world.store, second, join(world.state, "threads", T1), io, 20);
    try {
      expect(launcher.open()).toBe(1);
      world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'stopping' WHERE id = ?").run(second);
      await until(() => launcher.open() === 0);
      expect(await listening(elsewhere.network.proxyPort)).toBe(false);
      expect(flexibleLaunch(world.store, second)?.networkClosedAt).not.toBeNull();
    } finally { stopWatching(); }
  });

  test("the console stopping closes every proxy still open", async () => {
    const { launcher } = counted();
    const ports: number[] = [];
    for (let n = 0; n < 3; n++) { const one = await launcher.prepare({ id: T1, repo: world.project }); if (one.ok) ports.push(one.network.proxyPort); }
    expect(launcher.open()).toBe(3);
    await launcher.close();
    expect(launcher.open()).toBe(0);
    for (const port of ports) expect(await listening(port)).toBe(false);
  });
});

describe("a turn that launches nothing", () => {
  let sessions: FlexibleSessions;
  beforeEach(() => {
    plantTerms();
    const opened = openFlexibleSessions(world.store);
    if (!opened.ok) throw new Error(opened.message);
    sessions = opened.sessions;
    sessionsOpen.push(sessions);
  });
  const admit = (key: string) => {
    const made = admitFlexibleTurn(world.store, { thread: T1, starter: { name: "pat", generation: world.store.accountOf("pat")!.generation }, digest, level: "full", freshProof: false, provider: "claude",
      model: "claude-sonnet-4-5", billing: "subscription", requestKey: key, holder: sessions.holder, clock: () => NOW });
    if (!made.ok) throw new Error(made.message);
    return made.turn;
  };

  test("refused before the spawn (the agent's level isn't offered): its proxy closes at once and the turn is withdrawn", async () => {
    const { launcher, proxies } = counted();
    const turn = admit("m-1");
    const unproven = { ...FLEXIBLE_PROVEN, claude: { ...FLEXIBLE_PROVEN.claude, full: { offered: false as const, why: "not proven here" } } };
    const begun = await beginFlexibleThreadTurn(world.store, sessions, { turn, message: "Fix the README", launcher, clock: () => NOW, proven: unproven as typeof FLEXIBLE_PROVEN });
    expect(begun).toMatchObject({ ok: false });
    expect(proxies).toHaveLength(1);
    expect(launcher.open()).toBe(0);
    expect(await listening(proxies[0]!.port)).toBe(false);
    expect(flexibleTurn(world.store, turn)?.status).toBe("withdrawn");
  });

  test("held to the network the person was shown: a project setting changed since then withdraws the turn and starts no proxy", async () => {
    const { launcher, asked } = counted();
    const shown = flexibleThreadNetwork(world.store, world.project);
    if ("ok" in shown) throw new Error("network");
    world.store.setProjectNetwork(world.project, { mode: "allowlist", hosts: ["added.example.com"], loopback: "proxy-only" }, "pat", NOW);
    const turn = admit("m-2");
    const begun = await beginFlexibleThreadTurn(world.store, sessions, { turn, message: "Fix the README", launcher, clock: () => NOW, expectNetwork: flexibleNetworkDigest(shown) });
    expect(begun).toMatchObject({ ok: false, reason: "network-changed" });
    expect(asked).toEqual([]);
    expect(flexibleTurn(world.store, turn)?.status).toBe("withdrawn");
  });
});

describe("the real start path: limits before storage, one thread per start, nothing left behind", () => {
  let sessions: FlexibleSessions;
  const KEY = "5".repeat(32);
  beforeEach(() => {
    const opened = openFlexibleSessions(world.store);
    if (!opened.ok) throw new Error(opened.message);
    sessions = opened.sessions;
    sessionsOpen.push(sessions);
    signIn("setup-token");
  });
  /** Threads besides the fixture's, their folders, and the keep-refs in the project's repository. */
  const leftovers = () => ({
    rows: world.store.handle.prepare("SELECT id, state FROM flexible_thread WHERE id <> ?").all(T1).map(row => ({ ...row })),
    folders: readdirSync(join(world.state, "threads")).filter(name => /^[0-9a-f]{32}$/.test(name) && name !== T1),
    refs: tgit(world.project, "for-each-ref", "--format=%(refname)", "refs/toolroll/threads/"),
  });
  const start = (launcher: FlexibleLauncher, over: Partial<Parameters<typeof startFlexibleThread>[2]> = {}) => startFlexibleThread(world.store, sessions, {
    repo: world.project, by: { name: "pat", generation: world.store.accountOf("pat")!.generation }, digest, message: "Fix the README", model: "claude-sonnet-4-5", billing: "subscription",
    startKey: KEY, launcher, clock: () => NOW, ...over });

  test("a start the limits refuse makes no repository, keep-ref or thread record at all", async () => {
    plantTerms({ liveThreads: 1 });
    // One thread already has a turn waiting: the project's one live thread.
    const busy = admitFlexibleTurn(world.store, { thread: T1, starter: { name: "pat", generation: world.store.accountOf("pat")!.generation }, digest, level: "full", freshProof: false, provider: "claude",
      model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-busy", holder: sessions.holder, clock: () => NOW });
    expect(busy.ok).toBe(true);
    const { launcher, asked } = counted();
    expect(await start(launcher)).toMatchObject({ ok: false, reason: "cap-reached" });
    expect(leftovers()).toEqual({ rows: [], folders: [], refs: "" });
    expect(asked).toEqual([]);
  });

  test("a start refused after its repository was made (the storage check) takes the repository, keep-ref and turn with it", async () => {
    plantTerms();
    const { launcher, asked } = counted(async () => { throw new Error("walk unfinished"); });
    expect(await start(launcher)).toMatchObject({ ok: false, reason: "storage" });
    const left = leftovers();
    expect(left.rows.every(row => row["state"] === "removed")).toBe(true);
    expect(left.folders).toEqual([]);
    expect(left.refs).toBe("");
    expect(asked).toEqual([]);
    expect(world.store.handle.prepare("SELECT status FROM thread_turn WHERE request_key = ?").all(`start:${KEY}`).map(row => row["status"])).toEqual(["withdrawn"]);
  });

  test("the same start posted twice makes one thread: the second gets the first one back", async () => {
    plantTerms();
    let release: () => void = () => {};
    const gate = new Promise<void>(open => { release = open; });
    const { launcher } = counted(async () => { await gate; throw new Error("walk unfinished"); });
    const first = start(launcher);
    // The first start's thread is recorded (its turn reserved) before its repository is made; the second post then finds it.
    await until(() => world.store.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn WHERE request_key = ?").get(`start:${KEY}`)!["n"] === 1);
    const second = await start(launcher);
    expect(second).toMatchObject({ ok: true, replayed: true });
    release();
    await first;
    const made = world.store.handle.prepare("SELECT id FROM flexible_thread WHERE id <> ?").all(T1).map(row => String(row["id"]));
    expect(made).toHaveLength(1);
    expect(second.ok && second.thread).toBe(made[0]);
  });

  test("billing: the card's kind must be the relay credential's kind now, or nothing is made; with no credential nothing starts", async () => {
    plantTerms();
    const { launcher, asked } = counted(async () => { throw new Error("walk unfinished"); });
    expect(await start(launcher, { billing: "api-key" })).toMatchObject({ ok: false, reason: "billing-changed" });
    expect(leftovers()).toEqual({ rows: [], folders: [], refs: "" });
    signIn("api-key");
    expect(await start(launcher, { billing: "subscription" })).toMatchObject({ ok: false, reason: "billing-changed" });
    writeHeldSecret(world.state, FLEXIBLE_RELAY_CREDENTIAL.name, FLEXIBLE_RELAY_CREDENTIAL.file, null);
    expect(await start(launcher)).toMatchObject({ ok: false, reason: "no-credential" });
    expect(leftovers()).toEqual({ rows: [], folders: [], refs: "" });
    expect(asked).toEqual([]);
  });

  test("a throw after the launch's proxy was made closes the proxy, and the thread goes with it", async () => {
    plantTerms();
    const { launcher, proxies } = counted();
    const exploding = new Proxy({}, { get: () => { throw new Error("the proven matrix couldn't be read"); } }) as typeof FLEXIBLE_PROVEN;
    await expect(start(launcher, { proven: exploding })).rejects.toThrow("couldn't be read");
    expect(proxies).toHaveLength(1);
    expect(launcher.open()).toBe(0);
    expect(await listening(proxies[0]!.port)).toBe(false);
    const left = leftovers();
    expect(left.rows.every(row => row["state"] === "removed")).toBe(true);
    expect(left.folders).toEqual([]);
    expect(left.refs).toBe("");
  });
});

describe("admission opens only a new thread's first turn while it is being made", () => {
  test("a thread still being made is admitted only with `opening`, and only while it has no turn", () => {
    plantTerms();
    const T2 = tid(2);
    world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'preparing')`)
      .run(T2, world.project, world.second, `refs/toolroll/threads/${T2}/base`, join(world.state, "threads", T2), NOW.toISOString());
    const ask = (key: string, opening?: boolean) => admitFlexibleTurn(world.store, { thread: T2, starter: { name: "pat", generation: world.store.accountOf("pat")!.generation }, digest, level: "full",
      freshProof: false, provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: key, holder: "h1", clock: () => NOW, ...(opening === undefined ? {} : { opening }) });
    expect(ask("m-a")).toMatchObject({ ok: false, reason: "thread-not-ready" });
    expect(ask("m-b", true)).toMatchObject({ ok: true });
    expect(ask("m-c", true)).toMatchObject({ ok: false, reason: "thread-not-ready" });
  });
});

describe("a proxy that fails to close stays listed and is tried again", () => {
  test("the launcher's close keeps a failed one for the next close", async () => {
    let fails = 1, closed = 0;
    const fake = { url: "http://run:x@127.0.0.1:1", secret: "x", port: 1, counts: () => ({ connections: 0, refused: 0, hosts: [], otherHosts: 0 }),
      close: async () => { if (fails-- > 0) throw new Error("busy"); closed++; } };
    const made = createFlexibleLauncher(world.store, { storage: async () => STORAGE, startProxy: async () => fake });
    if (!("prepare" in made)) throw new Error(made.message);
    const prepared = await made.prepare({ id: T1, repo: world.project });
    expect(prepared.ok).toBe(true);
    await expect(made.close()).rejects.toThrow("couldn't be closed yet");
    expect(made.open()).toBe(1);
    await made.close();
    expect(made.open()).toBe(0);
    expect(closed).toBe(1);
  });
});
