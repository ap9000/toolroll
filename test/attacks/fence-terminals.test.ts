/**
 * Attack: a fenced launch and the operator's terminals (sandbox-runtime.ts SEATBELT_PTY, SEATBELT_NO_OTHER_TERMINAL,
 * DETACH, withSeatbeltRules). The sandbox runtime's own `allowPty` would open reads and writes on every /dev/ttys
 * device, the operator's own open terminals among them, and its baseline already read them (a read takes what the
 * operator types there). Toolroll's rules open only a terminal the launch made itself (macOS's
 * `com.apple.sandbox.pty` extension), deny every other by name, refuse TIOCSTI (typing into a terminal) last, and start
 * every launch in a session of its own, so no terminal of whoever started Toolroll is its controlling terminal.
 *
 * Positive controls: openpty works inside; the outside terminal opens unsandboxed; TIOCSTI works unsandboxed on a
 * controlling terminal. Native probes use python3, skipped where it isn't installed.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, NO_GRANTS, runFolders, sandboxedSpawn, srtTermsOf, taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { SEATBELT_NO_OTHER_TERMINAL, SEATBELT_PTY, srtMacosCommand, srtQuote, withSeatbeltRules } from "../../src/sandbox-runtime.js";
import { git, needs, repository, seatbelt, underSandbox, useScratch, write } from "./harness.js";

const scratch = useScratch("terminals");
const PYTHON = spawnSync("python3", ["-c", "import pty, fcntl"], { stdio: "ignore", timeout: 30_000 }).status === 0;
const python = { available: PYTHON, note: "terminal probes skipped: python3 is not installed" };
const TIOCSTI = 2147578994;

type Pty = { _pty: string; pid: number; onData(listener: (data: string) => void): unknown; onExit(listener: (exit: { exitCode: number }) => void): unknown; kill(): void };
const ptySpawn = (file: string, args: readonly string[], options: { cwd?: string; env: Record<string, string> }): Pty =>
  (createRequire(import.meta.url)("@lydell/node-pty") as { spawn: (file: string, args: readonly string[], options: object) => Pty }).spawn(file, args, { cols: 80, rows: 24, ...options });

/** `file args` on a terminal of its own (node-pty: a session leader with it as its controlling terminal), to the end. */
async function onTerminal(file: string, args: readonly string[], env: Record<string, string>, cwd: string): Promise<{ out: string; code: number }> {
  const terminal = ptySpawn(file, args, { cwd, env: { ...process.env as Record<string, string>, NODE_OPTIONS: "", ...env } });
  let out = "";
  terminal.onData(data => { out += data; });
  const code = await new Promise<number>(done => terminal.onExit(({ exitCode }) => done(exitCode)));
  return { out, code };
}

function launches() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const home = join(root, "home");
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  return { root, launch: (kind: "build" | "command" | "check" | "flow" | "tool-server", readDeny: string[] = []) => fenceFor(kind, { databaseFile: join(state, "orders.db"), worktree, home, binding,
    runFolders: runFolders(null), poolRoots: [pool], policy: 2, readDeny, boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }) }) };
}

describe("attack: the operator's terminals from inside the fence", () => {
  test("policy: every launch's profile has its own terminal, and ends with the denies; never the runtime's open terminal rule", () => {
    const { root, launch } = launches();
    for (const kind of ["build", "command", "check", "flow", "tool-server"] as const) {
      const fence = launch(kind);
      const command = srtMacosCommand("/usr/bin/true", [], srtTermsOf(fence.fence, fence.fenceGrants), root);
      expect(command.split(SEATBELT_PTY), kind).toHaveLength(2);
      expect(command.split(SEATBELT_NO_OTHER_TERMINAL), kind).toHaveLength(2);
      expect(command.indexOf(SEATBELT_NO_OTHER_TERMINAL)).toBeGreaterThan(command.indexOf(SEATBELT_PTY));
      // The runtime's allowPty: every /dev/ttys device read and written, nobody's own required.
      expect(command).not.toContain('(regex #"^/dev/ttys")');
      // Nothing after Toolroll's denies but the shell and its command.
      const tail = command.slice(command.lastIndexOf("(deny "));
      expect(/^\(deny [^\n]*\)\n' \/\S+ -c /.test(tail), kind).toBe(true);
    }
    // A project that denies the terminal devices by name (or /dev whole) gets no terminal of its own either.
    for (const deny of ["/dev", "/dev/ptmx", "/dev/*"]) {
      const fence = launch("check", [deny]);
      const command = srtMacosCommand("/usr/bin/true", [], srtTermsOf(fence.fence, fence.fenceGrants), root);
      expect(command, deny).not.toContain(SEATBELT_PTY);
      expect(command).toContain(SEATBELT_NO_OTHER_TERMINAL);
    }
  });

  test("policy: the rules go into the runtime's profile word only; any other shape (a word before or after, an operator) is refused", () => {
    const dir = scratch();
    const words = ["/bin/echo", "/usr/bin/sandbox-exec -p '(version 1)\n(deny default)' it's; x && y"];
    const real = srtMacosCommand(words[0]!, words.slice(1), srtTermsOf([], NO_GRANTS), dir);
    // The command's own words hold the profile's opening, quotes and operators: the rules still land in the profile, once.
    expect(real.split(SEATBELT_PTY)).toHaveLength(2);
    expect(real.indexOf(SEATBELT_PTY)).toBeLessThan(real.indexOf("/bin/echo"));
    const unruled = (rules: string) => withSeatbeltRules(real, rules);
    expect(() => unruled("(allow default)'; touch /tmp/x; '")).toThrow("can't hold a quote");
    // Made from the runtime's own words, the way it quotes them.
    const env = ["env", "-u", "SECRET_TOKEN", "HTTP_PROXY=http://localhost:1", "/usr/bin/sandbox-exec", "-p", "(version 1)\n(deny default)", "/bin/bash", "-c", "/bin/echo hi"];
    const good = srtQuote(env);
    expect(withSeatbeltRules(good, "(allow file-read*)", "/bin/echo hi")).toBe(srtQuote([...env.slice(0, 6), "(version 1)\n(deny default)\n(allow file-read*)\n", ...env.slice(7)]));
    const refused = [
      `touch /tmp/x; ${good}`, `/bin/echo ${good}`, `${good}; touch /tmp/x`, `${good} && touch /tmp/x`, `${good} extra`, `${good} | cat`,
      `${good}\ntouch /tmp/x`, ` ${good}`, `${good} `, srtQuote(["env", "touch", ...env.slice(1)]), srtQuote(["env", ...env.slice(4, 6), "(version 1)\n(allow default)", ...env.slice(7)]),
      srtQuote([...env.slice(0, 7), "bash", ...env.slice(8)]), srtQuote([...env.slice(0, 8), "-x", "/bin/echo hi"]), srtQuote(["/usr/bin/env", ...env.slice(1)]),
      "/usr/bin/true", `env /usr/bin/sandbox-exec -p '(version 1)\n(deny default)`, `env "A=1" ${good.slice(4)}`,
    ];
    for (const line of refused) expect(() => withSeatbeltRules(line, "(allow file-read*)"), line).toThrow();
    // The command run is the one asked for.
    expect(() => withSeatbeltRules(good, "(allow file-read*)", "/bin/echo bye")).toThrow("isn't the shape");
  });

  test("native: a launch opens and reuses terminals of its own, never one made outside it (nor the same device made again outside)", ctx => {
    needs(ctx, seatbelt());
    needs(ctx, python);
    const root = scratch();
    // The operator's terminal: one this process holds open, made outside every sandbox.
    const outside = ptySpawn("/bin/sleep", ["30"], { env: { PATH: "" } });
    try {
      expect(outside._pty).toMatch(/^\/dev\/ttys[0-9]+$/);
      const probe = write(join(root, "terminal-probe.py"), `import os, pty, sys
def own():
    m, s = pty.openpty()
    name = os.ttyname(s)
    os.write(m, b"x\\n"); ok = os.read(s, 2) == b"x\\n"
    # Its own terminal again by name, and handed to a child (a transferred descriptor) that writes through it.
    again = os.open(name, os.O_RDWR | os.O_NOCTTY); os.close(again)
    child = os.fork()
    if child == 0:
        os.write(s, b"from-child\\n"); os._exit(0)
    os.waitpid(child, 0)
    return m, s, name, ok and b"from-child" in os.read(m, 64)
for round in (1, 2):
    m, s, name, ok = own(); os.close(m); os.close(s)
    print("own", round, ok)
for flag, label in ((os.O_RDONLY, "read"), (os.O_WRONLY, "write")):
    for path in (sys.argv[1], "/dev/fd/9"):
        try: os.close(os.open(path, flag | os.O_NOCTTY)); print("outside", label, path, "opened")
        except OSError as e: print("outside", label, path, "refused", e.errno)
`);
      const bare = spawnSync("python3", ["-I", probe, outside._pty], { encoding: "utf8", timeout: 30_000 });
      expect(bare.stdout, bare.stderr).toContain(`outside read ${outside._pty} opened\n`);
      expect(bare.stdout).toContain(`outside write ${outside._pty} opened\n`);
      const fenced = underSandbox(`python3 -I ${JSON.stringify(probe)} ${outside._pty}`, [], NO_GRANTS, { cwd: root, timeout: 30_000 });
      expect(fenced.stdout, fenced.stderr).toContain("own 1 True\nown 2 True\n");
      expect(fenced.stdout).toContain(`outside read ${outside._pty} refused 1\n`);
      expect(fenced.stdout).toContain(`outside write ${outside._pty} refused 1\n`);
      // /dev/fd names only what the launch already holds (no descriptor 9 here): never a way to another terminal.
      expect(fenced.stdout).toContain("outside read /dev/fd/9 refused 9\n");
    } finally { outside.kill(); }
  });

  test("native: a device number its own terminal had, made again outside after it closed, is not reopened", async ctx => {
    needs(ctx, seatbelt());
    needs(ctx, python);
    const root = scratch();
    const inside = write(join(root, "reuse-in.py"), `import os, pty, sys, time
d = sys.argv[1]
m, s = pty.openpty(); name = os.ttyname(s); os.close(s); os.close(m)
open(f"{d}/name", "w").write(name)
while not os.path.exists(f"{d}/ready"): time.sleep(0.02)
print("same", open(f"{d}/ready").read() == name)
for flag, label in ((os.O_RDONLY, "read"), (os.O_WRONLY, "write")):
    try: os.close(os.open(name, flag | os.O_NOCTTY)); print("reopen", label, "opened")
    except OSError as e: print("reopen", label, "refused", e.errno)
`);
    const outside = write(join(root, "reuse-out.py"), `import os, pty, sys, time
d = sys.argv[1]
while not os.path.exists(f"{d}/name"): time.sleep(0.02)
want = open(f"{d}/name").read(); held = []
for _ in range(64):
    m, s = pty.openpty(); held.append((m, s))
    if os.ttyname(s) == want: break
open(f"{d}/ready", "w").write(os.ttyname(held[-1][1]))
time.sleep(10)
`);
    const { spawn } = await import("node:child_process");
    const holder = spawn("python3", ["-I", outside, root], { stdio: "ignore" });
    try {
      const fenced = underSandbox(`python3 -I ${JSON.stringify(inside)} ${JSON.stringify(root)}`, [], NO_GRANTS, { cwd: root, timeout: 30_000 });
      ctx.skip(!fenced.stdout.includes("same True"), "the device number wasn't given out again outside in time");
      expect(fenced.stdout, fenced.stderr).toContain("reopen read refused 1\nreopen write refused 1");
    } finally { holder.kill("SIGKILL"); }
  });

  test("native: nothing is typed into a terminal from inside: TIOCSTI refused on a launch's own controlling terminal", async ctx => {
    needs(ctx, seatbelt());
    needs(ctx, python);
    const root = scratch();
    const probe = write(join(root, "sti.py"), `import fcntl, os
for label, opener in (("stdin", lambda: 0), ("/dev/tty", lambda: os.open("/dev/tty", os.O_RDWR))):
    try: fcntl.ioctl(opener(), ${TIOCSTI}, b"Z"); print(label, "TIOCSTI typed")
    except OSError as e: print(label, "TIOCSTI refused", e.errno)
`);
    // Positive control: unsandboxed, on its controlling terminal, it types.
    const bare = await onTerminal("python3", ["-I", probe], {}, root);
    expect(bare.out).toContain("stdin TIOCSTI typed");
    const { file, args, env } = sandboxedSpawn("python3", ["-I", probe], [], NO_GRANTS, root);
    const fenced = await onTerminal(file, args, env, root);
    expect(fenced.out).toContain("stdin TIOCSTI refused 1");
    expect(fenced.out).toContain("/dev/tty TIOCSTI refused 1");
    expect(fenced.out).not.toContain("typed");
  });

  test("native: a launch started by a process with a terminal has none of it; one started on a terminal of its own keeps that one", async ctx => {
    needs(ctx, seatbelt());
    const root = scratch();
    const script = `(exec 3</dev/tty) 2>/dev/null && echo has-terminal || echo no-terminal`;
    const { file, args, env } = sandboxedSpawn("/bin/sh", ["-c", script], [], NO_GRANTS, root);
    // Toolroll on a terminal (a console started from one): it spawns the launch the plain way, as exec.ts does.
    const parent = write(join(root, "parent.cjs"), `const { execFile } = require("node:child_process");
execFile(${JSON.stringify(file)}, ${JSON.stringify(args)}, { env: { ...process.env, ...${JSON.stringify(env)} } }, (error, stdout, stderr) => { process.stdout.write("child:" + stdout + stderr); });`);
    const started = await onTerminal(process.execPath, [parent], {}, root);
    expect(started.out).toContain("child:no-terminal");
    // A program on a terminal made for it (a live terminal, a coding session): it keeps its own.
    const own = await onTerminal(file, args, env, root);
    expect(own.out).toContain("has-terminal");
  });
});
