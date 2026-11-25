import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fakePid } from "../test/fake-pid.js";
import { mintApiToken } from "./api-tokens.js";
import { TerminalHost, type Pty, type PtySpawn } from "./live-terminal.js";
import { runFollowUpCheck } from "./result-follow-ups.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore } from "./store.js";
import { taskFingerprint } from "./task-live.js";

const dirs: string[] = [];
const servers: http.Server[] = [];
const hosts: TerminalHost[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function makeFakePtySpawn(): PtySpawn {
  let offset = 0;
  return () => {
    const pid = fakePid(offset++);
    const exitListeners: Array<(exit: { exitCode: number; signal?: number }) => void> = [];
    let exited = false;
    const pty: Pty = {
      pid,
      tty: null,
      pendingInput: () => 0,
      onData: () => undefined,
      onExit: fn => { exitListeners.push(fn); },
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        if (exited) return;
        exited = true;
        for (const fn of exitListeners) fn({ exitCode: 0 });
      },
    };
    return pty;
  };
}

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.stop();
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

describe("2-developer end-to-end multiplayer workflow", () => {
  test("pull -> candidate push -> SSE wake -> promote -> central check pass -> re-pull -> handoff -> remote live terminal start & reuse", async () => {
    const root = tempDir("so-mp-dogfood-");
    const repo = join(root, "app");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "app.txt"), "v1\n");
    execFileSync("git", ["-C", repo, "add", "app.txt"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    const initialHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const store = openStore(join(root, "state.db"));
    const now = new Date("2026-11-20T18:00:00Z");
    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex");
    const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
    if (!sam.ok) throw new Error("sam");

    store.setVerifyCommand({ repo, command: "grep -q '^v2$' app.txt", timeoutMs: 30_000, approvedBy: "alex" }, now);
    store.createTask({ id: "t-dogfood", title: "Ship multiplayer v1" }, now);
    const ref = store.refFor("built-in", "t-dogfood", "ours").id;
    store.placeTask(ref, repo);

    const alexAct = mintApiToken();
    store.createApiToken({ id: alexAct.id, account: "alex", name: "alex-act", secretHash: alexAct.hash, access: "act", purpose: "api", by: "alex", projects: [repo], expiresAt: "2027-01-01T00:00:00Z" }, now);
    const samAct = mintApiToken();
    store.createApiToken({ id: samAct.id, account: "sam", name: "sam-act", secretHash: samAct.hash, access: "act", purpose: "api", by: "sam", projects: [repo], expiresAt: "2027-01-01T00:00:00Z" }, now);
    const samRead = mintApiToken();
    store.createApiToken({ id: samRead.id, account: "sam", name: "sam-read", secretHash: samRead.hash, access: "read", purpose: "api", by: "sam", projects: [repo], expiresAt: "2027-01-01T00:00:00Z" }, now);

    const identity = store.workspaceIdentity();
    const evidenceRoot = join(root, "evidence");
    const host = new TerminalHost({
      spawn: makeFakePtySpawn(),
      worktreeRoot: join(root, "live-worktrees"),
      closeGraceMs: 50,
      processes: () => [],
      programs: { shell: { file: "/bin/sh", args: [] } },
      env: () => ({ PATH: process.env["PATH"] ?? "", HOME: root }),
    });
    hosts.push(host);

    const server = createDecisionServer({ store, configDir: root, evidenceRoot, repos: [repo], clock: () => now, terminalHost: host });
    const origin = await listen(server);
    const headers = (tok: string) => ({
      authorization: `Bearer ${tok}`,
      "x-toolroll-client": "terminal-remote",
      "x-toolroll-workspace": identity.id,
      "x-toolroll-recovery": identity.recoveryGeneration,
    });

    // 1. Dev A (alex) pulls Local Checkout and uploads a Candidate -> SSE taskFingerprint moves immediately.
    const fpBefore = taskFingerprint(store, "t-dogfood", now);
    const pull1 = await rawReq(origin, "GET", "/api/handoff/task/t-dogfood", headers(alexAct.token));
    expect(pull1.status).toBe(200);
    expect(pull1.json.baseCommit).toBe(initialHead);

    const patch = "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-v1\n+v2\n";
    const push = await rawReq(origin, "POST", "/api/handoff/task/t-dogfood/candidate", headers(alexAct.token), {
      patch,
      baseCommit: initialHead,
      note: "updated to v2",
    });
    expect(push.status).toBe(201);
    const candidateId = String(push.json.candidateId);
    const fpAfterUpload = taskFingerprint(store, "t-dogfood", now);
    expect(fpAfterUpload).not.toBe(fpBefore);

    // 2. Dev B (sam) promotes Candidate -> central Run created + check queued -> liveCheckState transitions waiting -> passed.
    const promote = await rawReq(origin, "POST", `/api/handoff/task/t-dogfood/candidate/${candidateId}/promote`, headers(samAct.token), {});
    expect(promote.status).toBe(200);
    const headCommit = String(promote.json.headCommit);
    const checks = promote.json.checks as { status: string; requestId: number };
    expect(checks.status).toBe("queued");

    const waitingList = await rawReq(origin, "GET", "/api/handoff/task/t-dogfood/candidates", headers(samRead.token));
    expect(waitingList.status).toBe(200);
    expect((waitingList.json.candidates as Array<Record<string, unknown>>)[0]?.liveCheckState).toBe("waiting");

    const fpBeforeCheck = taskFingerprint(store, "t-dogfood", now);
    const checked = await runFollowUpCheck(store, evidenceRoot, checks.requestId, { now: () => now });
    expect(checked?.state).toBe("passed");
    expect(taskFingerprint(store, "t-dogfood", now)).not.toBe(fpBeforeCheck);

    const passedList = await rawReq(origin, "GET", "/api/handoff/task/t-dogfood/candidates", headers(samRead.token));
    expect((passedList.json.candidates as Array<Record<string, unknown>>)[0]?.liveCheckState).toBe("passed");

    // 3. Re-pulling Local Checkout now resolves baseCommit to the promoted central headCommit.
    const pull2 = await rawReq(origin, "GET", "/api/handoff/task/t-dogfood", headers(alexAct.token));
    expect(pull2.status).toBe(200);
    expect(pull2.json.baseCommit).toBe(headCommit);

    // 4. Dev A hands task off to Dev B -> SSE fingerprint moves, presence owner updates.
    const fpBeforeHandoff = taskFingerprint(store, "t-dogfood", now);
    const handoff = await rawReq(origin, "POST", "/api/handoff/task/t-dogfood/assign-person", headers(alexAct.token), {
      person: "sam",
      why: "Ready for terminal smoke test",
    });
    expect(handoff.status).toBe(200);
    expect(taskFingerprint(store, "t-dogfood", now)).not.toBe(fpBeforeHandoff);
    const presence = await rawReq(origin, "GET", "/api/presence", headers(samRead.token));
    expect((presence.json.owners as Record<string, string>)["t-dogfood"]).toBe("sam");

    // 5. Dev B starts a central Live Terminal directly from remote TUI (read-only refused 403; second call reuses).
    const readRefused = await rawReq(origin, "POST", "/api/handoff/task/t-dogfood/terminal", headers(samRead.token), { program: "shell" });
    expect(readRefused.status).toBe(403);

    const started = await rawReq(origin, "POST", "/api/handoff/task/t-dogfood/terminal", headers(samAct.token), { program: "shell" });
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ ok: true, program: "shell", reused: false });
    const termId = String(started.json.id);
    expect(termId).toMatch(/^[a-f0-9]{32}$/);

    // Dev A lists remote terminals and sees Dev B's Live Terminal on t-dogfood ready to attach/observe.
    const terms = await rawReq(origin, "GET", "/api/handoff/terminals", headers(alexAct.token));
    expect(terms.status).toBe(200);
    expect(terms.json.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: termId, task: "t-dogfood", program: "shell", endedAt: null }),
    ]));

    // Calling start again reuses the existing Live Terminal rather than spawning a duplicate.
    const reused = await rawReq(origin, "POST", "/api/handoff/task/t-dogfood/terminal", headers(alexAct.token), { program: "shell" });
    expect(reused.status).toBe(200);
    expect(reused.json).toMatchObject({ ok: true, id: termId, reused: true });
  });
});
