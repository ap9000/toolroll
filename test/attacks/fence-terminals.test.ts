/**
 * Attack: a fenced launch and the operator's terminals (sandbox-runtime.ts SEATBELT_TERMINALS). The sandbox runtime's
 * own `allowPty` would open reads and writes on every /dev/ttys device, the operator's own open terminals among them,
 * and its baseline already read them (a read takes what the operator types there). Toolroll's rule opens only a
 * terminal the launch made itself (macOS's `com.apple.sandbox.pty` extension) and denies the rest by name; the
 * controlling terminal (/dev/tty) and a terminal handed down open keep working.
 *
 * Positive controls: openpty works inside; the same outside terminal opens unsandboxed. Native probes use python3,
 * skipped where it isn't installed.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, NO_GRANTS, runFolders, sandboxedSpawn, srtTermsOf, taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { SEATBELT_TERMINALS, srtMacosCommand, withSeatbeltRules } from "../../src/sandbox-runtime.js";
import { git, needs, repository, seatbelt, underSandbox, useScratch, write } from "./harness.js";

const scratch = useScratch("terminals");
const PYTHON = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore", timeout: 30_000 }).status === 0;
const python = { available: PYTHON, note: "terminal probes skipped: python3 is not installed" };

type Pty = { _pty: string; write(data: string): void; onData(listener: (data: string) => void): unknown; onExit(listener: (exit: { exitCode: number }) => void): unknown; kill(): void };
const ptySpawn = (file: string, args: string[], options: { cwd?: string; env: Record<string, string> }): Pty =>
  (createRequire(import.meta.url)("@lydell/node-pty") as { spawn: (file: string, args: string[], options: object) => Pty }).spawn(file, args, { cols: 80, rows: 24, ...options });

const TERMINAL_PROBE = `import os, pty, sys
m, s = pty.openpty()
os.write(m, b"x\\n"); print("own", os.ttyname(s).startswith("/dev/ttys"), os.read(s, 2) == b"x\\n")
for flag, name in ((os.O_RDONLY, "read"), (os.O_WRONLY, "write")):
    try:
        os.close(os.open(sys.argv[1], flag | os.O_NOCTTY)); print("outside", name, "opened")
    except OSError as e: print("outside", name, "refused", e.errno)
`;

describe("attack: the operator's terminals from inside the fence", () => {
  test("policy: every launch's profile ends with Toolroll's terminal rule, never the runtime's open one", () => {
    const root = scratch();
    const state = join(root, "toolroll");
    const pool = join(state, "worktrees");
    const main = repository(join(root, "shop"));
    const worktree = join(pool, "shop", "task-1-0123abcd");
    git(main, "worktree", "add", "-q", "-b", "t1", worktree);
    const home = join(root, "home");
    const binding = trustedWorktreeBinding(main, worktree, [pool]);
    for (const kind of ["build", "command", "check", "flow", "tool-server"] as const) {
      const launch = fenceFor(kind, { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
        boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }) });
      const command = srtMacosCommand("/usr/bin/true", [], srtTermsOf(launch.fence, launch.fenceGrants), root);
      expect(command.split(SEATBELT_TERMINALS), kind).toHaveLength(2);
      // The runtime's allowPty: every /dev/ttys device read and written, nobody's own required.
      expect(command).not.toContain('(regex #"^/dev/ttys")');
      // Last in the profile: nothing of the runtime's after it can take it back.
      expect(/^\n' \/\S+ -c /.test(command.slice(command.indexOf(SEATBELT_TERMINALS) + SEATBELT_TERMINALS.length))).toBe(true);
    }
  });

  test("policy: the rule goes into the runtime's profile word only; a command that isn't its shape is refused, not run with less", () => {
    const real = srtMacosCommand("/bin/echo", ["/usr/bin/sandbox-exec -p '(version 1)\n(deny default)' it's"], srtTermsOf([], NO_GRANTS), scratch());
    // The command's own words hold the profile's opening and a quote: the rule still lands in the profile, once.
    expect(real.split(SEATBELT_TERMINALS)).toHaveLength(2);
    expect(real.indexOf(SEATBELT_TERMINALS)).toBeLessThan(real.indexOf("/bin/echo"));
    expect(() => withSeatbeltRules(real, "(allow default)'; touch /tmp/x; '")).toThrow("can't hold a quote");
    expect(() => withSeatbeltRules("/usr/bin/true", "(allow file-read*)")).toThrow("isn't the shape");
    expect(() => withSeatbeltRules("env /usr/bin/sandbox-exec -p '(version 1)\n(allow default)' /bin/sh -c x", "(allow file-read*)")).toThrow("isn't the shape");
    expect(() => withSeatbeltRules("env /usr/bin/sandbox-exec -p '(version 1)\n(deny default)", "(allow file-read*)")).toThrow("never ends");
  });

  test("native: a launch opens a terminal of its own, and never reads or writes one made outside it", ctx => {
    needs(ctx, seatbelt());
    needs(ctx, python);
    const root = scratch();
    // The operator's terminal: one this process holds open, made outside every sandbox.
    const outside = ptySpawn("/bin/sleep", ["30"], { env: { PATH: "" } });
    try {
      expect(outside._pty).toMatch(/^\/dev\/ttys[0-9]+$/);
      const probe = write(join(root, "terminal-probe.py"), TERMINAL_PROBE);
      const bare = spawnSync("python3", ["-I", probe, outside._pty], { encoding: "utf8", timeout: 30_000 });
      expect(bare.stdout, bare.stderr).toContain("outside read opened\noutside write opened");
      const fenced = underSandbox(`python3 -I ${JSON.stringify(probe)} ${outside._pty}`, [], NO_GRANTS, { cwd: root, timeout: 30_000 });
      expect(fenced.stdout, fenced.stderr).toContain("own True True");
      expect(fenced.stdout).toContain("outside read refused 1");
      expect(fenced.stdout).toContain("outside write refused 1");
    } finally { outside.kill(); }
  });

  test("native: a launch run on a terminal keeps it: its output arrives, and /dev/tty opens", async ctx => {
    needs(ctx, seatbelt());
    const root = scratch();
    const script = `echo "fd:$(tty)"; exec 3</dev/tty && echo dev-tty-read-ok; echo to-the-terminal >&1`;
    const { file, args, env } = sandboxedSpawn("/bin/sh", ["-c", script], [], NO_GRANTS, root);
    const terminal = ptySpawn(file, args, { cwd: root, env: { ...process.env as Record<string, string>, ...env, NODE_OPTIONS: "" } });
    let seen = "";
    terminal.onData(data => { seen += data; });
    const code = await new Promise<number>(done => terminal.onExit(({ exitCode }) => done(exitCode)));
    expect(seen).toMatch(/fd:\/dev\/ttys[0-9]+/);
    expect(seen).toContain("dev-tty-read-ok");
    expect(seen).toContain("to-the-terminal");
    expect(code).toBe(0);
  });
});
