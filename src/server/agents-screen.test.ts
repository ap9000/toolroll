/**
 * The terminal workbench's Agents screen, through the real console routes (stand-in binaries and a stand-in pty only:
 * no real sign-in, install or model call):
 *
 * - an agent's own sign-in runs exactly the trusted install's real path with Toolroll's own arguments, from a fresh
 *   empty folder, with an environment built from nothing; an untrusted binary earlier on PATH runs nothing (a later,
 *   trusted one is never tried); a token and a team install's local sign-in are refused;
 * - an install runs only on the confirm of exactly the command shown;
 * - when the program ends, this computer's agents are looked for again; Check again does the same on demand;
 * - the installation's models change through Settings → Models' own write: a solo local owner may, a team install's
 *   local sign-in and a token may not.
 */
import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { TerminalHost, type Pty } from "../live-terminal.js";
import { agentsReadSchema, modelsReadSchema, termStartedSchema } from "../contracts/engine-api.js";
import { hashPassword } from "../scope.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";

type Spawned = { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; exit: (code: number) => void };
const spawned: Spawned[] = [];
let probes = 0;
let world: LocalWorld;
let bins: string, trusted: string, writable: string, root: string;
let path = "";

/** A stand-in program: a shell script that would print its name (it never runs; the pty is a stand-in). */
function program(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\necho stand-in\n");
  chmodSync(file, 0o755);
  return realpathSync(file);
}

beforeAll(async () => {
  bins = realpathSync(mkdtempSync(join(tmpdir(), "so-agent-bins-")));
  trusted = join(bins, "trusted"); writable = join(bins, "shared");
  for (const dir of [trusted, writable]) { rmSync(dir, { recursive: true, force: true }); writeFileSync(join(bins, ".keep"), ""); }
  const { mkdirSync } = await import("node:fs");
  mkdirSync(trusted, { mode: 0o755 }); mkdirSync(writable);
  chmodSync(writable, 0o777);
  for (const name of ["codex", "npm", "claude"]) program(trusted, name);
  program(writable, "codex");
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-agent-term-")));
  const spawn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Pty => {
    let exited: ((exit: { exitCode: number }) => void) | null = null;
    spawned.push({ file, args, cwd: options.cwd, env: options.env, exit: code => exited?.({ exitCode: code }) });
    return { pid: 2_147_000_000, tty: null, pendingInput: () => 0, onData: () => {}, onExit: listener => { exited = listener; }, write() {}, resize() {}, kill() {} };
  };
  const host = new TerminalHost({ spawn, worktreeRoot: join(root, "live"), processes: () => new Map(), closeGraceMs: 1 });
  world = await openLocalWorld({
    terminalHost: host,
    agentCommandEnv: () => ({ PATH: path, HOME: bins, USER: "alex", LANG: "C", TOOLROLL_TOKEN: "never-handed-on", GITHUB_TOKEN: "never-handed-on" }),
    connectionProbe: async () => { probes += 1; return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }; },
  });
}, LOCAL_WORLD_SETUP_MS);
afterAll(async () => {
  await world.close();
  rmSync(bins, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => { spawned.length = 0; path = ""; });

const start = async (kind: "sign-in" | "install", form: Record<string, string>, who?: { cookie: string; csrf: string }) => {
  const session = who ?? await world.localSession();
  const answer = await world.post(`/term/agent/${kind}`, session.cookie, { csrf: session.csrf, password: "", ...form }, "application/json");
  return { status: answer.status, body: termStartedSchema.parse(JSON.parse(answer.body)) };
};

test("an agent's sign-in runs exactly the trusted install with Toolroll's own arguments, from an empty folder, with no Toolroll credential", async () => {
  path = trusted;
  const answer = await start("sign-in", { agent: "codex" });
  expect(answer).toEqual({ status: 200, body: { ok: true, id: expect.stringMatching(/^[0-9a-f]{32}$/) } });
  expect(spawned).toHaveLength(1);
  const [one] = spawned;
  expect(one!.file).toBe(realpathSync(join(trusted, "codex")));
  expect(one!.args).toEqual(["login"]);
  expect(one!.cwd).toMatch(/\/live\/agent-[0-9a-f]{32}$/);
  expect(readdirSync(one!.cwd)).toEqual([]);
  // The person's own HOME (the agent keeps its login there), trusted PATH folders, nothing of Toolroll's.
  expect(one!.env["HOME"]).toBe(realpathSync(bins));
  expect(one!.env["PATH"]).toBe(trusted);
  expect(Object.keys(one!.env).sort()).toEqual(["COLORTERM", "HOME", "LANG", "PATH", "TERM", "USER"]);
  expect(JSON.stringify(one!.env)).not.toContain("never-handed-on");
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
  expect(spawned.map(one => [one.file, one.args])).toEqual([[realpathSync(join(trusted, "npm")), ["install", "-g", "@openai/codex"]]]);
});

test("when the sign-in ends, this computer's agents are looked for again", async () => {
  path = trusted;
  expect((await start("sign-in", { agent: "claude" })).status).toBe(200);
  const before = probes;
  spawned[0]!.exit(0);
  await expect.poll(() => probes, { timeout: 10_000 }).toBeGreaterThan(before);
});

test("Check again asks this computer's agents again and answers the agents read, with each agent's own commands", async () => {
  const session = await world.localSession();
  const before = probes;
  const answer = await world.post("/engine/agents/check", session.cookie, { csrf: session.csrf }, "application/json");
  expect(answer.status).toBe(200);
  const read = agentsReadSchema.parse(JSON.parse(answer.body));
  expect(probes).toBeGreaterThan(before);
  const codex = read.agents.find(one => one.id === "codex");
  expect(codex?.setup).toMatchObject({ install: "npm install -g @openai/codex", canInstall: true, signIn: "codex login", canSignIn: true });
});

test("a token never starts one, nor changes models", async () => {
  path = trusted;
  const bearer = { authorization: "Bearer tr_not_a_session", origin: world.origin, "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const sign = await world.send("/term/agent/sign-in", "POST", bearer, new URLSearchParams({ agent: "codex", password: "" }).toString());
  expect(sign.status).toBeGreaterThanOrEqual(400);
  const models = await world.send("/settings/models/agent", "POST", bearer, new URLSearchParams({ build: "codex|gpt-6-sol", digest: "x", password: "" }).toString());
  expect(models.status).toBeGreaterThanOrEqual(400);
  expect(spawned).toEqual([]);
});

test("models: a solo local owner changes the default agent through Settings → Models' write; a team install's local sign-in can't", async () => {
  const session = await world.localSession();
  const read = async () => modelsReadSchema.parse(JSON.parse((await world.send("/engine/models", "GET", { cookie: session.cookie, accept: "application/json" })).body));
  const before = await read();
  expect(before.canChange).toBe(true);
  const codex = before.presets.find(one => one.agent === "codex")!;
  const saved = await world.post("/settings/models/agent", session.cookie, { csrf: session.csrf, password: "", scope: "installation", digest: before.digest, ...codex.fields });
  expect(saved.status).toBe(303);
  expect(saved.headers.location).toMatch(/said=/);
  expect(world.store.phaseConfig("installation", "build")).toMatchObject({ provider: "codex" });
  // The ledger row the web writes, for each role.
  expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action LIKE 'agent for % changed' AND actor = 'alex'").get()!["n"]).toBeGreaterThan(0);
  // A second person: no longer solo, and the local sign-in stands for nothing here.
  world.store.saveApprover("robin", hashPassword("robin-password-1"), new Date());
  const after = await read();
  const back = world.store.phaseConfig("installation", "build");
  const refused = await world.post("/settings/models/agent", session.cookie, { csrf: session.csrf, password: "", scope: "installation", digest: after.digest, ...before.presets.find(one => one.agent === "claude")!.fields });
  expect(refused.status).toBeGreaterThanOrEqual(300);
  expect(refused.headers.location ?? "").not.toMatch(/said=/);
  expect(world.store.phaseConfig("installation", "build")).toEqual(back);
});
