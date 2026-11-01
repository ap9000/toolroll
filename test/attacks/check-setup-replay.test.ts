/** A filesystem lookup and shell-looking output cannot prove that a check never executed. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { approvedProgramMissing, launchFailedBeforeCheck } from "../../src/builder.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "check-replay-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test.each(["argument substitution", "relative PATH", "lookup race"])("attack: %s cannot turn executed code into a launch failure", kind => {
  const program = join(root, "check"), marker = join(root, "ran");
  let command = program, path = process.env["PATH"] ?? "/usr/bin:/bin";
  const plant = () => writeFileSync(program, `#!/bin/sh\necho ran > '${marker}'\necho '/bin/sh: ${kind === "relative PATH" ? "check" : program}: command not found' >&2\nexit 127\n`, { mode: 0o755 });
  if (kind === "argument substitution") command += ` $(echo ran > '${marker}')`;
  if (kind === "relative PATH") { plant(); command = "check"; path = ".:/usr/bin:/bin"; }
  const missing = approvedProgramMissing(command, root, path);
  if (kind === "lookup race") plant();
  const out = spawnSync("/bin/sh", ["-c", command], { cwd: root, env: { PATH: path }, encoding: "utf8", timeout: 5_000 });
  expect(existsSync(marker)).toBe(true);
  expect(out.status).toBe(127);
  expect(launchFailedBeforeCheck({ code: out.status!, stdout: out.stdout, stderr: out.stderr, timedOut: false, notFound: false }, null, missing)).toBe(false);
});
