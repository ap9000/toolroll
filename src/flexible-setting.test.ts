/**
 * Settings → General: "Interactive agent threads (beta)" (flexible-available.ts), with the real switch (no mock of it):
 * off by default; an instance operator's ordinary step-up turns it on or off (a solo session stands in, a team needs the
 * password, a token never), with a ledger row; its CLI twin `config set flexible on|off` (a person's password, never a
 * lead's or remote token); with it on, a thread starts (a recording stand-in for the engine's own start: no agent, no
 * model) with Claude only, and a Codex thread is refused; and turned off while a thread runs, the thread is stopped
 * safely: its relay refuses the next model call at once (a scripted stand-in for the model service), nothing new is
 * recorded or answered, and the console's upkeep stops its agent. Isolated stores and fixture sessions only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { flexibleAvailable, setFlexibleSetting } from "./flexible-available.js";
import { flexibleDigestOf, flexibleTermsJson, FLEXIBLE_UNAVAILABLE, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { prepareFlexibleThread } from "./flexible-thread.js";
import { FLEXIBLE_RELAY_CREDENTIAL, startFlexibleRelay, type FlexibleRelayServer } from "./flexible-relay.js";
import { answerFlexibleRequest, attachFlexibleAgent, openFlexibleSessions, startFlexibleThreadSession, settleFlexibleStops, type FlexibleSessions } from "./flexible-session.js";
import { writeHeldSecret } from "./tool-secret-store.js";
import { mintApiToken } from "./api-tokens.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate, EXIT } from "./operate.js";
import { FLEXIBLE_CLAUDE_ONLY } from "./server/engine-api.js";
import { FLEXIBLE_SETTING_WORDS } from "./server/settings-sections.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";
import { holdLaunch } from "./flexible-launch.js";
import type { ChildProcess } from "node:child_process";

// The engine's own thread start is a recording stand-in here (flexible-session.test.ts and flexible-launcher.test.ts
// prove the real one): no agent process, no model.
const held = vi.hoisted(() => ({ starts: [] as Record<string, unknown>[], origin: "http://127.0.0.1:9" }));
vi.mock("./flexible-session.js", async importOriginal => {
  const real = await importOriginal<typeof import("./flexible-session.js")>();
  return { ...real, startFlexibleThread: async (_store: unknown, _sessions: unknown, input: Record<string, unknown>) => {
    held.starts.push(input);
    return { ok: true, thread: "e".repeat(32), turn: "f".repeat(32) };
  } };
});
// The scripted model service: the shipped upstream list, its origin pointed at a local stand-in.
vi.mock("./flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("./flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, get origin() { return held.origin; } } } };
});

const OFF = "Interactive agent threads are off: Settings → General, or `toolroll config set flexible on`.";
const NOW = new Date();
/** The relay's own Claude credential (built here, never a real one). */
function signIn(state: string): void {
  writeHeldSecret(state, FLEXIBLE_RELAY_CREDENTIAL.name, FLEXIBLE_RELAY_CREDENTIAL.file, JSON.stringify({ kind: "setup-token", value: ["sk", "ant", "oat01", randomBytes(24).toString("hex")].join("-") }));
}
/** Signed Flexible terms for the project (as a person's yes would have left them). */
function plantTerms(world: ThreadWorld, signer: string): string {
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer, signerGeneration: world.store.accountOf(signer)!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full",
    default: "full", network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  const digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'password-now', ?, ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, signer, NOW.toISOString(), signer, NOW.toISOString());
  return digest;
}
const ledger = (world: ThreadWorld) => world.store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = 'interactive agent threads' ORDER BY id").all().map(row => ({ ...row }));

describe("Settings → General, and a thread through the console", () => {
  let world: ThreadWorld, server: Server, base: string, cookie: string, csrf: string, password: string, actToken: string;
  beforeAll(async () => {
    world = threadWorld();
    const alex = addApprover(world.store, "alex", NOW);
    if (!alex.ok) throw new Error("alex");
    password = alex.token;
    plantTerms(world, "alex");
    signIn(world.state);
    const minted = mintApiToken();
    world.store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(), by: "alex" }, NOW);
    actToken = minted.token;
    mkdirSync(join(world.dir, "config"));
    // An installation this console manages (its configuration folder): General shows installation settings.
    server = createDecisionServer({ store: world.store, evidenceRoot: join(world.dir, "evidence"), repos: [world.project], clock: () => new Date(), configDir: join(world.dir, "config"),
      telegramTokenFile: join(world.dir, "config", "telegram-token") });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
    cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text())![1]!;
    // No remembered password: each step-up below stands on the mode alone or the password typed for it.
    expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
  }, 60_000);
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    world.store.close();
    rmSync(world.dir, { recursive: true, force: true });
  });
  function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return fetch(base + path, { method: "POST", headers: { cookie, origin: base, ...headers }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
  }
  const said = (answer: Response) => decodeURIComponent(answer.headers.get("location") ?? "").replace(/\+/g, " ");
  const start = async (fields: Record<string, string>) => {
    const response = await fetch(`${base}/agents/live/thread`, { method: "POST", redirect: "manual",
      headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
      body: new URLSearchParams({ csrf, repo: world.project, message: "Fix the README", ...fields }).toString() });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  test("off by default: General says what it is in one line; T's road refuses with where to turn it on", async () => {
    expect(flexibleAvailable(world.store)).toBe(false);
    const page = await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text();
    expect(page).toContain('data-section="flexible"');
    expect(page).toContain("Interactive agent threads (beta)");
    expect(page).toContain(`Off. ${FLEXIBLE_SETTING_WORDS.replaceAll("'", "&#39;")}`);
    expect(FLEXIBLE_SETTING_WORDS).toBe("Claude Code only for now. Runs inside Toolroll's sandbox with your Claude sign-in relayed; Toolroll never gives the agent your key.");
    expect(page).toContain('href="/settings/change/flexible"');
    expect(await (await fetch(`${base}/settings/change/flexible`, { headers: { cookie } })).text()).toContain('action="/settings/flexible"');
    expect(await start({})).toEqual({ status: 404, body: { outcome: "refused", words: OFF } });
    // A read: it answers, says threads are off, and lists none (none was ever made).
    expect(await (await fetch(`${base}/agents/live/threads`, { headers: { cookie } })).json()).toEqual({ version: 1, on: false, threads: [] });
    expect(FLEXIBLE_UNAVAILABLE).toBe(OFF);
    expect(held.starts).toEqual([]);
  });

  test("a team install: only the password typed now changes it; a token never reaches the switch", async () => {
    for (const typed of ["", "not-it"]) {
      expect(said(await post("/settings/flexible", { enabled: "on", password: typed }))).toMatch(/^\/settings\/change\/flexible\?problem=Turning interactive agent threads on needs your Toolroll password, typed now/);
      expect(flexibleAvailable(world.store)).toBe(false);
    }
    expect(said(await post("/settings/flexible", { enabled: "maybe", password }))).toContain("Choose on or off");
    // A token (this person's own, able to act) is refused at the door, password and all.
    const token = await fetch(`${base}/settings/flexible`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${actToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enabled: "on", password }) });
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(flexibleAvailable(world.store)).toBe(false);
    expect(ledger(world)).toEqual([]);
    expect(said(await post("/settings/flexible", { enabled: "on", password }))).toContain("Interactive agent threads are on");
    expect(flexibleAvailable(world.store)).toBe(true);
    expect(said(await post("/settings/flexible", { enabled: "off", password }))).toContain("Interactive agent threads are off");
    expect(flexibleAvailable(world.store)).toBe(false);
    expect(ledger(world)).toEqual([{ actor: "alex", outcome: "on" }, { actor: "alex", outcome: "off" }]);
    expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
  });

  test("solo: turning on still needs the password typed now (it relays your Claude sign-in); turning off, the session stands in", async () => {
    expect(said(await post("/settings/install-mode/solo", { password }))).not.toContain("problem");
    expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
    // The change document asks for the password even here.
    expect(await (await fetch(`${base}/settings/change/flexible`, { headers: { cookie } })).text()).toMatch(/name="password"/);
    const before = ledger(world).length;
    expect(said(await post("/settings/flexible", { enabled: "on", password: "" }))).toContain("needs your Toolroll password, typed now");
    expect(flexibleAvailable(world.store)).toBe(false);
    expect(ledger(world)).toHaveLength(before);
    expect(said(await post("/settings/flexible", { enabled: "on", password }))).toContain("Interactive agent threads are on");
    expect(flexibleAvailable(world.store)).toBe(true);
    expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
    expect(said(await post("/settings/flexible", { enabled: "off", password: "" }))).toContain("Interactive agent threads are off");
    expect(flexibleAvailable(world.store)).toBe(false);
    expect(said(await post("/settings/flexible", { enabled: "on", password }))).toContain("Interactive agent threads are on");
    expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
    expect((await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text())).toContain(`On. ${FLEXIBLE_SETTING_WORDS.replaceAll("'", "&#39;")}`);
  });

  test("on: a thread starts with Claude Code under its terms card; a Codex thread is refused", async () => {
    expect(flexibleAvailable(world.store)).toBe(true);
    held.starts.length = 0;
    const card = (await start({})).body as { outcome: string; key: string; terms: { label: string; words: string }[] };
    expect(card.outcome).toBe("thread-terms");
    expect(card.terms.find(row => row.label === "Agent")?.words).toMatch(/^Claude .*, signed in through Toolroll's relay$/);
    expect(await start({ terms: card.key, agent: "codex" })).toEqual({ status: 409, body: { outcome: "refused", words: FLEXIBLE_CLAUDE_ONLY } });
    expect(await start({ agent: "codex" })).toEqual({ status: 409, body: { outcome: "refused", words: FLEXIBLE_CLAUDE_ONLY } });
    expect(FLEXIBLE_CLAUDE_ONLY).toContain("Codex threads come later");
    expect(held.starts).toEqual([]);
    expect(await start({ terms: card.key, agent: "claude" })).toEqual({ status: 200, body: { outcome: "done", words: "The thread started." } });
    expect(held.starts).toHaveLength(1);
    expect(held.starts[0]).toMatchObject({ repo: world.project, model: expect.stringMatching(/^claude-/), startKey: card.key });
    // Turned off again: the very next start refuses, before anything is looked up.
    setFlexibleSetting(world.store, false, "alex", new Date());
    expect(await start({ terms: card.key })).toEqual({ status: 404, body: { outcome: "refused", words: OFF } });
    expect(held.starts).toHaveLength(1);
  });

  test("off: the person still reads their own threads already made (the list says off); nobody else's, and no answer goes", async () => {
    // A thread made while they were on, then off again.
    setFlexibleSetting(world.store, true, "alex", new Date());
    const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
    if (!made.ok) throw new Error(made.message);
    setFlexibleSetting(world.store, false, "alex", new Date());
    const read = async (path: string) => { const answer = await fetch(`${base}${path}`, { headers: { cookie } }); return { status: answer.status, body: await answer.json() as Record<string, unknown> }; };
    const listed = await read("/agents/live/threads");
    expect(listed).toMatchObject({ status: 200, body: { on: false, threads: [{ id: made.thread.id, live: false }] } });
    const window = await read(`/agents/live/thread/${made.thread.id}`);
    expect(window).toMatchObject({ status: 200, body: { session: { kind: "thread", id: made.thread.id }, live: false } });
    expect(await read(`/agents/live/thread/${"b".repeat(32)}`)).toEqual({ status: 404, body: { error: "thread" } });
    const answer = await fetch(`${base}/agents/live/thread/${made.thread.id}/answer`, { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place" },
      body: new URLSearchParams({ csrf, request: "d".repeat(32), card: "1".repeat(64), decision: "decline" }).toString() });
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ outcome: "refused", words: OFF });
  });

  test("the CLI twin: config show/set flexible, a person's password only, never a token or the lead", async () => {
    const cli = async (args: string[], env: Record<string, string> = {}) => {
      const lines: string[] = [];
      const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
      Object.assign(process.env, env);
      try {
        const code = await runOperate("config", args, line => lines.push(line), { databaseFile: world.databaseFile });
        return { code, out: JSON.parse(lines.join("\n")) as Record<string, unknown> };
      } finally {
        for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      }
    };
    expect(await cli(["show", "flexible", "--json"])).toMatchObject({ code: EXIT.ok, out: { ok: true, flexible: { on: false } } });
    expect(await cli(["set", "flexible", "maybe", "--json", "--as", "alex", "--token", password])).toMatchObject({ code: EXIT.usage });
    expect(await cli(["set", "flexible", "on", "--repo", world.project, "--json", "--as", "alex", "--token", password])).toMatchObject({ code: EXIT.usage });
    const before = ledger(world).length;
    for (const [args, env] of [
      [["--as", "alex", "--token", "not-it"], {}],
      [["--as", "alex", "--token", actToken], {}],
      [["--as", "alex", "--token", password], { TOOLROLL_LEAD_TOKEN: "lt_x" }],
      [["--as", "alex", "--token", password], { TOOLROLL_REMOTE_TOKEN: actToken }],
    ] as [string[], Record<string, string>][]) {
      const refused = await cli(["set", "flexible", "on", "--json", ...args], env);
      expect(refused.code, args.join(" ")).toBe(EXIT.refused);
      expect(flexibleAvailable(world.store)).toBe(false);
    }
    expect(ledger(world)).toHaveLength(before);
    expect(await cli(["set", "flexible", "on", "--json", "--as", "alex", "--token", password])).toMatchObject({ code: EXIT.ok, out: { flexible: { on: true, by: "alex" } } });
    expect(flexibleAvailable(world.store)).toBe(true);
    expect(await cli(["set", "flexible", "off", "--json", "--as", "alex", "--token", password])).toMatchObject({ code: EXIT.ok, out: { flexible: { on: false } } });
    expect(ledger(world).slice(before)).toEqual([{ actor: "alex", outcome: "on" }, { actor: "alex", outcome: "off" }]);
  });
});

describe("turned off while a thread runs: stopped safely", () => {
  let world: ThreadWorld, sessions: FlexibleSessions, relay: FlexibleRelayServer, upstream: Server, thread: string, turn: string, launch: string, raw: DatabaseSync, upstreamCalls: number;
  beforeEach(async () => {
    world = threadWorld();
    world.store.saveApprover("alex", "hash-a", NOW);
    const digest = plantTerms(world, "alex");
    signIn(world.state);
    upstreamCalls = 0;
    upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => { upstreamCalls++; response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } })); });
    });
    await new Promise<void>(done => upstream.listen(0, "127.0.0.1", () => done()));
    held.origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    setFlexibleSetting(world.store, true, "alex", NOW);
    const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
    if (!made.ok) throw new Error(made.message);
    thread = made.thread.id;
    const opened = openFlexibleSessions(world.store);
    if (!opened.ok) throw new Error(opened.message);
    sessions = opened.sessions;
    const admitted = admitFlexibleTurn(world.store, { thread, starter: { name: "alex", generation: world.store.accountOf("alex")!.generation }, digest, level: "full", freshProof: false,
      provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-1", holder: sessions.holder, clock: () => NOW });
    if (!admitted.ok) throw new Error(admitted.message);
    turn = admitted.turn;
    const begun = beginFlexibleTurn(world.store, { turn, holder: sessions.holder, clock: () => NOW });
    if (!begun.ok) throw new Error(begun.message);
    launch = randomBytes(16).toString("hex");
    world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(launch, thread, turn, "f".repeat(32), sessions.holder, "9".repeat(32), fakePid(1), NOW.toISOString());
    // Held by this process as flexibleThreadSpawn holds the child it spawned (a stand-in whose process already ended).
    holdLaunch(launch, Object.assign(new EventEmitter(), { pid: fakePid(1), exitCode: 0, signalCode: null, kill: () => false }) as unknown as ChildProcess);
    const relayed = await startFlexibleThreadSession(world.store, sessions, { thread });
    if (!relayed.ok) throw new Error(relayed.message);
    const kept = await startFlexibleRelay(world.store, { thread });
    if ("ok" in kept) throw new Error(kept.message);
    relay = kept;
    mkdirSync(join(world.state, "threads", thread), { recursive: true });
    raw = new DatabaseSync(`${world.databaseFile}.coding.sqlite`);
  });
  afterEach(async () => {
    await relay.close();
    for (const one of sessions.threads.values()) await one.relay?.close();
    sessions.catalog.close();
    raw.close();
    upstream.closeAllConnections();
    await new Promise(done => upstream.close(done));
    world.store.close();
    rmSync(world.dir, { recursive: true, force: true });
  });
  const call = (token: string) => fetch(`${relay.url}/v1/messages?beta=true`, { method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
  const bash = (id: string) => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" }, tool_use_id: `toolu-${id}` } });
  const settled = () => new Promise(resolve => setImmediate(resolve));
  const states = () => raw.prepare("SELECT request_ref, state FROM thread_request ORDER BY created_at, request_ref").all().map(row => [row["request_ref"], row["state"]]);

  test("the relay refuses the next model call at once, inside its own reservation", async () => {
    const token = relay.issue({ thread, turn, launch }).token;
    expect((await call(token)).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    setFlexibleSetting(world.store, false, "alex", new Date());
    const refused = await call(token);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Interactive agent threads were turned off");
    expect(upstreamCalls).toBe(1);
    expect(world.store.handle.prepare("SELECT status, reason FROM thread_relay_call ORDER BY id").all().map(row => ({ ...row }))).toEqual([{ status: "completed", reason: null }, { status: "refused", reason: "threads-off" }]);
  });

  test("session wiring with an agent that already ended: nothing new is recorded or answered, and the stop withdraws answers, interrupts the turn, closes the relay (flexible-stop.slow.test.ts stops a running tree)", async () => {
    const stdout = new PassThrough(), stdin = new PassThrough(), exit = new EventEmitter();
    expect(attachFlexibleAgent(world.store, sessions, { thread, turn, launch, stdout, stdin, exited: listener => { exit.once("exit", listener); }, clock: () => NOW })).toEqual({ ok: true });
    stdout.write(`${JSON.stringify(bash("r1"))}\n`);
    await settled();
    expect(states()).toEqual([["r1", "pending"]]);
    const request = String(raw.prepare("SELECT id FROM thread_request WHERE request_ref = 'r1'").get()!["id"]);
    // On: the upkeep stops nothing.
    expect(await settleFlexibleStops(world.store, sessions)).toEqual({ ok: true, stopped: 0, pending: 0 });
    expect(sessions.threads.has(thread)).toBe(true);
    setFlexibleSetting(world.store, false, "alex", new Date());
    stdout.write(`${JSON.stringify(bash("r2"))}\n`);
    await settled();
    expect(states()).toEqual([["r1", "pending"]]);
    const answered = await answerFlexibleRequest(world.store, sessions, { held: () => true, thread, request, shownDigest: "1".repeat(64), by: { kind: "person", name: "alex", generation: world.store.accountOf("alex")!.generation },
      choice: { decision: "accept" } });
    expect(answered).toMatchObject({ ok: false, reason: "not-available", message: OFF });
    const relayPort = sessions.threads.get(thread)!.relay!.port;
    expect(await settleFlexibleStops(world.store, sessions)).toEqual({ ok: true, stopped: 1, pending: 0 });
    expect(sessions.threads.has(thread)).toBe(false);
    expect(states()).toEqual([["r1", "withdrawn"]]);
    expect(stdin.writableEnded).toBe(true);
    expect(flexibleTurn(world.store, turn)!.status).not.toBe("running");
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(launch)!["state"]).not.toBe("live");
    expect(await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, { method: "POST" }).then(() => "answered", () => "closed")).toBe("closed");
  });
});
