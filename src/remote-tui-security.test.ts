/**
 * Two-person adversarial security checks for remote TUI reads, live streams,
 * and pinned workspace/recovery isolation (aligned with PR #484 CW1/CW3 gates).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { mintApiToken } from "./api-tokens.js";
import { serviceOrigin } from "./connect-cli.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore } from "./store.js";

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

function rawGet(
  origin: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "application/json", ...headers },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: Record<string, unknown> | null = null;
        try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-json */ }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("remote TUI two-person adversarial security", () => {
  test("serviceOrigin enforces HTTPS for non-loopback hosts and rejects authority/path/query/fragment", () => {
    expect(serviceOrigin("https://central.example.com")).toBe("https://central.example.com");
    expect(serviceOrigin("http://127.0.0.1:4180")).toBe("http://127.0.0.1:4180");
    expect(serviceOrigin("http://localhost:4180")).toBe("http://localhost:4180");
    expect(() => serviceOrigin("http://central.example.com")).toThrow(/HTTPS/i);
    expect(() => serviceOrigin("http://100.64.0.1:4180")).toThrow(/HTTPS/i);
    expect(() => serviceOrigin("https://user:pass@central.example.com")).toThrow(/origin/i);
    expect(() => serviceOrigin("https://central.example.com/api")).toThrow(/origin/i);
    expect(() => serviceOrigin("https://central.example.com/?x=1")).toThrow(/origin/i);
  });

  test("GET /work/rows hides unauthorized projects and never leaks hidden counts or names in rollups", async () => {
    const root = tempDir("so-adv-work-");
    const repoA = join(root, "alpha");
    const repoB = join(root, "secret-beta");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T14:00:00Z");

    const alice = addApprover(store, "alice", now);
    if (!alice.ok) throw new Error("alice");
    const bob = addApprover(store, "bob", now, { name: "alice", token: alice.token });
    if (!bob.ok) throw new Error("bob");
    expect(store.setAccountProjects("alice", [repoA], "bob", now).ok).toBe(true);

    // One waiting task in alpha, two waiting tasks in secret-beta.
    store.createTask({ id: "t-alpha", title: "Visible alpha task" }, now);
    const refA = store.refFor("built-in", "t-alpha", "ours").id;
    store.placeTask(refA, repoA);
    store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(refA);

    for (const id of ["t-secret-1", "t-secret-2"]) {
      store.createTask({ id, title: `Classified ${id}` }, now);
      const ref = store.refFor("built-in", id, "ours").id;
      store.placeTask(ref, repoB);
      store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(ref);
    }

    const aliceToken = mintApiToken();
    store.createApiToken({
      id: aliceToken.id,
      account: "alice",
      name: "alice-read",
      secretHash: aliceToken.hash,
      access: "read",
      purpose: "api",
      by: "alice",
      projects: [repoA],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, now);
    const bobToken = mintApiToken();
    store.createApiToken({
      id: bobToken.id,
      account: "bob",
      name: "bob-read",
      secretHash: bobToken.hash,
      access: "read",
      purpose: "api",
      by: "bob",
      projects: null,
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

    const headersFor = (tok: string) => ({
      authorization: `Bearer ${tok}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration,
    });

    const aliceWork = await rawGet(origin, "/work/rows", headersFor(aliceToken.token));
    expect(aliceWork.status).toBe(200);
    expect(aliceWork.text).not.toContain("secret-beta");
    expect(aliceWork.text).not.toContain("t-secret-1");
    expect(aliceWork.text).not.toContain("Classified");
    const aliceRows = (aliceWork.json?.rows as Array<{ id: string }>) ?? [];
    expect(aliceRows.map(r => r.id)).toEqual(["t-alpha"]);
    expect(aliceWork.json?.spend).toBeNull();

    // Bob sees all three tasks; Alice's needsCount must stay strictly <= Bob's and never count secret-beta's 2 tasks.
    const bobWork = await rawGet(origin, "/work/rows", headersFor(bobToken.token));
    expect(bobWork.status).toBe(200);
    const bobRows = (bobWork.json?.rows as Array<{ id: string }>) ?? [];
    expect(bobRows.map(r => r.id).sort()).toEqual(["t-alpha", "t-secret-1", "t-secret-2"]);
    expect(Number(aliceWork.json?.needsCount ?? 0)).toBeLessThanOrEqual(1);
    expect(Number(bobWork.json?.needsCount ?? 0)).toBeGreaterThanOrEqual(Number(aliceWork.json?.needsCount ?? 0));
  });

  test("GET /live SSE revokes mid-stream on token revocation and recovery_generation rotation blocks stale pins", async () => {
    const root = tempDir("so-adv-live-");
    const repoA = join(root, "alpha");
    const repoB = join(root, "secret-beta");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T14:00:00Z");

    const alice = addApprover(store, "alice", now);
    if (!alice.ok) throw new Error("alice");
    const bob = addApprover(store, "bob", now, { name: "alice", token: alice.token });
    if (!bob.ok) throw new Error("bob");
    expect(store.setAccountProjects("alice", [repoA], "bob", now).ok).toBe(true);

    store.createTask({ id: "t-alpha", title: "Live alpha" }, now);
    const refA = store.refFor("built-in", "t-alpha", "ours").id;
    store.placeTask(refA, repoA);

    store.createTask({ id: "t-beta", title: "Hidden beta" }, now);
    const refB = store.refFor("built-in", "t-beta", "ours").id;
    store.placeTask(refB, repoB);

    // Seed one run in alpha and one run in secret-beta for /agents/live/run/:run isolation.
    const nowIso = now.toISOString();
    store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, started_at, role, phase, branch, worktree) VALUES (?, 'lease-a', 'worker-1', ?, 'builder', 'build', 'tr/a', ?)").run(refA, nowIso, repoA);
    const runA = Number((store.handle.prepare("SELECT last_insert_rowid() AS id").get() as Record<string, unknown>)["id"]);
    store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, started_at, role, phase, branch, worktree) VALUES (?, 'lease-b', 'worker-1', ?, 'builder', 'build', 'tr/b', ?)").run(refB, nowIso, repoB);
    const runB = Number((store.handle.prepare("SELECT last_insert_rowid() AS id").get() as Record<string, unknown>)["id"]);

    const aliceToken = mintApiToken();
    store.createApiToken({
      id: aliceToken.id,
      account: "alice",
      name: "alice-live",
      secretHash: aliceToken.hash,
      access: "read",
      purpose: "api",
      by: "alice",
      projects: [repoA],
      expiresAt: new Date("2027-01-01T00:00:00Z").toISOString(),
    }, now);
    const bobToken = mintApiToken();
    store.createApiToken({
      id: bobToken.id,
      account: "bob",
      name: "bob-live",
      secretHash: bobToken.hash,
      access: "read",
      purpose: "api",
      by: "bob",
      projects: null,
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

    const aliceHeaders = {
      authorization: `Bearer ${aliceToken.token}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration,
    };

    // 1. /agents/live/run/:run hides secret-beta's run (404, same as unknown run) while allowing alpha's run.
    const hiddenRun = await rawGet(origin, `/agents/live/run/${runB}`, aliceHeaders);
    const unknownRun = await rawGet(origin, `/agents/live/run/999999`, aliceHeaders);
    expect(hiddenRun.status).toBe(404);
    expect(unknownRun.status).toBe(404);
    const visibleRun = await rawGet(origin, `/agents/live/run/${runA}`, aliceHeaders);
    expect(visibleRun.status).toBe(200);

    // 2. Open /live?room=task:t-alpha SSE stream, revoke alice's token mid-stream, trigger a write, verify `gone` + close!
    const sseResult = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL("/live?room=task:t-alpha", origin);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "text/event-stream", ...aliceHeaders },
      }, res => {
        let body = "";
        let revoked = false;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (!revoked && body.includes("event: change")) {
            revoked = true;
            // Revoke Alice's token mid-stream and mutate the task so the live bus fires immediately.
            store.revokeApiToken(aliceToken.id, "bob", now);
            store.handle.prepare("UPDATE task SET updated_at = ? WHERE id = 't-alpha'").run("2026-11-20T14:01:00Z");
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(sseResult.status).toBe(200);
    expect(sseResult.body).toContain("event: change");
    expect(sseResult.body).toContain("event: gone");

    // 3. After revocation, /agents/live/run/:run immediately returns 401.
    const afterRevoke = await rawGet(origin, `/agents/live/run/${runA}`, aliceHeaders);
    expect(afterRevoke.status).toBe(401);

    // 4. Rotating recovery_generation immediately rejects stale pins with 409 recovery-changed across all remote reads.
    const rotated = "1".repeat(32);
    store.handle.prepare("UPDATE workspace_identity SET recovery_generation = ? WHERE singleton = 1").run(rotated);
    const staleBobHeaders = {
      authorization: `Bearer ${bobToken.token}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration, // old generation!
    };
    const staleWork = await rawGet(origin, "/work/rows", staleBobHeaders);
    const staleSteps = await rawGet(origin, "/t/t-alpha/steps", staleBobHeaders);
    const stalePresence = await rawGet(origin, "/api/presence", staleBobHeaders);
    const staleHandoff = await rawGet(origin, "/api/handoff/task/t-alpha", staleBobHeaders);
    expect(staleWork.status).toBe(409);
    expect(staleSteps.status).toBe(409);
    expect(stalePresence.status).toBe(409);
    expect(staleHandoff.status).toBe(409);
  });
});
