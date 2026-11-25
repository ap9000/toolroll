import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildProviderCommand,
  buildSanitizedChildEnv,
  buildTurnPrompt,
  DirectChatHost,
  directChatPostureOf,
  importLegacyDirectChatJson,
  parseDirectChatLine,
} from "./direct-chat.js";
import { assertTrustedCloneGit, pinnedConfigBackupPath, runTrustedCloneGit } from "./direct-chat-git.js";
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

  test("isolated local clone has its own .git dir, no origin remote, and cannot touch main repo refs or hooks", async () => {
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
      const res = await host.createThread({
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
      // Separate git-dir inside Toolroll state folder (clone's .git is a gitdir pointer file).
      expect(lstatSync(join(thread.clonePath, ".git")).isFile()).toBe(true);
      expect(thread.gitDir).toContain(join("direct-chat", "gitdirs"));
      expect(thread.configSha256).toMatch(/^[0-9a-f]{64}$/);
      // Remote `origin` was removed so pushes cannot reach main checkout.
      const remotes = execFileSync("git", ["-C", thread.clonePath, "remote"], { env: GIT_ENV, encoding: "utf8" }).trim();
      expect(remotes).toBe("");
      // Branch matches toolroll/chat-<shortId> in clone, NOT in main repo.
      const cloneBranch = execFileSync("git", ["-C", thread.clonePath, "branch", "--show-current"], { env: GIT_ENV, encoding: "utf8" }).trim();
      expect(cloneBranch).toBe(thread.branch);
      const mainBranches = execFileSync("git", ["-C", repo, "branch", "--list"], { env: GIT_ENV, encoding: "utf8" });
      expect(mainBranches).not.toContain(thread.branch);

      // Mutating branches or planting diff.external in the clone's git-dir config cannot touch main repo
      // AND causes Toolroll's pinned-config guard to refuse before running git!
      execFileSync("git", ["-C", thread.clonePath, "branch", "side-branch"], { env: GIT_ENV });
      expect(execFileSync("git", ["-C", repo, "branch", "--list"], { env: GIT_ENV, encoding: "utf8" })).not.toContain("side-branch");
      const marker = join(root, "pwned.txt");
      appendFileSync(join(thread.gitDir!, "config"), `\n[diff]\n\texternal = touch ${marker}\n`);
      const binding = host.bindingOf(thread)!;
      expect(assertTrustedCloneGit(binding).ok).toBe(false);
      expect(() => runTrustedCloneGit(binding, ["diff", "--no-ext-diff", "--no-textconv", thread.baseSha])).toThrow(/config changed/i);
      expect(existsSync(marker)).toBe(false);

      // Stop turn and verify repairCloneGit restores tampered config, .git pointer, and planted commondir!
      host.stopThread("alex", thread.id);
      const evilCommonDir = join(root, "evil-common");
      mkdirSync(evilCommonDir, { recursive: true });
      const filterMarker = join(root, "filter-pwned.txt");
      writeFileSync(
        join(evilCommonDir, "config"),
        `[filter "evil"]\n\tclean = touch ${filterMarker}\n\tsmudge = cat\n`,
      );
      writeFileSync(join(thread.clonePath, ".gitattributes"), "* filter=evil\n");
      writeFileSync(join(thread.gitDir!, "commondir"), `${evilCommonDir}\n`);
      // Even after restoring config, commondir redirect MUST still be refused and filter must never execute.
      writeFileSync(join(thread.gitDir!, "config"), readFileSync(pinnedConfigBackupPath(thread.gitDir!)));
      const commonDirCheck = assertTrustedCloneGit(binding);
      expect(commonDirCheck.ok).toBe(false);
      if (!commonDirCheck.ok) expect(commonDirCheck.error).toMatch(/commondir/i);
      expect(() => runTrustedCloneGit(binding, ["status"])).toThrow(/commondir/i);
      expect(existsSync(filterMarker)).toBe(false);

      // Also verify tampering .git pointer + commondir + config can be cleanly repaired via host.repairCloneGit!
      writeFileSync(join(thread.clonePath, ".git"), "gitdir: /tmp/not-ours\n");
      appendFileSync(join(thread.gitDir!, "config"), "\n[user]\n\tname = tampered\n");
      const repaired = host.repairCloneGit("alex", thread.id);
      expect(repaired.ok).toBe(true);
      expect(assertTrustedCloneGit(binding).ok).toBe(true);
      expect(existsSync(join(thread.gitDir!, "commondir"))).toBe(false);
      expect(runTrustedCloneGit(binding, ["status", "--porcelain"])).toContain(".gitattributes");
      expect(existsSync(filterMarker)).toBe(false);

      // A dangling symlink named `commondir` is also refused, and a tampered `.pinned-config` backup is refused!
      symlinkSync("/nonexistent/target", join(thread.gitDir!, "commondir"));
      expect(assertTrustedCloneGit(binding).ok).toBe(false);
      writeFileSync(pinnedConfigBackupPath(thread.gitDir!), "[core]\n\tbare = true\n");
      const refusedRepair = host.repairCloneGit("alex", thread.id);
      expect(refusedRepair.ok).toBe(false);
      if (!refusedRepair.ok) expect(refusedRepair.error).toMatch(/does not match the recorded hash/i);

      expect(spawned[0]?.cwd).toBe(realpathSync(thread.clonePath));
    } finally {
      host.close();
      store.close();
    }
  });

  test("detached turn survives server restart, re-adopts via custody, tails JSONL, and settles on exit", async () => {
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
    const started = await hostA.createThread({
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

  test("stopThread signals process group; provider switch refuses while running and hands off context once idle", async () => {
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
      const started = await host.createThread({
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
      const dup = await host.createThread({
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
      expect(stopped).toEqual({ ok: true, stopped: true, stopping: false });
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

  test("deleteThread protects uncommitted changes with 409 unless discardChanges or keepClone is specified", async () => {
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
      const started = await host.createThread({
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
        message: { content: [{ type: "text", text: "## Summary\n\n- Line one\nANTHROPIC_API_KEY=sk-ant-api03-secretvalue1234567890\n- Line two" }] },
      }),
      "claude",
    );
    expect(claudeEvents[0]?.kind).toBe("text_replace");
    if (claudeEvents[0]?.kind === "text_replace") {
      expect(claudeEvents[0].text).not.toContain("sk-ant-api03");
      expect(claudeEvents[0].text).toContain("## Summary\n\n- Line one\n");
      expect(claudeEvents[0].text).toContain("\n- Line two");
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
    expect(prompt).toContain("do not run git commit or git push");
    expect(prompt).toContain("Hello");
  });

  test("importLegacyDirectChatJson imports Mac chat-threads.json strictly as archived read-only history and refuses writes", () => {
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

      // Imported legacy chats are archived & have empty clone_path (never pointing at real checkout).
      const rawRow = store.handle
        .prepare("SELECT archived_at, clone_path, is_legacy FROM direct_chat_thread WHERE id = ?")
        .get("a1b2c3d4e5f64789abcd0123456789ab") as Record<string, unknown>;
      expect(rawRow["archived_at"]).toBe("2026-10-01T10:05:00.000Z");
      expect(rawRow["clone_path"]).toBe("");
      expect(rawRow["is_legacy"]).toBe(1);

      const host = new DirectChatHost(store, { stateRoot: join(root, "state") });
      expect(host.listThreads("alex")).toHaveLength(0);

      // Even if someone manually clears archived_at and sets clone_path = repo, every write path refuses!
      store.handle.prepare("UPDATE direct_chat_thread SET archived_at = NULL, clone_path = ? WHERE id = ?").run(repo, "a1b2c3d4e5f64789abcd0123456789ab");
      const sendBlocked = host.sendMessage({
        owner: "alex",
        threadId: "a1b2c3d4e5f64789abcd0123456789ab",
        requestId: "9".repeat(32),
        prompt: "Touch real repo",
      });
      expect(sendBlocked.ok).toBe(false);
      if (!sendBlocked.ok) expect(sendBlocked.status).toBe(409);
      const applyBlocked = host.applyMainEdits("alex", "a1b2c3d4e5f64789abcd0123456789ab");
      expect(applyBlocked.ok).toBe(false);
    } finally {
      store.close();
    }
  });

  test("hardening regressions: verified stop with SIGKILL escalation, unreadable ps = unknown, missing startIdentity escape hatch, partial JSONL across restart, split-delta redaction, CLI flag safety", async () => {
    const root = tempDir();
    const repo = makeRepoSimple(root);
    const stateRoot = join(root, "state");
    const dbPath = join(root, "state.db");
    let nowMs = Date.parse("2026-11-24T10:00:00.000Z");
    let tableUnreadable = false;
    let ignoreSigterm = true;
    const signalsSent: Array<{ pid: number; sig: NodeJS.Signals }> = [];

    const rows = new Map<number, ProcRow>();
    const stubbornCustody: CustodyIO = {
      platform: "darwin",
      self: 1,
      table: () => (tableUnreadable ? null : [...rows.values()]),
      namespaceOf: () => null,
      holdersOf: () => [],
      signal(targets, sig) {
        const sent: ProcessWitness[] = [];
        for (const t of targets) {
          signalsSent.push({ pid: t.pid, sig });
          if (sig === "SIGKILL" || !ignoreSigterm) {
            rows.delete(t.pid);
          }
          sent.push(t);
        }
        return { sent, gone: [], mismatched: [], refused: [], unsupported: false, bestEffort: true };
      },
    };

    const store = openStore(dbPath);
    let capturedLogPath = "";
    const host = new DirectChatHost(store, {
      stateRoot,
      now: () => new Date(nowMs),
      custody: stubbornCustody,
      bootId: () => "boot-1",
      stopGraceMs: 5_000,
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        capturedLogPath = input.logPath;
        mkdirSync(dirname(input.logPath), { recursive: true });
        // Write a partial JSONL line WITHOUT a trailing newline, plus split-secret deltas!
        writeFileSync(
          input.logPath,
          `${JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "ANTHROPIC_API_KEY=" } })}\n`
            + `${JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "sk-ant-api03-secretvalue1234567890" } })}\n`
            + `{"event":"result","result":{"conversation_id":"conv-`,
          { mode: 0o600 },
        );
        rows.set(8801, { pid: 8801, ppid: 1, pgid: 8801, uid: 501, start: "s8801", zombie: false });
        return { pid: 8801, pgid: 8801, startIdentity: "s8801" };
      },
    });

    try {
      const started = await host.createThread({
        owner: "alex",
        localGeneration: 1,
        accountGeneration: 1,
        requestId: "8".repeat(32),
        repo,
        provider: "gemini",
        prompt: "-flag-like prompt",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      // 1. Unreadable ps table must NOT mark the running turn dead!
      tableUnreadable = true;
      host.reconcileRunningTurns();
      expect(host.getThread("alex", started.thread.id)?.running).toBe(true);
      // Split-secret across two text_deltas is redacted on whole accumulated text!
      expect(host.getThread("alex", started.thread.id)?.turns[0]?.assistantText).not.toContain("sk-ant-api03");

      // 2. Partial line without '\n' was NOT consumed in byte_offset; finish writing it and verify recovery.
      tableUnreadable = false;
      appendFileSync(capturedLogPath, `999","status":"SUCCESS","response":"Done cleanly."}}\n`);
      host.reconcileRunningTurns();
      expect(host.getThread("alex", started.thread.id)?.thread.providerSessionId).toBe("conv-999");

      // 3. Start a second turn that ignores SIGTERM -> stopThread enters stopping state, deleteThread refuses 409,
      //    and after stopGraceMs elapses reconcileRunningTurns escalates to SIGKILL and settles!
      const second = host.sendMessage({
        owner: "alex",
        threadId: started.thread.id,
        requestId: "7".repeat(32),
        prompt: "Long running task",
      });
      expect(second.ok).toBe(true);
      const stopRes = host.stopThread("alex", started.thread.id);
      expect(stopRes).toEqual({ ok: true, stopped: false, stopping: true });
      expect(signalsSent.some(s => s.sig === "SIGTERM")).toBe(true);

      const delBlocked = host.deleteThread({ owner: "alex", threadId: started.thread.id, discardChanges: true });
      expect(delBlocked.ok).toBe(false);
      if (!delBlocked.ok) expect(delBlocked.code).toBe("turn_stopping");

      // Advance clock past stopGraceMs -> SIGKILL sent, process dies, next reconcile settles turn as stopped!
      nowMs += 6_000;
      host.reconcileRunningTurns();
      expect(signalsSent.some(s => s.sig === "SIGKILL")).toBe(true);
      host.reconcileRunningTurns();
      expect(host.getThread("alex", started.thread.id)?.running).toBe(false);
      expect(host.getThread("alex", started.thread.id)?.turns.at(-1)?.status).toBe("stopped");

      // 4. Verify CLI prompt flag safety, Claude partial streaming flag, & Codex resume sandbox flags.
      const claudeCmd = buildProviderCommand({ provider: "claude", modelId: "opus", prompt: "--danger", sessionId: null });
      expect(claudeCmd).toContain("--include-partial-messages");
      expect(claudeCmd.slice(-2)).toEqual(["--", "--danger"]);
      const codexResume = buildProviderCommand({ provider: "codex", modelId: "gpt-5.4", prompt: "-foo", sessionId: "thr_1" });
      expect(codexResume).toContain("resume");
      expect(codexResume).toContain('sandbox_mode="workspace-write"');
      expect(codexResume).toContain('approval_policy="never"');
      expect(codexResume.slice(-2)).toEqual(["--", "-foo"]);

      // 5. Missing startIdentity escape hatch: if startIdentity was null at spawn and the PID is still
      //    present in ps (e.g. PID reuse), Stop never blindly signals the PID, and once stopGraceMs elapses
      //    reconcileRunningTurns settles it as interrupted so the chat isn't permanently wedged!
      const missingIdHost = new DirectChatHost(store, {
        stateRoot,
        now: () => new Date(nowMs),
        custody: stubbornCustody,
        bootId: () => "boot-1",
        stopGraceMs: 5_000,
        locateBinary: () => "/fake/claude",
        spawnTurn: input => {
          mkdirSync(dirname(input.logPath), { recursive: true });
          writeFileSync(input.logPath, "", { mode: 0o600 });
          rows.set(9911, { pid: 9911, ppid: 1, pgid: 9911, uid: 501, start: "reused-pid", zombie: false });
          return { pid: 9911, pgid: 9911, startIdentity: null };
        },
      });
      const third = missingIdHost.sendMessage({
        owner: "alex",
        threadId: started.thread.id,
        requestId: "6".repeat(32),
        prompt: "Missing start identity turn",
      });
      expect(third.ok).toBe(true);
      const beforeSignals = signalsSent.length;
      const stopUnknown = missingIdHost.stopThread("alex", started.thread.id);
      expect(stopUnknown).toEqual({ ok: true, stopped: false, stopping: true });
      // Must NOT signal unproven PID 9911!
      expect(signalsSent).toHaveLength(beforeSignals);
      nowMs += 6_000;
      missingIdHost.reconcileRunningTurns();
      expect(signalsSent).toHaveLength(beforeSignals);
      expect(missingIdHost.getThread("alex", started.thread.id)?.running).toBe(false);
      expect(missingIdHost.getThread("alex", started.thread.id)?.turns.at(-1)?.status).toBe("interrupted");
      missingIdHost.close();
    } finally {
      host.close();
      store.close();
    }
  });

  test("Claude stream_event partial deltas stream token-by-token, surface tool_use early, and reset cleanly across steps", async () => {
    const root = tempDir("dc-stream-");
    const repo = makeTempRepo(root, "stream-repo");
    const store = openStore(join(root, "state.db"));
    const stateRoot = join(root, "state");
    const custody = new FakeCustody();
    let turnLogPath = "";

    const host = new DirectChatHost(store, {
      stateRoot,
      custody,
      bootId: () => "boot-1",
      locateBinary: () => "/fake/claude",
      spawnTurn: input => {
        turnLogPath = input.logPath;
        mkdirSync(dirname(input.logPath), { recursive: true });
        writeFileSync(input.logPath, "", { mode: 0o600 });
        custody.add(7701, 7701, "start-stream");
        return { pid: 7701, pgid: 7701, startIdentity: "start-stream" };
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
        modelId: "opus",
        prompt: "Review the site",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      // Step 1 streams text deltas and starts a tool_use before the full assistant block arrives.
      appendFileSync(
        turnLogPath,
        [
          JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } }),
          JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Let me " } } }),
          JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "check." } } }),
          JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "Read" } } }),
          // Subagent stream_event must be ignored.
          JSON.stringify({ type: "stream_event", parent_tool_use_id: "sub_9", event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } } }),
        ].join("\n") + "\n",
      );
      host.drainRunningTurnLogs();
      let detail = host.getThread("alex", started.thread.id)!;
      expect(detail.turns[0]?.assistantText).toBe("Let me check.");
      expect(detail.turns[0]?.tools).toHaveLength(1);
      expect(detail.turns[0]?.tools[0]).toMatchObject({ id: "toolu_1", name: "Read", status: "running" });

      // Tool input arrives on full assistant block, then tool completes, then step 2 streams final markdown.
      appendFileSync(
        turnLogPath,
        [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } }] } }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false }] } }),
          JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } }),
        ].join("\n") + "\n",
      );
      host.drainRunningTurnLogs();
      detail = host.getThread("alex", started.thread.id)!;
      // Still keeps prior text until first delta of step 2 arrives (no blank flash!).
      expect(detail.turns[0]?.assistantText).toBe("Let me check.");
      expect(detail.turns[0]?.tools[0]).toMatchObject({ id: "toolu_1", detail: "README.md", status: "done" });

      // Now step 2 streams markdown line-by-line!
      appendFileSync(
        turnLogPath,
        [
          JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "## Summary\n\n" } } }),
          JSON.stringify({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "- Looks great!" } } }),
        ].join("\n") + "\n",
      );
      host.drainRunningTurnLogs();
      detail = host.getThread("alex", started.thread.id)!;
      expect(detail.turns[0]?.assistantText).toBe("## Summary\n\n- Looks great!");
    } finally {
      host.close();
      store.close();
    }
  });
});

function makeRepoSimple(root: string): string {
  return makeTempRepo(root, "hardening-repo");
}
