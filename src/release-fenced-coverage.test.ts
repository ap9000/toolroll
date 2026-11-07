/**
 * The plane's answer on a sandboxed Full check's skips (docs/plans/trusted-release-reports.md, H3). Its first row is the
 * one that keeps releases going: a check that ran unsandboxed, as Toolroll's own do, is answered at once, and nothing is
 * read from GitHub.
 */
import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { builtRun, releaseFixture, RELEASE_NOW, reportOf, sealedCheck, type ReleaseFixture } from "../test/release-fixture.js";
import { CHECK_STAMP_VERSION, unfencedStamp } from "./check-stamp.js";
import { storeReleaseAdapter } from "./release-adapters.js";
import { recordCheckStamp } from "./store.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const stamp = { version: CHECK_STAMP_VERSION, level: "sandboxed", policyDigest: "a".repeat(32), writable: ["/w"], readable: [], network: { mode: "machine" } } as const;
const CASE = "unit:src/index.test.ts::needs a sandbox";

function adapter(f: ReleaseFixture, macosCases: (sha: string) => Promise<ReadonlyMap<string, boolean> | null>) {
  return storeReleaseAdapter(() => f.store, () => {}, () => RELEASE_NOW, undefined, {
    observe: async () => { throw new Error("no CI read here"); }, mergeBase: async () => { throw new Error("no merge base here"); }, upToDateRequired: async () => null,
    evidenceRoot: join(f.dir, "evidence"), macosCases });
}
const neverRead = async (): Promise<null> => { throw new Error("GitHub must not be read"); };
const sealed = (f: ReleaseFixture, skipped: string[]) => sealedCheck(f, f.taskId, f.approved, (_plan, units) => reportOf(units.map(file => file === "src/index.test.ts" ? { file, skipped } : { file }))).runId;

describe("what a release's check skipped", () => {
  test("an unsandboxed check is today's road: answered at once, whatever else is or isn't recorded", async () => {
    const f = fixture = releaseFixture();
    const run = builtRun(f.store, f.taskId, f.approved);
    f.store.stampRunCheckAccess(run, "unsandboxed");
    await expect(adapter(f, neverRead).fencedCoverage!(f.taskId, run, f.approved)).resolves.toEqual({ ok: true, covered: 0 });
  });
  test("a level the launch fell back to is what counts: stamped unsandboxed, nothing skipped for this reason", async () => {
    const f = fixture = releaseFixture();
    const run = builtRun(f.store, f.taskId, f.approved);
    recordCheckStamp(f.store, run, unfencedStamp(), RELEASE_NOW);
    await expect(adapter(f, neverRead).fencedCoverage!(f.taskId, run, f.approved)).resolves.toEqual({ ok: true, covered: 0 });
  });
  test("no stamp on a sandboxed run, or no report, can't be judged", async () => {
    const f = fixture = releaseFixture();
    const run = builtRun(f.store, f.taskId, f.approved);
    await expect(adapter(f, neverRead).fencedCoverage!(f.taskId, run, f.approved)).resolves.toMatchObject({ ok: false, why: expect.stringContaining("wasn't recorded") });
    recordCheckStamp(f.store, run, stamp, RELEASE_NOW);
    await expect(adapter(f, neverRead).fencedCoverage!(f.taskId, run, f.approved)).resolves.toMatchObject({ ok: false, why: expect.stringContaining("report can't be read") });
  });
  test("nothing skipped reads nothing from GitHub", async () => {
    const f = fixture = releaseFixture();
    const run = sealed(f, []);
    recordCheckStamp(f.store, run, stamp, RELEASE_NOW);
    await expect(adapter(f, neverRead).fencedCoverage!(f.taskId, run, f.approved)).resolves.toEqual({ ok: true, covered: 0 });
  });
  test.each([
    ["the same case passed", new Map([[CASE, true]]), { ok: true, covered: 1 }],
    ["another case of the file passed", new Map([["unit:src/index.test.ts::other", true]]), { ok: false }],
    ["the case failed there", new Map([[CASE, false]]), { ok: false }],
    ["the reports can't be read", null, { ok: false }],
  ])("skipped here, and %s", async (_, cases, answer) => {
    const f = fixture = releaseFixture();
    const run = sealed(f, ["needs a sandbox"]);
    recordCheckStamp(f.store, run, stamp, RELEASE_NOW);
    await expect(adapter(f, async sha => { expect(sha).toBe(f.approved); return cases; }).fencedCoverage!(f.taskId, run, f.approved)).resolves.toMatchObject(answer);
  });
});
