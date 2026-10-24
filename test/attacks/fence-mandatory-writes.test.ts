/**
 * Attack: a build planting something that runs later, outside every fence: a Git hook or config, an editor's tasks, an
 * MCP server list or a shell profile in the project. Anthropic's sandbox-runtime denies these names to every write it
 * sandboxes (its DANGEROUS_FILES and dangerous directories, anchored at the launch's own folder, any depth below it),
 * whatever the write mode; Toolroll passes the launch's folder so the runtime anchors them at the checkout. Positive
 * controls: ordinary files beside them stay writable inside, and unsandboxed the same write lands.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, runFolders, taskBoundary, trustedWorktreeBinding, writeAllowlist } from "../../src/agent-fence.js";
import { git, needs, osFence, repository, underSandbox, useScratch, write } from "./harness.js";

const scratch = useScratch("mandatory");

/** A project with a linked worktree in the state folder's pool and a nested repository in it. */
function setup() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true });
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  repository(join(worktree, "vendor-lib"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const fence = (workspace: boolean) => {
    const allowed = workspace ? writeAllowlist({ provider: "command", home, worktree, binding, launchFolder: null, cache: null }) : null;
    return fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
      boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }), writes: allowed === null ? null : { writes: allowed.writes, readOnly: allowed.readOnly } });
  };
  return { root, main, worktree, home, fence };
}

describe("attack: planting what runs later, from inside the fence", () => {
  test("native: the runtime's protected names in the checkout (any depth) can't be written, in either write mode; ordinary files can", ctx => {
    needs(ctx, osFence());
    const { worktree, fence } = setup();
    const denied = [
      join(worktree, ".mcp.json"), join(worktree, ".vscode", "tasks.json"), join(worktree, ".bashrc"), join(worktree, ".gitmodules"),
      join(worktree, "vendor-lib", ".git", "hooks", "post-checkout"), join(worktree, "vendor-lib", ".git", "config"),
      join(worktree, ".claude", "commands", "x.md"), join(worktree, "packages", "app", ".zshrc"),
    ];
    // Linux finds nested names that exist when it launches (the runtime's ripgrep scan).
    if (process.platform === "linux") for (const path of denied) write(path, "existing\n");
    const allowed = [join(worktree, "src", "index.ts"), join(worktree, "notes.txt")];
    for (const workspace of [true, false]) {
      const launch = fence(workspace);
      const script = [...denied, ...allowed].map(path => `mkdir -p "$(dirname ${JSON.stringify(path)})" 2>/dev/null; if echo planted >> ${JSON.stringify(path)} 2>/dev/null; then echo ok; else echo denied; fi`).join("\n");
      // The launch's own folder is the checkout, as a build's is: the runtime anchors its names there.
      const result = underSandbox(script, launch.fence, launch.fenceGrants, { cwd: worktree });
      const said = result.stdout.trim().split("\n");
      expect(denied.map((path, at) => `${said[at]} ${path}`), `${workspace ? "workspace" : "anywhere"}: ${result.stderr}`).toEqual(denied.map(path => `denied ${path}`));
      expect(said.slice(denied.length)).toEqual(allowed.map(() => "ok"));
      for (const path of denied) expect(existsSync(path) && readFileSync(path, "utf8").includes("planted")).toBe(false);
    }
    // Positive control: unsandboxed, the same write lands.
    write(join(worktree, ".mcp.json"), "planted\n");
    expect(readFileSync(join(worktree, ".mcp.json"), "utf8")).toBe("planted\n");
  });
});
