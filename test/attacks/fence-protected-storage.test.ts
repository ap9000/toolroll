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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { codexFenceArgv, fenceFor, runFolders, srtTermsOf, taskBoundary, trustedWorktreeBinding, type FenceGrants, type FencePolicy } from "../../src/agent-fence.js";
import { run } from "../../src/exec.js";
import { prepareProtectedStorage, ProtectedStorageRefusal, protectedStorageDenies, protectedStorageHere, readLook, spawnLook, storageAccessHolder, storageLookScript, storageRefusalOf, type ProtectedStorage, type StorageLook } from "../../src/protected-storage.js";
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
  const fence = (policy: FencePolicy, readDeny: string[] = [], storage?: ProtectedStorage) => fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool],
    boundary: taskBoundary({ worktree, provider: "command", home, binding, policy, ...(storage === undefined ? {} : { storage }) }), readDeny: readDeny.map(one => readDenyPath(one, home)), ...(storage === undefined ? {} : { storage }) });
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

  // Release check 3249 and the 0.9.94 deploy: a listing (or open) inside another app's data waited on a macOS privacy
  // prompt, on the thread that serves everything. Codex round 2: an earlier walk is no proof (a link can move deeper
  // inside a root without changing the root), and a look run with spawnSync still stalled that thread. So every launch
  // awaits its own complete check, run in a child process, and refuses when it can't finish.
  const containerHome = () => {
    const { root, home, worktree, fence } = plane();
    const slack = join(home, "Library/Containers/com.tinyspeck.slackmacgap"), teams = join(home, "Library/Group Containers/UBF8T346G9.com.microsoft.teams");
    for (const [container, at, name] of [[slack, "Data/Stash", "Stash"], [teams, "Moved", "Moved"]] as const) {
      mkdirSync(join(home, name), { recursive: true });
      mkdirSync(join(container, at, ".."), { recursive: true });
      symlinkSync(join(home, name), join(container, at), "dir");
    }
    return { root, home, slack, teams, worktree, fence };
  };
  /** The check's child, run in this process: what protected-storage-look.js answers. */
  const lookHere = (list?: (path: string) => import("node:fs").Dirent[]): StorageLook => async request => {
    const here = protectedStorageHere(request.home, request.env, request.platform, () => {}, list);
    return { kind: "done", storage: { names: here.names, denies: here.denies }, unfinished: here.unfinished };
  };
  const refusalOf = async (pending: Promise<unknown>): Promise<ProtectedStorageRefusal> => {
    try { await pending; } catch (error) { if (error instanceof ProtectedStorageRefusal) return error; throw error; }
    throw new Error("the check didn't refuse");
  };

  test("a nested link moved since an earlier launch is found by this launch's own walk: nothing earlier stands in for it", async () => {
    const { root, home, slack } = containerHome();
    const first = await prepareProtectedStorage(home, {}, "darwin", lookHere(), "the program");
    expect(first.denies).toContain(join(home, "Stash"));
    // Codex's probe: the link deep in the container now leads to another folder; the container itself looks unchanged.
    const elsewhere = join(root, "stash-b");
    mkdirSync(elsewhere);
    rmSync(join(slack, "Data", "Stash"));
    symlinkSync(elsewhere, join(slack, "Data", "Stash"), "dir");
    const second = await prepareProtectedStorage(home, {}, "darwin", lookHere(), "the program");
    expect(second.denies).toContain(realpathSync(elsewhere));
    expect(second.denies).not.toContain(join(home, "Stash"));
  });

  test("a check that doesn't finish refuses the launch, naming the app it was on and the program to allow; it never claims macOS is asking", async () => {
    const { home, slack } = containerHome();
    const refused = await refusalOf(prepareProtectedStorage(home, {}, "darwin", async () => ({ kind: "timed-out", at: realpathSync(slack) }), "the program that keeps Toolroll running (/opt/node)"));
    expect(refused.why).toBe("timed-out");
    expect(refused.apps).toEqual(["Slack"]);
    expect(refused.message).toBe("Nothing was started: Toolroll couldn't finish checking Slack's data for links to keep out of the build (the check didn't finish within 10 seconds). "
      + "macOS may need to let the program that keeps Toolroll running (/opt/node) read it: in System Settings → Privacy & Security → Full Disk Access, turn it on for the program that keeps Toolroll running (/opt/node), then try again.");
    expect(refused.message).not.toMatch(/macOS is asking/);
    expect(storageRefusalOf(refused)).toBe(refused);
    // Timed out before any root: "other apps". A failed check refuses too.
    expect((await refusalOf(prepareProtectedStorage(home, {}, "darwin", async () => ({ kind: "timed-out", at: null }), "x"))).message).toContain("checking other apps' data");
    expect((await refusalOf(prepareProtectedStorage(home, {}, "darwin", async () => ({ kind: "failed", detail: "boom" }), "x"))).why).toBe("failed");
  });

  test("a walk that met an error (not \"not there\" or \"not allowed\") refuses; an unreadable folder is an answer", async () => {
    const { home, slack } = containerHome();
    mkdirSync(join(slack, "Data", "Deep"), { recursive: true });
    if (process.getuid?.() !== 0) {
      chmodSync(join(slack, "Data", "Deep"), 0o000);
      try { expect((await prepareProtectedStorage(home, {}, "darwin", lookHere(), "x")).denies).toContain(join(home, "Stash")); }
      finally { chmodSync(join(slack, "Data", "Deep"), 0o755); }
    }
    const list = (path: string) => {
      if (path.endsWith(join("Data", "Deep"))) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      return readdirSync(path, { withFileTypes: true });
    };
    const refused = await refusalOf(prepareProtectedStorage(home, {}, "darwin", lookHere(list), "x"));
    expect(refused).toMatchObject({ why: "unfinished", apps: ["Slack"] });
  });

  test("checks asked for at once share one child; not on a Mac, the check runs as it is and asks no child", async () => {
    const { home } = containerHome();
    let looks = 0;
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const look: StorageLook = async request => { looks++; await gate; return lookHere()(request); };
    const both = Promise.all([prepareProtectedStorage(home, {}, "darwin", look, "x"), prepareProtectedStorage(home, {}, "darwin", look, "x")]);
    open();
    const [one, two] = await both;
    expect(looks).toBe(1);
    expect(one).toEqual(two);
    // The next launch looks again: a finished check is never kept.
    await prepareProtectedStorage(home, {}, "darwin", look, "x");
    expect(looks).toBe(2);
    await prepareProtectedStorage(home, {}, "linux", async () => { throw new Error("asked"); }, "x");
  });

  test("the program to allow: the background service's program, the terminal app, or the program itself", () => {
    expect(storageAccessHolder({ XPC_SERVICE_NAME: "com.toolroll.plane" }, "/opt/node", {} as NodeJS.ProcessVersions)).toBe("the program that keeps Toolroll running (/opt/node)");
    expect(storageAccessHolder({ XPC_SERVICE_NAME: "0", TERM_PROGRAM: "iTerm.app" }, "/opt/node", {} as NodeJS.ProcessVersions)).toBe("the terminal app Toolroll was started from (iTerm)");
    expect(storageAccessHolder({}, "/opt/node", {} as NodeJS.ProcessVersions)).toBe("the program Toolroll runs as (/opt/node)");
    expect(storageAccessHolder({}, "/x", { electron: "1" } as unknown as NodeJS.ProcessVersions)).toBe("the Toolroll app");
  });

  // Codex round 2, finding 2: the look must never hold this thread. A real child that waits: timers here keep firing.
  test("a real child that waits: this thread's timers keep firing, its limit kills it, and the launch is refused naming the app", async () => {
    const { home, slack } = containerHome();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 25);
    try {
      const waits = `process.stdout.write("at\\t"+JSON.stringify(${JSON.stringify(realpathSync(slack))})+"\\n");setTimeout(()=>{},60000);`;
      const started = Date.now();
      const refused = await refusalOf(prepareProtectedStorage(home, {}, "darwin", async () => readLook(await spawnLook(process.execPath, ["-e", waits], 700)), "x"));
      expect(Date.now() - started).toBeGreaterThanOrEqual(650);
      expect(ticks).toBeGreaterThanOrEqual(10);
      expect(refused).toMatchObject({ why: "timed-out", apps: ["Slack"] });
    } finally { clearInterval(timer); }
    // A child that fails, or answers nothing readable, is a failed check.
    expect(readLook(await spawnLook(process.execPath, ["-e", "process.exit(3)"], 5_000))).toEqual({ kind: "failed", detail: "the check exited with 3" });
    expect(readLook(await spawnLook(process.execPath, ["-e", "process.stdout.write('done\\t{}\\n')"], 5_000))).toMatchObject({ kind: "failed" });
  });

  test.runIf(existsSync(storageLookScript()))("the built child script answers what the check run here answers", async () => {
    const { home } = containerHome();
    const env = { OP_CONFIG_DIR: join(home, "op") };
    const here = protectedStorageHere(realpathSync(home), env, "darwin");
    const ran = readLook(await spawnLook(process.execPath, [storageLookScript(), JSON.stringify({ home: realpathSync(home), env, platform: "darwin" })], 10_000));
    expect(ran).toEqual({ kind: "done", storage: { names: here.names, denies: here.denies }, unfinished: [] });
  });

  // Every road that makes a fence awaits the check first and hands it over; none runs the walk itself.
  test("every launch road hands fenceFor and taskBoundary an awaited check, and nothing in the check waits on this thread", () => {
    const sources = readdirSync("src", { recursive: true, encoding: "utf8" }).filter(path => path.endsWith(".ts") && !path.includes(".test.") && !path.endsWith(".d.ts")).map(path => join("src", path));
    const roads: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const call of text.matchAll(/\b(fenceFor|taskBoundary)\(/g)) {
        if (/function\s+$/.test(text.slice(Math.max(0, call.index - 20), call.index))) continue;
        let depth = 0, at = call.index + call[0].length - 1;
        for (; at < text.length; at++) { if (text[at] === "(") depth++; else if (text[at] === ")" && --depth === 0) break; }
        const args = text.slice(call.index, at);
        roads.push(file);
        expect(/\bstorage\b/.test(args), `${file}: ${args.slice(0, 80)}`).toBe(true);
      }
    }
    expect([...new Set(roads)].sort()).toEqual(["src/coding-provider.ts", "src/eval-oracle.ts", "src/flow-code.ts", "src/invoke.ts", "src/project-tools.ts", "src/release-carry.ts"]);
    const check = readFileSync("src/protected-storage.ts", "utf8");
    expect(check).not.toMatch(/spawnSync|execFileSync|execSync/);
    // The walk run here is only ever the child's, a fallback no launch road takes, or a test's.
    for (const file of sources) {
      if (file === "src/protected-storage.ts" || file === "src/protected-storage-look.ts") continue;
      const text = readFileSync(file, "utf8");
      if (file === "src/agent-fence.ts") { expect(text.match(/protectedStorageDenies\(|protectedStorageNames\(/g)?.length ?? 0, file).toBeLessThanOrEqual(3); continue; }
      expect(/protectedStorage(Here|Denies|Names)\(/.test(text), file).toBe(false);
    }
  });

  // App containers are a macOS idea: elsewhere there is nothing to walk, and the platform-pure tests above cover the logic.
  test.runIf(mac)("native: a link inside a container that leads outward is denied by the launch's own check", async ctx => {
    vi.stubEnv("XDG_CONFIG_HOME", "");
    try {
      const { home, worktree, fence } = containerHome();
      const secret = write(join(home, "Stash", "session"), marker("stash"));
      const storage = await prepareProtectedStorage(home, {}, "darwin", lookHere(), "x");
      const launch = fence(2, [], storage);
      expect(launch.fence).toContain(join(home, "Stash"));
      needs(ctx, osFence());
      expect(execFileSync("cat", [secret], { encoding: "utf8" })).toMatch(/^synthetic-attack-/);
      expect(lines(underSandbox(readScript([secret]), launch.fence, launch.fenceGrants, { cwd: worktree }))).toEqual(["denied"]);
    } finally { vi.unstubAllEnvs(); }
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
