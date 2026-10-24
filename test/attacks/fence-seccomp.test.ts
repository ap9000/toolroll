/**
 * Attack: a Linux build leaving its sandbox through the kernel instead of the filesystem: a new user namespace (which
 * can undo the mount denies), a VM socket (which no network namespace fences), io_uring (which makes sockets without the
 * socket() call) or a unix socket to a host service. Every Linux workload runs through Anthropic's sandbox-runtime's
 * seccomp helper (shipped in its package), which refuses a unix socket and io_uring; a VM socket and a new user
 * namespace are left as the runtime leaves them. Positive control: unsandboxed, every probe succeeds here.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { NO_GRANTS } from "../../src/agent-fence.js";
import { needs, osFence, underSandboxAsync, useScratch } from "./harness.js";

const scratch = useScratch("seccomp");
const PROBE = resolve(import.meta.dirname, "../fixtures/seccomp-probe.py");
const probeLines = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => line.split(" ") as [string, string]));

describe("attack: leaving the Linux fence through the kernel", () => {
  test("native Linux: io_uring, a VM socket, a new user namespace and a unix socket work unsandboxed and are refused inside", async ctx => {
    ctx.skip(process.platform !== "linux", "seccomp checks skipped: not Linux");
    needs(ctx, osFence());
    const plain = probeLines(spawnSync("python3", [PROBE], { encoding: "utf8" }).stdout);
    expect(plain).toMatchObject({ io_uring: "ok", userns: "ok", unix: "ok" });
    // A machine with no VM-socket transport refuses the family itself (EAFNOSUPPORT); the filter's EPERM is still
    // a different answer, so it still shows the filter acted.
    expect(plain["vsock"] === "ok" || plain["vsock"] !== "EPERM").toBe(true);
    const dir = scratch();
    mkdirSync(join(dir, "denied"));
    const inside = await underSandboxAsync(`python3 ${JSON.stringify(PROBE)}`, [join(dir, "denied")], NO_GRANTS, { cwd: dir });
    const said = probeLines(inside.stdout);
    // What the sandbox runtime's filter refuses: making a unix socket, and io_uring. A VM socket and a new user
    // namespace are its to allow (its limits: a user namespace inside bubblewrap's can't undo the mounts it was given).
    expect(said["unix"], inside.stderr).toBe("EPERM");
    expect(said["io_uring"], JSON.stringify(said)).not.toBe("ok");
  });
});
