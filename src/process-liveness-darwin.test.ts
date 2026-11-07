/**
 * The real macOS process table. Only Darwin's fork rules let a newer process with a saved group's number prove that
 * group gone (process-liveness.ts), so the proof is tested where it applies; the fixtures in task-control.test.ts cover
 * the logic everywhere.
 */
import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { processMayBeAlive } from "./process-liveness.js";

test.skipIf(process.platform !== "darwin")("the real process table proves a group newer than a recorded exit, and refuses one born before it", async () => {
  // Its own group, started here; stopped by this exact handle below.
  const held = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise(resolve => held.once("spawn", resolve));
  try {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const witness = (exitedAt: string) => ({ observedAt: ago(3 * 3_600_000), finishedAt: ago(3_600_000), exitedAt });
    expect(processMayBeAlive(held.pid!, true, witness(ago(2 * 3_600_000)))).toBe(false);
    expect(processMayBeAlive(held.pid!, true, { ...witness(ago(0)), observedAt: ago(-60_000) })).toBe(true);
  } finally { held.kill("SIGKILL"); }
});
