/**
 * The Linux sandbox's programs (sandbox-runtime.ts LINUX_SANDBOX_TOOLS) are one list: the runtime's own check asks for
 * nothing outside it, a missing one is found and named with the line that installs it, and install.sh, the Linux guide
 * and the README name exactly these. Every PATH here is a temp folder of stubs.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkLinuxDependencies } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { LINUX_SANDBOX_TOOLS, SANDBOX_LAUNCH_SPEC, linuxSandboxInstallLine, missingLinuxSandboxTools, sandboxRuntimeProblem, srtSpawn, type SandboxLaunchSpec, type SrtTerms } from "./sandbox-runtime.js";
import { managerLine, packageSystem } from "./linux-packages.js";
import { checkSeccompHelper, resolveLinuxSandboxTools, sandboxToolsRepair, sandboxToolExclusions, seccompHelperPath, verifyLinuxSandboxTools, type LinuxSandboxTools, type ToolTrust } from "./sandbox-tools.js";
import { toolrollInstall } from "./agent-fence.js";
import { outsideTempDir } from "../test/short-temp.js";

const root = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
let bin: string;
let savedPath: string | undefined;
const stub = (name: string, mode = 0o755) => { writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, name), mode); };

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "so-srt-tools-"));
  savedPath = process.env["PATH"];
});
afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
  rmSync(bin, { recursive: true, force: true });
});

describe("the Linux sandbox's programs: one list", () => {
  test("every program the runtime's own check says is not installed is on the list", () => {
    // The runtime looks programs up with `which` on this process's PATH: only `which` is there.
    symlinkSync("/usr/bin/which", join(bin, "which"));
    process.env["PATH"] = bin;
    const named = checkLinuxDependencies().errors.filter(error => /not installed/.test(error));
    expect(named.length).toBeGreaterThan(0);
    for (const error of named) expect(LINUX_SANDBOX_TOOLS.some(tool => error.includes(tool.command)), error).toBe(true);
    // With every listed program there, the runtime names none missing.
    // `which` is the real one linked above (never written through).
    for (const tool of LINUX_SANDBOX_TOOLS) if (tool.command !== "which") stub(tool.command);
    expect(checkLinuxDependencies().errors.filter(error => /not installed/.test(error))).toEqual([]);
  });

  test("a missing program is found and named by its package, with the line that installs it", () => {
    stub("bwrap");
    stub("bash");
    stub("which");
    stub("rg", 0o644); // not executable: not there
    expect(missingLinuxSandboxTools(bin)).toEqual(["socat", "ripgrep"]);
    expect(missingLinuxSandboxTools("")).toEqual(["bubblewrap", "socat", "ripgrep", "bash", "which"]);
    stub("socat");
    stub("rg");
    expect(missingLinuxSandboxTools(bin)).toEqual([]);
    process.env["PATH"] = join(bin, "nothing-here");
    expect(sandboxRuntimeProblem("linux")).toBe(`bubblewrap, socat, ripgrep, bash and which are not installed (${linuxSandboxInstallLine(["bubblewrap", "socat", "ripgrep", "bash", "which"])})`);
  });

  test.each([
    ["apt", false, "sudo apt update && sudo apt install bubblewrap socat ripgrep bash debianutils"],
    ["apt", true, "apt update && apt install bubblewrap socat ripgrep bash debianutils"],
    ["dnf", false, "sudo dnf install bubblewrap socat ripgrep bash which"],
    ["zypper", false, "sudo zypper install bubblewrap socat ripgrep bash which"],
    ["pacman", false, "sudo pacman -S --needed bubblewrap socat ripgrep bash which"],
    ["apk", true, "apk add bubblewrap socat ripgrep bash which"],
  ] as const)("the install line for %s (root: %s) uses its own manager and package names, sudo only when not root", (manager, isRoot, line) => {
    expect(linuxSandboxInstallLine(undefined, { manager, root: isRoot })).toBe(line);
    // Found by the manager's fixed system path; none found: every manager's line, named.
    expect(packageSystem(path => path === { apt: "/usr/bin/apt-get", dnf: "/usr/bin/dnf", zypper: "/usr/bin/zypper", pacman: "/usr/bin/pacman", apk: "/sbin/apk" }[manager], isRoot ? 0 : 1000)).toEqual({ manager, root: isRoot });
  });

  test("install.sh, the Linux guide and the README name exactly these", () => {
    expect(root("install.sh")).toContain(`for tool in ${LINUX_SANDBOX_TOOLS.map(tool => `${tool.command}:${tool.package}`).join(" ")}; do`);
    const packages = LINUX_SANDBOX_TOOLS.map(tool => tool.package);
    expect(linuxSandboxInstallLine(undefined, { manager: null, root: false }).split("; ")).toEqual([
      `${managerLine("apt", packages, false)} (Debian, Ubuntu)`, `${managerLine("dnf", packages, false)} (Fedora)`, `${managerLine("zypper", packages, false)} (openSUSE)`,
      `${managerLine("pacman", packages, false)} (Arch)`, `${managerLine("apk", packages, false)} (Alpine)`]);
    const guide = root("docs/guide/linux.md");
    for (const manager of ["apt", "dnf", "zypper", "pacman", "apk"] as const) expect(guide).toContain(managerLine(manager, packages, false));
    expect(root("README.md")).toContain(managerLine("apt", packages, false));
    expect(root("docs/guide/getting-started.md")).toContain(managerLine("apt", packages, false));
  });
});

describe("the Linux sandbox's own programs: root's own, by exact path, checked again at every launch", () => {
  const SYSTEM = ["bwrap", "socat", "bash", "rg", "which"] as const;
  const me = process.getuid?.() ?? 0;
  /** This test's uid stands in for root (only root can make root's files), and for the owner of Toolroll's code. */
  const standIn: ToolTrust = { root: [0, me], codeOwner: me };
  let world: string;
  beforeEach(() => { world = outsideTempDir("so-srt-root-"); chmodSync(world, 0o755); });
  afterEach(() => { rmSync(world, { recursive: true, force: true }); });
  /** A folder of stand-ins for the programs (0755, this user's); `skip` names ones left out. */
  const folder = (name: string, skip: readonly string[] = [], mode = 0o755): string => {
    const dir = join(world, name);
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    for (const tool of SYSTEM.filter(one => !skip.includes(one))) { writeFileSync(join(dir, tool), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, tool), mode); }
    return realpathSync(dir);
  };
  const helper = (dir: string): string => { writeFileSync(join(dir, "apply-seccomp"), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, "apply-seccomp"), 0o755); return join(dir, "apply-seccomp"); };
  const terms = (cwd: string): SrtTerms => ({ readConfig: { denyOnly: [] }, writeConfig: { allowOnly: ["/", cwd], denyWithinAllow: [] }, allowMachLookup: [], network: { kind: "open" } });
  /** Long enough for the kernel's coarse clock to move on, so a file made now has a later change time. */
  const pause = (): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); };
  const found = (verdict: ReturnType<typeof resolveLinuxSandboxTools>): LinuxSandboxTools => { if (!verdict.ok) throw new Error(verdict.why); return verdict.tools; };

  test("an untrusted bwrap earlier on PATH, or listed first, is never used: the launch gets root's by exact path", () => {
    const system = folder("system");
    const seccomp = helper(system);
    const planted = folder("planted", [], 0o777);
    process.env["PATH"] = `${planted}:${system}:${process.env["PATH"] ?? ""}`;
    const tools = found(resolveLinuxSandboxTools({ ...standIn, folders: [planted, system], seccomp }));
    for (const tool of SYSTEM) expect(tools[tool].real).toBe(join(system, tool));
    expect(tools.whichFolder).toBe(system);
    const cwd = folder("project", SYSTEM);
    const launch = srtSpawn("/bin/true", [], terms(cwd), cwd, undefined, "linux", exclusions => resolveLinuxSandboxTools({ ...standIn, folders: [planted, system], seccomp, exclusions }));
    const spec = JSON.parse(launch.env[SANDBOX_LAUNCH_SPEC]!) as SandboxLaunchSpec;
    expect(spec.tools.bwrap.real).toBe(join(system, "bwrap"));
    expect(JSON.stringify(spec.tools)).not.toContain(planted);
  });

  test("a program not owned by root (a user's own copy, as one in /usr/local/bin) is refused, and the person is told what to install", () => {
    const users = folder("usr-local-bin");
    const refused = resolveLinuxSandboxTools({ folders: [users], root: [0], codeOwner: me, seccomp: helper(users) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.why).toContain(`${join(users, "bwrap")}: ${join(users, "bwrap")} isn't owned by root`);
      expect(refused.why).toContain(`install bubblewrap from your system package manager (${linuxSandboxInstallLine(["bubblewrap"])})`);
    }
  });

  test("ripgrep only in ~/.cargo/bin (on PATH) is never used: the person is told to install it from the system's package manager", () => {
    const system = folder("system", ["rg"]);
    process.env["PATH"] = `${folder("cargo-bin")}:${system}`;
    expect(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp: helper(system) })).toEqual({ ok: false, failure: "missing",
      why: `ripgrep (rg) has no copy owned by root in ${system}: install ripgrep from your system package manager (${linuxSandboxInstallLine(["ripgrep"])})` });
  });

  test("a cached program swapped or loosened between launches is refused on the next launch", () => {
    const system = folder("system");
    const seccomp = helper(system);
    const tools = found(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp }));
    expect(verifyLinuxSandboxTools(tools, { ...standIn, seccomp })).toBeNull();
    // Another file in its place (same name, same owner, same mode): not the program that was checked, even where the
    // system hands the freed inode straight to it (Linux does): its change time is the kernel's, not the old one.
    unlinkSync(join(system, "bwrap"));
    pause();
    writeFileSync(join(system, "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(verifyLinuxSandboxTools(tools, { ...standIn, seccomp })).toBe(`bwrap (${join(system, "bwrap")}) changed since it was checked`);
    const work = folder("work", SYSTEM);
    const launch = () => srtSpawn("/bin/true", [], terms(work), work, undefined, "linux", exclusions => {
      const why = verifyLinuxSandboxTools(tools, { ...standIn, seccomp, exclusions });
      return why === null ? { ok: true, tools } : { ok: false, why };
    });
    expect(launch).toThrow("changed since it was checked");
    // Made writable by others: refused too.
    const again = found(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp }));
    chmodSync(join(system, "socat"), 0o777);
    expect(verifyLinuxSandboxTools(again, { ...standIn, seccomp })).toMatch(/^socat .*others can change/);
  });

  test("a program reached through a link into the launch's checkout is refused", () => {
    const project = folder("project");
    const linked = join(world, "linked");
    mkdirSync(linked, { mode: 0o755 });
    for (const tool of SYSTEM) symlinkSync(join(project, tool), join(linked, tool));
    const refused = resolveLinuxSandboxTools({ ...standIn, folders: [linked], seccomp: helper(folder("pkg", SYSTEM)), exclusions: sandboxToolExclusions(terms(project), project) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain(`${join(project, "bwrap")} is inside a project, worktree or Toolroll's own folder`);
  });

  test("the seccomp helper is exactly Toolroll's own sandbox-runtime's: one planted on PATH or in a user npm folder is never used", () => {
    const system = folder("system");
    const planted = folder("npm-global", SYSTEM);
    const fake = helper(planted);
    mkdirSync(join(planted, "lib", "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor", "seccomp", "x64"), { recursive: true });
    process.env["PATH"] = `${planted}:${system}`;
    process.env["npm_config_prefix"] = planted;
    try {
      const tools = found(resolveLinuxSandboxTools({ ...standIn, folders: [system] }));
      expect(tools.seccomp.real).toBe(realpathSync(seccompHelperPath()!));
      // Handed any other helper, however well kept, a launch refuses it.
      const swapped = { ...tools, seccomp: found(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp: fake })).seccomp };
      expect(verifyLinuxSandboxTools(swapped, standIn)).toBe(`the seccomp helper (${fake}) isn't Toolroll's own sandbox-runtime's`);
    } finally { delete process.env["npm_config_prefix"]; }
  });

  test("an installed program that fails its check is a trust failure with its paths, not missing; the repair covers it and every folder above, and then it passes", () => {
    const run = (commands: readonly string[]) => { for (const one of commands) expect(spawnSync("/bin/sh", ["-c", one]).status, one).toBe(0); };
    // A writable bwrap (the others fine).
    const system = folder("system");
    const seccomp = helper(system);
    chmodSync(join(system, "bwrap"), 0o777);
    const writable = resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp });
    expect(writable).toMatchObject({ ok: false, failure: "untrusted", rejected: [join(system, "bwrap")] });
    expect(!writable.ok && writable.why).toMatch(/^bubblewrap \(bwrap\) has no copy Toolroll can trust in .*fix those paths \(`toolroll doctor` prints how\), or install bubblewrap/);
    const fileRepair = sandboxToolsRepair({ ...standIn, folders: [system], seccomp }, null)!;
    expect(fileRepair.commands).toEqual([`chmod go-w '${join(system, "bwrap")}'`]);
    run(fileRepair.commands);
    expect(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp }).ok).toBe(true);
    // A writable folder above every program: each of them fails, and one command fixes the folder.
    chmodSync(system, 0o775);
    expect(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp })).toMatchObject({ ok: false, failure: "untrusted" });
    const folderRepair = sandboxToolsRepair({ ...standIn, folders: [system], seccomp }, null)!;
    expect(folderRepair.commands).toEqual([`chmod go-w '${system}'`]);
    run(folderRepair.commands);
    expect(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp }).ok).toBe(true);
    expect(sandboxToolsRepair({ ...standIn, folders: [system], seccomp }, null)).toBeNull();
    // A copy this user owns where only root's count: why, and the package manager, never a chown.
    const users = folder("usr-local-bin");
    const mine = sandboxToolsRepair({ folders: [users], root: [0], codeOwner: me, seccomp: helper(users) }, null)!;
    expect(mine.commands.some(one => one.startsWith("chown"))).toBe(false);
    expect(mine.notes.join(" ")).toContain(`${join(users, "bwrap")} is yours, but the sandbox runs only programs root owns`);
  });

  test("a missing program refuses with a plain reason, and nothing falls back to a PATH lookup", () => {
    const system = folder("system", ["socat"]);
    process.env["PATH"] = folder("on-path");
    const resolved = resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp: helper(system) });
    expect(resolved).toEqual({ ok: false, failure: "missing", why: `socat has no copy owned by root in ${system}: install socat from your system package manager (${linuxSandboxInstallLine(["socat"])})` });
    if (!resolved.ok) expect(() => srtSpawn("/bin/true", [], terms(system), system, undefined, "linux", () => resolved)).toThrow(resolved.why);
  });

  test("the launch helper checks the programs again itself: none, malformed or not root's, and nothing starts", () => {
    const system = folder("system");
    const tools = found(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp: helper(system) }));
    const cwd = folder("work", SYSTEM);
    const base: Omit<SandboxLaunchSpec, "tools"> = { file: "/bin/true", args: [], cwd, terms: terms(cwd) };
    for (const [given, said] of [
      [undefined, "the sandbox's programs weren't given by checked paths"],
      [{ ...tools, bwrap: { real: "bwrap", id: tools.bwrap.id } }, "the sandbox's programs weren't given by checked paths"],
      // Well formed, but this user's files: the helper accepts only root's.
      [tools, `bwrap (${join(system, "bwrap")}): ${join(system, "bwrap")} isn't owned by root`],
    ] as const) {
      const ran = spawnSync(process.execPath, ["--import", "tsx", "src/sandbox-launch.ts"], {
        cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000,
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", [SANDBOX_LAUNCH_SPEC]: JSON.stringify(given === undefined ? base : { ...base, tools: given }) },
      });
      expect(ran.status, ran.stderr).toBe(126);
      expect(ran.stderr).toContain(`toolroll sandbox: nothing was started: ${said}`);
    }
  });

  describe("a seccomp helper Toolroll's user owns is write-protected exactly as Toolroll's code is", () => {
    /** Only real root counts as root here: the stand-in package is this user's, as a user's npm install is. */
    const usersOwn: ToolTrust = { root: [0], codeOwner: me };
    /** A stand-in package: its JavaScript in dist/, its vendor folder a link to `elsewhere`, where the helper is. */
    const pkg = () => {
      const root = folder("pkg", SYSTEM);
      mkdirSync(join(root, "dist"), { mode: 0o755 });
      const elsewhere = join(world, "elsewhere");
      mkdirSync(join(elsewhere, "seccomp", "x64"), { recursive: true, mode: 0o755 });
      for (const dir of [elsewhere, join(elsewhere, "seccomp"), join(elsewhere, "seccomp", "x64")]) chmodSync(dir, 0o755);
      helper(join(elsewhere, "seccomp", "x64"));
      symlinkSync(elsewhere, join(root, "vendor"));
      return { root, helper: join(root, "vendor", "seccomp", "x64", "apply-seccomp"), target: join(realpathSync(elsewhere), "seccomp", "x64", "apply-seccomp") };
    };
    const writes = (allowOnly: string[], denyWithinAllow: string[], literalAllowOnly?: string[]): SrtTerms =>
      ({ readConfig: { denyOnly: [] }, writeConfig: { allowOnly, denyWithinAllow, ...(literalAllowOnly === undefined ? {} : { literalAllowOnly }) }, allowMachLookup: [], network: { kind: "open" } });

    test("the code write-denied but the helper's target, through a vendor link, writable by the launch: refused", () => {
      const { root, helper: path, target } = pkg();
      const work = folder("work", SYSTEM);
      const attack = checkSeccompHelper(path, sandboxToolExclusions(writes([work, join(world, "elsewhere")], [root]), work), usersOwn);
      expect(attack).toEqual({ ok: false, why: expect.stringContaining(`the launch may write ${target}`) });
      // The literal write roots count the same.
      const literal = checkSeccompHelper(path, sandboxToolExclusions(writes([work], [root], [join(world, "elsewhere")]), work), usersOwn);
      expect(literal).toEqual({ ok: false, why: expect.stringContaining(`the launch may write ${target}`) });
      // The install tree's denies covering the code only, not the target the link leads to: refused.
      expect(checkSeccompHelper(path, sandboxToolExclusions(writes([work], [root]), work), usersOwn)).toEqual({ ok: false, why: `the fence's install-tree write denies don't cover ${target}` });
      // Covered where it really is, and nothing above it writable: served (the positive control).
      expect(checkSeccompHelper(path, sandboxToolExclusions(writes([work], [root, dirname(target)]), work), usersOwn)).toMatchObject({ ok: true, tool: { real: target } });
    });

    test("a launch that may write anywhere (`/`) is served a user-owned helper only inside the install denies, as the code is", () => {
      const { root, helper: path, target } = pkg();
      const work = folder("work", SYSTEM);
      const covered = sandboxToolExclusions(writes(["/", work], [root, dirname(target)]), work);
      expect(covered.writes?.allow).toContain("/");
      expect(checkSeccompHelper(path, covered, usersOwn)).toMatchObject({ ok: true, tool: { real: target } });
      // The code covered but not the helper's target the vendor link leads to: writable, refused.
      expect(checkSeccompHelper(path, sandboxToolExclusions(writes(["/", work], [root]), work), usersOwn)).toEqual({ ok: false, why: `the launch may write ${target}, and the helper isn't root's own` });
    });

    test("the install's folder renamed between launches, and another put in its place, refuses the next launch", () => {
      const system = folder("system");
      const { helper: path, target } = pkg();
      const tools = found(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp: path }));
      expect(tools.seccomp.real).toBe(target);
      expect(verifyLinuxSandboxTools(tools, { ...standIn, seccomp: path })).toBeNull();
      const install = dirname(dirname(target));
      renameSync(install, `${install}-moved`);
      // Gone from where it was: the path no longer resolves.
      expect(verifyLinuxSandboxTools(tools, { ...standIn, seccomp: path })).toMatch(/^seccomp .*isn't there/);
      // Another install at the same path: the same canonical path, another file.
      pause();
      mkdirSync(join(install, "x64"), { recursive: true, mode: 0o755 });
      for (const dir of [install, join(install, "x64")]) chmodSync(dir, 0o755);
      helper(join(install, "x64"));
      expect(verifyLinuxSandboxTools(tools, { ...standIn, seccomp: path })).toBe(`seccomp (${target}) changed since it was checked`);
    });

    test("no sticky pass: a helper below a sticky, world-writable folder is refused", () => {
      const sticky = join(world, "sticky");
      mkdirSync(join(sticky, "inner"), { recursive: true });
      chmodSync(sticky, 0o1777);
      chmodSync(join(sticky, "inner"), 0o755);
      const path = helper(join(sticky, "inner"));
      expect(checkSeccompHelper(path, { all: [] }, usersOwn)).toEqual({ ok: false, why: `others can change ${realpathSync(sticky)} (group- or world-writable)` });
    });

    test("the fence's install-tree write denies cover the real helper's canonical target", () => {
      const target = realpathSync(seccompHelperPath()!);
      expect(toolrollInstall(null, join(world, "home")).some(root => target === root || target.startsWith(`${root}/`))).toBe(true);
    });
  });
});
