import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Whether these tests run inside a macOS sandbox: the release check runs inside the plane's check fence, and macOS
 * refuses a new sandbox inside any sandbox that denies anything, and the fence hides other processes. Tests that must
 * create a sandbox, watch other processes or set special file bits skip there; CI (Linux, and the tag's macOS jobs)
 * runs them unfenced.
 */
export const INSIDE_FENCE: boolean = (() => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return false;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 10_000 });
    return false;
  } catch {
    return true;
  }
})();
