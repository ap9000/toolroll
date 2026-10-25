/**
 * The 0.9.70 review's findings, each as an attack on the sandbox runtime's terms (agent-fence.ts srtTermsOf,
 * homeWriteDenies, serverGrantsOf, codexFenceArgv, protectedChanges), with a positive control.
 *
 * - A tool server never reads its build's checkout back (the build's own-checkout read grant is the agent's alone).
 * - What no launch writes reaches Codex's profile too (read-only there), under Full access.
 * - An agent's own sign-in exemption is its exact sign-in files, never its settings, commands or agents.
 * - A linked ~/.config or LaunchAgents is denied at both ends.
 * - The handoff refuses a protected folder's own name (a link committed as `pkg/.vscode`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexFenceArgv, fenceFor, homeWriteDenies, protectedChanges, protectedLinks, runFolders, sandboxedSpawn, serverGrantsOf, srtTermsOf, taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { codexSandbox, git, needs, osFence, repository, underCodex, underSandbox, useScratch, write } from "./harness.js";

const scratch = useScratch("review-0970");

function plane() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true });
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const launch = (provider = "command") => fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2, provider,
    boundary: taskBoundary({ worktree, provider, home, binding, policy: 2 }) });
  return { root, state, pool, main, worktree, home, binding, launch };
}

describe("the 0.9.70 review's findings", () => {
  test("native: a tool server's fence reads nothing of its build's checkout; the build's own fence does (positive control)", ctx => {
    const { worktree, launch, root } = plane();
    const secret = write(join(worktree, "src", "wrote.ts"), "build-written\n");
    const build = launch();
    // As invoke.ts fences a server: the build's denies, its checkout denied by name, its grants less the agent's own.
    const serverDenies = [...build.fence, realpathSync(worktree)];
    expect(srtTermsOf(serverDenies, serverGrantsOf(build.fenceGrants)).readConfig.allowWithinDeny).not.toContain(realpathSync(worktree));
    needs(ctx, osFence());
    const read = `cat ${JSON.stringify(secret)} 2>/dev/null || echo refused`;
    const server = sandboxedSpawn("/bin/sh", ["-c", read], serverDenies, serverGrantsOf(build.fenceGrants), root);
    expect(spawnSync(server.file, server.args, { cwd: root, encoding: "utf8", env: { ...process.env, ...server.env } }).stdout.trim()).toBe("refused");
    // The build's own grants (its checkout read back) would have read it: the grant was the hole.
    const leaky = sandboxedSpawn("/bin/sh", ["-c", read], serverDenies, build.fenceGrants, root);
    expect(spawnSync(leaky.file, leaky.args, { cwd: root, encoding: "utf8", env: { ...process.env, ...leaky.env } }).stdout.trim()).toBe("build-written");
  });

  test("Codex's profile holds what no launch writes read-only, under Full access too", ctx => {
    const { home, worktree, launch, root } = plane();
    const agents = write(join(home, "Library", "LaunchAgents", "keep.plist"), "original\n");
    // (On Linux the write denies take the names there at launch.)
    for (const name of [".ssh", ".codex"]) mkdirSync(join(home, name), { recursive: true });
    const build = launch();
    const table = codexFenceArgv(build.fence, true, build.fenceGrants).find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
    for (const path of [join(home, "Library", "LaunchAgents"), join(home, ".ssh"), join(home, ".codex")]) expect(table).toContain(`"${realpathSync(home)}${path.slice(home.length)}"="read"`);
    needs(ctx, codexSandbox());
    const probe = `echo planted >> ${JSON.stringify(agents)} 2>/dev/null && echo written || echo refused`;
    const held = underCodex(probe, build.fence, true, build.fenceGrants, { cwd: worktree, codexHome: join(root, "codex-home") });
    expect(held.stdout.trim(), held.stderr).toBe("refused");
    expect(readFileSync(agents, "utf8")).toBe("original\n");
    // Positive control: the same profile without the write denies writes it.
    const open = underCodex(probe, build.fence, true, { ...build.fenceGrants, writeDenies: [] }, { cwd: worktree, codexHome: join(root, "codex-home") });
    expect(open.stdout.trim(), open.stderr).toBe("written");
  });

  test("an agent's own exemption is its exact sign-in files: its settings, commands and agents stay denied", () => {
    const { home, binding } = plane();
    const base = realpathSync(home);
    const claude = homeWriteDenies(home, binding, "claude", "darwin");
    for (const name of [".claude/settings.json", ".claude/settings.local.json", ".claude/commands", ".claude/agents", ".codex"]) expect(claude, name).toContain(join(base, name));
    for (const name of [".claude.json", ".claude/.credentials.json"]) expect(claude, name).not.toContain(join(base, name));
    const codex = homeWriteDenies(home, binding, "codex", "darwin");
    expect(codex).toEqual(expect.arrayContaining([join(base, ".codex"), join(base, ".claude.json"), join(base, ".claude", "settings.json")]));
    // The added persistence points, $XDG_CONFIG_HOME honoured.
    const xdg = join(base, "xdg");
    const listed = homeWriteDenies(home, binding, null, "darwin", { XDG_CONFIG_HOME: xdg });
    for (const name of [".zshenv", ".zlogin", ".bash_login", ".zprofile", ".profile", ".ssh", ".gnupg", ".config/fish", ".config/autostart", ".local/bin", "bin"]) expect(listed, name).toContain(join(base, name));
    expect(listed).toEqual(expect.arrayContaining([join(xdg, "git"), join(xdg, "fish")]));
    // Linux holds only what is there (an absent name's stand-in would be unreadable to the person's own tools).
    write(join(base, ".zshenv"), "x\n");
    const linux = homeWriteDenies(home, binding, null, "linux");
    expect(linux).toContain(join(base, ".zshenv"));
    expect(linux).not.toContain(join(base, ".bash_profile"));
  });

  test("native: a linked ~/.config and a linked LaunchAgents are denied at both ends", ctx => {
    const { home, root, worktree, launch } = plane();
    const realConfig = join(root, "dotfiles", "config");
    const realAgents = join(root, "dotfiles", "agents");
    mkdirSync(join(realConfig, "gh"), { recursive: true });
    mkdirSync(realAgents, { recursive: true });
    write(join(realConfig, "gh", "config.yml"), "original\n");
    symlinkSync(realConfig, join(home, ".config"));
    mkdirSync(join(home, "Library"), { recursive: true });
    symlinkSync(realAgents, join(home, "Library", "LaunchAgents"));
    const denies = homeWriteDenies(home, null, null);
    expect(denies).toEqual(expect.arrayContaining([join(realpathSync(home), ".config", "gh"), join(realpathSync(realConfig), "gh"), realpathSync(realAgents)]));
    needs(ctx, osFence());
    const build = launch();
    const targets = [join(realConfig, "gh", "config.yml"), join(home, ".config", "gh", "config.yml"), join(realAgents, "evil.plist"), join(home, "Library", "LaunchAgents", "evil.plist")];
    const attempt = targets.map(path => `echo planted >> ${JSON.stringify(path)} 2>/dev/null && echo written || echo refused`).join("\n");
    const result = underSandbox(attempt, build.fence, build.fenceGrants, { cwd: worktree });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(targets.map(() => "refused"));
    expect(existsSync(join(realAgents, "evil.plist"))).toBe(false);
    // Positive control: unsandboxed, the same writes land.
    expect(spawnSync("/bin/sh", ["-c", attempt], { encoding: "utf8" }).stdout.trim().split("\n")).toEqual(targets.map(() => "written"));
  });

  test("the handoff refuses a protected folder's own name: a link committed as pkg/.vscode", () => {
    expect(protectedChanges(["pkg/.vscode", ".idea", "a/.claude/commands", "lib/.git/hooks", "src/vscode.ts", "docs/.vscodeignore"])).toEqual(["pkg/.vscode", ".idea", "a/.claude/commands", "lib/.git/hooks"]);
  });

  test("the handoff refuses a staged link at a protected name or a folder on the way to one, at any depth", () => {
    const table: [string, boolean][] = [
      [".claude", true], ["pkg/.claude", true], ["pkg/.CLAUDE", true], [".claude/commands", true], ["a/b/.vscode", true], [".git", true], ["lib/.git", true],
      ["lib/.git/hooks", true], [".mcp.json", true], ["pkg/.envrc", true],
      ["src/claude.ts", false], ["docs/link", false], ["pkg/.claudeignore", false], ["vendor/git", false],
    ];
    expect(protectedLinks(table.map(([path]) => path))).toEqual(table.filter(([, refused]) => refused).map(([path]) => path));
  });

  test("Codex: a linked ~/.ssh that leads into a read-denied folder is denied by its own name, never read back", () => {
    const { home, root, launch } = plane();
    const secret = join(root, "vault");
    write(join(secret, "id"), "secret\n");
    symlinkSync(secret, join(home, ".ssh"));
    const build = launch();
    // The vault is read-denied (as a project's read deny or the state is): its link at ~/.ssh must not read it back.
    const table = codexFenceArgv([...build.fence, realpathSync(secret)], true, build.fenceGrants).find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
    expect(table).toContain(`"${join(realpathSync(home), ".ssh")}"="deny"`);
    expect(table).not.toContain(`"${join(realpathSync(home), ".ssh")}"="read"`);
  });
});
