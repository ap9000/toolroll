/**
 * Schema v154 and the execution stamp (docs/plans/trusted-release-reports.md, H2). A run from before reads no stamp, and
 * no stamp is never "sandboxed": each way of reading one wrong is a row below.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHECK_STAMP_VERSION, EVERYWHERE, ranWords, readStamp, readStamps, stampRefusal, unfencedStamp, type CheckStamp } from "./check-stamp.js";
import { fencedStamp } from "./invoke.js";
import { openStore, recordCheckStamp, runCheckStamp, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, V154_STEPS, type Store } from "./store.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const FENCED: CheckStamp = { version: CHECK_STAMP_VERSION, level: "sandboxed", policyDigest: "a".repeat(32), writable: ["/checkout"], readable: [], network: { mode: "machine" } };
const SIGN_INS: CheckStamp = { ...FENCED, level: "sign-ins", network: { mode: "allowlist", hosts: ["api.github.com"] } };
let dir: string | undefined;
const open: Store[] = [];
afterEach(() => { for (const one of open.splice(0)) { try { one.close(); } catch { /* closed */ } } if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const fresh = (name = "s.db"): Store => { dir ??= mkdtempSync(join(tmpdir(), "so-v154-")); const store = openStore(join(dir, name)); open.push(store); return store; };

describe("v154", () => {
  test("a fresh database has the table; a v151 one gains it and changes no saved row; and it may update in place", () => {
    const store = fresh();
    expect(SCHEMA_VERSION).toBe(160);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(154);
    expect(V154_STEPS).toEqual(["check-stamps"]);
    store.close();
    const db = new DatabaseSync(join(dir!, "s.db"));
    db.exec("DROP TABLE check_stamp");
    db.prepare("UPDATE schema_version SET version = 151").run();
    db.close();
    const upgraded = openStore(join(dir!, "s.db"));
    open.push(upgraded);
    expect(upgraded.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(160);
    expect(upgraded.handle.prepare("SELECT COUNT(*) AS n FROM check_stamp").get()?.["n"]).toBe(0);
  });
});

describe("a run's stamps", () => {
  test("a run with no stamp is unknown; repeats of a launch are one row; the widest launch stands", () => {
    const store = fresh();
    expect(runCheckStamp(store, 7)).toEqual({ state: "unknown", why: "missing" });
    recordCheckStamp(store, 7, FENCED, NOW);
    recordCheckStamp(store, 7, FENCED, NOW);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM check_stamp").get()?.["n"]).toBe(1);
    expect(runCheckStamp(store, 7)).toEqual({ state: "current", stamp: FENCED });
    recordCheckStamp(store, 7, unfencedStamp(), NOW);
    recordCheckStamp(store, 7, SIGN_INS, NOW);
    expect(runCheckStamp(store, 7)).toMatchObject({ state: "current", stamp: { level: "unsandboxed" } });
  });
  test("one damaged launch makes the whole run unknown, whatever else it stamped", () => {
    expect(readStamps([JSON.stringify(FENCED), "{"])).toEqual({ state: "unknown", why: "unreadable" });
    expect(readStamps([JSON.stringify(FENCED), JSON.stringify({ ...FENCED, version: 0 })])).toEqual({ state: "unknown", why: "old" });
    expect(readStamps([])).toEqual({ state: "unknown", why: "missing" });
  });
  test.each([
    ["no stamp", null, "missing"],
    ["not JSON", "sandboxed", "unreadable"],
    ["an array", "[]", "unreadable"],
    ["an older version", JSON.stringify({ ...FENCED, version: 0 }), "old"],
    ["a newer version", JSON.stringify({ ...FENCED, version: 2 }), "old"],
    ["no version", JSON.stringify({ ...FENCED, version: undefined }), "unreadable"],
    ["an unknown level", JSON.stringify({ ...FENCED, level: "mostly" }), "unreadable"],
    ["a field more", JSON.stringify({ ...FENCED, extra: 1 }), "unreadable"],
    ["a field fewer", JSON.stringify({ ...FENCED, readable: undefined }), "unreadable"],
    ["a digest of the wrong shape", JSON.stringify({ ...FENCED, policyDigest: "x" }), "unreadable"],
    ["a sandboxed level with no fence", JSON.stringify({ ...FENCED, policyDigest: null }), "unreadable"],
    ["an empty path", JSON.stringify({ ...FENCED, writable: [""] }), "unreadable"],
    ["a network of another shape", JSON.stringify({ ...FENCED, network: { mode: "open" } }), "unreadable"],
  ])("%s reads unknown, never sandboxed", (_, text, why) => {
    const reading = readStamp(text);
    expect(reading).toEqual({ state: "unknown", why });
    expect(stampRefusal(reading, "sandboxed")).not.toBeNull();
    expect(stampRefusal(reading, "unsandboxed")).not.toBeNull();
    expect(ranWords(reading)).toBe("How these checks ran wasn't recorded");
  });
  test("relying on a stamp: within what was sealed stands, wider refuses", () => {
    const at = (stamp: CheckStamp) => ({ state: "current" as const, stamp });
    expect(stampRefusal(at(FENCED), "sandboxed")).toBeNull();
    expect(stampRefusal(at(FENCED), "unsandboxed")).toBeNull();
    expect(stampRefusal(at(SIGN_INS), "sandboxed")).toMatch(/wider/);
    expect(stampRefusal(at(unfencedStamp()), "sign-ins")).toMatch(/wider/);
  });
  test("a launch's stamp is read from the grants it takes: writes as granted, no write fence as everywhere, sign-ins and network as given", () => {
    const grants = { readOnly: [], readable: ["/b", "/a"], lookup: [], writes: { subpaths: ["/z", "/y"], prefixes: [{ path: "/git/packed-refs", suffix: "x" }] } };
    const stamp = fencedStamp("sandboxed", ["/deny"], grants, undefined);
    expect(stamp).toMatchObject({ level: "sandboxed", writable: ["/git/packed-refsx", "/y", "/z"], readable: ["/a", "/b"], network: { mode: "machine" } });
    expect(readStamp(JSON.stringify(stamp)).state).toBe("current");
    expect(fencedStamp("sandboxed", ["/deny"], { readOnly: [], readable: [], lookup: [] }, undefined).writable).toEqual([EVERYWHERE]);
    expect(fencedStamp("sandboxed", ["/deny"], grants, undefined).policyDigest).not.toBe(fencedStamp("sandboxed", ["/other"], grants, undefined).policyDigest);
    const signedIn = fencedStamp("sign-ins", ["/deny"], { ...grants, signIns: { read: ["/s"] } as never }, { version: 1, mode: "allowlist", hosts: ["b", "a"], loopback: "proxy-only" });
    expect(signedIn).toMatchObject({ level: "sign-ins", readable: ["/a", "/b", "/s"], network: { mode: "allowlist", hosts: ["a", "b"] } });
  });
});
