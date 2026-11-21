import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { createDecisionServer } from "./serve.js";
import { validateHandoffPatch } from "./local-handoff.js";
import { maybeRunConnectCommand } from "./connect-cli.js";
import { maybeRunHandoffCommand } from "./handoff-cli.js";

let store: Store;
let dir: string;
let server: Server | undefined;
const now = () => new Date();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  }).trim();
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-handoff-")));
  store = openStore(join(dir, "orders.db"));
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((done, fail) => server!.close(err => err ? fail(err) : done()));
    server = undefined;
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("validateHandoffPatch rejects traversal, .git, symlinks, absolute paths, and secrets", () => {
  expect(validateHandoffPatch("").ok).toBe(false);
  expect(validateHandoffPatch("diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n+x\n").ok).toBe(false);
  expect(validateHandoffPatch("diff --git a/../escape.ts b/../escape.ts\n--- a/../escape.ts\n+++ b/../escape.ts\n@@ -1 +1 @@\n+x\n").ok).toBe(false);
  expect(validateHandoffPatch("diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n").ok).toBe(false);
  expect(validateHandoffPatch("diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n+const k = 'ghp_123456789012345678901234567890123456';\n").ok).toBe(false);
  const ok = validateHandoffPatch("diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-old\n+new\n");
  expect(ok).toEqual({ ok: true, files: ["hello.txt"] });
});

test("end-to-end handoff pull creates an isolated worktree without touching a dirty checkout, and push uploads an unverified candidate", async () => {
  const centralRepo = join(dir, "central-repo");
  mkdirSync(centralRepo, { recursive: true });
  git(centralRepo, ["init", "-b", "main"]);
  writeFileSync(join(centralRepo, "hello.txt"), "hello world\n");
  git(centralRepo, ["add", "hello.txt"]);
  git(centralRepo, ["commit", "-m", "initial"]);

  // Local developer clone with an uncommitted dirty file that must NEVER be touched.
  const localRepo = join(dir, "local-repo");
  git(dir, ["clone", centralRepo, localRepo]);
  writeFileSync(join(localRepo, "hello.txt"), "my dirty local wip\n");

  const alice = addApprover(store, "alice", now());
  if (!alice.ok) throw new Error("alice");
  const actToken = mintApiToken();
  store.createApiToken({ id: actToken.id, account: "alice", name: "act", secretHash: actToken.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alice", projects: [centralRepo], purpose: "api" }, now());
  const readToken = mintApiToken();
  store.createApiToken({ id: readToken.id, account: "alice", name: "read", secretHash: readToken.hash, access: "read", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alice", projects: [centralRepo], purpose: "api" }, now());

  store.createTask({ id: "t-handoff", title: "Improve greeting" }, now());
  const taskRef = store.refFor("built-in", "t-handoff", "ours").id;
  store.placeTask(taskRef, centralRepo);

  const evidenceRoot = join(dir, "evidence");
  server = createDecisionServer({ store, configDir: dir, evidenceRoot, repos: [centralRepo] });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("addr");
  const origin = `http://127.0.0.1:${addr.port}`;

  const profileFile = join(dir, "remote", "profiles.json");
  expect(await maybeRunConnectCommand(
    ["connect", origin, "--as", "alice", "--token-stdin"],
    () => {},
    { profileFile, readStdin: async () => actToken.token, stderr: () => {} },
  )).toBe(0);

  // Pull into isolated local worktree.
  const pullLines: string[] = [];
  expect(await maybeRunHandoffCommand(
    ["handoff", "pull", "t-handoff", "--repo", localRepo],
    line => pullLines.push(line),
    { profileFile },
  )).toBe(0);

  // Main checkout is still untouched & dirty!
  expect(readFileSync(join(localRepo, "hello.txt"), "utf8")).toBe("my dirty local wip\n");

  // Locate the created isolated worktree and edit cleanly there.
  const cdLine = pullLines.find(l => l.trim().startsWith("cd "))!;
  const worktree = cdLine.trim().slice(3);
  expect(existsSync(worktree)).toBe(true);
  expect(readFileSync(join(worktree, "hello.txt"), "utf8")).toBe("hello world\n");
  writeFileSync(join(worktree, "hello.txt"), "hello central workspace\n");

  // Push candidate back to central task.
  const pushLines: string[] = [];
  expect(await maybeRunHandoffCommand(
    ["handoff", "push", "--note", "Updated greeting locally"],
    line => pushLines.push(line),
    { profileFile, cwd: worktree },
  )).toBe(0);
  expect(pushLines.join("\n")).toContain("unverified");

  // Verify central server persisted the candidate patch & recorded the steering note with unverified provenance.
  const notes = store.listSteerNotes(taskRef);
  expect(notes.some(n => n.note.includes("Local code handoff candidate") && n.note.includes("unverified") && n.note.includes("Updated greeting locally"))).toBe(true);

  // Read-only token cannot upload a candidate.
  const roProfile = join(dir, "remote", "ro-profiles.json");
  expect(await maybeRunConnectCommand(
    ["connect", origin, "--as", "alice", "--token-stdin"],
    () => {},
    { profileFile: roProfile, readStdin: async () => readToken.token, stderr: () => {} },
  )).toBe(0);
  const roLines: string[] = [];
  expect(await maybeRunHandoffCommand(
    ["handoff", "push", "t-handoff"],
    line => roLines.push(line),
    { profileFile: roProfile, cwd: worktree },
  )).toBe(1);
  expect(roLines.join("\n")).toMatch(/act API token/i);
});

test("toolroll handoff rebase cleanly rebases onto a teammate's promoted central commit (even unfetched) and safely handles conflicts", async () => {
  const centralRepo = join(dir, "central-rebase");
  mkdirSync(centralRepo, { recursive: true });
  git(centralRepo, ["init", "-b", "main"]);
  writeFileSync(join(centralRepo, "a.txt"), "a1\n");
  writeFileSync(join(centralRepo, "b.txt"), "b1\n");
  git(centralRepo, ["add", "."]);
  git(centralRepo, ["commit", "-m", "initial"]);

  const aliceLocal = join(dir, "alice-local");
  const bobLocal = join(dir, "bob-local");
  git(dir, ["clone", centralRepo, aliceLocal]);
  git(dir, ["clone", centralRepo, bobLocal]);

  const alice = addApprover(store, "alice", now());
  if (!alice.ok) throw new Error("alice");
  const bob = addApprover(store, "bob", now(), { name: "alice", token: alice.token });
  if (!bob.ok) throw new Error("bob");
  const aliceTok = mintApiToken();
  store.createApiToken({ id: aliceTok.id, account: "alice", name: "a", secretHash: aliceTok.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alice", projects: [centralRepo], purpose: "api" }, now());
  const bobTok = mintApiToken();
  store.createApiToken({ id: bobTok.id, account: "bob", name: "b", secretHash: bobTok.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "bob", projects: [centralRepo], purpose: "api" }, now());

  store.createTask({ id: "t-rebase", title: "Concurrent teammate edits" }, now());
  const taskRef = store.refFor("built-in", "t-rebase", "ours").id;
  store.placeTask(taskRef, centralRepo);

  const evidenceRoot = join(dir, "evidence-rebase");
  server = createDecisionServer({ store, configDir: dir, evidenceRoot, repos: [centralRepo] });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("addr");
  const origin = `http://127.0.0.1:${addr.port}`;

  const aliceProfile = join(dir, "remote", "alice.json");
  const bobProfile = join(dir, "remote", "bob.json");
  expect(await maybeRunConnectCommand(["connect", origin, "--as", "alice", "--token-stdin"], () => {}, { profileFile: aliceProfile, readStdin: async () => aliceTok.token, stderr: () => {} })).toBe(0);
  expect(await maybeRunConnectCommand(["connect", origin, "--as", "bob", "--token-stdin"], () => {}, { profileFile: bobProfile, readStdin: async () => bobTok.token, stderr: () => {} })).toBe(0);

  // Both devs pull at the same initial commit.
  const aPull: string[] = [];
  expect(await maybeRunHandoffCommand(["handoff", "pull", "t-rebase", "--repo", aliceLocal], l => aPull.push(l), { profileFile: aliceProfile })).toBe(0);
  const aWt = aPull.find(l => l.trim().startsWith("cd "))!.trim().slice(3);

  const bPull: string[] = [];
  expect(await maybeRunHandoffCommand(["handoff", "pull", "t-rebase", "--repo", bobLocal], l => bPull.push(l), { profileFile: bobProfile })).toBe(0);
  const bWt = bPull.find(l => l.trim().startsWith("cd "))!.trim().slice(3);

  // Alice edits a.txt, pushes Candidate 1, and promotes it (creating a new central headCommit not yet fetched in bobLocal!).
  writeFileSync(join(aWt, "a.txt"), "a2\n");
  const aPush: string[] = [];
  expect(await maybeRunHandoffCommand(["handoff", "push", "--note", "alice a2"], l => aPush.push(l), { profileFile: aliceProfile, cwd: aWt })).toBe(0);
  const cand1 = /cand-[a-f0-9]{16}/.exec(aPush.join("\n"))![0]!;

  const identity = store.workspaceIdentity();
  const postPromote = (candId: string, token: string): Promise<{ status: number; json: { headCommit: string } }> =>
    new Promise((resolve, reject) => {
      const u = new URL(`/api/handoff/task/t-rebase/candidate/${candId}/promote`, origin);
      const r = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-toolroll-client": "terminal-remote",
          "x-toolroll-workspace": identity.id,
          "x-toolroll-recovery": identity.recoveryGeneration,
          "content-type": "application/json",
          "content-length": "2",
          accept: "application/json",
        },
      }, res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(Buffer.from(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { headCommit: string } }));
      });
      r.on("error", reject);
      r.write("{}");
      r.end();
    });

  const promote1Res = await postPromote(cand1, aliceTok.token);
  expect(promote1Res.status).toBe(200);
  const promoted1 = promote1Res.json;

  // Bob edits b.txt (non-overlapping) and runs one-command `handoff rebase --push`.
  writeFileSync(join(bWt, "b.txt"), "b2\n");
  const bRebase: string[] = [];
  expect(await maybeRunHandoffCommand(
    ["handoff", "rebase", "--push", "--note", "bob b2 rebased"],
    l => bRebase.push(l),
    { profileFile: bobProfile, cwd: bWt },
  )).toBe(0);
  expect(bRebase.join("\n")).toContain("Rebased handoff worktree");
  expect(readFileSync(join(bWt, "a.txt"), "utf8")).toBe("a2\n");
  expect(readFileSync(join(bWt, "b.txt"), "utf8")).toBe("b2\n");

  // Bob's newly uploaded candidate promotes cleanly on top of Alice's promoted headCommit!
  const cand2 = /cand-[a-f0-9]{16}/.exec(bRebase.join("\n"))![0]!;
  const promote2Res = await postPromote(cand2, bobTok.token);
  expect(promote2Res.status).toBe(200);
  const promoted2 = promote2Res.json;
  expect(promoted2.headCommit).not.toBe(promoted1.headCommit);
  expect(git(centralRepo, ["show", `${promoted2.headCommit}:a.txt`])).toBe("a2");
  expect(git(centralRepo, ["show", `${promoted2.headCommit}:b.txt`])).toBe("b2");

  // Conflict case: Alice edits b.txt at her old base (`b1 -> b-conflict`) and rebases onto promoted2 (`b2`):
  // rebase exits 1, keeps conflict markers + backup patch, never silently loses her edits.
  writeFileSync(join(aWt, "b.txt"), "b-conflict\n");
  const statusStale: string[] = [];
  expect(await maybeRunHandoffCommand(["handoff", "status"], l => statusStale.push(l), { profileFile: aliceProfile, cwd: aWt })).toBe(0);
  expect(statusStale.join("\n")).toContain("[STALE");
  expect(statusStale.join("\n")).toContain("toolroll handoff rebase t-rebase");

  const conflictLines: string[] = [];
  expect(await maybeRunHandoffCommand(["handoff", "rebase"], l => conflictLines.push(l), { profileFile: aliceProfile, cwd: aWt })).toBe(1);
  expect(conflictLines.join("\n")).toContain("merge conflicts");
  expect(conflictLines.join("\n")).toContain("rebase-backup.patch");
  expect(readFileSync(join(aWt, "b.txt"), "utf8")).toContain("<<<<<<<");

  // `handoff clean` refuses dirty worktrees without --force, and cleanly removes with --force without touching aliceLocal.
  const dirtyClean: string[] = [];
  expect(await maybeRunHandoffCommand(["handoff", "clean"], l => dirtyClean.push(l), { cwd: aWt })).toBe(1);
  expect(dirtyClean.join("\n")).toContain("--force");
  expect(existsSync(aWt)).toBe(true);

  const forcedClean: string[] = [];
  expect(await maybeRunHandoffCommand(["handoff", "clean", "t-rebase", "--repo", aliceLocal, "--force"], l => forcedClean.push(l))).toBe(0);
  expect(existsSync(aWt)).toBe(false);
  expect(existsSync(join(aliceLocal, "a.txt"))).toBe(true);
});
