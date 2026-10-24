/**
 * Attack: a build planting something that runs later, outside every fence (docs/plans/sandbox-parity.md C8): a Git
 * hook or config, an editor's tasks or an MCP server list in the project, a shell profile, LaunchAgent, `.envrc` or a
 * package manager's config in the home folder. Anthropic's sandbox runtime denies these names to every write; so does
 * Toolroll now, in every mode (the home folder's under `writes: anywhere`, where it was writable), with only the exact
 * files an approval unlocked given back; and a result that wrote one anyway (Linux, Codex) is refused at the handoff.
 * Positive controls: unsandboxed every write lands, and ordinary files beside them stay writable inside.
 */
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, linuxFenced, macosFenced, macosFenceProfile, protectedChanges, runFolders, taskBoundary, toolrollInstall, trustedWorktreeBinding, validUnlock } from "../../src/agent-fence.js";
import { nativeSeccomp } from "../seccomp-fixture.js";
import { codexSandbox, git, needs, osFence, repository, underCodex, useScratch, write } from "./harness.js";

const scratch = useScratch("mandatory");

/** A project with a linked worktree in the state folder's pool, a nested repository in it, and a home of its own. */
function setup(unlock: string[] = []) {
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
  /** The launch's fence as fenceFor makes it right before the spawn (it looks at what exists then). */
  const fence = () => fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, boundary: taskBoundary({ worktree, provider: "command", home, binding }), binding,
    runFolders: runFolders(null), poolRoots: [pool], unlock });
  return { root, main, worktree, home, launch: fence(), fence };
}

/** Each target written (one line each: `<path> ok|denied`), in the OS fence, without blocking this process. */
function writeEach(targets: string[], launch: ReturnType<typeof setup>["launch"], cwd: string): Promise<string[]> {
  const script = targets.map(path => `mkdir -p "$(dirname ${JSON.stringify(path)})" 2>/dev/null; if echo planted >> ${JSON.stringify(path)} 2>/dev/null; then echo ok; else echo denied; fi`).join("\n");
  const wrapped = process.platform === "darwin" ? macosFenced("/bin/sh", ["-c", script], launch.fence, launch.fenceGrants)
    : linuxFenced("/bin/sh", ["-c", script], launch.fence, { ...launch.fenceGrants, seccomp: nativeSeccomp()! });
  return new Promise(done => {
    const child = spawn(wrapped.file, wrapped.args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => done(out.trim().split("\n")));
  });
}

describe("attack: planting what runs later, from inside the fence", () => {
  test("policy: srt's names, Q-B's, the package managers' and Toolroll's own install; unlocks only exact protected files", () => {
    const { launch, worktree, main } = setup([".vscode/settings.json"]);
    const mandatory = launch.fenceGrants.mandatory!;
    expect(mandatory.unlock).toEqual([join(worktree, ".vscode", "settings.json")]);
    expect(mandatory.git).toEqual(expect.arrayContaining([join(main, ".git", "config"), join(main, ".git", "hooks")]));
    for (const path of toolrollInstall(worktree, "/nonexistent-home")) expect(launch.fenceGrants.readOnly).toContain(path);
    expect([".vscode/settings.json", ".mcp.json", "packages/a/.envrc", ".claude/settings.local.json"].every(validUnlock)).toBe(true);
    expect(["README.md", "../.zshrc", "/etc/x", ".git/hooks/pre-commit", ".vscode/*", ".vscode"].some(validUnlock)).toBe(false);
    if (process.platform === "darwin") expect(launch.fenceGrants.mandatory!.anchors).toEqual([worktree]);
  });

  test("native: protected names in the checkout (any depth, any case), its Git data and the home folder can't be written; ordinary files can", async ctx => {
    needs(ctx, osFence());
    const { worktree, home, main, fence } = setup([".vscode/settings.json"]);
    const denied = [
      join(worktree, ".mcp.json"), join(worktree, ".vscode", "tasks.json"), join(worktree, "packages", "app", ".envrc"),
      join(worktree, "vendor-lib", ".git", "hooks", "post-checkout"), join(worktree, "vendor-lib", ".git", "config"),
      join(worktree, ".claude", "settings.json"), join(main, ".git", "hooks", "pre-commit"), join(main, ".git", "config"),
      join(home, ".zshrc"), join(home, ".npmrc"), join(home, ".gitconfig"), join(home, "Library", "LaunchAgents", "evil.plist"), join(home, ".config", "git", "config"),
      ...(process.platform === "darwin" ? [join(worktree, "sub", ".MCP.json"), join(worktree, ".VsCode", "x.json")] : []),
    ];
    // Linux binds only names that exist at launch read-only: those made later are the handoff's (below).
    if (process.platform === "linux") for (const path of denied) write(path, "existing\n");
    const allowed = [join(worktree, "src", "index.ts"), join(worktree, ".vscode", "settings.json"), join(home, "notes.txt")];
    // The project already has its .vscode folder (an unlocked file is written in it, never a protected folder made).
    write(join(worktree, ".vscode", "settings.json"), "{}\n");
    const results = await writeEach([...denied, ...allowed], fence(), worktree);
    expect(denied.map((path, at) => `${results[at]} ${path}`)).toEqual(denied.map(path => `denied ${path}`));
    expect(results.slice(denied.length)).toEqual(allowed.map(() => "ok"));
    for (const path of denied) expect(existsSync(path) && readFileSync(path, "utf8").includes("planted")).toBe(false);
  });

  test("an unlock planted as a link (to a file elsewhere, or a hard link) or under a linked folder grants nothing", async ctx => {
    const { worktree, home, root, fence } = setup([".envrc", ".vscode/settings.json", "pkg/.npmrc"]);
    // What a build could plant at the unlocked names: a symbolic link to the home folder's profile, a hard link to an
    // ordinary file outside the checkout, and a linked folder carrying the third name out.
    const profile = write(join(home, ".bashrc"), "original\n");
    const elsewhere = write(join(root, "outside", "notes.txt"), "original\n");
    symlinkSync(profile, join(worktree, ".envrc"));
    mkdirSync(join(worktree, ".vscode"));
    linkSync(elsewhere, join(worktree, ".vscode", "settings.json"));
    symlinkSync(join(root, "outside"), join(worktree, "pkg"));
    const launch = fence();
    expect(launch.fenceGrants.mandatory!.unlock).toEqual([]);
    expect(macosFenceProfile(launch.fence, launch.fenceGrants)).not.toMatch(/\(allow file-write\* \(literal [^)]*(\.envrc|settings\.json|\.npmrc)/);
    needs(ctx, osFence());
    // On Linux a protected name that is a link out of the checkout, to somewhere this build could write, has no fence.
    if (process.platform === "linux") {
      expect(() => linuxFenced("/bin/true", [], launch.fence, { ...launch.fenceGrants, seccomp: nativeSeccomp()! })).toThrow(/leads to .*which this build could write/);
      return;
    }
    const results = await writeEach([join(worktree, ".envrc"), join(worktree, ".vscode", "settings.json")], launch, worktree);
    expect(results).toEqual(["denied", "denied"]);
    expect(readFileSync(profile, "utf8")).toBe("original\n");
    expect(readFileSync(elsewhere, "utf8")).toBe("original\n");
  });

  test("native Codex: protected names that exist are read-only in its profile; ordinary files stay writable", ctx => {
    needs(ctx, codexSandbox());
    const { worktree, root, fence } = setup();
    const targets = [join(worktree, ".mcp.json"), join(worktree, ".vscode", "tasks.json"), join(worktree, "src", "ok.ts")];
    for (const path of targets) write(path, "existing\n");
    const launch = fence();
    const ran = underCodex(targets.map(path => `if echo planted >> ${JSON.stringify(path)} 2>/dev/null; then echo ok; else echo denied; fi`).join("\n"), launch.fence, true, launch.fenceGrants, { cwd: worktree, codexHome: join(root, "codex-home") });
    expect(ran.stdout.trim().split("\n"), ran.stderr).toEqual(["denied", "denied", "ok"]);
  });

  test("the handoff refuses a result that wrote a protected name, unless that exact file was unlocked", () => {
    expect(protectedChanges(["src/a.ts", ".mcp.json", "packages/x/.vscode/tasks.json", "lib/.git/hooks/x", "README.md", "a/.Envrc", ".vscode/settings.json"], [".vscode/settings.json"]))
      .toEqual([".mcp.json", "packages/x/.vscode/tasks.json", "lib/.git/hooks/x", "a/.Envrc"]);
    expect(protectedChanges(["docs/vscode.md", "src/mcp.json.ts"])).toEqual([]);
  });
});
