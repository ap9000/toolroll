/**
 * The agent fence: Toolroll's own secrets (the state folder beside the
 * database, except the build's worktree, and ~/.standing-orders) are out of
 * every agent's reach. What it covers, how each provider receives it, and —
 * on macOS — that the sandbox really refuses a read from a child process.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { agentFence, claudeFenceSettings, codexFenceArgv, linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenced, macosFenceProfile, taskBoundary } from "./agent-fence.js";
import { adapterFor } from "./provider.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";
import { run, runStreamJsonl } from "./exec.js";

const T0 = new Date("2026-09-23T12:00:00.000Z");

describe("the agent fence", () => {
  let dir: string, state: string, home: string, worktree: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-")));
    state = join(dir, "standing-orders");
    home = join(dir, "home");
    worktree = join(state, "worktrees", "app", "task-1");
    for (const path of [state, home, worktree, join(state, "evidence", "12"), join(state, "backups"), join(home, ".standing-orders", "keys")]) mkdirSync(path, { recursive: true });
    for (const [file, text] of [["orders.db", "db"], ["orders.db-wal", "wal"], ["up-login.txt", "name: alex\npassword: canary-login"], ["runner-token", "t"], ["repos.json", "[]"]] as const) writeFileSync(join(state, file), text);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("covers everything in the state folder but the worktree's own folder, the database with its journal, and ~/.standing-orders; never the worktree", () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    expect(fence).toEqual([
      join(home, ".standing-orders"),
      join(state, "backups"), join(state, "evidence"), join(state, "orders.db"), join(state, "orders.db-wal"),
      join(state, "repos.json"), join(state, "runner-token"), join(state, "up-login.txt"),
    ].sort());
    expect(fence.some(path => worktree.startsWith(path))).toBe(false);
    // A repository in the folder — the build's own, named by its worktree's git metadata, or any other — is work, never fenced.
    mkdirSync(join(state, "repo", ".git", "worktrees", "task-1"), { recursive: true });
    mkdirSync(join(state, "other-project", ".git"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(state, "repo", ".git", "worktrees", "task-1")}\n`);
    const withRepos = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    expect(withRepos).toEqual(fence);
    // A database in a shared folder (a repository): only it and secret-looking entries.
    const shared = join(dir, "repo");
    mkdirSync(join(shared, ".git"), { recursive: true });
    for (const file of ["orders.db", "up-login.txt", "package.json", "deploy.token"]) writeFileSync(join(shared, file), "x");
    expect(agentFence({ databaseFile: join(shared, "orders.db"), worktree: null, home })).toEqual([join(home, ".standing-orders"), join(shared, "deploy.token"), join(shared, "orders.db"), join(shared, "up-login.txt")].sort());
    // No database file: only ~/.standing-orders.
    expect(agentFence({ databaseFile: null, worktree: null, home })).toEqual([join(home, ".standing-orders")]);
  });

  describe("a build's task boundary", () => {
    let projects: string, main: string, tree: string;
    beforeEach(() => {
      // A project beside others, its worktree under the state folder beside another task's.
      projects = join(dir, "Developer");
      main = join(projects, "app");
      tree = join(state, "worktrees", "app", "task-1");
      for (const path of [join(main, ".git", "worktrees", "task-1"), join(main, ".git", "worktrees", "task-2"), join(main, "src"), join(projects, "other", ".git"), join(projects, "notes"), join(state, "worktrees", "app", "task-2"),
        join(home, ".ssh"), join(home, ".claude"), join(home, ".codex"), join(home, ".config", "gh")]) mkdirSync(path, { recursive: true });
      writeFileSync(join(tree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "task-1")}\n`);
      writeFileSync(join(state, "worktrees", "app", "task-2", ".git"), `gitdir: ${join(main, ".git", "worktrees", "task-2")}\n`);
      for (const file of [join(main, "package.json"), join(home, ".claude.json"), join(home, ".npmrc"), join(home, ".codex", "auth.json"), join(home, ".claude", "settings.json")]) writeFileSync(file, "{}");
    });

    test("other repositories, other tasks' worktrees, the primary checkout (all but .git) and home configuration; never the task's own folder or its git", () => {
      const claude = taskBoundary({ worktree: tree, provider: "claude", home });
      expect(claude.shell).toEqual([
        join(home, ".codex"), join(home, ".config", "gh"), join(home, ".ssh"),
        join(main, "package.json"), join(main, "src"), join(projects, "other"), join(state, "worktrees", "app", "task-2"),
        join(main, ".git", "worktrees", "task-2"),
      ].sort());
      // Claude's CLI reads its own home to sign in and resume, so the OS fence leaves it; its file tools still refuse the sensitive files.
      expect(claude.fileTools).toEqual([join(home, ".claude", "settings.json"), join(home, ".claude.json"), join(home, ".npmrc")].sort());
      // Codex fences only its agent's commands, so its own home is fenced too: its CLI still signs in from outside the sandbox.
      const codex = taskBoundary({ worktree: tree, provider: "codex", home });
      expect(codex.shell).toEqual(expect.arrayContaining([join(home, ".codex"), join(home, ".claude"), join(home, ".claude.json"), join(projects, "other")]));
      expect(codex.fileTools).toEqual([]);
      for (const boundary of [claude, codex]) {
        for (const kept of [tree, join(main, ".git"), main, join(projects, "notes"), projects, home]) expect(boundary.shell).not.toContain(kept);
      }
      // The fence holds the boundary, and still never the worktree or anything above it.
      const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree: tree, home, boundary: claude });
      expect(fence).toEqual(expect.arrayContaining(claude.shell));
      expect(fence.some(path => tree === path || tree.startsWith(path + "/"))).toBe(false);
    });

    test("home repository siblings and hidden toolchain clones stay usable; adjacent projects elsewhere stay fenced", () => {
      for (const name of [".nvm", ".oh-my-zsh", "ordinary-project"]) mkdirSync(join(home, name, ".git"), { recursive: true });
      mkdirSync(join(projects, ".hidden-toolchain", ".git"), { recursive: true });
      const homeRepo = join(home, "app");
      mkdirSync(join(homeRepo, ".git", "worktrees", "task-1"), { recursive: true });
      for (const checkout of [homeRepo, tree]) {
        writeFileSync(join(tree, ".git"), `gitdir: ${join(homeRepo, ".git", "worktrees", "task-1")}\n`);
        const boundary = taskBoundary({ worktree: checkout, provider: "claude", home });
        for (const name of [".nvm", ".oh-my-zsh", "ordinary-project"]) expect(boundary.shell).not.toContain(join(home, name));
        expect(boundary.shell).toContain(join(home, ".ssh"));
      }
      writeFileSync(join(tree, ".git"), `gitdir: ${relative(tree, join(main, ".git", "worktrees", "task-1"))}\n`);
      const boundary = taskBoundary({ worktree: tree, provider: "claude", home });
      expect(boundary.shell).not.toContain(join(projects, ".hidden-toolchain"));
      expect(boundary.shell).toContain(join(projects, "other"));
      expect(boundary.shell).toContain(join(main, ".git", "worktrees", "task-2"));
      expect(boundary.shell).not.toContain(join(main, ".git", "worktrees", "task-1"));
    });

    test.skipIf(!macosFenceAvailable())("on macOS a build's shell can't read an adjacent repository or home configuration, and still reads and writes its own worktree", () => {
      writeFileSync(join(projects, "other", "secret.txt"), "adjacent");
      writeFileSync(join(home, ".ssh", "id_canary"), "key");
      writeFileSync(join(tree, "mine.txt"), "mine");
      const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree: tree, home, boundary: taskBoundary({ worktree: tree, provider: "claude", home }) });
      const script = `const fs=require("fs");const out=[];for(const f of process.argv.slice(1)){try{out.push(fs.readFileSync(f,"utf8").trim())}catch(e){out.push(e.code)}}try{fs.writeFileSync(${JSON.stringify(join(projects, "other", "x.txt"))},"x");out.push("wrote-adjacent")}catch(e){out.push(e.code)}console.log(out.join(" "))`;
      const { file, args } = macosFenced(process.execPath, ["-e", script, join(projects, "other", "secret.txt"), join(home, ".ssh", "id_canary"), join(tree, "mine.txt"), join(home, ".claude.json")], fence);
      expect(spawnSync(file, args, { encoding: "utf8" }).stdout.trim()).toBe("EPERM EPERM mine {} EPERM");

      // Real Git reproducer: an inaccessible sibling checkout looks prunable.
      // Its metadata must survive prune while this task can still use its index.
      const repo = join(projects, "prune-repro");
      const active = join(dir, "prune-tasks", "active");
      const other = join(dir, "prune-tasks", "other");
      mkdirSync(repo);
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      };
      git("init", "-q");
      git("-c", "user.name=Fence test", "-c", "user.email=fence@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
      git("worktree", "add", "-qb", "active", active);
      git("worktree", "add", "-qb", "other", other);
      const metadata = join(repo, ".git", "worktrees", "other");
      const before = readFileSync(join(metadata, "HEAD"), "utf8");
      const boundary = taskBoundary({ worktree: active, provider: "claude", home });
      const prune = (paths: string[]) => {
        const cmd = macosFenced("/usr/bin/git", ["worktree", "prune", "--expire=now", "--verbose"], paths);
        return spawnSync(cmd.file, cmd.args, { cwd: active, encoding: "utf8" });
      };
      prune(boundary.shell);
      expect(readFileSync(join(metadata, "HEAD"), "utf8")).toBe(before);
      writeFileSync(join(active, "mine.txt"), "mine");
      const add = macosFenced("/usr/bin/git", ["add", "mine.txt"], boundary.shell);
      expect(spawnSync(add.file, add.args, { cwd: active, encoding: "utf8" }).status).toBe(0);
      // Control: the previous checkout-only fence really deletes the sibling metadata.
      expect(prune(boundary.shell.filter(path => path !== metadata)).status).toBe(0);
      expect(existsSync(metadata)).toBe(false);
    });
  });

  test("Codex gets its own sandbox with the fence denied (Auto keeps the workspace profile; Full access widens it, never unsandboxed); Claude's file tools get deny rules", () => {
    const fence = ["/s/up-login.txt", "/h/.standing-orders"];
    expect(codexFenceArgv(fence, false)).toEqual(["-c", 'default_permissions="standing-orders"', "-c", 'permissions.standing-orders.extends=":workspace"', "-c", 'permissions.standing-orders.filesystem={"/s/up-login.txt"="deny","/h/.standing-orders"="deny"}']);
    expect(codexFenceArgv(fence, true)).toEqual(["-c", 'default_permissions="standing-orders"', "-c", 'permissions.standing-orders.extends=":workspace"', "-c", 'permissions.standing-orders.filesystem={"/"="write","/s/up-login.txt"="deny","/h/.standing-orders"="deny"}', "-c", "permissions.standing-orders.network.enabled=true", "-c", 'approval_policy="never"']);
    const base = { phase: "build" as const, brief: "go", model: null, maxTurns: 5, permissionMode: "auto", resumeSession: null, fence };
    for (const skipPermissions of [false, true]) {
      const argv = adapterFor("codex").argv({ ...base, skipPermissions });
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain("--sandbox");
      expect(argv).toContain('default_permissions="standing-orders"');
    }
    // A resumed Codex turn keeps the same fence.
    expect(adapterFor("codex").argv({ ...base, skipPermissions: false, resumeSession: "thread-1" })).toContain('default_permissions="standing-orders"');
    // A review keeps its own isolation, fence or not.
    expect(adapterFor("codex").argv({ ...base, phase: "review", skipPermissions: false })).toContain("--ignore-user-config");
    const claude = adapterFor("claude").argv({ ...base, skipPermissions: true });
    const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual(["Read(//s/up-login.txt)", "Read(//s/up-login.txt/**)", "Edit(//s/up-login.txt)", "Edit(//s/up-login.txt/**)", "Read(//h/.standing-orders)", "Read(//h/.standing-orders/**)", "Edit(//h/.standing-orders)", "Edit(//h/.standing-orders/**)"]);
    expect(JSON.parse(claudeFenceSettings([]))).toEqual({ permissions: { deny: [] } });
    expect(macosFenceProfile(['/a "quoted"/x'])).toContain('(subpath "/a \\"quoted\\"/x")');
  });

  test.skipIf(!macosFenceAvailable())("on macOS the sandbox refuses a fenced read from any child process, while the worktree, other writes and the network stay open", () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    const script = `const fs=require("fs");const out=[];for(const f of process.argv.slice(1)){try{out.push(fs.readFileSync(f,"utf8").trim())}catch(e){out.push(e.code)}}try{fs.writeFileSync(${JSON.stringify(join(worktree, "made.txt"))},"ok");out.push("wrote-worktree")}catch(e){out.push(e.code)}try{fs.writeFileSync(${JSON.stringify(join(dir, "elsewhere.txt"))},"ok");out.push("wrote-elsewhere")}catch(e){out.push(e.code)}console.log(out.join(" "))`;
    const { file, args } = macosFenced(process.execPath, ["-e", script, join(state, "up-login.txt"), join(home, ".standing-orders", "keys"), join(state, "evidence", "12")], fence);
    const result = spawnSync(file, args, { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("EPERM EPERM EPERM wrote-worktree wrote-elsewhere");
    expect(readFileSync(join(worktree, "made.txt"), "utf8")).toBe("ok");
  });

  test.skipIf(!macosFenceAvailable())("the spawn road every provider transport uses applies the fence to the real process: buffered and streaming", async () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    // The child writes what it could read into the worktree (always reachable).
    const outcome = join(worktree, "outcome.txt");
    const script = `const fs=require("fs");let r;try{r=fs.readFileSync(${JSON.stringify(join(state, "up-login.txt"))},"utf8")}catch(e){r=e.code}fs.writeFileSync(${JSON.stringify(outcome)},r)`;
    await run(process.execPath, ["-e", script], { processGroup: true, fence });
    expect(readFileSync(outcome, "utf8")).toBe("EPERM");
    await runStreamJsonl(process.execPath, ["-e", script], { processGroup: true, fence });
    expect(readFileSync(outcome, "utf8")).toBe("EPERM");
    // Without a fence the same spawn reads it: the test would catch a no-op fence.
    await run(process.execPath, ["-e", script], { processGroup: true });
    expect(readFileSync(outcome, "utf8")).toContain("canary-login");
  });

  describe("through the gateway", () => {
    test("a fresh build and its resumed repair get the same setup: no settings sources, strict MCP, the task boundary, and the user's own sign-in", async () => {
      mkdirSync(join(state, "worktrees", "app", "task-2", ".git"), { recursive: true });
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(home, ".claude.json"), "{}");
      const local = openStore(join(state, "orders.db.boundary"));
      try {
        register(local, { name: "builder-1", host: "test", capacity: 9, repos: [dir], now: T0, newToken: () => "tok" });
        local.createTask({ id: "t-bound", title: "t-bound" }, T0);
        const ref = local.refFor("built-in", "t-bound").id;
        local.placeTask(ref, dir);
        const took = acquire(local, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => "lease-bound", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
        if (!took.ok) throw new Error("claim");
        const launches: { args: readonly string[]; env: Record<string, string | undefined>; omit: readonly string[]; fence: readonly string[] }[] = [];
        const runner = async (_file: string, args: readonly string[], options?: { env?: Record<string, string | undefined>; omitEnv?: readonly string[]; fence?: readonly string[]; onSessionId?: (id: string) => void }) => {
          launches.push({ args, env: options?.env ?? {}, omit: options?.omitEnv ?? [], fence: options?.fence ?? [] });
          options?.onSessionId?.("session-1");
          return { ...OK, stdout: JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }) + "\n" + JSON.stringify({ type: "result", subtype: "success", session_id: "session-1", result: "done" }) + "\n" };
        };
        for (const resumeSession of [null, "session-1"]) {
          const id = local.startRun({ taskRef: ref, leaseId: "lease-bound", runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
          if (resumeSession !== null) local.stampRun(id, { sessionId: resumeSession });
          await invokeAgent(local, id, { provider: "claude", model: null }, { phase: resumeSession === null ? "build" : "repair", brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: true, resumeSession }, { keyHome: home, clock: () => T0, cwd: worktree, runner: runner as never });
          local.finishRun(id, { outcome: "built", now: T0 });
        }
        expect(launches).toHaveLength(2);
        for (const launch of launches) {
          expect(launch.args[launch.args.indexOf("--setting-sources") + 1]).toBe("");
          expect(launch.args).toContain("--strict-mcp-config");
          expect(launch.args[launch.args.indexOf("--add-dir") + 1]).toBe(worktree);
          expect(launch.env["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"]).toBe("1");
          // Its own login: no key handed over, no home moved, and the subscription's own key shed.
          for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME"]) expect(launch.env[name]).toBeUndefined();
          expect(launch.omit).toContain("ANTHROPIC_API_KEY");
          const deny = (JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;
          expect(deny).toEqual(expect.arrayContaining([`Read(/${join(home, ".claude.json")})`, `Read(/${join(home, ".ssh")}/**)`, `Edit(/${join(state, "worktrees", "app", "task-2")}/**)`]));
          if (macosFenceAvailable()) expect(launch.fence).toEqual(expect.arrayContaining([join(home, ".ssh"), join(state, "worktrees", "app", "task-2")]));
        }
        expect(launches[1]!.args).toContain("--resume");
      } finally {
        local.close();
      }
    });

    let store: Store;
    beforeEach(() => {
      store = openStore(join(state, "orders.db.live"));
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [dir], now: T0, newToken: () => "tok" });
    });
    afterEach(() => store.close());
    const open = (id: string, provider: "claude" | "codex"): number => {
      store.createTask({ id, title: id }, T0);
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, dir);
      const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => `lease-${id}`, ttlMs: 10 * 365 * 24 * 3600 * 1000 });
      if (!took.ok) throw new Error("claim");
      return store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider, model: null, chosen: "legacy" }, now: T0 });
    };
    const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

    test("every build is launched fenced and the run says how", async () => {
      const seen: { file: string; args: readonly string[] }[] = [];
      const ask = { phase: "build" as const, brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: true, resumeSession: null };
      const codexRun = open("t-codex", "codex");
      await invokeAgent(store, codexRun, { provider: "codex", model: null }, ask, { keyHome: home, clock: () => T0, runner: async (file, args) => { seen.push({ file, args }); return OK; } });
      const codex = seen.at(-1)!;
      expect(codex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      const filesystem = codex.args.find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
      expect(filesystem).toContain(`"${join(state, "up-login.txt")}"="deny"`);
      expect(filesystem).toContain(`"${join(home, ".standing-orders")}"="deny"`);
      expect(filesystem).not.toContain(`"${join(state, "worktrees")}"`);
      expect(store.runFence(codexRun)).toEqual({ method: "codex-profile", paths: expect.any(Number) });
      const claudeRun = open("t-claude", "claude");
      let wrap: readonly string[] | undefined;
      await invokeAgent(store, claudeRun, { provider: "claude", model: null }, ask, { keyHome: home, clock: () => T0, runner: async (file, args, options) => { seen.push({ file, args }); wrap = options?.fence; return OK; } });
      const claude = seen.at(-1)!;
      // The provider's own argv is unchanged; the spawn road applies the sandbox.
      expect(claude.file).toBe("claude");
      expect(claude.args).toContain("--settings");
      expect(claude.args[claude.args.indexOf("--add-dir") + 1]).toBe(worktree);
      if (macosFenceAvailable()) {
        expect(wrap).toContain(join(state, "up-login.txt"));
        expect(store.runFence(claudeRun)).toEqual({ method: "macos-sandbox", paths: expect.any(Number) });
      } else {
        expect(store.runFence(claudeRun)).toEqual({ method: "claude-rules", paths: expect.any(Number) });
      }
    });
  });
});

describe("the Linux fence (v88)", () => {
  test("bubblewrap masks each fenced folder with an empty one and each fenced file with /dev/null, around the agent itself", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-linux-fence-")));
    try {
      const folder = join(root, "keys"), file = join(root, "up-login.txt");
      mkdirSync(folder);
      writeFileSync(file, "alex secret");
      expect(linuxFenced("claude", ["-p", "hi"], [folder, file])).toEqual({ file: "bwrap", args: ["--dev-bind", "/", "/", "--tmpfs", folder, "--ro-bind", "/dev/null", file, "--die-with-parent", "--", "claude", "-p", "hi"] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("it is used only on Linux, and only where bubblewrap actually runs", () => {
    expect(linuxFenceAvailable("darwin", () => true)).toBe(false);
    expect(linuxFenceAvailable("win32", () => true)).toBe(false);
  });
});

describe("the macOS fence inside another sandbox", () => {
  test.runIf(process.platform === "darwin")("a process already fenced (a flow's check zone running end-to-end journeys) doesn't nest it; any other probe failure keeps it on", () => {
    expect(macosFenceAvailable("darwin", () => ({ status: 0, stderr: "" }))).toBe(true);
    expect(macosFenceAvailable("darwin", () => ({ status: 71, stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n" }))).toBe(false);
    expect(macosFenceAvailable("darwin", () => ({ status: null, stderr: "" }))).toBe(true);
    expect(macosFenceAvailable("darwin", () => { throw new Error("spawn EAGAIN"); })).toBe(true);
    expect(macosFenceAvailable("linux", () => ({ status: 0, stderr: "" }))).toBe(false);
  });
});
