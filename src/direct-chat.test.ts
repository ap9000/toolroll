import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildSanitizedChildEnv,
  buildTurnPrompt,
  DirectChatHost,
  directChatPostureOf,
  importLegacyDirectChatJson,
  parseDirectChatLine,
} from "./direct-chat.js";
import type { CustodyIO, ProcessWitness, ProcRow } from "./flexible-custody.js";
import { openStore } from "./store.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function makeTempRepo(root: string, name = "payments-api"): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  writeFileSync(join(repo, "README.md"), "# Payments\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { env: GIT_ENV });
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
  readonly signaled: Array<{ targets: readonly ProcessWitness[]; signal: NodeJS.Signals }> = [];

  add(pid: number, pgid = pid, start = "s1764028800"): void {
    this.rows.set(pid, { pid, ppid: 1, pgid, uid: 501, start, zombie: false });
  }

  kill(pid: number): void {
    this.rows.delete(pid);
  }

  table(): ProcRow[] {
    return [...this.rows.values()];
  }

  namespaceOf(): string | null {
    return null;
  }

  holdersOf(): number[] {
    return [];
  }

  signal(targets: readonly ProcessWitness[], sig: NodeJS.Signals) {
    this.signaled.push({ targets, signal: sig });
    const sent: ProcessWitness[] = [];
    for (const target of targets) {
      const row = this.rows.get(target.pid);
      if (row && row.start === target.start) {
        this.rows.delete(target.pid);
        sent.push(target);
      }
    }
    return { sent, gone: [], mismatched: [], refused: [], unsupported: false, bestEffort: true };
  }
}

describe("DirectChatHost & helpers", () => {
  const cleanupDirs: string[] = [];

  function tempDir(prefix = "dc-test-"): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanupDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isolated local clone has its own .git dir, no origin remote, and cannot touch main repo refs or hooks", () => {
    const root = tempDir();
    const repo = makeTempRepo(root);
    // Leave an uncommitted edit in main checkout to verify it is reported but not copied into the clone.
    writeFileSync(join(repo, "dirty.txt"), "local uncommitted edit\n");

    const store = openStore(join(root, "state.db"));
    const custody = new FakeCustody();
    const spawned: Array<{ cwd: string; args: string[] }> = [];
    let nextPid = 4000;

    const host = new DirectChatHost(store, {
      stateRoot: join(root, "state"),
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        spawned.push({ cwd: input.cwd, args: input.args });
        const pid = nextPid++;
        custody.add(pid, pid, "start-1");
        return { pid, pgid: pid, startIdentity: "start-1" };
      },
    });

    try {
      const res = host.createThread({
        owner: "alex",
        localGeneration: 1,
        accountGeneration: 1,
        requestId: "1".repeat(32),
        repo,
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        prompt: "Inspect README",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const { thread } = res;
      expect(thread.mainDirtyFiles).toEqual(["dirty.txt"]);
      expect(existsSync(join(thread.clonePath, "dirty.txt"))).toBe(false);
      // Real standalone .git directory (NOT a worktree .git pointer file).
      expect(lstatSync(join(thread.clonePath, ".git")).isDirectory()).toBe(true);
      // Remote `origin` was removed so pushes cannot reach main checkout.
      const remotes = execFileSync("git", ["-C", thread.clonePath, "remote"], { env: GIT_ENV, encoding: "utf8" }).trim();
      expect(remotes).toBe("");
      // Branch matches toolroll/chat-<shortId> in clone, NOT in main repo.
      const cloneBranch = execFileSync("git", ["-C", thread.clonePath, "branch", "--show-current"], { env: GIT_ENV, encoding: "utf8" }).trim();
      expect(cloneBranch).toBe(thread.branch);
      const mainBranches = execFileSync("git", ["-C", repo, "branch", "--list"], { env: GIT_ENV, encoding: "utf8" });
      expect(mainBranches).not.toContain(thread.branch);

      // Mutating hooks and branches inside the clone cannot touch main repo's .git.
      writeFileSync(join(thread.clonePath, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
      execFileSync("git", ["-C", thread.clonePath, "branch", "side-branch"], { env: GIT_ENV });
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(execFileSync("git", ["-C", repo, "branch", "--list"], { env: GIT_ENV, encoding: "utf8" })).not.toContain("side-branch");
      expect(spawned[0]?.cwd).toBe(thread.clonePath);
    } finally {
      host.close();
      store.close();
    }
  });

  test("detached turn survives server restart, re-adopts via custody, tails JSONL, and settles on exit", () => {
    const root = tempDir();
    const repo = makeTempRepo(root);
    const dbPath = join(root, "state.db");
    const stateRoot = join(root, "state");
    const custody = new FakeCustody();
    let capturedLogPath = "";

    // Host A starts the turn and closes without killing the detached process.
    const storeA = openStore(dbPath);
    const hostA = new DirectChatHost(storeA, {
      stateRoot,
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        capturedLogPath = input.logPath;
        mkdirSync(dirname(input.logPath), { recursive: true });
        writeFileSync(
          input.logPath,
          `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" })}\n`,
          { mode: 0o600 },
        );
        custody.add(5001, 5001, "s1764028801");
        return { pid: 5001, pgid: 5001, startIdentity: "s1764028801" };
      },
    });
    const started = hostA.createThread({
      owner: "alex",
      localGeneration: 1,
      accountGeneration: 1,
      requestId: "2".repeat(32),
      repo,
      provider: "claude",
      prompt: "Check build",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hostA.reconcileRunningTurns();
    hostA.close();
    storeA.close();
    // Detached process is still running after Host A closed.
    expect(custody.rows.has(5001)).toBe(true);

    // Process keeps streaming mid-turn while server is down.
    const midTurnLines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } },
            { type: "text", text: "Running tests now." },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false }],
        },
      }),
    ].join("\n") + "\n";
    writeFileSync(capturedLogPath, readFileSync(capturedLogPath, "utf8") + midTurnLines);

    // Host B starts up on the same DB, re-adopts the running turn, then sees final result + exit.
    const storeB = openStore(dbPath);
    const notes: string[] = [];
    const hostB = new DirectChatHost(storeB, {
      stateRoot,
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      onNotify: n => notes.push(n.event),
    });
    try {
      hostB.reconcileRunningTurns();
      let detail = hostB.getThread("alex", started.thread.id)!;
      expect(detail.running).toBe(true);
      expect(detail.thread.providerSessionId).toBe("sess-abc");
      expect(detail.turns[0]?.tools).toHaveLength(1);
      expect(detail.turns[0]?.tools[0]?.status).toBe("done");

      // Final result arrives and process exits cleanly.
      writeFileSync(
        capturedLogPath,
        readFileSync(capturedLogPath, "utf8") + `${JSON.stringify({ type: "result", subtype: "success", result: "All tests passed." })}\n`,
      );
      custody.kill(5001);
      hostB.reconcileRunningTurns();
      detail = hostB.getThread("alex", started.thread.id)!;
      expect(detail.running).toBe(false);
      expect(detail.turns[0]?.status).toBe("completed");
      expect(detail.turns[0]?.assistantText).toContain("All tests passed.");
      expect(notes).toContain("change");
    } finally {
      hostB.close();
      storeB.close();
    }
  });

  test("stopThread signals process group; provider switch refuses while running and hands off context once idle", () => {
    const root = tempDir();
    const repo = makeTempRepo(root);
    const store = openStore(join(root, "state.db"));
    const custody = new FakeCustody();
    const capturedPrompts: string[] = [];
    let pidSeq = 6000;

    const host = new DirectChatHost(store, {
      stateRoot: join(root, "state"),
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/bin",
      spawnTurn: input => {
        capturedPrompts.push(input.args.join(" "));
        const pid = pidSeq++;
        custody.add(pid, pid, `start-${pid}`);
        return { pid, pgid: pid, startIdentity: `start-${pid}` };
      },
    });

    try {
      const started = host.createThread({
        owner: "alex",
        localGeneration: 1,
        accountGeneration: 1,
        requestId: "3".repeat(32),
        repo,
        provider: "claude",
        prompt: "First question",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      // Duplicate requestId is idempotent (no second spawn).
      const dup = host.createThread({
        owner: "alex",
        localGeneration: 1,
        accountGeneration: 1,
        requestId: "3".repeat(32),
        repo,
        provider: "claude",
        prompt: "First question",
      });
      expect(dup.ok).toBe(true);
      expect(capturedPrompts).toHaveLength(1);

      // Switching model while running is refused with 409.
      const refusedSwitch = host.switchModel({
        owner: "alex",
        threadId: started.thread.id,
        provider: "codex",
        modelId: "gpt-5.4",
      });
      expect(refusedSwitch.ok).toBe(false);
      if (!refusedSwitch.ok) expect(refusedSwitch.status).toBe(409);

      // Stop running turn via custody signal.
      const stopped = host.stopThread("alex", started.thread.id);
      expect(stopped).toEqual({ ok: true, stopped: true });
      expect(custody.signaled).toEqual([{ targets: [{ pid: 6000, start: "start-6000" }], signal: "SIGTERM" }]);

      // Now switch to Codex and send a follow-up turn.
      const switched = host.switchModel({
        owner: "alex",
        threadId: started.thread.id,
        provider: "codex",
        modelId: "gpt-5.4",
      });
      expect(switched.ok).toBe(true);

      const followUp = host.sendMessage({
        owner: "alex",
        threadId: started.thread.id,
        requestId: "4".repeat(32),
        prompt: "Continue with Codex",
      });
      expect(followUp.ok).toBe(true);
      if (!followUp.ok) return;
      expect(followUp.turn.switchedFromProvider).toBe("claude");
      expect(capturedPrompts[1]).toContain("[Context handed off from earlier turns in this chat:]");
      expect(capturedPrompts[1]).toContain("First question");
      expect(capturedPrompts[1]).toContain("Continue with Codex");
    } finally {
      host.close();
      store.close();
    }
  });

  test("deleteThread protects uncommitted changes with 409 unless discardChanges or keepClone is specified", () => {
    const root = tempDir();
    const repo = makeTempRepo(root);
    const store = openStore(join(root, "state.db"));
    const custody = new FakeCustody();

    const host = new DirectChatHost(store, {
      stateRoot: join(root, "state"),
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      spawnTurn: () => {
        custody.add(7001, 7001, "start-7001");
        return { pid: 7001, pgid: 7001, startIdentity: "start-7001" };
      },
    });

    try {
      const started = host.createThread({
        owner: "alex",
        localGeneration: 1,
        accountGeneration: 1,
        requestId: "5".repeat(32),
        repo,
        provider: "claude",
        prompt: "Edit a file",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      host.stopThread("alex", started.thread.id);

      // Write an uncommitted edit inside the clone.
      writeFileSync(join(started.thread.clonePath, "new-feature.ts"), "export const x = 1;\n");

      const blocked = host.deleteThread({ owner: "alex", threadId: started.thread.id });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.status).toBe(409);
        expect(blocked.code).toBe("unmerged_changes");
      }
      expect(existsSync(started.thread.clonePath)).toBe(true);

      // Deleting with keepClone preserves the clone directory while archiving the thread.
      const kept = host.deleteThread({ owner: "alex", threadId: started.thread.id, keepClone: true });
      expect(kept.ok).toBe(true);
      expect(existsSync(started.thread.clonePath)).toBe(true);
      expect(host.getThread("alex", started.thread.id)).toBeNull();
    } finally {
      host.close();
      store.close();
    }
  });

  test("stream parser handles Claude, Codex, Gemini events and redacts leaked tokens", () => {
    const claudeEvents = parseDirectChatLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ANTHROPIC_API_KEY=sk-ant-api03-secretvalue1234567890" }] },
      }),
      "claude",
    );
    expect(claudeEvents[0]?.kind).toBe("text_replace");
    if (claudeEvents[0]?.kind === "text_replace") {
      expect(claudeEvents[0].text).not.toContain("sk-ant-api03");
    }

    const codexSession = parseDirectChatLine(JSON.stringify({ type: "thread.started", thread_id: "thr_99" }), "codex");
    expect(codexSession).toEqual([{ kind: "session_id", sessionId: "thr_99" }]);

    const geminiDenied = parseDirectChatLine(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "push_remote" }] } }),
      "gemini",
    );
    expect(geminiDenied.some(e => e.kind === "failed" && e.message.includes("push_remote"))).toBe(true);

    // Sanitized env strips push/deploy tokens and disables git prompts.
    const env = buildSanitizedChildEnv({
      PATH: "/usr/bin",
      GH_TOKEN: "ghp_secret",
      GITHUB_TOKEN: "gho_secret",
      NPM_TOKEN: "npm_secret",
      VERCEL_TOKEN: "vrc_secret",
      SAFE_VAR: "keep",
    });
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["NPM_TOKEN"]).toBeUndefined();
    expect(env["VERCEL_TOKEN"]).toBeUndefined();
    expect(env["SAFE_VAR"]).toBe("keep");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");

    // Plain-English posture copy and handoff prompt helper.
    expect(directChatPostureOf("claude").summary).toBe("Runs commands without asking");
    expect(directChatPostureOf("codex").sandboxed).toBe(true);
    const prompt = buildTurnPrompt({
      userPrompt: "Do next",
      branch: "toolroll/chat-12345678",
      isFirstTurnForProvider: true,
      priorTurns: [{ userPrompt: "Hello", assistantText: "Hi there" }],
    });
    expect(prompt).toContain("isolated local clone on branch toolroll/chat-12345678");
    expect(prompt).toContain("Hello");
  });

  test("importLegacyDirectChatJson imports Mac chat-threads.json once, idempotently, leaving file untouched", () => {
    const root = tempDir();
    const repo = makeTempRepo(root);
    const legacyPath = join(root, "chat-threads.json");
    const legacyPayload = JSON.stringify([
      {
        id: "A1B2C3D4-E5F6-4789-ABCD-0123456789AB",
        title: "Legacy Mac chat",
        project: repo,
        provider: "claude",
        modelID: "claude-sonnet-4-6",
        providerSessionID: "legacy-sess-1",
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-01T10:05:00.000Z",
        messages: [
          { role: "user", text: "What does README say?", createdAt: "2026-10-01T10:00:00.000Z" },
          { role: "assistant", text: "It describes Payments.", createdAt: "2026-10-01T10:01:00.000Z" },
        ],
      },
    ]);
    writeFileSync(legacyPath, legacyPayload);

    const store = openStore(join(root, "state.db"));
    try {
      const first = importLegacyDirectChatJson({ store, owner: "alex", accountGeneration: 1, jsonPath: legacyPath });
      expect(first).toBe(1);
      // Second run is a no-op (INSERT OR IGNORE).
      const second = importLegacyDirectChatJson({ store, owner: "alex", accountGeneration: 1, jsonPath: legacyPath });
      expect(second).toBe(0);
      // Original Mac file untouched.
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyPayload);

      const host = new DirectChatHost(store, { stateRoot: join(root, "state") });
      const list = host.listThreads("alex");
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe("Legacy Mac chat");
      const detail = host.getThread("alex", list[0]!.id)!;
      expect(detail.turns).toHaveLength(1);
      expect(detail.turns[0]?.userPrompt).toBe("What does README say?");
      expect(detail.turns[0]?.assistantText).toBe("It describes Payments.");
    } finally {
      store.close();
    }
  });
});
