/**
 * A run's own sign-in: a service connected by signing in gives each run a
 * fresh access token, made outside the fence at launch, and never the refresh
 * token. A rotated refresh token is kept, renewals never race, a research step
 * asks for its read scopes only, and the run's token is revoked when it ends.
 * The provider here is a real server on this computer that records every
 * request it gets.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { addToolTo, prepareRunTools, readToolSecrets, setToolSecrets, type ToolLaunchArgs, type ToolSpec } from "./project-tools.js";
import { runScope } from "./oauth-run-token.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";
import { boundCheckout } from "../test/bound-checkout.js";

const T0 = new Date("2026-10-13T08:00:00.000Z");
const REFRESH_0 = ["refresh", "canary", "9f".repeat(12)].join("-");
const STORED_ACCESS = ["stored", "access", "4e".repeat(12)].join("-");

type Seen = { path: string; form: Record<string, string>; authorization: string | null; body: string };
/** The service: a token endpoint that rotates its refresh token on every use and refuses a used one, a revocation endpoint, and an MCP server that answers only a live access token. */
function provider(options: { narrow?: boolean; fail?: boolean } = {}) {
  const seen: Seen[] = [];
  let refresh = REFRESH_0, issued = 0;
  const live = new Set<string>();
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const path = request.url ?? "";
      const form = request.headers["content-type"]?.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(body)) : {};
      seen.push({ path, form, authorization: request.headers.authorization ?? null, body });
      const json = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (path === "/token") {
        if (options.fail === true) return json(400, { error: "invalid_grant", error_description: `refresh ${form["refresh_token"]} is gone` });
        if (form["refresh_token"] !== refresh) return json(400, { error: "invalid_grant" });
        if (form["scope"] !== undefined && options.narrow === false) return json(400, { error: "invalid_scope" });
        refresh = `refresh-rotated-${++issued}`;
        const access = `run-access-${issued}`;
        live.add(access);
        return json(200, { access_token: access, refresh_token: refresh, expires_in: 900, token_type: "Bearer", ...(form["scope"] === undefined ? {} : { scope: form["scope"] }) });
      }
      if (path === "/revoke") { live.delete(form["token"] ?? ""); return json(200, {}); }
      if (path === "/mcp") {
        const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!live.has(token)) return json(401, { error: "unauthorized" });
        const message = JSON.parse(body) as { id?: number; method: string };
        if (message.id === undefined) { response.writeHead(202); response.end(); return; }
        return json(200, { jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [{ name: "list_issues" }] } : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "svc", version: "1" } } });
      }
      json(404, {});
    });
  });
  return { server, seen, live, refresh: () => refresh };
}

let dir: string, repo: string, store: Store, svc: ReturnType<typeof provider>, base: string;
const runs = () => ({
  projectTools: (one: string) => store.projectTools(one), orgPolicy: () => store.orgPolicy(),
  getRun: () => ({ taskRef: 1 }), refById: () => ({ repo, externalId: "task" }), getScope: () => null, toolSealFor: () => null,
  recordRunTools: (_run: number, json: string) => { recorded.push(json); },
}) as unknown as Parameters<typeof prepareRunTools>[0];
let recorded: string[] = [];

async function connect(options: Parameters<typeof provider>[0] = {}, values: Record<string, string> = {}) {
  svc = provider(options);
  await new Promise<void>(done => svc.server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(svc.server.address() as AddressInfo).port}`;
  const spec: ToolSpec = { name: "linear", transport: "http", command: null, args: [], url: `${base}/mcp`, bearer: "OAUTH_ACCESS_TOKEN", headerSecrets: {}, about: "Issues.",
    secrets: ["OAUTH_ACCESS_TOKEN", "OAUTH_REFRESH_TOKEN", "OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "OAUTH_TOKEN_URL", "OAUTH_EXPIRES_AT", "OAUTH_RESOURCE"].map(name => ({ name, optional: name !== "OAUTH_ACCESS_TOKEN" })) };
  expect(addToolTo(store, repo, spec, "connected by signing in", "alex", T0, { home: dir })).toMatchObject({ ok: true });
  setToolSecrets(repo, "linear", { OAUTH_ACCESS_TOKEN: STORED_ACCESS, OAUTH_REFRESH_TOKEN: REFRESH_0, OAUTH_CLIENT_ID: "client-7", OAUTH_TOKEN_URL: `${base}/token`,
    OAUTH_REVOKE_URL: `${base}/revoke`, OAUTH_RESOURCE: `${base}/mcp`, OAUTH_GRANTED_SCOPE: "issues:read issues:write openid", ...values }, dir);
}

/** What Claude does with a launch's config: list the tool's actions through the broker. */
async function use(launch: ToolLaunchArgs): Promise<{ status: number; config: string; url: string; authorization: string }> {
  const config = readFileSync(launch.argv[launch.argv.indexOf("--mcp-config") + 1]!, "utf8");
  const server = (JSON.parse(config) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> }).mcpServers["linear"]!;
  const answer = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: server.headers.Authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  await answer.text();
  return { status: answer.status, config, url: server.url, authorization: server.headers.Authorization };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-run-token-")));
  repo = join(dir, "shop");
  store = openStore(join(dir, "orders.db"));
  recorded = [];
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
});
afterEach(async () => {
  store.close();
  await new Promise<void>(done => svc?.server.close(() => done()) ?? done());
  rmSync(dir, { recursive: true, force: true });
});

test("each run gets a fresh access token of its own, never the refresh token, revoked when the run ends; another run's key opens nothing", async () => {
  await connect();
  const first = await prepareRunTools(runs(), 1, "claude", { home: dir, now: T0 });
  const second = await prepareRunTools(runs(), 2, "claude", { home: dir, now: T0 });
  const [a, b] = [await use(first), await use(second)];
  expect([a.status, b.status]).toEqual([200, 200]);
  // The service saw each run's own token, never the stored one, and never a refresh token at its MCP address.
  const mcp = svc.seen.filter(one => one.path === "/mcp").map(one => one.authorization);
  expect(new Set(mcp)).toEqual(new Set(["Bearer run-access-1", "Bearer run-access-2"]));
  // One run's broker key is closed to the other's tools.
  const crossed = await fetch(b.url, { method: "POST", headers: { "content-type": "application/json", authorization: a.authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  expect(crossed.status).toBe(401);
  // Nothing the agent can read names a token of the service: not its config, not the run's record.
  for (const text of [a.config, b.config, ...recorded]) {
    for (const secret of [REFRESH_0, "refresh-rotated", STORED_ACCESS, "run-access-", "client-7"]) expect(text).not.toContain(secret);
  }
  // The newest rotated refresh token is the one kept; the stored access token is the person's own, unchanged.
  expect(readToolSecrets(repo, "linear", dir)).toMatchObject({ OAUTH_REFRESH_TOKEN: svc.refresh(), OAUTH_ACCESS_TOKEN: STORED_ACCESS });
  first.cleanup();
  await expect.poll(() => svc.seen.filter(one => one.path === "/revoke").map(one => one.form["token"])).toEqual(["run-access-1"]);
  expect(svc.seen.find(one => one.path === "/revoke")!.form).toMatchObject({ token_type_hint: "access_token", client_id: "client-7" });
  expect(svc.live.has("run-access-1")).toBe(false);
  // The second run still works until its own end.
  expect((await use(second)).status).toBe(200);
  second.cleanup();
  await expect.poll(() => svc.live.size).toBe(0);
  // The token requests never carried a scope for a build: the saved grant, never more.
  expect(svc.seen.filter(one => one.path === "/token").every(one => one.form["scope"] === undefined && one.form["grant_type"] === "refresh_token")).toBe(true);
});

test("concurrent launches renew one at a time, so a service that rotates its refresh token on every use signs every run in", async () => {
  await connect();
  const launches = await Promise.all([1, 2, 3, 4].map(id => prepareRunTools(runs(), id, "claude", { home: dir, now: T0 })));
  try {
    expect(recorded.map(one => (JSON.parse(one) as { skipped: unknown[] }).skipped)).toEqual([[], [], [], []]);
    const tokens = svc.seen.filter(one => one.path === "/token").map(one => one.form["refresh_token"]);
    expect(tokens).toEqual([REFRESH_0, "refresh-rotated-1", "refresh-rotated-2", "refresh-rotated-3"]);
    expect(readToolSecrets(repo, "linear", dir)["OAUTH_REFRESH_TOKEN"]).toBe("refresh-rotated-4");
    expect(new Set(svc.live)).toEqual(new Set(["run-access-1", "run-access-2", "run-access-3", "run-access-4"]));
  } finally {
    for (const one of launches) one.cleanup();
  }
  await expect.poll(() => svc.live.size).toBe(0);
});

test("a research step asks for its read scopes only; a service that won't narrow is asked for the saved grant, never more", async () => {
  expect(runScope(["issues:read", "issues:write", "openid"], true)).toEqual(["issues:read", "openid"]);
  expect(runScope(["issues:read", "issues:write"], false)).toBeNull();
  expect(runScope(null, true)).toBeNull();
  expect(runScope(["issues:read"], true)).toBeNull();
  await connect();
  const research = await prepareRunTools(runs(), 1, "claude", { home: dir, now: T0, readOnly: { linear: ["list_issues"] } });
  research.cleanup();
  expect(svc.seen.find(one => one.path === "/token")!.form["scope"]).toBe("issues:read openid");
  await new Promise<void>(done => svc.server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-run-token-")));
  store = openStore(join(dir, "orders.db"));
  await connect({ narrow: false });
  const wide = await prepareRunTools(runs(), 2, "claude", { home: dir, now: T0, readOnly: { linear: ["list_issues"] } });
  try {
    expect(svc.seen.filter(one => one.path === "/token").map(one => one.form["scope"])).toEqual(["issues:read openid", undefined]);
    expect((await use(wide)).status).toBe(200);
  } finally { wide.cleanup(); }
});

test("a sign-in that can't be renewed leaves the tool out, saying why in plain words, and never falls back to the stored token or repeats the service's answer", async () => {
  await connect({ fail: true });
  const launch = await prepareRunTools(runs(), 1, "claude", { home: dir, now: T0 });
  try {
    const config = readFileSync(launch.argv[launch.argv.indexOf("--mcp-config") + 1]!, "utf8");
    expect(JSON.parse(config)).toEqual({ mcpServers: {} });
    expect(JSON.parse(recorded[0]!)).toEqual({ provider: "claude", tools: [], skipped: [{ name: "linear", reason: "its sign-in ran out; connect it again on the Tools page" }] });
    expect(recorded[0]).not.toContain(REFRESH_0);
    expect(svc.seen.some(one => one.path === "/mcp")).toBe(false);
  } finally { launch.cleanup(); }
});

test("a sign-in that gave no refresh token stays in the broker as it is, like a key: no renewal, nothing revoked", async () => {
  await connect({}, { OAUTH_REFRESH_TOKEN: "" });
  svc.live.add(STORED_ACCESS);
  const launch = await prepareRunTools(runs(), 1, "claude", { home: dir, now: T0 });
  expect((await use(launch)).status).toBe(200);
  launch.cleanup();
  expect(svc.seen.filter(one => one.path !== "/mcp")).toEqual([]);
  expect(svc.seen.find(one => one.path === "/mcp")!.authorization).toBe(`Bearer ${STORED_ACCESS}`);
});

test("a Codex launch file holds only the broker's address and key, never the run's access token or the refresh token", async () => {
  await connect();
  const launch = await prepareRunTools(runs(), 1, "codex", { home: dir, now: T0 });
  try {
    const file = launch.argv.find(one => one.startsWith("mcp_servers.linear.args="))!;
    const relay = readFileSync((JSON.parse(file.slice("mcp_servers.linear.args=".length)) as string[])[1]!, "utf8");
    for (const secret of [REFRESH_0, "refresh-rotated", "run-access-", STORED_ACCESS]) {
      expect(relay).not.toContain(secret);
      expect(launch.argv.join(" ")).not.toContain(secret);
    }
  } finally { launch.cleanup(); }
  await expect.poll(() => svc.seen.filter(one => one.path === "/revoke")).toHaveLength(1);
});

test("through the gateway: a fresh build, a resumed repair whose provider crashes, and a stopped attempt each end with no live run token", async () => {
  repo = join(dir, "repo");
  const worktree = join(dir, "state", "worktrees", "repo", "task");
  for (const path of [repo, worktree]) mkdirSync(path, { recursive: true });
  store.close();
  store = openStore(join(dir, "state", "orders.db"));
  boundCheckout(store, repo, worktree);
  register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => "tok" });
  await connect();
  store.createTask({ id: "t-oauth", title: "t-oauth" }, T0);
  const ref = store.refFor("built-in", "t-oauth").id;
  store.placeTask(ref, repo);
  const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-oauth", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
  if (!took.ok) throw new Error("claim");
  const seen: { config: string; env: string; status: number }[] = [];
  const runner = (crash: boolean) => async (_file: string, args: readonly string[], options?: { env?: Record<string, string | undefined>; onSessionId?: (id: string) => void }) => {
    const config = readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8");
    const server = (JSON.parse(config) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> }).mcpServers["linear"]!;
    const answer = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: server.headers.Authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    await answer.text();
    seen.push({ config, env: JSON.stringify(options?.env ?? {}), status: answer.status });
    if (crash) throw new Error("the provider crashed");
    options?.onSessionId?.("session-1");
    return { code: 0, stderr: "", timedOut: false, notFound: false, stdout: `${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" })}\n${JSON.stringify({ type: "result", subtype: "success", session_id: "session-1", result: "done" })}\n` };
  };
  const startRun = () => store.startRun({ taskRef: ref, leaseId: "lease-oauth", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
  const invoke = (id: number, crash: boolean, resumeSession: string | null) => invokeAgent(store, id, { provider: "claude", model: null }, { phase: resumeSession === null ? "build" : "repair", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: true, resumeSession }, { keyHome: dir, clock: () => T0, cwd: worktree, runner: runner(crash) as never });

  const fresh = startRun();
  expect((await invoke(fresh, false, null)).kind).toBe("ran");
  store.finishRun(fresh, { outcome: "built", now: T0 });
  await expect.poll(() => svc.live.size).toBe(0);

  const resumed = startRun();
  store.stampRun(resumed, { sessionId: "session-1" });
  await invoke(resumed, true, "session-1").catch(() => undefined);
  await expect.poll(() => svc.live.size).toBe(0);

  const stopped = startRun();
  expect(store.requestRunStop({ runId: stopped, taskRef: ref, by: "alex", via: "cli" }, T0)).toMatchObject({ ok: true });
  await invoke(stopped, false, null).catch(() => undefined);
  await expect.poll(() => svc.live.size).toBe(0);

  expect(seen.map(one => one.status)).toEqual([200, 200]);
  const minted = svc.seen.filter(one => one.path === "/token").length;
  expect(svc.seen.filter(one => one.path === "/revoke")).toHaveLength(minted);
  for (const one of seen) for (const secret of [REFRESH_0, "refresh-rotated", "run-access-", STORED_ACCESS]) {
    expect(one.config).not.toContain(secret);
    expect(one.env).not.toContain(secret);
  }
});
