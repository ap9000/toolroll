// A miniature Vitest suite for src/suite-lifecycle.test.ts: it leaves a temp folder and a helper process, then passes
// or hangs (FIXTURE_MODE). The run's temp root (test/temp-root.ts) and the helper must be gone however it ends.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

test("leaves things behind", async () => {
  const made = mkdtempSync(join(tmpdir(), "so-fixture-"));
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", cwd: made });
  writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify({ tmp: tmpdir(), made, helper: helper.pid }));
  if (process.env.FIXTURE_MODE === "hang") await new Promise(() => {});
}, 600_000);
