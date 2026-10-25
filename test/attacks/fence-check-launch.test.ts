/**
 * Attack: what a fenced launch may do with terminals and macOS services now that a project's checks can drive a
 * pseudo-terminal and Chromium (sandbox-runtime.ts SEATBELT_TERMINALS, SEATBELT_CHROMIUM).
 *
 * - Terminals, every launch: the sandbox runtime's own `allowPty` would open reads and writes on every /dev/ttys
 *   device, the operator's own open terminals among them, and its baseline already read them (a read takes what the
 *   operator types there). Toolroll's rule opens only a terminal the launch made itself (macOS's
 *   `com.apple.sandbox.pty` extension), and denies the rest by name.
 * - Chromium, a check's launch only: registering and looking up the headless shell's port rendezvous service under a
 *   pid, and nothing else of anyone's: other names (a near miss, Chrome for Testing's, the pasteboard, the window
 *   server) stay refused, and a build, flow or tool server gets none of it. The residual (SECURITY.md): any pid's
 *   name, so a server of that name registered outside is found too; pinned below.
 *
 * Positive controls: openpty works inside; the same terminal opened from outside works; the Chromium names register
 * inside a check's fence. Native probes use python3 (ctypes for bootstrap_check_in / bootstrap_look_up), skipped
 * where it isn't installed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, NO_GRANTS, runFolders, srtTermsOf, taskBoundary, trustedWorktreeBinding, type FenceKind } from "../../src/agent-fence.js";
import { SEATBELT_CHROMIUM, SEATBELT_TERMINALS, srtMacosCommand, withSeatbeltRules } from "../../src/sandbox-runtime.js";
import { git, needs, repository, seatbelt, underSandbox, useScratch, write } from "./harness.js";

const scratch = useScratch("check-launch");
const PYTHON = spawnSync("python3", ["-c", "import ctypes, pty"], { stdio: "ignore", timeout: 30_000 }).status === 0;
const python = { available: PYTHON, note: "terminal and mach probes skipped: python3 is not installed" };

function plane() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const home = join(root, "home");
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const launch = (kind: FenceKind) => fenceFor(kind, { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
    boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }) });
  return { root, worktree, launch };
}

const MACH_PROBE = `import ctypes, sys
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
bootstrap = ctypes.c_uint.in_dll(lib, "bootstrap_port").value
for spec in sys.argv[1:]:
    op, name = spec.split(":", 1)
    port = ctypes.c_uint(0)
    call = lib.bootstrap_check_in if op == "register" else lib.bootstrap_look_up
    print(f"{spec}={call(bootstrap, name.encode(), ctypes.byref(port))}")
`;
/** 0: done; 1100: refused by the sandbox (BOOTSTRAP_NOT_PRIVILEGED); 1102: allowed, but nobody has that name. */
const machResults = (out: string): Record<string, number> => Object.fromEntries(out.trim().split("\n").filter(line => line.includes("=")).map(line => {
  const at = line.lastIndexOf("=");
  return [line.slice(0, at), Number(line.slice(at + 1))];
}));

describe("attack: terminals and Chromium's services from inside the fence", () => {
  test("policy: every launch's profile ends with Toolroll's terminal rules; only a check's adds Chromium's, and never the runtime's open terminal rule", () => {
    const { launch, root } = plane();
    for (const kind of ["build", "command", "flow", "tool-server", "check"] as const) {
      const grants = launch(kind).fenceGrants;
      expect(grants.browser === true, kind).toBe(kind === "check");
      const command = srtMacosCommand("/usr/bin/true", [], srtTermsOf(launch(kind).fence, grants), root);
      expect(command).toContain(SEATBELT_TERMINALS);
      expect(command.includes(SEATBELT_CHROMIUM), kind).toBe(kind === "check");
      // The runtime's allowPty: every /dev/ttys device read and written, nobody's own required.
      expect(command).not.toContain('(regex #"^/dev/ttys")');
    }
    // The rules come last in the profile: nothing of the runtime's after them can take them back.
    const check = srtMacosCommand("/usr/bin/true", [], { ...srtTermsOf([], NO_GRANTS), browser: true }, root);
    expect(check.indexOf(SEATBELT_CHROMIUM)).toBeGreaterThan(check.indexOf("(deny default"));
    expect(/^\n' \/\S+ -c /.test(check.slice(check.indexOf(SEATBELT_CHROMIUM) + SEATBELT_CHROMIUM.length))).toBe(true);
  });

  test("policy: the rules go into the runtime's profile word only; a command that isn't its shape is refused, not run with less", () => {
    const real = srtMacosCommand("/bin/echo", ["/usr/bin/sandbox-exec -p '(version 1)\n(deny default)' it's"], srtTermsOf([], NO_GRANTS), scratch());
    // The command's own words hold the profile's opening and a quote: the rules still land in the profile, once.
    const profileEnd = real.indexOf(SEATBELT_TERMINALS) + SEATBELT_TERMINALS.length;
    expect(real.split(SEATBELT_TERMINALS)).toHaveLength(2);
    expect(real.indexOf(SEATBELT_TERMINALS)).toBeLessThan(real.indexOf("/bin/echo"));
    expect(/^\n' \/\S+ -c /.test(real.slice(profileEnd))).toBe(true);
    expect(() => withSeatbeltRules(real, "(allow default)'; touch /tmp/x; '")).toThrow("can't hold a quote");
    expect(() => withSeatbeltRules("/usr/bin/true", "(allow file-read*)")).toThrow("isn't the shape");
    expect(() => withSeatbeltRules("env /usr/bin/sandbox-exec -p '(version 1)\n(allow default)' /bin/sh -c x", "(allow file-read*)")).toThrow("isn't the shape");
    expect(() => withSeatbeltRules("env /usr/bin/sandbox-exec -p '(version 1)\n(deny default)", "(allow file-read*)")).toThrow("never ends");
  });

  test("native: a launch opens a terminal of its own, and never reads or writes one made outside it", ctx => {
    needs(ctx, seatbelt());
    needs(ctx, python);
    const { root } = plane();
    // The operator's terminal: one this process holds open, made outside every sandbox.
    const native = (createRequire(import.meta.url)("@lydell/node-pty") as typeof import("@lydell/node-pty")).spawn("/bin/sleep", ["30"], { cols: 80, rows: 24, env: { PATH: "" } });
    try {
      const outside = (native as unknown as { _pty: string })._pty;
      expect(outside).toMatch(/^\/dev\/ttys[0-9]+$/);
      const probe = write(join(root, "terminal-probe.py"), `import os, pty, sys
m, s = pty.openpty()
os.write(m, b"x\\n"); print("own", os.ttyname(s).startswith("/dev/ttys"), os.read(s, 2) == b"x\\n")
for flag, name in ((os.O_RDONLY, "read"), (os.O_WRONLY, "write")):
    try:
        os.close(os.open(sys.argv[1], flag | os.O_NOCTTY)); print("outside", name, "opened")
    except OSError as e: print("outside", name, "refused", e.errno)
`);
      // Positive control: unsandboxed, this user opens it both ways.
      const bare = spawnSync("python3", ["-I", probe, outside], { encoding: "utf8", timeout: 30_000 });
      expect(bare.stdout, bare.stderr).toContain("outside read opened\noutside write opened");
      for (const grants of [NO_GRANTS, { ...NO_GRANTS, browser: true as const }]) {
        const fenced = underSandbox(`python3 -I ${JSON.stringify(probe)} ${outside}`, [], grants, { cwd: root, timeout: 30_000 });
        expect(fenced.stdout, fenced.stderr).toContain("own True True");
        expect(fenced.stdout).toContain("outside read refused 1");
        expect(fenced.stdout).toContain("outside write refused 1");
      }
    } finally { native.kill(); }
  });

  test("native: a check's fence registers and finds Chromium's rendezvous name, and nothing else; other launches get none of it", ctx => {
    needs(ctx, seatbelt());
    needs(ctx, python);
    const { root, launch } = plane();
    const probe = write(join(root, "mach.py"), MACH_PROBE);
    const pid = 4000 + Math.floor(Math.random() * 50_000);
    const chromium = `register:org.chromium.Chromium.MachPortRendezvousServer.${pid}`;
    const refused = [`register:com.google.chrome.for.testing.MachPortRendezvousServer.${pid + 1}`, `lookup:com.google.chrome.for.testing.MachPortRendezvousServer.${pid + 3}`, "register:org.chromium.evil", "register:com.example.evil", `register:org.chromium.Chromium.MachPortRendezvousServer.${pid}x`,
      "register:org.chromium.Chromium.MachPortRendezvousServer.", "register:com.google.Chrome.MachPortRendezvousServer.1",
      "lookup:com.apple.pasteboard.1", "lookup:com.apple.windowserver.active", "lookup:org.chromium.crashpad.child_port_handshake.1"];
    const all = [chromium, `lookup:org.chromium.Chromium.MachPortRendezvousServer.${pid + 2}`, ...refused];
    const run = (kind: FenceKind) => {
      const fence = launch(kind);
      const ran = underSandbox(`python3 -I ${JSON.stringify(probe)} ${all.join(" ")}`, fence.fence, fence.fenceGrants, { cwd: root });
      expect(ran.status, ran.stderr).toBe(0);
      return machResults(ran.stdout);
    };
    // Positive control: unsandboxed, every one of these registers (lookups find the services that exist).
    const bare = machResults(spawnSync("python3", ["-I", probe, ...refused.filter(one => one.startsWith("register:")).map(one => `${one}.bare`)], { encoding: "utf8" }).stdout);
    expect(Object.values(bare).every(code => code === 0)).toBe(true);
    const check = run("check");
    expect(check[chromium]).toBe(0);
    // Looked up, not refused: the name is allowed and simply not registered by anyone.
    expect(check[`lookup:org.chromium.Chromium.MachPortRendezvousServer.${pid + 2}`]).toBe(1102);
    for (const one of refused) expect(check[one], one).toBe(1100);
    for (const kind of ["build", "flow", "tool-server"] as const) {
      const other = run(kind);
      for (const one of all) expect(other[one], `${kind} ${one}`).toBe(1100);
    }
  });

  // The residual SECURITY.md states (Chromium in a check's sandbox): Seatbelt can't tie the name's pid to the caller,
  // so a check finds a rendezvous server registered outside under that name. Pinned so a change either way is seen.
  test("native residual: a check finds a Chromium-named server registered outside its sandbox (a build doesn't)", async ctx => {
    needs(ctx, seatbelt());
    needs(ctx, python);
    const { root, launch } = plane();
    const probe = write(join(root, "mach.py"), MACH_PROBE);
    const name = `org.chromium.Chromium.MachPortRendezvousServer.${100_000 + Math.floor(Math.random() * 800_000)}`;
    const holder = spawn("python3", ["-I", "-c", `import ctypes, sys
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
port = ctypes.c_uint(0)
print(lib.bootstrap_check_in(ctypes.c_uint.in_dll(lib, "bootstrap_port").value, sys.argv[1].encode(), ctypes.byref(port)), flush=True)
sys.stdin.read()`, name], { stdio: ["pipe", "pipe", "ignore"] });
    try {
      const registered = await new Promise<string>(done => holder.stdout!.once("data", chunk => done(String(chunk).trim())));
      expect(registered).toBe("0");
      const lookUp = (kind: FenceKind) => {
        const fence = launch(kind);
        return machResults(underSandbox(`python3 -I ${JSON.stringify(probe)} lookup:${name}`, fence.fence, fence.fenceGrants, { cwd: root }).stdout)[`lookup:${name}`];
      };
      expect(lookUp("check")).toBe(0);
      expect(lookUp("build")).toBe(1100);
    } finally { holder.kill("SIGKILL"); }
  });
});
