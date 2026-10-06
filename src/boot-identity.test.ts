/**
 * Boot identity for process custody (plan acceptance 3): the kernel's own
 * per-boot token is read and validated; a VERIFIED boot change on the same
 * host proves an old process gone; the same boot, a missing or malformed
 * identity, a foreign host, a legacy witness without an id, and a reused
 * pid all keep the conservative road — and stop settlement, resume, and
 * the worktree occupancy note follow exactly that rule.
 */

import { afterEach, describe, expect, test } from "vitest";
import { hostname } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { currentBootId, injectBootIdentity, normalizeBootId, provenDeadByBootChange, readBootIdentity } from "./boot-identity.js";
import { openStore, type Store } from "./store.js";
import { recordWorktreeProcess, worktreeProcessOccupancy } from "./worktree.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { fakePid } from "../test/fake-pid.js";

const BOOT_A = "4cdea6bb-1ac8-4e7c-bfcf-646f89b8a8a7";
const BOOT_B = "9b1d0e2f-3a4b-4c5d-8e6f-a1b2c3d4e5f6";

describe("reading the boot identity", () => {
  test("linux reads /proc/sys/kernel/random/boot_id; darwin reads kern.bootsessionuuid; both normalize to one lower-case UUID", () => {
    expect(readBootIdentity({ platform: "linux", readFile: () => `${BOOT_A.toUpperCase()}\n` })).toEqual({ ok: true, id: BOOT_A, source: "linux-boot-id" });
    expect(readBootIdentity({ platform: "darwin", sysctl: name => { expect(name).toBe("kern.bootsessionuuid"); return `${BOOT_B.toUpperCase()}\n`; } })).toEqual({ ok: true, id: BOOT_B, source: "darwin-bootsessionuuid" });
  });

  test("a missing, unreadable or malformed identity is an explicit unknown, never a guess", () => {
    expect(readBootIdentity({ platform: "win32" })).toMatchObject({ ok: false, reason: "unsupported-platform" });
    expect(readBootIdentity({ platform: "linux", readFile: () => { throw new Error("ENOENT"); } })).toMatchObject({ ok: false, reason: "unreadable" });
    expect(readBootIdentity({ platform: "linux", readFile: () => "not-a-uuid\n" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(readBootIdentity({ platform: "darwin", sysctl: () => "" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(normalizeBootId(` ${BOOT_A.toUpperCase()} `)).toBe(BOOT_A);
    expect(normalizeBootId("4cdea6bb1ac84e7cbfcf646f89b8a8a7")).toBeNull();
    expect(normalizeBootId(`${BOOT_A}\n${BOOT_B}`)).toBeNull();
  });

  test("this host reads a real identity where the platform offers one", () => {
    const identity = readBootIdentity();
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(identity.ok, identity.ok ? "" : identity.detail).toBe(true);
    } else {
      expect(identity.ok).toBe(false);
    }
  });
});

describe("the one rule: proven dead by boot change", () => {
  const host = hostname();

  test("a verified different boot on the same host proves the process gone", () => {
    expect(provenDeadByBootChange({ host, bootId: BOOT_A }, { host, bootId: BOOT_B })).toBe(true);
    expect(provenDeadByBootChange({ host, bootId: BOOT_A.toUpperCase() }, { host, bootId: BOOT_B })).toBe(true);
  });

  test("same boot, legacy witness, unknown current boot, malformed ids and a foreign host all stay conservative", () => {
    expect(provenDeadByBootChange({ host, bootId: BOOT_A }, { host, bootId: BOOT_A })).toBe(false);
    expect(provenDeadByBootChange({ host, bootId: null }, { host, bootId: BOOT_B })).toBe(false);
    expect(provenDeadByBootChange({ host, bootId: BOOT_A }, { host, bootId: null })).toBe(false);
    expect(provenDeadByBootChange({ host, bootId: "garbage" }, { host, bootId: BOOT_B })).toBe(false);
    expect(provenDeadByBootChange({ host, bootId: BOOT_A }, { host, bootId: "garbage" })).toBe(false);
    expect(provenDeadByBootChange({ host: "other-host", bootId: BOOT_A }, { host, bootId: BOOT_B })).toBe(false);
  });
});

describe("custody across boots", () => {
  let store: Store;
  let dir: string;
  const REPO = resolve("/repo");
  // The live process and all run/witness times share a current baseline.
  const T0 = new Date();
  const host = hostname();

  afterEach(() => {
    injectBootIdentity(null);
    store?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** A claimed builder run with a stop recorded and the run already ended — only the witnesses decide. */
  function stoppedRun(): number {
    store = openStore(":memory:");
    register(store, { name: "r", host, capacity: 1, repos: [REPO], now: T0, newToken: () => "tok" });
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor("built-in", "t").id;
    store.placeTask(ref, REPO);
    const claimed = acquire(store, ref, "r", { token: "tok", now: T0, ttlMs: 3_600_000, newLeaseId: () => "lease" });
    if (!claimed.ok) throw new Error(claimed.reason);
    const runId = store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
    const asked = store.requestRunStop({ runId, taskRef: ref, by: "alex", via: "cli" }, T0);
    if (!asked.ok) throw new Error(asked.reason);
    return runId;
  }

  /** The run ends; the stop settles right there ONLY if the witnesses allow it. */
  const finish = (runId: number): { settled: boolean; problem: string | null } => {
    store.finishRun(runId, { outcome: "failed", reason: "interrupted", now: T0 });
    return { settled: store.stopOf(runId)?.settledAt !== null, problem: store.stopQuiescenceProblem(runId) };
  };

  const witness = (runId: number, facts: { pid?: number | null; host?: string; bootId?: string | null; containment?: string | null; container?: string | null }): number => {
    const id = Number(store.raw().prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, boot_id, containment, container) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
      .run(runId, facts.pid === undefined ? process.pid : facts.pid, facts.host ?? host, T0.toISOString(), facts.bootId === undefined ? BOOT_A : facts.bootId, facts.containment ?? null, facts.container ?? null).lastInsertRowid);
    return id;
  };

  test("c4: same boot — a live pid keeps the stop pending; PID probes decide", () => {
    const runId = stoppedRun();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    witness(runId, { pid: process.pid });
    const ended = finish(runId);
    expect(ended.settled).toBe(false);
    expect(ended.problem).toContain("may still be running");
    expect(store.settleRunStop(runId, "recovered", T0)).toBe(false);
  });

  test("c4: a VERIFIED boot change on this host settles a live-looking pid (reuse), an incomplete spawn witness, and an unproven native object", () => {
    const runId = stoppedRun();
    injectBootIdentity({ ok: true, id: BOOT_B, source: "injected" });
    // This very process's pid — alive now — but witnessed under the old boot: a reused pid.
    witness(runId, { pid: process.pid, bootId: BOOT_A });
    // An incomplete spawn from the old boot: reserved, never stamped.
    witness(runId, { pid: null, bootId: BOOT_A });
    // A native object never proven empty, from the old boot.
    witness(runId, { pid: process.pid, bootId: BOOT_A, containment: "cgroup2", container: "/sys/fs/cgroup/gone" });
    // Before the run ends nothing settles (the run is open); once it ends,
    // the verified boot change is the proof and the stop settles at once.
    expect(store.stopQuiescenceProblem(runId)).toContain("still open");
    const ended = finish(runId);
    expect(ended).toEqual({ settled: true, problem: null });
    expect(store.stopOf(runId)?.settledAt).not.toBeNull();
  });

  test("c4: a legacy witness without a boot id, a foreign host, a malformed id, and an unknown current boot each stay conservative", () => {
    for (const [label, facts, current] of [
      ["legacy", { pid: process.pid, bootId: null }, { ok: true, id: BOOT_B, source: "injected" }],
      ["foreign host", { pid: process.pid, bootId: BOOT_A, host: "elsewhere" }, { ok: true, id: BOOT_B, source: "injected" }],
      ["malformed witness", { pid: process.pid, bootId: "not-a-uuid" }, { ok: true, id: BOOT_B, source: "injected" }],
      ["unknown current", { pid: process.pid, bootId: BOOT_A }, { ok: false, reason: "unsupported-platform", detail: "x" }],
    ] as const) {
      const runId = stoppedRun();
      injectBootIdentity(current as Parameters<typeof injectBootIdentity>[0]);
      witness(runId, facts);
      const ended = finish(runId);
      expect(ended.settled, label).toBe(false);
      expect(ended.problem, label).not.toBeNull();
      expect(store.settleRunStop(runId, "recovered", T0), label).toBe(false);
      store.close();
    }
    store = openStore(":memory:");
  });

  test("c4: an incomplete spawn witness from a foreign host and from the SAME boot both block; only the verified old boot releases it", () => {
    const runId = stoppedRun();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    witness(runId, { pid: null, bootId: BOOT_A });
    expect(finish(runId)).toMatchObject({ settled: false, problem: expect.stringContaining("incomplete spawn witness") });
    store.close();
    const other = stoppedRun();
    injectBootIdentity({ ok: true, id: BOOT_B, source: "injected" });
    witness(other, { pid: null, bootId: BOOT_A, host: "elsewhere" });
    expect(finish(other)).toMatchObject({ settled: false, problem: expect.stringContaining("another host") });
  });

  test("c4: new witnesses are stamped with this process's boot identity, or NULL when it is unknown", () => {
    const runId = stoppedRun();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    const reserved = store.reserveRunProcess(runId, T0, true);
    expect(store.raw().prepare("SELECT boot_id FROM run_process WHERE id = ?").get(reserved)?.["boot_id"]).toBe(BOOT_A);
    injectBootIdentity({ ok: false, reason: "unsupported-platform", detail: "x" });
    expect(currentBootId()).toBeNull();
    const pid = fakePid(1);
    store.recordRunProcess(runId, pid, T0, true);
    expect(store.raw().prepare("SELECT boot_id FROM run_process WHERE pid = ?").get(pid)?.["boot_id"]).toBeNull();
  });

  test("c4: the worktree occupancy note carries the boot id; a note from a verified previous boot frees the checkout, a legacy note does not", () => {
    store = openStore(":memory:");
    register(store, { name: "r", host, capacity: 1, repos: [REPO], now: T0, newToken: () => "tok" });
    dir = mkdtempSync(join(tmpdir(), "so-boot-wt-"));
    store.saveWorktree({ path: dir, repo: REPO, branch: "b", runner: "r", taskRef: null, createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true });
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    // Another live process of this machine (the test runner's parent), under this boot.
    recordWorktreeProcess(store, dir, "r", process.ppid);
    expect(worktreeProcessOccupancy(dir)).toEqual({ held: true, by: process.ppid });
    // The same note read after a verified boot change: that pid cannot be the holder.
    injectBootIdentity({ ok: true, id: BOOT_B, source: "injected" });
    expect(worktreeProcessOccupancy(dir)).toEqual({ held: false });
    // A legacy note (no boot id) stays conservative even after the change.
    writeFileSync(join(dir, ".standing-orders-lease"), `${process.ppid} r group\n`);
    expect(worktreeProcessOccupancy(dir)).toEqual({ held: true, by: process.ppid });
    // An unknown current boot stays conservative too.
    writeFileSync(join(dir, ".standing-orders-lease"), `${process.ppid} r group ${BOOT_A}\n`);
    injectBootIdentity({ ok: false, reason: "unsupported-platform", detail: "x" });
    expect(worktreeProcessOccupancy(dir)).toEqual({ held: true, by: process.ppid });
  });
});
