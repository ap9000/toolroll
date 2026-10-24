/**
 * Attack: a build planting what runs for the person next, outside its checkout: a login item, a systemd user unit, a
 * shell profile, Git's or gh's configuration, a sign-in file, or the repository's own Git hooks and config (which its
 * linked worktree reaches through `.git`). Under a write allowlist they are outside what the sandbox runtime lets it
 * write; where a project lets its builds write anywhere they are denied by name (agent-fence.ts homeWriteDenies). An
 * agent's own sign-in stays its own to write. Positive controls: an ordinary home file is written under `anywhere`, and
 * unsandboxed every target is writable.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, homeWriteDenies, runFolders, taskBoundary, trustedWorktreeBinding, writeAllowlist } from "../../src/agent-fence.js";
import { git, needs, osFence, repository, underSandbox, useScratch, write } from "./harness.js";

const scratch = useScratch("home-writes");

function setup() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true });
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const home = join(root, "home");
  const targets = [
    join(home, "Library", "LaunchAgents", "evil.plist"), join(home, ".config", "systemd", "user", "evil.service"), join(home, ".config", "git", "config"),
    join(home, ".config", "gh", "config.yml"), join(home, ".bashrc"), join(home, ".zshrc"), join(home, ".gitconfig"), join(home, ".npmrc"),
    join(home, ".codex", "auth.json"), join(home, ".claude.json"), join(main, ".git", "config"), join(main, ".git", "hooks", "post-checkout"),
  ];
  // The runtime denies on Linux only what is there when a launch starts (an absent one would be made, empty, on the host).
  for (const path of targets) if (!existsSync(path)) write(path, "original\n");
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const fence = (workspace: boolean, provider?: string) => {
    const allowed = workspace ? writeAllowlist({ provider: provider ?? "command", home, worktree, binding, launchFolder: null, cache: null }) : null;
    return fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
      boundary: taskBoundary({ worktree, provider: provider ?? "command", home, binding, policy: 2 }), writes: allowed === null ? null : { writes: allowed.writes, readOnly: allowed.readOnly }, ...(provider === undefined ? {} : { provider }) });
  };
  return { main, worktree, home, targets, binding, fence };
}

const attempt = (paths: readonly string[]) => paths.map(path => `if echo planted >> ${JSON.stringify(path)} 2>/dev/null; then echo written; else echo denied; fi`).join("\n");

describe("attack: planting what runs for the person next, outside the checkout", () => {
  test("the names are denied by name, the agent's own sign-in left its own", () => {
    const { home, main, binding } = setup();
    const denies = homeWriteDenies(home, binding, "command");
    for (const path of [join(home, "Library", "LaunchAgents"), join(home, ".config", "gh"), join(home, ".codex"), join(home, ".claude.json"), join(main, ".git", "hooks")]) expect(denies, path).toContain(path);
    const claude = homeWriteDenies(home, binding, "claude");
    expect(claude).not.toContain(join(home, ".claude.json"));
    expect(claude).toContain(join(home, ".codex"));
  });

  test("native: none of them is written, whether the build writes its workspace or anywhere; an ordinary home file is", ctx => {
    needs(ctx, osFence());
    const { worktree, home, targets, fence } = setup();
    for (const workspace of [true, false]) {
      const launch = fence(workspace);
      const result = underSandbox(attempt([...targets, join(home, "notes.txt")]), launch.fence, launch.fenceGrants, { cwd: worktree });
      const said = result.stdout.trim().split("\n");
      expect(targets.map((path, at) => `${said[at]} ${path}`), `${workspace ? "workspace" : "anywhere"}: ${result.stderr}`).toEqual(targets.map(path => `denied ${path}`));
      expect(said.at(-1)).toBe(workspace ? "denied" : "written");
    }
    for (const path of targets) expect(readFileSync(path, "utf8")).not.toContain("planted");
    // Positive control: unsandboxed, the same writes land.
    const open = spawnSync("/bin/sh", ["-c", attempt(targets)], { cwd: worktree, encoding: "utf8" });
    expect(open.stdout.trim().split("\n")).toEqual(targets.map(() => "written"));
  });
});
