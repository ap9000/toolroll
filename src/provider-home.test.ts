/**
 * What a build keeps of the provider's own home: a no-model build's model
 * choices, and a Codex build's own CODEX_HOME that links (never copies) the
 * operator's sign-in and sessions and holds nothing else — fenced from the
 * agent, removed after the run, fresh and resumed alike.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDefaults, codexDefaults, isolatedCodexHome } from "./provider-home.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";

const T0 = new Date("2026-10-12T12:00:00.000Z");

describe("what a build keeps of the provider's own home", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-provider-home-"))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a no-model build reads only the operator's model, Claude's always-on thinking and Codex's effort (a selected profile's first)", () => {
    const claude = join(dir, ".claude");
    mkdirSync(claude);
    expect(claudeDefaults(claude)).toEqual({});
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ model: "opus", alwaysThinkingEnabled: true, hooks: { SessionStart: [] }, enabledPlugins: { x: true } }));
    expect(claudeDefaults(claude)).toEqual({ model: "opus", alwaysThinking: true });
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ model: "--dangerously-skip-permissions", alwaysThinkingEnabled: "yes" }));
    expect(claudeDefaults(claude)).toEqual({});
    writeFileSync(join(claude, "settings.json"), "not json");
    expect(claudeDefaults(claude)).toEqual({});

    const codex = join(dir, ".codex");
    mkdirSync(codex);
    expect(codexDefaults(codex)).toEqual({});
    writeFileSync(join(codex, "config.toml"), ['model = "gpt-5.6-sol"', 'model_reasoning_effort = "high" # mine', "", "[mcp_servers.x]", 'command = "x"', 'model = "not-this"'].join("\n"));
    expect(codexDefaults(codex)).toEqual({ model: "gpt-5.6-sol", effort: "high" });
    writeFileSync(join(codex, "config.toml"), ['profile = "deep"', 'model = "gpt-5.6-sol"', 'model_reasoning_effort = "low"', "[profiles.deep]", 'model_reasoning_effort = "xhigh"'].join("\n"));
    expect(codexDefaults(codex)).toEqual({ model: "gpt-5.6-sol", effort: "xhigh" });
    writeFileSync(join(codex, "config.toml"), 'model_reasoning_effort = "high\\"; rm -rf"');
    expect(codexDefaults(codex)).toEqual({});
  });

  test("a Codex build's own home links the sign-in and sessions, holds no skills or AGENTS.md, and its removal leaves the originals", () => {
    const source = join(dir, ".codex");
    mkdirSync(join(source, "skills", "mine"), { recursive: true });
    writeFileSync(join(source, "auth.json"), "{}");
    writeFileSync(join(source, "AGENTS.md"), "Always do this.");
    writeFileSync(join(source, "config.toml"), 'model = "x"');
    const home = isolatedCodexHome(source, dir);
    expect(readdirSync(home.dir).sort()).toEqual(["auth.json", "sessions"]);
    expect(lstatSync(join(home.dir, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home.dir, "auth.json"))).toBe(join(source, "auth.json"));
    expect(readlinkSync(join(home.dir, "sessions"))).toBe(join(source, "sessions"));
    // Sessions written through the link are the operator's: a resumed build finds them.
    writeFileSync(join(home.dir, "sessions", "rollout-1.jsonl"), "{}");
    home.cleanup();
    expect(existsSync(home.dir)).toBe(false);
    expect(readdirSync(join(source, "sessions"))).toEqual(["rollout-1.jsonl"]);
    expect(existsSync(join(source, "auth.json"))).toBe(true);
    // No sign-in yet (an API-key build): nothing to link, and nothing copied.
    const bare = isolatedCodexHome(join(dir, "fresh"), dir);
    expect(readdirSync(bare.dir)).toEqual(["sessions"]);
    bare.cleanup();
  });

  test("failed home setup removes the partial private directory", () => {
    const source = join(dir, "source");
    mkdirSync(source);
    writeFileSync(join(source, "sessions"), "not a directory");
    expect(() => isolatedCodexHome(source, dir)).toThrow();
    expect(readdirSync(dir)).toEqual(["source"]);
  });

  describe("through the gateway", () => {
    let store: Store, home: string, worktree: string;
    beforeEach(() => {
      home = join(dir, "home");
      worktree = join(dir, "standing-orders", "worktrees", "app", "task");
      mkdirSync(join(home, ".codex", "skills"), { recursive: true });
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(home, ".codex", "auth.json"), "{}");
      writeFileSync(join(home, ".codex", "AGENTS.md"), "Global instructions");
      writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');
      store = openStore(join(dir, "standing-orders", "orders.db"));
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [dir], now: T0, newToken: () => "tok" });
    });
    afterEach(() => store.close());

    test.each([null, "thread-1"])("private home failure refuses before spawn and leaves no started stamp (resume %s)", async resumeSession => {
      store.createTask({ id: "home-failure", title: "home-failure" }, T0);
      const ref = store.refFor("built-in", "home-failure").id;
      store.placeTask(ref, dir);
      const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-failure", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
      if (!took.ok) throw new Error("claim");
      const id = store.startRun({ taskRef: ref, leaseId: "lease-failure", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "codex", model: null, chosen: "legacy" }, now: T0 });
      if (resumeSession !== null) store.stampRun(id, { sessionId: resumeSession });
      writeFileSync(join(home, ".codex", "sessions"), "not a directory");
      let spawned = false;
      const result = await invokeAgent(store, id, { provider: "codex", model: null }, { phase: resumeSession === null ? "build" : "repair", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession }, {
        keyHome: home, env: { CODEX_HOME: join(home, ".codex") }, clock: () => T0, cwd: worktree,
        runner: async () => { spawned = true; throw new Error("must not spawn"); },
      });
      expect(result).toMatchObject({ kind: "refused", reason: "containment", diagnostic: expect.stringContaining("private Codex home") });
      expect(spawned).toBe(false);
      expect(store.getRun(id)?.providerStartedAt).toBeNull();
    });

    test("each Codex launch, fresh or resumed, gets its own fenced CODEX_HOME and the operator's model and effort, removed when it ends", async () => {
      store.createTask({ id: "t-codex", title: "t-codex" }, T0);
      const ref = store.refFor("built-in", "t-codex").id;
      store.placeTask(ref, dir);
      const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-codex", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
      if (!took.ok) throw new Error("claim");
      const seen: { home: string; contents: string[]; args: readonly string[] }[] = [];
      const runner = async (_file: string, args: readonly string[], options?: { env?: Record<string, string | undefined>; onSessionId?: (id: string) => void }) => {
        const codexHome = options?.env?.["CODEX_HOME"] ?? "";
        seen.push({ home: codexHome, contents: readdirSync(codexHome).sort(), args });
        options?.onSessionId?.("thread-1");
        return { code: 0, stderr: "", timedOut: false, notFound: false, stdout: `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n` };
      };
      for (const resumeSession of [null, "thread-1"]) {
        const id = store.startRun({ taskRef: ref, leaseId: "lease-codex", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "codex", model: null, chosen: "legacy" }, now: T0 });
        if (resumeSession !== null) store.stampRun(id, { sessionId: resumeSession });
        await invokeAgent(store, id, { provider: "codex", model: null }, { phase: resumeSession === null ? "build" : "repair", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: false, resumeSession }, { keyHome: home, clock: () => T0, cwd: worktree, runner: runner as never });
        store.finishRun(id, { outcome: "built", now: T0 });
      }
      expect(seen).toHaveLength(2);
      expect(seen[0]!.home).not.toBe(seen[1]!.home);
      for (const launch of seen) {
        expect(launch.contents).toEqual(["auth.json", "sessions"]);
        expect(existsSync(launch.home)).toBe(false);
        const filesystem = launch.args.find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
        expect(filesystem).toContain(`"${realpathSync(join(launch.home, ".."))}/${launch.home.split("/").pop()}"="deny"`);
        expect(launch.args.join(" ")).toContain('-m gpt-5.6-sol -c model_reasoning_effort="high"');
      }
      expect(seen[1]!.args).toContain("resume");
    });
  });
});
