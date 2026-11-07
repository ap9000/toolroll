/**
 * install.sh's start (easy-start plan G): piped into sh, the script's input is the download, so it opens Toolroll on the
 * terminal itself (/dev/tty) and, with no terminal at all, prints a start command whose folder is quoted for a shell.
 * Every program it calls (node, npm, toolroll) is a stub on PATH; HOME is a temp folder; nothing is installed.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url));

let base: string;
let stubs: string;
let record: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "so-install-"));
  stubs = join(base, "bin");
  record = join(base, "started.txt");
  mkdirSync(stubs);
  const stub = (name: string, body: string) => { writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stubs, name), 0o755); };
  stub("node", `echo 22.13.0`);
  stub("npm", `[ "$1" = ls ] && exit 1\nexit 0`);
  stub("git", `exit 0`);
  // The installed command: --version answers; a start records its arguments, one per line, and whether stdin is a terminal.
  stub("toolroll", `[ "$1" = --version ] && { echo "toolroll 9.9.9"; exit 0; }\n{ for a in "$@"; do printf '%s\\n' "$a"; done; if [ -t 0 ]; then echo TTY; else echo NO-TTY; fi; } > "${record}"`);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

/** Run a command in a NEW session (no controlling terminal, as under a pipe from curl with no terminal at all). */
function run(command: string, args: string[], env: Record<string, string>, stdin: "pipe" | "ignore" = "pipe"): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    // detached: setsid(2), so /dev/tty can't be opened unless something (script) gives the session a terminal.
    const child = spawn(command, args, {
      detached: true,
      // stdin piped, as from curl; script(1) on macOS refuses a socket for its input, so it gets /dev/null.
      stdio: [stdin, "pipe", "pipe"],
      env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "xdg"), LC_ALL: "C", ...env },
    });
    let out = "";
    child.stdout.on("data", chunk => { out += String(chunk); });
    child.stderr.on("data", chunk => { out += String(chunk); });
    // A script that exits first closes its stdin: that write's EPIPE is not this test's answer, the exit code is.
    child.stdin?.on("error", () => {});
    child.stdin?.end("");
    child.on("exit", code => resolve({ code, out }));
  });
}
const started = (): string[] => readFileSync(record, "utf8").trimEnd().split("\n");

describe("install.sh starts Toolroll on the terminal, or says how", () => {
  test("SO_NO_START=1 installs only and prints the quoted start command", async () => {
    const projects = join(base, "projects");
    const result = await run("sh", [INSTALL], { SO_NO_START: "1", SO_PROJECTS: projects });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`Start it with: toolroll --project-root '${projects}'`);
    expect(existsSync(record)).toBe(false);
  });

  test("with no terminal at all (piped, a new session), it prints the quoted command and exits 0", async () => {
    const projects = join(base, "projects");
    const result = await run("sh", [INSTALL], { SO_PROJECTS: projects });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`Start it with: toolroll --project-root '${projects}'`);
    expect(existsSync(record)).toBe(false);
  });

  test("a folder with a quote and a space is quoted so the printed command starts exactly that folder", async () => {
    const projects = join(base, "it's my projects");
    const result = await run("sh", [INSTALL], { SO_PROJECTS: projects });
    expect(result.code, result.out).toBe(0);
    const line = result.out.split("\n").find(one => one.startsWith("Start it with: "))!;
    expect(line).toBe(`Start it with: toolroll --project-root '${projects.replace(/'/g, "'\\''")}'`);
    // Pasting it into a shell runs toolroll with the folder as one argument.
    const pasted = await run("sh", ["-c", line.slice("Start it with: ".length)], {});
    expect(pasted.code, pasted.out).toBe(0);
    expect(started()).toEqual(["--project-root", projects, "NO-TTY"]);
  });

  test("with a terminal (under script's pseudo-terminal), it execs toolroll --project-root on that terminal", async () => {
    const projects = join(base, "projects");
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "sh", INSTALL] : ["-qec", `sh '${INSTALL}'`, "/dev/null"];
    const result = await run("script", args, { SO_PROJECTS: projects }, "ignore");
    expect(result.code, result.out).toBe(0);
    expect(started()).toEqual(["--project-root", projects, "TTY"]);
    expect(result.out).not.toContain("Start it with:");
  });
});
