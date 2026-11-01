/**
 * Attack: a Linux build seeing or reaching the host's processes, or pushing keystrokes into the operator's terminal.
 * Anthropic's sandbox-runtime gives every Linux sandbox a session and a process view of its own (bubblewrap
 * --new-session, --unshare-pid and a fresh /proc). Positive controls: unsandboxed, the same probes see the host process
 * and open the terminal.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { NO_GRANTS, sandboxedSpawn } from "../../src/agent-fence.js";
import { holder, marker, needs, osFence, underSandboxAsync, useChildren, useScratch } from "./harness.js";

const scratch = useScratch("linux-ns");
const track = useChildren();
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

describe("attack: the host's processes and terminal from a Linux build with an open network", () => {
  test("native Linux: host processes are out of sight and can't be signalled", async ctx => {
    ctx.skip(process.platform !== "linux", "namespace checks skipped: not Linux");
    needs(ctx, osFence());
    const dir = scratch();
    mkdirSync(join(dir, "denied"));
    const target = await holder({ SO_ATTACK_MARKER: marker("linux-pid") }, track);
    // Positive control: unsandboxed, the holder is in /proc and can be signalled.
    expect(spawnSync("/bin/sh", ["-c", `test -d /proc/${target.pid} && kill -0 ${target.pid} && echo seen`], { encoding: "utf8" }).stdout.trim()).toBe("seen");
    const inside = await underSandboxAsync(`if test -d /proc/${target.pid}; then echo seen; else echo hidden; fi; kill -0 ${target.pid} 2>/dev/null && echo signalled || echo unsignalled; ls /proc | grep -c '^[0-9]'`, [join(dir, "denied")], NO_GRANTS, { cwd: dir });
    const out = inside.stdout.trim().split("\n");
    expect(out.slice(0, 2), inside.stderr).toEqual(["hidden", "unsignalled"]);
    expect(Number(out[2])).toBeLessThan(20);
  });

  test("native Linux: no controlling terminal inside, so nothing can be pushed into the operator's", async ctx => {
    ctx.skip(process.platform !== "linux", "terminal checks skipped: not Linux");
    needs(ctx, osFence());
    ctx.skip(!hasScript, "terminal probe skipped: util-linux script(1) is not installed");
    const dir = scratch();
    mkdirSync(join(dir, "denied"));
    const probe = `if (exec 3</dev/tty) 2>/dev/null; then echo tty-open; else echo no-tty; fi`;
    // Positive control: under a pseudo-terminal of its own (script), a plain process has a controlling terminal.
    const plain = spawnSync("script", ["-qec", probe, "/dev/null"], { encoding: "utf8", timeout: 30_000 });
    expect(plain.stdout).toContain("tty-open");
    const { file, args, env } = sandboxedSpawn("/bin/sh", ["-c", `${probe}; python3 -c 'import fcntl,termios,os
try:
    fd=os.open("/dev/tty",os.O_RDWR); fcntl.ioctl(fd,termios.TIOCSTI,b"x"); print("tiocsti-sent")
except OSError as e: print("tiocsti-refused")' 2>/dev/null || echo tiocsti-refused`], [join(dir, "denied")], NO_GRANTS, dir);
    const quoted = [file, ...args].map(one => `'${one.replace(/'/g, "'\\''")}'`).join(" ");
    const inside = spawnSync("script", ["-qec", quoted, "/dev/null"], { encoding: "utf8", timeout: 30_000, cwd: dir, env: { ...process.env, ...env } });
    expect(inside.stdout, inside.stderr).toContain("no-tty");
    expect(inside.stdout).toContain("tiocsti-refused");
    expect(inside.stdout).not.toContain("tiocsti-sent");
  });
});
