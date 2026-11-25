import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fakePid } from "../test/fake-pid.js";
import { DirectChatHost } from "./direct-chat.js";
import {
  captureNewWorkspaceArtifacts,
  detectSafeImageMime,
  extractBase64ImagesFromLine,
  saveDirectChatArtifact,
  snapshotWorkspaceImages,
} from "./direct-chat-artifacts.js";
import {
  baseStillAncestor,
  cancelDirectChatShip,
  directChatArmedPass,
  executeDirectChatShip,
  listDirectChatShips,
  previewDirectChatShip,
} from "./direct-chat-ship.js";
import {
  applyMainDirtyPatch,
  cloneSafeNodeModules,
  cloneSafeNodeModulesAsync,
  discoverNodeModulesDirs,
  scanNodeModulesSafety,
} from "./direct-chat-workspace.js";
import type { CustodyIO, ProcessWitness, ProcRow } from "./flexible-custody.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { storeEvidence } from "./evidence.js";
import { declareNewInstallSolo } from "./install-mode.js";
import { addApprover } from "./scope.js";
import { openStore } from "./store.js";
import { sealVerificationReceipt } from "./verification-evidence.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const T0 = new Date("2026-10-27T12:00:00.000Z");

// Valid 1x1 PNG bytes.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeRepo(root: string, name = "payments-api"): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.venv/\n.next/\n.turbo/\n");
  writeFileSync(join(repo, "README.md"), "# Payments\nLine one\n");
  execFileSync("git", ["-C", repo, "add", ".gitignore", "README.md"], { env: GIT_ENV });
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "initial"],
    { env: GIT_ENV },
  );
  return repo;
}

class FakeCustody implements CustodyIO {
  readonly platform: NodeJS.Platform = "darwin";
  readonly self = 1;
  readonly rows = new Map<number, ProcRow>();
  add(pid: number, start = "s1"): void {
    this.rows.set(pid, { pid, ppid: 1, pgid: pid, uid: 501, start, zombie: false });
  }
  table(): ProcRow[] { return [...this.rows.values()]; }
  namespaceOf(): string | null { return null; }
  holdersOf(): number[] { return []; }
  signal(targets: readonly ProcessWitness[]) {
    for (const t of targets) this.rows.delete(t.pid);
    return { sent: [...targets], gone: [], mismatched: [], refused: [], unsupported: false, bestEffort: true };
  }
}

describe("Direct Chat Phase 1b (workspace, artifacts, Ship)", () => {
  const cleanupDirs: string[] = [];
  function tempDir(prefix = "dc-1b-"): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanupDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  });

  test("safe APFS node_modules cloning discovers monorepo dirs, allows internal relative symlinks, and rejects escaping/absolute symlinks", async () => {
    const root = tempDir();
    const repo = makeRepo(root);
    const clonePath = join(root, "clone");
    mkdirSync(clonePath, { recursive: true });

    // 1. Safe root node_modules with internal relative .bin symlink.
    const rootNm = join(repo, "node_modules");
    mkdirSync(join(rootNm, "pkg"), { recursive: true });
    mkdirSync(join(rootNm, ".bin"), { recursive: true });
    writeFileSync(join(rootNm, "pkg", "cli.js"), "#!/usr/bin/env node\n");
    symlinkSync("../pkg/cli.js", join(rootNm, ".bin", "pkg"));

    // 2. Safe pnpm workspace relative symlink (`../../packages/shared`) inside repo root is ALLOWED.
    mkdirSync(join(repo, "packages", "shared"), { recursive: true });
    writeFileSync(join(repo, "packages", "shared", "index.js"), "export const s = 1;\n");
    const pnpmNm = join(repo, "packages", "app", "node_modules");
    mkdirSync(pnpmNm, { recursive: true });
    symlinkSync("../../shared", join(pnpmNm, "shared-pkg"));

    // 3. Unsafe nested monorepo node_modules escaping OUTSIDE the repo root is REJECTED.
    const unsafeNm = join(repo, "packages", "bad", "node_modules");
    mkdirSync(unsafeNm, { recursive: true });
    symlinkSync("../../../../../etc/hosts", join(unsafeNm, "escape-link"));

    // 4. Unsafe nested node_modules with an absolute symlink is REJECTED.
    const absNm = join(repo, "packages", "abs", "node_modules");
    mkdirSync(absNm, { recursive: true });
    symlinkSync(join(repo, "README.md"), join(absNm, "abs-link"));

    // 5. Ignored .venv and .next must never be discovered.
    mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
    mkdirSync(join(repo, ".next", "cache"), { recursive: true });

    const discovered = discoverNodeModulesDirs(repo);
    expect(discovered).toEqual(["node_modules", "packages/abs/node_modules", "packages/app/node_modules", "packages/bad/node_modules"]);
    expect(scanNodeModulesSafety(rootNm, { repoRoot: repo }).safe).toBe(true);
    expect(scanNodeModulesSafety(pnpmNm, { repoRoot: repo }).safe).toBe(true);
    expect(scanNodeModulesSafety(unsafeNm, { repoRoot: repo }).safe).toBe(false);
    expect(scanNodeModulesSafety(absNm, { repoRoot: repo }).safe).toBe(false);

    const copied: Array<{ src: string; dst: string }> = [];
    const res = cloneSafeNodeModules({
      repo,
      clonePath,
      platform: "darwin",
      copyCoW: (src, dst) => {
        if (src.endsWith(join("packages", "app", "node_modules"))) {
          // Simulate a partial copy that fails mid-way -> partial dst must be cleaned up!
          mkdirSync(dst, { recursive: true });
          writeFileSync(join(dst, "partial.tmp"), "incomplete");
          throw new Error("ETIMEDOUT");
        }
        copied.push({ src, dst });
        mkdirSync(dst, { recursive: true });
      },
    });
    expect(res.cloned).toEqual(["node_modules"]);
    expect(existsSync(join(clonePath, "packages", "app", "node_modules"))).toBe(false);
    expect(res.skipped.map(s => s.path).sort()).toEqual(["packages/abs/node_modules", "packages/app/node_modules", "packages/bad/node_modules"]);
    expect(copied).toHaveLength(1);

    // Async CoW clone path produces the same safe result without blocking the event loop.
    const asyncClonePath = join(root, "clone-async");
    mkdirSync(asyncClonePath, { recursive: true });
    const asyncRes = await cloneSafeNodeModulesAsync({
      repo,
      clonePath: asyncClonePath,
      platform: "darwin",
      copyCoW: async (_src, dst) => {
        mkdirSync(dst, { recursive: true });
      },
    });
    expect(asyncRes.cloned).toEqual(["node_modules", "packages/app/node_modules"]);
    expect(asyncRes.skipped.map(s => s.path).sort()).toEqual(["packages/abs/node_modules", "packages/bad/node_modules"]);
  });

  test("applyMainDirtyPatch brings tracked edits into the isolated clone without touching main checkout", async () => {
    const root = tempDir();
    const repo = makeRepo(root);
    const stateRoot = join(root, "state");
    const store = openStore(join(root, "state.db"));
    const custody = new FakeCustody();
    const host = new DirectChatHost(store, {
      stateRoot,
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        mkdirSync(dirname(input.logPath), { recursive: true });
        writeFileSync(input.logPath, "", { mode: 0o600 });
        const pid = fakePid(10);
        custody.add(pid, "s9050");
        return { pid, pgid: pid, startIdentity: "s9050" };
      },
    });
    try {
      const started = await host.createThread({
        owner: "alex",
        localGeneration: 1,
        accountGeneration: 1,
        requestId: "a".repeat(32),
        repo,
        provider: "claude",
        prompt: "Setup",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      host.stopThread("alex", started.thread.id);

      // Dirty main checkout (one tracked edit + one untracked file).
      writeFileSync(join(repo, "README.md"), "# Payments\nLine one\nUncommitted line\n");
      writeFileSync(join(repo, "notes.tmp"), "untracked note\n");

      const applied = applyMainDirtyPatch({ repo, binding: host.bindingOf(started.thread)! });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.appliedFiles).toEqual(["README.md"]);
      expect(applied.untrackedFiles).toEqual(["notes.tmp"]);
      expect(readFileSync(join(started.thread.clonePath, "README.md"), "utf8")).toContain("Uncommitted line");
      expect(existsSync(join(started.thread.clonePath, "notes.tmp"))).toBe(false);
    } finally {
      host.close();
      store.close();
    }
  });

  test("artifacts enforce magic bytes, reject SVG/fake images, git-exclude attachments, and capture workspace + base64 images", async () => {
    const root = tempDir();
    const repo = makeRepo(root);
    const store = openStore(join(root, "state.db"));
    const custody = new FakeCustody();
    const stateRoot = join(root, "state");

    const host = new DirectChatHost(store, {
      stateRoot,
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        mkdirSync(dirname(input.logPath), { recursive: true });
        writeFileSync(input.logPath, "", { mode: 0o600 });
        const pid = fakePid(11);
        custody.add(pid, "s9100");
        return { pid, pgid: pid, startIdentity: "s9100" };
      },
    });

    try {
      const started = await host.createThread({
        owner: "alex",
        localGeneration: 1,
        accountGeneration: 1,
        requestId: "1".repeat(32),
        repo,
        provider: "claude",
        prompt: "Review screenshot",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      host.stopThread("alex", started.thread.id);

      // Magic-byte validation: PNG ok, SVG / fake PNG rejected.
      expect(detectSafeImageMime(TINY_PNG)).toBe("image/png");
      expect(detectSafeImageMime(Buffer.from("<svg><script>alert(1)</script></svg>"))).toBeNull();

      const rejectedSvg = saveDirectChatArtifact(store, {
        stateRoot,
        threadId: started.thread.id,
        turnId: null,
        kind: "attachment",
        filename: "evil.svg",
        mimeType: "image/svg+xml",
        bytes: Buffer.from("<svg></svg>"),
        clonePath: started.thread.clonePath,
      });
      expect(rejectedSvg.ok).toBe(false);
      if (!rejectedSvg.ok) expect(rejectedSvg.status).toBe(415);

      // Valid PNG attachment is stored 0600, placed in .toolroll-attachments/, and excluded from git status.
      const attached = host.attachFile({
        owner: "alex",
        threadId: started.thread.id,
        filename: "mockup.png",
        bytes: TINY_PNG,
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      expect(attached.cloneRelativePath).toMatch(/^\.toolroll-attachments\//);
      expect(existsSync(join(started.thread.clonePath, attached.cloneRelativePath!))).toBe(true);
      const gitStatus = execFileSync("git", ["-C", started.thread.clonePath, "status", "--porcelain"], { env: GIT_ENV, encoding: "utf8" }).trim();
      expect(gitStatus).toBe("");

      // Pre/post workspace scan captures real new PNG and ignores symlinks.
      const before = snapshotWorkspaceImages(started.thread.clonePath);
      writeFileSync(join(started.thread.clonePath, "after.png"), TINY_PNG);
      symlinkSync(join(repo, "README.md"), join(started.thread.clonePath, "sneaky.png"));
      const captured = captureNewWorkspaceArtifacts(store, {
        stateRoot,
        threadId: started.thread.id,
        turnId: started.turn.id,
        clonePath: started.thread.clonePath,
        before,
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.filename).toBe("after.png");

      // Embedded base64 PNG in Claude tool_result JSONL is extracted.
      const line = JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG.toString("base64") } }],
        },
      });
      const extracted = extractBase64ImagesFromLine(line, "claude");
      expect(extracted).toHaveLength(1);
      expect(extracted[0]?.bytes.equals(TINY_PNG)).toBe(true);
    } finally {
      host.close();
      store.close();
    }
  });

  test("Ship previews hashed terms, freezes snapshot commits, supports keep-branch on local repos, and arms+cancels verify-only tasks on GitHub repos", async () => {
    const root = tempDir();
    const repo = makeRepo(root);
    const store = openStore(join(root, "state.db"));
    const op = addApprover(store, "alex", T0);
    if (!op.ok) throw new Error("addApprover");
    declareNewInstallSolo(store, "alex", T0);
    for (const phase of ["build", "plan", "review"] as const) {
      store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
    }

    const custody = new FakeCustody();
    const host = new DirectChatHost(store, {
      stateRoot: join(root, "state"),
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        mkdirSync(dirname(input.logPath), { recursive: true });
        writeFileSync(input.logPath, "", { mode: 0o600 });
        const pid = fakePid(12);
        custody.add(pid, "s9200");
        return { pid, pgid: pid, startIdentity: "s9200" };
      },
    });

    try {
      const started = await host.createThread({
        owner: "alex",
        localGeneration: null,
        accountGeneration: 1,
        requestId: "2".repeat(32),
        repo,
        provider: "claude",
        prompt: "Add feature",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      host.stopThread("alex", started.thread.id);

      // Make an uncommitted edit inside the isolated clone.
      writeFileSync(join(started.thread.clonePath, "feature.ts"), "export const ready = true;\n");

      // 1. Local repo without GitHub grant: canAutoMerge is false, keep-branch works with per-ship branch name.
      const preview1 = previewDirectChatShip(store, { stateRoot: host.stateRoot, owner: "alex", threadId: started.thread.id });
      expect(preview1.ok).toBe(true);
      if (!preview1.ok) return;
      expect(preview1.preview.canAutoMerge).toBe(false);
      expect(preview1.preview.mode).toBe("keep-branch");
      expect(preview1.preview.branch).toBe(`${started.thread.branch}-1`);
      expect(preview1.preview.changedFiles).toEqual(["feature.ts"]);

      // Stale termsDigest is refused with 409 terms_changed.
      const stale = executeDirectChatShip(store, {
        stateRoot: host.stateRoot,
        owner: "alex",
        threadId: started.thread.id,
        mode: "keep-branch",
        termsDigest: "0".repeat(32),
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.code).toBe("terms_changed");

      // Keep-branch freezes a snapshot commit and fetches the per-ship branch into main repo.
      const kept = executeDirectChatShip(store, {
        stateRoot: host.stateRoot,
        owner: "alex",
        threadId: started.thread.id,
        mode: "keep-branch",
        termsDigest: preview1.preview.termsDigest,
      });
      expect(kept.ok).toBe(true);
      if (!kept.ok) return;
      expect(kept.ship.state).toBe("kept");
      const mainBranches = execFileSync("git", ["-C", repo, "branch", "--list"], { env: GIT_ENV, encoding: "utf8" });
      expect(mainBranches).toContain(`${started.thread.branch}-1`);

      // 2. Configure GitHub publication grant + check command -> auto-merge Ship arms a verify-only task!
      store.savePublicationGrant({
        repo,
        githubRepo: "acme/payments-api",
        remote: "origin",
        headPrefix: "toolroll/",
        base: "main",
        merge: true,
        mergeMethod: "squash",
        capabilities: ["push-branch", "open-pr"],
        selector: "ours",
        draft: false,
        grantedBy: "alex",
      }, T0);
      store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, T0);

      // Make another edit in the same chat to test a second Ship snapshot.
      writeFileSync(join(started.thread.clonePath, "feature2.ts"), "export const v2 = 2;\n");
      const preview2 = previewDirectChatShip(store, { stateRoot: host.stateRoot, owner: "alex", threadId: started.thread.id, mode: "ship" });
      expect(preview2.ok).toBe(true);
      if (!preview2.ok) return;
      expect(preview2.preview.canAutoMerge).toBe(true);
      expect(preview2.preview.checkCommand).toBe("npm test");
      expect(preview2.preview.githubRepo).toBe("acme/payments-api");

      const shipped = executeDirectChatShip(store, {
        stateRoot: host.stateRoot,
        owner: "alex",
        threadId: started.thread.id,
        mode: "ship",
        termsDigest: preview2.preview.termsDigest,
        password: op.token,
        now: T0,
      });
      expect(shipped.ok, JSON.stringify(shipped)).toBe(true);
      if (!shipped.ok) return;
      expect(shipped.ship.state).toBe("armed");
      expect(shipped.ship.taskId).toBe(`dc-${preview2.preview.termsDigest}`);
      expect(store.getTask(shipped.ship.taskId!)).not.toBeNull();

      // Cancelling the armed Ship transitions it to cancelled AND cancels the verify-only task!
      const cancelled = cancelDirectChatShip(store, {
        owner: "alex",
        threadId: started.thread.id,
        shipId: shipped.ship.id,
      });
      expect(cancelled.ok).toBe(true);
      const ships = listDirectChatShips(store, started.thread.id);
      expect(ships.find(s => s.id === shipped.ship.id)?.state).toBe("cancelled");
      expect(store.getTask(shipped.ship.taskId!)?.state).toBe("cancelled");

      // 3. Base check prefers remote-tracking ref `refs/remotes/origin/main` over a stale local `refs/heads/main`,
      //    and automatic cancel via `directChatArmedPass` ALSO cancels the underlying verify-only task!
      writeFileSync(join(started.thread.clonePath, "feature3.ts"), "export const v3 = 3;\n");
      const preview3 = previewDirectChatShip(store, { stateRoot: host.stateRoot, owner: "alex", threadId: started.thread.id, mode: "ship" });
      expect(preview3.ok).toBe(true);
      if (!preview3.ok) return;
      const shipped3 = executeDirectChatShip(store, {
        stateRoot: host.stateRoot,
        owner: "alex",
        threadId: started.thread.id,
        mode: "ship",
        termsDigest: preview3.preview.termsDigest,
        password: op.token,
        now: T0,
      });
      expect(shipped3.ok).toBe(true);
      if (!shipped3.ok) return;

      // Create an orphan commit on `refs/remotes/origin/main` (simulating a remote force-push while local `main` is stale).
      const orphanTree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { env: GIT_ENV, encoding: "utf8" }).trim();
      const orphanSha = execFileSync(
        "git",
        ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit-tree", orphanTree, "-m", "remote rewrite"],
        { env: GIT_ENV, encoding: "utf8" },
      ).trim();
      execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", orphanSha], { env: GIT_ENV });
      expect(baseStillAncestor(repo, started.thread.baseSha, "origin", "main")).toBe("no");

      const passReport = await directChatArmedPass(store, { root: join(root, "evidence"), clock: () => T0 });
      expect(passReport.cancelled).toBe(1);
      expect(listDirectChatShips(store, started.thread.id).find(s => s.id === shipped3.ship.id)?.state).toBe("cancelled");
      expect(store.getTask(shipped3.ship.taskId!)?.state).toBe("cancelled");

      // 4. Definite merge failure reverts `merging -> completed` (instead of getting stuck in `merging` and
      //    cancelled 15 minutes later as uncertain).
      execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", started.thread.baseSha], { env: GIT_ENV });
      writeFileSync(join(started.thread.clonePath, "feature4.ts"), "export const v4 = 4;\n");
      const preview4 = previewDirectChatShip(store, { stateRoot: host.stateRoot, owner: "alex", threadId: started.thread.id, mode: "ship" });
      expect(preview4.ok).toBe(true);
      if (!preview4.ok) return;
      const shipped4 = executeDirectChatShip(store, {
        stateRoot: host.stateRoot,
        owner: "alex",
        threadId: started.thread.id,
        mode: "ship",
        termsDigest: preview4.preview.termsDigest,
        password: op.token,
        now: T0,
      });
      expect(shipped4.ok).toBe(true);
      if (!shipped4.ok) return;

      // Seed a passing verified builder run + open PR so directChatArmedPass enters the `completed` -> `merging` step.
      const taskRef4 = store.lookupRef(shipped4.ship.taskId!)!;
      const scope4 = store.getScope(shipped4.ship.taskId!)!;
      const T1 = new Date(T0.getTime() + 1_000);
      const run4 = Number(
        store.handle.prepare(`
          INSERT INTO run (
            task_ref, lease_id, runner, branch, worktree, model, role, provider,
            started_at, finished_at, base_revision, head_revision, scope_digest, committed, outcome
          ) VALUES (?, 'lease-4', 'w1', ?, ?, 'sonnet', 'builder', 'claude', ?, ?, ?, ?, ?, 1, 'built')
        `).run(
          taskRef4.id,
          shipped4.ship.branch,
          started.thread.clonePath,
          T1.toISOString(),
          T1.toISOString(),
          started.thread.baseSha,
          shipped4.ship.candidateSha,
          scope4.digest,
        ).lastInsertRowid,
      );
      const evRoot = join(root, "evidence");
      mkdirSync(evRoot, { recursive: true });
      storeEvidence(store, evRoot, run4, "check-log", "check.log", Buffer.from("PASS\n"), "machine check", T1, { captureStatus: "ok", redacted: false });
      sealVerificationReceipt(
        store,
        evRoot,
        run4,
        shipped4.ship.candidateSha,
        store.liveVerifyCommand(repo)!,
        { configured: true, ran: true, exitCode: 0 },
        T1,
      );
      recordRunCheckLevel(store, { id: run4, taskId: shipped4.ship.taskId!, repo }, "full", "project", T1);
      store.handle.prepare(`
        INSERT INTO run_check (run, status, exit_code, suites_json, release, recorded_at)
        VALUES (?, 'passed', 0, '[]', 0, ?)
      `).run(run4, T1.toISOString());
      const pubId = store.createPublicationIntent({
        run: run4,
        taskRef: taskRef4.id,
        githubRepo: "acme/payments-api",
        remote: "origin",
        base: "main",
        head: shipped4.ship.branch,
        headSha: shipped4.ship.candidateSha,
        bodyHash: "h1",
        draft: false,
      }, T1);
      store.handle.prepare(`
        UPDATE publication SET state = 'opened', pr_number = 42, pr_url = 'https://github.com/acme/payments-api/pull/42'
        WHERE id = ?
      `).run(pubId);
      store.handle.prepare(`
        INSERT INTO pull_request_follow (publication, flow_card, revisions, created_at, updated_at)
        VALUES (?, NULL, 0, ?, ?)
      `).run(pubId, T1.toISOString(), T1.toISOString());
      store.handle.prepare(`
        UPDATE direct_chat_ship SET state = 'completed' WHERE id = ?
      `).run(shipped4.ship.id);

      const ghActions: string[] = [];
      const failMergePass = await directChatArmedPass(store, {
        root: evRoot,
        clock: () => T1,
        exec: async (_cmd, args) => {
          ghActions.push(`${args[0]} ${args[1]}`);
          if (args[0] === "pr" && args[1] === "view") {
            return {
              code: 0,
              stdout: JSON.stringify({
                state: "OPEN",
                isDraft: false,
                headRefOid: shipped4.ship.candidateSha,
                statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
                mergeCommit: null,
                baseRefName: "main",
                url: "https://github.com/acme/payments-api/pull/42",
              }),
              stderr: "",
              notFound: false,
            };
          }
          // Simulate GitHub refusing the merge (e.g. branch protection / transient 502).
          return { code: 1, stdout: "", stderr: "GraphQL: Base branch policy blocked merge temporarily", notFound: false };
        },
      });
      expect(ghActions).toContain("pr merge");
      expect(failMergePass.waiting).toBe(1);
      const afterFail = listDirectChatShips(store, started.thread.id).find(s => s.id === shipped4.ship.id)!;
      expect(afterFail.state).toBe("completed");
      expect(afterFail.mergeToken).toBeNull();
      expect(afterFail.detail).toContain("Base branch policy");
    } finally {
      host.close();
      store.close();
    }
  });
});
