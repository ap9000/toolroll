/**
 * Attack: read another process's secrets without touching a file. A debugger attach (lldb, `task_for_pid`) reads a
 * tool server's or Toolroll's memory and environment; a direct `sysctl(KERN_PROCARGS2)` (what `ps -E` uses) reads its
 * arguments and environment. Guard: macosFenceProfile denies `kern.procargs`, process info outside the build's own
 * sandbox, and task ports. The build's own processes still start, signal and wait.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentFence, macosFenceProfile, NO_GRANTS } from "../../src/agent-fence.js";
import { holder, lines, marker, needs, q, seatbelt, sha256, underSeatbelt, useChildren, useScratch, write } from "./harness.js";

/** A direct sysctl(CTL_KERN=1, KERN_PROCARGS2=49, pid): `ps` is setuid and can't run in a sandbox, so it would prove
 * nothing. Says only whether it could read, and the digest of any SO_ATTACK_MARKER seen. */
const PROBE = [
  "import ctypes, hashlib, re, sys",
  "libc = ctypes.CDLL(None, use_errno=True)",
  "for pid in sys.argv[1:]:",
  "    size = ctypes.c_size_t(1 << 20)",
  "    buf = ctypes.create_string_buffer(size.value)",
  "    mib = (ctypes.c_int * 3)(1, 49, int(pid))",
  "    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:",
  "        print('denied'); continue",
  "    found = re.search(rb'SO_ATTACK_MARKER=([^\\0]*)', buf.raw[:size.value])",
  "    print('read ' + (hashlib.sha256(found.group(1)).hexdigest() if found else 'no-marker'))",
].join("\n");
const python = spawnSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const lldb = existsSync("/usr/bin/lldb") && spawnSync("/usr/bin/lldb", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0;

describe("attack: debugger attach and reading another process's arguments or environment", () => {
  const scratch = useScratch("procinfo");
  const track = useChildren();
  const fenceOf = () => {
    const dir = scratch();
    const worktree = join(dir, "app");
    mkdirSync(worktree);
    return { dir, worktree, fence: agentFence({ databaseFile: null, worktree, home: join(dir, "home") }) };
  };

  test("policy: every profile denies kern.procargs, foreign process info and task ports, and keeps its own sandbox's process info", () => {
    const profile = macosFenceProfile([], NO_GRANTS).split("\n");
    expect(profile).toEqual(expect.arrayContaining([
      '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
      "(deny process-info-pidinfo)",
      "(allow process-info-pidinfo (target same-sandbox))",
      "(deny mach-priv-task-port)",
      "(deny mach-task-name)",
    ]));
    // The same-sandbox allow comes after the blanket deny, or it would be overridden.
    expect(profile.indexOf("(allow process-info-pidinfo (target same-sandbox))")).toBeGreaterThan(profile.indexOf("(deny process-info-pidinfo)"));
  });

  test("native: KERN_PROCARGS2 and ps can't read another process's environment; the build's own processes still run", async ctx => {
    needs(ctx, seatbelt());
    ctx.skip(python === "", "KERN_PROCARGS2 probe skipped: python3 is not installed");
    const { dir, worktree, fence } = fenceOf();
    const secret = marker("procargs");
    const target = await holder({ SO_ATTACK_MARKER: secret }, track);
    const probe = write(join(dir, "probe.py"), PROBE);
    const fenced = underSeatbelt([
      `${q(python)} ${q(probe)} ${target.pid} ${process.pid}`,
      `ps -E -p ${target.pid} -o command= 2>/dev/null | grep -c SO_ATTACK_MARKER || true`,
      `ps eww -p ${target.pid} 2>/dev/null | grep -c SO_ATTACK_MARKER || true`,
    ].join("\n"), fence, NO_GRANTS, { cwd: worktree });
    expect(fenced.stdout + fenced.stderr).not.toContain(secret);
    expect(fenced.stdout).not.toContain(sha256(secret));
    expect(lines(fenced).slice(0, 2)).toEqual(["denied", "denied"]);
    // Control: unfenced, the same probe reads the marker, so the fence is what holds.
    expect(spawnSync(python, [probe, String(target.pid)], { encoding: "utf8" }).stdout.trim()).toBe(`read ${sha256(secret)}`);
    // Legitimate: the build starts, signals and waits on its own children.
    const own = underSeatbelt(`sleep 5 & child=$!; kill -0 "$child" && echo child-alive; kill "$child"; wait "$child" 2>/dev/null; echo waited; ${q(process.execPath)} -e 'console.log("node-ok")'`, fence, NO_GRANTS, { cwd: worktree });
    expect(lines(own), own.stderr).toEqual(["child-alive", "waited", "node-ok"]);
  });

  test("native: lldb can't attach (task_for_pid) to read another process's environment", async ctx => {
    needs(ctx, seatbelt());
    ctx.skip(!lldb, "debugger attach probe skipped: lldb (Command Line Tools) is not installed");
    const { worktree, fence } = fenceOf();
    const secret = marker("lldb");
    const target = await holder({ SO_ATTACK_MARKER: secret }, track);
    const probe = `/usr/bin/lldb -p ${target.pid} --batch -o 'expr -- (char*)getenv("SO_ATTACK_MARKER")' 2>&1`;
    const fenced = underSeatbelt(probe, fence, NO_GRANTS, { cwd: worktree, timeout: 90_000 });
    expect(fenced.stdout).not.toContain(secret);
    expect(fenced.stdout).toMatch(/attach failed|Not allowed to attach|error/i);
    const outside = spawnSync("/bin/sh", ["-c", probe], { encoding: "utf8", timeout: 90_000 });
    // Some machines refuse debugging outside any sandbox too; then only the fenced refusal is proved, said plainly.
    if (/attach failed|Not allowed/i.test(outside.stdout)) await ctx.annotate("lldb can't attach outside the fence on this machine either; only the fenced refusal is proved");
    else expect(outside.stdout).toContain(secret);
  }, 120_000);
});
