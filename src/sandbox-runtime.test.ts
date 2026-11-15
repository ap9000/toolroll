/**
 * The Linux sandbox's programs (sandbox-runtime.ts LINUX_SANDBOX_TOOLS) are one list: the runtime's own check asks for
 * nothing outside it, a missing one is found and named with the line that installs it, and install.sh, the Linux guide
 * and the README name exactly these. Every PATH here is a temp folder of stubs.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLinuxDependencies } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { LINUX_SANDBOX_TOOLS, SANDBOX_LAUNCH_SPEC, linuxSandboxInstallLine, missingLinuxSandboxTools, resolveLinuxSandboxTools, sandboxRuntimeProblem, sandboxToolExclusions, srtSpawn, type SandboxLaunchSpec, type SrtTerms } from "./sandbox-runtime.js";

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

describe("the Linux sandbox's own programs: trusted paths, never PATH", () => {
  const TOOLS = ["bwrap", "socat", "bash", "rg"] as const;
  /** A folder of stand-ins for the four programs, made trusted (0755, this user's); `skip` names one left out. */
  const folder = (name: string, skip: string[] = [], mode = 0o755): string => {
    const dir = join(bin, name);
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    for (const tool of TOOLS.filter(one => !skip.includes(one))) { writeFileSync(join(dir, tool), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, tool), mode); }
    return realpathSync(dir);
  };
  const terms = (cwd: string): SrtTerms => ({ readConfig: { denyOnly: [] }, writeConfig: { allowOnly: ["/", cwd], denyWithinAllow: [] }, allowMachLookup: [], network: { kind: "open" } });
  beforeEach(() => { chmodSync(bin, 0o755); });

  test("an untrusted bwrap earlier on PATH is never used: the launch gets the trusted one by its absolute path", () => {
    const trusted = folder("system");
    const planted = folder("planted", [], 0o777);
    process.env["PATH"] = `${planted}:${trusted}:${process.env["PATH"] ?? ""}`;
    const resolved = resolveLinuxSandboxTools({ folders: [trusted] });
    expect(resolved).toEqual({ ok: true, tools: Object.fromEntries(TOOLS.map(tool => [tool, join(trusted, tool)])) });
    // Even listed first among the folders looked in, a copy others can change is passed over, never used.
    expect(resolveLinuxSandboxTools({ folders: [planted, trusted] })).toEqual(resolved);
    // And a launch is handed exactly those paths: what the helper gives the runtime as bwrapPath, socatPath, binShell
    // and the ripgrep command.
    const cwd = folder("project", TOOLS.slice());
    const launch = srtSpawn("/bin/true", [], terms(cwd), cwd, undefined, "linux", exclusions => resolveLinuxSandboxTools({ folders: [planted, trusted], exclusions }));
    const spec = JSON.parse(launch.env[SANDBOX_LAUNCH_SPEC]!) as SandboxLaunchSpec;
    expect(spec.tools).toEqual({ bwrap: join(trusted, "bwrap"), socat: join(trusted, "socat"), bash: join(trusted, "bash"), rg: join(trusted, "rg") });
    expect(JSON.stringify(spec.tools)).not.toContain(planted);
  });

  test("a program reached through a link into the launch's project, worktree or state is never used", () => {
    const project = folder("project");
    const linked = join(bin, "linked");
    mkdirSync(linked, { mode: 0o755 });
    for (const tool of TOOLS) symlinkSync(join(project, tool), join(linked, tool));
    const refused = srtSpawn.bind(null, "/bin/true", [], terms(project), project, undefined, "linux", exclusions => resolveLinuxSandboxTools({ folders: [linked], exclusions }));
    expect(refused).toThrow(/bubblewrap \(bwrap\) has no copy Toolroll can trust .*inside a project, worktree or Toolroll's own folder/);
    expect(sandboxToolExclusions(terms(project), project)).not.toContain("/");
  });

  test("a missing program refuses with a plain reason, and nothing falls back to a PATH lookup", () => {
    const trusted = folder("system", ["socat"]);
    // socat is on PATH; it still isn't used, because it isn't in a folder the sandbox looks in.
    const onPath = folder("on-path");
    process.env["PATH"] = onPath;
    const resolved = resolveLinuxSandboxTools({ folders: [trusted] });
    expect(resolved).toEqual({ ok: false, why: `socat isn't installed in a system folder Toolroll trusts (${trusted})` });
    expect(() => srtSpawn("/bin/true", [], terms(trusted), trusted, undefined, "linux", () => resolved)).toThrow(`socat isn't installed in a system folder Toolroll trusts (${trusted})`);
    // A copy no one but root or this user may own is not trusted either: named, with why.
    expect(resolveLinuxSandboxTools({ folders: [trusted], uid: undefined })).toEqual({ ok: false, why: expect.stringMatching(/^bubblewrap \(bwrap\) has no copy Toolroll can trust in .*who owns it can't be checked/) });
  });

  test("the launch helper starts nothing when it isn't handed the programs by absolute paths", () => {
    const cwd = folder("work", TOOLS.slice());
    const base: Omit<SandboxLaunchSpec, "tools"> = { file: "/bin/true", args: [], cwd, terms: terms(cwd) };
    for (const tools of [undefined, { bwrap: "bwrap", socat: "/usr/bin/socat", bash: "/bin/bash", rg: "/usr/bin/rg" }]) {
      const ran = spawnSync(process.execPath, ["--import", "tsx", "src/sandbox-launch.ts"], {
        cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000,
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", [SANDBOX_LAUNCH_SPEC]: JSON.stringify(tools === undefined ? base : { ...base, tools }) },
      });
      expect(ran.status, ran.stderr).toBe(126);
      expect(ran.stderr).toContain("toolroll sandbox: nothing was started: the sandbox's programs weren't given by trusted paths");
    }
  });
});
