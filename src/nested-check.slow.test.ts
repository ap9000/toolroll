/**
 * The release check runs inside the plane's check fence, where macOS can't nest a sandbox (run 3235: twelve files that
 * launch flows' scripts and project tools' servers failed there, since those launches are fenced and required). The
 * plane allows unconfined agents there; each such test's store does the same when INSIDE_FENCE (test/inside-fence.ts).
 * This runs a few of those files inside an outer sandbox, as the plane does, and expects them to pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { INSIDE_FENCE } from "../test/inside-fence.js";

// Like the plane's check fence for this purpose: anything else allowed, but it denies something, so nothing nests, and
// it holds the shared launch root (/private/tmp/so-cmd-…) that fenced launches make their folders in.
const OUTER = '(version 1)(allow default)(deny file-write* (regex #"^/private/tmp/so-cmd-"))';
const NEST_PROBE = "(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(allow sysctl-read)(allow mach-lookup)";
const FILES = ["src/subagent-tools.test.ts", "src/flow-code.test.ts", "test/attacks/flow-schedule-swap.test.ts", "test/attacks/flow-boundary.test.ts"];
const native = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !INSIDE_FENCE;

test.skipIf(!native)("files that launch flows' scripts and tools' servers pass inside an outer sandbox, as in the plane's check", () => {
  const root = resolve(import.meta.dirname, "..");
  // Positive control: inside the outer sandbox, a new sandbox can't be made (the condition the files must handle).
  const nested = spawnSync("/usr/bin/sandbox-exec", ["-p", OUTER, "/usr/bin/sandbox-exec", "-p", NEST_PROBE, "/usr/bin/true"], { encoding: "utf8" });
  expect(nested.status).not.toBe(0);
  const ran = spawnSync("/usr/bin/sandbox-exec", ["-p", OUTER, resolve(root, "node_modules/.bin/vitest"), "run", ...FILES], {
    // Inside the outer sandbox no new one can start, so these files' native cases must skip there: the CI lane's
    // TOOLROLL_REQUIRE_NATIVE (which makes a missing native facility fail) is not the inner run's to obey.
    cwd: root, encoding: "utf8", timeout: 540_000, env: { ...withoutRequiredNative(withoutColor(process.env)), NO_COLOR: "1", VITEST_MAX_WORKERS: "2" },
  });
  expect(ran.status, `${ran.stdout}\n${ran.stderr}`.slice(-4000)).toBe(0);
  // Plain text: the release check forces colour, whose codes would sit between the words (run 3241).
  expect(ran.stdout.replace(/\u001b\[[0-9;]*m/g, "")).toMatch(/Test Files {2}4 passed/);
}, 600_000);

/** The environment without what forces colour, so the inner run's summary is plain text. */
function withoutColor(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { FORCE_COLOR: _force, CLICOLOR_FORCE: _clicolor, ...rest } = env;
  return rest;
}

/** The environment without the lane's native requirement, which a run inside an outer sandbox can never meet. */
function withoutRequiredNative(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TOOLROLL_REQUIRE_NATIVE: _required, ...rest } = env;
  return rest;
}
