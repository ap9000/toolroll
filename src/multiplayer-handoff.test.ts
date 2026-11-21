import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { mintApiToken } from "./api-tokens.js";
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

function rawReq(
  origin: string,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        accept: "application/json",
        ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(serialized)) }),
        ...headers,
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      });
    });
    req.on("error", reject);
    if (serialized !== undefined) req.write(serialized);
    req.end();
  });
}

describe("human task handoff and local candidate promotion", () => {
  test("POST /api/handoff/task/:task/assign-person hands task to a project-authorized teammate and enforces auth gates", async () => {
    const root = tempDir("so-handoff-person-");
    const repoA = join(root, "alpha");
    const repoB = join(root, "beta");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T15:00:00Z");

    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex");
    const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
    if (!sam.ok) throw new Error("sam");
    const pat = addApprover(store, "pat", now, { name: "alex", token: alex.token });
    if (!pat.ok) throw new Error("pat");
    store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = ?").run("pat");
    const outsider = addApprover(store, "outsider", now, { name: "alex", token: alex.token });
    if (!outsider.ok) throw new Error("outsider");
    expect(store.setAccountProjects("outsider", [repoB], "alex", now).ok).toBe(true);

    store.createTask({ id: "t-collab", title: "Review auth migration" }, now);
    const refA = store.refFor("built-in", "t-collab", "ours").id;
    store.placeTask(refA, repoA);

    const actTok = mintApiToken();
    store.createApiToken({ id: actTok.id, account: "alex", name: "act", secretHash: actTok.hash, access: "act", purpose: "api", by: "alex", projects: [repoA], expiresAt: "2027-01-01T00:00:00Z" }, now);
    const readTok = mintApiToken();
    store.createApiToken({ id: readTok.id, account: "alex", name: "read", secretHash: readTok.hash, access: "read", purpose: "api", by: "alex", projects: [repoA], expiresAt: "2027-01-01T00:00:00Z" }, now);
    const identity = store.workspaceIdentity();

    const server = createDecisionServer({ store, configDir: root, evidenceRoot: join(root, "evidence"), repos: [repoA, repoB], clock: () => now, terminalHost: null });
    const origin = await listen(server);

    const headers = (tok: string) => ({
      authorization: `Bearer ${tok}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration,
    });

    // Read-only token refused (403).
    expect((await rawReq(origin, "POST", "/api/handoff/task/t-collab/assign-person", headers(readTok.token), { person: "sam" })).status).toBe(403);
    // Teammate without project access refused (400).
    expect((await rawReq(origin, "POST", "/api/handoff/task/t-collab/assign-person", headers(actTok.token), { person: "outsider" })).status).toBe(400);

    // Authorized handoff to sam succeeds, updates presence owner, and enqueues personal task-ask notification.
    const ok = await rawReq(origin, "POST", "/api/handoff/task/t-collab/assign-person", headers(actTok.token), { person: "sam", why: "Can you sanity check?" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, taskId: "t-collab", person: "sam", why: "Can you sanity check?" });
    expect(ok.json.warning).toBeUndefined();

    // Handing an unapproved task to a project-authorized Viewer succeeds as a coordination signal with a clear warning.
    const toViewer = await rawReq(origin, "POST", "/api/handoff/task/t-collab/assign-person", headers(actTok.token), { person: "pat", why: "Take a look" });
    expect(toViewer.status).toBe(200);
    expect(toViewer.json).toMatchObject({ ok: true, taskId: "t-collab", person: "pat" });
    expect(String(toViewer.json.warning ?? "")).toContain("Viewer");
    expect(String(toViewer.json.warning ?? "")).toContain("cannot approve");

    // Re-hand back to sam so presence check verifies latest owner cleanly.
    expect((await rawReq(origin, "POST", "/api/handoff/task/t-collab/assign-person", headers(actTok.token), { person: "sam", why: "Back to you" })).status).toBe(200);

    const presence = await rawReq(origin, "GET", "/api/presence", headers(actTok.token));
    expect((presence.json.owners as Record<string, string>)["t-collab"]).toBe("sam");
    const asks = store.listNotifications("pending").filter(n => n.kind === "task-ask" && n.recipient === "sam");
    expect(asks.length).toBeGreaterThanOrEqual(1);
  });

  test("local candidates are listed, promoted with SHA-256 verification, and refused on digest tampering", async () => {
    const root = tempDir("so-handoff-promote-");
    const repo = join(root, "app");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "hello.txt"), "before\n");
    execFileSync("git", ["-C", repo, "add", "hello.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    const baseCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T15:00:00Z");
    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex");

    store.createTask({ id: "t-cand", title: "Polish greeting" }, now);
    const ref = store.refFor("built-in", "t-cand", "ours").id;
    store.placeTask(ref, repo);

    const actTok = mintApiToken();
    store.createApiToken({ id: actTok.id, account: "alex", name: "act", secretHash: actTok.hash, access: "act", purpose: "api", by: "alex", projects: [repo], expiresAt: "2027-01-01T00:00:00Z" }, now);
    const readTok = mintApiToken();
    store.createApiToken({ id: readTok.id, account: "alex", name: "read", secretHash: readTok.hash, access: "read", purpose: "api", by: "alex", projects: [repo], expiresAt: "2027-01-01T00:00:00Z" }, now);
    const identity = store.workspaceIdentity();
    const evidenceRoot = join(root, "evidence");

    const server = createDecisionServer({ store, configDir: root, evidenceRoot, repos: [repo], clock: () => now, terminalHost: null });
    const origin = await listen(server);
    const headers = (tok: string) => ({
      authorization: `Bearer ${tok}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration,
    });

    const patch = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n";
    const uploaded = await rawReq(origin, "POST", "/api/handoff/task/t-cand/candidate", headers(actTok.token), { patch, baseCommit, note: "tweaked locally" });
    expect(uploaded.status).toBe(201);
    const candidateId = String(uploaded.json.candidateId);

    const listed = await rawReq(origin, "GET", "/api/handoff/task/t-cand/candidates", headers(readTok.token));
    expect(listed.status).toBe(200);
    expect(listed.json.candidates).toEqual([
      expect.objectContaining({ id: candidateId, author: "alex", trust: "unverified", promotedAt: null, stale: false }),
    ]);

    // Read-only token refused on promote (403).
    expect((await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId}/promote`, headers(readTok.token), {})).status).toBe(403);

    // Act approver promotes cleanly while base commit matches.
    const promoted = await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId}/promote`, headers(actTok.token), {});
    expect(promoted.status).toBe(200);
    expect(promoted.json).toMatchObject({ ok: true, taskId: "t-cand", candidateId, promotedBy: "alex" });

    // Moving the central repo head refuses promotion with 409 stale_candidate (no silent auto-merge).
    writeFileSync(join(repo, "other.txt"), "advanced\n");
    execFileSync("git", ["-C", repo, "add", "other.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "advance head"]);
    const advancedHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const stalePromote = await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId}/promote`, headers(actTok.token), {});
    expect(stalePromote.status).toBe(409);
    expect(stalePromote.json.error).toBe("stale_candidate");

    // Once a central run records the advanced head in SQLite, GET .../candidates flags stale: true purely from DB (never spawning git on GET).
    store.handle.prepare(`
      INSERT INTO run (task_ref, runner, lease_id, role, started_at, finished_at, outcome, committed, base_revision, head_revision, branch, worktree)
      VALUES (?, 'builder-1', 'lease-adv', 'builder', ?, ?, 'built', 1, ?, ?, 'toolroll/t-cand', ?)
    `).run(ref, now.toISOString(), now.toISOString(), baseCommit, advancedHead, repo);
    const staleList = await rawReq(origin, "GET", "/api/handoff/task/t-cand/candidates", headers(readTok.token));
    expect(staleList.status).toBe(200);
    expect((staleList.json.candidates as Array<{ stale: boolean }>)[0]?.stale).toBe(true);

    // Tampering with the saved patch file causes 409 digest_mismatch.
    writeFileSync(join(evidenceRoot, "handoff-candidates", "t-cand", `${candidateId}.patch`), `${patch}\n# tampered\n`);
    const tampered = await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId}/promote`, headers(actTok.token), {});
    expect(tampered.status).toBe(409);
    expect(tampered.json.error).toBe("digest_mismatch");
  });
});
