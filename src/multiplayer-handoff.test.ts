import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { mintApiToken } from "./api-tokens.js";
import { runFollowUpCheck } from "./result-follow-ups.js";
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
    const patch2 = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+concurrent\n";
    const uploaded = await rawReq(origin, "POST", "/api/handoff/task/t-cand/candidate", headers(actTok.token), { patch, baseCommit, note: "tweaked locally" });
    expect(uploaded.status).toBe(201);
    const candidateId = String(uploaded.json.candidateId);

    // A second concurrent Local Checkout candidate built on the same baseCommit before promotion.
    const uploaded2 = await rawReq(origin, "POST", "/api/handoff/task/t-cand/candidate", headers(actTok.token), { patch: patch2, baseCommit, note: "concurrent edit" });
    expect(uploaded2.status).toBe(201);
    const candidateId2 = String(uploaded2.json.candidateId);

    const listed = await rawReq(origin, "GET", "/api/handoff/task/t-cand/candidates", headers(readTok.token));
    expect(listed.status).toBe(200);
    expect(listed.json.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: candidateId, author: "alex", trust: "unverified", promotedAt: null, stale: false }),
      expect.objectContaining({ id: candidateId2, author: "alex", trust: "unverified", promotedAt: null, stale: false }),
    ]));

    // Read-only token refused on promote (403).
    expect((await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId}/promote`, headers(readTok.token), {})).status).toBe(403);

    // Act approver promotes cleanly: materializes real Git branch/commit, Run row with not-run check, and sealed diff artifact.
    const promoted = await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId}/promote`, headers(actTok.token), {});
    expect(promoted.status).toBe(200);
    expect(promoted.json).toMatchObject({
      ok: true,
      taskId: "t-cand",
      candidateId,
      promotedBy: "alex",
      branch: `toolroll/candidate/${candidateId}`,
    });
    const runId = Number(promoted.json.runId);
    const headCommit = String(promoted.json.headCommit);
    expect(runId).toBeGreaterThan(0);
    expect(headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(headCommit).not.toBe(baseCommit);
    expect(execFileSync("git", ["-C", repo, "show", `${headCommit}:hello.txt`], { encoding: "utf8" })).toBe("after\n");
    // Materialized run starts with check status 'not-run' (never forged as passed) and stores a sealed diff artifact.
    expect(store.getRun(runId)?.headRevision).toBe(headCommit);
    expect(store.runCheckFor(runId)?.status).toBe("not-run");
    expect(store.artifactsFor(runId).some(a => a.kind === "diff")).toBe(true);
    // Default branch 'main' was untouched.
    expect(execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(baseCommit);

    // Because candidate 1's promotion advanced the task head in SQLite, concurrent candidate 2 is now stale on GET (purely from DB) and refused with 409 stale_candidate on POST.
    const staleList = await rawReq(origin, "GET", "/api/handoff/task/t-cand/candidates", headers(readTok.token));
    expect(staleList.status).toBe(200);
    const listedById = new Map((staleList.json.candidates as Array<{ id: string; stale: boolean; runId?: number }>).map(c => [c.id, c]));
    expect(listedById.get(candidateId)?.stale).toBe(false);
    expect(listedById.get(candidateId)?.runId).toBe(runId);
    expect(listedById.get(candidateId2)?.stale).toBe(true);
    const stalePromote = await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId2}/promote`, headers(actTok.token), {});
    expect(stalePromote.status).toBe(409);
    expect(stalePromote.json.error).toBe("stale_candidate");

    // Tampering with the saved patch file causes 409 digest_mismatch.
    writeFileSync(join(evidenceRoot, "handoff-candidates", "t-cand", `${candidateId}.patch`), `${patch}\n# tampered\n`);
    const tampered = await rawReq(origin, "POST", `/api/handoff/task/t-cand/candidate/${candidateId}/promote`, headers(actTok.token), {});
    expect(tampered.status).toBe(409);
    expect(tampered.json.error).toBe("digest_mismatch");
  });

  test("promoting a candidate queues central verification when the project has an approved check command", async () => {
    const root = tempDir("so-handoff-check-");
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

    // Configure an approved full verification command that asserts the promoted commit's content.
    store.setVerifyCommand({ repo, command: "grep -q '^after$' hello.txt", timeoutMs: 30_000, approvedBy: "alex" }, now);

    store.createTask({ id: "t-check", title: "Verify promoted candidate" }, now);
    const ref = store.refFor("built-in", "t-check", "ours").id;
    store.placeTask(ref, repo);

    const actTok = mintApiToken();
    store.createApiToken({ id: actTok.id, account: "alex", name: "act", secretHash: actTok.hash, access: "act", purpose: "api", by: "alex", projects: [repo], expiresAt: "2027-01-01T00:00:00Z" }, now);
    const identity = store.workspaceIdentity();
    const evidenceRoot = join(root, "evidence");

    const server = createDecisionServer({ store, configDir: root, evidenceRoot, repos: [repo], clock: () => now, terminalHost: null });
    const origin = await listen(server);
    const headers = {
      authorization: `Bearer ${actTok.token}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration,
    };

    const patch = "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n";
    const uploaded = await rawReq(origin, "POST", "/api/handoff/task/t-check/candidate", headers, { patch, baseCommit, note: "ready for central check" });
    expect(uploaded.status).toBe(201);
    const candidateId = String(uploaded.json.candidateId);

    const promoted = await rawReq(origin, "POST", `/api/handoff/task/t-check/candidate/${candidateId}/promote`, headers, {});
    expect(promoted.status).toBe(200);
    const checks = promoted.json.checks as { status: string; level?: string; requestId?: number };
    expect(checks).toMatchObject({ status: "queued", level: "full" });
    expect(typeof checks.requestId).toBe("number");
    const headCommit = String(promoted.json.headCommit);

    // Executing the queued central verification checks out headCommit and passes against the materialized file.
    const checked = await runFollowUpCheck(store, evidenceRoot, checks.requestId!, { now: () => now });
    expect(checked).not.toBeNull();
    expect(checked?.state).toBe("passed");
    if (checked && checked.state === "passed") {
      expect(checked.head).toBe(headCommit);
    }
  });
});
