/**
 * The terminal workbench's Agents screen, through the real console routes (stand-in binaries and a stand-in pty that
 * emits output: no real sign-in, install or model call):
 *
 * - an agent's own sign-in or install starts only for the terminal workbench's own session (its terminal key epoch,
 *   a local owner's, solo, over direct loopback): a browser session, a full password session with the password typed
 *   (only that rule refuses it), a request through a proxy, a team install and a valid API token are each refused, and
 *   nothing runs;
 * - it runs exactly the trusted install with Toolroll's own arguments, from a fresh empty folder, with an environment
 *   built from nothing; an untrusted binary earlier on PATH runs nothing; a launcher's interpreter is pinned (its real
 *   path runs with the script's), and a `node` linked into a project checkout never runs;
 * - an install runs only on the confirm of exactly the command shown;
 * - a sign-in pane keeps nothing: no screen replay, one page once, nothing held after the program ends;
 * - when the program ends, this computer's agents are looked for again; Check again does the same on demand;
 * - the installation's models change through Settings → Models' own write: a solo local owner may; a team install's
 *   local sign-in and a valid token may not.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { MAX_LIVE_TERMINALS, TerminalHost, type Pty, type TerminalViewer } from "../live-terminal.js";
import { agentsReadSchema, linkRedemptionSchema, modelsReadSchema, termStartedSchema } from "../contracts/engine-api.js";
import { mintApiToken } from "../api-tokens.js";
import { hashPassword } from "../scope.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";

type Spawned = { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; exit: (code: number) => void; emit: (text: string) => void };
const spawned: Spawned[] = [];
let probes = 0;
let world: LocalWorld;
let host: TerminalHost;
let bins: string, trusted: string, writable: string, launcher: string, hijacked: string, root: string;
let path = "";
const WORKBENCH_ONLY = "Sign in to agents from your own terminal: run toolroll there";

/** A stand-in launcher script (it never runs: the pty is a stand-in). */
function script(dir: string, name: string, first = "#!/bin/sh"): string {
  const file = join(dir, name);
  writeFileSync(file, `${first}\necho stand-in\n`);
  chmodSync(file, 0o755);
  return realpathSync(file);
}
/** A stand-in interpreter: a real (non-script) program, copied, owned by this user. */
function interpreter(dir: string, name: string): string {
  const file = join(dir, name);
  copyFileSync("/bin/echo", file);
  chmodSync(file, 0o755);
  return realpathSync(file);
}

beforeAll(async () => {
  bins = realpathSync(mkdtempSync(join(tmpdir(), "so-agent-bins-")));
  trusted = join(bins, "trusted"); writable = join(bins, "shared"); launcher = join(bins, "launcher"); hijacked = join(bins, "hijacked");
  for (const dir of [trusted, launcher, hijacked]) mkdirSync(dir, { mode: 0o755 });
  mkdirSync(writable); chmodSync(writable, 0o777);
  for (const name of ["codex", "npm", "claude"]) script(trusted, name);
  script(writable, "codex");
  // A launcher whose interpreter is found on PATH (a bare `env fakenode`), both trusted stand-ins.
  script(launcher, "codex", "#!/usr/bin/env fakenode");
  interpreter(launcher, "fakenode");
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-agent-term-")));
  const spawn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Pty => {
    let exited: ((exit: { exitCode: number }) => void) | null = null;
    let output: ((data: string) => void) | null = null;
    spawned.push({ file, args, cwd: options.cwd, env: options.env, exit: code => exited?.({ exitCode: code }), emit: text => output?.(text) });
    // Killed (by a close, or nobody attaching in time): it exits, as a program does.
    return { pid: 2_147_000_000, tty: null, pendingInput: () => 0, onData: listener => { output = listener; }, onExit: listener => { exited = listener; }, write() {}, resize() {}, kill() { exited?.({ exitCode: 137 }); } };
  };
  host = new TerminalHost({ spawn, worktreeRoot: join(root, "live"), processes: () => new Map(), closeGraceMs: 1, sensitiveAttachMs: 5_000 });
  world = await openLocalWorld({
    browserKey: true,
    terminalHost: host,
    agentCommandEnv: () => ({ PATH: path, HOME: bins, USER: "alex", LANG: "C", TOOLROLL_TOKEN: "never-handed-on", GITHUB_TOKEN: "never-handed-on" }),
    connectionProbe: async () => { probes += 1; return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }; },
  });
  // The attack: a trusted PATH folder whose `node` is a link into a project checkout (a build may write there).
  script(hijacked, "codex", "#!/usr/bin/env node");
  interpreter(world.repo, "node");
  symlinkSync(join(world.repo, "node"), join(hijacked, "node"));
}, LOCAL_WORLD_SETUP_MS);
afterAll(async () => {
  await world.close();
  rmSync(bins, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
/** Every agent pane this file started, ended and gone (they are removed when they end; one may run at a time). */
const agentPanes = () => host.list("alex").filter(one => one.agent !== null);
afterEach(async () => {
  for (const one of spawned) one.exit(0);
  await expect.poll(() => agentPanes().length, { timeout: 10_000 }).toBe(0);
  spawned.length = 0; path = "";
});

type Session = { cookie: string; csrf: string; key: string | null };
/** The terminal workbench's own session: the console's local link, redeemed by a terminal client (A0). */
async function workbench(): Promise<Session> {
  const link = world.server.mintLocalLink()!;
  const redeemed = await world.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
  const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
  return { cookie: `${body.cookie.name}=${body.cookie.value}`, csrf: body.csrf, key: body.key };
}
const post = (path_: string, who: Session, form: Record<string, string>, more: Record<string, string> = {}) =>
  world.send(path_, "POST", { cookie: who.cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", accept: "application/json",
    ...(who.key === null ? {} : { "x-toolroll-key": who.key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" }), ...more },
  new URLSearchParams({ csrf: who.csrf, ...form }).toString());
const start = async (kind: "sign-in" | "install", form: Record<string, string>, who?: Session, more: Record<string, string> = {}) => {
  const answer = await post(`/term/agent/${kind}`, who ?? await workbench(), { password: "", ...form }, more);
  let body: unknown;
  try { body = termStartedSchema.parse(JSON.parse(answer.body)); } catch { body = answer.body; }
  return { status: answer.status, body };
};

test("a sign-in runs a stand-in trusted binary with Toolroll's own arguments, from an empty folder, with no Toolroll credential (stand-ins only; no real agent CLI)", async () => {
  path = trusted;
  const answer = await start("sign-in", { agent: "codex" });
  expect(answer).toEqual({ status: 200, body: { ok: true, id: expect.stringMatching(/^[0-9a-f]{32}$/) } });
  expect(spawned).toHaveLength(1);
  const [one] = spawned;
  // A `#!/bin/sh` launcher: the shell's own real path runs, with the script's real path, then Toolroll's arguments.
  expect(one!.file).toBe(realpathSync("/bin/sh"));
  expect(one!.args).toEqual([realpathSync(join(trusted, "codex")), "login"]);
  expect(one!.cwd).toMatch(/\/live\/agent-[0-9a-f]{32}$/);
  expect(readdirSync(one!.cwd)).toEqual([]);
  // The person's own HOME (the agent keeps its login there), the interpreter's folder and trusted folders, nothing of Toolroll's.
  expect(one!.env["HOME"]).toBe(realpathSync(bins));
  expect(one!.env["PATH"]).toBe(`${realpathSync("/bin")}:${trusted}`);
  expect(Object.keys(one!.env).sort()).toEqual(["COLORTERM", "HOME", "LANG", "PATH", "TERM", "USER"]);
  expect(JSON.stringify(one!.env)).not.toContain("never-handed-on");
});

test("a stand-in launcher's interpreter is pinned: its real path runs with the script's, never the script by itself", async () => {
  path = launcher;
  expect((await start("sign-in", { agent: "codex" })).status).toBe(200);
  expect(spawned.map(one => [one.file, one.args])).toEqual([[realpathSync(join(launcher, "fakenode")), [realpathSync(join(launcher, "codex")), "login"]]]);
  expect(spawned[0]!.env["PATH"]).toBe(launcher);
});

test("a launcher whose first line passes its interpreter arguments runs nothing", async () => {
  const dir = join(bins, "flags");
  mkdirSync(dir, { mode: 0o755 });
  interpreter(dir, "fakenode");
  path = dir;
  for (const first of ["#!/usr/bin/env -S fakenode --require=/tmp/x.js", "#!/usr/bin/env fakenode --require=/tmp/x.js", `#!${realpathSync(join(dir, "fakenode"))} --inspect`]) {
    script(dir, "codex", first);
    const answer = await start("sign-in", { agent: "codex" });
    expect(answer.status, first).toBe(409);
    expect(answer.body, first).toMatchObject({ ok: false, error: expect.stringMatching(/passes its interpreter arguments/) });
  }
  expect(spawned).toEqual([]);
});

test("a `node` linked into a project checkout never runs, though its PATH folder is trusted", async () => {
  path = `${hijacked}:${launcher}`;
  const answer = await start("sign-in", { agent: "codex" });
  expect(answer.status).toBe(409);
  expect(answer.body).toMatchObject({ ok: false, error: expect.stringMatching(/interpreter `node`: it is inside a project/) });
  expect(spawned).toEqual([]);
});

test("an untrusted binary earlier on PATH runs nothing, and the trusted one after it is never tried", async () => {
  path = `${writable}:${trusted}`;
  const answer = await start("sign-in", { agent: "codex" });
  expect(answer.status).toBe(409);
  expect(answer.body).toMatchObject({ ok: false, error: expect.stringMatching(/won't run `codex`: others can change/) });
  expect(spawned).toEqual([]);
});

test("an agent with no command of Toolroll's, or an id it doesn't know, starts nothing", async () => {
  path = trusted;
  expect((await start("sign-in", { agent: "openrouter" })).status).toBe(409);
  expect((await start("sign-in", { agent: "../../bin/sh" })).status).toBe(400);
  expect((await start("install", { agent: "goose", confirm: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash" })).status).toBe(409);
  expect(spawned).toEqual([]);
});

test("an install runs only on the confirm of exactly the command shown", async () => {
  path = trusted;
  expect((await start("install", { agent: "codex" })).body).toEqual({ ok: false, error: "Confirm the exact install command first." });
  expect((await start("install", { agent: "codex", confirm: "npm install -g @openai/codex@evil" })).status).toBe(409);
  expect(spawned).toEqual([]);
  const answer = await start("install", { agent: "codex", confirm: "npm install -g @openai/codex" });
  expect(answer.status).toBe(200);
  expect(spawned.map(one => [one.file, one.args])).toEqual([[realpathSync("/bin/sh"), [realpathSync(join(trusted, "npm")), "install", "-g", "@openai/codex"]]]);
});

test("an unattached sign-in that prints a token and ends leaves nothing behind; one nobody attaches to ends by itself", async () => {
  path = trusted;
  const first = (await start("sign-in", { agent: "codex" })).body as { id: string };
  spawned[0]!.emit("Your token: sk-ant-oat01-FAKE-not-a-real-token-0123456789\r\n");
  expect(host.heldBytes(first.id)).toBeGreaterThan(0);
  spawned[0]!.exit(0);
  expect(host.heldBytes(first.id)).toBe(0);
  expect(await host.replay(first.id)).toBe("");
  // Removed once it ended (well before the wait for its page would have ended it).
  await expect.poll(() => host.get(first.id), { timeout: 2_500 }).toBeNull();
  spawned.length = 0;
  // Nobody attaches: ended and dropped after the wait (5 s here, 30 s in a console).
  const second = (await start("sign-in", { agent: "codex" })).body as { id: string };
  spawned[0]!.emit("secret-ish output\r\n");
  await expect.poll(() => host.get(second.id), { timeout: 10_000 }).toBeNull();
  expect(host.heldBytes(second.id)).toBe(0);
});

test("more than the held cap before the page attaches: dropped, and the page is told", async () => {
  path = trusted;
  const { id } = (await start("sign-in", { agent: "codex" })).body as { id: string };
  spawned[0]!.emit("x".repeat(300 * 1024));
  expect(host.heldBytes(id)).toBe(0);
  const seen: string[] = [];
  host.attach(id, { output: data => seen.push(data.toString("utf8")), control: () => {} });
  expect(seen.join("")).toContain("earlier output was dropped");
});

test("repeated sign-ins never use up a person's terminals; a second one while one runs is refused politely", async () => {
  path = trusted;
  for (let i = 0; i < 20; i += 1) {
    const { id } = (await start("sign-in", { agent: "codex" })).body as { id: string };
    spawned.at(-1)!.exit(0);
    await expect.poll(() => host.get(id), { timeout: 2_500 }).toBeNull();
  }
  // A project terminal still starts (the 16 kept and 8 running are a person's terminals, not sign-ins).
  const project = await host.start({ name: "alex", generation: world.store.accountOf("alex")!.generation }, world.repo, "shell");
  expect(project.agent).toBeNull();
  await host.close(project.id);
  await host.remove(project.id).catch(() => {});
  spawned.length = 0;
  expect((await start("sign-in", { agent: "codex" })).status).toBe(200);
  expect(await start("sign-in", { agent: "claude" })).toEqual({ status: 409, body: { ok: false, error: "A sign-in or install is already open. Finish it (or close it) first." } });
  // While it runs, a person still has all their running terminals.
  const owner = { name: "alex", generation: world.store.accountOf("alex")!.generation };
  const mine: string[] = [];
  for (let i = 0; i < MAX_LIVE_TERMINALS; i += 1) mine.push((await host.start(owner, world.repo, "shell")).id);
  for (const id of mine) { await host.close(id); await host.remove(id).catch(() => {}); }
});

test("the agent socket closes once the session is no longer this console start's workbench (its terminal epoch changed)", async () => {
  path = trusted;
  const who = await workbench();
  const { id } = (await start("sign-in", { agent: "codex" }, who)).body as { id: string };
  const ws = new WebSocket(`ws://127.0.0.1:${world.port}/term/${id}/socket`, ["toolroll", `toolroll.key.${who.key}`],
    { headers: { cookie: who.cookie, origin: world.origin, host: `127.0.0.1:${world.port}` } });
  const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
  const hello = new Promise<void>((resolve, reject) => { ws.on("message", (data, binary) => { if (!binary && String(data).includes("hello")) resolve(); }); ws.on("unexpected-response", (_, response) => reject(Error(`refused ${response.statusCode}`))); });
  await hello;
  // Another console start re-keys the saved session (its epoch is no longer this start's): the next proof closes it.
  const db = new DatabaseSync(join(world.configDir, "state.db"));
  try { db.exec("PRAGMA busy_timeout = 5000"); db.prepare("UPDATE web_session SET key_epoch = 'terminal:another-start' WHERE account = 'alex'").run(); } finally { db.close(); }
  spawned[0]!.emit("more output\r\n");
  expect(await closed).toBe(4401);
  // And it ends with its socket: nothing of it stays.
  await expect.poll(() => host.get(id), { timeout: 10_000 }).toBeNull();
});

test("a sign-in pane keeps nothing: no replay, one page once, nothing held after it ends", async () => {
  path = trusted;
  const answer = await start("sign-in", { agent: "codex" });
  const id = (answer.body as { id: string }).id;
  const token = "sk-ant-oat01-FAKE-not-a-real-token-0123456789";
  spawned[0]!.emit(`Your token: ${token}\r\n`);
  // What a later page would be shown: nothing.
  expect(await host.replay(id)).toBe("");
  const seen: string[] = [];
  const viewer: TerminalViewer = { output: data => seen.push(data.toString("utf8")), control: () => {} };
  const detach = host.attach(id, viewer);
  // The one page gets what was printed before it attached, then live output.
  spawned[0]!.emit("still waiting\r\n");
  expect(seen.join("")).toContain(token);
  expect(seen.join("")).toContain("still waiting");
  // A second page, or the same one again, is refused.
  expect(() => host.attach(id, { output: () => {}, control: () => {} })).toThrow(/one place only/);
  // Its one page let go: it ends and is gone (it can't be shown again).
  detach();
  await expect.poll(() => host.get(id), { timeout: 10_000 }).toBeNull();
  expect(await host.replay(id)).toBe("");
  // Never listed with projects' terminals.
  const who = await workbench();
  const state = JSON.parse((await world.send("/term/state", "GET", { cookie: who.cookie, accept: "application/json" })).body) as { sessions: { id: string }[] };
  expect(state.sessions.map(one => one.id)).not.toContain(id);
});

test("when the sign-in ends, this computer's agents are looked for again", async () => {
  path = trusted;
  expect((await start("sign-in", { agent: "claude" })).status).toBe(200);
  const before = probes;
  spawned[0]!.exit(0);
  await expect.poll(() => probes, { timeout: 10_000 }).toBeGreaterThan(before);
});

test("Check again asks this computer's agents again and answers the agents read, with each agent's own commands", async () => {
  const before = probes;
  const answer = await post("/engine/agents/check", await workbench(), {});
  expect(answer.status).toBe(200);
  const read = agentsReadSchema.parse(JSON.parse(answer.body));
  expect(probes).toBeGreaterThan(before);
  const codex = read.agents.find(one => one.id === "codex");
  expect(codex?.setup).toMatchObject({ install: "npm install -g @openai/codex", canInstall: true, signIn: "codex login", canSignIn: true });
});

test("only the workbench's own session starts one: a browser session and a request through a proxy are refused", async () => {
  path = trusted;
  // The laptop owner's browser (the same local link, spent by a browser): its session has no terminal key epoch.
  const link = world.server.mintLocalLink()!;
  const spent = await world.send(link, "GET");
  const cookie = [spent.headers["set-cookie"] ?? []].flat().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie })).body) as { csrf: string }).csrf;
  const fromBrowser = await start("sign-in", { agent: "codex" }, { cookie, csrf, key: null });
  expect(fromBrowser.status).toBe(403);
  expect(JSON.stringify(fromBrowser.body)).toMatch(/run toolroll|isn't connected|reconnect/);
  // The workbench's own session, from elsewhere (a proxy forwarded it): refused before anything runs.
  const forwarded = await start("sign-in", { agent: "codex" }, await workbench(), { "x-forwarded-for": "203.0.113.7" });
  expect(forwarded.status).toBeGreaterThanOrEqual(400);
  expect(spawned).toEqual([]);
});

test("a valid API token never starts one, nor changes models", async () => {
  path = trusted;
  const minted = mintApiToken();
  world.store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  const bearer = { authorization: `Bearer ${minted.token}`, origin: world.origin, "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const sign = await world.send("/term/agent/sign-in", "POST", bearer, new URLSearchParams({ agent: "codex", password: "" }).toString());
  expect(sign.status).toBeGreaterThanOrEqual(400);
  const install = await world.send("/term/agent/install", "POST", bearer, new URLSearchParams({ agent: "codex", confirm: "npm install -g @openai/codex", password: "" }).toString());
  expect(install.status).toBeGreaterThanOrEqual(400);
  const models = await world.send("/settings/models/agent", "POST", bearer, new URLSearchParams({ build: "codex|gpt-6-sol", digest: "x", password: "" }).toString());
  expect(models.status).toBeGreaterThanOrEqual(400);
  expect(spawned).toEqual([]);
});

// Last: these change who uses this Toolroll (a password, then a second person).
test("models: a solo local owner changes them through Settings → Models' write; a full session can't start a pane; a team install refuses both", async () => {
  path = trusted;
  const who = await workbench();
  const read = async () => modelsReadSchema.parse(JSON.parse((await world.send("/engine/models", "GET", { cookie: who.cookie, accept: "application/json" })).body));
  const before = await read();
  expect(before.canChange).toBe(true);
  const codex = before.presets.find(one => one.agent === "codex")!;
  const saved = await post("/settings/models/agent", who, { password: "", scope: "installation", digest: before.digest, ...codex.fields });
  expect(saved.status).toBe(303);
  expect(saved.headers.location).toMatch(/said=/);
  expect(world.store.phaseConfig("installation", "build")).toMatchObject({ provider: "codex" });
  // The ledger row the web writes, for each role.
  expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action LIKE 'agent for % changed' AND actor = 'alex'").get()!["n"]).toBeGreaterThan(0);
  // A second person: no longer solo. The workbench's local sign-in starts no pane and changes no model.
  world.store.saveApprover("robin", hashPassword("robin-password-1"), new Date());
  const team = await start("sign-in", { agent: "codex" }, who);
  expect(team.status).toBeGreaterThanOrEqual(400);
  const after = await read();
  const back = world.store.phaseConfig("installation", "build");
  const refused = await post("/settings/models/agent", who, { password: "", scope: "installation", digest: after.digest, ...before.presets.find(one => one.agent === "claude")!.fields });
  expect(refused.status).toBeGreaterThanOrEqual(300);
  expect(refused.headers.location ?? "").not.toMatch(/said=/);
  expect(world.store.phaseConfig("installation", "build")).toEqual(back);
  // A full password session (robin's, an approver here) is a browser's: refused with the workbench's words.
  const login = await world.send("/login", "POST", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "robin", token: "robin-password-1" }).toString());
  const cookie = [login.headers["set-cookie"] ?? []].flat().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="));
  if (cookie !== undefined) {
    const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie })).body) as { csrf: string }).csrf;
    const full = await start("sign-in", { agent: "codex", password: "robin-password-1" }, { cookie, csrf, key: null });
    expect(full.status).toBeGreaterThanOrEqual(400);
  }
  expect(spawned).toEqual([]);
});

// A full password session of the only operator, on this computer, solo, with the password typed now: everything a
// browser terminal start needs. Only the workbench rule refuses it.
test("a full browser session, password typed, starts no pane: only the terminal workbench's own session does", async () => {
  const { openStore } = await import("../store.js");
  const { createDecisionServer } = await import("../serve.js");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-agent-full-")));
  const store = openStore(":memory:");
  expect(store.bootstrapApproverIfNone("alex", hashPassword("alex-password-1"), new Date())).toEqual({ ok: true });
  path = trusted;
  const server = createDecisionServer({ store, evidenceRoot: dir, repos: [dir], terminalHost: host, agentCommandEnv: () => ({ PATH: path, HOME: bins }) } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: "alex-password-1" }), redirect: "manual" });
    const cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const csrf = /data-csrf="([^"]+)"/.exec(await (await fetch(`${base}/term`, { headers: { cookie } })).text())![1]!;
    const answer = await fetch(`${base}/term/agent/sign-in`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" },
      body: new URLSearchParams({ csrf, agent: "codex", password: "alex-password-1" }), redirect: "manual" });
    expect({ status: answer.status, body: await answer.json() }).toEqual({ status: 403, body: { ok: false, error: WORKBENCH_ONLY } });
    expect(spawned).toEqual([]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
