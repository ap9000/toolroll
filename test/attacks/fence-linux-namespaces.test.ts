/**
 * Attack: a Linux build seeing or reaching the host's processes, or pushing keystrokes into the operator's terminal
 * (docs/plans/sandbox-parity.md C6). bubblewrap gave a process view of its own only under a confined network; a build
 * with an open network saw every host process in /proc and kept the operator's controlling terminal (TIOCSTI). Every
 * Linux fence now has a session and a process view of its own, as Anthropic's sandbox runtime always has. Positive
 * controls: unsandboxed, the same probes see the host process and open the terminal.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { linuxFenced, NO_GRANTS } from "../../src/agent-fence.js";
import { holder, marker, needs, useChildren, useScratch } from "./harness.js";

const scratch = useScratch("linux-ns");
const track = useChildren();

function bubblewrap(): { available: boolean; note: string } {
  if (process.platform !== "linux") return { available: false, note: "bubblewrap namespace checks skipped: not Linux" };
  const ran = spawnSync("bwrap", ["--dev-bind", "/", "/", "--new-session", "--unshare-pid", "--proc", "/proc", "--", "true"], { encoding: "utf8", timeout: 5_000 });
  return ran.status === 0 ? { available: true, note: "" } : { available: false, note: `bubblewrap namespace checks skipped: ${(ran.stderr ?? "").trim() || "bwrap can't make a namespace here"}` };
}
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

/** `script` under the Linux fence with an open network, without blocking this process (the holder must keep running). */
function fenced(script: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { file, args } = linuxFenced("/bin/sh", ["-c", script], [join(cwd, "denied")], NO_GRANTS);
  return new Promise(done => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => done({ code, stdout, stderr }));
  });
}

describe("attack: the host's processes and terminal from a Linux build with an open network", () => {
  test("policy: every bubblewrap launch has its own session and process view, whatever its network", () => {
    const args = linuxFenced("claude", [], ["/x"], NO_GRANTS).args;
    for (const flag of ["--new-session", "--unshare-pid"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--proc") + 1]).toBe("/proc");
    expect(args).not.toContain("--unshare-net");
  });

  test("native: host processes are out of sight and /proc/1 is the sandbox's own", async ctx => {
    needs(ctx, bubblewrap());
    const dir = scratch();
    mkdirSync(join(dir, "denied"));
    const target = await holder({ SO_ATTACK_MARKER: marker("linux-pid") }, track);
    // Positive control: unsandboxed, the holder is in /proc and can be signalled.
    expect(spawnSync("/bin/sh", ["-c", `test -d /proc/${target.pid} && kill -0 ${target.pid} && echo seen`], { encoding: "utf8" }).stdout.trim()).toBe("seen");
    const inside = await fenced(`if test -d /proc/${target.pid}; then echo seen; else echo hidden; fi; kill -0 ${target.pid} 2>/dev/null && echo signalled || echo unsignalled; tr '\\0' ' ' < /proc/1/cmdline; echo; ls /proc | grep -c '^[0-9]'`, dir);
    const out = inside.stdout.trim().split("\n");
    expect(out.slice(0, 2), inside.stderr).toEqual(["hidden", "unsignalled"]);
    // The sandbox's own init (bubblewrap) or its command is pid 1, never the host's.
    expect(out[2]).toMatch(/bwrap|\/bin\/sh/);
    expect(Number(out[3])).toBeLessThan(10);
  });

  test("native: no controlling terminal inside, so nothing can be pushed into the operator's", async ctx => {
    needs(ctx, bubblewrap());
    ctx.skip(!hasScript, "terminal probe skipped: util-linux script(1) is not installed");
    const dir = scratch();
    mkdirSync(join(dir, "denied"));
    const probe = `if (exec 3</dev/tty) 2>/dev/null; then echo tty-open; else echo no-tty; fi`;
    // Positive control: under a pseudo-terminal of its own (script), a plain process has a controlling terminal.
    const plain = spawnSync("script", ["-qec", probe, "/dev/null"], { encoding: "utf8", timeout: 30_000 });
    expect(plain.stdout).toContain("tty-open");
    const { file, args } = linuxFenced("/bin/sh", ["-c", `${probe}; python3 -c 'import fcntl,termios,os
try:
    fd=os.open("/dev/tty",os.O_RDWR); fcntl.ioctl(fd,termios.TIOCSTI,b"x"); print("tiocsti-sent")
except OSError as e: print("tiocsti-refused")' 2>/dev/null || echo tiocsti-refused`], [join(dir, "denied")], NO_GRANTS);
    const quoted = [file, ...args].map(one => `'${one.replace(/'/g, "'\\''")}'`).join(" ");
    const inside = spawnSync("script", ["-qec", quoted, "/dev/null"], { encoding: "utf8", timeout: 30_000, cwd: dir });
    expect(inside.stdout, inside.stderr).toContain("no-tty");
    expect(inside.stdout).toContain("tiocsti-refused");
    expect(inside.stdout).not.toContain("tiocsti-sent");
  });
});
