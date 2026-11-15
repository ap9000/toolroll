/**
 * The Linux sandbox's programs (sandbox-runtime.ts LINUX_SANDBOX_TOOLS) are one list: the runtime's own check asks for
 * nothing outside it, a missing one is found and named with the line that installs it, and install.sh, the Linux guide
 * and the README name exactly these. Every PATH here is a temp folder of stubs.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLinuxDependencies } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { LINUX_SANDBOX_TOOLS, SANDBOX_LAUNCH_SPEC, linuxSandboxInstallLine, missingLinuxSandboxTools, sandboxRuntimeProblem, srtSpawn, type SandboxLaunchSpec, type SrtTerms } from "./sandbox-runtime.js";
import { resolveLinuxSandboxTools, sandboxToolExclusions, seccompHelperPath, verifyLinuxSandboxTools, type LinuxSandboxTools, type ToolTrust } from "./sandbox-tools.js";
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
    for (const tool of LINUX_SANDBOX_TOOLS) stub(tool.command);
    expect(checkLinuxDependencies().errors.filter(error => /not installed/.test(error))).toEqual([]);
  });

  test("a missing program is found and named by its package, with the line that installs it", () => {
    stub("bwrap");
    stub("rg", 0o644); // not executable: not there
    expect(missingLinuxSandboxTools(bin)).toEqual(["socat", "ripgrep"]);
    expect(missingLinuxSandboxTools("")).toEqual(["bubblewrap", "socat", "ripgrep"]);
    stub("socat");
    stub("rg");
    expect(missingLinuxSandboxTools(bin)).toEqual([]);
    process.env["PATH"] = join(bin, "nothing-here");
    expect(sandboxRuntimeProblem("linux")).toBe("bubblewrap, socat and ripgrep are not installed (sudo apt update && sudo apt install bubblewrap socat ripgrep (Fedora: sudo dnf install bubblewrap socat ripgrep))");
  });

  test("install.sh, the Linux guide and the README name exactly these", () => {
    expect(root("install.sh")).toContain(`for tool in ${LINUX_SANDBOX_TOOLS.map(tool => `${tool.command}:${tool.package}`).join(" ")}; do`);
    const packages = LINUX_SANDBOX_TOOLS.map(tool => tool.package).join(" ");
    expect(linuxSandboxInstallLine()).toBe(`sudo apt update && sudo apt install ${packages} (Fedora: sudo dnf install ${packages})`);
    const guide = root("docs/guide/linux.md");
    expect(guide).toContain(`sudo apt update && sudo apt install ${packages}`);
    expect(guide).toContain(`sudo dnf install ${packages}`);
    expect(root("README.md")).toContain(`sudo apt update && sudo apt install ${packages}`);
    expect(root("docs/guide/getting-started.md")).toContain(`sudo apt update && sudo apt install ${packages}`);
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
      expect(refused.why).toContain("install bubblewrap from your system package manager (sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap)");
    }
  });

  test("ripgrep only in ~/.cargo/bin (on PATH) is never used: the person is told to install it from the system's package manager", () => {
    const system = folder("system", ["rg"]);
    process.env["PATH"] = `${folder("cargo-bin")}:${system}`;
    expect(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp: helper(system) })).toEqual({ ok: false,
      why: `ripgrep (rg) has no copy owned by root in ${system}: install ripgrep from your system package manager (sudo apt install ripgrep; Fedora: sudo dnf install ripgrep)` });
  });

  test("a cached program swapped or loosened between launches is refused on the next launch", () => {
    const system = folder("system");
    const seccomp = helper(system);
    const tools = found(resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp }));
    expect(verifyLinuxSandboxTools(tools, { ...standIn, seccomp })).toBeNull();
    // Another file in its place (same name, same owner, same mode): not the program that was checked.
    unlinkSync(join(system, "bwrap"));
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

  test("a missing program refuses with a plain reason, and nothing falls back to a PATH lookup", () => {
    const system = folder("system", ["socat"]);
    process.env["PATH"] = folder("on-path");
    const resolved = resolveLinuxSandboxTools({ ...standIn, folders: [system], seccomp: helper(system) });
    expect(resolved).toEqual({ ok: false, why: `socat has no copy owned by root in ${system}: install socat from your system package manager (sudo apt install socat; Fedora: sudo dnf install socat)` });
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
});
