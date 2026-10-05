/**
 * OS process containment (docs/PROCESS_CONTAINMENT_PLAN.md): the policy
 * words, the truthful capability, the pinned requirement that nothing can
 * weaken, and the shared spawn transports — buffered, streaming, held —
 * refusing BEFORE any target executes when required containment is not
 * there, and preserving argv, stdin, environment, cwd and exact-run
 * custody when it is. The OS object here is a file-backed stand-in that
 * runs the real cgroup2 prelude; the kernel-backed object is exercised by
 * containment-native.test.ts on Linux.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CGROUP2_PRELUDE,
  CONTAINMENT_ENV,
  containmentNotice,
  createContainer,
  currentContainment,
  describeContainment,
  effectiveContainment,
  overrideContainerFactoryForTests,
  ownCgroupPath,
  parseContainmentPolicy,
  pinContainment,
  probeContainmentCapability,
  resetContainmentForTests,
  resolveContainment,
  type AttachOutcome,
  type Container,
  type ContainmentCapability,
} from "./containment.js";
import { CONTAINMENT_REFUSED_CODE, run, runClaudeStreamJsonl, runGeminiStreamJsonl, runStreamJsonl, startClaudeHeldSession } from "./exec.js";
import { witnessedRunner } from "./process-custody.js";
import { openStore } from "./store.js";

const posix = process.platform !== "win32";

describe("the policy words", () => {
  test("absent means observed — every existing installation keeps its behaviour", () => {
    expect(parseContainmentPolicy(undefined)).toEqual({ ok: true, policy: "observed", source: "default" });
    expect(parseContainmentPolicy(null)).toEqual({ ok: true, policy: "observed", source: "default" });
  });

  test("the three words parse exactly, case- and space-insensitively", () => {
    expect(parseContainmentPolicy("required")).toEqual({ ok: true, policy: "required", source: "explicit" });
    expect(parseContainmentPolicy(" Preferred ")).toEqual({ ok: true, policy: "preferred", source: "explicit" });
    expect(parseContainmentPolicy("observed")).toEqual({ ok: true, policy: "observed", source: "explicit" });
  });

  test("a corrupt word is a refusal, never a quiet fall back to observed", () => {
    for (const word of ["yes", "", "native", "require", "0", "true"]) {
      const parsed = parseContainmentPolicy(word);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problem).toContain("observed, preferred, required");
    }
  });
});

describe("the capability, established by doing", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-contain-cap-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("macOS has no native backend and says why, with the VM/Linux route", () => {
    const capability = probeContainmentCapability({ platform: "darwin" });
    expect(capability).toMatchObject({ platform: "darwin", backend: null, available: false });
    expect(capability.detail).toContain("NOTE_TRACK");
    expect(capability.detail).toContain("AbandonProcessGroup");
    expect(capability.detail).toMatch(/Linux VM|Linux runner/);
  });

  test("linux: a mount that is not cgroup v2 is unavailable", () => {
    const capability = probeContainmentCapability({ platform: "linux", cgroupMount: dir, selfCgroup: "0::/own\n" });
    expect(capability).toMatchObject({ platform: "linux", backend: "cgroup2", available: false });
    expect(capability.detail).toContain("not a cgroup v2");
  });

  test("linux: /proc/self/cgroup without a unified entry is unavailable", () => {
    writeFileSync(join(dir, "cgroup.controllers"), "cpu memory\n");
    expect(ownCgroupPath("12:memory:/legacy\n")).toBeNull();
    expect(ownCgroupPath("0::/user.slice/user-1000.slice/session-2.scope\n")).toBe("/user.slice/user-1000.slice/session-2.scope");
    const capability = probeContainmentCapability({ platform: "linux", cgroupMount: dir, selfCgroup: "12:memory:/legacy\n" });
    expect(capability).toMatchObject({ available: false });
    expect(capability.detail).toContain("0::");
  });

  test("linux: a cgroup this user cannot create children in is not delegated — unavailable, with the delegation route", () => {
    if (!posix || process.getuid?.() === 0) return;
    writeFileSync(join(dir, "cgroup.controllers"), "cpu memory\n");
    mkdirSync(join(dir, "own"));
    chmodSync(join(dir, "own"), 0o555);
    try {
      const capability = probeContainmentCapability({ platform: "linux", cgroupMount: dir, selfCgroup: "0::/own\n" });
      expect(capability).toMatchObject({ available: false, cgroupRoot: join(dir, "own") });
      expect(capability.detail).toContain("not delegated");
      expect(capability.detail).toContain("Delegate=yes");
    } finally {
      chmodSync(join(dir, "own"), 0o755);
    }
  });

  test("linux: ordinary files cannot fake an atomic kernel cgroup.kill capability", () => {
    writeFileSync(join(dir, "cgroup.controllers"), "cpu memory\n");
    mkdirSync(join(dir, "own"));
    const without = probeContainmentCapability({ platform: "linux", cgroupMount: dir, selfCgroup: "0::/own\n" });
    expect(without).toMatchObject({ available: false, backend: "cgroup2", cgroupRoot: join(dir, "own"), cgroupKill: false });
    expect(without.detail).toContain("cgroup.kill");
    writeFileSync(join(dir, "own", "cgroup.kill"), "");
    const withKill = probeContainmentCapability({ platform: "linux", cgroupMount: dir, selfCgroup: "0::/own\n" });
    expect(withKill).toMatchObject({ available: false, cgroupKill: false });
    // The probe left nothing behind.
    expect(existsSync(join(dir, "own"))).toBe(true);
    expect(readFileSync(join(dir, "cgroup.controllers"), "utf8")).toBe("cpu memory\n");
  });

  test("windows: the Job Object backend needs its helper and PowerShell, and says which is missing", () => {
    expect(probeContainmentCapability({ platform: "win32", helperPath: join(dir, "missing.ps1") })).toMatchObject({ backend: "job-object", available: false, detail: expect.stringContaining("helper is missing") });
    writeFileSync(join(dir, "helper.ps1"), "# helper\n");
    const powershell = join(dir, "powershell.exe");
    writeFileSync(powershell, "");
    expect(probeContainmentCapability({ platform: "win32", helperPath: join(dir, "helper.ps1"), powershellPath: powershell })).toMatchObject({ backend: "job-object", available: true, helper: join(dir, "helper.ps1"), powershell });
  });

  test("an unknown platform is observed-only and says so", () => {
    expect(probeContainmentCapability({ platform: "freebsd" })).toMatchObject({ backend: null, available: false });
  });
});

const unavailable: ContainmentCapability = { platform: "darwin", backend: null, available: false, detail: "macOS has no supported cgroup or Job Object equivalent" };
const available: ContainmentCapability = { platform: "linux", backend: "cgroup2", available: true, detail: "delegated cgroup v2 at /own", cgroupRoot: "/sys/fs/cgroup/own", cgroupKill: true };

describe("the effective status is truthful", () => {
  test("observed is observed whatever the machine can do", () => {
    expect(effectiveContainment("observed", available)).toMatchObject({ mode: "observed", downgraded: false, refusal: null });
    expect(effectiveContainment("observed", unavailable)).toMatchObject({ mode: "observed", downgraded: false, refusal: null });
    expect(describeContainment(effectiveContainment("observed", unavailable))).toContain("observed");
  });

  test("preferred on a capable machine is native; on an incapable one it is observed AND reported as a downgrade", () => {
    expect(effectiveContainment("preferred", available)).toMatchObject({ mode: "native", downgraded: false, refusal: null });
    const downgraded = effectiveContainment("preferred", unavailable);
    expect(downgraded).toMatchObject({ mode: "observed", downgraded: true, refusal: null });
    expect(describeContainment(downgraded)).toContain("preferred native");
    expect(describeContainment(downgraded)).toContain("unavailable");
  });

  test("required on an incapable machine never downgrades: it refuses, in actionable words", () => {
    const refused = effectiveContainment("required", unavailable);
    expect(refused.mode).toBe("observed");
    expect(refused.downgraded).toBe(false);
    expect(refused.refusal).toContain("required but unavailable on this darwin runner");
    expect(refused.refusal).toContain(unavailable.detail);
    expect(describeContainment(refused)).toContain("REQUIRED but unavailable");
    expect(effectiveContainment("required", available)).toMatchObject({ mode: "native", refusal: null });
  });
});

describe("the start-up notice", () => {
  const undelegated: ContainmentCapability = { platform: "linux", backend: "cgroup2", available: false, cgroupRoot: "/sys/fs/cgroup", detail: "cgroup / is not delegated to this user (EROFS creating a child cgroup) — delegate it" };

  test("Linux without a delegated cgroup reads as one plain sentence; the exact reason stays in the status line", () => {
    for (const policy of ["observed", "preferred"] as const) {
      const effective = effectiveContainment(policy, undelegated);
      expect(containmentNotice(effective)).toBe("Agents run without Linux process containment on this machine (it needs a delegated cgroup). That's fine for trying Toolroll; see docs/guide/linux.md to turn it on.");
      expect(describeContainment(effective)).toContain("EROFS");
    }
  });

  test("nothing to say when containment is on, on other platforms, and never in place of a refusal", () => {
    expect(containmentNotice(effectiveContainment("preferred", available))).toBeNull();
    expect(containmentNotice(effectiveContainment("observed", available))).toBeNull();
    expect(containmentNotice(effectiveContainment("observed", unavailable))).toBeNull();
    expect(containmentNotice(effectiveContainment("required", undelegated))).toBeNull();
  });
});

describe("the pinned policy", () => {
  afterEach(() => { resetContainmentForTests(); delete process.env[CONTAINMENT_ENV]; });

  test("unpinned is observed; a pin stands; a weaker pin is refused, a tighter one admitted", () => {
    expect(currentContainment().policy).toBe("observed");
    pinContainment(effectiveContainment("preferred", unavailable));
    expect(currentContainment().policy).toBe("preferred");
    pinContainment(effectiveContainment("required", unavailable));
    expect(currentContainment().policy).toBe("required");
    expect(() => pinContainment(effectiveContainment("preferred", available))).toThrow(/pinned at required/);
    expect(() => pinContainment(effectiveContainment("observed", available))).toThrow(/would weaken/);
    expect(currentContainment().policy).toBe("required");
  });

  test("the flag wins over the environment, the environment over the default, and a corrupt value refuses to start", () => {
    process.env[CONTAINMENT_ENV] = "preferred";
    const fromEnv = resolveContainment(undefined);
    expect(fromEnv.ok && fromEnv.effective.policy).toBe("preferred");
    const fromFlag = resolveContainment("required");
    expect(fromFlag.ok && fromFlag.effective.policy).toBe("required");
    process.env[CONTAINMENT_ENV] = "corrupt";
    resetContainmentForTests();
    const corrupt = resolveContainment(undefined);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.problem).toContain('"corrupt"');
    expect(currentContainment().policy).toBe("observed");
  });
});

/**
 * A file-backed OS object: the REAL cgroup2 prelude, pointed at an
 * ordinary directory whose `cgroup.procs` is a plain file. It proves the
 * transport wiring on any POSIX machine — the join happens before the
 * exec, argv/stdin/env/cwd pass through, custody rides the callbacks —
 * without a kernel cgroup.
 */
function fileBackedContainer(root: string, log: string[], options: { joinable?: boolean } = {}): Container {
  const dir = join(root, `obj-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "cgroup.procs"), "");
  if (options.joinable === false) chmodSync(join(dir, "cgroup.procs"), 0o444);
  return {
    backend: "cgroup2",
    id: dir,
    launch(file, args) {
      log.push(`launch ${file}`);
      // Targets find their object through this note (a kernel cgroup would
      // be visible in /proc/self/cgroup instead).
      writeFileSync(join(root, "latest-object"), dir);
      return {
        file: "/bin/sh",
        args: ["-c", CGROUP2_PRELUDE, "so-contain", dir, file, ...args],
        extraStdio: ["pipe"],
        attach(child) {
          return new Promise<AttachOutcome>(resolve => {
            const channel = child.stdio[3] as import("node:net").Socket;
            let seen = "";
            channel.on("data", chunk => { seen += String(chunk); if (seen === "attached\n") { channel.write("go\n"); resolve({ ok: true }); } });
            channel.on("end", () => resolve({ ok: false, detail: `the target was not placed in ${dir} before execution (the join failed; the target never ran)` }));
          });
        },
      };
    },
    async kill() { log.push("kill"); return true; },
    populated() { return false; },
    async waitEmpty() { return true; },
    release() { log.push("release"); },
  };
}

describe("the shared transports under a required policy", () => {
  let dir: string;
  const log: string[] = [];
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-contain-transport-"))); log.length = 0; });
  afterEach(() => { resetContainmentForTests(); overrideContainerFactoryForTests(null); rmSync(dir, { recursive: true, force: true }); });

  const MARK = `
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.SO_MARK, "ran\\n");
  `;

  test.skipIf(!posix)("an exit-zero target cannot pass proof when the native object stays unproven", async () => {
    pinContainment(effectiveContainment("required", available));
    overrideContainerFactoryForTests(() => ({ ...fileBackedContainer(dir, log), populated: () => null, kill: async () => false }));
    for (const transport of [run, runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl]) {
      const result = await transport(process.execPath, ["-e", "process.exit(0)"], { processGroup: true, timeoutMs: 3000 });
      expect(result.code).toBe(CONTAINMENT_REFUSED_CODE);
      expect(result.containment).toMatchObject({ empty: false });
    }
  });

  test("c1: required + unavailable refuses BEFORE any target executes — buffered, streaming and held alike — with no witness reserved", async () => {
    pinContainment(effectiveContainment("required", unavailable));
    const mark = join(dir, "ran.txt");
    const script = join(dir, "mark.mjs");
    writeFileSync(script, MARK);
    let reserved = 0;
    const common = { processGroup: true, env: { SO_MARK: mark }, beforeSpawn: () => { reserved += 1; return true; }, timeoutMs: 10_000 };

    const buffered = await run(process.execPath, [script], common);
    expect(buffered.code).toBe(CONTAINMENT_REFUSED_CODE);
    expect(buffered.containment).toEqual({ refused: expect.stringContaining("required but unavailable") });
    expect(buffered.stderr).toContain("No provider, setup or check process runs");

    for (const transport of [runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl]) {
      const streamed = await transport(process.execPath, [script], { ...common, stdin: "{}\n" });
      expect(streamed.code).toBe(CONTAINMENT_REFUSED_CODE);
      expect(streamed.containment).toEqual({ refused: expect.stringContaining("required but unavailable") });
    }
    // A short socket path, like the held tests: under a suite's nested temp folder join(dir, …) passes macOS's 103-byte
    // limit and the session refuses for the path before it reaches the containment policy this test is about.
    const held = await startClaudeHeldSession(process.execPath, [script], { ...common, socketPath: `/tmp/so-ct-${process.pid}.sock`, cookie: "c", readyTimeoutMs: 2_000 });
    expect(held).toMatchObject({ ok: false, reason: "spawn-failed", message: expect.stringContaining("required but unavailable") });

    expect(existsSync(mark)).toBe(false);
    expect(reserved).toBe(0);
  });

  test("c1: a plain (non-provider) spawn is untouched by the policy — nothing outside the containable boundary is refused", async () => {
    pinContainment(effectiveContainment("required", unavailable));
    const plain = await run(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 10_000 });
    expect(plain).toMatchObject({ code: 0, stdout: "ok" });
    expect(plain.containment).toBeUndefined();
  });

  test("c1: under native containment the target is joined BEFORE it executes and receives argv, stdin, environment and cwd verbatim", async () => {
    if (!posix) return;
    pinContainment(effectiveContainment("required", available));
    overrideContainerFactoryForTests((_effective, label) => { log.push(`make ${label}`); return fileBackedContainer(dir, log); });
    const script = join(dir, "echo.mjs");
    writeFileSync(script, `
      import { readFileSync } from "node:fs";
      let input = ""; try { input = readFileSync(0, "utf8"); } catch {}
      const object = readFileSync(process.env.SO_ROOT + "/latest-object", "utf8");
      const procs = readFileSync(object + "/cgroup.procs", "utf8").trim();
      process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env.SO_PROBE, cwd: process.cwd(), input, joined: procs === String(process.pid), fd3: (() => { try { readFileSync(3); return "open"; } catch { return "closed"; } })() }));
    `);
    const args = ["--flag", "a value with spaces", 'quotes "inside"', "unicode ✓", "", "$HOME", "*"];
    let container: { backend: string; id: string } | null = null;
    let empties = 0;
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    const result = await run(process.execPath, [script, ...args], {
      processGroup: true,
      cwd,
      timeoutMs: 10_000,
      env: { SO_PROBE: "probe-value", SO_ROOT: dir },
      onContainer: info => { container = info; },
      onContainerEmpty: () => { empties += 1; },
    });
    expect(result.code).toBe(0);
    expect(container).not.toBeNull();
    expect(result.containment).toEqual({ backend: "cgroup2", id: container!.id, empty: true });
    expect(empties).toBe(1);
    expect(log).toEqual([expect.stringMatching(/^make /), `launch ${process.execPath}`, "release"]);

    const seen = JSON.parse(result.stdout) as { argv: string[]; env: string; cwd: string; fd3: string; joined: boolean; input: string };
    // The target read its own pid back from the object it was joined to
    // (sh's exec keeps the pid), BEFORE it ran: membership precedes execution.
    expect(seen.joined).toBe(true);
    expect(seen.argv).toEqual(args);
    expect(seen.env).toBe("probe-value");
    expect(seen.cwd).toBe(cwd);
    expect(seen.fd3).toBe("closed");
    expect(seen.input).toBe("");

    // stdin through the streaming transport, same object road: the target
    // writes what it read to a file, since the codex transport retains only
    // load-bearing JSONL lines.
    const sink = join(dir, "stdin.txt");
    writeFileSync(script, `
      import { readFileSync, writeFileSync } from "node:fs";
      const object = readFileSync(process.env.SO_ROOT + "/latest-object", "utf8");
      const procs = readFileSync(object + "/cgroup.procs", "utf8").trim();
      writeFileSync(process.env.SO_SINK, JSON.stringify({ input: readFileSync(0, "utf8"), joined: procs === String(process.pid), argv: process.argv.slice(2) }));
    `);
    const streamed = await runStreamJsonl(process.execPath, [script, "x y", "z"], { processGroup: true, cwd, timeoutMs: 10_000, stdin: "the whole prompt\n", env: { SO_ROOT: dir, SO_SINK: sink } });
    expect(streamed.code).toBe(0);
    expect(streamed.containment).toMatchObject({ backend: "cgroup2", empty: true });
    expect(JSON.parse(readFileSync(sink, "utf8"))).toEqual({ input: "the whole prompt\n", joined: true, argv: ["x y", "z"] });
  });

  test("c1: a failed join refuses with the target never having run, and the result says so", async () => {
    if (!posix || process.getuid?.() === 0) return;
    pinContainment(effectiveContainment("required", available));
    overrideContainerFactoryForTests(() => fileBackedContainer(dir, log, { joinable: false }));
    const mark = join(dir, "ran.txt");
    const script = join(dir, "mark.mjs");
    writeFileSync(script, MARK);
    const result = await run(process.execPath, [script], { processGroup: true, timeoutMs: 10_000, env: { SO_MARK: mark } });
    expect(result.code).toBe(CONTAINMENT_REFUSED_CODE);
    expect(result.containment).toEqual({ refused: expect.stringContaining("the target never ran") });
    expect(existsSync(mark)).toBe(false);
    // The object was still settled and released — nothing leaks.
    expect(log).toContain("release");
  });

  test("c1: exact-run custody names the OS object on the spawn witness and marks it empty only on the OS's word", async () => {
    if (!posix) return;
    pinContainment(effectiveContainment("required", available));
    overrideContainerFactoryForTests(() => fileBackedContainer(dir, log));
    const store = openStore(":memory:");
    try {
      const T0 = new Date("2026-09-12T10:00:00.000Z");
      store.createTask({ id: "t", title: "t" }, T0);
      const ref = store.refFor("built-in", "t").id;
      store.placeTask(ref, "/repo");
      const runId = store.startRun({ taskRef: ref, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
      const spawn = witnessedRunner(store, runId, () => new Date(), run);
      const result = await spawn(process.execPath, ["-e", "process.stdout.write('done')"], { processGroup: true, timeoutMs: 10_000 });
      expect(result).toMatchObject({ code: 0, stdout: "done" });
      const rows = store.raw().prepare("SELECT * FROM run_process WHERE run = ? ORDER BY id").all(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ containment: "cgroup2", container: expect.stringContaining(dir) });
      expect(rows[0]?.["container_empty_at"]).toEqual(expect.any(String));
      expect(rows[0]?.["pid"]).toEqual(expect.any(Number));
      // A witness whose object was NEVER proven empty keeps the stop fence closed.
      store.raw().prepare("UPDATE run_process SET container_empty_at = NULL, exited_at = NULL WHERE run = ?").run(runId);
      store.finishRun(runId, { outcome: "failed", reason: "interrupted", now: new Date() });
      const problem = store.stopQuiescenceProblem(runId);
      // The stand-in object's directory still exists without cgroup.events:
      // on Linux that reads unknown; elsewhere the backend cannot be probed.
      expect(problem).toMatch(/cannot be proven empty|still has members/);
    } finally {
      store.close();
    }
  });

  test("createContainer answers null under observed, refuses under required-unavailable, and makes the object under native", () => {
    expect(createContainer(effectiveContainment("observed", available), "x")).toEqual({ container: null });
    expect(createContainer(effectiveContainment("preferred", unavailable), "x")).toEqual({ container: null });
    const refused = createContainer(effectiveContainment("required", unavailable), "x");
    expect("refused" in refused && refused.refused).toContain("required but unavailable");
    overrideContainerFactoryForTests(() => fileBackedContainer(dir, log));
    const made = createContainer(effectiveContainment("required", available), "run:1");
    expect("container" in made && made.container?.backend).toBe("cgroup2");
    overrideContainerFactoryForTests(() => { throw new Error("mkdir EACCES"); });
    const failed = createContainer(effectiveContainment("required", available), "run:1");
    expect("refused" in failed && failed.refused).toContain("could not be established for this spawn");
  });
});
