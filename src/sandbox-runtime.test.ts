/**
 * The Linux sandbox's programs (sandbox-runtime.ts LINUX_SANDBOX_TOOLS) are one list: the runtime's own check asks for
 * nothing outside it, a missing one is found and named with the line that installs it, and install.sh, the Linux guide
 * and the README name exactly these. Every PATH here is a temp folder of stubs.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLinuxDependencies } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { LINUX_SANDBOX_TOOLS, linuxSandboxInstallLine, missingLinuxSandboxTools, sandboxRuntimeProblem } from "./sandbox-runtime.js";

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
