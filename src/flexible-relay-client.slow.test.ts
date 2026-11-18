/**
 * Evidence, against the real Claude Code, for the sign-in relay's answers (the thread sign-in plan v2 §4 step 5): which
 * status keeps Claude Code from retrying and from suggesting `/login`, and what it shows the person. The real binary
 * (TOOLROLL_TEST_REAL_CLAUDE, a person's opt-in: test/setup-state.ts; unset, as in CI, this skips with that note) is
 * pointed at a stand-in relay on loopback with a made-up relay token, and run inside a macOS sandbox (sandbox-exec)
 * that denies every network but loopback, the keychain's services, and the person's own ~/.claude, ~/.claude.json,
 * ~/.config, Keychains and Claude application folders, with a throwaway HOME, CLAUDE_CONFIG_DIR and an environment
 * built from nothing. No model is reached and no real credential exists anywhere in it.
 *
 * Findings it records (Claude Code 2.1.321, 2026-11-17): the relay's 403 permission_error carrying Toolroll's words is
 * shown once, as "Failed to authenticate. API Error: 403 <Toolroll's words>", after exactly one request, with no
 * `/login` suggestion; a raw 401 and a 503 are each retried (nine requests in two minutes, nothing shown): so the relay
 * answers a refused or missing sign-in with 403, never Claude's 401 or a 5xx.
 */
import { afterEach, describe, expect, test } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { signInRefusedWords } from "./flexible-sign-in.js";

const CLAUDE = process.env["TOOLROLL_TEST_REAL_CLAUDE"];
const SANDBOX = "/usr/bin/sandbox-exec";
const WHY_NOT = process.platform !== "darwin" ? "the isolation this evidence needs is the macOS sandbox (sandbox-exec)"
  : CLAUDE === undefined ? "set TOOLROLL_TEST_REAL_CLAUDE to the installed claude binary to record this evidence (the owner runs it once before a release)"
  : !existsSync(SANDBOX) ? "this Mac has no /usr/bin/sandbox-exec" : null;

const servers: Server[] = [], children: ChildProcess[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The sandbox: everything allowed but the network beyond loopback, the keychain's services, and the person's own
 * Claude, config and keychain folders (read or write). */
function profile(home: string): string {
  const quoted = (path: string) => JSON.stringify(path);
  return `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.secd") (global-name "com.apple.trustd.agent"))
(deny file-read* file-write* (subpath ${quoted(join(home, ".claude"))}) (literal ${quoted(join(home, ".claude.json"))}) (subpath ${quoted(join(home, ".config"))}) (subpath ${quoted(join(home, "Library", "Keychains"))}) (subpath ${quoted(join(home, "Library", "Application Support", "Claude"))}))
`;
}

/** One run of the real client against a stand-in relay answering every call with `status` and `body`: what it printed,
 * how it exited, and how many calls reached the stand-in (bounded: stopped after `limitMs`). */
async function run(status: number, body: unknown, limitMs: number): Promise<{ out: string; code: number | null; calls: number; stopped: boolean }> {
  let calls = 0;
  const server = createServer((request, response) => { request.resume(); request.on("end", () => { calls++; response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); }); });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "so-real-claude-"));
  dirs.push(dir);
  const sandbox = join(dir, "profile.sb");
  writeFileSync(sandbox, profile(userInfo().homedir));
  // The sandbox really holds the person's own Claude folder shut (when there is one to hold shut).
  const own = join(userInfo().homedir, ".claude");
  if (existsSync(own)) expect(spawnSync(SANDBOX, ["-f", sandbox, "/bin/ls", own], { env: { PATH: "/usr/bin:/bin" } }).status).not.toBe(0);
  const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), CLAUDE_CONFIG_DIR: join(dir, ".claude"), TMPDIR: dir, PATH: "/usr/bin:/bin",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: `tr-relay-${randomBytes(24).toString("hex")}`,
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const child = spawn(SANDBOX, ["-f", sandbox, CLAUDE!, "-p", "hi", "--model", "claude-sonnet-4-5"], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", chunk => { out += String(chunk); });
  child.stderr!.on("data", chunk => { out += String(chunk); });
  let stopped = false;
  // The real client's own retries decide how long it takes; past this it is stopped (and said so).
  const guard = setTimeout(() => { stopped = true; child.kill("SIGKILL"); }, limitMs); // guard: bound a ceiling on the real client's own retries; its exit wins
  const code = await new Promise<number | null>(done => child.once("exit", exit => done(exit)));
  clearTimeout(guard);
  return { out, code, calls, stopped };
}

describe("the real Claude Code against the relay's answers", () => {
  test.for([401, 403])("a refused sign-in (Claude answered %i): the relay's 403 is shown once, in Toolroll's words, with no retry and no /login", async (upstream, ctx) => {
    if (WHY_NOT !== null) { ctx.skip(WHY_NOT); return; }
    const words = signInRefusedWords(upstream);
    const seen = await run(403, { type: "error", error: { type: "permission_error", message: words } }, 90_000);
    expect(seen.stopped).toBe(false);
    expect(seen.calls).toBe(1);
    expect(seen.code).not.toBe(0);
    expect(seen.out).toContain(words);
    expect(seen.out).not.toMatch(/\/login/);
  }, 120_000);

  test.for([[401, "authentication_error"], [503, "api_error"]] as const)("why not answer %i: the real client retries it and shows nothing while it does", async ([status, type], ctx) => {
    if (WHY_NOT !== null) { ctx.skip(WHY_NOT); return; }
    const seen = await run(status, { type: "error", error: { type, message: "no" } }, 30_000);
    expect(seen.calls).toBeGreaterThan(1);
  }, 60_000);
});
