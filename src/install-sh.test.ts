/**
 * install.sh's start (easy-start plan G): piped into sh, the script's input is the download, so it opens Toolroll on the
 * terminal itself (/dev/tty) and, with no terminal at all, prints a start command whose folder is quoted for a shell.
 * Every program it calls (node, npm, toolroll) is a stub on PATH; HOME is a temp folder; nothing is installed.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  // node: its version (NODE_STUB_VERSION), the floor by default.
  stub("node", `echo "\${NODE_STUB_VERSION:-22.20.0}"`);
  stub("npm", `[ "$1" = ls ] && exit 1\n[ "$1" = install ] && : > "${base}/npm-installed"\nexit 0`);
  // git: its version (GIT_STUB_VERSION), and the repository a folder is in (a folder with a .git directory).
  stub("git", `[ "$1" = --version ] && { echo "git version \${GIT_STUB_VERSION:-2.43.0}"; exit 0; }\ncase " $* " in *" --absolute-git-dir "*) [ -d .git ] && { echo "$(pwd -P)/.git"; exit 0; }; exit 128 ;; *" rev-parse "*) [ -d .git ] && { pwd -P; exit 0; }; exit 128 ;; *" config "*) exit 1 ;; esac\nexit 0`);
  // The installed command: --version answers; a start records its arguments, one per line, and whether stdin is a
  // terminal, and the folder it started in.
  stub("toolroll", `[ "$1" = --version ] && { echo "toolroll 9.9.9"; exit 0; }\n{ for a in "$@"; do printf '%s\\n' "$a"; done; if [ -t 0 ]; then echo TTY; else echo NO-TTY; fi; } > "${record}"\npwd -P > "${record}.cwd"`);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

/** Run a command in a NEW session (no controlling terminal, as under a pipe from curl with no terminal at all). */
function run(command: string, args: string[], env: Record<string, string>, stdin: "pipe" | "ignore" = "pipe", cwd = base): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    // detached: setsid(2), so /dev/tty can't be opened unless something (script) gives the session a terminal.
    const child = spawn(command, args, {
      detached: true, cwd,
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

  // Eight W2: run inside a repository, it starts there; outside one, ~/Projects as before.
  test("run inside a git repository with a terminal, it starts Toolroll on that repository, in it", async () => {
    const repo = join(base, "shop");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "sh", INSTALL] : ["-qec", `sh '${INSTALL}'`, "/dev/null"];
    const result = await run("script", args, {}, "ignore", repo);
    expect(result.code, result.out).toBe(0);
    expect(started()).toEqual(["TTY"]);
    expect(readFileSync(`${record}.cwd`, "utf8").trim()).toBe(realpathSync(repo));
    expect(result.out).toContain(`Starting Toolroll in ${realpathSync(repo)}`);
    expect(existsSync(join(base, "home", "Projects"))).toBe(false);
  });

  test("inside a repository with no terminal or SO_NO_START, it says to start it there; SO_PROJECTS still wins", async () => {
    const repo = join(base, "shop");
    mkdirSync(join(repo, ".git"), { recursive: true });
    for (const env of [{}, { SO_NO_START: "1" }]) {
      const result = await run("sh", [INSTALL], env, "pipe", repo);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain(`Start it in ${realpathSync(repo)} with: toolroll`);
      expect(existsSync(record)).toBe(false);
    }
    const projects = join(base, "projects");
    const chosen = await run("sh", [INSTALL], { SO_NO_START: "1", SO_PROJECTS: projects }, "pipe", repo);
    expect(chosen.out).toContain(`Start it with: toolroll --project-root '${projects}'`);
  });

  test("git older than 2.41 stops before anything is installed, and says which it found; 2.41 and newer go on", async () => {
    const old = await run("sh", [INSTALL], { SO_NO_START: "1", GIT_STUB_VERSION: "2.39.5 (Apple Git-154)" });
    expect(old.code).toBe(1);
    expect(old.out).toContain("it needs git 2.41 or newer; this computer has 2.39.");
    expect(existsSync(join(base, "npm-installed"))).toBe(false);
    for (const version of ["2.41.0", "2.47.1", "3.0.0"]) {
      const ok = await run("sh", [INSTALL], { SO_NO_START: "1", GIT_STUB_VERSION: version });
      expect(ok.code, `${version}: ${ok.out}`).toBe(0);
    }
  });

  test("Node older than 22.20 stops before anything is installed (the store doesn't work on 22.13–22.19), and says how to update; 22.20 and newer go on", async () => {
    for (const version of ["22.13.0", "22.15.1", "22.19.0", "20.18.0"]) {
      const old = await run("sh", [INSTALL], { SO_NO_START: "1", NODE_STUB_VERSION: version });
      expect(old.code, version).toBe(1);
      expect(old.out).toContain(`it needs Node.js 22.20 or newer; this computer has ${version}. Update Node (https://nodejs.org`);
      expect(existsSync(join(base, "npm-installed"))).toBe(false);
    }
    for (const version of ["22.20.0", "22.23.5", "24.22.3", "26.13.1"]) {
      const ok = await run("sh", [INSTALL], { SO_NO_START: "1", NODE_STUB_VERSION: version });
      expect(ok.code, `${version}: ${ok.out}`).toBe(0);
    }
  });

  test("no coding agent found: it says one is needed to build tasks, never that it works without one", async () => {
    const result = await run("sh", [INSTALL], { SO_NO_START: "1" });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("Toolroll needs one to build your tasks");
    expect(result.out).not.toContain("works without one");
  });
});

/**
 * Codex review of #377, finding 3: which repository install.sh starts in is git's answer with every override cleared,
 * kept only when it is a folder with a .git entry that contains the folder the script ran in. Real git here (only its
 * version is answered by the stub), against hostile environments and repository config.
 */
describe("install.sh's repository, with real git", () => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const makeRepo = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    execFileSync(realGit, ["init", "-q", dir], { env: gitEnv });
    return realpathSync(dir);
  };
  beforeEach(() => {
    // Version from the stub (the floor check), everything else from the real git.
    writeFileSync(join(stubs, "git"), `#!/bin/sh\n[ "$1" = --version ] && { echo "git version 2.43.0"; exit 0; }\nexec "${realGit}" "$@"\n`);
    chmodSync(join(stubs, "git"), 0o755);
  });
  const startLine = (out: string) => out.split("\n").find(one => one.startsWith("Start it"));
  const projectsLine = () => `Start it with: toolroll --project-root '${join(base, "home", "Projects")}'`;

  test("run from a folder inside a repository: that repository's top", async () => {
    const repo = makeRepo(join(base, "shop"));
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    const result = await run("sh", [INSTALL], { SO_NO_START: "1" }, "pipe", join(repo, "src", "deep"));
    expect(result.code, result.out).toBe(0);
    expect(startLine(result.out)).toBe(`Start it in ${repo} with: toolroll`);
  });

  test("GIT_DIR and GIT_WORK_TREE pointing at another repository, run outside any: ~/Projects, never that repository", async () => {
    const other = makeRepo(join(base, "other"));
    const outside = join(base, "plain");
    mkdirSync(outside);
    const result = await run("sh", [INSTALL], { SO_NO_START: "1", GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other }, "pipe", outside);
    expect(result.code, result.out).toBe(0);
    expect(startLine(result.out)).toBe(projectsLine());
  });

  test("injected config (GIT_CONFIG_COUNT core.worktree) can't move the repository it starts in", async () => {
    const repo = makeRepo(join(base, "shop"));
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    const result = await run("sh", [INSTALL], { SO_NO_START: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: elsewhere }, "pipe", repo);
    expect(result.code, result.out).toBe(0);
    expect(startLine(result.out)).toBe(`Start it in ${repo} with: toolroll`);
  });

  test("a repository whose own config sets core.worktree to a folder outside it: ~/Projects, never that folder", async () => {
    const repo = makeRepo(join(base, "shop"));
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    execFileSync(realGit, ["-C", repo, "config", "core.worktree", elsewhere], { env: gitEnv });
    const result = await run("sh", [INSTALL], { SO_NO_START: "1" }, "pipe", repo);
    expect(result.code, result.out).toBe(0);
    expect(startLine(result.out)).toBe(projectsLine());
  });

  test("round 2 (finding C): a nested repository whose core.worktree points at the repository around it: ~/Projects", async () => {
    const outer = makeRepo(join(base, "outer"));
    const inner = makeRepo(join(outer, "vendor", "inner"));
    execFileSync(realGit, ["-C", inner, "config", "core.worktree", outer], { env: gitEnv });
    const result = await run("sh", [INSTALL], { SO_NO_START: "1" }, "pipe", inner);
    expect(result.code, result.out).toBe(0);
    expect(startLine(result.out)).toBe(projectsLine());
  });

  test("the script stays plain POSIX sh (dash parses it)", () => {
    for (const shell of ["/bin/sh", "/bin/dash", "/usr/bin/dash"]) {
      if (!existsSync(shell)) continue;
      expect(() => execFileSync(shell, ["-n", INSTALL]), shell).not.toThrow();
    }
  });
});
