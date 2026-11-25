import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { mintApiToken } from "./api-tokens.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore } from "./store.js";

const REMOTE_WORKSPACE_HEADER = "x-toolroll-workspace";
const REMOTE_RECOVERY_HEADER = "x-toolroll-recovery";

const dirs: string[] = [];
const servers: http.Server[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>(resolve => s.close(() => resolve()));
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("unexpected address");
  return `http://127.0.0.1:${addr.port}`;
}

function rawRequest(
  origin: string,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { accept: "application/json", ...headers },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("multiplayer presence and approval pings", () => {
  test("GET /api/presence exposes scoped viewers, human owners, and hides unauthorized projects", async () => {
    const root = tempDir("so-presence-");
    const repoA = join(root, "alpha");
    const repoB = join(root, "secret-beta");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T12:00:00Z");

    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex");
    const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
    if (!sam.ok) throw new Error("sam");
    expect(store.setAccountProjects("alex", [repoA], "sam", now).ok).toBe(true);

    store.createTask({ id: "t-alpha", title: "Build login" }, now);
    const refA = store.refFor("built-in", "t-alpha", "ours").id;
    store.placeTask(refA, repoA);

    store.createTask({ id: "t-beta", title: "Secret roadmap" }, now);
    const refB = store.refFor("built-in", "t-beta", "ours").id;
    store.placeTask(refB, repoB);

    store.noteTaskAct(refA, "filed", now, undefined, { account: "alex", lead: false });
    store.noteTaskAct(refA, "asked", now, { person: "sam", why: "Please review" }, { account: "alex", lead: false });
    store.noteTaskAct(refB, "filed", now, undefined, { account: "sam", lead: false });

    const alexToken = mintApiToken();
    store.createApiToken({
      id: alexToken.id,
      account: "alex",
      name: "alex-remote",
      secretHash: alexToken.hash,
      access: "act",
      purpose: "api",
      by: "alex",
      projects: [repoA],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, now);
    const identity = store.workspaceIdentity();

    const server = createDecisionServer({
      store,
      configDir: root,
      repos: [repoA, repoB],
      evidenceRoot: join(root, "evidence"),
      clock: () => now,
      terminalHost: null,
    });
    const origin = await listen(server);

    const headers = {
      authorization: `Bearer ${alexToken.token}`,
      "x-toolroll-client": "terminal-remote",
      [REMOTE_WORKSPACE_HEADER]: identity.id,
      [REMOTE_RECOVERY_HEADER]: String(identity.recoveryGeneration),
    };

    // Unauthenticated call is refused.
    const unauth = await rawRequest(origin, "GET", "/api/presence", {});
    expect(unauth.status).toBe(401);

    // Browser header on remote bearer token is refused.
    const badBrowserHeader = await rawRequest(origin, "GET", "/api/presence", {
      ...headers,
      "sec-fetch-mode": "cors",
    });
    expect(badBrowserHeader.status).toBe(400);

    // Scoped remote presence sees alpha (owned by sam via ask handoff) and never leaks secret-beta.
    const res = await rawRequest(origin, "GET", "/api/presence", headers);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.me).toBe("alex");
    expect(res.json.accounts).toEqual(["alex", "sam"]);
    const owners = res.json.owners as Record<string, string | null>;
    expect(owners["t-alpha"]).toBe("sam");
    expect(owners["t-beta"]).toBeUndefined();
    expect(res.json.tasks).toEqual({});
  });

  test("POST /api/handoff/task/:task/approval-ping enqueues personal decision push and enforces approver/act/state gates", async () => {
    const root = tempDir("so-ping-");
    const repoA = join(root, "alpha");
    const repoB = join(root, "hidden");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T12:00:00Z");

    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex");
    const viewer = addApprover(store, "viewer", now, { name: "alex", token: alex.token });
    if (!viewer.ok) throw new Error("viewer");
    store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'viewer'").run();

    store.createTask({ id: "t-wait", title: "Ship remote TUI" }, now);
    const waitingRef = store.refFor("built-in", "t-wait", "ours").id;
    store.placeTask(waitingRef, repoA);
    store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(waitingRef);

    store.createTask({ id: "t-plain", title: "Just queued without scope" }, now);
    const plainRef = store.refFor("built-in", "t-plain", "ours").id;
    store.placeTask(plainRef, repoA);

    store.createTask({ id: "t-hidden", title: "Hidden work" }, now);
    const hiddenRef = store.refFor("built-in", "t-hidden", "ours").id;
    store.placeTask(hiddenRef, repoB);
    store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(hiddenRef);

    // Enroll a push subscription for alex so paired channels include web-push.
    store.handle.prepare(`
      INSERT INTO push_subscription (approver, approver_generation, endpoint, p256dh, auth, ua_words, vapid_fingerprint, starts_after_notification, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("alex", 1, "https://updates.push.services.mozilla.com/wpush/v2/test", "p256dh", "auth", "iPhone Safari", "fp1234", 0, now.toISOString());

    const actToken = mintApiToken();
    store.createApiToken({
      id: actToken.id,
      account: "alex",
      name: "alex-act",
      secretHash: actToken.hash,
      access: "act",
      purpose: "api",
      by: "alex",
      projects: [repoA],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, now);
    const readToken = mintApiToken();
    store.createApiToken({
      id: readToken.id,
      account: "alex",
      name: "alex-read",
      secretHash: readToken.hash,
      access: "read",
      purpose: "api",
      by: "alex",
      projects: [repoA],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, now);
    const viewerToken = mintApiToken();
    store.createApiToken({
      id: viewerToken.id,
      account: "viewer",
      name: "viewer-act",
      secretHash: viewerToken.hash,
      access: "act",
      purpose: "api",
      by: "alex",
      projects: [repoA],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, now);
    const identity = store.workspaceIdentity();

    const server = createDecisionServer({
      store,
      configDir: root,
      repos: [repoA, repoB],
      evidenceRoot: join(root, "evidence"),
      clock: () => now,
      terminalHost: null,
    });
    const origin = await listen(server);

    const baseHeaders = (tok: string) => ({
      authorization: `Bearer ${tok}`,
      "x-toolroll-client": "terminal-remote",
      [REMOTE_WORKSPACE_HEADER]: identity.id,
      [REMOTE_RECOVERY_HEADER]: String(identity.recoveryGeneration),
    });

    // 1. Read-only token is refused (403).
    const readRes = await rawRequest(origin, "POST", "/api/handoff/task/t-wait/approval-ping", baseHeaders(readToken.token));
    expect(readRes.status).toBe(403);

    // 2. Viewer account is refused (403).
    const viewerRes = await rawRequest(origin, "POST", "/api/handoff/task/t-wait/approval-ping", baseHeaders(viewerToken.token));
    expect(viewerRes.status).toBe(403);

    // 3. Hidden project returns 404 without leaking existence.
    const hiddenRes = await rawRequest(origin, "POST", "/api/handoff/task/t-hidden/approval-ping", baseHeaders(actToken.token));
    expect(hiddenRes.status).toBe(404);

    // 4. Task not waiting on approval returns 409.
    const plainRes = await rawRequest(origin, "POST", "/api/handoff/task/t-plain/approval-ping", baseHeaders(actToken.token));
    expect(plainRes.status).toBe(409);

    // 5. Approver act token on waiting task succeeds, enqueues personal decision push, and logs audit action.
    const okRes = await rawRequest(origin, "POST", "/api/handoff/task/t-wait/approval-ping", baseHeaders(actToken.token));
    expect(okRes.status).toBe(200);
    expect(okRes.json.ok).toBe(true);
    expect(okRes.json.taskId).toBe("t-wait");
    expect(okRes.json.enqueued).toBe(true);
    expect(okRes.json.channels).toEqual(["web-push"]);
    expect(okRes.json.path).toBe("/t/t-wait");

    const notifications = store.listNotifications("pending").filter(n => n.kind === "approval-ping");
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.recipient).toBe("alex");
    expect(notifications[0]?.pushClass).toBe("decision");
    expect(notifications[0]?.link).toBe(`/n/${waitingRef}`);
  });
});
