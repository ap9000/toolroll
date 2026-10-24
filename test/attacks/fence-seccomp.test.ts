/**
 * Attack: a Linux build leaving its sandbox through the kernel instead of the filesystem (docs/plans/sandbox-parity.md
 * C7): a new user namespace (which can undo the mount denies), a VM socket (which no network namespace fences) or
 * io_uring (which makes sockets without the socket() call). Every Linux workload now runs through the seccomp helper
 * vendored from Anthropic's sandbox runtime, which refuses all three with EPERM; and a helper replaced after it was
 * installed means no Linux fence at all. Positive control: unsandboxed, every probe succeeds here.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { linuxFenced, NO_GRANTS } from "../../src/agent-fence.js";
import { CONTAINMENT_REFUSED_CODE, run } from "../../src/exec.js";
import { installSeccompHelper, verifySeccompHelper } from "../../src/seccomp-helper.js";
import { nativeSeccomp } from "../seccomp-fixture.js";
import { needs, useScratch } from "./harness.js";

const scratch = useScratch("seccomp");
const PROBE = resolve(import.meta.dirname, "../fixtures/seccomp-probe.py");

function seccompHere(): { available: boolean; note: string; platform?: NodeJS.Platform } {
  if (process.platform !== "linux") return { available: false, note: "seccomp checks skipped: not Linux" };
  if (nativeSeccomp() === null) return { available: false, platform: "linux", note: "seccomp checks skipped: no seccomp helper built (node vendor/seccomp/build.mjs)" };
  const ran = spawnSync("bwrap", ["--dev-bind", "/", "/", "--new-session", "--unshare-pid", "--proc", "/proc", "--", "true"], { encoding: "utf8", timeout: 5_000 });
  return ran.status === 0 ? { available: true, note: "" } : { available: false, platform: "linux", note: `seccomp checks skipped: ${(ran.stderr ?? "").trim() || "bwrap can't make its namespaces here"}` };
}

const probeLines = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => line.split(" ") as [string, string]));

describe("attack: leaving the Linux fence through the kernel", () => {
  test("native: io_uring, a VM socket and a new user namespace work unsandboxed and are refused (EPERM) inside", async ctx => {
    needs(ctx, seccompHere());
    const plain = probeLines(spawnSync("python3", [PROBE], { encoding: "utf8" }).stdout);
    expect(plain).toMatchObject({ io_uring: "ok", userns: "ok" });
    // A machine with no VM-socket transport refuses the family itself (EAFNOSUPPORT); the filter's EPERM is still
    // a different answer, so it still shows the filter acted.
    expect(plain["vsock"] === "ok" || plain["vsock"] !== "EPERM").toBe(true);
    const dir = scratch();
    mkdirSync(join(dir, "denied"));
    const { file, args } = linuxFenced("python3", [PROBE], [join(dir, "denied")], { ...NO_GRANTS, seccomp: nativeSeccomp()! });
    const inside = await new Promise<string>(done => {
      const child = spawn(file, args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", chunk => { out += chunk; });
      child.on("close", () => done(out));
    });
    expect(probeLines(inside)).toEqual({ io_uring: "EPERM", vsock: "EPERM", userns: "EPERM" });
  });

  test("a helper replaced after it was installed (or missing) means no Linux fence: nothing runs", async ctx => {
    needs(ctx, seccompHere());
    const state = scratch();
    const installed = installSeccompHelper(state, { path: nativeSeccomp()!.helper, sha256: nativeSeccomp()!.sha256 });
    expect(installed).not.toBeNull();
    expect(verifySeccompHelper(installed!)).toBe(true);
    // A build can't reach the state folder; this is what a replaced helper would be.
    writeFileSync(installed!.helper, "#!/bin/sh\nexec \"$@\"\n");
    expect(verifySeccompHelper(installed!)).toBe(false);
    const ran = await run("/bin/true", [], { fence: [join(state, "denied")], fenceGrants: { ...NO_GRANTS, seccomp: installed! }, confinement: "required" });
    expect(ran).toMatchObject({ code: CONTAINMENT_REFUSED_CODE });
    expect(ran.stderr).toMatch(/seccomp helper/);
    // A copy that doesn't hash to the manifest is never installed in its place.
    const bad = join(state, "bad");
    copyFileSync(installed!.helper, bad);
    expect(installSeccompHelper(join(state, "other"), { path: bad, sha256: nativeSeccomp()!.sha256 })).toBeNull();
  });
});
