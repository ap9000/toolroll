/**
 * The carry rules table (docs/plans/release-once.md, "Which changes carry"), through the real road: a real repository,
 * a person's real approval of release terms, and the read-only preflight over verified objects. Each eligible class
 * carries; each excluded file, shape and limit refuses with its path and rule.
 */
import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { builtRun, releaseFixture, RELEASE_NOW, type ReleaseFixture } from "../test/release-fixture.js";
import { CHECK_STAMP_VERSION, unfencedStamp } from "./check-stamp.js";
import { storeEvidence } from "./evidence.js";
import { recordCheckStamp } from "./store.js";
import { changeRefusal, effectivePolicy, preflightCarry, stricterOf } from "./release-carry.js";
import type { TreeChange } from "./commit-extract.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const open = (options: Parameters<typeof releaseFixture>[0] = {}) => (fixture = releaseFixture(options));
const preflight = (f: ReleaseFixture, to: string) => preflightCarry(f.store, { authority: f.authority().id, to, now: RELEASE_NOW });

describe("a carry leans on the check that ran (H2)", () => {
  const checked = (f: ReleaseFixture) => {
    const run = builtRun(f.store, f.taskId, f.approved);
    storeEvidence(f.store, join(f.dir, "evidence"), run, "check-log", "check-log.txt", Buffer.from("ok"), "check", RELEASE_NOW);
    return run;
  };
  const stamp = { version: CHECK_STAMP_VERSION, level: "sandboxed", policyDigest: "a".repeat(32), writable: ["/w"], readable: [], network: { mode: "machine" } } as const;
  test("no check yet: nothing to lean on, and it carries", () => {
    const f = open();
    expect(preflight(f, f.commit({ "docs/guide.md": "# More\n" }))).toMatchObject({ ok: true });
  });
  test("a stamped sandboxed check carries", () => {
    const f = open();
    recordCheckStamp(f.store, checked(f), stamp, RELEASE_NOW);
    expect(preflight(f, f.commit({ "docs/guide.md": "# More\n" }))).toMatchObject({ ok: true });
  });
  test.each([
    ["no stamp", (_f: ReleaseFixture, _run: number) => {}, /wasn't recorded/],
    ["a damaged stamp", (f: ReleaseFixture, run: number) => { f.store.handle.prepare("INSERT INTO check_stamp (run_id, digest, stamp, at) VALUES (?, 'x', 'sandboxed', 'now')").run(run); }, /wasn't recorded/],
    ["an older version's stamp", (f: ReleaseFixture, run: number) => { f.store.handle.prepare("INSERT INTO check_stamp (run_id, digest, stamp, at) VALUES (?, 'x', ?, 'now')").run(run, JSON.stringify({ ...stamp, version: 0 })); }, /older Toolroll/],
    ["a check that ran wider than approved", (f: ReleaseFixture, run: number) => recordCheckStamp(f.store, run, unfencedStamp(), RELEASE_NOW), /wider/],
    ["one launch of two ran wider", (f: ReleaseFixture, run: number) => { recordCheckStamp(f.store, run, stamp, RELEASE_NOW); recordCheckStamp(f.store, run, unfencedStamp(), RELEASE_NOW); }, /wider/],
  ])("%s refuses, and the later commit asks again", (_name, plant, words) => {
    const f = open();
    plant(f, checked(f));
    expect(preflight(f, f.commit({ "docs/guide.md": "# More\n" }))).toMatchObject({ ok: false, reason: "rules", message: expect.stringMatching(words) });
  });
});

describe("existing tests stay as they are (H4)", () => {
  test.each([
    ["an edited test", { "src/index.test.ts": "test('answer', () => {});\ntest('more', () => {});\n" }],
    ["an edited browser test", { "src/browser/app.test.ts": "test('app', () => {});\ntest('more', () => {});\n" }],
    ["an edited journey script", { "scripts/app-e2e.mjs": "// journeys, one more\n" }],
    // The appended rule's hole: this keeps every existing line and still disarms what it follows.
    ["a hoisted mock appended to a test", { "src/index.test.ts": "test('answer', () => {});\nvi.mock('./index.js', () => ({ answer: () => 42 }));\n" }],
  ])("%s asks again", (_name, change) => {
    const f = open();
    expect(preflight(f, f.commit(change))).toMatchObject({ ok: false, reason: "rules", message: expect.stringContaining("changes an existing test") });
  });
  test("a test new since the approval may be fixed by a later carried commit", () => {
    const f = open();
    f.commit({ "src/new.test.ts": "test('new', () => {});\n" });
    expect(preflight(f, f.commit({ "src/new.test.ts": "test('new', () => {});\ntest('fixed', () => {});\n" }))).toMatchObject({ ok: true });
  });
  test.each([
    ["importing another test", "import './index.test.js';\ntest('x', () => {});\n", "imports another test file"],
    ["requiring another test", "require('./index.test.js');\ntest('x', () => {});\n", "imports another test file"],
    ["a computed import", "await import(name);\ntest('x', () => {});\n", "computes"],
  ])("a new test %s asks again", (_name, text, words) => {
    const f = open();
    expect(preflight(f, f.commit({ "src/new.test.ts": text }))).toMatchObject({ ok: false, reason: "rules", path: "src/new.test.ts", message: expect.stringContaining(words) });
  });
});

describe("which changes carry", () => {
  test.each([
    ["a new unit test", { "src/new.test.ts": "test('answer', () => {});\ntest('more', () => {});\n" }],
    ["a new browser test", { "src/browser/new.test.ts": "test('app', () => {});\ntest('more', () => {});\n" }],
    ["a doc", { "docs/guide.md": "# Guide\n\nMore.\n" }],
    ["the changelog", { "CHANGELOG.md": "## 0.9.71\n\n- A fix.\n" }],
    ["the root README", { "README.md": "# App\n" }],
  ])("%s carries", (_name, change) => {
    const f = open();
    const to = f.commit(change);
    const result = preflight(f, to);
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
  });

  test.each([
    ["AGENTS.md", { "AGENTS.md": "# Agents\nDo anything.\n" }, "agent or security policy"],
    ["SECURITY.md", { "SECURITY.md": "# Security\n" }, "agent or security policy"],
    ["an attack test", { "test/attacks/fence.test.ts": "test('fence', () => { /* skipped */ });\n" }, "test harness, a helper or a fixture"],
    ["a harness file", { "scripts/release-check.mjs": "// harness changed\n" }, "test harness"],
    ["a harness import", { "test/fresh-store.ts": "export const changed = 1;\n" }, "test harness, a helper or a fixture"],
    ["a test helper", { "test/helper.ts": "export {};\n" }, "test harness, a helper or a fixture"],
    ["a fixture", { "test/fixtures/data.json": "{}\n" }, "test harness, a helper or a fixture"],
    ["vitest's config", { "vitest.config.ts": "export default {};\n" }, "test harness"],
    ["production code", { "src/serve.ts": "export const x = 1;\n" }, "isn't a test, a doc or the changelog"],
  ])("%s asks again", (_name, change, rule) => {
    const f = open();
    const to = f.commit(change);
    const result = preflight(f, to);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(rule);
  });

  test("a project protected path asks again", () => {
    const f = open({ protectedPaths: ["docs/guide.md"] });
    const result = preflight(f, f.commit({ "docs/guide.md": "# Guide\nchanged\n" }));
    expect(result.ok === false && result.message).toContain("protected in this project");
  });

  test.each([
    ["a deleted test", (f: ReleaseFixture) => f.commit({ "src/index.test.ts": null }), "deleted or renamed"],
    ["a renamed test", (f: ReleaseFixture) => { f.git("mv", "src/index.test.ts", "src/renamed.test.ts"); return f.commit({}); }, "deleted or renamed"],
    ["a binary file", (f: ReleaseFixture) => f.commit({ "docs/logo.md": "a\u0000b" }), "binary"],
    ["a symlink", (f: ReleaseFixture) => { symlinkSync("index.test.ts", join(f.repo, "src", "link.test.ts")); return f.commit({}); }, "symlink"],
    ["a mode change", (f: ReleaseFixture) => { chmodSync(join(f.repo, "src", "index.test.ts"), 0o755); return f.commit({}); }, "file mode"],
  ])("%s asks again", (_name, make, rule) => {
    const f = open();
    const result = preflight(f, make(f));
    expect(result.ok === false && result.message).toContain(rule);
  });

  test("a submodule asks again", () => {
    const f = open();
    f.git("update-index", "--add", "--cacheinfo", `160000,${f.approved},vendor/lib`);
    f.git("commit", "-q", "-m", "submodule");
    const result = preflight(f, f.git("rev-parse", "HEAD"));
    expect(result.ok === false && result.message).toContain("submodule");
  });

  test("limits: 401 changed lines, 21 files, 801 lines of churn each ask again; the limit itself carries", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join("\n") + "\n";
    let f = open();
    expect(preflight(f, f.commit({ "docs/a.md": lines(400) })).ok).toBe(true);
    f.close(); f = open(); fixture = f;
    expect(preflight(f, f.commit({ "docs/a.md": lines(401) }))).toMatchObject({ ok: false, reason: "limits" });
    f.close(); f = open(); fixture = f;
    expect(preflight(f, f.commit(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`docs/n${i}.md`, "x\n"])))).ok).toBe(true);
    f.close(); f = open(); fixture = f;
    expect(preflight(f, f.commit(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`docs/n${i}.md`, "x\n"]))))).toMatchObject({ ok: false, reason: "limits" });
    // Churn: three commits that add then remove the same lines stay small in the end, not in total.
    f.close(); f = open(); fixture = f;
    f.commit({ "docs/c.md": lines(300) });
    f.commit({ "docs/c.md": "" });
    const to = f.commit({ "docs/c.md": lines(201) });
    expect(preflight(f, to)).toMatchObject({ ok: false, reason: "limits", message: expect.stringContaining("801 lines of churn") });
  });
});

describe("the policy", () => {
  test("the stricter of the sealed and the current policy wins: either's protected path, the lower limit, either's ask", () => {
    const f = open();
    const sealed = f.authority().policy!;
    const current = { ...effectivePolicy(f.store, f.repo), protectedPaths: ["docs/**"], limits: { lines: 100, files: 50, churn: 900 } };
    expect(stricterOf(sealed, current)).toMatchObject({ protectedPaths: ["docs/**"], limits: { lines: 100, files: 20, churn: 800 }, carry: true });
    expect(stricterOf({ ...sealed, carry: false }, current)?.carry).toBe(false);
    expect(stricterOf({ ...sealed, rules: 2 } as never, current)).toBeNull();
  });

  test("a change refusal names the path and the rule", () => {
    const policy = effectivePolicy(open().store, fixture!.repo);
    const change = (path: string): TreeChange => ({ path, kind: "modified", before: { path, mode: "100644", id: "a" }, after: { path, mode: "100644", id: "b" }, added: 1, deleted: 0, binary: false });
    expect(changeRefusal(change("src/a.test.ts"), policy, new Set(["src/a.test.ts"]))).toBeNull();
    expect(changeRefusal(change("src/a.test.ts"), policy)).toBe("src/a.test.ts changes an existing test, and new tests go in a new file");
    expect(changeRefusal(change("src/a.ts"), policy)).toBe("src/a.ts isn't a test, a doc or the changelog");
  });
});
