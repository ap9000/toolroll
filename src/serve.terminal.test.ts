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
import { mintApiToken } from "./api-tokens.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { loadPtySpawn, TerminalHost } from "./live-terminal.js";
import { T0 } from "../test/serve-kit.js";
import { INSIDE_FENCE } from "../test/inside-fence.js";

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

  // The release check runs inside the plane's macOS fence, which can't nest a sandbox or observe other processes; CI (Linux, and the tag's macOS jobs) runs these unfenced.
  test.skipIf(INSIDE_FENCE)("typing reaches the program and its output comes back; close says it ended", async () => {
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

  test.skipIf(INSIDE_FENCE)("cross-account full operators share a project terminal with single-controller handoff, while project-excluded accounts get 404", async () => {
    const sam = addApprover(store, "sam", T0, { name: "alex", token });
    if (!sam.ok) throw new Error("sam");
    const outsider = addApprover(store, "outsider", T0, { name: "alex", token });
    if (!outsider.ok) throw new Error("outsider");
    expect(store.setAccountProjects("outsider", [join(home, "other-repo")], "alex", T0).ok).toBe(true);

    const alexCookie = await login("alex", token);
    const samCookie = await login("sam", sam.token);
    const outsiderCookie = await login("outsider", outsider.token);

    const id = await start(alexCookie);
    // Sam sees Alex's project terminal in /term/state.
    const samState = await (await fetch(`${base}/term/state`, { headers: { cookie: samCookie } })).json() as { sessions: Array<{ id: string }> };
    expect(samState.sessions.some(one => one.id === id)).toBe(true);
    // Outsider cannot upgrade (project excluded -> 403/404).
    expect(await upgrade(`/term/${id}/socket`, { cookie: outsiderCookie, origin: base })).toBe(401);

    // Alex attaches first (controller), Sam attaches second (observer).
    const alexLive = await attach(id, alexCookie);
    await until(() => alexLive.controls.some(one => one["t"] === "control" && one["role"] === "controller"));
    const samLive = await attach(id, samCookie);
    await until(() => samLive.controls.some(one => one["t"] === "control" && one["role"] === "observer" && one["controller"] === "alex"));

    // While observer, Sam's keystrokes are ignored; taking control hands over cleanly.
    samLive.ws.send(JSON.stringify({ t: "in", d: "ignored-observer-text\r" }));
    samLive.ws.send(JSON.stringify({ t: "take-control" }));
    await until(() => samLive.controls.some(one => one["t"] === "control" && one["role"] === "controller" && one["controller"] === "sam"));
    samLive.ws.send(JSON.stringify({ t: "in", d: "hello-from-sam\r" }));
    await until(() => alexLive.out().includes("hello-from-sam"));
    expect(alexLive.out()).not.toContain("ignored-observer-text");
    alexLive.ws.close();
    samLive.ws.close();
  });

  test.skipIf(INSIDE_FENCE)("remote TUI act approver discovers and attaches to live central terminals over WebSocket, and drops on token revocation", async () => {
    const alexCookie = await login("alex", token);
    const id = await start(alexCookie);

    const actTok = mintApiToken();
    store.createApiToken({
      id: actTok.id, account: "alex", name: "remote-act", secretHash: actTok.hash,
      access: "act", purpose: "api", by: "alex", projects: [repo],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, T0);
    const readTok = mintApiToken();
    store.createApiToken({
      id: readTok.id, account: "alex", name: "remote-read", secretHash: readTok.hash,
      access: "read", purpose: "api", by: "alex", projects: [repo],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, T0);
    const identity = store.workspaceIdentity();

    const remoteHeaders = (tok: string) => ({
      authorization: `Bearer ${tok}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration,
    });

    // Read-only token is refused (403) on both discovery and WebSocket attach.
    expect(await upgrade(`/term/${id}/socket`, remoteHeaders(readTok.token))).toBe(403);

    // Act approver discovers the live terminal via /api/handoff/terminals.
    const listed = await new Promise<{ status: number; json: { sessions?: Array<{ id: string }> } }>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request({ hostname: "127.0.0.1", port, path: "/api/handoff/terminals", method: "GET", headers: { accept: "application/json", ...remoteHeaders(actTok.token) } }, res => {
          const chunks: Buffer[] = [];
          res.on("data", c => chunks.push(Buffer.from(c)));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sessions?: Array<{ id: string }> } }));
        });
        req.on("error", reject);
        req.end();
      }).catch(reject);
    });
    expect(listed.status).toBe(200);
    expect(listed.json.sessions?.some(one => one.id === id)).toBe(true);

    // Remote WebSocket attach receives hello + control and relays live I/O, then disconnects 4401 on revocation.
    const remoteWs = new WebSocket(`ws://127.0.0.1:${port}/term/${id}/socket`, ["toolroll"], { headers: remoteHeaders(actTok.token) });
    let out = "";
    const controls: Array<Record<string, unknown>> = [];
    const closed = new Promise<number>(done => remoteWs.on("close", code => done(code)));
    remoteWs.on("message", (data, binary) => { if (binary) out += (data as Buffer).toString(); else controls.push(JSON.parse(String(data)) as Record<string, unknown>); });
    await new Promise<void>((resolve, reject) => {
      remoteWs.on("open", () => resolve());
      remoteWs.on("unexpected-response", (_r, res) => reject(new Error(`refused ${res.statusCode}`)));
    });
    await until(() => controls.some(one => one["t"] === "hello"));
    remoteWs.send(JSON.stringify({ t: "in", d: "hello-remote-tui\r" }));
    await until(() => out.includes("hello-remote-tui"));

    // Revoking the API token immediately closes the live remote WebSocket with 4401.
    store.revokeApiToken(actTok.id, "alex", T0);
    expect(await closed).toBe(4401);
  });
});
