/**
 * Live terminals over real HTTP and a real WebSocket (docs/plans/live-terminal.md): start takes a fresh password, the
 * socket's upgrade refuses every wrong host, origin, credential and owner before it is accepted, typed input reaches
 * the program and its output comes back, and a sign-out closes an open socket.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { loadPtySpawn, TerminalHost } from "./live-terminal.js";
import { T0 } from "../test/serve-kit.js";

const spawn = loadPtySpawn();
let home: string, repo: string, store: Store, server: Server, base: string, port: number, token: string, host: TerminalHost;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "so-term-http-")));
  repo = join(home, "project");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
  store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  host = new TerminalHost({ spawn: spawn!, worktreeRoot: join(home, "live"), closeGraceMs: 300,
    programs: { claude: { file: "/bin/cat", args: [] }, shell: { file: "/bin/sh", args: [] } }, env: () => ({ PATH: process.env["PATH"] ?? "", HOME: home }) });
  server = createDecisionServer({ store, evidenceRoot: home, repos: [repo], terminalHost: host } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  port = address.port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const login = async (name = "alex", password = token) => {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: password }), redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
};
const csrfOf = async (cookie: string) => {
  const html = await (await fetch(`${base}/term`, { headers: { cookie } })).text();
  return /data-csrf="([^"]+)"/.exec(html)![1]!;
};
const post = async (cookie: string, path: string, fields: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams(fields), redirect: "manual" });
  return { status: response.status, body: await response.json() as { ok: boolean; id?: string; error?: string } };
};
const start = async (cookie: string) => {
  const started = await post(cookie, "/term/start", { csrf: await csrfOf(cookie), repo, program: "claude", password: token });
  expect(started).toMatchObject({ status: 200, body: { ok: true } });
  return started.body.id!;
};

/** An upgrade's outcome: the HTTP status it was refused with, or "open". */
const upgrade = (path: string, headers: Record<string, string>) => new Promise<number | "open">(resolve => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  ws.on("open", () => { ws.close(); resolve("open"); });
  ws.on("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); response.resume(); });
  ws.on("error", () => resolve(0));
});

/** An open socket, its output so far, its control frames, and how it closed. */
const attach = (id: string, cookie: string) => new Promise<{ ws: WebSocket; out: () => string; controls: Array<Record<string, unknown>>; closed: Promise<number> }>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${id}/socket`, { headers: { cookie, origin: base } });
  let out = "";
  const controls: Array<Record<string, unknown>> = [];
  const closed = new Promise<number>(done => ws.on("close", code => done(code)));
  ws.on("message", (data, binary) => { if (binary) out += (data as Buffer).toString(); else controls.push(JSON.parse(String(data)) as Record<string, unknown>); });
  ws.on("open", () => resolve({ ws, out: () => out, controls, closed }));
  ws.on("unexpected-response", (_request, response) => reject(new Error(`refused ${response.statusCode}`)));
});
const until = async (check: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
};

describe.skipIf(spawn === null || process.platform === "win32")("live terminals over HTTP", () => {
  test("a server whose terminal couldn't be proved stopped still closes, and says so", async () => {
    const blindHost = new TerminalHost({ spawn: spawn!, worktreeRoot: join(home, "blind"), closeGraceMs: 200, programs: { claude: { file: "/bin/cat", args: [] } },
      env: () => ({ PATH: process.env["PATH"] ?? "" }), residents: () => null });
    const blind = createDecisionServer({ store, evidenceRoot: home, repos: [repo], terminalHost: blindHost } as Parameters<typeof createDecisionServer>[0]);
    await new Promise<void>(resolve => blind.listen(0, "127.0.0.1", resolve));
    await blindHost.start({ name: "alex", generation: store.accountOf("alex")!.generation }, repo, "claude");
    const error = await new Promise<Error | undefined>(resolve => blind.close(resolve));
    expect(error?.message).toMatch(/could not be proved stopped/);
    expect(blind.listening).toBe(false);
  });

  test("start takes the operator's password; nothing starts without it", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    expect(await post(cookie, "/term/start", { csrf, repo, program: "claude" })).toMatchObject({ status: 403, body: { ok: false } });
    expect(await post(cookie, "/term/start", { csrf, repo, program: "claude", password: "wrong-password" })).toMatchObject({ status: 403, body: { ok: false } });
    expect(await post(cookie, "/term/start", { csrf, repo: home, program: "claude", password: token })).toMatchObject({ status: 403 });
    expect(await post(cookie, "/term/start", { csrf, repo, program: "vim", password: token })).toMatchObject({ status: 400 });
    expect(host.list("alex")).toHaveLength(0);
    const id = await start(cookie);
    const state = await (await fetch(`${base}/term/state`, { headers: { cookie } })).json() as { sessions: Array<{ id: string; program: string }> };
    expect(state.sessions).toEqual([expect.objectContaining({ id, program: "claude" })]);
  });

  test("every wrong upgrade is refused before it opens", async () => {
    const cookie = await login();
    const id = await start(cookie);
    const path = `/term/${id}/socket`;
    expect(await upgrade(path, { cookie, origin: base })).toBe("open");
    expect(await upgrade(path, { cookie })).toBe(403);
    expect(await upgrade(path, { cookie, origin: "http://evil.example" })).toBe(403);
    expect(await upgrade(path, { cookie, origin: `https://127.0.0.1:${port}` })).toBe(403);
    expect(await upgrade(path, { cookie, origin: base, host: "evil.example" })).toBe(421);
    expect(await upgrade(path, { origin: base })).toBe(401);
    expect(await upgrade(path, { cookie, origin: base, authorization: `Bearer alex:${token}` })).toBe(403);
    expect(await upgrade(`${path}?token=x`, { cookie, origin: base })).toBe(400);
    expect(await upgrade(`/term/${"b".repeat(32)}/socket`, { cookie, origin: base })).toBe(404);
    expect(await upgrade("/live", { cookie, origin: base })).toBe(0);
    // A plain GET of the socket address only says it takes an upgrade.
    expect((await fetch(`${base}${path}`, { headers: { cookie } })).status).toBe(426);
  });

  test("typing reaches the program and its output comes back; close says it ended", async () => {
    const cookie = await login();
    const id = await start(cookie);
    const live = await attach(id, cookie);
    await until(() => live.controls.some(one => one["t"] === "hello"));
    live.ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
    live.ws.send(JSON.stringify({ t: "in", d: "ping-from-the-phone\r" }));
    await until(() => live.out().includes("ping-from-the-phone"));
    // A late page gets the scrollback first.
    const late = await attach(id, cookie);
    await until(() => late.out().includes("ping-from-the-phone"));
    late.ws.close();
    expect(await post(cookie, `/term/${id}/close`, { csrf: await csrfOf(cookie) })).toMatchObject({ status: 200, body: { ok: true } });
    await until(() => live.controls.some(one => one["t"] === "exit"));
    const worktree = host.get(id)!.worktree;
    expect(existsSync(worktree)).toBe(true);
    expect(await post(cookie, `/term/${id}/remove`, { csrf: await csrfOf(cookie) })).toMatchObject({ status: 200 });
    expect(existsSync(worktree)).toBe(false);
  });

  test("a frame that isn't a terminal frame closes the socket", async () => {
    const cookie = await login();
    const live = await attach(await start(cookie), cookie);
    live.ws.send(JSON.stringify({ t: "exec", d: "rm -rf /" }));
    expect(await live.closed).toBe(1003);
  });

  test("signing out closes an open terminal socket", async () => {
    const cookie = await login();
    const live = await attach(await start(cookie), cookie);
    await until(() => live.controls.some(one => one["t"] === "hello"));
    await fetch(`${base}/logout`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual" });
    expect(await live.closed).toBe(4401);
  });
});
