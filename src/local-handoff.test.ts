import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
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
