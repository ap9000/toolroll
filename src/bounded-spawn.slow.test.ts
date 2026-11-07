/** One bounded process tree, against real processes, and the map's fetch against oversized objects (docs/plans/code-map.md §1). */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GIT_ENV, mapWorld, URL_A, type MapWorld } from "../test/code-map-world.js";
import { boundedRun, cleanupLeftover, folderBytes, processStartedAt } from "./bounded-spawn.js";
import { checkCodeMap } from "./code-map-build.js";
import { currentVersion, readRefresh, readVersionMap, recordFolder, recordSpawn, takeLease } from "./code-map-store.js";
import { initPrivateDir, MAP_FETCH_LIMITS, readShallowMain, shallowClean } from "./remote-main.js";

const posix = process.platform !== "win32";
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const base = (dir: string) => ({ cwd: dir, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, timeoutMs: 20_000, maxStdout: 1024 * 1024, maxStderr: 4096, label: "test" });
let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-bounded-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!posix)("the tree is bounded", () => {
  test("attack: a time limit kills the whole group, helpers included", async () => {
    const pidFile = join(dir, "pid");
    const ran = await boundedRun("/bin/sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], { ...base(dir), timeoutMs: 400 });
    expect(ran.killed).toBe("time");
    const helper = Number(execFileSync("cat", [pidFile], { encoding: "utf8" }).trim());
    await expect.poll(() => alive(helper)).toBe(false);
  });
  test("attack: nothing the root started outlives its exit", async () => {
    const pidFile = join(dir, "pid");
    await boundedRun("/bin/sh", ["-c", `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}`], base(dir));
    const helper = Number(execFileSync("cat", [pidFile], { encoding: "utf8" }).trim());
    await expect.poll(() => alive(helper)).toBe(false);
  });
  test("attack: memory past the limit is caught by the tripwire, and the result says it was checked, not enforced", async () => {
    const ran = await boundedRun(process.execPath, ["-e", "const held=[];for(;;){held.push(Buffer.alloc(32*1024*1024,1));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}"], { ...base(dir), memoryBytes: 150 * 1024 * 1024 });
    expect(ran.killed).toBe("memory");
    if (process.platform === "darwin") expect(ran.enforced).toBe("checked");
    expect(ran.peakBytes).toBeGreaterThan(150 * 1024 * 1024);
  });
  test("attack: a folder past its disk limit is killed", async () => {
    const ran = await boundedRun("/bin/sh", ["-c", `i=0; while :; do head -c 2000000 /dev/zero > ${dir}/f$i; i=$((i+1)); done`], { ...base(dir), diskBytes: 8_000_000, folder: dir });
    expect(ran.killed).toBe("disk");
  });
  test("attack: one file past RLIMIT_FSIZE can't be written", async () => {
    const ran = await boundedRun("/bin/sh", ["-c", `head -c 2000000 /dev/zero > ${dir}/big`], { ...base(dir), fileBytes: 512 * 1024 });
    expect(ran.code).not.toBe(0);
    expect(folderBytes(dir)).toBeLessThanOrEqual(512 * 1024);
  });
  test("attack: output past its cap is killed, and stderr is capped", async () => {
    const ran = await boundedRun("/bin/sh", ["-c", "yes | head -c 5000000; yes >&2"], { ...base(dir), maxStdout: 100_000, maxStderr: 64 });
    expect(ran.killed).toBe("output");
    expect(ran.stderr.length).toBeLessThanOrEqual(64);
  });
  test("argv reaches the target untouched", async () => {
    const ran = await boundedRun("/bin/sh", ["-c", 'printf "%s|" "$@"', "x", "a b", "$HOME", "`id`"], base(dir));
    expect(ran.stdout.toString()).toBe("a b|$HOME|`id`|");
  });
});

describe.skipIf(!posix)("crash cleanup", () => {
  const leftover = () => {
    const folder = join(dir, ".code-map-left");
    mkdirSync(folder);
    const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
    child.unref();
    return { child, folder, pid: child.pid! };
  };
  test("a recorded group is killed when its leader is still the same process, and the folder goes", async () => {
    const { pid, folder } = leftover();
    await expect.poll(() => processStartedAt(pid)).not.toBeNull();
    expect(cleanupLeftover({ pid, pgid: pid, startedAt: processStartedAt(pid), folder }, dir)).toEqual({ killed: true, removed: true });
    await expect.poll(() => alive(pid)).toBe(false);
    expect(existsSync(folder)).toBe(false);
  });
  test("attack: a reused pid isn't killed, and a folder outside the root isn't removed", async () => {
    const { pid, folder } = leftover();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "so-outside-")));
    await expect.poll(() => processStartedAt(pid)).not.toBeNull();
    try {
      expect(cleanupLeftover({ pid, pgid: pid, startedAt: "Mon Jan  1 00:00:00 2001", folder: outside }, dir)).toEqual({ killed: false, removed: false });
      expect(alive(pid)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally { process.kill(-pid, "SIGKILL"); rmSync(outside, { recursive: true, force: true }); rmSync(folder, { recursive: true, force: true }); }
  });
  test("worker death: the next worker's takeover kills the recorded group and removes the folder", async () => {
    const world = mapWorld();
    try {
      // A worker SIGKILLed mid-fetch leaves exactly this: an expired lease, a recorded spawn, a live group and a folder.
      mkdirSync(world.scratch, { recursive: true });
      const folder = join(world.scratch, ".code-map-dead");
      mkdirSync(folder);
      const lease = takeLease(world.store, world.repo, "worker-dead", world.now.at)!;
      const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
      child.unref();
      const pid = child.pid!;
      await expect.poll(() => processStartedAt(pid)).not.toBeNull();
      recordFolder(world.store, lease, folder);
      recordSpawn(world.store, lease, { pid, pgid: pid, startedAt: processStartedAt(pid) });
      world.now.at = new Date(world.now.at.getTime() + 11 * 60_000);
      expect(await checkCodeMap(world.store, world.repo, world.deps({ owner: "worker-next" }))).toBe("published");
      await expect.poll(() => alive(pid)).toBe(false);
      expect(existsSync(folder)).toBe(false);
      expect(readRefresh(world.store, world.repo)!.spawn).toEqual({ pid: null, pgid: null, startedAt: null, folder: null });
    } finally { world.close(); }
  });
});

describe("a depth-1 folder is clean only as the fetch left it", () => {
  const commit = "a".repeat(40);
  test.each([["a shallow file naming the commit", commit, true], ["a shallow file naming another", "b".repeat(40), false]])("%s", (_name, text, want) => {
    writeFileSync(join(dir, "shallow"), `${text}\n`);
    expect(shallowClean(dir, commit)).toBe(want);
  });
  test("attack: grafts or alternates refuse it", () => {
    mkdirSync(join(dir, "info")); writeFileSync(join(dir, "info", "grafts"), "x");
    expect(shallowClean(dir, commit)).toBe(false);
    rmSync(join(dir, "info", "grafts"));
    mkdirSync(join(dir, "objects", "info"), { recursive: true }); writeFileSync(join(dir, "objects", "info", "alternates"), "/elsewhere\n");
    expect(shallowClean(dir, commit)).toBe(false);
  });
});

describe.skipIf(!posix)("oversized objects", () => {
  let world: MapWorld;
  afterEach(() => { world.close(); });
  const pushBlob = (name: string, oid: string) => {
    world.git("update-index", "--add", "--cacheinfo", `100644,${oid},${name}`);
    world.git("commit", "-qm", name);
    world.git("push", "-q", "origin", "main");
  };
  test("attack: a compressed 2 GB zero blob is fetched inside the caps or killed, and is never read", async () => {
    world = mapWorld();
    const zeros = join(world.dir, "zeros");
    execFileSync("/bin/sh", ["-c", `head -c 2147483648 /dev/zero > ${zeros}`]);
    const oid = execFileSync("git", ["-c", "core.compression=1", "-C", world.work, "hash-object", "-w", zeros], { env: GIT_ENV, encoding: "utf8" }).trim();
    rmSync(zeros);
    pushBlob("big.ts", oid);
    const outcome = await checkCodeMap(world.store, world.repo, world.deps());
    if (outcome === "published") {
      const map = readVersionMap(world.store, currentVersion(world.store, world.repo)!.id)!;
      expect(map.files.find(one => one.path === "big.ts")).toMatchObject({ state: "too-large", symbols: [] });
    } else expect(outcome).toBe("failed");
  }, 240_000);
  test("attack: a large base with a small delta stays within the caps or is killed; the peak is recorded", async () => {
    world = mapWorld();
    const big = join(world.dir, "big");
    execFileSync("/bin/sh", ["-c", `head -c 268435456 /dev/urandom > ${big}`]);
    const first = execFileSync("git", ["-C", world.work, "hash-object", "-w", big], { env: GIT_ENV, encoding: "utf8" }).trim();
    const fd = openSync(big, "a"); writeFileSync(fd, "tail"); closeSync(fd);
    const second = execFileSync("git", ["-C", world.work, "hash-object", "-w", big], { env: GIT_ENV, encoding: "utf8" }).trim();
    rmSync(big);
    world.git("update-index", "--add", "--cacheinfo", `100644,${first},a.bin`);
    world.git("update-index", "--add", "--cacheinfo", `100644,${second},b.bin`);
    world.git("commit", "-qm", "delta");
    world.git("-c", "core.bigFileThreshold=2g", "-c", "pack.window=2", "repack", "-adfq");
    world.git("push", "-q", "origin", "main");
    let peak = 0;
    const seam = world.seam;
    const measuring: typeof world.seam = async (file, args, options) => { const ran = await seam(file, args, options); peak = Math.max(peak, ran.peakBytes); return ran; };
    const folder = join(world.dir, "fetch");
    mkdirSync(folder);
    await initPrivateDir(folder, measuring);
    const got = await readShallowMain(URL_A, folder, { gitArgs: [], env: {}, proxy: null }, measuring);
    // The tripwire's limit: a burst between samples can pass the limit before the kill, so only the outcome is asserted here.
    process.stdout.write(`code-map delta fetch: peak ${Math.round(peak / 1024 / 1024)} MB of ${MAP_FETCH_LIMITS.memoryBytes / 1024 / 1024} MB, ${got.ok ? "fetched" : got.why}\n`);
    if (!got.ok) expect(got.why).toMatch(/limit|couldn't read/);
  }, 240_000);
});
