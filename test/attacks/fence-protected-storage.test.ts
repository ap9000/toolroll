/**
 * Protected storage (docs/plans/chat-management.md §1.1): the person's chat apps, browser profiles and password
 * managers are denied to every launch, under fence policy 1 and 2, on the OS fence (Seatbelt or bubblewrap) and Codex's
 * own sandbox, whatever the project's read settings. Every folder here is a synthetic stand-in in a temporary home
 * folder: no test reads a real app's data.
 *
 * Attacks: a direct read; an alias (a link from the checkout into a protected root); a protected root that is itself a
 * link to a relocated folder; a link inside a protected root pointing outward (a nested link); a root made after the
 * plane's first launch; a configured override (OP_CONFIG_DIR everywhere, XDG_CONFIG_HOME on Linux, a Firefox profile
 * placed elsewhere by profiles.ini); a project read grant that tries to reopen a protected path. And the chat and vault
 * variables never reach a launch. Positive control: unfenced, every canary reads, and an ordinary home file stays
 * readable under policy 2.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { codexFenceArgv, fenceFor, runFolders, srtTermsOf, taskBoundary, trustedWorktreeBinding, type FenceGrants, type FencePolicy } from "../../src/agent-fence.js";
import { run } from "../../src/exec.js";
import { protectedStorageDenies } from "../../src/protected-storage.js";
import { readDenyPath } from "../../src/project-sandbox.js";
import { codexSandbox, git, lines, marker, needs, osFence, repository, underCodex, underSandbox, useScratch, write } from "./harness.js";

const scratch = useScratch("protected-storage");
const mac = process.platform === "darwin";
/** Where each app keeps its data on this platform, relative to home. */
const AT = mac
  ? { slack: "Library/Application Support/Slack", discord: "Library/Application Support/discord", chrome: "Library/Application Support/Google/Chrome",
    telegram: "Library/Application Support/Telegram Desktop", firefox: "Library/Application Support/Firefox" }
  : { slack: ".config/Slack", discord: ".config/discord", chrome: ".config/google-chrome", telegram: ".local/share/TelegramDesktop", firefox: ".mozilla/firefox" };

function plane() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true });
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const home = join(root, "home");
  const canary = {
    // A direct read of a listed root.
    direct: write(join(home, AT.slack, "storage", "token"), marker("slack")),
    // A root that is itself a link to a relocated folder.
    relocated: write(join(root, "relocated", "discord", "Local Storage", "leveldb"), marker("discord")),
    // A link inside a protected root leading outward.
    nested: write(join(root, "profiles", "chrome-default", "Cookies"), marker("chrome")),
    // OP_CONFIG_DIR, read from the plane's own environment.
    override: write(join(root, "op-config", "config"), marker("op")),
    // A Firefox profile profiles.ini places outside its root.
    firefox: write(join(root, "ff-profile", "cookies.sqlite"), marker("firefox")),
    // A profile moved to the home folder under its own name: shaped like a container's system mirror (`X` → `~/X`), but
    // inside a browser's folder, so it is the profile, not the system's (Codex review of 0.9.73, finding 3).
    mirrored: write(join(home, "Profile 1", "Cookies"), marker("chrome-profile")),
    // Not protected: the home folder's ordinary files stay readable under policy 2.
    ordinary: write(join(home, "notes.txt"), marker("ordinary")),
  };
  symlinkSync(join(root, "relocated", "discord"), join(home, AT.discord), "dir");
  mkdirSync(join(home, AT.chrome), { recursive: true });
  symlinkSync(join(root, "profiles", "chrome-default"), join(home, AT.chrome, "Default"), "dir");
  symlinkSync(join(home, "Profile 1"), join(home, AT.chrome, "Profile 1"), "dir");
  write(join(home, AT.firefox, "profiles.ini"), `[Profile0]\nName=default\nIsRelative=0\nPath=${join(root, "ff-profile")}\n`);
  // An alias: a link the build made in its own checkout, into a protected root.
  symlinkSync(join(home, AT.slack), join(worktree, "alias"), "dir");
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const fence = (policy: FencePolicy, readDeny: string[] = []) => fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool],
    boundary: taskBoundary({ worktree, provider: "command", home, binding, policy }), readDeny: readDeny.map(one => readDenyPath(one, home)) });
  return { root, state, home, worktree, canary, fence };
}

const readScript = (paths: readonly string[]) => paths.map(path => `if cat ${JSON.stringify(path)} >/dev/null 2>&1; then echo read; else echo denied; fi`).join("\n");

describe("protected storage: chat apps, browser profiles and password managers, under both policies", () => {
  test("the deny list names every root, the relocated one's real folder, the nested link's target and the overrides", () => {
    vi.stubEnv("OP_CONFIG_DIR", "");
    try {
      const { root, home, canary } = plane();
      vi.stubEnv("OP_CONFIG_DIR", join(root, "op-config"));
      const denies = protectedStorageDenies(home);
      for (const path of [join(home, AT.slack), join(home, AT.telegram), join(home, AT.discord), join(root, "relocated", "discord"), join(root, "profiles", "chrome-default"),
        join(root, "op-config"), join(root, "ff-profile")]) expect(denies, path).toContain(path);
      // Never the home folder itself, nor the ordinary files beside the listed roots.
      expect(denies).not.toContain(home);
      expect(denies.some(path => canary.ordinary.startsWith(`${path}/`))).toBe(false);
      // A mirror-shaped link in a browser's folder is where its profile went: denied on every platform.
      expect(denies).toContain(join(home, "Profile 1"));
    } finally { vi.unstubAllEnvs(); }
  });

  test("only macOS's own links in an app container are passed over; any other outward link there is denied", () => {
    const { home } = plane();
    const slack = join(home, "Library/Containers/com.tinyspeck.slackmacgap"), teams = join(home, "Library/Group Containers/UBF8T346G9.com.microsoft.teams");
    for (const [container, at, name] of [[slack, "Data/Desktop", "Desktop"], [slack, "Data/Library/Fonts", "Library/Fonts"],
      [slack, "Data/Library/Application Scripts/com.tinyspeck.slackmacgap", "Library/Application Scripts/com.tinyspeck.slackmacgap"], [teams, "Downloads", "Downloads"],
      // Not the system's: an unknown name, another app's scripts, a system name outside Data/, and a system name leading elsewhere.
      [slack, "Data/Stash", "Stash"], [slack, "Data/Library/Application Scripts/com.other.app", "Library/Application Scripts/com.other.app"], [slack, "Desktop", "Desktop-moved"],
      [teams, "Pictures", "Elsewhere/Pictures"]] as const) {
      mkdirSync(join(home, name), { recursive: true });
      mkdirSync(join(container, at, ".."), { recursive: true });
      symlinkSync(join(home, name), join(container, at), "dir");
    }
    const denies = protectedStorageDenies(home, {}, "darwin", () => {});
    for (const kept of ["Desktop", "Library/Fonts", "Library/Application Scripts/com.tinyspeck.slackmacgap", "Downloads"]) expect(denies, kept).not.toContain(join(home, kept));
    for (const denied of ["Stash", "Library/Application Scripts/com.other.app", "Desktop-moved", "Elsewhere/Pictures"]) expect(denies, denied).toContain(join(home, denied));
  });

  test("a project read grant or write grant inside protected storage is dropped, whatever the project set", () => {
    const { home, fence } = plane();
    const launch = fence(2, ["~/.config/other"]);
    const inside = join(home, AT.slack, "storage");
    const grants: FenceGrants = { ...launch.fenceGrants, readable: [...launch.fenceGrants.readable, inside], readOnly: [...launch.fenceGrants.readOnly, inside],
      writes: { subpaths: [inside], prefixes: [{ path: join(inside, "token"), suffix: ".*" }] } };
    const terms = srtTermsOf(launch.fence, grants);
    expect(terms.readConfig.denyOnly).toContain(join(home, AT.slack));
    expect(terms.readConfig.allowWithinDeny?.some(path => typeof path === "string" && path.startsWith(join(home, AT.slack)))).toBe(false);
    expect(terms.writeConfig.allowOnly.some(path => path.startsWith(join(home, AT.slack)))).toBe(false);
    expect(terms.writeConfig.denyWithinAllow).toContain(join(home, AT.slack));
    // Codex: the protected root is denied and nothing inside it is granted (it lets the more specific path win).
    const argv = codexFenceArgv(launch.fence, true, grants).join(" ");
    expect(argv).toContain(`"${join(home, AT.slack)}"="deny"`);
    expect(argv).not.toContain(`"${inside}"="read"`);
    expect(argv).not.toContain(`"${inside}"="write"`);
  });

  for (const policy of [1, 2] as const) {
    test(`native: policy ${policy}: direct, alias, relocated, nested, override and profile reads are all denied; a root made after the first launch too`, async ctx => {
      vi.stubEnv("OP_CONFIG_DIR", "");
      try {
        const { root, home, worktree, canary, fence } = plane();
        vi.stubEnv("OP_CONFIG_DIR", join(root, "op-config"));
        // Positive control: unfenced, every canary is a readable file.
        for (const path of Object.values(canary)) expect(execFileSync("cat", [path], { encoding: "utf8" })).toMatch(/^synthetic-attack-/);
        const first = fence(policy);
        needs(ctx, osFence());
        const paths = [canary.direct, join(worktree, "alias", "storage", "token"), join(home, AT.discord, "Local Storage", "leveldb"), canary.relocated,
          join(home, AT.chrome, "Default", "Cookies"), canary.nested, canary.override, canary.firefox, canary.mirrored, canary.ordinary];
        const result = underSandbox(readScript(paths), first.fence, first.fenceGrants, { cwd: worktree });
        // Every protected path denied; the ordinary home file read under v2 and denied by nothing it names under v1.
        expect(lines(result), result.stderr).toEqual([...paths.slice(0, -1).map(() => "denied"), "read"]);
        // A root made after the plane's first launch: denied at the next launch (and by name at the first, on a Mac).
        const later = write(join(home, AT.telegram, "tdata", "key_datas"), marker("telegram"));
        expect(execFileSync("cat", [later], { encoding: "utf8" })).toMatch(/^synthetic-attack-/);
        const next = fence(policy);
        expect(lines(underSandbox(readScript([later]), next.fence, next.fenceGrants, { cwd: worktree }))).toEqual(["denied"]);
        if (mac) expect(lines(underSandbox(readScript([later]), first.fence, first.fenceGrants, { cwd: worktree }))).toEqual(["denied"]);
        // A project read setting can only add denies: listing an ordinary path never reopens a protected one.
        const listed = fence(policy, ["~/notes.txt"]);
        expect(lines(underSandbox(readScript([canary.direct, canary.ordinary]), listed.fence, listed.fenceGrants, { cwd: worktree }))).toEqual(["denied", "denied"]);
      } finally { vi.unstubAllEnvs(); }
    });
  }

  test("native: a protected root the build tries to make now (to swap in a link later) can't be made", async ctx => {
    const { home, worktree, fence } = plane();
    const launch = fence(2);
    needs(ctx, osFence());
    const target = join(home, AT.telegram);
    const result = underSandbox(`mkdir -p ${JSON.stringify(join(target, "tdata"))} 2>/dev/null; ln -s /tmp ${JSON.stringify(join(target, "planted"))} 2>/dev/null; echo done`, launch.fence, launch.fenceGrants, { cwd: worktree });
    expect(lines(result)).toEqual(["done"]);
    expect(spawnSync("test", ["-e", join(target, "planted")]).status).not.toBe(0);
  });

  test.runIf(process.platform === "linux")("native (Linux): an XDG_CONFIG_HOME override is denied too", async ctx => {
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      const { root, worktree, fence } = plane();
      const xdg = join(root, "xdg");
      const secret = write(join(xdg, "Slack", "storage", "token"), marker("xdg"));
      vi.stubEnv("XDG_CONFIG_HOME", xdg);
      const launch = fence(2);
      needs(ctx, osFence());
      expect(lines(underSandbox(readScript([secret]), launch.fence, launch.fenceGrants, { cwd: worktree }))).toEqual(["denied"]);
    } finally { vi.unstubAllEnvs(); }
  });

  for (const policy of [1, 2] as const) {
    test(`native: Codex's sandbox, policy ${policy}: the same reads are denied`, async ctx => {
      const { root, home, worktree, canary, fence } = plane();
      const launch = fence(policy);
      needs(ctx, codexSandbox());
      const paths = [canary.direct, join(worktree, "alias", "storage", "token"), canary.relocated, join(home, AT.chrome, "Default", "Cookies"), canary.nested, canary.firefox, canary.mirrored];
      const result = underCodex(readScript(paths), launch.fence, false, launch.fenceGrants, { cwd: worktree, codexHome: join(root, "codex-home") });
      expect(lines(result), result.stderr).toEqual(paths.map(() => "denied"));
    });
  }

  test("native: no chat or vault variable reaches a fenced launch", async ctx => {
    const { worktree, fence } = plane();
    const launch = fence(2);
    needs(ctx, osFence());
    const names = ["SLACK_TOKEN", "TELEGRAM_BOT_TOKEN", "DISCORD_TOKEN", "TEAMS_WEBHOOK", "OP_SESSION_my", "BW_SESSION", "BITWARDENCLI_APPDATA_DIR"];
    const env = { ...process.env, NODE_OPTIONS: undefined, ...Object.fromEntries(names.map(name => [name, marker(name.toLowerCase())])), KEPT_VARIABLE: "kept" };
    const printed = await run("/usr/bin/env", [], { cwd: worktree, env, fence: launch.fence, fenceGrants: launch.fenceGrants, confinement: "required" });
    expect(printed.code, printed.stderr).toBe(0);
    for (const name of names) expect(printed.stdout).not.toContain(`${name}=`);
    expect(printed.stdout).toContain("KEPT_VARIABLE=kept");
  });
});
