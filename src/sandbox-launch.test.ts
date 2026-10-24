/** The Linux launch helper (sandbox-launch.ts): the launch runs once, its exit status is the helper's, and the
 * descriptor that says it started never reaches it. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { linuxFenceAvailable, NO_GRANTS, sandboxedSpawn } from "./agent-fence.js";

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
