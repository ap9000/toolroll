/**
 * Evidence, against the real Claude Code, for the sign-in relay's answers (the thread sign-in plan v2 §4 step 5): which
 * of the relay's exact refusals the real client shows once and stops on, and which it retries silently. The real binary
 * (TOOLROLL_TEST_REAL_CLAUDE, a person's opt-in: test/setup-state.ts; unset, as in CI, this skips with that note) is
 * pointed at a stand-in relay on loopback with a made-up relay token, from an empty working folder, with an environment
 * made by the repo's isolation helpers (scripts/isolated-env.mjs isolatedEnvironment, checked by assertIsolated: the
 * only names added are the stand-in's address and the made-up token), inside a macOS sandbox (sandbox-exec) that:
 * - denies every file by default: it may read only /System, /usr, /dev, the root folder's listing, the binary itself and
 *   the metadata of the folders above the world and the binary, and read and write only the test's own world;
 * - denies every network connection but the stand-in's own loopback port (Unix sockets included);
 * - denies the keychain's services.
 * Other operations (process launch, other system services) stay allowed by the profile's default; it is a sandbox for
 * the files, network and keychain this evidence must not touch. No model is reached and no real credential exists.
 *
 * Findings it records (Claude Code 2.1.321, 2026-11-17): every one of the relay's 403 permission_error answers is shown
 * once, as "… API Error: 403 <Toolroll's words>", after exactly one request, with no `/login` suggestion; a raw 401 and
 * a 503 are each retried with nothing shown (nine requests in two minutes): so the relay's refusals that end a turn are
 * all Toolroll's own 403s, never Claude's 401 or a 5xx.
 */
import { afterEach, describe, expect, test } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { signInRefusedWords } from "./flexible-sign-in.js";
import { RELAY_CALL_ANSWERS } from "./flexible-relay.js";
// @ts-expect-error plain ESM script without declarations
import { assertIsolated, isolatedEnvironment } from "../scripts/isolated-env.mjs";

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

/** Every folder from `path` up to the root. */
const above = (path: string): string[] => { const out: string[] = []; for (let at = path; ; at = dirname(at)) { out.push(at); if (at === dirname(at)) return out; } };
const quoted = (path: string) => JSON.stringify(path);

/** The sandbox: files denied by default (system libraries, the binary and the world only), network to one port only,
 * no keychain services. */
function profile(world: string, binary: string, port: number): string {
  const metadata = [...new Set([...above(world), ...above(binary)])].map(one => `(literal ${quoted(one)})`).join(" ");
  return `(version 1)
(allow default)
(deny file-read* file-write*)
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/dev") (literal "/") (literal ${quoted(binary)}))
(allow file-read-metadata ${metadata})
(allow file-read* file-write* (subpath ${quoted(world)}))
(allow file-write* (subpath "/dev"))
(deny network-outbound)
(allow network-outbound (remote ip "localhost:${port}"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.secd") (global-name "com.apple.trustd.agent"))
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-real-claude-")));
  dirs.push(root);
  const world = isolatedEnvironment({ root }) as { env: Record<string, string>; home: string; tmp: string };
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const binary = realpathSync(CLAUDE!);
  const sandbox = join(root, "profile.sb");
  writeFileSync(sandbox, profile(root, binary, port));
  // The sandbox really holds the person's own Claude folder and their home shut.
  const own = join(userInfo().homedir, ".claude");
  if (existsSync(own)) expect(spawnSync(SANDBOX, ["-f", sandbox, "/bin/ls", own], { env: { PATH: "/usr/bin:/bin" } }).status).not.toBe(0);
  expect(spawnSync(SANDBOX, ["-f", sandbox, "/bin/ls", userInfo().homedir], { env: { PATH: "/usr/bin:/bin" } }).status).not.toBe(0);
  const env: Record<string, string> = { ...world.env, CLAUDE_CONFIG_DIR: join(world.home, ".claude"), CLAUDE_CODE_TMPDIR: world.tmp,
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  assertIsolated(env, { root });
  // The only names added past the check: the stand-in relay's loopback address and a made-up relay token, exactly what a
  // thread's agent is given.
  const relay = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: `tr-relay-${randomBytes(24).toString("hex")}` };
  const child = spawn(SANDBOX, ["-f", sandbox, binary, "-p", "hi", "--model", "claude-sonnet-4-5"], { cwd, env: { ...env, ...relay }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", chunk => { out += String(chunk); });
  child.stderr!.on("data", chunk => { out += String(chunk); });
  let stopped = false;
  const guard = setTimeout(() => { stopped = true; child.kill("SIGKILL"); }, limitMs); // guard: bound a ceiling on the real client's own retries; its exit wins
  const code = await new Promise<number | null>(done => child.once("exit", exit => done(exit)));
  clearTimeout(guard);
  // Its working folder holds nothing it wasn't given.
  expect(readdirSync(cwd)).toEqual([]);
  return { out, code, calls, stopped };
}

/** Every relay refusal that ends the agent's turn: Toolroll's own 403s, exactly as the relay sends them. */
const TURN_ENDING = [
  ...[401, 403].map(upstream => [`a sign-in Claude refused (${upstream})`, { type: "permission_error", message: signInRefusedWords(upstream) }] as const),
  ...(["unsettled", "check-failed", "no-sign-in", "sign-in-refused", "threads-off", "billing-mismatch"] as const)
    .map(reason => [reason, { type: RELAY_CALL_ANSWERS[reason].type, message: RELAY_CALL_ANSWERS[reason].message }] as const),
];

describe("the real Claude Code against the relay's answers", () => {
  test("every turn-ending refusal the relay sends is Toolroll's own 403", () => {
    for (const reason of ["unsettled", "check-failed", "no-sign-in", "sign-in-refused", "threads-off", "billing-mismatch"] as const) {
      expect(RELAY_CALL_ANSWERS[reason], reason).toMatchObject({ status: 403, type: "permission_error" });
    }
  });

  test.for(TURN_ENDING)("%s: the relay's 403 is shown once, in Toolroll's words, with no retry and no /login", async ([, error], ctx) => {
    if (WHY_NOT !== null) { ctx.skip(WHY_NOT); return; }
    const seen = await run(403, { type: "error", error }, 90_000);
    expect(seen.stopped).toBe(false);
    expect(seen.calls).toBe(1);
    expect(seen.code).not.toBe(0);
    expect(seen.out).toContain(error.message);
    expect(seen.out).not.toMatch(/\/login/);
  }, 120_000);

  test.for([[401, "authentication_error"], [503, "api_error"]] as const)("why not answer %i: the real client retries it and shows nothing while it does", async ([status, type], ctx) => {
    if (WHY_NOT !== null) { ctx.skip(WHY_NOT); return; }
    const seen = await run(status, { type: "error", error: { type, message: "no" } }, 30_000);
    expect(seen.calls).toBeGreaterThan(1);
  }, 60_000);
});
