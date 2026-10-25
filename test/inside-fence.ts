import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { linuxFenceAvailable, macosFenceAvailable } from "../src/agent-fence.js";
import { tmpdir } from "node:os";

/**
 * Whether these tests run inside a macOS sandbox: the release check runs inside the plane's check fence, and macOS
 * refuses a new sandbox inside any sandbox that denies anything, and the fence hides other processes. Tests that must
 * create a sandbox, watch other processes or set special file bits skip there; CI (Linux, and the tag's macOS jobs)
 * runs them unfenced.
 */
export const INSIDE_FENCE: boolean = (() => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return false;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(allow sysctl-read)(allow mach-lookup)", "/usr/bin/true"], { stdio: "ignore", timeout: 10_000 });
    return false;
  } catch {
    return true;
  }
})();

/**
 * Whether this run's temp folder leaves too little room for a unix socket test (about 104 bytes in all): inside an older
 * plane's check fence, whose launch folder is deep. Since 0.9.69 a check's launch folder on a Mac is short
 * (/private/tmp/so-cmd-…), so socket tests run inside a fence too.
 */
export const SOCKETS_TOO_DEEP: boolean = INSIDE_FENCE && realpathSync(tmpdir()).length > 49;

/**
 * Whether no OS fence can be made here at all: inside another sandbox (INSIDE_FENCE), or on a Linux runner without the
 * sandbox runtime's tools (bubblewrap, socat, ripgrep) or with unprivileged user namespaces refused. Launches that
 * require a fence (flows' scripts, tools' servers) are then refused unless an operator allowed unconfined agents, so a
 * test that isn't about the fence allows them in its store, as an operator of such a machine would.
 */
export const NO_OS_FENCE: boolean = INSIDE_FENCE || !(macosFenceAvailable() || linuxFenceAvailable());
