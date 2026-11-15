/** The Linux launch helper (sandbox-launch.ts): the launch runs once, its exit status is the helper's, and the
 * descriptor that says it started never reaches it. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { linuxFenceAvailable, NO_GRANTS, sandboxedSpawn } from "./agent-fence.js";
import { SANDBOX_LAUNCH_SPEC, type SandboxLaunchSpec } from "./sandbox-runtime.js";

test.skipIf(process.platform !== "linux" || !linuxFenceAvailable())("native Linux: a launch runs exactly once, keeps its exit status, and never sees the start descriptor", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-launch-")));
  try {
    const log = join(dir, "ran.log");
    const wrapped = sandboxedSpawn("/bin/sh", ["-c", `echo once >> ${JSON.stringify(log)}; test -e /proc/self/fd/3 && echo fd3-open || echo fd3-closed; exit 7`], [join(dir, "denied")], NO_GRANTS, dir);
    const result = spawnSync(wrapped.file, wrapped.args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...wrapped.env } });
    expect(result.status, result.stderr).toBe(7);
    expect(result.stdout.trim()).toBe("fd3-closed");
    expect(readFileSync(log, "utf8")).toBe("once\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux" || !linuxFenceAvailable())("native Linux: where bubblewrap, socat or the seccomp helper is gone, nothing runs; with them, it does (positive control), and PATH never picks them", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-launch-")));
  try {
    const marker = join(dir, "ran");
    const wrapped = sandboxedSpawn("/bin/sh", ["-c", `touch ${JSON.stringify(marker)}`], [join(dir, "denied")], NO_GRANTS, dir);
    // The helper checks again for itself, at the exact paths it was handed (never PATH): bubblewrap gone from its path
    // is a machine without it.
    const spec = JSON.parse(wrapped.env[SANDBOX_LAUNCH_SPEC]!) as SandboxLaunchSpec;
    const gone = { [SANDBOX_LAUNCH_SPEC]: JSON.stringify({ ...spec, tools: { ...spec.tools, bwrap: { ...spec.tools.bwrap, real: join(dir, "gone", "bwrap") } } }) };
    const bare = spawnSync(wrapped.file, wrapped.args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...wrapped.env, ...gone } });
    expect(bare.status, bare.stderr).toBe(126);
    expect(bare.stderr).toMatch(/nothing was started: bwrap .*isn't there/);
    expect(() => readFileSync(marker)).toThrow();
    // A bubblewrap planted first on the launch's PATH is never the one that runs: root's own does.
    const planted = join(dir, "planted");
    mkdirSync(planted);
    // So is a `which`, a bash or a seccomp helper planted there: the helper's own lookups never see the launch's PATH.
    for (const name of ["bwrap", "which", "bash", "apply-seccomp"]) writeFileSync(join(planted, name), `#!/bin/sh\ntouch ${JSON.stringify(join(dir, "planted-ran"))}\necho ${JSON.stringify(join(planted, "bash"))}\n`, { mode: 0o755 });
    const ok = spawnSync(wrapped.file, wrapped.args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...wrapped.env, PATH: `${planted}:${process.env["PATH"] ?? ""}` } });
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("");
    expect(existsSync(join(dir, "planted-ran"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux" || !linuxFenceAvailable())("native Linux: a stop at any point of setup never lets the launch start afterwards, and ends nonzero", async () => {
  const { spawn } = await import("node:child_process");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-launch-")));
  try {
    for (const delay of [0, 30, 80, 150, 300, 600]) {
      const marker = join(dir, `ran-${delay}`);
      const wrapped = sandboxedSpawn("/bin/sh", ["-c", `touch ${JSON.stringify(marker)}; sleep 5`], [join(dir, "denied")], NO_GRANTS, dir);
      const child = spawn(wrapped.file, wrapped.args, { cwd: dir, env: { ...process.env, ...wrapped.env }, stdio: "ignore" });
      setTimeout(() => child.kill("SIGTERM"), delay);
      const status = await new Promise<number | null>(done => child.on("close", (code, signal) => done(code ?? (signal === null ? null : 143))));
      // Whenever it stopped, it ended nonzero; and a launch that hadn't started never started after the stop.
      expect(status, `${delay} ms`).not.toBe(0);
      const atClose = existsSync(marker);
      await new Promise(done => setTimeout(done, 500));
      if (!atClose) expect(existsSync(marker), `${delay} ms: started after the stop`).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
