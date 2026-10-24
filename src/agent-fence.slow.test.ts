/**
 * The agent fence: Toolroll's own secrets (the state folder beside the
 * database, except the build's worktree, and ~/.standing-orders) are out of
 * every agent's reach. What it covers, how each provider receives it, and —
 * on macOS — that the sandbox really refuses a read from a child process.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { agentFence, checkoutPool, codexPool, trustedWorktreeBinding, HARDENED_GIT_ARGS, checkoutGitEnv, claudeFenceSettings, codexFenceArgv, fenceGrants, fencedGitEnv, flattened, linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenced, macosFenceProfile, MACOS_BASELINE, ownedAncestors, runFolders, taskBoundary } from "./agent-fence.js";

/** Every macOS profile's opening (deny by default, the baseline, the base read and write allows) and, with an open
 * network, its closing rules. */
const MACOS_HEAD = ["(version 1)", "(deny default)", ...MACOS_BASELINE, "(allow file-read*)", "(allow file-write*)", "(allow file-read-metadata (vnode-type DIRECTORY))"];
const MACOS_TAIL_OPEN = ["(allow network*)", "(deny appleevent-send)", "(deny lsopen)"];
import { adapterFor } from "./provider.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";
import { run, runStreamJsonl } from "./exec.js";
import { createHash } from "node:crypto";
import { symlinkSync } from "node:fs";
import { claudeToolArgs } from "./project-tools.js";
import { NOTES_SERVER } from "../test/notes-mcp-server.js";
import { poolRootOf } from "./worktree.js";
import { INSIDE_FENCE } from "../test/inside-fence.js";

// Observe the real spawn boundary without redefining Node's ESM exports.
vi.mock("node:child_process", { spy: true });

const T0 = new Date("2026-09-23T12:00:00.000Z");

// Parse the generated subset of TOML (quoted path = quoted access). Consume
// every entry and reject duplicates before constructing the lookup table.
function parseFilesystem(argv: string[]): Map<string, string> {
  const setting = argv.find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
  const table = setting.slice(setting.indexOf("=") + 1);
  expect(table.startsWith("{") && table.endsWith("}")).toBe(true);
  const entries = new Map<string, string>();
  const pair = /("(?:[^"\\]|\\["\\])*")=("(?:read|write|deny)")(,|(?=\}$))/y;
  let offset = 1;
  while (offset < table.length - 1) {
    pair.lastIndex = offset;
    const match = pair.exec(table);
    expect(match, `Invalid filesystem TOML at ${offset}`).not.toBeNull();
    const key = JSON.parse(match![1]!) as string;
    expect(entries.has(key), `Duplicate filesystem key: ${key}`).toBe(false);
    entries.set(key, JSON.parse(match![2]!) as string);
    offset = pair.lastIndex;
  }
  expect(offset).toBe(table.length - 1);
  return entries;
}

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

  function duplicateLaunch() {
    const tools = join(dir, "so-tools-own");
    const codexHome = join(dir, "so-codex-own");
    for (const path of [tools, codexHome]) mkdirSync(path);
    const alias = join(dir, "tools-alias");
    symlinkSync(tools, alias, "dir");
    const folders = runFolders(null, dir);
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home, runFolders: folders });
    expect(fence).toEqual(expect.arrayContaining([tools, codexHome]));
    return {
      tools, codexHome,
      fence: [...fence, tools, codexHome, alias, `${tools}/../so-tools-own`],
      grants: { readOnly: [tools, alias, codexHome], readable: [], lookup: [], runFolders: folders },
    };
  }

  test.each([false, true])("Codex filesystem TOML has unique resolved keys for repeated launch folders (full access: %s)", fullAccess => {
    const launch = duplicateLaunch();
    const entries = parseFilesystem(codexFenceArgv(launch.fence, fullAccess, launch.grants));
    expect(entries.get(launch.tools)).toBe("deny");
    expect(entries.get(launch.codexHome)).toBe("deny");
    expect(entries.has(join(dir, "tools-alias"))).toBe(false);
    expect(entries.get(join(state, "orders.db"))).toBe("deny");
    // Even the broad full-access grant must not duplicate or override a deny.
    expect(parseFilesystem(codexFenceArgv(["/", "/"], true)).get("/")).toBe("deny");
  });

  // The release check runs inside the plane's macOS fence, which can't nest a sandbox or observe other processes; CI
  // (Linux, and the tag's macOS jobs) runs these unfenced.
  test.skipIf(INSIDE_FENCE || spawnSync("codex", ["--version"], { encoding: "utf8" }).error?.message.includes("ENOENT"))(
    "installed Codex sandbox accepts duplicate-path launch policy, runs git, and denies the database",
    () => {
      const launch = duplicateLaunch();
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git("init", "-q");
      git("-c", "user.name=Fence test", "-c", "user.email=fence@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
      const head = git("rev-parse", "HEAD");
      const database = join(state, "orders.db");
      const command = 'git rev-parse HEAD || exit 10; if cat "$1" >/dev/null 2>&1; then exit 11; fi; echo database-denied';
      // Control proves the read assertion is sensitive to the fence.
      const control = spawnSync("/bin/sh", ["-c", command, "probe", database], { cwd: worktree, encoding: "utf8" });
      expect(control.status, control.stderr).toBe(11);
      for (const fullAccess of [false, true]) {
        const result = spawnSync("codex", ["sandbox", ...codexFenceArgv(launch.fence, fullAccess, launch.grants),
          "-P", "standing-orders", "--", "/bin/sh", "-c", command, "probe", database], {
          cwd: worktree, encoding: "utf8", env: { ...process.env, CODEX_HOME: launch.codexHome },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([head, "database-denied"]);
      }
    },
  );

  function linkedCheckout() {
    const main = join(dir, "projects", "main");
    mkdirSync(main, { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: main, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("-c", "user.name=Fence test", "-c", "user.email=fence@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    git("worktree", "add", "-qb", "task", worktree);
    symlinkSync(main, join(dir, "projects", "alias"), "dir");
    const sibling = join(dir, "projects", "sibling");
    mkdirSync(join(sibling, ".git"), { recursive: true });
    return { main, sibling, head: git("rev-parse", "HEAD") };
  }

  test("canonical siblings exclude aliases of main and preserve real repositories", () => {
    const { main, sibling } = linkedCheckout();
    const binding = trustedWorktreeBinding(main, worktree);
    const boundary = taskBoundary({ worktree, provider: "codex", home, binding });
    expect(boundary.shell).toContain(sibling);
    expect(boundary.shell).not.toContain(main);
    expect(boundary.shell).not.toContain(join(dir, "projects", "alias"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const gitdir = realpathSync(join(main, ".git", "worktrees", "task-1"));
      const fence = agentFence({ databaseFile: null, home, worktree, binding,
        boundary: { ...boundary, shell: [...boundary.shell, join(dir, "projects", "alias"), join(main, ".git"), gitdir] } });
      expect(fence).toContain(sibling);
      for (const path of [main, join(main, ".git"), gitdir]) {
        expect(fence).not.toContain(path);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(path));
      }
    } finally { warn.mockRestore(); }
  });

  test("hardened Git probes never execute checkout fsmonitor or index hooks", () => {
    const { main, head } = linkedCheckout();
    const marker = join(dir, "git-helper-ran");
    const monitor = join(dir, "monitor");
    const hook = join(main, ".git", "hooks", "post-index-change");
    for (const script of [monitor, hook]) {
      writeFileSync(script, `#!/bin/sh\necho fired >> '${marker}'\n`);
      chmodSync(script, 0o755);
    }
    expect(spawnSync("git", ["config", "core.fsmonitor", monitor], { cwd: main }).status).toBe(0);
    const env = checkoutGitEnv({ ...process.env, GIT_DIR: join(home, ".ssh"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: monitor });
    for (const args of [["rev-parse", "HEAD"], ["status", "--porcelain"]]) {
      const check = spawnSync("git", [...HARDENED_GIT_ARGS, ...args], { cwd: worktree, env, encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout.trim()).toBe(args[0] === "rev-parse" ? head : "");
    }
    expect(existsSync(marker)).toBe(false);
  });

  test.each(["ssh", "state", "database"])("a hostile %s pointer cannot remove protected denies", target => {
    const { main } = linkedCheckout();
    const binding = trustedWorktreeBinding(main, worktree);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(home, ".toolroll"), { recursive: true });
    const database = join(state, "orders.db");
    writeFileSync(database, "fixture");
    const hostile = target === "ssh" ? join(home, ".ssh", "x") : target === "state" ? join(home, ".toolroll", ".git", "worktrees", "x") : database;
    writeFileSync(join(worktree, ".git"), `gitdir: ${hostile}\n`);
    const boundary = taskBoundary({ worktree, provider: "codex", home, binding });
    const fence = agentFence({ databaseFile: database, worktree, home, boundary, binding });
    for (const denied of [join(home, ".ssh"), join(home, ".toolroll"), database]) expect(fence).toContain(denied);
    expect(() => trustedWorktreeBinding(main, worktree)).toThrow("The checkout's Git pointer was changed");
  });

  test.skipIf(!macosFenceAvailable())("generated Codex and Claude fences permit linked checkout Git commands", () => {
    const { main, sibling, head } = linkedCheckout();
    const binding = trustedWorktreeBinding(main, worktree);
    // Codex's half needs the Codex CLI (not on every macOS runner); Claude's runs wherever Seatbelt does.
    const codexInstalled = spawnSync("codex", ["--version"], { encoding: "utf8" }).error === undefined;
    for (const provider of codexInstalled ? ["claude", "codex"] : ["claude"]) {
      const boundary = taskBoundary({ worktree, provider, home, binding });
      const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home, boundary });
      const grants = fenceGrants({ databaseFile: null, worktree, boundary });
      expect(fence).toContain(sibling);
      for (const args of [["rev-parse", "HEAD"], ["status", "--porcelain"]]) {
        const wrapped = provider === "codex"
          ? { file: "codex", args: ["sandbox", ...codexFenceArgv(fence, false, grants), "-P", "standing-orders", "--", "git", ...HARDENED_GIT_ARGS, ...args] }
          : macosFenced("git", [...HARDENED_GIT_ARGS, ...args], fence, grants);
        const result = spawnSync(wrapped.file, wrapped.args, { cwd: worktree, encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(args[0] === "rev-parse" ? head : "");
      }
    }
  });

  test("Codex denies future tool and home folders by namespace, including descendants", () => {
    const folders = runFolders(null, dir);
    const argv = codexFenceArgv([], true, { readOnly: [], readable: [], lookup: [], runFolders: folders });
    const filesystem = argv.find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
    for (const prefix of ["so-tools-", "so-codex-", "so-net-"]) {
      expect(filesystem).toContain(`"${dir}/${prefix}*"="deny"`);
      expect(filesystem).toContain(`"${dir}/${prefix}*/**"="deny"`);
    }
    const later = join(dir, "so-tools-later");
    mkdirSync(later);
    writeFileSync(join(later, "mcp.json"), "synthetic launch config");
    expect(codexFenceArgv([], true, { readOnly: [], readable: [], lookup: [], runFolders: folders })).toEqual(argv);
  });

  test("covers everything in the state folder but the worktree's own folder, the database with its journal, and ~/.standing-orders; never the worktree", () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    expect(fence).toEqual([
      join(home, ".standing-orders"),
      join(state, "backups"), join(state, "bridge-secrets"), join(state, "evidence"), join(state, "orders.db"), join(state, "orders.db-wal"),
      join(state, "repos.json"), join(state, ".toolroll-run"), join(state, "runner-token"), join(state, "sign-in-copies"), join(state, "up-login.txt"),
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
    expect(agentFence({ databaseFile: join(shared, "orders.db"), worktree: null, home })).toEqual([join(home, ".standing-orders"), join(shared, "bridge-secrets"), join(shared, "deploy.token"), join(shared, "orders.db"), join(shared, "sign-in-copies"), join(shared, ".toolroll-run"), join(shared, "up-login.txt")].sort());
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
      const claude = taskBoundary({ binding: { main, gitdir: join(main, ".git", "worktrees", "task-1") }, worktree: tree, provider: "claude", home });
      expect(claude.shell).toEqual([
        join(home, ".codex"), join(home, ".config", "gh"), join(home, ".ssh"),
        join(main, "package.json"), join(main, "src"), join(projects, "other"), join(state, "worktrees", "app", "task-2"),
      ].sort());
      // Another task's git metadata is read, never written; the checkout it names is looked up, never read.
      expect(claude.readOnly).toEqual([join(main, ".git", "worktrees", "task-2")]);
      writeFileSync(join(main, ".git", "worktrees", "task-2", "gitdir"), `${join(state, "worktrees", "app", "task-2", ".git")}\n`);
      expect(taskBoundary({ binding: { main, gitdir: join(main, ".git", "worktrees", "task-1") }, worktree: tree, provider: "claude", home }).lookup).toEqual([join(state, "worktrees", "app", "task-2"), join(state, "worktrees", "app", "task-2", ".git")]);
      // Claude's CLI reads its own home to sign in and resume, so the OS fence leaves it; its file tools still refuse the sensitive files.
      expect(claude.fileTools).toEqual([join(home, ".claude", "settings.json"), join(home, ".claude.json"), join(home, ".npmrc")].sort());
      // Codex fences only its agent's commands, so its own home is fenced too: its CLI still signs in from outside the sandbox.
      const codex = taskBoundary({ binding: { main, gitdir: join(main, ".git", "worktrees", "task-1") }, worktree: tree, provider: "codex", home });
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
        const boundary = taskBoundary({ binding: { main: homeRepo, gitdir: join(homeRepo, ".git", "worktrees", "task-1") }, worktree: checkout, provider: "claude", home });
        for (const name of [".nvm", ".oh-my-zsh", "ordinary-project"]) expect(boundary.shell).not.toContain(join(home, name));
        expect(boundary.shell).toContain(join(home, ".ssh"));
      }
      writeFileSync(join(tree, ".git"), `gitdir: ${relative(tree, join(main, ".git", "worktrees", "task-1"))}\n`);
      const boundary = taskBoundary({ binding: { main, gitdir: join(main, ".git", "worktrees", "task-1") }, worktree: tree, provider: "claude", home });
      expect(boundary.shell).not.toContain(join(projects, ".hidden-toolchain"));
      expect(boundary.shell).toContain(join(projects, "other"));
      expect(boundary.readOnly).toContain(join(main, ".git", "worktrees", "task-2"));
      expect([...boundary.shell, ...boundary.readOnly]).not.toContain(join(main, ".git", "worktrees", "task-1"));
    });

    test.skipIf(!macosFenceAvailable())("on macOS a build's shell can't read an adjacent repository or home configuration, and still reads and writes its own worktree", () => {
      writeFileSync(join(projects, "other", "secret.txt"), "adjacent");
      writeFileSync(join(home, ".ssh", "id_canary"), "key");
      writeFileSync(join(tree, "mine.txt"), "mine");
      const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree: tree, home, boundary: taskBoundary({ binding: { main, gitdir: join(main, ".git", "worktrees", "task-1") }, worktree: tree, provider: "claude", home }) });
      const script = `const fs=require("fs");const out=[];for(const f of process.argv.slice(1)){try{out.push(fs.readFileSync(f,"utf8").trim())}catch(e){out.push(e.code)}}try{fs.writeFileSync(${JSON.stringify(join(projects, "other", "x.txt"))},"x");out.push("wrote-adjacent")}catch(e){out.push(e.code)}console.log(out.join(" "))`;
      const { file, args } = macosFenced(process.execPath, ["-e", script, join(projects, "other", "secret.txt"), join(home, ".ssh", "id_canary"), join(tree, "mine.txt"), join(home, ".claude.json")], fence);
      expect(spawnSync(file, args, { encoding: "utf8" }).stdout.trim()).toBe("EPERM EPERM mine {} EPERM");
    });

    test.skipIf(!macosFenceAvailable())("on macOS git gc and worktree prune work inside the fence, keep a live sibling and what its index holds, and can't write another task's entry", async () => {
      const repo = join(projects, "prune-repro");
      const active = join(dir, "prune-tasks", "active");
      const other = join(dir, "prune-tasks", "other");
      mkdirSync(repo);
      const git = (cwd: string, ...args: string[]) => {
        const result = spawnSync("git", ["-c", "user.name=Fence test", "-c", "user.email=fence@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git(repo, "init", "-q");
      git(repo, "commit", "--allow-empty", "-qm", "fixture");
      git(repo, "worktree", "add", "-qb", "active", active);
      git(repo, "worktree", "add", "-qb", "other", other);
      // Another task's staged work: an object only its index reaches.
      writeFileSync(join(other, "staged.txt"), "only in the other task's index\n");
      git(other, "add", "staged.txt");
      const staged = git(other, "rev-parse", ":staged.txt");
      const metadata = join(repo, ".git", "worktrees", "other");
      const before = readFileSync(join(metadata, "HEAD"), "utf8");
      const boundary = taskBoundary({ binding: trustedWorktreeBinding(repo, active), worktree: active, provider: "claude", home });
      expect(boundary.shell).toContain(other);
      expect(boundary.readOnly).toEqual([metadata]);
      const grants = fenceGrants({ databaseFile: null, worktree: active, boundary });
      const fenced = (script: string, rules = grants) => run("/bin/bash", ["-c", script], { cwd: active, processGroup: true, confinement: "required", fence: boundary.shell, fenceGrants: rules, env: fencedGitEnv({}) });

      const inside = await fenced([
        "git config gc.reflogExpire; git config gc.reflogExpireUnreachable",
        "git gc --prune=now --quiet && echo gc-ok",
        "git worktree prune --expire=now --verbose && echo prune-ok",
        `cat ${JSON.stringify(join(metadata, "HEAD"))} >/dev/null && echo read-sibling-head`,
        `(echo x > ${JSON.stringify(join(metadata, "HEAD"))}) 2>/dev/null && echo wrote-sibling-head || echo write-refused`,
        `(rm -rf ${JSON.stringify(metadata)}) 2>/dev/null; test -d ${JSON.stringify(metadata)} && echo entry-kept`,
        `cat ${JSON.stringify(join(other, "staged.txt"))} 2>/dev/null || echo sibling-checkout-unreadable`,
      ].join("\n"));
      expect(inside.code, inside.stderr).toBe(0);
      expect(inside.stdout.trim().split("\n")).toEqual(["never", "never", "gc-ok", "prune-ok", "read-sibling-head", "write-refused", "entry-kept", "sibling-checkout-unreadable"]);
      expect(readFileSync(join(metadata, "HEAD"), "utf8")).toBe(before);
      git(repo, "cat-file", "-e", staged);
      expect(git(repo, "worktree", "list", "--porcelain")).toContain(other);
      // This task's own git still works.
      writeFileSync(join(active, "mine.txt"), "mine");
      expect((await fenced("git add mine.txt && echo added")).stdout.trim()).toBe("added");

      // Control: without the lookup, the live sibling looks deleted and prune goes to remove its entry;
      // the write fence alone still keeps it.
      const blind = await fenced("git worktree prune --expire=now --verbose 2>&1", { ...grants, lookup: [] });
      expect(blind.stdout).toContain("worktrees/other");
      expect(existsSync(join(metadata, "HEAD"))).toBe(true);
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
    await run(process.execPath, ["-e", script], { processGroup: true, confinement: "required", fence });
    expect(readFileSync(outcome, "utf8")).toBe("EPERM");
    await runStreamJsonl(process.execPath, ["-e", script], { processGroup: true, confinement: "required", fence });
    expect(readFileSync(outcome, "utf8")).toBe("EPERM");
    // Without a fence the same spawn reads it: the test would catch a no-op fence.
    await run(process.execPath, ["-e", script], { processGroup: true });
    expect(readFileSync(outcome, "utf8")).toContain("canary-login");
  });

  describe("through the gateway", () => {
    function bind(local: Store) {
      const { main } = linkedCheckout();
      local.saveWorktree({ path: worktree, repo: main, branch: "task", runner: null, taskRef: null,
        createdAt: T0.toISOString(), leasedAt: null, releasedAt: null, verified: true });
    }
    test("a fresh build and its resumed repair get the same setup: no settings sources, strict MCP, the task boundary, and the user's own sign-in", async () => {
      mkdirSync(join(state, "worktrees", "app", "task-2", ".git"), { recursive: true });
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(home, ".claude.json"), "{}");
      const local = openStore(join(state, "orders.db.boundary"));
      bind(local);
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
      bind(store);
      const remotePool = join(dir, "custom-pool", "other", "task-0123abcd");
      mkdirSync(remotePool, { recursive: true });
      store.saveWorktree({ path: remotePool, repo: join(dir, "other"), branch: "task", runner: null, taskRef: null,
        createdAt: T0.toISOString(), leasedAt: null, releasedAt: null, verified: true });
      const seen: { file: string; args: readonly string[] }[] = [];
      const ask = { phase: "build" as const, brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: true, resumeSession: null };
      const codexRun = open("t-codex", "codex");
      await invokeAgent(store, codexRun, { provider: "codex", model: null }, ask, { keyHome: home, clock: () => T0, runner: async (file, args) => { seen.push({ file, args }); return OK; } });
      const codex = seen.at(-1)!;
      expect(codex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      const filesystem = codex.args.find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
      expect(filesystem).toContain(`"${join(state, "up-login.txt")}"="deny"`);
      expect(filesystem).toContain(`"${join(home, ".standing-orders")}"="deny"`);
      // Codex keeps ancestors traversable, with explicit launch-time sibling denies.
      expect(filesystem).toContain(`"${join(state, "worktrees")}"="read"`);
      expect(filesystem).toContain(`"${worktree}"="write"`);
      expect(filesystem).toContain(`"${join(dir, "custom-pool")}"="deny"`);
      expect(filesystem).not.toContain("[!");
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

/** Shared installs are named by a 24-hex key; the plane's record of this checkout: its project and stamped setup. */
const LINKED_KEY = "0123456789abcdef01234567", OTHER_KEY = "fedcba9876543210fedcba98";
const LINKED = { repo: "/projects/app", setupDigest: "setup-1" };

describe("what the fence gives back", () => {
  let dir: string, state: string, worktree: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-grants-")));
    state = join(dir, "standing-orders");
    worktree = join(state, "worktrees", "app", "task-1");
    // Two shared installs: the one this checkout links, and another project's.
    for (const key of [LINKED_KEY, OTHER_KEY]) {
      const repo = key === LINKED_KEY ? LINKED.repo : "/projects/other";
      const pkg = join(state, "deps", key, "node_modules", "pkg");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pkg", main: "index.js" }));
      writeFileSync(join(pkg, "index.js"), `module.exports = { value: ${JSON.stringify(key)} };\n`);
      writeFileSync(join(pkg, "bin", "cli.js"), `#!/usr/bin/env node\nconsole.log("ran ${key}");\n`, { mode: 0o755 });
      mkdirSync(join(state, "deps", key, "node_modules", ".bin"));
      symlinkSync(join("..", "pkg", "bin", "cli.js"), join(state, "deps", key, "node_modules", ".bin", "pkg-cli"));
      writeFileSync(join(state, "deps", key, "ready.json"), JSON.stringify({ version: 1, repo, key, lock: "lock", node: "node", setup: LINKED.setupDigest, tree: null, createdAt: "2026-10-12T00:00:00.000Z" }));
    }
    // The checkout's node_modules as linkInto makes it: one link per entry and a note naming the copy.
    const shared = join(state, "deps", LINKED_KEY, "node_modules");
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", ".toolroll-shared"), `${shared}\n`);
    for (const entry of ["pkg", ".bin"]) symlinkSync(join(shared, entry), join(worktree, "node_modules", entry), "dir");
    for (const [file, text] of [["orders.db", "db"], ["runner-token", "t"]] as const) writeFileSync(join(state, file), text);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("only the shared install this checkout links is readable, inside a fenced deps folder that is only looked up; Codex gets the same as plain paths", () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home: join(dir, "home") });
    expect(fence).toContain(join(state, "deps"));
    const grants = fenceGrants({ databaseFile: join(state, "orders.db"), worktree, linked: LINKED });
    expect(grants).toEqual({ readOnly: [], readable: [join(state, "deps", LINKED_KEY, "node_modules")], lookup: [join(state, "deps"), join(state, "deps", LINKED_KEY)] });
    // A checkout with its own install (or none) is given nothing.
    expect(fenceGrants({ databaseFile: join(state, "orders.db"), worktree: join(dir, "elsewhere"), linked: LINKED }).readable).toEqual([]);
    const profile = macosFenceProfile(fence, grants);
    expect(profile).toContain(`(allow file-read-metadata (literal "${join(state, "deps")}") (literal "${join(state, "deps", LINKED_KEY)}"))`);
    expect(profile).toContain(`(allow file-read* file-test-existence (subpath "${join(state, "deps", LINKED_KEY, "node_modules")}"))`);
    // The deny comes first and the narrow grant after it: a later Seatbelt rule wins.
    expect(profile.indexOf(`(subpath "${join(state, "deps")}")`)).toBeLessThan(profile.indexOf("(allow file-read* file-test-existence"));
    // Codex can't grant inside a deny: the deps folder becomes read-only and everything not on the way is denied.
    const flat = flattened(fence, grants);
    expect(flat.deny).toEqual(expect.arrayContaining([join(state, "deps", OTHER_KEY), join(state, "deps", LINKED_KEY, "ready.json"), join(state, "runner-token")]));
    expect(flat.deny).not.toContain(join(state, "deps"));
    expect(flat.readOnly.sort()).toEqual([join(state, "deps"), join(state, "deps", LINKED_KEY), join(state, "deps", LINKED_KEY, "node_modules")]);
    const filesystem = codexFenceArgv(fence, false, grants).find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
    expect(filesystem).toContain(`"${join(state, "deps", LINKED_KEY, "node_modules")}"="read"`);
    expect(filesystem).toContain(`"${join(state, "deps", OTHER_KEY)}"="deny"`);
    // Codex can't deny-then-grant, so a secret-looking name made later in a read-only folder is denied by pattern.
    for (const folder of [join(state, "deps"), join(state, "deps", LINKED_KEY)]) {
      for (const pattern of ["orders.db*", "*token*", "up-login*", "*.txt"]) expect(filesystem).toContain(`"${join(folder, pattern)}"="deny"`);
    }
    // Linux binds the readable copy back, read-only, after masking the folder around it.
    const bwrap = linuxFenced("claude", [], fence, grants).args;
    // The deps folder is masked whole (what is made there later is masked too), then only the linked copy is bound back.
    const mask = bwrap.findIndex((arg, at) => arg === "--tmpfs" && bwrap[at + 1] === join(state, "deps"));
    const bind = bwrap.findIndex((arg, at) => arg === "--ro-bind" && bwrap[at + 1] === join(state, "deps", LINKED_KEY, "node_modules"));
    expect(mask).toBeGreaterThan(0);
    expect(bind).toBeGreaterThan(mask);
    expect(bwrap).not.toContain(join(state, "deps", OTHER_KEY));
  });

  test("every macOS profile hides other processes' arguments and environment and anything outside its own sandbox; other launches' folders are denied by pattern, its own kept", () => {
    const own = join(dir, "so-tools-own");
    const profile = macosFenceProfile(["/s/secret"], { readOnly: ["/r/meta"], readable: [], lookup: ["/r/checkout"], runFolders: { root: "/private/var/folders/a.b/T", own } });
    expect(profile.split("\n")).toEqual([
      ...MACOS_HEAD,
      '(deny file-read* file-write* (subpath "/s/secret"))',
      '(deny file-write* (subpath "/r/meta"))',
      '(deny file-read* file-write* (regex #"^/private/var/folders/a\\.b/T/(so-tools-|so-codex-|so-net-|so-cmd-)"))',
      '(allow file-read-metadata (literal "/r/checkout"))',
      `(allow file-read* file-write* (subpath "${own}"))`,
      `(deny file-write* (literal "${own}"))`,
      '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
      "(deny process-info*)",
      "(allow process-info* (target same-sandbox))",
      "(deny mach-task-name)",
      ...MACOS_TAIL_OPEN,
    ]);
    // Present launch folders are fenced by path too, for Codex and Linux; never this launch's own.
    const root = join(dir, "tmp");
    for (const name of ["so-tools-mine", "so-tools-theirs", "so-codex-theirs", "unrelated"]) mkdirSync(join(root, name), { recursive: true });
    const fence = agentFence({ databaseFile: null, worktree: null, home: join(dir, "home"), runFolders: runFolders(join(root, "so-tools-mine"), root) });
    expect(fence).toEqual([join(root, "so-codex-theirs"), join(root, "so-tools-theirs")]);
    // A second root (a Mac's short one for checks) is denied by pattern too.
    const both = macosFenceProfile([], { readOnly: [], readable: [], lookup: [], runFolders: { root: "/private/var/folders/a.b/T", own, also: ["/private/tmp"] } });
    expect(both).toContain('(deny file-read* file-write* (regex #"^/private/tmp/(so-tools-|so-codex-|so-net-|so-cmd-)"))');
  });

  test("Codex: a folder holding the shared install that can't be listed stays denied whole, and its grant is dropped", () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home: join(dir, "home") });
    const grants = fenceGrants({ databaseFile: join(state, "orders.db"), worktree, linked: LINKED });
    const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const flat = flattened(fence, grants, path => { if (path === join(state, "deps")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); return readdirSync(path); });
      expect(flat.deny).toContain(join(state, "deps"));
      expect(flat.readOnly).toEqual([]);
      expect(String(said.mock.calls[0]?.[0])).toContain(`couldn't list ${join(state, "deps")}`);
    } finally { said.mockRestore(); }
  });

  test("a shared install the checkout's note names is granted only when it is the plane's copy for this project and setup; a foreign key is refused", async () => {
    const granted = (linked: { repo: string; setupDigest: string | null } | null) => fenceGrants({ databaseFile: join(state, "orders.db"), worktree, linked }).readable;
    expect(granted(LINKED)).toEqual([join(state, "deps", LINKED_KEY, "node_modules")]);
    // The plane recorded nothing, or another setup: nothing is granted.
    expect(granted(null)).toEqual([]);
    expect(granted({ ...LINKED, setupDigest: "setup-2" })).toEqual([]);
    expect(granted({ ...LINKED, setupDigest: null })).toEqual([]);
    // The build rewrites its note to another project's copy, or to a folder that isn't a key.
    const note = join(worktree, "node_modules", ".toolroll-shared");
    writeFileSync(note, `${join(state, "deps", OTHER_KEY, "node_modules")}\n`);
    expect(granted(LINKED)).toEqual([]);
    mkdirSync(join(state, "deps", "not-a-key", "node_modules"), { recursive: true });
    writeFileSync(note, `${join(state, "deps", "not-a-key", "node_modules")}\n`);
    expect(granted(LINKED)).toEqual([]);
    if (!macosFenceAvailable()) return;
    // Under the fence, the foreign copy the build points itself at stays unreadable.
    writeFileSync(note, `${join(state, "deps", OTHER_KEY, "node_modules")}\n`);
    rmSync(join(worktree, "node_modules", "pkg"));
    symlinkSync(join(state, "deps", OTHER_KEY, "node_modules", "pkg"), join(worktree, "node_modules", "pkg"), "dir");
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home: join(dir, "home") });
    const foreign = await run("/bin/bash", ["-c", `${JSON.stringify(process.execPath)} -e 'console.log(require("pkg").value)' 2>/dev/null || echo foreign-refused`],
      { cwd: worktree, processGroup: true, confinement: "required", fence, fenceGrants: fenceGrants({ databaseFile: join(state, "orders.db"), worktree, linked: LINKED }) });
    expect(foreign.stdout.trim()).toBe("foreign-refused");
  });

  test("Codex: a read-only grant equal to or inside a denied path is dropped", () => {
    const grants = { readOnly: ["/d/secrets/inner", "/d", "/r/meta"], readable: [], lookup: [] };
    expect(flattened(["/d", "/e"], grants)).toEqual({ deny: ["/d", "/e"], readOnly: ["/r/meta"] });
    const filesystem = codexFenceArgv(["/d"], false, grants).find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
    expect(filesystem).not.toContain('"/d/secrets/inner"');
    expect(filesystem).toContain('"/d"="deny"');
  });

  test("bubblewrap masks each fenced folder whole first, then binds back only grants outside fenced paths, launch folders and secret names", () => {
    const fenced = join(dir, "fenced"), meta = join(dir, "meta"), temp = join(dir, "T");
    const paths = { inner: join(fenced, "inner"), linked: join(fenced, "deps", "k", "node_modules"), secret: join(fenced, "deps", "x.token", "node_modules"),
      launch: join(temp, "so-tools-other", "lib"), own: join(temp, "so-tools-mine", "lib") };
    for (const path of [meta, ...Object.values(paths)]) mkdirSync(path, { recursive: true });
    const grants = { readOnly: [paths.inner, fenced, meta], readable: [paths.linked, paths.secret, paths.launch, paths.own], lookup: [], runFolders: { root: temp, own: join(temp, "so-tools-mine") } };
    const bwrap = linuxFenced("claude", [], [fenced], grants).args;
    // One whole mask (a file made there after launch is masked with it), then the grants, then the command.
    expect(bwrap.slice(0, 5)).toEqual(["--dev-bind", "/", "/", "--tmpfs", fenced]);
    const bound = bwrap.flatMap((arg, at) => arg === "--ro-bind" ? [bwrap[at + 1]!] : []);
    expect(bound.sort()).toEqual([meta, paths.linked, paths.own].sort());
    expect(bwrap.indexOf("--ro-bind")).toBeGreaterThan(bwrap.indexOf("--tmpfs"));
  });

  test("a fenced build's git never expires a reflog, after any settings the caller already passed", () => {
    expect(fencedGitEnv({})).toEqual({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "gc.reflogExpire", GIT_CONFIG_VALUE_0: "never", GIT_CONFIG_KEY_1: "gc.reflogExpireUnreachable", GIT_CONFIG_VALUE_1: "never" });
    expect(fencedGitEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" })).toEqual({ GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_1: "gc.reflogExpire", GIT_CONFIG_VALUE_1: "never", GIT_CONFIG_KEY_2: "gc.reflogExpireUnreachable", GIT_CONFIG_VALUE_2: "never" });
    const ran = spawnSync("git", ["config", "gc.reflogExpireUnreachable"], { env: { ...process.env, ...fencedGitEnv(process.env) }, encoding: "utf8" });
    expect(ran.stdout.trim()).toBe("never");
  });

  test.skipIf(!macosFenceAvailable())("on macOS a build imports a package and runs a .bin from its linked shared install, and can't read or change any other", async () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home: join(dir, "home") });
    const grants = fenceGrants({ databaseFile: join(state, "orders.db"), worktree, linked: LINKED });
    const other = join(state, "deps", OTHER_KEY, "node_modules", "pkg", "index.js");
    const linked = join(state, "deps", LINKED_KEY, "node_modules", "pkg", "index.js");
    const ran = await run("/bin/bash", ["-c", [
      `${JSON.stringify(process.execPath)} -e 'console.log(require("pkg").value)'`,
      "PATH=\"$PWD/node_modules/.bin:$PATH\" pkg-cli",
      `cat ${JSON.stringify(other)} 2>/dev/null || echo other-copy-unreadable`,
      `ls ${JSON.stringify(join(state, "deps"))} 2>/dev/null || echo deps-unlisted`,
      `(echo x >> ${JSON.stringify(linked)}) 2>/dev/null && echo changed-shared || echo shared-read-only`,
      `cat ${JSON.stringify(join(state, "runner-token"))} 2>/dev/null || echo state-still-fenced`,
    ].join("\n")], { cwd: worktree, processGroup: true, confinement: "required", fence, fenceGrants: grants });
    expect(ran.stdout.trim().split("\n"), ran.stderr).toEqual([LINKED_KEY, `ran ${LINKED_KEY}`, "other-copy-unreadable", "deps-unlisted", "shared-read-only", "state-still-fenced"]);
    // A file written into the deps folder after launch stays unreadable, beside the folder and inside the linked copy.
    const flag = join(worktree, "written.flag");
    const late = [join(state, "deps", "late.token"), join(state, "deps", LINKED_KEY, "late-notes.md"), join(state, "deps", OTHER_KEY, "node_modules", "late.js")];
    const waiting = run("/bin/bash", ["-c", [
      `while [ ! -e ${JSON.stringify(flag)} ]; do sleep 0.1; done`,
      ...late.map(path => `cat ${JSON.stringify(path)} 2>/dev/null || echo late-unreadable`),
      `${JSON.stringify(process.execPath)} -e 'console.log(require("pkg").value)'`,
      "PATH=\"$PWD/node_modules/.bin:$PATH\" pkg-cli",
    ].join("\n")], { cwd: worktree, processGroup: true, confinement: "required", fence, fenceGrants: grants, timeoutMs: 30_000 });
    await new Promise(done => setTimeout(done, 500));
    for (const path of late) writeFileSync(path, "synthetic-late-secret");
    writeFileSync(flag, "");
    const after = await waiting;
    expect(after.stdout.trim().split("\n"), after.stderr).toEqual(["late-unreadable", "late-unreadable", "late-unreadable", LINKED_KEY, `ran ${LINKED_KEY}`]);
    // Control: the deny alone (the fence before this change) breaks the same import.
    const before = await run("/bin/bash", ["-c", `${JSON.stringify(process.execPath)} -e 'require("pkg")' 2>/dev/null && echo imported || echo import-failed`], { cwd: worktree, processGroup: true, confinement: "required", fence });
    expect(before.stdout.trim()).toBe("import-failed");
  });
});

describe("a build's tool secrets behind the macOS fence", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-secrets-"))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Reads a process's arguments and environment with a direct sysctl(KERN_PROCARGS2) — `ps` is setuid and can't run
   * in a sandbox, so it would prove nothing — and says only whether it could, and the digest of any NOTES_TOKEN seen. */
  const PROBE = [
    "import ctypes, hashlib, re, sys",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "for pid in sys.argv[1:]:",
    "    size = ctypes.c_size_t(1 << 20)",
    "    buf = ctypes.create_string_buffer(size.value)",
    "    mib = (ctypes.c_int * 3)(1, 49, int(pid))",
    "    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:",
    "        print('denied'); continue",
    "    found = re.search(rb'NOTES_TOKEN=([^\\0]*)', buf.raw[:size.value])",
    "    print('read ' + (hashlib.sha256(found.group(1)).hexdigest() if found else 'no-token'))",
  ].join("\n");
  const python = spawnSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();

  test.skipIf(!macosFenceAvailable() || python === "")("a fenced shell finds no secret in its tool config, other launches' folders, its descriptors or a process listing, and its opted-in tool still starts", async () => {
    const secret = ["notes", "secret", "5e".repeat(16)].join("-");
    const server = join(dir, "notes.mjs");
    writeFileSync(server, NOTES_SERVER);
    writeFileSync(join(dir, "probe.py"), PROBE);
    // The fence is fixed after the tools (as in invoke.ts): the broker reads it when its server starts.
    let fenceOf: { fence: string[]; grants: ReturnType<typeof fenceGrants> } | null = null;
    const tools = await claudeToolArgs({ tools: [{ spec: { name: "notes", transport: "stdio", command: process.execPath, args: [server, join(dir, "notes.log")], url: null, secrets: [{ name: "NOTES_TOKEN", optional: false }], bearer: null, headerSecrets: {}, about: "Notes" }, digest: "d", values: { NOTES_TOKEN: secret } }], skipped: [] },
      { broker: { wrap: () => (file, args) => macosFenced(file, args, fenceOf!.fence, fenceOf!.grants) } });
    try {
      const folders = runFolders(tools.privateDir!);
      const databaseFile = join(dir, "orders.db");
      writeFileSync(databaseFile, "private database");
      fenceOf = { fence: agentFence({ databaseFile, worktree: null, home: join(dir, "home"), runFolders: folders }), grants: fenceGrants({ databaseFile, worktree: null, runFolders: folders }) };
      expect(fenceOf.fence).toContain(databaseFile);
      const configFile = tools.argv[1]!;
      const notes = (JSON.parse(readFileSync(configFile, "utf8")) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> }).mcpServers["notes"]!;
      // Another launch's folder, made after this one's fence was fixed.
      const theirs = mkdtempSync(join(tmpdir(), "so-tools-"));
      writeFileSync(join(theirs, "mcp.json"), JSON.stringify({ secret }));
      const client = `const [url, auth] = process.argv.slice(1); const call = (id, method, params) => fetch(url, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then(r => r.json());
        await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fenced", version: "1" } });
        const answer = await call(2, "tools/call", { name: "read_note", arguments: {} });
        console.log("tool " + answer.result.content[0].text);`;
      try {
        // The tool starts from inside the fence first, so its server has a pid to probe.
        const started = await run(process.execPath, ["--input-type=module", "-e", client, notes.url, notes.headers.Authorization], { processGroup: true, confinement: "required", fence: fenceOf.fence, fenceGrants: fenceOf.grants });
        expect(started.stdout.trim(), started.stderr).toBe(`tool ${createHash("sha256").update(secret).digest("hex")}`);
        const [serverPid] = tools.serverPids?.() ?? [];
        expect(serverPid).toEqual(expect.any(Number));
        const spawned = vi.mocked(spawn);
        spawned.mockClear();
        const fenced = await run("/bin/bash", ["-c", [
          `cat ${JSON.stringify(configFile)}`,
          `cat ${JSON.stringify(join(theirs, "mcp.json"))} 2>/dev/null || echo other-launch-unreadable`,
          // Every descriptor the shell inherited that can be read as a file.
          "for fd in /dev/fd/*; do [ -f \"$fd\" ] && head -c 65536 \"$fd\"; done; echo",
          `${JSON.stringify(python)} ${JSON.stringify(join(dir, "probe.py"))} ${process.pid} ${serverPid}`,
        ].join("\n")], { processGroup: true, confinement: "required", fence: fenceOf.fence, fenceGrants: fenceOf.grants });
        expect(spawned.mock.calls.map(([file, args]) => [file, args?.slice(0, 3)])).toEqual([
          ["/usr/bin/sandbox-exec", ["-p", macosFenceProfile(fenceOf.fence, fenceOf.grants), "/bin/bash"]],
        ]);
        expect(fenced.stdout).not.toContain(secret);
        expect(fenced.stdout).toContain(notes.url);
        expect(fenced.stdout).toContain("other-launch-unreadable");
        expect(fenced.stdout.trim().split("\n").slice(-2)).toEqual(["denied", "denied"]);
        // Control: unfenced, the same probe reads the server's environment, secret and all.
        const open = spawnSync(python, [join(dir, "probe.py"), String(serverPid)], { encoding: "utf8" });
        expect(open.stdout.trim()).toBe(`read ${createHash("sha256").update(secret).digest("hex")}`);
      } finally {
        rmSync(theirs, { recursive: true, force: true });
      }
    } finally {
      tools.cleanup();
    }
  });
});

describe("the macOS fence holds against renaming a folder above it and against another process's task port", () => {
  let dir: string, state: string, home: string, worktree: string, root: string, own: string;
  const MARKER = "synthetic-fence-marker-0962";
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-hold-")));
    state = join(dir, "home", ".config", "standing-orders");
    home = join(dir, "home");
    worktree = join(dir, "projects", "app");
    // A stand-in system temp folder: this launch's own tool folder and another run's, holding a broker token.
    root = join(dir, "T");
    own = join(root, "so-tools-mine");
    for (const path of [state, worktree, own, join(root, "so-tools-other")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(state, "up-login.txt"), MARKER);
    writeFileSync(join(state, "orders.db"), "db");
    writeFileSync(join(root, "so-tools-other", "mcp.json"), JSON.stringify({ token: MARKER }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fenceOf = () => {
    const folders = runFolders(own, root);
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home, runFolders: folders });
    return { fence, grants: { ...fenceGrants({ databaseFile: join(state, "orders.db"), worktree }), runFolders: folders } };
  };
  const sh = (script: string, profile?: string) => {
    const { fence, grants } = fenceOf();
    const { file, args } = profile === undefined ? macosFenced("/bin/bash", ["-c", script], fence, grants) : { file: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/bash", "-c", script] };
    return spawnSync(file, args, { encoding: "utf8", cwd: worktree, env: { ...process.env, NODE_OPTIONS: undefined } });
  };

  test("the folders above a fenced path and the temp folder are the user's own ones only, never / nor the path itself", () => {
    const above = ownedAncestors([join(state, "up-login.txt")], [root]);
    expect(above).toEqual(expect.arrayContaining([state, home, dir, root]));
    expect(above).not.toContain(join(state, "up-login.txt"));
    expect(above).not.toContain("/");
    // System folders the user doesn't own are left out: a build can't rename them anyway.
    expect(above).not.toContain("/private");
    expect(ownedAncestors(["/nowhere/at/all"], ["/no/temp"])).toEqual([]);
    const { fence, grants } = fenceOf();
    const profile = macosFenceProfile(fence, grants);
    expect(profile).toContain(`(literal "${home}")`);
    expect(profile).toContain(`(literal "${root}")`);
    expect(profile.split("\n").at(-1 - MACOS_TAIL_OPEN.length)).toMatch(/^\(deny file-write\* \(literal /);
  });

  test.skipIf(!macosFenceAvailable())("a build can't rename a folder above a fenced path or the temp folder to read through the new name, and still writes inside them", () => {
    const attack = [
      `mv "${root}" "${root}.x" && echo moved-temp; cat "${root}.x/so-tools-other/mcp.json" "${root}/so-tools-other/mcp.json" 2>/dev/null`,
      `mv "${home}/.config" "${home}/.c" && echo moved-config; cat "${home}/.c/standing-orders/up-login.txt" "${state}/up-login.txt" 2>/dev/null`,
      `rm -rf "${home}/.config" 2>/dev/null; rmdir "${dir}/home" 2>/dev/null; true`,
    ].join("\n");
    const fenced = sh(attack);
    expect(fenced.stdout).not.toContain(MARKER);
    expect(fenced.stdout).not.toContain("moved-");
    expect(existsSync(join(root, "so-tools-other", "mcp.json")) && existsSync(join(state, "up-login.txt"))).toBe(true);
    // The same profile without the ancestor rule lets the rename through: the rule is what holds.
    const { fence, grants } = fenceOf();
    const without = macosFenceProfile(fence, grants).split("\n").filter(line => !line.startsWith("(deny file-write* (literal ")).join("\n");
    const open = sh(`mv "${root}" "${root}.x" && cat "${root}.x/so-tools-other/mcp.json"; mv "${root}.x" "${root}"`, without);
    expect(open.stdout).toContain(MARKER);
    // Writing inside those folders works as before: the own tool folder, the temp folder, the home folder.
    const inside = sh([
      `echo a > "${own}/config.json" && mv "${own}/config.json" "${own}/mcp.json" && echo own-ok`,
      `mkdir "${root}/scratch" && echo b > "${root}/scratch/f" && rm -r "${root}/scratch" && echo temp-ok`,
      `echo c > "${home}/.toolrc.tmp" && mv "${home}/.toolrc.tmp" "${home}/.toolrc" && rm "${home}/.toolrc" && echo home-ok`,
      `f=$(mktemp) && echo d > "$f" && rm "$f" && echo tmpdir-ok`,
    ].join("\n"));
    expect(inside.stdout.trim().split("\n")).toEqual(["own-ok", "temp-ok", "home-ok", "tmpdir-ok"]);
  });

  const lldb = existsSync("/usr/bin/lldb") && spawnSync("/usr/bin/lldb", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0;
  // Without lldb (no command line tools) there is no probe here that can attach at all: say so rather than pass.
  test.skipIf(!macosFenceAvailable() || !lldb)("a build can't attach to another process (lldb, task_for_pid) to read its environment", async () => {
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env["PATH"] ?? "", SO_FENCE_MARKER: MARKER }, stdio: "ignore" });
    try {
      await new Promise(done => setTimeout(done, 500));
      const probe = `/usr/bin/lldb -p ${sibling.pid} --batch -o 'expr -- (char*)getenv("SO_FENCE_MARKER")' 2>&1`;
      const fenced = sh(probe);
      expect(fenced.stdout).not.toContain(MARKER);
      expect(fenced.stdout).toMatch(/attach failed|Not allowed to attach|error/i);
      // No unsandboxed control: outside the fence lldb can stall on developer-tools authorization, and its debugserver
      // (its own session) outlives any timeout, so the run never stops. The fenced refusal above is the guard.
    } finally { sibling.kill("SIGKILL"); }
  }, 120_000);

  test.skipIf(!macosFenceAvailable())("node, npm, git, tsc and vitest still run under the fence", () => {
    const bin = join(process.cwd(), "node_modules", ".bin");
    writeFileSync(join(worktree, "smoke.test.js"), 'test("adds", () => { expect(1 + 1).toBe(2); });\n');
    const ran = sh([
      `"${process.execPath}" -e 'console.log("node-ok")'`,
      `npm --version >/dev/null && echo npm-ok`,
      `git init -q && git add smoke.test.js && git -c user.name=t -c user.email=t@t commit -qm smoke && git log --oneline | grep -q smoke && echo git-ok`,
      `"${bin}/tsc" --version >/dev/null && echo tsc-ok`,
      `"${bin}/vitest" run --globals --root "${worktree}" --reporter=dot >/dev/null 2>&1 && echo vitest-ok`,
    ].join("\n"));
    expect(ran.stdout.trim().split("\n")).toEqual(["node-ok", "npm-ok", "git-ok", "tsc-ok", "vitest-ok"]);
  }, 120_000);
});

describe("a link planted among the repository's worktree entries grants nothing", () => {
  let dir: string, home: string, repo: string, active: string, secrets: string;
  const MARKER = "synthetic-tool-secret-0962";
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-planted-")));
    home = join(dir, "home");
    secrets = join(home, ".toolroll", "tool-secrets");
    repo = join(dir, "projects", "app");
    active = join(dir, "projects", "app-tasks", "active");
    mkdirSync(secrets, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(secrets, "t.json"), JSON.stringify({ token: MARKER }));
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=Fence test", "-c", "user.email=fence@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git(repo, "init", "-q");
    git(repo, "commit", "--allow-empty", "-qm", "fixture");
    git(repo, "worktree", "add", "-qb", "active", active);
    // What a fenced build can do in its own repository's shared git folder: plant a link to a fenced folder.
    symlinkSync(secrets, join(repo, ".git", "worktrees", "x"), "dir");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const launch = (provider: string) => {
    const boundary = taskBoundary({ binding: trustedWorktreeBinding(repo, active), worktree: active, provider, home });
    const fence = agentFence({ databaseFile: null, worktree: active, home, boundary });
    return { boundary, fence, grants: fenceGrants({ databaseFile: null, worktree: active, boundary }) };
  };
  const probe = () => `cat ${JSON.stringify(join(secrets, "t.json"))} 2>/dev/null || echo secret-denied`;

  test("the boundary never follows it into a read-only grant, and Codex's policy keeps the folder denied", () => {
    const { boundary, fence, grants } = launch("codex");
    expect(fence).toContain(join(home, ".toolroll"));
    expect(boundary.readOnly).toEqual([]);
    expect(JSON.stringify(boundary)).not.toContain("tool-secrets");
    const filesystem = parseFilesystem(codexFenceArgv(fence, false, grants));
    expect([...filesystem].filter(([, mode]) => mode === "read")).toEqual([]);
    expect(filesystem.get(join(home, ".toolroll"))).toBe("deny");
    // Bubblewrap masks the folder and binds nothing back from the planted link.
    const bwrap = linuxFenced("claude", [], fence, grants).args;
    expect(bwrap.join(" ")).not.toContain("tool-secrets");
    expect(bwrap[bwrap.indexOf(join(home, ".toolroll")) - 1]).toBe("--tmpfs");
  });

  // The release check runs inside the plane's macOS fence, which can't nest a sandbox or observe other processes; CI
  // (Linux, and the tag's macOS jobs) runs these unfenced.
  test.skipIf(INSIDE_FENCE || spawnSync("codex", ["--version"], { encoding: "utf8" }).error !== undefined)("the installed Codex sandbox denies the read through the planted link's target", () => {
    const { fence, grants } = launch("codex");
    const codexHome = join(dir, "so-codex-own");
    mkdirSync(codexHome);
    const control = spawnSync("/bin/sh", ["-c", probe()], { cwd: active, encoding: "utf8" });
    expect(control.stdout).toContain(MARKER);
    const result = spawnSync("codex", ["sandbox", ...codexFenceArgv(fence, false, grants), "-P", "standing-orders", "--", "/bin/sh", "-c", probe()], {
      cwd: active, encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome },
    });
    expect(result.stdout, result.stderr).not.toContain(MARKER);
    expect(result.stdout.trim()).toBe("secret-denied");
  });

  test("a planted entry whose pointer names a fenced path gets no lookup: only a checkout that names its entry back is looked up", () => {
    const planted = join(repo, ".git", "worktrees", "y");
    mkdirSync(planted);
    writeFileSync(join(planted, "gitdir"), `${join(secrets, "t.json", ".git")}\n`);
    for (const provider of ["claude", "codex"]) {
      const { boundary, grants } = launch(provider);
      expect(boundary.lookup).toEqual([]);
      expect(JSON.stringify(grants.lookup)).not.toContain("tool-secrets");
    }
    // A real sibling checkout is still looked up.
    spawnSync("git", ["worktree", "add", "-qb", "sibling", join(dir, "projects", "app-tasks", "sibling")], { cwd: repo, encoding: "utf8" });
    expect(launch("claude").boundary.lookup).toEqual([join(dir, "projects", "app-tasks", "sibling"), join(dir, "projects", "app-tasks", "sibling", ".git")]);
    if (!macosFenceAvailable()) return;
    const { fence, grants } = launch("claude");
    const { file, args } = macosFenced("/bin/sh", ["-c", `stat ${JSON.stringify(join(secrets, "t.json"))} >/dev/null 2>&1 && echo stat-allowed || echo stat-denied`], fence, grants);
    expect(spawnSync(file, args, { cwd: active, encoding: "utf8" }).stdout.trim()).toBe("stat-denied");
  });

  test.skipIf(!macosFenceAvailable())("the macOS fence denies the read through the planted link's target", () => {
    const { fence, grants } = launch("claude");
    const { file, args } = macosFenced("/bin/sh", ["-c", probe()], fence, grants);
    const result = spawnSync(file, args, { cwd: active, encoding: "utf8" });
    expect(result.stdout).not.toContain(MARKER);
    expect(result.stdout.trim()).toBe("secret-denied");
  });
});

describe("another project's checkouts are out of reach", () => {
  let dir: string, state: string, home: string, pool: string, main: string, active: string, theirs: string, root: string, own: string, head: string;
  const MARKER = "synthetic-cross-project-0963";
  const q = (path: string) => JSON.stringify(path);
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-pool-")));
    state = join(dir, "standing-orders");
    home = join(dir, "home");
    pool = join(state, "worktrees");
    main = join(dir, "projects", "app");
    // Checkouts named as the plane names them (worktreePath): pool/<project>/<branch>-<digest>.
    active = join(pool, "app", "task-0123abcd");
    theirs = join(pool, "other", "task-89abcdef");
    // A stand-in system temp folder holding this launch's own tool folder.
    root = join(dir, "T");
    own = join(root, "so-tools-mine");
    for (const path of [home, main, theirs, own, join(dir, "projects", "other", ".git", "worktrees", "task-89abcdef")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(state, "orders.db"), "db");
    writeFileSync(join(theirs, "secret.txt"), MARKER);
    writeFileSync(join(theirs, ".git"), `gitdir: ${join(dir, "projects", "other", ".git", "worktrees", "task-89abcdef")}\n`);
    writeFileSync(join(own, "mcp.json"), "own-tools");
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.name=Fence test", "-c", "user.email=fence@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(main, "init", "-q");
    git(main, "commit", "--allow-empty", "-qm", "fixture");
    git(main, "worktree", "add", "-qb", "task", active);
    // A sibling task of the same project: its git metadata is read-only, its checkout only looked up.
    git(main, "worktree", "add", "-qb", "sibling", join(pool, "app", "sibling-4567cdef"));
    head = git(active, "rev-parse", "HEAD");
    // The shared install this checkout links, as the plane made it.
    const shared = join(state, "deps", LINKED_KEY, "node_modules");
    mkdirSync(join(shared, "pkg"), { recursive: true });
    writeFileSync(join(shared, "pkg", "package.json"), JSON.stringify({ name: "pkg", main: "index.js" }));
    writeFileSync(join(shared, "pkg", "index.js"), `module.exports = { value: ${JSON.stringify(LINKED_KEY)} };\n`);
    writeFileSync(join(state, "deps", LINKED_KEY, "ready.json"), JSON.stringify({ version: 1, repo: LINKED.repo, key: LINKED_KEY, lock: "lock", node: "node", setup: LINKED.setupDigest, tree: null, createdAt: "2026-10-12T00:00:00.000Z" }));
    mkdirSync(join(active, "node_modules"));
    writeFileSync(join(active, "node_modules", ".toolroll-shared"), `${shared}\n`);
    symlinkSync(join(shared, "pkg"), join(active, "node_modules", "pkg"), "dir");
    // What the build can do in its own checkout: plant a link to another project's worktree.
    symlinkSync(theirs, join(active, "link"), "dir");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const launch = (provider: "claude" | "codex") => {
    const binding = trustedWorktreeBinding(main, active, [pool]);
    const boundary = taskBoundary({ worktree: active, provider, home, binding });
    const folders = runFolders(own, root);
    const databaseFile = join(state, "orders.db");
    return {
      fence: agentFence({ databaseFile, worktree: active, home, boundary, binding, runFolders: folders }),
      grants: fenceGrants({ databaseFile, worktree: active, boundary, runFolders: folders, linked: LINKED, binding, home, poolRoots: [pool, poolRootOf(active, main)] }),
    };
  };
  /** Made after the sandbox policy was built: a new project's worktree, which no launch-time listing could name. */
  const later = () => {
    const path = join(pool, "late", "task-fedcba98");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "secret.txt"), MARKER);
    return path;
  };
  const probe = (late: string | null, tools: boolean) => [
    `cat ${q(join(theirs, "secret.txt"))} 2>/dev/null || echo other-unreadable`,
    `(echo x > ${q(join(theirs, "planted.txt"))}) 2>/dev/null && echo other-written || echo other-unwritable`,
    `ls ${q(join(pool, "other"))} >/dev/null 2>&1 && echo pool-listed || echo pool-unlisted`,
    "cat link/secret.txt 2>/dev/null || echo link-unreadable",
    ...(late === null ? [] : [`cat ${q(join(late, "secret.txt"))} 2>/dev/null || echo later-unreadable`,
    `(echo x > ${q(join(late, "planted.txt"))}) 2>/dev/null && echo later-written || echo later-unwritable`]),
    `pwd -P`,
    `${q(process.execPath)} -e 'console.log(require("fs").realpathSync(process.cwd()))'`,
    `git ${HARDENED_GIT_ARGS.join(" ")} rev-parse HEAD`,
    `git ${HARDENED_GIT_ARGS.join(" ")} status --porcelain >/dev/null && echo status-ok`,
    "echo mine > mine.txt && cat mine.txt",
    `printf '%s' 'console.log("node-" + require("pkg").value)' > run.js && ${q(process.execPath)} run.js`,
    "npm --version >/dev/null && echo npm-ok",
    ...(tools ? [`cat ${q(join(own, "mcp.json"))}`] : []),
  ].join("\n");
  const HELD = ["other-unreadable", "other-unwritable", "pool-unlisted", "link-unreadable", "later-unreadable", "later-unwritable"];
  const WORKS = () => [active, active, head, "status-ok", "mine", `node-${LINKED_KEY}`, "npm-ok"];

  test("the plane names its checkouts' pool by their layout only", () => {
    expect(poolRootOf(active, main)).toBe(pool);
    expect(poolRootOf(join(dir, "custom", "app", "fix-0011aabb"), "/x/app")).toBe(join(dir, "custom"));
    // Not a checkout the plane made: no pool is guessed from it.
    expect(poolRootOf(join(dir, "projects", "app-tasks", "active"), main)).toBeNull();
    expect(poolRootOf(join(pool, "other", "task-0123abcd"), main)).toBeNull();
  });

  test("the pool is denied whole, the own checkout given back with only the folders between looked up", () => {
    const { fence, grants } = launch("claude");
    expect(grants.pool).toMatchObject({ deny: [pool], own: active, lookup: [pool, join(pool, "app")] });
    // agentFence never fences at or above the checkout; the pool deny lives in the grants alone.
    expect(fence).not.toContain(pool);
    expect(grants.readable).toEqual([join(state, "deps", LINKED_KEY, "node_modules")]);
    // A launch with no checkout, or one in another pool (--pool), still has the plane's own pool denied whole.
    expect(checkoutPool({ roots: [pool], worktree: null, home })).toEqual({ deny: [pool], own: null, lookup: [] });
    const elsewhere = join(dir, "custom", "app", "fix-0011aabb");
    mkdirSync(elsewhere, { recursive: true });
    expect(checkoutPool({ roots: [pool, poolRootOf(elsewhere, main)], worktree: elsewhere, home })).toEqual({ deny: [join(dir, "custom"), pool].sort(), own: elsewhere, lookup: [join(dir, "custom"), join(dir, "custom", "app")] });
  });

  test("a pool holding the checkout's own Git data is never denied whole: it is split around it, never refused", () => {
    const inner = join(pool, "repo");
    const gitdir = join(inner, ".git", "worktrees", "task-0123abcd");
    for (const path of [gitdir, join(inner, "src"), join(pool, "app")]) mkdirSync(path, { recursive: true });
    const result = checkoutPool({ roots: [pool], worktree: active, binding: { main: inner, gitdir }, home });
    expect(result.deny).toEqual([join(pool, "app"), join(pool, "late"), join(pool, "other"), join(inner, "src")].filter(path => existsSync(path)).sort());
    for (const path of [pool, inner, join(inner, ".git"), gitdir]) expect(result.deny).not.toContain(path);
    expect(result.own).toBe(active);
    const codex = codexPool(result);
    for (const path of [pool, inner, join(inner, ".git"), gitdir, active]) expect(codex.deny).not.toContain(path);
    expect(codex.read).toEqual(expect.arrayContaining([pool, inner]));
    expect(codex.deny).toContain(join(pool, "other"));
    // Never the whole machine, the home folder or one above it, or a root inside the checkout itself.
    for (const roots of [["/"], [home], [dir], [active], [join(active, "node_modules")]]) expect(checkoutPool({ roots, worktree: active, home }).deny).toEqual([]);
  });

  test("Seatbelt: the pool deny comes first, the own checkout's allow right after it, before every other deny and the read-only and lookup rules", () => {
    const { fence, grants } = launch("claude");
    const lines = macosFenceProfile(fence, grants).split("\n");
    const at = MACOS_HEAD.length - 2;
    expect(lines.slice(at, at + 6)).toEqual([
      ...MACOS_HEAD.slice(-2),
      `(deny file-read* file-write* (subpath ${q(pool)}))`,
      `(allow file-read* file-write* (subpath ${q(active)}))`,
      `(deny file-write* (literal ${q(active)}))`,
      `(allow file-read-metadata (literal ${q(pool)}) (literal ${q(join(pool, "app"))}))`,
    ]);
    // Every later deny still holds inside the checkout; the lookup and readable grants still come after them.
    expect(lines[at + 6]).toMatch(/^\(deny file-read\* file-write\* \(subpath /);
    expect(lines.findIndex(line => line.startsWith("(deny file-write* (subpath"))).toBeGreaterThan(at + 5);
    expect(lines.findLastIndex(line => line.includes(q(join(pool, "app", "sibling-4567cdef"))))).toBeGreaterThan(at + 5);
    expect(lines.findIndex(line => line.startsWith("(allow file-read* file-test-existence"))).toBeGreaterThan(at + 5);
    // The pool's folders above can't be renamed to reach it under a name no rule mentions.
    expect(lines.at(-1 - MACOS_TAIL_OPEN.length)).toContain(`(literal ${q(state)})`);
  });

  test("bubblewrap masks the pool, then binds the own checkout back read-write, before every other mask", () => {
    const { fence, grants } = launch("claude");
    const bwrap = linuxFenced("claude", [], fence, grants).args;
    expect(bwrap.slice(0, 8)).toEqual(["--dev-bind", "/", "/", "--tmpfs", pool, "--bind", active, active]);
    const masks = bwrap.flatMap((arg, at) => arg === "--tmpfs" ? [at] : []);
    expect(masks.slice(1).every(at => at > bwrap.indexOf("--bind"))).toBe(true);
    expect(bwrap.filter(arg => arg === "--bind")).toHaveLength(1);
    // The shared install is still bound back read-only; nothing in the pool but the own checkout is.
    expect(bwrap[bwrap.indexOf(join(state, "deps", LINKED_KEY, "node_modules")) - 1]).toBe("--ro-bind");
    const bound = bwrap.flatMap((arg, at) => arg === "--ro-bind" || arg === "--bind" ? [bwrap[at + 1]!] : []);
    expect(bound.filter(path => path.startsWith(pool + "/"))).toEqual([active]);
  });

  test("Codex denies launch-time siblings without denying or pattern-matching own ancestors", () => {
    for (const fullAccess of [false, true]) {
      const { fence, grants } = launch("codex");
      const filesystem = parseFilesystem(codexFenceArgv(fence, fullAccess, grants));
      expect(filesystem.get(pool)).toBe("read");
      expect(filesystem.get(join(pool, "app"))).toBe("read");
      expect(filesystem.get(active)).toBe("write");
      expect(filesystem.get(join(pool, "other"))).toBe("deny");
      expect(filesystem.get(join(pool, "app", "sibling-4567cdef"))).toBe("deny");
      expect([...filesystem.keys()].filter(path => path.startsWith(pool + "/")).some(path => /[*?[]/.test(path))).toBe(false);
      // New projects are picked up by the next launch, not by the previous policy.
      later();
      expect(filesystem.has(join(pool, "late"))).toBe(false);
      expect(parseFilesystem(codexFenceArgv(fence, fullAccess, grants)).get(join(pool, "late"))).toBe("deny");
      rmSync(join(pool, "late"), { recursive: true, force: true });
    }
    const { fence, grants } = launch("codex");
    const filesystem = parseFilesystem(codexFenceArgv([...fence, active], false, { ...grants, readOnly: [theirs] }));
    expect(filesystem.has(theirs)).toBe(false);
    expect(filesystem.get(active)).toBe("deny");
    expect(codexPool({ deny: [pool], own: null, lookup: [] })).toEqual({ read: [], deny: [pool], write: [] });
  });

  test.each(["checkout", "project"])("binding rejects a redirected recorded %s before accepting a genuine sibling registry entry", component => {
    const sibling = join(pool, "app", "sibling-4567cdef");
    if (component === "checkout") {
      rmSync(active, { recursive: true, force: true });
      symlinkSync(sibling, active);
    } else {
      // A different recorded project name must not adopt the real registered checkout.
      const alias = join(pool, "redirect");
      symlinkSync(join(pool, "app"), alias);
      expect(() => trustedWorktreeBinding(main, join(alias, "task-0123abcd"), [pool])).toThrow("trusted binding");
      return;
    }
    expect(() => trustedWorktreeBinding(main, active)).toThrow("trusted binding");
  });

  test("binding checks project redirects through an alias above the trusted pool", () => {
    const alias = join(dir, "state-alias");
    symlinkSync(state, alias);
    symlinkSync(join(pool, "app"), join(pool, "redirect"));
    expect(() => trustedWorktreeBinding(main, join(alias, "worktrees", "redirect", "task-0123abcd"), [pool])).toThrow("trusted binding");
    expect(trustedWorktreeBinding(main, join(alias, "worktrees", "app", "task-0123abcd"), [pool]).main).toBe(main);
  });

  test("Codex denies dangling and looping entries without breaking the own launch", () => {
    const { grants } = launch("codex");
    const dangling = join(pool, "dangling"), looping = join(pool, "looping");
    symlinkSync(join(dir, "missing"), dangling);
    symlinkSync(looping, looping);
    const policy = codexPool(grants.pool!);
    expect(policy.deny).toEqual(expect.arrayContaining([dangling, looping]));
    expect(policy.read).toEqual([pool, join(pool, "app")]);
    expect(policy.write).toEqual([active]);
  });

  test.skipIf(!macosFenceAvailable())("Seatbelt blocks replacing the own checkout root before a resumed launch", () => {
    const { fence, grants } = launch("claude");
    const attack = `cd / && rm -rf ${q(active)}; ln -s ${q(join(pool, "app", "sibling-4567cdef"))} ${q(active)}`;
    const wrapped = macosFenced("/bin/sh", ["-c", attack], fence, grants);
    spawnSync(wrapped.file, wrapped.args, { cwd: active, encoding: "utf8" });
    expect(lstatSync(active).isDirectory()).toBe(true);
    // Deleting contents may remove .git: a resumed launch must refuse, never adopt a sibling.
    expect(() => trustedWorktreeBinding(main, active)).toThrow("trusted binding");
    const control = macosFenced("/bin/sh", ["-c", attack], fence, { ...grants, pool: undefined });
    spawnSync(control.file, control.args, { cwd: dir, encoding: "utf8" });
    expect(lstatSync(active).isSymbolicLink()).toBe(true);
    expect(() => trustedWorktreeBinding(main, active)).toThrow("trusted binding");
  });

  test("Codex resolves aliases without denying own checkout or Git data and refuses an incomplete listing", () => {
    const { grants } = launch("codex");
    symlinkSync(join(pool, "other"), join(pool, "alias"));
    symlinkSync(active, join(pool, "own-alias"));
    symlinkSync(join(main, ".git"), join(pool, "git-alias"));
    const held = codexPool(grants.pool!);
    expect(held.deny).toContain(join(pool, "other"));
    expect(held.deny).not.toContain(active);
    expect(held.deny).not.toContain(join(main, ".git"));
    expect(() => codexPool(grants.pool!, () => { throw new Error("listing denied"); })).toThrow("listing denied");
  });

  test.skipIf(!macosFenceAvailable())("on macOS another project's worktree, and one made after launch, can't be read or written; the own checkout, git, node, npm, shared deps and tools still work", () => {
    const { fence, grants } = launch("claude");
    const env = { ...process.env, NODE_OPTIONS: undefined };
    const wrapped = (late: string, rules = grants) => macosFenced("/bin/sh", ["-c", probe(late, true)], fence, rules);
    const { file, args } = wrapped(join(pool, "late", "task-fedcba98"));
    const late = later();
    const result = spawnSync(file, args, { cwd: active, encoding: "utf8", env });
    expect(result.stdout, result.stderr).not.toContain(MARKER);
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([...HELD, ...WORKS(), "own-tools"]);
    expect(existsSync(join(theirs, "planted.txt")) || existsSync(join(late, "planted.txt"))).toBe(false);
    // Control: the same fence without the pool deny reads both, so the deny is what holds.
    const open = wrapped(late, { ...grants, pool: undefined });
    expect(spawnSync(open.file, open.args, { cwd: active, encoding: "utf8", env }).stdout).toContain(MARKER);
  }, 60_000);

  test.skipIf(!linuxFenceAvailable())("bubblewrap denies existing and later projects while own checkout and tools work", () => {
    const { fence, grants } = launch("claude");
    const late = join(pool, "late", "task-fedcba98");
    const wrapped = linuxFenced("/bin/sh", ["-c", probe(late, true)], fence, grants);
    later();
    const result = spawnSync(wrapped.file, wrapped.args, { cwd: active, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: undefined } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([...HELD, ...WORKS(), "own-tools"]);
    expect(existsSync(join(theirs, "planted.txt")) || existsSync(join(late, "planted.txt"))).toBe(false);
  });

  // Whether Codex's own sandbox runs here at all (it can't inside another Seatbelt sandbox).
  const codexSandbox = (() => {
    const scratch = mkdtempSync(join(tmpdir(), "so-codex-probe-"));
    try {
      return spawnSync("codex", ["sandbox", ...codexFenceArgv([], false), "-P", "standing-orders", "--", "/usr/bin/true"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: scratch }, timeout: 30_000 }).status === 0;
    } catch { return false; } finally { rmSync(scratch, { recursive: true, force: true }); }
  })();
  test.skipIf(!codexSandbox)("under the installed Codex sandbox an existing other project is denied; own cwd, realpath, git, node, npm and shared deps work", () => {
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    for (const fullAccess of [false, true]) {
      const { fence, grants } = launch("codex");
      const argv = codexFenceArgv(fence, fullAccess, grants);
      const result = spawnSync("codex", ["sandbox", ...argv, "-P", "standing-orders", "--", "/bin/sh", "-c", probe(null, false)], {
        cwd: active, encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome, NODE_OPTIONS: undefined }, timeout: 60_000,
      });
      expect(result.stdout, result.stderr).not.toContain(MARKER);
      expect(result.stdout.trim().split("\n"), result.stderr).toEqual([...HELD.slice(0, 4), ...WORKS()]);
      expect(existsSync(join(theirs, "planted.txt"))).toBe(false);
      const poison = spawnSync("codex", ["sandbox", ...argv, "-P", "standing-orders", "--", "/bin/sh", "-c",
        `mkdir -p stash; ln -s ${q(join(active, "stash"))} ${q(join(pool, "new-project"))}; ln -s ${q(join(active, "stash"))} ${q(join(pool, "app", "new-task"))}`], {
        cwd: active, encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome, NODE_OPTIONS: undefined }, timeout: 60_000,
      });
      expect(poison.status, poison.stderr).not.toBe(0);
      expect(existsSync(join(pool, "new-project"))).toBe(false);
      expect(existsSync(join(pool, "app", "new-task"))).toBe(false);
      expect(existsSync(join(active, "stash"))).toBe(true);
    }
    // Control: the same sandbox without the pool policy reads the foreign marker.
    const { fence, grants } = launch("codex");
    expect(spawnSync("codex", ["sandbox", ...codexFenceArgv(fence, true, { ...grants, pool: undefined }), "-P", "standing-orders", "--", "/bin/sh", "-c", probe(later(), false)], {
      cwd: active, encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome, NODE_OPTIONS: undefined }, timeout: 60_000,
    }).stdout).toContain(MARKER);
    const control = spawnSync("codex", ["sandbox", ...codexFenceArgv(fence, true, { ...grants, pool: undefined }), "-P", "standing-orders", "--", "/bin/sh", "-c",
      `ln -s ${q(join(active, "stash"))} ${q(join(pool, "new-project"))}`], {
      cwd: active, encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome, NODE_OPTIONS: undefined }, timeout: 60_000,
    });
    expect(control.status, control.stderr).toBe(0);
    expect(lstatSync(join(pool, "new-project")).isSymbolicLink()).toBe(true);
  }, 120_000);
});
